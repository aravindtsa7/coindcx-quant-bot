import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { createCanonicalCandle1m } from '../../../src/market-data/models';
import { CanonicalDecimal } from '../../../src/market-data/canonical-decimal';
import { DerivedAggregateDecimal } from '../../../src/market-data/higher-timeframe/derived-aggregate-decimal';
import type { HigherTimeframeCandle } from '../../../src/market-data/higher-timeframe/types';
import {
  adaptCanonicalCandle1m,
  adaptHigherTimeframeCandle,
  BollingerKernel,
  IndicatorCalcDecimal,
  IndicatorDecimal,
  IndicatorError,
  MAX_INDICATOR_PERIOD,
  SmaKernel,
  SuperTrendKernel,
  VwapKernel,
  validatePeriod,
} from '../../../src/indicators';
import { populationVariance } from '../../../src/indicators/primitives/rolling';
import { BASE_TIME, candle } from './helpers';

function codeOf(action: () => unknown): string | undefined {
  try { action(); } catch (error) { return error instanceof IndicatorError ? error.code : undefined; }
  return undefined;
}

describe('Phase 8 decimal architecture', () => {
  it('uses an isolated 128-digit context without mutating global Decimal', () => {
    expect(Decimal.precision).toBe(30);
    expect(IndicatorCalcDecimal.precision).toBe(128);
    expect(IndicatorCalcDecimal.rounding).toBe(Decimal.ROUND_HALF_UP);
    expect(Decimal.precision).toBe(30);
  });

  it.each([
    ['0007.5000', '7.5'],
    ['-0007.5000', '-7.5'],
    ['-0.0000000000000000001', '0'],
    ['0.0000000000000000004', '0'],
    ['12.34000', '12.34'],
    ['100000000000000000000000000000', '100000000000000000000000000000'],
  ])('canonicalizes %s to %s', (input, expected) => {
    const value = new IndicatorDecimal(input);
    expect(value.value).toBe(expected);
    expect(value.toJSON()).toBe(expected);
    expect(Object.isFrozen(value)).toBe(true);
    expect(value.value).not.toMatch(/[eE]/);
  });

  it('rounds half up to 18 fractional places', () => {
    expect(new IndicatorDecimal('1.1234567890123456784').value).toBe('1.123456789012345678');
    expect(new IndicatorDecimal('1.1234567890123456785').value).toBe('1.123456789012345679');
    expect(new IndicatorDecimal('-1.1234567890123456785').value).toBe('-1.123456789012345679');
  });

  it('renders tiny and large finite values without exponents', () => {
    expect(new IndicatorDecimal('0.000000000000000001').value).toBe('0.000000000000000001');
    expect(new IndicatorDecimal('999999999999999999999999999999.9').value).toBe('999999999999999999999999999999.9');
  });

  it('rejects overflow and non-finite values with stable codes', () => {
    expect(codeOf(() => new IndicatorDecimal('1000000000000000000000000000000'))).toBe('INDICATOR_OVERFLOW');
    expect(() => new IndicatorDecimal('123456789012345678901234567890.123456789012345678')).not.toThrow();
    expect(codeOf(() => new IndicatorDecimal('NaN'))).toBe('INDICATOR_NUMERIC_FAILURE');
    expect(codeOf(() => new IndicatorDecimal('Infinity'))).toBe('INDICATOR_NUMERIC_FAILURE');
  });

  it('rejects post-quantization carry overflow when rounding to 18 decimal places', () => {
    const carryOverflowInput = '999999999999999999999999999999.9999999999999999996';
    expect(() => new IndicatorDecimal(carryOverflowInput)).toThrow(IndicatorError);
    expect(codeOf(() => new IndicatorDecimal(carryOverflowInput))).toBe('INDICATOR_OVERFLOW');
  });

  it('retains finite products and squared differences beyond 64 digits', () => {
    const product = new IndicatorCalcDecimal('999999999999999999.999999999999999999')
      .times('999999999999999999999999999999.999999999999999999');
    expect(product.toFixed()).toBe('999999999999999999999999999999999998999999999999.000000000000000000000000000000000001');
    const values = [
      new IndicatorCalcDecimal('999999999999999999.999999999999999999'),
      new IndicatorCalcDecimal('0.000000000000000001'),
    ];
    const variance = populationVariance(values, values[0]!.plus(values[1]!).div(2));
    expect(variance.toFixed().replace('.', '').length).toBeGreaterThan(64);
  });
});

describe('candle adapters, validation, and terminal segments', () => {
  it('adapts canonical candles and ignores provenance in math', () => {
    const make = (source: 'WS_FINALIZED' | 'REST_RECOVERY' | 'REST_HISTORICAL') => createCanonicalCandle1m({
      pair: 'BTC_INR', openTimeMs: BASE_TIME, open: '10', high: '11', low: '9', close: '10', volume: '2', quoteVolume: null,
      source, finalizedAtMs: BASE_TIME + 60_001, providerEventTimeMs: null, generationId: null,
    });
    const outputs = (['WS_FINALIZED', 'REST_RECOVERY', 'REST_HISTORICAL'] as const).map((source) =>
      new SmaKernel({ pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, period: 1 }).update(adaptCanonicalCandle1m(make(source))).value?.value,
    );
    expect(outputs).toEqual(['10', '10', '10']);
  });

  it('adapts actual higher-timeframe candle contracts', () => {
    const source: HigherTimeframeCandle = Object.freeze({
      pair: 'ETH_INR', timeframeMinutes: 5, openTimeMs: BASE_TIME, closeTimeExclusiveMs: BASE_TIME + 300_000,
      open: new CanonicalDecimal('20'), high: new CanonicalDecimal('22'), low: new CanonicalDecimal('19'), close: new CanonicalDecimal('21'),
      volume: new DerivedAggregateDecimal('12345678901234567890.25'), quoteVolume: new DerivedAggregateDecimal('8'), source: 'CANONICAL_1M_DERIVED',
    });
    const adapted = adaptHigherTimeframeCandle(source);
    expect(adapted.timeframeMinutes).toBe(5);
    expect(adapted.volume.toFixed()).toBe('12345678901234567890.25');
    expect(Object.isFrozen(adapted)).toBe(true);
  });

  it.each([
    ['PAIR_MISMATCH', () => ({ ...candle(0, '10'), pair: 'ETH_INR' })],
    ['TIMEFRAME_MISMATCH', () => ({ ...candle(0, '10', { timeframeMinutes: 5 }), pair: 'BTC_INR' })],
    ['INVALID_CANDLE_INPUT', () => ({ ...candle(0, '10'), openTimeMs: BASE_TIME + 1 })],
    ['INVALID_CANDLE_INPUT', () => ({ ...candle(0, '10'), closeTimeExclusiveMs: BASE_TIME + 1 })],
    ['INVALID_CANDLE_INPUT', () => ({ ...candle(0, '10'), high: new IndicatorCalcDecimal('9') })],
    ['INVALID_CANDLE_INPUT', () => ({ ...candle(0, '10'), volume: new IndicatorCalcDecimal('-1') })],
  ])('rejects malformed input as %s and terminates', (expected, makeBad) => {
    const kernel = new SmaKernel({ pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, period: 1 });
    expect(codeOf(() => kernel.update(makeBad() as ReturnType<typeof candle>))).toBe(expected);
    expect(kernel.isTerminated).toBe(true);
    expect(() => kernel.update(candle(0, '10'))).toThrow();
  });

  it('requires the configured bootstrap origin', () => {
    const kernel = new SmaKernel({ pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, period: 1 });
    expect(codeOf(() => kernel.update(candle(1, '10')))).toBe('INVALID_CANDLE_INPUT');
  });

  it.each([
    ['duplicate', 0, 'CANDLE_ORDER_VIOLATION'],
    ['backward', -1, 'CANDLE_ORDER_VIOLATION'],
    ['gap', 2, 'CANDLE_GAP'],
  ])('fails closed on a %s timestamp', (_label, index, expected) => {
    const kernel = new SmaKernel({ pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, period: 2 });
    kernel.update(candle(0, '10'));
    expect(codeOf(() => kernel.update(candle(index, '11')))).toBe(expected);
    expect(codeOf(() => kernel.update(candle(1, '11')))).toBe(expected);
  });

  it('does not mutate rolling state before rejecting and allows a fresh segment', () => {
    const config = { pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, period: 2 };
    const broken = new SmaKernel(config);
    broken.update(candle(0, '10'));
    expect(codeOf(() => broken.update(candle(2, '100')))).toBe('CANDLE_GAP');
    const repaired = new SmaKernel(config);
    expect(repaired.update(candle(0, '10')).value).toBeNull();
    expect(repaired.update(candle(1, '12')).value?.value).toBe('11');
    const newSegment = new SmaKernel({ ...config, bootstrapStartOpenTimeMs: BASE_TIME + 120_000 });
    expect(newSegment.segment.bootstrapStartOpenTimeMs).not.toBe(repaired.segment.bootstrapStartOpenTimeMs);
    expect(newSegment.update(candle(2, '100')).value).toBeNull();
  });

  it('rejects a VWAP midnight straddle before accumulation', () => {
    const start = STRADDLING_7M_START;
    const kernel = new VwapKernel({ pair: 'BTC_INR', timeframeMinutes: 7, bootstrapStartOpenTimeMs: start });
    const bad = candle(0, '10', { bootstrap: start, timeframeMinutes: 7 });
    expect(codeOf(() => kernel.update(bad))).toBe('INVALID_CANDLE_INPUT');
    expect(kernel.isTerminated).toBe(true);
  });

  it('validates all period and multiplier boundaries before allocation', () => {
    expect(validatePeriod(1)).toBe(1);
    expect(validatePeriod(MAX_INDICATOR_PERIOD)).toBe(MAX_INDICATOR_PERIOD);
    for (const invalid of [0, -1, 1.5, 100_001, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
      expect(codeOf(() => validatePeriod(invalid))).toBe('INVALID_INDICATOR_PARAMETER');
    }
    expect(() => new SmaKernel({ pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, period: 100_000 })).not.toThrow();
    expect(codeOf(() => new BollingerKernel({ pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, period: 2, multiplier: '0' }))).toBe('INVALID_INDICATOR_PARAMETER');
    expect(codeOf(() => new SuperTrendKernel({ pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, atrPeriod: 2, multiplier: '-1' }))).toBe('INVALID_INDICATOR_PARAMETER');
    expect(() => new BollingerKernel({ pair: 'BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE_TIME, period: 2, multiplier: new IndicatorCalcDecimal('1.25') })).not.toThrow();
  });
});

const STRADDLING_7M_START = Math.floor((BASE_TIME + 86_400_000 - 1) / (7 * 60_000)) * 7 * 60_000;
