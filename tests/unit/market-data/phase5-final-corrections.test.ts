import { describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { FakeClock } from '../../../src/integration/coindcx/clock';
import { CoinDcxPublicFuturesStream } from '../../../src/integration/coindcx/websocket/public-stream';
import { CoinDcxStreamEnvelope } from '../../../src/integration/coindcx/websocket/types';
import { CanonicalMarketDataEngine } from '../../../src/market-data/canonical-engine';
import { createCanonicalCandle1m } from '../../../src/market-data/models';
import { PairCanonicalStateMachine } from '../../../src/market-data/pair-state';
import { InsertCandleResult } from '../../../src/market-data/persistence/candle-repository';
import { CoinDcxFuturesCandleRestReader, RestCandleRecord } from '../../../src/market-data/rest-candle-reader';
import { CanonicalCandle1m, CanonicalStreamEvent } from '../../../src/market-data/types';
import { ManualScheduler } from '../coindcx/ws/test-helpers';
import {
  InMemoryCandleRepository,
  MockFuturesCandleRestReader,
  TEST_BASE_MINUTE_MS,
  createTestCandlePayload,
  createTestEnvelope,
} from './test-helpers';

/**
 * Phase 5 — Final architectural correction regression suite.
 *
 * These tests reproduce the exact production races Terra's targeted re-review flagged as still
 * broken (F1 ordering, F2 pre-gap ownership, F5 durable recovery fault, freshness-before-acceptance,
 * F11 restart contract, staleness rearm, F3 stop-during-persistence, F10 replay fidelity). Each test
 * is written so that reverting the corresponding fix makes it fail (not just pass trivially).
 */
describe('Phase 5 — Final Architectural Correction', () => {
  const PAIR = 'B-BTC_USDT';
  const MINUTE_0 = TEST_BASE_MINUTE_MS;
  const MINUTE_1 = MINUTE_0 + 60_000;
  const MINUTE_2 = MINUTE_1 + 60_000;
  const MINUTE_3 = MINUTE_2 + 60_000;

  // ===========================================================================================
  // F1 — Ordered per-pair commit queue
  // ===========================================================================================
  describe('F1: Ordered finalization commit queue', () => {
    it('slow 12:00 DB insert + fast 12:01 insert still publish strictly in order 12:00 -> 12:01', async () => {
      const clock = new FakeClock(MINUTE_0 + 50_000);
      const scheduler = new ManualScheduler();
      const repo = new InMemoryCandleRepository();
      const publishedEvents: CanonicalStreamEvent[] = [];

      let resolveSlowInsert!: (value: InsertCandleResult) => void;
      const slowInsertPromise = new Promise<InsertCandleResult>((resolve) => {
        resolveSlowInsert = resolve;
      });
      const originalInsert = repo.insertCandle.bind(repo);
      repo.insertCandle = vi.fn(async (candle: CanonicalCandle1m) => {
        if (candle.openTimeMs === MINUTE_0) {
          await slowInsertPromise;
        }
        return originalInsert(candle);
      });

      const engine = new CanonicalMarketDataEngine({
        repository: repo,
        clock,
        scheduler,
        finalizationGraceMs: 500,
      });
      await engine.initializePair(PAIR);
      engine.subscribe((e) => publishedEvents.push(e));

      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0, close: new Decimal('50000') }))
      );
      clock.setTime(MINUTE_1 + 50_000);
      await engine.handleStreamEnvelope(
        // 12:01 arrives: makes 12:00 eligible (schedules its finalization).
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1, close: new Decimal('50100') }))
      );
      clock.setTime(MINUTE_2 + 50_000);
      await engine.handleStreamEnvelope(
        // 12:02 arrives: makes 12:01 eligible (schedules its finalization) too.
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_2 }))
      );

      // Fire both grace timers. 12:00's commit starts and hangs on its slow insert; 12:01 becomes
      // ready but must sit behind it in the ordered queue -- its insert must not even be attempted.
      scheduler.advanceTime(600);
      await new Promise((r) => setTimeout(r, 10));

      expect(await repo.getCandle(PAIR, MINUTE_0)).toBeNull();
      expect(await repo.getCandle(PAIR, MINUTE_1)).toBeNull();
      expect(publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED').length).toBe(0);

      // Release the slow 12:00 insert.
      resolveSlowInsert({ outcome: 'INSERTED' });
      await new Promise((r) => setTimeout(r, 10));

      const candle0 = await repo.getCandle(PAIR, MINUTE_0);
      const candle1 = await repo.getCandle(PAIR, MINUTE_1);
      expect(candle0?.close.value).toBe('50000');
      expect(candle1?.close.value).toBe('50100');

      const closedEvents = publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED');
      expect(closedEvents.length).toBe(2);
      expect((closedEvents[0]!.payload as CanonicalCandle1m).openTimeMs).toBe(MINUTE_0);
      expect((closedEvents[1]!.payload as CanonicalCandle1m).openTimeMs).toBe(MINUTE_1);

      // Monotonic watermark: never regresses back to MINUTE_0 after advancing to MINUTE_1.
      expect(engine.getPairHealth(PAIR)?.latestCanonicalOpenTimeMs).toBe(MINUTE_1);

      engine.stop();
    });
  });

  // ===========================================================================================
  // F2 — Pre-gap working candle ownership
  // ===========================================================================================
  describe('F2: Pre-gap working candle ownership', () => {
    it('working 12:00 -> live 12:03: predecessor is verified via REST, buffered 12:03 drains without a repeated identical recovery loop', async () => {
      const clock = new FakeClock(MINUTE_3 + 10_000);
      const repo = new InMemoryCandleRepository();
      const recoveryCalls: { fromMs: number; toMs: number }[] = [];

      const restReader = {
        fetchClosedCandles: vi.fn(async (q: { pair: string; fromMs: number; toMs: number }) => {
          recoveryCalls.push({ fromMs: q.fromMs, toMs: q.toMs });
          const records: RestCandleRecord[] = [];
          for (let t = q.fromMs; t <= q.toMs; t += 60_000) {
            records.push({
              pair: PAIR,
              openTimeMs: t,
              open: new Decimal('50000'),
              high: new Decimal('50100'),
              low: new Decimal('49900'),
              close: new Decimal('50050'),
              volume: new Decimal('1'),
              quoteVolume: null,
            });
          }
          return records;
        }),
      } as unknown as CoinDcxFuturesCandleRestReader;

      const engine = new CanonicalMarketDataEngine({ repository: repo, restReader, clock });
      await engine.initializePair(PAIR);

      // Working 12:00 established live; no successor ever confirms it via WS.
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0 }))
      );
      expect(engine.getPairHealth(PAIR)?.workingOpenTimeMs).toBe(MINUTE_0);

      // Live jumps straight to 12:03.
      await engine.handleStreamEnvelope(
        createTestEnvelope(
          'PUBLIC_CANDLE_UPDATE',
          createTestCandlePayload({ openTimeMs: MINUTE_3, providerEventTimeMs: MINUTE_3 + 5_000 })
        )
      );

      // Recovery range must include the orphaned predecessor's own minute (12:00), not just the gap.
      expect(recoveryCalls).toEqual([{ fromMs: MINUTE_0, toMs: MINUTE_2 }]);
      expect(recoveryCalls.length).toBe(1); // exactly one attempt: no repeated identical recovery loop

      const health = engine.getPairHealth(PAIR)!;
      expect(health.state).toBe('HEALTHY');
      expect(health.latestCanonicalOpenTimeMs).toBe(MINUTE_2);
      expect(health.bufferedLiveUpdateCount).toBe(0); // buffered 12:03 drained
      expect(health.workingOpenTimeMs).toBe(MINUTE_3); // replay progressed: 12:03 became the new working candle

      expect(await repo.getCandle(PAIR, MINUTE_0)).not.toBeNull();
      expect(await repo.getCandle(PAIR, MINUTE_1)).not.toBeNull();
      expect(await repo.getCandle(PAIR, MINUTE_2)).not.toBeNull();

      engine.stop();
    });
  });

  // ===========================================================================================
  // F5 — RECOVERY_INCOMPLETE durable fault
  // ===========================================================================================
  describe('F5: RECOVERY_INCOMPLETE is a durable, fail-closed fault', () => {
    it('missing one REST minute latches RECOVERY_INCOMPLETE; a subsequent normal live packet cannot clear it', async () => {
      const clock = new FakeClock(MINUTE_2 + 35_000);
      const scheduler = new ManualScheduler();
      const repo = new InMemoryCandleRepository();
      const restReader = new MockFuturesCandleRestReader();
      // Only MINUTE_1 returned; MINUTE_2 missing from requested coverage.
      restReader.recordsToReturn = [
        {
          pair: PAIR,
          openTimeMs: MINUTE_1,
          open: new Decimal('50000'),
          high: new Decimal('50000'),
          low: new Decimal('50000'),
          close: new Decimal('50000'),
          volume: new Decimal('1'),
          quoteVolume: null,
        },
      ];

      const engine = new CanonicalMarketDataEngine({
        repository: repo,
        restReader: restReader as unknown as CoinDcxFuturesCandleRestReader,
        clock,
        scheduler,
        finalizationGraceMs: 500,
      });
      await engine.initializePair(PAIR);

      await engine.executeRecovery(PAIR, MINUTE_1, MINUTE_2);

      let health = engine.getPairHealth(PAIR)!;
      expect(health.state).toBe('RECOVERING');
      expect(health.truthFault).toBe('RECOVERY_INCOMPLETE');

      // A normal live packet arrives next -- while RECOVERING it is buffered, and must NOT clear the fault.
      clock.setTime(MINUTE_3 + 35_000);
      await engine.handleStreamEnvelope(
        createTestEnvelope(
          'PUBLIC_CANDLE_UPDATE',
          createTestCandlePayload({ openTimeMs: MINUTE_3, providerEventTimeMs: MINUTE_3 + 30_000 })
        )
      );

      health = engine.getPairHealth(PAIR)!;
      expect(health.truthFault).toBe('RECOVERY_INCOMPLETE');
      expect(health.state).toBe('RECOVERING');

      // Even well past any grace window, nothing publishes while the fault is latched.
      scheduler.advanceTime(5_000);
      await new Promise((r) => setTimeout(r, 10));
      expect(await repo.getCandle(PAIR, MINUTE_3)).toBeNull();

      engine.stop();
    });

    it('REST failure (throw) latches RECOVERY_INCOMPLETE as a durable fault, not merely a log line', async () => {
      const clock = new FakeClock(MINUTE_2 + 35_000);
      const repo = new InMemoryCandleRepository();
      const restReader = {
        fetchClosedCandles: vi.fn().mockRejectedValue(new Error('network down')),
      } as unknown as CoinDcxFuturesCandleRestReader;

      const engine = new CanonicalMarketDataEngine({ repository: repo, restReader, clock });
      await engine.initializePair(PAIR);

      await engine.executeRecovery(PAIR, MINUTE_1, MINUTE_2);

      const health = engine.getPairHealth(PAIR)!;
      expect(health.truthFault).toBe('RECOVERY_INCOMPLETE');
      expect(health.state).toBe('RECOVERING');

      engine.stop();
    });

    it('only a successful exact recovery for the ACTIVE epoch clears a RECOVERY_INCOMPLETE fault', async () => {
      const clock = new FakeClock(MINUTE_2 + 35_000);
      const repo = new InMemoryCandleRepository();
      const restReader = new MockFuturesCandleRestReader();
      restReader.recordsToReturn = []; // first attempt: incomplete

      const engine = new CanonicalMarketDataEngine({
        repository: repo,
        restReader: restReader as unknown as CoinDcxFuturesCandleRestReader,
        clock,
      });
      const pairState = await engine.initializePair(PAIR);

      await engine.executeRecovery(PAIR, MINUTE_1, MINUTE_1);
      expect(engine.getPairHealth(PAIR)?.truthFault).toBe('RECOVERY_INCOMPLETE');
      const activeEpoch = pairState.recoveryEpoch;

      // Retry for the SAME active epoch, now with complete coverage.
      restReader.recordsToReturn = [
        {
          pair: PAIR,
          openTimeMs: MINUTE_1,
          open: new Decimal('50000'),
          high: new Decimal('50000'),
          low: new Decimal('50000'),
          close: new Decimal('50000'),
          volume: new Decimal('1'),
          quoteVolume: null,
        },
      ];
      await engine.executeRecovery(PAIR, MINUTE_1, MINUTE_1, activeEpoch);

      const health = engine.getPairHealth(PAIR)!;
      expect(health.truthFault).toBe('NONE');
      expect(health.state).toBe('HEALTHY');

      engine.stop();
    });
  });

  // ===========================================================================================
  // D — Freshness follows acceptance, not arrival
  // ===========================================================================================
  describe('Freshness telemetry mutates only after acceptance', () => {
    it('a historical packet (<= latestCanonicalOpenTimeMs) does not refresh freshness fields', async () => {
      const clock = new FakeClock(MINUTE_1 + 10_000);
      const repo = new InMemoryCandleRepository();
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

      const engine = new CanonicalMarketDataEngine({ repository: repo, clock });
      await engine.initializePair(PAIR);

      // Establish a HEALTHY baseline with a known freshness timestamp via a legitimate live packet.
      await engine.handleStreamEnvelope(
        createTestEnvelope(
          'PUBLIC_CANDLE_UPDATE',
          createTestCandlePayload({ openTimeMs: MINUTE_1, providerEventTimeMs: MINUTE_1 + 5_000 })
        )
      );
      const baseline = engine.getPairHealth(PAIR)!;
      expect(baseline.lastValidProviderEventTimeMs).toBe(MINUTE_1 + 5_000);

      // Advance the clock, then feed a historical packet matching the already-persisted MINUTE_0 row.
      clock.setTime(MINUTE_1 + 40_000);
      await engine.handleStreamEnvelope(
        createTestEnvelope(
          'PUBLIC_CANDLE_UPDATE',
          createTestCandlePayload({
            openTimeMs: MINUTE_0,
            providerEventTimeMs: MINUTE_1 + 39_000,
            open: new Decimal('50000'),
            high: new Decimal('50000'),
            low: new Decimal('50000'),
            close: new Decimal('50000'),
            volume: new Decimal('1'),
            quoteVolume: null,
          })
        )
      );

      const after = engine.getPairHealth(PAIR)!;
      expect(after.lastValidProviderEventTimeMs).toBe(MINUTE_1 + 5_000);
      expect(after.lastValidReceivedAtMs).toBe(baseline.lastValidReceivedAtMs);
      expect(after.duplicateCount).toBe(1); // packet WAS processed, just classified historical/duplicate

      engine.stop();
    });

    it('a rejected forward-skewed packet does not refresh freshness fields', async () => {
      const clock = new FakeClock(MINUTE_0 + 10_000);
      const state = new PairCanonicalStateMachine(
        { pair: PAIR, clock, maxFutureSkewMs: 5_000 },
        {
          onFinalizeCandle: async () => {},
          onRequestRecovery: async () => {},
          onConflictDetected: () => {},
          getPersistedCandle: async () => null,
        }
      );

      await state.handleCandleUpdate(createTestCandlePayload({ openTimeMs: MINUTE_0, providerEventTimeMs: MINUTE_0 + 5_000 }));
      const baseline = state.getHealthSnapshot();
      expect(baseline.lastValidProviderEventTimeMs).toBe(MINUTE_0 + 5_000);

      clock.setTime(MINUTE_0 + 20_000);
      await state.handleCandleUpdate(
        createTestCandlePayload({ openTimeMs: MINUTE_1, providerEventTimeMs: clock.nowMs() + 50_000 }),
        { sequence: 2 }
      );

      const after = state.getHealthSnapshot();
      expect(after.state).toBe('DEGRADED');
      expect(after.lastValidProviderEventTimeMs).toBe(baseline.lastValidProviderEventTimeMs);
      expect(after.lastValidReceivedAtMs).toBe(baseline.lastValidReceivedAtMs);

      state.stop();
    });
  });

  // ===========================================================================================
  // F11 — Explicit restart contract (supported) + concurrent start
  // ===========================================================================================
  describe('F11: Explicit restart contract', () => {
    it('start -> stop -> start resubscribes and resumes processing (no permanent inertness)', async () => {
      let listenerCount = 0;
      let capturedHandler: ((envelope: CoinDcxStreamEnvelope<unknown>) => void) | null = null;
      const mockStream = {
        subscribe: vi.fn((handler: (envelope: CoinDcxStreamEnvelope<unknown>) => void) => {
          listenerCount++;
          capturedHandler = handler;
          return () => {
            listenerCount--;
          };
        }),
      } as unknown as CoinDcxPublicFuturesStream;

      const repo = new InMemoryCandleRepository();
      const engine = new CanonicalMarketDataEngine({ repository: repo, publicStream: mockStream });

      await engine.start();
      expect(engine.lifecycleState).toBe('RUNNING');
      expect(listenerCount).toBe(1);

      engine.stop();
      expect(engine.lifecycleState).toBe('STOPPED');
      expect(listenerCount).toBe(0);

      // Restart must NOT remain permanently inert.
      await engine.start();
      expect(engine.lifecycleState).toBe('RUNNING');
      expect(listenerCount).toBe(1);

      expect(capturedHandler).not.toBeNull();
      await engine.initializePair(PAIR);
      capturedHandler!(createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0 })));
      await new Promise((r) => setTimeout(r, 10));

      // Events delivered after restart must actually be processed, not silently dropped.
      expect(engine.getPairHealth(PAIR)?.workingOpenTimeMs).toBe(MINUTE_0);

      engine.stop();
    });

    it('two concurrent start() calls before the first resolves register exactly one underlying subscription', async () => {
      let listenerCount = 0;
      const mockStream = {
        subscribe: vi.fn(() => {
          listenerCount++;
          return () => {
            listenerCount--;
          };
        }),
      } as unknown as CoinDcxPublicFuturesStream;

      const engine = new CanonicalMarketDataEngine({ publicStream: mockStream });

      await Promise.all([engine.start(), engine.start()]);
      expect(engine.lifecycleState).toBe('RUNNING');
      expect(listenerCount).toBe(1);

      // A third call after both settled must also be a no-op.
      await engine.start();
      expect(listenerCount).toBe(1);

      engine.stop();
      expect(listenerCount).toBe(0);
    });
  });

  // ===========================================================================================
  // Staleness rearm: historical packets must not postpone the deadline
  // ===========================================================================================
  describe('Staleness rearm ignores historical packets', () => {
    it('a historical packet during the window does not rearm the deadline; STALE still fires on the original schedule', async () => {
      const clock = new FakeClock(MINUTE_0);
      const scheduler = new ManualScheduler();
      const repo = new InMemoryCandleRepository();

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

      const engine = new CanonicalMarketDataEngine({ repository: repo, clock, scheduler });
      await engine.initializePair(PAIR); // warm restart baseline: latestCanonicalOpenTimeMs = MINUTE_0

      // t=0 (MINUTE_1): first accepted live packet establishes HEALTHY + a stale deadline ~120s out.
      clock.setTime(MINUTE_1);
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1, providerEventTimeMs: MINUTE_1 }))
      );
      expect(engine.getPairHealth(PAIR)?.state).toBe('HEALTHY');
      const freshnessAfterFirst = engine.getPairHealth(PAIR)?.lastValidReceivedAtMs;

      // t=9s: a HISTORICAL packet (already-persisted MINUTE_0) arrives. Must NOT rearm the deadline.
      clock.setTime(MINUTE_1 + 9_000);
      await engine.handleStreamEnvelope(
        createTestEnvelope(
          'PUBLIC_CANDLE_UPDATE',
          createTestCandlePayload({
            openTimeMs: MINUTE_0,
            open: new Decimal('50000'),
            high: new Decimal('50000'),
            low: new Decimal('50000'),
            close: new Decimal('50000'),
            volume: new Decimal('1'),
            quoteVolume: null,
          })
        )
      );
      expect(engine.getPairHealth(PAIR)?.lastValidReceivedAtMs).toBe(freshnessAfterFirst);

      // Drive past the ORIGINAL deadline computed from t=0 (120s default threshold), not from the
      // ignored historical packet at t=9s. If the historical packet had wrongly rearmed the deadline
      // (bug reproduced), elapsed-since-freshness would be only 112s here and STALE would not fire.
      clock.setTime(MINUTE_1 + 121_000);
      scheduler.advanceTime(121_000);

      expect(engine.getPairHealth(PAIR)?.state).toBe('STALE');

      engine.stop();
    });
  });

  // ===========================================================================================
  // F3 — stop() during in-flight persistence
  // ===========================================================================================
  describe('F3: stop() during in-flight persistence', () => {
    it('stopping mid-commit does not publish, does not throw, and a later-resolving DB write stays inert', async () => {
      const clock = new FakeClock(MINUTE_0 + 35_000);
      const scheduler = new ManualScheduler();
      const repo = new InMemoryCandleRepository();
      const publishedEvents: CanonicalStreamEvent[] = [];

      let resolveInsert!: (value: InsertCandleResult) => void;
      const hangingInsert = new Promise<InsertCandleResult>((resolve) => {
        resolveInsert = resolve;
      });
      repo.insertCandle = vi.fn().mockImplementation(async () => hangingInsert);

      const engine = new CanonicalMarketDataEngine({
        repository: repo,
        clock,
        scheduler,
        finalizationGraceMs: 500,
      });
      await engine.initializePair(PAIR);
      engine.subscribe((e) => publishedEvents.push(e));

      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0 }))
      );
      clock.setTime(MINUTE_1 + 35_000);
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1 }))
      );

      // Trigger the grace timer: commit starts and hangs on the DB insert.
      scheduler.advanceTime(600);
      await Promise.resolve();
      expect(scheduler.activeTimerCount).toBeGreaterThan(0);

      expect(() => engine.stop()).not.toThrow();
      expect(engine.lifecycleState).toBe('STOPPED');
      expect(scheduler.activeTimerCount).toBe(0);

      // Let the hanging DB write resolve AFTER stop() -- must not publish or crash.
      resolveInsert({ outcome: 'INSERTED' });
      await new Promise((r) => setTimeout(r, 10));

      const closedEvents = publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED');
      expect(closedEvents.length).toBe(0);

      expect(() => engine.stop()).not.toThrow(); // idempotent
    });
  });

  // ===========================================================================================
  // F10 — Buffer replay preserves exact metadata, not just count
  // ===========================================================================================
  describe('F10: Buffer replay fidelity', () => {
    it('a replayed buffered envelope finalizes with its own OHLCV/providerEventTimeMs, not stale or default values', async () => {
      const clock = new FakeClock(MINUTE_2 + 10_000);
      const scheduler = new ManualScheduler();
      const repo = new InMemoryCandleRepository();

      const engine = new CanonicalMarketDataEngine({ repository: repo, clock, scheduler, finalizationGraceMs: 500 });
      const pairState = await engine.initializePair(PAIR);

      // Force RECOVERING via reconnect barrier so the next live packet buffers instead of applying directly.
      pairState.handleReconnectBarrier(2);

      // Buffer a live packet for MINUTE_2 with distinctive OHLCV + providerEventTimeMs.
      await engine.handleStreamEnvelope(
        createTestEnvelope(
          'PUBLIC_CANDLE_UPDATE',
          createTestCandlePayload({
            openTimeMs: MINUTE_2,
            providerEventTimeMs: MINUTE_2 + 12_345,
            open: new Decimal('61000'),
            high: new Decimal('61500'),
            low: new Decimal('60900'),
            close: new Decimal('61200'),
            volume: new Decimal('7.25'),
            quoteVolume: new Decimal('444000'),
          }),
          { generationId: 2, sequence: 9 }
        )
      );
      expect(engine.getPairHealth(PAIR)?.bufferedLiveUpdateCount).toBe(1);

      // A stale-generation packet for the SAME minute must be dropped, never overriding the buffered entry.
      await engine.handleStreamEnvelope(
        createTestEnvelope(
          'PUBLIC_CANDLE_UPDATE',
          createTestCandlePayload({ openTimeMs: MINUTE_2, providerEventTimeMs: MINUTE_2 + 1_000, close: new Decimal('1') }),
          { generationId: 1, sequence: 1 }
        )
      );
      expect(engine.getPairHealth(PAIR)?.bufferedLiveUpdateCount).toBe(1);
      expect(engine.getPairHealth(PAIR)?.lateDropCount).toBe(1);

      // Complete recovery for the barrier-created epoch (no REST candles actually missing here).
      await pairState.applyRecoveredCandlesAndDrainBuffer([], 2);

      expect(engine.getPairHealth(PAIR)?.bufferedLiveUpdateCount).toBe(0);
      expect(engine.getPairHealth(PAIR)?.workingOpenTimeMs).toBe(MINUTE_2);

      // Drive a successor + grace timer to finalize MINUTE_2, proving the REPLAYED metadata (not
      // defaults, and not the stale-generation packet's values) is what gets persisted.
      clock.setTime(MINUTE_3 + 10_000);
      await engine.handleStreamEnvelope(
        createTestEnvelope(
          'PUBLIC_CANDLE_UPDATE',
          createTestCandlePayload({ openTimeMs: MINUTE_3, providerEventTimeMs: MINUTE_3 + 1_000 }),
          { generationId: 2, sequence: 10 }
        )
      );
      scheduler.advanceTime(600);
      await new Promise((r) => setTimeout(r, 10));

      const persisted = await repo.getCandle(PAIR, MINUTE_2);
      expect(persisted).not.toBeNull();
      expect(persisted!.open.value).toBe('61000');
      expect(persisted!.high.value).toBe('61500');
      expect(persisted!.low.value).toBe('60900');
      expect(persisted!.close.value).toBe('61200');
      expect(persisted!.volume.value).toBe('7.25');
      expect(persisted!.quoteVolume?.value).toBe('444000');
      expect(persisted!.providerEventTimeMs).toBe(MINUTE_2 + 12_345);

      engine.stop();
    });
  });
});
