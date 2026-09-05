import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FakeClock } from '../../../../src/integration/coindcx/clock';
import {
  HistoricalDatasetService,
  canonicalHashDecimal,
  computeDatasetId,
  encodeHistoricalLogicalRow,
  findMissingMinuteSpans,
} from '../../../../src/market-data/historical';
import { CanonicalCandleConflictError } from '../../../../src/market-data/errors';
import {
  BASE_START_MS,
  DEFAULT_TEST_PAIR,
  MemoryCandleRepository,
  MemoryManifestRepository,
  makeTestCandle,
} from './test-helpers';

describe('Phase 7 — Round-Trip, Identity, Quote Volume, and Hash Normalization Evidence', () => {
  describe('Section 11: Export -> Import Round Trip', () => {
    it('preserves bit-for-bit canonical truth, contentSha256, and datasetId across export and import into clean repo', async () => {
      const repoA = new MemoryCandleRepository();
      const manifestRepoA = new MemoryManifestRepository();
      const clock = new FakeClock(BASE_START_MS + 20 * 60_000);

      const serviceA = new HistoricalDatasetService({
        reader: repoA,
        repository: repoA,
        manifests: manifestRepoA,
        clock,
      });

      // Build canonical dataset truth in repoA with mixed WS_FINALIZED / REST_RECOVERY sources
      const c0 = makeTestCandle({
        openTimeMs: BASE_START_MS,
        open: '3715000.000000000000000000',
        high: '3718500.500000000000000000',
        low: '3714000.000000000000000000',
        close: '3717200.000000000000000000',
        volume: '1.452000000000000000',
        quoteVolume: null,
        source: 'WS_FINALIZED',
        generationId: 1,
      });
      const c1 = makeTestCandle({
        openTimeMs: BASE_START_MS + 60_000,
        open: '3717200.000000000000000000',
        high: '3719000.000000000000000000',
        low: '3716000.000000000000000000',
        close: '3718000.000000000000000000',
        volume: '2.100000000000000000',
        quoteVolume: '7807800.000000000000000000',
        source: 'REST_RECOVERY',
        generationId: null,
      });
      await repoA.insertCandle(c0);
      await repoA.insertCandle(c1);

      // Create initial manifest on DB A
      const manifestA = await serviceA.createManifest(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + 2 * 60_000);

      const exportDir = await mkdtemp(join(tmpdir(), 'coindcx-roundtrip-'));
      try {
        const exported = await serviceA.exportDataset(manifestA.datasetId, exportDir);

        // Clean, empty repository B
        const repoB = new MemoryCandleRepository();
        const manifestRepoB = new MemoryManifestRepository();
        const serviceB = new HistoricalDatasetService({
          reader: repoB,
          repository: repoB,
          manifests: manifestRepoB,
          clock,
        });

        // Import exported files into repo B
        const manifestB = await serviceB.importDataset(exported.manifestFilePath, exported.ndjsonFilePath);

        // Read imported truth from repo B
        const imported0 = await repoB.getCandle(DEFAULT_TEST_PAIR, BASE_START_MS);
        const imported1 = await repoB.getCandle(DEFAULT_TEST_PAIR, BASE_START_MS + 60_000);

        expect(imported0).not.toBeNull();
        expect(imported1).not.toBeNull();

        // Assert identical pair, timestamps, OHLC, volume, quoteVolume
        expect(imported0!.pair).toBe(c0.pair);
        expect(imported0!.openTimeMs).toBe(c0.openTimeMs);
        expect(imported0!.open.value).toBe(c0.open.value);
        expect(imported0!.high.value).toBe(c0.high.value);
        expect(imported0!.low.value).toBe(c0.low.value);
        expect(imported0!.close.value).toBe(c0.close.value);
        expect(imported0!.volume.value).toBe(c0.volume.value);
        expect(imported0!.quoteVolume).toBeNull();

        expect(imported1!.pair).toBe(c1.pair);
        expect(imported1!.openTimeMs).toBe(c1.openTimeMs);
        expect(imported1!.open.value).toBe(c1.open.value);
        expect(imported1!.high.value).toBe(c1.high.value);
        expect(imported1!.low.value).toBe(c1.low.value);
        expect(imported1!.close.value).toBe(c1.close.value);
        expect(imported1!.volume.value).toBe(c1.volume.value);
        expect(imported1!.quoteVolume!.value).toBe(c1.quoteVolume!.value);

        // Assert identical contentSha256 and datasetId
        expect(manifestB.contentSha256).toBe(manifestA.contentSha256);
        expect(manifestB.datasetId).toBe(manifestA.datasetId);

        // Imported candles have source REST_HISTORICAL while repoA had WS_FINALIZED / REST_RECOVERY
        expect(imported0!.source).toBe('REST_HISTORICAL');
        expect(imported1!.source).toBe('REST_HISTORICAL');
      } finally {
        await rm(exportDir, { recursive: true, force: true });
      }
    });
  });

  describe('Section 12: Provenance-Neutral Identity', () => {
    it('WS_FINALIZED, REST_RECOVERY, and REST_HISTORICAL produce identical logical row serialization, contentSha256, and datasetId', () => {
      const baseParams = {
        pair: DEFAULT_TEST_PAIR,
        openTimeMs: BASE_START_MS,
        open: '100', high: '110', low: '95', close: '105', volume: '10', quoteVolume: null,
      };

      const cWs = makeTestCandle({
        ...baseParams,
        source: 'WS_FINALIZED',
        finalizedAtMs: BASE_START_MS + 60_100,
        providerEventTimeMs: 1704067200500,
        generationId: 5,
      });

      const cRecovery = makeTestCandle({
        ...baseParams,
        source: 'REST_RECOVERY',
        finalizedAtMs: BASE_START_MS + 65_000,
        providerEventTimeMs: null,
        generationId: null,
      });

      const cHistorical = makeTestCandle({
        ...baseParams,
        source: 'REST_HISTORICAL',
        finalizedAtMs: BASE_START_MS + 60_000,
        providerEventTimeMs: null,
        generationId: null,
      });

      // 1. Identical logical row serialization
      const rowWs = encodeHistoricalLogicalRow(cWs);
      const rowRec = encodeHistoricalLogicalRow(cRecovery);
      const rowHist = encodeHistoricalLogicalRow(cHistorical);

      expect(rowWs.toString('utf8')).toBe(rowRec.toString('utf8'));
      expect(rowRec.toString('utf8')).toBe(rowHist.toString('utf8'));

      // 2. Identical contentSha256
      const hashWs = createHash('sha256').update(rowWs).digest('hex');
      const hashRec = createHash('sha256').update(rowRec).digest('hex');
      const hashHist = createHash('sha256').update(rowHist).digest('hex');

      expect(hashWs).toBe(hashRec);
      expect(hashRec).toBe(hashHist);

      // 3. Identical datasetId
      const range = { fromInclusiveMs: BASE_START_MS, toExclusiveMs: BASE_START_MS + 60_000 };
      const idWs = computeDatasetId(DEFAULT_TEST_PAIR, range, hashWs);
      const idRec = computeDatasetId(DEFAULT_TEST_PAIR, range, hashRec);
      const idHist = computeDatasetId(DEFAULT_TEST_PAIR, range, hashHist);

      expect(idWs).toBe(idRec);
      expect(idRec).toBe(idHist);

      // 4. One real OHLCV change MUST alter contentSha256
      const cModified = makeTestCandle({
        ...baseParams,
        close: '105.000000000000000001', // altered market truth
        source: 'WS_FINALIZED',
      });
      const rowModified = encodeHistoricalLogicalRow(cModified);
      const hashModified = createHash('sha256').update(rowModified).digest('hex');
      expect(hashModified).not.toBe(hashWs);
    });
  });

  describe('Section 14: Quote Volume Semantics', () => {
    it('quoteVolume null !== quoteVolume numeric zero for canonical serialization and hash', () => {
      const cNull = makeTestCandle({
        openTimeMs: BASE_START_MS,
        quoteVolume: null,
      });
      const cZero = makeTestCandle({
        openTimeMs: BASE_START_MS,
        quoteVolume: '0',
      });

      const rowNull = encodeHistoricalLogicalRow(cNull).toString('utf8');
      const rowZero = encodeHistoricalLogicalRow(cZero).toString('utf8');

      // Null serializes to "N", zero serializes to "0"
      expect(rowNull).toContain('|N\n');
      expect(rowZero).toContain('|0\n');
      expect(rowNull).not.toBe(rowZero);

      const hashNull = createHash('sha256').update(rowNull).digest('hex');
      const hashZero = createHash('sha256').update(rowZero).digest('hex');
      expect(hashNull).not.toBe(hashZero);
    });

    it('existing DB minute with non-null quoteVolume remains authoritative and is not refetched by backfill', () => {
      // Existing DB minute has non-null quoteVolume = 1000
      const existingCandle = makeTestCandle({
        openTimeMs: BASE_START_MS,
        quoteVolume: '1000.00',
        source: 'WS_FINALIZED',
      });

      const range = { fromInclusiveMs: BASE_START_MS, toExclusiveMs: BASE_START_MS + 60_000 };
      const missingSpans = findMissingMinuteSpans(DEFAULT_TEST_PAIR, range, [existingCandle]);

      // Complete minute is NOT considered missing: zero REST refetch spans
      expect(missingSpans).toHaveLength(0);
    });

    it('inserting candle with null quoteVolume against existing non-null throws conflict', async () => {
      const repo = new MemoryCandleRepository();
      const existingCandle = makeTestCandle({
        openTimeMs: BASE_START_MS,
        quoteVolume: '1000.00',
        source: 'WS_FINALIZED',
      });
      await repo.insertCandle(existingCandle);

      // Incoming backfill/import row with quoteVolume = null
      const incomingCandle = makeTestCandle({
        openTimeMs: BASE_START_MS,
        quoteVolume: null,
        source: 'REST_HISTORICAL',
      });

      await expect(repo.insertCandle(incomingCandle)).rejects.toThrow(CanonicalCandleConflictError);
    });
  });

  describe('Section 15: Hash Canonicalization Matrix', () => {
    it('normalizes decimal strings with exact value preservation, no rounding/truncation, and collapses negative zero', () => {
      // "1", "1.0", "1.00" => "1"
      expect(canonicalHashDecimal('1')).toBe('1');
      expect(canonicalHashDecimal('1.0')).toBe('1');
      expect(canonicalHashDecimal('1.00')).toBe('1');

      // "0", "0.0", "-0", "-0.000" => "0"
      expect(canonicalHashDecimal('0')).toBe('0');
      expect(canonicalHashDecimal('0.0')).toBe('0');
      expect(canonicalHashDecimal('-0')).toBe('0');
      expect(canonicalHashDecimal('-0.000')).toBe('0');

      // "10.5000" => "10.5"
      expect(canonicalHashDecimal('10.5000')).toBe('10.5');

      // Leading zeros: "001.20" => "1.2", "000.5" => "0.5"
      expect(canonicalHashDecimal('001.20')).toBe('1.2');
      expect(canonicalHashDecimal('000.5')).toBe('0.5');

      // 18 fractional digits preserved exactly without rounding or truncation
      const eighteenDigits = '0.123456789012345678';
      expect(canonicalHashDecimal(eighteenDigits)).toBe(eighteenDigits);

      const oneSatoshi = '0.000000000000000001';
      expect(canonicalHashDecimal(oneSatoshi)).toBe(oneSatoshi);
    });

    it('matches hard-coded expected SHA-256 fixture for known fixed logical dataset', () => {
      const fixedCandle = makeTestCandle({
        pair: 'B-BTC_USDT',
        openTimeMs: 1704067200000,
        open: '3715000.000000000000000000',
        high: '3718500.500000000000000000',
        low: '3714000.000000000000000000',
        close: '3717200.000000000000000000',
        volume: '1.452000000000000000',
        quoteVolume: null,
      });

      const rowBytes = encodeHistoricalLogicalRow(fixedCandle);
      expect(rowBytes.toString('utf8')).toBe('B-BTC_USDT|1704067200000|3715000|3718500.5|3714000|3717200|1.452|N\n');

      const computedSha = createHash('sha256').update(rowBytes).digest('hex');
      const EXPECTED_FIXTURE_SHA256 = 'd37d6f64b264314f5222e8692ac6f023fa30d92c112dc743aff96da645d99d39';
      expect(computedSha).toBe(EXPECTED_FIXTURE_SHA256);

      const range = { fromInclusiveMs: 1704067200000, toExclusiveMs: 1704067260000 };
      const computedDatasetId = computeDatasetId('B-BTC_USDT', range, computedSha);
      const EXPECTED_FIXTURE_DATASET_ID = '76bcb67ba2c593e3a2e5b2ee7803b1725580f726d08c7f7a83a261faa14b4670';
      expect(computedDatasetId).toBe(EXPECTED_FIXTURE_DATASET_ID);
    });
  });
});
