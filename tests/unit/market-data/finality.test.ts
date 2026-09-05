import { describe, expect, it } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { PairCanonicalStateMachine } from '../../../src/market-data/pair-state';
import { CanonicalCandle1m } from '../../../src/market-data/types';
import {
  createTestCandlePayload,
  FakeClock,
  ManualScheduler,
} from './test-helpers';

describe('Phase 5 — Successor-Confirmed Finality & Clock Safety', () => {
  const PAIR = 'B-BTC_USDT';
  const MINUTE_0 = 1700000040000;
  const MINUTE_1 = 1700000100000;

  function createTestState(options: {
    finalizationGraceMs?: number;
    maxFutureSkewMs?: number;
    clockTime?: number;
  } = {}) {
    const clock = new FakeClock(options.clockTime ?? MINUTE_0 + 35000);
    const scheduler = new ManualScheduler();
    const finalized: CanonicalCandle1m[] = [];
    const recoveries: { pair: string; fromMs: number; toMs: number }[] = [];
    const conflicts: { pair: string; message: string }[] = [];

    const state = new PairCanonicalStateMachine(
      {
        pair: PAIR,
        clock,
        scheduler,
        finalizationGraceMs: options.finalizationGraceMs ?? 1000,
        maxFutureSkewMs: options.maxFutureSkewMs ?? 5000,
      },
      {
        onFinalizeCandle: async (c) => {
          finalized.push(c);
        },
        onRequestRecovery: async (p, from, to) => {
          recoveries.push({ pair: p, fromMs: from, toMs: to });
        },
        onConflictDetected: (p, msg) => {
          conflicts.push({ pair: p, message: msg });
        },
        getPersistedCandle: async () => null,
      }
    );

    return { state, clock, scheduler, finalized, recoveries, conflicts };
  }

  const defaultMeta = { sequence: 1, receivedAtMs: MINUTE_0 + 30100, generationId: 1 };

  it('6. successor minute makes previous eligible, not immediately unsafe', async () => {
    const { state, clock, scheduler, finalized } = createTestState({ finalizationGraceMs: 1000 });

    // Send minute 0 updates
    await state.handleCandleUpdate(
      createTestCandlePayload({
        openTimeMs: MINUTE_0,
        providerEventTimeMs: MINUTE_0 + 30000,
      }),
      defaultMeta
    );
    expect(finalized.length).toBe(0);

    // Send successor minute 1 with clock advancing
    clock.setTime(MINUTE_1 + 1050);
    await state.handleCandleUpdate(
      createTestCandlePayload({
        openTimeMs: MINUTE_1,
        providerEventTimeMs: MINUTE_1 + 1000,
      }),
      { sequence: 2, receivedAtMs: MINUTE_1 + 1050, generationId: 1 }
    );

    // Minute 0 is now eligible, but bounded grace timer (1000ms) has NOT expired yet
    expect(finalized.length).toBe(0);
    expect(scheduler.activeTimerCount).toBeGreaterThan(0);

    // Advance scheduler past the grace period
    scheduler.advanceTime(1001);
    await Promise.resolve();

    expect(finalized.length).toBe(1);
    expect(finalized[0]!.openTimeMs).toBe(MINUTE_0);
    expect(finalized[0]!.closeTimeExclusiveMs).toBe(MINUTE_0 + 60000);
    expect(finalized[0]!.source).toBe('WS_FINALIZED');
  });

  it('7. finalization grace accepts valid late update', async () => {
    const { state, clock, scheduler, finalized } = createTestState({ finalizationGraceMs: 1000 });

    // Initial minute 0 update
    await state.handleCandleUpdate(
      createTestCandlePayload({
        openTimeMs: MINUTE_0,
        providerEventTimeMs: MINUTE_0 + 30000,
        close: new Decimal('50000.0'),
        volume: new Decimal('10.0'),
      }),
      defaultMeta
    );

    // Successor minute 1 arrives, scheduling grace timer for minute 0
    clock.setTime(MINUTE_1 + 600);
    await state.handleCandleUpdate(
      createTestCandlePayload({
        openTimeMs: MINUTE_1,
        providerEventTimeMs: MINUTE_1 + 500,
      }),
      { sequence: 2, receivedAtMs: MINUTE_1 + 550, generationId: 1 }
    );
    expect(finalized.length).toBe(0);

    // Late packet for minute 0 arrives during grace window (500ms into grace)
    scheduler.advanceTime(500);
    await state.handleCandleUpdate(
      createTestCandlePayload({
        openTimeMs: MINUTE_0,
        providerEventTimeMs: MINUTE_0 + 59999, // newer timestamp for minute 0
        high: new Decimal('50300.0'),
        close: new Decimal('50200.0'),
        volume: new Decimal('12.0'),
      }),
      { sequence: 3, receivedAtMs: MINUTE_1 + 500, generationId: 1 }
    );

    // Now advance remaining grace time (501ms)
    scheduler.advanceTime(501);
    await Promise.resolve();

    // Verified: minute 0 was finalized with the updated late data
    expect(finalized.length).toBe(1);
    expect(finalized[0]!.openTimeMs).toBe(MINUTE_0);
    expect(finalized[0]!.close.toString()).toBe('50200');
    expect(finalized[0]!.volume.toString()).toBe('12');
  });

  it('8. finalization timer cleans correctly', async () => {
    const { state, clock, scheduler } = createTestState({ finalizationGraceMs: 1000 });

    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_0, providerEventTimeMs: MINUTE_0 + 30000 }),
      defaultMeta
    );

    clock.setTime(MINUTE_1 + 1050);
    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_1, providerEventTimeMs: MINUTE_1 + 1000 }),
      { sequence: 2, receivedAtMs: MINUTE_1 + 1050, generationId: 1 }
    );

    expect(scheduler.activeTimerCount).toBeGreaterThan(0);

    // Call stop()
    state.stop();

    // All timers cleared immediately with zero open handles
    expect(scheduler.activeTimerCount).toBe(0);
  });

  it('9. no successor => no canonical close', async () => {
    const { state, clock, scheduler, finalized } = createTestState({
      clockTime: MINUTE_0 + 35000,
    });

    await state.handleCandleUpdate(
      createTestCandlePayload({
        openTimeMs: MINUTE_0,
        providerEventTimeMs: MINUTE_0 + 30000,
        close: new Decimal('50000.0'),
      }),
      defaultMeta
    );

    // Advance local wall clock by 10 minutes
    clock.advance(600000);
    scheduler.advanceTime(600000);

    // No successor was observed from WebSocket! Wall clock alone NEVER triggers finalization.
    expect(finalized.length).toBe(0);
    expect(state.latestCanonicalOpenTimeMs).toBeNull();
  });

  it('10. minute alignment validation', async () => {
    const { state } = createTestState();

    // Pass non-aligned openTimeMs: 1700000040123 (% 60000 !== 0)
    await state.handleCandleUpdate(
      createTestCandlePayload({
        openTimeMs: 1700000040123,
      }),
      defaultMeta
    );

    expect(state.state).toBe('INVALID');
  });

  it('11. provider forward skew cannot finalize early', async () => {
    // Current local clock is MINUTE_0 + 10_000, max skew tolerance is 5_000ms
    const { state, clock, finalized } = createTestState({
      clockTime: MINUTE_0 + 10000,
      maxFutureSkewMs: 5000,
    });

    await state.handleCandleUpdate(
      createTestCandlePayload({
        openTimeMs: MINUTE_0,
        providerEventTimeMs: MINUTE_0 + 10000,
      }),
      defaultMeta
    );

    // Incoming packet claims providerEventTime is 20_000ms into future (excess skew)
    await state.handleCandleUpdate(
      createTestCandlePayload({
        openTimeMs: MINUTE_1, // Purported successor
        providerEventTimeMs: clock.nowMs() + 20000, // 20s ahead of local clock
      }),
      { sequence: 2, receivedAtMs: clock.nowMs(), generationId: 1 }
    );

    // Must fail-closed, degrade health, and NOT finalize minute 0
    expect(state.state).toBe('DEGRADED');
    expect(finalized.length).toBe(0);
  });

  it('35. quoteVolume absence is not fabricated as zero', async () => {
    const { state, clock, scheduler, finalized } = createTestState({ finalizationGraceMs: 1000 });

    // Payload with quoteVolume explicitly null
    await state.handleCandleUpdate(
      createTestCandlePayload({
        openTimeMs: MINUTE_0,
        providerEventTimeMs: MINUTE_0 + 30000,
        quoteVolume: null,
      }),
      defaultMeta
    );

    // Successor triggers finalization
    clock.setTime(MINUTE_1 + 1050);
    await state.handleCandleUpdate(
      createTestCandlePayload({
        openTimeMs: MINUTE_1,
        providerEventTimeMs: MINUTE_1 + 1000,
      }),
      { sequence: 2, receivedAtMs: MINUTE_1 + 1050, generationId: 1 }
    );
    scheduler.advanceTime(1001);
    await Promise.resolve();

    expect(finalized.length).toBe(1);
    expect(finalized[0]!.quoteVolume).toBeNull();
    // Invariant: quoteVolume must NOT be fabricated as 0
    expect(finalized[0]!.quoteVolume).not.toEqual(new Decimal(0));
  });

  it('37. immutable returned candle', async () => {
    const { state, clock, scheduler, finalized } = createTestState({ finalizationGraceMs: 1000 });

    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_0, providerEventTimeMs: MINUTE_0 + 30000 }),
      defaultMeta
    );
    clock.setTime(MINUTE_1 + 1050);
    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: MINUTE_1, providerEventTimeMs: MINUTE_1 + 1000 }),
      { sequence: 2, receivedAtMs: MINUTE_1 + 1000, generationId: 1 }
    );
    scheduler.advanceTime(1001);
    await Promise.resolve();

    expect(finalized.length).toBe(1);
    const candle = finalized[0]!;

    // CanonicalCandle1m is frozen
    expect(Object.isFrozen(candle)).toBe(true);
    expect(() => {
      // @ts-expect-error mutating frozen object
      candle.close = new Decimal('99999');
    }).toThrow();
  });
});
