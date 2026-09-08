import { riskSourceInvalid } from './errors';

export function riskDeepCopyFreeze<T>(value: T, ancestors = new Set<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || value instanceof Map || value instanceof Set) riskSourceInvalid('Risk canonical values permit only plain objects and arrays');
  if (ancestors.has(value as object)) riskSourceInvalid('Risk canonical values cannot contain cycles');
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) riskSourceInvalid('Risk canonical values permit only plain objects');
  ancestors.add(value as object);
  const copy = Array.isArray(value)
    ? value.map((entry) => riskDeepCopyFreeze(entry, ancestors))
    : Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, riskDeepCopyFreeze(entry, ancestors)]));
  ancestors.delete(value as object);
  return Object.freeze(copy) as T;
}

export function freezeRiskRuntime<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const entry of Object.values(value as Record<string, unknown>)) freezeRiskRuntime(entry, seen);
  return Object.freeze(value);
}
