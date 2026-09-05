import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../../../src/integration/coindcx/clock';
import { CanonicalDecimal } from '../../../../src/market-data/canonical-decimal';
import {
  BackfillProgress,
  HistoricalBackfillService,
  HistoricalRestCandleRecord,
  HistoricalRestReader,
} from '../../../../src/market-data/historical';
import {
  BASE_START_MS,
  DEFAULT_TEST_PAIR,
  makeTestCandle,
  MemoryCandleRepository,
} from './test-helpers';

describe('EVID-P7-03: HistoricalBackfillService DB_FAILURE / REST_FAILURE translation and onProgress', () => {
  const PAIR = DEFAULT_TEST_PAIR;
  const T0 = BASE_START_MS;
  const MIN = 60_000;

  function makeRestCandle(openTimeMs: number): HistoricalRestCandleRecord {
    return {
      pair: PAIR,
      openTimeMs,
      open: CanonicalDecimal.from('100.00'),
      high: CanonicalDecimal.from('110.00'),
      low: CanonicalDecimal.from('95.00'),
      close: CanonicalDecimal.from('105.00'),
      volume: CanonicalDecimal.from('10.00'),
      quoteVolume: null,
    };
  }

  describe('EVID-P7-03A: BACKFILL DB_FAILURE', () => {
    it('translates initial chunk getRange reader error to DB_FAILURE with zero REST calls, zero inserts, and zero onProgress', async () => {
      const store = new MemoryCandleRepository();
      vi.spyOn(store, 'getRange').mockRejectedValue(new Error('Connection lost to DB'));
      const insertSpy = vi.spyOn(store, 'insertCandle');

      const restFetchSpy = vi.fn();
      const mockRestReader: HistoricalRestReader = {
        fetchClosedCandles: restFetchSpy,
      };

      const progressSpy = vi.fn();
      const clock = new FakeClock(T0 + 10 * MIN);

      const service = new HistoricalBackfillService({
        reader: store,
        repository: store,
        restReader: mockRestReader,
        clock,
      });

      await expect(
        service.backfill(
          { pair: PAIR, fromInclusiveMs: T0, toExclusiveMs: T0 + 2 * MIN, chunkMinutes: 2 },
          progressSpy
        )
      ).rejects.toMatchObject({
        code: 'DB_FAILURE',
        message: 'Unable to read backfill chunk',
      });

      // Assert no side effects occurred:
      // No REST call if DB read fails before missing spans are known
      expect(restFetchSpy).not.toHaveBeenCalled();
      // No canonical insert
      expect(insertSpy).not.toHaveBeenCalled();
      // No progress callback claiming completed chunk
      expect(progressSpy).not.toHaveBeenCalled();
    });

    it('translates final chunk verification getRange failure to DB_FAILURE and emits no onProgress for the failed chunk', async () => {
      const store = new MemoryCandleRepository();
      let callCount = 0;
      const getRangeSpy = vi.spyOn(store, 'getRange').mockImplementation(async (_pair, _from, _to) => {
        callCount++;
        if (callCount === 1) {
          // Initial read: DB is empty, so missing span is entire chunk
          return [];
        }
        // Second call is from verifyCanonicalRange after inserts: simulate DB failure
        throw new Error('Verification read disk error');
      });

      const restFetchSpy = vi.fn().mockResolvedValue([makeRestCandle(T0), makeRestCandle(T0 + MIN)]);
      const mockRestReader: HistoricalRestReader = {
        fetchClosedCandles: restFetchSpy,
      };

      const progressSpy = vi.fn();
      const clock = new FakeClock(T0 + 10 * MIN);

      const service = new HistoricalBackfillService({
        reader: store,
        repository: store,
        restReader: mockRestReader,
        clock,
      });

      await expect(
        service.backfill(
          { pair: PAIR, fromInclusiveMs: T0, toExclusiveMs: T0 + 2 * MIN, chunkMinutes: 2 },
          progressSpy
        )
      ).rejects.toMatchObject({
        code: 'DB_FAILURE',
        message: 'Unable to read canonical range',
      });

      // Initial read + verify read were attempted
      expect(getRangeSpy).toHaveBeenCalledTimes(2);
      // REST was called for the missing span
      expect(restFetchSpy).toHaveBeenCalledTimes(1);
      // But verify failed, so onProgress was NOT emitted for this chunk
      expect(progressSpy).not.toHaveBeenCalled();
    });
  });

  describe('EVID-P7-03B: BACKFILL REST_FAILURE', () => {
    it('translates REST reader failure to REST_FAILURE, performs no inserts, emits no onProgress, and produces no synthetic candles', async () => {
      const store = new MemoryCandleRepository();
      // Initial DB read succeeds and finds 0 candles (entire 2-minute span missing)
      const insertSpy = vi.spyOn(store, 'insertCandle');

      const restFetchSpy = vi.fn().mockRejectedValue(new Error('CoinDCX REST HTTP 502 Bad Gateway'));
      const mockRestReader: HistoricalRestReader = {
        fetchClosedCandles: restFetchSpy,
      };

      const progressSpy = vi.fn();
      const clock = new FakeClock(T0 + 10 * MIN);

      const service = new HistoricalBackfillService({
        reader: store,
        repository: store,
        restReader: mockRestReader,
        clock,
      });

      await expect(
        service.backfill(
          { pair: PAIR, fromInclusiveMs: T0, toExclusiveMs: T0 + 2 * MIN, chunkMinutes: 2 },
          progressSpy
        )
      ).rejects.toMatchObject({
        code: 'REST_FAILURE',
        message: 'Historical REST request failed',
      });

      // REST fetch was attempted for missing span
      expect(restFetchSpy).toHaveBeenCalledTimes(1);
      expect(restFetchSpy).toHaveBeenCalledWith({
        pair: PAIR,
        fromMs: T0,
        toMs: T0 + MIN,
      });

      // No inserts / no synthetic candles written to store
      expect(insertSpy).not.toHaveBeenCalled();
      expect(store.rows.size).toBe(0);

      // Chunk not reported completed
      expect(progressSpy).not.toHaveBeenCalled();
    });
  });

  describe('EVID-P7-03C: onProgress callback contract and monotonicity', () => {
    it('emits onProgress with exact type contract in monotonic chronological chunk order for multi-chunk backfill', async () => {
      const store = new MemoryCandleRepository();

      // Chunk 0: [T0, T0 + 2*MIN] -> DB has candle at T0, missing candle at T0 + MIN
      await store.insertCandle(makeTestCandle({ pair: PAIR, openTimeMs: T0 }));

      // Chunk 1: [T0 + 2*MIN, T0 + 4*MIN] -> DB already has both candles (complete chunk, REST skipped)
      await store.insertCandle(makeTestCandle({ pair: PAIR, openTimeMs: T0 + 2 * MIN }));
      await store.insertCandle(makeTestCandle({ pair: PAIR, openTimeMs: T0 + 3 * MIN }));

      // Chunk 2: [T0 + 4*MIN, T0 + 6*MIN] -> DB has 0 candles, missing both

      const restFetchSpy = vi.fn().mockImplementation(async ({ fromMs, toMs }: { fromMs: number; toMs: number }) => {
        const records: HistoricalRestCandleRecord[] = [];
        for (let t = fromMs; t <= toMs; t += MIN) {
          records.push(makeRestCandle(t));
        }
        return records;
      });

      const mockRestReader: HistoricalRestReader = {
        fetchClosedCandles: restFetchSpy,
      };

      const progressEvents: BackfillProgress[] = [];
      const clock = new FakeClock(T0 + 20 * MIN);

      const service = new HistoricalBackfillService({
        reader: store,
        repository: store,
        restReader: mockRestReader,
        clock,
      });

      const summary = await service.backfill(
        { pair: PAIR, fromInclusiveMs: T0, toExclusiveMs: T0 + 6 * MIN, chunkMinutes: 2 },
        (progress) => progressEvents.push(progress)
      );

      // Summary assertions
      expect(summary).toEqual({
        pair: PAIR,
        fromInclusiveMs: T0,
        toExclusiveMs: T0 + 6 * MIN,
        totalCandles: 6,
        insertedCount: 3, // 1 from chunk 0, 0 from chunk 1, 2 from chunk 2
        existingCount: 3, // 1 from chunk 0, 2 from chunk 1, 0 from chunk 2
      });

      // Monotonic chronological chunk index order: 0, 1, 2
      expect(progressEvents.map((p) => p.chunkIndex)).toEqual([0, 1, 2]);
      expect(progressEvents).toHaveLength(3);

      // Exact contract verification:
      // Chunk 0: 1 in DB, 1 fetched from REST
      expect(progressEvents[0]).toEqual({
        pair: PAIR,
        chunkIndex: 0,
        totalChunks: 3,
        currentChunkStartMs: T0,
        currentChunkEndMs: T0 + 2 * MIN,
        candlesFetchedFromRest: 1,
        candlesAlreadyInDb: 1,
      });

      // Chunk 1: completely in DB, skipped REST entirely
      expect(progressEvents[1]).toEqual({
        pair: PAIR,
        chunkIndex: 1,
        totalChunks: 3,
        currentChunkStartMs: T0 + 2 * MIN,
        currentChunkEndMs: T0 + 4 * MIN,
        candlesFetchedFromRest: 0,
        candlesAlreadyInDb: 2,
      });

      // Chunk 2: 0 in DB, 2 fetched from REST
      expect(progressEvents[2]).toEqual({
        pair: PAIR,
        chunkIndex: 2,
        totalChunks: 3,
        currentChunkStartMs: T0 + 4 * MIN,
        currentChunkEndMs: T0 + 6 * MIN,
        candlesFetchedFromRest: 2,
        candlesAlreadyInDb: 0,
      });

      // Verify REST was called only for chunk 0 and chunk 2 (chunk 1 was skipped)
      expect(restFetchSpy).toHaveBeenCalledTimes(2);
      expect(restFetchSpy).toHaveBeenNthCalledWith(1, { pair: PAIR, fromMs: T0 + MIN, toMs: T0 + MIN });
      expect(restFetchSpy).toHaveBeenNthCalledWith(2, { pair: PAIR, fromMs: T0 + 4 * MIN, toMs: T0 + 5 * MIN });
    });

    it('does not emit false successful completion after a failure in a later chunk', async () => {
      const store = new MemoryCandleRepository();

      // Chunk 0 ([T0, T0 + 2*MIN]): DB has both candles (succeeds)
      await store.insertCandle(makeTestCandle({ pair: PAIR, openTimeMs: T0 }));
      await store.insertCandle(makeTestCandle({ pair: PAIR, openTimeMs: T0 + MIN }));

      // Chunk 1 ([T0 + 2*MIN, T0 + 4*MIN]): DB empty, REST throws
      const mockRestReader: HistoricalRestReader = {
        fetchClosedCandles: vi.fn().mockRejectedValue(new Error('REST timeout during chunk 1')),
      };

      const progressEvents: BackfillProgress[] = [];
      const clock = new FakeClock(T0 + 20 * MIN);

      const service = new HistoricalBackfillService({
        reader: store,
        repository: store,
        restReader: mockRestReader,
        clock,
      });

      await expect(
        service.backfill(
          { pair: PAIR, fromInclusiveMs: T0, toExclusiveMs: T0 + 6 * MIN, chunkMinutes: 2 },
          (p) => progressEvents.push(p)
        )
      ).rejects.toMatchObject({
        code: 'REST_FAILURE',
      });

      // Only chunk 0 succeeded and reported progress; chunk 1 and chunk 2 did NOT emit progress
      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0]?.chunkIndex).toBe(0);
    });

    it('does not emit false successful completion when DB read fails on a second chunk', async () => {
      const store = new MemoryCandleRepository();

      // Chunk 0: DB has candles
      await store.insertCandle(makeTestCandle({ pair: PAIR, openTimeMs: T0 }));
      await store.insertCandle(makeTestCandle({ pair: PAIR, openTimeMs: T0 + MIN }));

      let chunkGetRangeCount = 0;
      const originalGetRange = store.getRange.bind(store);
      vi.spyOn(store, 'getRange').mockImplementation(async (pair, from, to) => {
        chunkGetRangeCount++;
        // First 2 calls are for chunk 0 (initial read + verify range)
        if (chunkGetRangeCount <= 2) {
          return originalGetRange(pair, from, to);
        }
        // 3rd call is for chunk 1: fail DB read
        throw new Error('Database read crash on chunk 1');
      });

      const mockRestReader: HistoricalRestReader = {
        fetchClosedCandles: vi.fn(),
      };

      const progressEvents: BackfillProgress[] = [];
      const clock = new FakeClock(T0 + 20 * MIN);

      const service = new HistoricalBackfillService({
        reader: store,
        repository: store,
        restReader: mockRestReader,
        clock,
      });

      await expect(
        service.backfill(
          { pair: PAIR, fromInclusiveMs: T0, toExclusiveMs: T0 + 4 * MIN, chunkMinutes: 2 },
          (p) => progressEvents.push(p)
        )
      ).rejects.toMatchObject({
        code: 'DB_FAILURE',
      });

      // Only chunk 0 emitted progress; chunk 1 did not emit false completion
      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0]?.chunkIndex).toBe(0);
    });
  });
});
