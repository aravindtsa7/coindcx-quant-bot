import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BacktestDecimal, sha256CanonicalJson, updateCanonicalEventHash, type BacktestEvent, type BacktestRunResult } from '../../../../src/backtest';
import { ValidationEvidenceCollector } from '../../../../src/research/research-validation/evidence-collector';
import { calculateExpectancy, calculateMaxDrawdown, calculateMetricsFromEvidence, calculateProfitFactor, calculateSharpe, calculateSortino, calculateTotalNetReturn } from '../../../../src/research/research-validation/metrics';
import { BASE } from '../strategy-coin-matrix/helpers';

const RUN = 'a'.repeat(64);
function event(sequence: number, eventTimeMs: number, type: BacktestEvent['type'], payload: Readonly<Record<string, unknown>> = {}): BacktestEvent { return { sequence, eventTimeMs, type, runId: RUN, entityId: RUN, payload }; }
function outcome(events: readonly BacktestEvent[], finalEquity = '105'): BacktestRunResult {
  const hash = createHash('sha256'); for (const item of events) updateCanonicalEventHash(hash, item);
  const payload = { runId: RUN, terminalStatus: 'COMPLETED' as const, isValid: true as const, pair: 'BTC-INR', datasetId: 'b'.repeat(64), timeRange: { bootstrapFromInclusiveMs: BASE - 60_000, evaluationFromInclusiveMs: BASE, evaluationToExclusiveMs: BASE + 86_400_000, replayToExclusiveMs: BASE + 86_400_000 },
    financialSummary: { initialEquity: new BacktestDecimal('100'), finalEquity: new BacktestDecimal(finalEquity), realizedGrossPnl: new BacktestDecimal('0'), unrealizedGrossPnl: new BacktestDecimal('5'), netPnl: new BacktestDecimal('5'), makerFees: new BacktestDecimal('0'), takerFees: new BacktestDecimal('0'), totalFees: new BacktestDecimal('0'), fundingPnl: new BacktestDecimal('-5'), spreadCostAttribution: new BacktestDecimal('0'), slippageCostAttribution: new BacktestDecimal('0') },
    fidelity: { marketDataFidelity: 'CANONICAL_1M' as const, executionFidelity: 'CONSERVATIVE_1M_OHLCV' as const, partialFillModel: 'NOT_MODELED_PHASE9' as const, queueModel: 'NOT_MODELED_PHASE9' as const, riskEngine: 'NOT_APPLIED_PHASE9' as const, leverageModel: 'NOT_MODELED_PHASE9' as const, liquidationModel: 'NOT_MODELED_PHASE9' as const, fundingFidelity: 'TEST_ONLY' as const }, totalFills: 0, totalClosedTrades: 0, terminalPosition: null, terminalOpenOrders: Object.freeze([]), eventLedgerSha256: hash.digest('hex') };
  return Object.freeze({ ...payload, resultSha256: sha256CanonicalJson(payload) });
}
function collector(): ValidationEvidenceCollector { return new ValidationEvidenceCollector({ validationPlanId: 'c'.repeat(64), validationSubjectId: 'd'.repeat(64), validationFoldId: 'FOLD_00_OOS', scenarioId: 'BASELINE', matrixPlanId: 'e'.repeat(64), matrixCellId: 'f'.repeat(64), expectedRunId: RUN, analysisStartMs: BASE, analysisEndExclusiveMs: BASE + 86_400_000, pair: 'BTC-INR', datasetId: 'b'.repeat(64), bootstrapFromInclusiveMs: BASE - 60_000 }); }

describe('Phase 12 event evidence collector', () => {
  it('hashes the full stream while metrics include terminal post-funding equity', () => {
    const events = [event(1, BASE - 60_000, 'DATASET_VERIFIED'), event(2, BASE, 'ACCOUNT_MARKED', { equity: '100' }), event(3, BASE + 86_400_000, 'ACCOUNT_MARKED', { equity: '110' }), event(4, BASE + 86_400_000, 'FUNDING_APPLIED', { accountEquity: { equity: '105' } }), event(5, BASE + 86_400_000, 'RUN_COMPLETED', { totalFills: 0, totalClosedTrades: 0 })];
    const sink = collector(); for (const item of events) sink.write(item); const evidence = sink.finalize(outcome(events));
    expect(evidence.baselineEquity).toBe('100'); expect(evidence.terminalAnalysisEquity).toBe('105'); expect(evidence.dailyEquities).toHaveLength(2); expect(evidence.dailyReturns).toEqual({ status: 'VALUE', value: ['0.05'] });
    expect(evidence.observedEventCount).toBe(5); expect(evidence.observedEventLedgerSha256).toBe(evidence.phase9EventLedgerSha256);
  });

  it('rejects wrong first sequence, gaps, duplicate/reordered events, wrong run and terminal misuse', () => {
    expect(() => collector().write(event(2, BASE, 'ACCOUNT_MARKED', { equity: '100' }))).toThrow();
    const gap = collector(); gap.write(event(1, BASE, 'ACCOUNT_MARKED', { equity: '100' })); expect(() => gap.write(event(3, BASE, 'RUN_COMPLETED'))).toThrow();
    const wrong = collector(); expect(() => wrong.write({ ...event(1, BASE, 'ACCOUNT_MARKED', { equity: '100' }), runId: 'b'.repeat(64) })).toThrow();
    const terminal = collector(); terminal.write(event(1, BASE, 'RUN_COMPLETED', { totalFills: 0, totalClosedTrades: 0 })); expect(() => terminal.write(event(2, BASE, 'RUN_COMPLETED', { totalFills: 0, totalClosedTrades: 0 }))).toThrow();
    expect(() => collector().finalize(outcome([]))).toThrow();
  });

  it('fails closed on ledger/result tampering and missing UTC boundaries', () => {
    const events = [event(1, BASE, 'ACCOUNT_MARKED', { equity: '100' }), event(2, BASE + 86_400_000, 'ACCOUNT_MARKED', { equity: '101' }), event(3, BASE + 86_400_000, 'RUN_COMPLETED', { totalFills: 0, totalClosedTrades: 0 })];
    const valid = outcome(events, '101'); const ledgerSink = collector(); events.forEach((item) => ledgerSink.write(item));
    const wrongLedgerPayload = { ...valid, eventLedgerSha256: 'f'.repeat(64) }; const wrongLedger = { ...wrongLedgerPayload, resultSha256: sha256CanonicalJson(Object.fromEntries(Object.entries(wrongLedgerPayload).filter(([key]) => key !== 'resultSha256'))) } as BacktestRunResult;
    expect(() => ledgerSink.finalize(wrongLedger)).toThrow(/event ledger hash/);
    const resultSink = collector(); events.forEach((item) => resultSink.write(item)); expect(() => resultSink.finalize({ ...valid, resultSha256: 'f'.repeat(64) })).toThrow(/resultSha256/);
    const missingEvents = [event(1, BASE, 'ACCOUNT_MARKED', { equity: '100' }), event(2, BASE + 86_400_000, 'RUN_COMPLETED', { totalFills: 0, totalClosedTrades: 0 })]; const missing = collector(); missingEvents.forEach((item) => missing.write(item));
    expect(() => missing.finalize(outcome(missingEvents))).toThrow(/Missing UTC equity boundary/);
  });

  it.each(['0', '-1'])('preserves evidence and makes return-dependent metrics unavailable when prior equity is %s', (priorEquity) => {
    const events = [event(1, BASE, 'ACCOUNT_MARKED', { equity: priorEquity }), event(2, BASE + 86_400_000, 'ACCOUNT_MARKED', { equity: '10' }), event(3, BASE + 86_400_000, 'RUN_COMPLETED', { totalFills: 0, totalClosedTrades: 0 })];
    const sink = collector(); events.forEach((item) => sink.write(item)); const evidence = sink.finalize(outcome(events, '10'));
    expect(evidence.dailyReturns).toEqual({ status: 'UNDEFINED', reason: 'NON_POSITIVE_PRIOR_EQUITY', value: null });
    expect(evidence.validationEvidenceSha256).toHaveLength(64);
    const metrics = calculateMetricsFromEvidence([evidence], { policyId: 'P12_METRIC_POLICY_V1', annualRiskFreeRate: '0', annualSortinoTargetRate: '0', annualizationFactor: 365, minDailyObservations: 1, minClosedTrades: 1, sharpeDegradationDenominatorFloor: '0.1' });
    expect(metrics.sharpe).toEqual({ status: 'UNDEFINED', reason: 'NON_POSITIVE_PRIOR_EQUITY', value: null });
    expect(metrics.sortino).toEqual({ status: 'UNDEFINED', reason: 'NON_POSITIVE_PRIOR_EQUITY', value: null });
    const validEvents = [event(1, BASE, 'ACCOUNT_MARKED', { equity: '100' }), event(2, BASE + 86_400_000, 'ACCOUNT_MARKED', { equity: '110' }), event(3, BASE + 86_400_000, 'RUN_COMPLETED', { totalFills: 0, totalClosedTrades: 0 })];
    const validSink = collector(); validEvents.forEach((item) => validSink.write(item)); const validEvidence = validSink.finalize(outcome(validEvents, '110'));
    expect(calculateMetricsFromEvidence([validEvidence, evidence], { policyId: 'P12_METRIC_POLICY_V1', annualRiskFreeRate: '0', annualSortinoTargetRate: '0', annualizationFactor: 365, minDailyObservations: 1, minClosedTrades: 1, sharpeDegradationDenominatorFloor: '0.1' }).sharpe)
      .toEqual({ status: 'UNDEFINED', reason: 'NON_POSITIVE_PRIOR_EQUITY', value: null });
  });
});

describe('Phase 12 decimal metrics', () => {
  const policy = { annualRiskFreeRate: '0', annualSortinoTargetRate: '0', annualizationFactor: 365 as const, minDailyObservations: 2 };
  it('computes return, drawdown, profit factor and expectancy without native float results', () => {
    expect(calculateTotalNetReturn('100', '110')).toEqual({ status: 'VALUE', value: '0.1' });
    expect(calculateMaxDrawdown(['100', '120', '90', '130']).percent).toEqual({ status: 'VALUE', value: '25' });
    expect(calculateProfitFactor(['10', '-5', '2'])).toEqual({ status: 'VALUE', value: '2.4' });
    expect(calculateExpectancy(['10', '-4'])).toEqual({ status: 'VALUE', value: '3' });
    expect(calculateProfitFactor(['1', '2'])).toMatchObject({ status: 'UNDEFINED', reason: 'ZERO_LOSSES' });
  });
  it('uses sample variance and distinct Sortino target with typed degeneracy', () => {
    expect(calculateSharpe(['0.01', '-0.01', '0.02'], policy)).toMatchObject({ status: 'VALUE' });
    expect(calculateSharpe(['0.01', '0.01'], policy)).toMatchObject({ status: 'UNDEFINED', reason: 'ZERO_SAMPLE_VARIANCE' });
    expect(calculateSortino(['0.01', '0.02'], policy)).toMatchObject({ status: 'UNDEFINED', reason: 'ZERO_DOWNSIDE_DEVIATION' });
    expect(calculateSortino(['0.01', '-0.02'], { ...policy, annualSortinoTargetRate: '0.1' })).toMatchObject({ status: 'VALUE' });
  });
});
