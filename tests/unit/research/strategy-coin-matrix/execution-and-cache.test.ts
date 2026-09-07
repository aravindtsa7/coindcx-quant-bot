import { describe, expect, it } from 'vitest';
import {
  BacktestDecimal,
  canonicalJson,
  sha256CanonicalJson,
  type BacktestDatasetSource,
} from '../../../../src/backtest';
import type { CanonicalCandle1m } from '../../../../src/market-data/types';
import {
  InMemoryMatrixCompletedResultCache,
  validateCachedCompletedResult,
  type MatrixPairExecutionResources,
  type StrategyCoinMatrixCellResult,
} from '../../../../src/research/strategy-coin-matrix';
import { executeWithGitSourceVerifier } from '../../../../src/research/strategy-coin-matrix/executor';
import { planWithGitSourceVerifier } from '../../../../src/research/strategy-coin-matrix/planner';
import { candles, ControlledGitVerifier, matrixInput, registry, resources } from './helpers';

class CountingSource implements BacktestDatasetSource {
  public readonly immutable = true as const;
  public reads = 0;
  public constructor(public readonly sourceIdentity: string, private readonly rows: readonly CanonicalCandle1m[], private readonly shouldFail = false) {}
  public async getRange(pair: string, fromInclusiveMs: number, toInclusiveMs: number): Promise<readonly CanonicalCandle1m[]> {
    this.reads += 1;
    if (this.shouldFail) throw new Error('controlled dataset failure');
    return this.rows.filter((row) => row.pair === pair && row.openTimeMs >= fromInclusiveMs && row.openTimeMs <= toInclusiveMs);
  }
  public assertIdentity(expected: string): void {
    if (expected !== this.sourceIdentity) throw new Error('identity changed');
  }
}

async function finalized(pairResources: readonly MatrixPairExecutionResources[], allStrategies = true) {
  const definitions = registry();
  const plan = await planWithGitSourceVerifier(matrixInput(pairResources, allStrategies), { registry: definitions, pairResources }, new ControlledGitVerifier());
  return { plan, definitions };
}

describe('Phase 11 production execution and cache evidence', () => {
  it('P11-I06/I07/I13 executes BTC and ETH through genuine Phase 9 and all four Phase 10 strategies', async () => {
    const pairResources = [resources('BTC-INR'), resources('ETH-INR')];
    const fixture = await finalized(pairResources);
    const verifier = new ControlledGitVerifier();
    const result = await executeWithGitSourceVerifier(fixture.plan, { registry: fixture.definitions, pairResources }, { workerCount: 2 }, verifier);
    expect(result.status).toBe('COMPLETED');
    expect(result.totalCells).toBe(8);
    expect(result.cellResults.every((cell) => cell.status === 'COMPLETED' && cell.runId === cell.expectedRunId && cell.outcome.runId === cell.expectedRunId)).toBe(true);
    expect(new Set(result.cellResults.map((cell) => cell.strategyId))).toEqual(new Set(['EMA_TREND', 'ATR_BREAKOUT', 'RSI_MOMENTUM', 'MULTI_TIMEFRAME_TREND']));
    expect(new Set(result.cellResults.map((cell) => cell.pair))).toEqual(new Set(['BTC-INR', 'ETH-INR']));
    expect(verifier.assertions).toBe(5);
  });

  it('P11-I09 preserves all terminal cells and distinguishes pre-engine, Phase 9, partial, and source-wide failures', async () => {
    const btc = resources('BTC-INR');
    const eth = resources('ETH-INR');
    const fixture = await finalized([btc, eth]);
    const partialEthSource = new CountingSource(eth.datasetSource.sourceIdentity, candles('ETH-INR'), true);
    const partial = await executeWithGitSourceVerifier(fixture.plan, {
      registry: fixture.definitions,
      pairResources: [btc, { ...eth, datasetSource: partialEthSource }],
    }, { workerCount: 2 }, new ControlledGitVerifier());
    expect(partial.status).toBe('PARTIAL');
    expect(partial.cellResults).toHaveLength(fixture.plan.cells.length);
    const preEngine = partial.cellResults.find((cell) => cell.status === 'FAILED');
    expect(preEngine).toMatchObject({ status: 'FAILED', failure: { code: 'CELL_EXECUTION_FAILED' } });

    const mismatchedEth = { ...eth, instrumentSpec: { ...eth.instrumentSpec, instrumentSpecSnapshotId: 'f'.repeat(64) } };
    await expect(executeWithGitSourceVerifier(
      fixture.plan,
      { registry: fixture.definitions, pairResources: [btc, mismatchedEth] },
      { workerCount: 2 },
      new ControlledGitVerifier(),
    )).rejects.toMatchObject({ code: 'RESOURCE_IDENTITY_MISMATCH' });

    const rows = candles('BTC-INR');
    const brokenSource = new CountingSource(btc.datasetSource.sourceIdentity, rows, true);
    const oneFixture = await finalized([btc], false);
    const engineFailed = await executeWithGitSourceVerifier(oneFixture.plan, {
      registry: oneFixture.definitions,
      pairResources: [{ ...btc, datasetSource: brokenSource }],
    }, {}, new ControlledGitVerifier());
    expect(engineFailed.cellResults[0]).toMatchObject({
      status: 'FAILED',
      failure: { code: 'CELL_EXECUTION_FAILED' },
      outcome: { terminalStatus: 'FAILED', errorCode: 'BACKTEST_RUN_FAILED' },
    });

    const invalidated = await executeWithGitSourceVerifier(fixture.plan, { registry: fixture.definitions, pairResources: [btc, eth] }, { workerCount: 1 }, new ControlledGitVerifier(undefined, 2));
    expect(invalidated.status).toBe('FAILED');
    expect(invalidated.completedCells).toBe(1);
    expect(invalidated.cellResults).toHaveLength(fixture.plan.cells.length);
    expect(invalidated.cellResults.slice(1).every((cell) => cell.status === 'FAILED' && cell.failure.code === 'MATRIX_SOURCE_DIRTY')).toBe(true);

    const finalInvalidation = await executeWithGitSourceVerifier(fixture.plan, { registry: fixture.definitions, pairResources: [btc, eth] }, { workerCount: 8 }, new ControlledGitVerifier(undefined, 2));
    expect(finalInvalidation.status).toBe('FAILED');
    expect(finalInvalidation.completedCells).toBe(8);
    expect(finalInvalidation.failedCells).toBe(0);
  });

  it('P11-I10 is concurrency and verification-page invariant with no canonical timing fields', async () => {
    const pairResources = [resources('BTC-INR'), resources('ETH-INR')];
    const fixture = await finalized(pairResources);
    const serial = await executeWithGitSourceVerifier(fixture.plan, { registry: fixture.definitions, pairResources }, { workerCount: 1, verificationPageMinutes: 1 }, new ControlledGitVerifier());
    const parallel = await executeWithGitSourceVerifier(fixture.plan, { registry: fixture.definitions, pairResources }, { workerCount: 4, verificationPageMinutes: 7 }, new ControlledGitVerifier());
    expect(parallel).toEqual(serial);
    expect(parallel.matrixResultSha256).toBe(serial.matrixResultSha256);
    expect(canonicalJson(parallel)).toBe(canonicalJson(serial));
    expect(canonicalJson(parallel)).not.toMatch(/durationMs|performance|hostname|pid|elapsed/i);
  });

  it('P11-I11 has the frozen complete grid before the first execution boundary', async () => {
    const pairResources = [resources('BTC-INR'), resources('ETH-INR')];
    const fixture = await finalized(pairResources);
    const plannedIds = fixture.plan.cells.map((cell) => cell.matrixCellId);
    expect(Object.isFrozen(fixture.plan.cells)).toBe(true);
    const verifier = new ControlledGitVerifier(undefined, 1);
    const result = await executeWithGitSourceVerifier(fixture.plan, { registry: fixture.definitions, pairResources }, { workerCount: 4 }, verifier);
    expect(fixture.plan.cells.map((cell) => cell.matrixCellId)).toEqual(plannedIds);
    expect(result.totalCells).toBe(plannedIds.length);
    expect(result.failedCells).toBe(plannedIds.length);
  });

  it('P11-I14 emits deeply immutable terminal evidence', async () => {
    const pairResources = [resources('BTC-INR')];
    const fixture = await finalized(pairResources, false);
    const result = await executeWithGitSourceVerifier(fixture.plan, { registry: fixture.definitions, pairResources }, {}, new ControlledGitVerifier());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.cellResults)).toBe(true);
    expect(Object.isFrozen(result.cellResults[0])).toBe(true);
    expect(result.cellResults[0]?.status).toBe('COMPLETED');
    if (result.cellResults[0]?.status === 'COMPLETED') expect(Object.isFrozen(result.cellResults[0].outcome.financialSummary)).toBe(true);
  });

  it('P11-I15 reuses only exact genuine completed hashes and executes fresh for corrupt or failed cache entries', async () => {
    const baseResource = resources('BTC-INR');
    const fixture = await finalized([baseResource], false);
    const first = await executeWithGitSourceVerifier(fixture.plan, { registry: fixture.definitions, pairResources: [baseResource] }, {}, new ControlledGitVerifier());
    const completed = first.cellResults[0];
    const cell = fixture.plan.cells[0];
    if (completed?.status !== 'COMPLETED' || cell === undefined) throw new Error('expected completed fixture');
    expect(validateCachedCompletedResult(cell, completed)).toBe(true);
    expect(sha256CanonicalJson(completed.outcome)).not.toBe(completed.outcome.resultSha256);
    expect(validateCachedCompletedResult(cell, Object.freeze({ ...completed, matrixCellId: 'f'.repeat(64) }))).toBe(false);
    expect(validateCachedCompletedResult(cell, Object.freeze({ ...completed, runId: 'f'.repeat(64) }))).toBe(false);
    expect(validateCachedCompletedResult(cell, Object.freeze({ ...completed, outcome: Object.freeze({ ...completed.outcome, runId: 'f'.repeat(64) }) }))).toBe(false);

    const cachedSource = new CountingSource(baseResource.datasetSource.sourceIdentity, candles('BTC-INR'));
    const cachedResource = resources('BTC-INR', cachedSource);
    const reused = await executeWithGitSourceVerifier(fixture.plan, {
      registry: fixture.definitions,
      pairResources: [cachedResource],
      cache: new InMemoryMatrixCompletedResultCache([completed]),
    }, {}, new ControlledGitVerifier());
    expect(reused.status).toBe('COMPLETED');
    expect(cachedSource.reads).toBe(0);

    const corruptOutcome = Object.freeze({
      ...completed.outcome,
      financialSummary: Object.freeze({ ...completed.outcome.financialSummary, finalEquity: new BacktestDecimal('999') }),
    });
    const corrupt = Object.freeze({ ...completed, outcome: corruptOutcome }) as StrategyCoinMatrixCellResult;
    expect(validateCachedCompletedResult(cell, corrupt)).toBe(false);
    const freshSource = new CountingSource(baseResource.datasetSource.sourceIdentity, candles('BTC-INR'));
    const fresh = await executeWithGitSourceVerifier(fixture.plan, {
      registry: fixture.definitions,
      pairResources: [resources('BTC-INR', freshSource)],
      cache: new InMemoryMatrixCompletedResultCache([corrupt]),
    }, {}, new ControlledGitVerifier());
    expect(fresh.status).toBe('COMPLETED');
    expect(freshSource.reads).toBeGreaterThan(0);

    const malformedSource = new CountingSource(baseResource.datasetSource.sourceIdentity, candles('BTC-INR'));
    const malformed = await executeWithGitSourceVerifier(fixture.plan, {
      registry: fixture.definitions,
      pairResources: [resources('BTC-INR', malformedSource)],
      cache: { get: () => ({ status: 'COMPLETED' }) },
    }, {}, new ControlledGitVerifier());
    expect(malformed.status).toBe('COMPLETED');
    expect(malformedSource.reads).toBeGreaterThan(0);

    const failingSource = new CountingSource(baseResource.datasetSource.sourceIdentity, candles('BTC-INR'), true);
    const failed = await executeWithGitSourceVerifier(fixture.plan, { registry: fixture.definitions, pairResources: [resources('BTC-INR', failingSource)] }, {}, new ControlledGitVerifier());
    const retrySource = new CountingSource(baseResource.datasetSource.sourceIdentity, candles('BTC-INR'));
    const retried = await executeWithGitSourceVerifier(fixture.plan, {
      registry: fixture.definitions,
      pairResources: [resources('BTC-INR', retrySource)],
      cache: new InMemoryMatrixCompletedResultCache(failed.cellResults),
    }, {}, new ControlledGitVerifier());
    expect(retried.status).toBe('COMPLETED');
    expect(retrySource.reads).toBeGreaterThan(0);
  });
});
