import type { StrategyRegistry } from '../../strategies/core/registry';
import type { MatrixBacktestExecutionConfig, MatrixPairCatalogEntry, MatrixPairExecutionResources, StrategyParameterCandidateSpace } from '../strategy-coin-matrix/types';

export const DAY_MS = 86_400_000;

export interface ValidationWalkForwardConfig { readonly policyId: 'P12_WALK_FORWARD_V1'; readonly trainDays: number; readonly testDays: number; readonly stepDays: number; readonly embargoDays: number }
export type HoldoutExposureDeclaration = 'UNSEEN_BY_OPERATOR' | 'PREVIOUSLY_OBSERVED';
export interface ValidationHoldoutConfig { readonly holdoutStartMs: number; readonly holdoutEndExclusiveMs: number; readonly exposureDeclaration: HoldoutExposureDeclaration }
export interface ValidationMetricPolicyConfig {
  readonly policyId: 'P12_METRIC_POLICY_V1'; readonly annualRiskFreeRate: string; readonly annualSortinoTargetRate: string;
  readonly annualizationFactor: 365; readonly minDailyObservations: number; readonly minClosedTrades: number; readonly sharpeDegradationDenominatorFloor: string;
}
export interface ValidationApprovalThresholds {
  readonly minOosClosedTrades: number; readonly minDailyObservations: number; readonly minOosSharpe: string; readonly minOosSortino: string;
  readonly maxOosDrawdownPercent: string; readonly minNetDailyProfitFactor: string; readonly minNetDailyExpectancy: string; readonly minOosFoldPassRatio: string;
  readonly maxIsToOosSharpeDegradation: string; readonly requireCostStressSurvival: boolean; readonly maxMonteCarloAdverseDrawdownPercent: string;
  readonly minDeflatedSharpeZ: string; readonly requireHoldoutPositiveReturn: boolean; readonly minHoldoutSharpe: string; readonly requireFreshHoldout: boolean;
}
export interface ValidationCostModel { readonly makerFeeRate: string; readonly takerFeeRate: string; readonly halfSpreadBps: string; readonly marketSlippageBps: string; readonly stopSlippageBps: string }
export interface ValidationCostStressConfig { readonly policyId: 'P12_COST_STRESS_V1'; readonly scenarios: readonly { readonly scenarioId: string; readonly costModel: ValidationCostModel }[] }
export interface ValidationMonteCarloConfig { readonly policyId: 'P12_MONTE_CARLO_PERMUTATION_V1'; readonly simulationCount: number; readonly adversePercentile: number; readonly seedDerivationPolicy: 'HMAC_SHA256_V1' }
export interface ValidationOverfittingConfig { readonly policyId: 'P12_DEFLATED_SHARPE_Z_V1'; readonly metric: 'DEFLATED_SHARPE_Z' }
export interface ParameterNeighborhoodMapping { readonly targetParameterHash: string; readonly adjacentNeighborParameterHashes: readonly string[] }
export interface ValidationStrategyInput { readonly strategyId: string; readonly strategyVersion: string; readonly candidateSpace: StrategyParameterCandidateSpace }

export interface ResearchValidationPlanInput {
  readonly planName: string; readonly validationPolicyVersion: 'P12_VALIDATION_POLICY_V1'; readonly pairBindings: readonly MatrixPairCatalogEntry[];
  readonly strategies: readonly ValidationStrategyInput[]; readonly validationWindow: { readonly startMs: number; readonly endExclusiveMs: number };
  readonly walkForward: ValidationWalkForwardConfig; readonly holdout: ValidationHoldoutConfig; readonly metricPolicy: ValidationMetricPolicyConfig;
  readonly thresholds: ValidationApprovalThresholds; readonly costStress: ValidationCostStressConfig; readonly monteCarlo: ValidationMonteCarloConfig;
  readonly overfitting: ValidationOverfittingConfig; readonly backtestBaseConfig: MatrixBacktestExecutionConfig; readonly parameterNeighborhoods?: readonly ParameterNeighborhoodMapping[];
}
export interface ResearchValidationPlan extends ResearchValidationPlanInput { readonly schemaVersion: 1; readonly sourceIdentity: { readonly gitCommitHash: string }; readonly pairUniverse: readonly string[] }
export interface ResearchValidationSubject { readonly validationSubjectId: string; readonly pair: string; readonly strategyId: string; readonly strategyVersion: string; readonly parameterHash: string; readonly normalizedParameters: Readonly<Record<string, unknown>> }
export interface ValidationFoldDefinition {
  readonly foldIndex: number; readonly isValidationFoldId: string; readonly oosValidationFoldId: string;
  readonly isStartMs: number; readonly isEndExclusiveMs: number; readonly oosStartMs: number; readonly oosEndExclusiveMs: number;
}
export interface FinalizedResearchValidationPlan { readonly plan: ResearchValidationPlan; readonly validationPlanId: string; readonly subjects: readonly ResearchValidationSubject[]; readonly folds: readonly ValidationFoldDefinition[]; readonly unusedTailMs: number }

export type MetricValidityStatus = 'VALUE' | 'UNDEFINED' | 'INSUFFICIENT_DATA';
export type MetricUndefinedReason = 'ZERO_SAMPLE_VARIANCE' | 'ZERO_DOWNSIDE_DEVIATION' | 'ZERO_LOSSES' | 'ZERO_DENOMINATOR' | 'ZERO_BASELINE_EQUITY' | 'NON_POSITIVE_BASELINE_EQUITY' | 'NON_POSITIVE_PRIOR_EQUITY' | 'NON_POSITIVE_SIMULATED_EQUITY' | 'DSR_ESTIMATOR_VARIANCE_INVALID' | 'ZERO_DSR_ESTIMATOR_DEVIATION';
export interface MetricValueResult<T = string> { readonly status: 'VALUE'; readonly value: T }
export interface MetricUndefinedResult { readonly status: 'UNDEFINED'; readonly reason: MetricUndefinedReason; readonly value: null }
export interface MetricInsufficientDataResult { readonly status: 'INSUFFICIENT_DATA'; readonly reason: string; readonly count: number; readonly required: number; readonly value: null }
export type ValidationMetric<T = string> = MetricValueResult<T> | MetricUndefinedResult | MetricInsufficientDataResult;
export interface CanonicalDailyTerminalEquity { readonly boundaryTimeMs: number; readonly equity: string }
export interface CanonicalValidationEvidence {
  readonly equityPath: readonly { readonly eventTimeMs: number; readonly equity: string }[];
  readonly schemaVersion: 1; readonly validationPlanId: string; readonly validationSubjectId: string; readonly validationFoldId: string; readonly scenarioId: string;
  readonly matrixPlanId: string; readonly matrixCellId: string; readonly expectedRunId: string; readonly runId: string; readonly resultSha256: string;
  readonly observedEventLedgerSha256: string; readonly phase9EventLedgerSha256: string; readonly observedEventCount: number; readonly baselineEquity: string;
  readonly terminalAnalysisEquity: string; readonly totalNetReturn: string; readonly maxDrawdownAmount: string; readonly maxDrawdownPercent: string;
  readonly totalFills: number; readonly totalClosedTrades: number; readonly totalFees: string; readonly fundingPnl: string;
  readonly dailyEquities: readonly CanonicalDailyTerminalEquity[]; readonly dailyReturns: ValidationMetric<readonly string[]>; readonly closedTradeGrossPnls: readonly string[];
  readonly validationEvidenceSha256: string;
}
export interface ValidationMetrics { readonly totalNetReturn: ValidationMetric; readonly maxDrawdownPercent: ValidationMetric; readonly sharpe: ValidationMetric; readonly sortino: ValidationMetric; readonly grossTradeProfitFactor: ValidationMetric; readonly grossTradeExpectancy: ValidationMetric; readonly netDailyProfitFactor: ValidationMetric; readonly netDailyExpectancy: ValidationMetric }
export type ValidationGateStatus = 'PASS' | 'FAIL' | 'UNAVAILABLE' | 'DISABLED';
export interface ValidationGateEvaluation { readonly gateId: string; readonly gateName: string; readonly status: ValidationGateStatus; readonly observedValue: string | number | null; readonly thresholdValue: string | number | boolean | null; readonly reason?: string }
export interface ValidationFoldResult { readonly validationFoldId: string; readonly kind: 'IS' | 'OOS'; readonly evidence: CanonicalValidationEvidence | null; readonly metrics: ValidationMetrics | null; readonly verdict?: 'PASS' | 'FAIL' | 'INSUFFICIENT_EVIDENCE'; readonly failureCode?: string }
export interface ValidationCostStressEvaluation { readonly scenarioId: string; readonly evidence: readonly CanonicalValidationEvidence[]; readonly totalNetReturn: ValidationMetric }
export interface ValidationMonteCarloResult { readonly status: MetricValidityStatus; readonly adversePercentile: number; readonly simulationCount: number; readonly seedHex: string; readonly adverseDrawdownPercent: string | null; readonly reason?: string }
export interface ValidationHoldoutEvaluation { readonly evidence: CanonicalValidationEvidence | null; readonly metrics: ValidationMetrics | null; readonly exposureDeclaration: HoldoutExposureDeclaration; readonly positiveReturnGate: ValidationGateEvaluation; readonly freshnessGate: ValidationGateEvaluation }
export interface StrategyValidationRecord {
  readonly validationSubjectId: string; readonly pair: string; readonly strategyId: string; readonly strategyVersion: string; readonly parameterHash: string;
  readonly verdict: 'PASSED' | 'FAILED' | 'INSUFFICIENT_EVIDENCE'; readonly foldResults: readonly ValidationFoldResult[]; readonly aggregateOosMetrics: ValidationMetrics;
  readonly gateEvaluations: readonly ValidationGateEvaluation[]; readonly costStressEvaluations?: readonly ValidationCostStressEvaluation[];
  readonly monteCarloResult?: ValidationMonteCarloResult; readonly holdoutEvaluation?: ValidationHoldoutEvaluation; readonly validationSubjectResultSha256: string;
  readonly parameterNeighborhoodSensitivity?: ValidationMetric;
}
export type ValidationPlanStatus = 'COMPLETED' | 'PARTIAL' | 'FAILED';
export interface AbortedValidationSubject { readonly validationSubjectId: string; readonly code: string }
export interface ResearchValidationPlanResult {
  readonly validationPlanId: string; readonly planName: string; readonly status: ValidationPlanStatus; readonly totalSubjects: number; readonly passedSubjects: number;
  readonly failedSubjects: number; readonly insufficientEvidenceSubjects: number; readonly totalFolds: number; readonly unusedTailMs: number;
  readonly freshnessBasis: 'OPERATOR_ATTESTATION_V1'; readonly subjectResults: readonly StrategyValidationRecord[]; readonly abortedSubjects: readonly AbortedValidationSubject[];
  readonly validationResultSha256: string;
}
export interface ValidationExecutionDependencies { readonly registry: StrategyRegistry; readonly pairResources: readonly MatrixPairExecutionResources[] }
export interface ValidationExecutionOptions { readonly workerCount?: number; readonly verificationPageMinutes?: number }
