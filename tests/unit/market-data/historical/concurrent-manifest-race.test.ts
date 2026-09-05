import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../../../src/integration/coindcx/clock';
import {
  computeDatasetId,
  HistoricalDatasetError,
  HistoricalDatasetManifest,
  HistoricalDatasetService,
  HistoricalManifestRepository,
} from '../../../../src/market-data/historical';
import {
  BASE_START_MS,
  DEFAULT_TEST_PAIR,
  makeCanonicalRange,
  MemoryCandleRepository,
} from './test-helpers';

describe('EVID-P7-02: createManifest concurrent insert-race recovery path', () => {
  const FROM_MS = BASE_START_MS;
  const TO_MS = BASE_START_MS + 3 * 60_000; // 3 minutes

  function setupServiceWithPopulatedCandles() {
    const candleRepo = new MemoryCandleRepository();
    const candles = makeCanonicalRange(3, FROM_MS, DEFAULT_TEST_PAIR);
    for (const c of candles) {
      candleRepo.rows.set(c.openTimeMs, c);
    }
    const clock = new FakeClock(TO_MS + 10 * 60_000);
    return { candleRepo, clock };
  }

  it('same-identity race: recovers idempotently, preserves existing createdAt, no overwrite, no second insert loop', async () => {
    const { candleRepo, clock } = setupServiceWithPopulatedCandles();

    let getByRangeCallCount = 0;
    let winnerManifest: HistoricalDatasetManifest | null = null;
    const winnerCreatedAt = new Date(FROM_MS - 60_000); // Created in the past by concurrent winner

    const insertSpy = vi.fn().mockImplementation(async (candidate: Omit<HistoricalDatasetManifest, 'createdAt'>) => {
      // Simulate another writer having just inserted the exact same manifest
      winnerManifest = Object.freeze({
        ...candidate,
        createdAt: winnerCreatedAt,
      });
      throw new HistoricalDatasetError('MANIFEST_CONFLICT', 'Manifest unique identity already exists');
    });

    const getByRangeSpy = vi.fn().mockImplementation(async (_pair: string, _from: number, _to: number) => {
      getByRangeCallCount++;
      if (getByRangeCallCount === 1) {
        // Initial check: manifest does not yet exist
        return null;
      }
      // Re-read after conflict: returns the winner manifest inserted by concurrent writer
      return winnerManifest;
    });

    const getByDatasetIdSpy = vi.fn().mockResolvedValue(null);

    const mockManifestRepo: HistoricalManifestRepository = {
      getByDatasetId: getByDatasetIdSpy,
      getByRange: getByRangeSpy,
      insert: insertSpy,
    };

    const service = new HistoricalDatasetService({
      reader: candleRepo,
      repository: candleRepo,
      manifests: mockManifestRepo,
      clock,
      pageMinutes: 1,
    });

    const result = await service.createManifest(DEFAULT_TEST_PAIR, FROM_MS, TO_MS);

    // 1. Service called getByRange twice: initial check (null), then re-read after race
    expect(getByRangeSpy).toHaveBeenCalledTimes(2);
    expect(getByRangeSpy).toHaveBeenNthCalledWith(1, DEFAULT_TEST_PAIR, FROM_MS, TO_MS);
    expect(getByRangeSpy).toHaveBeenNthCalledWith(2, DEFAULT_TEST_PAIR, FROM_MS, TO_MS);

    // 2. insert called exactly once (no second insert loop / no retry loop)
    expect(insertSpy).toHaveBeenCalledTimes(1);

    // 3. Result matches recomputed canonical truth and identical winner identity
    expect(result).not.toBeNull();
    expect(result.pair).toBe(DEFAULT_TEST_PAIR);
    expect(result.fromInclusiveMs).toBe(FROM_MS);
    expect(result.toExclusiveMs).toBe(TO_MS);
    expect(result.expectedCandleCount).toBe(3);
    expect(result.actualCandleCount).toBe(3);
    expect(result.firstOpenTimeMs).toBe(FROM_MS);
    expect(result.lastOpenTimeMs).toBe(TO_MS - 60_000);

    const expectedDatasetId = computeDatasetId(DEFAULT_TEST_PAIR, { fromInclusiveMs: FROM_MS, toExclusiveMs: TO_MS }, result.contentSha256);
    expect(result.datasetId).toBe(expectedDatasetId);

    // 4. Winner's existing createdAt is preserved (not overwritten by caller's current time)
    expect(result.createdAt).toBe(winnerCreatedAt);

    // 5. No overwrite or update called
    expect((mockManifestRepo as unknown as Record<string, unknown>).update).toBeUndefined();
    expect((mockManifestRepo as unknown as Record<string, unknown>).upsert).toBeUndefined();
  });

  describe('conflict variants: mismatching winner remains fail closed', () => {
    it('different contentSha256 and datasetId after race fails closed with MANIFEST_CONFLICT', async () => {
      const { candleRepo, clock } = setupServiceWithPopulatedCandles();

      let getByRangeCallCount = 0;
      const conflictingSha = 'e'.repeat(64);

      const mockManifestRepo: HistoricalManifestRepository = {
        getByDatasetId: vi.fn().mockResolvedValue(null),
        getByRange: vi.fn().mockImplementation(async (pair: string, from: number, to: number) => {
          getByRangeCallCount++;
          if (getByRangeCallCount === 1) return null;
          // Concurrent winner stored a DIFFERENT content hash
          return Object.freeze({
            datasetId: computeDatasetId(pair, { fromInclusiveMs: from, toExclusiveMs: to }, conflictingSha),
            schemaVersion: 1,
            venue: 'COINDCX',
            market: 'FUTURES',
            resolutionMinutes: 1,
            pair,
            fromInclusiveMs: from,
            toExclusiveMs: to,
            expectedCandleCount: 3,
            actualCandleCount: 3,
            firstOpenTimeMs: from,
            lastOpenTimeMs: to - 60_000,
            contentSha256: conflictingSha,
            createdAt: new Date(),
          });
        }),
        insert: vi.fn().mockRejectedValue(
          new HistoricalDatasetError('MANIFEST_CONFLICT', 'Manifest unique identity already exists')
        ),
      };

      const service = new HistoricalDatasetService({
        reader: candleRepo,
        repository: candleRepo,
        manifests: mockManifestRepo,
        clock,
      });

      await expect(service.createManifest(DEFAULT_TEST_PAIR, FROM_MS, TO_MS)).rejects.toMatchObject({
        code: 'MANIFEST_CONFLICT',
        message: 'Manifest unique identity already exists',
      });

      expect(mockManifestRepo.insert).toHaveBeenCalledTimes(1);
      expect(mockManifestRepo.getByRange).toHaveBeenCalledTimes(2);
    });

    it('different candle count after race fails closed with MANIFEST_CONFLICT', async () => {
      const { candleRepo, clock } = setupServiceWithPopulatedCandles();

      let getByRangeCallCount = 0;

      const mockManifestRepo: HistoricalManifestRepository = {
        getByDatasetId: vi.fn().mockResolvedValue(null),
        getByRange: vi.fn().mockImplementation(async (pair: string, from: number, to: number) => {
          getByRangeCallCount++;
          if (getByRangeCallCount === 1) return null;
          // Concurrent winner has mismatching candle count
          return Object.freeze({
            datasetId: 'f'.repeat(64),
            schemaVersion: 1,
            venue: 'COINDCX',
            market: 'FUTURES',
            resolutionMinutes: 1,
            pair,
            fromInclusiveMs: from,
            toExclusiveMs: to,
            expectedCandleCount: 3,
            actualCandleCount: 99, // Mismatched count
            firstOpenTimeMs: from,
            lastOpenTimeMs: to - 60_000,
            contentSha256: 'a'.repeat(64),
            createdAt: new Date(),
          });
        }),
        insert: vi.fn().mockRejectedValue(
          new HistoricalDatasetError('MANIFEST_CONFLICT', 'Manifest unique identity already exists')
        ),
      };

      const service = new HistoricalDatasetService({
        reader: candleRepo,
        repository: candleRepo,
        manifests: mockManifestRepo,
        clock,
      });

      await expect(service.createManifest(DEFAULT_TEST_PAIR, FROM_MS, TO_MS)).rejects.toMatchObject({
        code: 'MANIFEST_CONFLICT',
        message: 'Manifest unique identity already exists',
      });
    });

    it('null re-read after race (racer rolled back) fails closed with MANIFEST_CONFLICT', async () => {
      const { candleRepo, clock } = setupServiceWithPopulatedCandles();

      const mockManifestRepo: HistoricalManifestRepository = {
        getByDatasetId: vi.fn().mockResolvedValue(null),
        getByRange: vi.fn().mockResolvedValue(null), // Always returns null
        insert: vi.fn().mockRejectedValue(
          new HistoricalDatasetError('MANIFEST_CONFLICT', 'Manifest unique identity already exists')
        ),
      };

      const service = new HistoricalDatasetService({
        reader: candleRepo,
        repository: candleRepo,
        manifests: mockManifestRepo,
        clock,
      });

      await expect(service.createManifest(DEFAULT_TEST_PAIR, FROM_MS, TO_MS)).rejects.toMatchObject({
        code: 'MANIFEST_CONFLICT',
        message: 'Manifest unique identity already exists',
      });
    });

    it('unexpected non-conflict insert error (e.g. DB_FAILURE) is rethrown immediately without re-read', async () => {
      const { candleRepo, clock } = setupServiceWithPopulatedCandles();

      const getByRangeSpy = vi.fn().mockResolvedValue(null);
      const insertSpy = vi.fn().mockRejectedValue(
        new HistoricalDatasetError('DB_FAILURE', 'Unable to persist historical manifest')
      );

      const mockManifestRepo: HistoricalManifestRepository = {
        getByDatasetId: vi.fn().mockResolvedValue(null),
        getByRange: getByRangeSpy,
        insert: insertSpy,
      };

      const service = new HistoricalDatasetService({
        reader: candleRepo,
        repository: candleRepo,
        manifests: mockManifestRepo,
        clock,
      });

      await expect(service.createManifest(DEFAULT_TEST_PAIR, FROM_MS, TO_MS)).rejects.toMatchObject({
        code: 'DB_FAILURE',
        message: 'Unable to persist historical manifest',
      });

      // Only initial getByRange check was performed; race recovery re-read was NOT entered
      expect(getByRangeSpy).toHaveBeenCalledTimes(1);
      expect(insertSpy).toHaveBeenCalledTimes(1);
    });
  });
});
