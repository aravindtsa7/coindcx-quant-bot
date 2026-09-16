import { RankingError } from './errors';
import { rankCalc, rankCanonical, RANK_ZERO } from './numeric';
import { P15_COMPONENT_IDS } from './policy';
import type { RankingComponentScore } from './types';

/**
 * Composite scoring.
 *
 * `compositeScore = sum(weightedScore_i)` over the frozen `P15_RANKING_V1`
 * component set, where each `weightedScore_i` is the already-quantized
 * `weight_i x componentScore_i` published on the result row. Quantizing each
 * term once and then summing (rather than summing at full precision and
 * quantizing at the end) makes the published row exactly self-auditable: the
 * seven published `weightedScore` values re-add to the published
 * `compositeScore` with no residue.
 *
 * Every component declared by the policy must be present exactly once. A
 * missing or duplicated component is a hard failure, never a zero.
 */
export function computeCompositeScore(componentScores: readonly RankingComponentScore[]): string {
  const seen = new Set<string>();
  for (const score of componentScores) {
    if (seen.has(score.componentId)) {
      throw new RankingError('RANKING_POLICY_INVALID', `Duplicate component in composite score: ${score.componentId}`);
    }
    seen.add(score.componentId);
  }
  for (const componentId of P15_COMPONENT_IDS) {
    if (!seen.has(componentId)) {
      throw new RankingError('RANKING_POLICY_INVALID', `Composite score is missing required component: ${componentId}`);
    }
  }
  if (seen.size !== P15_COMPONENT_IDS.length) {
    throw new RankingError('RANKING_POLICY_INVALID', 'Composite score carries a component the frozen policy does not declare');
  }

  // Summation order is the frozen policy order, not the caller's array order.
  const byId = new Map(componentScores.map((score) => [score.componentId, score] as const));
  let total = RANK_ZERO;
  for (const componentId of P15_COMPONENT_IDS) {
    const score = byId.get(componentId);
    if (score === undefined) {
      throw new RankingError('RANKING_POLICY_INVALID', `Composite score is missing required component: ${componentId}`);
    }
    total = total.plus(rankCalc(score.weightedScore));
  }
  return rankCanonical(total);
}
