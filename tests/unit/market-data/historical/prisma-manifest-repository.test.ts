import { describe, expect, it, vi } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  HistoricalDatasetError,
  HistoricalDatasetManifest,
  PrismaHistoricalManifestRepository,
} from '../../../../src/market-data/historical';

describe('EVID-P7-01: PrismaHistoricalManifestRepository', () => {
  const TEST_PAIR = 'B-BTC_USDT';
  const FROM_MS = 1704067200000;
  const TO_MS = 1704067500000; // 5 minutes
  const CONTENT_SHA = 'a'.repeat(64);
  const DATASET_ID = 'b'.repeat(64);
  const CREATED_AT = new Date('2024-01-01T01:00:00.000Z');

  function makeRawDbRow(overrides?: Record<string, unknown>) {
    return {
      datasetId: DATASET_ID,
      schemaVersion: 1,
      venue: 'COINDCX',
      market: 'FUTURES',
      resolutionMinutes: 1,
      pair: TEST_PAIR,
      fromInclusiveMs: BigInt(FROM_MS),
      toExclusiveMs: BigInt(TO_MS),
      expectedCandleCount: 5,
      actualCandleCount: 5,
      firstOpenTimeMs: BigInt(FROM_MS),
      lastOpenTimeMs: BigInt(FROM_MS + 4 * 60_000),
      contentSha256: CONTENT_SHA,
      createdAt: CREATED_AT,
      ...overrides,
    };
  }

  function createCandidateManifest(): Omit<HistoricalDatasetManifest, 'createdAt'> {
    return {
      datasetId: DATASET_ID,
      schemaVersion: 1,
      venue: 'COINDCX',
      market: 'FUTURES',
      resolutionMinutes: 1,
      pair: TEST_PAIR,
      fromInclusiveMs: FROM_MS,
      toExclusiveMs: TO_MS,
      expectedCandleCount: 5,
      actualCandleCount: 5,
      firstOpenTimeMs: FROM_MS,
      lastOpenTimeMs: FROM_MS + 4 * 60_000,
      contentSha256: CONTENT_SHA,
    };
  }

  describe('A. getByDatasetId', () => {
    it('queries by exact datasetId and maps raw BigInt row correctly', async () => {
      const findUnique = vi.fn().mockResolvedValue(makeRawDbRow());
      const mockPrisma = { historicalDataset: { findUnique } } as unknown as PrismaClient;
      const repo = new PrismaHistoricalManifestRepository(mockPrisma);

      const result = await repo.getByDatasetId(DATASET_ID);

      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(findUnique).toHaveBeenCalledWith({
        where: { datasetId: DATASET_ID },
      });

      expect(result).not.toBeNull();
      expect(result).toEqual({
        datasetId: DATASET_ID,
        schemaVersion: 1,
        venue: 'COINDCX',
        market: 'FUTURES',
        resolutionMinutes: 1,
        pair: TEST_PAIR,
        fromInclusiveMs: FROM_MS,
        toExclusiveMs: TO_MS,
        expectedCandleCount: 5,
        actualCandleCount: 5,
        firstOpenTimeMs: FROM_MS,
        lastOpenTimeMs: FROM_MS + 4 * 60_000,
        contentSha256: CONTENT_SHA,
        createdAt: CREATED_AT,
      });
      // Assert BigInt fields were translated to safe JavaScript numbers
      expect(typeof result?.fromInclusiveMs).toBe('number');
      expect(typeof result?.toExclusiveMs).toBe('number');
      expect(typeof result?.firstOpenTimeMs).toBe('number');
      expect(typeof result?.lastOpenTimeMs).toBe('number');
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('returns null when datasetId row does not exist', async () => {
      const findUnique = vi.fn().mockResolvedValue(null);
      const mockPrisma = { historicalDataset: { findUnique } } as unknown as PrismaClient;
      const repo = new PrismaHistoricalManifestRepository(mockPrisma);

      const result = await repo.getByDatasetId('c'.repeat(64));

      expect(findUnique).toHaveBeenCalledWith({
        where: { datasetId: 'c'.repeat(64) },
      });
      expect(result).toBeNull();
    });
  });

  describe('B. getByRange', () => {
    it('queries by exact pair and BigInt range fields and maps row correctly', async () => {
      const findUnique = vi.fn().mockResolvedValue(makeRawDbRow());
      const mockPrisma = { historicalDataset: { findUnique } } as unknown as PrismaClient;
      const repo = new PrismaHistoricalManifestRepository(mockPrisma);

      const result = await repo.getByRange(TEST_PAIR, FROM_MS, TO_MS);

      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(findUnique).toHaveBeenCalledWith({
        where: {
          pair_fromInclusiveMs_toExclusiveMs: {
            pair: TEST_PAIR,
            fromInclusiveMs: BigInt(FROM_MS),
            toExclusiveMs: BigInt(TO_MS),
          },
        },
      });

      expect(result).not.toBeNull();
      expect(result?.pair).toBe(TEST_PAIR);
      expect(result?.fromInclusiveMs).toBe(FROM_MS);
      expect(result?.toExclusiveMs).toBe(TO_MS);
      expect(typeof result?.fromInclusiveMs).toBe('number');
      expect(typeof result?.toExclusiveMs).toBe('number');
    });

    it('returns null when range row does not exist', async () => {
      const findUnique = vi.fn().mockResolvedValue(null);
      const mockPrisma = { historicalDataset: { findUnique } } as unknown as PrismaClient;
      const repo = new PrismaHistoricalManifestRepository(mockPrisma);

      const result = await repo.getByRange(TEST_PAIR, FROM_MS, TO_MS);

      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });
  });

  describe('C. insert success', () => {
    it('writes exact manifest fields with BigInt translations and returns immutable manifest', async () => {
      const create = vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        createdAt: CREATED_AT,
      }));
      const mockPrisma = { historicalDataset: { create } } as unknown as PrismaClient;
      const repo = new PrismaHistoricalManifestRepository(mockPrisma);

      const candidate = createCandidateManifest();
      const result = await repo.insert(candidate);

      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith({
        data: {
          datasetId: candidate.datasetId,
          schemaVersion: candidate.schemaVersion,
          venue: candidate.venue,
          market: candidate.market,
          resolutionMinutes: candidate.resolutionMinutes,
          pair: candidate.pair,
          fromInclusiveMs: BigInt(candidate.fromInclusiveMs),
          toExclusiveMs: BigInt(candidate.toExclusiveMs),
          expectedCandleCount: candidate.expectedCandleCount,
          actualCandleCount: candidate.actualCandleCount,
          firstOpenTimeMs: BigInt(candidate.firstOpenTimeMs),
          lastOpenTimeMs: BigInt(candidate.lastOpenTimeMs),
          contentSha256: candidate.contentSha256,
        },
      });

      expect(result).toEqual({
        ...candidate,
        createdAt: CREATED_AT,
      });
      expect(typeof result.fromInclusiveMs).toBe('number');
      expect(typeof result.toExclusiveMs).toBe('number');
      expect(typeof result.firstOpenTimeMs).toBe('number');
      expect(typeof result.lastOpenTimeMs).toBe('number');
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  describe('D. duplicate / P2002 conflict', () => {
    it('translates Prisma P2002 unique constraint error to MANIFEST_CONFLICT without silent overwrite or upsert', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.x',
      });
      const create = vi.fn().mockRejectedValue(p2002Error);
      const mockPrisma = { historicalDataset: { create } } as unknown as PrismaClient;
      const repo = new PrismaHistoricalManifestRepository(mockPrisma);

      const candidate = createCandidateManifest();

      await expect(repo.insert(candidate)).rejects.toThrow(HistoricalDatasetError);
      await expect(repo.insert(candidate)).rejects.toMatchObject({
        code: 'MANIFEST_CONFLICT',
        message: 'Manifest unique identity already exists',
      });

      expect(create).toHaveBeenCalledTimes(2);
      expect((mockPrisma as unknown as { historicalDataset?: { upsert?: unknown } }).historicalDataset?.upsert).toBeUndefined();
    });
  });

  describe('E. corrupted persisted row rejection (mapManifest fail-closed)', () => {
    const corruptions = [
      { name: 'schemaVersion !== 1', row: makeRawDbRow({ schemaVersion: 2 }) },
      { name: 'venue !== COINDCX', row: makeRawDbRow({ venue: 'BINANCE' }) },
      { name: 'market !== FUTURES', row: makeRawDbRow({ market: 'SPOT' }) },
      { name: 'resolutionMinutes !== 1', row: makeRawDbRow({ resolutionMinutes: 5 }) },
      { name: 'malformed datasetId (not 64 hex)', row: makeRawDbRow({ datasetId: 'short-id' }) },
      { name: 'malformed contentSha256 (not 64 hex)', row: makeRawDbRow({ contentSha256: 'xyz' }) },
    ];

    for (const { name, row } of corruptions) {
      it(`getByDatasetId fails closed with MANIFEST_CONFLICT on corrupted row: ${name}`, async () => {
        const findUnique = vi.fn().mockResolvedValue(row);
        const mockPrisma = { historicalDataset: { findUnique } } as unknown as PrismaClient;
        const repo = new PrismaHistoricalManifestRepository(mockPrisma);

        await expect(repo.getByDatasetId(DATASET_ID)).rejects.toMatchObject({
          code: 'MANIFEST_CONFLICT',
          message: 'Persisted manifest is invalid',
        });
      });

      it(`getByRange fails closed with MANIFEST_CONFLICT on corrupted row: ${name}`, async () => {
        const findUnique = vi.fn().mockResolvedValue(row);
        const mockPrisma = { historicalDataset: { findUnique } } as unknown as PrismaClient;
        const repo = new PrismaHistoricalManifestRepository(mockPrisma);

        await expect(repo.getByRange(TEST_PAIR, FROM_MS, TO_MS)).rejects.toMatchObject({
          code: 'MANIFEST_CONFLICT',
          message: 'Persisted manifest is invalid',
        });
      });

      it(`insert fails closed with DB_FAILURE if returned row is corrupted: ${name}`, async () => {
        const create = vi.fn().mockResolvedValue(row);
        const mockPrisma = { historicalDataset: { create } } as unknown as PrismaClient;
        const repo = new PrismaHistoricalManifestRepository(mockPrisma);

        await expect(repo.insert(createCandidateManifest())).rejects.toMatchObject({
          code: 'DB_FAILURE',
          message: 'Unable to persist historical manifest',
        });
      });
    }
  });

  describe('F. unexpected DB errors fail closed', () => {
    it('insert translates unexpected DB error to DB_FAILURE', async () => {
      const genericError = new Error('Database connection reset');
      const create = vi.fn().mockRejectedValue(genericError);
      const mockPrisma = { historicalDataset: { create } } as unknown as PrismaClient;
      const repo = new PrismaHistoricalManifestRepository(mockPrisma);

      await expect(repo.insert(createCandidateManifest())).rejects.toMatchObject({
        code: 'DB_FAILURE',
        message: 'Unable to persist historical manifest',
      });
    });

    it('insert translates non-P2002 Prisma errors to DB_FAILURE', async () => {
      const prismaOtherError = new Prisma.PrismaClientKnownRequestError('Connection timeout', {
        code: 'P1001',
        clientVersion: '5.x',
      });
      const create = vi.fn().mockRejectedValue(prismaOtherError);
      const mockPrisma = { historicalDataset: { create } } as unknown as PrismaClient;
      const repo = new PrismaHistoricalManifestRepository(mockPrisma);

      await expect(repo.insert(createCandidateManifest())).rejects.toMatchObject({
        code: 'DB_FAILURE',
        message: 'Unable to persist historical manifest',
      });
    });

    it('getByDatasetId propagates DB error rather than returning null or swallowing', async () => {
      const dbError = new Error('Disk failure');
      const findUnique = vi.fn().mockRejectedValue(dbError);
      const mockPrisma = { historicalDataset: { findUnique } } as unknown as PrismaClient;
      const repo = new PrismaHistoricalManifestRepository(mockPrisma);

      await expect(repo.getByDatasetId(DATASET_ID)).rejects.toThrow('Disk failure');
    });

    it('getByRange propagates DB error rather than returning null or swallowing', async () => {
      const dbError = new Error('Disk failure');
      const findUnique = vi.fn().mockRejectedValue(dbError);
      const mockPrisma = { historicalDataset: { findUnique } } as unknown as PrismaClient;
      const repo = new PrismaHistoricalManifestRepository(mockPrisma);

      await expect(repo.getByRange(TEST_PAIR, FROM_MS, TO_MS)).rejects.toThrow('Disk failure');
    });
  });
});
