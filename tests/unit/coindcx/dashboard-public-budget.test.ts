import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBotReadBudget } from '../../../scripts/run-coindcx-bot';
import { startPracticalReadRuntime } from '../../../scripts/practical-read-runtime';
import { RateLimitCoordinator } from '../../../src/integration/coindcx/rate-limit/runtime/coordinator';

afterEach(() => { vi.restoreAllMocks(); });

describe('Dashboard public candle pacing', () => {
  it('keeps account policy at 1/sec, 20/min and assigns public candles a separate 8/sec, 480/min coordinator', async () => {
    const start = vi.spyOn(RateLimitCoordinator, 'start');
    const runtime = await startPracticalReadRuntime();
    try {
      expect(start).toHaveBeenCalledTimes(2);
      const [account, market] = start.mock.calls.map(([c]) => c);
      expect(account!.limiter.windows).toEqual([{ windowMs: 1000, maxStarts: 1 }, { windowMs: 60000, maxStarts: 20 }]);
      expect(market!.limiter.windows).toEqual([{ windowMs: 1000, maxStarts: 8 }, { windowMs: 60000, maxStarts: 480 }]);
      expect(market!.limiter.concurrency).toBe(1);
      expect(market!.stateDirectory).not.toBe(account!.stateDirectory);
      expect(market!.pipePath).not.toBe(account!.pipePath);
      expect(runtime.stats()).toMatchObject({ connected: true, pacing: { startsPerSecond: 1, startsPerMinute: 20, publicMarketData: { startsPerSecond: 8, startsPerMinute: 480 } } });
    } finally { await runtime.close(); }
  });
  it('charges each public request and retains coordinator throttle blocking without an unpaced fallback', async () => {
    const runtime = await startBotReadBudget('PUBLIC_MARKET_DATA');
    try {
      const binding = runtime.publicReadBudget;
      for (let i = 0; i < 3; i++) {
        const result = await binding.budget.acquire({ scope: 'PUBLIC', lifetimeMs: 1000 });
        expect(result.kind).toBe('GRANTED'); if (result.kind !== 'GRANTED') throw new Error('PERMIT_EXPECTED');
        const create = vi.fn(() => i);
        expect(result.permit.start(create)).toEqual({ kind: 'STARTED', value: i });
        expect(result.permit.start(create).kind).toBe('NOT_STARTED'); expect(create).toHaveBeenCalledOnce();
        if (i === 2) result.permit.throttled({ retryAfter: '60' });
        result.permit.complete();
      }
      await vi.waitFor(() => expect(runtime.readStats().blockedScopes).toContain('PUBLIC'));
      expect(runtime.readStats().connected).toBe(true);
    } finally { await runtime.close(); }
  }, 10000);
});
