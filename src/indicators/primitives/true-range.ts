import type { IndicatorCalc } from '../decimal/indicator-calc-decimal';
import type { IndicatorCandle } from '../types';

export function trueRange(candle: IndicatorCandle, previousClose: IndicatorCalc | null): IndicatorCalc {
  const range = candle.high.minus(candle.low);
  if (previousClose === null) return range;
  const highGap = candle.high.minus(previousClose).abs();
  const lowGap = candle.low.minus(previousClose).abs();
  let result = range;
  if (highGap.gt(result)) result = highGap;
  if (lowGap.gt(result)) result = lowGap;
  return result;
}
