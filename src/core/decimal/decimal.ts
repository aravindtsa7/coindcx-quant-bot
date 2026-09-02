import { Decimal } from 'decimal.js';

// Configure high precision for quant calculations (30 digits, ROUND_HALF_UP)
Decimal.set({
  precision: 30,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 30,
});

export type DecimalValue = Decimal.Value;

/**
 * Creates a Decimal instance safely from string, number, or another Decimal.
 * Strings are preferred to avoid initial floating point representation error.
 */
export function toDecimal(value: DecimalValue): Decimal {
  if (value instanceof Decimal) {
    return value;
  }
  return new Decimal(value);
}

/**
 * Returns a Decimal representing zero.
 */
export function zeroDecimal(): Decimal {
  return new Decimal(0);
}

/**
 * Returns a Decimal representing one.
 */
export function oneDecimal(): Decimal {
  return new Decimal(1);
}

/**
 * Decimal-safe addition: a + b
 */
export function add(a: DecimalValue, b: DecimalValue): Decimal {
  return toDecimal(a).plus(toDecimal(b));
}

/**
 * Decimal-safe subtraction: a - b
 */
export function sub(a: DecimalValue, b: DecimalValue): Decimal {
  return toDecimal(a).minus(toDecimal(b));
}

/**
 * Decimal-safe multiplication: a * b
 */
export function mul(a: DecimalValue, b: DecimalValue): Decimal {
  return toDecimal(a).times(toDecimal(b));
}

/**
 * Decimal-safe division: a / b
 * Throws an Error if denominator is zero.
 */
export function div(a: DecimalValue, b: DecimalValue): Decimal {
  const bDec = toDecimal(b);
  if (bDec.isZero()) {
    throw new Error('Division by zero in decimal calculation');
  }
  return toDecimal(a).dividedBy(bDec);
}

/**
 * Decimal-safe equality: a === b
 */
export function eq(a: DecimalValue, b: DecimalValue): boolean {
  return toDecimal(a).equals(toDecimal(b));
}

/**
 * Decimal-safe greater than: a > b
 */
export function gt(a: DecimalValue, b: DecimalValue): boolean {
  return toDecimal(a).greaterThan(toDecimal(b));
}

/**
 * Decimal-safe greater than or equal: a >= b
 */
export function gte(a: DecimalValue, b: DecimalValue): boolean {
  return toDecimal(a).greaterThanOrEqualTo(toDecimal(b));
}

/**
 * Decimal-safe less than: a < b
 */
export function lt(a: DecimalValue, b: DecimalValue): boolean {
  return toDecimal(a).lessThan(toDecimal(b));
}

/**
 * Decimal-safe less than or equal: a <= b
 */
export function lte(a: DecimalValue, b: DecimalValue): boolean {
  return toDecimal(a).lessThanOrEqualTo(toDecimal(b));
}

/**
 * Round a decimal to a specified number of decimal places.
 */
export function roundTo(
  value: DecimalValue,
  decimalPlaces: number,
  roundingMode: Decimal.Rounding = Decimal.ROUND_HALF_UP
): Decimal {
  return toDecimal(value).toDecimalPlaces(decimalPlaces, roundingMode);
}

/**
 * Format a decimal to a fixed decimal place string representation.
 */
export function toFixedString(value: DecimalValue, decimalPlaces: number): string {
  return toDecimal(value).toFixed(decimalPlaces);
}

/**
 * Minimum of two or more decimal values.
 */
export function minDecimal(...values: DecimalValue[]): Decimal {
  if (values.length === 0) {
    throw new Error('minDecimal requires at least one value');
  }
  const first = values[0];
  if (first === undefined) {
    throw new Error('minDecimal value is undefined');
  }
  let currentMin = toDecimal(first);
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (v !== undefined) {
      const dec = toDecimal(v);
      if (dec.lt(currentMin)) {
        currentMin = dec;
      }
    }
  }
  return currentMin;
}

/**
 * Maximum of two or more decimal values.
 */
export function maxDecimal(...values: DecimalValue[]): Decimal {
  if (values.length === 0) {
    throw new Error('maxDecimal requires at least one value');
  }
  const first = values[0];
  if (first === undefined) {
    throw new Error('maxDecimal value is undefined');
  }
  let currentMax = toDecimal(first);
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (v !== undefined) {
      const dec = toDecimal(v);
      if (dec.gt(currentMax)) {
        currentMax = dec;
      }
    }
  }
  return currentMax;
}

export { Decimal };
