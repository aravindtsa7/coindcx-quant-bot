import type { IndicatorPoint, PriceSource } from '../../indicators/types';
import { toStrategyCalc } from '../core/decimal';
import { StrategyError } from '../core/errors';
import { BaseStrategyKernel, type StrategyOutcome } from '../core/kernel';
import { freezeNormalizedParameters, requireExactObject, strategyPeriod, strategyPriceSource, strategyTimeframe } from '../core/parameters';
import type { StrategyDefinition, StrategyEvaluationSnapshot, StrategyIndicatorBootstrapIdentityEntry, StrategyKernel } from '../core/types';

export type EmaTrendParameters = Readonly<{
  timeframeMinutes: number;
  fastPeriod: number;
  slowPeriod: number;
  priceSource: PriceSource;
}> & Readonly<Record<string, unknown>>;

export function normalizeEmaTrendParameters(raw: unknown): EmaTrendParameters {
  const value = requireExactObject(raw, ['timeframeMinutes', 'fastPeriod', 'slowPeriod', 'priceSource'], 'EMA Trend parameters');
  const parameters = {
    timeframeMinutes: strategyTimeframe(value.timeframeMinutes, 'timeframeMinutes'),
    fastPeriod: strategyPeriod(value.fastPeriod, 'fastPeriod'),
    slowPeriod: strategyPeriod(value.slowPeriod, 'slowPeriod'),
    priceSource: strategyPriceSource(value.priceSource, 'priceSource'),
  };
  if (parameters.slowPeriod < 2 || parameters.fastPeriod >= parameters.slowPeriod) {
    throw new StrategyError('INVALID_STRATEGY_PARAMETER', 'EMA Trend requires fastPeriod < slowPeriod and slowPeriod >= 2');
  }
  return freezeNormalizedParameters(parameters) as EmaTrendParameters;
}

export class EmaTrendKernel extends BaseStrategyKernel {
  public constructor(pair: string, parameters: EmaTrendParameters, bootstrap: readonly StrategyIndicatorBootstrapIdentityEntry[]) {
    const requirements = [
      { alias: 'ema.fast', indicatorType: 'EMA' as const, timeframeMinutes: parameters.timeframeMinutes, parameters: { period: parameters.fastPeriod }, priceSource: parameters.priceSource },
      { alias: 'ema.slow', indicatorType: 'EMA' as const, timeframeMinutes: parameters.timeframeMinutes, parameters: { period: parameters.slowPeriod }, priceSource: parameters.priceSource },
    ];
    super({ pair, strategyId: 'EMA_TREND', strategyVersion: '1.0.0', normalizedParameters: parameters, indicatorBootstrapIdentity: bootstrap, triggerTimeframeMinutes: parameters.timeframeMinutes, indicatorRequirements: requirements });
  }
  protected evaluateValidated(_snapshot: StrategyEvaluationSnapshot, points: ReadonlyMap<string, IndicatorPoint<unknown>>): StrategyOutcome {
    const fast = this.indicatorValue(points, 'ema.fast');
    const slow = this.indicatorValue(points, 'ema.slow');
    if (fast === null || slow === null) return { status: 'WARMING', targetExposure: null, reasonCodes: ['EMA_WARMING'] };
    const comparison = toStrategyCalc(fast, 'EMA fast').comparedTo(toStrategyCalc(slow, 'EMA slow'));
    if (comparison > 0) return { status: 'READY', targetExposure: 'LONG', reasonCodes: ['EMA_FAST_ABOVE_SLOW'] };
    if (comparison < 0) return { status: 'READY', targetExposure: 'SHORT', reasonCodes: ['EMA_FAST_BELOW_SLOW'] };
    return { status: 'READY', targetExposure: 'FLAT', reasonCodes: ['EMA_FAST_EQUALS_SLOW'] };
  }
}

export const emaTrendV1Definition: StrategyDefinition<EmaTrendParameters> = Object.freeze({
  strategyId: 'EMA_TREND',
  strategyVersion: '1.0.0',
  normalizeParameters: normalizeEmaTrendParameters,
  createKernel(config: { readonly pair: string; readonly parameters: unknown; readonly indicatorBootstrapIdentity: readonly StrategyIndicatorBootstrapIdentityEntry[] }): StrategyKernel {
    return new EmaTrendKernel(config.pair, normalizeEmaTrendParameters(config.parameters), config.indicatorBootstrapIdentity);
  },
});
