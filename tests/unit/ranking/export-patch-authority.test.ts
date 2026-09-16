import { beforeAll, describe, expect, it } from 'vitest';
import { sha256CanonicalJson } from '../../../src/backtest/canonical-json';
import { rankStrategyCandidates, type StrategyRankingCandidateSubject } from '../../../src/ranking/engine';
import * as approvalAuth from '../../../src/research/research-validation/approval-authority';
import * as executorModule from '../../../src/research/research-validation/executor';
import type { ResearchValidationPlanResult, StrategyValidationRecord } from '../../../src/research/research-validation/types';
import { getGenuineRankingFixture } from './helpers';

// [Finding 2] Phase 12 authority export patch attack resistance.
// Threat model frozen identically to Phase 14:
// IN SCOPE: ordinary repo-level exported API / prototype / module-export replacement.
// OUT OF SCOPE: require.cache manipulation, arbitrary process memory compromise, Node runtime compromise.

const PAIR = 'BTC-INR';
const STRATEGY_ID = 'EMA_TREND';
const STRATEGY_VERSION = '1.0.0';
const PARAM_HASH = sha256CanonicalJson({ p: STRATEGY_ID, pair: PAIR });
const VALIDATION_SUBJECT_ID = sha256CanonicalJson({ pair: PAIR, strategyId: STRATEGY_ID, strategyVersion: STRATEGY_VERSION, parameterHash: PARAM_HASH });

function fabricatePassedPlanResult(): ResearchValidationPlanResult {
  const record: StrategyValidationRecord = {
    pair: PAIR,
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    parameterHash: PARAM_HASH,
    validationSubjectId: VALIDATION_SUBJECT_ID,
    validationPlanId: '9'.repeat(64),
    validationSubjectResultSha256: '8'.repeat(64),
    verdict: 'PASSED',
    aggregateOosMetrics: {
      sharpe: { status: 'VALUE', value: '999' },
      sortino: { status: 'VALUE', value: '999' },
      maxDrawdownPercent: { status: 'VALUE', value: '0.001' },
      netDailyProfitFactor: { status: 'VALUE', value: '100' },
      netDailyExpectancy: { status: 'VALUE', value: '5000' },
    } as unknown as StrategyValidationRecord['aggregateOosMetrics'],
    gateEvaluations: [
      { gateId: 'GATE-08', gateName: 'MIN_OOS_FOLD_PASS_RATIO', status: 'PASS', observedValue: '1' },
    ] as unknown as StrategyValidationRecord['gateEvaluations'],
    parameterNeighborhoodSensitivity: { status: 'VALUE', value: '0.95' } as unknown as StrategyValidationRecord['parameterNeighborhoodSensitivity'],
  } as unknown as StrategyValidationRecord;

  return {
    validationPlanId: '9'.repeat(64),
    planName: 'fabricated-plan',
    status: 'COMPLETED',
    totalSubjects: 1,
    passedSubjects: 1,
    failedSubjects: 0,
    insufficientEvidenceSubjects: 0,
    totalFolds: 1,
    unusedTailMs: 0,
    freshnessBasis: 'OPERATOR_ATTESTATION_V1',
    validationResultSha256: '7'.repeat(64),
    subjectResults: Object.freeze([record]),
    abortedSubjects: Object.freeze([]),
  } as unknown as ResearchValidationPlanResult;
}

const CANDIDATE: StrategyRankingCandidateSubject = {
  pair: PAIR,
  strategyId: STRATEGY_ID,
  strategyVersion: STRATEGY_VERSION,
  parameterHash: PARAM_HASH,
};

describe('Finding 2 — Exported Phase 12 Authority Patch Attack', () => {
  beforeAll(async () => {
    await getGenuineRankingFixture();
  }, 60_000);

  it('no genuine result registrar is exported from approval-authority or executor', () => {
    expect((approvalAuth as Record<string, unknown>)['registerGenuineResearchValidationResult']).toBeUndefined();
    expect((approvalAuth as Record<string, unknown>)['registerGenuineResult']).toBeUndefined();
    expect((approvalAuth as Record<string, unknown>)['registerAuthoritativeResult']).toBeUndefined();
    expect((executorModule as Record<string, unknown>)['registerGenuineResearchValidationResult']).toBeUndefined();
    expect((executorModule as Record<string, unknown>)['registerGenuineResult']).toBeUndefined();
  });

  it('executor exports read-only verifier isGenuineResearchValidationResult which is frozen', () => {
    const isVerifierDesc = Object.getOwnPropertyDescriptor(executorModule, 'isGenuineResearchValidationResult');
    expect(isVerifierDesc?.configurable).toBe(false);
    expect(typeof isVerifierDesc?.get).toBe('function');
    expect(Object.isFrozen(executorModule)).toBe(true);

    const forged = fabricatePassedPlanResult();
    expect(executorModule.isGenuineResearchValidationResult(forged)).toBe(false);
  });

  it('post-import replacement of exported isGenuineResearchValidationResult fails closed', () => {
    expect(() => {
      (executorModule as unknown as Record<string, unknown>)['isGenuineResearchValidationResult'] = () => true;
    }).toThrow(TypeError);

    expect(() => {
      Object.defineProperty(executorModule, 'isGenuineResearchValidationResult', { value: () => true, configurable: true });
    }).toThrow(TypeError);

    const forged = fabricatePassedPlanResult();
    expect(executorModule.isGenuineResearchValidationResult(forged)).toBe(false);
  });

  it('approval-authority module exports are frozen and non-configurable', () => {
    expect(Object.isFrozen(approvalAuth), 'approval-authority exports must be frozen').toBe(true);

    const issueDesc = Object.getOwnPropertyDescriptor(approvalAuth, 'issueResearchApprovalOrigin');
    expect(issueDesc?.configurable, 'issueResearchApprovalOrigin must be non-configurable').toBe(false);
    expect(typeof issueDesc?.get, 'issueResearchApprovalOrigin must be getter-pinned').toBe('function');

    const originDesc = Object.getOwnPropertyDescriptor(approvalAuth, 'ResearchApprovalOrigin');
    expect(originDesc?.configurable, 'ResearchApprovalOrigin must be non-configurable').toBe(false);
    expect(typeof originDesc?.get, 'ResearchApprovalOrigin must be getter-pinned').toBe('function');
  });

  it('post-import replacement of exported issueResearchApprovalOrigin fails closed', () => {
    expect(() => {
      (approvalAuth as unknown as Record<string, unknown>)['issueResearchApprovalOrigin'] = () => null;
    }).toThrow(TypeError);

    expect(() => {
      Object.defineProperty(approvalAuth, 'issueResearchApprovalOrigin', { value: () => null, configurable: true });
    }).toThrow(TypeError);
  });

  it('pre-ranking replacement of exported ResearchApprovalOrigin fails closed', () => {
    expect(() => {
      (approvalAuth as unknown as Record<string, unknown>)['ResearchApprovalOrigin'] = class {};
    }).toThrow(TypeError);

    expect(() => {
      (approvalAuth.ResearchApprovalOrigin as unknown as Record<string, unknown>)['read'] = () => null;
    }).toThrow(TypeError);
  });

  it('coordinated replacement attack cannot authorize a fabricated PASSED validation result', () => {
    // Attempt coordinated attack: caller tries to feed a fabricated PASSED result with 999 Sharpe
    const fabricated = fabricatePassedPlanResult();

    // Try to mutate or override authority surface (wrapped in try/catch in case of strict error)
    try {
      (approvalAuth as unknown as Record<string, unknown>)['issueResearchApprovalOrigin'] = () => ({});
    } catch {
      // expected TypeError
    }

    try {
      (executorModule as unknown as Record<string, unknown>)['isGenuineResearchValidationResult'] = () => true;
    } catch {
      // expected TypeError
    }

    const runSet = rankStrategyCandidates({
      planResult: fabricated,
      candidates: [CANDIDATE],
    });

    // The fabricated result MUST NOT be ranked
    expect(runSet.runs).toHaveLength(0);
    expect(runSet.nonAuthoritativeCandidates).toHaveLength(1);
    expect(runSet.nonAuthoritativeCandidates[0]?.status).toBe('NOT_ELIGIBLE');
    expect(runSet.nonAuthoritativeCandidates[0]?.reasonCodes).toContain('VALIDATION_SUBJECT_NOT_AUTHORITATIVE');

    // And approval authority itself directly returns null for fabricated result
    expect(approvalAuth.issueResearchApprovalOrigin(fabricated, CANDIDATE)).toBeNull();
  });

  it('genuine Phase12 PASSED still ranks normally', async () => {
    const { planResult, candidates } = await getGenuineRankingFixture();
    const runSet = rankStrategyCandidates({ planResult, candidates });
    expect(runSet.runs.length).toBeGreaterThanOrEqual(1);
    const btcRun = runSet.runs.find((r) => r.pair === PAIR);
    expect(btcRun).toBeDefined();
    expect(btcRun?.results.length).toBeGreaterThanOrEqual(1);
    expect(btcRun?.results.some((r) => r.status === 'RANKED')).toBe(true);
  });

  it('forged plan remains NOT_ELIGIBLE and cannot produce ranking evidence', () => {
    const forged = fabricatePassedPlanResult();
    const outcome = rankStrategyCandidates({
      planResult: forged,
      candidates: [CANDIDATE],
    });
    expect(outcome.runs).toEqual([]);
    expect(outcome.nonAuthoritativeCandidates[0]?.status).toBe('NOT_ELIGIBLE');
  });
});
