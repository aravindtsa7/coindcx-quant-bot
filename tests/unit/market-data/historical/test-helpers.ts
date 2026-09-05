import { createCanonicalCandle1m, areCanonicalCandlesIdentical } from '../../../../src/market-data/models';
import { Canonical1mRangeReader } from '../../../../src/market-data/higher-timeframe/types';
import { Candle1mRepository, InsertCandleResult } from '../../../../src/market-data/persistence/candle-repository';
import { CanonicalCandle1m, CanonicalCandleSource } from '../../../../src/market-data/types';
import {
  HistoricalDatasetManifest,
  HistoricalManifestRepository,
  HistoricalDatasetError,
} from '../../../../src/market-data/historical';
import { CanonicalCandleConflictError } from '../../../../src/market-data/errors';

export const BASE_START_MS = 1704067200000; // 2024-01-01T00:00:00.000Z
export const DEFAULT_TEST_PAIR = 'B-BTC_USDT';

export interface MakeTestCandleParams {
  readonly pair?: string;
  readonly openTimeMs: number;
  readonly open?: string;
  readonly high?: string;
  readonly low?: string;
  readonly close?: string;
  readonly volume?: string;
  readonly quoteVolume?: string | null;
  readonly source?: CanonicalCandleSource;
  readonly finalizedAtMs?: number;
  readonly providerEventTimeMs?: number | null;
  readonly generationId?: number | null;
}

export function makeTestCandle(params: MakeTestCandleParams): CanonicalCandle1m {
  const pair = params.pair ?? DEFAULT_TEST_PAIR;
  const open = params.open ?? '100.00';
  const high = params.high ?? '110.00';
  const low = params.low ?? '95.00';
  const close = params.close ?? '105.00';
  const volume = params.volume ?? '10.00';
  const quoteVolume = params.quoteVolume === undefined ? null : params.quoteVolume;
  const source = params.source ?? 'REST_HISTORICAL';
  const finalizedAtMs = params.finalizedAtMs ?? params.openTimeMs + 60_000;
  return createCanonicalCandle1m({
    pair,
    openTimeMs: params.openTimeMs,
    open,
    high,
    low,
    close,
    volume,
    quoteVolume,
    source,
    finalizedAtMs,
    providerEventTimeMs: params.providerEventTimeMs ?? null,
    generationId: params.generationId ?? null,
  });
}

export function makeCanonicalRange(
  count: number,
  startMs: number = BASE_START_MS,
  pair: string = DEFAULT_TEST_PAIR,
  overrides?: Partial<MakeTestCandleParams>
): CanonicalCandle1m[] {
  const candles: CanonicalCandle1m[] = [];
  for (let i = 0; i < count; i++) {
    const openTimeMs = startMs + i * 60_000;
    candles.push(
      makeTestCandle({
        pair,
        openTimeMs,
        open: '100.00',
        high: '110.00',
        low: '95.00',
        close: '105.00',
        volume: '10.00',
        quoteVolume: null,
        source: 'REST_HISTORICAL',
        ...overrides,
      })
    );
  }
  return candles;
}

export class MemoryCandleRepository implements Candle1mRepository, Canonical1mRangeReader {
  public readonly rows = new Map<number, CanonicalCandle1m>();
  public insertCalls: CanonicalCandle1m[] = [];
  public getRangeCalls: Array<{ pair: string; fromInclusiveMs: number; toInclusiveMs: number }> = [];
  public failOnInsertPredicate?: ((candle: CanonicalCandle1m) => boolean) | undefined;

  public async insertCandle(candle: CanonicalCandle1m): Promise<InsertCandleResult> {
    this.insertCalls.push(candle);
    if (this.failOnInsertPredicate && this.failOnInsertPredicate(candle)) {
      throw new Error('Simulated database crash on insertCandle');
    }
    const existing = this.rows.get(candle.openTimeMs);
    if (existing) {
      if (areCanonicalCandlesIdentical(existing, candle)) {
        return { outcome: 'ALREADY_IDENTICAL' };
      }
      throw new CanonicalCandleConflictError(
        `Conflict at ${candle.openTimeMs}: incoming differs from stored`
      );
    }
    this.rows.set(candle.openTimeMs, candle);
    return { outcome: 'INSERTED' };
  }

  public async getCandle(pair: string, openTimeMs: number): Promise<CanonicalCandle1m | null> {
    const candle = this.rows.get(openTimeMs);
    if (candle && candle.pair === pair) return candle;
    return null;
  }

  public async getLatestCanonicalCandle(pair: string): Promise<CanonicalCandle1m | null> {
    let latest: CanonicalCandle1m | null = null;
    for (const candle of this.rows.values()) {
      if (candle.pair === pair && (!latest || candle.openTimeMs > latest.openTimeMs)) {
        latest = candle;
      }
    }
    return latest;
  }

  public async getRange(
    pair: string,
    fromInclusiveMs: number,
    toInclusiveMs: number
  ): Promise<readonly CanonicalCandle1m[]> {
    this.getRangeCalls.push({ pair, fromInclusiveMs, toInclusiveMs });
    return [...this.rows.values()]
      .filter((c) => c.pair === pair && c.openTimeMs >= fromInclusiveMs && c.openTimeMs <= toInclusiveMs)
      .sort((a, b) => a.openTimeMs - b.openTimeMs);
  }
}

export class MemoryManifestRepository implements HistoricalManifestRepository {
  public readonly manifestsById = new Map<string, HistoricalDatasetManifest>();
  public readonly manifestsByRange = new Map<string, HistoricalDatasetManifest>();
  public insertCalls: Array<Omit<HistoricalDatasetManifest, 'createdAt'>> = [];

  private rangeKey(pair: string, from: number, to: number): string {
    return `${pair}:${from}:${to}`;
  }

  public async getByDatasetId(datasetId: string): Promise<HistoricalDatasetManifest | null> {
    return this.manifestsById.get(datasetId) ?? null;
  }

  public async getByRange(
    pair: string,
    fromInclusiveMs: number,
    toExclusiveMs: number
  ): Promise<HistoricalDatasetManifest | null> {
    return this.manifestsByRange.get(this.rangeKey(pair, fromInclusiveMs, toExclusiveMs)) ?? null;
  }

  public async insert(manifest: Omit<HistoricalDatasetManifest, 'createdAt'>): Promise<HistoricalDatasetManifest> {
    this.insertCalls.push(manifest);
    const key = this.rangeKey(manifest.pair, manifest.fromInclusiveMs, manifest.toExclusiveMs);
    if (this.manifestsByRange.has(key) || this.manifestsById.has(manifest.datasetId)) {
      throw new HistoricalDatasetError('MANIFEST_CONFLICT', 'Manifest already exists');
    }
    const created: HistoricalDatasetManifest = Object.freeze({
      ...manifest,
      createdAt: new Date(),
    });
    this.manifestsById.set(created.datasetId, created);
    this.manifestsByRange.set(key, created);
    return created;
  }
}
