/**
 * Phase17 strict real-database acceptance runner.
 *
 * Ordinary `npm test` treats
 * `tests/integration/execution/live-execution-persistence.integration.test.ts`
 * as soft-skippable (matching the repository's existing live-DB integration
 * convention) so unit development never depends on a local MySQL being up.
 *
 * This script is the Phase17 ACCEPTANCE path: it sets
 * `REQUIRE_LIVE_EXECUTION_DB_INTEGRATION=1`, under which that suite's
 * `beforeAll` throws — failing the run — if it cannot provision a real,
 * disposable MySQL shadow database, instead of silently marking itself
 * unavailable. Use this command whenever a real pass/fail signal for the
 * Phase17 durable-idempotence proof is required.
 *
 * It places NO CoinDCX order: the suite it runs has no gateway, no transport,
 * and no network call of any kind.
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  [
    require.resolve('vitest/vitest.mjs'),
    'run',
    'tests/integration/execution/live-execution-persistence.integration.test.ts',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, REQUIRE_LIVE_EXECUTION_DB_INTEGRATION: '1' },
  },
);

if (result.error) {
  console.error('[P17-DB-INTEGRATION] failed to launch vitest:', result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
