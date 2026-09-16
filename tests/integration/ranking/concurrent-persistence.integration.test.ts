import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStrategyRankingRepository } from '../../../src/ranking';
import { RankingError } from '../../../src/ranking/errors';
import { getGenuineRankingFixture, getGenuineRankingRunSet, runForPair } from '../../unit/ranking/helpers';

// Finding 3 — real MySQL/Prisma concurrency, over two INDEPENDENT connections
// (not two Promises racing inside one process, and not a mocked client).
// Mirrors the disposable shadow-database pattern already used by
// `tests/integration/execution/paper-production-runtime.test.ts`.
//
// ACCEPTANCE SEMANTICS: by default (plain `npm test`, or running this file
// directly with vitest) this suite soft-skips - console.warn + return early -
// when no local MySQL is reachable, exactly like the existing P14-I live-DB
// convention, so ordinary unit development never depends on a database being
// up. That means a plain `vitest run` of this file reports PASS whether or
// not it actually touched a database - which is exactly why a soft skip must
// never be trusted as acceptance evidence for Finding 3 on its own.
//
// For actual Phase15 acceptance, set REQUIRE_RANKING_DB_INTEGRATION=1 (or run
// `npm run test:integration:ranking`, which sets it for you). Under that
// flag, `beforeAll` THROWS - failing the whole suite - if it cannot reach a
// real, disposable MySQL database, instead of silently marking itself
// unavailable. It is therefore impossible for this flag to report a false
// green: either the real database race actually ran, or the run fails.

const STRICT = process.env['REQUIRE_RANKING_DB_INTEGRATION'] === '1';
const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = `p15_ranking_test_${randomBytes(6).toString('hex')}`;

function mysqlArgs(extra: readonly string[]): string[] {
  const url = new URL(BASE_DATABASE_URL!);
  const args = ['-h', url.hostname, '-P', url.port || '3306', '-u', decodeURIComponent(url.username)];
  if (url.password) args.push(`-p${decodeURIComponent(url.password)}`);
  return [...args, ...extra];
}
function shadowDatabaseUrl(): string {
  const url = new URL(BASE_DATABASE_URL!);
  url.pathname = `/${SHADOW_DB_NAME}`;
  return url.toString();
}

let dbAvailable = false;
let actuallyConnected = false;
/** Two INDEPENDENT PrismaClient instances/connections against the same shadow database. */
let prismaConnectionA: PrismaClient;
let prismaConnectionB: PrismaClient;

beforeAll(async () => {
  if (!BASE_DATABASE_URL) {
    if (STRICT) throw new Error('[P15-DB-INTEGRATION] REQUIRE_RANKING_DB_INTEGRATION=1 but no DATABASE_URL is configured - cannot run the strict real-database acceptance suite.');
    dbAvailable = false;
    return;
  }
  try {
    execFileSync('mysql', mysqlArgs(['-e', `CREATE DATABASE \`${SHADOW_DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      stdio: 'pipe', timeout: 60_000, shell: true, env: { ...process.env, DATABASE_URL: shadowDatabaseUrl() },
    });
    prismaConnectionA = new PrismaClient({ datasources: { db: { url: shadowDatabaseUrl() } } });
    prismaConnectionB = new PrismaClient({ datasources: { db: { url: shadowDatabaseUrl() } } });
    await prismaConnectionA.$queryRawUnsafe('SELECT 1');
    await prismaConnectionB.$queryRawUnsafe('SELECT 1');
    dbAvailable = true;
    console.log(`[P15-DB-INTEGRATION] connected to disposable shadow database "${SHADOW_DB_NAME}" via two independent PrismaClient connections`);
  } catch (error) {
    dbAvailable = false;
    if (STRICT) {
      throw new Error(
        `[P15-DB-INTEGRATION] REQUIRE_RANKING_DB_INTEGRATION=1 but could not provision/connect to a disposable MySQL shadow database - failing, not skipping. Underlying error: ${(error as Error).message}`,
      );
    }
  }
}, 90_000);

afterAll(async () => {
  if (!dbAvailable) return;
  await prismaConnectionA.$disconnect();
  await prismaConnectionB.$disconnect();
  try {
    execFileSync('mysql', mysqlArgs(['-e', `DROP DATABASE IF EXISTS \`${SHADOW_DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
  } catch { /* best-effort cleanup only */ }
}, 30_000);

/**
 * Returns true if the caller should skip (soft mode, DB unavailable). In
 * strict mode this can never be reached with `dbAvailable === false`, because
 * `beforeAll` already threw and failed the whole suite before any `it()` body
 * runs - this is a defense-in-depth check, not the primary enforcement.
 */
function skip(): boolean {
  if (dbAvailable) return false;
  if (STRICT) throw new Error('[P15-DB-INTEGRATION] strict mode reached a test body with no database connection - this should be unreachable (beforeAll should already have thrown).');
  console.warn('P15 ranking live-DB concurrency suite skipped: no reachable disposable MySQL environment (see beforeAll). Set REQUIRE_RANKING_DB_INTEGRATION=1 (or run `npm run test:integration:ranking`) to make this failure hard.');
  return true;
}

describe('Finding 3 — real MySQL concurrent ranking-evidence persistence', () => {
  it('two independent connections racing to persist the SAME genuine run/content: exactly one wins the real P2002 race, the other resolves ALREADY_IDENTICAL', async () => {
    if (skip()) return;
    actuallyConnected = true;

    const runSet = await getGenuineRankingRunSet();
    const run = runForPair(runSet, 'BTC-INR');

    expect(prismaConnectionA).not.toBe(prismaConnectionB);
    const repositoryOverConnectionA = createStrategyRankingRepository(prismaConnectionA);
    const repositoryOverConnectionB = createStrategyRankingRepository(prismaConnectionB);

    const [outcomeA, outcomeB] = await Promise.all([
      repositoryOverConnectionA.persistRun(run),
      repositoryOverConnectionB.persistRun(run),
    ]);

    const outcomes = [outcomeA.outcome, outcomeB.outcome].sort();
    expect(outcomes, 'exactly one INSERTED (won the real unique-key race) and one ALREADY_IDENTICAL (lost it, hit the real P2002 and recovered)').toEqual(['ALREADY_IDENTICAL', 'INSERTED']);

    const rows = await prismaConnectionA.rankingRun.findMany({ where: { rankingRunId: run.rankingRunId } });
    expect(rows, 'the real unique constraint prevented a duplicate row, not just application logic').toHaveLength(1);
    expect(rows[0]?.rankingRunSha256).toBe(run.rankingRunSha256);

    const resultRows = await prismaConnectionA.rankingResult.findMany({ where: { rankingRunId: run.rankingRunId } });
    expect(resultRows).toHaveLength(run.results.length);

    console.log('[P15-DB-INTEGRATION] executed real concurrent same-content race over two independent connections; outcomes =', outcomes);
  }, 60_000);

  it('conflicting content under the same logical identity: the real database is queried and the mismatch fails closed with RANKING_EVIDENCE_CONFLICT', async () => {
    if (skip()) return;
    actuallyConnected = true;

    const { planResult, candidates } = await getGenuineRankingFixture();
    const { rankStrategyCandidates } = await import('../../../src/ranking/engine');

    const runSetA = rankStrategyCandidates({ planResult, candidates });
    const runA = runForPair(runSetA, 'ETH-INR');

    const repository = createStrategyRankingRepository(prismaConnectionA);
    const firstOutcome = await repository.persistRun(runA);
    expect(firstOutcome.outcome).toBe('INSERTED');

    // Simulate a conflicting logical write (e.g. schema drift, a manual edit,
    // replay after a policy change) by corrupting the STORED row directly via
    // the independent connection B - bypassing the repository entirely so the
    // next persistRun call must detect the mismatch against the REAL stored
    // value, not an in-memory assumption.
    await prismaConnectionB.rankingRun.update({
      where: { rankingRunId: runA.rankingRunId },
      data: { rankingRunSha256: 'f'.repeat(64) },
    });

    await expect(repository.persistRun(runA)).rejects.toThrow(RankingError);
    try {
      await repository.persistRun(runA);
      expect.unreachable('expected persistRun to throw');
    } catch (error) {
      expect((error as RankingError).code).toBe('RANKING_EVIDENCE_CONFLICT');
    }

    console.log('[P15-DB-INTEGRATION] executed real conflicting-content-same-identity check; fails closed with RANKING_EVIDENCE_CONFLICT against the real stored row');
  }, 60_000);

  it('reports whether it actually connected and executed against real MySQL, or was skipped', () => {
    if (STRICT) {
      // Unreachable unless beforeAll already threw and failed the suite.
      expect(dbAvailable, 'strict mode guarantees a real connection by the time tests run').toBe(true);
      expect(actuallyConnected, 'strict mode must have actually executed the real-DB tests above, not skipped them').toBe(true);
    } else if (!dbAvailable) {
      console.warn('[P15-DB-INTEGRATION] this run did NOT execute against a real database (soft-skip mode, no MySQL reachable). Not acceptance evidence for Finding 3 - run `npm run test:integration:ranking` for that.');
    } else {
      expect(actuallyConnected, 'a database was available but no test above actually ran its real-DB assertions').toBe(true);
      console.log('[P15-DB-INTEGRATION] this run DID execute against a real, disposable MySQL database.');
    }
  });
});
