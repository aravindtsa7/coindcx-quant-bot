import { describe, expect, it } from 'vitest';
import {
  applyLiveOrderObservation,
  initialLiveOrderState,
  isLiveTerminalState,
  markCancelAmbiguous,
  markRejected,
  markSubmissionAmbiguous,
  releaseDispatchClaim,
  requestCancel,
  reserveDispatch,
  LIVE_ORDER_TRANSITIONS,
  LIVE_TERMINAL_STATES,
} from '../../../../src/execution/live/state-machine';
import type { LiveOrderObservation, LiveOrderStateName, LiveOrderStateRecord } from '../../../../src/execution/live/types';
import { LiveExecutionError } from '../../../../src/execution/live/errors';

const CLIENT_ORDER_ID = 'p17-' + 'a'.repeat(32);
const EXCHANGE_ORDER_ID = 'venue-1';
const PAIR = 'B-BTC_USDT';

function created(orderedQuantity = '2'): LiveOrderStateRecord {
  return initialLiveOrderState({
    intentId: 'intent-1',
    clientOrderId: CLIENT_ORDER_ID,
    accountId: 'account-live-1',
    pair: PAIR,
    orderedQuantity,
  });
}

function observation(overrides: Partial<LiveOrderObservation> = {}): LiveOrderObservation {
  return Object.freeze({
    kind: 'ACKNOWLEDGED',
    clientOrderId: CLIENT_ORDER_ID,
    exchangeClientOrderId: null,
    exchangeOrderId: EXCHANGE_ORDER_ID,
    pair: PAIR,
    side: 'BUY',
    cumulativeFilledQuantity: '0',
    orderedQuantity: '2',
    averageFillPrice: null,
    exchangeStatus: 'open',
    providerEventTimeMs: 1_000,
    ...overrides,
  });
}

/** Applies an observation and asserts it was genuinely applied. */
function apply(order: LiveOrderStateRecord, next: LiveOrderObservation): LiveOrderStateRecord {
  const application = applyLiveOrderObservation(order, next);
  if (application.kind !== 'APPLIED') throw new Error(`expected APPLIED, got ${application.kind}`);
  return application.order;
}

function acknowledged(): LiveOrderStateRecord {
  return apply(reserveDispatch(created()), observation());
}

describe('P17 initial state and dispatch claim', () => {
  it('starts CREATED with zero fill and full remaining quantity', () => {
    const order = created();
    expect(order.state).toBe('CREATED');
    expect(order.cumulativeFilledQuantity).toBe('0');
    expect(order.remainingQuantity).toBe('2');
    expect(order.exchangeOrderId).toBeNull();
    expect(order.revision).toBe(0);
  });

  it('CREATED -> DISPATCH_RESERVED bumps the optimistic-concurrency revision', () => {
    const reserved = reserveDispatch(created());
    expect(reserved.state).toBe('DISPATCH_RESERVED');
    expect(reserved.revision).toBe(1);
  });

  it('refuses to reserve an already-reserved order', () => {
    expect(() => reserveDispatch(reserveDispatch(created()))).toThrow(/LIVE_ORDER_STATE_CONFLICT/);
  });

  it('releases a claim back to CREATED only when nothing reached the exchange', () => {
    const released = releaseDispatchClaim(reserveDispatch(created()), 'TRANSPORT_ERROR');
    expect(released.state).toBe('CREATED');
    expect(released.faultCode).toBe('TRANSPORT_ERROR');
  });

  it('never releases a claim once an exchange order id exists', () => {
    const acked = acknowledged();
    expect(() => releaseDispatchClaim(acked, 'TRANSPORT_ERROR')).toThrow(/LIVE_ORDER_STATE_CONFLICT/);
  });
});

describe('P17-I08 acknowledgement is not a fill', () => {
  it('an ACK with zero executed quantity lands in ACKNOWLEDGED, not FILLED', () => {
    const acked = acknowledged();
    expect(acked.state).toBe('ACKNOWLEDGED');
    expect(acked.cumulativeFilledQuantity).toBe('0');
    expect(acked.remainingQuantity).toBe('2');
    expect(acked.exchangeOrderId).toBe(EXCHANGE_ORDER_ID);
    expect(acked.lastExchangeStatus).toBe('open');
  });

  it('an ACK that simultaneously reports executed quantity reflects the fill facts', () => {
    const order = apply(reserveDispatch(created()), observation({ cumulativeFilledQuantity: '0.5', averageFillPrice: '100' }));
    expect(order.state).toBe('PARTIALLY_FILLED');
    expect(order.cumulativeFilledQuantity).toBe('0.5');
  });
});

describe('P17-I09 partial fills are first class', () => {
  it('tracks an exact partial fill and exact remaining quantity', () => {
    const partial = apply(acknowledged(), observation({
      kind: 'PARTIAL_FILL',
      cumulativeFilledQuantity: '0.7',
      averageFillPrice: '100.25',
      exchangeStatus: 'partially_filled',
      providerEventTimeMs: 2_000,
    }));
    expect(partial.state).toBe('PARTIALLY_FILLED');
    expect(partial.cumulativeFilledQuantity).toBe('0.7');
    expect(partial.remainingQuantity).toBe('1.3');
    expect(partial.averageFillPrice).toBe('100.25');
  });

  it('accumulates multiple partial fills monotonically', () => {
    let order = acknowledged();
    order = apply(order, observation({ kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '0.5', averageFillPrice: '100', exchangeStatus: 'partially_filled', providerEventTimeMs: 2_000 }));
    order = apply(order, observation({ kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '1.25', averageFillPrice: '101', exchangeStatus: 'partially_filled', providerEventTimeMs: 3_000 }));
    order = apply(order, observation({ kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '1.75', averageFillPrice: '101.5', exchangeStatus: 'partially_filled', providerEventTimeMs: 4_000 }));
    expect(order.cumulativeFilledQuantity).toBe('1.75');
    expect(order.remainingQuantity).toBe('0.25');
    expect(order.state).toBe('PARTIALLY_FILLED');
  });

  it('completes into FILLED only when cumulative fill equals the ordered quantity', () => {
    let order = acknowledged();
    order = apply(order, observation({ kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '1', averageFillPrice: '100', exchangeStatus: 'partially_filled', providerEventTimeMs: 2_000 }));
    order = apply(order, observation({ kind: 'FILL', cumulativeFilledQuantity: '2', averageFillPrice: '100.5', exchangeStatus: 'filled', providerEventTimeMs: 3_000 }));
    expect(order.state).toBe('FILLED');
    expect(order.remainingQuantity).toBe('0');
    expect(order.averageFillPrice).toBe('100.5');
  });

  it('never coerces a partial into a full fill', () => {
    expect(() => applyLiveOrderObservation(acknowledged(), observation({
      kind: 'FILL',
      cumulativeFilledQuantity: '1.5',
      exchangeStatus: 'filled',
      providerEventTimeMs: 2_000,
    }))).toThrow(/LIVE_FILL_INVALID/);
  });

  it('rejects an over-fill beyond the ordered quantity', () => {
    expect(() => applyLiveOrderObservation(acknowledged(), observation({
      kind: 'PARTIAL_FILL',
      cumulativeFilledQuantity: '2.5',
      exchangeStatus: 'partially_filled',
      providerEventTimeMs: 2_000,
    }))).toThrow(/LIVE_FILL_INVALID/);
  });

  it('rejects a negative cumulative fill', () => {
    expect(() => applyLiveOrderObservation(acknowledged(), observation({
      cumulativeFilledQuantity: '-0.1',
      providerEventTimeMs: 2_000,
    }))).toThrow(LiveExecutionError);
  });

  it('rejects a partial-fill observation that reports nothing executed', () => {
    expect(() => applyLiveOrderObservation(acknowledged(), observation({
      kind: 'PARTIAL_FILL',
      cumulativeFilledQuantity: '0',
      exchangeStatus: 'partially_filled',
      providerEventTimeMs: 2_000,
    }))).toThrow(/LIVE_FILL_INVALID/);
  });

  it('rejects a fresh observation whose cumulative fill regressed', () => {
    const partial = apply(acknowledged(), observation({ kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '1', averageFillPrice: '100', exchangeStatus: 'partially_filled', providerEventTimeMs: 2_000 }));
    expect(() => applyLiveOrderObservation(partial, observation({
      kind: 'PARTIAL_FILL',
      cumulativeFilledQuantity: '0.5',
      averageFillPrice: '99',
      exchangeStatus: 'partially_filled',
      providerEventTimeMs: 3_000,
    }))).toThrow(/LIVE_FILL_INVALID/);
  });
});

describe('P17 duplicate and out-of-order provider events', () => {
  it('an exact replay of an applied observation is a DUPLICATE no-op', () => {
    const acked = acknowledged();
    const replay = applyLiveOrderObservation(acked, observation());
    expect(replay.kind).toBe('DUPLICATE');
    expect(replay.order).toBe(acked);
    expect(replay.order.revision).toBe(acked.revision);
  });

  it('a late observation with a lower cumulative fill is STALE and never regresses state', () => {
    const partial = apply(acknowledged(), observation({ kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '1.5', averageFillPrice: '100', exchangeStatus: 'partially_filled', providerEventTimeMs: 5_000 }));
    const late = applyLiveOrderObservation(partial, observation({
      kind: 'PARTIAL_FILL',
      cumulativeFilledQuantity: '0.5',
      averageFillPrice: '99',
      exchangeStatus: 'partially_filled',
      providerEventTimeMs: 2_000,
    }));
    expect(late.kind).toBe('STALE');
    expect(late.order.cumulativeFilledQuantity).toBe('1.5');
    expect(late.order.state).toBe('PARTIALLY_FILLED');
  });

  it('a late acknowledgement never demotes a filled order', () => {
    const filled = apply(acknowledged(), observation({ kind: 'FILL', cumulativeFilledQuantity: '2', averageFillPrice: '100', exchangeStatus: 'filled', providerEventTimeMs: 9_000 }));
    const late = applyLiveOrderObservation(filled, observation({ providerEventTimeMs: 1_000 }));
    expect(late.kind).toBe('STALE');
    expect(late.order.state).toBe('FILLED');
  });

  it('replaying a terminal FILL observation is idempotent', () => {
    const fill = observation({ kind: 'FILL', cumulativeFilledQuantity: '2', averageFillPrice: '100', exchangeStatus: 'filled', providerEventTimeMs: 9_000 });
    const filled = apply(acknowledged(), fill);
    const replay = applyLiveOrderObservation(filled, fill);
    expect(replay.kind).toBe('DUPLICATE');
    expect(replay.order.cumulativeFilledQuantity).toBe('2');
  });
});

describe('P17-I13 cancellation correctness', () => {
  it('ACKNOWLEDGED -> CANCEL_REQUESTED -> CANCELLED preserves a zero fill', () => {
    const requested = requestCancel(acknowledged());
    expect(requested.state).toBe('CANCEL_REQUESTED');
    const cancelled = apply(requested, observation({ kind: 'CANCELLED', exchangeStatus: 'cancelled', providerEventTimeMs: 3_000 }));
    expect(cancelled.state).toBe('CANCELLED');
    expect(cancelled.cumulativeFilledQuantity).toBe('0');
  });

  it('a cancel acknowledgement never erases fills confirmed before it', () => {
    const partial = apply(acknowledged(), observation({ kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '0.75', averageFillPrice: '100', exchangeStatus: 'partially_filled', providerEventTimeMs: 2_000 }));
    const cancelled = apply(requestCancel(partial), observation({
      kind: 'CANCELLED',
      cumulativeFilledQuantity: '0.75',
      averageFillPrice: '100',
      exchangeStatus: 'partially_cancelled',
      providerEventTimeMs: 3_000,
    }));
    expect(cancelled.state).toBe('CANCELLED');
    expect(cancelled.cumulativeFilledQuantity).toBe('0.75');
    expect(cancelled.remainingQuantity).toBe('1.25');
  });

  it('a cancel that races a complete fill resolves as FILLED, never CANCELLED-with-full-fill', () => {
    const requested = requestCancel(acknowledged());
    const resolved = apply(requested, observation({
      kind: 'CANCELLED',
      cumulativeFilledQuantity: '2',
      averageFillPrice: '100',
      exchangeStatus: 'cancelled',
      providerEventTimeMs: 3_000,
    }));
    expect(resolved.state).toBe('FILLED');
    expect(resolved.remainingQuantity).toBe('0');
  });

  it('a fill may still arrive after a cancel was requested', () => {
    const requested = requestCancel(acknowledged());
    const filled = apply(requested, observation({ kind: 'FILL', cumulativeFilledQuantity: '2', averageFillPrice: '100', exchangeStatus: 'filled', providerEventTimeMs: 3_000 }));
    expect(filled.state).toBe('FILLED');
  });

  it('a cancel cannot be requested from CREATED or from a terminal state', () => {
    expect(() => requestCancel(created())).toThrow(/LIVE_ORDER_STATE_CONFLICT/);
    const filled = apply(acknowledged(), observation({ kind: 'FILL', cumulativeFilledQuantity: '2', averageFillPrice: '100', exchangeStatus: 'filled', providerEventTimeMs: 3_000 }));
    expect(() => requestCancel(filled)).toThrow(/LIVE_ORDER_STATE_CONFLICT/);
  });

  it('records a cancel ambiguity as a durable fault without changing state', () => {
    const requested = requestCancel(acknowledged());
    const faulted = markCancelAmbiguous(requested, 'LIVE_CANCEL_AMBIGUOUS');
    expect(faulted.state).toBe('CANCEL_REQUESTED');
    expect(faulted.faultCode).toBe('LIVE_CANCEL_AMBIGUOUS');
    expect(faulted.revision).toBe(requested.revision + 1);
  });
});

describe('P17 rejection and ambiguity are terminal', () => {
  it('records a rejection with no executed quantity', () => {
    const rejected = apply(reserveDispatch(created()), observation({ kind: 'REJECTED', exchangeStatus: 'rejected', providerEventTimeMs: 2_000 }));
    expect(rejected.state).toBe('REJECTED');
    expect(rejected.cumulativeFilledQuantity).toBe('0');
  });

  it('refuses a rejection that claims executed quantity', () => {
    expect(() => applyLiveOrderObservation(reserveDispatch(created()), observation({
      kind: 'REJECTED',
      cumulativeFilledQuantity: '1',
      averageFillPrice: '100',
      exchangeStatus: 'rejected',
      providerEventTimeMs: 2_000,
    }))).toThrow(/LIVE_ORDER_STATE_CONFLICT/);
  });

  it('records a venue refusal that carries no order snapshot through the same transition check', () => {
    const rejected = markRejected(reserveDispatch(created()), 'HTTP_400');
    expect(rejected.state).toBe('REJECTED');
    expect(rejected.faultCode).toBe('HTTP_400');
    expect(rejected.revision).toBe(2);
  });

  it('refuses to mark an order rejected once it holds executed quantity', () => {
    const partial = apply(acknowledged(), observation({ kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '1', averageFillPrice: '100', exchangeStatus: 'partially_filled', providerEventTimeMs: 2_000 }));
    expect(() => markRejected(partial, 'HTTP_400')).toThrow(/LIVE_ORDER_STATE_CONFLICT/);
  });

  it('refuses to mark a never-dispatched or terminal order rejected', () => {
    expect(() => markRejected(created(), 'HTTP_400')).toThrow(/LIVE_ORDER_STATE_CONFLICT/);
    const cancelled = apply(requestCancel(acknowledged()), observation({ kind: 'CANCELLED', exchangeStatus: 'cancelled', providerEventTimeMs: 3_000 }));
    expect(() => markRejected(cancelled, 'HTTP_400')).toThrow(/LIVE_ORDER_STATE_CONFLICT/);
  });

  it('preserves a late fill after rejection as a reconciliation-required conflict', () => {
    const rejected = apply(reserveDispatch(created()), observation({ kind: 'REJECTED', exchangeStatus: 'rejected', providerEventTimeMs: 2_000 }));
    const conflict = applyLiveOrderObservation(rejected, observation({
      kind: 'FILL',
      cumulativeFilledQuantity: '2',
      averageFillPrice: '100',
      exchangeStatus: 'filled',
      providerEventTimeMs: 3_000,
    }));
    expect(conflict.kind).toBe('APPLIED');
    expect(conflict.order.state).toBe('RECONCILIATION_REQUIRED');
    expect(conflict.order.cumulativeFilledQuantity).toBe('2');
  });

  it('SUBMISSION_AMBIGUOUS is terminal for Phase17 and admits no further transition', () => {
    const ambiguous = markSubmissionAmbiguous(reserveDispatch(created()), 'LIVE_SUBMISSION_AMBIGUOUS');
    expect(ambiguous.state).toBe('SUBMISSION_AMBIGUOUS');
    expect(ambiguous.faultCode).toBe('LIVE_SUBMISSION_AMBIGUOUS');
    expect(LIVE_ORDER_TRANSITIONS.SUBMISSION_AMBIGUOUS).toEqual([]);
    expect(() => applyLiveOrderObservation(ambiguous, observation({ providerEventTimeMs: 3_000 }))).toThrow(/LIVE_ORDER_STATE_CONFLICT/);
  });

  it('never marks an already-acknowledged order as submission-ambiguous', () => {
    expect(() => markSubmissionAmbiguous(acknowledged(), 'LIVE_SUBMISSION_AMBIGUOUS')).toThrow(/LIVE_ORDER_STATE_CONFLICT/);
  });
});

describe('P17-I16 observation identity is proven before any state change', () => {
  it('refuses an observation for a different client order id', () => {
    expect(() => applyLiveOrderObservation(acknowledged(), observation({ clientOrderId: 'p17-' + 'b'.repeat(32), providerEventTimeMs: 3_000 })))
      .toThrow(/LIVE_ORDER_IDENTITY_MISMATCH/);
  });

  it('refuses an observation for a different pair', () => {
    expect(() => applyLiveOrderObservation(acknowledged(), observation({ pair: 'B-ETH_USDT', providerEventTimeMs: 3_000 })))
      .toThrow(/LIVE_ORDER_IDENTITY_MISMATCH/);
  });

  it('refuses an observation carrying a different exchange order id than already recorded', () => {
    expect(() => applyLiveOrderObservation(acknowledged(), observation({ exchangeOrderId: 'venue-2', providerEventTimeMs: 3_000 })))
      .toThrow(/LIVE_ORDER_IDENTITY_MISMATCH/);
  });

  it('refuses an observation reporting a different ordered quantity', () => {
    expect(() => applyLiveOrderObservation(acknowledged(), observation({ orderedQuantity: '3', providerEventTimeMs: 3_000 })))
      .toThrow(/LIVE_ORDER_IDENTITY_MISMATCH/);
  });
});

describe('P17 frozen transition relation', () => {
  it('declares the ten Phase17 states and the reconciliation terminal state', () => {
    const states = Object.keys(LIVE_ORDER_TRANSITIONS) as LiveOrderStateName[];
    expect(states).toHaveLength(10);
    expect(LIVE_TERMINAL_STATES).toEqual(['FILLED', 'CANCELLED', 'REJECTED', 'SUBMISSION_AMBIGUOUS', 'RECONCILIATION_REQUIRED']);
    for (const terminal of LIVE_TERMINAL_STATES) {
      expect(isLiveTerminalState(terminal)).toBe(true);
    }
    expect(LIVE_ORDER_TRANSITIONS.RECONCILIATION_REQUIRED).toEqual([]);
  });

  it('forbids FILLED -> PARTIALLY_FILLED and CANCELLED -> ACKNOWLEDGED', () => {
    expect(LIVE_ORDER_TRANSITIONS.FILLED).not.toContain('PARTIALLY_FILLED');
    expect(LIVE_ORDER_TRANSITIONS.CANCELLED).not.toContain('ACKNOWLEDGED');
  });

  it('never allows a dispatch to skip the local claim', () => {
    expect(LIVE_ORDER_TRANSITIONS.CREATED).toEqual(['DISPATCH_RESERVED']);
  });
});

describe('P17 Wave C corrected averages and late financial truth', () => {
  it('applies a corrected cumulative average at the same filled quantity', () => {
    const partial = apply(acknowledged(), observation({ kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '1', averageFillPrice: '100', exchangeStatus: 'partially_filled', providerEventTimeMs: 2_000 }));
    const corrected = applyLiveOrderObservation(partial, observation({ kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '1.0', averageFillPrice: '101.25', exchangeStatus: 'partially_filled', providerEventTimeMs: 3_000 }));
    expect(corrected.kind).toBe('APPLIED');
    expect(corrected.order.cumulativeFilledQuantity).toBe('1');
    expect(corrected.order.averageFillPrice).toBe('101.25');
  });

  it('persists the provider cumulative average when filled quantity increases', () => {
    const first = apply(acknowledged(), observation({ kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '0.5', averageFillPrice: '100', exchangeStatus: 'partially_filled', providerEventTimeMs: 2_000 }));
    const second = apply(first, observation({ kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '1.5', averageFillPrice: '104', exchangeStatus: 'partially_filled', providerEventTimeMs: 3_000 }));
    expect(second.averageFillPrice).toBe('104');
  });

  it('fails closed when positive cumulative fill omits its average price', () => {
    expect(() => applyLiveOrderObservation(acknowledged(), observation({ kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '1', averageFillPrice: null, exchangeStatus: 'partially_filled', providerEventTimeMs: 2_000 })))
      .toThrow(/LIVE_FILL_INVALID/);
  });

  it.each([
    ['partial', '1', 'PARTIAL_FILL'],
    ['full', '2', 'FILL'],
  ] as const)('preserves a cancelled projection plus later %s fill as reconciliation-required', (_label, quantity, kind) => {
    const cancelled = apply(requestCancel(acknowledged()), observation({ kind: 'CANCELLED', exchangeStatus: 'cancelled', providerEventTimeMs: 2_000 }));
    const late = applyLiveOrderObservation(cancelled, observation({ kind, cumulativeFilledQuantity: quantity, averageFillPrice: '102', exchangeStatus: kind === 'FILL' ? 'filled' : 'partially_filled', providerEventTimeMs: 3_000 }));
    expect(late.kind).toBe('APPLIED');
    expect(late.order.state).toBe('RECONCILIATION_REQUIRED');
    expect(late.order.cumulativeFilledQuantity).toBe(quantity);
    expect(late.order.averageFillPrice).toBe('102');
  });

  it('deduplicates a repeated late-fill observation after preserving it', () => {
    const cancelled = apply(requestCancel(acknowledged()), observation({ kind: 'CANCELLED', exchangeStatus: 'cancelled', providerEventTimeMs: 2_000 }));
    const late = observation({ kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '1', averageFillPrice: '102', exchangeStatus: 'partially_filled', providerEventTimeMs: 3_000 });
    const conflict = apply(cancelled, late);
    const replay = applyLiveOrderObservation(conflict, late);
    expect(replay.kind).toBe('DUPLICATE');
    expect(replay.order.cumulativeFilledQuantity).toBe('1');
  });

  it('never decreases execution after entering reconciliation-required', () => {
    const cancelled = apply(requestCancel(acknowledged()), observation({ kind: 'CANCELLED', exchangeStatus: 'cancelled', providerEventTimeMs: 2_000 }));
    const conflict = apply(cancelled, observation({ kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '1.5', averageFillPrice: '102', exchangeStatus: 'partially_filled', providerEventTimeMs: 3_000 }));
    expect(() => applyLiveOrderObservation(conflict, observation({ kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '1', averageFillPrice: '101', exchangeStatus: 'partially_filled', providerEventTimeMs: 4_000 })))
      .toThrow(/LIVE_FILL_INVALID/);
    expect(LIVE_ORDER_TRANSITIONS.RECONCILIATION_REQUIRED).toEqual([]);
  });
});
