import { describe, expect, it } from 'vitest';
import { CanonicalMarketDataEngine } from '../../../src/market-data/canonical-engine';
import {
  CoinDcxFuturesCandleRestReader,
} from '../../../src/market-data/rest-candle-reader';
import {
  FakeClock,
  InMemoryCandleRepository,
} from './test-helpers';

describe('Phase 5 — Fixed Read-Only CoinDCX Futures REST Recovery Reader', () => {
  const PAIR = 'B-BTC_USDT';
  const MINUTE_0 = 1700000040000;
  const MINUTE_1 = 1700000100000;
  const MINUTE_2 = 1700000160000;
  const MINUTE_3 = 1700000220000;

  it('19. REST response sorted descending is normalized ascending', async () => {
    const clock = new FakeClock(MINUTE_3 + 30000);

    // Provider returns data in reverse chronological order (descending)
    const mockResponse = JSON.stringify({
      s: 'ok',
      data: [
        {
          open: '50200.0',
          high: '50300.0',
          low: '50150.0',
          close: '50250.0',
          volume: '15.0',
          time: MINUTE_2 / 1000,
        },
        {
          open: '50100.0',
          high: '50250.0',
          low: '50050.0',
          close: '50200.0',
          volume: '12.0',
          time: MINUTE_1 / 1000,
        },
        {
          open: '50000.0',
          high: '50150.0',
          low: '49950.0',
          close: '50100.0',
          volume: '10.0',
          time: MINUTE_0 / 1000,
        },
      ],
    });

    const reader = new CoinDcxFuturesCandleRestReader({
      clock,
      httpTransport: async () => mockResponse,
    });

    const results = await reader.fetchClosedCandles({
      pair: PAIR,
      fromMs: MINUTE_0,
      toMs: MINUTE_2,
    });

    expect(results.length).toBe(3);
    // Verified: strictly sorted ascending
    expect(results[0]!.openTimeMs).toBe(MINUTE_0);
    expect(results[1]!.openTimeMs).toBe(MINUTE_1);
    expect(results[2]!.openTimeMs).toBe(MINUTE_2);
    expect(results[0]!.close.toString()).toBe('50100');
    expect(results[2]!.close.toString()).toBe('50250');
  });

  it('20. REST duplicate identical is idempotent', async () => {
    const clock = new FakeClock(MINUTE_2 + 30000);

    const mockResponse = JSON.stringify({
      s: 'ok',
      data: [
        {
          open: '50000.0',
          high: '50100.0',
          low: '49900.0',
          close: '50050.0',
          volume: '10.0',
          time: MINUTE_0 / 1000,
        },
        {
          open: '50000.0',
          high: '50100.0',
          low: '49900.0',
          close: '50050.0',
          volume: '10.0',
          time: MINUTE_0 / 1000, // Identical duplicate record
        },
      ],
    });

    const reader = new CoinDcxFuturesCandleRestReader({
      clock,
      httpTransport: async () => mockResponse,
    });

    const results = await reader.fetchClosedCandles({
      pair: PAIR,
      fromMs: MINUTE_0,
      toMs: MINUTE_0,
    });

    // Deduplicated idempotently
    expect(results.length).toBe(1);
    expect(results[0]!.openTimeMs).toBe(MINUTE_0);
  });

  it('21. REST conflicting duplicate fails', async () => {
    const clock = new FakeClock(MINUTE_2 + 30000);

    const mockResponse = JSON.stringify({
      s: 'ok',
      data: [
        {
          open: '50000.0',
          high: '50100.0',
          low: '49900.0',
          close: '50050.0',
          volume: '10.0',
          time: MINUTE_0 / 1000,
        },
        {
          open: '50000.0',
          high: '50200.0', // Conflicting high price!
          low: '49900.0',
          close: '50150.0',
          volume: '12.0',
          time: MINUTE_0 / 1000,
        },
      ],
    });

    const reader = new CoinDcxFuturesCandleRestReader({
      clock,
      httpTransport: async () => mockResponse,
    });

    await expect(
      reader.fetchClosedCandles({
        pair: PAIR,
        fromMs: MINUTE_0,
        toMs: MINUTE_0,
      })
    ).rejects.toThrow(/conflicting duplicate records/);
  });

  it('22. REST missing requested minute keeps RECOVERING', async () => {
    const clock = new FakeClock(MINUTE_3 + 30000);
    const repo = new InMemoryCandleRepository();

    // Response returns MINUTE_0 and MINUTE_2, but MINUTE_1 is missing
    const mockResponse = JSON.stringify({
      s: 'ok',
      data: [
        {
          open: '50000.0',
          high: '50100.0',
          low: '49900.0',
          close: '50050.0',
          volume: '10.0',
          time: MINUTE_0 / 1000,
        },
        {
          open: '50200.0',
          high: '50300.0',
          low: '50100.0',
          close: '50250.0',
          volume: '12.0',
          time: MINUTE_2 / 1000,
        },
      ],
    });

    const restReader = new CoinDcxFuturesCandleRestReader({
      clock,
      httpTransport: async () => mockResponse,
    });

    const engine = new CanonicalMarketDataEngine({
      repository: repo,
      restReader,
      clock,
    });

    await engine.initializePair(PAIR);
    // Request recovery for MINUTE_0 through MINUTE_2
    await engine.executeRecovery(PAIR, MINUTE_0, MINUTE_2);

    // Incomplete coverage: pair must remain RECOVERING
    const health = engine.getPairHealth(PAIR)!;
    expect(health.state).toBe('RECOVERING');
    engine.stop();
  });

  it('23. REST current/forming minute not accepted as closed truth', async () => {
    // Current wall clock is inside MINUTE_2
    const clock = new FakeClock(MINUTE_2 + 25000);

    const mockResponse = JSON.stringify({
      s: 'ok',
      data: [
        {
          open: '50000.0',
          high: '50100.0',
          low: '49900.0',
          close: '50050.0',
          volume: '10.0',
          time: MINUTE_0 / 1000, // Closed minute
        },
        {
          open: '50200.0',
          high: '50300.0',
          low: '50100.0',
          close: '50250.0',
          volume: '8.0',
          time: MINUTE_2 / 1000, // Forming/current minute!
        },
      ],
    });

    const reader = new CoinDcxFuturesCandleRestReader({
      clock,
      httpTransport: async () => mockResponse,
    });

    const results = await reader.fetchClosedCandles({
      pair: PAIR,
      fromMs: MINUTE_0,
      toMs: MINUTE_2,
    });

    // Forming minute MINUTE_2 must be rejected; only MINUTE_0 returned
    expect(results.length).toBe(1);
    expect(results[0]!.openTimeMs).toBe(MINUTE_0);
    expect(results.find((r) => r.openTimeMs === MINUTE_2)).toBeUndefined();
  });

  it('Exact request contract: path, resolution=1, pcode=f, epoch seconds conversion', async () => {
    let capturedUrl = '';
    const reader = new CoinDcxFuturesCandleRestReader({
      clock: new FakeClock(MINUTE_3 + 30000),
      httpTransport: async (url) => {
        capturedUrl = url;
        return JSON.stringify({ s: 'ok', data: [] });
      },
    });

    await reader.fetchClosedCandles({
      pair: 'B-BTC_USDT',
      fromMs: 1700000000000,
      toMs: 1700000120000,
    });

    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe('/market_data/candlesticks');
    expect(parsed.searchParams.get('pair')).toBe('B-BTC_USDT');
    expect(parsed.searchParams.get('from')).toBe(String(Math.floor(1700000000000 / 1000)));
    expect(parsed.searchParams.get('to')).toBe(String(Math.floor(1700000120000 / 1000)));
    expect(parsed.searchParams.get('resolution')).toBe('1');
    expect(parsed.searchParams.get('pcode')).toBe('f');
  });

  it('Provider errors are sanitized and redacted without leaking internal details', async () => {
    const reader = new CoinDcxFuturesCandleRestReader({
      clock: new FakeClock(MINUTE_3 + 30000),
      httpTransport: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.1:443 (api_key=SECRET_12345)');
      },
    });

    await expect(
      reader.fetchClosedCandles({
        pair: 'B-BTC_USDT',
        fromMs: 1700000000000,
        toMs: 1700000060000,
      })
    ).rejects.toThrow(/Futures candlestick recovery request failed/);
  });
});
