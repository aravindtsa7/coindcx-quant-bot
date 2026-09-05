import Decimal from 'decimal.js';
import { CanonicalValidationError } from '../errors';

export const MAX_DERIVED_SCALE = 18;
export const MAX_DERIVED_INTEGER_DIGITS = 30;
export const MAX_DERIVED_PRECISION = 48;

export const AggregationDecimal = Decimal.clone({
  precision: 64,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});

function validate(input: string): string {
  const value = input.trim();
  if (!value || /[eE]/.test(value)) throw new CanonicalValidationError(`Invalid derived aggregate decimal: ${input}`);
  const match = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new CanonicalValidationError(`Malformed derived aggregate decimal: ${input}`);
  if (match[1] === '-') throw new CanonicalValidationError('Derived aggregate volume cannot be negative');
  const integerPart = (match[2] ?? '0').replace(/^0+(?!$)/, '');
  const fraction = match[3] ?? '';
  const integerDigits = integerPart === '0' ? (fraction ? 0 : 1) : integerPart.length;
  const precision = integerDigits + fraction.length;
  if (fraction.length > MAX_DERIVED_SCALE || integerDigits > MAX_DERIVED_INTEGER_DIGITS || precision > MAX_DERIVED_PRECISION) {
    throw new CanonicalValidationError(`Derived aggregate decimal exceeds exact bounds: ${input}`);
  }
  return fraction ? `${integerPart}.${fraction}` : integerPart;
}

export class DerivedAggregateDecimal {
  readonly #value: string;

  constructor(input: string | DerivedAggregateDecimal) {
    this.#value = input instanceof DerivedAggregateDecimal ? input.value : validate(input);
    Object.freeze(this);
  }

  public get value(): string { return this.#value; }
  public toString(): string { return this.#value; }
  public toJSON(): string { return this.#value; }
  public equals(other: DerivedAggregateDecimal | null | undefined): boolean {
    return other instanceof DerivedAggregateDecimal && new AggregationDecimal(this.#value).equals(other.value);
  }
  public static from(input: string | DerivedAggregateDecimal): DerivedAggregateDecimal {
    return input instanceof DerivedAggregateDecimal ? input : new DerivedAggregateDecimal(input);
  }
}
