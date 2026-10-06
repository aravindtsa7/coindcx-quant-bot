import { describe, expect, it } from 'vitest';
import { createLimiterState, restoreLimiterState, step, type BudgetRequest, type LimiterState, type SchedulerEffect, type SchedulerEvent } from '../../../../src/integration/coindcx/rate-limit';
import { fixtureConfig, range, simulate } from './harness';

// M2 W1 actual-start accounting (design V3 §2; follow-up issue 1). Offline, pure; fixture numbers only.
const cfg = fixtureConfig();
const burst = (r: ReturnType<typeof simulate>): number => r.maxStartsIn(1000);

function run(state: LimiterState, now: number, event: SchedulerEvent): { state: LimiterState; effects: readonly SchedulerEffect[] } { return step(state, now, event); }
function request(id: string, now: number, overrides: Partial<BudgetRequest> = {}): BudgetRequest {
  return { requestId: id, grantId: `g-${id}`, clientInstanceId: 'C1', sessionId: 'S1', cls: 'P1', operation: 'READ', scope: 'API_AUTH', deadlineMs: now + 60_000, lifetimeMs: 10_000, ...overrides };
}
function opened(config = cfg): LimiterState { return run(createLimiterState(config, 0, 'E1'), 0, { type: 'SESSION_OPENED', sessionId: 'S1', clientInstanceId: 'C1' }).state; }
const kinds = (effects: readonly SchedulerEffect[]): string[] => effects.map((e) => e.kind);

describe('M2 W1 accounting: actual starts, not grants', () => {
  it('suspension after the start check: the charge stays uncertain until STARTED, so actual starts stay within the burst cap', () => {
    const r = simulate({ config: cfg, horizon: 6000 }, [
      { id: 'A', client: 'CA', arrive: 0, pause: 3500 },
      ...range(20, (i) => ({ id: `B${i}`, arrive: 3100 })),
    ], [3400]);
    expect(r.starts).toHaveLength(21);
    expect(burst(r)).toBeLessThanOrEqual(20);
    // A received and acknowledged its grant at 0; RECEIVED has no accounting effect, so its charge is still unresolved at 3400.
    expect(r.states.get(3400)!.charges.find((c) => c.grantId === 'g-A')!.latestStartMs).toBeNull();
    expect(r.starts.find((s) => s.id === 'A')!.at).toBe(3500);
    // The 20th B waits for the 19 others' charges to leave the window (receipt+TTL would have released A's charge at ~2000).
    expect(Math.max(...r.starts.filter((s) => s.id.startsWith('B')).map((s) => s.at))).toBeGreaterThanOrEqual(4100);
  });

  it('delayed and missing RECEIVED acknowledgements do not change accounting; STARTED resolves the charge', () => {
    const r = simulate({ config: cfg, horizon: 5000 }, [
      ...range(20, (i) => ({ id: `A${i}`, arrive: 0, startDelay: 1500, noReceivedAck: true })),
      ...range(20, (i) => ({ id: `B${i}`, arrive: 1001 })),
    ], [1400]);
    expect(r.states.get(1400)!.charges.filter((c) => c.latestStartMs === null)).toHaveLength(20);
    expect(r.starts).toHaveLength(40);
    expect(burst(r)).toBeLessThanOrEqual(20);
  });

  it('duplicate reports are idempotent and RECEIVED never resolves a charge', () => {
    let s = opened();
    s = run(s, 0, { type: 'ENQUEUE', request: request('a', 0) }).state;
    const persisted = run(s, 0, { type: 'ADVANCE' });
    expect(kinds(persisted.effects)).toEqual([]);
    s = run(s, 0, { type: 'PERSIST_COMMITTED', revision: s.revision }).state;
    expect(s.charges[0]!.delivery).toBe('DELIVERED');
    const received = run(s, 5, { type: 'REPORT', clientInstanceId: 'C1', grantId: 'g-a', kind: 'RECEIVED' });
    expect(received.state.charges[0]!.latestStartMs).toBeNull();
    const dupReceived = run(received.state, 6, { type: 'REPORT', clientInstanceId: 'C1', grantId: 'g-a', kind: 'RECEIVED' });
    expect(dupReceived.effects).toContainEqual({ kind: 'REPORT_IGNORED', grantId: 'g-a', reason: 'DUPLICATE' });
    const started = run(dupReceived.state, 10, { type: 'REPORT', clientInstanceId: 'C1', grantId: 'g-a', kind: 'STARTED' });
    expect(started.state.charges[0]!.latestStartMs).toBe(10);
    const dupStarted = run(started.state, 20, { type: 'REPORT', clientInstanceId: 'C1', grantId: 'g-a', kind: 'STARTED' });
    expect(dupStarted.state.charges[0]!.latestStartMs).toBe(10);
    expect(dupStarted.effects).toContainEqual({ kind: 'REPORT_IGNORED', grantId: 'g-a', reason: 'DUPLICATE' });
    const completed = run(dupStarted.state, 30, { type: 'REPORT', clientInstanceId: 'C1', grantId: 'g-a', kind: 'COMPLETED' });
    expect(completed.state.charges[0]!.slotHeld).toBe(false);
    const late = run(completed.state, 40, { type: 'REPORT', clientInstanceId: 'C1', grantId: 'g-a', kind: 'NOT_STARTED' });
    expect(late.effects).toContainEqual({ kind: 'REPORT_IGNORED', grantId: 'g-a', reason: 'AFTER_STARTED' });
    expect(late.state.charges).toHaveLength(1); // still counted in the window
  });

  it('reports are accepted from the issuing client instance only, across sessions and epochs', () => {
    let s = run(opened(), 0, { type: 'ENQUEUE', request: request('a', 0) }).state;
    s = run(s, 0, { type: 'PERSIST_COMMITTED', revision: s.revision }).state;
    const forged = run(s, 1, { type: 'REPORT', clientInstanceId: 'C2', grantId: 'g-a', kind: 'NOT_STARTED' });
    expect(forged.state.charges).toHaveLength(1);
    expect(forged.effects).toContainEqual({ kind: 'REPORT_IGNORED', grantId: 'g-a', reason: 'OTHER_CLIENT' });
    const closed = run(forged.state, 2, { type: 'SESSION_CLOSED', sessionId: 'S1' });
    const voided = run(closed.state, 3, { type: 'REPORT', clientInstanceId: 'C1', grantId: 'g-a', kind: 'NOT_STARTED' });
    expect(voided.state.charges).toHaveLength(0); // irrevocable NOT_STARTED from the issuing client: the only refund
    expect(run(voided.state, 4, { type: 'REPORT', clientInstanceId: 'C1', grantId: 'g-unknown', kind: 'STARTED' }).effects).toContainEqual({ kind: 'REPORT_IGNORED', grantId: 'g-unknown', reason: 'UNKNOWN_GRANT' });
  });

  it('a lost session releases nothing: a client suspended after its check starts late and is still accounted', () => {
    const r = simulate({ config: cfg, horizon: 40_000, disconnects: [{ client: 'CA', at: 100 }] }, [
      { id: 'A', client: 'CA', arrive: 0, pause: 30_000, noReceivedAck: true },
      ...range(20, (i) => ({ id: `B${i}`, arrive: 29_500 })),
    ], [25_000]);
    expect(r.states.get(25_000)!.charges.find((c) => c.grantId === 'g-A')!.latestStartMs).toBeNull();
    expect(r.starts.find((s) => s.id === 'A')!.at).toBe(30_000);
    expect(r.starts).toHaveLength(21);
    expect(burst(r)).toBeLessThanOrEqual(20);
  });

  it('a coordinator restart restores outstanding charges from the committed snapshot (no cold-start forgetting)', () => {
    const r = simulate({ config: cfg, horizon: 30_000, restartAt: 100 }, [
      { id: 'A', client: 'CA', arrive: 0, pause: 25_000 },
      ...range(20, (i) => ({ id: `B${i}`, arrive: 24_500 })),
    ], [20_000]);
    const restoredA = r.states.get(20_000)!.charges.find((c) => c.grantId === 'g-A')!;
    expect(restoredA.latestStartMs).toBeNull();
    expect(r.state.epoch).toBe('E2');
    expect(r.starts).toHaveLength(21);
    expect(burst(r)).toBeLessThanOrEqual(20);
  });

  it('a request outliving its lifetime envelope keeps its slot until COMPLETED; the overdue alert never releases it', () => {
    const r = simulate({ config: fixtureConfig({ concurrency: 1 }), horizon: 20_000 }, [
      { id: 'A', arrive: 0, duration: 15_000, lifetimeMs: 10_000 },
      { id: 'B', arrive: 1 },
    ]);
    expect(r.maxConcurrent()).toBe(1);
    expect(r.starts.find((s) => s.id === 'B')!.at).toBe(15_000);
    const overdue = r.effects.filter((e) => e.effect.kind === 'ALERT' && e.effect.code === 'SLOT_OVERDUE');
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.at).toBe(10_001);
  });

  it('a suspension that delays the start past the envelope also keeps the slot (no time-based release)', () => {
    const r = simulate({ config: fixtureConfig({ concurrency: 1 }), horizon: 20_000 }, [
      { id: 'A', client: 'CA', arrive: 0, pause: 3500, duration: 10_000 },
      { id: 'B', arrive: 1 },
    ]);
    expect(r.maxConcurrent()).toBe(1);
    expect(r.starts.map((s) => [s.id, s.at])).toEqual([['A', 3500], ['B', 13_500]]);
  });

  it('missing reports hold capacity indefinitely; termination evidence bounds the charge at the observation time', () => {
    const narrow = fixtureConfig({ windows: [{ windowMs: 1000, maxStarts: 2 }, { windowMs: 10_000, maxStarts: 200 }], uncertainChargeAlertMs: 2000 });
    const reqs = [{ id: 'A', client: 'CA', arrive: 0, pause: 100_000, crashAt: 500 }, { id: 'B1', arrive: 0 }, { id: 'B2', arrive: 10 }, { id: 'B3', arrive: 10 }];
    const without = simulate({ config: narrow, horizon: 6000 }, reqs);
    expect(without.state.charges.find((c) => c.grantId === 'g-A')!.latestStartMs).toBeNull();
    // A's unresolved charge permanently occupies one of the two burst places: B3 waits a full window behind B2's start.
    const b2Start = without.starts.find((s) => s.id === 'B2')!.at;
    expect(without.grantedAt.get('B3')).toBe(b2Start + 1000);
    expect(without.effects.filter((e) => e.effect.kind === 'ALERT' && e.effect.code === 'UNCERTAIN_CHARGE_OUTSTANDING')).toHaveLength(1);
    const withEvidence = simulate({ config: narrow, horizon: 6000, terminationEvidence: true }, reqs);
    expect(withEvidence.grantedAt.get('B3')).toBe(1500); // termination at 500 + W(1000), never earlier
    // Bounded, not released: still counted in the 10 s window (until 500 + 10000), slot torn down.
    const a = withEvidence.state.charges.find((c) => c.grantId === 'g-A')!;
    expect([a.latestStartMs, a.slotHeld]).toEqual([500, false]);
  });

  it('an empty or missing reconnect inventory releases nothing; only explicit per-grant voids release', () => {
    let s = opened();
    for (const id of ['a', 'b', 'c']) s = run(s, 0, { type: 'ENQUEUE', request: request(id, 0) }).state;
    s = run(s, 0, { type: 'PERSIST_COMMITTED', revision: s.revision }).state;
    s = run(s, 1, { type: 'SESSION_CLOSED', sessionId: 'S1' }).state;
    s = run(s, 2, { type: 'SESSION_OPENED', sessionId: 'S2', clientInstanceId: 'C1' }).state;
    const empty = run(s, 3, { type: 'INVENTORY', clientInstanceId: 'C1', used: [], voided: [] });
    expect(empty.state.charges.map((c) => [c.grantId, c.latestStartMs])).toEqual([['g-a', null], ['g-b', null], ['g-c', null]]);
    const explicit = run(empty.state, 4, { type: 'INVENTORY', clientInstanceId: 'C1', used: ['g-a'], voided: ['g-b'] });
    expect(explicit.state.charges.map((c) => [c.grantId, c.latestStartMs])).toEqual([['g-a', 4], ['g-c', null]]);
    const contradiction = run(explicit.state, 5, { type: 'INVENTORY', clientInstanceId: 'C1', used: ['g-c'], voided: ['g-c'] });
    expect(contradiction.state.charges.find((c) => c.grantId === 'g-c')!.latestStartMs).toBeNull();
    expect(contradiction.effects).toContainEqual({ kind: 'ALERT', code: 'INVENTORY_CONTRADICTION', detail: 'g-c' });
  });

  it('window boundaries are half-open: a start at t + W is not in the window of t', () => {
    const r = simulate({ config: cfg, horizon: 3000 }, [...range(20, (i) => ({ id: `A${i}`, arrive: 0 })), { id: 'B', arrive: 999 }, ...range(20, (i) => ({ id: `C${i}`, arrive: 1000 }))]);
    expect(r.starts.find((s) => s.id === 'B')!.at).toBe(1000);
    expect(burst(r)).toBe(20);
    expect(r.starts).toHaveLength(41);
  });
});

describe('M2 W1 write-ahead persistence contract', () => {
  it('a grant is delivered only after a durable commit of a snapshot that contains it', () => {
    const planned = run(run(opened(), 0, { type: 'ENQUEUE', request: request('a', 0) }).state, 0, { type: 'ADVANCE' });
    const enqueue = run(opened(), 0, { type: 'ENQUEUE', request: request('a', 0) });
    expect(kinds(enqueue.effects)).toEqual(['PERSIST']);
    const persist = enqueue.effects[0] as Extract<SchedulerEffect, { kind: 'PERSIST' }>;
    expect(persist.snapshot.charges.map((c) => [c.grantId, c.latestStartMs, c.slotHeld])).toEqual([['g-a', null, true]]);
    expect(planned.effects.some((e) => e.kind === 'DELIVER_GRANT')).toBe(false);
    expect(run(enqueue.state, 1, { type: 'PERSIST_COMMITTED', revision: persist.revision - 1 }).effects.some((e) => e.kind === 'DELIVER_GRANT')).toBe(false);
    const committed = run(enqueue.state, 1, { type: 'PERSIST_COMMITTED', revision: persist.revision });
    expect(committed.effects.filter((e) => e.kind === 'DELIVER_GRANT')).toEqual([{ kind: 'DELIVER_GRANT', grant: { epoch: 'E1', sessionId: 'S1', grantId: 'g-a', requestId: 'a', ttlMs: 2000, operation: 'READ', scope: 'API_AUTH', viaHook: false, probeGen: null } }]);
    expect(run(enqueue.state, 1, { type: 'PERSIST_COMMITTED', revision: persist.revision + 5 }).effects).toContainEqual({ kind: 'ALERT', code: 'UNKNOWN_PERSIST_REVISION', detail: String(persist.revision + 5) });
  });

  it('a failed write never delivers, fails closed, and a restore of the possibly-written snapshot holds the grant as uncertain', () => {
    const enqueue = run(opened(), 0, { type: 'ENQUEUE', request: request('a', 0) });
    const persist = enqueue.effects[0] as Extract<SchedulerEffect, { kind: 'PERSIST' }>;
    const failed = run(enqueue.state, 1, { type: 'PERSIST_FAILED', revision: persist.revision });
    expect(failed.state.unknown).toBe('PERSISTENCE_FAILED');
    expect(failed.state.charges).toHaveLength(0);
    expect(kinds(failed.effects)).not.toContain('PERSIST');
    const after = run(failed.state, 2, { type: 'ENQUEUE', request: request('b', 2) });
    expect(after.effects).toContainEqual({ kind: 'REFUSE', requestId: 'b', sessionId: 'S1', code: 'STATE_UNKNOWN' });
    expect(run(after.state, 3, { type: 'PERSIST_COMMITTED', revision: persist.revision }).effects.some((e) => e.kind === 'DELIVER_GRANT')).toBe(false);
    const restored = restoreLimiterState(cfg, persist.snapshot, 5, 'E2', null);
    expect(restored.kind).toBe('RESTORED');
    expect(restored.state.charges.map((c) => [c.grantId, c.latestStartMs, c.slotHeld])).toEqual([['g-a', null, true]]);
  });

  it('a grant planned before a 429 or a STOP is voided at commit, never delivered', () => {
    const enqueue = run(opened(), 0, { type: 'ENQUEUE', request: request('m', 0, { operation: 'CREATE' }) });
    const revision = (enqueue.effects[0] as Extract<SchedulerEffect, { kind: 'PERSIST' }>).revision;
    const stopped = run(enqueue.state, 1, { type: 'STOP' });
    const commitAfterStop = run(stopped.state, 2, { type: 'PERSIST_COMMITTED', revision });
    expect(commitAfterStop.effects.some((e) => e.kind === 'DELIVER_GRANT')).toBe(false);
    expect(commitAfterStop.state.charges).toHaveLength(0);
    const read = run(opened(), 0, { type: 'ENQUEUE', request: request('r', 0) });
    const throttled = run(read.state, 1, { type: 'THROTTLE_OBSERVED', retryAfter: { retryAfter: '30', serverDate: undefined, receiptWallMs: null, localClockTrusted: false } });
    const commitAfterBlock = run(throttled.state, 2, { type: 'PERSIST_COMMITTED', revision: (read.effects[0] as Extract<SchedulerEffect, { kind: 'PERSIST' }>).revision });
    expect(commitAfterBlock.effects.some((e) => e.kind === 'DELIVER_GRANT')).toBe(false);
  });

  it('step never mutates its input state', () => {
    const s = run(opened(), 0, { type: 'ENQUEUE', request: request('a', 0) }).state;
    const before = JSON.stringify(s);
    run(s, 1, { type: 'PERSIST_COMMITTED', revision: s.revision });
    run(s, 1, { type: 'STOP' });
    expect(JSON.stringify(s)).toBe(before);
    expect(Object.isFrozen(s)).toBe(true);
  });
});
