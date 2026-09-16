import { RankingError } from './errors';
import { rankCalc, rankCompareDecimals } from './numeric';
import { P15_TIE_BREAK_ORDER } from './policy';
import type { RankingComponentId, RankingTieBreakLevel } from './types';

/**
 * Deterministic total ordering for a pair-local candidate set.
 *
 * Primary key: `compositeScore`, descending, compared as exact Decimals (not
 * as strings, so a semantically-equal-but-differently-written value can never
 * masquerade as a tie-break).
 *
 * Tie-breaks are applied in the frozen `P15_TIE_BREAK_ORDER` and nothing else.
 * `createdAt`, database insertion id, worker index, execution duration, wall
 * clock and randomness are structurally absent: this module receives only
 * canonical metric values and the canonical `validationSubjectId`.
 *
 * The final level is lexical `validationSubjectId` order, which makes the
 * comparator a TOTAL order (candidate identities are unique inside a run, so
 * `compare` never returns 0 for two distinct candidates).
 */

interface TieBreakRule {
  readonly level: RankingTieBreakLevel;
  readonly componentId: RankingComponentId | null;
  /** `1` = ascending (lower wins), `-1` = descending (higher wins). */
  readonly sign: 1 | -1;
}

const TIE_BREAK_RULES: readonly TieBreakRule[] = Object.freeze([
  Object.freeze({ level: 'LOWER_MAX_DRAWDOWN' as const, componentId: 'MAX_DRAWDOWN' as const, sign: 1 as const }),
  Object.freeze({ level: 'HIGHER_SHARPE' as const, componentId: 'SHARPE' as const, sign: -1 as const }),
  Object.freeze({ level: 'HIGHER_SORTINO' as const, componentId: 'SORTINO' as const, sign: -1 as const }),
  Object.freeze({ level: 'HIGHER_PROFIT_FACTOR' as const, componentId: 'PROFIT_FACTOR' as const, sign: -1 as const }),
  Object.freeze({ level: 'LEXICAL_VALIDATION_SUBJECT_ID' as const, componentId: null, sign: 1 as const }),
]);

// Self-validating: the rule table must cover the frozen policy order exactly,
// in the same sequence. A policy change without a rule change fails at load.
(function assertTieBreakTableIntegrity(): void {
  if (TIE_BREAK_RULES.length !== P15_TIE_BREAK_ORDER.length) {
    throw new RankingError('RANKING_POLICY_INVALID', 'Tie-break rule table does not cover the frozen tie-break order');
  }
  P15_TIE_BREAK_ORDER.forEach((level, index) => {
    if (TIE_BREAK_RULES[index]?.level !== level) {
      throw new RankingError('RANKING_POLICY_INVALID', `Tie-break rule ${index} does not match frozen level ${level}`);
    }
  });
})();

export interface RankingOrderingCandidate {
  readonly validationSubjectId: string;
  readonly compositeScore: string;
  readonly metricValues: Readonly<Record<RankingComponentId, string>>;
}

function metricValue(candidate: RankingOrderingCandidate, componentId: RankingComponentId): string {
  const value = candidate.metricValues[componentId];
  if (value === undefined) {
    throw new RankingError('RANKING_NUMERIC_FAILURE', `Tie-break requires an authoritative ${componentId} value`);
  }
  return value;
}

function compareAtLevel(left: RankingOrderingCandidate, right: RankingOrderingCandidate, rule: TieBreakRule): -1 | 0 | 1 {
  if (rule.componentId === null) {
    const a = left.validationSubjectId;
    const b = right.validationSubjectId;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const comparison = rankCompareDecimals(rankCalc(metricValue(left, rule.componentId)), rankCalc(metricValue(right, rule.componentId)));
  return (comparison * rule.sign) as -1 | 0 | 1;
}

/**
 * The first frozen tie-break level that separates two candidates with an equal
 * composite score, or `null` when their composite scores already differ.
 */
export function resolveTieBreakLevel(left: RankingOrderingCandidate, right: RankingOrderingCandidate): RankingTieBreakLevel | null {
  if (rankCompareDecimals(rankCalc(left.compositeScore), rankCalc(right.compositeScore)) !== 0) return null;
  for (const rule of TIE_BREAK_RULES) {
    if (compareAtLevel(left, right, rule) !== 0) return rule.level;
  }
  return null;
}

/** Total ordering comparator: composite descending, then the frozen tie-break order. */
export function compareRankingCandidates(left: RankingOrderingCandidate, right: RankingOrderingCandidate): -1 | 0 | 1 {
  const composite = rankCompareDecimals(rankCalc(left.compositeScore), rankCalc(right.compositeScore));
  if (composite !== 0) return (composite * -1) as -1 | 1;
  for (const rule of TIE_BREAK_RULES) {
    const comparison = compareAtLevel(left, right, rule);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

/**
 * Orders a pair-local candidate set. The input array order is irrelevant: the
 * comparator is total, so the output is the same permutation for every input
 * permutation. Two candidates comparing equal at every level would mean two
 * identical `validationSubjectId`s, which the engine rejects up front.
 */
export function orderRankingCandidates(candidates: readonly RankingOrderingCandidate[]): readonly RankingOrderingCandidate[] {
  const ordered = [...candidates].sort(compareRankingCandidates);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous === undefined || current === undefined) {
      throw new RankingError('RANKING_NUMERIC_FAILURE', 'Ranking ordering produced a hole');
    }
    if (compareRankingCandidates(previous, current) === 0) {
      throw new RankingError('DUPLICATE_RANKING_CANDIDATE', `Ranking order is not total for candidate ${current.validationSubjectId}`);
    }
  }
  return Object.freeze(ordered);
}
