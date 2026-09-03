import { isLosslessNumber } from 'lossless-json';
import { Decimal, zeroDecimal } from '../../core/decimal/decimal';
import { CoinDcxResponseValidationError } from '../../core/errors/app-error';
import {
  AuthVerificationResult,
  DynamicLeverageTier,
  DynamicSafetyMarginTier,
  FuturesWalletTransaction,
  InrFuturesInstrument,
  InrFuturesOrder,
  InrFuturesPosition,
  InrFuturesPositionTransaction,
  InrFuturesTrade,
  InrFuturesWallet,
} from './models';
import {
  FuturesOrderWire,
  FuturesPositionTransactionWire,
  FuturesPositionWire,
  FuturesTradeWire,
  FuturesWalletTransactionWire,
  FuturesWalletWire,
  InstrumentWire,
  UserInfoItemWireSchema,
} from './schemas';
import { z } from 'zod';

/**
 * Converts a wire numeric value (LosslessNumber, string, or number) directly into Decimal.
 * Strictly avoids passing through JavaScript number/parseFloat to preserve precision.
 * Enforces that all values are valid, finite numbers (rejecting NaN, Infinity, and empty/whitespace).
 */
export function toLosslessDecimal(value: unknown, fieldName = 'value'): Decimal {
  if (value === undefined || value === null) {
    throw new CoinDcxResponseValidationError(
      `Required numeric field '${fieldName}' is missing or null`
    );
  }

  if (value instanceof Decimal) {
    if (!value.isFinite() || value.isNaN()) {
      throw new CoinDcxResponseValidationError(
        `Non-finite Decimal value is not allowed for field '${fieldName}'`
      );
    }
    return value;
  }

  let raw: string;
  if (isLosslessNumber(value)) {
    raw = value.value;
  } else if (typeof value === 'string') {
    raw = value;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      throw new CoinDcxResponseValidationError(
        `Non-finite number '${value}' is not allowed for field '${fieldName}'`
      );
    }
    raw = value.toString();
  } else {
    throw new CoinDcxResponseValidationError(
      `Unsupported type for numeric field '${fieldName}': ${typeof value}`
    );
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new CoinDcxResponseValidationError(
      `Numeric field '${fieldName}' cannot be empty or whitespace`
    );
  }

  // Explicitly reject non-finite representations (case-insensitive nan, inf, infinity)
  if (/^[+-]?(nan|inf|infinity)$/i.test(trimmed)) {
    throw new CoinDcxResponseValidationError(
      `Non-finite numeric value '${trimmed}' is not allowed for field '${fieldName}'`
    );
  }

  let dec: Decimal;
  try {
    dec = new Decimal(trimmed);
  } catch {
    throw new CoinDcxResponseValidationError(
      `Invalid numeric format '${trimmed}' for field '${fieldName}'`
    );
  }

  if (!dec.isFinite() || dec.isNaN()) {
    throw new CoinDcxResponseValidationError(
      `Non-finite numeric value '${trimmed}' is not allowed for field '${fieldName}'`
    );
  }

  return dec;
}

export function nullableLosslessDecimal(value: unknown, fieldName = 'value'): Decimal | null {
  if (value === undefined || value === null) {
    return null;
  }
  return toLosslessDecimal(value, fieldName);
}


/**
 * Validates and converts an integer timestamp safely without loss.
 */
export function toSafeIntegerTimestamp(value: unknown, fieldName: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (isLosslessNumber(value)) {
    const str = value.value;
    if (!/^-?\d+$/.test(str)) {
      throw new CoinDcxResponseValidationError(
        `Timestamp field '${fieldName}' must be an integer, received fractional: ${str}`
      );
    }
    const num = Number(str);
    if (!Number.isSafeInteger(num)) {
      throw new CoinDcxResponseValidationError(
        `Timestamp field '${fieldName}' exceeds JavaScript safe integer range: ${str}`
      );
    }
    return num;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const num = Number(value);
    if (!Number.isSafeInteger(num)) {
      throw new CoinDcxResponseValidationError(
        `Timestamp field '${fieldName}' exceeds JavaScript safe integer range: ${value}`
      );
    }
    return num;
  }
  throw new CoinDcxResponseValidationError(
    `Invalid timestamp value for '${fieldName}': ${String(value)}`
  );
}

export function normalizeInstrument(wire: InstrumentWire): InrFuturesInstrument {
  if (wire.margin_currency_short_name.toUpperCase() !== 'INR') {
    throw new CoinDcxResponseValidationError(
      `Instrument margin currency must be 'INR', received '${wire.margin_currency_short_name}'`,
      { pair: wire.pair }
    );
  }

  // Parse dynamic position leverage details
  const dynamicPositionLeverageTiers: DynamicLeverageTier[] = [];
  if (wire.dynamic_position_leverage_details && typeof wire.dynamic_position_leverage_details === 'object') {
    for (const [k, v] of Object.entries(wire.dynamic_position_leverage_details)) {
      if (v !== undefined && v !== null) {
        dynamicPositionLeverageTiers.push({
          leverage: toLosslessDecimal(k, 'leverageKey'),
          maxPositionSizeUsdt: toLosslessDecimal(v, 'maxPositionSizeUsdt'),
        });
      }
    }
    dynamicPositionLeverageTiers.sort((a, b) => a.leverage.comparedTo(b.leverage));
  }

  // Parse dynamic safety margin details
  const dynamicSafetyMarginTiers: DynamicSafetyMarginTier[] = [];
  if (wire.dynamic_safety_margin_details && typeof wire.dynamic_safety_margin_details === 'object') {
    for (const [k, v] of Object.entries(wire.dynamic_safety_margin_details)) {
      if (v !== undefined && v !== null) {
        dynamicSafetyMarginTiers.push({
          positionSizeThresholdUsdt: toLosslessDecimal(k, 'thresholdKey'),
          maintenanceMarginPercent: toLosslessDecimal(v, 'maintenanceMarginPercent'),
        });
      }
    }
    dynamicSafetyMarginTiers.sort((a, b) =>
      a.positionSizeThresholdUsdt.comparedTo(b.positionSizeThresholdUsdt)
    );
  }

  return {
    pair: wire.pair,
    status: wire.status,
    kind: wire.kind,
    settlement: wire.settlement ?? null,
    settleCurrency: wire.settle_currency_short_name,
    quoteCurrency: wire.quote_currency_short_name,
    positionCurrency: wire.position_currency_short_name,
    underlyingCurrency: wire.underlying_currency_short_name,
    marginCurrency: 'INR',
    unitContractValue: toLosslessDecimal(wire.unit_contract_value, 'unit_contract_value'),
    priceIncrement: toLosslessDecimal(wire.price_increment, 'price_increment'),
    quantityIncrement: toLosslessDecimal(wire.quantity_increment, 'quantity_increment'),
    minTradeSize: toLosslessDecimal(wire.min_trade_size, 'min_trade_size'),
    minPrice: toLosslessDecimal(wire.min_price, 'min_price'),
    maxPrice: toLosslessDecimal(wire.max_price, 'max_price'),
    minQuantity: toLosslessDecimal(wire.min_quantity, 'min_quantity'),
    maxQuantity: toLosslessDecimal(wire.max_quantity, 'max_quantity'),
    minNotional: toLosslessDecimal(wire.min_notional, 'min_notional'),
    maxNotional: nullableLosslessDecimal(wire.max_notional, 'max_notional'),
    maxMarketOrderQuantity: nullableLosslessDecimal(wire.max_market_order_quantity, 'max_market_order_quantity'),
    makerFeePercent: toLosslessDecimal(wire.maker_fee, 'maker_fee'),
    takerFeePercent: toLosslessDecimal(wire.taker_fee, 'taker_fee'),
    safetyPercentage: nullableLosslessDecimal(wire.safety_percentage, 'safety_percentage'),
    fundingFrequency:
      wire.funding_frequency !== undefined && wire.funding_frequency !== null
        ? toSafeIntegerTimestamp(wire.funding_frequency, 'funding_frequency')
        : null,
    expiryTimeMs:
      wire.expiry_time !== undefined && wire.expiry_time !== null
        ? toSafeIntegerTimestamp(wire.expiry_time, 'expiry_time')
        : null,
    exitOnly: wire.exit_only ?? false,
    timeInForceOptions: Object.freeze([...(wire.time_in_force_options ?? [])]),
    supportedOrderTypes: Object.freeze([...(wire.order_types ?? [])]),
    dynamicPositionLeverageTiers: Object.freeze(dynamicPositionLeverageTiers),
    dynamicSafetyMarginTiers: Object.freeze(dynamicSafetyMarginTiers),
    legacyMaxLeverageLongIgnored: nullableLosslessDecimal(wire.max_leverage_long, 'max_leverage_long'),
    legacyMaxLeverageShortIgnored: nullableLosslessDecimal(wire.max_leverage_short, 'max_leverage_short'),
    raw: { ...wire },
  };
}

export function normalizeWallet(wire: FuturesWalletWire): InrFuturesWallet {
  return {
    id: wire.id ?? null,
    currency: wire.currency_short_name.toUpperCase(),
    lockedInitialMargin: toLosslessDecimal(wire.locked_balance, 'locked_balance'),
    legacyBalanceIgnored: nullableLosslessDecimal(wire.balance, 'balance'),
    crossOrderMargin: nullableLosslessDecimal(wire.cross_order_margin, 'cross_order_margin'),
    crossUserMargin: nullableLosslessDecimal(wire.cross_user_margin, 'cross_user_margin'),
  };
}


export function normalizePosition(wire: FuturesPositionWire): InrFuturesPosition {
  if (wire.margin_currency_short_name.toUpperCase() !== 'INR') {
    throw new CoinDcxResponseValidationError(
      `Position margin currency must be 'INR', received '${wire.margin_currency_short_name}'`,
      { id: wire.id, pair: wire.pair }
    );
  }

  // CoinDCX documentation states cross margin is unsupported for INR-margined Futures
  if (wire.margin_type === 'crossed') {
    throw new CoinDcxResponseValidationError(
      `Cross margin is unsupported for CoinDCX INR-margined Futures: position '${wire.id}' is crossed`,
      { id: wire.id, pair: wire.pair, marginType: wire.margin_type }
    );
  }

  if (wire.margin_type !== null && wire.margin_type !== 'isolated') {
    throw new CoinDcxResponseValidationError(
      `Unexpected margin_type '${wire.margin_type}' for INR Futures position '${wire.id}'`,
      { id: wire.id, pair: wire.pair, marginType: wire.margin_type }
    );
  }

  // Required fields fail-closed check
  if (wire.active_pos === undefined) throw new CoinDcxResponseValidationError("Missing required field 'active_pos'");
  if (wire.avg_price === undefined) throw new CoinDcxResponseValidationError("Missing required field 'avg_price'");
  if (wire.locked_margin === undefined) throw new CoinDcxResponseValidationError("Missing required field 'locked_margin'");
  if (wire.locked_user_margin === undefined) throw new CoinDcxResponseValidationError("Missing required field 'locked_user_margin'");
  if (wire.locked_order_margin === undefined) throw new CoinDcxResponseValidationError("Missing required field 'locked_order_margin'");
  if (wire.leverage === undefined) throw new CoinDcxResponseValidationError("Missing required field 'leverage'");
  if (wire.maintenance_margin === undefined) throw new CoinDcxResponseValidationError("Missing required field 'maintenance_margin'");
  if (wire.mark_price === undefined) throw new CoinDcxResponseValidationError("Missing required field 'mark_price'");
  if (wire.settlement_currency_avg_price === undefined) {
    throw new CoinDcxResponseValidationError("Missing required field 'settlement_currency_avg_price'");
  }

  const activePositionQuantity = toLosslessDecimal(wire.active_pos, 'active_pos');

  // Conditional active-position safety:
  // For active positions (activePositionQuantity != 0), maintenance_margin, mark_price,
  // and settlement_currency_avg_price MUST be non-null.
  // For flat positions (activePositionQuantity == 0), explicit null is permitted.
  let maintenanceMarginUsdt: Decimal | null;
  let markPriceUsdt: Decimal | null;
  let settlementCurrencyAvgPriceInrPerUsdt: Decimal | null;

  if (!activePositionQuantity.isZero()) {
    if (wire.maintenance_margin === null) {
      throw new CoinDcxResponseValidationError(
        `Active position '${wire.id}' on pair '${wire.pair}' requires non-null 'maintenance_margin'`,
        { id: wire.id, pair: wire.pair }
      );
    }
    if (wire.mark_price === null) {
      throw new CoinDcxResponseValidationError(
        `Active position '${wire.id}' on pair '${wire.pair}' requires non-null 'mark_price'`,
        { id: wire.id, pair: wire.pair }
      );
    }
    if (wire.settlement_currency_avg_price === null) {
      throw new CoinDcxResponseValidationError(
        `Active INR position '${wire.id}' on pair '${wire.pair}' requires non-null 'settlement_currency_avg_price'`,
        { id: wire.id, pair: wire.pair }
      );
    }
    maintenanceMarginUsdt = toLosslessDecimal(wire.maintenance_margin, 'maintenance_margin');
    markPriceUsdt = toLosslessDecimal(wire.mark_price, 'mark_price');
    settlementCurrencyAvgPriceInrPerUsdt = toLosslessDecimal(
      wire.settlement_currency_avg_price,
      'settlement_currency_avg_price'
    );
  } else {
    maintenanceMarginUsdt = nullableLosslessDecimal(wire.maintenance_margin, 'maintenance_margin');
    markPriceUsdt = nullableLosslessDecimal(wire.mark_price, 'mark_price');
    settlementCurrencyAvgPriceInrPerUsdt = nullableLosslessDecimal(
      wire.settlement_currency_avg_price,
      'settlement_currency_avg_price'
    );
  }

  return {
    id: wire.id,
    pair: wire.pair,
    activePositionQuantity, // Signed: negative for short, positive for long
    inactiveBuyQuantity: nullableLosslessDecimal(wire.inactive_pos_buy, 'inactive_pos_buy') ?? zeroDecimal(),
    inactiveSellQuantity: nullableLosslessDecimal(wire.inactive_pos_sell, 'inactive_pos_sell') ?? zeroDecimal(),
    avgPriceUsdt: toLosslessDecimal(wire.avg_price, 'avg_price'),
    liquidationPriceUsdt: nullableLosslessDecimal(wire.liquidation_price, 'liquidation_price'),
    lockedMarginUsdt: toLosslessDecimal(wire.locked_margin, 'locked_margin'),
    lockedUserMarginUsdt: toLosslessDecimal(wire.locked_user_margin, 'locked_user_margin'),
    lockedOrderMarginUsdt: toLosslessDecimal(wire.locked_order_margin, 'locked_order_margin'),
    maintenanceMarginUsdt,
    markPriceUsdt,
    takeProfitTriggerPriceUsdt: nullableLosslessDecimal(wire.take_profit_trigger, 'take_profit_trigger'),
    stopLossTriggerPriceUsdt: nullableLosslessDecimal(wire.stop_loss_trigger, 'stop_loss_trigger'),
    leverage: toLosslessDecimal(wire.leverage, 'leverage'),
    marginType: 'isolated', // Documented: null or 'isolated' represents isolated
    settlementCurrencyAvgPriceInrPerUsdt,
    marginCurrency: 'INR',
    updatedAtMs: toSafeIntegerTimestamp(wire.updated_at, 'updated_at'),
  };
}


export function normalizeOrder(wire: FuturesOrderWire): InrFuturesOrder {
  if (wire.margin_currency_short_name.toUpperCase() !== 'INR') {
    throw new CoinDcxResponseValidationError(
      `Order margin currency must be 'INR', received '${wire.margin_currency_short_name}'`,
      { id: wire.id, pair: wire.pair }
    );
  }

  return {
    id: wire.id,
    pair: wire.pair,
    side: wire.side,
    status: wire.status,
    orderType: wire.order_type,
    priceUsdt: nullableLosslessDecimal(wire.price, 'price'),
    stopPriceUsdt: nullableLosslessDecimal(wire.stop_price, 'stop_price'),
    avgPriceUsdt: nullableLosslessDecimal(wire.avg_price, 'avg_price'),
    totalQuantity: toLosslessDecimal(wire.total_quantity, 'total_quantity'),
    remainingQuantity: toLosslessDecimal(wire.remaining_quantity, 'remaining_quantity'),
    cancelledQuantity: nullableLosslessDecimal(wire.cancelled_quantity, 'cancelled_quantity'),
    feeAmountUsdt: nullableLosslessDecimal(wire.fee_amount, 'fee_amount'),
    settlementCurrencyConversionPriceInrPerUsdt: nullableLosslessDecimal(
      wire.settlement_currency_conversion_price,
      'settlement_currency_conversion_price'
    ),
    makerFeePercent: nullableLosslessDecimal(wire.maker_fee, 'maker_fee'),
    takerFeePercent: nullableLosslessDecimal(wire.taker_fee, 'taker_fee'),
    leverage: nullableLosslessDecimal(wire.leverage, 'leverage'),
    stage: wire.stage ?? null,
    positionMarginType: wire.position_margin_type ?? null,
    marginCurrency: 'INR',
    createdAtMs: toSafeIntegerTimestamp(wire.created_at, 'created_at'),
    updatedAtMs: toSafeIntegerTimestamp(wire.updated_at, 'updated_at'),
  };
}

export function normalizePositionTransaction(
  wire: FuturesPositionTransactionWire
): InrFuturesPositionTransaction {
  if (wire.margin_currency_short_name.toUpperCase() !== 'INR') {
    throw new CoinDcxResponseValidationError(
      `Transaction margin currency must be 'INR', received '${wire.margin_currency_short_name}'`
    );
  }

  return {
    pair: wire.pair ?? null,
    stage: wire.stage,
    pnlAmountInr: toLosslessDecimal(wire.amount, 'amount'),
    feeAmountInr: toLosslessDecimal(wire.fee_amount, 'fee_amount'),
    priceInInr: nullableLosslessDecimal(wire.price_in_inr, 'price_in_inr'),
    priceInUsdt: nullableLosslessDecimal(wire.price_in_usdt, 'price_in_usdt'),
    settlementAmountInr: nullableLosslessDecimal(wire.settlement_amount, 'settlement_amount'),
    parentType: wire.parent_type ?? null,
    parentId: wire.parent_id ?? null,
    positionId: wire.position_id ?? null,
    source: wire.source ?? null,
    marginCurrency: 'INR',
    createdAtMs: toSafeIntegerTimestamp(wire.created_at, 'created_at'),
    updatedAtMs: toSafeIntegerTimestamp(wire.updated_at, 'updated_at'),
  };
}

export function normalizeTrade(wire: FuturesTradeWire): InrFuturesTrade {
  if (wire.margin_currency_short_name.toUpperCase() !== 'INR') {
    throw new CoinDcxResponseValidationError(
      `Trade margin currency must be 'INR', received '${wire.margin_currency_short_name}'`,
      { pair: wire.pair }
    );
  }

  return {
    pair: wire.pair,
    side: wire.side,
    priceUsdt: toLosslessDecimal(wire.price, 'price'),
    quantity: toLosslessDecimal(wire.quantity, 'quantity'),
    feeAmountUsdt: toLosslessDecimal(wire.fee_amount, 'fee_amount'),
    isMaker: wire.is_maker ?? null,
    orderId: wire.order_id ?? null,
    settlementCurrencyConversionPriceInrPerUsdt: nullableLosslessDecimal(
      wire.settlement_currency_conversion_price,
      'settlement_currency_conversion_price'
    ),
    marginCurrency: 'INR',
    timestampMs: toSafeIntegerTimestamp(wire.timestamp, 'timestamp'),
  };
}

export function normalizeWalletTransaction(
  wire: FuturesWalletTransactionWire
): FuturesWalletTransaction {
  return {
    walletId: wire.derivatives_futures_wallet_id ?? null,
    transactionType: wire.transaction_type,
    amount: toLosslessDecimal(wire.amount, 'amount'),
    currency: wire.currency_short_name,
    currencyFullName: wire.currency_full_name ?? null,
    reason: wire.reason ?? null,
    createdAtMs: toSafeIntegerTimestamp(wire.created_at, 'created_at'),
  };
}

export function normalizeUserInfo(
  wire: z.infer<typeof UserInfoItemWireSchema>
): AuthVerificationResult {
  // CRITICAL SECURITY: Email, phone, name are discarded. Only connectivity proof and internal ID retained.
  return {
    authenticated: true,
    coindcxId: wire.coindcx_id,
  };
}
