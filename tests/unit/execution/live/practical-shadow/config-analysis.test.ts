import { describe, expect, it } from 'vitest';
import { PRACTICAL_SAFETY_CEILINGS, PRACTICAL_TIMING_CANDIDATES } from '../../../../../src/execution/live/practical/policy';
import { PRACTICAL_RECOVERY_HARD_CEILINGS } from '../../../../../src/execution/live/practical-recovery/timing';
import {
  PRACTICAL_SHADOW_RECOMMENDATION_MIN_SAMPLES,
  analysePracticalShadowCampaign,
  type PracticalShadowAnalysedEvaluation,
} from '../../../../../src/execution/live/practical-shadow/analysis';
import { classifyPracticalShadowEvaluation } from '../../../../../src/execution/live/practical-shadow/classification';
import { collectPracticalShadowEvidence } from '../../../../../src/execution/live/practical-shadow/collector';
import { PRACTICAL_SHADOW_PROVISIONAL_REVIEW_CRITERIA, PRACTICAL_SHADOW_REVIEW_CRITERIA_STATUS, resolvePracticalShadowConfig } from '../../../../../src/execution/live/practical-shadow/config';
import { ACCOUNT, COMMIT_A, EPOCH, FINGERPRINT, T0, TEST_PROVIDER, TIER_B_ELIGIBLE, advancePhase18, shadowWorld, type ShadowWorld } from './support';

describe('shadow configuration (observational only)', () => {
  it('the window and timing values are taken VERBATIM from Stage 1A and Checkpoint B; the default review rule is 14 days', () => {
    const config = resolvePracticalShadowConfig({ provider: TEST_PROVIDER, cadenceMs: 300_000 });
    expect(config.window).toEqual({
      minimumPasses: PRACTICAL_SAFETY_CEILINGS.minimumPasses,
      minimumPassSpacingMs: PRACTICAL_SAFETY_CEILINGS.minimumPassSpacingMs,
      minimumCertificationSpanMs: PRACTICAL_SAFETY_CEILINGS.minimumCertificationSpanMs,
    });
    expect(config.timing).toEqual({
      readCandidateMs: PRACTICAL_TIMING_CANDIDATES.readDuration.valueMs,
      passCandidateMs: PRACTICAL_TIMING_CANDIDATES.passWindow.valueMs,
      interReadGapCandidateMs: PRACTICAL_TIMING_CANDIDATES.interReadGap.valueMs,
      hardReadTimeoutMs: PRACTICAL_RECOVERY_HARD_CEILINGS.readTimeoutMs,
      hardPassDurationMs: PRACTICAL_RECOVERY_HARD_CEILINGS.passDurationMs,
    });
    expect(config.calibrationReview).toEqual(PRACTICAL_SHADOW_PROVISIONAL_REVIEW_CRITERIA);
    // PROVISIONAL human-review criteria (not authority requirements, CoinDCX guarantees, or calibrated thresholds).
    expect(PRACTICAL_SHADOW_PROVISIONAL_REVIEW_CRITERIA).toEqual({
      status: 'PROVISIONAL_HUMAN_REVIEW_CRITERIA', minimumDurationMs: 14 * 24 * 60 * 60 * 1000, minimumCompletedEvaluations: 1_000, minimumCoveragePermille: 800,
    });
    expect(Object.isFrozen(PRACTICAL_SHADOW_PROVISIONAL_REVIEW_CRITERIA)).toBe(true);
    expect(config.snapshot['calibrationReview']).toMatchObject({ status: PRACTICAL_SHADOW_REVIEW_CRITERIA_STATUS });
    expect(resolvePracticalShadowConfig({ provider: TEST_PROVIDER, cadenceMs: 60_000, calibrationReview: { minimumCompletedEvaluations: 5 } }).calibrationReview.status).toBe('PROVISIONAL_HUMAN_REVIEW_CRITERIA');
    expect(config.paperIntents).toHaveLength(6);
    expect(config.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['a non-integer cadence', { cadenceMs: 60_000.5 }],
    ['a zero cadence', { cadenceMs: 0 }],
    ['a cadence shorter than two certification spans', { cadenceMs: 2 * PRACTICAL_SAFETY_CEILINGS.minimumCertificationSpanMs - 1 }],
    ['a cadence longer than a day', { cadenceMs: 86_400_001 }],
    ['an unknown paper action', { cadenceMs: 60_000, paperIntents: [{ action: 'MODIFY', stage: 'STAGE_5A_CANCEL_ONLY' }] }],
    ['an unknown rollout stage', { cadenceMs: 60_000, paperIntents: [{ action: 'CANCEL', stage: 'STAGE_6' }] }],
    ['a duplicate paper intent', { cadenceMs: 60_000, paperIntents: [{ action: 'CANCEL', stage: 'STAGE_5A_CANCEL_ONLY' }, { action: 'CANCEL', stage: 'STAGE_5A_CANCEL_ONLY' }] }],
    ['a coverage rule above 1000 permille', { cadenceMs: 60_000, calibrationReview: { minimumCoveragePermille: 1_001 } }],
    ['no provider descriptor', { cadenceMs: 60_000, provider: undefined }],
    ['a plain-http REST origin', { cadenceMs: 60_000, provider: { restOrigin: 'http://rest.shadow.invalid', streamEndpoint: 'wss://stream.shadow.invalid' } }],
    ['a REST origin carrying credentials', { cadenceMs: 60_000, provider: { restOrigin: 'https://user:pass@rest.shadow.invalid', streamEndpoint: 'wss://stream.shadow.invalid' } }],
    ['a REST origin with a path or query', { cadenceMs: 60_000, provider: { restOrigin: 'https://rest.shadow.invalid/v2?x=1', streamEndpoint: 'wss://stream.shadow.invalid' } }],
    ['a non-wss stream endpoint', { cadenceMs: 60_000, provider: { restOrigin: 'https://rest.shadow.invalid', streamEndpoint: 'https://stream.shadow.invalid' } }],
  ])('%s is refused', (_label, input) => {
    expect(() => resolvePracticalShadowConfig({ provider: TEST_PROVIDER, ...(input as object) } as never)).toThrow(/SHADOW_CONFIG_INVALID/);
  });

  it('the configuration digest binds the cadence, the intents, and the review rules', () => {
    const base = resolvePracticalShadowConfig({ provider: TEST_PROVIDER, cadenceMs: 60_000 }).digest;
    expect(resolvePracticalShadowConfig({ provider: TEST_PROVIDER, cadenceMs: 60_000 }).digest).toBe(base);
    expect(resolvePracticalShadowConfig({ provider: TEST_PROVIDER, cadenceMs: 120_000 }).digest).not.toBe(base);
    expect(resolvePracticalShadowConfig({ provider: TEST_PROVIDER, cadenceMs: 60_000, paperIntents: [{ action: 'CANCEL', stage: 'STAGE_5A_CANCEL_ONLY' }] }).digest).not.toBe(base);
    expect(resolvePracticalShadowConfig({ provider: TEST_PROVIDER, cadenceMs: 60_000, calibrationReview: { minimumCompletedEvaluations: 5 } }).digest).not.toBe(base);
  });
});

async function analysed(world: ShadowWorld, sequence: number): Promise<PracticalShadowAnalysedEvaluation> {
  const evidence = await collectPracticalShadowEvidence({
    sources: world.sources, config: world.config, accountId: ACCOUNT, expectedProviderAccountFingerprint: FINGERPRINT, runtimeEpoch: EPOCH,
    campaignId: 'campaign-1', evaluationId: `evaluation-${sequence}`, tierB: TIER_B_ELIGIBLE, generationBaselineFor: () => 0,
  });
  const classification = classifyPracticalShadowEvaluation(evidence, world.config.paperIntents);
  return {
    sequence, evidence, restStability: classification.rest.result, restFailure: classification.rest.failure,
    authorityEligible: classification.authority.authorityEligible, blockers: classification.authority.blockers, primaryBlocker: classification.authority.primaryBlocker,
  };
}

describe('calibration analysis', () => {
  it('nearest-rank percentiles over integer samples', async () => {
    const world = await shadowWorld();
    advancePhase18(world);
    // Reads at 100 ms each: 21 reads per evaluation.
    const evaluations = [await analysed(world, 1), await analysed(world, 2)];
    const report = analysePracticalShadowCampaign({
      campaign: { campaignId: 'campaign-1', status: 'ACTIVE', startedAtMs: T0, sourceProvenance: 'GIT_CLEAN_COMMIT', softwareVersion: COMMIT_A, cadenceMs: 60_000, calibrationReview: PRACTICAL_SHADOW_PROVISIONAL_REVIEW_CRITERIA },
      completed: evaluations, abortedEvaluations: 1, inProgressEvaluations: 0, cutoffSequence: 3,
    });
    expect(report.reads.latencyMs).toEqual({ count: 42, min: 100, p50: 100, p90: 100, p95: 100, p99: 100, max: 100 });
    expect(report.passes.durationMs).toMatchObject({ count: 6, min: 700, max: 700 });
    expect(report.passes.bracketPass).toEqual({ count: 6, total: 6, permille: 1000 });
    expect(report.evidence.restStabilityPass).toEqual({ count: 2, total: 2, permille: 1000 });
    expect(report.authority.authorityEligible).toEqual({ count: 0, total: 2, permille: 0 });
    expect(report.authority.primaryBlockers).toEqual({ PRIVATE_STREAM_READINESS_UNPROVEN: 2 });
    expect(report.stream.readinessAtStart).toEqual({ UNPROVEN: 2 });
    expect(report.evaluations).toEqual({ completed: 2, aborted: 1, inProgress: 0 });
    expect(report.grantsAuthority).toBe(false);
  });

  it('distribution arithmetic: p50/p90/p95/p99 by nearest rank', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    const evidence = { reads: values.map((latencyMs) => ({ passIndex: 1, slot: 'O1', kind: 'ORDERS', startedAtMs: 0, endedAtMs: latencyMs, latencyMs, failure: null, pagesRead: 1, complete: true, contentDigest: 'x' })) };
    const report = analysePracticalShadowCampaign({
      campaign: { campaignId: 'c', status: 'ACTIVE', startedAtMs: 0, sourceProvenance: 'GIT_CLEAN_COMMIT', softwareVersion: COMMIT_A, cadenceMs: 60_000, calibrationReview: PRACTICAL_SHADOW_PROVISIONAL_REVIEW_CRITERIA },
      completed: [{
        sequence: 1, restStability: 'FAIL', restFailure: 'MALFORMED_RESPONSE', authorityEligible: false, blockers: ['REST_STABILITY_NOT_PASSED'], primaryBlocker: 'REST_STABILITY_NOT_PASSED',
        evidence: {
          ...evidence, startedAtMs: 0, endedAtMs: 100, events: { total: 0, byReason: {} }, timing: { readCandidateMs: 50, passCandidateMs: 1, interReadGapCandidateMs: 1, hardReadTimeoutMs: 1_000, hardPassDurationMs: 1_000 },
          readiness: { atStart: { atMs: 0, readiness: 'UNPROVEN', unprovenReason: null, incarnation: 1 }, samples: [], atEnd: { atMs: 0, readiness: 'UNPROVEN', unprovenReason: null, incarnation: 1 } },
        } as never,
      }],
      abortedEvaluations: 0, inProgressEvaluations: 0, cutoffSequence: 1,
    });
    expect(report.reads.latencyMs).toEqual({ count: 100, min: 1, p50: 50, p90: 90, p95: 95, p99: 99, max: 100 });
    expect(report.reads.readCandidateExceeded).toEqual({ count: 50, total: 100, permille: 500 });
  });

  it('recommendations are CALIBRATION_RECOMMENDATION data only (never applied, never a guarantee), and only with enough samples', async () => {
    const world = await shadowWorld();
    advancePhase18(world);
    const one = [await analysed(world, 1)];
    const campaign = { campaignId: 'campaign-1', status: 'ACTIVE', startedAtMs: T0, sourceProvenance: 'GIT_CLEAN_COMMIT', softwareVersion: COMMIT_A, cadenceMs: 60_000, calibrationReview: PRACTICAL_SHADOW_PROVISIONAL_REVIEW_CRITERIA };
    expect(21).toBeLessThan(PRACTICAL_SHADOW_RECOMMENDATION_MIN_SAMPLES);
    expect(analysePracticalShadowCampaign({ campaign, completed: one, abortedEvaluations: 0, inProgressEvaluations: 0, cutoffSequence: 1 }).recommendations).toEqual([]);
    const two = [...one, await analysed(world, 2)];
    const recommendations = analysePracticalShadowCampaign({ campaign, completed: two, abortedEvaluations: 0, inProgressEvaluations: 0, cutoffSequence: 2 }).recommendations;
    expect(recommendations.map((entry) => entry.parameter)).toEqual(['READ_DURATION', 'PASS_WINDOW', 'INTER_READ_GAP']);
    for (const entry of recommendations) {
      expect(entry).toMatchObject({ status: 'CALIBRATION_RECOMMENDATION', providerGuarantee: false, appliesAutomatically: false, requiresHumanReview: true });
    }
    expect(JSON.stringify(recommendations)).not.toMatch(/SAFE_THRESHOLD|PROVIDER_GUARANTEE/);
    // Nothing was tuned: the Stage 1A candidates and the hard ceilings are untouched.
    expect(PRACTICAL_TIMING_CANDIDATES.readDuration.valueMs).toBe(recommendations[0]!.currentCandidateMs);
    expect(Object.isFrozen(PRACTICAL_TIMING_CANDIDATES)).toBe(true);
    expect(Object.isFrozen(PRACTICAL_RECOVERY_HARD_CEILINGS)).toBe(true);
  });

  it('a fake-clock campaign is NOT eligible for human calibration review; the configured rules decide, and eligibility grants nothing', async () => {
    const world = await shadowWorld();
    advancePhase18(world);
    const evaluations = [await analysed(world, 1), await analysed(world, 2)];
    const campaign = { campaignId: 'campaign-1', status: 'ACTIVE', startedAtMs: T0, sourceProvenance: 'GIT_CLEAN_COMMIT', softwareVersion: COMMIT_A, cadenceMs: 60_000, calibrationReview: PRACTICAL_SHADOW_PROVISIONAL_REVIEW_CRITERIA };
    const report = analysePracticalShadowCampaign({ campaign, completed: evaluations, abortedEvaluations: 0, inProgressEvaluations: 0, cutoffSequence: 2 });
    expect(report.coverage).toMatchObject({ sampleCount: 2, eligibleForHumanCalibrationReview: false });
    expect(report.coverage.durationObservedMs).toBe(evaluations[1]!.evidence.endedAtMs - T0);
    const lenient = analysePracticalShadowCampaign({
      campaign: { ...campaign, calibrationReview: { status: PRACTICAL_SHADOW_REVIEW_CRITERIA_STATUS, minimumDurationMs: 1, minimumCompletedEvaluations: 2, minimumCoveragePermille: 1 } },
      completed: evaluations, abortedEvaluations: 0, inProgressEvaluations: 0, cutoffSequence: 2,
    });
    expect(lenient.coverage.eligibleForHumanCalibrationReview).toBe(true);
    expect(lenient.coverage.rules.status).toBe('PROVISIONAL_HUMAN_REVIEW_CRITERIA');
    expect(lenient.coverage.criteriaNotice).toMatch(/not authority requirements, not CoinDCX guarantees, not calibrated safety thresholds/);
    expect(lenient.provenance).toEqual({ sourceProvenance: 'GIT_CLEAN_COMMIT', softwareVersion: COMMIT_A, trustedCleanCommit: true });
    expect(lenient.grantsAuthority).toBe(false);
  });

  it.each([
    ['a dirty/development provenance', 'GIT_DIRTY_TREE', COMMIT_A],
    ['an unknown software version', 'GIT_CLEAN_COMMIT', 'unknown-software-version'],
    ['a non-hex commit', 'GIT_CLEAN_COMMIT', 'software-1'],
    ['an upper-case commit', 'GIT_CLEAN_COMMIT', COMMIT_A.toUpperCase()],
  ])('a dataset with %s can NEVER become human-review eligible, whatever its duration or sample count', async (_label, sourceProvenance, softwareVersion) => {
    const world = await shadowWorld();
    advancePhase18(world);
    const evaluations = [await analysed(world, 1), await analysed(world, 2)];
    const report = analysePracticalShadowCampaign({
      campaign: {
        campaignId: 'campaign-1', status: 'ACTIVE', startedAtMs: T0, sourceProvenance, softwareVersion, cadenceMs: 60_000,
        calibrationReview: { status: PRACTICAL_SHADOW_REVIEW_CRITERIA_STATUS, minimumDurationMs: 1, minimumCompletedEvaluations: 1, minimumCoveragePermille: 1 },
      },
      completed: evaluations, abortedEvaluations: 0, inProgressEvaluations: 0, cutoffSequence: 2,
    });
    expect(report.coverage.eligibleForHumanCalibrationReview).toBe(false);
    expect(report.provenance.trustedCleanCommit).toBe(false);
  });

  it('deterministic: the same dataset in any order gives an identical report', async () => {
    const world = await shadowWorld();
    advancePhase18(world);
    const evaluations = [await analysed(world, 1), await analysed(world, 2), await analysed(world, 3)];
    const campaign = { campaignId: 'campaign-1', status: 'ACTIVE', startedAtMs: T0, sourceProvenance: 'GIT_CLEAN_COMMIT', softwareVersion: COMMIT_A, cadenceMs: 60_000, calibrationReview: PRACTICAL_SHADOW_PROVISIONAL_REVIEW_CRITERIA };
    const a = analysePracticalShadowCampaign({ campaign, completed: evaluations, abortedEvaluations: 0, inProgressEvaluations: 0, cutoffSequence: 3 });
    const b = analysePracticalShadowCampaign({ campaign, completed: [...evaluations].reverse(), abortedEvaluations: 0, inProgressEvaluations: 0, cutoffSequence: 3 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
