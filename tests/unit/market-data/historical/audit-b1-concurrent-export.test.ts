import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../../../src/integration/coindcx/clock';
import { HistoricalDatasetService } from '../../../../src/market-data/historical';
import { BASE_START_MS as BASE, MemoryCandleRepository, MemoryManifestRepository, makeCanonicalRange } from './test-helpers';

const fault = vi.hoisted(() => ({ mode: '', ownedPaths: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs,
    createReadStream: ((path, options) => {
      const stream = fs.createReadStream(path, options);
      if (fault.mode === 'EXISTING_READ_FAILURE') process.nextTick(() => stream.destroy(new Error('Artifact read failed')));
      return stream;
    }) as typeof fs.createReadStream,
    createWriteStream: ((path, options) => {
    fault.ownedPaths.push(String(path));
    if (fault.mode === 'CREATE_FAILURE') throw new Error('Stream construction failed');
    if (fault.mode === 'OPEN_EEXIST') fs.writeFileSync(path, 'occupied');
    const stream = fs.createWriteStream(path, options);
    if (fault.mode === 'WRITE_FAILURE' || (fault.mode === 'FIRST_WRITE_FAILURE' && fault.ownedPaths.length === 1)) stream._write = (_chunk, _encoding, callback) => callback(Object.assign(new Error('Disk full'), { code: 'ENOSPC' }));
    return stream;
  }) as typeof fs.createWriteStream };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs,
    writeFile: (async (...args) => {
      if (fault.mode === 'MANIFEST_WRITE_FAILURE' && String(args[0]).endsWith('manifest.tmp')) throw new Error('Manifest write failed');
      return fs.writeFile(...args);
    }) as typeof fs.writeFile,
    rename: (async (from, to) => {
      if (fault.mode === 'PUBLICATION_RACE') await new Promise((resolve) => setTimeout(resolve, 20));
      if (fault.mode === 'DATA_RENAME_FAILURE' && String(to).endsWith('.ndjson')) throw new Error('Data rename failed');
      if (fault.mode === 'MANIFEST_RENAME_FAILURE' && String(to).endsWith('.json')) throw new Error('Manifest rename failed');
      return fs.rename(from, to);
    }) as typeof fs.rename,
  };
});

let directory: string;
beforeEach(async () => { fault.mode = ''; fault.ownedPaths = []; directory = await mkdtemp(join(tmpdir(), 'b1-concurrent-export-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function fixture(pair = 'B-BTC_USDT') {
  const repository = new MemoryCandleRepository();
  for (const candle of makeCanonicalRange(3, BASE, pair)) await repository.insertCandle(candle);
  const service = new HistoricalDatasetService({ reader: repository, repository, manifests: new MemoryManifestRepository(), clock: new FakeClock(BASE + 600_000), pageMinutes: 1 });
  const manifest = await service.createManifest(pair, BASE, BASE + 180_000);
  const getRange = repository.getRange.bind(repository);
  vi.spyOn(repository, 'getRange').mockImplementation(async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return getRange(...args);
  });
  return { service, manifest, repository };
}

async function assertArtifact(service: HistoricalDatasetService, datasetId: string, output = directory) {
  const files = await readdir(output);
  expect(files.filter((file) => file.startsWith('.'))).toEqual([]);
  const manifestPath = join(output, `dataset-${datasetId}.manifest.json`);
  const dataPath = join(output, `dataset-${datasetId}.candles.ndjson`);
  expect((await readFile(dataPath, 'utf8')).trim().split('\n')).toHaveLength(3);
  expect((await service.importDataset(manifestPath, dataPath)).datasetId).toBe(datasetId);
  return [await readFile(manifestPath, 'utf8'), await readFile(dataPath, 'utf8')];
}

describe('Audit B1 concurrent export ownership and publication', () => {
  it.each([2, 3])('%i simultaneous same-destination exports settle with valid bytes and no orphan artifacts', async (count) => {
    const { service, manifest } = await fixture();
    fault.mode = 'PUBLICATION_RACE';
    const results = await Promise.allSettled(Array.from({ length: count }, () => service.exportDataset(manifest.datasetId, directory)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'MANIFEST_CONFLICT' });
    expect(new Set(fault.ownedPaths).size).toBe(count);
    const before = await assertArtifact(service, manifest.datasetId);
    fault.mode = '';
    await service.exportDataset(manifest.datasetId, directory);
    expect(await assertArtifact(service, manifest.datasetId)).toEqual(before);
    expect(await readdir(directory)).toHaveLength(2);
  });

  it('exports the same dataset to different destinations with identical bytes', async () => {
    const { service, manifest } = await fixture();
    const other = join(directory, 'other');
    await Promise.all([service.exportDataset(manifest.datasetId, directory), service.exportDataset(manifest.datasetId, other)]);
    expect(await assertArtifact(service, manifest.datasetId, other)).toEqual(await assertArtifact(service, manifest.datasetId));
  });

  it('exports BTC and ETH independently while publication overlaps', async () => {
    const btc = await fixture(); const eth = await fixture('B-ETH_USDT');
    fault.mode = 'PUBLICATION_RACE';
    await Promise.all([btc.service.exportDataset(btc.manifest.datasetId, directory), eth.service.exportDataset(eth.manifest.datasetId, directory)]);
    await assertArtifact(btc.service, btc.manifest.datasetId);
    await assertArtifact(eth.service, eth.manifest.datasetId);
    expect(await readdir(directory)).toHaveLength(4);
  });

  it.each(['CREATE_FAILURE', 'OPEN_EEXIST', 'WRITE_FAILURE', 'MANIFEST_WRITE_FAILURE', 'DATA_RENAME_FAILURE', 'MANIFEST_RENAME_FAILURE'])('%s settles, removes its artifacts, and permits a clean retry', async (mode) => {
    const { service, manifest } = await fixture();
    fault.mode = mode;
    await expect(service.exportDataset(manifest.datasetId, directory)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
    fault.mode = '';
    await service.exportDataset(manifest.datasetId, directory);
    await assertArtifact(service, manifest.datasetId);
  });

  it('preserves valid existing bytes when concurrent operations fail', async () => {
    const { service, manifest } = await fixture();
    await service.exportDataset(manifest.datasetId, directory);
    const before = await assertArtifact(service, manifest.datasetId);
    fault.mode = 'WRITE_FAILURE';
    const results = await Promise.allSettled([service.exportDataset(manifest.datasetId, directory), service.exportDataset(manifest.datasetId, directory)]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(await assertArtifact(service, manifest.datasetId)).toEqual(before);
  });

  it('one failed operation cannot remove a concurrent successful operation\'s temporary data', async () => {
    const { service, manifest } = await fixture();
    fault.mode = 'FIRST_WRITE_FAILURE';
    const results = await Promise.allSettled([service.exportDataset(manifest.datasetId, directory), service.exportDataset(manifest.datasetId, directory)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(new Set(fault.ownedPaths).size).toBe(2);
    await assertArtifact(service, manifest.datasetId);
  });

  it('owns verification read-stream errors and preserves the existing artifact', async () => {
    const { service, manifest } = await fixture();
    await service.exportDataset(manifest.datasetId, directory);
    const before = await assertArtifact(service, manifest.datasetId);
    fault.mode = 'EXISTING_READ_FAILURE';
    await expect(service.exportDataset(manifest.datasetId, directory)).rejects.toThrow('Artifact read failed');
    fault.mode = '';
    expect(await assertArtifact(service, manifest.datasetId)).toEqual(before);
  });

  it.each([2, 3, 'OPEN_EEXIST'] as const)('survives in an unguarded child process: %s', async (scenario) => {
    // No uncaughtException/unhandledRejection handlers: an unowned stream error
    // kills this process and makes execFile reject, as in the original defect.
    const script = `
      const fs = require('node:fs');
      const fsp = require('node:fs/promises');
      const { errorMonitor } = require('node:events');
      const original = fs.createWriteStream;
      let ownedErrors = 0;
      fs.createWriteStream = (path, options) => {
        if (${JSON.stringify(scenario)} === 'OPEN_EEXIST') fs.writeFileSync(path, 'occupied');
        const stream = original(path, options);
        stream.on(errorMonitor, () => { if (stream.listenerCount('error') > 0) ownedErrors++; });
        return stream;
      };
      const { HistoricalDatasetService } = require('./src/market-data/historical');
      const { FakeClock } = require('./src/integration/coindcx/clock');
      const { MemoryCandleRepository, MemoryManifestRepository, makeCanonicalRange, BASE_START_MS } = require('./tests/unit/market-data/historical/test-helpers');
      (async () => {
        const repo = new MemoryCandleRepository();
        for (const row of makeCanonicalRange(3)) await repo.insertCandle(row);
        const service = new HistoricalDatasetService({reader:repo,repository:repo,manifests:new MemoryManifestRepository(),clock:new FakeClock(BASE_START_MS+600000)});
        const manifest = await service.createManifest('B-BTC_USDT', BASE_START_MS, BASE_START_MS+180000);
        const read = repo.getRange.bind(repo);
        repo.getRange = async (...args) => { await new Promise(r => setTimeout(r, 30)); return read(...args); };
        const output = process.argv[1];
        const results = await Promise.allSettled(Array.from({length:${typeof scenario === 'number' ? scenario : 2}}, () => service.exportDataset(manifest.datasetId, output)));
        const files = await fsp.readdir(output);
        let valid = false;
        const success = results.find(r => r.status === 'fulfilled');
        if (success) valid = (await service.importDataset(success.value.manifestFilePath, success.value.ndjsonFilePath)).datasetId === manifest.datasetId;
        process.stdout.write(JSON.stringify({ statuses:results.map(r => r.status), files, valid, ownedErrors }));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--require', 'tsx/cjs', '--eval', script, directory], { cwd: process.cwd(), timeout: 20_000 });
    expect(stderr).toBe('');
    const proof = JSON.parse(stdout) as { statuses: string[]; files: string[]; valid: boolean; ownedErrors: number };
    expect(proof.statuses).toHaveLength(typeof scenario === 'number' ? scenario : 2);
    expect(proof.files.some((file) => file.startsWith('.'))).toBe(false);
    if (scenario === 'OPEN_EEXIST') {
      expect(proof.statuses).toEqual(['rejected', 'rejected']);
      expect(proof.ownedErrors).toBe(2);
      expect(proof.files).toEqual([]);
    } else {
      expect(proof.statuses).toContain('fulfilled');
      expect(proof.valid).toBe(true);
      expect(proof.files).toHaveLength(2);
    }
  }, 30_000);
});
