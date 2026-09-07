import { createHash } from 'node:crypto';
import { StrategyError } from './errors';

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new StrategyError('STRATEGY_NUMERIC_FAILURE', 'Canonical JSON permits only safe integer numbers');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new StrategyError('STRATEGY_INPUT_INVALID', `Unsupported canonical JSON value: ${typeof value}`);
  }
  if (value instanceof Date) throw new StrategyError('STRATEGY_INPUT_INVALID', 'Date is forbidden in canonical JSON');
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new StrategyError('STRATEGY_INPUT_INVALID', 'Canonical JSON cannot serialize cycles');
    ancestors.add(value);
    const result = `[${value.map((entry) => serialize(entry, ancestors)).join(',')}]`;
    ancestors.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) throw new StrategyError('STRATEGY_INPUT_INVALID', 'Canonical JSON cannot serialize cycles');
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new StrategyError('STRATEGY_INPUT_INVALID', 'Canonical JSON permits only plain objects');
    }
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const properties = Object.keys(record).sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`);
    ancestors.delete(value);
    return `{${properties.join(',')}}`;
  }
  throw new StrategyError('STRATEGY_INPUT_INVALID', 'Unsupported canonical JSON input');
}

export function strategyCanonicalJson(value: unknown): string {
  return serialize(value, new Set<object>());
}

export function strategySha256CanonicalJson(value: unknown): string {
  return createHash('sha256').update(Buffer.from(strategyCanonicalJson(value), 'utf8')).digest('hex');
}
