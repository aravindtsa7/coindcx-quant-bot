import { canonicalJson, sha256CanonicalJson } from '../../backtest/canonical-json';
import { registerGenuineResearchValidationResult } from './approval-authority';
import { StrategyCoinMatrixError } from '../strategy-coin-matrix/errors';
import { ProductionGitSourceVerifier, type GitSourceVerifier } from '../strategy-coin-matrix/git-source';
import { executeWithGitSourceVerifier } from '../strategy-coin-matrix/executor';
import { assertPairResourceIdentity, planWithGitSourceVerifier } from '../strategy-coin-matrix/planner';
import type { FinalizedStrategyCoinMatrixPlan, MatrixBacktestExecutionConfig, StrategyCoinMatrixCell, StrategyCoinMatrixPlanInput } from '../strategy-coin-matrix/types';
import { calculateDeflatedSharpeZ } from './deflated-sharpe';
import { ValidationEvidenceCollector } from './evidence-collector';
import { ResearchValidationError } from './errors';
import { degradation, evaluateFoldLocalGates, foldVerdict, metricGate, subjectVerdict } from './gates';
import { freezeValidationRuntime, validationDeepCopyFreeze } from './immutable';
import { calculateMetricsFromEvidence } from './metrics';
import { runMonteCarlo } from './monte-carlo';
import { calc, canonical } from './numeric';
import type { CanonicalValidationEvidence, FinalizedResearchValidationPlan, ResearchValidationPlanResult, StrategyValidationRecord, ValidationCostStressEvaluation, ValidationExecutionDependencies, ValidationExecutionOptions, ValidationFoldResult, ValidationGateEvaluation, ValidationHoldoutEvaluation, ValidationMetric, ValidationMetrics } from './types';
import { normalizeValidationPolicies, planResearchValidation, planResearchValidationWithGitSourceVerifier } from './planner';
import type { ResearchValidationPlanInput } from './types';

function ascii(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function unavailable(reason: string): ValidationMetric { return freezeValidationRuntime({ status: 'INSUFFICIENT_DATA', reason, count: 0, required: 1, value: null }); }
function unavailableSeries(reason: string): ValidationMetric<readonly string[]> { return freezeValidationRuntime({ status: 'INSUFFICIENT_DATA', reason, count: 0, required: 1, value: null }); }

function subjectId(cell: StrategyCoinMatrixCell): string { return sha256CanonicalJson({ pair: cell.pair, strategyId: cell.strategyId, strategyVersion: cell.strategyVersion, parameterHash: cell.parameterHash }); }
function sourceCode(error: unknown): boolean { return error instanceof StrategyCoinMatrixError && ['MATRIX_SOURCE_DIRTY', 'MATRIX_SOURCE_COMMIT_MISMATCH', 'MATRIX_SOURCE_STATE_UNAVAILABLE'].includes(error.code); }
class FixedCaptureVerifier implements GitSourceVerifier {
  public constructor(private readonly commit: string) {}
  public async capture(): Promise<string> { return this.commit; }
  public async assertExpected(expected: string): Promise<void> { if (expected !== this.commit) throw new StrategyCoinMatrixError('MATRIX_SOURCE_COMMIT_MISMATCH', 'Matrix commit differs from validation commit'); }
}

interface ExecutionBundle { readonly matrix: FinalizedStrategyCoinMatrixPlan; readonly evidence: ReadonlyMap<string, CanonicalValidationEvidence | null>; readonly sourceInvalid: boolean; readonly sourceFailure?: string }
function validationSourceCode(error: unknown): string { return error instanceof StrategyCoinMatrixError && error.code === 'MATRIX_SOURCE_DIRTY' ? 'VALIDATION_SOURCE_DIRTY' : error instanceof StrategyCoinMatrixError && error.code === 'MATRIX_SOURCE_COMMIT_MISMATCH' ? 'VALIDATION_SOURCE_COMMIT_MISMATCH' : 'VALIDATION_SOURCE_UNAVAILABLE'; }
// Phase 11 can absorb a final verifier failure into its matrix status while all
// cells remain completed. Retain the first failure across every validation window.
class LatchingGitSourceVerifier implements GitSourceVerifier {
  #failure: StrategyCoinMatrixError | null = null;
  public constructor(private readonly delegate: GitSourceVerifier) {}
  public get sourceFailure(): string | null { return this.#failure === null ? null : validationSourceCode(this.#failure); }
  async #verify<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#failure !== null) throw this.#failure;
    try { return await operation(); }
    catch (error) {
      this.#failure ??= error instanceof StrategyCoinMatrixError && sourceCode(error)
        ? error : new StrategyCoinMatrixError('MATRIX_SOURCE_STATE_UNAVAILABLE', 'Validation source verification failed', { cause: error });
      throw this.#failure;
    }
  }
  public capture(): Promise<string> { return this.#verify(() => this.delegate.capture()); }
  public assertExpected(expected: string): Promise<void> { return this.#verify(() => this.delegate.assertExpected(expected)); }
}

async function executeWindow(finalized: FinalizedResearchValidationPlan, dependencies: ValidationExecutionDependencies, verifier: LatchingGitSourceVerifier, options: ValidationExecutionOptions,
  validationFoldId: string, scenarioId: string, startMs: number, endExclusiveMs: number, backtestConfig: MatrixBacktestExecutionConfig): Promise<ExecutionBundle> {
  const expected = finalized.plan.sourceIdentity.gitCommitHash;
  try { await verifier.assertExpected(expected); } catch (error) { if (sourceCode(error)) return { matrix: null as never, evidence: new Map(), sourceInvalid: true, sourceFailure: validationSourceCode(error) }; throw error; }
  const input: StrategyCoinMatrixPlanInput = { planName: `${finalized.plan.planName}/${validationFoldId}/${scenarioId}`, bootstrapPolicyId: 'P11_INDICATOR_BOOTSTRAP_V1',
    researchWindow: { analysisStartMs: startMs, analysisEndExclusiveMs: endExclusiveMs }, pairs: finalized.plan.pairBindings, strategies: finalized.plan.strategies, backtestConfig };
  const matrix = await planWithGitSourceVerifier(input, dependencies, new FixedCaptureVerifier(expected));
  const collectors = new Map<string, ValidationEvidenceCollector>();
  const result = await executeWithGitSourceVerifier(matrix, { registry: dependencies.registry, pairResources: dependencies.pairResources }, {
    ...(options.workerCount === undefined ? {} : { workerCount: options.workerCount }), ...(options.verificationPageMinutes === undefined ? {} : { verificationPageMinutes: options.verificationPageMinutes }),
    eventSinkFactory: (cell) => { const id = subjectId(cell); const subject = finalized.subjects.find((item) => item.validationSubjectId === id); if (subject === undefined || collectors.has(cell.matrixCellId)) throw new ResearchValidationError('EVIDENCE_INTEGRITY_FAILURE', 'Collector lineage is duplicate or unknown');
      const collector = new ValidationEvidenceCollector({ validationPlanId: finalized.validationPlanId, validationSubjectId: id, validationFoldId, scenarioId, matrixPlanId: matrix.matrixPlanId, matrixCellId: cell.matrixCellId, expectedRunId: cell.expectedRunId, analysisStartMs: startMs, analysisEndExclusiveMs: endExclusiveMs, pair: cell.pair, datasetId: cell.datasetId, bootstrapFromInclusiveMs: cell.timeRange.bootstrapFromInclusiveMs }); collectors.set(cell.matrixCellId, collector); return collector; },
  }, verifier);
  if (verifier.sourceFailure !== null) return { matrix, evidence: new Map(), sourceInvalid: true, sourceFailure: verifier.sourceFailure };
  if (result.status === 'FAILED' && result.completedCells > 0) {
    throw new ResearchValidationError('EVIDENCE_INTEGRITY_FAILURE', 'Failed matrix with completed cells has no latched source failure');
  }
  const evidence = new Map<string, CanonicalValidationEvidence | null>();
  for (const cellResult of result.cellResults) {
    const id = subjectId(matrix.cells[cellResult.cellSequence - 1] as StrategyCoinMatrixCell);
    if (evidence.has(id)) throw new ResearchValidationError('CONCURRENCY_INTEGRITY_VIOLATION', 'Matrix returned duplicate subject evidence');
    if (cellResult.status === 'COMPLETED') {
      const collector = collectors.get(cellResult.matrixCellId); if (collector === undefined) throw new ResearchValidationError('EVIDENCE_INTEGRITY_FAILURE', 'Completed Phase 11 cell has no event collector');
      evidence.set(id, collector.finalize(cellResult.outcome));
    } else evidence.set(id, null);
  }
  if (evidence.size !== finalized.subjects.length) throw new ResearchValidationError('CONCURRENCY_INTEGRITY_VIOLATION', 'Matrix result does not cover every validation subject');
  return { matrix, evidence, sourceInvalid: false };
}

function aggregateGateSet(metrics: ValidationMetrics, evidence: readonly CanonicalValidationEvidence[], thresholds: FinalizedResearchValidationPlan['plan']['thresholds']): ValidationGateEvaluation[] {
  return [...evaluateFoldLocalGates(metrics, evidence.reduce((sum, item) => sum + item.totalClosedTrades, 0), evidence.reduce((sum, item) => sum + item.dailyEquities.length - 1, 0), thresholds)];
}
function foldResult(id: string, kind: 'IS' | 'OOS', evidence: CanonicalValidationEvidence | null, finalized: FinalizedResearchValidationPlan): ValidationFoldResult {
  if (evidence === null) return freezeValidationRuntime({ validationFoldId: id, kind, evidence: null, metrics: null, verdict: 'INSUFFICIENT_EVIDENCE', failureCode: 'BACKTEST_EXECUTION_FAILED' });
  const metrics = calculateMetricsFromEvidence([evidence], finalized.plan.metricPolicy); const gates = evaluateFoldLocalGates(metrics, evidence.totalClosedTrades, evidence.dailyEquities.length - 1, finalized.plan.thresholds);
  return freezeValidationRuntime({ validationFoldId: id, kind, evidence, metrics, ...(kind === 'OOS' ? { verdict: foldVerdict(gates) } : {}) });
}
function resultHash(record: Omit<StrategyValidationRecord, 'validationSubjectResultSha256'>): StrategyValidationRecord { return freezeValidationRuntime({ ...record, validationSubjectResultSha256: sha256CanonicalJson(record) }); }

function failedResult(finalized: FinalizedResearchValidationPlan, abortedCode: string): ResearchValidationPlanResult {
  const abortedSubjects = finalized.subjects.map((subject) => ({ validationSubjectId: subject.validationSubjectId, code: abortedCode }));
  const payload = { validationPlanId: finalized.validationPlanId, planName: finalized.plan.planName, status: 'FAILED' as const, totalSubjects: finalized.subjects.length, passedSubjects: 0, failedSubjects: 0,
    insufficientEvidenceSubjects: 0, totalFolds: finalized.folds.length, unusedTailMs: finalized.unusedTailMs, freshnessBasis: 'OPERATOR_ATTESTATION_V1' as const, subjectResults: Object.freeze([]), abortedSubjects: Object.freeze(abortedSubjects) };
  const hashPayload = { validationPlanId: payload.validationPlanId, planName: payload.planName, status: payload.status, totalSubjects: payload.totalSubjects,
    passedSubjects: payload.passedSubjects, failedSubjects: payload.failedSubjects, insufficientEvidenceSubjects: payload.insufficientEvidenceSubjects,
    totalFolds: payload.totalFolds, unusedTailMs: payload.unusedTailMs, freshnessBasis: payload.freshnessBasis, subjectDigests: Object.freeze([]), abortedSubjects: payload.abortedSubjects };
  const result = freezeValidationRuntime({ ...payload, validationResultSha256: sha256CanonicalJson(hashPayload) });
  registerGenuineResearchValidationResult(result);
  return result;
}

export async function executeResearchValidationWithGitSourceVerifier(finalizedInput: FinalizedResearchValidationPlan, dependencies: ValidationExecutionDependencies, options: ValidationExecutionOptions, sourceVerifier: GitSourceVerifier): Promise<ResearchValidationPlanResult> {
  const verifier = new LatchingGitSourceVerifier(sourceVerifier);
  const finalized = validationDeepCopyFreeze(finalizedInput); const expected = finalized.plan.sourceIdentity.gitCommitHash;
  normalizeValidationPolicies(finalized.plan);
  if (sha256CanonicalJson(finalized.plan) !== finalized.validationPlanId) throw new ResearchValidationError('VALIDATION_PLAN_INVALID', 'Finalized validation plan identity is invalid');
  const runtimePairs = new Set<string>(); for (const resource of dependencies.pairResources) { if (runtimePairs.has(resource.pair) || !finalized.plan.pairUniverse.includes(resource.pair)) throw new ResearchValidationError('RESOURCE_IDENTITY_MISMATCH', 'Runtime pair resources are duplicate or foreign'); runtimePairs.add(resource.pair); }
  if (runtimePairs.size !== finalized.plan.pairBindings.length) throw new ResearchValidationError('RESOURCE_IDENTITY_MISMATCH', 'Runtime pair resources do not exactly cover pairBindings');
  try { for (const binding of finalized.plan.pairBindings) { const resource = dependencies.pairResources.find((item) => item.pair === binding.pair); if (resource === undefined) throw new ResearchValidationError('RESOURCE_IDENTITY_MISMATCH', 'Runtime pair is missing'); assertPairResourceIdentity(binding, resource); } }
  catch (error) { if (error instanceof ResearchValidationError) throw error; throw new ResearchValidationError('RESOURCE_IDENTITY_MISMATCH', 'Runtime pair identity differs from the validation plan', { cause: error }); }
  // A matching hash authenticates bytes, not their meaning. Reuse the actual
  // planner with the stored commit, without recapturing source or consuming latch checks.
  const authoritative = await planResearchValidationWithGitSourceVerifier(finalized.plan, dependencies, new FixedCaptureVerifier(expected));
  if (canonicalJson(authoritative) !== canonicalJson(finalized)) throw new ResearchValidationError('VALIDATION_PLAN_INVALID', 'Finalized validation plan is not the canonical semantically valid plan');
  try { await verifier.assertExpected(expected); } catch (error) { return failedResult(finalized, validationSourceCode(error)); }
  const foldResults = new Map<string, ValidationFoldResult[]>(); const stressEvidence = new Map<string, Map<string, CanonicalValidationEvidence[]>>(); const holdoutEvidence = new Map<string, CanonicalValidationEvidence | null>();
  const aborted = new Map<string, string>();
  for (const subject of finalized.subjects) { foldResults.set(subject.validationSubjectId, []); stressEvidence.set(subject.validationSubjectId, new Map()); }
  try {
    for (const fold of finalized.folds) {
      for (const window of [{ id: fold.isValidationFoldId, kind: 'IS' as const, start: fold.isStartMs, end: fold.isEndExclusiveMs }, { id: fold.oosValidationFoldId, kind: 'OOS' as const, start: fold.oosStartMs, end: fold.oosEndExclusiveMs }]) {
        const bundle = await executeWindow(finalized, dependencies, verifier, options, window.id, 'BASELINE', window.start, window.end, finalized.plan.backtestBaseConfig); if (bundle.sourceInvalid) return failedResult(finalized, bundle.sourceFailure ?? 'VALIDATION_SOURCE_UNAVAILABLE');
        for (const subject of finalized.subjects) { const item = bundle.evidence.get(subject.validationSubjectId) ?? null; if (item === null) aborted.set(subject.validationSubjectId, 'BACKTEST_EXECUTION_FAILED'); foldResults.get(subject.validationSubjectId)?.push(foldResult(window.id, window.kind, item, finalized)); }
      }
      for (const scenario of finalized.plan.costStress.scenarios) {
        const config = freezeValidationRuntime({ ...finalized.plan.backtestBaseConfig, costModel: scenario.costModel });
        const bundle = await executeWindow(finalized, dependencies, verifier, options, fold.oosValidationFoldId, scenario.scenarioId, fold.oosStartMs, fold.oosEndExclusiveMs, config); if (bundle.sourceInvalid) return failedResult(finalized, bundle.sourceFailure ?? 'VALIDATION_SOURCE_UNAVAILABLE');
        for (const subject of finalized.subjects) { const item = bundle.evidence.get(subject.validationSubjectId); if (item !== null && item !== undefined) { const byScenario = stressEvidence.get(subject.validationSubjectId); const list = byScenario?.get(scenario.scenarioId) ?? []; list.push(item); byScenario?.set(scenario.scenarioId, list); } else aborted.set(subject.validationSubjectId, 'BACKTEST_EXECUTION_FAILED'); }
      }
    }
    const holdout = await executeWindow(finalized, dependencies, verifier, options, 'HOLDOUT', 'BASELINE', finalized.plan.holdout.holdoutStartMs, finalized.plan.holdout.holdoutEndExclusiveMs, finalized.plan.backtestBaseConfig); if (holdout.sourceInvalid) return failedResult(finalized, holdout.sourceFailure ?? 'VALIDATION_SOURCE_UNAVAILABLE');
    for (const subject of finalized.subjects) { const item = holdout.evidence.get(subject.validationSubjectId) ?? null; holdoutEvidence.set(subject.validationSubjectId, item); if (item === null) aborted.set(subject.validationSubjectId, 'BACKTEST_EXECUTION_FAILED'); }
    try { await verifier.assertExpected(expected); } catch (error) { return failedResult(finalized, validationSourceCode(error)); }
  } catch (error) {
    if (error instanceof ResearchValidationError && ['EVIDENCE_INTEGRITY_FAILURE', 'CONCURRENCY_INTEGRITY_VIOLATION'].includes(error.code)) return failedResult(finalized, error.code);
    if (sourceCode(error)) return failedResult(finalized, validationSourceCode(error));
    throw error;
  }

  const oosReturns = new Map<string, ValidationMetric<readonly string[]>>();
  for (const subject of finalized.subjects) {
    const evidence = (foldResults.get(subject.validationSubjectId) ?? []).filter((item) => item.kind === 'OOS').flatMap((item) => item.evidence === null ? [] : [item.evidence]);
    const invalid = evidence.map((item) => item.dailyReturns).find((item) => item.status !== 'VALUE');
    oosReturns.set(subject.validationSubjectId, invalid ?? freezeValidationRuntime({ status: 'VALUE', value: Object.freeze(evidence.flatMap((item) => item.dailyReturns.status === 'VALUE' ? item.dailyReturns.value : [])) }));
  }
  const aggregateMetrics = new Map<string, ValidationMetrics>();
  for (const subject of finalized.subjects) { const evidence = (foldResults.get(subject.validationSubjectId) ?? []).filter((item) => item.kind === 'OOS').flatMap((item) => item.evidence === null ? [] : [item.evidence]); aggregateMetrics.set(subject.validationSubjectId, calculateMetricsFromEvidence(evidence, finalized.plan.metricPolicy)); }
  const subjectResults: StrategyValidationRecord[] = [];
  for (const subject of finalized.subjects) {
    if (aborted.has(subject.validationSubjectId)) continue;
    const folds = foldResults.get(subject.validationSubjectId) ?? []; const oos = folds.filter((item) => item.kind === 'OOS'); const oosEvidence = oos.flatMap((item) => item.evidence === null ? [] : [item.evidence]);
    const aggregateOosMetrics = aggregateMetrics.get(subject.validationSubjectId);
    if (aggregateOosMetrics === undefined) throw new ResearchValidationError('CONCURRENCY_INTEGRITY_VIOLATION', 'Aggregate metrics are missing for a subject');
    const gates = aggregateGateSet(aggregateOosMetrics, oosEvidence, finalized.plan.thresholds);
    const passing = oos.filter((item) => item.verdict === 'PASS').length; const foldRatio = canonical(calc(passing.toString()).div(finalized.folds.length)); gates.push(metricGate('GATE-08', 'MIN_OOS_FOLD_PASS_RATIO', { status: 'VALUE', value: foldRatio }, finalized.plan.thresholds.minOosFoldPassRatio, 'MIN'));
    const degradations: ValidationMetric[] = finalized.folds.map((definition) => { const is = folds.find((item) => item.validationFoldId === definition.isValidationFoldId)?.metrics?.sharpe ?? unavailable('IS_SHARPE_UNAVAILABLE'); const out = folds.find((item) => item.validationFoldId === definition.oosValidationFoldId)?.metrics?.sharpe ?? unavailable('OOS_SHARPE_UNAVAILABLE'); return degradation(is, out, finalized.plan.metricPolicy.sharpeDegradationDenominatorFloor); });
    const validDegradation = degradations.filter((item): item is { readonly status: 'VALUE'; readonly value: string } => item.status === 'VALUE'); const maxDegradation: ValidationMetric = validDegradation.length !== degradations.length ? unavailable('FOLD_SHARPE_UNAVAILABLE') : { status: 'VALUE', value: validDegradation.map((item) => item.value).sort((a, b) => calc(b).comparedTo(calc(a)))[0] ?? '0' };
    gates.push(metricGate('GATE-09', 'MAX_IS_TO_OOS_DEGRADATION', maxDegradation, finalized.plan.thresholds.maxIsToOosSharpeDegradation, 'MAX'));
    const costs: ValidationCostStressEvaluation[] = finalized.plan.costStress.scenarios.map((scenario) => { const evidence = stressEvidence.get(subject.validationSubjectId)?.get(scenario.scenarioId) ?? []; return freezeValidationRuntime({ scenarioId: scenario.scenarioId, evidence: Object.freeze(evidence), totalNetReturn: calculateMetricsFromEvidence(evidence, finalized.plan.metricPolicy).totalNetReturn }); });
    if (!finalized.plan.thresholds.requireCostStressSurvival) gates.push({ gateId: 'GATE-10', gateName: 'COST_STRESS_SURVIVAL', status: 'DISABLED', observedValue: null, thresholdValue: false });
    else { const moderate = costs.find((entry) => entry.scenarioId === 'MODERATE_STRESS'); const metric = moderate?.totalNetReturn ?? unavailable('MODERATE_STRESS_UNAVAILABLE'); gates.push(metric.status !== 'VALUE' ? { gateId: 'GATE-10', gateName: 'COST_STRESS_SURVIVAL', status: 'UNAVAILABLE', observedValue: null, thresholdValue: true, reason: metric.reason } : { gateId: 'GATE-10', gateName: 'COST_STRESS_SURVIVAL', status: calc(metric.value).greaterThan(0) ? 'PASS' : 'FAIL', observedValue: metric.value, thresholdValue: true }); }
    const subjectOosReturns = oosReturns.get(subject.validationSubjectId) ?? unavailableSeries('OOS_RETURNS_UNAVAILABLE');
    const monteCarloResult = subjectOosReturns.status === 'VALUE'
      ? runMonteCarlo(finalized.validationPlanId, subject.validationSubjectId, subjectOosReturns.value, finalized.plan.monteCarlo)
      : freezeValidationRuntime({ status: subjectOosReturns.status, adversePercentile: finalized.plan.monteCarlo.adversePercentile, simulationCount: finalized.plan.monteCarlo.simulationCount, seedHex: '', adverseDrawdownPercent: null, reason: subjectOosReturns.reason });
    gates.push(monteCarloResult.status !== 'VALUE' ? { gateId: 'GATE-11', gateName: 'MONTE_CARLO_ADVERSE_DRAWDOWN', status: 'UNAVAILABLE', observedValue: null, thresholdValue: finalized.plan.thresholds.maxMonteCarloAdverseDrawdownPercent, ...(monteCarloResult.reason === undefined ? {} : { reason: monteCarloResult.reason }) } : metricGate('GATE-11', 'MONTE_CARLO_ADVERSE_DRAWDOWN', { status: 'VALUE', value: canonical(calc(monteCarloResult.adverseDrawdownPercent)) }, finalized.plan.thresholds.maxMonteCarloAdverseDrawdownPercent, 'MAX'));
    const family = finalized.subjects.filter((item) => item.pair === subject.pair && item.strategyId === subject.strategyId && item.strategyVersion === subject.strategyVersion).map((item) => oosReturns.get(item.validationSubjectId) ?? unavailableSeries('OOS_RETURNS_UNAVAILABLE'));
    const dsr = subjectOosReturns.status !== 'VALUE' ? subjectOosReturns : family.some((item) => item.status !== 'VALUE') ? unavailable('DSR_FAMILY_RETURNS_UNAVAILABLE')
      : calculateDeflatedSharpeZ(subjectOosReturns.value, family.map((item) => item.status === 'VALUE' ? item.value : []), finalized.plan.metricPolicy.annualRiskFreeRate, finalized.plan.metricPolicy.minDailyObservations);
    gates.push(metricGate('GATE-12', 'DEFLATED_SHARPE_Z', dsr, finalized.plan.thresholds.minDeflatedSharpeZ, 'MIN'));
    const holdEvidence = holdoutEvidence.get(subject.validationSubjectId) ?? null; const holdMetrics = holdEvidence === null ? null : calculateMetricsFromEvidence([holdEvidence], finalized.plan.metricPolicy);
    const positiveReturnGate: ValidationGateEvaluation = !finalized.plan.thresholds.requireHoldoutPositiveReturn ? { gateId: 'GATE-13B', gateName: 'HOLDOUT_POSITIVE_RETURN', status: 'DISABLED', observedValue: null, thresholdValue: false } : holdMetrics?.totalNetReturn.status === 'VALUE' ? { gateId: 'GATE-13B', gateName: 'HOLDOUT_POSITIVE_RETURN', status: calc(holdMetrics.totalNetReturn.value).greaterThan(0) ? 'PASS' : 'FAIL', observedValue: holdMetrics.totalNetReturn.value, thresholdValue: '0' } : { gateId: 'GATE-13B', gateName: 'HOLDOUT_POSITIVE_RETURN', status: 'UNAVAILABLE', observedValue: null, thresholdValue: '0' };
    const freshnessGate: ValidationGateEvaluation = !finalized.plan.thresholds.requireFreshHoldout ? { gateId: 'GATE-13C', gateName: 'HOLDOUT_FRESHNESS', status: 'DISABLED', observedValue: finalized.plan.holdout.exposureDeclaration, thresholdValue: false } : { gateId: 'GATE-13C', gateName: 'HOLDOUT_FRESHNESS', status: finalized.plan.holdout.exposureDeclaration === 'UNSEEN_BY_OPERATOR' ? 'PASS' : 'UNAVAILABLE', observedValue: finalized.plan.holdout.exposureDeclaration, thresholdValue: true };
    const sharpeGate = metricGate('GATE-13A', 'HOLDOUT_SHARPE', holdMetrics?.sharpe ?? unavailable('HOLDOUT_UNAVAILABLE'), finalized.plan.thresholds.minHoldoutSharpe, 'MIN'); const subgates = [sharpeGate, positiveReturnGate, freshnessGate];
    const holdGate: ValidationGateEvaluation = { gateId: 'GATE-13', gateName: 'FINAL_HOLDOUT_GATE', status: subgates.some((gate) => gate.status === 'FAIL') ? 'FAIL' : subgates.some((gate) => gate.status === 'UNAVAILABLE') ? 'UNAVAILABLE' : 'PASS', observedValue: holdMetrics?.sharpe.status === 'VALUE' ? holdMetrics.sharpe.value : null, thresholdValue: finalized.plan.thresholds.minHoldoutSharpe }; gates.push(holdGate);
    const holdoutEvaluation: ValidationHoldoutEvaluation = freezeValidationRuntime({ evidence: holdEvidence, metrics: holdMetrics, exposureDeclaration: finalized.plan.holdout.exposureDeclaration, positiveReturnGate, freshnessGate });
    const mapping = finalized.plan.parameterNeighborhoods?.find((item) => item.targetParameterHash === subject.parameterHash); let parameterNeighborhoodSensitivity: ValidationMetric | undefined;
    if (mapping !== undefined) { const target = aggregateOosMetrics.sharpe; const neighbors = finalized.subjects.filter((item) => item.pair === subject.pair && item.strategyId === subject.strategyId && item.strategyVersion === subject.strategyVersion && mapping.adjacentNeighborParameterHashes.includes(item.parameterHash)).map((item) => aggregateMetrics.get(item.validationSubjectId)?.sharpe ?? unavailable('NEIGHBOR_SHARPE_UNAVAILABLE'));
      parameterNeighborhoodSensitivity = target.status !== 'VALUE' || neighbors.some((item) => item.status !== 'VALUE') ? unavailable('PARAMETER_NEIGHBORHOOD_UNAVAILABLE') : calc(target.value).isZero() ? { status: 'UNDEFINED', reason: 'ZERO_DENOMINATOR', value: null } : { status: 'VALUE', value: canonical(neighbors.reduce((sum, item) => sum.plus(calc(item.status === 'VALUE' ? item.value : '0')), calc('0')).div(neighbors.length).div(calc(target.value))) }; }
    const base = { validationSubjectId: subject.validationSubjectId, pair: subject.pair, strategyId: subject.strategyId, strategyVersion: subject.strategyVersion, parameterHash: subject.parameterHash, verdict: subjectVerdict(gates), foldResults: Object.freeze(folds), aggregateOosMetrics, gateEvaluations: Object.freeze(gates), costStressEvaluations: Object.freeze(costs), monteCarloResult, holdoutEvaluation, ...(parameterNeighborhoodSensitivity === undefined ? {} : { parameterNeighborhoodSensitivity }) };
    subjectResults.push(resultHash(base));
  }
  subjectResults.sort((left, right) => ascii(left.validationSubjectId, right.validationSubjectId)); const passedSubjects = subjectResults.filter((item) => item.verdict === 'PASSED').length; const failedSubjects = subjectResults.filter((item) => item.verdict === 'FAILED').length; const insufficientEvidenceSubjects = subjectResults.length - passedSubjects - failedSubjects;
  const abortedSubjects = [...aborted].map(([validationSubjectId, code]) => ({ validationSubjectId, code })).sort((left, right) => ascii(left.validationSubjectId, right.validationSubjectId));
  const status = subjectResults.length === 0 ? 'FAILED' as const : abortedSubjects.length === 0 ? 'COMPLETED' as const : 'PARTIAL' as const;
  const payload = { validationPlanId: finalized.validationPlanId, planName: finalized.plan.planName, status, totalSubjects: finalized.subjects.length, passedSubjects, failedSubjects, insufficientEvidenceSubjects, totalFolds: finalized.folds.length, unusedTailMs: finalized.unusedTailMs, freshnessBasis: 'OPERATOR_ATTESTATION_V1' as const, subjectResults: Object.freeze(subjectResults), abortedSubjects: Object.freeze(abortedSubjects) };
  const hashPayload = { validationPlanId: payload.validationPlanId, planName: payload.planName, status: payload.status, totalSubjects: payload.totalSubjects,
    passedSubjects: payload.passedSubjects, failedSubjects: payload.failedSubjects, insufficientEvidenceSubjects: payload.insufficientEvidenceSubjects,
    totalFolds: payload.totalFolds, unusedTailMs: payload.unusedTailMs, freshnessBasis: payload.freshnessBasis,
    subjectDigests: subjectResults.map((item) => ({ validationSubjectId: item.validationSubjectId, verdict: item.verdict, validationSubjectResultSha256: item.validationSubjectResultSha256 })), abortedSubjects: payload.abortedSubjects };
  const result = freezeValidationRuntime({ ...payload, validationResultSha256: sha256CanonicalJson(hashPayload) });
  registerGenuineResearchValidationResult(result);
  return result;
}

export async function executeResearchValidation(finalized: FinalizedResearchValidationPlan, dependencies: ValidationExecutionDependencies, options: ValidationExecutionOptions = {}): Promise<ResearchValidationPlanResult> { return executeResearchValidationWithGitSourceVerifier(finalized, dependencies, options, new ProductionGitSourceVerifier(process.cwd())); }
export async function runResearchValidation(input: ResearchValidationPlanInput, dependencies: ValidationExecutionDependencies, options: ValidationExecutionOptions = {}): Promise<ResearchValidationPlanResult> { const finalized = await planResearchValidation(input, dependencies); return executeResearchValidation(finalized, dependencies, options); }
export async function runResearchValidationWithGitSourceVerifier(input: ResearchValidationPlanInput, dependencies: ValidationExecutionDependencies, options: ValidationExecutionOptions, verifier: GitSourceVerifier): Promise<ResearchValidationPlanResult> { const finalized = await planResearchValidationWithGitSourceVerifier(input, dependencies, verifier); return executeResearchValidationWithGitSourceVerifier(finalized, dependencies, options, verifier); }
