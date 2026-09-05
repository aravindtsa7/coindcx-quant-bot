import { describe, expect, it } from 'vitest';
import { HigherTimeframeEngine } from '../../../../src/market-data/higher-timeframe';
import { candle, FakeCanonicalEngine, flushQueues, MemoryRangeReader } from './helpers';

function setup(): { source: FakeCanonicalEngine; reader: MemoryRangeReader; engine: HigherTimeframeEngine } {
  const source = new FakeCanonicalEngine(); const reader = new MemoryRangeReader();
  source.setHealth('PAIR-A'); reader.add(candle('PAIR-A', 0));
  return { source, reader, engine: new HigherTimeframeEngine({ canonicalEngine: source, rangeReader: reader, pairs: ['PAIR-A'], timeframes: [2] }) };
}

describe('HigherTimeframeEngine subscriber isolation and snapshot dispatch', () => {
  it('isolates throwing recipients and keeps later pair queue work usable', async () => {
    const { source, reader, engine } = setup(); const received: number[] = [];
    engine.subscribe(() => { throw new Error('downstream failure'); }); engine.subscribe((event) => received.push(event.bucketStartMs));
    await engine.start(); reader.add(candle('PAIR-A', 1)); source.emit(candle('PAIR-A', 1)); await flushQueues();
    reader.add(candle('PAIR-A', 2), candle('PAIR-A', 3)); source.emit(candle('PAIR-A', 2)); source.emit(candle('PAIR-A', 3)); await flushQueues();
    expect(received).toHaveLength(2); expect(engine.getPairSnapshot('PAIR-A')?.operationalState).toBe('READY'); engine.stop();
  });

  it('takes a recipient snapshot: additions apply to the next event and removals do not corrupt dispatch', async () => {
    const { source, reader, engine } = setup(); const received: string[] = [];
    let removeB: () => void = () => {};
    engine.subscribe(() => { received.push('A'); engine.subscribe(() => received.push('C')); removeB(); });
    removeB = engine.subscribe(() => received.push('B'));
    await engine.start(); reader.add(candle('PAIR-A', 1)); source.emit(candle('PAIR-A', 1)); await flushQueues();
    expect(received).toEqual(['A', 'B']);
    reader.add(candle('PAIR-A', 2), candle('PAIR-A', 3)); source.emit(candle('PAIR-A', 2)); source.emit(candle('PAIR-A', 3)); await flushQueues();
    expect(received).toEqual(['A', 'B', 'A', 'C']);
    engine.stop();
  });

  it('synchronous stop during dispatch invalidates remaining snapshotted recipients and permits restart', async () => {
    const { source, reader, engine } = setup(); const received: string[] = [];
    const removeStopper = engine.subscribe(() => { received.push('stopper'); engine.stop(); });
    engine.subscribe(() => received.push('later'));
    await engine.start(); reader.add(candle('PAIR-A', 1)); source.emit(candle('PAIR-A', 1)); await flushQueues();
    expect(received).toEqual(['stopper']); expect(engine.lifecycleState).toBe('STOPPED'); removeStopper();
    await engine.start(); reader.add(candle('PAIR-A', 2), candle('PAIR-A', 3)); source.emit(candle('PAIR-A', 2)); source.emit(candle('PAIR-A', 3)); await flushQueues();
    expect(engine.lifecycleState).toBe('RUNNING'); engine.stop();
  });
});
