import { computeBatch } from './core/batch';
import { BaseIndicatorKernel } from './core/kernel';
import { validatePeriod } from './core/parameters';
import { createSegmentIdentity } from './core/segment';
import { IndicatorCalcDecimal, type IndicatorCalc } from './decimal/indicator-calc-decimal';
import { RmaAccumulator } from './primitives/rma';
import { trueRange } from './primitives/true-range';
import type { DmiAdxValue, IndicatorCandle, IndicatorPoint, PeriodIndicatorConfig } from './types';

export class DmiAdxKernel extends BaseIndicatorKernel<DmiAdxValue> {
  #previousHigh: IndicatorCalc | null = null;
  #previousLow: IndicatorCalc | null = null;
  #previousClose: IndicatorCalc | null = null;
  readonly #smoothedTr: RmaAccumulator;
  readonly #smoothedPlusDm: RmaAccumulator;
  readonly #smoothedMinusDm: RmaAccumulator;
  readonly #adx: RmaAccumulator;
  public constructor(config: PeriodIndicatorConfig) {
    const period = validatePeriod(config.period);
    super(createSegmentIdentity({ ...config, indicatorType: 'DMI_ADX', parameters: { period } }));
    this.#smoothedTr = new RmaAccumulator(period);
    this.#smoothedPlusDm = new RmaAccumulator(period);
    this.#smoothedMinusDm = new RmaAccumulator(period);
    this.#adx = new RmaAccumulator(period);
  }
  protected calculate(candle: IndicatorCandle): Readonly<DmiAdxValue> | null {
    if (this.#previousHigh === null || this.#previousLow === null || this.#previousClose === null) {
      this.#setPrevious(candle);
      return null;
    }
    const upMove = candle.high.minus(this.#previousHigh);
    const downMove = this.#previousLow.minus(candle.low);
    const zero = new IndicatorCalcDecimal(0);
    const plusDm = upMove.gt(downMove) && upMove.gt(0) ? upMove : zero;
    const minusDm = downMove.gt(upMove) && downMove.gt(0) ? downMove : zero;
    const tr = trueRange(candle, this.#previousClose);
    const smoothedTr = this.#smoothedTr.update(tr);
    const smoothedPlusDm = this.#smoothedPlusDm.update(plusDm);
    const smoothedMinusDm = this.#smoothedMinusDm.update(minusDm);
    this.#setPrevious(candle);
    if (smoothedTr === null || smoothedPlusDm === null || smoothedMinusDm === null) return null;
    const hundred = new IndicatorCalcDecimal(100);
    const plusDI = smoothedTr.isZero() ? zero : hundred.times(smoothedPlusDm).div(smoothedTr);
    const minusDI = smoothedTr.isZero() ? zero : hundred.times(smoothedMinusDm).div(smoothedTr);
    const denominator = plusDI.plus(minusDI);
    const dx = denominator.isZero() ? zero : hundred.times(plusDI.minus(minusDI).abs()).div(denominator);
    const adx = this.#adx.update(dx);
    return this.composite({
      plusDI: this.publish(plusDI),
      minusDI: this.publish(minusDI),
      adx: adx === null ? null : this.publish(adx),
    });
  }
  #setPrevious(candle: IndicatorCandle): void {
    this.#previousHigh = candle.high;
    this.#previousLow = candle.low;
    this.#previousClose = candle.close;
  }
}
export function computeDmiAdx(candles: readonly IndicatorCandle[], config: PeriodIndicatorConfig): readonly IndicatorPoint<DmiAdxValue>[] {
  return computeBatch(new DmiAdxKernel(config), candles);
}
