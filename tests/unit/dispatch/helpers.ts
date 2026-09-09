import { expect } from 'vitest';
import { InMemoryBacktestDatasetSource } from '../../../src/backtest';
import { IndicatorDecimal } from '../../../src/indicators';
import { executeResearchValidationWithGitSourceVerifier } from '../../../src/research/research-validation/executor';
import { planResearchValidationWithGitSourceVerifier } from '../../../src/research/research-validation/planner';
import { issueResearchApprovalOrigin, ResearchApprovalOrigin, type ResearchValidationPlanResult } from '../../../src/research/research-validation';
import { createStrategyRiskHandoff, recomputeStrategyDecisionId, type RiskEvaluationContext } from '../../../src/risk';
import { candles, ControlledGitVerifier, datasetManifest, registry, resources } from '../research/strategy-coin-matrix/helpers';
import { validationInput } from '../research/research-validation/helpers';
import { emaTrendV1Definition, StrategyReadonlyMap, type StrategyDecision, type StrategyKernel, type StrategyTargetExposure } from '../../../src/strategies';
import { makeAccount, makeEntry, makeExposure, makePair, makePolicy, makeSettlement, makeTiers, resealContext, seal } from '../risk/helpers';

export const PAIR = 'B-BTC_USDT';
export const PARAMETERS = { timeframeMinutes: 1, fastPeriod: 1, slowPeriod: 2, priceSource: 'CLOSE' as const };
const DAY = 86_400_000;
const BASE = 1_704_067_200_000;

export function makeKernel(pair: string = PAIR): StrategyKernel {
  return emaTrendV1Definition.createKernel({ pair, parameters: PARAMETERS, indicatorBootstrapIdentity: [{ timeframeMinutes: 1, bootstrapStartOpenTimeMs: 0 }] });
}

export function evaluateDecision(kernel: StrategyKernel, evaluationTimeMs: number, target: StrategyTargetExposure = 'LONG'): StrategyDecision {
  const candle = { pair: kernel.pair, timeframeMinutes: 1, openTimeMs: evaluationTimeMs - 60_000, closeTimeExclusiveMs: evaluationTimeMs, open: '100', high: '110', low: '90', close: '100', volume: '1', quoteVolume: null };
  const point = (value: string) => ({ pair: candle.pair, timeframeMinutes: 1, openTimeMs: candle.openTimeMs, closeTimeExclusiveMs: evaluationTimeMs, value: new IndicatorDecimal(value) });
  const decision = kernel.evaluate({
    pair: kernel.pair, evaluationTimeMs, triggerClosedCandle: candle,
    latestClosedCandleByTimeframe: new StrategyReadonlyMap([[1, candle]]), candlesClosedAtThisTimestamp: [candle],
    latestIndicatorPointByAlias: new StrategyReadonlyMap([
      ['ema.fast', point(target === 'LONG' ? '110' : target === 'SHORT' ? '90' : '100')],
      ['ema.slow', point('100')],
    ]),
  });
  if (recomputeStrategyDecisionId(decision) !== decision.decisionId) throw new Error('dispatch test fixture identity mismatch');
  return decision;
}

export const EVAL_BASE = 1_200_000;

/**
 * A full, admission-ready `RiskEvaluationContext` for one decision from `kernel`.
 * Admission-coordinator tests exercise dedup/sequencing/exposure math independent
 * of the research-approval layer (already covered separately), so this bypasses
 * `authorizeStrategyDispatch` and calls `createStrategyRiskHandoff` directly.
 */
export function pairSnapshotFor(pair: string) {
  const base = makePair();
  if (pair === base.pair) return base;
  const ownership = base.ownership.status === 'RECONCILED' ? { ...base.ownership, pair } : base.ownership;
  return seal({ ...base, pair, ownership });
}

export function tiersFor(pair: string) {
  const base = makeTiers();
  return pair === base.pair ? base : seal({ ...base, pair });
}

function retimed<T extends { readonly provenance: { readonly sourceId: string; readonly sourceTimeMs: number | null; readonly observedAtMs: number; readonly contentSha256: string } }>(value: T, evaluationTimeMs: number): T {
  return { ...value, provenance: { ...value.provenance, sourceTimeMs: evaluationTimeMs, observedAtMs: evaluationTimeMs } };
}

export function buildContext(kernel: StrategyKernel, decision: StrategyDecision, overrides: Partial<RiskEvaluationContext> = {}): RiskEvaluationContext {
  const handoff = createStrategyRiskHandoff(kernel, decision, 'instrument-1');
  if (handoff === null) throw new Error('dispatch test fixture requires a READY decision');
  const t = decision.evaluationTimeMs;
  const pairSnapshot = retimed(pairSnapshotFor(kernel.pair), t);
  return resealContext({
    strategyOrigin: handoff.strategyOrigin, candidate: handoff.candidate, entryStopProposal: retimed(makeEntry(decision), t), leverageProposal: null, override: null,
    evaluationTimeMs: t, accountSnapshot: retimed(makeAccount(), t), pairSnapshot, exposureSnapshot: retimed(makeExposure(), t),
    leverageTierSnapshot: retimed(tiersFor(kernel.pair), t), settlementRateSnapshot: retimed(makeSettlement(), t), ...overrides,
  });
}

export function policyFor(pair: string = PAIR, tightCapInr?: string) {
  const pairMaxExposureInr = tightCapInr ?? '500000';
  return makePolicy({
    pairConfig: { pair, pairMaxLeverage: '20', pairMaxExposureInr, pairMaxConcurrentPositions: 10 },
    ...(tightCapInr === undefined ? {} : {
      globalConfig: { globalMaxLeverage: '20', globalMaxOpenNotionalInr: tightCapInr, globalMaxConcurrentPositions: 20, globalMaxDailyLossInr: '50000', globalDailyLossLimitPercent: null, globalMaxDrawdownPercent: '50' },
      modeConfig: { mode: 'NORMAL', riskPerTradePercent: '1', maxNotionalPerTradeInr: '100000', leverageRecommendation: '5', maxConcurrentExposureInr: tightCapInr, maxCoinExposureInr: tightCapInr, maxStrategyExposureInr: tightCapInr, maxConcurrentPositions: 10, maxDailyLossInr: '40000', dailyLossLimitPercent: null, maxDrawdownPercent: '40', consecutiveLossLimit: 3, cooldownMs: 60000 },
    }),
  });
}

/** One genuine, memoized Phase 12 PASSED result for `PAIR`/EMA_TREND/`PARAMETERS` — matches `makeKernel()` exactly. */
let cachedApproval: Promise<{ readonly result: ResearchValidationPlanResult; readonly origin: ResearchApprovalOrigin }> | null = null;
export function genuineResearchApproval(): Promise<{ readonly result: ResearchValidationPlanResult; readonly origin: ResearchApprovalOrigin }> {
  cachedApproval ??= (async () => {
    const rows = candles(PAIR, 10 * 24 * 60);
    const base = resources(PAIR);
    const resource = { ...base, datasetManifest: datasetManifest(rows), datasetSource: new InMemoryBacktestDatasetSource('dispatch-approval-memory', rows) };
    const definitions = registry();
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
    if (record === undefined) throw new Error('dispatch test fixture requires a subject');
    expect(record.verdict).toBe('PASSED');
    const kernel = makeKernel();
    expect(record.strategyId).toBe(kernel.strategyId);
    expect(record.strategyVersion).toBe(kernel.strategyVersion);
    expect(record.parameterHash).toBe(kernel.parameterHash);
    expect(record.pair).toBe(kernel.pair);
    const origin = issueResearchApprovalOrigin(result, { pair: record.pair, strategyId: record.strategyId, strategyVersion: record.strategyVersion, parameterHash: record.parameterHash });
    if (origin === null) throw new Error('dispatch test fixture requires a genuine approval origin');
    return { result, origin };
  })();
  return cachedApproval;
}
