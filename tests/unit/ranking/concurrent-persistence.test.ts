import { beforeAll, describe, expect, it } from 'vitest';
import { RankingError } from '../../../src/ranking/errors';
import {
  RankingEvidenceUniqueViolationError,
  StrategyRankingRepository,
  type RankingEvidenceStore,
  type RankingResultRow,
  type RankingRunRow,
  type StoredRankingRunSummary,
} from '../../../src/ranking/persistence/ranking-repository';
import type { StrategyRankingRun } from '../../../src/ranking/types';
import { getGenuineRankingFixture, getGenuineRankingRunSet, runForPair, testAuthority } from './helpers';

class ConcurrentStoreDouble implements RankingEvidenceStore {
  public readonly runs = new Map<string, RankingRunRow>();
  public readonly results = new Map<string, RankingResultRow>();
  public insertCalls = 0;
  public findCalls = 0;

  public async findRun(rankingRunId: string): Promise<StoredRankingRunSummary | null> {
    this.findCalls += 1;
    // Slight async tick to allow true concurrency races
    await new Promise((resolve) => setTimeout(resolve, 5));
    const row = this.runs.get(rankingRunId);
    return row === undefined ? null : { rankingRunId: row.rankingRunId, rankingRunSha256: row.rankingRunSha256 };
  }

  public async insertRun(run: RankingRunRow, results: readonly RankingResultRow[]): Promise<void> {
    this.insertCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.runs.has(run.rankingRunId)) {
      throw new RankingEvidenceUniqueViolationError(`Unique constraint failed on rankingRunId: ${run.rankingRunId}`);
    }
    this.runs.set(run.rankingRunId, run);
    for (const res of results) {
      if (this.results.has(res.rankingResultSha256)) {
        throw new RankingEvidenceUniqueViolationError(`Unique constraint failed on rankingResultSha256: ${res.rankingResultSha256}`);
      }
      this.results.set(res.rankingResultSha256, res);
    }
  }
}

async function genuineRun(): Promise<StrategyRankingRun> {
  const runSet = await getGenuineRankingRunSet();
  return runForPair(runSet, 'BTC-INR');
}

describe('Finding 3 — Concurrent Persistence Idempotence', () => {
  beforeAll(async () => {
    await getGenuineRankingFixture();
  }, 60_000);

  it('concurrent identical persist: exactly one INSERTED, all competitors ALREADY_IDENTICAL', async () => {
    const store = new ConcurrentStoreDouble();
    const repository = new StrategyRankingRepository(store, testAuthority());
    const run = await genuineRun();

    // 5 concurrent identical persists
    const results = await Promise.all([
      repository.persistRun(run),
      repository.persistRun(run),
      repository.persistRun(run),
      repository.persistRun(run),
      repository.persistRun(run),
    ]);

    const inserted = results.filter((r) => r.outcome === 'INSERTED');
    const identical = results.filter((r) => r.outcome === 'ALREADY_IDENTICAL');

    expect(inserted).toHaveLength(1);
    expect(identical).toHaveLength(4);
    expect(store.runs.size).toBe(1);
    expect(store.results.size).toBe(run.results.length);
  });

  it('concurrent conflict: same rankingRunId with different content hash throws RANKING_EVIDENCE_CONFLICT', async () => {
    const store = new ConcurrentStoreDouble();
    const repository = new StrategyRankingRepository(store, testAuthority());
    const run = await genuineRun();

    // Seed the store with an existing run under the same rankingRunId but different sha256
    store.runs.set(run.rankingRunId, {
      rankingRunId: run.rankingRunId,
      schemaVersion: run.schemaVersion,
      rankingPolicyId: run.rankingPolicyId,
      rankingPolicyVersion: run.rankingPolicyVersion,
      pair: run.pair,
      validationPlanId: run.validationPlanId,
      candidateCount: run.candidateCount,
      rankedCount: run.rankedCount,
      economicStatus: run.economicStatus,
      promotionEligible: run.promotionEligible,
      maxLifecycle: run.maxLifecycle,
      rankingRunSha256: '0'.repeat(64), // Conflicting hash
    });

    await expect(repository.persistRun(run)).rejects.toThrow(RankingError);
    try {
      await repository.persistRun(run);
      expect.unreachable('expected persistRun to throw');
    } catch (error) {
      expect((error as RankingError).code).toBe('RANKING_EVIDENCE_CONFLICT');
    }
  });

  it('collision re-read resolves ALREADY_IDENTICAL when competitor commits between findRun and insertRun', async () => {
    // Store that reports null on initial findRun to trigger insert race
    let firstFind = true;
    const run = await genuineRun();

    const store: RankingEvidenceStore = {
      findRun: (id: string) => {
        if (firstFind) {
          firstFind = false;
          return Promise.resolve(null);
        }
        return Promise.resolve({ rankingRunId: id, rankingRunSha256: run.rankingRunSha256 });
      },
      insertRun: () => {
        // Simulate concurrent competitor committed first
        return Promise.reject(new RankingEvidenceUniqueViolationError(`Unique constraint failed on rankingRunId: ${run.rankingRunId}`));
      },
    };

    const repository = new StrategyRankingRepository(store, testAuthority());
    const outcome = await repository.persistRun(run);
    expect(outcome).toEqual({ rankingRunId: run.rankingRunId, outcome: 'ALREADY_IDENTICAL' });
  });

  it('collision re-read throws RANKING_EVIDENCE_CONFLICT when competitor commits conflicting hash', async () => {
    let firstFind = true;
    const run = await genuineRun();

    const store: RankingEvidenceStore = {
      findRun: (id: string) => {
        if (firstFind) {
          firstFind = false;
          return Promise.resolve(null);
        }
        return Promise.resolve({ rankingRunId: id, rankingRunSha256: 'f'.repeat(64) });
      },
      insertRun: () => {
        return Promise.reject(new RankingEvidenceUniqueViolationError(`Unique constraint failed on rankingRunId: ${run.rankingRunId}`));
      },
    };

    const repository = new StrategyRankingRepository(store, testAuthority());
    await expect(repository.persistRun(run)).rejects.toThrow(RankingError);
    try {
      await repository.persistRun(run);
      expect.unreachable('expected persistRun to throw');
    } catch (error) {
      expect((error as RankingError).code).toBe('RANKING_EVIDENCE_CONFLICT');
    }
  });
});
