import { describe, expect, it } from 'vitest';
import { aggregateExactBucket, HigherTimeframeEngine } from '../../../../src/market-data/higher-timeframe';
import { HigherTimeframeCandle } from '../../../../src/market-data/higher-timeframe/types';
import { BASE, candle, FakeCanonicalEngine, flushQueues, MemoryRangeReader } from './helpers';

function identity(value: HigherTimeframeCandle): string { return `${value.timeframeMinutes}:${value.openTimeMs}`; }
function comparable(value: HigherTimeframeCandle): object {
  return { pair: value.pair, timeframeMinutes: value.timeframeMinutes, openTimeMs: value.openTimeMs, closeTimeExclusiveMs: value.closeTimeExclusiveMs, open: value.open.value, high: value.high.value, low: value.low.value, close: value.close.value, volume: value.volume.value, quoteVolume: value.quoteVolume?.value ?? null, source: value.source };
}

describe('HigherTimeframeEngine ordering and batch/live parity', () => {
  it('emits simultaneous live closes in ascending timeframe order and matches aggregateExactBucket exactly', async () => {
    const source = new FakeCanonicalEngine(); const reader = new MemoryRangeReader(); source.setHealth('PAIR-A'); reader.add(candle('PAIR-A', 0));
    const timeframes = [2, 3, 4, 5]; const engine = new HigherTimeframeEngine({ canonicalEngine: source, rangeReader: reader, pairs: ['PAIR-A'], timeframes });
    const events: HigherTimeframeCandle[] = []; engine.subscribe((event) => { expect(event.eventTimeMs).toBe(event.closeTimeExclusiveMs); events.push(event.candle); }); await engine.start();
    const data = Array.from({ length: 20 }, (_, minute) => candle('PAIR-A', minute));
    for (const value of data.slice(1)) { reader.add(value); source.emit(value); await flushQueues(); }
    const exact = new Map<string, HigherTimeframeCandle>();
    for (const timeframe of timeframes) for (let start = 0; start + timeframe <= data.length; start += timeframe) exact.set(`${timeframe}:${BASE + start * 60_000}`, aggregateExactBucket(data.slice(start, start + timeframe), timeframe));
    expect(events.map(identity).sort()).toEqual([...exact.keys()].sort());
    for (const value of events) expect(comparable(value)).toEqual(comparable(exact.get(identity(value))!));
    const closeAt20 = events.filter((value) => value.closeTimeExclusiveMs === BASE + 20 * 60_000).map((value) => value.timeframeMinutes);
    expect(closeAt20).toEqual([2, 4, 5]);
    engine.stop();
  });

  it('stages resync catch-up in close-time then timeframe order with unique identities', async () => {
    const source = new FakeCanonicalEngine(); const reader = new MemoryRangeReader(); source.setHealth('PAIR-A'); reader.add(candle('PAIR-A', 0));
    const engine = new HigherTimeframeEngine({ canonicalEngine: source, rangeReader: reader, pairs: ['PAIR-A'], timeframes: [2, 3, 4] });
    const events: HigherTimeframeCandle[] = []; engine.subscribe((event) => events.push(event.candle)); await engine.start();
    source.setHealth('PAIR-A', { state: 'STALE' }); source.emit(candle('PAIR-A', 1)); await flushQueues();
    reader.add(...Array.from({ length: 8 }, (_, index) => candle('PAIR-A', index + 1))); source.setHealth('PAIR-A'); source.emit(candle('PAIR-A', 1)); await flushQueues();
    const keys = events.map(identity); expect(new Set(keys).size).toBe(keys.length);
    const order = events.map((value) => [value.closeTimeExclusiveMs, value.timeframeMinutes]);
    expect(order).toEqual([...order].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!));
    engine.stop();
  });
});
