import { describe, expect, it } from 'vitest';
import { Decimal } from '../../../../src/core/decimal/decimal';
import { createCanonicalCandle1m } from '../../../../src/market-data/models';
import { aggregateExactBucket, bucketEndExclusiveMs, bucketStartMs, DerivedAggregateDecimal, durationMs, ENABLED_HIGHER_TIMEFRAMES } from '../../../../src/market-data/higher-timeframe';
import { BASE, candle } from './helpers';

describe('enabled higher-timeframe mathematical matrix', () => {
  it.each(ENABLED_HIGHER_TIMEFRAMES)('proves UTC epoch bucket duration, endpoints, and exact constituent count for %im', (timeframe) => {
    const atCrossHour = Date.UTC(2024, 0, 1, 1, 2, 0);
    const start = bucketStartMs(atCrossHour, timeframe);
    const end = bucketEndExclusiveMs(atCrossHour, timeframe);
    expect(durationMs(timeframe)).toBe(timeframe * 60_000);
    expect(end - start).toBe(timeframe * 60_000);
    expect(start % (timeframe * 60_000)).toBe(0);
    const values = Array.from({ length: timeframe }, (_, index) => candle('PAIR-A', (start - BASE) / 60_000 + index));
    const aggregate = aggregateExactBucket(values, timeframe);
    expect(aggregate).toMatchObject({ timeframeMinutes: timeframe, openTimeMs: start, closeTimeExclusiveMs: end });
  });

  it('anchors cross-hour, cross-midnight, and 1440m at UTC boundaries rather than IST', () => {
    const crossMidnight = Date.UTC(2024, 0, 2, 0, 1, 0);
    expect(bucketStartMs(crossMidnight, 60)).toBe(Date.UTC(2024, 0, 2, 0, 0, 0));
    expect(bucketStartMs(crossMidnight, 1440)).toBe(Date.UTC(2024, 0, 2, 0, 0, 0));
    expect(bucketStartMs(Date.UTC(2024, 0, 1, 5, 30, 0), 1440)).toBe(Date.UTC(2024, 0, 1, 0, 0, 0));
  });

  it('provides DerivedAggregateDecimal.from and equals and sums a 1440m expanded exact domain without changing shared Decimal configuration', () => {
    const precision = Decimal.precision; const rounding = Decimal.rounding;
    const same = new DerivedAggregateDecimal('10.0');
    expect(DerivedAggregateDecimal.from(same)).toBe(same);
    expect(DerivedAggregateDecimal.from('10.0').equals(new DerivedAggregateDecimal('10'))).toBe(true);
    const start = Date.UTC(2024, 0, 2, 0, 0, 0);
    const constituents = Array.from({ length: 1440 }, (_, index) => createCanonicalCandle1m({
      pair: 'PAIR-A', openTimeMs: start + index * 60_000, open: '1', high: '1', low: '1', close: '1',
      volume: '999999999999999999.999999999999999999', quoteVolume: null, source: 'WS_FINALIZED',
      finalizedAtMs: start + (index + 1) * 60_000, providerEventTimeMs: null, generationId: null,
    }));
    const result = aggregateExactBucket(constituents, 1440);
    expect(result.volume.value).toBe('1439999999999999999999.99999999999999856');
    expect(result.volume.value.split('.')[0]?.length).toBeGreaterThan(18);
    expect(Decimal.precision).toBe(precision); expect(Decimal.rounding).toBe(rounding);
  });
});
