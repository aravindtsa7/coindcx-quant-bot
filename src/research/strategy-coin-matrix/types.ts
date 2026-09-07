import type { HistoricalDatasetManifest } from '../../market-data/historical';
import type {
  BacktestDatasetSource,
  BacktestFailedRunResult,
  BacktestFundingFidelity,
  BacktestFundingSchedule,
  BacktestInstrumentSpec,
  BacktestRunResult,
  BacktestEventSink,
} from '../../backtest/types';
import type { StrategyRegistry } from '../../strategies/core/registry';
import type { MatrixErrorCode } from './errors';

export const PHASE11_INDICATOR_BOOTSTRAP_POLICY_V1 = 'P11_INDICATOR_BOOTSTRAP_V1' as const;
export type MatrixBootstrapPolicyId = typeof PHASE11_INDICATOR_BOOTSTRAP_POLICY_V1;

export interface StrategyParameterCandidateSpace {
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly dimensions: Readonly<Record<string, readonly unknown[]>>;
}

export interface MatrixPairDatasetBinding {
  readonly pair: string;
  readonly datasetId: string;
  readonly datasetContentSha256: string;
}

export interface MatrixStrategyCatalogEntry {
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly candidateSpace: StrategyParameterCandidateSpace;
}

export interface MatrixPairCatalogEntry {
  readonly pair: string;
  readonly datasetBinding: MatrixPairDatasetBinding;
  readonly fixedResearchQuantity: string;
  readonly instrumentSpecSnapshotId: string;
  readonly fundingScheduleBinding: {
    readonly sourceId: string;
    readonly contentSha256: string;
    readonly fidelity: BacktestFundingFidelity;
  };
}

export interface MatrixBacktestExecutionConfig {
  readonly initialEquity: string;
  readonly costModel: {
    readonly makerFeeRate: string;
    readonly takerFeeRate: string;
    readonly halfSpreadBps: string;
    readonly marketSlippageBps: string;
    readonly stopSlippageBps: string;
  };
  readonly intrabarAmbiguityPolicy: 'ADVERSE_FIRST';
  readonly maxOpenOrders: number;
  readonly engineSemanticVersion: string;
}

export interface StrategyCoinMatrixPlanInput {
  readonly planName: string;
  readonly bootstrapPolicyId: MatrixBootstrapPolicyId;
  readonly researchWindow: {
    readonly analysisStartMs: number;
    readonly analysisEndExclusiveMs: number;
  };
  readonly pairs: readonly MatrixPairCatalogEntry[];
  readonly strategies: readonly MatrixStrategyCatalogEntry[];
  readonly backtestConfig: MatrixBacktestExecutionConfig;
}

export interface StrategyCoinMatrixPlan extends StrategyCoinMatrixPlanInput {
  readonly schemaVersion: 1;
  readonly sourceIdentity: { readonly gitCommitHash: string };
}

export interface MatrixPairExecutionResources {
  readonly pair: string;
  readonly datasetManifest: HistoricalDatasetManifest;
  readonly datasetSource: BacktestDatasetSource;
  readonly instrumentSpec: BacktestInstrumentSpec;
  readonly fundingSchedule: BacktestFundingSchedule;
}

export interface StrategyCoinMatrixCell {
  readonly matrixCellId: string;
  readonly matrixPlanId: string;
  readonly cellSequence: number;
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly normalizedParameters: Readonly<Record<string, unknown>>;
  readonly parameterHash: string;
  readonly strategyInstanceId: string;
  readonly datasetId: string;
  readonly datasetContentSha256: string;
  readonly timeRange: {
    readonly bootstrapFromInclusiveMs: number;
    readonly evaluationFromInclusiveMs: number;
    readonly evaluationToExclusiveMs: number;
    readonly replayToExclusiveMs: number;
  };
  readonly fixedResearchQuantity: string;
  readonly expectedRunId: string;
}

export interface FinalizedStrategyCoinMatrixPlan {
  readonly plan: StrategyCoinMatrixPlan;
  readonly matrixPlanId: string;
  readonly cells: readonly StrategyCoinMatrixCell[];
}

export interface MatrixCellFailure {
  readonly code: MatrixErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface MatrixCellResultBase {
  readonly matrixCellId: string;
  readonly cellSequence: number;
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly strategyInstanceId: string;
  readonly datasetId: string;
  readonly expectedRunId: string;
}

export interface MatrixCellCompletedResult extends MatrixCellResultBase {
  readonly status: 'COMPLETED';
  readonly runId: string;
  readonly outcome: BacktestRunResult;
  readonly failure: null;
}

export interface MatrixCellFailedResult extends MatrixCellResultBase {
  readonly status: 'FAILED';
  readonly runId: string | null;
  readonly outcome: BacktestFailedRunResult | null;
  readonly failure: MatrixCellFailure;
}

export type StrategyCoinMatrixCellResult = MatrixCellCompletedResult | MatrixCellFailedResult;
export type MatrixPlanStatus = 'COMPLETED' | 'PARTIAL' | 'FAILED';

export interface StrategyCoinMatrixPlanResult {
  readonly matrixPlanId: string;
  readonly planName: string;
  readonly status: MatrixPlanStatus;
  readonly totalCells: number;
  readonly completedCells: number;
  readonly failedCells: number;
  readonly cellResults: readonly StrategyCoinMatrixCellResult[];
  readonly matrixResultSha256: string;
}

export interface MatrixCompletedResultCache {
  get(matrixCellId: string): Promise<unknown> | unknown;
}

export interface MatrixPlanningDependencies {
  readonly registry: StrategyRegistry;
  readonly pairResources: readonly MatrixPairExecutionResources[];
}

export interface MatrixExecutionDependencies extends MatrixPlanningDependencies {
  readonly cache?: MatrixCompletedResultCache;
}

export interface MatrixExecutionOptions {
  readonly workerCount?: number;
  readonly verificationPageMinutes?: number;
  readonly eventSinkFactory?: (cell: StrategyCoinMatrixCell) => BacktestEventSink;
}
