export class PairSerialQueue {
  #tail: Promise<void> = Promise.resolve();

  public enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
