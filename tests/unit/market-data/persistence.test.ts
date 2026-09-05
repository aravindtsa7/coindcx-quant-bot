import { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { CanonicalMarketDataEngine } from '../../../src/market-data/canonical-engine';
import { CanonicalCandleConflictError, CanonicalCandleError } from '../../../src/market-data/errors';
import { createCanonicalCandle1m } from '../../../src/market-data/models';
import { PrismaCandle1mRepository } from '../../../src/market-data/persistence/candle-repository';
import { CanonicalCandle1m, CanonicalStreamEvent } from '../../../src/market-data/types';
import {
  createTestCandlePayload,
  createTestEnvelope,
  FakeClock,
  InMemoryCandleRepository,
  ManualScheduler,
} from './test-helpers';

describe('Phase 5 — Immutable Persistence & Persist-Before-Publish', () => {
  const PAIR = 'B-BTC_USDT';
  const MINUTE_0 = 1700000040000;
  const MINUTE_1 = 1700000100000;

  function createSampleCandle(overrides: Partial<Parameters<typeof createCanonicalCandle1m>[0]> = {}): CanonicalCandle1m {
    return createCanonicalCandle1m({
      pair: PAIR,
      openTimeMs: MINUTE_0,
      open: new Decimal('50000.0'),
      high: new Decimal('50100.0'),
      low: new Decimal('49900.0'),
      close: new Decimal('50050.0'),
      volume: new Decimal('10.0'),
      quoteVolume: new Decimal('500500.0'),
      source: 'WS_FINALIZED',
      finalizedAtMs: MINUTE_0 + 61000,
      providerEventTimeMs: null,
      generationId: null,
      ...overrides,
    });
  }

  it('28. empty DB startup does not invent prehistory', async () => {
    const clock = new FakeClock(MINUTE_0 + 30000);
    const repo = new InMemoryCandleRepository();
    const engine = new CanonicalMarketDataEngine({ repository: repo, clock });

    await engine.initializePair(PAIR);

    // Baseline is null; no pre-existing candles
    expect(engine.getPairHealth(PAIR)?.latestCanonicalOpenTimeMs).toBeNull();
    expect(engine.getPairHealth(PAIR)?.gapCount).toBe(0);
    expect(engine.getPairHealth(PAIR)?.state).toBe('HEALTHY');

    // First snapshot establishes baseline without triggering recovery back to epoch 0
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0 }))
    );

    expect(engine.getPairHealth(PAIR)?.gapCount).toBe(0);
    expect(engine.getPairHealth(PAIR)?.state).toBe('HEALTHY');
    engine.stop();
  });

  it('29. persisted restart resumes from latest canonical minute', async () => {
    const clock = new FakeClock(MINUTE_1 + 30000);
    const repo = new InMemoryCandleRepository();

    // Pre-populate database with persisted candle from prior run
    const priorCandle = createSampleCandle({ openTimeMs: MINUTE_0 });
    await repo.insertCandle(priorCandle);

    const engine = new CanonicalMarketDataEngine({ repository: repo, clock });
    await engine.initializePair(PAIR);

    // Initialized from latest DB row
    expect(engine.getPairHealth(PAIR)?.latestCanonicalOpenTimeMs).toBe(MINUTE_0);

    // Next expected minute (MINUTE_1) connects cleanly without gap
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1 }))
    );

    expect(engine.getPairHealth(PAIR)?.gapCount).toBe(0);
    expect(engine.getPairHealth(PAIR)?.state).toBe('HEALTHY');
    engine.stop();
  });

  it('30. persist occurs before event publish', async () => {
    const clock = new FakeClock(MINUTE_0 + 35000);
    const scheduler = new ManualScheduler();
    const repo = new InMemoryCandleRepository();
    const publishedEvents: CanonicalStreamEvent[] = [];
    const executionOrder: string[] = [];

    // Wrap insertCandle to record execution timing
    const originalInsert = repo.insertCandle.bind(repo);
    repo.insertCandle = async (candle: CanonicalCandle1m) => {
      executionOrder.push('DB_INSERT_STARTED');
      const res = await originalInsert(candle);
      executionOrder.push('DB_INSERT_COMMITTED');
      return res;
    };

    const engine = new CanonicalMarketDataEngine({
      repository: repo,
      clock,
      scheduler,
      finalizationGraceMs: 500,
    });
    await engine.initializePair(PAIR);

    engine.subscribe((event) => {
      executionOrder.push(`EVENT_PUBLISHED:${event.eventType}`);
      publishedEvents.push(event);
    });

    // Feed minute 0 and successor minute 1
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0 }))
    );

    clock.setTime(MINUTE_1 + 35000);
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1 }))
    );

    scheduler.advanceTime(600); // Trigger finalization grace
    await new Promise((r) => setTimeout(r, 10));

    // Verify ordering: DB committed BEFORE CANONICAL_1M_CLOSED published
    expect(executionOrder).toEqual([
      'DB_INSERT_STARTED',
      'DB_INSERT_COMMITTED',
      'EVENT_PUBLISHED:CANONICAL_1M_CLOSED',
    ]);
    expect(publishedEvents.length).toBe(1);
    expect(publishedEvents[0]!.eventType).toBe('CANONICAL_1M_CLOSED');
    engine.stop();
  });

  it('31. DB failure prevents publish', async () => {
    const clock = new FakeClock(MINUTE_0 + 35000);
    const scheduler = new ManualScheduler();
    const repo = new InMemoryCandleRepository();
    const publishedEvents: CanonicalStreamEvent[] = [];

    // Force DB failure
    repo.insertCandle = async () => {
      throw new CanonicalCandleError('Simulated DB disk failure / connection lost');
    };

    const engine = new CanonicalMarketDataEngine({
      repository: repo,
      clock,
      scheduler,
      finalizationGraceMs: 500,
    });
    await engine.initializePair(PAIR);

    engine.subscribe((event) => {
      publishedEvents.push(event);
    });

    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0 }))
    );

    clock.setTime(MINUTE_1 + 35000);
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1 }))
    );

    scheduler.advanceTime(600);
    await new Promise((r) => setTimeout(r, 10));

    // Persistence failed: CANONICAL_1M_CLOSED must NOT be published
    const closedEvents = publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED');
    expect(closedEvents.length).toBe(0);

    // Pair health must degrade fail-closed
    expect(engine.getPairHealth(PAIR)?.state).toBe('DEGRADED');
    engine.stop();
  });

  it('32. duplicate DB identical row is idempotent', async () => {
    interface MockRow {
      pair: string;
      openTimeMs: bigint;
      closeTimeMs: bigint;
      open: Prisma.Decimal;
      high: Prisma.Decimal;
      low: Prisma.Decimal;
      close: Prisma.Decimal;
      volume: Prisma.Decimal;
      quoteVolume: Prisma.Decimal | null;
      source: string;
      providerEventTimeMs: bigint | null;
      generationId: number | null;
      finalizedAt: Date;
    }
    const store = new Map<string, MockRow>();

    // Mock PrismaClient to simulate MySQL UNIQUE constraint P2002 on duplicate insert
    const mockPrisma = {
      candle1m: {
        create: async ({ data }: { data: Prisma.Candle1mCreateInput }): Promise<MockRow> => {
          const key = `${data.pair}:${data.openTimeMs.toString()}`;
          if (store.has(key)) {
            const p2002Err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: '5.x',
            });
            throw p2002Err;
          }
          const row: MockRow = {
            pair: data.pair,
            openTimeMs: data.openTimeMs as bigint,
            closeTimeMs: data.closeTimeMs as bigint,
            open: data.open as Prisma.Decimal,
            high: data.high as Prisma.Decimal,
            low: data.low as Prisma.Decimal,
            close: data.close as Prisma.Decimal,
            volume: data.volume as Prisma.Decimal,
            quoteVolume: (data.quoteVolume ?? null) as Prisma.Decimal | null,
            source: data.source,
            providerEventTimeMs: (data.providerEventTimeMs ?? null) as bigint | null,
            generationId: (data.generationId ?? null) as number | null,
            finalizedAt: data.finalizedAt as Date,
          };
          store.set(key, row);
          return row;
        },
        findUnique: async ({
          where,
        }: {
          where: { pair_openTimeMs: { pair: string; openTimeMs: bigint } };
        }): Promise<MockRow | null> => {
          const key = `${where.pair_openTimeMs.pair}:${where.pair_openTimeMs.openTimeMs.toString()}`;
          const existing = store.get(key);
          if (!existing) return null;
          return existing;
        },
      },
    } as unknown as PrismaClient;

    const repo = new PrismaCandle1mRepository(mockPrisma);
    const candle = createSampleCandle();

    // First insert succeeds
    await repo.insertCandle(candle);

    // Second identical insert encounters P2002 and succeeds as idempotent no-op returning ALREADY_IDENTICAL
    const secondResult = await repo.insertCandle(candle);
    expect(secondResult.outcome).toBe('ALREADY_IDENTICAL');
  });

  it('33. duplicate DB conflicting row fails closed', async () => {
    interface MockRow {
      pair: string;
      openTimeMs: bigint;
      closeTimeMs: bigint;
      open: Prisma.Decimal;
      high: Prisma.Decimal;
      low: Prisma.Decimal;
      close: Prisma.Decimal;
      volume: Prisma.Decimal;
      quoteVolume: Prisma.Decimal | null;
      source: string;
      providerEventTimeMs: bigint | null;
      generationId: number | null;
      finalizedAt: Date;
    }
    const store = new Map<string, MockRow>();

    const mockPrisma = {
      candle1m: {
        create: async ({ data }: { data: Prisma.Candle1mCreateInput }): Promise<MockRow> => {
          const key = `${data.pair}:${data.openTimeMs.toString()}`;
          if (store.has(key)) {
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: '5.x',
            });
          }
          const row: MockRow = {
            pair: data.pair,
            openTimeMs: data.openTimeMs as bigint,
            closeTimeMs: data.closeTimeMs as bigint,
            open: data.open as Prisma.Decimal,
            high: data.high as Prisma.Decimal,
            low: data.low as Prisma.Decimal,
            close: data.close as Prisma.Decimal,
            volume: data.volume as Prisma.Decimal,
            quoteVolume: (data.quoteVolume ?? null) as Prisma.Decimal | null,
            source: data.source,
            providerEventTimeMs: (data.providerEventTimeMs ?? null) as bigint | null,
            generationId: (data.generationId ?? null) as number | null,
            finalizedAt: data.finalizedAt as Date,
          };
          store.set(key, row);
          return row;
        },
        findUnique: async ({
          where,
        }: {
          where: { pair_openTimeMs: { pair: string; openTimeMs: bigint } };
        }): Promise<MockRow | null> => {
          const key = `${where.pair_openTimeMs.pair}:${where.pair_openTimeMs.openTimeMs.toString()}`;
          const existing = store.get(key);
          if (!existing) return null;
          return existing;
        },
      },
    } as unknown as PrismaClient;

    const repo = new PrismaCandle1mRepository(mockPrisma);
    const candle1 = createSampleCandle({ close: new Decimal('50000.0') });
    await repo.insertCandle(candle1);

    // Second conflicting candle (different close price with valid OHLC)
    const candle2 = createSampleCandle({ high: new Decimal('52100.0'), close: new Decimal('52000.0') });

    // Must throw CanonicalCandleConflictError and never overwrite
    await expect(repo.insertCandle(candle2)).rejects.toThrow(CanonicalCandleConflictError);
  });

  it('34. late conflicting event cannot rewrite DB', async () => {
    const clock = new FakeClock(MINUTE_0 + 35000);
    const scheduler = new ManualScheduler();
    const repo = new InMemoryCandleRepository();

    const engine = new CanonicalMarketDataEngine({
      repository: repo,
      clock,
      scheduler,
      finalizationGraceMs: 500,
    });
    await engine.initializePair(PAIR);

    // Finalize MINUTE_0
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0, close: new Decimal('50050.0') }))
    );

    clock.setTime(MINUTE_1 + 35000);
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1 }))
    );
    scheduler.advanceTime(600);
    await new Promise((r) => setTimeout(r, 10));

    const persistedBefore = await repo.getCandle(PAIR, MINUTE_0);
    expect(persistedBefore?.close.toString()).toBe('50050');

    // Now a late conflicting event arrives for already finalized MINUTE_0 claiming close was 50090.0
    await engine.handleStreamEnvelope(
      createTestEnvelope(
        'PUBLIC_CANDLE_UPDATE',
        createTestCandlePayload({
          openTimeMs: MINUTE_0,
          providerEventTimeMs: MINUTE_0 + 40000,
          close: new Decimal('50090.0'),
        })
      )
    );
    await new Promise((r) => setTimeout(r, 10));

    // Database row must be preserved unmodified
    const persistedAfter = await repo.getCandle(PAIR, MINUTE_0);
    expect(persistedAfter?.close.toString()).toBe('50050');
    expect(engine.getPairHealth(PAIR)?.state).toBe('DEGRADED');
    engine.stop();
  });
});
