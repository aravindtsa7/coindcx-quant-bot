import { describe, expect, it, vi } from 'vitest';
import { sha256CanonicalJson, type BacktestDatasetSource } from '../../../../src/backtest';
import type { CanonicalCandle1m } from '../../../../src/market-data/types';
import {
  executeStrategyCoinMatrix,
  runStrategyCoinMatrix,
  type FinalizedStrategyCoinMatrixPlan,
  type MatrixPairExecutionResources,
  type StrategyCoinMatrixCell,
  type StrategyCoinMatrixPlanInput,
} from '../../../../src/research/strategy-coin-matrix';
import { executeWithGitSourceVerifier } from '../../../../src/research/strategy-coin-matrix/executor';
import { ProductionGitSourceVerifier } from '../../../../src/research/strategy-coin-matrix/git-source';
import { assertFinalizedPlanIntegrity, planWithGitSourceVerifier } from '../../../../src/research/strategy-coin-matrix/planner';
import { BASE, candles, COMMIT_A, ControlledGitVerifier, matrixInput, registry, resources } from './helpers';

class CountingSource implements BacktestDatasetSource {
  public readonly immutable = true as const;
  public reads = 0;

  public constructor(public readonly sourceIdentity: string, private readonly rows: readonly CanonicalCandle1m[]) {}

  public async getRange(pair: string, fromInclusiveMs: number, toInclusiveMs: number): Promise<readonly CanonicalCandle1m[]> {
    this.reads += 1;
    return this.rows.filter((row) => row.pair === pair && row.openTimeMs >= fromInclusiveMs && row.openTimeMs <= toInclusiveMs);
  }

  public assertIdentity(expected: string): void {
    if (expected !== this.sourceIdentity) throw new Error('identity changed');
  }
}

function emaInput(
  pairResource: MatrixPairExecutionResources,
  fastPeriod: readonly number[],
  slowPeriod: readonly number[],
): StrategyCoinMatrixPlanInput {
  const input = matrixInput([pairResource], false);
  const strategy = input.strategies[0];
  if (strategy === undefined) throw new Error('missing EMA fixture');
  return {
    ...input,
    researchWindow: {
      analysisStartMs: BASE + 20 * 60_000,
      analysisEndExclusiveMs: BASE + 23 * 60_000,
    },
    strategies: [{
      ...strategy,
      candidateSpace: {
        ...strategy.candidateSpace,
        dimensions: { timeframeMinutes: [1], fastPeriod, slowPeriod, priceSource: ['CLOSE'] },
      },
    }],
  };
}

function cellIdentity(cell: Omit<StrategyCoinMatrixCell, 'cellSequence' | 'matrixCellId'>): Readonly<Record<string, unknown>> {
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

function transplant(cell: StrategyCoinMatrixCell, matrixPlanId: string): StrategyCoinMatrixCell {
  const {
    cellSequence: _cellSequence,
    matrixCellId: _matrixCellId,
    ...sourceIdentity
  } = cell;
  const unsequenced = { ...sourceIdentity, matrixPlanId };
  return Object.freeze({
    ...unsequenced,
    matrixCellId: sha256CanonicalJson(cellIdentity(unsequenced)),
    cellSequence: 1,
  });
}

function canonicalArtifact(
  finalized: FinalizedStrategyCoinMatrixPlan,
  suppliedCells: readonly StrategyCoinMatrixCell[],
): FinalizedStrategyCoinMatrixPlan {
  const sorted = [...suppliedCells].sort((left, right) => {
    const leftKey = [left.pair, left.strategyId, left.strategyVersion, left.parameterHash, left.strategyInstanceId, left.expectedRunId].join('|');
    const rightKey = [right.pair, right.strategyId, right.strategyVersion, right.parameterHash, right.strategyInstanceId, right.expectedRunId].join('|');
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return Object.freeze({
    ...finalized,
    cells: Object.freeze(sorted.map((cell, index) => Object.freeze({ ...cell, cellSequence: index + 1 }))),
  });
}

async function fixture() {
  const baseResource = resources('BTC-INR');
  const definitions = registry();
  const dependencies = { registry: definitions, pairResources: [baseResource] };
  const target = await planWithGitSourceVerifier(emaInput(baseResource, [1, 2], [3, 4]), dependencies, new ControlledGitVerifier());
  const foreign = await planWithGitSourceVerifier(emaInput(baseResource, [1], [5]), dependencies, new ControlledGitVerifier());
  return { baseResource, definitions, foreign, target };
}

async function expectPreDispatchRejection(
  artifact: FinalizedStrategyCoinMatrixPlan,
  baseResource: MatrixPairExecutionResources,
  definitions: ReturnType<typeof registry>,
  expectedCode: 'MATRIX_PLAN_INTEGRITY_MISMATCH' | 'CONCURRENCY_INTEGRITY_VIOLATION' = 'MATRIX_PLAN_INTEGRITY_MISMATCH',
): Promise<void> {
  const source = new CountingSource(baseResource.datasetSource.sourceIdentity, candles(baseResource.pair));
  let cacheGets = 0;
  const executionResource = resources(baseResource.pair, source);
  await expect(executeWithGitSourceVerifier(
    artifact,
    {
      registry: definitions,
      pairResources: [executionResource],
      cache: { get: () => { cacheGets += 1; return null; } },
    },
    { workerCount: 4 },
    new ControlledGitVerifier(),
  )).rejects.toMatchObject({ code: expectedCode });
  expect(source.reads).toBe(0);
  expect(cacheGets).toBe(0);
}

describe('P11-I16 authoritative finalized cell-set reconstruction', () => {
  it('accepts an untouched planner artifact through the shared authoritative derivation source', async () => {
    const { baseResource, definitions, target } = await fixture();
    const source = new CountingSource(baseResource.datasetSource.sourceIdentity, candles(baseResource.pair));
    const result = await executeWithGitSourceVerifier(
      target,
      { registry: definitions, pairResources: [resources(baseResource.pair, source)] },
      { workerCount: 2 },
      new ControlledGitVerifier(),
    );
    expect(result.status).toBe('COMPLETED');
    expect(result.totalCells).toBe(4);
    expect(source.reads).toBeGreaterThan(0);
  });

  it('rejects an omitted valid cell after attacker resequencing and before execution or cache lookup', async () => {
    const { baseResource, definitions, target } = await fixture();
    const artifact = canonicalArtifact(target, target.cells.slice(0, -1));
    expect(() => assertFinalizedPlanIntegrity(artifact)).not.toThrow();
    await expectPreDispatchRejection(artifact, baseResource, definitions);
  });

  it('rejects an extra valid-looking fully rehashed cell before execution or cache lookup', async () => {
    const { baseResource, definitions, foreign, target } = await fixture();
    const foreignCell = foreign.cells[0];
    if (foreignCell === undefined) throw new Error('missing foreign cell');
    const artifact = canonicalArtifact(target, [...target.cells, transplant(foreignCell, target.matrixPlanId)]);
    expect(() => assertFinalizedPlanIntegrity(artifact)).not.toThrow();
    await expectPreDispatchRejection(artifact, baseResource, definitions);
  });

  it('rejects a foreign candidate substitution even when every dependent identity is consistently rehashed', async () => {
    const { baseResource, definitions, foreign, target } = await fixture();
    const foreignCell = foreign.cells[0];
    if (foreignCell === undefined) throw new Error('missing foreign cell');
    const artifact = canonicalArtifact(target, [transplant(foreignCell, target.matrixPlanId), ...target.cells.slice(1)]);
    expect(() => assertFinalizedPlanIntegrity(artifact)).not.toThrow();
    await expectPreDispatchRejection(artifact, baseResource, definitions);
  });

  it('rejects duplicate-plus-omission before any cell execution or cache lookup', async () => {
    const { baseResource, definitions, target } = await fixture();
    const first = target.cells[0];
    if (first === undefined) throw new Error('missing target cell');
    const artifact = canonicalArtifact(target, [first, first, ...target.cells.slice(2)]);
    await expectPreDispatchRejection(artifact, baseResource, definitions, 'CONCURRENCY_INTEGRITY_VIOLATION');
  });

  it('rejects a crafted fully rehashed out-of-plan cell that passes structural integrity', async () => {
    const baseResource = resources('BTC-INR');
    const definitions = registry();
    const dependencies = { registry: definitions, pairResources: [baseResource] };
    const target = await planWithGitSourceVerifier(emaInput(baseResource, [1], [2]), dependencies, new ControlledGitVerifier());
    const foreign = await planWithGitSourceVerifier(emaInput(baseResource, [1], [3]), dependencies, new ControlledGitVerifier());
    const foreignCell = foreign.cells[0];
    if (foreignCell === undefined) throw new Error('missing foreign cell');
    const artifact = canonicalArtifact(target, [transplant(foreignCell, target.matrixPlanId)]);
    expect(() => assertFinalizedPlanIntegrity(artifact)).not.toThrow();
    await expectPreDispatchRejection(artifact, baseResource, definitions);
  });

  it('rejects the same-count replacement of one expected candidate by another valid strategy candidate', async () => {
    const { baseResource, definitions, foreign, target } = await fixture();
    const foreignCell = foreign.cells[0];
    if (foreignCell === undefined) throw new Error('missing foreign cell');
    const artifact = canonicalArtifact(target, [...target.cells.slice(0, -1), transplant(foreignCell, target.matrixPlanId)]);
    expect(artifact.cells).toHaveLength(target.cells.length);
    expect(() => assertFinalizedPlanIntegrity(artifact)).not.toThrow();
    await expectPreDispatchRejection(artifact, baseResource, definitions);
  });

  it('rejects N-1 supplied cells even when every supplied cell is genuine and structurally valid', async () => {
    const { baseResource, definitions, target } = await fixture();
    const artifact = canonicalArtifact(target, target.cells.slice(1));
    expect(() => assertFinalizedPlanIntegrity(artifact)).not.toThrow();
    await expectPreDispatchRejection(artifact, baseResource, definitions);
  });

  it('protects both public execution entry points and keeps the Git verifier non-injectable publicly', async () => {
    const { baseResource, definitions, foreign, target } = await fixture();
    const foreignCell = foreign.cells[0];
    if (foreignCell === undefined) throw new Error('missing foreign cell');
    const invalid = canonicalArtifact(target, [transplant(foreignCell, target.matrixPlanId), ...target.cells.slice(1)]);
    const source = new CountingSource(baseResource.datasetSource.sourceIdentity, candles(baseResource.pair));
    const runtimeResource = resources(baseResource.pair, source);
    const capture = vi.spyOn(ProductionGitSourceVerifier.prototype, 'capture').mockResolvedValue(COMMIT_A);
    const assertExpected = vi.spyOn(ProductionGitSourceVerifier.prototype, 'assertExpected').mockResolvedValue(undefined);
    try {
      await expect(executeStrategyCoinMatrix(invalid, { registry: definitions, pairResources: [runtimeResource] }))
        .rejects.toMatchObject({ code: 'MATRIX_PLAN_INTEGRITY_MISMATCH' });
      expect(source.reads).toBe(0);

      const valid = await runStrategyCoinMatrix(emaInput(runtimeResource, [1], [2]), { registry: definitions, pairResources: [runtimeResource] });
      expect(valid.status).toBe('COMPLETED');
      expect(source.reads).toBeGreaterThan(0);
    } finally {
      capture.mockRestore();
      assertExpected.mockRestore();
    }
  });
});
