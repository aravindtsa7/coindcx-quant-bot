/** Strict current CoinDCX futures order wire contracts. */
import { isLosslessNumber, LosslessNumber } from 'lossless-json';
import { z } from 'zod';

export const LiveWireNumericSchema = z.union([
  z.string(),
  z.number(),
  z.custom<LosslessNumber>((value) => isLosslessNumber(value), { message: 'Expected LosslessNumber' }),
]);

export const LiveWireTimestampSchema = z.union([
  z.number(),
  z.custom<LosslessNumber>((value) => isLosslessNumber(value)),
]);

export const LIVE_OBSERVATION_WIRE_STATUSES = [
  'open',
  'filled',
  'partially_filled',
  'partially_cancelled',
  'cancelled',
  'rejected',
  'untriggered',
] as const;
export type LiveObservationWireStatus = (typeof LIVE_OBSERVATION_WIRE_STATUSES)[number];

export const LIVE_WIRE_ORDER_TYPES = [
  'limit_order',
  'market_order',
  'stop_limit',
  'stop_market',
  'take_profit_limit',
  'take_profit_market',
] as const;

const LiveOrderEconomicsSchema = z
  .object({
    id: z.string().min(1),
    pair: z.string().min(1),
    side: z.enum(['buy', 'sell']),
    order_type: z.enum(LIVE_WIRE_ORDER_TYPES),
    price: LiveWireNumericSchema.nullable(),
    avg_price: LiveWireNumericSchema,
    total_quantity: LiveWireNumericSchema,
    remaining_quantity: LiveWireNumericSchema,
    cancelled_quantity: LiveWireNumericSchema,
    leverage: LiveWireNumericSchema.optional().nullable(),
    margin_currency_short_name: z.enum(['INR', 'USDT']),
    settlement_currency_conversion_price: LiveWireNumericSchema.optional().nullable(),
    created_at: LiveWireTimestampSchema,
    updated_at: LiveWireTimestampSchema,
  })
  .passthrough();

/** Create returns an array containing exactly the newly-created order. */
export const LiveCreateOrderWireSchema = LiveOrderEconomicsSchema.extend({ status: z.literal('initial') });
export type LiveCreateOrderWire = z.infer<typeof LiveCreateOrderWireSchema>;
export const LiveCreateOrderResponseSchema = z.array(LiveCreateOrderWireSchema).length(1);

/** The documented list-orders observation endpoint returns a collection. */
export const LiveObservedOrderWireSchema = LiveOrderEconomicsSchema.extend({
  status: z.enum(LIVE_OBSERVATION_WIRE_STATUSES),
});
export type LiveObservedOrderWire = z.infer<typeof LiveObservedOrderWireSchema>;
export const LiveListOrdersResponseSchema = z.array(LiveObservedOrderWireSchema);

/** The documented cancel response is a success acknowledgement, not order truth. */
const Wire200Schema = LiveWireNumericSchema.refine((value) => {
  if (isLosslessNumber(value)) return value.value === '200';
  return String(value) === '200';
}, { message: 'Expected provider success code 200' });
export const LiveCancelResponseSchema = z.object({
  message: z.literal('success'),
  status: Wire200Schema,
  code: Wire200Schema,
}).passthrough();

/** Documented failures carry a provider message and may carry a code/status. */
export const LiveErrorResponseSchema = z.object({
  message: z.string().min(1),
  code: z.union([z.string(), z.number()]).optional(),
  status: z.union([z.string(), z.number()]).optional(),
}).passthrough();

/** Executable contract tests use this to prove a flat create body is invalid. */
export const LiveCreateRequestSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  order: z.object({
    side: z.enum(['buy', 'sell']),
    pair: z.string().min(1),
    order_type: z.enum(['limit_order', 'market_order']),
    price: LiveWireNumericSchema.nullable(),
    stop_price: z.null(),
    total_quantity: LiveWireNumericSchema,
    leverage: LiveWireNumericSchema.optional(),
    notification: z.literal('no_notification'),
    time_in_force: z.enum(['good_till_cancel', 'fill_or_kill', 'immediate_or_cancel']).optional(),
    margin_currency_short_name: z.literal('INR'),
  }).strict(),
}).strict();

export const LiveListOrdersRequestSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  status: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  page: z.string().regex(/^\d+$/),
  size: z.literal('200'),
  margin_currency_short_name: z.tuple([z.literal('INR')]),
}).strict();
