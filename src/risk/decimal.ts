import Decimal from 'decimal.js';
import { riskSourceInvalid } from './errors';

const RiskCalcDecimal = Decimal.clone({
  precision: 128,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -1000,
  toExpPos: 1000,
});
const MarginDecimal = Decimal.clone({ precision: 128, rounding: Decimal.ROUND_CEIL, toExpNeg: -1000, toExpPos: 1000 });
// Decimal.clone shares the library prototype by default; isolate that alias too.
const isolatedPrototype = (): Decimal => {
  const copy = Object.fromEntries(Object.entries(RiskCalcDecimal.prototype).filter(([key]) => key !== 'constructor')) as unknown as Decimal;
  return Object.freeze(copy);
};
RiskCalcDecimal.prototype = isolatedPrototype();
MarginDecimal.prototype = isolatedPrototype();
// Neither the clone nor its instances escape this module. Decimal instances expose
// their constructor, so returning a raw instance would leak mutable configuration.
type Operand = RiskCalc | string | number;
function unwrap(value: Operand): string { return value instanceof RiskValue ? value.toFixed() : String(value); }

// Exact fixed-point addition: align integer coefficients before adding. This is
// an exact intermediate representation, not a larger floating Decimal context.
function exactSum(left: string, right: string): string {
  const parts = (value: string): readonly [string, number] => {
    const [integer = '0', fraction = ''] = value.split('.');
    return [integer + fraction, fraction.length];
  };
  const [a, as] = parts(left); const [b, bs] = parts(right);
  const scale = as > bs ? as : bs;
  const coefficient = BigInt(a) * 10n ** BigInt(scale - as) + BigInt(b) * 10n ** BigInt(scale - bs);
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  return `${negative ? '-' : ''}${scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`}`;
}

class RiskValue {
  readonly #value: Decimal;
  constructor(value: string) { this.#value = new RiskCalcDecimal(value); Object.freeze(this); }
  plus(value: Operand): RiskCalc { return riskDecimal(exactSum(this.toFixed(), unwrap(value))); }
  minus(value: Operand): RiskCalc { return this.plus(riskDecimal(unwrap(value)).negated()); }
  mul(value: Operand): RiskCalc { return riskDecimal(this.#value.mul(unwrap(value)).toFixed()); }
  div(value: Operand): RiskCalc { return riskDecimal(this.#value.div(unwrap(value)).toFixed()); }
  divUp(value: Operand): RiskCalc { return riskDecimal(new MarginDecimal(this.toFixed()).div(unwrap(value)).toFixed()); }
  mod(value: Operand): RiskCalc { return riskDecimal(this.#value.mod(unwrap(value)).toFixed()); }
  floor(): RiskCalc { return riskDecimal(this.#value.floor().toFixed()); }
  abs(): RiskCalc { return riskDecimal(this.#value.abs().toFixed()); }
  negated(): RiskCalc { return riskDecimal(this.#value.negated().toFixed()); }
  toDecimalPlaces(scale: number): RiskCalc { return riskDecimal(this.#value.toDecimalPlaces(scale).toFixed()); }
  toFixed(): string { return this.#value.toFixed(); }
  sd(): number { return this.#value.sd(); }
  cmp(value: Operand): number { return this.#value.cmp(unwrap(value)); }
  eq(value: Operand): boolean { return this.cmp(value) === 0; }
  lt(value: Operand): boolean { return this.cmp(value) < 0; }
  lte(value: Operand): boolean { return this.cmp(value) <= 0; }
  gt(value: Operand): boolean { return this.cmp(value) > 0; }
  gte(value: Operand): boolean { return this.cmp(value) >= 0; }
  isZero(): boolean { return this.#value.isZero(); }
  isNegative(): boolean { return this.#value.isNegative(); }
  isFinite(): boolean { return this.#value.isFinite(); }
  isNaN(): boolean { return this.#value.isNaN(); }
}
Object.freeze(RiskValue.prototype);
Object.freeze(RiskValue);
export type RiskCalc = RiskValue;
const FIXED = /^-?[0-9]+(?:\.[0-9]+)?$/;

export function canonicalDecimalString(value: unknown, label = 'decimal'): string {
  if (typeof value !== 'string' || !FIXED.test(value)) riskSourceInvalid(`${label} must use fixed-point Decimal syntax`);
  try {
    const decimal = new RiskCalcDecimal(value);
    if (!decimal.isFinite() || decimal.isNaN()) riskSourceInvalid(`${label} must be finite`);
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [rawInteger = '0', rawFraction = ''] = unsigned.split('.');
    const integer = rawInteger.replace(/^0+(?!$)/, '') || '0';
    const fraction = rawFraction.replace(/0+$/, '');
    const zero = integer === '0' && fraction.length === 0;
    return `${negative && !zero ? '-' : ''}${integer}${fraction.length === 0 ? '' : `.${fraction}`}`;
  } catch (error) {
    if (error instanceof Error && error.name === 'RiskEngineError') throw error;
    riskSourceInvalid(`Unable to parse ${label}`, error);
  }
}

export function riskDecimal(value: string): RiskCalc { return new RiskValue(value); }
export function canonicalRiskDecimal(value: RiskCalc): string {
  if (!value.isFinite() || value.isNaN()) riskSourceInvalid('Risk calculation produced a non-finite Decimal');
  return canonicalDecimalString(value.toFixed(), 'calculated Decimal');
}
export function floorToIncrement(value: RiskCalc, increment: RiskCalc): RiskCalc {
  return floorRatioToIncrement(value, riskDecimal('1'), increment);
}

// Exact rational floor avoids rounding a quotient up across an exchange tick.
export function floorRatioToIncrement(numerator: RiskCalc, denominator: RiskCalc, increment: RiskCalc): RiskCalc {
  const parts = (value: RiskCalc): readonly [bigint, number] => {
    const [integer = '0', fraction = ''] = value.toFixed().split('.');
    return [BigInt(integer + fraction), fraction.length];
  };
  const [n, ns] = parts(numerator); const [d, ds] = parts(denominator); const [i, is] = parts(increment);
  if (d <= 0n || i <= 0n) throw new ValuationNumericContextError('Non-positive sizing denominator');
  const top = n * 10n ** BigInt(ds + is); const bottom = d * i * 10n ** BigInt(ns);
  const quotient = top / bottom - (top < 0n && top % bottom !== 0n ? 1n : 0n);
  return checkedProduct(riskDecimal(quotient.toString()), increment);
}

export class ValuationNumericContextError extends Error {}
export function assertRiskDecimalContext(...values: readonly RiskCalc[]): void {
  if (values.some((value) => value.sd() > 128)) {
    throw new ValuationNumericContextError('Decimal operand exceeds 128 significant digits');
  }
}
export function checkedProduct(...values: readonly RiskCalc[]): RiskCalc {
  assertRiskDecimalContext(...values);
  let result = riskDecimal('1');
  for (const value of values) {
    if (result.sd() + value.sd() > 128) throw new ValuationNumericContextError('Decimal product may exceed 128 significant digits');
    result = result.mul(value);
    if (!result.isFinite() || result.isNaN()) throw new ValuationNumericContextError('Decimal product is non-finite');
  }
  return result;
}
