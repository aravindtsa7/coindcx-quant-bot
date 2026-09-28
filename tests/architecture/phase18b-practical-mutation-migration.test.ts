import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRACTICAL_MUTATION_OUTCOMES } from '../../src/execution/live/practical/types';

// Phase 18B Stage 1B2, Wave 1: the durable order-bound lease SHAPE only.
//
//   - One new forward migration, after every earlier accepted one. It is
//     FROZEN: after independent source, SQL, manifest, real-MySQL, and hash
//     review it is pinned in phase18-migration-freeze.test.ts under its exact
//     name and accepted LF-normalized SHA-256 (this file requires that pin).
//   - It lifts exactly ONE Stage 1B1 constraint (never armed), in the same
//     statement that adds the strict Stage 1B2 coupling CHECKs.
//   - ONE structural order binding: a single composite FK on
//     (intent_id, client_order_id, account_id) to live_order, backed by a new
//     composite UNIQUE index on live_order. No independent single-column FK.
//   - Nothing else changes: no drop, rename, modify, or data change.

const REPO_ROOT = path.resolve(__dirname, '../..');
const MIGRATIONS_ROOT = path.join(REPO_ROOT, 'prisma/migrations');
const MIGRATION = '20260927000000_phase18b_practical_mutation_safety';
/** The accepted LF-normalized SHA-256 (the freeze pin). */
const ACCEPTED_SHA256 = '02f9d0112f3a3287e1f7dae37afd326026e550f5aed21d143e6f4f6f69ea243b';
const CHECKPOINT_C = '20260926000000_phase18b_practical_shadow_calibration';
const STAGE_1B1 = '20260925000000_phase18b_practical_persistence';
const LEASE = '`live_practical_mutation_lease`';

function migrationSql(directory: string): string {
  return readFileSync(path.join(MIGRATIONS_ROOT, directory, 'migration.sql'), 'utf8').replace(/\r\n/g, '\n');
}

/** SQL statements without comment lines, whitespace collapsed (no space just inside parentheses). */
function statementsOf(sql: string): string[] {
  return sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
    .split(';').map((statement) => statement.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim()).filter(Boolean);
}

const sql = migrationSql(MIGRATION);
const statements = statementsOf(sql);

const EXPECTED_CHECKS: readonly (readonly [string, string])[] = [
  ['live_practical_mutation_lease_binding_chk', '(`intent_id` IS NULL) = (`client_order_id` IS NULL) AND (`intent_id` IS NULL) = (`cancel_generation` IS NULL)'],
  ['live_practical_mutation_lease_bound_action_chk', "`intent_id` IS NULL OR `action` = 'CANCEL'"],
  ['live_practical_mutation_lease_cancel_generation_chk', '`cancel_generation` IS NULL OR `cancel_generation` >= 1'],
  ['live_practical_mutation_lease_armed_bound_chk', '`armed_at_ms` IS NULL OR `intent_id` IS NOT NULL'],
  ['live_practical_mutation_lease_armed_time_chk', '`armed_at_ms` IS NULL OR `armed_at_ms` >= `created_at_ms`'],
  ['live_practical_mutation_lease_bound_completed_time_chk', '`intent_id` IS NULL OR `completed_at_ms` IS NULL OR `completed_at_ms` >= COALESCE(`armed_at_ms`, `created_at_ms`)'],
  ['live_practical_mutation_lease_bound_outcome_chk', "`intent_id` IS NULL OR `outcome` IS NULL OR (`armed_at_ms` IS NULL AND `outcome` = 'PRE_DISPATCH_FAILURE') OR (`armed_at_ms` IS NOT NULL AND `outcome` IN ('ACCEPTED', 'REJECTED', 'AMBIGUOUS', 'PRE_DISPATCH_FAILURE'))"],
];

describe('[Stage 1B2] the order-bound lease migration: placement and freeze status', () => {
  it('is the newest migration, directly after the frozen Checkpoint C migration, and holds exactly migration.sql', () => {
    const directories = readdirSync(MIGRATIONS_ROOT).filter((name) => statSync(path.join(MIGRATIONS_ROOT, name)).isDirectory()).sort();
    expect(directories.at(-1)).toBe(MIGRATION);
    expect(directories.at(-2)).toBe(CHECKPOINT_C);
    expect(directories.filter((name) => name.includes('phase18b'))).toEqual([STAGE_1B1, CHECKPOINT_C, MIGRATION]);
    expect(readdirSync(path.join(MIGRATIONS_ROOT, MIGRATION))).toEqual(['migration.sql']);
  });

  it('is FROZEN under its exact name and accepted hash, and its bytes on disk still match that hash', () => {
    const freezeTest = readFileSync(path.join(REPO_ROOT, 'tests/architecture/phase18-migration-freeze.test.ts'), 'utf8');
    expect(freezeTest).toContain(`'${MIGRATION}': '${ACCEPTED_SHA256}',`);
    expect(createHash('sha256').update(sql).digest('hex')).toBe(ACCEPTED_SHA256);
  });

  it('the frozen Stage 1B1 migration still carries its "never armed" CHECK: the lift happens ONLY in this forward migration', () => {
    expect(migrationSql(STAGE_1B1)).toContain('ADD CONSTRAINT `live_practical_mutation_lease_not_armed_chk` CHECK (`armed_at_ms` IS NULL)');
  });
});

describe('[Stage 1B2] the order-bound lease migration: exact statement shape', () => {
  it('consists of exactly these six statements, in this order', () => {
    expect(statements).toHaveLength(6);
    expect(statements[0]).toBe(`ALTER TABLE ${LEASE} ADD COLUMN \`cancel_generation\` INTEGER NULL`);
    expect(statements[1]).toBe('CREATE UNIQUE INDEX `live_order_practical_binding_key` ON `live_order`(`intent_id`, `client_order_id`, `account_id`)');
    expect(statements[2]).toBe(`CREATE INDEX \`live_practical_mutation_lease_order_binding_idx\` ON ${LEASE}(\`intent_id\`, \`client_order_id\`, \`account_id\`)`);
    expect(statements[3]).toBe(`CREATE UNIQUE INDEX \`live_practical_mutation_lease_intent_cancel_key\` ON ${LEASE}(\`intent_id\`, \`cancel_generation\`)`);
    expect(statements[4]).toBe(`ALTER TABLE ${LEASE} ADD CONSTRAINT \`live_practical_mutation_lease_order_fkey\` `
      + 'FOREIGN KEY (`intent_id`, `client_order_id`, `account_id`) REFERENCES `live_order`(`intent_id`, `client_order_id`, `account_id`) '
      + 'ON DELETE RESTRICT ON UPDATE RESTRICT');
    expect(statements[5]!.startsWith(`ALTER TABLE ${LEASE} DROP CHECK \`live_practical_mutation_lease_not_armed_chk\`, ADD CONSTRAINT`)).toBe(true);
  });

  it('lifts exactly ONE constraint (never armed), in the SAME statement that adds every Stage 1B2 coupling CHECK', () => {
    const drops = [...sql.matchAll(/\bDROP\b[^,;]*/g)].map((match) => match[0].trim());
    expect(drops).toEqual(['DROP CHECK `live_practical_mutation_lease_not_armed_chk`']);
    const replace = statements[5]!;
    const added = [...replace.matchAll(/ADD CONSTRAINT `([a-z_]+)` CHECK \((.*?)\)(?=, ADD CONSTRAINT|$)/g)].map((match) => [match[1], match[2]] as const);
    expect(added).toEqual(EXPECTED_CHECKS);
    expect(statements.filter((statement) => statement.includes(' CHECK '))).toEqual([replace]);
  });

  it('changes nothing else: no rename, modify, truncate, or data change; no other table is altered', () => {
    for (const statement of statements) {
      const withoutReferentialClauses = statement.replace(/ON (DELETE|UPDATE) RESTRICT/g, '');
      expect(withoutReferentialClauses, statement).not.toMatch(/\bRENAME\b|\bMODIFY\b|\bCHANGE\b|\bTRUNCATE\b|\bDELETE\b|\bUPDATE\b|\bINSERT\b|CASCADE|SET NULL|SET DEFAULT/i);
      expect(statement, statement).toMatch(/^(ALTER TABLE `live_practical_mutation_lease`|CREATE (UNIQUE )?INDEX `[a-z_]+` ON `(live_practical_mutation_lease|live_order)`)/);
    }
    // live_order receives exactly one additive index and nothing else.
    expect(statements.filter((statement) => statement.includes('`live_order`('))).toHaveLength(2);
    expect(statements.some((statement) => statement.startsWith('ALTER TABLE `live_order`'))).toBe(false);
  });

  it('binds an order-bound lease to live_order through ONE composite key only (no independent single-column foreign key)', () => {
    const foreignKeys = statements.filter((statement) => statement.includes('FOREIGN KEY'));
    expect(foreignKeys).toEqual([statements[4]]);
    expect([...sql.matchAll(/REFERENCES `([a-z_]+)`\(([^)]*)\)/g)].map((match) => [match[1], match[2]])).toEqual([
      ['live_order', '`intent_id`, `client_order_id`, `account_id`'],
    ]);
    expect(sql).not.toMatch(/FOREIGN KEY \(`intent_id`\)|FOREIGN KEY \(`client_order_id`\)/);
  });

  it('an ARMED order-bound lease may complete only with a Stage 1A outcome other than the create-only DUPLICATE_CLIENT_ORDER_ID', () => {
    const armedOutcomes = [...EXPECTED_CHECKS.at(-1)![1].slice(EXPECTED_CHECKS.at(-1)![1].lastIndexOf('IN (')).matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
    expect(armedOutcomes).toEqual(PRACTICAL_MUTATION_OUTCOMES.filter((outcome) => outcome !== 'DUPLICATE_CLIENT_ORDER_ID'));
  });

  it('stores no credential, signature, raw provider identity, or provider payload', () => {
    const code = statements.join('\n');
    expect(code).not.toMatch(/api_?key|apiKey|secret|signature|authorization|coindcx_?id|coindcxId|payload|raw_|password|token/i);
  });
});

describe('[Stage 1B2] prisma/schema.prisma agrees with the migration and weakens no Phase 17 key', () => {
  const schema = readFileSync(path.join(REPO_ROOT, 'prisma/schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const model = (name: string): string => {
    const start = schema.indexOf(`model ${name} {`);
    expect(start, name).toBeGreaterThan(-1);
    return schema.slice(start, schema.indexOf('\n}', start)).replace(/^\s*\/\/\/.*$/gm, '');
  };

  it('the lease model carries the nullable cancel generation, the one composite order relation, and both new keys', () => {
    const lease = model('LivePracticalMutationLease');
    expect(lease).toMatch(/cancelGeneration\s+Int\?\s+@map\("cancel_generation"\)/);
    expect(lease).toMatch(/intentId\s+String\?\s+@map\("intent_id"\) @db\.VarChar\(64\)/);
    expect(lease).toMatch(/clientOrderId\s+String\?\s+@map\("client_order_id"\) @db\.VarChar\(64\)/);
    expect(lease).toContain('@relation("LivePracticalLeaseOrderBinding", fields: [intentId, clientOrderId, accountId], references: [intentId, clientOrderId, accountId], onDelete: Restrict, onUpdate: Restrict, map: "live_practical_mutation_lease_order_fkey")');
    expect(lease).toContain('@@unique([intentId, cancelGeneration], map: "live_practical_mutation_lease_intent_cancel_key")');
    expect(lease).toContain('@@index([intentId, clientOrderId, accountId], map: "live_practical_mutation_lease_order_binding_idx")');
    // Exactly one relation to LiveOrder.
    expect(lease.match(/\bLiveOrder\?/g)).toHaveLength(1);
  });

  it('live_order gains only the composite binding key; its primary key and client-order-id uniqueness are unchanged', () => {
    const order = model('LiveOrder');
    expect(order).toContain('@@unique([intentId, clientOrderId, accountId], map: "live_order_practical_binding_key")');
    expect(order).toMatch(/intentId\s+String @id @map\("intent_id"\) @db\.VarChar\(64\)/);
    expect(order).toMatch(/clientOrderId String @unique\(map: "live_order_client_order_id_unique"\) @map\("client_order_id"\) @db\.VarChar\(64\)/);
    expect(order).toContain('practicalMutationLeases LivePracticalMutationLease[] @relation("LivePracticalLeaseOrderBinding")');
  });
});
