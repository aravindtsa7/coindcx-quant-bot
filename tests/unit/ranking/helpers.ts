import { sha256CanonicalJson } from '../../../src/backtest/canonical-json';
import { P15_COMPONENT_IDS } from '../../../src/ranking/policy';
import type {
  RankingCandidateEvidence, RankingComponentId, RankingComponentMetric, RankingComponentMetrics,
  RankedStrategyRankingResult, StrategyRankingRun, StrategyRankingRunSet,
} from '../../../src/ranking/types';

/**
 * Fixtures for the PURE Phase15 ranking core.
 *
 * These build `RankingCandidateEvidence` directly, exercising normalization,
 * composite scoring, tie-breaking and identity without paying for a full
 * Phase12 research run. They are NOT an authority bypass: `src/ranking/index.ts`
 * does not re-export the core, so no production caller can reach it this way.
 * The authority path itself is proved separately, against a genuine Phase12
 * executor result, in `authority.test.ts`.
 */

export const TEST_PLAN_ID = 'f'.repeat(64);

export type MetricSpec = Partial<Record<RankingComponentId, string | null>>;

/** Neutral baseline: every required component present and identical. */
export const BASE_METRICS: Readonly<Record<RankingComponentId, string>> = Object.freeze({
  SHARPE: '1',
  SORTINO: '1',
  MAX_DRAWDOWN: '10',
  PROFIT_FACTOR: '1.5',
  EXPECTANCY: '100',
  OOS_CONSISTENCY: '1',
  PARAMETER_ROBUSTNESS: '0.9',
});

export interface EvidenceOptions {
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion?: string;
  readonly parameterHash?: string;
  readonly metrics?: MetricSpec;
  readonly validationPlanId?: string;
  readonly validationSubjectResultSha256?: string;
}

export function buildEvidence(options: EvidenceOptions): RankingCandidateEvidence {
  const strategyVersion = options.strategyVersion ?? '1.0.0';
  const parameterHash = options.parameterHash ?? sha256CanonicalJson({ p: options.strategyId, pair: options.pair });
  const validationSubjectId = sha256CanonicalJson({
    pair: options.pair, strategyId: options.strategyId, strategyVersion, parameterHash,
  });
  const metrics: Partial<Record<RankingComponentId, RankingComponentMetric>> = {};
  for (const componentId of P15_COMPONENT_IDS) {
    const override = options.metrics?.[componentId];
    const value = override === undefined ? BASE_METRICS[componentId] : override;
    metrics[componentId] = value === null
      ? { status: 'UNAVAILABLE', reason: 'METRIC_NOT_VALUE', detail: `${componentId}:INSUFFICIENT_DATA:TEST` }
      : { status: 'VALUE', value };
  }
  return {
    identity: {
      pair: options.pair,
      strategyId: options.strategyId,
      strategyVersion,
      parameterHash,
      validationSubjectId,
      validationPlanId: options.validationPlanId ?? TEST_PLAN_ID,
      validationSubjectResultSha256: options.validationSubjectResultSha256 ?? sha256CanonicalJson({ subject: validationSubjectId }),
    },
    metrics: metrics as RankingComponentMetrics,
  };
}

/** Deterministic, seedless permutation used to prove input-order independence. */
export function rotate<T>(values: readonly T[], by: number): readonly T[] {
  if (values.length === 0) return values;
  const offset = ((by % values.length) + values.length) % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

export function everyPermutation<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length <= 1) return [values];
  const output: T[][] = [];
  values.forEach((value, index) => {
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const tail of everyPermutation(rest)) output.push([value, ...tail]);
  });
  return output;
}

export function runForPair(runSet: StrategyRankingRunSet, pair: string): StrategyRankingRun {
  const run = runSet.runs.find((entry) => entry.pair === pair);
  if (run === undefined) throw new Error(`No ranking run for pair ${pair}`);
  return run;
}

export function rankedResults(run: StrategyRankingRun): readonly RankedStrategyRankingResult[] {
  return run.results.filter((entry): entry is RankedStrategyRankingResult => entry.status === 'RANKED');
}

export function rankOrder(run: StrategyRankingRun): readonly string[] {
  return rankedResults(run).map((entry) => entry.strategyId);
}
