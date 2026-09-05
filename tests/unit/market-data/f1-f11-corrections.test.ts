import { describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { FakeClock } from '../../../src/integration/coindcx/clock';
import { CoinDcxPublicFuturesStream } from '../../../src/integration/coindcx/websocket/public-stream';
import { CanonicalDecimal } from '../../../src/market-data/canonical-decimal';
import { CanonicalMarketDataEngine } from '../../../src/market-data/canonical-engine';
import { CanonicalValidationError } from '../../../src/market-data/errors';
import { areCanonicalCandlesIdentical, createCanonicalCandle1m } from '../../../src/market-data/models';
import { PairCanonicalStateMachine } from '../../../src/market-data/pair-state';
import { InsertCandleResult } from '../../../src/market-data/persistence/candle-repository';
import { CoinDcxFuturesCandleRestReader, RestCandleRecord } from '../../../src/market-data/rest-candle-reader';
import { CanonicalCandle1m, CanonicalStreamEvent } from '../../../src/market-data/types';
import { ManualScheduler } from '../coindcx/ws/test-helpers';
import {
  InMemoryCandleRepository,
  TEST_BASE_MINUTE_MS,
  createTestCandlePayload,
  createTestEnvelope,
} from './test-helpers';

const PAIR = 'B-BTC_USDT';
const MINUTE_0 = TEST_BASE_MINUTE_MS; // 1700000040000 (aligned UTC minute)
const MINUTE_1 = MINUTE_0 + 60_000;
const MINUTE_2 = MINUTE_1 + 60_000;
const MINUTE_3 = MINUTE_2 + 60_000;

describe('Phase 5 — Consolidated Production Corrections (Terra F1–F11)', () => {
  // =========================================================================
  // F1: FINALIZATION OWNERSHIP MODEL
  // =========================================================================
  describe('F1: Per-Minute Finalization Ownership Model', () => {
    it('12:00 -> 12:01 -> 12:02 within grace: 12:00 is NEVER lost, both finalized in order', async () => {
      const clock = new FakeClock(MINUTE_0 + 50_000);
      const scheduler = new ManualScheduler();
      const repo = new InMemoryCandleRepository();
      const publishedEvents: CanonicalStreamEvent[] = [];

      const engine = new CanonicalMarketDataEngine({
        repository: repo,
        clock,
        scheduler,
        finalizationGraceMs: 70_000, // 70s grace allows 12:02 (60s later) to arrive while 12:00 grace is active
      });
      await engine.initializePair(PAIR);
      engine.subscribe((e) => publishedEvents.push(e));

      // 12:00 arrives
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({
          openTimeMs: MINUTE_0,
          providerEventTimeMs: MINUTE_0 + 50_000,
          close: new Decimal('50000'),
        }))
      );

      // 12:01 arrives (successor for 12:00, schedules 12:00 finalization with 70s grace)
      clock.setTime(MINUTE_1 + 1_000);
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({
          openTimeMs: MINUTE_1,
          providerEventTimeMs: MINUTE_1 + 1_000,
          close: new Decimal('50100'),
        }))
      );

      // 12:02 arrives 60s later (still 10s BEFORE 12:00 grace timer expires!)
      // Must schedule 12:01 finalization WITHOUT cancelling 12:00!
      clock.setTime(MINUTE_2 + 1_000);
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({
          openTimeMs: MINUTE_2,
          providerEventTimeMs: MINUTE_2 + 1_000,
          close: new Decimal('50200'),
        }))
      );

      // Advance scheduler past both grace periods
      scheduler.advanceTime(80_000);
      await new Promise((r) => setTimeout(r, 10));

      // Assert: BOTH 12:00 and 12:01 were finalized and persisted in order
      const candle0 = await repo.getCandle(PAIR, MINUTE_0);
      const candle1 = await repo.getCandle(PAIR, MINUTE_1);

      expect(candle0).not.toBeNull();
      expect(candle0?.openTimeMs).toBe(MINUTE_0);
      expect(candle0?.close.value).toBe('50000');

      expect(candle1).not.toBeNull();
      expect(candle1?.openTimeMs).toBe(MINUTE_1);
      expect(candle1?.close.value).toBe('50100');

      // Assert event ordering: 12:00 closed, then 12:01 closed
      const closedEvents = publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED');
      expect(closedEvents.length).toBe(2);
      expect((closedEvents[0]!.payload as CanonicalCandle1m).openTimeMs).toBe(MINUTE_0);
      expect((closedEvents[1]!.payload as CanonicalCandle1m).openTimeMs).toBe(MINUTE_1);

      engine.stop();
    });
  });

  // =========================================================================
  // F2: CONTINUITY BARRIER & WARM RESTART
  // =========================================================================
  describe('F2: Continuity Barrier & Warm Restart', () => {
    it('Warm restart: latest persisted 12:00, live 12:03 detects 12:01 & 12:02 gap before admitting 12:03', async () => {
      const clock = new FakeClock(MINUTE_3 + 10_000);
      const scheduler = new ManualScheduler();
      const repo = new InMemoryCandleRepository();

      // Seed repo with latest persisted candle = 12:00
      await repo.insertCandle(
        createCanonicalCandle1m({
          pair: PAIR,
          openTimeMs: MINUTE_0,
          open: '50000',
          high: '50100',
          low: '49900',
          close: '50050',
          volume: '10',
          quoteVolume: '500000',
          source: 'WS_FINALIZED',
          finalizedAtMs: MINUTE_0 + 61_000,
          providerEventTimeMs: MINUTE_0 + 59_000,
          generationId: 1,
        })
      );

      let requestedRecoveryRange: { fromMs: number; toMs: number } | null = null;
      const mockRestReader = {
        fetchClosedCandles: vi.fn(async (q: { fromMs: number; toMs: number }) => {
          requestedRecoveryRange = q;
          return [] as readonly RestCandleRecord[];
        }),
      } as unknown as CoinDcxFuturesCandleRestReader;

      const engine = new CanonicalMarketDataEngine({
        repository: repo,
        restReader: mockRestReader,
        clock,
        scheduler,
      });

      // Warm restart initializes latest canonical = 12:00
      await engine.initializePair(PAIR);
      const initHealth = engine.getPairHealth(PAIR)!;
      expect(initHealth.latestCanonicalOpenTimeMs).toBe(MINUTE_0);
      expect(initHealth.continuityWatermarkMs).toBe(MINUTE_0);

      // First live update arrives at 12:03 (jump of 3 minutes)
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({
          openTimeMs: MINUTE_3,
          providerEventTimeMs: MINUTE_3 + 5_000,
        }))
      );

      // Assert: pair state entered RECOVERING, gapCount incremented, live 12:03 buffered
      const health = engine.getPairHealth(PAIR)!;
      expect(health.state).toBe('RECOVERING');
      expect(health.gapCount).toBe(1);
      expect(health.bufferedLiveUpdateCount).toBe(1);

      // Missing interval requested: [12:01, 12:02]
      expect(requestedRecoveryRange).toEqual({
        pair: PAIR,
        fromMs: MINUTE_1,
        toMs: MINUTE_2,
      });

      engine.stop();
    });

    it('Warm restart: live packet <= latest canonical is treated as historical, does not advance freshness or working state', async () => {
      const clock = new FakeClock(MINUTE_2);
      const repo = new InMemoryCandleRepository();

      // Persist 12:00 and 12:01
      const candle0 = createCanonicalCandle1m({
        pair: PAIR,
        openTimeMs: MINUTE_0,
        open: '50000',
        high: '50000',
        low: '50000',
        close: '50000',
        volume: '1',
        quoteVolume: null,
        source: 'WS_FINALIZED',
        finalizedAtMs: MINUTE_0 + 60_000,
        providerEventTimeMs: null,
        generationId: 1,
      });
      await repo.insertCandle(candle0);

      const engine = new CanonicalMarketDataEngine({
        repository: repo,
        clock,
      });
      await engine.initializePair(PAIR);

      // Historical packet for 12:00 arrives (matches persisted row)
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({
          openTimeMs: MINUTE_0,
          open: new Decimal('50000'),
          high: new Decimal('50000'),
          low: new Decimal('50000'),
          close: new Decimal('50000'),
          volume: new Decimal('1'),
          quoteVolume: null,
        }))
      );

      const health = engine.getPairHealth(PAIR)!;
      expect(health.workingOpenTimeMs).toBeNull(); // Did not advance working candle
      expect(health.duplicateCount).toBe(1);

      engine.stop();
    });
  });

  // =========================================================================
  // F3: ASYNC EPOCH SAFETY & DISCONNECT RACE
  // =========================================================================
  describe('F3: Async Epoch Safety & Disconnect Race', () => {
    it('generation1 finalization awaiting DB aborts publication if reconnect/recovery starts before DB resolves', async () => {
      const clock = new FakeClock(MINUTE_0 + 35_000);
      const scheduler = new ManualScheduler();
      const repo = new InMemoryCandleRepository();
      const publishedEvents: CanonicalStreamEvent[] = [];

      let resolveDbInsert!: (value: InsertCandleResult) => void;
      const slowInsertPromise = new Promise<InsertCandleResult>((resolve) => {
        resolveDbInsert = resolve;
      });

      // Hook repository insertCandle to hang on MINUTE_0
      repo.insertCandle = vi.fn().mockImplementation(async (candle: CanonicalCandle1m) => {
        if (candle.openTimeMs === MINUTE_0) {
          return slowInsertPromise;
        }
        return { outcome: 'INSERTED' };
      });

      const engine = new CanonicalMarketDataEngine({
        repository: repo,
        clock,
        scheduler,
        finalizationGraceMs: 500,
      });
      await engine.initializePair(PAIR);
      engine.subscribe((e) => publishedEvents.push(e));

      // 12:00 arrives, then successor 12:01 arrives
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0 }), { generationId: 1 })
      );
      clock.setTime(MINUTE_1 + 35_000);
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1 }), { generationId: 1 })
      );

      // Trigger finalization timer -> enters async insertCandle
      scheduler.advanceTime(600);

      // Reconnect barrier arrives (generation 2 active, starts recovery)
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_STREAM_RECOVERY_REQUIRED', {
          stream: 'PUBLIC_FUTURES',
          previousGeneration: 1,
          newGeneration: 2,
          reason: 'RECONNECT',
        }, { generationId: 2 })
      );

      // Now the old DB insert resolves
      resolveDbInsert({ outcome: 'INSERTED' });
      await new Promise((r) => setTimeout(r, 10));

      // Assert: generation 1 callback did NOT emit CANONICAL_1M_CLOSED because epoch changed!
      const closedEvents = publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED');
      expect(closedEvents.length).toBe(0);

      engine.stop();
    });
  });

  // =========================================================================
  // F4: SINGLE-OWNER RECOVERY & DUPLICATE INSERT OUTCOME
  // =========================================================================
  describe('F4: Single-Owner Recovery & Deduplication', () => {
    it('Real ACTIVE Recovery A superseded by real ACTIVE Recovery B: A cannot commit/clear-fault/drain/complete after being superseded', async () => {
      // Unlike a prior version of this test, neither recovery epoch is invented via an explicit
      // parameter: both A and B call executeRecovery() WITHOUT an epoch, so each one calls the real
      // pairState.enterRecovery() internally and genuinely becomes the ACTIVE recovery epoch, exactly
      // as production code does. A stale epoch value passed directly could never exercise a real race.
      const clock = new FakeClock(MINUTE_3 + 10_000);
      const repo = new InMemoryCandleRepository();
      const publishedEvents: CanonicalStreamEvent[] = [];

      let resolveA!: (records: readonly RestCandleRecord[]) => void;
      let resolveB!: (records: readonly RestCandleRecord[]) => void;
      const hangingA = new Promise<readonly RestCandleRecord[]>((resolve) => {
        resolveA = resolve;
      });
      const hangingB = new Promise<readonly RestCandleRecord[]>((resolve) => {
        resolveB = resolve;
      });
      let fetchCallCount = 0;
      const restReader = {
        fetchClosedCandles: vi.fn().mockImplementation(() => {
          fetchCallCount++;
          return fetchCallCount === 1 ? hangingA : hangingB;
        }),
      } as unknown as CoinDcxFuturesCandleRestReader;

      const engine = new CanonicalMarketDataEngine({ repository: repo, restReader, clock });
      const pairState = await engine.initializePair(PAIR);
      engine.subscribe((e) => publishedEvents.push(e));

      expect(pairState.recoveryEpoch).toBe(1);

      // Recovery A: genuinely calls enterRecovery() internally, really bumping recoveryEpoch to 2.
      const promiseA = engine.executeRecovery(PAIR, MINUTE_1, MINUTE_1);
      expect(pairState.recoveryEpoch).toBe(2);
      expect(pairState.state).toBe('RECOVERING');

      // Buffer a live update while still genuinely RECOVERING (from A) -- only a real B completing
      // should ever drain it.
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_3, providerEventTimeMs: MINUTE_3 + 5_000 }))
      );
      expect(pairState.getHealthSnapshot().bufferedLiveUpdateCount).toBe(1);

      // Recovery B genuinely supersedes A: also calls enterRecovery() for real, bumping to 3.
      const promiseB = engine.executeRecovery(PAIR, MINUTE_1, MINUTE_2);
      expect(pairState.recoveryEpoch).toBe(3);

      // Resolve A's (now-stale) REST fetch with poisoned data.
      resolveA([
        {
          pair: PAIR,
          openTimeMs: MINUTE_1,
          open: new Decimal('999'),
          high: new Decimal('999'),
          low: new Decimal('999'),
          close: new Decimal('999'),
          volume: new Decimal('1'),
          quoteVolume: null,
        },
      ]);
      await promiseA;

      // A must have accomplished NOTHING: no persisted candle from A's poisoned data, RECOVERING still
      // active, buffer still undrained, no RECOVERY_COMPLETED emitted for A.
      expect(await repo.getCandle(PAIR, MINUTE_1)).toBeNull();
      expect(pairState.state).toBe('RECOVERING');
      expect(pairState.truthFault).toBe('NONE');
      expect(pairState.getHealthSnapshot().bufferedLiveUpdateCount).toBe(1);
      expect(publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_RECOVERY_COMPLETED').length).toBe(0);

      // Now let B resolve with the real, correct coverage.
      resolveB([
        {
          pair: PAIR,
          openTimeMs: MINUTE_1,
          open: new Decimal('1'),
          high: new Decimal('1'),
          low: new Decimal('1'),
          close: new Decimal('1'),
          volume: new Decimal('1'),
          quoteVolume: null,
        },
        {
          pair: PAIR,
          openTimeMs: MINUTE_2,
          open: new Decimal('1'),
          high: new Decimal('1'),
          low: new Decimal('1'),
          close: new Decimal('1'),
          volume: new Decimal('1'),
          quoteVolume: null,
        },
      ]);
      await promiseB;

      // B completes normally: persists both minutes with B's data (never A's poisoned '999'), drains
      // the buffer, returns to HEALTHY, and emits exactly one RECOVERY_COMPLETED.
      expect(pairState.state).toBe('HEALTHY');
      expect(pairState.getHealthSnapshot().bufferedLiveUpdateCount).toBe(0);
      const candle1 = await repo.getCandle(PAIR, MINUTE_1);
      const candle2 = await repo.getCandle(PAIR, MINUTE_2);
      expect(candle1?.close.value).toBe('1');
      expect(candle2?.close.value).toBe('1');
      expect(publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_RECOVERY_COMPLETED').length).toBe(1);

      engine.stop();
    });

    it('Duplicate identical DB row produces at most one CANONICAL_1M_CLOSED publication', async () => {
      const clock = new FakeClock(MINUTE_0 + 35_000);
      const scheduler = new ManualScheduler();
      const repo = new InMemoryCandleRepository();
      const publishedEvents: CanonicalStreamEvent[] = [];

      const engine = new CanonicalMarketDataEngine({
        repository: repo,
        clock,
        scheduler,
        finalizationGraceMs: 500,
      });
      await engine.initializePair(PAIR);
      engine.subscribe((e) => publishedEvents.push(e));

      // Pre-seed identical candle into repository
      await repo.insertCandle(
        createCanonicalCandle1m({
          pair: PAIR,
          openTimeMs: MINUTE_0,
          open: '50000',
          high: '50000',
          low: '50000',
          close: '50000',
          volume: '10',
          quoteVolume: null,
          source: 'WS_FINALIZED',
          finalizedAtMs: MINUTE_0 + 60_000,
          providerEventTimeMs: MINUTE_0 + 50_000,
          generationId: 1,
        })
      );

      // Now live finalization attempts to finalize identical MINUTE_0
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({
          openTimeMs: MINUTE_0,
          open: new Decimal('50000'),
          high: new Decimal('50000'),
          low: new Decimal('50000'),
          close: new Decimal('50000'),
          volume: new Decimal('10'),
          quoteVolume: null,
        }))
      );
      clock.setTime(MINUTE_1 + 35_000);
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1 }))
      );

      scheduler.advanceTime(600);
      await new Promise((r) => setTimeout(r, 10));

      // Repo returned ALREADY_IDENTICAL: must NOT publish duplicate CANONICAL_1M_CLOSED
      const closedEvents = publishedEvents.filter(
        (e) => e.eventType === 'CANONICAL_1M_CLOSED' && (e.payload as CanonicalCandle1m).openTimeMs === MINUTE_0
      );
      expect(closedEvents.length).toBe(0);

      engine.stop();
    });
  });

  // =========================================================================
  // F5: FAIL-CLOSED TRUTH FAULT LATCH
  // =========================================================================
  describe('F5: Fail-Closed Truth Fault Latch', () => {
    it('Material conflict latches truth fault: next normal packet CANNOT auto-heal to HEALTHY, blocks future closes', async () => {
      const clock = new FakeClock(MINUTE_1 + 10_000);
      const scheduler = new ManualScheduler();
      const repo = new InMemoryCandleRepository();
      const publishedEvents: CanonicalStreamEvent[] = [];

      // Pre-seed 12:00 in repo with close = 50000
      await repo.insertCandle(
        createCanonicalCandle1m({
          pair: PAIR,
          openTimeMs: MINUTE_0,
          open: '50000',
          high: '50000',
          low: '50000',
          close: '50000',
          volume: '10',
          quoteVolume: null,
          source: 'WS_FINALIZED',
          finalizedAtMs: MINUTE_0 + 60_000,
          providerEventTimeMs: null,
          generationId: 1,
        })
      );

      const engine = new CanonicalMarketDataEngine({
        repository: repo,
        clock,
        scheduler,
        finalizationGraceMs: 500,
      });
      await engine.initializePair(PAIR);
      engine.subscribe((e) => publishedEvents.push(e));

      // Late conflicting packet for 12:00 arrives with close = 55000
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({
          openTimeMs: MINUTE_0,
          close: new Decimal('55000'),
        }))
      );

      const healthAfterConflict = engine.getPairHealth(PAIR)!;
      expect(healthAfterConflict.truthFault).toBe('CANONICAL_CONFLICT');
      expect(healthAfterConflict.state).toBe('DEGRADED');

      // Next normal 12:01 packet arrives
      clock.setTime(MINUTE_1 + 35_000);
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1 }))
      );

      // Truth fault MUST NOT be auto-healed to HEALTHY
      const healthAfterPacket = engine.getPairHealth(PAIR)!;
      expect(healthAfterPacket.truthFault).toBe('CANONICAL_CONFLICT');
      expect(healthAfterPacket.state).toBe('DEGRADED');

      // Successor 12:02 arrives to attempt 12:01 finalization
      clock.setTime(MINUTE_2 + 35_000);
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_2 }))
      );
      scheduler.advanceTime(600);

      // Publication is blocked due to active truth fault!
      const closedEvents = publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED');
      expect(closedEvents.length).toBe(0);

      engine.stop();
    });
  });

  // =========================================================================
  // F6: CANONICAL IMMUTABILITY
  // =========================================================================
  describe('F6: Canonical Immutability', () => {
    it('Nested Decimal internal mutation attempt fails to modify published CanonicalDecimal values', () => {
      const candle = createCanonicalCandle1m({
        pair: PAIR,
        openTimeMs: MINUTE_0,
        open: '50000.1234',
        high: '50100',
        low: '49900',
        close: '50050',
        volume: '10.5',
        quoteVolume: null,
        source: 'WS_FINALIZED',
        finalizedAtMs: MINUTE_0 + 60_000,
        providerEventTimeMs: null,
        generationId: 1,
      });

      // Try mutating primitive value property or prototype
      try {
        (candle.open as unknown as Record<string, unknown>).value = '999999';
      } catch {
        // Expected in strict mode
      }
      expect(candle.open.value).toBe('50000.1234');
      expect(candle.open.toString()).toBe('50000.1234');

      // Try mutating Decimal internals if caller converts to Decimal
      const dec = candle.open.toDecimal();
      (dec as unknown as Record<string, unknown>).c = [9999]; // Mutate isolated copy
      expect(candle.open.value).toBe('50000.1234'); // Canonical value remains unaffected
    });
  });

  // =========================================================================
  // F7: QUOTE VOLUME EQUALITY
  // =========================================================================
  describe('F7: Quote Volume Truth Equality', () => {
    it('areCanonicalCandlesIdentical strictly enforces null !== Decimal(0)', () => {
      const baseParams = {
        pair: PAIR,
        openTimeMs: MINUTE_0,
        open: '50000',
        high: '50000',
        low: '50000',
        close: '50000',
        volume: '1',
        source: 'WS_FINALIZED' as const,
        finalizedAtMs: MINUTE_0 + 60_000,
        providerEventTimeMs: null,
        generationId: 1,
      };

      const candleNullQuote = createCanonicalCandle1m({ ...baseParams, quoteVolume: null });
      const candleZeroQuote = createCanonicalCandle1m({ ...baseParams, quoteVolume: '0' });
      const candleEqualQuote = createCanonicalCandle1m({ ...baseParams, quoteVolume: '50000' });
      const candleDiffQuote = createCanonicalCandle1m({ ...baseParams, quoteVolume: '50001' });

      // null !== Decimal(0)
      expect(areCanonicalCandlesIdentical(candleNullQuote, candleZeroQuote)).toBe(false);
      expect(areCanonicalCandlesIdentical(candleZeroQuote, candleNullQuote)).toBe(false);

      // matching quoteVolume
      expect(areCanonicalCandlesIdentical(candleNullQuote, candleNullQuote)).toBe(true);
      expect(areCanonicalCandlesIdentical(candleEqualQuote, candleEqualQuote)).toBe(true);

      // mismatching quoteVolume
      expect(areCanonicalCandlesIdentical(candleEqualQuote, candleDiffQuote)).toBe(false);
    });
  });

  // =========================================================================
  // F8: DB PRECISION & SCALE VALIDATION
  // =========================================================================
  describe('F8: DB Precision & Scale Validation (DECIMAL 36, 18)', () => {
    it('Accepts 18 decimal scale digits, rejects 19 decimal scale digits', () => {
      // 18 digits fractional: accepted
      const valid18 = '1.123456789012345678';
      const dec18 = new CanonicalDecimal(valid18);
      expect(dec18.value).toBe(valid18);

      // 19 digits fractional: rejected
      const invalid19 = '1.1234567890123456789';
      expect(() => new CanonicalDecimal(invalid19)).toThrow(CanonicalValidationError);
      expect(() => new CanonicalDecimal(invalid19)).toThrow(/Scale exceeds maximum supported 18 digits/);
    });

    it('Rejects total precision > 36 digits and integer digits > 18', () => {
      // 19 integer digits: rejected
      const invalidInt = '1234567890123456789.0';
      expect(() => new CanonicalDecimal(invalidInt)).toThrow(CanonicalValidationError);

      // 18 integer digits + 18 fractional digits = 36 total digits: accepted
      const valid36 = '123456789012345678.123456789012345678';
      expect(new CanonicalDecimal(valid36).value).toBe(valid36);
    });

    it('Rejects exponential notation', () => {
      expect(() => new CanonicalDecimal('1e-5')).toThrow(CanonicalValidationError);
      expect(() => new CanonicalDecimal('2.5E+4')).toThrow(CanonicalValidationError);
    });
  });

  // =========================================================================
  // F9: CANDLE-TIME SAFETY
  // =========================================================================
  describe('F9: Candle-Time Safety', () => {
    it('Rejects implausibly far-future candle openings even if provider timestamp is fresh', async () => {
      const clock = new FakeClock(MINUTE_0 + 35_000);
      const stateMachine = new PairCanonicalStateMachine(
        { pair: PAIR, clock },
        {
          onFinalizeCandle: async () => {},
          onRequestRecovery: async () => {},
          onConflictDetected: () => {},
          getPersistedCandle: async () => null,
        }
      );

      // Year 5000 open time: 95617584000000
      const year5000OpenTime = 95617584000000;
      await stateMachine.handleCandleUpdate(
        createTestCandlePayload({
          openTimeMs: year5000OpenTime,
          providerEventTimeMs: MINUTE_0 + 35_000, // fresh provider timestamp
        })
      );

      const health = stateMachine.getHealthSnapshot();
      expect(health.truthFault).toBe('TIME_INVALID');
      expect(health.state).toBe('INVALID');

      stateMachine.stop();
    });

    it('Rejects non-safe integer or unaligned candle times', () => {
      expect(() =>
        createCanonicalCandle1m({
          pair: PAIR,
          openTimeMs: Number.MAX_SAFE_INTEGER + 10,
          open: '50000',
          high: '50000',
          low: '50000',
          close: '50000',
          volume: '1',
          quoteVolume: null,
          source: 'WS_FINALIZED',
          finalizedAtMs: 1000,
          providerEventTimeMs: null,
          generationId: 1,
        })
      ).toThrow(CanonicalValidationError);

      expect(() =>
        createCanonicalCandle1m({
          pair: PAIR,
          openTimeMs: MINUTE_0 + 12345, // Not 60s aligned
          open: '50000',
          high: '50000',
          low: '50000',
          close: '50000',
          volume: '1',
          quoteVolume: null,
          source: 'WS_FINALIZED',
          finalizedAtMs: 1000,
          providerEventTimeMs: null,
          generationId: 1,
        })
      ).toThrow(CanonicalValidationError);
    });
  });

  // =========================================================================
  // F10: FULL ENVELOPE RECOVERY BUFFER
  // =========================================================================
  describe('F10: Full Envelope Recovery Buffer', () => {
    it('Coalesces same-minute snapshots in-place and preserves original sequence and timestamps', async () => {
      const clock = new FakeClock(MINUTE_1 + 10_000);
      const stateMachine = new PairCanonicalStateMachine(
        { pair: PAIR, clock, maxRecoveryBuffer: 10 },
        {
          onFinalizeCandle: async () => {},
          onRequestRecovery: async () => {},
          onConflictDetected: () => {},
          getPersistedCandle: async () => null,
        }
      );

      stateMachine.enterRecovery();

      // Envelope 1: seq 10, close 50000
      const env1 = createTestEnvelope(
        'PUBLIC_CANDLE_UPDATE',
        createTestCandlePayload({ openTimeMs: MINUTE_1, providerEventTimeMs: MINUTE_1 + 5_000, close: new Decimal('50000') }),
        { sequence: 10, receivedAtMs: 1000 }
      );
      await stateMachine.handleStreamEnvelope(env1);
      expect(stateMachine.getHealthSnapshot().bufferedLiveUpdateCount).toBe(1);

      // Envelope 2: seq 11 (newer), close 50100 -> coalesced in-place
      const env2 = createTestEnvelope(
        'PUBLIC_CANDLE_UPDATE',
        createTestCandlePayload({ openTimeMs: MINUTE_1, providerEventTimeMs: MINUTE_1 + 6_000, close: new Decimal('50100') }),
        { sequence: 11, receivedAtMs: 1050 }
      );
      await stateMachine.handleStreamEnvelope(env2);
      expect(stateMachine.getHealthSnapshot().bufferedLiveUpdateCount).toBe(1);

      // Envelope 3: duplicate of seq 11 -> ignored
      await stateMachine.handleStreamEnvelope(env2);
      expect(stateMachine.getHealthSnapshot().bufferedLiveUpdateCount).toBe(1);

      stateMachine.stop();
    });

    it('Buffer overflow triggers BUFFER_OVERFLOW truth fault and fails closed', async () => {
      const clock = new FakeClock(MINUTE_3 + 10_000);
      const stateMachine = new PairCanonicalStateMachine(
        { pair: PAIR, clock, maxRecoveryBuffer: 2 },
        {
          onFinalizeCandle: async () => {},
          onRequestRecovery: async () => {},
          onConflictDetected: () => {},
          getPersistedCandle: async () => null,
        }
      );

      stateMachine.enterRecovery();

      await stateMachine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1, providerEventTimeMs: MINUTE_1 }), { sequence: 1 })
      );
      await stateMachine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_2, providerEventTimeMs: MINUTE_2 }), { sequence: 2 })
      );
      // Exceed capacity
      await stateMachine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_3, providerEventTimeMs: MINUTE_3 }), { sequence: 3 })
      );

      const health = stateMachine.getHealthSnapshot();
      expect(health.truthFault).toBe('BUFFER_OVERFLOW');
      expect(health.state).toBe('INVALID');

      stateMachine.stop();
    });
  });

  // =========================================================================
  // F11: ENGINE LIFECYCLE & SINGLE LISTENER
  // =========================================================================
  describe('F11: Engine Lifecycle & Single Listener', () => {
    it('Calling start() multiple times registers stream listener exactly once and is idempotent', async () => {
      let listenerCount = 0;
      const mockStream = {
        subscribe: vi.fn(() => {
          listenerCount++;
          return () => {
            listenerCount--;
          };
        }),
      } as unknown as CoinDcxPublicFuturesStream;

      const engine = new CanonicalMarketDataEngine({
        publicStream: mockStream,
      });

      expect(engine.lifecycleState).toBe('STOPPED');

      await engine.start();
      expect(engine.lifecycleState).toBe('RUNNING');
      expect(listenerCount).toBe(1);

      // Concurrent / sequential second start()
      await engine.start();
      expect(engine.lifecycleState).toBe('RUNNING');
      expect(listenerCount).toBe(1); // No duplicate listener registered!

      engine.stop();
      expect(engine.lifecycleState).toBe('STOPPED');
      expect(listenerCount).toBe(0);

      // Idempotent stop
      engine.stop();
      expect(engine.lifecycleState).toBe('STOPPED');
      expect(listenerCount).toBe(0);
    });

    it('Safe event dispatch: subscriber throwing an error does not corrupt engine or cause unhandled rejections', async () => {
      const clock = new FakeClock(MINUTE_0 + 35_000);
      const scheduler = new ManualScheduler();
      const repo = new InMemoryCandleRepository();

      const engine = new CanonicalMarketDataEngine({
        repository: repo,
        clock,
        scheduler,
        finalizationGraceMs: 500,
      });
      await engine.initializePair(PAIR);

      // Rogue subscriber throws
      engine.subscribe(() => {
        throw new Error('Subscriber exploded');
      });

      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0 }))
      );
      clock.setTime(MINUTE_1 + 35_000);
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1 }))
      );

      // Advancing timer finalizes candle, invokes throwing subscriber safely
      scheduler.advanceTime(600);
      await new Promise((r) => setTimeout(r, 10));

      const candle = await repo.getCandle(PAIR, MINUTE_0);
      expect(candle).not.toBeNull();

      engine.stop();
    });
  });

  // =========================================================================
  // STALENESS TIMER REARM
  // =========================================================================
  describe('Staleness Timer Rearm', () => {
    it('Rearms staleness deadline deterministically after healthy intervals and marks STALE on later inactivity', async () => {
      const clock = new FakeClock(MINUTE_0);
      const scheduler = new ManualScheduler();
      const stateMachine = new PairCanonicalStateMachine(
        { pair: PAIR, clock, scheduler, staleThresholdMs: 60_000 },
        {
          onFinalizeCandle: async () => {},
          onRequestRecovery: async () => {},
          onConflictDetected: () => {},
          getPersistedCandle: async () => null,
        }
      );

      // Packet arrives at T=0
      await stateMachine.handleCandleUpdate(createTestCandlePayload({
        openTimeMs: MINUTE_0,
        providerEventTimeMs: MINUTE_0,
      }));
      expect(stateMachine.state).toBe('HEALTHY');

      // Activity arrives at T=40s (shortly before 60s check)
      clock.setTime(MINUTE_0 + 40_000);
      await stateMachine.handleCandleUpdate(createTestCandlePayload({
        openTimeMs: MINUTE_0,
        providerEventTimeMs: MINUTE_0 + 40_000,
      }), { sequence: 2 });
      expect(stateMachine.state).toBe('HEALTHY');

      // Advance clock to T=65s (past the initial 60s deadline, but only 25s since last activity)
      scheduler.advanceTime(25_000);
      // Must STILL be HEALTHY because last activity was at T=40s!
      expect(stateMachine.state).toBe('HEALTHY');

      // Now inactivity continues until T=105s (65s since last activity at T=40s)
      clock.setTime(MINUTE_0 + 105_000);
      scheduler.advanceTime(40_000);

      // Inactivity exceeded threshold -> transitions to STALE
      expect(stateMachine.state).toBe('STALE');

      stateMachine.stop();
    });
  });
});
