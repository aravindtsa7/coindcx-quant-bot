import type {
  AcceptedCloseRiskDecision, AcceptedOpenRiskDecision, PortfolioExposureSnapshot, RiskDecision, RiskEvaluationContext, RiskPolicy,
} from '../risk';

export type AdmissionStatus = 'ADMITTED' | 'RELEASED';

/**
 * [C-F07] The minimum transactional admission identity needed to prove ownership
 * of a pending capacity grant. Binds only current, exact fields already produced by
 * Phase 10/13 (never invents financial identity) plus one deterministic,
 * process-local `generation` counter — required because the same `riskDecisionId`
 * may legitimately be admitted again after an earlier admission for it was
 * released, and the two grants must remain distinguishable in the ledger.
 */
export interface AdmissionRecord {
  readonly admissionId: string;
  readonly generation: number;
  readonly accountId: string;
  readonly riskDecisionId: string;
  readonly sourceStrategyDecisionId: string;
  readonly strategyInstanceId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly pair: string;
  readonly decisionSequence: number;
  readonly direction: 'LONG' | 'SHORT';
  readonly approvedNotionalInr: string;
  readonly approvedMarginInr: string;
  readonly status: AdmissionStatus;
}

export interface AdmissionRequest {
  readonly accountId: string;
  readonly policy: RiskPolicy;
  readonly context: RiskEvaluationContext;
}

export type AdmissionOutcome =
  | { readonly status: 'ADMITTED'; readonly decision: AcceptedOpenRiskDecision; readonly admission: AdmissionRecord }
  | { readonly status: 'ACCEPTED_NO_CAPACITY_OWNERSHIP'; readonly decision: AcceptedCloseRiskDecision }
  | { readonly status: 'STALE_DECISION_SEQUENCE'; readonly strategyInstanceId: string; readonly decisionSequence: number; readonly latestAdmittedSequence: number }
  | { readonly status: 'REJECTED'; readonly decision: RiskDecision };

export type ReleaseOutcome =
  | { readonly status: 'RELEASED'; readonly admission: AdmissionRecord }
  | { readonly status: 'ALREADY_RELEASED'; readonly admission: AdmissionRecord }
  | { readonly status: 'UNKNOWN_ADMISSION' };

/** Everything Phase 14 is allowed to consume — never a raw `RiskDecision`. */
export interface AdmittedRiskHandoff {
  readonly admission: AdmissionRecord;
  readonly decision: AcceptedOpenRiskDecision;
}

export type { PortfolioExposureSnapshot };
