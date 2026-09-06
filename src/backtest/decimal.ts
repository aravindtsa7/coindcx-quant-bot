import Decimal from 'decimal.js';
import { BacktestError } from './errors';

export const MAX_BACKTEST_SCALE = 18;
export const MAX_BACKTEST_INTEGER_DIGITS = 30;
export const MAX_BACKTEST_PRECISION = 48;

export const BacktestCalcDecimal = Decimal.clone({
  precision: 128,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -160,
  toExpPos: 160,
});

export type BacktestCalc = InstanceType<typeof BacktestCalcDecimal>;
export type BacktestDecimalInput = string | BacktestDecimal | BacktestCalc;

function fixedInput(input: BacktestDecimalInput): string | BacktestCalc {
  if (input instanceof BacktestDecimal) return input.value;
  if (typeof input === 'string') {
    const value = input.trim();
    if (value.length === 0 || /[eE]/.test(value) || !/^[+-]?\d+(?:\.\d+)?$/.test(value)) {
      throw new BacktestError('BACKTEST_NUMERIC_FAILURE', `Invalid fixed-point backtest decimal: ${input}`);
    }
    return value;
  }
  return input;
}

export function toBacktestCalcDecimal(input: BacktestDecimalInput): BacktestCalc {
  try {
    const value = new BacktestCalcDecimal(fixedInput(input));
    if (!value.isFinite() || value.isNaN()) {
      throw new BacktestError('BACKTEST_NUMERIC_FAILURE', 'Backtest decimal must be finite');
    }
    return value;
  } catch (error) {
    if (error instanceof BacktestError) throw error;
    throw new BacktestError('BACKTEST_NUMERIC_FAILURE', 'Unable to construct backtest decimal', { cause: error });
  }
}

export class BacktestDecimal {
  readonly #value: string;

  public constructor(input: BacktestDecimalInput) {
    const raw = toBacktestCalcDecimal(input);
    const rounded = raw.toDecimalPlaces(MAX_BACKTEST_SCALE, Decimal.ROUND_HALF_UP);
    if (!rounded.isFinite() || rounded.isNaN()) {
      throw new BacktestError('BACKTEST_NUMERIC_FAILURE', 'Backtest output quantization was non-finite');
    }
    if (rounded.isZero()) {
      this.#value = '0';
      Object.freeze(this);
      return;
    }
    const fixed = rounded.toFixed();
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(fixed);
    if (!match) throw new BacktestError('BACKTEST_NUMERIC_FAILURE', `Invalid fixed-point output: ${fixed}`);
    const integer = (match[2] ?? '0').replace(/^0+(?!$)/, '');
    const fraction = (match[3] ?? '').replace(/0+$/, '');
    const integerDigits = integer === '0' ? 0 : integer.length;
    const precision = integerDigits + fraction.length;
    if (integerDigits > MAX_BACKTEST_INTEGER_DIGITS || precision > MAX_BACKTEST_PRECISION) {
      throw new BacktestError('BACKTEST_OVERFLOW', `Backtest output exceeds DECIMAL(48,18): ${fixed}`);
    }
    this.#value = `${match[1] ?? ''}${integer}${fraction.length === 0 ? '' : `.${fraction}`}`;
    Object.freeze(this);
  }

  public static from(input: BacktestDecimalInput): BacktestDecimal {
    return input instanceof BacktestDecimal ? input : new BacktestDecimal(input);
  }

  public get value(): string { return this.#value; }
  public toString(): string { return this.#value; }
  public toJSON(): string { return this.#value; }
  public toCalculationDecimal(): BacktestCalc { return new BacktestCalcDecimal(this.#value); }
  public equals(other: BacktestDecimal | null | undefined): boolean {
    return other instanceof BacktestDecimal && this.#value === other.value;
  }
}

export const BACKTEST_ZERO = Object.freeze(new BacktestCalcDecimal('0'));
export const BACKTEST_ONE = Object.freeze(new BacktestCalcDecimal('1'));
export const BACKTEST_BPS_DIVISOR = Object.freeze(new BacktestCalcDecimal('10000'));

export function requirePositive(value: BacktestCalc, label: string): void {
  if (!value.isFinite() || value.lessThanOrEqualTo(0)) {
    throw new BacktestError('BACKTEST_NUMERIC_FAILURE', `${label} must be strictly positive`);
  }
}

export function publicDecimal(value: BacktestCalc): BacktestDecimal {
  return new BacktestDecimal(value);
}
