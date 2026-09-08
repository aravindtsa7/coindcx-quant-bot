import { describe, expect, it } from 'vitest';
import { CoinDcxFuturesCandleRestReader } from '../../../src/market-data/rest-candle-reader';
import { FakeClock } from './test-helpers';
import { P, T, M } from './audit-a1-helpers';

function read(volume: string, quote = 'null', time = String(T)) {
  const raw = `{"s":"ok","data":[{"time":${time},"open":100,"high":120,"low":90,"close":100,"volume":${volume},"quote_volume":${quote}}]}`;
  return new CoinDcxFuturesCandleRestReader({ clock: new FakeClock(T + M), httpTransport: async () => raw }).fetchClosedCandles({ pair: P, fromMs: T, toMs: T });
}

describe('Audit A1 lossless REST evidence', () => {
  it.each([
    ['12345678.123456789', '12345678.123456789'],
    ['999999999999999999', '999999999999999999'],
    ['0.000000000000000001', '0.000000000000000001'],
    ['1e-18', '0.000000000000000001'],
  ])('preserves numeric token %s and equivalent string exactly', async (token, expected) => {
    const numeric = await read(token); const string = await read(JSON.stringify(token));
    expect(numeric[0]?.volume.toFixed()).toBe(expected);
    expect(string[0]?.volume.toFixed()).toBe(expected);
  });
  it('preserves optional quote volume and leaves null unavailable', async () => {
    expect((await read('1', '12345678.123456789'))[0]?.quoteVolume?.toFixed()).toBe('12345678.123456789');
    expect((await read('1'))[0]?.quoteVolume).toBeNull();
  });
  it.each(['1000000000000000000', '1e-19', '1e100000000', 'null', '{}', '"not-a-number"', 'NaN'])('rejects unsupported or inexact financial token %s', async token => {
    await expect(read(token)).rejects.toThrow();
  });
  it.each([String(T + 0.5), '9007199254740993', '"1700000000.5"'])('rejects unsafe/noninteger timestamp token %s', async time => {
    await expect(read('1', 'null', time)).rejects.toThrow();
  });
  it('seconds and milliseconds have exact timestamp parity', async () => {
    expect((await read('1', 'null', String(T / 1000)))[0]?.openTimeMs).toBe(T);
    expect((await read('1'))[0]?.openTimeMs).toBe(T);
  });
});
