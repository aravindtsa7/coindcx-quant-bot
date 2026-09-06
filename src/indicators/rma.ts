import { extractPrice, validatePriceSource } from './candle/price-source';
import { computeBatch } from './core/batch';
import { BaseIndicatorKernel } from './core/kernel';
import { validatePeriod } from './core/parameters';
import { createSegmentIdentity } from './core/segment';
import { IndicatorDecimal } from './decimal/indicator-decimal';
import { RmaAccumulator } from './primitives/rma';
import type { IndicatorCandle, IndicatorPoint, PriceSource, ScalarIndicatorConfig } from './types';

export class RmaKernel extends BaseIndicatorKernel<IndicatorDecimal> {
  readonly #source: PriceSource;
  readonly #rma: RmaAccumulator;
  public constructor(config: ScalarIndicatorConfig) {
    const period = validatePeriod(config.period);
    const source = validatePriceSource(config.priceSource ?? 'CLOSE');
    super(createSegmentIdentity({ ...config, indicatorType: 'RMA', parameters: { period }, priceSource: source }));
    this.#source = source;
    this.#rma = new RmaAccumulator(period);
  }
  protected calculate(candle: IndicatorCandle): IndicatorDecimal | null {
    const value = this.#rma.update(extractPrice(candle, this.#source));
    return value === null ? null : this.publish(value);
  }
}
export function computeRma(candles: readonly IndicatorCandle[], config: ScalarIndicatorConfig): readonly IndicatorPoint<IndicatorDecimal>[] {
  return computeBatch(new RmaKernel(config), candles);
}
export { RmaKernel as WilderRmaKernel };
export const computeWilderRma = computeRma;
