import { describe, expect, it, vi } from 'vitest';
import { CoinDcxClient } from '../../../src/integration/coindcx/client';
import { CoinDcxTransport, HttpResponse } from '../../../src/integration/coindcx/transport';

describe('Generic Instrument Discovery', () => {
  // Mock instruments database simulating CoinDCX exchange state
  const mockExchangeInstruments: Record<string, Record<string, unknown>> = {
    'B-BTC_USDT': {
      pair: 'B-BTC_USDT',
      status: 'active',
      kind: 'perpetual',
      settle_currency_short_name: 'USDT',
      quote_currency_short_name: 'USDT',
      position_currency_short_name: 'BTC',
      underlying_currency_short_name: 'BTC',
      margin_currency_short_name: 'INR',
      max_leverage_long: '50.0',
      max_leverage_short: '50.0',
      unit_contract_value: '0.001',
      price_increment: '0.5',
      quantity_increment: '0.001',
      min_trade_size: '0.001',
      min_price: '100.0',
      max_price: '500000.0',
      min_quantity: '0.001',
      max_quantity: '100.0',
      min_notional: '500.0',
      maker_fee: '0.0002',
      taker_fee: '0.0005',
    },
    'B-ETH_USDT': {
      pair: 'B-ETH_USDT',
      status: 'active',
      kind: 'perpetual',
      settle_currency_short_name: 'USDT',
      quote_currency_short_name: 'USDT',
      position_currency_short_name: 'ETH',
      underlying_currency_short_name: 'ETH',
      margin_currency_short_name: 'INR',
      max_leverage_long: '25.0',
      max_leverage_short: '25.0',
      unit_contract_value: '0.01',
      price_increment: '0.1',
      quantity_increment: '0.01',
      min_trade_size: '0.01',
      min_price: '10.0',
      max_price: '50000.0',
      min_quantity: '0.01',
      max_quantity: '1000.0',
      min_notional: '500.0',
      maker_fee: '0.0002',
      taker_fee: '0.0005',
    },
    'B-SOL_USDT': {
      pair: 'B-SOL_USDT',
      status: 'active',
      kind: 'perpetual',
      settle_currency_short_name: 'USDT',
      quote_currency_short_name: 'USDT',
      position_currency_short_name: 'SOL',
      underlying_currency_short_name: 'SOL',
      margin_currency_short_name: 'INR',
      max_leverage_long: '20.0',
      max_leverage_short: '20.0',
      unit_contract_value: '0.1',
      price_increment: '0.01',
      quantity_increment: '0.1',
      min_trade_size: '0.1',
      min_price: '1.0',
      max_price: '10000.0',
      min_quantity: '0.1',
      max_quantity: '5000.0',
      min_notional: '500.0',
      maker_fee: '0.0002',
      taker_fee: '0.0005',
    },
    'B-XRP_USDT': {
      pair: 'B-XRP_USDT',
      status: 'inactive', // Inactive pair for negative test
      kind: 'perpetual',
      settle_currency_short_name: 'USDT',
      quote_currency_short_name: 'USDT',
      position_currency_short_name: 'XRP',
      underlying_currency_short_name: 'XRP',
      margin_currency_short_name: 'INR',
      max_leverage_long: '10.0',
      max_leverage_short: '10.0',
      unit_contract_value: '1.0',
      price_increment: '0.0001',
      quantity_increment: '1.0',
      min_trade_size: '1.0',
      min_price: '0.01',
      max_price: '100.0',
      min_quantity: '1.0',
      max_quantity: '50000.0',
      min_notional: '500.0',
      maker_fee: '0.0002',
      taker_fee: '0.0005',
    },
  };

  const createDiscoveryTransport = (): CoinDcxTransport => {
    return {
      executeRead: vi.fn().mockImplementation(async (opts: { endpoint: string; queryParams?: Record<string, unknown> }): Promise<HttpResponse<unknown>> => {
        if (opts.endpoint === 'ACTIVE_INSTRUMENTS') {
          return {
            status: 200,
            headers: {},
            data: Object.keys(mockExchangeInstruments),
            durationMs: 5,
          };
        }

        if (opts.endpoint === 'INSTRUMENT') {
          const pair = opts.queryParams?.['pair'] as string;
          const inst = mockExchangeInstruments[pair];
          if (!inst) {
            throw new Error(`Pair not found: ${pair}`);
          }
          return {
            status: 200,
            headers: {},
            data: { instrument: inst },
            durationMs: 5,
          };
        }

        throw new Error(`Unexpected endpoint: ${opts.endpoint}`);
      }),
    } as unknown as CoinDcxTransport;
  };


  it('discovers BTC dynamically without hardcoded pair name in core transport', async () => {
    const transport = createDiscoveryTransport();
    const client = new CoinDcxClient({ transport });

    const btc = await client.findActiveInrPerpetualByUnderlying('BTC');
    expect(btc).not.toBeNull();
    expect(btc!.pair).toBe('B-BTC_USDT');
    expect(btc!.underlyingCurrency).toBe('BTC');
    expect(btc!.status).toBe('active');
    expect(btc!.kind).toBe('perpetual');
  });

  it('discovers ETH dynamically without hardcoded pair name in core transport', async () => {
    const transport = createDiscoveryTransport();
    const client = new CoinDcxClient({ transport });

    const eth = await client.findActiveInrPerpetualByUnderlying('eth'); // Case-insensitive test
    expect(eth).not.toBeNull();
    expect(eth!.pair).toBe('B-ETH_USDT');
    expect(eth!.underlyingCurrency).toBe('ETH');
    expect(eth!.status).toBe('active');
  });

  it('proves future asset onboarding: discovers SOL with identical logic and zero code modifications', async () => {
    const transport = createDiscoveryTransport();
    const client = new CoinDcxClient({ transport });

    const sol = await client.findActiveInrPerpetualByUnderlying('SOL');
    expect(sol).not.toBeNull();
    expect(sol!.pair).toBe('B-SOL_USDT');
    expect(sol!.underlyingCurrency).toBe('SOL');
    expect(sol!.status).toBe('active');
  });

  it('returns null if requested asset is inactive', async () => {
    const transport = createDiscoveryTransport();
    const client = new CoinDcxClient({ transport });

    const xrp = await client.findActiveInrPerpetualByUnderlying('XRP');
    expect(xrp).toBeNull(); // Status is 'inactive' in mock data
  });

  it('returns null for an asset not present in active instruments list', async () => {
    const transport = createDiscoveryTransport();
    const client = new CoinDcxClient({ transport });

    const doge = await client.findActiveInrPerpetualByUnderlying('DOGE');
    expect(doge).toBeNull();
  });
});

