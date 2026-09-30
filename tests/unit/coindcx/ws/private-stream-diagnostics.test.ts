import { describe, expect, it } from 'vitest';
import { incrementDiagnosticCounter, nextDiagnosticIdentifier } from '../../../../src/core/time/diagnostic-counter';
import { PrivateStreamDiagnosticRecorder } from '../../../../src/integration/coindcx/websocket/private-stream-diagnostics';
import { CLOCK_ISSUES, DIAGNOSTICS_LIMITS, EMPTY_EXPORT_HISTORY, gapDuration, parsePrivateStreamDiagnostics, type ClockIssue, type DiagnosticCurrent, type Gap, type PrivateStreamDiagnosticsV1, type Stamp } from '../../../../src/integration/coindcx/websocket/private-stream-diagnostics-schema';

export const SESSION = '12345678-1234-4123-8123-123456789abc';
export const COMMIT = '7c6f6fa1d8bc89fe6c7b291681c593fa158c91e5';
const CURRENT: Omit<DiagnosticCurrent, 'firstObservedRequiredAt'> = { generation: 1, activeAttempt: null, state: 'STOPPED', authJoinSent: false, reconciliationRequired: false };
function recorder() {
  let wallMs = 1_700_000_000_000; let elapsedMs = 0;
  const r = new PrivateStreamDiagnosticRecorder({ sessionId: SESSION, sourceCommit: COMMIT, clock: { read: () => ({ wallMs, elapsedMs }) } });
  return { r, set: (wall: number, mono: number) => { wallMs = wall; elapsedMs = mono; }, advance: (ms: number) => { wallMs += ms; elapsedMs += ms; }, snapshot: () => r.snapshot('PERIODIC', CURRENT)! };
}

describe('closed diagnostic input validation', () => {
  it('round trips rebuilt immutable object and JSON text without changing historical schemas', () => {
    const c = recorder(); c.r.attemptStarted(1);
    const s = c.snapshot();
    expect(parsePrivateStreamDiagnostics(JSON.stringify(s))).toEqual(s);
    expect(Object.isFrozen(s.events[0]?.at)).toBe(true);
    expect(s).toMatchObject({ grantsAuthority: false, provesAccountContinuity: false, providerConfirmationObservation: 'NOT_OBSERVABLE_WITH_EXISTING_LISTENERS' });
  });
  it.each([
    (s: string) => s.replace('"schemaVersion":', '"schemaVersion":"ignored","schemaVersion":'),
    (s: string) => s.replace('"source":{', '"source":{"kind":"ignored",'),
    (s: string) => s.replace('"wallMs":', '"wallMs":0,"wallMs":'),
    (s: string) => s.replace('"kind":"ATTEMPT_STARTED"', '"kind":"ATTEMPT_STARTED","\\u006bind":"ATTEMPT_STARTED"'),
  ])('rejects duplicate decoded keys at root, nested source, stamp and array element levels', (tamper) => {
    const c = recorder(); c.r.attemptStarted(1);
    expect(() => parsePrivateStreamDiagnostics(tamper(JSON.stringify(c.snapshot())))).toThrow('DIAGNOSTICS_INVALID');
  });
  it('rejects unknown keys, inherited fields, accessors, symbols, hostile proxies and sparse/accessor arrays without invoking getters', () => {
    const c = recorder(); c.r.attemptStarted(1); const good = c.snapshot(); let calls = 0;
    const getter = { ...good }; Object.defineProperty(getter, 'session', { get: () => { calls++; throw new Error('RAW_ERROR_MARKER'); }, enumerable: true });
    const inherited = Object.assign(Object.create({ session: good.session }) as object, good); delete (inherited as { session?: unknown }).session;
    const sparse = new Array(1); const accessor = [good.events[0]];
    Object.defineProperty(accessor, '0', { get: () => { calls++; return good.events[0]; }, enumerable: true });
    const nested = { ...good, session: { ...good.session, [Symbol('hidden')]: 'RAW_MARKER' } };
    const proxy = new Proxy(good, { getPrototypeOf: () => { throw new Error('RAW_ERROR_MARKER'); } });
    for (const bad of [getter, inherited, nested, proxy, { ...good, raw: 'RAW_MARKER' }, { ...good, events: sparse }, { ...good, events: accessor }]) {
      expect(() => parsePrivateStreamDiagnostics(bad)).toThrow(/^DIAGNOSTICS_INVALID$/);
    }
    expect(calls).toBe(0);
  });
  it('rejects authority flags, forged duration, invalid identifiers, malformed JSON and oversized text', () => {
    const c = recorder(); const a = c.r.attemptStarted(1)!; c.r.record(a, { kind: 'FAILURE', category: 'CONNECT_ERROR' }); const s = c.snapshot();
    for (const bad of [{ ...s, grantsAuthority: true }, { ...s, session: { ...s.session, id: 'account-1' } }, { ...s, gaps: { ...s.gaps, open: { ...s.gaps.open!, durationMs: 123 } } }, '{', ' '.repeat(DIAGNOSTICS_LIMITS.snapshotBytes + 1)]) expect(() => parsePrivateStreamDiagnostics(bad)).toThrow('DIAGNOSTICS_INVALID');
  });
});

describe('clock evidence requires incomplete diagnostic coverage', () => {
  function fixture() {
    const c = recorder(); const a = c.r.attemptStarted(1)!;
    c.r.record(a, { kind: 'CONNECTED', reconnectPath: false }); c.advance(10);
    c.r.record(a, { kind: 'DISCONNECTED', category: 'TRANSPORT_CLOSE' }); c.advance(10);
    const b = c.r.attemptStarted(2)!; c.r.record(b, { kind: 'CONNECTED', reconnectPath: true });
    c.r.record(b, { kind: 'RECONCILIATION_REQUIRED', firstAssertion: true }); c.advance(5);
    c.r.record(b, { kind: 'DISCONNECTED', category: 'PING_TIMEOUT' }); c.advance(5);
    return c.r.snapshot('PERIODIC', { ...CURRENT, reconciliationRequired: true })!;
  }
  function mark(s: PrivateStreamDiagnosticsV1): PrivateStreamDiagnosticsV1 {
    return { ...s, coverage: { ...s.coverage, status: 'INCOMPLETE', issues: [...s.coverage.issues, 'CLOCK_ANOMALY'] } };
  }
  function acceptsBoth(s: PrivateStreamDiagnosticsV1) {
    expect(parsePrivateStreamDiagnostics(s)).toEqual(s);
    expect(parsePrivateStreamDiagnostics(JSON.stringify(s))).toEqual(s);
  }
  function rejectsBoth(s: PrivateStreamDiagnosticsV1) {
    const before = JSON.stringify(s);
    expect(() => parsePrivateStreamDiagnostics(s)).toThrow(/^DIAGNOSTICS_INVALID$/);
    expect(() => parsePrivateStreamDiagnostics(before)).toThrow(/^DIAGNOSTICS_INVALID$/);
    expect(JSON.stringify(s)).toBe(before); // Validation never repairs the caller's evidence.
  }
  const locations = ['session.startedAt', 'snapshot.at', 'current.firstObservedRequiredAt', 'first event.at', 'last event.at',
    'closed.openedAt', 'closed.endedAt', 'closed.observedThrough', 'open.openedAt', 'open.observedThrough'] as const;
  function anomalyAt(s: PrivateStreamDiagnosticsV1, location: typeof locations[number], issue: ClockIssue): PrivateStreamDiagnosticsV1 {
    const anomaly = (at: Stamp): Stamp => ({ ...at, issues: [issue],
      wallMs: issue === 'WALL_INVALID' ? null : at.wallMs,
      elapsedMs: issue === 'MONOTONIC_INVALID' ? null : at.elapsedMs,
      clockEpoch: issue.startsWith('MONOTONIC_') ? at.clockEpoch + 1 : at.clockEpoch });
    const duration = (g: Gap): Gap => { const ms = gapDuration(g.openedAt, g.observedThrough); return { ...g, durationMs: ms, durationStatus: ms === null ? 'CLOCK_INVALID' : 'VALID' }; };
    if (location === 'session.startedAt') return { ...s, session: { ...s.session, startedAt: anomaly(s.session.startedAt) } };
    if (location === 'current.firstObservedRequiredAt') return { ...s, current: { ...s.current, firstObservedRequiredAt: anomaly(s.current.firstObservedRequiredAt!) } };
    if (location === 'first event.at' || location === 'last event.at') return { ...s, events: s.events.map((e, i) => i === (location === 'first event.at' ? 0 : s.events.length - 1) ? { ...e, at: anomaly(e.at) } : e) };
    if (location === 'snapshot.at' || location === 'open.observedThrough') {
      const at = anomaly(s.snapshot.at);
      // Existing equality contracts remain satisfied, so rejection isolates coverage.
      return { ...s, snapshot: { ...s.snapshot, at }, gaps: { ...s.gaps, open: duration({ ...s.gaps.open!, observedThrough: at }) } };
    }
    if (location === 'open.openedAt') return { ...s, gaps: { ...s.gaps, open: duration({ ...s.gaps.open!, openedAt: anomaly(s.gaps.open!.openedAt) }) } };
    return { ...s, gaps: { ...s.gaps, closed: s.gaps.closed.map((g) => {
      if (location === 'closed.openedAt') return duration({ ...g, openedAt: anomaly(g.openedAt) });
      const at = anomaly(location === 'closed.endedAt' ? g.endedAt! : g.observedThrough);
      return duration({ ...g, endedAt: at, observedThrough: at });
    }) } };
  }
  it.each(locations.flatMap(location => CLOCK_ISSUES.map(issue => [location, issue] as const)))('requires CLOCK_ANOMALY for %s with %s in both input forms', (location, issue) => {
    const bad = anomalyAt(fixture(), location, issue);
    rejectsBoth(bad);
    const good = mark(bad); acceptsBoth(good);
    rejectsBoth({ ...good, coverage: { ...good.coverage, status: 'COMPLETE' } });
    if (issue.startsWith('WALL_')) {
      expect(good.gaps.closed[0]?.durationMs).toBe(10);
      expect(good.gaps.open?.durationMs).toBe(5);
    }
  });
  it.each(['wallClockAnomalies', 'monotonicClockAnomalies'] as const)('requires CLOCK_ANOMALY from the cumulative %s counter alone', (counter) => {
    const base = recorder().snapshot(); const bad = { ...base, counters: { ...base.counters, [counter]: 1 } };
    rejectsBoth(bad); acceptsBoth(mark(bad));
    // Already incomplete for another reason does not satisfy the clock requirement.
    rejectsBoth({ ...bad, coverage: { ...bad.coverage, status: 'INCOMPLETE', issues: ['EXPORT_SKIPPED'] }, exportHistory: { ...bad.exportHistory, skippedRequests: 1 } });
  });
  it.each(['wallClockAnomalies', 'monotonicClockAnomalies'] as const)('keeps CLOCK_ANOMALY mandatory after actual %s events and closed gaps have been evicted', (counter) => {
    const c = recorder(); let a = c.r.attemptStarted(1)!; c.r.record(a, { kind: 'CONNECTED', reconnectPath: false });
    c.advance(20); c.r.record(a, { kind: 'RECONNECT_SUPPRESSED' });
    c.set(counter === 'wallClockAnomalies' ? 100 : 1_700_000_000_030, 10);
    c.r.record(a, { kind: 'DISCONNECTED', category: 'TRANSPORT_CLOSE' });
    c.set(1_700_000_000_040, 40); a = c.r.attemptStarted(2)!; c.r.record(a, { kind: 'CONNECTED', reconnectPath: true });
    for (let i = 0; i < DIAGNOSTICS_LIMITS.closedGaps; i++) {
      c.advance(1); c.r.record(a, { kind: 'DISCONNECTED', category: 'TRANSPORT_CLOSE' });
      a = c.r.attemptStarted(i + 3)!; c.r.record(a, { kind: 'CONNECTED', reconnectPath: true });
    }
    for (let i = 0; i < DIAGNOSTICS_LIMITS.lifecycleEvents; i++) c.r.record(a, { kind: 'RECONNECT_SUPPRESSED' });
    const s = c.snapshot(); expect(s.counters[counter]).toBeGreaterThan(0);
    expect(s.coverage.closedGapsEvicted).toBe(1); expect(s.coverage.eventsEvicted).toBeGreaterThan(0);
    const retained = [s.session.startedAt, s.snapshot.at, ...s.events.map(e => e.at), ...s.gaps.closed.flatMap(g => [g.openedAt, g.endedAt!, g.observedThrough])];
    expect(retained.every(at => at.issues.length === 0)).toBe(true); acceptsBoth(s);
    rejectsBoth({ ...s, coverage: { ...s.coverage, issues: s.coverage.issues.filter(issue => issue !== 'CLOCK_ANOMALY') } });
  });
  it('permits a historical CLOCK_ANOMALY flag without retained corroboration or positive counters', () => {
    const s = recorder().snapshot(); expect(s.counters.wallClockAnomalies + s.counters.monotonicClockAnomalies).toBe(0);
    acceptsBoth(mark(s));
  });
  it('preserves recorder-fault null sentinel stamps without inventing clock anomalies', () => {
    const r = new PrivateStreamDiagnosticRecorder({ sessionId: SESSION, sourceCommit: COMMIT, clock: { read: () => { throw new Error('SYNTHETIC_CLOCK_FAULT'); } } });
    const s = r.snapshot('FINAL', CURRENT)!;
    expect(s.session.startedAt).toMatchObject({ wallMs: null, elapsedMs: null, issues: [] });
    expect(s.snapshot.at).toEqual(s.session.startedAt);
    expect(s.coverage.issues).toEqual(['RECORDER_FAULT']); acceptsBoth(s);
  });
});

describe('bounded local gap observations', () => {
  it('initial failures/repeated failures open one gap; restoration and reconciliation remain separate', () => {
    const c = recorder(); const a = c.r.attemptStarted(1)!;
    c.r.record(a, { kind: 'FAILURE', category: 'CONNECT_TIMEOUT' }); c.advance(20);
    c.r.record(a, { kind: 'FAILURE', category: 'SOCKET_ERROR' });
    expect(c.snapshot().gaps.open).toMatchObject({ kind: 'INITIAL_CONNECTION_FAILURE', durationMs: 20, openedBy: a });
    const b = c.r.attemptStarted(2)!; c.advance(10); c.r.record(b, { kind: 'CONNECTED', reconnectPath: true });
    c.r.record(b, { kind: 'CONNECTED', reconnectPath: true });
    const s = c.snapshot(); expect(s.gaps.closed).toHaveLength(1);
    expect(s.gaps.closed[0]).toMatchObject({ endedBy: b, status: 'TRANSPORT_RESTORED', durationMs: 30 });
    expect(s.counters).toMatchObject({ failureCallbacks: 2, gapsOpened: 1, gapsRestored: 1, successfulTransportReconnects: 0, socketConnections: 1, connectCallbacks: 2 });
    expect(s.current.reconciliationRequired).toBe(false); // Recorder never fabricates the transport latch.
  });
  it('deduplicates transport gaps and attributes recovery to the new attempt; stop freezes unresolved duration and restart never resets the latch', () => {
    const c = recorder(); const a = c.r.attemptStarted(1)!; c.r.record(a, { kind: 'CONNECTED', reconnectPath: false });
    c.r.record(a, { kind: 'DISCONNECTED', category: 'TRANSPORT_CLOSE' }); c.r.record(a, { kind: 'DISCONNECTED', category: 'PING_TIMEOUT' });
    const b = c.r.attemptStarted(2)!; c.advance(50); c.r.record(b, { kind: 'CONNECTED', reconnectPath: true }); c.r.record(b, { kind: 'RECONCILIATION_REQUIRED', firstAssertion: true });
    c.r.record(b, { kind: 'DISCONNECTED', category: 'TRANSPORT_ERROR' }); c.advance(5); c.r.record(b, { kind: 'STOP', resultingGeneration: 3 }); c.advance(100);
    const s = c.r.snapshot('FINAL', { ...CURRENT, reconciliationRequired: true })!;
    expect(s.gaps.closed.map(g => [g.kind, g.status, g.durationMs])).toEqual([['TRANSPORT_GAP', 'TRANSPORT_RESTORED', 50], ['TRANSPORT_GAP', 'STOPPED_UNRESOLVED', 5]]);
    expect(s.counters.successfulTransportReconnects).toBe(1); expect(s.current.firstObservedRequiredAt).not.toBeNull();
    const d = c.r.attemptStarted(4)!; c.r.record(d, { kind: 'FAILURE', category: 'ATTEMPT_EXCEPTION' });
    expect(c.snapshot().gaps.open?.kind).toBe('AFTER_STOP_CONNECTION_FAILURE');
  });
  it('uses monotonic duration despite wall regression, invalidates duration across monotonic epochs and records invalid clock samples', () => {
    const c = recorder(); const a = c.r.attemptStarted(1)!; c.r.record(a, { kind: 'FAILURE', category: 'CONNECT_ERROR' });
    c.set(100, 10); expect(c.snapshot().gaps.open?.durationMs).toBe(10);
    c.set(101, 2); expect(c.snapshot().gaps.open).toMatchObject({ durationMs: null, durationStatus: 'CLOCK_INVALID' });
    c.set(NaN, Infinity); const s = c.snapshot(); expect(s.snapshot.at.issues).toEqual(['WALL_INVALID', 'MONOTONIC_INVALID']);
    expect(s.coverage).toMatchObject({ status: 'INCOMPLETE', issues: ['CLOCK_ANOMALY'] });
    c.set(102, 12); expect(c.snapshot().gaps.open?.durationMs).toBeNull();
  });
  it('records clock exceptions and reentrant clock calls without throwing or resuming failed capture', () => {
    const r = new PrivateStreamDiagnosticRecorder({ sessionId: SESSION, sourceCommit: COMMIT, clock: { read: () => { throw new Error('SENSITIVE_MARKER'); } } });
    expect(r.attemptStarted(1)).toBeNull(); const s = r.snapshot('FINAL', CURRENT)!;
    expect(s.coverage).toMatchObject({ captureState: 'DISABLED_RECORDER_FAULT', status: 'INCOMPLETE', recorderFaults: 1, countersExact: false });
    expect(JSON.stringify(s)).not.toContain('SENSITIVE_MARKER');
    const nested: { recorder?: PrivateStreamDiagnosticRecorder } = {};
    nested.recorder = new PrivateStreamDiagnosticRecorder({ sessionId: SESSION, sourceCommit: COMMIT, clock: { read: () => { nested.recorder?.record(null, { kind: 'STOP', resultingGeneration: 2 }); return { wallMs: 1, elapsedMs: 1 }; } } });
    expect(() => nested.recorder!.attemptStarted(1)).not.toThrow(); expect(nested.recorder.snapshot('FINAL', CURRENT)?.coverage.captureState).toBe('DISABLED_RECORDER_FAULT');
  });
  it('retains exact aggregate counts but declares evicted history and protects the open gap', () => {
    const c = recorder(); let a = c.r.attemptStarted(1)!; c.r.record(a, { kind: 'CONNECTED', reconnectPath: false });
    for (let i = 0; i < 300; i++) { c.r.record(a, { kind: 'DISCONNECTED', category: 'TRANSPORT_CLOSE' }); a = c.r.attemptStarted(i + 2)!; c.r.record(a, { kind: 'CONNECTED', reconnectPath: true }); }
    c.r.record(a, { kind: 'DISCONNECTED', category: 'PING_TIMEOUT' });
    for (let i = 0; i < 4200; i++) c.r.record(a, { kind: 'RECONNECT_SUPPRESSED' });
    const s = c.snapshot(); expect(s.events).toHaveLength(4096); expect(s.gaps.closed).toHaveLength(256); expect(s.gaps.open?.gapId).toBe(301);
    expect(s.coverage).toMatchObject({ status: 'INCOMPLETE', closedGapsEvicted: 44, countersExact: true }); expect(s.coverage.eventsEvicted).toBeGreaterThan(0);
    expect(s.counters).toMatchObject({ disconnectCallbacks: 301, gapsOpened: 301, gapsRestored: 300 });
    expect(s.coverage.firstRetainedEventSequence).toBe(s.coverage.eventsEvicted + 1);
  });
  it('saturates counters without wraparound and represents export saturation and missed publications', () => {
    expect(incrementDiagnosticCounter(Number.MAX_SAFE_INTEGER - 1)).toEqual({ value: Number.MAX_SAFE_INTEGER, saturated: false });
    expect(incrementDiagnosticCounter(Number.MAX_SAFE_INTEGER)).toEqual({ value: Number.MAX_SAFE_INTEGER, saturated: true });
    expect(nextDiagnosticIdentifier(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(nextDiagnosticIdentifier(Number.MAX_SAFE_INTEGER)).toBeNull();
    const c = recorder(); const s = c.r.snapshot('FINAL', CURRENT, { ...EMPTY_EXPORT_HISTORY, skippedRequests: Number.MAX_SAFE_INTEGER, failedWrites: 1, ackTimeouts: 1, workerFailures: 1, finalUnconfirmed: true, lastFailure: 'ACK_TIMEOUT' })!;
    expect(s.coverage).toMatchObject({ counterSaturated: true, countersExact: false, status: 'INCOMPLETE' });
    expect(s.coverage.issues).toEqual(['COUNTER_SATURATED', 'EXPORT_SKIPPED', 'EXPORT_WRITE_FAILED', 'EXPORT_WORKER_FAILED', 'EXPORT_ACK_TIMEOUT', 'FINAL_UNCONFIRMED']);
  });
  it('invalid/exhausted transport generations disable capture instead of inventing socket IDs', () => {
    const c = recorder(); expect(c.r.attemptStarted(Number.MAX_SAFE_INTEGER + 1)).toBeNull(); expect(c.snapshot().coverage.countersExact).toBe(false);
  });
});
