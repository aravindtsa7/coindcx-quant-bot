import { describe, expect, it } from 'vitest';
import { PRACTICAL_ACCOUNT_STATES, PRACTICAL_INVALIDATION_REASONS } from '../../../../../src/execution/live/practical/types';
import { PracticalShadowCampaignRunner, abortPracticalShadowCampaign } from '../../../../../src/execution/live/practical-shadow/campaign';
import { collectPracticalShadowEvidence } from '../../../../../src/execution/live/practical-shadow/collector';
import {
  PRACTICAL_SHADOW_EVIDENCE_V1_DOMAINS,
  canonicalPracticalShadowEvidenceJson,
  parsePracticalShadowEvidence,
  practicalShadowEvidenceDigest,
  type PracticalShadowEvidence,
} from '../../../../../src/execution/live/practical-shadow/evidence';
import { buildPracticalShadowCompletion } from '../../../../../src/execution/live/practical-shadow/integrity';
import type { PracticalShadowEvaluationResult, PracticalShadowPaperDecisionRecord } from '../../../../../src/execution/live/practical-shadow/ports';
import { replayPracticalShadowSnapshot } from '../../../../../src/execution/live/practical-shadow/replay';
import { PRACTICAL_SHADOW_STREAM_READINESS } from '../../../../../src/execution/live/practical-shadow/types';
import { sha256CanonicalJson } from '../../../../../src/risk';
import {
  ACCOUNT,
  EPOCH,
  EPOCH_B,
  FINGERPRINT,
  MemoryPracticalShadowStore,
  T0,
  TIER_B_ELIGIBLE,
  advancePhase18,
  cleanSource,
  shadowWorld,
} from './support';

type Json = Record<string, unknown>;

async function claimed() {
  const world = await shadowWorld();
  const store = new MemoryPracticalShadowStore();
  let ids = 0;
  const runner = new PracticalShadowCampaignRunner({
    store, sources: world.sources, config: world.config, accountId: ACCOUNT, expectedProviderAccountFingerprint: FINGERPRINT, runtimeEpoch: EPOCH,
    sourceProvenance: cleanSource(), tierB: TIER_B_ELIGIBLE, workerId: 'worker-a', newId: () => `worker-a-${++ids}`,
  });
  await runner.open('START_NEW');
  const campaignId = runner.campaign!.campaignId;
  advancePhase18(world);
  const evaluationId = 'evaluation-under-test';
  expect((await store.claimEvaluation({ campaignId, workerId: 'worker-a', evaluationId, runtimeEpoch: EPOCH, nowMs: T0 })).kind).toBe('CLAIMED');
  const evidence = await collectPracticalShadowEvidence({
    sources: world.sources, config: world.config, accountId: ACCOUNT, expectedProviderAccountFingerprint: FINGERPRINT, runtimeEpoch: EPOCH,
    campaignId, evaluationId, tierB: TIER_B_ELIGIBLE, generationBaselineFor: () => null,
  });
  const complete = (result: PracticalShadowEvaluationResult, paperDecisions: readonly PracticalShadowPaperDecisionRecord[]) => store.completeEvaluation({ evaluationId, workerId: 'worker-a', result, paperDecisions, nowMs: T0 + 1 });
  const expectRolledBack = async (result: PracticalShadowEvaluationResult, paperDecisions: readonly PracticalShadowPaperDecisionRecord[], pattern: RegExp) => {
    await expect(complete(result, paperDecisions)).rejects.toThrow(pattern);
    expect(store.evaluations.get(evaluationId)).toMatchObject({ status: 'CLAIMED', result: null });
    expect(store.paperDecisions.size).toBe(0);
  };
  /** A self-consistent record (digest, classification, and paper decisions all recomputed) for altered evidence. */
  const forged = (change: (value: Json) => Json) => buildPracticalShadowCompletion(change(JSON.parse(JSON.stringify(evidence)) as Json) as unknown as PracticalShadowEvidence, world.config.paperIntents);
  /** The genuine record with only its evidence JSON replaced (unparsable into a digest: the genuine digest is kept). */
  const withRawEvidence = (change: (value: Json) => Json) => {
    const genuine = buildPracticalShadowCompletion(evidence, world.config.paperIntents);
    return { result: { ...genuine.result, evidenceJson: JSON.stringify(change(JSON.parse(genuine.result.evidenceJson) as Json)) }, paperDecisions: genuine.paperDecisions };
  };
  return { world, store, runner, campaignId, evaluationId, evidence, complete, expectRolledBack, forged, withRawEvidence };
}

// ---------------------------------------------------------------------------
// P18B-C-06: one configured protocol and the claimed runtime
// ---------------------------------------------------------------------------

describe('P18B-C-06 evidence is bound EXACTLY to the configured protocol and to the claimed evaluation runtime', () => {
  it.each([
    ['1. minimumPasses weakened', (e: Json) => ({ ...e, window: { ...(e['window'] as Json), minimumPasses: 1 } }), /window\.minimumPasses/],
    ['2. pass spacing weakened', (e: Json) => ({ ...e, window: { ...(e['window'] as Json), minimumPassSpacingMs: 1 } }), /window\.minimumPassSpacingMs/],
    ['3. certification span weakened', (e: Json) => ({ ...e, window: { ...(e['window'] as Json), minimumCertificationSpanMs: 1 } }), /window\.minimumCertificationSpanMs/],
    ['4. hard pass duration raised', (e: Json) => ({ ...e, timing: { ...(e['timing'] as Json), hardPassDurationMs: 10_000_000 } }), /timing\.hardPassDurationMs/],
    ['5. hard read timeout changed', (e: Json) => ({ ...e, timing: { ...(e['timing'] as Json), hardReadTimeoutMs: 10_000_000 } }), /timing\.hardReadTimeoutMs/],
    ['6. a telemetry candidate changed', (e: Json) => ({ ...e, timing: { ...(e['timing'] as Json), passCandidateMs: 1 } }), /timing\.passCandidateMs/],
    ['6b. a stricter value is refused too (exactly one protocol)', (e: Json) => ({ ...e, window: { ...(e['window'] as Json), minimumPasses: 9 } }), /window\.minimumPasses/],
    ['7. the evidence runtime epoch differs from the claimed evaluation', (e: Json) => ({ ...e, runtimeEpoch: EPOCH_B }), /runtimeEpoch/],
  ])('%s -> refused, zero writes', async (_label, change, field) => {
    const ctx = await claimed();
    const record = ctx.forged(change);
    await ctx.expectRolledBack(record.result, record.paperDecisions, field);
  });

  it('8. a forged ONE-pass REST PASS cannot be persisted under the configured 3-pass campaign', async () => {
    const ctx = await claimed();
    const onePass = ctx.forged((e) => ({
      ...e,
      window: { minimumPasses: 1, minimumPassSpacingMs: 1, minimumCertificationSpanMs: 1 },
      reads: (e['reads'] as Json[]).filter((read) => read['passIndex'] === 1),
      reconciliation: (e['reconciliation'] as Json[]).slice(0, 2),
    }));
    expect(onePass.result.restStability).toBe('PASS');
    await ctx.expectRolledBack(onePass.result, onePass.paperDecisions, /window\.minimumPasses/);
  });

  it('9. the normal collector record completes unchanged', async () => {
    const ctx = await claimed();
    const genuine = buildPracticalShadowCompletion(ctx.evidence, ctx.world.config.paperIntents);
    expect(await ctx.complete(genuine.result, genuine.paperDecisions)).toMatchObject({ kind: 'COMPLETED' });
    expect(ctx.store.paperDecisions.size).toBe(6);
  });

  it('10. replay independently verifies the same protocol and runtime bindings', async () => {
    const ctx = await claimed();
    const genuine = buildPracticalShadowCompletion(ctx.evidence, ctx.world.config.paperIntents);
    await ctx.complete(genuine.result, genuine.paperDecisions);
    const snapshot = (await ctx.store.snapshotCampaign(ctx.campaignId))!;
    expect(replayPracticalShadowSnapshot(snapshot).consistent).toBe(true);
    const row = snapshot.evaluations[0]!;
    const weakened = { ...JSON.parse(row.result!.evidenceJson), window: { minimumPasses: 1, minimumPassSpacingMs: 1, minimumCertificationSpanMs: 1 } };
    const reforged = parsePracticalShadowEvidence(weakened);
    const replaced = { ...row, result: { ...row.result!, evidenceJson: JSON.stringify(reforged), evidenceDigest: practicalShadowEvidenceDigest(reforged) } };
    expect(() => replayPracticalShadowSnapshot({ ...snapshot, evaluations: [replaced] })).toThrow(/window\.minimumPasses/);
    expect(() => replayPracticalShadowSnapshot({ ...snapshot, evaluations: [{ ...row, runtimeEpoch: EPOCH_B }] })).toThrow(/runtimeEpoch/);
  });
});

// ---------------------------------------------------------------------------
// P18B-C-07: a CLOSED V1 evidence schema; canonical safe persistence
// ---------------------------------------------------------------------------

describe('P18B-C-07 V1 evidence is a CLOSED schema and only its canonical safe form is ever persisted', () => {
  it.each([
    ['1. an unknown root field', (e: Json) => ({ ...e, note: 'x' }), /SHADOW_UNSUPPORTED_VERSION/],
    ['2. an unknown nested read field', (e: Json) => ({ ...e, reads: (e['reads'] as Json[]).map((read, index) => (index === 0 ? { ...read, rawOrderPayload: { id: 'o-1', price: '1' } } : read)) }), /SHADOW_UNSUPPORTED_VERSION/],
    ['3. an unknown readiness field', (e: Json) => ({ ...e, readiness: { ...(e['readiness'] as Json), atStart: { ...((e['readiness'] as Json)['atStart'] as Json), subscriptionConfirmation: true } } }), /SHADOW_UNSUPPORTED_VERSION/],
    ['4. an arbitrary read failure code', (e: Json) => ({ ...e, reads: (e['reads'] as Json[]).map((read, index) => (index === 0 ? { ...read, failure: 'HTTP 401 invalid key abc123', contentDigest: null } : read)) }), /SHADOW_EVIDENCE_INSUFFICIENT/],
    ['5. an arbitrary event reason key', (e: Json) => ({ ...e, events: { total: 1, byReason: { 'order o-1 filled at 101.5': 1 } } }), /SHADOW_UNSUPPORTED_VERSION/],
    ['6a. a secret at the root', (e: Json) => ({ ...e, secret: 'API-SECRET-MUST-NEVER-PERSIST' }), /SHADOW_UNSUPPORTED_VERSION/],
    ['6b. a credential inside tierB', (e: Json) => ({ ...e, tierB: { ...(e['tierB'] as Json), apiKey: 'API-KEY-MUST-NEVER-PERSIST' } }), /SHADOW_UNSUPPORTED_VERSION/],
    ['6c. a raw position payload inside a reconciliation sample', (e: Json) => ({ ...e, reconciliation: (e['reconciliation'] as Json[]).map((sample, index) => (index === 0 ? { ...sample, rawPositionPayload: [{ pair: 'B-BTC_USDT' }] } : sample)) }), /SHADOW_UNSUPPORTED_VERSION/],
    ['an unknown Phase 18 status', (e: Json) => ({ ...e, reconciliation: (e['reconciliation'] as Json[]).map((sample, index) => (index === 0 ? { ...sample, status: 'SOMETHING_ELSE' } : sample)) }), /SHADOW_EVIDENCE_INSUFFICIENT/],
    ['an unknown practical account state', (e: Json) => ({ ...e, practicalAccount: { ...(e['practicalAccount'] as Json), state: 'STRICT_CONTINUITY' } }), /SHADOW_EVIDENCE_INSUFFICIENT/],
    ['an unknown fence mode', (e: Json) => ({ ...e, practicalAccount: { ...(e['practicalAccount'] as Json), fenceMode: 'ARMED' } }), /SHADOW_EVIDENCE_INSUFFICIENT/],
    ['an unknown Tier-B disabled reason', (e: Json) => ({ ...e, tierB: { status: 'DISABLED', disabledReason: 'because I said so', accountAllowlisted: false } }), /SHADOW_EVIDENCE_INSUFFICIENT/],
    ['an unknown stream-health trip', (e: Json) => ({ ...e, streamHealthTrip: 'PROVIDER_SAID_OK' }), /SHADOW_EVIDENCE_INSUFFICIENT/],
    ['an unknown UNPROVEN reason', (e: Json) => ({ ...e, readiness: { ...(e['readiness'] as Json), atStart: { ...((e['readiness'] as Json)['atStart'] as Json), unprovenReason: 'TRUST_ME' } } }), /SHADOW_EVIDENCE_INSUFFICIENT/],
    ['a non-hex content digest', (e: Json) => ({ ...e, reads: (e['reads'] as Json[]).map((read, index) => (index === 1 ? { ...read, contentDigest: '{"orders":[]}' } : read)) }), /SHADOW_EVIDENCE_INSUFFICIENT/],
    ['an event total that disagrees with its counts', (e: Json) => ({ ...e, events: { total: 7, byReason: {} } }), /SHADOW_EVIDENCE_INSUFFICIENT/],
    ['a missing field', (e: Json) => { const { tierB: _tierB, ...rest } = e; return rest; }, /SHADOW_EVIDENCE_INSUFFICIENT/],
  ])('%s is refused by the parser AND by the store (zero writes; nothing survives into the dataset)', async (_label, change, pattern) => {
    const ctx = await claimed();
    const raw = change(JSON.parse(JSON.stringify(ctx.evidence)) as Json);
    expect(() => parsePracticalShadowEvidence(raw)).toThrow(pattern);
    const record = ctx.withRawEvidence(change);
    await ctx.expectRolledBack(record.result, record.paperDecisions, pattern);
    expect(JSON.stringify([...ctx.store.evaluations.values()])).not.toMatch(/SECRET|API-KEY|rawOrderPayload|rawPositionPayload/);
  });

  it('8. normal collector output round-trips unchanged through the closed parser', async () => {
    const ctx = await claimed();
    const parsed = parsePracticalShadowEvidence(JSON.parse(JSON.stringify(ctx.evidence)));
    expect(parsed).toEqual(ctx.evidence);
    expect(practicalShadowEvidenceDigest(parsed)).toBe(practicalShadowEvidenceDigest(ctx.evidence));
    expect(canonicalPracticalShadowEvidenceJson(parsed)).toBe(JSON.stringify(parsed));
  });

  it('10. the stored evidenceJson is EXACTLY the canonical rebuilt record whose digest is stored, even when the caller sent another serialization', async () => {
    const ctx = await claimed();
    const genuine = buildPracticalShadowCompletion(ctx.evidence, ctx.world.config.paperIntents);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(genuine.result.evidenceJson) as Json).reverse()));
    expect(reordered).not.toBe(genuine.result.evidenceJson);
    expect(await ctx.complete({ ...genuine.result, evidenceJson: reordered }, genuine.paperDecisions)).toMatchObject({ kind: 'COMPLETED' });
    const stored = ctx.store.evaluations.get(ctx.evaluationId)!.result!;
    const reparsed = parsePracticalShadowEvidence(JSON.parse(stored.evidenceJson));
    expect(stored.evidenceJson).toBe(canonicalPracticalShadowEvidenceJson(reparsed));
    expect(stored.evidenceJson).toBe(genuine.result.evidenceJson);
    expect(stored.evidenceDigest).toBe(practicalShadowEvidenceDigest(reparsed));
  });

  it('9. replay refuses stored open-world evidence rather than silently dropping its extra fields', async () => {
    const ctx = await claimed();
    const genuine = buildPracticalShadowCompletion(ctx.evidence, ctx.world.config.paperIntents);
    await ctx.complete(genuine.result, genuine.paperDecisions);
    const snapshot = (await ctx.store.snapshotCampaign(ctx.campaignId))!;
    const row = snapshot.evaluations[0]!;
    const openWorld = { ...row, result: { ...row.result!, evidenceJson: JSON.stringify({ ...JSON.parse(row.result!.evidenceJson), rawOrderPayload: [{ id: 'o-1' }] }) } };
    expect(() => replayPracticalShadowSnapshot({ ...snapshot, evaluations: [openWorld] })).toThrow(/SHADOW_UNSUPPORTED_VERSION/);
  });

  it('the closed V1 domains cover exactly what the collector can produce', () => {
    const D = PRACTICAL_SHADOW_EVIDENCE_V1_DOMAINS;
    expect([...D.practicalAccountStates].sort()).toEqual([...PRACTICAL_ACCOUNT_STATES].sort());
    for (const reason of [...D.eventReasons.filter((entry) => entry !== 'NOISE'), ...D.streamHealthTrips]) {
      expect(PRACTICAL_INVALIDATION_REASONS as readonly string[]).toContain(reason);
    }
    expect(PRACTICAL_SHADOW_STREAM_READINESS).toEqual(['PROVEN_READY', 'UNPROVEN', 'RECONCILIATION_REQUIRED', 'DISCONNECTED']);
    expect(Object.isFrozen(D)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P18B-C-08: a corrupted campaign is never resumed
// ---------------------------------------------------------------------------

describe('P18B-C-08 resume validates the stored configuration BEFORE any write; the explicit abort still works', () => {
  it('a tampered, future-versioned, or malformed stored configuration is never resumed; nothing changes; abort still ends it', async () => {
    const ctx = await claimed();
    const original = ctx.store.campaigns.get(ctx.campaignId)!;
    const config = JSON.parse(original.configJson) as Json;
    for (const [configJson, configDigest, pattern] of [
      [JSON.stringify({ ...config, cadenceMs: 120_000 }), original.configDigest, /SHADOW_EVIDENCE_TAMPERED/],
      [JSON.stringify({ ...config, analysisVersion: 'P18B_SHADOW_ANALYSIS_V9' }), null, /SHADOW_UNSUPPORTED_VERSION/],
      ['{not json', original.configDigest, /SHADOW_EVIDENCE_INSUFFICIENT/],
    ] as const) {
      const corrupted = { ...original, configJson, configDigest: configDigest ?? sha256CanonicalJson(JSON.parse(configJson)) };
      ctx.store.campaigns.set(ctx.campaignId, corrupted);
      const before = JSON.stringify([[...ctx.store.campaigns.values()], [...ctx.store.evaluations.values()]]);
      const resumer = new PracticalShadowCampaignRunner({
        store: ctx.store, sources: ctx.world.sources, config: ctx.world.config, accountId: ACCOUNT, expectedProviderAccountFingerprint: FINGERPRINT, runtimeEpoch: EPOCH,
        sourceProvenance: cleanSource(), tierB: TIER_B_ELIGIBLE, workerId: 'worker-b',
      });
      await expect(resumer.open('RESUME')).rejects.toThrow(pattern);
      // No owner change, no revision change, the old CLAIMED evaluation is still CLAIMED.
      expect(JSON.stringify([[...ctx.store.campaigns.values()], [...ctx.store.evaluations.values()]])).toBe(before);
      expect(ctx.store.evaluations.get(ctx.evaluationId)!.status).toBe('CLAIMED');
    }
    expect(await abortPracticalShadowCampaign({ store: ctx.store, accountId: ACCOUNT, campaignId: ctx.campaignId, reason: 'CONFIG_CORRUPTED', nowMs: T0 + 5 })).toMatchObject({ kind: 'ABORTED', abortedEvaluations: 1 });
  });
});
