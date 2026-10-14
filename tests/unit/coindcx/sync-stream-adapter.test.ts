import { describe, expect, it } from 'vitest';
import { practicalPrivateStreamReadiness } from '../../../src/execution/live/practical-recovery/private-events';
import {
  runAsyncSynchronizationCandidate,
  type AsyncClock,
  type AsyncSynchronizationResult,
  type AsyncSynchronizationSource,
} from '../../../src/execution/live/practical-synchronization/async-orchestrator';
import { GRANTS_NOTHING, type ObservationComponent, type SynchronizationConfig } from '../../../src/execution/live/practical-synchronization/engine';
import type { LiveVenueOrderEvidence, LiveVenuePositionEvidence } from '../../../src/execution/live/reconciliation/types';
import { createCoinDcxSyncStreamAdapter, type CoinDcxSyncStreamAdapter, type SyncPrivateStreamPort } from '../../../src/integration/coindcx/live/sync-stream-adapter';
import type { CoinDcxStreamEnvelope, PrivateStreamHealthSnapshot, StreamEventListener } from '../../../src/integration/coindcx/websocket/types';

// SYNTHETIC ONLY: fake injected streams and a manual clock. No socket, credential, client, provider or runtime.
const ACCOUNT = 'synthetic-account';
const CANARY = 'SYNTHETIC-PRIVATE-PAYLOAD-CANARY';
const LIMITS = { readTimeoutMs: 1_000, streamTimeoutMs: 1_000 };

/** A fake private stream: mutable health and a subscriber set that, like the real stream, catches subscriber errors. */
class FakeStream implements SyncPrivateStreamPort {
  public health: Record<string, unknown> = { state: 'AUTH_JOIN_SENT', generationId: 1, reconnectAttempt: 0, connected: true, authJoinSent: true,
    lastEventReceivedAtMs: null, invalidEventCount: 0, staleGenerationDropCount: 0, reconnectCount: 0, reconciliationRequired: false };
  public readonly listeners = new Set<StreamEventListener>();
  public readonly subscriberErrors: unknown[] = [];
  public subscribeCalls = 0;
  public unsubscribeCalls = 0;
  public subscribe(listener: StreamEventListener): () => void {
    this.subscribeCalls += 1;
    this.listeners.add(listener);
    return () => { this.unsubscribeCalls += 1; this.listeners.delete(listener); };
  }
  public getHealthSnapshot(): PrivateStreamHealthSnapshot { return { ...this.health } as unknown as PrivateStreamHealthSnapshot; }
  public emit(eventType: string, payload: unknown = { secret: CANARY }): void {
    const envelope = { source: 'COINDCX', stream: 'PRIVATE_ACCOUNT', generationId: this.health['generationId'], sequence: 1, receivedAtMs: 1,
      eventType, providerTimestampMs: null, pair: CANARY, payload } as unknown as CoinDcxStreamEnvelope<unknown>;
    for (const listener of [...this.listeners]) { try { listener(envelope); } catch (error) { this.subscriberErrors.push(error); } }
  }
}

class TestClock implements AsyncClock {
  public t = 10_000;
  public now(): number { return this.t; }
  public delay(_ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  }
}

function order(): LiveVenueOrderEvidence {
  return { exchangeOrderId: 'ex-1', pair: 'B-BTC_USDT', side: 'BUY', venueStatus: 'open', orderedQuantity: '0.5', filledQuantity: '0', remainingQuantity: '0.5',
    cancelledQuantity: '0', averageFillPrice: null, price: '64000.5', wireOrderType: 'limit_order', leverage: '5', providerCreatedAtMs: 1_000, providerEventTimeMs: 1_500, clientOrderId: 'bot-0001' };
}
function position(): LiveVenuePositionEvidence {
  return { venuePositionId: 'pos-1', pair: 'B-BTC_USDT', signedQuantity: '0.5', averageEntryPrice: '64000.5', leverage: '5', providerEventTimeMs: 1_600 };
}
const config = (maxCycles: number): SynchronizationConfig => ({
  mode: 'FULL_EVIDENCE',
  scope: { accountId: ACCOUNT, components: ['ORDERS', 'POSITIONS'], requiredAccounting: [], history: { kind: 'AVAILABLE_HISTORY' } },
  scanLimits: { ORDERS: { pageSize: 2, maxPages: 3 }, POSITIONS: { pageSize: 2, maxPages: 3 } },
  thresholds: { maxEvidenceAgeMs: 5_000, maxTotalReadDurationMs: 2_000 },
  maxCycles,
  lineage: { ownedOrders: [{ exchangeOrderId: 'ex-1', intentId: 'intent-1' }], ambiguousCreates: [], closedIntentTags: [], ownedPositions: ['pos-1'], botTagNamespace: 'bot-' },
  contracts: { tagContract: { confirmed: false }, venueGeneratedOrderTypes: null, venueGeneratedWalletStages: null, terminalShortPage: {} },
});
const PAGES: Record<ObservationComponent, unknown[][]> = { ORDERS: [[order()], []], POSITIONS: [[position()], []], TRANSACTIONS: [[], []] };

function harness() {
  const stream = new FakeStream();
  const clock = new TestClock();
  const adapter = createCoinDcxSyncStreamAdapter({ stream, clock })!;
  return { stream, clock, adapter, runSubscriptions: 0, runUnsubscriptions: 0 };
}
/** Reads go through a fake scan; `during` runs inside each read (to change the stream mid-window). */
function sourceOf(h: ReturnType<typeof harness>, during?: (cycle: number, pass: 0 | 1, component: ObservationComponent) => void): AsyncSynchronizationSource {
  return {
    async scan({ binding }) {
      during?.(binding.cycle, binding.pass, binding.component);
      const startedAtMs = h.clock.now();
      h.clock.t += 5;
      return { binding, scan: { kind: 'SCANNED', accountScope: { kind: 'CONFIRMED', accountId: ACCOUNT }, startedAtMs, endedAtMs: h.clock.now(), pages: PAGES[binding.component] } };
    },
    observeStream: h.adapter.observeStream,
    subscribeEvents(listener) {
      h.runSubscriptions += 1;
      const remove = h.adapter.subscribeEvents(listener);
      return () => { h.runUnsubscriptions += 1; remove(); };
    },
  };
}
const runWith = (h: ReturnType<typeof harness>, maxCycles: number, during?: Parameters<typeof sourceOf>[1]): Promise<AsyncSynchronizationResult> =>
  runAsyncSynchronizationCandidate({ config: config(maxCycles), limits: LIMITS, source: sourceOf(h, during), clock: h.clock });
const once = (fn: () => void) => { let done = false; return () => { if (!done) { done = true; fn(); } }; };
const signal = new AbortController().signal;
async function evaluateWindow(adapter: CoinDcxSyncStreamAdapter, change: () => void, cycle = 0): Promise<Record<string, unknown>> {
  await adapter.observeStream({ cycle, point: 'CYCLE_START', signal });
  change();
  return await adapter.observeStream({ cycle, point: 'EVALUATION', signal }) as Record<string, unknown>;
}

describe('M4 private-stream observation adapter through the asynchronous synchronization candidate', () => {
  it('a quiet stream is recorded, never credited, with UNKNOWN acknowledgement and no continuity, readiness or grant', async () => {
    const h = harness();
    const result = await runWith(h, 1);
    expect(result.status).toBe('OBSERVED_CONVERGENCE');
    expect(result.semantics).toBe('OBSERVED_CONVERGENCE_WITHIN_DECLARED_SCAN_SCOPE');
    expect(result.historyCompleteness.status).toBe('UNPROVEN');
    expect(result.eventOrdering).toEqual({ localObservedEventCount: 0, providerSequence: 'NOT_AVAILABLE', gapDetection: 'NOT_CLAIMED' });
    const assessment = result.cycles[0]!.engine!.assessment;
    expect(assessment.stream).toMatchObject({ epoch: 1, quietStream: true, quietStreamProvesNoActivity: false, privateStreamReadiness: 'NOT_ASSESSED', joinAcknowledgement: 'UNKNOWN' });
    expect(assessment.providerSynchronization.status).toBe('NOT_ESTABLISHED');
    expect(practicalPrivateStreamReadiness(h.stream.getHealthSnapshot()).kind).not.toBe('PROVEN_READY');
    expect(result.grants).toBe(GRANTS_NOTHING);
    expect(JSON.stringify(result)).not.toMatch(/READY"|SYNCHRONIZED|\bPROVEN|PROVIDER_CONFIRMED/);
  });

  it('an envelope during a window revokes that cycle; a fresh quiet cycle is then observed, and no payload is retained', async () => {
    const h = harness();
    const forwarded: unknown[] = [];
    const spy = h.adapter.subscribeEvents((event) => forwarded.push(event));
    const emitOnce = once(() => h.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION'));
    const result = await runWith(h, 2, (cycle) => { if (cycle === 0) emitOnce(); });
    spy();
    expect(result.cycles.map((cycle) => cycle.status)).toEqual(['REVOKED', 'OBSERVED_CONVERGENCE']);
    expect(result.cycles[0]!.reasons).toContain('EVENT_OBSERVED_DURING_CYCLE');
    expect(forwarded).toEqual([{ observedAtMs: 10_000 }]);
    expect(JSON.stringify([result, forwarded])).not.toContain(CANARY);
  });

  it('a generation change during the window revokes as a changed epoch and a disconnect', async () => {
    const h = harness();
    const result = await runWith(h, 1, (_c, pass) => { if (pass === 1) h.stream.health = { ...h.stream.health, generationId: 2 }; });
    expect(result.status).toBe('REVOKED_CYCLE_LIMIT_REACHED');
    expect(result.cycles[0]!.reasons).toEqual(expect.arrayContaining(['EPOCH_CHANGED', 'DISCONNECT_DURING_WINDOW']));
  });

  it('a disconnect followed by a reconnect before the final snapshot is not erased by the final connected snapshot', async () => {
    // Health only, no envelope: socket errors reconnect without dispatching PRIVATE_STREAM_DISCONNECTED.
    const h = harness();
    const result = await runWith(h, 1, (_c, pass, component) => {
      if (pass !== 0 || component !== 'ORDERS') return;
      h.stream.health = { ...h.stream.health, connected: false, state: 'RECONNECT_WAIT', reconnectCount: 1 };
      h.stream.health = { ...h.stream.health, connected: true, state: 'RECONCILIATION_REQUIRED', generationId: 2, reconciliationRequired: true };
    });
    expect(result.status).toBe('REVOKED_CYCLE_LIMIT_REACHED');
    expect(result.cycles[0]!.reasons).toEqual(expect.arrayContaining(['DISCONNECT_DURING_WINDOW', 'EPOCH_CHANGED', 'RECONNECT_LATCHED']));
    // A disconnect envelope alone (same generation, connected again) is latched too.
    const direct = harness();
    const observed = await evaluateWindow(direct.adapter, () => {
      direct.stream.health = { ...direct.stream.health, connected: false };
      direct.stream.emit('PRIVATE_STREAM_DISCONNECTED');
      direct.stream.health = { ...direct.stream.health, connected: true };
    });
    expect(observed).toMatchObject({ connected: true, epoch: 1, epochAtWindowStart: 1, disconnectObservedSinceWindowStart: true });
    // A reconnect counted without a generation change is still a disconnect.
    const counted = harness();
    expect(await evaluateWindow(counted.adapter, () => { counted.stream.health = { ...counted.stream.health, reconnectCount: 1 }; }))
      .toMatchObject({ disconnectObservedSinceWindowStart: true });
  });

  it('the sticky reconciliation latch revokes every cycle, and a latch at window start is never cleared by a later snapshot', async () => {
    const h = harness();
    h.stream.health = { ...h.stream.health, reconciliationRequired: true, state: 'RECONCILIATION_REQUIRED' };
    const result = await runWith(h, 2);
    expect(result.status).toBe('REVOKED_CYCLE_LIMIT_REACHED');
    for (const cycle of result.cycles) expect(cycle.reasons).toContain('RECONNECT_LATCHED');
    const direct = harness();
    direct.stream.health = { ...direct.stream.health, reconciliationRequired: true };
    expect(await evaluateWindow(direct.adapter, () => { direct.stream.health = { ...direct.stream.health, reconciliationRequired: false }; }))
      .toMatchObject({ reconnectLatched: true });
  });

  it('an invalid-event-count rise (a dropped malformed notification) is an unknown event that revokes', async () => {
    const h = harness();
    const result = await runWith(h, 1, (_c, pass) => { if (pass === 1) h.stream.health = { ...h.stream.health, invalidEventCount: 1 }; });
    expect(result.status).toBe('REVOKED_CYCLE_LIMIT_REACHED');
    expect(result.cycles[0]!.reasons).toContain('EVENT_DURING_OR_AFTER_WINDOW');
    const direct = harness();
    direct.clock.t = 12_345;
    expect(await evaluateWindow(direct.adapter, () => { direct.stream.health = { ...direct.stream.health, invalidEventCount: 3 }; }))
      .toMatchObject({ events: [{ observedAtMs: 12_345 }], disconnectObservedSinceWindowStart: false });
  });

  it('confirmation-like health fields are never promoted into a join acknowledgement', async () => {
    const h = harness();
    h.stream.health = { ...h.stream.health, authJoinSent: true, subscriptionConfirmation: { source: 'PROVIDER', incarnation: 1, confirmedAtMs: 1 },
      joinAcknowledgement: { kind: 'PROVIDER_CONFIRMED', epoch: 1 } };
    expect(await evaluateWindow(h.adapter, () => undefined)).toMatchObject({ joinAcknowledgement: { kind: 'UNKNOWN' } });
    const result = await runWith(h, 1);
    expect(result.cycles[0]!.engine!.assessment.stream?.joinAcknowledgement).toBe('UNKNOWN');
    expect(result.cycles[0]!.engine!.assessment.providerSynchronization.status).toBe('NOT_ESTABLISHED');
  });
});

describe('M4 private-stream observation adapter: window, subscription and failure lifecycle', () => {
  it('subscribes once at creation; the run subscribes and unsubscribes its listener; close unsubscribes the stream once', async () => {
    const h = harness();
    expect(h.stream.subscribeCalls).toBe(1);
    await runWith(h, 1);
    expect([h.runSubscriptions, h.runUnsubscriptions, h.stream.subscribeCalls, h.stream.unsubscribeCalls]).toEqual([1, 1, 1, 0]);
    const forwarded: unknown[] = [];
    const remove = h.adapter.subscribeEvents((event) => forwarded.push(event));
    h.stream.emit('PRIVATE_POSITION_UPDATE_NOTIFICATION');
    remove(); remove(); // idempotent
    h.stream.emit('PRIVATE_POSITION_UPDATE_NOTIFICATION');
    expect(forwarded).toHaveLength(1); // delivered only until removed
    h.adapter.close(); h.adapter.close();
    expect(h.stream.unsubscribeCalls).toBe(1);
    await expect(h.adapter.observeStream({ cycle: 0, point: 'CYCLE_START', signal })).rejects.toThrow('SYNC_STREAM_ADAPTER_CLOSED');
    expect(() => h.adapter.subscribeEvents(() => undefined)).toThrow('SYNC_STREAM_ADAPTER_CLOSED');
  });

  it('opens a window only at CYCLE_START, closes it at EVALUATION, and keeps events outside a window out of the next one', async () => {
    const h = harness();
    await expect(h.adapter.observeStream({ cycle: 0, point: 'EVALUATION', signal })).rejects.toThrow('SYNC_STREAM_WINDOW_NOT_STARTED');
    h.stream.emit('PRIVATE_BALANCE_CHANGE_NOTIFICATION'); // no window open
    await h.adapter.observeStream({ cycle: 0, point: 'CYCLE_START', signal });
    await h.adapter.observeStream({ cycle: 1, point: 'CYCLE_START', signal }); // a fresh window replaces the earlier one
    await expect(h.adapter.observeStream({ cycle: 0, point: 'EVALUATION', signal })).rejects.toThrow('SYNC_STREAM_WINDOW_NOT_STARTED');
    h.clock.t = 10_100;
    h.stream.emit('PRIVATE_BALANCE_CHANGE_NOTIFICATION');
    const observed = await h.adapter.observeStream({ cycle: 1, point: 'EVALUATION', signal }) as Record<string, unknown>;
    expect(observed['events']).toEqual([{ observedAtMs: 10_100 }]);
    await expect(h.adapter.observeStream({ cycle: 1, point: 'EVALUATION', signal })).rejects.toThrow('SYNC_STREAM_WINDOW_NOT_STARTED');
  });

  it('keeps every envelope of a synchronous burst and an event during cycle-start capture; an aborted cycle ends its window', async () => {
    const h = harness();
    const realHealth = h.stream.getHealthSnapshot.bind(h.stream);
    let emitDuringCapture = true;
    h.stream.getHealthSnapshot = () => {
      if (emitDuringCapture) { emitDuringCapture = false; h.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION'); }
      return realHealth();
    };
    await h.adapter.observeStream({ cycle: 0, point: 'CYCLE_START', signal });
    for (let i = 0; i < 3; i += 1) h.stream.emit('PRIVATE_POSITION_UPDATE_NOTIFICATION');
    const observed = await h.adapter.observeStream({ cycle: 0, point: 'EVALUATION', signal }) as Record<string, unknown>;
    expect(observed['events']).toHaveLength(4); // no event is collapsed or lost
    // After its cycle's signal aborts, the window is gone: a burst then is not retained, and its evaluation rejects.
    const cycleController = new AbortController();
    await h.adapter.observeStream({ cycle: 1, point: 'CYCLE_START', signal: cycleController.signal });
    h.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    cycleController.abort();
    for (let i = 0; i < 3; i += 1) h.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    await expect(h.adapter.observeStream({ cycle: 1, point: 'EVALUATION', signal })).rejects.toThrow('SYNC_STREAM_WINDOW_NOT_STARTED');
    // Through the orchestration, a burst during a read revokes on the first envelope and the next cycle starts clean.
    const run = harness();
    const burst = once(() => { for (let i = 0; i < 5; i += 1) run.stream.emit('PRIVATE_BALANCE_CHANGE_NOTIFICATION'); });
    const result = await runWith(run, 2, (cycle) => { if (cycle === 0) burst(); });
    expect(result.cycles.map((cycle) => cycle.status)).toEqual(['REVOKED', 'OBSERVED_CONVERGENCE']);
    expect(result.cycles[1]!.engine!.assessment.stream).toMatchObject({ quietStream: true });
  });

  it('a failed evaluation, a missing signal, a failed subscription and a failed unsubscribe leave no clean state behind', async () => {
    const h = harness();
    const realHealth = h.stream.getHealthSnapshot.bind(h.stream);
    await h.adapter.observeStream({ cycle: 0, point: 'CYCLE_START', signal });
    h.stream.getHealthSnapshot = () => { throw new Error('synthetic health failure'); };
    await expect(h.adapter.observeStream({ cycle: 0, point: 'EVALUATION', signal })).rejects.toThrow('synthetic health failure');
    h.stream.getHealthSnapshot = realHealth;
    await expect(h.adapter.observeStream({ cycle: 0, point: 'EVALUATION', signal })).rejects.toThrow('SYNC_STREAM_WINDOW_NOT_STARTED');
    await expect(h.adapter.observeStream({ cycle: 0, point: 'CYCLE_START', signal: undefined as unknown as AbortSignal })).rejects.toThrow('SYNC_STREAM_REQUEST_INVALID');
    // A subscribe that registers the listener and then throws: the leftover listener records and reads nothing.
    let clockReads = 0;
    let leftover: StreamEventListener | null = null;
    const partial = { getHealthSnapshot: () => realHealth(), subscribe: (listener: StreamEventListener) => { leftover = listener; throw new Error('synthetic subscribe failure'); } };
    expect(() => createCoinDcxSyncStreamAdapter({ stream: partial, clock: { now: () => { clockReads += 1; return 10_000; } } })).toThrow('synthetic subscribe failure');
    expect(() => leftover!({} as CoinDcxStreamEnvelope<unknown>)).not.toThrow();
    expect(clockReads).toBe(0);
    // An unsubscribe failure on close propagates, and the adapter is closed regardless.
    const failing = new FakeStream();
    failing.subscribe = () => () => { throw new Error('synthetic unsubscribe failure'); };
    const adapter = createCoinDcxSyncStreamAdapter({ stream: failing, clock: new TestClock() })!;
    expect(() => adapter.close()).toThrow('synthetic unsubscribe failure');
    await expect(adapter.observeStream({ cycle: 0, point: 'CYCLE_START', signal })).rejects.toThrow('SYNC_STREAM_ADAPTER_CLOSED');
  });

  it('a failed observation rejects, and the orchestration then revokes as unavailable', async () => {
    const throwing = harness();
    throwing.stream.getHealthSnapshot = () => { throw new Error('synthetic health failure'); };
    const failed = await runWith(throwing, 1);
    expect(failed.status).toBe('REVOKED_CYCLE_LIMIT_REACHED');
    expect(failed.cycles[0]!.reasons).toContain('STREAM_OBSERVATION_UNAVAILABLE');
    for (const bad of [{ ...harness().stream.health, generationId: -1 }, { ...harness().stream.health, reconnectCount: undefined }, null]) {
      const h = harness();
      h.stream.getHealthSnapshot = () => bad as unknown as PrivateStreamHealthSnapshot;
      await expect(h.adapter.observeStream({ cycle: 0, point: 'CYCLE_START', signal })).rejects.toThrow('SYNC_STREAM_HEALTH_MALFORMED');
    }
    const aborted = new AbortController(); aborted.abort();
    await expect(harness().adapter.observeStream({ cycle: 0, point: 'CYCLE_START', signal: aborted.signal })).rejects.toThrow('SYNC_STREAM_OBSERVATION_CANCELLED');
    const fractional = harness();
    await fractional.adapter.observeStream({ cycle: 0, point: 'CYCLE_START', signal });
    fractional.clock.t = 10_000.5;
    fractional.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    await expect(fractional.adapter.observeStream({ cycle: 0, point: 'EVALUATION', signal })).rejects.toThrow('SYNC_STREAM_CLOCK_INVALID');
    const zero = harness();
    zero.stream.health = { ...zero.stream.health, generationId: 0, connected: false, state: 'STOPPED' };
    expect(await evaluateWindow(zero.adapter, () => undefined)).toMatchObject({ epoch: null, epochAtWindowStart: null, connected: false, disconnectObservedSinceWindowStart: true });
  });

  it('a consumer failure is counted as an unprocessed event, rethrown to the stream, and revokes later windows', async () => {
    const h = harness();
    const delivered: unknown[] = [];
    const removeBad = h.adapter.subscribeEvents(() => { throw new Error('synthetic consumer failure'); });
    const removeGood = h.adapter.subscribeEvents((event) => delivered.push(event));
    h.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    removeBad(); removeGood();
    expect(delivered).toHaveLength(1); // the other consumer still received it
    expect(h.stream.subscriberErrors.map((error) => (error as Error).message)).toEqual(['SYNC_STREAM_CONSUMER_FAILED']);
    expect(await evaluateWindow(h.adapter, () => undefined)).toMatchObject({ bufferedUnprocessedEvents: 1 });
    const result = await runWith(h, 1);
    expect(result.cycles[0]!.reasons).toContain('BUFFERED_EVENTS_PENDING');
  });

  it('rejects invalid options and an invalid subscription explicitly', () => {
    const stream = new FakeStream();
    expect(createCoinDcxSyncStreamAdapter({ stream, clock: undefined as unknown as { now(): number } })).toBeNull();
    expect(createCoinDcxSyncStreamAdapter({ stream: {} as SyncPrivateStreamPort, clock: new TestClock() })).toBeNull();
    expect(() => createCoinDcxSyncStreamAdapter({ stream: { ...stream, getHealthSnapshot: () => stream.getHealthSnapshot(), subscribe: () => { throw new Error('synthetic subscribe failure'); } }, clock: new TestClock() }))
      .toThrow('synthetic subscribe failure');
    expect(() => createCoinDcxSyncStreamAdapter({ stream: { getHealthSnapshot: () => stream.getHealthSnapshot(), subscribe: () => undefined as unknown as () => void }, clock: new TestClock() }))
      .toThrow('SYNC_STREAM_SUBSCRIBE_INVALID');
  });
});
