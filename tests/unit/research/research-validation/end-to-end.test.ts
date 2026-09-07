import { describe, expect, it } from 'vitest';
import { InMemoryBacktestDatasetSource, type BacktestDatasetSource } from '../../../../src/backtest';
import type { CanonicalCandle1m } from '../../../../src/market-data/types';
import { executeResearchValidationWithGitSourceVerifier } from '../../../../src/research/research-validation/executor';
import { planResearchValidationWithGitSourceVerifier } from '../../../../src/research/research-validation/planner';
import { candles, ControlledGitVerifier, datasetManifest, registry, resources } from '../strategy-coin-matrix/helpers';
import { validationInput } from './helpers';

describe('Phase 12 genuine execution integration', () => {
  it('runs Phase 11/10/9, verifies streamed evidence, and is worker invariant', async () => {
    const rows = candles('BTC-INR', 4 * 24 * 60); const base = resources('BTC-INR');
    const resource = { ...base, datasetManifest: datasetManifest(rows), datasetSource: new InMemoryBacktestDatasetSource('phase12-memory', rows) };
    const definitions = registry(); const input = validationInput([resource]);
    const finalized = await planResearchValidationWithGitSourceVerifier(input, { registry: definitions, pairResources: [resource] }, new ControlledGitVerifier());
    const serial = await executeResearchValidationWithGitSourceVerifier(finalized, { registry: definitions, pairResources: [resource] }, { workerCount: 1 }, new ControlledGitVerifier());
    const parallel = await executeResearchValidationWithGitSourceVerifier(finalized, { registry: definitions, pairResources: [resource] }, { workerCount: 4 }, new ControlledGitVerifier());
    expect(serial.status).toBe('COMPLETED'); expect(serial.subjectResults).toHaveLength(1); expect(serial.subjectResults[0]?.foldResults).toHaveLength(2);
    const evidence = serial.subjectResults[0]?.foldResults.find((fold) => fold.kind === 'OOS')?.evidence;
    expect(evidence?.runId).toBe(evidence?.expectedRunId); expect(evidence?.observedEventLedgerSha256).toBe(evidence?.phase9EventLedgerSha256); expect(evidence?.validationEvidenceSha256).toHaveLength(64);
    expect(parallel).toEqual(serial); expect(parallel.validationResultSha256).toBe(serial.validationResultSha256);
  }, 60_000);

  it('executes genuine stressed runs and changes Phase 9 run identity', async () => {
    const rows = candles('BTC-INR', 4 * 24 * 60); const base = resources('BTC-INR'); const resource = { ...base, datasetManifest: datasetManifest(rows), datasetSource: new InMemoryBacktestDatasetSource('stress-memory', rows) };
    const definitions = registry(); const original = validationInput([resource]); const input = { ...original, thresholds: { ...original.thresholds, requireCostStressSurvival: true }, costStress: { policyId: 'P12_COST_STRESS_V1' as const, scenarios: [{ scenarioId: 'MODERATE_STRESS', costModel: { makerFeeRate: '0.001', takerFeeRate: '0.002', halfSpreadBps: '1', marketSlippageBps: '2', stopSlippageBps: '3' } }] } };
    const finalized = await planResearchValidationWithGitSourceVerifier(input, { registry: definitions, pairResources: [resource] }, new ControlledGitVerifier());
    const result = await executeResearchValidationWithGitSourceVerifier(finalized, { registry: definitions, pairResources: [resource] }, {}, new ControlledGitVerifier()); const subject = result.subjectResults[0];
    const baselineRun = subject?.foldResults.find((fold) => fold.kind === 'OOS')?.evidence?.runId; const stressRun = subject?.costStressEvaluations?.[0]?.evidence[0]?.runId;
    expect(result.status).toBe('COMPLETED'); expect(stressRun).toBeDefined(); expect(stressRun).not.toBe(baselineRun); expect(subject?.gateEvaluations.find((gate) => gate.gateId === 'GATE-10')?.status).not.toBe('DISABLED');
  }, 60_000);

  it('returns FAILED on source invalidation and PARTIAL with explicit aborted subjects', async () => {
    const btcRows = candles('BTC-INR', 4 * 24 * 60); const ethRows = candles('ETH-INR', 4 * 24 * 60); const btcBase = resources('BTC-INR'); const ethBase = resources('ETH-INR');
    const btc = { ...btcBase, datasetManifest: datasetManifest(btcRows), datasetSource: new InMemoryBacktestDatasetSource('btc-memory', btcRows) };
    class FailingSource implements BacktestDatasetSource { public readonly immutable = true as const; public readonly sourceIdentity = 'eth-failing'; public getRange(): Promise<readonly CanonicalCandle1m[]> { return Promise.reject(new Error('controlled read failure')); } }
    const eth = { ...ethBase, datasetManifest: datasetManifest(ethRows), datasetSource: new FailingSource() }; const definitions = registry(); const input = validationInput([btc, eth]);
    const finalized = await planResearchValidationWithGitSourceVerifier(input, { registry: definitions, pairResources: [btc, eth] }, new ControlledGitVerifier());
    const invalid = await executeResearchValidationWithGitSourceVerifier(finalized, { registry: definitions, pairResources: [btc, eth] }, {}, new ControlledGitVerifier(undefined, 2));
    expect(invalid.status).toBe('FAILED'); expect(invalid.subjectResults).toHaveLength(0); expect(invalid.abortedSubjects).toHaveLength(2);
    const partial = await executeResearchValidationWithGitSourceVerifier(finalized, { registry: definitions, pairResources: [btc, eth] }, { workerCount: 2 }, new ControlledGitVerifier());
    expect(partial.status).toBe('PARTIAL'); expect(partial.subjectResults).toHaveLength(1); expect(partial.abortedSubjects).toHaveLength(1); expect(partial.subjectResults.length + partial.abortedSubjects.length).toBe(partial.totalSubjects);
  }, 60_000);
});
