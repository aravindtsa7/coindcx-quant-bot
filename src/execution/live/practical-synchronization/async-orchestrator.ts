/**
 * M4 (unwired review candidate, docs/M4_SYNCHRONIZATION_CANDIDATE.md): asynchronous read orchestration over the M4
 * engine. It only gathers injected asynchronous observations and hands them to `evaluateCollectedCycle`; it
 * duplicates no normalization, scan, ownership or assessment rule. It is imported by nothing in `src/`.
 *
 * One cycle: the initial stream observation, REST pass 0 and then pass 1 (components of a pass may complete in any
 * order), the final stream observation, then the engine's assessment.
 *
 * Bindings. Every scan request carries a binding (account, scope, cycle, pass, component, cycle-start epoch, request
 * id), and a response is accepted only if it echoes that exact binding. A response that arrives after its cycle was
 * abandoned or superseded is never awaited by, and so never enters, a newer cycle; a misrouted one fails its binding.
 *
 * Events. Every private event delivered while a cycle is active is counted by a LOCAL observed-event counter and
 * revokes that cycle, even if the stream's temporary buffer is later emptied. The local counter is not a provider
 * sequence number: no provider sequence exists (register D1), and no gap detection is claimed.
 *
 * Failures. A read failure, timeout, cancellation, malformed response or binding mismatch is an explicit unresolved
 * result. A revoked cycle restarts only within the configured cycle limit. Nothing here clears the reconnect latch or
 * any strict reconciliation requirement; observations pass through unchanged apart from the locally observed events.
 *
 * Every result grants nothing.
 */
import {
  evaluateCollectedCycle,
  GRANTS_NOTHING,
  isValidSynchronizationConfig,
  SYNC_HISTORY_UNPROVEN,
  type ObservationComponent,
  type SyncCycleResult,
  type SyncHistoryScope,
  type SynchronizationConfig,
  type SyncScanLimits,
} from './engine';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** What a scan response must echo exactly. */
export type AsyncReadBinding = Readonly<{
  accountId: string;
  scopeId: string;
  cycle: number;
  pass: 0 | 1;
  component: ObservationComponent;
  /** The stream epoch observed at cycle start (null when unknown). */
  epoch: number | null;
  requestId: string;
}>;

/** The injected asynchronous source: async fixtures in tests. Nothing here constructs one. */
export interface AsyncSynchronizationSource {
  /** Resolves to `{ binding, scan }`, where `scan` is an engine `SyncComponentScan`. */
  scan(request: Readonly<{ binding: AsyncReadBinding; limits: SyncScanLimits; history: SyncHistoryScope; signal: AbortSignal }>): Promise<unknown>;
  /** Resolves to a stream observation (the engine validates it). */
  observeStream(request: Readonly<{ cycle: number; point: 'CYCLE_START' | 'EVALUATION'; signal: AbortSignal }>): Promise<unknown>;
  /** Registers a listener for private events as they are observed locally; returns the unsubscribe function. */
  subscribeEvents(listener: (event: unknown) => void): () => void;
}

/** Injected time. `delay` resolves after `ms`, or rejects when `signal` aborts. */
export interface AsyncClock {
  now(): number;
  delay(ms: number, signal: AbortSignal): Promise<void>;
}

/** Explicit per-call bounds. No default exists; none is approved for production. */
export interface AsyncOrchestrationLimits {
  readonly readTimeoutMs: number;
  readonly streamTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type AsyncReadOutcome = 'RESPONSE' | 'READ_TIMEOUT' | 'READ_CANCELLED' | 'READ_REJECTED' | 'RESPONSE_MALFORMED' | 'RESPONSE_BINDING_MISMATCH';
export type AsyncOrchestrationReason =
  | Exclude<AsyncReadOutcome, 'RESPONSE'>
  | 'STREAM_OBSERVATION_UNAVAILABLE' | 'EVENT_OBSERVED_DURING_CYCLE' | 'RUN_CANCELLED';

export type AsyncCycleRecord = Readonly<{
  cycle: number;
  status: 'OBSERVED_CONVERGENCE' | 'UNRESOLVED' | 'REVOKED' | 'CANCELLED';
  /** Orchestration reasons first, then the engine's (when it assessed the cycle). */
  reasons: readonly string[];
  orchestrationReasons: readonly AsyncOrchestrationReason[];
  reads: readonly Readonly<{ pass: 0 | 1; component: ObservationComponent; outcome: AsyncReadOutcome }>[];
  localObservedEventCount: number;
  /** The engine's assessment of the collected cycle; null when the cycle was abandoned or cancelled first. */
  engine: SyncCycleResult | null;
}>;

export type AsyncSynchronizationResult = Readonly<{
  status: 'OBSERVED_CONVERGENCE' | 'UNRESOLVED' | 'REVOKED_CYCLE_LIMIT_REACHED' | 'CANCELLED' | 'INVALID_CONFIGURATION';
  semantics: 'OBSERVED_CONVERGENCE_WITHIN_DECLARED_SCAN_SCOPE';
  historyCompleteness: typeof SYNC_HISTORY_UNPROVEN;
  /** A local count of events this process observed. Not a provider sequence; no gap detection is claimed. */
  eventOrdering: Readonly<{ localObservedEventCount: number; providerSequence: 'NOT_AVAILABLE'; gapDetection: 'NOT_CLAIMED' }>;
  cycles: readonly AsyncCycleRecord[];
  grants: typeof GRANTS_NOTHING;
}>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const NEVER = new Promise<never>(() => undefined);

type Settled<T> = Readonly<{ kind: 'OK'; value: T }> | Readonly<{ kind: 'TIMEOUT' | 'CANCELLED' | 'REJECTED' }>;

/** Awaits `work` until it settles, `ms` elapses on the injected clock, or `signal` aborts, whichever comes first. */
async function settle<T>(work: () => Promise<T>, ms: number, clock: AsyncClock, signal: AbortSignal): Promise<Settled<T>> {
  if (signal.aborted) return { kind: 'CANCELLED' };
  const timer = new AbortController();
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<Settled<T>>((resolve) => { onAbort = () => resolve({ kind: 'CANCELLED' }); signal.addEventListener('abort', onAbort, { once: true }); });
  try {
    let pending: Promise<T>;
    try { pending = work(); } catch { return { kind: 'REJECTED' }; }
    return await Promise.race<Settled<T>>([
      pending.then((value): Settled<T> => ({ kind: 'OK', value }), (): Settled<T> => (signal.aborted ? { kind: 'CANCELLED' } : { kind: 'REJECTED' })),
      clock.delay(ms, timer.signal).then((): Settled<T> => ({ kind: 'TIMEOUT' }), () => NEVER),
      aborted,
    ]);
  } finally {
    timer.abort();
    signal.removeEventListener('abort', onAbort);
  }
}

function sameBinding(value: unknown, expected: AsyncReadBinding): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(expected) as (keyof AsyncReadBinding)[];
  return Object.keys(value).length === keys.length && keys.every((key) => value[key] === expected[key]);
}

function scopeIdOf(config: SynchronizationConfig): string {
  return JSON.stringify([config.scope.accountId, [...config.scope.components], [...config.scope.requiredAccounting], config.scope.history]);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function runCycle(config: SynchronizationConfig, limits: AsyncOrchestrationLimits, source: AsyncSynchronizationSource, clock: AsyncClock,
  outer: AbortSignal, cycle: number, onEvent: { current: ((event: unknown) => void) | null }): Promise<AsyncCycleRecord> {
  const controller = new AbortController();
  const signal = controller.signal;
  const cancelFromOuter = (): void => controller.abort();
  outer.addEventListener('abort', cancelFromOuter, { once: true });
  const localEvents: Readonly<{ observedAtMs: number }>[] = [];
  const reasons = new Set<AsyncOrchestrationReason>();
  const reads: Array<Readonly<{ pass: 0 | 1; component: ObservationComponent; outcome: AsyncReadOutcome }>> = [];
  // Every event during the active cycle is revocation evidence, whatever the stream buffer later reports.
  onEvent.current = (event: unknown) => {
    const observedAtMs = isRecord(event) && typeof event['observedAtMs'] === 'number' && Number.isSafeInteger(event['observedAtMs']) ? event['observedAtMs'] : clock.now();
    localEvents.push(Object.freeze({ observedAtMs }));
    reasons.add('EVENT_OBSERVED_DURING_CYCLE');
    controller.abort();
  };
  const record = (status: AsyncCycleRecord['status'], engine: SyncCycleResult | null): AsyncCycleRecord => {
    const orchestrationReasons = Object.freeze([...reasons].sort());
    return Object.freeze({
      cycle, status, orchestrationReasons, reads: Object.freeze([...reads]), localObservedEventCount: localEvents.length, engine,
      reasons: Object.freeze([...orchestrationReasons, ...(engine === null ? [] : engine.reasons.filter((reason) => !orchestrationReasons.includes(reason as AsyncOrchestrationReason)))]),
    });
  };
  const interrupted = (): AsyncCycleRecord | null => {
    if (localEvents.length > 0) return record('REVOKED', null);
    if (outer.aborted) { reasons.add('RUN_CANCELLED'); return record('CANCELLED', null); }
    return null;
  };

  try {
    const observe = async (point: 'CYCLE_START' | 'EVALUATION'): Promise<unknown> => {
      const observed = await settle(() => source.observeStream({ cycle, point, signal }), limits.streamTimeoutMs, clock, signal);
      if (observed.kind === 'OK') return observed.value;
      reasons.add('STREAM_OBSERVATION_UNAVAILABLE');
      return null; // the engine treats it as unavailable, which revokes
    };
    const start = await observe('CYCLE_START');
    const early = interrupted();
    if (early !== null) return early;
    const epoch = isRecord(start) && (start['epoch'] === null || isPositive(start['epoch'])) ? start['epoch'] as number | null : null;
    const scopeId = scopeIdOf(config);

    const scans: unknown[][] = [];
    for (const pass of [0, 1] as const) {
      // Components of one pass run concurrently and may complete in any order; results are placed by binding.
      const results = await Promise.all(config.scope.components.map(async (component): Promise<unknown> => {
        const binding: AsyncReadBinding = Object.freeze({ accountId: config.scope.accountId, scopeId, cycle, pass, component, epoch, requestId: `${cycle}:${pass}:${component}` });
        const settled = await settle(() => source.scan({ binding, limits: config.scanLimits[component]!, history: config.scope.history, signal }), limits.readTimeoutMs, clock, signal);
        let outcome: AsyncReadOutcome;
        let scan: unknown = null;
        if (settled.kind !== 'OK') outcome = settled.kind === 'TIMEOUT' ? 'READ_TIMEOUT' : settled.kind === 'CANCELLED' ? 'READ_CANCELLED' : 'READ_REJECTED';
        else if (!isRecord(settled.value) || !('scan' in settled.value)) outcome = 'RESPONSE_MALFORMED';
        else if (!sameBinding(settled.value['binding'], binding)) outcome = 'RESPONSE_BINDING_MISMATCH';
        else { outcome = 'RESPONSE'; scan = settled.value['scan']; }
        reads.push(Object.freeze({ pass, component, outcome }));
        if (outcome !== 'RESPONSE') reasons.add(outcome);
        return scan; // null for every non-response: the engine records READ_FAILED
      }));
      const stop = interrupted();
      if (stop !== null) return stop;
      scans.push(results);
    }

    const evaluationObserved = await observe('EVALUATION');
    const late = interrupted();
    if (late !== null) return late;
    // Locally observed events are kept as revocation evidence even when the provider-side buffer is empty.
    const evaluation = isRecord(evaluationObserved) && Array.isArray(evaluationObserved['events'])
      ? { ...evaluationObserved, events: [...(evaluationObserved['events'] as unknown[]), ...localEvents] } : evaluationObserved;
    const engine = evaluateCollectedCycle(config, cycle, { start, scans, evaluation, evaluatedAtMs: clock.now() });
    const status = engine.status === 'REVOKED' ? 'REVOKED' as const
      : engine.status === 'OBSERVED_CONVERGENCE' && reasons.size === 0 ? 'OBSERVED_CONVERGENCE' as const : 'UNRESOLVED' as const;
    return record(status, engine);
  } finally {
    onEvent.current = null; // later events belong to no cycle; a late response can no longer reach this cycle either
    controller.abort();
    outer.removeEventListener('abort', cancelFromOuter);
  }
}

/**
 * Runs asynchronous observation cycles until one is not revoked, the cycle limit is reached, or `signal` aborts.
 * A revoked cycle (an observed event, or an engine revocation) restarts with a fresh cycle; nothing is reused.
 */
export async function runAsyncSynchronizationCandidate(input: Readonly<{
  config: unknown; limits: unknown; source: AsyncSynchronizationSource; clock: AsyncClock; signal?: AbortSignal;
}>): Promise<AsyncSynchronizationResult> {
  const result = (status: AsyncSynchronizationResult['status'], cycles: readonly AsyncCycleRecord[]): AsyncSynchronizationResult => Object.freeze({
    status, semantics: 'OBSERVED_CONVERGENCE_WITHIN_DECLARED_SCAN_SCOPE' as const, historyCompleteness: SYNC_HISTORY_UNPROVEN,
    eventOrdering: Object.freeze({ localObservedEventCount: cycles.reduce((sum, entry) => sum + entry.localObservedEventCount, 0), providerSequence: 'NOT_AVAILABLE' as const, gapDetection: 'NOT_CLAIMED' as const }),
    cycles: Object.freeze([...cycles]), grants: GRANTS_NOTHING,
  });
  const { config, limits, source, clock } = input;
  if (!isValidSynchronizationConfig(config) || !isRecord(limits) || !isPositive(limits['readTimeoutMs']) || !isPositive(limits['streamTimeoutMs'])) {
    return result('INVALID_CONFIGURATION', []);
  }
  const outer = input.signal ?? new AbortController().signal;
  const onEvent: { current: ((event: unknown) => void) | null } = { current: null };
  const unsubscribe = source.subscribeEvents((event) => { onEvent.current?.(event); });
  const cycles: AsyncCycleRecord[] = [];
  try {
    for (let cycle = 0; cycle < config.maxCycles; cycle += 1) {
      const entry = await runCycle(config, limits as unknown as AsyncOrchestrationLimits, source, clock, outer, cycle, onEvent);
      cycles.push(entry);
      if (entry.status === 'CANCELLED') return result('CANCELLED', cycles);
      if (entry.status !== 'REVOKED') return result(entry.status, cycles);
      if (outer.aborted) return result('CANCELLED', cycles);
    }
    return result('REVOKED_CYCLE_LIMIT_REACHED', cycles);
  } finally {
    unsubscribe();
  }
}
