import { createHash } from 'node:crypto';
import type { Canonical1mRangeReader } from '../market-data/higher-timeframe/types';
import { MINUTE_MS } from '../market-data/higher-timeframe/timeframe';
import { canonicalHashDecimal, computeDatasetId, encodeHistoricalLogicalRow } from '../market-data/historical';
import type { CanonicalCandle1m } from '../market-data/types';
import { createCanonicalCandle1m } from '../market-data/models';
import { CanonicalDecimal } from '../market-data/canonical-decimal';
import { BacktestError } from './errors';
import type { BacktestDatasetSource } from './types';
import type { NormalizedBacktestInputs } from './manifest';

export interface VerifiedDatasetEvidence {
  readonly actualCandleCount: number;
  readonly firstOpenTimeMs: number;
  readonly lastOpenTimeMs: number;
  readonly contentSha256: string;
  readonly datasetId: string;
  readonly sourceIdentity: string;
  readonly replayContentSha256: string;
}

function validateCandleStructure(candle: CanonicalCandle1m, pair: string): void {
  if (candle.pair !== pair) throw new BacktestError('DATASET_IDENTITY_MISMATCH', 'Candle pair differs from manifest pair');
  if (!(candle.open instanceof CanonicalDecimal) || !(candle.high instanceof CanonicalDecimal) ||
      !(candle.low instanceof CanonicalDecimal) || !(candle.close instanceof CanonicalDecimal) ||
      !(candle.volume instanceof CanonicalDecimal) || (candle.quoteVolume !== null && !(candle.quoteVolume instanceof CanonicalDecimal)) ||
      !Number.isSafeInteger(candle.openTimeMs) || candle.openTimeMs % MINUTE_MS !== 0 ||
      candle.closeTimeExclusiveMs !== candle.openTimeMs + MINUTE_MS ||
      candle.open.isNegative() || candle.high.isNegative() || candle.low.isNegative() || candle.close.isNegative() ||
      candle.volume.isNegative() || (candle.quoteVolume !== null && candle.quoteVolume.isNegative()) ||
      candle.high.lessThan(candle.low) || candle.high.lessThan(candle.open) || candle.high.lessThan(candle.close) ||
      candle.low.greaterThan(candle.open) || candle.low.greaterThan(candle.close)) {
    throw new BacktestError('DATASET_ORDER_VIOLATION', 'Canonical candle structure is invalid');
  }
}

async function assertSourceIdentity(source: BacktestDatasetSource, expected: string): Promise<void> {
  if (source.immutable !== true || source.sourceIdentity !== expected) {
    throw new BacktestError('DATASET_IDENTITY_MISMATCH', 'Dataset source identity changed');
  }
  try { await source.assertIdentity?.(expected); }
  catch (error) {
    throw new BacktestError('DATASET_IDENTITY_MISMATCH', 'Dataset source snapshot is no longer identical', { cause: error });
  }
}

async function readPage(
  source: BacktestDatasetSource,
  pair: string,
  fromInclusiveMs: number,
  toExclusiveMs: number,
): Promise<readonly CanonicalCandle1m[]> {
  try {
    return await source.getRange(pair, fromInclusiveMs, toExclusiveMs - MINUTE_MS);
  } catch (error) {
    if (error instanceof BacktestError) throw error;
    throw new BacktestError('BACKTEST_RUN_FAILED', 'Unable to read the canonical dataset source', { cause: error });
  }
}

export async function verifyHistoricalDataset(
  inputs: NormalizedBacktestInputs,
  source: BacktestDatasetSource,
): Promise<VerifiedDatasetEvidence> {
  await assertSourceIdentity(source, inputs.sourceIdentity);
  const manifest = inputs.dataset;
  const hash = createHash('sha256');
  const replayHash = createHash('sha256');
  let expectedOpenTimeMs = manifest.fromInclusiveMs;
  let firstOpenTimeMs: number | null = null;
  let lastOpenTimeMs: number | null = null;
  let actualCandleCount = 0;
  const pageDurationMs = inputs.verificationPageMinutes * MINUTE_MS;
  if (!Number.isSafeInteger(pageDurationMs)) throw new BacktestError('DATASET_RANGE_INVALID', 'Verification page duration is unsafe');
  for (let pageStart = manifest.fromInclusiveMs; pageStart < manifest.toExclusiveMs; pageStart += pageDurationMs) {
    const pageEnd = Math.min(pageStart + pageDurationMs, manifest.toExclusiveMs);
    const rows = await readPage(source, manifest.pair, pageStart, pageEnd);
    for (const candle of rows) {
      validateCandleStructure(candle, manifest.pair);
      if (candle.openTimeMs < pageStart || candle.openTimeMs >= pageEnd) {
        throw new BacktestError('DATASET_ORDER_VIOLATION', 'Dataset reader returned a row outside its requested page');
      }
      if (candle.openTimeMs < expectedOpenTimeMs) {
        throw new BacktestError('DATASET_ORDER_VIOLATION', 'Dataset contains a duplicate or backward row');
      }
      if (candle.openTimeMs > expectedOpenTimeMs) {
        throw new BacktestError('DATASET_GAP', `Dataset is missing the minute at ${expectedOpenTimeMs}`);
      }
      const encoded = encodeHistoricalLogicalRow({
        pair: candle.pair,
        openTimeMs: candle.openTimeMs,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        quoteVolume: candle.quoteVolume,
      });
      hash.update(encoded);
      if (candle.openTimeMs >= inputs.manifest.bootstrapFromInclusiveMs &&
          candle.openTimeMs < inputs.manifest.replayToExclusiveMs) replayHash.update(encoded);
      canonicalHashDecimal(candle.close);
      firstOpenTimeMs ??= candle.openTimeMs;
      lastOpenTimeMs = candle.openTimeMs;
      actualCandleCount++;
      expectedOpenTimeMs += MINUTE_MS;
    }
    if (expectedOpenTimeMs < pageEnd) {
      throw new BacktestError('DATASET_GAP', `Dataset page is incomplete at ${expectedOpenTimeMs}`);
    }
  }
  await assertSourceIdentity(source, inputs.sourceIdentity);
  const contentSha256 = hash.digest('hex');
  const datasetId = computeDatasetId(manifest.pair, manifest, contentSha256);
  const expectedCandleCount = (manifest.toExclusiveMs - manifest.fromInclusiveMs) / MINUTE_MS;
  if (actualCandleCount !== expectedCandleCount || actualCandleCount !== manifest.expectedCandleCount ||
      actualCandleCount !== manifest.actualCandleCount || firstOpenTimeMs !== manifest.firstOpenTimeMs ||
      lastOpenTimeMs !== manifest.lastOpenTimeMs || contentSha256 !== manifest.contentSha256 ||
      datasetId !== manifest.datasetId) {
    throw new BacktestError('DATASET_IDENTITY_MISMATCH', 'Canonical stream does not exactly match its Phase 7 manifest');
  }
  return Object.freeze({
    actualCandleCount,
    firstOpenTimeMs,
    lastOpenTimeMs,
    contentSha256,
    datasetId,
    sourceIdentity: inputs.sourceIdentity,
    replayContentSha256: replayHash.digest('hex'),
  });
}

export async function* replayVerifiedDataset(
  inputs: NormalizedBacktestInputs,
  source: BacktestDatasetSource,
  expectedReplayContentSha256?: string,
): AsyncGenerator<CanonicalCandle1m> {
  await assertSourceIdentity(source, inputs.sourceIdentity);
  const { bootstrapFromInclusiveMs, replayToExclusiveMs, pair } = inputs.manifest;
  const pageDurationMs = inputs.verificationPageMinutes * MINUTE_MS;
  let expectedOpenTimeMs = bootstrapFromInclusiveMs;
  const replayHash = createHash('sha256');
  for (let pageStart = bootstrapFromInclusiveMs; pageStart < replayToExclusiveMs; pageStart += pageDurationMs) {
    await assertSourceIdentity(source, inputs.sourceIdentity);
    const pageEnd = Math.min(pageStart + pageDurationMs, replayToExclusiveMs);
    const rows = await readPage(source, pair, pageStart, pageEnd);
    for (const candle of rows) {
      validateCandleStructure(candle, pair);
      if (candle.openTimeMs < expectedOpenTimeMs) {
        throw new BacktestError('DATASET_ORDER_VIOLATION', 'Replay contains duplicate or backward rows');
      }
      if (candle.openTimeMs > expectedOpenTimeMs) {
        throw new BacktestError('DATASET_GAP', 'Replay contains a missing minute');
      }
      if (candle.openTimeMs < pageStart || candle.openTimeMs >= pageEnd) {
        throw new BacktestError('DATASET_ORDER_VIOLATION', 'Replay reader returned a row outside the requested page');
      }
      expectedOpenTimeMs += MINUTE_MS;
      replayHash.update(encodeHistoricalLogicalRow({
        pair: candle.pair,
        openTimeMs: candle.openTimeMs,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        quoteVolume: candle.quoteVolume,
      }));
      yield candle;
    }
    if (expectedOpenTimeMs !== pageEnd) throw new BacktestError('DATASET_GAP', 'Replay page is incomplete');
  }
  await assertSourceIdentity(source, inputs.sourceIdentity);
  if (expectedOpenTimeMs !== replayToExclusiveMs) throw new BacktestError('DATASET_GAP', 'Replay range is incomplete');
  const replayContentSha256 = replayHash.digest('hex');
  if (expectedReplayContentSha256 !== undefined && replayContentSha256 !== expectedReplayContentSha256) {
    throw new BacktestError('DATASET_IDENTITY_MISMATCH', 'Pass 2 replay bytes differ from the verified Pass 1 source');
  }
}

export class PagedBacktestDatasetSource implements BacktestDatasetSource {
  public readonly immutable = true as const;
  public constructor(
    public readonly sourceIdentity: string,
    readonly reader: Canonical1mRangeReader,
    readonly identityCheck?: (expectedSourceIdentity: string) => Promise<void> | void,
  ) {
    if (sourceIdentity.length === 0) throw new BacktestError('INVALID_BACKTEST_CONFIG', 'Source identity is required');
    Object.freeze(this);
  }
  public getRange(pair: string, fromInclusiveMs: number, toInclusiveMs: number): Promise<readonly CanonicalCandle1m[]> {
    return this.reader.getRange(pair, fromInclusiveMs, toInclusiveMs);
  }
  public assertIdentity(expectedSourceIdentity: string): Promise<void> | void {
    if (expectedSourceIdentity !== this.sourceIdentity) throw new BacktestError('DATASET_IDENTITY_MISMATCH', 'Source identity mismatch');
    return this.identityCheck?.(expectedSourceIdentity);
  }
}

export class InMemoryBacktestDatasetSource implements BacktestDatasetSource {
  public readonly immutable = true as const;
  readonly #candles: readonly CanonicalCandle1m[];
  public constructor(public readonly sourceIdentity: string, candles: readonly CanonicalCandle1m[]) {
    this.#candles = Object.freeze(candles.map((candle) => createCanonicalCandle1m({
      pair: candle.pair,
      openTimeMs: candle.openTimeMs,
      open: candle.open.value,
      high: candle.high.value,
      low: candle.low.value,
      close: candle.close.value,
      volume: candle.volume.value,
      quoteVolume: candle.quoteVolume?.value ?? null,
      source: candle.source,
      finalizedAtMs: candle.finalizedAtMs,
      providerEventTimeMs: candle.providerEventTimeMs,
      generationId: candle.generationId,
    })));
    Object.freeze(this);
  }
  public async getRange(pair: string, fromInclusiveMs: number, toInclusiveMs: number): Promise<readonly CanonicalCandle1m[]> {
    return Object.freeze(this.#candles.filter((candle) => candle.pair === pair && candle.openTimeMs >= fromInclusiveMs && candle.openTimeMs <= toInclusiveMs));
  }
  public assertIdentity(expectedSourceIdentity: string): void {
    if (expectedSourceIdentity !== this.sourceIdentity) throw new BacktestError('DATASET_IDENTITY_MISMATCH', 'Source identity mismatch');
  }
}
