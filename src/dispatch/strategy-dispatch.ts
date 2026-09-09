import { ResearchApprovalOrigin } from '../research/research-validation';
import { createStrategyRiskHandoff, type StrategyRiskCandidate } from '../risk';
import type { StrategyDecision, StrategyDecisionOrigin, StrategyKernel } from '../strategies';

// [C-F06] Narrowest production owner of "RESEARCH APPROVAL -> STRATEGY DISPATCH
// ELIGIBILITY -> RISK EVALUATION". Deliberately outside RiskEngine (which stays a
// pure evaluator, unaware of research approval) and outside Phase 12 (which owns
// only whether a subject passed, not whether it may be dispatched right now).
//
// An unapproved or mismatched strategy configuration can never reach
// `createStrategyRiskHandoff` (and therefore never reach `RiskEngine.evaluateRisk`)
// through this function: it returns null for every rejection case rather than
// constructing a candidate.
export function authorizeStrategyDispatch(
  kernel: StrategyKernel,
  decision: StrategyDecision,
  instrumentSpecSnapshotId: string,
  researchApproval: ResearchApprovalOrigin | null,
): { readonly candidate: StrategyRiskCandidate; readonly strategyOrigin: StrategyDecisionOrigin } | null {
  const approval = ResearchApprovalOrigin.read(researchApproval);
  // Missing approval, or an object that is not a genuine ResearchApprovalOrigin
  // (forged, foreign, or a caller-rehashed lookalike) — read() returns null for all.
  if (approval === null) return null;
  // Wrong pair / strategyId / strategyVersion / parameterHash relative to the
  // strategy actually being dispatched: the approval was genuine, but for a
  // different subject than this kernel instance represents.
  if (approval.pair !== kernel.pair || approval.strategyId !== kernel.strategyId ||
      approval.strategyVersion !== kernel.strategyVersion || approval.parameterHash !== kernel.parameterHash) return null;
  return createStrategyRiskHandoff(kernel, decision, instrumentSpecSnapshotId);
}
