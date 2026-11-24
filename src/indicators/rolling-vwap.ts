import { BaseIndicatorKernel } from './core/kernel';
import { validatePeriod } from './core/parameters';
import { createSegmentIdentity } from './core/segment';
import { IndicatorCalcDecimal, type IndicatorCalc } from './decimal/indicator-calc-decimal';
import type { IndicatorCandle, PeriodIndicatorConfig } from './types';

export interface RollingVwapValue { readonly value: string; readonly stdDev: string; readonly volume: string }
/** Population variance of HLC3, weighted by actual base volume over the last N closed bars. */
export class RollingVwapKernel extends BaseIndicatorKernel<RollingVwapValue> {
  readonly #period: number;
  readonly #window: { price: IndicatorCalc; volume: IndicatorCalc }[] = [];
  public constructor(config: PeriodIndicatorConfig) {
    const period = validatePeriod(config.period);
    super(createSegmentIdentity({ ...config, indicatorType: 'ROLLING_VWAP', parameters: { period }, priceSource: 'HLC3' }));
    this.#period = period;
  }
  protected calculate(candle: IndicatorCandle): Readonly<RollingVwapValue> | null {
    this.#window.push({ price: candle.high.plus(candle.low).plus(candle.close).div(3), volume: candle.volume });
    if (this.#window.length > this.#period) this.#window.shift();
    if (this.#window.length < this.#period) return null;
    const volume = this.#window.reduce((sum, row) => sum.plus(row.volume), new IndicatorCalcDecimal(0));
    // A zero-volume window has no VWAP. Publish an explicit sentinel, never a synthetic trading price.
    if (volume.isZero()) return this.composite({ value: '0', stdDev: '0', volume: '0' });
    const mean = this.#window.reduce((sum, row) => sum.plus(row.price.times(row.volume)), new IndicatorCalcDecimal(0)).div(volume);
    const variance = this.#window.reduce((sum, row) => sum.plus(row.price.minus(mean).pow(2).times(row.volume)), new IndicatorCalcDecimal(0)).div(volume);
    return this.composite({ value: this.publish(mean).value, stdDev: this.publish(variance.sqrt()).value, volume: volume.toFixed() });
  }
}
