import {
  createRiskPolicy,
  evidenceContentSha256,
  recomputeStrategyDecisionId,
  type AccountRiskSnapshot,
  type CoinDcxLeverageTierSnapshot,
  type EntryStopProposal,
  type PairRiskSnapshot,
  type PortfolioExposureSnapshot,
  type RiskEvaluationContext,
  type RiskPolicy,
  type RiskPolicyDraft,
  type SettlementConversionSnapshot,
} from '../../../src/risk';
import type { StrategyDecision } from '../../../src/strategies';

export const SHA_A = 'a'.repeat(64);
export const EVALUATION_TIME = 1_000_000;

export function seal<T extends { readonly provenance: { readonly sourceId: string; readonly sourceTimeMs: number | null; readonly observedAtMs: number; readonly contentSha256: string } }>(value: T): T {
  return { ...value, provenance: { ...value.provenance, contentSha256: evidenceContentSha256(value) } };
}

export function makePolicy(overrides: Partial<RiskPolicyDraft> = {}): RiskPolicy {
  const base: RiskPolicyDraft = {
    globalConfig: {
      globalMaxLeverage: '20', globalMaxOpenNotionalInr: '1000000', globalMaxConcurrentPositions: 20,
      globalMaxDailyLossInr: '50000', globalDailyLossLimitPercent: null, globalMaxDrawdownPercent: '50',
    },
    pairConfig: { pair: 'B-BTC_USDT', pairMaxLeverage: '20', pairMaxExposureInr: '500000', pairMaxConcurrentPositions: 10 },
    modeConfig: {
      mode: 'NORMAL', riskPerTradePercent: '1', maxNotionalPerTradeInr: '100000', leverageRecommendation: '5',
      maxConcurrentExposureInr: '800000', maxCoinExposureInr: '400000', maxStrategyExposureInr: '300000',
      maxConcurrentPositions: 10, maxDailyLossInr: '40000', dailyLossLimitPercent: null,
      maxDrawdownPercent: '40', consecutiveLossLimit: 3, cooldownMs: 60000,
    },
    sourceAuthorityPolicy: {
      accountRiskSourceId: 'account-source', pairRiskSourceId: 'pair-source', exposureSourceId: 'exposure-source',
      leverageTierSourceId: 'tier-source', conversionSourceId: 'conversion-source',
    },
    freshnessPolicy: {
      maxAccountSnapshotAgeMs: 1000, maxPairSnapshotAgeMs: 1000, maxExposureSnapshotAgeMs: 1000,
      maxLeverageTierSnapshotAgeMs: 1000, maxSettlementRateSnapshotAgeMs: 1000,
    },
    valuationPolicy: {
      valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1', valuationPriceField: 'markPriceUsdt',
      valuationUnitScale: 8, valuationUnitRounding: 'ROUND_HALF_UP',
    },
  };
  const merged = { ...base, ...overrides };
  return createRiskPolicy({
    globalConfig: {
      globalMaxLeverage: merged.globalConfig.globalMaxLeverage, globalMaxOpenNotionalInr: merged.globalConfig.globalMaxOpenNotionalInr,
      globalMaxConcurrentPositions: merged.globalConfig.globalMaxConcurrentPositions, globalMaxDailyLossInr: merged.globalConfig.globalMaxDailyLossInr,
      globalDailyLossLimitPercent: merged.globalConfig.globalDailyLossLimitPercent, globalMaxDrawdownPercent: merged.globalConfig.globalMaxDrawdownPercent,
    },
    pairConfig: { pair: merged.pairConfig.pair, pairMaxLeverage: merged.pairConfig.pairMaxLeverage, pairMaxExposureInr: merged.pairConfig.pairMaxExposureInr, pairMaxConcurrentPositions: merged.pairConfig.pairMaxConcurrentPositions },
    modeConfig: {
      mode: merged.modeConfig.mode, riskPerTradePercent: merged.modeConfig.riskPerTradePercent, maxNotionalPerTradeInr: merged.modeConfig.maxNotionalPerTradeInr,
      leverageRecommendation: merged.modeConfig.leverageRecommendation, maxConcurrentExposureInr: merged.modeConfig.maxConcurrentExposureInr,
      maxCoinExposureInr: merged.modeConfig.maxCoinExposureInr, maxStrategyExposureInr: merged.modeConfig.maxStrategyExposureInr,
      maxConcurrentPositions: merged.modeConfig.maxConcurrentPositions, maxDailyLossInr: merged.modeConfig.maxDailyLossInr,
      dailyLossLimitPercent: merged.modeConfig.dailyLossLimitPercent, maxDrawdownPercent: merged.modeConfig.maxDrawdownPercent,
      consecutiveLossLimit: merged.modeConfig.consecutiveLossLimit, cooldownMs: merged.modeConfig.cooldownMs,
    },
    sourceAuthorityPolicy: {
      accountRiskSourceId: merged.sourceAuthorityPolicy.accountRiskSourceId, pairRiskSourceId: merged.sourceAuthorityPolicy.pairRiskSourceId,
      exposureSourceId: merged.sourceAuthorityPolicy.exposureSourceId, leverageTierSourceId: merged.sourceAuthorityPolicy.leverageTierSourceId,
      conversionSourceId: merged.sourceAuthorityPolicy.conversionSourceId,
    },
    freshnessPolicy: {
      maxAccountSnapshotAgeMs: merged.freshnessPolicy.maxAccountSnapshotAgeMs, maxPairSnapshotAgeMs: merged.freshnessPolicy.maxPairSnapshotAgeMs,
      maxExposureSnapshotAgeMs: merged.freshnessPolicy.maxExposureSnapshotAgeMs, maxLeverageTierSnapshotAgeMs: merged.freshnessPolicy.maxLeverageTierSnapshotAgeMs,
      maxSettlementRateSnapshotAgeMs: merged.freshnessPolicy.maxSettlementRateSnapshotAgeMs,
    },
    valuationPolicy: {
      valuationMethodVersion: merged.valuationPolicy.valuationMethodVersion, valuationPriceField: merged.valuationPolicy.valuationPriceField,
      valuationUnitScale: merged.valuationPolicy.valuationUnitScale, valuationUnitRounding: merged.valuationPolicy.valuationUnitRounding,
    },
  });
}

export function makeDecision(targetExposure: StrategyDecision['targetExposure'] = 'LONG', status: StrategyDecision['status'] = 'READY'): StrategyDecision {
  const body: StrategyDecision = {
    decisionId: SHA_A, decisionSequence: 1, strategyInstanceId: 'instance-1', strategyId: 'strategy-1',
    strategyVersion: '1.0.0', parameterHash: SHA_A, pair: 'B-BTC_USDT', evaluationTimeMs: EVALUATION_TIME,
    triggerTimeframeMinutes: 5, status, targetExposure, reasonCodes: ['SIGNAL'],
  };
  return { ...body, decisionId: recomputeStrategyDecisionId(body) };
}

function provenance(sourceId: string) {
  return { sourceId, sourceTimeMs: EVALUATION_TIME, observedAtMs: EVALUATION_TIME, contentSha256: SHA_A };
}

export function makeAccount(): AccountRiskSnapshot {
  return seal({
    accountId: 'account-1', provenance: provenance('account-source'), accountStateKnown: true,
    availableMarginInr: '100000', lockedMarginInr: '0', currentEquityInr: '100000', peakEquityInr: '100000',
    dailyPnl: { realizedTradingPnlInr: '0', fundingPnlInr: '0', feesInr: '0', otherAccountAdjustmentsInr: '0', netDailyPnlInr: '0' },
    consecutiveLossCount: 0, cooldownActiveUntilMs: null, accountMaxLeverage: null, reconciliationSourceIds: ['wallet', 'positions'],
  });
}

export function makePair(): PairRiskSnapshot {
  return seal({
    pair: 'B-BTC_USDT', instrumentSpecSnapshotId: 'instrument-1', status: 'ACTIVE', exitOnly: false,
    priceIncrement: '1', quantityIncrement: '1', minPrice: '1', maxPrice: '1000000', minQuantity: '1',
    maxQuantity: '10000', minTradeSize: '1', minNotional: '1', maxNotional: '10000', contractMultiplier: '0.001',
    position: { state: 'FLAT' },
    ownership: { status: 'RECONCILED', positionState: 'FLAT', accountId: 'account-1', pair: 'B-BTC_USDT', positionId: null, instanceOwnership: [] },
    provenance: provenance('pair-source'),
  });
}

export function makeExposure(): PortfolioExposureSnapshot {
  return seal({
    globalOpenNotionalInr: '0', perPairOpenNotionalInr: {}, perStrategyOpenNotionalInr: {}, concurrentOpenPositions: 0,
    pending: { status: 'KNOWN', globalPendingNotionalInr: '0', pairPendingNotionalInr: {}, strategyPendingNotionalInr: {},
      instancePendingReservations: [], pendingReservationCount: 0, pendingDirectionalNotionalInr: { longInr: '0', shortInr: '0' } },
    provenance: provenance('exposure-source'),
  });
}

export function makeTiers(): CoinDcxLeverageTierSnapshot {
  return seal({
    pair: 'B-BTC_USDT', provenance: provenance('tier-source'), semanticsStatus: 'VERIFIED', semanticsVersion: 'verified-v1', exchangeMaxLeverage: '10',
    tiers: [{ tierId: 'tier-1', lowerNotionalUsdt: '0', upperNotionalUsdt: null, lowerInclusive: true, upperInclusive: false, maxLeverage: '10' }],
    safetyMarginTiers: [], legacyMaxLeverageLongIgnored: null, legacyMaxLeverageShortIgnored: null,
  });
}

export function makeSettlement(): SettlementConversionSnapshot {
  return seal({ conversionMarketId: 'USDT_INR', sourceCurrency: 'USDT', targetCurrency: 'INR', marginCurrency: 'INR', rateInrPerUsdt: '80', provenance: provenance('conversion-source') });
}

export function makeEntry(decision = makeDecision()): EntryStopProposal {
  return seal({ proposalId: 'entry-1', proposalPolicyId: 'CURRENT_MARK_PRICE_ENTRY_V1', sourceStrategyDecisionId: decision.decisionId,
    pair: decision.pair, entryPriceUsdt: '100', stopPriceUsdt: '90', provenance: provenance('pair-source') });
}

export function makeContext(changes: Partial<RiskEvaluationContext> = {}): RiskEvaluationContext {
  const decision = makeDecision();
  return {
    candidate: { strategyDecision: decision, pair: decision.pair, instrumentSpecSnapshotId: 'instrument-1' },
    entryStopProposal: makeEntry(decision), leverageProposal: { proposalId: 'lev-1', proposalPolicyId: 'NONE_USE_MODE_DEFAULT_V1', sourceStrategyDecisionId: decision.decisionId, requestedLeverage: null },
    override: null, evaluationTimeMs: EVALUATION_TIME, accountSnapshot: makeAccount(), pairSnapshot: makePair(), exposureSnapshot: makeExposure(),
    leverageTierSnapshot: makeTiers(), settlementRateSnapshot: makeSettlement(), ...changes,
  };
}

export function resealContext(context: RiskEvaluationContext): RiskEvaluationContext {
  return {
    ...context,
    entryStopProposal: context.entryStopProposal === null ? null : seal(context.entryStopProposal),
    accountSnapshot: context.accountSnapshot === null ? null : seal(context.accountSnapshot),
    pairSnapshot: seal(context.pairSnapshot), exposureSnapshot: context.exposureSnapshot === null ? null : seal(context.exposureSnapshot),
    leverageTierSnapshot: context.leverageTierSnapshot === null ? null : seal(context.leverageTierSnapshot),
    settlementRateSnapshot: context.settlementRateSnapshot === null ? null : seal(context.settlementRateSnapshot),
  };
}
