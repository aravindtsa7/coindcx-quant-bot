import { BacktestCalcDecimal, type BacktestCalc } from '../../backtest/decimal';
import { freezeValidationRuntime } from './immutable';
import { calc, canonical, mean, sampleVariance } from './numeric';
import type { CanonicalValidationEvidence, MetricUndefinedReason, ValidationMetric, ValidationMetricPolicyConfig, ValidationMetrics } from './types';

const undefinedMetric = (reason: Parameters<typeof makeUndefined>[0]): ValidationMetric => makeUndefined(reason);
function makeUndefined(reason: MetricUndefinedReason): ValidationMetric {
  return freezeValidationRuntime({ status: 'UNDEFINED' as const, reason, value: null });
}
function insufficient(reason: string, count: number, required: number): ValidationMetric {
  return freezeValidationRuntime({ status: 'INSUFFICIENT_DATA' as const, reason, count, required, value: null });
}
function value(result: BacktestCalc | string): ValidationMetric { return freezeValidationRuntime({ status: 'VALUE' as const, value: typeof result === 'string' ? result : canonical(result) }); }

export function calculateTotalNetReturn(baselineEquity: string, terminalEquity: string): ValidationMetric {
  const baseline = calc(baselineEquity);
  if (baseline.isZero()) return undefinedMetric('ZERO_BASELINE_EQUITY');
  if (baseline.lessThan(0)) return undefinedMetric('NON_POSITIVE_BASELINE_EQUITY');
  return value(calc(terminalEquity).minus(baseline).div(baseline));
}

export function calculateMaxDrawdown(equities: readonly string[]): { readonly amount: ValidationMetric; readonly percent: ValidationMetric } {
  if (equities.length === 0) return freezeValidationRuntime({ amount: insufficient('NO_EQUITY_OBSERVATIONS', 0, 1), percent: insufficient('NO_EQUITY_OBSERVATIONS', 0, 1) });
  let peak = calc(equities[0] ?? '0'); let maxAmount = new BacktestCalcDecimal(0); let maxPercent = new BacktestCalcDecimal(0);
  for (const entry of equities) { const equity = calc(entry); if (equity.greaterThan(peak)) peak = equity; const amount = peak.minus(equity); if (amount.greaterThan(maxAmount)) maxAmount = amount; if (peak.greaterThan(0)) { const p = amount.div(peak).times(100); if (p.greaterThan(maxPercent)) maxPercent = p; } }
  return freezeValidationRuntime({ amount: value(maxAmount), percent: peak.lessThanOrEqualTo(0) ? undefinedMetric('ZERO_DENOMINATOR') : value(maxPercent) });
}

function dailyRate(annual: string): BacktestCalc { return calc(annual).plus(1).pow(new BacktestCalcDecimal(1).div(365)).minus(1); }

export function calculateSharpe(dailyReturns: readonly string[], policy: Pick<ValidationMetricPolicyConfig, 'annualRiskFreeRate' | 'annualizationFactor' | 'minDailyObservations'>): ValidationMetric {
  if (dailyReturns.length < policy.minDailyObservations || dailyReturns.length < 2) return insufficient('INSUFFICIENT_DAILY_OBSERVATIONS', dailyReturns.length, Math.max(policy.minDailyObservations, 2));
  const rate = dailyRate(policy.annualRiskFreeRate); const excess = dailyReturns.map((entry) => calc(entry).minus(rate)); const variance = sampleVariance(excess);
  if (variance.isZero()) return undefinedMetric('ZERO_SAMPLE_VARIANCE');
  return value(mean(excess).div(variance.sqrt()).times(new BacktestCalcDecimal(policy.annualizationFactor).sqrt()));
}

export function calculateDailySharpe(dailyReturns: readonly string[], annualRiskFreeRate: string, minimum: number): ValidationMetric {
  if (dailyReturns.length < minimum || dailyReturns.length < 2) return insufficient('INSUFFICIENT_DAILY_OBSERVATIONS', dailyReturns.length, Math.max(minimum, 2));
  const excess = dailyReturns.map((entry) => calc(entry).minus(dailyRate(annualRiskFreeRate))); const variance = sampleVariance(excess);
  return variance.isZero() ? undefinedMetric('ZERO_SAMPLE_VARIANCE') : value(mean(excess).div(variance.sqrt()));
}

export function calculateSortino(dailyReturns: readonly string[], policy: Pick<ValidationMetricPolicyConfig, 'annualSortinoTargetRate' | 'annualizationFactor' | 'minDailyObservations'>): ValidationMetric {
  if (dailyReturns.length < policy.minDailyObservations || dailyReturns.length < 2) return insufficient('INSUFFICIENT_DAILY_OBSERVATIONS', dailyReturns.length, Math.max(policy.minDailyObservations, 2));
  const target = dailyRate(policy.annualSortinoTargetRate); const returns = dailyReturns.map(calc); const downside = returns.map((entry) => BacktestCalcDecimal.min(entry.minus(target), 0));
  const semiVariance = downside.reduce((sum, entry) => sum.plus(entry.pow(2)), new BacktestCalcDecimal(0)).div(returns.length - 1);
  if (semiVariance.isZero()) return undefinedMetric('ZERO_DOWNSIDE_DEVIATION');
  return value(mean(returns).minus(target).div(semiVariance.sqrt()).times(new BacktestCalcDecimal(policy.annualizationFactor).sqrt()));
}

export function calculateProfitFactor(changes: readonly string[]): ValidationMetric {
  const values = changes.map(calc); const wins = values.filter((entry) => entry.greaterThan(0)).reduce((sum, entry) => sum.plus(entry), new BacktestCalcDecimal(0));
  const losses = values.filter((entry) => entry.lessThan(0)).reduce((sum, entry) => sum.plus(entry), new BacktestCalcDecimal(0)).abs();
  return losses.isZero() ? undefinedMetric('ZERO_LOSSES') : value(wins.div(losses));
}
export function calculateExpectancy(changes: readonly string[], minimum = 1): ValidationMetric {
  if (changes.length < minimum) return insufficient('INSUFFICIENT_OBSERVATIONS', changes.length, minimum);
  return value(mean(changes.map(calc)));
}

export function calculateMetricsFromEvidence(evidence: readonly CanonicalValidationEvidence[], policy: ValidationMetricPolicyConfig): ValidationMetrics {
  const dailyReturnFailure = evidence.map((entry) => entry.dailyReturns).find((entry) => entry.status !== 'VALUE');
  const dailyReturns = evidence.flatMap((entry) => entry.dailyReturns.status === 'VALUE' ? entry.dailyReturns.value : []); const trades = evidence.flatMap((entry) => entry.closedTradeGrossPnls);
  const dailyChanges = evidence.flatMap((entry) => entry.dailyEquities.slice(1).map((equity, index) => canonical(calc(equity.equity).minus(calc(entry.dailyEquities[index]?.equity ?? '0')))));
  const invalidBaseline = evidence.some((entry) => calc(entry.baselineEquity).lessThanOrEqualTo(0));
  const aggregateReturn = evidence.reduce((equity, item) => equity.times(calc(item.totalNetReturn).plus(1)), new BacktestCalcDecimal(1)).minus(1);
  const drawdownPercent = evidence.reduce<ValidationMetric>((current, entry) => current.status !== 'VALUE' || calc(entry.maxDrawdownPercent).greaterThan(calc(current.value)) ? value(entry.maxDrawdownPercent) : current, value('0'));
  const dailyFailureMetric = dailyReturnFailure?.status === 'UNDEFINED' ? makeUndefined(dailyReturnFailure.reason) : dailyReturnFailure?.status === 'INSUFFICIENT_DATA' ? insufficient(dailyReturnFailure.reason, dailyReturnFailure.count, dailyReturnFailure.required) : null;
  return freezeValidationRuntime({ totalNetReturn: evidence.length === 0 ? insufficient('NO_EVIDENCE', 0, 1) : invalidBaseline ? undefinedMetric('NON_POSITIVE_BASELINE_EQUITY') : value(aggregateReturn),
    maxDrawdownPercent: drawdownPercent, sharpe: dailyFailureMetric ?? calculateSharpe(dailyReturns, policy), sortino: dailyFailureMetric ?? calculateSortino(dailyReturns, policy), grossTradeProfitFactor: calculateProfitFactor(trades),
    grossTradeExpectancy: calculateExpectancy(trades), netDailyProfitFactor: calculateProfitFactor(dailyChanges), netDailyExpectancy: calculateExpectancy(dailyChanges) });
}
