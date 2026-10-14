/**
 * M4 (unwired review candidate): a private-stream observation adapter for the asynchronous synchronization
 * orchestration. It implements that orchestration's `observeStream` and `subscribeEvents` sources structurally (no
 * import of the candidate modules) over an INJECTED stream port, which the existing `CoinDcxPrivateAccountStream`
 * satisfies (`subscribe`, `getHealthSnapshot`). It constructs no socket, signer, client or runtime, reads no
 * configuration or credentials, and is composed nowhere. See `docs/M4_SYNC_STREAM_ADAPTER.md`.
 *
 * Mapping (revocation inputs only; nothing here is readiness, continuity or authority):
 *   - epoch: the stream's local connection incarnation (`generationId`, positive), never provider/account continuity;
 *   - window-start epoch: captured by the CYCLE_START observation, which precedes the cycle's first read;
 *   - disconnect: any lifecycle envelope in the window, or a `generationId`/`reconnectCount` change since CYCLE_START,
 *     or not connected at either point. It is latched, so a final connected snapshot cannot erase it;
 *   - reconnect latch: the stream's sticky `reconciliationRequired` (or its RECONCILIATION_REQUIRED state), at either point;
 *   - join acknowledgement: always UNKNOWN (CoinDCX sends none; register D2);
 *   - events: every envelope received in the window, whatever its type, as its local observation time only; a change
 *     in the stream's invalid-event count is one more unknown event (existing Phase 18B rule);
 *   - buffered unprocessed events: envelopes this adapter received but failed to deliver. The port exposes no queue or
 *     upstream backlog, so 0 means only "none known here", never complete delivery (O4).
 *
 * Every failure is explicit: an unusable observation rejects (the orchestration then revokes), and a consumer failure
 * is counted and rethrown to the stream. No payload, event type or identifier is retained or forwarded.
 */
import type { PrivateStreamHealthSnapshot, StreamEventListener } from '../websocket/types';

/** The injected stream port (the existing private stream satisfies it). */
export interface SyncPrivateStreamPort {
  subscribe(listener: StreamEventListener): () => void;
  getHealthSnapshot(): PrivateStreamHealthSnapshot;
}

export interface CoinDcxSyncStreamAdapterOptions {
  readonly stream: SyncPrivateStreamPort;
  /** The same injected clock as the reads (integer milliseconds). */
  readonly clock: Readonly<{ now(): number }>;
}

/** The engine's stream observation shape. The engine validates it; declared here to avoid an execution import. */
export type SyncStreamObservation = Readonly<{
  connected: boolean;
  epoch: number | null;
  epochAtWindowStart: number | null;
  disconnectObservedSinceWindowStart: boolean;
  reconnectLatched: boolean;
  joinAcknowledgement: Readonly<{ kind: 'UNKNOWN' }>;
  events: readonly Readonly<{ observedAtMs: number }>[];
  bufferedUnprocessedEvents: number;
}>;

export interface CoinDcxSyncStreamAdapter {
  observeStream(request: Readonly<{ cycle: number; point: 'CYCLE_START' | 'EVALUATION'; signal: AbortSignal }>): Promise<unknown>;
  subscribeEvents(listener: (event: unknown) => void): () => void;
  close(): void;
}

const LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set(['PRIVATE_STREAM_CONNECTED', 'PRIVATE_STREAM_DISCONNECTED', 'PRIVATE_RECONCILIATION_REQUIRED']);
const RECONCILIATION_REQUIRED_STATE = 'RECONCILIATION_REQUIRED';
const UNKNOWN_ACKNOWLEDGEMENT = Object.freeze({ kind: 'UNKNOWN' as const });

type Health = Readonly<{ generationId: number; connected: boolean; latched: boolean; invalidEventCount: number; reconnectCount: number }>;
/** One cycle's window. `start` is null while its health is being captured. `release` detaches its abort listener. */
type ObservationWindow = {
  cycle: number; start: Health | null; lifecycle: boolean; clockInvalid: boolean; events: Readonly<{ observedAtMs: number }>[]; release: () => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Reads each health field once. A malformed snapshot throws. */
function readHealth(stream: SyncPrivateStreamPort): Health {
  const snapshot: unknown = stream.getHealthSnapshot();
  if (!isRecord(snapshot)) throw new Error('SYNC_STREAM_HEALTH_MALFORMED');
  const { state, generationId, connected, invalidEventCount, reconnectCount, reconciliationRequired } = snapshot;
  if (typeof state !== 'string' || !isCount(generationId) || typeof connected !== 'boolean' || !isCount(invalidEventCount)
    || !isCount(reconnectCount) || typeof reconciliationRequired !== 'boolean') {
    throw new Error('SYNC_STREAM_HEALTH_MALFORMED');
  }
  return Object.freeze({ generationId, connected, latched: reconciliationRequired || state === RECONCILIATION_REQUIRED_STATE, invalidEventCount, reconnectCount });
}

function isLifecycleEnvelope(envelope: unknown): boolean {
  try {
    const eventType = isRecord(envelope) ? envelope['eventType'] : undefined;
    return typeof eventType === 'string' && LIFECYCLE_EVENT_TYPES.has(eventType);
  } catch {
    return false; // still counted as an event by the caller
  }
}

const epochOf = (health: Health): number | null => (health.generationId > 0 ? health.generationId : null);

/** Creates the unwired adapter and subscribes to the stream at once. Returns null for invalid options (no defaults). */
export function createCoinDcxSyncStreamAdapter(options: CoinDcxSyncStreamAdapterOptions): CoinDcxSyncStreamAdapter | null {
  if (typeof options?.stream?.subscribe !== 'function' || typeof options.stream.getHealthSnapshot !== 'function' || typeof options.clock?.now !== 'function') {
    return null;
  }
  const { stream, clock } = options;
  const consumers = new Set<(event: unknown) => void>();
  let openWindow: ObservationWindow | null = null;
  let undelivered = 0;
  let closed = false;

  const localTime = (): number | null => {
    try {
      const now: unknown = clock.now();
      return isCount(now) ? now : null;
    } catch {
      return null;
    }
  };

  const onEnvelope: StreamEventListener = (envelope) => {
    if (closed) return;
    const observedAtMs = localTime();
    const current = openWindow;
    if (current !== null) {
      if (observedAtMs === null) current.clockInvalid = true;
      else current.events.push(Object.freeze({ observedAtMs }));
      if (isLifecycleEnvelope(envelope)) current.lifecycle = true;
    }
    const event = Object.freeze(observedAtMs === null ? {} : { observedAtMs });
    let failed = false;
    for (const consumer of [...consumers]) {
      try { consumer(event); } catch { failed = true; }
    }
    if (failed) {
      undelivered += 1; // received but not applied by every consumer
      throw new Error('SYNC_STREAM_CONSUMER_FAILED');
    }
  };

  // Subscribe before any window can open, so no event falls between opening a window and subscribing. A failed or
  // invalid subscription closes the adapter first, so a listener the stream may still hold records nothing.
  let unsubscribeStream: unknown;
  try {
    unsubscribeStream = stream.subscribe(onEnvelope);
  } catch (error) {
    closed = true;
    throw error;
  }
  if (typeof unsubscribeStream !== 'function') {
    closed = true;
    throw new Error('SYNC_STREAM_SUBSCRIBE_INVALID');
  }

  /** Ends a window: detaches its abort listener and, if it is still the open one, stops retaining events for it. */
  const closeWindow = (target: ObservationWindow | null): void => {
    if (target === null) return;
    target.release();
    if (openWindow === target) openWindow = null;
  };

  function observation(health: Health, start: Health, disconnect: boolean, events: readonly Readonly<{ observedAtMs: number }>[]): SyncStreamObservation {
    return Object.freeze({
      connected: health.connected,
      epoch: epochOf(health),
      epochAtWindowStart: epochOf(start),
      disconnectObservedSinceWindowStart: disconnect,
      reconnectLatched: health.latched || start.latched,
      joinAcknowledgement: UNKNOWN_ACKNOWLEDGEMENT,
      events: Object.freeze([...events]),
      bufferedUnprocessedEvents: undelivered,
    });
  }

  async function observeStream(request: Readonly<{ cycle: number; point: 'CYCLE_START' | 'EVALUATION'; signal: AbortSignal }>): Promise<unknown> {
    if (closed) throw new Error('SYNC_STREAM_ADAPTER_CLOSED');
    const signal: unknown = isRecord(request) ? request.signal : undefined;
    if (!isRecord(request) || !isCount(request.cycle) || (request.point !== 'CYCLE_START' && request.point !== 'EVALUATION')
      || typeof (signal as AbortSignal | undefined)?.addEventListener !== 'function' || typeof (signal as AbortSignal).removeEventListener !== 'function') {
      throw new Error('SYNC_STREAM_REQUEST_INVALID');
    }
    const cycleSignal = signal as AbortSignal;
    if (cycleSignal.aborted) throw new Error('SYNC_STREAM_OBSERVATION_CANCELLED');
    if (request.point === 'CYCLE_START') {
      closeWindow(openWindow);
      // Open the window before capturing health, so an event during the capture is kept. The window ends when its
      // cycle's signal aborts (the orchestration aborts it on revocation and when the cycle ends), so an abandoned
      // window retains nothing further.
      const pending: ObservationWindow = { cycle: request.cycle, start: null, lifecycle: false, clockInvalid: false, events: [], release: () => undefined };
      const onAbort = (): void => { closeWindow(pending); };
      cycleSignal.addEventListener('abort', onAbort, { once: true });
      pending.release = () => { cycleSignal.removeEventListener('abort', onAbort); };
      openWindow = pending;
      let start: Health;
      try {
        start = readHealth(stream);
      } catch (error) {
        closeWindow(pending); // a failed start leaves no window, so its evaluation rejects
        throw error;
      }
      pending.start = start;
      return observation(start, start, false, []);
    }
    const current = openWindow;
    if (current === null || current.cycle !== request.cycle || current.start === null) throw new Error('SYNC_STREAM_WINDOW_NOT_STARTED');
    closeWindow(current); // an evaluation ends its window whether or not it succeeds
    const health = readHealth(stream);
    if (current.clockInvalid) throw new Error('SYNC_STREAM_CLOCK_INVALID');
    const events = [...current.events];
    if (health.invalidEventCount !== current.start.invalidEventCount) {
      const now = localTime();
      if (now === null) throw new Error('SYNC_STREAM_CLOCK_INVALID');
      events.push(Object.freeze({ observedAtMs: now }));
    }
    const disconnect = current.lifecycle || !current.start.connected || !health.connected
      || health.generationId !== current.start.generationId || health.reconnectCount !== current.start.reconnectCount;
    return observation(health, current.start, disconnect, events);
  }

  function subscribeEvents(listener: (event: unknown) => void): () => void {
    if (closed) throw new Error('SYNC_STREAM_ADAPTER_CLOSED');
    if (typeof listener !== 'function') throw new Error('SYNC_STREAM_LISTENER_INVALID');
    const entry = (event: unknown): void => { listener(event); };
    consumers.add(entry);
    return () => { consumers.delete(entry); };
  }

  function close(): void {
    if (closed) return;
    closed = true; // set first: an unsubscribe failure below still leaves the adapter closed, never clean
    closeWindow(openWindow);
    consumers.clear();
    (unsubscribeStream as () => void)();
  }

  return Object.freeze({ observeStream, subscribeEvents, close });
}
