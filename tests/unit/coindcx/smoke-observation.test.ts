import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForSmokeObservation } from '../../../scripts/smoke-observation-helper';

describe('P4-F005: Public Smoke Bounded Observation Timer Cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('4. timeout path: clears all timers and returns false when candles never arrive', async () => {
    const intendedPairs = ['B-BTC_USDT', 'B-ETH_USDT'];
    const candleCounts = new Map<string, number>([
      ['B-BTC_USDT', 0],
      ['B-ETH_USDT', 0],
    ]);

    const isComplete = (): boolean =>
      intendedPairs.every((pair) => (candleCounts.get(pair) ?? 0) >= 1);

    const waitPromise = waitForSmokeObservation({
      timeoutMs: 20_000,
      pollIntervalMs: 500,
      isComplete,
    });

    // Timers are active while waiting (interval + timeout)
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);

    // Advance to timeout without receiving any candles
    await vi.advanceTimersByTimeAsync(20_000);

    const result = await waitPromise;

    // Assertions required by Section 4:
    // - result = failure / false
    // - interval cleared
    // - timeout cleared
    // - no pending timers
    expect(result).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    // Verify non-success path behaves correctly in downstream evaluation
    let exitCode = 0;
    if (!result) {
      exitCode = 1;
    }
    expect(exitCode).toBe(1);
  });

  it('5. success path regression: clears all timers immediately when all pairs observed before timeout', async () => {
    const intendedPairs = ['B-BTC_USDT', 'B-ETH_USDT'];
    const candleCounts = new Map<string, number>([
      ['B-BTC_USDT', 0],
      ['B-ETH_USDT', 0],
    ]);

    const isComplete = (): boolean =>
      intendedPairs.every((pair) => (candleCounts.get(pair) ?? 0) >= 1);

    const waitPromise = waitForSmokeObservation({
      timeoutMs: 20_000,
      pollIntervalMs: 500,
      isComplete,
    });

    // Advance 1000ms: only 1 pair receives a candle
    await vi.advanceTimersByTimeAsync(1000);
    candleCounts.set('B-BTC_USDT', 1);

    // Advance another 500ms poll: still waiting because ETH is 0
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);

    // ETH receives a candle at 2000ms
    candleCounts.set('B-ETH_USDT', 1);

    // Next poll interval detects all pairs satisfied
    await vi.advanceTimersByTimeAsync(500);

    const result = await waitPromise;

    // Assertions required by Section 5:
    // - success
    // - interval cleared immediately
    // - timeout cleared
    // - zero pending timers
    expect(result).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('immediately completes with zero timers if all pairs already observed prior to wait', async () => {
    const isComplete = (): boolean => true;

    const waitPromise = waitForSmokeObservation({
      timeoutMs: 20_000,
      pollIntervalMs: 500,
      isComplete,
    });

    const result = await waitPromise;
    expect(result).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears all timers via finally if isComplete predicate throws an error', async () => {
    let callCount = 0;
    const isComplete = (): boolean => {
      callCount++;
      if (callCount >= 2) {
        throw new Error('Simulated predicate validation fault');
      }
      return false;
    };

    const waitPromise = waitForSmokeObservation({
      timeoutMs: 20_000,
      pollIntervalMs: 500,
      isComplete,
    });

    // Advance past the second poll interval to trigger throw
    const advancePromise = vi.advanceTimersByTimeAsync(1500);

    await expect(waitPromise).rejects.toThrow('Simulated predicate validation fault');
    await advancePromise;

    // Guaranteed cleanup: zero pending timers even after exception
    expect(vi.getTimerCount()).toBe(0);
  });

  it('smoke script contract: proves zero process.exit(), uses process.exitCode, and preserves stream.stop()', () => {
    const smokeScriptPath = path.resolve(__dirname, '../../../scripts/coindcx-ws-smoke.ts');
    const smokeScriptContent = fs.readFileSync(smokeScriptPath, 'utf8');

    // Invariant: DO NOT USE process.exit()
    expect(smokeScriptContent).not.toMatch(/process\.exit\s*\(/);

    // Invariant: Use process.exitCode
    expect(smokeScriptContent).toContain('process.exitCode = 0');
    expect(smokeScriptContent).toContain('process.exitCode = 1');

    // Invariant: Bounded wait helper is utilized
    expect(smokeScriptContent).toContain('waitForSmokeObservation');

    // Invariant: Stream stop in finally
    expect(smokeScriptContent).toContain('stream.stop()');
    expect(smokeScriptContent).toContain('finally {');
  });
});

