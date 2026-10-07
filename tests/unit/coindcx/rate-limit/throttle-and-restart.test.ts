import { describe, expect, it } from 'vitest';
import {
  createLimiterState, restoreLimiterState, step,
  type BudgetRequest, type LimiterSnapshot, type LimiterState, type RetryAfterContext, type SchedulerEffect, type SchedulerEvent,
} from '../../../../src/integration/coindcx/rate-limit';
import { fixtureConfig } from './harness';

// M2 W1 operator STOP vs throttle, Retry-After, restart recovery (design V3 §3, §5; follow-up issues 2 and 3).
const cfg = fixtureConfig();
const RECEIPT = Date.parse('Tue, 06 Oct 2026 00:00:00 GMT');
const TEN_MINUTES = ['Tue, 06 Oct 2026 00:10:00 GMT', 'Tuesday, 06-Oct-26 00:10:00 GMT', 'Tue Oct  6 00:10:00 2026'];
type Persist = Extract<SchedulerEffect, { kind: 'PERSIST' }>;

interface Driver { state: LimiterState; effects: SchedulerEffect[]; snapshot: LimiterSnapshot | null; send(now: number, event: SchedulerEvent): readonly SchedulerEffect[] }
/** Applies events with auto-committed persistence; collects every effect. */
function driver(state: LimiterState): Driver {
  const d: Driver = {
    state, effects: [], snapshot: null,
    send(now, event) {
      const out: SchedulerEffect[] = [];
      let pending: SchedulerEvent | null = event;
      while (pending !== null) {
        const result = step(d.state, now, pending); d.state = result.state; pending = null;
        for (const effect of result.effects) { out.push(effect); if (effect.kind === 'PERSIST') { d.snapshot = effect.snapshot; pending = { type: 'PERSIST_COMMITTED', revision: effect.revision }; } }
      }
      d.effects.push(...out);
      return out;
    },
  };
  return d;
}
function fresh(): Driver {
  const d = driver(createLimiterState(cfg, 0, 'E1'));
  d.send(0, { type: 'SESSION_OPENED', sessionId: 'S1', clientInstanceId: 'C1' });
  return d;
}
const req = (id: string, now: number, overrides: Partial<BudgetRequest> = {}): BudgetRequest => ({
  requestId: id, grantId: `g-${id}`, clientInstanceId: 'C1', sessionId: 'S1', cls: 'P1', operation: 'READ', scope: 'API_AUTH', deadlineMs: now + 100_000, lifetimeMs: 10_000, ...overrides,
});
const ra = (retryAfter: string | undefined, overrides: Partial<RetryAfterContext> = {}): RetryAfterContext => ({ retryAfter, serverDate: undefined, receiptWallMs: RECEIPT, localClockTrusted: true, ...overrides });
const delivered = (effects: readonly SchedulerEffect[]): string[] => effects.flatMap((e) => (e.kind === 'DELIVER_GRANT' ? [e.grant.requestId] : []));
const refused = (effects: readonly SchedulerEffect[]): Array<[string, string]> => effects.flatMap((e) => (e.kind === 'REFUSE' ? [[e.requestId, e.code] as [string, string]] : []));
const probeDue = (effects: readonly SchedulerEffect[]) => effects.flatMap((e) => (e.kind === 'PROBE_DUE' ? [e] : []));
const blockedUntil = (s: LimiterState): number[] => (['API_AUTH', 'PUBLIC'] as const).map((scope) => { const t = s.scopes[scope]; return t.kind === 'BLOCKED' ? t.notBeforeMs : -1; });

/** Probes every scope as soon as it is due; records probe grant times and the first ordinary grant time. */
function recover(d: Driver, from: number, until: number, serverEnd: number): { probes: number[]; firstOrdinary: number | null } {
  const probes: number[] = []; let firstOrdinary: number | null = null; let n = 0;
  d.send(from, { type: 'ENQUEUE', request: req(`ord-${from}`, from, { deadlineMs: from + 100_000 }) });
  for (let t = from; t <= until && firstOrdinary === null; t += 1000) {
    const out = d.send(t, { type: 'ADVANCE' });
    for (const due of [...probeDue(out), ...probeDue(d.effects.slice(0, 0))]) {
      const id = `probe-${n++}`;
      const granted = d.send(t, { type: 'ENQUEUE', request: req(id, t, { operation: 'PROBE', scope: due.scope, probeGen: due.probeGen, cls: 'P0' }) });
      if (delivered(granted).includes(id)) probes.push(t);
      if (t >= serverEnd) d.send(t, { type: 'PROBE_RESULT', scope: due.scope, probeGen: due.probeGen, outcome: 'SUCCESS' });
      else d.send(t, { type: 'THROTTLE_OBSERVED', retryAfter: ra(String(Math.ceil((serverEnd - t) / 1000))) });
    }
    if (d.state.scopes.API_AUTH.kind === 'CLEAR' && d.state.scopes.PUBLIC.kind === 'CLEAR') {
      const id = `ord-${t}-x`;
      if (delivered(d.send(t, { type: 'ENQUEUE', request: req(id, t) })).includes(id)) firstOrdinary = t;
    }
  }
  return { probes, firstOrdinary };
}

describe('M2 W1 operator STOP is orthogonal to the throttle', () => {
  it('STOP survives a 429 and a successful probe of every scope; reads resume, mutations stay refused', () => {
    const d = fresh();
    d.send(0, { type: 'STOP' });
    d.send(1, { type: 'THROTTLE_OBSERVED', retryAfter: ra('20') });
    expect(d.state.admission).toBe('STOPPED');
    const due = probeDue(d.send(20_001, { type: 'ADVANCE' }));
    expect(due.map((p) => p.scope)).toEqual(['API_AUTH', 'PUBLIC']);
    for (const p of due) d.send(20_001, { type: 'PROBE_RESULT', scope: p.scope, probeGen: p.probeGen, outcome: 'SUCCESS' });
    expect(d.state.admission).toBe('STOPPED');
    expect(refused(d.send(20_002, { type: 'ENQUEUE', request: req('create', 20_002, { operation: 'CREATE' }) }))).toEqual([['create', 'ADMISSION_STOPPED']]);
    expect(delivered(d.send(20_003, { type: 'ENQUEUE', request: req('read', 20_003) }))).toEqual(['read']);
  });

  it('a hook cancel gets budget while stopped only with the registered token; other mutations are refused and revoked', () => {
    const d = fresh();
    const token = {};
    d.send(0, { type: 'ENQUEUE', request: req('create', 0, { operation: 'CREATE' }) });
    expect(delivered(d.effects)).toEqual(['create']);
    const stop = d.send(1, { type: 'STOP' });
    expect(stop).toContainEqual({ kind: 'REVOKE', sessionId: 'S1', grantIds: ['g-create'] });
    expect(d.state.charges.find((c) => c.grantId === 'g-create')).toBeDefined(); // held until NOT_STARTED arrives
    expect(refused(d.send(2, { type: 'ENQUEUE', request: req('c1', 2, { operation: 'CANCEL' }) }))).toEqual([['c1', 'ADMISSION_STOPPED']]);
    // No registered hook (always so in production until M6): a caller-supplied token is CANCELLATION_HOOK_ABSENT (V3 R2-05).
    expect(refused(d.send(3, { type: 'ENQUEUE', request: req('c2', 3, { operation: 'CANCEL', hookToken: {} }) }))).toEqual([['c2', 'CANCELLATION_HOOK_ABSENT']]);
    d.send(4, { type: 'HOOK_REGISTERED', token });
    expect(refused(d.send(5, { type: 'ENQUEUE', request: req('c4', 5, { operation: 'CANCEL', hookToken: {} }) }))).toEqual([['c4', 'HOOK_TOKEN_MISMATCH']]);
    expect(delivered(d.send(5, { type: 'ENQUEUE', request: req('c3', 5, { operation: 'CANCEL', hookToken: token }) }))).toEqual(['c3']);
    expect(refused(d.send(6, { type: 'ENQUEUE', request: req('r', 6, { hookToken: token }) }))).toEqual([['r', 'INVALID_REQUEST']]);
  });

  it('RESET_STOP while throttled opens only the latch; mutations still wait for every scope to clear', () => {
    const d = fresh();
    d.send(0, { type: 'STOP' });
    d.send(1, { type: 'THROTTLE_OBSERVED', retryAfter: ra('20') });
    d.send(2, { type: 'RESET_STOP' });
    expect(d.state.admission).toBe('OPEN');
    expect(delivered(d.send(3, { type: 'ENQUEUE', request: req('create', 3, { operation: 'CREATE' }) }))).toEqual([]);
    const due = probeDue(d.send(20_001, { type: 'ADVANCE' }));
    d.send(20_001, { type: 'PROBE_RESULT', scope: 'PUBLIC', probeGen: due.find((p) => p.scope === 'PUBLIC')!.probeGen, outcome: 'SUCCESS' });
    // A public probe success is a scoped observation: only PUBLIC reads resume; API_AUTH reads and every mutation wait.
    expect(d.state.scopes.API_AUTH.kind).toBe('PROBING');
    d.send(20_002, { type: 'ENQUEUE', request: req('public-read', 20_002, { scope: 'PUBLIC' }) });
    d.send(20_002, { type: 'ENQUEUE', request: req('auth-read', 20_002) });
    expect(delivered(d.effects)).toEqual(['public-read']);
    d.send(20_003, { type: 'PROBE_RESULT', scope: 'API_AUTH', probeGen: due.find((p) => p.scope === 'API_AUTH')!.probeGen, outcome: 'SUCCESS' });
    expect(delivered(d.effects)).toContain('create');
  });

  it('a stale probe result is ignored; a failed probe re-blocks with local backoff; a 429 revokes unstarted grants', () => {
    const d = fresh();
    d.send(0, { type: 'ENQUEUE', request: req('r', 0) });
    expect(d.send(1, { type: 'THROTTLE_OBSERVED', retryAfter: ra('20') })).toContainEqual({ kind: 'REVOKE', sessionId: 'S1', grantIds: ['g-r'] });
    const due = probeDue(d.send(20_001, { type: 'ADVANCE' }));
    expect(d.send(20_002, { type: 'PROBE_RESULT', scope: 'PUBLIC', probeGen: 999, outcome: 'SUCCESS' })).toContainEqual({ kind: 'ALERT', code: 'STALE_PROBE_RESULT', detail: 'PUBLIC#999' });
    d.send(20_003, { type: 'PROBE_RESULT', scope: 'API_AUTH', probeGen: due[0]!.probeGen, outcome: 'FAILED' });
    expect(d.state.scopes.API_AUTH).toEqual({ kind: 'BLOCKED', notBeforeMs: 20_003 + 30_000 }); // backoff 15 s x 2^1
  });
});

describe('M2 W1 Retry-After: three HTTP-date forms; never a 60 s fallback for a stated bound', () => {
  it.each(TEN_MINUTES)('%s at receipt Tue, 06 Oct 2026 00:00:00 GMT blocks every scope for 602,000 ms (trusted clock)', (value) => {
    const d = fresh();
    const out = d.send(1000, { type: 'THROTTLE_OBSERVED', retryAfter: ra(value) });
    expect(blockedUntil(d.state)).toEqual([1000 + 602_000, 1000 + 602_000]);
    expect(out).toContainEqual({ kind: 'ALERT', code: 'WAIT_EXCEEDS_OPERATIONAL_CAP', detail: '602000' }); // alert only
  });

  it.each(TEN_MINUTES)('%s with an untrusted local clock 9 min fast uses the server Date header: 602,000 ms', (value) => {
    const d = fresh();
    d.send(0, { type: 'THROTTLE_OBSERVED', retryAfter: ra(value, { localClockTrusted: false, receiptWallMs: RECEIPT + 540_000, serverDate: 'Tue, 06 Oct 2026 00:00:00 GMT' }) });
    expect(blockedUntil(d.state)).toEqual([602_000, 602_000]);
  });

  it.each(TEN_MINUTES)('%s with neither a trusted clock nor a Date header fails closed (UNKNOWN), never 60 s', (value) => {
    const d = fresh();
    const out = d.send(0, { type: 'THROTTLE_OBSERVED', retryAfter: ra(value, { localClockTrusted: false }) });
    expect(d.state.unknown).toBe('RETRY_AFTER_UNBOUNDED');
    expect(out).toContainEqual(expect.objectContaining({ kind: 'ALERT', code: 'DATE_CONVERSION_UNCERTAIN' }));
    expect(delivered(d.send(70_000, { type: 'ENQUEUE', request: req('r', 70_000) }))).toEqual([]);
    expect(probeDue(d.send(700_000, { type: 'ADVANCE' }))).toEqual([]);
  });

  it('absent header -> the 60 s default; present but unparseable -> fail closed; a later shorter bound never moves the deadline back', () => {
    const absent = fresh();
    absent.send(0, { type: 'THROTTLE_OBSERVED', retryAfter: ra(undefined) });
    expect(blockedUntil(absent.state)).toEqual([60_000, 60_000]);
    const garbled = fresh();
    garbled.send(0, { type: 'THROTTLE_OBSERVED', retryAfter: ra('soon') });
    expect(garbled.state.unknown).toBe('RETRY_AFTER_UNBOUNDED');
    const late = fresh();
    late.send(10_000, { type: 'THROTTLE_OBSERVED', retryAfter: ra('90') });
    late.send(50_000, { type: 'THROTTLE_OBSERVED', retryAfter: ra('5') });
    expect(blockedUntil(late.state)).toEqual([100_000, 100_000]);
  });
});

describe('M2 W1 restart recovery: full re-wait, no wall clock, no early probe or ordinary start', () => {
  function blockedSnapshot(retryAfter: RetryAfterContext): LimiterSnapshot {
    const d = fresh();
    d.send(0, { type: 'THROTTLE_OBSERVED', retryAfter });
    return d.snapshot!;
  }

  it('Retry-After 600, restart 1 s later on a fresh monotonic clock: probes and ordinary grants wait the full 600 s from restart', () => {
    const snapshot = blockedSnapshot(ra('600'));
    // The new process's monotonic clock starts near zero; true elapsed since the 429 is 1000 ms.
    const restoredAt = 7, trueOffset = 1000 - restoredAt;
    const restored = restoreLimiterState(cfg, snapshot, restoredAt, 'E2', null);
    expect(restored.kind).toBe('RESTORED');
    expect(blockedUntil(restored.state)).toEqual([restoredAt + 600_000, restoredAt + 600_000]);
    const d = driver(restored.state);
    d.send(restoredAt, { type: 'SESSION_OPENED', sessionId: 'S1', clientInstanceId: 'C1' });
    const seen = recover(d, restoredAt, restoredAt + 700_000, 600_000 - trueOffset);
    expect(seen.probes.length).toBeGreaterThan(0);
    for (const t of [...seen.probes, seen.firstOrdinary!]) expect(t + trueOffset).toBeGreaterThanOrEqual(600_000);
  });

  it('wall-clock jumps forward or backward cannot shorten the restored wait (restore takes no wall clock at all)', () => {
    const snapshot = blockedSnapshot(ra('600'));
    for (const restoredAt of [0, 5, 1_000_000_000]) {
      const restored = restoreLimiterState(cfg, snapshot, restoredAt, 'E2', null);
      expect(blockedUntil(restored.state)).toEqual([restoredAt + 600_000, restoredAt + 600_000]);
    }
    // The date form, converted once at receipt with a trusted clock, is persisted as a relative wait and re-waited in full.
    const dated = blockedSnapshot(ra('Tue Oct  6 00:10:00 2026'));
    expect(dated.blocks).toEqual([{ receivedAtMs: 0, fullWaitMs: 602_000, form: 'ASCTIME' }]);
    expect(JSON.stringify(dated)).not.toMatch(/Wall|wall/);
    expect(blockedUntil(restoreLimiterState(cfg, dated, 3, 'E2', null).state)).toEqual([602_003, 602_003]);
  });

  it('same-boot elapsed evidence shortens the re-wait exactly to the retained bound, never below it', () => {
    const snapshot = blockedSnapshot(ra('600'));
    const restoredAt = 50, elapsedSinceSnapshot = 1000;
    const restored = restoreLimiterState(cfg, snapshot, restoredAt, 'E2', { kind: 'SAME_BOOT_ELAPSED', elapsedSinceSnapshotMs: elapsedSinceSnapshot });
    expect(blockedUntil(restored.state)).toEqual([restoredAt + 599_000, restoredAt + 599_000]);
    const d = driver(restored.state);
    d.send(restoredAt, { type: 'SESSION_OPENED', sessionId: 'S1', clientInstanceId: 'C1' });
    const trueOffset = elapsedSinceSnapshot - restoredAt;
    const seen = recover(d, restoredAt, restoredAt + 700_000, 600_000 - trueOffset);
    for (const t of [...seen.probes, seen.firstOrdinary!]) expect(t + trueOffset).toBeGreaterThanOrEqual(600_000);
  });

  it('restores STOP exactly, never the hook, and keeps started charges conservatively at the restore time', () => {
    const d = fresh();
    const token = {};
    d.send(0, { type: 'HOOK_REGISTERED', token });
    d.send(0, { type: 'ENQUEUE', request: req('a', 0) });
    d.send(10, { type: 'REPORT', clientInstanceId: 'C1', grantId: 'g-a', kind: 'STARTED' });
    d.send(20, { type: 'STOP' });
    const restored = restoreLimiterState(cfg, d.snapshot, 5, 'E2', null);
    expect(restored.state.admission).toBe('STOPPED');
    expect(restored.state.hookToken).toBeNull();
    expect(restored.state.charges.map((c) => [c.grantId, c.latestStartMs, c.started])).toEqual([['g-a', 5, true]]);
    const r2 = driver(restored.state);
    r2.send(5, { type: 'SESSION_OPENED', sessionId: 'S9', clientInstanceId: 'C1' });
    // The persisted `started` flag survives restore: a later NOT_STARTED is a protocol violation and releases nothing.
    const late = r2.send(6, { type: 'REPORT', clientInstanceId: 'C1', grantId: 'g-a', kind: 'NOT_STARTED' });
    expect(late).toContainEqual({ kind: 'REPORT_IGNORED', grantId: 'g-a', reason: 'AFTER_STARTED' });
    expect(late).toContainEqual({ kind: 'ALERT', code: 'PROTOCOL_VIOLATION', detail: 'NOT_STARTED after STARTED g-a' });
    expect(r2.state.charges.map((c) => c.grantId)).toEqual(['g-a']);
  });

  it.each([
    ['missing file', undefined], ['garbage', 'not json'], ['wrong format', { format: 'x' }],
  ])('an unreadable snapshot (%s) restores STOPPED/UNKNOWN with no grants and refuses RESET_STOP', (_label, persisted) => {
    const restored = restoreLimiterState(cfg, persisted, 0, 'E2', null);
    expect(restored.kind).toBe('UNREADABLE');
    expect([restored.state.admission, restored.state.unknown]).toEqual(['STOPPED', 'SNAPSHOT_UNREADABLE']);
    const d = driver(restored.state);
    expect(d.send(1, { type: 'RESET_STOP' })).toContainEqual({ kind: 'ALERT', code: 'RESET_REFUSED_STATE_UNKNOWN', detail: 'SNAPSHOT_UNREADABLE' });
    d.send(1, { type: 'SESSION_OPENED', sessionId: 'S1', clientInstanceId: 'C1' });
    expect(refused(d.send(2, { type: 'ENQUEUE', request: req('r', 2) }))).toEqual([['r', 'STATE_UNKNOWN']]);
  });

  it('rejects inconsistent snapshots: extra keys, a reused epoch, a blocked scope without a block record', () => {
    const d = fresh();
    d.send(0, { type: 'THROTTLE_OBSERVED', retryAfter: ra('30') });
    const good = d.snapshot!;
    expect(restoreLimiterState(cfg, good, 0, 'E2', null).kind).toBe('RESTORED');
    expect(restoreLimiterState(cfg, { ...good, extra: 1 }, 0, 'E2', null).kind).toBe('UNREADABLE');
    expect(restoreLimiterState(cfg, good, 0, 'E1', null).kind).toBe('UNREADABLE');
    expect(restoreLimiterState(cfg, { ...good, blocks: [] }, 0, 'E2', null).kind).toBe('UNREADABLE');
  });

  it('a monotonic clock that moves backwards fails closed', () => {
    const d = fresh();
    d.send(100, { type: 'ADVANCE' });
    const out = d.send(50, { type: 'ADVANCE' });
    expect(d.state.unknown).toBe('CLOCK_REGRESSION');
    expect(out).toContainEqual({ kind: 'ALERT', code: 'CLOCK_REGRESSION', detail: 'now 50 < last 100' });
  });

  it('the PERSIST effect precedes the delivery of any grant planned after a block record change', () => {
    const d = fresh();
    const first = step(d.state, 0, { type: 'THROTTLE_OBSERVED', retryAfter: ra('20') });
    expect(first.effects.find((e): e is Persist => e.kind === 'PERSIST')!.snapshot.blocks).toHaveLength(1);
  });
});
