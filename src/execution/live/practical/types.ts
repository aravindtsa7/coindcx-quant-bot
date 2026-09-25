/**
 * Phase 18B practical live safety — domain vocabulary (Stage 1A).
 *
 * Phase 18B is a SEPARATE, WEAKER, OPT-IN authorization tier ("practical
 * recovery") for a venue that offers no account sequence, no replay, and no
 * common snapshot. Nothing here is, represents, or can be converted into the
 * Phase 18 strict continuity capability: no type in this tree names it, and
 * every practical authority value carries `provesAccountContinuity: false`.
 *
 * Stage 1A is pure domain only: no persistence, no provider reads, no stream,
 * no gateway, no runtime wiring, and no clock (every time is passed in).
 */
import { assertCredentialFree } from '../errors';

// ---------------------------------------------------------------------------
// Account states
// ---------------------------------------------------------------------------

/**
 * The practical account states. There is deliberately NO strict-continuity
 * state here: Phase 18B can never produce one.
 */
export const PRACTICAL_ACCOUNT_STATES = Object.freeze([
  'QUARANTINED',
  'CERTIFYING',
  'PROVIDER_UNAVAILABLE',
  'CERTIFIED_IDLE',
  'MUTATING',
  'MANUAL_REVIEW_REQUIRED',
] as const);
export type PracticalAccountStateName = (typeof PRACTICAL_ACCOUNT_STATES)[number];

/** Exactly the six Stage-1A states: no case folding, trimming, or coercion. */
export function isPracticalAccountStateName(value: unknown): value is PracticalAccountStateName {
  return typeof value === 'string' && (PRACTICAL_ACCOUNT_STATES as readonly string[]).includes(value);
}

/** The only basis a practical authorization can ever carry. */
export type PracticalAuthorizationBasis = 'PRACTICAL_RECOVERY';
export const PRACTICAL_AUTHORIZATION_BASIS: PracticalAuthorizationBasis = 'PRACTICAL_RECOVERY';

/** Every Tier-B mutation kind. Which ones are PERMITTED is decided only by `policy.ts`. */
export const PRACTICAL_MUTATION_ACTIONS = Object.freeze(['OPEN', 'CANCEL', 'CLOSE'] as const);
export type PracticalMutationAction = (typeof PRACTICAL_MUTATION_ACTIONS)[number];

export function isPracticalMutationAction(value: unknown): value is PracticalMutationAction {
  return typeof value === 'string' && (PRACTICAL_MUTATION_ACTIONS as readonly string[]).includes(value);
}

/**
 * The recorded outcome of one Tier-B mutation. EVERY outcome returns the
 * account to QUARANTINED and none restores the consumed certificate.
 */
export const PRACTICAL_MUTATION_OUTCOMES = Object.freeze([
  'ACCEPTED',
  'REJECTED',
  'AMBIGUOUS',
  'DUPLICATE_CLIENT_ORDER_ID',
  'PRE_DISPATCH_FAILURE',
] as const);
export type PracticalMutationOutcome = (typeof PRACTICAL_MUTATION_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// Invalidation reasons
// ---------------------------------------------------------------------------

/**
 * Every reason practical authority can be revoked or an episode escalated.
 * Each has exactly one severity in `invalidation.ts`; the compiler enforces
 * that the table there is exhaustive.
 */
export const PRACTICAL_INVALIDATION_REASONS = Object.freeze([
  // Private stream (revoke-only; never grants or preserves authority)
  'WS_DISCONNECTED',
  'WS_RECONNECTED',
  'WS_JOIN_FAILED',
  'WS_PING_TIMEOUT',
  'PRIVATE_STATE_EVENT',
  'UNKNOWN_PRIVATE_EVENT',
  // Provider reads
  'PROVIDER_READ_ERROR',
  'PROVIDER_SCHEMA_ERROR',
  'INCOMPLETE_PAGINATION',
  // Account identity
  'ACCOUNT_IDENTITY_MISSING',
  'ACCOUNT_IDENTITY_MISMATCH',
  // Bindings
  'GENERATION_CHANGED',
  'RUNTIME_EPOCH_CHANGED',
  'STREAM_INCARNATION_CHANGED',
  'CONFIG_CHANGED',
  // Mutation-time checks
  'PREFLIGHT_MISMATCH',
  'POST_MUTATION_MISMATCH',
  // Order ambiguity
  'AMBIGUOUS_CREATE',
  'AMBIGUOUS_CANCEL',
  'DUPLICATE_CLIENT_ORDER_ID',
  'CLIENT_ORDER_ID_MULTIPLE_MATCHES',
  // Venue findings
  'ORPHAN_ORDER',
  'UNEXPLAINED_POSITION',
  'VENUE_INITIATED_CHANGE',
  'ECONOMICS_MISMATCH',
  'ORDER_IDENTITY_CONFLICT',
  'UNKNOWN_VENUE_STATUS',
  // Evidence quality
  'EVIDENCE_STALE',
  'CLOCK_ANOMALY',
  // Certificate lifecycle
  'CERTIFICATE_EXPIRED',
  'CERTIFICATE_CONSUMED',
  // Escalation
  'RECOVERY_ESCALATION_THRESHOLD',
] as const);
export type PracticalInvalidationReason = (typeof PRACTICAL_INVALIDATION_REASONS)[number];

export function isPracticalInvalidationReason(value: unknown): value is PracticalInvalidationReason {
  return typeof value === 'string' && (PRACTICAL_INVALIDATION_REASONS as readonly string[]).includes(value);
}

/** What an invalidation does to the account. */
export type PracticalInvalidationSeverity = 'QUARANTINE' | 'MANUAL_REVIEW';

/** Why an account entered QUARANTINED, for audit. Invalidations plus the non-fault entries. */
export type PracticalQuarantineCause =
  | PracticalInvalidationReason
  | 'RUNTIME_STARTUP'
  | 'MUTATION_OUTCOME_RECORDED'
  | 'OPERATOR_RESOLVED';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PracticalLiveSafetyErrorCode =
  /** Configuration or a policy value would loosen an implementation-owned ceiling, or is malformed. */
  | 'PRACTICAL_POLICY_INVALID'
  /** A value was presented as practical authority but is not a genuine one (forged, cloned, structural). */
  | 'PRACTICAL_AUTHORITY_INVALID'
  /** A state-machine transition not in the allowed table. */
  | 'PRACTICAL_ILLEGAL_TRANSITION'
  /** Certificate issuance input failed validation. */
  | 'PRACTICAL_CERTIFICATE_INVALID'
  /** A certificate was presented for a different account, fingerprint, epoch, generation, or stream incarnation. */
  | 'PRACTICAL_CERTIFICATE_BINDING_MISMATCH'
  | 'PRACTICAL_CERTIFICATE_EXPIRED'
  /** A certificate presented at a time earlier than its issuance (backward or pre-issuance clock). */
  | 'PRACTICAL_CERTIFICATE_BEFORE_ISSUANCE'
  /** A certificate that is already CONSUMED, EXPIRED, or REVOKED. */
  | 'PRACTICAL_CERTIFICATE_NOT_ISSUED'
  /** A fence record that is malformed, has an unknown mode, or whose revision cannot advance safely. Never normalized. */
  | 'PRACTICAL_FENCE_INVALID'
  /** A fence operation that conflicts with the current mode (e.g. lease while certifying). */
  | 'PRACTICAL_FENCE_CONFLICT'
  /** A fence operation against a different account, epoch, generation, run, lease, or revision. */
  | 'PRACTICAL_FENCE_BINDING_MISMATCH'
  /** The requested mutation action is not permitted by the policy. */
  | 'PRACTICAL_ACTION_NOT_PERMITTED';

/** Credential-free, typed Phase 18B error. Details go through the Phase 17 credential guard. */
export class PracticalLiveSafetyError extends Error {
  public readonly code: PracticalLiveSafetyErrorCode;
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  public constructor(code: PracticalLiveSafetyErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(`[${code}] ${message}`);
    assertCredentialFree(details);
    this.name = 'PracticalLiveSafetyError';
    this.code = code;
    this.details = details === undefined ? undefined : Object.freeze({ ...details });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Shared validators
// ---------------------------------------------------------------------------

/** Non-empty, exact (untrimmed-equal) identifier. */
export function isExactId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

/** Lowercase 64-hex digest. */
export const PRACTICAL_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
