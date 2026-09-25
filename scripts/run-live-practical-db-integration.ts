/**
 * Phase 18B Stage 1B1 strict real-database acceptance runner.
 *
 * Ordinary `npm test` treats
 * `tests/integration/execution/live-practical-persistence.integration.test.ts`
 * as soft-skippable (the repository's live-DB integration convention), so unit
 * development never depends on a local MySQL being up.
 *
 * This script is the Stage 1B1 ACCEPTANCE path: it sets
 * `REQUIRE_LIVE_PRACTICAL_DB_INTEGRATION=1`, under which that suite's
 * `beforeAll` throws, failing the run, if it cannot provision a real,
 * disposable MySQL shadow database, instead of silently marking itself
 * unavailable.
 *
 * It places NO CoinDCX order and makes no network call: the suite exercises
 * durable persistence only.
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  [
    require.resolve('vitest/vitest.mjs'),
    'run',
    'tests/integration/execution/live-practical-persistence.integration.test.ts',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, REQUIRE_LIVE_PRACTICAL_DB_INTEGRATION: '1' },
  },
);

if (result.error) {
  console.error('[P18B-DB-INTEGRATION] failed to launch vitest:', result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
