import Decimal from 'decimal.js';
import { PaperEngineError } from './errors';

// Prisma `Decimal(36,18)` is the repository's sole persisted-decimal convention
// (see `Candle1m`). MAX_PAPER_SCALE/MAX_PAPER_INTEGER_DIGITS mirror it exactly so
// `PaperDecimal` is always representable in that column shape without silent loss.
export const MAX_PAPER_SCALE = 18;
export const MAX_PAPER_INTEGER_DIGITS = 18;
export const MAX_PAPER_PRECISION = 36;

// Isolated 128-digit calculation context, cloned independently of both the
// app-wide `src/core/decimal` context and the backtest engine's own isolated
// context — mirrors `src/backtest/decimal.ts`'s `BacktestCalcDecimal` pattern so
// Phase14 arithmetic can never be silently perturbed by unrelated app config, and
// vice versa.
export const PaperCalcDecimal = Decimal.clone({
  precision: 128,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -160,
  toExpPos: 160,
});

export type PaperCalc = InstanceType<typeof PaperCalcDecimal>;
export type PaperDecimalInput = string | PaperDecimal | PaperCalc;

function fixedInput(input: PaperDecimalInput): string | PaperCalc {
  if (input instanceof PaperDecimal) return input.value;
  if (typeof input === 'string') {
    const value = input.trim();
    if (value.length === 0 || /[eE]/.test(value) || !/^[+-]?\d+(?:\.\d+)?$/.test(value)) {
      throw new PaperEngineError('PAPER_NUMERIC_FAILURE', `Invalid fixed-point paper decimal: ${input}`);
    }
    return value;
  }
  return input;
}

export function toPaperCalcDecimal(input: PaperDecimalInput): PaperCalc {
  try {
    const value = new PaperCalcDecimal(fixedInput(input));
    if (!value.isFinite() || value.isNaN()) {
      throw new PaperEngineError('PAPER_NUMERIC_FAILURE', 'Paper decimal must be finite');
    }
    return value;
  } catch (error) {
    if (error instanceof PaperEngineError) throw error;
    throw new PaperEngineError('PAPER_NUMERIC_FAILURE', 'Unable to construct paper decimal', { cause: error });
  }
}

/**
 * Immutable, DB-commit-boundary-quantized envelope: `ROUND_HALF_UP` to
 * `MAX_PAPER_SCALE` fractional digits, bounded to the persisted `Decimal(36,18)`
 * shape. Constructing one is exactly the "explicit durable-posting boundary
 * helper" — higher-precision `PaperCalc` intermediate values must never be
 * quantized through this class mid-calculation, only when a value is about to
 * become a durable posting.
 */
export class PaperDecimal {
  readonly #value: string;

  public constructor(input: PaperDecimalInput) {
    const raw = toPaperCalcDecimal(input);
    const rounded = raw.toDecimalPlaces(MAX_PAPER_SCALE, Decimal.ROUND_HALF_UP);
    if (!rounded.isFinite() || rounded.isNaN()) {
      throw new PaperEngineError('PAPER_NUMERIC_FAILURE', 'Paper output quantization was non-finite');
    }
    if (rounded.isZero()) {
      this.#value = '0';
      Object.freeze(this);
      return;
    }
    const fixed = rounded.toFixed();
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(fixed);
    if (!match) throw new PaperEngineError('PAPER_NUMERIC_FAILURE', `Invalid fixed-point output: ${fixed}`);
    const integer = (match[2] ?? '0').replace(/^0+(?!$)/, '');
    const fraction = (match[3] ?? '').replace(/0+$/, '');
    const integerDigits = integer === '0' ? 0 : integer.length;
    const precision = integerDigits + fraction.length;
    if (integerDigits > MAX_PAPER_INTEGER_DIGITS || precision > MAX_PAPER_PRECISION) {
      throw new PaperEngineError('PAPER_OVERFLOW', `Paper output exceeds DECIMAL(${MAX_PAPER_PRECISION},${MAX_PAPER_SCALE}): ${fixed}`);
    }
    this.#value = `${match[1] ?? ''}${integer}${fraction.length === 0 ? '' : `.${fraction}`}`;
    Object.freeze(this);
  }

  public static from(input: PaperDecimalInput): PaperDecimal {
    return input instanceof PaperDecimal ? input : new PaperDecimal(input);
  }

  public get value(): string { return this.#value; }
  public toString(): string { return this.#value; }
  public toJSON(): string { return this.#value; }
  public toCalculationDecimal(): PaperCalc { return new PaperCalcDecimal(this.#value); }
  public equals(other: PaperDecimal | null | undefined): boolean {
    return other instanceof PaperDecimal && this.#value === other.value;
  }
}

export const PAPER_ZERO = Object.freeze(new PaperCalcDecimal('0'));
export const PAPER_ONE = Object.freeze(new PaperCalcDecimal('1'));

export function paperDecimal(value: PaperDecimalInput): PaperCalc { return toPaperCalcDecimal(value); }

export function paperMin(a: PaperCalc, b: PaperCalc): PaperCalc { return a.lessThanOrEqualTo(b) ? a : b; }
export function paperMax(a: PaperCalc, b: PaperCalc): PaperCalc { return a.greaterThanOrEqualTo(b) ? a : b; }

/**
 * Canonical fixed-point decimal string used inside identity-hash payloads:
 * numerically equivalent inputs ("2", "2.0", "002.000") normalize to one
 * identical string, matching the repository's existing risk/backtest
 * canonicalization convention exactly (leading/trailing zero stripping,
 * `"-0"` normalized to `"0"`).
 */
export function canonicalPaperDecimalString(value: unknown, label = 'decimal'): string {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) {
    throw new PaperEngineError('PAPER_SOURCE_INVALID', `${label} must use fixed-point Decimal syntax`);
  }
  const decimal = new PaperCalcDecimal(value);
  if (!decimal.isFinite() || decimal.isNaN()) throw new PaperEngineError('PAPER_SOURCE_INVALID', `${label} must be finite`);
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [rawInteger = '0', rawFraction = ''] = unsigned.split('.');
  const integer = rawInteger.replace(/^0+(?!$)/, '') || '0';
  const fraction = rawFraction.replace(/0+$/, '');
  const zero = integer === '0' && fraction.length === 0;
  return `${negative && !zero ? '-' : ''}${integer}${fraction.length === 0 ? '' : `.${fraction}`}`;
}

function decompose(value: PaperCalc): readonly [bigint, number] {
  const fixed = value.toFixed();
  const negative = fixed.startsWith('-');
  const unsigned = negative ? fixed.slice(1) : fixed;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, '');
  const magnitude = BigInt(digits === '' ? '0' : digits);
  return [negative && magnitude !== 0n ? -magnitude : magnitude, fraction.length];
}

function formatScaled(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  if (scale === 0) return `${negative ? '-' : ''}${digits}`;
  const integer = digits.slice(0, -scale) || '0';
  const fraction = digits.slice(-scale);
  return `${negative ? '-' : ''}${integer}${fraction.length ? `.${fraction}` : ''}`;
}

// Exact BigInt floor division for a strictly positive divisor.
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  return r !== 0n && r < 0n ? q - 1n : q;
}
function ceilDiv(a: bigint, b: bigint): bigint {
  return -floorDiv(-a, b);
}

function toCommonScale(value: PaperCalc, tick: PaperCalc): { readonly v: bigint; readonly t: bigint; readonly scale: number } {
  const [vCoeff, vScale] = decompose(value);
  const [tCoeff, tScale] = decompose(tick);
  const scale = Math.max(vScale, tScale);
  const v = vCoeff * 10n ** BigInt(scale - vScale);
  const t = tCoeff * 10n ** BigInt(scale - tScale);
  return { v, t, scale };
}

function assertTickable(value: PaperCalc, tick: PaperCalc): void {
  if (!tick.isFinite() || tick.lessThanOrEqualTo(0)) throw new PaperEngineError('PAPER_NUMERIC_FAILURE', 'Tick size must be strictly positive');
  if (!value.isFinite()) throw new PaperEngineError('PAPER_NUMERIC_FAILURE', 'Value must be finite');
}

/** BUY-side rounding: exact ceiling to the nearest multiple of `tick`. No native floating arithmetic. */
export function ceilToTick(value: PaperCalc, tick: PaperCalc): PaperCalc {
  assertTickable(value, tick);
  const { v, t, scale } = toCommonScale(value, tick);
  return new PaperCalcDecimal(formatScaled(ceilDiv(v, t) * t, scale));
}

/** SELL-side rounding: exact floor to the nearest multiple of `tick`. No native floating arithmetic. */
export function floorToTick(value: PaperCalc, tick: PaperCalc): PaperCalc {
  assertTickable(value, tick);
  const { v, t, scale } = toCommonScale(value, tick);
  return new PaperCalcDecimal(formatScaled(floorDiv(v, t) * t, scale));
}

/**
 * Quantity policy is reject-not-resize (V1 frozen rule): a quantity already
 * approved/aligned upstream (Phase13 truncates to `quantityIncrement`) must
 * divide the increment exactly; a misaligned quantity is a contract violation,
 * never silently snapped.
 */
export function assertQuantityAligned(quantity: PaperCalc, increment: PaperCalc): void {
  if (!increment.isFinite() || increment.lessThanOrEqualTo(0)) {
    throw new PaperEngineError('PAPER_NUMERIC_FAILURE', 'Quantity increment must be strictly positive');
  }
  const { v, t } = toCommonScale(quantity, increment);
  if (t === 0n || v % t !== 0n) {
    throw new PaperEngineError('PAPER_QUANTITY_MISALIGNED', 'Quantity is not aligned to the instrument quantity increment');
  }
}
