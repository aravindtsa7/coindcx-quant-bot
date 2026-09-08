import { afterEach, describe, expect, it } from 'vitest';
import { isPhase5Eligible } from '../../../src/market-data/higher-timeframe';
import { CanonicalHealthState } from '../../../src/market-data/types';
import { M, P, T, barrier, setup, update } from './audit-a1-helpers';

const MAX_SOURCE_AGE_MS = 120_000;
const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });

function context(now: number) {
  const c = setup(now);
  stops.push(() => c.engine.stop());
  return c;
}

function expectHealth(c: ReturnType<typeof setup>, state: CanonicalHealthState) {
  const health = c.engine.getPairHealth(P);
  expect(health?.state).toBe(state);
  expect(isPhase5Eligible(health)).toBe(state === 'HEALTHY');
  expect(health?.truthFault).toBe('NONE');
}

describe('Audit A1 A-F06 source freshness excludes every future timestamp', () => {
  it.each([
    [-MAX_SOURCE_AGE_MS, 'STALE'], // Preserve the existing expiry at age >= threshold.
    [-MAX_SOURCE_AGE_MS + 1, 'HEALTHY'],
    [-1, 'HEALTHY'],
    [0, 'HEALTHY'],
    [1, 'STALE'],
    [4999, 'STALE'],
    [5000, 'STALE'],
    [5001, 'DEGRADED'],
  ] as const)('source offset %i yields %s and matching Phase6 eligibility', async (offset, state) => {
    const now = T + 3 * M + 30_000;
    const source = now + offset;
    const open = Math.floor(source / M) * M;
    const c = context(now);
    await c.engine.initializePair(P);
    await c.engine.handleStreamEnvelope({ ...update(open, 1, { providerEventTimeMs: source }), receivedAtMs: now });
    expectHealth(c, state);
    const health = c.engine.getPairHealth(P);
    expect(health?.lastValidProviderEventTimeMs).toBe(state === 'HEALTHY' ? source : null);
    expect(health?.lastValidReceivedAtMs).toBe(state === 'HEALTHY' ? now : null);
    // Tolerated skew is accepted as working evidence, not classified as malformed.
    expect(health?.workingOpenTimeMs).toBe(offset <= 5000 ? open : null);
  });

  it('empty startup and no-evidence timeout remain ineligible', async () => {
    const c = context(T);
    await c.engine.initializePair(P);
    expectHealth(c, 'STALE');
    c.clock.advance(MAX_SOURCE_AGE_MS); c.scheduler.advanceTime(MAX_SOURCE_AGE_MS);
    expectHealth(c, 'STALE');
  });

  it.each([
    ['old packet received now', -599_999, 'STALE'],
    ['current source', 0, 'HEALTHY'],
    ['future +1ms', 1, 'STALE'],
    ['future at max skew', 5000, 'STALE'],
  ] as const)('timed-out STALE plus %s (offset %i) yields %s', async (_label, offset, state) => {
    const c = context(T + 1000);
    await c.engine.handleStreamEnvelope(update(T));
    expectHealth(c, 'HEALTHY');
    c.clock.advance(10 * M); c.scheduler.advanceTime(10 * M);
    expectHealth(c, 'STALE');
    const now = c.clock.nowMs();
    await c.engine.handleStreamEnvelope({ ...update(T, 1, { providerEventTimeMs: now + offset }, 2), receivedAtMs: now });
    expectHealth(c, state);
    expect(c.engine.getPairHealth(P)?.lastValidProviderEventTimeMs).toBe(state === 'HEALTHY' ? now : T + 1000);
  });

  it.each([1, 4999, 5000])('accepted future +%ims also makes an already healthy pair ineligible', async offset => {
    const c = context(T + 1000);
    await c.engine.handleStreamEnvelope(update(T));
    expectHealth(c, 'HEALTHY');
    await c.engine.handleStreamEnvelope(update(T, 1, { providerEventTimeMs: c.clock.nowMs() + offset }, 2));
    expectHealth(c, 'STALE');
    expect(c.engine.getPairHealth(P)?.lastValidProviderEventTimeMs).toBe(T + 1000);
  });

  it.each([1, 5000])('future +%ims cannot complete an empty reconnect handoff', async offset => {
    const c = context(T + 1000);
    await c.engine.handleStreamEnvelope(update(T));
    await c.engine.handleStreamEnvelope(barrier());
    const before = c.engine.getPairHealth(P);
    await c.engine.handleStreamEnvelope(update(T, 2, { providerEventTimeMs: c.clock.nowMs() + offset }));
    expectHealth(c, 'RECOVERING');
    expect(c.engine.getPairHealth(P)?.recoveryRequired).toBe(true);
    expect(c.engine.getPairHealth(P)?.recoveryEpoch).toBe(before?.recoveryEpoch);
    expect(c.engine.getPairHealth(P)?.lastValidProviderEventTimeMs).toBeNull();
    expect(c.repository.insertCalls).toHaveLength(0);
    await c.engine.handleStreamEnvelope(update(T, 2));
    expectHealth(c, 'HEALTHY');
    expect(c.engine.getPairHealth(P)?.recoveryRequired).toBe(false);
  });

  it('catching up and timer passage cannot heal tolerated future evidence; a new current update can', async () => {
    const c = context(T + 1000);
    const future = T + 6000;
    await c.engine.handleStreamEnvelope(update(T, 1, { providerEventTimeMs: future }));
    expectHealth(c, 'STALE');
    c.clock.advance(5000); c.scheduler.advanceTime(5000);
    expectHealth(c, 'STALE');
    // An identical duplicate remains a duplicate, not accepted forward progress.
    await c.engine.handleStreamEnvelope(update(T, 1, { providerEventTimeMs: future }, 2));
    expectHealth(c, 'STALE');
    c.clock.advance(MAX_SOURCE_AGE_MS); c.scheduler.advanceTime(MAX_SOURCE_AGE_MS);
    expectHealth(c, 'STALE');
    expect(c.engine.getPairHealth(P)?.lastValidProviderEventTimeMs).toBeNull();
    await c.engine.handleStreamEnvelope(update(T, 1, { providerEventTimeMs: c.clock.nowMs() }, 3));
    expectHealth(c, 'HEALTHY');
  });
});
