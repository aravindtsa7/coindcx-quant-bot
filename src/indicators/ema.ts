import { extractPrice, validatePriceSource } from './candle/price-source';
import { computeBatch } from './core/batch';
import { BaseIndicatorKernel } from './core/kernel';
import { validatePeriod } from './core/parameters';
import { createSegmentIdentity } from './core/segment';
import { IndicatorDecimal } from './decimal/indicator-decimal';
import { EmaAccumulator } from './primitives/ema';
import type { IndicatorCandle, IndicatorPoint, PriceSource, ScalarIndicatorConfig } from './types';

export class EmaKernel extends BaseIndicatorKernel<IndicatorDecimal> {
  readonly #source: PriceSource;
  readonly #ema: EmaAccumulator;
  public constructor(config: ScalarIndicatorConfig) {
    const period = validatePeriod(config.period);
    const source = validatePriceSource(config.priceSource ?? 'CLOSE');
    super(createSegmentIdentity({ ...config, indicatorType: 'EMA', parameters: { period }, priceSource: source }));
    this.#source = source;
    this.#ema = new EmaAccumulator(period);
  }
  protected calculate(candle: IndicatorCandle): IndicatorDecimal | null {
    const value = this.#ema.update(extractPrice(candle, this.#source));
    return value === null ? null : this.publish(value);
  }
}
export function computeEma(candles: readonly IndicatorCandle[], config: ScalarIndicatorConfig): readonly IndicatorPoint<IndicatorDecimal>[] {
  return computeBatch(new EmaKernel(config), candles);
}
