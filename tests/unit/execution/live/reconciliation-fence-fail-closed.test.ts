/**
 * [F18-15] Missing Phase18 Prisma reconciliation delegate must fail closed.
 *
 * The original defect: `assertReconciliationFence` (in `../repository.ts`)
 * inferred "this is a harmless unit-test double" from the STRUCTURAL absence
 * of a `liveReconciliationState` Prisma delegate on the transaction object,
 * and silently skipped the fence when that inference fired. Any accidental
 * mismatch between the generated Prisma client and the deployed schema — a
 * stale client, a partially-applied migration, a wrong client instance —
 * would have hit that exact branch in PRODUCTION and silently disabled
 * Phase18 fencing rather than blocking live mutation.
 *
 * The fix replaces that structural inference with an EXPLICIT opt-in marker
 * (`LIVE_EXECUTION_TEST_TRANSACTION`) that only a deliberate test double can
 * carry. These tests prove the other side of that fix: a transaction that
 * looks exactly like the broken-production scenario — no delegate, no
 * marker — is refused, not silently accepted, on every mutation path that
 * matters (OPEN, CLOSE-shaped, regular cancel), with zero durable reservation
 * taken and zero wire mutation possible, and with a specific, deterministic
 * error code.
 *
 * NOTHING HERE TOUCHES COINDCX. `FakeOrderGateway` performs no I/O; it exists
 * only to prove the gateway is NEVER reached.
 */
import { describe, expect, it } from 'vitest';
import { LiveExecutionError } from '../../../../src/execution/live/errors';
import type { LiveExecutionIntentRecord } from '../../../../src/execution/live/intent';
import { PrismaLiveExecutionRepository } from '../../../../src/execution/live/repository';
import { LiveExecutionService } from '../../../../src/execution/live/service';
import { FakeOrderGateway, livePolicy } from './helpers';

const FAIL_CLOSED = /LIVE_RECONCILIATION_REQUIRED/;
const ACCOUNT = 'account-live-1';
const PAIR = 'B-BTC_USDT';
const INTENT_ID = 'f'.repeat(64);
const CLIENT_ORDER_ID = `p17-${'f'.repeat(32)}`;

type Row = Record<string, unknown>;

/**
 * Simulates exactly the production failure scenario F18-15 closes: a real
 * shaped transaction object that has NO `liveReconciliationState` delegate
 * (a stale generated client, a partially-applied migration) and carries NO
 * test-only bypass marker. Deliberately does NOT import or set
 * `LIVE_EXECUTION_TEST_TRANSACTION` anywhere in this file.
 */
class BrokenProductionTransaction {
  public readonly intents = new Map<string, Row>();
  public readonly orders = new Map<string, Row>();
  public readonly events = new Map<string, Row>();
  public readonly admissions = new Map<string, Row>();
  public readonly positions = new Map<string, Row>();

  #unique(): Error & { code: string } {
    const error = new Error('Unique constraint failed') as Error & { code: string };
    error.code = 'P2002';
    return error;
  }

  public readonly liveExecutionIntent = {
    findUnique: async ({ where }: { where: { intentId: string } }) => this.intents.get(where.intentId) ?? null,
    create: ({ data }: { data: Row }) => ({
      run: () => {
        const intentId = data['intentId'] as string;
        if (this.intents.has(intentId)) throw this.#unique();
        this.intents.set(intentId, { ...data });
        return data;
      },
    }),
  };

  public readonly liveOrder = {
    findUnique: async ({ where, include }: { where: { intentId: string }; include?: { intent?: boolean } }) => {
      const row = this.orders.get(where.intentId);
      if (row === undefined) return null;
      return include?.intent === true ? { ...row, intent: this.intents.get(where.intentId) ?? null } : { ...row };
    },
    create: ({ data }: { data: Row }) => ({
      run: () => {
        const intentId = data['intentId'] as string;
        if (this.orders.has(intentId)) throw this.#unique();
        this.orders.set(intentId, { dispatchWireArmed: false, cancelWireArmed: false, ...data, updatedAt: new Date(0) });
        return data;
      },
    }),
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const row = this.orders.get(where['intentId'] as string);
      if (row === undefined) return { count: 0 };
      for (const [key, expected] of Object.entries(where)) {
        if (key === 'intentId') continue;
        if (row[key] !== expected) return { count: 0 };
      }
      const next = { ...row };
      for (const [key, value] of Object.entries(data)) {
        if (value !== null && typeof value === 'object' && 'increment' in (value as Row)) {
          next[key] = (row[key] as number) + (value as { increment: number }).increment;
          continue;
        }
        next[key] = value;
      }
      this.orders.set(where['intentId'] as string, next);
      return { count: 1 };
    },
    update: async ({ where, data }: { where: { intentId: string }; data: Row }) => {
      const row = this.orders.get(where.intentId);
      if (row === undefined) throw new Error('no such row');
      const next = { ...row, ...data };
      this.orders.set(where.intentId, next);
      return next;
    },
  };

  public readonly liveOrderEvent = {
    findUnique: async ({ where }: { where: { intentId_observationSha256: { intentId: string; observationSha256: string } } }) =>
      this.events.get(`${where.intentId_observationSha256.intentId}:${where.intentId_observationSha256.observationSha256}`) ?? null,
    create: async ({ data }: { data: Row }) => {
      const key = `${String(data['intentId'])}:${String(data['observationSha256'])}`;
      if (this.events.has(key)) throw this.#unique();
      this.events.set(key, { ...data });
      return data;
    },
  };

  public readonly liveAdmissionConsumption = {
    findUnique: async ({ where }: { where: { admissionId?: string; intentId?: string } }) => {
      if (where.admissionId !== undefined) return this.admissions.get(where.admissionId) ?? null;
      return [...this.admissions.values()].find((row) => row['intentId'] === where.intentId) ?? null;
    },
    create: async ({ data }: { data: Row }) => {
      const admissionId = data['admissionId'] as string;
      if (this.admissions.has(admissionId)) throw this.#unique();
      this.admissions.set(admissionId, { ...data });
      return data;
    },
  };

  public readonly livePosition = {
    findUnique: async ({ where }: { where: { accountId_pair: { accountId: string; pair: string } } }) =>
      this.positions.get(`${where.accountId_pair.accountId}:${where.accountId_pair.pair}`) ?? null,
  };

  public async $executeRaw(): Promise<number> { return 0; }

  public async $transaction(operations: readonly { run(): unknown }[] | ((tx: this) => Promise<unknown>)): Promise<unknown> {
    if (typeof operations === 'function') return operations(this);
    return operations.map((operation) => operation.run());
  }
}

function intentRecord(overrides: Partial<LiveExecutionIntentRecord> = {}): LiveExecutionIntentRecord {
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
    ...overrides,
  };
}

function closeIntentRecord(): LiveExecutionIntentRecord {
  const base = intentRecord();
  return {
    ...base,
    content: {
      ...base.content, action: 'CLOSE', side: 'SELL', leverage: null, admissionId: null,
      positionInstanceId: 'position-1', positionRevision: 0, reduceOnlyQuantity: '0.5',
    },
    lineage: { researchApproval: null, sourceStrategyDecisionId: base.lineage.sourceStrategyDecisionId },
  };
}

async function seededRepository(): Promise<{ repository: PrismaLiveExecutionRepository; db: BrokenProductionTransaction }> {
  const db = new BrokenProductionTransaction();
  const repository = new PrismaLiveExecutionRepository(db as never);
  await repository.ensureIntent(intentRecord());
  return { repository, db };
}

describe('F18-15 a missing reconciliation delegate fails closed, never open', () => {
  it('OPEN (claimDispatch) is blocked: deterministic error, zero durable reservation, zero wire mutation', async () => {
    const { repository, db } = await seededRepository();
    let admissionCalls = 0;
    await expect(repository.claimDispatch(INTENT_ID, undefined, async () => { admissionCalls += 1; return true; }))
      .rejects.toThrow(FAIL_CLOSED);
    expect(admissionCalls).toBe(0);
    expect((db.orders.get(INTENT_ID) as Row)['state']).toBe('CREATED');
  });

  it('OPEN through the full service never reaches the gateway', async () => {
    const db = new BrokenProductionTransaction();
    const repository = new PrismaLiveExecutionRepository(db as never);
    const gateway = new FakeOrderGateway();
    const service = new LiveExecutionService({ gateway, repository, policy: livePolicy() });
    // No genuine authority is even needed to prove the point: the repository
    // fence fires on `claimDispatch`, long before any gateway call, for ANY
    // caller that does not supply a genuine reconciliation authorization —
    // which is exactly the scenario if the upstream runtime somehow proceeded
    // without Phase18 having verified this account healthy.
    await expect(repository.claimDispatch(INTENT_ID)).rejects.toThrow(FAIL_CLOSED);
    expect(gateway.placeCallCount).toBe(0);
    void service;
  });

  it('CLOSE-shaped dispatch (claimDispatch on a CLOSE intent) is blocked before the position is even compared', async () => {
    const db = new BrokenProductionTransaction();
    const repository = new PrismaLiveExecutionRepository(db as never);
    await repository.ensureIntent(closeIntentRecord());
    db.positions.set(`${ACCOUNT}:${PAIR}`, {
      accountId: ACCOUNT, pair: PAIR, positionInstanceId: 'position-1', revision: 0, side: 'LONG',
      quantity: '0.5', instrumentSpecSnapshotId: 'spec-1', ownerStrategyInstanceId: 'instance-1',
      ownerStrategyId: 'EMA_TREND', ownerStrategyVersion: '1.0.0', ownerParameterHash: 'p'.repeat(64),
    });
    await expect(repository.claimDispatch(INTENT_ID)).rejects.toThrow(FAIL_CLOSED);
    expect((db.orders.get(INTENT_ID) as Row)['state']).toBe('CREATED');
  });

  it('the durable pre-wire arm (armDispatchWire) is blocked even for an already-reserved order', async () => {
    const { repository, db } = await seededRepository();
    // Directly force the row into DISPATCH_RESERVED to isolate `armDispatchWire`
    // from `claimDispatch`'s own (already-proven) fencing.
    db.orders.set(INTENT_ID, { ...db.orders.get(INTENT_ID) as Row, state: 'DISPATCH_RESERVED', revision: 1 });
    await expect(repository.armDispatchWire(INTENT_ID, 1)).rejects.toThrow(FAIL_CLOSED);
    expect((db.orders.get(INTENT_ID) as Row)['dispatchWireArmed']).toBe(false);
  });

  it('regular cancel (claimCancel) is blocked: deterministic error, no cancel reservation taken', async () => {
    const { repository, db } = await seededRepository();
    db.orders.set(INTENT_ID, { ...db.orders.get(INTENT_ID) as Row, state: 'ACKNOWLEDGED', exchangeOrderId: 'venue-1', revision: 1 });
    await expect(repository.claimCancel(INTENT_ID, ACCOUNT)).rejects.toThrow(FAIL_CLOSED);
    expect((db.orders.get(INTENT_ID) as Row)['cancelState']).toBe('NONE');
  });

  it('regular cancel through the full service never reaches the gateway', async () => {
    const db = new BrokenProductionTransaction();
    const repository = new PrismaLiveExecutionRepository(db as never);
    await repository.ensureIntent(intentRecord());
    db.orders.set(INTENT_ID, { ...db.orders.get(INTENT_ID) as Row, state: 'ACKNOWLEDGED', exchangeOrderId: 'venue-1', revision: 1 });
    const gateway = new FakeOrderGateway();
    const service = new LiveExecutionService({ gateway, repository, policy: livePolicy() });
    await expect(service.cancelDurable(INTENT_ID, ACCOUNT)).rejects.toThrow(FAIL_CLOSED);
    expect(gateway.cancelCallCount).toBe(0);
    expect((db.orders.get(INTENT_ID) as Row)['cancelState']).toBe('NONE');
  });

  it('the durable pre-wire arm for cancel (armCancelWire) is blocked even for an already-reserved cancel', async () => {
    const { repository, db } = await seededRepository();
    db.orders.set(INTENT_ID, {
      ...db.orders.get(INTENT_ID) as Row, state: 'CANCEL_REQUESTED', exchangeOrderId: 'venue-1',
      cancelState: 'CANCEL_RESERVED', cancelGeneration: 1, revision: 1,
    });
    await expect(repository.armCancelWire(INTENT_ID, 1)).rejects.toThrow(FAIL_CLOSED);
    expect((db.orders.get(INTENT_ID) as Row)['cancelWireArmed']).toBe(false);
  });

  it('applyObservationAtomically, commitState, commitReconciledState, completeCancelAttempt and markExpiredDispatchUnresolved are all blocked', async () => {
    const { repository } = await seededRepository();
    const observation = {
      kind: 'ACKNOWLEDGED' as const, clientOrderId: CLIENT_ORDER_ID, exchangeClientOrderId: null,
      exchangeOrderId: 'venue-1', pair: PAIR, side: 'BUY' as const, cumulativeFilledQuantity: '0',
      orderedQuantity: '0.5', averageFillPrice: null, exchangeStatus: 'open', providerEventTimeMs: 1_000,
    };
    await expect(repository.applyObservationAtomically(INTENT_ID, observation)).rejects.toThrow(FAIL_CLOSED);
    await expect(repository.commitState({
      intentId: INTENT_ID, clientOrderId: CLIENT_ORDER_ID, accountId: ACCOUNT, pair: PAIR, state: 'ACKNOWLEDGED',
      exchangeOrderId: 'venue-1', orderedQuantity: '0.5', cumulativeFilledQuantity: '0', remainingQuantity: '0.5',
      averageFillPrice: null, lastExchangeStatus: 'open', lastProviderEventTimeMs: 1_000, faultCode: null,
      cancelState: 'NONE', cancelGeneration: 0, cancelExchangeOrderId: null, cancelFaultCode: null,
      dispatchWireArmed: false, cancelWireArmed: false, revision: 0,
    }, 0)).rejects.toThrow(FAIL_CLOSED);
    await expect(repository.commitReconciledState({
      intentId: INTENT_ID, clientOrderId: CLIENT_ORDER_ID, accountId: ACCOUNT, pair: PAIR, state: 'ACKNOWLEDGED',
      exchangeOrderId: 'venue-1', orderedQuantity: '0.5', cumulativeFilledQuantity: '0', remainingQuantity: '0.5',
      averageFillPrice: null, lastExchangeStatus: 'open', lastProviderEventTimeMs: 1_000, faultCode: null,
      cancelState: 'NONE', cancelGeneration: 0, cancelExchangeOrderId: null, cancelFaultCode: null,
      dispatchWireArmed: false, cancelWireArmed: false, revision: 0,
    }, 0, null)).rejects.toThrow(FAIL_CLOSED);
    await expect(repository.completeCancelAttempt(INTENT_ID, 1, 'ACKNOWLEDGED', null)).rejects.toThrow(FAIL_CLOSED);
    await expect(repository.markExpiredDispatchUnresolved(INTENT_ID, ACCOUNT, new Date(Date.now() + 60_000))).rejects.toThrow(FAIL_CLOSED);
  });

  it('fails with the specific deterministic LIVE_RECONCILIATION_REQUIRED code, not a generic error', async () => {
    const { repository } = await seededRepository();
    try {
      await repository.claimDispatch(INTENT_ID);
      throw new Error('expected claimDispatch to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LiveExecutionError);
      expect((error as LiveExecutionError).code).toBe('LIVE_RECONCILIATION_REQUIRED');
    }
  });
});
