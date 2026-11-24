import type { IndicatorPoint } from '../../indicators/types';
import { StrategyCalcDecimal, toStrategyCalc, type StrategyCalc } from '../core/decimal';
import { BaseStrategyKernel, type StrategyOutcome } from '../core/kernel';
import { deepCopyFreeze } from '../core/immutable';
import { freezeNormalizedParameters, positiveDecimalParameter, requireExactObject, strategyPeriod, strategyTimeframe } from '../core/parameters';
import type { StrategyConstructionDescription, StrategyDefinition, StrategyEvaluationSnapshot, StrategyIndicatorBootstrapIdentityEntry } from '../core/types';

type Parameters = Readonly<{ timeframeMinutes: number; atrPeriod: number; multiplier: string }> & Readonly<Record<string, unknown>>;
export function normalizeSupertrendParameters(raw: unknown): Parameters {
  const p = requireExactObject(raw, ['timeframeMinutes', 'atrPeriod', 'multiplier'], 'SuperTrend parameters');
  return freezeNormalizedParameters({ timeframeMinutes: strategyTimeframe(p.timeframeMinutes, 'timeframeMinutes'), atrPeriod: strategyPeriod(p.atrPeriod, 'atrPeriod'),
    multiplier: positiveDecimalParameter(typeof p.multiplier === 'number' ? String(p.multiplier) : p.multiplier, 'multiplier') });
}
function describe(p: Parameters): StrategyConstructionDescription<Parameters> {
  return deepCopyFreeze({ normalizedParameters: p, triggerTimeframeMinutes: p.timeframeMinutes,
    indicatorRequirements: [{ alias: 'atr', indicatorType: 'ATR', timeframeMinutes: p.timeframeMinutes, parameters: { period: p.atrPeriod } }] });
}
export class SupertrendStrategyKernel extends BaseStrategyKernel {
  #upper: StrategyCalc | null = null;
  #lower: StrategyCalc | null = null;
  #previousClose: StrategyCalc | null = null;
  #direction: 'LONG' | 'SHORT' = 'SHORT';
  readonly #multiplier: StrategyCalc;
  public constructor(pair: string, p: Parameters, bootstrap: readonly StrategyIndicatorBootstrapIdentityEntry[]) {
    const d = describe(p);
    super({ pair, strategyId: 'SUPERTREND', strategyVersion: '1.0.0', normalizedParameters: p, triggerTimeframeMinutes: d.triggerTimeframeMinutes,
      indicatorRequirements: d.indicatorRequirements, indicatorBootstrapIdentity: bootstrap });
    this.#multiplier = new StrategyCalcDecimal(p.multiplier);
  }
  protected evaluateValidated(snapshot: StrategyEvaluationSnapshot, points: ReadonlyMap<string, IndicatorPoint<unknown>>): StrategyOutcome {
    const atr = this.indicatorValue(points, 'atr');
    if (atr === null) return { status: 'WARMING', targetExposure: null, reasonCodes: ['SUPERTREND_ATR_WARMING'] };
    const c = snapshot.triggerClosedCandle, close = toStrategyCalc(c.close), mid = toStrategyCalc(c.high).plus(c.low).div(2);
    const distance = toStrategyCalc(atr).times(this.#multiplier), basicUpper = mid.plus(distance), basicLower = mid.minus(distance);
    const upper = this.#upper === null || basicUpper.lt(this.#upper) || this.#previousClose!.gt(this.#upper) ? basicUpper : this.#upper;
    const lower = this.#lower === null || basicLower.gt(this.#lower) || this.#previousClose!.lt(this.#lower) ? basicLower : this.#lower;
    const direction = this.#upper === null ? 'SHORT' : this.#direction === 'SHORT' ? close.gt(upper) ? 'LONG' : 'SHORT' : close.lt(lower) ? 'SHORT' : 'LONG';
    return { status: 'READY', targetExposure: direction, reasonCodes: [direction === 'LONG' ? 'SUPERTREND_UP' : 'SUPERTREND_DOWN'],
      commit: () => { this.#upper = upper; this.#lower = lower; this.#previousClose = close; this.#direction = direction; } };
  }
}
export const supertrendV1Definition: StrategyDefinition<Parameters> = Object.freeze({ strategyId: 'SUPERTREND', strategyVersion: '1.0.0', normalizeParameters: normalizeSupertrendParameters,
  describeConstruction: (raw: unknown) => describe(normalizeSupertrendParameters(raw)),
  createKernel: (config: { readonly pair: string; readonly parameters: unknown; readonly indicatorBootstrapIdentity: readonly StrategyIndicatorBootstrapIdentityEntry[] }) => new SupertrendStrategyKernel(config.pair, normalizeSupertrendParameters(config.parameters), config.indicatorBootstrapIdentity) });
