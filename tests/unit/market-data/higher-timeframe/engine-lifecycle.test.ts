import { describe, expect, it } from 'vitest';
import { HigherTimeframeEngine } from '../../../../src/market-data/higher-timeframe';
import { BASE, candle, deferred, FakeCanonicalEngine, flushQueues, MemoryRangeReader } from './helpers';

describe('HigherTimeframeEngine lifecycle run ownership', () => {
  it('makes start and stop idempotent, and each fresh run owns a fresh Phase 5 subscription', async () => {
    const source = new FakeCanonicalEngine();
    const reader = new MemoryRangeReader();
    source.setHealth('PAIR-A'); reader.add(candle('PAIR-A', 0));
    const engine = new HigherTimeframeEngine({ canonicalEngine: source, rangeReader: reader, pairs: ['PAIR-A'], timeframes: [2] });
    const first = engine.start();
    const second = engine.start();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    await engine.start();
    expect(source.subscriptionCount).toBe(1);
    engine.stop(); engine.stop();
    expect(source.unsubscribeCount).toBe(1);
    await engine.start();
    expect(source.subscriptionCount).toBe(2);
    engine.stop();
  });

  it('invalidates stale hydration after stop/start without permitting stale state or publication', async () => {
    const source = new FakeCanonicalEngine();
    const reader = new MemoryRangeReader();
    source.setHealth('PAIR-A'); reader.add(candle('PAIR-A', 0));
    const oldLatest = deferred<void>();
    let firstLatest = true;
    reader.latestGate = async () => { if (firstLatest) { firstLatest = false; await oldLatest.promise; } };
    const engine = new HigherTimeframeEngine({ canonicalEngine: source, rangeReader: reader, pairs: ['PAIR-A'], timeframes: [2] });
    const events: number[] = [];
    engine.subscribe((event) => events.push(event.bucketStartMs));
    const oldStart = engine.start();
    await flushQueues();
    engine.stop();
    const newStart = engine.start();
    await newStart;
    reader.add(candle('PAIR-A', 1));
    source.emit(candle('PAIR-A', 1));
    await flushQueues();
    expect(events).toEqual([BASE]);
    oldLatest.resolve();
    await oldStart;
    await flushQueues();
    expect(engine.getPairSnapshot('PAIR-A')).toMatchObject({ operationalState: 'READY', lastProcessedCanonicalOpenTimeMs: BASE + 60_000 });
    expect(events).toEqual([BASE]);
    engine.stop();
  });

  it('invalidates a stale pending resync completion after stop/start', async () => {
    const source = new FakeCanonicalEngine();
    const reader = new MemoryRangeReader();
    source.setHealth('PAIR-A'); reader.add(candle('PAIR-A', 0));
    const engine = new HigherTimeframeEngine({ canonicalEngine: source, rangeReader: reader, pairs: ['PAIR-A'], timeframes: [2] });
    const events: number[] = [];
    engine.subscribe((event) => events.push(event.bucketStartMs));
    await engine.start();
    source.setHealth('PAIR-A', { state: 'STALE' }); source.emit(candle('PAIR-A', 1)); await flushQueues();
    reader.add(candle('PAIR-A', 1));
    const gate = deferred<void>(); reader.rangeGate = async () => gate.promise;
    source.setHealth('PAIR-A'); source.emit(candle('PAIR-A', 1)); await flushQueues();
    expect(engine.getPairSnapshot('PAIR-A')?.operationalState).toBe('RESYNCING');
    engine.stop();
    reader.rangeGate = null;
    const restart = engine.start();
    await restart;
    gate.resolve(); await flushQueues();
    expect(engine.getPairSnapshot('PAIR-A')).toMatchObject({ operationalState: 'READY', lastProcessedCanonicalOpenTimeMs: BASE + 60_000 });
    expect(events).toEqual([]);
    engine.stop();
  });
});
