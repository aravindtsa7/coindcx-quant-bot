/**
 * Bounded observation polling helper for WebSocket smoke tests.
 *
 * Invariants:
 * - Polls at a configured interval until predicate returns true or timeout expires.
 * - Always clears BOTH the polling interval and the timeout timer on ALL exit paths:
 *   - Success (predicate satisfied before timeout)
 *   - Timeout (timeout reached before predicate satisfied)
 *   - Exception (thrown by predicate or caller)
 * - Returns true on success, false on timeout.
 * - Guarantees zero pending observation timers remain upon completion.
 */

export interface SmokeObservationOptions {
  /** Maximum wait time in milliseconds before timing out */
  readonly timeoutMs: number;
  /** Polling interval in milliseconds (default: 500ms) */
  readonly pollIntervalMs?: number;
  /** Predicate returning true when observation criteria are met */
  readonly isComplete: () => boolean;
}

export async function waitForSmokeObservation(
  options: SmokeObservationOptions
): Promise<boolean> {
  const { timeoutMs, pollIntervalMs = 500, isComplete } = options;

  // Immediate evaluation: if already satisfied, return true with zero timers scheduled
  if (isComplete()) {
    return true;
  }

  let intervalId: NodeJS.Timeout | null = null;
  let timeoutId: NodeJS.Timeout | null = null;
  let settled = false;

  const cleanupTimers = (): void => {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  try {
    return await new Promise<boolean>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanupTimers();
          resolve(false);
        }
      }, timeoutMs);

      intervalId = setInterval(() => {
        try {
          if (!settled && isComplete()) {
            settled = true;
            cleanupTimers();
            resolve(true);
          }
        } catch (err) {
          settled = true;
          cleanupTimers();
          reject(err);
        }
      }, pollIntervalMs);
    });
  } finally {
    cleanupTimers();
  }
}

