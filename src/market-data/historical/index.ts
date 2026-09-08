import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../persistence/prisma';
import { Clock, SystemClock } from '../../integration/coindcx/clock';
import { CanonicalDecimal } from '../canonical-decimal';
import { canonicalFixedPointIdentity } from '../fixed-point-identity';
import { Decimal } from '../../core/decimal/decimal';
import { createCanonicalCandle1m } from '../models';
import { Candle1mRepository } from '../persistence/candle-repository';
import { Canonical1mRangeReader } from '../higher-timeframe/types';
import { CanonicalCandle1m } from '../types';

const MIN_OPEN_TIME_MS = 1577836800000;
const MINUTE_MS = 60_000;
const DEFAULT_PAGE_MINUTES = 1440;
const PAIR_PATTERN = /^[A-Z0-9_.-]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type HistoricalDatasetErrorCode =
  | 'INVALID_RANGE' | 'REST_FAILURE' | 'REST_INCOMPLETE' | 'CANONICAL_VALIDATION_FAILURE'
  | 'CANONICAL_CONFLICT' | 'DB_FAILURE' | 'DATASET_INCOMPLETE' | 'HASH_MISMATCH'
  | 'IMPORT_FORMAT_INVALID' | 'TOCTOU_VIOLATION' | 'MANIFEST_CONFLICT';

export class HistoricalDatasetError extends Error {
  public readonly code: HistoricalDatasetErrorCode;
  constructor(code: HistoricalDatasetErrorCode, message: string) {
    super(message);
    this.name = 'HistoricalDatasetError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface HistoricalRange { readonly fromInclusiveMs: number; readonly toExclusiveMs: number; }
export interface HistoricalDatasetManifest {
  readonly datasetId: string; readonly schemaVersion: 1; readonly venue: 'COINDCX'; readonly market: 'FUTURES';
  readonly resolutionMinutes: 1; readonly pair: string; readonly fromInclusiveMs: number; readonly toExclusiveMs: number;
  readonly expectedCandleCount: number; readonly actualCandleCount: number; readonly firstOpenTimeMs: number;
  readonly lastOpenTimeMs: number; readonly contentSha256: string; readonly createdAt: Date;
}
export interface BackfillRequest extends HistoricalRange { readonly pair: string; readonly chunkMinutes?: number; }
export interface BackfillProgress {
  readonly pair: string; readonly chunkIndex: number; readonly totalChunks: number; readonly currentChunkStartMs: number;
  readonly currentChunkEndMs: number; readonly candlesFetchedFromRest: number; readonly candlesAlreadyInDb: number;
}
export interface HistoricalRestCandleRecord {
  readonly pair: string; readonly openTimeMs: number; readonly open: CanonicalDecimal | Decimal; readonly high: CanonicalDecimal | Decimal;
  readonly low: CanonicalDecimal | Decimal; readonly close: CanonicalDecimal | Decimal; readonly volume: CanonicalDecimal | Decimal;
  readonly quoteVolume: CanonicalDecimal | Decimal | null;
}
export interface HistoricalRestReader {
  fetchClosedCandles(query: { pair: string; fromMs: number; toMs: number }): Promise<readonly HistoricalRestCandleRecord[]>;
}
export interface HistoricalManifestRepository {
  getByDatasetId(datasetId: string): Promise<HistoricalDatasetManifest | null>;
  getByRange(pair: string, fromInclusiveMs: number, toExclusiveMs: number): Promise<HistoricalDatasetManifest | null>;
  insert(manifest: Omit<HistoricalDatasetManifest, 'createdAt'>): Promise<HistoricalDatasetManifest>;
}

export function validateHistoricalPair(pair: string): string {
  if (!PAIR_PATTERN.test(pair)) throw new HistoricalDatasetError('CANONICAL_VALIDATION_FAILURE', 'Historical pair is invalid');
  return pair;
}

export function validateHistoricalRange(range: HistoricalRange, clock: Clock = new SystemClock()): HistoricalRange {
  const { fromInclusiveMs, toExclusiveMs } = range;
  if (!Number.isSafeInteger(fromInclusiveMs) || !Number.isSafeInteger(toExclusiveMs) ||
      fromInclusiveMs % MINUTE_MS !== 0 || toExclusiveMs % MINUTE_MS !== 0 ||
      fromInclusiveMs < MIN_OPEN_TIME_MS || fromInclusiveMs >= toExclusiveMs ||
      toExclusiveMs > Math.floor(clock.nowMs() / MINUTE_MS) * MINUTE_MS) {
    throw new HistoricalDatasetError('INVALID_RANGE', 'Historical range must be closed-minute, safe, aligned, and half-open');
  }
  return range;
}

export function planHistoricalChunks(range: HistoricalRange, chunkMinutes = DEFAULT_PAGE_MINUTES): readonly HistoricalRange[] {
  if (!Number.isSafeInteger(chunkMinutes) || chunkMinutes <= 0 || chunkMinutes > Math.floor(Number.MAX_SAFE_INTEGER / MINUTE_MS)) {
    throw new HistoricalDatasetError('INVALID_RANGE', 'chunkMinutes must be a positive safe integer');
  }
  const chunkMs = chunkMinutes * MINUTE_MS;
  const chunks: HistoricalRange[] = [];
  for (let start = range.fromInclusiveMs; start < range.toExclusiveMs; start += chunkMs) {
    chunks.push(Object.freeze({ fromInclusiveMs: start, toExclusiveMs: Math.min(start + chunkMs, range.toExclusiveMs) }));
  }
  return Object.freeze(chunks);
}

function validateExistingRows(pair: string, range: HistoricalRange, rows: readonly CanonicalCandle1m[]): void {
  let previous: number | null = null;
  for (const row of rows) {
    if (row.pair !== pair || row.openTimeMs < range.fromInclusiveMs || row.openTimeMs >= range.toExclusiveMs ||
        (previous !== null && row.openTimeMs <= previous)) {
      throw new HistoricalDatasetError('CANONICAL_VALIDATION_FAILURE', 'Existing canonical rows are malformed or unordered');
    }
    try { createCanonicalCandle1m(row); } catch { throw new HistoricalDatasetError('CANONICAL_VALIDATION_FAILURE', 'Existing canonical row is invalid'); }
    previous = row.openTimeMs;
  }
}

export function findMissingMinuteSpans(pair: string, range: HistoricalRange, rows: readonly CanonicalCandle1m[]): readonly HistoricalRange[] {
  validateHistoricalPair(pair); validateExistingRows(pair, range, rows);
  const spans: HistoricalRange[] = [];
  let expected = range.fromInclusiveMs;
  for (const row of rows) {
    if (row.openTimeMs > expected) spans.push(Object.freeze({ fromInclusiveMs: expected, toExclusiveMs: row.openTimeMs }));
    expected = row.openTimeMs + MINUTE_MS;
  }
  if (expected < range.toExclusiveMs) spans.push(Object.freeze({ fromInclusiveMs: expected, toExclusiveMs: range.toExclusiveMs }));
  return Object.freeze(spans);
}

/** Exact textual normalization for hash bytes; it never performs financial arithmetic. */
export function canonicalHashDecimal(value: CanonicalDecimal | string): string {
  const raw = value instanceof CanonicalDecimal ? value.value : value;
  return canonicalFixedPointIdentity(CanonicalDecimal.from(raw).value);
}

export interface HistoricalLogicalRow {
  readonly pair: string; readonly openTimeMs: number; readonly open: CanonicalDecimal; readonly high: CanonicalDecimal;
  readonly low: CanonicalDecimal; readonly close: CanonicalDecimal; readonly volume: CanonicalDecimal; readonly quoteVolume: CanonicalDecimal | null;
}

export function encodeHistoricalLogicalRow(row: HistoricalLogicalRow): Buffer {
  validateHistoricalPair(row.pair);
  if (!Number.isSafeInteger(row.openTimeMs) || row.openTimeMs % MINUTE_MS !== 0) {
    throw new HistoricalDatasetError('CANONICAL_VALIDATION_FAILURE', 'Logical row time is invalid');
  }
  const values = [row.pair, String(row.openTimeMs), canonicalHashDecimal(row.open), canonicalHashDecimal(row.high),
    canonicalHashDecimal(row.low), canonicalHashDecimal(row.close), canonicalHashDecimal(row.volume),
    row.quoteVolume === null ? 'N' : canonicalHashDecimal(row.quoteVolume)];
  return Buffer.from(`${values.join('|')}\n`, 'utf8');
}

export function computeDatasetId(pair: string, range: HistoricalRange, contentSha256: string): string {
  validateHistoricalPair(pair);
  if (!SHA256_PATTERN.test(contentSha256)) throw new HistoricalDatasetError('HASH_MISMATCH', 'contentSha256 is invalid');
  const envelope = `schemaVersion:1\nvenue:COINDCX\nmarket:FUTURES\npair:${pair}\nfromInclusiveMs:${range.fromInclusiveMs}\ntoExclusiveMs:${range.toExclusiveMs}\nresolutionMinutes:1\ncontentSha256:${contentSha256}\n`;
  return createHash('sha256').update(Buffer.from(envelope, 'utf8')).digest('hex');
}

interface VerificationResult {
  readonly expectedCandleCount: number; readonly actualCandleCount: number; readonly firstOpenTimeMs: number;
  readonly lastOpenTimeMs: number; readonly contentSha256: string;
}

async function verifyCanonicalRange(
  reader: Canonical1mRangeReader, pair: string, range: HistoricalRange, pageMinutes: number,
  onRow?: (row: CanonicalCandle1m) => Promise<void>
): Promise<VerificationResult> {
  if (!Number.isSafeInteger(pageMinutes) || pageMinutes <= 0) throw new HistoricalDatasetError('INVALID_RANGE', 'pageMinutes must be positive');
  const hash = createHash('sha256'); let previous: number | null = null; let count = 0;
  for (const page of planHistoricalChunks(range, pageMinutes)) {
    let rows: readonly CanonicalCandle1m[];
    try { rows = await reader.getRange(pair, page.fromInclusiveMs, page.toExclusiveMs - MINUTE_MS); }
    catch { throw new HistoricalDatasetError('DB_FAILURE', 'Unable to read canonical range'); }
    validateExistingRows(pair, page, rows);
    for (const row of rows) {
      if (previous !== null && row.openTimeMs !== previous + MINUTE_MS) {
        throw new HistoricalDatasetError('DATASET_INCOMPLETE', 'Canonical range has a missing or discontinuous minute');
      }
      hash.update(encodeHistoricalLogicalRow(row));
      if (onRow) await onRow(row);
      previous = row.openTimeMs; count++;
    }
  }
  const expected = (range.toExclusiveMs - range.fromInclusiveMs) / MINUTE_MS;
  if (count !== expected || previous !== range.toExclusiveMs - MINUTE_MS) {
    throw new HistoricalDatasetError('DATASET_INCOMPLETE', 'Canonical range is incomplete');
  }
  return Object.freeze({ expectedCandleCount: expected, actualCandleCount: count, firstOpenTimeMs: range.fromInclusiveMs,
    lastOpenTimeMs: range.toExclusiveMs - MINUTE_MS, contentSha256: hash.digest('hex') });
}

export class HistoricalBackfillService {
  readonly #reader: Canonical1mRangeReader; readonly #repository: Candle1mRepository; readonly #rest: HistoricalRestReader; readonly #clock: Clock;
  constructor(dependencies: { reader: Canonical1mRangeReader; repository: Candle1mRepository; restReader: HistoricalRestReader; clock?: Clock }) {
    this.#reader = dependencies.reader; this.#repository = dependencies.repository; this.#rest = dependencies.restReader; this.#clock = dependencies.clock ?? new SystemClock();
  }
  public async backfill(request: BackfillRequest, onProgress?: (progress: BackfillProgress) => void): Promise<{ pair: string; fromInclusiveMs: number; toExclusiveMs: number; totalCandles: number; insertedCount: number; existingCount: number }> {
    validateHistoricalPair(request.pair); validateHistoricalRange(request, this.#clock);
    const chunks = planHistoricalChunks(request, request.chunkMinutes); let insertedCount = 0; let existingCount = 0;
    for (const [chunkIndex, chunk] of chunks.entries()) {
      let existing: readonly CanonicalCandle1m[];
      try { existing = await this.#reader.getRange(request.pair, chunk.fromInclusiveMs, chunk.toExclusiveMs - MINUTE_MS); }
      catch { throw new HistoricalDatasetError('DB_FAILURE', 'Unable to read backfill chunk'); }
      const missing = findMissingMinuteSpans(request.pair, chunk, existing); existingCount += existing.length; let fetched = 0;
      for (const span of missing) {
        let records: readonly HistoricalRestCandleRecord[];
        try { records = await this.#rest.fetchClosedCandles({ pair: request.pair, fromMs: span.fromInclusiveMs, toMs: span.toExclusiveMs - MINUTE_MS }); }
        catch { throw new HistoricalDatasetError('REST_FAILURE', 'Historical REST request failed'); }
        if (!isExactRestSpan(request.pair, span, records)) throw new HistoricalDatasetError('REST_INCOMPLETE', 'Historical REST response does not exactly cover requested span');
        for (const record of records) {
          const candle = createCanonicalCandle1m({ ...record, source: 'REST_HISTORICAL', finalizedAtMs: record.openTimeMs + MINUTE_MS, providerEventTimeMs: null, generationId: null });
          try { const result = await this.#repository.insertCandle(candle); if (result.outcome === 'INSERTED') insertedCount++; else existingCount++; }
          catch { throw new HistoricalDatasetError('CANONICAL_CONFLICT', 'Historical candle conflicts with canonical truth'); }
          fetched++;
        }
      }
      await verifyCanonicalRange(this.#reader, request.pair, chunk, request.chunkMinutes ?? DEFAULT_PAGE_MINUTES);
      onProgress?.({ pair: request.pair, chunkIndex, totalChunks: chunks.length, currentChunkStartMs: chunk.fromInclusiveMs,
        currentChunkEndMs: chunk.toExclusiveMs, candlesFetchedFromRest: fetched, candlesAlreadyInDb: existing.length });
    }
    return Object.freeze({ pair: request.pair, fromInclusiveMs: request.fromInclusiveMs, toExclusiveMs: request.toExclusiveMs,
      totalCandles: (request.toExclusiveMs - request.fromInclusiveMs) / MINUTE_MS, insertedCount, existingCount });
  }
}

function isExactRestSpan(pair: string, span: HistoricalRange, records: readonly HistoricalRestCandleRecord[]): boolean {
  const count = (span.toExclusiveMs - span.fromInclusiveMs) / MINUTE_MS;
  if (records.length !== count) return false;
  return records.every((record, index) => record.pair === pair && record.openTimeMs === span.fromInclusiveMs + index * MINUTE_MS);
}

export class PrismaHistoricalManifestRepository implements HistoricalManifestRepository {
  readonly #prisma: PrismaClient;
  constructor(prismaClient: PrismaClient = defaultPrisma) { this.#prisma = prismaClient; }
  public async getByDatasetId(datasetId: string): Promise<HistoricalDatasetManifest | null> {
    const row = await this.#prisma.historicalDataset.findUnique({ where: { datasetId } }); return row ? mapManifest(row) : null;
  }
  public async getByRange(pair: string, fromInclusiveMs: number, toExclusiveMs: number): Promise<HistoricalDatasetManifest | null> {
    const row = await this.#prisma.historicalDataset.findUnique({ where: { pair_fromInclusiveMs_toExclusiveMs: { pair, fromInclusiveMs: BigInt(fromInclusiveMs), toExclusiveMs: BigInt(toExclusiveMs) } } });
    return row ? mapManifest(row) : null;
  }
  public async insert(manifest: Omit<HistoricalDatasetManifest, 'createdAt'>): Promise<HistoricalDatasetManifest> {
    try {
      const row = await this.#prisma.historicalDataset.create({ data: { ...manifest, fromInclusiveMs: BigInt(manifest.fromInclusiveMs), toExclusiveMs: BigInt(manifest.toExclusiveMs), firstOpenTimeMs: BigInt(manifest.firstOpenTimeMs), lastOpenTimeMs: BigInt(manifest.lastOpenTimeMs) } });
      return mapManifest(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new HistoricalDatasetError('MANIFEST_CONFLICT', 'Manifest unique identity already exists');
      throw new HistoricalDatasetError('DB_FAILURE', 'Unable to persist historical manifest');
    }
  }
}

function mapManifest(row: { datasetId: string; schemaVersion: number; venue: string; market: string; resolutionMinutes: number; pair: string; fromInclusiveMs: bigint; toExclusiveMs: bigint; expectedCandleCount: number; actualCandleCount: number; firstOpenTimeMs: bigint; lastOpenTimeMs: bigint; contentSha256: string; createdAt: Date }): HistoricalDatasetManifest {
  if (row.schemaVersion !== 1 || row.venue !== 'COINDCX' || row.market !== 'FUTURES' || row.resolutionMinutes !== 1 || !SHA256_PATTERN.test(row.datasetId) || !SHA256_PATTERN.test(row.contentSha256)) throw new HistoricalDatasetError('MANIFEST_CONFLICT', 'Persisted manifest is invalid');
  return Object.freeze({ ...row, schemaVersion: 1, venue: 'COINDCX', market: 'FUTURES', resolutionMinutes: 1, fromInclusiveMs: Number(row.fromInclusiveMs), toExclusiveMs: Number(row.toExclusiveMs), firstOpenTimeMs: Number(row.firstOpenTimeMs), lastOpenTimeMs: Number(row.lastOpenTimeMs) });
}

export class HistoricalDatasetService {
  readonly #reader: Canonical1mRangeReader; readonly #repository: Candle1mRepository; readonly #manifests: HistoricalManifestRepository; readonly #clock: Clock; readonly #pageMinutes: number;
  constructor(dependencies: { reader: Canonical1mRangeReader; repository: Candle1mRepository; manifests: HistoricalManifestRepository; clock?: Clock; pageMinutes?: number }) {
    this.#reader = dependencies.reader; this.#repository = dependencies.repository; this.#manifests = dependencies.manifests; this.#clock = dependencies.clock ?? new SystemClock(); this.#pageMinutes = dependencies.pageMinutes ?? DEFAULT_PAGE_MINUTES;
  }
  public async createManifest(pair: string, fromInclusiveMs: number, toExclusiveMs: number): Promise<HistoricalDatasetManifest> {
    validateHistoricalPair(pair); const range = validateHistoricalRange({ fromInclusiveMs, toExclusiveMs }, this.#clock);
    const verified = await verifyCanonicalRange(this.#reader, pair, range, this.#pageMinutes); const datasetId = computeDatasetId(pair, range, verified.contentSha256);
    const candidate = { datasetId, schemaVersion: 1 as const, venue: 'COINDCX' as const, market: 'FUTURES' as const, resolutionMinutes: 1 as const, pair, ...range, ...verified };
    const existing = await this.#manifests.getByRange(pair, fromInclusiveMs, toExclusiveMs);
    if (existing) { if (sameManifestIdentity(existing, candidate)) return existing; throw new HistoricalDatasetError('MANIFEST_CONFLICT', 'Existing manifest differs from canonical truth'); }
    try { return await this.#manifests.insert(candidate); }
    catch (error) {
      if (!(error instanceof HistoricalDatasetError) || error.code !== 'MANIFEST_CONFLICT') throw error;
      const raced = await this.#manifests.getByRange(pair, fromInclusiveMs, toExclusiveMs);
      if (raced && sameManifestIdentity(raced, candidate)) return raced;
      throw error;
    }
  }
  public async getManifest(datasetId: string): Promise<HistoricalDatasetManifest | null> {
    if (!SHA256_PATTERN.test(datasetId)) throw new HistoricalDatasetError('IMPORT_FORMAT_INVALID', 'datasetId is invalid');
    return this.#manifests.getByDatasetId(datasetId);
  }
  public async verifyDataset(datasetId: string): Promise<{ readonly isValid: boolean; readonly error?: string }> {
    const manifest = await this.getManifest(datasetId); if (!manifest) throw new HistoricalDatasetError('DATASET_INCOMPLETE', 'Historical dataset manifest was not found');
    try { const verified = await verifyCanonicalRange(this.#reader, manifest.pair, manifest, this.#pageMinutes); const id = computeDatasetId(manifest.pair, manifest, verified.contentSha256); if (!sameManifestIdentity(manifest, { ...manifest, ...verified, datasetId: id })) throw new HistoricalDatasetError('HASH_MISMATCH', 'Dataset no longer matches manifest'); return { isValid: true }; }
    catch (error) { return { isValid: false, error: error instanceof Error ? error.message : 'Dataset verification failed' }; }
  }
  public async exportDataset(datasetId: string, outputDirectory: string): Promise<{ readonly manifestFilePath: string; readonly ndjsonFilePath: string }> {
    const manifest = await this.getManifest(datasetId); if (!manifest) throw new HistoricalDatasetError('DATASET_INCOMPLETE', 'Historical dataset manifest was not found');
    await mkdir(outputDirectory, { recursive: true });
    const stem = `dataset-${manifest.datasetId}`;
    const dataPath = join(outputDirectory, `${stem}.candles.ndjson`);
    const manifestPath = join(outputDirectory, `${stem}.manifest.json`);
    const operationDirectory = await mkdtemp(join(outputDirectory, `.${stem}.`));
    const tempPath = join(operationDirectory, 'candles.tmp');
    const tempManifestPath = join(operationDirectory, 'manifest.tmp');
    try {
      const stream = createWriteStream(tempPath, { encoding: 'utf8', flags: 'wx' });
      // Own errors before any asynchronous reader work. Consume rejection immediately,
      // and retain finished's error listener through destroy/close and cleanup.
      const completion = finished(stream).then(() => null, (error: unknown) => ({ error }));
      try {
        const verified = await verifyCanonicalRange(this.#reader, manifest.pair, manifest, this.#pageMinutes, async (row) => {
          if (stream.destroyed) throw stream.errored ?? new Error('Export stream closed');
          await new Promise<void>((resolve, reject) => {
            stream.write(`${JSON.stringify(logicalJson(row))}\n`, (error) => error ? reject(error) : resolve());
          });
        });
        stream.end();
        const outcome = await completion;
        if (outcome) throw outcome.error;
        const id = computeDatasetId(manifest.pair, manifest, verified.contentSha256);
        if (!sameManifestIdentity(manifest, { ...manifest, ...verified, datasetId: id })) throw new HistoricalDatasetError('HASH_MISMATCH', 'Exported DB truth does not match manifest');
      } finally {
        stream.destroy();
        await completion;
      }
      await writeFile(tempManifestPath, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', flag: 'wx' });
      await publishExport(outputDirectory, stem, tempPath, tempManifestPath, dataPath, manifestPath, manifest);
      return { manifestFilePath: manifestPath, ndjsonFilePath: dataPath };
    } finally { await rm(operationDirectory, { recursive: true, force: true }); }
  }
  public async importDataset(manifestFilePath: string, ndjsonFilePath: string): Promise<HistoricalDatasetManifest> {
    const snapshotDir = await mkdtemp(join(tmpdir(), 'coindcx-phase7-')); const snapshotPath = join(snapshotDir, basename(ndjsonFilePath));
    try {
      await copyFile(ndjsonFilePath, snapshotPath); const manifest = parseManifest(JSON.parse(await readFile(manifestFilePath, 'utf8')));
      validateHistoricalPair(manifest.pair); validateHistoricalRange(manifest, this.#clock);
      const passOne = await verifyArtifact(snapshotPath, manifest); if (passOne.contentSha256 !== manifest.contentSha256 || computeDatasetId(manifest.pair, manifest, passOne.contentSha256) !== manifest.datasetId) throw new HistoricalDatasetError('HASH_MISMATCH', 'Artifact identity does not match manifest');
      for await (const row of readArtifactRows(snapshotPath, manifest)) {
        const candle = createCanonicalCandle1m({ ...row, source: 'REST_HISTORICAL', finalizedAtMs: row.openTimeMs + MINUTE_MS, providerEventTimeMs: null, generationId: null });
        try { await this.#repository.insertCandle(candle); } catch { throw new HistoricalDatasetError('CANONICAL_CONFLICT', 'Imported candle conflicts with canonical truth'); }
      }
      const verified = await verifyCanonicalRange(this.#reader, manifest.pair, manifest, this.#pageMinutes); const id = computeDatasetId(manifest.pair, manifest, verified.contentSha256);
      if (!sameManifestIdentity(manifest, { ...manifest, ...verified, datasetId: id })) throw new HistoricalDatasetError('HASH_MISMATCH', 'Post-import canonical truth differs from artifact');
      return this.createManifest(manifest.pair, manifest.fromInclusiveMs, manifest.toExclusiveMs);
    } catch (error) { if (error instanceof HistoricalDatasetError) throw error; throw new HistoricalDatasetError('IMPORT_FORMAT_INVALID', 'Historical artifact is invalid'); }
    finally { await rm(snapshotDir, { recursive: true, force: true }); }
  }
}

function sameManifestIdentity(a: HistoricalDatasetManifest, b: Omit<HistoricalDatasetManifest, 'createdAt'> | HistoricalDatasetManifest): boolean {
  return a.datasetId === b.datasetId && a.schemaVersion === b.schemaVersion && a.venue === b.venue && a.market === b.market && a.resolutionMinutes === b.resolutionMinutes && a.pair === b.pair && a.fromInclusiveMs === b.fromInclusiveMs && a.toExclusiveMs === b.toExclusiveMs && a.expectedCandleCount === b.expectedCandleCount && a.actualCandleCount === b.actualCandleCount && a.firstOpenTimeMs === b.firstOpenTimeMs && a.lastOpenTimeMs === b.lastOpenTimeMs && a.contentSha256 === b.contentSha256;
}
function logicalJson(row: HistoricalLogicalRow): Record<string, string | number | null> { return { pair: row.pair, openTimeMs: row.openTimeMs, open: row.open.value, high: row.high.value, low: row.low.value, close: row.close.value, volume: row.volume.value, quoteVolume: row.quoteVolume?.value ?? null }; }
async function exportPathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function publishExport(directory: string, stem: string, tempData: string, tempManifest: string, dataPath: string, manifestPath: string, manifest: HistoricalDatasetManifest): Promise<void> {
  // Only publication to this destination is exclusive; streaming and other datasets
  // remain independent. A competing publisher receives a controlled conflict.
  const lockPath = join(directory, `.${stem}.publish`);
  try { await mkdir(lockPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new HistoricalDatasetError('MANIFEST_CONFLICT', 'Dataset export publication is already in progress');
    throw error;
  }
  try {
    const dataExists = await exportPathExists(dataPath);
    const manifestExists = await exportPathExists(manifestPath);
    if (dataExists || manifestExists) {
      if (!dataExists || !manifestExists) throw new HistoricalDatasetError('MANIFEST_CONFLICT', 'Destination contains an incomplete export');
      const existing = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
      const verified = await verifyArtifact(dataPath, existing);
      if (!sameManifestIdentity(manifest, existing) || verified.contentSha256 !== manifest.contentSha256) throw new HistoricalDatasetError('MANIFEST_CONFLICT', 'Destination differs from verified export');
      return;
    }
    await rename(tempData, dataPath);
    try { await rename(tempManifest, manifestPath); }
    catch (error) { await rm(dataPath, { force: true }); throw error; }
  } finally { await rm(lockPath, { recursive: true, force: true }); }
}

function parseManifest(input: unknown): HistoricalDatasetManifest {
  if (!isPlainRecord(input) || !exactKeys(input, ['datasetId', 'schemaVersion', 'venue', 'market', 'resolutionMinutes', 'pair', 'fromInclusiveMs', 'toExclusiveMs', 'expectedCandleCount', 'actualCandleCount', 'firstOpenTimeMs', 'lastOpenTimeMs', 'contentSha256', 'createdAt']) ||
      typeof input.datasetId !== 'string' || typeof input.contentSha256 !== 'string' || !SHA256_PATTERN.test(input.datasetId) || !SHA256_PATTERN.test(input.contentSha256) || input.schemaVersion !== 1 || input.venue !== 'COINDCX' || input.market !== 'FUTURES' || input.resolutionMinutes !== 1 || typeof input.pair !== 'string' || !safeIntegerFields(input, ['fromInclusiveMs', 'toExclusiveMs', 'expectedCandleCount', 'actualCandleCount', 'firstOpenTimeMs', 'lastOpenTimeMs']) || typeof input.createdAt !== 'string' || Number.isNaN(new Date(input.createdAt).getTime())) throw new HistoricalDatasetError('IMPORT_FORMAT_INVALID', 'Manifest has invalid strict schema');
  const fromInclusiveMs = numberField(input, 'fromInclusiveMs'); const toExclusiveMs = numberField(input, 'toExclusiveMs');
  const expectedCandleCount = numberField(input, 'expectedCandleCount'); const actualCandleCount = numberField(input, 'actualCandleCount');
  const firstOpenTimeMs = numberField(input, 'firstOpenTimeMs'); const lastOpenTimeMs = numberField(input, 'lastOpenTimeMs');
  const expectedFromRange = (toExclusiveMs - fromInclusiveMs) / MINUTE_MS;
  if (!Number.isSafeInteger(expectedFromRange) || expectedCandleCount !== expectedFromRange || actualCandleCount !== expectedFromRange || firstOpenTimeMs !== fromInclusiveMs || lastOpenTimeMs !== toExclusiveMs - MINUTE_MS) {
    throw new HistoricalDatasetError('IMPORT_FORMAT_INVALID', 'Manifest boundaries or candle counts are inconsistent');
  }
  return Object.freeze({ datasetId: input.datasetId, schemaVersion: 1, venue: 'COINDCX', market: 'FUTURES', resolutionMinutes: 1, pair: input.pair, fromInclusiveMs, toExclusiveMs, expectedCandleCount, actualCandleCount, firstOpenTimeMs, lastOpenTimeMs, contentSha256: input.contentSha256, createdAt: new Date(input.createdAt) });
}
async function verifyArtifact(path: string, manifest: HistoricalDatasetManifest): Promise<VerificationResult> { let count = 0; let previous: number | null = null; const hash = createHash('sha256'); for await (const row of readArtifactRows(path, manifest)) { if (previous !== null && row.openTimeMs !== previous + MINUTE_MS) throw new HistoricalDatasetError('IMPORT_FORMAT_INVALID', 'NDJSON minute sequence is discontinuous'); hash.update(encodeHistoricalLogicalRow(row)); previous = row.openTimeMs; count++; } if (count !== manifest.expectedCandleCount || count !== manifest.actualCandleCount || previous !== manifest.lastOpenTimeMs || manifest.firstOpenTimeMs !== manifest.fromInclusiveMs) throw new HistoricalDatasetError('DATASET_INCOMPLETE', 'Artifact is incomplete'); return { expectedCandleCount: manifest.expectedCandleCount, actualCandleCount: count, firstOpenTimeMs: manifest.fromInclusiveMs, lastOpenTimeMs: manifest.lastOpenTimeMs, contentSha256: hash.digest('hex') }; }
async function* readArtifactRows(path: string, manifest: HistoricalDatasetManifest): AsyncGenerator<HistoricalLogicalRow> {
  const input = createReadStream(path, { encoding: 'utf8' });
  const completion = finished(input).then(() => null, (error: unknown) => ({ error }));
  const reader = createInterface({ input, crlfDelay: Infinity });
  input.once('error', () => reader.close());
  try {
    let lineNumber = 0;
    for await (const line of reader) {
      lineNumber++;
      if (line === '') throw new HistoricalDatasetError('IMPORT_FORMAT_INVALID', 'Blank NDJSON line');
      let parsed: unknown;
      try { parsed = JSON.parse(line); }
      catch { throw new HistoricalDatasetError('IMPORT_FORMAT_INVALID', `Invalid NDJSON at line ${lineNumber}`); }
      const row = parseLogicalRow(parsed);
      if (row.pair !== manifest.pair || row.openTimeMs < manifest.fromInclusiveMs || row.openTimeMs >= manifest.toExclusiveMs) throw new HistoricalDatasetError('IMPORT_FORMAT_INVALID', 'NDJSON row outside manifest range');
      yield row;
    }
    const outcome = await completion;
    if (outcome) throw outcome.error;
  } finally {
    reader.close();
    input.destroy();
    await completion;
  }
}
function parseLogicalRow(input: unknown): HistoricalLogicalRow {
  if (!isPlainRecord(input) || !exactKeys(input, ['pair', 'openTimeMs', 'open', 'high', 'low', 'close', 'volume', 'quoteVolume']) || typeof input.pair !== 'string' || typeof input.open !== 'string' || typeof input.high !== 'string' || typeof input.low !== 'string' || typeof input.close !== 'string' || typeof input.volume !== 'string' || !(typeof input.quoteVolume === 'string' || input.quoteVolume === null)) throw new HistoricalDatasetError('IMPORT_FORMAT_INVALID', 'NDJSON row has invalid strict schema');
  const openTimeMs = numberField(input, 'openTimeMs');
  if (openTimeMs % MINUTE_MS !== 0) throw new HistoricalDatasetError('IMPORT_FORMAT_INVALID', 'NDJSON time is not minute aligned');
  const open = stringField(input, 'open'); const high = stringField(input, 'high'); const low = stringField(input, 'low'); const close = stringField(input, 'close'); const volume = stringField(input, 'volume');
  try { const row = { pair: input.pair, openTimeMs, open: CanonicalDecimal.from(open), high: CanonicalDecimal.from(high), low: CanonicalDecimal.from(low), close: CanonicalDecimal.from(close), volume: CanonicalDecimal.from(volume), quoteVolume: input.quoteVolume === null ? null : CanonicalDecimal.from(stringField(input, 'quoteVolume')) }; createCanonicalCandle1m({ ...row, source: 'REST_HISTORICAL', finalizedAtMs: row.openTimeMs + MINUTE_MS, providerEventTimeMs: null, generationId: null }); return row; } catch { throw new HistoricalDatasetError('IMPORT_FORMAT_INVALID', 'NDJSON decimal or OHLC value is invalid'); }
}
function isPlainRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value); return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function safeIntegerFields(value: Record<string, unknown>, keys: readonly string[]): boolean { return keys.every((key) => Number.isSafeInteger(value[key])); }
function numberField(value: Record<string, unknown>, key: string): number { const field = value[key]; if (!Number.isSafeInteger(field)) throw new HistoricalDatasetError('IMPORT_FORMAT_INVALID', `Invalid ${key}`); return field as number; }
function stringField(value: Record<string, unknown>, key: string): string { const field = value[key]; if (typeof field !== 'string' || field !== field.trim()) throw new HistoricalDatasetError('IMPORT_FORMAT_INVALID', `Invalid ${key}`); return field; }
