import { validateSegmentCoordinates } from './parameters';
import type { IndicatorCalculationSegmentIdentity, PriceSource } from '../types';

function freezeParameters(parameters: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...parameters });
}

export function createSegmentIdentity(config: {
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly bootstrapStartOpenTimeMs: number;
  readonly indicatorType: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly priceSource?: PriceSource;
}): IndicatorCalculationSegmentIdentity {
  validateSegmentCoordinates(config.pair, config.timeframeMinutes, config.bootstrapStartOpenTimeMs);
  const base = {
    pair: config.pair,
    timeframeMinutes: config.timeframeMinutes,
    indicatorType: config.indicatorType,
    parameters: freezeParameters(config.parameters),
    bootstrapStartOpenTimeMs: config.bootstrapStartOpenTimeMs,
  };
  return Object.freeze(config.priceSource === undefined ? base : { ...base, priceSource: config.priceSource });
}
