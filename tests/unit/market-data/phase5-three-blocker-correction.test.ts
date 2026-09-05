import { describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { FakeClock } from '../../../src/integration/coindcx/clock';
import { CanonicalMarketDataEngine } from '../../../src/market-data/canonical-engine';
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

/**
 * Phase 5 — Final 3-blocker correction regression suite.
 *
 * Covers Terra's DO_NOT_COMMIT_PHASE5 verdict blockers: FRESHNESS-SUPERSEDED-REFRESH,
 * RECOVERY-COMMIT-INTERLEAVE, RESTART-EPOCH-REUSE. Each test is written to exercise the real
 * production path and to fail if the corresponding fix were reverted.
 */
describe('Phase 5 — Three-Blocker Correction', () => {
  const PAIR = 'B-BTC_USDT';
  const MINUTE_0 = TEST_BASE_MINUTE_MS;
  const MINUTE_1 = MINUTE_0 + 60_000;
  const MINUTE_2 = MINUTE_1 + 60_000;
  const MINUTE_3 = MINUTE_2 + 60_000;
  const MINUTE_5 = MINUTE_0 + 5 * 60_000;

  // ===========================================================================================
  // A. FRESHNESS-SUPERSEDED-REFRESH: ARRIVAL != ACCEPTANCE
  // ===========================================================================================
  describe('FRESHNESS-SUPERSEDED-REFRESH', () => {
    it('a SUPERSEDED same-minute update does not refresh freshness and does not postpone the staleness deadline', async () => {
      const clock = new FakeClock(MINUTE_0);
      const scheduler = new ManualScheduler();
      const state = new PairCanonicalStateMachine(
        { pair: PAIR, clock, scheduler, staleThresholdMs: 10_000 },
        {
          onFinalizeCandle: async () => {},
          onRequestRecovery: async () => {},
          onConflictDetected: () => {},
          getPersistedCandle: async () => null,
        }
      );

      // t=0: accepted current same-minute snapshot.
      await state.handleCandleUpdate(
        createTestCandlePayload({ openTimeMs: MINUTE_0, providerEventTimeMs: MINUTE_0 + 5_000, close: new Decimal('50000') }),
        { sequence: 5, receivedAtMs: MINUTE_0 + 5_000 }
      );
      const baseline = state.getHealthSnapshot();
      expect(baseline.lastValidProviderEventTimeMs).toBe(MINUTE_0 + 5_000);
      expect(baseline.state).toBe('HEALTHY');

      // t=9s: an older/materially-different same-minute snapshot (lower providerEventTimeMs AND lower
      // sequence than what's already accepted) -> WorkingCandleManager reports SUPERSEDED.
      clock.setTime(MINUTE_0 + 9_000);
      await state.handleCandleUpdate(
        createTestCandlePayload({ openTimeMs: MINUTE_0, providerEventTimeMs: MINUTE_0 + 1_000, close: new Decimal('49950') }),
        { sequence: 1, receivedAtMs: MINUTE_0 + 9_000 }
      );

      const afterSuperseded = state.getHealthSnapshot();
      expect(afterSuperseded.lastValidProviderEventTimeMs).toBe(MINUTE_0 + 5_000);
      expect(afterSuperseded.lastValidReceivedAtMs).toBe(baseline.lastValidReceivedAtMs);
      expect(afterSuperseded.lateDropCount).toBe(1);

      // The deadline was armed from t=0 with a 10s threshold; it must still fire at ~t=10s, proving the
      // SUPERSEDED packet at t=9s did NOT postpone it (a postponed deadline would still read HEALTHY here).
      clock.setTime(MINUTE_0 + 10_500);
      scheduler.advanceTime(10_500);
      expect(state.state).toBe('STALE');

      state.stop();
    });

    it('genuinely ACCEPTED newer live progress at t=9s DOES rearm the staleness deadline to ~t=19s', async () => {
      const clock = new FakeClock(MINUTE_0);
      const scheduler = new ManualScheduler();
      const state = new PairCanonicalStateMachine(
        { pair: PAIR, clock, scheduler, staleThresholdMs: 10_000 },
        {
          onFinalizeCandle: async () => {},
          onRequestRecovery: async () => {},
          onConflictDetected: () => {},
          getPersistedCandle: async () => null,
        }
      );

      await state.handleCandleUpdate(createTestCandlePayload({ openTimeMs: MINUTE_0, providerEventTimeMs: MINUTE_0 }));
      expect(state.state).toBe('HEALTHY');

      // t=9: a genuinely newer same-minute update (higher providerEventTimeMs + sequence) -> ACCEPTED.
      clock.setTime(MINUTE_0 + 9_000);
      await state.handleCandleUpdate(
        createTestCandlePayload({ openTimeMs: MINUTE_0, providerEventTimeMs: MINUTE_0 + 9_000, close: new Decimal('50010') }),
        { sequence: 2 }
      );
      expect(state.state).toBe('HEALTHY');

      // The ORIGINAL deadline (armed from t=0, ~10s out) fires around scheduler-time 10s. Since real
      // activity occurred at t=9s, elapsed-since-activity is only ~1.5s: must remain HEALTHY.
      clock.setTime(MINUTE_0 + 10_500);
      scheduler.advanceTime(10_500);
      expect(state.state).toBe('HEALTHY');

      // No more activity. By ~t=20s (10s after the t=9 rearm), it must transition to STALE.
      clock.setTime(MINUTE_0 + 20_000);
      scheduler.advanceTime(9_500);
      expect(state.state).toBe('STALE');

      state.stop();
    });

    it('none of stale-generation, historical-finalized, future-skew-invalid, or superseded packets refresh freshness', async () => {
      const clock = new FakeClock(MINUTE_1 + 10_000);
      const repo = new InMemoryCandleRepository();
      const engine = new CanonicalMarketDataEngine({ repository: repo, clock });
      await engine.initializePair(PAIR);

      // Establish a baseline via one legitimate accepted packet.
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1, providerEventTimeMs: MINUTE_1 + 1_000 }), {
          generationId: 5,
        })
      );
      const baseline = engine.getPairHealth(PAIR)!;
      expect(baseline.lastValidProviderEventTimeMs).toBe(MINUTE_1 + 1_000);

      // Stale generation: rejected before ever reaching classification.
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1, providerEventTimeMs: MINUTE_1 + 9_000 }), {
          generationId: 4,
        })
      );
      // Future-skew invalid: providerEventTimeMs far beyond clock + maxFutureSkewMs.
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_2, providerEventTimeMs: clock.nowMs() + 60_000 }), {
          generationId: 5,
        })
      );
      // Superseded same-minute (older than what's already accepted for MINUTE_1).
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1, providerEventTimeMs: MINUTE_1 + 500 }), {
          generationId: 5,
        })
      );

      const afterAll = engine.getPairHealth(PAIR)!;
      expect(afterAll.lastValidProviderEventTimeMs).toBe(baseline.lastValidProviderEventTimeMs);
      expect(afterAll.lastValidReceivedAtMs).toBe(baseline.lastValidReceivedAtMs);

      engine.stop();
    });
  });

  // ===========================================================================================
  // B. RECOVERY-COMMIT-INTERLEAVE: one unified per-pair ordering authority
  // ===========================================================================================
  describe('RECOVERY-COMMIT-INTERLEAVE', () => {
    it('an in-flight live 12:00 commit blocks recovery 12:01/12:02 from persisting first; DB and publish order remain 12:00,12:01,12:02', async () => {
      const clock = new FakeClock(MINUTE_0 + 50_000);
      const scheduler = new ManualScheduler();
      const repo = new InMemoryCandleRepository();
      const publishedEvents: CanonicalStreamEvent[] = [];

      let resolveInsert0!: (value: InsertCandleResult) => void;
      const hangingInsert0 = new Promise<InsertCandleResult>((resolve) => {
        resolveInsert0 = resolve;
      });
      const originalInsert = repo.insertCandle.bind(repo);
      repo.insertCandle = vi.fn(async (candle: CanonicalCandle1m) => {
        if (candle.openTimeMs === MINUTE_0) {
          await hangingInsert0;
        }
        return originalInsert(candle);
      });

      const restReader = {
        fetchClosedCandles: vi.fn(async (q: { fromMs: number; toMs: number }) => {
          const records: RestCandleRecord[] = [];
          for (let t = q.fromMs; t <= q.toMs; t += 60_000) {
            records.push({
              pair: PAIR,
              openTimeMs: t,
              open: new Decimal('2'),
              high: new Decimal('2'),
              low: new Decimal('2'),
              close: new Decimal('2'),
              volume: new Decimal('1'),
              quoteVolume: null,
            });
          }
          return records;
        }),
      } as unknown as CoinDcxFuturesCandleRestReader;

      const engine = new CanonicalMarketDataEngine({ repository: repo, restReader, clock, scheduler, finalizationGraceMs: 500 });
      await engine.initializePair(PAIR);
      engine.subscribe((e) => publishedEvents.push(e));

      // Establish working=12:00, then successor 12:01 -> schedules 12:00's finalization.
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0, close: new Decimal('50000') }))
      );
      clock.setTime(MINUTE_1 + 50_000);
      await engine.handleStreamEnvelope(createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1 })));

      // Fire the grace timer: 12:00's commit starts and hangs on its DB insert.
      scheduler.advanceTime(600);
      await new Promise((r) => setTimeout(r, 10));
      expect(await repo.getCandle(PAIR, MINUTE_0)).toBeNull();

      // A gap is now detected: working (currently 12:01) jumps straight to live 12:03, triggering
      // recovery for [12:01, 12:02] while 12:00's live commit is STILL in flight.
      clock.setTime(MINUTE_3 + 10_000);
      const gapPromise = engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_3, providerEventTimeMs: MINUTE_3 + 5_000 }))
      );

      // Let recovery's REST fetch resolve and attempt to enqueue its candidates -- they must NOT be
      // able to persist while 12:00 is still hanging.
      await new Promise((r) => setTimeout(r, 10));
      expect(await repo.getCandle(PAIR, MINUTE_1)).toBeNull();
      expect(await repo.getCandle(PAIR, MINUTE_2)).toBeNull();

      // Now release 12:00's hanging insert.
      resolveInsert0({ outcome: 'INSERTED' });
      await gapPromise;
      await new Promise((r) => setTimeout(r, 10));

      // Persistence order: 12:00, then 12:01, then 12:02 -- fully contiguous, nothing skipped.
      const c0 = await repo.getCandle(PAIR, MINUTE_0);
      const c1 = await repo.getCandle(PAIR, MINUTE_1);
      const c2 = await repo.getCandle(PAIR, MINUTE_2);
      expect(c0?.close.value).toBe('50000');
      expect(c1?.close.value).toBe('2');
      expect(c2?.close.value).toBe('2');

      // Publication order matches persistence order.
      const closedEvents = publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED');
      expect(closedEvents.map((e) => (e.payload as CanonicalCandle1m).openTimeMs)).toEqual([MINUTE_0, MINUTE_1, MINUTE_2]);

      expect(engine.getPairHealth(PAIR)?.latestCanonicalOpenTimeMs).toBe(MINUTE_2);
      expect(engine.getPairHealth(PAIR)?.state).toBe('HEALTHY');
      expect(publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_RECOVERY_COMPLETED').length).toBe(1);

      engine.stop();
    });

    it('B4: predecessor commit failure blocks all later recovery commits -- fail-closed, no leapfrogging', async () => {
      const clock = new FakeClock(MINUTE_0 + 50_000);
      const scheduler = new ManualScheduler();
      const repo = new InMemoryCandleRepository();
      const publishedEvents: CanonicalStreamEvent[] = [];

      let rejectInsert0!: (err: Error) => void;
      const hangingInsert0 = new Promise<InsertCandleResult>((_resolve, reject) => {
        rejectInsert0 = reject;
      });
      const originalInsert = repo.insertCandle.bind(repo);
      repo.insertCandle = vi.fn(async (candle: CanonicalCandle1m) => {
        if (candle.openTimeMs === MINUTE_0) {
          return hangingInsert0;
        }
        return originalInsert(candle);
      });

      const restReader = {
        fetchClosedCandles: vi.fn(async (q: { fromMs: number; toMs: number }) => {
          const records: RestCandleRecord[] = [];
          for (let t = q.fromMs; t <= q.toMs; t += 60_000) {
            records.push({
              pair: PAIR,
              openTimeMs: t,
              open: new Decimal('2'),
              high: new Decimal('2'),
              low: new Decimal('2'),
              close: new Decimal('2'),
              volume: new Decimal('1'),
              quoteVolume: null,
            });
          }
          return records;
        }),
      } as unknown as CoinDcxFuturesCandleRestReader;

      const engine = new CanonicalMarketDataEngine({ repository: repo, restReader, clock, scheduler, finalizationGraceMs: 500 });
      const pairState = await engine.initializePair(PAIR);
      engine.subscribe((e) => publishedEvents.push(e));

      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0, close: new Decimal('50000') }))
      );
      clock.setTime(MINUTE_1 + 50_000);
      await engine.handleStreamEnvelope(createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1 })));

      scheduler.advanceTime(600);
      await new Promise((r) => setTimeout(r, 10));

      clock.setTime(MINUTE_3 + 10_000);
      const gapPromise = engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_3, providerEventTimeMs: MINUTE_3 + 5_000 }))
      );
      await new Promise((r) => setTimeout(r, 10));

      // 12:00's predecessor commit genuinely fails (e.g. a transient DB error).
      rejectInsert0(new Error('transient DB error'));
      await gapPromise;
      await new Promise((r) => setTimeout(r, 10));

      // Fail-closed: nothing later ever committed; no leapfrogging over the failed slot.
      expect(await repo.getCandle(PAIR, MINUTE_1)).toBeNull();
      expect(await repo.getCandle(PAIR, MINUTE_2)).toBeNull();
      expect(pairState.truthFault).toBe('PERSISTENCE_FAILURE');
      expect(pairState.state).toBe('DEGRADED');
      expect(pairState.latestCanonicalOpenTimeMs).toBeNull();
      expect(publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED').length).toBe(0);
      expect(publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_RECOVERY_COMPLETED').length).toBe(0);

      engine.stop();
    });
  });

  // ===========================================================================================
  // C. RESTART-EPOCH-REUSE: engine run ownership + state-machine identity
  // ===========================================================================================
  describe('RESTART-EPOCH-REUSE', () => {
    it('an old in-flight run-A insert settles into the shared baseline via the persistence barrier, but its callback stays inert in run B even with matching epoch numbers; run B then inherits continuity normally', async () => {
      const clock = new FakeClock(MINUTE_0 + 50_000);
      const scheduler = new ManualScheduler();
      const repo = new InMemoryCandleRepository();
      const publishedEvents: CanonicalStreamEvent[] = [];

      let resolveInsertA!: (value: InsertCandleResult) => void;
      const hangingInsertA = new Promise<InsertCandleResult>((resolve) => {
        resolveInsertA = resolve;
      });
      const originalInsert = repo.insertCandle.bind(repo);
      let insertCallCount = 0;
      repo.insertCandle = vi.fn(async (candle: CanonicalCandle1m) => {
        insertCallCount++;
        if (insertCallCount === 1) {
          await hangingInsertA;
        }
        return originalInsert(candle);
      });

      // Recovery will be triggered once run B detects the MINUTE_5 gap; resolve with empty coverage
      // (RECOVERY_INCOMPLETE) rather than reaching out to a real network endpoint.
      const restReader = {
        fetchClosedCandles: vi.fn(async () => [] as RestCandleRecord[]),
      } as unknown as CoinDcxFuturesCandleRestReader;

      const engine = new CanonicalMarketDataEngine({ repository: repo, restReader, clock, scheduler, finalizationGraceMs: 500 });
      engine.subscribe((e) => publishedEvents.push(e));

      // Run A: initialize BTC, drive 12:00's finalization to the point of awaiting repository.insert.
      await engine.initializePair(PAIR);
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0, close: new Decimal('50005') }))
      );
      clock.setTime(MINUTE_1 + 50_000);
      await engine.handleStreamEnvelope(createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1 })));
      scheduler.advanceTime(600);
      await new Promise((r) => setTimeout(r, 10));
      expect(await repo.getCandle(PAIR, MINUTE_0)).toBeNull(); // run A's insert genuinely in flight

      // Stop run A.
      engine.stop();

      // Start run B and BEGIN initializing the SAME pair name. Per the cross-run persistence barrier
      // (SOL-P5-001/2B), this legitimately WAITS for run A's still-pending physical write to settle
      // before reading the durable baseline — so it is kicked off but not awaited yet.
      // engine.stop() clears subscribers by design, so run B must (re-)subscribe like any real consumer
      // reconnecting after a restart.
      await engine.start();
      engine.subscribe((e) => publishedEvents.push(e));
      const runBInitPromise = engine.initializePair(PAIR);

      // Release run A's stale insert — it legitimately succeeds and physically writes MINUTE_0.
      resolveInsertA({ outcome: 'INSERTED' });
      const runBPairState = await runBInitPromise;
      await new Promise((r) => setTimeout(r, 15));

      // Run A's OWN callback must still be completely inert: no CLOSED event is ever credited to it,
      // even though the row it wrote is now legitimately part of durable truth.
      expect(publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED').length).toBe(0);

      // Run B correctly OBSERVES the settled prior write as its baseline (2B) — not a null/cold start —
      // while its OWN epoch counters are still fresh (1/1), proving ownership is identity/runId-based,
      // never confused by the epoch-number coincidence with run A's stale token.
      expect(runBPairState.canonicalEpoch).toBe(1);
      expect(runBPairState.recoveryEpoch).toBe(1);
      expect(runBPairState.latestCanonicalOpenTimeMs).toBe(MINUTE_0);
      expect(runBPairState.getHealthSnapshot().lastValidProviderEventTimeMs).toBeNull();
      expect(runBPairState.state).toBe('HEALTHY');
      expect(runBPairState.truthFault).toBe('NONE');

      const persistedMinute0 = await repo.getCandle(PAIR, MINUTE_0);
      expect(persistedMinute0?.close.value).toBe('50005'); // run A's physically-written data, verified

      // Run B then processes live data atop that inherited baseline. Since the next expected minute is
      // MINUTE_1 (not MINUTE_5), a live jump straight to MINUTE_5 must trigger the F2 warm-restart gap
      // barrier rather than direct cold-start acceptance — proving run B genuinely inherited continuity
      // rather than starting fresh.
      clock.setTime(MINUTE_5 + 50_000);
      await engine.handleStreamEnvelope(
        createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_5, providerEventTimeMs: MINUTE_5 + 5_000 }))
      );

      const afterGap = engine.getPairHealth(PAIR)!;
      expect(afterGap.state).toBe('RECOVERING');
      expect(afterGap.gapCount).toBe(1);
      expect(publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED').length).toBe(0);

      engine.stop();
    });
  });
});
