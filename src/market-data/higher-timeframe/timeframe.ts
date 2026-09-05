export const MINUTE_MS = 60_000;
export const MAX_TIMEFRAME_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / MINUTE_MS);
export const ENABLED_HIGHER_TIMEFRAMES = Object.freeze([2, 3, 4, 5, 10, 15, 30, 60, 240, 1440] as const);

export function assertValidTimeframeMinutes(timeframeMinutes: number): void {
  if (!Number.isSafeInteger(timeframeMinutes) || timeframeMinutes < 2 || timeframeMinutes > MAX_TIMEFRAME_MINUTES) {
    throw new RangeError(`Invalid higher timeframe minutes: ${timeframeMinutes}`);
  }
}

export function normalizeTimeframes(timeframes: readonly number[]): readonly number[] {
  if (timeframes.length === 0) throw new RangeError('At least one higher timeframe is required');
  const copy = [...timeframes];
  for (const timeframe of copy) assertValidTimeframeMinutes(timeframe);
  copy.sort((a, b) => a - b);
  for (let index = 1; index < copy.length; index++) {
    if (copy[index] === copy[index - 1]) throw new RangeError(`Duplicate higher timeframe: ${copy[index]}`);
  }
  return Object.freeze(copy);
}

export function assertMinuteAlignedOpenTimeMs(openTimeMs: number): void {
  if (!Number.isSafeInteger(openTimeMs) || openTimeMs % MINUTE_MS !== 0) {
    throw new RangeError(`openTimeMs must be a safe UTC-minute-aligned integer: ${openTimeMs}`);
  }
}

export function durationMs(timeframeMinutes: number): number {
  assertValidTimeframeMinutes(timeframeMinutes);
  const duration = timeframeMinutes * MINUTE_MS;
  if (!Number.isSafeInteger(duration)) throw new RangeError('Higher timeframe duration is unsafe');
  return duration;
}

export function bucketStartMs(openTimeMs: number, timeframeMinutes: number): number {
  assertMinuteAlignedOpenTimeMs(openTimeMs);
  const duration = durationMs(timeframeMinutes);
  const start = Math.floor(openTimeMs / duration) * duration;
  if (!Number.isSafeInteger(start)) throw new RangeError('Higher timeframe bucket start is unsafe');
  return start;
}

export function bucketEndExclusiveMs(openTimeMs: number, timeframeMinutes: number): number {
  const start = bucketStartMs(openTimeMs, timeframeMinutes);
  const end = start + durationMs(timeframeMinutes);
  if (!Number.isSafeInteger(end)) throw new RangeError('Higher timeframe bucket end is unsafe');
  return end;
}
