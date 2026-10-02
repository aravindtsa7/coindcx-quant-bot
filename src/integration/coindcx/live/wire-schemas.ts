import { types } from 'node:util';
/** Strict current CoinDCX futures order wire contracts. */
import { isLosslessNumber, LosslessNumber } from 'lossless-json';
import { z } from 'zod';
import { COINDCX_CLIENT_ORDER_ID_MAX_LENGTH } from '../../../execution/live/identity';

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

/**
 * [Wave B3 / F18-24] Deliberately carries NO `time_in_force` field.
 *
 * This is the RESPONSE-side economics shape (create-response and list-orders/
 * observation), not the create-REQUEST shape below (`LiveCreateRequestSchema`,
 * which DOES send `time_in_force` — a request and its response are different
 * contracts). `docs/PHASE18_RECONCILIATION.md` §8 records this precisely:
 * [Wave B4 / F18-24] no authoritative time-in-force field is documented in
 * the verified CoinDCX futures List Orders response contract available to
 * this project. That is an evidence-bounded claim about what this project has
 * verified and documented, not an assertion about the provider's full,
 * possibly-undocumented behavior under every circumstance — this project has
 * no way to prove a universal negative about an external API it does not
 * control. The distinction matters operationally: it is why `.passthrough()`
 * below preserves unexpected fields instead of stripping them, and why F18-21
 * blocks on the ABSENCE of verified evidence rather than on a claim that the
 * field structurally cannot exist.
 *
 * `.passthrough()` means any UNEXPECTED field the real venue response
 * happens to carry — including, hypothetically, a TIF-like one — is
 * preserved in the parsed object rather than stripped, but nothing here maps
 * it into `LiveVenueOrderEvidence`: no such field is added to this schema on
 * spec, because doing so without a verified field name and verified
 * semantics would be exactly the kind of fabricated provider behavior this
 * repository's evidence model forbids (§14 "absence is never proof" cuts
 * both ways — presence of an UNVERIFIED field is not proof either). If a
 * maintainer ever independently verifies a real field name and its
 * authoritative meaning against actual CoinDCX documentation or a captured
 * response, the correct sequence is: (1) add it here as a typed, non-optional
 * enum of only the documented values; (2) map it into
 * `LiveVenueOrderEvidence` with unknown/malformed values normalized to
 * "unproven", never guessed; (3) SEPARATELY and explicitly decide whether to
 * narrow `ambiguousCreateIdentityUnobservableReason` (F18-21) — its presence
 * in the wire shape must never, by itself, re-enable automatic ambiguous-
 * create resolution.
 */
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
    // Provider-confirmed on create and observed in List Orders (null on orders
    // created without one). Typed as unknown so an unexpected type cannot fail
    // the whole response; the adapter accepts only an exact string equal to
    // the local id, treats null/absent as "no echo", and treats any other value
    // as an identity mismatch.
    client_order_id: z.unknown().optional(),
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
    // Mandatory on every normal create: the intent's persisted deterministic
    // id, within the provider-confirmed 36-character limit.
    client_order_id: z.string().min(1).max(COINDCX_CLIENT_ORDER_ID_MAX_LENGTH),
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

/** Independent literal recipes: no public application-owned graph node is reused. */
function makeOwnedCancelGraphs() {
const LiveWireNumericSchema = z.union([
  z.string(),
  z.number(),
  z.custom<LosslessNumber>((value) => isLosslessNumber(value), { message: 'Expected LosslessNumber' }),
]);
const Wire200Schema = LiveWireNumericSchema.refine((value) => {
  if (isLosslessNumber(value)) return value.value === '200';
  return String(value) === '200';
}, { message: 'Expected provider success code 200' });
const LiveCancelResponseSchema = z.object({
  message: z.literal('success'),
  status: Wire200Schema,
  code: Wire200Schema,
}).passthrough();
const LiveErrorResponseSchema = z.object({
  message: z.string().min(1),
  code: z.union([z.string(), z.number()]).optional(),
  status: z.union([z.string(), z.number()]).optional(),
}).passthrough();
return { LiveCancelResponseSchema, LiveErrorResponseSchema };
}
const ownedCancelGraphs = makeOwnedCancelGraphs();
const ownedZodError = z.ZodError;
function copyOwnedParserIssue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? '[UNSAFE_PARSE_ISSUE]' : value;
  if (types.isProxy(value)) throw new Error('UNSAFE_PARSE_ISSUE');
  if (value instanceof ownedZodError) return new ownedZodError(value.issues.map(issue => copyOwnedParserIssue(issue) as z.ZodIssue));
  const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, 'value')) throw new Error('UNSAFE_PARSE_ISSUE');
    Object.defineProperty(result, key, { value: copyOwnedParserIssue(descriptor.value), enumerable: true, writable: true, configurable: true });
  }
  return result;
}
function detachOwnedParserResult<T extends z.SafeParseReturnType<unknown, unknown>>(result: T): T {
  if (result.success) return result;
  try { return { success: false, error: new ownedZodError(result.error.issues.map(issue => copyOwnedParserIssue(issue) as z.ZodIssue)) } as T; }
  catch { return { success: false, error: new ownedZodError([{ code: 'custom', path: [], message: 'Unsafe parser issue data' }]) } as T; }
}
export function parseOwnedCancelResponse(value: unknown): ReturnType<typeof LiveCancelResponseSchema.safeParse> {
  return detachOwnedParserResult(ownedCancelGraphs.LiveCancelResponseSchema.safeParse(value));
}
Object.freeze(parseOwnedCancelResponse);
export function parseOwnedCancelError(value: unknown): ReturnType<typeof LiveErrorResponseSchema.safeParse> {
  return detachOwnedParserResult(ownedCancelGraphs.LiveErrorResponseSchema.safeParse(value));
}
Object.freeze(parseOwnedCancelError);
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const [name, value] of Object.entries({ parseOwnedCancelResponse, parseOwnedCancelError })) {
    const descriptor = Object.getOwnPropertyDescriptor(module.exports, name);
    if (descriptor?.configurable === false) {
      if (descriptor.get === undefined || descriptor.set !== undefined || module.exports[name] !== value) throw new Error('OWNED_TRUSTED_EXPORT_INVALID');
    } else Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
  }
}
