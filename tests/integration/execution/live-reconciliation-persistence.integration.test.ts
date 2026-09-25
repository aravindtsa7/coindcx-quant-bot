import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import Decimal from 'decimal.js';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RiskAdmissionCoordinator } from '../../../src/dispatch/admission';
import { LiveExecutionAuthority } from '../../../src/execution/live/authority';
import { PrismaLiveExecutionRepository } from '../../../src/execution/live/repository';
import { LiveExecutionService } from '../../../src/execution/live/service';
import { LiveExecutionIntent, type LiveExecutionIntentRecord } from '../../../src/execution/live/intent';
import {
  LiveReconciliationService,
  PrismaLiveReconciliationRepository,
  evaluateReconciliationBarrier,
  requireCurrentReconciliation,
  resolveOrphanCleanupPolicy,
} from '../../../src/execution/live/reconciliation';
import type { LiveVenueEvidenceSet } from '../../../src/execution/live/reconciliation/types';
import { newLiveRuntimeIdentity } from '../../../src/execution/live/reconciliation/barrier';
import { mintOrphanAmbiguityResolutionRequest } from '../../../src/execution/live/reconciliation/orphan-resolution';
import { composeLiveExecutionRuntime, LiveExecutionRuntime } from '../../../src/integration/coindcx/live/production-runtime';
import {
  ACCOUNT,
  AlwaysUnstableEvidenceProvider,
  EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
  EPOCH,
  FakeEvidenceProvider,
  FakeOrphanCancellation,
  FixedClock,
  LatencyAwareEvidenceProvider,
  OTHER_PAIR,
  PAIR,
  SequencedEvidenceProvider,
  evidenceSet,
  filledVenueOrder,
  provenance,
  venueOrder,
  venuePosition,
} from '../../unit/execution/live/reconciliation/helpers';
import { FakeOrderGateway, genuineEnablement, livePolicy, mintGenuineLiveOpen } from '../../unit/execution/live/helpers';

// [P18-DB] Real MySQL proof of the Phase18 reconciliation guarantees, over two
// INDEPENDENT connections — not two Promises racing inside one process, and not
// a mocked client. It exercises exactly the database behaviours the fencing
// claims rest on: UNIQUE(account_id, generation), the conditional orphan
// cancellation claim, the finding dedup index, and the transaction rollback.
//
// NOTHING HERE TOUCHES COINDCX. The evidence provider returns fixtures and the
// orphan-cancellation port RECORDS calls instead of making them. There is no
// gateway, no transport, and no network call of any kind (§25).
//
// ACCEPTANCE SEMANTICS (identical to the Phase17 convention): by default this
// suite soft-skips when no local MySQL is reachable. For real acceptance set
// REQUIRE_LIVE_RECONCILIATION_DB_INTEGRATION=1 (or run
// `npm run test:integration:live-reconciliation`), under which `beforeAll`
// THROWS rather than skipping, making a false green impossible.

const REPO_ROOT = path.resolve(__dirname, '../../..');
const STRICT = process.env['REQUIRE_LIVE_RECONCILIATION_DB_INTEGRATION'] === '1';
const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = `p18_recon_test_${randomBytes(6).toString('hex')}`;

function mysqlArgs(extra: readonly string[]): string[] {
  const url = new URL(BASE_DATABASE_URL!);
  const args = ['-h', url.hostname, '-P', url.port || '3306', '-u', decodeURIComponent(url.username)];
  if (url.password) args.push(`-p${decodeURIComponent(url.password)}`);
  return [...args, ...extra];
}

function shadowDatabaseUrl(): string {
  const url = new URL(BASE_DATABASE_URL!);
  url.pathname = `/${SHADOW_DB_NAME}`;
  return url.toString();
}

let dbAvailable = false;
let connectionA: PrismaClient;
let connectionB: PrismaClient;

beforeAll(async () => {
  if (!BASE_DATABASE_URL) {
    if (STRICT) throw new Error('[P18-DB-INTEGRATION] REQUIRE_LIVE_RECONCILIATION_DB_INTEGRATION=1 but no DATABASE_URL is configured.');
    dbAvailable = false;
    return;
  }
  try {
    execFileSync('mysql', mysqlArgs(['-e', `CREATE DATABASE \`${SHADOW_DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      stdio: 'pipe', timeout: 90_000, shell: true, env: { ...process.env, DATABASE_URL: shadowDatabaseUrl() },
    });
    connectionA = new PrismaClient({ datasources: { db: { url: shadowDatabaseUrl() } } });
    connectionB = new PrismaClient({ datasources: { db: { url: shadowDatabaseUrl() } } });
    await connectionA.$queryRawUnsafe('SELECT 1');
    await connectionB.$queryRawUnsafe('SELECT 1');
    dbAvailable = true;
    console.log(`[P18-DB-INTEGRATION] connected to disposable shadow database "${SHADOW_DB_NAME}" via two independent connections`);
  } catch (error) {
    dbAvailable = false;
    if (STRICT) {
      throw new Error(`[P18-DB-INTEGRATION] strict mode could not provision a disposable MySQL shadow database: ${(error as Error).message}`);
    }
  }
}, 120_000);

afterAll(async () => {
  if (!dbAvailable) return;
  await connectionA.$disconnect();
  await connectionB.$disconnect();
  try {
    execFileSync('mysql', mysqlArgs(['-e', `DROP DATABASE IF EXISTS \`${SHADOW_DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
  } catch { /* best-effort cleanup only */ }
}, 30_000);

function skip(): boolean {
  if (dbAvailable) return false;
  if (STRICT) throw new Error('[P18-DB-INTEGRATION] strict mode reached a test body with no database connection.');
  console.warn('P18 reconciliation DB suite skipped: no reachable disposable MySQL. Set REQUIRE_LIVE_RECONCILIATION_DB_INTEGRATION=1 to make this hard.');
  return true;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let sequence = 0;
/** A fresh account per test, so no test can be polluted by another's durable rows. */
function freshAccount(): string {
  sequence += 1;
  return `${ACCOUNT}-${sequence.toString(16)}`;
}

let intentSequence = 0;
function intentRecord(accountId: string, overrides: {
  readonly pair?: string;
  readonly side?: 'BUY' | 'SELL';
  readonly action?: 'OPEN' | 'CLOSE';
  readonly quantity?: string;
  readonly price?: string;
  readonly strategyInstanceId?: string;
} = {}): LiveExecutionIntentRecord {
  intentSequence += 1;
  const suffix = intentSequence.toString(16).padStart(4, '0');
  return {
    intentId: `${'0'.repeat(60)}${suffix}`,
    clientOrderId: `p18-${'0'.repeat(28)}${suffix}`,
    wireOrderType: 'limit_order',
    quantityAdjusted: false,
    priceAdjusted: false,
    content: {
      accountId,
      pair: overrides.pair ?? PAIR,
      side: overrides.side ?? 'BUY',
      action: overrides.action ?? 'OPEN',
      quantity: overrides.quantity ?? '0.5',
      orderType: 'LIMIT',
      price: overrides.price ?? '64000.5',
      timeInForce: 'UNSPECIFIED',
      leverage: '5',
      riskDecisionId: `risk-${suffix}`,
      admissionId: `admission-${suffix}`,
      strategyInstanceId: overrides.strategyInstanceId ?? 'instance-1',
      strategyId: 'EMA_TREND',
      strategyVersion: '1.0.0',
      parameterHash: 'p'.repeat(64),
      liveExecutionPolicyId: 'policy-1',
      instrumentSpecSnapshotId: 'spec-1',
      authorizedNotionalInr: '2560020',
      settlementRateInrPerQuote: '80',
      positionInstanceId: null,
      positionRevision: null,
      reduceOnlyQuantity: null,
    },
    lineage: {
      researchApproval: {
        validationSubjectId: `subject-${suffix}`,
        validationPlanId: `plan-${suffix}`,
        validationSubjectResultSha256: 'r'.repeat(64),
      },
      sourceStrategyDecisionId: `decision-${suffix}`,
    },
  };
}

/**
 * Seeds a durable Phase17 order through the real repository, then places its
 * mutable projection into the state under test. Only the mutable projection
 * columns are touched — the sealed intent and its immutable mirrors are written
 * by the repository itself, so every Phase17 integrity proof still applies.
 */
async function seedOrder(
  client: PrismaClient,
  intent: LiveExecutionIntentRecord,
  projection: {
    readonly state: string;
    readonly exchangeOrderId?: string | null;
    readonly cumulativeFilledQuantity?: string;
    readonly averageFillPrice?: string | null;
    readonly cancelState?: string;
  },
): Promise<void> {
  const repository = new PrismaLiveExecutionRepository(client);
  await repository.ensureIntent(intent);
  const filled = projection.cumulativeFilledQuantity ?? '0';
  const remaining = (Number(intent.content.quantity) - Number(filled)).toString();
  await client.liveOrder.update({
    where: { intentId: intent.intentId },
    data: {
      state: projection.state as never,
      exchangeOrderId: projection.exchangeOrderId ?? null,
      cumulativeFilledQuantity: filled,
      remainingQuantity: remaining,
      averageFillPrice: projection.averageFillPrice ?? null,
      cancelState: (projection.cancelState ?? 'NONE') as never,
      faultCode: projection.state === 'SUBMISSION_AMBIGUOUS' ? 'LIVE_SUBMISSION_AMBIGUOUS' : null,
      revision: 1,
    },
  });
}

type MinimalEvidenceProvider = {
  readonly readOrders: (...args: never[]) => unknown;
  readonly readPositions: (...args: never[]) => unknown;
};

function buildService<P extends MinimalEvidenceProvider = FakeEvidenceProvider>(client: PrismaClient, options: {
  readonly evidence?: LiveVenueEvidenceSet;
  /** [Wave B / F18-04] Overrides the default single-fixture fake, for stability-protocol tests. */
  readonly evidenceProvider?: P;
  readonly accountId?: string;
  readonly epoch?: string;
  readonly maxSnapshotAttempts?: number;
  readonly orphanCancellation?: FakeOrphanCancellation;
  readonly orphanEnabled?: boolean;
  readonly orphanAccount?: string;
} = {}) {
  const reconciliation = new PrismaLiveReconciliationRepository(client);
  const execution = new PrismaLiveExecutionRepository(client);
  const provider = (options.evidenceProvider ?? new FakeEvidenceProvider(options.evidence ?? evidenceSet())) as P;
  const resolution = resolveOrphanCleanupPolicy({
    LIVE_ORPHAN_CANCELLATION_ENABLED: options.orphanEnabled === true ? 'true' : 'false',
    LIVE_ORPHAN_CANCELLATION_ACCOUNT_ALLOWLIST: options.orphanAccount ?? '',
  });
  const runtimeIdentity = newLiveRuntimeIdentity();
  const service = new LiveReconciliationService({
    repository: reconciliation,
    executionRepository: execution,
    evidenceProvider: provider as never,
    runtimeIdentity,
    credentialAccountId: options.accountId ?? (options.evidence ?? evidenceSet()).accountId,
    expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
    clock: new FixedClock(),
    maxSnapshotAttempts: options.maxSnapshotAttempts,
    ...(resolution.status === 'ENABLED' && options.orphanCancellation !== undefined
      ? { orphanPolicy: resolution.policy, orphanCancellation: options.orphanCancellation }
      : {}),
  });
  return { service, reconciliation, execution, provider, runtimeIdentity };
}

/**
 * Rewrites an evidence fixture onto a per-test account AND re-anchors every
 * timestamp to the current wall clock.
 *
 * The re-anchoring is not cosmetic. Durable rows are seeded with real
 * `created_at`/`updated_at` values, and the ambiguous-create resolver checks a
 * candidate's venue creation time against that persisted local submission
 * window. A fixture frozen at an arbitrary epoch would fall outside it and be
 * refused — which is the resolver behaving correctly, so the fixture is what
 * has to move, not the rule.
 *
 * The two read windows stay strictly ordered (orders first, then positions)
 * with no observation after the boundary, which is the shape a HEALTHY verdict
 * requires under §13.
 */
function forAccount(accountId: string, evidence: LiveVenueEvidenceSet): LiveVenueEvidenceSet {
  const readEnd = Date.now();
  const readStart = readEnd - 2_000;
  const observed = readEnd - 500;
  return Object.freeze({
    ...evidence,
    accountId,
    orders: Object.freeze(evidence.orders.map((order) => Object.freeze({
      ...order,
      providerCreatedAtMs: observed - 500,
      providerEventTimeMs: observed,
    }))),
    positions: Object.freeze(evidence.positions.map((position) => Object.freeze({
      ...position,
      providerEventTimeMs: observed,
    }))),
    ordersProvenance: Object.freeze({
      ...evidence.ordersProvenance,
      localReadStartedAtMs: readStart,
      localReadEndedAtMs: readEnd,
    }),
    positionsProvenance: Object.freeze({
      ...evidence.positionsProvenance,
      localReadStartedAtMs: readEnd,
      localReadEndedAtMs: readEnd + 100,
    }),
    evaluatedAtMs: readEnd + 200,
  });
}

/**
 * [P18 Wave B4 / F18-27] `requireCurrentReconciliation` now always blocks
 * with reason `ACCOUNT_CONTINUITY_NOT_PROVEN` once every other fencing/state
 * check has passed, because no evidence provider in this codebase can prove
 * account continuity (see `currentAccountContinuityCapability`'s doc in
 * `barrier.ts`). Tests below that exercise a Phase17/Wave-A property
 * ORTHOGONAL to F18-27 — wire-arm fencing, generation races, crash recovery,
 * idempotence — call this helper instead of `requireCurrentReconciliation`.
 * It reads the exact same genuine, DB-backed HEALTHY authorization object
 * `requireCurrentReconciliation` handed back before F18-27, directly from the
 * repository's `authorizeCurrentHealthy` — which F18-27 deliberately left
 * unchanged; only the barrier deciding whether to RELEASE that object
 * through `requireCurrentReconciliation` changed. Production code never
 * calls `authorizeCurrentHealthy` directly (only `requireCurrentReconciliation`,
 * exclusively, from `production-runtime.ts`), so this helper reintroduces no
 * production gap — it isolates the property each test is actually about from
 * the orthogonal, permanent F18-27 finding. Tests that ARE about the F18-27
 * barrier itself call `requireCurrentReconciliation` directly and assert on
 * `ACCOUNT_CONTINUITY_NOT_PROVEN`.
 */
async function healthyAuthorizationForTest(
  reconciliation: PrismaLiveReconciliationRepository,
  accountId: string,
  runtimeIdentity: unknown,
): Promise<unknown> {
  const outcome = await reconciliation.authorizeCurrentHealthy(accountId, runtimeIdentity);
  if (outcome.authorization === null) {
    throw new Error(`[test helper] authorizeCurrentHealthy did not mint an authorization for ${accountId}; state=${JSON.stringify(outcome.state)}`);
  }
  return outcome.authorization;
}

/** Exact decimal comparison against a durable `DECIMAL(36,18)` column. */
function expectExactDecimal(value: { toFixed(): string } | null | undefined, expected: string): void {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  expect(new Decimal(value!.toFixed()).equals(new Decimal(expected))).toBe(true);
}

// ---------------------------------------------------------------------------
// §24.1 / §24.2 — fencing
// ---------------------------------------------------------------------------

describe('P18-DB §4 durable generation fencing', () => {
  it('[1] two reconcilers racing produce exactly one authoritative generation', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const a = new PrismaLiveReconciliationRepository(connectionA);
    const b = new PrismaLiveReconciliationRepository(connectionB);

    // Two INDEPENDENT connections claiming at the same time. The winner is
    // decided by MySQL's UNIQUE(account_id, generation), not by a local lock.
    const [first, second] = await Promise.all([
      a.claimGeneration(accountId, newLiveRuntimeIdentity(), 1_000),
      b.claimGeneration(accountId, newLiveRuntimeIdentity(), 1_000),
    ]);

    const claimed = [first, second].filter((outcome) => outcome.kind === 'CLAIMED');
    const lost = [first, second].filter((outcome) => outcome.kind === 'LOST');
    // Either one wins outright, or the two serialize into distinct generations —
    // never two owners of the SAME generation, which is the actual invariant.
    const generations = claimed.map((outcome) => (outcome.kind === 'CLAIMED' ? outcome.lease.generation : -1));
    expect(new Set(generations).size).toBe(generations.length);
    expect(claimed.length + lost.length).toBe(2);

    const state = await a.loadState(accountId);
    expect(state.status).toBe('RUNNING');
    // Only the newest generation owns the account.
    expect(state.currentGeneration).toBe(Math.max(...generations));
  });

  it('[2] a stale generation cannot commit anything after a newer one takes over', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const a = new PrismaLiveReconciliationRepository(connectionA);
    const b = new PrismaLiveReconciliationRepository(connectionB);

    const stale = await a.claimGeneration(accountId, newLiveRuntimeIdentity(), 1_000);
    expect(stale.kind).toBe('CLAIMED');
    if (stale.kind !== 'CLAIMED') return;

    // A second worker, on a second connection, fences the first out.
    const fresh = await b.claimGeneration(accountId, newLiveRuntimeIdentity(), 2_000);
    expect(fresh.kind).toBe('CLAIMED');
    if (fresh.kind !== 'CLAIMED') return;
    expect(fresh.lease.generation).toBeGreaterThan(stale.lease.generation);

    // EVERY durable write path refuses the stale lease, not just completion.
    await expect(a.completeRun(stale.lease, {}, 3_000)).rejects.toThrow(/LIVE_RECONCILIATION_STALE_GENERATION/);
    await expect(a.recordSnapshot(stale.lease, 'f'.repeat(64), 3_000, { validated: true, ordersComplete: true, positionsComplete: true })).rejects.toThrow(/LIVE_RECONCILIATION_STALE_GENERATION/);
    await expect(a.persistFindings(stale.lease, [], 3_000)).rejects.toThrow(/LIVE_RECONCILIATION_STALE_GENERATION/);
    await expect(a.clearPositionOwnership(stale.lease, stale.authorization, PAIR)).rejects.toThrow(/LIVE_RECONCILIATION_STALE_GENERATION/);

    // Even the newer owner cannot fabricate HEALTHY without the trusted
    // service's completion proof and durable evidence.
    await expect(b.completeRun(fresh.lease, {}, 4_000)).rejects.toThrow(/completion proof/i);
  });
});

describe('P18-DB Wave A transaction-bound authority races', () => {
  it('fences OPEN after N+1 claims and performs zero mutation work', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { service, reconciliation, execution, runtimeIdentity } = buildService(connectionA, { evidence: forAccount(accountId, evidenceSet()) });
    await service.reconcileAccount(accountId);
    const authorization = await healthyAuthorizationForTest(reconciliation, accountId, runtimeIdentity);
    const intent = intentRecord(accountId);
    await execution.ensureIntent(intent);
    await new PrismaLiveReconciliationRepository(connectionB).claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now());
    let mutationWork = 0;
    await expect(execution.claimDispatch(intent.intentId, authorization, async () => { mutationWork += 1; return true; }))
      .rejects.toThrow(/STALE_GENERATION/);
    expect(mutationWork).toBe(0);
    expect((await connectionA.liveOrder.findUniqueOrThrow({ where: { intentId: intent.intentId } })).state).toBe('CREATED');
  });

  it('fences normal cancel after N+1 claims', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { service, reconciliation, execution, runtimeIdentity } = buildService(connectionA, { evidence: forAccount(accountId, evidenceSet()) });
    await service.reconcileAccount(accountId);
    const authorization = await healthyAuthorizationForTest(reconciliation, accountId, runtimeIdentity);
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'ACKNOWLEDGED', exchangeOrderId: `venue-${accountId}` });
    await new PrismaLiveReconciliationRepository(connectionB).claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now());
    await expect(execution.claimCancel(intent.intentId, accountId, authorization)).rejects.toThrow(/STALE_GENERATION/);
    expect((await connectionA.liveOrder.findUniqueOrThrow({ where: { intentId: intent.intentId } })).cancelState).toBe('NONE');
  });

  it('fences CLOSE at the final dispatch claim despite valid position ownership', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { service, reconciliation, execution, runtimeIdentity } = buildService(connectionA, { evidence: forAccount(accountId, evidenceSet()) });
    await service.reconcileAccount(accountId);
    const authorization = await healthyAuthorizationForTest(reconciliation, accountId, runtimeIdentity);
    const base = intentRecord(accountId, { action: 'CLOSE', side: 'SELL' });
    const closeIntent: LiveExecutionIntentRecord = {
      ...base,
      content: { ...base.content, action: 'CLOSE', side: 'SELL', leverage: null, admissionId: null,
        settlementRateInrPerQuote: null, positionInstanceId: `position-${accountId}`,
        positionRevision: 0, reduceOnlyQuantity: base.content.quantity },
      lineage: { researchApproval: null, sourceStrategyDecisionId: base.lineage.sourceStrategyDecisionId },
    };
    await execution.ensureIntent(closeIntent);
    await connectionA.livePosition.create({ data: {
      accountId, pair: PAIR, positionInstanceId: `position-${accountId}`, revision: 0,
      side: 'LONG', quantity: base.content.quantity, instrumentSpecSnapshotId: base.content.instrumentSpecSnapshotId,
      ownerStrategyInstanceId: base.content.strategyInstanceId, ownerStrategyId: base.content.strategyId,
      ownerStrategyVersion: base.content.strategyVersion, ownerParameterHash: base.content.parameterHash,
    } });
    await new PrismaLiveReconciliationRepository(connectionB).claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now());
    await expect(execution.claimDispatch(closeIntent.intentId, authorization, async () => true)).rejects.toThrow(/STALE_GENERATION/);
    expect((await connectionA.liveOrder.findUniqueOrThrow({ where: { intentId: closeIntent.intentId } })).state).toBe('CREATED');
  });

  it('rejects a stale Phase17 repair without an event or economic write', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const execution = new PrismaLiveExecutionRepository(connectionA);
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'ACKNOWLEDGED', exchangeOrderId: `venue-${accountId}` });
    const owner = await new PrismaLiveReconciliationRepository(connectionA).claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now());
    if (owner.kind !== 'CLAIMED') throw new Error('expected owner');
    await new PrismaLiveReconciliationRepository(connectionB).claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now() + 1);
    await expect(execution.applyObservationAtomically(intent.intentId, {
      kind: 'FILL', clientOrderId: intent.clientOrderId, exchangeClientOrderId: null,
      exchangeOrderId: `venue-${accountId}`, pair: PAIR, side: 'BUY',
      cumulativeFilledQuantity: intent.content.quantity, orderedQuantity: intent.content.quantity,
      averageFillPrice: '64000.5', exchangeStatus: 'filled', providerEventTimeMs: Date.now(),
    }, owner.authorization)).rejects.toThrow(/STALE_GENERATION/);
    expect(await connectionA.liveOrderEvent.count({ where: { intentId: intent.intentId } })).toBe(0);
    expect((await connectionA.liveOrder.findUniqueOrThrow({ where: { intentId: intent.intentId } })).cumulativeFilledQuantity.toFixed()).toBe('0');
  });

  it('rejects a stale orphan claim before an external cancel can be sent', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const repositoryA = new PrismaLiveReconciliationRepository(connectionA);
    const owner = await repositoryA.claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now());
    if (owner.kind !== 'CLAIMED') throw new Error('expected owner');
    const exchangeOrderId = `orphan-${accountId}`;
    await repositoryA.recordOrphanOrder(owner.lease, venueOrder({ exchangeOrderId }), Date.now());
    await new PrismaLiveReconciliationRepository(connectionB).claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now() + 1);
    await expect(repositoryA.claimOrphanCancellation(owner.lease, owner.authorization, exchangeOrderId, Date.now())).rejects.toThrow(/STALE_GENERATION/);
    expect((await repositoryA.loadOrphanOrders(accountId))[0]?.cancelState).toBe('NONE');
  });

  // [F18-14] This used to assert the OLD, deadlocked behaviour: a generation
  // could never be superseded while ANY dispatch/cancel/orphan mutation claim
  // was outstanding. That made a crash between "local reservation taken" and
  // "reconciliation completes" PERMANENT, because only a completed
  // reconciliation can clear such a claim and only a NEW generation can run
  // one. The fix removes that block; see `claimGeneration` in
  // `../../../src/execution/live/reconciliation/repository.ts` for the full
  // reasoning and `crash recovery` regression tests below for the exact
  // reviewer-confirmed deadlock reproduction.
  it('[F18-14] a new generation MAY supersede an outstanding local dispatch reservation, and the stale worker is fenced before any wire attempt', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { service, reconciliation, execution, runtimeIdentity } = buildService(connectionA, { evidence: forAccount(accountId, evidenceSet()) });
    await service.reconcileAccount(accountId);
    const authorization = await healthyAuthorizationForTest(reconciliation, accountId, runtimeIdentity);
    const intent = intentRecord(accountId);
    await execution.ensureIntent(intent);
    const claim = await execution.claimDispatch(intent.intentId, authorization, async () => true);
    expect(claim.kind).toBe('CLAIMED');
    if (claim.kind !== 'CLAIMED') return;
    expect(claim.order.dispatchWireArmed).toBe(false);

    // A NEW generation is free to take over. No process liveness, heartbeat, or
    // timeout is consulted — the outstanding claim's WIRE-ARM flag is what
    // decides recoverability, and it decides it later, not here.
    const supersession = await new PrismaLiveReconciliationRepository(connectionB).claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now());
    expect(supersession.kind).toBe('CLAIMED');

    // The stale worker (still holding its pre-supersession HEALTHY authorization)
    // can never arm the wire attempt: the arm is fenced exactly like every other
    // durable write, so it fails BEFORE any gateway could ever be reached.
    await expect(execution.armDispatchWire(intent.intentId, claim.order.revision, authorization)).rejects.toThrow(/STALE_GENERATION/);
    expect((await connectionA.liveOrder.findUniqueOrThrow({ where: { intentId: intent.intentId } })).state).toBe('DISPATCH_RESERVED');
    expect((await connectionA.liveOrder.findUniqueOrThrow({ where: { intentId: intent.intentId } })).dispatchWireArmed).toBe(false);
  });
});

describe('P18-DB Wave A credential and derived-health defenses', () => {
  it('two production compositions from the same credentials have independent hidden runtime identities', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const provider = new FakeEvidenceProvider(forAccount(accountId, evidenceSet()));
    const gatewayA = new FakeOrderGateway();
    const gatewayB = new FakeOrderGateway();
    const input = {
      config: {
        NODE_ENV: 'production', LIVE_EXECUTION_ENABLED: 'true',
        LIVE_EXECUTION_ACCOUNT_ALLOWLIST: accountId, LIVE_EXECUTION_PAIR_ALLOWLIST: PAIR,
        LIVE_EXECUTION_MAX_ORDER_NOTIONAL_INR: '10000000',
        COINDCX_API_KEY: 'test-key', COINDCX_API_SECRET: 'test-secret', COINDCX_LIVE_ACCOUNT_ID: accountId,
        COINDCX_EXPECTED_ACCOUNT_FINGERPRINT: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
      },
      prisma: connectionA,
      coordinator: new RiskAdmissionCoordinator(),
      evidenceProvider: provider,
    };
    const first = composeLiveExecutionRuntime({ ...input, gateway: gatewayA });
    const second = composeLiveExecutionRuntime({ ...input, gateway: gatewayB });
    expect('runtimeEpoch' in first).toBe(false);
    expect(Object.keys(first)).not.toContain('runtimeEpoch');
    expect(() => Reflect.construct(LiveExecutionRuntime, [{}])).toThrow(/factory constructed/i);

    // [P18 Wave B4 / F18-27] `cancelLive` now NEVER reaches intent lookup —
    // `requireCurrentReconciliation` always blocks on the permanent
    // account-continuity gate once fencing passes — so `LIVE_INTENT_INVALID`
    // is no longer an observable "we got past the barrier" signal. The block
    // REASON still distinguishes the two runtimes' independent identities:
    // the one that just reconciled is blocked ONLY by F18-27
    // (`ACCOUNT_CONTINUITY_NOT_PROVEN`), proving its own fencing passed,
    // while the other is blocked by genuine epoch mismatch/absence — proving
    // it did NOT inherit the first's pass.
    await first.reconcileAccount(accountId);
    await expect(first.cancelLive('missing-intent'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
    await expect(second.cancelLive('missing-intent'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'STALE_RUNTIME_GENERATION' } });
    await second.reconcileAccount(accountId);
    await expect(first.cancelLive('missing-intent'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'STALE_RUNTIME_GENERATION' } });
    await expect(second.cancelLive('missing-intent'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
    expect(gatewayA.cancelCallCount).toBe(0);
    expect(gatewayB.cancelCallCount).toBe(0);
  });

  it('credential account A rejects B before any B durable claim, evidence, or repair', async () => {
    if (skip()) return;
    const accountA = freshAccount();
    const accountB = freshAccount();
    const { service, provider } = buildService(connectionA, { evidence: forAccount(accountA, evidenceSet()) });
    await expect(service.reconcileAccount(accountB)).rejects.toThrow(/Credential-bound reconciliation/);
    expect(provider.calls).toBe(0);
    expect(await connectionA.liveReconciliationState.count({ where: { accountId: accountB } })).toBe(0);
    expect(await connectionA.liveReconciliationRun.count({ where: { accountId: accountB } })).toBe(0);
    expect(await connectionA.liveReconciliationFinding.count({ where: { accountId: accountB } })).toBe(0);
    expect(await connectionA.liveOrphanVenueOrder.count({ where: { accountId: accountB } })).toBe(0);
    expect(await connectionA.livePosition.count({ where: { accountId: accountB } })).toBe(0);
    expect(await connectionA.liveOrder.count({ where: { accountId: accountB } })).toBe(0);
  });

  it('rejects the old direct HEALTHY exploit and leaves a snapshot-less run RUNNING', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const repository = new PrismaLiveReconciliationRepository(connectionA);
    const claim = await repository.claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now());
    if (claim.kind !== 'CLAIMED') throw new Error('expected owner');
    const lease = claim.lease;
    const oldExploit = (...args: [typeof lease, string, number, number]): Promise<unknown> =>
      (repository.completeRun as unknown as { call(thisArg: unknown, ...values: unknown[]): Promise<unknown> })
        .call(repository, ...args);
    await expect(oldExploit(lease, 'HEALTHY', 0, Date.now())).rejects.toThrow(/completion proof/i);
    expect((await repository.loadState(accountId)).status).toBe('RUNNING');
  });

  it('rejects wrong-epoch completion while a complete authoritative run derives HEALTHY', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const repository = new PrismaLiveReconciliationRepository(connectionA);
    const claim = await repository.claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now());
    if (claim.kind !== 'CLAIMED') throw new Error('expected owner');
    await expect(repository.completeRun({ ...claim.lease, runtimeEpoch: 'wrong-epoch' }, {}, Date.now()))
      .rejects.toThrow(/STALE_GENERATION/);

    const healthyAccount = freshAccount();
    const { service } = buildService(connectionA, { evidence: forAccount(healthyAccount, evidenceSet()) });
    const outcome = await service.reconcileAccount(healthyAccount);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');
  });
});

// ---------------------------------------------------------------------------
// §24.3 — idempotence
// ---------------------------------------------------------------------------

describe('P18-DB §16 idempotence', () => {
  it('[3] an identical rerun creates no duplicate finding and no new economic effect', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId: `stranger-${accountId}` })] }));
    const { service } = buildService(connectionA, { evidence });

    await service.reconcileAccount(accountId);
    const afterFirst = await connectionA.liveReconciliationFinding.findMany({ where: { accountId } });
    const orphanAfterFirst = await connectionA.liveOrphanVenueOrder.findMany({ where: { accountId } });

    await service.reconcileAccount(accountId);
    await service.reconcileAccount(accountId);

    const afterThird = await connectionA.liveReconciliationFinding.findMany({ where: { accountId } });
    const orphanAfterThird = await connectionA.liveOrphanVenueOrder.findMany({ where: { accountId } });

    expect(afterThird).toHaveLength(afterFirst.length);
    expect(afterThird.map((row) => row.findingId).sort()).toEqual(afterFirst.map((row) => row.findingId).sort());
    expect(orphanAfterThird).toHaveLength(orphanAfterFirst.length);
    // The orphan row was re-observed, never re-created.
    expect(orphanAfterThird[0]?.createdAt.getTime()).toBe(orphanAfterFirst[0]?.createdAt.getTime());
  });
});

// ---------------------------------------------------------------------------
// §24.4 / §24.5 — ambiguous create resolution
// ---------------------------------------------------------------------------

describe('P18-DB §6 ambiguous create resolution', () => {
  // [Wave B3 / F18-21 correction] This test originally proved a unique proof
  // resolves an ambiguous create through the real `resolveAmbiguousCreate`
  // entry point. Independent review's F18-21 fix made that entry point
  // unconditionally refuse EVERY local TIF value (no CoinDCX evidence
  // contract proof of time-in-force exists for any record), so automatic
  // resolution through this path is now permanently blocked in production —
  // see the `[F18-21 REQUIRED MATRIX]` tests below for the full proof across
  // every TIF value. This test now proves the (equally load-bearing) other
  // half: the block is total — even a genuinely unique, economically-perfect,
  // complete-evidence candidate never binds — AND idempotent across reruns.
  // `resolveAmbiguousCreateAgainstObservableCandidates` (unit-tested
  // directly in `order-reconciliation.test.ts`) is where the underlying
  // candidate-selection/persistence-shape logic this test used to exercise
  // remains proven, ready for the day a genuinely authoritative TIF proof
  // exists.
  it('[4] a unique proof does NOT resolve an ambiguous create: TIF is unconditionally unobservable, and reruns remain idempotent', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [venueOrder({ exchangeOrderId: `venue-${accountId}` })],
      positions: [venuePosition({ signedQuantity: '0' })],
    }));
    const { service } = buildService(connectionA, { evidence });
    const outcome = await service.reconcileAccount(accountId);

    const order = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    expect(order?.state).toBe('SUBMISSION_AMBIGUOUS');
    expect(order?.exchangeOrderId).toBeNull();
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
    expect(outcome.kind === 'COMPLETED' && outcome.result.findings.map((f) => f.code)).toContain('RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE');

    // Rerunning stays idempotent: no new finding, no new event, no state churn.
    const revisionAfterFirst = order?.revision;
    const events = await connectionA.liveOrderEvent.count({ where: { intentId: intent.intentId } });
    const findingsAfterFirst = await connectionA.liveReconciliationFinding.count({ where: { accountId } });
    await service.reconcileAccount(accountId);
    const after = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    expect(after?.revision).toBe(revisionAfterFirst);
    expect(await connectionA.liveOrderEvent.count({ where: { intentId: intent.intentId } })).toBe(events);
    expect(await connectionA.liveReconciliationFinding.count({ where: { accountId } })).toBe(findingsAfterFirst);
  });

  it('[5] two matching candidates leave the order unresolved and the account blocked', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [
        venueOrder({ exchangeOrderId: `venue-a-${accountId}` }),
        venueOrder({ exchangeOrderId: `venue-b-${accountId}` }),
      ],
    }));
    const { service, reconciliation } = buildService(connectionA, { evidence });
    const outcome = await service.reconcileAccount(accountId);

    const order = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    // Untouched: no venue identity was adopted, no state advanced.
    expect(order?.state).toBe('SUBMISSION_AMBIGUOUS');
    expect(order?.exchangeOrderId).toBeNull();

    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('MANUAL_REVIEW_REQUIRED');
    const state = await reconciliation.loadState(accountId);
    expect(evaluateReconciliationBarrier(state, EPOCH).kind).toBe('BLOCKED');
  });
});

// ---------------------------------------------------------------------------
// §24.6 / §24.7 / §24.8 — orphans
// ---------------------------------------------------------------------------

describe('P18-DB §9 orphan venue orders', () => {
  it('[6] an orphan is recorded and never silently adopted', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    // A local order exists, but it is NOT the venue order below.
    await seedOrder(connectionA, intent, { state: 'ACKNOWLEDGED', exchangeOrderId: `mine-${accountId}` });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [
        venueOrder({ exchangeOrderId: `mine-${accountId}` }),
        venueOrder({ exchangeOrderId: `stranger-${accountId}` }),
      ],
    }));
    const { service } = buildService(connectionA, { evidence });
    const outcome = await service.reconcileAccount(accountId);

    const orphans = await connectionA.liveOrphanVenueOrder.findMany({ where: { accountId } });
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.exchangeOrderId).toBe(`stranger-${accountId}`);
    expect(orphans[0]?.cancelState).toBe('NONE');

    // The local order was NOT re-pointed at the stranger.
    const order = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    expect(order?.exchangeOrderId).toBe(`mine-${accountId}`);
    // And the account is blocked rather than reported healthy.
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
  });

  it('[7] the durable claim permits at most one wire cancel attempt, across runs and connections', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const port = new FakeOrphanCancellation({ kind: 'CANCELLED' });
    const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId: `stranger-${accountId}` })] }));

    const first = buildService(connectionA, { evidence, orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId });
    const second = buildService(connectionB, { evidence, orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId });

    await first.service.reconcileAccount(accountId);
    await second.service.reconcileAccount(accountId);
    await first.service.reconcileAccount(accountId);

    expect(port.attempts).toHaveLength(1);
    const orphan = await connectionA.liveOrphanVenueOrder.findUnique({
      where: { accountId_exchangeOrderId: { accountId, exchangeOrderId: `stranger-${accountId}` } },
    });
    expect(orphan?.cancelState).toBe('CANCEL_ACKNOWLEDGED');
    expect(orphan?.cancelGeneration).toBe(1);
  });

  it('[8] an ambiguous orphan cancel is not resent after a restart', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const port = new FakeOrphanCancellation({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId: `stranger-${accountId}` })] }));

    const before = buildService(connectionA, { evidence, orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId });
    await before.service.reconcileAccount(accountId);
    expect(port.attempts).toHaveLength(1);

    // A NEW process: new runtime epoch, same durable state.
    const after = buildService(connectionB, {
      evidence, epoch: 'runtime-epoch-restarted', orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId,
    });
    const outcome = await after.service.reconcileAccount(accountId);

    expect(port.attempts).toHaveLength(1);
    const orphan = await connectionB.liveOrphanVenueOrder.findUnique({
      where: { accountId_exchangeOrderId: { accountId, exchangeOrderId: `stranger-${accountId}` } },
    });
    expect(orphan?.cancelState).toBe('CANCEL_AMBIGUOUS');
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('MANUAL_REVIEW_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// §24.9 – §24.12 — positions
// ---------------------------------------------------------------------------

describe('P18-DB §10 authoritative live position establishment', () => {
  it('[9] exact venue/local reconstruction materializes Phase17 CLOSE ownership', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, {
      state: 'FILLED', exchangeOrderId: `venue-${accountId}`, cumulativeFilledQuantity: '0.5', averageFillPrice: '64000',
    });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [filledVenueOrder('0.5', { exchangeOrderId: `venue-${accountId}` })],
      positions: [venuePosition({ signedQuantity: '0.5' })],
    }));
    const { service } = buildService(connectionA, { evidence });
    const outcome = await service.reconcileAccount(accountId);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');

    const position = await connectionA.livePosition.findUnique({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(position).not.toBeNull();
    expect(position?.side).toBe('LONG');
    expectExactDecimal(position?.quantity, '0.5');
    expect(position?.ownerStrategyInstanceId).toBe('instance-1');

    const shares = await connectionA.livePositionOwnershipShare.findMany({ where: { accountId, pair: PAIR } });
    expect(shares).toHaveLength(1);
    expect(shares[0]?.materialized).toBe(true);
    expect(JSON.parse(shares[0]!.lineageJson)).toEqual([intent.intentId]);
  });

  it('[10] a mismatched position fails closed and writes no live_position', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, {
      state: 'FILLED', exchangeOrderId: `venue-${accountId}`, cumulativeFilledQuantity: '0.5', averageFillPrice: '64000',
    });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [filledVenueOrder('0.5', { exchangeOrderId: `venue-${accountId}` })],
      // The venue holds MORE than local lineage proves.
      positions: [venuePosition({ signedQuantity: '0.9' })],
    }));
    const { service } = buildService(connectionA, { evidence });
    const outcome = await service.reconcileAccount(accountId);

    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('UNHEALTHY');
    expect(await connectionA.livePosition.findUnique({ where: { accountId_pair: { accountId, pair: PAIR } } })).toBeNull();
    const findings = await connectionA.liveReconciliationFinding.findMany({ where: { accountId } });
    expect(findings.map((row) => row.code)).toContain('RECON_POSITION_QUANTITY_MISMATCH');
  });

  it('[11] strategy ownership cannot be fabricated from an aggregate venue quantity', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    // Exactly ONE strategy instance exists locally, and it has NO proven fills.
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'ACKNOWLEDGED', exchangeOrderId: `venue-${accountId}` });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [venueOrder({ exchangeOrderId: `venue-${accountId}` })],
      positions: [venuePosition({ signedQuantity: '0.5' })],
    }));
    const { service } = buildService(connectionA, { evidence });
    const outcome = await service.reconcileAccount(accountId);

    // The only candidate owner does NOT receive the aggregate.
    expect(await connectionA.livePosition.findUnique({ where: { accountId_pair: { accountId, pair: PAIR } } })).toBeNull();
    expect(await connectionA.livePositionOwnershipShare.findMany({ where: { accountId } })).toHaveLength(0);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
    const findings = await connectionA.liveReconciliationFinding.findMany({ where: { accountId } });
    expect(findings.map((row) => row.code)).toContain('RECON_POSITION_UNATTRIBUTED_EXPOSURE');
  });

  it('[12] multi-instance shares summing exactly to the aggregate are attributed without a single-owner claim', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const first = intentRecord(accountId, { strategyInstanceId: 'instance-a', quantity: '0.3' });
    const second = intentRecord(accountId, { strategyInstanceId: 'instance-b', quantity: '0.2' });
    await seedOrder(connectionA, first, {
      state: 'FILLED', exchangeOrderId: `venue-a-${accountId}`, cumulativeFilledQuantity: '0.3', averageFillPrice: '64000',
    });
    await seedOrder(connectionA, second, {
      state: 'FILLED', exchangeOrderId: `venue-b-${accountId}`, cumulativeFilledQuantity: '0.2', averageFillPrice: '64000',
    });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [
        filledVenueOrder('0.3', { exchangeOrderId: `venue-a-${accountId}`, orderedQuantity: '0.3' }),
        filledVenueOrder('0.2', { exchangeOrderId: `venue-b-${accountId}`, orderedQuantity: '0.2' }),
      ],
      positions: [venuePosition({ signedQuantity: '0.5' })],
    }));
    const { service } = buildService(connectionA, { evidence });
    const outcome = await service.reconcileAccount(accountId);

    const shares = await connectionA.livePositionOwnershipShare.findMany({
      where: { accountId, pair: PAIR }, orderBy: { ownerStrategyInstanceId: 'asc' },
    });
    expect(shares.map((row) => row.ownerStrategyInstanceId)).toEqual(['instance-a', 'instance-b']);
    expectExactDecimal(shares[0]?.quantity, '0.3');
    expectExactDecimal(shares[1]?.quantity, '0.2');
    expect(shares.every((row) => row.materialized === false)).toBe(true);
    // Fully attributed, so no unattributed-exposure fault...
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');
    // ...but Phase17's single-owner CLOSE record is deliberately NOT written,
    // so CLOSE for this pair stays fail-closed.
    expect(await connectionA.livePosition.findUnique({ where: { accountId_pair: { accountId, pair: PAIR } } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §24.13 / §24.14 — fills converge exactly once
// ---------------------------------------------------------------------------

describe('P18-DB §17 crash recovery of fills', () => {
  it('[13] a partial-fill restart converges exactly once', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    // Crash left the local order acknowledged with zero fill; the venue had
    // already partially filled it.
    await seedOrder(connectionA, intent, { state: 'ACKNOWLEDGED', exchangeOrderId: `venue-${accountId}` });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [filledVenueOrder('0.2', { exchangeOrderId: `venue-${accountId}` })],
      positions: [venuePosition({ signedQuantity: '0.2' })],
    }));
    const { service } = buildService(connectionA, { evidence });

    await service.reconcileAccount(accountId);
    const afterFirst = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    expect(afterFirst?.state).toBe('PARTIALLY_FILLED');
    expectExactDecimal(afterFirst?.cumulativeFilledQuantity, '0.2');
    const eventsAfterFirst = await connectionA.liveOrderEvent.count({ where: { intentId: intent.intentId } });
    expect(eventsAfterFirst).toBe(1);

    // Converges exactly once: a second and third run add no fill and no event.
    await service.reconcileAccount(accountId);
    await service.reconcileAccount(accountId);
    const afterThird = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    expectExactDecimal(afterThird?.cumulativeFilledQuantity, '0.2');
    expect(afterThird?.revision).toBe(afterFirst?.revision);
    expect(await connectionA.liveOrderEvent.count({ where: { intentId: intent.intentId } })).toBe(1);
  });

  it('[14] a late authoritative fill applies exactly once', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, {
      state: 'PARTIALLY_FILLED', exchangeOrderId: `venue-${accountId}`, cumulativeFilledQuantity: '0.2', averageFillPrice: '64000',
    });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [filledVenueOrder('0.5', { exchangeOrderId: `venue-${accountId}` })],
      positions: [venuePosition({ signedQuantity: '0.5' })],
    }));
    const { service } = buildService(connectionA, { evidence });

    await service.reconcileAccount(accountId);
    const afterFirst = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    expect(afterFirst?.state).toBe('FILLED');
    expectExactDecimal(afterFirst?.cumulativeFilledQuantity, '0.5');

    await service.reconcileAccount(accountId);
    const afterSecond = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    expectExactDecimal(afterSecond?.cumulativeFilledQuantity, '0.5');
    expect(afterSecond?.revision).toBe(afterFirst?.revision);
  });
});

// ---------------------------------------------------------------------------
// §24.15 / §24.16 — crash boundaries
// ---------------------------------------------------------------------------

describe('P18-DB §17 crash injection', () => {
  it('[15] a crash before commit rolls the whole transaction back', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const repository = new PrismaLiveReconciliationRepository(connectionA);
    const claim = await repository.claimGeneration(accountId, newLiveRuntimeIdentity(), 1_000);
    if (claim.kind !== 'CLAIMED') throw new Error('expected a claim');

    const before = await connectionA.liveOrphanVenueOrder.count({ where: { accountId } });

    // Crash mid-transaction: the orphan record and the snapshot write share a
    // transaction with a failing statement, so neither survives.
    await expect(connectionA.$transaction(async (tx) => {
      await tx.liveOrphanVenueOrder.create({ data: {
        accountId, exchangeOrderId: `doomed-${accountId}`, pair: PAIR, side: 'BUY', venueStatus: 'open',
        orderedQuantity: '0.5', filledQuantity: '0', price: '1', firstSeenGeneration: claim.lease.generation,
        lastSeenGeneration: claim.lease.generation, providerEventTimeMs: BigInt(1),
      } });
      throw new Error('simulated crash before commit');
    })).rejects.toThrow('simulated crash before commit');

    expect(await connectionA.liveOrphanVenueOrder.count({ where: { accountId } })).toBe(before);
  });

  it('[16] a restart after an incomplete reconciliation leaves the account blocked', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const repository = new PrismaLiveReconciliationRepository(connectionA);

    // Claim a generation and then "crash": never complete the run.
    const claim = await repository.claimGeneration(accountId, newLiveRuntimeIdentity(), 1_000);
    expect(claim.kind).toBe('CLAIMED');

    const crashed = await repository.loadState(accountId);
    expect(crashed.status).toBe('RUNNING');
    expect(evaluateReconciliationBarrier(crashed, EPOCH).kind).toBe('BLOCKED');

    // A NEW process starts. It must NOT inherit anything from the dead run.
    const restarted = await repository.loadState(accountId);
    const resolution = evaluateReconciliationBarrier(restarted, 'runtime-epoch-restarted');
    expect(resolution.kind).toBe('BLOCKED');

    // The abandoned run is explicitly fenced, not left pending forever.
    const next = await repository.claimGeneration(accountId, newLiveRuntimeIdentity(), 2_000);
    expect(next.kind).toBe('CLAIMED');
    const runs = await connectionA.liveReconciliationRun.findMany({ where: { accountId }, orderBy: { generation: 'asc' } });
    expect(runs[0]?.status).toBe('ABANDONED');
    expect(runs[1]?.status).toBe('RUNNING');
  });

  it('a crash after the ownership claim but before completion never publishes a healthy verdict', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const repository = new PrismaLiveReconciliationRepository(connectionA);
    const claim = await repository.claimGeneration(accountId, newLiveRuntimeIdentity(), 1_000);
    if (claim.kind !== 'CLAIMED') throw new Error('expected a claim');
    await repository.recordSnapshot(claim.lease, 'a'.repeat(64), 2_000, { validated: true, ordersComplete: true, positionsComplete: true });

    // Snapshot recorded, evaluation never finished.
    const state = await repository.loadState(accountId);
    expect(state.status).toBe('RUNNING');
    expect(state.healthyGeneration).toBeNull();
    expect(evaluateReconciliationBarrier(state, EPOCH).kind).toBe('BLOCKED');
  });
});

// ---------------------------------------------------------------------------
// §24.17 / §24.18 — the live mutation barrier
// ---------------------------------------------------------------------------

describe('P18-DB §18 the live mutation barrier', () => {
  it('[17] [P18 Wave B4 / F18-27] a HEALTHY reconciliation clears every fencing check but stays blocked pending account-continuity proof, which REST-only evidence can never supply', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const evidence = forAccount(accountId, evidenceSet());
    const { service, reconciliation, runtimeIdentity } = buildService(connectionA, { evidence });

    const outcome = await service.reconcileAccount(accountId);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');

    // Every fencing/state precondition `evaluateReconciliationBarrier` checks
    // (epoch, generation, blocking-finding-count) is satisfied here — the
    // ONLY reason authorization is refused is the permanent, structural
    // F18-27 finding that REST-only evidence can never prove account
    // continuity. This is what "HEALTHY reconciliation permits the normal
    // Phase17 path" meant before F18-27; it no longer does, by design.
    await expect(requireCurrentReconciliation(reconciliation, accountId, runtimeIdentity, 'CREATE'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
    await expect(requireCurrentReconciliation(reconciliation, accountId, runtimeIdentity, 'CLOSE'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
    // The underlying genuine HEALTHY authorization the barrier is refusing to
    // release still exists, proving the refusal above is F18-27 specifically
    // and not some other latent defect swallowing it.
    await expect(healthyAuthorizationForTest(reconciliation, accountId, runtimeIdentity)).resolves.toBeDefined();
  });

  it('[18] an unresolved account remains mutation-blocked on every path', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [
        venueOrder({ exchangeOrderId: `venue-a-${accountId}` }),
        venueOrder({ exchangeOrderId: `venue-b-${accountId}` }),
      ],
    }));
    const { service, reconciliation, runtimeIdentity } = buildService(connectionA, { evidence });
    await service.reconcileAccount(accountId);

    for (const mutation of ['CREATE', 'CANCEL', 'CLOSE'] as const) {
      await expect(requireCurrentReconciliation(reconciliation, accountId, runtimeIdentity, mutation)).rejects.toThrow(/LIVE_RECONCILIATION/);
    }
  });

  it('a never-reconciled account is blocked with no durable row at all', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const reconciliation = new PrismaLiveReconciliationRepository(connectionA);
    expect(await connectionA.liveReconciliationState.findUnique({ where: { accountId } })).toBeNull();
    const state = await reconciliation.loadState(accountId);
    expect(state.status).toBe('RECONCILIATION_REQUIRED');
    await expect(requireCurrentReconciliation(reconciliation, accountId, newLiveRuntimeIdentity(), 'CREATE'))
      .rejects.toThrow(/LIVE_RECONCILIATION_REQUIRED/);
  });

  it('a HEALTHY verdict from a PREVIOUS runtime epoch does not authorize a new process', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const evidence = forAccount(accountId, evidenceSet());
    const { service, reconciliation, runtimeIdentity } = buildService(connectionA, { evidence, epoch: 'first-process' });
    await service.reconcileAccount(accountId);
    // [P18 Wave B4 / F18-27] Blocked for THIS runtime too — by the permanent
    // continuity gate, not by epoch fencing. `.reason` distinguishes the two:
    // proves fencing itself would have permitted it.
    await expect(requireCurrentReconciliation(reconciliation, accountId, runtimeIdentity, 'CREATE'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });

    // Same durable row, different process. It must not inherit the pass —
    // and its block reason must be the EPOCH mismatch specifically, not the
    // (also-true) continuity gate, proving epoch fencing is still the active
    // cause here.
    await expect(requireCurrentReconciliation(reconciliation, accountId, newLiveRuntimeIdentity(), 'CREATE'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'STALE_RUNTIME_GENERATION' } });
  });
});

// ---------------------------------------------------------------------------
// Pair genericity and credential secrecy
// ---------------------------------------------------------------------------

describe('P18-DB §21/§22 secrecy and pair genericity', () => {
  it('reconciles a different pair with identical logic and no pair-specific branch', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId, { pair: OTHER_PAIR });
    await seedOrder(connectionA, intent, {
      state: 'FILLED', exchangeOrderId: `venue-${accountId}`, cumulativeFilledQuantity: '0.5', averageFillPrice: '64000',
    });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [filledVenueOrder('0.5', { exchangeOrderId: `venue-${accountId}`, pair: OTHER_PAIR })],
      positions: [venuePosition({ pair: OTHER_PAIR, signedQuantity: '0.5' })],
    }));
    const { service } = buildService(connectionA, { evidence });
    const outcome = await service.reconcileAccount(accountId);

    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');
    const position = await connectionA.livePosition.findUnique({ where: { accountId_pair: { accountId, pair: OTHER_PAIR } } });
    expectExactDecimal(position?.quantity, '0.5');
  });

  it('persists no credential material in any reconciliation row', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId: `stranger-${accountId}` })] }));
    const { service } = buildService(connectionA, { evidence });
    await service.reconcileAccount(accountId);

    const findings = await connectionA.liveReconciliationFinding.findMany({ where: { accountId } });
    expect(findings.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(findings, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)).toLowerCase();
    for (const forbidden of ['apikey', 'apisecret', 'x-auth', 'signature', 'authorization', 'password', 'secret', 'token']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('refuses to declare health when a provider read was incomplete', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const evidence = forAccount(accountId, evidenceSet({
      ordersProvenance: provenance({ complete: false, incompleteReason: 'ORDER_READ_FAILED_BUY_PAGE_3' }),
    }));
    const { service, reconciliation } = buildService(connectionA, { evidence });
    const outcome = await service.reconcileAccount(accountId);

    expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
    const state = await reconciliation.loadState(accountId);
    expect(evaluateReconciliationBarrier(state, EPOCH).kind).toBe('BLOCKED');
  });
});

// ---------------------------------------------------------------------------
// Wave A2 crash-claim recovery (F18-14)
//
// These prove the durable wire-arm protocol end to end over real MySQL, using
// TWO independent connections exactly like every other race proof above.
// "Simulate process death" means: nothing further happens on the connection
// that took the local claim. It is never released, never completed, never
// touched again by that connection — the ONLY thing that can happen to it is
// what a genuinely different runtime, reconciling on its OWN connection,
// durably does to it.
// ---------------------------------------------------------------------------

describe('P18-DB Wave A2 §16 OPEN crash recovery', () => {
  it('[A2-1] local-reservation crash (wire never armed): F recovers with zero wire mutation and the account reaches HEALTHY', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const evidence = forAccount(accountId, evidenceSet());
    const e = buildService(connectionA, { evidence });
    await e.service.reconcileAccount(accountId); // runtime E -> HEALTHY
    const authorization = await healthyAuthorizationForTest(e.reconciliation, accountId, e.runtimeIdentity);
    const intent = intentRecord(accountId);
    await e.execution.ensureIntent(intent);
    const claim = await e.execution.claimDispatch(intent.intentId, authorization, async () => true);
    expect(claim.kind).toBe('CLAIMED');
    expect(claim.order.dispatchWireArmed).toBe(false);
    // --- simulated crash: connection A never touches this order again ---

    const f = buildService(connectionB, { evidence: forAccount(accountId, evidenceSet()) });
    const outcome = await f.service.reconcileAccount(accountId);
    expect(outcome.kind).toBe('COMPLETED');
    const order = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: intent.intentId } });
    expect(order.state).toBe('CREATED');
    expect(order.dispatchWireArmed).toBe(false);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');
    const findings = await connectionB.liveReconciliationFinding.findMany({ where: { accountId } });
    expect(findings.map((row) => row.code)).toContain('RECON_DISPATCH_RESERVATION_RECLAIMED');
  });

  it('[A2-2] wire may have been attempted (armed): F can reconcile, but the mutation stays outstanding with no resend', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const evidence = forAccount(accountId, evidenceSet());
    const e = buildService(connectionA, { evidence });
    await e.service.reconcileAccount(accountId);
    const authorization = await healthyAuthorizationForTest(e.reconciliation, accountId, e.runtimeIdentity);
    const intent = intentRecord(accountId);
    await e.execution.ensureIntent(intent);
    const claim = await e.execution.claimDispatch(intent.intentId, authorization, async () => true);
    expect(claim.kind).toBe('CLAIMED');
    const armed = await e.execution.armDispatchWire(intent.intentId, claim.order.revision, authorization);
    expect(armed.dispatchWireArmed).toBe(true);
    // --- simulated crash: after wire-arm, before any response persistence ---

    const evidenceForF = forAccount(accountId, evidenceSet());
    const f = buildService(connectionB, { evidence: evidenceForF });
    const outcome = await f.service.reconcileAccount(accountId);
    expect(outcome.kind).toBe('COMPLETED');
    const order = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: intent.intentId } });
    // The claim is untouched — it is proven ambiguous, never blindly resolved.
    expect(order.state).toBe('DISPATCH_RESERVED');
    expect(order.dispatchWireArmed).toBe(true);
    expect(order.exchangeOrderId).toBeNull();
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
    const findings = await connectionB.liveReconciliationFinding.findMany({ where: { accountId } });
    // [Wave B3 / F18-21] Previously `RECON_AMBIGUOUS_CREATE_PROVEN_ABSENT`
    // (complete read, zero candidates). The TIF-unobservability gate now
    // fires first, unconditionally, before candidate count is even
    // considered — the F18-14 invariant this test exists to prove (claim
    // untouched, no resend, not HEALTHY) is identical either way.
    expect(findings.map((row) => row.code)).toContain('RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE');

    // No blind retry: reconciling again against the SAME evidence changes nothing.
    f.provider.setEvidence(evidenceForF);
    await f.service.reconcileAccount(accountId);
    const after = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: intent.intentId } });
    expect(after.state).toBe('DISPATCH_RESERVED');
    expect(after.exchangeOrderId).toBeNull();
  });
});

describe('P18-DB Wave A2 §16 regular cancel crash recovery', () => {
  it('[A2-3] local-reservation crash (wire never armed): F recovers with zero wire mutation and the account reaches HEALTHY', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'ACKNOWLEDGED', exchangeOrderId: `venue-${accountId}` });
    const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId: `venue-${accountId}` })] }));
    const e = buildService(connectionA, { evidence });
    await e.service.reconcileAccount(accountId);
    const authorization = await healthyAuthorizationForTest(e.reconciliation, accountId, e.runtimeIdentity);
    const claim = await e.execution.claimCancel(intent.intentId, accountId, authorization);
    expect(claim.kind).toBe('CLAIMED');
    expect(claim.order.cancelWireArmed).toBe(false);
    // --- simulated crash: connection A never touches this order again ---

    const f = buildService(connectionB, { evidence: forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId: `venue-${accountId}` })] })) });
    const outcome = await f.service.reconcileAccount(accountId);
    const order = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: intent.intentId } });
    expect(order.cancelState).toBe('NONE');
    expect(order.cancelWireArmed).toBe(false);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');
    const findings = await connectionB.liveReconciliationFinding.findMany({ where: { accountId } });
    expect(findings.map((row) => row.code)).toContain('RECON_CANCEL_RESERVATION_RECLAIMED');

    // The order is genuinely cancellable again: the account is not bricked.
    expect((await f.execution.claimCancel(intent.intentId, accountId, await healthyAuthorizationForTest(f.reconciliation, accountId, f.runtimeIdentity))).kind).toBe('CLAIMED');
  });

  it('[A2-4] wire may have been attempted (armed): F can reconcile, but the mutation stays outstanding with no resend', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'ACKNOWLEDGED', exchangeOrderId: `venue-${accountId}` });
    const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId: `venue-${accountId}` })] }));
    const e = buildService(connectionA, { evidence });
    await e.service.reconcileAccount(accountId);
    const authorization = await healthyAuthorizationForTest(e.reconciliation, accountId, e.runtimeIdentity);
    const claim = await e.execution.claimCancel(intent.intentId, accountId, authorization);
    expect(claim.kind).toBe('CLAIMED');
    const armed = await e.execution.armCancelWire(intent.intentId, claim.order.revision, authorization);
    expect(armed.cancelWireArmed).toBe(true);
    // --- simulated crash: after wire-arm, before any response persistence ---
    // The venue shows NO effect from the (possibly-sent) cancel: still resting.

    const f = buildService(connectionB, { evidence: forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId: `venue-${accountId}` })] })) });
    const outcome = await f.service.reconcileAccount(accountId);
    const order = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: intent.intentId } });
    // Authoritative evidence proves the order is genuinely unaffected, so the
    // claim IS safely resolved here — this is evidence-based resolution, never
    // a blind local inference from the armed flag alone.
    expect(order.cancelState).toBe('NONE');
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');
  });

  it('[A2-5] wire-armed and the venue proves the order was actually cancelled: resolved from evidence, never resent', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'ACKNOWLEDGED', exchangeOrderId: `venue-${accountId}` });
    const evidenceOpen = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId: `venue-${accountId}` })] }));
    const e = buildService(connectionA, { evidence: evidenceOpen });
    await e.service.reconcileAccount(accountId);
    const authorization = await healthyAuthorizationForTest(e.reconciliation, accountId, e.runtimeIdentity);
    const claim = await e.execution.claimCancel(intent.intentId, accountId, authorization);
    const armed = await e.execution.armCancelWire(intent.intentId, claim.order.revision, authorization);
    expect(armed.cancelWireArmed).toBe(true);
    // --- simulated crash: the cancel DID land at the venue, but this process never learns it ---

    const evidenceCancelled = forAccount(accountId, evidenceSet({
      orders: [venueOrder({
        exchangeOrderId: `venue-${accountId}`, venueStatus: 'cancelled', remainingQuantity: '0', cancelledQuantity: '0.5',
      })],
    }));
    const f = buildService(connectionB, { evidence: evidenceCancelled });
    const outcome = await f.service.reconcileAccount(accountId);
    const order = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: intent.intentId } });
    expect(order.state).toBe('CANCELLED');
    expect(order.cancelState).toBe('NONE');
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');
  });
});

describe('P18-DB Wave A2 §16 orphan cancel crash recovery', () => {
  it('[A2-6] local-reservation crash (wire never armed): F recovers with zero wire mutation', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const exchangeOrderId = `stranger-${accountId}`;
    const repositoryA = new PrismaLiveReconciliationRepository(connectionA);
    const claimGen = await repositoryA.claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now());
    if (claimGen.kind !== 'CLAIMED') throw new Error('expected a claim');
    await repositoryA.recordOrphanOrder(claimGen.lease, venueOrder({ exchangeOrderId }), Date.now());
    const orphanClaim = await repositoryA.claimOrphanCancellation(claimGen.lease, claimGen.authorization, exchangeOrderId, Date.now());
    expect(orphanClaim.kind).toBe('CLAIMED');
    if (orphanClaim.kind !== 'CLAIMED') return;
    expect(orphanClaim.record.cancelWireArmed).toBe(false);
    // --- simulated crash: connection A never touches this claim again ---

    const port = new FakeOrphanCancellation({ kind: 'CANCELLED' });
    const f = buildService(connectionB, {
      evidence: forAccount(accountId, evidenceSet()), orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId,
    });
    const outcome = await f.service.reconcileAccount(accountId);
    expect(port.attempts).toHaveLength(0); // zero wire mutation
    const orphan = await connectionB.liveOrphanVenueOrder.findUnique({ where: { accountId_exchangeOrderId: { accountId, exchangeOrderId } } });
    expect(orphan?.cancelState).toBe('NONE');
    expect(orphan?.cancelWireArmed).toBe(false);
    // The venue no longer shows this order at all: it is genuinely gone, so
    // there is nothing left to orphan-detect, and the account is not bricked.
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');
  });

  it('[A2-7] wire may have been attempted (armed): F recovers, marks it CANCEL_AMBIGUOUS, and never resends', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const exchangeOrderId = `stranger-${accountId}`;
    const repositoryA = new PrismaLiveReconciliationRepository(connectionA);
    const claimGen = await repositoryA.claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now());
    if (claimGen.kind !== 'CLAIMED') throw new Error('expected a claim');
    await repositoryA.recordOrphanOrder(claimGen.lease, venueOrder({ exchangeOrderId }), Date.now());
    const orphanClaim = await repositoryA.claimOrphanCancellation(claimGen.lease, claimGen.authorization, exchangeOrderId, Date.now());
    if (orphanClaim.kind !== 'CLAIMED') throw new Error('expected a claim');
    const armed = await repositoryA.armOrphanCancelWire(claimGen.lease, claimGen.authorization, exchangeOrderId, orphanClaim.record.cancelGeneration);
    expect(armed.cancelWireArmed).toBe(true);
    // --- simulated crash: after wire-arm, before any response persistence ---

    const port = new FakeOrphanCancellation({ kind: 'CANCELLED' });
    const f = buildService(connectionB, {
      evidence: forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId })] })),
      orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId,
    });
    const outcome = await f.service.reconcileAccount(accountId);
    expect(port.attempts).toHaveLength(0); // zero wire mutation — never resent
    const orphan = await connectionB.liveOrphanVenueOrder.findUnique({ where: { accountId_exchangeOrderId: { accountId, exchangeOrderId } } });
    expect(orphan?.cancelState).toBe('CANCEL_AMBIGUOUS');
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('MANUAL_REVIEW_REQUIRED');
    const findings = await connectionB.liveReconciliationFinding.findMany({ where: { accountId } });
    expect(findings.map((row) => row.code)).toContain('RECON_ORPHAN_CANCEL_AMBIGUOUS');
  });
});

describe('P18-DB Wave A2 §17 concurrency races', () => {
  it('[A2-8] new reconciliation wins first: the stale worker\'s wire-arm fails and sends zero requests', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const evidence = forAccount(accountId, evidenceSet());
    const e = buildService(connectionA, { evidence });
    await e.service.reconcileAccount(accountId);
    const authorization = await healthyAuthorizationForTest(e.reconciliation, accountId, e.runtimeIdentity);
    const intent = intentRecord(accountId);
    await e.execution.ensureIntent(intent);
    const claim = await e.execution.claimDispatch(intent.intentId, authorization, async () => true);
    expect(claim.kind).toBe('CLAIMED');

    // N+1 becomes the current recovery generation BEFORE N arms the wire.
    const supersession = await new PrismaLiveReconciliationRepository(connectionB).claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now());
    expect(supersession.kind).toBe('CLAIMED');

    await expect(e.execution.armDispatchWire(intent.intentId, claim.order.revision, authorization)).rejects.toThrow(/STALE_GENERATION/);
    const order = await connectionA.liveOrder.findUniqueOrThrow({ where: { intentId: intent.intentId } });
    expect(order.dispatchWireArmed).toBe(false);
  });

  it('[A2-9] wire-arm wins first: N+1 can still enter recovery, the mutation is visible as potentially sent, and there is no permanent NOT_OWNER loop', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const evidence = forAccount(accountId, evidenceSet());
    const e = buildService(connectionA, { evidence });
    await e.service.reconcileAccount(accountId);
    const authorization = await healthyAuthorizationForTest(e.reconciliation, accountId, e.runtimeIdentity);
    const intent = intentRecord(accountId);
    await e.execution.ensureIntent(intent);
    const claim = await e.execution.claimDispatch(intent.intentId, authorization, async () => true);
    expect(claim.kind).toBe('CLAIMED');

    // N commits the wire-arm BEFORE N+1 claims.
    const armed = await e.execution.armDispatchWire(intent.intentId, claim.order.revision, authorization);
    expect(armed.dispatchWireArmed).toBe(true);

    // N+1 is still free to claim and begin recovery — no NOT_OWNER deadlock,
    // ever, regardless of what N was doing.
    const f = buildService(connectionB, { evidence: forAccount(accountId, evidenceSet()) });
    const outcome = await f.service.reconcileAccount(accountId);
    expect(outcome.kind).toBe('COMPLETED');
    const order = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: intent.intentId } });
    // Visible as potentially sent: untouched, not silently cleared.
    expect(order.state).toBe('DISPATCH_RESERVED');
    expect(order.dispatchWireArmed).toBe(true);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');

    // And the SAME account can be reconciled again immediately — proving there
    // is no permanent NOT_OWNER loop: every subsequent claim still succeeds.
    const g = buildService(connectionA, { evidence: forAccount(accountId, evidenceSet()) });
    const secondOutcome = await g.service.reconcileAccount(accountId);
    expect(secondOutcome.kind).toBe('COMPLETED');
  });
});

describe('P18-DB Wave A2 §18 exact F18-14 regression reproduction', () => {
  it('[A2-10] create: runtime E HEALTHY, DISPATCH_RESERVED, simulated death, runtime F recovers, zero duplicate wire request, account not bricked', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const coordinator = new RiskAdmissionCoordinator();
    const enablement = genuineEnablement({ LIVE_EXECUTION_ACCOUNT_ALLOWLIST: accountId, COINDCX_LIVE_ACCOUNT_ID: accountId });
    const minted = await mintGenuineLiveOpen({ accountId, coordinator, enablement });
    const record = LiveExecutionIntent.read(minted.intent);
    const authorityRecord = LiveExecutionAuthority.read(minted.authority);
    if (record === null || authorityRecord === null) throw new Error('fixture expected a genuine minted authority');

    // runtime E reconciles -> HEALTHY.
    const evidence = forAccount(accountId, evidenceSet());
    const e = buildService(connectionA, { evidence });
    await e.service.reconcileAccount(accountId);
    const authorizationE = await healthyAuthorizationForTest(e.reconciliation, accountId, e.runtimeIdentity);

    // -> create order reaches DISPATCH_RESERVED. Taken at the repository level,
    // exactly like every other crash test above: `LiveExecutionService.dispatch`
    // always runs through to the gateway, so simulating a crash strictly
    // BETWEEN the local claim and the wire-arm requires stopping here, before
    // ever constructing a service bound to a gateway.
    const gatewayE = new FakeOrderGateway();
    await e.execution.ensureIntent(record);
    const claim = await e.execution.claimDispatch(record.intentId, authorizationE, async () => true);
    expect(claim.kind).toBe('CLAIMED');
    const claimed = await connectionA.liveOrder.findUniqueOrThrow({ where: { intentId: record.intentId } });
    expect(claimed.state).toBe('DISPATCH_RESERVED');
    expect(claimed.dispatchWireArmed).toBe(false);
    // -> simulate process death: E never arms the wire and never calls a
    // gateway. Zero wire requests so far.
    expect(gatewayE.placeCallCount).toBe(0);

    // -> construct runtime F. F cannot use E's HEALTHY (a fresh epoch is not the current one).
    const f = buildService(connectionB, { evidence: forAccount(accountId, evidenceSet()) });
    await expect(requireCurrentReconciliation(f.reconciliation, accountId, f.runtimeIdentity, 'CREATE')).rejects.toThrow(/LIVE_RECONCILIATION_REQUIRED/);

    // -> runtime F successfully begins reconciliation/recovery. Under the OLD
    // F18-14 behaviour this deadlocked here: `claimGeneration` returned LOST
    // forever because a DISPATCH_RESERVED claim existed, and only a completed
    // reconciliation could ever clear it.
    const outcome = await f.service.reconcileAccount(accountId);
    expect(outcome.kind).toBe('COMPLETED');

    // -> the stale claim becomes recoverable: unarmed, so it is safely reclaimed.
    const recovered = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: record.intentId } });
    expect(recovered.state).toBe('CREATED');
    expect(recovered.dispatchWireArmed).toBe(false);

    // -> no duplicate wire request: E's gateway was never called, and F's
    // reconciliation never calls a gateway at all (it has none).
    expect(gatewayE.placeCallCount).toBe(0);

    // -> the account is not permanently bricked: it is HEALTHY again, and the
    // SAME intent can be genuinely dispatched now, through a NEW runtime.
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');
    const authorizationF = await healthyAuthorizationForTest(f.reconciliation, accountId, f.runtimeIdentity);
    const gatewayF = new FakeOrderGateway().queuePlace({
      kind: 'ACCEPTED',
      observation: {
        kind: 'ACKNOWLEDGED', clientOrderId: record.clientOrderId, exchangeClientOrderId: null,
        exchangeOrderId: `venue-${accountId}`, pair: record.content.pair, side: record.content.side,
        cumulativeFilledQuantity: '0', orderedQuantity: record.content.quantity, averageFillPrice: null,
        exchangeStatus: 'open', providerEventTimeMs: Date.now(),
      },
    });
    const serviceF = new LiveExecutionService({ gateway: gatewayF, repository: new PrismaLiveExecutionRepository(connectionB), policy: livePolicy() });
    const dispatched = await serviceF.dispatch(minted.authority, minted.intent, authorizationF);
    expect(dispatched.kind).toBe('SUBMITTED');
    expect(gatewayF.placeCallCount).toBe(1);
  }, 60_000);

  it('[A2-11] regular cancel: runtime E HEALTHY, CANCEL_RESERVED, simulated death, runtime F recovers, zero duplicate wire request, account not bricked', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'ACKNOWLEDGED', exchangeOrderId: `venue-${accountId}` });
    const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId: `venue-${accountId}` })] }));

    // runtime E reconciles -> HEALTHY.
    const e = buildService(connectionA, { evidence });
    await e.service.reconcileAccount(accountId);
    const authorizationE = await healthyAuthorizationForTest(e.reconciliation, accountId, e.runtimeIdentity);

    // -> cancel reaches CANCEL_RESERVED.
    const gatewayE = new FakeOrderGateway();
    const serviceE = new LiveExecutionService({ gateway: gatewayE, repository: new PrismaLiveExecutionRepository(connectionA), policy: livePolicy() });
    void serviceE; // the durable claim below is taken directly, mirroring §16/§18's "reaches the reserved state" framing
    const claim = await e.execution.claimCancel(intent.intentId, accountId, authorizationE);
    expect(claim.kind).toBe('CLAIMED');
    // -> simulate process death: zero wire requests so far.
    expect(gatewayE.placeCallCount + gatewayE.cancelCallCount).toBe(0);

    // -> construct runtime F. F cannot use E's HEALTHY.
    const f = buildService(connectionB, { evidence: forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId: `venue-${accountId}` })] })) });
    await expect(requireCurrentReconciliation(f.reconciliation, accountId, f.runtimeIdentity, 'CREATE')).rejects.toThrow(/LIVE_RECONCILIATION_REQUIRED/);

    // -> runtime F successfully begins reconciliation/recovery and clears the
    // stale unarmed claim with zero exchange mutation.
    const outcome = await f.service.reconcileAccount(accountId);
    expect(outcome.kind).toBe('COMPLETED');
    const recovered = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: intent.intentId } });
    expect(recovered.cancelState).toBe('NONE');
    expect(recovered.cancelWireArmed).toBe(false);
    expect(gatewayE.cancelCallCount).toBe(0);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');

    // -> the account is not permanently bricked: a genuine NEW cancel attempt
    // now reaches the gateway exactly once.
    const authorizationF = await healthyAuthorizationForTest(f.reconciliation, accountId, f.runtimeIdentity);
    const gatewayF = new FakeOrderGateway().queueCancel({
      kind: 'CANCEL_ACCEPTED',
      observation: {
        kind: 'CANCELLED', clientOrderId: intent.clientOrderId, exchangeClientOrderId: null,
        exchangeOrderId: `venue-${accountId}`, pair: intent.content.pair, side: intent.content.side,
        cumulativeFilledQuantity: '0', orderedQuantity: intent.content.quantity, averageFillPrice: null,
        exchangeStatus: 'cancelled', providerEventTimeMs: Date.now(),
      },
    });
    const serviceF = new LiveExecutionService({ gateway: gatewayF, repository: new PrismaLiveExecutionRepository(connectionB), policy: livePolicy() });
    const cancelled = await serviceF.cancelDurable(intent.intentId, accountId, authorizationF);
    expect(cancelled.kind).toBe('CANCELLED');
    expect(gatewayF.cancelCallCount).toBe(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Wave A3: legacy migration safety (F18-16) and durable integrity (F18-18)
//
// [F18-16 methodology] `prisma migrate deploy` already brought this disposable
// database fully up to date, including the Wave A2 `ALTER TABLE` + backfill.
// Re-running `migrate deploy` a second time is a no-op (Prisma's own
// bookkeeping table skips already-applied migrations), so it cannot be used
// here to re-observe the backfill firing. Instead, these tests seed rows
// through the SAME repository path Phase17 always used (`ensureIntent` +
// `claimDispatch`/`claimCancel`, which — exactly like every pre-Wave-A2 build
// of this code — never touches `dispatch_wire_armed`/`cancel_wire_armed`, so
// the seeded row is byte-for-byte what a genuinely pre-existing outstanding
// claim looked like the INSTANT the Wave A2 `ALTER TABLE ... DEFAULT false`
// ran, before its backfill `UPDATE` executed), then execute that migration's
// own backfill SQL directly against the real database. This proves the exact
// behaviour under test — "does the backfill correctly reclassify a pre-existing
// outstanding claim as possibly-sent" — without the unrelated risk of
// reconstructing historical schema files. `[migration text]` tests below
// additionally pin that this executed SQL is byte-identical to what actually
// ships in the migration file, so the two can never drift apart.
// ---------------------------------------------------------------------------

const WAVE_A2_BACKFILL_SQL = Object.freeze([
  "UPDATE `live_order`\nSET `dispatch_wire_armed` = true\nWHERE `state` = 'DISPATCH_RESERVED';",
  "UPDATE `live_order`\nSET `cancel_wire_armed` = true\nWHERE `cancel_state` = 'CANCEL_RESERVED';",
  "UPDATE `live_orphan_venue_order`\nSET `cancel_wire_armed` = true\nWHERE `cancel_state` = 'CANCEL_CLAIMED';",
]);

describe('P18-DB Wave A3 §F18-16 legacy migration safety', () => {
  it('[migration text] the shipped migration file contains the exact backfill statements this suite executes', () => {
    const migrationPath = path.join(
      REPO_ROOT, 'prisma', 'migrations', '20260921010000_phase18_wave_a2_crash_recovery', 'migration.sql',
    );
    const text = readFileSync(migrationPath, 'utf8');
    for (const statement of WAVE_A2_BACKFILL_SQL) {
      expect(text.replace(/\r\n/g, '\n')).toContain(statement);
    }
  });

  it('[A3-1] backfill marks pre-existing outstanding claims possibly-sent, and leaves every control row unarmed', async () => {
    if (skip()) return;
    const accountId = freshAccount();

    // A pre-existing outstanding dispatch reservation (never armed by any
    // Wave A2 code path — this account predates it).
    const legacyDispatch = intentRecord(accountId);
    await seedOrder(connectionA, legacyDispatch, { state: 'DISPATCH_RESERVED' });

    // A pre-existing outstanding cancel reservation.
    const legacyCancel = intentRecord(accountId);
    await seedOrder(connectionA, legacyCancel, {
      state: 'CANCEL_REQUESTED', exchangeOrderId: `venue-${accountId}`, cancelState: 'CANCEL_RESERVED',
    });

    // Controls: none of these are outstanding claims, so the backfill must
    // never touch them.
    const controlCreated = intentRecord(accountId);
    await seedOrder(connectionA, controlCreated, { state: 'CREATED' });
    const controlTerminal = intentRecord(accountId);
    await seedOrder(connectionA, controlTerminal, {
      state: 'FILLED', exchangeOrderId: `venue-terminal-${accountId}`, cumulativeFilledQuantity: '0.5', averageFillPrice: '64000',
    });
    const controlAcknowledgedNoCancel = intentRecord(accountId);
    await seedOrder(connectionA, controlAcknowledgedNoCancel, { state: 'ACKNOWLEDGED', exchangeOrderId: `venue-ack-${accountId}` });

    for (const statement of WAVE_A2_BACKFILL_SQL) await connectionA.$executeRawUnsafe(statement);

    const dispatchRow = await connectionA.liveOrder.findUniqueOrThrow({ where: { intentId: legacyDispatch.intentId } });
    expect(dispatchRow.state).toBe('DISPATCH_RESERVED');
    expect(dispatchRow.dispatchWireArmed).toBe(true);
    expect(dispatchRow.cancelWireArmed).toBe(false);

    const cancelRow = await connectionA.liveOrder.findUniqueOrThrow({ where: { intentId: legacyCancel.intentId } });
    expect(cancelRow.cancelState).toBe('CANCEL_RESERVED');
    expect(cancelRow.cancelWireArmed).toBe(true);
    expect(cancelRow.dispatchWireArmed).toBe(false);

    for (const controlIntentId of [controlCreated.intentId, controlTerminal.intentId, controlAcknowledgedNoCancel.intentId]) {
      const row = await connectionA.liveOrder.findUniqueOrThrow({ where: { intentId: controlIntentId } });
      expect(row.dispatchWireArmed).toBe(false);
      expect(row.cancelWireArmed).toBe(false);
    }
  });

  it('[A3-2] a migrated legacy claim is NEVER reclaimed as unsent: reconciliation leaves it blocked pending evidence, with zero blind retry', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const legacyDispatch = intentRecord(accountId);
    await seedOrder(connectionA, legacyDispatch, { state: 'DISPATCH_RESERVED' });
    const legacyCancel = intentRecord(accountId);
    await seedOrder(connectionA, legacyCancel, {
      state: 'CANCEL_REQUESTED', exchangeOrderId: `venue-${accountId}`, cancelState: 'CANCEL_RESERVED',
    });
    for (const statement of WAVE_A2_BACKFILL_SQL) await connectionA.$executeRawUnsafe(statement);

    // Evidence proves nothing: no venue order exists for either claim, so
    // neither can be resolved from authoritative evidence this run.
    const { service } = buildService(connectionA, { evidence: forAccount(accountId, evidenceSet()) });
    const outcome = await service.reconcileAccount(accountId);
    expect(outcome.kind).toBe('COMPLETED');

    const dispatchRow = await connectionA.liveOrder.findUniqueOrThrow({ where: { intentId: legacyDispatch.intentId } });
    // NOT reclaimed to CREATED: a migrated legacy claim is never treated as
    // "local-only, safe to reclaim" — that is the whole point of F18-16.
    expect(dispatchRow.state).toBe('DISPATCH_RESERVED');
    expect(dispatchRow.dispatchWireArmed).toBe(true);

    const cancelRow = await connectionA.liveOrder.findUniqueOrThrow({ where: { intentId: legacyCancel.intentId } });
    expect(cancelRow.cancelState).toBe('CANCEL_RESERVED');
    expect(cancelRow.cancelWireArmed).toBe(true);

    // Blocked, not HEALTHY, until authoritative evidence resolves it.
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('MANUAL_REVIEW_REQUIRED');
    const state = await new PrismaLiveReconciliationRepository(connectionA).loadState(accountId);
    expect(evaluateReconciliationBarrier(state, EPOCH).kind).toBe('BLOCKED');

    // Zero blind wire retry: reconciliation holds no gateway at all, so there
    // is no code path here through which a resend could even be attempted.
  });

  it('[A3-3, F18-14 recheck] a genuinely NEW unarmed Wave A2 reservation is still safely reclaimed, unlike a migrated legacy one', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const evidence = forAccount(accountId, evidenceSet());
    const e = buildService(connectionA, { evidence });
    await e.service.reconcileAccount(accountId);
    const authorization = await healthyAuthorizationForTest(e.reconciliation, accountId, e.runtimeIdentity);
    const intent = intentRecord(accountId);
    await e.execution.ensureIntent(intent);
    const claim = await e.execution.claimDispatch(intent.intentId, authorization, async () => true);
    expect(claim.kind).toBe('CLAIMED');
    expect(claim.order.dispatchWireArmed).toBe(false);

    const f = buildService(connectionB, { evidence: forAccount(accountId, evidenceSet()) });
    const outcome = await f.service.reconcileAccount(accountId);
    const order = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: intent.intentId } });
    // Reclaimed to CREATED: this is a genuine new-protocol local-only
    // reservation, never wire-armed, distinct from a migrated legacy claim.
    expect(order.state).toBe('CREATED');
    expect(order.dispatchWireArmed).toBe(false);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');
  });
});

describe('P18-DB Wave A3 §F18-18 contradictory wire-armed state fails closed (real MySQL)', () => {
  it('[A3-4] dispatchWireArmed=true while state=CREATED (direct SQL corruption) fails closed with zero reconciliation effect', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'CREATED' });

    // Reconcile and mint a genuine HEALTHY authorization BEFORE corrupting the
    // row, so the "no live mutation" proof below exercises the full fenced
    // path (not a fence refusal that would mask the integrity check).
    const { service, reconciliation, runtimeIdentity } = buildService(connectionA, { evidence: forAccount(accountId, evidenceSet()) });
    await service.reconcileAccount(accountId);
    const authorization = await healthyAuthorizationForTest(reconciliation, accountId, runtimeIdentity);

    // Bypasses the repository entirely, simulating tampering or a future
    // regression — never something any Phase17/Phase18 code path can write.
    // This touches ONLY `live_order`, so the authorization just minted above
    // still names the current, untouched reconciliation generation.
    await connectionA.$executeRawUnsafe(
      'UPDATE `live_order` SET `dispatch_wire_armed` = true WHERE `intent_id` = ?', intent.intentId,
    );

    const execution = new PrismaLiveExecutionRepository(connectionA);
    await expect(execution.load(intent.intentId)).rejects.toThrow(/LIVE_DURABLE_INTEGRITY_VIOLATION/);
    await expect(execution.listAccountOrderViews(accountId)).rejects.toThrow(/LIVE_DURABLE_INTEGRITY_VIOLATION/);

    // No live mutation: a service bound to a real gateway, holding a genuine
    // CURRENT authorization, still never reaches the gateway.
    const gateway = new FakeOrderGateway();
    const liveService = new LiveExecutionService({ gateway, repository: execution, policy: livePolicy() });
    await expect(liveService.cancelDurable(intent.intentId, accountId, authorization)).rejects.toThrow(/LIVE_DURABLE_INTEGRITY_VIOLATION/);
    expect(gateway.placeCallCount + gateway.cancelCallCount).toBe(0);

    // No reconciliation economic effect: a FRESH reconciliation attempt (its
    // own new generation claim, no caller authorization needed) refuses
    // before any finding, snapshot, or commit is produced, leaving the
    // account RUNNING (blocked), never HEALTHY. Compared against the count
    // right after the first (successful, pre-corruption) run rather than
    // asserting zero outright: a legitimate reconciliation of a flat account
    // may itself record a non-blocking audit finding, and that is not what
    // this proves — what matters is that the SECOND, failing attempt adds
    // nothing on top of it.
    const findingsBeforeSecondAttempt = await connectionA.liveReconciliationFinding.count({ where: { accountId } });
    const second = buildService(connectionA, { evidence: forAccount(accountId, evidenceSet()) });
    await expect(second.service.reconcileAccount(accountId)).rejects.toThrow(/LIVE_DURABLE_INTEGRITY_VIOLATION/);
    const state = await reconciliation.loadState(accountId);
    expect(state.status).toBe('RUNNING');
    expect(await connectionA.liveReconciliationFinding.count({ where: { accountId } })).toBe(findingsBeforeSecondAttempt);
  });

  it('[A3-5] cancelWireArmed=true while cancel_state=NONE (direct SQL corruption) fails closed with zero reconciliation effect', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'ACKNOWLEDGED', exchangeOrderId: `venue-${accountId}` });

    // Evidence matches the seeded order so the pre-corruption reconcile
    // genuinely reaches HEALTHY (an unmatched order would block on its own
    // CONFLICT finding, which would defeat the point of this fixture).
    const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId: `venue-${accountId}` })] }));
    const { service, reconciliation, runtimeIdentity } = buildService(connectionA, { evidence });
    const preCorruptionOutcome = await service.reconcileAccount(accountId);
    expect(preCorruptionOutcome.kind === 'COMPLETED' && preCorruptionOutcome.result.status).toBe('HEALTHY');
    const authorization = await healthyAuthorizationForTest(reconciliation, accountId, runtimeIdentity);

    await connectionA.$executeRawUnsafe(
      'UPDATE `live_order` SET `cancel_wire_armed` = true WHERE `intent_id` = ?', intent.intentId,
    );

    const execution = new PrismaLiveExecutionRepository(connectionA);
    await expect(execution.load(intent.intentId)).rejects.toThrow(/LIVE_DURABLE_INTEGRITY_VIOLATION/);

    const gateway = new FakeOrderGateway();
    const liveService = new LiveExecutionService({ gateway, repository: execution, policy: livePolicy() });
    await expect(liveService.cancelDurable(intent.intentId, accountId, authorization)).rejects.toThrow(/LIVE_DURABLE_INTEGRITY_VIOLATION/);
    expect(gateway.placeCallCount + gateway.cancelCallCount).toBe(0);

    const findingsBeforeSecondAttempt = await connectionA.liveReconciliationFinding.count({ where: { accountId } });
    const second = buildService(connectionA, { evidence });
    await expect(second.service.reconcileAccount(accountId)).rejects.toThrow(/LIVE_DURABLE_INTEGRITY_VIOLATION/);
    const state = await reconciliation.loadState(accountId);
    expect(state.status).toBe('RUNNING');
    expect(await connectionA.liveReconciliationFinding.count({ where: { accountId } })).toBe(findingsBeforeSecondAttempt);
  });

  it('[A3-6] orphan cancelWireArmed=true while cancel_state=NONE (direct SQL corruption) fails closed', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const repository = new PrismaLiveReconciliationRepository(connectionA);
    const claim = await repository.claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now());
    if (claim.kind !== 'CLAIMED') throw new Error('expected a claim');
    const exchangeOrderId = `stranger-${accountId}`;
    await repository.recordOrphanOrder(claim.lease, venueOrder({ exchangeOrderId }), Date.now());
    await connectionA.$executeRawUnsafe(
      'UPDATE `live_orphan_venue_order` SET `cancel_wire_armed` = true WHERE `account_id` = ? AND `exchange_order_id` = ?',
      accountId, exchangeOrderId,
    );
    await expect(repository.loadOrphanOrders(accountId)).rejects.toThrow(/LIVE_DURABLE_INTEGRITY_VIOLATION/);
  });
});

// ---------------------------------------------------------------------------
// Wave B — F18-03 / F18-04 / F18-08 (real MySQL)
// ---------------------------------------------------------------------------

describe('P18-DB Wave B §F18-03 incomplete pagination never resolves an ambiguous create', () => {
  it('[B-1] a single visible candidate from an INCOMPLETE read never adopts a venue identity', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [venueOrder({ exchangeOrderId: `venue-${accountId}` })],
      ordersProvenance: provenance({ complete: false, incompleteReason: 'ORDER_PAGINATION_LIMIT_BUY' }),
    }));
    const { service, reconciliation } = buildService(connectionA, { evidence });
    const outcome = await service.reconcileAccount(accountId);

    const order = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    // The decisive assertion: no durable economic adoption, EXACTLY like the
    // two-candidate case already proven above — a single visible candidate
    // from an incomplete read is no more trustworthy than two candidates.
    expect(order?.state).toBe('SUBMISSION_AMBIGUOUS');
    expect(order?.exchangeOrderId).toBeNull();

    expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
    const state = await reconciliation.loadState(accountId);
    expect(evaluateReconciliationBarrier(state, EPOCH).kind).toBe('BLOCKED');
  });

  it('[B-2] incomplete positions evidence adopts no ownership even when a durable order provably filled', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, {
      state: 'ACKNOWLEDGED', exchangeOrderId: `venue-${accountId}`, cumulativeFilledQuantity: '0.5', averageFillPrice: '64000',
    });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [filledVenueOrder('0.5', { exchangeOrderId: `venue-${accountId}` })],
      positionsProvenance: provenance({ source: 'COINDCX_FUTURES_POSITIONS', complete: false, incompleteReason: 'POSITION_READ_FAILED_PAGE_1' }),
    }));
    const { service } = buildService(connectionA, { evidence });
    await service.reconcileAccount(accountId);

    const shares = await connectionA.livePositionOwnershipShare.count({ where: { accountId } });
    const position = await connectionA.livePosition.findUnique({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(shares).toBe(0);
    expect(position).toBeNull();
  });
});

describe('P18-DB Wave B §F18-04 the bracketed snapshot-stability protocol over a real connection', () => {
  it('[B-3] a perpetually-mutating order set never completes HEALTHY and applies zero economic effects', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const provider = new AlwaysUnstableEvidenceProvider({
      orders: [], ordersProvenance: provenance({ source: 'COINDCX_FUTURES_ORDERS' }),
      positions: [], positionsProvenance: provenance({ source: 'COINDCX_FUTURES_POSITIONS', localReadStartedAtMs: 2_000, localReadEndedAtMs: 2_100 }),
      unstableOrders: true,
    });
    const { service, reconciliation } = buildService(connectionA, { evidenceProvider: provider, accountId, maxSnapshotAttempts: 2 });

    const outcome = await service.reconcileAccount(accountId);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
    expect(outcome.kind === 'COMPLETED' && outcome.result.findings.map((finding) => finding.code)).toEqual(['RECON_EVIDENCE_SNAPSHOT_UNSTABLE']);

    const state = await reconciliation.loadState(accountId);
    expect(state.status).not.toBe('HEALTHY');
    expect(await connectionA.liveOrphanVenueOrder.count({ where: { accountId } })).toBe(0);
  });

  it('[B-4] a stable bracketed snapshot proceeds to HEALTHY exactly like the single-read path did', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const clean = forAccount(accountId, evidenceSet());
    const provider = new SequencedEvidenceProvider({
      orders: [clean.orders],
      ordersProvenance: [clean.ordersProvenance],
      positions: [clean.positions],
      positionsProvenance: [clean.positionsProvenance],
    });
    const { service } = buildService(connectionA, { evidenceProvider: provider, accountId });

    const outcome = await service.reconcileAccount(accountId);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');
  });

  it('[B-7] a transient blip that stabilizes on the second bracket converges exactly once, including across a fresh generation', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    // [Wave B3 / F18-21] Previously used an ambiguous-create resolution as
    // the convergence signal; that path is now unconditionally blocked on
    // TIF (see the dedicated F18-21 describe block), so this test observes
    // convergence through ORPHAN DETECTION instead — a signal entirely
    // independent of TIF/ambiguous-create identity, and just as good a proof
    // that the F18-04 stability-retry mechanism converges to a single,
    // idempotent durable outcome once the bracket stabilizes.
    const stableEvidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId: `stranger-${accountId}`, venueStatus: 'open' })] }));
    const provider = new SequencedEvidenceProvider({
      // Attempt 1: A sees nothing, B sees the stranger order -> unstable.
      // Attempt 2: A and B agree -> stable, and the now-proven orphan is recorded.
      orders: [[], stableEvidence.orders, stableEvidence.orders, stableEvidence.orders],
      ordersProvenance: [stableEvidence.ordersProvenance],
      positions: [stableEvidence.positions],
      positionsProvenance: [stableEvidence.positionsProvenance],
    });
    const { service: first, execution } = buildService(connectionA, { evidenceProvider: provider, accountId, maxSnapshotAttempts: 3 });
    const outcome = await first.reconcileAccount(accountId);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');

    const orphans = await connectionA.liveOrphanVenueOrder.findMany({ where: { accountId } });
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.exchangeOrderId).toBe(`stranger-${accountId}`);
    const findingsAfterFirst = await connectionA.liveReconciliationFinding.count({ where: { accountId } });

    // A SECOND, independent reconciliation generation sees the already-stable
    // evidence and converges to the exact same durable state: no duplicate
    // orphan row, no new finding.
    const stableAgain = new SequencedEvidenceProvider({
      orders: [stableEvidence.orders],
      ordersProvenance: [stableEvidence.ordersProvenance],
      positions: [stableEvidence.positions],
      positionsProvenance: [stableEvidence.positionsProvenance],
    });
    const { service: second } = buildService(connectionA, { evidenceProvider: stableAgain, accountId });
    const secondOutcome = await second.reconcileAccount(accountId);
    expect(secondOutcome.kind === 'COMPLETED' && secondOutcome.result.status).not.toBe('HEALTHY');

    const orphansAfterSecond = await connectionA.liveOrphanVenueOrder.findMany({ where: { accountId } });
    expect(orphansAfterSecond).toHaveLength(1);
    expect(await connectionA.liveReconciliationFinding.count({ where: { accountId } })).toBe(findingsAfterFirst);
    void execution;
  });
});

describe('P18-DB Wave B §F18-08 missing venue leverage never adopts a leveraged ambiguous create', () => {
  it('[B-5] a single candidate reporting no leverage at all is never treated as an exact match', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    // `intentRecord`'s default content carries leverage '5' (line ~156).
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [venueOrder({ exchangeOrderId: `venue-${accountId}`, leverage: null })],
    }));
    const { service, reconciliation } = buildService(connectionA, { evidence });
    const outcome = await service.reconcileAccount(accountId);

    const order = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    expect(order?.state).toBe('SUBMISSION_AMBIGUOUS');
    expect(order?.exchangeOrderId).toBeNull();
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
    const state = await reconciliation.loadState(accountId);
    expect(evaluateReconciliationBarrier(state, EPOCH).kind).toBe('BLOCKED');
  });
});

describe('P18-DB Wave B §F18-03/§F18-04 idempotence under a persisting block', () => {
  it('[B-6] repeated reconciliation against an unresolvable incomplete candidate adds no new findings or events', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [venueOrder({ exchangeOrderId: `venue-${accountId}` })],
      ordersProvenance: provenance({ complete: false, incompleteReason: 'ORDER_PAGINATION_LIMIT_BUY' }),
    }));

    const first = buildService(connectionA, { evidence });
    await first.service.reconcileAccount(accountId);
    const findingsAfterFirst = await connectionA.liveReconciliationFinding.count({ where: { accountId } });
    const eventsAfterFirst = await connectionA.liveOrderEvent.count({ where: { intentId: intent.intentId } });

    for (let run = 0; run < 2; run += 1) {
      const next = buildService(connectionA, { evidence });
      const outcome = await next.service.reconcileAccount(accountId);
      expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
    }

    expect(await connectionA.liveReconciliationFinding.count({ where: { accountId } })).toBe(findingsAfterFirst);
    expect(await connectionA.liveOrderEvent.count({ where: { intentId: intent.intentId } })).toBe(eventsAfterFirst);
    const order = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    expect(order?.state).toBe('SUBMISSION_AMBIGUOUS');
    expect(order?.exchangeOrderId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wave B2 — F18-20 / F18-21 (real MySQL)
// ---------------------------------------------------------------------------

describe('P18-DB Wave B2 §F18-20 incomplete evidence never advances a KNOWN venue-bound order', () => {
  it('[B2-1] a proven partial-fill advance is withheld entirely when the order read is incomplete: zero DB mutation', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'ACKNOWLEDGED', exchangeOrderId: `venue-${accountId}`, cumulativeFilledQuantity: '0' });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [filledVenueOrder('0.2', { exchangeOrderId: `venue-${accountId}` })],
      ordersProvenance: provenance({ complete: false, incompleteReason: 'ORDER_PAGINATION_LIMIT_BUY' }),
    }));
    const before = await connectionA.liveOrderEvent.count({ where: { intentId: intent.intentId } });
    const { service } = buildService(connectionA, { evidence });
    const outcome = await service.reconcileAccount(accountId);

    const order = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    expect(order?.state).toBe('ACKNOWLEDGED');
    expectExactDecimal(order?.cumulativeFilledQuantity, '0');
    expect(await connectionA.liveOrderEvent.count({ where: { intentId: intent.intentId } })).toBe(before);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
    expect(outcome.kind === 'COMPLETED' && outcome.result.findings.map((f) => f.code)).toContain('RECON_ORDER_ADVANCE_WITHHELD_INCOMPLETE_EVIDENCE');
  });

  it('[B2-2] a proven FULL fill (terminal FILLED advance) is equally withheld when the order read is incomplete', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'ACKNOWLEDGED', exchangeOrderId: `venue-${accountId}`, cumulativeFilledQuantity: '0' });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [filledVenueOrder('0.5', { exchangeOrderId: `venue-${accountId}` })],
      ordersProvenance: provenance({ complete: false, incompleteReason: 'ORDER_READ_FAILED_SELL_PAGE_3' }),
    }));
    const { service } = buildService(connectionA, { evidence });
    await service.reconcileAccount(accountId);

    const order = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    expect(order?.state).toBe('ACKNOWLEDGED');
    expectExactDecimal(order?.cumulativeFilledQuantity, '0');
  });

  it('[B2-3] withholding a known-order advance leaves position ownership untouched too (cascading safety)', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'ACKNOWLEDGED', exchangeOrderId: `venue-${accountId}`, cumulativeFilledQuantity: '0' });

    const evidence = forAccount(accountId, evidenceSet({
      orders: [filledVenueOrder('0.5', { exchangeOrderId: `venue-${accountId}` })],
      ordersProvenance: provenance({ complete: false, incompleteReason: 'ORDER_PAGINATION_LIMIT_BUY' }),
      positions: [venuePosition({ signedQuantity: '0.5' })],
    }));
    const { service } = buildService(connectionA, { evidence });
    await service.reconcileAccount(accountId);

    // The order never advanced, so its fill contribution is still zero;
    // lineage-derived ownership cannot and must not materialize from it.
    const shares = await connectionA.livePositionOwnershipShare.count({ where: { accountId } });
    const position = await connectionA.livePosition.findUnique({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(shares).toBe(0);
    expect(position).toBeNull();
  });

  it('[B2-5] a STABLE (twice-confirmed) but still-incomplete read remains insufficient authority — stability is not completeness', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'ACKNOWLEDGED', exchangeOrderId: `venue-${accountId}`, cumulativeFilledQuantity: '0' });

    const advanced = forAccount(accountId, evidenceSet({
      orders: [filledVenueOrder('0.2', { exchangeOrderId: `venue-${accountId}` })],
      ordersProvenance: provenance({ complete: false, incompleteReason: 'ORDER_PAGINATION_LIMIT_SELL' }),
    }));
    // A fixed fixture is served identically on every bracketed read, so it is
    // genuinely STABLE (both brackets agree) — but `complete: false` on every
    // one of those identical reads, proving repeated agreement never upgrades
    // completeness (§5 "Repeated reads do not upgrade completeness").
    const { service } = buildService(connectionA, { evidence: advanced, maxSnapshotAttempts: 3 });
    const outcome = await service.reconcileAccount(accountId);

    const order = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    expect(order?.state).toBe('ACKNOWLEDGED');
    expectExactDecimal(order?.cumulativeFilledQuantity, '0');
    expect(outcome.kind === 'COMPLETED' && outcome.result.findings.map((f) => f.code)).not.toContain('RECON_EVIDENCE_SNAPSHOT_UNSTABLE');
    expect(outcome.kind === 'COMPLETED' && outcome.result.findings.map((f) => f.code)).toContain('RECON_ORDER_ADVANCE_WITHHELD_INCOMPLETE_EVIDENCE');
  });

  it('[B2-7] withheld evidence converges to the correct advance exactly once, the moment a later run supplies COMPLETE evidence', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'ACKNOWLEDGED', exchangeOrderId: `venue-${accountId}`, cumulativeFilledQuantity: '0' });

    const incomplete = forAccount(accountId, evidenceSet({
      orders: [filledVenueOrder('0.2', { exchangeOrderId: `venue-${accountId}` })],
      ordersProvenance: provenance({ complete: false, incompleteReason: 'ORDER_PAGINATION_LIMIT_BUY' }),
    }));
    const first = buildService(connectionA, { evidence: incomplete });
    await first.service.reconcileAccount(accountId);
    const withheld = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    expect(withheld?.state).toBe('ACKNOWLEDGED');
    expectExactDecimal(withheld?.cumulativeFilledQuantity, '0');

    const complete = forAccount(accountId, evidenceSet({
      orders: [filledVenueOrder('0.2', { exchangeOrderId: `venue-${accountId}` })],
      positions: [venuePosition({ signedQuantity: '0.2' })],
    }));
    const second = buildService(connectionA, { evidence: complete });
    const outcome = await second.service.reconcileAccount(accountId);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');

    const advanced = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    expect(advanced?.state).toBe('PARTIALLY_FILLED');
    expectExactDecimal(advanced?.cumulativeFilledQuantity, '0.2');
    const revisionAfterAdvance = advanced?.revision;
    const eventsAfterAdvance = await connectionA.liveOrderEvent.count({ where: { intentId: intent.intentId } });

    // A third run against the SAME complete evidence converges exactly once:
    // no duplicate event, no revision churn.
    const third = buildService(connectionA, { evidence: complete });
    await third.service.reconcileAccount(accountId);
    const stillAdvanced = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    expect(stillAdvanced?.revision).toBe(revisionAfterAdvance);
    expect(await connectionA.liveOrderEvent.count({ where: { intentId: intent.intentId } })).toBe(eventsAfterAdvance);
  });
});

describe('P18-DB Wave B2 §F18-21 TIF-unobservable candidates never bind an ambiguous create', () => {
  it('[B2-4] a local FILL_OR_KILL intent with an otherwise-perfect single candidate remains unbound', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    // `intentRecord` does not expose `timeInForce` as an override; the durable
    // projection's identity view reads it straight through from the sealed
    // intent, so this test drives it via a direct intent-content override at
    // the seam `intentRecord` itself does not need to know about: the
    // pure-function layer already proves the TIF gate exhaustively (Wave B2
    // unit tests). This DB test proves the SAME gate holds end to end when a
    // genuinely persisted intent carries a non-default TIF.
    const withTif = { ...intent, content: { ...intent.content, timeInForce: 'FILL_OR_KILL' as const } };
    await seedOrder(connectionA, withTif, { state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null });

    const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId: `venue-${accountId}` })] }));
    const { service, reconciliation } = buildService(connectionA, { evidence });
    const outcome = await service.reconcileAccount(accountId);

    const order = await connectionA.liveOrder.findUnique({ where: { intentId: withTif.intentId } });
    expect(order?.state).toBe('SUBMISSION_AMBIGUOUS');
    expect(order?.exchangeOrderId).toBeNull();
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
    expect(outcome.kind === 'COMPLETED' && outcome.result.findings.map((f) => f.code)).toContain('RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE');
    const state = await reconciliation.loadState(accountId);
    expect(evaluateReconciliationBarrier(state, EPOCH).kind).toBe('BLOCKED');
  });

  // [Wave B3 / F18-21 correction] Previously this test asserted GOOD_TILL_CANCEL
  // (and, implicitly, UNSPECIFIED) resolved normally — the exemption
  // independent review rejected. There is no venue-indistinguishable default
  // this project can found a durable identity binding on. The required
  // matrix (§24) now proves ALL FIVE local TIF values leave the order
  // unbound against a real database, with zero exchangeOrderId adoption.
  it.each([
    'GOOD_TILL_CANCEL',
    'UNSPECIFIED',
    'IMMEDIATE_OR_CANCEL',
    'FILL_OR_KILL',
    'POST_ONLY',
  ] as const)('[F18-21 REQUIRED MATRIX] local TIF %s never binds an exchangeOrderId, even against an otherwise-perfect single candidate (real MySQL)', async (timeInForce) => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    const withTif = { ...intent, content: { ...intent.content, timeInForce } };
    await seedOrder(connectionA, withTif, { state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null });

    const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId: `venue-${accountId}` })] }));
    const { service, reconciliation } = buildService(connectionA, { evidence });
    const outcome = await service.reconcileAccount(accountId);

    const order = await connectionA.liveOrder.findUnique({ where: { intentId: withTif.intentId } });
    expect(order?.state).toBe('SUBMISSION_AMBIGUOUS');
    expect(order?.exchangeOrderId).toBeNull();
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
    expect(outcome.kind === 'COMPLETED' && outcome.result.findings.map((f) => f.code)).toContain('RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE');
    const state = await reconciliation.loadState(accountId);
    expect(evaluateReconciliationBarrier(state, EPOCH).kind).toBe('BLOCKED');
  });

  it('[F18-21 idempotence] repeated reconciliation against a permanently TIF-unobservable candidate adds no new findings or events', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    const withTif = { ...intent, content: { ...intent.content, timeInForce: 'UNSPECIFIED' as const } };
    await seedOrder(connectionA, withTif, { state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null });

    const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId: `venue-${accountId}` })] }));
    const first = buildService(connectionA, { evidence });
    await first.service.reconcileAccount(accountId);
    const findingsAfterFirst = await connectionA.liveReconciliationFinding.count({ where: { accountId } });
    const eventsAfterFirst = await connectionA.liveOrderEvent.count({ where: { intentId: withTif.intentId } });

    for (let run = 0; run < 2; run += 1) {
      const next = buildService(connectionA, { evidence });
      const outcome = await next.service.reconcileAccount(accountId);
      expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
    }

    expect(await connectionA.liveReconciliationFinding.count({ where: { accountId } })).toBe(findingsAfterFirst);
    expect(await connectionA.liveOrderEvent.count({ where: { intentId: withTif.intentId } })).toBe(eventsAfterFirst);
    const order = await connectionA.liveOrder.findUnique({ where: { intentId: withTif.intentId } });
    expect(order?.state).toBe('SUBMISSION_AMBIGUOUS');
    expect(order?.exchangeOrderId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wave B3 — F18-23 / F18-04 (real MySQL)
// ---------------------------------------------------------------------------

describe('P18-DB Wave B3 §F18-23 real network latency must not falsely block a clean account', () => {
  it('[B3-1] 40ms of latency on every one of the four bracketed provider calls does not produce RECON_EVIDENCE_CAUSALITY_VIOLATION', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const clock = new FixedClock(Date.now());
    const provider = new LatencyAwareEvidenceProvider({ clock, latencyMs: 40, orders: [], positions: [] });
    const { service } = buildService(connectionA, { evidenceProvider: provider, accountId });

    const outcome = await service.reconcileAccount(accountId);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');
    expect(outcome.kind === 'COMPLETED' && outcome.result.findings.map((f) => f.code)).not.toContain('RECON_EVIDENCE_CAUSALITY_VIOLATION');
  });
});

describe('P18-DB Wave B3 §F18-04 CURRENT-STATE reconciliation (Option B) over a real connection', () => {
  it('[B3-2] a clean account with zero history-sensitive local state reaches HEALTHY from current-state-only reconciliation', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    // Same ABA-blind-spot pattern as the unit test: both bracketed reads of
    // each kind are empty/flat. The protocol genuinely cannot see whatever
    // may have transiently happened in between — that is accepted (§6.2) —
    // and is safe here because nothing durable locally depends on it.
    const provider = new SequencedEvidenceProvider({
      orders: [[], []],
      ordersProvenance: [provenance({ source: 'COINDCX_FUTURES_ORDERS' })],
      positions: [[], []],
      positionsProvenance: [provenance({ source: 'COINDCX_FUTURES_POSITIONS', localReadStartedAtMs: 2_000, localReadEndedAtMs: 2_100 })],
    });
    const { service } = buildService(connectionA, { evidenceProvider: provider, accountId, maxSnapshotAttempts: 3 });

    const outcome = await service.reconcileAccount(accountId);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');
  });

  it('[B3-3] the IDENTICAL final REST-visible state remains blocked when local durable state is history-sensitive (real MySQL)', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    // A real, persisted DISPATCH_RESERVED claim whose wire outcome is
    // genuinely unknown — reached through the same seeding helper every other
    // crash-recovery test in this file uses, then advanced to
    // SUBMISSION_AMBIGUOUS exactly as Phase17's own expiry path would.
    await seedOrder(connectionA, intent, { state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null });

    // Identical endpoint pattern to [B3-2]: both bracketed reads empty/flat.
    const provider = new SequencedEvidenceProvider({
      orders: [[], []],
      ordersProvenance: [provenance({ source: 'COINDCX_FUTURES_ORDERS' })],
      positions: [[], []],
      positionsProvenance: [provenance({ source: 'COINDCX_FUTURES_POSITIONS', localReadStartedAtMs: 2_000, localReadEndedAtMs: 2_100 })],
    });
    const { service } = buildService(connectionA, { evidenceProvider: provider, accountId, maxSnapshotAttempts: 3 });

    const outcome = await service.reconcileAccount(accountId);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');

    const order = await connectionA.liveOrder.findUnique({ where: { intentId: intent.intentId } });
    expect(order?.state).toBe('SUBMISSION_AMBIGUOUS');
    expect(order?.exchangeOrderId).toBeNull();
  });

  it('[B3-4] repeated reconciliation of the blocked history-sensitive account is idempotent: no new findings, no stale ownership or live_position effect', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const intent = intentRecord(accountId);
    await seedOrder(connectionA, intent, { state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null });

    const provider = evidenceSet({ orders: [], positions: [] });
    const first = buildService(connectionA, { evidence: forAccount(accountId, provider) });
    await first.service.reconcileAccount(accountId);
    const findingsAfterFirst = await connectionA.liveReconciliationFinding.count({ where: { accountId } });

    for (let run = 0; run < 2; run += 1) {
      const next = buildService(connectionA, { evidence: forAccount(accountId, provider) });
      const outcome = await next.service.reconcileAccount(accountId);
      expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
    }

    expect(await connectionA.liveReconciliationFinding.count({ where: { accountId } })).toBe(findingsAfterFirst);
    const shares = await connectionA.livePositionOwnershipShare.count({ where: { accountId } });
    const position = await connectionA.livePosition.findUnique({ where: { accountId_pair: { accountId, pair: PAIR } } });
    expect(shares).toBe(0);
    expect(position).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wave B4 — F18-25 / F18-26 / F18-27 (real MySQL)
// ---------------------------------------------------------------------------

describe('P18-DB Wave B4 §F18-25 durable orphan ambiguity is sticky across generations, independent of current evidence', () => {
  it('[B4-1] run 1: visible orphan -> ambiguous cancel -> durable CANCEL_AMBIGUOUS; run 2: venue stops returning it, but the account still blocks; run 3: idempotent repeat', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const exchangeOrderId = `stranger-${accountId}`;
    const port = new FakeOrphanCancellation({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const visibleEvidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId })] }));
    const emptyEvidence = forAccount(accountId, evidenceSet({ orders: [] }));

    // Run 1: the orphan is visible, cleanup is enabled, the cancel attempt's
    // outcome is unestablished.
    const run1 = buildService(connectionA, { evidence: visibleEvidence, orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId });
    const outcome1 = await run1.service.reconcileAccount(accountId);
    expect(port.attempts).toHaveLength(1);
    expect(outcome1.kind === 'COMPLETED' && outcome1.result.status).toBe('MANUAL_REVIEW_REQUIRED');
    const afterRun1 = await connectionA.liveOrphanVenueOrder.findUnique({
      where: { accountId_exchangeOrderId: { accountId, exchangeOrderId } },
    });
    expect(afterRun1?.cancelState).toBe('CANCEL_AMBIGUOUS');
    const findingRow = await connectionA.liveReconciliationFinding.findFirst({
      where: { accountId, code: 'RECON_ORPHAN_CANCEL_AMBIGUOUS' },
    });
    expect(findingRow).not.toBeNull();
    const stickyDigest = findingRow!.findingSha256;

    // Run 2: the venue no longer returns the order AT ALL — otherwise-clean,
    // stable evidence. The confirmed exploit: without F18-25, this run would
    // see zero orphans, push no finding for this order, and could reach
    // HEALTHY. With the fix, the durable CANCEL_AMBIGUOUS is reasserted
    // regardless.
    const run2 = buildService(connectionB, { evidence: emptyEvidence, epoch: 'runtime-epoch-2', orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId });
    const outcome2 = await run2.service.reconcileAccount(accountId);
    expect(port.attempts).toHaveLength(1); // never resent
    expect(outcome2.kind === 'COMPLETED' && outcome2.result.status).not.toBe('HEALTHY');
    expect(outcome2.kind === 'COMPLETED' && outcome2.result.findings.some((f) => f.code === 'RECON_ORPHAN_CANCEL_AMBIGUOUS')).toBe(true);
    const afterRun2 = await connectionA.liveOrphanVenueOrder.findUnique({
      where: { accountId_exchangeOrderId: { accountId, exchangeOrderId } },
    });
    expect(afterRun2?.cancelState).toBe('CANCEL_AMBIGUOUS'); // unchanged, never oscillates
    const findingAfterRun2 = await connectionA.liveReconciliationFinding.findFirst({ where: { accountId, code: 'RECON_ORPHAN_CANCEL_AMBIGUOUS' } });
    expect(findingAfterRun2?.findingSha256).toBe(stickyDigest); // same row, dedup by content, not a new one

    // Run 3: repeat once more. Idempotent: same digest, no duplicate rows,
    // still blocked, no economic mutation, no further wire attempts.
    const run3 = buildService(connectionA, { evidence: emptyEvidence, epoch: 'runtime-epoch-3', orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId });
    const outcome3 = await run3.service.reconcileAccount(accountId);
    expect(port.attempts).toHaveLength(1);
    expect(outcome3.kind === 'COMPLETED' && outcome3.result.status).not.toBe('HEALTHY');
    expect(await connectionA.liveReconciliationFinding.count({ where: { accountId, code: 'RECON_ORPHAN_CANCEL_AMBIGUOUS' } })).toBe(1);
    const afterRun3 = await connectionA.liveOrphanVenueOrder.findUnique({
      where: { accountId_exchangeOrderId: { accountId, exchangeOrderId } },
    });
    expect(afterRun3?.cancelState).toBe('CANCEL_AMBIGUOUS');
    expect(afterRun3?.revision).toBe(afterRun1?.revision); // zero further mutation of the orphan row itself
  });
});

describe('P18-DB Wave B5 §F18-29 a durably CANCEL_AMBIGUOUS orphan never also raises the generic RECON_ORPHAN_VENUE_ORDER finding (real MySQL)', () => {
  it('[B5-1] same-run direct discovery and every later reassertion each write exactly one finding row for the orphan', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const exchangeOrderId = `stranger-${accountId}`;
    const port = new FakeOrphanCancellation({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const visibleEvidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId })] }));

    // Run 1: the FIRST time this orphan is ever seen, in the same run its
    // cancel attempt turns ambiguous. Before the F18-29 fix, this exact
    // sequence produced BOTH `RECON_ORPHAN_VENUE_ORDER` (from orphan
    // detection, evaluated before the cancel attempt even happens) and
    // `RECON_ORPHAN_CANCEL_AMBIGUOUS` (from the cancel attempt itself) as two
    // separate durable rows for the identical underlying orphan.
    const run1 = buildService(connectionA, { evidence: visibleEvidence, orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId });
    const outcome1 = await run1.service.reconcileAccount(accountId);
    expect(outcome1.kind === 'COMPLETED' && outcome1.result.status).toBe('MANUAL_REVIEW_REQUIRED');

    const rowsAfterRun1 = await connectionA.liveReconciliationFinding.findMany({ where: { accountId, exchangeOrderId } });
    expect(rowsAfterRun1.map((row) => row.code)).toEqual(['RECON_ORPHAN_CANCEL_AMBIGUOUS']);

    // Run 2: the venue STILL returns the order (unlike the F18-25 test, which
    // exercises the order becoming invisible). detectOrphanVenueOrders would,
    // on its own, raise a fresh RECON_ORPHAN_VENUE_ORDER for it every single
    // generation the order stays visible; F18-29 requires that finding to
    // stay suppressed for as long as the sticky ambiguity finding covers it.
    const run2 = buildService(connectionB, { evidence: visibleEvidence, epoch: 'runtime-epoch-2', orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId });
    const outcome2 = await run2.service.reconcileAccount(accountId);
    expect(outcome2.kind === 'COMPLETED' && outcome2.result.status).not.toBe('HEALTHY');
    expect(port.attempts).toHaveLength(1); // never resent

    const rowsAfterRun2 = await connectionA.liveReconciliationFinding.findMany({ where: { accountId, exchangeOrderId } });
    expect(rowsAfterRun2.map((row) => row.code)).toEqual(['RECON_ORPHAN_CANCEL_AMBIGUOUS']);
    expect(rowsAfterRun2).toHaveLength(1); // still exactly one row, not two
  });
});

// ---------------------------------------------------------------------------
// [Wave C1 / F18-06] Durable orphan cancellation ambiguity resolution: an
// explicit, audited operator decision is the ONLY way a `CANCEL_AMBIGUOUS`
// orphan ever stops blocking. Every guarantee here is proven against a real
// database, with two genuinely independent connections wherever concurrency
// is the property under test.
// ---------------------------------------------------------------------------

describe('P18-DB Wave C1 §F18-06 durable orphan ambiguity resolution (real MySQL)', () => {
  async function driveToAmbiguousDB(client: PrismaClient, accountId: string, exchangeOrderId: string) {
    const port = new FakeOrphanCancellation({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId })] }));
    const e = buildService(client, { evidence, orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId });
    const outcome = await e.service.reconcileAccount(accountId);
    if (outcome.kind !== 'COMPLETED' || outcome.result.status !== 'MANUAL_REVIEW_REQUIRED') {
      throw new Error('expected the account to reach MANUAL_REVIEW_REQUIRED with an ambiguous orphan cancel');
    }
    const orphan = await client.liveOrphanVenueOrder.findUniqueOrThrow({
      where: { accountId_exchangeOrderId: { accountId, exchangeOrderId } },
    });
    return { ...e, port, orphan };
  }

  it('[C1-1] basic resolution: durable, audited, no wire call, no economic mutation, not reasserted, live mutation still fails with ACCOUNT_CONTINUITY_NOT_PROVEN', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const exchangeOrderId = `stranger-${accountId}`;
    const { reconciliation, port, orphan } = await driveToAmbiguousDB(connectionA, accountId, exchangeOrderId);

    const request = mintOrphanAmbiguityResolutionRequest({
      accountId, exchangeOrderId, expectedRevision: orphan.revision,
      outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:jane', note: 'Manually acknowledged after investigation',
    });
    const { resolution, orphan: resolved } = await reconciliation.resolveOrphanCancelAmbiguity(request, Date.now());
    expect(resolved.cancelState).toBe('CANCEL_AMBIGUOUS_RESOLVED');

    // Durably persisted, auditable.
    const auditRows = await connectionA.liveOrphanCancelResolution.findMany({ where: { accountId, exchangeOrderId } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.outcome).toBe('ACKNOWLEDGED_NO_RETRY');
    expect(auditRows[0]?.resolvedBy).toBe('ops:jane');
    expect(auditRows[0]?.note).toBe('Manually acknowledged after investigation');
    expect(auditRows[0]?.resolvedCancelGeneration).toBe(orphan.cancelGeneration);
    expect(resolution.resolutionId).toBe(auditRows[0]?.resolutionId);

    // No wire call beyond the original ambiguous attempt.
    expect(port.attempts).toHaveLength(1);

    // No economic mutation of any kind: this account has no live orders and
    // no live position at all.
    expect(await connectionA.liveOrder.count({ where: { accountId } })).toBe(0);
    expect(await connectionA.livePosition.count({ where: { accountId } })).toBe(0);

    // Next reconciliation, venue no longer returns the order: not reasserted,
    // and with nothing else blocking the account reaches HEALTHY.
    const emptyEvidence = forAccount(accountId, evidenceSet());
    const next = buildService(connectionB, { evidence: emptyEvidence, orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId });
    const outcome2 = await next.service.reconcileAccount(accountId);
    if (outcome2.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome2.result.findings.map((f) => f.code)).not.toContain('RECON_ORPHAN_CANCEL_AMBIGUOUS');
    expect(outcome2.result.status).toBe('HEALTHY');
    expect(port.attempts).toHaveLength(1); // still never resent

    // Live mutation authorization is STILL refused — for the F18-27 reason,
    // not because resolution granted anything. Resolution and live-mutation
    // authorization are deliberately separate authorities (§F18-27/§F18-28
    // are completely unaffected by this module).
    await expect(requireCurrentReconciliation(reconciliation, accountId, next.runtimeIdentity, 'CREATE'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
  });

  it('[C1-2] a stale-revision resolution request is refused with zero mutation', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const exchangeOrderId = `stranger-${accountId}`;
    const { reconciliation, orphan } = await driveToAmbiguousDB(connectionA, accountId, exchangeOrderId);

    const staleRequest = mintOrphanAmbiguityResolutionRequest({
      accountId, exchangeOrderId, expectedRevision: orphan.revision - 1,
      outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:jane',
    });
    await expect(reconciliation.resolveOrphanCancelAmbiguity(staleRequest, Date.now())).rejects.toThrow(/LIVE_ORPHAN_RESOLUTION_STALE_REVISION/);

    const after = await connectionA.liveOrphanVenueOrder.findUniqueOrThrow({
      where: { accountId_exchangeOrderId: { accountId, exchangeOrderId } },
    });
    expect(after.cancelState).toBe('CANCEL_AMBIGUOUS');
    expect(after.revision).toBe(orphan.revision);
    expect(await connectionA.liveOrphanCancelResolution.count({ where: { accountId, exchangeOrderId } })).toBe(0);
  });

  it('[C1-3] a resolution for one account never touches another account\'s orphan, even with the identical exchange order id', async () => {
    if (skip()) return;
    const accountA = freshAccount();
    const accountB = freshAccount();
    const sharedExchangeOrderId = 'stranger-shared';
    const a = await driveToAmbiguousDB(connectionA, accountA, sharedExchangeOrderId);
    const b = await driveToAmbiguousDB(connectionB, accountB, sharedExchangeOrderId);

    const request = mintOrphanAmbiguityResolutionRequest({
      accountId: accountA, exchangeOrderId: sharedExchangeOrderId, expectedRevision: a.orphan.revision,
      outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:jane',
    });
    await a.reconciliation.resolveOrphanCancelAmbiguity(request, Date.now());

    const afterA = await connectionA.liveOrphanVenueOrder.findUniqueOrThrow({
      where: { accountId_exchangeOrderId: { accountId: accountA, exchangeOrderId: sharedExchangeOrderId } },
    });
    const afterB = await connectionA.liveOrphanVenueOrder.findUniqueOrThrow({
      where: { accountId_exchangeOrderId: { accountId: accountB, exchangeOrderId: sharedExchangeOrderId } },
    });
    expect(afterA.cancelState).toBe('CANCEL_AMBIGUOUS_RESOLVED');
    expect(afterB.cancelState).toBe('CANCEL_AMBIGUOUS'); // completely untouched
    expect(afterB.revision).toBe(b.orphan.revision);
    expect(await connectionA.liveOrphanCancelResolution.count({ where: { accountId: accountB } })).toBe(0);
  });

  it('[C1-4] two concurrent resolution requests for the same ambiguity: exactly one wins, one deterministic loser, one audit row, one revision advancement', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const exchangeOrderId = `stranger-${accountId}`;
    const { orphan } = await driveToAmbiguousDB(connectionA, accountId, exchangeOrderId);

    const repoA = new PrismaLiveReconciliationRepository(connectionA);
    const repoB = new PrismaLiveReconciliationRepository(connectionB);
    const requestA = mintOrphanAmbiguityResolutionRequest({
      accountId, exchangeOrderId, expectedRevision: orphan.revision,
      outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:a',
    });
    const requestB = mintOrphanAmbiguityResolutionRequest({
      accountId, exchangeOrderId, expectedRevision: orphan.revision,
      outcome: 'CONFIRMED_CANCELLED', resolvedBy: 'ops:b',
    });

    const [resultA, resultB] = await Promise.allSettled([
      repoA.resolveOrphanCancelAmbiguity(requestA, Date.now()),
      repoB.resolveOrphanCancelAmbiguity(requestB, Date.now()),
    ]);

    const settled = [resultA, resultB];
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/LIVE_ORPHAN_RESOLUTION_(STALE_REVISION|NOT_AMBIGUOUS)/);

    const finalOrphan = await connectionA.liveOrphanVenueOrder.findUniqueOrThrow({
      where: { accountId_exchangeOrderId: { accountId, exchangeOrderId } },
    });
    expect(finalOrphan.cancelState).toBe('CANCEL_AMBIGUOUS_RESOLVED');
    expect(finalOrphan.revision).toBe(orphan.revision + 1); // exactly one advancement, never two

    const auditRows = await connectionA.liveOrphanCancelResolution.findMany({ where: { accountId, exchangeOrderId } });
    expect(auditRows).toHaveLength(1); // exactly one durable resolution row, no duplicate
  });

  it('[C1-5a] operator resolves first: a reconciliation that starts afterward never reasserts the old ambiguity or resends the cancel, and raises the stronger reappearance finding if the order is still visible', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const exchangeOrderId = `stranger-${accountId}`;
    const { reconciliation, port, orphan } = await driveToAmbiguousDB(connectionA, accountId, exchangeOrderId);

    const request = mintOrphanAmbiguityResolutionRequest({
      accountId, exchangeOrderId, expectedRevision: orphan.revision,
      outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:jane',
    });
    await reconciliation.resolveOrphanCancelAmbiguity(request, Date.now());

    // Reconciliation runs AFTER the resolution commits, with the order still
    // visible at the venue.
    const visibleAgain = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId })] }));
    const next = buildService(connectionB, { evidence: visibleAgain, orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId });
    const outcome = await next.service.reconcileAccount(accountId);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(port.attempts).toHaveLength(1); // never resent
    const codes = outcome.result.findings.filter((f) => f.subject.exchangeOrderId === exchangeOrderId).map((f) => f.code);
    expect(codes).toEqual(['RECON_ORPHAN_REAPPEARED_AFTER_RESOLUTION']);
    expect(outcome.result.status).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('[C1-5b] no reconciliation write path can ever revert a resolved orphan back to CANCEL_AMBIGUOUS, proven directly against every claim/arm/reclaim/complete transition', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const exchangeOrderId = `stranger-${accountId}`;
    const { reconciliation, orphan, runtimeIdentity } = await driveToAmbiguousDB(connectionA, accountId, exchangeOrderId);

    const request = mintOrphanAmbiguityResolutionRequest({
      accountId, exchangeOrderId, expectedRevision: orphan.revision,
      outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:jane',
    });
    await reconciliation.resolveOrphanCancelAmbiguity(request, Date.now());

    // A fresh reconciliation generation claims ownership over the SAME
    // account/runtime — exactly what "generation N is reconciling" means —
    // and attempts the one write path that could, in principle, ever touch
    // this orphan's cancellation state: claimOrphanCancellation. It must
    // refuse, because the durable row is not NONE.
    const claim = await reconciliation.claimGeneration(accountId, runtimeIdentity, Date.now());
    if (claim.kind !== 'CLAIMED') throw new Error('expected a genuine generation claim');
    const claimResult = await reconciliation.claimOrphanCancellation(claim.lease, claim.authorization, exchangeOrderId, Date.now());
    expect(claimResult.kind).toBe('NOT_CLAIMABLE');
    expect(claimResult.record.cancelState).toBe('CANCEL_AMBIGUOUS_RESOLVED');

    const after = await connectionA.liveOrphanVenueOrder.findUniqueOrThrow({
      where: { accountId_exchangeOrderId: { accountId, exchangeOrderId } },
    });
    expect(after.cancelState).toBe('CANCEL_AMBIGUOUS_RESOLVED'); // never reverted by any reconciliation write
    expect(after.revision).toBe(orphan.revision + 1); // only the resolution's own increment
  });

  it('[C1-6] crash/restart: a brand-new runtime epoch reconciling after a resolution does not reassert the old ambiguity or resend the cancel', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const exchangeOrderId = `stranger-${accountId}`;
    const { reconciliation, port, orphan } = await driveToAmbiguousDB(connectionA, accountId, exchangeOrderId);

    const request = mintOrphanAmbiguityResolutionRequest({
      accountId, exchangeOrderId, expectedRevision: orphan.revision,
      outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:jane',
    });
    await reconciliation.resolveOrphanCancelAmbiguity(request, Date.now());

    // A brand-new process: new runtime identity (via buildService's fresh
    // newLiveRuntimeIdentity()), a different connection, and the venue no
    // longer returns the order at all — exactly what a restart after a
    // resolved crash-ambiguity looks like.
    const emptyEvidence = forAccount(accountId, evidenceSet());
    const restarted = buildService(connectionB, { evidence: emptyEvidence, orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId });
    const outcome = await restarted.service.reconcileAccount(accountId);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome.result.findings.map((f) => f.code)).not.toContain('RECON_ORPHAN_CANCEL_AMBIGUOUS');
    expect(outcome.result.status).toBe('HEALTHY');
    expect(port.attempts).toHaveLength(1); // never resent, even after a full restart
  });

  it('[C1-7] a resolved orphan reappearing at the venue raises the stronger finding, is never silently ignored, and blocks', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const exchangeOrderId = `stranger-${accountId}`;
    const { reconciliation, port, orphan } = await driveToAmbiguousDB(connectionA, accountId, exchangeOrderId);

    const request = mintOrphanAmbiguityResolutionRequest({
      accountId, exchangeOrderId, expectedRevision: orphan.revision,
      outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:jane',
    });
    await reconciliation.resolveOrphanCancelAmbiguity(request, Date.now());

    // Baseline: venue stops returning it, account reaches HEALTHY — proving
    // this test's reappearance below is a genuine departure from a settled
    // resolved-and-quiet state, not an artifact of never having been quiet.
    const emptyEvidence = forAccount(accountId, evidenceSet());
    const healthyRun = buildService(connectionB, { evidence: emptyEvidence, orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId });
    const healthyOutcome = await healthyRun.service.reconcileAccount(accountId);
    if (healthyOutcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(healthyOutcome.result.status).toBe('HEALTHY');

    // The exact same exchange order id becomes active again.
    const reappearedEvidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId })] }));
    const reappearedRun = buildService(connectionA, { evidence: reappearedEvidence, orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId });
    const reappearedOutcome = await reappearedRun.service.reconcileAccount(accountId);
    if (reappearedOutcome.kind !== 'COMPLETED') throw new Error('expected completion');
    const codes = reappearedOutcome.result.findings.filter((f) => f.subject.exchangeOrderId === exchangeOrderId).map((f) => f.code);
    expect(codes).toEqual(['RECON_ORPHAN_REAPPEARED_AFTER_RESOLUTION']);
    expect(reappearedOutcome.result.status).toBe('MANUAL_REVIEW_REQUIRED');
    expect(port.attempts).toHaveLength(1); // never auto-cancelled again
  });
});

describe('P18-DB Wave B4 §F18-26 orphan cancellation is durably wire-armed BEFORE the HTTP call', () => {
  it('[B4-2] a legitimate cancel attempt arms the wire before the port is called', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const exchangeOrderId = `stranger-${accountId}`;
    let armedBeforeCall = false;
    const port = new FakeOrphanCancellation({ kind: 'CANCELLED' });
    const originalCancel = port.cancelVenueOrder.bind(port);
    port.cancelVenueOrder = async (request) => {
      const row = await connectionA.liveOrphanVenueOrder.findUnique({
        where: { accountId_exchangeOrderId: { accountId, exchangeOrderId: request.exchangeOrderId } },
      });
      armedBeforeCall = row?.cancelWireArmed === true && row.cancelState === 'CANCEL_CLAIMED';
      return originalCancel(request);
    };
    const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId })] }));
    const { service } = buildService(connectionA, { evidence, orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId });

    await service.reconcileAccount(accountId);
    expect(armedBeforeCall).toBe(true);
    const after = await connectionA.liveOrphanVenueOrder.findUnique({
      where: { accountId_exchangeOrderId: { accountId, exchangeOrderId } },
    });
    // Armed proof is cleared once the outcome is durably resolved (§F18-18):
    // it must never survive as a contradictory `true` against a settled state.
    expect(after?.cancelState).toBe('CANCEL_ACKNOWLEDGED');
    expect(after?.cancelWireArmed).toBe(false);
  });

  it('[B4-3] crash BEFORE arm: restart reclaims with zero wire calls', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const exchangeOrderId = `stranger-${accountId}`;
    const repositoryA = new PrismaLiveReconciliationRepository(connectionA);
    const owner = await repositoryA.claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now());
    if (owner.kind !== 'CLAIMED') throw new Error('expected owner');
    await repositoryA.recordOrphanOrder(owner.lease, venueOrder({ exchangeOrderId }), Date.now());
    const claim = await repositoryA.claimOrphanCancellation(owner.lease, owner.authorization, exchangeOrderId, Date.now());
    if (claim.kind !== 'CLAIMED') throw new Error('expected claim');
    // Simulated crash: the claim exists, `cancelWireArmed` is still false —
    // local proof alone shows the wire call could not possibly have left
    // this process.
    expect(claim.record.cancelWireArmed).toBe(false);

    const port = new FakeOrphanCancellation({ kind: 'CANCELLED' });
    const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId })] }));
    const restart = buildService(connectionB, {
      evidence, accountId, epoch: 'runtime-epoch-restart', orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId,
    });
    await restart.service.reconcileAccount(accountId);

    // The unarmed claim was safely reclaimed (NONE), and — because cleanup is
    // still enabled and the orphan is still visible — a genuinely NEW claim
    // was then taken and cancelled through the normal path. Either way, the
    // crashed attempt itself sent zero wire requests: nothing about the
    // reclaim path ever touches the gateway.
    const after = await connectionA.liveOrphanVenueOrder.findUnique({
      where: { accountId_exchangeOrderId: { accountId, exchangeOrderId } },
    });
    expect(['CANCEL_ACKNOWLEDGED', 'NONE']).toContain(after?.cancelState);
    expect(port.attempts.length).toBeLessThanOrEqual(1);
  });

  it('[B4-4] crash AFTER arm, before response persistence: restart never blind-resends, and stays ambiguous/blocking', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const exchangeOrderId = `stranger-${accountId}`;
    const repositoryA = new PrismaLiveReconciliationRepository(connectionA);
    const owner = await repositoryA.claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now());
    if (owner.kind !== 'CLAIMED') throw new Error('expected owner');
    await repositoryA.recordOrphanOrder(owner.lease, venueOrder({ exchangeOrderId }), Date.now());
    const claim = await repositoryA.claimOrphanCancellation(owner.lease, owner.authorization, exchangeOrderId, Date.now());
    if (claim.kind !== 'CLAIMED') throw new Error('expected claim');
    // Arm succeeds — the wire call MAY be about to leave this process —
    // then the process dies before any provider result is persisted.
    const armed = await repositoryA.armOrphanCancelWire(owner.lease, owner.authorization, exchangeOrderId, claim.record.cancelGeneration);
    expect(armed.cancelWireArmed).toBe(true);

    const port = new FakeOrphanCancellation({ kind: 'CANCELLED' });
    const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId })] }));
    const restart = buildService(connectionB, {
      evidence, accountId, epoch: 'runtime-epoch-restart', orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId,
    });
    const outcome = await restart.service.reconcileAccount(accountId);

    // No automatic resend: the crash-recovery path resolves an ARMED claim to
    // CANCEL_AMBIGUOUS through the exact same durable path an unestablished
    // live outcome uses, never by calling the gateway again.
    expect(port.attempts).toHaveLength(0);
    const after = await connectionA.liveOrphanVenueOrder.findUnique({
      where: { accountId_exchangeOrderId: { accountId, exchangeOrderId } },
    });
    expect(after?.cancelState).toBe('CANCEL_AMBIGUOUS');
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
  });

  it('[B4-5] stale generation race: N claims, N+1 becomes current, N attempts to arm and is rejected with zero wire calls', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const exchangeOrderId = `stranger-${accountId}`;
    const repositoryA = new PrismaLiveReconciliationRepository(connectionA);
    const n = await repositoryA.claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now());
    if (n.kind !== 'CLAIMED') throw new Error('expected owner');
    await repositoryA.recordOrphanOrder(n.lease, venueOrder({ exchangeOrderId }), Date.now());
    const claim = await repositoryA.claimOrphanCancellation(n.lease, n.authorization, exchangeOrderId, Date.now());
    if (claim.kind !== 'CLAIMED') throw new Error('expected claim');

    // N+1 supersedes N before N can arm.
    await new PrismaLiveReconciliationRepository(connectionB).claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now() + 1);

    await expect(repositoryA.armOrphanCancelWire(n.lease, n.authorization, exchangeOrderId, claim.record.cancelGeneration))
      .rejects.toThrow(/STALE_GENERATION/);
    const after = await repositoryA.loadOrphanOrders(accountId);
    expect(after[0]?.cancelWireArmed).toBe(false);
    expect(after[0]?.cancelState).toBe('CANCEL_CLAIMED');
  });
});

describe('P18-DB Wave B4 §F18-27 a venue order appearing after the final REST read is invisible to reconciliation, and the barrier refuses regardless (real MySQL)', () => {
  it('[B4-6] a clean run reaches HEALTHY exactly as it would with no race at all, and the barrier still refuses live-mutation authorization', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const provider = new SequencedEvidenceProvider({
      orders: [[], []],
      ordersProvenance: [provenance({ source: 'COINDCX_FUTURES_ORDERS' })],
      positions: [[], []],
      positionsProvenance: [provenance({ source: 'COINDCX_FUTURES_POSITIONS', localReadStartedAtMs: 2_000, localReadEndedAtMs: 2_100 })],
    });
    const { service, reconciliation, runtimeIdentity } = buildService(connectionA, { evidenceProvider: provider, accountId, maxSnapshotAttempts: 3 });

    const outcome = await service.reconcileAccount(accountId);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');

    // Honest Level-2 status; still no live-mutation authorization, over a
    // real DB-backed authorization mint.
    await expect(requireCurrentReconciliation(reconciliation, accountId, runtimeIdentity, 'CREATE'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
    await expect(healthyAuthorizationForTest(reconciliation, accountId, runtimeIdentity)).resolves.toBeDefined();
  });
});

describe('P18-DB Wave B5 §F18-28 a sampled-HEALTHY account cannot be authorized by forging the continuity capability (real MySQL)', () => {
  it('[B5-2] a genuinely fenced, real-DB-minted HEALTHY authorization is still refused no matter what a caller attempts to pass as a 5th argument', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const provider = new SequencedEvidenceProvider({
      orders: [[], []],
      ordersProvenance: [provenance({ source: 'COINDCX_FUTURES_ORDERS' })],
      positions: [[], []],
      positionsProvenance: [provenance({ source: 'COINDCX_FUTURES_POSITIONS', localReadStartedAtMs: 2_000, localReadEndedAtMs: 2_100 })],
    });
    const { service, reconciliation, runtimeIdentity } = buildService(connectionA, { evidenceProvider: provider, accountId, maxSnapshotAttempts: 3 });

    const outcome = await service.reconcileAccount(accountId);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');

    // `requireCurrentReconciliation` has exactly 4 parameters — there is no
    // well-typed way for a caller to influence the continuity decision at
    // all. This proves it holds even against a caller willing to fight the
    // compiler (`as never`) and reach past the type system directly, against
    // a REAL database-minted, genuinely fenced HEALTHY authorization (not a
    // fake repository stub, unlike the equivalent unit-level forgery matrix
    // in `evidence-and-barrier.test.ts`).
    const call = requireCurrentReconciliation as unknown as (
      repository: unknown, accountId: unknown, runtimeIdentity: unknown, mutation: unknown, forged?: unknown,
    ) => Promise<unknown>;
    const forgeryAttempts: readonly unknown[] = [
      'ACCOUNT_CONTINUITY_PROVEN',
      { kind: 'ACCOUNT_CONTINUITY_PROVEN' },
      Object.freeze({ kind: 'ACCOUNT_CONTINUITY_PROVEN', accountId }),
      true,
      null,
    ];
    for (const forged of forgeryAttempts) {
      await expect(call(reconciliation, accountId, runtimeIdentity, 'CREATE', forged))
        .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
    }
    // The genuine authorization still exists underneath — proving the refusal
    // above is the continuity gate specifically, not some other fencing
    // failure that would refuse regardless of what this test is trying to
    // isolate.
    await expect(healthyAuthorizationForTest(reconciliation, accountId, runtimeIdentity)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// [Wave C3 / F18-12] `live_reconciliation_run.finding_count` is the TOTAL
// number of durable findings the run's completion proof covers, and
// `blocking_finding_count` is the blocking subset. The two are never
// conflated: a non-blocking finding (VERIFIED_MATCH / SAFE_AUTHORITATIVE_ADVANCE
// / LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE) counts toward the total and
// never toward the blocking count or the account's blocking state.
// ---------------------------------------------------------------------------

const RUN_STATUS_FOR_STATE: Readonly<Record<string, string>> = {
  HEALTHY: 'COMPLETED_HEALTHY',
  UNHEALTHY: 'COMPLETED_UNHEALTHY',
  MANUAL_REVIEW_REQUIRED: 'COMPLETED_MANUAL_REVIEW',
};

/**
 * The durable accounting of the account's CURRENT run, read straight from
 * MySQL: run counters, the finding rows they must describe, and the state row.
 * Asserts the run row and the state row agree with the finding rows.
 */
async function currentRunAccounting(client: PrismaClient, accountId: string) {
  const state = await client.liveReconciliationState.findUniqueOrThrow({ where: { accountId } });
  const run = await client.liveReconciliationRun.findUniqueOrThrow({ where: { runId: state.currentRunId! } });
  const rows = await client.liveReconciliationFinding.findMany({
    where: { accountId, lastSeenGeneration: state.currentGeneration, resolvedAtMs: null },
  });
  const blockingRows = rows.filter((row) => row.blocking);
  expect(run.generation).toBe(state.currentGeneration);
  expect(run.status).toBe(RUN_STATUS_FOR_STATE[state.status]);
  expect(run.findingCount).toBe(rows.length);
  expect(run.blockingFindingCount).toBe(blockingRows.length);
  expect(state.blockingFindingCount).toBe(blockingRows.length);
  return { state, run, rows, blockingRows };
}

function filledOrderWithMatchingPosition(accountId: string, extraOrders: readonly ReturnType<typeof venueOrder>[] = []) {
  return forAccount(accountId, evidenceSet({
    orders: [filledVenueOrder('0.5', { exchangeOrderId: `venue-${accountId}` }), ...extraOrders],
    positions: [venuePosition({ signedQuantity: '0.5' })],
  }));
}

async function seedFilledOrder(accountId: string): Promise<LiveExecutionIntentRecord> {
  const intent = intentRecord(accountId);
  await seedOrder(connectionA, intent, {
    state: 'FILLED', exchangeOrderId: `venue-${accountId}`, cumulativeFilledQuantity: '0.5', averageFillPrice: '64000',
  });
  return intent;
}

describe('P18-DB Wave C3 §F18-12 finding_count is the total, blocking_finding_count the blocking subset (real MySQL)', () => {
  it('[C3-12a] 0 total / 0 blocking: a clean account records finding_count = 0', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { service } = buildService(connectionA, { evidence: forAccount(accountId, evidenceSet()) });
    const outcome = await service.reconcileAccount(accountId);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');

    const { run, state } = await currentRunAccounting(connectionA, accountId);
    expect(state.status).toBe('HEALTHY');
    expect(run.findingCount).toBe(0);
    expect(run.blockingFindingCount).toBe(0);
    expect(outcome.result.findings).toHaveLength(0);
  });

  it('[C3-12b] informational only: non-blocking findings count toward finding_count and never block', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await seedFilledOrder(accountId);
    const { service } = buildService(connectionA, { evidence: filledOrderWithMatchingPosition(accountId) });
    const outcome = await service.reconcileAccount(accountId);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');

    const { run, state, rows } = await currentRunAccounting(connectionA, accountId);
    expect(state.status).toBe('HEALTHY');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((row) => !row.blocking)).toBe(true);
    expect(run.findingCount).toBe(outcome.result.findings.length);
    expect(run.findingCount).toBeGreaterThanOrEqual(1);
    expect(run.blockingFindingCount).toBe(0);
    expect(outcome.result.blockingFindingCount).toBe(0);
  });

  it('[C3-12c] blocking only: finding_count equals the blocking count because every finding blocks', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId: `stranger-${accountId}` })] }));
    const { service } = buildService(connectionA, { evidence });
    const outcome = await service.reconcileAccount(accountId);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');

    const { run, state, rows } = await currentRunAccounting(connectionA, accountId);
    expect(state.status).not.toBe('HEALTHY');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((row) => row.blocking)).toBe(true);
    expect(run.findingCount).toBe(run.blockingFindingCount);
    expect(run.findingCount).toBe(outcome.result.findings.length);
    expect(run.blockingFindingCount).toBe(outcome.result.blockingFindingCount);
  });

  it('[C3-12d] mixed: finding_count is the TOTAL, strictly above the blocking count, and only blocking findings drive the state', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await seedFilledOrder(accountId);
    const evidence = filledOrderWithMatchingPosition(accountId, [venueOrder({ exchangeOrderId: `stranger-${accountId}` })]);
    const { service } = buildService(connectionA, { evidence });
    const outcome = await service.reconcileAccount(accountId);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');

    const { run, state, rows, blockingRows } = await currentRunAccounting(connectionA, accountId);
    const informational = rows.filter((row) => !row.blocking);
    expect(informational.length).toBeGreaterThanOrEqual(1);
    expect(blockingRows.length).toBeGreaterThanOrEqual(1);
    expect(run.findingCount).toBe(informational.length + blockingRows.length);
    expect(run.findingCount).toBeGreaterThan(run.blockingFindingCount);
    expect(run.findingCount).toBe(outcome.result.findings.length);
    expect(run.blockingFindingCount).toBe(outcome.result.blockingFindingCount);
    // The blocking state reflects only the blocking (orphan) findings.
    expect(state.status).toBe('UNHEALTHY');
    expect(state.healthyGeneration).toBeNull();
    expect(new Set(blockingRows.map((row) => row.category))).toEqual(new Set(['ORPHAN']));
  });

  it('[C3-12e] accounting is deterministic across identical reruns: same totals, no duplicate finding rows', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await seedFilledOrder(accountId);
    const evidence = filledOrderWithMatchingPosition(accountId, [venueOrder({ exchangeOrderId: `stranger-${accountId}` })]);
    const { service } = buildService(connectionA, { evidence });

    // Run 1 materializes the live position, so run 2 legitimately observes a
    // different fact about it (a durable position that matches, rather than a
    // provably reconstructable missing one) and mints that one new finding row.
    // From run 2 on, the facts are unchanged, so the accounting must be too.
    await service.reconcileAccount(accountId);
    const first = await currentRunAccounting(connectionA, accountId);
    await service.reconcileAccount(accountId);
    const second = await currentRunAccounting(connectionA, accountId);
    const rowsAfterSecond = await connectionA.liveReconciliationFinding.count({ where: { accountId } });
    await service.reconcileAccount(accountId);
    const third = await currentRunAccounting(connectionA, accountId);

    expect(second.run.generation).toBe(first.run.generation + 1);
    expect(third.run.generation).toBe(second.run.generation + 1);
    for (const run of [second.run, third.run]) {
      expect(run.findingCount).toBe(first.run.findingCount);
      expect(run.blockingFindingCount).toBe(first.run.blockingFindingCount);
    }
    expect(third.rows.map((row) => row.findingId).sort()).toEqual(second.rows.map((row) => row.findingId).sort());
    expect(await connectionA.liveReconciliationFinding.count({ where: { accountId } })).toBe(rowsAfterSecond);
  });
});

// ---------------------------------------------------------------------------
// [Wave C3 / F18-11] Adversarial real-MySQL gaps. Each test proves an
// invariant the earlier suite proved only at a narrower level: [1] races
// `claimGeneration` alone, [2] drives a stale lease by hand, and [C1-3]/[C1-4]
// cover cross-account resolution and resolution-versus-resolution. These race
// COMPLETE reconciliation runs over two independent connections.
// ---------------------------------------------------------------------------

/** A losing concurrent actor may be fenced out or rolled back; it may never succeed silently. */
const ACCEPTABLE_LOSER = /LIVE_RECONCILIATION_STALE_GENERATION|LIVE_RECONCILIATION_REQUIRED|deadlock|write conflict|P2034/i;

type ReconcileOutcome = Awaited<ReturnType<LiveReconciliationService['reconcileAccount']>>;

function settledOutcomes(label: string, results: readonly PromiseSettledResult<ReconcileOutcome>[]): { readonly completed: number } {
  console.log(label, results.map((result) => (result.status === 'fulfilled' ? result.value.kind : String((result.reason as Error).message).slice(0, 80))));
  let completed = 0;
  for (const result of results) {
    if (result.status === 'rejected') {
      expect(String((result.reason as Error).message)).toMatch(ACCEPTABLE_LOSER);
    } else {
      expect(['COMPLETED', 'NOT_OWNER']).toContain(result.value.kind);
      if (result.value.kind === 'COMPLETED') completed += 1;
    }
  }
  return { completed };
}

/** No generation is owned twice, at most one run is RUNNING, and the state row points at the newest generation. */
async function expectSingleAuthoritativeHistory(client: PrismaClient, accountId: string): Promise<void> {
  const runs = await client.liveReconciliationRun.findMany({ where: { accountId } });
  const state = await client.liveReconciliationState.findUniqueOrThrow({ where: { accountId } });
  expect(new Set(runs.map((run) => run.generation)).size).toBe(runs.length);
  expect(runs.filter((run) => run.status === 'RUNNING').length).toBeLessThanOrEqual(1);
  expect(state.currentGeneration).toBe(Math.max(...runs.map((run) => run.generation)));
  expect(runs.find((run) => run.runId === state.currentRunId)?.generation).toBe(state.currentGeneration);
  // No stale writer ever stamped HEALTHY for a generation other than the current one.
  expect(state.healthyGeneration === null || state.healthyGeneration === state.currentGeneration).toBe(true);
}

function orphanKey(accountId: string, exchangeOrderId: string) {
  return { where: { accountId_exchangeOrderId: { accountId, exchangeOrderId } } };
}

describe('P18-DB Wave C3 §F18-11 concurrent full reconciliation runs (real MySQL, two connections)', () => {
  it('[C3-11a] two complete runs racing on one account with orphan cleanup enabled: one authoritative history, at most one wire cancel, never resent', async () => {
    if (skip()) return;
    for (let round = 0; round < 3; round += 1) {
      const accountId = freshAccount();
      const exchangeOrderId = `stranger-${accountId}`;
      const port = new FakeOrphanCancellation({ kind: 'CANCELLED' });
      const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId })] }));
      const options = { evidence, orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId };

      const { completed } = settledOutcomes('P18_C3_11A_RACE_EVIDENCE', await Promise.allSettled([
        buildService(connectionA, options).service.reconcileAccount(accountId),
        buildService(connectionB, options).service.reconcileAccount(accountId),
      ]));
      expect(completed).toBeGreaterThanOrEqual(1);
      expect(port.attempts.length).toBeLessThanOrEqual(1);
      await expectSingleAuthoritativeHistory(connectionA, accountId);

      // A fresh process converges whatever interleaving happened, and never
      // sends a second cancel for the same orphan.
      const converged = await buildService(connectionA, options).service.reconcileAccount(accountId);
      if (converged.kind !== 'COMPLETED') throw new Error('expected the converging run to complete');
      expect(port.attempts.length).toBeLessThanOrEqual(1);
      const orphan = await connectionA.liveOrphanVenueOrder.findUniqueOrThrow(orphanKey(accountId, exchangeOrderId));
      expect(orphan.cancelState).not.toBe('CANCEL_CLAIMED');
      if (port.attempts.length === 1) {
        // Sent once: acknowledged, or sticky-ambiguous if the sender was fenced
        // before it could persist the response.
        expect(['CANCEL_ACKNOWLEDGED', 'CANCEL_AMBIGUOUS']).toContain(orphan.cancelState);
      }
      expect(converged.result.status).not.toBe('HEALTHY');
      if (orphan.cancelState === 'CANCEL_AMBIGUOUS') expect(converged.result.status).toBe('MANUAL_REVIEW_REQUIRED');
      await expectSingleAuthoritativeHistory(connectionA, accountId);
      await currentRunAccounting(connectionA, accountId);
    }
  });

  it('[C3-11b] two complete runs racing to apply the same authoritative fill advance record exactly one durable economic event', async () => {
    if (skip()) return;
    for (let round = 0; round < 3; round += 1) {
      const accountId = freshAccount();
      const intent = intentRecord(accountId);
      await seedOrder(connectionA, intent, { state: 'ACKNOWLEDGED', exchangeOrderId: `venue-${accountId}` });
      const evidence = forAccount(accountId, evidenceSet({
        orders: [filledVenueOrder('0.2', { exchangeOrderId: `venue-${accountId}` })],
        positions: [venuePosition({ signedQuantity: '0.2' })],
      }));

      const { completed } = settledOutcomes('P18_C3_11B_RACE_EVIDENCE', await Promise.allSettled([
        buildService(connectionA, { evidence }).service.reconcileAccount(accountId),
        buildService(connectionB, { evidence }).service.reconcileAccount(accountId),
      ]));
      expect(completed).toBeGreaterThanOrEqual(1);
      await expectSingleAuthoritativeHistory(connectionA, accountId);

      const afterRace = await connectionA.liveOrder.findUniqueOrThrow({ where: { intentId: intent.intentId } });
      expect(afterRace.state).toBe('PARTIALLY_FILLED');
      expectExactDecimal(afterRace.cumulativeFilledQuantity, '0.2');
      expect(await connectionA.liveOrderEvent.count({ where: { intentId: intent.intentId } })).toBe(1);

      // A later run changes no economics.
      await buildService(connectionB, { evidence }).service.reconcileAccount(accountId);
      const afterRerun = await connectionA.liveOrder.findUniqueOrThrow({ where: { intentId: intent.intentId } });
      expectExactDecimal(afterRerun.cumulativeFilledQuantity, '0.2');
      expect(afterRerun.revision).toBe(afterRace.revision);
      expect(await connectionA.liveOrderEvent.count({ where: { intentId: intent.intentId } })).toBe(1);
      expect(await connectionA.livePositionOwnershipShare.count({ where: { accountId, pair: PAIR } })).toBeLessThanOrEqual(1);
    }
  });
});

describe('P18-DB Wave C3 §F18-11 cross-account isolation under concurrency (real MySQL)', () => {
  it('[C3-11c] two accounts reconciled concurrently with an IDENTICAL orphan exchange id stay fully independent', async () => {
    if (skip()) return;
    // [F18-44] This case first reproduced the cross-account deadlock in
    // `claimGeneration` (MySQL chose one account's first claim as the deadlock
    // victim and the caller received P2034). Wave C3.1 retries that whole claim
    // transaction, so both accounts must now complete, every round.
    for (let round = 0; round < 5; round += 1) {
      const accountA = freshAccount();
      const accountB = freshAccount();
      const shared = `stranger-shared-c3-${round}`;
      await seedFilledOrder(accountA);
      const evidenceA = filledOrderWithMatchingPosition(accountA, [venueOrder({ exchangeOrderId: shared })]);
      const evidenceB = forAccount(accountB, evidenceSet({ orders: [venueOrder({ exchangeOrderId: shared })] }));
      const portA = new FakeOrphanCancellation({ kind: 'CANCELLED' });
      const portB = new FakeOrphanCancellation({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });

      const settled = await Promise.allSettled([
        buildService(connectionA, { evidence: evidenceA, orphanCancellation: portA, orphanEnabled: true, orphanAccount: accountA }).service.reconcileAccount(accountA),
        buildService(connectionB, { evidence: evidenceB, orphanCancellation: portB, orphanEnabled: true, orphanAccount: accountB }).service.reconcileAccount(accountB),
      ]);
      console.log('P18_C3_11C_ISOLATION_EVIDENCE', settled.map((result) => (result.status === 'fulfilled' ? result.value.kind : String((result.reason as Error).message).replace(/\s+/g, ' ').slice(-90))));
      for (const result of settled) {
        if (result.status === 'rejected') throw result.reason as Error;
        expect(result.value.kind).toBe('COMPLETED');
      }

      expect(portA.attempts).toEqual([{ exchangeOrderId: shared, pair: PAIR }]);
      expect(portB.attempts).toEqual([{ exchangeOrderId: shared, pair: PAIR }]);
      expect((await connectionA.liveOrphanVenueOrder.findUniqueOrThrow(orphanKey(accountA, shared))).cancelState).toBe('CANCEL_ACKNOWLEDGED');
      expect((await connectionA.liveOrphanVenueOrder.findUniqueOrThrow(orphanKey(accountB, shared))).cancelState).toBe('CANCEL_AMBIGUOUS');

      // Each account's generation, state, and finding accounting is its own.
      const accountingA = await currentRunAccounting(connectionA, accountA);
      const accountingB = await currentRunAccounting(connectionA, accountB);
      expect(accountingA.state.currentGeneration).toBe(1);
      expect(accountingB.state.currentGeneration).toBe(1);
      expect(await connectionA.liveReconciliationRun.count({ where: { accountId: { in: [accountA, accountB] } } })).toBe(2);
      expect(accountingA.rows.every((row) => row.accountId === accountA)).toBe(true);
      expect(accountingB.rows.every((row) => row.accountId === accountB)).toBe(true);
      expect(accountingB.state.status).toBe('MANUAL_REVIEW_REQUIRED');
      expect(accountingA.state.status).not.toBe('MANUAL_REVIEW_REQUIRED');
      expect(await connectionA.livePosition.count({ where: { accountId: accountB } })).toBe(0);
      expect(await connectionA.livePositionOwnershipShare.count({ where: { accountId: accountB } })).toBe(0);
    }
  });

  it('[C3-11d] a genuine lease and authorization for account A can never claim, arm, or complete account B\'s orphan', async () => {
    if (skip()) return;
    const accountA = freshAccount();
    const accountB = freshAccount();
    const onlyInB = `stranger-only-${accountB}`;
    await buildService(connectionB, { evidence: forAccount(accountB, evidenceSet({ orders: [venueOrder({ exchangeOrderId: onlyInB })] })) })
      .service.reconcileAccount(accountB);
    const before = await connectionA.liveOrphanVenueOrder.findUniqueOrThrow(orphanKey(accountB, onlyInB));
    expect(before.cancelState).toBe('NONE');

    const repoA = new PrismaLiveReconciliationRepository(connectionA);
    const claimA = await repoA.claimGeneration(accountA, newLiveRuntimeIdentity(), Date.now());
    if (claimA.kind !== 'CLAIMED') throw new Error('expected A to claim a generation');
    await expect(repoA.claimOrphanCancellation(claimA.lease, claimA.authorization, onlyInB, Date.now())).rejects.toThrow(/LIVE_PERSISTENCE_FAULT/);
    await expect(repoA.armOrphanCancelWire(claimA.lease, claimA.authorization, onlyInB, 1)).rejects.toThrow();
    await expect(repoA.completeOrphanCancellation(claimA.lease, claimA.authorization, onlyInB, 1, 'CANCEL_ACKNOWLEDGED', null)).rejects.toThrow();

    // A's authorization presented alongside B's own genuine lease is refused too.
    const repoB = new PrismaLiveReconciliationRepository(connectionB);
    const claimB = await repoB.claimGeneration(accountB, newLiveRuntimeIdentity(), Date.now());
    if (claimB.kind !== 'CLAIMED') throw new Error('expected B to claim a generation');
    await expect(repoB.claimOrphanCancellation(claimB.lease, claimA.authorization, onlyInB, Date.now())).rejects.toThrow(/LIVE_RECONCILIATION_REQUIRED/);

    const after = await connectionA.liveOrphanVenueOrder.findUniqueOrThrow(orphanKey(accountB, onlyInB));
    expect(after.cancelState).toBe('NONE');
    expect(after.revision).toBe(before.revision);
    expect(after.cancelGeneration).toBe(before.cancelGeneration);
    expect(after.cancelWireArmed).toBe(false);
    expect(await connectionA.liveOrphanVenueOrder.count({ where: { accountId: accountA } })).toBe(0);
  });
});

describe('P18-DB Wave C3 §F18-11 operator resolution racing a reconciliation run (real MySQL)', () => {
  it('[C3-11e] resolution and reconciliation committed concurrently: zero new wire calls, one consistent outcome, never reverted, never HEALTHY', async () => {
    if (skip()) return;
    for (let round = 0; round < 3; round += 1) {
      const accountId = freshAccount();
      const exchangeOrderId = `stranger-${accountId}`;
      const port = new FakeOrphanCancellation({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
      const evidence = forAccount(accountId, evidenceSet({ orders: [venueOrder({ exchangeOrderId })] }));
      const options = { evidence, orphanCancellation: port, orphanEnabled: true, orphanAccount: accountId };
      await buildService(connectionA, options).service.reconcileAccount(accountId);
      const ambiguous = await connectionA.liveOrphanVenueOrder.findUniqueOrThrow(orphanKey(accountId, exchangeOrderId));
      expect(ambiguous.cancelState).toBe('CANCEL_AMBIGUOUS');
      expect(port.attempts).toHaveLength(1);

      const request = mintOrphanAmbiguityResolutionRequest({
        accountId, exchangeOrderId, expectedRevision: ambiguous.revision,
        outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:c3',
      });
      const [resolution, reconciliation] = await Promise.allSettled([
        new PrismaLiveReconciliationRepository(connectionA).resolveOrphanCancelAmbiguity(request, Date.now()),
        buildService(connectionB, options).service.reconcileAccount(accountId),
      ]);

      console.log('P18_C3_11E_RACE_EVIDENCE', [resolution, reconciliation].map((result) => (result.status === 'fulfilled' ? ('kind' in result.value ? result.value.kind : 'RESOLVED') : String((result.reason as Error).message).slice(0, 80))));
      if (resolution.status === 'rejected') {
        expect(String((resolution.reason as Error).message)).toMatch(/LIVE_ORPHAN_RESOLUTION_STALE_REVISION|deadlock|write conflict|P2034/i);
      }
      if (reconciliation.status === 'rejected') {
        expect(String((reconciliation.reason as Error).message)).toMatch(ACCEPTABLE_LOSER);
      } else if (reconciliation.value.kind === 'COMPLETED') {
        expect(reconciliation.value.result.status).not.toBe('HEALTHY');
      }
      expect(port.attempts).toHaveLength(1);

      const orphan = await connectionA.liveOrphanVenueOrder.findUniqueOrThrow(orphanKey(accountId, exchangeOrderId));
      const audits = await connectionA.liveOrphanCancelResolution.count({ where: { accountId, exchangeOrderId } });
      expect(['CANCEL_AMBIGUOUS', 'CANCEL_AMBIGUOUS_RESOLVED']).toContain(orphan.cancelState);
      expect(audits).toBe(orphan.cancelState === 'CANCEL_AMBIGUOUS_RESOLVED' ? 1 : 0);
      expect(audits).toBe(resolution.status === 'fulfilled' ? 1 : 0);

      // A later run never reverts a committed resolution and never resends.
      const later = await buildService(connectionA, options).service.reconcileAccount(accountId);
      if (later.kind !== 'COMPLETED') throw new Error('expected the later run to complete');
      const finalOrphan = await connectionA.liveOrphanVenueOrder.findUniqueOrThrow(orphanKey(accountId, exchangeOrderId));
      expect(finalOrphan.cancelState).toBe(orphan.cancelState);
      expect(port.attempts).toHaveLength(1);
      expect(later.result.status).toBe('MANUAL_REVIEW_REQUIRED');
      const codes = later.result.findings.filter((f) => f.subject.exchangeOrderId === exchangeOrderId).map((f) => f.code);
      expect(codes).toEqual([
        orphan.cancelState === 'CANCEL_AMBIGUOUS_RESOLVED' ? 'RECON_ORPHAN_REAPPEARED_AFTER_RESOLUTION' : 'RECON_ORPHAN_CANCEL_AMBIGUOUS',
      ]);
      await expectSingleAuthoritativeHistory(connectionA, accountId);
    }
  });
});

// ---------------------------------------------------------------------------
// [Wave C3.1 / F18-44] Bounded retry of the whole `claimGeneration`
// transaction on Prisma P2034 (MySQL deadlock victim). [C3-11c] above covers
// complete runs; these race the claim directly, where the deadlock occurs.
// ---------------------------------------------------------------------------

/** Counts `$transaction` calls on both connections for the duration of `body`, then restores them. */
async function countingTransactions<T>(body: () => Promise<T>): Promise<{ readonly result: T; readonly transactions: number }> {
  let transactions = 0;
  const originals = [connectionA, connectionB].map((client) => {
    const original = client.$transaction.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { $transaction: unknown }).$transaction = (...args: unknown[]) => {
      transactions += 1;
      return original(...args);
    };
    return { client, original };
  });
  try {
    return { result: await body(), transactions };
  } finally {
    for (const { client, original } of originals) (client as unknown as { $transaction: unknown }).$transaction = original;
  }
}

describe('P18-DB Wave C3.1 §F18-44 cross-account first-claim deadlocks are retried, never surfaced (real MySQL)', () => {
  it('[C3.1-1] 20 pairs of DIFFERENT new accounts claiming concurrently all obtain their own generation 1, with no partial rows', async () => {
    if (skip()) return;
    const repoA = new PrismaLiveReconciliationRepository(connectionA);
    const repoB = new PrismaLiveReconciliationRepository(connectionB);
    const accounts: string[] = [];
    const { result: outcomes, transactions } = await countingTransactions(async () => {
      const all: Awaited<ReturnType<PrismaLiveReconciliationRepository['claimGeneration']>>[] = [];
      for (let pair = 0; pair < 20; pair += 1) {
        const accountA = freshAccount();
        const accountB = freshAccount();
        accounts.push(accountA, accountB);
        const settled = await Promise.allSettled([
          repoA.claimGeneration(accountA, newLiveRuntimeIdentity(), Date.now()),
          repoB.claimGeneration(accountB, newLiveRuntimeIdentity(), Date.now()),
        ]);
        for (const result of settled) {
          if (result.status === 'rejected') throw result.reason as Error;
          all.push(result.value);
        }
      }
      return all;
    });
    // Every claim opens its own transaction; each extra one is a retry of a
    // deadlock victim in a FRESH transaction.
    console.log('P18_C3_1_RETRY_EVIDENCE', { claims: outcomes.length, transactions, retries: transactions - outcomes.length });
    expect(transactions).toBeGreaterThanOrEqual(outcomes.length);
    expect(transactions).toBeLessThanOrEqual(outcomes.length * 3);

    for (const [index, outcome] of outcomes.entries()) {
      expect(outcome.kind).toBe('CLAIMED');
      if (outcome.kind !== 'CLAIMED') continue;
      expect(outcome.lease.accountId).toBe(accounts[index]);
      expect(outcome.lease.generation).toBe(1);
    }
    const runs = await connectionA.liveReconciliationRun.findMany({ where: { accountId: { in: accounts } } });
    expect(runs).toHaveLength(accounts.length);
    expect(new Set(runs.map((run) => run.accountId)).size).toBe(accounts.length);
    expect(runs.every((run) => run.generation === 1 && run.status === 'RUNNING')).toBe(true);
    for (const accountId of accounts) {
      const state = await connectionA.liveReconciliationState.findUniqueOrThrow({ where: { accountId } });
      expect(state.currentGeneration).toBe(1);
      expect(runs.find((run) => run.accountId === accountId)?.runId).toBe(state.currentRunId);
    }
    // A claim writes no finding or orphan row, retried or not.
    expect(await connectionA.liveReconciliationFinding.count({ where: { accountId: { in: accounts } } })).toBe(0);
    expect(await connectionA.liveOrphanVenueOrder.count({ where: { accountId: { in: accounts } } })).toBe(0);
  });

  it('[C3.1-2] same-account races keep Wave A fencing: never two owners of one generation, and the loser stays fenced', async () => {
    if (skip()) return;
    for (let round = 0; round < 10; round += 1) {
      const accountId = freshAccount();
      const a = new PrismaLiveReconciliationRepository(connectionA);
      const b = new PrismaLiveReconciliationRepository(connectionB);
      const settled = await Promise.allSettled([
        a.claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now()),
        b.claimGeneration(accountId, newLiveRuntimeIdentity(), Date.now()),
      ]);
      const outcomes = settled.map((result) => {
        if (result.status === 'rejected') throw result.reason as Error;
        return result.value;
      });
      const claimed = outcomes.filter((outcome) => outcome.kind === 'CLAIMED');
      const generations = claimed.map((outcome) => (outcome.kind === 'CLAIMED' ? outcome.lease.generation : -1));
      expect(claimed.length).toBeGreaterThanOrEqual(1);
      expect(new Set(generations).size).toBe(generations.length);

      const state = await connectionA.liveReconciliationState.findUniqueOrThrow({ where: { accountId } });
      expect(state.currentGeneration).toBe(Math.max(...generations));
      expect(await connectionA.liveReconciliationRun.count({ where: { accountId } })).toBe(claimed.length);
      // Whoever did not end up current (a LOST outcome, or the older of two
      // serialized claims) can commit nothing.
      for (const outcome of claimed) {
        if (outcome.kind !== 'CLAIMED' || outcome.lease.generation === state.currentGeneration) continue;
        await expect(a.persistFindings(outcome.lease, [], Date.now())).rejects.toThrow(/LIVE_RECONCILIATION_STALE_GENERATION/);
      }
      for (const outcome of outcomes) {
        if (outcome.kind === 'LOST') expect(outcome.state.currentGeneration).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
