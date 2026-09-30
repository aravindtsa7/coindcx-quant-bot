import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { CoinDcxPrivateAccountStream } from '../../../../src/integration/coindcx/websocket/private-stream';
import type { PrivateStreamDiagnosticConfig } from '../../../../src/integration/coindcx/websocket/private-stream-diagnostics';
import { createTestStreamContext } from './test-helpers';

const diagnosticConfig: PrivateStreamDiagnosticConfig = { sessionId: '12345678-1234-4123-8123-123456789abc', sourceCommit: '7c6f6fa1d8bc89fe6c7b291681c593fa158c91e5', clock: { read: () => ({ wallMs: 1000, elapsedMs: 10 }) } };
const MARKER = 'SENSITIVE_SYNTHETIC_MARKER';
const silent = pino({ level: 'silent' });

async function trace(mode: 'disabled' | 'enabled' | 'fault', scenario: 'normal' | 'initial-error' | 'timeout' | 'reentrant' | 'join-reentrant' | 'factory-error') {
  const c = createTestStreamContext();
  const clock = vi.spyOn(c.clock, 'nowMs'); const rng = vi.fn(c.rng);
  const timers: unknown[] = [];
  const timeout = c.scheduler.setTimeout.bind(c.scheduler); const interval = c.scheduler.setInterval.bind(c.scheduler);
  const clearTimeout = c.scheduler.clearTimeout.bind(c.scheduler); const clearInterval = c.scheduler.clearInterval.bind(c.scheduler);
  c.scheduler.setTimeout = (callback, delay) => { const id = timeout(callback, delay); timers.push(['timeout', id, delay]); return id; };
  c.scheduler.setInterval = (callback, delay) => { const id = interval(callback, delay); timers.push(['interval', id, delay]); return id; };
  c.scheduler.clearTimeout = (id) => { timers.push(['clearTimeout', id]); clearTimeout(id); };
  c.scheduler.clearInterval = (id) => { timers.push(['clearInterval', id]); clearInterval(id); };
  if (scenario === 'initial-error' || scenario === 'timeout') c.socketFactory.autoConnectSynchronously = false;
  if (scenario === 'factory-error') vi.spyOn(c.socketFactory, 'createSocket').mockImplementationOnce(() => { throw new Error(MARKER); });
  if (scenario === 'join-reentrant') {
    const create = c.socketFactory.createSocket.bind(c.socketFactory);
    c.socketFactory.createSocket = () => { const s = create(); const emit = s.emit.bind(s); s.emit = (event, ...args) => { emit(event, ...args); if (event === 'join') stream.stop(); }; return s; };
  }
  const stream = new CoinDcxPrivateAccountStream({ ...c, rng, apiKey: 'dummy-key', apiSecret: 'dummy-secret', logger: silent,
    ...(mode === 'disabled' ? {} : { diagnostics: mode === 'fault' ? { ...diagnosticConfig, clock: { read: () => { throw new Error(MARKER); } } } : diagnosticConfig }),
  });
  const envelopes: unknown[] = []; let restarted = false; let replacement: Promise<void> | undefined;
  stream.subscribe(event => { envelopes.push(event); if (scenario === 'reentrant' && !restarted && event.eventType === 'PRIVATE_STREAM_CONNECTED') { restarted = true; stream.stop(); replacement = stream.start(); } });
  const snapshots: unknown[] = [];
  const start = stream.start().catch(error => String(error.code ?? error.message));
  const old = c.socketFactory.latestSocket;
  const stale = old === undefined ? [] : [...old.listeners.values()].flatMap(set => [...set]);
  const oldTimers = [...c.scheduler.timers.values()].map(t => t.callback);
  if (scenario === 'initial-error') old!.trigger('connect_error', new Error(MARKER));
  if (scenario === 'timeout') c.scheduler.advanceTime(10_000);
  const outcome = await start; await replacement;
  snapshots.push(stream.getHealthSnapshot(), stream.getMetrics());
  if (scenario === 'initial-error' || scenario === 'timeout' || scenario === 'factory-error') { c.socketFactory.autoConnectSynchronously = true; c.scheduler.runAllTimers(); await Promise.resolve(); }
  if (stream.connected) {
    const s = c.socketFactory.latestSocket!;
    expect(s.getTotalListenerCount()).toBe(7);
    s.trigger('balance-update', { balances: [{ accountId: MARKER, orderId: MARKER }] });
    const ping = [...c.scheduler.intervals.values()].map(t => t.callback);
    const duplicateFailure = [...s.listeners.get('error')!][0]!;
    s.trigger('disconnect', { raw: MARKER }); duplicateFailure(new Error(MARKER));
    c.scheduler.runAllTimers(); await Promise.resolve();
    for (const cb of ping) cb();
  }
  for (const cb of stale) cb({ raw: MARKER }); for (const cb of oldTimers) cb();
  snapshots.push(stream.getHealthSnapshot(), stream.getMetrics());
  stream.stop(); stream.stop(); snapshots.push(stream.getHealthSnapshot(), stream.getMetrics());
  const diagnostics = stream.getDiagnosticsSnapshot('FINAL');
  const result = { outcome, envelopes, snapshots, timers, rngCalls: rng.mock.calls.length, clockCalls: clock.mock.calls.length,
    sockets: c.socketFactory.createdSockets.map(s => ({ disconnect: s.disconnectCalls, emitted: s.emitted, listeners: s.getTotalListenerCount() })),
    remaining: [c.scheduler.activeTimerCount, c.scheduler.activeIntervalCount] };
  return { result, diagnostics };
}

describe('private transport observation preserves control flow and authority barriers', () => {
  it.each(['normal', 'initial-error', 'timeout', 'reentrant', 'join-reentrant', 'factory-error'] as const)('enabled and disabled traces, including failing observer, are identical: %s', async scenario => {
    const disabled = await trace('disabled', scenario); const enabled = await trace('enabled', scenario); const fault = await trace('fault', scenario);
    expect(enabled.result).toEqual(disabled.result); expect(fault.result).toEqual(disabled.result);
    expect(disabled.diagnostics).toBeNull(); expect(enabled.diagnostics).not.toBeNull();
    expect(fault.diagnostics?.coverage.captureState).toBe('DISABLED_RECORDER_FAULT');
    expect(enabled.result.remaining).toEqual([0, 0]);
    const json = JSON.stringify(enabled.diagnostics); expect(json).not.toContain(MARKER); expect(json).not.toContain('dummy-key'); expect(json).not.toContain('dummy-secret');
    expect(enabled.diagnostics?.grantsAuthority).toBe(false); expect(enabled.diagnostics?.provesAccountContinuity).toBe(false);
  });
  it('separates reconnect restoration from unresolved reconciliation and associates stale callbacks with their original attempt', async () => {
    const { diagnostics: s } = await trace('enabled', 'normal');
    expect(s!.gaps.closed[0]).toMatchObject({ kind: 'TRANSPORT_GAP', status: 'TRANSPORT_RESTORED', openedBy: { attempt: 1, generation: 1 }, endedBy: { attempt: 2, generation: 2 } });
    expect(s!.current).toMatchObject({ state: 'STOPPED', reconciliationRequired: true });
    expect(s!.events.filter(e => e.kind === 'STALE_CALLBACK').some(e => e.socket?.attempt === 1)).toBe(true);
    expect(s!.counters).toMatchObject({ gapsOpened: 1, gapsRestored: 1, reconnectsScheduled: 1, successfulTransportReconnects: 1 });
    expect(s!.providerConfirmationObservation).toBe('NOT_OBSERVABLE_WITH_EXISTING_LISTENERS');
  });
});
