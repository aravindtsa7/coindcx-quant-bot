import { describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { FakeClock } from '../../../src/integration/coindcx/clock';
import { CanonicalMarketDataEngine } from '../../../src/market-data/canonical-engine';
import { PairCanonicalStateMachine } from '../../../src/market-data/pair-state';
import { CanonicalCandle1m, CanonicalStreamEvent } from '../../../src/market-data/types';
import { ManualScheduler } from '../coindcx/ws/test-helpers';
import {
  InMemoryCandleRepository,
  TEST_BASE_MINUTE_MS,
  createTestCandlePayload,
  createTestEnvelope,
} from './test-helpers';

/**
 * Phase 5 — RESTART-INITIALIZATION-RACE correction regression suite.
 *
 * initializePair() is asynchronous (it awaits repository.getLatestCanonicalCandle). Confirmed defect:
 * if stop()/start() lands while an OLD run's initializePair() call is still awaiting that read, the
 * stale read resolving later could construct and install an old-run state machine, overwriting a
 * newer run's already-active instance for the same pair. Every test here drives the real
 * CanonicalMarketDataEngine production path with a deferred (manually-controlled) repository promise.
 */
describe('Phase 5 — RESTART-INITIALIZATION-RACE Correction', () => {
  const PAIR = 'B-BTC_USDT';
  const MINUTE_0 = TEST_BASE_MINUTE_MS;
  const MINUTE_1 = MINUTE_0 + 60_000;

  /** Wraps a repository so its Nth call to getLatestCanonicalCandle can be held open on demand. */
  function deferredLookupRepo() {
    const repo = new InMemoryCandleRepository();
    const originalGetLatest = repo.getLatestCanonicalCandle.bind(repo);
    const deferred: Array<{ resolve: (v: CanonicalCandle1m | null) => void }> = [];
    let callCount = 0;
    const holds: boolean[] = []; // holds[i] === true means call i+1 should hang until manually released

    repo.getLatestCanonicalCandle = vi.fn(async (pair: string) => {
      const index = callCount++;
      if (holds[index]) {
        return new Promise<CanonicalCandle1m | null>((resolve) => {
          deferred[index] = { resolve };
        });
      }
      return originalGetLatest(pair);
    });

    return {
      repo,
      holdNextCall: () => {
        holds[callCount] = true;
      },
      releaseCall: (index: number, value: CanonicalCandle1m | null = null) => {
        deferred[index]!.resolve(value);
      },
      get callCount() {
        return callCount;
      },
    };
  }

  it('1+2. stale Run-A initializePair cannot overwrite Run-B pair state; Run-B then processes normally', async () => {
    const clock = new FakeClock(MINUTE_0 + 50_000);
    const scheduler = new ManualScheduler();
    const { repo, holdNextCall, releaseCall } = deferredLookupRepo();
    const publishedEvents: CanonicalStreamEvent[] = [];

    const engine = new CanonicalMarketDataEngine({ repository: repo, clock, scheduler, finalizationGraceMs: 500 });
    engine.subscribe((e) => publishedEvents.push(e));

    // Run A: start(), initializePair(BTC) begins, its DB read is held open.
    await engine.start();
    holdNextCall();
    const runAPromise = engine.initializePair(PAIR);
    await Promise.resolve(); // let the synchronous portion register the (now-pending) DB read

    // stop() ends run A while that read is still unresolved.
    engine.stop();

    // Run B: start(), initializePair(BTC) completes normally (its own, separate DB read).
    // engine.stop() clears subscribers by design, so run B must (re-)subscribe like any real consumer
    // reconnecting after a restart.
    await engine.start();
    engine.subscribe((e) => publishedEvents.push(e));
    const runBPairState = await engine.initializePair(PAIR);
    expect(runBPairState).toBeInstanceOf(PairCanonicalStateMachine);

    // Now resolve the OLD Run-A repository lookup.
    releaseCall(0, null);
    const runAResolved = await runAPromise;
    await new Promise((r) => setTimeout(r, 10));

    // Run-B's map entry remains EXACTLY the same active instance -- re-fetching via initializePair()
    // must yield the identical object, and Run A's own promise must resolve to that SAME instance
    // rather than installing/returning a different (stale) one.
    const reFetched = await engine.initializePair(PAIR);
    expect(reFetched).toBe(runBPairState);
    expect(runAResolved).toBe(runBPairState);

    // No health/watermark/freshness mutation from run A, and no CANONICAL_1M_CLOSED from it.
    expect(runBPairState.latestCanonicalOpenTimeMs).toBeNull();
    expect(runBPairState.canonicalEpoch).toBe(1);
    expect(runBPairState.getHealthSnapshot().lastValidProviderEventTimeMs).toBeNull();
    expect(publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED').length).toBe(0);
    expect(scheduler.activeTimerCount).toBe(0); // no stale timers from run A's (non-)initialization

    // Run B then processes fresh, valid market data normally.
    clock.setTime(MINUTE_0 + 50_000);
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0, close: new Decimal('50020') }))
    );
    clock.setTime(MINUTE_1 + 50_000);
    await engine.handleStreamEnvelope(createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1 })));
    scheduler.advanceTime(600);
    await new Promise((r) => setTimeout(r, 15));

    const persisted = await repo.getCandle(PAIR, MINUTE_0);
    expect(persisted).not.toBeNull();
    expect(persisted?.close.value).toBe('50020');
    expect(runBPairState.latestCanonicalOpenTimeMs).toBe(MINUTE_0);
    const closedEvents = publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED');
    expect(closedEvents.length).toBe(1);

    engine.stop();
  });

  it('3. stop during an unresolved initialization (no restart) leaves no pair installed and stays inert', async () => {
    const clock = new FakeClock(MINUTE_0 + 50_000);
    const scheduler = new ManualScheduler();
    const { repo, holdNextCall, releaseCall } = deferredLookupRepo();
    const publishedEvents: CanonicalStreamEvent[] = [];

    const engine = new CanonicalMarketDataEngine({ repository: repo, clock, scheduler });
    engine.subscribe((e) => publishedEvents.push(e));

    await engine.start();
    holdNextCall();
    const initPromise = engine.initializePair(PAIR);
    await Promise.resolve();

    engine.stop();
    expect(engine.lifecycleState).toBe('STOPPED');

    // The old DB read resolves after stop(), with no subsequent run ever re-initializing this pair.
    releaseCall(0, null);
    // The stale attempt has nothing valid to fall back to (no newer-run instance exists), so its own
    // promise settles as a rejection -- verify it does NOT hang forever and does NOT resolve to a
    // fabricated/installed instance.
    await expect(initPromise).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 10));

    expect(engine.getPairHealth(PAIR)).toBeUndefined(); // pair absent from #pairStates
    expect(scheduler.activeTimerCount).toBe(0); // no timer was ever created
    expect(publishedEvents.length).toBe(0); // no event publication
    expect(engine.lifecycleState).toBe('STOPPED'); // lifecycle remains stopped
  });

  it('4. two concurrent initializePair() calls within the SAME run are single-flight: one DB read, one instance', async () => {
    const clock = new FakeClock(MINUTE_0 + 50_000);
    const { repo, holdNextCall, releaseCall } = deferredLookupRepo();

    const engine = new CanonicalMarketDataEngine({ repository: repo, clock });

    holdNextCall();
    const first = engine.initializePair(PAIR);
    const second = engine.initializePair(PAIR);
    await Promise.resolve();

    // Only one DB read was issued for the two concurrent calls.
    expect(repo.getLatestCanonicalCandle).toHaveBeenCalledTimes(1);

    releaseCall(0, null);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    // Same logical initialization: identical instance, no duplicate installation.
    expect(firstResult).toBe(secondResult);
    expect(await engine.initializePair(PAIR)).toBe(firstResult);

    engine.stop();
  });

  it('5. A -> B -> C: old A/B initialization callbacks resolving during run C remain inert', async () => {
    const clock = new FakeClock(MINUTE_0 + 50_000);
    const scheduler = new ManualScheduler();
    const { repo, holdNextCall, releaseCall } = deferredLookupRepo();
    const publishedEvents: CanonicalStreamEvent[] = [];

    const engine = new CanonicalMarketDataEngine({ repository: repo, clock, scheduler });
    engine.subscribe((e) => publishedEvents.push(e));

    // Run A: begins initialization, held open.
    await engine.start();
    holdNextCall();
    const runAPromise = engine.initializePair(PAIR);
    await Promise.resolve();
    engine.stop();

    // Run B: also begins initialization, ALSO held open (its own read).
    await engine.start();
    holdNextCall();
    const runBPromise = engine.initializePair(PAIR);
    await Promise.resolve();
    engine.stop();

    // Run C: completes normally.
    await engine.start();
    const runCPairState = await engine.initializePair(PAIR);
    expect(runCPairState).toBeInstanceOf(PairCanonicalStateMachine);

    // Now resolve BOTH stale reads (A first, then B), simulating out-of-order late resolution.
    releaseCall(0, null); // Run A's read
    const runAResolved = await runAPromise;
    releaseCall(1, null); // Run B's read
    const runBResolved = await runBPromise;
    await new Promise((r) => setTimeout(r, 10));

    // Both old runs' initializations are inert: neither installed anything of its own, and both hand
    // back the CURRENT (run C) instance rather than a stale one.
    expect(runAResolved).toBe(runCPairState);
    expect(runBResolved).toBe(runCPairState);
    expect(await engine.initializePair(PAIR)).toBe(runCPairState);

    expect(runCPairState.latestCanonicalOpenTimeMs).toBeNull();
    expect(runCPairState.canonicalEpoch).toBe(1);
    expect(publishedEvents.filter((e) => e.eventType === 'CANONICAL_1M_CLOSED').length).toBe(0);
    expect(scheduler.activeTimerCount).toBe(0);

    engine.stop();
  });
});
