import { evidenceContentSha256, sha256CanonicalJson } from './canonical';
import { canonicalRiskDecimal, checkedProduct, riskDecimal, ValuationNumericContextError } from './decimal';
import { RiskConfigError, RiskEngineError } from './errors';
import { exposureReasons, reservationIdentityReasons } from './exposure';
import { freezeRiskRuntime } from './immutable';
import { computePositionSizingPolicyId, computeRiskPolicyId, riskDecisionIdentityPayload } from './identity';
import { lossDrawdownReasons } from './loss-drawdown';
import { verifyOwnership } from './ownership';
import { createRiskPolicy, normalizeRiskOverride } from './policy';
import { evaluatePositionSizing, type PositionSizingEvaluation } from './position-sizing';
import { orderReasonCodes, type RiskRejectionCode } from './reason-codes';
import { verifyEvidence } from './source-authority';
import { deriveRiskAction, strategyLineageReasons } from './strategy-lineage';
import { normalizeRiskEvaluationContext } from './validation';
import { verifyCurrentValuation } from './valuation';
import type {
  AcceptedCloseRiskDecision, AcceptedOpenRiskDecision, RejectedRiskDecision, RiskAuditStep, RiskDecision,
  RiskEvaluationContext, RiskInputContentHashes, RiskPolicy, RiskPolicyDraft,
} from './types';

type RiskDecisionDraft = Omit<AcceptedOpenRiskDecision, 'riskDecisionId'> |
  Omit<AcceptedCloseRiskDecision, 'riskDecisionId'> | Omit<RejectedRiskDecision, 'riskDecisionId'>;

const STEP_NAMES = [
  'STATIC_POLICY_CONFIG_INTEGRITY', 'CANONICAL_SOURCE_SHAPE', 'STRATEGY_DECISION_IDENTITY',
  'PAIR_ACCOUNT_INSTRUMENT_IDENTITY', 'PROPOSAL_IDENTITY_PROVENANCE', 'SNAPSHOT_IDENTITY_PROVENANCE',
  'TEMPORAL_FRESHNESS', 'ACTION_DERIVATION', 'INSTRUMENT_CONSTRAINTS', 'PENDING_OWNERSHIP_STATE',
  'SIZING_TIER_MARGIN', 'EXPOSURE_LOSS_DRAWDOWN', 'FINAL_DECISION_ASSEMBLY',
] as const;

function unique(codes: readonly RiskRejectionCode[]): readonly RiskRejectionCode[] { return [...new Set(codes)]; }
function omitId<T extends Record<string, unknown>>(value: T, id: keyof T): Record<string, unknown> { const copy = { ...value }; delete copy[id]; return copy; }

function assertPolicyIdentity(policy: RiskPolicy): void {
  const checks: readonly [Record<string, unknown>, string, string][] = [
    [policy.globalConfig as unknown as Record<string, unknown>, 'globalRiskConfigId', policy.globalConfig.globalRiskConfigId],
    [policy.pairConfig as unknown as Record<string, unknown>, 'pairRiskConfigId', policy.pairConfig.pairRiskConfigId],
    [policy.modeConfig as unknown as Record<string, unknown>, 'riskModeConfigId', policy.modeConfig.riskModeConfigId],
    [policy.sourceAuthorityPolicy as unknown as Record<string, unknown>, 'riskSourceAuthorityPolicyId', policy.sourceAuthorityPolicy.riskSourceAuthorityPolicyId],
    [policy.freshnessPolicy as unknown as Record<string, unknown>, 'riskFreshnessPolicyId', policy.freshnessPolicy.riskFreshnessPolicyId],
    [policy.valuationPolicy as unknown as Record<string, unknown>, 'riskValuationPolicyId', policy.valuationPolicy.riskValuationPolicyId],
  ];
  if (checks.some(([value, key, expected]) => sha256CanonicalJson(omitId(value, key)) !== expected) ||
      policy.positionSizingPolicyId !== computePositionSizingPolicyId() || computeRiskPolicyId(policy) !== policy.riskPolicyId) {
    throw new RiskConfigError('RISK_POLICY_IDENTITY_MISMATCH', 'Risk policy identity is invalid');
  }
}

function policyDraftFromPolicy(policy: RiskPolicy): RiskPolicyDraft {
  return {
    globalConfig: omitId(policy.globalConfig as unknown as Record<string, unknown>, 'globalRiskConfigId') as unknown as RiskPolicyDraft['globalConfig'],
    pairConfig: omitId(policy.pairConfig as unknown as Record<string, unknown>, 'pairRiskConfigId') as unknown as RiskPolicyDraft['pairConfig'],
    modeConfig: omitId(policy.modeConfig as unknown as Record<string, unknown>, 'riskModeConfigId') as unknown as RiskPolicyDraft['modeConfig'],
    sourceAuthorityPolicy: omitId(policy.sourceAuthorityPolicy as unknown as Record<string, unknown>, 'riskSourceAuthorityPolicyId') as unknown as RiskPolicyDraft['sourceAuthorityPolicy'],
    freshnessPolicy: omitId(policy.freshnessPolicy as unknown as Record<string, unknown>, 'riskFreshnessPolicyId') as unknown as RiskPolicyDraft['freshnessPolicy'],
    valuationPolicy: omitId(policy.valuationPolicy as unknown as Record<string, unknown>, 'riskValuationPolicyId') as unknown as RiskPolicyDraft['valuationPolicy'],
  };
}

function audit(stepReasons: readonly (readonly RiskRejectionCode[])[], action: string, sizingStepExecuted: boolean): readonly RiskAuditStep[] {
  return STEP_NAMES.map((name, index) => {
    const step = index + 1;
    const reasons = orderReasonCodes(stepReasons[index] ?? []);
    const applicable = step === 9 || step === 12 ? action === 'OPEN' : step === 11 ? sizingStepExecuted : step === 10 ? action !== 'NO_CHANGE' : true;
    return { step, name, outcome: reasons.length > 0 ? 'FAIL' : applicable ? 'PASS' : 'SKIPPED', reasonCodes: reasons };
  });
}

function verifySnapshot(
  snapshot: { readonly provenance: { readonly sourceId: string; readonly sourceTimeMs: number | null; readonly observedAtMs: number; readonly contentSha256: string } },
  source: string, evaluationTimeMs: number, age: number, stale: RiskRejectionCode,
): { hash: string; identity: readonly RiskRejectionCode[]; temporal: readonly RiskRejectionCode[] } {
  const result = verifyEvidence(snapshot, source, evaluationTimeMs, age, stale);
  return { hash: result.contentHash, identity: result.reasons.filter((code) => code === 'DECISION_IDENTITY_MISMATCH' || code === 'SOURCE_ID_MISMATCH'),
    temporal: result.reasons.filter((code) => code !== 'DECISION_IDENTITY_MISMATCH' && code !== 'SOURCE_ID_MISMATCH') };
}

export class RiskEngine {
  public readonly policy: RiskPolicy;
  public constructor(policy: RiskPolicy) {
    assertPolicyIdentity(policy);
    const normalizedPolicy = createRiskPolicy(policyDraftFromPolicy(policy));
    if (normalizedPolicy.riskPolicyId !== policy.riskPolicyId) throw new RiskConfigError('RISK_POLICY_IDENTITY_MISMATCH', 'Risk policy is not canonical');
    this.policy = normalizedPolicy;
    Object.freeze(this);
  }

  public evaluatePositionSizing(context: RiskEvaluationContext): PositionSizingEvaluation {
    const normalized = this.normalize(context);
    const action = deriveRiskAction(normalized.candidate.strategyDecision, normalized.pairSnapshot.position);
    const preflightReasons = this.positionSizingPreflightAudit(normalized, action);
    return evaluatePositionSizing({ action, candidate: normalized.candidate, entryStopProposal: normalized.entryStopProposal, leverageProposal: normalized.leverageProposal,
      override: normalized.override, accountSnapshot: normalized.accountSnapshot, pairSnapshot: normalized.pairSnapshot, exposureSnapshot: normalized.exposureSnapshot,
      leverageTierSnapshot: normalized.leverageTierSnapshot, settlementRateSnapshot: normalized.settlementRateSnapshot }, this.policy, preflightReasons);
  }

  public evaluateRisk(context: RiskEvaluationContext): RiskDecision {
    const normalized = this.normalize(context);
    const decision = normalized.candidate.strategyDecision;
    if (decision.status !== 'READY' || decision.targetExposure === null) throw new RiskEngineError('RISK_SOURCE_INVALID', 'Only READY StrategyDecision inputs are actionable');
    const action = deriveRiskAction(decision, normalized.pairSnapshot.position);
    const stepReasons: RiskRejectionCode[][] = Array.from({ length: 13 }, () => []);
    stepReasons[2]?.push(...strategyLineageReasons(normalized.candidate, normalized.strategyOrigin));
    if (decision.evaluationTimeMs > normalized.evaluationTimeMs) stepReasons[6]?.push('EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION');
    if (normalized.candidate.pair !== decision.pair || normalized.pairSnapshot.pair !== decision.pair || this.policy.pairConfig.pair !== decision.pair || normalized.candidate.instrumentSpecSnapshotId !== normalized.pairSnapshot.instrumentSpecSnapshotId) stepReasons[3]?.push('DECISION_IDENTITY_MISMATCH');
    if (normalized.entryStopProposal !== null && (normalized.entryStopProposal.sourceStrategyDecisionId !== decision.decisionId || normalized.entryStopProposal.pair !== decision.pair)) stepReasons[4]?.push('DECISION_IDENTITY_MISMATCH');
    if (normalized.leverageProposal !== null && normalized.leverageProposal.sourceStrategyDecisionId !== decision.decisionId) stepReasons[4]?.push('DECISION_IDENTITY_MISMATCH');

    let accountHash: string | null = null;
    let exposureHash: string | null = null;
    let tierHash: string | null = null;
    let settlementHash: string | null = null;
    const pairEvidence = verifySnapshot(normalized.pairSnapshot, this.policy.sourceAuthorityPolicy.pairRiskSourceId, normalized.evaluationTimeMs, this.policy.freshnessPolicy.maxPairSnapshotAgeMs, 'PAIR_STATE_UNAVAILABLE');
    stepReasons[5]?.push(...pairEvidence.identity); stepReasons[6]?.push(...pairEvidence.temporal);
    if (normalized.entryStopProposal !== null) {
      const entryEvidence = verifySnapshot(normalized.entryStopProposal, this.policy.sourceAuthorityPolicy.pairRiskSourceId, normalized.evaluationTimeMs, this.policy.freshnessPolicy.maxPairSnapshotAgeMs, 'PAIR_STATE_UNAVAILABLE');
      stepReasons[5]?.push(...entryEvidence.identity); stepReasons[6]?.push(...entryEvidence.temporal);
    }
    if (normalized.accountSnapshot !== null) {
      const checked = verifySnapshot(normalized.accountSnapshot, this.policy.sourceAuthorityPolicy.accountRiskSourceId, normalized.evaluationTimeMs, this.policy.freshnessPolicy.maxAccountSnapshotAgeMs, 'ACCOUNT_STATE_STALE');
      accountHash = checked.hash; stepReasons[5]?.push(...checked.identity); stepReasons[6]?.push(...checked.temporal);
      if (!normalized.accountSnapshot.accountStateKnown && action !== 'NO_CHANGE') stepReasons[6]?.push('ACCOUNT_STATE_UNAVAILABLE');
    } else if (action === 'OPEN' || action === 'CLOSE' || action === 'REVERSAL_DEFERRED') stepReasons[6]?.push('ACCOUNT_STATE_UNAVAILABLE');
    if (normalized.exposureSnapshot !== null) {
      const checked = verifySnapshot(normalized.exposureSnapshot, this.policy.sourceAuthorityPolicy.exposureSourceId, normalized.evaluationTimeMs, this.policy.freshnessPolicy.maxExposureSnapshotAgeMs, 'EXPOSURE_STATE_STALE');
      exposureHash = checked.hash; stepReasons[5]?.push(...checked.identity); stepReasons[6]?.push(...checked.temporal);
    } else if (action === 'OPEN') stepReasons[6]?.push('EXPOSURE_STATE_UNAVAILABLE');
    if (normalized.leverageTierSnapshot !== null) {
      const checked = verifySnapshot(normalized.leverageTierSnapshot, this.policy.sourceAuthorityPolicy.leverageTierSourceId, normalized.evaluationTimeMs, this.policy.freshnessPolicy.maxLeverageTierSnapshotAgeMs, 'LEVERAGE_TIERS_STALE');
      tierHash = checked.hash; stepReasons[5]?.push(...checked.identity); stepReasons[6]?.push(...checked.temporal);
    } else if (action === 'OPEN') stepReasons[6]?.push('LEVERAGE_TIERS_UNAVAILABLE');
    if (normalized.settlementRateSnapshot !== null) {
      const checked = verifySnapshot(normalized.settlementRateSnapshot, this.policy.sourceAuthorityPolicy.conversionSourceId, normalized.evaluationTimeMs, this.policy.freshnessPolicy.maxSettlementRateSnapshotAgeMs, 'SETTLEMENT_RATE_STALE');
      settlementHash = checked.hash; stepReasons[5]?.push(...checked.identity); stepReasons[6]?.push(...checked.temporal);
    } else if (action === 'OPEN' || (normalized.pairSnapshot.position.state === 'OPEN' && action !== 'NO_CHANGE')) stepReasons[6]?.push('SETTLEMENT_RATE_UNAVAILABLE');

    if (normalized.accountSnapshot !== null && normalized.pairSnapshot.ownership.status === 'RECONCILED' && normalized.pairSnapshot.ownership.accountId !== normalized.accountSnapshot.accountId) stepReasons[3]?.push('ACCOUNT_IDENTITY_MISMATCH');
    if (action === 'NO_CHANGE') stepReasons[7]?.push('NO_CHANGE_TARGET_ALREADY_HELD');
    if (action === 'REVERSAL_DEFERRED') stepReasons[7]?.push('REVERSAL_REQUIRES_SEQUENTIAL_EVALUATION');
    if (action === 'OPEN' && (normalized.pairSnapshot.status.toUpperCase() !== 'ACTIVE' || normalized.pairSnapshot.exitOnly)) stepReasons[8]?.push('INSTRUMENT_NOT_TRADEABLE_FOR_NEW_EXPOSURE');

    const valuation = verifyCurrentValuation(normalized.pairSnapshot, normalized.settlementRateSnapshot, this.policy, normalized.evaluationTimeMs);
    if (action !== 'NO_CHANGE') {
      stepReasons[5]?.push(...valuation.reasons.filter((code) => code !== 'POSITION_OWNERSHIP_UNRECONCILED' && code !== 'EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION'));
      stepReasons[6]?.push(...valuation.reasons.filter((code) => code === 'EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION'));
    }
    const ownership = verifyOwnership(normalized.pairSnapshot, normalized.candidate, normalized.accountSnapshot?.accountId ?? null,
      valuation.unitValuationInrPerQty, valuation.aggregateCurrentNotionalInr);
    if (action !== 'NO_CHANGE') stepReasons[9]?.push(...ownership.reasons, ...valuation.reasons.filter((code) => code === 'POSITION_OWNERSHIP_UNRECONCILED'));
    if (action === 'CLOSE' && ownership.ownedQuantity === null) stepReasons[9]?.push('POSITION_OWNERSHIP_MISMATCH');
    if (action === 'OPEN' && normalized.exposureSnapshot?.pending.status === 'UNKNOWN') stepReasons[9]?.push('PENDING_EXPOSURE_UNKNOWN');

    const sizing = evaluatePositionSizing({ action, candidate: normalized.candidate, entryStopProposal: normalized.entryStopProposal, leverageProposal: normalized.leverageProposal,
      override: normalized.override, accountSnapshot: normalized.accountSnapshot, pairSnapshot: normalized.pairSnapshot, exposureSnapshot: normalized.exposureSnapshot,
      leverageTierSnapshot: normalized.leverageTierSnapshot, settlementRateSnapshot: normalized.settlementRateSnapshot }, this.policy, this.positionSizingPreflightAudit(normalized, action));
    for (const step of sizing.decision.auditTrail) stepReasons[step.step - 1]?.push(...step.reasonCodes as readonly RiskRejectionCode[]);
    if (action === 'OPEN') {
      stepReasons[11]?.push(...exposureReasons(normalized.exposureSnapshot, normalized.candidate, this.policy, sizing.decision.sizing?.finalNotionalInr ?? null));
      stepReasons[11]?.push(...lossDrawdownReasons(normalized.accountSnapshot, this.policy, normalized.evaluationTimeMs));
    }
    let closeNotionalUsdt: string | null = null;
    if (action === 'CLOSE' && ownership.ownedQuantity !== null && normalized.pairSnapshot.position.state === 'OPEN' && normalized.pairSnapshot.position.valuation !== null) {
      try {
        closeNotionalUsdt = canonicalRiskDecimal(checkedProduct(riskDecimal(ownership.ownedQuantity),
          riskDecimal(normalized.pairSnapshot.position.valuation.valuationPriceUsdt), riskDecimal(normalized.pairSnapshot.contractMultiplier)));
      } catch (error) {
        if (error instanceof ValuationNumericContextError) stepReasons[9]?.push('VALUATION_NUMERIC_CONTEXT_EXCEEDED'); else throw error;
      }
    }
    const hashes: RiskInputContentHashes = { accountSnapshotSha256: accountHash, pairSnapshotSha256: evidenceContentSha256(normalized.pairSnapshot), exposureSnapshotSha256: exposureHash, leverageTierSnapshotSha256: tierHash, settlementRateSnapshotSha256: settlementHash };
    const allReasons = orderReasonCodes(unique(stepReasons.flat()));
    const sizingStepExecuted = sizing.decision.auditTrail.some((step) => step.step === 11 && step.outcome !== 'SKIPPED');
    const trail = audit(stepReasons, action, sizingStepExecuted);
    const base = {
      schemaVersion: 1 as const, riskPolicyId: this.policy.riskPolicyId, sourceStrategyDecisionId: decision.decisionId,
      sourcePositionSizingDecisionId: sizing.decision.positionSizingDecisionId, strategyId: decision.strategyId, strategyVersion: decision.strategyVersion,
      parameterHash: decision.parameterHash, strategyInstanceId: decision.strategyInstanceId, pair: decision.pair, riskMode: this.policy.modeConfig.mode,
      evaluationTimeMs: normalized.evaluationTimeMs, capsApplied: sizing.capsApplied, auditTrail: trail, inputContentHashes: hashes,
    };
    const identify = (result: RiskDecisionDraft): RiskDecision => {
      const reasonCodes = result.status === 'REJECTED'
        ? [result.primaryReasonCode, ...result.secondaryReasonCodes] : result.reasonCodes;
      const riskDecisionId = sha256CanonicalJson(riskDecisionIdentityPayload(normalized, this.policy, sizing.decision.positionSizingDecisionId, hashes,
        { status: result.status, action: result.action, approved: result.approved, reasonCodes }));
      return freezeRiskRuntime({ ...result, riskDecisionId });
    };
    if (allReasons.length > 0) {
      const primary = allReasons[0];
      if (primary === undefined) throw new Error('Rejected decision requires a primary reason');
      return identify({ ...base, status: 'REJECTED', action, approved: null, primaryReasonCode: primary, secondaryReasonCodes: allReasons.slice(1) });
    }
    if (action === 'OPEN') return identify(this.acceptOpen(base, sizing));
    if (action === 'CLOSE') return identify(this.acceptClose(base, normalized, ownership.ownedQuantity, ownership.ownedNotionalInr, closeNotionalUsdt));
    throw new Error('Non-executable action cannot be accepted');
  }

  private normalize(context: RiskEvaluationContext): RiskEvaluationContext {
    let normalized = normalizeRiskEvaluationContext(context);
    if (normalized.expectedRiskPolicyId !== undefined && normalized.expectedRiskPolicyId !== this.policy.riskPolicyId) throw new RiskConfigError('RISK_POLICY_IDENTITY_MISMATCH', 'Expected riskPolicyId does not match');
    if (normalized.override !== null) normalized = freezeRiskRuntime({ ...normalized, override: normalizeRiskOverride(this.policy, normalized.override) });
    return normalized;
  }

  private positionSizingPreflightAudit(context: RiskEvaluationContext, action: string): readonly RiskAuditStep[] {
    const decision = context.candidate.strategyDecision;
    const stepReasons: RiskRejectionCode[][] = Array.from({ length: 10 }, () => []);
    stepReasons[2]?.push(...strategyLineageReasons(context.candidate, context.strategyOrigin));
    if (decision.evaluationTimeMs > context.evaluationTimeMs) stepReasons[6]?.push('EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION');
    if (context.candidate.pair !== decision.pair || context.pairSnapshot.pair !== decision.pair ||
        this.policy.pairConfig.pair !== decision.pair || context.candidate.instrumentSpecSnapshotId !== context.pairSnapshot.instrumentSpecSnapshotId) {
      stepReasons[3]?.push('DECISION_IDENTITY_MISMATCH');
    }
    if (context.entryStopProposal !== null &&
        (context.entryStopProposal.sourceStrategyDecisionId !== decision.decisionId || context.entryStopProposal.pair !== decision.pair)) stepReasons[4]?.push('DECISION_IDENTITY_MISMATCH');
    if (context.leverageProposal !== null && context.leverageProposal.sourceStrategyDecisionId !== decision.decisionId) stepReasons[4]?.push('DECISION_IDENTITY_MISMATCH');
    if (action === 'OPEN') {
      const snapshots: readonly [
        { readonly provenance: { readonly sourceId: string; readonly sourceTimeMs: number | null; readonly observedAtMs: number; readonly contentSha256: string } } | null,
        string, number, RiskRejectionCode,
      ][] = [
        [context.pairSnapshot, this.policy.sourceAuthorityPolicy.pairRiskSourceId, this.policy.freshnessPolicy.maxPairSnapshotAgeMs, 'PAIR_STATE_UNAVAILABLE'],
        [context.entryStopProposal, this.policy.sourceAuthorityPolicy.pairRiskSourceId, this.policy.freshnessPolicy.maxPairSnapshotAgeMs, 'PAIR_STATE_UNAVAILABLE'],
        [context.accountSnapshot, this.policy.sourceAuthorityPolicy.accountRiskSourceId, this.policy.freshnessPolicy.maxAccountSnapshotAgeMs, 'ACCOUNT_STATE_STALE'],
        [context.exposureSnapshot, this.policy.sourceAuthorityPolicy.exposureSourceId, this.policy.freshnessPolicy.maxExposureSnapshotAgeMs, 'EXPOSURE_STATE_STALE'],
        [context.leverageTierSnapshot, this.policy.sourceAuthorityPolicy.leverageTierSourceId, this.policy.freshnessPolicy.maxLeverageTierSnapshotAgeMs, 'LEVERAGE_TIERS_STALE'],
        [context.settlementRateSnapshot, this.policy.sourceAuthorityPolicy.conversionSourceId, this.policy.freshnessPolicy.maxSettlementRateSnapshotAgeMs, 'SETTLEMENT_RATE_STALE'],
      ];
      for (const [snapshot, source, age, stale] of snapshots) {
        if (snapshot !== null) {
          const evidence = verifySnapshot(snapshot, source, context.evaluationTimeMs, age, stale);
          stepReasons[5]?.push(...evidence.identity); stepReasons[6]?.push(...evidence.temporal);
        }
      }
      stepReasons[9]?.push(...reservationIdentityReasons(context.exposureSnapshot, context.candidate));
    }
    const executed = action === 'OPEN' ? [3, 4, 5, 6, 7, 10] : [3, 4, 5, 7];
    return executed.map((step) => ({ step, name: STEP_NAMES[step - 1] ?? '', outcome: (stepReasons[step - 1]?.length ?? 0) > 0 ? 'FAIL' : 'PASS', reasonCodes: orderReasonCodes(stepReasons[step - 1] ?? []) }));
  }

  private acceptOpen(base: Omit<AcceptedOpenRiskDecision, 'riskDecisionId' | 'status' | 'action' | 'approved' | 'reasonCodes'>, sizing: PositionSizingEvaluation): Omit<AcceptedOpenRiskDecision, 'riskDecisionId'> {
    const value = sizing.decision.sizing;
    if (sizing.decision.outcome !== 'SIZED' || value === null) throw new Error('Accepted OPEN requires SIZED decision');
    return freezeRiskRuntime({ ...base, status: 'ACCEPTED', action: 'OPEN', approved: {
      approvedQuantity: value.finalQuantity, approvedLeverage: value.finalLeverage, approvedNotionalUsdt: value.finalNotionalUsdt,
      approvedNotionalInr: value.finalNotionalInr, estimatedInitialMarginUsdt: value.estimatedInitialMarginUsdt,
      estimatedInitialMarginInr: value.estimatedInitialMarginInr, estimatedStopLossRiskInr: value.estimatedStopLossRiskInr,
    }, reasonCodes: [] });
  }

  private acceptClose(base: Omit<AcceptedCloseRiskDecision, 'riskDecisionId' | 'status' | 'action' | 'approved' | 'reasonCodes'>, context: RiskEvaluationContext, quantity: string | null, notionalInr: string | null, notionalUsdt: string | null): Omit<AcceptedCloseRiskDecision, 'riskDecisionId'> {
    if (quantity === null || notionalInr === null || notionalUsdt === null || context.pairSnapshot.position.state !== 'OPEN' || context.pairSnapshot.position.valuation === null) throw new Error('Accepted CLOSE requires reconciled ownership');
    return freezeRiskRuntime({ ...base, status: 'ACCEPTED', action: 'CLOSE', approved: { approvedQuantity: quantity, approvedNotionalUsdt: notionalUsdt, approvedNotionalInr: notionalInr }, reasonCodes: [] });
  }
}

export function createRiskEngine(draft: RiskPolicyDraft): RiskEngine { return new RiskEngine(createRiskPolicy(draft)); }
export function evaluateRisk(policy: RiskPolicy, context: RiskEvaluationContext): RiskDecision { return new RiskEngine(policy).evaluateRisk(context); }
