import type { CanonicalCandle1m } from '../../market-data/types';
import type { HigherTimeframeCandle } from '../../market-data/higher-timeframe/types';
import { toIndicatorCalcDecimal } from '../decimal/indicator-calc-decimal';
import type { IndicatorCandle } from '../types';

function normalized(
  candle: CanonicalCandle1m | HigherTimeframeCandle,
  timeframeMinutes: number,
): IndicatorCandle {
  return Object.freeze({
    pair: candle.pair,
    timeframeMinutes,
    openTimeMs: candle.openTimeMs,
    closeTimeExclusiveMs: candle.closeTimeExclusiveMs,
    open: toIndicatorCalcDecimal(candle.open.value),
    high: toIndicatorCalcDecimal(candle.high.value),
    low: toIndicatorCalcDecimal(candle.low.value),
    close: toIndicatorCalcDecimal(candle.close.value),
    volume: toIndicatorCalcDecimal(candle.volume.value),
    quoteVolume: candle.quoteVolume === null ? null : toIndicatorCalcDecimal(candle.quoteVolume.value),
  });
}

export function adaptCanonicalCandle1m(candle: CanonicalCandle1m): IndicatorCandle {
  return normalized(candle, 1);
}
export function adaptHigherTimeframeCandle(candle: HigherTimeframeCandle): IndicatorCandle {
  return normalized(candle, candle.timeframeMinutes);
}
export function adaptIndicatorCandle(candle: CanonicalCandle1m | HigherTimeframeCandle): IndicatorCandle {
  return 'timeframeMinutes' in candle
    ? adaptHigherTimeframeCandle(candle)
    : adaptCanonicalCandle1m(candle);
}
