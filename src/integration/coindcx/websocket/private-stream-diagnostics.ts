import { SystemDiagnosticClock, type DiagnosticClock } from '../../../core/time/diagnostic-clock';
import { incrementDiagnosticCounter, nextDiagnosticIdentifier } from '../../../core/time/diagnostic-counter';
import { CALLBACK_CATEGORIES, COUNTER_NAMES, COVERAGE_ISSUES, DIAGNOSTICS_LIMITS, DIAGNOSTICS_VERSION, DISCONNECT_CATEGORIES, EMPTY_EXPORT_HISTORY, FAILURE_CATEGORIES, gapDuration, parsePrivateStreamDiagnostics, type ClockIssue, type CounterName, type CoverageIssue, type DiagnosticCurrent, type DiagnosticEvent, type EventDetail, type ExportHistory, type Gap, type PrivateStreamDiagnosticsV1, type SocketAttempt, type Stamp } from './private-stream-diagnostics-schema';

export interface PrivateStreamDiagnosticConfig {
  readonly sessionId: string;
  readonly sourceCommit: string;
  /** Trusted deterministic test clock; production uses the independent system clock. */
  readonly clock?: DiagnosticClock;
}

/** Fixed ring: no array shifting, scanning or allocation proportional to retention at capture. */
class Ring<T> {
  readonly #values: Array<T | undefined>;
  #start = 0;
  #length = 0;
  public constructor(readonly capacity: number) { this.#values = new Array<T | undefined>(capacity); }
  public push(value: T): boolean {
    const full = this.#length === this.capacity;
    this.#values[(this.#start + this.#length) % this.capacity] = value;
    if (full) this.#start = (this.#start + 1) % this.capacity; else this.#length++;
    return full;
  }
  public values(): T[] { return Array.from({ length: this.#length }, (_, index) => this.#values[(this.#start + index) % this.capacity]!); }
}

function zeros<T extends string>(keys: readonly T[]): Record<T, number> { return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>; }

/** Internal, bounded, nonthrowing observation. Never accepts raw transport arguments. */
export class PrivateStreamDiagnosticRecorder {
  readonly #clock: DiagnosticClock;
  readonly #sessionId: string;
  readonly #sourceCommit: string;
  readonly #events = new Ring<DiagnosticEvent>(DIAGNOSTICS_LIMITS.lifecycleEvents);
  readonly #closed = new Ring<Gap>(DIAGNOSTICS_LIMITS.closedGaps);
  readonly #counters = zeros(COUNTER_NAMES);
  readonly #disconnects = zeros(DISCONNECT_CATEGORIES);
  readonly #failures = zeros(FAILURE_CATEGORIES);
  readonly #issues = new Set<CoverageIssue>();
  readonly #started: Stamp;
  #last: Stamp = Object.freeze({ wallMs: null, elapsedMs: null, clockEpoch: 0, issues: Object.freeze([]) });
  #epoch = 0;
  #sequence = 0;
  #snapshotSequence = 0;
  #attemptSequence = 0;
  #gapSequence = 0;
  #eventsEvicted = 0;
  #gapsEvicted = 0;
  #faults = 0;
  #saturated = false;
  #disabled: 'ACTIVE' | 'DISABLED_RECORDER_FAULT' | 'DISABLED_IDENTIFIER_EXHAUSTION' = 'ACTIVE';
  #open: Gap | null = null;
  #everConnected = false;
  #connectedAttempt = 0;
  #afterStop = false;
  #firstRequired: Stamp | null = null;
  #reading = false;

  public constructor(config: PrivateStreamDiagnosticConfig) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(config.sessionId) || !/^[0-9a-f]{40}$/.test(config.sourceCommit)) throw new Error('DIAGNOSTICS_CONFIG_INVALID');
    this.#sessionId = config.sessionId; this.#sourceCommit = config.sourceCommit;
    this.#clock = config.clock ?? new SystemDiagnosticClock();
    try { this.#started = this.#stamp(); } catch { this.#fault(); this.#started = this.#last; }
  }

  #increment(value: number): number {
    const result = incrementDiagnosticCounter(value);
    if (result.saturated) { this.#saturated = true; this.#issues.add('COUNTER_SATURATED'); }
    return result.value;
  }
  #count(name: CounterName): void { this.#counters[name] = this.#increment(this.#counters[name]); }
  #identifier(value: number): number {
    const next = nextDiagnosticIdentifier(value);
    if (next === null) { this.#disabled = 'DISABLED_IDENTIFIER_EXHAUSTION'; this.#issues.add('IDENTIFIER_EXHAUSTED'); throw new Error('DIAGNOSTICS_IDENTIFIER_EXHAUSTED'); }
    return next;
  }
  #fault(): void {
    if (this.#disabled === 'DISABLED_IDENTIFIER_EXHAUSTION') return;
    this.#disabled = 'DISABLED_RECORDER_FAULT'; this.#faults = this.#increment(this.#faults); this.#issues.add('RECORDER_FAULT');
  }
  #stamp(): Stamp {
    if (this.#reading) throw new Error('DIAGNOSTICS_REENTRANT_CLOCK');
    this.#reading = true;
    let sample: ReturnType<DiagnosticClock['read']>;
    try { sample = this.#clock.read(); } finally { this.#reading = false; }
    if (this.#disabled !== 'ACTIVE') throw new Error('DIAGNOSTICS_CAPTURE_DISABLED');
    const valid = (value: number) => Number.isSafeInteger(value) && value >= 0;
    const issues: ClockIssue[] = [];
    const wallMs = valid(sample.wallMs) ? sample.wallMs : null;
    const elapsedMs = valid(sample.elapsedMs) ? sample.elapsedMs : null;
    if (wallMs === null) issues.push('WALL_INVALID'); else if (this.#last.wallMs !== null && wallMs < this.#last.wallMs) issues.push('WALL_REGRESSION');
    if (elapsedMs === null) issues.push('MONOTONIC_INVALID'); else if (this.#last.elapsedMs !== null && elapsedMs < this.#last.elapsedMs) issues.push('MONOTONIC_REGRESSION');
    if (issues.some((issue) => issue.startsWith('WALL'))) this.#count('wallClockAnomalies');
    if (issues.some((issue) => issue.startsWith('MONOTONIC'))) { this.#count('monotonicClockAnomalies'); this.#epoch = this.#identifier(this.#epoch); }
    if (issues.length > 0) this.#issues.add('CLOCK_ANOMALY');
    this.#last = Object.freeze({ wallMs, elapsedMs, clockEpoch: this.#epoch, issues: Object.freeze(issues) });
    return this.#last;
  }
  #emit(association: SocketAttempt | null, detail: EventDetail, at: Stamp): void {
    this.#sequence = this.#identifier(this.#sequence);
    if (this.#events.push(Object.freeze({ sequence: this.#sequence, socket: association, at, ...detail }))) { this.#eventsEvicted = this.#increment(this.#eventsEvicted); this.#issues.add('EVENTS_EVICTED'); }
  }
  public attemptStarted(generation: number): SocketAttempt | null {
    if (this.#disabled !== 'ACTIVE') return null;
    try {
      if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('DIAGNOSTICS_GENERATION_INVALID');
      this.#attemptSequence = this.#identifier(this.#attemptSequence);
      const association = Object.freeze({ attempt: this.#attemptSequence, generation });
      const phase = this.#afterStop ? 'AFTER_STOP' : this.#attemptSequence === 1 ? 'INITIAL' : 'RETRY';
      this.#count('attemptsStarted'); this.#emit(association, { kind: 'ATTEMPT_STARTED', phase }, this.#stamp());
      return association;
    } catch { this.#fault(); return null; }
  }
  #openGap(association: SocketAttempt, cause: Gap['cause'], at: Stamp): void {
    if (this.#open !== null) return;
    this.#gapSequence = this.#identifier(this.#gapSequence);
    this.#open = Object.freeze({ gapId: this.#gapSequence, kind: this.#afterStop ? 'AFTER_STOP_CONNECTION_FAILURE' : this.#everConnected ? 'TRANSPORT_GAP' : 'INITIAL_CONNECTION_FAILURE', cause, openedBy: association, openedAt: at, status: 'OPEN', endedBy: null, endedAt: null, observedThrough: at, durationMs: gapDuration(at, at), durationStatus: gapDuration(at, at) === null ? 'CLOCK_INVALID' : 'VALID' });
    this.#count('gapsOpened'); this.#emit(association, { kind: 'GAP_OPENED', gapId: this.#gapSequence }, at);
  }
  #closeGap(association: SocketAttempt | null, at: Stamp, stopped: boolean): void {
    if (this.#open === null) return;
    const gap = this.#open;
    const durationMs = gapDuration(gap.openedAt, at);
    const closed: Gap = Object.freeze({ ...gap, status: stopped ? 'STOPPED_UNRESOLVED' : 'TRANSPORT_RESTORED', endedBy: stopped ? null : association, endedAt: at, observedThrough: at, durationMs, durationStatus: durationMs === null ? 'CLOCK_INVALID' : 'VALID' });
    if (this.#closed.push(closed)) { this.#gapsEvicted = this.#increment(this.#gapsEvicted); this.#issues.add('CLOSED_GAPS_EVICTED'); }
    this.#open = null;
    this.#count(stopped ? 'gapsStopped' : 'gapsRestored');
    if (!stopped && gap.kind === 'TRANSPORT_GAP') this.#count('successfulTransportReconnects');
    this.#emit(association, { kind: stopped ? 'GAP_STOPPED' : 'GAP_RESTORED', gapId: gap.gapId }, at);
  }
  public record(association: SocketAttempt | null, detail: EventDetail): void {
    if (this.#disabled !== 'ACTIVE') return;
    try {
      // All inputs are closed local values generated by the transport, never provider arguments.
      if (association === null && detail.kind !== 'STOP' && detail.kind !== 'STALE_CALLBACK') return;
      const at = this.#stamp();
      switch (detail.kind) {
        case 'SOCKET_CREATED': this.#count('socketsCreated'); break;
        case 'CONNECTED': this.#count('connectCallbacks'); if (association !== null && this.#connectedAttempt !== association.attempt) { this.#connectedAttempt = association.attempt; this.#count('socketConnections'); } break;
        case 'DISCONNECTED': this.#count('disconnectCallbacks'); this.#disconnects[detail.category] = this.#increment(this.#disconnects[detail.category]); break;
        case 'FAILURE': this.#count('failureCallbacks'); this.#failures[detail.category] = this.#increment(this.#failures[detail.category]); break;
        case 'RECONNECT_SCHEDULED': this.#count('reconnectsScheduled'); break;
        case 'RECONNECT_TIMER_FIRED': this.#count('reconnectTimersFired'); break;
        case 'RECONNECT_SUPPRESSED': this.#count('reconnectSchedulesSuppressed'); break;
        case 'JOIN_EMIT_ATTEMPTED': this.#count('joinEmitAttempts'); break;
        case 'JOIN_EMIT_RETURNED': this.#count('joinEmitReturns'); break;
        case 'JOIN_MARKED_SENT': this.#count('joinMarkedSent'); break;
        case 'STALE_CALLBACK': if (!CALLBACK_CATEGORIES.includes(detail.callback)) throw new Error('DIAGNOSTICS_CALLBACK_INVALID'); this.#count('staleCallbacks'); break;
        case 'STOP': this.#count('stopCalls'); break;
        case 'RECONCILIATION_REQUIRED': this.#count('latchAssertions'); if (this.#firstRequired === null) this.#firstRequired = at; break;
      }
      this.#emit(association, detail, at);
      if ((detail.kind === 'FAILURE' || detail.kind === 'DISCONNECTED') && association !== null) this.#openGap(association, detail.category, at);
      if (detail.kind === 'CONNECTED') { this.#closeGap(association, at, false); this.#everConnected = true; this.#afterStop = false; }
      if (detail.kind === 'STOP') { this.#closeGap(association, at, true); this.#afterStop = true; }
    } catch { this.#fault(); }
  }
  public notification(valid: boolean): void {
    if (this.#disabled !== 'ACTIVE') return;
    try { this.#count(valid ? 'validNotifications' : 'invalidNotifications'); } catch { this.#fault(); }
  }
  public snapshot(reason: PrivateStreamDiagnosticsV1['snapshot']['reason'], current: Omit<DiagnosticCurrent, 'firstObservedRequiredAt'>, history: ExportHistory = EMPTY_EXPORT_HISTORY): PrivateStreamDiagnosticsV1 | null {
    try {
      this.#snapshotSequence = this.#identifier(this.#snapshotSequence);
      let at = this.#last;
      if (this.#disabled === 'ACTIVE') { try { at = this.#stamp(); } catch { this.#fault(); } }
      const issues = new Set(this.#issues);
      const exportSaturated = [history.skippedRequests, history.failedWrites, history.workerFailures, history.ackTimeouts].includes(Number.MAX_SAFE_INTEGER);
      if (exportSaturated) issues.add('COUNTER_SATURATED');
      if (history.skippedRequests > 0) issues.add('EXPORT_SKIPPED');
      if (history.failedWrites > 0) issues.add('EXPORT_WRITE_FAILED');
      if (history.workerFailures > 0) issues.add('EXPORT_WORKER_FAILED');
      if (history.ackTimeouts > 0) issues.add('EXPORT_ACK_TIMEOUT');
      if (history.finalUnconfirmed) issues.add('FINAL_UNCONFIRMED');
      const events = this.#events.values();
      const durationMs = this.#open === null ? null : gapDuration(this.#open.openedAt, at);
      return parsePrivateStreamDiagnostics({
        schemaVersion: DIAGNOSTICS_VERSION, grantsAuthority: false, provesAccountContinuity: false,
        session: { id: this.#sessionId, source: { kind: 'GIT_CLEAN_COMMIT', commit: this.#sourceCommit, checkedAt: 'SESSION_START' }, startedAt: this.#started },
        snapshot: { sequence: this.#snapshotSequence, reason, at }, limits: DIAGNOSTICS_LIMITS,
        current: { ...current, generation: Number.isSafeInteger(current.generation) ? current.generation : null, firstObservedRequiredAt: this.#firstRequired },
        providerConfirmationObservation: 'NOT_OBSERVABLE_WITH_EXISTING_LISTENERS', counters: this.#counters, disconnectsByCategory: this.#disconnects, failuresByCategory: this.#failures,
        events, gaps: { closed: this.#closed.values(), open: this.#open === null ? null : { ...this.#open, observedThrough: at, durationMs, durationStatus: durationMs === null ? 'CLOCK_INVALID' : 'VALID' } },
        coverage: { scope: 'LOCAL_OBSERVATIONS_ONLY', status: issues.size === 0 ? 'COMPLETE' : 'INCOMPLETE', captureState: this.#disabled, issues: COVERAGE_ISSUES.filter((issue) => issues.has(issue)), firstRetainedEventSequence: events[0]?.sequence ?? null, lastRecordedEventSequence: events.at(-1)?.sequence ?? null, eventsEvicted: this.#eventsEvicted, closedGapsEvicted: this.#gapsEvicted, recorderFaults: this.#faults, counterSaturated: this.#saturated || exportSaturated, countersExact: !this.#saturated && !exportSaturated && this.#faults === 0 && this.#disabled === 'ACTIVE' },
        exportHistory: history,
      });
    } catch { this.#fault(); return null; }
  }
}
