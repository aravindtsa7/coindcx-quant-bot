import { describe, expect, it } from 'vitest';
import { BacktestDecimal, normalizeBacktestInputs, sha256CanonicalJson } from '../../../../src/backtest';
import {
  deriveIndicatorBootstrapIdentity,
  type MatrixStrategyCatalogEntry,
  StrategyCoinMatrixError,
  type StrategyCoinMatrixPlanInput,
} from '../../../../src/research/strategy-coin-matrix';
import { planWithGitSourceVerifier } from '../../../../src/research/strategy-coin-matrix/planner';
import { buildStrategyBacktestParticipantIdentity } from '../../../../src/strategies';
import { BASE, COMMIT_A, COMMIT_B, ControlledGitVerifier, matrixInput, registry, resources } from './helpers';

async function plan(input: StrategyCoinMatrixPlanInput, pairResources = [resources('BTC-INR')]) {
  return planWithGitSourceVerifier(input, { registry: registry(), pairResources }, new ControlledGitVerifier());
}

describe('Phase 11 deterministic planning', () => {
  it('P11-I01 canonicalizes object, dimension, candidate, pair, and strategy ordering', async () => {
    const btc = resources('BTC-INR');
    const eth = resources('ETH-INR');
    const baseInput = matrixInput([btc, eth], false);
    const baseStrategy = baseInput.strategies[0];
    if (baseStrategy === undefined) throw new Error('missing fixture strategy');
    const first: StrategyCoinMatrixPlanInput = {
      ...baseInput,
      strategies: [{ ...baseStrategy, candidateSpace: { ...baseStrategy.candidateSpace, dimensions: { timeframeMinutes: [1], fastPeriod: [2, 1], slowPeriod: [4, 3], priceSource: ['CLOSE'] } } }],
    };
    const strategy = first.strategies[0];
    if (strategy === undefined) throw new Error('missing fixture strategy');
    const shuffled: StrategyCoinMatrixPlanInput = {
      backtestConfig: { ...first.backtestConfig, costModel: { ...first.backtestConfig.costModel } },
      pairs: [...first.pairs].reverse(),
      researchWindow: { analysisEndExclusiveMs: first.researchWindow.analysisEndExclusiveMs, analysisStartMs: first.researchWindow.analysisStartMs },
      bootstrapPolicyId: first.bootstrapPolicyId,
      planName: first.planName,
      strategies: [{
        strategyVersion: strategy.strategyVersion,
        strategyId: strategy.strategyId,
        candidateSpace: {
          strategyVersion: strategy.strategyVersion,
          strategyId: strategy.strategyId,
          dimensions: { slowPeriod: [3, 4], timeframeMinutes: [1], priceSource: ['CLOSE'], fastPeriod: [1, 2] },
        },
      }],
    };
    const left = await plan(first, [btc, eth]);
    const right = await plan(shuffled, [eth, btc]);
    expect(left.plan).toEqual(right.plan);
    expect(left.matrixPlanId).toBe(right.matrixPlanId);
    expect(left.cells).toEqual(right.cells);
  });

  it('P11-I04 binds the verified full Git commit into matrix plan identity', async () => {
    const pairResource = resources('BTC-INR');
    const input = matrixInput([pairResource], false);
    const dependencies = { registry: registry(), pairResources: [pairResource] };
    const first = await planWithGitSourceVerifier(input, dependencies, new ControlledGitVerifier(COMMIT_A));
    const second = await planWithGitSourceVerifier(input, dependencies, new ControlledGitVerifier(COMMIT_B));
    expect(first.plan.sourceIdentity.gitCommitHash).toBe(COMMIT_A);
    expect(second.plan.sourceIdentity.gitCommitHash).toBe(COMMIT_B);
    expect(first.matrixPlanId).not.toBe(second.matrixPlanId);
  });

  it.each([
    ['EMA_TREND', { timeframeMinutes: [1], fastPeriod: [2], slowPeriod: [2], priceSource: ['CLOSE'] }],
    ['ATR_BREAKOUT', { timeframeMinutes: [1], atrPeriod: [0], breakoutMultiplier: ['1'] }],
    ['RSI_MOMENTUM', { timeframeMinutes: [1], period: [1], shortThreshold: ['70'], longThreshold: ['30'], priceSource: ['CLOSE'] }],
    ['MULTI_TIMEFRAME_TREND', { timeframes: [[1, 1]], fastPeriod: [1], slowPeriod: [2], priceSource: ['CLOSE'] }],
  ])('P11-I02 preserves Phase 10 validation authority for %s', async (strategyId, dimensions) => {
    const pairResource = resources('BTC-INR');
    const input = matrixInput([pairResource], false);
    const strategy: MatrixStrategyCatalogEntry = {
      strategyId,
      strategyVersion: '1.0.0',
      candidateSpace: { strategyId, strategyVersion: '1.0.0', dimensions },
    };
    await expect(plan({ ...input, strategies: [strategy] }, [pairResource])).rejects.toMatchObject({ code: 'STRATEGY_PARAM_VALIDATION_FAILED' });
  });

  it('delegates financial and execution configuration rejection to the Phase 9 normalization path', async () => {
    const pairResource = resources('BTC-INR');
    const input = matrixInput([pairResource], false);
    const invalid = { ...input, backtestConfig: { ...input.backtestConfig, costModel: { ...input.backtestConfig.costModel, makerFeeRate: '-0.1' } } };
    await expect(plan(invalid, [pairResource])).rejects.toMatchObject({ code: 'INVALID_BACKTEST_CONFIG' });
  });

  it('P11-I03 derives exact EMA, ATR, and RSI warmup and rejects insufficient coverage', async () => {
    const requirements = [
      { alias: 'ema', indicatorType: 'EMA' as const, timeframeMinutes: 5, parameters: { period: 2 }, priceSource: 'CLOSE' as const },
      { alias: 'atr', indicatorType: 'ATR' as const, timeframeMinutes: 2, parameters: { period: 3 } },
      { alias: 'rsi', indicatorType: 'RSI' as const, timeframeMinutes: 1, parameters: { period: 4 }, priceSource: 'CLOSE' as const },
    ];
    const first = deriveIndicatorBootstrapIdentity(requirements, BASE + 60 * 60_000);
    const second = deriveIndicatorBootstrapIdentity(requirements, BASE + 60 * 60_000);
    expect(first).toEqual(second);
    expect(first.entries.map((entry) => entry.timeframeMinutes)).toEqual([1, 2, 5]);
    expect(first.bootstrapFromInclusiveMs).toBe(BASE + 30 * 60_000);
    expect(first.bootstrapFromInclusiveMs % (10 * 60_000)).toBe(0);

    const short = resources('BTC-INR');
    const input = matrixInput([short], false);
    const lateDataset = { ...short.datasetManifest, fromInclusiveMs: BASE + 10 * 60_000 };
    const boundLate = {
      ...input,
      pairs: [{ ...input.pairs[0]!, datasetBinding: { ...input.pairs[0]!.datasetBinding, datasetId: lateDataset.datasetId, datasetContentSha256: lateDataset.contentSha256 } }],
    };
    await expect(plan(boundLate, [{ ...short, datasetManifest: lateDataset }])).rejects.toMatchObject({ code: 'DATASET_COVERAGE_GAP' });

    const earlyEnd = { ...short.datasetManifest, toExclusiveMs: BASE + 19 * 60_000 };
    const boundEarlyEnd = {
      ...input,
      pairs: [{ ...input.pairs[0]!, datasetBinding: { ...input.pairs[0]!.datasetBinding, datasetId: earlyEnd.datasetId, datasetContentSha256: earlyEnd.contentSha256 } }],
    };
    await expect(plan(boundEarlyEnd, [{ ...short, datasetManifest: earlyEnd }])).rejects.toMatchObject({ code: 'DATASET_COVERAGE_GAP' });
  });

  it('P11-I05 expands the complete grid in canonical total order with stable 1-based sequence', async () => {
    const btc = resources('BTC-INR');
    const eth = resources('ETH-INR');
    const finalized = await plan(matrixInput([eth, btc]), [eth, btc]);
    expect(finalized.cells).toHaveLength(8);
    expect(finalized.cells.map((cell) => cell.cellSequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(finalized.cells.map((cell) => cell.pair)).toEqual(['BTC-INR', 'BTC-INR', 'BTC-INR', 'BTC-INR', 'ETH-INR', 'ETH-INR', 'ETH-INR', 'ETH-INR']);
    const tuples = finalized.cells.map((cell) => [cell.pair, cell.strategyId, cell.strategyVersion, cell.parameterHash, cell.strategyInstanceId, cell.expectedRunId].join('|'));
    expect(tuples).toEqual([...tuples].sort());
    expect(new Set(finalized.cells.map((cell) => cell.matrixCellId)).size).toBe(8);
  });

  it('P11-I06 delegates expectedRunId and configured higher timeframes to real Phase 9 inputs', async () => {
    const pairResource = resources('BTC-INR');
    const finalized = await plan(matrixInput([pairResource]), [pairResource]);
    const cell = finalized.cells.find((candidate) => candidate.strategyId === 'MULTI_TIMEFRAME_TREND');
    if (cell === undefined) throw new Error('missing MTF cell');
    const definition = registry().get(cell.strategyId, cell.strategyVersion);
    const description = definition.describeConstruction(cell.normalizedParameters);
    const bootstrap = deriveIndicatorBootstrapIdentity(description.indicatorRequirements, finalized.plan.researchWindow.analysisStartMs);
    const kernel = definition.createKernel({ pair: cell.pair, parameters: cell.normalizedParameters, indicatorBootstrapIdentity: bootstrap.entries });
    const participantIdentity = buildStrategyBacktestParticipantIdentity({ kernel, fixedResearchQuantity: cell.fixedResearchQuantity, gitCommitHash: COMMIT_A });
    const normalized = normalizeBacktestInputs({
      datasetManifest: pairResource.datasetManifest,
      bootstrapFromInclusiveMs: cell.timeRange.bootstrapFromInclusiveMs,
      evaluationFromInclusiveMs: cell.timeRange.evaluationFromInclusiveMs,
      evaluationToExclusiveMs: cell.timeRange.evaluationToExclusiveMs,
      replayToExclusiveMs: cell.timeRange.replayToExclusiveMs,
      configuredTimeframes: [...new Set(kernel.indicatorRequirements.map((requirement) => requirement.timeframeMinutes).filter((timeframe) => timeframe > 1))].sort((left, right) => left - right),
      instrumentSpec: pairResource.instrumentSpec,
      costModel: {
        makerFeeRate: new BacktestDecimal('0'), takerFeeRate: new BacktestDecimal('0'), halfSpreadBps: new BacktestDecimal('0'),
        marketSlippageBps: new BacktestDecimal('0'), stopSlippageBps: new BacktestDecimal('0'),
      },
      fundingSchedule: pairResource.fundingSchedule,
      participantIdentity,
      initialEquity: '10000',
      intrabarAmbiguityPolicy: 'ADVERSE_FIRST',
      maxOpenOrders: 20,
      engineSemanticVersion: '9.0.0',
      sourceIdentity: pairResource.datasetSource.sourceIdentity,
    });
    expect(normalized.configuredTimeframes).toEqual([2]);
    expect(normalized.runId).toBe(cell.expectedRunId);
    expect(normalized.runId).toBe(sha256CanonicalJson(normalized.manifest));
    const changedDataset = normalizeBacktestInputs({ ...normalizedInput(normalized, pairResource), datasetManifest: { ...pairResource.datasetManifest, datasetId: 'c'.repeat(64) } });
    const changedGit = normalizeBacktestInputs({ ...normalizedInput(normalized, pairResource), participantIdentity: { ...participantIdentity, gitCommitHash: COMMIT_B } });
    const changedFunding = normalizeBacktestInputs({ ...normalizedInput(normalized, pairResource), fundingSchedule: { ...pairResource.fundingSchedule, sourceId: 'different-funding-source' } });
    const changedConfig = normalizeBacktestInputs({ ...normalizedInput(normalized, pairResource), initialEquity: '10001' });
    expect(new Set([normalized.runId, changedDataset.runId, changedGit.runId, changedFunding.runId, changedConfig.runId]).size).toBe(5);
  });

  it('P11-I08 rejects duplicate normalized candidates and unsupported indicators before a plan exists', async () => {
    const pairResource = resources('BTC-INR');
    const input = matrixInput([pairResource], false);
    const duplicate: MatrixStrategyCatalogEntry = {
      strategyId: 'ATR_BREAKOUT', strategyVersion: '1.0.0',
      candidateSpace: { strategyId: 'ATR_BREAKOUT', strategyVersion: '1.0.0', dimensions: { timeframeMinutes: [1], atrPeriod: [1], breakoutMultiplier: ['2.0', '2.00'] } },
    };
    await expect(plan({ ...input, strategies: [duplicate] }, [pairResource])).rejects.toMatchObject({ code: 'DUPLICATE_PARAMETER_CANDIDATE' });
    const duplicateMtf: MatrixStrategyCatalogEntry = {
      strategyId: 'MULTI_TIMEFRAME_TREND', strategyVersion: '1.0.0',
      candidateSpace: { strategyId: 'MULTI_TIMEFRAME_TREND', strategyVersion: '1.0.0', dimensions: { timeframes: [[2, 1], [1, 2]], fastPeriod: [1], slowPeriod: [2], priceSource: ['CLOSE'] } },
    };
    await expect(plan({ ...input, strategies: [duplicateMtf] }, [pairResource])).rejects.toMatchObject({ code: 'DUPLICATE_PARAMETER_CANDIDATE' });
    for (const indicatorType of ['SMA', 'MACD', 'BOLLINGER', 'SUPERTREND'] as const) {
      expect(() => deriveIndicatorBootstrapIdentity([
        { alias: indicatorType.toLowerCase(), indicatorType, timeframeMinutes: 1, parameters: { period: 2 } },
      ], BASE)).toThrowError(expect.objectContaining({ code: 'MATRIX_UNSUPPORTED_INDICATOR_BOOTSTRAP_POLICY' }));
    }
    let kernelCreated = false;
    const unsupportedRegistry = registry();
    unsupportedRegistry.register(Object.freeze({
      strategyId: 'CUSTOM_SMA', strategyVersion: '1.0.0',
      normalizeParameters: () => Object.freeze({ period: 2 }),
      describeConstruction: () => Object.freeze({
        normalizedParameters: Object.freeze({ period: 2 }),
        triggerTimeframeMinutes: 1,
        indicatorRequirements: Object.freeze([{ alias: 'sma', indicatorType: 'SMA' as const, timeframeMinutes: 1, parameters: Object.freeze({ period: 2 }) }]),
      }),
      createKernel: () => { kernelCreated = true; throw new Error('must not construct unsupported kernel'); },
    }));
    const unsupportedStrategy: MatrixStrategyCatalogEntry = {
      strategyId: 'CUSTOM_SMA', strategyVersion: '1.0.0',
      candidateSpace: { strategyId: 'CUSTOM_SMA', strategyVersion: '1.0.0', dimensions: { period: [2] } },
    };
    await expect(planWithGitSourceVerifier({ ...input, strategies: [unsupportedStrategy] }, { registry: unsupportedRegistry, pairResources: [pairResource] }, new ControlledGitVerifier()))
      .rejects.toMatchObject({ code: 'MATRIX_UNSUPPORTED_INDICATOR_BOOTSTRAP_POLICY' });
    expect(kernelCreated).toBe(false);
    expect(sha256CanonicalJson({ ...input, bootstrapPolicyId: 'P11_INDICATOR_BOOTSTRAP_V1' }))
      .not.toBe(sha256CanonicalJson({ ...input, bootstrapPolicyId: 'P11_INDICATOR_BOOTSTRAP_V2' }));
  });

  it('P11-I12 binds quantity only at adapter/run/cell identity layers', async () => {
    const pairResource = resources('BTC-INR');
    const firstInput = matrixInput([pairResource], false);
    const secondInput = { ...firstInput, pairs: [{ ...firstInput.pairs[0]!, fixedResearchQuantity: '0.02' }] };
    const first = await plan(firstInput, [pairResource]);
    const second = await plan(secondInput, [pairResource]);
    expect(first.cells[0]?.parameterHash).toBe(second.cells[0]?.parameterHash);
    expect(first.cells[0]?.strategyInstanceId).toBe(second.cells[0]?.strategyInstanceId);
    expect(first.cells[0]?.expectedRunId).not.toBe(second.cells[0]?.expectedRunId);
    expect(first.cells[0]?.matrixCellId).not.toBe(second.cells[0]?.matrixCellId);
    const definition = registry().get('EMA_TREND', '1.0.0');
    if (first.cells[0] === undefined) throw new Error('missing cell');
    const description = definition.describeConstruction(first.cells[0].normalizedParameters);
    const bootstrap = deriveIndicatorBootstrapIdentity(description.indicatorRequirements, first.plan.researchWindow.analysisStartMs);
    const kernel = definition.createKernel({ pair: 'BTC-INR', parameters: first.cells[0].normalizedParameters, indicatorBootstrapIdentity: bootstrap.entries });
    expect(buildStrategyBacktestParticipantIdentity({ kernel, fixedResearchQuantity: '0.01', gitCommitHash: COMMIT_A }).parameterHash)
      .not.toBe(buildStrategyBacktestParticipantIdentity({ kernel, fixedResearchQuantity: '0.02', gitCommitHash: COMMIT_A }).parameterHash);
  });

  it('P11-I14 defensively copies caller inputs and deeply freezes plan and cells', async () => {
    const pairResource = resources('BTC-INR');
    const input = matrixInput([pairResource]);
    const mutablePairs = [...input.pairs];
    const mutableValues = [1];
    const mutableTimeframes = [2, 1];
    const mutableInput = {
      ...input,
      pairs: mutablePairs,
      strategies: input.strategies.map((strategy) => strategy.strategyId === 'EMA_TREND'
        ? { ...strategy, candidateSpace: { ...strategy.candidateSpace, dimensions: { timeframeMinutes: mutableValues, fastPeriod: [1], slowPeriod: [2], priceSource: ['CLOSE'] } } }
        : strategy.strategyId === 'MULTI_TIMEFRAME_TREND'
          ? { ...strategy, candidateSpace: { ...strategy.candidateSpace, dimensions: { timeframes: [mutableTimeframes], fastPeriod: [1], slowPeriod: [2], priceSource: ['CLOSE'] } } }
          : strategy),
    };
    const finalized = await plan(mutableInput, [pairResource]);
    const before = JSON.stringify(finalized);
    const mutablePair = mutablePairs[0] as unknown as {
      fixedResearchQuantity: string;
      datasetBinding: { datasetId: string };
      fundingScheduleBinding: { sourceId: string };
    };
    const mutableConfig = mutableInput.backtestConfig as unknown as { initialEquity: string; costModel: { makerFeeRate: string } };
    mutablePairs.length = 0;
    mutableValues[0] = 5;
    mutableTimeframes.push(60);
    mutablePair.fixedResearchQuantity = '999';
    mutablePair.datasetBinding.datasetId = 'f'.repeat(64);
    mutablePair.fundingScheduleBinding.sourceId = 'mutated';
    mutableConfig.initialEquity = '1';
    mutableConfig.costModel.makerFeeRate = '0.9';
    expect(JSON.stringify(finalized)).toBe(before);
    expect(Object.isFrozen(finalized)).toBe(true);
    expect(Object.isFrozen(finalized.plan.pairs)).toBe(true);
    expect(Object.isFrozen(finalized.plan.strategies[0]?.candidateSpace.dimensions)).toBe(true);
    expect(Object.isFrozen(finalized.cells[0]?.normalizedParameters)).toBe(true);
    expect(() => { (finalized.cells as unknown as unknown[]).push(new StrategyCoinMatrixError('CELL_EXECUTION_FAILED', 'x')); }).toThrow();
    expect(finalized.plan.sourceIdentity.gitCommitHash).toBe(COMMIT_A);
  });
});

function normalizedInput(
  normalized: ReturnType<typeof normalizeBacktestInputs>,
  pairResource: ReturnType<typeof resources>,
) {
  return {
    datasetManifest: pairResource.datasetManifest,
    bootstrapFromInclusiveMs: normalized.manifest.bootstrapFromInclusiveMs,
    evaluationFromInclusiveMs: normalized.manifest.evaluationFromInclusiveMs,
    evaluationToExclusiveMs: normalized.manifest.evaluationToExclusiveMs,
    replayToExclusiveMs: normalized.manifest.replayToExclusiveMs,
    configuredTimeframes: normalized.configuredTimeframes,
    instrumentSpec: pairResource.instrumentSpec,
    costModel: normalized.costModel,
    fundingSchedule: pairResource.fundingSchedule,
    participantIdentity: normalized.manifest.participant,
    initialEquity: normalized.manifest.initialEquity,
    intrabarAmbiguityPolicy: normalized.manifest.intrabarAmbiguityPolicy,
    maxOpenOrders: normalized.manifest.maxOpenOrders,
    engineSemanticVersion: normalized.manifest.engineSemanticVersion,
    sourceIdentity: pairResource.datasetSource.sourceIdentity,
  };
}
