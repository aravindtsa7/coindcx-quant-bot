/**
 * M2 W2: limiter coordinator process around the pure W1 scheduler. Unwired: no provider request or mutation path
 * imports this module. A budget permit is never execution authority.
 *
 * Serialization: every inbound message and timer tick is handled synchronously to completion
 * (scheduler step -> durable commit (both slots flushed) -> PERSIST_COMMITTED step -> sends). Grants, STOP/RESET
 * acknowledgements, throttle/probe acknowledgements, probe announcements and state broadcasts are sent only after
 * the commit that contains them. A failed commit fails closed (scheduler UNKNOWN) and is never retried by this process.
 *
 * Conservative W2 decisions: no recovery from UNKNOWN; no process-termination evidence (a crashed or disconnected
 * client keeps its uncertain charges and slots); no trusted-local-clock date conversion and no shortened restart
 * wait (those optional W1 inputs are never passed); no cancellation hook over IPC or after restart; nothing is
 * released by elapsed TTL, orphan timeout, request timeout or an empty inventory.
 * IPC is an offline trusted-host prototype: no ACL, impersonation or remote-client exclusion is implemented or claimed.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import {
  createLimiterState, restoreLimiterState, snapshotLimiterState, step,
  type BudgetScope, type ChargeRecord, type LimiterState, type SchedulerEffect, type SchedulerEvent,
} from '../index';
import type { CoordinatorConfig } from './config';
import { encodeFrame, FrameDecoder } from './framing';
import { clientMessageSchema, PROTOCOL_VERSION, type ClientMessage, type CoordinatorMessage, type StateView } from './protocol';
import { openStateStore, type DurableRecord, type StateStore, type StateStoreFaults } from './state-store';

export const newId = (prefix: 'e' | 's' | 'g' | 'c' | 'r'): string => `${prefix}${randomBytes(16).toString('hex')}`;
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Test-only fault points (process-crash simulation). Production construction passes none. */
export interface CoordinatorFaults { readonly store?: StateStoreFaults; readonly afterCommitBeforeDelivery?: (seq: number) => void }
export type CoordinatorStart =
  | Readonly<{ kind: 'RUNNING'; coordinator: RateLimitCoordinator; recoveredFrom: string }>
  | Readonly<{ kind: 'BIND_FAILED'; code: string }>
  | Readonly<{ kind: 'FAIL_CLOSED'; reason: string }>;
export type ControlAck = Readonly<{ result: 'APPLIED' | 'REJECTED'; reason?: string }>;
export interface CoordinatorAlert { readonly atMs: number; readonly code: string; readonly detail: string }

interface Session {
  readonly id: string; readonly socket: net.Socket; readonly decoder: FrameDecoder;
  clientInstanceId: string | null; probeScopes: readonly BudgetScope[]; pending: number; handshakeTimer: NodeJS.Timeout | null;
}

export class RateLimitCoordinator {
  readonly #config: CoordinatorConfig; readonly #server: net.Server; readonly #store: StateStore; readonly #faults: CoordinatorFaults;
  readonly #origin = process.hrtime.bigint();
  readonly #sessions = new Map<string, Session>();
  readonly #sockets = new Set<net.Socket>();
  readonly #clients = new Map<string, string>(); // clientInstanceId -> sha256(resume secret)
  readonly #requests = new Map<string, { sessionId: string; ref: string }>();
  readonly #alertListeners = new Set<(alert: CoordinatorAlert) => void>();
  readonly alerts: CoordinatorAlert[] = [];
  #state: LimiterState; #tick: NodeJS.Timeout | null = null; #closing = false; #lastView = '';
  /** Sends that must follow the durable commit of the step that produced them (probe announcements). */
  #afterCommit: Array<() => void> = [];
  readonly epoch: string;

  private constructor(config: CoordinatorConfig, server: net.Server, store: StateStore, record: DurableRecord, faults: CoordinatorFaults) {
    this.#config = config; this.#server = server; this.#store = store; this.#faults = faults;
    for (const client of record.clients) this.#clients.set(client.clientInstanceId, client.resumeSecretSha256);
    this.epoch = newId('e');
    const now = this.#now();
    if (record.scheduler === null) this.#state = createLimiterState(config.limiter, now, this.epoch);
    else {
      // No elapsed-time evidence is ever passed (W2 decision): every block re-waits its full duration.
      const restored = restoreLimiterState(config.limiter, record.scheduler, now, this.epoch, null);
      if (restored.kind !== 'RESTORED') throw new FailClosed('SCHEDULER_SNAPSHOT_UNREADABLE');
      this.#state = restored.state;
    }
  }

  /** Bind first (single coordinator per pipe, hence per state directory), then open and restore durable state. */
  static async start(config: CoordinatorConfig, faults: CoordinatorFaults = {}): Promise<CoordinatorStart> {
    const server = net.createServer({ allowHalfOpen: false, pauseOnConnect: true });
    const bound = await new Promise<string | null>((resolve) => {
      server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'UNKNOWN'));
      server.listen(config.pipePath, () => resolve(null));
    });
    if (bound !== null) return Object.freeze({ kind: 'BIND_FAILED', code: bound });
    const closeServer = (): Promise<void> => new Promise((resolve) => server.close(() => resolve()));
    const opened = openStateStore(config.stateDirectory, config.pipePath, config.maxStateBytes, faults.store ?? {});
    if (opened.kind !== 'OPEN') { await closeServer(); return Object.freeze({ kind: 'FAIL_CLOSED', reason: opened.reason }); }
    let coordinator: RateLimitCoordinator;
    try {
      coordinator = new RateLimitCoordinator(config, server, opened.store, opened.record, faults);
      // The restored state (new epoch) is made durable before any connection is served.
      if (!coordinator.#commit()) throw new FailClosed('INITIAL_COMMIT_FAILED');
    } catch (error) {
      await closeServer();
      return Object.freeze({ kind: 'FAIL_CLOSED', reason: error instanceof FailClosed ? error.message : 'STARTUP_ERROR' });
    }
    server.on('connection', (socket) => coordinator.#accept(socket));
    coordinator.#tick = setInterval(() => coordinator.#dispatch({ type: 'ADVANCE' }), config.tickMs);
    return Object.freeze({ kind: 'RUNNING', coordinator, recoveredFrom: opened.recoveredFrom });
  }

  get state(): LimiterState { return this.#state; }
  get durableSeq(): number { return this.#store.lastSeq; }
  onAlert(listener: (alert: CoordinatorAlert) => void): () => void { this.#alertListeners.add(listener); return () => this.#alertListeners.delete(listener); }
  /** Operator STOP (in-process). Returns only after the durable commit. */
  stop(): ControlAck { return this.#control('STOP'); }
  /** Operator RESET_STOP (in-process). Refused while the scheduler is UNKNOWN (no recovery from UNKNOWN in W2). */
  resetStop(): ControlAck { return this.#control('RESET_STOP'); }

  /** Stops serving. Releases nothing: outstanding charges and slots remain in the durable state. */
  async close(): Promise<void> {
    this.#closing = true;
    if (this.#tick !== null) clearInterval(this.#tick);
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #now(): number { return Number((process.hrtime.bigint() - this.#origin) / 1_000_000n); }
  #alert(code: string, detail: string): void {
    const alert = Object.freeze({ atMs: this.#now(), code, detail });
    this.alerts.push(alert); if (this.alerts.length > 1000) this.alerts.shift();
    for (const listener of this.#alertListeners) listener(alert);
  }

  /** Durable commit of the current scheduler state and client registry; then PERSIST_COMMITTED. False = failed closed. */
  #commit(): boolean {
    if (this.#store.failed) return false;
    const liveClients = new Set([...this.#sessions.values()].flatMap((s) => (s.clientInstanceId === null ? [] : [s.clientInstanceId])));
    const keep = (id: string): boolean => liveClients.has(id) || this.#state.charges.some((charge) => charge.clientInstanceId === id);
    const clients = [...this.#clients].filter(([id]) => keep(id)).map(([clientInstanceId, resumeSecretSha256]) => ({ clientInstanceId, resumeSecretSha256 }));
    const revision = this.#state.revision;
    let seq: number;
    try { seq = this.#store.commit({ scheduler: snapshotLimiterState(this.#state), clients }); } catch (error) {
      this.#alert('PERSISTENCE_FAILED', error instanceof Error ? error.message : 'commit failed');
      this.#apply({ type: 'PERSIST_FAILED', revision }, false);
      // Grants planned in the failed revision were voided by the scheduler (never sent): refuse their requests explicitly.
      for (const [requestId, target] of this.#requests) {
        if (this.#state.queue.some((queued) => queued.request.requestId === requestId)) continue;
        this.#requests.delete(requestId);
        const session = this.#sessions.get(target.sessionId);
        if (session !== undefined) { session.pending -= 1; this.#send(session, { t: 'REFUSED', ref: target.ref, code: 'PERSISTENCE_FAILED' }); }
      }
      return false;
    }
    for (const [id] of this.#clients) if (!keep(id)) this.#clients.delete(id);
    this.#faults.afterCommitBeforeDelivery?.(seq);
    if (revision > this.#state.committedRevision) this.#apply({ type: 'PERSIST_COMMITTED', revision }, false);
    return true;
  }

  /** One scheduler event, handled to completion. Returns effects and whether every required commit succeeded. */
  #dispatch(event: SchedulerEvent): { effects: SchedulerEffect[]; durable: boolean } {
    if (this.#closing) return { effects: [], durable: false };
    const effects = this.#apply(event, true);
    const durable = effects.some((effect) => effect.kind === 'PERSIST') ? this.#commit() : true;
    const deferred = this.#afterCommit; this.#afterCommit = [];
    if (durable) for (const send of deferred) send();
    this.#broadcastStateIfChanged();
    return { effects, durable };
  }
  #apply(event: SchedulerEvent, deferPersist: boolean): SchedulerEffect[] {
    const result = step(this.#state, this.#now(), event);
    this.#state = result.state;
    for (const effect of result.effects) this.#effect(effect);
    if (!deferPersist && result.effects.some((effect) => effect.kind === 'PERSIST')) this.#commit();
    return [...result.effects];
  }
  #effect(effect: SchedulerEffect): void {
    switch (effect.kind) {
      case 'PERSIST': return; // committed by the caller of #apply
      case 'DELIVER_GRANT': {
        const target = this.#requests.get(effect.grant.requestId);
        this.#requests.delete(effect.grant.requestId);
        const session = target === undefined ? undefined : this.#sessions.get(target.sessionId);
        if (session !== undefined && target !== undefined) { session.pending -= 1; this.#send(session, { t: 'GRANT', ref: target.ref, grant: { ...effect.grant, viaHook: false } }); }
        return;
      }
      case 'REFUSE': {
        const target = this.#requests.get(effect.requestId);
        this.#requests.delete(effect.requestId);
        const session = target === undefined ? undefined : this.#sessions.get(target.sessionId);
        if (session !== undefined && target !== undefined) { session.pending -= 1; this.#send(session, { t: 'REFUSED', ref: target.ref, code: effect.code }); }
        return;
      }
      case 'REVOKE': { const session = this.#sessions.get(effect.sessionId); if (session) this.#send(session, { t: 'REVOKE', grantIds: [...effect.grantIds] }); return; }
      case 'PROBE_DUE':
        this.#afterCommit.push(() => { for (const session of this.#sessions.values()) if (session.probeScopes.includes(effect.scope)) this.#send(session, { t: 'PROBE_DUE', scope: effect.scope, probeGen: effect.probeGen }); });
        return;
      case 'ALERT': this.#alert(effect.code, effect.detail); return;
      case 'REPORT_IGNORED': return;
    }
  }

  #view(): StateView {
    const scopes = this.#state.scopes;
    return { admission: this.#state.admission, blockedScopes: (['API_AUTH', 'PUBLIC'] as const).filter((s) => scopes[s].kind !== 'CLEAR'), unknown: this.#state.unknown !== null };
  }
  #broadcastStateIfChanged(): void {
    const view = this.#view(), key = JSON.stringify(view);
    if (key === this.#lastView) return;
    this.#lastView = key;
    for (const session of this.#sessions.values()) if (session.clientInstanceId !== null) this.#send(session, { t: 'STATE', state: view });
  }

  #control(action: 'STOP' | 'RESET_STOP'): ControlAck {
    const { effects, durable } = this.#dispatch({ type: action });
    if (!durable) return { result: 'REJECTED', reason: 'PERSISTENCE_FAILED' };
    if (effects.some((e) => e.kind === 'ALERT' && e.code === 'RESET_REFUSED_STATE_UNKNOWN')) return { result: 'REJECTED', reason: 'STATE_UNKNOWN' };
    return { result: 'APPLIED' };
  }

  #send(session: Session, message: CoordinatorMessage): void {
    if (session.socket.destroyed) return;
    try { session.socket.write(encodeFrame(message, this.#config.maxFrameBytes)); } catch { this.#alert('SEND_FAILED', session.id); session.socket.destroy(); }
  }

  #accept(socket: net.Socket): void {
    this.#sockets.add(socket);
    socket.once('close', () => this.#sockets.delete(socket));
    if (this.#closing || this.#sessions.size >= this.#config.maxSessions) { socket.end(encodeFrame({ t: 'ERROR', code: 'TOO_MANY_SESSIONS' }, this.#config.maxFrameBytes)); return; }
    const session: Session = { id: newId('s'), socket, decoder: new FrameDecoder(this.#config.maxFrameBytes), clientInstanceId: null, probeScopes: [], pending: 0, handshakeTimer: null };
    this.#sessions.set(session.id, session);
    session.handshakeTimer = setTimeout(() => this.#protocolError(session, 'HANDSHAKE_TIMEOUT'), this.#config.handshakeTimeoutMs);
    socket.on('data', (chunk: Buffer) => {
      const decoded = session.decoder.push(chunk);
      if (decoded.kind === 'PROTOCOL_ERROR') { this.#protocolError(session, decoded.reason); return; }
      for (const frame of decoded.frames) {
        if (socket.destroyed) return;
        const parsed = clientMessageSchema.safeParse(frame);
        if (!parsed.success) { this.#protocolError(session, 'INVALID_MESSAGE'); return; }
        this.#message(session, parsed.data);
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (session.handshakeTimer !== null) clearTimeout(session.handshakeTimer);
      this.#sessions.delete(session.id);
      for (const [requestId, target] of this.#requests) if (target.sessionId === session.id) this.#requests.delete(requestId);
      // Releases nothing: grants of the closed session stay uncertain until positive evidence arrives.
      if (session.clientInstanceId !== null) this.#dispatch({ type: 'SESSION_CLOSED', sessionId: session.id });
    });
    socket.resume();
  }
  #protocolError(session: Session, code: string): void {
    this.#alert('PROTOCOL_ERROR', `${session.id}:${code}`);
    if (!session.socket.destroyed) session.socket.end(encodeFrame({ t: 'ERROR', code }, this.#config.maxFrameBytes));
    session.socket.destroy();
  }

  #message(session: Session, message: ClientMessage): void {
    if (session.clientInstanceId === null) {
      if (message.t !== 'HELLO' && message.t !== 'RESUME') { this.#protocolError(session, 'HANDSHAKE_REQUIRED'); return; }
      this.#handshake(session, message);
      return;
    }
    const instance = session.clientInstanceId;
    switch (message.t) {
      case 'HELLO': case 'RESUME': this.#protocolError(session, 'DUPLICATE_HANDSHAKE'); return;
      case 'REQUEST': {
        if (session.pending >= this.#config.maxPendingRequestsPerSession) { this.#send(session, { t: 'REFUSED', ref: message.ref, code: 'TOO_MANY_PENDING' }); return; }
        const requestId = newId('r');
        this.#requests.set(requestId, { sessionId: session.id, ref: message.ref });
        session.pending += 1;
        this.#dispatch({ type: 'ENQUEUE', request: {
          requestId, grantId: newId('g'), clientInstanceId: instance, sessionId: session.id, cls: message.cls, operation: message.operation, scope: message.scope,
          deadlineMs: this.#now() + message.deadlineInMs, lifetimeMs: message.lifetimeMs, ...(message.probeGen === undefined ? {} : { probeGen: message.probeGen }),
        } });
        return;
      }
      case 'REPORT': {
        const charge = this.#bound(session, message);
        if (typeof charge === 'string') { this.#send(session, { t: 'ACK', ackId: message.ackId, result: 'REJECTED', reason: charge }); return; }
        const { effects, durable } = this.#dispatch({ type: 'REPORT', clientInstanceId: instance, grantId: message.grantId, kind: message.kind });
        this.#ack(session, message.ackId, effects, durable, message.grantId);
        return;
      }
      case 'INVENTORY': {
        // Explicit per-grant statements only; each entry must belong to this client and to the named closed session.
        const ok = (grantId: string): boolean => this.#state.charges.some((c) => c.grantId === grantId && c.clientInstanceId === instance && c.epoch === message.closedEpoch && c.sessionId === message.closedSessionId);
        const used = message.used.filter(ok), voided = message.voided.filter(ok);
        const dropped = message.used.length + message.voided.length - used.length - voided.length;
        if (message.closedSessionId === session.id) { this.#send(session, { t: 'ACK', ackId: message.ackId, result: 'REJECTED', reason: 'OPEN_SESSION' }); return; }
        if (dropped > 0) this.#alert('INVENTORY_ENTRIES_REJECTED', `${session.id}:${dropped}`);
        const { durable } = this.#dispatch({ type: 'INVENTORY', clientInstanceId: instance, used, voided });
        this.#send(session, { t: 'ACK', ackId: message.ackId, result: durable ? 'APPLIED' : 'REJECTED', ...(durable ? (dropped > 0 ? { reason: `DROPPED_${dropped}` } : {}) : { reason: 'PERSISTENCE_FAILED' }) });
        return;
      }
      case 'THROTTLED': {
        const charge = this.#bound(session, message);
        if (typeof charge === 'string') { this.#send(session, { t: 'ACK', ackId: message.ackId, result: 'REJECTED', reason: charge }); return; }
        // Receipt is taken at the coordinator (no earlier than the client's receipt); the local clock is never trusted here.
        const { effects, durable } = this.#dispatch({ type: 'THROTTLE_OBSERVED', retryAfter: { retryAfter: message.retryAfter, serverDate: message.serverDate, receiptWallMs: null, localClockTrusted: false } });
        this.#ack(session, message.ackId, effects, durable, message.grantId);
        return;
      }
      case 'PROBE_RESULT': {
        const charge = this.#bound(session, message);
        if (typeof charge === 'string' || charge.operation !== 'PROBE' || charge.probeGen === null) { this.#send(session, { t: 'ACK', ackId: message.ackId, result: 'REJECTED', reason: typeof charge === 'string' ? charge : 'NOT_A_PROBE' }); return; }
        const { effects, durable } = this.#dispatch({ type: 'PROBE_RESULT', scope: charge.scope, probeGen: charge.probeGen, outcome: message.outcome });
        const stale = effects.some((e) => e.kind === 'ALERT' && e.code === 'STALE_PROBE_RESULT');
        this.#send(session, { t: 'ACK', ackId: message.ackId, result: !durable ? 'REJECTED' : stale ? 'IGNORED' : 'APPLIED', ...(!durable ? { reason: 'PERSISTENCE_FAILED' } : stale ? { reason: 'STALE_PROBE' } : {}) });
        return;
      }
      case 'CONTROL': {
        // Trusted-host prototype: any connected client may send operator control (no ACL implemented or claimed).
        const ack = this.#control(message.action);
        this.#send(session, { t: 'ACK', ackId: message.ackId, result: ack.result, ...(ack.reason === undefined ? {} : { reason: ack.reason }) });
        return;
      }
    }
  }

  /** The grant must exist, belong to this session's client instance, and match the epoch and session it was issued in. */
  #bound(session: Session, message: { grantId: string; grantEpoch: string; grantSessionId: string }): ChargeRecord | string {
    const charge = this.#state.charges.find((c) => c.grantId === message.grantId);
    if (charge === undefined) return 'UNKNOWN_GRANT';
    if (charge.clientInstanceId !== session.clientInstanceId || charge.epoch !== message.grantEpoch || charge.sessionId !== message.grantSessionId) {
      this.#alert('REPORT_BINDING_MISMATCH', `${session.id}:${message.grantId}`);
      return 'BINDING_MISMATCH';
    }
    return charge;
  }
  #ack(session: Session, ackId: string, effects: readonly SchedulerEffect[], durable: boolean, grantId: string): void {
    if (!durable) { this.#send(session, { t: 'ACK', ackId, result: 'REJECTED', reason: 'PERSISTENCE_FAILED' }); return; }
    const ignored = effects.find((e): e is Extract<SchedulerEffect, { kind: 'REPORT_IGNORED' }> => e.kind === 'REPORT_IGNORED' && e.grantId === grantId);
    this.#send(session, { t: 'ACK', ackId, result: ignored ? 'IGNORED' : 'APPLIED', ...(ignored ? { reason: ignored.reason } : {}) });
  }

  #handshake(session: Session, message: Extract<ClientMessage, { t: 'HELLO' | 'RESUME' }>): void {
    if (session.handshakeTimer !== null) { clearTimeout(session.handshakeTimer); session.handshakeTimer = null; }
    let resumeSecret: string | undefined;
    if (message.t === 'HELLO') {
      if (this.#clients.size >= this.#config.maxRegisteredClients) { this.#protocolError(session, 'TOO_MANY_CLIENTS'); return; }
      const id = newId('c');
      resumeSecret = randomBytes(32).toString('hex');
      this.#clients.set(id, sha256(resumeSecret));
      session.clientInstanceId = id;
    } else {
      const stored = this.#clients.get(message.clientInstanceId);
      const presented = Buffer.from(sha256(message.resumeSecret), 'hex');
      if (stored === undefined || !timingSafeEqual(Buffer.from(stored, 'hex'), presented)) { this.#protocolError(session, 'RESUME_REJECTED'); return; }
      for (const other of this.#sessions.values()) if (other !== session && other.clientInstanceId === message.clientInstanceId) other.socket.destroy();
      session.clientInstanceId = message.clientInstanceId;
    }
    session.probeScopes = [...new Set(message.probeScopes)];
    // The registration (and the open session) are durable before WELCOME is sent.
    const { durable } = this.#dispatch({ type: 'SESSION_OPENED', sessionId: session.id, clientInstanceId: session.clientInstanceId });
    if (!(durable && this.#commit())) { this.#protocolError(session, 'PERSISTENCE_FAILED'); return; }
    this.#send(session, { t: 'WELCOME', epoch: this.epoch, sessionId: session.id, clientInstanceId: session.clientInstanceId, ...(resumeSecret === undefined ? {} : { resumeSecret }), state: this.#view() });
  }
}

class FailClosed extends Error {}
export { PROTOCOL_VERSION };
