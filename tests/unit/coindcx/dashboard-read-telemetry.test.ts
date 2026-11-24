import { describe, expect, it, vi } from 'vitest';
import { observeReadBudget } from '../../../scripts/practical-read-telemetry';
import { disciplinedPermit, type ReadBudget } from '../../../src/integration/coindcx/rate-limit/runtime/read-budget';

function fixture() {
  let time = 1000;
  const complete = vi.fn(), release = vi.fn(), throttled = vi.fn();
  const delegate: ReadBudget = { acquire: async () => ({ kind: 'GRANTED', permit: disciplinedPermit({ start: create => ({ kind: 'STARTED', value: create() }), complete, release, throttled }) }) };
  return { ...observeReadBudget(delegate, () => time), advance: (ms: number) => { time += ms; }, complete, release, throttled };
}
describe('Dashboard read telemetry', () => {
  it('measures actual starts/completions by scope without changing permit identity or factory results', async () => {
    const f = fixture(), acquired = await f.budget.acquire({ scope: 'PUBLIC', lifetimeMs: 1000 });
    expect(acquired.kind).toBe('GRANTED'); if (acquired.kind !== 'GRANTED') return;
    const response = { resource: true };
    expect(acquired.permit.start(() => response)).toEqual({ kind: 'STARTED', value: response });
    expect(f.stats()).toMatchObject({ started: 1, inFlight: 1, pending: 0, scopes: { PUBLIC: { started: 1 }, API_AUTH: { started: 0 } } });
    f.advance(40); acquired.permit.complete(); acquired.permit.complete();
    expect(f.complete).toHaveBeenCalledOnce();
    expect(f.stats()).toMatchObject({ completed: 1, inFlight: 0, latencies: [{ durationMs: 40, scope: 'PUBLIC' }] });
  });
  it('never starts a refused or released permit or invents a traffic point', async () => {
    const refused = observeReadBudget({ acquire: async () => ({ kind: 'REFUSED', reason: 'STOPPED' }) }, () => 1000);
    expect(await refused.budget.acquire({ scope: 'API_AUTH', lifetimeMs: 100 })).toEqual({ kind: 'REFUSED', reason: 'STOPPED' });
    expect(refused.stats()).toMatchObject({ refused: 1, started: 0, pending: 0, traffic: [] });
    const f = fixture(), p = await f.budget.acquire({ scope: 'PUBLIC', lifetimeMs: 100 }); if (p.kind !== 'GRANTED') return;
    p.permit.release(); const create = vi.fn(); expect(p.permit.start(create).kind).toBe('NOT_STARTED'); expect(create).not.toHaveBeenCalled();
    expect(f.stats().traffic).toEqual([]);
  });
  it('retains started uncertainty after a throwing factory and forwards throttle evidence unchanged', async () => {
    const f = fixture(), p = await f.budget.acquire({ scope: 'API_AUTH', lifetimeMs: 100 }); if (p.kind !== 'GRANTED') return;
    expect(() => p.permit.start(() => { throw new Error('uncertain start'); })).toThrow('uncertain start');
    const headers = { retryAfter: '7' }; p.permit.throttled(headers);
    expect(f.throttled).toHaveBeenCalledWith(headers); expect(f.stats()).toMatchObject({ started: 1, inFlight: 1, completed: 0 });
  });
  it('bounds traffic samples and returns isolated snapshots', async () => {
    const f = fixture();
    for (let i = 0; i < 130; i++) { const p = await f.budget.acquire({ scope: 'PUBLIC', lifetimeMs: 100 }); if (p.kind === 'GRANTED') { p.permit.start(() => null); f.advance(1); p.permit.complete(); } }
    const snapshot = f.stats(); expect(snapshot.traffic).toHaveLength(120); expect(snapshot.latencies).toHaveLength(120);
    snapshot.scopes.PUBLIC.started = -1; snapshot.traffic.length = 0;
    expect(f.stats().scopes.PUBLIC.started).toBe(130); expect(f.stats().traffic).toHaveLength(120);
  });
});
