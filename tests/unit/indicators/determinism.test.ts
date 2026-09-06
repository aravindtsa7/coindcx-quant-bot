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
  computeUtcDayVwap,
  computeVolumeRatio,
  computeVolumeSma,
  DmiAdxKernel,
  type DmiAdxValue,
  DonchianKernel,
  EmaKernel,
  type IndicatorCalculationSegmentIdentity,
  type IndicatorCandle,
  type IndicatorDecimal,
  type IndicatorKernel,
  type IndicatorPoint,
  MacdKernel,
  type MacdValue,
  RmaKernel,
  RsiKernel,
  SmaKernel,
  SuperTrendKernel,
  type SuperTrendValue,
  UtcDayVwapKernel,
  VolumeRatioKernel,
  VolumeSmaKernel,
} from '../../../src/indicators';
import { RollingExtrema, RollingSum } from '../../../src/indicators/primitives/rolling';
import { IndicatorCalcDecimal } from '../../../src/indicators/decimal/indicator-calc-decimal';
import { BASE_TIME, candle, closes } from './helpers';

function incremental(kernel: IndicatorKernel<unknown>, candles: readonly IndicatorCandle[]): readonly unknown[] {
  return candles.map((item) => kernel.update(item));
}
function encoded(value: unknown): string { return JSON.stringify(value); }

describe('batch/incremental parity and prefix determinism', () => {
  const bars = ['10', '12', '11', '15', '14', '18', '13', '17'].map((close, index) =>
    candle(index, close, { high: new IndicatorCalcDecimal(close).plus(2).toFixed(), low: new IndicatorCalcDecimal(close).minus(2).toFixed(), volume: String(index % 3) }),
  );
  const scalar = { pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, period: 3 };
  const macd = { pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 };
  const superTrend = { pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, atrPeriod: 3, multiplier: '1.5' } as const;
  const vwap = { pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME };

  const matrix = [
    ['SMA', () => computeSma(bars, scalar), () => new SmaKernel(scalar)],
    ['EMA', () => computeEma(bars, scalar), () => new EmaKernel(scalar)],
    ['RMA', () => computeRma(bars, scalar), () => new RmaKernel(scalar)],
    ['ATR', () => computeAtr(bars, scalar), () => new AtrKernel(scalar)],
    ['RSI', () => computeRsi(bars, scalar), () => new RsiKernel(scalar)],
    ['MACD', () => computeMacd(bars, macd), () => new MacdKernel(macd)],
    ['Bollinger', () => computeBollinger(bars, { ...scalar, multiplier: '2' }), () => new BollingerKernel({ ...scalar, multiplier: '2' })],
    ['DMI/ADX', () => computeDmiAdx(bars, scalar), () => new DmiAdxKernel(scalar)],
    ['SuperTrend', () => computeSuperTrend(bars, superTrend), () => new SuperTrendKernel(superTrend)],
    ['Donchian', () => computeDonchian(bars, scalar), () => new DonchianKernel(scalar)],
    ['VWAP', () => computeUtcDayVwap(bars, vwap), () => new UtcDayVwapKernel(vwap)],
    ['VolumeSMA', () => computeVolumeSma(bars, scalar), () => new VolumeSmaKernel(scalar)],
    ['VolumeRatio', () => computeVolumeRatio(bars, scalar), () => new VolumeRatioKernel(scalar)],
  ] as const;

  it.each(matrix)('%s batch calls the same incremental behavior', (_name, batch, factory) => {
    expect(encoded(batch())).toBe(encoded(incremental(factory(), bars)));
  });

  it.each(matrix)('%s is prefix deterministic with no repainting', (_name, batch, factory) => {
    const full = batch();
    const prefix = incremental(factory(), bars.slice(0, 5));
    expect(encoded(full.slice(0, 5))).toBe(encoded(prefix));
  });
});

describe('restart, isolation, and resource behavior', () => {
  const bars = closes(['10', '13', '9', '17', '12', '20', '11', '19']);
  const scalar = { pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, period: 3 };
  const recursiveFactories = [
    ['EMA', () => new EmaKernel(scalar)],
    ['RMA', () => new RmaKernel(scalar)],
    ['ATR', () => new AtrKernel(scalar)],
    ['RSI', () => new RsiKernel(scalar)],
    ['MACD', () => new MacdKernel({ pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 })],
    ['DMI/ADX', () => new DmiAdxKernel(scalar)],
    ['SuperTrend', () => new SuperTrendKernel({ pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, atrPeriod: 3, multiplier: '2' })],
  ] as const;

  it.each(recursiveFactories)('%s has exact same-origin replay parity', (_name, factory) => {
    const uninterrupted = incremental(factory(), bars);
    const rebuilt = incremental(factory(), bars);
    expect(encoded(rebuilt)).toBe(encoded(uninterrupted));
  });

  const nonEquivalentBars = [
    candle(0, '10', { open: '10', high: '12', low: '8', volume: '10' }),
    candle(1, '13', { open: '10', high: '15', low: '9', volume: '11' }),
    candle(2, '9', { open: '13', high: '14', low: '7', volume: '12' }),
    candle(3, '17', { open: '9', high: '19', low: '8', volume: '13' }),
    candle(4, '12', { open: '17', high: '18', low: '10', volume: '14' }),
    candle(5, '20', { open: '12', high: '22', low: '11', volume: '15' }),
    candle(6, '11', { open: '20', high: '21', low: '9', volume: '16' }),
    candle(7, '19', { open: '11', high: '21', low: '10', volume: '17' }),
    candle(8, '15', { open: '19', high: '20', low: '13', volume: '18' }),
    candle(9, '22', { open: '15', high: '24', low: '14', volume: '19' }),
    candle(10, '18', { open: '22', high: '23', low: '16', volume: '20' }),
    candle(11, '25', { open: '18', high: '27', low: '17', volume: '21' }),
  ];

  type DistinctTrajectoryResult = {
    readonly segmentA: IndicatorCalculationSegmentIdentity;
    readonly segmentB: IndicatorCalculationSegmentIdentity;
    readonly valueA: string;
    readonly valueB: string;
  };

  const evaluateDistinctTrajectory = <T>(
    createKernel: (bootstrapStartOpenTimeMs: number) => IndicatorKernel<T>,
    extractValue: (point: IndicatorPoint<T>) => string | null,
    k: number,
  ): DistinctTrajectoryResult => {
    const originA = nonEquivalentBars[0]!.openTimeMs;
    const originB = nonEquivalentBars[k]!.openTimeMs;
    const kernelA = createKernel(originA);
    const kernelB = createKernel(originB);
    const outA = nonEquivalentBars.map((item) => kernelA.update(item));
    const outB = nonEquivalentBars.slice(k).map((item) => kernelB.update(item));
    const lastA = outA.at(-1);
    const lastB = outB.at(-1);
    if (!lastA || !lastB) throw new Error('Expected output points');
    const valueA = extractValue(lastA);
    const valueB = extractValue(lastB);
    if (valueA === null || valueB === null) {
      throw new Error(`Expected non-null output after warmup, got valueA=${valueA}, valueB=${valueB}`);
    }
    return {
      segmentA: kernelA.segment,
      segmentB: kernelB.segment,
      valueA,
      valueB,
    };
  };

  const differentOriginMatrix: readonly [string, () => DistinctTrajectoryResult][] = [
    ['EMA', () => evaluateDistinctTrajectory((origin) => new EmaKernel({ ...scalar, bootstrapStartOpenTimeMs: origin }), (point: IndicatorPoint<IndicatorDecimal>) => point.value?.value ?? null, 3)],
    ['RMA', () => evaluateDistinctTrajectory((origin) => new RmaKernel({ ...scalar, bootstrapStartOpenTimeMs: origin }), (point: IndicatorPoint<IndicatorDecimal>) => point.value?.value ?? null, 3)],
    ['ATR', () => evaluateDistinctTrajectory((origin) => new AtrKernel({ ...scalar, bootstrapStartOpenTimeMs: origin }), (point: IndicatorPoint<IndicatorDecimal>) => point.value?.value ?? null, 3)],
    ['RSI', () => evaluateDistinctTrajectory((origin) => new RsiKernel({ ...scalar, bootstrapStartOpenTimeMs: origin }), (point: IndicatorPoint<IndicatorDecimal>) => point.value?.value ?? null, 3)],
    ['MACD', () => evaluateDistinctTrajectory((origin) => new MacdKernel({ pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: origin, fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 }), (point: IndicatorPoint<MacdValue>) => point.value?.signal?.value ?? null, 3)],
    ['DMI/ADX', () => evaluateDistinctTrajectory((origin) => new DmiAdxKernel({ ...scalar, bootstrapStartOpenTimeMs: origin }), (point: IndicatorPoint<DmiAdxValue>) => point.value?.adx?.value ?? null, 3)],
    ['SuperTrend', () => evaluateDistinctTrajectory((origin) => new SuperTrendKernel({ pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: origin, atrPeriod: 3, multiplier: '2' }), (point: IndicatorPoint<SuperTrendValue>) => point.value?.value.value ?? null, 3)],
  ];

  it.each(differentOriginMatrix)('%s treats a later bootstrap as a distinct recursive trajectory', (_name, run) => {
    const result = run();
    expect(result.segmentB.bootstrapStartOpenTimeMs).not.toBe(result.segmentA.bootstrapStartOpenTimeMs);
    expect(result.segmentB).not.toEqual(result.segmentA);
    expect(result.valueA).not.toBe(result.valueB);
  });

  it('repairs a gap only by rebuilding and replaying from the original origin', () => {
    const clean = incremental(new EmaKernel(scalar), bars);
    const broken = new EmaKernel(scalar);
    broken.update(bars[0]!);
    expect(() => broken.update(bars[2]!)).toThrowError(expect.objectContaining({ code: 'CANDLE_GAP' }));
    expect(() => broken.update(bars[1]!)).toThrowError(expect.objectContaining({ code: 'CANDLE_GAP' }));
    expect(encoded(incremental(new EmaKernel(scalar), bars))).toBe(encoded(clean));
  });

  it('keeps pair, timeframe, and parameter instances isolated while interleaved', () => {
    const btc = new EmaKernel({ ...scalar, period: 2 });
    const eth = new EmaKernel({ ...scalar, pair: 'ETH_INR', period: 3 });
    const five = new EmaKernel({ ...scalar, timeframeMinutes: 5, period: 2 });
    const btcBars = closes(['1', '3', '8']);
    const ethBars = closes(['10', '20', '30'], { pair: 'ETH_INR' });
    const fiveBars = closes(['5', '15', '25'], { timeframeMinutes: 5 });
    const btcOut: unknown[] = []; const ethOut: unknown[] = []; const fiveOut: unknown[] = [];
    for (let index = 0; index < 3; index += 1) {
      btcOut.push(btc.update(btcBars[index]!));
      ethOut.push(eth.update(ethBars[index]!));
      fiveOut.push(five.update(fiveBars[index]!));
    }
    expect(encoded(btcOut)).toBe(encoded(computeEma(btcBars, { ...scalar, period: 2 })));
    expect(encoded(ethOut)).toBe(encoded(computeEma(ethBars, { ...scalar, pair: 'ETH_INR', period: 3 })));
    expect(encoded(fiveOut)).toBe(encoded(computeEma(fiveBars, { ...scalar, timeframeMinutes: 5, period: 2 })));
  });

  it('never feeds public-rounded EMA values back into recurrence', () => {
    const precisionBars = closes(['1', '63', '28', '90']);
    const values = computeEma(precisionBars, scalar).map((point) => point.value?.value ?? null);
    // Raw seed is 92/3. Feeding its published ...667 value back would produce ...334 here.
    expect(values).toEqual([null, null, '30.666666666666666667', '60.333333333333333333']);
  });

  it('bounds rolling queues and grows them lazily', () => {
    const sum = new RollingSum(3);
    const max = new RollingExtrema(3, 'MAX');
    expect(sum.size).toBe(0);
    expect(max.size).toBe(0);
    for (let index = 0; index < 100; index += 1) {
      const value = new IndicatorCalcDecimal(index);
      sum.push(value); max.push(value);
      expect(sum.size).toBeLessThanOrEqual(3);
      expect(max.size).toBeLessThanOrEqual(3);
    }
  });
});
