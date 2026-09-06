import { describe, expect, it } from 'vitest';
import {
  AtrKernel,
  BollingerKernel,
  computeAtr,
  computeBollinger,
  computeDmiAdx,
  computeDonchian,
  computeEma,
  computeMacd,
  computeRma,
  computeRsi,
  computeSma,
  computeSuperTrend,
  computeTrueRange,
  computeUtcDayVwap,
  computeVolumeRatio,
  computeVolumeSma,
  DmiAdxKernel,
  DonchianKernel,
  EmaKernel,
  IndicatorCalcDecimal,
  MacdKernel,
  RmaKernel,
  RsiKernel,
  SmaKernel,
  SuperTrendKernel,
  TrueRangeKernel,
  UtcDayVwapKernel,
  VolumeRatioKernel,
  VolumeSmaKernel,
} from '../../../src/indicators';
import { BASE_TIME, candle, closes, strings } from './helpers';

const scalar = (period: number) => ({ pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, period });

describe('moving averages and true range', () => {
  it('computes rolling SMA with exact warmup and N=1', () => {
    expect(strings(computeSma(closes(['1', '2', '3', '4']), scalar(3)))).toEqual([null, null, '2', '3']);
    expect(strings(computeSma(closes(['1.25', '2.5']), scalar(1)))).toEqual(['1.25', '2.5']);
  });

  it('computes EMA seed and recurrence with N=1', () => {
    expect(strings(computeEma(closes(['1', '2', '3', '4', '5']), scalar(3)))).toEqual([null, null, '2', '3', '4']);
    expect(strings(computeEma(closes(['1', '5']), scalar(1)))).toEqual(['1', '5']);
  });

  it('computes Wilder RMA seed and recurrence with N=1', () => {
    expect(strings(computeRma(closes(['1', '2', '3', '4']), scalar(3)))).toEqual([null, null, '2', '2.666666666666666667']);
    expect(strings(computeRma(closes(['1', '5']), scalar(1)))).toEqual(['1', '5']);
  });

  it('extracts every supported scalar price source exactly', () => {
    const bar = candle(0, '12', { open: '10', high: '14', low: '8' });
    const expected = { CLOSE: '12', OPEN: '10', HIGH: '14', LOW: '8', HL2: '11', HLC3: '11.333333333333333333', OHLC4: '11' } as const;
    for (const [priceSource, value] of Object.entries(expected)) {
      const result = new SmaKernel({ ...scalar(1), priceSource: priceSource as keyof typeof expected }).update(bar);
      expect(result.value?.value).toBe(value);
    }
  });

  it('computes TR0, gap-up, and gap-down true ranges', () => {
    const bars = [
      candle(0, '9', { open: '9', high: '10', low: '8' }),
      candle(1, '13', { open: '12', high: '14', low: '12' }),
      candle(2, '7', { open: '8', high: '8', low: '6' }),
    ];
    expect(strings(computeTrueRange(bars, { pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME }))).toEqual(['2', '5', '7']);
  });

  it('computes ATR seed, recurrence, and N=1', () => {
    const bars = [
      candle(0, '9', { open: '9', high: '10', low: '8' }),
      candle(1, '11', { open: '10', high: '12', low: '9' }),
      candle(2, '12', { open: '11', high: '13', low: '10' }),
      candle(3, '10', { open: '11', high: '14', low: '8' }),
    ];
    expect(strings(computeAtr(bars, scalar(3)))).toEqual([null, null, '2.666666666666666667', '3.777777777777777778']);
    expect(strings(computeAtr(bars.slice(0, 2), scalar(1)))).toEqual(['2', '3']);
  });
});

describe('oscillators and bands', () => {
  it.each([
    [['1', '2', '3', '4'], '100'],
    [['4', '3', '2', '1'], '0'],
    [['2', '2', '2', '2'], '50'],
  ])('implements exact RSI zero behavior', (prices, expected) => {
    expect(computeRsi(closes(prices), scalar(3)).at(-1)?.value?.value).toBe(expected);
  });

  it('computes mixed RSI independently and honors N+1 warmup and N=1', () => {
    expect(strings(computeRsi(closes(['1', '2', '1', '3', '2']), scalar(3)))).toEqual([null, null, null, '75', '54.545454545454545455']);
    expect(strings(computeRsi(closes(['1', '2']), scalar(1)))).toEqual([null, '100']);
  });

  it('computes MACD slow/signal warmups, seed, and a negative histogram', () => {
    const config = { pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 };
    const values = computeMacd(closes(['1', '2', '3', '4', '3']), config).map((point) => point.value && ({
      macd: point.value.macd.value,
      signal: point.value.signal?.value ?? null,
      histogram: point.value.histogram?.value ?? null,
    }));
    expect(values).toEqual([null, null,
      { macd: '0.5', signal: null, histogram: null },
      { macd: '0.5', signal: '0.5', histogram: '0' },
      { macd: '0.166666666666666667', signal: '0.277777777777777778', histogram: '-0.111111111111111111' },
    ]);
  });

  it('rejects every invalid MACD period relationship independently', () => {
    const base = { pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 };
    expect(() => new MacdKernel({ ...base, fastPeriod: 3 })).toThrowError(expect.objectContaining({ code: 'INVALID_INDICATOR_PARAMETER' }));
    expect(() => new MacdKernel({ ...base, fastPeriod: 100_001 })).toThrowError(expect.objectContaining({ code: 'INVALID_INDICATOR_PARAMETER' }));
    expect(() => new MacdKernel({ ...base, slowPeriod: 100_001 })).toThrowError(expect.objectContaining({ code: 'INVALID_INDICATOR_PARAMETER' }));
    expect(() => new MacdKernel({ ...base, signalPeriod: 100_001 })).toThrowError(expect.objectContaining({ code: 'INVALID_INDICATOR_PARAMETER' }));
  });

  it('computes constant and population-variance Bollinger fixtures', () => {
    const constant = computeBollinger(closes(['2', '2']), { ...scalar(2), multiplier: '2' }).at(-1)?.value;
    expect(constant && Object.fromEntries(Object.entries(constant).map(([key, value]) => [key, value.value]))).toEqual({ middle: '2', upper: '2', lower: '2', stdDev: '0' });
    const population = computeBollinger(closes(['1', '3']), { ...scalar(2), multiplier: '1.5' }).at(-1)?.value;
    expect(population && Object.fromEntries(Object.entries(population).map(([key, value]) => [key, value.value]))).toEqual({ middle: '2', upper: '3.5', lower: '0.5', stdDev: '1' });
  });

  it('uses Decimal sqrt for a non-perfect variance', () => {
    const value = computeBollinger(closes(['1', '2', '4']), { ...scalar(3), multiplier: '1' }).at(-1)?.value;
    expect(value?.middle.value).toBe('2.333333333333333333');
    expect(value?.stdDev.value).toBe('1.247219128924647129');
  });

  it('retains the full high-precision squared-difference path in Bollinger', () => {
    const tiny = '0.000000000000000001';
    const huge = '999999999999999999.999999999999999999';
    const extreme = [candle(0, tiny, { high: tiny, low: tiny }), candle(1, huge, { high: huge, low: huge })];
    const value = computeBollinger(extreme, { ...scalar(2), multiplier: '1' }).at(-1)?.value;
    expect(value?.middle.value).toBe('500000000000000000');
    expect(value?.stdDev.value).toBe('499999999999999999.999999999999999999');
    expect(value?.upper.value).toBe('999999999999999999.999999999999999999');
    expect(value?.lower.value).toBe('0.000000000000000001');
  });
});

describe('DMI/ADX, SuperTrend, and Donchian', () => {
  const dmiBars = [
    candle(0, '9', { open: '9', high: '10', low: '8' }),
    candle(1, '11', { open: '10', high: '12', low: '9' }),
    candle(2, '12', { open: '11', high: '13', low: '10' }),
    candle(3, '9', { open: '10', high: '12', low: '8' }),
  ];

  it('seeds DMI on transitions 1..N and ADX at 2N-1', () => {
    const points = computeDmiAdx(dmiBars, scalar(2));
    expect(points[0]?.value).toBeNull();
    expect(points[1]?.value).toBeNull();
    expect(points[2]?.value?.plusDI.value).toBe('50');
    expect(points[2]?.value?.minusDI.value).toBe('0');
    expect(points[2]?.value?.adx).toBeNull();
    expect(points[3]?.value?.plusDI.value).toBe('21.428571428571428571');
    expect(points[3]?.value?.minusDI.value).toBe('28.571428571428571429');
    expect(points[3]?.value?.adx?.value).toBe('57.142857142857142857');
  });

  it('handles DMI tie, zero TR, zero denominator, and N=1', () => {
    const flat = [candle(0, '10', { high: '10', low: '10' }), candle(1, '10', { high: '10', low: '10' })];
    const result = computeDmiAdx(flat, scalar(1))[1]?.value;
    expect(result?.plusDI.value).toBe('0');
    expect(result?.minusDI.value).toBe('0');
    expect(result?.adx?.value).toBe('0');
    const tie = [candle(0, '10', { high: '11', low: '9' }), candle(1, '10', { high: '12', low: '8' })];
    const tieValue = computeDmiAdx(tie, scalar(1))[1]?.value;
    expect(tieValue?.plusDI.value).toBe('0');
    expect(tieValue?.minusDI.value).toBe('0');
  });

  it('implements SuperTrend seed, carry, DOWN-to-UP and equality boundary', () => {
    const bars = [
      candle(0, '10', { high: '11', low: '9' }),
      candle(1, '12', { open: '11', high: '12', low: '10' }),
      candle(2, '13', { open: '12.5', high: '13', low: '12' }),
      candle(3, '11.5', { open: '12', high: '13', low: '11.5' }),
      candle(4, '11', { open: '12', high: '12', low: '10' }),
    ];
    const values = computeSuperTrend(bars, { pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, atrPeriod: 1, multiplier: '1' }).map((point) =>
      point.value && { value: point.value.value.value, direction: point.value.direction },
    );
    expect(values).toEqual([
      { value: '12', direction: 'DOWN' },
      { value: '12', direction: 'DOWN' },
      { value: '11.5', direction: 'UP' },
      { value: '11.5', direction: 'UP' },
      { value: '13', direction: 'DOWN' },
    ]);
  });

  it('observes ATR warmup in SuperTrend', () => {
    expect(strings(computeSuperTrend(closes(['2', '3', '4']), { pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, atrPeriod: 3, multiplier: '2' }))).toEqual([null, null, '[object Object]']);
  });

  it('includes current candle and expires old Donchian extrema with N=1 support', () => {
    const bars = [
      candle(0, '5', { high: '10', low: '3' }),
      candle(1, '6', { high: '8', low: '2' }),
      candle(2, '7', { high: '7', low: '4' }),
      candle(3, '8', { high: '9', low: '5' }),
    ];
    const points = computeDonchian(bars, scalar(2));
    expect(points[1]?.value && { upper: points[1].value.upper.value, lower: points[1].value.lower.value }).toEqual({ upper: '10', lower: '2' });
    expect(points[2]?.value && { upper: points[2].value.upper.value, lower: points[2].value.lower.value }).toEqual({ upper: '8', lower: '2' });
    expect(points[3]?.value && { upper: points[3].value.upper.value, lower: points[3].value.lower.value, middle: points[3].value.middle.value }).toEqual({ upper: '9', lower: '4', middle: '6.5' });
    expect(computeDonchian([bars[0]!], scalar(1))[0]?.value?.upper.value).toBe('10');
  });
});

describe('UTC-day VWAP and volume indicators', () => {
  it('computes exact cumulative VWAP and preserves high-precision price-volume intermediates', () => {
    const bars = [
      candle(0, '10', { high: '11', low: '9', volume: '1' }),
      candle(1, '20', { high: '21', low: '19', volume: '3' }),
    ];
    expect(strings(computeUtcDayVwap(bars, { pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME }))).toEqual(['10', '17.5']);
    const huge = candle(0, '999999999999999999.999999999999999999', {
      high: '999999999999999999.999999999999999999', low: '999999999999999999.999999999999999999', volume: '999999999999999999999999999999.999999999999999999',
    });
    expect(new UtcDayVwapKernel({ pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME }).update(huge).value?.value)
      .toBe('999999999999999999.999999999999999999');
  });

  it('returns null through zero volume and resets exactly at UTC midnight', () => {
    const zero = [candle(0, '10', { volume: '0' }), candle(1, '12', { volume: '0' })];
    expect(strings(computeUtcDayVwap(zero, { pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME }))).toEqual([null, null]);
    const atMidnight = [
      candle(0, '10', { bootstrap: BASE_TIME + 86_399_940_000 }),
      candle(1, '20', { bootstrap: BASE_TIME + 86_399_940_000 }),
    ];
    expect(strings(computeUtcDayVwap(atMidnight, { pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME + 86_399_940_000 }))).toEqual(['10', '20']);
  });

  it('accepts a 1440-minute midnight-exclusive candle', () => {
    const daily = candle(0, '10', { timeframeMinutes: 1440, high: '11', low: '9', volume: '2' });
    const point = new UtcDayVwapKernel({ pair: 'BTC_INR', timeframeMinutes: 1440, bootstrapStartOpenTimeMs: BASE_TIME }).update(daily);
    expect(point.value?.value).toBe('10');
  });

  it('accepts a current safe higher-timeframe candle within one UTC day', () => {
    const fiveMinute = candle(0, '12', { timeframeMinutes: 5, high: '13', low: '10', volume: '4' });
    const point = new UtcDayVwapKernel({ pair: 'BTC_INR', timeframeMinutes: 5, bootstrapStartOpenTimeMs: BASE_TIME }).update(fiveMinute);
    expect(point.value?.value).toBe('11.666666666666666667');
  });

  it('computes VolumeSMA, VolumeRatio, zero denominator, and N=1', () => {
    const bars = ['2', '4', '6'].map((volume, index) => candle(index, '10', { volume }));
    expect(strings(computeVolumeSma(bars, scalar(2)))).toEqual([null, '3', '5']);
    expect(strings(computeVolumeRatio(bars, scalar(2)))).toEqual([null, '1.333333333333333333', '1.2']);
    expect(strings(computeVolumeRatio([candle(0, '10', { volume: '0' })], scalar(1)))).toEqual([null]);
    expect(strings(computeVolumeSma([candle(0, '10', { volume: '7' })], scalar(1)))).toEqual(['7']);
  });
});

void [AtrKernel, BollingerKernel, DmiAdxKernel, DonchianKernel, EmaKernel, RmaKernel, RsiKernel, SuperTrendKernel, TrueRangeKernel, VolumeRatioKernel, VolumeSmaKernel, IndicatorCalcDecimal];
