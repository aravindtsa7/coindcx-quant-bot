import { BacktestCalcDecimal, BacktestDecimal, type BacktestCalc } from '../../backtest/decimal';
import { ResearchValidationError } from './errors';

export function calc(value: unknown): BacktestCalc {
  try {
    if (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value)) throw new Error('Expected a fixed-point decimal string');
    return finite(new BacktestCalcDecimal(value));
  }
  catch (error) { throw new ResearchValidationError('METRIC_NUMERIC_FAILURE', 'Invalid validation decimal', { cause: error }); }
}
export function finite(value: BacktestCalc): BacktestCalc {
  if (!value.isFinite() || value.isNaN()) throw new ResearchValidationError('METRIC_NUMERIC_FAILURE', 'Validation calculation produced a non-finite value');
  return value;
}
export function canonical(value: BacktestCalc): string {
  try { return new BacktestDecimal(finite(value)).value; }
  catch (error) { throw new ResearchValidationError('METRIC_NUMERIC_FAILURE', 'Validation result is outside the finite decimal contract', { cause: error }); }
}
export function mean(values: readonly BacktestCalc[]): BacktestCalc {
  if (values.length === 0) throw new ResearchValidationError('METRIC_NUMERIC_FAILURE', 'Mean requires at least one value');
  return finite(values.reduce((sum, value) => sum.plus(finite(value)), new BacktestCalcDecimal(0)).div(values.length));
}
export function sampleVariance(values: readonly BacktestCalc[]): BacktestCalc {
  if (values.length < 2) throw new ResearchValidationError('METRIC_NUMERIC_FAILURE', 'Sample variance requires two observations');
  const average = mean(values);
  return finite(values.reduce((sum, value) => sum.plus(value.minus(average).pow(2)), new BacktestCalcDecimal(0)).div(values.length - 1));
}
