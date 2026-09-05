import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../../src/integration/coindcx/clock';
import {
  HistoricalDatasetService,
  HistoricalDatasetError,
  computeDatasetId,
} from '../../../../src/market-data/historical';
import {
  BASE_START_MS,
  DEFAULT_TEST_PAIR,
  MemoryCandleRepository,
  MemoryManifestRepository,
  makeCanonicalRange,
  makeTestCandle,
} from './test-helpers';

describe('Phase 7 — Manifest Creation and Lifecycle Evidence', () => {
  it('A & C & D: complete canonical range creates manifest recomputed from DB truth and persisted only after verification', async () => {
    const candleRepo = new MemoryCandleRepository();
    const manifestRepo = new MemoryManifestRepository();
    const clock = new FakeClock(BASE_START_MS + 10 * 60_000);
    const service = new HistoricalDatasetService({
      reader: candleRepo,
      repository: candleRepo,
      manifests: manifestRepo,
      clock,
      pageMinutes: 2,
    });

    const candles = makeCanonicalRange(5, BASE_START_MS, DEFAULT_TEST_PAIR);
    for (const c of candles) await candleRepo.insertCandle(c);

    const fromInclusiveMs = BASE_START_MS;
    const toExclusiveMs = BASE_START_MS + 5 * 60_000;

    // Verify manifest persisted only after full verification
    expect(manifestRepo.insertCalls).toHaveLength(0);
    const manifest = await service.createManifest(DEFAULT_TEST_PAIR, fromInclusiveMs, toExclusiveMs);

    expect(manifest.pair).toBe(DEFAULT_TEST_PAIR);
    expect(manifest.fromInclusiveMs).toBe(fromInclusiveMs);
    expect(manifest.toExclusiveMs).toBe(toExclusiveMs);
    expect(manifest.expectedCandleCount).toBe(5);
    expect(manifest.actualCandleCount).toBe(5);
    expect(manifest.firstOpenTimeMs).toBe(fromInclusiveMs);
    expect(manifest.lastOpenTimeMs).toBe(toExclusiveMs - 60_000);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.venue).toBe('COINDCX');
    expect(manifest.market).toBe('FUTURES');
    expect(manifest.resolutionMinutes).toBe(1);

    // C: contentSha256 and datasetId are recomputed from DB truth
    const expectedDatasetId = computeDatasetId(DEFAULT_TEST_PAIR, { fromInclusiveMs, toExclusiveMs }, manifest.contentSha256);
    expect(manifest.datasetId).toBe(expectedDatasetId);

    // D: persisted only after verification
    expect(manifestRepo.insertCalls).toHaveLength(1);
    expect(manifestRepo.insertCalls[0]!.datasetId).toBe(manifest.datasetId);
  });

  it('B: incomplete canonical range rejects and persists no manifest', async () => {
    const candleRepo = new MemoryCandleRepository();
    const manifestRepo = new MemoryManifestRepository();
    const clock = new FakeClock(BASE_START_MS + 10 * 60_000);
    const service = new HistoricalDatasetService({
      reader: candleRepo,
      repository: candleRepo,
      manifests: manifestRepo,
      clock,
    });

    // Populate minutes 0, 1, 3, 4 (missing minute 2)
    const c0 = makeTestCandle({ openTimeMs: BASE_START_MS });
    const c1 = makeTestCandle({ openTimeMs: BASE_START_MS + 60_000 });
    const c3 = makeTestCandle({ openTimeMs: BASE_START_MS + 3 * 60_000 });
    const c4 = makeTestCandle({ openTimeMs: BASE_START_MS + 4 * 60_000 });
    await candleRepo.insertCandle(c0);
    await candleRepo.insertCandle(c1);
    await candleRepo.insertCandle(c3);
    await candleRepo.insertCandle(c4);

    await expect(
      service.createManifest(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + 5 * 60_000)
    ).rejects.toThrow(HistoricalDatasetError);

    // B: assert no manifest persisted
    expect(manifestRepo.insertCalls).toHaveLength(0);
    expect(manifestRepo.manifestsById.size).toBe(0);
  });

  it('E & F: same exact range + freshly recomputed identity returns existing manifest unchanged and preserves createdAt', async () => {
    const candleRepo = new MemoryCandleRepository();
    const manifestRepo = new MemoryManifestRepository();
    const clock = new FakeClock(BASE_START_MS + 10 * 60_000);
    const service = new HistoricalDatasetService({
      reader: candleRepo,
      repository: candleRepo,
      manifests: manifestRepo,
      clock,
    });

    const candles = makeCanonicalRange(3, BASE_START_MS, DEFAULT_TEST_PAIR);
    for (const c of candles) await candleRepo.insertCandle(c);

    const first = await service.createManifest(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + 3 * 60_000);
    const originalCreatedAt = first.createdAt;
    expect(manifestRepo.insertCalls).toHaveLength(1);

    // Advance clock to simulate later idempotent recreation call
    clock.advance(3600_000);

    const second = await service.createManifest(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + 3 * 60_000);

    // E: existing manifest returned unchanged
    expect(second).toBe(first);
    expect(second.datasetId).toBe(first.datasetId);
    expect(second.contentSha256).toBe(first.contentSha256);

    // F: createdAt remains unchanged
    expect(second.createdAt).toBe(originalCreatedAt);

    // Zero additional database writes
    expect(manifestRepo.insertCalls).toHaveLength(1);
  });

  it('G & H: same range with different stored metadata fails closed with MANIFEST_CONFLICT and no mutable overwrite', async () => {
    const candleRepo = new MemoryCandleRepository();
    const manifestRepo = new MemoryManifestRepository();
    const clock = new FakeClock(BASE_START_MS + 10 * 60_000);
    const service = new HistoricalDatasetService({
      reader: candleRepo,
      repository: candleRepo,
      manifests: manifestRepo,
      clock,
    });

    const candles = makeCanonicalRange(3, BASE_START_MS, DEFAULT_TEST_PAIR);
    for (const c of candles) await candleRepo.insertCandle(c);

    const initial = await service.createManifest(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + 3 * 60_000);

    // Corrupt the stored manifest in repository (e.g. tampered contentSha256 or candle count)
    const tamperedSha = 'f'.repeat(64);
    const corruptedManifest = Object.freeze({
      ...initial,
      contentSha256: tamperedSha,
      datasetId: computeDatasetId(DEFAULT_TEST_PAIR, { fromInclusiveMs: BASE_START_MS, toExclusiveMs: BASE_START_MS + 3 * 60_000 }, tamperedSha),
    });
    manifestRepo.manifestsById.delete(initial.datasetId);
    manifestRepo.manifestsById.set(corruptedManifest.datasetId, corruptedManifest);
    const rangeKey = `${DEFAULT_TEST_PAIR}:${BASE_START_MS}:${BASE_START_MS + 3 * 60_000}`;
    manifestRepo.manifestsByRange.set(rangeKey, corruptedManifest);

    // Attempt recreation: must fail closed with MANIFEST_CONFLICT
    await expect(
      service.createManifest(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + 3 * 60_000)
    ).rejects.toMatchObject({ code: 'MANIFEST_CONFLICT' });

    // H: No mutable upsert/overwrite occurred
    const stored = await manifestRepo.getByRange(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + 3 * 60_000);
    expect(stored?.contentSha256).toBe(tamperedSha); // was not overwritten back
  });

  it('I: unknown datasetId read or verify produces clear fail-closed result', async () => {
    const candleRepo = new MemoryCandleRepository();
    const manifestRepo = new MemoryManifestRepository();
    const service = new HistoricalDatasetService({
      reader: candleRepo,
      repository: candleRepo,
      manifests: manifestRepo,
    });

    const unknownId = 'a'.repeat(64);
    const manifest = await service.getManifest(unknownId);
    expect(manifest).toBeNull();

    await expect(service.verifyDataset(unknownId)).rejects.toMatchObject({
      code: 'DATASET_INCOMPLETE',
    });

    // Malformed datasetId fails with IMPORT_FORMAT_INVALID
    await expect(service.getManifest('invalid-id')).rejects.toMatchObject({
      code: 'IMPORT_FORMAT_INVALID',
    });
  });

  it('J: verifyDataset detects missing minute, changed market truth, and hash mismatch', async () => {
    const candleRepo = new MemoryCandleRepository();
    const manifestRepo = new MemoryManifestRepository();
    const clock = new FakeClock(BASE_START_MS + 10 * 60_000);
    const service = new HistoricalDatasetService({
      reader: candleRepo,
      repository: candleRepo,
      manifests: manifestRepo,
      clock,
    });

    const candles = makeCanonicalRange(3, BASE_START_MS, DEFAULT_TEST_PAIR);
    for (const c of candles) await candleRepo.insertCandle(c);

    const manifest = await service.createManifest(DEFAULT_TEST_PAIR, BASE_START_MS, BASE_START_MS + 3 * 60_000);

    // Initially valid
    const initialVerification = await service.verifyDataset(manifest.datasetId);
    expect(initialVerification.isValid).toBe(true);

    // Subcase 1: Changed logical market truth (tamper with close price)
    candleRepo.rows.set(
      BASE_START_MS + 60_000,
      makeTestCandle({
        openTimeMs: BASE_START_MS + 60_000,
        high: '1000.00',
        close: '999.00', // changed
      })
    );
    const tamperedVerification = await service.verifyDataset(manifest.datasetId);
    expect(tamperedVerification.isValid).toBe(false);
    expect(tamperedVerification.error).toBeDefined();

    // Subcase 2: Missing canonical minute
    candleRepo.rows.delete(BASE_START_MS + 60_000);
    const missingVerification = await service.verifyDataset(manifest.datasetId);
    expect(missingVerification.isValid).toBe(false);
    expect(missingVerification.error).toBeDefined();

    // Subcase 3: Count mismatch (remove last minute)
    candleRepo.rows.set(BASE_START_MS + 60_000, candles[1]!);
    candleRepo.rows.delete(BASE_START_MS + 2 * 60_000);
    const countMismatchVerification = await service.verifyDataset(manifest.datasetId);
    expect(countMismatchVerification.isValid).toBe(false);
  });
});
