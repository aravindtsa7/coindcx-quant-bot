import { MAX_STRATEGY_PERIOD } from '../../strategies/core/parameters';
import type { StrategyIndicatorBootstrapIdentityEntry, StrategyIndicatorRequirement } from '../../strategies/core/types';
import { StrategyCoinMatrixError } from './errors';
import { matrixDeepCopyFreeze } from './immutable';

const MINUTE_MS = 60_000;

function safeProduct(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new StrategyCoinMatrixError('TIMEFRAME_ALIGNMENT_FAILURE', `${label} exceeds safe integer arithmetic`);
  return result;
}

function gcd(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) { const remainder = a % b; a = b; b = remainder; }
  return a;
}

function lcm(left: number, right: number): number { return safeProduct(left / gcd(left, right), right, 'Timeframe LCM'); }

export function deriveIndicatorBootstrapIdentity(
  requirements: readonly StrategyIndicatorRequirement[],
  analysisStartMs: number,
): { readonly bootstrapFromInclusiveMs: number; readonly entries: readonly StrategyIndicatorBootstrapIdentityEntry[] } {
  if (requirements.length === 0) throw new StrategyCoinMatrixError('MATRIX_UNSUPPORTED_INDICATOR_BOOTSTRAP_POLICY', 'Strategy must declare at least one supported indicator requirement');
  const warmupByTimeframe = new Map<number, number>();
  for (const requirement of requirements) {
    if (requirement.indicatorType !== 'EMA' && requirement.indicatorType !== 'ATR' && requirement.indicatorType !== 'RSI') {
      throw new StrategyCoinMatrixError('MATRIX_UNSUPPORTED_INDICATOR_BOOTSTRAP_POLICY', 'Indicator type is unsupported by P11 bootstrap policy V1', { details: { indicatorType: requirement.indicatorType } });
    }
    const period = requirement.parameters.period;
    if (!Number.isSafeInteger(period) || (period as number) < 1 || (period as number) > MAX_STRATEGY_PERIOD ||
        !Number.isSafeInteger(requirement.timeframeMinutes) || requirement.timeframeMinutes < 1) {
      throw new StrategyCoinMatrixError('MATRIX_UNSUPPORTED_INDICATOR_BOOTSTRAP_POLICY', 'Supported indicator requirement has invalid period or timeframe');
    }
    const warmupBars = safeProduct(3, period as number, 'Indicator warmup bars');
    const warmupMinutes = safeProduct(warmupBars, requirement.timeframeMinutes, 'Indicator warmup minutes');
    warmupByTimeframe.set(requirement.timeframeMinutes, Math.max(warmupByTimeframe.get(requirement.timeframeMinutes) ?? 0, warmupMinutes));
  }
  const timeframes = [...warmupByTimeframe.keys()].sort((left, right) => left - right);
  const alignmentMinutes = timeframes.reduce((current, timeframe) => lcm(current, timeframe), 1);
  const targetWarmupMinutes = Math.max(...warmupByTimeframe.values());
  const targetWarmupMs = safeProduct(targetWarmupMinutes, MINUTE_MS, 'Target warmup milliseconds');
  const alignmentMs = safeProduct(alignmentMinutes, MINUTE_MS, 'Bootstrap alignment milliseconds');
  const rawBootstrapStartMs = analysisStartMs - targetWarmupMs;
  if (!Number.isSafeInteger(rawBootstrapStartMs) || rawBootstrapStartMs < 0) {
    throw new StrategyCoinMatrixError('TIMEFRAME_ALIGNMENT_FAILURE', 'Bootstrap origin is outside safe non-negative epoch milliseconds');
  }
  const bootstrapFromInclusiveMs = Math.floor(rawBootstrapStartMs / alignmentMs) * alignmentMs;
  if (!Number.isSafeInteger(bootstrapFromInclusiveMs)) throw new StrategyCoinMatrixError('TIMEFRAME_ALIGNMENT_FAILURE', 'Aligned bootstrap origin is unsafe');
  const entries = timeframes.map((timeframeMinutes) => ({ timeframeMinutes, bootstrapStartOpenTimeMs: bootstrapFromInclusiveMs }));
  return matrixDeepCopyFreeze({ bootstrapFromInclusiveMs, entries });
}

export function configuredTimeframesFromRequirements(requirements: readonly StrategyIndicatorRequirement[]): readonly number[] {
  return Object.freeze([...new Set(requirements.map((requirement) => requirement.timeframeMinutes).filter((timeframe) => timeframe > 1))]
    .sort((left, right) => left - right));
}
