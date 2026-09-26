/**
 * Phase 18B Checkpoint B strict real-database acceptance runner.
 *
 * Ordinary `npm test` treats
 * `tests/integration/execution/live-practical-recovery.integration.test.ts`
 * as soft-skippable (the repository's live-DB integration convention). This
 * script sets `REQUIRE_LIVE_PRACTICAL_RECOVERY_DB_INTEGRATION=1`, under which
 * that suite's `beforeAll` throws, failing the run, if it cannot provision a
 * real, disposable MySQL shadow database.
 *
 * It places NO CoinDCX order and makes no network call: the venue and the
 * private stream are read-only fakes.
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  [
    require.resolve('vitest/vitest.mjs'),
    'run',
    'tests/integration/execution/live-practical-recovery.integration.test.ts',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, REQUIRE_LIVE_PRACTICAL_RECOVERY_DB_INTEGRATION: '1' },
  },
);

if (result.error) {
  console.error('[P18B-RECOVERY-DB] failed to launch vitest:', result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
