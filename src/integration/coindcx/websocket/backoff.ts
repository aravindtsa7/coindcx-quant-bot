export interface BackoffPolicyConfig {
  readonly minDelayMs: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
}

export const DEFAULT_BACKOFF_CONFIG: BackoffPolicyConfig = Object.freeze({
  minDelayMs: 500,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  factor: 2,
});

/**
 * Calculates bounded exponential backoff with jitter to prevent reconnect storms.
 *
 * Guarantees:
 * - Deterministic output when provided with a seeded or mock RNG.
 * - Upper-bounded strictly by maxDelayMs.
 * - Lower-bounded by minDelayMs to prevent tight reconnect loops.
 * - Exponential progression: min(maxDelay, baseDelay * factor^attempt).
 */
export function calculateBackoffWithJitter(
  attempt: number,
  config: BackoffPolicyConfig = DEFAULT_BACKOFF_CONFIG,
  rng: () => number = Math.random
): number {
  const safeAttempt = Math.max(0, Math.min(Math.floor(attempt), 20));
  const rawExponential = config.baseDelayMs * Math.pow(config.factor, safeAttempt);
  const capped = Math.min(config.maxDelayMs, Math.max(config.minDelayMs, rawExponential));

  // Range for jitter is between minDelayMs and capped
  const jitterRange = Math.max(0, capped - config.minDelayMs);
  const randomFraction = Math.max(0, Math.min(rng(), 1));
  const jitterOffset = Math.floor(randomFraction * jitterRange);

  return config.minDelayMs + jitterOffset;
}
