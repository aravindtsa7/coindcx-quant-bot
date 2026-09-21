/**
 * [F17-R03] The database trust boundary.
 *
 * The original defect was uneven verification: `ensureIntent` recomputed the
 * sealed `content_sha256` of a stored intent, but `claimDispatch`,
 * `applyObservationAtomically`, `claimCancel`, `markExpiredDispatchUnresolved`,
 * `load` and `loadObservationIdentity` all read the same immutable columns and
 * acted on them without recomputing anything. A writer who altered one column
 * could therefore change what a live order was allowed to do on every path
 * except the one that happened to check.
 *
 * These tests do not verify that a check exists; they verify that no path
 * lacks one. Three layers:
 *
 *   1. per-column sweeps — every immutable intent column, and every immutable
 *      `live_order` mirror column, altered one at a time;
 *   2. per-path adversarial cases — for each authoritative read, replay,
 *      recovery and restart path, a tampered row must fail closed AND leave no
 *      side effect (no claim taken, no admission consumed, no event appended,
 *      no state advanced);
 *   3. a poisoned-database bypass proof — with every durable intent row
 *      corrupted, every authoritative method of the repository is called and
 *      required to refuse. A path that forgot to verify would return normally
 *      and fail this test by construction, without anyone having to remember
 *      to add a case for it.
 */
import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { LiveExecutionError } from '../../../../src/execution/live/errors';
import type { LiveExecutionIntentRecord } from '../../../../src/execution/live/intent';
import {
  PrismaLiveExecutionRepository,
  liveExecutionIntentContentSha256,
  verifyStoredIntentIntegrity,
} from '../../../../src/execution/live/repository';
import type { LiveOrderObservation } from '../../../../src/execution/live/types';

const INTEGRITY = /LIVE_DURABLE_INTEGRITY_VIOLATION/;
const CLIENT_ORDER_ID = `p17-${'a'.repeat(32)}`;
const INTENT_ID = 'i'.repeat(64);
const ACCOUNT = 'account-live-1';
const PAIR = 'B-BTC_USDT';

type Row = Record<string, unknown>;

/**
 * A tamperable stand-in for the Phase17 tables. It is deliberately writable
 * from the outside: the threat being modelled is a writer with direct SQL
 * access, so the test must be able to change a stored column without going
 * through the repository.
 */
class TamperableDb {
  public readonly intents = new Map<string, Row>();
  public readonly orders = new Map<string, Row>();
  public readonly events = new Map<string, Row>();
  public readonly admissions = new Map<string, Row>();
  public readonly positions = new Map<string, Row>();
  public rawLockCount = 0;
  #interactiveTail: Promise<void> = Promise.resolve();

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
        for (const stored of this.intents.values()) if (stored['clientOrderId'] === data['clientOrderId']) throw this.#unique();
        this.intents.set(intentId, { ...data });
        return data;
      },
    }),
  };

  public readonly liveOrder = {
    findUnique: async ({ where, include }: { where: { intentId: string }; include?: { intent?: boolean } }) => {
      const row = this.orders.get(where.intentId);
      if (row === undefined) return null;
      // Faithful to Prisma: `include` joins the related row into the result.
      return include?.intent === true ? { ...row, intent: this.intents.get(where.intentId) ?? null } : { ...row };
    },
    create: ({ data }: { data: Row }) => ({
      run: () => {
        const intentId = data['intentId'] as string;
        if (this.orders.has(intentId)) throw this.#unique();
        this.orders.set(intentId, { ...data, updatedAt: new Date(0) });
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
      this.orders.set(where['intentId'] as string, applyData(row, data));
      return { count: 1 };
    },
    update: async ({ where, data }: { where: { intentId: string }; data: Row }) => {
      const row = this.orders.get(where.intentId);
      if (row === undefined) throw new Error('no such row');
      const next = applyData(row, data);
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

  public async $executeRaw(): Promise<number> {
    this.rawLockCount += 1;
    return 0;
  }

  public async $transaction(operations: readonly { run(): unknown }[] | ((tx: this) => Promise<unknown>)): Promise<unknown> {
    if (typeof operations === 'function') {
      let release!: () => void;
      const predecessor = this.#interactiveTail;
      this.#interactiveTail = new Promise<void>((resolve) => { release = resolve; });
      await predecessor;
      const snapshot = this.#snapshot();
      try {
        return await operations(this);
      } catch (error) {
        this.#rollback(snapshot);
        throw error;
      } finally {
        release();
      }
    }
    const snapshot = this.#snapshot();
    try {
      return operations.map((operation) => operation.run());
    } catch (error) {
      this.#rollback(snapshot);
      throw error;
    }
  }

  #snapshot(): readonly Map<string, Row>[] {
    return [this.intents, this.orders, this.events, this.admissions, this.positions].map((map) => new Map(map));
  }

  #rollback(snapshot: readonly Map<string, Row>[]): void {
    for (const [index, live] of [this.intents, this.orders, this.events, this.admissions, this.positions].entries()) {
      live.clear();
      for (const [key, value] of snapshot[index] as Map<string, Row>) live.set(key, value);
    }
  }
}

function applyData(row: Row, data: Row): Row {
  const next = { ...row };
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && 'increment' in (value as Row)) {
      next[key] = (row[key] as number) + (value as { increment: number }).increment;
      continue;
    }
    next[key] = value;
  }
  return next;
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

function observation(overrides: Partial<LiveOrderObservation> = {}): LiveOrderObservation {
  return {
    kind: 'ACKNOWLEDGED',
    clientOrderId: CLIENT_ORDER_ID,
    exchangeClientOrderId: null,
    exchangeOrderId: 'venue-1',
    pair: PAIR,
    side: 'BUY',
    cumulativeFilledQuantity: '0',
    orderedQuantity: '0.5',
    averageFillPrice: null,
    exchangeStatus: 'open',
    providerEventTimeMs: 1_000,
    ...overrides,
  };
}

async function seeded(record = intentRecord()): Promise<{ repository: PrismaLiveExecutionRepository; db: TamperableDb }> {
  const db = new TamperableDb();
  const repository = new PrismaLiveExecutionRepository(db as unknown as PrismaClient);
  await repository.ensureIntent(record);
  return { repository, db };
}

/** Rewrites one column of the stored intent WITHOUT updating its sealed digest. */
function tamperIntent(db: TamperableDb, column: string, value: unknown): void {
  db.intents.set(INTENT_ID, { ...db.intents.get(INTENT_ID) as Row, [column]: value });
}

function tamperOrder(db: TamperableDb, column: string, value: unknown): void {
  db.orders.set(INTENT_ID, { ...db.orders.get(INTENT_ID) as Row, [column]: value });
}

/** Drives the order to ACKNOWLEDGED so cancellation paths are reachable. */
async function acknowledged(repository: PrismaLiveExecutionRepository): Promise<void> {
  await repository.claimDispatch(INTENT_ID, async () => true);
  await repository.applyObservationAtomically(INTENT_ID, observation());
}

// ---------------------------------------------------------------------------
// 1. Per-column sweeps
// ---------------------------------------------------------------------------

describe('F17-R03 every immutable intent column is sealed by the digest', () => {
  const mutations: readonly (readonly [string, unknown])[] = [
    ['accountId', 'attacker-account'],
    ['pair', 'B-ETH_USDT'],
    ['side', 'SELL'],
    ['action', 'CLOSE'],
    ['quantity', '500'],
    ['orderType', 'MARKET'],
    ['price', '1'],
    ['timeInForce', 'IMMEDIATE_OR_CANCEL'],
    ['leverage', '50'],
    ['riskDecisionId', 'risk-attacker'],
    ['admissionId', 'admission-attacker'],
    ['strategyInstanceId', 'instance-attacker'],
    ['strategyId', 'ATTACKER'],
    ['strategyVersion', '9.9.9'],
    ['parameterHash', 'q'.repeat(64)],
    ['liveExecutionPolicyId', 'policy-attacker'],
    ['instrumentSpecSnapshotId', 'spec-attacker'],
    ['authorizedNotionalInr', '999999999'],
    ['settlementRateInrPerQuote', '1'],
    ['positionInstanceId', 'position-attacker'],
    ['positionRevision', 7],
    ['reduceOnlyQuantity', '500'],
    ['wireOrderType', 'market_order'],
    ['clientOrderId', `p17-${'b'.repeat(32)}`],
    ['intentId', 'j'.repeat(64)],
    ['sourceStrategyDecisionId', 'decision-attacker'],
    ['validationSubjectId', 'subject-attacker'],
    ['validationPlanId', 'plan-attacker'],
    ['validationSubjectResultSha256', 's'.repeat(64)],
    ['contentSha256', 'f'.repeat(64)],
  ];

  it.each(mutations)('detects a tampered %s', async (column, value) => {
    const { repository, db } = await seeded();
    tamperIntent(db, column, value);
    await expect(repository.load(INTENT_ID)).rejects.toThrow(INTEGRITY);
    await expect(repository.loadObservationIdentity(INTENT_ID)).rejects.toThrow(INTEGRITY);
  });

  it('covers every column the create payload writes', async () => {
    const { db } = await seeded();
    const stored = db.intents.get(INTENT_ID) as Row;
    const swept = new Set(mutations.map(([column]) => column));
    // `createdAt` is database-assigned operational metadata, not sealed content.
    const unswept = Object.keys(stored).filter((key) => !swept.has(key) && key !== 'createdAt');
    expect(unswept).toEqual([]);
  });

  it('accepts a decimal rewritten to an equivalent canonical form', async () => {
    const { repository, db } = await seeded();
    // 0.5 and 0.500000000000000000 are the same number; MySQL returns the
    // padded form. Integrity must not be a string comparison.
    tamperIntent(db, 'quantity', '0.500000000000000000');
    await expect(repository.load(INTENT_ID)).resolves.not.toBeNull();
    tamperIntent(db, 'quantity', { toFixed: () => '0.500000000000000000' });
    await expect(repository.load(INTENT_ID)).resolves.not.toBeNull();
  });

  it('refuses a durable row whose decimal column cannot be read at all', async () => {
    const { repository, db } = await seeded();
    tamperIntent(db, 'quantity', { notADecimal: true });
    await expect(repository.load(INTENT_ID)).rejects.toThrow(INTEGRITY);
  });
});

describe('F17-R03 every immutable live_order mirror column is proven against the intent', () => {
  const mutations: readonly (readonly [string, unknown])[] = [
    ['clientOrderId', `p17-${'c'.repeat(32)}`],
    ['accountId', 'attacker-account'],
    ['pair', 'B-ETH_USDT'],
    ['orderedQuantity', '500'],
  ];

  it.each(mutations)('detects a tampered live_order.%s while the intent is intact', async (column, value) => {
    const { repository, db } = await seeded();
    tamperOrder(db, column, value);
    await expect(repository.load(INTENT_ID)).rejects.toThrow(INTEGRITY);
  });

  it('refuses an order projection whose intent row has been deleted', async () => {
    const { repository, db } = await seeded();
    db.intents.delete(INTENT_ID);
    await expect(repository.load(INTENT_ID)).rejects.toThrow(INTEGRITY);
  });

  it('accepts a mirror rewritten to an equivalent canonical decimal', async () => {
    const { repository, db } = await seeded();
    tamperOrder(db, 'orderedQuantity', '0.500000000000000000');
    await expect(repository.load(INTENT_ID)).resolves.not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Per-path adversarial cases with side-effect proofs
// ---------------------------------------------------------------------------

describe('F17-R03 the dispatch claim refuses tampered durable state without side effects', () => {
  it('refuses a tampered intent and takes no claim and no admission', async () => {
    const { repository, db } = await seeded();
    tamperIntent(db, 'quantity', '500');
    await expect(repository.claimDispatch(INTENT_ID, async () => true)).rejects.toThrow(INTEGRITY);
    expect((db.orders.get(INTENT_ID) as Row)['state']).toBe('CREATED');
    expect(db.admissions.size).toBe(0);
  });

  it('never invokes the in-memory admission consumption callback for a tampered intent', async () => {
    const { repository, db } = await seeded();
    tamperIntent(db, 'admissionId', 'admission-attacker');
    let consumeCalls = 0;
    await expect(repository.claimDispatch(INTENT_ID, async () => { consumeCalls += 1; return true; })).rejects.toThrow(INTEGRITY);
    expect(consumeCalls).toBe(0);
  });

  it('refuses a tampered order mirror and takes no claim', async () => {
    const { repository, db } = await seeded();
    tamperOrder(db, 'orderedQuantity', '500');
    await expect(repository.claimDispatch(INTENT_ID, async () => true)).rejects.toThrow(INTEGRITY);
    expect((db.orders.get(INTENT_ID) as Row)['state']).toBe('CREATED');
  });

  it('refuses a tampered CLOSE intent before the position is even compared', async () => {
    const close = intentRecord({
      content: {
        ...intentRecord().content,
        action: 'CLOSE', side: 'SELL', leverage: null, admissionId: null,
        positionInstanceId: 'position-1', positionRevision: 3, reduceOnlyQuantity: '0.5',
      },
    });
    const { repository, db } = await seeded(close);
    db.positions.set(`${ACCOUNT}:${PAIR}`, {
      accountId: ACCOUNT, pair: PAIR, positionInstanceId: 'position-1', revision: 3, side: 'LONG',
      quantity: '0.5', instrumentSpecSnapshotId: 'spec-1', ownerStrategyInstanceId: 'instance-1',
      ownerStrategyId: 'EMA_TREND', ownerStrategyVersion: '1.0.0', ownerParameterHash: 'p'.repeat(64),
    });
    // Sanity: the untampered CLOSE is claimable, so the refusal below is caused
    // by the tamper and not by an unrelated CLOSE precondition.
    await expect(repository.claimDispatch(INTENT_ID)).resolves.toMatchObject({ kind: 'CLAIMED' });

    const fresh = await seeded(close);
    fresh.db.positions.set(`${ACCOUNT}:${PAIR}`, db.positions.get(`${ACCOUNT}:${PAIR}`) as Row);
    tamperIntent(fresh.db, 'reduceOnlyQuantity', '0.5');
    tamperIntent(fresh.db, 'quantity', '999');
    await expect(fresh.repository.claimDispatch(INTENT_ID)).rejects.toThrow(INTEGRITY);
    expect((fresh.db.orders.get(INTENT_ID) as Row)['state']).toBe('CREATED');
  });

  it('refuses when a consumption row is repointed at a foreign account or decision', async () => {
    const { repository, db } = await seeded();
    db.admissions.set('admission-1', {
      admissionId: 'admission-1', intentId: INTENT_ID, accountId: 'attacker-account', pair: PAIR, riskDecisionId: 'risk-1',
    });
    await expect(repository.claimDispatch(INTENT_ID, async () => true)).rejects.toThrow(/LIVE_AUTHORITY_INVALID/);
    expect((db.orders.get(INTENT_ID) as Row)['state']).toBe('CREATED');
  });
});

describe('F17-R03 observation folding refuses tampered durable state without appending an event', () => {
  it('refuses a tampered intent and writes no event row', async () => {
    const { repository, db } = await seeded();
    await repository.claimDispatch(INTENT_ID, async () => true);
    tamperIntent(db, 'side', 'SELL');
    await expect(repository.applyObservationAtomically(INTENT_ID, observation())).rejects.toThrow(INTEGRITY);
    expect(db.events.size).toBe(0);
    expect((db.orders.get(INTENT_ID) as Row)['state']).toBe('DISPATCH_RESERVED');
  });

  it('refuses a tampered ordered quantity that would widen the accepted fill envelope', async () => {
    const { repository, db } = await seeded();
    await repository.claimDispatch(INTENT_ID, async () => true);
    // Without the mirror check this would let a 5.0 fill be accepted against a
    // 0.5 order and recorded as a legitimate FILLED terminal state.
    tamperOrder(db, 'orderedQuantity', '5');
    await expect(repository.applyObservationAtomically(INTENT_ID, observation({
      kind: 'FILL', cumulativeFilledQuantity: '5', orderedQuantity: '5', averageFillPrice: '64000', exchangeStatus: 'filled', providerEventTimeMs: 2_000,
    }))).rejects.toThrow(INTEGRITY);
    expect(db.events.size).toBe(0);
  });

  it('still folds a legitimate observation after the tamper is reverted', async () => {
    const { repository, db } = await seeded();
    await repository.claimDispatch(INTENT_ID, async () => true);
    const pristine = { ...db.intents.get(INTENT_ID) as Row };
    tamperIntent(db, 'side', 'SELL');
    await expect(repository.applyObservationAtomically(INTENT_ID, observation())).rejects.toThrow(INTEGRITY);
    db.intents.set(INTENT_ID, pristine);
    const order = await repository.applyObservationAtomically(INTENT_ID, observation());
    expect(order.state).toBe('ACKNOWLEDGED');
    expect(db.events.size).toBe(1);
  });
});

describe('F17-R03 cancellation and restart recovery verify before they mutate', () => {
  it('refuses a cancellation claim on a tampered intent and reserves nothing', async () => {
    const { repository, db } = await seeded();
    await acknowledged(repository);
    tamperIntent(db, 'price', '1');
    await expect(repository.claimCancel(INTENT_ID, ACCOUNT)).rejects.toThrow(INTEGRITY);
    expect((db.orders.get(INTENT_ID) as Row)['cancelState']).toBe('NONE');
    expect((db.orders.get(INTENT_ID) as Row)['state']).toBe('ACKNOWLEDGED');
  });

  it('a rewritten live_order.accountId cannot transfer cancellation ownership', async () => {
    const { repository, db } = await seeded();
    await acknowledged(repository);
    // The attacker rewrites the projection's owner to their own trusted account.
    // Before the mirror check this would have satisfied the only ownership test
    // `claimCancel` performs.
    tamperOrder(db, 'accountId', 'attacker-account');
    await expect(repository.claimCancel(INTENT_ID, 'attacker-account')).rejects.toThrow(INTEGRITY);
    expect((db.orders.get(INTENT_ID) as Row)['cancelState']).toBe('NONE');
  });

  it('refuses restart recovery on a tampered intent and leaves the order reserved', async () => {
    const { repository, db } = await seeded();
    await repository.claimDispatch(INTENT_ID, async () => true);
    tamperIntent(db, 'authorizedNotionalInr', '999999999');
    await expect(repository.markExpiredDispatchUnresolved(INTENT_ID, ACCOUNT, new Date(Date.now() + 60_000)))
      .rejects.toThrow(INTEGRITY);
    expect((db.orders.get(INTENT_ID) as Row)['state']).toBe('DISPATCH_RESERVED');
  });

  it('a rewritten live_order.accountId cannot transfer restart-recovery ownership', async () => {
    const { repository, db } = await seeded();
    await repository.claimDispatch(INTENT_ID, async () => true);
    tamperOrder(db, 'accountId', 'attacker-account');
    await expect(repository.markExpiredDispatchUnresolved(INTENT_ID, 'attacker-account', new Date(Date.now() + 60_000)))
      .rejects.toThrow(INTEGRITY);
    expect((db.orders.get(INTENT_ID) as Row)['state']).toBe('DISPATCH_RESERVED');
  });

  it.each([
    ['account mirror', 'order', 'accountId', 'attacker-account'],
    ['pair mirror', 'order', 'pair', 'B-ETH_USDT'],
    ['ordered quantity mirror', 'order', 'orderedQuantity', '500'],
    ['client order id mirror', 'order', 'clientOrderId', `p17-${'b'.repeat(32)}`],
    ['canonical intent digest', 'intent', 'quantity', '500'],
  ] as const)('refuses cancellation completion after %s tampering and rolls back every field', async (_label, target, column, value) => {
    const { repository, db } = await seeded();
    await acknowledged(repository);
    const claim = await repository.claimCancel(INTENT_ID, ACCOUNT);
    expect(claim.kind).toBe('CLAIMED');
    if (target === 'order') tamperOrder(db, column, value);
    else tamperIntent(db, column, value);
    const before = { ...db.orders.get(INTENT_ID) as Row };

    await expect(repository.completeCancelAttempt(INTENT_ID, claim.generation, 'AMBIGUOUS', 'PROVIDER_TIMEOUT'))
      .rejects.toThrow(INTEGRITY);

    const after = db.orders.get(INTENT_ID) as Row;
    expect(after['cancelState']).toBe(before['cancelState']);
    expect(after['revision']).toBe(before['revision']);
    expect(after['faultCode']).toBe(before['faultCode']);
    expect(after['cancelFaultCode']).toBe(before['cancelFaultCode']);
  });

  it('refuses a state commit whose immutable mirrors moved underneath it', async () => {
    const { repository, db } = await seeded();
    const claim = await repository.claimDispatch(INTENT_ID, async () => true);
    expect(claim.kind).toBe('CLAIMED');
    tamperOrder(db, 'accountId', 'attacker-account');
    await expect(repository.commitState({ ...claim.order, state: 'ACKNOWLEDGED', revision: claim.order.revision + 1 }, claim.order.revision))
      .rejects.toThrow(INTEGRITY);
    expect((db.orders.get(INTENT_ID) as Row)['state']).toBe('DISPATCH_RESERVED');
    expect((db.orders.get(INTENT_ID) as Row)['revision']).toBe(claim.order.revision);
  });

  it('refuses commitState after ordered quantity tampering without changing state or revision', async () => {
    const { repository, db } = await seeded();
    const claim = await repository.claimDispatch(INTENT_ID, async () => true);
    expect(claim.kind).toBe('CLAIMED');
    tamperOrder(db, 'orderedQuantity', '500');
    const before = { ...db.orders.get(INTENT_ID) as Row };

    await expect(repository.commitState({ ...claim.order, state: 'ACKNOWLEDGED', revision: claim.order.revision + 1 }, claim.order.revision))
      .rejects.toThrow(INTEGRITY);

    const after = db.orders.get(INTENT_ID) as Row;
    expect(after['state']).toBe(before['state']);
    expect(after['revision']).toBe(before['revision']);
    expect(after['faultCode']).toBe(before['faultCode']);
  });
});

describe('F17-R03 self-consistent tampering is still caught where a minted intent exists', () => {
  it('reports a conflict, not an integrity violation, when content and digest were rewritten together', async () => {
    const { repository, db } = await seeded();
    const forged = intentRecord({ content: { ...intentRecord().content, quantity: '500' } });
    db.intents.set(INTENT_ID, {
      ...db.intents.get(INTENT_ID) as Row,
      quantity: '500',
      contentSha256: liveExecutionIntentContentSha256(forged),
    });
    // The digest now agrees with the content, so integrity alone cannot see it.
    expect(() => verifyStoredIntentIntegrity(db.intents.get(INTENT_ID))).not.toThrow();
    // Dispatch always re-presents a freshly minted intent, and that comparison
    // is what catches it.
    await expect(repository.ensureIntent(intentRecord())).rejects.toThrow(/LIVE_INTENT_CONFLICT/);
  });

  it('separates the two failures by code', async () => {
    const { repository, db } = await seeded();
    tamperIntent(db, 'quantity', '500');
    await expect(repository.ensureIntent(intentRecord())).rejects.toThrow(INTEGRITY);
  });
});

// ---------------------------------------------------------------------------
// 3. Poisoned-database bypass proof
// ---------------------------------------------------------------------------

describe('F17-R03 no authoritative path accepts durable state without verification', () => {
  /**
   * Every public entry point of the repository, classified. The classification
   * is total and is itself asserted against the class, so a method added later
   * cannot slip through unclassified.
   *
   *   - `verified-read`  — reads durable state and must refuse a poisoned row.
   *   - `guarded-write`  — performs no authoritative read; its input came from
   *                        a verified read and its WHERE clause pins the
   *                        immutable mirrors, so a moved row fails the write.
   *   - `undigested-read` — `live_position` alone, which carries no sealed
   *                        digest because Phase17 never writes it, and which
   *                        authorizes nothing on its own.
   */
  const paths: readonly {
    readonly name: string;
    readonly kind: 'verified-read' | 'guarded-write' | 'undigested-read';
    readonly call: (repository: PrismaLiveExecutionRepository) => Promise<unknown>;
  }[] = [
    { name: 'ensureIntent', kind: 'verified-read', call: (r) => r.ensureIntent(intentRecord()) },
    { name: 'claimDispatch', kind: 'verified-read', call: (r) => r.claimDispatch(INTENT_ID, async () => true) },
    { name: 'applyObservationAtomically', kind: 'verified-read', call: (r) => r.applyObservationAtomically(INTENT_ID, observation()) },
    { name: 'claimCancel', kind: 'verified-read', call: (r) => r.claimCancel(INTENT_ID, ACCOUNT) },
    { name: 'completeCancelAttempt', kind: 'verified-read', call: (r) => r.completeCancelAttempt(INTENT_ID, 1, 'ACKNOWLEDGED', null) },
    { name: 'markExpiredDispatchUnresolved', kind: 'verified-read', call: (r) => r.markExpiredDispatchUnresolved(INTENT_ID, ACCOUNT, new Date(Date.now() + 60_000)) },
    { name: 'load', kind: 'verified-read', call: (r) => r.load(INTENT_ID) },
    { name: 'loadObservationIdentity', kind: 'verified-read', call: (r) => r.loadObservationIdentity(INTENT_ID) },
    { name: 'commitState', kind: 'guarded-write', call: (r) => r.commitState({
      intentId: INTENT_ID, clientOrderId: CLIENT_ORDER_ID, accountId: ACCOUNT, pair: PAIR, state: 'ACKNOWLEDGED',
      exchangeOrderId: 'venue-1', orderedQuantity: '0.5', cumulativeFilledQuantity: '0', remainingQuantity: '0.5',
      averageFillPrice: null, lastExchangeStatus: 'open', lastProviderEventTimeMs: 1_000, faultCode: null,
      cancelState: 'NONE', cancelGeneration: 0, cancelExchangeOrderId: null, cancelFaultCode: null, revision: 3,
    }, 2) },
    { name: 'loadPositionOwnership', kind: 'undigested-read', call: (r) => r.loadPositionOwnership(ACCOUNT, PAIR) },
  ];

  it('enumerates every public method of the repository', () => {
    const declared = Object.getOwnPropertyNames(PrismaLiveExecutionRepository.prototype)
      .filter((name) => name !== 'constructor')
      .sort();
    expect(declared).toEqual([...paths].map((path) => path.name).sort());
  });

  it.each(paths.filter((path) => path.kind === 'verified-read'))('$name refuses a poisoned database', async ({ call }) => {
    const { repository, db } = await seeded();
    await acknowledged(repository);
    // Poison AFTER the order has been driven to a live state, so each path
    // reaches its real body rather than tripping an unrelated precondition.
    tamperIntent(db, 'contentSha256', 'f'.repeat(64));
    await expect(call(repository)).rejects.toThrow(INTEGRITY);
  });

  it('loadPositionOwnership is the only unverified read, and it authorizes nothing on its own', async () => {
    const { repository, db } = await seeded();
    db.positions.set(`${ACCOUNT}:${PAIR}`, {
      accountId: ACCOUNT, pair: PAIR, positionInstanceId: 'position-1', revision: 3, side: 'LONG',
      quantity: { toFixed: () => '0.500000000000000000' }, instrumentSpecSnapshotId: 'spec-1', ownerStrategyInstanceId: 'instance-1',
      ownerStrategyId: 'EMA_TREND', ownerStrategyVersion: '1.0.0', ownerParameterHash: 'p'.repeat(64),
    });
    await expect(repository.loadPositionOwnership(ACCOUNT, PAIR)).resolves.not.toBeNull();

    // A hostile position row cannot widen a CLOSE: the only consumer compares
    // it against the digest-verified intent, so a mismatch is a refusal.
    const close = intentRecord({
      content: {
        ...intentRecord().content,
        action: 'CLOSE', side: 'SELL', leverage: null, admissionId: null,
        positionInstanceId: 'position-1', positionRevision: 3, reduceOnlyQuantity: '0.5',
      },
    });
    const fresh = await seeded(close);
    fresh.db.positions.set(`${ACCOUNT}:${PAIR}`, {
      accountId: ACCOUNT, pair: PAIR, positionInstanceId: 'position-attacker', revision: 99, side: 'LONG',
      quantity: '999', instrumentSpecSnapshotId: 'spec-1', ownerStrategyInstanceId: 'instance-1',
      ownerStrategyId: 'EMA_TREND', ownerStrategyVersion: '1.0.0', ownerParameterHash: 'p'.repeat(64),
    });
    await expect(fresh.repository.claimDispatch(INTENT_ID)).rejects.toThrow(/LIVE_AUTHORITY_INVALID/);
  });

  it('exposes the verification helper as a real, callable boundary', () => {
    const healthy = { ...intentRecord().content, intentId: INTENT_ID, clientOrderId: CLIENT_ORDER_ID, wireOrderType: 'limit_order',
      sourceStrategyDecisionId: 'decision-1', validationSubjectId: 'subject-1', validationPlanId: 'plan-1',
      validationSubjectResultSha256: 'r'.repeat(64) } as Row;
    healthy['contentSha256'] = liveExecutionIntentContentSha256(intentRecord());
    expect(verifyStoredIntentIntegrity(healthy).digest).toBe(healthy['contentSha256']);
    expect(() => verifyStoredIntentIntegrity({ ...healthy, contentSha256: 'nope' })).toThrow(LiveExecutionError);
  });
});
