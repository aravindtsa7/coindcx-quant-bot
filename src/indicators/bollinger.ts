import { extractPrice, validatePriceSource } from './candle/price-source';
import { computeBatch } from './core/batch';
import { BaseIndicatorKernel } from './core/kernel';
import { validateMultiplier, validatePeriod } from './core/parameters';
import { createSegmentIdentity } from './core/segment';
import type { IndicatorCalc, IndicatorCalcInput } from './decimal/indicator-calc-decimal';
import { RollingSum, populationStdDev } from './primitives/rolling';
import type { BollingerValue, IndicatorCandle, IndicatorPoint, PriceSource } from './types';

export interface BollingerConfig {
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly bootstrapStartOpenTimeMs: number;
  readonly period: number;
  readonly multiplier: IndicatorCalcInput;
  readonly priceSource?: PriceSource;
}
export class BollingerKernel extends BaseIndicatorKernel<BollingerValue> {
  readonly #source: PriceSource;
  readonly #multiplier: IndicatorCalc;
  readonly #rolling: RollingSum;
  public constructor(config: BollingerConfig) {
    const period = validatePeriod(config.period);
    const multiplier = validateMultiplier(config.multiplier);
    const source = validatePriceSource(config.priceSource ?? 'CLOSE');
    super(createSegmentIdentity({ ...config, indicatorType: 'BOLLINGER', parameters: { period, multiplier: multiplier.toFixed() }, priceSource: source }));
    this.#source = source;
    this.#multiplier = multiplier;
    this.#rolling = new RollingSum(period);
  }
  protected calculate(candle: IndicatorCandle): Readonly<BollingerValue> | null {
    this.#rolling.push(extractPrice(candle, this.#source));
    const middle = this.#rolling.mean();
    if (middle === null) return null;
    const stdDev = populationStdDev(this.#rolling.values, middle);
    const distance = this.#multiplier.times(stdDev);
    return this.composite({
      middle: this.publish(middle),
      upper: this.publish(middle.plus(distance)),
      lower: this.publish(middle.minus(distance)),
      stdDev: this.publish(stdDev),
    });
  }
}
export function computeBollinger(candles: readonly IndicatorCandle[], config: BollingerConfig): readonly IndicatorPoint<BollingerValue>[] {
  return computeBatch(new BollingerKernel(config), candles);
}
export { BollingerKernel as BollingerBandsKernel };
export const computeBollingerBands = computeBollinger;
