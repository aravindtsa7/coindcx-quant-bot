import { createHash } from 'node:crypto';
import { createCanonicalCandle1m } from '../../../src/market-data/models';
import type { CanonicalCandle1m } from '../../../src/market-data/types';
import {
  computeDatasetId,
  encodeHistoricalLogicalRow,
  type HistoricalDatasetManifest,
} from '../../../src/market-data/historical';
import {
  BacktestDecimal,
  InMemoryBacktestDatasetSource,
  canonicalJson,
  sha256CanonicalJson,
  type BacktestActionBatch,
  type BacktestEngineConfig,
  type BacktestEvent,
  type BacktestParticipantAdapter,
} from '../../../src/backtest';

export const BASE = 1_704_067_200_000;
export const PAIR = 'B-BTC_INR';

export function candle(index: number, values: Partial<Record<'open' | 'high' | 'low' | 'close' | 'volume', string>> = {}, pair = PAIR): CanonicalCandle1m {
  return createCanonicalCandle1m({
    pair,
    openTimeMs: BASE + index * 60_000,
    open: values.open ?? '100',
    high: values.high ?? '110',
    low: values.low ?? '90',
    close: values.close ?? '100',
    volume: values.volume ?? '10',
    quoteVolume: null,
    source: 'REST_HISTORICAL',
    finalizedAtMs: BASE + (index + 1) * 60_000,
    providerEventTimeMs: null,
    generationId: null,
  });
}

export function manifest(candles: readonly CanonicalCandle1m[]): HistoricalDatasetManifest {
  const hash = createHash('sha256');
  for (const row of candles) hash.update(encodeHistoricalLogicalRow(row));
  const contentSha256 = hash.digest('hex');
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (!first || !last) throw new Error('fixture needs candles');
  const range = { fromInclusiveMs: first.openTimeMs, toExclusiveMs: last.closeTimeExclusiveMs };
  return Object.freeze({
    datasetId: computeDatasetId(first.pair, range, contentSha256),
    schemaVersion: 1,
    venue: 'COINDCX',
    market: 'FUTURES',
    resolutionMinutes: 1,
    pair: first.pair,
    ...range,
    expectedCandleCount: candles.length,
    actualCandleCount: candles.length,
    firstOpenTimeMs: first.openTimeMs,
    lastOpenTimeMs: last.openTimeMs,
    contentSha256,
    createdAt: new Date(0),
  });
}

export class ScriptedParticipant implements BacktestParticipantAdapter {
  public readonly contexts: Parameters<BacktestParticipantAdapter['onEvaluation']>[0][] = [];
  public constructor(private readonly actions: readonly BacktestActionBatch[] = []) {}
  public onEvaluation(context: Parameters<BacktestParticipantAdapter['onEvaluation']>[0]): BacktestActionBatch {
    this.contexts.push(context);
    return this.actions[this.contexts.length - 1] ?? {};
  }
}

export function config(
  candles: readonly CanonicalCandle1m[],
  participant: BacktestParticipantAdapter = new ScriptedParticipant(),
  overrides: Partial<BacktestEngineConfig> = {},
): BacktestEngineConfig {
  const dataManifest = manifest(candles);
  const instrumentIdentity = {
    pair: PAIR,
    priceIncrement: '0.01',
    quantityIncrement: '0.001',
    minQuantity: '0.001',
    minTradeSize: '0.001',
    minNotional: '1',
    contractMultiplier: '1',
  };
  const defaultConfig: BacktestEngineConfig = {
    datasetManifest: dataManifest,
    datasetSource: new InMemoryBacktestDatasetSource('fixture-source-v1', candles),
    bootstrapFromInclusiveMs: dataManifest.fromInclusiveMs,
    evaluationFromInclusiveMs: dataManifest.fromInclusiveMs + 60_000,
    evaluationToExclusiveMs: dataManifest.toExclusiveMs,
    replayToExclusiveMs: dataManifest.toExclusiveMs,
    configuredTimeframes: [],
    instrumentSpec: {
      pair: PAIR,
      priceIncrement: new BacktestDecimal(instrumentIdentity.priceIncrement),
      quantityIncrement: new BacktestDecimal(instrumentIdentity.quantityIncrement),
      minQuantity: new BacktestDecimal(instrumentIdentity.minQuantity),
      minTradeSize: new BacktestDecimal(instrumentIdentity.minTradeSize),
      minNotional: new BacktestDecimal(instrumentIdentity.minNotional),
      contractMultiplier: new BacktestDecimal(instrumentIdentity.contractMultiplier),
      instrumentSpecSnapshotId: sha256CanonicalJson(instrumentIdentity),
    },
    costModel: {
      makerFeeRate: new BacktestDecimal('0.001'),
      takerFeeRate: new BacktestDecimal('0.002'),
      halfSpreadBps: new BacktestDecimal('10'),
      marketSlippageBps: new BacktestDecimal('20'),
      stopSlippageBps: new BacktestDecimal('30'),
    },
    fundingSchedule: {
      sourceId: 'fixture-funding',
      contentSha256: sha256CanonicalJson([]),
      fidelity: 'TEST_ONLY',
      events: [],
    },
    participant,
    participantIdentity: {
      participantId: 'fixture-participant',
      participantVersion: '1.0.0',
      parameterHash: sha256CanonicalJson({ parameters: 'fixture' }),
      gitCommitHash: 'fixture-commit',
    },
    initialEquity: new BacktestDecimal('10000'),
  };
  return { ...defaultConfig, ...overrides };
}

export function eventTypes(events: readonly BacktestEvent[]): string[] {
  return events.map((event) => event.type);
}

export function logical(value: unknown): string { return canonicalJson(value); }
