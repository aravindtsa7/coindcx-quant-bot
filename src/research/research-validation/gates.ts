import { freezeValidationRuntime } from './immutable';
import { calc, canonical } from './numeric';
import type { ValidationApprovalThresholds, ValidationGateEvaluation, ValidationMetric, ValidationMetrics } from './types';

export function metricGate(gateId: string, gateName: string, metric: ValidationMetric, threshold: string, direction: 'MIN' | 'MAX'): ValidationGateEvaluation {
  if (metric.status !== 'VALUE') return freezeValidationRuntime({ gateId, gateName, status: 'UNAVAILABLE', observedValue: null, thresholdValue: threshold, reason: metric.reason });
  const passes = direction === 'MIN' ? calc(metric.value).greaterThanOrEqualTo(calc(threshold)) : calc(metric.value).lessThanOrEqualTo(calc(threshold));
  return freezeValidationRuntime({ gateId, gateName, status: passes ? 'PASS' : 'FAIL', observedValue: metric.value, thresholdValue: threshold });
}
export function evaluateFoldLocalGates(metrics: ValidationMetrics, totalClosedTrades: number, dailyCount: number, thresholds: ValidationApprovalThresholds): readonly ValidationGateEvaluation[] {
  return freezeValidationRuntime([
    { gateId: 'GATE-01', gateName: 'MIN_OOS_TRADES', status: totalClosedTrades >= thresholds.minOosClosedTrades ? 'PASS' : 'FAIL', observedValue: totalClosedTrades, thresholdValue: thresholds.minOosClosedTrades },
    { gateId: 'GATE-02', gateName: 'MIN_DAILY_OBSERVATIONS', status: dailyCount >= thresholds.minDailyObservations ? 'PASS' : 'FAIL', observedValue: dailyCount, thresholdValue: thresholds.minDailyObservations },
    metricGate('GATE-03', 'MIN_OOS_SHARPE', metrics.sharpe, thresholds.minOosSharpe, 'MIN'), metricGate('GATE-04', 'MIN_OOS_SORTINO', metrics.sortino, thresholds.minOosSortino, 'MIN'),
    metricGate('GATE-05', 'MAX_OOS_DRAWDOWN', metrics.maxDrawdownPercent, thresholds.maxOosDrawdownPercent, 'MAX'), metricGate('GATE-06', 'MIN_PROFIT_FACTOR', metrics.netDailyProfitFactor, thresholds.minNetDailyProfitFactor, 'MIN'),
    metricGate('GATE-07', 'MIN_EXPECTANCY', metrics.netDailyExpectancy, thresholds.minNetDailyExpectancy, 'MIN'),
  ]);
}
export function foldVerdict(gates: readonly ValidationGateEvaluation[]): 'PASS' | 'FAIL' | 'INSUFFICIENT_EVIDENCE' { return gates.some((gate) => gate.status === 'FAIL') ? 'FAIL' : gates.some((gate) => gate.status === 'UNAVAILABLE') ? 'INSUFFICIENT_EVIDENCE' : 'PASS'; }
export function subjectVerdict(gates: readonly ValidationGateEvaluation[]): 'PASSED' | 'FAILED' | 'INSUFFICIENT_EVIDENCE' { return gates.some((gate) => gate.status === 'FAIL') ? 'FAILED' : gates.some((gate) => gate.status === 'UNAVAILABLE') ? 'INSUFFICIENT_EVIDENCE' : 'PASSED'; }
export function degradation(isSharpe: ValidationMetric, oosSharpe: ValidationMetric, denominatorFloor: string): ValidationMetric {
  if (isSharpe.status !== 'VALUE' || oosSharpe.status !== 'VALUE') return freezeValidationRuntime({ status: 'INSUFFICIENT_DATA', reason: 'FOLD_SHARPE_UNAVAILABLE', count: 0, required: 2, value: null });
  const isValue = calc(isSharpe.value); const denominator = isValue.abs().greaterThan(calc(denominatorFloor)) ? isValue.abs() : calc(denominatorFloor);
  return freezeValidationRuntime({ status: 'VALUE', value: canonical(isValue.minus(calc(oosSharpe.value)).div(denominator)) });
}
