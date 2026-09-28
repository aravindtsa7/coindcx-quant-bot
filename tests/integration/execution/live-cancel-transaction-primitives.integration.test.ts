import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveExecutionIntentRecord } from '../../../src/execution/live/intent';
import {
  PrismaLiveExecutionRepository,
  armCancelWireWithinCallerFencedTransaction,
  claimCancelWithinCallerFencedTransaction,
  completeCancelAttemptWithinCallerFencedTransaction,
} from '../../../src/execution/live/repository';
import { newLiveRuntimeIdentity, readLiveRuntimeEpoch, requireCurrentReconciliation, type LiveRuntimeIdentity } from '../../../src/execution/live/reconciliation/barrier';
import { LiveReconciliationAuthorization, PrismaLiveReconciliationRepository } from '../../../src/execution/live/reconciliation/repository';

// [P18B-1B2-W2A-DB] Real MySQL proof of the Wave 2A extraction:
//
//   - the three transaction-scoped Phase17 CANCEL primitives reproduce the
//     pre-extraction claim / arm / completion semantics exactly, and compose
//     inside ONE caller-owned transaction that rolls back as a whole;
//   - the PUBLIC strict Tier-A methods still refuse without a genuine, current
//     HEALTHY reconciliation authorization, BEFORE any row changes, and still
//     work with one;
//   - the strict Phase 18 barrier still refuses with ACCOUNT_CONTINUITY_NOT_PROVEN.
//
// The primitives are called directly here for isolated persistence
// verification only; in src/ nothing imports them (architecture-pinned).
//
// NOTHING HERE TOUCHES COINDCX: no gateway, transport, signer, or network.
//
// ACCEPTANCE SEMANTICS (the Phase 17/18 convention): soft-skips without a
// reachable local MySQL; with REQUIRE_LIVE_CANCEL_PRIMITIVES_DB_INTEGRATION=1
// `beforeAll` THROWS instead. It always uses its own disposable database,
// dropped afterwards.

const STRICT = process.env['REQUIRE_LIVE_CANCEL_PRIMITIVES_DB_INTEGRATION'] === '1';
const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = `p18b_cancel_tx_test_${randomBytes(6).toString('hex')}`;

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
let connectionA: PrismaClient;
let connectionB: PrismaClient;

beforeAll(async () => {
  if (!BASE_DATABASE_URL) {
    if (STRICT) throw new Error('[P18B-W2A-DB] REQUIRE_LIVE_CANCEL_PRIMITIVES_DB_INTEGRATION=1 but no DATABASE_URL is configured.');
    return;
  }
  try {
    execFileSync('mysql', mysqlArgs(['-e', `CREATE DATABASE \`${SHADOW_DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      stdio: 'pipe', timeout: 120_000, shell: true, env: { ...process.env, DATABASE_URL: shadowDatabaseUrl() },
    });
    connectionA = new PrismaClient({ datasources: { db: { url: shadowDatabaseUrl() } } });
    connectionB = new PrismaClient({ datasources: { db: { url: shadowDatabaseUrl() } } });
    await connectionA.$queryRawUnsafe('SELECT 1');
    await connectionB.$queryRawUnsafe('SELECT 1');
    dbAvailable = true;
  } catch (error) {
    dbAvailable = false;
    if (STRICT) throw new Error(`[P18B-W2A-DB] strict mode could not provision a disposable MySQL database: ${(error as Error).name}`);
  }
}, 180_000);

afterAll(async () => {
  if (!dbAvailable) return;
  await connectionA.$disconnect();
  await connectionB.$disconnect();
  try {
    execFileSync('mysql', mysqlArgs(['-e', `DROP DATABASE IF EXISTS \`${SHADOW_DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
  } catch { /* best-effort cleanup only */ }
}, 30_000);

function skip(): boolean {
  if (dbAvailable) return false;
  if (STRICT) throw new Error('[P18B-W2A-DB] strict mode reached a test body with no database connection.');
  console.warn('P18B Wave 2A cancel-primitive DB suite skipped: no reachable disposable MySQL. Set REQUIRE_LIVE_CANCEL_PRIMITIVES_DB_INTEGRATION=1 to make this hard.');
  return true;
}

// ---------------------------------------------------------------------------
// Fixtures (a genuinely sealed Phase17 intent, stored through ensureIntent)
// ---------------------------------------------------------------------------

let sequence = 0;
function intentRecord(accountId: string): LiveExecutionIntentRecord {
  sequence += 1;
  const tag = `${randomBytes(4).toString('hex')}${sequence.toString(16).padStart(4, '0')}`;
  return {
    intentId: `${'0'.repeat(52)}${tag}`,
    clientOrderId: `p17-${'0'.repeat(20)}${tag}`,
    wireOrderType: 'limit_order',
    quantityAdjusted: false,
    priceAdjusted: false,
    content: {
      accountId,
      pair: 'B-BTC_USDT',
      side: 'BUY',
      action: 'OPEN',
      quantity: '0.5',
      orderType: 'LIMIT',
      price: '64000.5',
      timeInForce: 'UNSPECIFIED',
      leverage: '5',
      riskDecisionId: 'risk-w2a-1',
      admissionId: `admission-w2a-${tag}`,
      strategyInstanceId: 'instance-w2a-1',
      strategyId: 'EMA_TREND',
      strategyVersion: '1.0.0',
      parameterHash: 'p'.repeat(64),
      liveExecutionPolicyId: 'policy-w2a-1',
      instrumentSpecSnapshotId: 'spec-w2a-1',
      authorizedNotionalInr: '2560020',
      settlementRateInrPerQuote: '80',
      positionInstanceId: null,
      positionRevision: null,
      reduceOnlyQuantity: null,
    },
    lineage: {
      researchApproval: { validationSubjectId: 'subject-w2a-1', validationPlanId: 'plan-w2a-1', validationSubjectResultSha256: 'r'.repeat(64) },
      sourceStrategyDecisionId: 'decision-w2a-1',
    },
  };
}

function freshAccount(): string {
  return `w2a-acct-${randomBytes(4).toString('hex')}`;
}

/**
 * A sealed intent stored through the production ensureIntent (unfenced by design), then its MUTABLE
 * projection columns set to an acknowledged venue order (fixture only; the sealed intent and the
 * immutable mirrors are untouched, so every verified read still passes).
 */
async function seedOrder(
  accountId: string,
  projection: { readonly state?: 'ACKNOWLEDGED' | 'CREATED' | 'FILLED'; readonly exchangeOrderId?: string | null } = {},
): Promise<LiveExecutionIntentRecord> {
  const record = intentRecord(accountId);
  await new PrismaLiveExecutionRepository(connectionA).ensureIntent(record);
  const state = projection.state ?? 'ACKNOWLEDGED';
  if (state !== 'CREATED') {
    await connectionA.liveOrder.update({ where: { intentId: record.intentId }, data: {
      state,
      exchangeOrderId: projection.exchangeOrderId === undefined ? `venue-${randomBytes(4).toString('hex')}` : projection.exchangeOrderId,
      revision: 2,
    } });
  }
  return record;
}

async function orderRow(intentId: string) {
  const row = await connectionA.liveOrder.findUnique({ where: { intentId } });
  if (row === null) throw new Error(`missing order ${intentId}`);
  return row;
}

/** A genuine, current HEALTHY strict authorization for `accountId` (fixture: seeds a HEALTHY state row). */
async function strictAuthorization(accountId: string, identity: LiveRuntimeIdentity = newLiveRuntimeIdentity()): Promise<unknown> {
  const epoch = readLiveRuntimeEpoch(identity)!;
  const state = {
    status: 'HEALTHY' as const, currentGeneration: 1, currentRunId: `w2a-run-${accountId}`.slice(0, 64), currentRuntimeEpoch: epoch,
    healthyGeneration: 1, blockingFindingCount: 0, revision: 1,
  };
  await connectionA.liveReconciliationState.upsert({ where: { accountId }, create: { accountId, ...state }, update: state });
  const outcome = await new PrismaLiveReconciliationRepository(connectionA).authorizeCurrentHealthy(accountId, identity);
  if (outcome.authorization === null) throw new Error('fixture failed to establish strict authority');
  return outcome.authorization;
}

type Tx = Parameters<typeof claimCancelWithinCallerFencedTransaction>[0];

/** Runs `work` inside ONE caller-owned interactive transaction (the composition a future adapter will own). */
function inTransaction<T>(client: PrismaClient, work: (tx: Tx) => Promise<T>): Promise<T> {
  return client.$transaction((tx) => work(tx));
}

class InjectedRollback extends Error {}

// ---------------------------------------------------------------------------
// The PUBLIC strict Tier-A wrappers are unchanged
// ---------------------------------------------------------------------------

describe('P18B-W2A-DB the public strict methods still require genuine current HEALTHY reconciliation authority', () => {
  it('claimCancel refuses a missing, structural, or superseded authorization BEFORE any row changes', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const record = await seedOrder(accountId);
    const repository = new PrismaLiveExecutionRepository(connectionA);
    const authorization = await strictAuthorization(accountId);
    const before = await orderRow(record.intentId);
    await expect(repository.claimCancel(record.intentId, accountId)).rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED' });
    await expect(repository.claimCancel(record.intentId, accountId, { ...LiveReconciliationAuthorization.read(authorization) })).rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED' });
    await expect(repository.claimCancel(record.intentId, accountId, Object.create(LiveReconciliationAuthorization.prototype))).rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED' });
    // A genuine authorization for ANOTHER account is refused by the fence itself.
    await expect(repository.claimCancel(record.intentId, accountId, await strictAuthorization(freshAccount()))).rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED' });
    // A genuine authorization whose generation was superseded is fenced out.
    await connectionA.liveReconciliationState.update({ where: { accountId }, data: { currentGeneration: 2, status: 'RUNNING' } });
    await expect(repository.claimCancel(record.intentId, accountId, authorization)).rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_STALE_GENERATION' });
    const after = await orderRow(record.intentId);
    expect({ revision: after.revision, cancelState: after.cancelState, cancelGeneration: after.cancelGeneration, state: after.state })
      .toEqual({ revision: before.revision, cancelState: before.cancelState, cancelGeneration: before.cancelGeneration, state: before.state });
  });

  it('armCancelWire and completeCancelAttempt refuse a missing, structural, or superseded authorization BEFORE any row changes', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const record = await seedOrder(accountId);
    const repository = new PrismaLiveExecutionRepository(connectionA);
    const authorization = await strictAuthorization(accountId);
    const claim = await repository.claimCancel(record.intentId, accountId, authorization);
    expect(claim.kind).toBe('CLAIMED');
    const before = await orderRow(record.intentId);
    const forged = { ...LiveReconciliationAuthorization.read(authorization) };
    for (const refused of [undefined, forged]) {
      await expect(repository.armCancelWire(record.intentId, claim.order.revision, refused)).rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED' });
      await expect(repository.completeCancelAttempt(record.intentId, claim.generation, 'ACKNOWLEDGED', null, refused)).rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED' });
    }
    await connectionA.liveReconciliationState.update({ where: { accountId }, data: { currentGeneration: 2, status: 'RUNNING' } });
    await expect(repository.armCancelWire(record.intentId, claim.order.revision, authorization)).rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_STALE_GENERATION' });
    await expect(repository.completeCancelAttempt(record.intentId, claim.generation, 'ACKNOWLEDGED', null, authorization)).rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_STALE_GENERATION' });
    const after = await orderRow(record.intentId);
    expect({ revision: after.revision, cancelState: after.cancelState, cancelWireArmed: after.cancelWireArmed })
      .toEqual({ revision: before.revision, cancelState: before.cancelState, cancelWireArmed: before.cancelWireArmed });
  });

  it('with a genuine current HEALTHY authorization the public claim -> arm -> complete path is unchanged', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const record = await seedOrder(accountId);
    const repository = new PrismaLiveExecutionRepository(connectionA);
    const authorization = await strictAuthorization(accountId);
    const claim = await repository.claimCancel(record.intentId, accountId, authorization);
    expect(claim).toMatchObject({ kind: 'CLAIMED', generation: 1, order: { state: 'CANCEL_REQUESTED', cancelState: 'CANCEL_RESERVED', cancelWireArmed: false, revision: 3 } });
    const armed = await repository.armCancelWire(record.intentId, claim.order.revision, authorization);
    expect(armed).toMatchObject({ cancelState: 'CANCEL_RESERVED', cancelWireArmed: true, revision: 4 });
    const done = await repository.completeCancelAttempt(record.intentId, claim.generation, 'ACKNOWLEDGED', null, authorization);
    expect(done).toMatchObject({ cancelState: 'CANCEL_ACKNOWLEDGED', cancelWireArmed: false, revision: 5 });
    // The arm's account binding still comes from the fence: another account's genuine authority is refused.
    const other = await seedOrder(accountId);
    const otherClaim = await repository.claimCancel(other.intentId, accountId, authorization);
    await expect(repository.armCancelWire(other.intentId, otherClaim.order.revision, await strictAuthorization(freshAccount())))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED' });
  });

  it('the strict Phase 18 barrier still refuses a HEALTHY account with ACCOUNT_CONTINUITY_NOT_PROVEN', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const identity = newLiveRuntimeIdentity();
    await strictAuthorization(accountId, identity);
    await expect(requireCurrentReconciliation(new PrismaLiveReconciliationRepository(connectionA), accountId, identity, 'CANCEL'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
  });
});

// ---------------------------------------------------------------------------
// The transaction-scoped primitives reproduce the pre-extraction semantics
// ---------------------------------------------------------------------------

describe('P18B-W2A-DB claimCancelWithinCallerFencedTransaction', () => {
  it('CLAIMED: exactly one generation and one revision step, with the exact claim fields; then ALREADY_CLAIMED with no write', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const record = await seedOrder(accountId);
    const before = await orderRow(record.intentId);
    const claim = await inTransaction(connectionA, (tx) => claimCancelWithinCallerFencedTransaction(tx, record.intentId, accountId));
    expect(claim).toMatchObject({ kind: 'CLAIMED', generation: before.cancelGeneration + 1 });
    const after = await orderRow(record.intentId);
    expect(after).toMatchObject({
      state: 'CANCEL_REQUESTED', cancelState: 'CANCEL_RESERVED', cancelGeneration: before.cancelGeneration + 1,
      cancelExchangeOrderId: before.exchangeOrderId, cancelFaultCode: null, cancelWireArmed: false, revision: before.revision + 1,
    });
    expect(after.cancelClaimedAt).not.toBeNull();
    const again = await inTransaction(connectionA, (tx) => claimCancelWithinCallerFencedTransaction(tx, record.intentId, accountId));
    expect(again).toMatchObject({ kind: 'ALREADY_CLAIMED', generation: before.cancelGeneration + 1 });
    expect((await orderRow(record.intentId)).revision).toBe(after.revision);
  });

  it('NOT_CANCELLABLE for a non-cancellable state, with no write', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    for (const state of ['CREATED', 'FILLED'] as const) {
      const record = await seedOrder(accountId, { state });
      const before = await orderRow(record.intentId);
      const claim = await inTransaction(connectionA, (tx) => claimCancelWithinCallerFencedTransaction(tx, record.intentId, accountId));
      expect(claim, state).toMatchObject({ kind: 'NOT_CANCELLABLE', generation: before.cancelGeneration });
      expect((await orderRow(record.intentId)).revision, state).toBe(before.revision);
    }
  });

  it('refuses an account that does not own the order exactly (including a case variant), with no write', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const record = await seedOrder(accountId);
    const before = await orderRow(record.intentId);
    for (const wrong of [freshAccount(), accountId.toUpperCase(), `${accountId} `]) {
      await expect(inTransaction(connectionA, (tx) => claimCancelWithinCallerFencedTransaction(tx, record.intentId, wrong)))
        .rejects.toMatchObject({ code: 'LIVE_AUTHORITY_INVALID' });
    }
    expect((await orderRow(record.intentId)).revision).toBe(before.revision);
  });

  it('refuses an acknowledged order without an authoritative exchange order id', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const record = await seedOrder(accountId, { exchangeOrderId: null });
    await expect(inTransaction(connectionA, (tx) => claimCancelWithinCallerFencedTransaction(tx, record.intentId, accountId)))
      .rejects.toMatchObject({ code: 'LIVE_ORDER_IDENTITY_MISMATCH' });
    expect((await orderRow(record.intentId)).cancelState).toBe('NONE');
  });

  it('two independent connections racing the claim produce exactly one generation', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const record = await seedOrder(accountId);
    const before = await orderRow(record.intentId);
    const [a, b] = await Promise.all([
      inTransaction(connectionA, (tx) => claimCancelWithinCallerFencedTransaction(tx, record.intentId, accountId)),
      inTransaction(connectionB, (tx) => claimCancelWithinCallerFencedTransaction(tx, record.intentId, accountId)),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['ALREADY_CLAIMED', 'CLAIMED']);
    expect(await orderRow(record.intentId)).toMatchObject({ cancelGeneration: before.cancelGeneration + 1, revision: before.revision + 1 });
  }, 60_000);
});

describe('P18B-W2A-DB armCancelWireWithinCallerFencedTransaction', () => {
  it('arms ONLY an unarmed CANCEL_RESERVED claim at the exact revision, exactly once', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const record = await seedOrder(accountId);
    const conflict = { code: 'LIVE_ORDER_STATE_CONFLICT' };
    // Not reserved (cancelState NONE): refused.
    const unclaimed = await orderRow(record.intentId);
    await expect(inTransaction(connectionA, (tx) => armCancelWireWithinCallerFencedTransaction(tx, record.intentId, unclaimed.revision, accountId))).rejects.toMatchObject(conflict);
    const claim = await inTransaction(connectionA, (tx) => claimCancelWithinCallerFencedTransaction(tx, record.intentId, accountId));
    // Wrong expected revision: refused.
    await expect(inTransaction(connectionA, (tx) => armCancelWireWithinCallerFencedTransaction(tx, record.intentId, claim.order.revision + 1, accountId))).rejects.toMatchObject(conflict);
    // Fenced to another account: refused with the pre-existing error.
    await expect(inTransaction(connectionA, (tx) => armCancelWireWithinCallerFencedTransaction(tx, record.intentId, claim.order.revision, freshAccount())))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED' });
    const armed = await inTransaction(connectionA, (tx) => armCancelWireWithinCallerFencedTransaction(tx, record.intentId, claim.order.revision, accountId));
    expect(armed).toMatchObject({ cancelState: 'CANCEL_RESERVED', cancelWireArmed: true, revision: claim.order.revision + 1 });
    // Already armed: a second arm (same or new revision) is refused and writes nothing.
    await expect(inTransaction(connectionA, (tx) => armCancelWireWithinCallerFencedTransaction(tx, record.intentId, claim.order.revision, accountId))).rejects.toMatchObject(conflict);
    await expect(inTransaction(connectionA, (tx) => armCancelWireWithinCallerFencedTransaction(tx, record.intentId, armed.revision, accountId))).rejects.toMatchObject(conflict);
    expect((await orderRow(record.intentId)).revision).toBe(armed.revision);
  });

  it('two independent connections racing the arm: exactly one arms', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const record = await seedOrder(accountId);
    const claim = await inTransaction(connectionA, (tx) => claimCancelWithinCallerFencedTransaction(tx, record.intentId, accountId));
    const results = await Promise.allSettled([
      inTransaction(connectionA, (tx) => armCancelWireWithinCallerFencedTransaction(tx, record.intentId, claim.order.revision, accountId)),
      inTransaction(connectionB, (tx) => armCancelWireWithinCallerFencedTransaction(tx, record.intentId, claim.order.revision, accountId)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'LIVE_ORDER_STATE_CONFLICT' });
    expect(await orderRow(record.intentId)).toMatchObject({ cancelWireArmed: true, revision: claim.order.revision + 1 });
  }, 60_000);
});

describe('P18B-W2A-DB completeCancelAttemptWithinCallerFencedTransaction', () => {
  it('maps ACKNOWLEDGED / AMBIGUOUS / REJECTED exactly, clears the arm, and steps the revision once', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    for (const [outcome, cancelState, faultCode, orderFault] of [
      ['ACKNOWLEDGED', 'CANCEL_ACKNOWLEDGED', null, null],
      ['AMBIGUOUS', 'CANCEL_AMBIGUOUS', 'LIVE_CANCEL_AMBIGUOUS', 'LIVE_CANCEL_AMBIGUOUS'],
      ['REJECTED', 'CANCEL_REJECTED', 'VENUE_REFUSED', null],
    ] as const) {
      const record = await seedOrder(accountId);
      const claim = await inTransaction(connectionA, (tx) => claimCancelWithinCallerFencedTransaction(tx, record.intentId, accountId));
      const armed = await inTransaction(connectionA, (tx) => armCancelWireWithinCallerFencedTransaction(tx, record.intentId, claim.order.revision, accountId));
      const done = await inTransaction(connectionA, (tx) => completeCancelAttemptWithinCallerFencedTransaction(tx, record.intentId, claim.generation, outcome, faultCode, accountId));
      expect(done, outcome).toMatchObject({ cancelState, cancelFaultCode: faultCode, faultCode: orderFault, cancelWireArmed: false, revision: armed.revision + 1 });
      // Idempotent: the same outcome again returns the terminal state unchanged (no revision step).
      const again = await inTransaction(connectionA, (tx) => completeCancelAttemptWithinCallerFencedTransaction(tx, record.intentId, claim.generation, outcome, faultCode, accountId));
      expect(again.revision, outcome).toBe(done.revision);
      // A different outcome for the same, now terminal, claim is refused.
      const different = outcome === 'ACKNOWLEDGED' ? 'REJECTED' : 'ACKNOWLEDGED';
      await expect(inTransaction(connectionA, (tx) => completeCancelAttemptWithinCallerFencedTransaction(tx, record.intentId, claim.generation, different, null, accountId)))
        .rejects.toMatchObject({ code: 'LIVE_ORDER_STATE_CONFLICT' });
    }
  });

  it('refuses a different generation or another fenced account, with no write', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const record = await seedOrder(accountId);
    const claim = await inTransaction(connectionA, (tx) => claimCancelWithinCallerFencedTransaction(tx, record.intentId, accountId));
    for (const generation of [claim.generation + 1, claim.generation - 1]) {
      await expect(inTransaction(connectionA, (tx) => completeCancelAttemptWithinCallerFencedTransaction(tx, record.intentId, generation, 'ACKNOWLEDGED', null, accountId)))
        .rejects.toMatchObject({ code: 'LIVE_ORDER_STATE_CONFLICT' });
    }
    await expect(inTransaction(connectionA, (tx) => completeCancelAttemptWithinCallerFencedTransaction(tx, record.intentId, claim.generation, 'ACKNOWLEDGED', null, freshAccount())))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED' });
    expect(await orderRow(record.intentId)).toMatchObject({ cancelState: 'CANCEL_RESERVED', revision: claim.order.revision });
  });
});

describe('P18B-W2A-DB the primitives compose inside ONE caller-owned transaction that rolls back as a whole', () => {
  it('claim, then an injected failure before commit: the claim is rolled back', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const record = await seedOrder(accountId);
    const before = await orderRow(record.intentId);
    await expect(inTransaction(connectionA, async (tx) => {
      const claim = await claimCancelWithinCallerFencedTransaction(tx, record.intentId, accountId);
      expect(claim.kind).toBe('CLAIMED');
      throw new InjectedRollback('injected after the claim wrote, before commit');
    })).rejects.toBeInstanceOf(InjectedRollback);
    expect(await orderRow(record.intentId)).toMatchObject({ state: before.state, cancelState: 'NONE', cancelGeneration: before.cancelGeneration, revision: before.revision });
  });

  it('claim + arm in one transaction, then a failing database statement before commit: EVERYTHING is rolled back', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const record = await seedOrder(accountId);
    const before = await orderRow(record.intentId);
    await expect(inTransaction(connectionA, async (tx) => {
      const claim = await claimCancelWithinCallerFencedTransaction(tx, record.intentId, accountId);
      await armCancelWireWithinCallerFencedTransaction(tx, record.intentId, claim.order.revision, accountId);
      // A real database failure inside the same transaction (duplicate primary key).
      await tx.$executeRaw`INSERT INTO live_reconciliation_state (account_id, updated_at) VALUES (${accountId}, NOW(3))`;
      await tx.$executeRaw`INSERT INTO live_reconciliation_state (account_id, updated_at) VALUES (${accountId}, NOW(3))`;
    })).rejects.toThrow();
    expect(await orderRow(record.intentId)).toMatchObject({ cancelState: 'NONE', cancelWireArmed: false, cancelGeneration: before.cancelGeneration, revision: before.revision });
    expect(await connectionA.liveReconciliationState.findUnique({ where: { accountId } })).toBeNull();
  });

  it('claim + arm + complete in one transaction, then an injected failure: EVERYTHING is rolled back', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const record = await seedOrder(accountId);
    const before = await orderRow(record.intentId);
    await expect(inTransaction(connectionA, async (tx) => {
      const claim = await claimCancelWithinCallerFencedTransaction(tx, record.intentId, accountId);
      const armed = await armCancelWireWithinCallerFencedTransaction(tx, record.intentId, claim.order.revision, accountId);
      const done = await completeCancelAttemptWithinCallerFencedTransaction(tx, record.intentId, claim.generation, 'AMBIGUOUS', 'LIVE_CANCEL_AMBIGUOUS', accountId);
      expect(done.revision).toBe(armed.revision + 1);
      throw new InjectedRollback('injected after all three primitives wrote, before commit');
    })).rejects.toBeInstanceOf(InjectedRollback);
    expect(await orderRow(record.intentId)).toMatchObject({
      state: before.state, cancelState: 'NONE', cancelWireArmed: false, cancelGeneration: before.cancelGeneration, faultCode: null, revision: before.revision,
    });
  });
});
