/**
 * Phase 18B practical-recovery invalidation classification (Stage 1A).
 *
 * Pure: maps each typed reason to exactly one severity. It has no side effects,
 * revokes nothing by itself, and never grants anything. Callers apply the
 * result through `state-machine.ts` and `certificate.ts`.
 *
 *   - QUARANTINE: authority is revoked and the account must re-certify from
 *     scratch. Transport, read, staleness, binding, and ordinary ambiguity
 *     reasons. (Repeated failures escalate separately, through
 *     RECOVERY_ESCALATION_THRESHOLD.)
 *   - MANUAL_REVIEW: evidence of external activity, a broken identity, or a
 *     contradiction no automatic step may resolve. Only an explicit operator
 *     resolution leaves it.
 *
 * Anything that is not a known reason classifies as MANUAL_REVIEW (fail
 * closed), so a new or malformed reason can never be treated as benign.
 */
import {
  PRACTICAL_INVALIDATION_REASONS,
  isPracticalInvalidationReason,
  type PracticalAccountStateName,
  type PracticalInvalidationReason,
  type PracticalInvalidationSeverity,
} from './types';

/**
 * The exhaustive severity table. `Record<PracticalInvalidationReason, …>` makes
 * the compiler reject a reason without a severity.
 */
export const PRACTICAL_INVALIDATION_SEVERITY: Readonly<Record<PracticalInvalidationReason, PracticalInvalidationSeverity>> = Object.freeze({
  // Private stream: any of these means history may be unknown, or the stream saw state change.
  WS_DISCONNECTED: 'QUARANTINE',
  WS_RECONNECTED: 'QUARANTINE',
  WS_JOIN_FAILED: 'QUARANTINE',
  WS_PING_TIMEOUT: 'QUARANTINE',
  PRIVATE_STATE_EVENT: 'QUARANTINE',
  UNKNOWN_PRIVATE_EVENT: 'QUARANTINE',
  // Provider reads: retryable, never evidence of absence.
  PROVIDER_READ_ERROR: 'QUARANTINE',
  PROVIDER_SCHEMA_ERROR: 'QUARANTINE',
  INCOMPLETE_PAGINATION: 'QUARANTINE',
  // Identity: missing is retryable; a DIFFERENT account is never automatic.
  ACCOUNT_IDENTITY_MISSING: 'QUARANTINE',
  ACCOUNT_IDENTITY_MISMATCH: 'MANUAL_REVIEW',
  // Bindings: a new generation/epoch/stream/config simply voids the evidence.
  GENERATION_CHANGED: 'QUARANTINE',
  RUNTIME_EPOCH_CHANGED: 'QUARANTINE',
  STREAM_INCARNATION_CHANGED: 'QUARANTINE',
  CONFIG_CHANGED: 'QUARANTINE',
  // Mutation-time checks: a pre-flight mismatch aborts before any wire call; a
  // post-mutation mismatch means the venue did something we did not expect.
  PREFLIGHT_MISMATCH: 'QUARANTINE',
  POST_MUTATION_MISMATCH: 'MANUAL_REVIEW',
  // Order ambiguity: resolvable only by an exact client_order_id read-side
  // proof; escalates via RECOVERY_ESCALATION_THRESHOLD if it stays unresolved.
  AMBIGUOUS_CREATE: 'QUARANTINE',
  AMBIGUOUS_CANCEL: 'QUARANTINE',
  DUPLICATE_CLIENT_ORDER_ID: 'QUARANTINE',
  CLIENT_ORDER_ID_MULTIPLE_MATCHES: 'MANUAL_REVIEW',
  // Venue findings: external activity or contradictions.
  ORPHAN_ORDER: 'MANUAL_REVIEW',
  UNEXPLAINED_POSITION: 'MANUAL_REVIEW',
  VENUE_INITIATED_CHANGE: 'MANUAL_REVIEW',
  ECONOMICS_MISMATCH: 'MANUAL_REVIEW',
  ORDER_IDENTITY_CONFLICT: 'MANUAL_REVIEW',
  UNKNOWN_VENUE_STATUS: 'MANUAL_REVIEW',
  // Evidence quality.
  EVIDENCE_STALE: 'QUARANTINE',
  CLOCK_ANOMALY: 'QUARANTINE',
  // Certificate lifecycle.
  CERTIFICATE_EXPIRED: 'QUARANTINE',
  CERTIFICATE_CONSUMED: 'QUARANTINE',
  // Escalation.
  RECOVERY_ESCALATION_THRESHOLD: 'MANUAL_REVIEW',
});

// Module-load invariant: the table covers exactly the declared reasons.
if (Object.keys(PRACTICAL_INVALIDATION_SEVERITY).length !== PRACTICAL_INVALIDATION_REASONS.length) {
  throw new Error('Phase 18B invalidation severity table does not cover every declared reason');
}

/** Severity of one reason. Unknown or malformed input is MANUAL_REVIEW, never benign. */
export function classifyPracticalInvalidation(reason: unknown): PracticalInvalidationSeverity {
  return isPracticalInvalidationReason(reason) ? PRACTICAL_INVALIDATION_SEVERITY[reason] : 'MANUAL_REVIEW';
}

/** The account state an invalidation of this severity leads to. */
export function practicalStateForSeverity(severity: PracticalInvalidationSeverity): Extract<PracticalAccountStateName, 'QUARANTINED' | 'MANUAL_REVIEW_REQUIRED'> {
  return severity === 'QUARANTINE' ? 'QUARANTINED' : 'MANUAL_REVIEW_REQUIRED';
}

/** The strictest severity across several simultaneous reasons (MANUAL_REVIEW dominates). */
export function strictestPracticalSeverity(reasons: readonly unknown[]): PracticalInvalidationSeverity {
  if (reasons.length === 0) return 'MANUAL_REVIEW';
  return reasons.some((reason) => classifyPracticalInvalidation(reason) === 'MANUAL_REVIEW') ? 'MANUAL_REVIEW' : 'QUARANTINE';
}
