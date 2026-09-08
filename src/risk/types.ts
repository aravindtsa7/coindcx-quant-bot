import type { StrategyDecision } from '../strategies/core/types';

export type RiskMode = 'SAFE' | 'NORMAL' | 'HIGH' | 'CUSTOM';
export type RiskDecisionAction = 'OPEN' | 'CLOSE' | 'NO_CHANGE' | 'REVERSAL_DEFERRED';
export type RiskAuditOutcome = 'PASS' | 'FAIL' | 'SKIPPED';

export interface EvidenceProvenance {
  readonly sourceId: string;
  readonly sourceTimeMs: number | null;
  readonly observedAtMs: number;
  readonly contentSha256: string;
}

export interface EntryStopProposal {
  readonly proposalId: string;
  readonly proposalPolicyId: string;
  readonly sourceStrategyDecisionId: string;
  readonly pair: string;
  readonly entryPriceUsdt: string;
  readonly stopPriceUsdt: string;
  readonly provenance: EvidenceProvenance;
}

export interface LeverageProposal {
  readonly proposalId: string;
  readonly proposalPolicyId: string;
  readonly sourceStrategyDecisionId: string;
  readonly requestedLeverage: string | null;
}

export interface StrategyRiskCandidate {
  readonly strategyDecision: StrategyDecision;
  readonly pair: string;
  readonly instrumentSpecSnapshotId: string;
}

export interface InstanceOwnershipRecord {
  readonly strategyInstanceId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly currentQuantity: string;
  readonly currentNotionalInr: string;
}

export interface ReconciledFlatOwnership {
  readonly status: 'RECONCILED';
  readonly positionState: 'FLAT';
  readonly accountId: string;
  readonly pair: string;
  readonly positionId: null;
  readonly instanceOwnership: readonly [];
}

export interface ReconciledOpenOwnership {
  readonly status: 'RECONCILED';
  readonly positionState: 'OPEN';
  readonly accountId: string;
  readonly pair: string;
  readonly positionId: string;
  readonly instanceOwnership: readonly InstanceOwnershipRecord[];
}

export type PositionOwnershipState =
  | ReconciledFlatOwnership
  | ReconciledOpenOwnership
  | { readonly status: 'UNRECONCILED' };

export interface CanonicalPositionValuation {
  readonly valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1';
  readonly valuationPriceField: 'markPriceUsdt';
  readonly valuationPriceUsdt: string;
  readonly valuationPriceSourceId: string;
  readonly valuationPriceSourceTimeMs: number | null;
  readonly valuationPriceObservedAtMs: number;
  readonly contractMultiplier: string;
  readonly conversionMarket: string;
  readonly conversionRateInrPerUsdt: string;
  readonly conversionSourceId: string;
  readonly unitValuationInrPerQty: string;
  readonly aggregateCurrentNotionalInr: string;
}

export type PairPositionState =
  | { readonly state: 'FLAT' }
  | {
      readonly state: 'OPEN';
      readonly positionId: string;
      readonly positionDirection: 'LONG' | 'SHORT';
      readonly quantityMagnitude: string;
      readonly valuation: CanonicalPositionValuation | null;
    };

export interface PairRiskSnapshot {
  readonly pair: string;
  readonly instrumentSpecSnapshotId: string;
  readonly status: string;
  readonly exitOnly: boolean;
  readonly priceIncrement: string;
  readonly quantityIncrement: string;
  readonly minPrice: string;
  readonly maxPrice: string;
  readonly minQuantity: string;
  readonly maxQuantity: string;
  readonly minTradeSize: string;
  readonly minNotional: string;
  readonly maxNotional: string | null;
  readonly contractMultiplier: string;
  readonly position: PairPositionState;
  readonly ownership: PositionOwnershipState;
  readonly provenance: EvidenceProvenance;
}

export interface InstancePendingReservation {
  readonly strategyInstanceId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly pendingNotionalInr: string;
  readonly pendingReservationCount: number;
}

export type PendingExposureState =
  | {
      readonly status: 'KNOWN';
      readonly globalPendingNotionalInr: string;
      readonly pairPendingNotionalInr: Readonly<Record<string, string>>;
      readonly strategyPendingNotionalInr: Readonly<Record<string, string>>;
      readonly instancePendingReservations: readonly InstancePendingReservation[];
      readonly pendingReservationCount: number;
      readonly pendingDirectionalNotionalInr: { readonly longInr: string; readonly shortInr: string };
    }
  | { readonly status: 'UNKNOWN' };

export interface PortfolioExposureSnapshot {
  readonly globalOpenNotionalInr: string;
  readonly perPairOpenNotionalInr: Readonly<Record<string, string>>;
  readonly perStrategyOpenNotionalInr: Readonly<Record<string, string>>;
  readonly concurrentOpenPositions: number;
  readonly pending: PendingExposureState;
  readonly provenance: EvidenceProvenance;
}

export interface DailyPnlComponents {
  readonly realizedTradingPnlInr: string;
  readonly fundingPnlInr: string;
  readonly feesInr: string;
  readonly otherAccountAdjustmentsInr: string;
  readonly netDailyPnlInr: string;
}

export interface AccountRiskSnapshot {
  readonly accountId: string;
  readonly provenance: EvidenceProvenance;
  readonly accountStateKnown: boolean;
  readonly availableMarginInr: string;
  readonly lockedMarginInr: string;
  readonly currentEquityInr: string;
  readonly peakEquityInr: string;
  readonly dailyPnl: DailyPnlComponents;
  readonly consecutiveLossCount: number;
  readonly cooldownActiveUntilMs: number | null;
  readonly accountMaxLeverage: string | null;
  readonly reconciliationSourceIds: readonly string[];
}

export interface AccountRiskStateProvider {
  getAccountRiskSnapshot(evaluationTimeMs: number): Promise<AccountRiskSnapshot>;
}

export interface VerifiedLeverageTier {
  readonly tierId: string;
  readonly lowerNotionalUsdt: string;
  readonly upperNotionalUsdt: string | null;
  readonly lowerInclusive: boolean;
  readonly upperInclusive: boolean;
  readonly maxLeverage: string;
}

export interface CoinDcxLeverageTierSnapshot {
  readonly pair: string;
  readonly provenance: EvidenceProvenance;
  readonly semanticsStatus: 'VERIFIED' | 'SEMANTICS_UNVERIFIED';
  readonly semanticsVersion: string | null;
  readonly exchangeMaxLeverage: string;
  readonly tiers: readonly VerifiedLeverageTier[];
  readonly safetyMarginTiers: readonly {
    readonly positionSizeThresholdUsdt: string;
    readonly maintenanceMarginPercent: string;
  }[];
  readonly legacyMaxLeverageLongIgnored: string | null;
  readonly legacyMaxLeverageShortIgnored: string | null;
}

export interface SettlementConversionSnapshot {
  readonly conversionMarketId: string;
  readonly sourceCurrency: 'USDT';
  readonly targetCurrency: 'INR';
  readonly marginCurrency: 'INR';
  readonly rateInrPerUsdt: string;
  readonly provenance: EvidenceProvenance;
}

export interface SettlementConversionProvider {
  getSettlementConversionSnapshot(evaluationTimeMs: number): Promise<SettlementConversionSnapshot>;
}

export interface GlobalRiskConfig {
  readonly globalRiskConfigId: string;
  readonly globalMaxLeverage: string;
  readonly globalMaxOpenNotionalInr: string;
  readonly globalMaxConcurrentPositions: number;
  readonly globalMaxDailyLossInr: string;
  readonly globalDailyLossLimitPercent: string | null;
  readonly globalMaxDrawdownPercent: string;
}

export interface PairRiskConfig {
  readonly pair: string;
  readonly pairRiskConfigId: string;
  readonly pairMaxLeverage: string;
  readonly pairMaxExposureInr: string;
  readonly pairMaxConcurrentPositions: number | null;
}

export interface RiskModeConfig {
  readonly mode: RiskMode;
  readonly riskModeConfigId: string;
  readonly riskPerTradePercent: string;
  readonly maxNotionalPerTradeInr: string;
  readonly leverageRecommendation: string;
  readonly maxConcurrentExposureInr: string;
  readonly maxCoinExposureInr: string;
  readonly maxStrategyExposureInr: string;
  readonly maxConcurrentPositions: number;
  readonly maxDailyLossInr: string;
  readonly dailyLossLimitPercent: string | null;
  readonly maxDrawdownPercent: string;
  readonly consecutiveLossLimit: number | null;
  readonly cooldownMs: number | null;
}

export interface RiskOverride {
  readonly overrideId: string;
  readonly overrideRiskPerTradePercent: string | null;
  readonly overrideMaxLeverage: string | null;
  readonly overrideMaxNotionalInr: string | null;
}

export interface RiskFreshnessPolicy {
  readonly riskFreshnessPolicyId: string;
  readonly maxAccountSnapshotAgeMs: number;
  readonly maxPairSnapshotAgeMs: number;
  readonly maxExposureSnapshotAgeMs: number;
  readonly maxLeverageTierSnapshotAgeMs: number;
  readonly maxSettlementRateSnapshotAgeMs: number;
}

export interface RiskSourceAuthorityPolicy {
  readonly riskSourceAuthorityPolicyId: string;
  readonly accountRiskSourceId: string;
  readonly pairRiskSourceId: string;
  readonly exposureSourceId: string;
  readonly leverageTierSourceId: string;
  readonly conversionSourceId: string;
}

export interface RiskValuationPolicy {
  readonly riskValuationPolicyId: string;
  readonly valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1';
  readonly valuationPriceField: 'markPriceUsdt';
  readonly valuationUnitScale: number;
  readonly valuationUnitRounding: 'ROUND_HALF_UP';
}

export interface RiskPolicy {
  readonly globalConfig: GlobalRiskConfig;
  readonly pairConfig: PairRiskConfig;
  readonly modeConfig: RiskModeConfig;
  readonly sourceAuthorityPolicy: RiskSourceAuthorityPolicy;
  readonly freshnessPolicy: RiskFreshnessPolicy;
  readonly valuationPolicy: RiskValuationPolicy;
  readonly positionSizingPolicyId: string;
  readonly riskPolicyId: string;
}

export type GlobalRiskConfigDraft = Omit<GlobalRiskConfig, 'globalRiskConfigId'>;
export type PairRiskConfigDraft = Omit<PairRiskConfig, 'pairRiskConfigId'>;
export type RiskModeConfigDraft = Omit<RiskModeConfig, 'riskModeConfigId'>;
export type RiskSourceAuthorityPolicyDraft = Omit<RiskSourceAuthorityPolicy, 'riskSourceAuthorityPolicyId'>;
export type RiskFreshnessPolicyDraft = Omit<RiskFreshnessPolicy, 'riskFreshnessPolicyId'>;
export type RiskValuationPolicyDraft = Omit<RiskValuationPolicy, 'riskValuationPolicyId'>;

export interface RiskPolicyDraft {
  readonly globalConfig: GlobalRiskConfigDraft;
  readonly pairConfig: PairRiskConfigDraft;
  readonly modeConfig: RiskModeConfigDraft;
  readonly sourceAuthorityPolicy: RiskSourceAuthorityPolicyDraft;
  readonly freshnessPolicy: RiskFreshnessPolicyDraft;
  readonly valuationPolicy: RiskValuationPolicyDraft;
}

export type CapValue =
  | { readonly status: 'RESOLVED'; readonly value: string }
  | { readonly status: 'NOT_APPLICABLE' | 'UNRESOLVED'; readonly value: null };

export interface RiskCapsApplied {
  readonly riskPerTradePercentApplied: CapValue;
  readonly maxNotionalPerTradeInrApplied: CapValue;
  readonly requestedLeverage: CapValue;
  readonly modeRecommendedLeverage: CapValue;
  readonly exchangeMaxLeverage: CapValue;
  readonly tierMaxLeverage: CapValue;
  readonly accountMaxLeverage: CapValue;
  readonly pairMaxLeverage: CapValue;
  readonly globalMaxLeverage: CapValue;
  readonly finalLeverage: CapValue;
}

export interface RiskAuditStep {
  readonly step: number;
  readonly name: string;
  readonly outcome: RiskAuditOutcome;
  readonly reasonCodes: readonly string[];
}

export interface RiskInputContentHashes {
  readonly accountSnapshotSha256: string | null;
  readonly pairSnapshotSha256: string;
  readonly exposureSnapshotSha256: string | null;
  readonly leverageTierSnapshotSha256: string | null;
  readonly settlementRateSnapshotSha256: string | null;
}

export interface PositionSizingValues {
  readonly riskBudgetInr: string;
  readonly riskCappedQuantity: string;
  readonly finalQuantity: string;
  readonly finalLeverage: string;
  readonly finalNotionalUsdt: string;
  readonly finalNotionalInr: string;
  readonly estimatedInitialMarginUsdt: string;
  readonly estimatedInitialMarginInr: string;
  readonly estimatedStopLossRiskInr: string;
}

export interface PositionSizingDecision {
  readonly schemaVersion: 1;
  readonly positionSizingDecisionId: string;
  readonly sourceStrategyDecisionId: string;
  readonly strategyInstanceId: string;
  readonly pair: string;
  readonly instrumentSpecSnapshotId: string;
  readonly positionSizingPolicyId: string;
  readonly action: RiskDecisionAction;
  readonly outcome: 'SIZED' | 'NOT_SIZED' | 'NOT_APPLICABLE';
  readonly sizing: PositionSizingValues | null;
  readonly sizingReasonCodes: readonly string[];
  readonly auditTrail: readonly RiskAuditStep[];
}

interface RiskDecisionBase {
  readonly schemaVersion: 1;
  readonly riskDecisionId: string;
  readonly riskPolicyId: string;
  readonly sourceStrategyDecisionId: string;
  readonly sourcePositionSizingDecisionId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly strategyInstanceId: string;
  readonly pair: string;
  readonly riskMode: RiskMode;
  readonly evaluationTimeMs: number;
  readonly capsApplied: RiskCapsApplied;
  readonly auditTrail: readonly RiskAuditStep[];
  readonly inputContentHashes: RiskInputContentHashes;
}

export interface AcceptedOpenRiskDecision extends RiskDecisionBase {
  readonly status: 'ACCEPTED';
  readonly action: 'OPEN';
  readonly approved: {
    readonly approvedQuantity: string;
    readonly approvedLeverage: string;
    readonly approvedNotionalUsdt: string;
    readonly approvedNotionalInr: string;
    readonly estimatedInitialMarginUsdt: string;
    readonly estimatedInitialMarginInr: string;
    readonly estimatedStopLossRiskInr: string;
  };
  readonly reasonCodes: readonly string[];
}

export interface AcceptedCloseRiskDecision extends RiskDecisionBase {
  readonly status: 'ACCEPTED';
  readonly action: 'CLOSE';
  readonly approved: {
    readonly approvedQuantity: string;
    readonly approvedNotionalUsdt: string;
    readonly approvedNotionalInr: string;
  };
  readonly reasonCodes: readonly string[];
}

export interface RejectedRiskDecision extends RiskDecisionBase {
  readonly status: 'REJECTED';
  readonly action: RiskDecisionAction;
  readonly approved: null;
  readonly primaryReasonCode: string;
  readonly secondaryReasonCodes: readonly string[];
}

export type RiskDecision = AcceptedOpenRiskDecision | AcceptedCloseRiskDecision | RejectedRiskDecision;

export interface RiskEvaluationContext {
  readonly candidate: StrategyRiskCandidate;
  readonly entryStopProposal: EntryStopProposal | null;
  readonly leverageProposal: LeverageProposal | null;
  readonly override: RiskOverride | null;
  readonly evaluationTimeMs: number;
  readonly expectedRiskPolicyId?: string;
  readonly accountSnapshot: AccountRiskSnapshot | null;
  readonly pairSnapshot: PairRiskSnapshot;
  readonly exposureSnapshot: PortfolioExposureSnapshot | null;
  readonly leverageTierSnapshot: CoinDcxLeverageTierSnapshot | null;
  readonly settlementRateSnapshot: SettlementConversionSnapshot | null;
}

export interface PositionSizingRequest {
  readonly action: RiskDecisionAction;
  readonly candidate: StrategyRiskCandidate;
  readonly entryStopProposal: EntryStopProposal | null;
  readonly leverageProposal: LeverageProposal | null;
  readonly override: RiskOverride | null;
  readonly accountSnapshot: AccountRiskSnapshot | null;
  readonly pairSnapshot: PairRiskSnapshot;
  readonly exposureSnapshot: PortfolioExposureSnapshot | null;
  readonly leverageTierSnapshot: CoinDcxLeverageTierSnapshot | null;
  readonly settlementRateSnapshot: SettlementConversionSnapshot | null;
}
