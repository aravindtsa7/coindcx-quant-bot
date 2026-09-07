import type { IndicatorPoint, PriceSource } from '../../indicators/types';
import { StrategyCalcDecimal, toStrategyCalc } from '../core/decimal';
import { StrategyError } from '../core/errors';
import { BaseStrategyKernel, type StrategyOutcome } from '../core/kernel';
import { freezeNormalizedParameters, positiveDecimalParameter, requireExactObject, strategyPeriod, strategyPriceSource, strategyTimeframe } from '../core/parameters';
import type { StrategyDefinition, StrategyEvaluationSnapshot, StrategyIndicatorBootstrapIdentityEntry, StrategyKernel } from '../core/types';

export type RsiMomentumParameters = Readonly<{
  timeframeMinutes: number;
  period: number;
  longThreshold: string;
  shortThreshold: string;
  priceSource: PriceSource;
}> & Readonly<Record<string, unknown>>;

export function normalizeRsiMomentumParameters(raw: unknown): RsiMomentumParameters {
  const value = requireExactObject(raw, ['timeframeMinutes', 'period', 'longThreshold', 'shortThreshold', 'priceSource'], 'RSI Momentum parameters');
  const shortThreshold = positiveDecimalParameter(value.shortThreshold, 'shortThreshold');
  const longThreshold = positiveDecimalParameter(value.longThreshold, 'longThreshold');
  const short = new StrategyCalcDecimal(shortThreshold);
  const long = new StrategyCalcDecimal(longThreshold);
  if (!short.lt(long) || !long.lt(100)) {
    throw new StrategyError('INVALID_STRATEGY_PARAMETER', 'RSI thresholds require 0 < shortThreshold < longThreshold < 100');
  }
  return freezeNormalizedParameters({
    timeframeMinutes: strategyTimeframe(value.timeframeMinutes, 'timeframeMinutes'),
    period: strategyPeriod(value.period, 'period'), longThreshold, shortThreshold,
    priceSource: strategyPriceSource(value.priceSource, 'priceSource'),
  }) as RsiMomentumParameters;
}

export class RsiMomentumKernel extends BaseStrategyKernel {
  readonly #longThreshold: InstanceType<typeof StrategyCalcDecimal>;
  readonly #shortThreshold: InstanceType<typeof StrategyCalcDecimal>;
  public constructor(pair: string, parameters: RsiMomentumParameters, bootstrap: readonly StrategyIndicatorBootstrapIdentityEntry[]) {
    super({ pair, strategyId: 'RSI_MOMENTUM', strategyVersion: '1.0.0', normalizedParameters: parameters, indicatorBootstrapIdentity: bootstrap,
      triggerTimeframeMinutes: parameters.timeframeMinutes,
      indicatorRequirements: [{ alias: 'rsi', indicatorType: 'RSI', timeframeMinutes: parameters.timeframeMinutes, parameters: { period: parameters.period }, priceSource: parameters.priceSource }],
    });
    this.#longThreshold = new StrategyCalcDecimal(parameters.longThreshold);
    this.#shortThreshold = new StrategyCalcDecimal(parameters.shortThreshold);
  }
  protected evaluateValidated(_snapshot: StrategyEvaluationSnapshot, points: ReadonlyMap<string, IndicatorPoint<unknown>>): StrategyOutcome {
    const value = this.indicatorValue(points, 'rsi');
    if (value === null) return { status: 'WARMING', targetExposure: null, reasonCodes: ['RSI_WARMING'] };
    const rsi = toStrategyCalc(value, 'RSI value');
    if (rsi.lt(0) || rsi.gt(100)) throw new StrategyError('STRATEGY_NUMERIC_FAILURE', 'RSI value must be between zero and 100');
    if (rsi.gte(this.#longThreshold)) return { status: 'READY', targetExposure: 'LONG', reasonCodes: ['RSI_LONG_THRESHOLD'] };
    if (rsi.lte(this.#shortThreshold)) return { status: 'READY', targetExposure: 'SHORT', reasonCodes: ['RSI_SHORT_THRESHOLD'] };
    return { status: 'READY', targetExposure: 'FLAT', reasonCodes: ['RSI_NEUTRAL'] };
  }
}

export const rsiMomentumV1Definition: StrategyDefinition<RsiMomentumParameters> = Object.freeze({
  strategyId: 'RSI_MOMENTUM', strategyVersion: '1.0.0', normalizeParameters: normalizeRsiMomentumParameters,
  createKernel(config: { readonly pair: string; readonly parameters: unknown; readonly indicatorBootstrapIdentity: readonly StrategyIndicatorBootstrapIdentityEntry[] }): StrategyKernel {
    return new RsiMomentumKernel(config.pair, normalizeRsiMomentumParameters(config.parameters), config.indicatorBootstrapIdentity);
  },
});
