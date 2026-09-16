import { describe, expect, it } from 'vitest';
import { composeRankingRunSet } from '../../../src/ranking/core';
import { RankingError } from '../../../src/ranking/errors';
import {
  StrategyRankingRepository, toRankingResultRow,
  type RankingEvidenceStore, type RankingResultRow, type RankingRunRow, type StoredRankingRunSummary,
} from '../../../src/ranking/persistence/ranking-repository';
import type { StrategyRankingRun } from '../../../src/ranking/types';
import { buildEvidence, runForPair } from './helpers';

// P15 §11 — append-only, idempotent, restart-reproducible ranking evidence.
// Static store double: the repository's immutability/idempotence rules are
// datasource-independent and are proved without a live MySQL instance, matching
// the repository's existing Prisma-testing convention.

class InMemoryRankingStore implements RankingEvidenceStore {
  public readonly runs = new Map<string, RankingRunRow>();
  public readonly results = new Map<string, RankingResultRow>();
  public insertCalls = 0;

  public findRun(rankingRunId: string): Promise<StoredRankingRunSummary | null> {
    const row = this.runs.get(rankingRunId);
    return Promise.resolve(row === undefined ? null : { rankingRunId: row.rankingRunId, rankingRunSha256: row.rankingRunSha256 });
  }

  public insertRun(run: RankingRunRow, results: readonly RankingResultRow[]): Promise<void> {
    this.insertCalls += 1;
    if (this.runs.has(run.rankingRunId)) throw new Error('primary key violation');
    this.runs.set(run.rankingRunId, run);
    for (const result of results) {
      if (this.results.has(result.rankingResultSha256)) throw new Error('primary key violation');
      this.results.set(result.rankingResultSha256, result);
    }
    return Promise.resolve();
  }
}

const EVIDENCES = [
  buildEvidence({ pair: 'BTC-INR', strategyId: 'EMA_TREND', metrics: { SHARPE: '3', MAX_DRAWDOWN: '5' } }),
  buildEvidence({ pair: 'BTC-INR', strategyId: 'ATR_BREAKOUT', metrics: { SHARPE: '1', MAX_DRAWDOWN: '20' } }),
  buildEvidence({ pair: 'BTC-INR', strategyId: 'GAPPY', metrics: { PARAMETER_ROBUSTNESS: null } }),
  buildEvidence({ pair: 'ETH-INR', strategyId: 'EMA_TREND', metrics: { SHARPE: '2' } }),
] as const;

function freshRunSet() {
  return composeRankingRunSet([...EVIDENCES], []);
}

describe('P15 ranking persistence', () => {
  it('inserts a completed pair-local run and all of its result rows', async () => {
    const store = new InMemoryRankingStore();
    const repository = new StrategyRankingRepository(store);
    const run = runForPair(freshRunSet(), 'BTC-INR');
    expect(await repository.persistRun(run)).toEqual({ rankingRunId: run.rankingRunId, outcome: 'INSERTED' });
    expect(store.runs.size).toBe(1);
    expect(store.results.size).toBe(run.results.length);
  });

  it('is idempotent: re-persisting the identical run writes nothing', async () => {
    const store = new InMemoryRankingStore();
    const repository = new StrategyRankingRepository(store);
    const run = runForPair(freshRunSet(), 'BTC-INR');
    await repository.persistRun(run);
    expect(await repository.persistRun(run)).toEqual({ rankingRunId: run.rankingRunId, outcome: 'ALREADY_IDENTICAL' });
    expect(store.insertCalls).toBe(1);
  });

  it('is restart-reproducible: a recomputed run collides on the same deterministic id', async () => {
    const store = new InMemoryRankingStore();
    const repository = new StrategyRankingRepository(store);
    await repository.persistRun(runForPair(freshRunSet(), 'BTC-INR'));
    // Simulated process restart: nothing is replayed, the ranking is simply
    // recomputed from the same Phase12 evidence in a different input order.
    const recomputed = runForPair(composeRankingRunSet([...EVIDENCES].reverse(), []), 'BTC-INR');
    expect(await repository.persistRun(recomputed)).toEqual({ rankingRunId: recomputed.rankingRunId, outcome: 'ALREADY_IDENTICAL' });
    expect(store.insertCalls).toBe(1);
  });

  it('fails closed on a same-id / different-content write instead of overwriting', async () => {
    const store = new InMemoryRankingStore();
    const repository = new StrategyRankingRepository(store);
    const run = runForPair(freshRunSet(), 'BTC-INR');
    await repository.persistRun(run);
    const tampered = { ...run, rankingRunSha256: 'e'.repeat(64) } as StrategyRankingRun;
    await expect(repository.persistRun(tampered)).rejects.toThrow(RankingError);
    await expect(repository.persistRun(tampered)).rejects.toThrow(/RANKING_EVIDENCE_CONFLICT/);
    expect(store.insertCalls).toBe(1);
  });

  it('refuses to persist a run that weakens the frozen economic limitation', async () => {
    const repository = new StrategyRankingRepository(new InMemoryRankingStore());
    const run = runForPair(freshRunSet(), 'BTC-INR');
    for (const weakened of [
      { ...run, promotionEligible: true },
      { ...run, economicStatus: 'FUNDING_INCLUDED' },
      { ...run, maxLifecycle: 'SHADOW' },
    ] as unknown as StrategyRankingRun[]) {
      await expect(repository.persistRun(weakened)).rejects.toThrow(/RANKING_ECONOMIC_LIMIT_VIOLATION/);
    }
  });

  it('persists every pair-local run of a set in deterministic pair order', async () => {
    const store = new InMemoryRankingStore();
    const repository = new StrategyRankingRepository(store);
    const set = freshRunSet();
    const outcomes = await repository.persistRunSet(set);
    expect(outcomes.map((entry) => entry.outcome)).toEqual(['INSERTED', 'INSERTED']);
    expect([...store.runs.values()].map((row) => row.pair)).toEqual(['BTC-INR', 'ETH-INR']);
    expect(await repository.persistRunSet(set)).toEqual(outcomes.map((entry) => ({ ...entry, outcome: 'ALREADY_IDENTICAL' })));
  });

  it('stores decimals as canonical strings and never fabricates a score for an unrankable row', () => {
    const run = runForPair(freshRunSet(), 'BTC-INR');
    const rows = run.results.map(toRankingResultRow);
    const ranked = rows.find((row) => row.status === 'RANKED');
    const gap = rows.find((row) => row.status === 'INSUFFICIENT_RANKING_EVIDENCE');
    expect(typeof ranked?.compositeScore).toBe('string');
    expect(ranked?.compositeScore).toMatch(/^-?\d+(\.\d+)?$/);
    expect(ranked?.componentScoresJson).toContain('"componentId"');
    expect(gap?.compositeScore).toBeNull();
    expect(gap?.rank).toBeNull();
    expect(gap?.componentScoresJson).toBeNull();
    expect(gap?.unavailableComponentsJson).toContain('PARAMETER_ROBUSTNESS');
    for (const row of rows) {
      expect(row.promotionEligible).toBe(false);
      expect(row.economicStatus).toBe('FUNDING_EXCLUDED');
      expect(row.maxLifecycle).toBe('PAPER');
    }
  });

  it('exposes no update or delete method on the repository surface', () => {
    const names = new Set([
      ...Object.getOwnPropertyNames(StrategyRankingRepository.prototype),
      ...Object.getOwnPropertyNames(new StrategyRankingRepository(new InMemoryRankingStore())),
    ]);
    expect([...names].sort()).toEqual(['constructor', 'persistRun', 'persistRunSet']);
  });
});
