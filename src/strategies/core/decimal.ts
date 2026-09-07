import Decimal from 'decimal.js';
import { StrategyError, strategyParameterError } from './errors';

export const StrategyCalcDecimal = Decimal.clone({
  precision: 128,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -160,
  toExpPos: 160,
});

export type StrategyCalc = InstanceType<typeof StrategyCalcDecimal>;

const DECIMAL_SYNTAX = /^-?[0-9]+(?:\.[0-9]+)?$/;

export function normalizeCanonicalDecimalString(value: unknown, label = 'decimal parameter'): string {
  if (typeof value !== 'string' || !DECIMAL_SYNTAX.test(value)) {
    throw strategyParameterError(`${label} must use exact fixed-point decimal string syntax`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [rawInteger = '', rawFraction = ''] = unsigned.split('.');
  const integer = rawInteger.replace(/^0+(?!$)/, '') || '0';
  const fraction = rawFraction.replace(/0+$/, '');
  const zero = integer === '0' && fraction.length === 0;
  return `${negative && !zero ? '-' : ''}${integer}${fraction.length === 0 ? '' : `.${fraction}`}`;
}

export function toStrategyCalc(value: string, label = 'strategy numeric value'): StrategyCalc {
  try {
    if (!DECIMAL_SYNTAX.test(value)) {
      throw new StrategyError('STRATEGY_NUMERIC_FAILURE', `${label} must use fixed-point decimal syntax`);
    }
    const result = new StrategyCalcDecimal(value);
    if (!result.isFinite() || result.isNaN()) {
      throw new StrategyError('STRATEGY_NUMERIC_FAILURE', `${label} must be finite`);
    }
    return result;
  } catch (error) {
    if (error instanceof StrategyError) throw error;
    throw new StrategyError('STRATEGY_NUMERIC_FAILURE', `Unable to construct ${label}`, { cause: error });
  }
}

export function canonicalStrategyCalc(value: StrategyCalc, label = 'strategy numeric result'): string {
  if (!value.isFinite() || value.isNaN()) {
    throw new StrategyError('STRATEGY_NUMERIC_FAILURE', `${label} must be finite`);
  }
  try {
    return normalizeCanonicalDecimalString(value.toFixed(), label);
  } catch (error) {
    throw new StrategyError('STRATEGY_NUMERIC_FAILURE', `Unable to canonicalize ${label}`, { cause: error });
  }
}
