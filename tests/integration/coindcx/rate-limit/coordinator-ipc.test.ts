import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RateLimitClient, type AcquireRequest } from '../../../../src/integration/coindcx/rate-limit/runtime/client';
import { RateLimitCoordinator } from '../../../../src/integration/coindcx/rate-limit/runtime/coordinator';
import { encodeFrame, FrameDecoder } from '../../../../src/integration/coindcx/rate-limit/runtime/framing';
import { encodeRecord, openStateStore, SLOT_FILES, STATE_FORMAT } from '../../../../src/integration/coindcx/rate-limit/runtime/state-store';
import { cleanup, clientConfig, fixture, maxInWindow, sleep, waitFor, type Fixture } from './support';

// M2 W2 coordinator and client over real local Windows named pipes. Offline: temporary state directories,
// synthetic clients, fixture configuration. No provider, network or database access.
const running: RateLimitCoordinator[] = [];
const clients: RateLimitClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const c of running.splice(0)) await c.close();
  cleanup();
});
async function start(f: Fixture, faults: Parameters<typeof RateLimitCoordinator.start>[1] = {}): Promise<RateLimitCoordinator> {
  const result = await RateLimitCoordinator.start(f.coordinator, faults);
  if (result.kind !== 'RUNNING') throw new Error(`coordinator did not start: ${JSON.stringify(result)}`);
  running.push(result.coordinator);
  return result.coordinator;
}
async function connect(pipe: string, probeScopes: readonly ('API_AUTH' | 'PUBLIC')[] = []): Promise<RateLimitClient> {
  const c = new RateLimitClient(clientConfig(pipe, probeScopes));
  clients.push(c);
  expect(await c.connect()).toBe(true);
  return c;
}
const read = (overrides: Partial<AcquireRequest> = {}): AcquireRequest => ({ cls: 'P1', operation: 'READ', scope: 'API_AUTH', deadlineInMs: 30_000, lifetimeMs: 1000, ...overrides });
async function granted(c: RateLimitClient, request: AcquireRequest = read()) {
  const r = await c.acquire(request);
  if (r.kind !== 'GRANTED') throw new Error(`expected a grant, got ${JSON.stringify(r)}`);
  return r.permit;
}
function durable(f: Fixture): { journalSeq: number; scheduler: Record<string, unknown> } {
  const opened = openStateStore(f.dir, f.pipe, 1 << 20);
  if (opened.kind !== 'OPEN') throw new Error('state not readable');
  return opened.record as { journalSeq: number; scheduler: Record<string, unknown> };
}
/** A raw protocol peer for malformed and adversarial frames. */
async function raw(pipe: string): Promise<{ socket: net.Socket; messages: Array<Record<string, unknown>>; closed: Promise<void> }> {
  const socket = net.connect(pipe); const decoder = new FrameDecoder(65_536); const messages: Array<Record<string, unknown>> = [];
  socket.on('data', (chunk: Buffer) => { const d = decoder.push(chunk); if (d.kind === 'FRAMES') messages.push(...(d.frames as Array<Record<string, unknown>>)); });
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
  return { socket, messages, closed };
}

describe('M2 W2 coordinator: multiple clients, actual starts', () => {
  it('three clients never exceed the burst cap on measured request starts', async () => {
    const f = fixture();
    await start(f);
    const cs = await Promise.all([connect(f.pipe), connect(f.pipe), connect(f.pipe)]);
    const starts: number[] = [];
    await Promise.all(cs.map(async (c) => {
      for (let i = 0; i < 5; i++) {
        const permit = await granted(c);
        const started = permit.start(() => performance.now());
        if (started.kind !== 'STARTED') throw new Error('not started');
        starts.push(started.value);
        await permit.complete();
      }
    }));
    expect(starts).toHaveLength(15);
    expect(maxInWindow(starts, 1000)).toBeLessThanOrEqual(5);
  }, 30_000);
});

describe('M2 W2 coordinator: input validation and report binding', () => {
  it('rejects malformed frames, messages before the handshake, invalid messages and a wrong resume secret', async () => {
    const f = fixture();
    await start(f);
    const garbage = await raw(f.pipe);
    garbage.socket.write(Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from('{x}')]));
    await garbage.closed;
    expect(garbage.messages).toEqual([{ t: 'ERROR', code: 'INVALID_JSON' }]);
    const early = await raw(f.pipe);
    early.socket.write(encodeFrame({ t: 'REQUEST', ref: 'x', cls: 'P1', operation: 'READ', scope: 'API_AUTH', deadlineInMs: 1000, lifetimeMs: 1000 }, 65_536));
    await early.closed;
    expect(early.messages).toEqual([{ t: 'ERROR', code: 'HANDSHAKE_REQUIRED' }]);
    const invalid = await raw(f.pipe);
    invalid.socket.write(encodeFrame({ t: 'HELLO', v: 1, probeScopes: [], extra: true }, 65_536));
    await invalid.closed;
    expect(invalid.messages).toEqual([{ t: 'ERROR', code: 'INVALID_MESSAGE' }]);
    const legit = await connect(f.pipe);
    const forged = await raw(f.pipe);
    forged.socket.write(encodeFrame({ t: 'RESUME', v: 1, clientInstanceId: legit.clientInstanceId, resumeSecret: randomBytes(32).toString('hex'), probeScopes: [] }, 65_536));
    await forged.closed;
    expect(forged.messages).toEqual([{ t: 'ERROR', code: 'RESUME_REJECTED' }]);
  });

  it('binds reports to the issuing client, epoch and session; unknown and duplicate reports change nothing', async () => {
    const f = fixture();
    const coordinator = await start(f);
    const a = await connect(f.pipe), b = await connect(f.pipe);
    const permit = await granted(a);
    expect(await b.report(permit.grant, 'NOT_STARTED')).toEqual({ result: 'REJECTED', reason: 'BINDING_MISMATCH' });
    const otherSession = await connect(f.pipe);
    expect(await a.report({ ...permit.grant, sessionId: otherSession.session!.sessionId }, 'NOT_STARTED')).toEqual({ result: 'REJECTED', reason: 'BINDING_MISMATCH' });
    expect(await a.report({ ...permit.grant, grantId: `g${randomBytes(16).toString('hex')}` }, 'STARTED')).toEqual({ result: 'REJECTED', reason: 'UNKNOWN_GRANT' });
    expect(coordinator.state.charges.find((c) => c.grantId === permit.grant.grantId)!.latestStartMs).toBeNull();
    expect(permit.start(() => 1).kind).toBe('STARTED');
    await waitFor(() => coordinator.state.charges.find((c) => c.grantId === permit.grant.grantId)!.started, 5000, 'STARTED applied');
    expect(await a.report(permit.grant, 'STARTED')).toEqual({ result: 'IGNORED', reason: 'DUPLICATE' });
    expect(await a.report(permit.grant, 'NOT_STARTED')).toEqual({ result: 'IGNORED', reason: 'AFTER_STARTED' });
    expect(coordinator.state.charges.some((c) => c.grantId === permit.grant.grantId)).toBe(true);
    expect(coordinator.alerts.map((x) => x.code)).toEqual(expect.arrayContaining(['REPORT_BINDING_MISMATCH', 'PROTOCOL_VIOLATION']));
  });
});

describe('M2 W2 coordinator: STOP, throttle and probes (acknowledged after durable commit)', () => {
  it('STOP + 429 + successful probes of every scope: STOP survives; acknowledgements follow the durable commit', async () => {
    const f = fixture();
    const coordinator = await start(f);
    const c = await connect(f.pipe), prober = await connect(f.pipe, ['API_AUTH', 'PUBLIC']);
    const due: Array<{ scope: 'API_AUTH' | 'PUBLIC'; probeGen: number }> = [];
    prober.onProbeDue((scope, probeGen) => due.push({ scope, probeGen }));
    expect(await c.control('STOP')).toEqual({ result: 'APPLIED' });
    expect(durable(f).scheduler.admission).toBe('STOPPED'); // durable when acknowledged
    const permit = await granted(c);
    permit.start(() => 0);
    expect(await permit.reportThrottled({ retryAfter: '1' })).toEqual({ result: 'APPLIED' });
    expect(durable(f).scheduler.scopes).toEqual({ API_AUTH: 'BLOCKED', PUBLIC: 'BLOCKED' });
    await waitFor(() => c.view.blockedScopes.length === 2, 2000, 'blocked state broadcast');
    await waitFor(() => due.length === 2, 5000, 'probe announcements');
    for (const { scope, probeGen } of due) {
      const probe = await granted(prober, { cls: 'P0', operation: 'PROBE', scope, probeGen, deadlineInMs: 5000, lifetimeMs: 1000 });
      probe.start(() => 0);
      expect(await probe.reportProbe('SUCCESS')).toEqual({ result: 'APPLIED' });
      await probe.complete();
    }
    expect([coordinator.state.admission, coordinator.state.scopes.API_AUTH.kind, coordinator.state.scopes.PUBLIC.kind]).toEqual(['STOPPED', 'CLEAR', 'CLEAR']);
    expect(await c.acquire(read({ operation: 'CREATE' }))).toEqual({ kind: 'REFUSED', code: 'ADMISSION_STOPPED' });
    expect((await c.acquire(read())).kind).toBe('GRANTED');
  }, 30_000);

  it('separate scopes and probe generations: a PUBLIC success admits PUBLIC reads only; stale probes are refused or ignored', async () => {
    const f = fixture();
    const coordinator = await start(f);
    const c = await connect(f.pipe), prober = await connect(f.pipe, ['API_AUTH', 'PUBLIC']);
    const due: Array<{ scope: 'API_AUTH' | 'PUBLIC'; probeGen: number }> = [];
    prober.onProbeDue((scope, probeGen) => due.push({ scope, probeGen }));
    const first = await granted(c);
    first.start(() => 0);
    await first.reportThrottled({ retryAfter: '1' });
    await waitFor(() => due.length === 2, 5000, 'first probe generation');
    const pub = due.find((d) => d.scope === 'PUBLIC')!, auth = due.find((d) => d.scope === 'API_AUTH')!;
    const pubProbe = await granted(prober, { cls: 'P0', operation: 'PROBE', scope: 'PUBLIC', probeGen: pub.probeGen, deadlineInMs: 5000, lifetimeMs: 1000 });
    pubProbe.start(() => 0);
    await pubProbe.reportProbe('SUCCESS');
    expect((await c.acquire(read({ scope: 'PUBLIC' }))).kind).toBe('GRANTED');
    expect((await c.acquire(read({ deadlineInMs: 300 }))).kind).not.toBe('GRANTED');
    expect(await prober.acquire({ cls: 'P0', operation: 'PROBE', scope: 'API_AUTH', probeGen: pub.probeGen, deadlineInMs: 2000, lifetimeMs: 1000 })).toEqual({ kind: 'REFUSED', code: 'STALE_PROBE' });
    const authProbe = await granted(prober, { cls: 'P0', operation: 'PROBE', scope: 'API_AUTH', probeGen: auth.probeGen, deadlineInMs: 5000, lifetimeMs: 1000 });
    authProbe.start(() => 0);
    await (await granted(c, read({ scope: 'PUBLIC' }))).reportThrottled({ retryAfter: '1' }); // re-block before the probe result
    expect(await authProbe.reportProbe('SUCCESS')).toEqual({ result: 'IGNORED', reason: 'STALE_PROBE' });
    expect(coordinator.state.scopes.API_AUTH.kind).not.toBe('CLEAR');
  }, 30_000);
});

describe('M2 W2 coordinator: disconnect and restart retain uncertain capacity', () => {
  it('a disconnect releases nothing; the reconnect inventory voids only listed unused grants; active requests keep their slots', async () => {
    const f = fixture();
    const coordinator = await start(f);
    const c = await connect(f.pipe);
    const active = await granted(c), unused = await granted(c), done = await granted(c);
    active.start(() => 0);
    done.start(() => 0); await done.complete();
    const leaver = await connect(f.pipe);
    const abandoned = await granted(leaver);
    const charge = (id: string) => coordinator.state.charges.find((x) => x.grantId === id);
    await waitFor(() => charge(active.grant.grantId)?.started, 5000, 'active started');
    c.close(); leaver.close();
    await waitFor(() => coordinator.state.sessions[c.session?.sessionId ?? active.grant.sessionId]?.open === false, 5000, 'session closed');
    await sleep(500); // no release by elapsed time, TTL or orphan timeout
    expect([charge(unused.grant.grantId)?.latestStartMs, charge(unused.grant.grantId)?.slotHeld]).toEqual([null, true]);
    expect(charge(active.grant.grantId)?.slotHeld).toBe(true);
    expect(charge(abandoned.grant.grantId)?.latestStartMs).toBeNull();
    expect(await c.connect()).toBe(true); // RESUME: same instance, explicit inventory
    await waitFor(() => charge(unused.grant.grantId) === undefined, 5000, 'unused grant voided by inventory');
    expect(charge(active.grant.grantId)?.slotHeld).toBe(true);
    expect(await active.complete()).toEqual({ result: 'APPLIED' });
    expect(charge(active.grant.grantId)?.slotHeld).toBe(false);
    expect(charge(abandoned.grant.grantId)?.latestStartMs).toBeNull(); // never reconnected: still uncertain
  }, 30_000);

  it('a restart restores unresolved charges and slots and re-waits the full server bound: no early probe or ordinary grant', async () => {
    const f = fixture();
    const first = await start(f);
    const c = await connect(f.pipe);
    const active = await granted(c), unused = await granted(c);
    active.start(() => 0);
    const thrower = await granted(c);
    thrower.start(() => 0);
    expect(await thrower.reportThrottled({ retryAfter: '3' })).toEqual({ result: 'APPLIED' });
    const ackedAt = Date.now();
    await first.close(); running.splice(running.indexOf(first), 1);
    c.close();
    const restartedAt = Date.now();
    const second = await start(f);
    const charge = (id: string) => second.state.charges.find((x) => x.grantId === id);
    expect([charge(active.grant.grantId)?.started, charge(active.grant.grantId)?.slotHeld]).toEqual([true, true]);
    expect([charge(unused.grant.grantId)?.latestStartMs, charge(unused.grant.grantId)?.slotHeld]).toEqual([null, true]);
    expect(second.state.scopes.API_AUTH.kind).toBe('BLOCKED');
    const prober = await connect(f.pipe, ['API_AUTH', 'PUBLIC']);
    const due: Array<{ scope: 'API_AUTH' | 'PUBLIC'; probeGen: number; at: number }> = [];
    prober.onProbeDue((scope, probeGen) => due.push({ scope, probeGen, at: Date.now() }));
    expect(await c.connect()).toBe(true);
    const ordinary: Array<{ at: number; kind: string }> = [];
    let probesSucceededAt = Infinity;
    const poll = (async () => { while (ordinary.every((o) => o.kind !== 'GRANTED')) { const r = await c.acquire(read({ deadlineInMs: 200 })); ordinary.push({ at: Date.now(), kind: r.kind }); } })();
    await waitFor(() => due.length === 2, 10_000, 'probes after restart');
    for (const d of due) {
      const probe = await granted(prober, { cls: 'P0', operation: 'PROBE', scope: d.scope, probeGen: d.probeGen, deadlineInMs: 5000, lifetimeMs: 1000 });
      probe.start(() => 0); await probe.reportProbe('SUCCESS'); await probe.complete();
    }
    probesSucceededAt = Date.now();
    await poll;
    expect(Math.min(...due.map((d) => d.at))).toBeGreaterThanOrEqual(restartedAt + 3000); // full re-wait from restart
    expect(restartedAt + 3000).toBeGreaterThanOrEqual(ackedAt + 3000); // hence after the retained server bound
    const firstGrant = ordinary.find((o) => o.kind === 'GRANTED')!;
    expect(firstGrant.at).toBeGreaterThanOrEqual(Math.min(probesSucceededAt, ...due.map((d) => d.at)));
    expect(ordinary.filter((o) => o.at < Math.min(...due.map((d) => d.at))).every((o) => o.kind !== 'GRANTED')).toBe(true);
    expect(await c.connect()).toBe(true);
    await waitFor(() => charge(unused.grant.grantId) === undefined, 5000, 'inventory after restart voids the unused grant');
    expect(charge(active.grant.grantId)?.slotHeld).toBe(true);
  }, 40_000);
});

describe('M2 W2 coordinator: failed writes and unreadable state fail closed', () => {
  it('a failed durable write voids the planned grant (never delivered), refuses explicitly and fails closed without retry', async () => {
    const f = fixture();
    let armed = false, attempts = 0;
    const coordinator = await start(f, { store: { beforeSlotWrite: () => { if (armed) { attempts++; throw new Error('simulated write failure'); } } } });
    const c = await connect(f.pipe);
    const before = durable(f).journalSeq;
    armed = true;
    expect(await c.acquire(read())).toEqual({ kind: 'REFUSED', code: 'PERSISTENCE_FAILED' });
    expect(coordinator.state.unknown).toBe('PERSISTENCE_FAILED');
    expect(await c.acquire(read())).toEqual({ kind: 'REFUSED', code: 'STATE_UNKNOWN' });
    expect(await c.control('RESET_STOP')).toEqual({ result: 'REJECTED', reason: 'STATE_UNKNOWN' }); // no recovery from UNKNOWN in W2
    expect(attempts).toBe(1);
    expect(durable(f).journalSeq).toBe(before);
  });

  it('missing marker, corrupt slots or an unreadable scheduler snapshot: the coordinator refuses to start and overwrites nothing', async () => {
    const uninitialized = fixture(undefined, false);
    expect(await RateLimitCoordinator.start(uninitialized.coordinator)).toEqual({ kind: 'FAIL_CLOSED', reason: 'INSTALLATION_MARKER_MISSING_OR_UNREADABLE' });
    expect(fs.existsSync(uninitialized.dir)).toBe(false);
    const corrupt = fixture();
    for (const s of ['A', 'B'] as const) fs.writeFileSync(path.join(corrupt.dir, SLOT_FILES[s]), Buffer.from('torn'));
    expect(await RateLimitCoordinator.start(corrupt.coordinator)).toEqual({ kind: 'FAIL_CLOSED', reason: 'NO_VALID_SLOT_HEADER_HEADER' });
    const bad = fixture();
    const installationId = durableInstallation(bad);
    const record = encodeRecord(3, Buffer.from(JSON.stringify({ format: STATE_FORMAT, installationId, journalSeq: 3, scheduler: { not: 'a snapshot' }, clients: [] })));
    for (const s of ['A', 'B'] as const) fs.writeFileSync(path.join(bad.dir, SLOT_FILES[s]), record);
    expect(await RateLimitCoordinator.start(bad.coordinator)).toEqual({ kind: 'FAIL_CLOSED', reason: 'SCHEDULER_SNAPSHOT_UNREADABLE' });
    expect(fs.readFileSync(path.join(bad.dir, SLOT_FILES.A)).equals(record)).toBe(true);
    // The pipe is released after a fail-closed start.
    expect((await RateLimitCoordinator.start(bad.coordinator)).kind).toBe('FAIL_CLOSED');
  });
});
function durableInstallation(f: Fixture): string {
  const opened = openStateStore(f.dir, f.pipe, 1 << 20);
  if (opened.kind !== 'OPEN') throw new Error('not open');
  return opened.store.installationId;
}
