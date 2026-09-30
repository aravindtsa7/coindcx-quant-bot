/** Closed, credential-free local observations. No diagnostic value is authority. */
export const DIAGNOSTICS_VERSION = 'P18B_PRIVATE_STREAM_DIAGNOSTICS_V1';
export const DIAGNOSTICS_LIMITS = Object.freeze({ lifecycleEvents: 4096, closedGaps: 256, openGaps: 1, snapshotBytes: 4_194_304, exportIntervalMs: 30_000, exportAckTimeoutMs: 5_000, finalFlushTimeoutMs: 1_000 } as const);
export const DISCONNECT_CATEGORIES = ['SERVER_DISCONNECT', 'CLIENT_DISCONNECT', 'PING_TIMEOUT', 'TRANSPORT_CLOSE', 'TRANSPORT_ERROR', 'UNKNOWN_DISCONNECT_REASON'] as const;
export const FAILURE_CATEGORIES = ['CONNECT_TIMEOUT', 'CONNECT_ERROR', 'SOCKET_ERROR', 'ATTEMPT_EXCEPTION'] as const;
export const CALLBACK_CATEGORIES = ['CONNECT', 'DISCONNECT', 'CONNECT_ERROR', 'SOCKET_ERROR', 'POSITION', 'ORDER', 'BALANCE', 'CONNECT_TIMEOUT', 'RECONNECT_TIMER', 'PING_TIMER', 'NOTIFICATION_GUARD', 'FAILURE_GUARD'] as const;
export const TRANSPORT_STATES = ['STOPPED', 'CONNECTING', 'CONNECTED', 'AUTH_JOIN_SENT', 'RECONNECT_WAIT', 'RECONCILIATION_REQUIRED', 'DEGRADED'] as const;
export const CLOCK_ISSUES = ['WALL_REGRESSION', 'WALL_INVALID', 'MONOTONIC_REGRESSION', 'MONOTONIC_INVALID'] as const;
export const COVERAGE_ISSUES = ['EVENTS_EVICTED', 'CLOSED_GAPS_EVICTED', 'RECORDER_FAULT', 'CLOCK_ANOMALY', 'COUNTER_SATURATED', 'IDENTIFIER_EXHAUSTED', 'EXPORT_SKIPPED', 'EXPORT_WRITE_FAILED', 'EXPORT_WORKER_FAILED', 'EXPORT_ACK_TIMEOUT', 'FINAL_UNCONFIRMED'] as const;
export const EXPORT_FAILURES = ['WORKER_START_FAILED', 'WORKER_EXITED', 'OPEN_FAILED', 'WRITE_FAILED', 'REPLACE_FAILED', 'DESTINATION_EXISTS', 'OWNERSHIP_LOST', 'TEMP_CLEANUP_FAILED', 'SIZE_LIMIT', 'ACK_TIMEOUT', 'FINAL_BUSY', 'FINAL_FLUSH_TIMEOUT', 'SNAPSHOT_INVALID'] as const;
export const COUNTER_NAMES = ['attemptsStarted', 'socketsCreated', 'connectCallbacks', 'socketConnections', 'successfulTransportReconnects', 'disconnectCallbacks', 'failureCallbacks', 'reconnectsScheduled', 'reconnectTimersFired', 'reconnectSchedulesSuppressed', 'joinEmitAttempts', 'joinEmitReturns', 'joinMarkedSent', 'stopCalls', 'staleCallbacks', 'validNotifications', 'invalidNotifications', 'gapsOpened', 'gapsRestored', 'gapsStopped', 'latchAssertions', 'wallClockAnomalies', 'monotonicClockAnomalies'] as const;
export type DisconnectCategory = typeof DISCONNECT_CATEGORIES[number];
export type FailureCategory = typeof FAILURE_CATEGORIES[number];
export type CallbackCategory = typeof CALLBACK_CATEGORIES[number];
export type CoverageIssue = typeof COVERAGE_ISSUES[number];
export type ExportFailure = typeof EXPORT_FAILURES[number];
export type CounterName = typeof COUNTER_NAMES[number];
export type ClockIssue = typeof CLOCK_ISSUES[number];
export interface Stamp { readonly wallMs: number | null; readonly elapsedMs: number | null; readonly clockEpoch: number; readonly issues: readonly ClockIssue[] }
export interface SocketAttempt { readonly attempt: number; readonly generation: number }
export type EventDetail =
  | { readonly kind: 'ATTEMPT_STARTED'; readonly phase: 'INITIAL' | 'RETRY' | 'AFTER_STOP' }
  | { readonly kind: 'SOCKET_CREATED' | 'JOIN_EMIT_ATTEMPTED' | 'JOIN_EMIT_RETURNED' | 'JOIN_MARKED_SENT' | 'RECONNECT_TIMER_FIRED' | 'RECONNECT_SUPPRESSED' }
  | { readonly kind: 'CONNECTED'; readonly reconnectPath: boolean }
  | { readonly kind: 'DISCONNECTED'; readonly category: DisconnectCategory }
  | { readonly kind: 'FAILURE'; readonly category: FailureCategory }
  | { readonly kind: 'RECONNECT_SCHEDULED'; readonly delayMs: number }
  | { readonly kind: 'STALE_CALLBACK'; readonly callback: CallbackCategory }
  | { readonly kind: 'STOP'; readonly resultingGeneration: number }
  | { readonly kind: 'RECONCILIATION_REQUIRED'; readonly firstAssertion: boolean }
  | { readonly kind: 'GAP_OPENED' | 'GAP_RESTORED' | 'GAP_STOPPED'; readonly gapId: number };
export type DiagnosticEvent = Readonly<{ sequence: number; at: Stamp; socket: SocketAttempt | null }> & EventDetail;
export interface Gap {
  readonly gapId: number;
  readonly kind: 'INITIAL_CONNECTION_FAILURE' | 'AFTER_STOP_CONNECTION_FAILURE' | 'TRANSPORT_GAP';
  readonly cause: DisconnectCategory | FailureCategory;
  readonly openedBy: SocketAttempt;
  readonly openedAt: Stamp;
  readonly status: 'OPEN' | 'TRANSPORT_RESTORED' | 'STOPPED_UNRESOLVED';
  readonly endedBy: SocketAttempt | null;
  readonly endedAt: Stamp | null;
  readonly observedThrough: Stamp;
  readonly durationMs: number | null;
  readonly durationStatus: 'VALID' | 'CLOCK_INVALID';
}
export interface ExportHistory {
  readonly lastAcknowledgedSnapshotSequence: number | null;
  readonly skippedRequests: number;
  readonly failedWrites: number;
  readonly workerFailures: number;
  readonly ackTimeouts: number;
  readonly finalUnconfirmed: boolean;
  readonly lastFailure: ExportFailure | null;
}
export const EMPTY_EXPORT_HISTORY: ExportHistory = Object.freeze({ lastAcknowledgedSnapshotSequence: null, skippedRequests: 0, failedWrites: 0, workerFailures: 0, ackTimeouts: 0, finalUnconfirmed: false, lastFailure: null });
export interface DiagnosticCurrent {
  readonly generation: number | null;
  readonly activeAttempt: SocketAttempt | null;
  readonly state: typeof TRANSPORT_STATES[number];
  readonly authJoinSent: boolean;
  readonly reconciliationRequired: boolean;
  readonly firstObservedRequiredAt: Stamp | null;
}
export interface PrivateStreamDiagnosticsV1 {
  readonly schemaVersion: typeof DIAGNOSTICS_VERSION;
  readonly grantsAuthority: false;
  readonly provesAccountContinuity: false;
  readonly session: Readonly<{ id: string; source: Readonly<{ kind: 'GIT_CLEAN_COMMIT'; commit: string; checkedAt: 'SESSION_START' }>; startedAt: Stamp }>;
  readonly snapshot: Readonly<{ sequence: number; reason: 'START' | 'PERIODIC' | 'FINAL'; at: Stamp }>;
  readonly limits: typeof DIAGNOSTICS_LIMITS;
  readonly current: DiagnosticCurrent;
  readonly providerConfirmationObservation: 'NOT_OBSERVABLE_WITH_EXISTING_LISTENERS';
  readonly counters: Readonly<Record<CounterName, number>>;
  readonly disconnectsByCategory: Readonly<Record<DisconnectCategory, number>>;
  readonly failuresByCategory: Readonly<Record<FailureCategory, number>>;
  readonly events: readonly DiagnosticEvent[];
  readonly gaps: Readonly<{ closed: readonly Gap[]; open: Gap | null }>;
  readonly coverage: Readonly<{
    scope: 'LOCAL_OBSERVATIONS_ONLY'; status: 'COMPLETE' | 'INCOMPLETE';
    captureState: 'ACTIVE' | 'DISABLED_RECORDER_FAULT' | 'DISABLED_IDENTIFIER_EXHAUSTION';
    issues: readonly CoverageIssue[]; firstRetainedEventSequence: number | null; lastRecordedEventSequence: number | null;
    eventsEvicted: number; closedGapsEvicted: number; recorderFaults: number; counterSaturated: boolean; countersExact: boolean;
  }>;
  readonly exportHistory: ExportHistory;
}

function invalid(): never { throw new Error('DIAGNOSTICS_INVALID'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length) invalid();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = descriptors[String(i)];
    if (descriptor === undefined || !('value' in descriptor)) invalid();
    result.push(descriptor.value);
  }
  return result;
}
function integer(value: unknown, minimum = 0): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid(); return value; }
function nullableInteger(value: unknown, minimum = 0): number | null { return value === null ? null : integer(value, minimum); }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function code<T extends string>(value: unknown, domain: readonly T[]): T { if (typeof value !== 'string' || !domain.includes(value as T)) invalid(); return value as T; }
function codes<T extends string>(value: unknown, domain: readonly T[]): readonly T[] {
  const result = list(value, domain.length).map((entry) => code(entry, domain));
  if (new Set(result).size !== result.length) invalid();
  return Object.freeze(result);
}
function stamp(value: unknown): Stamp {
  const v = object(value, ['wallMs', 'elapsedMs', 'clockEpoch', 'issues']);
  return Object.freeze({ wallMs: nullableInteger(v['wallMs']), elapsedMs: nullableInteger(v['elapsedMs']), clockEpoch: integer(v['clockEpoch']), issues: codes(v['issues'], CLOCK_ISSUES) });
}
function socket(value: unknown): SocketAttempt {
  const v = object(value, ['attempt', 'generation']);
  return Object.freeze({ attempt: integer(v['attempt'], 1), generation: integer(v['generation'], 1) });
}
function nullableSocket(value: unknown): SocketAttempt | null { return value === null ? null : socket(value); }
function counts<T extends string>(value: unknown, keys: readonly T[]): Readonly<Record<T, number>> {
  const v = object(value, keys);
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, integer(v[key])])) as Record<T, number>);
}
function event(value: unknown): DiagnosticEvent {
  // Inspect kind through its own data descriptor before selecting exact fields.
  if (typeof value !== 'object' || value === null) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  if (descriptor === undefined || !('value' in descriptor)) invalid();
  const kind: unknown = descriptor.value;
  const base = ['sequence', 'at', 'socket', 'kind'];
  let detail: EventDetail;
  let v: Record<string, unknown>;
  switch (kind) {
    case 'ATTEMPT_STARTED': v = object(value, [...base, 'phase']); detail = { kind, phase: code(v['phase'], ['INITIAL', 'RETRY', 'AFTER_STOP']) }; break;
    case 'CONNECTED': v = object(value, [...base, 'reconnectPath']); detail = { kind, reconnectPath: bool(v['reconnectPath']) }; break;
    case 'DISCONNECTED': v = object(value, [...base, 'category']); detail = { kind, category: code(v['category'], DISCONNECT_CATEGORIES) }; break;
    case 'FAILURE': v = object(value, [...base, 'category']); detail = { kind, category: code(v['category'], FAILURE_CATEGORIES) }; break;
    case 'RECONNECT_SCHEDULED': v = object(value, [...base, 'delayMs']); detail = { kind, delayMs: integer(v['delayMs']) }; break;
    case 'STALE_CALLBACK': v = object(value, [...base, 'callback']); detail = { kind, callback: code(v['callback'], CALLBACK_CATEGORIES) }; break;
    case 'STOP': v = object(value, [...base, 'resultingGeneration']); detail = { kind, resultingGeneration: integer(v['resultingGeneration'], 1) }; break;
    case 'RECONCILIATION_REQUIRED': v = object(value, [...base, 'firstAssertion']); detail = { kind, firstAssertion: bool(v['firstAssertion']) }; break;
    case 'GAP_OPENED': case 'GAP_RESTORED': case 'GAP_STOPPED': v = object(value, [...base, 'gapId']); detail = { kind, gapId: integer(v['gapId'], 1) }; break;
    case 'SOCKET_CREATED': case 'JOIN_EMIT_ATTEMPTED': case 'JOIN_EMIT_RETURNED': case 'JOIN_MARKED_SENT': case 'RECONNECT_TIMER_FIRED': case 'RECONNECT_SUPPRESSED': v = object(value, base); detail = { kind }; break;
    default: invalid();
  }
  const association = nullableSocket(v['socket']);
  if (association === null && kind !== 'STOP' && kind !== 'STALE_CALLBACK') invalid();
  return Object.freeze({ sequence: integer(v['sequence'], 1), at: stamp(v['at']), socket: association, ...detail });
}
export function gapDuration(opened: Stamp, through: Stamp): number | null {
  if (opened.clockEpoch !== through.clockEpoch || opened.elapsedMs === null || through.elapsedMs === null || through.elapsedMs < opened.elapsedMs) return null;
  return through.elapsedMs - opened.elapsedMs;
}
function gap(value: unknown): Gap {
  const v = object(value, ['gapId', 'kind', 'cause', 'openedBy', 'openedAt', 'status', 'endedBy', 'endedAt', 'observedThrough', 'durationMs', 'durationStatus']);
  const status = code(v['status'], ['OPEN', 'TRANSPORT_RESTORED', 'STOPPED_UNRESOLVED']);
  const endedBy = nullableSocket(v['endedBy']);
  const endedAt = v['endedAt'] === null ? null : stamp(v['endedAt']);
  if (status === 'OPEN' ? endedBy !== null || endedAt !== null : endedAt === null || (status === 'TRANSPORT_RESTORED' ? endedBy === null : endedBy !== null)) invalid();
  const openedAt = stamp(v['openedAt']);
  const observedThrough = stamp(v['observedThrough']);
  const durationMs = nullableInteger(v['durationMs']);
  const durationStatus = code(v['durationStatus'], ['VALID', 'CLOCK_INVALID']);
  if ((durationMs === null) !== (durationStatus === 'CLOCK_INVALID') || durationMs !== gapDuration(openedAt, observedThrough)) invalid();
  if (endedAt !== null && JSON.stringify(endedAt) !== JSON.stringify(observedThrough)) invalid();
  return Object.freeze({ gapId: integer(v['gapId'], 1), kind: code(v['kind'], ['INITIAL_CONNECTION_FAILURE', 'AFTER_STOP_CONNECTION_FAILURE', 'TRANSPORT_GAP']), cause: code(v['cause'], [...DISCONNECT_CATEGORIES, ...FAILURE_CATEGORIES]), openedBy: socket(v['openedBy']), openedAt, status, endedBy, endedAt, observedThrough, durationMs, durationStatus });
}

/** Text-only preflight: decoded key uniqueness at EVERY object nesting level. */
function rejectDuplicateKeys(text: string): void {
  let at = 0;
  const whitespace = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) { const char = text[at++]; if (char === '\\') at++; else if (char === '"') return JSON.parse(text.slice(start, at)) as string; }
    invalid();
  };
  const value = (depth: number): void => {
    if (depth > 32) invalid();
    whitespace();
    if (text[at] === '{') {
      at++; whitespace(); const keys = new Set<string>();
      if (text[at] === '}') { at++; return; }
      for (;;) {
        whitespace(); if (text[at] !== '"') invalid(); const key = string();
        if (keys.has(key)) invalid(); keys.add(key); whitespace(); if (text[at++] !== ':') invalid(); value(depth + 1); whitespace();
        const end = text[at++]; if (end === '}') return; if (end !== ',') invalid();
      }
    }
    if (text[at] === '[') {
      at++; whitespace(); if (text[at] === ']') { at++; return; }
      for (;;) { value(depth + 1); whitespace(); const end = text[at++]; if (end === ']') return; if (end !== ',') invalid(); }
    }
    if (text[at] === '"') { string(); return; }
    const start = at;
    while (at < text.length && !/[\s,}\]]/.test(text[at]!)) at++;
    if (start === at) invalid();
  };
  value(0); whitespace(); if (at !== text.length) invalid();
}

/** No raw value/error is reflected. Text and object inputs have distinct checks. */
export function parsePrivateStreamDiagnostics(input: unknown): PrivateStreamDiagnosticsV1 {
  try {
    let value = input;
    if (typeof input === 'string') {
      if (Buffer.byteLength(input, 'utf8') > DIAGNOSTICS_LIMITS.snapshotBytes) invalid();
      rejectDuplicateKeys(input); value = JSON.parse(input) as unknown;
    }
    const v = object(value, ['schemaVersion', 'grantsAuthority', 'provesAccountContinuity', 'session', 'snapshot', 'limits', 'current', 'providerConfirmationObservation', 'counters', 'disconnectsByCategory', 'failuresByCategory', 'events', 'gaps', 'coverage', 'exportHistory']);
    if (v['schemaVersion'] !== DIAGNOSTICS_VERSION || v['grantsAuthority'] !== false || v['provesAccountContinuity'] !== false || v['providerConfirmationObservation'] !== 'NOT_OBSERVABLE_WITH_EXISTING_LISTENERS') invalid();
    const session = object(v['session'], ['id', 'source', 'startedAt']);
    if (typeof session['id'] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(session['id'])) invalid();
    const source = object(session['source'], ['kind', 'commit', 'checkedAt']);
    if (source['kind'] !== 'GIT_CLEAN_COMMIT' || source['checkedAt'] !== 'SESSION_START' || typeof source['commit'] !== 'string' || !/^[0-9a-f]{40}$/.test(source['commit'])) invalid();
    const snapshot = object(v['snapshot'], ['sequence', 'reason', 'at']);
    const limits = object(v['limits'], Object.keys(DIAGNOSTICS_LIMITS));
    for (const key of Object.keys(DIAGNOSTICS_LIMITS) as (keyof typeof DIAGNOSTICS_LIMITS)[]) if (limits[key] !== DIAGNOSTICS_LIMITS[key]) invalid();
    const current = object(v['current'], ['generation', 'activeAttempt', 'state', 'authJoinSent', 'reconciliationRequired', 'firstObservedRequiredAt']);
    const events = list(v['events'], DIAGNOSTICS_LIMITS.lifecycleEvents).map(event);
    for (let i = 1; i < events.length; i++) if (events[i]!.sequence <= events[i - 1]!.sequence) invalid();
    const gaps = object(v['gaps'], ['closed', 'open']);
    const closed = list(gaps['closed'], DIAGNOSTICS_LIMITS.closedGaps).map(gap);
    const open = gaps['open'] === null ? null : gap(gaps['open']);
    if (closed.some((entry) => entry.status === 'OPEN') || (open !== null && open.status !== 'OPEN')) invalid();
    const snapshotAt = stamp(snapshot['at']);
    const startedAt = stamp(session['startedAt']);
    const firstObservedRequiredAt = current['firstObservedRequiredAt'] === null ? null : stamp(current['firstObservedRequiredAt']);
    const counters = counts(v['counters'], COUNTER_NAMES);
    if (open !== null && JSON.stringify(open.observedThrough) !== JSON.stringify(snapshotAt)) invalid();
    if (new Set([...closed.map((entry) => entry.gapId), ...(open === null ? [] : [open.gapId])]).size !== closed.length + (open === null ? 0 : 1)) invalid();
    const coverage = object(v['coverage'], ['scope', 'status', 'captureState', 'issues', 'firstRetainedEventSequence', 'lastRecordedEventSequence', 'eventsEvicted', 'closedGapsEvicted', 'recorderFaults', 'counterSaturated', 'countersExact']);
    if (coverage['scope'] !== 'LOCAL_OBSERVATIONS_ONLY') invalid();
    const issues = codes(coverage['issues'], COVERAGE_ISSUES);
    const status = code(coverage['status'], ['COMPLETE', 'INCOMPLETE']);
    if ((status === 'COMPLETE') !== (issues.length === 0)) invalid();
    const first = nullableInteger(coverage['firstRetainedEventSequence'], 1);
    const last = nullableInteger(coverage['lastRecordedEventSequence'], 1);
    if (first !== (events[0]?.sequence ?? null) || last !== (events.at(-1)?.sequence ?? null)) invalid();
    const history = object(v['exportHistory'], ['lastAcknowledgedSnapshotSequence', 'skippedRequests', 'failedWrites', 'workerFailures', 'ackTimeouts', 'finalUnconfirmed', 'lastFailure']);
    const counterSaturated = bool(coverage['counterSaturated']);
    const recorderFaults = integer(coverage['recorderFaults']);
    const countersExact = bool(coverage['countersExact']);
    const captureState = code(coverage['captureState'], ['ACTIVE', 'DISABLED_RECORDER_FAULT', 'DISABLED_IDENTIFIER_EXHAUSTION']);
    if ((counterSaturated || recorderFaults > 0 || captureState !== 'ACTIVE') && countersExact) invalid();
    const requiresIssue = (condition: boolean, issue: CoverageIssue) => { if (condition && !issues.includes(issue)) invalid(); };
    const gapHasClockIssue = (entry: Gap) => entry.openedAt.issues.length > 0 ||
      (entry.endedAt?.issues.length ?? 0) > 0 || entry.observedThrough.issues.length > 0;
    requiresIssue(counters.wallClockAnomalies > 0 || counters.monotonicClockAnomalies > 0 ||
      startedAt.issues.length > 0 || snapshotAt.issues.length > 0 ||
      (firstObservedRequiredAt?.issues.length ?? 0) > 0 || events.some((entry) => entry.at.issues.length > 0) ||
      closed.some(gapHasClockIssue) || (open !== null && gapHasClockIssue(open)), 'CLOCK_ANOMALY');
    requiresIssue(integer(coverage['eventsEvicted']) > 0, 'EVENTS_EVICTED');
    requiresIssue(integer(coverage['closedGapsEvicted']) > 0, 'CLOSED_GAPS_EVICTED');
    requiresIssue(recorderFaults > 0 || captureState === 'DISABLED_RECORDER_FAULT', 'RECORDER_FAULT');
    requiresIssue(captureState === 'DISABLED_IDENTIFIER_EXHAUSTION', 'IDENTIFIER_EXHAUSTED');
    requiresIssue(counterSaturated, 'COUNTER_SATURATED');
    requiresIssue(integer(history['skippedRequests']) > 0, 'EXPORT_SKIPPED');
    requiresIssue(integer(history['failedWrites']) > 0, 'EXPORT_WRITE_FAILED');
    requiresIssue(integer(history['workerFailures']) > 0, 'EXPORT_WORKER_FAILED');
    requiresIssue(integer(history['ackTimeouts']) > 0, 'EXPORT_ACK_TIMEOUT');
    requiresIssue(bool(history['finalUnconfirmed']), 'FINAL_UNCONFIRMED');
    const sequence = integer(snapshot['sequence'], 1);
    const acknowledged = nullableInteger(history['lastAcknowledgedSnapshotSequence'], 1);
    if (acknowledged !== null && acknowledged >= sequence) invalid();
    return Object.freeze({
      schemaVersion: DIAGNOSTICS_VERSION, grantsAuthority: false, provesAccountContinuity: false,
      session: Object.freeze({ id: session['id'], source: Object.freeze({ kind: 'GIT_CLEAN_COMMIT', commit: source['commit'], checkedAt: 'SESSION_START' }), startedAt }),
      snapshot: Object.freeze({ sequence, reason: code(snapshot['reason'], ['START', 'PERIODIC', 'FINAL']), at: snapshotAt }), limits: DIAGNOSTICS_LIMITS,
      current: Object.freeze({ generation: nullableInteger(current['generation']), activeAttempt: nullableSocket(current['activeAttempt']), state: code(current['state'], TRANSPORT_STATES), authJoinSent: bool(current['authJoinSent']), reconciliationRequired: bool(current['reconciliationRequired']), firstObservedRequiredAt }),
      providerConfirmationObservation: 'NOT_OBSERVABLE_WITH_EXISTING_LISTENERS', counters, disconnectsByCategory: counts(v['disconnectsByCategory'], DISCONNECT_CATEGORIES), failuresByCategory: counts(v['failuresByCategory'], FAILURE_CATEGORIES), events: Object.freeze(events), gaps: Object.freeze({ closed: Object.freeze(closed), open }),
      coverage: Object.freeze({ scope: 'LOCAL_OBSERVATIONS_ONLY', status, captureState, issues, firstRetainedEventSequence: first, lastRecordedEventSequence: last, eventsEvicted: integer(coverage['eventsEvicted']), closedGapsEvicted: integer(coverage['closedGapsEvicted']), recorderFaults, counterSaturated, countersExact }),
      exportHistory: Object.freeze({ lastAcknowledgedSnapshotSequence: acknowledged, skippedRequests: integer(history['skippedRequests']), failedWrites: integer(history['failedWrites']), workerFailures: integer(history['workerFailures']), ackTimeouts: integer(history['ackTimeouts']), finalUnconfirmed: bool(history['finalUnconfirmed']), lastFailure: history['lastFailure'] === null ? null : code(history['lastFailure'], EXPORT_FAILURES) }),
    });
  } catch { invalid(); }
}
