import {
  CandleGapError,
  CandleOrderViolationError,
  InvalidCandleInputError,
  PairMismatchError,
  TimeframeMismatchError,
} from '../errors';
import type { IndicatorCandle, IndicatorCalculationSegmentIdentity } from '../types';

function invalid(condition: boolean, message: string): void {
  if (condition) throw new InvalidCandleInputError(message);
}

export function validateCandleStructure(candle: IndicatorCandle): void {
  invalid(!candle || typeof candle !== 'object', 'Candle is required');
  invalid(typeof candle.pair !== 'string' || candle.pair.trim() === '', 'Candle pair must be non-empty');
  invalid(!Number.isSafeInteger(candle.timeframeMinutes) || candle.timeframeMinutes < 1, 'Candle timeframe must be a positive safe integer');
  const duration = candle.timeframeMinutes * 60_000;
  invalid(!Number.isSafeInteger(duration), 'Candle duration is unsafe');
  invalid(!Number.isSafeInteger(candle.openTimeMs) || candle.openTimeMs < 0, 'Candle open time must be a non-negative safe integer');
  invalid(candle.openTimeMs % duration !== 0, 'Candle open time is not aligned to its timeframe bucket');
  invalid(!Number.isSafeInteger(candle.closeTimeExclusiveMs) || candle.closeTimeExclusiveMs !== candle.openTimeMs + duration, 'Candle close time is invalid');
  try {
    const decimals = [candle.open, candle.high, candle.low, candle.close, candle.volume];
    invalid(decimals.some((value) => !value || !value.isFinite()), 'Candle contains a non-finite decimal');
    invalid(candle.quoteVolume !== null && (!candle.quoteVolume || !candle.quoteVolume.isFinite()), 'Quote volume is non-finite');
    invalid(!candle.open.gt(0) || !candle.high.gt(0) || !candle.low.gt(0) || !candle.close.gt(0), 'OHLC prices must be positive');
    invalid(candle.volume.lt(0), 'Volume must be non-negative');
    invalid(candle.quoteVolume !== null && candle.quoteVolume.lt(0), 'Quote volume must be non-negative');
    invalid(candle.high.lt(candle.low) || candle.high.lt(candle.open) || candle.high.lt(candle.close), 'Candle high violates OHLC structure');
    invalid(candle.low.gt(candle.open) || candle.low.gt(candle.close), 'Candle low violates OHLC structure');
  } catch (error) {
    if (error instanceof InvalidCandleInputError) throw error;
    throw new InvalidCandleInputError('Candle decimal values are invalid', { cause: error });
  }
}

export function validateCandleForSegment(
  candle: IndicatorCandle,
  segment: IndicatorCalculationSegmentIdentity,
  previousOpenTimeMs: number | null,
): void {
  if (!candle || typeof candle !== 'object') throw new InvalidCandleInputError('Candle is required');
  if (candle.pair !== segment.pair) throw new PairMismatchError(`Expected pair ${segment.pair}, received ${candle.pair}`);
  if (candle.timeframeMinutes !== segment.timeframeMinutes) throw new TimeframeMismatchError(`Expected timeframe ${segment.timeframeMinutes}, received ${candle.timeframeMinutes}`);
  validateCandleStructure(candle);
  if (previousOpenTimeMs === null) {
    if (candle.openTimeMs !== segment.bootstrapStartOpenTimeMs) {
      throw new InvalidCandleInputError(`First candle must open at bootstrap origin ${segment.bootstrapStartOpenTimeMs}`);
    }
    return;
  }
  if (candle.openTimeMs <= previousOpenTimeMs) throw new CandleOrderViolationError('Candle timestamp is duplicate or backwards');
  const expected = previousOpenTimeMs + segment.timeframeMinutes * 60_000;
  if (candle.openTimeMs !== expected) throw new CandleGapError(`Expected candle at ${expected}, received ${candle.openTimeMs}`);
}
