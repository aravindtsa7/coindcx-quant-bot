import http from 'node:http';
import { LosslessNumber } from 'lossless-json';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LiveFetchOrderRequest, LivePlaceOrderRequest } from '../../../../src/execution/live/gateway';
import { COINDCX_ORDER_MUTATION_ENDPOINTS } from '../../../../src/integration/coindcx/live/endpoints';
import {
  COINDCX_DUPLICATE_CLIENT_ORDER_ID_SIGNAL,
  COINDCX_ORDER_OBSERVATION_MAX_PAGES,
  COINDCX_FUTURES_ORDER_CAPABILITIES,
  CoinDcxLiveFuturesOrderGateway,
  classifyCreateFailure,
  classifyCreateHttpFailure,
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
  it('posts the documented order envelope carrying the persisted client_order_id (provider-confirmed, <=36)', async () => {
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
        client_order_id: CLIENT_ORDER_ID,
      },
    });
    expect(CLIENT_ORDER_ID).toHaveLength(36);
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

  it('[PROVIDER-IDEMP-01] never records an unclassified create 4xx as a terminal refusal', async () => {
    // Formerly REJECTED. A 4xx may be the unconfirmed duplicate-client_order_id
    // rejection, i.e. proof an earlier create landed, so it must stay ambiguous.
    venue.respondJson(400, { message: 'invalid quantity' });
    expect(await gateway.placeOrder(placeRequest())).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'HTTP_400' });
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

describe('provider-confirmed client_order_id on the create and read paths', () => {
  it.each([
    ['37 characters', `${CLIENT_ORDER_ID}a`],
    ['not the frozen format', 'client-order-1'],
    ['uppercase', CLIENT_ORDER_ID.toUpperCase()],
    ['empty', ''],
  ])('refuses a client order id that is %s before any request is sent', async (_label, clientOrderId) => {
    const result = await gateway.placeOrder(placeRequest({ clientOrderId }));
    expect(result).toEqual({ kind: 'PRE_DISPATCH_FAILURE', reasonCode: 'LIVE_CLIENT_ORDER_ID_INVALID' });
    expect(venue.requests).toHaveLength(0);
  });

  it('the executable create contract requires client_order_id and enforces the 36-character limit', () => {
    const envelope = {
      timestamp: 1,
      order: {
        side: 'buy', pair: PAIR, order_type: 'limit_order', price: '1', stop_price: null, total_quantity: '1',
        notification: 'no_notification', margin_currency_short_name: 'INR', client_order_id: CLIENT_ORDER_ID,
      },
    };
    expect(LiveCreateRequestSchema.safeParse(envelope).success).toBe(true);
    const { client_order_id: _omitted, ...withoutId } = envelope.order;
    expect(LiveCreateRequestSchema.safeParse({ ...envelope, order: withoutId }).success).toBe(false);
    expect(LiveCreateRequestSchema.safeParse({ ...envelope, order: { ...envelope.order, client_order_id: `${CLIENT_ORDER_ID}a` } }).success).toBe(false);
  });

  it('no duplicate error code is guessed: the pinned signal is null and nothing classifies as duplicate', () => {
    expect(COINDCX_DUPLICATE_CLIENT_ORDER_ID_SIGNAL).toBeNull();
    for (const body of [
      { message: 'Duplicate client_order_id', code: 400 },
      { message: 'client order id already exists', code: 'DUPLICATE' },
      { message: 'duplicate' },
    ]) {
      expect(classifyCreateFailure(400, body)).toBe('UNCLASSIFIED');
      expect(classifyCreateFailure(422, body)).toBe('UNCLASSIFIED');
    }
  });

  it('an unknown provider error is never assumed to be a duplicate, even when its message says so', async () => {
    venue.respondJson(400, { message: 'Duplicate client_order_id: order already exists', code: 'E_DUP' });
    const withStringCode = await gateway.placeOrder(placeRequest());
    expect(withStringCode.kind).not.toBe('DUPLICATE_CLIENT_ORDER_ID');
    expect(withStringCode).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'HTTP_400' });

    // A numeric code arrives lossless-parsed; the existing error contract
    // treats that body as unestablished (AMBIGUOUS). Still never a duplicate.
    venue.reset();
    venue.respondJson(400, { message: 'Duplicate client_order_id: order already exists', code: 400 });
    const withNumericCode = await gateway.placeOrder(placeRequest());
    expect(withNumericCode.kind).not.toBe('DUPLICATE_CLIENT_ORDER_ID');
    expect(withNumericCode.kind).toBe('AMBIGUOUS');
  });

  it('a configured signal (wired later from the confirmed code) matches exact status AND exact code only, never the message', () => {
    const signal = { httpStatus: 400, providerCode: '4081' };
    expect(classifyCreateFailure(400, { message: 'anything at all', code: '4081' }, signal)).toBe('DUPLICATE_CLIENT_ORDER_ID');
    expect(classifyCreateFailure(400, { message: 'anything at all', code: 4081 }, signal)).toBe('DUPLICATE_CLIENT_ORDER_ID');
    expect(classifyCreateFailure(400, { message: 'x', code: new LosslessNumber('4081') }, signal)).toBe('DUPLICATE_CLIENT_ORDER_ID');
    expect(classifyCreateFailure(422, { message: 'x', code: '4081' }, signal)).toBe('UNCLASSIFIED');
    expect(classifyCreateFailure(400, { message: 'x', code: '40810' }, signal)).toBe('UNCLASSIFIED');
    expect(classifyCreateFailure(400, { message: 'duplicate 4081' }, signal)).toBe('UNCLASSIFIED');
    expect(classifyCreateFailure(400, null, signal)).toBe('UNCLASSIFIED');
  });

  it('a create response echoing the exact id is accepted and echoed; a different id is an identity mismatch', async () => {
    venue.respondJson(200, [order({ client_order_id: CLIENT_ORDER_ID })]);
    const accepted = await gateway.placeOrder(placeRequest());
    expect(accepted.kind).toBe('ACCEPTED');
    if (accepted.kind === 'ACCEPTED') expect(accepted.observation.exchangeClientOrderId).toBe(CLIENT_ORDER_ID);

    for (const echoed of [`p17-${'f'.repeat(32)}`, CLIENT_ORDER_ID.toUpperCase(), 12345]) {
      venue.reset();
      venue.respondJson(200, [order({ client_order_id: echoed })]);
      expect(await gateway.placeOrder(placeRequest())).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_IDENTITY_MISMATCH' });
    }
  });

  it('a create response with a null client_order_id is accepted with no echo (never filled in with the local id)', async () => {
    venue.respondJson(200, [order({ client_order_id: null })]);
    const accepted = await gateway.placeOrder(placeRequest());
    expect(accepted.kind).toBe('ACCEPTED');
    if (accepted.kind === 'ACCEPTED') expect(accepted.observation.exchangeClientOrderId).toBeNull();
  });

  it('fetchOrder refuses a venue order whose client_order_id differs, and echoes an identical one', async () => {
    venue.respondJson(200, [order({ status: 'open', client_order_id: `p17-${'f'.repeat(32)}` })]);
    expect(await gateway.fetchOrder(fetchRequest())).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_IDENTITY_MISMATCH' });
    venue.reset();
    venue.respondJson(200, [order({ status: 'open', client_order_id: CLIENT_ORDER_ID })]);
    const found = await gateway.fetchOrder(fetchRequest());
    expect(found.kind).toBe('FOUND');
    if (found.kind === 'FOUND') expect(found.observation.exchangeClientOrderId).toBe(CLIENT_ORDER_ID);
  });
});

describe('[PROVIDER-IDEMP-01] create HTTP failures are ambiguous unless they are the exact configured duplicate', () => {
  const FAILURE_STATUSES = [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504] as const;

  it.each(FAILURE_STATUSES)('signal null + HTTP %i => AMBIGUOUS through the real adapter, never REJECTED', async (status) => {
    expect(COINDCX_DUPLICATE_CLIENT_ORDER_ID_SIGNAL).toBeNull();
    venue.respondJson(status, { message: 'order refused', code: 'E_ANY' });
    const result = await gateway.placeOrder(placeRequest());
    expect(result).toEqual({ kind: 'AMBIGUOUS', reasonCode: `HTTP_${status}` });
    expect(venue.requests).toHaveLength(1);
  });

  it.each(FAILURE_STATUSES)('a message containing "duplicate" never changes the classification (HTTP %i)', async (status) => {
    venue.respondJson(status, { message: 'Duplicate client_order_id: an order with this client order id already exists', code: 'DUPLICATE' });
    expect(await gateway.placeOrder(placeRequest())).toEqual({ kind: 'AMBIGUOUS', reasonCode: `HTTP_${status}` });
  });

  it('a malformed error body => AMBIGUOUS', async () => {
    for (const body of [{ unexpected: true }, { message: '' }, [], 'not-an-object', null]) {
      venue.reset();
      venue.respondJson(400, body);
      const result = await gateway.placeOrder(placeRequest());
      expect(result.kind).toBe('AMBIGUOUS');
    }
    venue.reset();
    venue.respondMalformed();
    expect((await gateway.placeOrder(placeRequest())).kind).toBe('AMBIGUOUS');
  });

  it('a transport PRE_DISPATCH (connection refused, nothing sent) remains PRE_DISPATCH_FAILURE', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', () => resolve()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const unreachable = new CoinDcxLiveFuturesOrderGateway({ apiKey: API_KEY, apiSecret: API_SECRET, baseUrl: `http://127.0.0.1:${port}` });
    const result = await unreachable.placeOrder(placeRequest());
    expect(result.kind).toBe('PRE_DISPATCH_FAILURE');
  });

  describe('with a configured exact signal (the shape the confirmed code will be wired into)', () => {
    const signal = { httpStatus: 409, providerCode: '4081' };

    it('exact status + exact code => DUPLICATE_CLIENT_ORDER_ID (string, number, or lossless code)', () => {
      for (const code of ['4081', 4081, new LosslessNumber('4081')]) {
        expect(classifyCreateHttpFailure(409, { message: 'anything', code }, signal))
          .toEqual({ kind: 'DUPLICATE_CLIENT_ORDER_ID', reasonCode: 'HTTP_409_DUPLICATE_CLIENT_ORDER_ID' });
      }
    });

    it('same status, wrong code => AMBIGUOUS', () => {
      for (const code of ['4082', '40810', '408', 'DUPLICATE', undefined]) {
        expect(classifyCreateHttpFailure(409, { message: 'duplicate client order id', code }, signal)).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'HTTP_409' });
      }
    });

    it('same code, wrong status => AMBIGUOUS', () => {
      for (const status of [400, 422, 429, 500]) {
        expect(classifyCreateHttpFailure(status, { message: 'duplicate client order id', code: '4081' }, signal))
          .toEqual({ kind: 'AMBIGUOUS', reasonCode: `HTTP_${status}` });
      }
    });

    it('a duplicate-sounding message with no matching code => AMBIGUOUS', () => {
      expect(classifyCreateHttpFailure(409, { message: 'Duplicate client_order_id 4081' }, signal)).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'HTTP_409' });
    });

    it('a malformed body without the exact code => AMBIGUOUS', () => {
      expect(classifyCreateHttpFailure(409, { unexpected: true }, signal)).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_ERROR_RESPONSE_INVALID' });
      expect(classifyCreateHttpFailure(409, null, signal)).toEqual({ kind: 'AMBIGUOUS', reasonCode: 'LIVE_ERROR_RESPONSE_INVALID' });
    });
  });

  it('there is no terminal REJECTED outcome for any create HTTP failure, with or without a signal', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429, 499, 500, 599]) {
      for (const signal of [null, { httpStatus: 409, providerCode: '4081' }]) {
        expect(classifyCreateHttpFailure(status, { message: 'x', code: 'y' }, signal).kind).not.toBe('REJECTED');
      }
    }
  });
});
