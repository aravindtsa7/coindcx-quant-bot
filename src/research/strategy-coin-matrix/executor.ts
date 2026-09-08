import { BacktestEngine } from '../../backtest/engine';
import { BacktestDecimal } from '../../backtest/decimal';
import { deriveBacktestFundingScheduleForWindow } from '../../backtest/manifest';
import { sha256CanonicalJson } from '../../backtest/canonical-json';
import type { BacktestCostModel, BacktestRunOutcome } from '../../backtest/types';
import {
  buildStrategyBacktestParticipantIdentity,
  createStrategyBacktestIndicatorBindings,
  StrategyBacktestParticipantAdapter,
} from '../../strategies/adapters/backtest';
import { InMemoryStrategyDecisionSink } from '../../strategies/core/audit';
import { computeStrategyParameterHash } from '../../strategies/core/identity';
import { configuredTimeframesFromRequirements, deriveIndicatorBootstrapIdentity } from './bootstrap-policy';
import { validateCachedCompletedResult } from './cache';
import { StrategyCoinMatrixError, type MatrixErrorCode } from './errors';
import { ProductionGitSourceVerifier, type GitSourceVerifier } from './git-source';
import { freezeMatrixRuntime, matrixDeepCopyFreeze } from './immutable';
import { assertAuthoritativeFinalizedPlanIntegrity, assertFinalizedPlanIntegrity, assertPairResourceIdentity } from './planner';
import type {
  FinalizedStrategyCoinMatrixPlan,
  MatrixBacktestExecutionConfig,
  MatrixCellFailedResult,
  MatrixCellFailure,
  MatrixExecutionDependencies,
  MatrixExecutionOptions,
  MatrixPairCatalogEntry,
  MatrixPairExecutionResources,
  StrategyCoinMatrixCell,
  StrategyCoinMatrixCellResult,
  StrategyCoinMatrixPlanInput,
  StrategyCoinMatrixPlanResult,
} from './types';
import { planStrategyCoinMatrix } from './planner';

function costModel(config: MatrixBacktestExecutionConfig): BacktestCostModel {
  return {
    makerFeeRate: new BacktestDecimal(config.costModel.makerFeeRate),
    takerFeeRate: new BacktestDecimal(config.costModel.takerFeeRate),
    halfSpreadBps: new BacktestDecimal(config.costModel.halfSpreadBps),
    marketSlippageBps: new BacktestDecimal(config.costModel.marketSlippageBps),
    stopSlippageBps: new BacktestDecimal(config.costModel.stopSlippageBps),
  };
}

function resultBase(cell: StrategyCoinMatrixCell) {
  return {
    matrixCellId: cell.matrixCellId,
    cellSequence: cell.cellSequence,
    pair: cell.pair,
    strategyId: cell.strategyId,
    strategyVersion: cell.strategyVersion,
    parameterHash: cell.parameterHash,
    strategyInstanceId: cell.strategyInstanceId,
    datasetId: cell.datasetId,
    expectedRunId: cell.expectedRunId,
  };
}

function failure(cell: StrategyCoinMatrixCell, code: MatrixErrorCode, message: string, outcome: BacktestRunOutcome | null = null): MatrixCellFailedResult {
  const cellFailure: MatrixCellFailure = freezeMatrixRuntime({ code, message });
  if (outcome !== null && outcome.terminalStatus === 'FAILED') {
    return freezeMatrixRuntime({ ...resultBase(cell), status: 'FAILED' as const, runId: outcome.runId, outcome, failure: cellFailure });
  }
  return freezeMatrixRuntime({ ...resultBase(cell), status: 'FAILED' as const, runId: null, outcome: null, failure: cellFailure });
}

function sourceFailureCode(error: unknown): MatrixErrorCode {
  return error instanceof StrategyCoinMatrixError &&
    ['MATRIX_SOURCE_DIRTY', 'MATRIX_SOURCE_COMMIT_MISMATCH', 'MATRIX_SOURCE_STATE_UNAVAILABLE'].includes(error.code)
    ? error.code
    : 'MATRIX_SOURCE_STATE_UNAVAILABLE';
}

function resourceMaps(finalized: FinalizedStrategyCoinMatrixPlan, dependencies: MatrixExecutionDependencies): {
  readonly pairs: ReadonlyMap<string, MatrixPairCatalogEntry>;
  readonly resources: ReadonlyMap<string, MatrixPairExecutionResources>;
} {
  const pairs = new Map(finalized.plan.pairs.map((pair) => [pair.pair, pair] as const));
  const resources = new Map<string, MatrixPairExecutionResources>();
  for (const resource of dependencies.pairResources) {
    if (resources.has(resource.pair)) throw new StrategyCoinMatrixError('RESOURCE_IDENTITY_MISMATCH', 'Runtime resources contain duplicate pairs');
    resources.set(resource.pair, resource);
  }
  return { pairs, resources };
}

async function executeCell(
  finalized: FinalizedStrategyCoinMatrixPlan,
  cell: StrategyCoinMatrixCell,
  dependencies: MatrixExecutionDependencies,
  pair: MatrixPairCatalogEntry,
  resource: MatrixPairExecutionResources,
  verificationPageMinutes: number | undefined,
  eventSinkFactory: MatrixExecutionOptions['eventSinkFactory'],
): Promise<StrategyCoinMatrixCellResult> {
  try {
    assertPairResourceIdentity(pair, resource);
    if (resource.datasetManifest.fromInclusiveMs > cell.timeRange.bootstrapFromInclusiveMs ||
        resource.datasetManifest.toExclusiveMs < cell.timeRange.replayToExclusiveMs) {
      return failure(cell, 'DATASET_COVERAGE_GAP', 'Dataset does not cover the complete planned cell range');
    }
    let cached: unknown = null;
    try { cached = await dependencies.cache?.get(cell.matrixCellId) ?? null; }
    catch { cached = null; }
    if (validateCachedCompletedResult(cell, cached)) {
      return freezeMatrixRuntime({ ...resultBase(cell), status: 'COMPLETED' as const, runId: cell.expectedRunId, outcome: cached.outcome, failure: null });
    }
    const definition = dependencies.registry.get(cell.strategyId, cell.strategyVersion);
    const describeConstruction = definition.describeConstruction;
    if (describeConstruction === undefined) return failure(cell, 'STRATEGY_REGISTRY_LOOKUP_FAILED', 'Registered strategy does not expose construction metadata');
    const description = describeConstruction(cell.normalizedParameters);
    const bootstrap = deriveIndicatorBootstrapIdentity(description.indicatorRequirements, finalized.plan.researchWindow.analysisStartMs);
    if (bootstrap.bootstrapFromInclusiveMs !== cell.timeRange.bootstrapFromInclusiveMs ||
        computeStrategyParameterHash(description.normalizedParameters) !== cell.parameterHash) {
      return failure(cell, 'RUN_ID_MISMATCH', 'Reconstructed Phase 10 metadata differs from the finalized cell');
    }
    const kernel = definition.createKernel({ pair: cell.pair, parameters: cell.normalizedParameters, indicatorBootstrapIdentity: bootstrap.entries });
    if (kernel.parameterHash !== cell.parameterHash || kernel.strategyInstanceId !== cell.strategyInstanceId ||
        sha256CanonicalJson(kernel.indicatorRequirements) !== sha256CanonicalJson(description.indicatorRequirements) ||
        kernel.triggerTimeframeMinutes !== description.triggerTimeframeMinutes) {
      return failure(cell, 'RUN_ID_MISMATCH', 'Reconstructed Phase 10 kernel differs from the finalized cell');
    }
    const participantIdentity = buildStrategyBacktestParticipantIdentity({
      kernel,
      fixedResearchQuantity: cell.fixedResearchQuantity,
      gitCommitHash: finalized.plan.sourceIdentity.gitCommitHash,
    });
    const participant = new StrategyBacktestParticipantAdapter({
      kernel,
      fixedResearchQuantity: cell.fixedResearchQuantity,
      decisionSink: new InMemoryStrategyDecisionSink(),
    });
    const engineConfig = {
      datasetManifest: resource.datasetManifest,
      datasetSource: resource.datasetSource,
      bootstrapFromInclusiveMs: cell.timeRange.bootstrapFromInclusiveMs,
      evaluationFromInclusiveMs: cell.timeRange.evaluationFromInclusiveMs,
      evaluationToExclusiveMs: cell.timeRange.evaluationToExclusiveMs,
      replayToExclusiveMs: cell.timeRange.replayToExclusiveMs,
      configuredTimeframes: configuredTimeframesFromRequirements(kernel.indicatorRequirements),
      instrumentSpec: resource.instrumentSpec,
      costModel: costModel(finalized.plan.backtestConfig),
      fundingSchedule: deriveBacktestFundingScheduleForWindow(resource.fundingSchedule, cell.timeRange.evaluationFromInclusiveMs, cell.timeRange.replayToExclusiveMs),
      indicatorBindings: createStrategyBacktestIndicatorBindings(kernel),
      participant,
      participantIdentity,
      initialEquity: finalized.plan.backtestConfig.initialEquity,
      intrabarAmbiguityPolicy: finalized.plan.backtestConfig.intrabarAmbiguityPolicy,
      maxOpenOrders: finalized.plan.backtestConfig.maxOpenOrders,
      engineSemanticVersion: finalized.plan.backtestConfig.engineSemanticVersion,
      ...(verificationPageMinutes === undefined ? {} : { verificationPageMinutes }),
    };
    const sink = eventSinkFactory?.(cell);
    const engine = sink === undefined ? new BacktestEngine(engineConfig) : new BacktestEngine(engineConfig, sink);
    if (engine.runId !== cell.expectedRunId) return failure(cell, 'RUN_ID_MISMATCH', 'Phase 9 engine runId differs from expectedRunId');
    const outcome = await engine.run();
    if (outcome.runId !== cell.expectedRunId) return failure(cell, 'RUN_ID_MISMATCH', 'Phase 9 outcome runId differs from expectedRunId', outcome);
    if (outcome.terminalStatus === 'FAILED') return failure(cell, 'CELL_EXECUTION_FAILED', 'Phase 9 backtest execution failed', outcome);
    return freezeMatrixRuntime({ ...resultBase(cell), status: 'COMPLETED' as const, runId: outcome.runId, outcome, failure: null });
  } catch (error) {
    const code = error instanceof StrategyCoinMatrixError ? error.code : 'CELL_EXECUTION_FAILED';
    const message = error instanceof Error ? error.message : 'Matrix cell execution failed';
    return failure(cell, code, message);
  }
}

function validateOptions(options: MatrixExecutionOptions): Required<Pick<MatrixExecutionOptions, 'workerCount'>> & Pick<MatrixExecutionOptions, 'verificationPageMinutes' | 'eventSinkFactory'> {
  const workerCount = options.workerCount ?? 1;
  if (!Number.isSafeInteger(workerCount) || workerCount < 1) throw new StrategyCoinMatrixError('INVALID_BACKTEST_CONFIG', 'workerCount must be a positive safe integer');
  if (options.verificationPageMinutes !== undefined && (!Number.isSafeInteger(options.verificationPageMinutes) || options.verificationPageMinutes < 1)) {
    throw new StrategyCoinMatrixError('INVALID_BACKTEST_CONFIG', 'verificationPageMinutes must be a positive safe integer');
  }
  return {
    workerCount,
    ...(options.verificationPageMinutes === undefined ? {} : { verificationPageMinutes: options.verificationPageMinutes }),
    ...(options.eventSinkFactory === undefined ? {} : { eventSinkFactory: options.eventSinkFactory }),
  };
}

function finalizeResult(
  finalized: FinalizedStrategyCoinMatrixPlan,
  cellResults: readonly StrategyCoinMatrixCellResult[],
  sourceInvalid: boolean,
): StrategyCoinMatrixPlanResult {
  if (cellResults.length !== finalized.cells.length || cellResults.some((result, index) => result.cellSequence !== index + 1)) {
    throw new StrategyCoinMatrixError('CONCURRENCY_INTEGRITY_VIOLATION', 'Terminal results do not exactly cover canonical cell sequence');
  }
  const completedCells = cellResults.filter((result) => result.status === 'COMPLETED').length;
  const failedCells = cellResults.length - completedCells;
  const status = sourceInvalid || completedCells === 0 ? 'FAILED' as const : failedCells === 0 ? 'COMPLETED' as const : 'PARTIAL' as const;
  const cellDigests = cellResults.map((result) => result.status === 'COMPLETED' ? {
    expectedRunId: result.expectedRunId,
    matrixCellId: result.matrixCellId,
    resultSha256: result.outcome.resultSha256,
    runId: result.runId,
    status: result.status,
  } : {
    expectedRunId: result.expectedRunId,
    failureCode: result.failure.code,
    matrixCellId: result.matrixCellId,
    phase9ErrorCode: result.outcome?.errorCode ?? null,
    runId: result.runId,
    status: result.status,
  });
  const hashPayload = {
    matrixPlanId: finalized.matrixPlanId,
    status,
    totalCells: cellResults.length,
    completedCells,
    failedCells,
    cellDigests,
  };
  return freezeMatrixRuntime({
    matrixPlanId: finalized.matrixPlanId,
    planName: finalized.plan.planName,
    status,
    totalCells: cellResults.length,
    completedCells,
    failedCells,
    cellResults: Object.freeze([...cellResults]),
    matrixResultSha256: sha256CanonicalJson(hashPayload),
  });
}

export async function executeWithGitSourceVerifier(
  finalized: FinalizedStrategyCoinMatrixPlan,
  dependencies: MatrixExecutionDependencies,
  options: MatrixExecutionOptions,
  verifier: GitSourceVerifier,
): Promise<StrategyCoinMatrixPlanResult> {
  const immutableFinalized = matrixDeepCopyFreeze(finalized);
  assertFinalizedPlanIntegrity(immutableFinalized);
  const normalizedOptions = validateOptions(options);
  const maps = resourceMaps(immutableFinalized, dependencies);
  const results: (StrategyCoinMatrixCellResult | undefined)[] = new Array(immutableFinalized.cells.length);
  let sourceInvalid = false;
  let sourceCode: MatrixErrorCode = 'MATRIX_SOURCE_STATE_UNAVAILABLE';
  try { await verifier.assertExpected(immutableFinalized.plan.sourceIdentity.gitCommitHash); }
  catch (error) { sourceInvalid = true; sourceCode = sourceFailureCode(error); }
  if (!sourceInvalid) assertAuthoritativeFinalizedPlanIntegrity(immutableFinalized, dependencies);
  for (let offset = 0; offset < immutableFinalized.cells.length; offset += normalizedOptions.workerCount) {
    if (sourceInvalid) break;
    if (offset > 0) {
      try { await verifier.assertExpected(immutableFinalized.plan.sourceIdentity.gitCommitHash); }
      catch (error) { sourceInvalid = true; sourceCode = sourceFailureCode(error); break; }
    }
    const batch = immutableFinalized.cells.slice(offset, offset + normalizedOptions.workerCount);
    await Promise.all(batch.map(async (cell) => {
      const pair = maps.pairs.get(cell.pair);
      const resource = maps.resources.get(cell.pair);
      results[cell.cellSequence - 1] = pair === undefined || resource === undefined
        ? failure(cell, 'RESOURCE_IDENTITY_MISMATCH', 'Planned pair execution resources are unavailable')
        : await executeCell(immutableFinalized, cell, dependencies, pair, resource, normalizedOptions.verificationPageMinutes, normalizedOptions.eventSinkFactory);
    }));
  }
  if (!sourceInvalid) {
    try { await verifier.assertExpected(immutableFinalized.plan.sourceIdentity.gitCommitHash); }
    catch (error) { sourceInvalid = true; sourceCode = sourceFailureCode(error); }
  }
  for (const cell of immutableFinalized.cells) {
    if (results[cell.cellSequence - 1] === undefined) {
      results[cell.cellSequence - 1] = failure(cell, sourceCode, 'Matrix source identity became invalid before cell dispatch');
    }
  }
  const terminal = results.map((result) => {
    if (result === undefined) throw new StrategyCoinMatrixError('CONCURRENCY_INTEGRITY_VIOLATION', 'A planned cell has no terminal result');
    return result;
  });
  return finalizeResult(immutableFinalized, Object.freeze(terminal), sourceInvalid);
}

export async function executeStrategyCoinMatrix(
  finalized: FinalizedStrategyCoinMatrixPlan,
  dependencies: MatrixExecutionDependencies,
  options: MatrixExecutionOptions = {},
): Promise<StrategyCoinMatrixPlanResult> {
  const verifier = new ProductionGitSourceVerifier(process.cwd());
  return executeWithGitSourceVerifier(finalized, dependencies, options, verifier);
}

export async function runStrategyCoinMatrix(
  input: StrategyCoinMatrixPlanInput,
  dependencies: MatrixExecutionDependencies,
  options: MatrixExecutionOptions = {},
): Promise<StrategyCoinMatrixPlanResult> {
  const finalized = await planStrategyCoinMatrix(input, dependencies);
  return executeStrategyCoinMatrix(finalized, dependencies, options);
}
