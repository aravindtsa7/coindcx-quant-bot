import { describe, expect, it } from 'vitest';
import { PracticalShadowCampaignRunner } from '../../../../../src/execution/live/practical-shadow/campaign';
import { collectPracticalShadowEvidence } from '../../../../../src/execution/live/practical-shadow/collector';
import { parsePracticalShadowConfigSnapshot } from '../../../../../src/execution/live/practical-shadow/config';
import { practicalShadowEvidenceDigest } from '../../../../../src/execution/live/practical-shadow/evidence';
import { buildPracticalShadowCompletion } from '../../../../../src/execution/live/practical-shadow/integrity';
import type { PracticalShadowEvaluationResult, PracticalShadowPaperDecisionRecord } from '../../../../../src/execution/live/practical-shadow/ports';
import { replayPracticalShadowSnapshot } from '../../../../../src/execution/live/practical-shadow/replay';
import { sha256CanonicalJson } from '../../../../../src/risk';
import {
  ACCOUNT,
  COMMIT_A,
  EPOCH,
  FINGERPRINT,
  MemoryPracticalShadowStore,
  OTHER_FINGERPRINT,
  T0,
  TIER_B_ELIGIBLE,
  advancePhase18,
  cleanSource,
  shadowConfig,
  shadowWorld,
} from './support';

async function openCampaign(options: Parameters<typeof shadowWorld>[0] = {}) {
  const world = await shadowWorld(options);
  const store = new MemoryPracticalShadowStore();
  let ids = 0;
  const runner = new PracticalShadowCampaignRunner({
    store, sources: world.sources, config: world.config, accountId: ACCOUNT, expectedProviderAccountFingerprint: FINGERPRINT, runtimeEpoch: EPOCH,
    sourceProvenance: cleanSource(), tierB: TIER_B_ELIGIBLE, workerId: 'worker-a', newId: () => `worker-a-${++ids}`,
  });
  await runner.open('START_NEW');
  return { world, store, runner, campaignId: runner.campaign!.campaignId };
}

// ---------------------------------------------------------------------------
// P18B-C-03: the persisted configuration is bound to its digest and versions
// ---------------------------------------------------------------------------

describe('P18B-C-03 persisted configuration: digest-bound and version-checked before any use', () => {
  const config = shadowConfig({ cadenceMs: 300_000 });
  const json = JSON.stringify(config.snapshot);
  const body = (): Record<string, unknown> => JSON.parse(json) as Record<string, unknown>;

  it('a valid snapshot with its matching digest parses (same canonical hashing that created it)', () => {
    expect(config.digest).toBe(sha256CanonicalJson(config.snapshot));
    const parsed = parsePracticalShadowConfigSnapshot(json, config.digest);
    expect(parsed).toMatchObject({ cadenceMs: 300_000, digest: config.digest, provider: { restOrigin: 'https://rest.shadow.invalid', streamEndpoint: 'wss://stream.shadow.invalid' } });
    expect(parsed.paperIntents).toHaveLength(6);
    expect(parsed.calibrationReview.status).toBe('PROVISIONAL_HUMAN_REVIEW_CRITERIA');
  });

  it.each([
    ['the cadence', (value: Record<string, unknown>) => ({ ...value, cadenceMs: 60_000 })],
    ['the review criteria', (value: Record<string, unknown>) => ({ ...value, calibrationReview: { ...(value['calibrationReview'] as object), minimumDurationMs: 1, minimumCompletedEvaluations: 1, minimumCoveragePermille: 1 } })],
    ['a paper intent', (value: Record<string, unknown>) => ({ ...value, paperIntents: [{ action: 'CANCEL', stage: 'STAGE_5A_CANCEL_ONLY' }] })],
    ['the provider endpoint', (value: Record<string, unknown>) => ({ ...value, provider: { restOrigin: 'https://other.example', streamEndpoint: 'wss://stream.shadow.invalid' } })],
    ['the timing metadata', (value: Record<string, unknown>) => ({ ...value, timing: { ...(value['timing'] as object), readCandidateMs: 1 } })],
  ])('%s changed while the OLD digest is kept -> SHADOW_EVIDENCE_TAMPERED', (_label, change) => {
    expect(() => parsePracticalShadowConfigSnapshot(JSON.stringify(change(body())), config.digest)).toThrow(/SHADOW_EVIDENCE_TAMPERED/);
  });

  it.each([
    ['an unsupported persisted analysis version', { analysisVersion: 'P18B_SHADOW_ANALYSIS_V9' }],
    ['a future config schema', { schema: 'P18B_SHADOW_CONFIG_V2' }],
    ['an unsupported evidence schema', { evidenceSchemaVersion: 'P18B_SHADOW_EVIDENCE_V2' }],
    ['an unsupported paper policy', { paperPolicyVersion: 'P18B_PAPER_SAFETY_POLICY_V2' }],
    ['an unknown extra field', { futureKnob: 1 }],
  ])('%s is SHADOW_UNSUPPORTED_VERSION even with a consistent digest (never reinterpreted)', (_label, change) => {
    const changed = { ...body(), ...change };
    expect(() => parsePracticalShadowConfigSnapshot(JSON.stringify(changed), sha256CanonicalJson(changed))).toThrow(/SHADOW_UNSUPPORTED_VERSION/);
  });

  it('unlabelled review criteria are refused; a malformed digest is refused before parsing', () => {
    const unlabelled = { ...body(), calibrationReview: { ...(body()['calibrationReview'] as object), status: 'CALIBRATED_THRESHOLD' } };
    expect(() => parsePracticalShadowConfigSnapshot(JSON.stringify(unlabelled), sha256CanonicalJson(unlabelled))).toThrow(/SHADOW_UNSUPPORTED_VERSION/);
    expect(() => parsePracticalShadowConfigSnapshot(json, config.digest.toUpperCase())).toThrow(/SHADOW_EVIDENCE_TAMPERED/);
    expect(() => parsePracticalShadowConfigSnapshot('not json', config.digest)).toThrow(/SHADOW_EVIDENCE_INSUFFICIENT/);
  });

  it('replay refuses a config-tampered campaign (it can never be marked human-review eligible) and a persisted analysis version it does not implement', async () => {
    const { world, store, runner, campaignId } = await openCampaign();
    advancePhase18(world);
    await runner.runEvaluation();
    const snapshot = (await store.snapshotCampaign(campaignId))!;
    expect(replayPracticalShadowSnapshot(snapshot).report.coverage.eligibleForHumanCalibrationReview).toBe(false);
    const lenient = { ...JSON.parse(snapshot.campaign.configJson), calibrationReview: { status: 'PROVISIONAL_HUMAN_REVIEW_CRITERIA', minimumDurationMs: 1, minimumCompletedEvaluations: 1, minimumCoveragePermille: 1 } };
    expect(() => replayPracticalShadowSnapshot({ ...snapshot, campaign: { ...snapshot.campaign, configJson: JSON.stringify(lenient) } })).toThrow(/SHADOW_EVIDENCE_TAMPERED/);
    const future = { ...JSON.parse(snapshot.campaign.configJson), analysisVersion: 'P18B_SHADOW_ANALYSIS_V2' };
    expect(() => replayPracticalShadowSnapshot({ ...snapshot, campaign: { ...snapshot.campaign, configJson: JSON.stringify(future), configDigest: sha256CanonicalJson(future) } })).toThrow(/SHADOW_UNSUPPORTED_VERSION/);
  });

  it('the store refuses to start a campaign whose configJson and configDigest disagree (zero writes)', async () => {
    const store = new MemoryPracticalShadowStore();
    const other = shadowConfig({ cadenceMs: 120_000 });
    const binding = { accountId: ACCOUNT, providerAccountFingerprint: FINGERPRINT, softwareVersion: COMMIT_A, sourceProvenance: 'GIT_CLEAN_COMMIT' as const, configDigest: config.digest, evidenceSchemaVersion: 'P18B_SHADOW_EVIDENCE_V1' };
    await expect(store.startCampaign({ campaignId: 'campaign-x', binding, configJson: JSON.stringify(other.snapshot), workerId: 'worker-a', nowMs: T0 })).rejects.toThrow(/SHADOW_EVIDENCE_TAMPERED/);
    expect(store.campaigns.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P18B-C-04: evidence and paper decisions are cross-bound before completion
// ---------------------------------------------------------------------------

describe('P18B-C-04 a completion must tell exactly the story of its own evidence (else the whole completion rolls back)', () => {
  async function claimed(options: Parameters<typeof shadowWorld>[0] = {}) {
    const context = await openCampaign(options);
    advancePhase18(context.world);
    const evaluationId = 'evaluation-under-test';
    const claim = await context.store.claimEvaluation({ campaignId: context.campaignId, workerId: 'worker-a', evaluationId, runtimeEpoch: EPOCH, nowMs: T0 });
    expect(claim.kind).toBe('CLAIMED');
    const collect = (overrides: { readonly accountId?: string; readonly expectedProviderAccountFingerprint?: string; readonly evaluationId?: string; readonly campaignId?: string } = {}) => collectPracticalShadowEvidence({
      sources: context.world.sources, config: context.world.config, accountId: ACCOUNT, expectedProviderAccountFingerprint: FINGERPRINT, runtimeEpoch: EPOCH,
      campaignId: context.campaignId, evaluationId, tierB: TIER_B_ELIGIBLE, generationBaselineFor: () => null, ...overrides,
    });
    const complete = (result: PracticalShadowEvaluationResult, paperDecisions: readonly PracticalShadowPaperDecisionRecord[]) => context.store.completeEvaluation({
      evaluationId, workerId: 'worker-a', result, paperDecisions, nowMs: T0 + 1,
    });
    const expectRolledBack = async (result: PracticalShadowEvaluationResult, paperDecisions: readonly PracticalShadowPaperDecisionRecord[], pattern = /SHADOW_EVIDENCE_TAMPERED/) => {
      const paperBefore = context.store.paperDecisions.size;
      await expect(complete(result, paperDecisions)).rejects.toThrow(pattern);
      expect(context.store.evaluations.get(evaluationId)).toMatchObject({ status: 'CLAIMED', result: null });
      expect(context.store.paperDecisions.size).toBe(paperBefore);
    };
    return { ...context, evaluationId, collect, complete, expectRolledBack };
  }

  it('10. the normal collector completion is unchanged and recorded', async () => {
    const ctx = await claimed();
    const { result, paperDecisions } = buildPracticalShadowCompletion(await ctx.collect(), ctx.world.config.paperIntents);
    expect(await ctx.complete(result, paperDecisions)).toMatchObject({ kind: 'COMPLETED' });
    expect(ctx.store.paperDecisions.size).toBe(6);
  });

  it.each([
    ['1. evidence from account B', { accountId: 'account-B' }, /accountId/],
    ['2. fingerprint B under campaign A', { expectedProviderAccountFingerprint: OTHER_FINGERPRINT }, /expectedProviderAccountFingerprint/],
    ['3. evidence naming another evaluation', { evaluationId: 'evaluation-other' }, /evaluationId/],
    ['evidence naming another campaign', { campaignId: 'campaign-other' }, /campaignId/],
  ])('%s (self-consistent digest) is refused', async (_label, overrides, field) => {
    const ctx = await claimed();
    const { result, paperDecisions } = buildPracticalShadowCompletion(await ctx.collect(overrides), ctx.world.config.paperIntents);
    await ctx.expectRolledBack(result, paperDecisions, field);
  });

  it('4. evidence JSON changed without its digest, and 5. evidence + digest both re-forged for another account, are refused', async () => {
    const ctx = await claimed();
    const genuine = buildPracticalShadowCompletion(await ctx.collect(), ctx.world.config.paperIntents);
    const evidence = JSON.parse(genuine.result.evidenceJson);
    await ctx.expectRolledBack({ ...genuine.result, evidenceJson: JSON.stringify({ ...evidence, endedAtMs: evidence.endedAtMs + 1 }) }, genuine.paperDecisions);
    const foreign = { ...evidence, accountId: 'account-B' };
    await ctx.expectRolledBack({ ...genuine.result, evidenceJson: JSON.stringify(foreign), evidenceDigest: practicalShadowEvidenceDigest(foreign) }, genuine.paperDecisions, /accountId/);
    // Unparsable / incomplete evidence is refused too.
    await ctx.expectRolledBack({ ...genuine.result, evidenceJson: '{}' }, genuine.paperDecisions, /SHADOW_EVIDENCE_INSUFFICIENT/);
  });

  it('a top-level result field that disagrees with the evidence is refused', async () => {
    const ctx = await claimed();
    const genuine = buildPracticalShadowCompletion(await ctx.collect(), ctx.world.config.paperIntents);
    await ctx.expectRolledBack({ ...genuine.result, streamReadiness: 'PROVEN_READY' }, genuine.paperDecisions, /streamReadiness/);
    await ctx.expectRolledBack({ ...genuine.result, restStability: 'FAIL', restFailure: 'BRACKET_DISAGREEMENT' }, genuine.paperDecisions, /restStability/);
    await ctx.expectRolledBack({ ...genuine.result, blockers: [] }, genuine.paperDecisions, /blockers/);
    await ctx.expectRolledBack({ ...genuine.result, reconciliationGeneration: 999 }, genuine.paperDecisions, /reconciliationGeneration/);
  });

  it('6. UNPROVEN evaluation + forged PROVEN_READY paper decision, and 7. ineligible authority + WOULD_REACH_AUTHORITY_GATE, are refused', async () => {
    const ctx = await claimed();
    const genuine = buildPracticalShadowCompletion(await ctx.collect(), ctx.world.config.paperIntents);
    expect(genuine.result).toMatchObject({ streamReadiness: 'UNPROVEN', authorityEligible: false });
    const forge = (index: number, change: Partial<PracticalShadowPaperDecisionRecord>) => genuine.paperDecisions.map((decision, position) => (position === index ? { ...decision, ...change } : decision));
    const cancel5a = genuine.paperDecisions.findIndex((decision) => decision.requestedAction === 'CANCEL' && decision.rolloutStage === 'STAGE_5A_CANCEL_ONLY');
    await ctx.expectRolledBack(genuine.result, forge(cancel5a, { streamReadiness: 'PROVEN_READY' }), /CANCEL@STAGE_5A_CANCEL_ONLY:streamReadiness/);
    await ctx.expectRolledBack(genuine.result, forge(cancel5a, { outcome: 'WOULD_REACH_AUTHORITY_GATE', blockers: [] }), /CANCEL@STAGE_5A_CANCEL_ONLY:outcome/);
    await ctx.expectRolledBack(genuine.result, forge(cancel5a, { authorityPrerequisitesMet: true }), /authorityPrerequisitesMet/);
    await ctx.expectRolledBack(genuine.result, forge(cancel5a, { createdAtMs: 1 }), /createdAtMs/);
    await ctx.expectRolledBack(genuine.result, forge(cancel5a, { policyVersion: 'P18B_PAPER_SAFETY_POLICY_V2' }), /policyVersion/);
    await ctx.expectRolledBack(genuine.result, forge(cancel5a, { paperDecisionId: `pd-${'0'.repeat(48)}` }), /missing/);
  });

  it('8. a missing expected decision, 9. an extra decision, and a duplicate action/stage are refused', async () => {
    const ctx = await claimed({ config: { cadenceMs: 60_000, paperIntents: [{ action: 'CANCEL', stage: 'STAGE_5A_CANCEL_ONLY' }] } });
    const evidence = await ctx.collect();
    const genuine = buildPracticalShadowCompletion(evidence, ctx.world.config.paperIntents);
    expect(genuine.paperDecisions).toHaveLength(1);
    await ctx.expectRolledBack(genuine.result, [], /CANCEL@STAGE_5A_CANCEL_ONLY:missing/);
    const unconfigured = buildPracticalShadowCompletion(evidence, shadowConfig().paperIntents).paperDecisions.find((decision) => decision.requestedAction === 'OPEN')!;
    await ctx.expectRolledBack(genuine.result, [...genuine.paperDecisions, unconfigured], /OPEN@STAGE_5A_CANCEL_ONLY:unexpected/);
    await ctx.expectRolledBack(genuine.result, [...genuine.paperDecisions, genuine.paperDecisions[0]!], /duplicate/);
    // 11. After every refusal the evaluation is still CLAIMED with zero paper rows, and the genuine record then completes.
    expect(await ctx.complete(genuine.result, genuine.paperDecisions)).toMatchObject({ kind: 'COMPLETED' });
  });

  it('replay independently refuses evidence that is not bound to the campaign (a self-consistent digest from another account is never analysed)', async () => {
    const { world, store, runner, campaignId } = await openCampaign();
    advancePhase18(world);
    await runner.runEvaluation();
    const snapshot = (await store.snapshotCampaign(campaignId))!;
    const row = snapshot.evaluations[0]!;
    const foreign = { ...JSON.parse(row.result!.evidenceJson), accountId: 'account-B' };
    const forged = { ...row, result: { ...row.result!, evidenceJson: JSON.stringify(foreign), evidenceDigest: practicalShadowEvidenceDigest(foreign) } };
    expect(() => replayPracticalShadowSnapshot({ ...snapshot, evaluations: [forged] })).toThrow(/SHADOW_EVIDENCE_TAMPERED.*accountId/);
    expect(() => replayPracticalShadowSnapshot({ ...snapshot, campaign: { ...snapshot.campaign, providerAccountFingerprint: OTHER_FINGERPRINT } })).toThrow(/expectedProviderAccountFingerprint/);
    // An extra stored paper row is reported, never silently accepted.
    const extra = { ...snapshot.paperDecisions[0]!, paperDecisionId: `pd-${'1'.repeat(48)}` };
    expect(replayPracticalShadowSnapshot({ ...snapshot, paperDecisions: [...snapshot.paperDecisions, extra] }).consistent).toBe(false);
  });
});
