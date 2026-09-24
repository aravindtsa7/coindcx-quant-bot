/**
 * READ-ONLY CoinDCX provider probe: private account WebSocket observation.
 *
 * The socket is receive-only apart from one semantic operation,
 * `joinPrivateAccountChannel`, which builds the fixed documented `coindcx`
 * join payload itself and passes it through `assertReadOnlySocketEmit`
 * immediately before the single raw emission. The raw socket.io-client object
 * and its generic `emit` never leave this module: no caller can supply an
 * event name, a channel name, or a signed body. Every server event name is
 * captured through a catch-all hook so undocumented events are visible, but
 * event payloads are reduced to key paths, candidate-field summaries, and
 * timestamp units; connection identifiers are recorded only as SHA-256
 * digests.
 */
import io from 'socket.io-client';
import {
  PROBE_PRIVATE_CHANNEL,
  PROBE_SOCKET_JOIN_EVENT,
  PROBE_SOCKET_ORIGIN,
  ProbeSafetyError,
  assertReadOnlySocketEmit,
} from './allowlist';
import {
  CandidateTracker,
  SecretRegistry,
  TimestampTracker,
  classifyTimestamp,
  enumerateKeyPaths,
  isTimestampKey,
  registerSensitiveLeaves,
  scalarText,
  sha256Hex,
  walk,
  type KeyPath,
} from './sanitize';
import type { RequestSigner } from '../../src/integration/coindcx/signer';

/**
 * The production-facing probe socket. It deliberately has no generic `emit`:
 * the only outbound operation is the fixed private-channel join.
 */
export interface ProbeSocket {
  connect(): void;
  disconnect(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  /** Signs the fixed join body with `signer` and emits the documented `coindcx` join; nothing else can be sent. */
  joinPrivateAccountChannel(apiKey: string, signer: RequestSigner): void;
  socketId(): string | undefined;
  engineId(): string | undefined;
  onAnyServerEvent(listener: (event: string, args: readonly unknown[]) => void): void;
}

export type ProbeSocketFactory = (origin: typeof PROBE_SOCKET_ORIGIN) => ProbeSocket;

/**
 * The exact bytes signed for the private-channel join. Kept local (a unit
 * test pins it byte-identical to the production `CANONICAL_AUTH_BODY` in
 * `websocket/private-stream.ts`) so the probe does not import that module's
 * wider dependency graph.
 */
export const PROBE_JOIN_SIGNED_BODY = JSON.stringify({ channel: PROBE_PRIVATE_CHANNEL });

/** The raw socket.io-client 2.x surface. Module-private: never exported or returned. */
interface RawIoSocket {
  connect(): void;
  disconnect(): void;
  id?: string;
  io?: { engine?: { id?: string } };
  on(event: string, listener: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  onevent?: (packet: { data?: unknown[] }) => void;
}

/** Production factory: a dedicated socket.io-client 2.x instance with no automatic reconnection. */
export const productionProbeSocketFactory: ProbeSocketFactory = (origin) => {
  if (origin !== PROBE_SOCKET_ORIGIN) {
    throw new ProbeSafetyError('PROBE_SOCKET_OPERATION_REJECTED', 'Socket origin outside the read-only probe allowlist');
  }
  const ioFactory = io as unknown as (url: string, options: unknown) => RawIoSocket;
  const raw = ioFactory(PROBE_SOCKET_ORIGIN, { transports: ['websocket'], reconnection: false, autoConnect: false, forceNew: true });
  const anyListeners: ((event: string, args: readonly unknown[]) => void)[] = [];
  const original = raw.onevent;
  if (typeof original === 'function') {
    raw.onevent = function onevent(this: unknown, packet: { data?: unknown[] }) {
      const data = Array.isArray(packet.data) ? packet.data : [];
      for (const listener of anyListeners) listener(typeof data[0] === 'string' ? data[0] : '<non-string-event-name>', data.slice(1));
      return original.call(this, packet);
    };
  }
  return {
    connect: () => raw.connect(),
    disconnect: () => raw.disconnect(),
    on: (event, listener) => raw.on(event, listener),
    joinPrivateAccountChannel: (apiKey, signer) => {
      const payload = { channelName: PROBE_PRIVATE_CHANNEL, authSignature: signer.sign(PROBE_JOIN_SIGNED_BODY), apiKey };
      assertReadOnlySocketEmit(PROBE_SOCKET_JOIN_EVENT, payload);
      raw.emit(PROBE_SOCKET_JOIN_EVENT, payload);
    },
    socketId: () => raw.id,
    engineId: () => raw.io?.engine?.id,
    onAnyServerEvent: (listener) => { anyListeners.push(listener); },
  };
};

export interface WsEventSummary {
  readonly event: string;
  readonly count: number;
  readonly keyPaths: readonly KeyPath[];
}

export interface WsSessionObservation {
  readonly label: string;
  readonly connected: boolean;
  readonly connectLatencyMs: number | null;
  readonly socketIdSha256: string | null;
  readonly engineIdSha256: string | null;
  readonly joinEmitted: boolean;
  readonly serverEvents: readonly WsEventSummary[];
  readonly lifecycle: readonly { readonly event: string; readonly atMs: number; readonly detail: string | null }[];
  readonly accountEventCount: number;
}

/**
 * In memory only, never serialized. For each account event, the values of its
 * timestamp-NAMED fields converted to ms by magnitude. These carry no
 * documented event-time or replay semantics (a `created_at` may be old, an
 * `updated_at` may belong to another resource), so they support only a neutral
 * wall-clock comparison and never a replay conclusion.
 */
export interface WsSessionPrivate {
  readonly accountEventTimestampValuesMs: readonly (readonly number[])[];
  readonly allKeys: readonly string[];
}

export const ACCOUNT_EVENTS: ReadonlySet<string> = new Set(['df-order-update', 'df-position-update', 'balance-update']);

function parseEnvelope(arg: unknown): unknown {
  if (typeof arg === 'string') {
    try { return JSON.parse(arg) as unknown; } catch { return arg; }
  }
  if (arg !== null && typeof arg === 'object' && typeof (arg as { data?: unknown }).data === 'string') {
    const envelope = arg as Record<string, unknown>;
    try { return { ...envelope, data: JSON.parse(envelope['data'] as string) as unknown, dataWasJsonString: true }; } catch { return arg; }
  }
  return arg;
}

function toMs(value: unknown): number | null {
  const unit = classifyTimestamp(value);
  const text = scalarText(value);
  if (text === null) return null;
  switch (unit) {
    case 'SECONDS': case 'SECONDS_FRACTIONAL': return Math.round(Number(text) * 1000);
    case 'MILLISECONDS': return Number(text);
    case 'MICROSECONDS': return Math.round(Number(text) / 1000);
    case 'NANOSECONDS': return Math.round(Number(text) / 1_000_000);
    case 'ISO_8601_STRING': { const parsed = Date.parse(text); return Number.isNaN(parsed) ? null : parsed; }
    default: return null;
  }
}

/** A short description of a socket error or reason; objects contribute their key names only. */
function describeUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') return `object{${Object.keys(value).sort().join(',')}}`;
  return typeof value;
}

export interface ObserveSessionOptions {
  readonly label: string;
  readonly apiKey: string;
  readonly signer: RequestSigner;
  readonly factory: ProbeSocketFactory;
  readonly windowMs: number;
  readonly connectTimeoutMs: number;
  readonly monotonicNow: () => number;
  readonly wallNow: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly registry: SecretRegistry;
  readonly candidates: CandidateTracker;
  readonly timestamps: TimestampTracker;
}

export async function observePrivateSession(options: ObserveSessionOptions): Promise<{ observation: WsSessionObservation; privateData: WsSessionPrivate }> {
  const socket = options.factory(PROBE_SOCKET_ORIGIN);
  const startedAt = options.monotonicNow();
  const lifecycle: { event: string; atMs: number; detail: string | null }[] = [];
  const events = new Map<string, { count: number; payloads: unknown[] }>();
  const accountEventTimestampValues: number[][] = [];
  const allKeys = new Set<string>();
  let connectedAt: number | null = null;
  let joinEmitted = false;
  const note = (event: string, detail: string | null) => lifecycle.push({ event, atMs: Math.round(options.monotonicNow() - startedAt), detail: detail === null ? null : options.registry.redact(detail).slice(0, 160) });

  socket.onAnyServerEvent((event, args) => {
    const entry = events.get(event) ?? { count: 0, payloads: [] };
    entry.count += 1;
    const parsed = args.map(parseEnvelope);
    if (entry.payloads.length < 25) entry.payloads.push(parsed);
    events.set(event, entry);
    const timestampValues: number[] = [];
    for (const payload of parsed) {
      registerSensitiveLeaves(payload, options.registry);
      options.candidates.observe(`ws:${event}`, payload);
      options.timestamps.observe(`ws:${event}`, payload);
      walk(payload, ({ key, value }) => {
        allKeys.add(key);
        if (ACCOUNT_EVENTS.has(event) && isTimestampKey(key)) {
          const ms = toMs(value);
          if (ms !== null) timestampValues.push(ms);
        }
      });
    }
    if (ACCOUNT_EVENTS.has(event)) accountEventTimestampValues.push(timestampValues);
  });

  const connected = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), options.connectTimeoutMs);
    socket.on('connect', (...args: unknown[]) => {
      clearTimeout(timer);
      connectedAt = options.monotonicNow();
      note('connect', args.length === 0 ? null : `args:${args.length}`);
      resolve(true);
    });
    socket.on('connect_error', (error: unknown) => { note('connect_error', describeUnknown(error)); });
    socket.on('error', (error: unknown) => { note('error', describeUnknown(error)); });
    socket.on('disconnect', (reason: unknown) => { note('disconnect', describeUnknown(reason)); });
    socket.connect();
  });

  let socketIdSha256: string | null = null;
  let engineIdSha256: string | null = null;
  if (connected) {
    const socketId = socket.socketId();
    const engineId = socket.engineId();
    options.registry.addProviderValue('socket-id', socketId);
    options.registry.addProviderValue('engine-id', engineId);
    socketIdSha256 = socketId === undefined ? null : sha256Hex(socketId);
    engineIdSha256 = engineId === undefined ? null : sha256Hex(engineId);
    socket.joinPrivateAccountChannel(options.apiKey, options.signer);
    joinEmitted = true;
    note('join-emitted', null);
    await options.sleep(options.windowMs);
  }
  socket.disconnect();
  note('client-disconnect', null);

  const serverEvents = [...events.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([event, entry]) => ({
    event,
    count: entry.count,
    keyPaths: enumerateKeyPaths(entry.payloads.flat()),
  }));
  return {
    observation: {
      label: options.label,
      connected,
      connectLatencyMs: connectedAt === null ? null : Math.round(connectedAt - startedAt),
      socketIdSha256,
      engineIdSha256,
      joinEmitted,
      serverEvents,
      lifecycle,
      accountEventCount: serverEvents.filter((summary) => ACCOUNT_EVENTS.has(summary.event)).reduce((sum, summary) => sum + summary.count, 0),
    },
    privateData: { accountEventTimestampValuesMs: accountEventTimestampValues, allKeys: [...allKeys] },
  };
}
