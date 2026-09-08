import { describe, expect, it, vi } from 'vitest';
import { CoinDcxClient } from '../../../src/integration/coindcx/client';
import { CoinDcxTransport, HttpResponse } from '../../../src/integration/coindcx/transport';
import { CoinRuntimeBootstrapService } from '../../../src/coin-runtime';
import { wire, profile, deferred } from './audit-a2-helpers';

function clientFor(response: unknown) {
  const transport = new CoinDcxTransport();
  vi.spyOn(transport, 'executeRead').mockImplementation(async options => ({ status: 200, headers: {}, durationMs: 0,
    data: options.endpoint === 'ACTIVE_INSTRUMENTS' ? ['B-BTC_USDT'] : { instrument: response } }));
  return new CoinDcxClient({ transport });
}

describe('Audit A2 request identity and explicit restriction evidence', () => {
  it('accepts exact canonical request/response identity', async () => {
    expect((await clientFor(wire()).getInrFuturesInstrument('B-BTC_USDT')).pair).toBe('B-BTC_USDT');
  });
  it.each(['B-ETH_USDT', undefined, '', 'btc', 'b-btc_usdt', 'B-BTC_USDT '])('rejects mismatched/malformed response pair %s', async pair => {
    await expect(clientFor(wire('BTC', { pair })).getInrFuturesInstrument('B-BTC_USDT')).rejects.toMatchObject({ code: 'COINDCX_RESPONSE_VALIDATION_ERROR' });
  });
  it.each(['', 'b-btc_usdt', 'BTC/USDT'])('rejects ambiguous request %s', async pair => {
    await expect(clientFor(wire()).getInrFuturesInstrument(pair)).rejects.toThrow();
  });
  it('concurrent reversed responses cannot cross-contaminate pair requests', async () => {
    const transport = new CoinDcxTransport(); const btc = deferred<HttpResponse>(); const eth = deferred<HttpResponse>();
    vi.spyOn(transport, 'executeRead').mockImplementation(options => options.queryParams?.pair === 'B-BTC_USDT' ? btc.promise : eth.promise);
    const client = new CoinDcxClient({ transport });
    const results = Promise.allSettled([client.getInrFuturesInstrument('B-BTC_USDT'), client.getInrFuturesInstrument('B-ETH_USDT')]);
    eth.resolve({ status: 200, headers: {}, durationMs: 0, data: { instrument: wire() } });
    btc.resolve({ status: 200, headers: {}, durationMs: 0, data: { instrument: wire('ETH') } });
    expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
  });
  it('discovery and bootstrap cannot install mismatched instrument evidence', async () => {
    const client = clientFor(wire('BTC', { pair: 'B-ETH_USDT' }));
    expect(await client.findActiveInrPerpetualByUnderlying('BTC')).toBeNull();
    const service = new CoinRuntimeBootstrapService(client);
    expect((await service.bootstrap([profile()])).failures).toHaveLength(1);
    expect(service.registry.size).toBe(0);
  });
  it.each([
    [true, true, 'EXIT_ONLY'], [false, false, 'ELIGIBLE'],
    [undefined, null, 'RESTRICTION_UNKNOWN'], [null, null, 'RESTRICTION_UNKNOWN'],
  ] as const)('propagates exit_only=%s through discovery and bootstrap', async (exitOnly, expected, eligibility) => {
    const client = clientFor(wire('BTC', { exit_only: exitOnly }));
    expect((await client.findActiveInrPerpetualByUnderlying('BTC'))?.exitOnly).toBe(expected);
    const service = new CoinRuntimeBootstrapService(client);
    const result = await service.bootstrap([profile()]);
    expect(result.failures).toHaveLength(0);
    expect(result.successful[0]?.entryEligibility).toBe(eligibility);
    expect(result.successful[0]?.instrument?.exitOnly).toBe(expected);
  });
  it.each(['false', 0, {}])('rejects malformed exit_only=%s', async exitOnly => {
    const client = clientFor(wire('BTC', { exit_only: exitOnly }));
    await expect(client.getInrFuturesInstrument('B-BTC_USDT')).rejects.toThrow();
    expect((await new CoinRuntimeBootstrapService(client).bootstrap([profile()])).successful).toHaveLength(0);
  });

  it.each([
    ['B-BTC_USDT', 'order-1', true], ['B-ETH_USDT', 'order-1', false],
    ['B-BTC_USDT', 'order-2', false], ['B-BTC_USDT', null, false],
  ] as const)('binds filtered trade identity (%s/%s)', async (pair, orderId, accepted) => {
    const transport = new CoinDcxTransport();
    vi.spyOn(transport, 'executeRead').mockResolvedValue({ status: 200, headers: {}, durationMs: 0, data: [{
      pair, order_id: orderId, price: '100', quantity: '1', fee_amount: '0.1', side: 'buy', timestamp: 1700000000000, margin_currency_short_name: 'INR',
    }] });
    const client = new CoinDcxClient({ transport, apiKey: 'test-key', apiSecret: 'test-secret' });
    const result = client.listInrFuturesTrades({ pair: 'B-BTC_USDT', orderId: 'order-1', fromDate: '2024-01-01', toDate: '2024-01-02', page: '1', size: '10' });
    if (accepted) expect(await result).toHaveLength(1);
    else await expect(result).rejects.toMatchObject({ code: 'COINDCX_RESPONSE_VALIDATION_ERROR' });
  });

  it.each([
    ['B-BTC_USDT', 'position-1', true], ['B-ETH_USDT', 'position-1', false],
    ['B-BTC_USDT', 'position-2', false], ['B-BTC_USDT', 'position', false],
  ] as const)('binds filtered position identity (%s/%s) by exact list membership', async (pair, id, accepted) => {
    const transport = new CoinDcxTransport();
    vi.spyOn(transport, 'executeRead').mockResolvedValue({ status: 200, headers: {}, durationMs: 0, data: [{
      pair, id, active_pos: '1', avg_price: '100', locked_margin: '1', locked_user_margin: '1', locked_order_margin: '0', leverage: '1',
      maintenance_margin: '0.1', mark_price: '100', margin_type: null, settlement_currency_avg_price: '83',
      margin_currency_short_name: 'INR', updated_at: 1700000000000,
    }] });
    const client = new CoinDcxClient({ transport, apiKey: 'test-key', apiSecret: 'test-secret' });
    const result = client.listInrFuturesPositions({ pairs: 'B-BTC_USDT,B-SOL_USDT', position_ids: 'position-1,position-3', page: '1', size: '10' });
    if (accepted) expect(await result).toHaveLength(1);
    else await expect(result).rejects.toMatchObject({ code: 'COINDCX_RESPONSE_VALIDATION_ERROR' });
  });
});
