import { describe, expect, it } from 'vitest';
import { PAPER_FUNDING_CAPABILITY, PaperFundingUnsupportedError, isPaperFundingProductionPromotionEvidence, rejectUnsupportedPaperFundingOperation } from '../../../src/execution/funding-capability';
import { composeRankingRunSet } from '../../../src/ranking/core';
import {
  attachPaperObservations, buildPaperObservationView, PAPER_OBSERVATION_NOT_OBSERVED,
  type PaperObservationLineage, type PaperObservationView,
} from '../../../src/ranking/paper-observation';
import { P15_ECONOMIC_LIMITATION } from '../../../src/ranking/policy';
import { buildEvidence, rankedResults, runForPair } from './helpers';

// P15 §3/§13/§14/§17 — the funding-excluded paper boundary and the promotion
// firewall. The central claim proved here is STRUCTURAL: funding-excluded paper
// economics cannot reach the code that computes a rank, because the ranking
// entry point has no parameter for them and the ranking identity is sealed
// before an observation exists.

const BTC = [
  buildEvidence({ pair: 'BTC-INR', strategyId: 'EMA_TREND', metrics: { SHARPE: '3', MAX_DRAWDOWN: '5' } }),
  buildEvidence({ pair: 'BTC-INR', strategyId: 'ATR_BREAKOUT', metrics: { SHARPE: '1', MAX_DRAWDOWN: '20' } }),
] as const;

function lineage(strategyId: string, overrides: Partial<PaperObservationLineage> = {}): PaperObservationLineage {
  return {
    accountId: 'paper-account-1',
    accountRevision: '42',
    executionPolicySnapshotId: 'a'.repeat(64),
    instrumentEconomicsSnapshotId: 'b'.repeat(64),
    pair: 'BTC-INR',
    strategyId,
    strategyVersion: '1.0.0',
    parameterHash: buildEvidence({ pair: 'BTC-INR', strategyId }).identity.parameterHash,
    ...overrides,
  };
}

function observation(strategyId: string, pnl: string): PaperObservationView {
  return buildPaperObservationView({
    lineage: lineage(strategyId),
    mechanicalHealth: { reconciliationStatus: 'HEALTHY', observationDurationMs: 14 * 86_400_000, fillCount: 120, closedTradeCount: 60, runtimeFaultCount: 0 },
    fundingExcludedValues: { realizedPnlInr: pnl, unrealizedPnlInr: '0', equityInr: pnl },
  });
}

describe('P15 frozen Phase14 economic limitation', () => {
  it('mirrors the genuine Phase14 funding disclosure field for field', () => {
    expect(P15_ECONOMIC_LIMITATION.fundingCapability).toBe(PAPER_FUNDING_CAPABILITY.fundingCapability);
    expect(P15_ECONOMIC_LIMITATION.fundingCapabilityReason).toBe(PAPER_FUNDING_CAPABILITY.reason);
    expect(P15_ECONOMIC_LIMITATION.fundingApplied).toBe(PAPER_FUNDING_CAPABILITY.fundingApplied);
    expect(P15_ECONOMIC_LIMITATION.economicStatus).toBe(PAPER_FUNDING_CAPABILITY.economicCompleteness);
    expect(P15_ECONOMIC_LIMITATION.paperEconomicStatus).toBe(PAPER_FUNDING_CAPABILITY.paperEconomicStatus);
    expect(P15_ECONOMIC_LIMITATION.pnlLabel).toBe(PAPER_FUNDING_CAPABILITY.pnlLabel);
  });

  it('leaves the Phase14 funding refusal untouched (no funding row or provider invented)', () => {
    expect(() => rejectUnsupportedPaperFundingOperation('APPLY')).toThrow(PaperFundingUnsupportedError);
    expect(() => rejectUnsupportedPaperFundingOperation('RECOVER')).toThrow(PaperFundingUnsupportedError);
    expect(isPaperFundingProductionPromotionEvidence()).toBe(false);
  });
});

describe('P15 promotion firewall', () => {
  it('marks every authoritative result FUNDING_EXCLUDED / promotionEligible=false / maxLifecycle=PAPER', () => {
    const incomplete = buildEvidence({ pair: 'ETH-INR', strategyId: 'GAPS', metrics: { SHARPE: null } });
    const set = composeRankingRunSet([...BTC, incomplete], []);
    expect(set.economicStatus).toBe('FUNDING_EXCLUDED');
    expect(set.promotionEligible).toBe(false);
    expect(set.maxLifecycle).toBe('PAPER');
    for (const run of set.runs) {
      expect(run.economicStatus).toBe('FUNDING_EXCLUDED');
      expect(run.promotionEligible).toBe(false);
      expect(run.maxLifecycle).toBe('PAPER');
      for (const row of run.results) {
        expect(row.economicStatus).toBe('FUNDING_EXCLUDED');
        expect(row.promotionEligible).toBe(false);
        expect(row.maxLifecycle).toBe('PAPER');
        expect(row.reasonCodes).toContain('FUNDING_EXCLUDED');
        expect(row.reasonCodes).toContain('PROMOTION_BLOCKED_FUNDING_EXCLUDED');
      }
    }
  });

  it('never emits a promoted lifecycle state anywhere in its output', () => {
    const serialized = JSON.stringify(attachPaperObservations(
      composeRankingRunSet([...BTC], []),
      { [BTC[0].identity.validationSubjectId]: observation('EMA_TREND', '100000') },
    ));
    for (const forbidden of ['PAPER_APPROVED', 'SHADOW', 'LIVE_CANDIDATE', '"LIVE"', 'RESEARCH_APPROVED']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain('FUNDING_EXCLUDED');
  });
});

describe('P15 funding-excluded paper PnL cannot affect ranking', () => {
  const baseline = composeRankingRunSet([...BTC], []);

  it('produces an identical composite score, rank and identity for +100000 vs -100000 paper PnL', () => {
    const profitable = attachPaperObservations(composeRankingRunSet([...BTC], []), {
      [BTC[0].identity.validationSubjectId]: observation('EMA_TREND', '100000'),
      [BTC[1].identity.validationSubjectId]: observation('ATR_BREAKOUT', '100000'),
    });
    const catastrophic = attachPaperObservations(composeRankingRunSet([...BTC], []), {
      [BTC[0].identity.validationSubjectId]: observation('EMA_TREND', '-100000'),
      [BTC[1].identity.validationSubjectId]: observation('ATR_BREAKOUT', '-100000'),
    });

    expect(catastrophic.ranking.rankingRunSetSha256).toBe(profitable.ranking.rankingRunSetSha256);
    expect(catastrophic.ranking.rankingRunSetSha256).toBe(baseline.rankingRunSetSha256);

    const left = rankedResults(runForPair(profitable.ranking, 'BTC-INR'));
    const right = rankedResults(runForPair(catastrophic.ranking, 'BTC-INR'));
    expect(right.map((row) => [row.strategyId, row.rank, row.compositeScore, row.rankingResultSha256]))
      .toEqual(left.map((row) => [row.strategyId, row.rank, row.compositeScore, row.rankingResultSha256]));
    expect(runForPair(catastrophic.ranking, 'BTC-INR').rankingRunId).toBe(runForPair(profitable.ranking, 'BTC-INR').rankingRunId);

    // And the frozen economic verdict is unchanged by a spectacular paper profit.
    for (const row of right) {
      expect(row.promotionEligible).toBe(false);
      expect(row.maxLifecycle).toBe('PAPER');
      expect(row.economicStatus).toBe('FUNDING_EXCLUDED');
    }
  });

  it('inverting the profitability ordering of the paper observations changes no rank', () => {
    const forward = attachPaperObservations(composeRankingRunSet([...BTC], []), {
      [BTC[0].identity.validationSubjectId]: observation('EMA_TREND', '-999999'),
      [BTC[1].identity.validationSubjectId]: observation('ATR_BREAKOUT', '999999'),
    });
    expect(rankedResults(runForPair(forward.ranking, 'BTC-INR')).map((row) => row.strategyId)).toEqual(['EMA_TREND', 'ATR_BREAKOUT']);
  });

  it('re-emits the authoritative ranking by reference, so it cannot have been recomputed', () => {
    const view = attachPaperObservations(baseline, { [BTC[0].identity.validationSubjectId]: observation('EMA_TREND', '100000') });
    expect(view.ranking).toBe(baseline);
    expect(view.paperObservationAffectsRanking).toBe(false);
  });

  it('offers no parameter through which a paper value could enter scoring', () => {
    // `composeRankingRunSet` takes authorized evidence and non-authoritative
    // rows only; `RankingCandidateEvidence` carries only the seven policy
    // components, none of which is a paper value.
    expect(Object.keys(BTC[0].metrics).sort()).toEqual([
      'EXPECTANCY', 'MAX_DRAWDOWN', 'OOS_CONSISTENCY', 'PARAMETER_ROBUSTNESS', 'PROFIT_FACTOR', 'SHARPE', 'SORTINO',
    ]);
  });
});

describe('P15 paper observation view', () => {
  it('labels every economic value funding-excluded and non-authoritative', () => {
    const view = observation('EMA_TREND', '12345.5');
    expect(view.status).toBe('OBSERVED');
    if (view.status !== 'OBSERVED') throw new Error('narrowing');
    expect(view.economicStatus).toBe('FUNDING_EXCLUDED');
    expect(view.fundingApplied).toBe(false);
    expect(view.paperEconomicStatus).toBe('PAPER_NOT_ECONOMICALLY_COMPLETE');
    for (const value of Object.values(view.nonAuthoritativeFundingExcluded)) {
      expect(value.label).toBe('FUNDING_EXCLUDED_PNL');
      expect(value.authoritative).toBe(false);
      expect(value.affectsCompositeScore).toBe(false);
    }
  });

  it('carries mechanical health separately from economics', () => {
    const view = observation('EMA_TREND', '1');
    if (view.status !== 'OBSERVED') throw new Error('narrowing');
    expect(view.mechanicalHealth).toEqual({
      reconciliationStatus: 'HEALTHY', observationDurationMs: 14 * 86_400_000, fillCount: 120, closedTradeCount: 60, runtimeFaultCount: 0,
    });
  });

  it('downgrades an observation whose lineage does not bind this candidate', () => {
    const foreign = buildPaperObservationView({
      lineage: lineage('EMA_TREND', { parameterHash: 'f'.repeat(64) }),
      mechanicalHealth: { reconciliationStatus: 'HEALTHY', observationDurationMs: 1, fillCount: 0, closedTradeCount: 0, runtimeFaultCount: 0 },
    });
    const view = attachPaperObservations(baselineSet(), { [BTC[0].identity.validationSubjectId]: foreign });
    const attached = view.paperObservations[BTC[0].identity.validationSubjectId];
    expect(attached?.status).toBe('LINEAGE_UNPROVEN');
  });

  it('reports NOT_OBSERVED for a candidate with no observation at all', () => {
    const view = attachPaperObservations(baselineSet(), {});
    expect(view.paperObservations[BTC[1].identity.validationSubjectId]).toBe(PAPER_OBSERVATION_NOT_OBSERVED);
  });

  it('canonicalizes observational decimals and refuses an unparseable one', () => {
    const padded = buildPaperObservationView({
      lineage: lineage('EMA_TREND'),
      mechanicalHealth: { reconciliationStatus: 'HEALTHY', observationDurationMs: 1, fillCount: 0, closedTradeCount: 0, runtimeFaultCount: 0 },
      fundingExcludedValues: { realizedPnlInr: '1.500', equityInr: '-0' },
    });
    if (padded.status !== 'OBSERVED') throw new Error('narrowing');
    expect(padded.nonAuthoritativeFundingExcluded['realizedPnlInr']?.value).toBe('1.5');
    expect(padded.nonAuthoritativeFundingExcluded['equityInr']?.value).toBe('0');

    const garbage = buildPaperObservationView({
      lineage: lineage('EMA_TREND'),
      mechanicalHealth: { reconciliationStatus: 'HEALTHY', observationDurationMs: 1, fillCount: 0, closedTradeCount: 0, runtimeFaultCount: 0 },
      fundingExcludedValues: { realizedPnlInr: 'N/A' },
    });
    expect(garbage.status).toBe('LINEAGE_UNPROVEN');
  });

  it('refuses non-durable mechanical counts rather than inventing them', () => {
    const view = buildPaperObservationView({
      lineage: lineage('EMA_TREND'),
      mechanicalHealth: { reconciliationStatus: 'UNKNOWN', observationDurationMs: -1, fillCount: 0, closedTradeCount: 0, runtimeFaultCount: 0 },
    });
    expect(view.status).toBe('LINEAGE_UNPROVEN');
  });
});

function baselineSet() {
  return composeRankingRunSet([...BTC], []);
}
