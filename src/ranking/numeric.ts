import { BacktestCalcDecimal, BacktestDecimal, type BacktestCalc } from '../backtest/decimal';
import { RankingError } from './errors';

/**
 * Phase15 arithmetic contract.
 *
 * Every ranking number is an exact decimal. The repository's existing
 * 128-digit isolated calculation context (`BacktestCalcDecimal`) is reused
 * verbatim, and every published value is quantized exactly once through
 * `BacktestDecimal` (DECIMAL(48,18) fixed-point, `ROUND_HALF_UP`).
 *
 * Native JS floating-point arithmetic is never used for ranking math: the only
 * `number` values Phase15 computes with are integer ordinal positions and
 * candidate counts, which are converted to Decimal before any division.
 */

const FIXED_POINT = /^[+-]?\d+(?:\.\d+)?$/;

/** Parses an authoritative fixed-point decimal string into the isolated calculation context. */
export function rankCalc(value: unknown): BacktestCalc {
  if (typeof value !== 'string' || !FIXED_POINT.test(value)) {
    throw new RankingError('RANKING_NUMERIC_FAILURE', 'Ranking input is not a canonical fixed-point decimal string');
  }
  try {
    const decimal = new BacktestCalcDecimal(value);
    if (!decimal.isFinite() || decimal.isNaN()) {
      throw new RankingError('RANKING_NUMERIC_FAILURE', 'Ranking input is not finite');
    }
    return decimal;
  } catch (error) {
    if (error instanceof RankingError) throw error;
    throw new RankingError('RANKING_NUMERIC_FAILURE', 'Unable to construct ranking decimal', { cause: error });
  }
}

/** Quantizes a calculation value once into the canonical published decimal string. */
export function rankCanonical(value: BacktestCalc): string {
  try {
    if (!value.isFinite() || value.isNaN()) {
      throw new RankingError('RANKING_NUMERIC_FAILURE', 'Ranking calculation produced a non-finite value');
    }
    return new BacktestDecimal(value).value;
  } catch (error) {
    if (error instanceof RankingError) throw error;
    throw new RankingError('RANKING_NUMERIC_FAILURE', 'Ranking result is outside the finite decimal contract', { cause: error });
  }
}

/**
 * Canonicalizes an authoritative decimal string so that semantically equal
 * inputs written differently (`"1.50"`, `"1.5"`, `"+1.5"`, `"-0"`) produce one
 * identical canonical form, and therefore one identical ranking identity.
 */
export function rankNormalizeDecimalString(value: unknown): string {
  return rankCanonical(rankCalc(value));
}

/** Exact Decimal comparison. Returns -1 / 0 / 1 and never uses native float compare. */
export function rankCompareDecimals(left: BacktestCalc, right: BacktestCalc): -1 | 0 | 1 {
  return left.lessThan(right) ? -1 : left.greaterThan(right) ? 1 : 0;
}

/** Converts a non-negative safe integer ordinal/count into the isolated calculation context. */
export function rankIntegerCalc(value: number): BacktestCalc {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RankingError('RANKING_NUMERIC_FAILURE', 'Ranking ordinal values must be non-negative safe integers');
  }
  return new BacktestCalcDecimal(value);
}

export const RANK_ZERO: BacktestCalc = new BacktestCalcDecimal(0);
export const RANK_ONE: BacktestCalc = new BacktestCalcDecimal(1);
