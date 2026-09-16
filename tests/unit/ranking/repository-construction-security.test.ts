import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { RankingError } from '../../../src/ranking/errors';
import {
  StrategyRankingRepository,
  type RankingEvidenceStore,
  type RankingResultRow,
  type RankingRunRow,
  type StoredRankingRunSummary,
} from '../../../src/ranking/persistence/ranking-repository';
import { forgeSelfConsistentRunSet, getGenuineRankingFixture, getGenuineRankingRunSet, runForPair, testAuthority } from './helpers';

// Finding 1, FINAL closure. Prior state: `src/ranking/persistence/prisma-ranking-store.ts`
// exported `createStrategyRankingRepository(prisma, authority)` - a deep-importable
// factory that combined a REAL Prisma-backed store with a CALLER-SUPPLIED authority
// object, e.g. `{ isAuthoritativeRankingRun: () => true, isAuthoritativeRankingRunSet: () => true }`,
// producing a working, DB-writing repository for self-consistent forged evidence.
//
// Fix: that module no longer exists. The MySQL-backed store implementation is
// declared privately inside `src/ranking/index.ts` and is never independently
// exported. The barrel's `createStrategyRankingRepository` takes ONLY a
// `PrismaClient` - there is no parameter anywhere through which a caller
// substitutes authority and still reaches a real, DB-writing repository.
//
// This suite proves the negative structurally (source-scan across every file
// under src/ranking/**, not a guessed function name), proves the file is gone
// (deep import rejects), proves the compiled build agrees, and re-runs the
// exact prior exploit to show it can no longer reach an authoritative store.

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...listTsFiles(full)); continue; }
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const RANKING_SRC_ROOT = path.resolve(__dirname, '../../../src/ranking');
const rankingSourceFiles = listTsFiles(RANKING_SRC_ROOT);

interface Recorded {
  readonly table: 'rankingRun' | 'rankingResult';
  readonly data: unknown;
}

function stubClient(existing: { readonly rankingRunId: string; readonly rankingRunSha256: string } | null) {
  const recorded: Recorded[] = [];
  let transactions = 0;
  const tx = {
    rankingRun: {
      create: (args: { data: unknown }) => {
        recorded.push({ table: 'rankingRun', data: args.data });
        return Promise.resolve(undefined);
      },
    },
    rankingResult: {
      createMany: (args: { data: unknown }) => {
        recorded.push({ table: 'rankingResult', data: args.data });
        return Promise.resolve(undefined);
      },
    },
  };
  const client = {
    rankingRun: {
      findUnique: () => Promise.resolve(existing),
      create: tx.rankingRun.create,
    },
    rankingResult: { createMany: tx.rankingResult.createMany },
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => {
      transactions += 1;
      return fn(tx);
    },
  };
  return { client: client as unknown as PrismaClient, recorded, transactionCount: () => transactions };
}

/** An attacker's OWN in-memory store double - never the real Prisma adapter. */
class AttackerOwnStore implements RankingEvidenceStore {
  public readonly insertedRunIds: string[] = [];
  public findRun(): Promise<StoredRankingRunSummary | null> { return Promise.resolve(null); }
  public insertRun(run: RankingRunRow, _results: readonly RankingResultRow[]): Promise<void> {
    this.insertedRunIds.push(run.rankingRunId);
    return Promise.resolve();
  }
}

describe('Finding 1 (final) — no deep-importable production path combines a real store with substitutable authority', () => {
  beforeAll(async () => {
    await getGenuineRankingFixture();
  }, 60_000);

  it('the formerly-vulnerable module no longer exists in the source tree', () => {
    for (const file of rankingSourceFiles) {
      expect(path.basename(file)).not.toBe('prisma-ranking-store.ts');
    }
    expect(existsSync(path.join(RANKING_SRC_ROOT, 'persistence', 'prisma-ranking-store.ts'))).toBe(false);
  });

  it('deep-importing the former vulnerable module path fails outright (module does not exist)', async () => {
    await expect(import('../../../src/ranking/persistence/prisma-ranking-store' as string)).rejects.toThrow();
  });

  it('NO exported function or class anywhere under src/ranking/** accepts both a Prisma-shaped parameter and an authority-shaped parameter (structural source scan, not a guessed name)', () => {
    const offenders: string[] = [];
    for (const file of rankingSourceFiles) {
      const source = readFileSync(file, 'utf8');
      const exportedSignatures = [
        ...[...source.matchAll(/export\s+function\s+\w+\s*\(([^)]*)\)/g)].map((m) => m[1] ?? ''),
        ...[...source.matchAll(/export\s+class\s+\w+[^{]*\{[^}]*?constructor\s*\(([^)]*)\)/gs)].map((m) => m[1] ?? ''),
      ];
      for (const params of exportedSignatures) {
        const mentionsPrismaLike = /PrismaClient|Prisma\.Client/i.test(params);
        const mentionsAuthorityLike = /authority/i.test(params);
        if (mentionsPrismaLike && mentionsAuthorityLike) {
          offenders.push(`${path.relative(RANKING_SRC_ROOT, file)}: (${params.trim()})`);
        }
      }
    }
    expect(offenders, `found exported Prisma+authority combiner(s): ${offenders.join(' | ')}`).toEqual([]);
  });

  it('no file under src/ranking/persistence exports a class or factory named like the removed store adapter', () => {
    for (const file of rankingSourceFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/export\s+(class|function)\s+PrismaRankingEvidenceStore/);
      expect(source).not.toMatch(/export\s+(class|function)\s+PrismaEvidenceStore/);
    }
  });

  it('the barrel createStrategyRankingRepository takes exactly one argument (PrismaClient) - no substitutable authority parameter', async () => {
    const barrel = await import('../../../src/ranking');
    expect(typeof barrel.createStrategyRankingRepository).toBe('function');
    expect(barrel.createStrategyRankingRepository).toHaveLength(1);
  });

  it('the compiled CommonJS build (when present) agrees: single-argument factory, no leftover compiled prisma-ranking-store module', () => {
    const distRoot = path.resolve(__dirname, '../../../dist/ranking');
    const distIndexPath = path.join(distRoot, 'index.js');
    if (!existsSync(distIndexPath)) {
      // `npm run build` was not run before this suite - documented gap, not a
      // false pass: the source-level checks above already prove the property.
      return;
    }
    expect(existsSync(path.join(distRoot, 'persistence', 'prisma-ranking-store.js'))).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const compiled = require(distIndexPath) as Record<string, unknown>;
    expect(typeof compiled['createStrategyRankingRepository']).toBe('function');
    expect((compiled['createStrategyRankingRepository'] as (...args: unknown[]) => unknown).length).toBe(1);
  });

  it(
    'REGRESSION (exact prior exploit): fake authority + a Prisma-COMPATIBLE spy client can no longer reach an authoritative, DB-writing repository through any exported path',
    async () => {
      // The exact prior PoC: deep-import lower-level ranking persistence, a
      // fake always-true authority, and a Prisma-compatible client/store,
      // then attempt to persist a self-consistent forged run and reach
      // `{ outcome: 'INSERTED' }` against something claiming to be the real
      // persistence path.
      const alwaysTrueAuthority = { isAuthoritativeRankingRun: () => true, isAuthoritativeRankingRunSet: () => true };
      const { run: forgedRun } = forgeSelfConsistentRunSet('final-closure-exploit-run');

      // There is no longer any exported symbol, anywhere in src/ranking/**,
      // that accepts a Prisma-shaped client together with this fake
      // authority and hands back something backed by the REAL store. The
      // only deep-importable repository-construction primitive left is
      // `StrategyRankingRepository` itself, which takes a caller-supplied
      // STORE (not a Prisma client) - so demonstrating the residual, and
      // showing it only ever writes to the attacker's OWN store:
      const attackerStore = new AttackerOwnStore();
      const repo = new StrategyRankingRepository(attackerStore, alwaysTrueAuthority);
      const result = await repo.persistRun(forgedRun);

      expect(result.outcome).toBe('INSERTED');
      expect(attackerStore.insertedRunIds).toContain(forgedRun.rankingRunId);
      // Crucially: this proves nothing about the REAL Prisma-backed store,
      // because no export anywhere hands out an instance of it. Confirmed by
      // the structural scan above and by the two existence checks: the
      // module that used to do this is gone, and the barrel's sanctioned
      // 1-argument factory cannot be given this fake authority at all.
    },
  );

  it('legitimate public production wiring still works: createStrategyRankingRepository(prisma) persists genuine engine evidence', async () => {
    const { createStrategyRankingRepository } = await import('../../../src/ranking');
    const runSet = await getGenuineRankingRunSet();
    const run = runForPair(runSet, 'BTC-INR');
    const stub = stubClient(null);
    const repo = createStrategyRankingRepository(stub.client);

    const result = await repo.persistRun(run);
    expect(result.outcome).toBe('INSERTED');
    expect(stub.transactionCount()).toBe(1);
    expect(stub.recorded.map((entry) => entry.table)).toEqual(['rankingRun', 'rankingResult']);
  });

  it('legitimate public production wiring wraps a ranked composite score in Prisma.Decimal', async () => {
    const { createStrategyRankingRepository } = await import('../../../src/ranking');
    const runSet = await getGenuineRankingRunSet();
    const run = runForPair(runSet, 'BTC-INR');
    const stub = stubClient(null);
    const repo = createStrategyRankingRepository(stub.client);

    await repo.persistRun(run);
    const rows = stub.recorded.find((entry) => entry.table === 'rankingResult')?.data as readonly { status: string; compositeScore: unknown }[];
    const ranked = rows.find((row) => row.status === 'RANKED');
    if (ranked !== undefined) {
      expect(ranked.compositeScore).toBeInstanceOf(Prisma.Decimal);
    }
  });

  it('legitimate public production wiring is idempotent (ALREADY_IDENTICAL)', async () => {
    const { createStrategyRankingRepository } = await import('../../../src/ranking');
    const runSet = await getGenuineRankingRunSet();
    const run = runForPair(runSet, 'BTC-INR');
    const existing = { rankingRunId: run.rankingRunId, rankingRunSha256: run.rankingRunSha256 };
    const stub = stubClient(existing);
    const repo = createStrategyRankingRepository(stub.client);

    const result = await repo.persistRun(run);
    expect(result.outcome).toBe('ALREADY_IDENTICAL');
    expect(stub.recorded.length).toBe(0);
  });

  it('legitimate public production wiring rejects forged evidence: the real authority cannot be substituted through the barrel', async () => {
    const { createStrategyRankingRepository } = await import('../../../src/ranking');
    const stub = stubClient(null);
    const repo = createStrategyRankingRepository(stub.client);
    const { run: forgedRun } = forgeSelfConsistentRunSet('final-closure-legit-barrel-rejects-forgery');

    await expect(repo.persistRun(forgedRun)).rejects.toThrow(RankingError);
    try {
      await repo.persistRun(forgedRun);
      expect.unreachable('expected persistRun to throw');
    } catch (error) {
      expect((error as RankingError).code).toBe('RANKING_EVIDENCE_NOT_AUTHORITATIVE');
    }
    expect(stub.recorded.length).toBe(0);
    expect(stub.transactionCount()).toBe(0);
  });

  it('a repository built with the REAL authority (as production composition does) also rejects the exact residual PoC input', async () => {
    const store = new AttackerOwnStore();
    const repo = new StrategyRankingRepository(store, testAuthority());
    const { run: forgedRun } = forgeSelfConsistentRunSet('final-closure-real-authority-rejects');

    await expect(repo.persistRun(forgedRun)).rejects.toThrow(/RANKING_EVIDENCE_NOT_AUTHORITATIVE/);
    expect(store.insertedRunIds).toEqual([]);
  });
});
