import { BacktestDecimal } from '../../backtest/decimal';
import { canonicalJson, sha256CanonicalJson } from '../../backtest/canonical-json';
import { BacktestError } from '../../backtest/errors';
import { deriveBacktestFundingScheduleForWindow, normalizeBacktestInputs } from '../../backtest/manifest';
import type { BacktestCostModel } from '../../backtest/types';
import { buildStrategyBacktestParticipantIdentity, normalizeFixedResearchQuantity } from '../../strategies/adapters/backtest';
import { computeStrategyParameterHash } from '../../strategies/core/identity';
import type { StrategyDefinition, StrategyKernel } from '../../strategies/core/types';
import { configuredTimeframesFromRequirements, deriveIndicatorBootstrapIdentity } from './bootstrap-policy';
import { expandNormalizedCandidates, normalizeCandidateSpace, type NormalizedParameterCandidate } from './candidate-space';
import { StrategyCoinMatrixError } from './errors';
import { ProductionGitSourceVerifier, type GitSourceVerifier } from './git-source';
import { matrixDeepCopyFreeze } from './immutable';
import type {
  FinalizedStrategyCoinMatrixPlan,
  MatrixBacktestExecutionConfig,
  MatrixPairCatalogEntry,
  MatrixPairExecutionResources,
  MatrixPlanningDependencies,
  MatrixStrategyCatalogEntry,
  StrategyCoinMatrixCell,
  StrategyCoinMatrixPlan,
  StrategyCoinMatrixPlanInput,
} from './types';

const MINUTE_MS = 60_000;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.:@/-]{1,256}$/;
const PAIR = /^[A-Z0-9_.-]{1,64}$/;

function ascii(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function compareSemver(left: string, right: string): number {
  const pattern = /^(\d+)\.(\d+)\.(\d+)(.*)$/;
  const leftMatch = pattern.exec(left);
  const rightMatch = pattern.exec(right);
  if (leftMatch === null || rightMatch === null) return ascii(left, right);
  for (const index of [1, 2, 3]) {
    const leftPart = (leftMatch[index] ?? '').replace(/^0+(?!$)/, '');
    const rightPart = (rightMatch[index] ?? '').replace(/^0+(?!$)/, '');
    if (leftPart.length !== rightPart.length) return leftPart.length - rightPart.length;
    const difference = ascii(leftPart, rightPart);
    if (difference !== 0) return difference;
  }
  return ascii(leftMatch[4] ?? '', rightMatch[4] ?? '');
}

function normalizeWindow(window: StrategyCoinMatrixPlanInput['researchWindow']): StrategyCoinMatrixPlanInput['researchWindow'] {
  if (!Number.isSafeInteger(window.analysisStartMs) || !Number.isSafeInteger(window.analysisEndExclusiveMs) ||
      window.analysisStartMs < 0 || window.analysisEndExclusiveMs < 0 ||
      window.analysisStartMs % MINUTE_MS !== 0 || window.analysisEndExclusiveMs % MINUTE_MS !== 0 ||
      window.analysisStartMs >= window.analysisEndExclusiveMs) {
    throw new StrategyCoinMatrixError('INVALID_PARAMETER_SPACE', 'Research window must be safe, non-negative, minute-aligned, and non-empty');
  }
  return matrixDeepCopyFreeze({ ...window });
}

function normalizeBacktestConfig(config: MatrixBacktestExecutionConfig): MatrixBacktestExecutionConfig {
  try {
    if (config.intrabarAmbiguityPolicy !== 'ADVERSE_FIRST') throw new BacktestError('INVALID_BACKTEST_CONFIG', 'Only ADVERSE_FIRST is supported');
    return matrixDeepCopyFreeze({
      initialEquity: new BacktestDecimal(config.initialEquity).value,
      costModel: {
        makerFeeRate: new BacktestDecimal(config.costModel.makerFeeRate).value,
        takerFeeRate: new BacktestDecimal(config.costModel.takerFeeRate).value,
        halfSpreadBps: new BacktestDecimal(config.costModel.halfSpreadBps).value,
        marketSlippageBps: new BacktestDecimal(config.costModel.marketSlippageBps).value,
        stopSlippageBps: new BacktestDecimal(config.costModel.stopSlippageBps).value,
      },
      intrabarAmbiguityPolicy: 'ADVERSE_FIRST',
      maxOpenOrders: config.maxOpenOrders,
      engineSemanticVersion: config.engineSemanticVersion,
    });
  } catch (error) {
    throw new StrategyCoinMatrixError('INVALID_BACKTEST_CONFIG', 'Matrix backtest configuration is invalid', { cause: error });
  }
}

function normalizePairs(pairs: readonly MatrixPairCatalogEntry[]): readonly MatrixPairCatalogEntry[] {
  if (!Array.isArray(pairs) || pairs.length === 0) throw new StrategyCoinMatrixError('INVALID_PARAMETER_SPACE', 'Matrix must contain at least one pair');
  const normalized = pairs.map((entry) => {
    if (!PAIR.test(entry.pair) || entry.datasetBinding.pair !== entry.pair) {
      throw new StrategyCoinMatrixError('DATASET_PAIR_MISMATCH', 'Pair catalog and dataset binding pair differ');
    }
    if (!SHA256.test(entry.datasetBinding.datasetId) || !SHA256.test(entry.datasetBinding.datasetContentSha256) ||
        !SHA256.test(entry.instrumentSpecSnapshotId) || !SHA256.test(entry.fundingScheduleBinding.contentSha256) ||
        !ID.test(entry.fundingScheduleBinding.sourceId) ||
        !['VERIFIED_SCHEDULE', 'ASSUMPTION', 'TEST_ONLY'].includes(entry.fundingScheduleBinding.fidelity)) {
      throw new StrategyCoinMatrixError('RESOURCE_IDENTITY_MISMATCH', 'Pair catalog contains an invalid resource identity');
    }
    let fixedResearchQuantity: string;
    try { fixedResearchQuantity = normalizeFixedResearchQuantity(entry.fixedResearchQuantity); }
    catch (error) { throw new StrategyCoinMatrixError('STRATEGY_PARAM_VALIDATION_FAILED', 'Phase 10 rejected fixedResearchQuantity', { cause: error }); }
    return matrixDeepCopyFreeze({ ...entry, fixedResearchQuantity });
  }).sort((left, right) => ascii(left.pair, right.pair));
  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index]?.pair === normalized[index - 1]?.pair) throw new StrategyCoinMatrixError('INVALID_PARAMETER_SPACE', 'Pair catalog contains a duplicate pair');
  }
  return Object.freeze(normalized);
}

interface PreparedStrategy {
  readonly catalog: MatrixStrategyCatalogEntry;
  readonly definition: StrategyDefinition;
  readonly candidates: readonly NormalizedParameterCandidate[];
}

function prepareStrategies(
  entries: readonly MatrixStrategyCatalogEntry[],
  registry: MatrixPlanningDependencies['registry'],
): readonly PreparedStrategy[] {
  if (!Array.isArray(entries) || entries.length === 0) throw new StrategyCoinMatrixError('INVALID_PARAMETER_SPACE', 'Matrix must contain at least one strategy');
  const prepared = entries.map((entry) => {
    if (entry.strategyId !== entry.candidateSpace.strategyId || entry.strategyVersion !== entry.candidateSpace.strategyVersion) {
      throw new StrategyCoinMatrixError('INVALID_PARAMETER_SPACE', 'Strategy catalog identity differs from its candidate space');
    }
    let definition: StrategyDefinition;
    try { definition = registry.get(entry.strategyId, entry.strategyVersion); }
    catch (error) { throw new StrategyCoinMatrixError('STRATEGY_REGISTRY_LOOKUP_FAILED', 'Registered Phase 10 strategy was not found', { cause: error }); }
    if (definition.describeConstruction === undefined) {
      throw new StrategyCoinMatrixError('STRATEGY_REGISTRY_LOOKUP_FAILED', 'Registered strategy does not expose deterministic construction metadata');
    }
    const candidateSpace = normalizeCandidateSpace(entry.candidateSpace);
    const catalog = matrixDeepCopyFreeze({ strategyId: entry.strategyId, strategyVersion: entry.strategyVersion, candidateSpace });
    return { catalog, definition, candidates: expandNormalizedCandidates(candidateSpace, definition) };
  }).sort((left, right) => ascii(left.catalog.strategyId, right.catalog.strategyId) || compareSemver(left.catalog.strategyVersion, right.catalog.strategyVersion));
  for (let index = 1; index < prepared.length; index++) {
    if (prepared[index]?.catalog.strategyId === prepared[index - 1]?.catalog.strategyId &&
        prepared[index]?.catalog.strategyVersion === prepared[index - 1]?.catalog.strategyVersion) {
      throw new StrategyCoinMatrixError('INVALID_PARAMETER_SPACE', 'Strategy catalog contains a duplicate registered version');
    }
  }
  return Object.freeze(prepared);
}

function resourcesByPair(resources: readonly MatrixPairExecutionResources[]): ReadonlyMap<string, MatrixPairExecutionResources> {
  const result = new Map<string, MatrixPairExecutionResources>();
  for (const resource of resources) {
    if (result.has(resource.pair)) throw new StrategyCoinMatrixError('RESOURCE_IDENTITY_MISMATCH', 'Runtime resources contain a duplicate pair');
    result.set(resource.pair, resource);
  }
  return result;
}

export function assertPairResourceIdentity(pair: MatrixPairCatalogEntry, resource: MatrixPairExecutionResources): void {
  if (resource.pair !== pair.pair || resource.datasetManifest.pair !== pair.pair || resource.instrumentSpec.pair !== pair.pair) {
    throw new StrategyCoinMatrixError('RESOURCE_IDENTITY_MISMATCH', 'Runtime resource pair differs from the planned pair');
  }
  if (resource.datasetManifest.datasetId !== pair.datasetBinding.datasetId ||
      resource.datasetManifest.contentSha256 !== pair.datasetBinding.datasetContentSha256) {
    throw new StrategyCoinMatrixError('DATASET_IDENTITY_MISMATCH', 'Runtime dataset identity differs from the plan');
  }
  if (resource.instrumentSpec.instrumentSpecSnapshotId !== pair.instrumentSpecSnapshotId ||
      resource.fundingSchedule.sourceId !== pair.fundingScheduleBinding.sourceId ||
      resource.fundingSchedule.contentSha256 !== pair.fundingScheduleBinding.contentSha256 ||
      resource.fundingSchedule.fidelity !== pair.fundingScheduleBinding.fidelity) {
    throw new StrategyCoinMatrixError('RESOURCE_IDENTITY_MISMATCH', 'Runtime instrument or funding identity differs from the plan');
  }
}

function costModel(config: MatrixBacktestExecutionConfig): BacktestCostModel {
  return {
    makerFeeRate: new BacktestDecimal(config.costModel.makerFeeRate),
    takerFeeRate: new BacktestDecimal(config.costModel.takerFeeRate),
    halfSpreadBps: new BacktestDecimal(config.costModel.halfSpreadBps),
    marketSlippageBps: new BacktestDecimal(config.costModel.marketSlippageBps),
    stopSlippageBps: new BacktestDecimal(config.costModel.stopSlippageBps),
  };
}

function assertCoverage(resource: MatrixPairExecutionResources, bootstrapFromInclusiveMs: number, replayToExclusiveMs: number): void {
  if (resource.datasetManifest.fromInclusiveMs > bootstrapFromInclusiveMs || resource.datasetManifest.toExclusiveMs < replayToExclusiveMs) {
    throw new StrategyCoinMatrixError('DATASET_COVERAGE_GAP', 'Dataset does not cover the complete bootstrap and analysis window');
  }
}

function assertKernelMatchesDescription(
  kernel: StrategyKernel,
  definition: StrategyDefinition,
  candidate: NormalizedParameterCandidate,
  descriptionHash: string,
  triggerTimeframeMinutes: number,
): void {
  if (kernel.strategyId !== definition.strategyId || kernel.strategyVersion !== definition.strategyVersion ||
      kernel.parameterHash !== candidate.parameterHash || computeStrategyParameterHash(kernel.normalizedParameters) !== candidate.parameterHash ||
      kernel.triggerTimeframeMinutes !== triggerTimeframeMinutes || sha256CanonicalJson(kernel.indicatorRequirements) !== descriptionHash) {
    throw new StrategyCoinMatrixError('STRATEGY_PARAM_VALIDATION_FAILED', 'Phase 10 kernel differs from its construction metadata');
  }
}

type UnsequencedCell = Omit<StrategyCoinMatrixCell, 'matrixCellId' | 'cellSequence'>;

function cellIdentity(cell: UnsequencedCell): Readonly<Record<string, unknown>> {
  return {
    datasetContentSha256: cell.datasetContentSha256,
    datasetId: cell.datasetId,
    expectedRunId: cell.expectedRunId,
    fixedResearchQuantity: cell.fixedResearchQuantity,
    matrixPlanId: cell.matrixPlanId,
    pair: cell.pair,
    parameterHash: cell.parameterHash,
    strategyId: cell.strategyId,
    strategyInstanceId: cell.strategyInstanceId,
    strategyVersion: cell.strategyVersion,
    timeRange: cell.timeRange,
  };
}

function compareCells(left: UnsequencedCell, right: UnsequencedCell): number {
  return ascii(left.pair, right.pair) || ascii(left.strategyId, right.strategyId) || compareSemver(left.strategyVersion, right.strategyVersion) ||
    ascii(left.parameterHash, right.parameterHash) || ascii(left.strategyInstanceId, right.strategyInstanceId) || ascii(left.expectedRunId, right.expectedRunId);
}

export function assertFinalizedPlanIntegrity(finalized: FinalizedStrategyCoinMatrixPlan): void {
  if (!SHA256.test(finalized.matrixPlanId) || sha256CanonicalJson(finalized.plan) !== finalized.matrixPlanId) {
    throw new StrategyCoinMatrixError('RUN_ID_MISMATCH', 'Finalized matrix plan identity is invalid');
  }
  if (finalized.cells.length === 0) throw new StrategyCoinMatrixError('CONCURRENCY_INTEGRITY_VIOLATION', 'Finalized matrix plan has no cells');
  const ids = new Set<string>();
  for (let index = 0; index < finalized.cells.length; index++) {
    const cell = finalized.cells[index];
    if (cell === undefined || cell.cellSequence !== index + 1 || cell.matrixPlanId !== finalized.matrixPlanId ||
        cell.matrixCellId !== sha256CanonicalJson(cellIdentity(cell)) || ids.has(cell.matrixCellId) ||
        (index > 0 && compareCells(finalized.cells[index - 1] as StrategyCoinMatrixCell, cell) > 0)) {
      throw new StrategyCoinMatrixError('CONCURRENCY_INTEGRITY_VIOLATION', 'Finalized matrix cells fail identity, uniqueness, or ordering checks');
    }
    ids.add(cell.matrixCellId);
  }
}

/**
 * The single authoritative cell derivation used by both initial plan
 * finalization and serialized-plan verification. It deliberately consumes the
 * stored plan Git identity; it never captures or substitutes source state.
 */
function deriveAuthoritativeCells(
  plan: StrategyCoinMatrixPlan,
  matrixPlanId: string,
  dependencies: MatrixPlanningDependencies,
): readonly StrategyCoinMatrixCell[] {
  if (plan.bootstrapPolicyId !== 'P11_INDICATOR_BOOTSTRAP_V1') {
    throw new StrategyCoinMatrixError('MATRIX_UNSUPPORTED_INDICATOR_BOOTSTRAP_POLICY', 'Unsupported matrix bootstrap policy');
  }
  const researchWindow = normalizeWindow(plan.researchWindow);
  const pairs = normalizePairs(plan.pairs);
  const preparedStrategies = prepareStrategies(plan.strategies, dependencies.registry);
  const backtestConfig = normalizeBacktestConfig(plan.backtestConfig);
  const resourceMap = resourcesByPair(dependencies.pairResources);
  const unsequenced: UnsequencedCell[] = [];
  for (const pair of pairs) {
    const resource = resourceMap.get(pair.pair);
    if (resource === undefined) throw new StrategyCoinMatrixError('RESOURCE_IDENTITY_MISMATCH', 'Runtime resources are missing for a planned pair');
    assertPairResourceIdentity(pair, resource);
    for (const strategy of preparedStrategies) {
      for (const candidate of strategy.candidates) {
        const describeConstruction = strategy.definition.describeConstruction;
        if (describeConstruction === undefined) {
          throw new StrategyCoinMatrixError('STRATEGY_REGISTRY_LOOKUP_FAILED', 'Registered strategy does not expose deterministic construction metadata');
        }
        const description = describeConstruction(candidate.normalizedParameters);
        if (computeStrategyParameterHash(description.normalizedParameters) !== candidate.parameterHash) {
          throw new StrategyCoinMatrixError('STRATEGY_PARAM_VALIDATION_FAILED', 'Phase 10 construction metadata changed normalized parameters');
        }
        const bootstrap = deriveIndicatorBootstrapIdentity(description.indicatorRequirements, researchWindow.analysisStartMs);
        assertCoverage(resource, bootstrap.bootstrapFromInclusiveMs, researchWindow.analysisEndExclusiveMs);
        const kernel = strategy.definition.createKernel({ pair: pair.pair, parameters: candidate.normalizedParameters, indicatorBootstrapIdentity: bootstrap.entries });
        assertKernelMatchesDescription(kernel, strategy.definition, candidate, sha256CanonicalJson(description.indicatorRequirements), description.triggerTimeframeMinutes);
        const configuredTimeframes = configuredTimeframesFromRequirements(kernel.indicatorRequirements);
        const participantIdentity = buildStrategyBacktestParticipantIdentity({
          kernel,
          fixedResearchQuantity: pair.fixedResearchQuantity,
          gitCommitHash: plan.sourceIdentity.gitCommitHash,
        });
        let expectedRunId: string;
        try {
          expectedRunId = normalizeBacktestInputs({
            datasetManifest: resource.datasetManifest,
            bootstrapFromInclusiveMs: bootstrap.bootstrapFromInclusiveMs,
            evaluationFromInclusiveMs: researchWindow.analysisStartMs,
            evaluationToExclusiveMs: researchWindow.analysisEndExclusiveMs,
            replayToExclusiveMs: researchWindow.analysisEndExclusiveMs,
            configuredTimeframes,
            instrumentSpec: resource.instrumentSpec,
            costModel: costModel(backtestConfig),
            fundingSchedule: deriveBacktestFundingScheduleForWindow(resource.fundingSchedule, researchWindow.analysisStartMs, researchWindow.analysisEndExclusiveMs),
            participantIdentity,
            initialEquity: backtestConfig.initialEquity,
            intrabarAmbiguityPolicy: backtestConfig.intrabarAmbiguityPolicy,
            maxOpenOrders: backtestConfig.maxOpenOrders,
            engineSemanticVersion: backtestConfig.engineSemanticVersion,
            sourceIdentity: resource.datasetSource.sourceIdentity,
          }).runId;
        } catch (error) {
          const code = error instanceof BacktestError && error.code === 'FUNDING_SCHEDULE_INVALID' ? 'FUNDING_SCHEDULE_INVALID' : 'INVALID_BACKTEST_CONFIG';
          throw new StrategyCoinMatrixError(code, 'Phase 9 rejected normalized matrix cell inputs', { cause: error });
        }
        unsequenced.push(matrixDeepCopyFreeze({
          matrixPlanId,
          pair: pair.pair,
          strategyId: kernel.strategyId,
          strategyVersion: kernel.strategyVersion,
          normalizedParameters: kernel.normalizedParameters,
          parameterHash: kernel.parameterHash,
          strategyInstanceId: kernel.strategyInstanceId,
          datasetId: pair.datasetBinding.datasetId,
          datasetContentSha256: pair.datasetBinding.datasetContentSha256,
          timeRange: {
            bootstrapFromInclusiveMs: bootstrap.bootstrapFromInclusiveMs,
            evaluationFromInclusiveMs: researchWindow.analysisStartMs,
            evaluationToExclusiveMs: researchWindow.analysisEndExclusiveMs,
            replayToExclusiveMs: researchWindow.analysisEndExclusiveMs,
          },
          fixedResearchQuantity: pair.fixedResearchQuantity,
          expectedRunId,
        }));
      }
    }
  }
  unsequenced.sort(compareCells);
  return Object.freeze(unsequenced.map((cell, index) => matrixDeepCopyFreeze({
    ...cell,
    matrixCellId: sha256CanonicalJson(cellIdentity(cell)),
    cellSequence: index + 1,
  })));
}

/** @internal Execution-boundary check; intentionally absent from the public barrel. */
export function assertAuthoritativeFinalizedPlanIntegrity(
  finalized: FinalizedStrategyCoinMatrixPlan,
  dependencies: MatrixPlanningDependencies,
): void {
  const expectedCells = deriveAuthoritativeCells(finalized.plan, finalized.matrixPlanId, dependencies);
  if (finalized.cells.length !== expectedCells.length) {
    throw new StrategyCoinMatrixError(
      'MATRIX_PLAN_INTEGRITY_MISMATCH',
      'Supplied finalized cells do not have the authoritative Cartesian expansion count',
      { details: { actualCellCount: finalized.cells.length, expectedCellCount: expectedCells.length } },
    );
  }
  for (let index = 0; index < expectedCells.length; index++) {
    const actual = finalized.cells[index];
    const expected = expectedCells[index];
    if (actual === undefined || expected === undefined) {
      throw new StrategyCoinMatrixError('MATRIX_PLAN_INTEGRITY_MISMATCH', 'Supplied finalized cells do not cover the authoritative sequence');
    }
    let canonicalStructureMatches = false;
    try { canonicalStructureMatches = canonicalJson(actual) === canonicalJson(expected); }
    catch (error) {
      throw new StrategyCoinMatrixError(
        'MATRIX_PLAN_INTEGRITY_MISMATCH',
        'Supplied finalized cell is not canonically serializable',
        { cause: error, details: { cellIndex: index } },
      );
    }
    if (actual.cellSequence !== expected.cellSequence || actual.matrixCellId !== expected.matrixCellId || !canonicalStructureMatches) {
      throw new StrategyCoinMatrixError(
        'MATRIX_PLAN_INTEGRITY_MISMATCH',
        'Supplied finalized cell differs from the authoritative Cartesian expansion',
        {
          details: {
            actualMatrixCellId: actual.matrixCellId,
            cellIndex: index,
            expectedMatrixCellId: expected.matrixCellId,
          },
        },
      );
    }
  }
}

async function finalizeWithCommit(
  input: StrategyCoinMatrixPlanInput,
  dependencies: MatrixPlanningDependencies,
  gitCommitHash: string,
): Promise<FinalizedStrategyCoinMatrixPlan> {
  if (typeof input.planName !== 'string' || input.planName.length === 0 || input.planName.trim() !== input.planName) {
    throw new StrategyCoinMatrixError('INVALID_PARAMETER_SPACE', 'planName must be a non-empty exact string');
  }
  if (input.bootstrapPolicyId !== 'P11_INDICATOR_BOOTSTRAP_V1') {
    throw new StrategyCoinMatrixError('MATRIX_UNSUPPORTED_INDICATOR_BOOTSTRAP_POLICY', 'Unsupported matrix bootstrap policy');
  }
  const researchWindow = normalizeWindow(input.researchWindow);
  const pairs = normalizePairs(input.pairs);
  const preparedStrategies = prepareStrategies(input.strategies, dependencies.registry);
  const backtestConfig = normalizeBacktestConfig(input.backtestConfig);
  const plan: StrategyCoinMatrixPlan = matrixDeepCopyFreeze({
    schemaVersion: 1,
    planName: input.planName,
    bootstrapPolicyId: input.bootstrapPolicyId,
    researchWindow,
    pairs,
    strategies: preparedStrategies.map((prepared) => prepared.catalog),
    backtestConfig,
    sourceIdentity: { gitCommitHash },
  });
  const matrixPlanId = sha256CanonicalJson(plan);
  const cells = deriveAuthoritativeCells(plan, matrixPlanId, dependencies);
  const finalized = matrixDeepCopyFreeze({ plan, matrixPlanId, cells });
  assertFinalizedPlanIntegrity(finalized);
  return finalized;
}

export async function planWithGitSourceVerifier(
  input: StrategyCoinMatrixPlanInput,
  dependencies: MatrixPlanningDependencies,
  verifier: GitSourceVerifier,
): Promise<FinalizedStrategyCoinMatrixPlan> {
  const immutableInput = matrixDeepCopyFreeze(input);
  const gitCommitHash = await verifier.capture();
  return finalizeWithCommit(immutableInput, dependencies, gitCommitHash);
}

export async function planStrategyCoinMatrix(
  input: StrategyCoinMatrixPlanInput,
  dependencies: MatrixPlanningDependencies,
): Promise<FinalizedStrategyCoinMatrixPlan> {
  const verifier = new ProductionGitSourceVerifier(process.cwd());
  return planWithGitSourceVerifier(input, dependencies, verifier);
}
