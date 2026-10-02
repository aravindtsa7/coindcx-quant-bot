export type {
  AccountRiskSnapshot, AccountRiskStateProvider, AcceptedCloseRiskDecision, AcceptedOpenRiskDecision,
  CanonicalPositionValuation, CapValue, CoinDcxLeverageTierSnapshot, DailyPnlComponents, EntryStopProposal,
  EvidenceProvenance, GlobalRiskConfig, GlobalRiskConfigDraft, InstanceOwnershipRecord, InstancePendingReservation,
  LeverageProposal, PairPositionState, PairRiskConfig, PairRiskConfigDraft, PairRiskSnapshot, PendingExposureState,
  PortfolioExposureSnapshot, PositionOwnershipState, PositionSizingDecision, PositionSizingRequest, PositionSizingValues,
  ReconciledFlatOwnership, ReconciledOpenOwnership, RejectedRiskDecision, RiskAuditStep, RiskCapsApplied,
  RiskDecision, RiskDecisionAction, RiskEvaluationContext, RiskFreshnessPolicy, RiskFreshnessPolicyDraft,
  RiskInputContentHashes, RiskMode, RiskModeConfig, RiskModeConfigDraft, RiskOverride, RiskPolicy, RiskPolicyDraft,
  RiskSourceAuthorityPolicy, RiskSourceAuthorityPolicyDraft, RiskValuationPolicy, RiskValuationPolicyDraft,
  SettlementConversionProvider, SettlementConversionSnapshot, StrategyRiskCandidate, StrategyRiskLineage, VerifiedLeverageTier,
} from './types';
export { RiskConfigError, RiskEngineError } from './errors';
export type { RiskRejectionCode } from './reason-codes';
export { GROUP_A_REASON_CODES, GROUP_B_REASON_CODES, REJECTION_PRECEDENCE_V1 } from './reason-codes';
export { canonicalDecimalString, riskDecimal } from './decimal';
export { evidenceContentSha256, sha256CanonicalJson } from './canonical';
export { createRiskPolicy, normalizeRiskOverride } from './policy';
export { computePositionSizingDecisionId, computePositionSizingPolicyId, computeRiskPolicyId } from './identity';
export { createStrategyRiskCandidate, createStrategyRiskHandoff, deriveRiskAction, recomputeStrategyDecisionId } from './strategy-lineage';
export { normalizeCoinDcxPosition } from './ownership';
export { RiskEngine, createRiskEngine, evaluateRisk } from './engine';

// Reviewed defining-owner binding protection.

if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const name of ["sha256CanonicalJson"]) {
    const value = module.exports[name] as unknown;
    const descriptor = Object.getOwnPropertyDescriptor(module.exports, name);
    if (descriptor?.configurable === false) {
      if (descriptor.set !== undefined || (descriptor.get === undefined && descriptor.writable !== false) || module.exports[name] !== value) throw new Error('OWNED_TRUSTED_EXPORT_INVALID');
    } else Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
  }
}
