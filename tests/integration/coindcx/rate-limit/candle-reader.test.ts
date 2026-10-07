import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { CoinDcxOrderMutationTransport } from '../../../../src/integration/coindcx/live/mutation-transport';
import { RateLimitClient } from '../../../../src/integration/coindcx/rate-limit/runtime/client';
import { RateLimitCoordinator } from '../../../../src/integration/coindcx/rate-limit/runtime/coordinator';
import { createCoordinatorMutationBudget } from '../../../../src/integration/coindcx/rate-limit/runtime/mutation-budget';
import { attachReadProbeResponder, type ReadProbeOutcome } from '../../../../src/integration/coindcx/rate-limit/runtime/read-probe';
import { createCoordinatorReadBudget, type ReadBudget, type ReadPermit } from '../../../../src/integration/coindcx/rate-limit/runtime/read-budget';
import { CoinDcxTransport } from '../../../../src/integration/coindcx/transport';
import { CoinDcxFuturesCandleRestReader } from '../../../../src/market-data/rest-candle-reader';
import { cleanup, clientConfig, fixture, limiterFixture, maxInWindow, recordHttpRequestCreations, sleep, waitFor, type Fixture } from './support';

// M2 W5: the candle-reader request primitive over the shared coordinator budget. Loopback HTTP servers, temporary
// state directories, synthetic candles and credentials. No provider, external network or database access.
const stops: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); cleanup(); });

const MINUTE = 60_000;
const T1 = 1_700_000_040_000; // aligned UTC minutes, long closed relative to the fixture clock
const NOW = { nowMs: () => T1 + 60 * MINUTE };
const candle = (timeMs: number, close = '105.5') => ({ open: '100.1', high: '110.25', low: '95', close, volume: '10.000000000000000001', time: timeMs });
const okBody = (times: readonly number[]) => JSON.stringify({ s: 'ok', data: times.map((t) => candle(t)) });

interface Loopback { url: string; hits: string[]; starts: number[]; active: number; maxActive: number; handler: (req: http.IncomingMessage, res: http.ServerResponse) => void }
async function loopback(): Promise<Loopback> {
  const state: Loopback = { url: '', hits: [], starts: [], active: 0, maxActive: 0, handler: (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(okBody([T1])); } };
  const server = http.createServer((req, res) => {
    state.hits.push(req.url ?? ''); state.starts.push(performance.timeOrigin + performance.now());
    state.active += 1; state.maxActive = Math.max(state.maxActive, state.active); res.on('close', () => { state.active -= 1; });
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
/** Counts acquisitions and the moment each permit's request factory runs (actual request creation). */
function recording(inner: ReadBudget, delayGrantMs = 0): ReadBudget & { acquired: number; starts: number[] } {
  const out = { acquired: 0, starts: [] as number[], async acquire(request: Parameters<ReadBudget['acquire']>[0]) {
    out.acquired += 1;
    const result = await inner.acquire(request);
    if (delayGrantMs > 0) await sleep(delayGrantMs);
    if (result.kind !== 'GRANTED') return result;
    const permit = result.permit;
    const wrapped: ReadPermit = { start: (create) => permit.start(() => { out.starts.push(performance.timeOrigin + performance.now()); return create(); }),
      complete: () => permit.complete(), release: () => permit.release(), throttled: (h) => permit.throttled(h) };
    return { kind: 'GRANTED' as const, permit: wrapped };
  } };
  return out;
}
const reader = (url: string, budget: ReadBudget | undefined, timeoutMs = 5000) =>
  new CoinDcxFuturesCandleRestReader({ baseUrl: url, timeoutMs, clock: NOW, ...(budget === undefined ? {} : { readBudget: { budget, scope: 'PUBLIC' as const } }) });
const query = (fromMs = T1, toMs = T1) => ({ pair: 'B-BTC_USDT', fromMs, toMs });

describe('M2 W5 candle reader: shared budget and actual starts', () => {
  it('candle reads share one budget with other reads and mutations; measured request starts stay within the cap', async () => {
    const f = fixture();
    await coordinator(f);
    const c = await client(f.pipe);
    const pub = await loopback(), api = await loopback();
    const creations = recordHttpRequestCreations(); stops.push(creations.restore); // actual starts, not server arrival
    const candles = recording(createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 30_000 }));
    const reads = new CoinDcxTransport({ baseUrl: pub.url, readBudget: { budget: createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 30_000 }), scope: 'PUBLIC' } });
    const mutations = new CoinDcxOrderMutationTransport({ apiKey: 'synthetic-w5-key', apiSecret: 'synthetic-w5-secret', baseUrl: api.url });
    const mutationBudget = createCoordinatorMutationBudget(c, { cls: 'P0', deadlineInMs: 30_000 });
    const create = async () => {
      const g = await mutationBudget.acquire({ operation: 'CREATE', lifetimeMs: 5000 });
      if (g.kind !== 'GRANTED') throw new Error(g.reason);
      return (await mutations.execute('CREATE_ORDER', { timestamp: 1 }, 5000, g.permit)).kind;
    };
    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => reader(pub.url, candles).fetchClosedCandles(query()).then((r) => `CANDLES_${r.length}`)),
      ...Array.from({ length: 3 }, () => reads.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' }).then(() => 'READ')),
      ...Array.from({ length: 3 }, () => create()),
    ]);
    expect(results.sort()).toEqual(['CANDLES_1', 'CANDLES_1', 'CANDLES_1', 'CANDLES_1', 'READ', 'READ', 'READ', 'RESPONSE', 'RESPONSE', 'RESPONSE']);
    expect(creations.times).toHaveLength(10);
    expect(maxInWindow(creations.times, 1000)).toBeLessThanOrEqual(5); // fixture burst across all three kinds
    expect([candles.acquired, candles.starts.length]).toEqual([4, 4]);
  }, 30_000);

  it('concurrency is held for the actual candle request duration', async () => {
    const f = fixture(limiterFixture({ concurrency: 2 }));
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const pub = await loopback();
    pub.handler = (_req, res) => { setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(okBody([T1])); }, 150); };
    const budget = createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 30_000 });
    expect(await Promise.all(Array.from({ length: 5 }, () => reader(pub.url, budget).fetchClosedCandles(query()).then((r) => r.length)))).toEqual([1, 1, 1, 1, 1]);
    expect(pub.maxActive).toBeLessThanOrEqual(2);
    await waitFor(() => coord.state.charges.every((ch) => ch.started && !ch.slotHeld), 5000, 'all completed after teardown');
  }, 30_000);
});

describe('M2 W5 candle reader: refusal before any HTTP request', () => {
  it('missing (unbound production default), unavailable or refusing budgets: CanonicalRecoveryError, zero HTTP', async () => {
    const pub = await loopback();
    await expect(reader(pub.url, undefined).fetchClosedCandles(query())).rejects.toMatchObject({ message: expect.stringMatching(/read budget refused before any request: PRODUCTION_READ_BUDGET_UNBOUND/) });
    const unconnected = new RateLimitClient(clientConfig(fixture().pipe));
    await expect(reader(pub.url, createCoordinatorReadBudget(unconnected, { cls: 'P1', deadlineInMs: 1000 })).fetchClosedCandles(query()))
      .rejects.toMatchObject({ name: 'CanonicalRecoveryError', message: expect.stringMatching(/UNAVAILABLE_NOT_CONNECTED/) });
    const throwing: ReadBudget = { acquire: async () => { throw new Error('synthetic budget fault'); } };
    await expect(reader(pub.url, throwing).fetchClosedCandles(query())).rejects.toMatchObject({ message: expect.stringMatching(/READ_BUDGET_ERROR/) });
    const refusing: ReadBudget = { acquire: async () => ({ kind: 'REFUSED', reason: 'DEADLINE' }) };
    await expect(reader(pub.url, refusing).fetchClosedCandles(query())).rejects.toMatchObject({ message: expect.stringMatching(/refused before any request: DEADLINE/) });
    expect(pub.hits).toHaveLength(0);
  }, 30_000);

  it('a grant that expires before the start, or arrives after the request timeout (abandonment): no request; single use', async () => {
    const f = fixture(limiterFixture({ grantTtlMs: 100 }));
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const pub = await loopback();
    // Expired: the permit's synchronous start check voids it (NOT_STARTED, refunded).
    const late = recording(createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 5000 }), 250);
    await expect(reader(pub.url, late).fetchClosedCandles(query())).rejects.toMatchObject({ message: expect.stringMatching(/PERMIT_LOCAL_DEADLINE_PASSED/) });
    // Abandoned: the grant arrives after this request's timeout; it is released unused (known non-use).
    const slow = recording(createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 5000 }), 80);
    await expect(reader(pub.url, slow, 50).fetchClosedCandles(query())).rejects.toMatchObject({ message: expect.stringMatching(/timed out/) });
    expect(pub.hits).toHaveLength(0);
    expect([late.starts.length, slow.starts.length]).toEqual([0, 0]);
    await waitFor(() => coord.state.charges.length === 0, 5000, 'both unused grants refunded');
    // Single use: one acquisition and one actual start per request.
    const once = recording(createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 5000 }));
    expect(await reader(pub.url, once).fetchClosedCandles(query())).toHaveLength(1);
    expect([once.acquired, once.starts.length, pub.hits.length]).toEqual([1, 1, 1]);
  }, 30_000);
});

describe('M2 W5 candle reader: throttle, Retry-After and probe recovery', () => {
  it('a candle 429 keeps its error, blocks the shared budget (no HTTP inside the block) and a PUBLIC probe re-admits reads', async () => {
    const f = fixture(limiterFixture({ retryAfter: { noHeaderDefaultMs: 3000, providerStatedBlockMs: 500, localBackoffBaseMs: 500, localBackoffMaxMs: 2000, operationalCapMs: 600_000, clockUncertaintyMs: 100 } }));
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const pub = await loopback();
    pub.handler = (_req, res) => { res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' }); res.end('{}'); };
    const budget = createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 300 });
    await expect(reader(pub.url, budget).fetchClosedCandles(query())).rejects.toMatchObject({ name: 'CanonicalRecoveryError', message: 'Futures candlestick recovery request failed: HTTP status 429' });
    await waitFor(() => coord.state.scopes.PUBLIC.kind !== 'CLEAR', 5000, 'PUBLIC blocked');
    await expect(reader(pub.url, budget).fetchClosedCandles(query())).rejects.toMatchObject({ message: expect.stringMatching(/read budget refused before any request/) });
    expect(pub.hits).toHaveLength(1);
    pub.handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(okBody([T1])); };
    const executor = { probe: (): Promise<ReadProbeOutcome> => new Promise((resolve) => {
      const req = http.get(`${pub.url}/probe`, (res) => { res.resume(); });
      req.on('close', () => resolve({ kind: 'SUCCESS' })); req.on('error', () => resolve({ kind: 'FAILED' }));
    }) };
    const prober = await client(f.pipe, ['PUBLIC']);
    attachReadProbeResponder(prober, executor, { deadlineInMs: 5000, lifetimeMs: 1000 });
    await waitFor(() => coord.state.scopes.PUBLIC.kind === 'CLEAR', 10_000, 'PUBLIC re-admitted by its probe');
    expect(await reader(pub.url, createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 5000 })).fetchClosedCandles(query())).toHaveLength(1);
  }, 30_000);
});

describe('M2 W5 candle reader: unchanged semantics', () => {
  it('each caller retry gets a fresh permit; data, window query, filtering and error mapping are unchanged', async () => {
    const f = fixture();
    await coordinator(f);
    const c = await client(f.pipe);
    const pub = await loopback();
    const budget = recording(createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 5000 }));
    const r = reader(pub.url, budget);
    let status = 500;
    pub.handler = (_req, res) => {
      if (status !== 200) { res.writeHead(status); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      // Out-of-order, duplicate, out-of-range and forming-minute rows: filtering and dedupe are the reader's.
      res.end(JSON.stringify({ s: 'ok', data: [candle(T1 + MINUTE), candle(T1), candle(T1), candle(T1 - MINUTE), candle(T1 + 60 * MINUTE)] }));
    };
    await expect(r.fetchClosedCandles(query(T1, T1 + MINUTE))).rejects.toMatchObject({ message: 'Futures candlestick recovery request failed: HTTP status 500' });
    status = 200; // the caller retries: a new request and a new permit (the reader itself never retries)
    const records = await r.fetchClosedCandles(query(T1, T1 + MINUTE));
    expect(records.map((x) => [x.openTimeMs, x.close.toString(), x.volume.toString()])).toEqual([[T1, '105.5', '10.000000000000000001'], [T1 + MINUTE, '105.5', '10.000000000000000001']]);
    // A second window (caller-side paging) is a separate request with its own permit and the unchanged query format.
    expect(await r.fetchClosedCandles(query(T1 - MINUTE, T1 - MINUTE))).toHaveLength(1);
    expect(pub.hits.map((u) => new URL(u, 'http://x').search)).toEqual([
      `?pair=B-BTC_USDT&from=${T1 / 1000}&to=${(T1 + MINUTE) / 1000}&resolution=1&pcode=f`,
      `?pair=B-BTC_USDT&from=${T1 / 1000}&to=${(T1 + MINUTE) / 1000}&resolution=1&pcode=f`,
      `?pair=B-BTC_USDT&from=${(T1 - MINUTE) / 1000}&to=${(T1 - MINUTE) / 1000}&resolution=1&pcode=f`,
    ]);
    expect([budget.acquired, budget.starts.length]).toEqual([3, 3]);
    pub.handler = (_req, res) => { res.writeHead(200); res.end('{"s":"ok","data":[{"open":"1"}]}'); };
    await expect(r.fetchClosedCandles(query())).rejects.toMatchObject({ message: 'Invalid REST candlestick response schema' });
    pub.handler = (_req, res) => { res.writeHead(200); res.end('{bad json'); };
    await expect(r.fetchClosedCandles(query())).rejects.toMatchObject({ message: 'Failed to parse REST candlestick JSON response' });
    expect([budget.acquired, budget.starts.length, pub.hits.length]).toEqual([5, 5, 5]);
  }, 30_000);
});
