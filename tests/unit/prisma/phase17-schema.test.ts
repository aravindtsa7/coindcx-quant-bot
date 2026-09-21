import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';

// P17 §8/§14 schema and migration invariants. Static only — asserts against the
// generated Prisma DMMF and the raw migration SQL text, matching the existing
// `phase14-schema.test.ts` / `phase15-schema.test.ts` convention (no live
// database connection).

const dm = Prisma.dmmf.datamodel;
const MIGRATION_SQL = readFileSync(
  path.resolve(__dirname, '../../../prisma/migrations/20260920000000_phase17_live_execution/migration.sql'),
  'utf8',
);
const SCHEMA = readFileSync(path.resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');

const PHASE17_MODELS = ['LiveExecutionIntent', 'LiveAdmissionConsumption', 'LivePosition', 'LiveOrder', 'LiveOrderEvent'] as const;
const PRESERVED_MODELS = [
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

describe('P17 adds five models and preserves every earlier one', () => {
  it('declares the Phase17 model set', () => {
    const names = dm.models.map((entry) => entry.name);
    for (const expected of PHASE17_MODELS) expect(names).toContain(expected);
  });

  it('leaves every Phase0-15 model present and untouched in presence', () => {
    const names = dm.models.map((entry) => entry.name);
    for (const preserved of PRESERVED_MODELS) expect(names).toContain(preserved);
  });

  it('the migration is purely additive: five CREATE TABLEs, no ALTER of an existing table, no DROP', () => {
    expect(MIGRATION_SQL.match(/CREATE TABLE/g)).toHaveLength(5);
    expect(MIGRATION_SQL).not.toMatch(/DROP\s+TABLE/i);
    expect(MIGRATION_SQL).not.toMatch(/DROP\s+COLUMN/i);
    expect(MIGRATION_SQL).not.toMatch(/TRUNCATE/i);
    // The only ALTERs are foreign keys on the new tables themselves.
    const alters = MIGRATION_SQL.match(/ALTER TABLE `([a-z_]+)`/g) ?? [];
    expect(alters).toEqual(['ALTER TABLE `live_order`', 'ALTER TABLE `live_order_event`', 'ALTER TABLE `live_admission_consumption`']);
  });

  it('touches no paper or ranking table', () => {
    for (const legacy of ['paper_account', 'paper_order', 'paper_fill', 'paper_position', 'ranking_run', 'ranking_result']) {
      expect(MIGRATION_SQL).not.toContain(legacy);
    }
  });

  it('performs no backfill: nothing is INSERTed or UPDATEd from exchange state', () => {
    expect(MIGRATION_SQL).not.toMatch(/INSERT\s+INTO/i);
    expect(MIGRATION_SQL).not.toMatch(/UPDATE\s+`/i);
  });
});

describe('P17 durable identity and idempotence constraints', () => {
  it('uses the deterministic intent identity as the primary key', () => {
    expect(field('LiveExecutionIntent', 'intentId').isId).toBe(true);
    expect(field('LiveOrder', 'intentId').isId).toBe(true);
    expect(MIGRATION_SQL).toContain('PRIMARY KEY (`intent_id`)');
  });

  it('makes the client order id globally unique on both tables', () => {
    expect(field('LiveExecutionIntent', 'clientOrderId').isUnique).toBe(true);
    expect(field('LiveOrder', 'clientOrderId').isUnique).toBe(true);
    expect(MIGRATION_SQL).toContain('UNIQUE INDEX `live_execution_intent_client_order_id_unique`(`client_order_id`)');
    expect(MIGRATION_SQL).toContain('UNIQUE INDEX `live_order_client_order_id_unique`(`client_order_id`)');
  });

  it('deduplicates provider events by (intent, observation hash)', () => {
    expect(MIGRATION_SQL).toContain('UNIQUE INDEX `live_order_event_intent_observation_unique`(`intent_id`, `observation_sha256`)');
  });

  it('persists a canonical immutable intent digest', () => {
    expect(field('LiveExecutionIntent', 'contentSha256').isRequired).toBe(true);
    expect(MIGRATION_SQL).toContain('`content_sha256` VARCHAR(64) NOT NULL');
  });

  it('persists a separate cancellation claim generation and outcome', () => {
    expect(field('LiveOrder', 'cancelGeneration').type).toBe('Int');
    expect(field('LiveOrder', 'cancelState').type).toBe('LiveCancelState');
    expect(MIGRATION_SQL).toContain('`cancel_generation` INTEGER NOT NULL DEFAULT 0');
  });

  it('carries the optimistic-concurrency revision used by every conditional update', () => {
    const revision = field('LiveOrder', 'revision');
    expect(revision.type).toBe('Int');
    expect(revision.hasDefaultValue).toBe(true);
    expect(MIGRATION_SQL).toContain('`revision` INTEGER NOT NULL DEFAULT 0');
  });

  it('binds each order to its intent, and each event to its order, with RESTRICT semantics', () => {
    expect(MIGRATION_SQL).toContain('REFERENCES `live_execution_intent`(`intent_id`)');
    expect(MIGRATION_SQL).toContain('REFERENCES `live_order`(`intent_id`)');
    expect(MIGRATION_SQL.match(/ON DELETE RESTRICT ON UPDATE RESTRICT/g)).toHaveLength(3);
  });

  it('pins Phase17 foreign-key names identically in Prisma and migration SQL', () => {
    for (const name of [
      'live_order_intent_fkey',
      'live_order_event_order_fkey',
      'live_admission_consumption_intent_fkey',
    ]) {
      expect(SCHEMA).toContain(`map: "${name}"`);
      expect(MIGRATION_SQL).toContain(`ADD CONSTRAINT \`${name}\``);
    }
  });
});

describe('P17 economic values use Decimal-compatible storage', () => {
  const decimalColumns: ReadonlyArray<readonly [string, string]> = [
    ['LiveExecutionIntent', 'quantity'],
    ['LiveExecutionIntent', 'price'],
    ['LiveExecutionIntent', 'leverage'],
    ['LiveExecutionIntent', 'authorizedNotionalInr'],
    ['LiveExecutionIntent', 'settlementRateInrPerQuote'],
    ['LiveExecutionIntent', 'reduceOnlyQuantity'],
    ['LivePosition', 'quantity'],
    ['LiveOrder', 'orderedQuantity'],
    ['LiveOrder', 'cumulativeFilledQuantity'],
    ['LiveOrder', 'remainingQuantity'],
    ['LiveOrder', 'averageFillPrice'],
    ['LiveOrderEvent', 'cumulativeFilledQuantity'],
    ['LiveOrderEvent', 'averageFillPrice'],
  ];

  it.each(decimalColumns)('%s.%s is a Decimal column', (modelName, fieldName) => {
    expect(field(modelName, fieldName).type).toBe('Decimal');
  });

  it('every Phase17 decimal column is DECIMAL(36,18), matching the repository-wide convention', () => {
    const declarations = MIGRATION_SQL.match(/DECIMAL\(\d+,\d+\)/g) ?? [];
    expect(declarations.length).toBe(decimalColumns.length);
    for (const declaration of declarations) expect(declaration).toBe('DECIMAL(36,18)');
  });

  it('stores provider and observation times as BigInt epoch-ms, distinct from operational timestamps', () => {
    expect(field('LiveOrder', 'lastProviderEventTimeMs').type).toBe('BigInt');
    expect(field('LiveOrderEvent', 'providerEventTimeMs').type).toBe('BigInt');
    expect(field('LiveOrder', 'createdAt').type).toBe('DateTime');
    expect(field('LiveOrder', 'updatedAt').type).toBe('DateTime');
  });
});

describe('P17 enum vocabulary matches the frozen state model', () => {
  it('declares the ten live order states', () => {
    expect(enumValues('LiveOrderState')).toEqual([
      'CREATED', 'DISPATCH_RESERVED', 'SUBMISSION_AMBIGUOUS', 'ACKNOWLEDGED',
      'PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'CANCELLED', 'REJECTED', 'RECONCILIATION_REQUIRED',
    ]);
    expect(enumValues('LiveCancelState')).toEqual([
      'NONE', 'CANCEL_RESERVED', 'CANCEL_ACKNOWLEDGED', 'CANCEL_AMBIGUOUS', 'CANCEL_REJECTED',
    ]);
  });

  it('declares the observation kinds, sides, actions, order types, and time-in-force values', () => {
    expect(enumValues('LiveOrderEventKind')).toEqual(['ACKNOWLEDGED', 'PARTIAL_FILL', 'FILL', 'CANCELLED', 'REJECTED']);
    expect(enumValues('LiveOrderSide')).toEqual(['BUY', 'SELL']);
    expect(enumValues('LiveExecutionActionKind')).toEqual(['OPEN', 'CLOSE']);
    expect(enumValues('LiveOrderTypeKind')).toEqual(['MARKET', 'LIMIT']);
    expect(enumValues('LiveTimeInForceKind')).toEqual([
      'UNSPECIFIED', 'GOOD_TILL_CANCEL', 'FILL_OR_KILL', 'POST_ONLY', 'IMMEDIATE_OR_CANCEL',
    ]);
  });

  it('keeps the Phase14 paper enums separate and unchanged', () => {
    expect(enumValues('PaperOrderSide')).toEqual(['BUY', 'SELL']);
    expect(dm.enums.map((entry) => entry.name)).toContain('PaperOrderState');
  });
});

describe('P17 nullable columns represent genuine absence, never a guess', () => {
  it('leaves the exchange order id nullable until the venue genuinely supplies one', () => {
    expect(field('LiveOrder', 'exchangeOrderId').isRequired).toBe(false);
    expect(MIGRATION_SQL).toContain('`exchange_order_id` VARCHAR(64) NULL');
  });

  it('leaves research lineage nullable, because CLOSE is research-exempt', () => {
    for (const column of ['validationSubjectId', 'validationPlanId', 'validationSubjectResultSha256']) {
      expect(field('LiveExecutionIntent', column).isRequired).toBe(false);
    }
    expect(field('LiveExecutionIntent', 'sourceStrategyDecisionId').isRequired).toBe(true);
  });

  it('leaves the admission id nullable, because a CLOSE is never capacity-tracked', () => {
    expect(field('LiveExecutionIntent', 'admissionId').isRequired).toBe(false);
    expect(field('LiveExecutionIntent', 'riskDecisionId').isRequired).toBe(true);
  });

  it('records a fault code only when a fail-closed state was genuinely reached', () => {
    expect(field('LiveOrder', 'faultCode').isRequired).toBe(false);
  });
});

describe('P17 schema documents what it persists', () => {
  it('names the Phase17 section and its idempotence mechanism', () => {
    expect(SCHEMA).toContain('PHASE 17 — LIVE EXECUTION');
    expect(SCHEMA).toContain('live_execution_intent');
    expect(SCHEMA).toContain('live_order_event');
  });

  it('stores no raw credential-bearing provider payload', () => {
    for (const forbidden of ['api_key', 'api_secret', 'signature', 'auth_header', 'raw_request']) {
      expect(SCHEMA.toLowerCase()).not.toContain(`${forbidden} `);
      expect(MIGRATION_SQL.toLowerCase()).not.toContain(forbidden);
    }
  });
});
