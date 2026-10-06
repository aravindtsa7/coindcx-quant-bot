/**
 * M2 W1 shared REST limiter: explicit configuration. Pure; no defaults.
 * Every value is supplied by the caller. Numbers used in tests are fixtures, not approved production values
 * (design V3 §9 / U-M2-8: all configuration values are NOT APPROVED).
 */
import { types } from 'node:util';

export const PRIORITY_CLASSES = ['P0', 'P1', 'P2', 'P3'] as const;
export type PriorityClass = (typeof PRIORITY_CLASSES)[number];
export const BUDGET_SCOPES = ['API_AUTH', 'PUBLIC'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export interface RateWindow { readonly windowMs: number; readonly maxStarts: number }
export interface ClassShare { readonly minPerWindow: number; readonly maxPerWindow: number }
export interface RetryAfterPolicy {
  /** Lower bound applied only when a 429 carries NO Retry-After header. */
  readonly noHeaderDefaultMs: number;
  readonly providerStatedBlockMs: number;
  readonly localBackoffBaseMs: number;
  readonly localBackoffMaxMs: number;
  /** Alert threshold only; never shortens a server bound. */
  readonly operationalCapMs: number;
  /** Added to every date-derived wait. */
  readonly clockUncertaintyMs: number;
}
export interface RateLimiterConfig {
  /** Start-count constraints over half-open windows [x, x + windowMs). */
  readonly windows: readonly RateWindow[];
  /** The window (one of `windows`) over which class minimums and ceilings are measured. */
  readonly fairnessWindowMs: number;
  readonly classShares: Readonly<Record<PriorityClass, ClassShare>>;
  readonly concurrency: number;
  readonly p0ReservedSlots: number;
  /** Relative client-side start-check limit carried in each grant. Never used for accounting. */
  readonly grantTtlMs: number;
  /** Every request must carry a finite deadline no later than enqueue time + this cap. */
  readonly maxRequestDeadlineMs: number;
  /** Overdue-slot alert fires at latest start + request lifetime + this guard. Never releases a slot. */
  readonly overdueGuardMs: number;
  /** Alert when a charge stays without a STARTED/NOT_STARTED resolution this long. Never releases it. */
  readonly uncertainChargeAlertMs: number;
  readonly retryAfter: RetryAfterPolicy;
}
export type RateLimiterConfigResult = Readonly<{ kind: 'VALID'; config: RateLimiterConfig }> | Readonly<{ kind: 'INVALID'; reason: string }>;

const CONFIG_KEYS = ['windows', 'fairnessWindowMs', 'classShares', 'concurrency', 'p0ReservedSlots', 'grantTtlMs', 'maxRequestDeadlineMs', 'overdueGuardMs', 'uncertainChargeAlertMs', 'retryAfter'] as const;
const RETRY_KEYS = ['noHeaderDefaultMs', 'providerStatedBlockMs', 'localBackoffBaseMs', 'localBackoffMaxMs', 'operationalCapMs', 'clockUncertaintyMs'] as const;

/** Plain data only: no Proxy, no accessors, no foreign prototype, exactly the expected own keys. */
function record(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || types.isProxy(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || !keys.every((key) => own.includes(key))) return null;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return null;
  }
  return value as Readonly<Record<string, unknown>>;
}
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const nonNegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function validateRateLimiterConfig(input: unknown): RateLimiterConfigResult {
  const fail = (reason: string): RateLimiterConfigResult => Object.freeze({ kind: 'INVALID', reason });
  const root = record(input, CONFIG_KEYS);
  if (root === null) return fail('CONFIG_SHAPE');
  if (!Array.isArray(root.windows) || types.isProxy(root.windows) || root.windows.length === 0) return fail('WINDOWS');
  const windows: RateWindow[] = [];
  for (const entry of root.windows as unknown[]) {
    const window = record(entry, ['windowMs', 'maxStarts']);
    if (window === null || !positive(window.windowMs) || !positive(window.maxStarts)) return fail('WINDOW_VALUE');
    if (windows.some((existing) => existing.windowMs === window.windowMs)) return fail('WINDOW_DUPLICATE');
    windows.push(Object.freeze({ windowMs: window.windowMs, maxStarts: window.maxStarts }));
  }
  const fairness = windows.find((window) => window.windowMs === root.fairnessWindowMs);
  if (fairness === undefined) return fail('FAIRNESS_WINDOW_NOT_CONFIGURED');
  const sharesInput = record(root.classShares, PRIORITY_CLASSES);
  if (sharesInput === null) return fail('CLASS_SHARES_SHAPE');
  const shares = {} as Record<PriorityClass, ClassShare>;
  let minimumSum = 0;
  for (const cls of PRIORITY_CLASSES) {
    const share = record(sharesInput[cls], ['minPerWindow', 'maxPerWindow']);
    if (share === null || !nonNegative(share.minPerWindow) || !positive(share.maxPerWindow) || share.minPerWindow > share.maxPerWindow) return fail(`CLASS_SHARE_${cls}`);
    if (share.maxPerWindow > fairness.maxStarts) return fail(`CLASS_CEILING_${cls}`);
    minimumSum += share.minPerWindow;
    shares[cls] = Object.freeze({ minPerWindow: share.minPerWindow, maxPerWindow: share.maxPerWindow });
  }
  if (minimumSum > fairness.maxStarts) return fail('CLASS_MINIMUMS_INFEASIBLE');
  if (!positive(root.concurrency) || !nonNegative(root.p0ReservedSlots) || root.p0ReservedSlots >= root.concurrency) return fail('CONCURRENCY');
  for (const key of ['grantTtlMs', 'maxRequestDeadlineMs', 'overdueGuardMs', 'uncertainChargeAlertMs'] as const) if (!positive(root[key])) return fail(key);
  const retry = record(root.retryAfter, RETRY_KEYS);
  if (retry === null) return fail('RETRY_AFTER_SHAPE');
  for (const key of RETRY_KEYS) if (!(key === 'clockUncertaintyMs' ? nonNegative(retry[key]) : positive(retry[key]))) return fail(`RETRY_AFTER_${key}`);
  if ((retry.localBackoffBaseMs as number) > (retry.localBackoffMaxMs as number)) return fail('RETRY_AFTER_BACKOFF_RANGE');
  return Object.freeze({
    kind: 'VALID',
    config: Object.freeze({
      windows: Object.freeze(windows), fairnessWindowMs: fairness.windowMs, classShares: Object.freeze(shares),
      concurrency: root.concurrency, p0ReservedSlots: root.p0ReservedSlots as number,
      grantTtlMs: root.grantTtlMs as number, maxRequestDeadlineMs: root.maxRequestDeadlineMs as number,
      overdueGuardMs: root.overdueGuardMs as number, uncertainChargeAlertMs: root.uncertainChargeAlertMs as number,
      retryAfter: Object.freeze(Object.fromEntries(RETRY_KEYS.map((key) => [key, retry[key] as number])) as unknown as RetryAfterPolicy),
    }),
  });
}
