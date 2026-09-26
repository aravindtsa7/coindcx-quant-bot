import { describe, expect, it } from 'vitest';
import { sha256CanonicalJson } from '../../../../../src/risk';
import { PracticalShadowCampaignRunner, practicalShadowTierBStatus } from '../../../../../src/execution/live/practical-shadow/campaign';
import { practicalShadowEvidenceDigest, parsePracticalShadowEvidence } from '../../../../../src/execution/live/practical-shadow/evidence';
import type { PracticalShadowCampaignSnapshot } from '../../../../../src/execution/live/practical-shadow/ports';
import type { PracticalShadowSourceProvenance } from '../../../../../src/execution/live/practical-shadow/provenance';
import { replayPracticalShadowSnapshot } from '../../../../../src/execution/live/practical-shadow/replay';
import { FakeScheduler } from '../practical-recovery/support';
import {
  ACCOUNT,
  COMMIT_B,
  EPOCH,
  FINGERPRINT,
  MemoryPracticalShadowStore,
  TIER_B_ELIGIBLE,
  advancePhase18,
  cleanSource,
  shadowConfig,
  shadowWorld,
  type ShadowWorld,
} from './support';

function runner(world: ShadowWorld, store: MemoryPracticalShadowStore, options: { readonly workerId?: string; readonly source?: PracticalShadowSourceProvenance; readonly cadenceMs?: number; readonly ownScheduler?: boolean } = {}) {
  let ids = 0;
  const workerId = options.workerId ?? 'worker-a';
  return new PracticalShadowCampaignRunner({
    store,
    // A separate process has its own timers on the same world clock.
    sources: options.ownScheduler === true ? { ...world.sources, scheduler: new FakeScheduler(world.clock) } : world.sources,
    config: options.cadenceMs === undefined ? world.config : shadowConfig({ cadenceMs: options.cadenceMs }),
    accountId: ACCOUNT,
    expectedProviderAccountFingerprint: FINGERPRINT,
    runtimeEpoch: EPOCH,
    sourceProvenance: options.source ?? cleanSource(),
    tierB: TIER_B_ELIGIBLE,
    workerId,
    newId: () => `${workerId}-${++ids}`,
  });
}

describe('campaign lifecycle', () => {
  it('start -> evaluations -> stop; the real-like UNPROVEN stream records REST data with authority ineligible', async () => {
    const world = await shadowWorld();
    const store = new MemoryPracticalShadowStore();
    const a = runner(world, store);
    expect(await a.open('START_NEW')).toMatchObject({ kind: 'STARTED', campaign: { status: 'ACTIVE', configDigest: world.config.digest } });
    advancePhase18(world);
    const first = await a.runEvaluation();
    expect(first).toMatchObject({ kind: 'COMPLETED', sequence: 1, restStability: 'PASS', streamReadiness: 'UNPROVEN', authorityEligible: false, primaryBlocker: 'PRIVATE_STREAM_READINESS_UNPROVEN' });
    const snapshot = (await store.snapshotCampaign(a.campaign!.campaignId))!;
    expect(snapshot.evaluations[0]!.result).toMatchObject({ restStability: 'PASS', authorityEligible: false, streamReadiness: 'UNPROVEN' });
    expect(snapshot.paperDecisions).toHaveLength(6);
    expect(snapshot.paperDecisions.every((decision) => decision.outcome === 'WOULD_BLOCK')).toBe(true);
    expect(await a.stop('COMPLETED', 'TEST_DONE')).toBe(true);
    expect(await store.loadActiveCampaign(ACCOUNT)).toBeNull();
    // Nothing in shadow wrote practical authority state.
    expect(world.practical.operations.filter((op) => op !== 'loadAccount')).toEqual(['initializeAccount']);
  });

  it('only one ACTIVE campaign per account; START_NEW is refused while one is active', async () => {
    const world = await shadowWorld();
    const store = new MemoryPracticalShadowStore();
    await runner(world, store).open('START_NEW');
    expect(await runner(world, store, { workerId: 'worker-b' }).open('START_NEW')).toMatchObject({ kind: 'REFUSED', reason: 'ACTIVE_CAMPAIGN_EXISTS' });
  });

  it('CRASH/RESUME: a crashed CLAIMED evaluation is ABORTED on resume, never counted; the new worker continues the SAME campaign', async () => {
    const world = await shadowWorld();
    const store = new MemoryPracticalShadowStore();
    const a = runner(world, store);
    await a.open('START_NEW');
    await a.runEvaluation();
    // Worker A "crashes" inside its second evaluation: the claim exists, the completion never happens.
    world.scheduler.hold();
    const pending = a.runEvaluation();
    await new Promise((resolve) => setImmediate(resolve));
    expect([...store.evaluations.values()].map((row) => row.status)).toEqual(['COMPLETED', 'CLAIMED']);

    const b = runner(world, store, { workerId: 'worker-b', ownScheduler: true });
    expect(await b.open('RESUME')).toMatchObject({ kind: 'RESUMED', abortedEvaluations: 1, campaign: { workerId: 'worker-b', campaignId: a.campaign!.campaignId } });
    expect([...store.evaluations.values()].map((row) => [row.status, row.abortReason])).toEqual([['COMPLETED', null], ['ABORTED', 'WORKER_REPLACED']]);
    expect(await b.runEvaluation()).toMatchObject({ kind: 'COMPLETED', sequence: 3 });

    // The stale worker wakes up: its completion is refused and it stops collecting.
    world.scheduler.release();
    expect(await pending).toEqual({ kind: 'NOT_COLLECTED', reason: 'STALE_WORKER' });
    expect(a.campaign).toBeNull();
    const snapshot = (await store.snapshotCampaign(b.campaign!.campaignId))!;
    expect(snapshot.evaluations.filter((row) => row.status === 'COMPLETED')).toHaveLength(2);
    // Replaying the resumed campaign is consistent and never double-counts.
    expect(replayPracticalShadowSnapshot(snapshot)).toMatchObject({ consistent: true, evaluationsReplayed: 2, report: { evaluations: { completed: 2, aborted: 1, inProgress: 0 } } });
  });

  it('a campaign whose binding differs is NEVER silently resumed (software, configuration)', async () => {
    const world = await shadowWorld();
    const store = new MemoryPracticalShadowStore();
    await runner(world, store).open('START_NEW');
    expect(await runner(world, store, { workerId: 'worker-b', source: cleanSource(COMMIT_B) }).open('RESUME')).toMatchObject({ kind: 'REFUSED', reason: 'BINDING_MISMATCH', detail: ['softwareVersion'] });
    expect(await runner(world, store, { workerId: 'worker-c', cadenceMs: 120_000 }).open('RESUME_OR_START')).toMatchObject({ kind: 'REFUSED', reason: 'BINDING_MISMATCH', detail: ['configDigest'] });
    expect(await runner(world, store, { workerId: 'worker-d' }).open('RESUME')).toMatchObject({ kind: 'RESUMED' });
  });

  it('runLoop paces evaluations by the cadence (observational) and stops when asked', async () => {
    const world = await shadowWorld();
    const store = new MemoryPracticalShadowStore();
    const a = runner(world, store, { cadenceMs: 120_000 });
    await a.open('START_NEW');
    expect(await a.runLoop({ shouldContinue: () => store.evaluations.size < 3 })).toBe(3);
    const starts = [...store.evaluations.values()].map((row) => JSON.parse(row.result!.evidenceJson).startedAtMs as number);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(120_000);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(120_000);
  });

  it('Tier-B status is configuration DATA only (never an enablement)', () => {
    expect(practicalShadowTierBStatus({}, ACCOUNT)).toEqual({ status: 'DISABLED', disabledReason: 'NOT_EXPLICITLY_ENABLED', accountAllowlisted: false });
    expect(practicalShadowTierBStatus({ LIVE_PRACTICAL_SAFETY_ENABLED: 'true', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: ACCOUNT }, ACCOUNT)).toMatchObject({ status: 'ELIGIBLE', accountAllowlisted: true });
    expect(practicalShadowTierBStatus({ LIVE_PRACTICAL_SAFETY_ENABLED: 'true', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: 'other' }, ACCOUNT)).toMatchObject({ status: 'ELIGIBLE', accountAllowlisted: false });
  });
});

async function collectedSnapshot(evaluations = 2): Promise<PracticalShadowCampaignSnapshot> {
  const world = await shadowWorld({ provenReady: true });
  const store = new MemoryPracticalShadowStore();
  const a = runner(world, store);
  await a.open('START_NEW');
  for (let count = 0; count < evaluations; count += 1) {
    advancePhase18(world);
    await a.runEvaluation();
  }
  return (await store.snapshotCampaign(a.campaign!.campaignId))!;
}

describe('deterministic offline replay', () => {
  it('recomputes every candidate, blocker, and paper decision exactly; the same dataset replays identically', async () => {
    const snapshot = await collectedSnapshot(3);
    // PROVEN_READY test stream: evaluation 1 has no baseline yet; later ones are eligible.
    expect(snapshot.evaluations.map((row) => row.result!.authorityEligible)).toEqual([false, true, true]);
    const first = replayPracticalShadowSnapshot(snapshot);
    expect(first).toMatchObject({ consistent: true, mismatches: [], evaluationsReplayed: 3, paperDecisionsReplayed: 18, grantsAuthority: false });
    expect(JSON.stringify(replayPracticalShadowSnapshot(snapshot))).toBe(JSON.stringify(first));
    expect(first.report.authority.authorityEligible).toEqual({ count: 2, total: 3, permille: 666 });
  });

  it('a stored classification that does not match its evidence is reported as a mismatch', async () => {
    const snapshot = await collectedSnapshot();
    const altered = {
      ...snapshot,
      evaluations: snapshot.evaluations.map((row, index) => (index === 0 ? { ...row, result: { ...row.result!, restStability: 'FAIL' as const, restFailure: 'X' } } : row)),
    };
    const replay = replayPracticalShadowSnapshot(altered);
    expect(replay.consistent).toBe(false);
    expect(replay.mismatches.map((entry) => entry.field)).toEqual(['restStability', 'restFailure']);
  });

  it('changed evidence is TAMPERED; missing evidence is INSUFFICIENT (nothing is invented)', async () => {
    const snapshot = await collectedSnapshot(1);
    const row = snapshot.evaluations[0]!;
    const evidence = JSON.parse(row.result!.evidenceJson);
    const tampered = { ...snapshot, evaluations: [{ ...row, result: { ...row.result!, evidenceJson: JSON.stringify({ ...evidence, endedAtMs: evidence.endedAtMs + 1 }) } }] };
    expect(() => replayPracticalShadowSnapshot(tampered)).toThrow(/SHADOW_EVIDENCE_TAMPERED/);
    const { reads: _reads, ...withoutReads } = evidence;
    const insufficient = { ...snapshot, evaluations: [{ ...row, result: { ...row.result!, evidenceJson: JSON.stringify(withoutReads) } }] };
    expect(() => replayPracticalShadowSnapshot(insufficient)).toThrow(/SHADOW_EVIDENCE_INSUFFICIENT/);
    expect(() => parsePracticalShadowEvidence({ ...evidence, readiness: { ...evidence.readiness, atStart: { ...evidence.readiness.atStart, readiness: 'MAYBE_READY' } } })).toThrow(/SHADOW_EVIDENCE_INSUFFICIENT/);
    // The genuine record parses back to exactly its stored digest.
    expect(practicalShadowEvidenceDigest(parsePracticalShadowEvidence(evidence))).toBe(row.result!.evidenceDigest);
  });

  it('unsupported versions are REFUSED, never reinterpreted (evidence schema, analysis, paper policy)', async () => {
    const snapshot = await collectedSnapshot(1);
    const row = snapshot.evaluations[0]!;
    const evidence = JSON.parse(row.result!.evidenceJson);
    const futureEvidence = { ...snapshot, evaluations: [{ ...row, result: { ...row.result!, evidenceSchemaVersion: 'P18B_SHADOW_EVIDENCE_V2', evidenceJson: JSON.stringify({ ...evidence, schemaVersion: 'P18B_SHADOW_EVIDENCE_V2' }) } }] };
    expect(() => replayPracticalShadowSnapshot(futureEvidence)).toThrow(/SHADOW_UNSUPPORTED_VERSION/);
    expect(() => replayPracticalShadowSnapshot(snapshot, { analysisVersion: 'P18B_SHADOW_ANALYSIS_V9' })).toThrow(/SHADOW_UNSUPPORTED_VERSION/);
    const futurePolicy = { ...snapshot, paperDecisions: snapshot.paperDecisions.map((decision) => ({ ...decision, policyVersion: 'P18B_PAPER_SAFETY_POLICY_V2' })) };
    expect(() => replayPracticalShadowSnapshot(futurePolicy)).toThrow(/SHADOW_UNSUPPORTED_VERSION/);
    const futureConfigBody = { ...JSON.parse(snapshot.campaign.configJson), paperPolicyVersion: 'P18B_PAPER_SAFETY_POLICY_V2' };
    // Re-digested consistently: refused as an unsupported version, never reinterpreted.
    const futureConfig = { ...snapshot, campaign: { ...snapshot.campaign, configJson: JSON.stringify(futureConfigBody), configDigest: sha256CanonicalJson(futureConfigBody) } };
    expect(() => replayPracticalShadowSnapshot(futureConfig)).toThrow(/SHADOW_UNSUPPORTED_VERSION/);
    // Changed WITHOUT its bound digest: tampered.
    expect(() => replayPracticalShadowSnapshot({ ...snapshot, campaign: { ...snapshot.campaign, configJson: JSON.stringify(futureConfigBody) } })).toThrow(/SHADOW_EVIDENCE_TAMPERED/);
  });
});
