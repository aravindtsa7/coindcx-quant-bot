import { LosslessNumber } from 'lossless-json';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { CoinDcxResponseValidationError } from '../../../src/core/errors/app-error';
import {
  normalizeInstrument,
  normalizeOrder,
  normalizePosition,
  normalizePositionTransaction,
  normalizeTrade,
  normalizeUserInfo,
  normalizeWallet,
  normalizeWalletTransaction,
  nullableLosslessDecimal,
  toLosslessDecimal,
  toSafeIntegerTimestamp,
} from '../../../src/integration/coindcx/normalizers';

describe('CoinDCX Normalizers & Decimal Precision Safety', () => {
  describe('toLosslessDecimal precision regression tests', () => {
    it('preserves exact decimal lexeme of 0.011572734637194769 and large tokens into Decimal without JS number loss', () => {
      const token1 = '0.011572734637194769';
      const lossless1 = new LosslessNumber(token1);
      const dec1 = toLosslessDecimal(lossless1);

      expect(dec1.toString()).toBe(token1);
      expect(dec1).toEqual(new Decimal(token1));

      const token2 = '987654321012345.12345678901234';
      const lossless2 = new LosslessNumber(token2);
      const dec2 = toLosslessDecimal(lossless2);

      expect(dec2.toString()).toBe(token2);
      expect(dec2).toEqual(new Decimal(token2));
    });


    it('rejects non-finite values (NaN, +NaN, -NaN, Infinity, +Infinity, -Infinity, inf, -inf)', () => {
      const nonFiniteValues = [
        'NaN',
        '+NaN',
        '-NaN',
        'Infinity',
        '+Infinity',
        '-Infinity',
        'inf',
        '-inf',
        '+inf',
        'nan',
      ];

      for (const val of nonFiniteValues) {
        expect(() => toLosslessDecimal(val, 'testField')).toThrow(CoinDcxResponseValidationError);
      }
    });

    it('rejects malformed numeric strings, empty strings, whitespace, null, and undefined', () => {
      expect(() => toLosslessDecimal('abc')).toThrow(CoinDcxResponseValidationError);
      expect(() => toLosslessDecimal('1.2.3')).toThrow(CoinDcxResponseValidationError);
      expect(() => toLosslessDecimal('')).toThrow(CoinDcxResponseValidationError);
      expect(() => toLosslessDecimal('   ')).toThrow(CoinDcxResponseValidationError);
      expect(() => toLosslessDecimal(null)).toThrow(CoinDcxResponseValidationError);
      expect(() => toLosslessDecimal(undefined)).toThrow(CoinDcxResponseValidationError);
    });

    it('accepts valid zero and negative financial numbers safely', () => {
      expect(toLosslessDecimal('0')).toEqual(new Decimal(0));
      expect(toLosslessDecimal('-0.25')).toEqual(new Decimal('-0.25'));
      expect(toLosslessDecimal(0)).toEqual(new Decimal(0));
      expect(toLosslessDecimal(-50.5)).toEqual(new Decimal('-50.5'));
    });

    it('nullableLosslessDecimal returns null for absent/null but strictly rejects present empty or malformed strings', () => {
      // Absent or null -> null
      expect(nullableLosslessDecimal(null)).toBeNull();
      expect(nullableLosslessDecimal(undefined)).toBeNull();

      // Valid numbers -> Decimal
      expect(nullableLosslessDecimal('0')).toEqual(new Decimal(0));
      expect(nullableLosslessDecimal('123.45')).toEqual(new Decimal('123.45'));

      // Present empty or whitespace string -> fails closed with validation error
      expect(() => nullableLosslessDecimal('')).toThrow(CoinDcxResponseValidationError);
      expect(() => nullableLosslessDecimal('   ')).toThrow(CoinDcxResponseValidationError);
      expect(() => nullableLosslessDecimal('NaN')).toThrow(CoinDcxResponseValidationError);
      expect(() => nullableLosslessDecimal('Infinity')).toThrow(CoinDcxResponseValidationError);
    });
  });

  describe('toSafeIntegerTimestamp', () => {
    it('accepts safe integer numbers and whole numeric strings', () => {
      expect(toSafeIntegerTimestamp(1700000000000, 'time')).toBe(1700000000000);
      expect(toSafeIntegerTimestamp(new LosslessNumber('1700000000000'), 'time')).toBe(1700000000000);
      expect(toSafeIntegerTimestamp('1700000000000', 'time')).toBe(1700000000000);
    });

    it('rejects fractional timestamps rather than silently truncating them', () => {
      expect(() => toSafeIntegerTimestamp(new LosslessNumber('1700000000.5'), 'time')).toThrow(
        CoinDcxResponseValidationError
      );
      expect(() => toSafeIntegerTimestamp('1700000000.5', 'time')).toThrow(
        CoinDcxResponseValidationError
      );
    });
  });

  describe('normalizeInstrument & Dynamic Leverage', () => {
    it('parses dynamic leverage and safety margin tiers and segregates ignored legacy leverage', () => {
      const wire = {
        pair: 'B-BTC_USDT',
        status: 'active',
        kind: 'perpetual',
        settlement: 'never',
        settle_currency_short_name: 'USDT',
        quote_currency_short_name: 'USDT',
        position_currency_short_name: 'BTC',
        underlying_currency_short_name: 'BTC',
        margin_currency_short_name: 'INR',
        max_leverage_long: '50.0', // Documented "Ignore this"
        max_leverage_short: '50.0', // Documented "Ignore this"
        unit_contract_value: '0.001',
        price_increment: '0.5',
        quantity_increment: '0.001',
        min_trade_size: '0.001',
        min_price: '1000.0',
        max_price: '500000.0',
        min_quantity: '0.001',
        max_quantity: '100.0',
        min_notional: '500.0',
        max_notional: '50000000.0',
        max_market_order_quantity: '10.0',
        maker_fee: '0.0002',
        taker_fee: '0.0005',
        safety_percentage: '2.5',
        funding_frequency: 8,
        expiry_time: 1900000000000,
        exit_only: false,
        time_in_force_options: ['good_till_cancel'],
        order_types: ['limit_order'],
        dynamic_position_leverage_details: {
          '20': 100000,
          '5': 15000000,
          '10': 1000000,
        },
        dynamic_safety_margin_details: {
          '100000': 2.0,
          '50000': 1.5,
        },
      };

      const inst = normalizeInstrument(wire);

      // Legacy leverage is NOT exposed as effective maximum
      expect(inst.legacyMaxLeverageLongIgnored).toEqual(new Decimal('50'));
      expect(inst.legacyMaxLeverageShortIgnored).toEqual(new Decimal('50'));

      // Dynamic leverage tiers parsed and sorted ascending
      expect(inst.dynamicPositionLeverageTiers).toHaveLength(3);
      expect(inst.dynamicPositionLeverageTiers[0]).toEqual({
        leverage: new Decimal('5'),
        maxPositionSizeUsdt: new Decimal('15000000'),
      });
      expect(inst.dynamicPositionLeverageTiers[1]).toEqual({
        leverage: new Decimal('10'),
        maxPositionSizeUsdt: new Decimal('1000000'),
      });
      expect(inst.dynamicPositionLeverageTiers[2]).toEqual({
        leverage: new Decimal('20'),
        maxPositionSizeUsdt: new Decimal('100000'),
      });

      // Dynamic safety margin tiers parsed and sorted ascending
      expect(inst.dynamicSafetyMarginTiers).toHaveLength(2);
      expect(inst.dynamicSafetyMarginTiers[0]).toEqual({
        positionSizeThresholdUsdt: new Decimal('50000'),
        maintenanceMarginPercent: new Decimal('1.5'),
      });
      expect(inst.dynamicSafetyMarginTiers[1]).toEqual({
        positionSizeThresholdUsdt: new Decimal('100000'),
        maintenanceMarginPercent: new Decimal('2.0'),
      });

      expect(inst.makerFeePercent).toEqual(new Decimal('0.0002'));
      expect(inst.takerFeePercent).toEqual(new Decimal('0.0005'));
    });

    it('rejects instrument if margin currency is not INR', () => {
      const wire = {
        pair: 'B-BTC_USDT',
        status: 'active',
        kind: 'perpetual',
        settle_currency_short_name: 'USDT',
        quote_currency_short_name: 'USDT',
        position_currency_short_name: 'BTC',
        underlying_currency_short_name: 'BTC',
        margin_currency_short_name: 'USDT', // Not INR!
        unit_contract_value: '0.001',
        price_increment: '0.5',
        quantity_increment: '0.001',
        min_trade_size: '0.001',
        min_price: '1.0',
        max_price: '100000.0',
        min_quantity: '0.001',
        max_quantity: '100.0',
        min_notional: '500.0',
        maker_fee: '0.0002',
        taker_fee: '0.0005',
        time_in_force_options: ['good_till_cancel'],
        order_types: ['limit_order'],
      };

      expect(() => normalizeInstrument(wire)).toThrow(CoinDcxResponseValidationError);
    });

  });

  describe('normalizeWallet (Locked Initial Margin Semantics)', () => {
    it('normalizes locked initial margin and stores raw balance as legacyBalanceIgnored without total/available/equity calculation', () => {
      const wire = {
        id: 'w-1',
        currency_short_name: 'INR',
        balance: '50000.0', // Documented "Ignore this"
        locked_balance: '15000.0',
        cross_order_margin: '500.0',
        cross_user_margin: '1000.0',
      };

      const wallet = normalizeWallet(wire);

      expect(wallet.currency).toBe('INR');
      expect(wallet.lockedInitialMargin).toEqual(new Decimal('15000.0'));
      expect(wallet.legacyBalanceIgnored).toEqual(new Decimal('50000.0'));
      // Verify totalBalance, availableBalance, and equity do NOT exist on the normalized model
      expect((wallet as unknown as Record<string, unknown>)['totalBalance']).toBeUndefined();
      expect((wallet as unknown as Record<string, unknown>)['availableBalance']).toBeUndefined();
      expect((wallet as unknown as Record<string, unknown>)['equity']).toBeUndefined();
    });

    it('normalizes USDT wallet with currency USDT and lockedInitialMargin without substituting for INR wallet', () => {
      const wire = {
        id: 'w-usdt',
        currency_short_name: 'USDT',
        locked_balance: '100.0',
      };

      const wallet = normalizeWallet(wire);
      expect(wallet.currency).toBe('USDT');
      expect(wallet.lockedInitialMargin).toEqual(new Decimal('100.0'));
      expect(wallet.currency).not.toBe('INR');
    });
  });



  describe('normalizePosition & Fail-Closed Validation', () => {
    const validWirePosition = {
      id: 'pos-1',
      pair: 'B-BTC_USDT',
      active_pos: '-0.25', // Short position
      inactive_pos_buy: '0.0',
      inactive_pos_sell: '0.0',
      avg_price: '55000.5',
      liquidation_price: '58000.0',
      locked_margin: '1100.0',
      locked_user_margin: '1000.0',
      locked_order_margin: '100.0',
      maintenance_margin: '50.0',
      mark_price: '54900.0',
      take_profit_trigger: null,
      stop_loss_trigger: null,
      leverage: '20',
      margin_type: 'isolated',
      settlement_currency_avg_price: '89.5',
      margin_currency_short_name: 'INR',
      updated_at: 1700000000000,
    };

    it('normalizes position with explicit currency property names and signed active quantity', () => {
      const pos = normalizePosition(validWirePosition);

      expect(pos.activePositionQuantity).toEqual(new Decimal('-0.25'));
      expect(pos.avgPriceUsdt).toEqual(new Decimal('55000.5'));
      expect(pos.lockedMarginUsdt).toEqual(new Decimal('1100.0'));
      expect(pos.lockedUserMarginUsdt).toEqual(new Decimal('1000.0'));
      expect(pos.lockedOrderMarginUsdt).toEqual(new Decimal('100.0'));
      expect(pos.maintenanceMarginUsdt).toEqual(new Decimal('50.0'));
      expect(pos.markPriceUsdt).toEqual(new Decimal('54900.0'));
      expect(pos.settlementCurrencyAvgPriceInrPerUsdt).toEqual(new Decimal('89.5'));
      expect(pos.marginCurrency).toBe('INR');
      expect(pos.marginType).toBe('isolated');
    });

    it('normalizes documented margin_type = null explicitly as isolated', () => {
      const wire = {
        ...validWirePosition,
        margin_type: null, // Documented: null is isolated
      };

      const pos = normalizePosition(wire);
      expect(pos.marginType).toBe('isolated');
    });

    it('rejects crossed margin position as unsupported exchange contract anomaly', () => {
      const wire = {
        ...validWirePosition,
        margin_type: 'crossed', // Cross margin unsupported for INR futures
      };

      expect(() => normalizePosition(wire)).toThrow(CoinDcxResponseValidationError);
    });

    it('rejects non-INR position responses', () => {
      const wire = {
        ...validWirePosition,
        margin_currency_short_name: 'USDT',
      };

      expect(() => normalizePosition(wire)).toThrow(CoinDcxResponseValidationError);
    });

    it('fails closed when safety-critical fields are missing (does NOT default to zero)', () => {
      const missingPos = { ...validWirePosition };
      delete (missingPos as Record<string, unknown>)['active_pos'];
      expect(() => normalizePosition(missingPos)).toThrow(CoinDcxResponseValidationError);

      const missingMargin = { ...validWirePosition };
      delete (missingMargin as Record<string, unknown>)['locked_margin'];
      expect(() => normalizePosition(missingMargin)).toThrow(CoinDcxResponseValidationError);

      const missingPrice = { ...validWirePosition };
      delete (missingPrice as Record<string, unknown>)['avg_price'];
      expect(() => normalizePosition(missingPrice)).toThrow(CoinDcxResponseValidationError);

      const missingMaint = { ...validWirePosition };
      delete (missingMaint as Record<string, unknown>)['maintenance_margin'];
      expect(() => normalizePosition(missingMaint)).toThrow(CoinDcxResponseValidationError);

      const missingMark = { ...validWirePosition };
      delete (missingMark as Record<string, unknown>)['mark_price'];
      expect(() => normalizePosition(missingMark)).toThrow(CoinDcxResponseValidationError);

      const missingSettlement = { ...validWirePosition };
      delete (missingSettlement as Record<string, unknown>)['settlement_currency_avg_price'];
      expect(() => normalizePosition(missingSettlement)).toThrow(CoinDcxResponseValidationError);
    });

    it('accepts explicit null for maintenance_margin, mark_price, and settlement_currency_avg_price on flat positions (active_pos == 0)', () => {
      const flatWirePosition = {
        ...validWirePosition,
        active_pos: '0.0',
        maintenance_margin: null,
        mark_price: null,
        settlement_currency_avg_price: null,
      };

      const pos = normalizePosition(flatWirePosition);

      expect(pos.activePositionQuantity.isZero()).toBe(true);
      expect(pos.maintenanceMarginUsdt).toBeNull();
      expect(pos.markPriceUsdt).toBeNull();
      expect(pos.settlementCurrencyAvgPriceInrPerUsdt).toBeNull();

      // Ensure explicit null does NOT become Decimal(0)
      expect(pos.maintenanceMarginUsdt).not.toEqual(new Decimal(0));
      expect(pos.markPriceUsdt).not.toEqual(new Decimal(0));
      expect(pos.settlementCurrencyAvgPriceInrPerUsdt).not.toEqual(new Decimal(0));
    });

    it('strictly rejects explicit null for maintenance_margin, mark_price, or settlement_currency_avg_price on active positions (active_pos != 0)', () => {
      // Active long position with null maintenance_margin
      const activeNullMaint = {
        ...validWirePosition,
        active_pos: '0.5',
        maintenance_margin: null,
      };
      expect(() => normalizePosition(activeNullMaint)).toThrow(CoinDcxResponseValidationError);

      // Active short position with null mark_price
      const activeNullMark = {
        ...validWirePosition,
        active_pos: '-0.25',
        mark_price: null,
      };
      expect(() => normalizePosition(activeNullMark)).toThrow(CoinDcxResponseValidationError);

      // Active position with null settlement_currency_avg_price
      const activeNullSettlement = {
        ...validWirePosition,
        active_pos: '-0.25',
        settlement_currency_avg_price: null,
      };
      expect(() => normalizePosition(activeNullSettlement)).toThrow(CoinDcxResponseValidationError);
    });

    it('accepts active position with valid non-null numeric values and preserves exact Decimals', () => {
      const activeWire = {
        ...validWirePosition,
        active_pos: '1.5',
        maintenance_margin: '75.25',
        mark_price: '54850.5',
        settlement_currency_avg_price: '89.75',
      };

      const pos = normalizePosition(activeWire);

      expect(pos.activePositionQuantity).toEqual(new Decimal('1.5'));
      expect(pos.maintenanceMarginUsdt).toEqual(new Decimal('75.25'));
      expect(pos.markPriceUsdt).toEqual(new Decimal('54850.5'));
      expect(pos.settlementCurrencyAvgPriceInrPerUsdt).toEqual(new Decimal('89.75'));
    });
  });


  describe('normalizeOrder & Currency Safety', () => {
    it('normalizes orders with explicit USDT and INR-per-USDT currency properties', () => {
      const wire = {
        id: 'ord-1',
        pair: 'B-BTC_USDT',
        side: 'buy' as const,
        status: 'open',
        order_type: 'limit_order',
        price: '52000.0',
        stop_price: null,
        avg_price: '52000.0',
        total_quantity: '0.1',
        remaining_quantity: '0.1',
        cancelled_quantity: null,
        fee_amount: '0.5',
        settlement_currency_conversion_price: '89.2',
        maker_fee: '0.0002',
        taker_fee: '0.0005',
        leverage: '20',
        margin_currency_short_name: 'INR',
        created_at: 1700000000000,
        updated_at: 1700000000000,
      };

      const order = normalizeOrder(wire);

      expect(order.priceUsdt).toEqual(new Decimal('52000.0'));
      expect(order.feeAmountUsdt).toEqual(new Decimal('0.5'));
      expect(order.settlementCurrencyConversionPriceInrPerUsdt).toEqual(new Decimal('89.2'));
      expect(order.marginCurrency).toBe('INR');
      // ideal_margin is omitted or ignored
      expect((order as unknown as Record<string, unknown>)['ideal_margin']).toBeUndefined();
    });

    it('rejects order if margin currency is not INR', () => {
      const wire = {
        id: 'ord-1',
        pair: 'B-BTC_USDT',
        side: 'buy' as const,
        status: 'open',
        order_type: 'limit_order',
        total_quantity: '0.1',
        remaining_quantity: '0.1',
        margin_currency_short_name: 'USDT',
        created_at: 1700000000000,
        updated_at: 1700000000000,
      };

      expect(() => normalizeOrder(wire)).toThrow(CoinDcxResponseValidationError);
    });
  });

  describe('normalizePositionTransaction & Currency Safety', () => {
    it('normalizes position transaction with explicit INR PnL and fee semantics', () => {
      const wire = {
        pair: 'B-BTC_USDT',
        stage: 'funding',
        amount: '-150.25', // Realized PnL in INR
        fee_amount: '2.50', // Fee in INR
        price_in_inr: '1.0',
        price_in_usdt: '0.0112',
        settlement_amount: '0.0',
        margin_currency_short_name: 'INR',
        created_at: 1700000000000,
        updated_at: 1700000000000,
      };

      const tx = normalizePositionTransaction(wire);

      expect(tx.stage).toBe('funding');
      expect(tx.pnlAmountInr).toEqual(new Decimal('-150.25'));
      expect(tx.feeAmountInr).toEqual(new Decimal('2.50'));
      expect(tx.priceInInr).toEqual(new Decimal('1.0'));
      expect(tx.priceInUsdt).toEqual(new Decimal('0.0112'));
      expect(tx.marginCurrency).toBe('INR');
    });

    it('rejects transaction if margin currency is not INR', () => {
      const wire = {
        stage: 'funding',
        amount: '100.0',
        fee_amount: '0.0',
        margin_currency_short_name: 'USDT',
        created_at: 1700000000000,
        updated_at: 1700000000000,
      };

      expect(() => normalizePositionTransaction(wire)).toThrow(CoinDcxResponseValidationError);
    });
  });

  describe('normalizeTrade & Currency Safety', () => {
    it('normalizes trade with explicit USDT price and fee semantics', () => {
      const wire = {
        price: '55000.0',
        quantity: '0.05',
        is_maker: true,
        fee_amount: '0.25',
        pair: 'B-BTC_USDT',
        side: 'buy',
        timestamp: 1700000000000,
        margin_currency_short_name: 'INR',
      };

      const trade = normalizeTrade(wire);

      expect(trade.priceUsdt).toEqual(new Decimal('55000.0'));
      expect(trade.quantity).toEqual(new Decimal('0.05'));
      expect(trade.feeAmountUsdt).toEqual(new Decimal('0.25'));
      expect(trade.marginCurrency).toBe('INR');
    });

    it('rejects trade if margin currency is not INR', () => {
      const wire = {
        price: '55000.0',
        quantity: '0.05',
        fee_amount: '0.25',
        pair: 'B-BTC_USDT',
        side: 'buy',
        timestamp: 1700000000000,
        margin_currency_short_name: 'USDT',
      };

      expect(() => normalizeTrade(wire)).toThrow(CoinDcxResponseValidationError);
    });
  });

  describe('normalizeWalletTransaction', () => {
    it('normalizes wallet transaction entry with Decimal amount', () => {
      const wire = {
        derivatives_futures_wallet_id: 'w-1',
        transaction_type: 'deposit',
        amount: '1000.50',
        currency_short_name: 'INR',
        currency_full_name: 'Indian Rupee',
        reason: 'bank_transfer',
        created_at: 1700000000000,
      };

      const tx = normalizeWalletTransaction(wire);
      expect(tx.walletId).toBe('w-1');
      expect(tx.transactionType).toBe('deposit');
      expect(tx.amount).toEqual(new Decimal('1000.50'));
      expect(tx.currency).toBe('INR');
      expect(tx.createdAtMs).toBe(1700000000000);
    });
  });

  describe('normalizeUserInfo', () => {
    it('discards all PII and retains only connectivity proof and coindcx_id', () => {
      const wire = {
        coindcx_id: 'user-12345',
        first_name: 'Satoshi',
        last_name: 'Nakamoto',
        email: 'satoshi@bitcoin.org',
        mobile_number: '+919999999999',
      };

      const res = normalizeUserInfo(wire);
      expect(res.authenticated).toBe(true);
      expect(res.coindcxId).toBe('user-12345');
      expect((res as unknown as Record<string, unknown>)['email']).toBeUndefined();
      expect((res as unknown as Record<string, unknown>)['mobile_number']).toBeUndefined();
    });
  });
});
