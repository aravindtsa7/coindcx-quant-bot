import { computeBatch } from './core/batch';
import { BaseIndicatorKernel } from './core/kernel';
import { validatePeriod } from './core/parameters';
import { createSegmentIdentity } from './core/segment';
import { IndicatorDecimal } from './decimal/indicator-decimal';
import { RollingSum } from './primitives/rolling';
import type { IndicatorCandle, IndicatorPoint, PeriodIndicatorConfig } from './types';

export class VolumeSmaKernel extends BaseIndicatorKernel<IndicatorDecimal> {
  readonly #rolling: RollingSum;
  public constructor(config: PeriodIndicatorConfig) {
    const period = validatePeriod(config.period);
    super(createSegmentIdentity({ ...config, indicatorType: 'VOLUME_SMA', parameters: { period } }));
    this.#rolling = new RollingSum(period);
  }
  protected calculate(candle: IndicatorCandle): IndicatorDecimal | null {
    this.#rolling.push(candle.volume);
    const mean = this.#rolling.mean();
    return mean === null ? null : this.publish(mean);
  }
}
export class VolumeRatioKernel extends BaseIndicatorKernel<IndicatorDecimal> {
  readonly #rolling: RollingSum;
  public constructor(config: PeriodIndicatorConfig) {
    const period = validatePeriod(config.period);
    super(createSegmentIdentity({ ...config, indicatorType: 'VOLUME_RATIO', parameters: { period } }));
    this.#rolling = new RollingSum(period);
  }
  protected calculate(candle: IndicatorCandle): IndicatorDecimal | null {
    this.#rolling.push(candle.volume);
    const mean = this.#rolling.mean();
    return mean === null || mean.isZero() ? null : this.publish(candle.volume.div(mean));
  }
}
export function computeVolumeSma(candles: readonly IndicatorCandle[], config: PeriodIndicatorConfig): readonly IndicatorPoint<IndicatorDecimal>[] {
  return computeBatch(new VolumeSmaKernel(config), candles);
}
export function computeVolumeRatio(candles: readonly IndicatorCandle[], config: PeriodIndicatorConfig): readonly IndicatorPoint<IndicatorDecimal>[] {
  return computeBatch(new VolumeRatioKernel(config), candles);
}
