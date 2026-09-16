import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';

// P15 §11 schema/migration invariants. Static only — asserts against the
// generated Prisma DMMF and the raw migration SQL text, matching the existing
// `phase14-schema.test.ts` convention (no live database connection).

const dm = Prisma.dmmf.datamodel;
const MIGRATION_DIR = path.resolve(__dirname, '../../../prisma/migrations/20260916120000_phase15_strategy_ranking');
const MIGRATION_SQL = readFileSync(path.join(MIGRATION_DIR, 'migration.sql'), 'utf8');
const PHASE15_MODELS = ['RankingRun', 'RankingResult'] as const;

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

describe('Phase15 ranking schema', () => {
  it('adds exactly the two Phase15 models', () => {
    for (const name of PHASE15_MODELS) expect(model(name).dbName).toBe(name === 'RankingRun' ? 'ranking_run' : 'ranking_result');
  });

  it('keys a ranking run by its deterministic rankingRunId (idempotent re-persist)', () => {
    expect(field('RankingRun', 'rankingRunId').isId).toBe(true);
    expect(field('RankingRun', 'rankingRunId').dbName).toBe('ranking_run_id');
  });

  it('keys a ranking result by its own content hash', () => {
    expect(field('RankingResult', 'rankingResultSha256').isId).toBe(true);
  });

  it('persists the frozen economic limitation on both tables', () => {
    for (const name of PHASE15_MODELS) {
      expect(field(name, 'economicStatus').isRequired).toBe(true);
      expect(field(name, 'promotionEligible').type).toBe('Boolean');
      expect(field(name, 'promotionEligible').isRequired).toBe(true);
      expect(field(name, 'maxLifecycle').isRequired).toBe(true);
    }
  });

  it('stores the composite score as a nullable DECIMAL, never a float', () => {
    const composite = field('RankingResult', 'compositeScore');
    expect(composite.type).toBe('Decimal');
    expect(composite.isRequired).toBe(false);
    expect(MIGRATION_SQL).toContain('`composite_score` DECIMAL(36,18) NULL');
    expect(MIGRATION_SQL).not.toMatch(/\bFLOAT\b|\bDOUBLE\b/i);
  });

  it('leaves ranked-only columns nullable so an unrankable row is never a fabricated zero', () => {
    for (const name of ['rank', 'candidateCount', 'compositeTieGroupSize', 'tieBreakLevelApplied', 'componentScoresJson', 'unavailableComponentsJson']) {
      expect(field('RankingResult', name).isRequired).toBe(false);
    }
  });

  it('binds each result row to its run by foreign key and enforces one row per subject per run', () => {
    expect(MIGRATION_SQL).toContain('ranking_result_run_fkey');
    expect(MIGRATION_SQL).toContain('ON DELETE RESTRICT ON UPDATE RESTRICT');
    expect(MIGRATION_SQL).toContain('UNIQUE INDEX `ranking_result_run_subject_unique`(`ranking_run_id`, `validation_subject_id`)');
  });

  it('binds the Phase12 lineage columns on every result row', () => {
    for (const name of ['validationSubjectId', 'validationPlanId', 'validationSubjectResultSha256', 'parameterHash', 'strategyId', 'strategyVersion', 'pair']) {
      expect(field('RankingResult', name).isRequired).toBe(true);
    }
    expect(field('RankingRun', 'validationPlanId').isRequired).toBe(true);
  });

  it('is purely additive: it creates only Phase15 tables and alters nothing existing', () => {
    const withoutComments = MIGRATION_SQL.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    const statements = withoutComments.split(';').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      expect(statement).toMatch(/^(CREATE TABLE `ranking_(run|result)`|ALTER TABLE `ranking_result`)/);
    }
    // No data statement and no destructive statement exists; `RESTRICT` is the
    // only context in which these words appear at all.
    expect(withoutComments).not.toMatch(/\bDROP\b|\bUPDATE\s+`|\bINSERT\b|\bDELETE\s+FROM\b/i);
  });

  it('never references a Phase12 or Phase14 table (no cross-phase mutation surface)', () => {
    for (const forbidden of ['paper_account', 'paper_position', 'paper_ledger_entry', 'paper_order', 'paper_fill', 'candles_1m', 'historical_dataset']) {
      expect(MIGRATION_SQL).not.toContain(forbidden);
    }
    for (const name of PHASE15_MODELS) {
      for (const relation of model(name).fields.filter((entry) => entry.kind === 'object')) {
        expect(PHASE15_MODELS as readonly string[]).toContain(relation.type);
      }
    }
  });

  it('adds no relation from any pre-Phase15 model into the ranking tables', () => {
    for (const entry of dm.models) {
      if ((PHASE15_MODELS as readonly string[]).includes(entry.name)) continue;
      for (const relation of entry.fields.filter((item) => item.kind === 'object')) {
        expect(PHASE15_MODELS as readonly string[]).not.toContain(relation.type);
      }
    }
  });
});
