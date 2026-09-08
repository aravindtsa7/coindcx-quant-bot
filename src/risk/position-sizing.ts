import { freezeRiskRuntime } from './immutable';
import { computePositionSizingDecisionId } from './identity';
import { orderReasonCodes } from './reason-codes';
import { instrumentPriceReasons, isInstrumentPriceReason, resolveTierSizing, riskCapsForRequest } from './tier-resolution';
import type { RiskRejectionCode } from './reason-codes';
import type { PositionSizingDecision, PositionSizingRequest, RiskAuditStep, RiskCapsApplied, RiskPolicy } from './types';

export interface PositionSizingEvaluation {
  readonly decision: PositionSizingDecision;
  readonly capsApplied: RiskCapsApplied;
}

export function evaluatePositionSizing(
  request: PositionSizingRequest,
  policy: RiskPolicy,
  preflightAudit: readonly RiskAuditStep[] = [],
): PositionSizingEvaluation {
  const preflightReasons = preflightAudit.flatMap((step) => step.reasonCodes) as RiskRejectionCode[];
  const priceReasons = instrumentPriceReasons(request);
  const result = preflightReasons.length === 0
    ? resolveTierSizing(request, policy)
    : { sizing: null, reasons: preflightReasons, capsApplied: riskCapsForRequest(request, policy) };
  const ordered = orderReasonCodes([...result.reasons, ...priceReasons]);
  const applicable = request.action === 'OPEN';
  const sizingReasons = orderReasonCodes([
    ...priceReasons.filter((code) => !isInstrumentPriceReason(code)),
    ...(preflightReasons.length > 0 ? [] : result.reasons.filter((code) => !isInstrumentPriceReason(code) &&
      code !== 'ACCOUNT_STATE_UNAVAILABLE' && code !== 'EXPOSURE_STATE_UNAVAILABLE' && code !== 'PENDING_EXPOSURE_UNKNOWN')),
  ]);
  const prerequisiteAudit: RiskAuditStep[] = [];
  for (const [step, name, codes] of [
    [7, 'TEMPORAL_FRESHNESS', ['ACCOUNT_STATE_UNAVAILABLE', 'EXPOSURE_STATE_UNAVAILABLE']],
    [10, 'PENDING_OWNERSHIP_STATE', ['PENDING_EXPOSURE_UNKNOWN']],
  ] as const) {
    const reasonCodes = ordered.filter((code) => (codes as readonly string[]).includes(code));
    if (reasonCodes.length > 0) prerequisiteAudit.push({ step, name, outcome: 'FAIL', reasonCodes });
  }
  const entries: readonly RiskAuditStep[] = [...preflightAudit, ...prerequisiteAudit, {
    step: 9, name: 'INSTRUMENT_CONSTRAINTS',
    outcome: !applicable ? 'SKIPPED' : priceReasons.some(isInstrumentPriceReason) ? 'FAIL' : 'PASS',
    reasonCodes: orderReasonCodes(priceReasons.filter(isInstrumentPriceReason)),
  }, {
    step: 11, name: 'SIZING_TIER_MARGIN',
    outcome: sizingReasons.length > 0 ? 'FAIL' : result.sizing !== null ? 'PASS' : 'SKIPPED',
    reasonCodes: sizingReasons,
  }];
  const auditTrail = [...new Set(entries.map((entry) => entry.step))].sort((left, right) => left - right).map((step): RiskAuditStep => {
    const matches = entries.filter((entry) => entry.step === step);
    const reasonCodes = orderReasonCodes(matches.flatMap((entry) => entry.reasonCodes) as RiskRejectionCode[]);
    return { step, name: matches[0]?.name ?? '', reasonCodes,
      outcome: reasonCodes.length > 0 ? 'FAIL' : matches.some((entry) => entry.outcome === 'PASS') ? 'PASS' : 'SKIPPED' };
  });
  const payload: Omit<PositionSizingDecision, 'positionSizingDecisionId'> = {
    schemaVersion: 1, sourceStrategyDecisionId: request.candidate.strategyDecision.decisionId,
    strategyInstanceId: request.candidate.strategyDecision.strategyInstanceId, pair: request.candidate.pair,
    instrumentSpecSnapshotId: request.candidate.instrumentSpecSnapshotId, positionSizingPolicyId: policy.positionSizingPolicyId, action: request.action,
    outcome: !applicable ? 'NOT_APPLICABLE' : result.sizing === null ? 'NOT_SIZED' : 'SIZED', sizing: result.sizing,
    sizingReasonCodes: ordered, auditTrail,
  };
  const decision = freezeRiskRuntime({ ...payload, positionSizingDecisionId: computePositionSizingDecisionId(payload) });
  return { decision, capsApplied: freezeRiskRuntime(result.capsApplied) };
}
