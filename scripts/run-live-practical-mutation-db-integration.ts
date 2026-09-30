/**
 * Phase 18B Stage 1B2 strict real-database acceptance runner.
 *
 * Ordinary `npm test` treats the Stage 1B2 real-MySQL suites as
 * soft-skippable (the repository's live-DB integration convention), so unit
 * development never depends on a local MySQL being up.
 *
 * This script is the Stage 1B2 ACCEPTANCE path. It runs the seven Stage 1B2
 * real-MySQL suites with their strict flags set:
 *
 *   - the frozen mutation-safety migration shape
 *     (REQUIRE_LIVE_PRACTICAL_MUTATION_DB_INTEGRATION),
 *   - the Wave 2A Phase 17 cancel transaction primitives
 *     (REQUIRE_LIVE_CANCEL_PRIMITIVES_DB_INTEGRATION),
 *   - the Wave 2B1 order-bound practical CANCEL store: atomic acquire and
 *     atomic pre-wire arm (REQUIRE_LIVE_PRACTICAL_CANCEL_STORE_DB_INTEGRATION),
 *   - the Wave 2B2a Phase17/18 bound-claim interlock and no-wire release
 *     primitives (REQUIRE_LIVE_PRACTICAL_CANCEL_INTERLOCK_DB_INTEGRATION),
 *   - the Wave 2B2b consistent listing, no-wire completion / in-process
 *     abandon, and the full two-run reconciliation race
 *     (REQUIRE_LIVE_PRACTICAL_CANCEL_NOWIRE_DB_INTEGRATION),
 *   - the Wave 2B2c unknown-acquire-commit resolution: the discriminator, the
 *     lock order, and the anomaly / receipt lifecycle
 *     (REQUIRE_LIVE_PRACTICAL_CANCEL_UNKNOWN_ACQUIRE_DB_INTEGRATION),
 *   - the Wave 2B2d previous-runtime UNARMED leased-fence recovery, its zombie
 *     races, and the reconciliation afterwards
 *     (REQUIRE_LIVE_PRACTICAL_CANCEL_PREVIOUS_RUNTIME_DB_INTEGRATION).
 *
 * Under those flags each suite's `beforeAll` THROWS, failing the run, if it
 * cannot provision its own real, disposable MySQL database (always dropped
 * afterwards), instead of silently marking itself unavailable. It never uses an
 * operational database.
 *
 * It places NO CoinDCX order and makes no network call: the suites exercise
 * durable persistence only.
 *
 * Before vitest is spawned, DATABASE_URL must be a `mysql:` URL on a loopback
 * host (localhost, 127.0.0.1, ::1, [::1]); anything else is refused here, with
 * a credential-free message, so no suite can create or drop a disposable
 * database on a remote or operational server.
 */
import { spawnSync } from 'node:child_process';
import { assertLocalMysqlDatabaseUrl, DisposableMysqlGuardError } from '../tests/helpers/p18b-disposable-mysql';

try {
  assertLocalMysqlDatabaseUrl(process.env['DATABASE_URL']);
} catch (error) {
  const reason = error instanceof DisposableMysqlGuardError ? error.message : 'the DATABASE_URL guard failed.';
  console.error(`[P18B-1B2-DB-INTEGRATION] refused before launching vitest: ${reason}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    require.resolve('vitest/vitest.mjs'),
    'run',
    'tests/integration/execution/live-practical-mutation-migration.integration.test.ts',
    'tests/integration/execution/live-cancel-transaction-primitives.integration.test.ts',
    'tests/integration/execution/live-practical-cancel-mutation.integration.test.ts',
    'tests/integration/execution/live-practical-cancel-interlock.integration.test.ts',
    'tests/integration/execution/live-practical-cancel-nowire.integration.test.ts',
    'tests/integration/execution/live-practical-cancel-unknown-acquire.integration.test.ts',
    'tests/integration/execution/live-practical-cancel-previous-runtime.integration.test.ts',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      REQUIRE_LIVE_PRACTICAL_MUTATION_DB_INTEGRATION: '1',
      REQUIRE_LIVE_CANCEL_PRIMITIVES_DB_INTEGRATION: '1',
      REQUIRE_LIVE_PRACTICAL_CANCEL_STORE_DB_INTEGRATION: '1',
      REQUIRE_LIVE_PRACTICAL_CANCEL_INTERLOCK_DB_INTEGRATION: '1',
      REQUIRE_LIVE_PRACTICAL_CANCEL_NOWIRE_DB_INTEGRATION: '1',
      REQUIRE_LIVE_PRACTICAL_CANCEL_UNKNOWN_ACQUIRE_DB_INTEGRATION: '1',
      REQUIRE_LIVE_PRACTICAL_CANCEL_PREVIOUS_RUNTIME_DB_INTEGRATION: '1',
    },
  },
);

if (result.error) {
  console.error('[P18B-1B2-DB-INTEGRATION] failed to launch vitest:', result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
