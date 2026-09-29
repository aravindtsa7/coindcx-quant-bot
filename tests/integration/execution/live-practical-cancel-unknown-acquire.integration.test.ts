import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveExecutionIntentRecord } from '../../../src/execution/live/intent';
import { PrismaLiveExecutionRepository, releaseUnarmedCancelClaimWithinCallerFencedTransaction } from '../../../src/execution/live/repository';
import { issuePracticalRecoveryCertificate, type PracticalRecoveryCertificate } from '../../../src/execution/live/practical/certificate';
import { issuePracticalLiveSafetyEnablement, type PracticalLiveSafetyEnablement } from '../../../src/execution/live/practical/policy';
import type { PracticalAccountSnapshot } from '../../../src/execution/live/practical-persistence/ports';
import { PrismaPracticalSafetyRepository, withLockedPracticalAccountWithinCallerTransaction } from '../../../src/execution/live/practical-persistence/repository';
import { PracticalAcquireCommitUnknownError, PracticalMutationError } from '../../../src/execution/live/practical-mutation/ports';
import { PrismaPracticalCancelMutationStore } from '../../../src/execution/live/practical-mutation/repository';
import { PracticalAcquiredCancel, PracticalUnknownAcquire, readPracticalUnknownAcquireReceipt } from '../../../src/execution/live/practical-mutation/ticket';
import { providerAccountFingerprint } from '../../../src/execution/live/reconciliation/account-identity';
import { newLiveRuntimeIdentity, readLiveRuntimeEpoch } from '../../../src/execution/live/reconciliation/barrier';
import { PrismaLiveReconciliationRepository } from '../../../src/execution/live/reconciliation/repository';
import { createRootLogger, redactSensitiveData } from '../../../src/monitoring/logger';
import { DisposableMysqlGuardError, DisposableMysqlLifecycle, generateDisposableDatabaseName } from '../../helpers/p18b-disposable-mysql';

// [P18B-1B2-W2B2c-DB] Real MySQL proof of the Stage 1B2 unknown-ACQUIRE-commit resolution:
//
//   DISCRIMINATOR  a GENUINE commit-lost acquisition (it really committed) resolves RESTORED; a GENUINE
//                  rollback-lost one (it really rolled back) resolves NOT_COMMITTED; an acquisition whose COMMIT
//                  is still IN FLIGHT holds the account rows, so the resolution waits for its real outcome.
//   LOCK ORDER     [correction 1] the resolution keeps the Stage 1B1 certificate-before-lease order in all three
//                  fence cases (names our lease / IDLE / names another lease on another certificate) and cannot
//                  deadlock with a concurrent practical operation on the same account.
//   ANOMALIES      [correction 2] tampered durable rows never RESTORE and never assert a closure: the strict
//                  parser rejects some before classification (a COMPLETED or deleted lease still named by the
//                  fence -> malformed latch); the rest are classified; every anomaly leaves the receipt
//                  permanently mint-disabled, even after the rows are hand-repaired.
//   D1             the receipt never appears in the error's details, JSON, inspect output, or real logger lines.
//
// Read-only resolution: no Phase 17 write, no reconciliation lock, no gateway. Failures are injected by TEST-ONLY
// client wrappers (no production failpoint, no trigger). NOTHING HERE TOUCHES COINDCX.
//
// ACCEPTANCE SEMANTICS: soft-skips without a reachable local MySQL; with
// REQUIRE_LIVE_PRACTICAL_CANCEL_UNKNOWN_ACQUIRE_DB_INTEGRATION=1 `beforeAll` THROWS instead. It always uses its own
// disposable database, dropped afterwards (also after a partial provisioning failure), and refuses, before any
// mysql/prisma command, a DATABASE_URL that is not mysql: on localhost / 127.0.0.1 / ::1 / [::1].

const STRICT = process.env['REQUIRE_LIVE_PRACTICAL_CANCEL_UNKNOWN_ACQUIRE_DB_INTEGRATION'] === '1';
const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = generateDisposableDatabaseName();

let lifecycle: DisposableMysqlLifecycle | null = null;
let dbAvailable = false;
let connectionA: PrismaClient;
let connectionB: PrismaClient;
let observer: PrismaClient;

beforeAll(async () => {
  if (!BASE_DATABASE_URL) {
    if (STRICT) throw new Error('[P18B-W2B2c-DB] REQUIRE_LIVE_PRACTICAL_CANCEL_UNKNOWN_ACQUIRE_DB_INTEGRATION=1 but no DATABASE_URL is configured.');
    return;
  }
  let guarded: DisposableMysqlLifecycle;
  try {
    guarded = new DisposableMysqlLifecycle({ rawBaseUrl: BASE_DATABASE_URL, name: SHADOW_DB_NAME, strict: STRICT });
  } catch (error) {
    const reason = error instanceof DisposableMysqlGuardError ? error.message : (error as Error).name;
    if (STRICT) throw new Error(`[P18B-W2B2c-DB] strict mode refused to provision: ${reason}`);
    console.warn(`P18B Wave 2B2c unknown-acquire DB suite skipped: ${reason}`);
    return;
  }
  lifecycle = guarded;
  try {
    guarded.createDatabase();
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      stdio: 'pipe', timeout: 120_000, shell: true, env: { ...process.env, DATABASE_URL: guarded.databaseUrl() },
    });
    connectionA = guarded.track(new PrismaClient({ datasources: { db: { url: guarded.databaseUrl() } } }));
    connectionB = guarded.track(new PrismaClient({ datasources: { db: { url: guarded.databaseUrl() } } }));
    observer = guarded.track(new PrismaClient({ datasources: { db: { url: guarded.databaseUrl({ connection_limit: '2' }) } } }));
    for (const client of [connectionA, connectionB, observer]) await client.$queryRawUnsafe('SELECT 1');
    dbAvailable = true;
  } catch (error) {
    dbAvailable = false;
    let cleanupFailure = '';
    try {
      await guarded.cleanup();
    } catch (cleanupError) {
      cleanupFailure = `; cleanup ALSO failed: ${cleanupError instanceof DisposableMysqlGuardError ? cleanupError.message : (cleanupError as Error).name}`;
    }
    if (STRICT) throw new Error(`[P18B-W2B2c-DB] strict mode could not provision a disposable MySQL database: ${(error as Error).name}${cleanupFailure}`);
  }
}, 180_000);

afterAll(async () => {
  dbAvailable = false;
  if (lifecycle !== null) await lifecycle.cleanup();
}, 30_000);

function skip(): boolean {
  if (dbAvailable) return false;
  if (STRICT) throw new Error('[P18B-W2B2c-DB] strict mode reached a test body with no database connection.');
  console.warn('P18B Wave 2B2c unknown-acquire DB suite skipped: no reachable disposable MySQL. Set REQUIRE_LIVE_PRACTICAL_CANCEL_UNKNOWN_ACQUIRE_DB_INTEGRATION=1 to make this hard.');
  return true;
}

// ---------------------------------------------------------------------------
// Fixtures (real certification, real Wave 2B1 acquire)
// ---------------------------------------------------------------------------

const IDENTITY = newLiveRuntimeIdentity();
const EPOCH = readLiveRuntimeEpoch(IDENTITY)!;
const GENERATION = 1;
const T0 = 1_700_000_000_000;
const NOW = T0 + 60_000;
const RESOLVE_AT = NOW + 2_000;
const CLOSE_AT = NOW + 5_000;
const FINGERPRINT = providerAccountFingerprint('w2b2c-fake-coindcx-account');

let sequence = 0;
function freshAccount(): string {
  sequence += 1;
  return `w2b2c-acct-${sequence}-${randomBytes(4).toString('hex')}`;
}

function enablementFor(accountId: string): PracticalLiveSafetyEnablement {
  const resolution = issuePracticalLiveSafetyEnablement({ LIVE_PRACTICAL_SAFETY_ENABLED: 'true', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: accountId });
  if (resolution.status !== 'ENABLED') throw new Error('fixture enablement');
  return resolution.enablement;
}

function expectationOf(account: PracticalAccountSnapshot) {
  return { accountId: account.accountId, runtimeEpoch: account.fence.runtimeEpoch, reconciliationGeneration: account.fence.reconciliationGeneration, revision: account.fence.revision };
}

function practical(client: PrismaClient = connectionA): PrismaPracticalSafetyRepository {
  return new PrismaPracticalSafetyRepository(client);
}

function store(client: PrismaClient = connectionA): PrismaPracticalCancelMutationStore {
  return new PrismaPracticalCancelMutationStore(client);
}

function execution(client: PrismaClient = connectionA): PrismaLiveExecutionRepository {
  return new PrismaLiveExecutionRepository(client);
}

async function healthyReconciliation(accountId: string, generation: number): Promise<void> {
  const state = {
    status: 'HEALTHY' as const, currentGeneration: generation, currentRunId: `recon-run-w2b2c-${generation}`, currentRuntimeEpoch: EPOCH,
    healthyGeneration: generation, blockingFindingCount: 0, revision: generation,
  };
  await connectionA.liveReconciliationState.upsert({ where: { accountId }, create: { accountId, ...state }, update: state } as never);
}

function issueCertificate(accountId: string, generation: number, issuedAtMs: number, marker: string): PracticalRecoveryCertificate {
  return issuePracticalRecoveryCertificate({
    enablement: enablementFor(accountId),
    bindings: { accountId, providerAccountFingerprint: FINGERPRINT, runtimeEpoch: EPOCH, reconciliationGeneration: generation, streamIncarnation: generation },
    evidence: { evidenceDigest: marker.repeat(64), passCount: 3, certificationSpanMs: 30_000, minimumObservedPassSpacingMs: 10_000 },
    issuedAtMs,
  });
}

async function certified(accountId: string): Promise<{ account: PracticalAccountSnapshot; certificate: PracticalRecoveryCertificate }> {
  const start = (await practical().initializeAccount({ accountId, runtimeEpoch: EPOCH, reconciliationGeneration: 0, nowMs: T0 - 50_000 })).account;
  const certifying = await practical().startCertification({ accountId, expected: expectationOf(start), runId: 'run-w2b2c', nowMs: T0 - 40_000 });
  const certificate = issueCertificate(accountId, GENERATION, T0, 'e');
  const account = await practical().finishCertification({ accountId, expected: expectationOf(certifying), runId: 'run-w2b2c', resultingGeneration: GENERATION, certificate, nowMs: T0 });
  await healthyReconciliation(accountId, GENERATION);
  return { account, certificate };
}

function intentRecord(accountId: string): LiveExecutionIntentRecord {
  sequence += 1;
  const tag = `${randomBytes(4).toString('hex')}${sequence.toString(16).padStart(4, '0')}`;
  return {
    intentId: `${'0'.repeat(52)}${tag}`,
    clientOrderId: `p17-${'0'.repeat(20)}${tag}`,
    wireOrderType: 'limit_order', quantityAdjusted: false, priceAdjusted: false,
    content: {
      accountId, pair: 'B-BTC_USDT', side: 'BUY', action: 'OPEN', quantity: '0.5', orderType: 'LIMIT', price: '64000.5', timeInForce: 'UNSPECIFIED', leverage: '5',
      riskDecisionId: 'risk-w2b2c', admissionId: `admission-w2b2c-${tag}`, strategyInstanceId: 'instance-w2b2c', strategyId: 'EMA_TREND', strategyVersion: '1.0.0',
      parameterHash: 'p'.repeat(64), liveExecutionPolicyId: 'policy-w2b2c', instrumentSpecSnapshotId: 'spec-w2b2c', authorizedNotionalInr: '2560020',
      settlementRateInrPerQuote: '80', positionInstanceId: null, positionRevision: null, reduceOnlyQuantity: null,
    },
    lineage: {
      researchApproval: { validationSubjectId: 'subject-w2b2c', validationPlanId: 'plan-w2b2c', validationSubjectResultSha256: 'r'.repeat(64) },
      sourceStrategyDecisionId: 'decision-w2b2c',
    },
  };
}

interface Seeded {
  readonly accountId: string;
  readonly order: LiveExecutionIntentRecord;
  readonly exchangeOrderId: string;
  readonly account: PracticalAccountSnapshot;
  readonly certificate: PracticalRecoveryCertificate;
}

async function seeded(): Promise<Seeded> {
  const accountId = freshAccount();
  const { account, certificate } = await certified(accountId);
  const order = intentRecord(accountId);
  await execution().ensureIntent(order);
  const exchangeOrderId = `venue-${randomBytes(4).toString('hex')}`;
  await connectionA.liveOrder.update({ where: { intentId: order.intentId }, data: { state: 'ACKNOWLEDGED', exchangeOrderId, revision: 2 } });
  return { accountId, order, exchangeOrderId, account, certificate };
}

function acquireInput(seed: Seeded, overrides: Partial<{ certificate: PracticalRecoveryCertificate; account: PracticalAccountSnapshot; trustedNowMs: number }> = {}) {
  return {
    accountId: seed.accountId, expected: expectationOf(overrides.account ?? seed.account), certificate: overrides.certificate ?? seed.certificate,
    enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, intentId: seed.order.intentId, trustedNowMs: overrides.trustedNowMs ?? NOW,
  };
}

// ----- test-only client wrappers ------------------------------------------------

class ForcedRollback extends Error {}

/** The transaction COMMITS for real, then the client reports a lost connection: an UNKNOWN outcome, durably committed. */
function commitLostClient(base: PrismaClient = connectionA): PrismaClient {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return async (work: unknown, options: unknown) => {
          await (target.$transaction as (w: unknown, o: unknown) => Promise<unknown>)(work, options);
          throw new Prisma.PrismaClientKnownRequestError('connection lost after COMMIT', { code: 'P1017', clientVersion: 'test' });
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** The work COMPLETES, then MySQL really rolls it back, and the client reports a lost connection: UNKNOWN, durably nothing. */
function rollbackLostClient(base: PrismaClient = connectionA): PrismaClient {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return async (work: (tx: unknown) => Promise<unknown>, options: unknown) => {
          try {
            await (target.$transaction as (w: (tx: unknown) => Promise<unknown>, o: unknown) => Promise<unknown>)(async (tx) => {
              await work(tx);
              throw new ForcedRollback('roll the completed work back');
            }, options);
          } catch (error) {
            if (!(error instanceof ForcedRollback)) throw error;
          }
          throw new Prisma.PrismaClientKnownRequestError('connection lost before the COMMIT was confirmed', { code: 'P1017', clientVersion: 'test' });
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/**
 * The work COMPLETES and the client reports a lost connection AT ONCE, while the REAL transaction stays open (holding
 * every lock it took) until the test decides its real outcome: COMMIT or ROLLBACK.
 */
function heldCommitClient(base: PrismaClient): { client: PrismaClient; decide: (commit: boolean) => Promise<void> } {
  let workDone!: () => void;
  const done = new Promise<void>((resolve) => { workDone = resolve; });
  let open!: (commit: boolean) => void;
  const gate = new Promise<boolean>((resolve) => { open = resolve; });
  let settled: Promise<unknown> = Promise.resolve();
  const client = new Proxy(base, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return async (work: (tx: unknown) => Promise<unknown>, options: Record<string, unknown>) => {
          settled = (target.$transaction as (w: (tx: unknown) => Promise<unknown>, o: unknown) => Promise<unknown>)(async (tx) => {
            const value = await work(tx);
            workDone();
            if (!(await gate)) throw new ForcedRollback('the in-flight transaction really rolls back');
            return value;
          }, { ...options, timeout: 60_000 }).catch((error: unknown) => { if (!(error instanceof ForcedRollback)) throw error; });
          await done;
          throw new Prisma.PrismaClientKnownRequestError('connection lost while the COMMIT was in flight', { code: 'P1017', clientVersion: 'test' });
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { client, decide: async (commit) => { open(commit); await settled; } };
}

/** Throws a simulated deadlock (P2034) for the first `times` transactions, then passes through. */
function deadlockingClient(times: number): PrismaClient {
  let remaining = times;
  return new Proxy(connectionA, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return async (work: unknown, options: unknown) => {
          if (remaining > 0) {
            remaining -= 1;
            throw new Prisma.PrismaClientKnownRequestError('simulated deadlock', { code: 'P2034', clientVersion: 'test' });
          }
          return (target.$transaction as (w: unknown, o: unknown) => Promise<unknown>)(work, options);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** Counts every interactive transaction attempt (a deadlock victim is retried as a SECOND attempt). */
function countingClient(base: PrismaClient): { client: PrismaClient; attempts: () => number } {
  let attempts = 0;
  const client = new Proxy(base, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return async (work: unknown, options: unknown) => {
          attempts += 1;
          return (target.$transaction as (w: unknown, o: unknown) => Promise<unknown>)(work, options);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { client, attempts: () => attempts };
}

class InjectedFault extends Error {}

/** The FIRST review-episode insert fails (the manual-review escalation cannot be confirmed); later ones pass. */
function reviewFailingOnceClient(): PrismaClient {
  let calls = 0;
  return connectionA.$extends({
    query: { livePracticalReviewEpisode: { async create({ args, query }: { args: unknown; query: (a: unknown) => Promise<unknown> }) { calls += 1; if (calls === 1) throw new InjectedFault('review insert failed'); return query(args); } } },
  } as never) as unknown as PrismaClient;
}

async function tamperWithoutForeignKeys(statements: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<void> {
  await connectionA.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
    try {
      await statements(tx);
    } finally {
      await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
    }
  });
}

/** Holds row locks on the observer connection until released (the locking reads are the ones given). */
async function holdLocks(statements: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<{ release: () => Promise<void> }> {
  let mayCommit!: () => void;
  const released = new Promise<void>((resolve) => { mayCommit = resolve; });
  let locked!: () => void;
  const hasLocks = new Promise<void>((resolve) => { locked = resolve; });
  const holder = observer.$transaction(async (tx) => {
    await statements(tx);
    locked();
    await released;
  }, { timeout: 60_000, maxWait: 10_000 });
  await hasLocks;
  return { release: async () => { mayCommit(); await holder; } };
}

/** True when `promise` is still pending after `ms` (it is blocked on a lock). */
async function stillPending(promise: Promise<unknown>, ms = 2_000): Promise<boolean> {
  const marker = Symbol('pending');
  const outcome = await Promise.race([promise.then(() => null, () => null), new Promise((resolve) => { setTimeout(() => resolve(marker), ms); })]);
  return outcome === marker;
}

// ----- durable snapshots ----------------------------------------------------------

async function practicalRows(accountId: string) {
  const [state, fence, leases, certificates, reviews, recoveries, latch] = await Promise.all([
    connectionA.livePracticalAccountState.findUnique({ where: { accountId } }),
    connectionA.livePracticalAccountFence.findUnique({ where: { accountId } }),
    connectionA.livePracticalMutationLease.findMany({ where: { accountId }, orderBy: { leaseId: 'asc' } }),
    connectionA.livePracticalCertificate.findMany({ where: { accountId }, orderBy: { certificateId: 'asc' } }),
    connectionA.livePracticalReviewEpisode.findMany({ where: { accountId }, orderBy: { reviewEpisodeId: 'asc' } }),
    connectionA.livePracticalRecoveryEpisode.findMany({ where: { accountId }, orderBy: { episodeId: 'asc' } }),
    connectionA.livePracticalMalformedLatch.findUnique({ where: { accountId } }),
  ]);
  return { state, fence, leases, certificates, reviews, recoveries, latch };
}

/** Every row a resolution could touch: both durable sides, the intent, order events, and the reconciliation rows. */
async function everything(seed: Seeded) {
  const [order, events, intent, reconciliation, findings] = await Promise.all([
    connectionA.liveOrder.findUnique({ where: { intentId: seed.order.intentId } }),
    connectionA.liveOrderEvent.findMany({ where: { intentId: seed.order.intentId } }),
    connectionA.liveExecutionIntent.findUnique({ where: { intentId: seed.order.intentId } }),
    connectionA.liveReconciliationState.findUnique({ where: { accountId: seed.accountId } }),
    connectionA.liveReconciliationFinding.findMany({ where: { accountId: seed.accountId }, orderBy: { findingId: 'asc' } }),
  ]);
  return { order, events, intent, reconciliation, findings, ...(await practicalRows(seed.accountId)) };
}

// ----- genuine unknown acquisitions -------------------------------------------------

interface Unknown extends Seeded {
  readonly error: PracticalAcquireCommitUnknownError;
  readonly receipt: PracticalUnknownAcquire;
}

async function unknownAcquire(client: PrismaClient, seed?: Seeded): Promise<Unknown> {
  const base = seed ?? await seeded();
  const error = await store(client).acquireCancelLease(acquireInput(base)).then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(PracticalAcquireCommitUnknownError);
  const receipt = readPracticalUnknownAcquireReceipt(error);
  expect(PracticalUnknownAcquire.status(receipt)).toBe('PENDING');
  return { ...base, error: error as PracticalAcquireCommitUnknownError, receipt: receipt! };
}

/** A GENUINE commit-lost acquisition: it REALLY committed (one LEASED unarmed bound lease), and no handle exists anywhere. */
async function committedUnknown(): Promise<Unknown & { readonly leaseId: string }> {
  const unknown = await unknownAcquire(commitLostClient());
  const rows = await practicalRows(unknown.accountId);
  expect(rows.leases).toHaveLength(1);
  expect(rows.leases[0]).toMatchObject({ status: 'LEASED', armedAtMs: null, intentId: unknown.order.intentId, cancelGeneration: 1 });
  expect(rows.fence).toMatchObject({ mode: 'MUTATION_LEASED', leaseId: rows.leases[0]!.leaseId });
  return { ...unknown, leaseId: rows.leases[0]!.leaseId };
}

/** A GENUINE rollback-lost acquisition: the work completed, MySQL rolled it back; durably NOTHING changed. */
async function rolledBackUnknown(seed?: Seeded): Promise<Unknown> {
  const base = seed ?? await seeded();
  const before = await everything(base);
  const unknown = await unknownAcquire(rollbackLostClient(), base);
  expect(await everything(base)).toEqual(before);
  expect(before.leases).toHaveLength(0);
  return unknown;
}

const resolveInput = (receipt: unknown, overrides: Record<string, unknown> = {}) => ({ unknown: receipt, runtimeIdentity: IDENTITY, trustedNowMs: RESOLVE_AT, ...overrides });

async function refusedWith(receipt: unknown, client: PrismaClient = connectionA): Promise<PracticalMutationError> {
  const error = await store(client).resolveUnknownAcquire(resolveInput(receipt)).then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(PracticalMutationError);
  expect((error as PracticalMutationError).code).toBe('PRACTICAL_MUTATION_RECOVERY_REFUSED');
  return error as PracticalMutationError;
}

/** After an escalated anomaly, only the account's review state changed: nothing on either durable side was written. */
function expectOnlyReviewEntered(before: Awaited<ReturnType<typeof everything>>, after: Awaited<ReturnType<typeof everything>>): void {
  for (const key of ['order', 'events', 'intent', 'reconciliation', 'findings', 'leases', 'certificates'] as const) {
    expect(after[key], key).toEqual(before[key]);
  }
  expect({ mode: after.fence!.mode, leaseId: after.fence!.leaseId, certificateId: after.fence!.certificateId })
    .toEqual({ mode: before.fence!.mode, leaseId: before.fence!.leaseId, certificateId: before.fence!.certificateId });
  expect(after.state!.state).toBe('MANUAL_REVIEW_REQUIRED');
  const added = after.reviews.filter((review) => !before.reviews.some((earlier) => earlier.reviewEpisodeId === review.reviewEpisodeId));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ kind: 'INVALIDATION', reason: 'POST_MUTATION_MISMATCH', status: 'OPEN' });
  expect(after.latch).toBeNull();
  // The ONE recovery-episode change the reviewed Stage 1B1 review entry makes: an OPEN episode is ended as
  // ESCALATED_TO_MANUAL_REVIEW, linked to the new review, at the resolution instant. Nothing else changes.
  expect(after.recoveries).toHaveLength(before.recoveries.length);
  for (const [index, episode] of before.recoveries.entries()) {
    const escalated = episode.status === 'OPEN'
      ? { ...episode, status: 'ESCALATED_TO_MANUAL_REVIEW', endedAtMs: BigInt(RESOLVE_AT), reviewEpisodeId: added[0]!.reviewEpisodeId }
      : episode;
    expect(after.recoveries[index], episode.episodeId).toEqual(escalated);
  }
}

// ---------------------------------------------------------------------------
// K. The discriminator
// ---------------------------------------------------------------------------

describe('P18B-W2B2c-DB K: an unknown acquisition is decided from the locked durable rows alone', () => {
  it('K1: COMMITTED (commit lost): RESTORED is the intended handle, unchanged; the resolution writes nothing; the handle then arms and closes', async () => {
    if (skip()) return;
    const unknown = await committedUnknown();
    const before = await everything(unknown);
    const result = await store().resolveUnknownAcquire(resolveInput(unknown.receipt));
    expect(result.kind).toBe('RESTORED');
    if (result.kind !== 'RESTORED') throw new Error('unreachable');
    expect(await everything(unknown)).toEqual(before);
    const record = PracticalAcquiredCancel.read(result.acquired)!;
    expect(record).toMatchObject({ accountId: unknown.accountId, leaseId: unknown.leaseId, intentId: unknown.order.intentId, cancelGeneration: 1, exchangeOrderId: unknown.exchangeOrderId, leaseCreatedAtMs: NOW });
    expect(PracticalAcquiredCancel.status(result.acquired)).toBe('AVAILABLE');
    expect(PracticalUnknownAcquire.status(unknown.receipt)).toBe('SPENT');
    const armed = await store().armCancelLease({ acquired: result.acquired, enablement: enablementFor(unknown.accountId), runtimeIdentity: IDENTITY, trustedNowMs: NOW + 1_000 });
    expect((await store().completeUndispatchedCancel({ armed: armed.ticket, report: { kind: 'NOT_DISPATCHED', reason: 'ABORTED_BEFORE_DISPATCH' }, trustedNowMs: CLOSE_AT })).kind).toBe('COMPLETED');
    await expect(store().resolveUnknownAcquire(resolveInput(unknown.receipt))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
  });

  it('K2: ROLLED BACK (the work completed, MySQL rolled it back): NOT_COMMITTED; nothing written; the same certificate then acquires under a NEW lease id', async () => {
    if (skip()) return;
    const unknown = await rolledBackUnknown();
    const before = await everything(unknown);
    expect(await store().resolveUnknownAcquire(resolveInput(unknown.receipt))).toEqual({ kind: 'NOT_COMMITTED', certificateStatus: 'ISSUED' });
    expect(await everything(unknown)).toEqual(before);
    expect(PracticalUnknownAcquire.status(unknown.receipt)).toBe('SPENT');
    const acquired = await store().acquireCancelLease(acquireInput(unknown));
    expect(acquired.kind).toBe('ACQUIRED');
  });

  it.each([['COMMITS', 'RESTORED', true], ['ROLLS BACK', 'NOT_COMMITTED', false]] as const)(
    'K3: the COMMIT is still IN FLIGHT: the resolution WAITS on the account rows, then sees the real outcome (%s -> %s)',
    { timeout: 60_000 },
    async (_label, expected, commit) => {
      if (skip()) return;
      const seed = await seeded();
      const held = heldCommitClient(connectionB);
      const unknown = await unknownAcquire(held.client, seed);
      const resolution = store(connectionA).resolveUnknownAcquire(resolveInput(unknown.receipt));
      expect(await stillPending(resolution)).toBe(true);
      await held.decide(commit);
      expect((await resolution).kind).toBe(expected);
    },
  );

  it('K4: a DUPLICATE acquisition with the same certificate, intent, and instant: the rolled-back one is NOT_COMMITTED; the winner keeps the only handle', async () => {
    if (skip()) return;
    const unknown = await rolledBackUnknown();
    const winner = await store().acquireCancelLease(acquireInput(unknown));
    if (winner.kind !== 'ACQUIRED') throw new Error('fixture: winner');
    const before = await everything(unknown);
    expect(await store().resolveUnknownAcquire(resolveInput(unknown.receipt))).toEqual({ kind: 'NOT_COMMITTED', certificateStatus: 'CONSUMED_BY_ANOTHER_LEASE' });
    expect(await everything(unknown)).toEqual(before);
    const armed = await store().armCancelLease({ acquired: winner.acquired, enablement: enablementFor(unknown.accountId), runtimeIdentity: IDENTITY, trustedNowMs: NOW + 1_000 });
    expect(PracticalAcquiredCancel.status(winner.acquired)).toBe('SPENT');
    expect(armed.kind).toBe('ARMED');
  });

  it('K5: single use: two concurrent resolutions mint at most one handle; forged, cloned, spent, or other-epoch receipts are refused', async () => {
    if (skip()) return;
    const unknown = await committedUnknown();
    await expect(store().resolveUnknownAcquire(resolveInput({ ...unknown.receipt }))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    await expect(store().resolveUnknownAcquire(resolveInput(unknown.receipt, { runtimeIdentity: newLiveRuntimeIdentity() }))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    expect(PracticalUnknownAcquire.status(unknown.receipt)).toBe('PENDING');
    const results = await Promise.allSettled([
      store(connectionA).resolveUnknownAcquire(resolveInput(unknown.receipt)),
      store(connectionB).resolveUnknownAcquire(resolveInput(unknown.receipt)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    await expect(store().resolveUnknownAcquire(resolveInput(unknown.receipt))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
  });

  it('K6: invalidated to QUARANTINED and reconciliation RUNNING after the commit: RESTORED (cleanup parity); arm refuses it; abandon closes both sides', async () => {
    if (skip()) return;
    const unknown = await committedUnknown();
    await practical().invalidate({ accountId: unknown.accountId, reason: 'WS_DISCONNECTED', nowMs: NOW + 1 });
    await new PrismaLiveReconciliationRepository(connectionA).claimGeneration(unknown.accountId, newLiveRuntimeIdentity(), NOW + 2);
    const result = await store().resolveUnknownAcquire(resolveInput(unknown.receipt));
    if (result.kind !== 'RESTORED') throw new Error('expected RESTORED');
    await expect(store().armCancelLease({ acquired: result.acquired, enablement: enablementFor(unknown.accountId), runtimeIdentity: IDENTITY, trustedNowMs: NOW + 1_000 }))
      .rejects.toBeInstanceOf(Error);
    expect(PracticalAcquiredCancel.status(result.acquired)).toBe('AVAILABLE');
    expect((await store().abandonAcquiredCancel({ acquired: result.acquired, trustedNowMs: CLOSE_AT })).kind).toBe('COMPLETED');
    expect((await orderOf(unknown)).cancelState).toBe('NONE');
  });

  it('K8: no reconciliation lock: the resolution completes while another connection holds live_reconciliation_state FOR UPDATE', { timeout: 60_000 }, async () => {
    if (skip()) return;
    const unknown = await committedUnknown();
    const holder = await holdLocks((tx) => tx.$executeRaw`SELECT account_id FROM live_reconciliation_state WHERE account_id = ${unknown.accountId} FOR UPDATE`);
    const resolution = store().resolveUnknownAcquire(resolveInput(unknown.receipt));
    const blocked = await stillPending(resolution, 8_000);
    await holder.release();
    expect(blocked).toBe(false);
    expect((await resolution).kind).toBe('RESTORED');
  });

  it('K10: D4: the read-only resolution\'s own COMMIT is unknown: the receipt is PENDING again, nothing changed, and the retry RESTORES', async () => {
    if (skip()) return;
    const unknown = await committedUnknown();
    const before = await everything(unknown);
    await expect(store(commitLostClient()).resolveUnknownAcquire(resolveInput(unknown.receipt))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    expect(PracticalUnknownAcquire.status(unknown.receipt)).toBe('PENDING');
    expect(await everything(unknown)).toEqual(before);
    expect((await store().resolveUnknownAcquire(resolveInput(unknown.receipt))).kind).toBe('RESTORED');
  });

  it('K11: one deadlock is retried inside ONE call; exhausted deadlock retries are a FAULT with the receipt PENDING', async () => {
    if (skip()) return;
    const unknown = await committedUnknown();
    await expect(store(deadlockingClient(3)).resolveUnknownAcquire(resolveInput(unknown.receipt))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_FAULT' });
    expect(PracticalUnknownAcquire.status(unknown.receipt)).toBe('PENDING');
    expect((await store(deadlockingClient(1)).resolveUnknownAcquire(resolveInput(unknown.receipt))).kind).toBe('RESTORED');
  });

  it('K12: without the receipt nothing in-process releases the account: a retried acquisition is refused with zero change', async () => {
    if (skip()) return;
    const unknown = await committedUnknown();
    const before = await everything(unknown);
    await expect(store().acquireCancelLease(acquireInput(unknown))).rejects.toBeInstanceOf(Error);
    expect(await everything(unknown)).toEqual(before);
  });

  it('K13/K14: after RESTORED the interlock still refuses a Tier-A claim of the bound order; after the abandon a Tier-A claim moves to generation 2', async () => {
    if (skip()) return;
    const unknown = await committedUnknown();
    const result = await store().resolveUnknownAcquire(resolveInput(unknown.receipt));
    if (result.kind !== 'RESTORED') throw new Error('expected RESTORED');
    const reconciliation = new PrismaLiveReconciliationRepository(connectionA);
    const before = await everything(unknown);
    const blocked = await reconciliation.authorizeCurrentHealthy(unknown.accountId, IDENTITY)
      .then(({ authorization }) => execution().claimCancel(unknown.order.intentId, unknown.accountId, authorization))
      .then((claim) => claim, (error: unknown) => error);
    expect(blocked).not.toMatchObject({ kind: 'CLAIMED' });
    expect(await everything(unknown)).toEqual(before);
    expect((await store().abandonAcquiredCancel({ acquired: result.acquired, trustedNowMs: CLOSE_AT })).kind).toBe('COMPLETED');
    const rows = await practicalRows(unknown.accountId);
    expect(rows.state!.state).not.toBe('CERTIFIED_IDLE');
    expect(rows.certificates.every((certificate) => certificate.status !== 'ISSUED')).toBe(true);
    const { authorization } = await reconciliation.authorizeCurrentHealthy(unknown.accountId, IDENTITY);
    expect(await execution().claimCancel(unknown.order.intentId, unknown.accountId, authorization)).toMatchObject({ kind: 'CLAIMED', generation: 2 });
  });
});

async function orderOf(seed: Seeded) {
  return connectionA.liveOrder.findUniqueOrThrow({ where: { intentId: seed.order.intentId } });
}

// ---------------------------------------------------------------------------
// LK. [Correction 1] Lock order: certificates before leases, in all three fence cases
// ---------------------------------------------------------------------------

describe('P18B-W2B2c-DB LK: the resolution keeps the Stage 1B1 certificate-before-lease order and cannot deadlock', () => {
  it.each(['certificate', 'lease'] as const)('LK1 (the fence names OUR lease): a held %s row lock blocks the resolution until released; then RESTORED', { timeout: 60_000 }, async (row) => {
    if (skip()) return;
    const unknown = await committedUnknown();
    const certificateId = (await practicalRows(unknown.accountId)).certificates[0]!.certificateId;
    const holder = await holdLocks((tx) => row === 'certificate'
      ? tx.$executeRaw`SELECT certificate_id FROM live_practical_certificate WHERE certificate_id = ${certificateId} FOR UPDATE`
      : tx.$executeRaw`SELECT lease_id FROM live_practical_mutation_lease WHERE lease_id = ${unknown.leaseId} FOR UPDATE`);
    const counted = countingClient(connectionA);
    const resolution = store(counted.client).resolveUnknownAcquire(resolveInput(unknown.receipt));
    expect(await stillPending(resolution)).toBe(true);
    await holder.release();
    expect((await resolution).kind).toBe('RESTORED');
    expect(counted.attempts()).toBe(1);
  });

  it('LK2 (the fence is IDLE; the attempt rolled back; CERTIFIED_IDLE locks our certificate as the CURRENT one): a held certificate lock blocks it; then NOT_COMMITTED', { timeout: 60_000 }, async () => {
    if (skip()) return;
    const unknown = await rolledBackUnknown();
    const certificateId = (await practicalRows(unknown.accountId)).certificates[0]!.certificateId;
    expect((await practicalRows(unknown.accountId)).state!.state).toBe('CERTIFIED_IDLE');
    const holder = await holdLocks((tx) => tx.$executeRaw`SELECT certificate_id FROM live_practical_certificate WHERE certificate_id = ${certificateId} FOR UPDATE`);
    const counted = countingClient(connectionA);
    const resolution = store(counted.client).resolveUnknownAcquire(resolveInput(unknown.receipt));
    expect(await stillPending(resolution)).toBe(true);
    await holder.release();
    expect(await resolution).toEqual({ kind: 'NOT_COMMITTED', certificateStatus: 'ISSUED' });
    expect(counted.attempts()).toBe(1);
  });

  it('LK3 (the fence names ANOTHER lease on ANOTHER certificate): our certificate is locked AFTER that lease, yet a concurrent practical operation serializes on the account rows: no deadlock, one attempt each', { timeout: 90_000 }, async () => {
    if (skip()) return;
    // A rolls back (certificate C1 stays ISSUED) -> C1 revoked -> recertified with C2 at generation 2 -> B acquires with C2.
    const unknown = await rolledBackUnknown();
    const c1 = (await practicalRows(unknown.accountId)).certificates[0]!.certificateId;
    await practical().revokeCertificate({ accountId: unknown.accountId, certificateId: c1, reason: 'WS_DISCONNECTED', nowMs: NOW + 10 });
    const quarantined = await practical().loadAccount(unknown.accountId);
    if (quarantined.kind !== 'FOUND') throw new Error('fixture: account');
    const T2 = NOW + 1_000;
    const certifying = await practical().startCertification({ accountId: unknown.accountId, expected: expectationOf(quarantined.account), runId: 'run-w2b2c-2', nowMs: T2 - 100 });
    const c2 = issueCertificate(unknown.accountId, 2, T2, 'd');
    const recertified = await practical().finishCertification({ accountId: unknown.accountId, expected: expectationOf(certifying), runId: 'run-w2b2c-2', resultingGeneration: 2, certificate: c2, nowMs: T2 });
    await healthyReconciliation(unknown.accountId, 2);
    const other = await store().acquireCancelLease(acquireInput(unknown, { certificate: c2, account: recertified, trustedNowMs: T2 + 60_000 }));
    if (other.kind !== 'ACQUIRED') throw new Error(`fixture: other acquisition ${other.kind}`);
    const fence = (await practicalRows(unknown.accountId)).fence!;
    expect(fence).toMatchObject({ mode: 'MUTATION_LEASED', certificateId: PracticalAcquiredCancel.read(other.acquired)!.certificate.certificateId });

    // Hold OUR certificate (C1): the resolution holds the account rows, C2 and the other lease, and waits on C1.
    const holder = await holdLocks((tx) => tx.$executeRaw`SELECT certificate_id FROM live_practical_certificate WHERE certificate_id = ${c1} FOR UPDATE`);
    const resolving = countingClient(connectionA);
    const arming = countingClient(connectionB);
    const resolution = store(resolving.client).resolveUnknownAcquire(resolveInput(unknown.receipt));
    expect(await stillPending(resolution)).toBe(true);
    // A concurrent arm of the OTHER lease (C2 -> its lease -> Phase 17) waits on the ACCOUNT rows first: no cycle can form.
    const arm = store(arming.client).armCancelLease({ acquired: other.acquired, enablement: enablementFor(unknown.accountId), runtimeIdentity: IDENTITY, trustedNowMs: T2 + 61_000 });
    expect(await stillPending(arm)).toBe(true);
    await holder.release();
    expect(await resolution).toEqual({ kind: 'NOT_COMMITTED', certificateStatus: 'REVOKED' });
    expect((await arm).kind).toBe('ARMED');
    expect(resolving.attempts()).toBe(1);
    expect(arming.attempts()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A. Anomalies: never RESTORED, never a closure, receipt permanently mint-disabled
// ---------------------------------------------------------------------------

/** An OUT-OF-BAND closure through the real persistence scope and Phase 17 primitive (an unreviewed writer): fully consistent-looking. */
async function closeOutOfBand(unknown: Unknown & { readonly leaseId: string }): Promise<void> {
  const certificateId = (await practicalRows(unknown.accountId)).certificates[0]!.certificateId;
  await connectionA.$transaction(async (tx) => withLockedPracticalAccountWithinCallerTransaction(practical(), tx, unknown.accountId, async (scope) => {
    const order = await tx.liveOrder.findUniqueOrThrow({ where: { intentId: unknown.order.intentId } });
    await scope.requireLeasedOrderBoundCancelLease({
      leaseId: unknown.leaseId, certificateId, runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION,
      binding: { intentId: unknown.order.intentId, clientOrderId: order.clientOrderId, cancelGeneration: 1 },
    });
    await releaseUnarmedCancelClaimWithinCallerFencedTransaction(tx, unknown.order.intentId, 1, unknown.accountId);
    await scope.completeOrderBoundCancelLeaseNoWire(CLOSE_AT);
  }), { timeout: 15_000 });
}

describe('P18B-W2B2c-DB A: an anomaly never RESTORES, never asserts a closure, and leaves the receipt permanently mint-disabled', () => {
  type Tamper = (unknown: Unknown & { readonly leaseId: string }) => Promise<unknown>;
  const CLASSIFIED: readonly (readonly [string, string, Tamper])[] = [
    ['A1', 'a CONSISTENT-LOOKING out-of-band closure (lease COMPLETED PRE_DISPATCH_FAILURE, fence IDLE, Phase 17 NONE)', closeOutOfBand],
    ['A4', 'a COUPLED arm (lease armed_at_ms AND Phase 17 cancel_wire_armed)', async (unknown) => {
      await connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET armed_at_ms = created_at_ms + 1 WHERE lease_id = ${unknown.leaseId}`;
      await connectionA.$executeRaw`UPDATE live_order SET cancel_wire_armed = 1, revision = revision + 1 WHERE intent_id = ${unknown.order.intentId}`;
    }],
    ['A5', 'an armed lease with an unarmed Phase 17 claim', (unknown) => connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET armed_at_ms = created_at_ms + 1 WHERE lease_id = ${unknown.leaseId}`],
    ['A6', 'another lease creation instant', (unknown) => connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET created_at_ms = created_at_ms - 1 WHERE lease_id = ${unknown.leaseId}`],
    ['A7', 'another certificate evidence digest', (unknown) => connectionA.$executeRaw`UPDATE live_practical_certificate SET evidence_digest = ${'d'.repeat(64)} WHERE account_id = ${unknown.accountId}`],
    ['A8', 'a case-only Phase 17 pair change', (unknown) => connectionA.$executeRaw`UPDATE live_order SET pair = LOWER(pair) WHERE intent_id = ${unknown.order.intentId}`],
    ['A9', 'a case-only Phase 17 exchange order id change', (unknown) => connectionA.$executeRaw`UPDATE live_order SET exchange_order_id = UPPER(exchange_order_id) WHERE intent_id = ${unknown.order.intentId}`],
    ['A10', 'a case-only Phase 17 cancel exchange order id change', (unknown) => connectionA.$executeRaw`UPDATE live_order SET cancel_exchange_order_id = UPPER(cancel_exchange_order_id) WHERE intent_id = ${unknown.order.intentId}`],
    ['A11', 'the Phase 17 claim released to NONE at our generation', (unknown) => connectionA.$executeRaw`UPDATE live_order SET cancel_state = 'NONE', revision = revision + 1 WHERE intent_id = ${unknown.order.intentId}`],
    ['A12', 'a LATER Phase 17 generation', (unknown) => connectionA.$executeRaw`UPDATE live_order SET cancel_generation = cancel_generation + 1, revision = revision + 1 WHERE intent_id = ${unknown.order.intentId}`],
    ['A13', 'the Phase 17 order row deleted', (unknown) => tamperWithoutForeignKeys((tx) => tx.$executeRaw`DELETE FROM live_order WHERE intent_id = ${unknown.order.intentId}`)],
    ['A14', 'an out-of-band closure whose lease row was then deleted (a CONSUMED certificate with no lease)', async (unknown) => {
      await closeOutOfBand(unknown);
      await tamperWithoutForeignKeys((tx) => tx.$executeRaw`DELETE FROM live_practical_mutation_lease WHERE lease_id = ${unknown.leaseId}`);
    }],
  ];
  const REASONS: Readonly<Record<string, string>> = {
    A1: 'LEASE_NOT_LEASED', A4: 'LEASE_ARMED', A5: 'LEASE_ARMED', A6: 'LEASE_IDENTITY', A7: 'CERTIFICATE_MISMATCH', A8: 'PHASE17_IDENTITY',
    A9: 'PHASE17_IDENTITY', A10: 'PHASE17_IDENTITY', A11: 'PHASE17_CLAIM', A12: 'PHASE17_CLAIM', A13: 'PHASE17_MISSING', A14: 'ABSENT_BUT_REFERENCED',
  };

  it.each(CLASSIFIED)('%s: %s -> RECOVERY_REFUSED (classified), manual review, no handle, receipt REFUSED', async (id, _name, tamper) => {
    if (skip()) return;
    const unknown = await committedUnknown();
    await tamper(unknown);
    const before = await everything(unknown);
    const error = await refusedWith(unknown.receipt);
    expect(error.details).toMatchObject({ accountId: unknown.accountId, leaseId: unknown.leaseId, reason: REASONS[id], escalated: true });
    expect(PracticalUnknownAcquire.status(unknown.receipt)).toBe('REFUSED');
    expectOnlyReviewEntered(before, await everything(unknown));
    // Idempotent: nothing more is ever done with this receipt.
    await expect(store().resolveUnknownAcquire(resolveInput(unknown.receipt))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
  });

  it.each([
    ['A2', 'a COMPLETED lease STILL NAMED by the leased fence', (unknown: Unknown & { readonly leaseId: string }) =>
      connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET status = 'COMPLETED', outcome = 'PRE_DISPATCH_FAILURE', completed_at_ms = created_at_ms + 5 WHERE lease_id = ${unknown.leaseId}`],
    ['A3', 'a DELETED lease STILL NAMED by the leased fence', (unknown: Unknown & { readonly leaseId: string }) =>
      tamperWithoutForeignKeys((tx) => tx.$executeRaw`DELETE FROM live_practical_mutation_lease WHERE lease_id = ${unknown.leaseId}`)],
  ] as const)('[correction 2] %s: %s: the STRICT PARSER rejects the account first -> ACCOUNT_UNREADABLE, the malformed latch IS the escalation; hand repair never re-enables minting', async (_id, _name, tamper) => {
    if (skip()) return;
    const unknown = await committedUnknown();
    const leaseRow = await connectionA.livePracticalMutationLease.findUniqueOrThrow({ where: { leaseId: unknown.leaseId } });
    await tamper(unknown);
    const before = await everything(unknown);
    const error = await refusedWith(unknown.receipt);
    expect(error.details).toMatchObject({ reason: 'ACCOUNT_UNREADABLE', escalated: true });
    expect(PracticalUnknownAcquire.status(unknown.receipt)).toBe('REFUSED');
    const after = await everything(unknown);
    // The actual result: the parser was NOT weakened; the malformed-state latch (a MALFORMED_STATE review) is durable.
    expect(after.latch).not.toBeNull();
    expect(after.reviews.filter((review) => review.kind === 'MALFORMED_STATE' && review.status === 'OPEN')).toHaveLength(1);
    expect(error.details!['reviewEpisodeId']).toBe(after.latch!.currentReviewEpisodeId);
    for (const key of ['order', 'events', 'intent', 'leases', 'certificates', 'fence'] as const) expect(after[key], key).toEqual(before[key]);
    // HAND REPAIR: put the original lease row back exactly. The rows are restorable again, but the receipt stays refused.
    await tamperWithoutForeignKeys(async (tx) => {
      await tx.$executeRaw`DELETE FROM live_practical_mutation_lease WHERE lease_id = ${unknown.leaseId}`;
      await tx.livePracticalMutationLease.create({ data: leaseRow });
    });
    const repaired = await everything(unknown);
    await expect(store().resolveUnknownAcquire(resolveInput(unknown.receipt))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    expect(await everything(unknown)).toEqual(repaired);
  });

  it('A15: the escalation cannot be confirmed (the review insert fails): ANOMALY_UNESCALATED; after a HAND REPAIR a retry still only escalates -> REFUSED, never a handle', async () => {
    if (skip()) return;
    const unknown = await committedUnknown();
    await connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET armed_at_ms = created_at_ms + 1 WHERE lease_id = ${unknown.leaseId}`;
    const before = await everything(unknown);
    const first = await refusedWith(unknown.receipt, reviewFailingOnceClient());
    expect(first.details).toMatchObject({ reason: 'LEASE_ARMED', escalated: false, reviewEpisodeId: null });
    expect(PracticalUnknownAcquire.status(unknown.receipt)).toBe('ANOMALY_UNESCALATED');
    expect(await everything(unknown)).toEqual(before);
    // Hand repair: the lease is exactly restorable again.
    await connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET armed_at_ms = NULL WHERE lease_id = ${unknown.leaseId}`;
    const repaired = await everything(unknown);
    const retried = await refusedWith(unknown.receipt);
    expect(retried.details).toMatchObject({ reason: 'ANOMALY_PREVIOUSLY_PROVEN', escalated: true });
    expect(PracticalUnknownAcquire.status(unknown.receipt)).toBe('REFUSED');
    expectOnlyReviewEntered(repaired, await everything(unknown));
    await expect(store().resolveUnknownAcquire(resolveInput(unknown.receipt))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
  });

  it('A16: an account ALREADY in manual review: the escalation is PRESERVED (idempotent), still REFUSED with no handle', async () => {
    if (skip()) return;
    const unknown = await committedUnknown();
    await practical().enterManualReview({ accountId: unknown.accountId, reason: 'ORPHAN_ORDER', nowMs: NOW + 1 });
    await connectionA.$executeRaw`UPDATE live_order SET pair = LOWER(pair) WHERE intent_id = ${unknown.order.intentId}`;
    const before = await everything(unknown);
    const error = await refusedWith(unknown.receipt);
    expect(error.details).toMatchObject({ reason: 'PHASE17_IDENTITY', escalated: true, reviewEpisodeId: before.state!.currentReviewEpisodeId });
    expect(await everything(unknown)).toEqual(before);
    expect(PracticalUnknownAcquire.status(unknown.receipt)).toBe('REFUSED');
  });
});

// ---------------------------------------------------------------------------
// D1. The receipt never leaks
// ---------------------------------------------------------------------------

describe('P18B-W2B2c-DB D1: the receipt travels OFF the error and never appears in details, JSON, inspect output, or logs', () => {
  it('K15: a real commit-lost error: the attempted lease id (canary) and the receipt class are in none of the renderings', async () => {
    if (skip()) return;
    const unknown = await committedUnknown();
    const canary = unknown.leaseId;
    const { error, receipt } = unknown;
    expect(error.details).toEqual({ accountId: unknown.accountId });
    expect(Object.keys(error).sort()).toEqual(['code', 'details', 'name']);
    const lines: string[] = [];
    const logger = createRootLogger({ level: 'info', destination: { write: (line: string) => { lines.push(line); } } as never });
    logger.error(error);
    logger.error({ err: error }, 'unknown acquisition');
    logger.warn({ error, details: error.details }, 'unknown acquisition details');
    const errorRenderings = [
      JSON.stringify(error),
      JSON.stringify(redactSensitiveData(error)),
      JSON.stringify(redactSensitiveData({ err: error })),
      inspect(error, { showHidden: true, depth: Infinity }),
      String(error),
      error.message,
      ...lines,
    ];
    expect(lines).toHaveLength(3);
    for (const rendering of errorRenderings) {
      // The error never reaches the receipt: no content and not even its class.
      expect(rendering).not.toContain(canary);
      expect(rendering).not.toContain('PracticalUnknownAcquire');
      expect(rendering).not.toContain(unknown.order.intentId);
    }
    // The receipt itself renders as an EMPTY object (private fields only): its class name, never its content.
    expect(JSON.stringify(receipt)).toBe('{}');
    expect(inspect(receipt, { showHidden: true, depth: Infinity })).toBe('PracticalUnknownAcquire {}');
    // Copies and wrappers never carry it; only the exact error object does.
    expect(readPracticalUnknownAcquireReceipt({ ...error })).toBeNull();
    expect(readPracticalUnknownAcquireReceipt(structuredClone(error))).toBeNull();
    expect(readPracticalUnknownAcquireReceipt(new Error('wrapped', { cause: error }))).toBeNull();
    expect(readPracticalUnknownAcquireReceipt(error)).toBe(receipt);
  });
});
