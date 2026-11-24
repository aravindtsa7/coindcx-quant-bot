import { describe, expect, it } from 'vitest';
import { sma, ema, rma, trueRange, atr, rsi, adx, bollingerBands, bandwidthPercentile, donchian, rvol, candleBodyRatio,
  utcDayVwap, rolling24hVwap, aggregateClosed4h, macroTrendGates, costGate, type GateCandle } from '../../../src/integration/coindcx/live/strategy-gates';

const start = Date.parse('2026-01-01T00:00:00Z'), minute = 60_000;
function candle(i: number, price = 100 + i, duration = minute, volume = 1): GateCandle {
  return { openTimeMs: start + i * duration, closeTimeMs: start + (i + 1) * duration, open: price, high: price + 1, low: price - 1, close: price, volume };
}
describe('Causal institutional indicator foundation', () => {
  it('SMA-seeds EMA and Wilder RMA, and retains unavailable contiguous warmup', () => {
    expect(sma([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]);
    expect(ema([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]);
    expect(rma([1, 2, 3, 4], 3)[3]).toBeCloseTo(8 / 3);
    expect(ema([null, 1, 2, 3, null, 8, 9, 10], 3)).toEqual([null, null, null, 2, null, null, null, 9]);
    expect(() => ema([1], 0)).toThrow('INVALID_INDICATOR_PERIOD');
  });
  it('requires a prior close for TR and the full Wilder ATR/RSI/ADX warmups', () => {
    const rows = Array.from({ length: 40 }, (_, i) => candle(i));
    expect(trueRange(rows)[0]).toBeNull(); expect(atr(rows).slice(0, 14).every(v => v === null)).toBe(true);
    expect(atr(rows)[14]).toBe(2); expect(rsi(rows.map(c => c.close))[14]).toBe(100);
    expect(rsi(Array(20).fill(100))[14]).toBe(50);
    const strength = adx(rows); expect(strength.adx.slice(0, 27).every(v => v === null)).toBe(true);
    expect(strength.adx[27]).toBe(100); expect(strength.plusDi[14]).toBe(50); expect(strength.minusDi[14]).toBe(0);
  });
  it('uses population BB deviation and a linear-interpolated rolling percentile', () => {
    const bands = bollingerBands([1, 2, 3, 4], 3, 2);
    expect(bands.middle).toEqual([null, null, 2, 3]);
    expect(bands.upper[2]).toBeCloseTo(2 + 2 * Math.sqrt(2 / 3), 12);
    expect(bands.lower[2]).toBeCloseTo(2 - 2 * Math.sqrt(2 / 3), 12);
    expect(bandwidthPercentile([1, 2, 3, 4], 3, .6)).toEqual([null, null, 2.2, 3.2]);
  });
  it('excludes the current candle from Donchian and includes it in RVOL', () => {
    const rows = [candle(0, 10, minute, 1), candle(1, 20, minute, 2), candle(2, 100, minute, 3)];
    expect(donchian(rows, 2)).toEqual({ upper: [null, null, 21], lower: [null, null, 9] });
    expect(rvol(rows, 2)).toEqual([null, 4 / 3, 1.2]);
    expect(rvol(rows.map(c => ({ ...c, volume: 0 })), 2)).toEqual([null, null, null]);
    expect(candleBodyRatio({ ...rows[0]!, open: 10, close: 11, high: 12, low: 8 })).toBe(.25);
    expect(candleBodyRatio({ ...rows[0]!, high: 10, low: 10, close: 10 })).toBe(0);
  });
  it('resets HLC3 VWAP at UTC midnight and uses an actual full 24-hour rolling window', () => {
    const rows = Array.from({ length: 26 }, (_, i) => candle(i, 100 + i, 60 * minute, i === 1 ? 3 : 1));
    const daily = utcDayVwap(rows), rolling = rolling24hVwap(rows);
    expect(daily[1]).toBe(100.75); expect(daily[24]).toBe(124);
    expect(rolling.slice(0, 23).every(v => v === null)).toBe(true);
    expect(rolling[23]).toBeCloseTo((Array.from({ length: 24 }, (_, i) => 100 + i).reduce((a, b) => a + b, 0) + 202) / 26);
    expect(rolling[25]).toBe(113.5);
    expect(rolling24hVwap(rows.filter((_, i) => i !== 10))[22]).toBeNull();
    expect(utcDayVwap(rows.map(c => ({ ...c, volume: 0 }))).every(v => v === null)).toBe(true);
  });
  it('keeps every indicator prefix unchanged after future price/volume mutations', () => {
    const rows = Array.from({ length: 100 }, (_, i) => candle(i, 100 + Math.sin(i) * 10, minute, 1 + i % 4));
    const compute = (r: GateCandle[]) => ({ ema: ema(r.map(c => c.close), 10), atr: atr(r), rsi: rsi(r.map(c => c.close)),
      adx: adx(r).adx, bb: bollingerBands(r.map(c => c.close)).upper, dc: donchian(r).upper, volume: rvol(r), vwap: utcDayVwap(r) });
    const full = compute(rows), prefix = compute(rows.slice(0, 65));
    for (const key of Object.keys(full) as (keyof typeof full)[]) expect(full[key].slice(0, 65)).toEqual(prefix[key]);
  });
});
describe('Closed 4h macro and fractional cost gates', () => {
  it('joins 45m signals only to AVAILABLE closed 4h candles, including exact boundary equality', () => {
    const source = Array.from({ length: 201 * 240 }, (_, i) => candle(i, 100 + i / 1000));
    const boundary = start + 200 * 240 * minute;
    const signal = (close: number): GateCandle => ({ ...candle(0), openTimeMs: close - 45 * minute, closeTimeMs: close });
    const strategies = [signal(boundary - 30 * minute), signal(boundary + 15 * minute)];
    const result = macroTrendGates(strategies, source);
    expect(result[0]!.sourceCloseTimeMs).toBe(boundary - 240 * minute); expect(result[0]!.long200).toBe(false);
    expect(result[1]!.sourceCloseTimeMs).toBe(boundary); expect(result[1]).toMatchObject({ long200: true, short200: false, long100: true, short100: false });
    expect(macroTrendGates([signal(boundary)], source)[0]!.long200).toBe(true);
    const changed = source.map(c => c.openTimeMs >= boundary ? { ...c, open: 1, high: 2, low: .5, close: 1, volume: 999 } : c);
    expect(macroTrendGates(strategies, changed)).toEqual(result);
    expect(macroTrendGates(strategies, source.filter(c => c.closeTimeMs <= boundary))).toEqual(result);
    expect(() => aggregateClosed4h(strategies, 45)).toThrow('NON_DIVISIBLE_MACRO_SOURCE');
  });
  it('drops incomplete macro buckets and reverses G100/G200 in a falling regime', () => {
    const source = Array.from({ length: 200 * 240 }, (_, i) => candle(i, 1000 - i / 1000));
    const strategy = [{ ...candle(0), closeTimeMs: source.at(-1)!.closeTimeMs }];
    expect(macroTrendGates(strategy, source)[0]).toMatchObject({ short100: true, short200: true, long100: false, long200: false });
    expect(aggregateClosed4h(source.slice(1))).toHaveLength(199);
  });
  it('disables CG at nonpositive multipliers and blocks warmup or insufficient ATR/cost ratios', () => {
    expect(costGate(null, 100, 0, .00158)).toBe(true); expect(costGate(null, 100, 2, .00158)).toBe(false);
    expect(costGate(.2, 100, 2, .00158)).toBe(false); expect(costGate(.316, 100, 2, .00158)).toBe(true);
    expect(() => costGate(1, 100, 2, -.01)).toThrow('INVALID_COST_GATE');
  });
});
