/**
 * [F17-R04] Consumption-state boundedness measured through the REAL service
 * path, for every terminal shape a Phase17 dispatch can take.
 *
 * `tests/unit/dispatch/admission-consumption-bounded.test.ts` proves the
 * structural property directly against the coordinator. This file proves the
 * operational one: whatever the venue does — accepts, rejects, times out,
 * refuses before dispatch, or the order is later cancelled — the process ends
 * up holding exactly one consumption marker per admission, never one per
 * attempt, and no retry path can add another.
 */
import { describe, expect, it } from 'vitest';
import { RiskAdmissionCoordinator, liveAdmissionConsumptionCardinality } from '../../../../src/dispatch/admission';
import { LiveExecutionIntent, type LiveExecutionIntentRecord } from '../../../../src/execution/live/intent';
import { LiveExecutionService } from '../../../../src/execution/live/service';
import {
  FakeOrderGateway,
  InMemoryLiveExecutionRepository,
  livePolicy,
  mintGenuineLiveOpen,
  observationFor,
} from './helpers';

interface Harness {
  readonly service: LiveExecutionService;
  readonly gateway: FakeOrderGateway;
  readonly coordinator: RiskAdmissionCoordinator;
  readonly authority: unknown;
  readonly intent: unknown;
  readonly record: LiveExecutionIntentRecord;
}

async function harness(): Promise<Harness> {
  const coordinator = new RiskAdmissionCoordinator();
  const minted = await mintGenuineLiveOpen({ coordinator });
  const record = LiveExecutionIntent.read(minted.intent);
  if (record === null) throw new Error('fixture');
  const gateway = new FakeOrderGateway();
  return {
    service: new LiveExecutionService({ gateway, repository: new InMemoryLiveExecutionRepository(), policy: livePolicy() }),
    gateway,
    coordinator,
    authority: minted.authority,
    intent: minted.intent,
    record,
  };
}

const TIMEOUT = 60_000;

const ack = (record: LiveExecutionIntentRecord) =>
  observationFor(record, { kind: 'ACKNOWLEDGED', exchangeStatus: 'open', providerEventTimeMs: 1_000 });

describe('F17-R04 exactly one consumption marker survives every dispatch outcome', () => {
  it('a successful submission consumes once, and replay adds nothing', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    expect((await h.service.dispatch(h.authority, h.intent)).kind).toBe('SUBMITTED');
    expect(liveAdmissionConsumptionCardinality(h.coordinator)).toBe(1);

    for (let i = 0; i < 50; i += 1) {
      expect((await h.service.dispatch(h.authority, h.intent)).kind).toBe('ALREADY_DISPATCHED');
    }
    expect(liveAdmissionConsumptionCardinality(h.coordinator)).toBe(1);
    expect(h.gateway.placeCallCount).toBe(1);
  }, TIMEOUT);

  it('a venue rejection consumes once and cannot be re-consumed by retrying', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'REJECTED', reasonCode: 'HTTP_400', observation: null });
    expect((await h.service.dispatch(h.authority, h.intent)).kind).toBe('REJECTED');
    expect(liveAdmissionConsumptionCardinality(h.coordinator)).toBe(1);

    for (let i = 0; i < 50; i += 1) {
      expect((await h.service.dispatch(h.authority, h.intent)).kind).toBe('ALREADY_DISPATCHED');
    }
    expect(liveAdmissionConsumptionCardinality(h.coordinator)).toBe(1);
  }, TIMEOUT);

  it('a dispatch timeout (ambiguous submission) consumes once and stays at one while failing closed', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const outcome = await h.service.dispatch(h.authority, h.intent);
    expect(outcome.kind).toBe('AMBIGUOUS');
    expect(outcome.order.state).toBe('SUBMISSION_AMBIGUOUS');
    expect(liveAdmissionConsumptionCardinality(h.coordinator)).toBe(1);

    // Every retry must fail closed rather than resend — and must not consume again.
    for (let i = 0; i < 50; i += 1) {
      await expect(h.service.dispatch(h.authority, h.intent)).rejects.toThrow(/LIVE_SUBMISSION_AMBIGUOUS/);
    }
    expect(liveAdmissionConsumptionCardinality(h.coordinator)).toBe(1);
    expect(h.gateway.placeCallCount).toBe(1);
  }, TIMEOUT);

  it('a pre-dispatch failure is retryable many times and still consumes exactly once', async () => {
    const h = await harness();
    // The claim is taken (and the admission consumed) before the wire call, so
    // a provably-unsent failure releases the claim while the consumption stays
    // bound to THIS intent. Retrying is allowed and must be idempotent.
    for (let i = 0; i < 25; i += 1) {
      h.gateway.queuePlace({ kind: 'PRE_DISPATCH_FAILURE', reasonCode: 'CONNECT_REFUSED' });
      await expect(h.service.dispatch(h.authority, h.intent)).rejects.toThrow(/LIVE_PROVIDER_ERROR/);
      expect(liveAdmissionConsumptionCardinality(h.coordinator)).toBe(1);
    }

    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    expect((await h.service.dispatch(h.authority, h.intent)).kind).toBe('SUBMITTED');
    expect(liveAdmissionConsumptionCardinality(h.coordinator)).toBe(1);
  }, TIMEOUT);

  it('cancellation never adds or removes a consumption marker', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    await h.service.dispatch(h.authority, h.intent);
    expect(liveAdmissionConsumptionCardinality(h.coordinator)).toBe(1);

    h.gateway.queueCancel({ kind: 'CANCEL_ACCEPTED', observation: null });
    h.gateway.queueFetch({
      kind: 'FOUND',
      observation: observationFor(h.record, { kind: 'CANCELLED', exchangeStatus: 'cancelled', providerEventTimeMs: 2_000 }),
    });
    const cancelled = await h.service.cancel(h.authority, h.intent);
    expect(cancelled.kind).toBe('CANCELLED');
    expect(liveAdmissionConsumptionCardinality(h.coordinator)).toBe(1);

    // Repeated cancellation of a terminal order must not touch it either.
    for (let i = 0; i < 20; i += 1) {
      expect((await h.service.cancel(h.authority, h.intent)).kind).toBe('NOT_CANCELLABLE');
    }
    expect(liveAdmissionConsumptionCardinality(h.coordinator)).toBe(1);
  }, TIMEOUT);

  it('an ambiguous cancellation leaves the marker count unchanged', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    await h.service.dispatch(h.authority, h.intent);
    h.gateway.queueCancel({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const outcome = await h.service.cancel(h.authority, h.intent);
    expect(outcome.kind).toBe('AMBIGUOUS');
    expect(liveAdmissionConsumptionCardinality(h.coordinator)).toBe(1);
  }, TIMEOUT);
});
