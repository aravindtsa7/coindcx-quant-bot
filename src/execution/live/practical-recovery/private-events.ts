/**
 * Phase 18B Checkpoint B: private-stream event and health classification
 * (pure).
 *
 * The private stream can only REVOKE practical authority. Nothing here grants,
 * preserves, or renews anything: every function returns either "no trip" or
 * a typed Stage 1A invalidation reason. There is no "healthy" output a caller
 * could treat as evidence, and a reconnect is never a recovery: it trips, it
 * leaves the stream unbindable (below), and only a new watch on a READY stream
 * plus a new full certification could ever certify again.
 *
 * FAIL CLOSED. An event whose safety relevance is not KNOWN to be nil trips:
 *   - lifecycle events (connect, disconnect, reconnect/reconciliation-required)
 *     trip as stream-lifecycle reasons;
 *   - order, position, and balance notifications are account STATE CHANGES and
 *     trip as PRIVATE_STATE_EVENT (a balance change can accompany a fill,
 *     funding, or a transfer; it is not assumed benign);
 *   - an event from any other incarnation, from another stream, of an unknown
 *     type, or with a malformed envelope trips as UNKNOWN_PRIVATE_EVENT or
 *     STREAM_INCARNATION_CHANGED.
 * The reviewed NOISE list is deliberately EMPTY: the CoinDCX private account
 * stream currently delivers no event that is known to be safety-irrelevant.
 * Adding one is a reviewed edit of `PRACTICAL_PRIVATE_NOISE_EVENT_TYPES`.
 *
 * The private stream DROPS a malformed notification (it only counts it), so
 * the tripwire must also watch the health snapshot: a change in the
 * invalid-event count is an unknown private event and trips too.
 *
 * POSITIVE READINESS (`practicalPrivateStreamReadiness`). Certification
 * treats the ABSENCE of private events as safety evidence, so a QUIET ACTIVE
 * subscription must never be confused with a BLIND, UNPROVEN one. Readiness
 * is one of:
 *   - PROVEN_READY: connected, no unresolved reconnect, the authenticated join
 *     sent, state AUTH_JOIN_SENT, AND a PROVIDER-originated subscription
 *     confirmation for exactly this incarnation;
 *   - UNPROVEN: anything short of that, in particular AUTH_JOIN_SENT with no
 *     provider confirmation ("join sent" proves only that the client tried);
 *   - RECONCILIATION_REQUIRED: the stream reconnected and its continuity is
 *     unresolved (sticky in the existing adapter);
 *   - DISCONNECTED.
 * A watch binds ONLY to PROVEN_READY, and to that incarnation and that
 * confirmation. Any later loss (disconnect, reconnect, new incarnation,
 * RECONCILIATION_REQUIRED, lost join, confirmation gone or replaced,
 * malformed or unknown state) trips. Readiness of incarnation N never
 * authorizes incarnation N+1: a new incarnation starts UNPROVEN.
 *
 * THE EXISTING COINDCX ADAPTER IS ALWAYS UNPROVEN. CoinDCX sends no join or
 * subscription acknowledgement, and the adapter
 * (`src/integration/coindcx/websocket/private-stream.ts`) only emits `join`
 * and listens for data events; it has no confirmation to report and never
 * sets `subscriptionConfirmation`. So with the real adapter no watch can
 * bind and PRODUCTION CERTIFICATION IS UNAVAILABLE (fail closed), until a
 * future, reviewed adapter step observes a GENUINE provider confirmation.
 * Nothing here invents a join acknowledgement, a subscription
 * acknowledgement, an event-delivery guarantee, or a provider health
 * guarantee; and no amount of silence or of agreeing REST reads turns
 * UNPROVEN into PROVEN_READY.
 *
 * No private payload content is read except the disconnect reason category,
 * and none is ever logged or persisted.
 */
import type { PracticalInvalidationReason } from '../practical/types';
import type { PracticalPrivateStreamHealth } from './ports';

/** The stream id the CoinDCX private account stream stamps on its envelopes. */
export const PRACTICAL_PRIVATE_STREAM_ID = 'PRIVATE_ACCOUNT';

/** Reviewed, safety-irrelevant private event types. Deliberately empty (see module doc). */
export const PRACTICAL_PRIVATE_NOISE_EVENT_TYPES: readonly string[] = Object.freeze([]);

/** Private account state changes: every one trips. */
export const PRACTICAL_PRIVATE_STATE_EVENT_TYPES: readonly string[] = Object.freeze([
  'PRIVATE_ORDER_UPDATE_NOTIFICATION',
  'PRIVATE_POSITION_UPDATE_NOTIFICATION',
  'PRIVATE_BALANCE_CHANGE_NOTIFICATION',
]);

/** Stream lifecycle events: every one trips (a lifecycle change breaks the watched incarnation). */
export const PRACTICAL_PRIVATE_LIFECYCLE_EVENT_TYPES: readonly string[] = Object.freeze([
  'PRIVATE_STREAM_CONNECTED',
  'PRIVATE_STREAM_DISCONNECTED',
  'PRIVATE_RECONCILIATION_REQUIRED',
]);

/**
 * The only stream state in which readiness CAN be PROVEN_READY (and then only
 * with a provider confirmation): the authenticated join sent on a clean
 * connection. Being in this state is necessary, never sufficient.
 * RECONCILIATION_REQUIRED, CONNECTED (join not yet sent), DEGRADED,
 * RECONNECT_WAIT, CONNECTING, and STOPPED are never ready.
 */
export const PRACTICAL_PRIVATE_BINDABLE_STATES: readonly string[] = Object.freeze(['AUTH_JOIN_SENT']);

/** The stream state the CoinDCX adapter enters (and keeps) after a reconnect. */
export const PRACTICAL_PRIVATE_RECONCILIATION_REQUIRED_STATE = 'RECONCILIATION_REQUIRED';

export type PracticalPrivateEventClassification =
  | { readonly kind: 'NOISE' }
  | { readonly kind: 'TRIP'; readonly category: 'LIFECYCLE' | 'STATE_CHANGE' | 'UNKNOWN'; readonly reason: PracticalInvalidationReason };

function trip(category: 'LIFECYCLE' | 'STATE_CHANGE' | 'UNKNOWN', reason: PracticalInvalidationReason): PracticalPrivateEventClassification {
  return Object.freeze({ kind: 'TRIP' as const, category, reason });
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function disconnectReason(payload: unknown): PracticalInvalidationReason {
  if (typeof payload === 'object' && payload !== null && (payload as Record<string, unknown>)['reason'] === 'PING_TIMEOUT') {
    return 'WS_PING_TIMEOUT';
  }
  return 'WS_DISCONNECTED';
}

/**
 * Classifies one private-stream envelope observed while a watch is bound to
 * `boundIncarnation`. Only an event whose type is on the reviewed NOISE list
 * (currently none), from the bound incarnation of the private stream, is not
 * a trip.
 */
export function classifyPracticalPrivateEvent(envelope: unknown, boundIncarnation: number): PracticalPrivateEventClassification {
  if (typeof envelope !== 'object' || envelope === null) return trip('UNKNOWN', 'UNKNOWN_PRIVATE_EVENT');
  const record = envelope as Record<string, unknown>;
  const eventType = record['eventType'];
  const generationId = record['generationId'];
  if (typeof eventType !== 'string' || !isNonNegativeSafeInteger(generationId) || record['stream'] !== PRACTICAL_PRIVATE_STREAM_ID) {
    return trip('UNKNOWN', 'UNKNOWN_PRIVATE_EVENT');
  }
  if (generationId !== boundIncarnation) {
    // Any event from another (older or newer) incarnation: the watched incarnation is no longer the only one.
    return trip('LIFECYCLE', 'STREAM_INCARNATION_CHANGED');
  }
  if (eventType === 'PRIVATE_STREAM_DISCONNECTED') return trip('LIFECYCLE', disconnectReason(record['payload']));
  if (eventType === 'PRIVATE_RECONCILIATION_REQUIRED') return trip('LIFECYCLE', 'WS_RECONNECTED');
  if (eventType === 'PRIVATE_STREAM_CONNECTED') return trip('LIFECYCLE', 'STREAM_INCARNATION_CHANGED');
  if (PRACTICAL_PRIVATE_STATE_EVENT_TYPES.includes(eventType)) return trip('STATE_CHANGE', 'PRIVATE_STATE_EVENT');
  if (PRACTICAL_PRIVATE_NOISE_EVENT_TYPES.includes(eventType)) return Object.freeze({ kind: 'NOISE' as const });
  return trip('UNKNOWN', 'UNKNOWN_PRIVATE_EVENT');
}

/** The incarnation a watch binds to, with the health values it must keep. */
export interface PracticalStreamBinding {
  readonly incarnation: number;
  readonly state: string;
  readonly invalidEventCount: number;
  /** The provider confirmation the binding relied on (its subscription attempt). */
  readonly confirmedAtMs: number;
}

function isWellFormedHealth(value: unknown): value is PracticalPrivateStreamHealth {
  if (typeof value !== 'object' || value === null) return false;
  const health = value as Record<string, unknown>;
  return typeof health['state'] === 'string'
    && isNonNegativeSafeInteger(health['generationId'])
    && typeof health['connected'] === 'boolean'
    && typeof health['authJoinSent'] === 'boolean'
    && isNonNegativeSafeInteger(health['invalidEventCount'])
    && typeof health['reconciliationRequired'] === 'boolean';
}

// ---------------------------------------------------------------------------
// Positive readiness
// ---------------------------------------------------------------------------

/** Why a connected stream is still UNPROVEN. */
export type PracticalStreamUnprovenReason =
  | 'HEALTH_MALFORMED'
  | 'NO_INCARNATION'
  /** The authenticated join was not (yet) sent. */
  | 'JOIN_NOT_SENT'
  /** Not in the one state a confirmed subscription can be in (AUTH_JOIN_SENT). */
  | 'STATE_NOT_READY'
  /** Join SENT, but no provider-originated confirmation that the subscription is active (the existing CoinDCX adapter, always). */
  | 'NO_PROVIDER_CONFIRMATION'
  | 'CONFIRMATION_MALFORMED'
  /** A confirmation of ANOTHER incarnation: readiness never carries over. */
  | 'CONFIRMATION_FOR_OTHER_INCARNATION';

/**
 * Positive private-stream readiness. Only PROVEN_READY can support a
 * certification, and only for the exact incarnation it names.
 */
export type PracticalPrivateStreamReadiness =
  | { readonly kind: 'PROVEN_READY'; readonly incarnation: number; readonly confirmedAtMs: number }
  | { readonly kind: 'UNPROVEN'; readonly reason: PracticalStreamUnprovenReason }
  | { readonly kind: 'RECONCILIATION_REQUIRED' }
  | { readonly kind: 'DISCONNECTED' };

const DISCONNECTED: PracticalPrivateStreamReadiness = Object.freeze({ kind: 'DISCONNECTED' as const });
const RECONCILIATION_REQUIRED: PracticalPrivateStreamReadiness = Object.freeze({ kind: 'RECONCILIATION_REQUIRED' as const });

function unproven(reason: PracticalStreamUnprovenReason): PracticalPrivateStreamReadiness {
  return Object.freeze({ kind: 'UNPROVEN' as const, reason });
}

/**
 * The stream's positive readiness, fail closed. PROVEN_READY requires ALL of:
 * a well-formed snapshot of a live incarnation; connected; no unresolved
 * reconnect; the authenticated join sent; state AUTH_JOIN_SENT; AND a
 * well-formed PROVIDER-originated subscription confirmation for exactly this
 * incarnation. AUTH_JOIN_SENT alone is UNPROVEN (NO_PROVIDER_CONFIRMATION).
 */
export function practicalPrivateStreamReadiness(health: unknown): PracticalPrivateStreamReadiness {
  if (!isWellFormedHealth(health)) return unproven('HEALTH_MALFORMED');
  if (!isPositiveSafeInteger(health.generationId)) return unproven('NO_INCARNATION');
  if (!health.connected) return DISCONNECTED;
  if (health.reconciliationRequired || health.state === PRACTICAL_PRIVATE_RECONCILIATION_REQUIRED_STATE) return RECONCILIATION_REQUIRED;
  if (!health.authJoinSent) return unproven('JOIN_NOT_SENT');
  if (!PRACTICAL_PRIVATE_BINDABLE_STATES.includes(health.state)) return unproven('STATE_NOT_READY');
  const confirmation: unknown = health.subscriptionConfirmation;
  if (confirmation === undefined || confirmation === null) return unproven('NO_PROVIDER_CONFIRMATION');
  if (typeof confirmation !== 'object') return unproven('CONFIRMATION_MALFORMED');
  const record = confirmation as Record<string, unknown>;
  if (record['source'] !== 'PROVIDER' || !isPositiveSafeInteger(record['incarnation']) || !isNonNegativeSafeInteger(record['confirmedAtMs'])) {
    return unproven('CONFIRMATION_MALFORMED');
  }
  if (record['incarnation'] !== health.generationId) return unproven('CONFIRMATION_FOR_OTHER_INCARNATION');
  return Object.freeze({ kind: 'PROVEN_READY' as const, incarnation: health.generationId, confirmedAtMs: record['confirmedAtMs'] as number });
}

/** Why a watch could not bind: the stream's readiness, never PROVEN_READY. */
export type PracticalStreamNotReadyReason = 'DISCONNECTED' | 'RECONCILIATION_REQUIRED' | PracticalStreamUnprovenReason;

export type PracticalStreamBindingResult =
  | { readonly kind: 'BOUND'; readonly binding: PracticalStreamBinding }
  | { readonly kind: 'NOT_READY'; readonly readiness: Exclude<PracticalPrivateStreamReadiness['kind'], 'PROVEN_READY'>; readonly reason: PracticalStreamNotReadyReason };

/** A watch binds ONLY to a PROVEN_READY incarnation, and to that confirmation. Binding is never evidence of health. */
export function bindPracticalPrivateStream(health: unknown): PracticalStreamBindingResult {
  const readiness = practicalPrivateStreamReadiness(health);
  if (readiness.kind !== 'PROVEN_READY') {
    return Object.freeze({ kind: 'NOT_READY' as const, readiness: readiness.kind, reason: readiness.kind === 'UNPROVEN' ? readiness.reason : readiness.kind });
  }
  const snapshot = health as PracticalPrivateStreamHealth;
  return Object.freeze({
    kind: 'BOUND' as const,
    binding: Object.freeze({
      incarnation: readiness.incarnation,
      state: snapshot.state,
      invalidEventCount: snapshot.invalidEventCount,
      confirmedAtMs: readiness.confirmedAtMs,
    }),
  });
}

/**
 * Compares a health snapshot with the binding. Returns the trip reason, or
 * null when nothing observable changed. Any loss of PROVEN_READY for the
 * bound incarnation and confirmation trips. Null is NOT a statement that the
 * stream is healthy or gap-free; it only means this check found no trip.
 */
export function practicalStreamHealthTrip(health: unknown, binding: PracticalStreamBinding): PracticalInvalidationReason | null {
  if (!isWellFormedHealth(health)) return 'UNKNOWN_PRIVATE_EVENT';
  if (health.generationId !== binding.incarnation) return 'STREAM_INCARNATION_CHANGED';
  const readiness = practicalPrivateStreamReadiness(health);
  if (readiness.kind === 'DISCONNECTED') return 'WS_DISCONNECTED';
  if (readiness.kind === 'RECONCILIATION_REQUIRED') return 'WS_RECONNECTED';
  // Left the ready state: a lifecycle change (DEGRADED: the stream's own malformed-event escalation).
  if (readiness.kind === 'UNPROVEN' && readiness.reason === 'STATE_NOT_READY') return health.state === 'DEGRADED' ? 'UNKNOWN_PRIVATE_EVENT' : 'WS_DISCONNECTED';
  // Readiness otherwise lost (join lost, confirmation gone, malformed, or replaced): the subscription is no longer proven.
  if (readiness.kind === 'UNPROVEN' || readiness.confirmedAtMs !== binding.confirmedAtMs) return 'WS_JOIN_FAILED';
  if (health.invalidEventCount !== binding.invalidEventCount) return 'UNKNOWN_PRIVATE_EVENT';
  if (health.state !== binding.state) return health.state === 'DEGRADED' ? 'UNKNOWN_PRIVATE_EVENT' : 'WS_DISCONNECTED';
  return null;
}
