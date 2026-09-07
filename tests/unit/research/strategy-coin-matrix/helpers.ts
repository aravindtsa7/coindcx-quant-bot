import { createHash } from 'node:crypto';
import {
  BacktestDecimal,
  InMemoryBacktestDatasetSource,
  computeBacktestFundingScheduleContentSha256,
  computeBacktestInstrumentSpecSnapshotId,
  type BacktestDatasetSource,
  type BacktestFundingSchedule,
  type BacktestInstrumentSpec,
} from '../../../../src/backtest';
import { createCanonicalCandle1m } from '../../../../src/market-data/models';
import { computeDatasetId, encodeHistoricalLogicalRow, type HistoricalDatasetManifest } from '../../../../src/market-data/historical';
import type { CanonicalCandle1m } from '../../../../src/market-data/types';
import {
  PHASE10_STRATEGY_DEFINITIONS,
  StrategyRegistry,
} from '../../../../src/strategies';
import type {
  MatrixPairExecutionResources,
  StrategyCoinMatrixPlanInput,
} from '../../../../src/research/strategy-coin-matrix';
import { StrategyCoinMatrixError } from '../../../../src/research/strategy-coin-matrix/errors';
import type { GitSourceVerifier } from '../../../../src/research/strategy-coin-matrix/git-source';

export const BASE = 1_704_067_200_000;
export const COMMIT_A = 'a'.repeat(40);
export const COMMIT_B = 'b'.repeat(40);

export function registry(): StrategyRegistry {
  const result = new StrategyRegistry();
  for (const definition of PHASE10_STRATEGY_DEFINITIONS) result.register(definition);
  return result;
}

export function candles(pair: string, count = 24): readonly CanonicalCandle1m[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => createCanonicalCandle1m({
    pair,
    openTimeMs: BASE + index * 60_000,
    open: '100',
    high: '101',
    low: '99',
    close: index % 2 === 0 ? '100' : '100.5',
    volume: '10',
    quoteVolume: null,
    source: 'REST_HISTORICAL',
    finalizedAtMs: BASE + (index + 1) * 60_000,
    providerEventTimeMs: null,
    generationId: null,
  })));
}

export function datasetManifest(rows: readonly CanonicalCandle1m[]): HistoricalDatasetManifest {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(encodeHistoricalLogicalRow(row));
  const contentSha256 = hash.digest('hex');
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first === undefined || last === undefined) throw new Error('Fixture requires candles');
  const range = { fromInclusiveMs: first.openTimeMs, toExclusiveMs: last.closeTimeExclusiveMs };
  return Object.freeze({
    datasetId: computeDatasetId(first.pair, range, contentSha256),
    schemaVersion: 1,
    venue: 'COINDCX',
    market: 'FUTURES',
    resolutionMinutes: 1,
    pair: first.pair,
    ...range,
    expectedCandleCount: rows.length,
    actualCandleCount: rows.length,
    firstOpenTimeMs: first.openTimeMs,
    lastOpenTimeMs: last.openTimeMs,
    contentSha256,
    createdAt: new Date(0),
  });
}

export function instrument(pair: string): BacktestInstrumentSpec {
  const identity = {
    pair,
    priceIncrement: new BacktestDecimal('0.01'),
    quantityIncrement: new BacktestDecimal('0.001'),
    minQuantity: new BacktestDecimal('0.001'),
    minTradeSize: new BacktestDecimal('0.001'),
    minNotional: new BacktestDecimal('0.01'),
    contractMultiplier: new BacktestDecimal('1'),
  };
  return Object.freeze({ ...identity, instrumentSpecSnapshotId: computeBacktestInstrumentSpecSnapshotId(identity) });
}

export function resources(pair: string, source?: BacktestDatasetSource): MatrixPairExecutionResources {
  const rows = candles(pair);
  const dataset = datasetManifest(rows);
  const fundingSchedule: BacktestFundingSchedule = Object.freeze({
    sourceId: `funding-${pair}`,
    contentSha256: computeBacktestFundingScheduleContentSha256([]),
    fidelity: 'TEST_ONLY',
    events: Object.freeze([]),
  });
  return Object.freeze({
    pair,
    datasetManifest: dataset,
    datasetSource: source ?? new InMemoryBacktestDatasetSource(`memory-${pair}`, rows),
    instrumentSpec: instrument(pair),
    fundingSchedule,
  });
}

export function matrixInput(pairResources: readonly MatrixPairExecutionResources[], allStrategies = true): StrategyCoinMatrixPlanInput {
  const strategies = allStrategies ? [
    { strategyId: 'EMA_TREND', strategyVersion: '1.0.0', candidateSpace: { strategyId: 'EMA_TREND', strategyVersion: '1.0.0', dimensions: { slowPeriod: [2], priceSource: ['CLOSE'], fastPeriod: [1], timeframeMinutes: [1] } } },
    { strategyId: 'ATR_BREAKOUT', strategyVersion: '1.0.0', candidateSpace: { strategyId: 'ATR_BREAKOUT', strategyVersion: '1.0.0', dimensions: { breakoutMultiplier: ['1.0'], atrPeriod: [1], timeframeMinutes: [1] } } },
    { strategyId: 'RSI_MOMENTUM', strategyVersion: '1.0.0', candidateSpace: { strategyId: 'RSI_MOMENTUM', strategyVersion: '1.0.0', dimensions: { shortThreshold: ['30'], period: [1], timeframeMinutes: [1], priceSource: ['CLOSE'], longThreshold: ['70'] } } },
    { strategyId: 'MULTI_TIMEFRAME_TREND', strategyVersion: '1.0.0', candidateSpace: { strategyId: 'MULTI_TIMEFRAME_TREND', strategyVersion: '1.0.0', dimensions: { timeframes: [[2, 1]], slowPeriod: [2], priceSource: ['CLOSE'], fastPeriod: [1] } } },
  ] : [
    { strategyId: 'EMA_TREND', strategyVersion: '1.0.0', candidateSpace: { strategyId: 'EMA_TREND', strategyVersion: '1.0.0', dimensions: { timeframeMinutes: [1], fastPeriod: [1], slowPeriod: [2], priceSource: ['CLOSE'] } } },
  ];
  return {
    planName: 'phase-11-test',
    bootstrapPolicyId: 'P11_INDICATOR_BOOTSTRAP_V1',
    researchWindow: { analysisStartMs: BASE + 12 * 60_000, analysisEndExclusiveMs: BASE + 20 * 60_000 },
    pairs: pairResources.map((resource) => ({
      pair: resource.pair,
      datasetBinding: { pair: resource.pair, datasetId: resource.datasetManifest.datasetId, datasetContentSha256: resource.datasetManifest.contentSha256 },
      fixedResearchQuantity: resource.pair === 'BTC-INR' ? '0.01' : '0.1',
      instrumentSpecSnapshotId: resource.instrumentSpec.instrumentSpecSnapshotId,
      fundingScheduleBinding: {
        sourceId: resource.fundingSchedule.sourceId,
        contentSha256: resource.fundingSchedule.contentSha256,
        fidelity: resource.fundingSchedule.fidelity,
      },
    })),
    strategies,
    backtestConfig: {
      initialEquity: '10000.00',
      costModel: { makerFeeRate: '0', takerFeeRate: '0', halfSpreadBps: '0', marketSlippageBps: '0', stopSlippageBps: '0' },
      intrabarAmbiguityPolicy: 'ADVERSE_FIRST',
      maxOpenOrders: 20,
      engineSemanticVersion: '9.0.0',
    },
  };
}

export class ControlledGitVerifier implements GitSourceVerifier {
  public assertions = 0;
  public constructor(
    private readonly commit = COMMIT_A,
    private readonly failAtAssertion: number | null = null,
    private readonly failureCode: 'MATRIX_SOURCE_DIRTY' | 'MATRIX_SOURCE_COMMIT_MISMATCH' = 'MATRIX_SOURCE_DIRTY',
  ) {}
  public async capture(): Promise<string> { return this.commit; }
  public async assertExpected(expected: string): Promise<void> {
    this.assertions += 1;
    if (expected !== this.commit) throw new StrategyCoinMatrixError('MATRIX_SOURCE_COMMIT_MISMATCH', 'controlled mismatch');
    if (this.failAtAssertion !== null && this.assertions >= this.failAtAssertion) {
      throw new StrategyCoinMatrixError(this.failureCode, 'controlled invalidation');
    }
  }
}
