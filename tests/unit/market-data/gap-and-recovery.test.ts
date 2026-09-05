import { describe, expect, it } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { CanonicalMarketDataEngine } from '../../../src/market-data/canonical-engine';
import { createCanonicalCandle1m } from '../../../src/market-data/models';
import { PairCanonicalStateMachine } from '../../../src/market-data/pair-state';
import { CanonicalCandle1m } from '../../../src/market-data/types';
import { CoinDcxFuturesCandleRestReader } from '../../../src/market-data/rest-candle-reader';
import {
  createTestCandlePayload,
  createTestEnvelope,
  FakeClock,
  InMemoryCandleRepository,
  ManualScheduler,
  MockFuturesCandleRestReader,
} from './test-helpers';

describe('Phase 5 — Gap Detection, Generation Barrier & Recovery Protocol', () => {
  const PAIR_BTC = 'B-BTC_USDT';
  const PAIR_ETH = 'B-ETH_USDT';
  const MINUTE_0 = 1700000040000;
  const MINUTE_1 = 1700000100000;
  const MINUTE_2 = 1700000160000;
  const MINUTE_3 = 1700000220000;
  const MINUTE_4 = 1700000280000;

  it('12. exact one-minute continuity', async () => {
    const clock = new FakeClock(MINUTE_0 + 35000);
    const scheduler = new ManualScheduler();
    const finalized: CanonicalCandle1m[] = [];
    const recoveries: { pair: string; fromMs: number; toMs: number }[] = [];

    const state = new PairCanonicalStateMachine(
      { pair: PAIR_BTC, clock, scheduler, finalizationGraceMs: 500 },
      {
        onFinalizeCandle: async (c) => { finalized.push(c); },
        onRequestRecovery: async (p, from, to) => { recoveries.push({ pair: p, fromMs: from, toMs: to }); },
        onConflictDetected: () => {},
        getPersistedCandle: async () => null,
      }
    );

    // Minute 0 -> Minute 1 -> Minute 2
    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_0, providerEventTimeMs: MINUTE_0 + 30000 }),
      { sequence: 1, receivedAtMs: MINUTE_0 + 30050, generationId: 1 }
    );

    clock.setTime(MINUTE_1 + 35000);
    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_1, providerEventTimeMs: MINUTE_1 + 30000 }),
      { sequence: 2, receivedAtMs: MINUTE_1 + 30050, generationId: 1 }
    );
    scheduler.advanceTime(600); // finalize minute 0

    clock.setTime(MINUTE_2 + 35000);
    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_2, providerEventTimeMs: MINUTE_2 + 30000 }),
      { sequence: 3, receivedAtMs: MINUTE_2 + 30050, generationId: 1 }
    );
    scheduler.advanceTime(600); // finalize minute 1

    expect(state.state).toBe('HEALTHY');
    expect(recoveries.length).toBe(0);
    expect(finalized.length).toBe(2);
    expect(finalized[0]!.openTimeMs).toBe(MINUTE_0);
    expect(finalized[1]!.openTimeMs).toBe(MINUTE_1);
    expect(state.getHealthSnapshot().gapCount).toBe(0);
  });

  it('13. single missing minute detection', async () => {
    const clock = new FakeClock(MINUTE_0 + 35000);
    const scheduler = new ManualScheduler();
    const finalized: CanonicalCandle1m[] = [];
    const recoveries: { pair: string; fromMs: number; toMs: number }[] = [];

    const state = new PairCanonicalStateMachine(
      { pair: PAIR_BTC, clock, scheduler },
      {
        onFinalizeCandle: async (c) => { finalized.push(c); },
        onRequestRecovery: async (p, from, to) => { recoveries.push({ pair: p, fromMs: from, toMs: to }); },
        onConflictDetected: () => {},
        getPersistedCandle: async () => null,
      }
    );

    // Minute 0 arrives
    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_0, providerEventTimeMs: MINUTE_0 + 30000 }),
      { sequence: 1, receivedAtMs: MINUTE_0 + 30050, generationId: 1 }
    );

    // Minute 2 arrives directly (Minute 1 is missing!)
    clock.setTime(MINUTE_2 + 35000);
    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_2, providerEventTimeMs: MINUTE_2 + 30000 }),
      { sequence: 2, receivedAtMs: MINUTE_2 + 30050, generationId: 1 }
    );

    expect(state.state).toBe('RECOVERING');
    expect(state.getHealthSnapshot().gapCount).toBe(1);
    expect(recoveries.length).toBe(1);
    // F2: Minute 0 was still an unfinalized working candle (no successor ever confirmed it) when the
    // gap was detected, so it must become part of the REST verification interval too — otherwise it
    // would be silently orphaned (never finalized via WS, never covered by REST).
    expect(recoveries[0]).toEqual({
      pair: PAIR_BTC,
      fromMs: MINUTE_0,
      toMs: MINUTE_1,
    });
  });

  it('14. multi-minute gap detection', async () => {
    const clock = new FakeClock(MINUTE_0 + 35000);
    const scheduler = new ManualScheduler();
    const recoveries: { pair: string; fromMs: number; toMs: number }[] = [];

    const state = new PairCanonicalStateMachine(
      { pair: PAIR_BTC, clock, scheduler },
      {
        onFinalizeCandle: async () => {},
        onRequestRecovery: async (p, from, to) => { recoveries.push({ pair: p, fromMs: from, toMs: to }); },
        onConflictDetected: () => {},
        getPersistedCandle: async () => null,
      }
    );

    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_0, providerEventTimeMs: MINUTE_0 + 30000 }),
      { sequence: 1, receivedAtMs: MINUTE_0 + 30050, generationId: 1 }
    );

    // Jumps directly to Minute 4 (skipping 1, 2, 3)
    clock.setTime(MINUTE_4 + 35000);
    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_4, providerEventTimeMs: MINUTE_4 + 30000 }),
      { sequence: 2, receivedAtMs: MINUTE_4 + 30050, generationId: 1 }
    );

    expect(state.state).toBe('RECOVERING');
    expect(recoveries.length).toBe(1);
    // F2: Minute 0's working candle was never finalized; it must be included in the verification range.
    expect(recoveries[0]).toEqual({
      pair: PAIR_BTC,
      fromMs: MINUTE_0,
      toMs: MINUTE_3,
    });
  });

  it('15. no fake candle creation', async () => {
    const clock = new FakeClock(MINUTE_0 + 35000);
    const scheduler = new ManualScheduler();
    const finalized: CanonicalCandle1m[] = [];

    const state = new PairCanonicalStateMachine(
      { pair: PAIR_BTC, clock, scheduler },
      {
        onFinalizeCandle: async (c) => { finalized.push(c); },
        onRequestRecovery: async () => {},
        onConflictDetected: () => {},
        getPersistedCandle: async () => null,
      }
    );

    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_0, providerEventTimeMs: MINUTE_0 + 30000 }),
      { sequence: 1, receivedAtMs: MINUTE_0 + 30050, generationId: 1 }
    );

    // Gap jump to Minute 3
    clock.setTime(MINUTE_3 + 35000);
    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_3, providerEventTimeMs: MINUTE_3 + 30000 }),
      { sequence: 2, receivedAtMs: MINUTE_3 + 30050, generationId: 1 }
    );

    scheduler.advanceTime(5000);

    // No synthetic / zero-volume / flat candles should be created
    expect(finalized.length).toBe(0);
    expect(finalized.find((c) => c.openTimeMs === MINUTE_1)).toBeUndefined();
    expect(finalized.find((c) => c.openTimeMs === MINUTE_2)).toBeUndefined();
  });

  it('16. public reconnect creates recovery barrier', async () => {
    const clock = new FakeClock(MINUTE_0 + 35000);
    const scheduler = new ManualScheduler();
    const state = new PairCanonicalStateMachine(
      { pair: PAIR_BTC, clock, scheduler },
      {
        onFinalizeCandle: async () => {},
        onRequestRecovery: async () => {},
        onConflictDetected: () => {},
        getPersistedCandle: async () => null,
      }
    );

    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_0, providerEventTimeMs: MINUTE_0 + 30000 }),
      { sequence: 1, receivedAtMs: MINUTE_0 + 30050, generationId: 1 }
    );
    expect(state.state).toBe('HEALTHY');

    // Trigger reconnect barrier
    state.handleReconnectBarrier(2);

    expect(state.state).toBe('RECOVERING');
    expect(state.getHealthSnapshot().recoveryRequired).toBe(true);
  });

  it('17. old generation cannot mutate Phase 5', async () => {
    const clock = new FakeClock(MINUTE_0 + 35000);
    const scheduler = new ManualScheduler();
    const state = new PairCanonicalStateMachine(
      { pair: PAIR_BTC, clock, scheduler },
      {
        onFinalizeCandle: async () => {},
        onRequestRecovery: async () => {},
        onConflictDetected: () => {},
        getPersistedCandle: async () => null,
      }
    );

    // Reconnect advanced generation to 2
    state.handleReconnectBarrier(2);

    // Stale envelope from generation 1 arrives
    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_0, providerEventTimeMs: MINUTE_0 + 30000 }),
      { sequence: 10, receivedAtMs: MINUTE_0 + 30050, generationId: 1 }
    );

    const snapshot = state.getHealthSnapshot();
    expect(snapshot.lateDropCount).toBe(1);
    expect(snapshot.workingOpenTimeMs).toBeNull();
  });

  it('18. new-generation live update cannot bypass unresolved recovery', async () => {
    const clock = new FakeClock(MINUTE_1 + 35000);
    const scheduler = new ManualScheduler();
    const finalized: CanonicalCandle1m[] = [];

    const state = new PairCanonicalStateMachine(
      { pair: PAIR_BTC, clock, scheduler, finalizationGraceMs: 500 },
      {
        onFinalizeCandle: async (c) => { finalized.push(c); },
        onRequestRecovery: async () => {},
        onConflictDetected: () => {},
        getPersistedCandle: async () => null,
      }
    );

    state.handleReconnectBarrier(2);
    expect(state.state).toBe('RECOVERING');

    // New generation live update arrives
    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_1, providerEventTimeMs: MINUTE_1 + 10000 }),
      { sequence: 1, receivedAtMs: MINUTE_1 + 10050, generationId: 2 }
    );

    // Another live update arrives for successor
    clock.setTime(MINUTE_2 + 35000);
    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_2, providerEventTimeMs: MINUTE_2 + 10000 }),
      { sequence: 2, receivedAtMs: MINUTE_2 + 10050, generationId: 2 }
    );

    scheduler.advanceTime(1000);

    // While recovery is unresolved, updates must be buffered and NOT published
    expect(finalized.length).toBe(0);
    expect(state.getHealthSnapshot().bufferedLiveUpdateCount).toBe(2);
  });

  it('24. recovery completes only with exact continuous coverage', async () => {
    const clock = new FakeClock(MINUTE_2 + 35000);
    const repo = new InMemoryCandleRepository();
    const restReader = new MockFuturesCandleRestReader();

    // Return partial coverage: requested MINUTE_1 to MINUTE_2, but only MINUTE_1 is returned
    restReader.recordsToReturn = [
      {
        pair: PAIR_BTC,
        openTimeMs: MINUTE_1,
        open: new Decimal('50000.0'),
        high: new Decimal('50100.0'),
        low: new Decimal('49900.0'),
        close: new Decimal('50050.0'),
        volume: new Decimal('10.0'),
        quoteVolume: null,
      },
    ];

    const engine = new CanonicalMarketDataEngine({
      repository: repo,
      restReader: restReader as unknown as CoinDcxFuturesCandleRestReader,
      clock,
    });
    await engine.initializePair(PAIR_BTC);

    // Execute recovery for MINUTE_1 through MINUTE_2
    await engine.executeRecovery(PAIR_BTC, MINUTE_1, MINUTE_2);

    // Coverage was incomplete, so pair state must remain RECOVERING
    const health = engine.getPairHealth(PAIR_BTC)!;
    expect(health.state).toBe('RECOVERING');
    engine.stop();
  });

  it('25. buffered live updates drain chronologically after recovery', async () => {
    const clock = new FakeClock(MINUTE_2 + 35000);
    const scheduler = new ManualScheduler();
    const finalized: CanonicalCandle1m[] = [];

    const state = new PairCanonicalStateMachine(
      { pair: PAIR_BTC, clock, scheduler, finalizationGraceMs: 500 },
      {
        onFinalizeCandle: async (c) => { finalized.push(c); },
        onRequestRecovery: async () => {},
        onConflictDetected: () => {},
        getPersistedCandle: async () => null,
      }
    );

    // Put into recovery
    state.handleReconnectBarrier(2);

    // Buffer live updates for Minute 2 and Minute 3
    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_2, providerEventTimeMs: MINUTE_2 + 10000 }),
      { sequence: 1, receivedAtMs: MINUTE_2 + 10050, generationId: 2 }
    );

    clock.setTime(MINUTE_3 + 35000);
    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_3, providerEventTimeMs: MINUTE_3 + 10000 }),
      { sequence: 2, receivedAtMs: MINUTE_3 + 10050, generationId: 2 }
    );
    expect(state.getHealthSnapshot().bufferedLiveUpdateCount).toBe(2);

    // REST provides recovered candles for Minute 0 and Minute 1
    const recovered0 = createCanonicalCandle1m({
      pair: PAIR_BTC,
      openTimeMs: MINUTE_0,
      open: new Decimal('50000'),
      high: new Decimal('50100'),
      low: new Decimal('49900'),
      close: new Decimal('50050'),
      volume: new Decimal('10'),
      quoteVolume: null,
      source: 'REST_RECOVERY',
      finalizedAtMs: MINUTE_0 + 60000,
      providerEventTimeMs: null,
      generationId: null,
    });
    const recovered1 = createCanonicalCandle1m({
      pair: PAIR_BTC,
      openTimeMs: MINUTE_1,
      open: new Decimal('50050'),
      high: new Decimal('50200'),
      low: new Decimal('50000'),
      close: new Decimal('50150'),
      volume: new Decimal('12'),
      quoteVolume: null,
      source: 'REST_RECOVERY',
      finalizedAtMs: MINUTE_1 + 60000,
      providerEventTimeMs: null,
      generationId: null,
    });

    await state.applyRecoveredCandlesAndDrainBuffer([recovered0, recovered1]);

    // Recovered candles finalized, buffer emptied, state returned to HEALTHY
    expect(state.state).toBe('HEALTHY');
    expect(state.getHealthSnapshot().bufferedLiveUpdateCount).toBe(0);
    expect(finalized.some((c) => c.openTimeMs === MINUTE_0)).toBe(true);
    expect(finalized.some((c) => c.openTimeMs === MINUTE_1)).toBe(true);
  });

  it('26. bounded recovery buffer', async () => {
    const clock = new FakeClock(MINUTE_1 + 35000);
    const scheduler = new ManualScheduler();
    const state = new PairCanonicalStateMachine(
      { pair: PAIR_BTC, clock, scheduler, maxRecoveryBuffer: 3 },
      {
        onFinalizeCandle: async () => {},
        onRequestRecovery: async () => {},
        onConflictDetected: () => {},
        getPersistedCandle: async () => null,
      }
    );

    state.handleReconnectBarrier(2);

    // Buffer 3 updates (within capacity)
    for (let i = 0; i < 3; i++) {
      clock.setTime(MINUTE_1 + i * 60000 + 35000);
      await state.handleCandleUpdate(
        createTestCandlePayload({
          openTimeMs: MINUTE_1 + i * 60000,
          providerEventTimeMs: MINUTE_1 + i * 60000 + 30000,
        }),
        { sequence: i + 1, receivedAtMs: MINUTE_1 + i * 60000 + 30050, generationId: 2 }
      );
    }
    expect(state.state).toBe('RECOVERING');

    // 4th update exceeds max capacity of 3: fail closed
    clock.setTime(MINUTE_1 + 3 * 60000 + 35000);
    await state.handleCandleUpdate(
      createTestCandlePayload({
        openTimeMs: MINUTE_1 + 3 * 60000,
        providerEventTimeMs: MINUTE_1 + 3 * 60000 + 30000,
      }),
      { sequence: 4, receivedAtMs: MINUTE_1 + 3 * 60000 + 30050, generationId: 2 }
    );
    expect(state.state).toBe('INVALID');
  });

  it('27. BTC recovery does not block/corrupt ETH', async () => {
    const clock = new FakeClock(MINUTE_0 + 35000);
    const scheduler = new ManualScheduler();
    const repo = new InMemoryCandleRepository();
    const restReader = new MockFuturesCandleRestReader();

    const engine = new CanonicalMarketDataEngine({
      repository: repo,
      restReader: restReader as unknown as CoinDcxFuturesCandleRestReader,
      clock,
      scheduler,
      finalizationGraceMs: 500,
    });

    await engine.initializePair(PAIR_BTC);
    await engine.initializePair(PAIR_ETH);

    // BTC enters recovery - send gap to BTC
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ pair: PAIR_BTC, openTimeMs: MINUTE_0 }), { pair: PAIR_BTC })
    );

    clock.setTime(MINUTE_3 + 35000);
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ pair: PAIR_BTC, openTimeMs: MINUTE_3 }), { pair: PAIR_BTC })
    );

    expect(engine.getPairHealth(PAIR_BTC)?.state).toBe('RECOVERING');

    // ETH continues normal steady stream
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ pair: PAIR_ETH, openTimeMs: MINUTE_0 }), { pair: PAIR_ETH })
    );

    clock.setTime(MINUTE_3 + 35000);
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ pair: PAIR_ETH, openTimeMs: MINUTE_1 }), { pair: PAIR_ETH })
    );

    scheduler.advanceTime(600);
    // The engine-level cross-run persistence coordinator (SOL-P5-001) serializes the physical write
    // behind a real await even for a pair with no prior activity, so a microtask flush is required here
    // (matching the pattern used by every other test that checks repository state after a grace timer).
    await new Promise((r) => setTimeout(r, 10));

    // ETH successfully finalized minute 0 and remains HEALTHY
    expect(engine.getPairHealth(PAIR_ETH)?.state).toBe('HEALTHY');
    const ethCandle = await repo.getCandle(PAIR_ETH, MINUTE_0);
    expect(ethCandle).not.toBeNull();
    expect(ethCandle?.pair).toBe(PAIR_ETH);

    // BTC remains isolated in RECOVERING without corrupting ETH
    expect(engine.getPairHealth(PAIR_BTC)?.state).toBe('RECOVERING');

    engine.stop();
  });
});
