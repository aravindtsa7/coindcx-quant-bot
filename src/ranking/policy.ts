import { sha256CanonicalJson } from '../backtest/canonical-json';
import { RankingError } from './errors';
import { rankCalc, rankCanonical, RANK_ONE, RANK_ZERO } from './numeric';
import {
  RANKING_SCHEMA_VERSION,
  type RankingComponentId,
  type RankingComponentPolicy,
  type RankingEconomicLimitation,
  type RankingPolicy,
  type RankingTieBreakLevel,
} from './types';

/**
 * The single frozen Phase15 V1 ranking policy.
 *
 * Every outcome-affecting decision lives here and nowhere else: the metric
 * set, the weights, the direction of each metric, the normalization algorithm,
 * the tie-break order, the decimal semantics, and the frozen Phase14 economic
 * limitation. `rankingPolicyId` is the SHA-256 of the canonical JSON of this
 * object, so no weight, direction, source, or tie-break change can occur under
 * an unchanged policy identity.
 *
 * ## Phase12 contract adaptations (mandatory disclosure)
 *
 * Phase15 invents no market statistic. Each component reads a value Phase12
 * already computes and cryptographically binds into
 * `StrategyValidationRecord.validationSubjectResultSha256`:
 *
 * | Phase15 component      | Phase12 authoritative source                                    |
 * | ---------------------- | --------------------------------------------------------------- |
 * | SHARPE                 | `aggregateOosMetrics.sharpe`                                      |
 * | SORTINO                | `aggregateOosMetrics.sortino`                                     |
 * | MAX_DRAWDOWN           | `aggregateOosMetrics.maxDrawdownPercent`                           |
 * | PROFIT_FACTOR          | `aggregateOosMetrics.netDailyProfitFactor`                          |
 * | EXPECTANCY             | `aggregateOosMetrics.netDailyExpectancy`                            |
 * | OOS_CONSISTENCY        | `GATE-08 MIN_OOS_FOLD_PASS_RATIO.observedValue`                    |
 * | PARAMETER_ROBUSTNESS   | `parameterNeighborhoodSensitivity`                                 |
 *
 * Adaptations relative to the generically-named Phase15 brief:
 *
 * 1. "Profit Factor" / "Expectancy" bind the NET DAILY variants, not the gross
 *    trade variants. Phase12 computes both, but only the net daily pair is the
 *    approval-gated authority (`GATE-06`/`GATE-07`,
 *    `minNetDailyProfitFactor`/`minNetDailyExpectancy`). Binding the gated
 *    variant keeps Phase15 aligned with the exact numbers that produced the
 *    `PASSED` verdict Phase15 depends on.
 * 2. "OOS Consistency" exists in Phase12 as a gate-observed value, not as a
 *    field of `ValidationMetrics`. Phase12 computes it as
 *    `passingOosFolds / totalFolds` in canonical Decimal and publishes it as
 *    `GATE-08.observedValue`. Phase15 reads that published value; it does NOT
 *    recompute a fold ratio of its own.
 * 3. "Max Drawdown" binds the PERCENT form (`maxDrawdownPercent`), the same
 *    form `GATE-05` gates, so the component is comparable across candidates
 *    with different capital bases.
 * 4. "Parameter Robustness" binds Phase12's neighborhood sensitivity statistic
 *    (mean neighbor OOS Sharpe / target OOS Sharpe). Phase15 applies the
 *    mandated HIGHER_IS_BETTER direction to the Phase12 value unchanged and
 *    performs no transform of its own. This metric is OPTIONAL in Phase12 (it
 *    is produced only when the validation plan declares a
 *    `parameterNeighborhoods` mapping for the subject's `parameterHash`, and it
 *    is never gated), so a `PASSED` subject does NOT mathematically guarantee
 *    it. Per the fail-closed rule, a candidate without it is
 *    `INSUFFICIENT_RANKING_EVIDENCE`, never coerced to zero and never silently
 *    re-weighted. Declaring `parameterNeighborhoods` in the Phase12 plan is
 *    therefore a precondition for a subject to be rankable under V1.
 *
 * Components 1, 2, 3, 5, 6, 7 (SHARPE, SORTINO, MAX_DRAWDOWN, PROFIT_FACTOR,
 * EXPECTANCY) ARE mathematically guaranteed to be `VALUE` for a `PASSED`
 * subject: `subjectVerdict` returns `PASSED` only when no gate is `FAIL` and
 * no gate is `UNAVAILABLE`, and `metricGate` returns `UNAVAILABLE` for every
 * non-`VALUE` metric. OOS_CONSISTENCY is likewise always `VALUE` because
 * Phase12 computes it from two integers. Phase15 still re-checks all seven and
 * fails closed rather than relying on that proof at runtime.
 */

const COMPONENTS: readonly RankingComponentPolicy[] = Object.freeze([
  Object.freeze({
    componentId: 'SHARPE' as const,
    weight: '0.25',
    direction: 'HIGHER_IS_BETTER' as const,
    required: true as const,
    source: Object.freeze({ kind: 'AGGREGATE_OOS_METRIC' as const, metric: 'sharpe' }),
  }),
  Object.freeze({
    componentId: 'SORTINO' as const,
    weight: '0.15',
    direction: 'HIGHER_IS_BETTER' as const,
    required: true as const,
    source: Object.freeze({ kind: 'AGGREGATE_OOS_METRIC' as const, metric: 'sortino' }),
  }),
  Object.freeze({
    componentId: 'MAX_DRAWDOWN' as const,
    weight: '0.20',
    direction: 'LOWER_IS_BETTER' as const,
    required: true as const,
    source: Object.freeze({ kind: 'AGGREGATE_OOS_METRIC' as const, metric: 'maxDrawdownPercent' }),
  }),
  Object.freeze({
    componentId: 'PROFIT_FACTOR' as const,
    weight: '0.15',
    direction: 'HIGHER_IS_BETTER' as const,
    required: true as const,
    source: Object.freeze({ kind: 'AGGREGATE_OOS_METRIC' as const, metric: 'netDailyProfitFactor' }),
  }),
  Object.freeze({
    componentId: 'EXPECTANCY' as const,
    weight: '0.10',
    direction: 'HIGHER_IS_BETTER' as const,
    required: true as const,
    source: Object.freeze({ kind: 'AGGREGATE_OOS_METRIC' as const, metric: 'netDailyExpectancy' }),
  }),
  Object.freeze({
    componentId: 'OOS_CONSISTENCY' as const,
    weight: '0.10',
    direction: 'HIGHER_IS_BETTER' as const,
    required: true as const,
    source: Object.freeze({ kind: 'GATE_OBSERVED_VALUE' as const, gateId: 'GATE-08', gateName: 'MIN_OOS_FOLD_PASS_RATIO' }),
  }),
  Object.freeze({
    componentId: 'PARAMETER_ROBUSTNESS' as const,
    weight: '0.05',
    direction: 'HIGHER_IS_BETTER' as const,
    required: true as const,
    source: Object.freeze({ kind: 'SUBJECT_METRIC' as const, metric: 'parameterNeighborhoodSensitivity' }),
  }),
]);

/**
 * Frozen restatement of the Phase14 economic limitation. Phase15 never widens
 * it; there is no enabled variant and no setter.
 */
export const P15_ECONOMIC_LIMITATION: RankingEconomicLimitation = Object.freeze({
  economicStatus: 'FUNDING_EXCLUDED',
  fundingCapability: 'FUNDING_UNSUPPORTED',
  fundingCapabilityReason: 'COINDCX_PROVIDER_EVIDENCE_INCOMPLETE',
  fundingApplied: false,
  paperEconomicStatus: 'PAPER_NOT_ECONOMICALLY_COMPLETE',
  pnlLabel: 'FUNDING_EXCLUDED_PNL',
  promotionEligible: false,
  maxLifecycle: 'PAPER',
});

/** The frozen tie-break precedence. Order is bound into `rankingPolicyId`. */
export const P15_TIE_BREAK_ORDER: readonly RankingTieBreakLevel[] = Object.freeze([
  'LOWER_MAX_DRAWDOWN',
  'HIGHER_SHARPE',
  'HIGHER_SORTINO',
  'HIGHER_PROFIT_FACTOR',
  'LEXICAL_VALIDATION_SUBJECT_ID',
] as const);

export const P15_RANKING_V1: RankingPolicy = Object.freeze({
  rankingPolicyVersion: 'P15_RANKING_V1',
  schemaVersion: RANKING_SCHEMA_VERSION,
  components: COMPONENTS,
  normalization: Object.freeze({
    algorithm: 'P15_CANDIDATE_SET_RELATIVE_DENSE_ORDINAL_V1' as const,
    scope: 'PAIR_LOCAL' as const,
    tieCollapse: 'DENSE_EQUAL_VALUES_SHARE_POSITION' as const,
    bestScore: '1' as const,
    worstScore: '0' as const,
    singleDistinctValueScore: '1' as const,
  }),
  tieBreakOrder: P15_TIE_BREAK_ORDER,
  decimal: Object.freeze({
    calculationPrecision: 128 as const,
    publishedScale: 18 as const,
    rounding: 'ROUND_HALF_UP' as const,
    floatingPointArithmetic: 'FORBIDDEN' as const,
  }),
  economicLimitation: P15_ECONOMIC_LIMITATION,
  paperEconomicContribution: 'NONE',
});

/** Every component id declared by `P15_RANKING_V1`, in frozen policy order. */
export const P15_COMPONENT_IDS: readonly RankingComponentId[] = Object.freeze(
  P15_RANKING_V1.components.map((component) => component.componentId),
);

/**
 * Self-validates the frozen policy at module load. A weight table that no
 * longer sums to exactly 1, a duplicated component, a missing tie-break level,
 * or a loosened economic limitation is a load-time failure, never a silently
 * mis-scored ranking.
 */
function assertPolicyIntegrity(policy: RankingPolicy): void {
  const seen = new Set<RankingComponentId>();
  let total = RANK_ZERO;
  for (const component of policy.components) {
    if (seen.has(component.componentId)) {
      throw new RankingError('RANKING_POLICY_INVALID', `Duplicate ranking component: ${component.componentId}`);
    }
    seen.add(component.componentId);
    const weight = rankCalc(component.weight);
    if (!weight.greaterThan(RANK_ZERO)) {
      throw new RankingError('RANKING_POLICY_INVALID', `Ranking component weight must be strictly positive: ${component.componentId}`);
    }
    total = total.plus(weight);
  }
  if (rankCanonical(total) !== rankCanonical(RANK_ONE)) {
    throw new RankingError('RANKING_POLICY_INVALID', `Ranking component weights must total exactly 1, got ${rankCanonical(total)}`);
  }
  const levels = new Set(policy.tieBreakOrder);
  if (levels.size !== policy.tieBreakOrder.length || policy.tieBreakOrder.length === 0) {
    throw new RankingError('RANKING_POLICY_INVALID', 'Ranking tie-break order must list each level exactly once');
  }
  if (policy.tieBreakOrder[policy.tieBreakOrder.length - 1] !== 'LEXICAL_VALIDATION_SUBJECT_ID') {
    throw new RankingError('RANKING_POLICY_INVALID', 'Ranking tie-break order must terminate in a total order');
  }
  const limitation = policy.economicLimitation;
  if (
    limitation.economicStatus !== 'FUNDING_EXCLUDED'
    || limitation.promotionEligible !== false
    || limitation.maxLifecycle !== 'PAPER'
    || limitation.fundingApplied !== false
    || policy.paperEconomicContribution !== 'NONE'
  ) {
    throw new RankingError('RANKING_ECONOMIC_LIMIT_VIOLATION', 'Phase15 may not weaken the frozen Phase14 economic limitation');
  }
}

assertPolicyIntegrity(P15_RANKING_V1);

/**
 * Deterministic policy identity. Binds the policy version, metric set, sources,
 * weights, directions, normalization algorithm, tie-break policy and economic
 * limitation semantics. No wall clock, host, or process value participates.
 */
export const P15_RANKING_POLICY_ID: string = sha256CanonicalJson(P15_RANKING_V1);

/** Looks up a frozen component policy, or throws rather than scoring with a default. */
export function rankingComponentPolicy(componentId: RankingComponentId): RankingComponentPolicy {
  const found = P15_RANKING_V1.components.find((component) => component.componentId === componentId);
  if (found === undefined) {
    throw new RankingError('RANKING_POLICY_INVALID', `Unknown ranking component: ${componentId}`);
  }
  return found;
}
