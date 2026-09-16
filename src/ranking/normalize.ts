import { RankingError } from './errors';
import { rankCalc, rankCanonical, rankCompareDecimals, rankIntegerCalc, RANK_ONE } from './numeric';
import { rankingComponentPolicy } from './policy';
import type { RankingComponentDirection, RankingComponentId, RankingComponentScore } from './types';

/**
 * `P15_CANDIDATE_SET_RELATIVE_DENSE_ORDINAL_V1`.
 *
 * Phase15 invents no absolute financial ceiling ("Sharpe 3 = perfect"). A
 * component is normalized ONLY against the other candidates of the same pair,
 * by exact Decimal comparison:
 *
 *  1. Collect the candidates' canonical component values.
 *  2. Reduce to the DISTINCT values and order them best -> worst
 *     (descending for HIGHER_IS_BETTER, ascending for LOWER_IS_BETTER - the
 *     ORDER is inverted for lower-is-better metrics, never the numeric sign).
 *  3. Give each distinct value a dense ordinal position `d` in `[0, D-1]`, so
 *     equal metric values necessarily receive an equal component score.
 *  4. `componentScore = D === 1 ? 1 : (D - 1 - d) / (D - 1)`, evaluated in the
 *     128-digit isolated Decimal context and quantized exactly once.
 *
 * A universe with a single distinct value (which includes every
 * single-candidate universe) scores 1 for that component.
 *
 * Nothing here reads a clock, a worker id, an insertion order, or an object
 * key-iteration order: the only inputs are the candidate values themselves.
 */

export interface ComponentValueInput {
  readonly validationSubjectId: string;
  readonly value: string;
}

export interface NormalizedComponentValue {
  readonly ordinalPosition: number;
  readonly distinctValueCount: number;
  readonly componentScore: string;
}

function orderDistinctValues(values: readonly string[], direction: RankingComponentDirection): readonly string[] {
  const distinct = [...new Set(values)];
  const sign = direction === 'HIGHER_IS_BETTER' ? -1 : 1;
  return distinct.sort((left, right) => {
    const comparison = rankCompareDecimals(rankCalc(left), rankCalc(right));
    if (comparison !== 0) return comparison * sign;
    // Unreachable for distinct canonical strings; kept as a total-order guard.
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * Normalizes one component across one pair-local candidate set. The returned
 * map is keyed by `validationSubjectId`; every input subject is present.
 */
export function normalizeComponent(
  componentId: RankingComponentId,
  inputs: readonly ComponentValueInput[],
): ReadonlyMap<string, NormalizedComponentValue> {
  if (inputs.length === 0) {
    throw new RankingError('RANKING_NUMERIC_FAILURE', `Cannot normalize component ${componentId} over an empty candidate set`);
  }
  const { direction } = rankingComponentPolicy(componentId);
  // Validate EVERY value up front. Ordering alone would not do it: a
  // one-distinct-value universe never invokes the comparator, so a
  // non-canonical string could otherwise reach a published `metricValue`.
  for (const input of inputs) rankCalc(input.value);
  const ordered = orderDistinctValues(inputs.map((input) => input.value), direction);
  const distinctValueCount = ordered.length;
  const positionByValue = new Map<string, number>();
  ordered.forEach((value, index) => positionByValue.set(value, index));

  const span = distinctValueCount - 1;
  const denominator = span === 0 ? null : rankIntegerCalc(span);

  const result = new Map<string, NormalizedComponentValue>();
  for (const input of inputs) {
    const ordinalPosition = positionByValue.get(input.value);
    if (ordinalPosition === undefined) {
      throw new RankingError('RANKING_NUMERIC_FAILURE', `Component ${componentId} lost a candidate value during normalization`);
    }
    const componentScore = denominator === null
      ? rankCanonical(RANK_ONE)
      : rankCanonical(rankIntegerCalc(span - ordinalPosition).div(denominator));
    if (result.has(input.validationSubjectId)) {
      throw new RankingError('DUPLICATE_RANKING_CANDIDATE', `Duplicate candidate in component ${componentId} normalization: ${input.validationSubjectId}`);
    }
    result.set(input.validationSubjectId, Object.freeze({ ordinalPosition, distinctValueCount, componentScore }));
  }
  return result;
}

/** Builds the published, self-auditable component score row. */
export function buildComponentScore(
  componentId: RankingComponentId,
  metricValue: string,
  normalized: NormalizedComponentValue,
): RankingComponentScore {
  const { weight, direction } = rankingComponentPolicy(componentId);
  return Object.freeze({
    componentId,
    weight,
    direction,
    metricValue,
    ordinalPosition: normalized.ordinalPosition,
    distinctValueCount: normalized.distinctValueCount,
    componentScore: normalized.componentScore,
    weightedScore: rankCanonical(rankCalc(weight).times(rankCalc(normalized.componentScore))),
  });
}
