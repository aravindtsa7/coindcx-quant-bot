import { Decimal } from '../../../src/core/decimal/decimal';
import { CanonicalMarketDataEngine } from '../../../src/market-data/canonical-engine';
import { createCanonicalCandle1m } from '../../../src/market-data/models';
import { CoinDcxFuturesCandleRestReader, RestCandleRecord } from '../../../src/market-data/rest-candle-reader';
import { CanonicalCandle1m } from '../../../src/market-data/types';
import { PublicCandleUpdatePayload } from '../../../src/integration/coindcx/websocket/types';
import { createTestCandlePayload, createTestEnvelope, FakeClock, InMemoryCandleRepository, ManualScheduler, MockFuturesCandleRestReader } from './test-helpers';
export { deferred, flushQueues } from './higher-timeframe/helpers';
export const T = Date.UTC(2026, 8, 8, 12);
export const M = 60_000;
export const P = 'B-BTC_USDT';

export function setup(now = T + 5 * M) {
  const clock = new FakeClock(now);
  const scheduler = new ManualScheduler();
  const repository = new InMemoryCandleRepository();
  const rest = new MockFuturesCandleRestReader();
  const engine = new CanonicalMarketDataEngine({ clock, scheduler, repository, restReader: rest as unknown as CoinDcxFuturesCandleRestReader });
  return { clock, scheduler, repository, rest, engine };
}

export function payload(t: number, overrides: Partial<PublicCandleUpdatePayload> = {}): PublicCandleUpdatePayload {
  return createTestCandlePayload({ pair: P, openTimeMs: t, providerEventTimeMs: t + 1000, open: new Decimal('100'), high: new Decimal('120'), low: new Decimal('90'), close: new Decimal('100'), volume: new Decimal('10'), quoteVolume: null, ...overrides });
}

export function update(t: number, generationId = 1, overrides: Partial<PublicCandleUpdatePayload> = {}, sequence = 1) {
  return createTestEnvelope('PUBLIC_CANDLE_UPDATE', payload(t, overrides), { generationId, sequence, receivedAtMs: t + 1000 });
}

export function barrier(generationId = 2) {
  return createTestEnvelope('PUBLIC_STREAM_RECOVERY_REQUIRED', { previousGeneration: generationId - 1, newGeneration: generationId, disconnectReceivedAtMs: T, reconnectedAtMs: T + 1000, lastValidProviderTimestampByPair: {} }, { generationId });
}

export function final(t: number, overrides: Partial<Parameters<typeof createCanonicalCandle1m>[0]> = {}): CanonicalCandle1m {
  return createCanonicalCandle1m({ ...payload(t), source: 'REST_RECOVERY', finalizedAtMs: t + M, generationId: null, providerEventTimeMs: null, ...overrides });
}

export function record(t: number): RestCandleRecord { return { ...payload(t) }; }
