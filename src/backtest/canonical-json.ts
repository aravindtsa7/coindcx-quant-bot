import { createHash, Hash } from 'node:crypto';
import { BacktestDecimal } from './decimal';
import { BacktestError } from './errors';

type JsonPrimitive = string | number | boolean | null;

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value instanceof BacktestDecimal) return JSON.stringify(value.value);
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new BacktestError('BACKTEST_RUN_FAILED', 'Canonical JSON permits only safe integer numbers');
    }
    return JSON.stringify(value as JsonPrimitive);
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new BacktestError('BACKTEST_RUN_FAILED', `Unsupported canonical JSON value: ${typeof value}`);
  }
  if (value instanceof Date) throw new BacktestError('BACKTEST_RUN_FAILED', 'Date is forbidden in canonical JSON');
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new BacktestError('BACKTEST_RUN_FAILED', 'Canonical JSON cannot serialize cycles');
    ancestors.add(value);
    const result = `[${value.map((entry) => serialize(entry, ancestors)).join(',')}]`;
    ancestors.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) throw new BacktestError('BACKTEST_RUN_FAILED', 'Canonical JSON cannot serialize cycles');
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new BacktestError('BACKTEST_RUN_FAILED', 'Canonical JSON permits only plain objects');
    }
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const properties = keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`);
    ancestors.delete(value);
    return `{${properties.join(',')}}`;
  }
  throw new BacktestError('BACKTEST_RUN_FAILED', 'Unsupported canonical JSON input');
}

export function canonicalJson(value: unknown): string {
  return serialize(value, new Set<object>());
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256').update(Buffer.from(canonicalJson(value), 'utf8')).digest('hex');
}

export function updateCanonicalEventHash(hash: Hash, event: unknown): void {
  hash.update(Buffer.from(`${canonicalJson(event)}\n`, 'utf8'));
}
