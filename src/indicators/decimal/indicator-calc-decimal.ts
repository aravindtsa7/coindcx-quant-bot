import Decimal from 'decimal.js';
import { IndicatorNumericFailureError } from '../errors';

export const IndicatorCalcDecimal = Decimal.clone({
  precision: 128,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -160,
  toExpPos: 160,
});

export type IndicatorCalc = InstanceType<typeof IndicatorCalcDecimal>;
export type IndicatorCalcInput = string | IndicatorCalc;

export function toIndicatorCalcDecimal(value: string | IndicatorCalc): IndicatorCalc {
  try {
    const result = new IndicatorCalcDecimal(value);
    if (!result.isFinite()) throw new IndicatorNumericFailureError('Indicator value must be finite');
    return result;
  } catch (error) {
    if (error instanceof IndicatorNumericFailureError) throw error;
    throw new IndicatorNumericFailureError('Unable to construct indicator decimal', { cause: error });
  }
}

export const INDICATOR_ZERO = Object.freeze(new IndicatorCalcDecimal(0));
export const INDICATOR_ONE = Object.freeze(new IndicatorCalcDecimal(1));
