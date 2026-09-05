import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../../src/integration/coindcx/clock';
import { createCanonicalCandle1m } from '../../../../src/market-data/models';
import { Candle1mRepository, InsertCandleResult } from '../../../../src/market-data/persistence/candle-repository';
import { CanonicalCandle1m } from '../../../../src/market-data/types';
import {
  canonicalHashDecimal, computeDatasetId, encodeHistoricalLogicalRow, findMissingMinuteSpans,
  HistoricalBackfillService, HistoricalDatasetError, planHistoricalChunks, validateHistoricalPair,
  validateHistoricalRange,
} from '../../../../src/market-data/historical';

const START = 1700000040000;
const PAIR = 'B-BTC_USDT';
function candle(openTimeMs: number): CanonicalCandle1m {
  return createCanonicalCandle1m({ pair: PAIR, openTimeMs, open: '1.00', high: '2.0', low: '1', close: '1.5', volume: '3.000', quoteVolume: null, source: 'WS_FINALIZED', finalizedAtMs: openTimeMs + 60_000, providerEventTimeMs: null, generationId: null });
}
class MemoryStore implements Candle1mRepository {
  readonly rows = new Map<number, CanonicalCandle1m>();
  public async insertCandle(value: CanonicalCandle1m): Promise<InsertCandleResult> { const old = this.rows.get(value.openTimeMs); if (old) return { outcome: 'ALREADY_IDENTICAL' }; this.rows.set(value.openTimeMs, value); return { outcome: 'INSERTED' }; }
  public async getLatestCanonicalCandle(): Promise<CanonicalCandle1m | null> { return null; }
  public async getCandle(_pair: string, openTimeMs: number): Promise<CanonicalCandle1m | null> { return this.rows.get(openTimeMs) ?? null; }
  public async getRange(_pair: string, from: number, to: number): Promise<readonly CanonicalCandle1m[]> { return [...this.rows.values()].filter((row) => row.openTimeMs >= from && row.openTimeMs <= to).sort((a, b) => a.openTimeMs - b.openTimeMs); }
}

describe('Phase 7 historical primitives', () => {
  it('rejects noncanonical pairs and current/forming ranges', () => {
    expect(() => validateHistoricalPair('b-btc_usdt')).toThrow(HistoricalDatasetError);
    expect(() => validateHistoricalPair('B|BTC')).toThrow(HistoricalDatasetError);
    expect(() => validateHistoricalRange({ fromInclusiveMs: START, toExclusiveMs: START + 60_000 }, new FakeClock(START + 1))).toThrow(HistoricalDatasetError);
  });
  it('plans exact half-open chunks and minimal missing spans', () => {
    expect(planHistoricalChunks({ fromInclusiveMs: START, toExclusiveMs: START + 5 * 60_000 }, 2)).toEqual([
      { fromInclusiveMs: START, toExclusiveMs: START + 2 * 60_000 }, { fromInclusiveMs: START + 2 * 60_000, toExclusiveMs: START + 4 * 60_000 }, { fromInclusiveMs: START + 4 * 60_000, toExclusiveMs: START + 5 * 60_000 },
    ]);
    expect(findMissingMinuteSpans(PAIR, { fromInclusiveMs: START, toExclusiveMs: START + 5 * 60_000 }, [candle(START), candle(START + 60_000), candle(START + 4 * 60_000)])).toEqual([{ fromInclusiveMs: START + 2 * 60_000, toExclusiveMs: START + 4 * 60_000 }]);
  });
  it('normalizes hash decimals textually and encodes LF-only logical rows', () => {
    expect(canonicalHashDecimal('001.200')).toBe('1.2'); expect(canonicalHashDecimal('-0.000')).toBe('0'); expect(canonicalHashDecimal('0.123456789012345678')).toBe('0.123456789012345678');
    expect(encodeHistoricalLogicalRow(candle(START)).toString('utf8')).toBe(`${PAIR}|${START}|1|2|1|1.5|3|N\n`);
    expect(computeDatasetId(PAIR, { fromInclusiveMs: START, toExclusiveMs: START + 60_000 }, '0'.repeat(64))).toHaveLength(64);
  });
  it('backfills only missing spans, uses exact inclusive REST end, and is resumable', async () => {
    const store = new MemoryStore(); store.rows.set(START, candle(START));
    const calls: Array<{ fromMs: number; toMs: number }> = [];
    const service = new HistoricalBackfillService({ reader: store, repository: store, clock: new FakeClock(START + 10 * 60_000), restReader: { async fetchClosedCandles(query) { calls.push(query); return [candle(START + 60_000), candle(START + 2 * 60_000)].map((row) => ({ ...row, quoteVolume: null })); } } });
    await service.backfill({ pair: PAIR, fromInclusiveMs: START, toExclusiveMs: START + 3 * 60_000, chunkMinutes: 3 });
    expect(calls).toEqual([{ pair: PAIR, fromMs: START + 60_000, toMs: START + 2 * 60_000 }]);
    await service.backfill({ pair: PAIR, fromInclusiveMs: START, toExclusiveMs: START + 3 * 60_000, chunkMinutes: 3 });
    expect(calls).toHaveLength(1);
  });
  it('fails closed when REST omits a requested minute', async () => {
    const store = new MemoryStore();
    const service = new HistoricalBackfillService({ reader: store, repository: store, clock: new FakeClock(START + 10 * 60_000), restReader: { async fetchClosedCandles() { return [candle(START)]; } } });
    await expect(service.backfill({ pair: PAIR, fromInclusiveMs: START, toExclusiveMs: START + 2 * 60_000 })).rejects.toMatchObject({ code: 'REST_INCOMPLETE' });
  });
});
