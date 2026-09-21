import { describe, expect, it } from 'vitest';
import { LiveExecutionError } from '../../../../src/execution/live/errors';
import { RiskAdmissionCoordinator } from '../../../../src/dispatch/admission';
import { LiveExecutionAuthority } from '../../../../src/execution/live/authority';
import { LiveExecutionIntent, type LiveExecutionIntentRecord } from '../../../../src/execution/live/intent';
import { LiveExecutionService } from '../../../../src/execution/live/service';
import type { LiveOrderObservation } from '../../../../src/execution/live/types';
import {
  FakeOrderGateway,
  InMemoryLiveExecutionRepository,
  LIVE_ACCOUNT,
  limitShape,
  livePolicy,
  mintGenuineLiveOpen,
  observationFor,
} from './helpers';

const TIMEOUT = 60_000;

interface Harness {
  readonly service: LiveExecutionService;
  readonly gateway: FakeOrderGateway;
  readonly repository: InMemoryLiveExecutionRepository;
  readonly authority: unknown;
  readonly intent: unknown;
  readonly record: LiveExecutionIntentRecord;
}

async function harness(overrides: Parameters<typeof mintGenuineLiveOpen>[0] = {}): Promise<Harness> {
  const minted = await mintGenuineLiveOpen(overrides);
  const record = LiveExecutionIntent.read(minted.intent);
  if (record === null) throw new Error('fixture');
  const gateway = new FakeOrderGateway();
  const repository = new InMemoryLiveExecutionRepository();
  return {
    service: new LiveExecutionService({ gateway, repository, policy: overrides.policy ?? livePolicy() }),
    gateway,
    repository,
    authority: minted.authority,
    intent: minted.intent,
    record,
  };
}

function ack(record: LiveExecutionIntentRecord): LiveOrderObservation {
  return observationFor(record, { kind: 'ACKNOWLEDGED', exchangeStatus: 'open', providerEventTimeMs: 1_000 });
}

function partial(record: LiveExecutionIntentRecord, cumulative: string, timeMs: number): LiveOrderObservation {
  return observationFor(record, {
    kind: 'PARTIAL_FILL',
    cumulativeFilledQuantity: cumulative,
    averageFillPrice: '100',
    exchangeStatus: 'partially_filled',
    providerEventTimeMs: timeMs,
  });
}

function full(record: LiveExecutionIntentRecord, timeMs: number): LiveOrderObservation {
  return observationFor(record, {
    kind: 'FILL',
    cumulativeFilledQuantity: record.content.quantity,
    averageFillPrice: '100',
    exchangeStatus: 'filled',
    providerEventTimeMs: timeMs,
  });
}

describe('P17 dispatch requires genuine authority and a genuine intent', () => {
  it('refuses a fabricated authority', async () => {
    const h = await harness();
    await expect(h.service.dispatch({ intentId: h.record.intentId }, h.intent)).rejects.toThrow(/LIVE_AUTHORITY_INVALID/);
    expect(h.gateway.placeCallCount).toBe(0);
  }, TIMEOUT);

  it('refuses a hand-built intent object', async () => {
    const h = await harness();
    await expect(h.service.dispatch(h.authority, { ...h.record })).rejects.toThrow(/LIVE_INTENT_INVALID/);
    expect(h.gateway.placeCallCount).toBe(0);
  }, TIMEOUT);
});

describe('P17-I08 a dispatched order is acknowledged, not filled', () => {
  it('records ACKNOWLEDGED with zero fill and the venue order id', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    const outcome = await h.service.dispatch(h.authority, h.intent);
    expect(outcome.kind).toBe('SUBMITTED');
    expect(outcome.order.state).toBe('ACKNOWLEDGED');
    expect(outcome.order.cumulativeFilledQuantity).toBe('0');
    expect(outcome.order.remainingQuantity).toBe(h.record.content.quantity);
    expect(outcome.order.exchangeOrderId).toBe('venue-order-1');
  }, TIMEOUT);

  it('sends the venue order-type lexeme and the deterministic client order id', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    await h.service.dispatch(h.authority, h.intent);
    expect(h.gateway.calls).toEqual([{ operation: 'place', clientOrderId: h.record.clientOrderId }]);
    expect(h.record.wireOrderType).toBe('limit_order');
  }, TIMEOUT);

  it('preserves IOC from the genuine intent through the service gateway port', async () => {
    const policy = livePolicy({ allowedTimeInForce: ['UNSPECIFIED', 'IMMEDIATE_OR_CANCEL'] });
    const h = await harness({
      policy,
      shape: { orderType: 'LIMIT', timeInForce: 'IMMEDIATE_OR_CANCEL', limitPrice: '100' },
    });
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    await h.service.dispatch(h.authority, h.intent);
    expect(h.gateway.placeRequests[0]?.timeInForce).toBe('IMMEDIATE_OR_CANCEL');
  }, TIMEOUT);
});

describe('P17-I07 dispatch is idempotent and never double-sends', () => {
  it('one genuine admission cannot dispatch two economically distinct intents', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const firstMint = await mintGenuineLiveOpen({ coordinator, shape: limitShape('100') });
    const secondMint = await mintGenuineLiveOpen({ coordinator, shape: limitShape('99') });
    const first = LiveExecutionIntent.read(firstMint.intent)!;
    const second = LiveExecutionIntent.read(secondMint.intent)!;
    expect(first.content.admissionId).toBe(second.content.admissionId);
    expect(first.intentId).not.toBe(second.intentId);
    const gateway = new FakeOrderGateway().queuePlace({ kind: 'ACCEPTED', observation: ack(first) });
    const repository = new InMemoryLiveExecutionRepository();
    const service = new LiveExecutionService({ gateway, repository, policy: livePolicy() });
    await service.dispatch(firstMint.authority, firstMint.intent);
    await expect(service.dispatch(secondMint.authority, secondMint.intent)).rejects.toThrow(/Admission already consumed/);
    expect(gateway.placeCallCount).toBe(1);
  }, TIMEOUT);

  it('a released genuine admission cannot dispatch', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const minted = await mintGenuineLiveOpen({ coordinator });
    const record = LiveExecutionAuthority.read(minted.authority);
    if (record?.admission === null || record?.admission === undefined) throw new Error('fixture');
    await coordinator.release(record.accountId, record.admission.admissionId);
    const gateway = new FakeOrderGateway();
    const service = new LiveExecutionService({ gateway, repository: new InMemoryLiveExecutionRepository(), policy: livePolicy() });
    await expect(service.dispatch(minted.authority, minted.intent)).rejects.toThrow(/Admission unavailable/);
    expect(gateway.placeCallCount).toBe(0);
  }, TIMEOUT);

  it('a durable same-intent consumption cannot revive a released admission on retry', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const minted = await mintGenuineLiveOpen({ coordinator });
    const record = LiveExecutionIntent.read(minted.intent)!;
    const authority = LiveExecutionAuthority.read(minted.authority);
    if (authority?.admission === null || authority?.admission === undefined) throw new Error('fixture');
    const gateway = new FakeOrderGateway().queuePlace({ kind: 'PRE_DISPATCH_FAILURE', reasonCode: 'CONNECT_REFUSED' });
    const repository = new InMemoryLiveExecutionRepository();
    const service = new LiveExecutionService({ gateway, repository, policy: livePolicy() });

    await expect(service.dispatch(minted.authority, minted.intent)).rejects.toThrow(/LIVE_PROVIDER_ERROR/);
    expect((await repository.load(record.intentId))?.state).toBe('CREATED');
    await coordinator.release(record.content.accountId, authority.admission.admissionId);

    await expect(service.dispatch(minted.authority, minted.intent)).rejects.toThrow(/Admission unavailable/);
    expect(gateway.placeCallCount).toBe(1);
  }, TIMEOUT);

  it('concurrent same-intent retries after release produce no new mutation winner', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const minted = await mintGenuineLiveOpen({ coordinator });
    const record = LiveExecutionIntent.read(minted.intent)!;
    const authority = LiveExecutionAuthority.read(minted.authority);
    if (authority?.admission === null || authority?.admission === undefined) throw new Error('fixture');
    const gateway = new FakeOrderGateway().queuePlace({ kind: 'PRE_DISPATCH_FAILURE', reasonCode: 'CONNECT_REFUSED' });
    const service = new LiveExecutionService({ gateway, repository: new InMemoryLiveExecutionRepository(), policy: livePolicy() });
    await expect(service.dispatch(minted.authority, minted.intent)).rejects.toThrow(/LIVE_PROVIDER_ERROR/);
    await coordinator.release(record.content.accountId, authority.admission.admissionId);

    const retries = await Promise.allSettled([
      service.dispatch(minted.authority, minted.intent),
      service.dispatch(minted.authority, minted.intent),
    ]);
    expect(retries.some((result) => result.status === 'rejected')).toBe(true);
    expect(retries.every((result) => result.status === 'rejected'
      || (result.status === 'fulfilled' && result.value.kind === 'ALREADY_DISPATCHED'))).toBe(true);
    expect(gateway.placeCallCount).toBe(1);
  }, TIMEOUT);

  it('a replay of the same intent performs no second exchange mutation', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    const first = await h.service.dispatch(h.authority, h.intent);
    const second = await h.service.dispatch(h.authority, h.intent);
    expect(first.kind).toBe('SUBMITTED');
    expect(second.kind).toBe('ALREADY_DISPATCHED');
    expect(second.order.state).toBe('ACKNOWLEDGED');
    expect(h.gateway.placeCallCount).toBe(1);
  }, TIMEOUT);

  it('two concurrent workers on the same intent produce exactly one exchange mutation', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    const [a, b] = await Promise.all([
      h.service.dispatch(h.authority, h.intent),
      h.service.dispatch(h.authority, h.intent),
    ]);
    expect(h.gateway.placeCallCount).toBe(1);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['ALREADY_DISPATCHED', 'SUBMITTED']);
  }, TIMEOUT);

  it('four concurrent workers still produce exactly one exchange mutation', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    const outcomes = await Promise.all([
      h.service.dispatch(h.authority, h.intent),
      h.service.dispatch(h.authority, h.intent),
      h.service.dispatch(h.authority, h.intent),
      h.service.dispatch(h.authority, h.intent),
    ]);
    expect(h.gateway.placeCallCount).toBe(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'SUBMITTED')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'ALREADY_DISPATCHED')).toHaveLength(3);
  }, TIMEOUT);

  it('a conflicting intent claiming an already-bound client order id fails closed', async () => {
    const h = await harness();
    const conflicting: LiveExecutionIntentRecord = {
      ...h.record,
      intentId: 'a'.repeat(64),
      content: { ...h.record.content, quantity: '99' },
    };
    await h.repository.ensureIntent(conflicting);
    await expect(h.service.dispatch(h.authority, h.intent)).rejects.toThrow(/LIVE_INTENT_CONFLICT/);
    expect(h.gateway.placeCallCount).toBe(0);
  }, TIMEOUT);

  it('a stored intent binding different economics to the same identity fails closed', async () => {
    const h = await harness();
    await h.repository.ensureIntent({ ...h.record, content: { ...h.record.content, quantity: '99' } });
    await expect(h.service.dispatch(h.authority, h.intent)).rejects.toThrow(/LIVE_INTENT_CONFLICT/);
    expect(h.gateway.placeCallCount).toBe(0);
  }, TIMEOUT);
});

describe('P17-I09 fills accumulate exactly through the service', () => {
  it('applies one partial fill', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    await h.service.dispatch(h.authority, h.intent);
    const order = await h.service.applyObservation(h.record.intentId, partial(h.record, '0.0001', 2_000));
    expect(order.state).toBe('PARTIALLY_FILLED');
    expect(order.cumulativeFilledQuantity).toBe('0.0001');
  }, TIMEOUT);

  it('applies several partial fills and then a full fill', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    await h.service.dispatch(h.authority, h.intent);
    await h.service.applyObservation(h.record.intentId, partial(h.record, '0.0001', 2_000));
    await h.service.applyObservation(h.record.intentId, partial(h.record, '0.0002', 3_000));
    const filled = await h.service.applyObservation(h.record.intentId, full(h.record, 4_000));
    expect(filled.state).toBe('FILLED');
    expect(filled.cumulativeFilledQuantity).toBe(h.record.content.quantity);
    expect(filled.remainingQuantity).toBe('0');
  }, TIMEOUT);

  it('a duplicate provider event changes nothing and is recorded once', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    await h.service.dispatch(h.authority, h.intent);
    const event = partial(h.record, '0.0001', 2_000);
    const first = await h.service.applyObservation(h.record.intentId, event);
    const commitsAfterFirst = h.repository.commitCount;
    const second = await h.service.applyObservation(h.record.intentId, event);
    expect(second.cumulativeFilledQuantity).toBe(first.cumulativeFilledQuantity);
    expect(second.revision).toBe(first.revision);
    expect(h.repository.commitCount).toBe(commitsAfterFirst);
  }, TIMEOUT);

  it('an out-of-order provider event never regresses cumulative fill', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    await h.service.dispatch(h.authority, h.intent);
    await h.service.applyObservation(h.record.intentId, partial(h.record, '0.0002', 5_000));
    const late = await h.service.applyObservation(h.record.intentId, partial(h.record, '0.0001', 2_000));
    expect(late.cumulativeFilledQuantity).toBe('0.0002');
    expect(late.state).toBe('PARTIALLY_FILLED');
  }, TIMEOUT);

  it('an observation for another order is refused at the identity check', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    await h.service.dispatch(h.authority, h.intent);
    const eventsBefore = h.repository.eventCount;
    const foreign = observationFor(h.record, { clientOrderId: 'p17-' + 'f'.repeat(32), providerEventTimeMs: 2_000 });
    await expect(h.service.applyObservation(h.record.intentId, foreign)).rejects.toThrow(/LIVE_ORDER_IDENTITY_MISMATCH/);
    expect(h.repository.eventCount).toBe(eventsBefore);
  }, TIMEOUT);

  it('a side mismatch is rejected before append-only event persistence', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    await h.service.dispatch(h.authority, h.intent);
    const eventsBefore = h.repository.eventCount;
    await expect(h.service.applyObservation(h.record.intentId, observationFor(h.record, {
      side: h.record.content.side === 'BUY' ? 'SELL' : 'BUY',
      providerEventTimeMs: 2_000,
    }))).rejects.toThrow(/LIVE_ORDER_IDENTITY_MISMATCH/);
    expect(h.repository.eventCount).toBe(eventsBefore);
  }, TIMEOUT);

  it('a mismatched exchange order id is rejected before append-only event persistence', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    await h.service.dispatch(h.authority, h.intent);
    const eventsBefore = h.repository.eventCount;
    await expect(h.service.applyObservation(h.record.intentId, observationFor(h.record, {
      exchangeOrderId: 'different-venue-order',
      providerEventTimeMs: 2_000,
    }))).rejects.toThrow(/LIVE_ORDER_IDENTITY_MISMATCH/);
    expect(h.repository.eventCount).toBe(eventsBefore);
  }, TIMEOUT);
});

describe('P17 rejection is terminal', () => {
  it('records an explicit venue rejection without any fill', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'REJECTED', reasonCode: 'HTTP_400', observation: null });
    const outcome = await h.service.dispatch(h.authority, h.intent);
    expect(outcome.kind).toBe('REJECTED');
    expect(outcome.order.state).toBe('REJECTED');
    expect(outcome.order.faultCode).toBe('HTTP_400');
    expect(outcome.order.cumulativeFilledQuantity).toBe('0');
  }, TIMEOUT);

  it('never re-dispatches a rejected intent', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'REJECTED', reasonCode: 'HTTP_400', observation: null });
    await h.service.dispatch(h.authority, h.intent);
    const replay = await h.service.dispatch(h.authority, h.intent);
    expect(replay.kind).toBe('ALREADY_DISPATCHED');
    expect(h.gateway.placeCallCount).toBe(1);
  }, TIMEOUT);
});

describe('P17-I14/I20 an unestablished outcome fails closed and is never retried', () => {
  it('a timeout after the request may have reached CoinDCX becomes SUBMISSION_AMBIGUOUS', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const outcome = await h.service.dispatch(h.authority, h.intent);
    expect(outcome.kind).toBe('AMBIGUOUS');
    expect(outcome.order.state).toBe('SUBMISSION_AMBIGUOUS');
    expect(outcome.order.faultCode).toBe('LIVE_SUBMISSION_AMBIGUOUS');
    expect(outcome.order.exchangeOrderId).toBeNull();
  }, TIMEOUT);

  it('refuses to resend an ambiguous intent — no blind retry', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' }, { kind: 'ACCEPTED', observation: ack(h.record) });
    await h.service.dispatch(h.authority, h.intent);
    await expect(h.service.dispatch(h.authority, h.intent)).rejects.toThrow(/LIVE_SUBMISSION_AMBIGUOUS/);
    expect(h.gateway.placeCallCount).toBe(1);
  }, TIMEOUT);

  it('defers resolution of an ambiguous submission to Phase18 rather than reading it back', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    await h.service.dispatch(h.authority, h.intent);
    await expect(h.service.syncOrderState(h.record.intentId)).rejects.toThrow(/LIVE_SUBMISSION_AMBIGUOUS/);
    await expect(h.service.cancel(h.authority, h.intent)).rejects.toThrow(/LIVE_CANCEL_AMBIGUOUS/);
  }, TIMEOUT);

  it('a failure proven to precede dispatch releases the claim and stays retryable', async () => {
    const h = await harness();
    h.gateway.queuePlace(
      { kind: 'PRE_DISPATCH_FAILURE', reasonCode: 'TRANSPORT_ERROR' },
      { kind: 'ACCEPTED', observation: ack(h.record) },
    );
    await expect(h.service.dispatch(h.authority, h.intent)).rejects.toThrow(/LIVE_PROVIDER_ERROR/);
    const afterFailure = await h.repository.load(h.record.intentId);
    expect(afterFailure?.state).toBe('CREATED');
    expect(afterFailure?.faultCode).toBe('TRANSPORT_ERROR');

    const retry = await h.service.dispatch(h.authority, h.intent);
    expect(retry.kind).toBe('SUBMITTED');
    expect(h.gateway.placeCallCount).toBe(2);
  }, TIMEOUT);
});

describe('P17-I13 cancellation', () => {
  async function acknowledged(): Promise<Harness> {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    await h.service.dispatch(h.authority, h.intent);
    return h;
  }

  it('cancels an acknowledged order and preserves the zero fill', async () => {
    const h = await acknowledged();
    h.gateway.queueCancel({
      kind: 'CANCEL_ACCEPTED',
      observation: observationFor(h.record, { kind: 'CANCELLED', exchangeStatus: 'cancelled', providerEventTimeMs: 3_000 }),
    });
    const outcome = await h.service.cancel(h.authority, h.intent);
    expect(outcome.kind).toBe('CANCELLED');
    expect(outcome.order.state).toBe('CANCELLED');
    expect(outcome.order.cumulativeFilledQuantity).toBe('0');
  }, TIMEOUT);

  it('keeps fills that raced the cancellation', async () => {
    const h = await acknowledged();
    await h.service.applyObservation(h.record.intentId, partial(h.record, '0.0001', 2_000));
    h.gateway.queueCancel({
      kind: 'CANCEL_ACCEPTED',
      observation: observationFor(h.record, {
        kind: 'CANCELLED',
        cumulativeFilledQuantity: '0.0001',
        averageFillPrice: '100',
        exchangeStatus: 'partially_cancelled',
        providerEventTimeMs: 3_000,
      }),
    });
    const outcome = await h.service.cancel(h.authority, h.intent);
    expect(outcome.kind).toBe('CANCELLED');
    expect(outcome.order.cumulativeFilledQuantity).toBe('0.0001');
  }, TIMEOUT);

  it('reports a full fill that beat the cancellation, never a fabricated CANCELLED', async () => {
    const h = await acknowledged();
    h.gateway.queueCancel({
      kind: 'CANCEL_ACCEPTED',
      observation: observationFor(h.record, {
        kind: 'CANCELLED',
        cumulativeFilledQuantity: h.record.content.quantity,
        averageFillPrice: '100',
        exchangeStatus: 'cancelled',
        providerEventTimeMs: 3_000,
      }),
    });
    const outcome = await h.service.cancel(h.authority, h.intent);
    expect(outcome.kind).toBe('FILLED_BEFORE_CANCEL');
    expect(outcome.order.state).toBe('FILLED');
  }, TIMEOUT);

  it('a bare cancel acknowledgement is not proof of zero fill: authoritative state is read back', async () => {
    const h = await acknowledged();
    h.gateway.queueCancel({ kind: 'CANCEL_ACCEPTED', observation: null });
    h.gateway.queueFetch({
      kind: 'FOUND',
      observation: observationFor(h.record, {
        kind: 'CANCELLED',
        cumulativeFilledQuantity: '0.0001',
        averageFillPrice: '100',
        exchangeStatus: 'partially_cancelled',
        providerEventTimeMs: 3_000,
      }),
    });
    const outcome = await h.service.cancel(h.authority, h.intent);
    expect(outcome.kind).toBe('CANCELLED');
    expect(outcome.order.cumulativeFilledQuantity).toBe('0.0001');
  }, TIMEOUT);

  it('records LIVE_CANCEL_AMBIGUOUS when neither the cancel nor a read-back establishes truth', async () => {
    const h = await acknowledged();
    h.gateway.queueCancel({ kind: 'CANCEL_ACCEPTED', observation: null });
    h.gateway.queueFetch({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const outcome = await h.service.cancel(h.authority, h.intent);
    expect(outcome.kind).toBe('AMBIGUOUS');
    expect(outcome.order.state).toBe('CANCEL_REQUESTED');
    expect(outcome.order.faultCode).toBe('LIVE_CANCEL_AMBIGUOUS');
  }, TIMEOUT);

  it('records LIVE_CANCEL_AMBIGUOUS when the cancel itself is unestablished', async () => {
    const h = await acknowledged();
    h.gateway.queueCancel({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const outcome = await h.service.cancel(h.authority, h.intent);
    expect(outcome.kind).toBe('AMBIGUOUS');
    expect(outcome.order.faultCode).toBe('LIVE_CANCEL_AMBIGUOUS');
  }, TIMEOUT);

  it('reports NOT_CANCELLABLE for an order that was never dispatched or is already terminal', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    await h.repository.ensureIntent(h.record);
    const never = await h.service.cancel(h.authority, h.intent);
    expect(never.kind).toBe('NOT_CANCELLABLE');

    await h.service.dispatch(h.authority, h.intent);
    await h.service.applyObservation(h.record.intentId, full(h.record, 4_000));
    const terminal = await h.service.cancel(h.authority, h.intent);
    expect(terminal.kind).toBe('NOT_CANCELLABLE');
    expect(terminal.order.state).toBe('FILLED');
  }, TIMEOUT);

  it('cancels after a service restart using only durable order state and configured account ownership', async () => {
    const h = await acknowledged();
    const restartedGateway = new FakeOrderGateway().queueCancel({
      kind: 'CANCEL_ACCEPTED',
      observation: observationFor(h.record, { kind: 'CANCELLED', exchangeStatus: 'cancelled', providerEventTimeMs: 3_000 }),
    });
    const restarted = new LiveExecutionService({ gateway: restartedGateway, repository: h.repository, policy: livePolicy() });
    const outcome = await restarted.cancelDurable(h.record.intentId, LIVE_ACCOUNT);
    expect(outcome.kind).toBe('CANCELLED');
    expect(restartedGateway.cancelCallCount).toBe(1);
  }, TIMEOUT);

  it('release does not retroactively invalidate an acknowledged order or its durable cancellation authority', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const minted = await mintGenuineLiveOpen({ coordinator });
    const record = LiveExecutionIntent.read(minted.intent)!;
    const authority = LiveExecutionAuthority.read(minted.authority);
    if (authority?.admission === null || authority?.admission === undefined) throw new Error('fixture');
    const gateway = new FakeOrderGateway()
      .queuePlace({ kind: 'ACCEPTED', observation: ack(record) })
      .queueCancel({
        kind: 'CANCEL_ACCEPTED',
        observation: observationFor(record, { kind: 'CANCELLED', exchangeStatus: 'cancelled', providerEventTimeMs: 3_000 }),
      });
    const service = new LiveExecutionService({ gateway, repository: new InMemoryLiveExecutionRepository(), policy: livePolicy() });
    await service.dispatch(minted.authority, minted.intent);
    await coordinator.release(record.content.accountId, authority.admission.admissionId);

    await expect(service.cancelDurable(record.intentId, record.content.accountId)).resolves.toMatchObject({ kind: 'CANCELLED' });
    expect(gateway.cancelCallCount).toBe(1);
  }, TIMEOUT);

  it('cancels a partially-filled order after restart without a retained authority object', async () => {
    const h = await acknowledged();
    await h.service.applyObservation(h.record.intentId, partial(h.record, '0.0001', 2_000));
    const restartedGateway = new FakeOrderGateway().queueCancel({
      kind: 'CANCEL_ACCEPTED',
      observation: observationFor(h.record, { kind: 'CANCELLED', cumulativeFilledQuantity: '0.0001', averageFillPrice: '100', exchangeStatus: 'partially_cancelled', providerEventTimeMs: 3_000 }),
    });
    const restarted = new LiveExecutionService({ gateway: restartedGateway, repository: h.repository, policy: livePolicy() });
    const outcome = await restarted.cancelDurable(h.record.intentId, LIVE_ACCOUNT);
    expect(outcome.order.cumulativeFilledQuantity).toBe('0.0001');
    expect(outcome.order.state).toBe('CANCELLED');
  }, TIMEOUT);

  it('gives one concurrent cancel caller the mutation claim', async () => {
    const h = await acknowledged();
    h.gateway.queueCancel({ kind: 'CANCEL_ACCEPTED', observation: observationFor(h.record, { kind: 'CANCELLED', exchangeStatus: 'cancelled', providerEventTimeMs: 3_000 }) });
    const [a, b] = await Promise.all([
      h.service.cancelDurable(h.record.intentId, LIVE_ACCOUNT),
      h.service.cancelDurable(h.record.intentId, LIVE_ACCOUNT),
    ]);
    expect(h.gateway.cancelCallCount).toBe(1);
    expect([a.kind, b.kind]).toContain('CANCELLED');
    expect(['CANCEL_REQUESTED', 'NOT_CANCELLABLE']).toContain([a, b].find((value) => value.kind !== 'CANCELLED')?.kind);
  }, TIMEOUT);

  it('never blindly resends an ambiguous cancellation', async () => {
    const h = await acknowledged();
    h.gateway.queueCancel({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const first = await h.service.cancelDurable(h.record.intentId, LIVE_ACCOUNT);
    const second = await h.service.cancelDurable(h.record.intentId, LIVE_ACCOUNT);
    expect(first.kind).toBe('AMBIGUOUS');
    expect(second.kind).toBe('AMBIGUOUS');
    expect(h.gateway.cancelCallCount).toBe(1);
  }, TIMEOUT);

  it('does not send a duplicate cancel after a successful terminal observation', async () => {
    const h = await acknowledged();
    h.gateway.queueCancel({ kind: 'CANCEL_ACCEPTED', observation: observationFor(h.record, { kind: 'CANCELLED', exchangeStatus: 'cancelled', providerEventTimeMs: 3_000 }) });
    expect((await h.service.cancelDurable(h.record.intentId, LIVE_ACCOUNT)).kind).toBe('CANCELLED');
    expect((await h.service.cancelDurable(h.record.intentId, LIVE_ACCOUNT)).kind).toBe('NOT_CANCELLABLE');
    expect(h.gateway.cancelCallCount).toBe(1);
  }, TIMEOUT);

  it('classifies a stranded dispatch reservation as explicit ambiguity and never resubmits it', async () => {
    const h = await harness();
    await h.repository.ensureIntent(h.record);
    await h.repository.claimDispatch(h.record.intentId, async () => true);
    await expect(h.service.cancelDurable(h.record.intentId, LIVE_ACCOUNT)).rejects.toThrow(/LIVE_CANCEL_AMBIGUOUS/);
    expect((await h.repository.load(h.record.intentId))?.state).toBe('SUBMISSION_AMBIGUOUS');
    expect(h.gateway.placeCallCount).toBe(0);
    expect(h.gateway.cancelCallCount).toBe(0);
  }, TIMEOUT);
});

describe('P17 order-status synchronisation', () => {
  it('folds authoritative venue state into durable state', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    await h.service.dispatch(h.authority, h.intent);
    h.gateway.queueFetch({ kind: 'FOUND', observation: full(h.record, 6_000) });
    const synced = await h.service.syncOrderState(h.record.intentId);
    expect(synced.state).toBe('FILLED');
  }, TIMEOUT);

  it('leaves state untouched when the venue reports nothing', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    await h.service.dispatch(h.authority, h.intent);
    h.gateway.queueFetch({ kind: 'NOT_FOUND' });
    const synced = await h.service.syncOrderState(h.record.intentId);
    expect(synced.state).toBe('ACKNOWLEDGED');
  }, TIMEOUT);

  it('never reads back an order that was never dispatched', async () => {
    const h = await harness();
    await h.repository.ensureIntent(h.record);
    const synced = await h.service.syncOrderState(h.record.intentId);
    expect(synced.state).toBe('CREATED');
    expect(h.gateway.calls).toEqual([]);
  }, TIMEOUT);

  it('refuses to operate on an intent that was never durably recorded', async () => {
    const h = await harness();
    await expect(h.service.syncOrderState('unknown-intent')).rejects.toThrow(LiveExecutionError);
  }, TIMEOUT);
});

describe('P17 Wave C provider conflict containment', () => {
  it('persists a late fill after cancellation and cannot automatically dispatch from the conflict state', async () => {
    const h = await harness();
    h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
    await h.service.dispatch(h.authority, h.intent);
    h.gateway.queueCancel({ kind: 'CANCEL_ACCEPTED', observation: observationFor(h.record, { kind: 'CANCELLED', exchangeStatus: 'cancelled', providerEventTimeMs: 2_000 }) });
    await h.service.cancel(h.authority, h.intent);
    const conflict = await h.service.applyObservation(h.record.intentId, partial(h.record, '0.0001', 3_000));
    expect(conflict.state).toBe('RECONCILIATION_REQUIRED');
    expect(conflict.cumulativeFilledQuantity).toBe('0.0001');
    const replay = await h.service.dispatch(h.authority, h.intent);
    expect(replay.kind).toBe('ALREADY_DISPATCHED');
    expect(h.gateway.placeCallCount).toBe(1);
  }, TIMEOUT);
});

describe('P17 the live execution path is pair-generic', () => {
  it('dispatches BTC, ETH, and SOL through the very same service and classes', async () => {
    const pairs = ['B-BTC_USDT', 'B-ETH_USDT', 'B-SOL_USDT'] as const;
    const states: string[] = [];
    for (const pair of pairs) {
      const h = await harness({ pair, shape: limitShape('100') });
      h.gateway.queuePlace({ kind: 'ACCEPTED', observation: ack(h.record) });
      const outcome = await h.service.dispatch(h.authority, h.intent);
      expect(outcome.order.pair).toBe(pair);
      expect(h.service).toBeInstanceOf(LiveExecutionService);
      states.push(outcome.order.state);
    }
    expect(states).toEqual(['ACKNOWLEDGED', 'ACKNOWLEDGED', 'ACKNOWLEDGED']);
  }, 120_000);
});
