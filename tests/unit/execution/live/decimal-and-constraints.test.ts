import { describe, expect, it } from 'vitest';
import {
  canonicalLiveDecimalString,
  canonicalNonNegativeLiveDecimal,
  canonicalPersistedLiveDecimal,
  canonicalPositiveLiveDecimal,
  ceilToIncrement,
  floorToIncrement,
  isAlignedToIncrement,
  liveDecimal,
} from '../../../../src/execution/live/decimal';
import { LiveExecutionError } from '../../../../src/execution/live/errors';
import {
  assertOrderWithinInstrumentConstraints,
  quantizeOrderEconomics,
  resolveWireOrderType,
  type AuthoritativeInstrumentConstraints,
} from '../../../../src/execution/live/instrument-constraints';

function constraints(overrides: Partial<AuthoritativeInstrumentConstraints> = {}): AuthoritativeInstrumentConstraints {
  return Object.freeze({
    pair: 'B-BTC_USDT',
    instrumentSpecSnapshotId: 'spec-1',
    quoteCurrency: 'USDT',
    settlementCurrency: 'INR',
    priceIncrement: '0.5',
    quantityIncrement: '0.001',
    minQuantity: '0.001',
    maxQuantity: '10',
    minPrice: '1',
    maxPrice: '1000000',
    minNotional: '10',
    maxNotional: null,
    maxMarketOrderQuantity: null,
    contractMultiplier: '1',
    supportedOrderTypes: Object.freeze(['market_order', 'limit_order']),
    supportedTimeInForce: Object.freeze([]),
    exitOnly: false,
    ...overrides,
  });
}

describe('P17 exact decimal handling (P17-I10)', () => {
  it('canonicalizes numerically equivalent strings to one representation', () => {
    expect(canonicalLiveDecimalString('2')).toBe('2');
    expect(canonicalLiveDecimalString('2.0')).toBe('2');
    expect(canonicalLiveDecimalString('002.000')).toBe('2');
    expect(canonicalLiveDecimalString('-0')).toBe('0');
    expect(canonicalLiveDecimalString('0.10')).toBe('0.1');
  });

  it('refuses exponent syntax, blank values, and non-strings', () => {
    expect(() => liveDecimal('1e5')).toThrow(LiveExecutionError);
    expect(() => liveDecimal('')).toThrow(LiveExecutionError);
    expect(() => canonicalLiveDecimalString(1.5 as never)).toThrow(LiveExecutionError);
    expect(() => canonicalLiveDecimalString('abc')).toThrow(LiveExecutionError);
  });

  it('adds exactly, with no binary floating point error', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754 doubles.
    expect(liveDecimal('0.1').plus(liveDecimal('0.2')).toFixed()).toBe('0.3');
    expect(liveDecimal('0.1').plus(liveDecimal('0.2')).equals(liveDecimal('0.3'))).toBe(true);
  });

  it('multiplies notional exactly at 18 decimal places', () => {
    const notional = liveDecimal('0.000000000000000001').times(liveDecimal('3'));
    expect(notional.toFixed()).toBe('0.000000000000000003');
  });

  it('enforces the persisted DECIMAL(36,18) envelope', () => {
    expect(canonicalPersistedLiveDecimal('1.000000000000000001', 'q')).toBe('1.000000000000000001');
    expect(() => canonicalPersistedLiveDecimal('1.0000000000000000001', 'q')).toThrow(/LIVE_OVERFLOW/);
    expect(() => canonicalPersistedLiveDecimal('1'.repeat(19), 'q')).toThrow(/LIVE_OVERFLOW/);
  });

  it('separates positive, non-negative, and signed validation', () => {
    expect(canonicalPositiveLiveDecimal('0.5', 'q')).toBe('0.5');
    expect(() => canonicalPositiveLiveDecimal('0', 'q')).toThrow(LiveExecutionError);
    expect(() => canonicalPositiveLiveDecimal('-1', 'q')).toThrow(LiveExecutionError);
    expect(canonicalNonNegativeLiveDecimal('0', 'q')).toBe('0');
    expect(() => canonicalNonNegativeLiveDecimal('-0.000000000000000001', 'q')).toThrow(LiveExecutionError);
  });
});

describe('P17 exact increment arithmetic', () => {
  it('floors and ceils to an increment using exact integer arithmetic', () => {
    expect(floorToIncrement(liveDecimal('0.30000000000000004'), liveDecimal('0.1')).toFixed()).toBe('0.3');
    expect(ceilToIncrement(liveDecimal('0.21'), liveDecimal('0.1')).toFixed()).toBe('0.3');
    expect(floorToIncrement(liveDecimal('64000.99'), liveDecimal('0.5')).toFixed()).toBe('64000.5');
    expect(ceilToIncrement(liveDecimal('64000.01'), liveDecimal('0.5')).toFixed()).toBe('64000.5');
  });

  it('leaves an already-aligned value untouched', () => {
    expect(floorToIncrement(liveDecimal('1.5'), liveDecimal('0.5')).toFixed()).toBe('1.5');
    expect(ceilToIncrement(liveDecimal('1.5'), liveDecimal('0.5')).toFixed()).toBe('1.5');
  });

  it('detects alignment exactly', () => {
    expect(isAlignedToIncrement(liveDecimal('0.003'), liveDecimal('0.001'))).toBe(true);
    expect(isAlignedToIncrement(liveDecimal('0.0035'), liveDecimal('0.001'))).toBe(false);
  });

  it('rejects a zero or negative increment', () => {
    expect(() => floorToIncrement(liveDecimal('1'), liveDecimal('0'))).toThrow(LiveExecutionError);
    expect(() => ceilToIncrement(liveDecimal('1'), liveDecimal('-0.1'))).toThrow(LiveExecutionError);
  });
});

describe('P17 quantization never increases risk (P17-I11)', () => {
  it('always floors quantity, so exposure can only shrink', () => {
    const economics = quantizeOrderEconomics({
      constraints: constraints(),
      side: 'BUY',
      orderType: 'MARKET',
      quantity: '0.0019',
      price: null,
    });
    expect(economics.quantity).toBe('0.001');
    expect(economics.quantityAdjusted).toBe(true);
  });

  it('quantizes a BUY limit price DOWN, away from crossing', () => {
    const economics = quantizeOrderEconomics({
      constraints: constraints(),
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: '0.001',
      price: '64000.99',
    });
    expect(economics.price).toBe('64000.5');
    expect(economics.priceAdjusted).toBe(true);
  });

  it('quantizes a SELL limit price UP, away from crossing', () => {
    const economics = quantizeOrderEconomics({
      constraints: constraints(),
      side: 'SELL',
      orderType: 'LIMIT',
      quantity: '0.001',
      price: '64000.01',
    });
    expect(economics.price).toBe('64000.5');
  });

  it('computes notional exactly as quantity * price * contract multiplier', () => {
    const economics = quantizeOrderEconomics({
      constraints: constraints({ contractMultiplier: '0.001' }),
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: '2',
      price: '64000.5',
    });
    expect(economics.notional).toBe('128.001');
  });

  it('reports no adjustment when nothing needed quantizing', () => {
    const economics = quantizeOrderEconomics({
      constraints: constraints(),
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: '0.002',
      price: '64000.5',
    });
    expect(economics.quantityAdjusted).toBe(false);
    expect(economics.priceAdjusted).toBe(false);
  });

  it('refuses a quantity that floors to zero rather than rounding it up', () => {
    expect(() => quantizeOrderEconomics({
      constraints: constraints(),
      side: 'BUY',
      orderType: 'MARKET',
      quantity: '0.0009',
      price: null,
    })).toThrow(/LIVE_INSTRUMENT_CONSTRAINT/);
  });

  it('refuses a LIMIT without a price and a MARKET with one', () => {
    expect(() => quantizeOrderEconomics({ constraints: constraints(), side: 'BUY', orderType: 'LIMIT', quantity: '0.01', price: null }))
      .toThrow(/LIVE_INSTRUMENT_CONSTRAINT/);
    expect(() => quantizeOrderEconomics({ constraints: constraints(), side: 'BUY', orderType: 'MARKET', quantity: '0.01', price: '1' }))
      .toThrow(/LIVE_INSTRUMENT_CONSTRAINT/);
  });
});

describe('P17 authoritative instrument bounds (P17-I11)', () => {
  const economicsFor = (quantity: string, price: string | null, side: 'BUY' | 'SELL' = 'BUY', overrides: Partial<AuthoritativeInstrumentConstraints> = {}) =>
    quantizeOrderEconomics({
      constraints: constraints(overrides),
      side,
      orderType: price === null ? 'MARKET' : 'LIMIT',
      quantity,
      price,
    });

  it('accepts an order inside every bound', () => {
    expect(() => assertOrderWithinInstrumentConstraints({
      constraints: constraints(),
      action: 'OPEN',
      orderType: 'LIMIT',
      economics: economicsFor('0.001', '64000.5'),
    })).not.toThrow();
  });

  it('rejects a quantity below the instrument minimum', () => {
    expect(() => assertOrderWithinInstrumentConstraints({
      constraints: constraints({ minQuantity: '0.01' }),
      action: 'OPEN',
      orderType: 'MARKET',
      economics: economicsFor('0.005', null),
    })).toThrow(/LIVE_INSTRUMENT_CONSTRAINT/);
  });

  it('rejects a quantity above the instrument maximum', () => {
    expect(() => assertOrderWithinInstrumentConstraints({
      constraints: constraints(),
      action: 'OPEN',
      orderType: 'MARKET',
      economics: economicsFor('11', null),
    })).toThrow(/LIVE_INSTRUMENT_CONSTRAINT/);
  });

  it('rejects a market order above the instrument market-order maximum', () => {
    expect(() => assertOrderWithinInstrumentConstraints({
      constraints: constraints({ maxMarketOrderQuantity: '0.005' }),
      action: 'OPEN',
      orderType: 'MARKET',
      economics: economicsFor('0.01', null),
    })).toThrow(/LIVE_INSTRUMENT_CONSTRAINT/);
  });

  it('rejects a price outside the instrument price band', () => {
    expect(() => assertOrderWithinInstrumentConstraints({
      constraints: constraints({ maxPrice: '100' }),
      action: 'OPEN',
      orderType: 'LIMIT',
      economics: economicsFor('0.001', '64000.5'),
    })).toThrow(/LIVE_INSTRUMENT_CONSTRAINT/);
  });

  it('rejects a notional below the instrument minimum', () => {
    expect(() => assertOrderWithinInstrumentConstraints({
      constraints: constraints({ minNotional: '1000000' }),
      action: 'OPEN',
      orderType: 'LIMIT',
      economics: economicsFor('0.001', '64000.5'),
    })).toThrow(/LIVE_INSTRUMENT_CONSTRAINT/);
  });

  it('rejects a notional above the instrument maximum', () => {
    expect(() => assertOrderWithinInstrumentConstraints({
      constraints: constraints({ maxNotional: '1' }),
      action: 'OPEN',
      orderType: 'LIMIT',
      economics: economicsFor('0.001', '64000.5'),
    })).toThrow(/LIVE_INSTRUMENT_CONSTRAINT/);
  });

  it('refuses new OPEN exposure on an exit-only instrument but still permits CLOSE', () => {
    const exitOnly = constraints({ exitOnly: true });
    const economics = economicsFor('0.001', null, 'BUY', { exitOnly: true });
    expect(() => assertOrderWithinInstrumentConstraints({ constraints: exitOnly, action: 'OPEN', orderType: 'MARKET', economics }))
      .toThrow(/LIVE_INSTRUMENT_CONSTRAINT/);
    expect(() => assertOrderWithinInstrumentConstraints({ constraints: exitOnly, action: 'CLOSE', orderType: 'MARKET', economics }))
      .not.toThrow();
  });
});

describe('P17 wire order type comes from the instrument, never an invented enum (§10)', () => {
  it('selects the venue lexeme the instrument itself declares', () => {
    expect(resolveWireOrderType(constraints(), 'MARKET')).toBe('market_order');
    expect(resolveWireOrderType(constraints(), 'LIMIT')).toBe('limit_order');
    expect(resolveWireOrderType(constraints({ supportedOrderTypes: ['market', 'limit'] }), 'LIMIT')).toBe('limit');
  });

  it('never selects a conditional variant for a plain economic shape', () => {
    const conditional = constraints({ supportedOrderTypes: ['stop_limit', 'take_profit_limit', 'limit_order'] });
    expect(resolveWireOrderType(conditional, 'LIMIT')).toBe('limit_order');
  });

  it('refuses when the instrument declares no plain order type of the requested shape', () => {
    expect(() => resolveWireOrderType(constraints({ supportedOrderTypes: ['stop_limit'] }), 'LIMIT'))
      .toThrow(/LIVE_UNSUPPORTED_EXECUTION_SEMANTICS/);
    expect(() => resolveWireOrderType(constraints({ supportedOrderTypes: [] }), 'MARKET'))
      .toThrow(/LIVE_UNSUPPORTED_EXECUTION_SEMANTICS/);
  });
});
