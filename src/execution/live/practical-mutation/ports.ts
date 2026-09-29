/**
 * Phase 18B Stage 1B2 (Wave 2B1): the practical CANCEL mutation store PORT.
 *
 * Prisma-free and network-free. The only implementation is `./repository.ts`.
 *
 * WHAT THIS IS. Two durable, all-or-nothing transitions for ONE Tier-B
 * (practical) CANCEL of ONE existing Phase 17 order:
 *
 *   ACQUIRE: in ONE database transaction, the genuine current practical
 *     certificate is consumed, exactly one ORDER-BOUND CANCEL lease is taken,
 *     the account enters MUTATING with a MUTATION_LEASED fence, and the
 *     existing Phase 17 cancel claim is taken, or nothing is.
 *   ARM: in ONE database transaction, the practical lease AND the Phase 17
 *     cancel claim are both marked armed (pre-wire), or neither is.
 *
 * WHAT THIS IS NOT.
 *   - Not account continuity. Every value here carries
 *     `provesAccountContinuity: false`; nothing here is, mints, reads, or
 *     forwards a Phase 18 strict reconciliation authorization. The strict
 *     Tier-A barrier still refuses with ACCOUNT_CONTINUITY_NOT_PROVEN.
 *   - Not dispatch authority. The armed ticket names the exact order a later,
 *     separately reviewed service may cancel; that service must still run its
 *     own private-stream guard immediately after the arm and before any
 *     gateway call. The database cannot prove the CURRENT stream incarnation:
 *     it only re-proves the certificate's durable `streamIncarnation`.
 *   - Not wired. No runtime, composition root, controller, or request path
 *     reaches this module (architecture-pinned), and there is no tier,
 *     mode, action, client-order-id, lease-id, or generation input.
 *   - CANCEL only. OPEN and CLOSE stay impossible (no action input; the
 *     rollout stage is STAGE_5A_CANCEL_ONLY; a database CHECK refuses any
 *     order-bound lease that is not CANCEL).
 */
import { assertCredentialFree } from '../errors';
import type { PracticalFenceExpectation } from '../practical/fence';
import type { PracticalInvalidationReason } from '../practical/types';
import type { PracticalAcquiredCancel, PracticalArmedCancel } from './ticket';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PracticalMutationErrorCode =
  /** Caller input failed validation before any durable access. Zero change. */
  | 'PRACTICAL_MUTATION_INVALID_INPUT'
  /** An enablement, runtime identity, certificate, or handle is not genuine, not permitted, or not usable. Zero change. */
  | 'PRACTICAL_MUTATION_AUTHORITY_INVALID'
  /** The quiet dwell after certificate issuance has not elapsed. Zero change; the certificate stays usable later. */
  | 'PRACTICAL_MUTATION_DWELL_NOT_ELAPSED'
  /** A pre-write arm check failed. The whole arm transaction rolled back: zero change. */
  | 'PRACTICAL_MUTATION_ARM_REFUSED'
  /** A post-write re-read, or a locked durable row, did not prove the exact expected result. Rolled back. */
  | 'PRACTICAL_MUTATION_SELF_CHECK_FAILED'
  /** A database failure (deadlock retries exhausted, or a non-retryable database error). Nothing was committed. */
  | 'PRACTICAL_MUTATION_FAULT'
  /**
   * The transaction work completed but its COMMIT failed or could not be
   * confirmed: the durable outcome is UNKNOWN. Nothing is minted, nothing is
   * compensated; a later recovery path resolves the durable state.
   */
  | 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN'
  /** [Wave 2B2b] A no-wire completion / abandon pre-write check failed. The whole transaction rolled back: zero change. */
  | 'PRACTICAL_MUTATION_COMPLETION_REFUSED'
  /**
   * [Wave 2B2b] The locked durable practical lease and the Phase 17 claim
   * contradict each other (a split pair). Rolled back; the account is then
   * put into manual review in its own transaction. Never repaired.
   */
  | 'PRACTICAL_MUTATION_SPLIT_STATE'
  /** [Wave 2B2b] The lease was already completed by a different operation. Zero change. */
  | 'PRACTICAL_MUTATION_ALREADY_COMPLETED';

/** Credential-free, typed Stage 1B2 mutation error. Details go through the Phase 17 credential guard. */
export class PracticalMutationError extends Error {
  public readonly code: PracticalMutationErrorCode;
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  public constructor(code: PracticalMutationErrorCode, message: string, details?: Readonly<Record<string, unknown>>, cause?: unknown) {
    super(`[${code}] ${message}`, cause === undefined ? undefined : { cause });
    assertCredentialFree(details);
    this.name = 'PracticalMutationError';
    this.code = code;
    this.details = details === undefined ? undefined : Object.freeze({ ...details });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Acquire
// ---------------------------------------------------------------------------

/** The exact, closed set of acquire input keys. Any other own key is refused before any durable access. */
export const PRACTICAL_CANCEL_ACQUIRE_INPUT_KEYS = Object.freeze([
  'accountId', 'expected', 'certificate', 'enablement', 'runtimeIdentity', 'intentId', 'trustedNowMs',
] as const);

export interface PracticalCancelAcquireInput {
  readonly accountId: string;
  /** The caller's view of the IDLE practical fence (exact account, epoch, generation, revision). */
  readonly expected: PracticalFenceExpectation;
  /** A genuine, in-memory ISSUED Stage 1A practical recovery certificate. */
  readonly certificate: unknown;
  /** A genuine configuration-issued Tier-B enablement. Read, never minted. */
  readonly enablement: unknown;
  /** The genuine runtime identity of THIS process. Read, never minted. */
  readonly runtimeIdentity: unknown;
  /** Lowercase 64-hex Phase 17 intent id: the ONLY order selector. The client order id is never an input. */
  readonly intentId: string;
  readonly trustedNowMs: number;
}

/** The existing Stage 1A reasons an acquisition may durably invalidate with (all QUARANTINE severity). */
export type PracticalAcquireInvalidationReason = 'PREFLIGHT_MISMATCH' | 'GENERATION_CHANGED' | 'RUNTIME_EPOCH_CHANGED' | 'CONFIG_CHANGED';

export type PracticalAcquireInvalidationCause =
  | 'EFFECTIVE_LIFETIME_EXCEEDED'
  | 'RECONCILIATION_STATE_MISMATCH'
  | 'PHASE17_ORDER_MISMATCH'
  | 'PHASE17_NOT_CANCELLABLE'
  | 'PHASE17_ALREADY_CLAIMED'
  | 'PHASE17_CLAIM_REFUSED';

export type PracticalCancelAcquisition =
  /** Committed: certificate CONSUMED, one order-bound CANCEL lease, MUTATING, MUTATION_LEASED, Phase 17 CANCEL_RESERVED. */
  | { readonly kind: 'ACQUIRED'; readonly acquired: PracticalAcquiredCancel }
  /** Committed (existing Stage 1B1 behavior): the certificate was outside its durable validity window. No Phase 17 row touched. */
  | { readonly kind: 'CERTIFICATE_TERMINATED'; readonly certificateId: string; readonly status: 'EXPIRED' | 'REVOKED' }
  /**
   * Committed fail-closed: the current certificate was REVOKED with `reason`
   * and the account QUARANTINED. No lease was created and no Phase 17 row
   * was written.
   */
  | {
      readonly kind: 'AUTHORITY_INVALIDATED';
      readonly certificateId: string;
      readonly reason: PracticalAcquireInvalidationReason;
      readonly cause: PracticalAcquireInvalidationCause;
      /** The classified Phase 17 pre-write refusal code, for PHASE17_CLAIM_REFUSED only. */
      readonly phase17Code: 'LIVE_INTENT_INVALID' | 'LIVE_AUTHORITY_INVALID' | 'LIVE_ORDER_IDENTITY_MISMATCH' | null;
    }
  /** Rolled back, then latched by the existing Stage 1B1 escalation: the account's durable rows are malformed. */
  | { readonly kind: 'MALFORMED_LATCHED'; readonly reviewEpisodeId: string };

// ---------------------------------------------------------------------------
// Arm
// ---------------------------------------------------------------------------

/** The exact, closed set of arm input keys. */
export const PRACTICAL_CANCEL_ARM_INPUT_KEYS = Object.freeze(['acquired', 'enablement', 'runtimeIdentity', 'trustedNowMs'] as const);

export interface PracticalCancelArmInput {
  /**
   * A genuine, AVAILABLE `PracticalAcquiredCancel`. A committed arm spends it; an
   * UNKNOWN arm commit leaves it ARM_OUTCOME_UNKNOWN [Wave 2B2b], which only
   * `abandonAcquiredCancel` accepts (no ticket is ever minted from it).
   */
  readonly acquired: unknown;
  readonly enablement: unknown;
  readonly runtimeIdentity: unknown;
  readonly trustedNowMs: number;
}

/** Every refusal throws with the database unchanged. */
export type PracticalCancelArm = { readonly kind: 'ARMED'; readonly ticket: PracticalArmedCancel };

// ---------------------------------------------------------------------------
// [Wave 2B2b] No-wire completion and in-process abandon
//
// Both close an ALREADY-OWNED order-bound CANCEL attempt that provably never
// reached a gateway, as PRE_DISPATCH_FAILURE, atomically on both durable
// sides. They are CLEANUP, not mutation authority: no enablement, HEALTHY
// reconciliation, dwell, certificate validity, stream, or runtime epoch is
// required. There is no dispatched outcome here: AMBIGUOUS, REJECTED, and
// ACCEPTED are not expressible, and there is no gateway input of any kind.
// ---------------------------------------------------------------------------

/** Why an ARMED ticket was never dispatched (audit only; never interpreted). */
export type PracticalNoDispatchReason = 'FINAL_STREAM_GUARD_FAILED' | 'DISPATCH_WINDOW_CLOSED' | 'ABORTED_BEFORE_DISPATCH';
export const PRACTICAL_NO_DISPATCH_REASONS: readonly PracticalNoDispatchReason[] = Object.freeze([
  'FINAL_STREAM_GUARD_FAILED', 'DISPATCH_WINDOW_CLOSED', 'ABORTED_BEFORE_DISPATCH',
] as const);

/** The ONLY completion report Wave 2B2b accepts. Its keys are exactly ['kind', 'reason']. */
export interface PracticalNotDispatchedReport {
  readonly kind: 'NOT_DISPATCHED';
  readonly reason: PracticalNoDispatchReason;
}
export const PRACTICAL_NOT_DISPATCHED_REPORT_KEYS = Object.freeze(['kind', 'reason'] as const);

/** The exact, closed set of undispatched-completion input keys. */
export const PRACTICAL_UNDISPATCHED_COMPLETION_INPUT_KEYS = Object.freeze(['armed', 'report', 'trustedNowMs'] as const);

export interface PracticalUndispatchedCompletionInput {
  /** A genuine `PracticalArmedCancel` that was never dispatched (ARMED), or an identical retry after an unknown commit. */
  readonly armed: unknown;
  readonly report: PracticalNotDispatchedReport;
  readonly trustedNowMs: number;
}

/** The exact, closed set of abandon input keys. */
export const PRACTICAL_CANCEL_ABANDON_INPUT_KEYS = Object.freeze(['acquired', 'trustedNowMs'] as const);

export interface PracticalCancelAbandonInput {
  /** A genuine `PracticalAcquiredCancel` that is AVAILABLE, ARM_OUTCOME_UNKNOWN, or ABANDON_OUTCOME_UNKNOWN (identical retry). */
  readonly acquired: unknown;
  readonly trustedNowMs: number;
}

export type PracticalNoWireCompletion =
  /**
   * COMPLETED: committed now. ALREADY_COMPLETED: an identical retry after an
   * unknown commit found the SAME completion already durable. Either way the
   * lease is COMPLETED PRE_DISPATCH_FAILURE and the Phase 17 claim is NONE.
   */
  | {
      readonly kind: 'COMPLETED' | 'ALREADY_COMPLETED';
      readonly outcome: 'PRE_DISPATCH_FAILURE';
      readonly leaseId: string;
      readonly intentId: string;
      readonly cancelGeneration: number;
    }
  /** Rolled back, then latched by the existing Stage 1B1 escalation: the account's durable rows are malformed. */
  | { readonly kind: 'MALFORMED_LATCHED'; readonly reviewEpisodeId: string };

// ---------------------------------------------------------------------------
// The ports
// ---------------------------------------------------------------------------

export interface PracticalCancelMutationStore {
  acquireCancelLease(input: PracticalCancelAcquireInput): Promise<PracticalCancelAcquisition>;
  armCancelLease(input: PracticalCancelArmInput): Promise<PracticalCancelArm>;
}

/** [Wave 2B2b] Truthful no-wire closing of an owned attempt. PRE_DISPATCH_FAILURE only. */
export interface PracticalCancelNoWireStore {
  completeUndispatchedCancel(input: PracticalUndispatchedCompletionInput): Promise<PracticalNoWireCompletion>;
  abandonAcquiredCancel(input: PracticalCancelAbandonInput): Promise<PracticalNoWireCompletion>;
}

/** Re-exported for callers that match on the invalidation reason; the set is closed. */
export const PRACTICAL_ACQUIRE_INVALIDATION_REASONS: readonly PracticalAcquireInvalidationReason[] = Object.freeze([
  'PREFLIGHT_MISMATCH', 'GENERATION_CHANGED', 'RUNTIME_EPOCH_CHANGED', 'CONFIG_CHANGED',
] satisfies PracticalInvalidationReason[]);
