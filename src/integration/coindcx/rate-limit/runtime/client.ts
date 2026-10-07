/**
 * M2 W2: limiter client. Budget only: a permit is never execution authority, and no provider request or mutation
 * path imports this module in W2.
 *
 * One-use permits (W1 client protocol): `permit.start(create)` runs the synchronous start check and, on USE, calls
 * `create` in the same synchronous region and queues STARTED (also when `create` throws). Reports go through an
 * acknowledged outbox and are re-sent after reconnection (the coordinator de-duplicates).
 * On reconnection the client voids every unused grant of the closed session and sends an explicit inventory;
 * grants it never received cannot be listed and stay uncertain at the coordinator.
 *
 * Pinned limit: a process suspension inside `start` delays the actual request without bound; the coordinator keeps
 * the charge uncertain until STARTED arrives. A local deadline refusal can likewise be delayed by suspension.
 */
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  checkStart, closeSessionAndInventory, emptyGrantBook, receiveGrant, revokeGrant,
  type BudgetOperation, type BudgetScope, type ClientGrantBook, type Grant, type PriorityClass,
} from '../index';
import type { ClientConfig } from './config';
import { encodeFrame, FrameDecoder } from './framing';
import { coordinatorMessageSchema, PROTOCOL_VERSION, type ClientMessage, type CoordinatorMessage, type StateView } from './protocol';

export interface AcquireRequest {
  readonly cls: PriorityClass; readonly operation: BudgetOperation; readonly scope: BudgetScope;
  readonly deadlineInMs: number; readonly lifetimeMs: number; readonly probeGen?: number;
}
export type AcquireResult =
  | Readonly<{ kind: 'GRANTED'; permit: BudgetPermit }>
  | Readonly<{ kind: 'REFUSED'; code: string }>
  | Readonly<{ kind: 'UNAVAILABLE'; reason: 'NOT_CONNECTED' | 'DISCONNECTED' | 'LOCAL_DEADLINE' | 'OUTBOX_FULL' }>;
export type AckResult = Readonly<{ result: 'APPLIED' | 'IGNORED' | 'REJECTED'; reason?: string }>;
type Outgoing = Extract<ClientMessage, { ackId: string }>;
type OutgoingBody = Outgoing extends infer M ? (M extends Outgoing ? Omit<M, 'ackId'> : never) : never;

export class RateLimitClient {
  readonly #config: ClientConfig;
  #socket: net.Socket | null = null;
  #book: ClientGrantBook = emptyGrantBook();
  #identity: { clientInstanceId: string; resumeSecret: string } | null = null;
  #session: { epoch: string; sessionId: string } | null = null;
  readonly #closedSessions: Array<{ epoch: string; sessionId: string }> = [];
  #view: StateView = { admission: 'OPEN', blockedScopes: [], unknown: false };
  #ackSeq = 0; #refSeq = 0;
  readonly #outbox = new Map<string, Outgoing>();
  readonly #ackWaiters = new Map<string, (ack: AckResult) => void>();
  readonly #pending = new Map<string, { resolve: (result: AcquireResult) => void; timer: NodeJS.Timeout }>();
  readonly #probeListeners = new Set<(scope: BudgetScope, probeGen: number) => void>();
  readonly #stateListeners = new Set<(view: StateView) => void>();
  #welcome: ((ok: boolean) => void) | null = null;
  #resumeRejected = false;

  constructor(config: ClientConfig) { this.#config = config; }

  get session(): Readonly<{ epoch: string; sessionId: string }> | null { return this.#session; }
  get clientInstanceId(): string | null { return this.#identity?.clientInstanceId ?? null; }
  get view(): StateView { return this.#view; }
  get outboxSize(): number { return this.#outbox.size; }
  onProbeDue(listener: (scope: BudgetScope, probeGen: number) => void): void { this.#probeListeners.add(listener); }
  onState(listener: (view: StateView) => void): void { this.#stateListeners.add(listener); }
  #localNow(): number { return Math.floor(performance.now()); }

  /** HELLO on first connection; RESUME (same client instance) afterwards. */
  connect(): Promise<boolean> {
    if (this.#socket !== null) return Promise.resolve(this.#session !== null);
    return new Promise((resolve) => {
      const socket = net.connect(this.#config.pipePath);
      const decoder = new FrameDecoder(this.#config.maxFrameBytes);
      this.#socket = socket;
      const timer = setTimeout(() => { socket.destroy(); }, this.#config.connectTimeoutMs);
      this.#welcome = (ok) => {
        clearTimeout(timer); this.#welcome = null;
        if (!ok && this.#resumeRejected && this.#identity !== null) {
          // The coordinator holds no charge for this identity (it prunes only such identities), so nothing held locally
          // under it can be reported: discard it and register once as a new client instance.
          this.#resumeRejected = false; this.#identity = null; this.#book = emptyGrantBook(); this.#closedSessions.length = 0;
          void this.connect().then(resolve);
          return;
        }
        resolve(ok);
      };
      socket.on('connect', () => {
        const scopes = [...this.#config.probeScopes];
        this.#write(this.#identity === null
          ? { t: 'HELLO', v: PROTOCOL_VERSION, probeScopes: scopes }
          : { t: 'RESUME', v: PROTOCOL_VERSION, clientInstanceId: this.#identity.clientInstanceId, resumeSecret: this.#identity.resumeSecret, probeScopes: scopes });
      });
      socket.on('data', (chunk: Buffer) => {
        const decoded = decoder.push(chunk);
        if (decoded.kind === 'PROTOCOL_ERROR') { socket.destroy(); return; }
        for (const frame of decoded.frames) {
          const parsed = coordinatorMessageSchema.safeParse(frame);
          if (!parsed.success) { socket.destroy(); return; }
          this.#message(parsed.data);
        }
      });
      socket.on('error', () => undefined);
      socket.on('close', () => { clearTimeout(timer); this.#closed(socket); });
    });
  }

  /** Closes the connection. Unused grants are voided at the next reconnection; nothing is released by closing. */
  close(): void { this.#socket?.destroy(); }

  acquire(request: AcquireRequest): Promise<AcquireResult> {
    if (this.#session === null || this.#socket === null) return Promise.resolve(Object.freeze({ kind: 'UNAVAILABLE', reason: 'NOT_CONNECTED' }));
    if (this.#outbox.size >= this.#config.maxOutbox) return Promise.resolve(Object.freeze({ kind: 'UNAVAILABLE', reason: 'OUTBOX_FULL' }));
    const ref = `q${++this.#refSeq}`;
    return new Promise((resolve) => {
      // Local bounded refusal: the coordinator also refuses at the deadline; a grant arriving later is voided.
      const timer = setTimeout(() => { this.#pending.delete(ref); resolve(Object.freeze({ kind: 'UNAVAILABLE', reason: 'LOCAL_DEADLINE' })); }, request.deadlineInMs);
      this.#pending.set(ref, { resolve, timer });
      this.#write({ t: 'REQUEST', ref, cls: request.cls, operation: request.operation, scope: request.scope, deadlineInMs: request.deadlineInMs, lifetimeMs: request.lifetimeMs, ...(request.probeGen === undefined ? {} : { probeGen: request.probeGen }) });
    });
  }

  /** Operator control over the trusted-host IPC prototype. Resolves after the coordinator's durable commit. */
  control(action: 'STOP' | 'RESET_STOP'): Promise<AckResult> { return this.#send({ t: 'CONTROL', action }); }

  #send(body: OutgoingBody): Promise<AckResult> {
    const ackId = `a${++this.#ackSeq}`;
    const message = { ...body, ackId } as Outgoing;
    this.#outbox.set(ackId, message);
    const acked = new Promise<AckResult>((resolve) => this.#ackWaiters.set(ackId, resolve));
    if (this.#session !== null) this.#write(message);
    return acked;
  }
  /** Fire-and-forget report used inside the synchronous start region (queued in the outbox, never awaited there). */
  report(grant: Grant, kind: 'RECEIVED' | 'STARTED' | 'NOT_STARTED' | 'COMPLETED'): Promise<AckResult> {
    return this.#send({ t: 'REPORT', grantId: grant.grantId, grantEpoch: grant.epoch, grantSessionId: grant.sessionId, kind });
  }
  reportThrottled(grant: Grant, headers: { retryAfter?: string; serverDate?: string }): Promise<AckResult> {
    return this.#send({ t: 'THROTTLED', grantId: grant.grantId, grantEpoch: grant.epoch, grantSessionId: grant.sessionId, ...headers });
  }
  reportProbe(grant: Grant, outcome: 'SUCCESS' | 'FAILED'): Promise<AckResult> {
    return this.#send({ t: 'PROBE_RESULT', grantId: grant.grantId, grantEpoch: grant.epoch, grantSessionId: grant.sessionId, outcome });
  }

  /** Synchronous start check for `grant`; USE runs `create` in the same synchronous region. */
  startGrant<T>(grant: Grant, create: () => T): Readonly<{ kind: 'STARTED'; value: T }> | Readonly<{ kind: 'NOT_STARTED'; reason: string }> {
    const consumed = this.consumeGrant(grant);
    if (consumed.kind === 'NOT_STARTED') return consumed;
    try {
      return Object.freeze({ kind: 'STARTED', value: create() });
    } finally {
      void this.report(grant, 'STARTED'); // also when `create` throws: a start cannot be excluded
    }
  }
  /**
   * M2 W4: the synchronous start check alone, for a mutation consumed at its last dispatch boundary. USE marks the grant
   * used and reports nothing; the caller reports STARTED (`report(grant, 'STARTED')`) at the actual request creation. A
   * used grant whose request is never created stays uncertain at the coordinator until the reconnect inventory lists it.
   */
  consumeGrant(grant: Grant): Readonly<{ kind: 'USED' }> | Readonly<{ kind: 'NOT_STARTED'; reason: string }> {
    const session = this.#session;
    const check = checkStart(this.#book, this.#localNow(), grant.grantId, {
      sessionId: session?.sessionId ?? '', sessionOpen: session !== null && this.#socket !== null, epoch: session?.epoch ?? '',
      knownStop: this.#view.admission === 'STOPPED', knownBlockedScopes: this.#view.unknown ? ['API_AUTH', 'PUBLIC'] : this.#view.blockedScopes,
    });
    this.#book = check.book;
    if (check.kind === 'REFUSED') return Object.freeze({ kind: 'NOT_STARTED', reason: check.reason });
    if (check.kind === 'VOID') { void this.report(grant, 'NOT_STARTED'); return Object.freeze({ kind: 'NOT_STARTED', reason: check.report.reason }); }
    return Object.freeze({ kind: 'USED' });
  }
  /** Voids an unused grant (NOT_STARTED). A used grant cannot be released. */
  releaseGrant(grant: Grant): boolean {
    const result = revokeGrant(this.#book, grant.grantId);
    this.#book = result.book;
    if (result.report !== null) void this.report(grant, 'NOT_STARTED');
    return result.report !== null;
  }

  #write(message: ClientMessage): void {
    const socket = this.#socket;
    if (socket === null || socket.destroyed) return;
    socket.write(encodeFrame(message, this.#config.maxFrameBytes));
  }

  #closed(socket: net.Socket): void {
    if (this.#socket !== socket) return;
    this.#socket = null;
    if (this.#session !== null) this.#closedSessions.push(this.#session);
    this.#session = null;
    for (const [ref, pending] of this.#pending) { clearTimeout(pending.timer); pending.resolve(Object.freeze({ kind: 'UNAVAILABLE', reason: 'DISCONNECTED' })); this.#pending.delete(ref); }
    this.#welcome?.(false);
  }

  #message(message: CoordinatorMessage): void {
    switch (message.t) {
      case 'WELCOME': {
        if (this.#identity === null) {
          if (message.resumeSecret === undefined) { this.#socket?.destroy(); return; }
          this.#identity = { clientInstanceId: message.clientInstanceId, resumeSecret: message.resumeSecret };
        } else if (message.clientInstanceId !== this.#identity.clientInstanceId) { this.#socket?.destroy(); return; }
        this.#session = { epoch: message.epoch, sessionId: message.sessionId };
        this.#setView(message.state);
        // Re-send unacknowledged reports first, then an explicit inventory for every closed session (unused grants voided first).
        for (const queued of this.#outbox.values()) this.#write(queued);
        for (const closed of this.#closedSessions.splice(0)) {
          const result = closeSessionAndInventory(this.#book, closed.sessionId);
          this.#book = result.book;
          if (result.inventory.used.length + result.inventory.voided.length > 0) {
            void this.#send({ t: 'INVENTORY', closedEpoch: closed.epoch, closedSessionId: closed.sessionId, used: [...result.inventory.used], voided: [...result.inventory.voided] });
          }
        }
        this.#welcome?.(true);
        return;
      }
      case 'GRANT': {
        const session = this.#session;
        if (session === null) return;
        const received = receiveGrant(this.#book, this.#localNow(), message.grant, session);
        this.#book = received.book;
        if (received.report !== null) { void this.report(message.grant, 'NOT_STARTED'); return; }
        void this.report(message.grant, 'RECEIVED');
        const pending = this.#pending.get(message.ref);
        if (pending === undefined) { this.releaseGrant(message.grant); return; } // local deadline already passed
        this.#pending.delete(message.ref); clearTimeout(pending.timer);
        pending.resolve(Object.freeze({ kind: 'GRANTED', permit: new BudgetPermit(this, message.grant) }));
        return;
      }
      case 'REFUSED': {
        const pending = this.#pending.get(message.ref);
        if (pending === undefined) return;
        this.#pending.delete(message.ref); clearTimeout(pending.timer);
        pending.resolve(Object.freeze({ kind: 'REFUSED', code: message.code }));
        return;
      }
      case 'REVOKE':
        for (const grantId of message.grantIds) {
          const held = this.#book.grants[grantId];
          if (held !== undefined) this.releaseGrant(held.grant);
        }
        return;
      case 'STATE': this.#setView(message.state); return;
      case 'PROBE_DUE': for (const listener of this.#probeListeners) listener(message.scope, message.probeGen); return;
      case 'ACK': {
        this.#outbox.delete(message.ackId);
        const waiter = this.#ackWaiters.get(message.ackId);
        this.#ackWaiters.delete(message.ackId);
        waiter?.(Object.freeze({ result: message.result, ...(message.reason === undefined ? {} : { reason: message.reason }) }));
        return;
      }
      case 'ERROR': if (message.code === 'RESUME_REJECTED') this.#resumeRejected = true; this.#socket?.destroy(); return;
    }
  }
  #setView(view: StateView): void { this.#view = view; for (const listener of this.#stateListeners) listener(view); }
}

/** A budget permit for one grant. Budget only; never execution authority. */
export class BudgetPermit {
  readonly #client: RateLimitClient;
  readonly grant: Grant;
  constructor(client: RateLimitClient, grant: Grant) { this.#client = client; this.grant = grant; }
  /** Synchronous: start check, then `create` in the same synchronous region. */
  start<T>(create: () => T): Readonly<{ kind: 'STARTED'; value: T }> | Readonly<{ kind: 'NOT_STARTED'; reason: string }> { return this.#client.startGrant(this.grant, create); }
  /** M2 W4, mutations: the synchronous start check only; STARTED is reported later by `reportStarted`, at request creation. */
  consume(): Readonly<{ kind: 'USED' }> | Readonly<{ kind: 'NOT_STARTED'; reason: string }> { return this.#client.consumeGrant(this.grant); }
  reportStarted(): Promise<AckResult> { return this.#client.report(this.grant, 'STARTED'); }
  /** Positive completion/teardown evidence; call after the response ended or the request was destroyed and closed. */
  complete(): Promise<AckResult> { return this.#client.report(this.grant, 'COMPLETED'); }
  release(): boolean { return this.#client.releaseGrant(this.grant); }
  reportThrottled(headers: { retryAfter?: string; serverDate?: string }): Promise<AckResult> { return this.#client.reportThrottled(this.grant, headers); }
  reportProbe(outcome: 'SUCCESS' | 'FAILED'): Promise<AckResult> { return this.#client.reportProbe(this.grant, outcome); }
}
