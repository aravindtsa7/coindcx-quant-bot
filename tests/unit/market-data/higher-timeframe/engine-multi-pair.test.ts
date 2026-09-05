import { describe, expect, it } from 'vitest';
import { HigherTimeframeEngine } from '../../../../src/market-data/higher-timeframe';
import { BASE, candle, deferred, FakeCanonicalEngine, flushQueues, MemoryRangeReader } from './helpers';

describe('HigherTimeframeEngine pair isolation', () => {
  it('allows Pair B hydration and live publication while Pair A DB work remains pending', async () => {
    const source = new FakeCanonicalEngine(); const reader = new MemoryRangeReader();
    source.setHealth('PAIR-A'); source.setHealth('PAIR-B'); reader.add(candle('PAIR-A', 0), candle('PAIR-B', 0));
    const gate = deferred<void>(); reader.rangeGate = async (pair) => { if (pair === 'PAIR-A') await gate.promise; };
    const engine = new HigherTimeframeEngine({ canonicalEngine: source, rangeReader: reader, pairs: ['PAIR-A', 'PAIR-B'], timeframes: [2] });
    const emitted: Array<{ pair: string; start: number }> = []; engine.subscribe((event) => emitted.push({ pair: event.pair, start: event.bucketStartMs }));
    const started = engine.start(); await flushQueues();
    expect(engine.getPairSnapshot('PAIR-A')?.operationalState).toBe('INITIALIZING');
    expect(engine.getPairSnapshot('PAIR-B')?.operationalState).toBe('READY');
    reader.add(candle('PAIR-B', 1)); source.emit(candle('PAIR-B', 1)); await flushQueues();
    expect(emitted).toEqual([{ pair: 'PAIR-B', start: BASE }]);
    expect(engine.getPairSnapshot('PAIR-B')?.lastProcessedCanonicalOpenTimeMs).toBe(BASE + 60_000);
    expect(engine.getPairSnapshot('PAIR-A')?.lastProcessedCanonicalOpenTimeMs).toBeNull();
    gate.resolve(); await started; await flushQueues();
    expect(engine.getPairSnapshot('PAIR-A')?.blockReason).toBeNull();
    expect(engine.getPairSnapshot('PAIR-B')?.blockReason).toBeNull();
    expect(engine.getPairSnapshot('PAIR-B')?.lastProcessedCanonicalOpenTimeMs).toBe(BASE + 60_000);
    expect(emitted).toEqual([{ pair: 'PAIR-B', start: BASE }]); engine.stop();
  });
});
