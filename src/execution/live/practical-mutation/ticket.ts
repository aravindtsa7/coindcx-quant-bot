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
 * ACQUIRED-HANDLE LIFECYCLE. AVAILABLE -> IN_USE (reserved at arm entry,
 * held across internal retries) -> AVAILABLE again after a PROVEN zero-change
 * refusal or rollback, or -> SPENT after a committed arm or an UNKNOWN commit
 * outcome. The in-memory state is a convenience only: the database arm
 * compare-and-set and row locks are the one-shot authority across processes.
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

export type PracticalAcquiredCancelStatus = 'AVAILABLE' | 'IN_USE' | 'SPENT';

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

  public get provesAccountContinuity(): false { return false; }
}
Object.freeze(PracticalAcquiredCancel.prototype);
Object.freeze(PracticalAcquiredCancel);

export class PracticalArmedCancel {
  readonly #record: PracticalArmedCancelRecord;
  #taken = false;

  public constructor(issuer: unknown, record: PracticalArmedCancelRecord) {
    if (issuer !== TICKET_ISSUER) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'An armed practical cancel may only be issued by the Stage 1B2 adapter after a committed arm');
    }
    this.#record = validArmedRecord(record);
    Object.freeze(this);
  }

  /** The record of a GENUINE ticket, or null for clones and structural fakes. */
  public static read(value: unknown): PracticalArmedCancelRecord | null {
    if (typeof value !== 'object' || value === null || !(#record in value)) return null;
    return (value as PracticalArmedCancel).#record;
  }

  public static isTaken(value: unknown): boolean | null {
    if (typeof value !== 'object' || value === null || !(#taken in value)) return null;
    return (value as PracticalArmedCancel).#taken;
  }

  /** Internal one-shot take; only this module holds the issuer. */
  public static take(issuer: unknown, value: unknown): PracticalArmedCancelRecord {
    if (issuer !== TICKET_ISSUER) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'Armed-cancel lifecycle changes are internal to the Stage 1B2 ticket module');
    }
    if (typeof value !== 'object' || value === null || !(#taken in value)) {
      throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'A genuine armed practical cancel is required');
    }
    const ticket = value as PracticalArmedCancel;
    if (ticket.#taken) throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', 'This armed practical cancel was already taken');
    ticket.#taken = true;
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

/** IN_USE -> SPENT after a committed arm, or conservatively after an UNKNOWN commit outcome. */
export function spendPracticalAcquiredCancel(value: unknown): void {
  PracticalAcquiredCancel.transition(TICKET_ISSUER, value, 'IN_USE', 'SPENT');
}

/**
 * One-shot take of an armed ticket, for the LATER (not yet reviewed) mutation
 * service. It has NO production importer in Wave 2B1 (architecture-pinned).
 */
export function takePracticalArmedCancel(value: unknown): PracticalArmedCancelRecord {
  return PracticalArmedCancel.take(TICKET_ISSUER, value);
}
