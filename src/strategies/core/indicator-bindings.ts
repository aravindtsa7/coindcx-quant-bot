import { AtrKernel } from '../../indicators/atr';
import { strategyCanonicalJson } from './canonical';
import { EmaKernel } from '../../indicators/ema';
import { RsiKernel } from '../../indicators/rsi';
import type { IndicatorKernel, PriceSource } from '../../indicators/types';
import { StrategyError } from './errors';
import type { StrategyIndicatorBinding, StrategyIndicatorRequirement, StrategyKernel } from './types';

function constructKernel(strategy: StrategyKernel, requirement: StrategyIndicatorRequirement): IndicatorKernel<unknown> {
  const bootstrap = strategy.indicatorBootstrapIdentity.find((entry) => entry.timeframeMinutes === requirement.timeframeMinutes);
  if (bootstrap === undefined) throw new StrategyError('STRATEGY_INPUT_INVALID', `Missing bootstrap origin for ${requirement.alias}`);
  const period = requirement.parameters.period;
  if (!Number.isSafeInteger(period)) throw new StrategyError('STRATEGY_INPUT_INVALID', `Invalid period for ${requirement.alias}`);
  const base = {
    pair: strategy.pair,
    timeframeMinutes: requirement.timeframeMinutes,
    bootstrapStartOpenTimeMs: bootstrap.bootstrapStartOpenTimeMs,
    period: period as number,
  };
  try {
    switch (requirement.indicatorType) {
      case 'EMA': return new EmaKernel({ ...base, priceSource: requirement.priceSource as PriceSource });
      case 'ATR': return new AtrKernel(base);
      case 'RSI': return new RsiKernel({ ...base, priceSource: requirement.priceSource as PriceSource });
      default: throw new StrategyError('STRATEGY_INPUT_INVALID', `Unsupported Phase 10 indicator type: ${requirement.indicatorType}`);
    }
  } catch (error) {
    if (error instanceof StrategyError) throw error;
    throw new StrategyError('STRATEGY_INPUT_INVALID', `Unable to construct Phase 8 kernel for ${requirement.alias}`, { cause: error });
  }
}

function optionalSource(value: { readonly priceSource?: PriceSource }): PriceSource | undefined {
  return value.priceSource;
}

export function assertStrategyIndicatorBindings(strategy: StrategyKernel, bindings: readonly StrategyIndicatorBinding[]): void {
  if (bindings.length !== strategy.indicatorRequirements.length) {
    throw new StrategyError('STRATEGY_INPUT_INVALID', 'Indicator bindings do not exactly cover strategy requirements');
  }
  const aliases = new Set<string>();
  for (const requirement of strategy.indicatorRequirements) {
    const matches = bindings.filter((binding) => binding.alias === requirement.alias);
    if (matches.length !== 1 || aliases.has(requirement.alias)) {
      throw new StrategyError('STRATEGY_INPUT_INVALID', `Indicator alias binding is missing or duplicated: ${requirement.alias}`);
    }
    aliases.add(requirement.alias);
    const binding = matches[0];
    if (binding === undefined) throw new StrategyError('STRATEGY_INPUT_INVALID', `Missing indicator binding: ${requirement.alias}`);
    const origin = strategy.indicatorBootstrapIdentity.find((entry) => entry.timeframeMinutes === requirement.timeframeMinutes);
    const segment = binding.kernel.segment;
    if (binding.requirement.alias !== requirement.alias || binding.kernel.isTerminated || origin === undefined ||
        segment.pair !== strategy.pair || segment.timeframeMinutes !== requirement.timeframeMinutes ||
        segment.indicatorType !== requirement.indicatorType ||
        strategyCanonicalJson(segment.parameters) !== strategyCanonicalJson(requirement.parameters) ||
        optionalSource(segment) !== optionalSource(requirement) ||
        segment.bootstrapStartOpenTimeMs !== origin.bootstrapStartOpenTimeMs) {
      throw new StrategyError('STRATEGY_INPUT_INVALID', `Phase 8 indicator segment mismatch for ${requirement.alias}`);
    }
  }
}

export function createStrategyIndicatorBindings(strategy: StrategyKernel): readonly StrategyIndicatorBinding[] {
  const bindings = strategy.indicatorRequirements.map((requirement) => Object.freeze({
    alias: requirement.alias,
    requirement,
    kernel: constructKernel(strategy, requirement),
  }));
  assertStrategyIndicatorBindings(strategy, bindings);
  return Object.freeze(bindings);
}
