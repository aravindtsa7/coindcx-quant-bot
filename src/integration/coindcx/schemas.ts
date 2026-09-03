import { isLosslessNumber, LosslessNumber } from 'lossless-json';
import { z } from 'zod';

/**
 * Universal validator for numeric values parsed by lossless-json or strings.
 * Preserves exact numeric lexemes without passing through JavaScript number.
 */
export const WireNumericSchema = z.union([
  z.string(),
  z.number(),
  z.custom<LosslessNumber>((val) => isLosslessNumber(val), {
    message: 'Expected LosslessNumber',
  }),
]);
export type WireNumeric = z.infer<typeof WireNumericSchema>;

// =========================================================================
// RUNTIME REQUEST VALIDATION SCHEMAS
// =========================================================================

export const PositiveIntegerStringSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'Must be a positive integer string (e.g. "1", "100")');

export const VALID_ORDER_STATUSES = [
  'open',
  'filled',
  'partially_filled',
  'partially_cancelled',
  'cancelled',
  'rejected',
  'untriggered',
] as const;
export type ValidOrderStatus = (typeof VALID_ORDER_STATUSES)[number];

export const OrderStatusStringSchema = z
  .string()
  .min(1, 'Status must be non-empty')
  .refine(
    (val) => {
      const parts = val.split(',').map((s) => s.trim());
      if (parts.length === 0 || parts.some((p) => p === '')) return false;
      return parts.every((p) => (VALID_ORDER_STATUSES as readonly string[]).includes(p));
    },
    {
      message:
        'Status must be a documented status or comma-separated combination of valid statuses (open, filled, partially_filled, partially_cancelled, cancelled, rejected, untriggered)',
    }
  );

export const ListInrOrdersRequestSchema = z.object({
  status: OrderStatusStringSchema,
  side: z.enum(['buy', 'sell']),
  page: PositiveIntegerStringSchema,
  size: PositiveIntegerStringSchema,
});
export type ListInrOrdersRequest = z.infer<typeof ListInrOrdersRequestSchema>;

export const ListInrPositionsRequestSchema = z.object({
  page: PositiveIntegerStringSchema,
  size: PositiveIntegerStringSchema,
  pairs: z.string().min(1).optional(),
  position_ids: z.string().min(1).optional(),
});
export type ListInrPositionsRequest = z.infer<typeof ListInrPositionsRequestSchema>;

export const VALID_TRANSACTION_STAGES = [
  'funding',
  'default',
  'exit',
  'tpsl_exit',
  'liquidation',
] as const;
export type ValidTransactionStage = (typeof VALID_TRANSACTION_STAGES)[number];

export const ListInrPositionTransactionsRequestSchema = z.object({
  stage: z.enum(VALID_TRANSACTION_STAGES, {
    errorMap: () => ({
      message:
        'Stage is required and must be one of: funding, default, exit, tpsl_exit, liquidation',
    }),
  }),
  page: PositiveIntegerStringSchema,
  size: PositiveIntegerStringSchema,
});
export type ListInrPositionTransactionsRequest = z.infer<
  typeof ListInrPositionTransactionsRequestSchema
>;

/**
 * Validates that a string is strictly in YYYY-MM-DD format AND represents
 * an actual valid Gregorian calendar date (with leap year awareness).
 */
export function isValidCalendarDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return false;
  }
  const parts = dateStr.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12) {
    return false;
  }
  if (day < 1 || day > 31) {
    return false;
  }

  const utcDate = new Date(Date.UTC(year, month - 1, day));
  return (
    utcDate.getUTCFullYear() === year &&
    utcDate.getUTCMonth() === month - 1 &&
    utcDate.getUTCDate() === day
  );
}

export const CalendarDateSchema = z
  .string()
  .refine((val) => isValidCalendarDate(val), {
    message: 'Must be a valid Gregorian calendar date in YYYY-MM-DD format',
  });

export const ListInrTradesRequestSchema = z
  .object({
    pair: z.string().min(1, 'Pair must be a non-empty string'),
    fromDate: CalendarDateSchema,
    toDate: CalendarDateSchema,
    page: PositiveIntegerStringSchema,
    size: PositiveIntegerStringSchema,
    orderId: z.string().min(1).optional(),
  })
  .refine((data) => data.fromDate <= data.toDate, {
    message: 'fromDate must be less than or equal to toDate',
    path: ['fromDate'],
  });
export type ListInrTradesRequest = z.infer<typeof ListInrTradesRequestSchema>;


export const ListWalletTransactionsRequestSchema = z.object({
  page: PositiveIntegerStringSchema,
  size: PositiveIntegerStringSchema,
});
export type ListWalletTransactionsRequest = z.infer<typeof ListWalletTransactionsRequestSchema>;

// =========================================================================
// WIRE RESPONSE SCHEMAS
// =========================================================================

export const ActiveInstrumentsResponseSchema = z.array(z.string());
export type ActiveInstrumentsResponse = z.infer<typeof ActiveInstrumentsResponseSchema>;

export const InstrumentWireSchema = z
  .object({
    pair: z.string(),
    status: z.string(),
    kind: z.string(),
    settlement: z.string().optional().nullable(),
    settle_currency_short_name: z.string(),
    quote_currency_short_name: z.string(),
    position_currency_short_name: z.string(),
    underlying_currency_short_name: z.string(),
    margin_currency_short_name: z.string(),
    max_leverage_long: WireNumericSchema.optional().nullable(),
    max_leverage_short: WireNumericSchema.optional().nullable(),
    unit_contract_value: WireNumericSchema,
    price_increment: WireNumericSchema,
    quantity_increment: WireNumericSchema,
    min_trade_size: WireNumericSchema,
    min_price: WireNumericSchema,
    max_price: WireNumericSchema,
    min_quantity: WireNumericSchema,
    max_quantity: WireNumericSchema,
    min_notional: WireNumericSchema,
    max_notional: WireNumericSchema.optional().nullable(),
    max_market_order_quantity: WireNumericSchema.optional().nullable(),
    maker_fee: WireNumericSchema,
    taker_fee: WireNumericSchema,
    safety_percentage: WireNumericSchema.optional().nullable(),
    funding_frequency: z.union([z.number(), z.custom<LosslessNumber>(isLosslessNumber)]).optional().nullable(),
    expiry_time: z.union([z.number(), z.custom<LosslessNumber>(isLosslessNumber)]).optional().nullable(),
    exit_only: z.boolean().optional().nullable(),
    time_in_force_options: z.array(z.string()).optional().default([]),
    order_types: z.array(z.string()).optional().default([]),
    dynamic_position_leverage_details: z.record(z.unknown()).optional().nullable(),
    dynamic_safety_margin_details: z.record(z.unknown()).optional().nullable(),
  })
  .passthrough();
export type InstrumentWire = z.infer<typeof InstrumentWireSchema>;

export const InstrumentDetailsResponseSchema = z.object({
  instrument: InstrumentWireSchema,
});
export type InstrumentDetailsResponse = z.infer<typeof InstrumentDetailsResponseSchema>;

export const UserInfoItemWireSchema = z
  .object({
    coindcx_id: z.string(),
    first_name: z.string().optional().nullable(),
    last_name: z.string().optional().nullable(),
    mobile_number: z.string().optional().nullable(),
    email: z.string().optional().nullable(),
  })
  .passthrough();

export const UserInfoResponseSchema = z.union([
  z.array(UserInfoItemWireSchema),
  UserInfoItemWireSchema,
]);
export type UserInfoResponse = z.infer<typeof UserInfoResponseSchema>;

export const FuturesWalletWireSchema = z
  .object({
    id: z.string().optional().nullable(),
    currency_short_name: z.string(),
    balance: WireNumericSchema.optional().nullable(), // Marked "Ignore this" in CoinDCX docs
    locked_balance: WireNumericSchema,
    cross_order_margin: WireNumericSchema.optional().nullable(),
    cross_user_margin: WireNumericSchema.optional().nullable(),
  })
  .passthrough();
export type FuturesWalletWire = z.infer<typeof FuturesWalletWireSchema>;

export const FuturesWalletsResponseSchema = z.array(FuturesWalletWireSchema);
export type FuturesWalletsResponse = z.infer<typeof FuturesWalletsResponseSchema>;

export const FuturesPositionWireSchema = z
  .object({
    id: z.string(),
    pair: z.string(),
    active_pos: WireNumericSchema,
    inactive_pos_buy: WireNumericSchema.optional().nullable(),
    inactive_pos_sell: WireNumericSchema.optional().nullable(),
    avg_price: WireNumericSchema,
    liquidation_price: WireNumericSchema.optional().nullable(),
    locked_margin: WireNumericSchema,
    locked_user_margin: WireNumericSchema,
    locked_order_margin: WireNumericSchema,
    take_profit_trigger: WireNumericSchema.optional().nullable(),
    stop_loss_trigger: WireNumericSchema.optional().nullable(),
    leverage: WireNumericSchema,
    maintenance_margin: WireNumericSchema.nullable(),
    mark_price: WireNumericSchema.nullable(),
    margin_type: z.string().nullable(), // null documented as isolated, 'crossed' unsupported for INR
    settlement_currency_avg_price: WireNumericSchema.nullable(),
    margin_currency_short_name: z.string(),
    updated_at: z.union([z.number(), z.custom<LosslessNumber>(isLosslessNumber)]),
  })
  .passthrough();
export type FuturesPositionWire = z.infer<typeof FuturesPositionWireSchema>;

export const FuturesPositionsResponseSchema = z.array(FuturesPositionWireSchema);
export type FuturesPositionsResponse = z.infer<typeof FuturesPositionsResponseSchema>;

export const FuturesOrderWireSchema = z
  .object({
    id: z.string(),
    pair: z.string(),
    side: z.enum(['buy', 'sell']),
    status: z.string(),
    order_type: z.string(),
    leverage: WireNumericSchema.optional().nullable(),
    maker_fee: WireNumericSchema.optional().nullable(),
    taker_fee: WireNumericSchema.optional().nullable(),
    fee_amount: WireNumericSchema.optional().nullable(),
    price: WireNumericSchema.optional().nullable(),
    stop_price: WireNumericSchema.optional().nullable(),
    avg_price: WireNumericSchema.optional().nullable(),
    total_quantity: WireNumericSchema,
    remaining_quantity: WireNumericSchema,
    cancelled_quantity: WireNumericSchema.optional().nullable(),
    settlement_currency_conversion_price: WireNumericSchema.optional().nullable(),
    stage: z.string().optional().nullable(),
    position_margin_type: z.string().optional().nullable(),
    margin_currency_short_name: z.string(),
    created_at: z.union([z.number(), z.custom<LosslessNumber>(isLosslessNumber)]),
    updated_at: z.union([z.number(), z.custom<LosslessNumber>(isLosslessNumber)]),
  })
  .passthrough();
export type FuturesOrderWire = z.infer<typeof FuturesOrderWireSchema>;

export const FuturesOrdersResponseSchema = z.array(FuturesOrderWireSchema);
export type FuturesOrdersResponse = z.infer<typeof FuturesOrdersResponseSchema>;

export const FuturesPositionTransactionWireSchema = z
  .object({
    pair: z.string().optional().nullable(),
    stage: z.string(),
    amount: WireNumericSchema, // Represents realized PnL in INR
    fee_amount: WireNumericSchema, // Fee in INR
    price_in_inr: WireNumericSchema.optional().nullable(),
    price_in_usdt: WireNumericSchema.optional().nullable(),
    parent_type: z.string().optional().nullable(),
    parent_id: z.string().optional().nullable(),
    position_id: z.string().optional().nullable(),
    settlement_amount: WireNumericSchema.optional().nullable(),
    source: z.string().optional().nullable(),
    margin_currency_short_name: z.string(),
    created_at: z.union([z.number(), z.custom<LosslessNumber>(isLosslessNumber)]),
    updated_at: z.union([z.number(), z.custom<LosslessNumber>(isLosslessNumber)]),
  })
  .passthrough();
export type FuturesPositionTransactionWire = z.infer<
  typeof FuturesPositionTransactionWireSchema
>;

export const FuturesPositionTransactionsResponseSchema = z.array(
  FuturesPositionTransactionWireSchema
);
export type FuturesPositionTransactionsResponse = z.infer<
  typeof FuturesPositionTransactionsResponseSchema
>;

export const FuturesTradeWireSchema = z
  .object({
    price: WireNumericSchema,
    quantity: WireNumericSchema,
    is_maker: z.boolean().optional().nullable(),
    fee_amount: WireNumericSchema,
    pair: z.string(),
    side: z.string(),
    timestamp: z.union([z.number(), z.custom<LosslessNumber>(isLosslessNumber)]),
    order_id: z.string().optional().nullable(),
    settlement_currency_conversion_price: WireNumericSchema.optional().nullable(),
    margin_currency_short_name: z.string(),
  })
  .passthrough();
export type FuturesTradeWire = z.infer<typeof FuturesTradeWireSchema>;

export const FuturesTradesResponseSchema = z.array(FuturesTradeWireSchema);
export type FuturesTradesResponse = z.infer<typeof FuturesTradesResponseSchema>;

export const FuturesWalletTransactionWireSchema = z
  .object({
    derivatives_futures_wallet_id: z.string().optional().nullable(),
    transaction_type: z.string(),
    amount: WireNumericSchema,
    currency_short_name: z.string(),
    currency_full_name: z.string().optional().nullable(),
    reason: z.string().optional().nullable(),
    created_at: z.union([z.number(), z.custom<LosslessNumber>(isLosslessNumber)]),
  })
  .passthrough();
export type FuturesWalletTransactionWire = z.infer<
  typeof FuturesWalletTransactionWireSchema
>;

export const FuturesWalletTransactionsResponseSchema = z.array(
  FuturesWalletTransactionWireSchema
);
export type FuturesWalletTransactionsResponse = z.infer<
  typeof FuturesWalletTransactionsResponseSchema
>;
