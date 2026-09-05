import { Decimal } from '../../../src/core/decimal/decimal';
import { FakeClock } from '../../../src/integration/coindcx/clock';
import {
  CoinDcxStreamEnvelope,
  PublicCandleUpdatePayload,
} from '../../../src/integration/coindcx/websocket/types';
import { CanonicalCandleConflictError } from '../../../src/market-data/errors';
import { areCanonicalCandlesIdentical } from '../../../src/market-data/models';
import { Candle1mRepository, InsertCandleResult } from '../../../src/market-data/persistence/candle-repository';
import {
  FetchCandlesQuery,
  RestCandleRecord,
} from '../../../src/market-data/rest-candle-reader';
import { CanonicalCandle1m } from '../../../src/market-data/types';
import { WorkingCandleSnapshot } from '../../../src/market-data/working-candle';
import { ManualScheduler } from '../coindcx/ws/test-helpers';

export { FakeClock, ManualScheduler };

export const TEST_BASE_MINUTE_MS = 1700000040000;

/**
 * Creates a valid test PublicCandleUpdatePayload for a given openTimeMs.
 */
export function createTestCandlePayload(
  overrides: Partial<PublicCandleUpdatePayload> = {}
): PublicCandleUpdatePayload {
  const openTimeMs = overrides.openTimeMs ?? TEST_BASE_MINUTE_MS;
  return {
    pair: 'B-BTC_USDT',
    duration: '1m',
    open: new Decimal('50000.0'),
    high: new Decimal('50100.0'),
    low: new Decimal('49900.0'),
    close: new Decimal('50050.0'),
    volume: new Decimal('10.5'),
    quoteVolume: new Decimal('525000.0'),
    openTimeMs,
    closeTimeMs: openTimeMs + 59999,
    isClosed: false,
    providerEventTimeMs: overrides.providerEventTimeMs ?? openTimeMs + 30000,
    rawChannel: 'B-BTC_USDT_1m-futures',
    ...overrides,
  };
}

/**
 * Creates a test WorkingCandleSnapshot.
 */
export function createTestWorkingSnapshot(
  overrides: Partial<WorkingCandleSnapshot> = {}
): WorkingCandleSnapshot {
  const openTimeMs = overrides.openTimeMs ?? TEST_BASE_MINUTE_MS;
  return {
    pair: 'B-BTC_USDT',
    openTimeMs,
    closeTimeMs: openTimeMs + 59999,
    open: new Decimal('50000.0'),
    high: new Decimal('50100.0'),
    low: new Decimal('49900.0'),
    close: new Decimal('50050.0'),
    volume: new Decimal('10.5'),
    quoteVolume: new Decimal('525000.0'),
    providerEventTimeMs: overrides.providerEventTimeMs ?? openTimeMs + 30000,
    sequence: overrides.sequence ?? 1,
    receivedAtMs: overrides.receivedAtMs ?? openTimeMs + 30100,
    generationId: overrides.generationId ?? 1,
    rawChannel: 'B-BTC_USDT_1m-futures',
    ...overrides,
  };
}

/**
 * Creates a test CoinDcxStreamEnvelope.
 */
export function createTestEnvelope<T>(
  eventType: 'PUBLIC_CANDLE_UPDATE' | 'PUBLIC_STREAM_RECOVERY_REQUIRED',
  payload: T,
  options: {
    generationId?: number;
    sequence?: number;
    receivedAtMs?: number;
    pair?: string | null;
  } = {}
): CoinDcxStreamEnvelope<T> {
  return {
    source: 'COINDCX',
    stream: 'PUBLIC_FUTURES',
    generationId: options.generationId ?? 1,
    sequence: options.sequence ?? 1,
    receivedAtMs: options.receivedAtMs ?? 1700000000000,
    eventType: eventType as CoinDcxStreamEnvelope<T>['eventType'],
    providerTimestampMs: 1700000000000,
    pair: options.pair ?? 'B-BTC_USDT',
    payload,
  };
}

/**
 * In-memory implementation of Candle1mRepository for fast, deterministic unit testing.
 */
export class InMemoryCandleRepository implements Candle1mRepository {
  public readonly candles = new Map<string, Map<number, CanonicalCandle1m>>();
  public insertCalls: CanonicalCandle1m[] = [];

  public async insertCandle(candle: CanonicalCandle1m): Promise<InsertCandleResult> {
    this.insertCalls.push(candle);
    let pairMap = this.candles.get(candle.pair);
    if (!pairMap) {
      pairMap = new Map<number, CanonicalCandle1m>();
      this.candles.set(candle.pair, pairMap);
    }

    const existing = pairMap.get(candle.openTimeMs);
    if (existing) {
      if (areCanonicalCandlesIdentical(existing, candle)) {
        return { outcome: 'ALREADY_IDENTICAL' };
      }
      throw new CanonicalCandleConflictError(
        `Canonical candle conflict for ${candle.pair} at openTime ${candle.openTimeMs}: incoming candle materially differs from persisted canonical truth`
      );
    }

    pairMap.set(candle.openTimeMs, candle);
    return { outcome: 'INSERTED' };
  }

  public async getLatestCanonicalCandle(pair: string): Promise<CanonicalCandle1m | null> {
    const pairMap = this.candles.get(pair);
    if (!pairMap || pairMap.size === 0) return null;

    let latest: CanonicalCandle1m | null = null;
    for (const c of pairMap.values()) {
      if (!latest || c.openTimeMs > latest.openTimeMs) {
        latest = c;
      }
    }
    return latest;
  }

  public async getCandle(pair: string, openTimeMs: number): Promise<CanonicalCandle1m | null> {
    const pairMap = this.candles.get(pair);
    if (!pairMap) return null;
    return pairMap.get(openTimeMs) ?? null;
  }

  public clear(): void {
    this.candles.clear();
    this.insertCalls = [];
  }
}

/**
 * Mock REST reader for controlled injection of REST candle responses in recovery tests.
 */
export class MockFuturesCandleRestReader {
  public fetchCalls: FetchCandlesQuery[] = [];
  public recordsToReturn: RestCandleRecord[] = [];
  public errorToThrow: Error | null = null;

  public async fetchClosedCandles(query: FetchCandlesQuery): Promise<RestCandleRecord[]> {
    this.fetchCalls.push(query);
    if (this.errorToThrow) {
      throw this.errorToThrow;
    }
    return this.recordsToReturn.filter(
      (r) => r.pair === query.pair && r.openTimeMs >= query.fromMs && r.openTimeMs <= query.toMs
    );
  }
}
