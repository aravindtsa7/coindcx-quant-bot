import { StrategyCoinMatrixError } from './errors';

export function matrixDeepCopyFreeze<T>(value: T, ancestors = new Set<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || value instanceof Map || value instanceof Set) {
    throw new StrategyCoinMatrixError('INVALID_PARAMETER_SPACE', 'Matrix canonical values permit only plain objects and arrays');
  }
  if (ancestors.has(value as object)) {
    throw new StrategyCoinMatrixError('INVALID_PARAMETER_SPACE', 'Matrix canonical values cannot contain cycles');
  }
  ancestors.add(value as object);
  if (Array.isArray(value)) {
    const copy = value.map((entry) => matrixDeepCopyFreeze(entry, ancestors));
    ancestors.delete(value as object);
    return Object.freeze(copy) as T;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new StrategyCoinMatrixError('INVALID_PARAMETER_SPACE', 'Matrix canonical values permit only plain objects');
  }
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = matrixDeepCopyFreeze(entry, ancestors);
  }
  ancestors.delete(value as object);
  return Object.freeze(copy) as T;
}

export function freezeMatrixRuntime<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const entry of Object.values(value as Record<string, unknown>)) freezeMatrixRuntime(entry, seen);
  return Object.freeze(value);
}
