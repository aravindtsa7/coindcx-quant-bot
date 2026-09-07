import { BacktestDecimal } from '../../backtest/decimal';
import { sha256CanonicalJson } from '../../backtest/canonical-json';
import { StrategyCoinMatrixError } from '../strategy-coin-matrix/errors';
import { ProductionGitSourceVerifier, type GitSourceVerifier } from '../strategy-coin-matrix/git-source';
import { planWithGitSourceVerifier } from '../strategy-coin-matrix/planner';
import type { MatrixPairCatalogEntry, MatrixPlanningDependencies, StrategyCoinMatrixPlanInput } from '../strategy-coin-matrix/types';
import { ResearchValidationError, type ValidationErrorCode } from './errors';
import { validationDeepCopyFreeze } from './immutable';
import { DAY_MS, type FinalizedResearchValidationPlan, type ResearchValidationPlanInput, type ResearchValidationSubject, type ValidationFoldDefinition } from './types';

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.:@/-]{1,256}$/;
function ascii(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function invalid(message: string, cause?: unknown): never { throw new ResearchValidationError('VALIDATION_PLAN_INVALID', message, cause === undefined ? undefined : { cause }); }

function translateSource(error: unknown): never {
  if (error instanceof StrategyCoinMatrixError) {
    const code: ValidationErrorCode = error.code === 'MATRIX_SOURCE_DIRTY' ? 'VALIDATION_SOURCE_DIRTY'
      : error.code === 'MATRIX_SOURCE_COMMIT_MISMATCH' ? 'VALIDATION_SOURCE_COMMIT_MISMATCH'
      : error.code === 'MATRIX_SOURCE_STATE_UNAVAILABLE' ? 'VALIDATION_SOURCE_UNAVAILABLE' : 'VALIDATION_PLAN_INVALID';
    throw new ResearchValidationError(code, 'Unable to finalize validation plan', { cause: error });
  }
  throw new ResearchValidationError('VALIDATION_SOURCE_UNAVAILABLE', 'Unable to capture authoritative Git source identity', { cause: error });
}

function day(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value % DAY_MS !== 0) invalid(`${label} must be a non-negative safe integer aligned to a UTC day`);
  return value;
}
function count(value: number, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) invalid(`${label} must be a safe integer >= ${minimum}`);
  return value;
}
function decimal(value: string, label: string, predicate?: (value: ReturnType<BacktestDecimal['toCalculationDecimal']>) => boolean): string {
  try {
    const normalized = new BacktestDecimal(value);
    if (predicate !== undefined && !predicate(normalized.toCalculationDecimal())) invalid(`${label} is outside its allowed range`);
    return normalized.value;
  } catch (error) { invalid(`${label} must be a canonical finite decimal`, error); }
}

function normalizePairs(pairs: readonly MatrixPairCatalogEntry[]): readonly MatrixPairCatalogEntry[] {
  if (!Array.isArray(pairs) || pairs.length === 0) invalid('pairBindings must be non-empty');
  const normalized = pairs.map((pair) => {
    if (pair.datasetBinding.pair !== pair.pair) invalid('datasetBinding.pair must equal pair');
    if (!SHA256.test(pair.datasetBinding.datasetId) || !SHA256.test(pair.datasetBinding.datasetContentSha256) || !SHA256.test(pair.instrumentSpecSnapshotId) ||
        !SHA256.test(pair.fundingScheduleBinding.contentSha256) || !ID.test(pair.fundingScheduleBinding.sourceId)) invalid('Pair binding resource identity is invalid');
    return pair;
  }).sort((left, right) => ascii(left.pair, right.pair));
  for (let index = 1; index < normalized.length; index++) if (normalized[index]?.pair === normalized[index - 1]?.pair) invalid('pairBindings contains a duplicate pair');
  return validationDeepCopyFreeze(normalized);
}

export function deriveWalkForwardFolds(input: Pick<ResearchValidationPlanInput, 'validationWindow' | 'walkForward' | 'holdout'>): { readonly folds: readonly ValidationFoldDefinition[]; readonly unusedTailMs: number } {
  const start = day(input.validationWindow.startMs, 'validationWindow.startMs');
  const end = day(input.validationWindow.endExclusiveMs, 'validationWindow.endExclusiveMs');
  const holdoutStart = day(input.holdout.holdoutStartMs, 'holdout.holdoutStartMs');
  const holdoutEnd = day(input.holdout.holdoutEndExclusiveMs, 'holdout.holdoutEndExclusiveMs');
  if (end <= start || holdoutEnd <= holdoutStart || holdoutStart < start || holdoutEnd > end) invalid('Validation and holdout windows are chronologically invalid');
  const { trainDays, testDays, stepDays, embargoDays } = input.walkForward;
  count(trainDays, 'walkForward.trainDays', 1); count(testDays, 'walkForward.testDays', 1); count(stepDays, 'walkForward.stepDays', 1); count(embargoDays, 'walkForward.embargoDays');
  if (stepDays !== testDays) invalid('P12_WALK_FORWARD_V1 requires stepDays === testDays');
  const spanDays = trainDays + embargoDays + testDays;
  if (!Number.isSafeInteger(spanDays)) invalid('Walk-forward duration exceeds safe integer arithmetic');
  const firstEnd = start + spanDays * DAY_MS;
  const stepMs = stepDays * DAY_MS;
  if (!Number.isSafeInteger(firstEnd) || !Number.isSafeInteger(stepMs)) invalid('Walk-forward timestamps exceed safe integer arithmetic');
  if (firstEnd > holdoutStart) invalid('Walk-forward window cannot accommodate at least one complete fold before holdout');
  const k = Math.floor((holdoutStart - firstEnd) / stepMs) + 1;
  const folds = Array.from({ length: k }, (_, foldIndex): ValidationFoldDefinition => {
    const isStartMs = start + foldIndex * stepMs;
    const isEndExclusiveMs = isStartMs + trainDays * DAY_MS;
    const oosStartMs = isEndExclusiveMs + embargoDays * DAY_MS;
    const oosEndExclusiveMs = oosStartMs + testDays * DAY_MS;
    if (![isStartMs, isEndExclusiveMs, oosStartMs, oosEndExclusiveMs].every(Number.isSafeInteger)) invalid('Derived fold timestamp exceeds safe integer arithmetic');
    const label = foldIndex.toString().padStart(2, '0');
    return { foldIndex, isValidationFoldId: `FOLD_${label}_IS`, oosValidationFoldId: `FOLD_${label}_OOS`, isStartMs, isEndExclusiveMs, oosStartMs, oosEndExclusiveMs };
  });
  const last = folds[folds.length - 1];
  if (last === undefined) invalid('Walk-forward plan contains zero folds');
  const unusedTailMs = holdoutStart - last.oosEndExclusiveMs;
  if (unusedTailMs < 0 || unusedTailMs >= stepMs) invalid('Walk-forward unused tail violates P12_WALK_FORWARD_V1');
  return validationDeepCopyFreeze({ folds, unusedTailMs });
}

function normalizePolicies(input: ResearchValidationPlanInput): Omit<ResearchValidationPlanInput, 'pairBindings' | 'strategies'> {
  if (typeof input.planName !== 'string' || input.planName.length === 0 || input.planName.trim() !== input.planName) invalid('planName must be a non-empty exact string');
  if (input.validationPolicyVersion !== 'P12_VALIDATION_POLICY_V1' || input.walkForward.policyId !== 'P12_WALK_FORWARD_V1' || input.metricPolicy.policyId !== 'P12_METRIC_POLICY_V1' ||
      input.costStress.policyId !== 'P12_COST_STRESS_V1' || input.monteCarlo.policyId !== 'P12_MONTE_CARLO_PERMUTATION_V1' || input.monteCarlo.seedDerivationPolicy !== 'HMAC_SHA256_V1' ||
      input.overfitting.policyId !== 'P12_DEFLATED_SHARPE_Z_V1' || input.overfitting.metric !== 'DEFLATED_SHARPE_Z') invalid('Unsupported Phase 12 policy identifier');
  if (input.metricPolicy.annualizationFactor !== 365) invalid('annualizationFactor must be 365');
  count(input.metricPolicy.minDailyObservations, 'metricPolicy.minDailyObservations', 1); count(input.metricPolicy.minClosedTrades, 'metricPolicy.minClosedTrades', 1);
  count(input.thresholds.minOosClosedTrades, 'thresholds.minOosClosedTrades'); count(input.thresholds.minDailyObservations, 'thresholds.minDailyObservations', 1);
  count(input.monteCarlo.simulationCount, 'monteCarlo.simulationCount', 1); count(input.monteCarlo.adversePercentile, 'monteCarlo.adversePercentile', 1);
  if (input.monteCarlo.adversePercentile > 99) invalid('monteCarlo.adversePercentile must be <= 99');
  if (!['UNSEEN_BY_OPERATOR', 'PREVIOUSLY_OBSERVED'].includes(input.holdout.exposureDeclaration)) invalid('Unsupported holdout exposure declaration');
  const scenarioIds = new Set<string>();
  const scenarios = input.costStress.scenarios.map((scenario) => {
    if (!ID.test(scenario.scenarioId) || scenarioIds.has(scenario.scenarioId)) invalid('Cost scenario IDs must be non-empty and unique');
    scenarioIds.add(scenario.scenarioId);
    return { scenarioId: scenario.scenarioId, costModel: normalizeCostModel(scenario.costModel) };
  }).sort((left, right) => ascii(left.scenarioId, right.scenarioId));
  if (input.thresholds.requireCostStressSurvival && scenarios.filter((scenario) => scenario.scenarioId === 'MODERATE_STRESS').length !== 1) invalid('Cost-stress survival requires exactly one MODERATE_STRESS scenario');
  const metricPolicy = { ...input.metricPolicy,
    annualRiskFreeRate: decimal(input.metricPolicy.annualRiskFreeRate, 'annualRiskFreeRate', (v) => v.greaterThan('-1')),
    annualSortinoTargetRate: decimal(input.metricPolicy.annualSortinoTargetRate, 'annualSortinoTargetRate', (v) => v.greaterThan('-1')),
    sharpeDegradationDenominatorFloor: decimal(input.metricPolicy.sharpeDegradationDenominatorFloor, 'sharpeDegradationDenominatorFloor', (v) => v.greaterThan(0)),
  };
  const thresholds = { ...input.thresholds,
    minOosSharpe: decimal(input.thresholds.minOosSharpe, 'minOosSharpe'), minOosSortino: decimal(input.thresholds.minOosSortino, 'minOosSortino'),
    maxOosDrawdownPercent: decimal(input.thresholds.maxOosDrawdownPercent, 'maxOosDrawdownPercent', (v) => v.greaterThanOrEqualTo(0)),
    minNetDailyProfitFactor: decimal(input.thresholds.minNetDailyProfitFactor, 'minNetDailyProfitFactor'), minNetDailyExpectancy: decimal(input.thresholds.minNetDailyExpectancy, 'minNetDailyExpectancy'),
    minOosFoldPassRatio: decimal(input.thresholds.minOosFoldPassRatio, 'minOosFoldPassRatio', (v) => v.greaterThanOrEqualTo(0) && v.lessThanOrEqualTo(1)),
    maxIsToOosSharpeDegradation: decimal(input.thresholds.maxIsToOosSharpeDegradation, 'maxIsToOosSharpeDegradation'),
    maxMonteCarloAdverseDrawdownPercent: decimal(input.thresholds.maxMonteCarloAdverseDrawdownPercent, 'maxMonteCarloAdverseDrawdownPercent', (v) => v.greaterThanOrEqualTo(0)),
    minDeflatedSharpeZ: decimal(input.thresholds.minDeflatedSharpeZ, 'minDeflatedSharpeZ'), minHoldoutSharpe: decimal(input.thresholds.minHoldoutSharpe, 'minHoldoutSharpe'),
  };
  const parameterNeighborhoods = input.parameterNeighborhoods?.map((mapping) => ({ targetParameterHash: mapping.targetParameterHash, adjacentNeighborParameterHashes: [...mapping.adjacentNeighborParameterHashes].sort(ascii) }))
    .sort((left, right) => ascii(left.targetParameterHash, right.targetParameterHash));
  return validationDeepCopyFreeze({ planName: input.planName, validationPolicyVersion: input.validationPolicyVersion, validationWindow: input.validationWindow,
    walkForward: input.walkForward, holdout: input.holdout, metricPolicy, thresholds, costStress: { ...input.costStress, scenarios }, monteCarlo: input.monteCarlo,
    overfitting: input.overfitting, backtestBaseConfig: { ...input.backtestBaseConfig, costModel: normalizeCostModel(input.backtestBaseConfig.costModel) },
    ...(parameterNeighborhoods === undefined ? {} : { parameterNeighborhoods }) });
}

function normalizeCostModel(model: ResearchValidationPlanInput['backtestBaseConfig']['costModel']): ResearchValidationPlanInput['backtestBaseConfig']['costModel'] {
  return validationDeepCopyFreeze({ makerFeeRate: decimal(model.makerFeeRate, 'makerFeeRate', (v) => v.greaterThanOrEqualTo(0)), takerFeeRate: decimal(model.takerFeeRate, 'takerFeeRate', (v) => v.greaterThanOrEqualTo(0)),
    halfSpreadBps: decimal(model.halfSpreadBps, 'halfSpreadBps', (v) => v.greaterThanOrEqualTo(0)), marketSlippageBps: decimal(model.marketSlippageBps, 'marketSlippageBps', (v) => v.greaterThanOrEqualTo(0)), stopSlippageBps: decimal(model.stopSlippageBps, 'stopSlippageBps', (v) => v.greaterThanOrEqualTo(0)) });
}

class CapturedVerifier implements GitSourceVerifier {
  public constructor(private readonly commit: string) {}
  public async capture(): Promise<string> { return this.commit; }
  public async assertExpected(expected: string): Promise<void> { if (expected !== this.commit) throw new StrategyCoinMatrixError('MATRIX_SOURCE_COMMIT_MISMATCH', 'Captured source differs'); }
}

export async function planResearchValidationWithGitSourceVerifier(input: ResearchValidationPlanInput, dependencies: MatrixPlanningDependencies, verifier: GitSourceVerifier): Promise<FinalizedResearchValidationPlan> {
  const copied = validationDeepCopyFreeze(input);
  const normalizedPolicies = normalizePolicies(copied);
  const pairBindings = normalizePairs(copied.pairBindings);
  const { folds, unusedTailMs } = deriveWalkForwardFolds(copied);
  let gitCommitHash: string;
  try { gitCommitHash = await verifier.capture(); } catch (error) { translateSource(error); }
  const first = folds[0];
  if (first === undefined) invalid('Validation plan has no folds');
  const matrixInput: StrategyCoinMatrixPlanInput = { planName: `${copied.planName}/NORMALIZE`, bootstrapPolicyId: 'P11_INDICATOR_BOOTSTRAP_V1',
    researchWindow: { analysisStartMs: first.isStartMs, analysisEndExclusiveMs: first.isEndExclusiveMs }, pairs: pairBindings, strategies: copied.strategies, backtestConfig: normalizedPolicies.backtestBaseConfig };
  let normalizedMatrix;
  try { normalizedMatrix = await planWithGitSourceVerifier(matrixInput, dependencies, new CapturedVerifier(gitCommitHash)); }
  catch (error) { if (error instanceof StrategyCoinMatrixError) invalid('Phase 11 rejected validation execution bindings', error); throw error; }
  const earliestBootstrap = Math.min(...normalizedMatrix.cells.map((cell) => cell.timeRange.bootstrapFromInclusiveMs));
  for (const resource of dependencies.pairResources) if (normalizedMatrix.plan.pairs.some((pair) => pair.pair === resource.pair) &&
      (resource.datasetManifest.fromInclusiveMs > earliestBootstrap || resource.datasetManifest.toExclusiveMs < copied.holdout.holdoutEndExclusiveMs)) invalid('Dataset does not cover the complete validation and holdout range');
  const normalizedStrategies = normalizedMatrix.plan.strategies;
  const plan = validationDeepCopyFreeze({ schemaVersion: 1 as const, ...normalizedPolicies, pairBindings: normalizedMatrix.plan.pairs, strategies: normalizedStrategies,
    sourceIdentity: { gitCommitHash }, pairUniverse: normalizedMatrix.plan.pairs.map((pair) => pair.pair) });
  const validationPlanId = sha256CanonicalJson(plan);
  const seen = new Set<string>();
  const subjects: ResearchValidationSubject[] = normalizedMatrix.cells.map((cell) => {
    const validationSubjectId = sha256CanonicalJson({ pair: cell.pair, strategyId: cell.strategyId, strategyVersion: cell.strategyVersion, parameterHash: cell.parameterHash });
    if (seen.has(validationSubjectId)) invalid('Derived validation subjects are not unique'); seen.add(validationSubjectId);
    return { validationSubjectId, pair: cell.pair, strategyId: cell.strategyId, strategyVersion: cell.strategyVersion, parameterHash: cell.parameterHash, normalizedParameters: cell.normalizedParameters };
  }).sort((left, right) => ascii(left.validationSubjectId, right.validationSubjectId));
  const knownHashes = new Set(subjects.map((subject) => subject.parameterHash));
  const targetHashes = new Set<string>();
  for (const mapping of plan.parameterNeighborhoods ?? []) {
    if (!SHA256.test(mapping.targetParameterHash) || !knownHashes.has(mapping.targetParameterHash) || targetHashes.has(mapping.targetParameterHash)) invalid('Parameter neighborhood target is invalid or duplicate');
    targetHashes.add(mapping.targetParameterHash); const neighbors = new Set<string>();
    if (mapping.adjacentNeighborParameterHashes.length === 0) invalid('Parameter neighborhood must contain at least one adjacent candidate');
    for (const hash of mapping.adjacentNeighborParameterHashes) {
      if (!SHA256.test(hash) || !knownHashes.has(hash) || hash === mapping.targetParameterHash || neighbors.has(hash)) invalid('Parameter neighborhood reference is invalid, duplicate, or self-referential');
      neighbors.add(hash);
    }
  }
  return validationDeepCopyFreeze({ plan, validationPlanId, subjects, folds, unusedTailMs });
}

export async function planResearchValidation(input: ResearchValidationPlanInput, dependencies: MatrixPlanningDependencies): Promise<FinalizedResearchValidationPlan> {
  return planResearchValidationWithGitSourceVerifier(input, dependencies, new ProductionGitSourceVerifier(process.cwd()));
}
