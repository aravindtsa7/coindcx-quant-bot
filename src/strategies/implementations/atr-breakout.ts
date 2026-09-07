import type { IndicatorPoint } from '../../indicators/types';
import { StrategyCalcDecimal, toStrategyCalc, type StrategyCalc } from '../core/decimal';
import { StrategyError } from '../core/errors';
import { BaseStrategyKernel, type StrategyOutcome } from '../core/kernel';
import { deepCopyFreeze } from '../core/immutable';
import { freezeNormalizedParameters, positiveDecimalParameter, requireExactObject, strategyPeriod, strategyTimeframe } from '../core/parameters';
import type { StrategyConstructionDescription, StrategyDefinition, StrategyEvaluationSnapshot, StrategyIndicatorBootstrapIdentityEntry, StrategyIndicatorRequirement, StrategyKernel } from '../core/types';

export type AtrBreakoutParameters = Readonly<{
  timeframeMinutes: number;
  atrPeriod: number;
  breakoutMultiplier: string;
}> & Readonly<Record<string, unknown>>;

export function normalizeAtrBreakoutParameters(raw: unknown): AtrBreakoutParameters {
  const value = requireExactObject(raw, ['timeframeMinutes', 'atrPeriod', 'breakoutMultiplier'], 'ATR Breakout parameters');
  return freezeNormalizedParameters({
    timeframeMinutes: strategyTimeframe(value.timeframeMinutes, 'timeframeMinutes'),
    atrPeriod: strategyPeriod(value.atrPeriod, 'atrPeriod'),
    breakoutMultiplier: positiveDecimalParameter(value.breakoutMultiplier, 'breakoutMultiplier'),
  }) as AtrBreakoutParameters;
}

function describe(parameters: AtrBreakoutParameters): StrategyConstructionDescription<AtrBreakoutParameters> {
  const indicatorRequirements: readonly StrategyIndicatorRequirement[] = [
    { alias: 'atr', indicatorType: 'ATR', timeframeMinutes: parameters.timeframeMinutes, parameters: { period: parameters.atrPeriod } },
  ];
  return deepCopyFreeze({ normalizedParameters: parameters, triggerTimeframeMinutes: parameters.timeframeMinutes, indicatorRequirements });
}

export class AtrBreakoutKernel extends BaseStrategyKernel {
  readonly #multiplier: StrategyCalc;
  #previousReadyClose: StrategyCalc | null = null;
  #previousReadyAtr: StrategyCalc | null = null;
  public constructor(pair: string, parameters: AtrBreakoutParameters, bootstrap: readonly StrategyIndicatorBootstrapIdentityEntry[]) {
    const description = describe(parameters);
    super({
      pair,
      strategyId: 'ATR_BREAKOUT',
      strategyVersion: '1.0.0',
      normalizedParameters: description.normalizedParameters,
      indicatorBootstrapIdentity: bootstrap,
      triggerTimeframeMinutes: description.triggerTimeframeMinutes,
      indicatorRequirements: description.indicatorRequirements,
    });
    this.#multiplier = new StrategyCalcDecimal(parameters.breakoutMultiplier);
  }
  protected evaluateValidated(snapshot: StrategyEvaluationSnapshot, points: ReadonlyMap<string, IndicatorPoint<unknown>>): StrategyOutcome {
    const atrValue = this.indicatorValue(points, 'atr');
    if (atrValue === null) return { status: 'WARMING', targetExposure: null, reasonCodes: ['ATR_INDICATOR_WARMING'] };
    const currentClose = toStrategyCalc(snapshot.triggerClosedCandle.close, 'ATR trigger close');
    const currentAtr = toStrategyCalc(atrValue, 'ATR value');
    if (currentAtr.isNegative()) throw new StrategyError('STRATEGY_NUMERIC_FAILURE', 'ATR value must not be negative');
    if (this.#previousReadyClose === null || this.#previousReadyAtr === null) {
      return {
        status: 'WARMING', targetExposure: null, reasonCodes: ['ATR_REFERENCE_WARMING'],
        commit: () => { this.#previousReadyClose = currentClose; this.#previousReadyAtr = currentAtr; },
      };
    }
    const upper = this.#previousReadyClose.plus(this.#previousReadyAtr.times(this.#multiplier));
    const lower = this.#previousReadyClose.minus(this.#previousReadyAtr.times(this.#multiplier));
    const outcome: Omit<StrategyOutcome, 'commit'> = currentClose.gt(upper)
      ? { status: 'READY', targetExposure: 'LONG', reasonCodes: ['ATR_BREAKOUT_UP'] }
      : currentClose.lt(lower)
        ? { status: 'READY', targetExposure: 'SHORT', reasonCodes: ['ATR_BREAKOUT_DOWN'] }
        : { status: 'READY', targetExposure: 'FLAT', reasonCodes: ['ATR_NO_BREAKOUT'] };
    return { ...outcome, commit: () => { this.#previousReadyClose = currentClose; this.#previousReadyAtr = currentAtr; } };
  }
}

export const atrBreakoutV1Definition: StrategyDefinition<AtrBreakoutParameters> = Object.freeze({
  strategyId: 'ATR_BREAKOUT', strategyVersion: '1.0.0', normalizeParameters: normalizeAtrBreakoutParameters,
  describeConstruction(parameters: unknown): StrategyConstructionDescription<AtrBreakoutParameters> {
    return describe(normalizeAtrBreakoutParameters(parameters));
  },
  createKernel(config: { readonly pair: string; readonly parameters: unknown; readonly indicatorBootstrapIdentity: readonly StrategyIndicatorBootstrapIdentityEntry[] }): StrategyKernel {
    return new AtrBreakoutKernel(config.pair, normalizeAtrBreakoutParameters(config.parameters), config.indicatorBootstrapIdentity);
  },
});
