import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// [Wave C3 / F18-19] Migration freeze discipline, enforced rather than only
// documented (`docs/PHASE18_RECONCILIATION.md` §15.1).
//
//   1. An accepted migration is immutable. Its bytes are pinned here.
//   2. Any later schema or persistence correction is a NEW, later-timestamped
//      forward migration. It is added below this list; nothing in the list
//      is ever edited to make parity or a test pass.
//   3. The migration parity scripts only compare; they never write, reset, or
//      regenerate a migration, so they cannot authorize rewriting one either.
//
// Hashes are taken over the file with CRLF normalized to LF, so a Windows or
// Unix checkout of the same committed bytes yields the same digest (several
// pre-Phase18 migrations are checked out with CRLF line endings here).
//
// Updating an entry in FROZEN_MIGRATIONS is never the fix for a failure here:
// restore the migration and add a new forward migration instead.

const REPO_ROOT = path.resolve(__dirname, '../..');
const MIGRATIONS_ROOT = path.join(REPO_ROOT, 'prisma/migrations');

const FROZEN_MIGRATIONS: Readonly<Record<string, string>> = Object.freeze({
  '20260902000000_init': '26fd8a8cf22c190760f1aa7a7dc2b030d21410ab4ce6fec81ee5dc09459fc4dc',
  '20260904000000_add_candles_1m': 'ae1ee1185245abd0f1a3006a4b1a7d41b7f1b8f9d05f67ecb512baeaa2317fe6',
  '20260906000000_add_historical_datasets': '9008c92cb1ab8886dcec27d20bd85f9de455a6b3c7fbf5a0db2911be3cffdd1f',
  '20260910050818_phase14_paper_persistence': 'd8b423d4d63592c11a5778a50e33456d3efe34cba53079e82459f81b79ba9dd9',
  '20260915000000_phase14_wave3b_instrument_economics': 'f419314d7bd3483187d1097f5d29b001d389a67860241e544a1b0b28c02694fb',
  '20260916000000_phase14_account_mutation_order': '8dbf905a01983a65944a37b6a036efb276f24ed9b55d46b813157c6bb445a522',
  '20260916120000_phase15_strategy_ranking': '9f7a6d9e0a0f0ff592da74ace98e0e300778182747b790caca0b553f7fe77b6b',
  '20260920000000_phase17_live_execution': '3a1e8e4669921b4e0928f03270dea4e6479a67f3a3dca5c49dcb96493c7ebc22',
  '20260921000000_phase18_reconciliation': '159d60b2314532a285e942b260300468285be19083166e2a123b6cf73761c0ab',
  '20260921010000_phase18_wave_a2_crash_recovery': '8387511487309150f7df64ee7bc822677c2774c695cb3d35d03dee2209a0c50a',
  '20260922000000_phase18_wave_c1_orphan_resolution': '14272259dc91d1a1c63325f47bf073b75e6a85583f3907de3c11b935e86cebf7',
  // Phase 18B Stage 1B1 (practical live-safety persistence), frozen after final source + SQL review (P18B-1B1-01..05 closed).
  '20260925000000_phase18b_practical_persistence': '734e3d01758667cf652c1a57745fc3c2bca9476599459b820f752a20eb054f99',
});

const PHASE18_MIGRATIONS = Object.keys(FROZEN_MIGRATIONS).filter((name) => name.includes('_phase18_'));
const PHASE18B_STAGE_1B1_MIGRATION = '20260925000000_phase18b_practical_persistence';
const MIGRATION_DIRECTORY = /^\d{14}_[a-z0-9_]+$/;

function migrationDirectories(): string[] {
  return readdirSync(MIGRATIONS_ROOT)
    .filter((name) => statSync(path.join(MIGRATIONS_ROOT, name)).isDirectory())
    .sort();
}

function normalizedSha256(directory: string): string {
  const text = readFileSync(path.join(MIGRATIONS_ROOT, directory, 'migration.sql'), 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text).digest('hex');
}

describe('[F18-19] accepted migrations are frozen', () => {
  it('pins all three Phase18 migrations, including the Wave C1 forward migration', () => {
    expect(PHASE18_MIGRATIONS).toEqual([
      '20260921000000_phase18_reconciliation',
      '20260921010000_phase18_wave_a2_crash_recovery',
      '20260922000000_phase18_wave_c1_orphan_resolution',
    ]);
  });

  it('pins the accepted Phase18B Stage 1B1 migration under its exact name, and no other Phase18B migration', () => {
    expect(Object.keys(FROZEN_MIGRATIONS).filter((name) => name.includes('phase18b'))).toEqual([PHASE18B_STAGE_1B1_MIGRATION]);
    expect(FROZEN_MIGRATIONS[PHASE18B_STAGE_1B1_MIGRATION]).toBe('734e3d01758667cf652c1a57745fc3c2bca9476599459b820f752a20eb054f99');
    expect(migrationDirectories()).toContain(PHASE18B_STAGE_1B1_MIGRATION);
  });

  it('a second Phase18B migration is never covered by the accepted one\'s pin: it is unfrozen and must be a later forward migration', () => {
    // The pin is an exact directory-name lookup (no prefix or pattern match), so another
    // phase18b directory is a separate, not-yet-accepted migration and must sort after it.
    for (const directory of migrationDirectories().filter((name) => name.includes('phase18b') && name !== PHASE18B_STAGE_1B1_MIGRATION)) {
      expect(Object.prototype.hasOwnProperty.call(FROZEN_MIGRATIONS, directory), directory).toBe(false);
      expect(directory > PHASE18B_STAGE_1B1_MIGRATION, `${directory} must sort after ${PHASE18B_STAGE_1B1_MIGRATION}`).toBe(true);
    }
  });

  it.each(Object.entries(FROZEN_MIGRATIONS))('%s is byte-identical to its accepted content', (directory, sha256) => {
    expect(readdirSync(path.join(MIGRATIONS_ROOT, directory))).toEqual(['migration.sql']);
    expect(normalizedSha256(directory)).toBe(sha256);
  });

  it('allows a new migration only as a later-timestamped forward migration after every frozen one', () => {
    const frozen = Object.keys(FROZEN_MIGRATIONS);
    const newestFrozen = [...frozen].sort().at(-1)!;
    for (const directory of migrationDirectories()) {
      expect(directory, directory).toMatch(MIGRATION_DIRECTORY);
      if (!frozen.includes(directory)) {
        // Never back-dated or inserted between accepted migrations.
        expect(directory > newestFrozen, `${directory} must sort after ${newestFrozen}`).toBe(true);
      }
    }
    for (const directory of frozen) expect(migrationDirectories()).toContain(directory);
  });
});

describe('[F18-19] the migration parity scripts compare and never rewrite', () => {
  it.each(['scripts/verify-phase17-migration-parity.ts', 'scripts/verify-phase18-migration-parity.ts'])('%s performs no write, reset, or regeneration', (script) => {
    const code = readFileSync(path.join(REPO_ROOT, script), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [/writeFile|appendFile|copyFile|rename(Sync)?\(|unlink|rmSync|mkdirSync/, /'dev'|migrate dev/, /'reset'|migrate reset/, /--force|--accept-data-loss|db push|'push'/, /prisma\/migrations/]) {
      expect(code, `${script} matches ${String(forbidden)}`).not.toMatch(forbidden);
    }
    // What it does do: apply migrations to a disposable database and diff.
    expect(code).toContain("'deploy'");
    expect(code).toContain("'diff'");
  });
});
