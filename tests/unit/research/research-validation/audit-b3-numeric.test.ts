import { describe, expect, it } from 'vitest';
import { BacktestCalcDecimal } from '../../../../src/backtest';
import { calc, canonical, mean, sampleVariance } from '../../../../src/research/research-validation/numeric';
import { metricGate } from '../../../../src/research/research-validation/gates';
import { calculateProfitFactor, calculateMaxDrawdown, calculateExpectancy, calculateSharpe, calculateSortino, calculateTotalNetReturn } from '../../../../src/research/research-validation/metrics';
import { runMonteCarlo } from '../../../../src/research/research-validation/monte-carlo';
import { calculateDeflatedSharpeAnalysis } from '../../../../src/research/research-validation/deflated-sharpe';

const monteCarlo = { policyId: 'P12_MONTE_CARLO_PERMUTATION_V1', simulationCount: 10, adversePercentile: 95, seedDerivationPolicy: 'HMAC_SHA256_V1' } as const;
const bad = ['NaN', '+NaN', 'Infinity', '+Infinity', '-Infinity', '1e999999', '1e-', '1e-18', 'garbage', '', '   ', undefined, null] as const;

describe('Audit B3 finite research evidence', () => {
  it.each(bad)('rejects %s at every approval-relevant numeric boundary', (input) => {
    const invalid = input as string;
    for (const operation of [
      () => calc(invalid),
      () => metricGate('test', 'metric', { status: 'VALUE', value: invalid }, '1', 'MIN'),
      () => metricGate('test', 'threshold', { status: 'VALUE', value: '1' }, invalid, 'MAX'),
      () => calculateProfitFactor(['10', '-2', invalid]),
      () => calculateMaxDrawdown(['100', invalid, '90']),
      () => calculateExpectancy(['1', invalid]),
      () => calculateTotalNetReturn('0', invalid),
      () => calculateSharpe(['0.01', invalid], { annualRiskFreeRate: '0', annualizationFactor: 365, minDailyObservations: 2 }),
      () => calculateSortino(['0.01', invalid], { annualSortinoTargetRate: '0', annualizationFactor: 365, minDailyObservations: 2 }),
      () => runMonteCarlo('a'.repeat(64), 'b'.repeat(64), [invalid], monteCarlo),
      () => runMonteCarlo('a'.repeat(64), 'b'.repeat(64), ['-1', invalid], monteCarlo),
      () => calculateDeflatedSharpeAnalysis(['0.01', invalid], [['0.01', '0.02']], '0', 2),
      () => calculateDeflatedSharpeAnalysis(['0.01', '0.02'], [[invalid]], '0', 2),
    ]) expect(operation).toThrowError(expect.objectContaining({ code: 'METRIC_NUMERIC_FAILURE' }));
  });

  it.each(['0', '-0', '1', '-1', '0.000000000000000001', '999999999999999999999999999999.999999999999999999'])('accepts exact finite fixed-point %s', (input) => {
    expect(canonical(calc(input))).toBe(input === '-0' ? '0' : input);
  });

  it('rejects non-finite intermediate calculations without converting them to zero', () => {
    for (const input of ['NaN', 'Infinity', '-Infinity']) {
      const invalid = new BacktestCalcDecimal(input);
      expect(() => canonical(invalid)).toThrow();
      expect(() => mean([calc('1'), invalid])).toThrow();
      expect(() => sampleVariance([calc('1'), invalid])).toThrow();
    }
    expect(() => canonical(calc('1').div(0))).toThrow();
  });

  it('retains exact threshold equality and a one-unit decision on either side', () => {
    const gate = (value: string) => metricGate('GATE-05', 'MAX_OOS_DRAWDOWN', { status: 'VALUE', value }, '0.0035', 'MAX').status;
    expect(gate('0.003499999999999999')).toBe('PASS');
    expect(gate('0.0035')).toBe('PASS');
    expect(gate('0.003500000000000001')).toBe('FAIL');
  });

  it('preserves empty, zero-loss and zero-variance statuses and deterministic Monte Carlo outputs', () => {
    expect(calculateProfitFactor(['1', '0'])).toMatchObject({ status: 'UNDEFINED', reason: 'ZERO_LOSSES' });
    expect(calculateMaxDrawdown([]).percent.status).toBe('INSUFFICIENT_DATA');
    expect(runMonteCarlo('a', 'b', [], monteCarlo).status).toBe('INSUFFICIENT_DATA');
    expect(calculateDeflatedSharpeAnalysis(['0', '0'], [['0', '0']], '0', 2).deflatedSharpeZ.status).not.toBe('VALUE');
    expect(runMonteCarlo('a', 'b', ['0.1', '-0.2', '0'], monteCarlo)).toEqual(runMonteCarlo('a', 'b', ['0.1', '-0.2', '0'], monteCarlo));
    expect(() => runMonteCarlo('a', 'b', ['0'], { ...monteCarlo, simulationCount: Infinity })).toThrow();
  });
});
