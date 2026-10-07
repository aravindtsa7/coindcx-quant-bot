import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CoinDcxOrderMutationTransport } from '../../../../src/integration/coindcx/live/mutation-transport';
import { CANCELLATION_HOOK_ABSENT, engageAdmissionStop, killSwitchCancellationStatus } from '../../../../src/integration/coindcx/rate-limit/runtime/admission-stop';
import { RateLimitClient } from '../../../../src/integration/coindcx/rate-limit/runtime/client';
import { RateLimitCoordinator } from '../../../../src/integration/coindcx/rate-limit/runtime/coordinator';
import { encodeFrame, FrameDecoder } from '../../../../src/integration/coindcx/rate-limit/runtime/framing';
import { consumeMutationPermit, createCoordinatorMutationBudget, type MutationBudget, type MutationPermit } from '../../../../src/integration/coindcx/rate-limit/runtime/mutation-budget';
import { attachReadProbeResponder, type ReadProbeOutcome } from '../../../../src/integration/coindcx/rate-limit/runtime/read-probe';
import { createCoordinatorReadBudget } from '../../../../src/integration/coindcx/rate-limit/runtime/read-budget';
import { CoinDcxTransport } from '../../../../src/integration/coindcx/transport';
import { cleanup, clientConfig, fixture, limiterFixture, sleep, waitFor, type Fixture } from './support';

// M2 W6 (M10A): the admission-stop interlock over the shared coordinator. Named-pipe IPC, loopback HTTP servers,
// temporary state directories, synthetic credentials. No provider, external network or database access.
const stops: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); cleanup(); });

interface Loopback { url: string; hits: number; handler: (req: http.IncomingMessage, res: http.ServerResponse) => void }
async function loopback(): Promise<Loopback> {
  const state: Loopback = { url: '', hits: 0, handler: (req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }); } };
  const server = http.createServer((req, res) => { state.hits += 1; state.handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stops.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return state;
}
async function coordinator(f: Fixture, faults: Parameters<typeof RateLimitCoordinator.start>[1] = {}): Promise<RateLimitCoordinator> {
  const started = await RateLimitCoordinator.start(f.coordinator, faults);
  if (started.kind !== 'RUNNING') throw new Error(JSON.stringify(started));
  stops.push(() => started.coordinator.close());
  return started.coordinator;
}
async function client(pipe: string, probeScopes: readonly ('API_AUTH' | 'PUBLIC')[] = []): Promise<RateLimitClient> {
  const c = new RateLimitClient(clientConfig(pipe, probeScopes));
  stops.push(() => c.close());
  expect(await c.connect()).toBe(true);
  return c;
}
async function grant(budget: MutationBudget, operation: 'CREATE' | 'CANCEL'): Promise<MutationPermit> {
  const acquired = await budget.acquire({ operation, lifetimeMs: 5000 });
  if (acquired.kind !== 'GRANTED') throw new Error(`expected a grant: ${acquired.reason}`);
  return acquired.permit;
}
const mutationTransport = (url: string) => new CoinDcxOrderMutationTransport({ apiKey: 'synthetic-w6-key', apiSecret: 'synthetic-w6-secret', baseUrl: url });
const tracked = <T>(promise: Promise<T>) => { const t = { settled: false, value: undefined as T | undefined }; void promise.then((v) => { t.settled = true; t.value = v; }); return t; };

describe('M2 W6 admission stop: local latch before the durable acknowledgement', () => {
  it('stops mutations while admission waits and while grants are outstanding; local refusal precedes the acknowledgement; reads continue', async () => {
    const f = fixture(limiterFixture({ concurrency: 1 }));
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const budget = createCoordinatorMutationBudget(c, { cls: 'P0', deadlineInMs: 10_000 });
    const outstanding = await grant(budget, 'CREATE'); // granted, unused: holds the only slot
    const waiting = budget.acquire({ operation: 'CANCEL', lifetimeMs: 5000 }); // waits for the slot
    await sleep(100);
    const localStops: string[] = [];
    const engagement = engageAdmissionStop({ localStops: [{ requestStop: () => { localStops.push('practical'); return { kind: 'ADMISSION_CLOSED' }; } }], limiter: c, ackTimeoutMs: 5000 });
    const report = tracked(engagement.report);
    // Synchronously latched, before any acknowledgement is awaited.
    expect(engagement.local).toEqual({ admissionStops: ['ADMISSION_CLOSED'], limiterLatch: 'LATCHED' });
    expect(localStops).toEqual(['practical']);
    expect(c.stopStatus.localLatch).toBe(true);
    expect(consumeMutationPermit(outstanding, 'CREATE')).toEqual({ kind: 'REFUSED', reason: 'PERMIT_ALREADY_VOIDED' }); // voided at the latch
    const fresh = budget.acquire({ operation: 'CREATE', lifetimeMs: 5000 });
    expect(await fresh).toEqual({ kind: 'REFUSED', reason: 'LOCAL_STOP' });
    expect(await waiting).toEqual({ kind: 'REFUSED', reason: 'LOCAL_STOP' });
    expect(report.settled).toBe(false); // the coordinator round trip has not completed yet
    expect(await engagement.report).toEqual({ local: engagement.local, coordinatorStop: { kind: 'DURABLE' }, cancellation: CANCELLATION_HOOK_ABSENT });
    expect(coord.state.admission).toBe('STOPPED');
    expect(c.stopStatus).toEqual({ localLatch: true, coordinator: 'DURABLE' });
    // Reads keep their eligibility under STOP.
    const read = await createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 5000 }).acquire({ scope: 'API_AUTH', lifetimeMs: 1000 });
    expect(read.kind).toBe('GRANTED');
    if (read.kind === 'GRANTED') read.permit.release();
    await waitFor(() => coord.state.charges.length === 0, 5000, 'voided grants refunded');
  }, 30_000);

  it('no HTTP from refused mutations; requests already started keep their definite or ambiguous outcomes and are not resent', async () => {
    const f = fixture();
    await coordinator(f);
    const c = await client(f.pipe);
    const budget = createCoordinatorMutationBudget(c, { cls: 'P0', deadlineInMs: 5000 });
    const api = await loopback();
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    api.handler = (req, res) => { req.resume(); req.on('end', () => { void held.then(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"message":"success","status":200,"code":200}'); }); }); };
    const definite = mutationTransport(api.url).execute('CANCEL_ORDER', { timestamp: 1, id: 'x' }, 5000, await grant(budget, 'CANCEL'));
    await waitFor(() => api.hits === 1, 5000, 'first request started');
    const engagement = engageAdmissionStop({ localStops: [], limiter: c, ackTimeoutMs: 5000 });
    release();
    expect(await definite).toMatchObject({ kind: 'RESPONSE', statusCode: 200 }); // definite stays definite
    expect((await engagement.report).coordinatorStop).toEqual({ kind: 'DURABLE' });
    expect(await budget.acquire({ operation: 'CREATE', lifetimeMs: 1000 })).toEqual({ kind: 'REFUSED', reason: 'LOCAL_STOP' });
    expect(await mutationTransport(api.url).execute('CREATE_ORDER', { timestamp: 1 }, 2000, null)).toEqual({ kind: 'PRE_DISPATCH', reasonCode: 'BUDGET_REFUSED' });
    expect(api.hits).toBe(1);
    // An ambiguous in-flight request stays ambiguous under STOP (separate client, granted before its STOP).
    const other = await client(f.pipe);
    expect((await other.control('RESET_STOP')).result).toBe('APPLIED'); // coordinator latch only; c's local latch stays
    await waitFor(() => other.view.admission === 'OPEN', 5000, 'coordinator reopened for the second client');
    api.handler = (req) => { req.resume(); req.on('end', () => { setTimeout(() => req.socket.destroy(), 100); }); };
    const ambiguous = mutationTransport(api.url).execute('CANCEL_ORDER', { timestamp: 1, id: 'y' }, 5000, await grant(createCoordinatorMutationBudget(other, { cls: 'P0', deadlineInMs: 5000 }), 'CANCEL'));
    await waitFor(() => api.hits === 2, 5000, 'second request started');
    const second = engageAdmissionStop({ localStops: [], limiter: other, ackTimeoutMs: 5000 });
    expect(await ambiguous).toMatchObject({ kind: 'UNESTABLISHED' });
    expect((await second.report).coordinatorStop).toEqual({ kind: 'DURABLE' });
    await sleep(200);
    expect(api.hits).toBe(2); // no automatic resend
    expect(c.stopStatus.localLatch).toBe(true);
  }, 30_000);
});

describe('M2 W6 admission stop: separate from throttle; durable acknowledgement only', () => {
  it('STOP + 429 + successful probe: the throttle clears, mutations stay stopped, reads resume', async () => {
    const f = fixture(limiterFixture({ retryAfter: { noHeaderDefaultMs: 3000, providerStatedBlockMs: 500, localBackoffBaseMs: 500, localBackoffMaxMs: 2000, operationalCapMs: 600_000, clockUncertaintyMs: 100 } }));
    const coord = await coordinator(f);
    const operator = await client(f.pipe);
    expect((await engageAdmissionStop({ localStops: [], limiter: operator, ackTimeoutMs: 5000 }).report).coordinatorStop).toEqual({ kind: 'DURABLE' });
    const worker = await client(f.pipe); // no local latch: proves the coordinator-level STOP
    const api = await loopback();
    api.handler = (_req, res) => { res.writeHead(429, { 'retry-after': '1' }); res.end('{}'); };
    const reads = new CoinDcxTransport({ baseUrl: api.url, readBudget: { budget: createCoordinatorReadBudget(worker, { cls: 'P1', deadlineInMs: 5000 }), scope: 'API_AUTH' } });
    await reads.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' }).catch(() => undefined);
    await waitFor(() => coord.state.scopes.API_AUTH.kind !== 'CLEAR', 5000, 'throttled');
    api.handler = (_req, res) => { res.writeHead(200); res.end('{}'); };
    const executor = { probe: (): Promise<ReadProbeOutcome> => new Promise((resolve) => {
      const req = http.get(`${api.url}/probe`, (res) => { res.resume(); });
      req.on('close', () => resolve({ kind: 'SUCCESS' })); req.on('error', () => resolve({ kind: 'FAILED' }));
    }) };
    attachReadProbeResponder(await client(f.pipe, ['API_AUTH', 'PUBLIC']), executor, { deadlineInMs: 5000, lifetimeMs: 1000 });
    await waitFor(() => coord.state.scopes.API_AUTH.kind === 'CLEAR' && coord.state.scopes.PUBLIC.kind === 'CLEAR', 15_000, 'throttle cleared by probes');
    expect(coord.state.admission).toBe('STOPPED'); // a successful probe never reopens mutation admission
    expect(await createCoordinatorMutationBudget(worker, { cls: 'P0', deadlineInMs: 2000 }).acquire({ operation: 'CANCEL', lifetimeMs: 1000 })).toEqual({ kind: 'REFUSED', reason: 'ADMISSION_STOPPED' });
    expect((await reads.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' })).status).toBe(200);
  }, 40_000);

  it('a failed STOP persistence is never reported as an acknowledged stop; the local latch holds and the coordinator fails closed', async () => {
    const f = fixture();
    let armed = false;
    const coord = await coordinator(f, { store: { beforeSlotWrite: () => { if (armed) throw new Error('simulated write failure'); } } });
    const c = await client(f.pipe);
    const worker = await client(f.pipe); // connected before the fault (a new handshake would itself need a commit)
    armed = true;
    const engagement = engageAdmissionStop({ localStops: [], limiter: c, ackTimeoutMs: 5000 });
    expect(await engagement.report).toMatchObject({ coordinatorStop: { kind: 'NOT_ACKNOWLEDGED', reason: 'REJECTED', detail: 'PERSISTENCE_FAILED' } });
    expect(c.stopStatus).toEqual({ localLatch: true, coordinator: 'REJECTED' });
    expect(coord.state.unknown).toBe('PERSISTENCE_FAILED'); // every grant now refused (fail closed)
    expect(await createCoordinatorMutationBudget(worker, { cls: 'P0', deadlineInMs: 2000 }).acquire({ operation: 'CREATE', lifetimeMs: 1000 })).toEqual({ kind: 'REFUSED', reason: 'STATE_UNKNOWN' });
  }, 30_000);

  it('coordinator unavailable, disconnect and restart: never a false acknowledgement; the queued STOP becomes durable after reconnection and survives restart', async () => {
    const f = fixture();
    const first = await RateLimitCoordinator.start(f.coordinator);
    if (first.kind !== 'RUNNING') throw new Error(JSON.stringify(first));
    const c = await client(f.pipe);
    await first.coordinator.close();
    await waitFor(() => c.session === null, 5000, 'client saw the disconnect');
    const engagement = engageAdmissionStop({ localStops: [], limiter: c, ackTimeoutMs: 5000 });
    expect(await engagement.report).toMatchObject({ coordinatorStop: { kind: 'NOT_ACKNOWLEDGED', reason: 'NOT_CONNECTED' } });
    expect(c.stopStatus).toEqual({ localLatch: true, coordinator: 'PENDING' });
    // Restart on the same durable state and pipe; the client's outbox re-sends the queued STOP.
    const second = await coordinator(f);
    expect(second.state.admission).toBe('OPEN'); // STOP never reached the coordinator before
    expect(await c.connect()).toBe(true);
    await waitFor(() => second.state.admission === 'STOPPED', 5000, 'queued STOP applied after reconnection');
    await waitFor(() => c.stopStatus.coordinator === 'DURABLE', 5000, 'late durable acknowledgement recorded');
    // Disconnect while an acknowledgement is outstanding: reported as not acknowledged, never success.
    const d = await client(f.pipe);
    const racing = engageAdmissionStop({ localStops: [], limiter: d, ackTimeoutMs: 5000 });
    d.close();
    expect(await racing.report).toMatchObject({ coordinatorStop: { kind: 'NOT_ACKNOWLEDGED', reason: 'DISCONNECTED' } });
    await second.close();
    const third = await coordinator(f);
    expect(third.state.admission).toBe('STOPPED'); // durable STOP restored on restart
  }, 30_000);
});

/** A scripted coordinator for ordering cases: it welcomes sessions and records CONTROL frames; acknowledgements are sent only on cue. */
async function scriptedCoordinator(pipe: string) {
  const hex = (prefix: string, n: number): string => `${prefix}${n.toString(16).padStart(32, '0')}`;
  const controls: Array<{ session: number; ackId: string; action: 'STOP' | 'RESET_STOP' }> = [];
  const others: string[] = [];
  let current: net.Socket | null = null; let sessions = 0;
  const server = net.createServer((socket) => {
    current = socket; const decoder = new FrameDecoder(65_536);
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      const out = decoder.push(chunk);
      if (out.kind !== 'FRAMES') return;
      for (const frame of out.frames as Array<Record<string, unknown>>) {
        if (frame.t === 'HELLO' || frame.t === 'RESUME') {
          sessions += 1;
          socket.write(encodeFrame({ t: 'WELCOME', epoch: hex('e', 1), sessionId: hex('s', sessions), clientInstanceId: hex('c', 1), ...(frame.t === 'HELLO' ? { resumeSecret: 'a'.repeat(64) } : {}), state: { admission: 'OPEN', blockedScopes: [], unknown: false } }, 65_536));
        } else if (frame.t === 'CONTROL') controls.push({ session: sessions, ackId: String(frame.ackId), action: frame.action as 'STOP' | 'RESET_STOP' });
        else others.push(String(frame.t));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(pipe, () => resolve()));
  stops.push(() => new Promise<void>((resolve) => { current?.destroy(); server.close(() => resolve()); }));
  return {
    controls, others,
    at: (index: number): { ackId: string; action: string } => { const m = controls[index]; if (m === undefined) throw new Error(`no control ${index}`); return m; },
    ack: (ackId: string, result: 'APPLIED' | 'REJECTED' = 'APPLIED'): void => { current?.write(encodeFrame({ t: 'ACK', ackId, result }, 65_536)); },
    drop: (): void => { current?.destroy(); },
  };
}
const mutationRequest = { cls: 'P0', operation: 'CREATE', scope: 'API_AUTH', deadlineInMs: 1000, lifetimeMs: 1000 } as const;

describe('M2 W6 admission stop: edge cases (closeout)', () => {
  it('a throwing local stop: the limiter latch still engages synchronously, every other local stop is attempted, and failures are reported apart from the durable acknowledgement', async () => {
    const f = fixture();
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const calls: string[] = [];
    const engagement = engageAdmissionStop({
      localStops: [
        { requestStop: () => { calls.push('first'); throw new Error('simulated local stop failure'); } },
        { requestStop: () => { calls.push('second'); return { kind: 'ADMISSION_CLOSED' }; } },
        { get requestStop(): () => unknown { calls.push('third'); throw new Error('simulated accessor failure'); } },
        { requestStop: () => { calls.push('fourth'); throw 'non-error value'; } },
      ],
      limiter: c, ackTimeoutMs: 5000,
    });
    // Settled synchronously, before anything is awaited.
    expect(calls).toEqual(['first', 'second', 'third', 'fourth']);
    expect(engagement.local).toEqual({ admissionStops: ['STOP_FAILED', 'ADMISSION_CLOSED', 'STOP_FAILED', 'STOP_FAILED'], limiterLatch: 'LATCHED' });
    expect(c.stopStatus.localLatch).toBe(true);
    expect(await c.acquire(mutationRequest)).toEqual({ kind: 'REFUSED', code: 'LOCAL_STOP' });
    // The local failures are reported separately; the coordinator acknowledgement is its own (durable) result.
    expect(await engagement.report).toEqual({ local: engagement.local, coordinatorStop: { kind: 'DURABLE' }, cancellation: CANCELLATION_HOOK_ABSENT });
    expect(coord.state.admission).toBe('STOPPED');
    // A failed local stop with no durable acknowledgement is not success either.
    const offline = new RateLimitClient(clientConfig(f.pipe)); stops.push(() => offline.close());
    const unacknowledged = engageAdmissionStop({ localStops: [{ requestStop: () => { throw new Error('simulated'); } }], limiter: offline, ackTimeoutMs: 5000 });
    expect(unacknowledged.local).toEqual({ admissionStops: ['STOP_FAILED'], limiterLatch: 'LATCHED' });
    expect((await unacknowledged.report).coordinatorStop).toEqual({ kind: 'NOT_ACKNOWLEDGED', reason: 'NOT_CONNECTED' });
    expect(await offline.acquire(mutationRequest)).toEqual({ kind: 'REFUSED', code: 'LOCAL_STOP' });
  }, 30_000);

  it('RESET_STOP pending when a newer STOP is requested: the delayed reset acknowledgement never clears the newer latch', async () => {
    const f = fixture();
    const fake = await scriptedCoordinator(f.pipe);
    const c = await client(f.pipe);
    const first = c.requestStop(5000);
    await waitFor(() => fake.controls.length === 1, 5000, 'first STOP sent');
    fake.ack(fake.at(0).ackId);
    expect(await first.acknowledgement).toEqual({ kind: 'DURABLE' });
    const reset = c.control('RESET_STOP');
    await waitFor(() => fake.controls.length === 2, 5000, 'reset sent');
    const newer = c.requestStop(5000); // requested while the reset acknowledgement is held back
    await waitFor(() => fake.controls.length === 3, 5000, 'newer STOP sent');
    expect(fake.controls.map((m) => m.action)).toEqual(['STOP', 'RESET_STOP', 'STOP']);
    fake.ack(fake.at(1).ackId); // the older reset is acknowledged after the newer STOP latched
    expect((await reset).result).toBe('APPLIED');
    expect(c.stopStatus).toEqual({ localLatch: true, coordinator: 'PENDING' }); // the earlier durable STOP was reset; the newer one is not yet durable
    expect(await c.acquire(mutationRequest)).toEqual({ kind: 'REFUSED', code: 'LOCAL_STOP' });
    expect(fake.others).not.toContain('REQUEST'); // refused locally, no IPC
    fake.ack(fake.at(2).ackId);
    expect(await newer.acknowledgement).toEqual({ kind: 'DURABLE' });
    expect(c.stopStatus).toEqual({ localLatch: true, coordinator: 'DURABLE' });
    // A reset sent after the newest STOP still clears the latch (existing behaviour is unchanged).
    const current = c.control('RESET_STOP');
    await waitFor(() => fake.controls.length === 4, 5000, 'current reset sent');
    fake.ack(fake.at(3).ackId);
    expect((await current).result).toBe('APPLIED');
    expect(c.stopStatus).toEqual({ localLatch: false, coordinator: 'NONE' });
  }, 30_000);

  it('RESET_STOP pending when a newer STOP is requested: reconnect replay of both keeps the newer latch (scripted and real coordinator)', async () => {
    const f = fixture();
    const fake = await scriptedCoordinator(f.pipe);
    const c = await client(f.pipe);
    const first = c.requestStop(5000);
    await waitFor(() => fake.controls.length === 1, 5000, 'first STOP sent');
    fake.ack(fake.at(0).ackId);
    expect(await first.acknowledgement).toEqual({ kind: 'DURABLE' });
    const reset = c.control('RESET_STOP');
    await waitFor(() => fake.controls.length === 2, 5000, 'reset sent');
    fake.drop(); // the reset's acknowledgement is lost with the connection
    await waitFor(() => c.session === null, 5000, 'client saw the disconnect');
    const newer = c.requestStop(5000);
    expect(await newer.acknowledgement).toEqual({ kind: 'NOT_ACKNOWLEDGED', reason: 'NOT_CONNECTED' }); // never a false acknowledgement
    expect(await c.connect()).toBe(true);
    // The outbox replays the unacknowledged reset, then the newer STOP, in order.
    await waitFor(() => fake.controls.filter((m) => m.session === 2).length === 2, 5000, 'replayed controls');
    const replayed = fake.controls.filter((m) => m.session === 2);
    expect(replayed.map((m) => [m.ackId, m.action])).toEqual([[fake.at(1).ackId, 'RESET_STOP'], [fake.at(3).ackId, 'STOP']]);
    fake.ack(fake.at(2).ackId); // the replayed reset
    expect((await reset).result).toBe('APPLIED');
    expect(c.stopStatus).toEqual({ localLatch: true, coordinator: 'PENDING' });
    expect(await c.acquire(mutationRequest)).toEqual({ kind: 'REFUSED', code: 'LOCAL_STOP' });
    fake.ack(fake.at(3).ackId); // the replayed newer STOP
    await waitFor(() => c.stopStatus.coordinator === 'DURABLE', 5000, 'late durable acknowledgement of the newer STOP');
    expect(c.stopStatus.localLatch).toBe(true);

    // The same ordering through the real coordinator and a restart: both queued while disconnected, replayed after reconnection.
    const g = fixture();
    const before = await RateLimitCoordinator.start(g.coordinator);
    if (before.kind !== 'RUNNING') throw new Error(JSON.stringify(before));
    const d = await client(g.pipe);
    expect((await d.control('STOP')).result).toBe('APPLIED');
    await before.coordinator.close();
    await waitFor(() => d.session === null, 5000, 'client saw the coordinator stop');
    const queuedReset = d.control('RESET_STOP');
    const queuedStop = d.requestStop(5000);
    expect(await queuedStop.acknowledgement).toEqual({ kind: 'NOT_ACKNOWLEDGED', reason: 'NOT_CONNECTED' });
    const after = await coordinator(g);
    expect(after.state.admission).toBe('STOPPED'); // durable STOP restored on restart
    expect(await d.connect()).toBe(true);
    expect((await queuedReset).result).toBe('APPLIED');
    await waitFor(() => d.stopStatus.coordinator === 'DURABLE', 5000, 'replayed STOP applied after the replayed reset');
    expect(after.state.admission).toBe('STOPPED');
    expect(d.stopStatus.localLatch).toBe(true);
    expect(await d.acquire(mutationRequest)).toEqual({ kind: 'REFUSED', code: 'LOCAL_STOP' });
  }, 30_000);
});

describe('M2 W6 cancellation hook: absent, not forgeable', () => {
  it('reports CANCELLATION_HOOK_ABSENT; caller-supplied hook fields or tokens grant nothing', async () => {
    expect(killSwitchCancellationStatus()).toBe('CANCELLATION_HOOK_ABSENT');
    const f = fixture();
    const coord = await coordinator(f);
    const operator = await client(f.pipe);
    let hookCalls = 0;
    const forged = { localStops: [], limiter: operator, ackTimeoutMs: 5000, cancellationHook: { cancelOutstanding: async () => { hookCalls++; } }, viaHook: true };
    const engagement = engageAdmissionStop(forged as Parameters<typeof engageAdmissionStop>[0]);
    expect(engagement.cancellation).toBe(CANCELLATION_HOOK_ABSENT);
    expect((await engagement.report).cancellation).toBe(CANCELLATION_HOOK_ABSENT);
    expect(hookCalls).toBe(0);
    const worker = await client(f.pipe);
    const flagged = { operation: 'CANCEL', lifetimeMs: 1000, viaHook: true, hookToken: {} } as unknown as { operation: 'CANCEL'; lifetimeMs: number };
    expect(await createCoordinatorMutationBudget(worker, { cls: 'P0', deadlineInMs: 2000 }).acquire(flagged)).toEqual({ kind: 'REFUSED', reason: 'ADMISSION_STOPPED' });
    expect(await worker.acquire({ cls: 'P0', operation: 'CANCEL', scope: 'API_AUTH', deadlineInMs: 2000, lifetimeMs: 1000, viaHook: true } as never)).toEqual({ kind: 'REFUSED', code: 'ADMISSION_STOPPED' });
    // A raw IPC request carrying a hook field is a protocol violation: the coordinator closes the session.
    const socket = net.connect(f.pipe); stops.push(() => { socket.destroy(); });
    const decoder = new FrameDecoder(65_536); const frames: Array<{ t: string }> = [];
    socket.on('data', (chunk: Buffer) => { const out = decoder.push(chunk); if (out.kind === 'FRAMES') frames.push(...(out.frames as Array<{ t: string }>)); });
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(encodeFrame({ t: 'HELLO', v: 1, probeScopes: [] }, 65_536));
    await waitFor(() => frames.some((m) => m.t === 'WELCOME'), 5000, 'welcome');
    socket.write(encodeFrame({ t: 'REQUEST', ref: 'h1', cls: 'P0', operation: 'CANCEL', scope: 'API_AUTH', deadlineInMs: 1000, lifetimeMs: 1000, hookToken: 'forged' } as never, 65_536));
    await closed;
    expect(frames.some((m) => m.t === 'GRANT')).toBe(false);
    expect(coord.state.charges.filter((ch) => ch.viaHook)).toEqual([]);
  }, 30_000);
});
