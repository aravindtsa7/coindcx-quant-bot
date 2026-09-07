import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryBacktestDatasetSource } from '../../../../src/backtest';
import { executeResearchValidationWithGitSourceVerifier } from '../../../../src/research/research-validation/executor';
import { planResearchValidationWithGitSourceVerifier } from '../../../../src/research/research-validation/planner';
import * as matrixExecutor from '../../../../src/research/strategy-coin-matrix/executor';
import { StrategyCoinMatrixError } from '../../../../src/research/strategy-coin-matrix/errors';
import type { GitSourceVerifier } from '../../../../src/research/strategy-coin-matrix/git-source';
import type { StrategyCoinMatrixPlanResult } from '../../../../src/research/strategy-coin-matrix/types';
import { candles, ControlledGitVerifier, datasetManifest, registry, resources } from '../strategy-coin-matrix/helpers';
import { validationInput } from './helpers';

type SourceCode = 'MATRIX_SOURCE_DIRTY' | 'MATRIX_SOURCE_COMMIT_MISMATCH' | 'MATRIX_SOURCE_STATE_UNAVAILABLE';

class OnceFailingVerifier implements GitSourceVerifier {
  public assertions = 0;
  public captures = 0;
  public constructor(private readonly commit: string, private readonly failAt: number, private readonly code: SourceCode) {}
  public async capture(): Promise<string> { this.captures += 1; return this.commit; }
  public async assertExpected(expected: string): Promise<void> {
    expect(expected).toBe(this.commit);
    this.assertions += 1;
    if (this.assertions === this.failAt) throw new StrategyCoinMatrixError(this.code, 'One-time source invalidation');
  }
}

async function fixture() {
  const rows = candles('BTC-INR', 4 * 24 * 60);
  const resource = { ...resources('BTC-INR'), datasetManifest: datasetManifest(rows), datasetSource: new InMemoryBacktestDatasetSource('source-latch-memory', rows) };
  const dependencies = { registry: registry(), pairResources: [resource] };
  const base = validationInput([resource]);
  const input = { ...base, thresholds: { ...base.thresholds, requireCostStressSurvival: true }, costStress: { policyId: 'P12_COST_STRESS_V1' as const,
    scenarios: [{ scenarioId: 'MODERATE_STRESS', costModel: { makerFeeRate: '0.001', takerFeeRate: '0.002', halfSpreadBps: '1', marketSlippageBps: '2', stopSlippageBps: '3' } }] } };
  const finalized = await planResearchValidationWithGitSourceVerifier(input, dependencies, new ControlledGitVerifier());
  return { dependencies, finalized };
}

function observeMatrices() {
  const executions: { readonly planName: string; readonly result: StrategyCoinMatrixPlanResult }[] = [];
  const execute = matrixExecutor.executeWithGitSourceVerifier;
  const spy = vi.spyOn(matrixExecutor, 'executeWithGitSourceVerifier').mockImplementation(async (...args) => {
    const result = await execute(...args);
    executions.push({ planName: args[0].plan.planName, result });
    return result;
  });
  return { executions, spy };
}

afterEach(() => vi.restoreAllMocks());

describe('P12-FMG01 validation-wide source invalidation', () => {
  it.each([
    ['MATRIX_SOURCE_DIRTY', 'VALIDATION_SOURCE_DIRTY'],
    ['MATRIX_SOURCE_COMMIT_MISMATCH', 'VALIDATION_SOURCE_COMMIT_MISMATCH'],
    ['MATRIX_SOURCE_STATE_UNAVAILABLE', 'VALIDATION_SOURCE_UNAVAILABLE'],
  ] as const)('latches %s at the genuine Phase 11 final check and stops every later window', async (matrixCode, validationCode) => {
    const { dependencies, finalized } = await fixture();
    // Initial Phase 12 check, window boundary, Phase 11 pre-check, Phase 11 final check.
    const verifier = new OnceFailingVerifier(finalized.plan.sourceIdentity.gitCommitHash, 4, matrixCode);
    const { executions, spy } = observeMatrices();
    const result = await executeResearchValidationWithGitSourceVerifier(finalized, dependencies, {}, verifier);

    expect(executions.map((entry) => entry.planName)).toEqual([`${finalized.plan.planName}/FOLD_00_IS/BASELINE`]);
    const matrix = executions[0]?.result;
    expect(matrix?.status).toBe('FAILED');
    expect(matrix?.completedCells).toBe(finalized.subjects.length);
    expect(matrix?.completedCells).toBe(matrix?.totalCells);
    expect(matrix?.cellResults.every((cell) => cell.status === 'COMPLETED')).toBe(true);
    expect(verifier.assertions).toBe(4);
    expect(verifier.captures).toBe(0);
    expect(result.status).toBe('FAILED');
    expect(result.subjectResults).toEqual([]);
    expect(result.abortedSubjects).toEqual(finalized.subjects.map((subject) => ({ validationSubjectId: subject.validationSubjectId, code: validationCode })));
    expect(result.totalSubjects).toBe(result.abortedSubjects.length);

    // The underlying verifier recovers, but the orchestration's private wrapper cannot.
    await expect(verifier.assertExpected(finalized.plan.sourceIdentity.gitCommitHash)).resolves.toBeUndefined();
    const executionVerifier = spy.mock.calls[0]?.[3];
    expect(executionVerifier).toBeDefined();
    await expect(executionVerifier?.assertExpected(finalized.plan.sourceIdentity.gitCommitHash)).rejects.toMatchObject({ code: matrixCode });
    await expect(executionVerifier?.capture()).rejects.toMatchObject({ code: matrixCode });
    expect(verifier.assertions).toBe(5);
    expect(verifier.captures).toBe(0);
    expect(result.status).toBe('FAILED');
    expect(spy).toHaveBeenCalledTimes(1);
  }, 60_000);

  it.each([
    [1, 'MATRIX_SOURCE_DIRTY', 'VALIDATION_SOURCE_DIRTY', 0],
    [1, 'MATRIX_SOURCE_COMMIT_MISMATCH', 'VALIDATION_SOURCE_COMMIT_MISMATCH', 0],
    [5, 'MATRIX_SOURCE_DIRTY', 'VALIDATION_SOURCE_DIRTY', 1],
    [14, 'MATRIX_SOURCE_DIRTY', 'VALIDATION_SOURCE_DIRTY', 4],
  ] as const)('preserves failure at assertion %i (%s)', async (failAt, matrixCode, validationCode, expectedExecutions) => {
    const { dependencies, finalized } = await fixture();
    const verifier = new OnceFailingVerifier(finalized.plan.sourceIdentity.gitCommitHash, failAt, matrixCode);
    const { executions } = observeMatrices();
    const result = await executeResearchValidationWithGitSourceVerifier(finalized, dependencies, {}, verifier);
    expect(verifier.assertions).toBe(failAt);
    expect(executions).toHaveLength(expectedExecutions);
    expect(result.status).toBe('FAILED');
    expect(result.abortedSubjects).toEqual(finalized.subjects.map((subject) => ({ validationSubjectId: subject.validationSubjectId, code: validationCode })));
    if (failAt === 14) expect(executions.map((entry) => entry.planName)).toEqual([
      `${finalized.plan.planName}/FOLD_00_IS/BASELINE`, `${finalized.plan.planName}/FOLD_00_OOS/BASELINE`,
      `${finalized.plan.planName}/FOLD_00_OOS/MODERATE_STRESS`, `${finalized.plan.planName}/HOLDOUT/BASELINE`,
    ]);
  }, 60_000);
});
