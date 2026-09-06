import { extractPrice, validatePriceSource } from './candle/price-source';
import { BaseIndicatorKernel } from './core/kernel';
import { computeBatch } from './core/batch';
import { validatePeriod } from './core/parameters';
import { createSegmentIdentity } from './core/segment';
import type { IndicatorCandle, IndicatorPoint, PriceSource, ScalarIndicatorConfig } from './types';
import { IndicatorDecimal } from './decimal/indicator-decimal';
import { RollingSum } from './primitives/rolling';

export class SmaKernel extends BaseIndicatorKernel<IndicatorDecimal> {
  readonly #source: PriceSource;
  readonly #rolling: RollingSum;
  public constructor(config: ScalarIndicatorConfig) {
    const period = validatePeriod(config.period);
    const source = validatePriceSource(config.priceSource ?? 'CLOSE');
    super(createSegmentIdentity({ ...config, indicatorType: 'SMA', parameters: { period }, priceSource: source }));
    this.#source = source;
    this.#rolling = new RollingSum(period);
  }
  protected calculate(candle: IndicatorCandle): IndicatorDecimal | null {
    this.#rolling.push(extractPrice(candle, this.#source));
    const mean = this.#rolling.mean();
    return mean === null ? null : this.publish(mean);
  }
}
export function computeSma(candles: readonly IndicatorCandle[], config: ScalarIndicatorConfig): readonly IndicatorPoint<IndicatorDecimal>[] {
  return computeBatch(new SmaKernel(config), candles);
}
