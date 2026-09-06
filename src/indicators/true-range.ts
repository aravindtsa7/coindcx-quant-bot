import { computeBatch } from './core/batch';
import { BaseIndicatorKernel } from './core/kernel';
import { createSegmentIdentity } from './core/segment';
import type { IndicatorCalc } from './decimal/indicator-calc-decimal';
import { IndicatorDecimal } from './decimal/indicator-decimal';
import { trueRange } from './primitives/true-range';
import type { IndicatorCandle, IndicatorPoint } from './types';

export interface TrueRangeConfig {
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly bootstrapStartOpenTimeMs: number;
}
export class TrueRangeKernel extends BaseIndicatorKernel<IndicatorDecimal> {
  #previousClose: IndicatorCalc | null = null;
  public constructor(config: TrueRangeConfig) {
    super(createSegmentIdentity({ ...config, indicatorType: 'TRUE_RANGE', parameters: {} }));
  }
  protected calculate(candle: IndicatorCandle): IndicatorDecimal {
    const value = trueRange(candle, this.#previousClose);
    this.#previousClose = candle.close;
    return this.publish(value);
  }
}
export function computeTrueRange(candles: readonly IndicatorCandle[], config: TrueRangeConfig): readonly IndicatorPoint<IndicatorDecimal>[] {
  return computeBatch(new TrueRangeKernel(config), candles);
}
