import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveExecutionIntentRecord } from '../../../src/execution/live/intent';
import { PrismaLiveExecutionRepository } from '../../../src/execution/live/repository';
import { issuePracticalRecoveryCertificate, type PracticalRecoveryCertificate } from '../../../src/execution/live/practical/certificate';
import { issuePracticalLiveSafetyEnablement, type PracticalLiveSafetyEnablement } from '../../../src/execution/live/practical/policy';
import type { PracticalAccountSnapshot } from '../../../src/execution/live/practical-persistence/ports';
import { PracticalDurableContradictionError, PracticalPersistenceError } from '../../../src/execution/live/practical-persistence/ports';
import { PrismaPracticalSafetyRepository } from '../../../src/execution/live/practical-persistence/repository';
import { PracticalLiveSafetyError } from '../../../src/execution/live/practical/types';
import { PrismaPracticalCancelMutationStore } from '../../../src/execution/live/practical-mutation/repository';
import { PracticalAcquiredCancel, PracticalArmedCancel, PracticalUnknownAcquire, readPracticalUnknownAcquireReceipt } from '../../../src/execution/live/practical-mutation/ticket';
import { providerAccountFingerprint } from '../../../src/execution/live/reconciliation/account-identity';
import { newLiveRuntimeIdentity, readLiveRuntimeEpoch, requireCurrentReconciliation } from '../../../src/execution/live/reconciliation/barrier';
import { PrismaLiveReconciliationRepository } from '../../../src/execution/live/reconciliation/repository';
import { LiveReconciliationService } from '../../../src/execution/live/reconciliation/service';
import { DisposableMysqlGuardError, DisposableMysqlLifecycle, generateDisposableDatabaseName } from '../../helpers/p18b-disposable-mysql';
import { EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT, FakeEvidenceProvider, FixedClock, evidenceSet, venueOrder } from '../../unit/execution/live/reconciliation/helpers';

// [P18B-1B2-W2B2d-DB] Real MySQL proof of the Stage 1B2 PREVIOUS-RUNTIME UNARMED leased-fence recovery (M1-M17):
//
//   RECOVER   a MUTATION_LEASED fence left by a previous runtime epoch whose order-bound lease and Phase 17 claim are a
//             coupled UNARMED pair: in ONE commit, the claim released, the lease COMPLETED PRE_DISPATCH_FAILURE through
//             the existing no-wire writer, and the fence adopted by THIS runtime's epoch.
//   REFUSE    this runtime's own lease; an ARMED orphan (evidence + manual review; never released); a split pair; any
//             exact-case identity / generation / certificate mismatch (manual review); a malformed account (the latch).
//   ZOMBIES   an old-epoch process that is still alive: its arm, abandon, no-wire retry, and 2B2c receipt all fail
//             closed after the recovery (both race orderings), never with a false closure or a handle.
//   AFTERWARDS an ordinary reconciliation run is HEALTHY; nothing grants authority; strict Tier-A still refuses.
//
// Failures are injected by TEST-ONLY client wrappers (no production failpoint, no trigger). NOTHING HERE TOUCHES
// COINDCX: the reconciliation evidence provider is the repository's in-memory fake.
//
// ACCEPTANCE SEMANTICS: soft-skips without a reachable local MySQL; with
// REQUIRE_LIVE_PRACTICAL_CANCEL_PREVIOUS_RUNTIME_DB_INTEGRATION=1 `beforeAll` THROWS instead. It always uses its own
// disposable database, dropped afterwards (also after a partial provisioning failure), and refuses, before any
// mysql/prisma command, a DATABASE_URL that is not mysql: on localhost / 127.0.0.1 / ::1 / [::1].

const STRICT = process.env['REQUIRE_LIVE_PRACTICAL_CANCEL_PREVIOUS_RUNTIME_DB_INTEGRATION'] === '1';
const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = generateDisposableDatabaseName();

let lifecycle: DisposableMysqlLifecycle | null = null;
let dbAvailable = false;
let connectionA: PrismaClient;
let connectionB: PrismaClient;
let observer: PrismaClient;

beforeAll(async () => {
  if (!BASE_DATABASE_URL) {
    if (STRICT) throw new Error('[P18B-W2B2d-DB] REQUIRE_LIVE_PRACTICAL_CANCEL_PREVIOUS_RUNTIME_DB_INTEGRATION=1 but no DATABASE_URL is configured.');
    return;
  }
  let guarded: DisposableMysqlLifecycle;
  try {
    guarded = new DisposableMysqlLifecycle({ rawBaseUrl: BASE_DATABASE_URL, name: SHADOW_DB_NAME, strict: STRICT });
  } catch (error) {
    const reason = error instanceof DisposableMysqlGuardError ? error.message : (error as Error).name;
    if (STRICT) throw new Error(`[P18B-W2B2d-DB] strict mode refused to provision: ${reason}`);
    console.warn(`P18B Wave 2B2d previous-runtime DB suite skipped: ${reason}`);
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
    if (STRICT) throw new Error(`[P18B-W2B2d-DB] strict mode could not provision a disposable MySQL database: ${(error as Error).name}${cleanupFailure}`);
  }
}, 180_000);

afterAll(async () => {
  dbAvailable = false;
  if (lifecycle !== null) await lifecycle.cleanup();
}, 30_000);

function skip(): boolean {
  if (dbAvailable) return false;
  if (STRICT) throw new Error('[P18B-W2B2d-DB] strict mode reached a test body with no database connection.');
  console.warn('P18B Wave 2B2d previous-runtime DB suite skipped: no reachable disposable MySQL. Set REQUIRE_LIVE_PRACTICAL_CANCEL_PREVIOUS_RUNTIME_DB_INTEGRATION=1 to make this hard.');
  return true;
}

// ---------------------------------------------------------------------------
// Fixtures: the PREVIOUS runtime (OLD) certifies, acquires, maybe arms, then "dies"; THIS runtime (NEW) recovers.
// ---------------------------------------------------------------------------

const OLD = newLiveRuntimeIdentity();
const OLD_EPOCH = readLiveRuntimeEpoch(OLD)!;
const NEW = newLiveRuntimeIdentity();
const NEW_EPOCH = readLiveRuntimeEpoch(NEW)!;
const GENERATION = 1;
const T0 = 1_700_000_000_000;
const NOW = T0 + 60_000;
const ARM_AT = NOW + 1_000;
const RECOVER_AT = NOW + 10_000;
const FINGERPRINT = providerAccountFingerprint('w2b2d-fake-coindcx-account');

let sequence = 0;
function freshAccount(): string {
  sequence += 1;
  return `w2b2d-acct-${sequence}-${randomBytes(4).toString('hex')}`;
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

async function certified(accountId: string): Promise<{ account: PracticalAccountSnapshot; certificate: PracticalRecoveryCertificate }> {
  const start = (await practical().initializeAccount({ accountId, runtimeEpoch: OLD_EPOCH, reconciliationGeneration: 0, nowMs: T0 - 50_000 })).account;
  const certifying = await practical().startCertification({ accountId, expected: expectationOf(start), runId: 'run-w2b2d', nowMs: T0 - 40_000 });
  const certificate = issuePracticalRecoveryCertificate({
    enablement: enablementFor(accountId),
    bindings: { accountId, providerAccountFingerprint: FINGERPRINT, runtimeEpoch: OLD_EPOCH, reconciliationGeneration: GENERATION, streamIncarnation: 1 },
    evidence: { evidenceDigest: 'e'.repeat(64), passCount: 3, certificationSpanMs: 30_000, minimumObservedPassSpacingMs: 10_000 },
    issuedAtMs: T0,
  });
  const account = await practical().finishCertification({ accountId, expected: expectationOf(certifying), runId: 'run-w2b2d', resultingGeneration: GENERATION, certificate, nowMs: T0 });
  const state = {
    status: 'HEALTHY' as const, currentGeneration: GENERATION, currentRunId: 'recon-run-w2b2d', currentRuntimeEpoch: OLD_EPOCH,
    healthyGeneration: GENERATION, blockingFindingCount: 0, revision: 1,
  };
  await connectionA.liveReconciliationState.upsert({ where: { accountId }, create: { accountId, ...state }, update: state } as never);
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
      riskDecisionId: 'risk-w2b2d', admissionId: `admission-w2b2d-${tag}`, strategyInstanceId: 'instance-w2b2d', strategyId: 'EMA_TREND', strategyVersion: '1.0.0',
      parameterHash: 'p'.repeat(64), liveExecutionPolicyId: 'policy-w2b2d', instrumentSpecSnapshotId: 'spec-w2b2d', authorizedNotionalInr: '2560020',
      settlementRateInrPerQuote: '80', positionInstanceId: null, positionRevision: null, reduceOnlyQuantity: null,
    },
    lineage: {
      researchApproval: { validationSubjectId: 'subject-w2b2d', validationPlanId: 'plan-w2b2d', validationSubjectResultSha256: 'r'.repeat(64) },
      sourceStrategyDecisionId: 'decision-w2b2d',
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

function acquireInput(seed: Seeded, identity: unknown = OLD) {
  return {
    accountId: seed.accountId, expected: expectationOf(seed.account), certificate: seed.certificate,
    enablement: enablementFor(seed.accountId), runtimeIdentity: identity, intentId: seed.order.intentId, trustedNowMs: NOW,
  };
}

interface Leased extends Seeded {
  readonly handle: PracticalAcquiredCancel;
  readonly leaseId: string;
}

/** The PREVIOUS runtime committed an acquisition (its handle is then simply dropped: the process "died"). */
async function leasedByOld(): Promise<Leased> {
  const seed = await seeded();
  const result = await store().acquireCancelLease(acquireInput(seed));
  if (result.kind !== 'ACQUIRED') throw new Error(`fixture acquisition: ${result.kind}`);
  return { ...seed, handle: result.acquired, leaseId: PracticalAcquiredCancel.read(result.acquired)!.leaseId };
}

/** ... and also committed the pre-wire arm (its ticket is dropped). */
async function armedByOld(): Promise<Leased & { readonly ticket: PracticalArmedCancel }> {
  const leased = await leasedByOld();
  const armed = await store().armCancelLease({ acquired: leased.handle, enablement: enablementFor(leased.accountId), runtimeIdentity: OLD, trustedNowMs: ARM_AT });
  return { ...leased, ticket: armed.ticket };
}

const recoverInput = (seed: Seeded, identity: unknown = NEW) => ({ accountId: seed.accountId, runtimeIdentity: identity, trustedNowMs: RECOVER_AT });

// ----- test-only client wrappers ------------------------------------------------

class ForcedRollback extends Error {}

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

type Snapshot = Awaited<ReturnType<typeof everything>>;

/** The exact durable end state of a recovery: both sides closed, the fence adopted by NEW, nothing else touched. */
function expectRecovered(before: Snapshot, after: Snapshot, leaseId: string, state: 'QUARANTINED' | 'MANUAL_REVIEW_REQUIRED' = 'QUARANTINED'): void {
  expect(after.order).toMatchObject({
    state: before.order!.state, cancelState: 'NONE', cancelGeneration: before.order!.cancelGeneration, cancelWireArmed: false, cancelFaultCode: null,
    cancelExchangeOrderId: before.order!.cancelExchangeOrderId, exchangeOrderId: before.order!.exchangeOrderId, revision: before.order!.revision + 1,
  });
  for (const key of ['events', 'intent', 'reconciliation', 'findings', 'certificates', 'latch'] as const) expect(after[key], key).toEqual(before[key]);
  expect(after.certificates.every((certificate) => certificate.status === 'CONSUMED')).toBe(true);
  expect(after.leases).toHaveLength(1);
  expect(after.leases[0]).toMatchObject({
    leaseId, status: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE', armedAtMs: null, completedAtMs: BigInt(RECOVER_AT),
    createdAtMs: before.leases[0]!.createdAtMs, runtimeEpoch: OLD_EPOCH,
  });
  expect(after.fence).toMatchObject({ mode: 'IDLE', leaseId: null, certificateId: null, runtimeEpoch: NEW_EPOCH, revision: before.fence!.revision + 2n });
  expect(after.state!.state).toBe(state);
}

/** A refusal that ROLLED BACK and then entered manual review through the shared call site: nothing else changed. */
function expectReviewedOnly(before: Snapshot, after: Snapshot): void {
  for (const key of ['order', 'events', 'intent', 'reconciliation', 'findings', 'leases', 'certificates', 'latch'] as const) expect(after[key], key).toEqual(before[key]);
  expect(after.fence).toMatchObject({ mode: 'MUTATION_LEASED', runtimeEpoch: OLD_EPOCH, leaseId: before.fence!.leaseId });
  expect(after.state!.state).toBe('MANUAL_REVIEW_REQUIRED');
  const added = after.reviews.filter((review) => !before.reviews.some((earlier) => earlier.reviewEpisodeId === review.reviewEpisodeId));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ kind: 'INVALIDATION', reason: 'POST_MUTATION_MISMATCH', status: 'OPEN' });
}

async function refused(seed: Seeded, reason: string, client: PrismaClient = connectionA, identity: unknown = NEW): Promise<void> {
  await expect(store(client).recoverPreviousRuntimeCancelLease(recoverInput(seed, identity)))
    .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_RECOVERY_REFUSED', details: { accountId: seed.accountId, reason } });
}

/** Standard Stage 1B1 adoption by NEW is still refused while a leased fence remains. */
async function expectAdoptionRefused(seed: Seeded): Promise<void> {
  const load = await practical().loadAccount(seed.accountId);
  if (load.kind !== 'FOUND') throw new Error('fixture: account');
  await expect(practical().adoptForNewRuntime({
    accountId: seed.accountId, previousRuntimeEpoch: OLD_EPOCH, expectedFenceRevision: load.account.fence.revision, newRuntimeEpoch: NEW_EPOCH, nowMs: RECOVER_AT,
  })).rejects.toBeInstanceOf(Error);
}

// ---------------------------------------------------------------------------
// M1-M6: the decision
// ---------------------------------------------------------------------------

describe('P18B-W2B2d-DB M: a previous runtime\'s leased fence, decided from the locked coupled durable pair', () => {
  it('M1: the previous runtime committed an acquisition and died: RECOVERED in ONE commit (claim released, lease PRE_DISPATCH_FAILURE, fence adopted by NEW)', async () => {
    if (skip()) return;
    const leased = await leasedByOld();
    const before = await everything(leased);
    expect(before.fence).toMatchObject({ mode: 'MUTATION_LEASED', runtimeEpoch: OLD_EPOCH });
    expect(await store().recoverPreviousRuntimeCancelLease(recoverInput(leased))).toEqual({
      kind: 'RECOVERED', outcome: 'PRE_DISPATCH_FAILURE', leaseId: leased.leaseId, intentId: leased.order.intentId, cancelGeneration: 1,
    });
    const after = await everything(leased);
    expectRecovered(before, after, leased.leaseId);
    expect(after.reviews).toEqual(before.reviews);
    // Leaving MUTATING opens exactly one recovery episode, caused by the runtime startup.
    const opened = after.recoveries.filter((episode) => !before.recoveries.some((earlier) => earlier.episodeId === episode.episodeId));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ status: 'OPEN', startCause: 'RUNTIME_STARTUP', runtimeEpoch: NEW_EPOCH });
    // Idempotent re-run: nothing leased any more, nothing written, no closure claimed.
    expect(await store().recoverPreviousRuntimeCancelLease(recoverInput(leased))).toEqual({ kind: 'NO_LEASED_FENCE', fenceHeldByThisRuntime: true });
    expect(await everything(leased)).toEqual(after);
  });

  it('M2: the previous runtime\'s acquisition COMMIT was unknown (its receipt dies with it): the same RECOVERED', async () => {
    if (skip()) return;
    const seed = await seeded();
    const error = await store(commitLostClient()).acquireCancelLease(acquireInput(seed)).then(() => null, (thrown: unknown) => thrown);
    expect(PracticalUnknownAcquire.status(readPracticalUnknownAcquireReceipt(error))).toBe('PENDING');
    const before = await everything(seed);
    expect(before.leases).toHaveLength(1);
    const result = await store().recoverPreviousRuntimeCancelLease(recoverInput(seed));
    expect(result).toMatchObject({ kind: 'RECOVERED', leaseId: before.leases[0]!.leaseId });
    expectRecovered(before, await everything(seed), before.leases[0]!.leaseId);
  });

  it('M3: the previous runtime\'s acquisition really ROLLED BACK: NO_LEASED_FENCE, nothing written; standard adoption then proceeds', async () => {
    if (skip()) return;
    const seed = await seeded();
    await store(rollbackLostClient()).acquireCancelLease(acquireInput(seed)).then(() => null, () => null);
    const before = await everything(seed);
    expect(before.leases).toHaveLength(0);
    expect(await store().recoverPreviousRuntimeCancelLease(recoverInput(seed))).toEqual({ kind: 'NO_LEASED_FENCE', fenceHeldByThisRuntime: false });
    expect(await everything(seed)).toEqual(before);
    const adopted = await practical().adoptForNewRuntime({
      accountId: seed.accountId, previousRuntimeEpoch: OLD_EPOCH, expectedFenceRevision: Number(before.fence!.revision), newRuntimeEpoch: NEW_EPOCH, nowMs: RECOVER_AT,
    });
    expect(adopted.fence).toMatchObject({ runtimeEpoch: NEW_EPOCH, mode: { kind: 'IDLE' } });
  });

  it('M4: the previous runtime ARMED and died: ARMED_ORPHAN_REQUIRES_EVIDENCE, manual review, never released; adoption still refused', async () => {
    if (skip()) return;
    const armed = await armedByOld();
    const before = await everything(armed);
    expect(before.order).toMatchObject({ cancelWireArmed: true });
    await refused(armed, 'ARMED_ORPHAN_REQUIRES_EVIDENCE');
    expectReviewedOnly(before, await everything(armed));
    await expectAdoptionRefused(armed);
  });

  it('M5: the previous runtime\'s arm COMMIT was unknown but really committed (ARM_OUTCOME_UNKNOWN): an armed orphan, never released', async () => {
    if (skip()) return;
    const leased = await leasedByOld();
    await expect(store(commitLostClient()).armCancelLease({ acquired: leased.handle, enablement: enablementFor(leased.accountId), runtimeIdentity: OLD, trustedNowMs: ARM_AT }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    expect(PracticalAcquiredCancel.status(leased.handle)).toBe('ARM_OUTCOME_UNKNOWN');
    const before = await everything(leased);
    await refused(leased, 'ARMED_ORPHAN_REQUIRES_EVIDENCE');
    expectReviewedOnly(before, await everything(leased));
  });

  it('M6: THIS runtime\'s own lease is CURRENT_RUNTIME_LEASE: no write and no review; a forged or cloned identity is refused before any access', async () => {
    if (skip()) return;
    const leased = await leasedByOld();
    const before = await everything(leased);
    await refused(leased, 'CURRENT_RUNTIME_LEASE', connectionA, OLD);
    for (const spoof of [OLD_EPOCH, { epoch: NEW_EPOCH }, { ...NEW }, JSON.parse(JSON.stringify(NEW)), Object.create(Object.getPrototypeOf(NEW))]) {
      await expect(store().recoverPreviousRuntimeCancelLease({ accountId: leased.accountId, runtimeIdentity: spoof, trustedNowMs: RECOVER_AT }))
        .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    }
    await expect(store().recoverPreviousRuntimeCancelLease({ ...recoverInput(leased), runtimeEpoch: NEW_EPOCH } as never)).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_INVALID_INPUT' });
    expect(await everything(leased)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// M7-M10: zombies (the old-epoch process is still alive)
// ---------------------------------------------------------------------------

describe('P18B-W2B2d-DB Z: a still-alive old-epoch process (zombie) can never undo, split, or claim the recovery', () => {
  it('M7a: recovery FIRST, then the zombie arms: the arm is refused with zero change; its handle stays AVAILABLE', async () => {
    if (skip()) return;
    const leased = await leasedByOld();
    expect((await store().recoverPreviousRuntimeCancelLease(recoverInput(leased))).kind).toBe('RECOVERED');
    const after = await everything(leased);
    await expect(store(connectionB).armCancelLease({ acquired: leased.handle, enablement: enablementFor(leased.accountId), runtimeIdentity: OLD, trustedNowMs: ARM_AT }))
      .rejects.toBeInstanceOf(Error);
    expect(await everything(leased)).toEqual(after);
    expect(PracticalAcquiredCancel.status(leased.handle)).toBe('AVAILABLE');
  });

  it('M7b: the zombie arms FIRST, then recovery: an armed orphan (review, not released); the zombie can still close its own no-wire ticket', async () => {
    if (skip()) return;
    const armed = await armedByOld();
    const before = await everything(armed);
    await refused(armed, 'ARMED_ORPHAN_REQUIRES_EVIDENCE');
    expectReviewedOnly(before, await everything(armed));
    expect((await store(connectionB).completeUndispatchedCancel({ armed: armed.ticket, report: { kind: 'NOT_DISPATCHED', reason: 'ABORTED_BEFORE_DISPATCH' }, trustedNowMs: RECOVER_AT }))
      .kind).toBe('COMPLETED');
    expect(await store().recoverPreviousRuntimeCancelLease(recoverInput(armed))).toEqual({ kind: 'NO_LEASED_FENCE', fenceHeldByThisRuntime: false });
  });

  it('M7c: recovery and the zombie arm TRULY concurrent (two connections, repeated): exactly one wins, the pair is never split', { timeout: 120_000 }, async () => {
    if (skip()) return;
    for (let round = 0; round < 4; round += 1) {
      const leased = await leasedByOld();
      const [recovery, arm] = await Promise.allSettled([
        store(connectionA).recoverPreviousRuntimeCancelLease(recoverInput(leased)),
        store(connectionB).armCancelLease({ acquired: leased.handle, enablement: enablementFor(leased.accountId), runtimeIdentity: OLD, trustedNowMs: ARM_AT }),
      ]);
      const rows = await everything(leased);
      const leaseArmed = rows.leases[0]!.armedAtMs !== null;
      expect(leaseArmed, `round ${round}`).toBe(rows.order!.cancelWireArmed);
      if (recovery.status === 'fulfilled') {
        expect(recovery.value.kind).toBe('RECOVERED');
        expect(arm.status).toBe('rejected');
        expect(rows.order).toMatchObject({ cancelState: 'NONE', cancelWireArmed: false });
        expect(rows.fence).toMatchObject({ mode: 'IDLE', runtimeEpoch: NEW_EPOCH });
      } else {
        expect(arm.status).toBe('fulfilled');
        expect(recovery.reason).toMatchObject({ details: { reason: 'ARMED_ORPHAN_REQUIRES_EVIDENCE' } });
        expect(rows.order).toMatchObject({ cancelState: 'CANCEL_RESERVED', cancelWireArmed: true });
        expect(rows.fence).toMatchObject({ mode: 'MUTATION_LEASED', runtimeEpoch: OLD_EPOCH });
      }
    }
  });

  it('M8a: recovery FIRST, then the zombie abandons: COMPLETION_REFUSED (superseded), zero writes, handle AVAILABLE again', async () => {
    if (skip()) return;
    const leased = await leasedByOld();
    expect((await store().recoverPreviousRuntimeCancelLease(recoverInput(leased))).kind).toBe('RECOVERED');
    const after = await everything(leased);
    await expect(store(connectionB).abandonAcquiredCancel({ acquired: leased.handle, trustedNowMs: RECOVER_AT + 1 }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMPLETION_REFUSED', message: expect.stringMatching(/another runtime epoch/) });
    expect(await everything(leased)).toEqual(after);
    expect(PracticalAcquiredCancel.status(leased.handle)).toBe('AVAILABLE');
  });

  it('M8b: the zombie abandons FIRST, then recovery: NO_LEASED_FENCE (not this runtime\'s), no closure claimed, nothing written', async () => {
    if (skip()) return;
    const leased = await leasedByOld();
    expect((await store(connectionB).abandonAcquiredCancel({ acquired: leased.handle, trustedNowMs: RECOVER_AT })).kind).toBe('COMPLETED');
    const after = await everything(leased);
    expect(await store().recoverPreviousRuntimeCancelLease(recoverInput(leased))).toEqual({ kind: 'NO_LEASED_FENCE', fenceHeldByThisRuntime: false });
    expect(await everything(leased)).toEqual(after);
  });

  it('M9: the zombie resolves its 2B2c receipt AFTER the recovery: RUNTIME_SUPERSEDED, receipt REFUSED, no handle, NO manual review, zero writes', async () => {
    if (skip()) return;
    const seed = await seeded();
    const error = await store(commitLostClient()).acquireCancelLease(acquireInput(seed)).then(() => null, (thrown: unknown) => thrown);
    const receipt = readPracticalUnknownAcquireReceipt(error);
    expect((await store().recoverPreviousRuntimeCancelLease(recoverInput(seed))).kind).toBe('RECOVERED');
    const after = await everything(seed);
    await expect(store(connectionB).resolveUnknownAcquire({ unknown: receipt, runtimeIdentity: OLD, trustedNowMs: RECOVER_AT + 1 }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_RECOVERY_REFUSED', details: { reason: 'RUNTIME_SUPERSEDED', escalated: false, reviewEpisodeId: null } });
    expect(PracticalUnknownAcquire.status(receipt)).toBe('REFUSED');
    expect(await everything(seed)).toEqual(after);
    await expect(store(connectionB).resolveUnknownAcquire({ unknown: receipt, runtimeIdentity: OLD, trustedNowMs: RECOVER_AT + 2 }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
  });

  it('M10: the zombie\'s ABANDON_OUTCOME_UNKNOWN retry (its abandon really rolled back) AFTER the recovery: COMPLETION_REFUSED, never ALREADY_COMPLETED', async () => {
    if (skip()) return;
    const leased = await leasedByOld();
    const before = await everything(leased);
    await expect(store(rollbackLostClient(connectionB)).abandonAcquiredCancel({ acquired: leased.handle, trustedNowMs: RECOVER_AT }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    expect(PracticalAcquiredCancel.status(leased.handle)).toBe('ABANDON_OUTCOME_UNKNOWN');
    expect(await everything(leased)).toEqual(before);
    expect((await store().recoverPreviousRuntimeCancelLease(recoverInput(leased))).kind).toBe('RECOVERED');
    const after = await everything(leased);
    await expect(store(connectionB).abandonAcquiredCancel({ acquired: leased.handle, trustedNowMs: RECOVER_AT + 1 }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMPLETION_REFUSED' });
    expect(await everything(leased)).toEqual(after);
    expect(PracticalAcquiredCancel.status(leased.handle)).toBe('ABANDON_OUTCOME_UNKNOWN');
  });

  it('M10b (control, NOT superseded): the zombie\'s abandon really committed; no adoption yet: its identical retry is still ALREADY_COMPLETED', async () => {
    if (skip()) return;
    const leased = await leasedByOld();
    await expect(store(commitLostClient(connectionB)).abandonAcquiredCancel({ acquired: leased.handle, trustedNowMs: RECOVER_AT }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    expect(await store().recoverPreviousRuntimeCancelLease(recoverInput(leased))).toEqual({ kind: 'NO_LEASED_FENCE', fenceHeldByThisRuntime: false });
    expect((await store(connectionB).abandonAcquiredCancel({ acquired: leased.handle, trustedNowMs: RECOVER_AT + 1 })).kind).toBe('ALREADY_COMPLETED');
  });
});

// ---------------------------------------------------------------------------
// M11: tampers (parser-first where the strict account read rejects the rows)
// ---------------------------------------------------------------------------

describe('P18B-W2B2d-DB T: a well-formed contradiction is reviewed and never released; a malformed account is latched', () => {
  type Tamper = (leased: Leased) => Promise<unknown>;
  const REVIEWED: readonly (readonly [string, string, Tamper])[] = [
    ['PHASE17_IDENTITY', 'a case-only Phase 17 client order id', (leased) => tamperWithoutForeignKeys((tx) => tx.$executeRaw`UPDATE live_order SET client_order_id = UPPER(client_order_id) WHERE intent_id = ${leased.order.intentId}`)],
    ['PHASE17_IDENTITY', 'a case-only Phase 17 cancel exchange order id', (leased) => connectionA.$executeRaw`UPDATE live_order SET cancel_exchange_order_id = UPPER(cancel_exchange_order_id) WHERE intent_id = ${leased.order.intentId}`],
    ['PHASE17_CLAIM', 'the Phase 17 claim released to NONE', (leased) => connectionA.$executeRaw`UPDATE live_order SET cancel_state = 'NONE', revision = revision + 1 WHERE intent_id = ${leased.order.intentId}`],
    ['PHASE17_CLAIM', 'another Phase 17 generation', (leased) => connectionA.$executeRaw`UPDATE live_order SET cancel_generation = cancel_generation + 1, revision = revision + 1 WHERE intent_id = ${leased.order.intentId}`],
    ['SPLIT_PAIR', 'the Phase 17 claim armed while the lease is not', (leased) => connectionA.$executeRaw`UPDATE live_order SET cancel_wire_armed = 1 WHERE intent_id = ${leased.order.intentId}`],
    ['SPLIT_PAIR', 'the lease armed while the Phase 17 claim is not', (leased) => connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET armed_at_ms = created_at_ms + 1 WHERE lease_id = ${leased.leaseId}`],
    ['PHASE17_MISSING', 'the Phase 17 order row deleted', (leased) => tamperWithoutForeignKeys((tx) => tx.$executeRaw`DELETE FROM live_order WHERE intent_id = ${leased.order.intentId}`)],
    ['LEASE_CERTIFICATE_MISMATCH', 'the certificate consumption instant differs from the lease creation', (leased) => connectionA.$executeRaw`UPDATE live_practical_certificate SET terminal_at_ms = terminal_at_ms + 1 WHERE account_id = ${leased.accountId}`],
  ];

  it.each(REVIEWED)('M11 %s: %s -> rolled back, manual review, never released, adoption still refused', async (reason, _name, tamper) => {
    if (skip()) return;
    const leased = await leasedByOld();
    await tamper(leased);
    const before = await everything(leased);
    await refused(leased, reason);
    expectReviewedOnly(before, await everything(leased));
    await expectAdoptionRefused(leased);
  });

  it.each([
    ['a COMPLETED lease still named by the leased fence', (leased: Leased) => connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET status = 'COMPLETED', outcome = 'PRE_DISPATCH_FAILURE', completed_at_ms = created_at_ms + 5 WHERE lease_id = ${leased.leaseId}`],
    ['a DELETED lease still named by the leased fence', (leased: Leased) => tamperWithoutForeignKeys((tx) => tx.$executeRaw`DELETE FROM live_practical_mutation_lease WHERE lease_id = ${leased.leaseId}`)],
  ] as const)('M11 parser-first: %s -> MALFORMED_LATCHED by the existing escalation; nothing released, no review of our own', async (_name, tamper) => {
    if (skip()) return;
    const leased = await leasedByOld();
    await tamper(leased);
    const before = await everything(leased);
    const result = await store().recoverPreviousRuntimeCancelLease(recoverInput(leased));
    expect(result.kind).toBe('MALFORMED_LATCHED');
    const after = await everything(leased);
    expect(after.latch).not.toBeNull();
    if (result.kind === 'MALFORMED_LATCHED') expect(after.latch!.currentReviewEpisodeId).toBe(result.reviewEpisodeId);
    for (const key of ['order', 'events', 'intent', 'leases', 'certificates', 'fence'] as const) expect(after[key], key).toEqual(before[key]);
    expect(after.reviews.filter((review) => review.reason === 'POST_MUTATION_MISMATCH')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// M12-M17: commit outcome, retries, locks, reconciliation afterwards, manual-review accounts
// ---------------------------------------------------------------------------

describe('P18B-W2B2d-DB C: unknown commits, retries, locks, and what follows the recovery', () => {
  it('M12a: the recovery COMMIT really happened but is unknown: no RECOVERED is reported; the retry RE-READS (NO_LEASED_FENCE, this runtime) with no write', async () => {
    if (skip()) return;
    const leased = await leasedByOld();
    const before = await everything(leased);
    await expect(store(commitLostClient()).recoverPreviousRuntimeCancelLease(recoverInput(leased))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    const committed = await everything(leased);
    expectRecovered(before, committed, leased.leaseId);
    expect(await store().recoverPreviousRuntimeCancelLease(recoverInput(leased))).toEqual({ kind: 'NO_LEASED_FENCE', fenceHeldByThisRuntime: true });
    expect(await everything(leased)).toEqual(committed);
  });

  it('M12b: the recovery was unknown but really ROLLED BACK: nothing changed; the retry re-reads and RECOVERS', async () => {
    if (skip()) return;
    const leased = await leasedByOld();
    const before = await everything(leased);
    await expect(store(rollbackLostClient()).recoverPreviousRuntimeCancelLease(recoverInput(leased))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    expect(await everything(leased)).toEqual(before);
    expect((await store().recoverPreviousRuntimeCancelLease(recoverInput(leased))).kind).toBe('RECOVERED');
    expectRecovered(before, await everything(leased), leased.leaseId);
  });

  it('M13: one deadlock is retried inside ONE call; exhausted retries are a FAULT with zero change and no review', async () => {
    if (skip()) return;
    const leased = await leasedByOld();
    const before = await everything(leased);
    await expect(store(deadlockingClient(3)).recoverPreviousRuntimeCancelLease(recoverInput(leased))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_FAULT' });
    expect(await everything(leased)).toEqual(before);
    expect((await store(deadlockingClient(1)).recoverPreviousRuntimeCancelLease(recoverInput(leased))).kind).toBe('RECOVERED');
  });

  it('M14: no reconciliation lock: the recovery completes while another connection holds live_reconciliation_state FOR UPDATE', { timeout: 60_000 }, async () => {
    if (skip()) return;
    const leased = await leasedByOld();
    const holder = await holdLocks((tx) => tx.$executeRaw`SELECT account_id FROM live_reconciliation_state WHERE account_id = ${leased.accountId} FOR UPDATE`);
    const recovery = store().recoverPreviousRuntimeCancelLease(recoverInput(leased));
    const blocked = await stillPending(recovery, 8_000);
    await holder.release();
    expect(blocked).toBe(false);
    expect((await recovery).kind).toBe('RECOVERED');
  });

  it('M15: before the recovery a reconciliation run is MANUAL_REVIEW_REQUIRED (practically bound); after it the ordinary run is HEALTHY; no authority is granted; strict Tier-A still refuses', { timeout: 120_000 }, async () => {
    if (skip()) return;
    const leased = await leasedByOld();
    const runtimeIdentity = newLiveRuntimeIdentity();
    const service = new LiveReconciliationService({
      repository: new PrismaLiveReconciliationRepository(connectionA),
      executionRepository: execution(),
      evidenceProvider: new FakeEvidenceProvider(evidenceSet({ accountId: leased.accountId, orders: [venueOrder({ exchangeOrderId: leased.exchangeOrderId })] })) as never,
      runtimeIdentity,
      credentialAccountId: leased.accountId,
      expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
      clock: new FixedClock(),
    });
    const bound = await service.reconcileAccount(leased.accountId);
    if (bound.kind !== 'COMPLETED') throw new Error(`run: ${bound.kind}`);
    expect(bound.result.status).toBe('MANUAL_REVIEW_REQUIRED');
    expect(bound.result.findings.map((finding) => finding.code)).toContain('RECON_CANCEL_CLAIM_PRACTICALLY_BOUND');
    expect((await store().recoverPreviousRuntimeCancelLease(recoverInput(leased))).kind).toBe('RECOVERED');
    const next = await service.reconcileAccount(leased.accountId);
    if (next.kind !== 'COMPLETED') throw new Error(`run: ${next.kind}`);
    expect(next.result.status).toBe('HEALTHY');
    expect(next.result.generation).toBe(bound.result.generation + 1);
    expect(next.result.findings.map((finding) => finding.code)).not.toContain('RECON_CANCEL_CLAIM_PRACTICALLY_BOUND');
    const rows = await practicalRows(leased.accountId);
    expect(rows.state!.state).toBe('QUARANTINED');
    expect(rows.fence).toMatchObject({ mode: 'IDLE', runtimeEpoch: NEW_EPOCH });
    expect(rows.certificates.every((certificate) => certificate.status !== 'ISSUED')).toBe(true);
    await expect(requireCurrentReconciliation(new PrismaLiveReconciliationRepository(connectionA), leased.accountId, runtimeIdentity, 'CANCEL'))
      .rejects.toMatchObject({ details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
    // The released claim no longer blocks a Tier-A REPOSITORY-level claim (the Tier-A barrier above is unchanged).
    const { authorization } = await new PrismaLiveReconciliationRepository(connectionA).authorizeCurrentHealthy(leased.accountId, runtimeIdentity);
    expect(await execution().claimCancel(leased.order.intentId, leased.accountId, authorization)).toMatchObject({ kind: 'CLAIMED', generation: 2 });
  });

  it.each(['certificate', 'lease'] as const)('M16: a held %s row lock blocks the recovery until released (then RECOVERED, one attempt); a concurrent Stage 1B1 operation serializes behind it', { timeout: 60_000 }, async (row) => {
    if (skip()) return;
    const leased = await leasedByOld();
    const certificateId = (await practicalRows(leased.accountId)).certificates[0]!.certificateId;
    const holder = await holdLocks((tx) => row === 'certificate'
      ? tx.$executeRaw`SELECT certificate_id FROM live_practical_certificate WHERE certificate_id = ${certificateId} FOR UPDATE`
      : tx.$executeRaw`SELECT lease_id FROM live_practical_mutation_lease WHERE lease_id = ${leased.leaseId} FOR UPDATE`);
    const counted = countingClient(connectionA);
    const recovery = store(counted.client).recoverPreviousRuntimeCancelLease(recoverInput(leased));
    expect(await stillPending(recovery)).toBe(true);
    // A Stage 1B1 manual-review entry takes the account rows first: it waits behind the recovery (no cycle).
    const review = practical(connectionB).enterManualReview({ accountId: leased.accountId, reason: 'ORPHAN_ORDER', nowMs: RECOVER_AT + 1 });
    expect(await stillPending(review)).toBe(true);
    await holder.release();
    expect((await recovery).kind).toBe('RECOVERED');
    expect(await review).toMatchObject({ kind: 'ENTERED' });
    expect(counted.attempts()).toBe(1);
  });

  it('M17: an account the previous runtime left in MANUAL_REVIEW_REQUIRED is recovered and STAYS in review (the same episode, no new one)', async () => {
    if (skip()) return;
    const leased = await leasedByOld();
    await practical().enterManualReview({ accountId: leased.accountId, reason: 'ORPHAN_ORDER', nowMs: NOW + 1 });
    const before = await everything(leased);
    expect(before.state!.state).toBe('MANUAL_REVIEW_REQUIRED');
    expect((await store().recoverPreviousRuntimeCancelLease(recoverInput(leased))).kind).toBe('RECOVERED');
    const after = await everything(leased);
    expectRecovered(before, after, leased.leaseId, 'MANUAL_REVIEW_REQUIRED');
    expect(after.reviews).toEqual(before.reviews);
    expect(after.state!.currentReviewEpisodeId).toBe(before.state!.currentReviewEpisodeId);
  });
});


// ---------------------------------------------------------------------------
// [review fix] Only a PROVEN durable contradiction is reviewed as LEASE_CERTIFICATE_MISMATCH; other conflicts are rethrown
// ---------------------------------------------------------------------------

/** The terminal lease compare-and-set matches NO row (as if the lease changed concurrently); nothing is executed. */
function leaseCasMissClient(): PrismaClient {
  return connectionA.$extends({
    query: { livePracticalMutationLease: { async updateMany() { return { count: 0 }; } } },
  } as never) as unknown as PrismaClient;
}

/** Injects the raw projection AFTER its real locked SQL read, inside the actual persistence transaction. */
function certificateLeaseProjectionClient(result: unknown): { client: PrismaClient; injected: () => number; rollbacks: () => number } {
  let injected = 0;
  let rollbacks = 0;
  const client = new Proxy(connectionA, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => {
          try {
            return await (target.$transaction as (w: (tx: Prisma.TransactionClient) => Promise<unknown>, o: unknown) => Promise<unknown>)(async (tx) => {
              const wrapped = new Proxy(tx, {
                get(transaction, key, transactionReceiver) {
                  if (key === '$queryRaw') {
                    return async (statement: Prisma.Sql) => {
                      const rows = await transaction.$queryRaw(statement);
                      if (/^SELECT lease_id AS leaseId, certificate_id AS certificateId\s+FROM live_practical_mutation_lease WHERE certificate_id = \? FOR UPDATE$/.test(statement.sql)) {
                        injected += 1;
                        return result;
                      }
                      return rows;
                    };
                  }
                  return Reflect.get(transaction, key, transactionReceiver);
                },
              });
              return work(wrapped);
            }, options);
          } catch (error) {
            rollbacks += 1;
            throw error;
          }
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { client, injected: () => injected, rollbacks: () => rollbacks };
}

describe('P18B-W2B2d-DB N: conflict classification is TYPED; only a proven lease/certificate contradiction is reviewed', () => {
  it('N1: a GENUINE certificate contradiction (consumed at another instant than the lease creation): LEASE_CERTIFICATE_MISMATCH with the typed cause; exactly one review row added', async () => {
    if (skip()) return;
    const leased = await leasedByOld();
    await connectionA.$executeRaw`UPDATE live_practical_certificate SET terminal_at_ms = terminal_at_ms + 1 WHERE account_id = ${leased.accountId}`;
    const before = await everything(leased);
    const error = await store().recoverPreviousRuntimeCancelLease(recoverInput(leased)).then(() => null, (thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'PRACTICAL_MUTATION_RECOVERY_REFUSED', details: { accountId: leased.accountId, reason: 'LEASE_CERTIFICATE_MISMATCH' } });
    const cause = (error as Error).cause;
    expect(cause).toBeInstanceOf(PracticalDurableContradictionError);
    expect(cause).toMatchObject({ code: 'PRACTICAL_PERSISTENCE_CONFLICT', contradiction: 'CERTIFICATE_NOT_BOUND_TO_LEASE' });
    const after = await everything(leased);
    expectReviewedOnly(before, after);
    expect(after.reviews.length - before.reviews.length).toBe(1);
  });

  it('N2: a NON-certificate persistence conflict (the terminal lease compare-and-set misses): the plain CONFLICT is rethrown unchanged, BOTH sides rolled back, NO review row', async () => {
    if (skip()) return;
    const leased = await leasedByOld();
    const before = await everything(leased);
    const error = await store(leaseCasMissClient()).recoverPreviousRuntimeCancelLease(recoverInput(leased)).then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PracticalPersistenceError);
    expect(error).not.toBeInstanceOf(PracticalDurableContradictionError);
    expect(error).toMatchObject({ code: 'PRACTICAL_PERSISTENCE_CONFLICT', message: expect.stringMatching(/completed or changed concurrently/) });
    expect(error).not.toMatchObject({ code: 'PRACTICAL_MUTATION_RECOVERY_REFUSED' });
    // Zero change anywhere: the Phase 17 release in the same transaction rolled back too, and no review was entered.
    expect(await everything(leased)).toEqual(before);
    // The account is still recoverable once the operational conflict is gone.
    expect((await store().recoverPreviousRuntimeCancelLease(recoverInput(leased))).kind).toBe('RECOVERED');
  });

  it('N3: a fence revision-exhaustion error (Stage 1A adoption cannot advance the revision): rethrown unchanged as the fence error, zero change, NO review row', async () => {
    if (skip()) return;
    const leased = await leasedByOld();
    await connectionA.$executeRaw`UPDATE live_practical_account_fence SET revision = ${BigInt(Number.MAX_SAFE_INTEGER - 1)} WHERE account_id = ${leased.accountId}`;
    const before = await everything(leased);
    const error = await store().recoverPreviousRuntimeCancelLease(recoverInput(leased)).then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PracticalLiveSafetyError);
    expect(error).toMatchObject({ code: 'PRACTICAL_FENCE_INVALID', message: expect.stringMatching(/revision is exhausted/) });
    expect(await everything(leased)).toEqual(before);
  });

  type Projection = { leaseId: string; certificateId: string };
  const MALFORMED: readonly (readonly [string, (row: Projection) => unknown])[] = [
    ['a non-array object result', () => ({})],
    ['a null result', () => null],
    ['[{}]', () => [{}]],
    ['a null row', () => [null]],
    ['a primitive row', () => ['unreadable']],
    ['an array row with apparent IDs', (row) => [Object.assign([], row)]],
    ['a missing certificate ID', (row) => [{ leaseId: row.leaseId }]],
    ['a non-string lease ID', (row) => [{ ...row, leaseId: 7 }]],
    ['an empty lease ID', (row) => [{ ...row, leaseId: '' }]],
    ['a padded lease ID', (row) => [{ ...row, leaseId: ` ${row.leaseId}` }]],
    ['an overlong lease ID', (row) => [{ ...row, leaseId: 'x'.repeat(65) }]],
    ['a non-string certificate ID', (row) => [{ ...row, certificateId: null }]],
    ['a malformed certificate digest', (row) => [{ ...row, certificateId: 'invalid-digest' }]],
    ['inherited IDs', (row) => [Object.create(row)]],
    ['an unreadable accessor', (row) => [{ certificateId: row.certificateId, get leaseId() { throw new Error('unreadable projection'); } }]],
    ['an unreadable descriptor', () => [new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('unreadable projection'); } })]],
    ['a sparse row set', () => new Array(1)],
    ['multiple rows including a malformed row', (row) => [row, {}]],
  ];

  it.each(MALFORMED)('N4: raw query returns %s -> ordinary operational CONFLICT, rollback, NO manual review or latch', async (_name, result) => {
    if (skip()) return;
    const leased = await leasedByOld();
    const before = await everything(leased);
    const injected = certificateLeaseProjectionClient(result({ leaseId: leased.leaseId, certificateId: before.certificates[0]!.certificateId }));
    const error = await store(injected.client).recoverPreviousRuntimeCancelLease(recoverInput(leased)).then(() => null, (thrown: unknown) => thrown);
    expect(injected.injected()).toBe(1);
    expect(injected.rollbacks()).toBe(1);
    expect(error).toBeInstanceOf(PracticalPersistenceError);
    expect(error).not.toBeInstanceOf(PracticalDurableContradictionError);
    expect(error).toMatchObject({ code: 'PRACTICAL_PERSISTENCE_CONFLICT' });
    expect(await everything(leased)).toEqual(before);
    expect((await store().recoverPreviousRuntimeCancelLease(recoverInput(leased))).kind).toBe('RECOVERED');
  });

  it.each([
    ['zero valid rows', () => []],
    ['two valid rows', (row: Projection) => [row, { ...row, leaseId: 'another-valid-lease' }]],
    ['an exact lease identity mismatch', (row: Projection) => [{ ...row, leaseId: row.leaseId.toUpperCase() }]],
    ['an exact certificate identity mismatch', (row: Projection) => [{ ...row, certificateId: row.certificateId === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64) }]],
  ] as const)('N5: raw query returns %s -> typed durable contradiction, rollback, exactly ONE manual-review entry', async (_name, result) => {
    if (skip()) return;
    const leased = await leasedByOld();
    const before = await everything(leased);
    const injected = certificateLeaseProjectionClient(result({ leaseId: leased.leaseId, certificateId: before.certificates[0]!.certificateId }));
    const error = await store(injected.client).recoverPreviousRuntimeCancelLease(recoverInput(leased)).then(() => null, (thrown: unknown) => thrown);
    expect(injected.injected()).toBe(1);
    expect(injected.rollbacks()).toBe(1);
    expect(error).toMatchObject({ code: 'PRACTICAL_MUTATION_RECOVERY_REFUSED', details: { reason: 'LEASE_CERTIFICATE_MISMATCH' } });
    expect((error as Error).cause).toBeInstanceOf(PracticalDurableContradictionError);
    expect((error as Error).cause).toMatchObject({ code: 'PRACTICAL_PERSISTENCE_CONFLICT', contradiction: 'CERTIFICATE_LEASE_NOT_UNIQUE' });
    expectReviewedOnly(before, await everything(leased));
  });
});
