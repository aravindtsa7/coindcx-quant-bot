import { BacktestCalcDecimal } from '../../backtest/decimal';
import { freezeValidationRuntime } from './immutable';
import { calc, canonical, mean, sampleVariance } from './numeric';
import type { ValidationMetric } from './types';

const undefinedMetric = (reason: 'ZERO_SAMPLE_VARIANCE' | 'DSR_ESTIMATOR_VARIANCE_INVALID' | 'ZERO_DSR_ESTIMATOR_DEVIATION'): ValidationMetric => freezeValidationRuntime({ status: 'UNDEFINED', reason, value: null });
export interface DeflatedSharpeAnalysis { readonly sr0: ValidationMetric; readonly deflatedSharpeZ: ValidationMetric }
function unavailableAnalysis(metric: ValidationMetric): DeflatedSharpeAnalysis { return freezeValidationRuntime({ sr0: metric, deflatedSharpeZ: metric }); }
export function calculateDeflatedSharpeAnalysis(candidateReturns: readonly string[], familyReturns: readonly (readonly string[])[], annualRiskFreeRate: string, minDailyObservations: number): DeflatedSharpeAnalysis {
  if (candidateReturns.length < minDailyObservations || candidateReturns.length < 2) return unavailableAnalysis(freezeValidationRuntime({ status: 'INSUFFICIENT_DATA', reason: 'INSUFFICIENT_DSR_OBSERVATIONS', count: candidateReturns.length, required: Math.max(minDailyObservations, 2), value: null }));
  const dailyRate = calc(annualRiskFreeRate).plus(1).pow(new BacktestCalcDecimal(1).div(365)).minus(1);
  const familyValues = familyReturns.map((returns) => {
    if (returns.length < minDailyObservations || returns.length < 2) return null;
    const excess = returns.map((entry) => calc(entry).minus(dailyRate)); const variance = sampleVariance(excess);
    return variance.isZero() ? null : mean(excess).div(variance.sqrt());
  });
  if (familyValues.some((entry) => entry === null)) return unavailableAnalysis(freezeValidationRuntime({ status: 'INSUFFICIENT_DATA', reason: 'INCOMPLETE_DSR_TRIAL_FAMILY', count: familyValues.filter((entry) => entry !== null).length, required: familyReturns.length, value: null }));
  const observations = candidateReturns.map((entry) => calc(entry).minus(dailyRate));
  const average = mean(observations); const sample = sampleVariance(observations); if (sample.isZero()) return unavailableAnalysis(undefinedMetric('ZERO_SAMPLE_VARIANCE'));
  const srHat = average.div(sample.sqrt()); const centered = observations.map((entry) => entry.minus(average)); const m2 = centered.reduce((sum, item) => sum.plus(item.pow(2)), new BacktestCalcDecimal(0)).div(observations.length);
  if (m2.isZero()) return unavailableAnalysis(undefinedMetric('ZERO_SAMPLE_VARIANCE'));
  const m3 = centered.reduce((sum, item) => sum.plus(item.pow(3)), new BacktestCalcDecimal(0)).div(observations.length); const m4 = centered.reduce((sum, item) => sum.plus(item.pow(4)), new BacktestCalcDecimal(0)).div(observations.length);
  const skewness = m3.div(m2.pow(new BacktestCalcDecimal('1.5'))); const kurtosis = m4.div(m2.pow(2));
  let sr0 = new BacktestCalcDecimal(0); const completeFamilyValues = familyValues as readonly InstanceType<typeof BacktestCalcDecimal>[];
  if (completeFamilyValues.length > 1) { const dispersion = sampleVariance(completeFamilyValues).sqrt(); if (!dispersion.isZero()) { const logM = new BacktestCalcDecimal(completeFamilyValues.length).ln(); const adjustment = new BacktestCalcDecimal(1).minus(new BacktestCalcDecimal('0.5772156649').plus(logM.ln()).div(logM.times(2))); sr0 = logM.times(2).sqrt().times(dispersion).times(adjustment); } }
  const numerator = new BacktestCalcDecimal(1).minus(skewness.times(srHat)).plus(kurtosis.minus(1).div(4).times(srHat.pow(2)));
  if (numerator.lessThanOrEqualTo(0)) return freezeValidationRuntime({ sr0: { status: 'VALUE', value: canonical(sr0) }, deflatedSharpeZ: undefinedMetric('DSR_ESTIMATOR_VARIANCE_INVALID') });
  const deviation = numerator.div(observations.length - 1).sqrt(); if (deviation.isZero()) return freezeValidationRuntime({ sr0: { status: 'VALUE', value: canonical(sr0) }, deflatedSharpeZ: undefinedMetric('ZERO_DSR_ESTIMATOR_DEVIATION') });
  return freezeValidationRuntime({ sr0: { status: 'VALUE', value: canonical(sr0) }, deflatedSharpeZ: { status: 'VALUE', value: canonical(srHat.minus(sr0).div(deviation)) } });
}
export function calculateDeflatedSharpeZ(candidateReturns: readonly string[], familyReturns: readonly (readonly string[])[], annualRiskFreeRate: string, minDailyObservations: number): ValidationMetric {
  return calculateDeflatedSharpeAnalysis(candidateReturns, familyReturns, annualRiskFreeRate, minDailyObservations).deflatedSharpeZ;
}
