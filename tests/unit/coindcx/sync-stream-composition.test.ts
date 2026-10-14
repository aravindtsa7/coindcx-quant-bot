import http from 'node:http';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { practicalPrivateStreamReadiness } from '../../../src/execution/live/practical-recovery/private-events';
import {
  runAsyncSynchronizationCandidate,
  type AsyncClock,
  type AsyncSynchronizationResult,
  type AsyncSynchronizationSource,
} from '../../../src/execution/live/practical-synchronization/async-orchestrator';
import { GRANTS_NOTHING, type ObservationComponent, type SynchronizationConfig } from '../../../src/execution/live/practical-synchronization/engine';
import type { LiveVenueOrderEvidence, LiveVenuePositionEvidence } from '../../../src/execution/live/reconciliation/types';
import { createCoinDcxSyncStreamAdapter, type CoinDcxSyncStreamAdapter } from '../../../src/integration/coindcx/live/sync-stream-adapter';
import { CoinDcxPrivateAccountStream } from '../../../src/integration/coindcx/websocket/private-stream';
import type { CoinDcxStreamEnvelope } from '../../../src/integration/coindcx/websocket/types';
import { createTestStreamContext } from './ws/test-helpers';

// SYNTHETIC ONLY: the REAL private stream class over the existing fake socket factory, manual scheduler and fake
// clock, with placeholder keys supplied here. No real socket, credential, network, provider or runtime.
const SYNTHETIC_KEY = 'SYNTHETIC-PLACEHOLDER-API-KEY';
const SYNTHETIC_SECRET = 'SYNTHETIC-PLACEHOLDER-API-SECRET';
const CANARY = 'SYNTHETIC-PRIVATE-PAYLOAD-CANARY';
const ACCOUNT = 'synthetic-account';
const LIMITS = { readTimeoutMs: 1_000, streamTimeoutMs: 1_000 };

class TestClock implements AsyncClock {
  public t = 10_000;
  public now(): number { return this.t; }
  public delay(_ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  }
}

const order = (): LiveVenueOrderEvidence => ({ exchangeOrderId: 'ex-1', pair: 'B-BTC_USDT', side: 'BUY', venueStatus: 'open', orderedQuantity: '0.5', filledQuantity: '0',
  remainingQuantity: '0.5', cancelledQuantity: '0', averageFillPrice: null, price: '64000.5', wireOrderType: 'limit_order', leverage: '5', providerCreatedAtMs: 1_000,
  providerEventTimeMs: 1_500, clientOrderId: 'bot-0001' });
const position = (): LiveVenuePositionEvidence => ({ venuePositionId: 'pos-1', pair: 'B-BTC_USDT', signedQuantity: '0.5', averageEntryPrice: '64000.5', leverage: '5', providerEventTimeMs: 1_600 });
const PAGES: Record<ObservationComponent, unknown[][]> = { ORDERS: [[order()], []], POSITIONS: [[position()], []], TRANSACTIONS: [[], []] };
/** SYNTHETIC lineage and unconfirmed contracts: test inputs only, never ownership evidence or provider settings. */
const config = (maxCycles: number): SynchronizationConfig => ({
  mode: 'FULL_EVIDENCE',
  scope: { accountId: ACCOUNT, components: ['ORDERS', 'POSITIONS'], requiredAccounting: [], history: { kind: 'AVAILABLE_HISTORY' } },
  scanLimits: { ORDERS: { pageSize: 2, maxPages: 3 }, POSITIONS: { pageSize: 2, maxPages: 3 } },
  thresholds: { maxEvidenceAgeMs: 5_000, maxTotalReadDurationMs: 2_000 },
  maxCycles,
  lineage: { ownedOrders: [{ exchangeOrderId: 'ex-1', intentId: 'intent-1' }], ambiguousCreates: [], closedIntentTags: [], ownedPositions: ['pos-1'], botTagNamespace: 'bot-' },
  contracts: { tagContract: { confirmed: false }, venueGeneratedOrderTypes: null, venueGeneratedWalletStages: null, terminalShortPage: {} },
});
/** A synthetic, schema-valid INR position update (shape from the existing private-event tests). */
const positionUpdate = () => [{ id: 'SYNTHETIC-pos', pair: 'B-BTC_USDT', active_pos: '0.5', avg_price: '51234.5', liquidation_price: '45000.0', locked_margin: '5123.45',
  leverage: 10, mark_price: '51250.0', maintenance_margin: '512.35', updated_at: 1700000050000, margin_type: 'isolated', margin_currency_short_name: 'INR',
  settlement_currency_avg_price: '89.5', note: CANARY }];

type Composition = ReturnType<typeof composition>;
function composition() {
  const ctx = createTestStreamContext();
  const stream = new CoinDcxPrivateAccountStream({ apiKey: SYNTHETIC_KEY, apiSecret: SYNTHETIC_SECRET, socketFactory: ctx.socketFactory, clock: ctx.clock,
    scheduler: ctx.scheduler, rng: ctx.rng });
  const clock = new TestClock();
  const adapter = createCoinDcxSyncStreamAdapter({ stream, clock })!;
  return { ctx, stream, clock, adapter, forwarded: [] as unknown[] };
}
/** Starts the real stream on fakes only, runs `body`, and always closes the adapter and stops the stream. */
async function withComposition(body: (c: Composition) => Promise<void>, created: Composition[] = []): Promise<void> {
  const c = composition();
  created.push(c);
  try {
    expect(c.ctx.socketFactory.createdSockets).toHaveLength(0); // nothing is created before start, and only fakes after
    await c.stream.start();
    expect(c.ctx.socketFactory.createdSockets).toHaveLength(1);
    await body(c);
  } finally {
    try { c.adapter.close(); } finally { c.stream.stop(); }
  }
}
const socketOf = (c: Composition) => c.ctx.socketFactory.latestSocket!;
function sourceOf(c: Composition, during?: (cycle: number, pass: 0 | 1, component: ObservationComponent) => void): AsyncSynchronizationSource {
  return {
    async scan({ binding }) {
      during?.(binding.cycle, binding.pass, binding.component);
      const startedAtMs = c.clock.now();
      c.clock.t += 5;
      return { binding, scan: { kind: 'SCANNED', accountScope: { kind: 'CONFIRMED', accountId: ACCOUNT }, startedAtMs, endedAtMs: c.clock.now(), pages: PAGES[binding.component] } };
    },
    observeStream: c.adapter.observeStream,
    subscribeEvents(listener) { return c.adapter.subscribeEvents((event) => { c.forwarded.push(event); listener(event); }); },
  };
}
const runWith = (c: Composition, maxCycles: number, during?: Parameters<typeof sourceOf>[1]): Promise<AsyncSynchronizationResult> =>
  runAsyncSynchronizationCandidate({ config: config(maxCycles), limits: LIMITS, source: sourceOf(c, during), clock: c.clock });
const firstRead = (fn: () => void) => (cycle: number, pass: 0 | 1, component: ObservationComponent) => { if (cycle === 0 && pass === 0 && component === 'ORDERS') fn(); };
const signal = new AbortController().signal;
async function directWindow(adapter: CoinDcxSyncStreamAdapter, change: () => void): Promise<Record<string, unknown>> {
  await adapter.observeStream({ cycle: 0, point: 'CYCLE_START', signal });
  change();
  return await adapter.observeStream({ cycle: 0, point: 'EVALUATION', signal }) as Record<string, unknown>;
}
function expectNothingRetained(...values: unknown[]): void {
  const text = JSON.stringify(values);
  for (const secret of [SYNTHETIC_KEY, SYNTHETIC_SECRET, CANARY]) expect(text).not.toContain(secret);
}

const denied = () => { throw new Error('SYNTHETIC_COMPOSITION_NETWORK_FORBIDDEN'); };
beforeEach(() => {
  vi.spyOn(http, 'request').mockImplementation(denied);
  vi.spyOn(https, 'request').mockImplementation(denied);
  vi.spyOn(globalThis, 'fetch').mockImplementation(denied);
});
afterEach(() => {
  // Restore first, so a failed check below can never leave the guards installed for later tests.
  const calls = [http.request, https.request, fetch].map((guarded) => vi.mocked(guarded).mock.calls.length);
  vi.restoreAllMocks();
  expect(calls).toEqual([0, 0, 0]);
});

describe('M4 sync-stream adapter over the REAL private stream class (fake transport and timers only)', () => {
  it('1. an initial synthetic connection records the local epoch; acknowledgement stays UNKNOWN; no readiness claim', async () => {
    await withComposition(async (c) => {
      expect(c.stream.state).toBe('AUTH_JOIN_SENT');
      const result = await runWith(c, 1);
      expect(result.status).toBe('OBSERVED_CONVERGENCE');
      const assessment = result.cycles[0]!.engine!.assessment;
      expect(assessment.stream).toMatchObject({ epoch: c.stream.generationId, joinAcknowledgement: 'UNKNOWN', privateStreamReadiness: 'NOT_ASSESSED',
        quietStream: true, quietStreamProvesNoActivity: false });
      expect(c.stream.generationId).toBe(1);
      expect(assessment.providerSynchronization.status).toBe('NOT_ESTABLISHED');
      expect(practicalPrivateStreamReadiness(c.stream.getHealthSnapshot())).toEqual({ kind: 'UNPROVEN', reason: 'NO_PROVIDER_CONFIRMATION' });
      expect(result.historyCompleteness.status).toBe('UNPROVEN');
      expect(result.grants).toBe(GRANTS_NOTHING);
      expectNothingRetained(result, c.forwarded);
    });
  });

  it('2. a disconnect and reconnect are latched; the final connected snapshot does not erase them; later cycles stay revoked', async () => {
    await withComposition(async (c) => {
      const observed = await directWindow(c.adapter, () => {
        socketOf(c).trigger('disconnect', 'transport close');
        expect(c.stream.state).toBe('RECONNECT_WAIT');
        c.ctx.scheduler.runAllTimers(); // the real reconnect: a new generation and the sticky reconciliation latch
      });
      expect(c.stream.connected).toBe(true);
      expect(c.stream.getHealthSnapshot()).toMatchObject({ generationId: 2, reconnectCount: 1, reconciliationRequired: true, state: 'RECONCILIATION_REQUIRED' });
      expect(observed).toMatchObject({ connected: true, epoch: 2, epochAtWindowStart: 1, disconnectObservedSinceWindowStart: true, reconnectLatched: true,
        joinAcknowledgement: { kind: 'UNKNOWN' }, bufferedUnprocessedEvents: 0 });
      expect(observed['events']).toHaveLength(3); // disconnect, reconciliation-required and connected envelopes, as local times only
      const later = await runWith(c, 2);
      expect(later.status).toBe('REVOKED_CYCLE_LIMIT_REACHED');
      expect(later.cycles.map((cycle) => cycle.reasons)).toEqual([['RECONNECT_LATCHED'], ['RECONNECT_LATCHED']]);
      expectNothingRetained(observed, later);
    });
    // Through the orchestration: the disconnect envelope revokes the cycle it occurs in; the latch revokes the next.
    await withComposition(async (c) => {
      const result = await runWith(c, 2, firstRead(() => { socketOf(c).trigger('disconnect', 'transport close'); c.ctx.scheduler.runAllTimers(); }));
      expect(result.cycles.map((cycle) => cycle.status)).toEqual(['REVOKED', 'REVOKED']);
      expect(result.cycles[0]!.reasons).toEqual(['EVENT_OBSERVED_DURING_CYCLE', 'READ_CANCELLED']); // the revocation aborts the in-flight reads
      expect(result.cycles[1]!.reasons).toEqual(['RECONNECT_LATCHED']);
      expectNothingRetained(result, c.forwarded);
    });
  });

  it.each(['error', 'connect_error'])('3. a socket %s schedules a reconnect without a disconnect envelope, and still revokes', async (event) => {
    await withComposition(async (c) => {
      const result = await runWith(c, 1, firstRead(() => { socketOf(c).trigger(event); }));
      expect(c.stream.getHealthSnapshot()).toMatchObject({ state: 'RECONNECT_WAIT', connected: false, generationId: 1, reconnectCount: 1 });
      expect(c.forwarded).toEqual([]); // no envelope reached any consumer
      expect(result.status).toBe('REVOKED_CYCLE_LIMIT_REACHED');
      expect(result.cycles[0]!.reasons).toEqual(['DISCONNECT_DURING_WINDOW', 'STREAM_DISCONNECTED']);
    });
  });

  it('4. a malformed notification raises the real invalid-event count and is an unknown event that revokes', async () => {
    await withComposition(async (c) => {
      const result = await runWith(c, 1, firstRead(() => { socketOf(c).trigger('df-order-update', { malformed: CANARY }); }));
      expect(c.stream.getHealthSnapshot().invalidEventCount).toBe(1);
      expect(c.forwarded).toEqual([]); // the real stream drops it; only its count changes
      expect(result.cycles[0]!.reasons).toEqual(['EVENT_DURING_OR_AFTER_WINDOW']);
      expectNothingRetained(result);
    });
  });

  it('5. stop() during an observation window prevents a clean cycle (disconnected, new generation)', async () => {
    await withComposition(async (c) => {
      const result = await runWith(c, 1, firstRead(() => { c.stream.stop(); }));
      expect(c.stream.getHealthSnapshot()).toMatchObject({ state: 'STOPPED', connected: false, generationId: 2 });
      expect(result.cycles[0]!.reasons).toEqual(['DISCONNECT_DURING_WINDOW', 'EPOCH_CHANGED', 'STREAM_DISCONNECTED']);
      // A window opened on the stopped stream has no usable window-start epoch either.
      const next = await runWith(c, 1);
      expect(next.cycles[0]!.reasons).toEqual(expect.arrayContaining(['EPOCH_UNKNOWN', 'STREAM_DISCONNECTED']));
    });
  });

  it('6. cleanup runs even when a test body fails, and a closed adapter receives nothing from the still-running stream', async () => {
    const created: Composition[] = [];
    await expect(withComposition(async () => { throw new Error('SYNTHETIC body failure'); }, created)).rejects.toThrow('SYNTHETIC body failure');
    const failed = created[0]!;
    expect(failed.stream.state).toBe('STOPPED');
    expect([failed.ctx.scheduler.activeTimerCount, failed.ctx.scheduler.activeIntervalCount]).toEqual([0, 0]);
    expect(failed.ctx.socketFactory.latestSocket!.listeners.size).toBe(0);
    await expect(failed.adapter.observeStream({ cycle: 0, point: 'CYCLE_START', signal })).rejects.toThrow('SYNC_STREAM_ADAPTER_CLOSED');

    await withComposition(async (c) => {
      const toAdapterConsumer: unknown[] = [];
      const direct: CoinDcxStreamEnvelope<unknown>[] = [];
      c.adapter.subscribeEvents((event) => toAdapterConsumer.push(event));
      const unsubscribeDirect = c.stream.subscribe((envelope) => direct.push(envelope));
      socketOf(c).trigger('df-position-update', positionUpdate());
      expect([toAdapterConsumer.length, direct.length]).toEqual([1, 1]);
      c.adapter.close();
      socketOf(c).trigger('df-position-update', positionUpdate());
      expect([toAdapterConsumer.length, direct.length]).toEqual([1, 2]); // dispatched by the stream, never reaching the closed adapter
      unsubscribeDirect();
      expectNothingRetained(toAdapterConsumer);
    });
  });
});
