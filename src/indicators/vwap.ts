import { computeBatch } from './core/batch';
import { BaseIndicatorKernel } from './core/kernel';
import { createSegmentIdentity } from './core/segment';
import { IndicatorCalcDecimal, type IndicatorCalc } from './decimal/indicator-calc-decimal';
import { InvalidCandleInputError } from './errors';
import type { IndicatorCandle, IndicatorPoint } from './types';
import { IndicatorDecimal } from './decimal/indicator-decimal';

export const DAY_MS = 86_400_000;
export interface VwapConfig {
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly bootstrapStartOpenTimeMs: number;
}
export class VwapKernel extends BaseIndicatorKernel<IndicatorDecimal> {
  #utcDay: number | null = null;
  #cumulativePv: IndicatorCalc = new IndicatorCalcDecimal(0);
  #cumulativeVolume: IndicatorCalc = new IndicatorCalcDecimal(0);
  public constructor(config: VwapConfig) {
    super(createSegmentIdentity({ ...config, indicatorType: 'UTC_DAY_VWAP', parameters: { anchor: 'UTC_DAY' } }));
  }
  protected override validateIndicatorCandle(candle: IndicatorCandle): void {
    const openDay = Math.floor(candle.openTimeMs / DAY_MS);
    const closeDay = Math.floor((candle.closeTimeExclusiveMs - 1) / DAY_MS);
    if (openDay !== closeDay) throw new InvalidCandleInputError('VWAP candle straddles UTC midnight');
  }
  protected calculate(candle: IndicatorCandle): IndicatorDecimal | null {
    const day = Math.floor(candle.openTimeMs / DAY_MS);
    if (this.#utcDay !== day) {
      this.#utcDay = day;
      this.#cumulativePv = new IndicatorCalcDecimal(0);
      this.#cumulativeVolume = new IndicatorCalcDecimal(0);
    }
    const typicalPrice = candle.high.plus(candle.low).plus(candle.close).div(new IndicatorCalcDecimal(3));
    this.#cumulativePv = this.#cumulativePv.plus(typicalPrice.times(candle.volume));
    this.#cumulativeVolume = this.#cumulativeVolume.plus(candle.volume);
    return this.#cumulativeVolume.isZero() ? null : this.publish(this.#cumulativePv.div(this.#cumulativeVolume));
  }
}
export function computeVwap(candles: readonly IndicatorCandle[], config: VwapConfig): readonly IndicatorPoint<IndicatorDecimal>[] {
  return computeBatch(new VwapKernel(config), candles);
}
export const UtcDayVwapKernel = VwapKernel;
export const computeUtcDayVwap = computeVwap;
