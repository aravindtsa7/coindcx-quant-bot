import { CoinProfile } from '../../../src/coin-runtime';
import { normalizeInstrument } from '../../../src/integration/coindcx/normalizers';
import { InstrumentWireSchema } from '../../../src/integration/coindcx/schemas';

export function wire(underlying = 'BTC', overrides: Record<string, unknown> = {}) {
  return { pair: `B-${underlying}_USDT`, underlying_currency_short_name: underlying,
    status: 'active', kind: 'perpetual', settle_currency_short_name: 'USDT', quote_currency_short_name: 'USDT',
    position_currency_short_name: underlying, margin_currency_short_name: 'INR', unit_contract_value: '1',
    price_increment: '0.01', quantity_increment: '0.01', min_trade_size: '0.01', min_price: '1', max_price: '1000000',
    min_quantity: '0.01', max_quantity: '1000000', min_notional: '100', maker_fee: '0.02', taker_fee: '0.05',
    exit_only: false, ...overrides };
}
export function instrument(underlying = 'BTC') { return normalizeInstrument(InstrumentWireSchema.parse(wire(underlying))); }
export function profile(underlying = 'BTC'): CoinProfile {
  return { underlying, enabled: true, dataEnabled: true, researchEnabled: true, paperEnabled: false,
    shadowEnabled: false, liveEnabled: false, timeframes: ['1m', '5m'], strategyAssignments: [],
    riskProfileId: 'DEFAULT_SAFE', defaultLeverage: null, configuredAbsoluteMaxLeverage: null };
}
export function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
