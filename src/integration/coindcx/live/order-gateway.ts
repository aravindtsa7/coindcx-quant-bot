/** CoinDCX futures live-order adapter for the verified current REST contract. */
import { isLosslessNumber } from 'lossless-json';
import type {
  CoinDcxFuturesOrderGateway,
  LiveCancelOrderRequest,
  LiveCancelOrderResult,
  LiveFetchOrderRequest,
  LiveFetchOrderResult,
  LivePlaceOrderRequest,
  LivePlaceOrderResult,
} from '../../../execution/live/gateway';
import { liveDecimal } from '../../../execution/live/decimal';
import type { LiveOrderObservation, LiveOrderObservationKind, LiveOrderSide, LiveTimeInForce } from '../../../execution/live/types';
import { Clock, SystemClock } from '../clock';
import { CoinDcxOrderMutationTransport } from './mutation-transport';
import {
  LiveCancelResponseSchema,
  LiveCreateOrderResponseSchema,
  LiveCreateRequestSchema,
  LiveErrorResponseSchema,
  LiveListOrdersRequestSchema,
  LiveListOrdersResponseSchema,
  type LiveCreateOrderWire,
  type LiveObservationWireStatus,
  type LiveObservedOrderWire,
} from './wire-schemas';

export const COINDCX_FUTURES_ORDER_CAPABILITIES = Object.freeze({
  supportsPostOnly: false,
  supportedOrderTypes: Object.freeze(['limit_order', 'market_order'] as const),
  supportedTimeInForce: Object.freeze(['good_till_cancel', 'fill_or_kill', 'immediate_or_cancel'] as const),
  supportsTimeInForceOnMarket: false,
});

const OBSERVATION_STATUSES = 'open,filled,partially_filled,partially_cancelled,cancelled,rejected,untriggered';
/** Requested page size only; the futures provider's actual page-size cap is not verified. */
const OBSERVATION_REQUESTED_PAGE_SIZE = '200' as const;
/** Finite loop guard, never evidence that provider pagination is exhausted. */
export const COINDCX_ORDER_OBSERVATION_MAX_PAGES = 100;
const FIXED_POINT = /^-?\d+(?:\.\d+)?$/;

type AnyOrderWire = LiveCreateOrderWire | LiveObservedOrderWire;

interface ExpectedOrderIdentity {
  readonly localClientOrderId: string;
  readonly exchangeOrderId: string | null;
  readonly pair: string;
  readonly side: LiveOrderSide;
  readonly wireOrderType: string;
  readonly quantity: string;
  readonly price: string | null;
  readonly settlementRateInrPerQuote: string | null;
  readonly marginCurrencyShortName: 'INR';
}

function exactNumeric(value: unknown): string | null {
  const raw = isLosslessNumber(value)
    ? value.value
    : typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : null;
  if (raw === null || !FIXED_POINT.test(raw.trim())) return null;
  try {
    return liveDecimal(raw.trim()).toFixed();
  } catch {
    return null;
  }
}

function providerTimestampMs(value: unknown): number | null {
  const exact = exactNumeric(value);
  if (exact === null) return null;
  const result = Number(exact);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function decimalEquals(left: string, right: string): boolean {
  try {
    return liveDecimal(left).equals(liveDecimal(right));
  } catch {
    return false;
  }
}

function wireTimeInForce(value: LiveTimeInForce): 'good_till_cancel' | 'fill_or_kill' | 'immediate_or_cancel' | null {
  switch (value) {
    case 'UNSPECIFIED': return null;
    case 'GOOD_TILL_CANCEL': return 'good_till_cancel';
    case 'FILL_OR_KILL': return 'fill_or_kill';
    case 'IMMEDIATE_OR_CANCEL': return 'immediate_or_cancel';
    case 'POST_ONLY': return null;
    default: return null;
  }
}

const STATUS_TO_OBSERVATION: Readonly<Record<LiveObservationWireStatus | 'initial', LiveOrderObservationKind | null>> = Object.freeze({
  initial: 'ACKNOWLEDGED',
  open: 'ACKNOWLEDGED',
  partially_filled: 'PARTIAL_FILL',
  filled: 'FILL',
  cancelled: 'CANCELLED',
  partially_cancelled: 'CANCELLED',
  rejected: 'REJECTED',
  untriggered: null,
});

export interface CoinDcxLiveOrderGatewayOptions {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly baseUrl?: string | undefined;
  readonly clock?: Clock | undefined;
}

export class CoinDcxLiveFuturesOrderGateway implements CoinDcxFuturesOrderGateway {
  readonly #transport: CoinDcxOrderMutationTransport;
  readonly #clock: Clock;

  public constructor(options: CoinDcxLiveOrderGatewayOptions) {
    this.#transport = new CoinDcxOrderMutationTransport({
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      baseUrl: options.baseUrl,
    });
    this.#clock = options.clock ?? new SystemClock();
  }

  public async placeOrder(request: LivePlaceOrderRequest): Promise<LivePlaceOrderResult> {
    if (request.timeInForce === 'POST_ONLY') {
      return { kind: 'PRE_DISPATCH_FAILURE', reasonCode: 'UNSUPPORTED_POST_ONLY' };
    }
    if (!COINDCX_FUTURES_ORDER_CAPABILITIES.supportedOrderTypes.includes(request.wireOrderType as 'limit_order' | 'market_order')) {
      return { kind: 'PRE_DISPATCH_FAILURE', reasonCode: 'UNSUPPORTED_ORDER_TYPE' };
    }
    if (request.wireOrderType === 'market_order' && request.timeInForce !== 'UNSPECIFIED') {
      return { kind: 'PRE_DISPATCH_FAILURE', reasonCode: 'INVALID_MARKET_TIME_IN_FORCE' };
    }

    const tif = wireTimeInForce(request.timeInForce);
    const order: Record<string, unknown> = {
      side: request.side === 'BUY' ? 'buy' : 'sell',
      pair: request.pair,
      order_type: request.wireOrderType,
      price: request.price,
      stop_price: null,
      total_quantity: request.quantity,
      notification: 'no_notification',
      margin_currency_short_name: 'INR',
    };
    if (request.leverage !== null) order['leverage'] = request.leverage;
    if (tif !== null) order['time_in_force'] = tif;
    const body = { timestamp: this.#clock.nowMs(), order };
    if (!LiveCreateRequestSchema.safeParse(body).success) {
      return { kind: 'PRE_DISPATCH_FAILURE', reasonCode: 'LIVE_CREATE_REQUEST_INVALID' };
    }

    const wire = await this.#transport.execute('CREATE_ORDER', body, request.timeoutMs);
    const failure = this.#classifyMutationFailure(wire);
    if (failure !== null) return failure;
    if (wire.kind !== 'RESPONSE') return { kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_RESPONSE_INVALID' };

    const parsed = LiveCreateOrderResponseSchema.safeParse(wire.data);
    if (!parsed.success) return { kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_RESPONSE_INVALID' };
    const translated = this.#translate(parsed.data[0]!, {
      localClientOrderId: request.clientOrderId,
      exchangeOrderId: null,
      pair: request.pair,
      side: request.side,
      wireOrderType: request.wireOrderType,
      quantity: request.quantity,
      price: request.price,
      settlementRateInrPerQuote: request.settlementRateInrPerQuote,
      marginCurrencyShortName: 'INR',
    });
    return translated === null
      ? { kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_IDENTITY_MISMATCH' }
      : { kind: 'ACCEPTED', observation: translated };
  }

  public async cancelOrder(request: LiveCancelOrderRequest): Promise<LiveCancelOrderResult> {
    const wire = await this.#transport.execute('CANCEL_ORDER', {
      timestamp: this.#clock.nowMs(),
      id: request.exchangeOrderId,
    }, request.timeoutMs);

    if (wire.kind === 'PRE_DISPATCH') return { kind: 'PRE_DISPATCH_FAILURE', reasonCode: wire.reasonCode };
    if (wire.kind === 'UNESTABLISHED') return { kind: 'AMBIGUOUS', reasonCode: wire.reasonCode };
    if (wire.statusCode >= 400) {
      if (!LiveErrorResponseSchema.safeParse(wire.data).success) return { kind: 'AMBIGUOUS', reasonCode: 'LIVE_ERROR_RESPONSE_INVALID' };
      return wire.statusCode < 500 && wire.statusCode !== 429
        ? { kind: 'REJECTED', reasonCode: `HTTP_${wire.statusCode}` }
        : { kind: 'AMBIGUOUS', reasonCode: `HTTP_${wire.statusCode}` };
    }
    if (!LiveCancelResponseSchema.safeParse(wire.data).success) {
      return { kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_RESPONSE_INVALID' };
    }
    return { kind: 'CANCEL_ACCEPTED', observation: null };
  }

  public async fetchOrder(request: LiveFetchOrderRequest): Promise<LiveFetchOrderResult> {
    let matched: LiveObservedOrderWire | null = null;
    for (let page = 1; page <= COINDCX_ORDER_OBSERVATION_MAX_PAGES; page += 1) {
      const body = {
        timestamp: this.#clock.nowMs(),
        status: OBSERVATION_STATUSES,
        side: request.side === 'BUY' ? 'buy' as const : 'sell' as const,
        page: String(page),
        size: OBSERVATION_REQUESTED_PAGE_SIZE,
        margin_currency_short_name: ['INR'] as ['INR'],
      };
      if (!LiveListOrdersRequestSchema.safeParse(body).success) {
        return { kind: 'AMBIGUOUS', reasonCode: 'LIVE_OBSERVATION_REQUEST_INVALID' };
      }
      const wire = await this.#transport.execute('LIST_ORDERS', body, request.timeoutMs);
      if (wire.kind !== 'RESPONSE') return { kind: 'AMBIGUOUS', reasonCode: wire.reasonCode };
      if (wire.statusCode >= 400) {
        if (!LiveErrorResponseSchema.safeParse(wire.data).success) return { kind: 'AMBIGUOUS', reasonCode: 'LIVE_ERROR_RESPONSE_INVALID' };
        return { kind: 'AMBIGUOUS', reasonCode: `HTTP_${wire.statusCode}` };
      }
      const parsed = LiveListOrdersResponseSchema.safeParse(wire.data);
      if (!parsed.success) return { kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_RESPONSE_INVALID' };

      // The current futures contract does not establish that a short non-empty
      // page is terminal. Only an empty page proves exhaustion. Keep at most
      // the single matching row while scanning so provider results are never
      // accumulated across pages.
      if (parsed.data.length === 0) {
        if (matched === null) return { kind: 'NOT_FOUND' };
        break;
      }

      for (const order of parsed.data) {
        if (order.id !== request.exchangeOrderId) continue;
        if (matched !== null) return { kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_IDENTITY_AMBIGUOUS' };
        matched = order;
      }
      if (page === COINDCX_ORDER_OBSERVATION_MAX_PAGES) {
        return { kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_OBSERVATION_PAGINATION_LIMIT' };
      }
    }

    // `matched === null` is unreachable here: only the empty-page branch may
    // establish NOT_FOUND, while the finite guard returns explicit ambiguity.
    if (matched === null) return { kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_OBSERVATION_PAGINATION_LIMIT' };
    const observation = this.#translate(matched, {
      localClientOrderId: request.clientOrderId,
      exchangeOrderId: request.exchangeOrderId,
      pair: request.pair,
      side: request.side,
      wireOrderType: request.wireOrderType,
      quantity: request.quantity,
      price: request.price,
      settlementRateInrPerQuote: request.settlementRateInrPerQuote,
      marginCurrencyShortName: request.marginCurrencyShortName,
    });
    return observation === null
      ? { kind: 'AMBIGUOUS', reasonCode: 'LIVE_ORDER_IDENTITY_MISMATCH' }
      : { kind: 'FOUND', observation };
  }

  #classifyMutationFailure(wire: Awaited<ReturnType<CoinDcxOrderMutationTransport['execute']>>): LivePlaceOrderResult | null {
    if (wire.kind === 'PRE_DISPATCH') return { kind: 'PRE_DISPATCH_FAILURE', reasonCode: wire.reasonCode };
    if (wire.kind === 'UNESTABLISHED') return { kind: 'AMBIGUOUS', reasonCode: wire.reasonCode };
    if (wire.statusCode < 400) return null;
    if (!LiveErrorResponseSchema.safeParse(wire.data).success) return { kind: 'AMBIGUOUS', reasonCode: 'LIVE_ERROR_RESPONSE_INVALID' };
    return wire.statusCode < 500 && wire.statusCode !== 429
      ? { kind: 'REJECTED', reasonCode: `HTTP_${wire.statusCode}`, observation: null }
      : { kind: 'AMBIGUOUS', reasonCode: `HTTP_${wire.statusCode}` };
  }

  #translate(order: AnyOrderWire, expected: ExpectedOrderIdentity): LiveOrderObservation | null {
    if (expected.exchangeOrderId !== null && order.id !== expected.exchangeOrderId) return null;
    if (order.pair !== expected.pair || order.order_type !== expected.wireOrderType) return null;
    if (order.margin_currency_short_name !== expected.marginCurrencyShortName) return null;
    const side: LiveOrderSide = order.side === 'buy' ? 'BUY' : 'SELL';
    if (side !== expected.side) return null;

    const total = exactNumeric(order.total_quantity);
    const remaining = exactNumeric(order.remaining_quantity);
    const cancelled = exactNumeric(order.cancelled_quantity);
    const price = order.price === null ? null : exactNumeric(order.price);
    const average = exactNumeric(order.avg_price);
    if (total === null || remaining === null || cancelled === null || average === null) return null;
    if (!decimalEquals(total, expected.quantity)) return null;
    if (expected.price !== null && (price === null || !decimalEquals(price, expected.price))) return null;
    if (expected.settlementRateInrPerQuote !== null && order.settlement_currency_conversion_price !== null
        && order.settlement_currency_conversion_price !== undefined) {
      const providerRate = exactNumeric(order.settlement_currency_conversion_price);
      if (providerRate === null || !decimalEquals(providerRate, expected.settlementRateInrPerQuote)) return null;
    }

    const totalD = liveDecimal(total);
    const remainingD = liveDecimal(remaining);
    const cancelledD = liveDecimal(cancelled);
    const averageD = liveDecimal(average);
    if (totalD.isNegative() || remainingD.isNegative() || cancelledD.isNegative() || averageD.isNegative()) return null;
    if (remainingD.plus(cancelledD).greaterThan(totalD)) return null;
    const filledD = totalD.minus(remainingD).minus(cancelledD);
    if (filledD.isNegative() || filledD.greaterThan(totalD)) return null;

    const kind = STATUS_TO_OBSERVATION[order.status];
    if (kind === null || kind === undefined) return null;
    if ((order.status === 'initial' || order.status === 'open') && !filledD.isZero()) return null;
    if (order.status === 'partially_filled' && (!filledD.greaterThan(0) || !filledD.lessThan(totalD))) return null;
    if (order.status === 'filled' && (!filledD.equals(totalD) || !remainingD.isZero() || !cancelledD.isZero())) return null;
    if ((order.status === 'cancelled' || order.status === 'partially_cancelled')
        && (!remainingD.isZero() || !cancelledD.greaterThan(0) || !filledD.lessThan(totalD))) return null;
    if (order.status === 'partially_cancelled' && !filledD.greaterThan(0)) return null;
    if (order.status === 'rejected' && !filledD.isZero()) return null;
    if (filledD.greaterThan(0) && !averageD.greaterThan(0)) return null;

    const providerEventTimeMs = providerTimestampMs(order.updated_at) ?? providerTimestampMs(order.created_at);
    if (providerEventTimeMs === null) return null;
    return Object.freeze({
      kind,
      clientOrderId: expected.localClientOrderId,
      exchangeClientOrderId: null,
      exchangeOrderId: order.id,
      pair: order.pair,
      side,
      cumulativeFilledQuantity: filledD.toFixed(),
      orderedQuantity: totalD.toFixed(),
      averageFillPrice: filledD.isZero() ? null : averageD.toFixed(),
      exchangeStatus: order.status,
      providerEventTimeMs,
    });
  }
}
