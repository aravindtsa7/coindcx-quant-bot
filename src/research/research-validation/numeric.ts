import { BacktestCalcDecimal, BacktestDecimal, type BacktestCalc } from '../../backtest/decimal';
import { ResearchValidationError } from './errors';

export function calc(value: string): BacktestCalc {
  try { return new BacktestCalcDecimal(value); }
  catch (error) { throw new ResearchValidationError('METRIC_NUMERIC_FAILURE', 'Invalid validation decimal', { cause: error }); }
}
export function canonical(value: BacktestCalc): string {
  if (!value.isFinite() || value.isNaN()) throw new ResearchValidationError('METRIC_NUMERIC_FAILURE', 'Validation calculation produced a non-finite value');
  return new BacktestDecimal(value).value;
}
export function mean(values: readonly BacktestCalc[]): BacktestCalc {
  if (values.length === 0) throw new ResearchValidationError('METRIC_NUMERIC_FAILURE', 'Mean requires at least one value');
  return values.reduce((sum, value) => sum.plus(value), new BacktestCalcDecimal(0)).div(values.length);
}
export function sampleVariance(values: readonly BacktestCalc[]): BacktestCalc {
  if (values.length < 2) throw new ResearchValidationError('METRIC_NUMERIC_FAILURE', 'Sample variance requires two observations');
  const average = mean(values);
  return values.reduce((sum, value) => sum.plus(value.minus(average).pow(2)), new BacktestCalcDecimal(0)).div(values.length - 1);
}
