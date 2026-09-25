/**
 * The frozen Phase17 live order state machine (§7, P17-I08/I09/I13/I14).
 *
 * Pure: no I/O, no clock, no persistence. Every durable state change in
 * `repository.ts` is produced by one of the functions here, so the legality of
 * a transition is decided in exactly one place and is directly unit-testable.
 *
 * Frozen semantics:
 *   - ACKNOWLEDGED is not a fill. A zero-fill acknowledgement never advances
 *     cumulative quantity.
 *   - cumulative fill is monotonically non-decreasing, forever.
 *   - a stale (older provider event time) observation is IGNORED, never applied
 *     and never an error — that is out-of-order delivery, not a contradiction.
 *   - a fresh observation that contradicts recorded truth (fill regression,
 *     over-fill, fills on a rejected order) is a hard fail-closed fault.
 *   - cancellation and fills race: a cancel acknowledgement never erases fills
 *     already confirmed, and a cancel of an already-complete order resolves as
 *     FILLED rather than inventing an impossible CANCELLED-with-full-fill state.
 *   - SUBMISSION_AMBIGUOUS is terminal for Phase17. Resolving it is Phase18
 *     reconciliation and is deliberately not implemented here (P17-I20).
 */
import { canonicalNonNegativeLiveDecimal, canonicalPositiveLiveDecimal, liveDecimal } from './decimal';
import { LiveExecutionError } from './errors';
import type { LiveOrderObservation, LiveOrderStateName, LiveOrderStateRecord } from './types';

/** States from which no Phase17 code path produces a further transition. */
export const LIVE_TERMINAL_STATES: readonly LiveOrderStateName[] = Object.freeze([
  'FILLED',
  'CANCELLED',
  'REJECTED',
  'SUBMISSION_AMBIGUOUS',
  'RECONCILIATION_REQUIRED',
]);

/** The complete legal transition relation. Anything absent here is forbidden. */
export const LIVE_ORDER_TRANSITIONS: Readonly<Record<LiveOrderStateName, readonly LiveOrderStateName[]>> = Object.freeze({
  CREATED: Object.freeze<LiveOrderStateName[]>(['DISPATCH_RESERVED']),
  // `CREATED` is reachable back from `DISPATCH_RESERVED` on exactly one
  // condition: the gateway proved the request never left this process
  // (`PRE_DISPATCH_FAILURE`). That is the entire difference between a
  // provably-unsent attempt, which may be re-claimed, and an unestablished one,
  // which becomes SUBMISSION_AMBIGUOUS forever (P17-I14).
  DISPATCH_RESERVED: Object.freeze<LiveOrderStateName[]>(['CREATED', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'SUBMISSION_AMBIGUOUS']),
  ACKNOWLEDGED: Object.freeze<LiveOrderStateName[]>(['PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'CANCELLED', 'REJECTED']),
  PARTIALLY_FILLED: Object.freeze<LiveOrderStateName[]>(['PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'CANCELLED']),
  CANCEL_REQUESTED: Object.freeze<LiveOrderStateName[]>(['PARTIALLY_FILLED', 'FILLED', 'CANCELLED']),
  FILLED: Object.freeze<LiveOrderStateName[]>([]),
  CANCELLED: Object.freeze<LiveOrderStateName[]>(['RECONCILIATION_REQUIRED']),
  REJECTED: Object.freeze<LiveOrderStateName[]>(['RECONCILIATION_REQUIRED']),
  SUBMISSION_AMBIGUOUS: Object.freeze<LiveOrderStateName[]>([]),
  RECONCILIATION_REQUIRED: Object.freeze<LiveOrderStateName[]>([]),
});

export function isLiveTerminalState(state: LiveOrderStateName): boolean {
  return LIVE_TERMINAL_STATES.includes(state);
}

function stateConflict(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', message, { details });
}

function fillInvalid(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new LiveExecutionError('LIVE_FILL_INVALID', message, { details });
}

/**
 * `allowSelfTransition` is granted ONLY to the observation path, where a
 * second acknowledgement carrying a new exchange status lexeme legitimately
 * re-enters the same state. Every explicit transition helper refuses it, so
 * re-reserving a dispatch or re-requesting a cancel is a conflict rather than
 * a silent second claim.
 */
function assertTransitionAllowed(
  from: LiveOrderStateName,
  to: LiveOrderStateName,
  intentId: string,
  allowSelfTransition = false,
): void {
  if (from === to && allowSelfTransition && !isLiveTerminalState(from)) return;
  if (!LIVE_ORDER_TRANSITIONS[from].includes(to) || (from === to && !allowSelfTransition)) {
    stateConflict(`Forbidden live order transition ${from} -> ${to}`, { intentId, from, to });
  }
}

/** Creates the initial, never-dispatched projection for a fresh intent. */
export function initialLiveOrderState(input: {
  readonly intentId: string;
  readonly clientOrderId: string;
  readonly accountId: string;
  readonly pair: string;
  readonly orderedQuantity: string;
}): LiveOrderStateRecord {
  const orderedQuantity = canonicalPositiveLiveDecimal(input.orderedQuantity, 'orderedQuantity');
  return Object.freeze({
    intentId: input.intentId,
    clientOrderId: input.clientOrderId,
    accountId: input.accountId,
    pair: input.pair,
    state: 'CREATED' as const,
    exchangeOrderId: null,
    orderedQuantity,
    cumulativeFilledQuantity: '0',
    remainingQuantity: orderedQuantity,
    averageFillPrice: null,
    lastExchangeStatus: null,
    lastProviderEventTimeMs: null,
    faultCode: null,
    cancelState: 'NONE',
    cancelGeneration: 0,
    cancelExchangeOrderId: null,
    cancelFaultCode: null,
    dispatchWireArmed: false,
    cancelWireArmed: false,
    revision: 0,
  });
}

/** CREATED -> DISPATCH_RESERVED. The local claim taken before any wire call. */
export function reserveDispatch(current: LiveOrderStateRecord): LiveOrderStateRecord {
  assertTransitionAllowed(current.state, 'DISPATCH_RESERVED', current.intentId);
  // A fresh reservation always starts unarmed: arming is a separate, later,
  // independently-fenced transition (`armDispatchWireAttempt`), never implied
  // by taking the reservation itself (§F18-14).
  return Object.freeze({ ...current, state: 'DISPATCH_RESERVED' as const, dispatchWireArmed: false, revision: current.revision + 1 });
}

/**
 * [P18 Wave A2 / F18-14] DISPATCH_RESERVED -> DISPATCH_RESERVED (wire-armed).
 *
 * The durable checkpoint proving a create-order wire request MAY have left
 * this process. Committed by the SAME fenced transaction pattern as every
 * other HEALTHY-authorized mutation, immediately before the HTTP call — so a
 * worker whose generation was superseded before this commits can never send
 * the request (Case A), and a worker whose generation is superseded AFTER it
 * commits leaves durable proof that recovery must treat as unresolved rather
 * than safely reclaimable (Case B).
 */
export function armDispatchWireAttempt(current: LiveOrderStateRecord): LiveOrderStateRecord {
  if (current.state !== 'DISPATCH_RESERVED' || current.dispatchWireArmed) {
    stateConflict('Cannot arm a create-order wire attempt outside an unarmed DISPATCH_RESERVED claim', {
      intentId: current.intentId, state: current.state, dispatchWireArmed: current.dispatchWireArmed,
    });
  }
  return Object.freeze({ ...current, dispatchWireArmed: true, revision: current.revision + 1 });
}

/**
 * [P18 Wave A2 / F18-14] CANCEL_RESERVED -> CANCEL_RESERVED (wire-armed). The
 * cancel-mutation equivalent of `armDispatchWireAttempt`.
 */
export function armCancelWireAttempt(current: LiveOrderStateRecord): LiveOrderStateRecord {
  if (current.cancelState !== 'CANCEL_RESERVED' || current.cancelWireArmed) {
    stateConflict('Cannot arm a cancel wire attempt outside an unarmed CANCEL_RESERVED claim', {
      intentId: current.intentId, cancelState: current.cancelState, cancelWireArmed: current.cancelWireArmed,
    });
  }
  return Object.freeze({ ...current, cancelWireArmed: true, revision: current.revision + 1 });
}

/**
 * [P18 Wave A2 / F18-14] DISPATCH_RESERVED -> CREATED, used ONLY by a
 * crash-recovering reconciliation generation (RUNNING authority), never by
 * the dispatching worker itself.
 *
 * Distinct from `releaseDispatchClaim`: that function trusts a POSITIVE
 * gateway proof ("nothing left this process") and therefore permits release
 * regardless of the arm flag. This function has no such proof — restart is
 * the only signal available — so it requires `dispatchWireArmed` to already
 * be false. An armed claim can NEVER be reclaimed this way; it must be
 * resolved through evidence (`resolveAmbiguousCreate`) or left blocking.
 */
export function reclaimDispatchAfterCrash(current: LiveOrderStateRecord): LiveOrderStateRecord {
  if (current.state !== 'DISPATCH_RESERVED' || current.dispatchWireArmed || current.exchangeOrderId !== null) {
    stateConflict('Cannot reclaim a dispatch reservation that may have reached the wire', {
      intentId: current.intentId, state: current.state, dispatchWireArmed: current.dispatchWireArmed,
    });
  }
  return Object.freeze({ ...current, state: 'CREATED' as const, dispatchWireArmed: false, revision: current.revision + 1 });
}

/**
 * [P18 Wave A2 / F18-14] CANCEL_RESERVED -> NONE (cancel claim only; order
 * state is untouched), used ONLY by a crash-recovering reconciliation
 * generation. Requires `cancelWireArmed` to already be false, for the same
 * reason `reclaimDispatchAfterCrash` does.
 */
export function reclaimCancelAfterCrash(current: LiveOrderStateRecord): LiveOrderStateRecord {
  if (current.cancelState !== 'CANCEL_RESERVED' || current.cancelWireArmed) {
    stateConflict('Cannot reclaim a cancel reservation that may have reached the wire', {
      intentId: current.intentId, cancelState: current.cancelState, cancelWireArmed: current.cancelWireArmed,
    });
  }
  return Object.freeze({ ...current, cancelState: 'NONE' as const, cancelWireArmed: false, revision: current.revision + 1 });
}

/**
 * DISPATCH_RESERVED -> SUBMISSION_AMBIGUOUS. Recorded when a create-order
 * mutation may or may not have reached CoinDCX. Never fabricates an exchange
 * order id and never assumes either outcome (P17-I14).
 */
export function markSubmissionAmbiguous(current: LiveOrderStateRecord, faultCode: string): LiveOrderStateRecord {
  assertTransitionAllowed(current.state, 'SUBMISSION_AMBIGUOUS', current.intentId);
  // [F18-18] Leaving DISPATCH_RESERVED for good: `dispatchWireArmed` is only
  // ever meaningful while parked there, and a stale `true` alongside a
  // non-DISPATCH_RESERVED state is exactly the contradictory durable
  // combination the integrity check refuses to read back.
  return Object.freeze({ ...current, state: 'SUBMISSION_AMBIGUOUS' as const, faultCode, dispatchWireArmed: false, revision: current.revision + 1 });
}

/**
 * DISPATCH_RESERVED -> CREATED. Legal ONLY when the gateway proved the request
 * never reached the network, so no exchange order can exist. Every other
 * unresolved outcome must use `markSubmissionAmbiguous` instead.
 */
export function releaseDispatchClaim(current: LiveOrderStateRecord, faultCode: string): LiveOrderStateRecord {
  assertTransitionAllowed(current.state, 'CREATED', current.intentId);
  if (current.exchangeOrderId !== null) {
    stateConflict('Cannot release a dispatch claim for an order the exchange already acknowledged', {
      intentId: current.intentId,
    });
  }
  return Object.freeze({ ...current, state: 'CREATED' as const, faultCode, dispatchWireArmed: false, revision: current.revision + 1 });
}

/** ACKNOWLEDGED|PARTIALLY_FILLED -> CANCEL_REQUESTED. */
export function requestCancel(current: LiveOrderStateRecord): LiveOrderStateRecord {
  assertTransitionAllowed(current.state, 'CANCEL_REQUESTED', current.intentId);
  return Object.freeze({ ...current, state: 'CANCEL_REQUESTED' as const, revision: current.revision + 1 });
}

/**
 * DISPATCH_RESERVED|ACKNOWLEDGED -> REJECTED for a venue refusal that carries
 * no order snapshot. Goes through the same transition validation as every
 * other state change rather than assembling a record by hand.
 */
export function markRejected(current: LiveOrderStateRecord, faultCode: string): LiveOrderStateRecord {
  assertTransitionAllowed(current.state, 'REJECTED', current.intentId);
  if (!liveDecimal(current.cumulativeFilledQuantity).isZero()) {
    stateConflict('A rejected order cannot carry executed quantity', { intentId: current.intentId });
  }
  // [F18-18] Same reasoning as `markSubmissionAmbiguous`: REJECTED is terminal
  // and never DISPATCH_RESERVED, so any wire-arm proof this order carried is
  // no longer meaningful and must not linger as a contradictory `true`.
  return Object.freeze({ ...current, state: 'REJECTED' as const, faultCode, dispatchWireArmed: false, revision: current.revision + 1 });
}

/** Records a cancel whose outcome could not be established. State is unchanged; the fault is durable. */
export function markCancelAmbiguous(current: LiveOrderStateRecord, faultCode: string): LiveOrderStateRecord {
  return Object.freeze({ ...current, faultCode, revision: current.revision + 1 });
}

export type ObservationApplication =
  | { readonly kind: 'APPLIED'; readonly order: LiveOrderStateRecord }
  /** An exact replay of an already-applied observation. Idempotent, not an error. */
  | { readonly kind: 'DUPLICATE'; readonly order: LiveOrderStateRecord }
  /** Delivered late; strictly older than what is already recorded. Ignored without regression. */
  | { readonly kind: 'STALE'; readonly order: LiveOrderStateRecord };

/** Maps an observation plus exact fill arithmetic onto the resulting state name. */
function resolveObservedState(
  current: LiveOrderStateRecord,
  observation: LiveOrderObservation,
  cumulative: ReturnType<typeof liveDecimal>,
  ordered: ReturnType<typeof liveDecimal>,
): LiveOrderStateName {
  const fullyFilled = cumulative.equals(ordered);
  switch (observation.kind) {
    case 'ACKNOWLEDGED':
      // An acknowledgement is never a fill. If the venue simultaneously reports
      // executed quantity, the fill facts win and the state reflects them.
      if (fullyFilled) return 'FILLED';
      return cumulative.greaterThan(0) ? 'PARTIALLY_FILLED' : 'ACKNOWLEDGED';
    case 'PARTIAL_FILL':
      if (fullyFilled) return 'FILLED';
      if (cumulative.lessThanOrEqualTo(0)) {
        fillInvalid('A partial-fill observation reported no executed quantity', { intentId: current.intentId });
      }
      return 'PARTIALLY_FILLED';
    case 'FILL':
      if (!fullyFilled) {
        fillInvalid('A fill observation did not account for the full ordered quantity', { intentId: current.intentId });
      }
      return 'FILLED';
    case 'CANCELLED':
      // P17-I13: a cancel acknowledgement is not proof that zero filled. A
      // cancel that races a complete fill resolves as FILLED.
      return fullyFilled ? 'FILLED' : 'CANCELLED';
    case 'REJECTED':
      if (cumulative.greaterThan(0)) {
        stateConflict('A rejected order cannot carry executed quantity', { intentId: current.intentId });
      }
      return 'REJECTED';
    default:
      return stateConflict('Unknown live order observation kind', { intentId: current.intentId });
  }
}

/**
 * Applies one validated exchange observation to the current durable state.
 *
 * Identity is checked first: an observation for a different client order id,
 * exchange order id, or pair is `LIVE_ORDER_IDENTITY_MISMATCH` and never
 * touches this order (P17-I16).
 */
export function applyLiveOrderObservation(
  current: LiveOrderStateRecord,
  observation: LiveOrderObservation,
): ObservationApplication {
  if (observation.clientOrderId !== current.clientOrderId || observation.pair !== current.pair) {
    throw new LiveExecutionError('LIVE_ORDER_IDENTITY_MISMATCH', 'Observation does not belong to this live order', {
      details: { intentId: current.intentId },
    });
  }
  if (current.exchangeOrderId !== null && observation.exchangeOrderId !== current.exchangeOrderId) {
    throw new LiveExecutionError('LIVE_ORDER_IDENTITY_MISMATCH', 'Observation carries a different exchange order id than already recorded', {
      details: { intentId: current.intentId },
    });
  }
  // A venue-echoed client order id, when present, must be byte-identical to
  // the local one. `null` (no echo) is not a contradiction.
  if (observation.exchangeClientOrderId !== null && observation.exchangeClientOrderId !== current.clientOrderId) {
    throw new LiveExecutionError('LIVE_ORDER_IDENTITY_MISMATCH', 'Observation carries a different venue client order id than this order', {
      details: { intentId: current.intentId },
    });
  }

  const ordered = liveDecimal(current.orderedQuantity);
  const recorded = liveDecimal(current.cumulativeFilledQuantity);
  const cumulative = liveDecimal(canonicalNonNegativeLiveDecimal(observation.cumulativeFilledQuantity, 'cumulativeFilledQuantity'));
  const observedOrdered = liveDecimal(canonicalPositiveLiveDecimal(observation.orderedQuantity, 'orderedQuantity'));

  if (!observedOrdered.equals(ordered)) {
    throw new LiveExecutionError('LIVE_ORDER_IDENTITY_MISMATCH', 'Observation reports a different ordered quantity than this order', {
      details: { intentId: current.intentId },
    });
  }
  if (cumulative.greaterThan(ordered)) {
    fillInvalid('Cumulative filled quantity exceeds the ordered quantity', { intentId: current.intentId });
  }

  let observedAverage: string | null = null;
  if (cumulative.greaterThan(0)) {
    if (observation.averageFillPrice === null) {
      fillInvalid('A positive cumulative fill requires the provider cumulative average price', { intentId: current.intentId });
    }
    observedAverage = canonicalPositiveLiveDecimal(observation.averageFillPrice, 'averageFillPrice');
  } else if (observation.averageFillPrice !== null) {
    fillInvalid('An average fill price cannot exist while cumulative fill is zero', { intentId: current.intentId });
  }

  const staleByTime = current.lastProviderEventTimeMs !== null
    && observation.providerEventTimeMs < current.lastProviderEventTimeMs;

  if (cumulative.lessThan(recorded)) {
    // Out-of-order delivery is ignored; a fresh contradiction is a hard fault.
    if (staleByTime) return { kind: 'STALE', order: current };
    fillInvalid('Cumulative filled quantity regressed against durable state', { intentId: current.intentId });
  }

  let nextState = resolveObservedState(current, observation, cumulative, ordered);

  const averageChanged = observedAverage !== current.averageFillPrice;
  if (staleByTime && nextState === current.state && cumulative.equals(recorded)) {
    return { kind: 'STALE', order: current };
  }

  if (isLiveTerminalState(current.state)) {
    if (current.state === 'SUBMISSION_AMBIGUOUS') {
      stateConflict('An ambiguous create cannot be resolved by Phase17 observation folding', { intentId: current.intentId });
    }
    if (current.state === 'FILLED') {
      if (!cumulative.equals(recorded) || nextState !== 'FILLED') {
        stateConflict(`Live order is terminal in ${current.state} and cannot be transitioned to ${nextState}`, {
          intentId: current.intentId, from: current.state, to: nextState,
        });
      }
      nextState = 'FILLED';
    } else if (current.state === 'RECONCILIATION_REQUIRED') {
      nextState = 'RECONCILIATION_REQUIRED';
    } else if (cumulative.greaterThan(recorded) || nextState !== current.state) {
      // Financially authoritative late evidence is preserved, but Phase17 does
      // not pretend it can reconcile the terminal contradiction.
      nextState = 'RECONCILIATION_REQUIRED';
    }
    const identicalReplay = nextState === current.state
      && cumulative.equals(recorded)
      && !averageChanged
      && observation.exchangeStatus === current.lastExchangeStatus;
    if (identicalReplay) return { kind: 'DUPLICATE', order: current };
  } else {
    assertTransitionAllowed(current.state, nextState, current.intentId, true);
  }

  const unchanged = nextState === current.state
    && cumulative.equals(recorded)
    && !averageChanged
    && observation.exchangeOrderId === current.exchangeOrderId
    && observation.exchangeStatus === current.lastExchangeStatus;
  if (unchanged) return { kind: 'DUPLICATE', order: current };

  return {
    kind: 'APPLIED',
    order: Object.freeze({
      ...current,
      state: nextState,
      exchangeOrderId: observation.exchangeOrderId,
      cumulativeFilledQuantity: cumulative.toFixed(),
      remainingQuantity: ordered.minus(cumulative).toFixed(),
      averageFillPrice: observedAverage,
      lastExchangeStatus: observation.exchangeStatus,
      lastProviderEventTimeMs: current.lastProviderEventTimeMs === null
        ? observation.providerEventTimeMs
        : Math.max(current.lastProviderEventTimeMs, observation.providerEventTimeMs),
      faultCode: nextState === 'RECONCILIATION_REQUIRED' ? 'LIVE_ORDER_STATE_CONFLICT' : current.faultCode,
      // [F18-18] `nextState` is never `DISPATCH_RESERVED` — observation
      // folding only ever advances FROM it, never back into it — so any
      // wire-arm proof is no longer meaningful once folded and must not
      // survive as a contradictory `true` against a non-reserved state.
      dispatchWireArmed: false,
      revision: current.revision + 1,
    }),
  };
}
