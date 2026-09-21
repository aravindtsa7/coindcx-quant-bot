/**
 * Exact-decimal layer for Phase17 live execution (P17-I10).
 *
 * Mirrors the frozen Phase14 convention in `src/execution/decimal.ts` — an
 * isolated 128-digit calculation context, fixed-point-only string parsing (no
 * exponent syntax), and a canonicalizer whose output is stable across
 * numerically equivalent inputs — but raises Phase17's own error codes so a
 * live numeric fault can never be mistaken for a paper one.
 *
 * NO JavaScript binary floating-point arithmetic is performed on any order
 * quantity, price, fill quantity, average price, notional, or fee anywhere in
 * `src/execution/live/**`; tick/increment arithmetic below is exact BigInt.
 */
import Decimal from 'decimal.js';
import { LiveExecutionError } from './errors';

/** Matches the repository's sole persisted-decimal convention, `Decimal(36,18)`. */
export const MAX_LIVE_SCALE = 18;
export const MAX_LIVE_INTEGER_DIGITS = 18;
export const MAX_LIVE_PRECISION = 36;

export const LiveCalcDecimal = Decimal.clone({
  precision: 128,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -160,
  toExpPos: 160,
});

export type LiveCalc = InstanceType<typeof LiveCalcDecimal>;
export type LiveDecimalInput = string | LiveCalc;

const FIXED_POINT = /^[+-]?\d+(?:\.\d+)?$/;

function fixedInput(input: LiveDecimalInput): string | LiveCalc {
  if (typeof input === 'string') {
    const value = input.trim();
    if (value.length === 0 || /[eE]/.test(value) || !FIXED_POINT.test(value)) {
      throw new LiveExecutionError('LIVE_NUMERIC_FAILURE', 'Live decimal must use fixed-point syntax without exponents');
    }
    return value;
  }
  return input;
}

/** Parses into the isolated live calculation context. Never accepts a JS `number`. */
export function liveDecimal(input: LiveDecimalInput): LiveCalc {
  try {
    const value = new LiveCalcDecimal(fixedInput(input));
    if (!value.isFinite() || value.isNaN()) {
      throw new LiveExecutionError('LIVE_NUMERIC_FAILURE', 'Live decimal must be finite');
    }
    return value;
  } catch (error) {
    if (error instanceof LiveExecutionError) throw error;
    throw new LiveExecutionError('LIVE_NUMERIC_FAILURE', 'Unable to construct live decimal', { cause: error });
  }
}

/**
 * Canonical fixed-point string used inside identity-hash payloads and durable
 * writes: numerically equivalent inputs ("2", "2.0", "002.000") collapse to one
 * identical string, and "-0" normalizes to "0" — byte-compatible with the
 * repository's existing risk/backtest/paper canonicalization.
 */
export function canonicalLiveDecimalString(value: unknown, label = 'decimal'): string {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', `${label} must use fixed-point Decimal syntax`);
  }
  const parsed = new LiveCalcDecimal(value);
  if (!parsed.isFinite() || parsed.isNaN()) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', `${label} must be finite`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [rawInteger = '0', rawFraction = ''] = unsigned.split('.');
  const integer = rawInteger.replace(/^0+(?!$)/, '') || '0';
  const fraction = rawFraction.replace(/0+$/, '');
  const zero = integer === '0' && fraction.length === 0;
  return `${negative && !zero ? '-' : ''}${integer}${fraction.length === 0 ? '' : `.${fraction}`}`;
}

/** Canonicalizes without rounding and proves exact `DECIMAL(36,18)` storage. */
export function canonicalPersistedLiveDecimal(value: unknown, label: string): string {
  const canonical = canonicalLiveDecimalString(value, label);
  const unsigned = canonical.startsWith('-') ? canonical.slice(1) : canonical;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const integerDigits = integer === '0' ? 0 : integer.length;
  if (integerDigits > MAX_LIVE_INTEGER_DIGITS || fraction.length > MAX_LIVE_SCALE) {
    throw new LiveExecutionError('LIVE_OVERFLOW', `${label} must fit DECIMAL(${MAX_LIVE_PRECISION},${MAX_LIVE_SCALE}) exactly`);
  }
  return canonical;
}

export function canonicalPositiveLiveDecimal(value: unknown, label: string): string {
  const canonical = canonicalPersistedLiveDecimal(value, label);
  if (canonical === '0' || canonical.startsWith('-')) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', `${label} must be strictly positive`);
  }
  return canonical;
}

export function canonicalNonNegativeLiveDecimal(value: unknown, label: string): string {
  const canonical = canonicalPersistedLiveDecimal(value, label);
  if (canonical.startsWith('-')) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', `${label} must not be negative`);
  }
  return canonical;
}

// ---------------------------------------------------------------------------
// Exact BigInt tick/increment arithmetic (no binary floating point anywhere)
// ---------------------------------------------------------------------------

function decompose(value: LiveCalc): readonly [bigint, number] {
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
  return `${negative ? '-' : ''}${integer}${fraction.length > 0 ? `.${fraction}` : ''}`;
}

function floorDiv(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  const remainder = a % b;
  return remainder !== 0n && remainder < 0n ? quotient - 1n : quotient;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return -floorDiv(-a, b);
}

function toCommonScale(value: LiveCalc, tick: LiveCalc): { readonly v: bigint; readonly t: bigint; readonly scale: number } {
  const [vCoefficient, vScale] = decompose(value);
  const [tCoefficient, tScale] = decompose(tick);
  const scale = Math.max(vScale, tScale);
  return {
    v: vCoefficient * 10n ** BigInt(scale - vScale),
    t: tCoefficient * 10n ** BigInt(scale - tScale),
    scale,
  };
}

function assertTickable(value: LiveCalc, tick: LiveCalc): void {
  if (!tick.isFinite() || tick.lessThanOrEqualTo(0)) {
    throw new LiveExecutionError('LIVE_NUMERIC_FAILURE', 'Tick/increment must be strictly positive');
  }
  if (!value.isFinite()) throw new LiveExecutionError('LIVE_NUMERIC_FAILURE', 'Value must be finite');
}

/** Exact floor to the nearest multiple of `tick`. Never increases magnitude for a positive value. */
export function floorToIncrement(value: LiveCalc, tick: LiveCalc): LiveCalc {
  assertTickable(value, tick);
  const { v, t, scale } = toCommonScale(value, tick);
  return new LiveCalcDecimal(formatScaled(floorDiv(v, t) * t, scale));
}

/** Exact ceiling to the nearest multiple of `tick`. */
export function ceilToIncrement(value: LiveCalc, tick: LiveCalc): LiveCalc {
  assertTickable(value, tick);
  const { v, t, scale } = toCommonScale(value, tick);
  return new LiveCalcDecimal(formatScaled(ceilDiv(v, t) * t, scale));
}

/** True when `value` is an exact integral multiple of `increment`. */
export function isAlignedToIncrement(value: LiveCalc, increment: LiveCalc): boolean {
  assertTickable(value, increment);
  const { v, t } = toCommonScale(value, increment);
  return t !== 0n && v % t === 0n;
}
