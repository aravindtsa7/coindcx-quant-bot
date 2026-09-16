/**
 * Phase15 strict real-database acceptance runner.
 *
 * Ordinary `npm test` treats `tests/integration/ranking/concurrent-persistence.integration.test.ts`
 * as soft-skippable (matching the repository's existing live-DB integration
 * convention) so unit development never depends on a local MySQL being up.
 *
 * This script is the Phase15 ACCEPTANCE path: it sets
 * `REQUIRE_RANKING_DB_INTEGRATION=1`, under which that suite's `beforeAll`
 * throws (failing the run) if it cannot reach a real, disposable MySQL
 * database, instead of silently marking itself unavailable and returning
 * early from every test. Use this command, not plain `npm test`, whenever a
 * real pass/fail signal for the Finding 3 real-database concurrency proof is
 * required.
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  [
    require.resolve('vitest/vitest.mjs'),
    'run',
    'tests/integration/ranking/concurrent-persistence.integration.test.ts',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, REQUIRE_RANKING_DB_INTEGRATION: '1' },
  },
);

if (result.error) {
  console.error('[P15-DB-INTEGRATION] failed to launch vitest:', result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
