import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../../../../src/integration/coindcx/clock';
import {
  HistoricalDatasetService,
} from '../../../../src/market-data/historical';
import {
  BASE_START_MS,
  DEFAULT_TEST_PAIR,
  MemoryCandleRepository,
  MemoryManifestRepository,
  makeCanonicalRange,
} from './test-helpers';

describe('Phase 7 — Bounded Verification Evidence', () => {
  it('reads DB in bounded windows/pages for createManifest, verifyDataset, and exportDataset', async () => {
    const candleRepo = new MemoryCandleRepository();
    const manifestRepo = new MemoryManifestRepository();
    const clock = new FakeClock(BASE_START_MS + 20 * 60_000);
    const pageMinutes = 3; // Configured page window: 3 minutes
    const service = new HistoricalDatasetService({
      reader: candleRepo,
      repository: candleRepo,
      manifests: manifestRepo,
      clock,
      pageMinutes,
    });

    const count = 10;
    const candles = makeCanonicalRange(count, BASE_START_MS, DEFAULT_TEST_PAIR);
    for (const c of candles) await candleRepo.insertCandle(c);

    // 1. Test createManifest bounded reading
    candleRepo.getRangeCalls = [];
    const manifest = await service.createManifest(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + count * 60_000);

    expect(candleRepo.getRangeCalls.length).toBeGreaterThanOrEqual(4); // 3 + 3 + 3 + 1 = 10 minutes => 4 pages
    for (const call of candleRepo.getRangeCalls) {
      const pageSpanMinutes = (call.toInclusiveMs - call.fromInclusiveMs + 60_000) / 60_000;
      expect(pageSpanMinutes).toBeLessThanOrEqual(pageMinutes);
    }

    // 2. Test verifyDataset bounded reading
    candleRepo.getRangeCalls = [];
    const verification = await service.verifyDataset(manifest.datasetId);
    expect(verification.isValid).toBe(true);
    expect(candleRepo.getRangeCalls.length).toBeGreaterThanOrEqual(4);
    for (const call of candleRepo.getRangeCalls) {
      const pageSpanMinutes = (call.toInclusiveMs - call.fromInclusiveMs + 60_000) / 60_000;
      expect(pageSpanMinutes).toBeLessThanOrEqual(pageMinutes);
    }

    // 3. Test exportDataset bounded reading
    const tempDir = await mkdtemp(join(tmpdir(), 'coindcx-bounded-export-'));
    try {
      candleRepo.getRangeCalls = [];
      await service.exportDataset(manifest.datasetId, tempDir);
      expect(candleRepo.getRangeCalls.length).toBeGreaterThanOrEqual(4);
      for (const call of candleRepo.getRangeCalls) {
        const pageSpanMinutes = (call.toInclusiveMs - call.fromInclusiveMs + 60_000) / 60_000;
        expect(pageSpanMinutes).toBeLessThanOrEqual(pageMinutes);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('same canonical truth with different pageMinutes yields identical contentSha256 and datasetId', async () => {
    const candleRepo = new MemoryCandleRepository();
    const count = 12;
    const candles = makeCanonicalRange(count, BASE_START_MS, DEFAULT_TEST_PAIR);
    for (const c of candles) await candleRepo.insertCandle(c);

    const clock = new FakeClock(BASE_START_MS + 20 * 60_000);

    // Run with pageMinutes = 2
    const serviceP2 = new HistoricalDatasetService({
      reader: candleRepo,
      repository: candleRepo,
      manifests: new MemoryManifestRepository(),
      clock,
      pageMinutes: 2,
    });
    const manifestP2 = await serviceP2.createManifest(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + count * 60_000);

    // Run with pageMinutes = 3
    const serviceP3 = new HistoricalDatasetService({
      reader: candleRepo,
      repository: candleRepo,
      manifests: new MemoryManifestRepository(),
      clock,
      pageMinutes: 3,
    });
    const manifestP3 = await serviceP3.createManifest(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + count * 60_000);

    // Run with pageMinutes = 7
    const serviceP7 = new HistoricalDatasetService({
      reader: candleRepo,
      repository: candleRepo,
      manifests: new MemoryManifestRepository(),
      clock,
      pageMinutes: 7,
    });
    const manifestP7 = await serviceP7.createManifest(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + count * 60_000);

    expect(manifestP2.contentSha256).toBe(manifestP3.contentSha256);
    expect(manifestP3.contentSha256).toBe(manifestP7.contentSha256);
    expect(manifestP2.datasetId).toBe(manifestP3.datasetId);
    expect(manifestP3.datasetId).toBe(manifestP7.datasetId);
  });

  it('preserves continuity across normal page boundaries and tracks first/last/count exact', async () => {
    const candleRepo = new MemoryCandleRepository();
    const manifestRepo = new MemoryManifestRepository();
    const clock = new FakeClock(BASE_START_MS + 20 * 60_000);
    const count = 9; // Exactly 3 pages of 3 minutes: [0..2], [3..5], [6..8]
    const service = new HistoricalDatasetService({
      reader: candleRepo,
      repository: candleRepo,
      manifests: manifestRepo,
      clock,
      pageMinutes: 3,
    });

    const candles = makeCanonicalRange(count, BASE_START_MS, DEFAULT_TEST_PAIR);
    for (const c of candles) await candleRepo.insertCandle(c);

    const manifest = await service.createManifest(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + count * 60_000);

    expect(manifest.actualCandleCount).toBe(9);
    expect(manifest.expectedCandleCount).toBe(9);
    expect(manifest.firstOpenTimeMs).toBe(BASE_START_MS);
    expect(manifest.lastOpenTimeMs).toBe(BASE_START_MS + 8 * 60_000);
  });

  it('fails closed with DATASET_INCOMPLETE when missing minute occurs exactly at page boundary', async () => {
    const clock = new FakeClock(BASE_START_MS + 20 * 60_000);
    const pageMinutes = 3; // Pages: [0, 1, 2], [3, 4, 5]

    // Case 1: missing minute 2 (last minute of page 0)
    const repo1 = new MemoryCandleRepository();
    const service1 = new HistoricalDatasetService({
      reader: repo1,
      repository: repo1,
      manifests: new MemoryManifestRepository(),
      clock,
      pageMinutes,
    });
    const candles1 = makeCanonicalRange(6, BASE_START_MS, DEFAULT_TEST_PAIR).filter((_, idx) => idx !== 2);
    for (const c of candles1) await repo1.insertCandle(c);

    await expect(
      service1.createManifest(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + 6 * 60_000)
    ).rejects.toMatchObject({ code: 'DATASET_INCOMPLETE' });

    // Case 2: missing minute 3 (first minute of page 1)
    const repo2 = new MemoryCandleRepository();
    const service2 = new HistoricalDatasetService({
      reader: repo2,
      repository: repo2,
      manifests: new MemoryManifestRepository(),
      clock,
      pageMinutes,
    });
    const candles2 = makeCanonicalRange(6, BASE_START_MS, DEFAULT_TEST_PAIR).filter((_, idx) => idx !== 3);
    for (const c of candles2) await repo2.insertCandle(c);

    await expect(
      service2.createManifest(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + 6 * 60_000)
    ).rejects.toMatchObject({ code: 'DATASET_INCOMPLETE' });
  });
});
