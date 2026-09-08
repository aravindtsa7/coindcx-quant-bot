import { describe, expect, it } from 'vitest';
import { sha256CanonicalJson } from '../../../../src/backtest';
import { calc, canonical } from '../../../../src/research/research-validation/numeric';
import { calculateMaxDrawdown, calculateMetricsFromEvidence } from '../../../../src/research/research-validation/metrics';
import { metricGate } from '../../../../src/research/research-validation/gates';
import type { CanonicalValidationEvidence } from '../../../../src/research/research-validation/types';
import { BASE } from '../strategy-coin-matrix/helpers';
import { validationInput } from './helpers';

const DAY = 86_400_000;
const policy = validationInput([]).metricPolicy;
function evidence(equities: readonly string[], start: number): CanonicalValidationEvidence {
  const baselineEquity = equities[0]!; const terminalAnalysisEquity = equities[equities.length - 1]!;
  const drawdown = calculateMaxDrawdown(equities);
  const dailyEquities = equities.map((equity, index) => ({ boundaryTimeMs: start + index * DAY, equity }));
  const dailyReturns = { status: 'VALUE' as const, value: equities.slice(1).map((equity, index) => canonical(calc(equity).div(calc(equities[index]!)).minus(1))) };
  const payload = { schemaVersion: 1 as const, validationPlanId: 'a'.repeat(64), validationSubjectId: 'b'.repeat(64), validationFoldId: String(start), scenarioId: 'BASELINE',
    matrixPlanId: 'c'.repeat(64), matrixCellId: sha256CanonicalJson(start), expectedRunId: 'd'.repeat(64), runId: 'd'.repeat(64), resultSha256: 'e'.repeat(64), observedEventLedgerSha256: 'f'.repeat(64), phase9EventLedgerSha256: 'f'.repeat(64),
    observedEventCount: equities.length, baselineEquity, terminalAnalysisEquity, totalNetReturn: canonical(calc(terminalAnalysisEquity).div(calc(baselineEquity)).minus(1)),
    maxDrawdownAmount: drawdown.amount.status === 'VALUE' ? drawdown.amount.value : '0', maxDrawdownPercent: drawdown.percent.status === 'VALUE' ? drawdown.percent.value : '0',
    totalFills: 0, totalClosedTrades: 0, totalFees: '0', fundingPnl: '0', dailyEquities, dailyReturns, closedTradeGrossPnls: [],
    equityPath: dailyEquities.map((point) => ({ eventTimeMs: point.boundaryTimeMs, equity: point.equity })),
  };
  return { ...payload, validationEvidenceSha256: sha256CanonicalJson(payload) };
}

describe('Audit B3 continuous chronological aggregate equity', () => {
  it.each([
    { label: 'two losses', paths: [['100', '90'], ['100', '90']], total: '-0.19', drawdown: '19' },
    { label: 'loss then recovery', paths: [['100', '90'], ['100', '120']], total: '0.08', drawdown: '10' },
    { label: 'later new peak', paths: [['100', '90'], ['100', '150', '120']], total: '0.08', drawdown: '20' },
    { label: 'flat fold between losses', paths: [['100', '90'], ['100', '100'], ['100', '90']], total: '-0.19', drawdown: '19' },
  ])('$label preserves cumulative equity and peak state', ({ paths, total, drawdown }) => {
    let start = BASE;
    const folds = paths.map((path) => { const result = evidence(path, start); start += (path.length - 1) * DAY; return result; });
    const result = calculateMetricsFromEvidence(folds, policy);
    expect(result.totalNetReturn).toEqual({ status: 'VALUE', value: total });
    expect(result.maxDrawdownPercent).toEqual({ status: 'VALUE', value: drawdown });
    expect(calculateMetricsFromEvidence([...folds].reverse(), policy)).toEqual(result);
    expect(folds[0]?.maxDrawdownPercent).toBe('10');
  });

  it('retains intraday drawdown even when daily endpoints recover', () => {
    const fold = evidence(['100', '100'], BASE);
    const withIntradayPath = { ...fold, equityPath: [{ eventTimeMs: BASE, equity: '100' }, { eventTimeMs: BASE + 60_000, equity: '80' }, { eventTimeMs: BASE + DAY, equity: '100' }], maxDrawdownPercent: '20', maxDrawdownAmount: '20' };
    expect(calculateMetricsFromEvidence([withIntradayPath], policy).maxDrawdownPercent).toEqual({ status: 'VALUE', value: '20' });
    expect(calculateMetricsFromEvidence([fold], policy).maxDrawdownPercent).toEqual({ status: 'VALUE', value: '0' });
  });

  it('preserves the original 0.0035% gate on continuous evidence instead of the maximum isolated fold', () => {
    const first = evidence(['10000', '10000.144', '9999.8562', '9999.8564'], BASE);
    const second = evidence(['10000', '10000.144', '9999.8562', '9999.8564'], BASE + 3 * DAY);
    expect(first.maxDrawdownPercent).toBe('0.002877958557396773');
    const aggregate = calculateMetricsFromEvidence([first, second], policy);
    expect(aggregate.maxDrawdownPercent).toEqual({ status: 'VALUE', value: '0.004313917229911889' });
    expect(metricGate('GATE-05', 'MAX_OOS_DRAWDOWN', { status: 'VALUE', value: first.maxDrawdownPercent }, '0.0035', 'MAX').status).toBe('PASS');
    expect(metricGate('GATE-05', 'MAX_OOS_DRAWDOWN', aggregate.maxDrawdownPercent, '0.0035', 'MAX').status).toBe('FAIL');
  });

  it('rejects missing, gapped, overlapping, unordered and mismatched equity paths', () => {
    const first = evidence(['100', '90'], BASE);
    const second = evidence(['100', '90'], BASE + DAY);
    for (const bad of [
      { ...first, equityPath: [] },
      { ...first, equityPath: [...first.equityPath].reverse() },
      { ...first, equityPath: [first.equityPath[0]!, first.equityPath[0]!] },
      { ...first, terminalAnalysisEquity: '80' },
    ]) expect(() => calculateMetricsFromEvidence([bad], policy)).toThrow();
    expect(() => calculateMetricsFromEvidence([first, first], policy)).toThrow();
    expect(() => calculateMetricsFromEvidence([first, evidence(['100', '90'], BASE + 2 * DAY)], policy)).toThrow();
    expect(calculateMetricsFromEvidence([first, second], policy).maxDrawdownPercent).toEqual({ status: 'VALUE', value: '19' });
  });

  it('retains no-evidence/no-trade statuses and UTC determinism', () => {
    expect(calculateMetricsFromEvidence([], policy).maxDrawdownPercent.status).toBe('INSUFFICIENT_DATA');
    const previous = process.env.TZ;
    try {
      const outputs: string[] = [];
      for (const zone of ['UTC', 'Asia/Kolkata', 'America/New_York']) {
        process.env.TZ = zone;
        const result = calculateMetricsFromEvidence([evidence(['100', '90'], BASE), evidence(['100', '90'], BASE + DAY)], policy);
        expect(result.grossTradeProfitFactor.status).toBe('UNDEFINED');
        outputs.push(sha256CanonicalJson(result));
      }
      expect(new Set(outputs).size).toBe(1);
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });

  it('rejects non-finite evidence before baseline, chronology or unavailable-metric branches can hide it', () => {
    const fold = evidence(['100', '90'], BASE);
    for (const invalid of ['NaN', 'Infinity', '-Infinity']) {
      for (const bad of [
        { ...fold, maxDrawdownPercent: invalid },
        { ...fold, dailyReturns: { status: 'VALUE' as const, value: [invalid] } },
        { ...fold, baselineEquity: '0', totalNetReturn: invalid },
        { ...fold, closedTradeGrossPnls: ['10', '-2', invalid] },
        { ...fold, equityPath: [{ ...fold.equityPath[0]!, equity: invalid }, fold.equityPath[1]!] },
      ]) expect(() => calculateMetricsFromEvidence([bad], policy)).toThrowError(expect.objectContaining({ code: 'METRIC_NUMERIC_FAILURE' }));
    }
  });
});
