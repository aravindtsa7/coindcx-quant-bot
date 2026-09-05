import { describe, expect, it } from 'vitest';
import { HigherTimeframeEngine } from '../../../../src/market-data/higher-timeframe';
import { BASE, candle, deferred, FakeCanonicalEngine, flushQueues, MemoryRangeReader } from './helpers';

describe('HigherTimeframeEngine authoritative resync/live serialization', () => {
  it('treats DB-covered live overlap idempotently and detects old duplicate truth conflicts', async () => {
    const source = new FakeCanonicalEngine(); const reader = new MemoryRangeReader();
    source.setHealth('PAIR-A'); reader.add(candle('PAIR-A', 0));
    const engine = new HigherTimeframeEngine({ canonicalEngine: source, rangeReader: reader, pairs: ['PAIR-A'], timeframes: [2] });
    const starts: number[] = []; engine.subscribe((event) => starts.push(event.bucketStartMs)); await engine.start();
    source.setHealth('PAIR-A', { state: 'STALE' }); source.emit(candle('PAIR-A', 1)); await flushQueues();
    reader.add(candle('PAIR-A', 1));
    const gate = deferred<void>(); reader.rangeGate = async () => gate.promise;
    source.setHealth('PAIR-A'); source.emit(candle('PAIR-A', 1)); await flushQueues();
    expect(engine.getPairSnapshot('PAIR-A')?.operationalState).toBe('RESYNCING');
    source.emit(candle('PAIR-A', 1)); // DB-covered overlap queues behind resync
    gate.resolve(); await flushQueues();
    expect(starts).toEqual([BASE]);
    expect(engine.getPairSnapshot('PAIR-A')).toMatchObject({ operationalState: 'READY', lastProcessedCanonicalOpenTimeMs: BASE + 60_000 });
    source.emit(candle('PAIR-A', 1, { high: '999', close: '998' })); await flushQueues();
    expect(engine.getPairSnapshot('PAIR-A')?.operationalState).toBe('BLOCKED');
    expect(starts).toEqual([BASE]);
    engine.stop();
  });

  it('queues above-high-watermark live truth behind resync and preserves chronological publication', async () => {
    const source = new FakeCanonicalEngine(); const reader = new MemoryRangeReader();
    source.setHealth('PAIR-A'); reader.add(candle('PAIR-A', 0));
    const engine = new HigherTimeframeEngine({ canonicalEngine: source, rangeReader: reader, pairs: ['PAIR-A'], timeframes: [2] });
    const starts: number[] = []; engine.subscribe((event) => starts.push(event.bucketStartMs)); await engine.start();
    source.setHealth('PAIR-A', { state: 'STALE' }); source.emit(candle('PAIR-A', 1)); await flushQueues();
    reader.add(candle('PAIR-A', 1)); const gate = deferred<void>(); reader.rangeGate = async () => gate.promise;
    source.setHealth('PAIR-A'); source.emit(candle('PAIR-A', 1)); await flushQueues();
    reader.add(candle('PAIR-A', 2)); source.emit(candle('PAIR-A', 2)); await flushQueues();
    expect(engine.getPairSnapshot('PAIR-A')).toMatchObject({ operationalState: 'RESYNCING', lastProcessedCanonicalOpenTimeMs: BASE });
    expect(starts).toEqual([]);
    gate.resolve(); await flushQueues();
    expect(engine.getPairSnapshot('PAIR-A')).toMatchObject({ operationalState: 'READY', lastProcessedCanonicalOpenTimeMs: BASE + 2 * 60_000 });
    expect(starts).toEqual([BASE]);
    engine.stop();
  });

  it('discards staged resync work when eligibility is lost while the DB read awaits', async () => {
    const source = new FakeCanonicalEngine(); const reader = new MemoryRangeReader();
    source.setHealth('PAIR-A'); reader.add(candle('PAIR-A', 0));
    const engine = new HigherTimeframeEngine({ canonicalEngine: source, rangeReader: reader, pairs: ['PAIR-A'], timeframes: [2] });
    const events: unknown[] = []; engine.subscribe((event) => events.push(event)); await engine.start();
    source.setHealth('PAIR-A', { state: 'STALE' }); source.emit(candle('PAIR-A', 1)); await flushQueues();
    reader.add(candle('PAIR-A', 1)); const gate = deferred<void>(); reader.rangeGate = async () => gate.promise;
    source.setHealth('PAIR-A'); source.emit(candle('PAIR-A', 1)); await flushQueues();
    source.setHealth('PAIR-A', { state: 'RECOVERING', recoveryRequired: true }); gate.resolve(); await flushQueues();
    expect(events).toEqual([]); expect(engine.getPairSnapshot('PAIR-A')?.operationalState).toBe('BLOCKED'); engine.stop();
  });
});
