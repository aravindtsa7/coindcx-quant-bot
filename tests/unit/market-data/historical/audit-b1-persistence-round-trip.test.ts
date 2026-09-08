import { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../../../src/integration/coindcx/clock';
import { CanonicalDecimal } from '../../../../src/market-data/canonical-decimal';
import { HistoricalDatasetService, computeDatasetId, encodeHistoricalLogicalRow } from '../../../../src/market-data/historical';
import { PrismaCandle1mRepository } from '../../../../src/market-data/persistence/candle-repository';
import { BASE_START_MS as BASE, DEFAULT_TEST_PAIR as PAIR, MemoryCandleRepository, MemoryManifestRepository, makeTestCandle } from './test-helpers';

const fields = ['open', 'high', 'low', 'close', 'volume', 'quoteVolume'] as const;
const values = ['0', '1', '0.1', '0.000001', '0.0000001', '0.000000000000000001', '12345678.123456789', '999999999999999999.999999999999999999'];

// Capture the real Prisma.Decimal objects emitted by production insertion, then
// return them through each production reload path (no live MySQL dependency).
function persistenceFixture() {
  let stored: Prisma.Candle1mCreateInput | undefined;
  const create = vi.fn(async ({ data }: { data: Prisma.Candle1mCreateInput }) => { stored = data; return data; });
  const prisma = { candle1m: {
    create,
    findUnique: vi.fn(async () => stored ?? null),
    findFirst: vi.fn(async () => stored ?? null),
    findMany: vi.fn(async () => stored ? [stored] : []),
  } };
  const repository = new PrismaCandle1mRepository(prisma as unknown as PrismaClient);
  const service = new HistoricalDatasetService({ reader: repository, repository, manifests: new MemoryManifestRepository(), clock: new FakeClock(BASE + 60_000) });
  return { repository, service, create, stored: () => {
    if (!stored) throw new Error('No persisted fixture');
    return stored;
  } };
}

describe('Audit B1 persisted DECIMAL(36,18) round-trip', () => {
  it.each(values)('preserves %s in all six financial fields through insertion, reload, manifest, export and import', async (value) => {
    const fixture = persistenceFixture();
    const candle = makeTestCandle({ openTimeMs: BASE, open: value, high: value, low: value, close: value, volume: value, quoteVolume: value });
    await expect(fixture.repository.insertCandle(candle)).resolves.toEqual({ outcome: 'INSERTED' });
    for (const field of fields) {
      const persisted = fixture.stored()[field];
      expect(persisted).toBeInstanceOf(Prisma.Decimal);
      expect((persisted as Prisma.Decimal).toFixed()).toBe(value);
    }
    if (value === '0.000000000000000001') expect((fixture.stored().open as Prisma.Decimal).toString()).toBe('1e-18');
    const reloaded = await fixture.repository.getCandle(PAIR, BASE);
    expect(reloaded?.pair).toBe(PAIR);
    expect(reloaded?.openTimeMs).toBe(BASE);
    for (const field of fields) expect(reloaded?.[field]?.value).toBe(value);
    expect(await fixture.repository.getLatestCanonicalCandle(PAIR)).toEqual(reloaded);
    expect(await fixture.repository.getRange(PAIR, BASE, BASE)).toEqual([reloaded]);
    const manifest = await fixture.service.createManifest(PAIR, BASE, BASE + 60_000);
    const hash = createHash('sha256').update(encodeHistoricalLogicalRow(candle)).digest('hex');
    expect(manifest.contentSha256).toBe(hash);
    expect(manifest.datasetId).toBe(computeDatasetId(PAIR, { fromInclusiveMs: BASE, toExclusiveMs: BASE + 60_000 }, hash));
    await expect(fixture.service.verifyDataset(manifest.datasetId)).resolves.toEqual({ isValid: true });
    const directory = await mkdtemp(join(tmpdir(), 'b1-persisted-export-'));
    try {
      const artifact = await fixture.service.exportDataset(manifest.datasetId, directory);
      const destination = new MemoryCandleRepository();
      const importer = new HistoricalDatasetService({ reader: destination, repository: destination, manifests: new MemoryManifestRepository(), clock: new FakeClock(BASE + 60_000) });
      const imported = await importer.importDataset(artifact.manifestFilePath, artifact.ndjsonFilePath);
      expect(imported.datasetId).toBe(manifest.datasetId);
      for (const field of fields) expect(destination.rows.get(BASE)?.[field]?.value).toBe(value);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps trailing-zero representations semantically identical and preserves null quoteVolume', async () => {
    const ids: string[] = [];
    for (const value of ['100', '100.0', '100.000000000000000000']) {
      const fixture = persistenceFixture();
      await fixture.repository.insertCandle(makeTestCandle({ openTimeMs: BASE, open: value, high: value, low: value, close: value, volume: value, quoteVolume: null }));
      expect((await fixture.repository.getCandle(PAIR, BASE))?.quoteVolume).toBeNull();
      ids.push((await fixture.service.createManifest(PAIR, BASE, BASE + 60_000)).datasetId);
    }
    expect(new Set(ids).size).toBe(1);
    expect(() => CanonicalDecimal.from('1e-18')).toThrow();
  });

  it.each(fields)('still rejects an invalid persisted negative %s', async (field) => {
    const fixture = persistenceFixture();
    await fixture.repository.insertCandle(makeTestCandle({ openTimeMs: BASE, quoteVolume: '1' }));
    fixture.stored()[field] = new Prisma.Decimal('-0.000000000000000001');
    await expect(fixture.repository.getCandle(PAIR, BASE)).rejects.toThrow();
    await expect(fixture.service.createManifest(PAIR, BASE, BASE + 60_000)).rejects.toMatchObject({ code: 'DB_FAILURE' });
  });
});
