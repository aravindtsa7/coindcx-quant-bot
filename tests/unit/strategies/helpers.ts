import { IndicatorDecimal, type IndicatorPoint } from '../../../src/indicators';
import {
  StrategyReadonlyMap,
  type StrategyCandleSnapshot,
  type StrategyEvaluationSnapshot,
  type StrategyKernel,
} from '../../../src/strategies';

export const PAIR = 'B-BTC_INR';
export const BASE = 1_704_067_200_000;

export function strategyCandle(timeframeMinutes: number, closeTimeExclusiveMs: number, close = '100'): StrategyCandleSnapshot {
  return Object.freeze({
    pair: PAIR,
    timeframeMinutes,
    openTimeMs: closeTimeExclusiveMs - timeframeMinutes * 60_000,
    closeTimeExclusiveMs,
    open: close,
    high: close,
    low: close,
    close,
    volume: '10',
    quoteVolume: null,
  });
}

export function indicatorPoint(timeframeMinutes: number, closeTimeExclusiveMs: number, value: string | null, pair = PAIR): IndicatorPoint<IndicatorDecimal> {
  return Object.freeze({
    pair,
    timeframeMinutes,
    openTimeMs: closeTimeExclusiveMs - timeframeMinutes * 60_000,
    closeTimeExclusiveMs,
    value: value === null ? null : new IndicatorDecimal(value),
  });
}

export function snapshot(
  kernel: StrategyKernel,
  evaluationTimeMs: number,
  values: Readonly<Record<string, string | null>>,
  options: {
    readonly triggerClose?: string;
    readonly additionalClosedTimeframes?: readonly number[];
    readonly pointOverrides?: Readonly<Record<string, IndicatorPoint<unknown>>>;
    readonly omitAliases?: readonly string[];
  } = {},
): StrategyEvaluationSnapshot {
  const trigger = strategyCandle(kernel.triggerTimeframeMinutes, evaluationTimeMs, options.triggerClose ?? '100');
  const closedTimeframes = new Set([kernel.triggerTimeframeMinutes, ...(options.additionalClosedTimeframes ?? [])]);
  const latestCandles = new Map<number, StrategyCandleSnapshot>();
  const closed = [...closedTimeframes].map((timeframe) => strategyCandle(timeframe, evaluationTimeMs));
  for (const timeframe of new Set(kernel.indicatorRequirements.map((requirement) => requirement.timeframeMinutes))) {
    const closeTime = closedTimeframes.has(timeframe) ? evaluationTimeMs : evaluationTimeMs - kernel.triggerTimeframeMinutes * 60_000;
    latestCandles.set(timeframe, timeframe === kernel.triggerTimeframeMinutes ? trigger : strategyCandle(timeframe, closeTime));
  }
  const points: [string, IndicatorPoint<unknown>][] = [];
  for (const requirement of kernel.indicatorRequirements) {
    if (options.omitAliases?.includes(requirement.alias)) continue;
    const override = options.pointOverrides?.[requirement.alias];
    const closeTime = closedTimeframes.has(requirement.timeframeMinutes)
      ? evaluationTimeMs
      : evaluationTimeMs - kernel.triggerTimeframeMinutes * 60_000;
    points.push([requirement.alias, override ?? indicatorPoint(requirement.timeframeMinutes, closeTime, values[requirement.alias] ?? null)]);
  }
  return Object.freeze({
    pair: PAIR,
    evaluationTimeMs,
    triggerClosedCandle: trigger,
    latestClosedCandleByTimeframe: new StrategyReadonlyMap(latestCandles.entries()),
    candlesClosedAtThisTimestamp: Object.freeze(closed),
    latestIndicatorPointByAlias: new StrategyReadonlyMap(points),
  });
}

export function bootstrap(...timeframes: number[]): readonly { readonly timeframeMinutes: number; readonly bootstrapStartOpenTimeMs: number }[] {
  return timeframes.map((timeframeMinutes) => ({ timeframeMinutes, bootstrapStartOpenTimeMs: BASE }));
}
