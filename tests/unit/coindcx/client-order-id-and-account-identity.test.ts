import { describe, expect, it, vi } from 'vitest';
import { CoinDcxClient } from '../../../src/integration/coindcx/client';
import { FakeClock } from '../../../src/integration/coindcx/clock';
import { normalizeClientOrderId, normalizeOrder } from '../../../src/integration/coindcx/normalizers';
import { FuturesOrderWireSchema } from '../../../src/integration/coindcx/schemas';
import type { CoinDcxTransport, ExecuteReadOptions, HttpResponse } from '../../../src/integration/coindcx/transport';

// Offline: the transport is an in-memory mock. Nothing reaches CoinDCX.

function wireOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'venue-1', pair: 'B-BTC_USDT', side: 'buy', status: 'open', order_type: 'limit_order',
    price: '64000.5', avg_price: '0', total_quantity: '0.5', remaining_quantity: '0.5', cancelled_quantity: '0',
    leverage: '5', margin_currency_short_name: 'INR', created_at: 1_700_000_000_000, updated_at: 1_700_000_000_500,
    ...overrides,
  };
}

function normalized(overrides: Record<string, unknown>) {
  return normalizeOrder(FuturesOrderWireSchema.parse(wireOrder(overrides)));
}

describe('List Orders client_order_id parsing', () => {
  it('keeps a string exactly, with no trim or case folding', () => {
    for (const value of ['p17-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'P17-AAAA', ' padded ', '']) {
      expect(normalized({ client_order_id: value }).clientOrderId).toBe(value);
    }
  });

  it('maps null, absent, and non-string values to null (which matches nothing), without failing the page', () => {
    expect(normalized({ client_order_id: null }).clientOrderId).toBeNull();
    expect(normalized({}).clientOrderId).toBeNull();
    expect(normalized({ client_order_id: 12345 }).clientOrderId).toBeNull();
    expect(normalized({ client_order_id: { nested: true } }).clientOrderId).toBeNull();
    expect(normalizeClientOrderId(undefined)).toBeNull();
  });
});

describe('users/info account identity read', () => {
  function clientReturning(data: unknown): CoinDcxClient {
    const transport = {
      executeRead: vi.fn().mockImplementation(async (_options: ExecuteReadOptions): Promise<HttpResponse<unknown>> => ({
        status: 200, headers: {}, data, durationMs: 1,
      })),
    } as unknown as CoinDcxTransport;
    return new CoinDcxClient({ apiKey: 'fake-api-key', apiSecret: 'fake-api-secret', clock: new FakeClock(), transport });
  }

  it('returns the single account identity (object or one-element array)', async () => {
    await expect(clientReturning({ coindcx_id: 'acct-1' }).getUserInfoSafe()).resolves.toEqual({ authenticated: true, coindcxId: 'acct-1' });
    await expect(clientReturning([{ coindcx_id: 'acct-1' }]).getUserInfoSafe()).resolves.toEqual({ authenticated: true, coindcxId: 'acct-1' });
  });

  it('refuses more than one account record instead of silently taking the first', async () => {
    await expect(clientReturning([{ coindcx_id: 'acct-1' }, { coindcx_id: 'acct-2' }]).getUserInfoSafe())
      .rejects.toThrow(/more than one account record/);
  });

  it('refuses an empty response and a missing coindcx_id', async () => {
    await expect(clientReturning([]).getUserInfoSafe()).rejects.toThrow();
    await expect(clientReturning({ email: 'x@example.com' }).getUserInfoSafe()).rejects.toThrow();
  });
});
