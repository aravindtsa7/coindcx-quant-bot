import { InvalidIndicatorParameterError } from '../errors';
import { IndicatorCalcDecimal, type IndicatorCalc } from '../decimal/indicator-calc-decimal';
import { PRICE_SOURCES, type IndicatorCandle, type PriceSource } from '../types';

export function validatePriceSource(source: PriceSource): PriceSource {
  if (!(PRICE_SOURCES as readonly string[]).includes(source)) {
    throw new InvalidIndicatorParameterError(`Unsupported price source: ${String(source)}`);
  }
  return source;
}

export function extractPrice(candle: IndicatorCandle, source: PriceSource = 'CLOSE'): IndicatorCalc {
  switch (source) {
    case 'CLOSE': return candle.close;
    case 'OPEN': return candle.open;
    case 'HIGH': return candle.high;
    case 'LOW': return candle.low;
    case 'HL2': return candle.high.plus(candle.low).div(new IndicatorCalcDecimal(2));
    case 'HLC3': return candle.high.plus(candle.low).plus(candle.close).div(new IndicatorCalcDecimal(3));
    case 'OHLC4': return candle.open.plus(candle.high).plus(candle.low).plus(candle.close).div(new IndicatorCalcDecimal(4));
  }
}
