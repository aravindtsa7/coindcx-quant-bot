/**
 * Phase 18B Stage 1B1: practical live-safety persistence port.
 *
 * Execution-owned. This module is Prisma-free; the only implementation is
 * `./repository.ts`. It defines durable STORAGE for the Stage 1A authority
 * model (`../practical`). It adds no authority of its own:
 *
 *   - a durable certificate is PRACTICAL_RECOVERY evidence, never Phase 18
 *     account continuity;
 *   - consuming a certificate and taking a mutation lease is a durable
 *     ONE-SHOT bookkeeping primitive. It does NOT authorize, arm, or dispatch
 *     any provider mutation. Stage 1B2 must still join this acquisition with
 *     the existing Phase 17 dispatch claim in ONE transaction (no
 *     split-brain window between "lease taken" and "dispatch claimed") before
 *     anything can reach the wire. Stage 1B1 wires nothing.
 *
 * TRUSTED ABSENCE. `NOT_FOUND` is returned only when the read succeeded and
 * returned zero rows for the account's state, fence, AND malformed latch. A
 * read error propagates as an exception. A row that fails strict validation
 * is `MALFORMED`: never repaired, never read as absent. Stage 1A's startup
 * rule then yields MANUAL_REVIEW_REQUIRED (see `practicalStartupStateFromLoad`).
 *
 * MALFORMED-STATE LATCH. A MALFORMED account is latched into a DURABLE
 * manual-review episode by the explicit `escalateMalformedAccount`. The
 * malformed rows are left exactly as found: nothing is rewritten, and no
 * epoch, generation, or revision is invented. The latch is a separate row
 * pointing at a MALFORMED_STATE review episode with fixed reason
 * DURABLE_STATE_MALFORMED and a safe problem code. While it is active, the
 * load is MALFORMED carrying that `reviewEpisodeId` (even if the rows have
 * since been corrected), and every operation except escalation (idempotent)
 * and the exact-episode resolution is refused with
 * PRACTICAL_PERSISTENCE_LATCHED. Stage 1A's contract: a malformed durable
 * state is retained as a MANUAL_REVIEW_REQUIRED episode, and only the normal
 * account- and episode-bound, one-shot resolution clears it.
 */
import { assertCredentialFree } from '../errors';
import type { PracticalCertificateStatus } from '../practical/certificate';
import type { PracticalAccountFence, PracticalFenceExpectation } from '../practical/fence';
import type {
  PracticalAccountStateName,
  PracticalInvalidationReason,
  PracticalMutationAction,
  PracticalMutationOutcome,
  PracticalQuarantineCause,
} from '../practical/types';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PracticalPersistenceErrorCode =
  /** The operation needs the account's practical rows and there are none (a successful zero-row read). */
  | 'PRACTICAL_PERSISTENCE_NOT_FOUND'
  /** A durable row failed strict validation. Never repaired; never treated as absent. */
  | 'PRACTICAL_PERSISTENCE_MALFORMED'
  /** The account is latched in a malformed-state manual-review episode; only its exact resolution proceeds. */
  | 'PRACTICAL_PERSISTENCE_LATCHED'
  /** A durable precondition (state, mode, current pointer, CAS) did not hold. Zero durable change. */
  | 'PRACTICAL_PERSISTENCE_CONFLICT'
  /** The certificate is not durable, not ISSUED, not current, or differs from the presented one. */
  | 'PRACTICAL_PERSISTENCE_CERTIFICATE_UNUSABLE'
  /** Caller input failed validation before any durable access. */
  | 'PRACTICAL_PERSISTENCE_INVALID_INPUT'
  /** The database kept failing on a transaction conflict; nothing was committed. */
  | 'PRACTICAL_PERSISTENCE_FAULT';

/** Why a durable read was MALFORMED. A safe code only; never a row dump. */
export type PracticalMalformedProblem =
  | 'STATE_ROW_INVALID'
  | 'FENCE_ROW_INVALID'
  | 'CERTIFICATE_ROW_INVALID'
  | 'LEASE_ROW_INVALID'
  | 'RECOVERY_EPISODE_ROW_INVALID'
  | 'REVIEW_EPISODE_ROW_INVALID'
  | 'LATCH_ROW_INVALID'
  | 'PARTIAL_ACCOUNT_ROWS'
  | 'DUPLICATE_ROWS'
  | 'ROWS_INCONSISTENT'
  /** The rows currently parse, but a malformed-state latch is still unresolved. */
  | 'LATCHED_PENDING_REVIEW';

/** The fixed, safe reason recorded on every MALFORMED_STATE review episode. */
export const PRACTICAL_DURABLE_STATE_MALFORMED = 'DURABLE_STATE_MALFORMED' as const;

/** Credential-free, typed persistence error. Details go through the Phase 17 credential guard. */
export class PracticalPersistenceError extends Error {
  public readonly code: PracticalPersistenceErrorCode;
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  public constructor(code: PracticalPersistenceErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(`[${code}] ${message}`);
    assertCredentialFree(details);
    this.name = 'PracticalPersistenceError';
    this.code = code;
    this.details = details === undefined ? undefined : Object.freeze({ ...details });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Durable records (strictly validated on every read)
// ---------------------------------------------------------------------------

export type PracticalRecoveryEpisodeStatus = 'OPEN' | 'CERTIFIED' | 'ESCALATED_TO_MANUAL_REVIEW';
export type PracticalReviewEpisodeStatus = 'OPEN' | 'RESOLVED';
export type PracticalLeaseStatus = 'LEASED' | 'COMPLETED';

export interface PracticalDurableCertificateRecord {
  readonly certificateId: string;
  readonly accountId: string;
  /** Lowercase 64-hex provider account fingerprint digest; never the raw identity. */
  readonly providerAccountFingerprint: string;
  readonly runtimeEpoch: string;
  readonly reconciliationGeneration: number;
  readonly streamIncarnation: number;
  readonly evidenceDigest: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly status: PracticalCertificateStatus;
  readonly terminalAtMs: number | null;
  readonly terminalReason: PracticalInvalidationReason | null;
}

export interface PracticalMutationLeaseRecord {
  readonly leaseId: string;
  readonly accountId: string;
  readonly certificateId: string;
  readonly action: PracticalMutationAction;
  readonly runtimeEpoch: string;
  readonly reconciliationGeneration: number;
  readonly createdAtMs: number;
  readonly status: PracticalLeaseStatus;
  readonly completedAtMs: number | null;
  /** Bookkeeping of what the caller reported; NOT evidence that a provider mutation happened. */
  readonly outcome: PracticalMutationOutcome | null;
}

export interface PracticalRecoveryEpisodeRecord {
  readonly episodeId: string;
  readonly accountId: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly startCause: PracticalQuarantineCause;
  readonly status: PracticalRecoveryEpisodeStatus;
  readonly runtimeEpoch: string;
  readonly reconciliationGeneration: number | null;
  readonly certifiedCertificateId: string | null;
  readonly reviewEpisodeId: string | null;
  readonly openedByResolutionId: string | null;
}

export type PracticalReviewEpisodeKind = 'INVALIDATION' | 'MALFORMED_STATE';

export interface PracticalReviewEpisodeRecord {
  readonly reviewEpisodeId: string;
  readonly accountId: string;
  readonly kind: PracticalReviewEpisodeKind;
  readonly enteredAtMs: number;
  /** A Stage 1A MANUAL_REVIEW reason for INVALIDATION; exactly DURABLE_STATE_MALFORMED for MALFORMED_STATE. */
  readonly reason: PracticalInvalidationReason | typeof PRACTICAL_DURABLE_STATE_MALFORMED;
  /** MALFORMED_STATE only: the safe problem code detected at escalation. */
  readonly malformedProblem: PracticalMalformedProblem | null;
  readonly runtimeEpoch: string;
  readonly status: PracticalReviewEpisodeStatus;
  readonly resolvedAtMs: number | null;
  readonly resolutionId: string | null;
}

/** One account's current practical rows, validated individually AND for mutual consistency. */
export interface PracticalAccountSnapshot {
  readonly accountId: string;
  readonly state: PracticalAccountStateName;
  readonly stateRevision: number;
  readonly fence: PracticalAccountFence;
  /** Non-null exactly while QUARANTINED, CERTIFYING, or PROVIDER_UNAVAILABLE. */
  readonly currentRecoveryEpisode: PracticalRecoveryEpisodeRecord | null;
  /** Non-null exactly while MANUAL_REVIEW_REQUIRED: the CURRENT review episode. */
  readonly currentReviewEpisode: PracticalReviewEpisodeRecord | null;
  /** Non-null exactly while CERTIFIED_IDLE: the one ISSUED, current certificate. */
  readonly currentCertificate: PracticalDurableCertificateRecord | null;
  /**
   * Non-null exactly while the fence is MUTATION_LEASED (in ANY state: an
   * invalidation mid-mutation leaves the fence leased while the state moves to
   * QUARANTINED or MANUAL_REVIEW_REQUIRED): the durable LEASED lease that the
   * fence names, exactly equal to it on lease id, certificate, account,
   * action, runtime epoch, and reconciliation generation.
   */
  readonly currentLease: PracticalMutationLeaseRecord | null;
  /**
   * Non-null exactly when `currentLease` is: the CONSUMED certificate behind
   * that lease, exactly equal to it on certificate id, account, runtime epoch,
   * and reconciliation generation (fence -> LEASED lease -> CONSUMED
   * certificate). Deliberately separate from `currentCertificate`, which is
   * the ISSUED certificate of CERTIFIED_IDLE only.
   */
  readonly leasedCertificate: PracticalDurableCertificateRecord | null;
}

// ---------------------------------------------------------------------------
// Explicit read results (NOT_FOUND is never an error in disguise)
// ---------------------------------------------------------------------------

export type PracticalAccountLoad =
  /** A successful read of zero state, fence, and latch rows: genuinely no prior practical state. */
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'FOUND'; readonly account: PracticalAccountSnapshot }
  /**
   * Untrustworthy durable state: MANUAL_REVIEW_REQUIRED. `reviewEpisodeId` is
   * the CURRENT durable malformed-state episode once escalated (null until
   * `escalateMalformedAccount` latches it).
   */
  | { readonly kind: 'MALFORMED'; readonly problem: PracticalMalformedProblem; readonly reviewEpisodeId: string | null };

export type PracticalRecordLoad<T> =
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'FOUND'; readonly record: T }
  | { readonly kind: 'MALFORMED'; readonly problem: PracticalMalformedProblem };

// ---------------------------------------------------------------------------
// Operation results
// ---------------------------------------------------------------------------

export type PracticalAccountInitialization =
  | { readonly kind: 'CREATED'; readonly account: PracticalAccountSnapshot }
  | { readonly kind: 'EXISTING'; readonly account: PracticalAccountSnapshot };

export type PracticalManualReviewEntry =
  /** A NEW review episode was created. */
  | { readonly kind: 'ENTERED'; readonly reviewEpisodeId: string; readonly account: PracticalAccountSnapshot }
  /** The account was already in review: its unresolved CURRENT episode is preserved (no new episode, no write). */
  | { readonly kind: 'PRESERVED'; readonly reviewEpisodeId: string; readonly account: PracticalAccountSnapshot };

export type PracticalCertificateTerminalChange =
  | { readonly kind: 'TERMINATED'; readonly certificate: PracticalDurableCertificateRecord; readonly account: PracticalAccountSnapshot }
  /** The certificate already had exactly this terminal status and reason: nothing written. */
  | { readonly kind: 'ALREADY_TERMINAL'; readonly certificate: PracticalDurableCertificateRecord };

export type PracticalLeaseAcquisition =
  | {
      readonly kind: 'LEASED';
      readonly lease: PracticalMutationLeaseRecord;
      readonly certificate: PracticalDurableCertificateRecord;
      readonly account: PracticalAccountSnapshot;
    }
  /**
   * The supplied trusted time was outside the certificate's validity window.
   * The certificate was durably terminated (EXPIRED, or REVOKED for
   * CLOCK_ANOMALY before issuance) and the account quarantined. No lease.
   */
  | {
      readonly kind: 'CERTIFICATE_TERMINATED';
      readonly certificate: PracticalDurableCertificateRecord;
      readonly account: PracticalAccountSnapshot;
    };

export type PracticalMalformedEscalation =
  /** A NEW MALFORMED_STATE review episode now latches the account. */
  | { readonly kind: 'LATCHED'; readonly reviewEpisodeId: string; readonly problem: PracticalMalformedProblem }
  /** The account was already latched: its unresolved CURRENT episode is preserved; nothing is written. */
  | { readonly kind: 'PRESERVED'; readonly reviewEpisodeId: string };

export type PracticalCertificationFailure =
  | { readonly kind: 'PROVIDER_UNAVAILABLE' }
  | { readonly kind: 'INVALIDATED'; readonly reason: PracticalInvalidationReason };

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * Durable practical safety storage. Every mutating operation runs in ONE
 * database transaction that locks the account's rows (`FOR UPDATE`, fixed
 * order: state, fence, then certificate/lease/episodes), applies the Stage 1A
 * pure transition(s), and writes with conditional updates. It is all or
 * nothing. Operations that refuse throw and change nothing.
 *
 * Deliberately NOT on this port: resolving a manual review. That primitive
 * exists on the Prisma adapter only, is internal, and is not wired (Stage 1B1
 * adds no operator authentication or endpoint).
 */
export interface PracticalSafetyRepository {
  loadAccount(accountId: string): Promise<PracticalAccountLoad>;
  loadCertificate(certificateId: string): Promise<PracticalRecordLoad<PracticalDurableCertificateRecord>>;
  loadLease(leaseId: string): Promise<PracticalRecordLoad<PracticalMutationLeaseRecord>>;

  /**
   * Latches a MALFORMED account into a durable MALFORMED_STATE review
   * episode. It writes only the episode and the latch; the malformed rows are
   * never touched. It is idempotent while latched (PRESERVED, no write), and
   * it refuses for NOT_FOUND and for a valid, unlatched account.
   * `detectingRuntimeEpoch` is audit only: the runtime that detected the fault.
   */
  escalateMalformedAccount(input: {
    readonly accountId: string;
    readonly detectingRuntimeEpoch: string;
    readonly nowMs: number;
  }): Promise<PracticalMalformedEscalation>;

  /** Creates the account's rows (QUARANTINED, fence IDLE revision 0, an OPEN recovery episode) if absent. */
  initializeAccount(input: {
    readonly accountId: string;
    readonly runtimeEpoch: string;
    readonly reconciliationGeneration: number;
    readonly nowMs: number;
  }): Promise<PracticalAccountInitialization>;

  /** Stage 1A adoption by a new runtime epoch. A leased fence is refused. */
  adoptForNewRuntime(input: {
    readonly accountId: string;
    readonly previousRuntimeEpoch: string;
    readonly expectedFenceRevision: number;
    readonly newRuntimeEpoch: string;
    readonly nowMs: number;
  }): Promise<PracticalAccountSnapshot>;

  startCertification(input: {
    readonly accountId: string;
    readonly expected: PracticalFenceExpectation;
    readonly runId: string;
    readonly nowMs: number;
  }): Promise<PracticalAccountSnapshot>;

  /** Persists the ISSUED certificate AND moves the fence to IDLE in one transaction. */
  finishCertification(input: {
    readonly accountId: string;
    readonly expected: PracticalFenceExpectation;
    readonly runId: string;
    readonly resultingGeneration: number;
    /** A genuine, in-memory ISSUED Stage 1A certificate. The repository never mints one. */
    readonly certificate: unknown;
    readonly nowMs: number;
  }): Promise<PracticalAccountSnapshot>;

  failCertification(input: {
    readonly accountId: string;
    readonly expected: PracticalFenceExpectation;
    readonly runId: string;
    readonly resultingGeneration: number;
    readonly failure: PracticalCertificationFailure;
    readonly nowMs: number;
  }): Promise<PracticalAccountSnapshot>;

  recordProviderRecovered(input: { readonly accountId: string; readonly nowMs: number }): Promise<PracticalAccountSnapshot>;

  /** Applies a Stage 1A invalidation immediately; revokes the current certificate; enters review for MANUAL_REVIEW reasons. */
  invalidate(input: {
    readonly accountId: string;
    readonly reason: PracticalInvalidationReason;
    readonly nowMs: number;
  }): Promise<{ readonly account: PracticalAccountSnapshot; readonly reviewEpisodeId: string | null }>;

  enterManualReview(input: {
    readonly accountId: string;
    readonly reason: PracticalInvalidationReason;
    readonly nowMs: number;
  }): Promise<PracticalManualReviewEntry>;

  revokeCertificate(input: {
    readonly accountId: string;
    readonly certificateId: string;
    readonly reason: PracticalInvalidationReason;
    readonly nowMs: number;
  }): Promise<PracticalCertificateTerminalChange>;

  expireCertificate(input: {
    readonly accountId: string;
    readonly certificateId: string;
    readonly trustedNowMs: number;
  }): Promise<PracticalCertificateTerminalChange>;

  /**
   * THE Stage 1B1 durable one-shot primitive: lock fence + certificate,
   * validate, ISSUED -> CONSUMED, IDLE -> MUTATION_LEASED, insert exactly one
   * lease, all in one transaction. Grants NO dispatch authority.
   */
  consumeCertificateAndLease(input: {
    readonly accountId: string;
    readonly expected: PracticalFenceExpectation;
    /** A genuine in-memory Stage 1A certificate whose record must equal the durable row exactly. */
    readonly certificate: unknown;
    readonly leaseId: string;
    readonly action: PracticalMutationAction;
    readonly trustedNowMs: number;
  }): Promise<PracticalLeaseAcquisition>;

  /** Bookkeeping only: records the reported outcome and releases the lease. No provider call. */
  releaseLease(input: {
    readonly accountId: string;
    readonly expected: PracticalFenceExpectation;
    readonly leaseId: string;
    readonly outcome: PracticalMutationOutcome;
    readonly nowMs: number;
  }): Promise<PracticalAccountSnapshot>;
}
