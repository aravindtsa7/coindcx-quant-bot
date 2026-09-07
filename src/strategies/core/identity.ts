import { strategySha256CanonicalJson } from './canonical';
import { strategyParameterError } from './errors';
import { deepCopyFreeze } from './immutable';
import { MAX_STRATEGY_TIMEFRAME_MINUTES } from './parameters';
import type {
  StrategyIndicatorBootstrapIdentityEntry,
  StrategyIndicatorRequirement,
} from './types';

const MINUTE_MS = 60_000;
const SHA256 = /^[a-f0-9]{64}$/;

export function computeStrategyParameterHash(parameters: Readonly<Record<string, unknown>>): string {
  return strategySha256CanonicalJson(parameters);
}

export function normalizeIndicatorBootstrapIdentity(
  entries: readonly StrategyIndicatorBootstrapIdentityEntry[],
  requirements: readonly StrategyIndicatorRequirement[],
): readonly StrategyIndicatorBootstrapIdentityEntry[] {
  if (!Array.isArray(entries)) throw strategyParameterError('indicatorBootstrapIdentity must be an array');
  const requiredTimeframes = [...new Set(requirements.map((requirement) => requirement.timeframeMinutes))]
    .sort((left, right) => left - right);
  const seen = new Set<number>();
  const normalized = entries.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw strategyParameterError(`indicatorBootstrapIdentity[${index}] must be an object`);
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== 'bootstrapStartOpenTimeMs' || keys[1] !== 'timeframeMinutes') {
      throw strategyParameterError(`indicatorBootstrapIdentity[${index}] has invalid keys`);
    }
    const timeframeMinutes = entry.timeframeMinutes;
    const bootstrapStartOpenTimeMs = entry.bootstrapStartOpenTimeMs;
    if (!Number.isSafeInteger(timeframeMinutes) || timeframeMinutes < 1 || timeframeMinutes > MAX_STRATEGY_TIMEFRAME_MINUTES) {
      throw strategyParameterError(`indicatorBootstrapIdentity[${index}].timeframeMinutes is invalid`);
    }
    if (seen.has(timeframeMinutes)) throw strategyParameterError('indicatorBootstrapIdentity contains a duplicate timeframe');
    seen.add(timeframeMinutes);
    if (!Number.isSafeInteger(bootstrapStartOpenTimeMs) || bootstrapStartOpenTimeMs < 0 || bootstrapStartOpenTimeMs % MINUTE_MS !== 0) {
      throw strategyParameterError(`indicatorBootstrapIdentity[${index}].bootstrapStartOpenTimeMs is invalid`);
    }
    return { timeframeMinutes, bootstrapStartOpenTimeMs };
  }).sort((left, right) => left.timeframeMinutes - right.timeframeMinutes);
  if (normalized.length !== requiredTimeframes.length ||
      normalized.some((entry, index) => entry.timeframeMinutes !== requiredTimeframes[index])) {
    throw strategyParameterError('indicatorBootstrapIdentity must exactly cover required strategy timeframes');
  }
  return deepCopyFreeze(normalized);
}

export function computeStrategyInstanceId(input: {
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly indicatorBootstrapIdentity: readonly StrategyIndicatorBootstrapIdentityEntry[];
}): string {
  if (typeof input.pair !== 'string' || input.pair.length === 0 || input.pair.trim() !== input.pair) {
    throw strategyParameterError('pair must be a non-empty exact string');
  }
  if (!SHA256.test(input.parameterHash)) throw strategyParameterError('parameterHash must be lowercase SHA-256');
  return strategySha256CanonicalJson({
    indicatorBootstrapIdentity: input.indicatorBootstrapIdentity,
    pair: input.pair,
    parameterHash: input.parameterHash,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
  });
}
