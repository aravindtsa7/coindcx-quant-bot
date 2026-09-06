import type { IndicatorCandle, IndicatorKernel, IndicatorPoint } from '../types';

export function computeBatch<T>(
  kernel: IndicatorKernel<T>,
  candles: readonly IndicatorCandle[],
): readonly IndicatorPoint<T>[] {
  const points: IndicatorPoint<T>[] = [];
  for (const candle of candles) points.push(kernel.update(candle));
  return Object.freeze(points);
}
