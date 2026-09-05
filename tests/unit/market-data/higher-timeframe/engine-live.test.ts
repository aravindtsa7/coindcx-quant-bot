import { describe, expect, it } from 'vitest';
import { CanonicalDecimal } from '../../../../src/market-data/canonical-decimal';
import { HigherTimeframeEngine, Canonical1mRangeReader, CanonicalEngineForHigherTimeframes } from '../../../../src/market-data/higher-timeframe';
import { createCanonicalCandle1m } from '../../../../src/market-data/models';
import { CanonicalCandle1m, CanonicalHealthSnapshot, CanonicalStreamEvent } from '../../../../src/market-data/types';

const BASE = 1_704_067_200_000;
function candle(minute: number): CanonicalCandle1m {
  return createCanonicalCandle1m({
    pair: 'PAIR-A', openTimeMs: BASE + minute * 60_000, open: String(10 + minute), high: String(12 + minute), low: String(9 + minute), close: String(11 + minute), volume: '1', quoteVolume: '2', source: 'WS_FINALIZED', finalizedAtMs: BASE + minute * 60_000 + 60_000, providerEventTimeMs: null, generationId: null,
  });
}
const health: CanonicalHealthSnapshot = { pair: 'PAIR-A', state: 'HEALTHY', truthFault: 'NONE', currentGenerationId: null, canonicalEpoch: 0, recoveryEpoch: 0, workingOpenTimeMs: null, latestCanonicalOpenTimeMs: null, continuityWatermarkMs: null, pendingFinalizationsCount: 0, lastValidProviderEventTimeMs: null, lastValidReceivedAtMs: null, gapCount: 0, lateDropCount: 0, duplicateCount: 0, recoveryRequired: false, bufferedLiveUpdateCount: 0 };

class FakeCanonicalEngine implements CanonicalEngineForHigherTimeframes {
  public readonly lifecycleState = 'RUNNING';
  public currentHealth: CanonicalHealthSnapshot = health;
  #listener: ((event: CanonicalStreamEvent<unknown>) => void) | null = null;
  public subscribe(listener: (event: CanonicalStreamEvent<unknown>) => void): () => void { this.#listener = listener; return () => { this.#listener = null; }; }
  public getPairHealth(): CanonicalHealthSnapshot { return this.currentHealth; }
  public emit(c: CanonicalCandle1m): void { this.#listener?.({ eventType: 'CANONICAL_1M_CLOSED', pair: c.pair, timestampMs: c.closeTimeExclusiveMs, payload: c }); }
}
class MemoryRangeReader implements Canonical1mRangeReader {
  public readonly rows: CanonicalCandle1m[] = [];
  public async getLatestCanonicalCandle(): Promise<CanonicalCandle1m | null> { return this.rows.at(-1) ?? null; }
  public async getRange(_pair: string, from: number, to: number): Promise<readonly CanonicalCandle1m[]> { return this.rows.filter((c) => c.openTimeMs >= from && c.openTimeMs <= to); }
}

describe('HigherTimeframeEngine live progression', () => {
  it('hydrates without historical replay and publishes exact live 2m close', async () => {
    const canonical = new FakeCanonicalEngine();
    const reader = new MemoryRangeReader();
    reader.rows.push(candle(0));
    const engine = new HigherTimeframeEngine({ canonicalEngine: canonical, rangeReader: reader, pairs: ['PAIR-A'], timeframes: [2] });
    const events: unknown[] = [];
    engine.subscribe((event) => events.push(event));
    await engine.start();
    expect(events).toEqual([]);
    reader.rows.push(candle(1));
    canonical.emit(candle(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toHaveLength(1);
    expect(engine.getPairSnapshot('PAIR-A')?.operationalState).toBe('READY');
    const event = events[0] as { eventTimeMs: number; candle: { high: CanonicalDecimal; volume: { value: string } } };
    expect(event.eventTimeMs).toBe(BASE + 2 * 60_000);
    expect(event.candle.high.value).toBe('13');
    expect(event.candle.volume.value).toBe('2');
  });

  it('blocks while Phase 5 is stale and resyncs authoritative DB truth when health self-heals', async () => {
    const canonical = new FakeCanonicalEngine();
    const reader = new MemoryRangeReader();
    reader.rows.push(candle(0));
    const engine = new HigherTimeframeEngine({ canonicalEngine: canonical, rangeReader: reader, pairs: ['PAIR-A'], timeframes: [2] });
    const events: unknown[] = [];
    engine.subscribe((event) => events.push(event));
    await engine.start();
    canonical.currentHealth = { ...health, state: 'STALE' };
    canonical.emit(candle(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.getPairSnapshot('PAIR-A')?.operationalState).toBe('BLOCKED');
    reader.rows.push(candle(1));
    canonical.currentHealth = health;
    canonical.emit(candle(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.getPairSnapshot('PAIR-A')?.operationalState).toBe('READY');
    expect(events).toHaveLength(1);
    expect((events[0] as { candle: { openTimeMs: number } }).candle.openTimeMs).toBe(BASE);
  });
});
