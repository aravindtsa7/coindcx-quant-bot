// Offline driver for the pure M2 W1 limiter. Simulated clients follow the client protocol; a SUSPENDED client
// (between its start check and request creation) performs no action at all until it resumes. Actual request starts
// and request intervals are recorded so tests measure starts, not grants. Numbers are fixtures, not approved values.
import {
  checkStart, closeSessionAndInventory, createLimiterState, emptyGrantBook, receiveGrant, restoreLimiterState, revokeGrant, step,
  validateRateLimiterConfig,
  type BudgetOperation, type BudgetScope, type ClientGrantBook, type ElapsedEvidence, type Grant, type LimiterSnapshot, type LimiterState,
  type PriorityClass, type RateLimiterConfig, type SchedulerEffect, type SchedulerEvent,
} from '../../../../src/integration/coindcx/rate-limit';

export function fixtureConfig(overrides: Record<string, unknown> = {}): RateLimiterConfig {
  const base = {
    windows: [{ windowMs: 1000, maxStarts: 20 }, { windowMs: 10_000, maxStarts: 200 }],
    fairnessWindowMs: 10_000,
    classShares: { P0: { minPerWindow: 0, maxPerWindow: 200 }, P1: { minPerWindow: 0, maxPerWindow: 200 }, P2: { minPerWindow: 0, maxPerWindow: 200 }, P3: { minPerWindow: 0, maxPerWindow: 200 } },
    concurrency: 1000, p0ReservedSlots: 0, grantTtlMs: 2000, maxRequestDeadlineMs: 120_000, overdueGuardMs: 1, uncertainChargeAlertMs: 60_000,
    retryAfter: { noHeaderDefaultMs: 60_000, providerStatedBlockMs: 10_000, localBackoffBaseMs: 15_000, localBackoffMaxMs: 300_000, operationalCapMs: 600_000, clockUncertaintyMs: 2000 },
    ...overrides,
  };
  const result = validateRateLimiterConfig(base);
  if (result.kind !== 'VALID') throw new Error(`fixture config invalid: ${result.reason}`);
  return result.config;
}

export interface SimRequest {
  readonly id: string; readonly client?: string; readonly cls?: PriorityClass; readonly operation?: BudgetOperation; readonly scope?: BudgetScope;
  readonly arrive: number; readonly deadline?: number; readonly lifetimeMs?: number;
  /** Delay from local receipt to the synchronous start check. */
  readonly startDelay?: number;
  /** Process suspension AFTER the check passed and BEFORE request creation. */
  readonly pause?: number;
  readonly duration?: number;
  readonly noReceivedAck?: boolean;
  readonly crashAt?: number;
}
export interface SimOptions {
  readonly config: RateLimiterConfig; readonly horizon: number;
  readonly disconnects?: readonly { client: string; at: number }[];
  readonly restartAt?: number; readonly restoreNowOffset?: number; readonly restoreEvidence?: ElapsedEvidence | null;
  readonly terminationEvidence?: boolean;
}
interface Client { id: string; session: string; epoch: string; book: ClientGrantBook; sessionOpen: boolean; seq: number; suspendedUntil: number; deadAt: number }
type Action = { at: number; seq: number; client: string; run: () => void };

export interface SimResult {
  readonly starts: ReadonlyArray<{ id: string; at: number }>;
  readonly intervals: ReadonlyArray<{ id: string; start: number; end: number }>;
  readonly grantedAt: ReadonlyMap<string, number>;
  readonly refusals: ReadonlyArray<{ id: string; at: number; code: string }>;
  readonly effects: ReadonlyArray<{ at: number; effect: SchedulerEffect }>;
  readonly state: LimiterState;
  readonly snapshots: ReadonlyArray<{ revision: number; snapshot: LimiterSnapshot }>;
  readonly states: ReadonlyMap<number, LimiterState>;
  maxStartsIn(windowMs: number): number;
  maxConcurrent(): number;
}

export function maxInWindow(times: readonly number[], windowMs: number): number {
  const sorted = [...times].sort((a, b) => a - b);
  let best = 0;
  for (let hi = 0, lo = 0; hi < sorted.length; hi++) { while (sorted[hi]! - sorted[lo]! >= windowMs) lo++; best = Math.max(best, hi - lo + 1); }
  return best;
}

/** Runs the scheduler with auto-committed write-ahead persistence and protocol-following simulated clients. */
export function simulate(options: SimOptions, requests: readonly SimRequest[], watchTimes: readonly number[] = []): SimResult {
  const { config } = options;
  let epochN = 1, state = createLimiterState(config, 0, 'E1');
  const clients = new Map<string, Client>();
  const actions: Action[] = []; let seq = 0;
  const starts: { id: string; at: number }[] = [], intervals: { id: string; start: number; end: number }[] = [];
  const grantedAt = new Map<string, number>(), refusals: { id: string; at: number; code: string }[] = [], effects: { at: number; effect: SchedulerEffect }[] = [];
  const snapshots: { revision: number; snapshot: LimiterSnapshot }[] = []; let committed: LimiterSnapshot | null = null;
  const states = new Map<number, LimiterState>();
  const byGrant = new Map<string, SimRequest>();
  const at = (time: number, client: string, run: () => void): void => { actions.push({ at: time, seq: seq++, client, run }); };

  const apply = (now: number, event: SchedulerEvent): void => {
    let pending: SchedulerEvent | null = event;
    while (pending !== null) {
      const result = step(state, now, pending); state = result.state; pending = null;
      for (const effect of result.effects) {
        effects.push({ at: now, effect });
        if (effect.kind === 'PERSIST') { snapshots.push({ revision: effect.revision, snapshot: effect.snapshot }); committed = effect.snapshot; pending = { type: 'PERSIST_COMMITTED', revision: effect.revision }; }
        if (effect.kind === 'REFUSE') refusals.push({ id: effect.requestId, at: now, code: effect.code });
        if (effect.kind === 'DELIVER_GRANT') deliver(now, effect.grant);
        if (effect.kind === 'REVOKE') for (const grantId of effect.grantIds) { const c = clientOf(grantId); at(now, c.id, () => { const r = revokeGrant(c.book, grantId); c.book = r.book; if (r.report) report(c, grantId, 'NOT_STARTED'); }); }
      }
    }
  };
  const clientOf = (grantId: string): Client => clients.get(byGrant.get(grantId)!.client ?? 'C1')!;
  const ensureClient = (id: string): Client => {
    let c = clients.get(id);
    if (c === undefined) { c = { id, session: `${id}-s1`, epoch: state.epoch, book: emptyGrantBook(), sessionOpen: true, seq: 1, suspendedUntil: -1, deadAt: Infinity }; clients.set(id, c); apply(0, { type: 'SESSION_OPENED', sessionId: c.session, clientInstanceId: id }); }
    return c;
  };
  const report = (c: Client, grantId: string, kind: 'RECEIVED' | 'STARTED' | 'NOT_STARTED' | 'COMPLETED'): void => apply(clock, { type: 'REPORT', clientInstanceId: c.id, grantId, kind });
  const deliver = (now: number, grant: Grant): void => {
    const request = byGrant.get(grant.grantId)!; const c = clientOf(grant.grantId);
    grantedAt.set(request.id, now);
    at(now, c.id, () => {
      const received = receiveGrant(c.book, clock, grant, { sessionId: c.session, epoch: c.epoch }); c.book = received.book;
      if (received.report) { report(c, grant.grantId, 'NOT_STARTED'); return; }
      if (!request.noReceivedAck) report(c, grant.grantId, 'RECEIVED');
      at(clock + (request.startDelay ?? 0), c.id, () => check(c, grant, request));
    });
  };
  let clock = 0;
  const check = (c: Client, grant: Grant, request: SimRequest): void => {
    const now = clock;
    const result = checkStart(c.book, now, grant.grantId, { sessionId: c.session, sessionOpen: c.sessionOpen, epoch: c.epoch, knownStop: false, knownBlockedScopes: [] });
    c.book = result.book;
    if (result.kind === 'VOID') { report(c, grant.grantId, 'NOT_STARTED'); return; }
    if (result.kind !== 'USE') return;
    const startAt = now + (request.pause ?? 0);
    c.suspendedUntil = startAt; // the whole process is suspended until the request is created
    at(startAt, c.id, () => {
      if (startAt >= c.deadAt) return; // died while suspended: never started
      starts.push({ id: request.id, at: startAt });
      const natural = startAt + (request.duration ?? 1);
      const end = Math.min(natural, c.deadAt);
      intervals.push({ id: request.id, start: startAt, end });
      report(c, grant.grantId, 'STARTED');
      if (natural < c.deadAt) at(natural, c.id, () => report(c, grant.grantId, 'COMPLETED'));
    });
  };

  for (const request of requests) {
    const c = ensureClient(request.client ?? 'C1');
    const grantId = `g-${request.id}`;
    byGrant.set(grantId, request);
    if (request.crashAt !== undefined) c.deadAt = Math.min(c.deadAt, request.crashAt);
    at(request.arrive, c.id, () => apply(clock, { type: 'ENQUEUE', request: {
      requestId: request.id, grantId, clientInstanceId: c.id, sessionId: c.session, cls: request.cls ?? 'P1', operation: request.operation ?? 'READ',
      scope: request.scope ?? 'API_AUTH', deadlineMs: request.deadline ?? request.arrive + config.maxRequestDeadlineMs, lifetimeMs: request.lifetimeMs ?? 10_000,
    } }));
  }
  for (const d of options.disconnects ?? []) {
    at(d.at, d.client, () => {
      const c = clients.get(d.client)!;
      apply(clock, { type: 'SESSION_CLOSED', sessionId: c.session });
      c.sessionOpen = false;
      // Reconnect (when the process is next running): void unused grants, open a new session, send an explicit inventory.
      at(clock, d.client, () => reconnect(c));
    });
  }
  const reconnect = (c: Client): void => {
    const closed = closeSessionAndInventory(c.book, c.session); c.book = closed.book;
    c.seq += 1; c.session = `${c.id}-s${c.seq}`; c.sessionOpen = true; c.epoch = state.epoch;
    apply(clock, { type: 'SESSION_OPENED', sessionId: c.session, clientInstanceId: c.id });
    apply(clock, { type: 'INVENTORY', clientInstanceId: c.id, used: closed.inventory.used, voided: closed.inventory.voided });
  };

  for (clock = 0; clock <= options.horizon; clock++) {
    if (options.restartAt !== undefined && clock === options.restartAt) {
      epochN += 1;
      const restored = restoreLimiterState(config, committed, clock, `E${epochN}`, options.restoreEvidence ?? null);
      if (restored.kind !== 'RESTORED') throw new Error('restore failed in harness');
      state = restored.state;
      for (const effect of restored.effects) if (effect.kind === 'PERSIST') { committed = effect.snapshot; apply(clock, { type: 'PERSIST_COMMITTED', revision: effect.revision }); }
      for (const c of clients.values()) { c.sessionOpen = false; at(clock, c.id, () => reconnect(c)); }
    }
    for (const c of clients.values()) if (options.terminationEvidence && c.deadAt === clock) apply(clock, { type: 'TERMINATION_EVIDENCE', clientInstanceId: c.id, evidence: 'OS_PROCESS_EXIT' });
    for (;;) {
      const due = actions.filter((a) => a.at <= clock).sort((a, b) => a.at - b.at || a.seq - b.seq);
      const runnable = due.find((a) => { const c = clients.get(a.client)!; return clock >= c.deadAt || clock >= c.suspendedUntil; });
      if (runnable === undefined) break;
      actions.splice(actions.indexOf(runnable), 1);
      const c = clients.get(runnable.client)!;
      if (clock >= c.deadAt) continue; // a dead process does nothing
      runnable.run();
    }
    apply(clock, { type: 'ADVANCE' });
    if (watchTimes.includes(clock)) states.set(clock, state);
  }
  return {
    starts, intervals, grantedAt, refusals, effects, state, snapshots, states,
    maxStartsIn: (windowMs) => maxInWindow(starts.map((s) => s.at), windowMs),
    maxConcurrent: () => {
      const ev = intervals.flatMap((i) => [[i.start, 1], [i.end, -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let cur = 0, best = 0; for (const [, d] of ev) { cur += d; best = Math.max(best, cur); } return best;
    },
  };
}
export const range = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
