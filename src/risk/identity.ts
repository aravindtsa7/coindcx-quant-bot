import { sha256CanonicalJson } from './canonical';
import type { PositionSizingDecision, RiskEvaluationContext, RiskInputContentHashes, RiskPolicy } from './types';

export const POSITION_SIZING_POLICY_PAYLOAD = Object.freeze({
  policyId: 'P13_POSITION_SIZING_V1',
  tierEnumerationPolicyId: 'P13_LEVERAGE_TIER_ENUMERATION_V1',
  roundingMode: 'FLOOR_CONSERVATIVE',
});

export function computePositionSizingPolicyId(): string { return sha256CanonicalJson(POSITION_SIZING_POLICY_PAYLOAD); }

export function computePositionSizingDecisionId(decision: Omit<PositionSizingDecision, 'positionSizingDecisionId'>): string {
  return sha256CanonicalJson(decision);
}

export function computeRiskPolicyId(policy: Omit<RiskPolicy, 'riskPolicyId'>): string {
  return sha256CanonicalJson({
    globalRiskConfigId: policy.globalConfig.globalRiskConfigId,
    pairRiskConfigId: policy.pairConfig.pairRiskConfigId,
    riskModeConfigId: policy.modeConfig.riskModeConfigId,
    riskSourceAuthorityPolicyId: policy.sourceAuthorityPolicy.riskSourceAuthorityPolicyId,
    riskValuationPolicyId: policy.valuationPolicy.riskValuationPolicyId,
    riskFreshnessPolicyId: policy.freshnessPolicy.riskFreshnessPolicyId,
    sizingPolicyId: 'P13_POSITION_SIZING_V1',
    tierEnumerationPolicyId: 'P13_LEVERAGE_TIER_ENUMERATION_V1',
    exposurePolicyId: 'P13_EXPOSURE_V1',
    lossDrawdownPolicyId: 'P13_LOSS_DRAWDOWN_V1',
    validationPrecedenceId: 'P13_VALIDATION_PRECEDENCE_V1',
    rejectionPrecedenceId: 'P13_REJECTION_PRECEDENCE_V1',
    auditOrderingId: 'P13_AUDIT_ORDERING_V1',
  });
}

export function riskDecisionIdentityPayload(
  context: RiskEvaluationContext,
  policy: RiskPolicy,
  positionSizingDecisionId: string,
  hashes: RiskInputContentHashes,
): Readonly<Record<string, unknown>> {
  return {
    riskPolicyId: policy.riskPolicyId,
    positionSizingDecisionId,
    sourceStrategyDecisionId: context.candidate.strategyDecision.decisionId,
    candidate: context.candidate,
    entryStopProposal: context.entryStopProposal,
    leverageProposal: context.leverageProposal,
    override: context.override,
    evaluationTimeMs: context.evaluationTimeMs,
    ...hashes,
  };
}
