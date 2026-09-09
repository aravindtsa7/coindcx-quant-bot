/**
 * Minimal per-key promise-chaining serializer (same idiom as
 * `src/market-data/higher-timeframe/pair-queue.ts`, duplicated locally rather than
 * imported across an unrelated domain boundary). One instance serializes every
 * operation enqueued on it, in submission order; a failing operation does not
 * break the chain for later operations, and each operation's own result/rejection
 * is delivered only to its own caller.
 */
export class SerialQueue {
  #tail: Promise<void> = Promise.resolve();
  public enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** Lazily creates and reuses one `SerialQueue` per key — account-scoped, not global. */
export class KeyedSerialQueue<K> {
  readonly #queues = new Map<K, SerialQueue>();
  public enqueue<T>(key: K, operation: () => Promise<T> | T): Promise<T> {
    let queue = this.#queues.get(key);
    if (queue === undefined) { queue = new SerialQueue(); this.#queues.set(key, queue); }
    return queue.enqueue(operation);
  }
}
