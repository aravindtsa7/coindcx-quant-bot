/**
 * Phase 18B Stage 1B2 (Wave 2B1): the two non-forgeable in-memory values of
 * one order-bound practical CANCEL.
 *
 *   PracticalAcquiredCancel  minted ONLY after an acquisition transaction
 *                            COMMITS. It is what an arm call presents. It
 *                            carries the full immutable snapshot of the
 *                            CONSUMED certificate so the arm transaction can
 *                            re-prove it field by field.
 *   PracticalArmedCancel     minted ONLY after an arm transaction COMMITS
 *                            (practical lease AND Phase 17 cancel claim both
 *                            armed). It names the exact order a later,
 *                            separately reviewed service may cancel.
 *
 * NEITHER IS AUTHORITY ON ITS OWN. Neither proves account continuity
 * (`provesAccountContinuity: false`), neither is or converts to a Phase 18
 * strict reconciliation authorization, and the armed ticket alone is not
 * enough to call a gateway: the later service must still run its own private
 * stream guard immediately after the arm. No secret is carried.
 *
 * NON-FORGEABLE. Private-field state, a module-private issuer object, and a
 * frozen class and prototype. `read` returns null for clones, spreads,
 * JSON round-trips, and prototype-only objects. The issuing and lifecycle
 * functions below are exported for the Stage 1B2 Prisma adapter ONLY; their
 * production importer set is architecture-pinned to exactly that file.
 *
 * ACQUIRED-HANDLE LIFECYCLE.
 *   arm:     AVAILABLE -> IN_USE (reserved at arm entry, held across internal
 *            retries) -> SPENT after a committed arm (a ticket is minted), or
 *            -> AVAILABLE again after a PROVEN zero-change refusal or rollback,
 *            or -> ARM_OUTCOME_UNKNOWN [Wave 2B2b] when the arm COMMIT could
 *            not be confirmed. No ticket is EVER minted from that state, so no
 *            gateway call can follow it; only abandon accepts it.
 *   abandon: AVAILABLE | ARM_OUTCOME_UNKNOWN | ABANDON_OUTCOME_UNKNOWN ->
 *            ABANDONING -> SPENT after COMMIT, or back to the state it came
 *            from after a PROVEN rollback, or -> ABANDON_OUTCOME_UNKNOWN (only
 *            an identical abandon retry accepts it).
 *
 * ARMED-TICKET LIFECYCLE [Wave 2B2b]. ARMED -> COMPLETING_NO_WIRE -> SPENT
 * after a committed no-wire completion, or back to ARMED after a PROVEN
 * rollback, or -> COMMIT_UNKNOWN (only an identical NOT_DISPATCHED retry with
 * the SAME reason accepts it). The unwired dispatch core additionally
 * transfers ARMED through PERMIT_CREATING into exclusive permit ownership.
 * TRANSFERRED never regains existing no-wire or dispatch eligibility. The
 * closed tables below add consumption/entry/result bookkeeping, not a gateway.
 *
 * UNKNOWN-ACQUIRE RECEIPT [Wave 2B2c]. `PracticalUnknownAcquire` is minted
 * ONLY when an acquisition's transaction work completed but its COMMIT could
 * not be confirmed. It is NOT a handle: it can neither arm nor abandon. It
 * holds the exact record that transaction would have committed (including the
 * lease id generated inside it), privately, and exposes nothing but `status`.
 * It is delivered through a module-private WeakMap keyed by the exact error
 * object (never as an error property, never in details).
 *   PENDING -> RESOLVING -> SPENT (RESTORED or NOT_COMMITTED), or -> PENDING
 *   again ONLY after an inconclusive attempt (a database fault, a lock-wait
 *   timeout, or the read-only resolution's own unknown COMMIT). Once an
 *   ANOMALY is proven the receipt is permanently mint-disabled:
 *   RESOLVING -> REFUSED (manual review / malformed latch confirmed) or
 *   -> ANOMALY_UNESCALATED; ANOMALY_UNESCALATED -> ESCALATING -> REFUSED, or
 *   back to ANOMALY_UNESCALATED. Neither REFUSED nor ANOMALY_UNESCALATED can
 *   ever reach PENDING, RESOLVING, or SPENT again, whatever the rows later say.
 *
 * The in-memory states are a convenience only: the database compare-and-sets
 * and row locks are the one-shot authority across processes.
 */
import { LIVE_CLIENT_ORDER_ID_PATTERN } from '../identity';
import {
  PRACTICAL_AUTHORIZATION_BASIS,
  PRACTICAL_DIGEST_PATTERN,
  isExactId,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  type PracticalAuthorizationBasis,
} from '../practical/types';
import { PracticalAcquireCommitUnknownError, PracticalMutationError } from './ports';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** The full immutable snapshot of the CONSUMED certificate behind an acquired lease. */
export interface PracticalAcquiredCancelCertificateSnapshot {
  readonly certificateId: string;
  readonly accountId: string;
  readonly providerAccountFingerprint: string;
  readonly runtimeEpoch: string;
  readonly reconciliationGeneration: number;
  readonly streamIncarnation: number;
  readonly evidenceDigest: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly status: 'CONSUMED';
  /** The durable `terminal_at_ms` written by the consumption. */
  readonly consumedAtMs: number;
  readonly terminalReason: null;
  readonly basis: PracticalAuthorizationBasis;
  readonly provesAccountContinuity: false;
}

export interface PracticalAcquiredCancelRecord {
  // lease
  readonly accountId: string;
  readonly leaseId: string;
  readonly action: 'CANCEL';
  readonly runtimeEpoch: string;
  readonly reconciliationGeneration: number;
  readonly leaseCreatedAtMs: number;
  // Phase 17 (from the verified post-claim order)
  readonly intentId: string;
  readonly clientOrderId: string;
  readonly cancelGeneration: number;
  readonly pair: string;
  readonly exchangeOrderId: string;
  readonly orderRevisionAfterClaim: number;
  // the CONSUMED certificate
  readonly certificate: PracticalAcquiredCancelCertificateSnapshot;
  readonly acquiredAtMs: number;
}

export interface PracticalArmedCancelRecord {
  readonly accountId: string;
  readonly leaseId: string;
  readonly certificateId: string;
  readonly intentId: string;
  readonly clientOrderId: string;
  readonly cancelGeneration: number;
  readonly exchangeOrderId: string;
  readonly pair: string;
  readonly orderRevisionAfterArm: number;
  readonly runtimeEpoch: string;
  readonly reconciliationGeneration: number;
  /** The CERTIFICATE's durable stream incarnation. A later service compares it to the live stream; the DB cannot. */
  readonly certificateStreamIncarnation: number;
  readonly certificateExpiresAtMs: number;
  readonly armedAtMs: number;
  readonly action: 'CANCEL';
  readonly basis: PracticalAuthorizationBasis;
  readonly provesAccountContinuity: false;
}

export type PracticalAcquiredCancelStatus =
  | 'AVAILABLE'
  | 'IN_USE'
  | 'SPENT'
  | 'ARM_OUTCOME_UNKNOWN'
  | 'ABANDONING'
  | 'ABANDON_OUTCOME_UNKNOWN';

export type PracticalArmedCancelStatus = 'ARMED' | 'COMPLETING_NO_WIRE' | 'COMMIT_UNKNOWN' | 'SPENT' | 'PERMIT_CREATING' | 'TRANSFERRED' | 'PERMIT_CREATION_UNKNOWN';
export const PRACTICAL_ARMED_CANCEL_TRANSITIONS: Readonly<Record<PracticalArmedCancelStatus, readonly PracticalArmedCancelStatus[]>> = Object.freeze({
  ARMED: Object.freeze(['COMPLETING_NO_WIRE', 'PERMIT_CREATING'] as const),
  COMPLETING_NO_WIRE: Object.freeze(['ARMED', 'COMMIT_UNKNOWN', 'SPENT'] as const),
  COMMIT_UNKNOWN: Object.freeze(['COMPLETING_NO_WIRE'] as const),
  PERMIT_CREATING: Object.freeze(['ARMED', 'PERMIT_CREATION_UNKNOWN', 'TRANSFERRED'] as const),
  PERMIT_CREATION_UNKNOWN: Object.freeze(['TRANSFERRED'] as const),
  TRANSFERRED: Object.freeze([]), SPENT: Object.freeze([]),
});

/** [Wave 2B2c] The unknown-acquire receipt lifecycle (see the module header). */
export type PracticalUnknownAcquireStatus = 'PENDING' | 'RESOLVING' | 'SPENT' | 'REFUSED' | 'ANOMALY_UNESCALATED' | 'ESCALATING';

/** The acquired-handle states an abandon may start from. */
const ABANDONABLE: readonly PracticalAcquiredCancelStatus[] = Object.freeze(['AVAILABLE', 'ARM_OUTCOME_UNKNOWN', 'ABANDON_OUTCOME_UNKNOWN']);

// ---------------------------------------------------------------------------
// Validation (every issued field; couplings)
// ---------------------------------------------------------------------------

function refuse(message: string, field: string): never {
  throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', message, { field });
}

function requireExact(value: unknown, field: string, maxLength: number): string {
  if (!isExactId(value) || value.length > maxLength) refuse(`${field} must be a non-empty exact string of at most ${maxLength} characters`, field);
  return value;
}

function requireDigest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !PRACTICAL_DIGEST_PATTERN.test(value)) refuse(`${field} must be a lowercase 64-hex digest`, field);
  return value;
}

function requirePositive(value: unknown, field: string): number {
  if (!isPositiveSafeInteger(value)) refuse(`${field} must be a positive safe integer`, field);
  return value;
}

function requireNonNegative(value: unknown, field: string): number {
  if (!isNonNegativeSafeInteger(value)) refuse(`${field} must be a non-negative safe integer`, field);
  return value;
}

function requireClientOrderId(value: unknown): string {
  if (typeof value !== 'string' || !LIVE_CLIENT_ORDER_ID_PATTERN.test(value)) refuse('clientOrderId must be the frozen Phase 17 client order id format', 'clientOrderId');
  return value;
}

function requireLiteral<T>(value: unknown, literal: T, field: string): T {
  if (value !== literal) refuse(`${field} must be exactly ${String(literal)}`, field);
  return literal;
}

function validCertificateSnapshot(value: PracticalAcquiredCancelCertificateSnapshot): PracticalAcquiredCancelCertificateSnapshot {
  const issuedAtMs = requireNonNegative(value.issuedAtMs, 'certificate.issuedAtMs');
  const expiresAtMs = requireNonNegative(value.expiresAtMs, 'certificate.expiresAtMs');
  if (expiresAtMs <= issuedAtMs) refuse('certificate.expiresAtMs must be after issuedAtMs', 'certificate.expiresAtMs');
  return Object.freeze({
    certificateId: requireDigest(value.certificateId, 'certificate.certificateId'),
    accountId: requireExact(value.accountId, 'certificate.accountId', 128),
    providerAccountFingerprint: requireDigest(value.providerAccountFingerprint, 'certificate.providerAccountFingerprint'),
    runtimeEpoch: requireExact(value.runtimeEpoch, 'certificate.runtimeEpoch', 64),
    reconciliationGeneration: requirePositive(value.reconciliationGeneration, 'certificate.reconciliationGeneration'),
    streamIncarnation: requirePositive(value.streamIncarnation, 'certificate.streamIncarnation'),
    evidenceDigest: requireDigest(value.evidenceDigest, 'certificate.evidenceDigest'),
    issuedAtMs,
    expiresAtMs,
    status: requireLiteral(value.status, 'CONSUMED' as const, 'certificate.status'),
    consumedAtMs: requireNonNegative(value.consumedAtMs, 'certificate.consumedAtMs'),
    terminalReason: requireLiteral(value.terminalReason, null, 'certificate.terminalReason'),
    basis: requireLiteral(value.basis, PRACTICAL_AUTHORIZATION_BASIS, 'certificate.basis'),
    provesAccountContinuity: requireLiteral(value.provesAccountContinuity, false as const, 'certificate.provesAccountContinuity'),
  });
}

function validAcquiredRecord(value: PracticalAcquiredCancelRecord): PracticalAcquiredCancelRecord {
  if (typeof value !== 'object' || value === null || typeof value.certificate !== 'object' || value.certificate === null) refuse('An acquired-cancel record is required', 'record');
  const certificate = validCertificateSnapshot(value.certificate);
  const record: PracticalAcquiredCancelRecord = Object.freeze({
    accountId: requireExact(value.accountId, 'accountId', 128),
    leaseId: requireExact(value.leaseId, 'leaseId', 64),
    action: requireLiteral(value.action, 'CANCEL' as const, 'action'),
    runtimeEpoch: requireExact(value.runtimeEpoch, 'runtimeEpoch', 64),
    reconciliationGeneration: requirePositive(value.reconciliationGeneration, 'reconciliationGeneration'),
    leaseCreatedAtMs: requireNonNegative(value.leaseCreatedAtMs, 'leaseCreatedAtMs'),
    intentId: requireDigest(value.intentId, 'intentId'),
    clientOrderId: requireClientOrderId(value.clientOrderId),
    cancelGeneration: requirePositive(value.cancelGeneration, 'cancelGeneration'),
    pair: requireExact(value.pair, 'pair', 64),
    exchangeOrderId: requireExact(value.exchangeOrderId, 'exchangeOrderId', 64),
    orderRevisionAfterClaim: requirePositive(value.orderRevisionAfterClaim, 'orderRevisionAfterClaim'),
    certificate,
    acquiredAtMs: requireNonNegative(value.acquiredAtMs, 'acquiredAtMs'),
  });
  // Couplings: one account, one epoch, one generation, one consumption instant.
  if (certificate.accountId !== record.accountId) refuse('The certificate belongs to a different account', 'certificate.accountId');
  if (certificate.runtimeEpoch !== record.runtimeEpoch) refuse('The certificate is bound to a different runtime epoch', 'certificate.runtimeEpoch');
  if (certificate.reconciliationGeneration !== record.reconciliationGeneration) refuse('The certificate is bound to a different generation', 'certificate.reconciliationGeneration');
  if (record.leaseCreatedAtMs !== certificate.consumedAtMs || record.acquiredAtMs !== record.leaseCreatedAtMs) {
    refuse('The lease creation, certificate consumption, and acquisition must be one instant', 'acquiredAtMs');
  }
  return record;
}

function validArmedRecord(value: PracticalArmedCancelRecord): PracticalArmedCancelRecord {
  if (typeof value !== 'object' || value === null) refuse('An armed-cancel record is required', 'record');
  return Object.freeze({
    accountId: requireExact(value.accountId, 'accountId', 128),
    leaseId: requireExact(value.leaseId, 'leaseId', 64),
    certificateId: requireDigest(value.certificateId, 'certificateId'),
    intentId: requireDigest(value.intentId, 'intentId'),
    clientOrderId: requireClientOrderId(value.clientOrderId),
    cancelGeneration: requirePositive(value.cancelGeneration, 'cancelGeneration'),
    exchangeOrderId: requireExact(value.exchangeOrderId, 'exchangeOrderId', 64),
    pair: requireExact(value.pair, 'pair', 64),
    orderRevisionAfterArm: requirePositive(value.orderRevisionAfterArm, 'orderRevisionAfterArm'),
    runtimeEpoch: requireExact(value.runtimeEpoch, 'runtimeEpoch', 64),
    reconciliationGeneration: requirePositive(value.reconciliationGeneration, 'reconciliationGeneration'),
    certificateStreamIncarnation: requirePositive(value.certificateStreamIncarnation, 'certificateStreamIncarnation'),
    certificateExpiresAtMs: requireNonNegative(value.certificateExpiresAtMs, 'certificateExpiresAtMs'),
    armedAtMs: requireNonNegative(value.armedAtMs, 'armedAtMs'),
    action: requireLiteral(value.action, 'CANCEL' as const, 'action'),
    basis: requireLiteral(value.basis, PRACTICAL_AUTHORIZATION_BASIS, 'basis'),
    provesAccountContinuity: requireLiteral(value.provesAccountContinuity, false as const, 'provesAccountContinuity'),
  });
}

// ---------------------------------------------------------------------------
// The values
// ---------------------------------------------------------------------------

const TICKET_ISSUER = Object.freeze({ purpose: 'p18b-stage1b2-practical-cancel-ticket' });

export class PracticalAcquiredCancel {
  readonly #record: PracticalAcquiredCancelRecord;
  #status: PracticalAcquiredCancelStatus = 'AVAILABLE';
  /** [Wave 2B2b] The state the first abandon started from; kept for an identical retry after an unknown commit. */
  #abandonOrigin: 'AVAILABLE' | 'ARM_OUTCOME_UNKNOWN' | null = null;

  public constructor(issuer: unknown, record: PracticalAcquiredCancelRecord) {
    if (issuer !== TICKET_ISSUER) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'An acquired practical cancel may only be issued by the Stage 1B2 adapter after a committed acquisition');
    }
    this.#record = validAcquiredRecord(record);
    Object.freeze(this);
  }

  /** The record of a GENUINE handle (whatever its status), or null for clones and structural fakes. */
  public static read(value: unknown): PracticalAcquiredCancelRecord | null {
    if (typeof value !== 'object' || value === null || !(#record in value)) return null;
    return (value as PracticalAcquiredCancel).#record;
  }

  /** The lifecycle status of a GENUINE handle, or null. */
  public static status(value: unknown): PracticalAcquiredCancelStatus | null {
    if (typeof value !== 'object' || value === null || !(#status in value)) return null;
    return (value as PracticalAcquiredCancel).#status;
  }

  /** Internal lifecycle transition; only this module holds the issuer. */
  public static transition(issuer: unknown, value: unknown, from: PracticalAcquiredCancelStatus, to: PracticalAcquiredCancelStatus): PracticalAcquiredCancelRecord {
    if (issuer !== TICKET_ISSUER) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'Acquired-cancel lifecycle changes are internal to the Stage 1B2 ticket module');
    }
    if (typeof value !== 'object' || value === null || !(#status in value)) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'A genuine acquired practical cancel is required');
    }
    const handle = value as PracticalAcquiredCancel;
    if (handle.#status !== from) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', `The acquired practical cancel is ${handle.#status}, not ${from}`, { status: handle.#status });
    }
    handle.#status = to;
    return handle.#record;
  }

  /**
   * [Wave 2B2b] Internal: starts (or retries) an abandon. The state the FIRST
   * abandon started from (AVAILABLE or ARM_OUTCOME_UNKNOWN) is remembered, so
   * a retry after an unknown abandon commit is judged exactly like the
   * original attempt (an AVAILABLE handle never permits an armed pair).
   */
  public static beginAbandon(issuer: unknown, value: unknown): {
    readonly record: PracticalAcquiredCancelRecord;
    readonly from: PracticalAcquiredCancelStatus;
    readonly origin: 'AVAILABLE' | 'ARM_OUTCOME_UNKNOWN';
  } {
    if (issuer !== TICKET_ISSUER) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'Acquired-cancel lifecycle changes are internal to the Stage 1B2 ticket module');
    }
    if (typeof value !== 'object' || value === null || !(#status in value)) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'A genuine acquired practical cancel is required');
    }
    const handle = value as PracticalAcquiredCancel;
    const from = handle.#status;
    if (!ABANDONABLE.includes(from)) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', `An acquired practical cancel in ${from} cannot be abandoned`, { status: from });
    }
    if (from === 'ABANDON_OUTCOME_UNKNOWN') {
      if (handle.#abandonOrigin === null) throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'An abandon retry has no recorded origin', { status: from });
    } else {
      handle.#abandonOrigin = from as 'AVAILABLE' | 'ARM_OUTCOME_UNKNOWN';
    }
    handle.#status = 'ABANDONING';
    return Object.freeze({ record: handle.#record, from, origin: handle.#abandonOrigin as 'AVAILABLE' | 'ARM_OUTCOME_UNKNOWN' });
  }

  public get provesAccountContinuity(): false { return false; }
}
Object.freeze(PracticalAcquiredCancel.prototype);
Object.freeze(PracticalAcquiredCancel);

export class PracticalArmedCancel {
  readonly #record: PracticalArmedCancelRecord;
  readonly #provenance: PracticalAcquiredCancelRecord | null;
  #status: PracticalArmedCancelStatus = 'ARMED';
  /** The NOT_DISPATCHED reason of a completion whose COMMIT was unknown: only the identical retry is accepted. */
  #unknownReason: string | null = null;

  public constructor(issuer: unknown, record: PracticalArmedCancelRecord, provenance?: PracticalAcquiredCancelRecord) {
    if (issuer !== TICKET_ISSUER) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'An armed practical cancel may only be issued by the Stage 1B2 adapter after a committed arm');
    }
    this.#record = validArmedRecord(record);
    this.#provenance = provenance === undefined ? null : validAcquiredRecord(provenance);
    if (this.#provenance !== null) {
      const original = this.#provenance;
      if (original.accountId !== record.accountId || original.leaseId !== record.leaseId
        || original.certificate.certificateId !== record.certificateId || original.intentId !== record.intentId
        || original.clientOrderId !== record.clientOrderId || original.cancelGeneration !== record.cancelGeneration
        || original.exchangeOrderId !== record.exchangeOrderId || original.pair !== record.pair
        || original.runtimeEpoch !== record.runtimeEpoch || original.reconciliationGeneration !== record.reconciliationGeneration
        || original.orderRevisionAfterClaim + 1 !== record.orderRevisionAfterArm
        || original.certificate.streamIncarnation !== record.certificateStreamIncarnation
        || original.certificate.expiresAtMs !== record.certificateExpiresAtMs || original.leaseCreatedAtMs > record.armedAtMs) {
        refuse('Original acquisition provenance does not match this arm', 'provenance');
      }
    }
    Object.freeze(this);
  }

  /** The record of a GENUINE ticket (whatever its status), or null for clones and structural fakes. */
  public static read(value: unknown): PracticalArmedCancelRecord | null {
    if (typeof value !== 'object' || value === null || !(#record in value)) return null;
    return (value as PracticalArmedCancel).#record;
  }

  /** Immutable acquisition provenance. Missing provenance never permits dispatch. */
  public static provenance(value: unknown): PracticalAcquiredCancelRecord | null {
    if (typeof value !== 'object' || value === null || !(#provenance in value)) return null;
    return (value as PracticalArmedCancel).#provenance;
  }

  /** The lifecycle status of a GENUINE ticket, or null. */
  public static status(value: unknown): PracticalArmedCancelStatus | null {
    if (typeof value !== 'object' || value === null || !(#status in value)) return null;
    return (value as PracticalArmedCancel).#status;
  }

  /**
   * Internal lifecycle transition; only this module holds the issuer.
   * `reason` is required to enter COMMIT_UNKNOWN and, when leaving it,
   * must equal the recorded reason exactly.
   */
  public static transition(
    issuer: unknown,
    value: unknown,
    from: PracticalArmedCancelStatus,
    to: PracticalArmedCancelStatus,
    reason: string | null,
  ): PracticalArmedCancelRecord {
    if (issuer !== TICKET_ISSUER) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'Armed-cancel lifecycle changes are internal to the Stage 1B2 ticket module');
    }
    if (typeof value !== 'object' || value === null || !(#status in value)) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'A genuine armed practical cancel is required');
    }
    const ticket = value as PracticalArmedCancel;
    if (ticket.#status !== from || !PRACTICAL_ARMED_CANCEL_TRANSITIONS[from].includes(to)) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', `The armed practical cancel is ${ticket.#status}, not ${from}`, { status: ticket.#status });
    }
    if (from === 'COMMIT_UNKNOWN' && to === 'COMPLETING_NO_WIRE' && reason !== ticket.#unknownReason) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'After an unknown commit only the identical no-wire completion may be retried', { status: ticket.#status });
    }
    if (to === 'COMMIT_UNKNOWN') {
      if (reason === null) throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'An unknown commit must record its reason', { status: ticket.#status });
      ticket.#unknownReason = reason;
    }
    ticket.#status = to;
    return ticket.#record;
  }

  public get provesAccountContinuity(): false { return false; }
}
Object.freeze(PracticalArmedCancel.prototype);
Object.freeze(PracticalArmedCancel);

// Dispatch ownership is exclusively transferred, never restored from durable rows.
// READY -> CONSUMING -> TRANSFERRED | READY(proven rollback) | REFUSED(CAS loser)
// | CONSUMPTION_UNKNOWN(no attempt). UNENTERED -> ENTERED -> RESULT_RECORDED.
// Cleanup/completion reservations restore only their prior state on proven rollback.
export type PracticalCancelDispatchStatus = 'READY' | 'CONSUMING' | 'TRANSFERRED' | 'REFUSED'
  | 'CONSUMPTION_UNKNOWN' | 'UNENTERED' | 'ENTERED' | 'RESULT_RECORDED'
  | 'CLEANING' | 'CLEANUP_UNKNOWN' | 'COMPLETING' | 'COMMIT_UNKNOWN' | 'SPENT';
export type PracticalCancelDispatchRole = 'PERMIT' | 'ATTEMPT' | 'OUTCOME';
export const PRACTICAL_CANCEL_DISPATCH_TRANSITIONS: Readonly<Record<PracticalCancelDispatchStatus, readonly PracticalCancelDispatchStatus[]>> = Object.freeze({
  READY: Object.freeze(['CONSUMING', 'CLEANING', 'COMPLETING'] as const),
  CONSUMING: Object.freeze(['READY', 'TRANSFERRED', 'REFUSED', 'CONSUMPTION_UNKNOWN'] as const),
  CONSUMPTION_UNKNOWN: Object.freeze(['CLEANING'] as const),
  UNENTERED: Object.freeze(['ENTERED', 'CLEANING'] as const),
  ENTERED: Object.freeze(['RESULT_RECORDED'] as const),
  CLEANING: Object.freeze(['READY', 'UNENTERED', 'CONSUMPTION_UNKNOWN', 'CLEANUP_UNKNOWN', 'SPENT'] as const),
  CLEANUP_UNKNOWN: Object.freeze(['CLEANING'] as const),
  COMPLETING: Object.freeze(['READY', 'COMMIT_UNKNOWN', 'SPENT'] as const),
  COMMIT_UNKNOWN: Object.freeze(['COMPLETING'] as const),
  TRANSFERRED: Object.freeze([]), REFUSED: Object.freeze([]), RESULT_RECORDED: Object.freeze([]), SPENT: Object.freeze([]),
});

export const PRACTICAL_CANCEL_RESULT_REASONS = Object.freeze([
  'LOCAL_REQUEST_REFUSED', 'PROVIDER_REJECTED', 'POSSIBLE_WIRE_FAILURE', 'UNEXPECTED_RESULT',
] as const);
export type PracticalCancelResultReason = (typeof PRACTICAL_CANCEL_RESULT_REASONS)[number];
export type PracticalCancelReportedResult =
  | { readonly kind: 'CANCEL_ACCEPTED'; readonly reason: null }
  | { readonly kind: 'REJECTED' | 'AMBIGUOUS' | 'PRE_DISPATCH_FAILURE'; readonly reason: PracticalCancelResultReason };
export interface PracticalCancelDispatchRecord {
  readonly armed: PracticalArmedCancelRecord;
  readonly original: PracticalAcquiredCancelRecord;
  readonly role: PracticalCancelDispatchRole;
  readonly result: PracticalCancelReportedResult | null;
  readonly creationUnknown: boolean;
}

/** Opaque, non-serializable ownership. Role and lifecycle are always checked together. */
export class PracticalCancelDispatchOwner {
  readonly #record: PracticalCancelDispatchRecord;
  #status: PracticalCancelDispatchStatus;
  #cleanupReason: string | null = null;
  #cleanupOrigin: 'READY' | 'UNENTERED' | 'CONSUMPTION_UNKNOWN' | null = null;
  #cleanupReservedFrom: 'READY' | 'UNENTERED' | 'CONSUMPTION_UNKNOWN' | 'CLEANUP_UNKNOWN' | null = null;
  public constructor(issuer: unknown, record: PracticalCancelDispatchRecord, status: PracticalCancelDispatchStatus) {
    if (issuer !== TICKET_ISSUER) refuse('Dispatch ownership has an internal issuer', 'owner');
    this.#record = Object.freeze(record);
    this.#status = status;
    Object.freeze(this);
  }
  public static read(value: unknown): PracticalCancelDispatchRecord | null {
    return typeof value === 'object' && value !== null && #record in value ? (value as PracticalCancelDispatchOwner).#record : null;
  }
  public static status(value: unknown): PracticalCancelDispatchStatus | null {
    return typeof value === 'object' && value !== null && #status in value ? (value as PracticalCancelDispatchOwner).#status : null;
  }
  /** Original unentered ownership, retained across every unknown cleanup retry. Never durable-row inference. */
  public static cleanupRevisions(value: unknown): readonly number[] | null {
    if (typeof value !== 'object' || value === null || !(#record in value)) return null;
    const owner = value as PracticalCancelDispatchOwner;
    if (owner.#cleanupOrigin === null) return null;
    const revision = owner.#record.armed.orderRevisionAfterArm;
    return Object.freeze(owner.#record.creationUnknown ? [revision]
      : owner.#cleanupOrigin === 'UNENTERED' ? [revision + 1]
        : owner.#cleanupOrigin === 'CONSUMPTION_UNKNOWN' ? [revision, revision + 1] : [revision]);
  }
  public static transition(issuer: unknown, value: unknown, from: PracticalCancelDispatchStatus, to: PracticalCancelDispatchStatus, reason: string | null = null): void {
    if (issuer !== TICKET_ISSUER || typeof value !== 'object' || value === null || !(#status in value)) refuse('Genuine exclusive dispatch ownership required', 'owner');
    const owner = value as PracticalCancelDispatchOwner;
    if (owner.#status !== from || !PRACTICAL_CANCEL_DISPATCH_TRANSITIONS[from].includes(to)) refuse('Illegal dispatch lifecycle transition', 'owner.status');
    const role = owner.#record.role;
    const roleAllows = role === 'OUTCOME' ? ['READY', 'COMPLETING', 'COMMIT_UNKNOWN', 'SPENT'].includes(from) && ['COMPLETING', 'READY', 'COMMIT_UNKNOWN', 'SPENT'].includes(to)
      : role === 'ATTEMPT' ? ['UNENTERED', 'ENTERED', 'RESULT_RECORDED', 'CLEANING', 'CLEANUP_UNKNOWN', 'SPENT'].includes(from)
        && ['UNENTERED', 'ENTERED', 'RESULT_RECORDED', 'CLEANING', 'CLEANUP_UNKNOWN', 'SPENT'].includes(to)
        : !['UNENTERED', 'ENTERED', 'RESULT_RECORDED', 'COMPLETING', 'COMMIT_UNKNOWN'].includes(from)
          && !['UNENTERED', 'ENTERED', 'RESULT_RECORDED', 'COMPLETING', 'COMMIT_UNKNOWN'].includes(to);
    if (!roleAllows) refuse('Dispatch lifecycle transition belongs to a different ownership role', 'owner.role');
    if (to === 'CLEANING') {
      if (reason === null || (owner.#cleanupReason !== null && reason !== owner.#cleanupReason)) refuse('Cleanup retry must use its identical reason', 'report');
      if (from !== 'READY' && from !== 'UNENTERED' && from !== 'CONSUMPTION_UNKNOWN' && from !== 'CLEANUP_UNKNOWN') refuse('Cleanup requires an unentered origin', 'owner.status');
      if (from === 'CLEANUP_UNKNOWN') {
        if (owner.#cleanupOrigin === null) refuse('Unknown cleanup has no original ownership', 'owner.status');
      } else owner.#cleanupOrigin = from;
      owner.#cleanupReservedFrom = from;
      owner.#cleanupReason = reason;
    }
    if (from === 'CLEANING') {
      if (to === 'READY' || to === 'UNENTERED' || to === 'CONSUMPTION_UNKNOWN') {
        if (to !== owner.#cleanupReservedFrom) refuse('Cleanup rollback cannot change ownership origin', 'owner.status');
        owner.#cleanupReason = null;
        owner.#cleanupOrigin = null;
      }
      owner.#cleanupReservedFrom = null;
    }
    owner.#status = to;
  }
}
Object.freeze(PracticalCancelDispatchOwner.prototype);
Object.freeze(PracticalCancelDispatchOwner);
export type PracticalCancelDispatchPermit = PracticalCancelDispatchOwner;
export type PracticalCancelDispatchAttempt = PracticalCancelDispatchOwner;
export type PracticalCancelOutcomeReceipt = PracticalCancelDispatchOwner;

/** Internal store-only armed reservation; refuses missing original provenance. */
export function reservePracticalCancelPermitCreation(value: unknown): PracticalCancelDispatchRecord {
  const armed = PracticalArmedCancel.read(value);
  const original = PracticalArmedCancel.provenance(value);
  if (armed === null || original === null) refuse('Original acquisition provenance is required', 'armed');
  PracticalArmedCancel.transition(TICKET_ISSUER, value, 'ARMED', 'PERMIT_CREATING', null);
  return Object.freeze({ armed, original, role: 'PERMIT', result: null, creationUnknown: false });
}
export function restorePracticalCancelPermitCreation(value: unknown): void {
  PracticalArmedCancel.transition(TICKET_ISSUER, value, 'PERMIT_CREATING', 'ARMED', null);
}
/** Creation commit uncertainty gives no permit; the original ticket retains unentered cleanup only. */
export function markPracticalCancelPermitCreationUnknown(value: unknown): void {
  PracticalArmedCancel.transition(TICKET_ISSUER, value, 'PERMIT_CREATING', 'PERMIT_CREATION_UNKNOWN', null);
}
export function issuePracticalCancelDispatchPermit(value: unknown): PracticalCancelDispatchPermit {
  const armed = PracticalArmedCancel.read(value);
  const original = PracticalArmedCancel.provenance(value);
  if (armed === null || original === null) refuse('Original acquisition provenance is required', 'armed');
  const owner = new PracticalCancelDispatchOwner(TICKET_ISSUER, Object.freeze({ armed, original, role: 'PERMIT', result: null, creationUnknown: false }), 'READY');
  PracticalArmedCancel.transition(TICKET_ISSUER, value, 'PERMIT_CREATING', 'TRANSFERRED', null);
  return owner;
}
/** Unknown creation issued no permit; transfer the original ticket into cleanup-only ownership. */
const CREATION_CLEANUP = new WeakMap<object, PracticalCancelDispatchOwner>();
export function issuePracticalCancelCreationCleanup(value: unknown): PracticalCancelDispatchOwner {
  if (typeof value === 'object' && value !== null) {
    const prior = CREATION_CLEANUP.get(value);
    if (prior !== undefined) return prior;
  }
  const armed = PracticalArmedCancel.read(value);
  const original = PracticalArmedCancel.provenance(value);
  if (armed === null || original === null) refuse('Original acquisition provenance is required', 'armed');
  const owner = new PracticalCancelDispatchOwner(TICKET_ISSUER, Object.freeze({ armed, original, role: 'PERMIT', result: null, creationUnknown: true }), 'CONSUMPTION_UNKNOWN');
  PracticalArmedCancel.transition(TICKET_ISSUER, value, 'PERMIT_CREATION_UNKNOWN', 'TRANSFERRED', null);
  CREATION_CLEANUP.set(value as object, owner);
  return owner;
}
export function transitionPracticalCancelDispatchOwner(value: unknown, from: PracticalCancelDispatchStatus, to: PracticalCancelDispatchStatus, reason: string | null = null): void {
  PracticalCancelDispatchOwner.transition(TICKET_ISSUER, value, from, to, reason);
}
export function issuePracticalCancelDispatchAttempt(value: unknown): PracticalCancelDispatchAttempt {
  const record = PracticalCancelDispatchOwner.read(value);
  if (record === null || record.role !== 'PERMIT') refuse('A genuine consuming permit is required', 'permission');
  const attempt = new PracticalCancelDispatchOwner(TICKET_ISSUER, Object.freeze({ ...record, role: 'ATTEMPT' }), 'UNENTERED');
  transitionPracticalCancelDispatchOwner(value, 'CONSUMING', 'TRANSFERRED');
  return attempt;
}

/** Zero production callers: the future trusted gateway owner must guard immediately before entry. */
export function enterPracticalCancelGateway(value: unknown): PracticalArmedCancelRecord {
  const record = PracticalCancelDispatchOwner.read(value);
  if (record === null || record.role !== 'ATTEMPT') refuse('A genuine unentered attempt is required', 'attempt');
  transitionPracticalCancelDispatchOwner(value, 'UNENTERED', 'ENTERED');
  return record.armed;
}

const NO_WIRE_RESULTS = new WeakMap<object, PracticalCancelDispatchOwner>();
/** Zero production callers. Future issuer must be the trusted transport's proven no-write boundary. */
export function issuePracticalCancelTransportNoWire(value: unknown): object {
  const record = PracticalCancelDispatchOwner.read(value);
  if (record?.role !== 'ATTEMPT' || PracticalCancelDispatchOwner.status(value) !== 'ENTERED') refuse('An entered genuine attempt is required', 'attempt');
  const proof = Object.freeze({});
  NO_WIRE_RESULTS.set(proof, value as PracticalCancelDispatchOwner);
  return proof;
}

/** Normalize only closed, own data fields. Unexpected/hostile/thrown results are possible-wire ambiguity. */
function normalizedCancelResult(value: unknown, attempt: unknown): PracticalCancelReportedResult {
  const unexpected = Object.freeze({ kind: 'AMBIGUOUS' as const, reason: 'UNEXPECTED_RESULT' as const });
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return unexpected;
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return unexpected;
    const keys = Reflect.ownKeys(value);
    const data: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== 'string') return unexpected;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) return unexpected;
      data[key] = descriptor.value;
    }
    if (data['kind'] === 'CANCEL_ACCEPTED' && keys.length === 1) return Object.freeze({ kind: 'CANCEL_ACCEPTED', reason: null });
    if (data['kind'] === 'PRE_DISPATCH_FAILURE' && keys.length === 2 && keys.includes('noWire')) {
      const proof = data['noWire'];
      if (typeof proof !== 'object' || proof === null || NO_WIRE_RESULTS.get(proof) !== attempt) return unexpected;
      NO_WIRE_RESULTS.delete(proof);
      return Object.freeze({ kind: 'PRE_DISPATCH_FAILURE', reason: 'LOCAL_REQUEST_REFUSED' });
    }
    if (keys.length === 1 && data['kind'] === 'REJECTED') return Object.freeze({ kind: 'REJECTED', reason: 'PROVIDER_REJECTED' });
    if (keys.length === 1 && data['kind'] === 'AMBIGUOUS') return Object.freeze({ kind: 'AMBIGUOUS', reason: 'POSSIBLE_WIRE_FAILURE' });
    return unexpected;
  } catch { return unexpected; }
}

/** Zero production callers; immutable result binding, one receipt, no authority or provider proof. */
export function issuePracticalCancelOutcome(value: unknown, reported: unknown): PracticalCancelOutcomeReceipt {
  const record = PracticalCancelDispatchOwner.read(value);
  if (record?.role !== 'ATTEMPT' || PracticalCancelDispatchOwner.status(value) !== 'ENTERED') refuse('An entered genuine attempt is required', 'attempt');
  const result = normalizedCancelResult(reported, value);
  const receipt = new PracticalCancelDispatchOwner(TICKET_ISSUER, Object.freeze({ ...record, role: 'OUTCOME', result }), 'READY');
  transitionPracticalCancelDispatchOwner(value, 'ENTERED', 'RESULT_RECORDED');
  return receipt;
}

/** [Wave 2B2c] The legal receipt transitions (from -> to). Anything else is refused. */
const UNKNOWN_ACQUIRE_TRANSITIONS: Readonly<Record<PracticalUnknownAcquireStatus, readonly PracticalUnknownAcquireStatus[]>> = Object.freeze({
  PENDING: Object.freeze<PracticalUnknownAcquireStatus[]>(['RESOLVING']),
  RESOLVING: Object.freeze<PracticalUnknownAcquireStatus[]>(['SPENT', 'PENDING', 'REFUSED', 'ANOMALY_UNESCALATED']),
  ANOMALY_UNESCALATED: Object.freeze<PracticalUnknownAcquireStatus[]>(['ESCALATING']),
  ESCALATING: Object.freeze<PracticalUnknownAcquireStatus[]>(['REFUSED', 'ANOMALY_UNESCALATED']),
  SPENT: Object.freeze<PracticalUnknownAcquireStatus[]>([]),
  REFUSED: Object.freeze<PracticalUnknownAcquireStatus[]>([]),
});

/**
 * [Wave 2B2c] The single-use recovery receipt of ONE acquisition attempt whose
 * COMMIT was unknown. Not a handle, not authority: it only lets the adapter
 * re-prove the attempt against the locked durable rows. Exposes only `status`.
 */
export class PracticalUnknownAcquire {
  readonly #record: PracticalAcquiredCancelRecord;
  #status: PracticalUnknownAcquireStatus = 'PENDING';
  /** Set ONCE when an anomaly is proven; never cleared. A mint-disabled receipt can never reach SPENT or PENDING. */
  #anomalyProven = false;

  public constructor(issuer: unknown, record: PracticalAcquiredCancelRecord) {
    if (issuer !== TICKET_ISSUER) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'An unknown-acquire receipt may only be issued by the Stage 1B2 adapter after an unknown acquisition COMMIT');
    }
    this.#record = validAcquiredRecord(record);
    Object.freeze(this);
  }

  /** The lifecycle status of a GENUINE receipt, or null for clones and structural fakes. */
  public static status(value: unknown): PracticalUnknownAcquireStatus | null {
    if (typeof value !== 'object' || value === null || !(#status in value)) return null;
    return (value as PracticalUnknownAcquire).#status;
  }

  /** Internal lifecycle transition; only this module holds the issuer. Returns the intended record. */
  public static transition(issuer: unknown, value: unknown, from: PracticalUnknownAcquireStatus, to: PracticalUnknownAcquireStatus): PracticalAcquiredCancelRecord {
    if (issuer !== TICKET_ISSUER) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'Unknown-acquire receipt lifecycle changes are internal to the Stage 1B2 ticket module');
    }
    if (typeof value !== 'object' || value === null || !(#status in value)) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'A genuine unknown-acquire receipt is required');
    }
    const receipt = value as PracticalUnknownAcquire;
    if (receipt.#status !== from || !UNKNOWN_ACQUIRE_TRANSITIONS[from].includes(to)) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', `The unknown-acquire receipt is ${receipt.#status}; ${from} -> ${to} is not allowed`, { status: receipt.#status });
    }
    if (to === 'REFUSED' || to === 'ANOMALY_UNESCALATED') receipt.#anomalyProven = true;
    // Defense in depth over the transition table: a proven anomaly can never mint or become retryable again.
    if (receipt.#anomalyProven && (to === 'SPENT' || to === 'PENDING' || to === 'RESOLVING')) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'The unknown-acquire receipt proved an anomaly and can never mint', { status: receipt.#status });
    }
    receipt.#status = to;
    return receipt.#record;
  }

  // No custom JSON or inspect surface is needed: every field is private, so JSON.stringify yields {}.
}
Object.freeze(PracticalUnknownAcquire.prototype);
Object.freeze(PracticalUnknownAcquire);

/**
 * [Wave 2B2c] The receipt of an unknown-acquire error, held OFF the error
 * object. Module-private: only `issuePracticalUnknownAcquire` writes it and
 * only `readPracticalUnknownAcquireReceipt` reads it.
 */
const UNKNOWN_ACQUIRE_RECEIPTS = new WeakMap<object, PracticalUnknownAcquire>();

// ---------------------------------------------------------------------------
// INTERNAL issuing and lifecycle boundary (production importer: the Stage 1B2 adapter ONLY)
// ---------------------------------------------------------------------------

/** Mints the acquired handle. Called only after the acquisition transaction COMMITTED. */
export function issuePracticalAcquiredCancel(record: PracticalAcquiredCancelRecord): PracticalAcquiredCancel {
  return new PracticalAcquiredCancel(TICKET_ISSUER, record);
}

/** Mints the armed ticket. Called only after the arm transaction COMMITTED. */
export function issuePracticalArmedCancel(record: PracticalArmedCancelRecord, provenance?: PracticalAcquiredCancelRecord): PracticalArmedCancel {
  return new PracticalArmedCancel(TICKET_ISSUER, record, provenance);
}

/** AVAILABLE -> IN_USE at arm entry. Throws (nothing changes) for a forged, in-use, or spent handle. */
export function reservePracticalAcquiredCancel(value: unknown): PracticalAcquiredCancelRecord {
  return PracticalAcquiredCancel.transition(TICKET_ISSUER, value, 'AVAILABLE', 'IN_USE');
}

/** IN_USE -> AVAILABLE, ONLY after a proven zero-change refusal or rollback. */
export function releasePracticalAcquiredCancel(value: unknown): void {
  PracticalAcquiredCancel.transition(TICKET_ISSUER, value, 'IN_USE', 'AVAILABLE');
}

/** IN_USE -> SPENT after a committed arm (a ticket is minted next). */
export function spendPracticalAcquiredCancel(value: unknown): void {
  PracticalAcquiredCancel.transition(TICKET_ISSUER, value, 'IN_USE', 'SPENT');
}

/** [Wave 2B2b] IN_USE -> ARM_OUTCOME_UNKNOWN when the arm COMMIT could not be confirmed. No ticket is minted. */
export function markPracticalAcquiredCancelArmOutcomeUnknown(value: unknown): void {
  PracticalAcquiredCancel.transition(TICKET_ISSUER, value, 'IN_USE', 'ARM_OUTCOME_UNKNOWN');
}

/**
 * [Wave 2B2b] AVAILABLE | ARM_OUTCOME_UNKNOWN | ABANDON_OUTCOME_UNKNOWN ->
 * ABANDONING. Returns the record and the state it came from (restored on a
 * proven rollback). Synchronous: nothing can interleave between the status
 * read and the transition.
 */
export function beginPracticalAcquiredCancelAbandon(value: unknown): {
  readonly record: PracticalAcquiredCancelRecord;
  readonly from: PracticalAcquiredCancelStatus;
  readonly origin: 'AVAILABLE' | 'ARM_OUTCOME_UNKNOWN';
} {
  return PracticalAcquiredCancel.beginAbandon(TICKET_ISSUER, value);
}

/** [Wave 2B2b] ABANDONING -> SPENT after a committed (or already-durable) abandon. */
export function finishPracticalAcquiredCancelAbandon(value: unknown): void {
  PracticalAcquiredCancel.transition(TICKET_ISSUER, value, 'ABANDONING', 'SPENT');
}

/** [Wave 2B2b] ABANDONING -> the state it came from, ONLY after a proven zero-change rollback. */
export function restorePracticalAcquiredCancelAbandon(value: unknown, from: PracticalAcquiredCancelStatus): void {
  if (!ABANDONABLE.includes(from)) throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'An abandon can only be restored to the state it started from', { status: from });
  PracticalAcquiredCancel.transition(TICKET_ISSUER, value, 'ABANDONING', from);
}

/** [Wave 2B2b] ABANDONING -> ABANDON_OUTCOME_UNKNOWN when the abandon COMMIT could not be confirmed. */
export function markPracticalAcquiredCancelAbandonOutcomeUnknown(value: unknown): void {
  PracticalAcquiredCancel.transition(TICKET_ISSUER, value, 'ABANDONING', 'ABANDON_OUTCOME_UNKNOWN');
}

/**
 * [Wave 2B2b] ARMED -> COMPLETING_NO_WIRE, or COMMIT_UNKNOWN (same reason
 * only) -> COMPLETING_NO_WIRE. Returns the record and the state it came from.
 */
export function beginPracticalArmedCancelNoWireCompletion(value: unknown, reason: string): { readonly record: PracticalArmedCancelRecord; readonly from: PracticalArmedCancelStatus } {
  const from = PracticalArmedCancel.status(value);
  if (from === null) throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'A genuine armed practical cancel is required');
  if (from !== 'ARMED' && from !== 'COMMIT_UNKNOWN') {
    throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', `An armed practical cancel in ${from} cannot be completed`, { status: from });
  }
  const record = PracticalArmedCancel.transition(TICKET_ISSUER, value, from, 'COMPLETING_NO_WIRE', reason);
  return Object.freeze({ record, from });
}

/** [Wave 2B2b] COMPLETING_NO_WIRE -> SPENT after a committed (or already-durable) no-wire completion. */
export function finishPracticalArmedCancelNoWireCompletion(value: unknown): void {
  PracticalArmedCancel.transition(TICKET_ISSUER, value, 'COMPLETING_NO_WIRE', 'SPENT', null);
}

/** [Wave 2B2b] COMPLETING_NO_WIRE -> the state it came from, ONLY after a proven zero-change rollback. */
export function restorePracticalArmedCancel(value: unknown, from: PracticalArmedCancelStatus, reason: string): void {
  if (from !== 'ARMED' && from !== 'COMMIT_UNKNOWN') throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'A completion can only be restored to the state it started from', { status: from });
  PracticalArmedCancel.transition(TICKET_ISSUER, value, 'COMPLETING_NO_WIRE', from, from === 'COMMIT_UNKNOWN' ? reason : null);
}

/** [Wave 2B2b] COMPLETING_NO_WIRE -> COMMIT_UNKNOWN (recording the reason) when the COMMIT could not be confirmed. */
export function markPracticalArmedCancelCommitUnknown(value: unknown, reason: string): void {
  PracticalArmedCancel.transition(TICKET_ISSUER, value, 'COMPLETING_NO_WIRE', 'COMMIT_UNKNOWN', reason);
}

// ----- [Wave 2B2c] the unknown-acquire receipt ---------------------------------

/**
 * Mints the receipt of an acquisition whose COMMIT was unknown and binds it to
 * that exact error object (off the object). Called only by the adapter's
 * acquire, only for a completed ACQUIRED outcome. Never mints a handle.
 */
export function issuePracticalUnknownAcquire(record: PracticalAcquiredCancelRecord, error: PracticalAcquireCommitUnknownError): PracticalUnknownAcquire {
  if (!(error instanceof PracticalAcquireCommitUnknownError) || UNKNOWN_ACQUIRE_RECEIPTS.has(error)) {
    throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'A receipt is bound once, to a genuine unknown-acquire error');
  }
  const receipt = new PracticalUnknownAcquire(TICKET_ISSUER, record);
  UNKNOWN_ACQUIRE_RECEIPTS.set(error, receipt);
  return receipt;
}

/**
 * The receipt of a genuine unknown-acquire error, or null (any other value,
 * including a copy, clone, JSON round-trip, or wrapper of that error).
 */
export function readPracticalUnknownAcquireReceipt(error: unknown): PracticalUnknownAcquire | null {
  if (typeof error !== 'object' || error === null) return null;
  return UNKNOWN_ACQUIRE_RECEIPTS.get(error) ?? null;
}

/**
 * PENDING -> RESOLVING (a full re-proof follows), or ANOMALY_UNESCALATED ->
 * ESCALATING (only the escalation is retried; nothing is read, nothing can be
 * minted). Synchronous: a concurrent second call is refused before any durable access.
 */
export function beginPracticalUnknownAcquireResolution(value: unknown): {
  readonly record: PracticalAcquiredCancelRecord;
  readonly from: 'PENDING' | 'ANOMALY_UNESCALATED';
} {
  const from = PracticalUnknownAcquire.status(value);
  if (from === null) throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'A genuine unknown-acquire receipt is required');
  if (from !== 'PENDING' && from !== 'ANOMALY_UNESCALATED') {
    throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', `An unknown-acquire receipt in ${from} cannot be resolved`, { status: from });
  }
  const record = PracticalUnknownAcquire.transition(TICKET_ISSUER, value, from, from === 'PENDING' ? 'RESOLVING' : 'ESCALATING');
  return Object.freeze({ record, from });
}

/** RESOLVING -> SPENT after a conclusive RESTORED (a handle is minted next) or NOT_COMMITTED. */
export function finishPracticalUnknownAcquireResolution(value: unknown): void {
  PracticalUnknownAcquire.transition(TICKET_ISSUER, value, 'RESOLVING', 'SPENT');
}

/** RESOLVING -> PENDING, ONLY after an INCONCLUSIVE attempt (never after a proven anomaly). */
export function restorePracticalUnknownAcquire(value: unknown): void {
  PracticalUnknownAcquire.transition(TICKET_ISSUER, value, 'RESOLVING', 'PENDING');
}

/**
 * RESOLVING | ESCALATING -> REFUSED (the manual review / malformed latch is
 * confirmed durable) or -> ANOMALY_UNESCALATED (it is not). Either way the
 * receipt is permanently mint-disabled.
 */
export function refusePracticalUnknownAcquire(value: unknown, from: 'RESOLVING' | 'ESCALATING', escalated: boolean): void {
  PracticalUnknownAcquire.transition(TICKET_ISSUER, value, from, escalated ? 'REFUSED' : 'ANOMALY_UNESCALATED');
}
