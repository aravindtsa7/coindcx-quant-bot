import { computeBatch } from './core/batch';
import { BaseIndicatorKernel } from './core/kernel';
import { validatePeriod } from './core/parameters';
import { createSegmentIdentity } from './core/segment';
import { IndicatorCalcDecimal } from './decimal/indicator-calc-decimal';
import { RollingExtrema } from './primitives/rolling';
import type { DonchianValue, IndicatorCandle, IndicatorPoint, PeriodIndicatorConfig } from './types';

export class DonchianKernel extends BaseIndicatorKernel<DonchianValue> {
  readonly #highs: RollingExtrema;
  readonly #lows: RollingExtrema;
  public constructor(config: PeriodIndicatorConfig) {
    const period = validatePeriod(config.period);
    super(createSegmentIdentity({ ...config, indicatorType: 'DONCHIAN', parameters: { period } }));
    this.#highs = new RollingExtrema(period, 'MAX');
    this.#lows = new RollingExtrema(period, 'MIN');
  }
  protected calculate(candle: IndicatorCandle): Readonly<DonchianValue> | null {
    const upper = this.#highs.push(candle.high);
    const lower = this.#lows.push(candle.low);
    if (upper === null || lower === null) return null;
    return this.composite({ upper: this.publish(upper), lower: this.publish(lower), middle: this.publish(upper.plus(lower).div(new IndicatorCalcDecimal(2))) });
  }
}
export function computeDonchian(candles: readonly IndicatorCandle[], config: PeriodIndicatorConfig): readonly IndicatorPoint<DonchianValue>[] {
  return computeBatch(new DonchianKernel(config), candles);
}
export { DonchianKernel as DonchianChannelKernel };
export const computeDonchianChannel = computeDonchian;
