import { describe, expect, it } from 'vitest';
import { HigherTimeframeEngine, isPhase5Eligible } from '../../../../src/market-data/higher-timeframe';
import { BASE, candle, FakeCanonicalEngine, flushQueues, health, MemoryRangeReader, truthFaults } from './helpers';

describe('HigherTimeframeEngine Phase 5 health authority', () => {
  it('uses exactly HEALTHY + NONE + recoveryRequired=false as its eligibility predicate', () => {
    expect(isPhase5Eligible(health('PAIR-A'))).toBe(true);
    for (const state of ['DEGRADED', 'STALE', 'RECOVERING', 'INVALID'] as const) expect(isPhase5Eligible(health('PAIR-A', { state }))).toBe(false);
    for (const truthFault of truthFaults) expect(isPhase5Eligible(health('PAIR-A', { truthFault }))).toBe(false);
    expect(isPhase5Eligible(health('PAIR-A', { recoveryRequired: true }))).toBe(false);
  });

  it('does not clear any Phase 5 truth fault or progress interim recovery closes', async () => {
    for (const truthFault of truthFaults) {
      const source = new FakeCanonicalEngine(); const reader = new MemoryRangeReader();
      reader.add(candle('PAIR-A', 0)); source.setHealth('PAIR-A');
      const engine = new HigherTimeframeEngine({ canonicalEngine: source, rangeReader: reader, pairs: ['PAIR-A'], timeframes: [2] });
      const events: unknown[] = []; engine.subscribe((event) => events.push(event)); await engine.start();
      source.setHealth('PAIR-A', { truthFault, state: 'DEGRADED' }); source.emit(candle('PAIR-A', 1)); await flushQueues();
      expect(engine.getPairSnapshot('PAIR-A')?.operationalState).toBe('BLOCKED'); expect(events).toEqual([]);
      expect(source.getPairHealth('PAIR-A')?.truthFault).toBe(truthFault);
      engine.stop();
    }
    for (const partial of [{ state: 'RECOVERING' as const }, { recoveryRequired: true }]) {
      const source = new FakeCanonicalEngine(); const reader = new MemoryRangeReader();
      reader.add(candle('PAIR-A', 0)); source.setHealth('PAIR-A');
      const engine = new HigherTimeframeEngine({ canonicalEngine: source, rangeReader: reader, pairs: ['PAIR-A'], timeframes: [2] });
      const events: unknown[] = []; engine.subscribe((event) => events.push(event)); await engine.start();
      source.setHealth('PAIR-A', partial); source.emit(candle('PAIR-A', 1, { source: 'REST_RECOVERY' })); await flushQueues();
      expect(events).toEqual([]); expect(engine.getPairSnapshot('PAIR-A')?.operationalState).toBe('BLOCKED'); engine.stop();
    }
  });

  it('requires authoritative resync after a fault-free DEGRADED -> HEALTHY transition', async () => {
    const source = new FakeCanonicalEngine(); const reader = new MemoryRangeReader();
    source.setHealth('PAIR-A'); reader.add(candle('PAIR-A', 0));
    const engine = new HigherTimeframeEngine({ canonicalEngine: source, rangeReader: reader, pairs: ['PAIR-A'], timeframes: [2] });
    const events: unknown[] = []; engine.subscribe((event) => events.push(event)); await engine.start();
    source.setHealth('PAIR-A', { state: 'DEGRADED' }); source.emit(candle('PAIR-A', 1)); await flushQueues();
    reader.add(candle('PAIR-A', 1)); source.setHealth('PAIR-A'); source.emit(candle('PAIR-A', 1)); await flushQueues();
    expect(engine.getPairSnapshot('PAIR-A')).toMatchObject({ operationalState: 'READY', lastProcessedCanonicalOpenTimeMs: BASE + 60_000 });
    expect(events).toHaveLength(1);
    engine.stop();
  });

  it('fails closed at the same DB high watermark and makes progress only when T+1 is persisted', async () => {
    const source = new FakeCanonicalEngine(); const reader = new MemoryRangeReader();
    source.setHealth('PAIR-A'); reader.add(candle('PAIR-A', 0));
    const engine = new HigherTimeframeEngine({ canonicalEngine: source, rangeReader: reader, pairs: ['PAIR-A'], timeframes: [2] });
    const events: unknown[] = []; engine.subscribe((event) => events.push(event)); await engine.start();
    source.setHealth('PAIR-A', { state: 'STALE' }); source.emit(candle('PAIR-A', 1)); await flushQueues();
    source.setHealth('PAIR-A'); source.emit(candle('PAIR-A', 1)); await flushQueues();
    expect(events).toEqual([]);
    expect(engine.getPairSnapshot('PAIR-A')).toMatchObject({ operationalState: 'BLOCKED', lastProcessedCanonicalOpenTimeMs: BASE });
    reader.add(candle('PAIR-A', 1)); source.emit(candle('PAIR-A', 1)); await flushQueues();
    expect(engine.getPairSnapshot('PAIR-A')).toMatchObject({ operationalState: 'READY', lastProcessedCanonicalOpenTimeMs: BASE + 60_000 });
    expect(events).toHaveLength(1);
    engine.stop();
  });
});
