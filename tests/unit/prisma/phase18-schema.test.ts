import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';

// P18 §23 schema and migration invariants. Static only — asserts against the
// generated Prisma DMMF and the raw migration SQL text, matching the existing
// `phase14/15/17-schema.test.ts` convention (no live database connection).

const dm = Prisma.dmmf.datamodel;
const MIGRATION_DIR = path.resolve(__dirname, '../../../prisma/migrations/20260921000000_phase18_reconciliation');
const MIGRATION_SQL = readFileSync(path.join(MIGRATION_DIR, 'migration.sql'), 'utf8');
const SCHEMA = readFileSync(path.resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');

/**
 * The migration's executable statements with `--` comment lines removed.
 *
 * Several assertions below check that a name does NOT appear. The header
 * comment legitimately DISCUSSES those names (it explains why Phase18 leaves
 * the Phase14/15 drift alone), so the assertions must run against what the
 * database actually executes, not against the prose explaining it.
 */
const MIGRATION_STATEMENTS = MIGRATION_SQL
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

const PHASE18_MODELS = [
  'LiveReconciliationState',
  'LiveReconciliationRun',
  'LiveReconciliationFinding',
  'LiveOrphanVenueOrder',
  'LivePositionOwnershipShare',
] as const;

const PHASE17_MODELS = ['LiveExecutionIntent', 'LiveAdmissionConsumption', 'LivePosition', 'LiveOrder', 'LiveOrderEvent'] as const;
const EARLIER_MODELS = [
  'SystemState', 'Candle1m', 'HistoricalDataset',
  'PaperAccount', 'PaperExecutionPolicySnapshot', 'PaperInstrumentEconomicsSnapshot', 'PaperReservation',
  'PaperExecutionIntent', 'PaperOrder', 'PaperFill', 'PaperPosition', 'PaperPositionOwnershipHistory',
  'PaperLedgerEntry', 'PaperReconciliationFault', 'RankingRun', 'RankingResult',
] as const;

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

describe('P18 adds five models and preserves every earlier one', () => {
  it('declares the Phase18 model set', () => {
    for (const name of PHASE18_MODELS) expect(model(name).name).toBe(name);
  });

  it('leaves every Phase17 and earlier model in place', () => {
    for (const name of [...PHASE17_MODELS, ...EARLIER_MODELS]) expect(model(name).name).toBe(name);
  });

  it('maps every Phase18 model to a snake_case table', () => {
    const expected: Record<string, string> = {
      LiveReconciliationState: 'live_reconciliation_state',
      LiveReconciliationRun: 'live_reconciliation_run',
      LiveReconciliationFinding: 'live_reconciliation_finding',
      LiveOrphanVenueOrder: 'live_orphan_venue_order',
      LivePositionOwnershipShare: 'live_position_ownership_share',
    };
    for (const [name, table] of Object.entries(expected)) {
      expect(model(name).dbName).toBe(table);
    }
  });
});

describe('P18 §23 the migration is strictly additive', () => {
  it('creates exactly the five Phase18 tables', () => {
    const created = [...MIGRATION_SQL.matchAll(/CREATE TABLE `([^`]+)`/g)].map((match) => match[1]).sort();
    expect(created).toEqual([
      'live_orphan_venue_order',
      'live_position_ownership_share',
      'live_reconciliation_finding',
      'live_reconciliation_run',
      'live_reconciliation_state',
    ]);
  });

  it('ALTERs no existing table, drops nothing, and backfills nothing', () => {
    // The only ALTER statements permitted are the two ADD CONSTRAINT lines that
    // attach Phase18's own foreign keys to Phase18's own new tables.
    const alters = [...MIGRATION_SQL.matchAll(/ALTER TABLE `([^`]+)`([^;]*);/g)];
    for (const [, table, body] of alters) {
      expect(['live_reconciliation_run', 'live_reconciliation_finding']).toContain(table);
      expect(body).toContain('ADD CONSTRAINT');
    }
    expect(MIGRATION_SQL).not.toMatch(/DROP TABLE/i);
    expect(MIGRATION_SQL).not.toMatch(/DROP COLUMN/i);
    expect(MIGRATION_SQL).not.toMatch(/\bMODIFY\b/i);
    expect(MIGRATION_SQL).not.toMatch(/\bINSERT INTO\b/i);
    expect(MIGRATION_SQL).not.toMatch(/\bUPDATE .* SET\b/i);
  });

  it('does NOT rewrite the pre-existing Phase14/15 foreign-key name drift', () => {
    // That drift predates Phase18 and is explicitly out of scope: an additive
    // reconciliation migration must not silently mutate Phase14/15 objects.
    expect(MIGRATION_STATEMENTS).not.toContain('paper_execution_intent');
    expect(MIGRATION_STATEMENTS).not.toContain('ranking_result');
  });

  it('touches no Phase17 table', () => {
    for (const table of ['live_execution_intent', 'live_order', 'live_order_event', 'live_admission_consumption']) {
      expect(MIGRATION_SQL).not.toContain(`\`${table}\``);
    }
    // `live_position` is READ by Phase18 but never altered by this migration.
    expect(MIGRATION_SQL).not.toContain('ALTER TABLE `live_position`');
  });
});

describe('P18 §4 fencing constraints exist in the database, not in application memory', () => {
  it('makes one generation ownable by exactly one run', () => {
    // The constraint NAME is asserted against the migration SQL; the DMMF does
    // not surface an index's `map` name, so the datamodel side asserts the
    // exact field tuple instead. Together they pin both.
    expect(MIGRATION_SQL).toMatch(/UNIQUE INDEX `live_reconciliation_run_account_generation_unique`\(`account_id`, `generation`\)/);
    expect(model('LiveReconciliationRun').uniqueFields).toContainEqual(['accountId', 'generation']);
  });

  it('makes a repeated finding an update rather than a duplicate row', () => {
    expect(MIGRATION_SQL).toMatch(/UNIQUE INDEX `live_reconciliation_finding_account_content_unique`\(`account_id`, `finding_sha256`\)/);
    expect(model('LiveReconciliationFinding').uniqueFields).toContainEqual(['accountId', 'findingSha256']);
  });

  it('binds an orphan cancellation claim to one exact venue order identity', () => {
    expect(MIGRATION_SQL).toMatch(/PRIMARY KEY \(`account_id`, `exchange_order_id`\)/);
    expect(model('LiveOrphanVenueOrder').primaryKey?.fields).toEqual(['accountId', 'exchangeOrderId']);
  });

  it('lets several instances hold shares of one position without owning the aggregate', () => {
    expect(model('LivePositionOwnershipShare').primaryKey?.fields)
      .toEqual(['accountId', 'pair', 'ownerStrategyInstanceId']);
  });

  it('gives every mutable Phase18 row an optimistic-concurrency token', () => {
    for (const name of ['LiveReconciliationState', 'LiveOrphanVenueOrder', 'LivePositionOwnershipShare']) {
      expect(field(name, 'revision').type).toBe('Int');
    }
  });
});

describe('P18 §23 explicit indexes and foreign-key names', () => {
  it('pins both Phase18 foreign-key names explicitly', () => {
    expect(MIGRATION_SQL).toContain('ADD CONSTRAINT `live_reconciliation_run_state_fkey`');
    expect(MIGRATION_SQL).toContain('ADD CONSTRAINT `live_reconciliation_finding_run_fkey`');
    expect(SCHEMA).toContain('map: "live_reconciliation_run_state_fkey"');
    expect(SCHEMA).toContain('map: "live_reconciliation_finding_run_fkey"');
  });

  it('uses RESTRICT on both foreign keys, so reconciliation history is never cascade-deleted', () => {
    const fkLines = MIGRATION_SQL.split('\n').filter((line) => line.includes('ADD CONSTRAINT'));
    expect(fkLines).toHaveLength(2);
    for (const line of fkLines) {
      expect(line).toContain('ON DELETE RESTRICT');
      expect(line).toContain('ON UPDATE RESTRICT');
    }
  });

  it('declares the query indexes the barrier and the reconciler actually use', () => {
    for (const index of [
      'live_reconciliation_state_status_idx',
      'live_reconciliation_run_account_status_idx',
      'live_reconciliation_finding_account_generation_idx',
      'live_reconciliation_finding_account_category_idx',
      'live_orphan_venue_order_account_cancel_idx',
      'live_orphan_venue_order_account_pair_idx',
      'live_position_ownership_share_account_pair_idx',
    ]) {
      expect(MIGRATION_SQL).toContain(index);
    }
  });
});

describe('P18 §15 every economic column is an exact Decimal', () => {
  it('stores every Phase18 quantity and price as DECIMAL(36,18)', () => {
    const decimalColumns: readonly (readonly [string, string])[] = [
      ['LiveOrphanVenueOrder', 'orderedQuantity'],
      ['LiveOrphanVenueOrder', 'filledQuantity'],
      ['LiveOrphanVenueOrder', 'price'],
      ['LivePositionOwnershipShare', 'quantity'],
    ];
    for (const [modelName, fieldName] of decimalColumns) {
      expect(field(modelName, fieldName).type, `${modelName}.${fieldName}`).toBe('Decimal');
    }
    const decimalCount = [...MIGRATION_SQL.matchAll(/DECIMAL\(36,\s*18\)/g)].length;
    expect(decimalCount).toBe(decimalColumns.length);
  });

  it('declares no FLOAT, DOUBLE, or REAL column anywhere in the migration', () => {
    expect(MIGRATION_STATEMENTS).not.toMatch(/\bFLOAT\b/i);
    expect(MIGRATION_STATEMENTS).not.toMatch(/\bDOUBLE\b/i);
    expect(MIGRATION_STATEMENTS).not.toMatch(/\bREAL\b/i);
  });

  it('keeps provider and local times in BigInt epoch-millisecond columns', () => {
    for (const [modelName, fieldName] of [
      ['LiveReconciliationRun', 'snapshotStartedAtMs'],
      ['LiveReconciliationFinding', 'firstSeenAtMs'],
      ['LiveOrphanVenueOrder', 'providerEventTimeMs'],
    ] as const) {
      expect(field(modelName, fieldName).type).toBe('BigInt');
    }
  });
});

describe('P18 §3/§12 enums encode the fail-closed defaults', () => {
  it('defaults an account to RECONCILIATION_REQUIRED', () => {
    expect(enumValues('LiveReconciliationStatus')).toEqual([
      'RECONCILIATION_REQUIRED', 'RUNNING', 'HEALTHY', 'UNHEALTHY', 'MANUAL_REVIEW_REQUIRED',
    ]);
    expect(field('LiveReconciliationState', 'status').default).toBe('RECONCILIATION_REQUIRED');
    expect(MIGRATION_SQL).toContain("DEFAULT 'RECONCILIATION_REQUIRED'");
  });

  it('declares the full conservative finding taxonomy', () => {
    expect(enumValues('LiveReconciliationFindingCategory')).toEqual([
      'VERIFIED_MATCH',
      'SAFE_AUTHORITATIVE_ADVANCE',
      'LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE',
      'CONFLICT',
      'ORPHAN',
      'AMBIGUOUS',
      'MANUAL_REVIEW_REQUIRED',
    ]);
  });

  it('defaults a finding to blocking, so a new category cannot silently permit trading', () => {
    expect(field('LiveReconciliationFinding', 'blocking').default).toBe(true);
  });

  it('defaults an orphan to having no cancellation claim', () => {
    // [Wave C1 / F18-06] `CANCEL_AMBIGUOUS_RESOLVED` was added by the later
    // `20260922000000_phase18_wave_c1_orphan_resolution` migration — this
    // assertion checks the live, fully-accumulated DMMF (every migration
    // applied, not just the original one this file's other assertions pin),
    // so it must track every wave that has since extended the enum.
    expect(enumValues('LiveOrphanCancelState')).toEqual([
      'NONE', 'CANCEL_CLAIMED', 'CANCEL_ACKNOWLEDGED', 'CANCEL_AMBIGUOUS', 'CANCEL_REJECTED', 'CANCEL_AMBIGUOUS_RESOLVED',
    ]);
    expect(field('LiveOrphanVenueOrder', 'cancelState').default).toBe('NONE');
  });

  it('declares an explicit ABANDONED run status so a crashed run is recoverable, not stuck', () => {
    expect(enumValues('LiveReconciliationRunStatus')).toContain('ABANDONED');
  });

  it('defaults a position share to un-materialized', () => {
    expect(field('LivePositionOwnershipShare', 'materialized').default).toBe(false);
  });
});

describe('P18 §21 the schema stores no credential-bearing column', () => {
  it('declares no column whose name suggests credential material', () => {
    for (const name of PHASE18_MODELS) {
      for (const entry of model(name).fields) {
        expect(/key|secret|signature|authorization|token|password|credential/i.test(entry.name), `${name}.${entry.name}`).toBe(false);
      }
    }
  });

  it('keeps finding evidence a sanitized TEXT column, never a raw provider payload column', () => {
    expect(field('LiveReconciliationFinding', 'evidenceJson').type).toBe('String');
    expect(MIGRATION_SQL).toContain('`evidence_json` TEXT NOT NULL');
    expect(MIGRATION_SQL).not.toMatch(/raw_(response|payload|body|request)/i);
  });
});
