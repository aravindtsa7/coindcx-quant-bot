/**
 * Phase18 strict real-database acceptance runner.
 *
 * Ordinary `npm test` treats
 * `tests/integration/execution/live-reconciliation-persistence.integration.test.ts`
 * as soft-skippable (matching the repository's existing live-DB integration
 * convention) so unit development never depends on a local MySQL being up.
 *
 * This script is the Phase18 ACCEPTANCE path: it sets
 * `REQUIRE_LIVE_RECONCILIATION_DB_INTEGRATION=1`, under which that suite's
 * `beforeAll` throws — failing the run — if it cannot provision a real,
 * disposable MySQL shadow database, instead of silently marking itself
 * unavailable. Use this command whenever a real pass/fail signal for the
 * Phase18 fencing, idempotence, and crash-recovery proofs is required.
 *
 * It places NO CoinDCX order and makes no network call: the suite it runs uses
 * a fixture evidence provider and an orphan-cancellation fake that records
 * attempts instead of performing them.
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  [
    require.resolve('vitest/vitest.mjs'),
    'run',
    'tests/integration/execution/live-reconciliation-persistence.integration.test.ts',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, REQUIRE_LIVE_RECONCILIATION_DB_INTEGRATION: '1' },
  },
);

if (result.error) {
  console.error('[P18-DB-INTEGRATION] failed to launch vitest:', result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
