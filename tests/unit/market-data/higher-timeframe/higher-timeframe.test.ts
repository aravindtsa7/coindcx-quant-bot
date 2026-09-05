import { describe, expect, it } from 'vitest';
import { createCanonicalCandle1m } from '../../../../src/market-data/models';
import {
  AggregationDecimal,
  DerivedAggregateDecimal,
  ENABLED_HIGHER_TIMEFRAMES,
  aggregateExactBucket,
  bucketEndExclusiveMs,
  bucketStartMs,
  normalizeTimeframes,
} from '../../../../src/market-data/higher-timeframe';
import { CanonicalCandle1m } from '../../../../src/market-data/types';

const BASE = 1_704_067_200_000; // 2024-01-01T00:00:00Z
function candle(minute: number, overrides: Partial<Parameters<typeof createCanonicalCandle1m>[0]> = {}): CanonicalCandle1m {
  return createCanonicalCandle1m({
    pair: 'B-BTC_USDT', openTimeMs: BASE + minute * 60_000,
    open: '10', high: '12', low: '9', close: '11', volume: '1.1', quoteVolume: '10.1',
    source: 'WS_FINALIZED', finalizedAtMs: BASE + minute * 60_000 + 60_000,
    providerEventTimeMs: null, generationId: null, ...overrides,
  });
}

describe('higher timeframe pure contracts', () => {
  it('uses deterministic generic UTC bucket math and validates configuration', () => {
    expect(ENABLED_HIGHER_TIMEFRAMES).toEqual([2, 3, 4, 5, 10, 15, 30, 60, 240, 1440]);
    expect(normalizeTimeframes([15, 2, 5])).toEqual([2, 5, 15]);
    expect(bucketStartMs(BASE + 4 * 60_000, 5)).toBe(BASE);
    expect(bucketEndExclusiveMs(BASE + 4 * 60_000, 5)).toBe(BASE + 5 * 60_000);
    for (const bad of [1, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      expect(() => normalizeTimeframes([bad])).toThrow();
    }
    expect(() => normalizeTimeframes([2, 2])).toThrow();
  });

  it('aggregates exact constituents without mutating the caller and preserves null quote volume', () => {
    const input = [
      candle(2, { open: '20', high: '22', low: '19', close: '21', volume: '2.2' }),
      candle(0, { open: '10', high: '14', low: '9', close: '13', volume: '1.1' }),
      candle(1, { open: '13', high: '30', low: '12', close: '20', volume: '3.3' }),
    ];
    const original = [...input];
    const result = aggregateExactBucket(input, 3);
    expect(input).toEqual(original);
    expect(result.open.value).toBe('10');
    expect(result.high.value).toBe('30');
    expect(result.low.value).toBe('9');
    expect(result.close.value).toBe('21');
    expect(result.volume.value).toBe('6.6');
    expect(result.quoteVolume?.value).toBe('30.3');
    expect(aggregateExactBucket([candle(0), candle(1, { quoteVolume: null })], 2).quoteVolume).toBeNull();
    expect(() => aggregateExactBucket([candle(0), candle(0)], 2)).toThrow();
    expect(() => aggregateExactBucket([candle(0), candle(2)], 2)).toThrow();
  });

  it('keeps aggregate decimal isolated, exact, bounded, and immutable', () => {
    expect(new DerivedAggregateDecimal('9'.repeat(30) + '.' + '1'.repeat(18)).value).toHaveLength(49);
    expect(() => new DerivedAggregateDecimal('1e4')).toThrow();
    expect(() => new DerivedAggregateDecimal('-1')).toThrow();
    expect(() => new DerivedAggregateDecimal('1.' + '1'.repeat(19))).toThrow();
    expect(Object.isFrozen(new DerivedAggregateDecimal('1.2'))).toBe(true);
    let total = new AggregationDecimal(0);
    for (let index = 0; index < 1440; index++) total = total.plus('999999999999999999.999999999999999999');
    expect(new DerivedAggregateDecimal(total.toFixed()).value).toBe('1439999999999999999999.99999999999999856');
  });
});
