import { BacktestError } from './errors';

export function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value as object)) return value;
  if (value instanceof Date || value instanceof Map || value instanceof Set) {
    throw new BacktestError('INVALID_BACKTEST_CONFIG', 'Mutable built-in containers are not valid frozen inputs');
  }
  seen.add(value as object);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

export class ImmutableReadonlyMap<K, V> implements ReadonlyMap<K, V> {
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
  public get [Symbol.toStringTag](): string { return 'ImmutableReadonlyMap'; }
}
