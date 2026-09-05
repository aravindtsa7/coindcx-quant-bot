import { describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient, type Candle1m } from '@prisma/client';
import { createCanonicalCandle1m } from '../../../../src/market-data/models';
import { CanonicalValidationError } from '../../../../src/market-data/errors';
import { PrismaCandle1mRepository } from '../../../../src/market-data/persistence/candle-repository';
import {
  HistoricalDatasetService,
  computeDatasetId,
  encodeHistoricalLogicalRow,
} from '../../../../src/market-data/historical';
import { FakeClock } from '../../../../src/integration/coindcx/clock';
import { createHash } from 'node:crypto';
import {
  BASE_START_MS,
  DEFAULT_TEST_PAIR,
  MemoryCandleRepository,
  MemoryManifestRepository,
  makeTestCandle,
} from './test-helpers';

let trackedSnapshotDir: string | null = null;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdtemp: async (prefix: string, options?: Parameters<typeof actual.mkdtemp>[1]) => {
      const dir = await actual.mkdtemp(prefix, options);
      if (typeof prefix === 'string' && prefix.includes('coindcx-phase7-')) {
        trackedSnapshotDir = dir;
      }
      return dir;
    },
  };
});

describe('Phase 7 — Runtime Validation and Cleanup Evidence', () => {
  describe('Section 13: REST_HISTORICAL Runtime Validation', () => {
    const validParams = {
      pair: DEFAULT_TEST_PAIR,
      openTimeMs: BASE_START_MS,
      open: '100', high: '110', low: '95', close: '105', volume: '10', quoteVolume: null,
      finalizedAtMs: BASE_START_MS + 60_000,
      providerEventTimeMs: null,
      generationId: null,
    };

    it('createCanonicalCandle1m: accepts REST_HISTORICAL and rejects unknown sources at runtime', () => {
      // Accepted
      const historicalCandle = createCanonicalCandle1m({
        ...validParams,
        source: 'REST_HISTORICAL',
      });
      expect(historicalCandle.source).toBe('REST_HISTORICAL');

      const wsCandle = createCanonicalCandle1m({
        ...validParams,
        source: 'WS_FINALIZED',
      });
      expect(wsCandle.source).toBe('WS_FINALIZED');

      const recCandle = createCanonicalCandle1m({
        ...validParams,
        source: 'REST_RECOVERY',
      });
      expect(recCandle.source).toBe('REST_RECOVERY');

      // Rejected at runtime
      expect(() =>
        createCanonicalCandle1m({
          ...validParams,
          source: 'UNKNOWN_SOURCE' as unknown as 'WS_FINALIZED',
        })
      ).toThrow(CanonicalValidationError);

      expect(() =>
        createCanonicalCandle1m({
          ...validParams,
          source: 'CSV_IMPORT' as unknown as 'WS_FINALIZED',
        })
      ).toThrow(CanonicalValidationError);

      expect(() =>
        createCanonicalCandle1m({
          ...validParams,
          source: '' as unknown as 'WS_FINALIZED',
        })
      ).toThrow(CanonicalValidationError);
    });

    it('Prisma repository row mapper: accepts REST_HISTORICAL and rejects unknown persisted source strings', async () => {
      const makeRow = (source: string): Candle1m => ({
        id: 'uuid-1',
        pair: DEFAULT_TEST_PAIR,
        openTimeMs: BigInt(BASE_START_MS),
        closeTimeMs: BigInt(BASE_START_MS + 60_000),
        open: new Prisma.Decimal('100.00'),
        high: new Prisma.Decimal('110.00'),
        low: new Prisma.Decimal('95.00'),
        close: new Prisma.Decimal('105.00'),
        volume: new Prisma.Decimal('10.00'),
        quoteVolume: null,
        source,
        providerEventTimeMs: null,
        generationId: null,
        finalizedAt: new Date(BASE_START_MS + 60_000),
        createdAt: new Date(),
      });

      // 1. Persisted REST_HISTORICAL row is successfully reconstructed into CanonicalCandle1m
      const mockPrismaValid = new PrismaClient();
      vi.spyOn(mockPrismaValid.candle1m, 'findUnique').mockResolvedValue(makeRow('REST_HISTORICAL'));
      vi.spyOn(mockPrismaValid.candle1m, 'findFirst').mockResolvedValue(makeRow('REST_HISTORICAL'));
      vi.spyOn(mockPrismaValid.candle1m, 'findMany').mockResolvedValue([makeRow('REST_HISTORICAL')]);
      const repoValid = new PrismaCandle1mRepository(mockPrismaValid);
      const candle = await repoValid.getCandle(DEFAULT_TEST_PAIR, BASE_START_MS);
      expect(candle).not.toBeNull();
      expect(candle!.source).toBe('REST_HISTORICAL');

      // 2. Corrupted or unknown persisted source strings fail closed with CanonicalCandleError
      const mockPrismaCorrupt = new PrismaClient();
      vi.spyOn(mockPrismaCorrupt.candle1m, 'findUnique').mockResolvedValue(makeRow('CORRUPTED_SOURCE_STRING'));
      vi.spyOn(mockPrismaCorrupt.candle1m, 'findFirst').mockResolvedValue(makeRow('CORRUPTED_SOURCE_STRING'));
      vi.spyOn(mockPrismaCorrupt.candle1m, 'findMany').mockResolvedValue([makeRow('CORRUPTED_SOURCE_STRING')]);
      const repoCorrupt = new PrismaCandle1mRepository(mockPrismaCorrupt);
      await expect(repoCorrupt.getCandle(DEFAULT_TEST_PAIR, BASE_START_MS)).rejects.toThrow(
        /Persisted candle source 'CORRUPTED_SOURCE_STRING' is not a valid CanonicalCandleSource/
      );
      await expect(repoCorrupt.getLatestCanonicalCandle(DEFAULT_TEST_PAIR)).rejects.toThrow(
        /Persisted candle source 'CORRUPTED_SOURCE_STRING' is not a valid CanonicalCandleSource/
      );
      await expect(repoCorrupt.getRange(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + 60_000)).rejects.toThrow(
        /Persisted candle source 'CORRUPTED_SOURCE_STRING' is not a valid CanonicalCandleSource/
      );
    });
  });

  describe('Section 17: Temporary Resource Cleanup Evidence', () => {
    it('cleans temp resources on export success and failure', async () => {
      const candleRepo = new MemoryCandleRepository();
      const manifestRepo = new MemoryManifestRepository();
      const clock = new FakeClock(BASE_START_MS + 10 * 60_000);
      const service = new HistoricalDatasetService({
        reader: candleRepo,
        repository: candleRepo,
        manifests: manifestRepo,
        clock,
      });

      const c0 = makeTestCandle({ openTimeMs: BASE_START_MS });
      await candleRepo.insertCandle(c0);
      const manifest = await service.createManifest(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + 60_000);

      const tempDir = await mkdtemp(join(tmpdir(), 'coindcx-cleanup-export-'));
      try {
        // 1. Success case: temp file .tmp is cleaned, only final files remain
        await service.exportDataset(manifest.datasetId, tempDir);
        const entries = await readdir(tempDir);
        expect(entries.filter((f) => f.includes('.tmp'))).toHaveLength(0);
        expect(entries.filter((f) => f.endsWith('.manifest.json'))).toHaveLength(1);
        expect(entries.filter((f) => f.endsWith('.candles.ndjson'))).toHaveLength(1);

        // 2. Failure case: hash mismatch during streaming verification cleans partial files
        candleRepo.rows.set(
          BASE_START_MS,
          makeTestCandle({
            openTimeMs: BASE_START_MS,
            high: '999.00',
            close: '888.00',
          })
        );
        const failDir = await mkdtemp(join(tmpdir(), 'coindcx-cleanup-fail-'));
        try {
          await expect(service.exportDataset(manifest.datasetId, failDir)).rejects.toThrow();
          const failEntries = await readdir(failDir);
          expect(failEntries.filter((f) => f.includes('.tmp'))).toHaveLength(0);
          expect(failEntries).toHaveLength(0);
        } finally {
          await rm(failDir, { recursive: true, force: true });
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('cleans temp snapshot directory on import success, Pass-1 failure, and Pass-2 failure', async () => {
      const candleRepo = new MemoryCandleRepository();
      const manifestRepo = new MemoryManifestRepository();
      const clock = new FakeClock(BASE_START_MS + 10 * 60_000);
      const service = new HistoricalDatasetService({
        reader: candleRepo,
        repository: candleRepo,
        manifests: manifestRepo,
        clock,
      });

      const tempDir = await mkdtemp(join(tmpdir(), 'coindcx-cleanup-import-'));
      const manifestPath = join(tempDir, 'dataset.manifest.json');
      const ndjsonPath = join(tempDir, 'dataset.candles.ndjson');

      const c0 = makeTestCandle({ openTimeMs: BASE_START_MS });
      const rowBytes = encodeHistoricalLogicalRow(c0);
      const contentSha256 = createHash('sha256').update(rowBytes).digest('hex');
      const datasetId = computeDatasetId(DEFAULT_TEST_PAIR, { fromInclusiveMs: BASE_START_MS, toExclusiveMs: BASE_START_MS + 60_000 }, contentSha256);

      const validManifest = {
        datasetId,
        schemaVersion: 1,
        venue: 'COINDCX',
        market: 'FUTURES',
        resolutionMinutes: 1,
        pair: DEFAULT_TEST_PAIR,
        fromInclusiveMs: BASE_START_MS,
        toExclusiveMs: BASE_START_MS + 60_000,
        expectedCandleCount: 1,
        actualCandleCount: 1,
        firstOpenTimeMs: BASE_START_MS,
        lastOpenTimeMs: BASE_START_MS,
        contentSha256,
        createdAt: new Date().toISOString(),
      };

      const validNdjson = JSON.stringify({
        pair: c0.pair,
        openTimeMs: c0.openTimeMs,
        open: c0.open.value,
        high: c0.high.value,
        low: c0.low.value,
        close: c0.close.value,
        volume: c0.volume.value,
        quoteVolume: null,
      }) + '\n';

      try {
        // 1. Success case: snapshot directory is deleted in finally block
        await writeFile(manifestPath, JSON.stringify(validManifest), 'utf8');
        await writeFile(ndjsonPath, validNdjson, 'utf8');

        trackedSnapshotDir = null;
        await service.importDataset(manifestPath, ndjsonPath);
        expect(trackedSnapshotDir).not.toBeNull();
        // Assert the snapshot directory was deleted
        await expect(access(trackedSnapshotDir!)).rejects.toThrow();

        // 2. Pass-1 failure case: corrupted NDJSON
        await writeFile(ndjsonPath, '{"broken": json\n', 'utf8');
        trackedSnapshotDir = null;
        await expect(service.importDataset(manifestPath, ndjsonPath)).rejects.toThrow();
        expect(trackedSnapshotDir).not.toBeNull();
        // Assert the snapshot directory was deleted
        await expect(access(trackedSnapshotDir!)).rejects.toThrow();

        // 3. Pass-2 failure case: repository failure on insert
        await writeFile(ndjsonPath, validNdjson, 'utf8');
        candleRepo.failOnInsertPredicate = () => true;
        trackedSnapshotDir = null;
        await expect(service.importDataset(manifestPath, ndjsonPath)).rejects.toThrow();
        expect(trackedSnapshotDir).not.toBeNull();
        // Assert the snapshot directory was deleted
        await expect(access(trackedSnapshotDir!)).rejects.toThrow();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
