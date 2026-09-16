import { describe, expect, it } from 'vitest';
import { RankingError } from '../../../src/ranking/errors';
import { buildComponentScore, normalizeComponent } from '../../../src/ranking/normalize';
import { computeCompositeScore } from '../../../src/ranking/score';
import { rankCalc, rankCanonical, rankNormalizeDecimalString } from '../../../src/ranking/numeric';
import { P15_COMPONENT_IDS } from '../../../src/ranking/policy';
import type { RankingComponentScore } from '../../../src/ranking/types';

// P15 §7 — deterministic, candidate-set-relative ordinal normalization with no
// invented absolute financial ceiling anywhere.

function score(componentId: Parameters<typeof normalizeComponent>[0], values: readonly [string, string][]): Map<string, string> {
  const normalized = normalizeComponent(componentId, values.map(([validationSubjectId, value]) => ({ validationSubjectId, value })));
  return new Map([...normalized.entries()].map(([id, entry]) => [id, entry.componentScore]));
}

describe('P15 ordinal normalization', () => {
  it('scores a single-candidate universe 1 for every component', () => {
    for (const componentId of P15_COMPONENT_IDS) {
      const result = normalizeComponent(componentId, [{ validationSubjectId: 'only', value: '7' }]);
      expect(result.get('only')).toEqual({ ordinalPosition: 0, distinctValueCount: 1, componentScore: '1' });
    }
  });

  it('scores a universe with one distinct value 1 for every candidate', () => {
    const result = score('SHARPE', [['a', '2'], ['b', '2'], ['c', '2']]);
    expect([...result.values()]).toEqual(['1', '1', '1']);
  });

  it('orders higher-is-better descending: best = 1, worst = 0', () => {
    const result = score('SHARPE', [['low', '0.5'], ['high', '3'], ['mid', '1']]);
    expect(result.get('high')).toBe('1');
    expect(result.get('mid')).toBe('0.5');
    expect(result.get('low')).toBe('0');
  });

  it('INVERTS THE ORDERING, not the numeric sign, for lower-is-better metrics', () => {
    const result = score('MAX_DRAWDOWN', [['deep', '40'], ['shallow', '5'], ['mid', '20']]);
    expect(result.get('shallow')).toBe('1');
    expect(result.get('mid')).toBe('0.5');
    expect(result.get('deep')).toBe('0');
  });

  it('handles negative lower-is-better and higher-is-better values without sign tricks', () => {
    expect(score('SHARPE', [['a', '-3'], ['b', '-1'], ['c', '-2']])).toEqual(new Map([['b', '1'], ['c', '0.5'], ['a', '0']]));
    expect(score('MAX_DRAWDOWN', [['a', '-3'], ['b', '-1'], ['c', '-2']])).toEqual(new Map([['a', '1'], ['c', '0.5'], ['b', '0']]));
  });

  it('gives exactly equal metric values exactly equal component scores (dense collapse)', () => {
    const result = normalizeComponent('SHARPE', [
      { validationSubjectId: 'a', value: '2' }, { validationSubjectId: 'b', value: '2' },
      { validationSubjectId: 'c', value: '1' }, { validationSubjectId: 'd', value: '3' },
    ]);
    expect(result.get('d')?.componentScore).toBe('1');
    expect(result.get('a')?.componentScore).toBe('0.5');
    expect(result.get('b')?.componentScore).toBe('0.5');
    expect(result.get('c')?.componentScore).toBe('0');
    // Dense: three DISTINCT values, four candidates.
    expect(result.get('a')?.distinctValueCount).toBe(3);
    expect(result.get('a')?.ordinalPosition).toBe(result.get('b')?.ordinalPosition);
  });

  it('is independent of the input order', () => {
    const forward = score('SHARPE', [['a', '1'], ['b', '2'], ['c', '3']]);
    const reverse = score('SHARPE', [['c', '3'], ['b', '2'], ['a', '1']]);
    const shuffled = score('SHARPE', [['b', '2'], ['a', '1'], ['c', '3']]);
    expect(reverse).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it('separates values differing by 1e-18 rather than collapsing them', () => {
    const result = score('SHARPE', [['a', '1.000000000000000001'], ['b', '1.000000000000000002']]);
    expect(result.get('b')).toBe('1');
    expect(result.get('a')).toBe('0');
  });

  it('treats semantically equal but differently written decimals as one value', () => {
    expect(rankNormalizeDecimalString('1.50')).toBe(rankNormalizeDecimalString('1.5'));
    expect(rankNormalizeDecimalString('+1.5')).toBe('1.5');
    expect(rankNormalizeDecimalString('-0')).toBe('0');
    expect(rankNormalizeDecimalString('0.000')).toBe('0');
  });

  it('produces exact rational ordinal scores for a four-distinct-value universe', () => {
    const result = score('SHARPE', [['a', '4'], ['b', '3'], ['c', '2'], ['d', '1']]);
    expect(result.get('a')).toBe('1');
    expect(result.get('b')).toBe('0.666666666666666667');
    expect(result.get('c')).toBe('0.333333333333333333');
    expect(result.get('d')).toBe('0');
  });

  it('rejects an empty candidate set rather than inventing a score', () => {
    expect(() => normalizeComponent('SHARPE', [])).toThrow(RankingError);
  });

  it('rejects a duplicate candidate inside one component normalization', () => {
    expect(() => normalizeComponent('SHARPE', [
      { validationSubjectId: 'a', value: '1' }, { validationSubjectId: 'a', value: '2' },
    ])).toThrow(/DUPLICATE_RANKING_CANDIDATE/);
  });

  it('rejects a non-canonical decimal rather than coercing it', () => {
    for (const bad of ['', 'NaN', 'Infinity', '1e3', '1.2.3', 'abc']) {
      expect(() => normalizeComponent('SHARPE', [{ validationSubjectId: 'a', value: bad }])).toThrow(RankingError);
    }
  });
});

describe('P15 composite scoring', () => {
  function componentScores(values: Readonly<Record<string, string>>): RankingComponentScore[] {
    return P15_COMPONENT_IDS.map((componentId) => buildComponentScore(componentId, '1', {
      ordinalPosition: 0, distinctValueCount: 2, componentScore: values[componentId] ?? '0',
    }));
  }

  it('sums the published weighted scores with no residue (self-auditable rows)', () => {
    const scores = componentScores({ SHARPE: '1', SORTINO: '0.5', MAX_DRAWDOWN: '1', PROFIT_FACTOR: '0', EXPECTANCY: '0.25', OOS_CONSISTENCY: '1', PARAMETER_ROBUSTNESS: '0' });
    const composite = computeCompositeScore(scores);
    const readdition = scores.reduce((sum, entry) => sum.plus(rankCalc(entry.weightedScore)), rankCalc('0'));
    expect(rankCanonical(readdition)).toBe(composite);
    // 0.25*1 + 0.15*0.5 + 0.20*1 + 0.15*0 + 0.10*0.25 + 0.10*1 + 0.05*0
    expect(composite).toBe('0.65');
  });

  it('scores a perfect candidate exactly 1 and a worst candidate exactly 0', () => {
    expect(computeCompositeScore(componentScores(Object.fromEntries(P15_COMPONENT_IDS.map((id) => [id, '1']))))).toBe('1');
    expect(computeCompositeScore(componentScores(Object.fromEntries(P15_COMPONENT_IDS.map((id) => [id, '0']))))).toBe('0');
  });

  it('is independent of the component array order (frozen policy order is used)', () => {
    const scores = componentScores({ SHARPE: '1', SORTINO: '0.5', MAX_DRAWDOWN: '1', PROFIT_FACTOR: '0', EXPECTANCY: '0.25', OOS_CONSISTENCY: '1', PARAMETER_ROBUSTNESS: '0' });
    expect(computeCompositeScore([...scores].reverse())).toBe(computeCompositeScore(scores));
  });

  it('refuses to score a partial component set rather than treating a gap as zero', () => {
    const scores = componentScores({ SHARPE: '1' });
    expect(() => computeCompositeScore(scores.slice(0, 3))).toThrow(/RANKING_POLICY_INVALID/);
    expect(() => computeCompositeScore([...scores, scores[0] as RankingComponentScore])).toThrow(/RANKING_POLICY_INVALID/);
  });
});
