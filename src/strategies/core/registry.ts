import { StrategyError } from './errors';
import type { StrategyDefinition, StrategyIndicatorBootstrapIdentityEntry, StrategyKernel } from './types';

function key(strategyId: string, strategyVersion: string): string {
  return `${strategyId}\u0000${strategyVersion}`;
}

export class StrategyRegistry {
  readonly #definitions = new Map<string, StrategyDefinition>();

  public register(definition: StrategyDefinition): void {
    const definitionKey = key(definition.strategyId, definition.strategyVersion);
    if (this.#definitions.has(definitionKey)) {
      throw new StrategyError('STRATEGY_REGISTRY_CONFLICT', `Strategy already registered: ${definition.strategyId}@${definition.strategyVersion}`);
    }
    this.#definitions.set(definitionKey, definition);
  }

  public get(strategyId: string, strategyVersion: string): StrategyDefinition {
    const definition = this.#definitions.get(key(strategyId, strategyVersion));
    if (definition === undefined) throw new StrategyError('STRATEGY_NOT_FOUND', `Strategy not found: ${strategyId}@${strategyVersion}`);
    return definition;
  }

  public has(strategyId: string, strategyVersion: string): boolean {
    return this.#definitions.has(key(strategyId, strategyVersion));
  }

  public list(): readonly { readonly strategyId: string; readonly strategyVersion: string }[] {
    return Object.freeze([...this.#definitions.values()]
      .map(({ strategyId, strategyVersion }) => Object.freeze({ strategyId, strategyVersion }))
      .sort((left, right) => left.strategyId < right.strategyId ? -1 : left.strategyId > right.strategyId ? 1 :
        left.strategyVersion < right.strategyVersion ? -1 : left.strategyVersion > right.strategyVersion ? 1 : 0));
  }

  public create(input: {
    readonly strategyId: string;
    readonly strategyVersion: string;
    readonly pair: string;
    readonly parameters: unknown;
    readonly indicatorBootstrapIdentity: readonly StrategyIndicatorBootstrapIdentityEntry[];
  }): StrategyKernel {
    return this.get(input.strategyId, input.strategyVersion).createKernel({
      pair: input.pair,
      parameters: input.parameters,
      indicatorBootstrapIdentity: input.indicatorBootstrapIdentity,
    });
  }
}
