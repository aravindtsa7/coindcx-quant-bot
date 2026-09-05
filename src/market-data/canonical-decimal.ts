import { Decimal } from '../core/decimal/decimal';
import { CanonicalValidationError } from './errors';

export const MAX_CANONICAL_SCALE = 18;
export const MAX_CANONICAL_PRECISION = 36;
export const MAX_CANONICAL_INTEGER_DIGITS = MAX_CANONICAL_PRECISION - MAX_CANONICAL_SCALE; // 18

/**
 * Validates that a decimal string or Decimal strictly satisfies MySQL DECIMAL(36, 18) constraints:
 * - No scientific notation / exponents.
 * - Fractional scale <= 18.
 * - Total precision <= 36.
 * - Integer digits <= 18.
 */
export function validateCanonicalDecimalExactness(raw: string | Decimal): {
  normalizedString: string;
  scale: number;
  precision: number;
} {
  let str: string;
  if (typeof raw === 'string') {
    str = raw.trim();
  } else if (raw instanceof Decimal) {
    str = raw.toFixed();
  } else {
    throw new CanonicalValidationError(`Invalid decimal input type: ${typeof raw}`);
  }

  if (!str || str === '') {
    throw new CanonicalValidationError('Decimal string cannot be empty');
  }

  // Reject scientific notation (e.g. 1e-5, 1E+10)
  if (/[eE]/.test(str)) {
    throw new CanonicalValidationError(`Scientific notation is forbidden for canonical financial decimals: ${str}`);
  }

  // Regex pattern for valid fixed-point decimal
  const match = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(str);
  if (!match) {
    throw new CanonicalValidationError(`Malformed decimal string: ${str}`);
  }

  const sign = match[1] ?? '';
  const integerPart = match[2] ?? '0';
  const fractionalPart = match[3] ?? '';

  // Check fractional scale
  const scale = fractionalPart.length;
  if (scale > MAX_CANONICAL_SCALE) {
    throw new CanonicalValidationError(
      `Scale exceeds maximum supported ${MAX_CANONICAL_SCALE} digits: scale=${scale} in ${str}`
    );
  }

  // Significant integer digits (strip leading zeros except when integer is solely "0")
  const strippedInt = integerPart.replace(/^0+(?!$)/, '');
  const integerDigits = strippedInt === '0' ? (scale > 0 ? 0 : 1) : strippedInt.length;
  const totalPrecision = integerDigits + scale;

  if (integerDigits > MAX_CANONICAL_INTEGER_DIGITS) {
    throw new CanonicalValidationError(
      `Integer digits exceed maximum supported ${MAX_CANONICAL_INTEGER_DIGITS} digits: integerDigits=${integerDigits} in ${str}`
    );
  }

  if (totalPrecision > MAX_CANONICAL_PRECISION) {
    throw new CanonicalValidationError(
      `Precision exceeds maximum supported ${MAX_CANONICAL_PRECISION} digits: totalPrecision=${totalPrecision} in ${str}`
    );
  }

  // Canonical normalized string representation (preserve sign if negative, or strip redundant +)
  const normalizedSign = sign === '-' ? '-' : '';
  const normalizedString = fractionalPart.length > 0
    ? `${normalizedSign}${strippedInt}.${fractionalPart}`
    : `${normalizedSign}${strippedInt}`;

  return {
    normalizedString,
    scale,
    precision: totalPrecision,
  };
}

/**
 * Immutable Canonical Decimal representation for finalized canonical market data.
 * - Structurally immutable: backed by primitive string, instance is frozen.
 * - Deep immutability: avoids exposing mutable Decimal internal arrays/properties.
 * - Exact precision & scale enforcement: strictly fits MySQL DECIMAL(36, 18).
 */
export class CanonicalDecimal {
  readonly #value: string;

  constructor(input: string | Decimal | CanonicalDecimal) {
    if (input instanceof CanonicalDecimal) {
      this.#value = input.value;
      Object.freeze(this);
      return;
    }

    const { normalizedString } = validateCanonicalDecimalExactness(input);
    this.#value = normalizedString;
    Object.freeze(this);
  }

  public get value(): string {
    return this.#value;
  }

  public toDecimal(): Decimal {
    return new Decimal(this.#value);
  }

  public toString(): string {
    return this.#value;
  }

  public toJSON(): string {
    return this.#value;
  }

  public isNegative(): boolean {
    return this.#value.startsWith('-');
  }

  public isZero(): boolean {
    return new Decimal(this.#value).isZero();
  }

  public equals(other: CanonicalDecimal | null | undefined): boolean {
    if (!other || !(other instanceof CanonicalDecimal)) {
      return false;
    }
    if (this.#value === other.value) {
      return true;
    }
    return new Decimal(this.#value).equals(new Decimal(other.value));
  }

  public lessThan(other: CanonicalDecimal): boolean {
    return new Decimal(this.#value).lessThan(new Decimal(other.value));
  }

  public greaterThan(other: CanonicalDecimal): boolean {
    return new Decimal(this.#value).greaterThan(new Decimal(other.value));
  }

  public static from(input: CanonicalDecimal | Decimal | string): CanonicalDecimal {
    if (input instanceof CanonicalDecimal) {
      return input;
    }
    return new CanonicalDecimal(input);
  }

  public static fromNullable(
    input: CanonicalDecimal | Decimal | string | null | undefined
  ): CanonicalDecimal | null {
    if (input === null || input === undefined) {
      return null;
    }
    return CanonicalDecimal.from(input);
  }
}
