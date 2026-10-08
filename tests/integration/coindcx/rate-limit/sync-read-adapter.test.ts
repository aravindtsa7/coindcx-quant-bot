import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveExecutionAuthority } from '../../../../src/execution/live/authority';
import { PracticalRecoveryCertificate } from '../../../../src/execution/live/practical/certificate';
import type { PrivateStreamObservation } from '../../../../src/execution/live/practical-observation/assessment';
import { runAsyncSynchronizationCandidate, type AsyncClock } from '../../../../src/execution/live/practical-synchronization/async-orchestrator';
import { GRANTS_NOTHING, type SynchronizationConfig } from '../../../../src/execution/live/practical-synchronization/engine';
import { currentAccountContinuityCapability } from '../../../../src/execution/live/reconciliation/barrier';
import { CoinDcxClient } from '../../../../src/integration/coindcx/client';
import { createCoinDcxSyncReadAdapter, SYNC_READ_FIELD_PROVENANCE, type SyncReadAdapterReport, type SyncReadRequest } from '../../../../src/integration/coindcx/live/sync-read-adapter';
import { RateLimitClient } from '../../../../src/integration/coindcx/rate-limit/runtime/client';
import { RateLimitCoordinator } from '../../../../src/integration/coindcx/rate-limit/runtime/coordinator';
import { createCoordinatorReadBudget, type TransportReadBudget } from '../../../../src/integration/coindcx/rate-limit/runtime/read-budget';
import { fixtureTransportBudget } from '../../../helpers/read-budget-fixture';
import { cleanup, clientConfig, fixture, limiterFixture, waitFor } from './support';

// M4 read adapter (unwired review candidate): adapter -> M2-budgeted CoinDcxClient -> transport -> loopback venue ->
// engine normalization -> assessment. Synthetic credentials and payloads only; no provider, external network or database.
const stops: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); cleanup(); });
const ACCOUNT = 'synthetic-account';
const STATUSES = ['open', 'filled', 'partially_filled', 'partially_cancelled', 'cancelled', 'rejected', 'untriggered'];
const ORDERS_PATH = '/exchange/v1/derivatives/futures/orders';
const POSITIONS_PATH = '/exchange/v1/derivatives/futures/positions';
const TIMEOUT = 60_000;

function orderWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'ex-1', pair: 'B-BTC_USDT', side: 'buy', status: 'open', order_type: 'limit_order', leverage: '5', price: '64000.5', avg_price: null,
    total_quantity: '0.5', remaining_quantity: '0.5', cancelled_quantity: '0', margin_currency_short_name: 'INR', created_at: 1_000, updated_at: 1_500,
    client_order_id: 'bot-0001', ...overrides };
}
function positionWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'pos-1', pair: 'B-BTC_USDT', active_pos: '0.5', avg_price: '64000.5', locked_margin: '1100.0', locked_user_margin: '1000.0', locked_order_margin: '100.0',
    maintenance_margin: '50.0', mark_price: '64100.0', margin_type: 'isolated', settlement_currency_avg_price: '89.5', margin_currency_short_name: 'INR',
    leverage: '5', updated_at: 1_600, ...overrides };
}

type Answer = { status: number; body: unknown; headers?: Record<string, string> } | Promise<{ status: number; body: unknown; headers?: Record<string, string> }>;
interface Venue { url: string; hits: Array<{ path: string; body: Record<string, unknown> }>; respond: (path: string, body: Record<string, unknown>) => Answer }
/** Default: buy page 1 has ex-1, every other orders page is empty; positions page 1 has pos-1, page 2 is empty. */
function defaultAnswer(path: string, body: Record<string, unknown>): Answer {
  if (path === ORDERS_PATH) return { status: 200, body: body['side'] === 'buy' && body['page'] === '1' ? [orderWire()] : [] };
  if (path === POSITIONS_PATH) return { status: 200, body: body['page'] === '1' ? [positionWire()] : [] };
  return { status: 404, body: { message: 'unexpected path' } };
}
async function startVenue(): Promise<Venue> {
  const state: Venue = { url: '', hits: [], respond: defaultAnswer };
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]!;
      const body = raw.length > 0 ? JSON.parse(raw) as Record<string, unknown> : {};
      state.hits.push({ path, body });
      void Promise.resolve(state.respond(path, body)).then((answer) => {
        res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers ?? {}) }); res.end(JSON.stringify(answer.body));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stops.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return state;
}

class ManualClock implements AsyncClock {
  public nowMs = 10_000;
  readonly #waiters: Array<{ due: number; resolve: () => void }> = [];
  public now(): number { return this.nowMs; }
  public delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('aborted')); return; }
      const waiter = { due: this.nowMs + ms, resolve };
      this.#waiters.push(waiter);
      signal.addEventListener('abort', () => { this.#waiters.splice(this.#waiters.indexOf(waiter), 1); reject(new Error('aborted')); }, { once: true });
    });
  }
  public advance(ms: number): void {
    this.nowMs += ms;
    for (const waiter of this.#waiters.filter((entry) => entry.due <= this.nowMs)) { this.#waiters.splice(this.#waiters.indexOf(waiter), 1); waiter.resolve(); }
  }
}

function stream(overrides: Partial<PrivateStreamObservation> = {}): PrivateStreamObservation {
  return { connected: true, epoch: 7, epochAtWindowStart: 7, disconnectObservedSinceWindowStart: false, reconnectLatched: false,
    joinAcknowledgement: { kind: 'UNKNOWN' }, events: [], bufferedUnprocessedEvents: 0, ...overrides };
}
function config(overrides: Partial<SynchronizationConfig> = {}, scope: Partial<SynchronizationConfig['scope']> = {}): SynchronizationConfig {
  return {
    mode: 'FULL_EVIDENCE',
    scope: { accountId: ACCOUNT, components: ['ORDERS', 'POSITIONS'], requiredAccounting: [], history: { kind: 'AVAILABLE_HISTORY' }, ...scope },
    scanLimits: { ORDERS: { pageSize: 2, maxPages: 3 }, POSITIONS: { pageSize: 2, maxPages: 3 }, TRANSACTIONS: { pageSize: 2, maxPages: 3 } },
    thresholds: { maxEvidenceAgeMs: 5_000, maxTotalReadDurationMs: 2_000 },
    maxCycles: 1,
    lineage: { ownedOrders: [{ exchangeOrderId: 'ex-1', intentId: 'intent-1' }], ambiguousCreates: [], closedIntentTags: [], ownedPositions: ['pos-1'], botTagNamespace: 'bot-' },
    contracts: { tagContract: { confirmed: false }, venueGeneratedOrderTypes: null, venueGeneratedWalletStages: null, terminalShortPage: {} },
    ...overrides,
  };
}

async function harness(options: { readBudget?: TransportReadBudget | null; provenance?: { kind: 'CREDENTIAL_BOUND'; accountId: string } | { kind: 'UNKNOWN' } } = {}) {
  const venue = await startVenue();
  const clock = new ManualClock();
  const readBudget = options.readBudget === undefined ? fixtureTransportBudget() : options.readBudget;
  const client = new CoinDcxClient({ apiKey: 'synthetic-sync-key', apiSecret: 'synthetic-sync-secret', baseUrl: venue.url, ...(readBudget === null ? {} : { readBudget }) });
  const adapter = createCoinDcxSyncReadAdapter({ client, accountProvenance: options.provenance ?? { kind: 'CREDENTIAL_BOUND', accountId: ACCOUNT }, orderStatuses: STATUSES, clock })!;
  const run = (c: SynchronizationConfig = config(), signal?: AbortSignal) => runAsyncSynchronizationCandidate({
    config: c, limits: { readTimeoutMs: 1_000, streamTimeoutMs: 1_000 }, clock, ...(signal === undefined ? {} : { signal }),
    source: { scan: (request) => adapter.scan(request as unknown as SyncReadRequest), observeStream: async () => stream(), subscribeEvents: () => () => undefined },
  });
  const request = (component: string, overrides: Partial<SyncReadRequest> = {}): SyncReadRequest => ({
    binding: { accountId: ACCOUNT, scopeId: 'scope-1', cycle: 0, pass: 0, component, epoch: 7, requestId: `0:0:${component}` },
    limits: { pageSize: 2, maxPages: 3 }, history: { kind: 'AVAILABLE_HISTORY' }, signal: new AbortController().signal, ...overrides,
  });
  return { venue, clock, client, adapter, run, request };
}
const reportOf = (response: unknown): SyncReadAdapterReport => (response as { adapter: SyncReadAdapterReport }).adapter;
const scanOf = (response: unknown): Record<string, unknown> => (response as { scan: Record<string, unknown> }).scan;

describe('M4 read adapter: end to end over the budgeted read client and a loopback venue', () => {
  it('adapter -> budgeted primitive -> loopback -> normalization -> assessment: observed convergence; orders read per side, bounded', async () => {
    const h = await harness();
    const result = await h.run();
    expect(result.status).toBe('OBSERVED_CONVERGENCE');
    // Per pass: orders buy page 1 and 2 (empty), sell page 1 (empty); positions page 1 and 2 (empty).
    const perPass = [`${ORDERS_PATH} buy 1`, `${ORDERS_PATH} buy 2`, `${ORDERS_PATH} sell 1`, `${POSITIONS_PATH} - 1`, `${POSITIONS_PATH} - 2`];
    expect(h.venue.hits.map((hit) => `${hit.path} ${String(hit.body['side'] ?? '-')} ${String(hit.body['page'])}`).sort()).toEqual([...perPass, ...perPass].sort());
    const ordersHit = h.venue.hits.find((hit) => hit.path === ORDERS_PATH)!;
    expect(ordersHit.body).toMatchObject({ status: STATUSES.join(','), size: '2', margin_currency_short_name: ['INR'] });
    expect(Object.keys(ordersHit.body)).not.toEqual(expect.arrayContaining(['from_date', 'to_date']));
    const records = result.cycles[0]!.engine!.records.flatMap((entry) => entry.records);
    expect(records.find((r) => r.key === 'order:ex-1')).toMatchObject({ ownership: 'OWNED', reason: 'BOT_CREATE_RESPONSE', occurrences: [{ segment: 'side=buy', page: 0, position: 0 }] });
    expect(records.find((r) => r.key === 'order:ex-1')?.fingerprint).toContain('client_order_id="bot-0001"');
    expect(result.grants).toBe(GRANTS_NOTHING);
  }, TIMEOUT);

  it('the adapter report keeps per-page provenance, segment stops, field provenance and the explicit limitations', async () => {
    const h = await harness();
    const report = reportOf(await h.adapter.scan(h.request('ORDERS')));
    expect(report).toMatchObject({
      support: 'SUPPORTED', endpoint: 'FUTURES_ORDERS', orderStatuses: STATUSES,
      correlation: { kind: 'ADAPTER_LOCAL_ECHO', providerReturnedIdentity: 'NONE' },
      accountProvenance: { source: 'AUTHENTICATED_CLIENT_CREDENTIAL_BINDING', status: 'BOUND', providerAccountProof: 'NOT_IN_READ_RESPONSES' },
      dateFilter: 'NOT_REQUESTED', historyCompleteness: 'UNKNOWN', terminalShortPage: 'NOT_ASSUMED_CONTINUED_TO_EMPTY_PAGE_OR_BOUND',
      cancellation: 'NOT_FORWARDABLE_TO_READ_PRIMITIVE_RESULT_ABANDONED', failure: null, gaps: [],
    });
    expect(report.pages.map((p) => `${p.segment}:${p.page}:${p.records}`)).toEqual(['side=buy:1:1', 'side=buy:2:0', 'side=sell:1:0']);
    expect(report.stops).toEqual([{ segment: 'side=buy', stop: 'EMPTY_PAGE' }, { segment: 'side=sell', stop: 'EMPTY_PAGE' }]);
    expect(report.fieldProvenance).toBe(SYNC_READ_FIELD_PROVENANCE.ORDERS);
    expect(SYNC_READ_FIELD_PROVENANCE.ORDERS.find((f) => f.providerField === 'client_id')).toEqual({ field: '(none)', providerField: 'client_id', basis: 'NOT_EXPOSED_BY_COMMITTED_READ_PATH', providerSemantics: 'NOT_CONFIRMED' });
    expect([...SYNC_READ_FIELD_PROVENANCE.ORDERS, ...SYNC_READ_FIELD_PROVENANCE.POSITIONS].every((f) => f.providerSemantics === 'NOT_CONFIRMED')).toBe(true);
    // A declared window cannot be applied by these endpoints: it is reported, and nothing is filtered.
    const windowed = reportOf(await h.adapter.scan(h.request('ORDERS', { history: { kind: 'DECLARED_WINDOW', fromMs: 0, toMs: 9_000 } })));
    expect(windowed.dateFilter).toBe('UNSUPPORTED_BY_ENDPOINT_NOT_APPLIED');
  }, TIMEOUT);

  it('a raw client_id field from the provider is not exposed by the committed path and is never renamed into client_order_id', async () => {
    const h = await harness();
    h.venue.respond = (path, body) => (path === ORDERS_PATH && body['side'] === 'buy' && body['page'] === '1'
      ? { status: 200, body: [orderWire({ client_order_id: null, client_id: 'bot-0001' })] } : defaultAnswer(path, body));
    const response = await h.adapter.scan(h.request('ORDERS'));
    const segments = scanOf(response)['segments'] as Array<{ pages: Array<Array<Record<string, unknown>>> }>;
    expect(segments[0]!.pages[0]![0]!['clientOrderId']).toBeNull();
  }, TIMEOUT);
});

describe('M4 read adapter: budget, pagination and malformed payloads', () => {
  it('a missing or unavailable budget produces zero HTTP and an explicit failure', async () => {
    const missing = await harness({ readBudget: null });
    const response = await missing.adapter.scan(missing.request('ORDERS'));
    expect(scanOf(response)).toEqual({ kind: 'FAILED' });
    expect(reportOf(response).failure).toMatchObject({ segment: 'side=buy', page: 1 });
    expect(missing.venue.hits).toEqual([]);
    const offline = new RateLimitClient(clientConfig(fixture().pipe)); stops.push(() => offline.close());
    const unavailable = await harness({ readBudget: { budget: createCoordinatorReadBudget(offline, { cls: 'P1', deadlineInMs: 500 }), scope: 'API_AUTH' } });
    expect((await unavailable.run()).status).toBe('UNRESOLVED');
    expect(unavailable.venue.hits).toEqual([]);
  }, TIMEOUT);

  it('a short page is not treated as terminal: reading continues, and records after it are kept and unresolved', async () => {
    const h = await harness();
    h.venue.respond = (path, body) => {
      if (path !== ORDERS_PATH || body['side'] !== 'buy') return defaultAnswer(path, body);
      return { status: 200, body: body['page'] === '1' ? [orderWire()] : body['page'] === '2' ? [orderWire({ id: 'ex-2', client_order_id: 'bot-0002' })] : [] };
    };
    const report = reportOf(await h.adapter.scan(h.request('ORDERS')));
    expect(report.pages.filter((p) => p.segment === 'side=buy').map((p) => p.records)).toEqual([1, 1, 0]);
    const result = await h.run();
    expect(result.status).toBe('UNRESOLVED');
    expect(result.cycles[0]!.engine!.reasons).toEqual(expect.arrayContaining(['RECORDS_AFTER_SHORT_PAGE']));
    expect(result.cycles[0]!.engine!.records.flatMap((e) => e.records).map((r) => r.key)).toEqual(expect.arrayContaining(['order:ex-1', 'order:ex-2']));
  }, TIMEOUT);

  it('full pages up to the bound stop at the bound (never the unlimited history) and are truncation', async () => {
    const h = await harness();
    let counter = 0;
    h.venue.respond = (path, body) => (path === ORDERS_PATH && body['side'] === 'buy'
      ? { status: 200, body: [orderWire({ id: `ex-f${counter += 1}` }), orderWire({ id: `ex-f${counter += 1}` })] } : defaultAnswer(path, body));
    const report = reportOf(await h.adapter.scan(h.request('ORDERS')));
    expect(report.stops[0]).toEqual({ segment: 'side=buy', stop: 'SCAN_BOUND' });
    expect(h.venue.hits.filter((hit) => hit.path === ORDERS_PATH && hit.body['side'] === 'buy')).toHaveLength(3);
    const result = await h.run();
    expect(result.cycles[0]!.engine!.reasons).toEqual(expect.arrayContaining(['SCAN_BOUNDARY_REACHED', 'PAGINATION_TRUNCATED']));
  }, TIMEOUT);

  it('a malformed payload fails the committed validation and is an explicit read failure; a missing optional quantity is an explicit gap', async () => {
    const h = await harness();
    h.venue.respond = (path, body) => (path === POSITIONS_PATH ? { status: 200, body: { not: 'an array' } } : defaultAnswer(path, body));
    const malformed = await h.adapter.scan(h.request('POSITIONS'));
    expect(scanOf(malformed)).toEqual({ kind: 'FAILED' });
    expect(reportOf(malformed).failure).toEqual({ segment: 'all', page: 1, errorName: 'CoinDcxResponseValidationError' });
    h.venue.respond = (path, body) => (path === ORDERS_PATH && body['side'] === 'buy' && body['page'] === '1'
      ? { status: 200, body: [orderWire({ cancelled_quantity: undefined })] } : defaultAnswer(path, body));
    const gap = reportOf(await h.adapter.scan(h.request('ORDERS')));
    expect(gap.gaps).toEqual([{ segment: 'side=buy', page: 1, key: 'order:ex-1', field: 'cancelled_quantity', gap: 'MISSING' }]);
    expect((await h.run()).cycles[0]!.engine!.reasons).toContain('RECORD_MALFORMED');
  }, TIMEOUT);
});

describe('M4 read adapter: account provenance, correlation, unsupported components and cumulative limits', () => {
  it('unknown provenance is ACCOUNT_SCOPE_UNKNOWN; a credential bound to another account is a mismatch; the echoed binding is only local correlation', async () => {
    const unknown = await harness({ provenance: { kind: 'UNKNOWN' } });
    expect((await unknown.run()).cycles[0]!.engine!.reasons).toEqual(['ACCOUNT_SCOPE_UNKNOWN']);
    const other = await harness({ provenance: { kind: 'CREDENTIAL_BOUND', accountId: 'another-account' } });
    expect((await other.run()).cycles[0]!.engine!.reasons).toEqual(['ACCOUNT_SCOPE_MISMATCH']);
    const response = await other.adapter.scan(other.request('POSITIONS')) as { binding: unknown; adapter: SyncReadAdapterReport };
    expect(response.binding).toEqual(other.request('POSITIONS').binding); // echoed as given; not provider proof
    expect(response.adapter.accountProvenance.status).toBe('MISMATCH');
    expect(response.adapter.correlation).toEqual({ kind: 'ADAPTER_LOCAL_ECHO', providerReturnedIdentity: 'NONE' });
  }, TIMEOUT);

  it('TRANSACTIONS is CLIENT_ADAPTER_UNSUPPORTED: an explicit failure that keeps a requiring scope unresolved, never another endpoint substituted', async () => {
    const h = await harness();
    const response = await h.adapter.scan(h.request('TRANSACTIONS'));
    expect(scanOf(response)).toEqual({ kind: 'FAILED' });
    expect(reportOf(response)).toMatchObject({ support: 'UNSUPPORTED', unsupportedReason: 'CLIENT_ADAPTER_UNSUPPORTED', endpoint: null });
    // The label is about this client path: not evidence that the provider lacks transaction history or fill ids, and
    // observing transaction records is a separate question from confirmed fill-level reconstruction.
    expect(reportOf(response).unsupportedScope).toEqual({
      meaning: 'NOT_EVIDENCE_THAT_THE_PROVIDER_LACKS_TRANSACTION_HISTORY_OR_FILL_IDENTIFIERS',
      transactionRecordObservation: 'NOT_IMPLEMENTED_BY_THIS_ADAPTER',
      fillLevelReconstruction: 'UNRESOLVED_STABLE_FILL_SEMANTICS_UNCONFIRMED',
      substitution: 'NONE',
    });
    const unknown = reportOf(await h.adapter.scan(h.request('WALLET')));
    expect(unknown.unsupportedReason).toBe('UNKNOWN_COMPONENT');
    expect(unknown.unsupportedScope).toBeUndefined();
    expect(h.venue.hits).toEqual([]);
    const result = await h.run(config({ mode: 'CUMULATIVE_STATE' }, { components: ['ORDERS', 'TRANSACTIONS'] }));
    expect(result.status).toBe('UNRESOLVED');
    expect(result.cycles[0]!.engine!.reasons).toContain('READ_FAILED');
  }, TIMEOUT);

  it('cumulative order and position state can converge while fill-level accounting stays UNKNOWN', async () => {
    const h = await harness();
    const result = await h.run(config({ mode: 'CUMULATIVE_STATE' }));
    expect(result.status).toBe('OBSERVED_CONVERGENCE');
    expect(result.cycles[0]!.engine!.assessment.fillLevelAccounting).toEqual({ completeFillReconstruction: 'UNKNOWN', exactlyOnceExecutionAccounting: 'UNKNOWN',
      feeAccounting: 'UNKNOWN', reasons: ['STABLE_FILL_ID_CONTRACT_UNRESOLVED', 'CUMULATIVE_STATE_MODE'] });
  }, TIMEOUT);

  it('ownership rules are unchanged: a bot-looking tag without durable lineage stays UNRESOLVED', async () => {
    const h = await harness();
    h.venue.respond = (path, body) => (path === ORDERS_PATH && body['side'] === 'sell' && body['page'] === '1'
      ? { status: 200, body: [orderWire({ id: 'ex-9', side: 'sell', client_order_id: 'bot-9999' })] } : defaultAnswer(path, body));
    const result = await h.run();
    expect(result.cycles[0]!.engine!.records.flatMap((e) => e.records).find((r) => r.key === 'order:ex-9')).toMatchObject({ ownership: 'UNRESOLVED', reason: 'TAG_WITHOUT_DURABLE_INTENT' });
    expect(result.status).toBe('UNRESOLVED');
  }, TIMEOUT);
});

describe('M4 read adapter: cancellation, timeout, late responses and 429 through the shared coordinator', () => {
  async function coordinatorBudget(options: Record<string, unknown> = {}) {
    const f = fixture(limiterFixture(options));
    const started = await RateLimitCoordinator.start(f.coordinator);
    if (started.kind !== 'RUNNING') throw new Error(JSON.stringify(started));
    stops.push(() => started.coordinator.close());
    const c = new RateLimitClient(clientConfig(f.pipe)); stops.push(() => c.close());
    expect(await c.connect()).toBe(true);
    return { coordinator: started.coordinator, budget: { budget: createCoordinatorReadBudget(c, { cls: 'P1', deadlineInMs: 500 }), scope: 'API_AUTH' as const } };
  }

  it('an orchestrator timeout abandons the in-flight page: no further page is read, and its budget charge is held until the request completes', async () => {
    const limiter = await coordinatorBudget();
    const h = await harness({ readBudget: limiter.budget });
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    h.venue.respond = (path, body) => (path === ORDERS_PATH && body['side'] === 'buy' && body['page'] === '1'
      ? held.then(() => ({ status: 200, body: [orderWire()] })) : defaultAnswer(path, body));
    const run = h.run();
    await waitFor(() => h.venue.hits.some((hit) => hit.path === ORDERS_PATH), 5_000, 'orders page 1 in flight');
    h.clock.advance(1_000); // the orchestrator's read timeout on the injected clock
    const result = await run;
    expect(result.status).toBe('UNRESOLVED');
    expect(result.cycles[0]!.orchestrationReasons).toContain('READ_TIMEOUT');
    expect(limiter.coordinator.state.charges.length).toBeGreaterThan(0); // the active request keeps its capacity
    const ordersHits = h.venue.hits.filter((hit) => hit.path === ORDERS_PATH).length;
    release();
    await waitFor(() => limiter.coordinator.state.charges.length === 0, 5_000, 'charge settled when the request completed');
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    expect(h.venue.hits.filter((hit) => hit.path === ORDERS_PATH)).toHaveLength(ordersHits); // the abandoned scan read no further page
  }, TIMEOUT);

  it('cancellation stops further page reads and reports the limitation; a late page result is abandoned', async () => {
    const h = await harness();
    const controller = new AbortController();
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    h.venue.respond = (path, body) => (path === ORDERS_PATH && body['page'] === '1' && body['side'] === 'buy' ? held.then(() => ({ status: 200, body: [orderWire()] })) : defaultAnswer(path, body));
    const pending = h.adapter.scan(h.request('ORDERS', { signal: controller.signal }));
    await waitFor(() => h.venue.hits.length === 1, 5_000, 'first page in flight');
    controller.abort();
    release();
    const response = await pending;
    expect(scanOf(response)).toEqual({ kind: 'FAILED' });
    expect(reportOf(response).stops).toEqual([{ segment: 'side=buy', stop: 'CANCELLED' }]);
    expect(reportOf(response).pages).toEqual([]); // the late page result was abandoned, not recorded
    expect(reportOf(response).cancellation).toBe('NOT_FORWARDABLE_TO_READ_PRIMITIVE_RESULT_ABANDONED');
    expect(h.venue.hits).toHaveLength(1);
  }, TIMEOUT);

  it('a 429 is reported to the shared coordinator, and the throttle stops further reads: no request storm', async () => {
    const limiter = await coordinatorBudget({ retryAfter: { noHeaderDefaultMs: 60_000, providerStatedBlockMs: 60_000, localBackoffBaseMs: 60_000, localBackoffMaxMs: 60_000, operationalCapMs: 600_000, clockUncertaintyMs: 100 } });
    const h = await harness({ readBudget: limiter.budget });
    h.venue.respond = (path) => (path === ORDERS_PATH ? { status: 429, body: { message: 'too many requests' }, headers: { 'retry-after': '60' } } : { status: 200, body: [] });
    const result = await h.run(config({}, { components: ['ORDERS'] }));
    expect(result.status).toBe('UNRESOLVED');
    await waitFor(() => limiter.coordinator.state.scopes.API_AUTH.kind !== 'CLEAR', 5_000, 'throttle recorded');
    expect(h.venue.hits).toHaveLength(1); // pass 1 was refused by the throttled budget before any request
  }, TIMEOUT);
});

describe('M4 read adapter: configuration and grants', () => {
  it('invalid adapter configuration is refused (no defaults)', async () => {
    const venue = await startVenue();
    const client = new CoinDcxClient({ apiKey: 'synthetic-sync-key', apiSecret: 'synthetic-sync-secret', baseUrl: venue.url, readBudget: fixtureTransportBudget() });
    const clock = new ManualClock();
    for (const options of [
      { client, accountProvenance: { kind: 'CREDENTIAL_BOUND' as const, accountId: ACCOUNT }, orderStatuses: [], clock },
      { client, accountProvenance: { kind: 'CREDENTIAL_BOUND' as const, accountId: '' }, orderStatuses: STATUSES, clock },
      { client, accountProvenance: { kind: 'GUESSED' } as never, orderStatuses: STATUSES, clock },
      { client, accountProvenance: { kind: 'UNKNOWN' as const }, orderStatuses: ['open; DROP'], clock },
    ]) expect(createCoinDcxSyncReadAdapter(options)).toBeNull();
  }, TIMEOUT);

  it('no outcome grants authority', async () => {
    const h = await harness();
    const results = [await h.run(), await h.run(config({}, { components: ['TRANSACTIONS'] }))];
    for (const result of results) {
      expect(result.grants).toBe(GRANTS_NOTHING);
      for (const candidate of [result, ...result.cycles]) {
        expect(LiveExecutionAuthority.read(candidate)).toBeNull();
        expect(PracticalRecoveryCertificate.read(candidate)).toBeNull();
      }
    }
    expect(currentAccountContinuityCapability()).toBe('REST_CURRENT_STATE_OBSERVED');
  }, TIMEOUT);
});
