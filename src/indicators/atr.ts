import { computeBatch } from './core/batch';
import { BaseIndicatorKernel } from './core/kernel';
import { validatePeriod } from './core/parameters';
import { createSegmentIdentity } from './core/segment';
import type { IndicatorCalc } from './decimal/indicator-calc-decimal';
import { IndicatorDecimal } from './decimal/indicator-decimal';
import { RmaAccumulator } from './primitives/rma';
import { trueRange } from './primitives/true-range';
import type { IndicatorCandle, IndicatorPoint, PeriodIndicatorConfig } from './types';

export class AtrKernel extends BaseIndicatorKernel<IndicatorDecimal> {
  #previousClose: IndicatorCalc | null = null;
  readonly #atr: RmaAccumulator;
  public constructor(config: PeriodIndicatorConfig) {
    const period = validatePeriod(config.period);
    super(createSegmentIdentity({ ...config, indicatorType: 'ATR', parameters: { period } }));
    this.#atr = new RmaAccumulator(period);
  }
  protected calculate(candle: IndicatorCandle): IndicatorDecimal | null {
    const tr = trueRange(candle, this.#previousClose);
    const value = this.#atr.update(tr);
    this.#previousClose = candle.close;
    return value === null ? null : this.publish(value);
  }
}
export function computeAtr(candles: readonly IndicatorCandle[], config: PeriodIndicatorConfig): readonly IndicatorPoint<IndicatorDecimal>[] {
  return computeBatch(new AtrKernel(config), candles);
}
