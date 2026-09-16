import { describe, expect, it } from 'vitest';
import { composeRankingRunSet } from '../../../src/ranking/core';
import { RankingError } from '../../../src/ranking/errors';
import { computeRankingRunId } from '../../../src/ranking/identity';
import type { RankingCandidateEvidence, RankedStrategyRankingResult } from '../../../src/ranking/types';
import { buildEvidence, everyPermutation, rankOrder, rankedResults, rotate, runForPair, TEST_PLAN_ID } from './helpers';

// P15 §15 — mandatory determinism matrix, exercised end-to-end through the
// pure ranking core (normalization -> composite -> tie-break -> identity).

function compose(evidences: readonly RankingCandidateEvidence[]) {
  return composeRankingRunSet(evidences, []);
}

const A = buildEvidence({ pair: 'BTC-INR', strategyId: 'EMA_TREND', metrics: { SHARPE: '3', SORTINO: '2', MAX_DRAWDOWN: '5', PROFIT_FACTOR: '2', EXPECTANCY: '500', OOS_CONSISTENCY: '1', PARAMETER_ROBUSTNESS: '0.95' } });
const B = buildEvidence({ pair: 'BTC-INR', strategyId: 'ATR_BREAKOUT', metrics: { SHARPE: '2', SORTINO: '1.5', MAX_DRAWDOWN: '10', PROFIT_FACTOR: '1.6', EXPECTANCY: '300', OOS_CONSISTENCY: '0.75', PARAMETER_ROBUSTNESS: '0.8' } });
const C = buildEvidence({ pair: 'BTC-INR', strategyId: 'RSI_MOMENTUM', metrics: { SHARPE: '1', SORTINO: '0.5', MAX_DRAWDOWN: '25', PROFIT_FACTOR: '1.1', EXPECTANCY: '50', OOS_CONSISTENCY: '0.5', PARAMETER_ROBUSTNESS: '0.4' } });

describe('P15 determinism — candidate ordering', () => {
  it('produces an identical run set for every input permutation (6 orderings)', () => {
    const baseline = compose([A, B, C]);
    for (const permutation of everyPermutation([A, B, C])) {
      const result = compose(permutation);
      expect(result.rankingRunSetSha256).toBe(baseline.rankingRunSetSha256);
      expect(runForPair(result, 'BTC-INR').rankingRunId).toBe(runForPair(baseline, 'BTC-INR').rankingRunId);
      expect(rankOrder(runForPair(result, 'BTC-INR'))).toEqual(['EMA_TREND', 'ATR_BREAKOUT', 'RSI_MOMENTUM']);
    }
  });

  it('is invariant to a simulated worker/concurrency completion order', () => {
    // Worker counts 1..5 producing rotated completion orders; the ranking core
    // observes only the candidate set, never the completion sequence.
    const baseline = compose([A, B, C]).rankingRunSetSha256;
    for (let workers = 1; workers <= 5; workers += 1) {
      expect(compose(rotate([A, B, C], workers)).rankingRunSetSha256).toBe(baseline);
    }
  });

  it('is invariant to the object key insertion order of the metric map', () => {
    const reordered: RankingCandidateEvidence = {
      identity: A.identity,
      metrics: Object.fromEntries([...Object.entries(A.metrics)].reverse()) as typeof A.metrics,
    };
    expect(compose([reordered, B]).rankingRunSetSha256).toBe(compose([A, B]).rankingRunSetSha256);
  });
});

describe('P15 determinism — Decimal canonicalization', () => {
  it('gives semantically equal but differently formatted metrics an identical identity', () => {
    const plain = buildEvidence({ pair: 'BTC-INR', strategyId: 'EMA_TREND', metrics: { SHARPE: '1.5', MAX_DRAWDOWN: '10' } });
    const padded = buildEvidence({ pair: 'BTC-INR', strategyId: 'EMA_TREND', metrics: { SHARPE: '1.500000000000000000', MAX_DRAWDOWN: '10.000' } });
    // The adapter canonicalizes on the way in; the identity input here is the
    // already-canonical form, so both must agree once normalized.
    const canonicalPadded: RankingCandidateEvidence = {
      identity: padded.identity,
      metrics: Object.fromEntries(Object.entries(padded.metrics).map(([key, metric]) => [
        key, metric.status === 'VALUE' ? { status: 'VALUE' as const, value: String(Number.parseFloat(metric.value)) } : metric,
      ])) as typeof padded.metrics,
    };
    expect(compose([canonicalPadded]).rankingRunSetSha256).toBe(compose([plain]).rankingRunSetSha256);
  });

  it('changes the run identity for a 1e-18 outcome-affecting metric difference', () => {
    const base = buildEvidence({ pair: 'BTC-INR', strategyId: 'EMA_TREND', metrics: { SHARPE: '1.000000000000000000' } });
    const nudged = buildEvidence({ pair: 'BTC-INR', strategyId: 'EMA_TREND', metrics: { SHARPE: '1.000000000000000001' } });
    const baseRun = runForPair(compose([base, B]), 'BTC-INR');
    const nudgedRun = runForPair(compose([nudged, B]), 'BTC-INR');
    expect(nudgedRun.rankingRunId).not.toBe(baseRun.rankingRunId);
    expect(nudgedRun.rankingRunSha256).not.toBe(baseRun.rankingRunSha256);
  });

  it('changes the run identity when a 1e-18 difference flips the ordering', () => {
    const lower = buildEvidence({ pair: 'BTC-INR', strategyId: 'X', metrics: { SHARPE: '1.000000000000000001' } });
    const higher = buildEvidence({ pair: 'BTC-INR', strategyId: 'X', metrics: { SHARPE: '1.000000000000000003' } });
    const rival = buildEvidence({ pair: 'BTC-INR', strategyId: 'Y', metrics: { SHARPE: '1.000000000000000002' } });
    expect(rankOrder(runForPair(compose([lower, rival]), 'BTC-INR'))).toEqual(['Y', 'X']);
    expect(rankOrder(runForPair(compose([higher, rival]), 'BTC-INR'))).toEqual(['X', 'Y']);
  });
});

describe('P15 determinism — universe shapes', () => {
  it('ranks a single candidate at rank 1 with a perfect composite score', () => {
    const run = runForPair(compose([A]), 'BTC-INR');
    expect(run.rankedCount).toBe(1);
    const [only] = rankedResults(run);
    expect(only?.rank).toBe(1);
    expect(only?.candidateCount).toBe(1);
    expect(only?.compositeScore).toBe('1');
    expect(only?.compositeTieGroupSize).toBe(1);
    expect(only?.tieBreakLevelApplied).toBeNull();
  });

  it('ranks two candidates 1 and 0', () => {
    const run = runForPair(compose([A, C]), 'BTC-INR');
    const ranked = rankedResults(run);
    expect(ranked.map((entry) => [entry.strategyId, entry.rank, entry.compositeScore])).toEqual([
      ['EMA_TREND', 1, '1'], ['RSI_MOMENTUM', 2, '0'],
    ]);
  });

  it('emits zero leaderboards for an empty authoritative universe rather than faking a ranking', () => {
    // The public entry point rejects an empty DECLARED universe outright
    // (see authority.test.ts); the core simply has nothing to rank.
    const empty = compose([]);
    expect(empty.runs).toEqual([]);
    expect(empty.rankingRunSetSha256).toHaveLength(64);
  });

  it('rejects a duplicate candidate identity deterministically and explicitly', () => {
    expect(() => compose([A, A])).toThrow(RankingError);
    expect(() => compose([A, A])).toThrow(/DUPLICATE_RANKING_CANDIDATE/);
  });
});

describe('P15 determinism — ties', () => {
  const baseMetrics = { SHARPE: '2', SORTINO: '2', MAX_DRAWDOWN: '10', PROFIT_FACTOR: '2', EXPECTANCY: '100', OOS_CONSISTENCY: '1', PARAMETER_ROBUSTNESS: '1' } as const;

  it('gives fully identical candidates identical composite scores and a total, stable order', () => {
    const tied = ['S_ALPHA', 'S_BETA', 'S_GAMMA'].map((strategyId) => buildEvidence({ pair: 'BTC-INR', strategyId, metrics: baseMetrics }));
    const baseline = compose(tied);
    const run = runForPair(baseline, 'BTC-INR');
    const ranked = rankedResults(run);
    expect(ranked.map((entry) => entry.compositeScore)).toEqual(['1', '1', '1']);
    expect(ranked.map((entry) => entry.compositeTieGroupSize)).toEqual([3, 3, 3]);
    // Every tie-break level above the lexical one is equal, so the terminal
    // level must be what separates them.
    expect(ranked.map((entry) => entry.tieBreakLevelApplied)).toEqual([null, 'LEXICAL_VALIDATION_SUBJECT_ID', 'LEXICAL_VALIDATION_SUBJECT_ID']);
    const ids = ranked.map((entry) => entry.validationSubjectId);
    expect([...ids].sort()).toEqual(ids);
    for (const permutation of everyPermutation(tied)) {
      expect(compose(permutation).rankingRunSetSha256).toBe(baseline.rankingRunSetSha256);
    }
  });

  it('resolves an EXACT composite tie by lower max drawdown (level 1)', () => {
    // Constructed so the two candidates score identically: `ZED` wins
    // MAX_DRAWDOWN (0.20) + EXPECTANCY (0.10); `ABE` wins SORTINO (0.15) +
    // PROFIT_FACTOR (0.15); SHARPE/OOS_CONSISTENCY/PARAMETER_ROBUSTNESS are
    // exactly equal so both score 1 there (0.40). Both composites = 0.70.
    // `ZED` sorts AFTER `ABE` lexically, so only the drawdown rule can put it
    // first.
    const zed = buildEvidence({ pair: 'BTC-INR', strategyId: 'ZED', metrics: { ...baseMetrics, MAX_DRAWDOWN: '5', EXPECTANCY: '200', SORTINO: '1', PROFIT_FACTOR: '1' } });
    const abe = buildEvidence({ pair: 'BTC-INR', strategyId: 'ABE', metrics: { ...baseMetrics, MAX_DRAWDOWN: '30', EXPECTANCY: '10', SORTINO: '5', PROFIT_FACTOR: '5' } });
    const ranked = rankedResults(runForPair(compose([abe, zed]), 'BTC-INR'));
    expect(ranked.map((entry) => entry.compositeScore)).toEqual(['0.7', '0.7']);
    expect(ranked.map((entry) => entry.strategyId)).toEqual(['ZED', 'ABE']);
    expect(ranked.map((entry) => entry.compositeTieGroupSize)).toEqual([2, 2]);
    expect(ranked.map((entry) => entry.tieBreakLevelApplied)).toEqual([null, 'LOWER_MAX_DRAWDOWN']);
    // Order-independent.
    expect(rankOrder(runForPair(compose([zed, abe]), 'BTC-INR'))).toEqual(['ZED', 'ABE']);
  });

  it('gives a lower-drawdown candidate the better ordinal slot on the drawdown component', () => {
    const shallow = buildEvidence({ pair: 'BTC-INR', strategyId: 'ZZZ_SHALLOW', metrics: { ...baseMetrics, MAX_DRAWDOWN: '4' } });
    const deep = buildEvidence({ pair: 'BTC-INR', strategyId: 'AAA_DEEP', metrics: { ...baseMetrics, MAX_DRAWDOWN: '40' } });
    const ranked = rankedResults(runForPair(compose([deep, shallow]), 'BTC-INR'));
    // MAX_DRAWDOWN is the only differing component, so composites differ; the
    // shallower drawdown must still win the ordinal slot.
    expect(ranked[0]?.strategyId).toBe('ZZZ_SHALLOW');
  });

  it('never uses insertion order as a tie-break', () => {
    const tied = ['M', 'N'].map((strategyId) => buildEvidence({ pair: 'BTC-INR', strategyId, metrics: baseMetrics }));
    const forward = rankedResults(runForPair(compose(tied), 'BTC-INR')).map((entry) => entry.validationSubjectId);
    const reverse = rankedResults(runForPair(compose([...tied].reverse()), 'BTC-INR')).map((entry) => entry.validationSubjectId);
    expect(reverse).toEqual(forward);
  });
});

describe('P15 determinism — pair isolation', () => {
  const btc = [A, B];
  const eth1 = buildEvidence({ pair: 'ETH-INR', strategyId: 'EMA_TREND', metrics: { SHARPE: '9', MAX_DRAWDOWN: '1' } });
  const eth2 = buildEvidence({ pair: 'ETH-INR', strategyId: 'RSI_MOMENTUM', metrics: { SHARPE: '0.1', MAX_DRAWDOWN: '80' } });

  it('emits one independent run per pair, sorted by pair', () => {
    const set = compose([eth2, ...btc, eth1]);
    expect(set.runs.map((run) => run.pair)).toEqual(['BTC-INR', 'ETH-INR']);
    expect(runForPair(set, 'BTC-INR').rankingRunId).not.toBe(runForPair(set, 'ETH-INR').rankingRunId);
  });

  it('leaves BTC ranking bit-for-bit unchanged when ETH candidates change', () => {
    const withEth = runForPair(compose([...btc, eth1, eth2]), 'BTC-INR');
    const withoutEth = runForPair(compose(btc), 'BTC-INR');
    const withDifferentEth = runForPair(compose([...btc, buildEvidence({ pair: 'ETH-INR', strategyId: 'ANY', metrics: { SHARPE: '1000' } })]), 'BTC-INR');
    expect(withEth.rankingRunId).toBe(withoutEth.rankingRunId);
    expect(withEth.rankingRunSha256).toBe(withoutEth.rankingRunSha256);
    expect(withDifferentEth.rankingRunSha256).toBe(withoutEth.rankingRunSha256);
  });

  it('never places a BTC candidate in an ETH leaderboard', () => {
    const set = compose([...btc, eth1, eth2]);
    for (const run of set.runs) {
      for (const result of run.results) expect(result.pair).toBe(run.pair);
    }
    expect(rankedResults(runForPair(set, 'ETH-INR')).map((entry) => entry.candidateCount)).toEqual([2, 2]);
  });
});

describe('P15 determinism — fail-closed metric validity', () => {
  it('excludes a candidate missing a required metric from the ranked universe', () => {
    const incomplete = buildEvidence({ pair: 'BTC-INR', strategyId: 'NO_ROBUSTNESS', metrics: { PARAMETER_ROBUSTNESS: null } });
    const run = runForPair(compose([A, incomplete]), 'BTC-INR');
    expect(run.candidateCount).toBe(2);
    expect(run.rankedCount).toBe(1);
    const insufficient = run.results.find((entry) => entry.status === 'INSUFFICIENT_RANKING_EVIDENCE');
    expect(insufficient?.strategyId).toBe('NO_ROBUSTNESS');
    expect(insufficient?.reasonCodes).toContain('REQUIRED_METRIC_UNAVAILABLE');
    // Never coerced to zero: there is no compositeScore field at all.
    expect(insufficient).not.toHaveProperty('compositeScore');
    expect(insufficient).not.toHaveProperty('rank');
  });

  it('reports every unavailable component rather than only the first', () => {
    const incomplete = buildEvidence({ pair: 'BTC-INR', strategyId: 'GAPS', metrics: { SHARPE: null, OOS_CONSISTENCY: null } });
    const run = runForPair(compose([incomplete]), 'BTC-INR');
    const row = run.results[0];
    expect(row?.status).toBe('INSUFFICIENT_RANKING_EVIDENCE');
    if (row?.status !== 'INSUFFICIENT_RANKING_EVIDENCE') throw new Error('expected insufficient row');
    expect(row.unavailableComponents.map((entry) => entry.componentId)).toEqual(['SHARPE', 'OOS_CONSISTENCY']);
  });

  it('keeps a fully-unrankable pair as an explicit empty leaderboard', () => {
    const incomplete = buildEvidence({ pair: 'BTC-INR', strategyId: 'GAPS', metrics: { SHARPE: null } });
    const run = runForPair(compose([incomplete]), 'BTC-INR');
    expect(run.rankedCount).toBe(0);
    expect(run.candidateCount).toBe(1);
    expect(run.rankingRunId).toHaveLength(64);
  });

  it('binds insufficient-evidence candidates into the run identity (the run identifies its whole evaluated universe)', () => {
    const incomplete = buildEvidence({ pair: 'BTC-INR', strategyId: 'GAPS', metrics: { SHARPE: null } });
    expect(runForPair(compose([A, incomplete]), 'BTC-INR').rankingRunId).not.toBe(runForPair(compose([A]), 'BTC-INR').rankingRunId);
  });
});

describe('P15 run identity', () => {
  it('binds the pair, the Phase12 plan identity and the candidate universe', () => {
    const universe = [{ evidence: A, rankable: true }];
    const base = computeRankingRunId({ pair: 'BTC-INR', validationPlanId: TEST_PLAN_ID, universe });
    expect(computeRankingRunId({ pair: 'ETH-INR', validationPlanId: TEST_PLAN_ID, universe })).not.toBe(base);
    expect(computeRankingRunId({ pair: 'BTC-INR', validationPlanId: 'e'.repeat(64), universe })).not.toBe(base);
    expect(computeRankingRunId({ pair: 'BTC-INR', validationPlanId: TEST_PLAN_ID, universe: [...universe, { evidence: B, rankable: true }] })).not.toBe(base);
  });

  it('is invariant to universe array order', () => {
    const forward = computeRankingRunId({ pair: 'BTC-INR', validationPlanId: TEST_PLAN_ID, universe: [{ evidence: A, rankable: true }, { evidence: B, rankable: true }] });
    const reverse = computeRankingRunId({ pair: 'BTC-INR', validationPlanId: TEST_PLAN_ID, universe: [{ evidence: B, rankable: true }, { evidence: A, rankable: true }] });
    expect(reverse).toBe(forward);
  });

  it('changes when the bound Phase12 subject result hash changes', () => {
    const tampered = buildEvidence({ pair: 'BTC-INR', strategyId: 'EMA_TREND', validationSubjectResultSha256: 'd'.repeat(64) });
    expect(runForPair(compose([tampered]), 'BTC-INR').rankingRunId).not.toBe(runForPair(compose([buildEvidence({ pair: 'BTC-INR', strategyId: 'EMA_TREND' })]), 'BTC-INR').rankingRunId);
  });

  it('gives each ranked row a content hash over its own full contents', () => {
    const ranked: readonly RankedStrategyRankingResult[] = rankedResults(runForPair(compose([A, B, C]), 'BTC-INR'));
    const hashes = new Set(ranked.map((entry) => entry.rankingResultSha256));
    expect(hashes.size).toBe(ranked.length);
    for (const entry of ranked) expect(entry.rankingResultSha256).toHaveLength(64);
  });

  it('refuses to mix candidates from different Phase12 validation plans in one pair run', () => {
    const foreign = buildEvidence({ pair: 'BTC-INR', strategyId: 'FOREIGN', validationPlanId: '0'.repeat(64) });
    expect(() => compose([A, foreign])).toThrow(/RANKING_EVIDENCE_CONFLICT/);
  });
});
