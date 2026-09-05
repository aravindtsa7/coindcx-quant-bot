import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
  makeTestCandle,
} from './test-helpers';

describe('Phase 7 — Export Evidence', () => {
  it('writes manifest artifact and canonical NDJSON with exact ordering, decimal precision, null quoteVolume, and no provenance', async () => {
    const candleRepo = new MemoryCandleRepository();
    const manifestRepo = new MemoryManifestRepository();
    const clock = new FakeClock(BASE_START_MS + 20 * 60_000);
    const service = new HistoricalDatasetService({
      reader: candleRepo,
      repository: candleRepo,
      manifests: manifestRepo,
      clock,
      pageMinutes: 2,
    });

    const c0 = makeTestCandle({
      openTimeMs: BASE_START_MS,
      open: '3715000.000000000000000000',
      high: '3718500.500000000000000000',
      low: '3714000.000000000000000000',
      close: '3717200.000000000000000000',
      volume: '1.452000000000000000',
      quoteVolume: null,
      source: 'WS_FINALIZED',
      generationId: 4,
      providerEventTimeMs: 1704067200500,
    });
    const c1 = makeTestCandle({
      openTimeMs: BASE_START_MS + 60_000,
      open: '3717200.000000000000000000',
      high: '3719000.000000000000000000',
      low: '3716000.000000000000000000',
      close: '3718000.000000000000000000',
      volume: '2.100000000000000000',
      quoteVolume: '7807800.000000000000000000',
      source: 'REST_HISTORICAL',
      generationId: null,
      providerEventTimeMs: null,
    });

    await candleRepo.insertCandle(c0);
    await candleRepo.insertCandle(c1);

    const manifest = await service.createManifest(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + 2 * 60_000);

    const tempDir = await mkdtemp(join(tmpdir(), 'coindcx-export-test-'));
    try {
      const exportResult = await service.exportDataset(manifest.datasetId, tempDir);

      expect(exportResult.manifestFilePath).toBe(join(tempDir, `dataset-${manifest.datasetId}.manifest.json`));
      expect(exportResult.ndjsonFilePath).toBe(join(tempDir, `dataset-${manifest.datasetId}.candles.ndjson`));

      // Read manifest artifact
      const manifestJson = JSON.parse(await readFile(exportResult.manifestFilePath, 'utf8'));
      expect(manifestJson.datasetId).toBe(manifest.datasetId);
      expect(manifestJson.contentSha256).toBe(manifest.contentSha256);
      expect(manifestJson.actualCandleCount).toBe(2);

      // Read NDJSON file
      const ndjsonText = await readFile(exportResult.ndjsonFilePath, 'utf8');
      const lines = ndjsonText.trim().split('\n');
      expect(lines).toHaveLength(2);

      const row0 = JSON.parse(lines[0]!);
      const row1 = JSON.parse(lines[1]!);

      // Ordering openTimeMs ASC
      expect(row0.openTimeMs).toBe(BASE_START_MS);
      expect(row1.openTimeMs).toBe(BASE_START_MS + 60_000);

      // Exact decimal strings preserved
      expect(row0.open).toBe('3715000.000000000000000000');
      expect(row0.high).toBe('3718500.500000000000000000');
      expect(row0.low).toBe('3714000.000000000000000000');
      expect(row0.close).toBe('3717200.000000000000000000');
      expect(row0.volume).toBe('1.452000000000000000');

      // quoteVolume null preserved as JSON null
      expect(row0.quoteVolume).toBeNull();
      expect(row1.quoteVolume).toBe('7807800.000000000000000000');

      // Strict check: no provenance or ephemeral fields in logical candle rows
      const allowedLogicalKeys = ['pair', 'openTimeMs', 'open', 'high', 'low', 'close', 'volume', 'quoteVolume'];
      expect(Object.keys(row0).sort()).toEqual(allowedLogicalKeys.sort());
      expect(Object.keys(row1).sort()).toEqual(allowedLogicalKeys.sort());

      const r0 = row0 as Record<string, unknown>;
      expect(r0.source).toBeUndefined();
      expect(r0.generationId).toBeUndefined();
      expect(r0.providerEventTimeMs).toBeUndefined();
      expect(r0.finalizedAtMs).toBeUndefined();

      // No leftover temporary files in outputDirectory
      const dirEntries = await readdir(tempDir);
      expect(dirEntries.filter((f) => f.includes('.tmp'))).toHaveLength(0);
      expect(dirEntries).toHaveLength(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails and cleans temp files when database truth does not match manifest during export', async () => {
    const candleRepo = new MemoryCandleRepository();
    const manifestRepo = new MemoryManifestRepository();
    const clock = new FakeClock(BASE_START_MS + 20 * 60_000);
    const service = new HistoricalDatasetService({
      reader: candleRepo,
      repository: candleRepo,
      manifests: manifestRepo,
      clock,
    });

    const c0 = makeTestCandle({ openTimeMs: BASE_START_MS });
    await candleRepo.insertCandle(c0);
    const manifest = await service.createManifest(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + 60_000);

    // Now tamper with DB truth after manifest creation
    candleRepo.rows.set(
      BASE_START_MS,
      makeTestCandle({
        openTimeMs: BASE_START_MS,
        high: '999.00',
        close: '888.00',
      })
    );

    const tempDir = await mkdtemp(join(tmpdir(), 'coindcx-export-fail-'));
    try {
      await expect(service.exportDataset(manifest.datasetId, tempDir)).rejects.toMatchObject({
        code: 'HASH_MISMATCH',
      });

      // Assert partial temp file was cleaned
      const entries = await readdir(tempDir);
      expect(entries.filter((f) => f.includes('.tmp'))).toHaveLength(0);
      expect(entries).toHaveLength(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
