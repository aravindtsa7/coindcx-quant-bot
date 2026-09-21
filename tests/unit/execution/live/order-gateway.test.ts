import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LiveFetchOrderRequest, LivePlaceOrderRequest } from '../../../../src/execution/live/gateway';
import { COINDCX_ORDER_MUTATION_ENDPOINTS } from '../../../../src/integration/coindcx/live/endpoints';
import {
  COINDCX_ORDER_OBSERVATION_MAX_PAGES,
  COINDCX_FUTURES_ORDER_CAPABILITIES,
  CoinDcxLiveFuturesOrderGateway,
} from '../../../../src/integration/coindcx/live/order-gateway';
import { LiveCreateRequestSchema } from '../../../../src/integration/coindcx/live/wire-schemas';

const API_KEY = 'unit-test-api-key';
const API_SECRET = 'unit-test-api-secret-value';
const CLIENT_ORDER_ID = `p17-${'a'.repeat(32)}`;
const PAIR = 'B-BTC_USDT';

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: unknown;
}

class StubVenue {
  public readonly requests: CapturedRequest[] = [];
  #server: http.Server | null = null;
  #responder: () => { status: number; body: string | null } = () => ({ status: 200, body: '{}' });
  #hang = false;
  public baseUrl = '';

  public async start(): Promise<void> {
    this.#server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        try { body = raw.length === 0 ? null : JSON.parse(raw); } catch { body = raw; }
        this.requests.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });
        if (this.#hang) return;
        const reply = this.#responder();
        response.writeHead(reply.status, { 'Content-Type': 'application/json' });
        response.end(reply.body ?? '');
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', () => {
      this.baseUrl = `http://127.0.0.1:${(this.#server?.address() as AddressInfo).port}`;
      resolve();
    }));
  }

  public respondJson(status: number, body: unknown): void {
    this.#hang = false;
    let responseCount = 0;
    this.#responder = () => ({ status, body: JSON.stringify(responseCount++ === 0 ? body : []) });
  }

  public respondSequence(...bodies: unknown[]): void {
    let index = 0;
    this.#responder = () => ({ status: 200, body: JSON.stringify(bodies[Math.min(index++, bodies.length - 1)]) });
  }

  public respondMalformed(): void { this.#responder = () => ({ status: 200, body: '{bad json' }); }
  public hang(): void { this.#hang = true; }
  public reset(): void { this.requests.length = 0; this.#hang = false; }
  public async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.#server === null) return resolve();
      this.#server.closeAllConnections?.();
      this.#server.close(() => resolve());
    });
  }
}

function order(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'venue-order-1',
    pair: PAIR,
    side: 'buy',
    status: 'initial',
    order_type: 'limit_order',
    price: '64000.5',
    avg_price: '0',
    total_quantity: '0.5',
    remaining_quantity: '0.5',
    cancelled_quantity: '0',
    leverage: '5',
    margin_currency_short_name: 'INR',
    settlement_currency_conversion_price: '89',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_500,
    ...overrides,
  };
}

function nonTargetOrders(count: number, prefix: string): readonly Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => order({ id: `${prefix}-${index}`, status: 'open' }));
}

function placeRequest(overrides: Partial<LivePlaceOrderRequest> = {}): LivePlaceOrderRequest {
  return {
    clientOrderId: CLIENT_ORDER_ID,
    pair: PAIR,
    side: 'BUY',
    wireOrderType: 'limit_order',
    quantity: '0.5',
    price: '64000.5',
    leverage: '5',
    settlementRateInrPerQuote: '89',
    timeInForce: 'UNSPECIFIED',
    timeoutMs: 2_000,
    ...overrides,
  };
}

function fetchRequest(overrides: Partial<LiveFetchOrderRequest> = {}): LiveFetchOrderRequest {
  return {
    clientOrderId: CLIENT_ORDER_ID,
    exchangeOrderId: 'venue-order-1',
    pair: PAIR,
    side: 'BUY',
    wireOrderType: 'limit_order',
    quantity: '0.5',
    price: '64000.5',
    settlementRateInrPerQuote: '89',
    marginCurrencyShortName: 'INR',
    timeoutMs: 2_000,
    ...overrides,
  };
}

const venue = new StubVenue();
let gateway: CoinDcxLiveFuturesOrderGateway;

beforeAll(async () => {
  await venue.start();
  gateway = new CoinDcxLiveFuturesOrderGateway({ apiKey: API_KEY, apiSecret: API_SECRET, baseUrl: venue.baseUrl });
});
afterAll(async () => venue.stop());
beforeEach(() => venue.reset());

describe('verified CoinDCX create contract and execution semantics', () => {
  it('posts the documented order envelope and never sends the local client identity', async () => {
    venue.respondJson(200, [order()]);
    expect((await gateway.placeOrder(placeRequest())).kind).toBe('ACCEPTED');
    const captured = venue.requests[0];
    expect(captured?.method).toBe('POST');
    expect(captured?.url).toBe(COINDCX_ORDER_MUTATION_ENDPOINTS.CREATE_ORDER.path);
    expect(captured?.headers['x-auth-apikey']).toBe(API_KEY);
    expect(captured?.headers['x-auth-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(captured?.body).toEqual({
      timestamp: expect.any(Number),
      order: {
        side: 'buy', pair: PAIR, order_type: 'limit_order', price: '64000.5', stop_price: null,
        total_quantity: '0.5', leverage: '5', notification: 'no_notification', margin_currency_short_name: 'INR',
      },
    });
    expect(JSON.stringify(captured?.body)).not.toContain(CLIENT_ORDER_ID);
  });

  it('rejects the old flat request shape in the executable contract', () => {
    expect(LiveCreateRequestSchema.safeParse({ timestamp: 1, pair: PAIR, side: 'buy', order_type: 'limit_order' }).success).toBe(false);
  });

  it.each([
    ['GOOD_TILL_CANCEL', 'good_till_cancel'],
    ['FILL_OR_KILL', 'fill_or_kill'],
    ['IMMEDIATE_OR_CANCEL', 'immediate_or_cancel'],
  ] as const)('preserves %s through to wire value %s', async (semantic, wireValue) => {
    venue.respondJson(200, [order()]);
    await gateway.placeOrder(placeRequest({ timeInForce: semantic }));
    const envelope = venue.requests[0]?.body as { order: Record<string, unknown> };
    expect(envelope.order['time_in_force']).toBe(wireValue);
  });

  it('has a fixed unsupported post-only capability and policy callers cannot cause a mutation', async () => {
    expect(COINDCX_FUTURES_ORDER_CAPABILITIES.supportsPostOnly).toBe(false);
    const result = await gateway.placeOrder(placeRequest({ timeInForce: 'POST_ONLY' }));
    expect(result).toEqual({ kind: 'PRE_DISPATCH_FAILURE', reasonCode: 'UNSUPPORTED_POST_ONLY' });
    expect(venue.requests).toHaveLength(0);
  });

  it('rejects time-in-force on MARKET before mutation', async () => {
    const result = await gateway.placeOrder(placeRequest({ wireOrderType: 'market_order', price: null, timeInForce: 'IMMEDIATE_OR_CANCEL' }));
    expect(result).toEqual({ kind: 'PRE_DISPATCH_FAILURE', reasonCode: 'INVALID_MARKET_TIME_IN_FORCE' });
    expect(venue.requests).toHaveLength(0);
  });

  it('accepts the documented initial acknowledgement and classifies client identity as local-only', async () => {
    venue.respondJson(200, [order()]);
    const result = await gateway.placeOrder(placeRequest());
    expect(result.kind).toBe('ACCEPTED');
    if (result.kind !== 'ACCEPTED') return;
    expect(result.observation.kind).toBe('ACKNOWLEDGED');
    expect(result.observation.exchangeOrderId).toBe('venue-order-1');
    expect(result.observation.clientOrderId).toBe(CLIENT_ORDER_ID);
    expect(result.observation.exchangeClientOrderId).toBeNull();
  });

  it('rejects a bare create object and a multi-order create response', async () => {
    venue.respondJson(200, order());
    expect(await gateway.placeOrder(placeRequest())).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_RESPONSE_INVALID' });
    venue.respondJson(200, [order(), order({ id: 'venue-order-2' })]);
    expect(await gateway.placeOrder(placeRequest())).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_RESPONSE_INVALID' });
  });

  it.each([
    ['pair', 'B-ETH_USDT'],
    ['side', 'sell'],
    ['order_type', 'market_order'],
    ['margin_currency_short_name', 'USDT'],
    ['settlement_currency_conversion_price', '90'],
    ['total_quantity', '9'],
    ['price', '64001'],
  ])('rejects a create acknowledgement with mismatched %s', async (field, value) => {
    venue.respondJson(200, [order({ [field]: value })]);
    expect(await gateway.placeOrder(placeRequest())).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_IDENTITY_MISMATCH' });
  });

  it('requires the documented cancelled quantity instead of fabricating zero', async () => {
    const { cancelled_quantity: _omitted, ...withoutCancelled } = order();
    venue.respondJson(200, [withoutCancelled]);
    expect(await gateway.placeOrder(placeRequest())).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_RESPONSE_INVALID' });
  });
});

describe('documented list-orders observation and hostile response validation', () => {
  it('uses list orders, never the inferred status route, and supplies documented filters', async () => {
    venue.respondJson(200, [order({ status: 'open' })]);
    expect((await gateway.fetchOrder(fetchRequest())).kind).toBe('FOUND');
    expect(venue.requests[0]?.url).toBe(COINDCX_ORDER_MUTATION_ENDPOINTS.LIST_ORDERS.path);
    expect(venue.requests[0]?.url).not.toContain('/status');
    expect(venue.requests[0]?.body).toEqual({
      timestamp: expect.any(Number), status: expect.stringContaining('partially_filled'), side: 'buy',
      page: '1', size: '200', margin_currency_short_name: ['INR'],
    });
  });

  it('handles zero exact exchange-id matches explicitly', async () => {
    venue.respondJson(200, [order({ id: 'different-order', status: 'open' })]);
    expect(await gateway.fetchOrder(fetchRequest())).toEqual({ kind: 'NOT_FOUND' });
    expect(venue.requests).toHaveLength(2);
  });

  it('continues after a 100-row short page and finds the exact target on page 2', async () => {
    venue.respondSequence(
      nonTargetOrders(100, 'page-1'),
      [order({ status: 'open' })],
      [],
    );
    expect((await gateway.fetchOrder(fetchRequest())).kind).toBe('FOUND');
    expect(venue.requests.map((request) => (request.body as { page: string }).page)).toEqual(['1', '2', '3']);
  });

  it('continues across multiple short non-empty pages until an empty page proves exhaustion', async () => {
    venue.respondSequence(
      [order({ id: 'page-1-other', status: 'open' })],
      [order({ id: 'page-2-other', status: 'open' })],
      [order({ status: 'open' })],
      [],
    );
    expect((await gateway.fetchOrder(fetchRequest())).kind).toBe('FOUND');
    expect(venue.requests).toHaveLength(4);
  });

  it('returns genuine NOT_FOUND only after a final empty page', async () => {
    venue.respondSequence(
      [order({ id: 'page-1-other', status: 'open' })],
      [order({ id: 'page-2-other', status: 'open' })],
      [],
    );
    expect(await gateway.fetchOrder(fetchRequest())).toEqual({ kind: 'NOT_FOUND' });
    expect(venue.requests).toHaveLength(3);
  });

  it('rejects multiple exact exchange-id matches as ambiguous and never uses element zero', async () => {
    venue.respondJson(200, [order({ status: 'open' }), order({ status: 'open' })]);
    expect(await gateway.fetchOrder(fetchRequest())).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_IDENTITY_AMBIGUOUS' });
  });

  it('rejects duplicate exact exchange identities appearing on different pages', async () => {
    venue.respondSequence(
      [order({ status: 'open' })],
      [order({ status: 'partially_filled', remaining_quantity: '0.4', avg_price: '64000.5' })],
      [],
    );
    expect(await gateway.fetchOrder(fetchRequest())).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_IDENTITY_AMBIGUOUS' });
    expect(venue.requests).toHaveLength(2);
  });

  it('bounds incremental page processing and reports guard exhaustion as ambiguity, never NOT_FOUND', async () => {
    venue.respondSequence([order({ id: 'always-not-the-target', status: 'open' })]);
    expect(await gateway.fetchOrder(fetchRequest())).toEqual({
      kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_OBSERVATION_PAGINATION_LIMIT',
    });
    expect(venue.requests).toHaveLength(COINDCX_ORDER_OBSERVATION_MAX_PAGES);
  });

  it.each([
    ['pair', 'B-ETH_USDT'],
    ['side', 'sell'],
    ['order_type', 'market_order'],
    ['margin_currency_short_name', 'USDT'],
    ['settlement_currency_conversion_price', '90'],
    ['total_quantity', '0.6'],
    ['price', '64001'],
  ])('rejects an observed order with mismatched immutable %s', async (field, value) => {
    venue.respondJson(200, [order({ status: 'open', [field]: value })]);
    expect(await gateway.fetchOrder(fetchRequest())).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_IDENTITY_MISMATCH' });
  });

  it.each([
    ['remaining_quantity', '-0.1'],
    ['cancelled_quantity', '-0.1'],
    ['remaining_quantity', '0.4', 'cancelled_quantity', '0.2'],
  ])('rejects impossible financial quantities', async (...parts: string[]) => {
    const overrides: Record<string, string> = { status: 'open' };
    for (let index = 0; index < parts.length; index += 2) overrides[parts[index]!] = parts[index + 1]!;
    venue.respondJson(200, [order(overrides)]);
    expect(await gateway.fetchOrder(fetchRequest())).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_IDENTITY_MISMATCH' });
  });

  it('cannot fabricate a fill when cancelled quantity is missing', async () => {
    const { cancelled_quantity: _omitted, ...hostile } = order({ status: 'cancelled', remaining_quantity: '0' });
    venue.respondJson(200, [hostile]);
    expect(await gateway.fetchOrder(fetchRequest())).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_RESPONSE_INVALID' });
  });

  it('maps documented partial-fill conservation exactly', async () => {
    venue.respondJson(200, [order({ status: 'partially_filled', remaining_quantity: '0.2', avg_price: '64000.25' })]);
    const result = await gateway.fetchOrder(fetchRequest());
    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.observation.cumulativeFilledQuantity).toBe('0.3');
    expect(result.observation.averageFillPrice).toBe('64000.25');
  });

  it('preserves executed quantity on partially-cancelled orders', async () => {
    venue.respondJson(200, [order({ status: 'partially_cancelled', remaining_quantity: '0', cancelled_quantity: '0.3', avg_price: '64000.25' })]);
    const result = await gateway.fetchOrder(fetchRequest());
    expect(result.kind).toBe('FOUND');
    if (result.kind !== 'FOUND') return;
    expect(result.observation.kind).toBe('CANCELLED');
    expect(result.observation.cumulativeFilledQuantity).toBe('0.2');
  });

  it('rejects a claimed full fill whose operands do not establish the full total', async () => {
    venue.respondJson(200, [order({ status: 'filled', remaining_quantity: '0.1', avg_price: '64000.25' })]);
    expect(await gateway.fetchOrder(fetchRequest())).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_IDENTITY_MISMATCH' });
  });

  it('fails closed on unknown provider status', async () => {
    venue.respondJson(200, [order({ status: 'mystery' })]);
    expect(await gateway.fetchOrder(fetchRequest())).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_RESPONSE_INVALID' });
  });
});

describe('mutation outcome and cancel contracts', () => {
  it('cancels only by exchange-confirmed id and does not send local client id', async () => {
    venue.respondJson(200, { message: 'success', status: 200, code: 200 });
    expect((await gateway.cancelOrder({ clientOrderId: CLIENT_ORDER_ID, exchangeOrderId: 'venue-order-1', pair: PAIR, timeoutMs: 2_000 })).kind).toBe('CANCEL_ACCEPTED');
    expect(venue.requests[0]?.body).toEqual({ timestamp: expect.any(Number), id: 'venue-order-1' });
  });

  it('requires the documented cancel acknowledgement', async () => {
    venue.respondJson(200, { message: 'maybe' });
    expect(await gateway.cancelOrder({ clientOrderId: CLIENT_ORDER_ID, exchangeOrderId: 'venue-order-1', pair: PAIR, timeoutMs: 2_000 }))
      .toEqual({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_RESPONSE_INVALID' });
  });

  it('uses the same short-page-safe observation after cancellation', async () => {
    venue.respondJson(200, { message: 'success', status: 200, code: 200 });
    expect((await gateway.cancelOrder({ clientOrderId: CLIENT_ORDER_ID, exchangeOrderId: 'venue-order-1', pair: PAIR, timeoutMs: 2_000 })).kind)
      .toBe('CANCEL_ACCEPTED');
    venue.respondSequence(
      nonTargetOrders(100, 'cancel-page-1'),
      [order({ status: 'cancelled', remaining_quantity: '0', cancelled_quantity: '0.5' })],
      [],
    );
    const observed = await gateway.fetchOrder(fetchRequest());
    expect(observed.kind).toBe('FOUND');
    if (observed.kind === 'FOUND') expect(observed.observation.kind).toBe('CANCELLED');
    expect(venue.requests.slice(1).map((request) => (request.body as { page: string }).page)).toEqual(['1', '2', '3']);
  });

  it('requires a documented error body before classifying a 4xx refusal', async () => {
    venue.respondJson(400, { message: 'invalid quantity' });
    expect(await gateway.placeOrder(placeRequest())).toEqual({ kind: 'REJECTED', reasonCode: 'HTTP_400', observation: null });
    venue.respondJson(400, { unexpected: true });
    expect(await gateway.placeOrder(placeRequest())).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_ERROR_RESPONSE_INVALID' });
  });

  it('keeps timeout and 5xx outcomes ambiguous', async () => {
    venue.respondJson(503, { message: 'unavailable' });
    expect(await gateway.placeOrder(placeRequest())).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'HTTP_503' });
    venue.hang();
    expect(await gateway.placeOrder(placeRequest({ timeoutMs: 100 }))).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
  });

  it('fails closed on malformed JSON', async () => {
    venue.respondMalformed();
    expect((await gateway.placeOrder(placeRequest())).kind).toBe('AMBIGUOUS');
  });

  it('never returns credentials or signatures', async () => {
    const syntheticSignature = 'f'.repeat(64);
    venue.respondJson(500, {
      message: JSON.stringify({
        apiKey: API_KEY,
        apiSecret: API_SECRET,
        authorization: `Bearer ${API_KEY}`,
        signature: syntheticSignature,
        signedRequest: '{"timestamp":1,"order":{"pair":"B-BTC_USDT"}}',
      }),
    });
    const result = await gateway.placeOrder(placeRequest());
    const serialized = JSON.stringify(result);
    for (const sensitive of [API_KEY, API_SECRET, syntheticSignature, 'Bearer', 'signedRequest', 'timestamp']) {
      expect(serialized).not.toContain(sensitive);
    }
    expect(result).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'HTTP_500' });
  });
});

describe('closed endpoint surface', () => {
  it('contains create, cancel, and documented list observation only', () => {
    expect(Object.keys(COINDCX_ORDER_MUTATION_ENDPOINTS).sort()).toEqual(['CANCEL_ORDER', 'CREATE_ORDER', 'LIST_ORDERS']);
    expect(Object.isFrozen(COINDCX_ORDER_MUTATION_ENDPOINTS)).toBe(true);
    expect(Object.values(COINDCX_ORDER_MUTATION_ENDPOINTS).every((entry) => entry.method === 'POST')).toBe(true);
  });
});
