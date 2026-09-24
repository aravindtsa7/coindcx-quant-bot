import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RiskAdmissionCoordinator } from '../../../src/dispatch/admission';
import { LiveExecutionAuthority } from '../../../src/execution/live/authority';
import { LiveExecutionIntent, type LiveExecutionIntentRecord } from '../../../src/execution/live/intent';
import { PrismaLiveExecutionRepository as ProductionPrismaLiveExecutionRepository } from '../../../src/execution/live/repository';
import type { CompleteCancelAttemptOutcome } from '../../../src/execution/live/repository';
import { LiveExecutionService } from '../../../src/execution/live/service';
import type { LiveOrderObservation, LiveOrderStateRecord } from '../../../src/execution/live/types';
import { newLiveRuntimeIdentity, readLiveRuntimeEpoch, type LiveRuntimeIdentity } from '../../../src/execution/live/reconciliation/barrier';
import { PrismaLiveReconciliationRepository } from '../../../src/execution/live/reconciliation/repository';
import { FakeOrderGateway, livePolicy, mintGenuineLiveOpen } from '../../unit/execution/live/helpers';

// [P17-DB] Real MySQL proof of the Phase17 idempotence guarantees, over two
// INDEPENDENT connections — not two Promises racing inside one process, and
// not a mocked client. It exercises exactly the database behaviours the
// repository's claims rest on: the unique client-order-id index, the
// conditional single-winner dispatch claim, the revision-guarded state
// commit, and the observation dedup index.
//
// NOTHING HERE TOUCHES COINDCX. There is no gateway, no transport, and no
// network call of any kind: this suite persists and races durable rows only.
//
// ACCEPTANCE SEMANTICS (identical to the Phase15 convention): by default this
// suite soft-skips when no local MySQL is reachable, so ordinary unit
// development never depends on a database being up. For real acceptance set
// REQUIRE_LIVE_EXECUTION_DB_INTEGRATION=1 (or run
// `npm run test:integration:live-execution`), under which `beforeAll` THROWS
// rather than skipping, making a false green impossible.

const STRICT = process.env['REQUIRE_LIVE_EXECUTION_DB_INTEGRATION'] === '1';
const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = `p17_live_test_${randomBytes(6).toString('hex')}`;

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

function executeShadowSql(sql: string): void {
  execFileSync('mysql', mysqlArgs(['-D', SHADOW_DB_NAME, '-e', sql]), { stdio: 'pipe', timeout: 15_000 });
}

let dbAvailable = false;
let connectionA: PrismaClient;
let connectionB: PrismaClient;

const phase17RuntimeIdentities = new Map<string, LiveRuntimeIdentity>();
const phase17Authorizations = new Map<string, Promise<unknown>>();

async function phase17ReconciliationAuthorization(client: PrismaClient, accountId: string): Promise<unknown> {
  const existingAuthorization = phase17Authorizations.get(accountId);
  if (existingAuthorization !== undefined) return existingAuthorization;
  const pending = establishPhase17ReconciliationAuthorization(client, accountId);
  phase17Authorizations.set(accountId, pending);
  try {
    return await pending;
  } catch (error) {
    phase17Authorizations.delete(accountId);
    throw error;
  }
}

async function establishPhase17ReconciliationAuthorization(client: PrismaClient, accountId: string): Promise<unknown> {
  let identity = phase17RuntimeIdentities.get(accountId);
  if (identity === undefined) {
    identity = newLiveRuntimeIdentity();
    phase17RuntimeIdentities.set(accountId, identity);
  }
  const epoch = readLiveRuntimeEpoch(identity)!;
  await client.liveReconciliationState.upsert({
    where: { accountId },
    create: {
      accountId,
      status: 'HEALTHY',
      currentGeneration: 1,
      currentRunId: `p17-test-${accountId}`.slice(0, 64),
      currentRuntimeEpoch: epoch,
      healthyGeneration: 1,
      blockingFindingCount: 0,
      revision: 1,
    },
    update: {
      status: 'HEALTHY',
      currentGeneration: 1,
      currentRunId: `p17-test-${accountId}`.slice(0, 64),
      currentRuntimeEpoch: epoch,
      healthyGeneration: 1,
      blockingFindingCount: 0,
      revision: 1,
    },
  });
  const outcome = await new PrismaLiveReconciliationRepository(client).authorizeCurrentHealthy(accountId, identity);
  if (outcome.authorization === null) throw new Error('Phase17 test fixture failed to establish reconciliation authority');
  return outcome.authorization;
}

/**
 * Phase17's real-MySQL suite predates the startup barrier. This adapter keeps
 * every old assertion on the production repository while establishing a real,
 * opaque reconciliation authority for the account before each mutation.
 */
class PrismaLiveExecutionRepository extends ProductionPrismaLiveExecutionRepository {
  readonly #client: PrismaClient;

  public constructor(client: PrismaClient) {
    super(client);
    this.#client = client;
  }

  async #accountForIntent(intentId: string): Promise<string> {
    const row = await this.#client.liveExecutionIntent.findUnique({ where: { intentId }, select: { accountId: true } });
    if (row === null) throw new Error(`Missing test intent ${intentId}`);
    return row.accountId;
  }

  public override async claimDispatch(intentId: string, authorizationOrConsume?: unknown, authorizedConsume?: () => Promise<boolean>) {
    const consume = authorizedConsume ?? (typeof authorizationOrConsume === 'function' ? authorizationOrConsume as () => Promise<boolean> : undefined);
    const authorization = await phase17ReconciliationAuthorization(this.#client, await this.#accountForIntent(intentId));
    return super.claimDispatch(intentId, authorization, consume);
  }

  // [F18-17] `LiveExecutionService.dispatch`/`cancelDurable` call `armDispatchWire`/
  // `armCancelWire` with whatever `reconciliationAuthorization` THEY themselves
  // received — never with what an overridden `claimDispatch`/`claimCancel`
  // injected internally, since that injection is opaque to the service layer.
  // Every test in this file calls `dispatch`/`cancelDurable` with no explicit
  // authorization (Phase17's real-MySQL suite predates the startup barrier), so
  // without these overrides the arm calls reach the PRODUCTION fence with
  // `undefined` and fail closed. This is a fixture gap, not a production one:
  // the two new arm methods get the exact same treatment as every other
  // overridden mutation method above and below.
  public override async armDispatchWire(intentId: string, expectedRevision: number) {
    const authorization = await phase17ReconciliationAuthorization(this.#client, await this.#accountForIntent(intentId));
    return super.armDispatchWire(intentId, expectedRevision, authorization);
  }

  public override async armCancelWire(intentId: string, expectedRevision: number) {
    const authorization = await phase17ReconciliationAuthorization(this.#client, await this.#accountForIntent(intentId));
    return super.armCancelWire(intentId, expectedRevision, authorization);
  }

  public override async commitState(next: LiveOrderStateRecord, expectedRevision: number) {
    return super.commitState(next, expectedRevision, await phase17ReconciliationAuthorization(this.#client, next.accountId));
  }

  public override async applyObservationAtomically(intentId: string, observation: LiveOrderObservation) {
    const authorization = await phase17ReconciliationAuthorization(this.#client, await this.#accountForIntent(intentId));
    return super.applyObservationAtomically(intentId, observation, authorization);
  }

  public override async claimCancel(intentId: string, trustedAccountId: string) {
    return super.claimCancel(intentId, trustedAccountId, await phase17ReconciliationAuthorization(this.#client, trustedAccountId));
  }

  public override async completeCancelAttempt(
    intentId: string,
    generation: number,
    outcome: CompleteCancelAttemptOutcome,
    faultCode: string | null,
  ) {
    const authorization = await phase17ReconciliationAuthorization(this.#client, await this.#accountForIntent(intentId));
    return super.completeCancelAttempt(intentId, generation, outcome, faultCode, authorization);
  }

  public override async markExpiredDispatchUnresolved(intentId: string, trustedAccountId: string, cutoff: Date) {
    return super.markExpiredDispatchUnresolved(
      intentId, trustedAccountId, cutoff,
      await phase17ReconciliationAuthorization(this.#client, trustedAccountId),
    );
  }
}

beforeAll(async () => {
  if (!BASE_DATABASE_URL) {
    if (STRICT) throw new Error('[P17-DB-INTEGRATION] REQUIRE_LIVE_EXECUTION_DB_INTEGRATION=1 but no DATABASE_URL is configured.');
    dbAvailable = false;
    return;
  }
  try {
    execFileSync('mysql', mysqlArgs(['-e', `CREATE DATABASE \`${SHADOW_DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      stdio: 'pipe', timeout: 90_000, shell: true, env: { ...process.env, DATABASE_URL: shadowDatabaseUrl() },
    });
    connectionA = new PrismaClient({ datasources: { db: { url: shadowDatabaseUrl() } } });
    connectionB = new PrismaClient({ datasources: { db: { url: shadowDatabaseUrl() } } });
    await connectionA.$queryRawUnsafe('SELECT 1');
    await connectionB.$queryRawUnsafe('SELECT 1');
    dbAvailable = true;
    console.log(`[P17-DB-INTEGRATION] connected to disposable shadow database "${SHADOW_DB_NAME}" via two independent connections`);
  } catch (error) {
    dbAvailable = false;
    if (STRICT) {
      throw new Error(`[P17-DB-INTEGRATION] strict mode could not provision a disposable MySQL shadow database: ${(error as Error).message}`);
    }
  }
}, 120_000);

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
  if (STRICT) throw new Error('[P17-DB-INTEGRATION] strict mode reached a test body with no database connection.');
  console.warn('P17 live-execution DB suite skipped: no reachable disposable MySQL. Set REQUIRE_LIVE_EXECUTION_DB_INTEGRATION=1 to make this hard.');
  return true;
}

let sequence = 0;
function intentRecord(overrides: Partial<LiveExecutionIntentRecord> = {}): LiveExecutionIntentRecord {
  sequence += 1;
  const suffix = sequence.toString(16).padStart(2, '0');
  return {
    intentId: `${'0'.repeat(62)}${suffix}`,
    clientOrderId: `p17-${'0'.repeat(30)}${suffix}`,
    wireOrderType: 'limit_order',
    quantityAdjusted: false,
    priceAdjusted: false,
    content: {
      accountId: 'account-live-db',
      pair: 'B-BTC_USDT',
      side: 'BUY',
      action: 'OPEN',
      quantity: '0.5',
      orderType: 'LIMIT',
      price: '64000.5',
      timeInForce: 'UNSPECIFIED',
      leverage: '5',
      riskDecisionId: 'risk-db-1',
      admissionId: `admission-db-${suffix}`,
      strategyInstanceId: 'instance-db-1',
      strategyId: 'EMA_TREND',
      strategyVersion: '1.0.0',
      parameterHash: 'p'.repeat(64),
      liveExecutionPolicyId: 'policy-db-1',
      instrumentSpecSnapshotId: 'spec-db-1',
      authorizedNotionalInr: '2560020',
      settlementRateInrPerQuote: '80',
      positionInstanceId: null,
      positionRevision: null,
      reduceOnlyQuantity: null,
    },
    lineage: {
      researchApproval: {
        validationSubjectId: 'subject-db-1',
        validationPlanId: 'plan-db-1',
        validationSubjectResultSha256: 'r'.repeat(64),
      },
      sourceStrategyDecisionId: 'decision-db-1',
    },
    ...overrides,
  };
}

function observation(clientOrderId: string, overrides: Partial<LiveOrderObservation> = {}): LiveOrderObservation {
  return {
    kind: 'ACKNOWLEDGED',
    clientOrderId,
    exchangeClientOrderId: null,
    exchangeOrderId: 'venue-db-1',
    pair: 'B-BTC_USDT',
    side: 'BUY',
    cumulativeFilledQuantity: '0',
    orderedQuantity: '0.5',
    averageFillPrice: null,
    exchangeStatus: 'open',
    providerEventTimeMs: 1_700_000_000_000,
    ...overrides,
  };
}

function closeIntentRecord(input: { accountId: string; pair: string; side: 'LONG' | 'SHORT'; positionInstanceId: string; revision: number; quantity: string }): LiveExecutionIntentRecord {
  const base = intentRecord();
  return {
    ...base,
    content: {
      ...base.content,
      accountId: input.accountId,
      pair: input.pair,
      side: input.side === 'LONG' ? 'SELL' : 'BUY',
      action: 'CLOSE',
      quantity: input.quantity,
      leverage: null,
      admissionId: null,
      authorizedNotionalInr: '8000',
      settlementRateInrPerQuote: null,
      positionInstanceId: input.positionInstanceId,
      positionRevision: input.revision,
      reduceOnlyQuantity: input.quantity,
    },
    lineage: { researchApproval: null, sourceStrategyDecisionId: base.lineage.sourceStrategyDecisionId },
  };
}

async function acknowledgedOrder(repository: PrismaLiveExecutionRepository, record: LiveExecutionIntentRecord): Promise<void> {
  await repository.ensureIntent(record);
  await repository.claimDispatch(record.intentId, async () => true);
  await repository.applyObservationAtomically(record.intentId, observation(record.clientOrderId));
}

describe('P17 real-database dispatch idempotence', () => {
  it('two independent connections racing the same dispatch claim produce exactly one winner', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repositoryA = new PrismaLiveExecutionRepository(connectionA);
    const repositoryB = new PrismaLiveExecutionRepository(connectionB);
    await repositoryA.ensureIntent(record);

    const [a, b] = await Promise.all([
      repositoryA.claimDispatch(record.intentId, async () => true),
      repositoryB.claimDispatch(record.intentId, async () => true),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['ALREADY_CLAIMED', 'CLAIMED']);

    const stored = await connectionA.liveOrder.findUnique({ where: { intentId: record.intentId } });
    expect(stored?.state).toBe('DISPATCH_RESERVED');
    expect(stored?.revision).toBe(1);
  }, 60_000);

  it('two independent connections cannot consume one admission for distinct economic intents', async () => {
    if (skip()) return;
    const first = intentRecord();
    const secondBase = intentRecord();
    const second = { ...secondBase, content: { ...secondBase.content, admissionId: first.content.admissionId, price: '63999' } };
    const repositoryA = new PrismaLiveExecutionRepository(connectionA);
    const repositoryB = new PrismaLiveExecutionRepository(connectionB);
    await Promise.all([repositoryA.ensureIntent(first), repositoryB.ensureIntent(second)]);

    const settled = await Promise.allSettled([
      repositoryA.claimDispatch(first.intentId, async () => true),
      repositoryB.claimDispatch(second.intentId, async () => true),
    ]);
    console.log('P17_ADMISSION_RACE_EVIDENCE', settled.map((result) => result.status === 'fulfilled' ? result.value.kind : String(result.reason)));
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await connectionA.liveAdmissionConsumption.count({ where: { admissionId: first.content.admissionId! } })).toBe(1);
  }, 60_000);

  it('two independent connections racing the SAME intent insert resolve to one row', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repositoryA = new PrismaLiveExecutionRepository(connectionA);
    const repositoryB = new PrismaLiveExecutionRepository(connectionB);

    const [a, b] = await Promise.all([
      repositoryA.ensureIntent(record),
      repositoryB.ensureIntent(record),
    ]);
    expect(a.intentId).toBe(record.intentId);
    expect(b.intentId).toBe(record.intentId);
    expect(await connectionA.liveExecutionIntent.count({ where: { intentId: record.intentId } })).toBe(1);
    expect(await connectionA.liveOrder.count({ where: { intentId: record.intentId } })).toBe(1);
  }, 60_000);

  it('the real UNIQUE(client_order_id) index rejects a second intent claiming the same client order id', async () => {
    if (skip()) return;
    const first = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await repository.ensureIntent(first);
    const colliding = intentRecord({ clientOrderId: first.clientOrderId });
    await expect(repository.ensureIntent(colliding)).rejects.toThrow(/LIVE_INTENT_CONFLICT/);
  }, 60_000);

  it('the revision guard rejects a state commit computed from a stale read', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repositoryA = new PrismaLiveExecutionRepository(connectionA);
    const repositoryB = new PrismaLiveExecutionRepository(connectionB);
    const created = await repositoryA.ensureIntent(record);

    const nextFromA: LiveOrderStateRecord = { ...created, state: 'DISPATCH_RESERVED', revision: created.revision + 1 };
    await repositoryA.commitState(nextFromA, created.revision);

    const nextFromB: LiveOrderStateRecord = { ...created, state: 'ACKNOWLEDGED', revision: created.revision + 1 };
    await expect(repositoryB.commitState(nextFromB, created.revision)).rejects.toThrow(/LIVE_ORDER_STATE_CONFLICT/);
  }, 60_000);

  it('the real observation dedup index makes a replayed provider event a no-op across connections', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repositoryA = new PrismaLiveExecutionRepository(connectionA);
    const repositoryB = new PrismaLiveExecutionRepository(connectionB);
    await repositoryA.ensureIntent(record);
    await repositoryA.claimDispatch(record.intentId, async () => true);

    const event = observation(record.clientOrderId);
    const results = await Promise.all([
      repositoryA.applyObservationAtomically(record.intentId, event),
      repositoryB.applyObservationAtomically(record.intentId, event),
    ]);
    expect(results.every((result) => result.state === 'ACKNOWLEDGED')).toBe(true);
    expect(await connectionA.liveOrderEvent.count({ where: { intentId: record.intentId } })).toBe(1);
  }, 60_000);

  it('reads every economic column back as an exact decimal string', async () => {
    if (skip()) return;
    const record = intentRecord({
      content: { ...intentRecord().content, quantity: '0.123456789012345678', price: '64000.000000000000000001' },
    });
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await repository.ensureIntent(record);
    const loaded = await repository.load(record.intentId);
    expect(loaded?.orderedQuantity).toBe('0.123456789012345678');
    // Prisma renders an exact zero DECIMAL(36,18) as "0"; the repository passes
    // the venue's exact lexeme through without re-scaling it.
    expect(loaded?.cumulativeFilledQuantity).toBe('0');
    const storedIntent = await connectionA.liveExecutionIntent.findUnique({ where: { intentId: record.intentId } });
    expect(storedIntent?.price?.toFixed()).toBe('64000.000000000000000001');
  }, 60_000);

  it.each(['LONG', 'SHORT'] as const)('dispatches an exact %s reduction only against the matching durable position revision', async (side) => {
    if (skip()) return;
    const accountId = `account-close-${side.toLowerCase()}`;
    const pair = side === 'LONG' ? 'B-SOL_USDT' : 'B-ETH_USDT';
    const positionInstanceId = `position-${side.toLowerCase()}`;
    const record = closeIntentRecord({ accountId, pair, side, positionInstanceId, revision: 4, quantity: '10' });
    await connectionA.livePosition.create({ data: {
      accountId, pair, positionInstanceId, revision: 4, side, quantity: '10', instrumentSpecSnapshotId: record.content.instrumentSpecSnapshotId,
      ownerStrategyInstanceId: record.content.strategyInstanceId, ownerStrategyId: record.content.strategyId,
      ownerStrategyVersion: record.content.strategyVersion, ownerParameterHash: record.content.parameterHash,
    } });
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await repository.ensureIntent(record);
    await expect(repository.claimDispatch(record.intentId)).resolves.toMatchObject({ kind: 'CLAIMED' });
  }, 60_000);

  it('rejects stale CLOSE revisions and a 999-unit reduction against a durable 10-unit position', async () => {
    if (skip()) return;
    const accountId = 'account-close-adversarial';
    const pair = 'B-BTC_USDT';
    const positionInstanceId = 'position-adversarial';
    const stale = closeIntentRecord({ accountId, pair, side: 'LONG', positionInstanceId, revision: 6, quantity: '10' });
    await connectionA.livePosition.create({ data: {
      accountId, pair, positionInstanceId, revision: 7, side: 'LONG', quantity: '10', instrumentSpecSnapshotId: stale.content.instrumentSpecSnapshotId,
      ownerStrategyInstanceId: stale.content.strategyInstanceId, ownerStrategyId: stale.content.strategyId,
      ownerStrategyVersion: stale.content.strategyVersion, ownerParameterHash: stale.content.parameterHash,
    } });
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await repository.ensureIntent(stale);
    await expect(repository.claimDispatch(stale.intentId)).rejects.toThrow(/stale|exposure-reducing/i);

    const oversized = closeIntentRecord({ accountId, pair, side: 'LONG', positionInstanceId, revision: 7, quantity: '999' });
    await repository.ensureIntent(oversized);
    await expect(repository.claimDispatch(oversized.intentId)).rejects.toThrow(/exposure-reducing/i);
  }, 60_000);
});

describe('P17 Wave C atomic observation application', () => {
  it('rolls back the event when projection update fails, then another connection replays the fill exactly once', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repositoryA = new PrismaLiveExecutionRepository(connectionA);
    const repositoryB = new PrismaLiveExecutionRepository(connectionB);
    await acknowledgedOrder(repositoryA, record);
    const fill = observation(record.clientOrderId, {
      kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '0.2', averageFillPrice: '64001', exchangeStatus: 'partially_filled', providerEventTimeMs: 1_700_000_001_000,
    });
    const trigger = `p17_projection_fail_${sequence}`;
    executeShadowSql(`CREATE TRIGGER \`${trigger}\` BEFORE UPDATE ON live_order FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced projection failure'`);
    try {
      await expect(repositoryA.applyObservationAtomically(record.intentId, fill)).rejects.toThrow(/forced projection failure/i);
      expect(await connectionA.liveOrderEvent.count({ where: { intentId: record.intentId } })).toBe(1);
      expect((await repositoryA.load(record.intentId))?.cumulativeFilledQuantity).toBe('0');
    } finally {
      executeShadowSql(`DROP TRIGGER IF EXISTS \`${trigger}\``);
    }
    const replayed = await repositoryB.applyObservationAtomically(record.intentId, fill);
    expect(replayed.cumulativeFilledQuantity).toBe('0.2');
    expect(await connectionA.liveOrderEvent.count({ where: { intentId: record.intentId } })).toBe(2);
    expect((await repositoryA.load(record.intentId))?.cumulativeFilledQuantity).toBe('0.2');
  }, 60_000);

  it('rejects invalid provider data without inserting an accepted event', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await acknowledgedOrder(repository, record);
    const before = await connectionA.liveOrderEvent.count({ where: { intentId: record.intentId } });
    await expect(repository.applyObservationAtomically(record.intentId, observation(record.clientOrderId, {
      exchangeOrderId: 'different-order', providerEventTimeMs: 1_700_000_001_000,
    }))).rejects.toThrow(/LIVE_ORDER_IDENTITY_MISMATCH/);
    expect(await connectionA.liveOrderEvent.count({ where: { intentId: record.intentId } })).toBe(before);
  }, 60_000);

  it('serializes concurrent identical observations across independent connections to one financial effect', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repositoryA = new PrismaLiveExecutionRepository(connectionA);
    const repositoryB = new PrismaLiveExecutionRepository(connectionB);
    await acknowledgedOrder(repositoryA, record);
    const fill = observation(record.clientOrderId, {
      kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '0.25', averageFillPrice: '64002', exchangeStatus: 'partially_filled', providerEventTimeMs: 1_700_000_001_000,
    });
    const [a, b] = await Promise.all([
      repositoryA.applyObservationAtomically(record.intentId, fill),
      repositoryB.applyObservationAtomically(record.intentId, fill),
    ]);
    expect(a.cumulativeFilledQuantity).toBe('0.25');
    expect(b.cumulativeFilledQuantity).toBe('0.25');
    expect(await connectionA.liveOrderEvent.count({ where: { intentId: record.intentId } })).toBe(2);
    expect((await repositoryA.applyObservationAtomically(record.intentId, fill)).cumulativeFilledQuantity).toBe('0.25');
    expect(await connectionA.liveOrderEvent.count({ where: { intentId: record.intentId } })).toBe(2);
  }, 60_000);
});

describe('P17 Wave C durable cancellation claim', () => {
  it('allows a fresh service instance to cancel an acknowledged durable order', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await acknowledgedOrder(repository, record);
    const gateway = new FakeOrderGateway().queueCancel({ kind: 'CANCEL_ACCEPTED', observation: observation(record.clientOrderId, {
      kind: 'CANCELLED', exchangeStatus: 'cancelled', providerEventTimeMs: 1_700_000_002_000,
    }) });
    const restarted = new LiveExecutionService({ gateway, repository: new PrismaLiveExecutionRepository(connectionB), policy: livePolicy() });
    const outcome = await restarted.cancelDurable(record.intentId, record.content.accountId);
    expect(outcome.kind).toBe('CANCELLED');
    expect(gateway.cancelCallCount).toBe(1);
    expect((await repository.load(record.intentId))?.cancelState).toBe('CANCEL_ACKNOWLEDGED');
    const duplicateGateway = new FakeOrderGateway();
    const duplicateRuntime = new LiveExecutionService({ gateway: duplicateGateway, repository: new PrismaLiveExecutionRepository(connectionA), policy: livePolicy() });
    expect((await duplicateRuntime.cancelDurable(record.intentId, record.content.accountId)).kind).toBe('NOT_CANCELLABLE');
    expect(duplicateGateway.cancelCallCount).toBe(0);
  }, 60_000);

  it('cancels a partially-filled durable order after service restart', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await acknowledgedOrder(repository, record);
    await repository.applyObservationAtomically(record.intentId, observation(record.clientOrderId, {
      kind: 'PARTIAL_FILL', cumulativeFilledQuantity: '0.1', averageFillPrice: '64001', exchangeStatus: 'partially_filled', providerEventTimeMs: 1_700_000_001_000,
    }));
    const gateway = new FakeOrderGateway().queueCancel({ kind: 'CANCEL_ACCEPTED', observation: observation(record.clientOrderId, {
      kind: 'CANCELLED', cumulativeFilledQuantity: '0.1', averageFillPrice: '64001', exchangeStatus: 'partially_cancelled', providerEventTimeMs: 1_700_000_002_000,
    }) });
    const restarted = new LiveExecutionService({ gateway, repository: new PrismaLiveExecutionRepository(connectionB), policy: livePolicy() });
    const outcome = await restarted.cancelDurable(record.intentId, record.content.accountId);
    expect(outcome.order.state).toBe('CANCELLED');
    expect(outcome.order.cumulativeFilledQuantity).toBe('0.1');
    expect(gateway.cancelCallCount).toBe(1);
  }, 60_000);

  it('gives exactly one of two independent cancel callers the wire mutation', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repositoryA = new PrismaLiveExecutionRepository(connectionA);
    const repositoryB = new PrismaLiveExecutionRepository(connectionB);
    await acknowledgedOrder(repositoryA, record);
    const gateway = new FakeOrderGateway().queueCancel({ kind: 'CANCEL_ACCEPTED', observation: observation(record.clientOrderId, {
      kind: 'CANCELLED', exchangeStatus: 'cancelled', providerEventTimeMs: 1_700_000_002_000,
    }) });
    const serviceA = new LiveExecutionService({ gateway, repository: repositoryA, policy: livePolicy() });
    const serviceB = new LiveExecutionService({ gateway, repository: repositoryB, policy: livePolicy() });
    const settled = await Promise.all([serviceA.cancelDurable(record.intentId, record.content.accountId), serviceB.cancelDurable(record.intentId, record.content.accountId)]);
    expect(gateway.cancelCallCount).toBe(1);
    expect(settled.some((result) => result.kind === 'CANCELLED')).toBe(true);
    expect((await repositoryA.load(record.intentId))?.state).toBe('CANCELLED');
  }, 60_000);

  it('persists ambiguous cancellation ownership across restart and never resends', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repositoryA = new PrismaLiveExecutionRepository(connectionA);
    await acknowledgedOrder(repositoryA, record);
    const gatewayA = new FakeOrderGateway().queueCancel({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const first = new LiveExecutionService({ gateway: gatewayA, repository: repositoryA, policy: livePolicy() });
    expect((await first.cancelDurable(record.intentId, record.content.accountId)).kind).toBe('AMBIGUOUS');
    const gatewayB = new FakeOrderGateway();
    const restarted = new LiveExecutionService({ gateway: gatewayB, repository: new PrismaLiveExecutionRepository(connectionB), policy: livePolicy() });
    expect((await restarted.cancelDurable(record.intentId, record.content.accountId)).kind).toBe('AMBIGUOUS');
    expect(gatewayA.cancelCallCount).toBe(1);
    expect(gatewayB.cancelCallCount).toBe(0);
  }, 60_000);

  it('turns an expired stranded reservation into explicit non-dispatchable ambiguity', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await repository.ensureIntent(record);
    await repository.claimDispatch(record.intentId, async () => true);
    await connectionA.liveOrder.update({ where: { intentId: record.intentId }, data: { updatedAt: new Date(0) } });
    const resolved = await repository.markExpiredDispatchUnresolved(record.intentId, record.content.accountId, new Date());
    expect(resolved.state).toBe('SUBMISSION_AMBIGUOUS');
    expect((await repository.claimDispatch(record.intentId, async () => true)).kind).toBe('ALREADY_CLAIMED');
  }, 60_000);
});

describe('P17 Wave C canonical stored-intent integrity', () => {
  it.each([
    ['leverage', { leverage: '999' }],
    ['order type', { orderType: 'MARKET' }],
    ['time in force', { timeInForce: 'FILL_OR_KILL' }],
    ['strategy tuple', { strategyId: 'TAMPERED_STRATEGY' }],
    ['quantity', { quantity: '0.4' }],
    ['price', { price: '64001' }],
  ] as const)('rejects a stored %s alteration even when the persisted digest is left untouched', async (_label, data) => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await repository.ensureIntent(record);
    await connectionA.liveExecutionIntent.update({ where: { intentId: record.intentId }, data });
    // [F17-R03] A stored row that contradicts its own sealed digest is now
    // reported as durable corruption, distinct from an economics conflict
    // between two self-consistent intents.
    await expect(repository.ensureIntent(record)).rejects.toThrow(/LIVE_DURABLE_INTEGRITY_VIOLATION/);
  }, 60_000);

  it('rejects an altered CLOSE position revision', async () => {
    if (skip()) return;
    const record = closeIntentRecord({ accountId: 'digest-close-account', pair: 'B-SOL_USDT', side: 'LONG', positionInstanceId: 'digest-position', revision: 7, quantity: '10' });
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await repository.ensureIntent(record);
    await connectionA.liveExecutionIntent.update({ where: { intentId: record.intentId }, data: { positionRevision: 8 } });
    await expect(repository.ensureIntent(record)).rejects.toThrow(/LIVE_DURABLE_INTEGRITY_VIOLATION/);
  }, 60_000);

  it('treats equivalent Decimal formatting and an identical retry as idempotent', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await repository.ensureIntent(record);
    const equivalent = { ...record, content: { ...record.content, quantity: '0.5000', price: '64000.5000', leverage: '5.0' } };
    await expect(repository.ensureIntent(equivalent)).resolves.toMatchObject({ intentId: record.intentId });
    await expect(repository.ensureIntent(record)).resolves.toMatchObject({ intentId: record.intentId });
    expect(await connectionA.liveExecutionIntent.count({ where: { intentId: record.intentId } })).toBe(1);
  }, 60_000);
});

/**
 * [F17-R03] Real-MySQL proof that the digest boundary holds on EVERY
 * authoritative durable path, not just the one `ensureIntent` happens to take.
 *
 * Each case writes the tamper with a direct `UPDATE` through the SECOND
 * connection — the actual threat model, a writer with database access — and
 * then requires the path to refuse and to leave no side effect behind.
 */
describe('P17 F17-R03 uniform durable integrity on real MySQL', () => {
  const INTEGRITY = /LIVE_DURABLE_INTEGRITY_VIOLATION/;

  it('refuses a dispatch claim on a tampered intent and neither claims nor consumes', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await repository.ensureIntent(record);
    await connectionB.liveExecutionIntent.update({ where: { intentId: record.intentId }, data: { quantity: '500' } });

    let consumeCalls = 0;
    await expect(repository.claimDispatch(record.intentId, async () => { consumeCalls += 1; return true; })).rejects.toThrow(INTEGRITY);
    expect(consumeCalls).toBe(0);
    const row = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: record.intentId } });
    expect(row.state).toBe('CREATED');
    expect(await connectionB.liveAdmissionConsumption.count({ where: { intentId: record.intentId } })).toBe(0);
  }, 60_000);

  it('refuses observation folding on a tampered intent and appends no event row', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await repository.ensureIntent(record);
    await repository.claimDispatch(record.intentId, async () => true);
    await connectionB.liveExecutionIntent.update({ where: { intentId: record.intentId }, data: { side: 'SELL' } });

    await expect(repository.applyObservationAtomically(record.intentId, observation(record.clientOrderId))).rejects.toThrow(INTEGRITY);
    expect(await connectionB.liveOrderEvent.count({ where: { intentId: record.intentId } })).toBe(0);
    const row = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: record.intentId } });
    expect(row.state).toBe('DISPATCH_RESERVED');
  }, 60_000);

  it('refuses observation folding when the live_order fill envelope was widened', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await repository.ensureIntent(record);
    await repository.claimDispatch(record.intentId, async () => true);
    // Only the projection mirror is altered; the intent and its digest agree.
    await connectionB.liveOrder.update({ where: { intentId: record.intentId }, data: { orderedQuantity: '5' } });

    await expect(repository.applyObservationAtomically(record.intentId, observation(record.clientOrderId, {
      kind: 'FILL', cumulativeFilledQuantity: '5', orderedQuantity: '5', averageFillPrice: '64000', exchangeStatus: 'filled',
      providerEventTimeMs: 1_700_000_100_000,
    }))).rejects.toThrow(INTEGRITY);
    expect(await connectionB.liveOrderEvent.count({ where: { intentId: record.intentId } })).toBe(0);
  }, 60_000);

  it('refuses a cancellation claim on a tampered intent and reserves nothing', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await acknowledgedOrder(repository, record);
    await connectionB.liveExecutionIntent.update({ where: { intentId: record.intentId }, data: { price: '1' } });

    await expect(repository.claimCancel(record.intentId, record.content.accountId)).rejects.toThrow(INTEGRITY);
    const row = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: record.intentId } });
    expect(row.cancelState).toBe('NONE');
    expect(row.state).toBe('ACKNOWLEDGED');
  }, 60_000);

  it('a rewritten live_order.account_id cannot transfer cancellation ownership', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await acknowledgedOrder(repository, record);
    await connectionB.liveOrder.update({ where: { intentId: record.intentId }, data: { accountId: 'attacker-account' } });

    await expect(repository.claimCancel(record.intentId, 'attacker-account')).rejects.toThrow(INTEGRITY);
    const row = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: record.intentId } });
    expect(row.cancelState).toBe('NONE');
  }, 60_000);

  it('refuses restart recovery on a tampered intent and leaves the reservation intact', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await repository.ensureIntent(record);
    await repository.claimDispatch(record.intentId, async () => true);
    await connectionB.liveExecutionIntent.update({ where: { intentId: record.intentId }, data: { authorizedNotionalInr: '999999999' } });

    await expect(repository.markExpiredDispatchUnresolved(record.intentId, record.content.accountId, new Date(Date.now() + 60_000)))
      .rejects.toThrow(INTEGRITY);
    const row = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: record.intentId } });
    expect(row.state).toBe('DISPATCH_RESERVED');
  }, 60_000);

  it('refuses load and loadObservationIdentity on a tampered intent', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await repository.ensureIntent(record);
    await connectionB.liveExecutionIntent.update({ where: { intentId: record.intentId }, data: { leverage: '99' } });

    await expect(repository.load(record.intentId)).rejects.toThrow(INTEGRITY);
    await expect(repository.loadObservationIdentity(record.intentId)).rejects.toThrow(INTEGRITY);
  }, 60_000);

  it('refuses a CLOSE claim on a tampered intent before the position is compared', async () => {
    if (skip()) return;
    const record = closeIntentRecord({
      accountId: 'r03-close-account', pair: 'B-SOL_USDT', side: 'LONG',
      positionInstanceId: 'r03-position', revision: 4, quantity: '10',
    });
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await connectionA.livePosition.create({ data: {
      accountId: 'r03-close-account', pair: 'B-SOL_USDT', positionInstanceId: 'r03-position', revision: 4,
      side: 'LONG', quantity: '10', instrumentSpecSnapshotId: record.content.instrumentSpecSnapshotId,
      ownerStrategyInstanceId: record.content.strategyInstanceId, ownerStrategyId: record.content.strategyId,
      ownerStrategyVersion: record.content.strategyVersion, ownerParameterHash: record.content.parameterHash,
    } });
    await repository.ensureIntent(record);
    await connectionB.liveExecutionIntent.update({ where: { intentId: record.intentId }, data: { quantity: '999' } });

    await expect(repository.claimDispatch(record.intentId)).rejects.toThrow(INTEGRITY);
    const row = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: record.intentId } });
    expect(row.state).toBe('CREATED');
    const position = await connectionB.livePosition.findUniqueOrThrow({ where: { accountId_pair: { accountId: 'r03-close-account', pair: 'B-SOL_USDT' } } });
    expect(position.quantity.toFixed()).toBe('10');
  }, 60_000);

  it('still accepts the untampered path, so the refusals above are caused by the tamper', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await acknowledgedOrder(repository, record);
    await expect(repository.load(record.intentId)).resolves.toMatchObject({ state: 'ACKNOWLEDGED' });
    await expect(repository.loadObservationIdentity(record.intentId)).resolves.toMatchObject({
      intentId: record.intentId, quantity: '0.5', price: '64000.5', side: 'BUY',
    });
    await expect(repository.claimCancel(record.intentId, record.content.accountId)).resolves.toMatchObject({ kind: 'CLAIMED' });
  }, 60_000);

  it('treats a textually different but numerically equal DECIMAL as the same sealed content', async () => {
    if (skip()) return;
    // Integrity must be a canonical comparison, not a string one: a writer may
    // legitimately supply a differently-formatted literal for the identical
    // number, and DECIMAL(36,18) round-tripping must not be mistaken for
    // tampering.
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await repository.ensureIntent(record);
    await connectionB.$executeRawUnsafe(
      'UPDATE live_execution_intent SET quantity = ? WHERE intent_id = ?', '0.5000000', record.intentId,
    );
    await expect(repository.load(record.intentId)).resolves.not.toBeNull();
    await expect(repository.loadObservationIdentity(record.intentId)).resolves.toMatchObject({ quantity: '0.5' });

    // ...while a genuinely different number, one ulp away, is still refused.
    await connectionB.$executeRawUnsafe(
      'UPDATE live_execution_intent SET quantity = ? WHERE intent_id = ?', '0.500000000000000001', record.intentId,
    );
    await expect(repository.load(record.intentId)).rejects.toThrow(INTEGRITY);
  }, 60_000);
});

describe('P17 final-blocker verify-before-write on real MySQL', () => {
  const INTEGRITY = /LIVE_DURABLE_INTEGRITY_VIOLATION/;

  it.each([
    ['account mirror', 'accountId'],
    ['pair mirror', 'pair'],
    ['ordered quantity mirror', 'orderedQuantity'],
    ['client order id mirror', 'clientOrderId'],
    ['canonical intent digest', 'intentDigest'],
  ] as const)('rolls cancellation completion back completely after %s tampering', async (_label, target) => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await acknowledgedOrder(repository, record);
    const claim = await repository.claimCancel(record.intentId, record.content.accountId);
    expect(claim.kind).toBe('CLAIMED');

    switch (target) {
      case 'accountId':
        await connectionB.liveOrder.update({ where: { intentId: record.intentId }, data: { accountId: 'tampered-account' } });
        break;
      case 'pair':
        await connectionB.liveOrder.update({ where: { intentId: record.intentId }, data: { pair: 'B-ETH_USDT' } });
        break;
      case 'orderedQuantity':
        await connectionB.liveOrder.update({ where: { intentId: record.intentId }, data: { orderedQuantity: '500' } });
        break;
      case 'clientOrderId':
        await connectionB.liveOrder.update({ where: { intentId: record.intentId }, data: { clientOrderId: `p17-tampered-${record.intentId.slice(-20)}` } });
        break;
      case 'intentDigest':
        await connectionB.liveExecutionIntent.update({ where: { intentId: record.intentId }, data: { quantity: '500' } });
        break;
    }
    const before = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: record.intentId } });

    await expect(repository.completeCancelAttempt(record.intentId, claim.generation, 'AMBIGUOUS', 'PROVIDER_TIMEOUT'))
      .rejects.toThrow(INTEGRITY);

    const after = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: record.intentId } });
    expect(after.cancelState).toBe(before.cancelState);
    expect(after.revision).toBe(before.revision);
    expect(after.faultCode).toBe(before.faultCode);
    expect(after.cancelFaultCode).toBe(before.cancelFaultCode);
  }, 60_000);

  it.each([
    ['ordered quantity', 'orderedQuantity'],
    ['account', 'accountId'],
    ['pair', 'pair'],
    ['client order id', 'clientOrderId'],
  ] as const)('locks and re-verifies %s before a dispatch state transition', async (_label, target) => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await repository.ensureIntent(record);

    let releaseWriter!: () => void;
    let writerHasLock!: () => void;
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const locked = new Promise<void>((resolve) => { writerHasLock = resolve; });
    const writer = connectionB.$transaction(async (tx) => {
      switch (target) {
        case 'orderedQuantity':
          await tx.liveOrder.update({ where: { intentId: record.intentId }, data: { orderedQuantity: '500' } });
          break;
        case 'accountId':
          await tx.liveOrder.update({ where: { intentId: record.intentId }, data: { accountId: 'tampered-account' } });
          break;
        case 'pair':
          await tx.liveOrder.update({ where: { intentId: record.intentId }, data: { pair: 'B-ETH_USDT' } });
          break;
        case 'clientOrderId':
          await tx.liveOrder.update({ where: { intentId: record.intentId }, data: { clientOrderId: `p17-race-${record.intentId.slice(-24)}` } });
          break;
      }
      writerHasLock();
      await writerGate;
    });
    await locked;
    let consumeCalls = 0;
    const claimAttempt = repository.claimDispatch(record.intentId, async () => { consumeCalls += 1; return true; });
    await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
    releaseWriter();
    await writer;

    await expect(claimAttempt).rejects.toThrow(INTEGRITY);
    expect(consumeCalls).toBe(0);
    const after = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: record.intentId } });
    expect(after.state).toBe('CREATED');
    expect(after.revision).toBe(0);
    expect(await connectionB.liveAdmissionConsumption.count({ where: { intentId: record.intentId } })).toBe(0);
  }, 60_000);

  it('commitState refuses an altered ordered quantity without changing state, revision, or fault', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await repository.ensureIntent(record);
    const claim = await repository.claimDispatch(record.intentId, async () => true);
    await connectionB.liveOrder.update({ where: { intentId: record.intentId }, data: { orderedQuantity: '500' } });
    const before = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: record.intentId } });

    await expect(repository.commitState({
      ...claim.order,
      state: 'ACKNOWLEDGED',
      exchangeOrderId: 'venue-never-committed',
      revision: claim.order.revision + 1,
    }, claim.order.revision)).rejects.toThrow(INTEGRITY);

    const after = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: record.intentId } });
    expect(after.state).toBe(before.state);
    expect(after.revision).toBe(before.revision);
    expect(after.faultCode).toBe(before.faultCode);
    expect(after.exchangeOrderId).toBe(before.exchangeOrderId);
  }, 60_000);

  it('untampered dispatch and state commit still succeed through the locked path', async () => {
    if (skip()) return;
    const record = intentRecord();
    const repository = new PrismaLiveExecutionRepository(connectionA);
    await repository.ensureIntent(record);
    const claim = await repository.claimDispatch(record.intentId, async () => true);
    await expect(repository.commitState({
      ...claim.order,
      state: 'ACKNOWLEDGED',
      exchangeOrderId: 'venue-normal-flow',
      revision: claim.order.revision + 1,
    }, claim.order.revision)).resolves.toMatchObject({ state: 'ACKNOWLEDGED', exchangeOrderId: 'venue-normal-flow' });
  }, 60_000);
});

describe('P17 final-blocker current admission validity on real MySQL', () => {
  it('rejects concurrent same-intent retries after release despite durable consumption', async () => {
    if (skip()) return;
    const coordinator = new RiskAdmissionCoordinator();
    const minted = await mintGenuineLiveOpen({ coordinator });
    const record = LiveExecutionIntent.read(minted.intent);
    const authority = LiveExecutionAuthority.read(minted.authority);
    if (record === null || authority?.admission === null || authority?.admission === undefined) throw new Error('fixture');
    const firstGateway = new FakeOrderGateway().queuePlace({ kind: 'PRE_DISPATCH_FAILURE', reasonCode: 'CONNECT_REFUSED' });
    const firstService = new LiveExecutionService({
      gateway: firstGateway,
      repository: new PrismaLiveExecutionRepository(connectionA),
      policy: livePolicy(),
    });

    await expect(firstService.dispatch(minted.authority, minted.intent)).rejects.toThrow(/LIVE_PROVIDER_ERROR/);
    expect(firstGateway.placeCallCount).toBe(1);
    expect((await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: record.intentId } })).state).toBe('CREATED');
    expect(await connectionB.liveAdmissionConsumption.count({ where: { intentId: record.intentId } })).toBe(1);
    await coordinator.release(record.content.accountId, authority.admission.admissionId);

    const retryGateway = new FakeOrderGateway();
    const retryA = new LiveExecutionService({ gateway: retryGateway, repository: new PrismaLiveExecutionRepository(connectionA), policy: livePolicy() });
    const retryB = new LiveExecutionService({ gateway: retryGateway, repository: new PrismaLiveExecutionRepository(connectionB), policy: livePolicy() });
    const retries = await Promise.allSettled([
      retryA.dispatch(minted.authority, minted.intent),
      retryB.dispatch(minted.authority, minted.intent),
    ]);

    expect(retries.every((result) => result.status === 'rejected')).toBe(true);
    expect(retryGateway.placeCallCount).toBe(0);
    const after = await connectionB.liveOrder.findUniqueOrThrow({ where: { intentId: record.intentId } });
    expect(after.state).toBe('CREATED');
    expect(await connectionB.liveAdmissionConsumption.count({ where: { intentId: record.intentId } })).toBe(1);
  }, 60_000);
});
