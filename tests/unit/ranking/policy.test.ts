import { describe, expect, it } from 'vitest';
import { sha256CanonicalJson } from '../../../src/backtest/canonical-json';
import {
  P15_COMPONENT_IDS, P15_ECONOMIC_LIMITATION, P15_RANKING_POLICY_ID, P15_RANKING_V1, P15_TIE_BREAK_ORDER,
  rankingComponentPolicy,
} from '../../../src/ranking/policy';
import { rankCalc, rankCanonical } from '../../../src/ranking/numeric';
import { RankingError } from '../../../src/ranking/errors';

// P15 §5/§6/§14 — the frozen policy is the single place outcome-affecting
// ranking decisions live, and its identity binds every one of them.

describe('P15_RANKING_V1 frozen policy', () => {
  it('declares exactly the seven mandated components with the mandated weights', () => {
    expect(P15_COMPONENT_IDS).toEqual([
      'SHARPE', 'SORTINO', 'MAX_DRAWDOWN', 'PROFIT_FACTOR', 'EXPECTANCY', 'OOS_CONSISTENCY', 'PARAMETER_ROBUSTNESS',
    ]);
    expect(P15_RANKING_V1.components.map((component) => [component.componentId, component.weight])).toEqual([
      ['SHARPE', '0.25'], ['SORTINO', '0.15'], ['MAX_DRAWDOWN', '0.20'], ['PROFIT_FACTOR', '0.15'],
      ['EXPECTANCY', '0.10'], ['OOS_CONSISTENCY', '0.10'], ['PARAMETER_ROBUSTNESS', '0.05'],
    ]);
  });

  it('weights total exactly 1 under Decimal arithmetic', () => {
    const total = P15_RANKING_V1.components.reduce((sum, component) => sum.plus(rankCalc(component.weight)), rankCalc('0'));
    expect(rankCanonical(total)).toBe('1');
  });

  it('assigns the mandated direction to each component', () => {
    expect(rankingComponentPolicy('MAX_DRAWDOWN').direction).toBe('LOWER_IS_BETTER');
    for (const componentId of P15_COMPONENT_IDS) {
      if (componentId === 'MAX_DRAWDOWN') continue;
      expect(rankingComponentPolicy(componentId).direction).toBe('HIGHER_IS_BETTER');
    }
  });

  it('declares every component required (fail-closed, never re-weighted)', () => {
    for (const component of P15_RANKING_V1.components) expect(component.required).toBe(true);
  });

  it('binds each component to a real Phase12 authoritative source', () => {
    expect(P15_RANKING_V1.components.map((component) => component.source)).toEqual([
      { kind: 'AGGREGATE_OOS_METRIC', metric: 'sharpe' },
      { kind: 'AGGREGATE_OOS_METRIC', metric: 'sortino' },
      { kind: 'AGGREGATE_OOS_METRIC', metric: 'maxDrawdownPercent' },
      { kind: 'AGGREGATE_OOS_METRIC', metric: 'netDailyProfitFactor' },
      { kind: 'AGGREGATE_OOS_METRIC', metric: 'netDailyExpectancy' },
      { kind: 'GATE_OBSERVED_VALUE', gateId: 'GATE-08', gateName: 'MIN_OOS_FOLD_PASS_RATIO' },
      { kind: 'SUBJECT_METRIC', metric: 'parameterNeighborhoodSensitivity' },
    ]);
  });

  it('declares the mandated tie-break order and terminates in a total order', () => {
    expect(P15_TIE_BREAK_ORDER).toEqual([
      'LOWER_MAX_DRAWDOWN', 'HIGHER_SHARPE', 'HIGHER_SORTINO', 'HIGHER_PROFIT_FACTOR', 'LEXICAL_VALIDATION_SUBJECT_ID',
    ]);
  });

  it('forbids wall-clock, insertion-order and randomness tie-breaks by omission', () => {
    const serialized = JSON.stringify(P15_RANKING_V1);
    for (const forbidden of ['createdAt', 'insertion', 'worker', 'random', 'duration', 'clock']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('declares exact Decimal semantics and forbids floating point', () => {
    expect(P15_RANKING_V1.decimal).toEqual({
      calculationPrecision: 128, publishedScale: 18, rounding: 'ROUND_HALF_UP', floatingPointArithmetic: 'FORBIDDEN',
    });
  });

  it('declares pair-local candidate-set-relative normalization, not absolute ceilings', () => {
    expect(P15_RANKING_V1.normalization).toEqual({
      algorithm: 'P15_CANDIDATE_SET_RELATIVE_DENSE_ORDINAL_V1',
      scope: 'PAIR_LOCAL',
      tieCollapse: 'DENSE_EQUAL_VALUES_SHARE_POSITION',
      bestScore: '1',
      worstScore: '0',
      singleDistinctValueScore: '1',
    });
  });

  it('freezes the Phase14 economic limitation and contributes zero paper economics', () => {
    expect(P15_ECONOMIC_LIMITATION).toEqual({
      economicStatus: 'FUNDING_EXCLUDED',
      fundingCapability: 'FUNDING_UNSUPPORTED',
      fundingCapabilityReason: 'COINDCX_PROVIDER_EVIDENCE_INCOMPLETE',
      fundingApplied: false,
      paperEconomicStatus: 'PAPER_NOT_ECONOMICALLY_COMPLETE',
      pnlLabel: 'FUNDING_EXCLUDED_PNL',
      promotionEligible: false,
      maxLifecycle: 'PAPER',
    });
    expect(P15_RANKING_V1.paperEconomicContribution).toBe('NONE');
  });

  it('is deeply immutable', () => {
    expect(Object.isFrozen(P15_RANKING_V1)).toBe(true);
    expect(Object.isFrozen(P15_RANKING_V1.components)).toBe(true);
    expect(Object.isFrozen(P15_ECONOMIC_LIMITATION)).toBe(true);
    expect(() => { (P15_ECONOMIC_LIMITATION as { promotionEligible: boolean }).promotionEligible = true; }).toThrow();
    const first = P15_RANKING_V1.components[0];
    expect(first).toBeDefined();
    expect(() => { (first as unknown as { weight: string }).weight = '0.99'; }).toThrow();
  });

  it('derives rankingPolicyId as the canonical hash of the whole frozen policy', () => {
    expect(P15_RANKING_POLICY_ID).toBe(sha256CanonicalJson(P15_RANKING_V1));
    expect(P15_RANKING_POLICY_ID).toHaveLength(64);
  });

  it('changes rankingPolicyId when any outcome-affecting policy field changes', () => {
    const reweighted = { ...P15_RANKING_V1, components: P15_RANKING_V1.components.map((component, index) => (index === 0 ? { ...component, weight: '0.30' } : component)) };
    const reversed = { ...P15_RANKING_V1, tieBreakOrder: [...P15_TIE_BREAK_ORDER].reverse() };
    const redirected = { ...P15_RANKING_V1, components: P15_RANKING_V1.components.map((component) => (component.componentId === 'MAX_DRAWDOWN' ? { ...component, direction: 'HIGHER_IS_BETTER' as const } : component)) };
    const resourced = { ...P15_RANKING_V1, components: P15_RANKING_V1.components.map((component) => (component.componentId === 'PROFIT_FACTOR' ? { ...component, source: { kind: 'AGGREGATE_OOS_METRIC' as const, metric: 'grossTradeProfitFactor' } } : component)) };
    for (const mutated of [reweighted, reversed, redirected, resourced]) {
      expect(sha256CanonicalJson(mutated)).not.toBe(P15_RANKING_POLICY_ID);
    }
  });

  it('rejects an unknown component rather than scoring with a default', () => {
    expect(() => rankingComponentPolicy('NOT_A_COMPONENT' as never)).toThrow(RankingError);
  });
});
