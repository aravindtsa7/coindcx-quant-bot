import { PRICE_SOURCES, type PriceSource } from '../../indicators/types';
import { StrategyCalcDecimal, normalizeCanonicalDecimalString } from './decimal';
import { strategyParameterError } from './errors';
import { deepCopyFreeze } from './immutable';

export const MAX_STRATEGY_PERIOD = 100_000;
export const MAX_STRATEGY_TIMEFRAME_MINUTES = 150_119_987_579;

export function requireExactObject(value: unknown, allowedKeys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw strategyParameterError(`${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw strategyParameterError(`Unknown ${label} key: ${key}`);
    if (record[key] === undefined) throw strategyParameterError(`${label}.${key} must not be undefined`);
  }
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) throw strategyParameterError(`Missing ${label} key: ${key}`);
  }
  return record;
}

export function positiveSafeInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw strategyParameterError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

export function strategyPeriod(value: unknown, label: string): number {
  return positiveSafeInteger(value, label, MAX_STRATEGY_PERIOD);
}

export function strategyTimeframe(value: unknown, label: string): number {
  return positiveSafeInteger(value, label, MAX_STRATEGY_TIMEFRAME_MINUTES);
}

export function strategyPriceSource(value: unknown, label: string): PriceSource {
  if (typeof value !== 'string' || !(PRICE_SOURCES as readonly string[]).includes(value)) {
    throw strategyParameterError(`${label} must be an exact supported PriceSource`);
  }
  return value as PriceSource;
}

export function sortedDistinctTimeframes(value: unknown, label: string): readonly number[] {
  if (!Array.isArray(value) || value.length < 2) throw strategyParameterError(`${label} must contain at least two timeframes`);
  const values = value.map((entry, index) => strategyTimeframe(entry, `${label}[${index}]`));
  const seen = new Set<number>();
  for (const timeframe of values) {
    if (seen.has(timeframe)) throw strategyParameterError(`${label} must not contain duplicate timeframes`);
    seen.add(timeframe);
  }
  return Object.freeze([...values].sort((left, right) => left - right));
}

export function positiveDecimalParameter(value: unknown, label: string): string {
  const normalized = normalizeCanonicalDecimalString(value, label);
  if (!new StrategyCalcDecimal(normalized).gt(0)) throw strategyParameterError(`${label} must be greater than zero`);
  return normalized;
}

export function freezeNormalizedParameters<T extends Readonly<Record<string, unknown>>>(parameters: T): T {
  return deepCopyFreeze(parameters);
}
