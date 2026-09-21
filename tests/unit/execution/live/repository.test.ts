import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { LiveExecutionError } from '../../../../src/execution/live/errors';
import type { LiveExecutionIntentRecord } from '../../../../src/execution/live/intent';
import { observationSha256, PrismaLiveExecutionRepository } from '../../../../src/execution/live/repository';
import type { LiveOrderObservation, LiveOrderStateRecord } from '../../../../src/execution/live/types';

/**
 * A minimal in-process stand-in for the MySQL tables Phase17 adds, faithful to
 * the two behaviours the production adapter actually depends on: unique-key
 * collisions raise Prisma error code P2002, and `updateMany` reports how many
 * rows its WHERE clause matched. The repository's idempotence claims rest on
 * exactly those two behaviours, so this is what must be exercised.
 */
class FakePrisma {
  public readonly intents = new Map<string, Record<string, unknown>>();
  public readonly orders = new Map<string, Record<string, unknown>>();
  public readonly events = new Set<string>();
  public readonly admissions = new Map<string, Record<string, unknown>>();
  public transactionCount = 0;
  #interactiveTail: Promise<void> = Promise.resolve();

  #uniqueViolation(): Error & { code: string } {
    const error = new Error('Unique constraint failed') as Error & { code: string };
    error.code = 'P2002';
    return error;
  }

  public readonly liveExecutionIntent = {
    findUnique: async ({ where }: { where: { intentId: string } }) => this.intents.get(where.intentId) ?? null,
    create: ({ data }: { data: Record<string, unknown> }) => ({
      run: () => {
        const intentId = data['intentId'] as string;
        const clientOrderId = data['clientOrderId'] as string;
        if (this.intents.has(intentId)) throw this.#uniqueViolation();
        for (const stored of this.intents.values()) {
          if (stored['clientOrderId'] === clientOrderId) throw this.#uniqueViolation();
        }
        this.intents.set(intentId, { ...data });
        return data;
      },
    }),
  };

  public readonly liveOrder = {
    findUnique: async ({ where }: { where: { intentId: string } }) => this.orders.get(where.intentId) ?? null,
    create: ({ data }: { data: Record<string, unknown> }) => ({
      run: () => {
        const intentId = data['intentId'] as string;
        if (this.orders.has(intentId)) throw this.#uniqueViolation();
        this.orders.set(intentId, { ...data });
        return data;
      },
    }),
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = this.orders.get(where['intentId'] as string);
      if (row === undefined) return { count: 0 };
      for (const [key, expected] of Object.entries(where)) {
        if (key === 'intentId') continue;
        if (row[key] !== expected) return { count: 0 };
      }
      const next = { ...row };
      for (const [key, value] of Object.entries(data)) {
        if (value !== null && typeof value === 'object' && 'increment' in (value as Record<string, unknown>)) {
          next[key] = (row[key] as number) + ((value as { increment: number }).increment);
          continue;
        }
        next[key] = value;
      }
      this.orders.set(where['intentId'] as string, next);
      return { count: 1 };
    },
  };

  public readonly liveOrderEvent = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const key = `${String(data['intentId'])}:${String(data['observationSha256'])}`;
      if (this.events.has(key)) throw this.#uniqueViolation();
      this.events.add(key);
      return data;
    },
  };

  public readonly liveAdmissionConsumption = {
    findUnique: async ({ where }: { where: { admissionId?: string; intentId?: string } }) => {
      if (where.admissionId !== undefined) return this.admissions.get(where.admissionId) ?? null;
      return [...this.admissions.values()].find((row) => row['intentId'] === where.intentId) ?? null;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const admissionId = data['admissionId'] as string;
      if (this.admissions.has(admissionId)) throw this.#uniqueViolation();
      this.admissions.set(admissionId, { ...data });
      return data;
    },
  };

  public async $executeRaw(): Promise<number> {
    return 0;
  }

  public async $transaction(operations: readonly { run(): unknown }[] | ((tx: this) => Promise<unknown>)): Promise<unknown> {
    this.transactionCount += 1;
    if (typeof operations === 'function') {
      let release!: () => void;
      const predecessor = this.#interactiveTail;
      this.#interactiveTail = new Promise<void>((resolve) => { release = resolve; });
      await predecessor;
      try {
        return await operations(this);
      } finally {
        release();
      }
    }
    const intentsBefore = new Map(this.intents);
    const ordersBefore = new Map(this.orders);
    const admissionsBefore = new Map(this.admissions);
    try {
      return operations.map((operation) => operation.run());
    } catch (error) {
      this.intents.clear();
      for (const [key, value] of intentsBefore) this.intents.set(key, value);
      this.orders.clear();
      for (const [key, value] of ordersBefore) this.orders.set(key, value);
      this.admissions.clear();
      for (const [key, value] of admissionsBefore) this.admissions.set(key, value);
      throw error;
    }
  }
}

function makeRepository(): { repository: PrismaLiveExecutionRepository; prisma: FakePrisma } {
  const prisma = new FakePrisma();
  return { repository: new PrismaLiveExecutionRepository(prisma as unknown as PrismaClient), prisma };
}

const CLIENT_ORDER_ID = `p17-${'a'.repeat(32)}`;

function intentRecord(overrides: Partial<LiveExecutionIntentRecord> = {}): LiveExecutionIntentRecord {
  return {
    intentId: 'i'.repeat(64),
    clientOrderId: CLIENT_ORDER_ID,
    wireOrderType: 'limit_order',
    quantityAdjusted: false,
    priceAdjusted: false,
    content: {
      accountId: 'account-live-1',
      pair: 'B-BTC_USDT',
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

function observation(overrides: Partial<LiveOrderObservation> = {}): LiveOrderObservation {
  return {
    kind: 'ACKNOWLEDGED',
    clientOrderId: CLIENT_ORDER_ID,
    exchangeClientOrderId: null,
    exchangeOrderId: 'venue-1',
    pair: 'B-BTC_USDT',
    side: 'BUY',
    cumulativeFilledQuantity: '0',
    orderedQuantity: '0.5',
    averageFillPrice: null,
    exchangeStatus: 'open',
    providerEventTimeMs: 1_000,
    ...overrides,
  };
}

describe('P17 durable intent creation', () => {
  it('writes the intent and its CREATED order in one transaction', async () => {
    const { repository, prisma } = makeRepository();
    const order = await repository.ensureIntent(intentRecord());
    expect(prisma.transactionCount).toBe(1);
    expect(order.state).toBe('CREATED');
    expect(order.remainingQuantity).toBe('0.5');
    expect(prisma.intents.size).toBe(1);
    expect(prisma.orders.size).toBe(1);
  });

  it('persists the full risk and research lineage as audit columns', async () => {
    const { repository, prisma } = makeRepository();
    const record = intentRecord();
    await repository.ensureIntent(record);
    const stored = prisma.intents.get(record.intentId);
    expect(stored).toMatchObject({
      riskDecisionId: 'risk-1',
      admissionId: 'admission-1',
      sourceStrategyDecisionId: 'decision-1',
      validationSubjectId: 'subject-1',
      validationPlanId: 'plan-1',
      wireOrderType: 'limit_order',
      instrumentSpecSnapshotId: 'spec-1',
    });
  });

  it('is idempotent for an identical replay', async () => {
    const { repository, prisma } = makeRepository();
    const record = intentRecord();
    const first = await repository.ensureIntent(record);
    const second = await repository.ensureIntent(record);
    expect(second).toEqual(first);
    expect(prisma.intents.size).toBe(1);
  });

  it('fails closed when the same identity is presented with different economics', async () => {
    const { repository } = makeRepository();
    const record = intentRecord();
    await repository.ensureIntent(record);
    await expect(repository.ensureIntent({
      ...record,
      content: { ...record.content, quantity: '0.6' },
    })).rejects.toThrow(/LIVE_INTENT_CONFLICT/);
  });

  it('fails closed when a different intent already owns the client order id', async () => {
    const { repository } = makeRepository();
    await repository.ensureIntent(intentRecord());
    await expect(repository.ensureIntent(intentRecord({ intentId: 'j'.repeat(64) })))
      .rejects.toThrow(/LIVE_INTENT_CONFLICT/);
  });

  it('rolls the transaction back when the order insert collides', async () => {
    const { repository, prisma } = makeRepository();
    const record = intentRecord();
    prisma.orders.set(record.intentId, { intentId: record.intentId });
    await expect(repository.ensureIntent(record)).rejects.toThrow(LiveExecutionError);
    expect(prisma.intents.size).toBe(0);
  });
});

describe('P17-I07 the dispatch claim has exactly one winner', () => {
  it('claims a CREATED order once and reports ALREADY_CLAIMED afterwards', async () => {
    const { repository } = makeRepository();
    const record = intentRecord();
    await repository.ensureIntent(record);
    const first = await repository.claimDispatch(record.intentId, async () => true);
    const second = await repository.claimDispatch(record.intentId, async () => true);
    expect(first.kind).toBe('CLAIMED');
    expect(first.order.state).toBe('DISPATCH_RESERVED');
    expect(first.order.revision).toBe(1);
    expect(second.kind).toBe('ALREADY_CLAIMED');
    expect(second.order.revision).toBe(1);
  });

  it('gives exactly one winner under concurrent claims', async () => {
    const { repository } = makeRepository();
    const record = intentRecord();
    await repository.ensureIntent(record);
    const outcomes = await Promise.all([
      repository.claimDispatch(record.intentId, async () => true),
      repository.claimDispatch(record.intentId, async () => true),
      repository.claimDispatch(record.intentId, async () => true),
    ]);
    expect(outcomes.filter((outcome) => outcome.kind === 'CLAIMED')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'ALREADY_CLAIMED')).toHaveLength(2);
  });

  it('never claims an order that is already past CREATED', async () => {
    const { repository, prisma } = makeRepository();
    const record = intentRecord();
    await repository.ensureIntent(record);
    prisma.orders.set(record.intentId, { ...prisma.orders.get(record.intentId), state: 'ACKNOWLEDGED' } as Record<string, unknown>);
    const claim = await repository.claimDispatch(record.intentId, async () => true);
    expect(claim.kind).toBe('ALREADY_CLAIMED');
  });
});

describe('P17 optimistic-concurrency state commits', () => {
  async function seeded(): Promise<{ repository: PrismaLiveExecutionRepository; prisma: FakePrisma; order: LiveOrderStateRecord }> {
    const { repository, prisma } = makeRepository();
    const record = intentRecord();
    const order = await repository.ensureIntent(record);
    return { repository, prisma, order };
  }

  it('commits a state computed from the current revision', async () => {
    const { repository, order } = await seeded();
    const next: LiveOrderStateRecord = {
      ...order,
      state: 'ACKNOWLEDGED',
      exchangeOrderId: 'venue-1',
      lastExchangeStatus: 'open',
      lastProviderEventTimeMs: 1_000,
      revision: order.revision + 1,
    };
    const committed = await repository.commitState(next, order.revision);
    expect(committed.state).toBe('ACKNOWLEDGED');
    const reloaded = await repository.load(order.intentId);
    expect(reloaded?.state).toBe('ACKNOWLEDGED');
    expect(reloaded?.exchangeOrderId).toBe('venue-1');
    expect(reloaded?.lastProviderEventTimeMs).toBe(1_000);
  });

  it('refuses a commit computed from a stale revision', async () => {
    const { repository, order } = await seeded();
    await repository.commitState({ ...order, state: 'DISPATCH_RESERVED', revision: order.revision + 1 }, order.revision);
    await expect(repository.commitState({ ...order, state: 'ACKNOWLEDGED', revision: order.revision + 1 }, order.revision))
      .rejects.toThrow(/LIVE_ORDER_STATE_CONFLICT/);
  });

  it('reports a missing row rather than silently creating one', async () => {
    const { repository } = makeRepository();
    await expect(repository.commitState({
      intentId: 'absent',
      clientOrderId: CLIENT_ORDER_ID,
      accountId: 'a',
      pair: 'B-BTC_USDT',
      state: 'ACKNOWLEDGED',
      exchangeOrderId: null,
      orderedQuantity: '1',
      cumulativeFilledQuantity: '0',
      remainingQuantity: '1',
      averageFillPrice: null,
      lastExchangeStatus: null,
      lastProviderEventTimeMs: null,
      faultCode: null,
      cancelState: 'NONE',
      cancelGeneration: 0,
      cancelExchangeOrderId: null,
      cancelFaultCode: null,
      revision: 1,
    }, 0)).rejects.toThrow(/LIVE_ORDER_STATE_CONFLICT/);
  });
});

describe('P17 observation identity', () => {
  it('hashes an observation deterministically and distinguishes every semantic field', () => {
    const base = observation();
    expect(observationSha256(base)).toBe(observationSha256({ ...base }));
    expect(observationSha256({ ...base, cumulativeFilledQuantity: '0.1' })).not.toBe(observationSha256(base));
    expect(observationSha256({ ...base, providerEventTimeMs: 2_000 })).not.toBe(observationSha256(base));
    expect(observationSha256({ ...base, exchangeStatus: 'filled' })).not.toBe(observationSha256(base));
  });
});

describe('P17 durable decimals are read back exactly', () => {
  it('reads Prisma Decimal objects back as exact fixed-point strings', async () => {
    const { repository, prisma } = makeRepository();
    const record = intentRecord();
    await repository.ensureIntent(record);
    const stored = prisma.orders.get(record.intentId) as Record<string, unknown>;
    prisma.orders.set(record.intentId, {
      ...stored,
      orderedQuantity: { toFixed: () => '0.500000000000000000' },
      cumulativeFilledQuantity: { toFixed: () => '0.125000000000000000' },
      remainingQuantity: { toFixed: () => '0.375000000000000000' },
      averageFillPrice: { toFixed: () => '64000.500000000000000000' },
    });
    const loaded = await repository.load(record.intentId);
    expect(loaded?.orderedQuantity).toBe('0.500000000000000000');
    expect(loaded?.cumulativeFilledQuantity).toBe('0.125000000000000000');
    expect(loaded?.averageFillPrice).toBe('64000.500000000000000000');
  });

  it('refuses a durable timestamp outside the safe integer range', async () => {
    const { repository, prisma } = makeRepository();
    const record = intentRecord();
    await repository.ensureIntent(record);
    const stored = prisma.orders.get(record.intentId) as Record<string, unknown>;
    prisma.orders.set(record.intentId, { ...stored, lastProviderEventTimeMs: 2n ** 62n });
    await expect(repository.load(record.intentId)).rejects.toThrow(/LIVE_PERSISTENCE_FAULT/);
  });
});
