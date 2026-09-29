import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveExecutionIntentRecord } from '../../../src/execution/live/intent';
import { classifyPracticalCancelBinding, currentPracticalCancelBinding } from '../../../src/execution/live/practical-cancel-binding';
import { PrismaLiveExecutionRepository } from '../../../src/execution/live/repository';
import { issuePracticalRecoveryCertificate, type PracticalRecoveryCertificate } from '../../../src/execution/live/practical/certificate';
import { issuePracticalLiveSafetyEnablement, type PracticalLiveSafetyEnablement } from '../../../src/execution/live/practical/policy';
import type { PracticalAccountSnapshot } from '../../../src/execution/live/practical-persistence/ports';
import { PrismaPracticalSafetyRepository } from '../../../src/execution/live/practical-persistence/repository';
import { PrismaPracticalCancelMutationStore } from '../../../src/execution/live/practical-mutation/repository';
import { PracticalAcquiredCancel, PracticalArmedCancel } from '../../../src/execution/live/practical-mutation/ticket';
import { providerAccountFingerprint } from '../../../src/execution/live/reconciliation/account-identity';
import { newLiveRuntimeIdentity, readLiveRuntimeEpoch, requireCurrentReconciliation } from '../../../src/execution/live/reconciliation/barrier';
import { PrismaLiveReconciliationRepository } from '../../../src/execution/live/reconciliation/repository';
import { LiveReconciliationService } from '../../../src/execution/live/reconciliation/service';
import { DisposableMysqlGuardError, DisposableMysqlLifecycle, generateDisposableDatabaseName } from '../../helpers/p18b-disposable-mysql';
import { EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT, FakeEvidenceProvider, FixedClock, evidenceSet, venueOrder } from '../../unit/execution/live/reconciliation/helpers';

// [P18B-1B2-W2B2b-DB] Real MySQL proof of the Stage 1B2 no-wire completion and in-process abandon:
//
//   LISTING   listAccountOrderViews reads orders, intents, and bindings in ONE explicit REPEATABLE READ
//             transaction: a completion committing between the two reads is never seen half-applied (no
//             false split pair); the read takes no lock.
//   FULL RUN  two real reconciliation runs: a run whose consistent snapshot saw LEASED + CANCEL_RESERVED
//             while a completion committed mid-run ends MANUAL_REVIEW_REQUIRED for THAT generation only; the
//             next ordinary run re-evaluates COMPLETED PRE_DISPATCH_FAILURE + NONE and is HEALTHY, with no
//             operator action and no authority grant (the practical account stays QUARANTINED; strict
//             Tier-A still refuses ACCOUNT_CONTINUITY_NOT_PROVEN).
//   NO-WIRE   completeUndispatchedCancel / abandonAcquiredCancel: both durable sides or neither, the release
//             variant derived only from the locked coupled pair, no reconciliation lock, split -> manual
//             review, retry / unknown-commit / idempotent-retry, and the ARM_OUTCOME_UNKNOWN lifecycle.
//
// Wave 2B2b writes ONLY PRE_DISPATCH_FAILURE: no AMBIGUOUS / REJECTED / ACCEPTED, no dispatch, no gateway.
// Failures are injected by TEST-ONLY client wrappers (no production failpoint, no trigger).
//
// NOTHING HERE TOUCHES COINDCX: the reconciliation evidence provider is the repository's in-memory fake.
//
// ACCEPTANCE SEMANTICS: soft-skips without a reachable local MySQL; with
// REQUIRE_LIVE_PRACTICAL_CANCEL_NOWIRE_DB_INTEGRATION=1 `beforeAll` THROWS instead. It always uses its own
// disposable database, dropped afterwards (also after a partial provisioning failure), and refuses, before any
// mysql/prisma command, a DATABASE_URL that is not mysql: on localhost / 127.0.0.1 / ::1 / [::1].

const STRICT = process.env['REQUIRE_LIVE_PRACTICAL_CANCEL_NOWIRE_DB_INTEGRATION'] === '1';
const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = generateDisposableDatabaseName();

let lifecycle: DisposableMysqlLifecycle | null = null;
let dbAvailable = false;
let connectionA: PrismaClient;
let connectionB: PrismaClient;
let observer: PrismaClient;

beforeAll(async () => {
  if (!BASE_DATABASE_URL) {
    if (STRICT) throw new Error('[P18B-W2B2b-DB] REQUIRE_LIVE_PRACTICAL_CANCEL_NOWIRE_DB_INTEGRATION=1 but no DATABASE_URL is configured.');
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
  console.warn('P18B Wave 2B2b no-wire DB suite skipped: no reachable disposable MySQL. Set REQUIRE_LIVE_PRACTICAL_CANCEL_NOWIRE_DB_INTEGRATION=1 to make this hard.');
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
async function acquired(): Promise<Acquired> {
  const accountId = freshAccount();
  const { account, certificate } = await certified(accountId);
  const order = intentRecord(accountId);
  await execution().ensureIntent(order);
  const exchangeOrderId = `venue-${randomBytes(4).toString('hex')}`;
  await connectionA.liveOrder.update({ where: { intentId: order.intentId }, data: { state: 'ACKNOWLEDGED', exchangeOrderId, revision: 2 } });
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

/** The exact durable end state of every no-wire completion (both sides), asserted row by row. */
async function expectClosedNoWire(seeded: Acquired, before: Awaited<ReturnType<typeof durable>>, armedAtMs: number | null, completedAtMs: number): Promise<void> {
  const after = await durable(seeded.accountId, seeded.order.intentId);
  expect(after.order).toMatchObject({
    state: before.order.state, cancelState: 'NONE', cancelGeneration: 1, cancelWireArmed: false, cancelFaultCode: null,
    cancelExchangeOrderId: before.order.cancelExchangeOrderId, revision: before.order.revision + 1, faultCode: before.order.faultCode,
  });
  expect(after.events).toEqual(before.events);
  expect(after.leases).toHaveLength(1);
  expect(after.leases[0]).toMatchObject({
    leaseId: before.leases[0]!.leaseId, status: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE', completedAtMs: BigInt(completedAtMs),
    armedAtMs: armedAtMs === null ? null : BigInt(armedAtMs), createdAtMs: before.leases[0]!.createdAtMs, intentId: seeded.order.intentId, cancelGeneration: 1,
  });
  expect(after.fence).toMatchObject({ mode: 'IDLE', leaseId: null, certificateId: null });
  expect(after.state!.state === 'QUARANTINED' || after.state!.state === 'MANUAL_REVIEW_REQUIRED').toBe(true);
  expect(after.state!.state).not.toBe('CERTIFIED_IDLE');
  // The CONSUMED certificate never returns to ISSUED and is otherwise byte-identical.
  expect(after.certificates).toEqual(before.certificates);
  expect(after.certificates.every((certificate) => certificate.status === 'CONSUMED')).toBe(true);
}

// ---------------------------------------------------------------------------
// L. Listing consistency
// ---------------------------------------------------------------------------

describe('P18B-W2B2b-DB L: the listing is ONE consistent, non-locking snapshot', () => {
  it('L1: a completion committing BETWEEN the order read and the binding read is never seen half-applied', { timeout: 60_000 }, async () => {
    if (skip()) return;
    const seeded = await acquired();
    let fired = false;
    const pausing = connectionA.$extends({
      query: {
        liveOrder: {
          async findMany({ args, query }: { args: unknown; query: (a: unknown) => Promise<unknown> }) {
            const rows = await query(args);
            if (!fired) {
              fired = true;
              // The abandon commits on ANOTHER connection while the listing's snapshot is already fixed.
              await store(connectionB).abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT });
            }
            return rows;
          },
        },
      },
    } as never) as unknown as PrismaClient;
    const views = await execution(pausing).listAccountOrderViews(seeded.accountId);
    expect(fired).toBe(true);
    const view = views.find((candidate) => candidate.intentId === seeded.order.intentId)!;
    // The consistent pre-completion snapshot: LEASED + CANCEL_RESERVED (never COMPLETED + CANCEL_RESERVED).
    expect(view.cancelState).toBe('CANCEL_RESERVED');
    expect(view.practicalCancelBinding).toMatchObject({ status: 'LEASED', outcome: null });
    expect(classifyPracticalCancelBinding(view.practicalCancelBinding, view.cancelState)).toBe('LEASED');
    // The completion really committed; a fresh listing sees the post-completion pair.
    const after = (await execution().listAccountOrderViews(seeded.accountId)).find((candidate) => candidate.intentId === seeded.order.intentId)!;
    expect(after.cancelState).toBe('NONE');
    expect(after.practicalCancelBinding).toMatchObject({ status: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(classifyPracticalCancelBinding(after.practicalCancelBinding, after.cancelState)).toBe('HISTORICAL');
  });

  it('L2 (control): the SAME interleaving with two separate autocommit reads really produces the false split pair', async () => {
    if (skip()) return;
    const seeded = await acquired();
    const order = await orderRow(seeded.order.intentId);
    expect(order.cancelState).toBe('CANCEL_RESERVED');
    await store(connectionB).abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT });
    const rows = await connectionA.$queryRaw<unknown[]>`SELECT lease_id AS leaseId, account_id AS accountId, intent_id AS intentId,
        client_order_id AS clientOrderId, cancel_generation AS cancelGeneration, status, outcome, armed_at_ms AS armedAtMs
      FROM live_practical_mutation_lease WHERE intent_id = ${seeded.order.intentId} AND cancel_generation = ${order.cancelGeneration}`;
    const binding = currentPracticalCancelBinding(rows, {
      accountId: seeded.accountId, intentId: seeded.order.intentId, clientOrderId: seeded.order.clientOrderId, cancelGeneration: order.cancelGeneration,
    });
    expect(binding).toMatchObject({ status: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(classifyPracticalCancelBinding(binding, order.cancelState)).toBe('SPLIT');
  });

  it('L3: the listing takes no lock: it returns while another connection holds live_order and the lease FOR UPDATE', { timeout: 60_000 }, async () => {
    if (skip()) return;
    const seeded = await acquired();
    let releaseHolder!: () => void;
    const holderMayCommit = new Promise<void>((resolve) => { releaseHolder = resolve; });
    let holderLocked!: () => void;
    const holderHasLocks = new Promise<void>((resolve) => { holderLocked = resolve; });
    const holder = observer.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT intent_id FROM live_order WHERE intent_id = ${seeded.order.intentId} FOR UPDATE`;
      await tx.$executeRaw`SELECT lease_id FROM live_practical_mutation_lease WHERE intent_id = ${seeded.order.intentId} FOR UPDATE`;
      holderLocked();
      await holderMayCommit;
    }, { timeout: 30_000, maxWait: 10_000 });
    await holderHasLocks;
    const listing = execution().listAccountOrderViews(seeded.accountId).then(() => 'RETURNED');
    const timeout = new Promise<string>((resolve) => { setTimeout(() => resolve('BLOCKED'), 5_000); });
    const outcome = await Promise.race([listing, timeout]);
    releaseHolder();
    await holder;
    expect(outcome).toBe('RETURNED');
  });
});

// ---------------------------------------------------------------------------
// R. Full two-run reconciliation
// ---------------------------------------------------------------------------

/** The fake provider, whose FIRST order read runs `hook` to completion (after the run's listing, before findings). */
class InterleavingEvidenceProvider extends FakeEvidenceProvider {
  #hook: (() => Promise<void>) | null;

  public constructor(evidence: ConstructorParameters<typeof FakeEvidenceProvider>[0], hook: (() => Promise<void>) | null) {
    super(evidence);
    this.#hook = hook;
  }

  public override async readOrders(): ReturnType<FakeEvidenceProvider['readOrders']> {
    const hook = this.#hook;
    this.#hook = null;
    if (hook !== null) await hook();
    return super.readOrders();
  }
}

function reconciliationService(seeded: Acquired, hook: (() => Promise<void>) | null) {
  const runtimeIdentity = newLiveRuntimeIdentity();
  const provider = new InterleavingEvidenceProvider(evidenceSet({
    accountId: seeded.accountId,
    orders: [venueOrder({ exchangeOrderId: seeded.exchangeOrderId })],
  }), hook);
  const service = new LiveReconciliationService({
    repository: new PrismaLiveReconciliationRepository(connectionA),
    executionRepository: execution(),
    evidenceProvider: provider as never,
    runtimeIdentity,
    credentialAccountId: seeded.accountId,
    expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
    clock: new FixedClock(),
  });
  return { service, runtimeIdentity, provider };
}

async function findingRows(accountId: string) {
  return connectionA.liveReconciliationFinding.findMany({ where: { accountId }, orderBy: { findingSha256: 'asc' } });
}

async function runAndReport(service: LiveReconciliationService, accountId: string) {
  const outcome = await service.reconcileAccount(accountId);
  if (outcome.kind !== 'COMPLETED') throw new Error(`run did not complete: ${outcome.kind}`);
  return outcome.result;
}

async function expectNoAuthorityGranted(seeded: Acquired, runtimeIdentity: ReturnType<typeof newLiveRuntimeIdentity>): Promise<void> {
  const rows = await practicalRows(seeded.accountId);
  expect(rows.state!.state).toBe('QUARANTINED');
  expect(rows.fence).toMatchObject({ mode: 'IDLE' });
  expect(rows.certificates.every((certificate) => certificate.status !== 'ISSUED')).toBe(true);
  await expect(requireCurrentReconciliation(new PrismaLiveReconciliationRepository(connectionA), seeded.accountId, runtimeIdentity, 'CANCEL'))
    .rejects.toMatchObject({ details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
}

describe('P18B-W2B2b-DB R: a completion racing a reconciliation run leaves no persistent manual-review state', () => {
  it.each([
    ['R1 (unarmed, via abandon)', false],
    ['R2 (armed, via completeUndispatchedCancel)', true],
  ] as const)('%s: run G ends MANUAL_REVIEW_REQUIRED (true at its snapshot); the ordinary run G+1 is HEALTHY, no operator action', { timeout: 120_000 }, async (_label, armedCase) => {
    if (skip()) return;
    const seeded = armedCase ? await armed() : await acquired();
    const close = armedCase
      ? () => store(connectionB).completeUndispatchedCancel({ armed: (seeded as Acquired & { ticket: PracticalArmedCancel }).ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT })
      : () => store(connectionB).abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT });
    let completion: unknown = null;
    const { service, runtimeIdentity, provider } = reconciliationService(seeded, async () => { completion = await close(); });

    // ---- run G: its listing snapshot is LEASED + CANCEL_RESERVED; the completion commits during its evidence read.
    const runG = await runAndReport(service, seeded.accountId);
    expect(completion).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(provider.orderCalls).toBeGreaterThan(0);
    expect(runG.status).toBe('MANUAL_REVIEW_REQUIRED');
    expect(runG.findings.map((finding) => finding.code)).toContain('RECON_CANCEL_CLAIM_PRACTICALLY_BOUND');
    const generationG = runG.generation;
    const staleFinding = (await findingRows(seeded.accountId)).filter((row) => row.code === 'RECON_CANCEL_CLAIM_PRACTICALLY_BOUND');
    expect(staleFinding).toHaveLength(1);
    expect(staleFinding[0]).toMatchObject({ lastSeenGeneration: generationG, resolvedAtMs: null, blocking: true, category: 'AMBIGUOUS' });
    // Reconciliation applied NO claim effect: the claim is NONE because of the completion, and the lease is COMPLETED.
    expect(await orderRow(seeded.order.intentId)).toMatchObject({ cancelState: 'NONE', cancelGeneration: 1, cancelWireArmed: false });
    expect((await practicalRows(seeded.accountId)).leases[0]).toMatchObject({ status: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    const practicalAfterG = await practicalRows(seeded.accountId);

    // ---- run G+1: an ordinary run. Nothing between the runs: no operator call, no finding write, no resolution.
    const runNext = await runAndReport(service, seeded.accountId);
    expect(runNext.generation).toBe(generationG + 1);
    expect(runNext.status).toBe('HEALTHY');
    expect(runNext.blockingFindingCount).toBe(0);
    expect(runNext.findings.filter((finding) => finding.subject.intentId === seeded.order.intentId && finding.category !== 'VERIFIED_MATCH')).toEqual([]);
    expect(runNext.state).toMatchObject({ status: 'HEALTHY', healthyGeneration: generationG + 1, blockingFindingCount: 0 });
    // The G finding row is untouched history: still last seen in G, never resolved by anyone, and not counted.
    expect((await findingRows(seeded.accountId)).filter((row) => row.code === 'RECON_CANCEL_CLAIM_PRACTICALLY_BOUND')).toEqual(staleFinding);
    // G+1 did not touch the practical rows.
    expect(await practicalRows(seeded.accountId)).toEqual(practicalAfterG);
    // A genuine repository-level HEALTHY read exists for G+1's runtime, but nothing grants Tier-B or strict authority.
    const { authorization } = await new PrismaLiveReconciliationRepository(connectionA).authorizeCurrentHealthy(seeded.accountId, runtimeIdentity);
    expect(authorization).not.toBeNull();
    await expectNoAuthorityGranted(seeded, runtimeIdentity);
  });

  it('R3 (control): with NO completion, run G+1 still raises the practically-bound finding and stays MANUAL_REVIEW_REQUIRED', { timeout: 120_000 }, async () => {
    if (skip()) return;
    const seeded = await acquired();
    const { service } = reconciliationService(seeded, null);
    const runG = await runAndReport(service, seeded.accountId);
    const runNext = await runAndReport(service, seeded.accountId);
    for (const run of [runG, runNext]) {
      expect(run.status).toBe('MANUAL_REVIEW_REQUIRED');
      expect(run.findings.map((finding) => finding.code)).toContain('RECON_CANCEL_CLAIM_PRACTICALLY_BOUND');
    }
    const rows = (await findingRows(seeded.accountId)).filter((row) => row.code === 'RECON_CANCEL_CLAIM_PRACTICALLY_BOUND');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastSeenGeneration).toBe(runNext.generation);
    expect(await orderRow(seeded.order.intentId)).toMatchObject({ cancelState: 'CANCEL_RESERVED' });
    expect((await practicalRows(seeded.accountId)).leases[0]).toMatchObject({ status: 'LEASED' });
  });

  it('R4: a completion committed BEFORE run G: run G itself is HEALTHY', { timeout: 120_000 }, async () => {
    if (skip()) return;
    const seeded = await acquired();
    await store(connectionB).abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT });
    const { service, runtimeIdentity } = reconciliationService(seeded, null);
    const runG = await runAndReport(service, seeded.accountId);
    expect(runG.status).toBe('HEALTHY');
    expect(runG.findings.map((finding) => finding.code)).not.toContain('RECON_CANCEL_CLAIM_PRACTICALLY_BOUND');
    await expectNoAuthorityGranted(seeded, runtimeIdentity);
  });
});

// ---------------------------------------------------------------------------
// U. completeUndispatchedCancel
// ---------------------------------------------------------------------------

describe('P18B-W2B2b-DB U: completeUndispatchedCancel (armed, never dispatched) closes BOTH sides or neither', () => {
  it('U1: atomic on both sides; the ticket is SPENT; afterwards a Tier-A claim moves to generation 2 and Stage 1B1 release refuses the completed lease', async () => {
    if (skip()) return;
    const seeded = await armed();
    const before = await durable(seeded.accountId, seeded.order.intentId);
    expect(before.order).toMatchObject({ cancelState: 'CANCEL_RESERVED', cancelWireArmed: true });
    const result = await store().completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT });
    expect(result).toEqual({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE', leaseId: before.leases[0]!.leaseId, intentId: seeded.order.intentId, cancelGeneration: 1 });
    await expectClosedNoWire(seeded, before, ARM_AT, CLOSE_AT);
    expect(PracticalArmedCancel.status(seeded.ticket)).toBe('SPENT');
    // Stage 1B1 release still refuses the (now completed) bound lease.
    const account = await practical().loadAccount(seeded.accountId);
    if (account.kind !== 'FOUND') throw new Error('fixture: account');
    await expect(practical().releaseLease({
      accountId: seeded.accountId, expected: expectationOf(account.account), leaseId: before.leases[0]!.leaseId, outcome: 'PRE_DISPATCH_FAILURE', nowMs: CLOSE_AT + 1,
    })).rejects.toBeInstanceOf(Error);
    // The historical binding never blocks: a Tier-A claim (repository level) moves to generation 2.
    const { authorization } = await new PrismaLiveReconciliationRepository(connectionA).authorizeCurrentHealthy(seeded.accountId, IDENTITY);
    expect(await execution().claimCancel(seeded.order.intentId, seeded.accountId, authorization)).toMatchObject({ kind: 'CLAIMED', generation: 2 });
    // A SPENT ticket is refused before any durable access.
    await expect(store().completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT })).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
  });

  it('U2: cleanup needs no authority: invalidated to QUARANTINED mid-mutation, reconciliation RUNNING, certificate window over', async () => {
    if (skip()) return;
    const seeded = await armed();
    await practical().invalidate({ accountId: seeded.accountId, reason: 'WS_DISCONNECTED', nowMs: ARM_AT + 1 });
    await new PrismaLiveReconciliationRepository(connectionA).claimGeneration(seeded.accountId, newLiveRuntimeIdentity(), ARM_AT + 2);
    const before = await durable(seeded.accountId, seeded.order.intentId);
    expect(before.state!.state).toBe('QUARANTINED');
    expect(before.fence).toMatchObject({ mode: 'MUTATION_LEASED' });
    const afterExpiry = T0 + 10 * 60_000; // far beyond the certificate window
    expect((await store().completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: afterExpiry })).kind).toBe('COMPLETED');
    await expectClosedNoWire(seeded, before, ARM_AT, afterExpiry);
    expect((await practicalRows(seeded.accountId)).state!.state).toBe('QUARANTINED');
  });

  it('U2b: an account moved to MANUAL_REVIEW_REQUIRED mid-mutation stays MANUAL_REVIEW_REQUIRED after the completion', async () => {
    if (skip()) return;
    const seeded = await armed();
    await practical().enterManualReview({ accountId: seeded.accountId, reason: 'ORPHAN_ORDER', nowMs: ARM_AT + 1 });
    const before = await durable(seeded.accountId, seeded.order.intentId);
    expect((await store().completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT })).kind).toBe('COMPLETED');
    await expectClosedNoWire(seeded, before, ARM_AT, CLOSE_AT);
    expect((await practicalRows(seeded.accountId)).state!.state).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('U3: no reconciliation lock: completion commits while another connection holds live_reconciliation_state FOR UPDATE', { timeout: 60_000 }, async () => {
    if (skip()) return;
    const seeded = await armed();
    let releaseHolder!: () => void;
    const holderMayCommit = new Promise<void>((resolve) => { releaseHolder = resolve; });
    let holderLocked!: () => void;
    const holderHasLock = new Promise<void>((resolve) => { holderLocked = resolve; });
    const holder = observer.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT account_id FROM live_reconciliation_state WHERE account_id = ${seeded.accountId} FOR UPDATE`;
      holderLocked();
      await holderMayCommit;
    }, { timeout: 30_000, maxWait: 10_000 });
    await holderHasLock;
    const completion = store().completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT }).then((result) => result.kind);
    const timeout = new Promise<string>((resolve) => { setTimeout(() => resolve('BLOCKED'), 8_000); });
    const outcome = await Promise.race([completion, timeout]);
    releaseHolder();
    await holder;
    expect(outcome).toBe('COMPLETED');
  });

  it('U5: a case-only lease identity tamper (collation match) is refused with zero change; the ticket stays ARMED', async () => {
    if (skip()) return;
    const seeded = await armed();
    await tamperWithoutForeignKeys((tx) => tx.$executeRawUnsafe('UPDATE live_practical_mutation_lease SET client_order_id = UPPER(client_order_id) WHERE intent_id = ?', seeded.order.intentId));
    const before = await durable(seeded.accountId, seeded.order.intentId);
    await expect(store().completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT })).rejects.toBeInstanceOf(Error);
    expect(await durable(seeded.accountId, seeded.order.intentId)).toEqual(before);
    expect(PracticalArmedCancel.status(seeded.ticket)).toBe('ARMED');
  });

  it('U6: a split pair (Phase 17 unarmed while the lease is armed) rolls back, enters durable manual review, keeps the fence leased', async () => {
    if (skip()) return;
    const seeded = await armed();
    await connectionA.$executeRaw`UPDATE live_order SET cancel_wire_armed = 0 WHERE intent_id = ${seeded.order.intentId}`;
    const beforeOrder = await orderRow(seeded.order.intentId);
    const beforeLease = (await practicalRows(seeded.accountId)).leases;
    await expect(store().completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_SPLIT_STATE' });
    const rows = await practicalRows(seeded.accountId);
    expect(await orderRow(seeded.order.intentId)).toEqual(beforeOrder);
    expect(rows.leases).toEqual(beforeLease);
    expect(rows.state!.state).toBe('MANUAL_REVIEW_REQUIRED');
    expect(rows.reviews.filter((review) => review.reason === 'POST_MUTATION_MISMATCH' && review.status === 'OPEN')).toHaveLength(1);
    expect(rows.fence).toMatchObject({ mode: 'MUTATION_LEASED' });
    expect(PracticalArmedCancel.status(seeded.ticket)).toBe('ARMED');
  });

  it.each([
    ['after the Phase 17 release UPDATE, before the practical write', 'liveOrder', 'updateMany'],
    ['after the lease compare-and-set, before the fence write and re-reads', 'livePracticalMutationLease', 'updateMany'],
  ] as const)('U7: a failure %s rolls BOTH sides back; the ticket is ARMED again and then completes', async (_label, model, operation) => {
    if (skip()) return;
    const seeded = await armed();
    const before = await durable(seeded.accountId, seeded.order.intentId);
    await expect(store(failAfter(model, operation)).completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT }))
      .rejects.toBeInstanceOf(InjectedFault);
    expect(await durable(seeded.accountId, seeded.order.intentId)).toEqual(before);
    expect(PracticalArmedCancel.status(seeded.ticket)).toBe('ARMED');
    expect((await store().completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT })).kind).toBe('COMPLETED');
    await expectClosedNoWire(seeded, before, ARM_AT, CLOSE_AT);
  });

  it('U8: one deadlock is retried inside ONE call; exhausted deadlock retries are a FAULT with zero change and the ticket ARMED', async () => {
    if (skip()) return;
    const seeded = await armed();
    const deadlock = () => new Prisma.PrismaClientKnownRequestError('simulated deadlock', { code: 'P2034', clientVersion: 'test' });
    const before = await durable(seeded.accountId, seeded.order.intentId);
    await expect(store(failWith('livePracticalMutationLease', 'updateMany', deadlock, 3)).completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_FAULT' });
    expect(await durable(seeded.accountId, seeded.order.intentId)).toEqual(before);
    expect(PracticalArmedCancel.status(seeded.ticket)).toBe('ARMED');
    expect((await store(failWith('livePracticalMutationLease', 'updateMany', deadlock, 1)).completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT })).kind).toBe('COMPLETED');
    await expectClosedNoWire(seeded, before, ARM_AT, CLOSE_AT);
  });

  it('U9: a lost COMMIT acknowledgement -> COMMIT_UNKNOWN; a different reason is refused; the identical retry is ALREADY_COMPLETED', async () => {
    if (skip()) return;
    const seeded = await armed();
    const before = await durable(seeded.accountId, seeded.order.intentId);
    await expect(store(commitLostClient()).completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    expect(PracticalArmedCancel.status(seeded.ticket)).toBe('COMMIT_UNKNOWN');
    await expectClosedNoWire(seeded, before, ARM_AT, CLOSE_AT); // it DID commit
    await expect(store().completeUndispatchedCancel({ armed: seeded.ticket, report: { kind: 'NOT_DISPATCHED', reason: 'ABORTED_BEFORE_DISPATCH' }, trustedNowMs: CLOSE_AT }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    const committed = await durable(seeded.accountId, seeded.order.intentId);
    expect((await store().completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT + 99 })).kind).toBe('ALREADY_COMPLETED');
    expect(await durable(seeded.accountId, seeded.order.intentId)).toEqual(committed);
    expect(PracticalArmedCancel.status(seeded.ticket)).toBe('SPENT');
  });

  it('U10: clock regression: the stored completion instant is the monotonic arm instant and the frozen CHECK holds', async () => {
    if (skip()) return;
    const seeded = await armed();
    const before = await durable(seeded.accountId, seeded.order.intentId);
    expect((await store().completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: NOW - 30_000 })).kind).toBe('COMPLETED');
    await expectClosedNoWire(seeded, before, ARM_AT, ARM_AT);
  });

  it('U11: a malformed practical row (case-only certificate fingerprint) latches the account; nothing is released', async () => {
    if (skip()) return;
    const seeded = await armed();
    const certificateId = (await practicalRows(seeded.accountId)).certificates[0]!.certificateId;
    await connectionA.$executeRaw`UPDATE live_practical_certificate SET provider_account_fingerprint = UPPER(provider_account_fingerprint) WHERE certificate_id = ${certificateId}`;
    const beforeOrder = await orderRow(seeded.order.intentId);
    const result = await store().completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT });
    expect(result.kind).toBe('MALFORMED_LATCHED');
    expect(await orderRow(seeded.order.intentId)).toEqual(beforeOrder);
    expect((await practicalRows(seeded.accountId)).leases[0]).toMatchObject({ status: 'LEASED' });
    expect(PracticalArmedCancel.status(seeded.ticket)).toBe('ARMED');
  });

  it('U13: a completion racing a guarded Phase 18 reclaim on two connections never splits the pair', { timeout: 60_000 }, async () => {
    if (skip()) return;
    const seeded = await armed();
    const authorization = (await new PrismaLiveReconciliationRepository(connectionA).claimGeneration(seeded.accountId, newLiveRuntimeIdentity(), ARM_AT + 2));
    if (authorization.kind !== 'CLAIMED') throw new Error('fixture: generation');
    const current = await execution().load(seeded.order.intentId);
    const cleared = Object.freeze({ ...current!, cancelState: 'NONE' as const, cancelFaultCode: null, cancelWireArmed: false, revision: current!.revision + 1 });
    const [completion, reclaim] = await Promise.allSettled([
      store(connectionB).completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT }),
      execution(connectionA).commitReconciledState(cleared, current!.revision, null, authorization.authorization),
    ]);
    expect(completion.status).toBe('fulfilled');
    expect(reclaim.status).toBe('rejected');
    const order = await orderRow(seeded.order.intentId);
    const lease = (await practicalRows(seeded.accountId)).leases[0]!;
    expect(order).toMatchObject({ cancelState: 'NONE', cancelGeneration: 1, cancelWireArmed: false });
    expect(lease).toMatchObject({ status: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(order.revision).toBe(current!.revision + 1); // exactly ONE writer moved the claim: the joint completion
  });
});

// ---------------------------------------------------------------------------
// A. abandonAcquiredCancel, including ARM_OUTCOME_UNKNOWN
// ---------------------------------------------------------------------------

describe('P18B-W2B2b-DB A: abandonAcquiredCancel closes BOTH sides, choosing the release ONLY from the durable pair', () => {
  it('A1: an AVAILABLE handle (never armed) is abandoned atomically; the handle is SPENT and can never arm', async () => {
    if (skip()) return;
    const seeded = await acquired();
    const before = await durable(seeded.accountId, seeded.order.intentId);
    expect((await store().abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT })).kind).toBe('COMPLETED');
    await expectClosedNoWire(seeded, before, null, CLOSE_AT);
    expect(PracticalAcquiredCancel.status(seeded.handle)).toBe('SPENT');
    await expect(store().armCancelLease({ acquired: seeded.handle, enablement: enablementFor(seeded.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
  });

  it('A1b: an AVAILABLE handle after a PROVEN arm refusal is abandoned atomically', async () => {
    if (skip()) return;
    const seeded = await acquired();
    await expect(store().armCancelLease({ acquired: seeded.handle, enablement: enablementFor(seeded.accountId), runtimeIdentity: IDENTITY, trustedNowMs: T0 + 1 }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_ARM_REFUSED' });
    expect(PracticalAcquiredCancel.status(seeded.handle)).toBe('AVAILABLE');
    const before = await durable(seeded.accountId, seeded.order.intentId);
    expect((await store().abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT })).kind).toBe('COMPLETED');
    await expectClosedNoWire(seeded, before, null, CLOSE_AT);
  });

  it('A2: ARM_OUTCOME_UNKNOWN whose transaction really ROLLED BACK (durably unarmed): the handle state and durable rows are asserted separately, then the UNARMED release', async () => {
    if (skip()) return;
    const seeded = await acquired();
    const beforeArm = await durable(seeded.accountId, seeded.order.intentId);
    await expect(store(rollbackLostClient()).armCancelLease({ acquired: seeded.handle, enablement: enablementFor(seeded.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    // The in-memory outcome is UNKNOWN ...
    expect(PracticalAcquiredCancel.status(seeded.handle)).toBe('ARM_OUTCOME_UNKNOWN');
    // ... while the durable truth is: nothing committed (both sides unarmed, every row unchanged).
    expect(await durable(seeded.accountId, seeded.order.intentId)).toEqual(beforeArm);
    expect(beforeArm.order.cancelWireArmed).toBe(false);
    expect(beforeArm.leases[0]!.armedAtMs).toBeNull();
    expect((await store().abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT })).kind).toBe('COMPLETED');
    await expectClosedNoWire(seeded, beforeArm, null, CLOSE_AT);
    expect(PracticalAcquiredCancel.status(seeded.handle)).toBe('SPENT');
  });

  it('A3: ARM_OUTCOME_UNKNOWN whose arm really COMMITTED (response lost; durably armed): the ARMED-UNDISPATCHED release', async () => {
    if (skip()) return;
    const seeded = await acquired();
    await expect(store(commitLostClient()).armCancelLease({ acquired: seeded.handle, enablement: enablementFor(seeded.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    expect(PracticalAcquiredCancel.status(seeded.handle)).toBe('ARM_OUTCOME_UNKNOWN');
    const beforeAbandon = await durable(seeded.accountId, seeded.order.intentId);
    expect(beforeAbandon.order.cancelWireArmed).toBe(true);
    expect(beforeAbandon.leases[0]!.armedAtMs).toBe(BigInt(ARM_AT));
    expect((await store().abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT })).kind).toBe('COMPLETED');
    await expectClosedNoWire(seeded, beforeAbandon, ARM_AT, CLOSE_AT);
  });

  it('A4: arm refuses an ARM_OUTCOME_UNKNOWN handle (no ticket can ever be minted from it)', async () => {
    if (skip()) return;
    const seeded = await acquired();
    await expect(store(commitLostClient()).armCancelLease({ acquired: seeded.handle, enablement: enablementFor(seeded.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    await expect(store().armCancelLease({ acquired: seeded.handle, enablement: enablementFor(seeded.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT + 1 }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    expect(PracticalAcquiredCancel.status(seeded.handle)).toBe('ARM_OUTCOME_UNKNOWN');
  });

  it('A5: an AVAILABLE handle with a durably armed pair (tampered) is a split: manual review, zero release', async () => {
    if (skip()) return;
    const seeded = await acquired();
    await connectionA.$executeRaw`UPDATE live_order SET cancel_wire_armed = 1 WHERE intent_id = ${seeded.order.intentId}`;
    await connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET armed_at_ms = ${BigInt(ARM_AT)} WHERE intent_id = ${seeded.order.intentId}`;
    const beforeOrder = await orderRow(seeded.order.intentId);
    await expect(store().abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT })).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_SPLIT_STATE' });
    expect(await orderRow(seeded.order.intentId)).toEqual(beforeOrder);
    const rows = await practicalRows(seeded.accountId);
    expect(rows.leases[0]).toMatchObject({ status: 'LEASED' });
    expect(rows.state!.state).toBe('MANUAL_REVIEW_REQUIRED');
    expect(PracticalAcquiredCancel.status(seeded.handle)).toBe('AVAILABLE');
  });

  it('A6: a lost abandon COMMIT acknowledgement -> ABANDON_OUTCOME_UNKNOWN; the retry is ALREADY_COMPLETED', async () => {
    if (skip()) return;
    const seeded = await acquired();
    const before = await durable(seeded.accountId, seeded.order.intentId);
    await expect(store(commitLostClient()).abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT })).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    expect(PracticalAcquiredCancel.status(seeded.handle)).toBe('ABANDON_OUTCOME_UNKNOWN');
    await expectClosedNoWire(seeded, before, null, CLOSE_AT);
    expect((await store().abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT + 1 })).kind).toBe('ALREADY_COMPLETED');
    expect(PracticalAcquiredCancel.status(seeded.handle)).toBe('SPENT');
  });

  it('A6b: an ARM_OUTCOME_UNKNOWN-origin handle (arm really committed) whose abandon COMMIT was lost: the retry is ALREADY_COMPLETED over the armed pair', async () => {
    if (skip()) return;
    const seeded = await acquired();
    await expect(store(commitLostClient()).armCancelLease({ acquired: seeded.handle, enablement: enablementFor(seeded.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    const before = await durable(seeded.accountId, seeded.order.intentId);
    await expect(store(commitLostClient()).abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT })).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    expect(PracticalAcquiredCancel.status(seeded.handle)).toBe('ABANDON_OUTCOME_UNKNOWN');
    await expectClosedNoWire(seeded, before, ARM_AT, CLOSE_AT);
    const committed = await everything(seeded);
    expect((await store().abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT + 1 })).kind).toBe('ALREADY_COMPLETED');
    expect(await everything(seeded)).toEqual(committed);
    expect(PracticalAcquiredCancel.status(seeded.handle)).toBe('SPENT');
  });

  it('A7: an abandon failing after the Phase 17 release rolls both sides back and restores the handle; the same handle then abandons', async () => {
    if (skip()) return;
    const seeded = await acquired();
    const before = await durable(seeded.accountId, seeded.order.intentId);
    await expect(store(failAfter('liveOrder', 'updateMany')).abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT })).rejects.toBeInstanceOf(InjectedFault);
    expect(await durable(seeded.accountId, seeded.order.intentId)).toEqual(before);
    expect(PracticalAcquiredCancel.status(seeded.handle)).toBe('AVAILABLE');
    expect((await store().abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT })).kind).toBe('COMPLETED');
    await expectClosedNoWire(seeded, before, null, CLOSE_AT);
  });
});

// ---------------------------------------------------------------------------
// I. The idempotent retry re-proves the exact identity and arm origin
// ---------------------------------------------------------------------------

/** A genuine COMMIT_UNKNOWN ticket whose completion REALLY committed (the COMMIT acknowledgement was lost). */
async function committedButUnknownTicket(): Promise<Acquired & { readonly ticket: PracticalArmedCancel }> {
  const seeded = await armed();
  const before = await durable(seeded.accountId, seeded.order.intentId);
  await expect(store(commitLostClient()).completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT }))
    .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
  expect(PracticalArmedCancel.status(seeded.ticket)).toBe('COMMIT_UNKNOWN');
  await expectClosedNoWire(seeded, before, ARM_AT, CLOSE_AT);
  return seeded;
}

/** A genuine ABANDON_OUTCOME_UNKNOWN handle of AVAILABLE origin whose abandon REALLY committed. */
async function committedButUnknownAbandon(): Promise<Acquired> {
  const seeded = await acquired();
  const before = await durable(seeded.accountId, seeded.order.intentId);
  await expect(store(commitLostClient()).abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT }))
    .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
  expect(PracticalAcquiredCancel.status(seeded.handle)).toBe('ABANDON_OUTCOME_UNKNOWN');
  await expectClosedNoWire(seeded, before, null, CLOSE_AT);
  return seeded;
}

type Tamper = (seeded: Acquired) => Promise<unknown>;
const ORDER_TAMPERS: readonly (readonly [string, Tamper])[] = [
  ['a case-only pair change', (seeded) => connectionA.$executeRaw`UPDATE live_order SET pair = LOWER(pair) WHERE intent_id = ${seeded.order.intentId}`],
  ['another pair', (seeded) => connectionA.$executeRaw`UPDATE live_order SET pair = 'B-ETH_USDT' WHERE intent_id = ${seeded.order.intentId}`],
  ['a case-only exchange order id change', (seeded) => connectionA.$executeRaw`UPDATE live_order SET exchange_order_id = UPPER(exchange_order_id) WHERE intent_id = ${seeded.order.intentId}`],
  ['another exchange order id', (seeded) => connectionA.$executeRaw`UPDATE live_order SET exchange_order_id = CONCAT(exchange_order_id, 'x') WHERE intent_id = ${seeded.order.intentId}`],
  ['a case-only cancel exchange order id change', (seeded) => connectionA.$executeRaw`UPDATE live_order SET cancel_exchange_order_id = UPPER(cancel_exchange_order_id) WHERE intent_id = ${seeded.order.intentId}`],
];

describe('P18B-W2B2b-DB I: an unknown-commit retry returns ALREADY_COMPLETED only for the exact durable completion', () => {
  it.each([
    ...ORDER_TAMPERS,
    ['the completed lease\'s arm instant', (seeded: Acquired) => connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET armed_at_ms = armed_at_ms + 1 WHERE intent_id = ${seeded.order.intentId}`],
  ] as const)('I1: COMMIT_UNKNOWN ticket, completion committed, then %s: the retry is COMPLETION_REFUSED, zero writes, ticket still COMMIT_UNKNOWN', async (_label, tamper) => {
    if (skip()) return;
    const seeded = await committedButUnknownTicket();
    await tamper(seeded);
    const tampered = await everything(seeded);
    await expect(store().completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT + 99 }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMPLETION_REFUSED' });
    expect(await everything(seeded)).toEqual(tampered);
    expect(PracticalArmedCancel.status(seeded.ticket)).toBe('COMMIT_UNKNOWN');
    // The refusal is stable: a second identical retry is refused the same way.
    await expect(store().completeUndispatchedCancel({ armed: seeded.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT + 100 }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMPLETION_REFUSED' });
    expect(await everything(seeded)).toEqual(tampered);
  });

  it.each([
    ...ORDER_TAMPERS,
    ['the completed lease\'s armedAtMs (AVAILABLE origin never armed)', (seeded: Acquired) => connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET armed_at_ms = created_at_ms WHERE intent_id = ${seeded.order.intentId}`],
  ] as const)('I2: AVAILABLE-origin ABANDON_OUTCOME_UNKNOWN handle, abandon committed, then %s: the retry is COMPLETION_REFUSED, zero writes, handle still ABANDON_OUTCOME_UNKNOWN', async (_label, tamper) => {
    if (skip()) return;
    const seeded = await committedButUnknownAbandon();
    await tamper(seeded);
    const tampered = await everything(seeded);
    await expect(store().abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT + 1 }))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMPLETION_REFUSED' });
    expect(await everything(seeded)).toEqual(tampered);
    expect(PracticalAcquiredCancel.status(seeded.handle)).toBe('ABANDON_OUTCOME_UNKNOWN');
  });

  it('I3: identical retries with NO tamper stay ALREADY_COMPLETED with zero writes (ticket and AVAILABLE-origin handle)', async () => {
    if (skip()) return;
    const ticketSeed = await committedButUnknownTicket();
    const ticketRows = await everything(ticketSeed);
    expect((await store().completeUndispatchedCancel({ armed: ticketSeed.ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT + 99 })).kind).toBe('ALREADY_COMPLETED');
    expect(await everything(ticketSeed)).toEqual(ticketRows);
    expect(PracticalArmedCancel.status(ticketSeed.ticket)).toBe('SPENT');
    const handleSeed = await committedButUnknownAbandon();
    const handleRows = await everything(handleSeed);
    expect((await store().abandonAcquiredCancel({ acquired: handleSeed.handle, trustedNowMs: CLOSE_AT + 1 })).kind).toBe('ALREADY_COMPLETED');
    expect(await everything(handleSeed)).toEqual(handleRows);
    expect(PracticalAcquiredCancel.status(handleSeed.handle)).toBe('SPENT');
  });

  it('I4: a LEGITIMATE later cancel generation (a real Tier-A claim, generation 2 CANCEL_RESERVED) keeps both retries ALREADY_COMPLETED with zero writes', async () => {
    if (skip()) return;
    for (const seeded of [await committedButUnknownTicket(), await committedButUnknownAbandon()]) {
      const { authorization } = await new PrismaLiveReconciliationRepository(connectionA).authorizeCurrentHealthy(seeded.accountId, IDENTITY);
      expect(await execution().claimCancel(seeded.order.intentId, seeded.accountId, authorization)).toMatchObject({ kind: 'CLAIMED', generation: 2 });
      const later = await everything(seeded);
      expect(later.order).toMatchObject({ cancelGeneration: 2, cancelState: 'CANCEL_RESERVED', exchangeOrderId: seeded.exchangeOrderId });
      const retry = 'ticket' in seeded
        ? store().completeUndispatchedCancel({ armed: (seeded as { ticket: PracticalArmedCancel }).ticket, report: NOT_DISPATCHED, trustedNowMs: CLOSE_AT + 99 })
        : store().abandonAcquiredCancel({ acquired: seeded.handle, trustedNowMs: CLOSE_AT + 1 });
      expect((await retry).kind).toBe('ALREADY_COMPLETED');
      expect(await everything(seeded)).toEqual(later);
    }
  });
});
