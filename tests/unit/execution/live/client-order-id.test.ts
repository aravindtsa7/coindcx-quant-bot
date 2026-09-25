import { describe, expect, it } from 'vitest';
import type { LivePlaceOrderRequest, LivePlaceOrderResult } from '../../../../src/execution/live/gateway';
import {
  COINDCX_CLIENT_ORDER_ID_MAX_LENGTH,
  LIVE_CLIENT_ORDER_ID_LENGTH,
  deriveLiveClientOrderId,
  isSendableLiveClientOrderId,
} from '../../../../src/execution/live/identity';
import { LiveExecutionIntent, type LiveExecutionIntentRecord } from '../../../../src/execution/live/intent';
import { LiveExecutionService } from '../../../../src/execution/live/service';
import { applyLiveOrderObservation, initialLiveOrderState } from '../../../../src/execution/live/state-machine';
import type { LiveOrderObservation, LiveOrderStateRecord } from '../../../../src/execution/live/types';
import {
  FakeOrderGateway,
  InMemoryLiveExecutionRepository,
  limitShape,
  livePolicy,
  mintGenuineLiveOpen,
  observationFor,
} from './helpers';

// Offline: FakeOrderGateway performs no I/O. No test here reaches CoinDCX.

const TIMEOUT = 60_000;

/** Records the durable state the repository holds at the instant the wire call is attempted. */
class InspectingGateway extends FakeOrderGateway {
  public readonly durableAtWireCall: { state: string; clientOrderId: string; dispatchWireArmed: boolean }[] = [];

  public constructor(private readonly repository: InMemoryLiveExecutionRepository, private readonly intentId: string) {
    super();
  }

  public override async placeOrder(request: LivePlaceOrderRequest): Promise<LivePlaceOrderResult> {
    const durable = await this.repository.load(this.intentId);
    if (durable === null) throw new Error('nothing was persisted before the network attempt');
    this.durableAtWireCall.push({ state: durable.state, clientOrderId: durable.clientOrderId, dispatchWireArmed: durable.dispatchWireArmed });
    return super.placeOrder(request);
  }
}

async function minted(overrides: Parameters<typeof mintGenuineLiveOpen>[0] = {}) {
  const authority = await mintGenuineLiveOpen(overrides);
  const record = LiveExecutionIntent.read(authority.intent);
  if (record === null) throw new Error('fixture');
  return { authority: authority.authority, intent: authority.intent, record };
}

describe('client_order_id format and provider length limit', () => {
  it('the derived id is exactly 36 characters (the provider maximum) and sendable', async () => {
    const { record } = await minted();
    expect(LIVE_CLIENT_ORDER_ID_LENGTH).toBe(36);
    expect(COINDCX_CLIENT_ORDER_ID_MAX_LENGTH).toBe(36);
    expect(record.clientOrderId).toHaveLength(36);
    expect(record.clientOrderId.length).toBeLessThanOrEqual(COINDCX_CLIENT_ORDER_ID_MAX_LENGTH);
    expect(isSendableLiveClientOrderId(record.clientOrderId)).toBe(true);
    expect(deriveLiveClientOrderId(record.content)).toBe(record.clientOrderId);
  }, TIMEOUT);

  it('a 37-character id is rejected locally, whatever its content', () => {
    const valid = `p17-${'a'.repeat(32)}`;
    expect(isSendableLiveClientOrderId(valid)).toBe(true);
    expect(isSendableLiveClientOrderId(`${valid}a`)).toBe(false);
    expect(`${valid}a`).toHaveLength(37);
    for (const invalid of ['', 'p17-', valid.toUpperCase(), ` ${valid}`, `p18-${'a'.repeat(32)}`, `p17-${'g'.repeat(32)}`, 36, null, undefined]) {
      expect(isSendableLiveClientOrderId(invalid)).toBe(false);
    }
  });
});

describe('client_order_id lifecycle through the Phase17 service', () => {
  it('is persisted (with the intent, claimed and wire-armed) BEFORE the first network create', async () => {
    const { authority, intent, record } = await minted();
    const repository = new InMemoryLiveExecutionRepository();
    const gateway = new InspectingGateway(repository, record.intentId);
    gateway.queuePlace({ kind: 'ACCEPTED', observation: observationFor(record) });
    const service = new LiveExecutionService({ gateway, repository, policy: livePolicy() });

    await service.dispatch(authority, intent);
    expect(gateway.durableAtWireCall).toEqual([{ state: 'DISPATCH_RESERVED', clientOrderId: record.clientOrderId, dispatchWireArmed: true }]);
    expect(gateway.placeRequests[0]!.clientOrderId).toBe(record.clientOrderId);
  }, TIMEOUT);

  it('a retry of the same logical intent (after a provably-unsent attempt) reuses the exact same id', async () => {
    const { authority, intent, record } = await minted();
    const repository = new InMemoryLiveExecutionRepository();
    const gateway = new FakeOrderGateway().queuePlace(
      { kind: 'PRE_DISPATCH_FAILURE', reasonCode: 'CONNECT_REFUSED' },
      { kind: 'ACCEPTED', observation: observationFor(record) },
    );
    const service = new LiveExecutionService({ gateway, repository, policy: livePolicy() });

    await expect(service.dispatch(authority, intent)).rejects.toThrow(/LIVE_PROVIDER_ERROR/);
    expect((await repository.load(record.intentId))?.state).toBe('CREATED');
    const retried = await service.dispatch(authority, intent);
    expect(retried.kind).toBe('SUBMITTED');
    expect(gateway.placeRequests.map((request) => request.clientOrderId)).toEqual([record.clientOrderId, record.clientOrderId]);
    expect((await repository.load(record.intentId))?.clientOrderId).toBe(record.clientOrderId);
  }, TIMEOUT);

  it('a new logical intent gets a new id; the same content always re-derives the same id', async () => {
    const first = await minted({ shape: limitShape('100') });
    const second = await minted({ shape: limitShape('99') });
    expect(second.record.clientOrderId).not.toBe(first.record.clientOrderId);
    expect(deriveLiveClientOrderId(first.record.content)).toBe(first.record.clientOrderId);
    const changedQuantity: LiveExecutionIntentRecord['content'] = { ...first.record.content, quantity: '999' };
    expect(deriveLiveClientOrderId(changedQuantity)).not.toBe(first.record.clientOrderId);
  }, TIMEOUT);

  it('a timeout (AMBIGUOUS) cannot generate another id: the intent is never resent and its id never changes', async () => {
    const { authority, intent, record } = await minted();
    const repository = new InMemoryLiveExecutionRepository();
    const gateway = new FakeOrderGateway().queuePlace({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_TRANSPORT_TIMEOUT' });
    const service = new LiveExecutionService({ gateway, repository, policy: livePolicy() });

    const outcome = await service.dispatch(authority, intent);
    expect(outcome.kind).toBe('AMBIGUOUS');
    await expect(service.dispatch(authority, intent)).rejects.toThrow(/LIVE_SUBMISSION_AMBIGUOUS/);
    await expect(service.dispatch(authority, intent)).rejects.toThrow(/LIVE_SUBMISSION_AMBIGUOUS/);
    expect(gateway.placeCallCount).toBe(1);
    const durable = await repository.load(record.intentId);
    expect(durable?.state).toBe('SUBMISSION_AMBIGUOUS');
    expect(durable?.clientOrderId).toBe(record.clientOrderId);
  }, TIMEOUT);

  it('a provider-confirmed duplicate is never success and never REJECTED: it fails closed as ambiguous with no venue identity', async () => {
    const { authority, intent, record } = await minted();
    const repository = new InMemoryLiveExecutionRepository();
    const gateway = new FakeOrderGateway().queuePlace({ kind: 'DUPLICATE_CLIENT_ORDER_ID', reasonCode: 'HTTP_400_DUPLICATE_CLIENT_ORDER_ID' });
    const service = new LiveExecutionService({ gateway, repository, policy: livePolicy() });

    const outcome = await service.dispatch(authority, intent);
    expect(outcome).toMatchObject({ kind: 'AMBIGUOUS', faultCode: 'LIVE_SUBMISSION_DUPLICATE_CLIENT_ORDER_ID' });
    const durable = await repository.load(record.intentId);
    expect(durable?.state).toBe('SUBMISSION_AMBIGUOUS');
    expect(durable?.exchangeOrderId).toBeNull();
    expect(durable?.clientOrderId).toBe(record.clientOrderId);
    await expect(service.dispatch(authority, intent)).rejects.toThrow(/LIVE_SUBMISSION_AMBIGUOUS/);
    expect(gateway.placeCallCount).toBe(1);
  }, TIMEOUT);
});

describe('a venue client_order_id echo must be exact', () => {
  const CLIENT_ORDER_ID = `p17-${'a'.repeat(32)}`;
  const current: LiveOrderStateRecord = Object.freeze({
    ...initialLiveOrderState({
      intentId: 'intent-1', clientOrderId: CLIENT_ORDER_ID, accountId: 'account-live-1', pair: 'B-BTC_USDT', orderedQuantity: '2',
    }),
    state: 'DISPATCH_RESERVED' as const,
  });
  const observation = (exchangeClientOrderId: string | null): LiveOrderObservation => Object.freeze({
    kind: 'ACKNOWLEDGED', clientOrderId: CLIENT_ORDER_ID, exchangeClientOrderId, exchangeOrderId: 'venue-1', pair: 'B-BTC_USDT',
    side: 'BUY', cumulativeFilledQuantity: '0', orderedQuantity: '2', averageFillPrice: null, exchangeStatus: 'open', providerEventTimeMs: 1_000,
  });

  it('an observation echoing a DIFFERENT client_order_id is an identity mismatch; null or identical is accepted', () => {
    expect(() => applyLiveOrderObservation(current, observation(`p17-${'f'.repeat(32)}`))).toThrow(/LIVE_ORDER_IDENTITY_MISMATCH/);
    expect(() => applyLiveOrderObservation(current, observation(CLIENT_ORDER_ID.toUpperCase()))).toThrow(/LIVE_ORDER_IDENTITY_MISMATCH/);
    expect(() => applyLiveOrderObservation(current, observation(null))).not.toThrow();
    expect(() => applyLiveOrderObservation(current, observation(CLIENT_ORDER_ID))).not.toThrow();
  });
});
