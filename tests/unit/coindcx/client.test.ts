import { describe, expect, it, vi } from 'vitest';
import {
  CoinDcxAuthError,
  CoinDcxProviderError,
  ValidationError,
} from '../../../src/core/errors/app-error';
import { CoinDcxClient } from '../../../src/integration/coindcx/client';
import { FakeClock } from '../../../src/integration/coindcx/clock';
import { CoinDcxTransport, ExecuteReadOptions, HttpResponse } from '../../../src/integration/coindcx/transport';

describe('CoinDcxClient', () => {
  const fakeApiKey = 'test-api-key-xyz';
  const fakeApiSecret = 'test-api-secret-123';

  const createMockTransport = (
    mockHandler: (options: ExecuteReadOptions) => Promise<HttpResponse<unknown>>
  ): CoinDcxTransport => {
    return {
      executeRead: vi.fn().mockImplementation(mockHandler),
    } as unknown as CoinDcxTransport;
  };

  describe('Runtime Request Validation (Fails before network dispatch)', () => {
    it('rejects listInrFuturesOrders if status is missing or invalid', async () => {
      const client = new CoinDcxClient({ apiKey: fakeApiKey, apiSecret: fakeApiSecret });

      // Missing status
      await expect(
        client.listInrFuturesOrders({
          side: 'buy',
          page: '1',
          size: '50',
        } as unknown as Parameters<typeof client.listInrFuturesOrders>[0])
      ).rejects.toThrow(ValidationError);

      // Undocumented / invalid status
      await expect(
        client.listInrFuturesOrders({
          status: 'all', // Undocumented
          side: 'buy',
          page: '1',
          size: '50',
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        client.listInrFuturesOrders({
          status: 'invalid_status',
          side: 'buy',
          page: '1',
          size: '50',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('rejects listInrFuturesOrders if side is missing or invalid', async () => {
      const client = new CoinDcxClient({ apiKey: fakeApiKey, apiSecret: fakeApiSecret });

      // Missing side
      await expect(
        client.listInrFuturesOrders({
          status: 'open',
          page: '1',
          size: '50',
        } as unknown as Parameters<typeof client.listInrFuturesOrders>[0])
      ).rejects.toThrow(ValidationError);

      // Invalid side
      await expect(
        client.listInrFuturesOrders({
          status: 'open',
          side: 'hold' as unknown as 'buy',
          page: '1',
          size: '50',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('accepts valid comma-separated statuses where documented', async () => {
      const mockTransport = createMockTransport(async (opts) => {
        expect(opts.endpoint).toBe('FUTURES_ORDERS');
        const bodyObj = JSON.parse(opts.body ?? '{}') as Record<string, unknown>;
        expect(bodyObj['status']).toBe('open,partially_filled');
        expect(bodyObj['side']).toBe('buy');
        expect(bodyObj['margin_currency_short_name']).toEqual(['INR']);

        return {
          status: 200,
          headers: {},
          data: [],
          durationMs: 5,
        };
      });

      const client = new CoinDcxClient({
        apiKey: fakeApiKey,
        apiSecret: fakeApiSecret,
        transport: mockTransport,
      });

      const orders = await client.listInrFuturesOrders({
        status: 'open,partially_filled',
        side: 'buy',
        page: '1',
        size: '10',
      });
      expect(orders).toEqual([]);
    });

    it('rejects invalid page or size on all endpoints before network dispatch', async () => {
      const client = new CoinDcxClient({ apiKey: fakeApiKey, apiSecret: fakeApiSecret });

      // Zero or negative
      await expect(
        client.listInrFuturesOrders({ status: 'open', side: 'buy', page: '0', size: '10' })
      ).rejects.toThrow(ValidationError);

      await expect(
        client.listInrFuturesOrders({ status: 'open', side: 'buy', page: '-1', size: '10' })
      ).rejects.toThrow(ValidationError);

      // Non-integer strings
      await expect(
        client.listInrFuturesOrders({ status: 'open', side: 'buy', page: '1.5', size: '10' })
      ).rejects.toThrow(ValidationError);

      await expect(
        client.listInrFuturesOrders({ status: 'open', side: 'buy', page: 'abc', size: '10' })
      ).rejects.toThrow(ValidationError);

      await expect(
        client.listInrFuturesPositions({ page: '', size: '10' })
      ).rejects.toThrow(ValidationError);
    });

    it('requires stage on listInrFuturesPositionTransactions without automatic undocumented default', async () => {
      const client = new CoinDcxClient({ apiKey: fakeApiKey, apiSecret: fakeApiSecret });

      // Missing stage
      await expect(
        client.listInrFuturesPositionTransactions({
          page: '1',
          size: '10',
        } as unknown as Parameters<typeof client.listInrFuturesPositionTransactions>[0])
      ).rejects.toThrow(ValidationError);

      // Undocumented 'all' stage
      await expect(
        client.listInrFuturesPositionTransactions({
          stage: 'all' as unknown as 'funding',
          page: '1',
          size: '10',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('validates trades parameters: pair, fromDate, toDate, calendar validity, and date ordering', async () => {
      const client = new CoinDcxClient({ apiKey: fakeApiKey, apiSecret: fakeApiSecret });

      // Missing pair
      await expect(
        client.listInrFuturesTrades({
          pair: '',
          fromDate: '2024-01-01',
          toDate: '2024-01-02',
          page: '1',
          size: '10',
        })
      ).rejects.toThrow(ValidationError);

      // Non-existent calendar dates
      const invalidCalendarDates = [
        '2026-02-29', // 2026 is not a leap year
        '2026-02-30',
        '2026-02-31',
        '2026-04-31', // April has 30 days
        '2026-13-01', // Invalid month 13
        '2026-00-01', // Invalid month 0
        '2026-01-00', // Invalid day 0
        '2026-01-32', // Invalid day 32
        '2026-1-01',  // Invalid format (not YYYY-MM-DD)
        'abc',
      ];

      for (const invalidDate of invalidCalendarDates) {
        await expect(
          client.listInrFuturesTrades({
            pair: 'B-BTC_USDT',
            fromDate: invalidDate,
            toDate: '2026-12-31',
            page: '1',
            size: '10',
          })
        ).rejects.toThrow(ValidationError);
      }

      // fromDate > toDate
      await expect(
        client.listInrFuturesTrades({
          pair: 'B-BTC_USDT',
          fromDate: '2024-01-10',
          toDate: '2024-01-01',
          page: '1',
          size: '10',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('proves invalid calendar date 2026-02-31 causes zero network dispatches', async () => {
      let dispatchCount = 0;
      const mockTransport = createMockTransport(async () => {
        dispatchCount++;
        return {
          status: 200,
          headers: {},
          data: [],
          durationMs: 5,
        };
      });

      const client = new CoinDcxClient({
        apiKey: fakeApiKey,
        apiSecret: fakeApiSecret,
        transport: mockTransport,
      });

      await expect(
        client.listInrFuturesTrades({
          pair: 'B-BTC_USDT',
          fromDate: '2026-02-31',
          toDate: '2026-03-05',
          page: '1',
          size: '10',
        })
      ).rejects.toThrow(ValidationError);

      expect(dispatchCount).toBe(0);
    });

    it('accepts valid Gregorian calendar dates including leap year 2024-02-29', async () => {
      let dispatched = false;
      const mockTransport = createMockTransport(async () => {
        dispatched = true;
        return {
          status: 200,
          headers: {},
          data: [],
          durationMs: 5,
        };
      });

      const client = new CoinDcxClient({
        apiKey: fakeApiKey,
        apiSecret: fakeApiSecret,
        transport: mockTransport,
      });

      await client.listInrFuturesTrades({
        pair: 'B-BTC_USDT',
        fromDate: '2024-02-29', // Valid leap day
        toDate: '2024-03-01',
        page: '1',
        size: '10',
      });

      expect(dispatched).toBe(true);
    });

  });

  describe('Unauthenticated client / missing credentials handling', () => {
    it('allows public discovery methods without credentials', async () => {
      const mockTransport = createMockTransport(async (opts) => {
        expect(opts.endpoint).toBe('ACTIVE_INSTRUMENTS');
        expect(opts.queryParams).toEqual({ 'margin_currency_short_name[]': 'INR' });
        return {
          status: 200,
          headers: {},
          data: ['B-BTC_USDT', 'B-ETH_USDT'],
          durationMs: 10,
        };
      });

      const client = new CoinDcxClient({ transport: mockTransport });
      const pairs = await client.listActiveInrFuturesInstruments();
      expect(pairs).toEqual(['B-BTC_USDT', 'B-ETH_USDT']);
    });

    it('rejects all authenticated methods with CoinDcxAuthError when credentials are missing', async () => {
      const client = new CoinDcxClient();

      await expect(client.getUserInfoSafe()).rejects.toThrow(CoinDcxAuthError);
      await expect(client.getFuturesWallets()).rejects.toThrow(CoinDcxAuthError);
      await expect(client.getInrFuturesWallet()).rejects.toThrow(CoinDcxAuthError);
      await expect(client.listInrFuturesPositions()).rejects.toThrow(CoinDcxAuthError);
      await expect(
        client.listInrFuturesOrders({ status: 'open', side: 'buy', page: '1', size: '10' })
      ).rejects.toThrow(CoinDcxAuthError);
      await expect(
        client.listInrFuturesPositionTransactions({ stage: 'funding', page: '1', size: '10' })
      ).rejects.toThrow(CoinDcxAuthError);
      await expect(
        client.listInrFuturesTrades({
          pair: 'B-BTC_USDT',
          fromDate: '2024-01-01',
          toDate: '2024-01-02',
          page: '1',
          size: '10',
        })
      ).rejects.toThrow(CoinDcxAuthError);
      await expect(client.listFuturesWalletTransactions()).rejects.toThrow(CoinDcxAuthError);
    });
  });

  describe('Authenticated Reads & Fresh Timestamps', () => {
    it('sends fresh millisecond timestamp on each subsequent authenticated call', async () => {
      const clock = new FakeClock(1700000000000);
      const timestampsCaptured: number[] = [];

      const mockTransport = createMockTransport(async (opts) => {
        const bodyObj = JSON.parse(opts.body ?? '{}') as { timestamp: number };
        timestampsCaptured.push(bodyObj.timestamp);
        return {
          status: 200,
          headers: {},
          data: [{ coindcx_id: 'user-uuid-1' }],
          durationMs: 10,
        };
      });

      const client = new CoinDcxClient({
        apiKey: fakeApiKey,
        apiSecret: fakeApiSecret,
        clock,
        transport: mockTransport,
      });

      await client.getUserInfoSafe();

      clock.advance(5000);
      await client.getUserInfoSafe();

      expect(timestampsCaptured).toEqual([1700000000000, 1700000005000]);
    });

    it('retrieves INR futures wallet and rejects USDT-only account with error', async () => {
      const clock = new FakeClock();
      let callCount = 0;

      const mockTransport = createMockTransport(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            status: 200,
            headers: {},
            data: [
              {
                id: 'w-usdt',
                currency_short_name: 'USDT',
                locked_balance: '0.0',
              },
              {
                id: 'w-inr',
                currency_short_name: 'INR',
                locked_balance: '5000.0',
              },
            ],
            durationMs: 10,
          };
        } else {
          return {
            status: 200,
            headers: {},
            data: [
              {
                id: 'w-usdt',
                currency_short_name: 'USDT',
                locked_balance: '0.0',
              },
            ],
            durationMs: 10,
          };
        }
      });

      const client = new CoinDcxClient({
        apiKey: fakeApiKey,
        apiSecret: fakeApiSecret,
        clock,
        transport: mockTransport,
      });

      const inrWallet = await client.getInrFuturesWallet();
      expect(inrWallet.id).toBe('w-inr');
      expect(inrWallet.currency).toBe('INR');
      expect(inrWallet.lockedInitialMargin.toString()).toBe('5000');

      // Rejects when INR wallet missing
      await expect(client.getInrFuturesWallet()).rejects.toThrow(CoinDcxProviderError);
    });

    it('reads positions with strict INR scoping and preserves short direction', async () => {
      const mockTransport = createMockTransport(async (opts) => {
        const bodyObj = JSON.parse(opts.body ?? '{}') as Record<string, unknown>;
        expect(bodyObj['margin_currency_short_name']).toEqual(['INR']);

        return {
          status: 200,
          headers: {},
          data: [
            {
              id: 'pos-1',
              pair: 'B-BTC_USDT',
              active_pos: '-0.25',
              avg_price: '55000.0',
              locked_margin: '1100.0',
              locked_user_margin: '1000.0',
              locked_order_margin: '100.0',
              maintenance_margin: '50.0',
              mark_price: '54900.0',
              margin_type: 'isolated',
              settlement_currency_avg_price: '89.5',
              margin_currency_short_name: 'INR',
              leverage: '20',
              updated_at: 1700000000000,
            },
          ],
          durationMs: 10,
        };
      });

      const client = new CoinDcxClient({
        apiKey: fakeApiKey,
        apiSecret: fakeApiSecret,
        transport: mockTransport,
      });

      const positions = await client.listInrFuturesPositions({ page: '1', size: '10' });
      expect(positions).toHaveLength(1);
      expect(positions[0]!.activePositionQuantity.toString()).toBe('-0.25');
      expect(positions[0]!.activePositionQuantity.isNegative()).toBe(true);
      expect(positions[0]!.lockedMarginUsdt.toString()).toBe('1100');
    });

    it('reads trades with required date range and pair parameters', async () => {
      const mockTransport = createMockTransport(async (opts) => {
        const bodyObj = JSON.parse(opts.body ?? '{}') as Record<string, unknown>;
        expect(bodyObj['pair']).toBe('B-BTC_USDT');
        expect(bodyObj['from_date']).toBe('2024-01-01');
        expect(bodyObj['to_date']).toBe('2024-01-10');
        expect(bodyObj['margin_currency_short_name']).toEqual(['INR']);

        return {
          status: 200,
          headers: {},
          data: [
            {
              price: '54000.0',
              quantity: '0.05',
              pair: 'B-BTC_USDT',
              side: 'buy',
              fee_amount: '0.25',
              timestamp: 1700000000000,
              margin_currency_short_name: 'INR',
            },
          ],
          durationMs: 10,
        };
      });

      const client = new CoinDcxClient({
        apiKey: fakeApiKey,
        apiSecret: fakeApiSecret,
        transport: mockTransport,
      });

      const trades = await client.listInrFuturesTrades({
        pair: 'B-BTC_USDT',
        fromDate: '2024-01-01',
        toDate: '2024-01-10',
        page: '1',
        size: '10',
        orderId: 'ord-xyz',
      });
      expect(trades).toHaveLength(1);
      expect(trades[0]!.priceUsdt.toString()).toBe('54000');
      expect(trades[0]!.feeAmountUsdt.toString()).toBe('0.25');
    });

    it('reads position transactions with explicit stage', async () => {
      const mockTransport = createMockTransport(async (opts) => {
        expect(opts.endpoint).toBe('POSITION_TRANSACTIONS');
        const bodyObj = JSON.parse(opts.body ?? '{}') as Record<string, unknown>;
        expect(bodyObj['stage']).toBe('funding');
        expect(bodyObj['margin_currency_short_name']).toEqual(['INR']);

        return {
          status: 200,
          headers: {},
          data: [
            {
              pair: 'B-BTC_USDT',
              stage: 'funding',
              amount: '-10.5',
              fee_amount: '0.0',
              margin_currency_short_name: 'INR',
              created_at: 1700000000000,
              updated_at: 1700000000000,
            },
          ],
          durationMs: 5,
        };
      });

      const client = new CoinDcxClient({
        apiKey: fakeApiKey,
        apiSecret: fakeApiSecret,
        transport: mockTransport,
      });

      const txs = await client.listInrFuturesPositionTransactions({
        stage: 'funding',
        page: '1',
        size: '10',
      });
      expect(txs).toHaveLength(1);
      expect(txs[0]!.stage).toBe('funding');
      expect(txs[0]!.pnlAmountInr.toString()).toBe('-10.5');
    });

    it('reads wallet transactions via executeRead WALLET_TRANSACTIONS', async () => {
      const mockTransport = createMockTransport(async (opts) => {
        expect(opts.endpoint).toBe('WALLET_TRANSACTIONS');
        expect(opts.queryParams).toEqual({ page: '1', size: '20' });

        return {
          status: 200,
          headers: {},
          data: [
            {
              derivatives_futures_wallet_id: 'w-1',
              transaction_type: 'deposit',
              amount: '1000.0',
              currency_short_name: 'INR',
              created_at: 1700000000000,
            },
          ],
          durationMs: 5,
        };
      });

      const client = new CoinDcxClient({
        apiKey: fakeApiKey,
        apiSecret: fakeApiSecret,
        transport: mockTransport,
      });

      const txs = await client.listFuturesWalletTransactions({ page: '1', size: '20' });
      expect(txs).toHaveLength(1);
      expect(txs[0]!.amount.toString()).toBe('1000');
    });

    it('throws CoinDcxResponseValidationError on malformed response payloads', async () => {
      const mockTransport = createMockTransport(async () => {
        return {
          status: 200,
          headers: {},
          data: { unexpectedShape: true },
          durationMs: 5,
        };
      });

      const client = new CoinDcxClient({
        apiKey: fakeApiKey,
        apiSecret: fakeApiSecret,
        transport: mockTransport,
      });

      const { CoinDcxResponseValidationError } = await import('../../../src/core/errors/app-error');

      await expect(client.getFuturesWallets()).rejects.toThrow(CoinDcxResponseValidationError);
      await expect(client.listInrFuturesPositions()).rejects.toThrow(CoinDcxResponseValidationError);
      await expect(
        client.listInrFuturesOrders({ status: 'open', side: 'buy', page: '1', size: '10' })
      ).rejects.toThrow(CoinDcxResponseValidationError);
      await expect(
        client.listInrFuturesPositionTransactions({ stage: 'funding', page: '1', size: '10' })
      ).rejects.toThrow(CoinDcxResponseValidationError);
      await expect(
        client.listInrFuturesTrades({
          pair: 'B-BTC_USDT',
          fromDate: '2024-01-01',
          toDate: '2024-01-02',
          page: '1',
          size: '10',
        })
      ).rejects.toThrow(CoinDcxResponseValidationError);
      await expect(client.listFuturesWalletTransactions()).rejects.toThrow(
        CoinDcxResponseValidationError
      );
      await expect(client.getUserInfoSafe()).rejects.toThrow(CoinDcxResponseValidationError);
    });
  });
});

