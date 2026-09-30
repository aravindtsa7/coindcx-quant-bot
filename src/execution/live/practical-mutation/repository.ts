/**
 * Phase 18B Stage 1B2 (Wave 2B1): the Prisma/MySQL practical CANCEL
 * mutation store. The ONLY Stage 1B2 Prisma adapter.
 *
 * It composes, inside ONE caller-owned interactive transaction per
 * operation, the reviewed Stage 1B1 practical rows (through the internal
 * `withLockedPracticalAccountWithinCallerTransaction` scope) with the
 * reviewed Phase 17 CANCEL transaction primitives (Wave 2A):
 *
 *   ACQUIRE  practical locks -> live_reconciliation_state -> live_order ->
 *            live_execution_intent -> Phase 17 claim -> certificate CONSUMED +
 *            ONE order-bound CANCEL lease + MUTATING + MUTATION_LEASED -> one COMMIT.
 *   ARM      the same lock order -> Phase 17 cancel wire arm (exact account,
 *            NEVER null) + practical lease armedAtMs -> one COMMIT.
 *   NO-WIRE  [Wave 2B2b] completeUndispatchedCancel / abandonAcquiredCancel:
 *            practical locks -> live_order -> live_execution_intent (NO
 *            live_reconciliation_state) -> the truthful no-wire Phase 17
 *            release (variant derived from the locked coupled durable pair)
 *            + the lease COMPLETED PRE_DISPATCH_FAILURE + fence released ->
 *            one COMMIT. Cleanup of an owned attempt, never mutation
 *            authority; no dispatched outcome exists here.
 *   RESOLVE  [Wave 2B2c] resolveUnknownAcquire: one READ-ONLY transaction
 *            deciding an unknown acquire COMMIT from the locked durable rows.
 *   RECOVER  [Wave 2B2d] recoverPreviousRuntimeCancelLease: a PREVIOUS runtime
 *            epoch's leased fence whose coupled pair is UNARMED -> the same
 *            no-wire release + PRE_DISPATCH_FAILURE completion AND the fence
 *            adopted by this runtime, in one COMMIT. Armed orphans are never
 *            released (evidence + manual review).
 *
 * TIER B ONLY, AND NOT CONTINUITY. The reconciliation-state row is read under
 * lock and compared exactly (see `./preflight.ts`); that is a durable-state
 * consistency check, NOT account continuity. Nothing here calls
 * `requireCurrentReconciliation`, `authorizeCurrentHealthy`, or the strict
 * reconciliation fence, and nothing mints, reads, or forwards a strict
 * reconciliation authorization. The strict Tier-A path is untouched.
 *
 * NO NETWORK, NO GATEWAY, NO WIRING. This module performs no CoinDCX I/O, owns
 * no gateway, transport, or signer, and nothing in production composes it.
 * The armed ticket is not enough to call a gateway: the later service must
 * still run its own private-stream guard immediately after the arm.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { LIVE_CLIENT_ORDER_ID_PATTERN } from '../identity';
import {
  armCancelWireWithinCallerFencedTransaction,
  claimCancelWithinCallerFencedTransaction,
  releaseArmedUndispatchedCancelClaimWithinCallerFencedTransaction,
  releaseUnarmedCancelClaimWithinCallerFencedTransaction,
  type ClaimCancelOutcome,
} from '../repository';
import { readLiveRuntimeEpoch } from '../reconciliation/barrier';
import { PracticalRecoveryCertificate, type PracticalRecoveryCertificateRecord } from '../practical/certificate';
import type { PracticalFenceExpectation } from '../practical/fence';
import { PracticalLiveSafetyEnablement, practicalActionPermission } from '../practical/policy';
import { PRACTICAL_AUTHORIZATION_BASIS, PRACTICAL_DIGEST_PATTERN, isExactId, isNonNegativeSafeInteger } from '../practical/types';
import {
  PracticalDurableContradictionError,
  PracticalPersistenceError,
  type PracticalDurableCertificateRecord,
  type PracticalMalformedEscalation,
  type PracticalMutationLeaseRecord,
} from '../practical-persistence/ports';
import {
  PrismaPracticalSafetyRepository,
  withLockedPracticalAccountWithinCallerTransaction,
  type PracticalLockedAccountScope,
} from '../practical-persistence/repository';
import {
  PRACTICAL_CANCEL_ABANDON_INPUT_KEYS,
  PRACTICAL_CANCEL_ACQUIRE_INPUT_KEYS,
  PRACTICAL_CANCEL_ARM_INPUT_KEYS,
  PRACTICAL_NO_DISPATCH_REASONS,
  PRACTICAL_NOT_DISPATCHED_REPORT_KEYS,
  PRACTICAL_PREVIOUS_RUNTIME_ESCALATING_REASONS,
  PRACTICAL_PREVIOUS_RUNTIME_RECOVERY_INPUT_KEYS,
  PRACTICAL_RECOVERY_REFUSAL_REASONS,
  PRACTICAL_UNDISPATCHED_COMPLETION_INPUT_KEYS,
  PRACTICAL_UNKNOWN_ACQUIRE_RESOLUTION_INPUT_KEYS,
  PracticalAcquireCommitUnknownError,
  PracticalMutationError,
  type PracticalAcquireInvalidationCause,
  type PracticalAcquireInvalidationReason,
  type PracticalCancelAbandonInput,
  type PracticalCancelAcquireInput,
  type PracticalCancelAcquisition,
  type PracticalCancelArm,
  type PracticalCancelArmInput,
  type PracticalCancelMutationStore,
  type PracticalCancelNoWireStore,
  type PracticalNoDispatchReason,
  type PracticalNoWireCompletion,
  type PracticalPreviousRuntimeRecovery,
  type PracticalPreviousRuntimeRecoveryInput,
  type PracticalPreviousRuntimeRecoveryStore,
  type PracticalPreviousRuntimeRefusalReason,
  type PracticalRecoveryRefusalReason,
  type PracticalUndispatchedCompletionInput,
  type PracticalUnknownAcquireCertificateStatus,
  type PracticalUnknownAcquireRecoveryStore,
  type PracticalUnknownAcquireResolution,
  type PracticalUnknownAcquireResolutionInput,
} from './ports';
import {
  classifyPracticalReconciliationMismatch,
  isClassifiedPreWriteClaimFailure,
  practicalCancelDwellMs,
  type PracticalClassifiedPreWriteClaimFailureCode,
} from './preflight';
import {
  beginPracticalAcquiredCancelAbandon,
  beginPracticalArmedCancelNoWireCompletion,
  beginPracticalUnknownAcquireResolution,
  finishPracticalAcquiredCancelAbandon,
  finishPracticalArmedCancelNoWireCompletion,
  finishPracticalUnknownAcquireResolution,
  issuePracticalAcquiredCancel,
  issuePracticalArmedCancel,
  issuePracticalUnknownAcquire,
  markPracticalAcquiredCancelAbandonOutcomeUnknown,
  markPracticalAcquiredCancelArmOutcomeUnknown,
  markPracticalArmedCancelCommitUnknown,
  refusePracticalUnknownAcquire,
  releasePracticalAcquiredCancel,
  reservePracticalAcquiredCancel,
  restorePracticalAcquiredCancelAbandon,
  restorePracticalArmedCancel,
  restorePracticalUnknownAcquire,
  spendPracticalAcquiredCancel,
  PracticalAcquiredCancel,
  PracticalArmedCancel,
  PracticalUnknownAcquire,
  type PracticalAcquiredCancelRecord,
  type PracticalArmedCancelRecord,
} from './ticket';

type Tx = Prisma.TransactionClient;

/** Whole-transaction attempts on a MySQL deadlock / write conflict: the first plus two retries (the Stage 1B1 scope). */
export const PRACTICAL_MUTATION_TRANSACTION_MAX_ATTEMPTS = 3;
/** Interactive transaction timeout (the Stage 1B1 value). */
const TRANSACTION_TIMEOUT_MS = 15_000;
/** MySQL's deadlock victim error number. */
const MYSQL_DEADLOCK = '1213';

// ---------------------------------------------------------------------------
// Transaction failure classification
// ---------------------------------------------------------------------------

/**
 * EXACTLY the Stage 1B1 retry scope: Prisma P2034, or P2010 carrying MySQL
 * 1213 (a deadlock surfaced by a raw locking read). Nothing else is retried:
 * not 1205, not P2028, not P1001/P1017, not unknown errors.
 */
function isRetryableDeadlock(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  if (error.code !== 'P2010') return false;
  const meta = error.meta;
  return meta !== undefined && meta !== null && (meta as Record<string, unknown>)['code'] === MYSQL_DEADLOCK;
}

function isDatabaseError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    || error instanceof Prisma.PrismaClientUnknownRequestError
    || error instanceof Prisma.PrismaClientRustPanicError
    || error instanceof Prisma.PrismaClientInitializationError
    || error instanceof Prisma.PrismaClientValidationError;
}

function databaseCodeOf(error: unknown): string {
  return error instanceof Prisma.PrismaClientKnownRequestError ? error.code : (error as Error).name;
}

// ---------------------------------------------------------------------------
// Input validation (before any durable access)
// ---------------------------------------------------------------------------

function invalidInput(message: string, field: string): never {
  throw new PracticalMutationError('PRACTICAL_MUTATION_INVALID_INPUT', message, { field });
}

function authorityInvalid(message: string, field: string): never {
  throw new PracticalMutationError('PRACTICAL_MUTATION_AUTHORITY_INVALID', message, { field });
}

function requireClosedWorld(input: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalidInput('An input record is required', 'input');
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalidInput('The input must be a plain record', 'input');
  const own = Reflect.ownKeys(input);
  const unexpected = own.filter((key) => typeof key !== 'string' || !keys.includes(key));
  if (unexpected.length > 0) invalidInput('The input carries a key this operation does not accept (no caller action, tier, client order id, lease id, or generation)', 'input');
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) invalidInput(`The input is missing ${key}`, key);
  }
  return input as Readonly<Record<string, unknown>>;
}

function requireAccountId(value: unknown): string {
  if (!isExactId(value) || value.length > 128) invalidInput('accountId must be a non-empty exact string of at most 128 characters', 'accountId');
  return value;
}

function requireIntentId(value: unknown): string {
  if (typeof value !== 'string' || !PRACTICAL_DIGEST_PATTERN.test(value)) invalidInput('intentId must be an exact lowercase 64-hex Phase 17 intent id', 'intentId');
  return value;
}

function requireNowMs(value: unknown): number {
  if (!isNonNegativeSafeInteger(value)) invalidInput('trustedNowMs must be a non-negative safe integer', 'trustedNowMs');
  return value;
}

interface CancelPolicy {
  readonly dwellMs: number;
  readonly lifetimeMs: number;
}

/** A genuine Tier-B enablement for exactly this account, at STAGE_5A_CANCEL_ONLY, permitting CANCEL. */
function requireCancelEnablement(value: unknown, accountId: string): CancelPolicy {
  const enablement = PracticalLiveSafetyEnablement.read(value);
  if (enablement === null) authorityInvalid('A genuine Tier-B enablement is required (configuration data is not authority)', 'enablement');
  if (enablement.stage !== 'STAGE_5A_CANCEL_ONLY') authorityInvalid('Tier B is enabled only at STAGE_5A_CANCEL_ONLY', 'enablement.stage');
  if (!practicalActionPermission(enablement.stage, 'CANCEL').permitted) authorityInvalid('CANCEL is not permitted', 'enablement.stage');
  if (!enablement.accountAllowlist.includes(accountId)) authorityInvalid('Tier B is not enabled for this exact account', 'accountId');
  return Object.freeze({ dwellMs: practicalCancelDwellMs(enablement.ceilings), lifetimeMs: enablement.ceilings.certificateLifetimeMs });
}

function requireRuntimeEpoch(value: unknown): string {
  const epoch = readLiveRuntimeEpoch(value);
  if (epoch === null) authorityInvalid('A genuine runtime identity is required', 'runtimeIdentity');
  return epoch;
}

/** The exact account id the Tier-B arm fences the Phase 17 arm with. Never null, never a variant. */
function requireExactAccountId(value: string, expected: string): string {
  if (!isExactId(value) || value !== expected) {
    throw new PracticalMutationError('PRACTICAL_MUTATION_SELF_CHECK_FAILED', 'The Tier-B arm must be fenced with the exact practical account id', { field: 'accountId' });
  }
  return value;
}

// ---------------------------------------------------------------------------
// Locked Phase 18 / Phase 17 reads (the LOCKING read is the value read)
// ---------------------------------------------------------------------------

/** The locked reconciliation-state row (or null). Mapped ONLY by `classifyPracticalReconciliationMismatch`. */
async function lockReconciliationState(tx: Tx, accountId: string): Promise<unknown> {
  const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT account_id AS accountId, status, current_generation AS currentGeneration,
    current_run_id AS currentRunId, current_runtime_epoch AS currentRuntimeEpoch, healthy_generation AS healthyGeneration,
    blocking_finding_count AS blockingFindingCount
    FROM live_reconciliation_state WHERE account_id = ${accountId} FOR UPDATE`);
  return Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
}

/** The claim/arm columns of a locked Phase 17 order, strictly typed. */
interface LockedPhase17Order {
  readonly intentId: string;
  readonly accountId: string;
  readonly clientOrderId: string;
  readonly pair: string;
  readonly state: string;
  readonly cancelState: string;
  readonly cancelGeneration: number;
  readonly cancelWireArmed: boolean;
  readonly exchangeOrderId: string | null;
  readonly cancelExchangeOrderId: string | null;
  readonly cancelFaultCode: string | null;
  readonly revision: number;
}

function unreadable(field: string): never {
  throw new PracticalMutationError('PRACTICAL_MUTATION_SELF_CHECK_FAILED', 'A locked Phase 17 order row is not readable exactly', { field });
}

function asString(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') unreadable(field);
  return value;
}

function asNullableString(row: Readonly<Record<string, unknown>>, field: string): string | null {
  const value = row[field];
  if (value !== null && typeof value !== 'string') unreadable(field);
  return value;
}

function asInteger(row: Readonly<Record<string, unknown>>, field: string): number {
  const value = row[field];
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) unreadable(field);
  return number;
}

function asBoolean(row: Readonly<Record<string, unknown>>, field: string): boolean {
  const value = row[field];
  if (value === true || value === 1 || value === 1n) return true;
  if (value === false || value === 0 || value === 0n) return false;
  return unreadable(field);
}

/**
 * Locks `live_order` (the locking read is the value read) and then
 * `live_execution_intent`: the established Phase 17 order. Returns null for
 * no row. Never trusts the database collation: every identity is compared
 * by the caller with exact JavaScript equality.
 */
async function lockPhase17Order(tx: Tx, intentId: string): Promise<LockedPhase17Order | null> {
  const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT intent_id AS intentId, account_id AS accountId, client_order_id AS clientOrderId,
    pair, state, cancel_state AS cancelState, cancel_generation AS cancelGeneration, cancel_wire_armed AS cancelWireArmed,
    exchange_order_id AS exchangeOrderId, cancel_exchange_order_id AS cancelExchangeOrderId, cancel_fault_code AS cancelFaultCode, revision
    FROM live_order WHERE intent_id = ${intentId} FOR UPDATE`);
  await tx.$executeRaw(Prisma.sql`SELECT intent_id FROM live_execution_intent WHERE intent_id = ${intentId} FOR UPDATE`);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (rows.length !== 1 || typeof rows[0] !== 'object' || rows[0] === null) unreadable('row');
  const row = rows[0] as Readonly<Record<string, unknown>>;
  return Object.freeze({
    intentId: asString(row, 'intentId'),
    accountId: asString(row, 'accountId'),
    clientOrderId: asString(row, 'clientOrderId'),
    pair: asString(row, 'pair'),
    state: asString(row, 'state'),
    cancelState: asString(row, 'cancelState'),
    cancelGeneration: asInteger(row, 'cancelGeneration'),
    cancelWireArmed: asBoolean(row, 'cancelWireArmed'),
    exchangeOrderId: asNullableString(row, 'exchangeOrderId'),
    cancelExchangeOrderId: asNullableString(row, 'cancelExchangeOrderId'),
    cancelFaultCode: asNullableString(row, 'cancelFaultCode'),
    revision: asInteger(row, 'revision'),
  });
}

/**
 * The durable NO-WRITE proof, independent of the source-order pin: the
 * claim's only UPDATE always steps `revision` and moves `cancel_state` off
 * NONE, and only this transaction can write the row (it holds the lock; a
 * locking read is a current read that sees this transaction's own writes).
 * Every claim column must equal the pre-claim locked snapshot exactly, or the
 * ORIGINAL failure is rethrown and the whole transaction rolls back.
 */
async function requirePhase17Untouched(tx: Tx, intentId: string, before: LockedPhase17Order, original: unknown): Promise<void> {
  const after = await lockPhase17Order(tx, intentId);
  const untouched = after !== null
    && after.intentId === before.intentId
    && after.accountId === before.accountId
    && after.clientOrderId === before.clientOrderId
    && after.revision === before.revision
    && after.state === before.state
    && after.cancelState === before.cancelState
    && after.cancelGeneration === before.cancelGeneration
    && after.cancelWireArmed === before.cancelWireArmed
    && after.cancelExchangeOrderId === before.cancelExchangeOrderId
    && after.cancelFaultCode === before.cancelFaultCode;
  if (untouched) return;
  if (original !== null) throw original;
  throw new PracticalMutationError('PRACTICAL_MUTATION_SELF_CHECK_FAILED', 'The Phase 17 order changed although the claim reported no write', { field: 'live_order' });
}

// ---------------------------------------------------------------------------
// Results of one transaction attempt (plain data; authority is minted only after COMMIT)
// ---------------------------------------------------------------------------

type AcquireOutcome =
  | { readonly kind: 'ACQUIRED'; readonly record: PracticalAcquiredCancelRecord }
  | { readonly kind: 'CERTIFICATE_TERMINATED'; readonly certificateId: string; readonly status: 'EXPIRED' | 'REVOKED' }
  | {
      readonly kind: 'AUTHORITY_INVALIDATED';
      readonly certificateId: string;
      readonly reason: PracticalAcquireInvalidationReason;
      readonly cause: PracticalAcquireInvalidationCause;
      readonly phase17Code: PracticalClassifiedPreWriteClaimFailureCode | null;
    };

interface AcquireContext {
  readonly accountId: string;
  readonly expected: unknown;
  readonly certificate: unknown;
  readonly presented: PracticalRecoveryCertificateRecord;
  readonly intentId: string;
  readonly epoch: string;
  readonly nowMs: number;
  readonly policy: CancelPolicy;
}

interface ArmContext {
  readonly handle: PracticalAcquiredCancelRecord;
  readonly epoch: string;
  readonly nowMs: number;
  readonly policy: CancelPolicy;
}

/** How one store transaction ended, so the caller can tell a PROVEN rollback from an unknown commit. */
class TransactionOutcomeUnknown extends Error {
  /** [Wave 2B2c] The value `work` completed with: exactly what the uncertain COMMIT would have made durable. */
  public readonly completed: unknown;

  public constructor(completed: unknown, cause: unknown) {
    super('commit outcome unknown', { cause });
    this.completed = completed;
  }
}

function armRefused(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new PracticalMutationError('PRACTICAL_MUTATION_ARM_REFUSED', message, details);
}

function selfCheckFailed(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new PracticalMutationError('PRACTICAL_MUTATION_SELF_CHECK_FAILED', message, details);
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// [Wave 2B2b] No-wire completion / abandon context and refusals
// ---------------------------------------------------------------------------

/**
 * Which owned attempt is being closed. It only PERMITS arm states; the release
 * variant itself is always DERIVED from the locked, coupled durable pair.
 *   ARMED_TICKET        a genuine ticket that was never dispatched: the durable pair must be armed.
 *   ABANDON_AVAILABLE   a handle whose arm never committed: the durable pair must be unarmed.
 *   ABANDON_ARM_UNKNOWN a handle whose arm COMMIT was unknown: either coupled pair (no ticket ever existed).
 */
type NoWireMode = 'ARMED_TICKET' | 'ABANDON_AVAILABLE' | 'ABANDON_ARM_UNKNOWN';

interface NoWireContext {
  readonly mode: NoWireMode;
  /** An identical retry after an unknown commit: an already-durable identical completion is ALREADY_COMPLETED. */
  readonly retry: boolean;
  readonly accountId: string;
  readonly leaseId: string;
  readonly certificateId: string;
  readonly runtimeEpoch: string;
  readonly reconciliationGeneration: number;
  readonly intentId: string;
  readonly clientOrderId: string;
  readonly cancelGeneration: number;
  readonly pair: string;
  readonly exchangeOrderId: string;
  /** ARMED_TICKET only: the exact durable arm instant the ticket was minted from. */
  readonly expectedArmedAtMs: number | null;
  /** Abandon only: the exact lease creation instant the handle was minted from. */
  readonly expectedLeaseCreatedAtMs: number | null;
  readonly certificateMatches: (certificate: PracticalDurableCertificateRecord) => boolean;
  readonly nowMs: number;
}

type NoWireOutcome = { readonly kind: 'COMPLETED' | 'ALREADY_COMPLETED' };

function completionRefused(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new PracticalMutationError('PRACTICAL_MUTATION_COMPLETION_REFUSED', message, details);
}

function splitState(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new PracticalMutationError('PRACTICAL_MUTATION_SPLIT_STATE', message, details);
}

function alreadyCompleted(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new PracticalMutationError('PRACTICAL_MUTATION_ALREADY_COMPLETED', message, details);
}

/** The ONLY completion report accepted: exactly { kind: 'NOT_DISPATCHED', reason } with a closed reason. */
function requireNotDispatchedReport(value: unknown): PracticalNoDispatchReason {
  const report = requireClosedWorld(value, PRACTICAL_NOT_DISPATCHED_REPORT_KEYS);
  if (report['kind'] !== 'NOT_DISPATCHED') invalidInput('Only a NOT_DISPATCHED report is accepted (no dispatched outcome exists in this store)', 'report.kind');
  const reason = report['reason'];
  if (typeof reason !== 'string' || !(PRACTICAL_NO_DISPATCH_REASONS as readonly string[]).includes(reason)) invalidInput('The not-dispatched reason is not one of the closed reasons', 'report.reason');
  return reason as PracticalNoDispatchReason;
}

/** The certificate's IMMUTABLE issuance identity, exact on every field (whatever its status). */
function sameCertificateIdentity(durable: PracticalDurableCertificateRecord, snapshot: PracticalAcquiredCancelRecord['certificate']): boolean {
  return durable.certificateId === snapshot.certificateId
    && durable.accountId === snapshot.accountId
    && durable.providerAccountFingerprint === snapshot.providerAccountFingerprint
    && durable.runtimeEpoch === snapshot.runtimeEpoch
    && durable.reconciliationGeneration === snapshot.reconciliationGeneration
    && durable.streamIncarnation === snapshot.streamIncarnation
    && durable.evidenceDigest === snapshot.evidenceDigest
    && durable.issuedAtMs === snapshot.issuedAtMs
    && durable.expiresAtMs === snapshot.expiresAtMs;
}

function sameCertificateSnapshot(durable: PracticalDurableCertificateRecord, snapshot: PracticalAcquiredCancelRecord['certificate']): boolean {
  return sameCertificateIdentity(durable, snapshot)
    && durable.status === 'CONSUMED'
    && durable.terminalAtMs === snapshot.consumedAtMs
    && durable.terminalReason === null;
}

// ---------------------------------------------------------------------------
// [Wave 2B2c] Unknown-acquire resolution
// ---------------------------------------------------------------------------

/** What the read-only resolution transaction concluded. The handle itself is minted only after COMMIT. */
type ResolveOutcome =
  | { readonly kind: 'RESTORED' }
  | { readonly kind: 'NOT_COMMITTED'; readonly certificateStatus: PracticalUnknownAcquireCertificateStatus };

/** The account states whose leased fence may still hold a restorable attempted lease (the no-wire set). */
const RESTORABLE_ACCOUNT_STATES: readonly string[] = Object.freeze(['MUTATING', 'QUARANTINED', 'MANUAL_REVIEW_REQUIRED']);

/** A proven anomaly, thrown inside the read-only transaction (it only rolls back). Mapped after the rollback. */
function recoveryAnomaly(reason: PracticalRecoveryRefusalReason, leaseId: string): never {
  throw new PracticalMutationError('PRACTICAL_MUTATION_RECOVERY_REFUSED', 'The attempted acquisition is not exactly restorable', { reason, leaseId });
}

/** The final refusal of a proven anomaly, after the rollback and the escalation attempt. No handle, no closure asserted. */
function recoveryRefused(
  reason: PracticalRecoveryRefusalReason,
  record: PracticalAcquiredCancelRecord,
  escalation: { readonly confirmed: boolean; readonly reviewEpisodeId: string | null },
  cause: unknown,
): PracticalMutationError {
  return new PracticalMutationError(
    'PRACTICAL_MUTATION_RECOVERY_REFUSED',
    'The unknown acquisition is an anomaly: no handle was minted, no closure is asserted, and the receipt can never mint',
    { accountId: record.accountId, leaseId: record.leaseId, reason, escalated: escalation.confirmed, reviewEpisodeId: escalation.reviewEpisodeId },
    cause,
  );
}

/** [Wave 2B2d] A previous-runtime recovery refusal (thrown inside the transaction, or after it for a mapped conflict). */
function leaseRecoveryRefused(reason: PracticalPreviousRuntimeRefusalReason, accountId: string, cause?: unknown): never {
  throw new PracticalMutationError('PRACTICAL_MUTATION_RECOVERY_REFUSED', 'The previous-runtime leased fence is not a recoverable coupled UNARMED pair', {
    accountId, reason,
  }, cause);
}

function isEscalatingLeaseRecoveryRefusal(error: unknown): boolean {
  if (!(error instanceof PracticalMutationError) || error.code !== 'PRACTICAL_MUTATION_RECOVERY_REFUSED') return false;
  const reason = error.details?.['reason'];
  return typeof reason === 'string' && (PRACTICAL_PREVIOUS_RUNTIME_ESCALATING_REASONS as readonly string[]).includes(reason);
}

/** [Wave 2B2d] No escalation was attempted (and none is needed): the refusal is explained by an epoch-fenced reviewed actor. */
const NOT_ESCALATED = Object.freeze({ confirmed: false, reviewEpisodeId: null });

/** [Wave 2B2d] The receipt's account was adopted by another runtime epoch (thrown inside the read-only transaction). */
function runtimeSuperseded(leaseId: string): never {
  throw new PracticalMutationError('PRACTICAL_MUTATION_RECOVERY_REFUSED', 'The account was adopted by another runtime epoch: this old-epoch receipt is superseded', {
    reason: 'RUNTIME_SUPERSEDED', leaseId,
  });
}

function isRuntimeSuperseded(error: unknown): boolean {
  return error instanceof PracticalMutationError && error.code === 'PRACTICAL_MUTATION_RECOVERY_REFUSED' && error.details?.['reason'] === 'RUNTIME_SUPERSEDED';
}

/** The attempted lease, exact on every immutable field of the intended record (the arm and completion state are checked separately). */
function sameAttemptedLease(lease: PracticalMutationLeaseRecord, record: PracticalAcquiredCancelRecord): boolean {
  const binding = lease.orderBinding;
  return lease.leaseId === record.leaseId
    && lease.accountId === record.accountId
    && lease.certificateId === record.certificate.certificateId
    && lease.action === 'CANCEL'
    && lease.runtimeEpoch === record.runtimeEpoch
    && lease.reconciliationGeneration === record.reconciliationGeneration
    && lease.createdAtMs === record.leaseCreatedAtMs
    && binding !== null
    && binding.intentId === record.intentId
    && binding.clientOrderId === record.clientOrderId
    && binding.cancelGeneration === record.cancelGeneration;
}

/** The fence names exactly the attempted lease and certificate. */
function fenceNamesAttempt(fence: PracticalLockedAccountScope['account']['fence'], record: PracticalAcquiredCancelRecord): boolean {
  return fence.mode.kind === 'MUTATION_LEASED'
    && fence.mode.leaseId === record.leaseId
    && fence.mode.certificateId === record.certificate.certificateId
    && fence.mode.action === 'CANCEL'
    && fence.accountId === record.accountId
    && fence.runtimeEpoch === record.runtimeEpoch
    && fence.reconciliationGeneration === record.reconciliationGeneration;
}

/**
 * INCONCLUSIVE failures of the read-only resolution: a database fault or an
 * exhausted deadlock retry (which include a lock-wait timeout while the
 * original COMMIT is still in flight). Nothing was proven; the receipt may be
 * resolved again. EVERYTHING else a resolution throws is a proven anomaly.
 */
function isInconclusiveResolution(error: unknown): boolean {
  return error instanceof PracticalMutationError && error.code === 'PRACTICAL_MUTATION_FAULT';
}

/** The refusal reason of a proven anomaly: the classified reason, or an unreadable account / row. */
function refusalReasonOf(error: unknown): PracticalRecoveryRefusalReason {
  if (error instanceof PracticalMutationError && error.code === 'PRACTICAL_MUTATION_RECOVERY_REFUSED') {
    const reason = error.details?.['reason'];
    if (typeof reason === 'string' && (PRACTICAL_RECOVERY_REFUSAL_REASONS as readonly string[]).includes(reason)) return reason as PracticalRecoveryRefusalReason;
  }
  return 'ACCOUNT_UNREADABLE';
}

export class PrismaPracticalCancelMutationStore implements PracticalCancelMutationStore, PracticalCancelNoWireStore, PracticalUnknownAcquireRecoveryStore, PracticalPreviousRuntimeRecoveryStore {
  readonly #prisma: PrismaClient;
  readonly #practical: PrismaPracticalSafetyRepository;

  public constructor(prisma: PrismaClient, newId?: () => string) {
    this.#prisma = prisma;
    // The SAME root client: the practical scope only ever runs inside this store's own transactions.
    this.#practical = new PrismaPracticalSafetyRepository(this.#prisma, newId);
  }

  /**
   * One fresh interactive transaction per attempt; the WHOLE attempt is
   * retried (all locks re-taken, all checks repeated, nothing reused) only on
   * the Stage 1B1 deadlock scope. A failure after `work` completed means the
   * COMMIT failed or could not be confirmed: TransactionOutcomeUnknown. Any
   * other failure means `work` threw, so no COMMIT was ever issued: a PROVEN
   * rollback. No compensation, revocation, or invalidation ever follows a
   * database failure.
   */
  async #transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      let workCompleted = false;
      let completedValue: T | undefined;
      try {
        return await this.#prisma.$transaction(async (tx) => {
          const value = await work(tx);
          completedValue = value;
          workCompleted = true;
          return value;
        }, { timeout: TRANSACTION_TIMEOUT_MS });
      } catch (error) {
        if (workCompleted) throw new TransactionOutcomeUnknown(completedValue, error);
        if (isRetryableDeadlock(error)) {
          if (attempt >= PRACTICAL_MUTATION_TRANSACTION_MAX_ATTEMPTS) {
            throw new PracticalMutationError('PRACTICAL_MUTATION_FAULT', 'The practical mutation transaction kept failing on a database conflict; nothing was committed', { attempts: attempt }, error);
          }
          continue;
        }
        if (isDatabaseError(error)) {
          throw new PracticalMutationError('PRACTICAL_MUTATION_FAULT', 'A database error rolled the practical mutation transaction back; nothing was committed', { databaseCode: databaseCodeOf(error) }, error);
        }
        throw error;
      }
    }
  }

  // ----- acquire ---------------------------------------------------------------

  public async acquireCancelLease(input: PracticalCancelAcquireInput): Promise<PracticalCancelAcquisition> {
    // A. Before any durable access: closed-world input and genuine authority only.
    const raw = requireClosedWorld(input, PRACTICAL_CANCEL_ACQUIRE_INPUT_KEYS);
    const accountId = requireAccountId(raw['accountId']);
    const intentId = requireIntentId(raw['intentId']);
    const nowMs = requireNowMs(raw['trustedNowMs']);
    const policy = requireCancelEnablement(raw['enablement'], accountId);
    const epoch = requireRuntimeEpoch(raw['runtimeIdentity']);
    const presented = PracticalRecoveryCertificate.read(raw['certificate']);
    if (presented === null) authorityInvalid('A genuine Stage 1A practical recovery certificate is required', 'certificate');
    if (PracticalRecoveryCertificate.status(raw['certificate'] as PracticalRecoveryCertificate) !== 'ISSUED') authorityInvalid('The certificate is not ISSUED', 'certificate');
    if (presented.basis !== PRACTICAL_AUTHORIZATION_BASIS || presented.provesAccountContinuity !== false) authorityInvalid('Only a PRACTICAL_RECOVERY certificate that proves no continuity is accepted', 'certificate');
    if (presented.accountId !== accountId) authorityInvalid('The certificate belongs to a different account', 'certificate.accountId');
    if (presented.runtimeEpoch !== epoch) authorityInvalid('The certificate was issued under a different runtime epoch than this process', 'certificate.runtimeEpoch');
    const context: AcquireContext = Object.freeze({
      accountId, expected: raw['expected'], certificate: raw['certificate'], presented, intentId, epoch, nowMs, policy,
    });

    let outcome: AcquireOutcome;
    try {
      outcome = await this.#transaction((tx) => this.#acquireWithin(tx, context));
    } catch (error) {
      if (error instanceof TransactionOutcomeUnknown) {
        // The unchanged throw contract (same code, details exactly { accountId }, no handle). [Wave 2B2c] For a
        // completed ACQUIRED outcome, a single-use receipt of the exact intended record is bound OFF the error.
        const unknownCommit = new PracticalAcquireCommitUnknownError(accountId, error.cause);
        const completed = error.completed as AcquireOutcome | undefined;
        if (completed !== undefined && completed.kind === 'ACQUIRED') issuePracticalUnknownAcquire(completed.record, unknownCommit);
        throw unknownCommit;
      }
      return this.#latchIfMalformed(error, accountId, epoch, nowMs);
    }
    // C. ONLY AFTER COMMIT.
    if (outcome.kind === 'ACQUIRED') return Object.freeze({ kind: 'ACQUIRED' as const, acquired: issuePracticalAcquiredCancel(outcome.record) });
    return Object.freeze(outcome);
  }

  /** B. The ONE acquisition transaction. Every statement uses `tx`. */
  async #acquireWithin(tx: Tx, context: AcquireContext): Promise<AcquireOutcome> {
    const { accountId, intentId, nowMs, epoch, policy } = context;
    return withLockedPracticalAccountWithinCallerTransaction(this.#practical, tx, accountId, async (scope) => {
      // 1. The Stage 1B1 one-shot validation (practical locks already taken by the hook).
      const prepared = await scope.prepareCancelConsumption({
        // The scope validates the expectation itself (exact account; the fence CAS checks every field).
        expected: context.expected as PracticalFenceExpectation, certificate: context.certificate, trustedNowMs: nowMs,
      });
      if (prepared.kind === 'CERTIFICATE_TERMINATED') {
        const status = prepared.certificate.status;
        if (status !== 'EXPIRED' && status !== 'REVOKED') selfCheckFailed('The terminated certificate is neither EXPIRED nor REVOKED', { accountId });
        return Object.freeze({ kind: 'CERTIFICATE_TERMINATED' as const, certificateId: prepared.certificate.certificateId, status });
      }
      const preparation = prepared.preparation;
      const durable = preparation.certificate;
      const invalidated = async (
        reason: PracticalAcquireInvalidationReason,
        cause: PracticalAcquireInvalidationCause,
        phase17Code: PracticalClassifiedPreWriteClaimFailureCode | null,
      ): Promise<AcquireOutcome> => {
        await scope.invalidateBeforeConsumption(preparation, reason);
        return Object.freeze({ kind: 'AUTHORITY_INVALIDATED' as const, certificateId: durable.certificateId, reason, cause, phase17Code });
      };

      // 2. D: the tightened effective lifetime, decided BEFORE the reconciliation read.
      if (nowMs >= durable.issuedAtMs + policy.lifetimeMs) return invalidated('CONFIG_CHANGED', 'EFFECTIVE_LIFETIME_EXCEEDED', null);
      // 3. Dwell: too early is a zero-change refusal (the certificate stays usable later).
      if (nowMs < durable.issuedAtMs + policy.dwellMs) {
        throw new PracticalMutationError('PRACTICAL_MUTATION_DWELL_NOT_ELAPSED', 'The quiet dwell after certificate issuance has not elapsed', { certificateId: durable.certificateId });
      }

      // 4. Phase 18 reconciliation state, locked; mapped ONLY by the pure classifier.
      const reconciliation = await lockReconciliationState(tx, accountId);
      const mismatch = classifyPracticalReconciliationMismatch(reconciliation, {
        accountId, runtimeEpoch: epoch, reconciliationGeneration: durable.reconciliationGeneration,
      });
      if (mismatch !== null) return invalidated(mismatch, 'RECONCILIATION_STATE_MISMATCH', null);

      // 5. Phase 17 rows in the established order; exact-case identity pre-check.
      const before = await lockPhase17Order(tx, intentId);
      if (before === null
        || before.intentId !== intentId
        || before.accountId !== accountId
        || !LIVE_CLIENT_ORDER_ID_PATTERN.test(before.clientOrderId)) {
        return invalidated('PREFLIGHT_MISMATCH', 'PHASE17_ORDER_MISMATCH', null);
      }

      // 6. The reviewed Phase 17 claim. The ONLY try/catch around a Phase 17 call in this module.
      let claim: ClaimCancelOutcome;
      try {
        claim = await claimCancelWithinCallerFencedTransaction(tx, intentId, accountId);
      } catch (error) {
        if (!isClassifiedPreWriteClaimFailure(error)) throw error;
        await requirePhase17Untouched(tx, intentId, before, error);
        return invalidated('PREFLIGHT_MISMATCH', 'PHASE17_CLAIM_REFUSED', error.code);
      }
      if (claim.kind !== 'CLAIMED') {
        await requirePhase17Untouched(tx, intentId, before, null);
        return invalidated('PREFLIGHT_MISMATCH', claim.kind === 'NOT_CANCELLABLE' ? 'PHASE17_NOT_CANCELLABLE' : 'PHASE17_ALREADY_CLAIMED', null);
      }

      // 7. The verified post-claim order must be exactly the claim of exactly this order.
      const claimed = claim.order;
      const exchangeOrderId = claimed.exchangeOrderId;
      if (claimed.intentId !== intentId
        || claimed.accountId !== accountId
        || claimed.clientOrderId !== before.clientOrderId
        || claimed.pair !== before.pair
        || claimed.state !== 'CANCEL_REQUESTED'
        || claimed.cancelState !== 'CANCEL_RESERVED'
        || claimed.cancelWireArmed !== false
        || claimed.cancelGeneration !== claim.generation
        || claim.generation !== before.cancelGeneration + 1
        || claimed.revision !== before.revision + 1
        || exchangeOrderId === null
        || claimed.cancelExchangeOrderId !== exchangeOrderId) {
        selfCheckFailed('The Phase 17 claim did not produce exactly the expected CANCEL_RESERVED order', { intentId });
      }

      // 8. Binding ONLY from the verified claimed order; then consume + ONE order-bound CANCEL lease.
      const leased = await scope.consumeIntoOrderBoundCancelLease(preparation, {
        intentId, clientOrderId: claimed.clientOrderId, cancelGeneration: claim.generation,
      });
      const consumed = leased.certificate;
      if (!samePresentedCertificate(consumed, context.presented)
        || consumed.status !== 'CONSUMED'
        || consumed.terminalReason !== null
        || consumed.terminalAtMs !== nowMs
        || leased.lease.createdAtMs !== nowMs
        || leased.lease.armedAtMs !== null) {
        selfCheckFailed('The consumed certificate and the new lease did not re-read exactly', { intentId });
      }

      // 9. Phase 17 re-read under lock: the claim is still exactly what the lease is bound to.
      const after = await lockPhase17Order(tx, intentId);
      if (after === null
        || after.intentId !== intentId
        || after.accountId !== accountId
        || after.clientOrderId !== claimed.clientOrderId
        || after.pair !== claimed.pair
        || after.cancelState !== 'CANCEL_RESERVED'
        || after.cancelWireArmed !== false
        || after.cancelGeneration !== claim.generation
        || after.revision !== claimed.revision
        || after.exchangeOrderId !== exchangeOrderId
        || after.cancelExchangeOrderId !== exchangeOrderId) {
        selfCheckFailed('The Phase 17 order did not re-read as exactly the bound claim', { intentId });
      }

      const record: PracticalAcquiredCancelRecord = {
        accountId,
        leaseId: leased.lease.leaseId,
        action: 'CANCEL',
        runtimeEpoch: leased.lease.runtimeEpoch,
        reconciliationGeneration: leased.lease.reconciliationGeneration,
        leaseCreatedAtMs: leased.lease.createdAtMs,
        intentId,
        clientOrderId: claimed.clientOrderId,
        cancelGeneration: claim.generation,
        pair: claimed.pair,
        exchangeOrderId: exchangeOrderId as string,
        orderRevisionAfterClaim: claimed.revision,
        certificate: {
          certificateId: consumed.certificateId,
          accountId: consumed.accountId,
          providerAccountFingerprint: consumed.providerAccountFingerprint,
          runtimeEpoch: consumed.runtimeEpoch,
          reconciliationGeneration: consumed.reconciliationGeneration,
          streamIncarnation: consumed.streamIncarnation,
          evidenceDigest: consumed.evidenceDigest,
          issuedAtMs: consumed.issuedAtMs,
          expiresAtMs: consumed.expiresAtMs,
          status: 'CONSUMED',
          consumedAtMs: consumed.terminalAtMs as number,
          terminalReason: null,
          basis: PRACTICAL_AUTHORIZATION_BASIS,
          provesAccountContinuity: false,
        },
        acquiredAtMs: nowMs,
      };
      return Object.freeze({ kind: 'ACQUIRED' as const, record });
    });
  }

  // ----- arm -------------------------------------------------------------------

  public async armCancelLease(input: PracticalCancelArmInput): Promise<PracticalCancelArm> {
    // A. Before any durable access. The handle is only READ here; it is reserved just before the transaction.
    const raw = requireClosedWorld(input, PRACTICAL_CANCEL_ARM_INPUT_KEYS);
    const acquired = raw['acquired'];
    const record = PracticalAcquiredCancel.read(acquired);
    if (record === null) authorityInvalid('A genuine acquired practical cancel is required', 'acquired');
    if (PracticalAcquiredCancel.status(acquired) !== 'AVAILABLE') authorityInvalid('The acquired practical cancel is in use or spent', 'acquired');
    if (record.certificate.basis !== PRACTICAL_AUTHORIZATION_BASIS || record.certificate.provesAccountContinuity !== false || record.action !== 'CANCEL') {
      authorityInvalid('The acquired practical cancel does not carry the practical-recovery literals', 'acquired');
    }
    const nowMs = requireNowMs(raw['trustedNowMs']);
    const policy = requireCancelEnablement(raw['enablement'], record.accountId);
    const epoch = requireRuntimeEpoch(raw['runtimeIdentity']);
    if (epoch !== record.runtimeEpoch) authorityInvalid('The acquired practical cancel belongs to a different runtime epoch than this process', 'runtimeIdentity');
    const context: ArmContext = Object.freeze({ handle: record, epoch, nowMs, policy });

    // IN_USE across every internal retry; released ONLY after a proven rollback, spent after COMMIT, ARM_OUTCOME_UNKNOWN after an unknown commit.
    reservePracticalAcquiredCancel(acquired);
    let armedRecord: PracticalArmedCancelRecord;
    try {
      armedRecord = await this.#transaction((tx) => this.#armWithin(tx, context));
    } catch (error) {
      if (error instanceof TransactionOutcomeUnknown) {
        // [Wave 2B2b] No ticket is minted, so no gateway call can follow. The durable arm may or may not have
        // committed; only `abandonAcquiredCancel` accepts this handle, and it decides from the locked durable pair.
        markPracticalAcquiredCancelArmOutcomeUnknown(acquired);
        throw new PracticalMutationError('PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN', 'The arm COMMIT could not be confirmed; no ticket was minted and the handle is ARM_OUTCOME_UNKNOWN (only an abandon accepts it)', { leaseId: record.leaseId }, error.cause);
      }
      // `work` threw, so no COMMIT was issued: a proven zero-change rollback. The handle stays usable.
      releasePracticalAcquiredCancel(acquired);
      const latched = await this.#latchIfMalformed(error, record.accountId, epoch, nowMs);
      throw new PracticalPersistenceError('PRACTICAL_PERSISTENCE_LATCHED', 'The account was latched in malformed-state manual review; nothing was armed', {
        accountId: record.accountId, reviewEpisodeId: latched.reviewEpisodeId,
      });
    }
    // C. ONLY AFTER COMMIT: spend the acquired handle, then mint the ticket.
    spendPracticalAcquiredCancel(acquired);
    return Object.freeze({ kind: 'ARMED' as const, ticket: issuePracticalArmedCancel(armedRecord) });
  }

  /** B. The ONE arm transaction. Every statement uses `tx`. */
  async #armWithin(tx: Tx, context: ArmContext): Promise<PracticalArmedCancelRecord> {
    const { handle, nowMs, epoch, policy } = context;
    return withLockedPracticalAccountWithinCallerTransaction(this.#practical, tx, handle.accountId, async (scope: PracticalLockedAccountScope) => {
      // 1-2. Exact armable account / fence / lease and the FULL certificate snapshot re-proof (practical locks held).
      const { lease, certificate } = await scope.requireArmableOrderBoundCancelLease({
        leaseId: handle.leaseId,
        runtimeEpoch: handle.runtimeEpoch,
        reconciliationGeneration: handle.reconciliationGeneration,
        leaseCreatedAtMs: handle.leaseCreatedAtMs,
        binding: { intentId: handle.intentId, clientOrderId: handle.clientOrderId, cancelGeneration: handle.cancelGeneration },
        certificate: {
          certificateId: handle.certificate.certificateId,
          accountId: handle.certificate.accountId,
          providerAccountFingerprint: handle.certificate.providerAccountFingerprint,
          runtimeEpoch: handle.certificate.runtimeEpoch,
          reconciliationGeneration: handle.certificate.reconciliationGeneration,
          streamIncarnation: handle.certificate.streamIncarnation,
          evidenceDigest: handle.certificate.evidenceDigest,
          issuedAtMs: handle.certificate.issuedAtMs,
          expiresAtMs: handle.certificate.expiresAtMs,
          consumedAtMs: handle.certificate.consumedAtMs,
        },
      });

      // 3. Time: the same dwell, inside min(durable expiry, issuance + configured lifetime), not before the lease.
      if (nowMs < certificate.issuedAtMs + policy.dwellMs
        || nowMs >= Math.min(certificate.expiresAtMs, certificate.issuedAtMs + policy.lifetimeMs)
        || nowMs < lease.createdAtMs) {
        armRefused('The arm is outside the certificate dwell / lifetime window', { leaseId: handle.leaseId });
      }

      // 4. Phase 18 reconciliation state, locked; the same pure classifier. Any mismatch: zero change.
      const reconciliation = await lockReconciliationState(tx, handle.accountId);
      const mismatch = classifyPracticalReconciliationMismatch(reconciliation, {
        accountId: handle.accountId, runtimeEpoch: epoch, reconciliationGeneration: lease.reconciliationGeneration,
      });
      if (mismatch !== null) armRefused('The reconciliation state no longer matches the lease', { leaseId: handle.leaseId, reason: mismatch });

      // 5. Phase 17 rows in the established order; exact-case identity and claim ownership.
      const before = await lockPhase17Order(tx, handle.intentId);
      if (before === null
        || before.intentId !== handle.intentId
        || before.accountId !== handle.accountId
        || before.clientOrderId !== handle.clientOrderId
        || before.pair !== handle.pair
        || before.cancelGeneration !== handle.cancelGeneration
        || before.cancelState !== 'CANCEL_RESERVED'
        || before.cancelWireArmed !== false
        || before.exchangeOrderId === null
        || before.exchangeOrderId !== handle.exchangeOrderId
        || before.cancelExchangeOrderId !== handle.exchangeOrderId
        || before.revision !== handle.orderRevisionAfterClaim) {
        armRefused('The Phase 17 order is not exactly the unarmed claim this lease is bound to', { leaseId: handle.leaseId });
      }

      // 6. The reviewed Phase 17 arm, fenced with the EXACT practical account id (never null).
      const armed = await armCancelWireWithinCallerFencedTransaction(tx, handle.intentId, handle.orderRevisionAfterClaim, requireExactAccountId(lease.accountId, handle.accountId));

      // 7. The practical lease, armed once under the complete-binding CAS (+ strict re-read, certificate re-proof).
      const practical = await scope.armOrderBoundCancelLease(nowMs);

      // 8. BOTH durable sides re-proven before COMMIT.
      const after = await lockPhase17Order(tx, handle.intentId);
      const bothArmed = armed.intentId === handle.intentId
        && armed.accountId === handle.accountId
        && armed.clientOrderId === handle.clientOrderId
        && armed.pair === handle.pair
        && armed.cancelState === 'CANCEL_RESERVED'
        && armed.cancelWireArmed === true
        && armed.cancelGeneration === handle.cancelGeneration
        && armed.revision === handle.orderRevisionAfterClaim + 1
        && armed.exchangeOrderId === handle.exchangeOrderId
        && armed.cancelExchangeOrderId === handle.exchangeOrderId
        && after !== null
        && after.cancelWireArmed === true
        && after.cancelState === 'CANCEL_RESERVED'
        && after.cancelGeneration === handle.cancelGeneration
        && after.revision === handle.orderRevisionAfterClaim + 1
        && practical.lease.armedAtMs === nowMs
        && practical.lease.leaseId === handle.leaseId
        && practical.certificate.certificateId === handle.certificate.certificateId
        && practical.account.state === 'MUTATING';
      if (!bothArmed) selfCheckFailed('The practical lease and the Phase 17 claim did not both re-read as armed exactly once', { leaseId: handle.leaseId });

      return {
        accountId: handle.accountId,
        leaseId: handle.leaseId,
        certificateId: handle.certificate.certificateId,
        intentId: handle.intentId,
        clientOrderId: handle.clientOrderId,
        cancelGeneration: handle.cancelGeneration,
        exchangeOrderId: handle.exchangeOrderId,
        pair: handle.pair,
        orderRevisionAfterArm: armed.revision,
        runtimeEpoch: handle.runtimeEpoch,
        reconciliationGeneration: handle.reconciliationGeneration,
        certificateStreamIncarnation: practical.certificate.streamIncarnation,
        certificateExpiresAtMs: practical.certificate.expiresAtMs,
        armedAtMs: nowMs,
        action: 'CANCEL',
        basis: PRACTICAL_AUTHORIZATION_BASIS,
        provesAccountContinuity: false,
      };
    });
  }

  // ----- [Wave 2B2b] no-wire completion (PRE_DISPATCH_FAILURE only) ------------

  /**
   * Closes an ARMED order-bound CANCEL whose ticket was NEVER dispatched (in
   * Wave 2B2 there is no dispatch path at all), as PRE_DISPATCH_FAILURE on
   * both durable sides in ONE transaction. Cleanup, not authority: no
   * enablement, reconciliation, dwell, certificate validity, stream, or
   * runtime epoch is consulted.
   */
  public async completeUndispatchedCancel(input: PracticalUndispatchedCompletionInput): Promise<PracticalNoWireCompletion> {
    // A. Before any durable access: closed-world input, a genuine ticket, the closed report.
    const raw = requireClosedWorld(input, PRACTICAL_UNDISPATCHED_COMPLETION_INPUT_KEYS);
    const armed = raw['armed'];
    const record = PracticalArmedCancel.read(armed);
    if (record === null) authorityInvalid('A genuine armed practical cancel is required', 'armed');
    if (record.basis !== PRACTICAL_AUTHORIZATION_BASIS || record.provesAccountContinuity !== false || record.action !== 'CANCEL') {
      authorityInvalid('The armed practical cancel does not carry the practical-recovery literals', 'armed');
    }
    const reason = requireNotDispatchedReport(raw['report']);
    const nowMs = requireNowMs(raw['trustedNowMs']);
    const status = PracticalArmedCancel.status(armed);
    if (status !== 'ARMED' && status !== 'COMMIT_UNKNOWN') authorityInvalid('The armed practical cancel is completing or spent', 'armed');
    const context: NoWireContext = Object.freeze({
      mode: 'ARMED_TICKET',
      retry: status === 'COMMIT_UNKNOWN',
      accountId: record.accountId,
      leaseId: record.leaseId,
      certificateId: record.certificateId,
      runtimeEpoch: record.runtimeEpoch,
      reconciliationGeneration: record.reconciliationGeneration,
      intentId: record.intentId,
      clientOrderId: record.clientOrderId,
      cancelGeneration: record.cancelGeneration,
      pair: record.pair,
      exchangeOrderId: record.exchangeOrderId,
      expectedArmedAtMs: record.armedAtMs,
      expectedLeaseCreatedAtMs: null,
      certificateMatches: (certificate: PracticalDurableCertificateRecord) => certificate.certificateId === record.certificateId
        && certificate.streamIncarnation === record.certificateStreamIncarnation
        && certificate.expiresAtMs === record.certificateExpiresAtMs,
      nowMs,
    });

    // COMPLETING_NO_WIRE across every internal retry (an unknown-commit retry must repeat the SAME reason).
    const { from } = beginPracticalArmedCancelNoWireCompletion(armed, reason);
    let outcome: NoWireOutcome;
    try {
      outcome = await this.#transaction((tx) => this.#noWireWithin(tx, context));
    } catch (error) {
      if (error instanceof TransactionOutcomeUnknown) {
        markPracticalArmedCancelCommitUnknown(armed, reason);
        throw new PracticalMutationError('PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN', 'The no-wire completion COMMIT could not be confirmed; only the identical completion may be retried', { leaseId: record.leaseId }, error.cause);
      }
      // `work` threw, so no COMMIT was issued: a proven zero-change rollback.
      restorePracticalArmedCancel(armed, from, reason);
      return this.#afterNoWireRollback(error, record.accountId, record.runtimeEpoch, nowMs);
    }
    finishPracticalArmedCancelNoWireCompletion(armed);
    return Object.freeze({
      kind: outcome.kind, outcome: 'PRE_DISPATCH_FAILURE' as const, leaseId: record.leaseId, intentId: record.intentId, cancelGeneration: record.cancelGeneration,
    });
  }

  /**
   * Abandons an acquired order-bound CANCEL in-process, as PRE_DISPATCH_FAILURE
   * on both durable sides in ONE transaction. No ticket was ever minted from
   * an acquired handle, so no gateway call can have been made for it: the
   * release variant (unarmed or armed-undispatched) is derived ONLY from the
   * locked, coupled durable pair, and the handle state only permits it.
   */
  public async abandonAcquiredCancel(input: PracticalCancelAbandonInput): Promise<PracticalNoWireCompletion> {
    const raw = requireClosedWorld(input, PRACTICAL_CANCEL_ABANDON_INPUT_KEYS);
    const acquired = raw['acquired'];
    const record = PracticalAcquiredCancel.read(acquired);
    if (record === null) authorityInvalid('A genuine acquired practical cancel is required', 'acquired');
    if (record.certificate.basis !== PRACTICAL_AUTHORIZATION_BASIS || record.certificate.provesAccountContinuity !== false || record.action !== 'CANCEL') {
      authorityInvalid('The acquired practical cancel does not carry the practical-recovery literals', 'acquired');
    }
    const nowMs = requireNowMs(raw['trustedNowMs']);

    // The state gate is inside the (synchronous) transition: AVAILABLE | ARM_OUTCOME_UNKNOWN | ABANDON_OUTCOME_UNKNOWN only.
    const { from, origin } = beginPracticalAcquiredCancelAbandon(acquired);
    const context: NoWireContext = Object.freeze({
      mode: origin === 'AVAILABLE' ? 'ABANDON_AVAILABLE' : 'ABANDON_ARM_UNKNOWN',
      retry: from === 'ABANDON_OUTCOME_UNKNOWN',
      accountId: record.accountId,
      leaseId: record.leaseId,
      certificateId: record.certificate.certificateId,
      runtimeEpoch: record.runtimeEpoch,
      reconciliationGeneration: record.reconciliationGeneration,
      intentId: record.intentId,
      clientOrderId: record.clientOrderId,
      cancelGeneration: record.cancelGeneration,
      pair: record.pair,
      exchangeOrderId: record.exchangeOrderId,
      expectedArmedAtMs: null,
      expectedLeaseCreatedAtMs: record.leaseCreatedAtMs,
      certificateMatches: (certificate: PracticalDurableCertificateRecord) => sameCertificateSnapshot(certificate, record.certificate),
      nowMs,
    });
    let outcome: NoWireOutcome;
    try {
      outcome = await this.#transaction((tx) => this.#noWireWithin(tx, context));
    } catch (error) {
      if (error instanceof TransactionOutcomeUnknown) {
        markPracticalAcquiredCancelAbandonOutcomeUnknown(acquired);
        throw new PracticalMutationError('PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN', 'The abandon COMMIT could not be confirmed; only the identical abandon may be retried', { leaseId: record.leaseId }, error.cause);
      }
      restorePracticalAcquiredCancelAbandon(acquired, from);
      return this.#afterNoWireRollback(error, record.accountId, record.runtimeEpoch, nowMs);
    }
    finishPracticalAcquiredCancelAbandon(acquired);
    return Object.freeze({
      kind: outcome.kind, outcome: 'PRE_DISPATCH_FAILURE' as const, leaseId: record.leaseId, intentId: record.intentId, cancelGeneration: record.cancelGeneration,
    });
  }

  /**
   * B. The ONE no-wire transaction. Lock order: practical rows (hook) ->
   * live_order -> live_execution_intent. It never reads or locks
   * live_reconciliation_state. Every statement uses `tx`.
   */
  async #noWireWithin(tx: Tx, ctx: NoWireContext): Promise<NoWireOutcome> {
    return withLockedPracticalAccountWithinCallerTransaction(this.#practical, tx, ctx.accountId, async (scope: PracticalLockedAccountScope) => {
      const expected = {
        leaseId: ctx.leaseId,
        certificateId: ctx.certificateId,
        runtimeEpoch: ctx.runtimeEpoch,
        reconciliationGeneration: ctx.reconciliationGeneration,
        binding: { intentId: ctx.intentId, clientOrderId: ctx.clientOrderId, cancelGeneration: ctx.cancelGeneration },
      };
      const details = { leaseId: ctx.leaseId };
      const fence = scope.account.fence;
      if (fence.mode.kind !== 'MUTATION_LEASED' || fence.mode.leaseId !== ctx.leaseId) {
        return this.#noWireAlreadyClosed(tx, scope, ctx, expected);
      }

      // 1. The exact LEASED order-bound lease (arm state RETURNED, not assumed) and its CONSUMED certificate.
      const { lease, certificate } = await scope.requireLeasedOrderBoundCancelLease(expected);
      if (!ctx.certificateMatches(certificate)) completionRefused('The lease certificate is not exactly the one this attempt acquired', details);
      if (ctx.expectedLeaseCreatedAtMs !== null && lease.createdAtMs !== ctx.expectedLeaseCreatedAtMs) completionRefused('The lease was not created by this acquisition', details);

      // 2. Phase 17 rows in the established order; exact-case identity.
      const before = await lockPhase17Order(tx, ctx.intentId);
      if (before === null
        || before.intentId !== ctx.intentId
        || before.accountId !== ctx.accountId
        || before.clientOrderId !== ctx.clientOrderId
        || before.pair !== ctx.pair
        || before.exchangeOrderId !== ctx.exchangeOrderId
        || before.cancelExchangeOrderId !== ctx.exchangeOrderId) {
        completionRefused('The Phase 17 order is not exactly the order this lease is bound to', details);
      }
      if (before.cancelGeneration !== ctx.cancelGeneration || before.cancelState !== 'CANCEL_RESERVED') {
        splitState('The practical lease is LEASED but the Phase 17 claim of its generation is not CANCEL_RESERVED', details);
      }

      // 3. The locked, COUPLED durable pair is the ONLY source of the release variant.
      const leaseArmed = lease.armedAtMs !== null;
      if (leaseArmed !== before.cancelWireArmed) splitState('The practical lease and the Phase 17 claim disagree on whether the wire was armed', details);
      if (ctx.mode === 'ARMED_TICKET') {
        if (!leaseArmed) splitState('A committed arm is not durable on either side', details);
        if (lease.armedAtMs !== ctx.expectedArmedAtMs) completionRefused('The durable arm is not the arm this ticket was minted from', details);
      } else if (ctx.mode === 'ABANDON_AVAILABLE' && leaseArmed) {
        splitState('The pair is durably armed although no arm of this handle committed or became unknown', details);
      }

      // 4. The truthful no-wire Phase 17 release (fenced with the EXACT practical account id), then the practical side.
      const accountForRelease = requireExactAccountId(lease.accountId, ctx.accountId);
      const released = leaseArmed
        ? await releaseArmedUndispatchedCancelClaimWithinCallerFencedTransaction(tx, ctx.intentId, ctx.cancelGeneration, accountForRelease)
        : await releaseUnarmedCancelClaimWithinCallerFencedTransaction(tx, ctx.intentId, ctx.cancelGeneration, accountForRelease);
      const completed = await scope.completeOrderBoundCancelLeaseNoWire(ctx.nowMs);

      // 5. BOTH durable sides re-proven before COMMIT.
      const after = await lockPhase17Order(tx, ctx.intentId);
      const closed = released.intentId === ctx.intentId
        && released.accountId === ctx.accountId
        && released.cancelState === 'NONE'
        && released.cancelGeneration === ctx.cancelGeneration
        && released.cancelWireArmed === false
        && released.cancelFaultCode === null
        && released.state === before.state
        && released.revision === before.revision + 1
        && after !== null
        && after.cancelState === 'NONE'
        && after.cancelGeneration === ctx.cancelGeneration
        && after.cancelWireArmed === false
        && after.state === before.state
        && after.revision === before.revision + 1
        && completed.lease.leaseId === ctx.leaseId
        && completed.lease.status === 'COMPLETED'
        && completed.lease.outcome === 'PRE_DISPATCH_FAILURE'
        && completed.lease.armedAtMs === lease.armedAtMs
        && completed.account.fence.mode.kind === 'IDLE'
        && completed.account.state !== 'CERTIFIED_IDLE'
        && completed.certificate.status === 'CONSUMED';
      if (!closed) selfCheckFailed('The no-wire completion did not re-read as exactly one released claim and one PRE_DISPATCH_FAILURE lease', details);
      return Object.freeze({ kind: 'COMPLETED' as const });
    });
  }

  /**
   * The fence no longer holds the lease. ALREADY_COMPLETED is returned only
   * after the SAME exact proof the completing path makes, re-made against the
   * durable completion: the exact lease (identity, binding, creation instant)
   * and CONSUMED certificate this attempt acquired, an arm state its ORIGIN
   * could have left, and the exact-case Phase 17 order (intent, account, client
   * order id, pair, exchange order id) whose claim of this generation was
   * released exactly as the no-wire release leaves it, or has since been
   * superseded by a LATER generation (whose cancel columns belong to that
   * claim). Any identity or arm-origin mismatch is COMPLETION_REFUSED (a
   * rollback with no write); a completed lease over an unreleased claim is a split.
   */
  async #noWireAlreadyClosed(
    tx: Tx,
    scope: PracticalLockedAccountScope,
    ctx: NoWireContext,
    expected: Parameters<PracticalLockedAccountScope['readOrderBoundCancelLease']>[0],
  ): Promise<NoWireOutcome> {
    const details = { leaseId: ctx.leaseId };
    // [Wave 2B2d] A fence adopted by ANOTHER runtime epoch supersedes this old-epoch caller: whatever closed the lease
    // (a previous-runtime recovery), it was not this caller's completion. Refused before any inspection, no write.
    if (scope.account.fence.runtimeEpoch !== ctx.runtimeEpoch) {
      completionRefused('The account was adopted by another runtime epoch: this old-epoch retry is superseded', details);
    }
    const { lease, certificate } = await scope.readOrderBoundCancelLease(expected);
    if (lease.status === 'LEASED') splitState('The lease is LEASED but no longer held by its fence', details);
    if (lease.status !== 'COMPLETED' || lease.outcome !== 'PRE_DISPATCH_FAILURE' || lease.completedAtMs === null) {
      alreadyCompleted('The lease was already completed with a different outcome', details);
    }

    // 1. The exact lease and certificate this attempt acquired (the completing path's checks).
    if (!ctx.certificateMatches(certificate)) completionRefused('The lease certificate is not exactly the one this attempt acquired', details);
    if (ctx.expectedLeaseCreatedAtMs !== null && lease.createdAtMs !== ctx.expectedLeaseCreatedAtMs) completionRefused('The lease was not created by this acquisition', details);

    // 2. The durable arm state must be one this attempt's ORIGIN could have left.
    const armPermitted = ctx.mode === 'ARMED_TICKET'
      ? ctx.expectedArmedAtMs !== null && lease.armedAtMs === ctx.expectedArmedAtMs
      : ctx.mode === 'ABANDON_AVAILABLE'
        ? lease.armedAtMs === null
        : true; // ABANDON_ARM_UNKNOWN: either coupled pair (no ticket ever existed)
    if (!armPermitted) completionRefused('The completed lease carries an arm state this attempt could not have left', details);

    // 3. The exact Phase 17 order, exact-case (never the collation).
    const order = await lockPhase17Order(tx, ctx.intentId);
    if (order === null
      || order.intentId !== ctx.intentId
      || order.accountId !== ctx.accountId
      || order.clientOrderId !== ctx.clientOrderId
      || order.pair !== ctx.pair
      || order.exchangeOrderId !== ctx.exchangeOrderId) {
      completionRefused('The Phase 17 order is not exactly the order this lease is bound to', details);
    }

    // 4. This generation released exactly as the no-wire release leaves it, or a LATER generation has started.
    if (order.cancelGeneration === ctx.cancelGeneration) {
      if (order.cancelState !== 'NONE' || order.cancelWireArmed) {
        splitState('The lease is COMPLETED PRE_DISPATCH_FAILURE but its Phase 17 claim was not released', details);
      }
      if (order.cancelFaultCode !== null || order.cancelExchangeOrderId !== ctx.exchangeOrderId) {
        completionRefused('The released Phase 17 claim is not exactly the claim this lease was bound to', details);
      }
    } else if (order.cancelGeneration < ctx.cancelGeneration) {
      splitState('The Phase 17 cancel generation is older than the completed lease', details);
    }

    if (!ctx.retry) alreadyCompleted('The lease was already completed as PRE_DISPATCH_FAILURE by another operation', details);
    return Object.freeze({ kind: 'ALREADY_COMPLETED' as const });
  }

  /**
   * After a PROVEN rollback of a no-wire transaction: a split pair is put into
   * manual review in its own transaction (the fence stays leased) and the
   * split error is rethrown; a malformed account is latched; anything else is
   * rethrown unchanged.
   */
  async #afterNoWireRollback(error: unknown, accountId: string, epoch: string, nowMs: number): Promise<PracticalNoWireCompletion> {
    if (error instanceof PracticalMutationError && error.code === 'PRACTICAL_MUTATION_SPLIT_STATE') {
      await this.#enterMismatchReview(accountId, nowMs);
      throw error;
    }
    return this.#latchIfMalformed(error, accountId, epoch, nowMs);
  }

  /**
   * The ONE Stage 1B1 manual-review entry of this adapter, always
   * POST_MUTATION_MISMATCH, always in its own transaction AFTER a rollback:
   * the [Wave 2B2b] split pair and the [Wave 2B2c] recovery anomaly. It never
   * repairs, releases, or completes anything. Idempotent (PRESERVED when the
   * account is already in review).
   */
  async #enterMismatchReview(accountId: string, nowMs: number): Promise<{ readonly reviewEpisodeId: string }> {
    return this.#practical.enterManualReview({ accountId, reason: 'POST_MUTATION_MISMATCH', nowMs });
  }

  // ----- [Wave 2B2c] unknown-acquire resolution --------------------------------

  /**
   * Resolves an acquisition whose COMMIT was unknown, from its single-use
   * receipt, in ONE read-only transaction. RESTORED only when the attempted
   * lease is exactly present, LEASED, unarmed, and restorable (the intended
   * handle, unchanged); NOT_COMMITTED only when the attempt provably wrote
   * nothing. ANY other durable state (including an account the strict parser
   * rejects) is a proven anomaly: the receipt becomes permanently mint-disabled,
   * the account is escalated to manual review (or the malformed-state latch),
   * and RECOVERY_REFUSED is thrown. No Phase 17 write, no reconciliation lock,
   * no enablement: the restored handle still needs arm's full checks.
   */
  public async resolveUnknownAcquire(input: PracticalUnknownAcquireResolutionInput): Promise<PracticalUnknownAcquireResolution> {
    // A. Before any durable access: closed-world input, a genuine resolvable receipt, this process's epoch.
    const raw = requireClosedWorld(input, PRACTICAL_UNKNOWN_ACQUIRE_RESOLUTION_INPUT_KEYS);
    const unknown = raw['unknown'];
    const status = PracticalUnknownAcquire.status(unknown);
    if (status === null) authorityInvalid('A genuine unknown-acquire receipt is required', 'unknown');
    if (status !== 'PENDING' && status !== 'ANOMALY_UNESCALATED') authorityInvalid('The unknown-acquire receipt is being resolved, spent, or refused', 'unknown');
    const epoch = requireRuntimeEpoch(raw['runtimeIdentity']);
    const nowMs = requireNowMs(raw['trustedNowMs']);

    // Synchronous: a concurrent second call now sees RESOLVING / ESCALATING and is refused above.
    const { record, from } = beginPracticalUnknownAcquireResolution(unknown);
    if (record.runtimeEpoch !== epoch) {
      if (from === 'PENDING') restorePracticalUnknownAcquire(unknown);
      else refusePracticalUnknownAcquire(unknown, 'ESCALATING', false);
      authorityInvalid('The unknown-acquire receipt belongs to a different runtime epoch than this process', 'runtimeIdentity');
    }
    if (from === 'ANOMALY_UNESCALATED') {
      // A PROVEN anomaly: nothing is read and nothing can be minted; only the escalation is retried.
      const escalation = await this.#escalateAnomaly(record.accountId, epoch, nowMs);
      refusePracticalUnknownAcquire(unknown, 'ESCALATING', escalation.confirmed);
      throw recoveryRefused('ANOMALY_PREVIOUSLY_PROVEN', record, escalation, undefined);
    }

    let outcome: ResolveOutcome;
    try {
      outcome = await this.#transaction((tx) => this.#resolveWithin(tx, record));
    } catch (error) {
      if (error instanceof TransactionOutcomeUnknown) {
        // D4: a read-only transaction whose COMMIT is unknown changed nothing and proved nothing: retry later.
        restorePracticalUnknownAcquire(unknown);
        throw new PracticalMutationError('PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN', 'The read-only resolution COMMIT could not be confirmed; the receipt is PENDING again', { accountId: record.accountId }, error.cause);
      }
      if (isInconclusiveResolution(error)) {
        restorePracticalUnknownAcquire(unknown);
        throw error;
      }
      if (isRuntimeSuperseded(error)) {
        // [Wave 2B2d] Superseded by another runtime: permanently REFUSED (mint-disabled), no manual review, nothing written.
        refusePracticalUnknownAcquire(unknown, 'RESOLVING', true);
        throw recoveryRefused('RUNTIME_SUPERSEDED', record, NOT_ESCALATED, error);
      }
      // Everything else is a PROVEN anomaly (or an account the strict parser rejects): permanently mint-disabled.
      const escalation = await this.#escalateAnomaly(record.accountId, epoch, nowMs);
      refusePracticalUnknownAcquire(unknown, 'RESOLVING', escalation.confirmed);
      throw recoveryRefused(refusalReasonOf(error), record, escalation, error);
    }
    // C. ONLY AFTER COMMIT: spend the receipt; RESTORED mints the INTENDED handle, unchanged (D2 / D3).
    finishPracticalUnknownAcquireResolution(unknown);
    if (outcome.kind === 'RESTORED') return Object.freeze({ kind: 'RESTORED' as const, acquired: issuePracticalAcquiredCancel(record) });
    return Object.freeze({ kind: 'NOT_COMMITTED' as const, certificateStatus: outcome.certificateStatus });
  }

  /**
   * B. The ONE read-only resolution transaction. Every statement uses `tx`;
   * nothing is written. It never reads or locks live_reconciliation_state.
   *
   * EXACT LOCK SEQUENCE (all FOR UPDATE; C = the attempt's certificate, L = the
   * attempted lease). The hook's Stage 1B1 account read comes first, in its
   * fixed order: latch -> latch episode -> state -> fence -> recovery episode
   * -> review episode -> CURRENT certificate (CERTIFIED_IDLE only) -> the
   * fence's LEASED certificate -> the fence's LEASE (certificates before
   * leases). The inspection then locks C -> the lease(s) resting on C -> L.
   *   fence names L (committed): account rows -> C (leased) -> L; then C, L
   *     again (already held) -> live_order -> live_execution_intent.
   *   fence IDLE (rolled back; CERTIFIED_IDLE): account rows -> C (current)
   *     -> [no lease]; then C (held) -> leases on C (none) -> L (absent).
   *   fence names another lease L2 on certificate C2: account rows -> C2 ->
   *     L2; then C -> leases on C -> L (absent). Here C is locked after L2:
   *     safe, because every transaction that locks ANY practical certificate
   *     or lease of this account first holds this account's latch / state /
   *     fence rows (all Stage 1B1 / 1B2 operations start with the same account
   *     read), so they serialize on the account rows and no cycle can form;
   *     the Phase 17/18 interlock and listing read practical rows WITHOUT locks.
   * Phase 17 rows are locked only on the PRESENT path, after every practical row.
   */
  async #resolveWithin(tx: Tx, record: PracticalAcquiredCancelRecord): Promise<ResolveOutcome> {
    return withLockedPracticalAccountWithinCallerTransaction(this.#practical, tx, record.accountId, async (scope: PracticalLockedAccountScope) => {
      const attempted = record.leaseId;
      // [Wave 2B2d] After the strict account read (a malformed account still fails first, parser-first), a fence adopted
      // by ANOTHER runtime epoch supersedes this old-epoch receipt: not an anomaly, nothing is inspected.
      if (scope.account.fence.runtimeEpoch !== record.runtimeEpoch) runtimeSuperseded(attempted);
      const { certificate, certificateLeaseIds, lease } = await scope.inspectAttemptedOrderBoundCancelLease({
        leaseId: attempted, certificateId: record.certificate.certificateId,
      });
      const fence = scope.account.fence;

      // C2. ABSENT: the attempt wrote nothing, PROVIDED nothing still refers to it.
      if (lease === null) {
        const fenceRefers = fence.mode.kind === 'MUTATION_LEASED' && fence.mode.leaseId === attempted;
        if (fenceRefers || certificateLeaseIds.includes(attempted)) recoveryAnomaly('ABSENT_BUT_REFERENCED', attempted);
        if (certificate === null || !sameCertificateIdentity(certificate, record.certificate)) recoveryAnomaly('CERTIFICATE_MISMATCH', attempted);
        if (certificate.status === 'CONSUMED') {
          // Consumed by exactly one OTHER lease (a different acquisition won); a consumed certificate with no lease is a deleted lease.
          if (certificateLeaseIds.length !== 1) recoveryAnomaly('ABSENT_BUT_REFERENCED', attempted);
          return Object.freeze({ kind: 'NOT_COMMITTED' as const, certificateStatus: 'CONSUMED_BY_ANOTHER_LEASE' as const });
        }
        // ISSUED / EXPIRED / REVOKED never had a lease resting on it.
        if (certificateLeaseIds.length !== 0) recoveryAnomaly('CERTIFICATE_MISMATCH', attempted);
        return Object.freeze({ kind: 'NOT_COMMITTED' as const, certificateStatus: certificate.status });
      }

      // C1 / C3. PRESENT. The exact attempted id is the proof of authorship; then status, arm, identity, fence,
      // certificate, Phase 17 - every check before RESTORED. No reviewed writer can complete or arm this lease
      // while its receipt is unresolved, so anything but an exactly restorable lease is an anomaly.
      if (lease.leaseId !== attempted) recoveryAnomaly('LEASE_IDENTITY', attempted);
      if (lease.status !== 'LEASED' || lease.completedAtMs !== null || lease.outcome !== null) recoveryAnomaly('LEASE_NOT_LEASED', attempted);
      if (lease.armedAtMs !== null) recoveryAnomaly('LEASE_ARMED', attempted);
      if (!sameAttemptedLease(lease, record)) recoveryAnomaly('LEASE_IDENTITY', attempted);
      if (!RESTORABLE_ACCOUNT_STATES.includes(scope.account.state) || !fenceNamesAttempt(fence, record)) recoveryAnomaly('FENCE_MISMATCH', attempted);
      if (certificate === null
        || !sameCertificateSnapshot(certificate, record.certificate)
        || certificateLeaseIds.length !== 1
        || certificateLeaseIds[0] !== attempted) {
        recoveryAnomaly('CERTIFICATE_MISMATCH', attempted);
      }

      // Phase 17 rows in the established order (after every practical row); exact-case identity, then the claim.
      const order = await lockPhase17Order(tx, record.intentId);
      if (order === null) recoveryAnomaly('PHASE17_MISSING', attempted);
      if (order.intentId !== record.intentId
        || order.accountId !== record.accountId
        || order.clientOrderId !== record.clientOrderId
        || order.pair !== record.pair
        || order.exchangeOrderId !== record.exchangeOrderId
        || order.cancelExchangeOrderId !== record.exchangeOrderId
        || order.cancelFaultCode !== null) {
        recoveryAnomaly('PHASE17_IDENTITY', attempted);
      }
      if (order.cancelGeneration !== record.cancelGeneration || order.cancelState !== 'CANCEL_RESERVED' || order.cancelWireArmed) {
        recoveryAnomaly('PHASE17_CLAIM', attempted);
      }
      // D3: order revision drift is permitted; the restored handle keeps the ORIGINAL revision, so arm refuses it.
      return Object.freeze({ kind: 'RESTORED' as const });
    });
  }

  /**
   * Escalates a PROVEN recovery anomaly, after the rollback. Never throws.
   * Confirmed means the account is durably in manual review: entered or
   * PRESERVED, already latched, or latched now by the existing malformed-state
   * escalation (the strict parser rejected the rows).
   */
  async #escalateAnomaly(accountId: string, epoch: string, nowMs: number): Promise<{ readonly confirmed: boolean; readonly reviewEpisodeId: string | null }> {
    try {
      const entry = await this.#enterMismatchReview(accountId, nowMs);
      return Object.freeze({ confirmed: true, reviewEpisodeId: entry.reviewEpisodeId });
    } catch (error) {
      if (error instanceof PracticalPersistenceError && error.code === 'PRACTICAL_PERSISTENCE_LATCHED') {
        const reviewEpisodeId = error.details?.['reviewEpisodeId'];
        return Object.freeze({ confirmed: true, reviewEpisodeId: typeof reviewEpisodeId === 'string' ? reviewEpisodeId : null });
      }
      if (error instanceof PracticalPersistenceError && error.code === 'PRACTICAL_PERSISTENCE_MALFORMED') {
        return this.#latchIfMalformed(error, accountId, epoch, nowMs).then(
          (latched) => Object.freeze({ confirmed: true, reviewEpisodeId: latched.reviewEpisodeId }),
          () => Object.freeze({ confirmed: false, reviewEpisodeId: null }),
        );
      }
      return Object.freeze({ confirmed: false, reviewEpisodeId: null });
    }
  }

  // ----- [Wave 2B2d] previous-runtime UNARMED leased-fence recovery ------------

  /**
   * Closes a MUTATION_LEASED fence left by a PREVIOUS runtime epoch when, and
   * only when, its order-bound lease and Phase 17 claim are a coupled UNARMED
   * pair (no ticket was ever minted from it, so no gateway call can have been
   * made): in ONE commit the Phase 17 claim is released, the lease is
   * COMPLETED PRE_DISPATCH_FAILURE through the existing no-wire writer, and
   * the fence is adopted by THIS runtime's epoch. RECOVERED is reported only
   * after a known COMMIT; an unknown COMMIT is rethrown and a retry simply
   * re-reads (NO_LEASED_FENCE is a fact about the current state, never a
   * closure claim). Refused with no write: this runtime's own lease, an unbound
   * lease. Refused, then manual review: an armed orphan (evidence required;
   * never released), a split pair, any exact-identity / generation mismatch.
   * A malformed account is latched. Cleanup, never authority: no enablement,
   * no reconciliation read or lock, no arm, no claim, no dispatch.
   */
  public async recoverPreviousRuntimeCancelLease(input: PracticalPreviousRuntimeRecoveryInput): Promise<PracticalPreviousRuntimeRecovery> {
    // A. Before any durable access. The adopting epoch comes ONLY from a genuine (non-forgeable) runtime identity.
    const raw = requireClosedWorld(input, PRACTICAL_PREVIOUS_RUNTIME_RECOVERY_INPUT_KEYS);
    const accountId = requireAccountId(raw['accountId']);
    const epoch = requireRuntimeEpoch(raw['runtimeIdentity']);
    const nowMs = requireNowMs(raw['trustedNowMs']);
    let outcome: PracticalPreviousRuntimeRecovery;
    try {
      outcome = await this.#transaction((tx) => this.#recoverWithin(tx, accountId, epoch, nowMs));
    } catch (error) {
      if (error instanceof TransactionOutcomeUnknown) {
        throw new PracticalMutationError('PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN', 'The previous-runtime recovery COMMIT could not be confirmed; a retry re-reads the durable state', { accountId }, error.cause);
      }
      return this.#afterRecoveryRollback(error, accountId, epoch, nowMs);
    }
    // C. ONLY AFTER COMMIT.
    return outcome;
  }

  /**
   * B. The ONE recovery transaction. Lock order: the Stage 1B1 account read
   * (hook: ... -> the fence's leased certificate -> the fence's lease), then
   * live_order -> live_execution_intent. No live_reconciliation_state.
   */
  async #recoverWithin(tx: Tx, accountId: string, epoch: string, nowMs: number): Promise<PracticalPreviousRuntimeRecovery> {
    return withLockedPracticalAccountWithinCallerTransaction(this.#practical, tx, accountId, async (scope: PracticalLockedAccountScope) => {
      const fence = scope.account.fence;
      if (fence.mode.kind !== 'MUTATION_LEASED') {
        return Object.freeze({ kind: 'NO_LEASED_FENCE' as const, fenceHeldByThisRuntime: fence.runtimeEpoch === epoch });
      }
      // 1. Only a PREVIOUS runtime's lease; this runtime owns its own handle / ticket / receipt paths.
      if (fence.runtimeEpoch === epoch) leaseRecoveryRefused('CURRENT_RUNTIME_LEASE', accountId);
      const held = scope.account.currentLease;
      if (held === null || fence.mode.action !== 'CANCEL' || held.orderBinding === null) leaseRecoveryRefused('UNBOUND_LEASE', accountId);
      const binding = held.orderBinding;

      // 2. The exact LEASED order-bound lease on its exact CONSUMED certificate (the 2B2b check; a well-formed
      //    inconsistency throws a persistence CONFLICT, mapped to LEASE_CERTIFICATE_MISMATCH after the rollback).
      const { lease } = await scope.requireLeasedOrderBoundCancelLease({
        leaseId: held.leaseId,
        certificateId: fence.mode.certificateId,
        runtimeEpoch: fence.runtimeEpoch,
        reconciliationGeneration: fence.reconciliationGeneration,
        binding: { intentId: binding.intentId, clientOrderId: binding.clientOrderId, cancelGeneration: binding.cancelGeneration },
      });

      // 3. Phase 17 rows in the established order; exact-case identity with the lease binding, then the claim.
      const order = await lockPhase17Order(tx, binding.intentId);
      if (order === null) leaseRecoveryRefused('PHASE17_MISSING', accountId);
      if (order.intentId !== binding.intentId
        || order.accountId !== accountId
        || order.clientOrderId !== binding.clientOrderId
        || order.exchangeOrderId === null
        || order.cancelExchangeOrderId !== order.exchangeOrderId
        || order.cancelFaultCode !== null) {
        leaseRecoveryRefused('PHASE17_IDENTITY', accountId);
      }
      if (order.cancelGeneration !== binding.cancelGeneration || order.cancelState !== 'CANCEL_RESERVED') leaseRecoveryRefused('PHASE17_CLAIM', accountId);

      // 4. The COUPLED durable pair decides. Only a coupled UNARMED pair is released; an armed pair needs evidence.
      const leaseArmed = lease.armedAtMs !== null;
      if (leaseArmed !== order.cancelWireArmed) leaseRecoveryRefused('SPLIT_PAIR', accountId);
      if (leaseArmed) leaseRecoveryRefused('ARMED_ORPHAN_REQUIRES_EVIDENCE', accountId);

      // 5. In ONE commit: the truthful no-wire Phase 17 release (exact account), then the lease + fence adoption.
      const released = await releaseUnarmedCancelClaimWithinCallerFencedTransaction(tx, binding.intentId, binding.cancelGeneration, requireExactAccountId(lease.accountId, accountId));
      const completed = await scope.completeOrderBoundCancelLeaseNoWireAndAdopt(nowMs, epoch);

      // 6. BOTH durable sides re-proven before COMMIT.
      const after = await lockPhase17Order(tx, binding.intentId);
      const closed = released.intentId === binding.intentId
        && released.accountId === accountId
        && released.cancelState === 'NONE'
        && released.cancelGeneration === binding.cancelGeneration
        && released.cancelWireArmed === false
        && released.cancelFaultCode === null
        && released.state === order.state
        && released.revision === order.revision + 1
        && after !== null
        && after.cancelState === 'NONE'
        && after.cancelGeneration === binding.cancelGeneration
        && after.cancelWireArmed === false
        && after.revision === order.revision + 1
        && completed.lease.leaseId === lease.leaseId
        && completed.lease.status === 'COMPLETED'
        && completed.lease.outcome === 'PRE_DISPATCH_FAILURE'
        && completed.lease.armedAtMs === null
        && completed.account.fence.mode.kind === 'IDLE'
        && completed.account.fence.runtimeEpoch === epoch
        && completed.certificate.status === 'CONSUMED';
      if (!closed) selfCheckFailed('The previous-runtime recovery did not re-read as one released claim, one PRE_DISPATCH_FAILURE lease, and an adopted fence', { leaseId: lease.leaseId });
      return Object.freeze({
        kind: 'RECOVERED' as const, outcome: 'PRE_DISPATCH_FAILURE' as const, leaseId: lease.leaseId, intentId: binding.intentId, cancelGeneration: binding.cancelGeneration,
      });
    });
  }

  /**
   * After a PROVEN rollback of a recovery: a PROVEN durable contradiction
   * enters manual review through the ONE shared call site. Two kinds only,
   * both TYPED (never matched by message): this store's escalating refusals
   * (armed orphan, split pair, Phase 17 identity / claim / missing row), and
   * the persistence layer's `PracticalDurableContradictionError` (the lease
   * and its CONSUMED certificate contradict each other), reported as
   * LEASE_CERTIFICATE_MISMATCH. A malformed account is latched. EVERY other
   * failure (a plain persistence CONFLICT from a lifecycle, CAS, concurrent
   * change or self-check re-read; a fence error such as revision exhaustion;
   * a database fault) is rethrown UNCHANGED: fail-closed, no review.
   */
  async #afterRecoveryRollback(error: unknown, accountId: string, epoch: string, nowMs: number): Promise<PracticalPreviousRuntimeRecovery> {
    const contradiction = error instanceof PracticalDurableContradictionError;
    if (contradiction || isEscalatingLeaseRecoveryRefusal(error)) {
      await this.#enterMismatchReview(accountId, nowMs);
      if (contradiction) leaseRecoveryRefused('LEASE_CERTIFICATE_MISMATCH', accountId, error);
      throw error;
    }
    return this.#latchIfMalformed(error, accountId, epoch, nowMs);
  }

  // ----- malformed-state latch (AFTER a rollback; the existing reviewed escalation) ----

  /**
   * A MALFORMED (not yet latched) account is latched by the existing Stage 1B1
   * escalation, in its own transaction, only after this store's transaction
   * rolled back. Anything else is rethrown unchanged.
   */
  async #latchIfMalformed(error: unknown, accountId: string, epoch: string, nowMs: number): Promise<{ readonly kind: 'MALFORMED_LATCHED'; readonly reviewEpisodeId: string }> {
    if (!(error instanceof PracticalPersistenceError) || error.code !== 'PRACTICAL_PERSISTENCE_MALFORMED') throw error;
    let escalation: PracticalMalformedEscalation;
    try {
      escalation = await this.#practical.escalateMalformedAccount({ accountId, detectingRuntimeEpoch: epoch, nowMs });
    } catch (escalationError) {
      // e.g. the rows are valid again, or the key is only a collation variant: the original failure stands.
      if (escalationError instanceof PracticalPersistenceError && escalationError.code === 'PRACTICAL_PERSISTENCE_CONFLICT') throw error;
      throw escalationError;
    }
    return Object.freeze({ kind: 'MALFORMED_LATCHED' as const, reviewEpisodeId: escalation.reviewEpisodeId });
  }
}

/** The consumed durable certificate still equals the genuine presented record on every persisted immutable field. */
function samePresentedCertificate(durable: PracticalDurableCertificateRecord, presented: PracticalRecoveryCertificateRecord): boolean {
  return durable.certificateId === presented.certificateId
    && durable.accountId === presented.accountId
    && durable.providerAccountFingerprint === presented.providerAccountFingerprint
    && durable.runtimeEpoch === presented.runtimeEpoch
    && durable.reconciliationGeneration === presented.reconciliationGeneration
    && durable.streamIncarnation === presented.streamIncarnation
    && durable.evidenceDigest === presented.evidenceDigest
    && durable.issuedAtMs === presented.issuedAtMs
    && durable.expiresAtMs === presented.expiresAtMs;
}
