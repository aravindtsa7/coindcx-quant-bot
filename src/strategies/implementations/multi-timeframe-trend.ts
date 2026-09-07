import type { IndicatorPoint, PriceSource } from '../../indicators/types';
import { toStrategyCalc } from '../core/decimal';
import { StrategyError } from '../core/errors';
import { BaseStrategyKernel, type StrategyOutcome } from '../core/kernel';
import { freezeNormalizedParameters, requireExactObject, sortedDistinctTimeframes, strategyPeriod, strategyPriceSource } from '../core/parameters';
import type { StrategyDefinition, StrategyEvaluationSnapshot, StrategyIndicatorBootstrapIdentityEntry, StrategyIndicatorRequirement, StrategyKernel } from '../core/types';

export type MultiTimeframeTrendParameters = Readonly<{
  timeframes: readonly number[];
  fastPeriod: number;
  slowPeriod: number;
  priceSource: PriceSource;
}> & Readonly<Record<string, unknown>>;

export function normalizeMultiTimeframeTrendParameters(raw: unknown): MultiTimeframeTrendParameters {
  const value = requireExactObject(raw, ['timeframes', 'fastPeriod', 'slowPeriod', 'priceSource'], 'Multi-Timeframe Trend parameters');
  const parameters = {
    timeframes: sortedDistinctTimeframes(value.timeframes, 'timeframes'),
    fastPeriod: strategyPeriod(value.fastPeriod, 'fastPeriod'),
    slowPeriod: strategyPeriod(value.slowPeriod, 'slowPeriod'),
    priceSource: strategyPriceSource(value.priceSource, 'priceSource'),
  };
  if (parameters.slowPeriod < 2 || parameters.fastPeriod >= parameters.slowPeriod) {
    throw new StrategyError('INVALID_STRATEGY_PARAMETER', 'Multi-Timeframe Trend requires fastPeriod < slowPeriod and slowPeriod >= 2');
  }
  return freezeNormalizedParameters(parameters) as MultiTimeframeTrendParameters;
}

function requirements(parameters: MultiTimeframeTrendParameters): readonly StrategyIndicatorRequirement[] {
  return parameters.timeframes.flatMap((timeframe) => [
    { alias: `tf.${timeframe}.ema.fast`, indicatorType: 'EMA' as const, timeframeMinutes: timeframe, parameters: { period: parameters.fastPeriod }, priceSource: parameters.priceSource },
    { alias: `tf.${timeframe}.ema.slow`, indicatorType: 'EMA' as const, timeframeMinutes: timeframe, parameters: { period: parameters.slowPeriod }, priceSource: parameters.priceSource },
  ]);
}

export class MultiTimeframeTrendKernel extends BaseStrategyKernel {
  readonly #timeframes: readonly number[];
  public constructor(pair: string, parameters: MultiTimeframeTrendParameters, bootstrap: readonly StrategyIndicatorBootstrapIdentityEntry[]) {
    const triggerTimeframeMinutes = parameters.timeframes[0];
    if (triggerTimeframeMinutes === undefined) throw new StrategyError('INVALID_STRATEGY_PARAMETER', 'Multi-Timeframe Trend requires a trigger timeframe');
    super({ pair, strategyId: 'MULTI_TIMEFRAME_TREND', strategyVersion: '1.0.0', normalizedParameters: parameters,
      indicatorBootstrapIdentity: bootstrap, triggerTimeframeMinutes, indicatorRequirements: requirements(parameters) });
    this.#timeframes = parameters.timeframes;
  }
  protected evaluateValidated(_snapshot: StrategyEvaluationSnapshot, points: ReadonlyMap<string, IndicatorPoint<unknown>>): StrategyOutcome {
    const states: ('BULLISH' | 'BEARISH' | 'NEUTRAL')[] = [];
    for (const timeframe of this.#timeframes) {
      const fast = this.indicatorValue(points, `tf.${timeframe}.ema.fast`);
      const slow = this.indicatorValue(points, `tf.${timeframe}.ema.slow`);
      if (fast === null || slow === null) return { status: 'WARMING', targetExposure: null, reasonCodes: ['MTF_WARMING'] };
      const comparison = toStrategyCalc(fast, `MTF ${timeframe} fast EMA`).comparedTo(toStrategyCalc(slow, `MTF ${timeframe} slow EMA`));
      states.push(comparison > 0 ? 'BULLISH' : comparison < 0 ? 'BEARISH' : 'NEUTRAL');
    }
    if (states.every((state) => state === 'BULLISH')) return { status: 'READY', targetExposure: 'LONG', reasonCodes: ['MTF_ALL_BULLISH'] };
    if (states.every((state) => state === 'BEARISH')) return { status: 'READY', targetExposure: 'SHORT', reasonCodes: ['MTF_ALL_BEARISH'] };
    return { status: 'READY', targetExposure: 'FLAT', reasonCodes: ['MTF_MIXED'] };
  }
}

export const multiTimeframeTrendV1Definition: StrategyDefinition<MultiTimeframeTrendParameters> = Object.freeze({
  strategyId: 'MULTI_TIMEFRAME_TREND', strategyVersion: '1.0.0', normalizeParameters: normalizeMultiTimeframeTrendParameters,
  createKernel(config: { readonly pair: string; readonly parameters: unknown; readonly indicatorBootstrapIdentity: readonly StrategyIndicatorBootstrapIdentityEntry[] }): StrategyKernel {
    return new MultiTimeframeTrendKernel(config.pair, normalizeMultiTimeframeTrendParameters(config.parameters), config.indicatorBootstrapIdentity);
  },
});
