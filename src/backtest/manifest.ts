import type { HistoricalDatasetManifest } from '../market-data/historical';
import { bucketStartMs, assertValidTimeframeMinutes, MINUTE_MS } from '../market-data/higher-timeframe/timeframe';
import { BacktestDecimal, toBacktestCalcDecimal, BACKTEST_BPS_DIVISOR } from './decimal';
import { BacktestError } from './errors';
import { deepFreeze } from './immutable';
import { sha256CanonicalJson } from './canonical-json';
import { computeBacktestInstrumentSpecSnapshotId } from './instrument';
import type {
  BacktestCostModel,
  BacktestFundingSchedule,
  BacktestInstrumentSpec,
  BacktestParticipantIdentity,
  BacktestRunManifest,
} from './types';

export const DEFAULT_MAX_OPEN_ORDERS = 20;
export const MAX_OPEN_ORDERS = 100;
export const PHASE9_ENGINE_SEMANTIC_VERSION = '9.0.0';
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.:@/-]{1,256}$/;

export interface NormalizedBacktestInputs {
  readonly manifest: BacktestRunManifest;
  readonly runId: string;
  readonly dataset: Omit<HistoricalDatasetManifest, 'createdAt'>;
  readonly instrumentSpec: BacktestInstrumentSpec;
  readonly costModel: BacktestCostModel;
  readonly fundingSchedule: BacktestFundingSchedule;
  readonly configuredTimeframes: readonly number[];
  readonly sourceIdentity: string;
  readonly verificationPageMinutes: number;
}

function safeAligned(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value % MINUTE_MS !== 0) {
    throw new BacktestError('DATASET_RANGE_INVALID', `${label} must be a safe minute-aligned integer`);
  }
}

function normalizeTimeframes(values: readonly number[]): readonly number[] {
  const sorted = [...values].sort((left, right) => left - right);
  for (const value of sorted) {
    try { assertValidTimeframeMinutes(value); }
    catch (error) { throw new BacktestError('TIMEFRAME_CONFIGURATION_INVALID', 'Invalid higher timeframe', { cause: error }); }
  }
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index] === sorted[index - 1]) {
      throw new BacktestError('TIMEFRAME_CONFIGURATION_INVALID', 'Duplicate higher timeframe');
    }
  }
  return Object.freeze(sorted);
}

function normalizeInstrument(spec: BacktestInstrumentSpec, pair: string): BacktestInstrumentSpec {
  if (spec.pair !== pair) throw new BacktestError('INSTRUMENT_CONSTRAINT_VIOLATION', 'Instrument pair does not match dataset');
  if (!SHA256.test(spec.instrumentSpecSnapshotId)) {
    throw new BacktestError('INSTRUMENT_CONSTRAINT_VIOLATION', 'Instrument snapshot identity must be lowercase SHA-256');
  }
  const normalized = {
    pair: spec.pair,
    priceIncrement: new BacktestDecimal(spec.priceIncrement),
    quantityIncrement: new BacktestDecimal(spec.quantityIncrement),
    minQuantity: new BacktestDecimal(spec.minQuantity),
    minTradeSize: new BacktestDecimal(spec.minTradeSize),
    minNotional: new BacktestDecimal(spec.minNotional),
    contractMultiplier: new BacktestDecimal(spec.contractMultiplier),
    instrumentSpecSnapshotId: spec.instrumentSpecSnapshotId,
  };
  for (const [name, value] of Object.entries(normalized)) {
    if (value instanceof BacktestDecimal && toBacktestCalcDecimal(value).lessThanOrEqualTo(0)) {
      throw new BacktestError('INSTRUMENT_CONSTRAINT_VIOLATION', `${name} must be positive`);
    }
  }
  if (computeBacktestInstrumentSpecSnapshotId(normalized) !== normalized.instrumentSpecSnapshotId) {
    throw new BacktestError('INSTRUMENT_CONSTRAINT_VIOLATION', 'Instrument snapshot hash does not match its exact constraints');
  }
  return deepFreeze(normalized);
}

function normalizeCost(cost: BacktestCostModel): BacktestCostModel {
  const normalized = deepFreeze({
    makerFeeRate: new BacktestDecimal(cost.makerFeeRate),
    takerFeeRate: new BacktestDecimal(cost.takerFeeRate),
    halfSpreadBps: new BacktestDecimal(cost.halfSpreadBps),
    marketSlippageBps: new BacktestDecimal(cost.marketSlippageBps),
    stopSlippageBps: new BacktestDecimal(cost.stopSlippageBps),
  });
  const values = Object.values(normalized).map((value) => toBacktestCalcDecimal(value));
  if (values.some((value) => value.isNegative())) throw new BacktestError('COST_MODEL_INVALID', 'Cost rates must be non-negative');
  const half = toBacktestCalcDecimal(normalized.halfSpreadBps).dividedBy(BACKTEST_BPS_DIVISOR);
  const market = toBacktestCalcDecimal(normalized.marketSlippageBps).dividedBy(BACKTEST_BPS_DIVISOR);
  const stop = toBacktestCalcDecimal(normalized.stopSlippageBps).dividedBy(BACKTEST_BPS_DIVISOR);
  if (half.plus(market).greaterThanOrEqualTo(1) || half.plus(stop).greaterThanOrEqualTo(1)) {
    throw new BacktestError('COST_MODEL_INVALID', 'Spread plus slippage rate must be less than one');
  }
  return normalized;
}

function normalizeFundingSource(schedule: BacktestFundingSchedule): BacktestFundingSchedule {
  if (!ID.test(schedule.sourceId) || !SHA256.test(schedule.contentSha256) ||
      !['VERIFIED_SCHEDULE', 'ASSUMPTION', 'TEST_ONLY'].includes(schedule.fidelity)) {
    throw new BacktestError('FUNDING_SCHEDULE_INVALID', 'Funding schedule identity is invalid');
  }
  let previous: number | null = null;
  const events = schedule.events.map((event) => {
    safeAligned(event.fundingTimeMs, 'fundingTimeMs');
    if (previous !== null && event.fundingTimeMs <= previous) {
      throw new BacktestError('FUNDING_SCHEDULE_INVALID', 'Funding source events must be strictly ordered and unique');
    }
    previous = event.fundingTimeMs;
    const fundingRate = new BacktestDecimal(event.fundingRate);
    const referencePrice = new BacktestDecimal(event.referencePrice);
    if (toBacktestCalcDecimal(referencePrice).lessThanOrEqualTo(0)) {
      throw new BacktestError('FUNDING_SCHEDULE_INVALID', 'Funding reference price must be positive');
    }
    return deepFreeze({ fundingTimeMs: event.fundingTimeMs, fundingRate, referencePrice });
  });
  if (computeBacktestFundingScheduleContentSha256(events) !== schedule.contentSha256) {
    throw new BacktestError('FUNDING_SCHEDULE_INVALID', 'Funding content hash does not match the normalized event schedule');
  }
  return deepFreeze({
    sourceId: schedule.sourceId,
    contentSha256: schedule.contentSha256,
    fidelity: schedule.fidelity,
    events: Object.freeze(events),
  });
}

/**
 * Validate ALL authoritative evidence before selecting close-time settlements in
 * (start, end]. Research callers use analysisStart, excluding flat warmup and
 * assigning an adjacent boundary to the preceding window exactly once.
 *
 * The returned content hash binds only the effective events. sourceId/fidelity
 * remain unchanged; the full source hash stays in the pair-bound research plan.
 * Direct Phase9 inputs still require an already bounded schedule.
 */
export function deriveBacktestFundingScheduleForWindow(
  authoritative: BacktestFundingSchedule,
  startExclusiveMs: number,
  endInclusiveMs: number,
): BacktestFundingSchedule {
  safeAligned(startExclusiveMs, 'funding window start');
  safeAligned(endInclusiveMs, 'funding window end');
  if (startExclusiveMs >= endInclusiveMs) throw new BacktestError('FUNDING_SCHEDULE_INVALID', 'Funding window must be non-empty and ordered');
  const source = normalizeFundingSource(authoritative);
  const events = source.events.filter((event) => event.fundingTimeMs > startExclusiveMs && event.fundingTimeMs <= endInclusiveMs);
  return deepFreeze({ sourceId: source.sourceId, fidelity: source.fidelity, contentSha256: computeBacktestFundingScheduleContentSha256(events), events });
}

function normalizeFunding(schedule: BacktestFundingSchedule, bootstrapFromInclusiveMs: number, replayToExclusiveMs: number): BacktestFundingSchedule {
  const normalized = normalizeFundingSource(schedule);
  if (normalized.events.some((event) => event.fundingTimeMs <= bootstrapFromInclusiveMs || event.fundingTimeMs > replayToExclusiveMs)) {
    throw new BacktestError('FUNDING_SCHEDULE_INVALID', 'Funding events must be strictly ordered within (bootstrap, replayTo]');
  }
  return normalized;
}

export function computeBacktestFundingScheduleContentSha256(
  events: readonly { readonly fundingTimeMs: number; readonly fundingRate: BacktestDecimal; readonly referencePrice: BacktestDecimal }[],
): string {
  return sha256CanonicalJson(events.map((event) => ({
    fundingTimeMs: event.fundingTimeMs,
    fundingRate: event.fundingRate.value,
    referencePrice: event.referencePrice.value,
  })));
}

function normalizeParticipant(identity: BacktestParticipantIdentity): BacktestParticipantIdentity {
  for (const value of Object.values(identity)) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
      throw new BacktestError('INVALID_BACKTEST_CONFIG', 'Participant identity fields must be non-empty strings');
    }
  }
  if (!SHA256.test(identity.parameterHash)) {
    throw new BacktestError('INVALID_BACKTEST_CONFIG', 'Participant parameterHash must be lowercase SHA-256');
  }
  return deepFreeze({ ...identity });
}

function normalizeDataset(manifest: HistoricalDatasetManifest): Omit<HistoricalDatasetManifest, 'createdAt'> {
  const { createdAt: _createdAt, ...identity } = manifest;
  if (identity.schemaVersion !== 1 || identity.venue !== 'COINDCX' || identity.market !== 'FUTURES' ||
      identity.resolutionMinutes !== 1 || !/^[A-Z0-9_.-]{1,64}$/.test(identity.pair) ||
      !SHA256.test(identity.datasetId) || !SHA256.test(identity.contentSha256)) {
    throw new BacktestError('DATASET_IDENTITY_MISMATCH', 'Historical manifest identity is invalid');
  }
  safeAligned(identity.fromInclusiveMs, 'dataset.fromInclusiveMs');
  safeAligned(identity.toExclusiveMs, 'dataset.toExclusiveMs');
  const durationMs = identity.toExclusiveMs - identity.fromInclusiveMs;
  if (identity.fromInclusiveMs >= identity.toExclusiveMs || !Number.isSafeInteger(durationMs) ||
      !Number.isSafeInteger(identity.expectedCandleCount) ||
      !Number.isSafeInteger(identity.actualCandleCount) || !Number.isSafeInteger(identity.firstOpenTimeMs) ||
      !Number.isSafeInteger(identity.lastOpenTimeMs) || identity.firstOpenTimeMs % MINUTE_MS !== 0 ||
      identity.lastOpenTimeMs % MINUTE_MS !== 0 || identity.expectedCandleCount < 1 || identity.actualCandleCount < 1) {
    throw new BacktestError('DATASET_IDENTITY_MISMATCH', 'Historical manifest counts or boundaries are invalid');
  }
  return deepFreeze({ ...identity });
}

export function normalizeBacktestInputs(input: {
  readonly datasetManifest: HistoricalDatasetManifest;
  readonly bootstrapFromInclusiveMs: number;
  readonly evaluationFromInclusiveMs: number;
  readonly evaluationToExclusiveMs: number;
  readonly replayToExclusiveMs: number;
  readonly configuredTimeframes?: readonly number[];
  readonly instrumentSpec: BacktestInstrumentSpec;
  readonly costModel: BacktestCostModel;
  readonly fundingSchedule: BacktestFundingSchedule;
  readonly participantIdentity: BacktestParticipantIdentity;
  readonly initialEquity: BacktestDecimal | string;
  readonly intrabarAmbiguityPolicy?: 'ADVERSE_FIRST';
  readonly maxOpenOrders?: number;
  readonly engineSemanticVersion?: string;
  readonly sourceIdentity: string;
  readonly verificationPageMinutes?: number;
}): NormalizedBacktestInputs {
  const dataset = normalizeDataset(input.datasetManifest);
  const boundaries = [input.bootstrapFromInclusiveMs, input.evaluationFromInclusiveMs, input.evaluationToExclusiveMs, input.replayToExclusiveMs];
  boundaries.forEach((value, index) => safeAligned(value, `range boundary ${index}`));
  if (!(dataset.fromInclusiveMs <= input.bootstrapFromInclusiveMs &&
        input.bootstrapFromInclusiveMs <= input.evaluationFromInclusiveMs &&
        input.evaluationFromInclusiveMs < input.evaluationToExclusiveMs &&
        input.evaluationToExclusiveMs <= input.replayToExclusiveMs &&
        input.replayToExclusiveMs <= dataset.toExclusiveMs)) {
    throw new BacktestError('DATASET_RANGE_INVALID', 'Backtest ranges violate the required half-open ordering');
  }
  const configuredTimeframes = normalizeTimeframes(input.configuredTimeframes ?? []);
  for (const timeframe of configuredTimeframes) {
    if (bucketStartMs(input.bootstrapFromInclusiveMs, timeframe) !== input.bootstrapFromInclusiveMs) {
      throw new BacktestError('TIMEFRAME_CONFIGURATION_INVALID', 'Bootstrap is not aligned to every higher timeframe');
    }
  }
  const maxOpenOrders = input.maxOpenOrders ?? DEFAULT_MAX_OPEN_ORDERS;
  if (!Number.isSafeInteger(maxOpenOrders) || maxOpenOrders < 1 || maxOpenOrders > MAX_OPEN_ORDERS) {
    throw new BacktestError('INVALID_BACKTEST_CONFIG', 'maxOpenOrders must be an integer from 1 through 100');
  }
  const verificationPageMinutes = input.verificationPageMinutes ?? 1440;
  if (!Number.isSafeInteger(verificationPageMinutes) || verificationPageMinutes < 1) {
    throw new BacktestError('INVALID_BACKTEST_CONFIG', 'verificationPageMinutes must be a positive safe integer');
  }
  if (!ID.test(input.sourceIdentity)) throw new BacktestError('INVALID_BACKTEST_CONFIG', 'Dataset source identity is invalid');
  const instrumentSpec = normalizeInstrument(input.instrumentSpec, dataset.pair);
  const costModel = normalizeCost(input.costModel);
  const fundingSchedule = normalizeFunding(input.fundingSchedule, input.bootstrapFromInclusiveMs, input.replayToExclusiveMs);
  const participant = normalizeParticipant(input.participantIdentity);
  const initialEquity = new BacktestDecimal(input.initialEquity);
  if (toBacktestCalcDecimal(initialEquity).lessThanOrEqualTo(0)) {
    throw new BacktestError('INVALID_BACKTEST_CONFIG', 'initialEquity must be positive');
  }
  const engineSemanticVersion = input.engineSemanticVersion ?? PHASE9_ENGINE_SEMANTIC_VERSION;
  if (!ID.test(engineSemanticVersion)) throw new BacktestError('INVALID_BACKTEST_CONFIG', 'Engine semantic version is invalid');
  if ((input.intrabarAmbiguityPolicy ?? 'ADVERSE_FIRST') !== 'ADVERSE_FIRST') {
    throw new BacktestError('INVALID_BACKTEST_CONFIG', 'Only ADVERSE_FIRST ambiguity handling is supported');
  }
  const manifest = deepFreeze<BacktestRunManifest>({
    schemaVersion: 1,
    venue: 'COINDCX',
    market: 'FUTURES',
    pair: dataset.pair,
    datasetId: dataset.datasetId,
    datasetContentSha256: dataset.contentSha256,
    bootstrapFromInclusiveMs: input.bootstrapFromInclusiveMs,
    evaluationFromInclusiveMs: input.evaluationFromInclusiveMs,
    evaluationToExclusiveMs: input.evaluationToExclusiveMs,
    replayToExclusiveMs: input.replayToExclusiveMs,
    configuredTimeframes,
    instrumentSpecSnapshotId: instrumentSpec.instrumentSpecSnapshotId,
    costModel: {
      makerFeeRate: costModel.makerFeeRate.value,
      takerFeeRate: costModel.takerFeeRate.value,
      halfSpreadBps: costModel.halfSpreadBps.value,
      marketSlippageBps: costModel.marketSlippageBps.value,
      stopSlippageBps: costModel.stopSlippageBps.value,
    },
    fundingSchedule: {
      sourceId: fundingSchedule.sourceId,
      contentSha256: fundingSchedule.contentSha256,
      fidelity: fundingSchedule.fidelity,
    },
    intrabarAmbiguityPolicy: 'ADVERSE_FIRST',
    maxOpenOrders,
    engineSemanticVersion,
    participant,
    initialEquity: initialEquity.value,
  });
  return deepFreeze({
    manifest,
    runId: sha256CanonicalJson(manifest),
    dataset,
    instrumentSpec,
    costModel,
    fundingSchedule,
    configuredTimeframes,
    sourceIdentity: input.sourceIdentity,
    verificationPageMinutes,
  });
}
