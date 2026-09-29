import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveExecutionIntentRecord } from '../../../src/execution/live/intent';
import {
  PrismaLiveExecutionRepository,
  completeCancelAttemptWithinCallerFencedTransaction,
  releaseArmedUndispatchedCancelClaimWithinCallerFencedTransaction,
  releaseUnarmedCancelClaimWithinCallerFencedTransaction,
} from '../../../src/execution/live/repository';
import { issuePracticalRecoveryCertificate, type PracticalRecoveryCertificate } from '../../../src/execution/live/practical/certificate';
import { issuePracticalLiveSafetyEnablement, type PracticalLiveSafetyEnablement } from '../../../src/execution/live/practical/policy';
import type { PracticalAccountSnapshot } from '../../../src/execution/live/practical-persistence/ports';
import { PrismaPracticalSafetyRepository } from '../../../src/execution/live/practical-persistence/repository';
import { PrismaPracticalCancelMutationStore } from '../../../src/execution/live/practical-mutation/repository';
import { PracticalAcquiredCancel } from '../../../src/execution/live/practical-mutation/ticket';
import { providerAccountFingerprint } from '../../../src/execution/live/reconciliation/account-identity';
import { newLiveRuntimeIdentity, readLiveRuntimeEpoch, requireCurrentReconciliation } from '../../../src/execution/live/reconciliation/barrier';
import { planClaimRecovery, reconcileIdentifiedOrder } from '../../../src/execution/live/reconciliation/order-reconciliation';
import { PrismaLiveReconciliationRepository } from '../../../src/execution/live/reconciliation/repository';
import { applyLiveOrderObservation, reclaimCancelAfterCrash } from '../../../src/execution/live/state-machine';
import type { LiveOrderObservation, LiveOrderStateRecord } from '../../../src/execution/live/types';
import { DisposableMysqlGuardError, DisposableMysqlLifecycle, generateDisposableDatabaseName } from '../../helpers/p18b-disposable-mysql';
import { evidenceSet, venueOrder } from '../../unit/execution/live/reconciliation/helpers';

// [P18B-1B2-W2B2a-DB] Real MySQL proof of the Phase17/18 bound-claim interlock:
//
//   VIEW:     listAccountOrderViews exposes ONLY the lease naming each order's EXACT CURRENT cancel generation,
//             re-proven with exact identity (a case-only / pad-space row fails closed).
//   GUARD:    every PUBLIC cancel-column write (Tier-A claim/arm/complete/commitState, Phase18
//             commitReconciledState) refuses a LEASED binding and an unresolved practical AMBIGUOUS
//             (LIVE_CANCEL_CLAIM_PRACTICALLY_BOUND), refuses a split (LIVE_DURABLE_INTEGRITY_VIOLATION), and
//             lets a HISTORICAL PRE_DISPATCH_FAILURE binding and unbound orders through unchanged.
//   PLANNING: the Phase18 planner over the REAL view produces zero effects for bound / sticky / split orders.
//   RR RACE:  the guard's non-locking read is exact because the snapshot is fixed only after live_order is locked.
//   NO-WIRE:  the two named primitives release exactly one CANCEL_RESERVED generation to NONE, with fixed
//             wire-arm preconditions, and leave order.state untouched.
//
// Completed leases here are TEST FIXTURES standing in for the future reviewed Stage 1B2 completion (Wave 2B2b):
// Wave 2B2a implements no completion, abandon, recovery, dispatch, ACCEPTED, or REJECTED.
//
// NOTHING HERE TOUCHES COINDCX: no gateway, transport, signer, or network.
//
// ACCEPTANCE SEMANTICS: soft-skips without a reachable local MySQL; with
// REQUIRE_LIVE_PRACTICAL_CANCEL_INTERLOCK_DB_INTEGRATION=1 `beforeAll` THROWS instead. It always uses its own
// disposable database, dropped afterwards (also after a partial provisioning failure), and refuses, before any
// mysql/prisma command, a DATABASE_URL that is not mysql: on localhost / 127.0.0.1 / ::1 / [::1].

const STRICT = process.env['REQUIRE_LIVE_PRACTICAL_CANCEL_INTERLOCK_DB_INTEGRATION'] === '1';
const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = generateDisposableDatabaseName();

let lifecycle: DisposableMysqlLifecycle | null = null;
let dbAvailable = false;
let connectionA: PrismaClient;
let connectionB: PrismaClient;
let observer: PrismaClient;

beforeAll(async () => {
  if (!BASE_DATABASE_URL) {
    if (STRICT) throw new Error('[P18B-W2B2a-DB] REQUIRE_LIVE_PRACTICAL_CANCEL_INTERLOCK_DB_INTEGRATION=1 but no DATABASE_URL is configured.');
    return;
  }
  let guarded: DisposableMysqlLifecycle;
  try {
    guarded = new DisposableMysqlLifecycle({ rawBaseUrl: BASE_DATABASE_URL, name: SHADOW_DB_NAME, strict: STRICT });
  } catch (error) {
    const reason = error instanceof DisposableMysqlGuardError ? error.message : (error as Error).name;
    if (STRICT) throw new Error(`[P18B-W2B2a-DB] strict mode refused to provision: ${reason}`);
    console.warn(`P18B Wave 2B2a interlock DB suite skipped: ${reason}`);
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
    if (STRICT) throw new Error(`[P18B-W2B2a-DB] strict mode could not provision a disposable MySQL database: ${(error as Error).name}${cleanupFailure}`);
  }
}, 180_000);

afterAll(async () => {
  dbAvailable = false;
  if (lifecycle !== null) await lifecycle.cleanup();
}, 30_000);

function skip(): boolean {
  if (dbAvailable) return false;
  if (STRICT) throw new Error('[P18B-W2B2a-DB] strict mode reached a test body with no database connection.');
  console.warn('P18B Wave 2B2a interlock DB suite skipped: no reachable disposable MySQL. Set REQUIRE_LIVE_PRACTICAL_CANCEL_INTERLOCK_DB_INTEGRATION=1 to make this hard.');
  return true;
}

// ---------------------------------------------------------------------------
// Fixtures (the Wave 2B1 acceptance fixtures: real certification, real acquire / arm)
// ---------------------------------------------------------------------------

const IDENTITY = newLiveRuntimeIdentity();
const EPOCH = readLiveRuntimeEpoch(IDENTITY)!;
const GENERATION = 1;
const T0 = 1_700_000_000_000;
const NOW = T0 + 60_000;
const ARM_AT = NOW + 1_000;
const FINGERPRINT = providerAccountFingerprint('w2b2a-fake-coindcx-account');

let sequence = 0;
function freshAccount(): string {
  sequence += 1;
  return `w2b2a-acct-${sequence}-${randomBytes(4).toString('hex')}`;
}

function enablementFor(accountId: string): PracticalLiveSafetyEnablement {
  const resolution = issuePracticalLiveSafetyEnablement({ LIVE_PRACTICAL_SAFETY_ENABLED: 'true', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: accountId });
  if (resolution.status !== 'ENABLED') throw new Error('fixture enablement');
  return resolution.enablement;
}

function expectationOf(account: PracticalAccountSnapshot) {
  return { accountId: account.accountId, runtimeEpoch: account.fence.runtimeEpoch, reconciliationGeneration: account.fence.reconciliationGeneration, revision: account.fence.revision };
}

async function certified(accountId: string): Promise<{ account: PracticalAccountSnapshot; certificate: PracticalRecoveryCertificate }> {
  const practical = new PrismaPracticalSafetyRepository(connectionA);
  const start = (await practical.initializeAccount({ accountId, runtimeEpoch: EPOCH, reconciliationGeneration: 0, nowMs: T0 - 50_000 })).account;
  const certifying = await practical.startCertification({ accountId, expected: expectationOf(start), runId: 'run-w2b2a', nowMs: T0 - 40_000 });
  const certificate = issuePracticalRecoveryCertificate({
    enablement: enablementFor(accountId),
    bindings: { accountId, providerAccountFingerprint: FINGERPRINT, runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION, streamIncarnation: 1 },
    evidence: { evidenceDigest: 'e'.repeat(64), passCount: 3, certificationSpanMs: 30_000, minimumObservedPassSpacingMs: 10_000 },
    issuedAtMs: T0,
  });
  const account = await practical.finishCertification({ accountId, expected: expectationOf(certifying), runId: 'run-w2b2a', resultingGeneration: GENERATION, certificate, nowMs: T0 });
  const state = {
    status: 'HEALTHY' as const, currentGeneration: GENERATION, currentRunId: 'recon-run-w2b2a', currentRuntimeEpoch: EPOCH,
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
      riskDecisionId: 'risk-w2b2a', admissionId: `admission-w2b2a-${tag}`, strategyInstanceId: 'instance-w2b2a', strategyId: 'EMA_TREND', strategyVersion: '1.0.0',
      parameterHash: 'p'.repeat(64), liveExecutionPolicyId: 'policy-w2b2a', instrumentSpecSnapshotId: 'spec-w2b2a', authorizedNotionalInr: '2560020',
      settlementRateInrPerQuote: '80', positionInstanceId: null, positionRevision: null, reduceOnlyQuantity: null,
    },
    lineage: {
      researchApproval: { validationSubjectId: 'subject-w2b2a', validationPlanId: 'plan-w2b2a', validationSubjectResultSha256: 'r'.repeat(64) },
      sourceStrategyDecisionId: 'decision-w2b2a',
    },
  };
}

interface Seeded {
  readonly accountId: string;
  readonly order: LiveExecutionIntentRecord;
  readonly exchangeOrderId: string;
}

/** A sealed intent whose projection is an acknowledged venue order. */
async function acknowledgedOrder(accountId: string): Promise<Seeded> {
  const order = intentRecord(accountId);
  await execution().ensureIntent(order);
  const exchangeOrderId = `venue-${randomBytes(4).toString('hex')}`;
  await connectionA.liveOrder.update({ where: { intentId: order.intentId }, data: { state: 'ACKNOWLEDGED', exchangeOrderId, revision: 2 } });
  return { accountId, order, exchangeOrderId };
}

/** Certified + HEALTHY + a committed Wave 2B1 acquisition: lease LEASED unarmed, Phase17 CANCEL_RESERVED unarmed, generation 1. */
async function leasedUnarmed(): Promise<Seeded & { readonly handle: PracticalAcquiredCancel }> {
  const accountId = freshAccount();
  const { account, certificate } = await certified(accountId);
  const seeded = await acknowledgedOrder(accountId);
  const result = await new PrismaPracticalCancelMutationStore(connectionA).acquireCancelLease({
    accountId, expected: expectationOf(account), certificate, enablement: enablementFor(accountId), runtimeIdentity: IDENTITY, intentId: seeded.order.intentId, trustedNowMs: NOW,
  });
  if (result.kind !== 'ACQUIRED') throw new Error(`fixture acquisition: ${result.kind}`);
  return { ...seeded, handle: result.acquired };
}

/** ... then the Wave 2B1 arm: lease armed at ARM_AT, Phase17 cancelWireArmed true. */
async function leasedArmed(): Promise<Seeded> {
  const seeded = await leasedUnarmed();
  const armed = await new PrismaPracticalCancelMutationStore(connectionA).armCancelLease({
    acquired: seeded.handle, enablement: enablementFor(seeded.accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT,
  });
  if (armed.kind !== 'ARMED') throw new Error('fixture arm');
  return seeded;
}

/** FIXTURE (stands in for the future reviewed completion): Phase17 CANCEL_AMBIGUOUS + lease COMPLETED AMBIGUOUS. */
async function completedAmbiguous(): Promise<Seeded> {
  const seeded = await leasedArmed();
  await connectionA.$transaction(async (tx) => {
    await completeCancelAttemptWithinCallerFencedTransaction(tx, seeded.order.intentId, 1, 'AMBIGUOUS', 'LIVE_CANCEL_AMBIGUOUS', seeded.accountId);
    await tx.$executeRaw`UPDATE live_practical_mutation_lease SET status = 'COMPLETED', outcome = 'AMBIGUOUS', completed_at_ms = armed_at_ms
      WHERE intent_id = ${seeded.order.intentId} AND cancel_generation = 1`;
  });
  return seeded;
}

/** FIXTURE: the joint no-wire release (the new unarmed primitive) + lease COMPLETED PRE_DISPATCH_FAILURE. */
async function completedPreDispatch(): Promise<Seeded> {
  const seeded = await leasedUnarmed();
  await connectionA.$transaction(async (tx) => {
    await releaseUnarmedCancelClaimWithinCallerFencedTransaction(tx, seeded.order.intentId, 1, seeded.accountId);
    await tx.$executeRaw`UPDATE live_practical_mutation_lease SET status = 'COMPLETED', outcome = 'PRE_DISPATCH_FAILURE', completed_at_ms = created_at_ms
      WHERE intent_id = ${seeded.order.intentId} AND cancel_generation = 1`;
  });
  return seeded;
}

function execution(client: PrismaClient = connectionA): PrismaLiveExecutionRepository {
  return new PrismaLiveExecutionRepository(client);
}

async function healthyAuthorization(accountId: string): Promise<unknown> {
  const { authorization } = await new PrismaLiveReconciliationRepository(connectionA).authorizeCurrentHealthy(accountId, IDENTITY);
  if (authorization === null) throw new Error('fixture: no HEALTHY authorization');
  return authorization;
}

/** A genuine Phase18 RUNNING authorization (claims a new reconciliation generation for the account). */
async function runningAuthorization(accountId: string): Promise<unknown> {
  const claim = await new PrismaLiveReconciliationRepository(connectionA).claimGeneration(accountId, newLiveRuntimeIdentity(), NOW + 10_000);
  if (claim.kind !== 'CLAIMED') throw new Error('fixture: generation not claimed');
  return claim.authorization;
}

async function load(intentId: string): Promise<LiveOrderStateRecord> {
  const order = await execution().load(intentId);
  if (order === null) throw new Error('fixture: order vanished');
  return order;
}

/** Every column of the order row, the order's event rows, and every practical lease row, for zero-change proofs. */
async function durableSnapshot(intentId: string) {
  const [order, events, leases] = await Promise.all([
    connectionA.liveOrder.findUniqueOrThrow({ where: { intentId } }),
    connectionA.liveOrderEvent.findMany({ where: { intentId }, orderBy: { observationSha256: 'asc' } }),
    connectionA.livePracticalMutationLease.findMany({ where: { intentId }, orderBy: { leaseId: 'asc' } }),
  ]);
  return { order, events, leases };
}

function clearedClaim(current: LiveOrderStateRecord): LiveOrderStateRecord {
  return Object.freeze({ ...current, cancelState: 'NONE' as const, cancelFaultCode: null, cancelWireArmed: false, revision: current.revision + 1 });
}

function observation(seeded: Seeded, kind: 'CANCELLED' | 'PARTIAL_FILL'): LiveOrderObservation {
  return {
    kind, clientOrderId: seeded.order.clientOrderId, exchangeClientOrderId: null, exchangeOrderId: seeded.exchangeOrderId, pair: 'B-BTC_USDT', side: 'BUY',
    cumulativeFilledQuantity: kind === 'CANCELLED' ? '0' : '0.1', orderedQuantity: '0.5', averageFillPrice: kind === 'CANCELLED' ? null : '64000.5',
    exchangeStatus: kind === 'CANCELLED' ? 'cancelled' : 'partially_filled', providerEventTimeMs: NOW + 5_000,
  } as LiveOrderObservation;
}

function venue(seeded: Seeded, status: 'open' | 'cancelled') {
  return evidenceSet({
    accountId: seeded.accountId,
    orders: [venueOrder(status === 'open'
      ? { exchangeOrderId: seeded.exchangeOrderId }
      : { exchangeOrderId: seeded.exchangeOrderId, venueStatus: 'cancelled', remainingQuantity: '0', cancelledQuantity: '0.5' })],
  });
}

async function viewOf(seeded: Seeded) {
  const views = await execution().listAccountOrderViews(seeded.accountId);
  const view = views.find((candidate) => candidate.intentId === seeded.order.intentId);
  if (view === undefined) throw new Error('fixture: view missing');
  return view;
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

const BOUND = { code: 'LIVE_CANCEL_CLAIM_PRACTICALLY_BOUND' };
const INTEGRITY = { code: 'LIVE_DURABLE_INTEGRITY_VIOLATION' };

// ---------------------------------------------------------------------------
// VIEW
// ---------------------------------------------------------------------------

describe('P18B-W2B2a-DB the advisory binding view: exact current generation only', () => {
  it('exposes a LEASED unarmed and a LEASED armed binding with every field exact', async () => {
    if (skip()) return;
    const unarmed = await leasedUnarmed();
    const lease = await connectionA.livePracticalMutationLease.findFirstOrThrow({ where: { intentId: unarmed.order.intentId } });
    expect((await viewOf(unarmed)).practicalCancelBinding).toEqual({
      leaseId: lease.leaseId, accountId: unarmed.accountId, intentId: unarmed.order.intentId, clientOrderId: unarmed.order.clientOrderId,
      cancelGeneration: 1, status: 'LEASED', outcome: null, armedAtMs: null,
    });
    const armed = await leasedArmed();
    expect((await viewOf(armed)).practicalCancelBinding).toMatchObject({ status: 'LEASED', outcome: null, armedAtMs: ARM_AT, cancelGeneration: 1 });
  });

  it('an order with no practical lease has a null binding', async () => {
    if (skip()) return;
    const seeded = await acknowledgedOrder(freshAccount());
    expect((await viewOf(seeded)).practicalCancelBinding).toBeNull();
  });

  it.each([
    ['client order id differs only by case', 'UPDATE live_practical_mutation_lease SET client_order_id = UPPER(client_order_id) WHERE intent_id = ?'],
    ['account id differs only by case', 'UPDATE live_practical_mutation_lease SET account_id = UPPER(account_id) WHERE intent_id = ?'],
    ['account id differs only by a trailing pad space', "UPDATE live_practical_mutation_lease SET account_id = CONCAT(account_id, ' ') WHERE intent_id = ?"],
    ['intent id differs only by case', 'UPDATE live_practical_mutation_lease SET intent_id = UPPER(intent_id) WHERE intent_id = ?'],
  ])('a row returned only by collation (%s) fails the listing AND the guard closed', async (_label, sql) => {
    if (skip()) return;
    const seeded = await leasedArmed();
    await tamperWithoutForeignKeys((tx) => tx.$executeRawUnsafe(sql, seeded.order.intentId));
    await expect(execution().listAccountOrderViews(seeded.accountId)).rejects.toMatchObject(INTEGRITY);
    const before = await durableSnapshot(seeded.order.intentId);
    const current = await load(seeded.order.intentId);
    await expect(execution().commitReconciledState(clearedClaim(current), current.revision, null, await runningAuthorization(seeded.accountId)))
      .rejects.toMatchObject(INTEGRITY);
    expect(await durableSnapshot(seeded.order.intentId)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// GUARD + PLANNING: LEASED
// ---------------------------------------------------------------------------

describe('P18B-W2B2a-DB a LEASED binding protects the Phase17 claim', () => {
  it('Phase18 crash recovery over the REAL view never reclaims an unarmed bound claim; a direct RECLAIM commit is refused with zero change', async () => {
    if (skip()) return;
    const seeded = await leasedUnarmed();
    const plan = planClaimRecovery([await viewOf(seeded)]);
    expect(plan.effects).toEqual([]);
    expect(plan.findings.map((finding) => finding.code)).toEqual(['RECON_CANCEL_CLAIM_PRACTICALLY_BOUND']);
    const before = await durableSnapshot(seeded.order.intentId);
    const current = await load(seeded.order.intentId);
    await expect(execution().commitReconciledState(reclaimCancelAfterCrash(current), current.revision, null, await runningAuthorization(seeded.accountId)))
      .rejects.toMatchObject(BOUND);
    expect(await durableSnapshot(seeded.order.intentId)).toEqual(before);
  });

  it('an armed bound claim: venue "still open" / "cancelled" produce zero effects; direct CLEAR and claim-clearing fold commits are refused', async () => {
    if (skip()) return;
    const seeded = await leasedArmed();
    const view = await viewOf(seeded);
    for (const status of ['open', 'cancelled'] as const) expect(reconcileIdentifiedOrder(view, venue(seeded, status)).effects).toEqual([]);
    const before = await durableSnapshot(seeded.order.intentId);
    const authorization = await runningAuthorization(seeded.accountId);
    const current = await load(seeded.order.intentId);
    await expect(execution().commitReconciledState(clearedClaim(current), current.revision, null, authorization)).rejects.toMatchObject(BOUND);
    const folded = applyLiveOrderObservation(current, observation(seeded, 'CANCELLED'));
    if (folded.kind !== 'APPLIED') throw new Error('fixture fold');
    const clearingFold = Object.freeze({ ...folded.order, cancelState: 'NONE' as const, cancelFaultCode: null, cancelWireArmed: false });
    await expect(execution().commitReconciledState(clearingFold, current.revision, observation(seeded, 'CANCELLED'), authorization)).rejects.toMatchObject(BOUND);
    expect(await durableSnapshot(seeded.order.intentId)).toEqual(before);
  });

  it('Tier-A public writes on an UNARMED bound claim are refused (arm would otherwise arm Phase17 alone); the unbound control arms', async () => {
    if (skip()) return;
    const seeded = await leasedUnarmed();
    const authorization = await healthyAuthorization(seeded.accountId);
    const current = await load(seeded.order.intentId);
    const before = await durableSnapshot(seeded.order.intentId);
    await expect(execution().armCancelWire(seeded.order.intentId, current.revision, authorization)).rejects.toMatchObject(BOUND);
    await expect(execution().completeCancelAttempt(seeded.order.intentId, 1, 'REJECTED', 'X', authorization)).rejects.toMatchObject(BOUND);
    await expect(execution().commitState({ ...current, cancelState: 'NONE', revision: current.revision + 1 }, current.revision, authorization)).rejects.toMatchObject(BOUND);
    expect(await durableSnapshot(seeded.order.intentId)).toEqual(before);

    // Control: the same Tier-A arm on an UNBOUND claim of the same shape succeeds.
    const control = await acknowledgedOrder(seeded.accountId);
    const claim = await execution().claimCancel(control.order.intentId, seeded.accountId, authorization);
    expect(claim.kind).toBe('CLAIMED');
    expect(await execution().armCancelWire(control.order.intentId, claim.order.revision, authorization)).toMatchObject({ cancelWireArmed: true });
  });

  it('Tier-A public writes on an ARMED bound claim are refused with zero change', async () => {
    if (skip()) return;
    const seeded = await leasedArmed();
    const authorization = await healthyAuthorization(seeded.accountId);
    const current = await load(seeded.order.intentId);
    const before = await durableSnapshot(seeded.order.intentId);
    for (const outcome of ['ACKNOWLEDGED', 'AMBIGUOUS', 'REJECTED'] as const) {
      await expect(execution().completeCancelAttempt(seeded.order.intentId, 1, outcome, null, authorization)).rejects.toMatchObject(BOUND);
    }
    await expect(execution().armCancelWire(seeded.order.intentId, current.revision, authorization)).rejects.toMatchObject(BOUND);
    await expect(execution().commitState(clearedClaim(current), current.revision, authorization)).rejects.toMatchObject(BOUND);
    expect(await durableSnapshot(seeded.order.intentId)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 1: a completed practical AMBIGUOUS stays CANCEL_AMBIGUOUS
// ---------------------------------------------------------------------------

describe('P18B-W2B2a-DB a completed practical AMBIGUOUS cancel stays CANCEL_AMBIGUOUS', () => {
  it('T1/T2: planning over the REAL view with complete "still open" / "cancelled" evidence: finding, ZERO effects; direct clears refused', async () => {
    if (skip()) return;
    const seeded = await completedAmbiguous();
    const view = await viewOf(seeded);
    expect(view.practicalCancelBinding).toMatchObject({ status: 'COMPLETED', outcome: 'AMBIGUOUS', armedAtMs: ARM_AT });
    expect(view.cancelState).toBe('CANCEL_AMBIGUOUS');
    expect(planClaimRecovery([view]).findings.map((finding) => finding.code)).toEqual(['RECON_PRACTICAL_CANCEL_AMBIGUITY_UNRESOLVED']);
    for (const status of ['open', 'cancelled'] as const) expect(reconcileIdentifiedOrder(view, venue(seeded, status)).effects).toEqual([]);

    const before = await durableSnapshot(seeded.order.intentId);
    const authorization = await runningAuthorization(seeded.accountId);
    const current = await load(seeded.order.intentId);
    await expect(execution().commitReconciledState(clearedClaim(current), current.revision, null, authorization)).rejects.toMatchObject(BOUND);
    const folded = applyLiveOrderObservation(current, observation(seeded, 'CANCELLED'));
    if (folded.kind !== 'APPLIED') throw new Error('fixture fold');
    await expect(execution().commitReconciledState(
      Object.freeze({ ...folded.order, cancelState: 'NONE' as const, cancelFaultCode: null, cancelWireArmed: false }), current.revision, observation(seeded, 'CANCELLED'), authorization,
    )).rejects.toMatchObject(BOUND);
    expect(await durableSnapshot(seeded.order.intentId)).toEqual(before);
    expect(before.order.cancelState).toBe('CANCEL_AMBIGUOUS');
  });

  it('T3: Tier-A completeCancelAttempt / commitState refuse; claimCancel writes nothing; the claim stays CANCEL_AMBIGUOUS', async () => {
    if (skip()) return;
    const seeded = await completedAmbiguous();
    const authorization = await healthyAuthorization(seeded.accountId);
    const current = await load(seeded.order.intentId);
    const before = await durableSnapshot(seeded.order.intentId);
    for (const outcome of ['ACKNOWLEDGED', 'AMBIGUOUS', 'REJECTED'] as const) {
      await expect(execution().completeCancelAttempt(seeded.order.intentId, 1, outcome, null, authorization)).rejects.toMatchObject(BOUND);
    }
    await expect(execution().commitState(clearedClaim(current), current.revision, authorization)).rejects.toMatchObject(BOUND);
    expect((await execution().claimCancel(seeded.order.intentId, seeded.accountId, authorization)).kind).toBe('ALREADY_CLAIMED');
    expect(await durableSnapshot(seeded.order.intentId)).toEqual(before);
  });

  it('a plain observation fold may record economics but NEVER moves the claim off CANCEL_AMBIGUOUS', async () => {
    if (skip()) return;
    const seeded = await completedAmbiguous();
    const authorization = await runningAuthorization(seeded.accountId);
    const after = await execution().applyObservationAtomically(seeded.order.intentId, observation(seeded, 'PARTIAL_FILL'), authorization);
    expect(after).toMatchObject({ cancelState: 'CANCEL_AMBIGUOUS', cancelGeneration: 1, cancelWireArmed: false });
    expect((await viewOf(seeded)).practicalCancelBinding).toMatchObject({ status: 'COMPLETED', outcome: 'AMBIGUOUS' });
  });

  it('T4: repeated reconciliation runs over time never clear it (no timeout path)', async () => {
    if (skip()) return;
    const seeded = await completedAmbiguous();
    for (let run = 0; run < 3; run += 1) {
      const view = await viewOf(seeded);
      const later = { ...venue(seeded, 'open'), evaluatedAtMs: Date.now() + run * 365 * 86_400_000 };
      expect(planClaimRecovery([view]).effects).toEqual([]);
      expect(reconcileIdentifiedOrder(view, later).effects).toEqual([]);
      const current = await load(seeded.order.intentId);
      await expect(execution().commitReconciledState(clearedClaim(current), current.revision, null, await runningAuthorization(seeded.accountId))).rejects.toMatchObject(BOUND);
    }
    expect((await load(seeded.order.intentId)).cancelState).toBe('CANCEL_AMBIGUOUS');
  });
});

// ---------------------------------------------------------------------------
// HISTORICAL and SPLIT
// ---------------------------------------------------------------------------

describe('P18B-W2B2a-DB a historical PRE_DISPATCH_FAILURE binding never blocks; split bindings fail closed', () => {
  it('T5: after the joint no-wire release the order plans ordinarily, a Tier-A claim moves to generation 2, and the old lease never appears again', async () => {
    if (skip()) return;
    const seeded = await completedPreDispatch();
    const view = await viewOf(seeded);
    expect(view.cancelState).toBe('NONE');
    expect(view.practicalCancelBinding).toMatchObject({ status: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE', armedAtMs: null, cancelGeneration: 1 });
    expect(planClaimRecovery([view])).toEqual({ findings: [], effects: [] });
    expect(reconcileIdentifiedOrder(view, venue(seeded, 'cancelled')).effects.map((effect) => effect.kind)).toEqual(['APPLY_OBSERVATION']);

    const claim = await execution().claimCancel(seeded.order.intentId, seeded.accountId, await healthyAuthorization(seeded.accountId));
    expect(claim).toMatchObject({ kind: 'CLAIMED', generation: 2 });
    expect((await viewOf(seeded)).practicalCancelBinding).toBeNull();
    // Generation 2 is unbound: ordinary Phase18 crash recovery reclaims it.
    const current = await load(seeded.order.intentId);
    expect(await execution().commitReconciledState(reclaimCancelAfterCrash(current), current.revision, null, await runningAuthorization(seeded.accountId)))
      .toMatchObject({ cancelState: 'NONE', cancelGeneration: 2 });
  });

  it('T6: COMPLETED REJECTED while still CANCEL_RESERVED (split): MANUAL_REVIEW finding, zero effects, guard refuses as integrity', async () => {
    if (skip()) return;
    const seeded = await leasedArmed();
    await connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET status = 'COMPLETED', outcome = 'REJECTED', completed_at_ms = armed_at_ms
      WHERE intent_id = ${seeded.order.intentId} AND cancel_generation = 1`;
    const view = await viewOf(seeded);
    expect(planClaimRecovery([view]).findings).toEqual([expect.objectContaining({ category: 'MANUAL_REVIEW_REQUIRED', code: 'RECON_PRACTICAL_CANCEL_BINDING_SPLIT' })]);
    expect(reconcileIdentifiedOrder(view, venue(seeded, 'open')).effects).toEqual([]);
    const before = await durableSnapshot(seeded.order.intentId);
    const current = await load(seeded.order.intentId);
    await expect(execution().commitReconciledState(clearedClaim(current), current.revision, null, await runningAuthorization(seeded.accountId))).rejects.toMatchObject(INTEGRITY);
    expect(await durableSnapshot(seeded.order.intentId)).toEqual(before);
  });

  it('T6: COMPLETED ACCEPTED with CANCEL_ACKNOWLEDGED (no reviewed producer exists) is split and refused', async () => {
    if (skip()) return;
    const seeded = await leasedArmed();
    await connectionA.$transaction(async (tx) => {
      await completeCancelAttemptWithinCallerFencedTransaction(tx, seeded.order.intentId, 1, 'ACKNOWLEDGED', null, seeded.accountId);
      await tx.$executeRaw`UPDATE live_practical_mutation_lease SET status = 'COMPLETED', outcome = 'ACCEPTED', completed_at_ms = armed_at_ms
        WHERE intent_id = ${seeded.order.intentId} AND cancel_generation = 1`;
    });
    const view = await viewOf(seeded);
    expect(planClaimRecovery([view]).findings.map((finding) => finding.code)).toEqual(['RECON_PRACTICAL_CANCEL_BINDING_SPLIT']);
    const current = await load(seeded.order.intentId);
    await expect(execution().commitState(clearedClaim(current), current.revision, await healthyAuthorization(seeded.accountId))).rejects.toMatchObject(INTEGRITY);
  });
});

// ---------------------------------------------------------------------------
// NO-WIRE PRIMITIVES
// ---------------------------------------------------------------------------

describe('P18B-W2B2a-DB the two named no-wire release primitives', () => {
  async function inTx<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return connectionA.$transaction(work);
  }

  it('unarmed: releases exactly generation 1 to NONE, keeps the generation and order.state, revision + 1', async () => {
    if (skip()) return;
    const seeded = await leasedUnarmed();
    const before = await load(seeded.order.intentId);
    const released = await inTx((tx) => releaseUnarmedCancelClaimWithinCallerFencedTransaction(tx, seeded.order.intentId, 1, seeded.accountId));
    expect(released).toMatchObject({
      state: before.state, cancelState: 'NONE', cancelGeneration: 1, cancelWireArmed: false, cancelFaultCode: null,
      cancelExchangeOrderId: before.cancelExchangeOrderId, revision: before.revision + 1,
    });
    expect(before.state).toBe('CANCEL_REQUESTED');
  });

  it('armed: releases an armed generation to NONE; each variant refuses the other arm state with zero change', async () => {
    if (skip()) return;
    const unarmed = await leasedUnarmed();
    const unarmedBefore = await durableSnapshot(unarmed.order.intentId);
    await expect(inTx((tx) => releaseArmedUndispatchedCancelClaimWithinCallerFencedTransaction(tx, unarmed.order.intentId, 1, unarmed.accountId)))
      .rejects.toMatchObject({ code: 'LIVE_ORDER_STATE_CONFLICT' });
    expect(await durableSnapshot(unarmed.order.intentId)).toEqual(unarmedBefore);

    const armed = await leasedArmed();
    const armedBefore = await durableSnapshot(armed.order.intentId);
    await expect(inTx((tx) => releaseUnarmedCancelClaimWithinCallerFencedTransaction(tx, armed.order.intentId, 1, armed.accountId)))
      .rejects.toMatchObject({ code: 'LIVE_ORDER_STATE_CONFLICT' });
    expect(await durableSnapshot(armed.order.intentId)).toEqual(armedBefore);
    expect(await inTx((tx) => releaseArmedUndispatchedCancelClaimWithinCallerFencedTransaction(tx, armed.order.intentId, 1, armed.accountId)))
      .toMatchObject({ state: 'CANCEL_REQUESTED', cancelState: 'NONE', cancelGeneration: 1, cancelWireArmed: false });
  });

  it('refuses a wrong generation, a case-only account, an empty account, and a non-reserved claim with zero change', async () => {
    if (skip()) return;
    const seeded = await leasedUnarmed();
    const before = await durableSnapshot(seeded.order.intentId);
    const intentId = seeded.order.intentId;
    await expect(inTx((tx) => releaseUnarmedCancelClaimWithinCallerFencedTransaction(tx, intentId, 2, seeded.accountId))).rejects.toMatchObject({ code: 'LIVE_ORDER_STATE_CONFLICT' });
    await expect(inTx((tx) => releaseUnarmedCancelClaimWithinCallerFencedTransaction(tx, intentId, 0, seeded.accountId))).rejects.toMatchObject({ code: 'LIVE_INTENT_INVALID' });
    await expect(inTx((tx) => releaseUnarmedCancelClaimWithinCallerFencedTransaction(tx, intentId, 1, seeded.accountId.toUpperCase()))).rejects.toMatchObject({ code: 'LIVE_AUTHORITY_INVALID' });
    await expect(inTx((tx) => releaseUnarmedCancelClaimWithinCallerFencedTransaction(tx, intentId, 1, ''))).rejects.toMatchObject({ code: 'LIVE_AUTHORITY_INVALID' });
    expect(await durableSnapshot(intentId)).toEqual(before);
    const unclaimed = await acknowledgedOrder(seeded.accountId);
    await expect(inTx((tx) => releaseUnarmedCancelClaimWithinCallerFencedTransaction(tx, unclaimed.order.intentId, 1, seeded.accountId))).rejects.toMatchObject({ code: 'LIVE_ORDER_STATE_CONFLICT' });
  });
});

// ---------------------------------------------------------------------------
// REPEATABLE READ timing and lock order
// ---------------------------------------------------------------------------

/**
 * Waits until the contender's `live_order ... FOR UPDATE` for THIS intent is observed BLOCKED in the server
 * process list on two consecutive polls (the holder owns that row lock; InnoDB reports a lock wait taken during
 * the optimizer's const-row read as RUNNING, so INNODB_TRX is not a reliable signal). Fails fast, with its
 * outcome, if the contender settles first; fails with a diagnostic dump if it never blocks.
 */
async function waitForLiveOrderLockWait(intentId: string, contender: Promise<string>): Promise<void> {
  let settled: string | null = null;
  void contender.then((outcome) => { settled = outcome; });
  const statement = `SELECT intent_id FROM live_order WHERE intent_id = '${intentId}' FOR UPDATE`;
  let consecutive = 0;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (settled !== null) throw new Error(`the contending transaction settled (${settled}) before blocking on live_order`);
    const rows = await observer.$queryRaw<Array<{ blocked: bigint | number }>>`SELECT COUNT(*) AS blocked FROM information_schema.PROCESSLIST
      WHERE db = DATABASE() AND command IN ('Execute', 'Query') AND info = ${statement}`;
    consecutive = Number(rows[0]?.blocked ?? 0) > 0 ? consecutive + 1 : 0;
    if (consecutive >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const processes = await observer.$queryRawUnsafe<unknown[]>('SELECT command, state, info FROM information_schema.PROCESSLIST WHERE db = DATABASE()');
  throw new Error(`the contending transaction never blocked on live_order: ${JSON.stringify(processes)}`);
}

describe('P18B-W2B2a-DB the guard is exact under REPEATABLE READ and keeps the global lock order', () => {
  it('a binding that becomes LEASED while the guarded write waits on live_order is SEEN (snapshot fixed after the lock); a pre-lock snapshot would have missed it', { timeout: 60_000 }, async () => {
    if (skip()) return;
    const seeded = await completedPreDispatch(); // HISTORICAL at generation 1, claim NONE: a Tier-A claim would be allowed
    const authorization = await healthyAuthorization(seeded.accountId);
    let releaseWriter!: () => void;
    const writerMayCommit = new Promise<void>((resolve) => { releaseWriter = resolve; });
    let writerLocked!: () => void;
    const writerHasLock = new Promise<void>((resolve) => { writerLocked = resolve; });

    // Control transaction (connection B): establishes its RR snapshot with a plain read BEFORE the change commits.
    let staleStatus: string | null = null;
    let releaseControl!: () => void;
    const controlMayReread = new Promise<void>((resolve) => { releaseControl = resolve; });
    let controlSnapshotTaken!: () => void;
    const controlHasSnapshot = new Promise<void>((resolve) => { controlSnapshotTaken = resolve; });
    const control = connectionB.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT status FROM live_practical_mutation_lease WHERE intent_id = ${seeded.order.intentId}`;
      controlSnapshotTaken();
      await controlMayReread;
      const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM live_practical_mutation_lease WHERE intent_id = ${seeded.order.intentId}`;
      staleStatus = rows[0]!.status;
    }, { timeout: 30_000, maxWait: 10_000 });

    // Writer (observer connection): a Stage-1B2-shaped writer that holds live_order while it changes the binding.
    const writer = observer.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT intent_id FROM live_order WHERE intent_id = ${seeded.order.intentId} FOR UPDATE`;
      await tx.$executeRaw`UPDATE live_practical_mutation_lease SET status = 'LEASED', outcome = NULL, completed_at_ms = NULL
        WHERE intent_id = ${seeded.order.intentId} AND cancel_generation = 1`;
      writerLocked();
      await writerMayCommit;
    }, { timeout: 30_000, maxWait: 10_000 });

    await writerHasLock;
    // The guarded Tier-A claim (connection A) starts while the binding still reads HISTORICAL, then waits on live_order.
    const guarded = execution(connectionA).claimCancel(seeded.order.intentId, seeded.accountId, authorization);
    const guardedOutcome = guarded.then(() => 'RESOLVED', (error: { code?: string }) => error.code ?? 'UNKNOWN');
    await waitForLiveOrderLockWait(seeded.order.intentId, guardedOutcome);
    await controlHasSnapshot; // the control snapshot provably predates the writer's commit
    releaseWriter();
    await writer;
    releaseControl();
    await control;

    expect(await guardedOutcome).toBe('LIVE_CANCEL_CLAIM_PRACTICALLY_BOUND');
    expect(staleStatus).toBe('COMPLETED'); // the pre-lock snapshot really would have missed the change
    expect(await load(seeded.order.intentId)).toMatchObject({ cancelState: 'NONE', cancelGeneration: 1 });
  });

  it('a practical-first holder (fence row, then live_order) and a Phase18 guarded write never deadlock: the guard takes no practical lock', { timeout: 60_000 }, async () => {
    if (skip()) return;
    const seeded = await leasedUnarmed();
    const authorization = await runningAuthorization(seeded.accountId);
    let releaseHolder!: () => void;
    const holderMayCommit = new Promise<void>((resolve) => { releaseHolder = resolve; });
    let holderLocked!: () => void;
    const holderHasLocks = new Promise<void>((resolve) => { holderLocked = resolve; });
    const holder = observer.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT account_id FROM live_practical_account_fence WHERE account_id = ${seeded.accountId} FOR UPDATE`;
      await tx.$executeRaw`SELECT lease_id FROM live_practical_mutation_lease WHERE intent_id = ${seeded.order.intentId} FOR UPDATE`;
      await tx.$executeRaw`SELECT intent_id FROM live_order WHERE intent_id = ${seeded.order.intentId} FOR UPDATE`;
      holderLocked();
      await holderMayCommit;
    }, { timeout: 30_000, maxWait: 10_000 });
    await holderHasLocks;
    const current = await load(seeded.order.intentId);
    const guarded = execution(connectionA).commitReconciledState(reclaimCancelAfterCrash(current), current.revision, null, authorization)
      .then(() => 'RESOLVED', (error: { code?: string }) => error.code ?? 'UNKNOWN');
    await waitForLiveOrderLockWait(seeded.order.intentId, guarded);
    releaseHolder();
    await holder;
    // The guarded write proceeded after the holder committed (no 1213 deadlock), then refused on the LEASED binding.
    expect(await guarded).toBe('LIVE_CANCEL_CLAIM_PRACTICALLY_BOUND');
  });
});

describe('P18B-W2B2a-DB the strict Tier-A barrier is unchanged', () => {
  it('still refuses with ACCOUNT_CONTINUITY_NOT_PROVEN for a practically bound account', async () => {
    if (skip()) return;
    const seeded = await leasedArmed();
    await expect(requireCurrentReconciliation(new PrismaLiveReconciliationRepository(connectionA), seeded.accountId, IDENTITY, 'CANCEL'))
      .rejects.toMatchObject({ details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
  });
});
