import { Decimal } from '../core/decimal/decimal';
import { CanonicalDecimal } from './canonical-decimal';
import { CanonicalValidationError } from './errors';
import { CanonicalCandle1m, CanonicalCandleSource } from './types';

// Sane minimum timestamp boundary: 2020-01-01T00:00:00.000Z
export const MIN_CANONICAL_OPEN_TIME_MS = 1577836800000;

export interface CreateCanonicalCandleParams {
  readonly pair: string;
  readonly openTimeMs: number;
  readonly open: CanonicalDecimal | Decimal | string;
  readonly high: CanonicalDecimal | Decimal | string;
  readonly low: CanonicalDecimal | Decimal | string;
  readonly close: CanonicalDecimal | Decimal | string;
  readonly volume: CanonicalDecimal | Decimal | string;
  readonly quoteVolume: CanonicalDecimal | Decimal | string | null;
  readonly source: CanonicalCandleSource;
  readonly finalizedAtMs: number;
  readonly providerEventTimeMs: number | null;
  readonly generationId: number | null;
}

export function createCanonicalCandle1m(params: CreateCanonicalCandleParams): CanonicalCandle1m {
  const {
    pair,
    openTimeMs,
    source,
    finalizedAtMs,
    providerEventTimeMs,
    generationId,
  } = params;

  if (!pair || pair.trim() === '') {
    throw new CanonicalValidationError('Pair is required for canonical candle');
  }

  // F9: Candle-time safety
  if (
    !Number.isSafeInteger(openTimeMs) ||
    !Number.isFinite(openTimeMs) ||
    openTimeMs < MIN_CANONICAL_OPEN_TIME_MS
  ) {
    throw new CanonicalValidationError(
      `Invalid openTimeMs: ${openTimeMs}. Must be finite safe integer >= ${MIN_CANONICAL_OPEN_TIME_MS}`
    );
  }

  if (openTimeMs % 60_000 !== 0) {
    throw new CanonicalValidationError(`openTimeMs must align to exact UTC minute: ${openTimeMs}`);
  }

  const closeTimeExclusiveMs = openTimeMs + 60_000;
  if (!Number.isSafeInteger(closeTimeExclusiveMs)) {
    throw new CanonicalValidationError(
      `closeTimeExclusiveMs is not a safe integer: ${closeTimeExclusiveMs}`
    );
  }

  // F6 & F8: CanonicalDecimal conversion and exactness validation
  const open = CanonicalDecimal.from(params.open);
  const high = CanonicalDecimal.from(params.high);
  const low = CanonicalDecimal.from(params.low);
  const close = CanonicalDecimal.from(params.close);
  const volume = CanonicalDecimal.from(params.volume);
  const quoteVolume = CanonicalDecimal.fromNullable(params.quoteVolume);

  // Non-negative financial values
  if (open.isNegative() || high.isNegative() || low.isNegative() || close.isNegative()) {
    throw new CanonicalValidationError('OHLC prices must be non-negative');
  }

  if (volume.isNegative()) {
    throw new CanonicalValidationError('Volume must be non-negative');
  }

  if (quoteVolume !== null && quoteVolume.isNegative()) {
    throw new CanonicalValidationError('Quote volume must be non-negative');
  }

  // Structural OHLC consistency
  if (high.lessThan(low)) {
    throw new CanonicalValidationError(`Structural OHLC violation: high (${high.value}) < low (${low.value})`);
  }
  if (high.lessThan(open)) {
    throw new CanonicalValidationError(`Structural OHLC violation: high (${high.value}) < open (${open.value})`);
  }
  if (high.lessThan(close)) {
    throw new CanonicalValidationError(`Structural OHLC violation: high (${high.value}) < close (${close.value})`);
  }
  if (low.greaterThan(open)) {
    throw new CanonicalValidationError(`Structural OHLC violation: low (${low.value}) > open (${open.value})`);
  }
  if (low.greaterThan(close)) {
    throw new CanonicalValidationError(`Structural OHLC violation: low (${low.value}) > close (${close.value})`);
  }

  if (source !== 'WS_FINALIZED' && source !== 'REST_RECOVERY') {
    throw new CanonicalValidationError(`Invalid source: ${source}`);
  }

  if (!Number.isSafeInteger(finalizedAtMs) || finalizedAtMs <= 0) {
    throw new CanonicalValidationError(`Invalid finalizedAtMs: ${finalizedAtMs}`);
  }

  return Object.freeze<CanonicalCandle1m>({
    pair,
    openTimeMs,
    closeTimeExclusiveMs,
    open,
    high,
    low,
    close,
    volume,
    quoteVolume,
    source,
    finalizedAtMs,
    providerEventTimeMs: providerEventTimeMs !== null && Number.isSafeInteger(providerEventTimeMs) ? providerEventTimeMs : null,
    generationId: generationId !== null && Number.isInteger(generationId) ? generationId : null,
  });
}

/**
 * Single, unified canonical candle truth comparator (F7).
 * Strictly verifies OHLCV + quoteVolume identity while preserving null !== Decimal(0).
 * Ephemeral transport metadata (generationId, providerEventTimeMs, finalizedAtMs) does not cause false conflicts.
 */
export function areCanonicalCandlesIdentical(a: CanonicalCandle1m, b: CanonicalCandle1m): boolean {
  if (a.pair !== b.pair) return false;
  if (a.openTimeMs !== b.openTimeMs) return false;
  if (!a.open.equals(b.open)) return false;
  if (!a.high.equals(b.high)) return false;
  if (!a.low.equals(b.low)) return false;
  if (!a.close.equals(b.close)) return false;
  if (!a.volume.equals(b.volume)) return false;

  // Strict null vs zero check: null !== Decimal(0)
  if (a.quoteVolume === null && b.quoteVolume !== null) return false;
  if (a.quoteVolume !== null && b.quoteVolume === null) return false;
  if (a.quoteVolume !== null && b.quoteVolume !== null && !a.quoteVolume.equals(b.quoteVolume)) {
    return false;
  }

  return true;
}
