import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CoinDcxLiveFuturesOrderGateway } from '../../../src/integration/coindcx/live/order-gateway';
import type { LiveExecutionIntentRecord } from '../../../src/execution/live/intent';
import { PrismaLiveExecutionRepository, consumeCancelDispatchWithinCallerFencedTransaction } from '../../../src/execution/live/repository';
import { issuePracticalRecoveryCertificate, PracticalRecoveryCertificate } from '../../../src/execution/live/practical/certificate';
import { issuePracticalLiveSafetyEnablement, type PracticalLiveSafetyEnablement } from '../../../src/execution/live/practical/policy';
import type { PracticalAccountSnapshot } from '../../../src/execution/live/practical-persistence/ports';
import { PrismaPracticalSafetyRepository, withLockedPracticalAccountWithinCallerTransaction } from '../../../src/execution/live/practical-persistence/repository';
import { PrismaPracticalCancelMutationStore } from '../../../src/execution/live/practical-mutation/repository';
import { PracticalAcquiredCancel, PracticalArmedCancel, PracticalCancelDispatchOwner, enterPracticalCancelGateway, issuePracticalCancelOutcome, issuePracticalCancelTransportNoWire } from '../../../src/execution/live/practical-mutation/ticket';
import { providerAccountFingerprint } from '../../../src/execution/live/reconciliation/account-identity';
import { newLiveRuntimeIdentity, readLiveRuntimeEpoch, requireCurrentReconciliation } from '../../../src/execution/live/reconciliation/barrier';
import { DisposableMysqlGuardError, DisposableMysqlLifecycle, generateDisposableDatabaseName } from '../../helpers/p18b-disposable-mysql';
import { classifyPracticalCancelBinding, currentPracticalCancelBinding } from '../../../src/execution/live/practical-cancel-binding';
import { FakeClock } from '../../../src/core/time/clock';
import { resolveLiveExecutionGate } from '../../../src/execution/live/gate';
import { PracticalRecoveryService } from '../../../src/execution/live/practical-recovery/service';
import { PrismaLiveReconciliationRepository } from '../../../src/execution/live/reconciliation/repository';
import { PracticalCancelService } from '../../../src/execution/live/practical-cancel/service';
import { PracticalCancelGatewayBoundary } from '../../../src/execution/live/practical-cancel/gateway-boundary';
import type { PracticalCancelStore, PracticalCancelResult, PracticalCancelDependencies } from '../../../src/execution/live/practical-cancel/ports';
import { FakePrivateStream, FakeReconciliation, FakeScheduler, FakeVenue } from '../../unit/execution/live/practical-recovery/support';

// Test-only synthetic authority. No provider, capture database or production issuer.
const STRICT = process.env['REQUIRE_LIVE_PRACTICAL_CANCEL_DISPATCH_DB_INTEGRATION'] === '1';
const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = generateDisposableDatabaseName();

let lifecycle: DisposableMysqlLifecycle | null = null;
let dbAvailable = false;
let connectionA: PrismaClient;
let connectionB: PrismaClient;
let observer: PrismaClient;

beforeAll(async () => {
  if (!BASE_DATABASE_URL) {
    if (STRICT) throw new Error('[P18B-W2B2b-DB] REQUIRE_LIVE_PRACTICAL_CANCEL_DISPATCH_DB_INTEGRATION=1 but no DATABASE_URL is configured.');
    return;
  }
  let guarded: DisposableMysqlLifecycle;
  try {
    guarded = new DisposableMysqlLifecycle({ rawBaseUrl: BASE_DATABASE_URL, name: SHADOW_DB_NAME, strict: STRICT });
  } catch (error) {
    const reason = error instanceof DisposableMysqlGuardError ? error.message : (error as Error).name;
    if (STRICT) throw new Error(`[P18B-W2B2b-DB] strict mode refused to provision: ${reason}`);
    console.warn(`P18B Wave 2B2b no-wire DB suite skipped: ${reason}`);
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
    if (STRICT) throw new Error(`[P18B-W2B2b-DB] strict mode could not provision a disposable MySQL database: ${(error as Error).name}${cleanupFailure}`);
  }
}, 180_000);

afterAll(async () => {
  dbAvailable = false;
  if (lifecycle !== null) await lifecycle.cleanup();
}, 30_000);

function skip(): boolean {
  if (dbAvailable) return false;
  if (STRICT) throw new Error('[P18B-W2B2b-DB] strict mode reached a test body with no database connection.');
  console.warn('P18B Wave 2B2b no-wire DB suite skipped: no reachable disposable MySQL. Set REQUIRE_LIVE_PRACTICAL_CANCEL_DISPATCH_DB_INTEGRATION=1 to make this hard.');
  return true;
}

// ---------------------------------------------------------------------------
// Fixtures (real certification, real Wave 2B1 acquire / arm)
// ---------------------------------------------------------------------------

const IDENTITY = newLiveRuntimeIdentity();
const EPOCH = readLiveRuntimeEpoch(IDENTITY)!;
const GENERATION = 1;
const T0 = 1_700_000_000_000;
const NOW = T0 + 60_000;
const ARM_AT = NOW + 1_000;
const CLOSE_AT = NOW + 5_000;
const FINGERPRINT = providerAccountFingerprint('w2b2b-fake-coindcx-account');

let sequence = 0;
function freshAccount(): string {
  sequence += 1;
  return `w2b2b-acct-${sequence}-${randomBytes(4).toString('hex')}`;
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
  const start = (await practical().initializeAccount({ accountId, runtimeEpoch: EPOCH, reconciliationGeneration: 0, nowMs: T0 - 50_000 })).account;
  const certifying = await practical().startCertification({ accountId, expected: expectationOf(start), runId: 'run-w2b2b', nowMs: T0 - 40_000 });
  const certificate = issuePracticalRecoveryCertificate({
    enablement: enablementFor(accountId),
    bindings: { accountId, providerAccountFingerprint: FINGERPRINT, runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION, streamIncarnation: 1 },
    evidence: { evidenceDigest: 'e'.repeat(64), passCount: 3, certificationSpanMs: 30_000, minimumObservedPassSpacingMs: 10_000 },
    issuedAtMs: T0,
  });
  const account = await practical().finishCertification({ accountId, expected: expectationOf(certifying), runId: 'run-w2b2b', resultingGeneration: GENERATION, certificate, nowMs: T0 });
  const state = {
    status: 'HEALTHY' as const, currentGeneration: GENERATION, currentRunId: 'recon-run-w2b2b', currentRuntimeEpoch: EPOCH,
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
      riskDecisionId: 'risk-w2b2b', admissionId: `admission-w2b2b-${tag}`, strategyInstanceId: 'instance-w2b2b', strategyId: 'EMA_TREND', strategyVersion: '1.0.0',
      parameterHash: 'p'.repeat(64), liveExecutionPolicyId: 'policy-w2b2b', instrumentSpecSnapshotId: 'spec-w2b2b', authorizedNotionalInr: '2560020',
      settlementRateInrPerQuote: '80', positionInstanceId: null, positionRevision: null, reduceOnlyQuantity: null,
    },
    lineage: {
      researchApproval: { validationSubjectId: 'subject-w2b2b', validationPlanId: 'plan-w2b2b', validationSubjectResultSha256: 'r'.repeat(64) },
      sourceStrategyDecisionId: 'decision-w2b2b',
    },
  };
}

interface Acquired {
  readonly accountId: string;
  readonly order: LiveExecutionIntentRecord;
  readonly exchangeOrderId: string;
  readonly handle: PracticalAcquiredCancel;
}

/** Certified + HEALTHY + one acknowledged order + a committed Wave 2B1 acquisition (unarmed, generation 1). */
async function acquired(revision = 2): Promise<Acquired> {
  const accountId = freshAccount();
  const { account, certificate } = await certified(accountId);
  const order = intentRecord(accountId);
  await execution().ensureIntent(order);
  const exchangeOrderId = `venue-${randomBytes(4).toString('hex')}`;
  await connectionA.liveOrder.update({ where: { intentId: order.intentId }, data: { state: 'ACKNOWLEDGED', exchangeOrderId, revision } });
  const result = await store().acquireCancelLease({
    accountId, expected: expectationOf(account), certificate, enablement: enablementFor(accountId), runtimeIdentity: IDENTITY, intentId: order.intentId, trustedNowMs: NOW,
  });
  if (result.kind !== 'ACQUIRED') throw new Error(`fixture acquisition: ${result.kind}`);
  return { accountId, order, exchangeOrderId, handle: result.acquired };
}

/** ... then the Wave 2B1 arm: the genuine ARMED ticket (never dispatched: there is no dispatch path). */
async function armed(): Promise<Acquired & { readonly ticket: PracticalArmedCancel }> {
  const seeded = await acquired();
  const result = await store().armCancelLease({ acquired: seeded.handle, enablement: enablementFor(seeded.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT });
  return { ...seeded, ticket: result.ticket };
}

const NOT_DISPATCHED = Object.freeze({ kind: 'NOT_DISPATCHED' as const, reason: 'FINAL_STREAM_GUARD_FAILED' as const });

async function orderRow(intentId: string) {
  return connectionA.liveOrder.findUniqueOrThrow({ where: { intentId } });
}

async function practicalRows(accountId: string) {
  const [state, fence, leases, certificates, reviews, recoveries] = await Promise.all([
    connectionA.livePracticalAccountState.findUnique({ where: { accountId } }),
    connectionA.livePracticalAccountFence.findUnique({ where: { accountId } }),
    connectionA.livePracticalMutationLease.findMany({ where: { accountId }, orderBy: { leaseId: 'asc' } }),
    connectionA.livePracticalCertificate.findMany({ where: { accountId }, orderBy: { certificateId: 'asc' } }),
    connectionA.livePracticalReviewEpisode.findMany({ where: { accountId }, orderBy: { reviewEpisodeId: 'asc' } }),
    connectionA.livePracticalRecoveryEpisode.findMany({ where: { accountId }, orderBy: { episodeId: 'asc' } }),
  ]);
  return { state, fence, leases, certificates, reviews, recoveries };
}

async function durable(accountId: string, intentId: string) {
  const [order, events] = await Promise.all([orderRow(intentId), connectionA.liveOrderEvent.findMany({ where: { intentId } })]);
  return { order, events, ...(await practicalRows(accountId)) };
}

/** Every row a no-wire retry could touch: both durable sides, the intent, the order events, and the reconciliation rows. */
async function everything(seeded: Acquired) {
  const [intent, reconciliation, findings] = await Promise.all([
    connectionA.liveExecutionIntent.findUnique({ where: { intentId: seeded.order.intentId } }),
    connectionA.liveReconciliationState.findUnique({ where: { accountId: seeded.accountId } }),
    connectionA.liveReconciliationFinding.findMany({ where: { accountId: seeded.accountId }, orderBy: { findingId: 'asc' } }),
  ]);
  return { ...(await durable(seeded.accountId, seeded.order.intentId)), intent, reconciliation, findings };
}

class InjectedFault extends Error {}

function failAfter(model: string, operation: string): PrismaClient {
  return connectionA.$extends({
    query: { [model]: { async [operation]({ args, query }: { args: unknown; query: (a: unknown) => Promise<unknown> }) { await query(args); throw new InjectedFault(`after ${model}.${operation}`); } } },
  } as never) as unknown as PrismaClient;
}

function failWith(model: string, operation: string, error: () => unknown, times: number): PrismaClient {
  let calls = 0;
  return connectionA.$extends({
    query: { [model]: { async [operation]({ args, query }: { args: unknown; query: (a: unknown) => Promise<unknown> }) { calls += 1; if (calls <= times) throw error(); return query(args); } } },
  } as never) as unknown as PrismaClient;
}

/** The transaction COMMITS for real, then the client reports a lost connection: an UNKNOWN outcome, durably committed. */
function commitLostClient(): PrismaClient {
  return new Proxy(connectionA, {
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

class ForcedRollback extends Error {}

/**
 * The store's transaction callback COMPLETES (so the store marks its work done), then the test wrapper throws
 * inside the real transaction so MySQL ROLLS IT BACK, and the client reports a lost connection: an UNKNOWN
 * outcome whose durable truth is "nothing committed". No production code is changed to produce it.
 */
function rollbackLostClient(): PrismaClient {
  return new Proxy(connectionA, {
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

/** Controlled local lifecycle observation after work, while the real transaction is still open. */
function lifecycleTransactionClient(observe: () => void, truth: 'CONFIRMED' | 'COMMITTED' | 'ROLLED_BACK' = 'CONFIRMED'): PrismaClient {
  return new Proxy(connectionA, {
    get(target, property, receiver) {
      if (property === '$transaction') return async (work: (tx: unknown) => Promise<unknown>, options: unknown) => {
        let result: unknown;
        try {
          result = await (target.$transaction as (w: (tx: unknown) => Promise<unknown>, o: unknown) => Promise<unknown>)(async tx => {
            const value = await work(tx); observe();
            if (truth === 'ROLLED_BACK') throw new ForcedRollback('synthetic lifecycle rollback');
            return value;
          }, options);
        } catch (error) { if (!(error instanceof ForcedRollback)) throw error; }
        if (truth !== 'CONFIRMED') throw new Prisma.PrismaClientKnownRequestError('synthetic lifecycle acknowledgement lost', { code: 'P1017', clientVersion: 'test' });
        return result;
      };
      return Reflect.get(target, property, receiver);
    },
  });
}

async function permitted() {
  const seed = await armed();
  const result = await store().createCancelDispatchPermission({ armed: seed.ticket, enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT + 1 });
  return { ...seed, permission: result.permission };
}
async function consumed() {
  const seed = await permitted();
  const result = await store().consumeCancelDispatchPermission({ permission: seed.permission, enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT + 2 });
  return { ...seed, attempt: result.attempt };
}
function outcomeOf(attempt: unknown, kind: string) {
  enterPracticalCancelGateway(attempt);
  return issuePracticalCancelOutcome(attempt, kind === 'PRE_DISPATCH_FAILURE'
    ? { kind, noWire: issuePracticalCancelTransportNoWire(attempt) } : { kind });
}

function writeObserver(client: PrismaClient = connectionA) {
  let writes = 0;
  const observed = client.$extends({ query: { $allModels: { $allOperations({ operation, args, query }) {
    if (/^(create|update|delete|upsert)/.test(operation)) writes += 1;
    return query(args);
  } } } });
  return { client: observed as unknown as PrismaClient, writes: () => writes };
}

const CLEANUP_ORIGINS = ['READY', 'CREATION_UNKNOWN', 'UNENTERED', 'CONSUMPTION_COMMITTED', 'CONSUMPTION_ROLLED_BACK'] as const;
async function cleanupOrigin(origin: typeof CLEANUP_ORIGINS[number]) {
  if (origin === 'CREATION_UNKNOWN') {
    const seed = await armed();
    await expect(store(commitLostClient()).createCancelDispatchPermission({ armed: seed.ticket, enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT + 1 })).rejects.toThrow(/COMMIT_OUTCOME_UNKNOWN/);
    return { ...seed, owner: seed.ticket, revisions: [4] };
  }
  if (origin === 'UNENTERED') {
    const seed = await consumed();
    return { ...seed, owner: seed.attempt, revisions: [5] };
  }
  const seed = await permitted();
  if (origin !== 'READY') await expect(store(origin === 'CONSUMPTION_COMMITTED' ? commitLostClient() : rollbackLostClient()).consumeCancelDispatchPermission({ permission: seed.permission, enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT + 2 })).rejects.toThrow(/COMMIT_OUTCOME_UNKNOWN/);
  return { ...seed, owner: seed.permission, revisions: origin === 'READY' ? [4] : [4, 5] };
}

describe('unwired dispatch real-MySQL acceptance', () => {
  it('independent caller-fenced MySQL transactions compete over original R; the durable loser cannot rebase', async () => {
    if (skip()) return;
    const seed = await armed();
    const arm = PracticalArmedCancel.read(seed.ticket)!;
    const ids: string[] = [];
    let announceWinner!: () => void, releaseWinner!: () => void, announceLoser!: () => void;
    const winnerReady = new Promise<void>(resolve => { announceWinner = resolve; });
    const winnerRelease = new Promise<void>(resolve => { releaseWinner = resolve; });
    const loserStarted = new Promise<void>(resolve => { announceLoser = resolve; });
    const compete = (client: PrismaClient, first: boolean) => client.$transaction(async tx => {
      const identity = await tx.$queryRaw<Array<{ id: bigint }>>`SELECT CONNECTION_ID() AS id`;
      ids.push(String(identity[0]!.id));
      if (!first) announceLoser();
      return withLockedPracticalAccountWithinCallerTransaction(practical(client), tx, seed.accountId, async scope => {
        await scope.requireLeasedOrderBoundCancelLease({ leaseId: arm.leaseId, certificateId: arm.certificateId, runtimeEpoch: arm.runtimeEpoch, reconciliationGeneration: arm.reconciliationGeneration, binding: { intentId: arm.intentId, clientOrderId: arm.clientOrderId, cancelGeneration: arm.cancelGeneration } });
        const result = await consumeCancelDispatchWithinCallerFencedTransaction(tx, arm.intentId, arm.orderRevisionAfterArm, arm.cancelGeneration, seed.accountId);
        if (first) { announceWinner(); await winnerRelease; }
        return result;
      });
    }, { timeout: 20_000 });
    const winner = compete(connectionA, true);
    await winnerReady;
    const loser = compete(connectionB, false);
    // Attach rejection handling before releasing the winning transaction.
    const resultsPromise = Promise.allSettled([winner, loser]);
    await loserStarted;
    releaseWinner();
    const results = await resultsPromise;
    expect(new Set(ids).size).toBe(2);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    if (results[1].status !== 'rejected') throw new Error('TEST_DURABLE_CAS_LOSER_MISSING');
    expect(results[1].reason).toMatchObject({ code: 'LIVE_ORDER_STATE_CONFLICT' });
    expect((await orderRow(seed.order.intentId)).revision).toBe(arm.orderRevisionAfterArm + 1);
    const before = await everything(seed);
    await expect(compete(connectionB, false)).rejects.toMatchObject({ code: 'LIVE_ORDER_STATE_CONFLICT' });
    expect(await everything(seed)).toEqual(before);
    // No permit or attempt was issued by this direct internal-primitives fixture.
    expect(PracticalArmedCancel.status(seed.ticket)).toBe('ARMED');
  });

  it.each(CLEANUP_ORIGINS.flatMap(origin => [true, false].flatMap(committed => [true, false].map(drift => ({ origin, committed, drift })))))('$origin cleanup committed=$committed drift=$drift retains exact original revision bounds through repeated unknown retries', async ({ origin, committed, drift }) => {
    if (skip()) return;
    const seed = await cleanupOrigin(origin);
    const lost = committed ? commitLostClient : rollbackLostClient;
    const close = (client: PrismaClient) => store(client).completeUnenteredCancelDispatch({ owner: seed.owner, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT });
    await expect(close(lost())).rejects.toThrow(/COMMIT_OUTCOME_UNKNOWN/);
    await expect(close(lost())).rejects.toThrow(/COMMIT_OUTCOME_UNKNOWN/);
    if (drift) await connectionA.liveOrder.update({ where: { intentId: seed.order.intentId }, data: { revision: Math.max(...seed.revisions) + (committed ? 2 : 1) } });
    const before = await everything(seed);
    const observed = writeObserver();
    if (drift) {
      await expect(close(observed.client)).rejects.toThrow(/COMPLETION_REFUSED/);
      expect(await everything(seed)).toEqual(before);
      expect(observed.writes()).toBe(0);
      // The ticket for unknown creation retains the private cleanup-only owner.
      if (origin !== 'CREATION_UNKNOWN') expect(PracticalCancelDispatchOwner.status(seed.owner)).toBe('CLEANUP_UNKNOWN');
    } else {
      expect((await close(observed.client)).kind).toBe(committed ? 'ALREADY_COMPLETED' : 'COMPLETED');
      if (committed) { expect(await everything(seed)).toEqual(before); expect(observed.writes()).toBe(0); }
    }
  });

  it.each(['orderedQuantity', 'intentDigest'] as const)('unknown committed READY cleanup refuses %s tampering without writes or losing unknown ownership', async field => {
    if (skip()) return;
    const seed = await permitted();
    const close = (client: PrismaClient) => store(client).completeUnenteredCancelDispatch({ owner: seed.permission, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT });
    await expect(close(commitLostClient())).rejects.toThrow(/COMMIT_OUTCOME_UNKNOWN/);
    const original = await everything(seed);
    if (field === 'orderedQuantity') await connectionA.liveOrder.update({ where: { intentId: seed.order.intentId }, data: { orderedQuantity: '0.6' } });
    else await connectionA.liveExecutionIntent.update({ where: { intentId: seed.order.intentId }, data: { contentSha256: 'd'.repeat(64) } });
    const tampered = await everything(seed);
    expect(tampered.order.revision).toBe(original.order.revision);
    const observed = writeObserver();
    for (let retry = 0; retry < 2; retry += 1) {
      await expect(close(observed.client)).rejects.toMatchObject({ code: 'LIVE_DURABLE_INTEGRITY_VIOLATION' });
      expect(PracticalCancelDispatchOwner.status(seed.permission)).toBe('CLEANUP_UNKNOWN');
      expect(await everything(seed)).toEqual(tampered);
    }
    expect(observed.writes()).toBe(0);
  });

  it('exclusive transfer prevents old-ticket cleanup, another permit and duplicate consumption/entry', async () => {
    if (skip()) return;
    const seed = await permitted();
    expect(PracticalArmedCancel.status(seed.ticket)).toBe('TRANSFERRED');
    await expect(store().completeUndispatchedCancel({ armed: seed.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT })).rejects.toThrow(/AUTHORITY_INVALID/);
    await expect(store().createCancelDispatchPermission({ armed: seed.ticket, enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT + 1 })).rejects.toThrow(/AUTHORITY_INVALID/);
    const input = { permission: seed.permission, enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT + 2 };
    const results = await Promise.allSettled([store(connectionA).consumeCancelDispatchPermission(input), store(connectionB).consumeCancelDispatchPermission(input)]);
    const winner = results.find((entry) => entry.status === 'fulfilled');
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(winner?.status).toBe('fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('TEST_WINNER_MISSING');
    expect((await orderRow(seed.order.intentId)).revision).toBe(5);
    await expect(store().completeUnenteredCancelDispatch({ owner: seed.permission, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT })).rejects.toThrow(/AUTHORITY_INVALID/);
    enterPracticalCancelGateway(winner.value.attempt);
    expect(() => enterPracticalCancelGateway(winner.value.attempt)).toThrow(/AUTHORITY_INVALID/);
    await expect(store().completeUnenteredCancelDispatch({ owner: winner.value.attempt, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT })).rejects.toThrow(/AUTHORITY_INVALID/);
    expect(requireCurrentReconciliation).toHaveLength(4);
  });

  it('durable CAS conflict permanently refuses consumption and cleanup; revision is never rebased', async () => {
    if (skip()) return;
    const seed = await permitted();
    await connectionB.liveOrder.update({ where: { intentId: seed.order.intentId }, data: { revision: { increment: 1 } } });
    const before = await everything(seed);
    await expect(store().consumeCancelDispatchPermission({ permission: seed.permission, enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT + 2 })).rejects.toThrow(/DISPATCH_CONFLICT/);
    expect(PracticalCancelDispatchOwner.status(seed.permission)).toBe('REFUSED');
    await expect(store().completeUnenteredCancelDispatch({ owner: seed.permission, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT })).rejects.toThrow(/AUTHORITY_INVALID/);
    expect(await everything(seed)).toEqual(before);
  });

  it.each(['committed', 'rolled-back'])('unknown consumption %s: no attempt/retry; exclusive unentered cleanup', async (mode) => {
    if (skip()) return;
    const seed = await permitted();
    await expect(store(mode === 'committed' ? commitLostClient() : rollbackLostClient()).consumeCancelDispatchPermission({ permission: seed.permission, enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT + 2 })).rejects.toThrow(/COMMIT_OUTCOME_UNKNOWN/);
    expect((await orderRow(seed.order.intentId)).revision).toBe(mode === 'committed' ? 5 : 4);
    expect(PracticalCancelDispatchOwner.status(seed.permission)).toBe('CONSUMPTION_UNKNOWN');
    await expect(store().consumeCancelDispatchPermission({ permission: seed.permission, enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT + 2 })).rejects.toThrow(/AUTHORITY_INVALID/);
    expect(() => enterPracticalCancelGateway(seed.permission)).toThrow(/AUTHORITY_INVALID/);
    const close = await store().completeUnenteredCancelDispatch({ owner: seed.permission, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT });
    expect(close.kind).toBe('COMPLETED');
    expect((await orderRow(seed.order.intentId)).cancelState).toBe('NONE');
    expect((await practicalRows(seed.accountId)).certificates[0]?.status).toBe('CONSUMED');
  });

  it.each(['committed', 'rolled-back'])('unknown permission creation %s: original cleanup-only owner survives cleanup uncertainty', async (mode) => {
    if (skip()) return;
    const seed = await armed();
    await expect(store(mode === 'committed' ? commitLostClient() : rollbackLostClient()).createCancelDispatchPermission({ armed: seed.ticket, enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT + 1 })).rejects.toThrow(/COMMIT_OUTCOME_UNKNOWN/);
    expect(PracticalArmedCancel.status(seed.ticket)).toBe('PERMIT_CREATION_UNKNOWN');
    await expect(store(commitLostClient()).completeUnenteredCancelDispatch({ owner: seed.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT })).rejects.toThrow(/COMMIT_OUTCOME_UNKNOWN/);
    const retry = await store().completeUnenteredCancelDispatch({ owner: seed.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT });
    expect(retry.kind).toBe('ALREADY_COMPLETED');
  });

  it('known consumption rollback restores READY without touching rows', async () => {
    if (skip()) return;
    const seed = await permitted();
    const before = await everything(seed);
    await expect(store(failAfter('liveOrder', 'updateMany')).consumeCancelDispatchPermission({ permission: seed.permission, enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT + 2 })).rejects.toThrow();
    expect(PracticalCancelDispatchOwner.status(seed.permission)).toBe('READY');
    expect(await everything(seed)).toEqual(before);
    await store().consumeCancelDispatchPermission({ permission: seed.permission, enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT + 2 });
  });

  it('deadlock retries reserve one owner throughout fresh transactions', async () => {
    if (skip()) return;
    const seed = await permitted();
    const deadlock = () => new Prisma.PrismaClientKnownRequestError('synthetic deadlock', { code: 'P2034', clientVersion: 'test' });
    await store(failWith('liveOrder', 'updateMany', deadlock, 2)).consumeCancelDispatchPermission({ permission: seed.permission, enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT + 2 });
    expect((await orderRow(seed.order.intentId)).revision).toBe(5);
  });

  it.each(['CANCEL_ACCEPTED', 'REJECTED', 'AMBIGUOUS', 'PRE_DISPATCH_FAILURE'])('%s atomically completes both sides without economic or authority change', async (kind) => {
    if (skip()) return;
    const seed = await consumed();
    const before = await orderRow(seed.order.intentId);
    const receipt = outcomeOf(seed.attempt, kind);
    const result = await store().completeCancelLease({ outcome: receipt, trustedNowMs: CLOSE_AT });
    const after = await orderRow(seed.order.intentId);
    const rows = await practicalRows(seed.accountId);
    const expected = kind === 'CANCEL_ACCEPTED' ? 'ACCEPTED' : kind;
    expect(result.kind).toBe('COMPLETED');
    expect(rows.leases[0]?.outcome).toBe(expected);
    expect(rows.leases[0]?.status).toBe('COMPLETED');
    expect(rows.certificates[0]?.status).toBe('CONSUMED');
    expect(rows.state?.state).toBe('QUARANTINED');
    expect(rows.fence?.mode).toBe('IDLE');
    expect(after.state).toBe(before.state);
    expect(after.cancelWireArmed).toBe(false);
    expect(after.revision).toBe(6);
    const views = await execution().listAccountOrderViews(seed.accountId);
    expect(views).toHaveLength(1);
    const rawBinding = [{ ...rows.leases[0], armedAtMs: rows.leases[0]?.armedAtMs }];
    const lease = rawBinding[0];
    if (lease === undefined) throw new Error('TEST_LEASE_MISSING');
    const binding = currentPracticalCancelBinding([{ leaseId: lease.leaseId, accountId: lease.accountId, intentId: lease.intentId, clientOrderId: lease.clientOrderId, cancelGeneration: lease.cancelGeneration, status: lease.status, outcome: lease.outcome, armedAtMs: lease.armedAtMs }], { accountId: seed.accountId, intentId: seed.order.intentId, clientOrderId: seed.order.clientOrderId, cancelGeneration: 1 });
    expect(classifyPracticalCancelBinding(binding, after.cancelState)).toBe(kind === 'AMBIGUOUS' ? 'PRACTICAL_AMBIGUITY_UNRESOLVED' : 'HISTORICAL');
  });

  it.each(['CANCEL_ACCEPTED', 'REJECTED', 'AMBIGUOUS', 'PRE_DISPATCH_FAILURE'])('%s faults between coupled writes roll back every row', async (kind) => {
    if (skip()) return;
    const seed = await consumed();
    const before = await everything(seed);
    const receipt = outcomeOf(seed.attempt, kind);
    await expect(store(failAfter('livePracticalMutationLease', 'updateMany')).completeCancelLease({ outcome: receipt, trustedNowMs: CLOSE_AT })).rejects.toThrow();
    expect(await everything(seed)).toEqual(before);
    expect(PracticalCancelDispatchOwner.status(receipt)).toBe('READY');
    await store().completeCancelLease({ outcome: receipt, trustedNowMs: CLOSE_AT });
  });

  it.each(['CANCEL_ACCEPTED', 'REJECTED', 'AMBIGUOUS', 'PRE_DISPATCH_FAILURE'])('%s unknown real commit and rollback retry only the immutable receipt', async (kind) => {
    if (skip()) return;
    for (const committed of [true, false]) {
      const seed = await consumed();
      const receipt = outcomeOf(seed.attempt, kind);
      await expect(store(committed ? commitLostClient() : rollbackLostClient()).completeCancelLease({ outcome: receipt, trustedNowMs: CLOSE_AT })).rejects.toThrow(/COMMIT_OUTCOME_UNKNOWN/);
      await expect(store().completeCancelLease({ outcome: { ...receipt }, trustedNowMs: CLOSE_AT })).rejects.toThrow(/AUTHORITY_INVALID/);
      const retry = await store().completeCancelLease({ outcome: receipt, trustedNowMs: CLOSE_AT });
      expect(retry.kind).toBe(committed ? 'ALREADY_COMPLETED' : 'COMPLETED');
      expect(PracticalCancelDispatchOwner.status(seed.attempt)).toBe('RESULT_RECORDED');
    }
  });

  it.each(['certificate', 'arm', 'fault', 'generation', 'epoch', 'order-revision'])('unknown completion refuses tampered %s without repair', async (field) => {
    if (skip()) return;
    const seed = await consumed();
    const receipt = outcomeOf(seed.attempt, 'REJECTED');
    await expect(store(commitLostClient()).completeCancelLease({ outcome: receipt, trustedNowMs: CLOSE_AT })).rejects.toThrow(/COMMIT_OUTCOME_UNKNOWN/);
    const owner = PracticalCancelDispatchOwner.read(receipt)!;
    if (field === 'certificate') await connectionA.livePracticalCertificate.update({ where: { certificateId: owner.armed.certificateId }, data: { evidenceDigest: 'd'.repeat(64) } });
    if (field === 'arm') await connectionA.livePracticalMutationLease.update({ where: { leaseId: owner.armed.leaseId }, data: { armedAtMs: BigInt(ARM_AT + 1) } });
    if (field === 'fault') await connectionA.liveOrder.update({ where: { intentId: seed.order.intentId }, data: { cancelFaultCode: 'DIFFERENT' } });
    if (field === 'generation') await connectionA.liveOrder.update({ where: { intentId: seed.order.intentId }, data: { cancelGeneration: 2 } });
    if (field === 'epoch') await connectionA.livePracticalAccountFence.update({ where: { accountId: seed.accountId }, data: { runtimeEpoch: 'superseding-runtime' } });
    if (field === 'order-revision') await connectionA.liveOrder.update({ where: { intentId: seed.order.intentId }, data: { revision: { increment: 1 } } });
    const before = await everything(seed);
    await expect(store().completeCancelLease({ outcome: receipt, trustedNowMs: CLOSE_AT })).rejects.toThrow();
    expect(await everything(seed)).toEqual(before);
  });

  it.each(['creation', 'consumption'])('%s independently rechecks original provenance, configuration, time and reconciliation', async (phase) => {
    if (skip()) return;
    for (const fault of ['runtime', 'enablement', 'expiry', 'certificate', 'reconciliation', 'state']) {
      const seed = await armed();
      const permission = phase === 'consumption' ? (await store().createCancelDispatchPermission({ armed: seed.ticket, enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT + 1 })).permission : null;
      const arm = PracticalArmedCancel.read(seed.ticket)!;
      if (fault === 'certificate') await connectionA.livePracticalCertificate.update({ where: { certificateId: arm.certificateId }, data: { streamIncarnation: 2 } });
      if (fault === 'reconciliation') await connectionA.liveReconciliationState.update({ where: { accountId: seed.accountId }, data: { status: 'MANUAL_REVIEW_REQUIRED' } });
      if (fault === 'state') await practical().invalidate({ accountId: seed.accountId, reason: 'WS_DISCONNECTED', nowMs: CLOSE_AT });
      const common = { enablement: fault === 'enablement' ? enablementFor('wrong-account') : enablementFor(seed.accountId), runtimeIdentity: fault === 'runtime' ? newLiveRuntimeIdentity() : IDENTITY, trustedNowMs: fault === 'expiry' ? arm.certificateExpiresAtMs : ARM_AT + 2 };
      const before = await everything(seed);
      await expect(phase === 'creation' ? store().createCancelDispatchPermission({ armed: seed.ticket, ...common }) : store().consumeCancelDispatchPermission({ permission, ...common })).rejects.toThrow();
      expect(await everything(seed)).toEqual(before);
    }
  });

  it('unentered cleanup and reported completion preserve manual review without healthy authority', async () => {
    if (skip()) return;
    for (const entered of [false, true]) {
      const seed = await consumed();
      await practical().invalidate({ accountId: seed.accountId, reason: 'POST_MUTATION_MISMATCH', nowMs: CLOSE_AT });
      await connectionA.liveReconciliationState.update({ where: { accountId: seed.accountId }, data: { status: 'MANUAL_REVIEW_REQUIRED' } });
      if (entered) await store().completeCancelLease({ outcome: outcomeOf(seed.attempt, 'AMBIGUOUS'), trustedNowMs: CLOSE_AT });
      else await store().completeUnenteredCancelDispatch({ owner: seed.attempt, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT });
      expect((await practicalRows(seed.accountId)).state?.state).toBe('MANUAL_REVIEW_REQUIRED');
    }
  });

  it('signed INT boundary reserves completion capacity and refuses the next original revision', async () => {
    if (skip()) return;
    for (const allowed of [true, false]) {
      const seed = await acquired(allowed ? 2_147_483_643 : 2_147_483_644);
      const ticket = (await store().armCancelLease({ acquired: seed.handle, enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT })).ticket;
      const input = { armed: ticket, enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT + 1 };
      if (!allowed) { await expect(store().createCancelDispatchPermission(input)).rejects.toThrow(/revision capacity/); continue; }
      const { permission } = await store().createCancelDispatchPermission(input);
      const { attempt } = await store().consumeCancelDispatchPermission({ permission, enablement: enablementFor(seed.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT + 2 });
      await store().completeCancelLease({ outcome: outcomeOf(attempt, 'CANCEL_ACCEPTED'), trustedNowMs: CLOSE_AT });
      expect((await orderRow(seed.order.intentId)).revision).toBe(2_147_483_647);
    }
  });
});

type OrchestrationMethod = keyof PracticalCancelStore;
const ORCHESTRATION_METHODS: readonly OrchestrationMethod[] = ['acquireCancelLease', 'armCancelLease', 'createCancelDispatchPermission',
  'consumeCancelDispatchPermission', 'completeCancelLease', 'abandonAcquiredCancel', 'completeUndispatchedCancel', 'completeUnenteredCancelDispatch', 'resolveUnknownAcquire'];

/** Real recovery issuance and real stores; provider/readiness inputs are synthetic test-only fixtures. */
async function orchestrationFixture(provenance: boolean | 'clock' | 'base-url' = false) {
  const accountId = freshAccount();
  const clock = new FakeClock(T0);
  const privateStream = new FakePrivateStream();
  const reconciliation = new FakeReconciliation(accountId, EPOCH);
  const venue = new FakeVenue(clock);
  venue.identity = { kind: 'OBSERVED', fingerprint: FINGERPRINT };
  venue.orders = []; venue.positions = [];
  const enablement = enablementFor(accountId);
  const recovery = new PracticalRecoveryService({ accountId, runtimeEpoch: EPOCH, expectedProviderAccountFingerprint: FINGERPRINT, enablement,
    persistence: practical(), venue, reconciliation, privateStream, clock, scheduler: new FakeScheduler(clock) });
  expect(await recovery.recoverAtStartup()).toMatchObject({ kind: 'READY' });
  expect(await recovery.startWatch()).toMatchObject({ kind: 'WATCHING' });
  const generation = reconciliation.completeHealthyRun(EPOCH);
  const state = { status: 'HEALTHY' as const, currentGeneration: generation, currentRunId: 'orchestration-reconciliation', currentRuntimeEpoch: EPOCH,
    healthyGeneration: generation, blockingFindingCount: 0, revision: 1 };
  await connectionA.liveReconciliationState.upsert({ where: { accountId }, create: { accountId, ...state }, update: state } as never);
  const certified = await recovery.certifyAccount();
  if (certified.kind !== 'CERTIFIED') throw new Error('ORCHESTRATION_CERTIFICATION_FIXTURE_FAILED');
  const record = PracticalRecoveryCertificate.read(certified.certificate)!;
  clock.setTime(record.issuedAtMs + 60_000);
  const order = intentRecord(accountId);
  await execution().ensureIntent(order);
  const exchangeOrderId = `orchestration-venue-${randomBytes(4).toString('hex')}`;
  await connectionA.liveOrder.update({ where: { intentId: order.intentId }, data: { state: 'ACKNOWLEDGED', exchangeOrderId, revision: 2 } });
  const gate = resolveLiveExecutionGate({ NODE_ENV: 'production', LIVE_EXECUTION_ENABLED: 'true', COINDCX_API_KEY: 'synthetic-integration-key', COINDCX_API_SECRET: 'synthetic-integration-secret',
    COINDCX_LIVE_ACCOUNT_ID: accountId, COINDCX_EXPECTED_ACCOUNT_FINGERPRINT: FINGERPRINT, LIVE_EXECUTION_ACCOUNT_ALLOWLIST: accountId,
    LIVE_EXECUTION_PAIR_ALLOWLIST: order.content.pair, LIVE_EXECUTION_MAX_ORDER_NOTIONAL_INR: '10000000' });
  if (gate.status !== 'ENABLED') throw new Error('ORCHESTRATION_GATE_FIXTURE_FAILED');
  const methods: OrchestrationMethod[] = [];
  const cleanupInputs: unknown[] = [];
  let calls = 0;
  let gatewayResult: unknown = { kind: 'CANCEL_ACCEPTED', observation: null };
  const overrides = new Map<OrchestrationMethod, PrismaClient>();
  const after = new Map<OrchestrationMethod, (result: unknown, input: unknown) => void | Promise<void>>();
  const real = store();
  const port = Object.fromEntries(ORCHESTRATION_METHODS.map(method => [method, async (input: unknown) => {
    methods.push(method);
    if (['completeCancelLease', 'abandonAcquiredCancel', 'completeUndispatchedCancel', 'completeUnenteredCancelDispatch'].includes(method)) cleanupInputs.push(input);
    const selected = overrides.has(method) ? store(overrides.get(method)!) : real;
    const result = await (selected[method] as (input: never) => Promise<unknown>).call(selected, input as never);
    await after.get(method)?.(result, input);
    return result;
  }])) as unknown as PracticalCancelStore;
  const gateway: PracticalCancelDependencies['gateway'] = { async cancelOrder(request) { calls += 1; expect(Object.isFrozen(request)).toBe(true); expect(request).toEqual({ clientOrderId: order.clientOrderId,
    exchangeOrderId, pair: order.content.pair, timeoutMs: 1000 }); return gatewayResult as never; } };
  let inputHookCalls = 0;
  const malformed = new Proxy({}, { get() { inputHookCalls++; throw new Error('UNEXPECTED_PREPARATION_INPUT_HOOK'); } });
  const practicalGatewayOptions = { apiKey: 'synthetic-integration-key', apiSecret: 'synthetic-integration-secret', baseUrl: 'invalid-local-url',
    clock: provenance === 'clock' ? { nowMs: () => malformed as never } : clock };
  if (provenance === 'base-url') practicalGatewayOptions.baseUrl = malformed as never;
  const service = new PracticalCancelService({ store: port, clock, runtimeIdentity: IDENTITY, enablement, liveEnablement: gate.enablement, recovery, requestTimeoutMs: 1000,
    gateway: provenance ? new CoinDcxLiveFuturesOrderGateway(practicalGatewayOptions) : gateway });
  const input = { intentId: order.intentId, expected: expectationOf(certified.account), certificate: certified.certificate };
  return { accountId, clock, privateStream, recovery, certificate: certified.certificate, order, exchangeOrderId, service, input, methods, cleanupInputs, overrides, after,
    gateway, calls: () => calls, inputHookCalls: () => inputHookCalls, result: (value: unknown) => { gatewayResult = value; } };
}
function requireBookkeeping(result: PracticalCancelResult) {
  if (result.kind !== 'BOOKKEEPING_PENDING') throw new Error('EXPECTED_GENUINE_BOOKKEEPING_CONTINUATION');
  return result.continuation;
}

describe('unwired orchestrator real-MySQL acceptance (synthetic provider fixtures)', () => {
  it.each(['COMMITTED', 'ROLLED_BACK'] as const)('observation-only drain retains exact %s cleanup ownership without a hidden retry', async truth => {
    if (skip()) return;
    const h = await orchestrationFixture();
    h.after.set('consumeCancelDispatchPermission', () => { h.privateStream.unprove(); });
    h.overrides.set('completeUnenteredCancelDispatch', truth === 'COMMITTED' ? commitLostClient() : rollbackLostClient());
    const continuation = requireBookkeeping(await h.service.cancel(h.input));
    h.service.requestStop();
    const before = await durable(h.accountId, h.order.intentId), calls = [...h.methods], gatewayCalls = h.calls();
    expect(h.service.snapshotDrainWithoutRetry()).toMatchObject({ kind: 'BOOKKEEPING_PENDING' });
    expect(await h.service.observeDrainWithoutRetry()).toMatchObject({ kind: 'BOOKKEEPING_PENDING' });
    expect(h.service.snapshotDrainWithoutRetry()).toMatchObject({ kind: 'BOOKKEEPING_PENDING' });
    expect(h.methods).toEqual(calls); expect(h.calls()).toBe(gatewayCalls);
    expect(await durable(h.accountId, h.order.intentId)).toEqual(before);
    h.overrides.delete('completeUnenteredCancelDispatch');
    expect(await h.service.retryBookkeeping({ continuation })).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(h.service.snapshotDrainWithoutRetry()).toEqual({ kind: 'LOCAL_DRAINED' });
    expect((h.cleanupInputs[0] as { owner: unknown }).owner).toBe((h.cleanupInputs[1] as { owner: unknown }).owner);
    expect(h.calls()).toBe(0);
  });
  it('stop before admission makes no durable calls and local drain is not durable shutdown proof', async () => {
    if (skip()) return;
    const h = await orchestrationFixture(), before = await durable(h.accountId, h.order.intentId);
    expect(await h.service.drain()).toEqual({ kind: 'REFUSED', code: 'ADMISSION_NOT_CLOSED' });
    h.service.requestStop(); h.service.requestStop();
    expect(await h.service.cancel(h.input)).toMatchObject({ code: 'ADMISSION_CLOSED' });
    expect(await h.service.drain()).toEqual({ kind: 'LOCAL_DRAINED' });
    expect(h.methods).toEqual([]); expect(h.calls()).toBe(0); expect(await durable(h.accountId, h.order.intentId)).toEqual(before);
    expect((await practicalRows(h.accountId)).certificates[0]?.status).toBe('ISSUED'); // local drainage did not revoke or stop observation
  });
  it.each(['acquireCancelLease', 'armCancelLease', 'createCancelDispatchPermission', 'consumeCancelDispatchPermission'].flatMap(method => ['before-commit', 'after-commit'].map(order => [method, order] as const)))('%s stop %s closes the genuine paired owner without dispatch', async (method, order) => {
    if (skip()) return;
    const h = await orchestrationFixture(), before = await orderRow(h.order.intentId);
    if (order === 'before-commit') h.overrides.set(method as OrchestrationMethod, lifecycleTransactionClient(() => { h.service.requestStop(); }));
    else h.after.set(method as OrchestrationMethod, () => { h.service.requestStop(); });
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(await h.service.drain()).toEqual({ kind: 'LOCAL_DRAINED' }); expect(h.calls()).toBe(0);
    const after = await orderRow(h.order.intentId), rows = await practicalRows(h.accountId);
    expect(after.cancelState).toBe('NONE'); expect(after.cancelWireArmed).toBe(false);
    expect(after.revision).toBe(method === 'acquireCancelLease' ? 4 : method === 'consumeCancelDispatchPermission' ? 6 : 5);
    expect(rows.leases[0]).toMatchObject({ status: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(rows.certificates[0]?.status).toBe('CONSUMED'); expect(rows.state?.state).toBe('QUARANTINED'); expect(rows.fence?.mode).toBe('IDLE');
    for (const key of ['orderedQuantity', 'cumulativeFilledQuantity', 'remainingQuantity', 'averageFillPrice', 'exchangeOrderId', 'pair'] as const) expect(after[key]).toEqual(before[key]);
  });
  it.each(['acquireCancelLease', 'armCancelLease', 'createCancelDispatchPermission', 'consumeCancelDispatchPermission', 'completeCancelLease'].flatMap(method => ['COMMITTED', 'ROLLED_BACK'].map(truth => [method, truth] as const)))('%s genuine unknown %s after local stop preserves ownership and drain never resends', async (method, truth) => {
    if (skip()) return;
    const h = await orchestrationFixture();
    h.overrides.set(method as OrchestrationMethod, lifecycleTransactionClient(() => { h.service.requestStop(); }, truth as 'COMMITTED' | 'ROLLED_BACK'));
    const result = await h.service.cancel(h.input); expect(['COMPLETED', 'BOOKKEEPING_PENDING']).toContain(result.kind);
    h.overrides.delete(method as OrchestrationMethod);
    expect(await h.service.drain()).toEqual({ kind: 'LOCAL_DRAINED' });
    expect(h.calls()).toBe(method === 'completeCancelLease' ? 1 : 0);
    expect(h.methods.filter(m => m === 'acquireCancelLease')).toHaveLength(1);
    expect(h.methods.filter(m => m === 'armCancelLease')).toHaveLength(method === 'acquireCancelLease' ? 0 : 1);
    const rows = await practicalRows(h.accountId), after = await orderRow(h.order.intentId);
    if (method === 'acquireCancelLease' && truth === 'ROLLED_BACK') {
      expect(rows.leases).toHaveLength(0); expect(rows.certificates[0]?.status).toBe('ISSUED'); expect(after.cancelState).toBe('NONE');
    } else {
      expect(rows.leases[0]?.status).toBe('COMPLETED'); expect(rows.certificates[0]?.status).toBe('CONSUMED');
      expect(rows.fence?.mode).toBe('IDLE'); expect(rows.state?.state).toBe('QUARANTINED'); expect(after.cancelWireArmed).toBe(false);
      expect(after.cancelState).toBe(method === 'completeCancelLease' ? 'CANCEL_ACKNOWLEDGED' : 'NONE');
    }
    if (method === 'completeCancelLease') {
      expect((h.cleanupInputs[0] as { outcome: unknown }).outcome).toBe((h.cleanupInputs[1] as { outcome: unknown }).outcome);
      expect(h.methods.filter(m => m === 'consumeCancelDispatchPermission')).toHaveLength(1);
    }
  });
  it.each(['COMMITTED', 'ROLLED_BACK'] as const)('stopped READY cleanup unknown %s drains the identical owner with its original revision bounds', async truth => {
    if (skip()) return;
    const h = await orchestrationFixture(); h.after.set('createCancelDispatchPermission', () => { h.service.requestStop(); });
    h.overrides.set('completeUnenteredCancelDispatch', truth === 'COMMITTED' ? commitLostClient() : rollbackLostClient());
    requireBookkeeping(await h.service.cancel(h.input)); const original = h.cleanupInputs[0] as { owner: unknown; report: unknown };
    expect(PracticalCancelDispatchOwner.cleanupRevisions(original.owner)).toEqual([4]); h.overrides.delete('completeUnenteredCancelDispatch');
    expect(await h.service.drain()).toEqual({ kind: 'LOCAL_DRAINED' });
    expect(h.cleanupInputs[1]).toMatchObject({ owner: original.owner, report: original.report });
    expect((await orderRow(h.order.intentId)).revision).toBe(5); expect(h.calls()).toBe(0); expect(h.methods).not.toContain('consumeCancelDispatchPermission');
  });
  it.each(['COMMITTED', 'ROLLED_BACK'] as const)('stopped unknown cleanup %s cannot drain after unrelated revision advancement and writes nothing', async truth => {
    if (skip()) return;
    const h = await orchestrationFixture(); h.after.set('createCancelDispatchPermission', () => { h.service.requestStop(); });
    h.overrides.set('completeUnenteredCancelDispatch', truth === 'COMMITTED' ? commitLostClient() : rollbackLostClient());
    requireBookkeeping(await h.service.cancel(h.input)); const original = h.cleanupInputs[0] as { owner: unknown; report: unknown };
    await connectionA.liveOrder.update({ where: { intentId: h.order.intentId }, data: { revision: { increment: 1 } } });
    const before = await durable(h.accountId, h.order.intentId), observed = writeObserver(); h.overrides.set('completeUnenteredCancelDispatch', observed.client);
    expect((await h.service.drain()).kind).toBe('BOOKKEEPING_PENDING');
    expect(observed.writes()).toBe(0); expect(await durable(h.accountId, h.order.intentId)).toEqual(before);
    expect((h.cleanupInputs[1] as { owner: unknown }).owner).toBe(original.owner); expect(PracticalCancelDispatchOwner.cleanupRevisions(original.owner)).toEqual([4]); expect(h.calls()).toBe(0);
  });
  it.each(['clock', 'base-url'].flatMap(source => ['CONFIRMED', 'COMMITTED', 'ROLLED_BACK'].map(truth => [source, truth] as const)))('malformed %s input %s atomically records ambiguity and retries only the identical receipt', async (source, truth) => {
    if (skip()) return;
    const h = await orchestrationFixture(source as 'clock' | 'base-url'), before = await orderRow(h.order.intentId);
    const consumedOrders: Awaited<ReturnType<typeof orderRow>>[] = [];
    h.after.set('consumeCancelDispatchPermission', async () => { consumedOrders.push(await orderRow(h.order.intentId)); });
    const native = vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('UNEXPECTED_NATIVE_FACTORY'); });
    try {
      if (truth !== 'CONFIRMED') h.overrides.set('completeCancelLease', truth === 'COMMITTED' ? commitLostClient() : rollbackLostClient());
      const result = await h.service.cancel(h.input);
      if (truth === 'CONFIRMED') expect(result).toMatchObject({ kind: 'COMPLETED', outcome: 'AMBIGUOUS' });
      else {
        const continuation = requireBookkeeping(result); h.overrides.delete('completeCancelLease');
        expect(await h.service.retryBookkeeping({ continuation })).toMatchObject({ kind: 'COMPLETED', outcome: 'AMBIGUOUS', disposition: truth === 'COMMITTED' ? 'ALREADY_COMPLETED' : 'COMPLETED' });
        expect((h.cleanupInputs[0] as { outcome: unknown }).outcome).toBe((h.cleanupInputs[1] as { outcome: unknown }).outcome);
      }
      const after = await orderRow(h.order.intentId), practicalAfter = await practicalRows(h.accountId);
      expect(native).not.toHaveBeenCalled(); expect(h.inputHookCalls()).toBe(0); expect(h.calls()).toBe(0);
      expect(h.methods.filter(m => m === 'consumeCancelDispatchPermission')).toHaveLength(1); expect(h.methods).not.toContain('completeUnenteredCancelDispatch');
      expect(after.cancelState).toBe('CANCEL_AMBIGUOUS'); expect(after.cancelWireArmed).toBe(false); expect(after.revision).toBe(6);
      expect(after.cancelFaultCode).toBe('LIVE_CANCEL_AMBIGUOUS'); expect(after.faultCode).toBe('LIVE_CANCEL_AMBIGUOUS');
      expect(consumedOrders).toHaveLength(1); expect(after.state).toBe(consumedOrders[0]!.state);
      for (const key of ['orderedQuantity', 'cumulativeFilledQuantity', 'remainingQuantity', 'averageFillPrice', 'exchangeOrderId', 'pair'] as const) expect(after[key]).toEqual(before[key]);
      expect(practicalAfter.certificates[0]?.status).toBe('CONSUMED'); expect(practicalAfter.state?.state).toBe('QUARANTINED'); expect(practicalAfter.fence?.mode).toBe('IDLE');
      expect(practicalAfter.leases[0]).toMatchObject({ status: 'COMPLETED', outcome: 'AMBIGUOUS' });
    } finally { native.mockRestore(); }
  });
  it.each(['CONFIRMED', 'COMMITTED', 'ROLLED_BACK'] as const)('genuine pre-factory no-write %s preserves coupled state and retries bookkeeping only', async truth => {
    if (skip()) return;
    const h = await orchestrationFixture(true), before = await orderRow(h.order.intentId);
    const consumedOrders: Awaited<ReturnType<typeof orderRow>>[] = [];
    h.after.set('consumeCancelDispatchPermission', async () => { consumedOrders.push(await orderRow(h.order.intentId)); });
    const native = vi.spyOn(http, 'request');
    try {
      if (truth !== 'CONFIRMED') h.overrides.set('completeCancelLease', truth === 'COMMITTED' ? commitLostClient() : rollbackLostClient());
      const result = await h.service.cancel(h.input);
      if (truth === 'CONFIRMED') expect(result).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
      else {
        const continuation = requireBookkeeping(result); h.overrides.delete('completeCancelLease');
        expect(await h.service.retryBookkeeping({ continuation })).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE', disposition: truth === 'COMMITTED' ? 'ALREADY_COMPLETED' : 'COMPLETED' });
        expect((h.cleanupInputs[0] as { outcome: unknown }).outcome).toBe((h.cleanupInputs[1] as { outcome: unknown }).outcome);
      }
      const after = await orderRow(h.order.intentId), practicalAfter = await practicalRows(h.accountId);
      expect(native).not.toHaveBeenCalled(); expect(h.calls()).toBe(0);
      expect(h.methods.filter(m => m === 'consumeCancelDispatchPermission')).toHaveLength(1);
      expect(h.methods).not.toContain('completeUnenteredCancelDispatch');
      expect(after.cancelState).toBe('NONE'); expect(after.cancelWireArmed).toBe(false);
      expect(after.cancelFaultCode).toBeNull(); expect(after.revision).toBe(6);
      expect(consumedOrders).toHaveLength(1); expect(consumedOrders[0]!.state).toBe('CANCEL_REQUESTED');
      expect(after.state).toBe(consumedOrders[0]!.state);
      for (const key of ['orderedQuantity', 'cumulativeFilledQuantity', 'remainingQuantity', 'averageFillPrice', 'exchangeOrderId', 'pair'] as const) expect(after[key]).toEqual(before[key]);
      expect(practicalAfter.certificates[0]?.status).toBe('CONSUMED'); expect(practicalAfter.state?.state).toBe('QUARANTINED');
      expect(practicalAfter.leases[0]).toMatchObject({ status: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    } finally { native.mockRestore(); }
  });
  it.each(['COMMITTED', 'ROLLED_BACK'] as const)('unknown consumption %s with genuine source makes zero native calls', async truth => {
    if (skip()) return;
    const h = await orchestrationFixture(true); h.overrides.set('consumeCancelDispatchPermission', truth === 'COMMITTED' ? commitLostClient() : rollbackLostClient());
    const native = vi.spyOn(http, 'request');
    try {
      expect(await h.service.cancel(h.input)).toMatchObject({ outcome: 'PRE_DISPATCH_FAILURE' });
      expect(native).not.toHaveBeenCalled(); expect(h.methods).not.toContain('completeCancelLease');
      expect(h.methods.filter(m => m === 'consumeCancelDispatchPermission')).toHaveLength(1);
    } finally { native.mockRestore(); }
  });
  it.each(['assignment', 'reflect', 'define', 'delete'] as const)('boundary %s cannot send and return false NOT_ENTERED after committed consumption', async operation => {
    if (skip()) return;
    const h = await orchestrationFixture();
    let redirects = 0;
    const replacement = async (attempt: unknown) => {
      redirects += 1;
      const arm = PracticalCancelDispatchOwner.read(attempt)!.armed;
      await h.gateway.cancelOrder(Object.freeze({ clientOrderId: arm.clientOrderId, exchangeOrderId: arm.exchangeOrderId, pair: arm.pair, timeoutMs: 1000 }));
      return { kind: 'NOT_ENTERED', code: 'ORIGINAL_WATCH_REFUSED' };
    };
    h.after.set('consumeCancelDispatchPermission', async result => {
      expect(PracticalCancelDispatchOwner.status((result as { attempt: unknown }).attempt)).toBe('UNENTERED');
      expect((await orderRow(h.order.intentId)).revision).toBe(5);
      h.privateStream.unprove();
      const target = PracticalCancelGatewayBoundary.prototype as unknown as Record<string, unknown>;
      if (operation === 'assignment') expect(() => { target['invoke'] = replacement; }).toThrow(TypeError);
      if (operation === 'reflect') expect(Reflect.set(target, 'invoke', replacement)).toBe(false);
      if (operation === 'define') expect(() => Object.defineProperty(target, 'invoke', { value: replacement })).toThrow(TypeError);
      if (operation === 'delete') expect(Reflect.deleteProperty(target, 'invoke')).toBe(false);
    });
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(h.calls()).toBe(0); expect(redirects).toBe(0);
    expect(h.methods).toEqual(['acquireCancelLease', 'armCancelLease', 'createCancelDispatchPermission', 'consumeCancelDispatchPermission', 'completeUnenteredCancelDispatch']);
    expect(h.cleanupInputs).toHaveLength(1);
    const owner = (h.cleanupInputs[0] as { owner: unknown }).owner;
    expect(PracticalCancelDispatchOwner.read(owner)?.role).toBe('ATTEMPT'); expect(PracticalCancelDispatchOwner.status(owner)).toBe('SPENT');
    const closed = await orderRow(h.order.intentId);
    expect(closed.revision).toBe(6); expect(closed.cancelState).toBe('NONE'); expect(closed.cancelWireArmed).toBe(false);
    expect((await practicalRows(h.accountId)).certificates[0]?.status).toBe('CONSUMED');
  });
  it.each(['COMMITTED', 'ROLLED_BACK'] as const)('protected final-boundary cleanup %s uncertainty retries identical ownership without dispatch', async truth => {
    if (skip()) return;
    const h = await orchestrationFixture();
    h.after.set('consumeCancelDispatchPermission', () => {
      h.privateStream.unprove();
      expect(Reflect.set(PracticalCancelGatewayBoundary.prototype, 'invoke', () => ({ kind: 'NOT_ENTERED' }))).toBe(false);
    });
    h.overrides.set('completeUnenteredCancelDispatch', truth === 'COMMITTED' ? commitLostClient() : rollbackLostClient());
    const continuation = requireBookkeeping(await h.service.cancel(h.input));
    h.overrides.delete('completeUnenteredCancelDispatch'); await h.recovery.settled();
    expect(Reflect.set(PracticalCancelGatewayBoundary.prototype, 'invoke', () => ({ kind: 'REPORTED' }))).toBe(false);
    expect(await h.service.retryBookkeeping({ continuation })).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE', disposition: truth === 'COMMITTED' ? 'ALREADY_COMPLETED' : 'COMPLETED' });
    expect((h.cleanupInputs[0] as { owner: unknown }).owner).toBe((h.cleanupInputs[1] as { owner: unknown }).owner);
    expect(h.methods.filter(m => m === 'acquireCancelLease')).toHaveLength(1);
    expect(h.methods.filter(m => m === 'consumeCancelDispatchPermission')).toHaveLength(1);
    expect(h.methods.filter(m => m === 'completeUnenteredCancelDispatch')).toHaveLength(2);
    expect(h.calls()).toBe(0); expect((await orderRow(h.order.intentId)).revision).toBe(6);
  });
  it.each(['assignment', 'reflect', 'define', 'delete'] as const)('%s cannot replace original-watch loss after committed consumption: zero gateway calls and only owned cleanup', async operation => {
    if (skip()) return;
    const h = await orchestrationFixture();
    const checker = PracticalRecoveryService.checkOriginalCertificateWatch;
    h.after.set('consumeCancelDispatchPermission', async result => {
      const attempt = (result as { attempt: unknown }).attempt;
      expect(PracticalCancelDispatchOwner.status(attempt)).toBe('UNENTERED');
      expect((await orderRow(h.order.intentId)).revision).toBe(5);
      expect((await practicalRows(h.accountId)).certificates[0]?.status).toBe('CONSUMED');
      h.privateStream.unprove();
      const target = PracticalRecoveryService as unknown as Record<string, unknown>;
      const key = 'checkOriginalCertificateWatch';
      const fake = () => ({ kind: 'UNCHANGED' });
      if (operation === 'assignment') expect(() => { target[key] = fake; }).toThrow(TypeError);
      if (operation === 'reflect') expect(Reflect.set(target, key, fake)).toBe(false);
      if (operation === 'define') expect(() => Object.defineProperty(target, key, { value: fake })).toThrow(TypeError);
      if (operation === 'delete') expect(Reflect.deleteProperty(target, key)).toBe(false);
      expect(PracticalRecoveryService.checkOriginalCertificateWatch).toBe(checker);
      expect(checker(h.recovery, { certificate: h.certificate, trustedNowMs: h.clock.nowMs() }).kind).toBe('REFUSED');
    });
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(h.calls()).toBe(0);
    expect(h.methods).toEqual(['acquireCancelLease', 'armCancelLease', 'createCancelDispatchPermission', 'consumeCancelDispatchPermission', 'completeUnenteredCancelDispatch']);
    expect(h.cleanupInputs).toHaveLength(1);
    const owner = (h.cleanupInputs[0] as { owner: unknown }).owner;
    expect(PracticalCancelDispatchOwner.read(owner)?.role).toBe('ATTEMPT');
    expect(PracticalCancelDispatchOwner.status(owner)).toBe('SPENT');
    const closed = await orderRow(h.order.intentId);
    expect(closed.revision).toBe(6); expect(closed.cancelState).toBe('NONE'); expect(closed.cancelWireArmed).toBe(false);
    expect((await practicalRows(h.accountId)).state?.state).toBe('QUARANTINED');
  });
  it.each(['COMMITTED', 'ROLLED_BACK'] as const)('watch-loss cleanup %s uncertainty remains bookkeeping-only despite attempted checker replacement', async truth => {
    if (skip()) return;
    const h = await orchestrationFixture();
    h.after.set('consumeCancelDispatchPermission', () => {
      h.privateStream.unprove();
      expect(Reflect.set(PracticalRecoveryService, 'checkOriginalCertificateWatch', () => ({ kind: 'UNCHANGED' }))).toBe(false);
    });
    h.overrides.set('completeUnenteredCancelDispatch', truth === 'COMMITTED' ? commitLostClient() : rollbackLostClient());
    const continuation = requireBookkeeping(await h.service.cancel(h.input));
    expect(h.calls()).toBe(0);
    h.overrides.delete('completeUnenteredCancelDispatch');
    await h.recovery.settled();
    expect(await h.service.retryBookkeeping({ continuation })).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE', disposition: truth === 'COMMITTED' ? 'ALREADY_COMPLETED' : 'COMPLETED' });
    expect(h.methods.filter(method => method === 'acquireCancelLease')).toHaveLength(1);
    expect(h.methods.filter(method => method === 'consumeCancelDispatchPermission')).toHaveLength(1);
    expect(h.methods.filter(method => method === 'completeUnenteredCancelDispatch')).toHaveLength(2);
    expect((h.cleanupInputs[0] as { owner: unknown }).owner).toBe((h.cleanupInputs[1] as { owner: unknown }).owner);
    expect(h.calls()).toBe(0);
  });
  it('a genuine malformed latch is blocked, never completed, with no Phase17 write or gateway call', async () => {
    if (skip()) return;
    const h = await orchestrationFixture(); const before = await orderRow(h.order.intentId);
    await connectionA.$executeRaw`UPDATE live_practical_account_fence SET mode = 'CERTIFYING', run_id = ' padded-run' WHERE account_id = ${h.accountId}`;
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'BLOCKED', code: 'MANUAL_REVIEW_REQUIRED' });
    expect(await orderRow(h.order.intentId)).toEqual(before); expect(h.calls()).toBe(0);
    // Retain the original unresolved result instead of reacquiring just to probe the durable latch.
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'BLOCKED', code: 'MANUAL_REVIEW_REQUIRED' });
    expect(h.methods.filter(method => method === 'acquireCancelLease')).toHaveLength(1);
    h.service.requestStop();
    expect(await h.service.drain()).toEqual({ kind: 'BLOCKED', code: 'MANUAL_REVIEW_REQUIRED' });
    expect(await orderRow(h.order.intentId)).toEqual(before); expect(h.calls()).toBe(0);
  });
  it('retains the genuine original watch after durable consumption and preserves economic rows', async () => {
    if (skip()) return;
    const h = await orchestrationFixture();
    const before = await orderRow(h.order.intentId);
    h.after.set('acquireCancelLease', async () => {
      expect((await practicalRows(h.accountId)).certificates[0]?.status).toBe('CONSUMED');
      expect(PracticalRecoveryService.checkOriginalCertificateWatch(h.recovery, { certificate: h.certificate, trustedNowMs: h.clock.nowMs() })).toEqual({ kind: 'UNCHANGED' });
      expect(await h.recovery.monitorAuthority()).toMatchObject({ kind: 'NO_OUTSTANDING_CERTIFICATE' });
    });
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'ACCEPTED' });
    expect(h.calls()).toBe(1);
    const after = await orderRow(h.order.intentId);
    expect(after.cancelState).toBe('CANCEL_ACKNOWLEDGED'); expect(after.cancelWireArmed).toBe(false);
    for (const key of ['orderedQuantity', 'cumulativeFilledQuantity', 'remainingQuantity', 'averageFillPrice', 'exchangeOrderId', 'pair'] as const) expect(after[key]).toEqual(before[key]);
    expect(after.state).toBe('CANCEL_REQUESTED'); // request bookkeeping, never CANCELLED/finality
    expect((await practicalRows(h.accountId)).certificates[0]?.status).toBe('CONSUMED');
  });
  it.each(['acquireCancelLease', 'armCancelLease', 'createCancelDispatchPermission', 'consumeCancelDispatchPermission'] as const)('watch trip during %s cleans only current owner', async method => {
    if (skip()) return;
    const h = await orchestrationFixture();
    h.after.set(method, () => { h.privateStream.unprove(); });
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(h.calls()).toBe(0);
    expect(h.methods.at(-1)).toBe(method === 'acquireCancelLease' ? 'abandonAcquiredCancel' : method === 'armCancelLease' ? 'completeUndispatchedCancel' : 'completeUnenteredCancelDispatch');
    expect((await orderRow(h.order.intentId)).cancelState).toBe('NONE');
    expect((await practicalRows(h.accountId)).state?.state).toBe('QUARANTINED');
  });
  it.each(['acquireCancelLease', 'armCancelLease', 'createCancelDispatchPermission', 'consumeCancelDispatchPermission'] as const)('time regression during %s never enters gateway', async method => {
    if (skip()) return;
    const h = await orchestrationFixture(); h.after.set(method, () => { h.clock.advance(-1); });
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' }); expect(h.calls()).toBe(0);
  });
  it.each(['acquireCancelLease', 'armCancelLease', 'createCancelDispatchPermission'] as const)('remote reconciliation supersession during %s refuses and cleans without renewed health', async method => {
    if (skip()) return;
    const h = await orchestrationFixture();
    h.after.set(method, async () => { await connectionB.liveReconciliationState.update({ where: { accountId: h.accountId }, data: { currentRuntimeEpoch: 'superseding-test-epoch' } }); });
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' }); expect(h.calls()).toBe(0);
  });
  it('does not claim a socket fence when remote supersession occurs after confirmed consumption', async () => {
    if (skip()) return;
    const h = await orchestrationFixture();
    h.after.set('consumeCancelDispatchPermission', async () => { await connectionB.liveReconciliationState.update({ where: { accountId: h.accountId }, data: { currentRuntimeEpoch: 'superseding-test-epoch' } }); });
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'ACCEPTED' }); expect(h.calls()).toBe(1);
    // This exposes the honest DB-to-socket gap; no strict authorization is minted.
    await expect(requireCurrentReconciliation(new PrismaLiveReconciliationRepository(connectionA), h.accountId, IDENTITY, 'CANCEL')).rejects.toThrow();
  });
  it.each(['COMMITTED', 'ROLLED_BACK'] as const)('genuine unknown consumption %s issues no attempt and never invokes or resends', async truth => {
    if (skip()) return;
    const h = await orchestrationFixture(); h.overrides.set('consumeCancelDispatchPermission', truth === 'COMMITTED' ? commitLostClient() : rollbackLostClient());
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(h.calls()).toBe(0); expect(h.methods.filter(m => m === 'consumeCancelDispatchPermission')).toHaveLength(1);
    expect((await orderRow(h.order.intentId)).revision).toBe(truth === 'COMMITTED' ? 6 : 5);
    const retried = await h.service.cancel(h.input); expect(retried.kind).not.toBe('COMPLETED'); expect(h.calls()).toBe(0);
  });
  it('CAS loser has no cleanup continuation or writes over the winner revision', async () => {
    if (skip()) return;
    const h = await orchestrationFixture();
    h.after.set('createCancelDispatchPermission', async () => { await connectionB.liveOrder.update({ where: { intentId: h.order.intentId }, data: { revision: { increment: 1 } } }); });
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'BLOCKED', code: 'PRACTICAL_MUTATION_DISPATCH_CONFLICT' });
    expect(h.calls()).toBe(0); expect(h.cleanupInputs).toEqual([]);
    expect((await practicalRows(h.accountId)).leases[0]?.status).toBe('LEASED'); expect((await orderRow(h.order.intentId)).cancelWireArmed).toBe(true);
    h.service.requestStop();
    expect(await h.service.drain()).toEqual({ kind: 'BLOCKED', code: 'PRACTICAL_MUTATION_DISPATCH_CONFLICT' });
    expect(h.calls()).toBe(0); expect(h.cleanupInputs).toEqual([]);
  });
  it.each(['COMMITTED', 'ROLLED_BACK'] as const)('unknown completion %s retries only the identical bookkeeping receipt', async truth => {
    if (skip()) return;
    const h = await orchestrationFixture(); h.overrides.set('completeCancelLease', truth === 'COMMITTED' ? commitLostClient() : rollbackLostClient());
    const continuation = requireBookkeeping(await h.service.cancel(h.input)); expect(h.calls()).toBe(1);
    h.overrides.delete('completeCancelLease');
    expect(await h.service.retryBookkeeping({ continuation })).toMatchObject({ kind: 'COMPLETED', outcome: 'ACCEPTED', disposition: truth === 'COMMITTED' ? 'ALREADY_COMPLETED' : 'COMPLETED' });
    const first = h.cleanupInputs[0] as { outcome: unknown }, second = h.cleanupInputs[1] as { outcome: unknown };
    expect(first.outcome).toBe(second.outcome); expect(h.calls()).toBe(1);
    expect(h.methods.filter(m => m === 'consumeCancelDispatchPermission')).toHaveLength(1);
  });
  it.each(['COMMITTED', 'ROLLED_BACK'] as const)('unknown creation with repeated unknown cleanup %s retains its hidden original owner', async truth => {
    if (skip()) return;
    const h = await orchestrationFixture();
    h.overrides.set('createCancelDispatchPermission', commitLostClient());
    h.overrides.set('completeUnenteredCancelDispatch', truth === 'COMMITTED' ? commitLostClient() : rollbackLostClient());
    const continuation = requireBookkeeping(await h.service.cancel(h.input));
    const first = h.cleanupInputs[0] as { owner: unknown; report: unknown };
    expect(PracticalArmedCancel.status(first.owner)).toBe('TRANSFERRED');
    for (let retry = 0; retry < 2; retry += 1) expect(await h.service.retryBookkeeping({ continuation })).toMatchObject({ kind: 'BLOCKED', code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    h.overrides.delete('completeUnenteredCancelDispatch');
    expect(await h.service.retryBookkeeping({ continuation })).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect((await orderRow(h.order.intentId)).revision).toBe(5);
    for (const value of h.cleanupInputs as Array<{ owner: unknown; report: unknown }>) { expect(value.owner).toBe(first.owner); expect(value.report).toBe(first.report); }
    expect(h.methods.filter(m => m === 'createCancelDispatchPermission')).toHaveLength(1);
    expect(h.methods).not.toContain('consumeCancelDispatchPermission'); expect(h.calls()).toBe(0);
  });
  it('startup disarm after real acquisition refuses the original watch and leaves only owned cleanup', async () => {
    if (skip()) return;
    const h = await orchestrationFixture();
    h.after.set('acquireCancelLease', async () => {
      expect(await h.recovery.recoverAtStartup()).toMatchObject({ kind: 'BLOCKED_MUTATION_LEASE_HELD' });
      expect(PracticalRecoveryService.checkOriginalCertificateWatch(h.recovery, { certificate: h.certificate, trustedNowMs: h.clock.nowMs() }).kind).toBe('REFUSED');
    });
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' }); expect(h.calls()).toBe(0);
  });
  it.each(['COMMITTED', 'ROLLED_BACK'] as const)('unknown acquire %s resolves then abandons; it cannot resume dispatch', async truth => {
    if (skip()) return;
    const h = await orchestrationFixture(); h.overrides.set('acquireCancelLease', truth === 'COMMITTED' ? commitLostClient() : rollbackLostClient());
    const continuation = requireBookkeeping(await h.service.cancel(h.input));
    const result = await h.service.retryBookkeeping({ continuation });
    expect(result).toMatchObject(truth === 'COMMITTED' ? { kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' } : { kind: 'NOT_COMMITTED', certificateStatus: 'ISSUED' });
    expect(h.calls()).toBe(0); expect(h.methods).not.toContain('armCancelLease'); expect(h.methods.filter(m => m === 'acquireCancelLease')).toHaveLength(1);
    expect(JSON.stringify(continuation)).toBe('{}');
  });
  it.each(['COMMITTED', 'ROLLED_BACK'] as const)('READY cleanup unknown %s retains original bounds and refuses unrelated advancement', async truth => {
    if (skip()) return;
    const h = await orchestrationFixture(); h.after.set('createCancelDispatchPermission', () => { h.privateStream.unprove(); });
    h.overrides.set('completeUnenteredCancelDispatch', truth === 'COMMITTED' ? commitLostClient() : rollbackLostClient());
    const continuation = requireBookkeeping(await h.service.cancel(h.input));
    h.overrides.delete('completeUnenteredCancelDispatch');
    await h.recovery.settled(); // measure only the retry, after independent tripwire invalidation
    const originalInput = h.cleanupInputs[0] as { owner: unknown; report: unknown };
    expect(PracticalCancelDispatchOwner.cleanupRevisions(originalInput.owner)).toEqual([4]);
    await connectionA.liveOrder.update({ where: { intentId: h.order.intentId }, data: { revision: { increment: 1 } } });
    const before = await durable(h.accountId, h.order.intentId);
    const observed = writeObserver(); h.overrides.set('completeUnenteredCancelDispatch', observed.client);
    expect((await h.service.retryBookkeeping({ continuation })).kind).toBe('BLOCKED');
    expect(observed.writes()).toBe(0);
    expect(await durable(h.accountId, h.order.intentId)).toEqual(before);
    const retryInput = h.cleanupInputs[1] as { owner: unknown; report: unknown };
    expect(retryInput.owner).toBe(originalInput.owner); expect(retryInput.report).toBe(originalInput.report);
    expect(PracticalCancelDispatchOwner.cleanupRevisions(originalInput.owner)).toEqual([4]); expect(h.calls()).toBe(0);
  });
  it.each(['PRE_DISPATCH_FAILURE', 'AMBIGUOUS', 'REJECTED'] as const)('reported %s preserves conservative durable classifications', async kind => {
    if (skip()) return;
    const h = await orchestrationFixture(); h.result({ kind, reasonCode: 'HTTP_400' });
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: kind === 'REJECTED' ? 'REJECTED' : 'AMBIGUOUS' });
    expect((await orderRow(h.order.intentId)).cancelState).toBe(kind === 'REJECTED' ? 'CANCEL_REJECTED' : 'CANCEL_AMBIGUOUS');
    expect((await practicalRows(h.accountId)).certificates[0]?.status).toBe('CONSUMED'); expect(h.calls()).toBe(1);
  });
});
