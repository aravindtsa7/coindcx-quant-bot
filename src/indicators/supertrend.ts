import { computeBatch } from './core/batch';
import { BaseIndicatorKernel } from './core/kernel';
import { validateMultiplier, validatePeriod } from './core/parameters';
import { createSegmentIdentity } from './core/segment';
import { IndicatorCalcDecimal, type IndicatorCalc, type IndicatorCalcInput } from './decimal/indicator-calc-decimal';
import { RmaAccumulator } from './primitives/rma';
import { trueRange } from './primitives/true-range';
import type { IndicatorCandle, IndicatorPoint, SuperTrendValue } from './types';

export interface SuperTrendConfig {
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly bootstrapStartOpenTimeMs: number;
  readonly atrPeriod: number;
  readonly multiplier: IndicatorCalcInput;
}
export class SuperTrendKernel extends BaseIndicatorKernel<SuperTrendValue> {
  readonly #atr: RmaAccumulator;
  readonly #multiplier: IndicatorCalc;
  #previousClose: IndicatorCalc | null = null;
  #finalUpper: IndicatorCalc | null = null;
  #finalLower: IndicatorCalc | null = null;
  #supertrend: IndicatorCalc | null = null;
  public constructor(config: SuperTrendConfig) {
    const atrPeriod = validatePeriod(config.atrPeriod, 'atrPeriod');
    const multiplier = validateMultiplier(config.multiplier);
    super(createSegmentIdentity({ ...config, indicatorType: 'SUPERTREND', parameters: { atrPeriod, multiplier: multiplier.toFixed() } }));
    this.#atr = new RmaAccumulator(atrPeriod);
    this.#multiplier = multiplier;
  }
  protected calculate(candle: IndicatorCandle): Readonly<SuperTrendValue> | null {
    const atr = this.#atr.update(trueRange(candle, this.#previousClose));
    if (atr === null) {
      this.#previousClose = candle.close;
      return null;
    }
    const hl2 = candle.high.plus(candle.low).div(new IndicatorCalcDecimal(2));
    const distance = this.#multiplier.times(atr);
    const basicUpper = hl2.plus(distance);
    const basicLower = hl2.minus(distance);
    if (this.#finalUpper === null || this.#finalLower === null || this.#supertrend === null || this.#previousClose === null) {
      this.#finalUpper = basicUpper;
      this.#finalLower = basicLower;
      this.#supertrend = basicUpper;
      this.#previousClose = candle.close;
      return this.composite({ value: this.publish(this.#supertrend), direction: 'DOWN' as const });
    }
    const previousFinalUpper = this.#finalUpper;
    const previousFinalLower = this.#finalLower;
    const previousSupertrend = this.#supertrend;
    const finalUpper = basicUpper.lt(previousFinalUpper) || this.#previousClose.gt(previousFinalUpper) ? basicUpper : previousFinalUpper;
    const finalLower = basicLower.gt(previousFinalLower) || this.#previousClose.lt(previousFinalLower) ? basicLower : previousFinalLower;
    let direction: 'UP' | 'DOWN';
    let supertrend: IndicatorCalc;
    if (previousSupertrend.eq(previousFinalUpper)) {
      direction = candle.close.lte(finalUpper) ? 'DOWN' : 'UP';
      supertrend = direction === 'DOWN' ? finalUpper : finalLower;
    } else {
      direction = candle.close.gte(finalLower) ? 'UP' : 'DOWN';
      supertrend = direction === 'UP' ? finalLower : finalUpper;
    }
    this.#finalUpper = finalUpper;
    this.#finalLower = finalLower;
    this.#supertrend = supertrend;
    this.#previousClose = candle.close;
    return this.composite({ value: this.publish(supertrend), direction });
  }
}
export function computeSuperTrend(candles: readonly IndicatorCandle[], config: SuperTrendConfig): readonly IndicatorPoint<SuperTrendValue>[] {
  return computeBatch(new SuperTrendKernel(config), candles);
}
