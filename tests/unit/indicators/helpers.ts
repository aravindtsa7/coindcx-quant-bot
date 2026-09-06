import { IndicatorCalcDecimal, type IndicatorCandle } from '../../../src/indicators';

export const BASE_TIME = 1_728_000_000_000;

export function candle(
  index: number,
  close: string,
  options: {
    pair?: string;
    timeframeMinutes?: number;
    open?: string;
    high?: string;
    low?: string;
    volume?: string;
    bootstrap?: number;
  } = {},
): IndicatorCandle {
  const timeframeMinutes = options.timeframeMinutes ?? 1;
  const openTimeMs = (options.bootstrap ?? BASE_TIME) + index * timeframeMinutes * 60_000;
  const price = new IndicatorCalcDecimal(close);
  return Object.freeze({
    pair: options.pair ?? 'BTC_INR',
    timeframeMinutes,
    openTimeMs,
    closeTimeExclusiveMs: openTimeMs + timeframeMinutes * 60_000,
    open: new IndicatorCalcDecimal(options.open ?? close),
    high: new IndicatorCalcDecimal(options.high ?? price.plus('0.5')),
    low: new IndicatorCalcDecimal(options.low ?? price.minus('0.5')),
    close: price,
    volume: new IndicatorCalcDecimal(options.volume ?? '1'),
    quoteVolume: null,
  });
}

export function closes(values: readonly string[], options: Parameters<typeof candle>[2] = {}): readonly IndicatorCandle[] {
  return values.map((value, index) => candle(index, value, options));
}

export function strings<T extends { readonly value: { toString(): string } | null }>(points: readonly T[]): readonly (string | null)[] {
  return points.map((point) => point.value?.toString() ?? null);
}
