import { z } from 'zod';
import { Decimal } from '../../../core/decimal/decimal';
import { CoinDcxSocketValidationError } from '../../../core/errors/app-error';
import {
  PrivateBalanceNotificationPayload,
  PrivateBalanceRecord,
  PrivateOrderNotificationPayload,
  PrivateOrderRecord,
  PrivatePositionNotificationPayload,
  PrivatePositionRecord,
  PublicCandleUpdatePayload,
} from './types';

/**
 * Safely parses financial decimal strings and numbers.
 * Invariant: Never uses parseFloat or unary + on financial values.
 * Rejects NaN, Infinity, empty/whitespace strings.
 */
export function parseFinancialDecimal(val: unknown, fieldName: string): Decimal {
  if (val === null || val === undefined) {
    throw new CoinDcxSocketValidationError(`Missing required financial field: ${fieldName}`);
  }

  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (
      trimmed === '' ||
      trimmed.toLowerCase().includes('nan') ||
      trimmed.toLowerCase().includes('inf')
    ) {
      throw new CoinDcxSocketValidationError(`Invalid numeric string for ${fieldName}: '${val}'`);
    }
    try {
      const dec = new Decimal(trimmed);
      if (!dec.isFinite() || dec.isNaN()) {
        throw new Error();
      }
      return dec;
    } catch {
      throw new CoinDcxSocketValidationError(`Non-finite decimal for ${fieldName}: '${val}'`);
    }
  }

  if (typeof val === 'number') {
    if (!Number.isFinite(val) || Number.isNaN(val)) {
      throw new CoinDcxSocketValidationError(`Non-finite number for ${fieldName}: ${val}`);
    }
    return new Decimal(val.toString());
  }

  throw new CoinDcxSocketValidationError(
    `Unsupported financial type for ${fieldName}: ${typeof val}`
  );
}

export function parseOptionalFinancialDecimal(
  val: unknown,
  fieldName: string
): Decimal | null {
  if (val === null || val === undefined) {
    return null;
  }
  return parseFinancialDecimal(val, fieldName);
}

/**
 * Normalizes timestamps to UTC epoch milliseconds.
 * If provider transmits epoch in seconds (e.g. 1705514400), converts to ms.
 */
export function normalizeTimestampToMs(val: unknown, fieldName: string): number {
  if (typeof val !== 'number' || !Number.isFinite(val) || Number.isNaN(val) || val < 0) {
    throw new CoinDcxSocketValidationError(`Invalid timestamp for ${fieldName}: ${String(val)}`);
  }

  // If timestamp is in seconds (< 100 billion, i.e. < year 5138 in seconds)
  if (val < 100_000_000_000) {
    return Math.floor(val * 1000);
  }

  return Math.floor(val);
}

// ============================================================================
// 1. PUBLIC CANDLESTICK WIRE SCHEMAS
// ============================================================================

const RawCandleItemSchema = z.object({
  open: z.union([z.string(), z.number()]),
  high: z.union([z.string(), z.number()]),
  low: z.union([z.string(), z.number()]),
  close: z.union([z.string(), z.number()]),
  volume: z.union([z.string(), z.number()]),
  quote_volume: z.union([z.string(), z.number()]).optional(),
  open_time: z.number(),
  close_time: z.number(),
  pair: z.string().min(1),
  duration: z.string().min(1),
  symbol: z.string().optional(),
});

export const RawCandleEnvelopeSchema = z.object({
  data: z.array(RawCandleItemSchema).min(1, 'Candle data array must contain at least one candle'),
  Ets: z.number(),
  i: z.string(),
  channel: z.string(),
  pr: z.string(),
});

export function validateAndNormalizeCandleEvent(
  raw: unknown,
  expectedPair?: string
): PublicCandleUpdatePayload {
  let normalizedRaw = raw;
  if (typeof raw === 'string') {
    try {
      normalizedRaw = JSON.parse(raw);
    } catch {
      throw new CoinDcxSocketValidationError('Malformed JSON candlestick envelope string');
    }
  }

  if (normalizedRaw && typeof normalizedRaw === 'object') {
    const rawObj = normalizedRaw as Record<string, unknown>;
    if (typeof rawObj['data'] === 'string') {
      try {
        const inner = JSON.parse(rawObj['data']);
        if (Array.isArray(inner)) {
          normalizedRaw = { ...rawObj, data: inner };
        } else if (typeof inner === 'object' && inner !== null) {
          normalizedRaw = { ...rawObj, ...inner };
        }
      } catch {
        throw new CoinDcxSocketValidationError('Malformed inner JSON candlestick data');
      }
    }
  }

  const parsed = RawCandleEnvelopeSchema.safeParse(normalizedRaw);
  if (!parsed.success) {
    throw new CoinDcxSocketValidationError('Malformed candlestick envelope from provider', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  const { data, Ets, i, channel, pr } = parsed.data;

  // Invariant 2 & Invariant Scope: Only Futures product allowed
  if (pr.toLowerCase() !== 'futures') {
    throw new CoinDcxSocketValidationError(`Invalid candle product: '${pr}'. Expected 'futures'`);
  }

  // Canonical live stream is strictly 1m
  if (i !== '1m') {
    throw new CoinDcxSocketValidationError(`Invalid candle interval: '${i}'. Expected '1m'`);
  }

  const candle = data[0]!;
  if (candle.duration !== '1m') {
    throw new CoinDcxSocketValidationError(
      `Candle duration mismatch: '${candle.duration}'. Expected '1m'`
    );
  }

  if (expectedPair && candle.pair !== expectedPair) {
    throw new CoinDcxSocketValidationError(
      `Candle pair '${candle.pair}' does not match expected subscription pair '${expectedPair}'`
    );
  }

  const open = parseFinancialDecimal(candle.open, 'open');
  const high = parseFinancialDecimal(candle.high, 'high');
  const low = parseFinancialDecimal(candle.low, 'low');
  const close = parseFinancialDecimal(candle.close, 'close');
  const volume = parseFinancialDecimal(candle.volume, 'volume');
  const quoteVolume = candle.quote_volume !== undefined
    ? parseFinancialDecimal(candle.quote_volume, 'quote_volume')
    : new Decimal(0);

  // Prices must be non-negative
  if (open.isNegative() || high.isNegative() || low.isNegative() || close.isNegative()) {
    throw new CoinDcxSocketValidationError('Candle prices must be non-negative');
  }

  // Volumes must be non-negative
  if (volume.isNegative() || quoteVolume.isNegative()) {
    throw new CoinDcxSocketValidationError('Candle volumes must be non-negative');
  }

  // Structural OHLC consistency checks
  if (high.lessThan(low)) {
    throw new CoinDcxSocketValidationError(
      `Structural OHLC violation: high (${high}) < low (${low})`
    );
  }
  if (high.lessThan(open)) {
    throw new CoinDcxSocketValidationError(
      `Structural OHLC violation: high (${high}) < open (${open})`
    );
  }
  if (high.lessThan(close)) {
    throw new CoinDcxSocketValidationError(
      `Structural OHLC violation: high (${high}) < close (${close})`
    );
  }
  if (low.greaterThan(open)) {
    throw new CoinDcxSocketValidationError(
      `Structural OHLC violation: low (${low}) > open (${open})`
    );
  }
  if (low.greaterThan(close)) {
    throw new CoinDcxSocketValidationError(
      `Structural OHLC violation: low (${low}) > close (${close})`
    );
  }

  const openTimeMs = normalizeTimestampToMs(candle.open_time, 'open_time');
  const closeTimeMs = normalizeTimestampToMs(candle.close_time, 'close_time');
  const providerEventTimeMs = normalizeTimestampToMs(Ets, 'Ets');

  if (openTimeMs > closeTimeMs) {
    throw new CoinDcxSocketValidationError(
      `Candle openTimeMs (${openTimeMs}) > closeTimeMs (${closeTimeMs})`
    );
  }

  return Object.freeze({
    pair: candle.pair,
    duration: '1m',
    open,
    high,
    low,
    close,
    volume,
    quoteVolume,
    openTimeMs,
    closeTimeMs,
    providerEventTimeMs,
    isClosed: false as const, // Invariant: Phase 4 NEVER marks candle closed
    rawChannel: channel,
  });
}

// ============================================================================
// 2. PRIVATE POSITION WIRE SCHEMAS
// ============================================================================

const RawPositionItemSchema = z.object({
  id: z.string().min(1),
  pair: z.string().min(1),
  active_pos: z.union([z.string(), z.number()]),
  avg_price: z.union([z.string(), z.number()]),
  liquidation_price: z.union([z.string(), z.number()]).optional().nullable(),
  locked_margin: z.union([z.string(), z.number()]).optional().nullable(),
  leverage: z.number(),
  mark_price: z.union([z.string(), z.number()]).optional().nullable(),
  maintenance_margin: z.union([z.string(), z.number()]).optional().nullable(),
  updated_at: z.number(),
  margin_type: z.string().optional().nullable(),
  margin_currency_short_name: z.string(),
  settlement_currency_avg_price: z.union([z.string(), z.number()]).optional().nullable(),
});

export const RawPositionUpdateSchema = z.array(RawPositionItemSchema);

export function validateAndFilterPositionNotification(
  raw: unknown
): PrivatePositionNotificationPayload {
  const parsed = RawPositionUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CoinDcxSocketValidationError('Malformed df-position-update payload', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  const validInrPositions: PrivatePositionRecord[] = [];
  let droppedNonInrCount = 0;

  for (const item of parsed.data) {
    // Invariant 2: INR Futures only
    if (item.margin_currency_short_name !== 'INR') {
      droppedNonInrCount++;
      continue;
    }

    const activePosition = parseFinancialDecimal(item.active_pos, 'active_pos');
    const avgPrice = parseFinancialDecimal(item.avg_price, 'avg_price');
    const liquidationPrice = item.liquidation_price !== undefined && item.liquidation_price !== null
      ? parseFinancialDecimal(item.liquidation_price, 'liquidation_price')
      : new Decimal(0);
    const lockedMargin = item.locked_margin !== undefined && item.locked_margin !== null
      ? parseFinancialDecimal(item.locked_margin, 'locked_margin')
      : new Decimal(0);
    const markPrice = parseOptionalFinancialDecimal(item.mark_price, 'mark_price');
    const maintenanceMargin = parseOptionalFinancialDecimal(
      item.maintenance_margin,
      'maintenance_margin'
    );
    const settlementCurrencyAvgPrice = parseOptionalFinancialDecimal(
      item.settlement_currency_avg_price,
      'settlement_currency_avg_price'
    );

    validInrPositions.push(
      Object.freeze({
        id: item.id,
        pair: item.pair,
        activePosition,
        avgPrice,
        liquidationPrice,
        lockedMargin,
        leverage: item.leverage,
        markPrice,
        maintenanceMargin,
        updatedAtMs: normalizeTimestampToMs(item.updated_at, 'updated_at'),
        marginType: item.margin_type ?? 'isolated',
        marginCurrency: 'INR' as const,
        settlementCurrencyAvgPrice,
      })
    );
  }

  return Object.freeze({
    positions: Object.freeze(validInrPositions),
    droppedNonInrCount,
  });
}

// ============================================================================
// 3. PRIVATE ORDER WIRE SCHEMAS
// ============================================================================

const RawOrderItemSchema = z.object({
  id: z.string().min(1),
  pair: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  status: z.string(),
  order_type: z.string(),
  leverage: z.number().optional().default(1),
  price: z.union([z.string(), z.number()]).optional().nullable(),
  avg_price: z.union([z.string(), z.number()]).optional().nullable(),
  total_quantity: z.union([z.string(), z.number()]),
  remaining_quantity: z.union([z.string(), z.number()]).optional().nullable(),
  cancelled_quantity: z.union([z.string(), z.number()]).optional().nullable(),
  fee_amount: z.union([z.string(), z.number()]).optional().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  margin_currency_short_name: z.string(),
});

export const RawOrderUpdateSchema = z.array(RawOrderItemSchema);

export function validateAndFilterOrderNotification(
  raw: unknown
): PrivateOrderNotificationPayload {
  const parsed = RawOrderUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CoinDcxSocketValidationError('Malformed df-order-update payload', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  const validInrOrders: PrivateOrderRecord[] = [];
  let droppedNonInrCount = 0;

  for (const item of parsed.data) {
    if (item.margin_currency_short_name !== 'INR') {
      droppedNonInrCount++;
      continue;
    }

    const price = item.price !== undefined && item.price !== null
      ? parseFinancialDecimal(item.price, 'price')
      : new Decimal(0);
    const avgPrice = item.avg_price !== undefined && item.avg_price !== null
      ? parseFinancialDecimal(item.avg_price, 'avg_price')
      : new Decimal(0);
    const totalQuantity = parseFinancialDecimal(item.total_quantity, 'total_quantity');
    const remainingQuantity = item.remaining_quantity !== undefined && item.remaining_quantity !== null
      ? parseFinancialDecimal(item.remaining_quantity, 'remaining_quantity')
      : new Decimal(0);
    const cancelledQuantity = item.cancelled_quantity !== undefined && item.cancelled_quantity !== null
      ? parseFinancialDecimal(item.cancelled_quantity, 'cancelled_quantity')
      : new Decimal(0);
    const feeAmount = item.fee_amount !== undefined && item.fee_amount !== null
      ? parseFinancialDecimal(item.fee_amount, 'fee_amount')
      : new Decimal(0);

    validInrOrders.push(
      Object.freeze({
        id: item.id,
        pair: item.pair,
        side: item.side,
        status: item.status,
        orderType: item.order_type,
        leverage: item.leverage,
        price,
        avgPrice,
        totalQuantity,
        remainingQuantity,
        cancelledQuantity,
        feeAmount,
        createdAtMs: normalizeTimestampToMs(item.created_at, 'created_at'),
        updatedAtMs: normalizeTimestampToMs(item.updated_at, 'updated_at'),
        marginCurrency: 'INR' as const,
      })
    );
  }

  return Object.freeze({
    orders: Object.freeze(validInrOrders),
    droppedNonInrCount,
  });
}

// ============================================================================
// 4. PRIVATE BALANCE WIRE SCHEMAS
// ============================================================================

const RawBalanceItemSchema = z.object({
  id: z.union([z.string(), z.number()]),
  balance: z.union([z.string(), z.number()]),
  locked_balance: z.union([z.string(), z.number()]),
  currency_short_name: z.string(),
});

export const RawBalanceUpdateSchema = z.array(RawBalanceItemSchema);

export function validateBalanceNotification(
  raw: unknown
): PrivateBalanceNotificationPayload {
  const parsed = RawBalanceUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CoinDcxSocketValidationError('Malformed balance-update payload', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  const balances: PrivateBalanceRecord[] = parsed.data.map((item) => {
    return Object.freeze({
      id: String(item.id),
      balance: parseFinancialDecimal(item.balance, 'balance'),
      lockedBalance: parseFinancialDecimal(item.locked_balance, 'locked_balance'),
      currencyShortName: item.currency_short_name,
    });
  });

  return Object.freeze({
    balances: Object.freeze(balances),
  });
}
