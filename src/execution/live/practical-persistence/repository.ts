/**
 * Phase 18B Stage 1B1: Prisma/MySQL implementation of the practical safety
 * persistence port.
 *
 * Every guarantee below is enforced by MySQL inside ONE transaction, never by
 * an in-memory lock or registry:
 *
 * | Guarantee                                   | Enforcement |
 * | :------------------------------------------ | :---------- |
 * | One operation per account at a time         | every operation first locks the state row, then the fence row, `FOR UPDATE` (fixed order), then any certificate / lease / episode rows it touches |
 * | Fence compare-and-set                       | the Stage 1A fence function checks account, epoch, generation, revision, and mode against the LOCKED row; the write is `updateMany` conditioned on the old revision and mode, and must affect exactly one row |
 * | Durable one-shot certificate                | `ISSUED -> terminal` is `updateMany ... WHERE status = 'ISSUED'` (exactly one row), and `UNIQUE(live_practical_mutation_lease.certificate_id)` allows at most one lease per certificate, whatever the number of in-memory certificate objects or processes |
 * | All or nothing                              | certificate insert + fence transition, and consumption + lease insert + fence transition, each share one transaction |
 * | Never commit an inconsistent account        | after writing, the account is re-read and strictly re-validated inside the same transaction |
 * | A leased fence is bound to its exact lease  | six-column composite FK (lease, certificate, account, action, epoch, generation); every account read re-validates exact equality plus LEASED, and `releaseLease` re-checks it independently before any write |
 * | ...and that lease to its CONSUMED certificate | four-column composite FK (certificate, account, epoch, generation); every account read re-validates exact equality plus CONSUMED; `releaseLease` re-checks it independently; consume self-checks the committed chain before returning |
 * | Generated ids are never trusted blindly     | every repository-generated id passes `#newDurableId` (exact, non-empty, fits its column) before the first write |
 *
 * The repository mints nothing. It never issues a certificate, an
 * enablement, or a manual-review resolution: it persists values that the
 * Stage 1A issuance boundaries created, after checking they are genuine.
 *
 * NOT DISPATCH AUTHORITY. `consumeCertificateAndLease` records a durable
 * one-shot lease. It does not call, arm, or authorize any gateway, and
 * nothing in Stage 1B1 calls it from live execution. Stage 1B2 must join this
 * acquisition and the existing Phase 17 dispatch claim in ONE transaction, so
 * there is no split-brain window between "lease taken" and "dispatch claimed".
 * Until then a lease is bookkeeping only.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { PracticalRecoveryCertificate, type PracticalRecoveryCertificateRecord } from '../practical/certificate';
import {
  adoptPracticalFenceForNewRuntime,
  beginPracticalCertification,
  beginPracticalMutationLease,
  finishPracticalCertification,
  initialPracticalFence,
  releasePracticalMutationLease,
  type PracticalAccountFence,
  type PracticalFenceExpectation,
} from '../practical/fence';
import { classifyPracticalInvalidation } from '../practical/invalidation';
import { practicalActionPermission } from '../practical/policy';
import {
  PracticalManualReviewResolution,
  practicalAccountStateOnStartup,
  practicalStateAfterTransitionFailure,
  transitionPracticalAccountState,
  type PracticalTransitionEvent,
} from '../practical/state-machine';
import {
  PRACTICAL_AUTHORIZATION_BASIS,
  PRACTICAL_DIGEST_PATTERN,
  PRACTICAL_MUTATION_OUTCOMES,
  PracticalLiveSafetyError,
  isExactId,
  isNonNegativeSafeInteger,
  isPracticalInvalidationReason,
  isPracticalMutationAction,
  type PracticalAccountStateName,
  type PracticalInvalidationReason,
  type PracticalMutationAction,
  type PracticalMutationOutcome,
  type PracticalQuarantineCause,
} from '../practical/types';
import { planPracticalAccountChange, type PracticalAccountChangePlan, type PracticalAccountChangeRequest } from './plan';
import {
  PRACTICAL_DURABLE_STATE_MALFORMED,
  PracticalPersistenceError,
  type PracticalMalformedEscalation,
  type PracticalAccountInitialization,
  type PracticalAccountLoad,
  type PracticalAccountSnapshot,
  type PracticalCertificateTerminalChange,
  type PracticalCertificationFailure,
  type PracticalDurableCertificateRecord,
  type PracticalLeaseAcquisition,
  type PracticalManualReviewEntry,
  type PracticalMutationLeaseRecord,
  type PracticalRecordLoad,
  type PracticalSafetyRepository,
} from './ports';
import {
  evaluatePracticalLatch,
  isPracticalCertificateBoundToLease,
  isPracticalLeaseBoundToFence,
  parsePracticalCertificateRow,
  parsePracticalLeaseRow,
  singleRowOrNull,
  toPracticalAccountLoad,
  toPracticalRecordLoad,
  type PracticalAccountRawRows,
} from './rows';

type Tx = Prisma.TransactionClient;

/** Attempts per operation on a MySQL deadlock / write conflict (Prisma P2034): the first plus two retries. */
export const PRACTICAL_TRANSACTION_MAX_ATTEMPTS = 3;
/** Interactive transaction timeout. Lock waits between racing workers are short; anything longer is a fault. */
const TRANSACTION_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Raw locked reads (always the latest committed row version)
// ---------------------------------------------------------------------------

function lockClause(lock: boolean): Prisma.Sql {
  return Prisma.raw(lock ? ' FOR UPDATE' : '');
}

async function readStateRow(tx: Tx, accountId: string, lock: boolean): Promise<unknown> {
  const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT account_id AS accountId, state, current_recovery_episode_id AS currentRecoveryEpisodeId,
    current_review_episode_id AS currentReviewEpisodeId, current_certificate_id AS currentCertificateId, revision
    FROM live_practical_account_state WHERE account_id = ${accountId}${lockClause(lock)}`);
  return singleRowOrNull(rows, 'STATE_ROW_INVALID');
}

async function readFenceRow(tx: Tx, accountId: string, lock: boolean): Promise<unknown> {
  const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT account_id AS accountId, runtime_epoch AS runtimeEpoch,
    reconciliation_generation AS reconciliationGeneration, revision, mode, run_id AS runId, lease_id AS leaseId,
    certificate_id AS certificateId, lease_action AS leaseAction
    FROM live_practical_account_fence WHERE account_id = ${accountId}${lockClause(lock)}`);
  return singleRowOrNull(rows, 'FENCE_ROW_INVALID');
}

async function readCertificateRow(tx: Tx, certificateId: string, lock: boolean): Promise<unknown> {
  const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT certificate_id AS certificateId, account_id AS accountId,
    provider_account_fingerprint AS providerAccountFingerprint, runtime_epoch AS runtimeEpoch,
    reconciliation_generation AS reconciliationGeneration, stream_incarnation AS streamIncarnation,
    evidence_digest AS evidenceDigest, issued_at_ms AS issuedAtMs, expires_at_ms AS expiresAtMs, status,
    terminal_at_ms AS terminalAtMs, terminal_reason AS terminalReason
    FROM live_practical_certificate WHERE certificate_id = ${certificateId}${lockClause(lock)}`);
  return singleRowOrNull(rows, 'CERTIFICATE_ROW_INVALID');
}

async function readLeaseRow(tx: Tx, leaseId: string, lock: boolean): Promise<unknown> {
  const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT lease_id AS leaseId, account_id AS accountId, certificate_id AS certificateId,
    action, intent_id AS intentId, client_order_id AS clientOrderId, runtime_epoch AS runtimeEpoch,
    reconciliation_generation AS reconciliationGeneration, created_at_ms AS createdAtMs, armed_at_ms AS armedAtMs,
    completed_at_ms AS completedAtMs, status, outcome
    FROM live_practical_mutation_lease WHERE lease_id = ${leaseId}${lockClause(lock)}`);
  return singleRowOrNull(rows, 'LEASE_ROW_INVALID');
}

async function readRecoveryEpisodeRow(tx: Tx, episodeId: string, lock: boolean): Promise<unknown> {
  const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT episode_id AS episodeId, account_id AS accountId, started_at_ms AS startedAtMs,
    ended_at_ms AS endedAtMs, start_cause AS startCause, status, runtime_epoch AS runtimeEpoch,
    reconciliation_generation AS reconciliationGeneration, certified_certificate_id AS certifiedCertificateId,
    review_episode_id AS reviewEpisodeId, opened_by_resolution_id AS openedByResolutionId
    FROM live_practical_recovery_episode WHERE episode_id = ${episodeId}${lockClause(lock)}`);
  return singleRowOrNull(rows, 'RECOVERY_EPISODE_ROW_INVALID');
}

async function readReviewEpisodeRow(tx: Tx, reviewEpisodeId: string, lock: boolean): Promise<unknown> {
  const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT review_episode_id AS reviewEpisodeId, account_id AS accountId, kind,
    entered_at_ms AS enteredAtMs, reason, malformed_problem AS malformedProblem, runtime_epoch AS runtimeEpoch, status,
    resolved_at_ms AS resolvedAtMs, resolution_id AS resolutionId
    FROM live_practical_review_episode WHERE review_episode_id = ${reviewEpisodeId}${lockClause(lock)}`);
  return singleRowOrNull(rows, 'REVIEW_EPISODE_ROW_INVALID');
}

async function readLatchRow(tx: Tx, accountId: string, lock: boolean): Promise<unknown> {
  const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT account_id AS accountId, current_review_episode_id AS currentReviewEpisodeId, revision
    FROM live_practical_malformed_latch WHERE account_id = ${accountId}${lockClause(lock)}`);
  return singleRowOrNull(rows, 'LATCH_ROW_INVALID');
}

/** A pointer column's value, only when it is a string; anything else is left for strict parsing to reject. */
function pointerOf(row: unknown, name: string): string | null {
  if (typeof row !== 'object' || row === null) return null;
  const value = (row as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

/**
 * Reads one account's rows as one snapshot. With `lock`, every row is locked
 * `FOR UPDATE` in ONE fixed order, used by every operation:
 *
 *   1 malformed-state latch   2 its review episode   3 state   4 fence
 *   5 current recovery episode   6 current review episode
 *   7 CERTIFICATES: the state's current certificate, then the certificate a
 *     MUTATION_LEASED fence names (by the fence's own certificate id)
 *   8 LEASE: the lease a MUTATION_LEASED fence names
 *
 * Certificates are always locked before leases, here and in every operation
 * that later re-reads either (consume locks the presented certificate, which
 * is the current one, before inserting its lease; release re-reads the leased
 * certificate before the lease), so no certificate/lease lock cycle exists.
 */
async function readAccountRows(tx: Tx, accountId: string, lock: boolean): Promise<PracticalAccountRawRows> {
  const latch = await readLatchRow(tx, accountId, lock);
  const latchEpisodeId = pointerOf(latch, 'currentReviewEpisodeId');
  const latchEpisode = latchEpisodeId === null ? null : await readReviewEpisodeRow(tx, latchEpisodeId, lock);
  const state = await readStateRow(tx, accountId, lock);
  const fence = await readFenceRow(tx, accountId, lock);
  const recoveryId = pointerOf(state, 'currentRecoveryEpisodeId');
  const reviewId = pointerOf(state, 'currentReviewEpisodeId');
  const certificateId = pointerOf(state, 'currentCertificateId');
  const leased = pointerOf(fence, 'mode') === 'MUTATION_LEASED';
  const leasedCertificateId = leased ? pointerOf(fence, 'certificateId') : null;
  const leaseId = leased ? pointerOf(fence, 'leaseId') : null;
  // Sequential awaits in the documented order (5, 6, 7, 7, 8).
  const recoveryEpisode = recoveryId === null ? null : await readRecoveryEpisodeRow(tx, recoveryId, lock);
  const reviewEpisode = reviewId === null ? null : await readReviewEpisodeRow(tx, reviewId, lock);
  const certificate = certificateId === null ? null : await readCertificateRow(tx, certificateId, lock);
  const leasedCertificate = leasedCertificateId === null ? null : await readCertificateRow(tx, leasedCertificateId, lock);
  const lease = leaseId === null ? null : await readLeaseRow(tx, leaseId, lock);
  return { latch, latchEpisode, state, fence, recoveryEpisode, reviewEpisode, certificate, leasedCertificate, lease };
}

/**
 * Refuses an account id that only matches durable rows through the
 * database's case-insensitive, pad-space collation (the rows are keyed by a
 * differently spelled id). Such a key must never create or change durable
 * state on behalf of the exactly-spelled account.
 */
function requireExactAccountKey(accountId: string, rows: PracticalAccountRawRows): void {
  for (const row of [rows.latch, rows.state, rows.fence]) {
    const stored = pointerOf(row, 'accountId');
    if (stored !== null && stored !== accountId) {
      conflict('The account id matches durable practical rows only case- or pad-insensitively; it does not name them exactly', { field: 'accountId' });
    }
  }
}

/**
 * The FOUND account of a load, or the typed refusal: NOT_FOUND, LATCHED (an
 * active malformed-state latch, whatever the rows now say), or MALFORMED.
 * Never null.
 */
function requireFound(accountId: string, load: PracticalAccountLoad): PracticalAccountSnapshot {
  switch (load.kind) {
    case 'FOUND':
      return load.account;
    case 'NOT_FOUND':
      throw new PracticalPersistenceError('PRACTICAL_PERSISTENCE_NOT_FOUND', 'The account has no practical rows', { accountId });
    default:
      if (load.reviewEpisodeId !== null) {
        throw new PracticalPersistenceError('PRACTICAL_PERSISTENCE_LATCHED', 'The account is latched in malformed-state manual review; only its exact episode resolution may proceed', {
          accountId, reviewEpisodeId: load.reviewEpisodeId, problem: load.problem,
        });
      }
      throw new PracticalPersistenceError('PRACTICAL_PERSISTENCE_MALFORMED', 'The account\'s durable practical rows are malformed', { accountId, problem: load.problem });
  }
}

/** The locked account for an operation (see `requireFound`). */
async function lockAccount(tx: Tx, accountId: string): Promise<PracticalAccountSnapshot> {
  return requireFound(accountId, toPracticalAccountLoad(accountId, await readAccountRows(tx, accountId, true)));
}

// ---------------------------------------------------------------------------
// Input validation (before any durable access)
// ---------------------------------------------------------------------------

function invalidInput(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new PracticalPersistenceError('PRACTICAL_PERSISTENCE_INVALID_INPUT', message, details);
}

function requireId(value: unknown, name: string, maxLength: number): string {
  if (!isExactId(value) || value.length > maxLength) invalidInput(`${name} must be a non-empty exact string of at most ${maxLength} characters`, { field: name });
  return value;
}

/**
 * A certificate id is always a lowercase 64-hex digest. Requiring that exact
 * form up front also means a case-variant key can never reach the
 * case-insensitive database comparison.
 */
function requireDigestId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !PRACTICAL_DIGEST_PATTERN.test(value)) invalidInput(`${name} must be a lowercase 64-hex digest`, { field: name });
  return value;
}

function requireTime(value: unknown, name: string): number {
  if (!isNonNegativeSafeInteger(value)) invalidInput(`${name} must be a non-negative safe integer`, { field: name });
  return value;
}

function requireReason(value: unknown): PracticalInvalidationReason {
  if (!isPracticalInvalidationReason(value)) invalidInput('A typed Stage 1A invalidation reason is required', { field: 'reason' });
  return value;
}

function requireExpectation(accountId: string, expected: PracticalFenceExpectation): PracticalFenceExpectation {
  if (typeof expected !== 'object' || expected === null || expected.accountId !== accountId) {
    invalidInput('The fence expectation must name the same account', { field: 'expected.accountId' });
  }
  return expected;
}

function conflict(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new PracticalPersistenceError('PRACTICAL_PERSISTENCE_CONFLICT', message, details);
}

function unusable(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new PracticalPersistenceError('PRACTICAL_PERSISTENCE_CERTIFICATE_UNUSABLE', message, details);
}

/** A genuine in-memory Stage 1A certificate's record, or refusal. Structural look-alikes and clones are refused. */
function genuineCertificateRecord(value: unknown): PracticalRecoveryCertificateRecord {
  const record = PracticalRecoveryCertificate.read(value);
  if (record === null) unusable('A genuine Stage 1A practical recovery certificate is required');
  if (record.basis !== PRACTICAL_AUTHORIZATION_BASIS || record.provesAccountContinuity !== false) {
    unusable('Only a PRACTICAL_RECOVERY certificate that proves no account continuity can be persisted');
  }
  return record;
}

/** The durable row must equal the presented certificate's record on EVERY persisted field. */
function sameCertificate(durable: PracticalDurableCertificateRecord, presented: PracticalRecoveryCertificateRecord): boolean {
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

/** Stage 1B integration contract: a caught Stage 1A transition failure persists the fail-closed state, never a hard-coded one. */
function transitionOrFailClosed(current: PracticalAccountStateName, event: PracticalTransitionEvent): PracticalAccountStateName {
  try {
    return transitionPracticalAccountState(current, event);
  } catch (error) {
    if (error instanceof PracticalLiveSafetyError) return practicalStateAfterTransitionFailure(current);
    throw error;
  }
}

/**
 * A FOUND record is returned only when its durable key EXACTLY equals the
 * requested key. The database collation is case-insensitive and pad-space, so
 * a differently spelled key can match a row; that row is a different identity
 * and is refused (fail closed), never returned as a match and never reported
 * as NOT_FOUND (the read did return a row).
 */
function exactKeyLoad<T>(load: PracticalRecordLoad<T>, isExactKey: (record: T) => boolean, field: string): PracticalRecordLoad<T> {
  if (load.kind === 'FOUND' && !isExactKey(load.record)) {
    conflict('The requested key matches a durable record only case- or pad-insensitively; it is not an exact identity match', { field });
  }
  return load;
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

/** MySQL's deadlock victim error number. */
const MYSQL_DEADLOCK = '1213';

/**
 * A MySQL deadlock / write conflict, retried in a fresh transaction. Prisma
 * reports it as P2034 from the model API, and as P2010 ("raw query failed")
 * with MySQL code 1213 from a raw locking read (`SELECT ... FOR UPDATE`),
 * which is how it surfaced against real MySQL when two escalations raced
 * (gap locks on an absent latch row). Nothing else is treated as retryable.
 */
function isRetryableDeadlock(error: unknown): boolean {
  if (isPrismaCode(error, 'P2034')) return true;
  if (!isPrismaCode(error, 'P2010')) return false;
  const meta = (error as Prisma.PrismaClientKnownRequestError).meta;
  return meta !== undefined && meta !== null && (meta as Record<string, unknown>)['code'] === MYSQL_DEADLOCK;
}

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

export class PrismaPracticalSafetyRepository implements PracticalSafetyRepository {
  readonly #prisma: PrismaClient;
  readonly #newId: () => string;

  public constructor(prisma: PrismaClient, newId: () => string = randomUUID) {
    this.#prisma = prisma;
    this.#newId = newId;
  }

  /**
   * The ONLY way this repository generates a durable identifier. The injected
   * generator is not trusted: its value must be a non-empty exact string (no
   * padding) that fits the destination column, or the operation is refused
   * BEFORE any durable write. Nothing is trimmed or normalized.
   */
  #newDurableId(name: string, maxLength: number): string {
    const id: unknown = this.#newId();
    if (!isExactId(id) || id.length > maxLength) {
      throw new PracticalPersistenceError('PRACTICAL_PERSISTENCE_FAULT', `The generated ${name} is not a non-empty exact string of at most ${maxLength} characters; nothing was written`, { field: name });
    }
    return id;
  }

  /**
   * One fresh interactive transaction per attempt. Retried ONLY on a MySQL
   * deadlock / write conflict (P2034, or P2010 carrying MySQL 1213; see
   * `isRetryableDeadlock`), and on a duplicate key (P2002) only
   * where the caller says so. A retried attempt re-locks and re-reads
   * everything; nothing from a rolled-back attempt is reused.
   */
  async #transaction<T>(work: (tx: Tx) => Promise<T>, options: { readonly retryDuplicateKey?: boolean; readonly retry?: boolean } = {}): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.#prisma.$transaction(work, { timeout: TRANSACTION_TIMEOUT_MS });
      } catch (error) {
        const retryable = options.retry !== false && (isRetryableDeadlock(error) || (options.retryDuplicateKey === true && isPrismaCode(error, 'P2002')));
        if (!retryable) throw error;
        if (attempt >= PRACTICAL_TRANSACTION_MAX_ATTEMPTS) {
          throw new PracticalPersistenceError('PRACTICAL_PERSISTENCE_FAULT', 'The practical persistence transaction kept failing on a database conflict; nothing was committed', { attempts: attempt });
        }
      }
    }
  }

  // ----- reads -------------------------------------------------------------

  public async loadAccount(accountId: string): Promise<PracticalAccountLoad> {
    requireId(accountId, 'accountId', 128);
    // One transaction = one consistent snapshot across the account's rows.
    const rows = await this.#transaction((tx) => readAccountRows(tx, accountId, false));
    return toPracticalAccountLoad(accountId, rows);
  }

  public async loadCertificate(certificateId: string): Promise<PracticalRecordLoad<PracticalDurableCertificateRecord>> {
    requireDigestId(certificateId, 'certificateId');
    const row = await this.#transaction((tx) => readCertificateRow(tx, certificateId, false));
    return exactKeyLoad(toPracticalRecordLoad(row, parsePracticalCertificateRow), (record) => record.certificateId === certificateId, 'certificateId');
  }

  public async loadLease(leaseId: string): Promise<PracticalRecordLoad<PracticalMutationLeaseRecord>> {
    requireId(leaseId, 'leaseId', 64);
    const row = await this.#transaction((tx) => readLeaseRow(tx, leaseId, false));
    return exactKeyLoad(toPracticalRecordLoad(row, parsePracticalLeaseRow), (record) => record.leaseId === leaseId, 'leaseId');
  }

  // ----- lifecycle ---------------------------------------------------------

  public async initializeAccount(input: {
    readonly accountId: string;
    readonly runtimeEpoch: string;
    readonly reconciliationGeneration: number;
    readonly nowMs: number;
  }): Promise<PracticalAccountInitialization> {
    const accountId = requireId(input.accountId, 'accountId', 128);
    const runtimeEpoch = requireId(input.runtimeEpoch, 'runtimeEpoch', 64);
    const nowMs = requireTime(input.nowMs, 'nowMs');
    const fence = initialPracticalFence({ accountId, runtimeEpoch, reconciliationGeneration: input.reconciliationGeneration });
    // A duplicate key means another worker created the account concurrently: re-read it.
    return this.#transaction(async (tx) => {
      const load = toPracticalAccountLoad(accountId, await readAccountRows(tx, accountId, true));
      // Only a trusted absence is initialized. A malformed or latched account is refused, never recreated.
      if (load.kind !== 'NOT_FOUND') return Object.freeze({ kind: 'EXISTING' as const, account: requireFound(accountId, load) });
      const episodeId = this.#newDurableId('recoveryEpisodeId', 64);
      const cause: PracticalQuarantineCause = 'RUNTIME_STARTUP';
      await tx.livePracticalRecoveryEpisode.create({ data: {
        episodeId, accountId, startedAtMs: BigInt(nowMs), startCause: cause, status: 'OPEN',
        runtimeEpoch, reconciliationGeneration: fence.reconciliationGeneration,
      } });
      await tx.livePracticalAccountState.create({ data: {
        accountId, state: practicalAccountStateOnStartup(null), currentRecoveryEpisodeId: episodeId, revision: 0n,
      } });
      await tx.livePracticalAccountFence.create({ data: {
        accountId, runtimeEpoch, reconciliationGeneration: fence.reconciliationGeneration, revision: BigInt(fence.revision), mode: 'IDLE',
      } });
      return Object.freeze({ kind: 'CREATED' as const, account: await lockAccount(tx, accountId) });
    }, { retryDuplicateKey: true });
  }

  public async adoptForNewRuntime(input: {
    readonly accountId: string;
    readonly previousRuntimeEpoch: string;
    readonly expectedFenceRevision: number;
    readonly newRuntimeEpoch: string;
    readonly nowMs: number;
  }): Promise<PracticalAccountSnapshot> {
    const accountId = requireId(input.accountId, 'accountId', 128);
    requireId(input.newRuntimeEpoch, 'newRuntimeEpoch', 64);
    const nowMs = requireTime(input.nowMs, 'nowMs');
    return this.#transaction(async (tx) => {
      const current = await lockAccount(tx, accountId);
      // Stage 1A: refuses a stale epoch/revision and a MUTATION_LEASED fence.
      const nextFence = adoptPracticalFenceForNewRuntime(current.fence, {
        accountId, previousRuntimeEpoch: input.previousRuntimeEpoch, revision: input.expectedFenceRevision,
      }, input.newRuntimeEpoch);
      return this.#apply(tx, current, {
        nextState: practicalAccountStateOnStartup(current.state),
        nextFence,
        openCause: 'RUNTIME_STARTUP',
        reason: 'RUNTIME_EPOCH_CHANGED',
      }, nowMs);
    });
  }

  // ----- certification -----------------------------------------------------

  public async startCertification(input: {
    readonly accountId: string;
    readonly expected: PracticalFenceExpectation;
    readonly runId: string;
    readonly nowMs: number;
  }): Promise<PracticalAccountSnapshot> {
    const accountId = requireId(input.accountId, 'accountId', 128);
    const expected = requireExpectation(accountId, input.expected);
    const runId = requireId(input.runId, 'runId', 64);
    const nowMs = requireTime(input.nowMs, 'nowMs');
    return this.#transaction(async (tx) => {
      const current = await lockAccount(tx, accountId);
      const nextFence = beginPracticalCertification(current.fence, expected, runId);
      const nextState = transitionPracticalAccountState(current.state, { kind: 'CERTIFICATION_STARTED' });
      return this.#apply(tx, current, { nextState, nextFence, openCause: 'RUNTIME_STARTUP', reason: null }, nowMs);
    });
  }

  public async finishCertification(input: {
    readonly accountId: string;
    readonly expected: PracticalFenceExpectation;
    readonly runId: string;
    readonly resultingGeneration: number;
    readonly certificate: unknown;
    readonly nowMs: number;
  }): Promise<PracticalAccountSnapshot> {
    const accountId = requireId(input.accountId, 'accountId', 128);
    const expected = requireExpectation(accountId, input.expected);
    const nowMs = requireTime(input.nowMs, 'nowMs');
    const record = genuineCertificateRecord(input.certificate);
    if (PracticalRecoveryCertificate.status(input.certificate as PracticalRecoveryCertificate) !== 'ISSUED') {
      unusable('Only an ISSUED certificate can be persisted', { certificateId: record.certificateId });
    }
    return this.#transaction(async (tx) => {
      const current = await lockAccount(tx, accountId);
      const nextFence = finishPracticalCertification(current.fence, expected, input.runId, input.resultingGeneration);
      const nextState = transitionPracticalAccountState(current.state, { kind: 'CERTIFICATION_SUCCEEDED' });
      if (record.accountId !== accountId
        || record.runtimeEpoch !== nextFence.runtimeEpoch
        || record.reconciliationGeneration !== nextFence.reconciliationGeneration) {
        unusable('The certificate is not bound to this account, runtime epoch, and resulting generation', { certificateId: record.certificateId });
      }
      if (nowMs < record.issuedAtMs || nowMs >= record.expiresAtMs) {
        unusable('The certificate is outside its validity window at persistence time', { certificateId: record.certificateId });
      }
      // Certificate FIRST, fence transition LAST: any failure rolls both back.
      try {
        await tx.livePracticalCertificate.create({ data: {
          certificateId: record.certificateId,
          accountId,
          providerAccountFingerprint: record.providerAccountFingerprint,
          runtimeEpoch: record.runtimeEpoch,
          reconciliationGeneration: record.reconciliationGeneration,
          streamIncarnation: record.streamIncarnation,
          evidenceDigest: record.evidenceDigest,
          issuedAtMs: BigInt(record.issuedAtMs),
          expiresAtMs: BigInt(record.expiresAtMs),
          status: 'ISSUED',
        } });
      } catch (error) {
        if (isPrismaCode(error, 'P2002')) conflict('This certificate was already persisted; a certificate is persisted exactly once', { certificateId: record.certificateId });
        throw error;
      }
      return this.#apply(tx, current, {
        nextState, nextFence, openCause: 'RUNTIME_STARTUP', reason: null, newCertificateId: record.certificateId,
      }, nowMs);
    });
  }

  public async failCertification(input: {
    readonly accountId: string;
    readonly expected: PracticalFenceExpectation;
    readonly runId: string;
    readonly resultingGeneration: number;
    readonly failure: PracticalCertificationFailure;
    readonly nowMs: number;
  }): Promise<PracticalAccountSnapshot> {
    const accountId = requireId(input.accountId, 'accountId', 128);
    const expected = requireExpectation(accountId, input.expected);
    const nowMs = requireTime(input.nowMs, 'nowMs');
    const failure: unknown = input.failure;
    if (typeof failure !== 'object' || failure === null) invalidInput('A certification failure is required', { field: 'failure' });
    const failureKind = (failure as { readonly kind?: unknown }).kind;
    let event: PracticalTransitionEvent;
    let reason: PracticalInvalidationReason | null;
    if (failureKind === 'PROVIDER_UNAVAILABLE') {
      event = { kind: 'PROVIDER_UNAVAILABLE' };
      reason = null;
    } else if (failureKind === 'INVALIDATED') {
      reason = requireReason((failure as { readonly reason?: unknown }).reason);
      event = { kind: 'INVALIDATED', reason };
    } else {
      invalidInput('Unknown certification failure', { field: 'failure.kind' });
    }
    return this.#transaction(async (tx) => {
      const current = await lockAccount(tx, accountId);
      const nextFence = finishPracticalCertification(current.fence, expected, input.runId, input.resultingGeneration);
      const nextState = transitionOrFailClosed(current.state, event);
      return this.#apply(tx, current, { nextState, nextFence, openCause: reason ?? 'RUNTIME_STARTUP', reason }, nowMs);
    });
  }

  public async recordProviderRecovered(input: { readonly accountId: string; readonly nowMs: number }): Promise<PracticalAccountSnapshot> {
    const accountId = requireId(input.accountId, 'accountId', 128);
    const nowMs = requireTime(input.nowMs, 'nowMs');
    return this.#transaction(async (tx) => {
      const current = await lockAccount(tx, accountId);
      const nextState = transitionPracticalAccountState(current.state, { kind: 'PROVIDER_RECOVERED' });
      return this.#apply(tx, current, { nextState, nextFence: null, openCause: 'RUNTIME_STARTUP', reason: null }, nowMs);
    });
  }

  // ----- invalidation, review, certificate terminal changes -----------------

  public async invalidate(input: {
    readonly accountId: string;
    readonly reason: PracticalInvalidationReason;
    readonly nowMs: number;
  }): Promise<{ readonly account: PracticalAccountSnapshot; readonly reviewEpisodeId: string | null }> {
    const accountId = requireId(input.accountId, 'accountId', 128);
    const reason = requireReason(input.reason);
    const nowMs = requireTime(input.nowMs, 'nowMs');
    return this.#transaction(async (tx) => {
      const current = await lockAccount(tx, accountId);
      const account = await this.#invalidateLocked(tx, current, reason, nowMs);
      const reviewEpisodeId = account.currentReviewEpisode === null ? null : account.currentReviewEpisode.reviewEpisodeId;
      return Object.freeze({ account, reviewEpisodeId });
    });
  }

  public async enterManualReview(input: {
    readonly accountId: string;
    readonly reason: PracticalInvalidationReason;
    readonly nowMs: number;
  }): Promise<PracticalManualReviewEntry> {
    const accountId = requireId(input.accountId, 'accountId', 128);
    const reason = requireReason(input.reason);
    if (classifyPracticalInvalidation(reason) !== 'MANUAL_REVIEW') {
      invalidInput('enterManualReview requires a reason whose Stage 1A severity is MANUAL_REVIEW', { reason });
    }
    const nowMs = requireTime(input.nowMs, 'nowMs');
    return this.#transaction(async (tx) => {
      const current = await lockAccount(tx, accountId);
      if (current.state === 'MANUAL_REVIEW_REQUIRED') {
        // Documented idempotence: the unresolved CURRENT episode is preserved; nothing is written.
        return Object.freeze({ kind: 'PRESERVED' as const, reviewEpisodeId: current.currentReviewEpisode!.reviewEpisodeId, account: current });
      }
      const account = await this.#invalidateLocked(tx, current, reason, nowMs);
      return Object.freeze({ kind: 'ENTERED' as const, reviewEpisodeId: account.currentReviewEpisode!.reviewEpisodeId, account });
    });
  }

  public async revokeCertificate(input: {
    readonly accountId: string;
    readonly certificateId: string;
    readonly reason: PracticalInvalidationReason;
    readonly nowMs: number;
  }): Promise<PracticalCertificateTerminalChange> {
    const accountId = requireId(input.accountId, 'accountId', 128);
    const certificateId = requireDigestId(input.certificateId, 'certificateId');
    const reason = requireReason(input.reason);
    const nowMs = requireTime(input.nowMs, 'nowMs');
    return this.#transaction(async (tx) => {
      const current = await lockAccount(tx, accountId);
      const certificate = await this.#lockOwnedCertificate(tx, accountId, certificateId);
      if (certificate.status !== 'ISSUED') {
        if (certificate.status === 'REVOKED' && certificate.terminalReason === reason) {
          return Object.freeze({ kind: 'ALREADY_TERMINAL' as const, certificate });
        }
        unusable('The certificate is already terminal and cannot be revoked again (never resurrected)', { certificateId, status: certificate.status });
      }
      this.#requireCurrent(current, certificateId);
      const account = await this.#invalidateLocked(tx, current, reason, nowMs);
      return Object.freeze({ kind: 'TERMINATED' as const, certificate: await this.#reloadCertificate(tx, certificateId), account });
    });
  }

  public async expireCertificate(input: {
    readonly accountId: string;
    readonly certificateId: string;
    readonly trustedNowMs: number;
  }): Promise<PracticalCertificateTerminalChange> {
    const accountId = requireId(input.accountId, 'accountId', 128);
    const certificateId = requireDigestId(input.certificateId, 'certificateId');
    const nowMs = requireTime(input.trustedNowMs, 'trustedNowMs');
    return this.#transaction(async (tx) => {
      const current = await lockAccount(tx, accountId);
      const certificate = await this.#lockOwnedCertificate(tx, accountId, certificateId);
      if (certificate.status === 'EXPIRED') return Object.freeze({ kind: 'ALREADY_TERMINAL' as const, certificate });
      if (certificate.status !== 'ISSUED') unusable('Only an ISSUED certificate can expire', { certificateId, status: certificate.status });
      if (nowMs < certificate.expiresAtMs) conflict('The certificate has not reached its absolute expiry at the supplied trusted time', { certificateId });
      this.#requireCurrent(current, certificateId);
      const account = await this.#apply(tx, current, {
        nextState: transitionPracticalAccountState(current.state, { kind: 'INVALIDATED', reason: 'CERTIFICATE_EXPIRED' }),
        nextFence: null,
        openCause: 'CERTIFICATE_EXPIRED',
        reason: 'CERTIFICATE_EXPIRED',
        certificateTermination: 'EXPIRED',
      }, nowMs);
      return Object.freeze({ kind: 'TERMINATED' as const, certificate: await this.#reloadCertificate(tx, certificateId), account });
    });
  }

  // ----- the durable one-shot: consume + lease --------------------------------

  public async consumeCertificateAndLease(input: {
    readonly accountId: string;
    readonly expected: PracticalFenceExpectation;
    readonly certificate: unknown;
    readonly leaseId: string;
    readonly action: PracticalMutationAction;
    readonly trustedNowMs: number;
  }): Promise<PracticalLeaseAcquisition> {
    const accountId = requireId(input.accountId, 'accountId', 128);
    const expected = requireExpectation(accountId, input.expected);
    const leaseId = requireId(input.leaseId, 'leaseId', 64);
    const nowMs = requireTime(input.trustedNowMs, 'trustedNowMs');
    if (!isPracticalMutationAction(input.action)) invalidInput('Unknown mutation action', { field: 'action' });
    const permission = practicalActionPermission('STAGE_5A_CANCEL_ONLY', input.action);
    if (!permission.permitted) {
      throw new PracticalLiveSafetyError('PRACTICAL_ACTION_NOT_PERMITTED', 'The action is not permitted in the Stage 5a rollout stage', { action: input.action, reason: permission.reason });
    }
    const presented = genuineCertificateRecord(input.certificate);

    return this.#transaction(async (tx) => {
      // 1. lock account (state, fence, current pointers), 2. lock the presented certificate.
      const current = await lockAccount(tx, accountId);
      const durable = await this.#lockOwnedCertificate(tx, accountId, presented.certificateId);
      // 3. strict validation against the DURABLE row (the only one-shot authority).
      if (!sameCertificate(durable, presented)) unusable('The presented certificate differs from the durable record', { certificateId: durable.certificateId });
      if (durable.status !== 'ISSUED') unusable('The certificate is no longer ISSUED', { certificateId: durable.certificateId, status: durable.status });
      this.#requireCurrent(current, durable.certificateId);
      // Stage 1A fence CAS: exact account, epoch, generation, revision; mode IDLE.
      const leasedFence = beginPracticalMutationLease(current.fence, expected, { leaseId, certificateId: durable.certificateId, action: input.action });
      if (durable.runtimeEpoch !== current.fence.runtimeEpoch || durable.reconciliationGeneration !== current.fence.reconciliationGeneration) {
        unusable('The certificate is bound to a different runtime epoch or generation than the fence', { certificateId: durable.certificateId });
      }
      // Validity window, from the DURABLE row and the supplied trusted time. Outside it,
      // the certificate is durably terminated (Stage 1A semantics) and no lease is taken.
      if (nowMs < durable.issuedAtMs || nowMs >= durable.expiresAtMs) {
        const expired = nowMs >= durable.expiresAtMs;
        const reason: PracticalInvalidationReason = expired ? 'CERTIFICATE_EXPIRED' : 'CLOCK_ANOMALY';
        const account = await this.#apply(tx, current, {
          nextState: transitionPracticalAccountState(current.state, { kind: 'INVALIDATED', reason }),
          nextFence: null,
          openCause: reason,
          reason,
          certificateTermination: expired ? 'EXPIRED' : 'REVOKED',
        }, nowMs);
        return Object.freeze({ kind: 'CERTIFICATE_TERMINATED' as const, certificate: await this.#reloadCertificate(tx, durable.certificateId), account });
      }
      const nextState = transitionPracticalAccountState(current.state, { kind: 'MUTATION_LEASED' });
      // 4. ISSUED -> CONSUMED, 5. insert the lease, 6. IDLE -> MUTATION_LEASED (+ revision): see #apply order.
      const account = await this.#apply(tx, current, {
        nextState, nextFence: leasedFence, openCause: 'RUNTIME_STARTUP', reason: null, certificateTermination: 'CONSUMED',
      }, nowMs, {
        insertLease: { leaseId, certificateId: durable.certificateId, action: input.action },
      });
      // Post-consume self-check on the locked re-read (#apply's final strict account read): the committed
      // result must be exactly fence -> this LEASED lease -> this CONSUMED certificate, or everything rolls back.
      const { currentLease, leasedCertificate } = account;
      if (account.state !== 'MUTATING'
        || account.fence.mode.kind !== 'MUTATION_LEASED'
        || account.fence.mode.leaseId !== leaseId
        || account.fence.mode.certificateId !== durable.certificateId
        || currentLease === null
        || currentLease.leaseId !== leaseId
        || leasedCertificate === null
        || leasedCertificate.certificateId !== durable.certificateId
        || leasedCertificate.status !== 'CONSUMED'
        || !isPracticalLeaseBoundToFence(currentLease, account.fence)
        || !isPracticalCertificateBoundToLease(leasedCertificate, currentLease)) {
        conflict('The consumed certificate, the lease, and the fence did not re-read as one exact chain', { leaseId });
      }
      return Object.freeze({ kind: 'LEASED' as const, lease: currentLease, certificate: leasedCertificate, account });
    });
  }

  public async releaseLease(input: {
    readonly accountId: string;
    readonly expected: PracticalFenceExpectation;
    readonly leaseId: string;
    readonly outcome: PracticalMutationOutcome;
    readonly nowMs: number;
  }): Promise<PracticalAccountSnapshot> {
    const accountId = requireId(input.accountId, 'accountId', 128);
    const expected = requireExpectation(accountId, input.expected);
    const leaseId = requireId(input.leaseId, 'leaseId', 64);
    const nowMs = requireTime(input.nowMs, 'nowMs');
    if (!(PRACTICAL_MUTATION_OUTCOMES as readonly unknown[]).includes(input.outcome)) {
      // Refused with zero change: the lease stays held and the account stays blocked.
      invalidInput('Unknown mutation outcome', { field: 'outcome' });
    }
    return this.#transaction(async (tx) => {
      // Account assembly already refuses a leased fence whose lease is not bound to it on every field (MALFORMED).
      const current = await lockAccount(tx, accountId);
      // Stage 1A: exact account, epoch, generation, revision; mode MUTATION_LEASED; exact lease id.
      const releasedFence = releasePracticalMutationLease(current.fence, expected, leaseId);
      // Independent re-check of the COMPLETE chain (fence -> LEASED lease -> CONSUMED certificate) against
      // fresh reads of rows the account read already locked (certificate before lease: no new lock order),
      // before anything is written.
      if (current.fence.mode.kind !== 'MUTATION_LEASED') conflict('The fence is not leased', { leaseId });
      const certificateRow = await readCertificateRow(tx, current.fence.mode.certificateId, true);
      if (certificateRow === null) conflict('The leased fence names a certificate that has no durable record', { leaseId });
      const leasedCertificate = parsePracticalCertificateRow(certificateRow);
      const leaseRow = await readLeaseRow(tx, leaseId, true);
      if (leaseRow === null) conflict('The leased fence names a lease that has no durable record', { leaseId });
      const lease = parsePracticalLeaseRow(leaseRow);
      if (lease.leaseId !== leaseId || !isPracticalLeaseBoundToFence(lease, current.fence)) {
        conflict('The durable lease is not a LEASED lease bound to the leased fence on every field', { leaseId });
      }
      if (!isPracticalCertificateBoundToLease(leasedCertificate, lease)) {
        conflict('The lease does not rest on its exact CONSUMED certificate', { leaseId });
      }
      const nextState = transitionOrFailClosed(current.state, { kind: 'MUTATION_OUTCOME_RECORDED', outcome: input.outcome });
      return this.#apply(tx, current, {
        nextState, nextFence: releasedFence, openCause: 'MUTATION_OUTCOME_RECORDED', reason: null,
      }, nowMs, { completeLease: { lease, outcome: input.outcome } });
    });
  }

  // ----- malformed-state escalation ------------------------------------------

  public async escalateMalformedAccount(input: {
    readonly accountId: string;
    readonly detectingRuntimeEpoch: string;
    readonly nowMs: number;
  }): Promise<PracticalMalformedEscalation> {
    const accountId = requireId(input.accountId, 'accountId', 128);
    const detectingRuntimeEpoch = requireId(input.detectingRuntimeEpoch, 'detectingRuntimeEpoch', 64);
    const nowMs = requireTime(input.nowMs, 'nowMs');
    // A duplicate latch key or a deadlock means a concurrent escalation won: re-read, then PRESERVE.
    return this.#transaction(async (tx) => {
      const rows = await readAccountRows(tx, accountId, true);
      // A differently spelled key must never latch (and so poison) the exactly spelled account.
      requireExactAccountKey(accountId, rows);
      // The latch itself must be trustworthy; a malformed latch is refused, never overwritten.
      const latch = evaluatePracticalLatch(accountId, rows.latch, rows.latchEpisode);
      if (latch.reviewEpisodeId !== null) {
        return Object.freeze({ kind: 'PRESERVED' as const, reviewEpisodeId: latch.reviewEpisodeId });
      }
      const load = toPracticalAccountLoad(accountId, rows);
      if (load.kind === 'NOT_FOUND') {
        throw new PracticalPersistenceError('PRACTICAL_PERSISTENCE_NOT_FOUND', 'No practical rows: that is a trusted absence (QUARANTINED), not a malformed state', { accountId });
      }
      if (load.kind === 'FOUND') conflict('The account\'s durable practical rows are valid; there is nothing malformed to escalate', { accountId });
      // Escalation writes ONLY the new episode and the latch; the malformed rows are left exactly as found.
      const reviewEpisodeId = this.#newDurableId('reviewEpisodeId', 64);
      await tx.livePracticalReviewEpisode.create({ data: {
        reviewEpisodeId,
        accountId,
        kind: 'MALFORMED_STATE',
        enteredAtMs: BigInt(nowMs),
        reason: PRACTICAL_DURABLE_STATE_MALFORMED,
        malformedProblem: load.problem,
        runtimeEpoch: detectingRuntimeEpoch,
        status: 'OPEN',
      } });
      if (latch.latch === null) {
        await tx.livePracticalMalformedLatch.create({ data: { accountId, currentReviewEpisodeId: reviewEpisodeId, revision: 0n } });
      } else {
        if (latch.latch.revision >= Number.MAX_SAFE_INTEGER) conflict('The latch revision is exhausted', { accountId });
        const updated = await tx.livePracticalMalformedLatch.updateMany({
          where: { accountId, revision: BigInt(latch.latch.revision), currentReviewEpisodeId: null },
          data: { currentReviewEpisodeId: reviewEpisodeId, revision: BigInt(latch.latch.revision + 1) },
        });
        if (updated.count !== 1) conflict('The latch changed concurrently', { accountId });
      }
      // Strict re-read inside the same transaction: the committed latch must be exactly this OPEN
      // episode (an inconsistent result throws and rolls the episode and the latch back).
      const after = await readAccountRows(tx, accountId, true);
      const latched = evaluatePracticalLatch(accountId, after.latch, after.latchEpisode);
      const reloaded = toPracticalAccountLoad(accountId, after);
      if (latched.reviewEpisodeId !== reviewEpisodeId || reloaded.kind !== 'MALFORMED' || reloaded.reviewEpisodeId !== reviewEpisodeId) {
        conflict('The malformed-state latch did not re-read as exactly the new episode', { accountId });
      }
      return Object.freeze({ kind: 'LATCHED' as const, reviewEpisodeId, problem: load.problem });
    }, { retryDuplicateKey: true });
  }

  /**
   * INTERNAL, NOT WIRED, NOT ON THE PORT. Resolves the account's CURRENT
   * manual-review episode, either the malformed-state latch episode (checked
   * first) or the state's invalidation episode, with a genuine Stage 1A
   * resolution bound to this account AND that exact current durable
   * reviewEpisodeId, read under the same locks that apply the change. There is
   * no operator authentication: `assertedBy` is a caller-asserted audit label.
   *
   * ORDERING (liveness without weakening one-shot):
   *   1. validate: genuine resolution; account and CURRENT episode match (no consumption);
   *   2. perform every durable write (`OPEN -> RESOLVED` conditional update,
   *      `UNIQUE resolution_id`, the latch/state changes);
   *   3. LAST, the Stage 1A transition re-validates and CONSUMES the resolution in memory.
   * A deadlock or rollback in step 2 therefore leaves the resolution unconsumed and
   * reusable (the operation is retried on P2034). A resolution already consumed in
   * memory fails step 3 and rolls everything back. The durable current episode and
   * UNIQUE resolution_id remain the authoritative double-spend protection.
   */
  public async resolveManualReview(input: { readonly accountId: string; readonly resolution: unknown; readonly nowMs: number }): Promise<PracticalAccountSnapshot> {
    const accountId = requireId(input.accountId, 'accountId', 128);
    const nowMs = requireTime(input.nowMs, 'nowMs');
    const record = PracticalManualReviewResolution.read(input.resolution);
    if (record === null) {
      throw new PracticalLiveSafetyError('PRACTICAL_AUTHORITY_INVALID', 'Manual review may only be left through a genuine resolution');
    }
    requireId(record.resolutionId, 'resolutionId', 128);
    requireId(record.assertedBy, 'assertedBy', 128);
    requireId(record.note, 'note', 512);
    const resolution = input.resolution as PracticalManualReviewResolution;
    const audit = { resolutionId: record.resolutionId, assertedBy: record.assertedBy, note: record.note };
    const precheck = (reviewEpisodeId: string): void => {
      if (record.accountId !== accountId) throw new PracticalLiveSafetyError('PRACTICAL_AUTHORITY_INVALID', 'The resolution is for a different account', { field: 'accountId' });
      if (record.reviewEpisodeId !== reviewEpisodeId) {
        throw new PracticalLiveSafetyError('PRACTICAL_AUTHORITY_INVALID', 'The resolution is for a different manual-review episode', { field: 'reviewEpisodeId' });
      }
    };
    const consumeLast = (reviewEpisodeId: string): void => {
      const next = transitionPracticalAccountState('MANUAL_REVIEW_REQUIRED', { kind: 'OPERATOR_RESOLUTION', accountId, reviewEpisodeId, resolution });
      if (next !== 'QUARANTINED') conflict('Unexpected resolution outcome', { accountId });
    };

    return this.#transaction(async (tx) => {
      const rows = await readAccountRows(tx, accountId, true);
      const load = toPracticalAccountLoad(accountId, rows);
      if (load.kind === 'MALFORMED' && load.reviewEpisodeId !== null) {
        // --- malformed-state latch episode ---
        const episodeId = load.reviewEpisodeId;
        precheck(episodeId);
        const latch = evaluatePracticalLatch(accountId, rows.latch, rows.latchEpisode).latch!;
        // The latch is cleared only once the rows are valid again AND hold no authority.
        const underlying = toPracticalAccountLoad(accountId, { ...rows, latch: null, latchEpisode: null });
        if (underlying.kind !== 'FOUND') {
          conflict('The durable practical rows are still malformed or absent; they must be corrected before the latch can be resolved', { accountId });
        }
        if (underlying.account.state !== 'QUARANTINED' && underlying.account.state !== 'MANUAL_REVIEW_REQUIRED') {
          conflict('The corrected rows must be at a non-authority baseline (QUARANTINED or MANUAL_REVIEW_REQUIRED)', { accountId, state: underlying.account.state });
        }
        try {
          const resolved = await tx.livePracticalReviewEpisode.updateMany({
            where: { reviewEpisodeId: episodeId, accountId, kind: 'MALFORMED_STATE', status: 'OPEN' },
            data: { status: 'RESOLVED', resolvedAtMs: BigInt(nowMs), resolutionId: audit.resolutionId, resolutionAssertedBy: audit.assertedBy, resolutionNote: audit.note },
          });
          if (resolved.count !== 1) conflict('The malformed-state episode was resolved concurrently', { accountId });
        } catch (error) {
          if (isPrismaCode(error, 'P2002')) conflict('This resolution id already resolved a review episode', { accountId });
          throw error;
        }
        const cleared = await tx.livePracticalMalformedLatch.updateMany({
          where: { accountId, revision: BigInt(latch.revision), currentReviewEpisodeId: episodeId },
          data: { currentReviewEpisodeId: null, revision: BigInt(latch.revision + 1) },
        });
        if (cleared.count !== 1) conflict('The latch changed concurrently', { accountId });
        const after = await lockAccount(tx, accountId);
        consumeLast(episodeId);
        return after;
      }

      // --- invalidation episode of a valid account ---
      const current = requireFound(accountId, load);
      if (current.state !== 'MANUAL_REVIEW_REQUIRED' || current.currentReviewEpisode === null) {
        conflict('The account is not in manual review', { accountId });
      }
      const episodeId = current.currentReviewEpisode.reviewEpisodeId;
      precheck(episodeId);
      let after: PracticalAccountSnapshot;
      try {
        after = await this.#apply(tx, current, {
          nextState: 'QUARANTINED', nextFence: null, openCause: 'OPERATOR_RESOLVED', reason: null, resolution: audit,
        }, nowMs);
      } catch (error) {
        if (isPrismaCode(error, 'P2002')) conflict('This resolution id already resolved a review episode', { accountId });
        throw error;
      }
      consumeLast(episodeId);
      return after;
    });
  }

  // ----- internals -----------------------------------------------------------

  async #invalidateLocked(tx: Tx, current: PracticalAccountSnapshot, reason: PracticalInvalidationReason, nowMs: number): Promise<PracticalAccountSnapshot> {
    const nextState = transitionPracticalAccountState(current.state, { kind: 'INVALIDATED', reason });
    return this.#apply(tx, current, { nextState, nextFence: null, openCause: reason, reason }, nowMs);
  }

  async #lockOwnedCertificate(tx: Tx, accountId: string, certificateId: string): Promise<PracticalDurableCertificateRecord> {
    const row = await readCertificateRow(tx, certificateId, true);
    if (row === null) unusable('The certificate has no durable record', { certificateId });
    const certificate = parsePracticalCertificateRow(row);
    if (certificate.certificateId !== certificateId) unusable('The certificate matches only case- or pad-insensitively; it is not this certificate', { certificateId });
    if (certificate.accountId !== accountId) unusable('The certificate belongs to a different account', { certificateId });
    return certificate;
  }

  async #reloadCertificate(tx: Tx, certificateId: string): Promise<PracticalDurableCertificateRecord> {
    return parsePracticalCertificateRow(await readCertificateRow(tx, certificateId, true));
  }

  #requireCurrent(current: PracticalAccountSnapshot, certificateId: string): void {
    if (current.state !== 'CERTIFIED_IDLE' || current.currentCertificate === null || current.currentCertificate.certificateId !== certificateId) {
      conflict('The certificate is not the account\'s current certificate', { certificateId, state: current.state });
    }
  }

  /**
   * Executes one planned change, in an order that satisfies every foreign
   * key and CHECK at every statement, then re-reads and strictly re-validates
   * the account INSIDE the transaction (an inconsistent result throws and
   * rolls everything back):
   *   1 terminate current certificate  2 insert lease  3 complete lease
   *   4 insert review episode  5 resolve review episode  6 close recovery episode
   *   7 open recovery episode  8 update state  9 update fence (last)
   */
  async #apply(
    tx: Tx,
    current: PracticalAccountSnapshot,
    request: PracticalAccountChangeRequest,
    nowMs: number,
    extras: {
      readonly insertLease?: { readonly leaseId: string; readonly certificateId: string; readonly action: PracticalMutationAction };
      readonly completeLease?: { readonly lease: PracticalMutationLeaseRecord; readonly outcome: PracticalMutationOutcome };
    } = {},
  ): Promise<PracticalAccountSnapshot> {
    // The plan is computed (and every generated id validated) before the first write.
    const plan: PracticalAccountChangePlan = planPracticalAccountChange(current, request, (kind) => this.#newDurableId(kind, 64));
    const fenceAfter: PracticalAccountFence = plan.nextFence ?? current.fence;
    const now = BigInt(nowMs);
    const exactlyOne = (count: number, message: string): void => {
      if (count !== 1) conflict(message, { accountId: current.accountId });
    };

    if (plan.terminateCertificate !== null) {
      const { certificateId, status, reason } = plan.terminateCertificate;
      const updated = await tx.livePracticalCertificate.updateMany({
        where: { certificateId, accountId: current.accountId, status: 'ISSUED' },
        data: { status, terminalAtMs: now, terminalReason: status === 'CONSUMED' ? null : reason },
      });
      exactlyOne(updated.count, 'The certificate left ISSUED concurrently');
    }
    if (extras.insertLease !== undefined) {
      try {
        await tx.livePracticalMutationLease.create({ data: {
          leaseId: extras.insertLease.leaseId,
          accountId: current.accountId,
          certificateId: extras.insertLease.certificateId,
          action: extras.insertLease.action,
          runtimeEpoch: fenceAfter.runtimeEpoch,
          reconciliationGeneration: fenceAfter.reconciliationGeneration,
          createdAtMs: now,
          status: 'LEASED',
        } });
      } catch (error) {
        if (isPrismaCode(error, 'P2002')) conflict('A lease with this id, or for this certificate, already exists', { leaseId: extras.insertLease.leaseId });
        throw error;
      }
    }
    if (extras.completeLease !== undefined) {
      const lease = extras.completeLease.lease;
      // Conditioned on the complete binding, not only the lease id.
      const updated = await tx.livePracticalMutationLease.updateMany({
        where: {
          leaseId: lease.leaseId, accountId: current.accountId, certificateId: lease.certificateId, action: lease.action,
          runtimeEpoch: lease.runtimeEpoch, reconciliationGeneration: lease.reconciliationGeneration, status: 'LEASED',
        },
        data: { status: 'COMPLETED', outcome: extras.completeLease.outcome, completedAtMs: now },
      });
      exactlyOne(updated.count, 'The lease was completed concurrently');
    }
    if (plan.enterReviewEpisode !== null) {
      await tx.livePracticalReviewEpisode.create({ data: {
        reviewEpisodeId: plan.enterReviewEpisode.reviewEpisodeId,
        accountId: current.accountId,
        kind: 'INVALIDATION',
        enteredAtMs: now,
        reason: plan.enterReviewEpisode.reason,
        runtimeEpoch: fenceAfter.runtimeEpoch,
        status: 'OPEN',
      } });
    }
    if (plan.resolveReviewEpisode !== null) {
      const { reviewEpisodeId, resolution } = plan.resolveReviewEpisode;
      const updated = await tx.livePracticalReviewEpisode.updateMany({
        where: { reviewEpisodeId, accountId: current.accountId, kind: 'INVALIDATION', status: 'OPEN' },
        data: {
          status: 'RESOLVED', resolvedAtMs: now, resolutionId: resolution.resolutionId,
          resolutionAssertedBy: resolution.assertedBy, resolutionNote: resolution.note,
        },
      });
      exactlyOne(updated.count, 'The review episode was resolved concurrently');
    }
    if (plan.closeRecoveryEpisode !== null) {
      const close = plan.closeRecoveryEpisode;
      const updated = await tx.livePracticalRecoveryEpisode.updateMany({
        where: { episodeId: close.episodeId, accountId: current.accountId, status: 'OPEN' },
        data: { status: close.status, endedAtMs: now, certifiedCertificateId: close.certifiedCertificateId, reviewEpisodeId: close.reviewEpisodeId },
      });
      exactlyOne(updated.count, 'The recovery episode was closed concurrently');
    }
    if (plan.openRecoveryEpisode !== null) {
      await tx.livePracticalRecoveryEpisode.create({ data: {
        episodeId: plan.openRecoveryEpisode.episodeId,
        accountId: current.accountId,
        startedAtMs: now,
        startCause: plan.openRecoveryEpisode.cause,
        status: 'OPEN',
        runtimeEpoch: fenceAfter.runtimeEpoch,
        reconciliationGeneration: plan.openRecoveryEpisode.reconciliationGeneration,
        openedByResolutionId: plan.openRecoveryEpisode.openedByResolutionId,
      } });
    }

    if (current.stateRevision >= Number.MAX_SAFE_INTEGER) {
      throw new PracticalPersistenceError('PRACTICAL_PERSISTENCE_CONFLICT', 'The account state revision is exhausted and cannot advance safely', { accountId: current.accountId });
    }
    const stateUpdated = await tx.livePracticalAccountState.updateMany({
      where: { accountId: current.accountId, revision: BigInt(current.stateRevision), state: current.state },
      data: {
        state: plan.nextState,
        currentRecoveryEpisodeId: plan.nextPointers.currentRecoveryEpisodeId,
        currentReviewEpisodeId: plan.nextPointers.currentReviewEpisodeId,
        currentCertificateId: plan.nextPointers.currentCertificateId,
        revision: BigInt(current.stateRevision + 1),
      },
    });
    exactlyOne(stateUpdated.count, 'The account state changed concurrently');

    if (plan.nextFence !== null) {
      const next = plan.nextFence;
      const mode = next.mode;
      const fenceUpdated = await tx.livePracticalAccountFence.updateMany({
        where: { accountId: current.accountId, revision: BigInt(current.fence.revision), mode: current.fence.mode.kind },
        data: {
          runtimeEpoch: next.runtimeEpoch,
          reconciliationGeneration: next.reconciliationGeneration,
          revision: BigInt(next.revision),
          mode: mode.kind,
          runId: mode.kind === 'CERTIFYING' ? mode.runId : null,
          leaseId: mode.kind === 'MUTATION_LEASED' ? mode.leaseId : null,
          certificateId: mode.kind === 'MUTATION_LEASED' ? mode.certificateId : null,
          leaseAction: mode.kind === 'MUTATION_LEASED' ? mode.action : null,
        },
      });
      exactlyOne(fenceUpdated.count, 'The fence changed concurrently (stale compare-and-set)');
    }

    return lockAccount(tx, current.accountId);
  }
}
