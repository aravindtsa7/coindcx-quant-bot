import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { URL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeClock } from '../../../src/core/time/clock';
import { PrismaPracticalSafetyRepository } from '../../../src/execution/live/practical-persistence/repository';
import { providerAccountFingerprint } from '../../../src/execution/live/reconciliation/account-identity';
import { sha256CanonicalJson } from '../../../src/risk';
import { PracticalShadowCampaignRunner, abortPracticalShadowCampaign } from '../../../src/execution/live/practical-shadow/campaign';
import { collectPracticalShadowEvidence, type PracticalShadowSources } from '../../../src/execution/live/practical-shadow/collector';
import { resolvePracticalShadowConfig } from '../../../src/execution/live/practical-shadow/config';
import {
  canonicalPracticalShadowEvidenceJson,
  parsePracticalShadowEvidence,
  practicalShadowEvidenceDigest,
  type PracticalShadowEvidence,
} from '../../../src/execution/live/practical-shadow/evidence';
import { buildPracticalShadowCompletion } from '../../../src/execution/live/practical-shadow/integrity';
import type { PracticalShadowEvaluationResult, PracticalShadowPaperDecisionRecord } from '../../../src/execution/live/practical-shadow/ports';
import type { PracticalShadowSourceProbe, PracticalShadowSourceProvenance } from '../../../src/execution/live/practical-shadow/provenance';
import { replayPracticalShadowSnapshot } from '../../../src/execution/live/practical-shadow/replay';
import { PrismaPracticalShadowStore } from '../../../src/execution/live/practical-shadow/repository';
import { runPracticalShadowCli } from '../../../src/integration/coindcx/live/practical-shadow-runtime';
import { CoinDcxReconciliationEvidenceAdapter } from '../../../src/integration/coindcx/live/reconciliation-evidence-adapter';
import { CoinDcxPrivateAccountStream } from '../../../src/integration/coindcx/websocket/private-stream';
import { createTestStreamContext } from '../../unit/coindcx/ws/test-helpers';
import { EPOCH, EPOCH_B, FINGERPRINT, OTHER_FINGERPRINT, FakePrivateStream, FakeReconciliation, FakeScheduler, FakeVenue, T0 } from '../../unit/execution/live/practical-recovery/support';
import { COMMIT_A, COMMIT_B, DIRTY_SOURCE, TEST_PROVIDER, TIER_B_ELIGIBLE, UNAVAILABLE_SOURCE, cleanSource } from '../../unit/execution/live/practical-shadow/support';

// [P18B-CHECKPOINT-C-DB] Real MySQL proof of the shadow calibration store and
// campaign lifecycle, with two INDEPENDENT connections.
//
// NOTHING HERE TOUCHES COINDCX. The venue is a read-only fake (or the real
// read-only evidence adapter over a fake read client), the private stream is
// a fake (or the real stream over the existing fake socket), and time is a
// fake clock. The Stage 1B1 practical account is only ever READ.
//
// ACCEPTANCE: by default this suite soft-skips when no local MySQL is
// reachable. `npm run test:integration:live-practical-shadow` sets
// REQUIRE_LIVE_PRACTICAL_SHADOW_DB_INTEGRATION=1, under which `beforeAll`
// throws instead, so a false green is impossible.

const REPO_ROOT = path.resolve(__dirname, '../../..');
const STRICT = process.env['REQUIRE_LIVE_PRACTICAL_SHADOW_DB_INTEGRATION'] === '1';
const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = `p18b_shadow_test_${randomBytes(6).toString('hex')}`;

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
    if (STRICT) throw new Error('[P18B-SHADOW-DB] REQUIRE_LIVE_PRACTICAL_SHADOW_DB_INTEGRATION=1 but no DATABASE_URL is configured.');
    return;
  }
  try {
    execFileSync('mysql', mysqlArgs(['-e', `CREATE DATABASE \`${SHADOW_DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: REPO_ROOT, stdio: 'pipe', timeout: 120_000, shell: true, env: { ...process.env, DATABASE_URL: shadowDatabaseUrl() },
    });
    connectionA = new PrismaClient({ datasources: { db: { url: shadowDatabaseUrl() } } });
    connectionB = new PrismaClient({ datasources: { db: { url: shadowDatabaseUrl() } } });
    await connectionA.$queryRawUnsafe('SELECT 1');
    await connectionB.$queryRawUnsafe('SELECT 1');
    dbAvailable = true;
  } catch (error) {
    dbAvailable = false;
    if (STRICT) throw new Error(`[P18B-SHADOW-DB] strict mode could not provision a disposable MySQL shadow database: ${(error as Error).message}`);
  }
}, 180_000);

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
  if (STRICT) throw new Error('[P18B-SHADOW-DB] strict mode reached a test body with no database connection.');
  console.warn('P18B shadow DB suite skipped: no reachable disposable MySQL. Set REQUIRE_LIVE_PRACTICAL_SHADOW_DB_INTEGRATION=1 to make this hard.');
  return true;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let accountCounter = 0;
function freshAccount(): string {
  accountCounter += 1;
  return `p18b-shd-${accountCounter}-${randomBytes(4).toString('hex')}`;
}

interface World {
  readonly accountId: string;
  readonly clock: FakeClock;
  readonly venue: FakeVenue;
  readonly stream: FakePrivateStream;
  readonly reconciliation: FakeReconciliation;
}

/** One account's read-only world, with its Stage 1B1 practical account initialized (then only READ by shadow). */
async function world(): Promise<World> {
  const accountId = freshAccount();
  const clock = new FakeClock(T0);
  const stream = new FakePrivateStream();
  stream.unprove(); // the REAL CoinDCX condition
  await new PrismaPracticalSafetyRepository(connectionA).initializeAccount({ accountId, runtimeEpoch: EPOCH, reconciliationGeneration: 0, nowMs: T0 });
  const reconciliation = new FakeReconciliation(accountId);
  reconciliation.completeHealthyRun(EPOCH);
  return { accountId, clock, venue: new FakeVenue(clock), stream, reconciliation };
}

function sourcesFor(w: World, connection: PrismaClient = connectionA): PracticalShadowSources {
  const practical = new PrismaPracticalSafetyRepository(connection);
  return {
    venue: w.venue,
    privateStream: w.stream,
    reconciliation: w.reconciliation,
    practicalAccount: { loadAccount: (accountId: string) => practical.loadAccount(accountId) },
    clock: w.clock,
    scheduler: new FakeScheduler(w.clock),
  };
}

function runnerFor(w: World, options: { readonly workerId: string; readonly connection?: PrismaClient; readonly cadenceMs?: number; readonly source?: PracticalShadowSourceProvenance; readonly sources?: PracticalShadowSources }) {
  const connection = options.connection ?? connectionA;
  let ids = 0;
  return new PracticalShadowCampaignRunner({
    store: new PrismaPracticalShadowStore(connection),
    sources: options.sources ?? sourcesFor(w, connection),
    config: resolvePracticalShadowConfig({ provider: TEST_PROVIDER, cadenceMs: options.cadenceMs ?? 60_000 }),
    accountId: w.accountId,
    expectedProviderAccountFingerprint: FINGERPRINT,
    runtimeEpoch: EPOCH,
    sourceProvenance: options.source ?? cleanSource(),
    tierB: TIER_B_ELIGIBLE,
    workerId: options.workerId,
    newId: () => `${options.workerId}-${randomBytes(3).toString('hex')}-${++ids}`,
  });
}

async function practicalRows(accountId: string) {
  return {
    state: await connectionA.livePracticalAccountState.findUnique({ where: { accountId } }),
    fence: await connectionA.livePracticalAccountFence.findUnique({ where: { accountId } }),
    certificates: await connectionA.livePracticalCertificate.count({ where: { accountId } }),
    leases: await connectionA.livePracticalMutationLease.count({ where: { accountId } }),
  };
}

async function evaluations(campaignId: string) {
  return connectionA.livePracticalShadowEvaluation.findMany({ where: { campaignId }, orderBy: { sequence: 'asc' } });
}

async function until(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** status/report/replay/abort never consult the source tree: a probe that fails the test if called. */
const NO_PROBE = (): PracticalShadowSourceProbe => {
  throw new Error('this command must not probe the source tree');
};

async function shadowRows(accountId: string) {
  const campaigns = await connectionA.livePracticalShadowCampaign.findMany({ where: { accountId }, orderBy: { campaignId: 'asc' } });
  const campaignIds = campaigns.map((row) => row.campaignId);
  return JSON.stringify({
    account: await connectionA.livePracticalShadowAccount.findUnique({ where: { accountId } }),
    campaigns,
    evaluations: await connectionA.livePracticalShadowEvaluation.findMany({ where: { campaignId: { in: campaignIds } }, orderBy: { evaluationId: 'asc' } }),
    paper: await connectionA.livePracticalShadowPaperDecision.findMany({ where: { campaignId: { in: campaignIds } }, orderBy: { paperDecisionId: 'asc' } }),
  }, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
}

async function cli(argv: readonly string[], env: Record<string, string>, options: { readonly probe?: () => PracticalShadowSourceProbe; readonly connection?: PrismaClient } = {}) {
  const lines: string[] = [];
  const code = await runPracticalShadowCli(argv, {
    env, io: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, prisma: options.connection ?? connectionA, sourceProbe: options.probe ?? NO_PROBE,
  });
  return { code, output: lines.join('\n') };
}

/** The genuine durable record (result + paper decisions) for a claimed evaluation, collected read-only from the world. */
async function genuineCompletion(
  w: World,
  campaignId: string,
  evaluationId: string,
  overrides: { readonly accountId?: string; readonly expectedProviderAccountFingerprint?: string; readonly evaluationId?: string } = {},
) {
  const config = resolvePracticalShadowConfig({ provider: TEST_PROVIDER, cadenceMs: 60_000 });
  const evidence = await collectPracticalShadowEvidence({
    sources: sourcesFor(w), config, accountId: w.accountId, expectedProviderAccountFingerprint: FINGERPRINT, runtimeEpoch: EPOCH,
    campaignId, evaluationId, tierB: TIER_B_ELIGIBLE, generationBaselineFor: () => null, ...overrides,
  });
  return buildPracticalShadowCompletion(evidence, config.paperIntents);
}

function paperId(): string {
  return `pd-${randomBytes(24).toString('hex')}`;
}

/** Placeholder result: only for the pre-transaction eligible-UNPROVEN refusal (it never reaches the integrity gate). */
function completedResult(overrides: Partial<PracticalShadowEvaluationResult> = {}): PracticalShadowEvaluationResult {
  return {
    startedAtMs: T0, endedAtMs: T0 + 1, reconciliationGeneration: 1, streamIncarnation: 1, streamReadiness: 'UNPROVEN', restStability: 'PASS', restFailure: null,
    authorityEligible: false, primaryBlocker: 'PRIVATE_STREAM_READINESS_UNPROVEN', blockers: ['PRIVATE_STREAM_READINESS_UNPROVEN'], evidenceSchemaVersion: 'P18B_SHADOW_EVIDENCE_V1',
    evidenceDigest: 'a'.repeat(64), evidenceJson: '{}', ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Campaign lifecycle over the real store
// ---------------------------------------------------------------------------

describe('P18B-CKPT-C-DB campaign lifecycle', () => {
  it('create -> evaluate (REAL-like UNPROVEN stream) -> stop: REST PASS persisted, authority NOT eligible, paper decisions all WOULD_BLOCK; Stage 1B1 rows untouched', async () => {
    if (skip()) return;
    const w = await world();
    const before = await practicalRows(w.accountId);
    const runner = runnerFor(w, { workerId: 'worker-a' });
    expect(await runner.open('START_NEW')).toMatchObject({ kind: 'STARTED' });
    const campaignId = runner.campaign!.campaignId;
    expect(await runner.runEvaluation()).toMatchObject({ kind: 'COMPLETED', sequence: 1, restStability: 'PASS', streamReadiness: 'UNPROVEN', authorityEligible: false, primaryBlocker: 'PRIVATE_STREAM_READINESS_UNPROVEN' });
    expect(await runner.runEvaluation()).toMatchObject({ kind: 'COMPLETED', sequence: 2 });
    const rows = await evaluations(campaignId);
    expect(rows.map((row) => [row.status, row.restStability, row.streamReadiness, row.authorityEligible, row.primaryBlocker])).toEqual([
      ['COMPLETED', 'PASS', 'UNPROVEN', false, 'PRIVATE_STREAM_READINESS_UNPROVEN'],
      ['COMPLETED', 'PASS', 'UNPROVEN', false, 'PRIVATE_STREAM_READINESS_UNPROVEN'],
    ]);
    const paper = await connectionA.livePracticalShadowPaperDecision.findMany({ where: { campaignId } });
    expect(paper).toHaveLength(12);
    expect(paper.every((row) => row.outcome === 'WOULD_BLOCK' && row.authorityPrerequisitesMet === false)).toBe(true);
    expect(await runner.stop('COMPLETED', 'TEST_DONE')).toBe(true);
    expect(await connectionA.livePracticalShadowCampaign.findUnique({ where: { campaignId } })).toMatchObject({ status: 'COMPLETED', endReason: 'TEST_DONE' });
    expect(await connectionA.livePracticalShadowAccount.findUnique({ where: { accountId: w.accountId } })).toMatchObject({ activeCampaignId: null });
    // Shadow never changes practical authority state.
    const after = await practicalRows(w.accountId);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ certificates: 0, leases: 0, state: { state: 'QUARANTINED' } });
  });

  it('CONCURRENT starts on two connections: exactly one ACTIVE campaign per account', async () => {
    if (skip()) return;
    const w = await world();
    const results = await Promise.all([
      runnerFor(w, { workerId: 'worker-a', connection: connectionA }).open('START_NEW'),
      runnerFor(w, { workerId: 'worker-b', connection: connectionB }).open('START_NEW'),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['REFUSED', 'STARTED']);
    expect(await connectionA.livePracticalShadowCampaign.count({ where: { accountId: w.accountId, status: 'ACTIVE' } })).toBe(1);
  });

  it('a stale configuration/software binding LOSES: the campaign is never silently resumed, and nothing changes', async () => {
    if (skip()) return;
    const w = await world();
    const a = runnerFor(w, { workerId: 'worker-a' });
    await a.open('START_NEW');
    const campaign = await connectionA.livePracticalShadowCampaign.findUniqueOrThrow({ where: { campaignId: a.campaign!.campaignId } });
    expect(await runnerFor(w, { workerId: 'worker-b', cadenceMs: 120_000 }).open('RESUME')).toMatchObject({ kind: 'REFUSED', reason: 'BINDING_MISMATCH', detail: ['configDigest'] });
    expect(await runnerFor(w, { workerId: 'worker-c', source: cleanSource(COMMIT_B) }).open('RESUME_OR_START')).toMatchObject({ kind: 'REFUSED', reason: 'BINDING_MISMATCH', detail: ['softwareVersion'] });
    expect(await connectionA.livePracticalShadowCampaign.findUniqueOrThrow({ where: { campaignId: campaign.campaignId } })).toMatchObject({ workerId: 'worker-a', revision: campaign.revision });
  });
});

// ---------------------------------------------------------------------------
// Crash / resume / concurrency
// ---------------------------------------------------------------------------

describe('P18B-CKPT-C-DB crash, resume, and concurrency', () => {
  it('CRASH mid-evaluation: the partial observation is never completed; a new process resumes the SAME campaign, aborts it, and continues; the stale worker loses', async () => {
    if (skip()) return;
    const w = await world();
    const deadSources = sourcesFor(w);
    const dead = runnerFor(w, { workerId: 'worker-a', sources: deadSources });
    await dead.open('START_NEW');
    const campaignId = dead.campaign!.campaignId;
    await dead.runEvaluation();
    (deadSources.scheduler as FakeScheduler).hold();
    const pending = dead.runEvaluation();
    await until(async () => (await evaluations(campaignId)).some((row) => row.status === 'CLAIMED'), 'the second evaluation to be claimed');
    await new Promise((resolve) => setTimeout(resolve, 30));

    const live = runnerFor(w, { workerId: 'worker-b', connection: connectionB });
    expect(await live.open('RESUME')).toMatchObject({ kind: 'RESUMED', abortedEvaluations: 1, campaign: { campaignId, workerId: 'worker-b' } });
    expect((await evaluations(campaignId)).map((row) => [row.sequence, row.status, row.abortReason, row.evidenceJson === null])).toEqual([
      [1, 'COMPLETED', null, false],
      [2, 'ABORTED', 'WORKER_REPLACED', true],
    ]);
    expect(await live.runEvaluation()).toMatchObject({ kind: 'COMPLETED', sequence: 3 });

    (deadSources.scheduler as FakeScheduler).release();
    expect(await pending).toEqual({ kind: 'NOT_COLLECTED', reason: 'STALE_WORKER' });
    // A second resume by the same worker is idempotent: nothing left to abort, nothing double-counted.
    expect(await runnerFor(w, { workerId: 'worker-b', connection: connectionB }).open('RESUME')).toMatchObject({ kind: 'RESUMED', abortedEvaluations: 0 });
    const rows = await evaluations(campaignId);
    expect(rows.filter((row) => row.status === 'COMPLETED')).toHaveLength(2);
    expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3]);
  });

  it('TWO WORKERS cannot complete the same evaluation twice (two connections racing); a different worker is stale', async () => {
    if (skip()) return;
    const w = await world();
    const a = runnerFor(w, { workerId: 'worker-a' });
    await a.open('START_NEW');
    const { a: storeA, b: storeB } = new ShadowStorePair();
    const claim = await storeA.claimEvaluation({ campaignId: a.campaign!.campaignId, workerId: 'worker-a', evaluationId: `eval-race-${randomBytes(3).toString('hex')}`, runtimeEpoch: EPOCH, nowMs: T0 });
    if (claim.kind !== 'CLAIMED') throw new Error('expected CLAIMED');
    const evaluationId = claim.evaluation.evaluationId;
    const { result, paperDecisions } = await genuineCompletion(w, a.campaign!.campaignId, evaluationId);
    const results = await Promise.all([
      storeA.completeEvaluation({ evaluationId, workerId: 'worker-a', result, paperDecisions, nowMs: T0 + 2 }),
      storeB.completeEvaluation({ evaluationId, workerId: 'worker-a', result, paperDecisions, nowMs: T0 + 2 }),
    ]);
    expect(results.map((entry) => (entry.kind === 'COMPLETED' ? 'COMPLETED' : entry.reason)).sort()).toEqual(['COMPLETED', 'NOT_CLAIMED']);
    expect(await storeB.completeEvaluation({ evaluationId, workerId: 'worker-z', result, paperDecisions, nowMs: T0 + 3 })).toEqual({ kind: 'REFUSED', reason: 'STALE_WORKER' });
    expect(await connectionA.livePracticalShadowEvaluation.count({ where: { evaluationId, status: 'COMPLETED' } })).toBe(1);
  });

  it('a paper decision REUSING another evaluation\'s id cannot create two records: refused before any write, and the evaluation stays CLAIMED', async () => {
    if (skip()) return;
    const w = await world();
    const a = runnerFor(w, { workerId: 'worker-a' });
    await a.open('START_NEW');
    await a.runEvaluation();
    const campaignId = a.campaign!.campaignId;
    const existing = await connectionA.livePracticalShadowPaperDecision.findFirstOrThrow({ where: { campaignId } });
    const store = new PrismaPracticalShadowStore(connectionA);
    const claim = await store.claimEvaluation({ campaignId, workerId: 'worker-a', evaluationId: `eval-dup-${randomBytes(3).toString('hex')}`, runtimeEpoch: EPOCH, nowMs: T0 });
    if (claim.kind !== 'CLAIMED') throw new Error('expected CLAIMED');
    const genuine = await genuineCompletion(w, campaignId, claim.evaluation.evaluationId);
    const cancel = genuine.paperDecisions.findIndex((decision) => decision.requestedAction === 'CANCEL' && decision.rolloutStage === 'STAGE_5A_CANCEL_ONLY');
    const reused = genuine.paperDecisions.map((decision, index) => (index === cancel ? { ...decision, paperDecisionId: existing.paperDecisionId } : decision));
    await expect(store.completeEvaluation({ evaluationId: claim.evaluation.evaluationId, workerId: 'worker-a', result: genuine.result, paperDecisions: reused, nowMs: T0 + 1 }))
      .rejects.toThrow(/SHADOW_EVIDENCE_TAMPERED/);
    expect(await connectionA.livePracticalShadowPaperDecision.count({ where: { paperDecisionId: existing.paperDecisionId } })).toBe(1);
    expect(await connectionA.livePracticalShadowEvaluation.findUniqueOrThrow({ where: { evaluationId: claim.evaluation.evaluationId } })).toMatchObject({ status: 'CLAIMED', evidenceJson: null });
  });

  it('REPORT/REPLAY while collection runs: a consistent snapshot with an explicit cutoff; the in-progress evaluation is reported as in progress, never counted', async () => {
    if (skip()) return;
    const w = await world();
    const sources = sourcesFor(w);
    const a = runnerFor(w, { workerId: 'worker-a', sources });
    await a.open('START_NEW');
    const campaignId = a.campaign!.campaignId;
    await a.runEvaluation();
    (sources.scheduler as FakeScheduler).hold();
    const pending = a.runEvaluation();
    await until(async () => (await evaluations(campaignId)).some((row) => row.status === 'CLAIMED'), 'an in-progress evaluation');
    const store = new PrismaPracticalShadowStore(connectionB);
    const during = (await store.snapshotCampaign(campaignId))!;
    expect(during.cutoffSequence).toBe(2);
    const replayDuring = replayPracticalShadowSnapshot(during);
    expect(replayDuring).toMatchObject({ consistent: true, evaluationsReplayed: 1, report: { evaluations: { completed: 1, aborted: 0, inProgress: 1 }, cutoffSequence: 2 } });
    (sources.scheduler as FakeScheduler).release();
    expect(await pending).toMatchObject({ kind: 'COMPLETED', sequence: 2 });
    const after = replayPracticalShadowSnapshot((await store.snapshotCampaign(campaignId))!);
    expect(after).toMatchObject({ consistent: true, evaluationsReplayed: 2, report: { evaluations: { completed: 2, inProgress: 0 } } });
    // Deterministic: the same stored dataset replays identically on either connection.
    expect(JSON.stringify(replayPracticalShadowSnapshot((await new PrismaPracticalShadowStore(connectionA).snapshotCampaign(campaignId))!))).toBe(JSON.stringify(after));
  });
});

/** Two stores over the two independent connections. */
class ShadowStorePair {
  public readonly a = new PrismaPracticalShadowStore(connectionA);
  public readonly b = new PrismaPracticalShadowStore(connectionB);
}

// ---------------------------------------------------------------------------
// Database-enforced invariants and parity
// ---------------------------------------------------------------------------

describe('P18B-CKPT-C-DB the database refuses what shadow must never record', () => {
  async function seededEvaluation(): Promise<{ campaignId: string; evaluationId: string }> {
    const w = await world();
    const a = runnerFor(w, { workerId: 'worker-a' });
    await a.open('START_NEW');
    const campaignId = a.campaign!.campaignId;
    const claim = await new PrismaPracticalShadowStore(connectionA).claimEvaluation({ campaignId, workerId: 'worker-a', evaluationId: `eval-chk-${randomBytes(3).toString('hex')}`, runtimeEpoch: EPOCH, nowMs: T0 });
    if (claim.kind !== 'CLAIMED') throw new Error('expected CLAIMED');
    return { campaignId, evaluationId: claim.evaluation.evaluationId };
  }

  it('an UNPROVEN evaluation can never be stored as authority-eligible (CHECK), and the store refuses it before writing', async () => {
    if (skip()) return;
    const { evaluationId } = await seededEvaluation();
    await expect(connectionA.$executeRawUnsafe(
      `UPDATE live_practical_shadow_evaluation SET status = 'COMPLETED', finished_at_ms = 1, started_at_ms = 0, ended_at_ms = 1, stream_readiness = 'UNPROVEN', rest_stability = 'PASS',
        authority_eligible = TRUE, blockers_json = '[]', evidence_schema_version = 'V', evidence_digest = '${'a'.repeat(64)}', evidence_json = '{}' WHERE evaluation_id = ?`, evaluationId,
    )).rejects.toThrow();
    await expect(new PrismaPracticalShadowStore(connectionA).completeEvaluation({
      evaluationId, workerId: 'worker-a', result: completedResult({ authorityEligible: true, primaryBlocker: null, blockers: [] }), paperDecisions: [], nowMs: T0 + 1,
    })).rejects.toThrow(/SHADOW_STORE_CONFLICT/);
  });

  it('an ABORTED evaluation can never carry evidence (CHECK: a crash never becomes a completed observation)', async () => {
    if (skip()) return;
    const { evaluationId } = await seededEvaluation();
    await expect(connectionA.$executeRawUnsafe(
      "UPDATE live_practical_shadow_evaluation SET status = 'ABORTED', abort_reason = 'X', finished_at_ms = 1, evidence_json = '{}' WHERE evaluation_id = ?", evaluationId,
    )).rejects.toThrow();
  });

  it.each([
    ['CANCEL@5a reaching the gate on an UNPROVEN stream', 'CANCEL', 'STAGE_5A_CANCEL_ONLY', 'UNPROVEN', 1],
    ['OPEN reaching the gate even with every prerequisite', 'OPEN', 'STAGE_5A_CANCEL_ONLY', 'PROVEN_READY', 1],
    ['CLOSE reaching the gate even with every prerequisite', 'CLOSE', 'STAGE_5A_CANCEL_ONLY', 'PROVEN_READY', 1],
    ['the future Stage 5b reaching the gate', 'CANCEL', 'STAGE_5B_OPEN_CLOSE_FUTURE', 'PROVEN_READY', 1],
  ])('a paper decision of %s is refused (CHECK)', async (_label, action, stage, readiness, prerequisites) => {
    if (skip()) return;
    const { campaignId, evaluationId } = await seededEvaluation();
    await expect(connectionA.$executeRawUnsafe(
      `INSERT INTO live_practical_shadow_paper_decision (paper_decision_id, evaluation_id, campaign_id, requested_action, rollout_stage, rest_stability, stream_readiness,
        authority_prerequisites_met, outcome, blockers_json, policy_version, created_at_ms) VALUES (?, ?, ?, ?, ?, 'PASS', ?, ?, 'WOULD_REACH_AUTHORITY_GATE', '[]', 'P', 1)`,
      paperId(), evaluationId, campaignId, action, stage, readiness, prerequisites,
    )).rejects.toThrow();
  });

  it('every Checkpoint C CHECK constraint is present, and the migrated database matches the Prisma datamodel on every live_practical_shadow_* object', async () => {
    if (skip()) return;
    const rows = await connectionA.$queryRaw<{ name: string }[]>`SELECT CONSTRAINT_NAME AS name FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ${SHADOW_DB_NAME} AND CONSTRAINT_NAME LIKE 'practical\\_shadow\\_%'`;
    expect(rows.map((row) => row.name).sort()).toEqual([
      'practical_shadow_account_revision_chk', 'practical_shadow_campaign_digest_chk', 'practical_shadow_campaign_end_chk', 'practical_shadow_campaign_provenance_chk', 'practical_shadow_campaign_revision_chk', 'practical_shadow_campaign_sequence_chk',
      'practical_shadow_campaign_window_chk', 'practical_shadow_evaluation_authority_chk', 'practical_shadow_evaluation_blocker_chk', 'practical_shadow_evaluation_digest_chk', 'practical_shadow_evaluation_rest_chk',
      'practical_shadow_evaluation_sequence_chk', 'practical_shadow_evaluation_status_chk', 'practical_shadow_evaluation_window_chk', 'practical_shadow_paper_decision_created_chk',
      'practical_shadow_paper_decision_gate_chk', 'practical_shadow_paper_decision_id_chk', 'practical_shadow_paper_decision_prerequisites_chk',
    ]);
    const diff = spawnSync(process.execPath, [
      path.join(REPO_ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'diff', '--script',
      '--from-url', shadowDatabaseUrl(),
      '--to-schema-datamodel', path.join(REPO_ROOT, 'prisma/schema.prisma'),
    ], { encoding: 'utf8', cwd: REPO_ROOT, env: process.env });
    expect(diff.status).toBe(0);
    expect(diff.stdout.split('\n').filter((line) => /live_practical_shadow|practical_shadow/.test(line))).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The CLI (database only) and the real read-only adapters
// ---------------------------------------------------------------------------

describe('P18B-CKPT-C-DB the CLI and the real read-only adapter boundary', () => {
  it('status, report, and replay read the database only (no credentials, no provider) and say NOT AUTHORITY', async () => {
    if (skip()) return;
    const w = await world();
    const a = runnerFor(w, { workerId: 'worker-a' });
    await a.open('START_NEW');
    await a.runEvaluation();
    const env = { COINDCX_LIVE_ACCOUNT_ID: w.accountId };
    for (const command of ['status', 'report', 'replay']) {
      const lines: string[] = [];
      const code = await runPracticalShadowCli([command], { env, io: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, prisma: connectionA, sourceProbe: NO_PROBE });
      expect(code, `${command}: ${lines.join('\n')}`).toBe(0);
      const output = JSON.parse(lines.join('\n'));
      // P18B-C-01: every view exposes the PERSISTED provenance (the clean commit the campaign was bound to).
      const provenance = { sourceProvenance: 'GIT_CLEAN_COMMIT', softwareVersion: COMMIT_A };
      if (command === 'status') expect(output).toMatchObject({ status: 'ACTIVE', provenance, evaluations: { completed: 1 }, authority: 'NOT AUTHORITY (shadow evidence only)' });
      if (command === 'report') {
        expect(output).toMatchObject({ replayConsistent: true, report: { grantsAuthority: false, provenance: { ...provenance, trustedCleanCommit: true }, authority: { primaryBlockers: { PRIVATE_STREAM_READINESS_UNPROVEN: 1 } } } });
        expect(output.report.coverage.rules.status).toBe('PROVISIONAL_HUMAN_REVIEW_CRITERIA');
      }
      if (command === 'replay') expect(output).toMatchObject({ consistent: true, provenance: { ...provenance, trustedCleanCommit: true }, evaluationsReplayed: 1, mismatches: [] });
    }
  });

  it('the REAL read-only CoinDCX adapters (fake read client, fake socket): REST evidence persisted, readiness UNPROVEN, never eligible, no certificate', async () => {
    if (skip()) return;
    const w = await world();
    const rawId = `raw-provider-id-${randomBytes(4).toString('hex')}`;
    const client = { getUserInfoSafe: async () => ({ coindcxId: rawId }), listInrFuturesOrders: async () => [], listInrFuturesPositions: async () => [] };
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({ apiKey: 'dummy-key', apiSecret: 'dummy-secret', socketFactory: ctx.socketFactory, clock: ctx.clock, scheduler: ctx.scheduler });
    await stream.start();
    const practical = new PrismaPracticalSafetyRepository(connectionA);
    const sources: PracticalShadowSources = {
      venue: new CoinDcxReconciliationEvidenceAdapter({ client: client as never, credentialAccountId: w.accountId, clock: w.clock }),
      privateStream: stream,
      reconciliation: w.reconciliation,
      practicalAccount: { loadAccount: (accountId: string) => practical.loadAccount(accountId) },
      clock: w.clock,
      scheduler: new FakeScheduler(w.clock),
    };
    let ids = 0;
    const runner = new PracticalShadowCampaignRunner({
      store: new PrismaPracticalShadowStore(connectionA), sources, config: resolvePracticalShadowConfig({ provider: TEST_PROVIDER, cadenceMs: 60_000 }), accountId: w.accountId,
      expectedProviderAccountFingerprint: providerAccountFingerprint(rawId), runtimeEpoch: EPOCH, sourceProvenance: cleanSource(), tierB: TIER_B_ELIGIBLE,
      workerId: 'worker-real', newId: () => `real-${randomBytes(3).toString('hex')}-${++ids}`,
    });
    await runner.open('START_NEW');
    expect(await runner.runEvaluation()).toMatchObject({ kind: 'COMPLETED', restStability: 'PASS', streamReadiness: 'UNPROVEN', authorityEligible: false, primaryBlocker: 'PRIVATE_STREAM_READINESS_UNPROVEN' });
    const [row] = await evaluations(runner.campaign!.campaignId);
    expect(row).toMatchObject({ status: 'COMPLETED', streamReadiness: 'UNPROVEN', authorityEligible: false });
    expect(row!.evidenceJson).not.toContain(rawId);
    expect(await practicalRows(w.accountId)).toMatchObject({ certificates: 0, leases: 0, state: { state: 'QUARANTINED' } });
    stream.stop();
  });
});

// ---------------------------------------------------------------------------
// P18B-C-01: software provenance (clean exact commit only)
// ---------------------------------------------------------------------------

describe('P18B-C-01 campaign software provenance (MySQL)', () => {
  it('1. a CLEAN exact commit starts a campaign; the commit and GIT_CLEAN_COMMIT are persisted in the binding', async () => {
    if (skip()) return;
    const w = await world();
    const runner = runnerFor(w, { workerId: 'worker-a' });
    expect(await runner.open('START_NEW')).toMatchObject({ kind: 'STARTED' });
    expect(await connectionA.livePracticalShadowCampaign.findUniqueOrThrow({ where: { campaignId: runner.campaign!.campaignId } }))
      .toMatchObject({ softwareVersion: COMMIT_A, sourceProvenance: 'GIT_CLEAN_COMMIT', status: 'ACTIVE' });
  });

  it.each([
    ['2. a DIRTY source tree', DIRTY_SOURCE, 'SHADOW_SOURCE_DIRTY'],
    ['3. UNAVAILABLE provenance', UNAVAILABLE_SOURCE, 'SHADOW_SOURCE_PROVENANCE_UNAVAILABLE'],
  ])('%s creates NO campaign row (and no account row) in any open mode', async (_label, source, reason) => {
    if (skip()) return;
    const w = await world();
    for (const mode of ['START_NEW', 'RESUME_OR_START', 'RESUME'] as const) {
      expect(await runnerFor(w, { workerId: 'worker-a', source }).open(mode)).toEqual({ kind: 'REFUSED', reason, detail: [] });
    }
    expect(await connectionA.livePracticalShadowCampaign.count({ where: { accountId: w.accountId } })).toBe(0);
    expect(await connectionA.livePracticalShadowAccount.count({ where: { accountId: w.accountId } })).toBe(0);
  });

  it('the CLI start with a dirty or unknown tree refuses before the database: no row', async () => {
    if (skip()) return;
    const w = await world();
    const env = {
      LIVE_PRACTICAL_SHADOW_ENABLED: 'true', COINDCX_API_KEY: 'k', COINDCX_API_SECRET: 's', COINDCX_LIVE_ACCOUNT_ID: w.accountId,
      COINDCX_EXPECTED_ACCOUNT_FINGERPRINT: FINGERPRINT, LIVE_PRACTICAL_SHADOW_CADENCE_MS: '60000',
    };
    expect(await cli(['start', '--new'], env, { probe: () => ({ head: COMMIT_A, status: '?? stray.ts\n' }) })).toMatchObject({ code: 2, output: expect.stringMatching(/SHADOW_SOURCE_DIRTY/) });
    expect(await cli(['start', '--new'], env, { probe: () => ({ head: null, status: null }) })).toMatchObject({ code: 2, output: expect.stringMatching(/SHADOW_SOURCE_PROVENANCE_UNAVAILABLE/) });
    expect(await connectionA.livePracticalShadowCampaign.count({ where: { accountId: w.accountId } })).toBe(0);
  });

  it('4/5. resume requires the EXACT same commit (other connection); another commit, dirty, or unknown cannot resume and changes nothing', async () => {
    if (skip()) return;
    const w = await world();
    const a = runnerFor(w, { workerId: 'worker-a' });
    await a.open('START_NEW');
    const before = await shadowRows(w.accountId);
    expect(await runnerFor(w, { workerId: 'worker-b', connection: connectionB, source: cleanSource(COMMIT_B) }).open('RESUME')).toMatchObject({ kind: 'REFUSED', reason: 'BINDING_MISMATCH', detail: ['softwareVersion'] });
    expect(await runnerFor(w, { workerId: 'worker-c', connection: connectionB, source: DIRTY_SOURCE }).open('RESUME')).toMatchObject({ kind: 'REFUSED', reason: 'SHADOW_SOURCE_DIRTY' });
    expect(await runnerFor(w, { workerId: 'worker-d', connection: connectionB, source: UNAVAILABLE_SOURCE }).open('RESUME_OR_START')).toMatchObject({ kind: 'REFUSED', reason: 'SHADOW_SOURCE_PROVENANCE_UNAVAILABLE' });
    expect(await shadowRows(w.accountId)).toBe(before);
    expect(await runnerFor(w, { workerId: 'worker-e', connection: connectionB, source: cleanSource(COMMIT_A) }).open('RESUME')).toMatchObject({ kind: 'RESUMED', campaign: { workerId: 'worker-e', softwareVersion: COMMIT_A } });
  });

  it('the store refuses an untrusted binding, and MySQL refuses a non-clean software version (CHECK)', async () => {
    if (skip()) return;
    const w = await world();
    const store = new PrismaPracticalShadowStore(connectionA);
    const binding = { accountId: w.accountId, providerAccountFingerprint: FINGERPRINT, softwareVersion: 'software-1', sourceProvenance: 'GIT_CLEAN_COMMIT' as const, configDigest: 'd'.repeat(64), evidenceSchemaVersion: 'P18B_SHADOW_EVIDENCE_V1' };
    await expect(store.startCampaign({ campaignId: `campaign-x-${randomBytes(3).toString('hex')}`, binding, configJson: '{}', workerId: 'worker-a', nowMs: T0 })).rejects.toThrow(/SHADOW_SOURCE_PROVENANCE_UNAVAILABLE/);
    expect(await connectionA.livePracticalShadowCampaign.count({ where: { accountId: w.accountId } })).toBe(0);
    const a = runnerFor(w, { workerId: 'worker-a' });
    await a.open('START_NEW');
    for (const version of ['software-1', COMMIT_A.toUpperCase(), `${COMMIT_A.slice(0, 39)}g`]) {
      await expect(connectionA.$executeRawUnsafe('UPDATE live_practical_shadow_campaign SET software_version = ? WHERE campaign_id = ?', version, a.campaign!.campaignId)).rejects.toThrow();
    }
    expect(await connectionA.livePracticalShadowCampaign.findUniqueOrThrow({ where: { campaignId: a.campaign!.campaignId } })).toMatchObject({ softwareVersion: COMMIT_A });
  });
});

// ---------------------------------------------------------------------------
// P18B-C-02: explicit operator abort (shadow only)
// ---------------------------------------------------------------------------

describe('P18B-C-02 explicit operator abort of a drifted campaign (MySQL)', () => {
  function stopEnv(w: World, cadenceMs: string): Record<string, string> {
    return { COINDCX_LIVE_ACCOUNT_ID: w.accountId, COINDCX_EXPECTED_ACCOUNT_FINGERPRINT: FINGERPRINT, LIVE_PRACTICAL_SHADOW_CADENCE_MS: cadenceMs, LIVE_PRACTICAL_SHADOW_RUNTIME_EPOCH: EPOCH };
  }

  /** An ACTIVE campaign with one completed evaluation and one evaluation IN FLIGHT (claimed; collection held). */
  async function driftedCampaign() {
    const w = await world();
    const sources = sourcesFor(w);
    const worker = runnerFor(w, { workerId: 'worker-a', sources });
    await worker.open('START_NEW');
    const campaignId = worker.campaign!.campaignId;
    await worker.runEvaluation();
    (sources.scheduler as FakeScheduler).hold();
    const pending = worker.runEvaluation();
    await until(async () => (await evaluations(campaignId)).some((row) => row.status === 'CLAIMED'), 'an in-flight evaluation');
    return { w, sources, worker, campaignId, pending };
  }

  it('1-5. changed config: normal stop REFUSES; the exact-id CLI abort succeeds, clears the pointer atomically, aborts the CLAIMED evaluation, and the stale completion loses', async () => {
    if (skip()) return;
    const { w, sources, worker, campaignId, pending } = await driftedCampaign();
    const practicalBefore = await practicalRows(w.accountId);

    // 1. Binding drift (cadence, then commit): the normal stop is refused and changes nothing.
    const before = await shadowRows(w.accountId);
    const clean = () => ({ head: COMMIT_A, status: '' });
    const refusedConfig = await cli(['stop'], stopEnv(w, '120000'), { probe: clean });
    expect(refusedConfig.code).toBe(1);
    expect(refusedConfig.output).toMatch(/BINDING_MISMATCH configDigest/);
    expect(refusedConfig.output).toMatch(/abort --account <accountId> --campaign <campaignId> --reason <CODE>/);
    expect(await cli(['stop'], stopEnv(w, '60000'), { probe: () => ({ head: COMMIT_B, status: '' }) })).toMatchObject({ code: 1, output: expect.stringMatching(/BINDING_MISMATCH softwareVersion/) });
    expect(await shadowRows(w.accountId)).toBe(before);

    // 2. The explicit abort (another connection; no credentials, no environment, no source probe).
    const aborted = await cli(['abort', '--account', w.accountId, '--campaign', campaignId, '--reason', 'CONFIG_CHANGED'], {}, { connection: connectionB });
    expect(aborted.code, aborted.output).toBe(0);
    expect(JSON.parse(aborted.output)).toMatchObject({ result: 'ABORTED', campaignId, status: 'ABORTED', endReason: 'OPERATOR_CAMPAIGN_ABORT:CONFIG_CHANGED', abortedEvaluations: 1 });

    // 3. The pointer is cleared in the same transaction as the status change.
    expect(await connectionA.livePracticalShadowAccount.findUniqueOrThrow({ where: { accountId: w.accountId } })).toMatchObject({ activeCampaignId: null });
    expect(await connectionA.livePracticalShadowCampaign.findUniqueOrThrow({ where: { campaignId } })).toMatchObject({ status: 'ABORTED', endReason: 'OPERATOR_CAMPAIGN_ABORT:CONFIG_CHANGED' });

    // 4. The in-flight evaluation is ABORTED (never a completed observation).
    expect((await evaluations(campaignId)).map((row) => [row.sequence, row.status, row.abortReason, row.evidenceJson === null])).toEqual([
      [1, 'COMPLETED', null, false],
      [2, 'ABORTED', 'OPERATOR_CAMPAIGN_ABORT', true],
    ]);

    // 5. The stale collector finishes and its completion LOSES; it writes nothing.
    (sources.scheduler as FakeScheduler).release();
    expect(await pending).toEqual({ kind: 'NOT_COLLECTED', reason: 'CAMPAIGN_NOT_ACTIVE' });
    expect(worker.campaign).toBeNull();
    const [, second] = await evaluations(campaignId);
    expect(second).toMatchObject({ status: 'ABORTED', evidenceJson: null });
    expect(await connectionA.livePracticalShadowPaperDecision.count({ where: { evaluationId: second!.evaluationId } })).toBe(0);

    // 9. Stage 1B1 practical rows are byte-identical.
    expect(await practicalRows(w.accountId)).toEqual(practicalBefore);
  });

  it('6-8. wrong account / unknown campaign refused with no write; a repeated abort is ALREADY_TERMINAL and writes nothing; never resumed; a new campaign may then start', async () => {
    if (skip()) return;
    const { w, sources, campaignId, pending } = await driftedCampaign();
    const other = await world();
    const practicalBefore = await practicalRows(w.accountId);
    const store = new PrismaPracticalShadowStore(connectionB);
    const active = await shadowRows(w.accountId);
    expect(await abortPracticalShadowCampaign({ store, accountId: other.accountId, campaignId, reason: 'WRONG', nowMs: T0 })).toEqual({ kind: 'REFUSED', reason: 'ACCOUNT_MISMATCH' });
    expect(await abortPracticalShadowCampaign({ store, accountId: w.accountId, campaignId: 'campaign-does-not-exist', reason: 'WRONG', nowMs: T0 })).toEqual({ kind: 'REFUSED', reason: 'UNKNOWN_CAMPAIGN' });
    expect(await cli(['abort', '--account', w.accountId, '--campaign', 'campaign-does-not-exist', '--reason', 'WRONG'], {})).toMatchObject({ code: 1, output: expect.stringMatching(/UNKNOWN_CAMPAIGN/) });
    await expect(abortPracticalShadowCampaign({ store, accountId: w.accountId, campaignId, reason: 'free text; not a code', nowMs: T0 })).rejects.toThrow(/SHADOW_CONFIG_INVALID/);
    expect(await shadowRows(w.accountId)).toBe(active);

    expect(await abortPracticalShadowCampaign({ store, accountId: w.accountId, campaignId, reason: 'FIRST', nowMs: T0 + 10 })).toMatchObject({ kind: 'ABORTED' });
    (sources.scheduler as FakeScheduler).release();
    await pending;
    const terminal = await shadowRows(w.accountId);
    expect(await abortPracticalShadowCampaign({ store, accountId: w.accountId, campaignId, reason: 'SECOND', nowMs: T0 + 20 })).toMatchObject({ kind: 'ALREADY_TERMINAL', campaign: { status: 'ABORTED', endReason: 'OPERATOR_CAMPAIGN_ABORT:FIRST' } });
    expect(JSON.parse((await cli(['abort', '--account', w.accountId, '--campaign', campaignId, '--reason', 'THIRD'], {})).output)).toMatchObject({ result: 'ALREADY_TERMINAL', status: 'ABORTED' });
    expect(await shadowRows(w.accountId)).toBe(terminal);
    // A terminal campaign is never resurrected.
    expect(await runnerFor(w, { workerId: 'worker-z', connection: connectionB }).open('RESUME')).toMatchObject({ kind: 'REFUSED', reason: 'NO_ACTIVE_CAMPAIGN' });
    expect(await shadowRows(w.accountId)).toBe(terminal);

    // 8. A new campaign may start after the explicit abort; the aborted one stays ABORTED.
    const next = runnerFor(w, { workerId: 'worker-n', connection: connectionB });
    expect(await next.open('START_NEW')).toMatchObject({ kind: 'STARTED' });
    expect(next.campaign!.campaignId).not.toBe(campaignId);
    expect(await connectionA.livePracticalShadowCampaign.findUniqueOrThrow({ where: { campaignId } })).toMatchObject({ status: 'ABORTED' });
    expect(await practicalRows(w.accountId)).toEqual(practicalBefore);
  });

  it('RACES on two connections: abort vs completion leaves one consistent outcome; two aborts give exactly one ABORTED', async () => {
    if (skip()) return;
    const w = await world();
    const a = runnerFor(w, { workerId: 'worker-a' });
    await a.open('START_NEW');
    const campaignId = a.campaign!.campaignId;
    const { a: storeA, b: storeB } = new ShadowStorePair();
    const claim = await storeA.claimEvaluation({ campaignId, workerId: 'worker-a', evaluationId: `eval-abort-race-${randomBytes(3).toString('hex')}`, runtimeEpoch: EPOCH, nowMs: T0 });
    if (claim.kind !== 'CLAIMED') throw new Error('expected CLAIMED');
    const evaluationId = claim.evaluation.evaluationId;
    const genuine = await genuineCompletion(w, campaignId, evaluationId);
    const [completion, abort] = await Promise.all([
      storeA.completeEvaluation({ evaluationId, workerId: 'worker-a', result: genuine.result, paperDecisions: genuine.paperDecisions, nowMs: T0 + 2 }),
      storeB.abortCampaign({ accountId: w.accountId, campaignId, reason: 'RACE', nowMs: T0 + 2 }),
    ]);
    expect(abort.kind).toBe('ABORTED');
    const row = await connectionA.livePracticalShadowEvaluation.findUniqueOrThrow({ where: { evaluationId } });
    if (completion.kind === 'COMPLETED') {
      expect(row.status).toBe('COMPLETED');
      expect(abort).toMatchObject({ abortedEvaluations: 0 });
    } else {
      expect(completion).toEqual({ kind: 'REFUSED', reason: 'CAMPAIGN_NOT_ACTIVE' });
      expect(row).toMatchObject({ status: 'ABORTED', abortReason: 'OPERATOR_CAMPAIGN_ABORT', evidenceJson: null });
    }
    expect(await connectionA.livePracticalShadowCampaign.findUniqueOrThrow({ where: { campaignId } })).toMatchObject({ status: 'ABORTED' });

    const w2 = await world();
    const b = runnerFor(w2, { workerId: 'worker-a' });
    await b.open('START_NEW');
    const results = await Promise.all([
      storeA.abortCampaign({ accountId: w2.accountId, campaignId: b.campaign!.campaignId, reason: 'ONE', nowMs: T0 }),
      storeB.abortCampaign({ accountId: w2.accountId, campaignId: b.campaign!.campaignId, reason: 'TWO', nowMs: T0 }),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['ABORTED', 'ALREADY_TERMINAL']);
    expect(await connectionA.livePracticalShadowAccount.findUniqueOrThrow({ where: { accountId: w2.accountId } })).toMatchObject({ activeCampaignId: null });
  });
});

// ---------------------------------------------------------------------------
// P18B-C-03: the persisted configuration is bound to its digest
// ---------------------------------------------------------------------------

describe('P18B-C-03 persisted configuration bound to configDigest (MySQL)', () => {
  it('a direct store start whose configJson does not match binding.configDigest writes NOTHING', async () => {
    if (skip()) return;
    const w = await world();
    const bound = resolvePracticalShadowConfig({ provider: TEST_PROVIDER, cadenceMs: 60_000 });
    const other = resolvePracticalShadowConfig({ provider: TEST_PROVIDER, cadenceMs: 120_000 });
    const binding = { accountId: w.accountId, providerAccountFingerprint: FINGERPRINT, softwareVersion: COMMIT_A, sourceProvenance: 'GIT_CLEAN_COMMIT' as const, configDigest: bound.digest, evidenceSchemaVersion: 'P18B_SHADOW_EVIDENCE_V1' };
    const store = new PrismaPracticalShadowStore(connectionA);
    await expect(store.startCampaign({ campaignId: `campaign-cfg-${randomBytes(3).toString('hex')}`, binding, configJson: JSON.stringify(other.snapshot), workerId: 'worker-a', nowMs: T0 })).rejects.toThrow(/SHADOW_EVIDENCE_TAMPERED/);
    expect(await connectionA.livePracticalShadowCampaign.count({ where: { accountId: w.accountId } })).toBe(0);
    expect(await connectionA.livePracticalShadowAccount.count({ where: { accountId: w.accountId } })).toBe(0);
  });

  it('config_json changed in the database with the old digest: replay and the CLI report REFUSE it (never re-interpreted, never review-eligible)', async () => {
    if (skip()) return;
    const w = await world();
    const a = runnerFor(w, { workerId: 'worker-a' });
    await a.open('START_NEW');
    await a.runEvaluation();
    const campaignId = a.campaign!.campaignId;
    const store = new PrismaPracticalShadowStore(connectionA);
    expect(replayPracticalShadowSnapshot((await store.snapshotCampaign(campaignId))!).consistent).toBe(true);
    const row = await connectionA.livePracticalShadowCampaign.findUniqueOrThrow({ where: { campaignId } });
    const lenient = { ...JSON.parse(row.configJson), calibrationReview: { status: 'PROVISIONAL_HUMAN_REVIEW_CRITERIA', minimumDurationMs: 1, minimumCompletedEvaluations: 1, minimumCoveragePermille: 1 } };
    await connectionA.$executeRawUnsafe('UPDATE live_practical_shadow_campaign SET config_json = ? WHERE campaign_id = ?', JSON.stringify(lenient), campaignId);
    const tampered = (await store.snapshotCampaign(campaignId))!;
    expect(() => replayPracticalShadowSnapshot(tampered)).toThrow(/SHADOW_EVIDENCE_TAMPERED/);
    await expect(cli(['report', '--campaign', campaignId], {})).rejects.toThrow(/SHADOW_EVIDENCE_TAMPERED/);
    // A worker can no longer complete against a tampered campaign configuration either.
    const claim = await store.claimEvaluation({ campaignId, workerId: 'worker-a', evaluationId: `eval-cfg-${randomBytes(3).toString('hex')}`, runtimeEpoch: EPOCH, nowMs: T0 });
    if (claim.kind !== 'CLAIMED') throw new Error('expected CLAIMED');
    const genuine = await genuineCompletion(w, campaignId, claim.evaluation.evaluationId);
    await expect(store.completeEvaluation({ evaluationId: claim.evaluation.evaluationId, workerId: 'worker-a', result: genuine.result, paperDecisions: genuine.paperDecisions, nowMs: T0 + 1 })).rejects.toThrow(/SHADOW_EVIDENCE_TAMPERED/);
    expect(await connectionA.livePracticalShadowEvaluation.findUniqueOrThrow({ where: { evaluationId: claim.evaluation.evaluationId } })).toMatchObject({ status: 'CLAIMED', evidenceJson: null });
  });

  it('MySQL refuses a malformed digest shape (config digest, fingerprint, evidence digest, paper decision id)', async () => {
    if (skip()) return;
    const w = await world();
    const a = runnerFor(w, { workerId: 'worker-a' });
    await a.open('START_NEW');
    await a.runEvaluation();
    const campaignId = a.campaign!.campaignId;
    const [evaluation] = await evaluations(campaignId);
    for (const [sql, value] of [
      ['UPDATE live_practical_shadow_campaign SET config_digest = ? WHERE campaign_id = ?', 'A'.repeat(64)],
      ['UPDATE live_practical_shadow_campaign SET config_digest = ? WHERE campaign_id = ?', `${'a'.repeat(63)}g`],
      ['UPDATE live_practical_shadow_campaign SET provider_account_fingerprint = ? WHERE campaign_id = ?', 'F'.repeat(64)],
    ] as const) {
      await expect(connectionA.$executeRawUnsafe(sql, value, campaignId)).rejects.toThrow();
    }
    await expect(connectionA.$executeRawUnsafe('UPDATE live_practical_shadow_evaluation SET evidence_digest = ? WHERE evaluation_id = ?', 'Z'.repeat(64), evaluation!.evaluationId)).rejects.toThrow();
    const paper = await connectionA.livePracticalShadowPaperDecision.findFirstOrThrow({ where: { evaluationId: evaluation!.evaluationId } });
    await expect(connectionA.$executeRawUnsafe('UPDATE live_practical_shadow_paper_decision SET paper_decision_id = ? WHERE paper_decision_id = ?', 'pd-not-hex', paper.paperDecisionId)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// P18B-C-04: durable evidence and paper decisions cross-bound before completion
// ---------------------------------------------------------------------------

describe('P18B-C-04 evidence + paper decisions are cross-bound BEFORE durable completion (MySQL)', () => {
  it('1-9 and 11: every foreign, altered, missing, or extra record is refused and rolls back (still CLAIMED, zero paper rows); 10: the genuine record completes', async () => {
    if (skip()) return;
    const w = await world();
    const a = runnerFor(w, { workerId: 'worker-a' });
    await a.open('START_NEW');
    const campaignId = a.campaign!.campaignId;
    const store = new PrismaPracticalShadowStore(connectionB);
    const claim = await store.claimEvaluation({ campaignId, workerId: 'worker-a', evaluationId: `eval-x-${randomBytes(3).toString('hex')}`, runtimeEpoch: EPOCH, nowMs: T0 });
    if (claim.kind !== 'CLAIMED') throw new Error('expected CLAIMED');
    const evaluationId = claim.evaluation.evaluationId;
    const practicalBefore = await practicalRows(w.accountId);
    const genuine = await genuineCompletion(w, campaignId, evaluationId);
    const refused = async (result: PracticalShadowEvaluationResult, paperDecisions: readonly PracticalShadowPaperDecisionRecord[], pattern: RegExp) => {
      await expect(store.completeEvaluation({ evaluationId, workerId: 'worker-a', result, paperDecisions, nowMs: T0 + 1 })).rejects.toThrow(pattern);
      expect(await connectionA.livePracticalShadowEvaluation.findUniqueOrThrow({ where: { evaluationId } })).toMatchObject({ status: 'CLAIMED', evidenceJson: null, evidenceDigest: null });
      expect(await connectionA.livePracticalShadowPaperDecision.count({ where: { evaluationId } })).toBe(0);
    };
    // 1-3: self-consistent evidence for another account / fingerprint / evaluation.
    for (const [overrides, field] of [
      [{ accountId: `${w.accountId}-b` }, /accountId/],
      [{ expectedProviderAccountFingerprint: OTHER_FINGERPRINT }, /expectedProviderAccountFingerprint/],
      [{ evaluationId: 'eval-another' }, /evaluationId/],
    ] as const) {
      const foreign = await genuineCompletion(w, campaignId, evaluationId, overrides);
      await refused(foreign.result, foreign.paperDecisions, field);
    }
    // 4: evidence changed without its digest; 5: re-digested for another account.
    const evidence = JSON.parse(genuine.result.evidenceJson);
    await refused({ ...genuine.result, evidenceJson: JSON.stringify({ ...evidence, endedAtMs: evidence.endedAtMs + 1 }) }, genuine.paperDecisions, /SHADOW_EVIDENCE_TAMPERED/);
    const reforged = { ...evidence, accountId: 'another-account' };
    await refused({ ...genuine.result, evidenceJson: JSON.stringify(reforged), evidenceDigest: practicalShadowEvidenceDigest(reforged) }, genuine.paperDecisions, /accountId/);
    // 6/7: UNPROVEN + forged PROVEN_READY paper decision; ineligible + WOULD_REACH_AUTHORITY_GATE.
    const cancel = genuine.paperDecisions.findIndex((decision) => decision.requestedAction === 'CANCEL' && decision.rolloutStage === 'STAGE_5A_CANCEL_ONLY');
    const forge = (change: Partial<PracticalShadowPaperDecisionRecord>) => genuine.paperDecisions.map((decision, index) => (index === cancel ? { ...decision, ...change } : decision));
    await refused(genuine.result, forge({ streamReadiness: 'PROVEN_READY' }), /streamReadiness/);
    await refused(genuine.result, forge({ outcome: 'WOULD_REACH_AUTHORITY_GATE', blockers: [] }), /outcome/);
    // 8/9: missing and extra decisions.
    await refused(genuine.result, genuine.paperDecisions.filter((_, index) => index !== cancel), /missing/);
    await refused(genuine.result, [...genuine.paperDecisions, { ...genuine.paperDecisions[cancel]!, paperDecisionId: paperId() }], /duplicate|unexpected/);
    // 10: the genuine record completes; Stage 1B1 rows untouched throughout.
    expect(await store.completeEvaluation({ evaluationId, workerId: 'worker-a', result: genuine.result, paperDecisions: genuine.paperDecisions, nowMs: T0 + 1 })).toMatchObject({ kind: 'COMPLETED' });
    expect(await connectionA.livePracticalShadowPaperDecision.count({ where: { evaluationId } })).toBe(6);
    expect(await practicalRows(w.accountId)).toEqual(practicalBefore);
  });

  it('the composite foreign key refuses a paper row naming an evaluation of ANOTHER campaign', async () => {
    if (skip()) return;
    const [w1, w2] = [await world(), await world()];
    const a = runnerFor(w1, { workerId: 'worker-a' });
    const b = runnerFor(w2, { workerId: 'worker-b' });
    await a.open('START_NEW');
    await b.open('START_NEW');
    await a.runEvaluation();
    const [evaluation] = await evaluations(a.campaign!.campaignId);
    await expect(connectionA.$executeRawUnsafe(
      `INSERT INTO live_practical_shadow_paper_decision (paper_decision_id, evaluation_id, campaign_id, requested_action, rollout_stage, rest_stability, stream_readiness,
        authority_prerequisites_met, outcome, blockers_json, policy_version, created_at_ms) VALUES (?, ?, ?, 'OPEN', 'STAGE_5B_OPEN_CLOSE_FUTURE', 'PASS', 'UNPROVEN', FALSE, 'WOULD_BLOCK', '[]', 'P', 1)`,
      paperId(), evaluation!.evaluationId, b.campaign!.campaignId,
    )).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// P18B-C-05: exact ids despite the case-insensitive collation
// ---------------------------------------------------------------------------

describe('P18B-C-05 caller-supplied ids are EXACT (a case-only match is never used)', () => {
  it('case variants cannot abort, stop, claim, complete, abort-evaluate, load, or snapshot; exact ids then succeed; zero writes', async () => {
    if (skip()) return;
    const w = await world();
    const a = runnerFor(w, { workerId: 'worker-a' });
    await a.open('START_NEW');
    const campaignId = a.campaign!.campaignId;
    const upper = campaignId.toUpperCase();
    expect(upper).not.toBe(campaignId);
    const store = new PrismaPracticalShadowStore(connectionB);
    const claim = await store.claimEvaluation({ campaignId, workerId: 'worker-a', evaluationId: `eval-case-${randomBytes(3).toString('hex')}`, runtimeEpoch: EPOCH, nowMs: T0 });
    if (claim.kind !== 'CLAIMED') throw new Error('expected CLAIMED');
    const evaluationId = claim.evaluation.evaluationId;
    const genuine = await genuineCompletion(w, campaignId, evaluationId);
    const before = await shadowRows(w.accountId);

    expect(await store.abortCampaign({ accountId: w.accountId, campaignId: upper, reason: 'CASE', nowMs: T0 })).toEqual({ kind: 'REFUSED', reason: 'UNKNOWN_CAMPAIGN' });
    await expect(store.abortCampaign({ accountId: w.accountId.toUpperCase(), campaignId, reason: 'CASE', nowMs: T0 })).rejects.toThrow(/SHADOW_STORE_CONFLICT/);
    expect(await cli(['abort', '--account', w.accountId, '--campaign', upper, '--reason', 'CASE'], {})).toMatchObject({ code: 1, output: expect.stringMatching(/UNKNOWN_CAMPAIGN/) });
    expect(await store.stopCampaign({ campaignId: upper, workerId: 'worker-a', status: 'COMPLETED', reason: 'CASE', nowMs: T0 })).toEqual({ kind: 'CAMPAIGN_NOT_ACTIVE' });
    expect(await store.claimEvaluation({ campaignId: upper, workerId: 'worker-a', evaluationId: `eval-case2-${randomBytes(3).toString('hex')}`, runtimeEpoch: EPOCH, nowMs: T0 })).toEqual({ kind: 'CAMPAIGN_NOT_ACTIVE' });
    expect(await store.completeEvaluation({ evaluationId: evaluationId.toUpperCase(), workerId: 'worker-a', result: genuine.result, paperDecisions: genuine.paperDecisions, nowMs: T0 + 1 })).toEqual({ kind: 'REFUSED', reason: 'NOT_CLAIMED' });
    expect(await store.abortEvaluation({ evaluationId: evaluationId.toUpperCase(), workerId: 'worker-a', reason: 'CASE', nowMs: T0 })).toEqual({ kind: 'REFUSED' });
    expect(await store.loadCampaign(upper)).toBeNull();
    expect(await store.snapshotCampaign(upper)).toBeNull();
    expect(await store.loadActiveCampaign(w.accountId.toUpperCase())).toBeNull();
    expect(await cli(['status', '--campaign', upper], {})).toMatchObject({ code: 1, output: expect.stringMatching(/Unknown campaign/) });
    expect(await shadowRows(w.accountId)).toBe(before);

    // The exact ids work.
    expect((await store.loadCampaign(campaignId))?.campaignId).toBe(campaignId);
    expect((await store.snapshotCampaign(campaignId))?.campaign.campaignId).toBe(campaignId);
    expect(await store.completeEvaluation({ evaluationId, workerId: 'worker-a', result: genuine.result, paperDecisions: genuine.paperDecisions, nowMs: T0 + 1 })).toMatchObject({ kind: 'COMPLETED' });
    expect(await store.abortCampaign({ accountId: w.accountId, campaignId, reason: 'EXACT', nowMs: T0 + 2 })).toMatchObject({ kind: 'ABORTED' });
  });
});

// ---------------------------------------------------------------------------
// P18B-C-06 / C-07 / C-08
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

describe('P18B-C-06/C-07 one configured protocol and a CLOSED evidence schema, enforced before durable completion (MySQL)', () => {
  it('weakened window/timing, another runtime epoch, a forged one-pass PASS, unknown fields, and secrets are all refused with ZERO writes; the genuine record is stored in canonical form', async () => {
    if (skip()) return;
    const w = await world();
    const a = runnerFor(w, { workerId: 'worker-a' });
    await a.open('START_NEW');
    const campaignId = a.campaign!.campaignId;
    const store = new PrismaPracticalShadowStore(connectionB);
    const claim = await store.claimEvaluation({ campaignId, workerId: 'worker-a', evaluationId: `eval-proto-${randomBytes(3).toString('hex')}`, runtimeEpoch: EPOCH, nowMs: T0 });
    if (claim.kind !== 'CLAIMED') throw new Error('expected CLAIMED');
    const evaluationId = claim.evaluation.evaluationId;
    const genuine = await genuineCompletion(w, campaignId, evaluationId);
    const intents = resolvePracticalShadowConfig({ provider: TEST_PROVIDER, cadenceMs: 60_000 }).paperIntents;
    const forged = (change: (value: Json) => Json) => buildPracticalShadowCompletion(change(JSON.parse(genuine.result.evidenceJson) as Json) as unknown as PracticalShadowEvidence, intents);
    const refused = async (result: PracticalShadowEvaluationResult, paperDecisions: readonly PracticalShadowPaperDecisionRecord[], pattern: RegExp) => {
      await expect(store.completeEvaluation({ evaluationId, workerId: 'worker-a', result, paperDecisions, nowMs: T0 + 1 })).rejects.toThrow(pattern);
      expect(await connectionA.livePracticalShadowEvaluation.findUniqueOrThrow({ where: { evaluationId } })).toMatchObject({ status: 'CLAIMED', evidenceJson: null, evidenceDigest: null });
      expect(await connectionA.livePracticalShadowPaperDecision.count({ where: { evaluationId } })).toBe(0);
    };
    // C-06: exactly the configured protocol and the claimed runtime.
    for (const [change, field] of [
      [(e: Json) => ({ ...e, window: { ...(e['window'] as Json), minimumPasses: 1 } }), /window\.minimumPasses/],
      [(e: Json) => ({ ...e, window: { ...(e['window'] as Json), minimumPassSpacingMs: 1 } }), /window\.minimumPassSpacingMs/],
      [(e: Json) => ({ ...e, window: { ...(e['window'] as Json), minimumCertificationSpanMs: 1 } }), /window\.minimumCertificationSpanMs/],
      [(e: Json) => ({ ...e, timing: { ...(e['timing'] as Json), hardPassDurationMs: 10_000_000 } }), /timing\.hardPassDurationMs/],
      [(e: Json) => ({ ...e, timing: { ...(e['timing'] as Json), hardReadTimeoutMs: 10_000_000 } }), /timing\.hardReadTimeoutMs/],
      [(e: Json) => ({ ...e, timing: { ...(e['timing'] as Json), readCandidateMs: 1 } }), /timing\.readCandidateMs/],
      [(e: Json) => ({ ...e, runtimeEpoch: EPOCH_B }), /runtimeEpoch/],
    ] as const) {
      const record = forged(change);
      await refused(record.result, record.paperDecisions, field);
    }
    const onePass = forged((e) => ({
      ...e, window: { minimumPasses: 1, minimumPassSpacingMs: 1, minimumCertificationSpanMs: 1 },
      reads: (e['reads'] as Json[]).filter((read) => read['passIndex'] === 1), reconciliation: (e['reconciliation'] as Json[]).slice(0, 2),
    }));
    expect(onePass.result.restStability).toBe('PASS');
    await refused(onePass.result, onePass.paperDecisions, /window\.minimumPasses/);
    // C-07: unknown fields / secrets / raw payloads / arbitrary codes never reach the database.
    for (const [change, pattern] of [
      [(e: Json) => ({ ...e, secret: 'API-SECRET-MUST-NEVER-PERSIST' }), /SHADOW_UNSUPPORTED_VERSION/],
      [(e: Json) => ({ ...e, reads: (e['reads'] as Json[]).map((read, index) => (index === 1 ? { ...read, rawOrderPayload: [{ id: 'o-1' }] } : read)) }), /SHADOW_UNSUPPORTED_VERSION/],
      [(e: Json) => ({ ...e, events: { total: 1, byReason: { 'provider said: key abc': 1 } } }), /SHADOW_UNSUPPORTED_VERSION/],
      [(e: Json) => ({ ...e, reads: (e['reads'] as Json[]).map((read, index) => (index === 0 ? { ...read, failure: 'HTTP 401 for key abc', contentDigest: null } : read)) }), /SHADOW_EVIDENCE_INSUFFICIENT/],
    ] as const) {
      await refused({ ...genuine.result, evidenceJson: JSON.stringify(change(JSON.parse(genuine.result.evidenceJson) as Json)) }, genuine.paperDecisions, pattern);
    }
    const everything = await connectionA.$queryRawUnsafe<{ n: bigint }[]>(
      "SELECT COUNT(*) AS n FROM live_practical_shadow_evaluation WHERE evidence_json LIKE '%SECRET%' OR evidence_json LIKE '%rawOrderPayload%' OR evidence_json LIKE '%key abc%'",
    );
    expect(Number(everything[0]!.n)).toBe(0);

    // The genuine record, even re-serialized by the caller, is stored as the canonical rebuilt record whose digest is stored.
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(genuine.result.evidenceJson) as Json).reverse()));
    expect(await store.completeEvaluation({ evaluationId, workerId: 'worker-a', result: { ...genuine.result, evidenceJson: reordered }, paperDecisions: genuine.paperDecisions, nowMs: T0 + 1 })).toMatchObject({ kind: 'COMPLETED' });
    const row = await connectionA.livePracticalShadowEvaluation.findUniqueOrThrow({ where: { evaluationId } });
    const reparsed = parsePracticalShadowEvidence(JSON.parse(row.evidenceJson!));
    expect(row.evidenceJson).toBe(canonicalPracticalShadowEvidenceJson(reparsed));
    expect(row.evidenceJson).toBe(genuine.result.evidenceJson);
    expect(row.evidenceDigest).toBe(practicalShadowEvidenceDigest(reparsed));
    expect(replayPracticalShadowSnapshot((await store.snapshotCampaign(campaignId))!).consistent).toBe(true);
  });
});

describe('P18B-C-08 a campaign whose stored configuration is corrupted is never resumed (MySQL)', () => {
  it('1-4: tampered, future-versioned, or malformed stored config -> resume refused with ZERO writes (owner, revision, CLAIMED rows unchanged); 5: explicit abort still ends it; 6: a valid resume is unchanged', async () => {
    if (skip()) return;
    const w = await world();
    const sources = sourcesFor(w);
    const a = runnerFor(w, { workerId: 'worker-a', sources });
    await a.open('START_NEW');
    const campaignId = a.campaign!.campaignId;
    await a.runEvaluation();
    (sources.scheduler as FakeScheduler).hold();
    const pending = a.runEvaluation();
    await until(async () => (await evaluations(campaignId)).some((row) => row.status === 'CLAIMED'), 'an in-flight evaluation');
    const original = await connectionA.livePracticalShadowCampaign.findUniqueOrThrow({ where: { campaignId } });
    const config = JSON.parse(original.configJson) as Json;
    const future = { ...config, analysisVersion: 'P18B_SHADOW_ANALYSIS_V9' };
    for (const [configJson, configDigest, pattern] of [
      [JSON.stringify({ ...config, cadenceMs: 120_000 }), original.configDigest, /SHADOW_EVIDENCE_TAMPERED/],
      [JSON.stringify(future), sha256CanonicalJson(future), /SHADOW_UNSUPPORTED_VERSION/],
      ['{not json', original.configDigest, /SHADOW_EVIDENCE_INSUFFICIENT/],
    ] as const) {
      await connectionA.$executeRawUnsafe('UPDATE live_practical_shadow_campaign SET config_json = ?, config_digest = ? WHERE campaign_id = ?', configJson, configDigest, campaignId);
      const before = await shadowRows(w.accountId);
      await expect(runnerFor(w, { workerId: 'worker-b', connection: connectionB }).open('RESUME')).rejects.toThrow(pattern);
      await expect(cli(['stop'], { COINDCX_LIVE_ACCOUNT_ID: w.accountId, COINDCX_EXPECTED_ACCOUNT_FINGERPRINT: FINGERPRINT, LIVE_PRACTICAL_SHADOW_CADENCE_MS: '60000' }, { probe: () => ({ head: COMMIT_A, status: '' }) })).rejects.toThrow(pattern);
      expect(await shadowRows(w.accountId)).toBe(before);
      expect(await connectionA.livePracticalShadowCampaign.findUniqueOrThrow({ where: { campaignId } })).toMatchObject({ workerId: 'worker-a', revision: original.revision });
      expect((await evaluations(campaignId)).map((row) => row.status)).toEqual(['COMPLETED', 'CLAIMED']);
    }
    // 5: the explicit abort does not depend on the configuration.
    expect(await abortPracticalShadowCampaign({ store: new PrismaPracticalShadowStore(connectionB), accountId: w.accountId, campaignId, reason: 'CONFIG_CORRUPTED', nowMs: T0 + 9 })).toMatchObject({ kind: 'ABORTED', abortedEvaluations: 1 });
    (sources.scheduler as FakeScheduler).release();
    expect(await pending).toEqual({ kind: 'NOT_COLLECTED', reason: 'CAMPAIGN_NOT_ACTIVE' });

    // 6: a valid campaign still resumes exactly as before.
    const next = runnerFor(w, { workerId: 'worker-c' });
    await next.open('START_NEW');
    expect(await runnerFor(w, { workerId: 'worker-d', connection: connectionB }).open('RESUME')).toMatchObject({ kind: 'RESUMED', abortedEvaluations: 0, campaign: { workerId: 'worker-d' } });
  });
});
