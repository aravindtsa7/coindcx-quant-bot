import { describe, expect, it } from 'vitest';
import { HigherTimeframeEngine } from '../../../../src/market-data/higher-timeframe';
import { BASE, candle, FakeCanonicalEngine, flushQueues, MemoryRangeReader } from './helpers';

describe('HigherTimeframeEngine hydration and historical replay suppression', () => {
  it('never replays a startup-complete 5m bucket when a later 60m-anchored resync rereads it', async () => {
    const source = new FakeCanonicalEngine(); const reader = new MemoryRangeReader(); source.setHealth('PAIR-A');
    reader.add(...Array.from({ length: 5 }, (_, minute) => candle('PAIR-A', minute)));
    const engine = new HigherTimeframeEngine({ canonicalEngine: source, rangeReader: reader, pairs: ['PAIR-A'], timeframes: [5, 60] });
    const fiveMinuteStarts: number[] = []; engine.subscribe((event) => { if (event.timeframeMinutes === 5) fiveMinuteStarts.push(event.bucketStartMs); });
    await engine.start(); expect(fiveMinuteStarts).toEqual([]);
    source.setHealth('PAIR-A', { state: 'STALE' }); source.emit(candle('PAIR-A', 5)); await flushQueues();
    reader.add(...Array.from({ length: 6 }, (_, index) => candle('PAIR-A', index + 5)));
    source.setHealth('PAIR-A'); source.emit(candle('PAIR-A', 5)); await flushQueues();
    expect(fiveMinuteStarts).toEqual([BASE + 5 * 60_000]);
    expect(new Set(fiveMinuteStarts).size).toBe(fiveMinuteStarts.length); engine.stop();
  });

  it('retains an incomplete startup bucket and publishes it exactly once when future live truth completes it', async () => {
    const source = new FakeCanonicalEngine(); const reader = new MemoryRangeReader(); source.setHealth('PAIR-A');
    reader.add(...Array.from({ length: 4 }, (_, minute) => candle('PAIR-A', minute)));
    const engine = new HigherTimeframeEngine({ canonicalEngine: source, rangeReader: reader, pairs: ['PAIR-A'], timeframes: [5] });
    const starts: number[] = []; engine.subscribe((event) => starts.push(event.bucketStartMs)); await engine.start();
    reader.add(candle('PAIR-A', 4)); source.emit(candle('PAIR-A', 4)); await flushQueues();
    source.emit(candle('PAIR-A', 4)); await flushQueues();
    expect(starts).toEqual([BASE]); engine.stop();
  });

  it('fails closed for startup latest/range failures and continuity gaps without publication', async () => {
    for (const failure of ['latest', 'range', 'gap'] as const) {
      const source = new FakeCanonicalEngine(); const reader = new MemoryRangeReader(); source.setHealth('PAIR-A'); reader.add(candle('PAIR-A', 0));
      if (failure === 'latest') reader.latestError = new Error('latest failed');
      if (failure === 'range') reader.rangeError = new Error('range failed');
      if (failure === 'gap') reader.add(candle('PAIR-A', 2));
      const engine = new HigherTimeframeEngine({ canonicalEngine: source, rangeReader: reader, pairs: ['PAIR-A'], timeframes: [5] });
      const events: unknown[] = []; engine.subscribe((event) => events.push(event)); await engine.start(); await flushQueues();
      expect(engine.getPairSnapshot('PAIR-A')?.operationalState).toBe('BLOCKED'); expect(events).toEqual([]); engine.stop();
    }
  });
});
