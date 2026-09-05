import { CanonicalDecimal } from '../canonical-decimal';
import { CanonicalCandle1m } from '../types';
import { AggregationDecimal, DerivedAggregateDecimal } from './derived-aggregate-decimal';
import { HigherTimeframeCandle } from './types';
import { MINUTE_MS, assertMinuteAlignedOpenTimeMs, bucketEndExclusiveMs, bucketStartMs, durationMs } from './timeframe';

function assertCanonicalConstituent(candle: CanonicalCandle1m): void {
  if (!candle || typeof candle.pair !== 'string' || candle.pair.trim() === '') throw new TypeError('Invalid canonical constituent pair');
  assertMinuteAlignedOpenTimeMs(candle.openTimeMs);
  if (candle.closeTimeExclusiveMs !== candle.openTimeMs + MINUTE_MS || !Number.isSafeInteger(candle.closeTimeExclusiveMs)) {
    throw new RangeError('Invalid canonical constituent close time');
  }
  if (!(candle.open instanceof CanonicalDecimal) || !(candle.high instanceof CanonicalDecimal) || !(candle.low instanceof CanonicalDecimal) || !(candle.close instanceof CanonicalDecimal) || !(candle.volume instanceof CanonicalDecimal)) {
    throw new TypeError('Canonical constituent decimals are invalid');
  }
  if (candle.quoteVolume !== null && !(candle.quoteVolume instanceof CanonicalDecimal)) throw new TypeError('Invalid canonical quote volume');
  if ((candle.source !== 'WS_FINALIZED' && candle.source !== 'REST_RECOVERY') || candle.high.lessThan(candle.low) || candle.high.lessThan(candle.open) || candle.high.lessThan(candle.close) || candle.low.greaterThan(candle.open) || candle.low.greaterThan(candle.close)) {
    throw new TypeError('Invalid canonical constituent structure');
  }
}

function exactSum(values: readonly CanonicalDecimal[]): DerivedAggregateDecimal {
  let total = new AggregationDecimal(0);
  for (const value of values) total = total.plus(value.value);
  return new DerivedAggregateDecimal(total.toFixed());
}

/** The sole Phase 6 aggregation mathematics primitive. */
export function aggregateExactBucket(candles: readonly CanonicalCandle1m[], timeframeMinutes: number): HigherTimeframeCandle {
  const duration = durationMs(timeframeMinutes);
  if (candles.length !== timeframeMinutes) throw new RangeError(`Expected exactly ${timeframeMinutes} canonical constituents`);
  const ordered = [...candles];
  for (const candle of ordered) assertCanonicalConstituent(candle);
  ordered.sort((a, b) => a.openTimeMs - b.openTimeMs);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) throw new RangeError('No canonical constituents');
  const start = bucketStartMs(first.openTimeMs, timeframeMinutes);
  const end = bucketEndExclusiveMs(first.openTimeMs, timeframeMinutes);
  if (last.openTimeMs !== end - MINUTE_MS || end - start !== duration) throw new RangeError('Constituents do not cover exact bucket endpoints');
  for (let index = 0; index < ordered.length; index++) {
    const candle = ordered[index];
    if (!candle || candle.pair !== first.pair || candle.openTimeMs !== start + index * MINUTE_MS || bucketStartMs(candle.openTimeMs, timeframeMinutes) !== start) {
      throw new RangeError('Constituents are not one exact contiguous canonical bucket');
    }
  }
  let high = first.high;
  let low = first.low;
  for (const candle of ordered) {
    if (candle.high.greaterThan(high)) high = candle.high;
    if (candle.low.lessThan(low)) low = candle.low;
  }
  const quoteVolume = ordered.every((candle) => candle.quoteVolume !== null)
    ? exactSum(ordered.map((candle) => candle.quoteVolume as CanonicalDecimal))
    : null;
  return Object.freeze({
    pair: first.pair,
    timeframeMinutes,
    openTimeMs: start,
    closeTimeExclusiveMs: end,
    open: first.open,
    high,
    low,
    close: last.close,
    volume: exactSum(ordered.map((candle) => candle.volume)),
    quoteVolume,
    source: 'CANONICAL_1M_DERIVED' as const,
  });
}
