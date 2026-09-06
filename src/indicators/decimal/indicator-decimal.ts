import Decimal from 'decimal.js';
import { IndicatorNumericFailureError, IndicatorOverflowError } from '../errors';
import { IndicatorCalc, IndicatorCalcDecimal, toIndicatorCalcDecimal } from './indicator-calc-decimal';

export const MAX_INDICATOR_SCALE = 18;
export const MAX_INDICATOR_INTEGER_DIGITS = 30;
export const MAX_INDICATOR_PRECISION = 48;

export class IndicatorDecimal {
  readonly #value: string;

  public constructor(input: string | IndicatorCalc) {
    const raw = toIndicatorCalcDecimal(input);
    if (!raw.isFinite()) throw new IndicatorNumericFailureError('Indicator output must be finite');
    const rounded = raw.toDecimalPlaces(MAX_INDICATOR_SCALE, Decimal.ROUND_HALF_UP);
    if (!rounded.isFinite()) throw new IndicatorNumericFailureError('Indicator output quantization was non-finite');
    if (rounded.isZero()) {
      this.#value = '0';
      Object.freeze(this);
      return;
    }
    const fixed = rounded.toFixed();
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(fixed);
    if (!match) throw new IndicatorNumericFailureError(`Invalid fixed-point indicator output: ${fixed}`);
    const integerPart = (match[2] ?? '0').replace(/^0+(?!$)/, '');
    const fractionalPart = (match[3] ?? '').replace(/0+$/, '');
    const integerDigits = integerPart === '0' ? 0 : integerPart.length;
    const precision = integerDigits + fractionalPart.length;
    if (integerDigits > MAX_INDICATOR_INTEGER_DIGITS || precision > MAX_INDICATOR_PRECISION) {
      throw new IndicatorOverflowError(`Indicator output exceeds DECIMAL(48,18) bounds: ${fixed}`);
    }
    this.#value = `${match[1] ?? ''}${integerPart}${fractionalPart ? `.${fractionalPart}` : ''}`;
    Object.freeze(this);
  }

  public static from(input: string | IndicatorCalc): IndicatorDecimal { return new IndicatorDecimal(input); }
  public get value(): string { return this.#value; }
  public toString(): string { return this.#value; }
  public toJSON(): string { return this.#value; }
  public equals(other: IndicatorDecimal | null | undefined): boolean {
    return other instanceof IndicatorDecimal && this.#value === other.value;
  }
  public toCalculationDecimal(): IndicatorCalc { return new IndicatorCalcDecimal(this.#value); }
}
