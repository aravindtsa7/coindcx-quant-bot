import { afterEach, describe, expect, it } from 'vitest';
import { CanonicalCandle1m } from '../../../src/market-data/types';
import { RestCandleRecord } from '../../../src/market-data/rest-candle-reader';
import { HigherTimeframeEngine, isPhase5Eligible } from '../../../src/market-data/higher-timeframe';
import { P, T, M, setup, update, barrier, deferred, flushQueues, record, final } from './audit-a1-helpers';

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });
function context(now?: number) { const c = setup(now); stops.push(() => c.engine.stop()); return c; }

describe('Audit A1 recovery ownership and initialization', () => {
  it('A19: skew, stale timer and ordinary traffic cannot bypass a real live-gap recovery', async () => {
    const c = context(); const gate = deferred<RestCandleRecord[]>();
    c.rest.fetchClosedCandles = () => gate.promise;
    await c.engine.handleStreamEnvelope(update(T));
    const recovery = c.engine.handleStreamEnvelope(update(T + 3 * M));
    await c.engine.handleStreamEnvelope(update(T, 1, { providerEventTimeMs: T + 6 * M }));
    c.scheduler.advanceTime(120_000);
    await c.engine.handleStreamEnvelope(update(T + M));
    c.scheduler.advanceTime(1000); await flushQueues();
    expect(c.repository.insertCalls).toHaveLength(0);
    expect(c.engine.getPairHealth(P)?.recoveryRequired).toBe(true);
    expect(isPhase5Eligible(c.engine.getPairHealth(P))).toBe(false);
    gate.resolve([]); await recovery;
    expect(c.engine.getPairHealth(P)?.truthFault).toBe('RECOVERY_INCOMPLETE');
    await c.engine.handleStreamEnvelope(update(T + 2 * M));
    expect(c.repository.insertCalls).toHaveLength(0);
  });

  it('successful full reconciliation clears ownership only after persistence settles', async () => {
    const c = context(T + 3 * M + 1000); const gate = deferred<RestCandleRecord[]>();
    c.rest.fetchClosedCandles = () => gate.promise;
    await c.engine.handleStreamEnvelope(update(T));
    const recovery = c.engine.handleStreamEnvelope(update(T + 3 * M));
    gate.resolve([record(T), record(T + M), record(T + 2 * M)]);
    await recovery;
    expect(c.repository.insertCalls.map(row => row.openTimeMs)).toEqual([T, T + M, T + 2 * M]);
    expect(c.engine.getPairHealth(P)?.recoveryRequired).toBe(false);
    expect(isPhase5Eligible(c.engine.getPairHealth(P))).toBe(true);
  });

  it('REST rejection keeps the independent barrier active', async () => {
    const c = context(); await c.engine.initializePair(P);
    c.rest.errorToThrow = new Error('offline');
    await c.engine.executeRecovery(P, T, T);
    await c.engine.handleStreamEnvelope(update(T + 4 * M, 1, { providerEventTimeMs: T + 5 * M }));
    expect(c.engine.getPairHealth(P)?.recoveryRequired).toBe(true);
    expect(c.engine.getPairHealth(P)?.truthFault).toBe('RECOVERY_INCOMPLETE');
    expect(c.repository.insertCalls).toHaveLength(0);
  });

  it('reconnect recovery cannot reuse G1 freshness without new G2 source evidence', async () => {
    const c = context(T + 1000);
    await c.engine.handleStreamEnvelope(update(T));
    c.clock.setTime(T + M + 1000); c.rest.recordsToReturn = [record(T)];
    await c.engine.handleStreamEnvelope(barrier()); await flushQueues();
    expect(c.engine.getPairHealth(P)?.recoveryRequired).toBe(false);
    expect(c.engine.getPairHealth(P)?.state).toBe('STALE');
    expect(c.engine.getPairHealth(P)?.lastValidProviderEventTimeMs).toBeNull();
    expect(isPhase5Eligible(c.engine.getPairHealth(P))).toBe(false);
    await c.engine.handleStreamEnvelope(update(T + M, 2));
    expect(isPhase5Eligible(c.engine.getPairHealth(P))).toBe(true);
  });

  it('buffered final-overlap verification retains ownership across its DB await', async () => {
    const c = context(T + M + 1000); await c.engine.initializePair(P);
    const restGate = deferred<RestCandleRecord[]>(); const dbGate = deferred<CanonicalCandle1m | null>();
    c.rest.fetchClosedCandles = () => restGate.promise;
    const recovery = c.engine.executeRecovery(P, T, T);
    await c.engine.handleStreamEnvelope(update(T, 1, { providerEventTimeMs: T + M }));
    c.repository.getCandle = () => dbGate.promise;
    restGate.resolve([record(T)]); await flushQueues();
    expect(c.engine.getPairHealth(P)?.recoveryRequired).toBe(true);
    await c.engine.handleStreamEnvelope(update(T + M));
    c.clock.setTime(T + 2 * M + 1000); await c.engine.handleStreamEnvelope(update(T + 2 * M));
    c.scheduler.advanceTime(1000); await flushQueues();
    expect(isPhase5Eligible(c.engine.getPairHealth(P))).toBe(false);
    expect(c.repository.insertCalls.map(row => row.openTimeMs)).toEqual([T]);
    dbGate.resolve(final(T)); await recovery;
    expect(c.engine.getPairHealth(P)?.recoveryRequired).toBe(false);
    c.scheduler.advanceTime(1000); await flushQueues();
    expect(c.repository.insertCalls.map(row => row.openTimeMs)).toEqual([T, T + M]);
  });

  it('A11: G1 pending initialization is discarded after G2 barrier; fresh G2 owns the replacement', async () => {
    const c = context(T + 1000); const gate = deferred<CanonicalCandle1m | null>(); let reads = 0;
    c.repository.getLatestCanonicalCandle = () => ++reads === 1 ? gate.promise : Promise.resolve(null);
    const old = c.engine.handleStreamEnvelope(update(T)); await flushQueues();
    await c.engine.handleStreamEnvelope(barrier());
    gate.resolve(null); await old;
    expect(c.engine.getPairHealth(P)).toBeUndefined();
    expect(c.repository.insertCalls).toHaveLength(0);
    await c.engine.handleStreamEnvelope(update(T, 2));
    expect(c.engine.getPairHealth(P)?.currentGenerationId).toBe(2);
    c.clock.setTime(T + M + 1000); await c.engine.handleStreamEnvelope(update(T + M, 2));
    c.scheduler.advanceTime(1000); await flushQueues();
    expect((await c.repository.getCandle(P, T))?.generationId).toBe(2);
  });

  it('G2 initialization can finish before G1 DB resolves without an old overwrite', async () => {
    const c = context(T + 1000); const gate = deferred<CanonicalCandle1m | null>(); let reads = 0;
    c.repository.getLatestCanonicalCandle = () => ++reads === 1 ? gate.promise : Promise.resolve(null);
    const old = c.engine.handleStreamEnvelope(update(T)); await flushQueues();
    await c.engine.handleStreamEnvelope(barrier()); await c.engine.handleStreamEnvelope(update(T, 2));
    const before = c.engine.getPairHealth(P); gate.resolve(null); await old;
    expect(c.engine.getPairHealth(P)).toEqual(before);
    expect(reads).toBe(2);
  });

  it.each([false, true])('stop during initialization is inert; restart=%s', async restart => {
    const c = context(T + 1000); const gate = deferred<CanonicalCandle1m | null>(); let reads = 0;
    c.repository.getLatestCanonicalCandle = () => ++reads === 1 ? gate.promise : Promise.resolve(null);
    const old = c.engine.handleStreamEnvelope(update(T)); await flushQueues(); c.engine.stop();
    if (restart) { await c.engine.start(); await c.engine.handleStreamEnvelope(update(T, 2)); }
    const before = c.engine.getPairHealth(P); gate.resolve(null); await old;
    expect(c.engine.getPairHealth(P)).toEqual(before);
  });

  it('same-generation pair initialization is single flight', async () => {
    const c = context(); const gate = deferred<CanonicalCandle1m | null>(); let reads = 0;
    c.repository.getLatestCanonicalCandle = () => { reads++; return gate.promise; };
    const a = c.engine.initializePair(P); const b = c.engine.initializePair(P); await flushQueues();
    expect(reads).toBe(1); gate.resolve(null); expect(await a).toBe(await b);
  });

  it('A09: no closed baseline resumes on a fresh replacement forming snapshot without REST', async () => {
    const c = context(T + 1000); const results: unknown[] = [];
    c.engine.subscribe(e => { if (e.eventType === 'CANONICAL_1M_RECOVERY_COMPLETED') results.push(e.payload); });
    await c.engine.handleStreamEnvelope(update(T)); await c.engine.handleStreamEnvelope(barrier());
    expect(c.engine.getPairHealth(P)?.recoveryRequired).toBe(true);
    await c.engine.handleStreamEnvelope(update(T, 2));
    expect(c.rest.fetchCalls).toHaveLength(0); expect(results).toEqual([{ result: 'NO_BASELINE' }]);
    expect(c.engine.getPairHealth(P)?.recoveryRequired).toBe(false);
    c.clock.setTime(T + M + 1000); await c.engine.handleStreamEnvelope(update(T + M, 2));
    c.scheduler.advanceTime(1000); await flushQueues();
    expect((await c.repository.getCandle(P, T))?.generationId).toBe(2);
  });

  it('A10: NOTHING_MISSING waits for fresh G2 handoff and makes no empty REST request', async () => {
    const c = context(T + M + 1000); await c.repository.insertCandle(final(T));
    await c.engine.initializePair(P); await c.engine.handleStreamEnvelope(barrier());
    expect(c.engine.getPairHealth(P)?.recoveryRequired).toBe(true);
    await c.engine.handleStreamEnvelope(update(T + M, 2));
    expect(c.rest.fetchCalls).toHaveLength(0); expect(c.engine.getPairHealth(P)?.recoveryRequired).toBe(false);
    expect(c.engine.getPairHealth(P)?.workingOpenTimeMs).toBe(T + M);
  });

  it('an empty-range handoff expands into real REST recovery when G2 starts in a later bucket', async () => {
    const c = context(T + 1000); await c.engine.handleStreamEnvelope(update(T));
    await c.engine.handleStreamEnvelope(barrier()); c.clock.setTime(T + 2 * M + 1000);
    c.rest.recordsToReturn = [record(T), record(T + M)];
    await c.engine.handleStreamEnvelope(update(T + 2 * M, 2));
    expect(c.rest.fetchCalls).toEqual([{ pair: P, fromMs: T, toMs: T + M }]);
    expect(c.engine.getPairHealth(P)?.recoveryRequired).toBe(false);
  });

  it('Phase 6 remains blocked during recovery and resumes with valid complete canonical buckets', async () => {
    const c = context(T + 1000); await c.engine.start(); await c.engine.initializePair(P);
    const reader = { getLatestCanonicalCandle: (pair: string) => c.repository.getLatestCanonicalCandle(pair),
      getRange: async (pair: string, from: number, to: number) => [...(c.repository.candles.get(pair)?.values() ?? [])].filter(row => row.openTimeMs >= from && row.openTimeMs <= to).sort((a, b) => a.openTimeMs - b.openTimeMs) };
    const derived = new HigherTimeframeEngine({ canonicalEngine: c.engine, rangeReader: reader, pairs: [P], timeframes: [2] });
    stops.push(() => derived.stop()); const emitted: number[] = []; derived.subscribe(e => emitted.push(e.bucketStartMs));
    await derived.start(); expect(derived.getPairSnapshot(P)?.operationalState).toBe('BLOCKED');
    await c.engine.handleStreamEnvelope(update(T));
    c.clock.setTime(T + M + 1000); await c.engine.handleStreamEnvelope(update(T + M)); c.scheduler.advanceTime(1000); await flushQueues();
    const gate = deferred<RestCandleRecord[]>(); c.rest.fetchClosedCandles = () => gate.promise;
    const recovery = c.engine.executeRecovery(P, T + M, T + M);
    await flushQueues(); expect(emitted).toEqual([]);
    c.clock.setTime(T + 2 * M + 1000); await c.engine.handleStreamEnvelope(update(T + 2 * M));
    gate.resolve([record(T + M)]); await recovery; await flushQueues();
    expect(emitted).toEqual([T]);
  });
});
