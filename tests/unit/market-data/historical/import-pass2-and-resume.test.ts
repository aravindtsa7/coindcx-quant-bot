import { describe, expect, it } from 'vitest';
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

describe('Phase 7 — Import Pass-2 and Crash / Resume Evidence', () => {
  const fromMs = BASE_START_MS;
  const toMs = BASE_START_MS + 4 * 60_000;
  const count = 4;

  function createValidRows() {
    return [
      makeTestCandle({ openTimeMs: fromMs, open: '100', high: '110', low: '95', close: '105', volume: '10', quoteVolume: null }),
      makeTestCandle({ openTimeMs: fromMs + 60_000, open: '105', high: '115', low: '100', close: '110', volume: '12', quoteVolume: null }),
      makeTestCandle({ openTimeMs: fromMs + 2 * 60_000, open: '110', high: '120', low: '105', close: '115', volume: '14', quoteVolume: null }),
      makeTestCandle({ openTimeMs: fromMs + 3 * 60_000, open: '115', high: '125', low: '110', close: '120', volume: '16', quoteVolume: null }),
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

  it('Pass 2: inserts REST_HISTORICAL canonical candles with deterministic finalizedAtMs and null provider/generation', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'coindcx-pass2-'));
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
      pageMinutes: 2,
    });

    try {
      const rows = createValidRows();
      const { manifest, ndjsonLines, datasetId } = setupArtifacts(rows);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      await writeFile(ndjsonPath, ndjsonLines.join('\n') + '\n', 'utf8');

      const importedManifest = await service.importDataset(manifestPath, ndjsonPath);
      expect(importedManifest.datasetId).toBe(datasetId);

      // Verify all rows inserted
      expect(candleRepo.rows.size).toBe(count);

      // Verify each inserted candle properties
      for (const [openTimeMs, candle] of candleRepo.rows.entries()) {
        expect(candle.source).toBe('REST_HISTORICAL');
        expect(candle.providerEventTimeMs).toBeNull();
        expect(candle.generationId).toBeNull();
        expect(candle.finalizedAtMs).toBe(openTimeMs + 60_000);
      }

      // Manifest persisted after successful DB reverification
      expect(manifestRepo.manifestsById.has(datasetId)).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('Pass 2: accepts existing identical rows (ALREADY_IDENTICAL) and fails on material conflict', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'coindcx-pass2-conflict-'));
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

    try {
      const rows = createValidRows();
      const { manifest, ndjsonLines, datasetId: _id } = setupArtifacts(rows);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      await writeFile(ndjsonPath, ndjsonLines.join('\n') + '\n', 'utf8');

      // Pre-populate row 0 as identical (different provenance)
      await candleRepo.insertCandle(
        makeTestCandle({
          openTimeMs: fromMs,
          open: '100', high: '110', low: '95', close: '105', volume: '10', quoteVolume: null,
          source: 'WS_FINALIZED',
          finalizedAtMs: fromMs + 120_000,
        })
      );

      // Pre-populate row 1 with CONFLICTING close price (108 vs incoming 110)
      await candleRepo.insertCandle(
        makeTestCandle({
          openTimeMs: fromMs + 60_000,
          open: '105', high: '115', low: '100',
          close: '108', // CONFLICT with incoming 110
          volume: '12', quoteVolume: null,
        })
      );

      // Import must fail closed with CANONICAL_CONFLICT
      await expect(service.importDataset(manifestPath, ndjsonPath)).rejects.toMatchObject({
        code: 'CANONICAL_CONFLICT',
      });

      // Manifest must NOT be persisted
      expect(manifestRepo.insertCalls).toHaveLength(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('Pass 2: if DB post-verification fails, manifest remains absent', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'coindcx-pass2-postverify-fail-'));
    const manifestPath = join(tempDir, 'dataset.manifest.json');
    const ndjsonPath = join(tempDir, 'dataset.candles.ndjson');

    const candleRepo = new MemoryCandleRepository();
    const manifestRepo = new MemoryManifestRepository();
    const clock = new FakeClock(toMs + 10 * 60_000);

    // Instrument reader to simulate DB corruption upon post-verification getRange
    const corruptingReader = {
      async getLatestCanonicalCandle(pair: string) {
        return candleRepo.getLatestCanonicalCandle(pair);
      },
      async getRange(pair: string, f: number, t: number) {
        // On post-verification call, omit one candle
        const normal = await candleRepo.getRange(pair, f, t);
        return normal.filter((c) => c.openTimeMs !== fromMs + 60_000);
      },
    };

    const service = new HistoricalDatasetService({
      reader: corruptingReader,
      repository: candleRepo,
      manifests: manifestRepo,
      clock,
    });

    try {
      const rows = createValidRows();
      const { manifest, ndjsonLines } = setupArtifacts(rows);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      await writeFile(ndjsonPath, ndjsonLines.join('\n') + '\n', 'utf8');

      await expect(service.importDataset(manifestPath, ndjsonPath)).rejects.toThrow();

      // Manifest must remain absent
      expect(manifestRepo.insertCalls).toHaveLength(0);
      expect(manifestRepo.manifestsById.size).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('Section 9: simulates Pass-2 crash and idempotent resume', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'coindcx-pass2-crash-resume-'));
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

    try {
      const rows = createValidRows();
      const { manifest, ndjsonLines, datasetId } = setupArtifacts(rows);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      await writeFile(ndjsonPath, ndjsonLines.join('\n') + '\n', 'utf8');

      // FIRST RUN: Fail on 3rd candle insert (openTimeMs === fromMs + 2 * 60_000)
      candleRepo.failOnInsertPredicate = (candle) => candle.openTimeMs === fromMs + 2 * 60_000;

      await expect(service.importDataset(manifestPath, ndjsonPath)).rejects.toThrow();

      // First run results:
      // - rows 0 and 1 were inserted before crash and remain in DB
      expect(candleRepo.rows.has(fromMs)).toBe(true);
      expect(candleRepo.rows.has(fromMs + 60_000)).toBe(true);
      expect(candleRepo.rows.has(fromMs + 2 * 60_000)).toBe(false);
      expect(candleRepo.rows.has(fromMs + 3 * 60_000)).toBe(false);

      // - manifest is ABSENT
      expect(manifestRepo.insertCalls).toHaveLength(0);
      expect(manifestRepo.manifestsById.size).toBe(0);

      // SECOND RUN (RESUME): Remove crash condition and rerun import with same valid artifact
      candleRepo.failOnInsertPredicate = undefined;
      candleRepo.insertCalls = [];

      const resumedManifest = await service.importDataset(manifestPath, ndjsonPath);

      // Pass 1 re-verified, Pass 2 resumed:
      // Rows 0 and 1 were passed to insertCandle and returned ALREADY_IDENTICAL
      // Rows 2 and 3 were newly INSERTED
      expect(resumedManifest.datasetId).toBe(datasetId);
      expect(candleRepo.rows.size).toBe(count);

      // Manifest persisted exactly once
      expect(manifestRepo.insertCalls).toHaveLength(1);
      expect(manifestRepo.manifestsById.get(datasetId)).toBeDefined();

      // Final logical truth is complete and verifiable
      const verifyResult = await service.verifyDataset(datasetId);
      expect(verifyResult.isValid).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
