/**
 * The complete, frozen set of CoinDCX order-mutation endpoints Phase17 may
 * reach (P17-I18).
 *
 * This map is module-private by intent: it is exported only so the Phase17
 * architecture test can assert its exact contents, and nothing outside
 * `mutation-transport.ts` consumes it. There is no way to add a path at a call
 * site — `CoinDcxOrderMutationEndpoint` is a closed union and the transport
 * accepts nothing else.
 *
 * ENDPOINT EVIDENCE (see `docs/PHASE17_LIVE_EXECUTION.md` §CoinDCX evidence for
 * the full provenance table, including which lines are documented versus
 * conservatively assumed):
 *
 *   base URL          https://api.coindcx.com  (identical to the already
 *                     production-verified read transport in `../transport.ts`)
 *   create            POST /exchange/v1/derivatives/futures/orders/create
 *   cancel            POST /exchange/v1/derivatives/futures/orders/cancel
 *   observation       POST /exchange/v1/derivatives/futures/orders
 *   auth              X-AUTH-APIKEY + X-AUTH-SIGNATURE, where the signature is
 *                     HMAC-SHA256(secret, exact JSON request bytes) in hex —
 *                     byte-identical to the scheme `../signer.ts` already
 *                     implements and Phase2 verified against the live venue.
 *   body              always includes a fresh millisecond `timestamp`.
 *
 * The create contract documents time_in_force for non-market orders and
 * explicitly marks post_only unsupported. The adapter therefore maps only the
 * documented GTC/FOK/IOC values and refuses post-only independently of policy.
 */

export type CoinDcxOrderMutationEndpoint = 'CREATE_ORDER' | 'CANCEL_ORDER' | 'LIST_ORDERS';

export interface OrderMutationEndpointDefinition {
  readonly method: 'POST';
  readonly path: string;
  /** Whether the call itself changes venue state. Drives ambiguity classification. */
  readonly mutating: boolean;
}

export const COINDCX_ORDER_MUTATION_ENDPOINTS: Readonly<Record<CoinDcxOrderMutationEndpoint, OrderMutationEndpointDefinition>> = Object.freeze({
  CREATE_ORDER: Object.freeze({
    method: 'POST' as const,
    path: '/exchange/v1/derivatives/futures/orders/create',
    mutating: true,
  }),
  CANCEL_ORDER: Object.freeze({
    method: 'POST' as const,
    path: '/exchange/v1/derivatives/futures/orders/cancel',
    mutating: true,
  }),
  LIST_ORDERS: Object.freeze({
    method: 'POST' as const,
    path: '/exchange/v1/derivatives/futures/orders',
    mutating: false,
  }),
});

export const COINDCX_LIVE_BASE_URL = 'https://api.coindcx.com';
export const COINDCX_LIVE_MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
