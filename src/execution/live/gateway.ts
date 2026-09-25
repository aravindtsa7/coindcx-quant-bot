/**
 * The Phase17 order-mutation PORT (P17-I17/I18).
 *
 * This is the only shape through which live execution may touch an exchange.
 * It is deliberately narrow — three operations, all order-scoped — and it
 * exposes no HTTP verb, URL, header, credential, or generic request primitive,
 * so execution code physically cannot use it to reach any other venue surface.
 *
 * The CoinDCX adapter that implements it lives at
 * `src/integration/coindcx/live/order-gateway.ts` and is imported by exactly
 * one file in the repository: `src/execution/live/composer.ts`. Everything else
 * — the service, the state machine, the repository — depends on this interface
 * only, which is what makes the architecture boundary statically provable.
 *
 * Every result variant is explicit about what is known. There is no "failed"
 * catch-all: a create-order call whose outcome cannot be established returns
 * `AMBIGUOUS`, never a failure the caller could safely retry (P17-I14).
 */
import type { LiveOrderObservation, LiveOrderSide, LiveTimeInForce } from './types';

export interface LivePlaceOrderRequest {
  /**
   * The intent's persisted deterministic id, sent to CoinDCX as
   * `client_order_id` (mandatory, at most 36 characters). The adapter refuses
   * to dispatch anything that is not exactly this frozen format.
   */
  readonly clientOrderId: string;
  readonly pair: string;
  readonly side: LiveOrderSide;
  /** The instrument's own declared order-type lexeme. Never an invented enum. */
  readonly wireOrderType: string;
  /** Exact fixed-point Decimal string, already quantized and constraint-checked. */
  readonly quantity: string;
  readonly price: string | null;
  readonly leverage: string | null;
  readonly settlementRateInrPerQuote: string | null;
  readonly timeInForce: LiveTimeInForce;
  readonly timeoutMs: number;
}

export type LivePlaceOrderResult =
  /** CoinDCX returned a validated order acknowledgement. Acknowledgement is not fill. */
  | { readonly kind: 'ACCEPTED'; readonly observation: LiveOrderObservation }
  /** CoinDCX explicitly refused the order. Terminal and never retried. */
  | { readonly kind: 'REJECTED'; readonly reasonCode: string; readonly observation: LiveOrderObservation | null }
  /**
   * The mutation may or may not have reached CoinDCX: timeout, broken
   * connection, unparseable body, or an unmapped server result. The caller must
   * fail closed and must not resend.
   */
  | { readonly kind: 'AMBIGUOUS'; readonly reasonCode: string }
  /**
   * CoinDCX positively identified this create as a DUPLICATE of an earlier
   * create carrying the same `client_order_id` (matched against the exact,
   * provider-confirmed error signal the adapter pins; never guessed from a
   * message). This is evidence the id was accepted before, and nothing more:
   * it is not a success, not a rejection, and it carries no venue order
   * identity. The caller fails closed exactly as for `AMBIGUOUS`, and only a
   * read-side proof (exactly one venue order carrying this exact id) may later
   * resolve it. Until the exact provider code is confirmed, no response is
   * ever classified this way.
   */
  | { readonly kind: 'DUPLICATE_CLIENT_ORDER_ID'; readonly reasonCode: string }
  /** Provably nothing was sent (request rejected locally before any socket write). */
  | { readonly kind: 'PRE_DISPATCH_FAILURE'; readonly reasonCode: string };

export interface LiveCancelOrderRequest {
  readonly clientOrderId: string;
  /** The authoritative exchange order id. Cancel always binds exact identity (P17-I13). */
  readonly exchangeOrderId: string;
  readonly pair: string;
  readonly timeoutMs: number;
}

export type LiveCancelOrderResult =
  /**
   * CoinDCX accepted the cancellation. `observation` carries the venue's own
   * post-cancel view when it supplies one — it is NOT evidence that nothing
   * filled.
   */
  | { readonly kind: 'CANCEL_ACCEPTED'; readonly observation: LiveOrderObservation | null }
  | { readonly kind: 'REJECTED'; readonly reasonCode: string }
  | { readonly kind: 'AMBIGUOUS'; readonly reasonCode: string }
  | { readonly kind: 'PRE_DISPATCH_FAILURE'; readonly reasonCode: string };

export interface LiveFetchOrderRequest {
  readonly clientOrderId: string;
  readonly exchangeOrderId: string;
  readonly pair: string;
  readonly side: LiveOrderSide;
  readonly wireOrderType: string;
  readonly quantity: string;
  readonly price: string | null;
  readonly settlementRateInrPerQuote: string | null;
  readonly marginCurrencyShortName: 'INR';
  readonly timeoutMs: number;
}

export type LiveFetchOrderResult =
  | { readonly kind: 'FOUND'; readonly observation: LiveOrderObservation }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'AMBIGUOUS'; readonly reasonCode: string };

/**
 * The single production order-mutation boundary. Implementations must:
 *   - validate every response against a schema before returning it (P17-I16);
 *   - never fabricate an exchange order id (P17-I14);
 *   - never include credential material in any returned value or thrown error
 *     (P17-I15);
 *   - map an unestablished outcome to `AMBIGUOUS`, never to success or failure.
 */
export interface CoinDcxFuturesOrderGateway {
  placeOrder(request: LivePlaceOrderRequest): Promise<LivePlaceOrderResult>;
  cancelOrder(request: LiveCancelOrderRequest): Promise<LiveCancelOrderResult>;
  fetchOrder(request: LiveFetchOrderRequest): Promise<LiveFetchOrderResult>;
}
