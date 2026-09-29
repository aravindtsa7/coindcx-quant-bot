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
 * the SAME reason accepts it). There is NO take and NO dispatch state: in
 * Wave 2B2 an ARMED ticket is, by construction, a ticket that was never
 * handed to any gateway. A future, separately reviewed gateway wave must add
 * a durable dispatch-permit boundary; this module grants nothing like it.
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
import { PracticalMutationError } from './ports';

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

export type PracticalArmedCancelStatus = 'ARMED' | 'COMPLETING_NO_WIRE' | 'COMMIT_UNKNOWN' | 'SPENT';

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
  #status: PracticalArmedCancelStatus = 'ARMED';
  /** The NOT_DISPATCHED reason of a completion whose COMMIT was unknown: only the identical retry is accepted. */
  #unknownReason: string | null = null;

  public constructor(issuer: unknown, record: PracticalArmedCancelRecord) {
    if (issuer !== TICKET_ISSUER) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'An armed practical cancel may only be issued by the Stage 1B2 adapter after a committed arm');
    }
    this.#record = validArmedRecord(record);
    Object.freeze(this);
  }

  /** The record of a GENUINE ticket (whatever its status), or null for clones and structural fakes. */
  public static read(value: unknown): PracticalArmedCancelRecord | null {
    if (typeof value !== 'object' || value === null || !(#record in value)) return null;
    return (value as PracticalArmedCancel).#record;
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
    if (ticket.#status !== from) {
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

// ---------------------------------------------------------------------------
// INTERNAL issuing and lifecycle boundary (production importer: the Stage 1B2 adapter ONLY)
// ---------------------------------------------------------------------------

/** Mints the acquired handle. Called only after the acquisition transaction COMMITTED. */
export function issuePracticalAcquiredCancel(record: PracticalAcquiredCancelRecord): PracticalAcquiredCancel {
  return new PracticalAcquiredCancel(TICKET_ISSUER, record);
}

/** Mints the armed ticket. Called only after the arm transaction COMMITTED. */
export function issuePracticalArmedCancel(record: PracticalArmedCancelRecord): PracticalArmedCancel {
  return new PracticalArmedCancel(TICKET_ISSUER, record);
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
