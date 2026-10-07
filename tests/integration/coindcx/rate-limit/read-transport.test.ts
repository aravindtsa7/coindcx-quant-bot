import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { RateLimitClient } from '../../../../src/integration/coindcx/rate-limit/runtime/client';
import { RateLimitCoordinator } from '../../../../src/integration/coindcx/rate-limit/runtime/coordinator';
import { encodeFrame, FrameDecoder } from '../../../../src/integration/coindcx/rate-limit/runtime/framing';
import { attachReadProbeResponder, type ReadProbeOutcome } from '../../../../src/integration/coindcx/rate-limit/runtime/read-probe';
import { createCoordinatorReadBudget, type ReadBudget, type ReadPermit } from '../../../../src/integration/coindcx/rate-limit/runtime/read-budget';
import { HmacSha256Signer } from '../../../../src/integration/coindcx/signer';
import { CoinDcxTransport } from '../../../../src/integration/coindcx/transport';
import { cleanup, clientConfig, fixture, limiterFixture, maxInWindow, sleep, waitFor, type Fixture } from './support';

// M2 W3: the read transport over the shared coordinator budget. Loopback HTTP servers stand in for the two configured
// hosts; temporary state directories; synthetic credentials. No provider, external network or database access.
const stops: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); cleanup(); });

interface Loopback { url: string; hits: number[]; active: number; maxActive: number; handler: (req: http.IncomingMessage, res: http.ServerResponse) => void }
async function loopback(): Promise<Loopback> {
  const state: Loopback = { url: '', hits: [], active: 0, maxActive: 0, handler: (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); } };
  const server = http.createServer((req, res) => {
    state.hits.push(performance.timeOrigin + performance.now()); state.active += 1; state.maxActive = Math.max(state.maxActive, state.active);
    res.on('close', () => { state.active -= 1; });
    state.handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stops.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return state;
}
async function coordinator(f: Fixture): Promise<RateLimitCoordinator> {
  const started = await RateLimitCoordinator.start(f.coordinator);
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
/** Records the moment each permit's request factory runs: the actual request creation. */
function recording(inner: ReadBudget): ReadBudget & { starts: number[]; acquired: number } {
  const out = { starts: [] as number[], acquired: 0, async acquire(request: Parameters<ReadBudget['acquire']>[0]) {
    out.acquired += 1;
    const result = await inner.acquire(request);
    if (result.kind !== 'GRANTED') return result;
    const permit = result.permit;
    const wrapped: ReadPermit = { ...permit, start: (create) => permit.start(() => { out.starts.push(performance.timeOrigin + performance.now()); return create(); }),
      complete: () => permit.complete(), release: () => permit.release(), throttled: (h) => permit.throttled(h) };
    return { kind: 'GRANTED' as const, permit: wrapped };
  } };
  return out;
}
const reads = (n: number, transport: CoinDcxTransport) => Array.from({ length: n }, () => transport.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' }).then(() => 'OK', (e: { message?: string }) => String(e.message)));

describe('M2 W3 read transport: one shared budget, actual request starts', () => {
  it('concurrent reads on both configured hosts share one budget; measured request starts stay within the cap', async () => {
    const f = fixture();
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const budget = recording(createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 30_000 }));
    const api = await loopback(), pub = await loopback();
    const apiTransport = new CoinDcxTransport({ baseUrl: api.url, readBudget: { budget, scope: 'API_AUTH' } });
    const pubTransport = new CoinDcxTransport({ baseUrl: pub.url, readBudget: { budget, scope: 'PUBLIC' } });
    const results = await Promise.all([...reads(6, apiTransport), ...reads(6, pubTransport)]);
    expect(results.every((r) => r === 'OK')).toBe(true);
    expect([api.hits.length, pub.hits.length]).toEqual([6, 6]);
    expect(budget.starts).toHaveLength(12);
    expect(maxInWindow(budget.starts, 1000)).toBeLessThanOrEqual(5); // fixture burst: 5 per 1000 ms across BOTH hosts
    await waitFor(() => coord.state.charges.every((ch) => !ch.slotHeld), 5000, 'all requests completed');
  }, 30_000);

  it('concurrency is held for the actual request duration (slow responses)', async () => {
    const f = fixture(limiterFixture({ concurrency: 2 }));
    await coordinator(f);
    const c = await client(f.pipe);
    const api = await loopback();
    api.handler = (_req, res) => { setTimeout(() => { res.writeHead(200); res.end('{}'); }, 150); };
    const transport = new CoinDcxTransport({ baseUrl: api.url, readBudget: { budget: createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 30_000 }), scope: 'API_AUTH' } });
    expect((await Promise.all(reads(5, transport))).every((r) => r === 'OK')).toBe(true);
    expect(api.maxActive).toBeLessThanOrEqual(2);
  }, 30_000);

  it('each retry obtains a fresh permit; preserves read response and error semantics', async () => {
    const f = fixture();
    await coordinator(f);
    const c = await client(f.pipe);
    const budget = recording(createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 30_000 }));
    const api = await loopback();
    let status = 500;
    api.handler = (req, res) => {
      req.resume();
      req.on('end', () => {
        if (status === 200) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(`{"price":123.4500000000000000001,"echo":${JSON.stringify(req.headers['x-auth-signature'] ?? null)}}`); return; }
        res.writeHead(status); res.end(status === 401 ? '{}' : 'oops-not-json-for-500?'.slice(0, 0));
      });
    };
    const signer = new HmacSha256Signer('synthetic-secret');
    const transport = new CoinDcxTransport({ baseUrl: api.url, apiKey: 'synthetic-key', signer, readBudget: { budget, scope: 'API_AUTH' } });
    await expect(transport.executeRead({ endpoint: 'FUTURES_POSITIONS', body: '{"timestamp":1}' })).rejects.toMatchObject({ code: 'COINDCX_PROVIDER_ERROR', statusCode: 500 });
    status = 200; // the caller retries: a new wire request and a new permit
    const ok = await transport.executeRead<{ price: { value: string }; echo: string }>({ endpoint: 'FUTURES_POSITIONS', body: '{"timestamp":1}' });
    expect(ok.data.price.value).toBe('123.4500000000000000001'); // lossless parsing unchanged
    expect(ok.data.echo).toBe(signer.sign('{"timestamp":1}')); // the caller-built body is signed as given
    status = 401;
    await expect(transport.executeRead({ endpoint: 'FUTURES_POSITIONS', body: '{}' })).rejects.toMatchObject({ code: 'COINDCX_AUTH_ERROR' });
    expect([budget.acquired, budget.starts.length, api.hits.length]).toEqual([3, 3, 3]);
    await expect(new CoinDcxTransport({ baseUrl: api.url, signer, readBudget: { budget, scope: 'API_AUTH' } }).executeRead({ endpoint: 'FUTURES_POSITIONS' })).rejects.toMatchObject({ code: 'COINDCX_AUTH_ERROR' });
    expect(budget.acquired).toBe(3); // configuration errors fail before any permit is acquired
  }, 30_000);
});

describe('M2 W3 read transport: refusal before any HTTP request', () => {
  it('no budget, an unconnected client, or a closed coordinator: explicit refusal and zero HTTP requests', async () => {
    const api = await loopback();
    await expect(new CoinDcxTransport({ baseUrl: api.url }).executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' })).rejects.toMatchObject({ statusCode: 503, details: { readBudget: 'REFUSED', reason: 'READ_BUDGET_MISSING' } });
    const f = fixture();
    const never = new RateLimitClient(clientConfig(f.pipe));
    await expect(new CoinDcxTransport({ baseUrl: api.url, readBudget: { budget: createCoordinatorReadBudget(never, { cls: 'P1', deadlineInMs: 1000 }), scope: 'API_AUTH' } }).executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' }))
      .rejects.toMatchObject({ details: { reason: 'UNAVAILABLE_NOT_CONNECTED' } });
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const transport = new CoinDcxTransport({ baseUrl: api.url, readBudget: { budget: createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 1000 }), scope: 'API_AUTH' } });
    await coord.close();
    await waitFor(() => c.session === null, 5000, 'client sees the coordinator gone');
    await expect(transport.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' })).rejects.toMatchObject({ details: { reason: 'UNAVAILABLE_NOT_CONNECTED' } });
    expect(api.hits).toHaveLength(0);
  }, 30_000);

  it('caller abandonment before a grant: explicit refusal, nothing sent, nothing left uncertain', async () => {
    const f = fixture(limiterFixture({ windows: [{ windowMs: 1000, maxStarts: 1 }, { windowMs: 10_000, maxStarts: 50 }] }));
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const api = await loopback();
    const patient = new CoinDcxTransport({ baseUrl: api.url, readBudget: { budget: createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 30_000 }), scope: 'API_AUTH' } });
    const hasty = new CoinDcxTransport({ baseUrl: api.url, readBudget: { budget: createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 300 }), scope: 'API_AUTH' } });
    await patient.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' }); // consumes the only burst place for ~1 s
    await expect(hasty.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' })).rejects.toMatchObject({ details: { readBudget: 'REFUSED' } });
    await sleep(1500);
    expect(api.hits).toHaveLength(1);
    expect(coord.state.charges.filter((ch) => !ch.started)).toEqual([]); // the abandoned request was refused, never granted
  }, 30_000);

  it('a grant arriving after the caller abandoned the read is voided at once: no usable permit, no HTTP request', async () => {
    // A minimal protocol peer that delivers the GRANT only after the client's local deadline.
    const pipe = `\\\\.\\pipe\\m2w3-late-${randomBytes(6).toString('hex')}`;
    const hex = (p: string): string => `${p}${randomBytes(16).toString('hex')}`;
    const epoch = hex('e'), sessionId = hex('s');
    const received: Array<Record<string, unknown>> = [];
    let send: ((m: unknown) => void) | null = null;
    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder(65_536);
      send = (m) => socket.write(encodeFrame(m, 65_536));
      socket.on('data', (chunk: Buffer) => {
        const d = decoder.push(chunk);
        if (d.kind !== 'FRAMES') return;
        for (const m of d.frames as Array<Record<string, unknown>>) {
          received.push(m);
          if (m.t === 'HELLO') send!({ t: 'WELCOME', epoch, sessionId, clientInstanceId: hex('c'), resumeSecret: randomBytes(32).toString('hex'), state: { admission: 'OPEN', blockedScopes: [], unknown: false } });
          if (m.t === 'REPORT') send!({ t: 'ACK', ackId: m.ackId, result: 'APPLIED' });
        }
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(pipe, () => resolve()));
    stops.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const c = await client(pipe);
    const api = await loopback();
    const transport = new CoinDcxTransport({ baseUrl: api.url, readBudget: { budget: createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 200 }), scope: 'API_AUTH' } });
    await expect(transport.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' })).rejects.toMatchObject({ details: { readBudget: 'REFUSED', reason: 'UNAVAILABLE_LOCAL_DEADLINE' } });
    const request = received.find((m) => m.t === 'REQUEST')!;
    const grantId = hex('g');
    send!({ t: 'GRANT', ref: request.ref, grant: { epoch, sessionId, grantId, requestId: 'r1', ttlMs: 2000, operation: 'READ', scope: 'API_AUTH', viaHook: false, probeGen: null } });
    await waitFor(() => received.some((m) => m.t === 'REPORT' && m.grantId === grantId && m.kind === 'NOT_STARTED'), 5000, 'late grant voided');
    expect(received.filter((m) => m.t === 'REPORT' && m.grantId === grantId).map((m) => m.kind)).toEqual(['RECEIVED', 'NOT_STARTED']);
    expect(api.hits).toHaveLength(0);
  }, 30_000);

  it('permit expiry and single use: a stale permit does not start; a used permit cannot be reused or released', async () => {
    const f = fixture(limiterFixture({ grantTtlMs: 100 }));
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const budget = createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 5000 });
    const stale = await budget.acquire({ scope: 'API_AUTH', lifetimeMs: 1000 });
    if (stale.kind !== 'GRANTED') throw new Error('expected a grant');
    await sleep(250);
    let created = 0;
    expect(stale.permit.start(() => { created += 1; })).toEqual({ kind: 'NOT_STARTED', reason: 'LOCAL_DEADLINE_PASSED' });
    expect(created).toBe(0);
    const fresh = await budget.acquire({ scope: 'API_AUTH', lifetimeMs: 1000 });
    if (fresh.kind !== 'GRANTED') throw new Error('expected a grant');
    expect(() => fresh.permit.start(() => { throw new Error('factory threw'); })).toThrow('factory threw');
    expect(fresh.permit.start(() => 1)).toEqual({ kind: 'NOT_STARTED', reason: 'PERMIT_STARTED' });
    fresh.permit.release();
    await sleep(200);
    // A throwing factory: STARTED was reported (a start cannot be excluded); no NOT_STARTED, no completion.
    const charge = await waitFor(() => coord.state.charges.find((ch) => ch.started), 5000, 'started charge');
    expect([charge.slotHeld, coord.state.charges.filter((ch) => ch.grantId !== charge.grantId)]).toEqual([true, []]);
  }, 30_000);

  it('timeout, response abort and coordinator disconnect after the start: each request is accounted and completes only on teardown', async () => {
    const f = fixture();
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const api = await loopback();
    const transport = new CoinDcxTransport({ baseUrl: api.url, timeoutMs: 200, readBudget: { budget: createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 5000 }), scope: 'API_AUTH' } });
    api.handler = () => { /* never responds */ };
    await expect(transport.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' })).rejects.toMatchObject({ code: 'COINDCX_TIMEOUT' });
    api.handler = (_req, res) => { res.writeHead(200, { 'content-length': '100' }); res.write('{"partial'); setTimeout(() => res.destroy(), 20); };
    await expect(transport.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' })).rejects.toMatchObject({ code: 'COINDCX_PROVIDER_ERROR' });
    await waitFor(() => coord.state.charges.length === 2 && coord.state.charges.every((ch) => ch.started && !ch.slotHeld), 5000, 'both torn down and completed');
    // Coordinator connection lost while a request is in flight: the request proceeds; reports are re-sent after reconnect.
    api.handler = (_req, res) => { setTimeout(() => { res.writeHead(200); res.end('{}'); }, 120); }; // within the 200 ms timeout
    const inFlight = transport.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' });
    await waitFor(() => api.hits.length === 3, 5000, 'third request on the wire');
    c.close();
    await inFlight;
    expect(await c.connect()).toBe(true);
    await waitFor(() => coord.state.charges.length === 3 && coord.state.charges.every((ch) => ch.started && !ch.slotHeld), 5000, 'reports re-sent after reconnect');
  }, 30_000);
});

describe('M2 W3 read transport: shared throttle, Retry-After forms, STOP and scoped probes', () => {
  async function throttledBy(headers: http.OutgoingHttpHeaders, sendDate: boolean) {
    const f = fixture(limiterFixture({ retryAfter: { noHeaderDefaultMs: 3000, providerStatedBlockMs: 500, localBackoffBaseMs: 500, localBackoffMaxMs: 2000, operationalCapMs: 600_000, clockUncertaintyMs: 100 } }));
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const api = await loopback();
    api.handler = (_req, res) => { res.sendDate = sendDate; res.writeHead(429, headers); res.end('{}'); };
    const transport = new CoinDcxTransport({ baseUrl: api.url, readBudget: { budget: createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 300 }), scope: 'API_AUTH' } });
    const error = await transport.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' }).catch((e: unknown) => e);
    await waitFor(() => coord.state.scopes.API_AUTH.kind !== 'CLEAR' || coord.state.unknown !== null, 5000, 'shared throttle applied');
    const refused = await transport.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' }).catch((e: { details?: unknown }) => e.details);
    return { coord, error, refused, hits: api.hits.length };
  }

  it('a 429 keeps its caller-facing error and blocks every scope at the coordinator; no further HTTP inside the block', async () => {
    const { coord, error, refused, hits } = await throttledBy({ 'retry-after': '2' }, true);
    expect(error).toMatchObject({ code: 'COINDCX_RATE_LIMIT', retryAfterMs: 2000 });
    expect([coord.state.scopes.API_AUTH.kind, coord.state.scopes.PUBLIC.kind]).toEqual(['BLOCKED', 'BLOCKED']);
    expect(refused).toMatchObject({ readBudget: 'REFUSED' });
    expect(hits).toBe(1);
  }, 30_000);

  const inTwoSeconds = (): http.OutgoingHttpHeaders => ({ 'retry-after': new Date(Date.now() + 2000).toUTCString() });
  it.each([
    ['absent Retry-After: the configured no-header default', () => ({}), true, 'BLOCKED', 3000],
    ['malformed Retry-After: fail closed (UNKNOWN)', () => ({ 'retry-after': 'soon' }), true, 'UNKNOWN', 0],
    ['HTTP-date with the server Date header', inTwoSeconds, true, 'BLOCKED', 1000],
    ['HTTP-date without a Date header (local clock untrusted): fail closed', inTwoSeconds, false, 'UNKNOWN', 0],
  ] as const)('%s', async (_label, headers, sendDate, expected, minimumWaitMs) => {
    const before = Date.now();
    const { coord } = await throttledBy(headers(), sendDate);
    if (expected === 'UNKNOWN') { expect(coord.state.unknown).toBe('RETRY_AFTER_UNBOUNDED'); return; }
    const scope = coord.state.scopes.API_AUTH;
    expect(scope.kind).toBe('BLOCKED');
    expect(coord.alerts.some((a) => a.code === 'RETRY_AFTER_PRESENT_BUT_UNPARSEABLE')).toBe(false);
    expect(Date.now() - before).toBeLessThan(minimumWaitMs + 5000);
    expect(coord.state.blocks.at(-1)!.fullWaitMs).toBeGreaterThanOrEqual(minimumWaitMs);
  }, 30_000);

  it('STOP does not stop reads; separate probe scopes re-admit independently; a throttled probe re-blocks under a new generation', async () => {
    const f = fixture(limiterFixture({ retryAfter: { noHeaderDefaultMs: 3000, providerStatedBlockMs: 500, localBackoffBaseMs: 500, localBackoffMaxMs: 2000, operationalCapMs: 600_000, clockUncertaintyMs: 100 } }));
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const api = await loopback(), pub = await loopback();
    expect(await c.control('STOP')).toEqual({ result: 'APPLIED' });
    const budget = createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 400 });
    const apiT = new CoinDcxTransport({ baseUrl: api.url, readBudget: { budget, scope: 'API_AUTH' } });
    const pubT = new CoinDcxTransport({ baseUrl: pub.url, readBudget: { budget, scope: 'PUBLIC' } });
    expect((await apiT.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' })).status).toBe(200); // reads continue under STOP
    api.handler = (_req, res) => { res.writeHead(429, { 'retry-after': '1' }); res.end('{}'); };
    await apiT.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' }).catch(() => undefined);
    // Loopback probe executor: PUBLIC succeeds at once; API_AUTH is throttled once, then succeeds.
    let authProbes = 0;
    const executor = { probe: (scope: 'API_AUTH' | 'PUBLIC'): Promise<ReadProbeOutcome> => {
      const target = scope === 'PUBLIC' ? pub.url : api.url;
      const throttle = scope === 'API_AUTH' && authProbes++ === 0;
      return new Promise((resolve) => {
        const req = http.get(`${target}/probe`, (res) => { res.resume(); res.on('end', () => undefined); });
        req.on('close', () => resolve(throttle ? { kind: 'THROTTLED', retryAfter: '1' } : { kind: 'SUCCESS' }));
        req.on('error', () => resolve({ kind: 'FAILED' }));
      });
    } };
    api.handler = (_req, res) => { res.writeHead(200); res.end('{}'); };
    const prober = await client(f.pipe, ['API_AUTH', 'PUBLIC']);
    const log = attachReadProbeResponder(prober, executor, { deadlineInMs: 5000, lifetimeMs: 1000 });
    await waitFor(() => coord.state.scopes.PUBLIC.kind === 'CLEAR', 10_000, 'PUBLIC re-admitted');
    expect((await pubT.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' })).status).toBe(200);
    await waitFor(() => log.some((l) => l.scope === 'API_AUTH' && l.result === 'THROTTLED'), 10_000, 'first API_AUTH probe throttled');
    await waitFor(() => coord.state.scopes.API_AUTH.kind === 'CLEAR', 10_000, 'API_AUTH re-admitted by a later generation');
    const auth = log.filter((l) => l.scope === 'API_AUTH');
    expect(auth.map((l) => l.result)).toEqual(['THROTTLED', 'SUCCESS']);
    expect(auth[1]!.probeGen).toBeGreaterThan(auth[0]!.probeGen);
    expect(coord.state.admission).toBe('STOPPED'); // probes never clear STOP
    await waitFor(() => coord.state.charges.filter((ch) => ch.operation === 'PROBE').every((ch) => !ch.slotHeld), 5000, 'probe requests completed');
  }, 40_000);
});
