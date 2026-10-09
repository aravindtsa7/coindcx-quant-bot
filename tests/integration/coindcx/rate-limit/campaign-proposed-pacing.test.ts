import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { CoinDcxClient } from '../../../../src/integration/coindcx/client';
import { RateLimitCoordinator } from '../../../../src/integration/coindcx/rate-limit/runtime/coordinator';
import { RateLimitClient } from '../../../../src/integration/coindcx/rate-limit/runtime/client';
import { createCoordinatorReadBudget } from '../../../../src/integration/coindcx/rate-limit/runtime/read-budget';
import { startCampaignHost } from '../../../../scripts/sync-read-launch/campaign-host';
import { clientCampaignAccess } from '../../../../scripts/sync-read-launch/campaign-access';
import { hostFixture, fixtureProposal, connection, venue, proposed, saveEvidence, IDENTITY } from './campaign-bootstrap-support';
import { waitFor, sleep, recordHttpRequestCreations, maxInWindow } from './support';

const hosts: Array<Awaited<ReturnType<typeof startCampaignHost>>> = [];
const running: RateLimitCoordinator[] = [], peers: RateLimitClient[] = [];
const venues: Array<Awaited<ReturnType<typeof venue>>> = [];
const timers: ReturnType<typeof setInterval>[] = [];
let restoreRecording: (() => void) | undefined;
afterEach(async () => { restoreRecording?.(); restoreRecording = undefined; timers.splice(0).forEach(clearInterval); peers.splice(0).forEach(p => p.close());
  for (const h of hosts.splice(0)) await h.close(); for (const c of running.splice(0)) await c.close(); for (const v of venues.splice(0)) await v.close(); }, 30000);
async function direct(f: ReturnType<typeof hostFixture>) {
  const result = await RateLimitCoordinator.start(f.cfg.coordinator);
  if (result.kind !== 'RUNNING') throw Error('M2 coordinator refused'); running.push(result.coordinator); return result.coordinator;
}
async function peer(f: ReturnType<typeof hostFixture>) { const p = new RateLimitClient(f.cfg.client); peers.push(p); expect(await p.connect()).toBe(true); return p; }
function client(p: RateLimitClient, origin: string, cls: 'P0' | 'P1') {
  return new CoinDcxClient({ ...connection(origin), baseUrl: origin, timeoutMs: 10000,
    readBudget: { budget: createCoordinatorReadBudget(p, { cls, deadlineInMs: 5000 }), scope: 'API_AUTH' } });
}
function record() { const rec = recordHttpRequestCreations(); restoreRecording = rec.restore; return rec.times; }

describe('unapproved proposed limiter: real M2 IPC and actual loopback request creations', () => {
  it('paces a complete two-pass evaluation, sends one combined status filter and refuses the fourteenth P1 request', async () => {
    const f = hostFixture(), h = await startCampaignHost(f.cfg, f.keys); hosts.push(h);
    const heartbeat = setInterval(() => h.heartbeat(), 100); timers.push(heartbeat);
    const v = await venue(); venues.push(v); const times = record();
    const p = fixtureProposal(h.provenance.connectionId, f.cfg.reportDirectory); // All campaign numeric values unchanged.
    expect(p.configuration.campaign).toEqual(proposed().configuration.campaign);
    const run = h.run(p, connection(v.origin));
    await waitFor(() => v.hits.length === 13, 25000, 'thirteen actual campaign reads');
    const read = new RateLimitClient(f.cfg.client, clientCampaignAccess(f.cfg.installationId, 'READ', f.keys.read)); peers.push(read); expect(await read.connect()).toBe(true);
    const before = performance.now(); const refused = await read.acquire({ cls: 'P1', operation: 'READ', scope: 'API_AUTH', deadlineInMs: 5000, lifetimeMs: 10000 });
    const refusalMs = performance.now() - before;
    expect(refused.kind).not.toBe('GRANTED'); expect(refusalMs).toBeGreaterThanOrEqual(4900); expect(refusalMs).toBeLessThan(6500); expect(times).toHaveLength(13);
    clearInterval(heartbeat); timers.splice(timers.indexOf(heartbeat), 1);
    await h.stop(); const outcome = await run;
    expect(outcome.report.stopReason).toBe('CANCELLED'); expect(outcome.report.evaluations).toHaveLength(1);
    expect(maxInWindow(times, 1000)).toBeLessThanOrEqual(2); expect(maxInWindow(times, 60000)).toBe(13);
    const orders = v.hits.filter(hit => hit.path.endsWith('/orders')), positions = v.hits.filter(hit => hit.path.endsWith('/positions'));
    expect(v.hits[0]!.path).toBe('/exchange/v1/users/info'); expect(orders).toHaveLength(8); expect(positions).toHaveLength(4);
    expect(orders.every(hit => hit.body['status'] === p.configuration.scope.orderStatuses.join(','))).toBe(true);
    for (const side of ['buy', 'sell']) for (const page of ['1', '2']) expect(orders.filter(hit => hit.body['side'] === side && hit.body['page'] === page)).toHaveLength(2);
    expect(outcome.report.evaluations[0]!.stream.observation).toBe('UNKNOWN'); expect(Object.values(outcome.report.grants).every(v => v === false)).toBe(true);
    saveEvidence('proposed-p1-pacing.json', { valuesStatus: 'PROPOSED_NOT_APPROVED', campaignNumericValuesUnchanged: true, stoppedAfterFirstEvaluation: true,
      actualRequestCreationTimesMs: times, requests: v.hits, maxStarts1000Ms: maxInWindow(times, 1000), maxStarts60000Ms: maxInWindow(times, 60000),
      fourteenthAcquisition: refused, refusalMs, additionalHttpRequestsOnRefusal: 0, statusFilterConstruction: 'ONE_COMBINED_FILTER_PER_SIDE_PAGE', providerFilterAcceptance: 'UNCONFIRMED' });
  }, 40_000);

  it('preserves P0 concurrency and enforces 20 starts in a real 60-second sliding window, then admits after expiry', async () => {
    const f = hostFixture(), coordinator = await direct(f), p1 = await peer(f), p0 = await peer(f);
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const v = await venue(() => held.then(() => ({ status: 200, body: { coindcx_id: IDENTITY } }))); venues.push(v);
    const times = record(), one = client(p1, v.origin, 'P1'), zero = client(p0, v.origin, 'P0');
    const first = [one.getUserInfoSafe(), one.getUserInfoSafe()];
    await waitFor(() => times.length === 2);
    const queued = one.getUserInfoSafe().then(() => null, error => error);
    const urgent = zero.getUserInfoSafe(); await waitFor(() => times.length === 3);
    expect(coordinator.state.charges.filter(c => c.slotHeld && c.cls === 'P1')).toHaveLength(2);
    expect(coordinator.state.charges.filter(c => c.slotHeld && c.cls === 'P0')).toHaveLength(1);
    expect(coordinator.state.charges.filter(c => c.slotHeld)).toHaveLength(3);
    const refused = await queued; expect(refused).not.toBeNull(); expect(times).toHaveLength(3);
    release(); await Promise.all([...first, urgent]);
    // Additional P0 lab load fills the shared minute cap. This is a stress test, not an extra campaign scope.
    for (let i = 0; i < 17; i++) await zero.getUserInfoSafe();
    expect(times).toHaveLength(20);
    const before = performance.now(); await expect(zero.getUserInfoSafe()).rejects.toThrow(/budget refused/i);
    const globalRefusalMs = performance.now() - before;
    expect(globalRefusalMs).toBeGreaterThanOrEqual(4900); expect(times).toHaveLength(20);
    expect(maxInWindow(times, 1000)).toBeLessThanOrEqual(2); expect(maxInWindow(times, 60000)).toBe(20);
    const elapsed = performance.timeOrigin + performance.now() - times[0]!;
    if (elapsed < 60500) await sleep(60500 - elapsed);
    await zero.getUserInfoSafe(); expect(times).toHaveLength(21);
    expect(maxInWindow(times, 1000)).toBeLessThanOrEqual(2); expect(maxInWindow(times, 60000)).toBeLessThanOrEqual(20);
    saveEvidence('proposed-global-pacing.json', { valuesStatus: 'PROPOSED_NOT_APPROVED', mode: 'LOOPBACK_LAB_LOAD_NOT_CAMPAIGN',
      limiterConfiguration: f.cfg.coordinator.limiter, actualRequestCreationTimesMs: times,
      maxStarts1000Ms: maxInWindow(times, 1000), maxStarts60000Ms: maxInWindow(times, 60000), p0ReservedConcurrencyObserved: { P1: 2, P0: 1, total: 3 },
      saturationHttpRequestsCreated: 0, globalRefusalMs, minuteExpiryReadAdmitted: true });
  }, 95_000);

  it('reports 429 through the real coordinator, stops collection and starts no fallback request', async () => {
    const f = hostFixture(), h = await startCampaignHost(f.cfg, f.keys); hosts.push(h); timers.push(setInterval(() => h.heartbeat(), 100));
    const v = await venue(url => url.endsWith('/users/info') ? { status: 200, body: { coindcx_id: IDENTITY } }
      : url.endsWith('/orders') ? { status: 429, body: {}, headers: { 'retry-after': '1' } } : { status: 200, body: [] }); venues.push(v);
    const times = record(); const result = await h.run(fixtureProposal(h.provenance.connectionId, f.cfg.reportDirectory), connection(v.origin));
    expect(['PROVIDER_THROTTLE_OBSERVED', 'BUDGET_UNAVAILABLE']).toContain(result.report.stopReason);
    const before = times.length; await sleep(200); expect(times).toHaveLength(before); expect(before).toBeLessThanOrEqual(3);
    expect(result.report.observations.convergedEvaluations).toBe(0);
    saveEvidence('proposed-429-results.json', { stopReason: result.report.stopReason, actualRequestCreationTimesMs: times, fallbackRequests: 0, grants: result.report.grants });
  }, 30_000);

  it('coordinator disconnect refuses pending admission without an HTTP start and keeps active charges uncertain', async () => {
    const f = hostFixture(), c = await direct(f), p = await peer(f);
    const grants = await Promise.all([p.acquire({ cls: 'P1', operation: 'READ', scope: 'API_AUTH', deadlineInMs: 5000, lifetimeMs: 10000 }),
      p.acquire({ cls: 'P1', operation: 'READ', scope: 'API_AUTH', deadlineInMs: 5000, lifetimeMs: 10000 })]);
    expect(grants.every(g => g.kind === 'GRANTED')).toBe(true);
    const v = await venue(); venues.push(v); const times = record(); const read = client(p, v.origin, 'P1').getUserInfoSafe().then(() => null, error => error);
    await sleep(50); await c.close(); running.splice(running.indexOf(c), 1);
    expect(await read).toMatchObject({ message: expect.stringMatching(/budget refused/i) }); expect(times).toHaveLength(0); expect(c.state.charges.filter(g => g.slotHeld)).toHaveLength(2);
    saveEvidence('proposed-disconnect-results.json', { requestCreations: times, admissionRefused: true, outstandingChargesHeld: 2, capacityRefunded: false });
  }, 30_000);
});
