import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CanonicalMarketDataEngine } from '../../../src/market-data/canonical-engine';
import { PairCanonicalStateMachine } from '../../../src/market-data/pair-state';
import { CoinDcxFuturesCandleRestReader } from '../../../src/market-data/rest-candle-reader';
import {
  createTestCandlePayload,
  createTestEnvelope,
  FakeClock,
  InMemoryCandleRepository,
  ManualScheduler,
  MockFuturesCandleRestReader,
} from './test-helpers';

describe('Phase 5 — Health States, Lifecycle Cleanup & Architectural Boundaries', () => {
  const PAIR_BTC = 'B-BTC_USDT';
  const MINUTE_0 = 1700000040000;
  const MINUTE_1 = 1700000100000;

  it('38. health HEALTHY', async () => {
    const clock = new FakeClock(MINUTE_0 + 30000);
    const repo = new InMemoryCandleRepository();
    const engine = new CanonicalMarketDataEngine({ repository: repo, clock });

    await engine.initializePair(PAIR_BTC);
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0 }))
    );

    const health = engine.getPairHealth(PAIR_BTC)!;
    expect(health.state).toBe('HEALTHY');
    expect(health.workingOpenTimeMs).toBe(MINUTE_0);
    engine.stop();
  });

  it('39. health STALE', async () => {
    const clock = new FakeClock(MINUTE_0 + 30000);
    const scheduler = new ManualScheduler();
    const repo = new InMemoryCandleRepository();

    const engine = new CanonicalMarketDataEngine({
      repository: repo,
      clock,
      scheduler,
    });
    await engine.initializePair(PAIR_BTC);

    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0 }))
    );
    expect(engine.getPairHealth(PAIR_BTC)?.state).toBe('HEALTHY');

    // Inactivity exceeds staleThresholdMs (default 120_000ms)
    clock.advance(130000);
    scheduler.advanceTime(130000);

    expect(engine.getPairHealth(PAIR_BTC)?.state).toBe('STALE');
    engine.stop();
  });

  it('40. health RECOVERING', async () => {
    const clock = new FakeClock(MINUTE_0 + 30000);
    const repo = new InMemoryCandleRepository();
    const restReader = new MockFuturesCandleRestReader();

    const engine = new CanonicalMarketDataEngine({
      repository: repo,
      restReader: restReader as unknown as CoinDcxFuturesCandleRestReader,
      clock,
    });
    await engine.initializePair(PAIR_BTC);

    // Stream disconnect recovery event transitions to RECOVERING
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_STREAM_RECOVERY_REQUIRED', {
        previousGeneration: 1,
        newGeneration: 2,
        reason: 'transport disconnect',
      })
    );

    expect(engine.getPairHealth(PAIR_BTC)?.state).toBe('RECOVERING');
    engine.stop();
  });

  it('41. health INVALID', async () => {
    const clock = new FakeClock(MINUTE_0 + 30000);
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

    // Malformed packet with non-integer openTimeMs
    await state.handleCandleUpdate(
      createTestCandlePayload({ openTimeMs: 1700000040000.5 as unknown as number }),
      { sequence: 1, receivedAtMs: MINUTE_0 + 30000, generationId: 1 }
    );

    expect(state.state).toBe('INVALID');
    state.stop();
  });

  it('42. stop clears timers/listeners', async () => {
    const clock = new FakeClock(MINUTE_0 + 35000);
    const scheduler = new ManualScheduler();
    const repo = new InMemoryCandleRepository();

    const engine = new CanonicalMarketDataEngine({
      repository: repo,
      clock,
      scheduler,
      finalizationGraceMs: 1000,
    });
    await engine.initializePair(PAIR_BTC);

    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_0 }))
    );

    clock.setTime(MINUTE_1 + 35000);
    await engine.handleStreamEnvelope(
      createTestEnvelope('PUBLIC_CANDLE_UPDATE', createTestCandlePayload({ openTimeMs: MINUTE_1 }))
    );

    // There should be active timers (grace timer, stale check timer)
    expect(scheduler.activeTimerCount).toBeGreaterThan(0);

    // Stop engine
    engine.stop();

    // All active timers are deterministically cleared
    expect(scheduler.activeTimerCount).toBe(0);
  });

  it('43. stop idempotent', () => {
    const clock = new FakeClock(MINUTE_0);
    const scheduler = new ManualScheduler();
    const repo = new InMemoryCandleRepository();

    const engine = new CanonicalMarketDataEngine({ repository: repo, clock, scheduler });
    expect(() => {
      engine.stop();
      engine.stop();
      engine.stop();
    }).not.toThrow();
  });

  it('44. no Phase 6 aggregation', () => {
    // Check that Phase 5 market-data code does not contain multi-minute candle synthesis (5m, 15m, 1h)
    const marketDataDir = path.resolve(__dirname, '../../../src/market-data');
    const files = fs.readdirSync(marketDataDir, { recursive: true }) as string[];

    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const content = fs.readFileSync(path.join(marketDataDir, file), 'utf-8');
      expect(content).not.toMatch(/build5mCandle/i);
      expect(content).not.toMatch(/aggregateHigherTimeframe/i);
      expect(content).not.toMatch(/resample/i);
    }
  });

  it('45. no strategy/risk/execution dependency', () => {
    // Check that Phase 5 market-data code has zero imports from execution, strategy, or risk modules
    const marketDataDir = path.resolve(__dirname, '../../../src/market-data');
    const files = fs.readdirSync(marketDataDir, { recursive: true }) as string[];

    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const content = fs.readFileSync(path.join(marketDataDir, file), 'utf-8');
      expect(content).not.toMatch(/order-placement/i);
      expect(content).not.toMatch(/execution/i);
      expect(content).not.toMatch(/risk-engine/i);
      expect(content).not.toMatch(/strategy/i);
      expect(content).not.toMatch(/private-auth/i);
    }
  });

  it('46. generic future coin pair works without core rewrite', async () => {
    const clock = new FakeClock(MINUTE_0 + 35000);
    const scheduler = new ManualScheduler();
    const repo = new InMemoryCandleRepository();

    const engine = new CanonicalMarketDataEngine({
      repository: repo,
      clock,
      scheduler,
      finalizationGraceMs: 500,
    });

    // Arbitrary unhardcoded coins
    const futureCoins = ['B-SOL_USDT', 'B-AVAX_USDT', 'B-DOGE_USDT'];

    for (const coin of futureCoins) {
      await engine.initializePair(coin);
      expect(engine.getPairHealth(coin)?.state).toBe('HEALTHY');

      clock.setTime(MINUTE_0 + 35000);
      await engine.handleStreamEnvelope(
        createTestEnvelope(
          'PUBLIC_CANDLE_UPDATE',
          createTestCandlePayload({ pair: coin, openTimeMs: MINUTE_0 }),
          { pair: coin }
        )
      );

      clock.setTime(MINUTE_1 + 35000);
      await engine.handleStreamEnvelope(
        createTestEnvelope(
          'PUBLIC_CANDLE_UPDATE',
          createTestCandlePayload({ pair: coin, openTimeMs: MINUTE_1 }),
          { pair: coin }
        )
      );
    }

    scheduler.advanceTime(600);
    // The engine-level cross-run persistence coordinator (SOL-P5-001) serializes the physical write
    // behind a real await even for a pair with no prior activity, so a microtask flush is required here
    // (matching the pattern used by every other test that checks repository state after a grace timer).
    await new Promise((r) => setTimeout(r, 10));

    for (const coin of futureCoins) {
      const persisted = await repo.getCandle(coin, MINUTE_0);
      expect(persisted).not.toBeNull();
      expect(persisted?.pair).toBe(coin);
      expect(engine.getPairHealth(coin)?.state).toBe('HEALTHY');
    }

    engine.stop();
  });
});
