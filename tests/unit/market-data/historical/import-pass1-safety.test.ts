import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../../../../src/integration/coindcx/clock';
import {
  HistoricalDatasetService,
  computeDatasetId,
  encodeHistoricalLogicalRow,
} from '../../../../src/market-data/historical';
import { createHash } from 'node:crypto';
import type { CanonicalCandle1m } from '../../../../src/market-data/types';
import {
  BASE_START_MS,
  DEFAULT_TEST_PAIR,
  MemoryCandleRepository,
  MemoryManifestRepository,
  makeTestCandle,
} from './test-helpers';

describe('Phase 7 — Import Pass-1 Zero-Write Safety', () => {
  const fromMs = BASE_START_MS;
  const toMs = BASE_START_MS + 3 * 60_000;
  const count = 3;

  function createValidLogicalRows(): [CanonicalCandle1m, CanonicalCandle1m, CanonicalCandle1m] {
    return [
      makeTestCandle({ openTimeMs: fromMs, open: '100', high: '110', low: '95', close: '105', volume: '10', quoteVolume: null }),
      makeTestCandle({ openTimeMs: fromMs + 60_000, open: '105', high: '115', low: '100', close: '110', volume: '12', quoteVolume: null }),
      makeTestCandle({ openTimeMs: fromMs + 2 * 60_000, open: '110', high: '120', low: '105', close: '115', volume: '15', quoteVolume: null }),
    ];
  }

  function computeValidShaAndId(rows: ReturnType<typeof createValidLogicalRows>) {
    const hash = createHash('sha256');
    for (const r of rows) {
      hash.update(encodeHistoricalLogicalRow(r));
    }
    const contentSha256 = hash.digest('hex');
    const datasetId = computeDatasetId(DEFAULT_TEST_PAIR, { fromInclusiveMs: fromMs, toExclusiveMs: toMs }, contentSha256);
    return { contentSha256, datasetId };
  }

  function validManifest(contentSha256: string, datasetId: string) {
    return {
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
  }

  function rowToJson(row: CanonicalCandle1m): string {
    return JSON.stringify({
      pair: row.pair,
      openTimeMs: row.openTimeMs,
      open: row.open.value,
      high: row.high.value,
      low: row.low.value,
      close: row.close.value,
      volume: row.volume.value,
      quoteVolume: row.quoteVolume ? row.quoteVolume.value : null,
    });
  }

  async function runPass1RejectionTest(
    setupArtifacts: () => { manifest: Record<string, unknown>; ndjsonLines: string[] }
  ) {
    const tempDir = await mkdtemp(join(tmpdir(), 'coindcx-pass1-'));
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
      const { manifest, ndjsonLines } = setupArtifacts();
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      await writeFile(ndjsonPath, ndjsonLines.join('\n') + '\n', 'utf8');

      // Attempt import: must reject
      await expect(service.importDataset(manifestPath, ndjsonPath)).rejects.toThrow();

      // MANDATORY ASSERTIONS: ZERO CANDLE INSERTS, ZERO MANIFEST INSERTS
      expect(candleRepo.insertCalls).toHaveLength(0);
      expect(candleRepo.rows.size).toBe(0);
      expect(manifestRepo.insertCalls).toHaveLength(0);
      expect(manifestRepo.manifestsById.size).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  it('1. invalid JSON in NDJSON line causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { contentSha256, datasetId } = computeValidShaAndId(validRows);
    await runPass1RejectionTest(() => ({
      manifest: validManifest(contentSha256, datasetId),
      ndjsonLines: [rowToJson(validRows[0]), '{"pair": broken json', rowToJson(validRows[2])],
    }));
  });

  it('2. malformed row (missing fields or unknown keys) causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { contentSha256, datasetId } = computeValidShaAndId(validRows);
    await runPass1RejectionTest(() => ({
      manifest: validManifest(contentSha256, datasetId),
      ndjsonLines: [
        rowToJson(validRows[0]),
        JSON.stringify({ pair: DEFAULT_TEST_PAIR, openTimeMs: fromMs + 60_000, open: '100' }), // missing high, low, close, volume, quoteVolume
        rowToJson(validRows[2]),
      ],
    }));
  });

  it('3. invalid pair causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { contentSha256, datasetId } = computeValidShaAndId(validRows);
    await runPass1RejectionTest(() => ({
      manifest: validManifest(contentSha256, datasetId),
      ndjsonLines: [
        rowToJson(validRows[0]),
        JSON.stringify({
          pair: 'b-btc_usdt', // lowercase prohibited
          openTimeMs: fromMs + 60_000,
          open: '105', high: '115', low: '100', close: '110', volume: '12', quoteVolume: null,
        }),
        rowToJson(validRows[2]),
      ],
    }));
  });

  it('4. invalid decimal (scale > 18 digits) causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { contentSha256, datasetId } = computeValidShaAndId(validRows);
    await runPass1RejectionTest(() => ({
      manifest: validManifest(contentSha256, datasetId),
      ndjsonLines: [
        rowToJson(validRows[0]),
        JSON.stringify({
          pair: DEFAULT_TEST_PAIR,
          openTimeMs: fromMs + 60_000,
          open: '105.1234567890123456789', // 19 scale digits (violates scale <= 18)
          high: '115', low: '100', close: '110', volume: '12', quoteVolume: null,
        }),
        rowToJson(validRows[2]),
      ],
    }));
  });

  it('5. scientific notation causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { contentSha256, datasetId } = computeValidShaAndId(validRows);
    await runPass1RejectionTest(() => ({
      manifest: validManifest(contentSha256, datasetId),
      ndjsonLines: [
        rowToJson(validRows[0]),
        JSON.stringify({
          pair: DEFAULT_TEST_PAIR,
          openTimeMs: fromMs + 60_000,
          open: '1e-5', // scientific notation strictly prohibited
          high: '115', low: '100', close: '110', volume: '12', quoteVolume: null,
        }),
        rowToJson(validRows[2]),
      ],
    }));
  });

  it('6. negative invalid OHLCV causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { contentSha256, datasetId } = computeValidShaAndId(validRows);
    await runPass1RejectionTest(() => ({
      manifest: validManifest(contentSha256, datasetId),
      ndjsonLines: [
        rowToJson(validRows[0]),
        JSON.stringify({
          pair: DEFAULT_TEST_PAIR,
          openTimeMs: fromMs + 60_000,
          open: '-10.00', // negative price
          high: '115', low: '100', close: '110', volume: '12', quoteVolume: null,
        }),
        rowToJson(validRows[2]),
      ],
    }));
  });

  it('7. structural OHLC violation (high < low) causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { contentSha256, datasetId } = computeValidShaAndId(validRows);
    await runPass1RejectionTest(() => ({
      manifest: validManifest(contentSha256, datasetId),
      ndjsonLines: [
        rowToJson(validRows[0]),
        JSON.stringify({
          pair: DEFAULT_TEST_PAIR,
          openTimeMs: fromMs + 60_000,
          open: '105', high: '90', low: '100', close: '105', volume: '12', quoteVolume: null, // high < low
        }),
        rowToJson(validRows[2]),
      ],
    }));
  });

  it('8. duplicate timestamp causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { contentSha256, datasetId } = computeValidShaAndId(validRows);
    await runPass1RejectionTest(() => ({
      manifest: validManifest(contentSha256, datasetId),
      ndjsonLines: [
        rowToJson(validRows[0]),
        rowToJson(validRows[0]), // duplicate timestamp
        rowToJson(validRows[2]),
      ],
    }));
  });

  it('9. out-of-order timestamp causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { contentSha256, datasetId } = computeValidShaAndId(validRows);
    await runPass1RejectionTest(() => ({
      manifest: validManifest(contentSha256, datasetId),
      ndjsonLines: [
        rowToJson(validRows[1]), // row 1 before row 0
        rowToJson(validRows[0]),
        rowToJson(validRows[2]),
      ],
    }));
  });

  it('10. gap between timestamps causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { contentSha256, datasetId } = computeValidShaAndId(validRows);
    const jumpedRow = makeTestCandle({
      openTimeMs: fromMs + 3 * 60_000, // jumped over 2*60_000
      open: '110', high: '120', low: '105', close: '115', volume: '15',
    });
    await runPass1RejectionTest(() => ({
      manifest: validManifest(contentSha256, datasetId),
      ndjsonLines: [rowToJson(validRows[0]), rowToJson(validRows[1]), rowToJson(jumpedRow)],
    }));
  });

  it('11. wrong first minute causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { contentSha256, datasetId } = computeValidShaAndId(validRows);
    await runPass1RejectionTest(() => ({
      manifest: validManifest(contentSha256, datasetId),
      ndjsonLines: [
        rowToJson(validRows[1]), // first row starts at fromMs + 60_000 instead of fromMs
        rowToJson(validRows[2]),
        rowToJson(makeTestCandle({ openTimeMs: fromMs + 3 * 60_000 })),
      ],
    }));
  });

  it('12. wrong last minute causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { contentSha256, datasetId } = computeValidShaAndId(validRows);
    await runPass1RejectionTest(() => ({
      manifest: validManifest(contentSha256, datasetId),
      ndjsonLines: [
        rowToJson(validRows[0]),
        rowToJson(validRows[1]),
        rowToJson(makeTestCandle({ openTimeMs: fromMs + 3 * 60_000 })), // last row at +3m instead of +2m
      ],
    }));
  });

  it('13. wrong row count causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { contentSha256, datasetId } = computeValidShaAndId(validRows);
    await runPass1RejectionTest(() => ({
      manifest: validManifest(contentSha256, datasetId),
      ndjsonLines: [rowToJson(validRows[0]), rowToJson(validRows[1])], // 2 rows instead of 3
    }));
  });

  it('14. tampered early row causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { contentSha256, datasetId } = computeValidShaAndId(validRows);
    const tamperedEarly = makeTestCandle({
      openTimeMs: fromMs,
      open: '100', high: '110', low: '95',
      close: '105.000000000000000001', // tampered close
      volume: '10',
    });
    await runPass1RejectionTest(() => ({
      manifest: validManifest(contentSha256, datasetId),
      ndjsonLines: [rowToJson(tamperedEarly), rowToJson(validRows[1]), rowToJson(validRows[2])],
    }));
  });

  it('15. tampered FINAL row causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { contentSha256, datasetId } = computeValidShaAndId(validRows);
    const tamperedFinal = makeTestCandle({
      openTimeMs: fromMs + 2 * 60_000,
      open: '110', high: '120', low: '105',
      close: '115.000000000000000001', // tampered close on last row
      volume: '15',
    });
    await runPass1RejectionTest(() => ({
      manifest: validManifest(contentSha256, datasetId),
      ndjsonLines: [rowToJson(validRows[0]), rowToJson(validRows[1]), rowToJson(tamperedFinal)],
    }));
  });

  it('16. wrong manifest contentSha256 causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { datasetId } = computeValidShaAndId(validRows);
    const wrongSha = '0'.repeat(64);
    await runPass1RejectionTest(() => ({
      manifest: validManifest(wrongSha, datasetId),
      ndjsonLines: validRows.map(rowToJson),
    }));
  });

  it('17. wrong manifest datasetId causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { contentSha256 } = computeValidShaAndId(validRows);
    const wrongId = '1'.repeat(64);
    await runPass1RejectionTest(() => ({
      manifest: validManifest(contentSha256, wrongId),
      ndjsonLines: validRows.map(rowToJson),
    }));
  });

  it('18. wrong manifest range (from >= to) causes ZERO database writes', async () => {
    const validRows = createValidLogicalRows();
    const { contentSha256, datasetId } = computeValidShaAndId(validRows);
    await runPass1RejectionTest(() => ({
      manifest: {
        ...validManifest(contentSha256, datasetId),
        fromInclusiveMs: toMs,
        toExclusiveMs: fromMs, // from >= to
      },
      ndjsonLines: validRows.map(rowToJson),
    }));
  });
});
