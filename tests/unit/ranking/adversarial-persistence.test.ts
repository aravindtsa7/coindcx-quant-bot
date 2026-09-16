import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { composeRankingRunSet } from '../../../src/ranking/core';
import { RankingError } from '../../../src/ranking/errors';
import { computeRankingResultSha256, computeRankingRunSha256, type UnhashedRankingResult } from '../../../src/ranking/identity';
import * as rankingRepositoryModule from '../../../src/ranking/persistence/ranking-repository';
import * as rankingEngineModule from '../../../src/ranking/engine';
import * as rankingAuthorityModule from '../../../src/ranking/authority';
import {
  StrategyRankingRepository,
  type RankingEvidenceStore,
  type RankingResultRow,
  type RankingRunRow,
  type StoredRankingRunSummary,
} from '../../../src/ranking/persistence/ranking-repository';
import type { RankedStrategyRankingResult, StrategyRankingRun } from '../../../src/ranking/types';
import { buildEvidence, forgeSelfConsistentRunSet, getGenuineRankingFixture, getGenuineRankingRunSet, runForPair, testAuthority } from './helpers';

class SpyRankingStore implements RankingEvidenceStore {
  public findCalls = 0;
  public insertCalls = 0;
  public readonly runs = new Map<string, RankingRunRow>();
  public readonly results = new Map<string, RankingResultRow>();

  public findRun(rankingRunId: string): Promise<StoredRankingRunSummary | null> {
    this.findCalls += 1;
    const row = this.runs.get(rankingRunId);
    return Promise.resolve(row === undefined ? null : { rankingRunId: row.rankingRunId, rankingRunSha256: row.rankingRunSha256 });
  }

  public insertRun(run: RankingRunRow, results: readonly RankingResultRow[]): Promise<void> {
    this.insertCalls += 1;
    this.runs.set(run.rankingRunId, run);
    for (const r of results) {
      this.results.set(r.rankingResultSha256, r);
    }
    return Promise.resolve();
  }
}

async function genuineRun(): Promise<StrategyRankingRun> {
  const runSet = await getGenuineRankingRunSet();
  return runForPair(runSet, 'BTC-INR');
}

describe('Finding 1 — Adversarial Persistence Authority Hardening', () => {
  beforeAll(async () => {
    await getGenuineRankingFixture();
  }, 60_000);

  it('authority.ts exports NOTHING callable except the isolated-channel factory (checked dynamically, not by a guessed name list)', () => {
    const authExports = rankingAuthorityModule as unknown as Record<string, unknown>;

    // Every discovery mechanism the review was asked to try, all at once:
    const viaKeys = Object.keys(authExports);
    const viaGetOwnPropertyNames = Object.getOwnPropertyNames(authExports).filter((name) => name !== '__esModule');
    const viaReflectOwnKeys = Reflect.ownKeys(authExports).filter((name) => name !== '__esModule');

    for (const surface of [viaKeys, viaGetOwnPropertyNames, viaReflectOwnKeys]) {
      const callableNames = surface.filter((name) => typeof authExports[name as string] === 'function');
      expect(callableNames).toEqual(['createRankingAuthorityChannel']);
    }

    // The one callable export is a pure factory: calling it must not require
    // (and must not have any way to reach) any pre-existing shared state, and
    // its return value must not itself leak a second callable surface beyond
    // the two verifiers and the attest function - there is no third,
    // hidden export-of-an-export to discover either.
    const channel = rankingAuthorityModule.createRankingAuthorityChannel();
    const channelKeys = Reflect.ownKeys(channel).sort();
    expect(channelKeys).toEqual(['attestRankingRunSet', 'isAuthoritativeRankingRun', 'isAuthoritativeRankingRunSet']);
  });

  it('REGRESSION (exact prior exploit): deep-importing authority.ts and minting a forged run set no longer influences the trusted repository', async () => {
    // This reproduces, verbatim, the exploit previously proven against
    // `recordAuthoritativeRankingRunSet`: deep-import the authority module,
    // call whatever mint/attest capability it exposes with a self-forged,
    // self-frozen, self-hashed run set, and see whether that forged evidence
    // becomes acceptable to a properly-constructed, engine-bound repository.
    const attackerChannel = rankingAuthorityModule.createRankingAuthorityChannel();
    const { run: forgedRun, runSet: forgedRunSet } = forgeSelfConsistentRunSet('exploit-regression-run');

    expect(attackerChannel.isAuthoritativeRankingRun(forgedRun)).toBe(false);
    expect(attackerChannel.isAuthoritativeRankingRunSet(forgedRunSet)).toBe(false);

    // The attacker CAN mint into their OWN channel - that is expected and
    // harmless, because their channel is disjoint from every other channel.
    attackerChannel.attestRankingRunSet(forgedRunSet);
    expect(attackerChannel.isAuthoritativeRankingRun(forgedRun)).toBe(true);
    expect(attackerChannel.isAuthoritativeRankingRunSet(forgedRunSet)).toBe(true);

    // But the REAL engine's exported verifiers - the ones the trusted
    // repository is actually wired to - must NOT be affected by the
    // attacker's own channel in any way.
    expect(rankingEngineModule.isAuthoritativeRankingRun(forgedRun)).toBe(false);
    expect(rankingEngineModule.isAuthoritativeRankingRunSet(forgedRunSet)).toBe(false);

    // And the trusted repository, constructed with the REAL engine
    // authority (exactly as production composition does), must reject it -
    // this is the exact call sequence ("deep import -> mint -> persistRun")
    // that previously returned `{ outcome: 'INSERTED' }`.
    const store = new SpyRankingStore();
    const repository = new StrategyRankingRepository(store, testAuthority());
    await expect(repository.persistRun(forgedRun)).rejects.toThrow(/RANKING_EVIDENCE_NOT_AUTHORITATIVE/);
    expect(store.insertCalls, 'zero DB writes - the original exploit used to reach INSERTED here').toBe(0);
  });

  it('two independently-created authority channels are fully isolated from each other', () => {
    const channelA = rankingAuthorityModule.createRankingAuthorityChannel();
    const channelB = rankingAuthorityModule.createRankingAuthorityChannel();
    const { run, runSet } = forgeSelfConsistentRunSet('isolation-check-run');

    channelA.attestRankingRunSet(runSet);
    expect(channelA.isAuthoritativeRankingRun(run)).toBe(true);
    expect(channelA.isAuthoritativeRankingRunSet(runSet)).toBe(true);

    // Channel B never saw that attestation - it must know nothing about it.
    expect(channelB.isAuthoritativeRankingRun(run)).toBe(false);
    expect(channelB.isAuthoritativeRankingRunSet(runSet)).toBe(false);
  });

  it('re-importing authority.ts (module cache reset) yields a fresh, unrelated factory - possession of a channel is never reacquired for free', async () => {
    vi.resetModules();
    const isolatedAuth = await import('../../../src/ranking/authority');
    const { run, runSet } = forgeSelfConsistentRunSet('reimport-check-run');

    const isolatedChannel = isolatedAuth.createRankingAuthorityChannel();
    isolatedChannel.attestRankingRunSet(runSet);
    expect(isolatedChannel.isAuthoritativeRankingRun(run)).toBe(true);

    // The engine's already-loaded, already-used real authority (captured
    // earlier in this file, before the module registry was reset) still
    // knows nothing about this run - proving a fresh import created a new,
    // disconnected sandbox rather than reacquiring any existing channel.
    expect(rankingEngineModule.isAuthoritativeRankingRun(run)).toBe(false);
  });

  it('no deep-imported or exported mutator exists in engine or repository beyond the two safe read-only verifiers', () => {
    const engineExports = rankingEngineModule as unknown as Record<string, unknown>;
    const repoExports = rankingRepositoryModule as unknown as Record<string, unknown>;

    const engineCallables = Object.getOwnPropertyNames(engineExports).filter((name) => typeof engineExports[name] === 'function');
    expect(engineCallables.sort()).toEqual(['isAuthoritativeRankingRun', 'isAuthoritativeRankingRunSet', 'rankStrategyCandidates'].sort());

    // The repository module never imports authority.ts or engine.ts at all,
    // so it cannot export (deliberately or accidentally) anything that
    // mutates ranking-authority state.
    const repoCallableNames = Object.getOwnPropertyNames(repoExports).filter((name) => typeof repoExports[name] === 'function');
    expect(repoCallableNames).not.toContain('isAuthoritativeRankingRun');
    expect(repoCallableNames).not.toContain('isAuthoritativeRankingRunSet');
    expect(repoCallableNames).not.toContain('recordAuthoritativeRankingRunSet');
  });

  it('the compiled CommonJS build (when present) exposes no authority.ts export beyond the factory', () => {
    const distAuthorityPath = path.resolve(__dirname, '../../../dist/ranking/authority.js');
    if (!existsSync(distAuthorityPath)) {
      // `npm run build` was not run before this suite - documented gap, not a
      // false pass: the source-level test above already proves the same
      // property against the TypeScript sources.
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const compiled = require(distAuthorityPath) as Record<string, unknown>;
    const callableNames = Reflect.ownKeys(compiled)
      .filter((name) => name !== '__esModule')
      .filter((name) => typeof compiled[name as string] === 'function');
    expect(callableNames).toEqual(['createRankingAuthorityChannel']);
  });

  it('repository-first import cannot seize authority or persist a forged run', async () => {
    // StrategyRankingRepository imported and instantiated without calling engine first
    const freshStore = new SpyRankingStore();
    const freshRepo = new StrategyRankingRepository(freshStore, testAuthority());

    const forgedRun = {
      rankingRunId: 'forged-run-1234',
      schemaVersion: 1,
      rankingPolicyId: '6302da3838ac630c0c1fa73d6ad54de0b7d2107485a7aa145620a4eb8490be82',
      rankingPolicyVersion: 'P15_RANKING_V1',
      pair: 'BTC-INR',
      validationPlanId: '0'.repeat(64),
      candidateCount: 0,
      rankedCount: 0,
      economicStatus: 'FUNDING_EXCLUDED',
      promotionEligible: false,
      maxLifecycle: 'PAPER',
      rankingRunSha256: '0'.repeat(64),
      results: [],
    } as unknown as StrategyRankingRun;

    await expect(freshRepo.persistRun(forgedRun)).rejects.toThrow(RankingError);
    try {
      await freshRepo.persistRun(forgedRun);
      expect.unreachable('expected persistRun to throw');
    } catch (error) {
      expect((error as RankingError).code).toBe('RANKING_EVIDENCE_NOT_AUTHORITATIVE');
    }
    expect(freshStore.insertCalls).toBe(0);
    expect(freshStore.findCalls).toBe(0);
  });

  it('spread copy of a genuine run fails authority (new object identity)', async () => {
    const store = new SpyRankingStore();
    const repository = new StrategyRankingRepository(store, testAuthority());
    const run = await genuineRun();
    const spreadCopy = { ...run } as StrategyRankingRun;

    await expect(repository.persistRun(spreadCopy)).rejects.toThrow(/RANKING_EVIDENCE_NOT_AUTHORITATIVE/);
    expect(store.insertCalls).toBe(0);
  });

  it('Object.create(genuineRun) fails authority (prototype chain is not reference identity)', async () => {
    const store = new SpyRankingStore();
    const repository = new StrategyRankingRepository(store, testAuthority());
    const run = await genuineRun();
    const derived = Object.create(run) as StrategyRankingRun;

    await expect(repository.persistRun(derived)).rejects.toThrow(/RANKING_EVIDENCE_NOT_AUTHORITATIVE/);
    expect(store.insertCalls).toBe(0);
  });

  it('a Proxy wrapping a genuine run fails authority (a Proxy is a distinct object identity from its target)', async () => {
    const store = new SpyRankingStore();
    const repository = new StrategyRankingRepository(store, testAuthority());
    const run = await genuineRun();
    const proxied = new Proxy(run, {}) as StrategyRankingRun;

    await expect(repository.persistRun(proxied)).rejects.toThrow(/RANKING_EVIDENCE_NOT_AUTHORITATIVE/);
    expect(store.insertCalls).toBe(0);
  });

  it('legitimate engine output succeeds through the trusted repository', async () => {
    const store = new SpyRankingStore();
    const repository = new StrategyRankingRepository(store, testAuthority());
    const run = await genuineRun();

    const result = await repository.persistRun(run);
    expect(result.outcome).toBe('INSERTED');
    expect(store.insertCalls).toBe(1);
  });

  it('pre-engine isolated import of authority surface yields NO callable mint/register capability', async () => {
    vi.resetModules();
    // In this fresh module context, authority is imported BEFORE engine
    const isolatedAuth = await import('../../../src/ranking/authority');
    const authExports = isolatedAuth as unknown as Record<string, unknown>;

    // Prove that no callable mint/register/mark capability exists anywhere on
    // the surface - checked structurally (every exported callable, whatever
    // it is named), not against a guessed name list.
    const callableExportNames = Object.keys(authExports).filter((name) => typeof authExports[name] === 'function');
    expect(callableExportNames).toEqual(['createRankingAuthorityChannel']);

    // Calling the one exported factory returns an isolated sandbox: its
    // read-only predicates return false for any forged run/runSet, and using
    // it has no bearing on any other channel.
    const { run: forgedRun, runSet: forgedRunSet } = forgeSelfConsistentRunSet('pre-engine-forged-run');
    const isolatedChannel = isolatedAuth.createRankingAuthorityChannel();
    expect(isolatedChannel.isAuthoritativeRankingRun(forgedRun)).toBe(false);
    expect(isolatedChannel.isAuthoritativeRankingRunSet(forgedRunSet)).toBe(false);

    // Now import the repository and verify the forged run cannot be
    // persisted through a repository built with THIS isolated channel either
    // (it was never attested into it).
    const { StrategyRankingRepository: IsolatedRepo } = await import('../../../src/ranking/persistence/ranking-repository');

    const store = new SpyRankingStore();
    const repo = new IsolatedRepo(store, isolatedChannel);

    await expect(repo.persistRun(forgedRun)).rejects.toThrow(/RANKING_EVIDENCE_NOT_AUTHORITATIVE/);
    expect(store.insertCalls).toBe(0);
    expect(store.findCalls).toBe(0);
  });

  it('rejects a forged structural run (built without engine authority) with zero DB writes', async () => {
    const store = new SpyRankingStore();
    const repository = new StrategyRankingRepository(store, testAuthority());

    const rawEvidences = [
      buildEvidence({ pair: 'BTC-INR', strategyId: 'EMA_TREND', metrics: { SHARPE: '3', MAX_DRAWDOWN: '5' } }),
      buildEvidence({ pair: 'BTC-INR', strategyId: 'ATR_BREAKOUT', metrics: { SHARPE: '1', MAX_DRAWDOWN: '20' } }),
    ];
    const forgedRun = runForPair(composeRankingRunSet(rawEvidences, []), 'BTC-INR');

    await expect(repository.persistRun(forgedRun)).rejects.toThrow(RankingError);
    try {
      await repository.persistRun(forgedRun);
      expect.unreachable('expected persistRun to throw');
    } catch (error) {
      expect((error as RankingError).code).toBe('RANKING_EVIDENCE_NOT_AUTHORITATIVE');
    }
    expect(store.insertCalls, 'zero DB writes').toBe(0);
    expect(store.findCalls, 'zero DB reads before authority check').toBe(0);
  });

  it('rejects a forged run with correctly recomputed self-consistent hashes with zero DB writes', async () => {
    const store = new SpyRankingStore();
    const repository = new StrategyRankingRepository(store, testAuthority());

    const base = await genuineRun();
    const clonedResults = base.results.map((res) => {
      const { rankingResultSha256: _rankingResultSha256, ...unhashed } = res;
      return {
        ...unhashed,
        rankingResultSha256: computeRankingResultSha256(unhashed as UnhashedRankingResult),
      };
    });
    const unhashedRun = {
      ...base,
      results: clonedResults,
    };
    delete (unhashedRun as { rankingRunSha256?: string }).rankingRunSha256;
    const selfConsistentForgedRun = {
      ...unhashedRun,
      rankingRunSha256: computeRankingRunSha256(unhashedRun),
    } as StrategyRankingRun;

    await expect(repository.persistRun(selfConsistentForgedRun)).rejects.toThrow(RankingError);
    try {
      await repository.persistRun(selfConsistentForgedRun);
      expect.unreachable('expected persistRun to throw');
    } catch (error) {
      expect((error as RankingError).code).toBe('RANKING_EVIDENCE_NOT_AUTHORITATIVE');
    }
    expect(store.insertCalls, 'zero DB writes').toBe(0);
    expect(store.findCalls, 'zero DB reads').toBe(0);
  });

  it('rejects forged result score/rank with zero DB writes', async () => {
    const store = new SpyRankingStore();
    const repository = new StrategyRankingRepository(store, testAuthority());
    const run = await genuineRun();

    const tamperedResults = run.results.map((r, i) => {
      if (i === 0 && r.status === 'RANKED') {
        return {
          ...r,
          compositeScore: '999999.000000000000000000',
          rank: 1,
        } as RankedStrategyRankingResult;
      }
      return r;
    });
    const tamperedRun = {
      ...run,
      results: tamperedResults,
    } as StrategyRankingRun;

    await expect(repository.persistRun(tamperedRun)).rejects.toThrow(RankingError);
    try {
      await repository.persistRun(tamperedRun);
      expect.unreachable('expected persistRun to throw');
    } catch (error) {
      expect((error as RankingError).code).toBe('RANKING_EVIDENCE_NOT_AUTHORITATIVE');
    }
    expect(store.insertCalls, 'zero DB writes').toBe(0);
    expect(store.findCalls, 'zero DB reads').toBe(0);
  });

  it('rejects forged Phase 12 validationPlanId or subject IDs with zero DB writes', async () => {
    const store = new SpyRankingStore();
    const repository = new StrategyRankingRepository(store, testAuthority());
    const run = await genuineRun();

    const tamperedResults = run.results.map((r, i) => {
      if (i === 0) {
        return {
          ...r,
          validationPlanId: '0'.repeat(64),
        };
      }
      return r;
    });
    const tamperedRun = {
      ...run,
      results: tamperedResults,
    } as StrategyRankingRun;

    await expect(repository.persistRun(tamperedRun)).rejects.toThrow(RankingError);
    try {
      await repository.persistRun(tamperedRun);
      expect.unreachable('expected persistRun to throw');
    } catch (error) {
      expect((error as RankingError).code).toBe('RANKING_EVIDENCE_NOT_AUTHORITATIVE');
    }
    expect(store.insertCalls, 'zero DB writes').toBe(0);
    expect(store.findCalls, 'zero DB reads').toBe(0);
  });

  it('rejects weakened result-level promotionEligible (true) with zero DB writes', async () => {
    const store = new SpyRankingStore();
    const repository = new StrategyRankingRepository(store, testAuthority());
    const run = await genuineRun();

    const tamperedResults = run.results.map((r, i) => {
      if (i === 0) {
        return {
          ...r,
          promotionEligible: true,
        };
      }
      return r;
    });
    const tamperedRun = {
      ...run,
      results: tamperedResults,
    } as unknown as StrategyRankingRun;

    await expect(repository.persistRun(tamperedRun)).rejects.toThrow(RankingError);
    try {
      await repository.persistRun(tamperedRun);
      expect.unreachable('expected persistRun to throw');
    } catch (error) {
      expect((error as RankingError).code).toBe('RANKING_EVIDENCE_NOT_AUTHORITATIVE');
    }
    expect(store.insertCalls, 'zero DB writes').toBe(0);
    expect(store.findCalls, 'zero DB reads').toBe(0);
  });

  it('rejects weakened result-level economicStatus or maxLifecycle with zero DB writes', async () => {
    const store = new SpyRankingStore();
    const repository = new StrategyRankingRepository(store, testAuthority());
    const run = await genuineRun();

    for (const weakenedField of [
      { economicStatus: 'FUNDING_INCLUDED' },
      { maxLifecycle: 'LIVE_CANDIDATE' },
    ]) {
      const tamperedResults = run.results.map((r, i) => {
        if (i === 0) {
          return {
            ...r,
            ...weakenedField,
          };
        }
        return r;
      });
      const tamperedRun = {
        ...run,
        results: tamperedResults,
      } as unknown as StrategyRankingRun;

      await expect(repository.persistRun(tamperedRun)).rejects.toThrow(RankingError);
      try {
        await repository.persistRun(tamperedRun);
        expect.unreachable('expected persistRun to throw');
      } catch (error) {
        expect((error as RankingError).code).toBe('RANKING_EVIDENCE_NOT_AUTHORITATIVE');
      }
      expect(store.insertCalls, 'zero DB writes').toBe(0);
    }
  });

  it('rejects mismatched rankingRunId / result run id with zero DB writes', async () => {
    const store = new SpyRankingStore();
    const repository = new StrategyRankingRepository(store, testAuthority());
    const run = await genuineRun();

    const tamperedResults = run.results.map((r, i) => {
      if (i === 0) {
        return {
          ...r,
          rankingRunId: 'mismatched-run-id-12345',
        };
      }
      return r;
    });
    const tamperedRun = {
      ...run,
      results: tamperedResults,
    } as StrategyRankingRun;

    await expect(repository.persistRun(tamperedRun)).rejects.toThrow(RankingError);
    try {
      await repository.persistRun(tamperedRun);
      expect.unreachable('expected persistRun to throw');
    } catch (error) {
      expect((error as RankingError).code).toBe('RANKING_EVIDENCE_NOT_AUTHORITATIVE');
    }
    expect(store.insertCalls, 'zero DB writes').toBe(0);
    expect(store.findCalls, 'zero DB reads').toBe(0);
  });

  it('rejects tampered rankingResultSha256 with zero DB writes', async () => {
    const store = new SpyRankingStore();
    const repository = new StrategyRankingRepository(store, testAuthority());
    const run = await genuineRun();

    const tamperedResults = run.results.map((r, i) => {
      if (i === 0) {
        return {
          ...r,
          rankingResultSha256: '9'.repeat(64),
        };
      }
      return r;
    });
    const tamperedRun = {
      ...run,
      results: tamperedResults,
    } as StrategyRankingRun;

    await expect(repository.persistRun(tamperedRun)).rejects.toThrow(RankingError);
    try {
      await repository.persistRun(tamperedRun);
      expect.unreachable('expected persistRun to throw');
    } catch (error) {
      expect((error as RankingError).code).toBe('RANKING_EVIDENCE_NOT_AUTHORITATIVE');
    }
    expect(store.insertCalls, 'zero DB writes').toBe(0);
    expect(store.findCalls, 'zero DB reads').toBe(0);
  });

  it('rejects tampered rankingRunSha256 with zero DB writes', async () => {
    const store = new SpyRankingStore();
    const repository = new StrategyRankingRepository(store, testAuthority());
    const run = await genuineRun();

    const tamperedRun = {
      ...run,
      rankingRunSha256: 'a'.repeat(64),
    } as StrategyRankingRun;

    await expect(repository.persistRun(tamperedRun)).rejects.toThrow(RankingError);
    try {
      await repository.persistRun(tamperedRun);
      expect.unreachable('expected persistRun to throw');
    } catch (error) {
      expect((error as RankingError).code).toBe('RANKING_EVIDENCE_NOT_AUTHORITATIVE');
    }
    expect(store.insertCalls, 'zero DB writes').toBe(0);
    expect(store.findCalls, 'zero DB reads').toBe(0);
  });

  it('rejects mismatched candidateCount or rankedCount with zero DB writes', async () => {
    const store = new SpyRankingStore();
    const repository = new StrategyRankingRepository(store, testAuthority());
    const run = await genuineRun();

    const mismatchedCandidateCount = { ...run, candidateCount: run.candidateCount + 1 } as StrategyRankingRun;
    await expect(repository.persistRun(mismatchedCandidateCount)).rejects.toThrow(RankingError);
    try {
      await repository.persistRun(mismatchedCandidateCount);
      expect.unreachable('expected persistRun to throw');
    } catch (error) {
      expect((error as RankingError).code).toBe('RANKING_EVIDENCE_NOT_AUTHORITATIVE');
    }

    const mismatchedRankedCount = { ...run, rankedCount: run.rankedCount + 1 } as StrategyRankingRun;
    await expect(repository.persistRun(mismatchedRankedCount)).rejects.toThrow(RankingError);
    try {
      await repository.persistRun(mismatchedRankedCount);
      expect.unreachable('expected persistRun to throw');
    } catch (error) {
      expect((error as RankingError).code).toBe('RANKING_EVIDENCE_NOT_AUTHORITATIVE');
    }

    expect(store.insertCalls, 'zero DB writes').toBe(0);
  });
});
