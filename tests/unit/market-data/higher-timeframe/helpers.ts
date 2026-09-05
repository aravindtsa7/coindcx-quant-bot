import { createCanonicalCandle1m } from '../../../../src/market-data/models';
import {
  Canonical1mRangeReader,
  CanonicalEngineForHigherTimeframes,
} from '../../../../src/market-data/higher-timeframe';
import {
  CanonicalCandle1m,
  CanonicalHealthSnapshot,
  CanonicalStreamEvent,
  TruthFault,
} from '../../../../src/market-data/types';

export const BASE = Date.UTC(2024, 0, 1, 0, 0, 0);

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

/** Deterministic microtask drain for the public, promise-backed pair queues. */
export async function flushQueues(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

export function health(pair: string, overrides: Partial<CanonicalHealthSnapshot> = {}): CanonicalHealthSnapshot {
  return {
    pair,
    state: 'HEALTHY',
    truthFault: 'NONE',
    currentGenerationId: null,
    canonicalEpoch: 0,
    recoveryEpoch: 0,
    workingOpenTimeMs: null,
    latestCanonicalOpenTimeMs: null,
    continuityWatermarkMs: null,
    pendingFinalizationsCount: 0,
    lastValidProviderEventTimeMs: null,
    lastValidReceivedAtMs: null,
    gapCount: 0,
    lateDropCount: 0,
    duplicateCount: 0,
    recoveryRequired: false,
    bufferedLiveUpdateCount: 0,
    ...overrides,
  };
}

export function candle(pair: string, minute: number, overrides: Partial<Parameters<typeof createCanonicalCandle1m>[0]> = {}): CanonicalCandle1m {
  const openTimeMs = BASE + minute * 60_000;
  return createCanonicalCandle1m({
    pair,
    openTimeMs,
    open: String(100 + minute),
    high: String(102 + minute),
    low: String(99 + minute),
    close: String(101 + minute),
    volume: '1',
    quoteVolume: '2',
    source: 'WS_FINALIZED',
    finalizedAtMs: openTimeMs + 60_000,
    providerEventTimeMs: null,
    generationId: null,
    ...overrides,
  });
}

export class FakeCanonicalEngine implements CanonicalEngineForHigherTimeframes {
  public readonly lifecycleState = 'RUNNING';
  public readonly snapshots = new Map<string, CanonicalHealthSnapshot>();
  public subscriptionCount = 0;
  public unsubscribeCount = 0;
  #listeners = new Set<(event: CanonicalStreamEvent<unknown>) => void>();

  public subscribe(listener: (event: CanonicalStreamEvent<unknown>) => void): () => void {
    this.subscriptionCount++;
    this.#listeners.add(listener);
    return () => { this.unsubscribeCount++; this.#listeners.delete(listener); };
  }

  public getPairHealth(pair: string): CanonicalHealthSnapshot | undefined { return this.snapshots.get(pair); }
  public setHealth(pair: string, state: Partial<CanonicalHealthSnapshot> = {}): void { this.snapshots.set(pair, health(pair, state)); }
  public emit(candleValue: CanonicalCandle1m, eventType: CanonicalStreamEvent['eventType'] = 'CANONICAL_1M_CLOSED'): void {
    const event: CanonicalStreamEvent<unknown> = { eventType, pair: candleValue.pair, timestampMs: candleValue.closeTimeExclusiveMs, payload: candleValue };
    for (const listener of [...this.#listeners]) listener(event);
  }
  public emitControl(pair: string, eventType: CanonicalStreamEvent['eventType']): void {
    const event: CanonicalStreamEvent<unknown> = { eventType, pair, timestampMs: BASE, payload: {} };
    for (const listener of [...this.#listeners]) listener(event);
  }
}

export class MemoryRangeReader implements Canonical1mRangeReader {
  public readonly rows = new Map<string, CanonicalCandle1m[]>();
  public latestError: Error | null = null;
  public rangeError: Error | null = null;
  public latestGate: ((pair: string) => Promise<void>) | null = null;
  public rangeGate: ((pair: string, from: number, to: number) => Promise<void>) | null = null;
  public rangeCalls: Array<{ pair: string; from: number; to: number }> = [];

  public add(...values: CanonicalCandle1m[]): void {
    for (const value of values) {
      const list = this.rows.get(value.pair) ?? [];
      list.push(value);
      list.sort((a, b) => a.openTimeMs - b.openTimeMs);
      this.rows.set(value.pair, list);
    }
  }
  public async getLatestCanonicalCandle(pair: string): Promise<CanonicalCandle1m | null> {
    if (this.latestGate) await this.latestGate(pair);
    if (this.latestError) throw this.latestError;
    const values = this.rows.get(pair) ?? [];
    return values.at(-1) ?? null;
  }
  public async getRange(pair: string, fromInclusiveMs: number, toInclusiveMs: number): Promise<readonly CanonicalCandle1m[]> {
    this.rangeCalls.push({ pair, from: fromInclusiveMs, to: toInclusiveMs });
    if (this.rangeGate) await this.rangeGate(pair, fromInclusiveMs, toInclusiveMs);
    if (this.rangeError) throw this.rangeError;
    return (this.rows.get(pair) ?? []).filter((value) => value.openTimeMs >= fromInclusiveMs && value.openTimeMs <= toInclusiveMs);
  }
}

export const truthFaults: readonly TruthFault[] = [
  'RECOVERY_INCOMPLETE', 'CANONICAL_CONFLICT', 'PERSISTENCE_FAILURE', 'BUFFER_OVERFLOW', 'TIME_INVALID',
];
