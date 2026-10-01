import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveExecutionIntentRecord } from '../../../src/execution/live/intent';
import { PrismaLiveExecutionRepository, consumeCancelDispatchWithinCallerFencedTransaction } from '../../../src/execution/live/repository';
import { issuePracticalRecoveryCertificate, type PracticalRecoveryCertificate } from '../../../src/execution/live/practical/certificate';
import { issuePracticalLiveSafetyEnablement, type PracticalLiveSafetyEnablement } from '../../../src/execution/live/practical/policy';
import type { PracticalAccountSnapshot } from '../../../src/execution/live/practical-persistence/ports';
import { PrismaPracticalSafetyRepository, withLockedPracticalAccountWithinCallerTransaction } from '../../../src/execution/live/practical-persistence/repository';
import { PrismaPracticalCancelMutationStore } from '../../../src/execution/live/practical-mutation/repository';
import { PracticalAcquiredCancel, PracticalArmedCancel, PracticalCancelDispatchOwner, enterPracticalCancelGateway, issuePracticalCancelOutcome, issuePracticalCancelTransportNoWire } from '../../../src/execution/live/practical-mutation/ticket';
import { providerAccountFingerprint } from '../../../src/execution/live/reconciliation/account-identity';
import { newLiveRuntimeIdentity, readLiveRuntimeEpoch, requireCurrentReconciliation } from '../../../src/execution/live/reconciliation/barrier';
import { DisposableMysqlGuardError, DisposableMysqlLifecycle, generateDisposableDatabaseName } from '../../helpers/p18b-disposable-mysql';
import { classifyPracticalCancelBinding, currentPracticalCancelBinding } from '../../../src/execution/live/practical-cancel-binding';

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
