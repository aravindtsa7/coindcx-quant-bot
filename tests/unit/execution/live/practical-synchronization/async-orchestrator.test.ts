import { describe, expect, it } from 'vitest';
import { LiveExecutionAuthority } from '../../../../../src/execution/live/authority';
import { PracticalRecoveryCertificate } from '../../../../../src/execution/live/practical/certificate';
import type { PrivateStreamObservation } from '../../../../../src/execution/live/practical-observation/assessment';
import { practicalPrivateStreamReadiness } from '../../../../../src/execution/live/practical-recovery/private-events';
import {
  runAsyncSynchronizationCandidate,
  type AsyncClock,
  type AsyncReadBinding,
  type AsyncSynchronizationResult,
  type AsyncSynchronizationSource,
} from '../../../../../src/execution/live/practical-synchronization/async-orchestrator';
import {
  GRANTS_NOTHING,
  runSynchronizationCandidate,
  type ObservationComponent,
  type SyncComponentScan,
  type SynchronizationConfig,
  type SyncHistoryScope,
  type SyncScanLimits,
} from '../../../../../src/execution/live/practical-synchronization/engine';
import { currentAccountContinuityCapability } from '../../../../../src/execution/live/reconciliation/barrier';
import { LiveReconciliationAuthorization } from '../../../../../src/execution/live/reconciliation/repository';
import type { LiveVenueOrderEvidence, LiveVenuePositionEvidence } from '../../../../../src/execution/live/reconciliation/types';
import { consumeMutationPermit } from '../../../../../src/integration/coindcx/rate-limit/runtime/mutation-budget';

// M4 asynchronous orchestration candidate. Async fixtures only: deferred promises, a manual clock and a manual event
// emitter. Every limit, timeout and threshold here is a test value, not a default.
const ACCOUNT = 'synthetic-account';
const LIMITS = { readTimeoutMs: 1_000, streamTimeoutMs: 1_000 };

function order(overrides: Partial<LiveVenueOrderEvidence> = {}): LiveVenueOrderEvidence {
  return {
    exchangeOrderId: 'ex-1', pair: 'B-BTC_USDT', side: 'BUY', venueStatus: 'open', orderedQuantity: '0.5', filledQuantity: '0',
    remainingQuantity: '0.5', cancelledQuantity: '0', averageFillPrice: null, price: '64000.5', wireOrderType: 'limit_order', leverage: '5',
    providerCreatedAtMs: 1_000, providerEventTimeMs: 1_500, clientOrderId: 'bot-0001', ...overrides,
  };
}
function position(overrides: Partial<LiveVenuePositionEvidence> = {}): LiveVenuePositionEvidence {
  return { venuePositionId: 'pos-1', pair: 'B-BTC_USDT', signedQuantity: '0.5', averageEntryPrice: '64000.5', leverage: '5', providerEventTimeMs: 1_600, ...overrides };
}
function stream(overrides: Partial<PrivateStreamObservation> = {}): PrivateStreamObservation {
  return { connected: true, epoch: 7, epochAtWindowStart: 7, disconnectObservedSinceWindowStart: false, reconnectLatched: false,
    joinAcknowledgement: { kind: 'UNKNOWN' }, events: [], bufferedUnprocessedEvents: 0, ...overrides };
}
function config(overrides: Partial<SynchronizationConfig> = {}, scope: Partial<SynchronizationConfig['scope']> = {}): SynchronizationConfig {
  return {
    mode: 'FULL_EVIDENCE',
    scope: { accountId: ACCOUNT, components: ['ORDERS', 'POSITIONS'], requiredAccounting: [], history: { kind: 'AVAILABLE_HISTORY' }, ...scope },
    scanLimits: { ORDERS: { pageSize: 2, maxPages: 3 }, POSITIONS: { pageSize: 2, maxPages: 3 }, TRANSACTIONS: { pageSize: 2, maxPages: 3 } },
    thresholds: { maxEvidenceAgeMs: 5_000, maxTotalReadDurationMs: 2_000 },
    maxCycles: 2,
    lineage: { ownedOrders: [{ exchangeOrderId: 'ex-1', intentId: 'intent-1' }], ambiguousCreates: [], closedIntentTags: [], ownedPositions: ['pos-1'], botTagNamespace: 'bot-' },
    contracts: { tagContract: { confirmed: false }, venueGeneratedOrderTypes: null, venueGeneratedWalletStages: null, terminalShortPage: {} },
    ...overrides,
  };
}
const PAGES: Record<ObservationComponent, readonly (readonly unknown[])[]> = { ORDERS: [[order()], []], POSITIONS: [[position()], []], TRANSACTIONS: [[], []] };

const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });
async function settleAll(rounds = 20): Promise<void> { for (let i = 0; i < rounds; i += 1) await flush(); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

/** A manual clock: `delay` resolves only when `advance` passes its due time. */
class ManualClock implements AsyncClock {
  public nowMs = 10_000;
  readonly #waiters: Array<{ due: number; resolve: () => void }> = [];
  public now(): number { return this.nowMs; }
  public delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('aborted')); return; }
      const waiter = { due: this.nowMs + ms, resolve };
      this.#waiters.push(waiter);
      signal.addEventListener('abort', () => { this.#waiters.splice(this.#waiters.indexOf(waiter), 1); reject(new Error('aborted')); }, { once: true });
    });
  }
  public async advance(ms: number): Promise<void> {
    this.nowMs += ms;
    for (const waiter of this.#waiters.filter((entry) => entry.due <= this.nowMs)) { this.#waiters.splice(this.#waiters.indexOf(waiter), 1); waiter.resolve(); }
    await settleAll();
  }
}

type ScanRequest = Parameters<AsyncSynchronizationSource['scan']>[0];
type ObserveRequest = Parameters<AsyncSynchronizationSource['observeStream']>[0];
interface Fixture {
  source: AsyncSynchronizationSource;
  clock: ManualClock;
  scans: ScanRequest[];
  observations: ObserveRequest[];
  emit(event: unknown): void;
  listenerCount(): number;
}
function respond(request: ScanRequest, clock: ManualClock, pages: readonly (readonly unknown[])[] = PAGES[request.binding.component], overrides: Partial<Extract<SyncComponentScan, { kind: 'SCANNED' }>> = {}) {
  return { binding: request.binding, scan: { kind: 'SCANNED', accountScope: { kind: 'CONFIRMED', accountId: ACCOUNT }, startedAtMs: clock.now(), endedAtMs: clock.now(), pages, ...overrides } };
}
function fixture(options: { scan?: (request: ScanRequest, f: Fixture) => Promise<unknown>; observe?: (request: ObserveRequest, f: Fixture) => Promise<unknown> } = {}): Fixture {
  const listeners = new Set<(event: unknown) => void>();
  const clock = new ManualClock();
  const f: Fixture = {
    clock, scans: [], observations: [],
    emit: (event) => { for (const listener of [...listeners]) listener(event); },
    listenerCount: () => listeners.size,
    source: {
      scan: (request) => { f.scans.push(request); return options.scan?.(request, f) ?? Promise.resolve(respond(request, clock)); },
      observeStream: (request) => { f.observations.push(request); return options.observe?.(request, f) ?? Promise.resolve(stream()); },
      subscribeEvents: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
  };
  return f;
}
const start = (f: Fixture, c: SynchronizationConfig = config(), signal?: AbortSignal) =>
  runAsyncSynchronizationCandidate({ config: c, limits: LIMITS, source: f.source, clock: f.clock, ...(signal === undefined ? {} : { signal }) });

describe('M4 async orchestration: order, bindings and out-of-order completion', () => {
  it('initial observation, pass 0, pass 1, final observation, then the engine assessment; every request is bound', async () => {
    const f = fixture();
    const result = await start(f);
    expect(result.status).toBe('OBSERVED_CONVERGENCE');
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]!.reads.map((r) => `${r.pass}:${r.component}:${r.outcome}`).sort()).toEqual(['0:ORDERS:RESPONSE', '0:POSITIONS:RESPONSE', '1:ORDERS:RESPONSE', '1:POSITIONS:RESPONSE']);
    expect(f.observations.map((o) => o.point)).toEqual(['CYCLE_START', 'EVALUATION']);
    expect(f.scans.map((s) => `${s.binding.pass}:${s.binding.component}`)).toEqual(['0:ORDERS', '0:POSITIONS', '1:ORDERS', '1:POSITIONS']);
    expect(f.scans[0]!.binding).toEqual({ accountId: ACCOUNT, scopeId: JSON.stringify([ACCOUNT, ['ORDERS', 'POSITIONS'], [], { kind: 'AVAILABLE_HISTORY' }]), cycle: 0, pass: 0, component: 'ORDERS', epoch: 7, requestId: '0:0:ORDERS' });
    expect(f.scans[0]!.limits).toEqual({ pageSize: 2, maxPages: 3 });
    expect(result.eventOrdering).toEqual({ localObservedEventCount: 0, providerSequence: 'NOT_AVAILABLE', gapDetection: 'NOT_CLAIMED' });
    expect(result.historyCompleteness.status).toBe('UNPROVEN');
    expect(f.listenerCount()).toBe(0); // unsubscribed when the run ends
  });

  it('components of a pass may complete out of order; pass 1 starts only after pass 0 completes', async () => {
    const slow = deferred<unknown>();
    const f = fixture({ scan: (request, fx) => (request.binding.cycle === 0 && request.binding.pass === 0 && request.binding.component === 'ORDERS' ? slow.promise : Promise.resolve(respond(request, fx.clock))) });
    const run = start(f);
    await settleAll();
    expect(f.scans.map((s) => `${s.binding.pass}:${s.binding.component}`)).toEqual(['0:ORDERS', '0:POSITIONS']); // POSITIONS done, ORDERS pending
    await f.clock.advance(400); // delayed, within the read timeout
    slow.resolve(respond(f.scans[0]!, f.clock));
    const result = await run;
    expect(result.status).toBe('OBSERVED_CONVERGENCE');
    expect(f.scans.map((s) => `${s.binding.pass}:${s.binding.component}`)).toEqual(['0:ORDERS', '0:POSITIONS', '1:ORDERS', '1:POSITIONS']);
  });

  it.each([
    ['another account', { accountId: 'other' }],
    ['another scope', { scopeId: 'other-scope' }],
    ['another epoch', { epoch: 8 }],
    ['another cycle', { cycle: 5 }],
    ['another request', { requestId: 'x' }],
    ['an extra field', { extra: true }],
  ])('a response bound to %s is never accepted', async (_label, change) => {
    const f = fixture({ scan: (request, fx) => Promise.resolve(request.binding.component === 'ORDERS' && request.binding.pass === 1
      ? { ...respond(request, fx.clock), binding: { ...request.binding, ...change } as AsyncReadBinding } : respond(request, fx.clock)) });
    const result = await start(f, config({ maxCycles: 1 }));
    expect(result.status).toBe('UNRESOLVED');
    expect(result.cycles[0]!.orchestrationReasons).toEqual(['RESPONSE_BINDING_MISMATCH']);
    expect(result.cycles[0]!.reasons).toEqual(expect.arrayContaining(['RESPONSE_BINDING_MISMATCH', 'READ_FAILED']));
  });
});

describe('M4 async orchestration: timeouts, failures, malformed responses and cancellation', () => {
  it('a read that never answers times out on the injected clock: explicit, unresolved, and its signal is aborted', async () => {
    const f = fixture({ scan: (request, fx) => (request.binding.component === 'ORDERS' && request.binding.pass === 0 ? new Promise(() => undefined) : Promise.resolve(respond(request, fx.clock))) });
    const run = start(f, config({ maxCycles: 1 }));
    await settleAll();
    await f.clock.advance(LIMITS.readTimeoutMs);
    const result = await run;
    expect(result.status).toBe('UNRESOLVED');
    expect(result.cycles[0]!.orchestrationReasons).toEqual(['READ_TIMEOUT']);
    expect(result.cycles[0]!.engine?.reasons).toContain('READ_FAILED');
    expect(f.scans[0]!.signal.aborted).toBe(true);
  });

  it.each([
    ['a rejected read', () => Promise.reject(new Error('synthetic failure')), 'READ_REJECTED'],
    ['a thrown read', () => { throw new Error('synthetic throw'); }, 'READ_REJECTED'],
    ['a malformed response', () => Promise.resolve('garbage'), 'RESPONSE_MALFORMED'],
    ['a response without a scan', (request: ScanRequest) => Promise.resolve({ binding: request.binding }), 'RESPONSE_MALFORMED'],
  ])('%s is explicit and unresolved', async (_label, failing, reason) => {
    const f = fixture({ scan: (request, fx) => (request.binding.component === 'POSITIONS' && request.binding.pass === 1 ? (failing as (r: ScanRequest) => Promise<unknown>)(request) : Promise.resolve(respond(request, fx.clock))) });
    const result = await start(f, config({ maxCycles: 1 }));
    expect(result.status).toBe('UNRESOLVED');
    expect(result.cycles[0]!.orchestrationReasons).toEqual([reason]);
  });

  it('a malformed scan inside a well-bound response is rejected by the engine (READ_FAILED)', async () => {
    const f = fixture({ scan: (request, fx) => Promise.resolve(request.binding.component === 'ORDERS' ? { binding: request.binding, scan: { kind: 'SOMETHING' } } : respond(request, fx.clock)) });
    const result = await start(f, config({ maxCycles: 1 }));
    expect(result.status).toBe('UNRESOLVED');
    expect(result.cycles[0]!.orchestrationReasons).toEqual([]);
    expect(result.cycles[0]!.engine?.reasons).toContain('READ_FAILED');
  });

  it('cancellation aborts in-flight reads and ends the run as CANCELLED, never as convergence', async () => {
    const outer = new AbortController();
    const f = fixture({ scan: (request, fx) => (request.binding.pass === 1 ? new Promise(() => undefined) : Promise.resolve(respond(request, fx.clock))) });
    const run = start(f, config(), outer.signal);
    await settleAll();
    outer.abort();
    const result = await run;
    expect(result.status).toBe('CANCELLED');
    expect(result.cycles[0]).toMatchObject({ status: 'CANCELLED', engine: null });
    expect(result.cycles[0]!.orchestrationReasons).toEqual(expect.arrayContaining(['RUN_CANCELLED', 'READ_CANCELLED']));
    expect(f.scans.filter((s) => s.binding.pass === 1).every((s) => s.signal.aborted)).toBe(true);
  });

  it('a stream observation that times out or fails is unavailable, which revokes', async () => {
    const f = fixture({ observe: (request) => (request.point === 'EVALUATION' ? Promise.reject(new Error('stream down')) : Promise.resolve(stream())) });
    const result = await start(f, config({ maxCycles: 1 }));
    expect(result.status).toBe('REVOKED_CYCLE_LIMIT_REACHED');
    expect(result.cycles[0]!.orchestrationReasons).toEqual(['STREAM_OBSERVATION_UNAVAILABLE']);
    expect(result.cycles[0]!.engine?.reasons).toContain('STREAM_DISCONNECTED');
    const hanging = fixture({ observe: (request) => (request.point === 'CYCLE_START' ? new Promise(() => undefined) : Promise.resolve(stream())) });
    const run = start(hanging, config({ maxCycles: 1 }));
    await settleAll();
    await hanging.clock.advance(LIMITS.streamTimeoutMs);
    expect((await run).cycles[0]!.orchestrationReasons).toContain('STREAM_OBSERVATION_UNAVAILABLE');
  });
});

describe('M4 async orchestration: events, epochs and fresh cycles', () => {
  it('an event between reads revokes the cycle at once; a fresh cycle is observed; the local counter is not a provider sequence', async () => {
    const pass1 = deferred<unknown>();
    const f = fixture({ scan: (request, fx) => (request.binding.cycle === 0 && request.binding.pass === 1 && request.binding.component === 'ORDERS' ? pass1.promise : Promise.resolve(respond(request, fx.clock))) });
    const run = start(f);
    await settleAll();
    f.emit({ observedAtMs: f.clock.now() });
    const result = await run;
    expect(result.cycles.map((c) => c.status)).toEqual(['REVOKED', 'OBSERVED_CONVERGENCE']);
    expect(result.cycles[0]).toMatchObject({ engine: null, localObservedEventCount: 1 });
    expect(result.cycles[0]!.orchestrationReasons).toContain('EVENT_OBSERVED_DURING_CYCLE');
    expect(result.status).toBe('OBSERVED_CONVERGENCE');
    expect(result.eventOrdering).toEqual({ localObservedEventCount: 1, providerSequence: 'NOT_AVAILABLE', gapDetection: 'NOT_CLAIMED' });
    expect(f.scans.filter((s) => s.binding.cycle === 1)).toHaveLength(4); // everything re-read
  });

  it('an event during the final observation stays revocation evidence even when the stream buffer is reported empty', async () => {
    let finalObservation: ReturnType<typeof deferred<unknown>> | null = null;
    const f = fixture({ observe: (request) => {
      if (request.cycle === 0 && request.point === 'EVALUATION') { finalObservation = deferred<unknown>(); return finalObservation.promise; }
      return Promise.resolve(stream());
    } });
    const run = start(f, config({ maxCycles: 1 }));
    await settleAll();
    f.emit({ observedAtMs: f.clock.now() });
    (finalObservation as ReturnType<typeof deferred<unknown>> | null)?.resolve(stream({ events: [], bufferedUnprocessedEvents: 0 })); // buffer drained
    const result = await run;
    expect(result.status).toBe('REVOKED_CYCLE_LIMIT_REACHED');
    expect(result.cycles[0]).toMatchObject({ status: 'REVOKED', localObservedEventCount: 1 });
  });

  it('a malformed event still counts and revokes', async () => {
    const pending = deferred<unknown>();
    const f = fixture({ scan: (request, fx) => (request.binding.pass === 1 && request.binding.component === 'ORDERS' ? pending.promise : Promise.resolve(respond(request, fx.clock))) });
    const run = start(f, config({ maxCycles: 1 }));
    await settleAll();
    f.emit('not-an-event');
    expect((await run).cycles[0]).toMatchObject({ status: 'REVOKED', localObservedEventCount: 1 });
  });

  it('a late response from an abandoned cycle never enters the newer cycle', async () => {
    const stale = deferred<unknown>();
    const f = fixture({ scan: (request, fx) => (request.binding.cycle === 0 && request.binding.pass === 1 && request.binding.component === 'ORDERS'
      ? stale.promise : Promise.resolve(respond(request, fx.clock))) });
    const run = start(f);
    await settleAll();
    f.emit({ observedAtMs: f.clock.now() }); // abandon cycle 0
    await settleAll();
    // Cycle 0's read answers late, with different data; cycle 1 has already started.
    stale.resolve(respond(f.scans.find((s) => s.binding.cycle === 0 && s.binding.pass === 1 && s.binding.component === 'ORDERS')!, f.clock, [[order({ filledQuantity: '0.4', remainingQuantity: '0.1' })], []]));
    const result = await run;
    expect(result.status).toBe('OBSERVED_CONVERGENCE');
    const fingerprints = result.cycles[1]!.engine!.records.flatMap((entry) => entry.records.map((r) => r.fingerprint));
    expect(fingerprints.every((fp) => !fp.includes('filledQuantity="0.4"'))).toBe(true);
  });

  it('a stale response misrouted to a newer cycle fails its binding', async () => {
    let first: ScanRequest | null = null;
    const f = fixture({ scan: (request, fx) => {
      if (request.binding.cycle === 0 && request.binding.pass === 0 && request.binding.component === 'ORDERS') first = request;
      // Cycle 1's ORDERS request is answered with cycle 0's response.
      if (request.binding.cycle === 1 && request.binding.pass === 0 && request.binding.component === 'ORDERS') return Promise.resolve(respond(first!, fx.clock));
      return Promise.resolve(respond(request, fx.clock));
    }, observe: (request) => Promise.resolve(request.cycle === 0 && request.point === 'EVALUATION' ? stream({ bufferedUnprocessedEvents: 1 }) : stream()) });
    const result = await start(f);
    expect(result.cycles.map((c) => c.status)).toEqual(['REVOKED', 'UNRESOLVED']);
    expect(result.cycles[1]!.orchestrationReasons).toEqual(['RESPONSE_BINDING_MISMATCH']);
  });

  it('an epoch change during the cycle revokes it; the binding carries the cycle-start epoch', async () => {
    const f = fixture({ observe: (request) => Promise.resolve(request.point === 'EVALUATION' ? stream({ epoch: 8, epochAtWindowStart: 8 }) : stream()) });
    const result = await start(f, config({ maxCycles: 1 }));
    expect(result.status).toBe('REVOKED_CYCLE_LIMIT_REACHED');
    expect(result.cycles[0]!.engine?.reasons).toContain('EPOCH_CHANGED');
    expect(f.scans.every((s) => s.binding.epoch === 7)).toBe(true);
  });

  it('a scan bound to the declared account but reporting another account scope is unresolved', async () => {
    const f = fixture({ scan: (request, fx) => Promise.resolve(respond(request, fx.clock, undefined, { accountScope: { kind: 'CONFIRMED', accountId: 'other' } })) });
    expect((await start(f, config({ maxCycles: 1 }))).cycles[0]!.engine?.reasons).toEqual(['ACCOUNT_SCOPE_MISMATCH']);
  });

  it('the reconnect latch is passed through, never cleared; every cycle revokes until the limit', async () => {
    const f = fixture({ observe: () => Promise.resolve(stream({ reconnectLatched: true })) });
    const result = await start(f, config({ maxCycles: 2 }));
    expect(result.status).toBe('REVOKED_CYCLE_LIMIT_REACHED');
    expect(result.cycles.map((c) => c.engine?.reasons)).toEqual([['RECONNECT_LATCHED'], ['RECONNECT_LATCHED']]);
  });

  it('events in every cycle exhaust the explicit cycle limit', async () => {
    const f = fixture({ scan: (request, fx) => {
      if (request.binding.pass === 1 && request.binding.component === 'ORDERS') { queueMicrotask(() => f.emit({ observedAtMs: fx.clock.now() })); return new Promise(() => undefined); }
      return Promise.resolve(respond(request, fx.clock));
    } });
    const result = await start(f, config({ maxCycles: 3 }));
    expect(result.status).toBe('REVOKED_CYCLE_LIMIT_REACHED');
    expect(result.cycles.map((c) => c.status)).toEqual(['REVOKED', 'REVOKED', 'REVOKED']);
    expect(result.eventOrdering.localObservedEventCount).toBe(3);
  });
});

describe('M4 async orchestration reuses the engine unchanged', () => {
  it('fingerprints, ownership and record views are identical to the synchronous engine for the same data', async () => {
    const pages = (component: ObservationComponent) => (component === 'ORDERS' ? [[order(), order({ exchangeOrderId: 'ex-9', clientOrderId: 'bot-9999' })], []] : PAGES[component]);
    const asyncResult = await start(fixture({ scan: (request, fx) => Promise.resolve(respond(request, fx.clock, pages(request.binding.component))) }), config({ maxCycles: 1 }));
    const syncResult = runSynchronizationCandidate(config({ maxCycles: 1 }), {
      scan: (request: Readonly<{ pass: 0 | 1; component: ObservationComponent; limits: SyncScanLimits; history: SyncHistoryScope }>) => ({ kind: 'SCANNED', accountScope: { kind: 'CONFIRMED', accountId: ACCOUNT }, startedAtMs: 10_000, endedAtMs: 10_000, pages: pages(request.component) }),
      stream: () => stream(),
      clock: () => 10_000,
    });
    expect(asyncResult.cycles[0]!.engine!.records).toEqual(syncResult.cycles[0]!.records);
    expect(asyncResult.cycles[0]!.engine!.records.flatMap((r) => r.records).find((r) => r.key === 'order:ex-9')).toMatchObject({ ownership: 'UNRESOLVED', reason: 'TAG_WITHOUT_DURABLE_INTENT' });
    expect(asyncResult.status).toBe('UNRESOLVED');
  });

  it('cumulative mode keeps fill-level accounting UNKNOWN', async () => {
    const txn = { category: 'FILL', fillId: null, parentExchangeOrderId: 'ex-1', stage: null, amount: '0.5', currency: 'USDT', providerEventTimeMs: 1_700 };
    const f = fixture({ scan: (request, fx) => Promise.resolve(respond(request, fx.clock, request.binding.component === 'TRANSACTIONS' ? [[txn], []] : PAGES[request.binding.component])) });
    const result = await start(f, config({ mode: 'CUMULATIVE_STATE', maxCycles: 1 }, { components: ['ORDERS', 'TRANSACTIONS'] }));
    expect(result.status).toBe('OBSERVED_CONVERGENCE');
    expect(result.cycles[0]!.engine!.assessment.fillLevelAccounting).toMatchObject({ completeFillReconstruction: 'UNKNOWN', exactlyOnceExecutionAccounting: 'UNKNOWN', feeAccounting: 'UNKNOWN' });
  });

  it.each([
    ['no limits', { config: config(), limits: undefined }],
    ['a zero read timeout', { config: config(), limits: { readTimeoutMs: 0, streamTimeoutMs: 1_000 } }],
    ['an invalid engine configuration', { config: { ...config(), maxCycles: 0 }, limits: LIMITS }],
  ])('%s is INVALID_CONFIGURATION (no defaults), with no reads', async (_label, input) => {
    const f = fixture();
    const result = await runAsyncSynchronizationCandidate({ ...input, source: f.source, clock: f.clock });
    expect(result).toMatchObject({ status: 'INVALID_CONFIGURATION', cycles: [], grants: GRANTS_NOTHING });
    expect(f.scans).toEqual([]);
  });
});

describe('M4 async orchestration grants nothing', () => {
  it('no outcome is accepted by any authority, certificate, permit or readiness reader', async () => {
    const outcomes: AsyncSynchronizationResult[] = [
      await start(fixture()),
      await start(fixture({ scan: () => Promise.reject(new Error('x')) }), config({ maxCycles: 1 })),
      await start(fixture({ observe: () => Promise.resolve(stream({ reconnectLatched: true })) }), config({ maxCycles: 1 })),
      await runAsyncSynchronizationCandidate({ config: null, limits: LIMITS, source: fixture().source, clock: new ManualClock() }),
    ];
    expect(outcomes.map((o) => o.status)).toEqual(['OBSERVED_CONVERGENCE', 'UNRESOLVED', 'REVOKED_CYCLE_LIMIT_REACHED', 'INVALID_CONFIGURATION']);
    for (const outcome of outcomes) {
      expect(outcome.grants).toBe(GRANTS_NOTHING);
      for (const candidate of [outcome, ...outcome.cycles, ...outcome.cycles.flatMap((c) => (c.engine === null ? [] : [c.engine, c.engine.assessment]))]) {
        expect(LiveExecutionAuthority.read(candidate)).toBeNull();
        expect(PracticalRecoveryCertificate.read(candidate)).toBeNull();
        expect(LiveReconciliationAuthorization.read(candidate)).toBeNull();
        expect(practicalPrivateStreamReadiness(candidate).kind).not.toBe('PROVEN_READY');
        expect(consumeMutationPermit(candidate, 'CANCEL').kind).toBe('REFUSED');
      }
      expect(JSON.stringify(outcome)).not.toMatch(/READY|SYNCHRONIZED|\bPROVEN|SATISFIED/);
    }
    expect(currentAccountContinuityCapability()).toBe('REST_CURRENT_STATE_OBSERVED');
  });
});
