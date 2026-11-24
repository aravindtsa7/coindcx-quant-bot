import type { InstrumentMetadata } from '../../../coin-runtime';
import { isLosslessNumber } from 'lossless-json';
import { Decimal } from '../../../core/decimal/decimal';
import { toIndicatorCalcDecimal } from '../../../indicators/decimal/indicator-calc-decimal';
import type { IndicatorPoint } from '../../../indicators/types';
import type { RestCandleRecord } from '../../../market-data/rest-candle-reader';
import {
  createRiskPolicy, createStrategyRiskHandoff, evaluateRisk, evidenceContentSha256, sha256CanonicalJson,
  type AccountRiskSnapshot, type CoinDcxLeverageTierSnapshot, type PairRiskSnapshot, type PortfolioExposureSnapshot,
  type RiskDecision, type RiskEvaluationContext, type RiskPolicy, type SettlementConversionSnapshot, type EntryStopProposal, type EvidenceProvenance,
} from '../../../risk';
import {
  createStrategyIndicatorBindings, emaTrendV1Definition, rsiMomentumV1Definition, StrategyReadonlyMap,
  type StrategyCandleSnapshot, type StrategyDecision, type StrategyIndicatorBinding, type StrategyKernel,
} from '../../../strategies';

export type PracticalBotStrategy = 'ema-trend' | 'rsi-momentum';
export type PracticalBotRiskScope = 'VENUE' | 'OPERATOR_SHADOW';
export interface PracticalBotObservedPosition { readonly venuePositionId: string; readonly pair: string; readonly signedQuantity: string }

/** Independent, authoritative M7 projections. Missing projections stay null, never synthetic balances/PnL. */
export interface PracticalBotRiskState {
  readonly scope?: PracticalBotRiskScope;
  readonly accountSnapshot: AccountRiskSnapshot | null;
  readonly exposureSnapshot: PortfolioExposureSnapshot | null;
  readonly settlementRateSnapshot: SettlementConversionSnapshot | null;
  readonly leverageTierSnapshot?: CoinDcxLeverageTierSnapshot;
  readonly pairSnapshot?: PairRiskSnapshot;
  readonly entryStopProposal?: EntryStopProposal;
}

export const BOT_RISK_SOURCES = Object.freeze({ accountRiskSourceId: 'BOT_ACCOUNT_RISK_V1', pairRiskSourceId: 'BOT_OBSERVED_PAIR_V1',
  exposureSourceId: 'BOT_PORTFOLIO_EXPOSURE_V1', leverageTierSourceId: 'BOT_DISCOVERED_TIERS_V1', conversionSourceId: 'BOT_SETTLEMENT_V1' });

export const BOT_SHADOW_RISK_SOURCES = Object.freeze({ ...BOT_RISK_SOURCES, accountRiskSourceId: 'BOT_OPERATOR_SHADOW_ACCOUNT_V1',
  exposureSourceId: 'BOT_OPERATOR_SHADOW_PENDING_V1', pairRiskSourceId: 'BOT_OPERATOR_SHADOW_PAIR_V1' });

export function createBotRiskPolicy(pair: string, maxInr: string, scope: PracticalBotRiskScope = 'VENUE'): RiskPolicy {
  return createRiskPolicy({
    globalConfig: { globalMaxLeverage: '1', globalMaxOpenNotionalInr: maxInr, globalMaxConcurrentPositions: 1,
      globalMaxDailyLossInr: maxInr, globalDailyLossLimitPercent: null, globalMaxDrawdownPercent: '5' },
    pairConfig: { pair, pairMaxLeverage: '1', pairMaxExposureInr: maxInr, pairMaxConcurrentPositions: 1 },
    modeConfig: { mode: 'SAFE', riskPerTradePercent: '0.25', maxNotionalPerTradeInr: maxInr, leverageRecommendation: '1',
      maxConcurrentExposureInr: maxInr, maxCoinExposureInr: maxInr, maxStrategyExposureInr: maxInr,
      maxConcurrentPositions: 1, maxDailyLossInr: maxInr, dailyLossLimitPercent: null, maxDrawdownPercent: '5',
      consecutiveLossLimit: 3, cooldownMs: 60_000 },
    sourceAuthorityPolicy: scope === 'OPERATOR_SHADOW' ? BOT_SHADOW_RISK_SOURCES : BOT_RISK_SOURCES,
    freshnessPolicy: { maxAccountSnapshotAgeMs: 10_000, maxPairSnapshotAgeMs: 10_000, maxExposureSnapshotAgeMs: 10_000,
      maxLeverageTierSnapshotAgeMs: 60_000, maxSettlementRateSnapshotAgeMs: 10_000 },
    valuationPolicy: { valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1', valuationPriceField: 'markPriceUsdt',
      valuationUnitScale: 8, valuationUnitRounding: 'ROUND_HALF_UP' },
  });
}

function seal<T extends { readonly provenance: EvidenceProvenance }>(value: T): T {
  return { ...value, provenance: { ...value.provenance, contentSha256: evidenceContentSha256(value) } };
}
function provenance(sourceId: string, observedAtMs: number) {
  return { sourceId, sourceTimeMs: null, observedAtMs, contentSha256: '' };
}
export { seal as sealBotRiskEvidence };

/**
 * Bounded coverage strictly inside the smallest published size cap. No claim is made about equality at a provider
 * boundary or the unmodelled remainder of the ladder. The documented maximum leverage applies throughout this
 * interior; global/pair/mode policy still caps sizing at 1x. See docs.coindcx.com/#get-instrument-details.
 */
export function createBotInteriorLeverageSnapshot(instrument: InstrumentMetadata, observedAtMs: number): CoinDcxLeverageTierSnapshot {
  const raw = instrument.dynamicPositionLeverageTiers;
  if (raw.length === 0 || raw.some(tier => !tier.leverage.isFinite() || tier.leverage.lt(1)
    || !tier.maxPositionSizeUsdt.isFinite() || !tier.maxPositionSizeUsdt.gt(0))) throw new Error('INVALID_LEVERAGE_TIERS');
  const largestLeverage = raw.reduce((max, tier) => Decimal.max(max, tier.leverage), new Decimal(1));
  const smallestCap = raw.reduce((min, tier) => Decimal.min(min, tier.maxPositionSizeUsdt), raw[0]!.maxPositionSizeUsdt);
  if (!raw.some(tier => tier.leverage.eq(largestLeverage) && tier.maxPositionSizeUsdt.eq(smallestCap))) throw new Error('INVALID_LEVERAGE_TIERS');
  const bound = smallestCap.div(2);
  if (!bound.gt(0) || !bound.lt(smallestCap)) throw new Error('INVALID_LEVERAGE_TIERS');
  return seal({ pair: instrument.pair, provenance: provenance(BOT_RISK_SOURCES.leverageTierSourceId, observedAtMs),
    semanticsStatus: 'VERIFIED', semanticsVersion: 'COINDCX_DOCUMENTED_STRICT_INTERIOR_V1', exchangeMaxLeverage: largestLeverage.toFixed(),
    tiers: [{ tierId: sha256CanonicalJson({ pair: instrument.pair, smallestCap: smallestCap.toFixed(), maxLeverage: largestLeverage.toFixed() }),
      lowerNotionalUsdt: '0', upperNotionalUsdt: bound.toFixed(), lowerInclusive: true, upperInclusive: true, maxLeverage: largestLeverage.toFixed() }],
    safetyMarginTiers: instrument.dynamicSafetyMarginTiers.map(tier => ({ positionSizeThresholdUsdt: tier.positionSizeThresholdUsdt.toFixed(),
      maintenanceMarginPercent: tier.maintenanceMarginPercent.toFixed() })), legacyMaxLeverageLongIgnored: null, legacyMaxLeverageShortIgnored: null });
}

/** Public conversion evidence uses poll freshness; its provider update time may be much older. */
export function readBotSettlementConversion(raw: unknown, observedAtMs: number): SettlementConversionSnapshot {
  if (!Array.isArray(raw)) throw new Error('INVALID_SETTLEMENT_CONVERSION');
  const matches = raw.filter((entry: unknown): entry is Record<string, unknown> => entry !== null && typeof entry === 'object'
    && !Array.isArray(entry) && (entry as Record<string, unknown>)['symbol'] === 'USDTINR'
    && (entry as Record<string, unknown>)['margin_currency_short_name'] === 'INR'
    && (entry as Record<string, unknown>)['target_currency_short_name'] === 'USDT');
  if (matches.length !== 1) throw new Error('INVALID_SETTLEMENT_CONVERSION');
  const numericText = (value: unknown): string | null => typeof value === 'string' ? value
    : isLosslessNumber(value) ? value.value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
  const rateText = numericText(matches[0]!['conversion_price']);
  const timeText = numericText(matches[0]!['last_updated_at']);
  if (rateText === null || !/^\d+(?:\.\d+)?$/.test(rateText) || timeText === null || !/^\d+$/.test(timeText)) {
    throw new Error('INVALID_SETTLEMENT_CONVERSION');
  }
  const rate = new Decimal(rateText);
  const sourceTimeMs = Number(timeText);
  if (!rate.isFinite() || !rate.gt(0) || !Number.isSafeInteger(sourceTimeMs) || sourceTimeMs <= 0
    || !Number.isSafeInteger(observedAtMs) || sourceTimeMs > observedAtMs) throw new Error('INVALID_SETTLEMENT_CONVERSION');
  return seal({ conversionMarketId: 'USDTINR', sourceCurrency: 'USDT', targetCurrency: 'INR', marginCurrency: 'INR',
    rateInrPerUsdt: rate.toFixed(), provenance: { ...provenance(BOT_RISK_SOURCES.conversionSourceId, observedAtMs), sourceTimeMs } });
}

/** A versioned proposal, not an assertion that a protective exchange order exists. */
export function createBotEntryStopProposal(instrument: InstrumentMetadata, decision: StrategyDecision,
  candle: RestCandleRecord, observedAtMs: number): EntryStopProposal | null {
  if (decision.status !== 'READY' || (decision.targetExposure !== 'LONG' && decision.targetExposure !== 'SHORT')) return null;
  if (candle.pair !== instrument.pair || decision.pair !== instrument.pair || candle.openTimeMs + 60_000 !== decision.evaluationTimeMs
    || decision.evaluationTimeMs > observedAtMs || !instrument.priceIncrement.gt(0)) throw new Error('INVALID_ENTRY_CANDLE');
  const tick = instrument.priceIncrement;
  const entry = candle.close.toNearest(tick, Decimal.ROUND_HALF_UP);
  const distance = Decimal.max(entry.times('0.01'), tick).div(tick).ceil().times(tick);
  const stop = decision.targetExposure === 'LONG' ? entry.minus(distance) : entry.plus(distance);
  const payload = { proposalPolicyId: 'BOT_CLOSED_1M_ONE_PERCENT_STOP_V1', sourceStrategyDecisionId: decision.decisionId,
    pair: instrument.pair, entryPriceUsdt: entry.toFixed(), stopPriceUsdt: stop.toFixed(),
    provenance: { ...provenance(BOT_RISK_SOURCES.pairRiskSourceId, observedAtMs), sourceTimeMs: decision.evaluationTimeMs } };
  return seal({ ...payload, proposalId: sha256CanonicalJson(payload) });
}

export function botInstrumentSnapshotId(instrument: InstrumentMetadata): string {
  return sha256CanonicalJson(JSON.parse(JSON.stringify(instrument)) as unknown);
}

export class PracticalBotStrategySession {
  readonly #strategy: PracticalBotStrategy;
  #kernel: StrategyKernel | undefined;
  #bindings: readonly StrategyIndicatorBinding[] = [];
  readonly #seen = new Map<number, string>();
  #decision: StrategyDecision | null = null;
  #points: ReadonlyMap<string, IndicatorPoint<unknown>> = new Map();
  public constructor(strategy: PracticalBotStrategy) { this.#strategy = strategy; }

  public evaluate(pair: string, input: readonly RestCandleRecord[], nowMs: number): {
    readonly decision: StrategyDecision | null; readonly kernel: StrategyKernel | null;
    readonly indicators: Readonly<Record<string, unknown>>;
  } {
    for (const record of [...input].sort((a, b) => a.openTimeMs - b.openTimeMs)) {
      if (record.pair !== pair || record.openTimeMs % 60_000 !== 0 || record.openTimeMs + 60_000 > nowMs) throw new Error('INVALID_CLOSED_CANDLE');
      const candle: StrategyCandleSnapshot = { pair, timeframeMinutes: 1, openTimeMs: record.openTimeMs,
        closeTimeExclusiveMs: record.openTimeMs + 60_000, open: record.open.toFixed(), high: record.high.toFixed(),
        low: record.low.toFixed(), close: record.close.toFixed(), volume: record.volume.toFixed(), quoteVolume: record.quoteVolume?.toFixed() ?? null };
      const hash = sha256CanonicalJson(candle);
      const previous = this.#seen.get(candle.openTimeMs);
      if (previous !== undefined) { if (previous !== hash) throw new Error('CANDLE_REVISION'); continue; }
      if (this.#kernel === undefined) {
        const definition = this.#strategy === 'ema-trend' ? emaTrendV1Definition : rsiMomentumV1Definition;
        const parameters = this.#strategy === 'ema-trend'
          ? { timeframeMinutes: 1, fastPeriod: 9, slowPeriod: 21, priceSource: 'CLOSE' }
          : { timeframeMinutes: 1, period: 14, longThreshold: '55', shortThreshold: '45', priceSource: 'CLOSE' };
        this.#kernel = definition.createKernel({ pair, parameters,
          indicatorBootstrapIdentity: [{ timeframeMinutes: 1, bootstrapStartOpenTimeMs: candle.openTimeMs }] });
        this.#bindings = createStrategyIndicatorBindings(this.#kernel);
      }
      if (this.#decision !== null && candle.closeTimeExclusiveMs !== this.#decision.evaluationTimeMs + 60_000) throw new Error('CANDLE_GAP');
      const indicatorCandle = { ...candle, open: toIndicatorCalcDecimal(candle.open), high: toIndicatorCalcDecimal(candle.high),
        low: toIndicatorCalcDecimal(candle.low), close: toIndicatorCalcDecimal(candle.close), volume: toIndicatorCalcDecimal(candle.volume),
        quoteVolume: candle.quoteVolume === null ? null : toIndicatorCalcDecimal(candle.quoteVolume) };
      this.#points = new StrategyReadonlyMap(this.#bindings.map(binding => [binding.alias, binding.kernel.update(indicatorCandle)] as const));
      this.#decision = this.#kernel.evaluate({ pair, evaluationTimeMs: candle.closeTimeExclusiveMs, triggerClosedCandle: candle,
        latestClosedCandleByTimeframe: new StrategyReadonlyMap([[1, candle]]), candlesClosedAtThisTimestamp: [candle], latestIndicatorPointByAlias: this.#points });
      this.#seen.set(candle.openTimeMs, hash);
    }
    return { decision: this.#decision, kernel: this.#kernel ?? null,
      indicators: Object.fromEntries([...this.#points].map(([alias, point]) => [alias, point.value])) };
  }
}

export function evaluateBotRisk(input: {
  readonly kernel: StrategyKernel; readonly decision: StrategyDecision; readonly instrument: InstrumentMetadata;
  readonly instrumentObservedAtMs: number; readonly evaluationTimeMs: number; readonly maxInr: string;
  readonly positionObservedAtMs: number;
  readonly latestClosedCandle?: RestCandleRecord;
  readonly candleObservedAtMs?: number;
  readonly accountFingerprint: string | null; readonly positions: readonly PracticalBotObservedPosition[] | null;
  readonly state?: PracticalBotRiskState;
}): { readonly decision: RiskDecision | null; readonly context: RiskEvaluationContext | null; readonly policy: RiskPolicy; readonly reasonCodes: readonly string[] } {
  const policy = createBotRiskPolicy(input.instrument.pair, input.maxInr, input.state?.scope);
  const sources = input.state?.scope === 'OPERATOR_SHADOW' ? BOT_SHADOW_RISK_SOURCES : BOT_RISK_SOURCES;
  const handoff = createStrategyRiskHandoff(input.kernel, input.decision, botInstrumentSnapshotId(input.instrument));
  if (handoff === null) return { decision: null, context: null, policy, reasonCodes: ['STRATEGY_WARMING'] };
  const observed = input.positions?.filter(position => position.pair === input.instrument.pair && !new Decimal(position.signedQuantity).isZero());
  if (input.state?.pairSnapshot === undefined && (observed === undefined || observed.length > 1)) {
    return { decision: null, context: null, policy, reasonCodes: [observed === undefined ? 'POSITION_STATE_UNAVAILABLE' : 'AMBIGUOUS_POSITION_STATE'] };
  }
  const instrument = input.instrument;
  const position = observed?.[0];
  const observedPair: PairRiskSnapshot = seal({
    pair: instrument.pair, instrumentSpecSnapshotId: handoff.candidate.instrumentSpecSnapshotId, status: instrument.status.toUpperCase(),
    exitOnly: instrument.exitOnly !== false, priceIncrement: instrument.priceIncrement.toFixed(), quantityIncrement: instrument.quantityIncrement.toFixed(),
    minPrice: instrument.minPrice.toFixed(), maxPrice: instrument.maxPrice.toFixed(), minQuantity: instrument.minQuantity.toFixed(),
    maxQuantity: instrument.maxQuantity.toFixed(), minTradeSize: instrument.minTradeSize.toFixed(), minNotional: instrument.minNotional.toFixed(),
    maxNotional: null, contractMultiplier: instrument.unitContractValue.toFixed(),
    position: position === undefined ? { state: 'FLAT' } : { state: 'OPEN', positionId: position.venuePositionId,
      positionDirection: new Decimal(position.signedQuantity).isPositive() ? 'LONG' : 'SHORT',
      quantityMagnitude: new Decimal(position.signedQuantity).abs().toFixed(), valuation: null },
    // A complete flat observation has no owner to attribute. Existing positions require durable strategy attribution.
    ownership: observed !== undefined && position === undefined && input.accountFingerprint !== null
      ? { status: 'RECONCILED', positionState: 'FLAT', accountId: input.accountFingerprint, pair: instrument.pair, positionId: null, instanceOwnership: [] }
      : { status: 'UNRECONCILED' }, provenance: provenance(sources.pairRiskSourceId, input.positionObservedAtMs),
  });
  const pair = input.state?.pairSnapshot ?? observedPair;
  if (input.state?.pairSnapshot) {
    const { position: _position, ownership: _ownership, provenance: _provenance, ...expectedMetadata } = observedPair;
    const { position: _providedPosition, ownership: _providedOwnership, provenance: _providedProvenance, ...providedMetadata } = pair;
    if (sha256CanonicalJson(expectedMetadata) !== sha256CanonicalJson(providedMetadata)) {
      return { decision: null, context: null, policy, reasonCodes: ['INSTRUMENT_SPEC_MISMATCH'] };
    }
    if (observed !== undefined && (pair.position.state !== observedPair.position.state ||
      (pair.position.state === 'OPEN' && observedPair.position.state === 'OPEN' &&
        (pair.position.positionId !== observedPair.position.positionId || pair.position.positionDirection !== observedPair.position.positionDirection ||
          new Decimal(pair.position.quantityMagnitude).comparedTo(observedPair.position.quantityMagnitude) !== 0)))) {
      return { decision: null, context: null, policy, reasonCodes: ['POSITION_OBSERVATION_MISMATCH'] };
    }
  }
  const tiers: CoinDcxLeverageTierSnapshot = input.state?.leverageTierSnapshot ?? seal({
    pair: instrument.pair, provenance: provenance(BOT_RISK_SOURCES.leverageTierSourceId, input.instrumentObservedAtMs),
    semanticsStatus: 'SEMANTICS_UNVERIFIED', semanticsVersion: null,
    exchangeMaxLeverage: instrument.dynamicPositionLeverageTiers.reduce((max, tier) => Decimal.max(max, tier.leverage), new Decimal(1)).toFixed(),
    // The normalized discovery model has caps, not verified inclusive/exclusive intervals. Do not invent them.
    tiers: [], safetyMarginTiers: instrument.dynamicSafetyMarginTiers.map(tier => ({
      positionSizeThresholdUsdt: tier.positionSizeThresholdUsdt.toFixed(), maintenanceMarginPercent: tier.maintenanceMarginPercent.toFixed() })),
    legacyMaxLeverageLongIgnored: null, legacyMaxLeverageShortIgnored: null,
  });
  const account = input.state?.accountSnapshot ?? null;
  // Empty complete venue positions prove zero current exposure, but say nothing about durable pending admissions.
  const flatExposure: PortfolioExposureSnapshot | null = input.positions !== null && input.accountFingerprint !== null
    && input.positions.every(record => new Decimal(record.signedQuantity).isZero())
    ? seal<PortfolioExposureSnapshot>({ accountId: input.accountFingerprint, globalOpenNotionalInr: '0', perPairOpenNotionalInr: {}, perStrategyOpenNotionalInr: {},
      concurrentOpenPositions: 0, pending: { status: 'UNKNOWN' }, provenance: provenance(BOT_RISK_SOURCES.exposureSourceId, input.positionObservedAtMs) }) : null;
  const exposure = input.state?.exposureSnapshot ?? flatExposure;
  if ((account !== null && account.accountId !== input.accountFingerprint) || (exposure !== null && exposure.accountId !== input.accountFingerprint)) {
    return { decision: null, context: null, policy, reasonCodes: ['ACCOUNT_IDENTITY_MISMATCH'] };
  }
  const entry = input.state?.entryStopProposal ?? (input.latestClosedCandle === undefined ? null
    : createBotEntryStopProposal(instrument, input.decision, input.latestClosedCandle, input.candleObservedAtMs ?? input.evaluationTimeMs));
  const scopedEntry = entry && input.state?.entryStopProposal === undefined && input.state?.scope === 'OPERATOR_SHADOW'
    ? seal({ ...entry, provenance: { ...entry.provenance, sourceId: sources.pairRiskSourceId } }) : entry;
  const context: RiskEvaluationContext = { ...handoff, entryStopProposal: scopedEntry, leverageProposal: null, override: null,
    evaluationTimeMs: input.evaluationTimeMs, accountSnapshot: account, pairSnapshot: pair, exposureSnapshot: exposure,
    leverageTierSnapshot: tiers, settlementRateSnapshot: input.state?.settlementRateSnapshot ?? null };
  const decision = evaluateRisk(policy, context);
  return { decision, context, policy, reasonCodes: decision.status === 'REJECTED'
    ? [decision.primaryReasonCode, ...decision.secondaryReasonCodes] : decision.reasonCodes };
}
