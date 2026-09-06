import Decimal from 'decimal.js';
import { IndicatorCalcDecimal, type IndicatorCalc } from '../decimal/indicator-calc-decimal';
import { InvalidIndicatorParameterError } from '../errors';

export const MAX_INDICATOR_PERIOD = 100_000;

export function validatePeriod(period: number, name = 'period'): number {
  if (!Number.isSafeInteger(period) || period < 1 || period > MAX_INDICATOR_PERIOD) {
    throw new InvalidIndicatorParameterError(`${name} must be a safe integer from 1 to ${MAX_INDICATOR_PERIOD}`);
  }
  return period;
}

export function validateMultiplier(value: string | IndicatorCalc, name = 'multiplier'): IndicatorCalc {
  if (typeof value !== 'string' && value.constructor !== IndicatorCalcDecimal) {
    throw new InvalidIndicatorParameterError(`${name} must be a decimal-safe string or IndicatorCalcDecimal`);
  }
  if (typeof value === 'string' && !/^[+]?(?:\d+)(?:\.\d+)?$/.test(value.trim())) {
    throw new InvalidIndicatorParameterError(`${name} must use fixed-point decimal notation`);
  }
  try {
    const result = new IndicatorCalcDecimal(value);
    if (!result.isFinite() || !result.gt(0)) throw new InvalidIndicatorParameterError(`${name} must be finite and greater than zero`);
    return result;
  } catch (error) {
    if (error instanceof InvalidIndicatorParameterError) throw error;
    throw new InvalidIndicatorParameterError(`${name} is not a valid decimal`);
  }
}

export function validateSegmentCoordinates(pair: string, timeframeMinutes: number, bootstrapStartOpenTimeMs: number): void {
  if (typeof pair !== 'string' || pair.trim() === '') throw new InvalidIndicatorParameterError('pair must be a non-empty string');
  if (!Number.isSafeInteger(timeframeMinutes) || timeframeMinutes < 1) throw new InvalidIndicatorParameterError('timeframeMinutes must be a positive safe integer');
  const duration = timeframeMinutes * 60_000;
  if (!Number.isSafeInteger(duration)) throw new InvalidIndicatorParameterError('timeframe duration is unsafe');
  if (!Number.isSafeInteger(bootstrapStartOpenTimeMs) || bootstrapStartOpenTimeMs < 0 || bootstrapStartOpenTimeMs % duration !== 0) {
    throw new InvalidIndicatorParameterError('bootstrapStartOpenTimeMs must be a non-negative safe integer aligned to the timeframe bucket');
  }
}

export type DecimalRounding = Decimal.Rounding;
