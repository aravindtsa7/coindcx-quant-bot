import { StrategyError } from './errors';

export function deepCopyFreeze<T>(value: T, ancestors = new Set<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || value instanceof Map || value instanceof Set) {
    throw new StrategyError('STRATEGY_INPUT_INVALID', 'Mutable built-in containers cannot be copied as strategy identity');
  }
  if (ancestors.has(value as object)) throw new StrategyError('STRATEGY_INPUT_INVALID', 'Strategy identity cannot contain cycles');
  ancestors.add(value as object);
  if (Array.isArray(value)) {
    const copy = value.map((entry) => deepCopyFreeze(entry, ancestors));
    ancestors.delete(value as object);
    return Object.freeze(copy) as T;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new StrategyError('STRATEGY_INPUT_INVALID', 'Strategy identity permits only plain objects');
  }
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = deepCopyFreeze(entry, ancestors);
  }
  ancestors.delete(value as object);
  return Object.freeze(copy) as T;
}

export function freezeRuntimeObject<T extends object>(value: T, seen = new Set<object>()): Readonly<T> {
  if (seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) {
    if (entry !== null && typeof entry === 'object' && !(entry instanceof StrategyReadonlyMap)) {
      freezeRuntimeObject(entry as object, seen);
    }
  }
  return Object.freeze(value);
}

export class StrategyReadonlyMap<K, V> implements ReadonlyMap<K, V> {
  readonly #map: Map<K, V>;
  public constructor(entries: Iterable<readonly [K, V]>) {
    this.#map = new Map(entries);
    Object.freeze(this);
  }
  public get size(): number { return this.#map.size; }
  public get(key: K): V | undefined { return this.#map.get(key); }
  public has(key: K): boolean { return this.#map.has(key); }
  public entries(): MapIterator<[K, V]> { return this.#map.entries(); }
  public keys(): MapIterator<K> { return this.#map.keys(); }
  public values(): MapIterator<V> { return this.#map.values(); }
  public forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#map.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
  public [Symbol.iterator](): MapIterator<[K, V]> { return this.#map[Symbol.iterator](); }
  public get [Symbol.toStringTag](): string { return 'StrategyReadonlyMap'; }
}
