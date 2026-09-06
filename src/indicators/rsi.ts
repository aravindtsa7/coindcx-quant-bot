import { extractPrice, validatePriceSource } from './candle/price-source';
import { computeBatch } from './core/batch';
import { BaseIndicatorKernel } from './core/kernel';
import { validatePeriod } from './core/parameters';
import { createSegmentIdentity } from './core/segment';
import { IndicatorCalcDecimal, type IndicatorCalc } from './decimal/indicator-calc-decimal';
import { IndicatorDecimal } from './decimal/indicator-decimal';
import { RmaAccumulator } from './primitives/rma';
import type { IndicatorCandle, IndicatorPoint, PriceSource, ScalarIndicatorConfig } from './types';

export class RsiKernel extends BaseIndicatorKernel<IndicatorDecimal> {
  readonly #source: PriceSource;
  readonly #averageGain: RmaAccumulator;
  readonly #averageLoss: RmaAccumulator;
  #previousPrice: IndicatorCalc | null = null;
  public constructor(config: ScalarIndicatorConfig) {
    const period = validatePeriod(config.period);
    const source = validatePriceSource(config.priceSource ?? 'CLOSE');
    super(createSegmentIdentity({ ...config, indicatorType: 'RSI', parameters: { period }, priceSource: source }));
    this.#source = source;
    this.#averageGain = new RmaAccumulator(period);
    this.#averageLoss = new RmaAccumulator(period);
  }
  protected calculate(candle: IndicatorCandle): IndicatorDecimal | null {
    const price = extractPrice(candle, this.#source);
    if (this.#previousPrice === null) {
      this.#previousPrice = price;
      return null;
    }
    const delta = price.minus(this.#previousPrice);
    const gain = delta.gt(0) ? delta : new IndicatorCalcDecimal(0);
    const loss = delta.lt(0) ? delta.negated() : new IndicatorCalcDecimal(0);
    const averageGain = this.#averageGain.update(gain);
    const averageLoss = this.#averageLoss.update(loss);
    this.#previousPrice = price;
    if (averageGain === null || averageLoss === null) return null;
    if (averageGain.isZero() && averageLoss.isZero()) return this.publish(new IndicatorCalcDecimal(50));
    if (averageLoss.isZero()) return this.publish(new IndicatorCalcDecimal(100));
    if (averageGain.isZero()) return this.publish(new IndicatorCalcDecimal(0));
    return this.publish(new IndicatorCalcDecimal(100).times(averageGain).div(averageGain.plus(averageLoss)));
  }
}
export function computeRsi(candles: readonly IndicatorCandle[], config: ScalarIndicatorConfig): readonly IndicatorPoint<IndicatorDecimal>[] {
  return computeBatch(new RsiKernel(config), candles);
}
