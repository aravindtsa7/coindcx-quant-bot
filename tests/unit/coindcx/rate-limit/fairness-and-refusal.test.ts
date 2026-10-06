import { describe, expect, it } from 'vitest';
import { createLimiterState, step, type BudgetRequest, type LimiterState, type SchedulerEffect, type SchedulerEvent } from '../../../../src/integration/coindcx/rate-limit';
import { fixtureConfig, range, simulate } from './harness';

// M2 W1 priority scheduling: conditional class progress and deadline refusal (design V3 §6; follow-up issue 4).
// No per-request service bound exists or is asserted.
const shares = { P0: { minPerWindow: 4, maxPerWindow: 8 }, P1: { minPerWindow: 4, maxPerWindow: 12 }, P2: { minPerWindow: 2, maxPerWindow: 6 }, P3: { minPerWindow: 1, maxPerWindow: 6 } };
const fair = fixtureConfig({ windows: [{ windowMs: 10_000, maxStarts: 20 }], fairnessWindowMs: 10_000, classShares: shares, concurrency: 8, p0ReservedSlots: 2 });

function auto(state: LimiterState, now: number, event: SchedulerEvent, sink: SchedulerEffect[]): LimiterState {
  let pending: SchedulerEvent | null = event, s = state;
  while (pending !== null) {
    const r = step(s, now, pending); s = r.state; pending = null;
    for (const e of r.effects) { sink.push(e); if (e.kind === 'PERSIST') pending = { type: 'PERSIST_COMMITTED', revision: e.revision }; }
  }
  return s;
}
const req = (id: string, overrides: Partial<BudgetRequest>): BudgetRequest => ({
  requestId: id, grantId: `g-${id}`, clientInstanceId: 'C1', sessionId: 'S1', cls: 'P1', operation: 'READ', scope: 'API_AUTH', deadlineMs: 50_000, lifetimeMs: 10_000, ...overrides,
});

describe('M2 W1 fairness: conditional class progress, explicit P0 reservation', () => {
  it('long in-flight P1 work cannot take the reserved P0 slots: P0 is granted on arrival', () => {
    const r = simulate({ config: fair, horizon: 40_000 }, [
      ...range(8, (i) => ({ id: `P1-${i}`, cls: 'P1' as const, arrive: 0, duration: 30_000 })),
      { id: 'P0', cls: 'P0', arrive: 5, deadline: 2000 },
    ]);
    expect(r.grantedAt.get('P0')).toBe(5);
    expect([...r.grantedAt].filter(([id, t]) => id.startsWith('P1') && t < 10_000)).toHaveLength(6); // C - p0Reserved
    expect(r.maxConcurrent()).toBeLessThanOrEqual(8);
  });

  it('a P0 flood is capped by its ceiling, so the P1 minimum is still served in the first window', () => {
    const r = simulate({ config: fixtureConfig({ windows: [{ windowMs: 10_000, maxStarts: 20 }], fairnessWindowMs: 10_000, classShares: shares, concurrency: 1000, p0ReservedSlots: 2 }), horizon: 30_000 }, [
      ...range(100, (i) => ({ id: `a${i}`, cls: 'P0' as const, arrive: 0 })), ...range(20, (i) => ({ id: `b${i}`, cls: 'P1' as const, arrive: 0 })),
    ]);
    const firstWindow = (prefix: string): number => [...r.grantedAt].filter(([id, t]) => id.startsWith(prefix) && t < 10_000).length;
    expect(firstWindow('a')).toBeLessThanOrEqual(8);
    expect(firstWindow('b')).toBeGreaterThanOrEqual(4);
    expect(r.maxStartsIn(10_000)).toBeLessThanOrEqual(20);
  });

  it('every queued request ends in a grant or an explicit refusal no later than its deadline (saturated FIFO)', () => {
    const reqs = [
      ...range(60, (i) => ({ id: `a${i}`, cls: 'P0' as const, arrive: 0, deadline: 100_000 })),
      ...range(60, (i) => ({ id: `b${i}`, cls: 'P1' as const, arrive: 0, deadline: 100_000 })),
      ...range(10, (i) => ({ id: `c${i}`, cls: 'P3' as const, arrive: 0, deadline: 60_000 })),
    ];
    const r = simulate({ config: fixtureConfig({ windows: [{ windowMs: 10_000, maxStarts: 20 }], fairnessWindowMs: 10_000, classShares: shares, concurrency: 1000, p0ReservedSlots: 2 }), horizon: 110_000 }, reqs);
    for (const q of reqs) {
      const granted = r.grantedAt.get(q.id), refusal = r.refusals.find((x) => x.id === q.id);
      expect((granted === undefined) !== (refusal === undefined)).toBe(true);
      if (refusal !== undefined) expect([refusal.code, refusal.at]).toEqual(['DEADLINE', q.deadline]);
      if (granted !== undefined) expect(granted).toBeLessThan(q.deadline);
    }
    expect(r.maxStartsIn(10_000)).toBeLessThanOrEqual(20);
  });

  it('uncertain charges held by suspended clients stop progress (no guarantee); refusal at the deadline still happens; progress resumes once they resolve', () => {
    const effects: SchedulerEffect[] = [];
    let s = createLimiterState(fixtureConfig({ windows: [{ windowMs: 10_000, maxStarts: 20 }], fairnessWindowMs: 10_000, classShares: shares, concurrency: 1000, p0ReservedSlots: 2 }), 0, 'E1');
    s = auto(s, 0, { type: 'SESSION_OPENED', sessionId: 'S1', clientInstanceId: 'C1' }, effects);
    // 8 P0 + 12 P1 (their ceilings) fill all 20 window places; their clients are suspended and never report.
    for (let i = 0; i < 20; i++) s = auto(s, 0, { type: 'ENQUEUE', request: req(`held${i}`, { cls: i < 8 ? 'P0' : 'P1', deadlineMs: 1000 }) }, effects);
    expect(effects.filter((e) => e.kind === 'DELIVER_GRANT')).toHaveLength(20);
    for (const [id, deadline] of [['p3-short', 50_000], ['p3-long-a', 115_000], ['p3-long-b', 115_000]] as const) s = auto(s, 0, { type: 'ENQUEUE', request: req(id, { cls: 'P3', deadlineMs: deadline }) }, effects);
    for (let t = 1000; t <= 70_000; t += 1000) s = auto(s, t, { type: 'ADVANCE' }, effects);
    expect(effects).toContainEqual({ kind: 'REFUSE', requestId: 'p3-short', sessionId: 'S1', code: 'DEADLINE' });
    expect(effects.some((e) => e.kind === 'DELIVER_GRANT' && e.grant.requestId.startsWith('p3-long'))).toBe(false);
    for (let i = 0; i < 20; i++) s = auto(s, 70_000, { type: 'REPORT', clientInstanceId: 'C1', grantId: `g-held${i}`, kind: 'STARTED' }, effects);
    for (let t = 70_000; t <= 80_000; t += 1000) s = auto(s, t, { type: 'ADVANCE' }, effects);
    const late = effects.flatMap((e) => (e.kind === 'DELIVER_GRANT' && e.grant.requestId.startsWith('p3-long') ? [e.grant.requestId] : []));
    expect(late.sort()).toEqual(['p3-long-a', 'p3-long-b']);
  });
});

describe('M2 W1 deadline refusal is evaluated when the scheduler steps (pinned limit)', () => {
  it('a blocked scope refuses at the deadline step; without a step (suspended coordinator) no refusal exists yet', () => {
    const effects: SchedulerEffect[] = [];
    let s = auto(createLimiterState(fixtureConfig(), 0, 'E1'), 0, { type: 'SESSION_OPENED', sessionId: 'S1', clientInstanceId: 'C1' }, effects);
    s = auto(s, 0, { type: 'THROTTLE_OBSERVED', retryAfter: { retryAfter: '600', serverDate: undefined, receiptWallMs: null, localClockTrusted: false } }, effects);
    s = auto(s, 1, { type: 'ENQUEUE', request: req('r', { deadlineMs: 30_000 }) }, effects);
    expect(effects.some((e) => e.kind === 'REFUSE')).toBe(false);
    // The process was suspended from 1 to 45,000: the refusal is produced at the first step after resumption, not at 30,000.
    const resumed: SchedulerEffect[] = [];
    auto(s, 45_000, { type: 'ADVANCE' }, resumed);
    expect(resumed).toContainEqual({ kind: 'REFUSE', requestId: 'r', sessionId: 'S1', code: 'DEADLINE' });
  });

  it('every request needs a finite deadline within the cap; invalid requests are refused, never queued', () => {
    const effects: SchedulerEffect[] = [];
    let s = auto(createLimiterState(fixtureConfig(), 1000, 'E1'), 1000, { type: 'SESSION_OPENED', sessionId: 'S1', clientInstanceId: 'C1' }, effects);
    for (const [id, deadlineMs] of [['past', 1000], ['too-far', 1000 + 120_001], ['infinite', Infinity], ['fraction', 1500.5]] as const) s = auto(s, 1000, { type: 'ENQUEUE', request: req(id, { deadlineMs }) }, effects);
    s = auto(s, 1000, { type: 'ENQUEUE', request: req('wrong-session', { sessionId: 'S9' }) }, effects);
    s = auto(s, 1000, { type: 'ENQUEUE', request: req('public-create', { operation: 'CREATE', scope: 'PUBLIC' }) }, effects);
    expect(effects.flatMap((e) => (e.kind === 'REFUSE' ? [[e.requestId, e.code]] : []))).toEqual([
      ['past', 'INVALID_DEADLINE'], ['too-far', 'INVALID_DEADLINE'], ['infinite', 'INVALID_DEADLINE'], ['fraction', 'INVALID_DEADLINE'],
      ['wrong-session', 'SESSION_INVALID'], ['public-create', 'INVALID_REQUEST'],
    ]);
    expect(s.queue).toHaveLength(0);
  });
});
