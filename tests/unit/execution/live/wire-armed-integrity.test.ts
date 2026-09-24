/**
 * [F18-18] Contradictory durable wire-armed state must fail closed.
 *
 * The valid-state matrix this file proves, over BOTH durable claim owners:
 *
 *   `live_order.dispatch_wire_armed`       may be `true` ONLY while
 *     `live_order.state === 'DISPATCH_RESERVED'`.
 *   `live_order.cancel_wire_armed`         may be `true` ONLY while
 *     `live_order.cancel_state === 'CANCEL_RESERVED'`.
 *   `live_orphan_venue_order.cancel_wire_armed` may be `true` ONLY while
 *     `live_orphan_venue_order.cancel_state === 'CANCEL_CLAIMED'`.
 *
 * Every legitimate write path was audited and fixed (Wave A3) to clear the
 * flag the instant its owning state is left, so no code path here can
 * PRODUCE a row that violates the matrix. A row that violates it anyway —
 * direct SQL, a future regression, replication corruption — is read back as
 * `LIVE_DURABLE_INTEGRITY_VIOLATION`, never silently accepted or coerced,
 * exactly like a sealed-content-digest mismatch.
 *
 * NOTHING HERE TOUCHES COINDCX. `FakeOrderGateway` performs no I/O; it exists
 * only to prove the gateway is never reached for a corrupted row.
 */
import { describe, expect, it } from 'vitest';
import { LiveExecutionError } from '../../../../src/execution/live/errors';
import type { LiveExecutionIntentRecord } from '../../../../src/execution/live/intent';
import {
  LIVE_EXECUTION_TEST_TRANSACTION,
  liveExecutionIntentContentSha256,
  PrismaLiveExecutionRepository,
} from '../../../../src/execution/live/repository';
import { LiveExecutionService } from '../../../../src/execution/live/service';
import { PrismaLiveReconciliationRepository } from '../../../../src/execution/live/reconciliation/repository';
import { FakeOrderGateway, livePolicy } from './helpers';

const INTEGRITY = /LIVE_DURABLE_INTEGRITY_VIOLATION/;
const CLIENT_ORDER_ID = `p17-${'a'.repeat(32)}`;
const INTENT_ID = 'i'.repeat(64);
const ACCOUNT = 'account-live-1';
const PAIR = 'B-BTC_USDT';

type Row = Record<string, unknown>;

function intentRecord(): LiveExecutionIntentRecord {
  return {
    intentId: INTENT_ID,
    clientOrderId: CLIENT_ORDER_ID,
    wireOrderType: 'limit_order',
    quantityAdjusted: false,
    priceAdjusted: false,
    content: {
      accountId: ACCOUNT,
      pair: PAIR,
      side: 'BUY',
      action: 'OPEN',
      quantity: '0.5',
      orderType: 'LIMIT',
      price: '64000.5',
      timeInForce: 'UNSPECIFIED',
      leverage: '5',
      riskDecisionId: 'risk-1',
      admissionId: 'admission-1',
      strategyInstanceId: 'instance-1',
      strategyId: 'EMA_TREND',
      strategyVersion: '1.0.0',
      parameterHash: 'p'.repeat(64),
      liveExecutionPolicyId: 'policy-1',
      instrumentSpecSnapshotId: 'spec-1',
      authorizedNotionalInr: '2560020',
      settlementRateInrPerQuote: '80',
      positionInstanceId: null,
      positionRevision: null,
      reduceOnlyQuantity: null,
    },
    lineage: {
      researchApproval: {
        validationSubjectId: 'subject-1',
        validationPlanId: 'plan-1',
        validationSubjectResultSha256: 'r'.repeat(64),
      },
      sourceStrategyDecisionId: 'decision-1',
    },
  };
}

function intentRow(): Row {
  const record = intentRecord();
  return {
    intentId: record.intentId,
    clientOrderId: record.clientOrderId,
    contentSha256: liveExecutionIntentContentSha256(record),
    accountId: record.content.accountId,
    pair: record.content.pair,
    side: record.content.side,
    action: record.content.action,
    quantity: record.content.quantity,
    orderType: record.content.orderType,
    price: record.content.price,
    timeInForce: record.content.timeInForce,
    leverage: record.content.leverage,
    riskDecisionId: record.content.riskDecisionId,
    admissionId: record.content.admissionId,
    strategyInstanceId: record.content.strategyInstanceId,
    strategyId: record.content.strategyId,
    strategyVersion: record.content.strategyVersion,
    parameterHash: record.content.parameterHash,
    liveExecutionPolicyId: record.content.liveExecutionPolicyId,
    instrumentSpecSnapshotId: record.content.instrumentSpecSnapshotId,
    authorizedNotionalInr: record.content.authorizedNotionalInr,
    settlementRateInrPerQuote: record.content.settlementRateInrPerQuote,
    positionInstanceId: record.content.positionInstanceId,
    positionRevision: record.content.positionRevision,
    reduceOnlyQuantity: record.content.reduceOnlyQuantity,
    wireOrderType: record.wireOrderType,
    sourceStrategyDecisionId: record.lineage.sourceStrategyDecisionId,
    validationSubjectId: record.lineage.researchApproval?.validationSubjectId ?? null,
    validationPlanId: record.lineage.researchApproval?.validationPlanId ?? null,
    validationSubjectResultSha256: record.lineage.researchApproval?.validationSubjectResultSha256 ?? null,
  };
}

/** A durable `live_order` row with every immutable mirror correct, only the mutable projection varies per test. */
function orderRow(overrides: Partial<{
  readonly state: string;
  readonly cancelState: string;
  readonly dispatchWireArmed: boolean;
  readonly cancelWireArmed: boolean;
  readonly exchangeOrderId: string | null;
}>): Row {
  return {
    intentId: INTENT_ID,
    clientOrderId: CLIENT_ORDER_ID,
    accountId: ACCOUNT,
    pair: PAIR,
    state: overrides.state ?? 'CREATED',
    exchangeOrderId: overrides.exchangeOrderId ?? null,
    orderedQuantity: '0.5',
    cumulativeFilledQuantity: '0',
    remainingQuantity: '0.5',
    averageFillPrice: null,
    lastExchangeStatus: null,
    lastProviderEventTimeMs: null,
    faultCode: null,
    cancelState: overrides.cancelState ?? 'NONE',
    cancelGeneration: 0,
    cancelExchangeOrderId: null,
    cancelFaultCode: null,
    dispatchWireArmed: overrides.dispatchWireArmed ?? false,
    cancelWireArmed: overrides.cancelWireArmed ?? false,
    revision: 0,
    updatedAt: new Date(0),
  };
}

/** Minimal read-only fake: enough to exercise `readVerifiedOrder`/`toStateRecord` and nothing more. */
class IntegrityTestDb {
  public readonly [LIVE_EXECUTION_TEST_TRANSACTION] = true as const;
  public order: Row | null = null;
  public readonly orphans: Row[] = [];

  public readonly liveExecutionIntent = {
    findUnique: async () => intentRow(),
  };

  public readonly liveOrder = {
    findUnique: async ({ include }: { include?: { intent?: boolean } }) =>
      this.order === null ? null : (include?.intent === true ? { ...this.order, intent: intentRow() } : { ...this.order }),
    findMany: async () => (this.order === null ? [] : [{ ...this.order, intent: intentRow(), createdAt: new Date(0) }]),
  };

  public readonly liveOrphanVenueOrder = {
    findMany: async () => this.orphans,
  };

  public async $executeRaw(): Promise<number> { return 0; }
  public async $transaction(operations: (tx: this) => Promise<unknown>): Promise<unknown> { return operations(this); }
}

function orphanRow(overrides: Partial<{ readonly cancelState: string; readonly cancelWireArmed: boolean }>): Row {
  return {
    accountId: ACCOUNT,
    exchangeOrderId: 'stranger-1',
    pair: PAIR,
    side: 'BUY',
    venueStatus: 'open',
    orderedQuantity: '0.5',
    filledQuantity: '0',
    price: '64000.5',
    firstSeenGeneration: 1,
    lastSeenGeneration: 1,
    cancelState: overrides.cancelState ?? 'NONE',
    cancelGeneration: 0,
    cancelFaultCode: null,
    cancelWireArmed: overrides.cancelWireArmed ?? false,
    revision: 0,
  };
}

describe('F18-18 dispatchWireArmed valid-state matrix', () => {
  const valid: readonly (readonly [string, string, boolean])[] = [
    ['CREATED unarmed', 'CREATED', false],
    ['DISPATCH_RESERVED unarmed (Case A/C local-only reservation)', 'DISPATCH_RESERVED', false],
    ['DISPATCH_RESERVED armed (Case B/D wire may have been attempted)', 'DISPATCH_RESERVED', true],
    ['ACKNOWLEDGED unarmed', 'ACKNOWLEDGED', false],
    ['FILLED unarmed', 'FILLED', false],
  ];

  it.each(valid)('%s is accepted', async (_label, state, dispatchWireArmed) => {
    const db = new IntegrityTestDb();
    db.order = orderRow({ state, dispatchWireArmed });
    const repository = new PrismaLiveExecutionRepository(db as never);
    await expect(repository.load(INTENT_ID)).resolves.not.toBeNull();
  });

  const invalid: readonly string[] = [
    'CREATED', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED',
    'CANCELLED', 'REJECTED', 'SUBMISSION_AMBIGUOUS', 'RECONCILIATION_REQUIRED',
  ];

  it.each(invalid)('dispatchWireArmed=true while state=%s fails closed with a deterministic error, no live mutation', async (state) => {
    const db = new IntegrityTestDb();
    db.order = orderRow({ state, dispatchWireArmed: true });
    const repository = new PrismaLiveExecutionRepository(db as never);
    await expect(repository.load(INTENT_ID)).rejects.toThrow(INTEGRITY);

    // No reconciliation economic effect: the account-wide read used by
    // reconciliation refuses too, before any finding or commit is produced.
    await expect(repository.listAccountOrderViews(ACCOUNT)).rejects.toThrow(INTEGRITY);

    // No live mutation: a service bound to a real gateway never reaches it.
    const gateway = new FakeOrderGateway();
    const service = new LiveExecutionService({ gateway, repository, policy: livePolicy() });
    await expect(service.cancelDurable(INTENT_ID, ACCOUNT)).rejects.toThrow(INTEGRITY);
    expect(gateway.placeCallCount + gateway.cancelCallCount).toBe(0);
  });

  it('fails with the specific deterministic LIVE_DURABLE_INTEGRITY_VIOLATION code, not a generic error', async () => {
    const db = new IntegrityTestDb();
    db.order = orderRow({ state: 'CREATED', dispatchWireArmed: true });
    const repository = new PrismaLiveExecutionRepository(db as never);
    try {
      await repository.load(INTENT_ID);
      throw new Error('expected load to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LiveExecutionError);
      expect((error as LiveExecutionError).code).toBe('LIVE_DURABLE_INTEGRITY_VIOLATION');
    }
  });
});

describe('F18-18 cancelWireArmed valid-state matrix', () => {
  it('CANCEL_RESERVED armed is accepted', async () => {
    const db = new IntegrityTestDb();
    db.order = orderRow({ state: 'CANCEL_REQUESTED', exchangeOrderId: 'venue-1', cancelState: 'CANCEL_RESERVED', cancelWireArmed: true });
    const repository = new PrismaLiveExecutionRepository(db as never);
    await expect(repository.load(INTENT_ID)).resolves.not.toBeNull();
  });

  it('CANCEL_RESERVED unarmed is accepted', async () => {
    const db = new IntegrityTestDb();
    db.order = orderRow({ state: 'CANCEL_REQUESTED', exchangeOrderId: 'venue-1', cancelState: 'CANCEL_RESERVED', cancelWireArmed: false });
    const repository = new PrismaLiveExecutionRepository(db as never);
    await expect(repository.load(INTENT_ID)).resolves.not.toBeNull();
  });

  const invalidCancelStates: readonly string[] = ['NONE', 'CANCEL_ACKNOWLEDGED', 'CANCEL_AMBIGUOUS', 'CANCEL_REJECTED'];

  it.each(invalidCancelStates)('cancelWireArmed=true while cancel_state=%s fails closed with a deterministic error, no live mutation', async (cancelState) => {
    const db = new IntegrityTestDb();
    db.order = orderRow({ state: 'CANCEL_REQUESTED', exchangeOrderId: 'venue-1', cancelState, cancelWireArmed: true });
    const repository = new PrismaLiveExecutionRepository(db as never);
    await expect(repository.load(INTENT_ID)).rejects.toThrow(INTEGRITY);
    await expect(repository.listAccountOrderViews(ACCOUNT)).rejects.toThrow(INTEGRITY);

    const gateway = new FakeOrderGateway();
    const service = new LiveExecutionService({ gateway, repository, policy: livePolicy() });
    await expect(service.cancelDurable(INTENT_ID, ACCOUNT)).rejects.toThrow(INTEGRITY);
    expect(gateway.placeCallCount + gateway.cancelCallCount).toBe(0);
  });
});

describe('F18-18 orphan cancelWireArmed valid-state matrix', () => {
  it('CANCEL_CLAIMED armed is accepted', async () => {
    const db = new IntegrityTestDb();
    db.orphans.push(orphanRow({ cancelState: 'CANCEL_CLAIMED', cancelWireArmed: true }));
    const repository = new PrismaLiveReconciliationRepository(db as never);
    await expect(repository.loadOrphanOrders(ACCOUNT)).resolves.toHaveLength(1);
  });

  it('CANCEL_CLAIMED unarmed is accepted', async () => {
    const db = new IntegrityTestDb();
    db.orphans.push(orphanRow({ cancelState: 'CANCEL_CLAIMED', cancelWireArmed: false }));
    const repository = new PrismaLiveReconciliationRepository(db as never);
    await expect(repository.loadOrphanOrders(ACCOUNT)).resolves.toHaveLength(1);
  });

  const invalidOrphanCancelStates: readonly string[] = ['NONE', 'CANCEL_ACKNOWLEDGED', 'CANCEL_AMBIGUOUS', 'CANCEL_REJECTED'];

  it.each(invalidOrphanCancelStates)('cancelWireArmed=true while cancel_state=%s fails closed', async (cancelState) => {
    const db = new IntegrityTestDb();
    db.orphans.push(orphanRow({ cancelState, cancelWireArmed: true }));
    const repository = new PrismaLiveReconciliationRepository(db as never);
    await expect(repository.loadOrphanOrders(ACCOUNT)).rejects.toThrow(INTEGRITY);
  });

  it('fails with the specific deterministic LIVE_DURABLE_INTEGRITY_VIOLATION code, not a generic error', async () => {
    const db = new IntegrityTestDb();
    db.orphans.push(orphanRow({ cancelState: 'NONE', cancelWireArmed: true }));
    const repository = new PrismaLiveReconciliationRepository(db as never);
    try {
      await repository.loadOrphanOrders(ACCOUNT);
      throw new Error('expected loadOrphanOrders to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LiveExecutionError);
      expect((error as LiveExecutionError).code).toBe('LIVE_DURABLE_INTEGRITY_VIOLATION');
    }
  });
});
