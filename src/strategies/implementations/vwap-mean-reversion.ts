import type { IndicatorPoint } from '../../indicators/types';
import type { RollingVwapValue } from '../../indicators/rolling-vwap';
import { toStrategyCalc } from '../core/decimal';
import { BaseStrategyKernel, type StrategyOutcome } from '../core/kernel';
import { deepCopyFreeze } from '../core/immutable';
import { freezeNormalizedParameters, positiveDecimalParameter, requireExactObject, strategyPeriod, strategyTimeframe } from '../core/parameters';
import type { StrategyConstructionDescription, StrategyDefinition, StrategyEvaluationSnapshot, StrategyIndicatorBootstrapIdentityEntry, StrategyTargetExposure } from '../core/types';

type Parameters = Readonly<{ timeframeMinutes: number; vwapPeriod: number; bandStdDev: string }> & Readonly<Record<string, unknown>>;
export function normalizeVwapMeanReversionParameters(raw: unknown): Parameters {
  const p = requireExactObject(raw, ['timeframeMinutes', 'vwapPeriod', 'bandStdDev'], 'Rolling VWAP parameters');
  return freezeNormalizedParameters({ timeframeMinutes: strategyTimeframe(p.timeframeMinutes, 'timeframeMinutes'), vwapPeriod: strategyPeriod(p.vwapPeriod, 'vwapPeriod'),
    bandStdDev: positiveDecimalParameter(typeof p.bandStdDev === 'number' ? String(p.bandStdDev) : p.bandStdDev, 'bandStdDev') });
}
function describe(p: Parameters): StrategyConstructionDescription<Parameters> {
  return deepCopyFreeze({ normalizedParameters: p, triggerTimeframeMinutes: p.timeframeMinutes,
    indicatorRequirements: [{ alias: 'vwap', indicatorType: 'ROLLING_VWAP', timeframeMinutes: p.timeframeMinutes, parameters: { period: p.vwapPeriod }, priceSource: 'HLC3' }] });
}
export class VwapMeanReversionKernel extends BaseStrategyKernel {
  #target: StrategyTargetExposure = 'FLAT';
  public constructor(pair: string, p: Parameters, bootstrap: readonly StrategyIndicatorBootstrapIdentityEntry[]) {
    const d = describe(p);
    super({ pair, strategyId: 'VWAP_MEAN_REVERSION', strategyVersion: '1.0.0', normalizedParameters: p, triggerTimeframeMinutes: d.triggerTimeframeMinutes,
      indicatorRequirements: d.indicatorRequirements, indicatorBootstrapIdentity: bootstrap });
  }
  protected evaluateValidated(snapshot: StrategyEvaluationSnapshot, points: ReadonlyMap<string, IndicatorPoint<unknown>>): StrategyOutcome {
    const point = points.get('vwap')!.value as RollingVwapValue | null;
    if (point === null) return { status: 'WARMING', targetExposure: null, reasonCodes: ['VWAP_WARMING'] };
    const mean = toStrategyCalc(point.value), deviation = toStrategyCalc(point.stdDev).times(String(this.normalizedParameters['bandStdDev']));
    const close = toStrategyCalc(snapshot.triggerClosedCandle.close);
    let target = this.#target, reason = 'VWAP_HOLD';
    if (toStrategyCalc(point.volume).isZero() || deviation.isZero()) { target = 'FLAT'; reason = 'VWAP_NO_VOLUME_OR_VARIANCE'; }
    else if (target === 'LONG' && close.gte(mean) || target === 'SHORT' && close.lte(mean)) { target = 'FLAT'; reason = 'VWAP_REVERTED_TO_MEAN'; }
    else if (close.lte(mean.minus(deviation))) { target = 'LONG'; reason = 'VWAP_LOWER_BAND'; }
    else if (close.gte(mean.plus(deviation))) { target = 'SHORT'; reason = 'VWAP_UPPER_BAND'; }
    return { status: 'READY', targetExposure: target, reasonCodes: [reason], commit: () => { this.#target = target; } };
  }
}
export const vwapMeanReversionV1Definition: StrategyDefinition<Parameters> = Object.freeze({ strategyId: 'VWAP_MEAN_REVERSION', strategyVersion: '1.0.0', normalizeParameters: normalizeVwapMeanReversionParameters,
  describeConstruction: (raw: unknown) => describe(normalizeVwapMeanReversionParameters(raw)),
  createKernel: (config: { readonly pair: string; readonly parameters: unknown; readonly indicatorBootstrapIdentity: readonly StrategyIndicatorBootstrapIdentityEntry[] }) => new VwapMeanReversionKernel(config.pair, normalizeVwapMeanReversionParameters(config.parameters), config.indicatorBootstrapIdentity) });
