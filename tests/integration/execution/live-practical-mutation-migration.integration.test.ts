import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { URL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPracticalSafetyRepository } from '../../../src/execution/live/practical-persistence/repository';

// [P18B-1B2-W1-DB] Real MySQL proof of the Stage 1B2 Wave 1 lease SHAPE
// migration (`20260927000000_phase18b_practical_mutation_safety`): the ONE
// composite order-binding foreign key, the lifted "never armed" CHECK and
// its strict replacements, and legacy UNBOUND Stage 1B1 compatibility.
//
// Rows are written with raw SQL on purpose: this suite proves what the
// DATABASE refuses, independently of any application code. Fixture rows are
// structural only (no sealed-intent digest is verified here).
//
// NOTHING HERE TOUCHES COINDCX: no gateway, transport, signer, or network.
//
// ACCEPTANCE SEMANTICS (the Phase 17/18 convention): soft-skips without a
// reachable local MySQL; with REQUIRE_LIVE_PRACTICAL_MUTATION_DB_INTEGRATION=1
// `beforeAll` THROWS instead, so a false green is impossible. It always runs
// against its own disposable database, which it drops afterwards.

const REPO_ROOT = path.resolve(__dirname, '../../..');
const STRICT = process.env['REQUIRE_LIVE_PRACTICAL_MUTATION_DB_INTEGRATION'] === '1';
const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = `p18b_mutation_test_${randomBytes(6).toString('hex')}`;

function mysqlArgs(extra: readonly string[]): string[] {
  const url = new URL(BASE_DATABASE_URL!);
  const args = ['-h', url.hostname, '-P', url.port || '3306', '-u', decodeURIComponent(url.username)];
  if (url.password) args.push(`-p${decodeURIComponent(url.password)}`);
  return [...args, ...extra];
}

function shadowDatabaseUrl(): string {
  const url = new URL(BASE_DATABASE_URL!);
  url.pathname = `/${SHADOW_DB_NAME}`;
  return url.toString();
}

let dbAvailable = false;
let prisma: PrismaClient;

beforeAll(async () => {
  if (!BASE_DATABASE_URL) {
    if (STRICT) throw new Error('[P18B-1B2-DB] REQUIRE_LIVE_PRACTICAL_MUTATION_DB_INTEGRATION=1 but no DATABASE_URL is configured.');
    return;
  }
  try {
    execFileSync('mysql', mysqlArgs(['-e', `CREATE DATABASE \`${SHADOW_DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: REPO_ROOT, stdio: 'pipe', timeout: 120_000, shell: true, env: { ...process.env, DATABASE_URL: shadowDatabaseUrl() },
    });
    prisma = new PrismaClient({ datasources: { db: { url: shadowDatabaseUrl() } } });
    await prisma.$queryRawUnsafe('SELECT 1');
    dbAvailable = true;
  } catch (error) {
    dbAvailable = false;
    if (STRICT) throw new Error(`[P18B-1B2-DB] strict mode could not provision a disposable MySQL database: ${(error as Error).name}`);
  }
}, 180_000);

afterAll(async () => {
  if (!dbAvailable) return;
  await prisma.$disconnect();
  try {
    execFileSync('mysql', mysqlArgs(['-e', `DROP DATABASE IF EXISTS \`${SHADOW_DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
  } catch { /* best-effort cleanup only */ }
}, 30_000);

function skip(): boolean {
  if (dbAvailable) return false;
  if (STRICT) throw new Error('[P18B-1B2-DB] strict mode reached a test body with no database connection.');
  console.warn('P18B Stage 1B2 migration DB suite skipped: no reachable disposable MySQL. Set REQUIRE_LIVE_PRACTICAL_MUTATION_DB_INTEGRATION=1 to make this hard.');
  return true;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EPOCH = 'runtime-epoch-w1';
const T0 = 1_000_000;
const hex64 = (): string => randomBytes(32).toString('hex');
const suffix = (): string => randomBytes(4).toString('hex');

interface OrderFixture { readonly intentId: string; readonly clientOrderId: string; readonly accountId: string }

/** A structural live_execution_intent + live_order pair (fixture only: the digest is not a real seal). */
async function seedOrder(accountId: string, label: string): Promise<OrderFixture> {
  const intentId = `w1-intent-${label}-${suffix()}`;
  const clientOrderId = `w1-cid-${label}-${suffix()}`;
  await prisma.liveExecutionIntent.create({ data: {
    intentId, clientOrderId, contentSha256: hex64(), accountId, pair: 'B-BTC_USDT', side: 'BUY', action: 'OPEN', quantity: '1',
    orderType: 'LIMIT', price: '100', timeInForce: 'UNSPECIFIED', leverage: '1', wireOrderType: 'limit_order', riskDecisionId: `rd-${suffix()}`,
    admissionId: null, strategyInstanceId: 'si-1', strategyId: 'EMA_TREND', strategyVersion: '1.0.0', parameterHash: hex64(),
    liveExecutionPolicyId: 'policy-1', instrumentSpecSnapshotId: 'spec-1', authorizedNotionalInr: '1000', settlementRateInrPerQuote: '90',
    positionInstanceId: null, positionRevision: null, reduceOnlyQuantity: null, sourceStrategyDecisionId: `sd-${suffix()}`,
  } });
  await prisma.liveOrder.create({ data: {
    intentId, clientOrderId, accountId, pair: 'B-BTC_USDT', state: 'ACKNOWLEDGED', exchangeOrderId: `ex-${suffix()}`,
    orderedQuantity: '1', cumulativeFilledQuantity: '0', remainingQuantity: '1', revision: 1,
  } });
  return { intentId, clientOrderId, accountId };
}

/** A practical account (QUARANTINED, IDLE fence, open recovery episode) created through the Stage 1B1 repository. */
async function seedAccount(): Promise<string> {
  const accountId = `w1-acct-${suffix()}`;
  const created = await new PrismaPracticalSafetyRepository(prisma).initializeAccount({ accountId, runtimeEpoch: EPOCH, reconciliationGeneration: 0, nowMs: T0 });
  expect(created.kind).toBe('CREATED');
  return accountId;
}

/** A fresh CONSUMED certificate (every lease needs its own: UNIQUE certificate_id). */
async function seedCertificate(accountId: string): Promise<string> {
  const certificateId = hex64();
  await prisma.livePracticalCertificate.create({ data: {
    certificateId, accountId, providerAccountFingerprint: hex64(), runtimeEpoch: EPOCH, reconciliationGeneration: 1, streamIncarnation: 1,
    evidenceDigest: hex64(), issuedAtMs: BigInt(T0), expiresAtMs: BigInt(T0 + 120_000), status: 'CONSUMED', terminalAtMs: BigInt(T0 + 1),
  } });
  return certificateId;
}

interface LeaseInsert {
  readonly accountId: string;
  readonly action?: string;
  readonly intentId?: string | null;
  readonly clientOrderId?: string | null;
  readonly cancelGeneration?: number | null;
  readonly createdAtMs?: number;
  readonly armedAtMs?: number | null;
  readonly completedAtMs?: number | null;
  readonly status?: 'LEASED' | 'COMPLETED';
  readonly outcome?: string | null;
}

/** Raw INSERT of one lease row (its own fresh certificate). Returns the lease id. */
async function insertLease(input: LeaseInsert): Promise<string> {
  const leaseId = `w1-lease-${suffix()}`;
  const certificateId = await seedCertificate(input.accountId);
  const armed = input.armedAtMs === undefined || input.armedAtMs === null ? null : BigInt(input.armedAtMs);
  const completed = input.completedAtMs === undefined || input.completedAtMs === null ? null : BigInt(input.completedAtMs);
  await prisma.$executeRaw`INSERT INTO live_practical_mutation_lease
    (lease_id, account_id, certificate_id, action, intent_id, client_order_id, cancel_generation, runtime_epoch,
     reconciliation_generation, created_at_ms, armed_at_ms, completed_at_ms, status, outcome)
    VALUES (${leaseId}, ${input.accountId}, ${certificateId}, ${input.action ?? 'CANCEL'}, ${input.intentId ?? null}, ${input.clientOrderId ?? null},
     ${input.cancelGeneration ?? null}, ${EPOCH}, 1, ${BigInt(input.createdAtMs ?? T0 + 10)}, ${armed}, ${completed},
     ${input.status ?? 'LEASED'}, ${input.outcome ?? null})`;
  return leaseId;
}

/** A bound lease on `order` (defaults: unarmed, LEASED, a fresh cancel generation). */
function bound(order: OrderFixture, overrides: Partial<LeaseInsert> = {}): LeaseInsert {
  return { accountId: order.accountId, intentId: order.intentId, clientOrderId: order.clientOrderId, cancelGeneration: nextGeneration(), ...overrides };
}

let generationCounter = 0;
function nextGeneration(): number {
  generationCounter += 1;
  return generationCounter;
}

const CHECK_VIOLATION = (name: string): RegExp => new RegExp(`Check constraint '${name}' is violated`);
const ORDER_FK_VIOLATION = /foreign key constraint fails[\s\S]*live_practical_mutation_lease_order_fkey/;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('P18B-1B2-W1-DB the migration is applied exactly (MySQL 8.0 via prisma migrate deploy)', () => {
  it('runs on MySQL 8.0.x and records the Stage 1B2 migration as applied, after every accepted one', async () => {
    if (skip()) return;
    const [server] = await prisma.$queryRaw<{ version: string }[]>`SELECT VERSION() AS version`;
    expect(server?.version).toMatch(/^8\.0\./);
    const applied = await prisma.$queryRaw<{ name: string; finished: number }[]>`SELECT migration_name AS name, (finished_at IS NOT NULL AND rolled_back_at IS NULL) AS finished
      FROM _prisma_migrations ORDER BY migration_name`;
    expect(applied.at(-1)).toMatchObject({ name: '20260927000000_phase18b_practical_mutation_safety' });
    expect(applied.every((row) => Number(row.finished) === 1)).toBe(true);
  });

  it('the ONE composite order-binding FK exists: (intent_id, client_order_id, account_id) -> live_order, RESTRICT/RESTRICT; no other lease -> live_order FK', async () => {
    if (skip()) return;
    const columns = await prisma.$queryRaw<{ name: string; column: string; referencedTable: string; referencedColumn: string; position: number }[]>`
      SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS \`column\`, REFERENCED_TABLE_NAME AS referencedTable, REFERENCED_COLUMN_NAME AS referencedColumn, ORDINAL_POSITION AS position
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ${SHADOW_DB_NAME} AND TABLE_NAME = 'live_practical_mutation_lease' AND REFERENCED_TABLE_NAME = 'live_order'
      ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`;
    expect(columns.map((row) => [row.name, row.column, row.referencedTable, row.referencedColumn, Number(row.position)])).toEqual([
      ['live_practical_mutation_lease_order_fkey', 'intent_id', 'live_order', 'intent_id', 1],
      ['live_practical_mutation_lease_order_fkey', 'client_order_id', 'live_order', 'client_order_id', 2],
      ['live_practical_mutation_lease_order_fkey', 'account_id', 'live_order', 'account_id', 3],
    ]);
    const [rule] = await prisma.$queryRaw<{ updateRule: string; deleteRule: string }[]>`SELECT UPDATE_RULE AS updateRule, DELETE_RULE AS deleteRule
      FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ${SHADOW_DB_NAME} AND CONSTRAINT_NAME = 'live_practical_mutation_lease_order_fkey'`;
    expect(rule).toEqual({ updateRule: 'RESTRICT', deleteRule: 'RESTRICT' });
  });

  it('live_order gains exactly the composite binding key; its primary key and client-order-id uniqueness are unchanged', async () => {
    if (skip()) return;
    const indexes = await prisma.$queryRaw<{ name: string; nonUnique: number; column: string; seq: number }[]>`
      SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS \`column\`, SEQ_IN_INDEX AS seq
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ${SHADOW_DB_NAME} AND TABLE_NAME = 'live_order'
        AND INDEX_NAME IN ('PRIMARY', 'live_order_client_order_id_unique', 'live_order_practical_binding_key')
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`;
    // Sorted here, not by MySQL: information_schema's collation orders 'PRIMARY' differently from lowercase names.
    const rows = indexes.map((row) => [row.name, Number(row.nonUnique), row.column, Number(row.seq)] as const)
      .sort((a, b) => (a[0] === b[0] ? a[3] - b[3] : a[0] < b[0] ? -1 : 1));
    expect(rows).toEqual([
      ['PRIMARY', 0, 'intent_id', 1],
      ['live_order_client_order_id_unique', 0, 'client_order_id', 1],
      ['live_order_practical_binding_key', 0, 'intent_id', 1],
      ['live_order_practical_binding_key', 0, 'client_order_id', 2],
      ['live_order_practical_binding_key', 0, 'account_id', 3],
    ]);
  });

  it('the Stage 1B1 "never armed" CHECK is gone and exactly the seven Stage 1B2 lease CHECKs are present', async () => {
    if (skip()) return;
    const rows = await prisma.$queryRaw<{ name: string }[]>`SELECT CONSTRAINT_NAME AS name FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = ${SHADOW_DB_NAME} AND CONSTRAINT_NAME LIKE 'live\\_practical\\_mutation\\_lease\\_%' ORDER BY CONSTRAINT_NAME`;
    expect(rows.map((row) => row.name).sort()).toEqual([
      'live_practical_mutation_lease_armed_bound_chk',
      'live_practical_mutation_lease_armed_time_chk',
      'live_practical_mutation_lease_binding_chk',
      'live_practical_mutation_lease_bound_action_chk',
      'live_practical_mutation_lease_bound_completed_time_chk',
      'live_practical_mutation_lease_bound_outcome_chk',
      'live_practical_mutation_lease_cancel_generation_chk',
      // Kept from Stage 1B1.
      'live_practical_mutation_lease_completed_chk',
      'live_practical_mutation_lease_generation_chk',
      'live_practical_mutation_lease_outcome_chk',
    ]);
  });
});

describe('P18B-1B2-W1-DB the database enforces the ONE structural order binding', () => {
  it('an order-bound lease on one exact live_order row is accepted and reads back with its exact binding', async () => {
    if (skip()) return;
    const accountId = await seedAccount();
    const order = await seedOrder(accountId, 'a');
    const generation = nextGeneration();
    const leaseId = await insertLease(bound(order, { cancelGeneration: generation }));
    const load = await new PrismaPracticalSafetyRepository(prisma).loadLease(leaseId);
    expect(load).toMatchObject({ kind: 'FOUND', record: {
      leaseId, accountId, action: 'CANCEL', armedAtMs: null, status: 'LEASED',
      orderBinding: { intentId: order.intentId, clientOrderId: order.clientOrderId, cancelGeneration: generation },
    } });
  });

  it('intent, client order id, and account from DIFFERENT live_order rows are refused by the composite key', async () => {
    if (skip()) return;
    const accountId = await seedAccount();
    const otherAccountId = await seedAccount();
    const a = await seedOrder(accountId, 'a');
    const b = await seedOrder(accountId, 'b');
    const c = await seedOrder(otherAccountId, 'c');
    for (const mixed of [
      { accountId, intentId: a.intentId, clientOrderId: b.clientOrderId },
      { accountId, intentId: b.intentId, clientOrderId: a.clientOrderId },
      // Each id genuinely exists, but only on another account's row (and the reverse).
      { accountId, intentId: c.intentId, clientOrderId: c.clientOrderId },
      { accountId: otherAccountId, intentId: a.intentId, clientOrderId: a.clientOrderId },
      { accountId, intentId: a.intentId, clientOrderId: c.clientOrderId },
      // An intent that exists nowhere.
      { accountId, intentId: 'w1-intent-missing', clientOrderId: a.clientOrderId },
    ]) {
      await expect(insertLease({ ...mixed, cancelGeneration: nextGeneration() }), JSON.stringify(mixed)).rejects.toThrow(ORDER_FK_VIOLATION);
    }
    expect(await prisma.livePracticalMutationLease.count({ where: { accountId: { in: [accountId, otherAccountId] } } })).toBe(0);
  });

  it('a referenced live_order row cannot be deleted while a lease binds it (RESTRICT)', async () => {
    if (skip()) return;
    const accountId = await seedAccount();
    const order = await seedOrder(accountId, 'a');
    await insertLease(bound(order));
    await expect(prisma.$executeRaw`DELETE FROM live_order WHERE intent_id = ${order.intentId}`).rejects.toThrow(/foreign key constraint fails/);
  });

  it('DEFENSE IN DEPTH ONLY: the case-insensitive collation lets a case-variant binding through, so the application must compare exactly', async () => {
    if (skip()) return;
    const accountId = await seedAccount();
    const order = await seedOrder(accountId, 'a');
    const variant = order.intentId.toUpperCase();
    expect(variant).not.toBe(order.intentId);
    const leaseId = await insertLease(bound(order, { intentId: variant }));
    const load = await new PrismaPracticalSafetyRepository(prisma).loadLease(leaseId);
    // The durable value is the variant, NOT the order's exact intent id: an exact comparison refuses it.
    expect(load.kind === 'FOUND' && load.record.orderBinding?.intentId).toBe(variant);
    expect(load.kind === 'FOUND' && load.record.orderBinding?.intentId === order.intentId).toBe(false);
  });

  it('at most one lease per Phase 17 cancel claim: UNIQUE (intent_id, cancel_generation)', async () => {
    if (skip()) return;
    const accountId = await seedAccount();
    const order = await seedOrder(accountId, 'a');
    const generation = nextGeneration();
    await insertLease(bound(order, { cancelGeneration: generation }));
    await expect(insertLease(bound(order, { cancelGeneration: generation }))).rejects.toThrow(/live_practical_mutation_lease_intent_cancel_key/);
    await insertLease(bound(order, { cancelGeneration: nextGeneration() }));
  });
});

describe('P18B-1B2-W1-DB the database enforces the closed lease shape', () => {
  it('OPEN and CLOSE can never be order-bound', async () => {
    if (skip()) return;
    const accountId = await seedAccount();
    const order = await seedOrder(accountId, 'a');
    for (const action of ['OPEN', 'CLOSE']) {
      await expect(insertLease(bound(order, { action })), action).rejects.toThrow(CHECK_VIOLATION('live_practical_mutation_lease_bound_action_chk'));
    }
  });

  it('a partial binding is refused (every combination)', async () => {
    if (skip()) return;
    const accountId = await seedAccount();
    const order = await seedOrder(accountId, 'a');
    for (const partial of [
      { intentId: null }, { clientOrderId: null }, { cancelGeneration: null },
      { intentId: null, clientOrderId: null }, { intentId: null, cancelGeneration: null }, { clientOrderId: null, cancelGeneration: null },
    ]) {
      await expect(insertLease(bound(order, partial)), JSON.stringify(partial)).rejects.toThrow(CHECK_VIOLATION('live_practical_mutation_lease_binding_chk'));
    }
  });

  it('cancel_generation < 1 is refused', async () => {
    if (skip()) return;
    const accountId = await seedAccount();
    const order = await seedOrder(accountId, 'a');
    for (const cancelGeneration of [0, -1]) {
      await expect(insertLease(bound(order, { cancelGeneration })), String(cancelGeneration)).rejects.toThrow(CHECK_VIOLATION('live_practical_mutation_lease_cancel_generation_chk'));
    }
  });

  it('an UNBOUND Stage 1B1 lease can never be armed (on insert or by update)', async () => {
    if (skip()) return;
    const accountId = await seedAccount();
    await expect(insertLease({ accountId, armedAtMs: T0 + 20 })).rejects.toThrow(CHECK_VIOLATION('live_practical_mutation_lease_armed_bound_chk'));
    const leaseId = await insertLease({ accountId });
    await expect(prisma.$executeRaw`UPDATE live_practical_mutation_lease SET armed_at_ms = ${BigInt(T0 + 20)} WHERE lease_id = ${leaseId}`)
      .rejects.toThrow(CHECK_VIOLATION('live_practical_mutation_lease_armed_bound_chk'));
  });

  it('armed_at_ms < created_at_ms, and completed_at_ms < armed_at_ms, are refused', async () => {
    if (skip()) return;
    const accountId = await seedAccount();
    const order = await seedOrder(accountId, 'a');
    await expect(insertLease(bound(order, { createdAtMs: T0 + 10, armedAtMs: T0 + 9 }))).rejects.toThrow(CHECK_VIOLATION('live_practical_mutation_lease_armed_time_chk'));
    await expect(insertLease(bound(order, { armedAtMs: T0 + 20, status: 'COMPLETED', completedAtMs: T0 + 19, outcome: 'AMBIGUOUS' })))
      .rejects.toThrow(CHECK_VIOLATION('live_practical_mutation_lease_bound_completed_time_chk'));
    await insertLease(bound(order, { createdAtMs: T0 + 10, armedAtMs: T0 + 10, status: 'COMPLETED', completedAtMs: T0 + 10, outcome: 'AMBIGUOUS' }));
  });

  it('[Wave 1.6] an order-bound completion never predates the arm, or the creation when never armed', async () => {
    if (skip()) return;
    const accountId = await seedAccount();
    const order = await seedOrder(accountId, 'a');
    const refused = CHECK_VIOLATION('live_practical_mutation_lease_bound_completed_time_chk');
    // 1. unarmed, created 100, completed 99: refused.
    await expect(insertLease(bound(order, { createdAtMs: 100, status: 'COMPLETED', completedAtMs: 99, outcome: 'PRE_DISPATCH_FAILURE' }))).rejects.toThrow(refused);
    // 2. unarmed, created 100, completed 100: accepted.
    await insertLease(bound(order, { createdAtMs: 100, status: 'COMPLETED', completedAtMs: 100, outcome: 'PRE_DISPATCH_FAILURE' }));
    // 3. armed, created 100, armed 110, completed 109: refused.
    await expect(insertLease(bound(order, { createdAtMs: 100, armedAtMs: 110, status: 'COMPLETED', completedAtMs: 109, outcome: 'AMBIGUOUS' }))).rejects.toThrow(refused);
    // 4. armed, created 100, armed 110, completed 110: accepted.
    await insertLease(bound(order, { createdAtMs: 100, armedAtMs: 110, status: 'COMPLETED', completedAtMs: 110, outcome: 'AMBIGUOUS' }));
    // Legacy UNBOUND timing semantics are unchanged: an unbound completion is not time-coupled by this migration.
    const unbound = await insertLease({ accountId, createdAtMs: 100, status: 'COMPLETED', completedAtMs: 99, outcome: 'PRE_DISPATCH_FAILURE' });
    expect(await new PrismaPracticalSafetyRepository(prisma).loadLease(unbound)).toMatchObject({ kind: 'FOUND', record: { orderBinding: null, completedAtMs: 99 } });
  });

  it('a completed UNARMED bound lease accepts ONLY PRE_DISPATCH_FAILURE', async () => {
    if (skip()) return;
    const accountId = await seedAccount();
    const order = await seedOrder(accountId, 'a');
    const completed = (outcome: string) => bound(order, { status: 'COMPLETED', completedAtMs: T0 + 30, outcome });
    await insertLease(completed('PRE_DISPATCH_FAILURE'));
    for (const outcome of ['ACCEPTED', 'REJECTED', 'AMBIGUOUS', 'DUPLICATE_CLIENT_ORDER_ID']) {
      await expect(insertLease(completed(outcome)), outcome).rejects.toThrow(CHECK_VIOLATION('live_practical_mutation_lease_bound_outcome_chk'));
    }
  });

  it('a completed ARMED bound CANCEL lease rejects DUPLICATE_CLIENT_ORDER_ID and accepts the four cancel outcomes', async () => {
    if (skip()) return;
    const accountId = await seedAccount();
    const order = await seedOrder(accountId, 'a');
    const completed = (outcome: string) => bound(order, { armedAtMs: T0 + 20, status: 'COMPLETED', completedAtMs: T0 + 30, outcome });
    await expect(insertLease(completed('DUPLICATE_CLIENT_ORDER_ID'))).rejects.toThrow(CHECK_VIOLATION('live_practical_mutation_lease_bound_outcome_chk'));
    for (const outcome of ['ACCEPTED', 'REJECTED', 'AMBIGUOUS', 'PRE_DISPATCH_FAILURE']) await insertLease(completed(outcome));
  });

  it('the legacy UNBOUND Stage 1B1 shape stays valid: unarmed, any outcome, parsed with no binding', async () => {
    if (skip()) return;
    const accountId = await seedAccount();
    const repository = new PrismaPracticalSafetyRepository(prisma);
    const leased = await insertLease({ accountId });
    expect(await repository.loadLease(leased)).toMatchObject({ kind: 'FOUND', record: { orderBinding: null, armedAtMs: null, status: 'LEASED' } });
    for (const [action, outcome] of [['CANCEL', 'ACCEPTED'], ['OPEN', 'REJECTED'], ['CLOSE', 'AMBIGUOUS'], ['CANCEL', 'DUPLICATE_CLIENT_ORDER_ID'], ['CANCEL', 'PRE_DISPATCH_FAILURE']] as const) {
      const leaseId = await insertLease({ accountId, action, status: 'COMPLETED', completedAtMs: T0 + 30, outcome });
      expect(await repository.loadLease(leaseId)).toMatchObject({ kind: 'FOUND', record: { action, outcome, orderBinding: null, armedAtMs: null } });
    }
  });
});
