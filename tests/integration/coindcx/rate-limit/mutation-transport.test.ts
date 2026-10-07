import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { CoinDcxOrderMutationTransport } from '../../../../src/integration/coindcx/live/mutation-transport';
import { RateLimitClient } from '../../../../src/integration/coindcx/rate-limit/runtime/client';
import { RateLimitCoordinator } from '../../../../src/integration/coindcx/rate-limit/runtime/coordinator';
import {
  consumeMutationPermit, createCoordinatorMutationBudget, releaseMutationPermit, type MutationBudget, type MutationPermit,
} from '../../../../src/integration/coindcx/rate-limit/runtime/mutation-budget';
import { createCoordinatorReadBudget } from '../../../../src/integration/coindcx/rate-limit/runtime/read-budget';
import { CoinDcxTransport } from '../../../../src/integration/coindcx/transport';
import { cleanup, clientConfig, fixture, limiterFixture, maxInWindow, recordHttpRequestCreations, sleep, waitFor, type Fixture } from './support';

// M2 W4: the order-mutation transport over the shared coordinator budget. Loopback HTTP servers, temporary state
// directories, synthetic credentials. No provider, external network or database access.
const stops: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); cleanup(); });

interface Loopback { url: string; hits: number[]; handler: (req: http.IncomingMessage, res: http.ServerResponse) => void }
async function loopback(): Promise<Loopback> {
  const state: Loopback = { url: '', hits: [], handler: (req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }); } };
  const server = http.createServer((req, res) => { state.hits.push(performance.timeOrigin + performance.now()); state.handler(req, res); });
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
async function client(pipe: string): Promise<RateLimitClient> {
  const c = new RateLimitClient(clientConfig(pipe));
  stops.push(() => c.close());
  expect(await c.connect()).toBe(true);
  return c;
}
async function grant(budget: MutationBudget, operation: 'CREATE' | 'CANCEL'): Promise<MutationPermit> {
  const acquired = await budget.acquire({ operation, lifetimeMs: 5000 });
  if (acquired.kind !== 'GRANTED') throw new Error(`expected a grant: ${acquired.reason}`);
  return acquired.permit;
}
const transportFor = (url: string, readBudget?: ConstructorParameters<typeof CoinDcxOrderMutationTransport>[0]['readBudget']) =>
  new CoinDcxOrderMutationTransport({ apiKey: 'synthetic-mutation-key', apiSecret: 'synthetic-mutation-secret', baseUrl: url, readBudget });
const CREATE_BODY = Object.freeze({ timestamp: 1, order: { client_order_id: 'synthetic' } });

describe('M2 W4 mutation transport: consumption, actual start and completion accounting', () => {
  it('consumption reports no start; STARTED is reported at request creation; completion only after teardown; exactly one request', async () => {
    const f = fixture();
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const budget = createCoordinatorMutationBudget(c, { cls: 'P0', deadlineInMs: 5000 });
    // Limiter level: a consumed permit whose request is never created stays uncertain (no STARTED, never released).
    const held = await grant(budget, 'CANCEL');
    const consumption = consumeMutationPermit(held, 'CANCEL');
    expect(consumption.kind).toBe('CONSUMED');
    await sleep(150);
    const uncertain = coord.state.charges.find((charge) => charge.operation === 'CANCEL')!;
    expect([uncertain.started, uncertain.latestStartMs, uncertain.slotHeld]).toEqual([false, null, true]);
    releaseMutationPermit(held); // a consumed permit is never released
    await sleep(100);
    expect(coord.state.charges.find((charge) => charge.grantId === uncertain.grantId)?.started).toBe(false);
    // Transport level: exactly one request, STARTED at creation, completion after close.
    const api = await loopback();
    const wire = await transportFor(api.url).execute('CREATE_ORDER', CREATE_BODY, 2000, await grant(budget, 'CREATE'));
    expect(wire).toMatchObject({ kind: 'RESPONSE', statusCode: 200 });
    expect(api.hits).toHaveLength(1);
    const created = await waitFor(() => coord.state.charges.find((charge) => charge.operation === 'CREATE' && !charge.slotHeld), 5000, 'create completed');
    expect(created.started).toBe(true);
    expect(created.latestStartMs).not.toBeNull();
  }, 30_000);

  it('refuses a missing, forged, read, wrong-operation or reused permit before any request; an unconsumed one can still be released', async () => {
    const f = fixture();
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const budget = createCoordinatorMutationBudget(c, { cls: 'P0', deadlineInMs: 5000 });
    const api = await loopback();
    const transport = transportFor(api.url);
    const refused = { kind: 'PRE_DISPATCH', reasonCode: 'BUDGET_REFUSED' };
    expect(await transport.execute('CREATE_ORDER', CREATE_BODY, 2000)).toEqual(refused);
    expect(await transport.execute('CREATE_ORDER', CREATE_BODY, 2000, null)).toEqual(refused);
    expect(await transport.execute('CREATE_ORDER', CREATE_BODY, 2000, { consume: () => ({ kind: 'USED' }), start: (create: () => unknown) => ({ kind: 'STARTED', value: create() }) })).toEqual(refused);
    const readGrant = await createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 5000 }).acquire({ scope: 'API_AUTH', lifetimeMs: 5000 });
    if (readGrant.kind !== 'GRANTED') throw new Error('read grant');
    expect(await transport.execute('CANCEL_ORDER', { timestamp: 1, id: 'x' }, 2000, readGrant.permit)).toEqual(refused);
    readGrant.permit.release();
    const cancelPermit = await grant(budget, 'CANCEL');
    expect(await transport.execute('CREATE_ORDER', CREATE_BODY, 2000, cancelPermit)).toEqual(refused); // the endpoint fixes the kind
    expect(api.hits).toHaveLength(0);
    releaseMutationPermit(cancelPermit); // never consumed: irrevocable known non-use (NOT_STARTED refund)
    await waitFor(() => coord.state.charges.length === 0, 5000, 'unused grants refunded');
    const once = await grant(budget, 'CREATE');
    expect(await transport.execute('CREATE_ORDER', CREATE_BODY, 2000, once)).toMatchObject({ kind: 'RESPONSE' });
    expect(await transport.execute('CREATE_ORDER', CREATE_BODY, 2000, once)).toEqual(refused); // no reuse: a retry needs a fresh permit
    expect(api.hits).toHaveLength(1);
  }, 30_000);

  it('expiry, revocation by STOP and coordinator disconnect between grant and consumption: refusal, zero requests', async () => {
    const f = fixture(limiterFixture({ grantTtlMs: 150 }));
    await coordinator(f);
    const c = await client(f.pipe);
    const budget = createCoordinatorMutationBudget(c, { cls: 'P0', deadlineInMs: 5000 });
    const api = await loopback();
    const transport = transportFor(api.url);
    const expiring = await grant(budget, 'CREATE');
    await sleep(300); // e.g. the durable arm was awaited for longer than the local start-check limit
    expect(await transport.execute('CREATE_ORDER', CREATE_BODY, 2000, expiring)).toEqual({ kind: 'PRE_DISPATCH', reasonCode: 'BUDGET_REFUSED' });
    const revoked = await grant(budget, 'CANCEL');
    expect((await c.control('STOP')).result).toBe('APPLIED');
    await waitFor(() => c.view.admission === 'STOPPED', 5000, 'stop observed');
    expect(await transport.execute('CANCEL_ORDER', { timestamp: 1, id: 'x' }, 2000, revoked)).toEqual({ kind: 'PRE_DISPATCH', reasonCode: 'BUDGET_REFUSED' });
    // W6: the client that sent STOP refuses locally; another client still meets the coordinator's STOP.
    expect(await budget.acquire({ operation: 'CREATE', lifetimeMs: 1000 })).toEqual({ kind: 'REFUSED', reason: 'LOCAL_STOP' });
    expect(await createCoordinatorMutationBudget(await client(f.pipe), { cls: 'P0', deadlineInMs: 5000 }).acquire({ operation: 'CREATE', lifetimeMs: 1000 })).toEqual({ kind: 'REFUSED', reason: 'ADMISSION_STOPPED' });
    expect((await c.control('RESET_STOP')).result).toBe('APPLIED');
    await waitFor(() => c.view.admission === 'OPEN', 5000, 'stop reset');
    const disconnected = await grant(budget, 'CREATE');
    c.close();
    await waitFor(() => c.session === null, 5000, 'client disconnected');
    expect(await transport.execute('CREATE_ORDER', CREATE_BODY, 2000, disconnected)).toEqual({ kind: 'PRE_DISPATCH', reasonCode: 'BUDGET_REFUSED' });
    expect(await budget.acquire({ operation: 'CREATE', lifetimeMs: 1000 })).toEqual({ kind: 'REFUSED', reason: 'UNAVAILABLE_NOT_CONNECTED' });
    expect(api.hits).toHaveLength(0);
  }, 30_000);

  it('timeout and response abort keep the existing classification; the slot is released only by actual teardown', async () => {
    const f = fixture();
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const budget = createCoordinatorMutationBudget(c, { cls: 'P0', deadlineInMs: 5000 });
    const api = await loopback();
    api.handler = (req) => { req.resume(); }; // never answers
    expect(await transportFor(api.url).execute('CANCEL_ORDER', { timestamp: 1, id: 'x' }, 150, await grant(budget, 'CANCEL'))).toEqual({ kind: 'UNESTABLISHED', reasonCode: 'TIMEOUT' });
    api.handler = (req, res) => { req.resume(); res.writeHead(200); res.write('{"partial":'); setTimeout(() => res.destroy(), 20); };
    expect(await transportFor(api.url).execute('CANCEL_ORDER', { timestamp: 1, id: 'x' }, 2000, await grant(budget, 'CANCEL'))).toMatchObject({ kind: 'UNESTABLISHED' });
    await waitFor(() => coord.state.charges.filter((charge) => charge.operation === 'CANCEL').every((charge) => charge.started && !charge.slotHeld), 5000, 'both torn down');
    expect(api.hits).toHaveLength(2); // no automatic resend
  }, 30_000);
});

describe('M2 W4 shared read/mutation budget', () => {
  it('reads and mutations share one start budget across both transports; measured starts stay within the cap', async () => {
    const f = fixture();
    await coordinator(f);
    const c = await client(f.pipe);
    const api = await loopback();
    const creations = recordHttpRequestCreations(); stops.push(creations.restore); // actual starts, not server arrival
    const starts = () => creations.times;
    const reads = new CoinDcxTransport({ baseUrl: api.url, readBudget: { budget: createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 30_000 }), scope: 'API_AUTH' } });
    const mutations = transportFor(api.url);
    const budget = createCoordinatorMutationBudget(c, { cls: 'P0', deadlineInMs: 30_000 });
    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => reads.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' }).then(() => 'READ_OK')),
      ...Array.from({ length: 4 }, async () => (await mutations.execute('CREATE_ORDER', CREATE_BODY, 5000, await grant(budget, 'CREATE'))).kind),
    ]);
    expect(results.sort()).toEqual(['READ_OK', 'READ_OK', 'READ_OK', 'READ_OK', 'RESPONSE', 'RESPONSE', 'RESPONSE', 'RESPONSE']);
    expect(maxInWindow(starts(), 1000)).toBeLessThanOrEqual(5); // fixture burst: 5 per 1000 ms across reads AND mutations
  }, 30_000);

  it('a 429 on a mutation blocks the shared scope for reads (no read request inside the block); the mutation outcome stays the provider response', async () => {
    const f = fixture();
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const api = await loopback();
    api.handler = (req, res) => { req.resume(); req.on('end', () => { res.writeHead(429, { 'retry-after': '30', 'content-type': 'application/json' }); res.end('{"message":"slow down"}'); }); };
    const budget = createCoordinatorMutationBudget(c, { cls: 'P0', deadlineInMs: 5000 });
    expect(await transportFor(api.url).execute('CANCEL_ORDER', { timestamp: 1, id: 'x' }, 2000, await grant(budget, 'CANCEL'))).toMatchObject({ kind: 'RESPONSE', statusCode: 429 });
    await waitFor(() => coord.state.scopes.API_AUTH.kind === 'BLOCKED', 5000, 'scope blocked');
    const reads = new CoinDcxTransport({ baseUrl: api.url, readBudget: { budget: createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 300 }), scope: 'API_AUTH' } });
    await expect(reads.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' })).rejects.toMatchObject({ statusCode: 503, details: { readBudget: 'REFUSED' } });
    expect(await budget.acquire({ operation: 'CREATE', lifetimeMs: 1000 })).toMatchObject({ kind: 'REFUSED' });
    expect(api.hits).toHaveLength(1);
  }, 30_000);

  it('order observation (LIST_ORDERS) uses a read permit: refused without a read budget, never paid by a mutation permit', async () => {
    const f = fixture();
    await coordinator(f);
    const c = await client(f.pipe);
    const api = await loopback();
    api.handler = (req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); }); };
    expect(await transportFor(api.url).execute('LIST_ORDERS', { timestamp: 1 }, 2000)).toEqual({ kind: 'PRE_DISPATCH', reasonCode: 'READ_BUDGET_REFUSED' });
    const paced = transportFor(api.url, { budget: createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 5000 }), scope: 'API_AUTH' });
    const permit = await grant(createCoordinatorMutationBudget(c, { cls: 'P0', deadlineInMs: 5000 }), 'CANCEL');
    expect(await paced.execute('LIST_ORDERS', { timestamp: 1 }, 2000, permit)).toEqual({ kind: 'PRE_DISPATCH', reasonCode: 'BUDGET_REFUSED' });
    releaseMutationPermit(permit);
    expect(api.hits).toHaveLength(0);
    expect(await paced.execute('LIST_ORDERS', { timestamp: 1 }, 2000)).toMatchObject({ kind: 'RESPONSE', statusCode: 200 });
    expect(api.hits).toHaveLength(1);
  }, 30_000);
});
