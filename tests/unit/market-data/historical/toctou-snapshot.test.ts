import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FakeClock } from '../../../../src/integration/coindcx/clock';
import {
  HistoricalDatasetService,
  computeDatasetId,
  encodeHistoricalLogicalRow,
} from '../../../../src/market-data/historical';
import {
  BASE_START_MS,
  DEFAULT_TEST_PAIR,
  MemoryCandleRepository,
  MemoryManifestRepository,
  makeTestCandle,
} from './test-helpers';

let postCopyHook: ((ndjsonPath: string) => Promise<void>) | null = null;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: async (
      src: Parameters<typeof actual.copyFile>[0],
      dest: Parameters<typeof actual.copyFile>[1],
      mode?: Parameters<typeof actual.copyFile>[2]
    ) => {
      const result = await actual.copyFile(src, dest, mode);
      if (typeof src === 'string' && postCopyHook) {
        await postCopyHook(src);
      }
      return result;
    },
  };
});

describe('Phase 7 — TOCTOU / Snapshot Isolation Evidence', () => {
  const fromMs = BASE_START_MS;
  const toMs = BASE_START_MS + 2 * 60_000;
  const count = 2;

  function createValidRows() {
    return [
      makeTestCandle({ openTimeMs: fromMs, open: '100', high: '110', low: '95', close: '105', volume: '10', quoteVolume: null }),
      makeTestCandle({ openTimeMs: fromMs + 60_000, open: '105', high: '115', low: '100', close: '110', volume: '12', quoteVolume: null }),
    ];
  }

  function setupArtifacts(rows: ReturnType<typeof createValidRows>) {
    const hash = createHash('sha256');
    for (const r of rows) hash.update(encodeHistoricalLogicalRow(r));
    const contentSha256 = hash.digest('hex');
    const datasetId = computeDatasetId(DEFAULT_TEST_PAIR, { fromInclusiveMs: fromMs, toExclusiveMs: toMs }, contentSha256);

    const manifest = {
      datasetId,
      schemaVersion: 1,
      venue: 'COINDCX',
      market: 'FUTURES',
      resolutionMinutes: 1,
      pair: DEFAULT_TEST_PAIR,
      fromInclusiveMs: fromMs,
      toExclusiveMs: toMs,
      expectedCandleCount: count,
      actualCandleCount: count,
      firstOpenTimeMs: fromMs,
      lastOpenTimeMs: toMs - 60_000,
      contentSha256,
      createdAt: new Date().toISOString(),
    };

    const ndjsonLines = rows.map((r) =>
      JSON.stringify({
        pair: r.pair,
        openTimeMs: r.openTimeMs,
        open: r.open.value,
        high: r.high.value,
        low: r.low.value,
        close: r.close.value,
        volume: r.volume.value,
        quoteVolume: r.quoteVolume ? r.quoteVolume.value : null,
      })
    );

    return { manifest, ndjsonLines, contentSha256, datasetId };
  }

  it('proves Outcome A: mutating original source NDJSON immediately after snapshot creation does not alter Pass 1 / Pass 2 import', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'coindcx-toctou-'));
    const manifestPath = join(tempDir, 'dataset.manifest.json');
    const ndjsonPath = join(tempDir, 'dataset.candles.ndjson');

    const candleRepo = new MemoryCandleRepository();
    const manifestRepo = new MemoryManifestRepository();
    const clock = new FakeClock(toMs + 10 * 60_000);
    const service = new HistoricalDatasetService({
      reader: candleRepo,
      repository: candleRepo,
      manifests: manifestRepo,
      clock,
    });

    const rows = createValidRows();
    const { manifest, ndjsonLines, datasetId } = setupArtifacts(rows);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    await writeFile(ndjsonPath, ndjsonLines.join('\n') + '\n', 'utf8');

    // Mutate the original source file immediately after snapshot copy is made
    postCopyHook = async (srcPath) => {
      if (srcPath.includes('dataset.candles.ndjson')) {
        await writeFile(srcPath, '{"pair":"B-BTC_USDT","openTimeMs":0,"malicious":true}\n', 'utf8');
      }
    };

    try {
      const importedManifest = await service.importDataset(manifestPath, ndjsonPath);

      // Successfully imported original verified truth despite source file corruption
      expect(importedManifest.datasetId).toBe(datasetId);

      // Verify that database received original verified rows, NOT corrupted source file bytes
      expect(candleRepo.rows.size).toBe(2);
      const importedRow0 = candleRepo.rows.get(fromMs);
      const importedRow1 = candleRepo.rows.get(fromMs + 60_000);

      expect(importedRow0?.close.value).toBe('105');
      expect(importedRow1?.close.value).toBe('110');
    } finally {
      postCopyHook = null;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('proves Outcome A (source deletion): deleting original source NDJSON after snapshot does not abort import', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'coindcx-toctou-delete-'));
    const manifestPath = join(tempDir, 'dataset.manifest.json');
    const ndjsonPath = join(tempDir, 'dataset.candles.ndjson');

    const candleRepo = new MemoryCandleRepository();
    const manifestRepo = new MemoryManifestRepository();
    const clock = new FakeClock(toMs + 10 * 60_000);
    const service = new HistoricalDatasetService({
      reader: candleRepo,
      repository: candleRepo,
      manifests: manifestRepo,
      clock,
    });

    const rows = createValidRows();
    const { manifest, ndjsonLines, datasetId } = setupArtifacts(rows);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    await writeFile(ndjsonPath, ndjsonLines.join('\n') + '\n', 'utf8');

    postCopyHook = async (srcPath) => {
      if (srcPath.includes('dataset.candles.ndjson')) {
        await rm(srcPath, { force: true });
      }
    };

    try {
      const importedManifest = await service.importDataset(manifestPath, ndjsonPath);
      expect(importedManifest.datasetId).toBe(datasetId);
      expect(candleRepo.rows.size).toBe(2);
    } finally {
      postCopyHook = null;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
