import { CoinRuntime, MarketDataSubscriptionIntent } from './types';

/**
 * Derives the market data subscription intent for a coin runtime.
 * Prepares explicit metadata for downstream real-time streaming ingestion.
 *
 * Invariant Guarantees:
 * - Pure metadata derivation without network side effects.
 * - If coin has never been discovered (instrument === null), returns null (zero fake pairs emitted).
 * - If profile.enabled is false, returns null (no active subscription intent).
 * - If profile.enabled && dataEnabled, requiresOneMinuteCandles is true.
 */
export function createSubscriptionIntent(
  runtime: CoinRuntime
): MarketDataSubscriptionIntent | null {
  // Undiscovered coin has no real exchange pair: never emit fake pairs
  if (runtime.instrument === null) {
    return null;
  }

  // Disabled coin produces no active subscription intent
  if (!runtime.profile.enabled) {
    return null;
  }

  return Object.freeze({
    underlying: runtime.profile.underlying,
    pair: runtime.instrument.pair,
    requiresOneMinuteCandles: runtime.profile.dataEnabled,
    requiresTrades: false, // Default off until high-frequency order-flow phase
  });
}

/**
 * Derives market data subscription intents for a collection of coin runtimes,
 * omitting any undiscovered or disabled coins.
 */
export function createSubscriptionIntents(
  runtimes: readonly CoinRuntime[]
): readonly MarketDataSubscriptionIntent[] {
  const intents: MarketDataSubscriptionIntent[] = [];
  for (const runtime of runtimes) {
    const intent = createSubscriptionIntent(runtime);
    if (intent !== null) {
      intents.push(intent);
    }
  }
  return Object.freeze(intents);
}
