import { describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { FakeClock } from '../../../src/integration/coindcx/clock';
import { CoinDcxPublicFuturesStream } from '../../../src/integration/coindcx/websocket/public-stream';
import { CanonicalMarketDataEngine } from '../../../src/market-data/canonical-engine';
import { createCanonicalCandle1m } from '../../../src/market-data/models';
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
 * Phase 5 — Final async lifecycle / cross-run safety correction (Sol audit) regression suite.
 *
 * SOL-P5-001..005 are one architectural issue: async operations were not completely owned by an engine
 * run / cross-run barrier. Every test here drives the real CanonicalMarketDataEngine production path
 * with deferred (manually-controlled) promises, reproducing the exact races Sol's audit confirmed.
 */
describe('Phase 5 — Cross-Run Safety Correction (Sol Audit)', () => {
  const PAIR = 'B-BTC_USDT';
  const PAIR_ETH = 'B-ETH_USDT';
  const MINUTE_0 = TEST_BASE_MINUTE_MS;
  const MINUTE_1 = MINUTE_0 + 60_000;
  const MINUTE_2 = MINUTE_1 + 60_000;
  const MINUTE_3 = MINUTE_2 + 60_000;
  const MINUTE_5 = MINUTE_0 + 5 * 60_000;
  const MINUTE_6 = MINUTE_0 + 6 * 60_000;

  // ===========================================================================================
  // A. CROSS-RUN COMMIT BARRIER (SOL-P5-001 / 2A / 2B / 2D)
  // ===========================================================================================
  it('A. Run-B initialization waits for the prior physical 12:00 write to settle before establishing baseline; DB order never inverts', async () => {
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
      fetchClosedCandles: vi.fn(async () => [] as RestCandleRecord[]),
    } as unknown as CoinDcxFuturesCandleRestReader;

    const engine = new CanonicalMarketDataEngine({ repository: repo, restReader, clock, scheduler, finalizationGraceMs: 500 });
    engine.subscribe((e) => publishedEvents.push(e));

    // Run A: 12:00 persistence begins and remains unresolved.
    await engine.initializePair(PAIR);
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0, close: new Decimal('50000') }))
    );
    clock.setTime(MINUTE_1 + 50_000);
    await engine.handleStreamEnvelope(createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1 })));
    scheduler.advanceTime(600);
    await new Promise((r) => setTimeout(r, 10));
    expect(await repo.getCandle(PAIR, MINUTE_0)).toBeNull(); // genuinely in flight

    // Stop/start Run B.
    engine.stop();
    await engine.start();
    engine.subscribe((e) => publishedEvents.push(e));

    // Run B begins initializing BTC while 12:00 is still pending -- must NOT establish a baseline yet.
    let runBInitSettled = false;
    const runBInitPromise = engine.initializePair(PAIR).then((sm) => {
      runBInitSettled = true;
      return sm;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(runBInitSettled).toBe(false); // still blocked on the cross-run persistence barrier

    // Release 12:00 -- it legitimately succeeds.
    resolveInsert0({ outcome: 'INSERTED' });
    const runBPairState = await runBInitPromise;
    await new Promise((r) => setTimeout(r, 10));

    expect(runBInitSettled).toBe(true);
    expect(runBPairState.latestCanonicalOpenTimeMs).toBe(MINUTE_0);
    // 2D: Run A's own callback is never credited with the publication.
    expect(publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED').length).toBe(0);

    // Send 12:05: cannot publish directly; the exact F2 recovery barrier is entered instead.
    clock.setTime(MINUTE_5 + 50_000);
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_5, providerEventTimeMs: MINUTE_5 + 5_000 }))
    );

    const afterGap = engine.getPairHealth(PAIR)!;
    expect(afterGap.state).toBe('RECOVERING');
    expect(afterGap.gapCount).toBe(1);
    expect(await repo.getCandle(PAIR, MINUTE_5)).toBeNull(); // never published directly

    // Physical DB order never inverted: 12:00 exists, 12:05 does not.
    expect(await repo.getCandle(PAIR, MINUTE_0)).not.toBeNull();

    engine.stop();
  });

  // ===========================================================================================
  // B. CROSS-RUN FAILURE (2C)
  // ===========================================================================================
  it('B. a prior-run predecessor insert FAILURE is never treated as a cold start in Run B; later publication stays blocked', async () => {
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

    const engine = new CanonicalMarketDataEngine({ repository: repo, clock, scheduler, finalizationGraceMs: 500 });
    engine.subscribe((e) => publishedEvents.push(e));

    await engine.initializePair(PAIR);
    await engine.handleStreamEnvelope(createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0 })));
    clock.setTime(MINUTE_1 + 50_000);
    await engine.handleStreamEnvelope(createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1 })));
    scheduler.advanceTime(600);
    await new Promise((r) => setTimeout(r, 10));

    engine.stop();
    await engine.start();
    engine.subscribe((e) => publishedEvents.push(e));

    const runBInitPromise = engine.initializePair(PAIR);
    rejectInsert0(new Error('transient DB error'));
    const runBPairState = await runBInitPromise;
    await new Promise((r) => setTimeout(r, 10));

    // NOT treated as an innocent cold start: fails closed immediately.
    expect(runBPairState.truthFault).toBe('PERSISTENCE_FAILURE');
    expect(runBPairState.state).toBe('RECOVERING');
    expect(runBPairState.latestCanonicalOpenTimeMs).toBeNull();

    // Later canonical publication is blocked even for a clean successor sequence.
    clock.setTime(MINUTE_5 + 50_000);
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_5, providerEventTimeMs: MINUTE_5 + 5_000 }))
    );
    clock.setTime(MINUTE_6 + 50_000);
    await engine.handleStreamEnvelope(createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_6 })));
    scheduler.advanceTime(600);
    await new Promise((r) => setTimeout(r, 10));

    expect(await repo.getCandle(PAIR, MINUTE_5)).toBeNull();
    expect(await repo.getCandle(PAIR, MINUTE_6)).toBeNull();
    expect(publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED').length).toBe(0);
    expect(runBPairState.truthFault).toBe('PERSISTENCE_FAILURE');

    engine.stop();
  });

  // ===========================================================================================
  // C. STALE DISPATCH (SOL-P5-002)
  // ===========================================================================================
  it('C. an old Run-A envelope awaiting initializePair cannot mutate Run-B working/freshness/health after a restart', async () => {
    const clock = new FakeClock(MINUTE_0 + 50_000);
    const scheduler = new ManualScheduler();
    const repo = new InMemoryCandleRepository();

    let resolveLookup!: (v: CanonicalCandle1m | null) => void;
    const hangingLookup = new Promise<CanonicalCandle1m | null>((resolve) => {
      resolveLookup = resolve;
    });
    const originalGetLatest = repo.getLatestCanonicalCandle.bind(repo);
    let lookupCallCount = 0;
    repo.getLatestCanonicalCandle = vi.fn(async (pair: string) => {
      lookupCallCount++;
      if (lookupCallCount === 1) {
        return hangingLookup;
      }
      return originalGetLatest(pair);
    });

    const engine = new CanonicalMarketDataEngine({ repository: repo, clock, scheduler, finalizationGraceMs: 500 });

    // Run A: an envelope arrives for a not-yet-initialized pair, triggering handleStreamEnvelope's OWN
    // internal initializePair() call, which hangs on the (first) DB lookup.
    const runAEnvelopePromise = engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0, providerEventTimeMs: MINUTE_0 + 5_000 }))
    );
    await new Promise((r) => setTimeout(r, 10));

    // Stop, then start Run B and let it establish its OWN instance for the same pair.
    engine.stop();
    await engine.start();
    const runBPairState = await engine.initializePair(PAIR);
    const baseline = runBPairState.getHealthSnapshot();
    expect(baseline.workingOpenTimeMs).toBeNull();
    expect(baseline.lastValidProviderEventTimeMs).toBeNull();

    // Now resolve run A's stale lookup -- its handleStreamEnvelope call resumes.
    resolveLookup(null);
    await runAEnvelopePromise;
    await new Promise((r) => setTimeout(r, 10));

    // Run A's envelope must NOT have mutated Run B's working candle, freshness, or health.
    const after = runBPairState.getHealthSnapshot();
    expect(after.workingOpenTimeMs).toBeNull();
    expect(after.lastValidProviderEventTimeMs).toBeNull();
    expect(after.state).toBe('HEALTHY');
    expect(after.truthFault).toBe('NONE');
    expect(after.gapCount).toBe(0);

    engine.stop();
  });

  // ===========================================================================================
  // D. STALE RECOVERY ERROR (SOL-P5-003)
  // ===========================================================================================
  it('D. an old Run-A REST recovery rejection cannot emit CANONICAL_1M_INVALID into Run B', async () => {
    const clock = new FakeClock(MINUTE_3 + 10_000);
    const scheduler = new ManualScheduler();
    const repo = new InMemoryCandleRepository();
    const publishedEventsB: CanonicalStreamEvent[] = [];

    let rejectRest!: (err: Error) => void;
    const hangingRest = new Promise<RestCandleRecord[]>((_resolve, reject) => {
      rejectRest = reject;
    });
    const restReader = {
      fetchClosedCandles: vi.fn(async () => hangingRest),
    } as unknown as CoinDcxFuturesCandleRestReader;

    const engine = new CanonicalMarketDataEngine({ repository: repo, restReader, clock, scheduler });

    // Run A: working=12:00, jump to 12:03 -> gap -> recovery request pending on REST.
    // The gap-triggering envelope's own handling awaits onRequestRecovery -> executeRecovery ->
    // fetchClosedCandles, which resolves to `hangingRest` -- so this call must NOT be awaited directly
    // here (it cannot settle until rejectRest() is called below), mirroring the pattern in test A.
    await engine.initializePair(PAIR);
    await engine.handleStreamEnvelope(createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0 })));
    const gapEnvelopePromise = engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_3, providerEventTimeMs: MINUTE_3 + 5_000 }))
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(engine.getPairHealth(PAIR)?.state).toBe('RECOVERING');

    // Stop/start Run B; subscribe a NEW listener.
    engine.stop();
    await engine.start();
    engine.subscribe((e) => publishedEventsB.push(e));

    // Reject Run A's still-pending REST request; the stale recovery's own catch block absorbs it.
    rejectRest(new Error('network down'));
    await gapEnvelopePromise;
    await new Promise((r) => setTimeout(r, 10));

    // Zero Run-B canonical invalid events.
    expect(publishedEventsB.filter((e) => e.eventType === 'CANONICAL_1M_INVALID').length).toBe(0);
    expect(publishedEventsB.length).toBe(0);

    engine.stop();
  });

  // ===========================================================================================
  // E. HISTORICAL DB READ FAILURE (SOL-P5-004)
  // ===========================================================================================
  it('E. a historical-verification DB read failure latches a blocking truth fault and prevents future canonical publication', async () => {
    const clock = new FakeClock(MINUTE_1 + 10_000);
    const scheduler = new ManualScheduler();
    const repo = new InMemoryCandleRepository();

    // A persisted canonical minute conceptually exists...
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

    // ...but the read used for historical verification specifically fails.
    repo.getCandle = vi.fn().mockRejectedValue(new Error('DB connection lost'));

    const engine = new CanonicalMarketDataEngine({ repository: repo, clock, scheduler });
    await engine.initializePair(PAIR); // baseline load uses getLatestCanonicalCandle, unaffected

    // A historical/late packet for MINUTE_0 arrives, triggering getPersistedCandle -> getCandle, which throws.
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0, providerEventTimeMs: MINUTE_1 + 5_000 }))
    );

    const health = engine.getPairHealth(PAIR)!;
    expect(health.truthFault).toBe('PERSISTENCE_FAILURE');
    expect(health.state).toBe('DEGRADED');

    // A subsequent NORMAL future candle cannot publish -- fail-closed, no auto-heal.
    clock.setTime(MINUTE_1 + 50_000);
    await engine.handleStreamEnvelope(createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1 })));

    const afterFuturePacket = engine.getPairHealth(PAIR)!;
    expect(afterFuturePacket.truthFault).toBe('PERSISTENCE_FAILURE');
    expect(afterFuturePacket.state).toBe('DEGRADED');
    expect(afterFuturePacket.workingOpenTimeMs).toBeNull(); // never accepted as a working candle

    engine.stop();
  });

  // ===========================================================================================
  // F. START PROMISE RACE (SOL-P5-005)
  // ===========================================================================================
  it('F. immediate stop()+start() right after start() reaches RUNNING (before its own finally cleanup) creates a fresh active run, not the obsolete operation', async () => {
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

    // Call 1 completes synchronously to RUNNING (start()'s IIFE has no real await), but its OWN
    // .finally() cleanup is still a pending microtask at this exact point.
    const firstStartPromise = engine.start();
    expect(engine.lifecycleState).toBe('RUNNING');
    expect(listenerCount).toBe(1);

    // Immediately (before the microtask queue runs call 1's .finally()) stop, then start again -- this
    // is exactly the SOL-P5-005 race.
    engine.stop();
    expect(engine.lifecycleState).toBe('STOPPED');
    expect(listenerCount).toBe(0);

    const secondStartPromise = engine.start();

    // The SECOND start must establish a genuinely fresh, active run immediately -- never silently
    // resolve/report success while the engine is actually stopped with no listener.
    expect(engine.lifecycleState).toBe('RUNNING');
    expect(listenerCount).toBe(1);

    await Promise.all([firstStartPromise, secondStartPromise]);
    await new Promise((r) => setTimeout(r, 10));

    // After both operations' deferred cleanup has run, the engine is still correctly RUNNING with
    // exactly one listener: the first (now-obsolete) operation's belated .finally() must not have
    // cleared the second (current) operation's tracking or torn down its subscription.
    expect(engine.lifecycleState).toBe('RUNNING');
    expect(listenerCount).toBe(1);

    engine.stop();
    expect(listenerCount).toBe(0);
  });

  // ===========================================================================================
  // G. MULTIPLE CYCLES: A -> stop -> B -> stop -> C (persistence + recovery callbacks)
  // ===========================================================================================
  it('G. across A -> stop -> B -> stop -> C, a stale Run-A persistence callback and a stale Run-B recovery callback both remain inert in run C', async () => {
    const clock = new FakeClock(MINUTE_0 + 50_000);
    const scheduler = new ManualScheduler();
    const repo = new InMemoryCandleRepository();
    const publishedEventsC: CanonicalStreamEvent[] = [];

    let resolveInsertA!: (v: InsertCandleResult) => void;
    const hangingInsertA = new Promise<InsertCandleResult>((resolve) => {
      resolveInsertA = resolve;
    });
    const originalInsert = repo.insertCandle.bind(repo);
    let insertCallCount = 0;
    repo.insertCandle = vi.fn(async (candle: CanonicalCandle1m) => {
      insertCallCount++;
      if (insertCallCount === 1) await hangingInsertA;
      return originalInsert(candle);
    });

    let rejectRestB!: (err: Error) => void;
    const hangingRestB = new Promise<RestCandleRecord[]>((_resolve, reject) => {
      rejectRestB = reject;
    });
    let restCallCount = 0;
    const restReader = {
      fetchClosedCandles: vi.fn(async () => {
        restCallCount++;
        if (restCallCount === 1) return hangingRestB;
        return [] as RestCandleRecord[];
      }),
    } as unknown as CoinDcxFuturesCandleRestReader;

    const engine = new CanonicalMarketDataEngine({ repository: repo, restReader, clock, scheduler, finalizationGraceMs: 500 });

    // Run A: BTC 12:00 persistence begins and hangs.
    await engine.initializePair(PAIR);
    await engine.handleStreamEnvelope(createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ pair: PAIR, openTimeMs: MINUTE_0 }), { pair: PAIR }));
    clock.setTime(MINUTE_1 + 50_000);
    await engine.handleStreamEnvelope(createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ pair: PAIR, openTimeMs: MINUTE_1 }), { pair: PAIR }));
    scheduler.advanceTime(600);
    await new Promise((r) => setTimeout(r, 10));
    engine.stop();

    // Run B: ETH (a DIFFERENT pair, to isolate this from the cross-pair persistence barrier tested in
    // A/B above) working=12:00, jump to 12:03 -> gap -> recovery request hangs on REST.
    await engine.start();
    await engine.initializePair(PAIR_ETH);
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ pair: PAIR_ETH, openTimeMs: MINUTE_0 }), { pair: PAIR_ETH })
    );
    // The clock is still parked at MINUTE_1 + 50_000 from run A's BTC flow above; it must advance
    // before the MINUTE_3 jump or the F9 far-future-candle check rejects it as INVALID before the gap
    // branch is ever reached (which would leave hangingRestB with zero consumers).
    clock.setTime(MINUTE_3 + 50_000);
    // Not awaited directly: this envelope's handling awaits onRequestRecovery -> executeRecovery ->
    // fetchClosedCandles, which resolves to `hangingRestB` and cannot settle until rejectRestB() runs
    // below (mirroring the fix applied to test D above).
    const ethGapEnvelopePromise = engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ pair: PAIR_ETH, openTimeMs: MINUTE_3, providerEventTimeMs: MINUTE_3 + 5_000 }), {
        pair: PAIR_ETH,
      })
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(engine.getPairHealth(PAIR_ETH)?.state).toBe('RECOVERING');
    engine.stop();

    // Run C: clean start, subscribe, begin initializing BOTH pairs (BTC will wait on the barrier for
    // run A's still-pending write).
    await engine.start();
    engine.subscribe((e) => publishedEventsC.push(e));
    const btcCPromise = engine.initializePair(PAIR);
    const ethCPromise = engine.initializePair(PAIR_ETH);

    // Resolve/reject both stale run A/B operations now, from within run C.
    resolveInsertA({ outcome: 'INSERTED' });
    rejectRestB(new Error('network down'));

    const [btcC, ethC] = await Promise.all([btcCPromise, ethCPromise]);
    // Let run B's now-rejected stale recovery settle through its own (absorbing) catch block.
    await ethGapEnvelopePromise;
    await new Promise((r) => setTimeout(r, 15));

    // Neither stale operation touched run C's state or emitted into run C's subscriber.
    expect(publishedEventsC.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED').length).toBe(0);
    expect(publishedEventsC.filter((e) => e.eventType === 'CANONICAL_1M_INVALID').length).toBe(0);

    expect(btcC.canonicalEpoch).toBe(1);
    expect(btcC.recoveryEpoch).toBe(1);
    // Run C correctly INHERITS run A's now-settled successful write as its baseline (2B) -- proving
    // this is a real cross-run barrier, not merely a "run A stays silent" patch.
    expect(btcC.latestCanonicalOpenTimeMs).toBe(MINUTE_0);

    expect(ethC.canonicalEpoch).toBe(1);
    expect(ethC.recoveryEpoch).toBe(1);
    expect(ethC.truthFault).toBe('NONE');
    expect(ethC.state).toBe('HEALTHY');
    expect(ethC.latestCanonicalOpenTimeMs).toBeNull(); // run B's gap/recovery never actually completed

    // Run C then works normally atop BTC's inherited baseline (next expected minute is MINUTE_1).
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ pair: PAIR, openTimeMs: MINUTE_1, close: new Decimal('50099') }), { pair: PAIR })
    );
    clock.setTime(MINUTE_2 + 50_000);
    await engine.handleStreamEnvelope(createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ pair: PAIR, openTimeMs: MINUTE_2 }), { pair: PAIR }));
    scheduler.advanceTime(600);
    await new Promise((r) => setTimeout(r, 15));

    const persisted = await repo.getCandle(PAIR, MINUTE_1);
    expect(persisted?.close.value).toBe('50099');
    const closedC = publishedEventsC.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED');
    expect(closedC.length).toBe(1);
    expect((closedC[0]!.payload as CanonicalCandle1m).openTimeMs).toBe(MINUTE_1);

    engine.stop();
  });

  // ===========================================================================================
  // H. EVENT DISPATCH OWNERSHIP (SOL-P5-006)
  // ===========================================================================================
  it('H1. a subscriber-triggered stop()/start() mid-dispatch cannot leak the in-flight Run-A event to remaining Run-A recipients or a newly-registered Run-B subscriber; a genuine subsequent Run-B event still delivers normally', async () => {
    const clock = new FakeClock(MINUTE_0 + 50_000);
    const scheduler = new ManualScheduler();
    const repo = new InMemoryCandleRepository();
    const restReader = {
      fetchClosedCandles: vi.fn().mockRejectedValue(new Error('network down')),
    } as unknown as CoinDcxFuturesCandleRestReader;

    const engine = new CanonicalMarketDataEngine({ repository: repo, restReader, clock, scheduler });
    await engine.start();
    await engine.initializePair(PAIR);

    const a1Events: CanonicalStreamEvent[] = [];
    const a2Events: CanonicalStreamEvent[] = [];
    const runBEvents: CanonicalStreamEvent[] = [];
    let restartTriggered = false;

    // Subscribed FIRST -- Set iteration/snapshot order is insertion order, so A1 is always visited before A2.
    engine.subscribe((event) => {
      a1Events.push(event);
      if (event.eventType === 'CANONICAL_1M_INVALID' && !restartTriggered) {
        restartTriggered = true;
        // Synchronously, from inside the ongoing Run-A dispatch: tear down Run A and stand up Run B.
        engine.stop();
        engine.start();
        engine.subscribe((e) => runBEvents.push(e));
      }
    });
    engine.subscribe((event) => a2Events.push(event));

    // Drive a genuine CANONICAL_1M_INVALID through the real production executeRecovery REST-failure path.
    await engine.executeRecovery(PAIR, MINUTE_0, MINUTE_0, 1);

    // A1 (which triggered the restart) legitimately observes the event that caused it to restart.
    expect(a1Events.filter((e) => e.eventType === 'CANONICAL_1M_INVALID').length).toBe(1);
    // A2 was present in the dispatch snapshot before the restart, but the run changed mid-dispatch --
    // dispatch must terminate before reaching it.
    expect(a2Events.filter((e) => e.eventType === 'CANONICAL_1M_INVALID').length).toBe(0);
    // The Run-B subscriber was registered AFTER this dispatch began -- it must receive zero copies of it.
    expect(runBEvents.filter((e) => e.eventType === 'CANONICAL_1M_INVALID').length).toBe(0);
    expect(runBEvents.length).toBe(0);

    // The restart genuinely completed: engine is RUNNING under the new run.
    expect(engine.lifecycleState).toBe('RUNNING');

    // A genuine subsequent Run-B event must still deliver normally to the Run-B subscriber.
    await engine.initializePair(PAIR);
    await engine.executeRecovery(PAIR, MINUTE_0, MINUTE_0, 1);
    expect(runBEvents.filter((e) => e.eventType === 'CANONICAL_1M_INVALID').length).toBe(1);

    engine.stop();
  });

  it('H2. a subscriber registered by another subscriber mid-dispatch (no restart involved) does not receive the event currently in flight', async () => {
    const clock = new FakeClock(MINUTE_0 + 50_000);
    const scheduler = new ManualScheduler();
    const repo = new InMemoryCandleRepository();
    const restReader = {
      fetchClosedCandles: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as CoinDcxFuturesCandleRestReader;

    const engine = new CanonicalMarketDataEngine({ repository: repo, restReader, clock, scheduler });
    await engine.initializePair(PAIR);

    const lateEvents: CanonicalStreamEvent[] = [];
    let lateSubscribed = false;
    engine.subscribe((event) => {
      if (event.eventType === 'CANONICAL_1M_INVALID' && !lateSubscribed) {
        lateSubscribed = true;
        engine.subscribe((e) => lateEvents.push(e));
      }
    });

    await engine.executeRecovery(PAIR, MINUTE_0, MINUTE_0, 1);

    // The recipient snapshot for this dispatch was fixed before the new subscriber was ever added.
    expect(lateEvents.filter((e) => e.eventType === 'CANONICAL_1M_INVALID').length).toBe(0);

    engine.stop();
  });

  it('H3. a subscriber that unsubscribes itself during dispatch is not invoked twice and does not corrupt delivery to remaining subscribers across dispatches', async () => {
    const clock = new FakeClock(MINUTE_0 + 50_000);
    const scheduler = new ManualScheduler();
    const repo = new InMemoryCandleRepository();
    const restReader = {
      fetchClosedCandles: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as CoinDcxFuturesCandleRestReader;

    const engine = new CanonicalMarketDataEngine({ repository: repo, restReader, clock, scheduler });
    await engine.initializePair(PAIR);

    let callCountA = 0;
    let callCountB = 0;
    const unsubA = engine.subscribe(() => {
      callCountA++;
      unsubA();
    });
    engine.subscribe(() => {
      callCountB++;
    });

    // executeRecovery emits twice: CANONICAL_1M_RECOVERY_REQUIRED (before the REST await), then
    // CANONICAL_1M_INVALID (from the REST rejection). A unsubscribes itself during the FIRST dispatch,
    // so it must not be present for the SECOND.
    await engine.executeRecovery(PAIR, MINUTE_0, MINUTE_0, 1);

    expect(callCountA).toBe(1);
    expect(callCountB).toBe(2);

    engine.stop();
  });
});
