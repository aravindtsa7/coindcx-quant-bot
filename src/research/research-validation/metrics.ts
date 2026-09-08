import { BacktestCalcDecimal, type BacktestCalc } from '../../backtest/decimal';
import { freezeValidationRuntime } from './immutable';
import { calc, canonical, finite, mean, sampleVariance } from './numeric';
import { ResearchValidationError } from './errors';
import type { CanonicalValidationEvidence, MetricUndefinedReason, ValidationMetric, ValidationMetricPolicyConfig, ValidationMetrics } from './types';

const undefinedMetric = (reason: Parameters<typeof makeUndefined>[0]): ValidationMetric => makeUndefined(reason);
function makeUndefined(reason: MetricUndefinedReason): ValidationMetric {
  return freezeValidationRuntime({ status: 'UNDEFINED' as const, reason, value: null });
}
function insufficient(reason: string, count: number, required: number): ValidationMetric {
  return freezeValidationRuntime({ status: 'INSUFFICIENT_DATA' as const, reason, count, required, value: null });
}
function value(result: BacktestCalc | string): ValidationMetric { return freezeValidationRuntime({ status: 'VALUE' as const, value: canonical(typeof result === 'string' ? calc(result) : result) }); }

export function calculateTotalNetReturn(baselineEquity: string, terminalEquity: string): ValidationMetric {
  const baseline = calc(baselineEquity); const terminal = calc(terminalEquity);
  if (baseline.isZero()) return undefinedMetric('ZERO_BASELINE_EQUITY');
  if (baseline.lessThan(0)) return undefinedMetric('NON_POSITIVE_BASELINE_EQUITY');
  return value(terminal.minus(baseline).div(baseline));
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
  // Validate every observation, including fields that might otherwise be skipped
  // by a comparison or unavailable-metric branch.
  for (const entry of evidence) {
    if (!Array.isArray(entry.equityPath) || entry.equityPath.length === 0) throw new ResearchValidationError('EVIDENCE_INTEGRITY_FAILURE', 'Observed equity path is missing');
    [entry.baselineEquity, entry.terminalAnalysisEquity, entry.totalNetReturn, entry.maxDrawdownAmount, entry.maxDrawdownPercent, entry.totalFees, entry.fundingPnl].forEach(calc);
    entry.dailyEquities.forEach((point) => calc(point.equity));
    entry.equityPath.forEach((point) => calc(point.equity));
    entry.closedTradeGrossPnls.forEach(calc);
    if (entry.dailyReturns.status === 'VALUE') entry.dailyReturns.value.forEach(calc);
  }
  evidence = [...evidence].sort((a, b) => a.equityPath[0]!.eventTimeMs - b.equityPath[0]!.eventTimeMs);
  const dailyReturnFailure = evidence.map((entry) => entry.dailyReturns).find((entry) => entry.status !== 'VALUE');
  const dailyReturns = evidence.flatMap((entry) => entry.dailyReturns.status === 'VALUE' ? entry.dailyReturns.value : []); const trades = evidence.flatMap((entry) => entry.closedTradeGrossPnls);
  const dailyChanges = evidence.flatMap((entry) => entry.dailyEquities.slice(1).map((equity, index) => canonical(calc(equity.equity).minus(calc(entry.dailyEquities[index]?.equity ?? '0')))));
  const invalidBaseline = evidence.some((entry) => calc(entry.baselineEquity).lessThanOrEqualTo(0));
  const aggregateReturn = evidence.reduce((equity, item) => equity.times(calc(item.totalNetReturn).plus(1)), new BacktestCalcDecimal(1)).minus(1);
  const drawdownPercent = evidence.length === 0 ? insufficient('NO_EVIDENCE', 0, 1) : invalidBaseline ? undefinedMetric('NON_POSITIVE_BASELINE_EQUITY') : chronologicalDrawdown(evidence);
  const dailyFailureMetric = dailyReturnFailure?.status === 'UNDEFINED' ? makeUndefined(dailyReturnFailure.reason) : dailyReturnFailure?.status === 'INSUFFICIENT_DATA' ? insufficient(dailyReturnFailure.reason, dailyReturnFailure.count, dailyReturnFailure.required) : null;
  return freezeValidationRuntime({ totalNetReturn: evidence.length === 0 ? insufficient('NO_EVIDENCE', 0, 1) : invalidBaseline ? undefinedMetric('NON_POSITIVE_BASELINE_EQUITY') : value(aggregateReturn),
    maxDrawdownPercent: drawdownPercent, sharpe: dailyFailureMetric ?? calculateSharpe(dailyReturns, policy), sortino: dailyFailureMetric ?? calculateSortino(dailyReturns, policy), grossTradeProfitFactor: calculateProfitFactor(trades),
    grossTradeExpectancy: calculateExpectancy(trades), netDailyProfitFactor: calculateProfitFactor(dailyChanges), netDailyExpectancy: calculateExpectancy(dailyChanges) });
}

function chronologicalDrawdown(evidence: readonly CanonicalValidationEvidence[]): ValidationMetric {
  function fail(message: string): never { throw new ResearchValidationError('EVIDENCE_INTEGRITY_FAILURE', message); }
  const ordered = [...evidence].sort((a, b) => (a.equityPath[0]?.eventTimeMs ?? 0) - (b.equityPath[0]?.eventTimeMs ?? 0));
  let priorEnd: number | null = null;
  let carriedEquity = calc('1'); let peak = carriedEquity; let maximum = calc('0');
  for (const entry of ordered) {
    const first = entry.equityPath[0]; const last = entry.equityPath[entry.equityPath.length - 1];
    if (!first || !last || entry.equityPath.length < 2) fail('Chronological drawdown requires the complete observed equity path');
    if (priorEnd !== null && first.eventTimeMs !== priorEnd) fail('Aggregate equity windows must be chronological, adjacent and non-overlapping');
    if (!calc(first.equity).equals(calc(entry.baselineEquity)) || !calc(last.equity).equals(calc(entry.terminalAnalysisEquity))) fail('Equity path endpoints differ from validation evidence');
    if (first.eventTimeMs !== entry.dailyEquities[0]?.boundaryTimeMs || last.eventTimeMs !== entry.dailyEquities[entry.dailyEquities.length - 1]?.boundaryTimeMs) fail('Equity path does not cover the daily evidence window');
    const baseline = calc(entry.baselineEquity); const scale = carriedEquity.div(baseline);
    let previous: number | null = null;
    for (const point of entry.equityPath) {
      if (!Number.isSafeInteger(point.eventTimeMs) || point.eventTimeMs % 60_000 !== 0 || (previous !== null && point.eventTimeMs <= previous)) fail('Equity path timestamps are invalid or unordered');
      previous = point.eventTimeMs;
      const equity = finite(calc(point.equity).times(scale));
      if (equity.greaterThan(peak)) peak = equity;
      const drawdown = finite(peak.minus(equity).div(peak).times(100));
      if (drawdown.greaterThan(maximum)) maximum = drawdown;
      carriedEquity = equity;
    }
    priorEnd = last.eventTimeMs;
  }
  return value(maximum);
}
