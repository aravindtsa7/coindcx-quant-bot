import { describe, expect, it } from 'vitest';
import { InMemoryBacktestDatasetSource } from '../../../../src/backtest';
import { executeResearchValidationWithGitSourceVerifier } from '../../../../src/research/research-validation/executor';
import { planResearchValidationWithGitSourceVerifier } from '../../../../src/research/research-validation/planner';
import { issueResearchApprovalOrigin, ResearchApprovalOrigin } from '../../../../src/research/research-validation/approval-authority';
import type { ResearchApprovalSubject } from '../../../../src/research/research-validation/approval-authority';
import type { ResearchValidationPlanResult } from '../../../../src/research/research-validation/types';
import { candles, ControlledGitVerifier, datasetManifest, registry, resources } from '../strategy-coin-matrix/helpers';
import { validationInput } from './helpers';

// Wave C3 — C-F06: research approval must be genuine executor origin, never a
// self-consistent caller hash. One real (small, fast-thresholded) research run
// backs every scenario below so the PASSED verdict and its subject identity are
// real Phase 12 output, not a fixture invented for this test.
const DAY = 86_400_000;
const BASE = 1_704_067_200_000;

let cached: Promise<{ readonly result: ResearchValidationPlanResult; readonly subject: ResearchApprovalSubject }> | null = null;
function genuineResult(): Promise<{ readonly result: ResearchValidationPlanResult; readonly subject: ResearchApprovalSubject }> {
  cached ??= (async () => {
    const rows = candles('BTC-INR', 10 * 24 * 60);
    const base = resources('BTC-INR');
    const resource = { ...base, datasetManifest: datasetManifest(rows), datasetSource: new InMemoryBacktestDatasetSource('approval-authority-memory', rows) };
    const definitions = registry();
    // 2 IS days / 2 OOS days / 2 holdout days: the default fixture's 1-day window
    // leaves every daily-observation-dependent gate UNAVAILABLE (INSUFFICIENT_EVIDENCE)
    // under minDailyObservations=2, so this widens it to reach a genuine PASSED verdict.
    const input = {
      ...validationInput([resource]),
      validationWindow: { startMs: BASE + DAY, endExclusiveMs: BASE + 7 * DAY },
      walkForward: { policyId: 'P12_WALK_FORWARD_V1' as const, trainDays: 2, testDays: 2, stepDays: 2, embargoDays: 0 },
      holdout: { holdoutStartMs: BASE + 5 * DAY, holdoutEndExclusiveMs: BASE + 7 * DAY, exposureDeclaration: 'UNSEEN_BY_OPERATOR' as const },
    };
    const finalized = await planResearchValidationWithGitSourceVerifier(input, { registry: definitions, pairResources: [resource] }, new ControlledGitVerifier());
    const result = await executeResearchValidationWithGitSourceVerifier(finalized, { registry: definitions, pairResources: [resource] }, {}, new ControlledGitVerifier());
    expect(result.status).toBe('COMPLETED');
    const record = result.subjectResults[0];
    if (record === undefined) throw new Error('fixture requires at least one subject');
    expect(record.verdict).toBe('PASSED');
    return { result, subject: { pair: record.pair, strategyId: record.strategyId, strategyVersion: record.strategyVersion, parameterHash: record.parameterHash } };
  })();
  return cached;
}

describe('C-F06 research approval origin authority', () => {
  it('issues an origin for a genuine PASSED subject, binding the exact current fields', async () => {
    const { result, subject } = await genuineResult();
    const origin = issueResearchApprovalOrigin(result, subject);
    expect(origin).not.toBeNull();
    const record = ResearchApprovalOrigin.read(origin);
    expect(record).toMatchObject({ ...subject, validationPlanId: result.validationPlanId });
    expect(record?.validationSubjectResultSha256).toHaveLength(64);
  }, 30_000);

  it('rejects a genuine result plus a mismatched subject (wrong pair)', async () => {
    const { result, subject } = await genuineResult();
    expect(issueResearchApprovalOrigin(result, { ...subject, pair: 'ETH-INR' })).toBeNull();
  }, 30_000);

  it('rejects a genuine result plus a mismatched subject (wrong strategyId)', async () => {
    const { result, subject } = await genuineResult();
    expect(issueResearchApprovalOrigin(result, { ...subject, strategyId: 'NOT_A_REAL_STRATEGY' })).toBeNull();
  }, 30_000);

  it('rejects a genuine result plus a mismatched subject (wrong strategyVersion)', async () => {
    const { result, subject } = await genuineResult();
    expect(issueResearchApprovalOrigin(result, { ...subject, strategyVersion: '999.0.0' })).toBeNull();
  }, 30_000);

  it('rejects a genuine result plus a mismatched subject (wrong parameterHash)', async () => {
    const { result, subject } = await genuineResult();
    expect(issueResearchApprovalOrigin(result, { ...subject, parameterHash: 'b'.repeat(64) })).toBeNull();
  }, 30_000);

  it('rejects a missing subject entirely absent from subjectResults', async () => {
    const { result } = await genuineResult();
    expect(issueResearchApprovalOrigin(result, { pair: 'SOL-INR', strategyId: 'NOTHING', strategyVersion: '1.0.0', parameterHash: 'c'.repeat(64) })).toBeNull();
  }, 30_000);

  it('rejects a byte-for-byte identical but caller-fabricated (non-genuine) result object', async () => {
    const { result, subject } = await genuineResult();
    // Not a hash tamper — an exact structural clone, including a correctly
    // self-consistent validationSubjectResultSha256. The only thing missing is
    // genuine origin: this object was never returned by the real executor.
    const forged = JSON.parse(JSON.stringify(result)) as ResearchValidationPlanResult;
    expect(forged).toEqual(result);
    expect(issueResearchApprovalOrigin(forged, subject)).toBeNull();
  }, 30_000);

  it('rejects a result with a manually-flipped verdict on an otherwise-genuine object graph reference check', async () => {
    // Even mutating a genuine, WeakSet-tracked result's nested verdict is
    // impossible at the language level (deep-frozen) — confirm that directly,
    // since it is the other half of "genuine origin, not caller-computable proof".
    const { result } = await genuineResult();
    const record = result.subjectResults[0];
    if (record === undefined) throw new Error('fixture');
    expect(() => { (record as { verdict: string }).verdict = 'FAILED'; }).toThrow();
  }, 30_000);

  it('rejects null and non-genuine-shaped values passed as planResult', () => {
    expect(issueResearchApprovalOrigin(null as unknown as ResearchValidationPlanResult, { pair: 'BTC-INR', strategyId: 'X', strategyVersion: '1', parameterHash: 'd'.repeat(64) })).toBeNull();
  });

  it('ResearchApprovalOrigin.read returns null for forged/foreign objects (no TypeScript-only brand bypass)', async () => {
    const { result, subject } = await genuineResult();
    const genuine = issueResearchApprovalOrigin(result, subject);
    expect(genuine).not.toBeNull();
    const fakeOrigin = { pair: subject.pair, strategyId: subject.strategyId, strategyVersion: subject.strategyVersion, parameterHash: subject.parameterHash,
      validationSubjectId: 'x'.repeat(64), validationPlanId: result.validationPlanId, validationSubjectResultSha256: 'y'.repeat(64) };
    expect(ResearchApprovalOrigin.read(fakeOrigin)).toBeNull();
    expect(ResearchApprovalOrigin.read(null)).toBeNull();
    expect(ResearchApprovalOrigin.read('not an object')).toBeNull();
  }, 30_000);
});
