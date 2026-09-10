import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';

// P14-C schema/migration invariant tests. Static only — no live database
// connection, matching the repository's existing Prisma-testing convention
// (`tests/unit/market-data/historical/prisma-manifest-repository.test.ts`
// mocks the client rather than hitting a real DB). These tests assert
// against the generated Prisma DMMF (produced by `npx prisma generate` from
// `prisma/schema.prisma`) and the raw generated migration SQL text.

const dm = Prisma.dmmf.datamodel;

function model(name: string) {
  const found = dm.models.find((m) => m.name === name);
  if (!found) throw new Error(`Model ${name} not found in DMMF`);
  return found;
}

function field(modelName: string, fieldName: string) {
  const found = model(modelName).fields.find((f) => f.name === fieldName);
  if (!found) throw new Error(`Field ${modelName}.${fieldName} not found`);
  return found;
}

function enumValues(name: string): readonly string[] {
  const found = dm.enums.find((e) => e.name === name);
  if (!found) throw new Error(`Enum ${name} not found in DMMF`);
  return found.values.map((v) => v.name);
}

const MIGRATION_DIR = path.resolve(__dirname, '../../../prisma/migrations/20260910050818_phase14_paper_persistence');
const MIGRATION_SQL = readFileSync(path.join(MIGRATION_DIR, 'migration.sql'), 'utf8');

const PHASE0_13_MODELS = ['SystemState', 'Candle1m', 'HistoricalDataset'] as const;
const PHASE14_MODELS = [
  'PaperAccount',
  'PaperExecutionPolicySnapshot',
  'PaperReservation',
  'PaperExecutionIntent',
  'PaperOrder',
  'PaperFill',
  'PaperPosition',
  'PaperPositionOwnershipHistory',
  'PaperLedgerEntry',
  'PaperReconciliationFault',
] as const;

describe('P14-C — final Phase14 model set (V2 §26, frozen at 10 models across V2.1/V2.2/V2.3)', () => {
  it('defines exactly the 10 frozen Phase14 models, no more, no fewer', () => {
    const names = dm.models.map((m) => m.name);
    for (const expected of PHASE14_MODELS) expect(names).toContain(expected);
    const phase14Present = names.filter((n) => PHASE14_MODELS.includes(n as (typeof PHASE14_MODELS)[number]));
    expect(phase14Present).toHaveLength(10);
  });

  it('preserves all pre-Phase14 (Phase0-13) models unchanged in presence', () => {
    const names = dm.models.map((m) => m.name);
    for (const expected of PHASE0_13_MODELS) expect(names).toContain(expected);
    expect(names).toHaveLength(PHASE0_13_MODELS.length + PHASE14_MODELS.length);
  });
});

describe('P14-C — reservation generation-sensitive identity (V2.1 frozen correction)', () => {
  it('has UNIQUE(accountId, riskDecisionId, generation) on PaperReservation', () => {
    const uniques = model('PaperReservation').uniqueIndexes.map((u) => [...u.fields].sort().join(','));
    expect(uniques).toContain([...['accountId', 'riskDecisionId', 'generation']].sort().join(','));
  });

  it('does NOT have the obsolete UNIQUE(accountId, riskDecisionId) two-column constraint', () => {
    const uniques = model('PaperReservation').uniqueIndexes.map((u) => [...u.fields].sort().join(','));
    expect(uniques).not.toContain([...['accountId', 'riskDecisionId']].sort().join(','));
  });

  it('admissionId is the primary key (deterministic, application-supplied, no @default)', () => {
    const f = field('PaperReservation', 'admissionId');
    expect(f.isId).toBe(true);
    expect(f.hasDefaultValue).toBe(false);
  });

  it('the migration SQL itself carries the correct unique index and not the obsolete one', () => {
    expect(MIGRATION_SQL).toMatch(/UNIQUE INDEX `paper_reservation_account_risk_decision_generation_unique`\(`account_id`, `risk_decision_id`, `generation`\)/);
    expect(MIGRATION_SQL).not.toMatch(/UNIQUE INDEX [^(]*\(`account_id`, `risk_decision_id`\)/);
  });

  it('final reservation status enum is ADMITTED/RELEASED/CONSUMED only — deprecated REJECTED (V2.1) is not retained (V2.2 override)', () => {
    expect(enumValues('PaperReservationStatus').slice().sort()).toEqual(['ADMITTED', 'CONSUMED', 'RELEASED'].sort());
  });

  it('has no dangling rejectionReasonCode column (dead alongside the removed REJECTED state)', () => {
    const names = model('PaperReservation').fields.map((f) => f.name);
    expect(names).not.toContain('rejectionReasonCode');
  });
});

describe('P14-C — MySQL-safe pair-slot (V2.1 §3 correction, no partial/filtered index)', () => {
  it('PaperPosition primary key is exactly (accountId, pair)', () => {
    const pk = model('PaperPosition').primaryKey;
    expect(pk).not.toBeNull();
    expect(pk?.fields).toEqual(['accountId', 'pair']);
  });

  it('pair-slot status supports exactly EMPTY/PENDING/OPEN', () => {
    expect(enumValues('PaperPairSlotStatus').slice().sort()).toEqual(['EMPTY', 'OPEN', 'PENDING'].sort());
  });

  it('carries the frozen slot-claim fields: admissionId, positionInstanceId, revision (all mutable-current, not derived)', () => {
    expect(field('PaperPosition', 'admissionId').isRequired).toBe(false);
    expect(field('PaperPosition', 'positionInstanceId').isRequired).toBe(false);
    expect(field('PaperPosition', 'revision').isRequired).toBe(true);
  });

  it('no partial/filtered unique index exists anywhere in the generated migration SQL', () => {
    expect(MIGRATION_SQL).not.toMatch(/WHERE/i);
    expect(MIGRATION_SQL).not.toMatch(/PARTIAL/i);
  });

  it('no PostgreSQL-only syntax appears anywhere in the generated migration SQL', () => {
    expect(MIGRATION_SQL).not.toMatch(/CREATE\s+TYPE/i);
    expect(MIGRATION_SQL).not.toMatch(/SERIAL/i);
    expect(MIGRATION_SQL).not.toMatch(/JSONB/i);
    expect(MIGRATION_SQL).not.toMatch(/RETURNING/i);
  });
});

describe('P14-C — position lifecycle history (V2 §9/§10, V2.1 §4 scope correction)', () => {
  it('PaperPositionOwnershipHistory is keyed by positionInstanceId', () => {
    const f = field('PaperPositionOwnershipHistory', 'positionInstanceId');
    expect(f.isId).toBe(true);
  });

  it('requires closingExecutionIntentId as NOT NULL — a row is never written for an unfinished lifecycle', () => {
    expect(field('PaperPositionOwnershipHistory', 'closingExecutionIntentId').isRequired).toBe(true);
  });
});

describe('P14-C — execution intent OPEN + CLOSE support (V2.2 §5/§6)', () => {
  it('supports both OPEN and CLOSE actions', () => {
    expect(enumValues('PaperExecutionAction').slice().sort()).toEqual(['CLOSE', 'OPEN']);
  });

  it('admissionId is nullable (NULL by design for CLOSE, research-exempt/uncapacitated)', () => {
    expect(field('PaperExecutionIntent', 'admissionId').isRequired).toBe(false);
  });

  it('CLOSE lifecycle fields (positionInstanceId, positionRevision, reduceOnlyQuantity) are representable and nullable (NULL for OPEN)', () => {
    expect(field('PaperExecutionIntent', 'positionInstanceId').isRequired).toBe(false);
    expect(field('PaperExecutionIntent', 'positionRevision').isRequired).toBe(false);
    expect(field('PaperExecutionIntent', 'reduceOnlyQuantity').isRequired).toBe(false);
  });

  it('OPEN lineage/audit fields are representable and nullable (audit-only, excluded from identity hashes per V2.2 §2)', () => {
    for (const f of ['researchApprovalOriginId', 'validationSubjectId', 'validationPlanId', 'validationSubjectResultSha256', 'strategyOriginId']) {
      expect(field('PaperExecutionIntent', f).isRequired).toBe(false);
    }
  });

  it('executionIntentId is the deterministic, application-supplied primary key (no DB default)', () => {
    const f = field('PaperExecutionIntent', 'executionIntentId');
    expect(f.isId).toBe(true);
    expect(f.hasDefaultValue).toBe(false);
  });
});

describe('P14-C — cardinality (V2 §11/§16, V2.2 §11, V2.3 §6)', () => {
  it('PaperOrder is keyed by executionIntentId itself (orderId = executionIntentId — one order per intent, structurally)', () => {
    const f = field('PaperOrder', 'executionIntentId');
    expect(f.isId).toBe(true);
  });

  it('PaperFill is keyed by orderId itself (fillId = orderId — at most one fill per order, structurally)', () => {
    const f = field('PaperFill', 'orderId');
    expect(f.isId).toBe(true);
  });

  it('PaperFill additionally carries UNIQUE(accountId, sourceStrategyDecisionId) — terminal, generation-independent dedup', () => {
    const uniques = model('PaperFill').uniqueIndexes.map((u) => [...u.fields].sort().join(','));
    expect(uniques).toContain([...['accountId', 'sourceStrategyDecisionId']].sort().join(','));
  });

  it('both PaperFill uniqueness constraints coexist (orderId PK + terminal source-decision unique) — neither replaces the other', () => {
    expect(field('PaperFill', 'orderId').isId).toBe(true);
    const uniques = model('PaperFill').uniqueIndexes.map((u) => [...u.fields].sort().join(','));
    expect(uniques.length).toBeGreaterThanOrEqual(1);
  });

  it('terminal source-decision uniqueness is NOT present on paper_reservation or paper_execution_intent (a released/unfilled attempt must remain retryable)', () => {
    const reservationUniques = model('PaperReservation').uniqueIndexes.map((u) => u.fields.slice().sort().join(','));
    const intentUniques = model('PaperExecutionIntent').uniqueIndexes.map((u) => u.fields.slice().sort().join(','));
    const target = ['accountId', 'sourceStrategyDecisionId'].sort().join(',');
    expect(reservationUniques).not.toContain(target);
    expect(intentUniques).not.toContain(target);
  });

  it('sourceExecutionKey is persisted on PaperFill (V2.3 frozen, application-computed, never DB-recomputed)', () => {
    const f = field('PaperFill', 'sourceExecutionKey');
    expect(f.isRequired).toBe(true);
    expect(f.hasDefaultValue).toBe(false);
  });
});

describe('P14-C — execution policy snapshot (V2 §6, content-addressed)', () => {
  it('PaperExecutionPolicySnapshot is keyed by executionPolicySnapshotId with no DB default (application-computed content hash)', () => {
    const f = field('PaperExecutionPolicySnapshot', 'executionPolicySnapshotId');
    expect(f.isId).toBe(true);
    expect(f.hasDefaultValue).toBe(false);
  });

  it('carries the full ExecutionPolicySnapshotContent field set from src/execution/policy.ts', () => {
    const names = model('PaperExecutionPolicySnapshot').fields.map((f) => f.name);
    for (const expected of [
      'policyVersion', 'fillSelectionPolicy', 'maxEvidenceAgeMs', 'requiredHealthState', 'takerFeeRate', 'slippageBps',
      'spreadSemantics', 'tickRoundingPolicy', 'quantityPolicy', 'contractMultiplier', 'currencyConversionPolicy',
      'accountingPolicy', 'executionSemanticsVersion',
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe('P14-C — account owner/fencing storage (V2 §16/§18, storage only)', () => {
  it('PaperAccount carries ownerFence and revision as monotonic, overflow-safe (BigInt) fields', () => {
    expect(field('PaperAccount', 'ownerFence').type).toBe('BigInt');
    expect(field('PaperAccount', 'revision').type).toBe('BigInt');
  });
});

describe('P14-C — Q18 Decimal storage (V2 §19/§21, matching src/execution/decimal.ts MAX_PAPER_SCALE/PRECISION)', () => {
  const decimalFieldsByModel: Record<string, readonly string[]> = {
    PaperAccount: ['startingCapitalInr', 'cumulativeRealizedPnlInr', 'cumulativeFeesInr', 'cumulativeFundingInr', 'peakEquityInr'],
    PaperExecutionPolicySnapshot: ['takerFeeRate', 'slippageBps', 'contractMultiplier'],
    PaperReservation: ['approvedNotionalInr', 'approvedMarginInr'],
    PaperExecutionIntent: ['approvedQuantity', 'approvedLeverage', 'approvedNotionalInr', 'approvedMarginInr', 'reduceOnlyQuantity'],
    PaperFill: ['fillPrice', 'quantity', 'feeInr', 'realizedPnlInr'],
    PaperPosition: ['quantity', 'averageEntryPriceInr', 'leverage', 'initialMarginInr', 'cumulativeRealizedPnlInr', 'cumulativeFeesInr', 'cumulativeFundingInr'],
    PaperPositionOwnershipHistory: ['quantity', 'averageEntryPriceInr', 'exitPriceInr', 'realizedPnlInr', 'totalFeesInr', 'totalFundingInr'],
    PaperLedgerEntry: ['amountInr', 'conversionRateInrPerUsdt'],
  };

  it('every designated Q18 economic field uses native Decimal(36,18), matching PaperDecimal\'s fixed envelope exactly', () => {
    for (const [modelName, fields] of Object.entries(decimalFieldsByModel)) {
      for (const fieldName of fields) {
        const f = field(modelName, fieldName);
        expect(f.type, `${modelName}.${fieldName} type`).toBe('Decimal');
        expect(f.nativeType, `${modelName}.${fieldName} nativeType`).toEqual(['Decimal', ['36', '18']]);
      }
    }
  });

  it('no Float/Double native type is used for any financial field anywhere in the Phase14 models', () => {
    for (const modelName of PHASE14_MODELS) {
      for (const f of model(modelName).fields) {
        expect(f.type, `${modelName}.${f.name}`).not.toBe('Float');
      }
    }
  });

  it('non-economic sequence/revision fields remain Int (no premature narrowing of Decimal, no unnecessary widening of plain counters)', () => {
    expect(field('PaperReservation', 'generation').type).toBe('Int');
    expect(field('PaperReservation', 'decisionSequence').type).toBe('Int');
    expect(field('PaperPosition', 'revision').type).toBe('Int');
  });
});

describe('P14-C — immutable economic fact identity (V2 §21/§23/§26)', () => {
  it('PaperLedgerEntry is keyed by a deterministic entryId with no DB default', () => {
    const f = field('PaperLedgerEntry', 'entryId');
    expect(f.isId).toBe(true);
    expect(f.hasDefaultValue).toBe(false);
  });

  it('enforces per-fill fact dedup UNIQUE(type, sourceFillId)', () => {
    const uniques = model('PaperLedgerEntry').uniqueIndexes.map((u) => u.fields.slice().sort().join(','));
    expect(uniques).toContain(['type', 'sourceFillId'].sort().join(','));
  });

  it('enforces the V2.3 §21 frozen funding key UNIQUE(type, accountId, positionInstanceId, fundingEventId)', () => {
    const uniques = model('PaperLedgerEntry').uniqueIndexes.map((u) => u.fields.slice().sort().join(','));
    expect(uniques).toContain(['type', 'accountId', 'positionInstanceId', 'fundingEventId'].sort().join(','));
  });

  it('supports the exact frozen ledger entry types', () => {
    expect(enumValues('PaperLedgerEntryType').slice().sort()).toEqual(
      ['STARTING_CAPITAL', 'FEE', 'FUNDING', 'REALIZED_PNL', 'MARGIN_ESTABLISH', 'MARGIN_RELEASE'].sort(),
    );
  });
});

describe('P14-C — migration SQL: no unrelated destructive statements', () => {
  it('contains no DROP TABLE, DROP DATABASE, or TRUNCATE statement', () => {
    expect(MIGRATION_SQL).not.toMatch(/DROP\s+TABLE/i);
    expect(MIGRATION_SQL).not.toMatch(/DROP\s+DATABASE/i);
    expect(MIGRATION_SQL).not.toMatch(/TRUNCATE/i);
  });

  it('does not ALTER any pre-existing Phase0-13 table', () => {
    for (const table of ['system_state', 'candles_1m', 'historical_datasets']) {
      expect(MIGRATION_SQL).not.toMatch(new RegExp(`ALTER TABLE \`${table}\``, 'i'));
    }
  });

  it('creates exactly the 10 frozen Phase14 tables', () => {
    const created = [...MIGRATION_SQL.matchAll(/CREATE TABLE `(\w+)`/g)].map((m) => m[1]);
    expect(created.sort()).toEqual(
      [
        'paper_account', 'paper_execution_policy_snapshot', 'paper_reservation', 'paper_execution_intent',
        'paper_order', 'paper_fill', 'paper_position', 'paper_position_ownership_history', 'paper_ledger_entry',
        'paper_reconciliation_fault',
      ].sort(),
    );
  });
});

describe('P14-C — P14-A/P14-B source semantics unchanged (regression guard)', () => {
  it('src/execution and src/integration/coindcx/paper-evidence.ts identity/contract constants are untouched', () => {
    const identitySource = readFileSync(path.resolve(__dirname, '../../../src/execution/identity.ts'), 'utf8');
    expect(identitySource).toContain("'P14_EXECUTION_INTENT_IDENTITY_V2'");
    expect(identitySource).toContain("'P14_CLOSE_EXECUTION_INTENT_IDENTITY_V1'");
    expect(identitySource).toContain("'P14_POSITION_INSTANCE_IDENTITY_V1'");
    expect(identitySource).toContain("'P14_SOURCE_EXECUTION_IDENTITY_V1'");
    const decimalSource = readFileSync(path.resolve(__dirname, '../../../src/execution/decimal.ts'), 'utf8');
    expect(decimalSource).toContain('MAX_PAPER_SCALE = 18');
    expect(decimalSource).toContain('MAX_PAPER_INTEGER_DIGITS = 18');
    expect(decimalSource).toContain('MAX_PAPER_PRECISION = 36');
  });
});
