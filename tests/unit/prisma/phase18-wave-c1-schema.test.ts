import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';

// [Wave C1 / F18-06] Static schema and migration invariants for
// `20260922000000_phase18_wave_c1_orphan_resolution`, matching the existing
// `phase18-schema.test.ts` convention (DMMF + raw migration SQL text, no live
// database connection). The real-MySQL suite
// (`live-reconciliation-persistence.integration.test.ts`, `[C1-1]`..`[C1-7]`)
// and `npm run verify:migration:phase18` prove the migration actually behaves
// correctly against a real database; this file pins its STATIC shape so a
// future edit cannot silently narrow it (e.g. dropping the unique index, or
// widening a bounded column) without a test noticing.

const dm = Prisma.dmmf.datamodel;
const MIGRATION_DIR = path.resolve(__dirname, '../../../prisma/migrations/20260922000000_phase18_wave_c1_orphan_resolution');
const MIGRATION_SQL = readFileSync(path.join(MIGRATION_DIR, 'migration.sql'), 'utf8');

function model(name: string) {
  const found = dm.models.find((entry) => entry.name === name);
  if (!found) throw new Error(`Model ${name} not found in DMMF`);
  return found;
}

function field(modelName: string, fieldName: string) {
  const found = model(modelName).fields.find((entry) => entry.name === fieldName);
  if (!found) throw new Error(`Field ${modelName}.${fieldName} not found`);
  return found;
}

function enumValues(name: string): readonly string[] {
  const found = dm.enums.find((entry) => entry.name === name);
  if (!found) throw new Error(`Enum ${name} not found in DMMF`);
  return found.values.map((value) => value.name);
}

describe('P18 Wave C1 §F18-06 the migration is additive and touches only what it must', () => {
  it('creates exactly one new table', () => {
    const created = [...MIGRATION_SQL.matchAll(/CREATE TABLE `([^`]+)`/g)].map((match) => match[1]);
    expect(created).toEqual(['live_orphan_cancel_resolution']);
  });

  it('drops nothing and backfills nothing', () => {
    expect(MIGRATION_SQL).not.toMatch(/DROP TABLE/i);
    expect(MIGRATION_SQL).not.toMatch(/DROP COLUMN/i);
    expect(MIGRATION_SQL).not.toMatch(/\bINSERT INTO\b/i);
    expect(MIGRATION_SQL).not.toMatch(/\bUPDATE .* SET\b/i);
  });

  it('the only MODIFY is the additive cancel_state enum widening, and it only ADDS a value', () => {
    const modifies = [...MIGRATION_SQL.matchAll(/MODIFY COLUMN `([^`]+)`/g)].map((m) => m[1]);
    expect(modifies).toEqual(['cancel_state']);
    // Every value the original migration declared is still present, in the
    // same relative order, with exactly one new value appended.
    expect(MIGRATION_SQL).toMatch(
      /ENUM\('NONE', 'CANCEL_CLAIMED', 'CANCEL_ACKNOWLEDGED', 'CANCEL_AMBIGUOUS', 'CANCEL_REJECTED', 'CANCEL_AMBIGUOUS_RESOLVED'\)/,
    );
  });

  it('touches no table outside live_orphan_venue_order and its own new table', () => {
    const alters = [...MIGRATION_SQL.matchAll(/ALTER TABLE `([^`]+)`/g)].map((m) => m[1]);
    for (const table of alters) {
      expect(['live_orphan_venue_order', 'live_orphan_cancel_resolution']).toContain(table);
    }
  });
});

describe('P18 Wave C1 §F18-06 the new enum and model exist with the documented shape', () => {
  it('adds LiveOrphanCancelResolutionOutcome with exactly the two documented values', () => {
    expect(enumValues('LiveOrphanCancelResolutionOutcome')).toEqual(['ACKNOWLEDGED_NO_RETRY', 'CONFIRMED_CANCELLED']);
  });

  it('extends LiveOrphanCancelState with exactly one new terminal value, appended after the originals', () => {
    const values = enumValues('LiveOrphanCancelState');
    expect(values.slice(0, 5)).toEqual(['NONE', 'CANCEL_CLAIMED', 'CANCEL_ACKNOWLEDGED', 'CANCEL_AMBIGUOUS', 'CANCEL_REJECTED']);
    expect(values[5]).toBe('CANCEL_AMBIGUOUS_RESOLVED');
    expect(values).toHaveLength(6);
  });

  it('declares LiveOrphanCancelResolution mapped to the expected table', () => {
    expect(model('LiveOrphanCancelResolution').dbName).toBe('live_orphan_cancel_resolution');
  });

  it('binds a resolution to exactly one cancellation attempt via a unique constraint', () => {
    expect(MIGRATION_SQL).toMatch(/UNIQUE INDEX `live_orphan_cancel_resolution_account_order_gen_key`\(`account_id`, `exchange_order_id`, `resolved_cancel_generation`\)/);
    expect(model('LiveOrphanCancelResolution').uniqueFields).toContainEqual(['accountId', 'exchangeOrderId', 'resolvedCancelGeneration']);
  });

  it('foreign-keys the resolution to its orphan with an explicit name and RESTRICT semantics', () => {
    expect(MIGRATION_SQL).toContain('ADD CONSTRAINT `live_orphan_cancel_resolution_orphan_fkey`');
    const fkLine = MIGRATION_SQL.split('\n').find((line) => line.includes('live_orphan_cancel_resolution_orphan_fkey'));
    expect(fkLine).toContain('ON DELETE RESTRICT');
    expect(fkLine).toContain('ON UPDATE RESTRICT');
  });

  it('bounds the operator identity and note columns rather than leaving them unbounded TEXT', () => {
    expect(MIGRATION_SQL).toContain('`resolved_by` VARCHAR(128) NOT NULL');
    expect(MIGRATION_SQL).toContain('`note` VARCHAR(512) NULL');
  });

  it('stores the resolved revision/generation as plain integers, matching the row they fence against', () => {
    expect(field('LiveOrphanCancelResolution', 'resolvedOrphanRevision').type).toBe('Int');
    expect(field('LiveOrphanCancelResolution', 'resolvedCancelGeneration').type).toBe('Int');
  });

  it('declares no column whose name suggests credential material', () => {
    for (const entry of model('LiveOrphanCancelResolution').fields) {
      expect(/key|secret|signature|authorization|token|password|credential/i.test(entry.name), entry.name).toBe(false);
    }
  });
});
