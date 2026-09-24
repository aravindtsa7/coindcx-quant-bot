/**
 * READ-ONLY CoinDCX provider probe: the transport allowlist.
 *
 * This is the probe's own, independent safety boundary. It does not rely on
 * callers promising not to mutate. Every REST request the probe can make is
 * resolved from this frozen table and checked by `assertReadOnlyProbeRequest`
 * BEFORE any network I/O; anything else throws. The table is a module
 * constant: nothing (no caller, no environment variable, no CLI flag) can add
 * a route at runtime.
 *
 * Every route below is byte-identical to a route in the Phase 2 read-only
 * transport map (`src/integration/coindcx/transport.ts`), which is the
 * transport the probe dispatches through, and which an existing architecture
 * test keeps free of any order-mutation path. Why each route is read-only:
 *
 *   USER_INFO          POST /exchange/v1/users/info
 *     CoinDCX "Get user info": returns the authenticated account's profile.
 *     Phase 2 verified it against the live venue (`getUserInfoSafe`).
 *   FUTURES_ORDERS     POST /exchange/v1/derivatives/futures/orders
 *     CoinDCX Futures "List orders": a filtered, paginated listing. Phase 17
 *     classifies this exact path `mutating: false` (`live/endpoints.ts`);
 *     create/cancel are the separate `/orders/create` and `/orders/cancel`.
 *   FUTURES_POSITIONS  POST /exchange/v1/derivatives/futures/positions
 *     CoinDCX Futures "List positions": a paginated listing. Exit, margin and
 *     TP/SL operations are separate sub-paths, none of which is listed here.
 *   FUTURES_WALLETS    GET  /exchange/v1/derivatives/futures/wallets
 *     CoinDCX Futures "Wallet details": balances. Transfers are a separate
 *     sub-path, not listed here.
 *
 * Deliberately NOT allowlisted: futures trades (needs pair/date scoping and is
 * not needed for these questions), every mutation route, and anything on
 * `hft-api.coindcx.com` (HFT is research-only in this wave).
 */

export const PROBE_API_ORIGIN = 'https://api.coindcx.com';
export const PROBE_SOCKET_ORIGIN = 'wss://stream.coindcx.com';

export type ProbeReadEndpoint = 'USER_INFO' | 'FUTURES_ORDERS' | 'FUTURES_POSITIONS' | 'FUTURES_WALLETS';

export interface ProbeReadRoute {
  readonly method: 'GET' | 'POST';
  readonly path: string;
}

export const READ_ONLY_PROVIDER_PROBE_ALLOWLIST: Readonly<Record<ProbeReadEndpoint, ProbeReadRoute>> = Object.freeze({
  USER_INFO: Object.freeze({ method: 'POST' as const, path: '/exchange/v1/users/info' }),
  FUTURES_ORDERS: Object.freeze({ method: 'POST' as const, path: '/exchange/v1/derivatives/futures/orders' }),
  FUTURES_POSITIONS: Object.freeze({ method: 'POST' as const, path: '/exchange/v1/derivatives/futures/positions' }),
  FUTURES_WALLETS: Object.freeze({ method: 'GET' as const, path: '/exchange/v1/derivatives/futures/wallets' }),
});

/**
 * Defense in depth: path segments that name a mutation. A route matching this
 * is rejected even if it were somehow present in the allowlist.
 */
const MUTATION_ROUTE_PATTERN = /(^|\/)(create|cancel|cancel_all|cancel_all_orders|edit|exit|close|update|update_leverage|add_margin|remove_margin|margin|leverage|tpsl|create_tpsl|transfer|withdraw|withdrawal|deposit)(\/|_|$)|hft[-_.]api/i;

export class ProbeSafetyError extends Error {
  public readonly code: 'PROBE_MUTATION_ROUTE_REJECTED' | 'PROBE_ROUTE_NOT_ALLOWLISTED' | 'PROBE_SOCKET_OPERATION_REJECTED';

  public constructor(code: ProbeSafetyError['code'], message: string) {
    super(`[${code}] ${message}`);
    this.name = 'ProbeSafetyError';
    this.code = code;
  }
}

export function isAllowlistedEndpoint(value: unknown): value is ProbeReadEndpoint {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(READ_ONLY_PROVIDER_PROBE_ALLOWLIST, value);
}

/**
 * The gate every probe REST request passes before any network I/O: the exact
 * method, origin, and path must be an allowlisted read route, with no query,
 * fragment, or embedded credentials. Throws otherwise.
 */
export function assertReadOnlyProbeRequest(method: string, url: string): ProbeReadEndpoint {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProbeSafetyError('PROBE_ROUTE_NOT_ALLOWLISTED', 'Unparseable probe URL');
  }
  if (MUTATION_ROUTE_PATTERN.test(parsed.pathname)) {
    throw new ProbeSafetyError('PROBE_MUTATION_ROUTE_REJECTED', `Mutation route refused before network I/O: ${method} ${parsed.pathname}`);
  }
  if (parsed.origin !== PROBE_API_ORIGIN || parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') {
    throw new ProbeSafetyError('PROBE_ROUTE_NOT_ALLOWLISTED', `Route outside the read-only probe allowlist: ${method} ${parsed.origin}${parsed.pathname}`);
  }
  for (const [endpoint, route] of Object.entries(READ_ONLY_PROVIDER_PROBE_ALLOWLIST)) {
    if (route.method === method && route.path === parsed.pathname) return endpoint as ProbeReadEndpoint;
  }
  throw new ProbeSafetyError('PROBE_ROUTE_NOT_ALLOWLISTED', `Route outside the read-only probe allowlist: ${method} ${parsed.pathname}`);
}

/** The only private-socket emission the probe may make: the documented `coindcx` channel join. */
export const PROBE_SOCKET_JOIN_EVENT = 'join';
export const PROBE_PRIVATE_CHANNEL = 'coindcx';

export function assertReadOnlySocketEmit(event: string, payload: unknown): void {
  const keys = payload !== null && typeof payload === 'object' ? Object.keys(payload).sort().join(',') : '';
  if (event !== PROBE_SOCKET_JOIN_EVENT || keys !== 'apiKey,authSignature,channelName'
      || (payload as { channelName?: unknown }).channelName !== PROBE_PRIVATE_CHANNEL) {
    throw new ProbeSafetyError('PROBE_SOCKET_OPERATION_REJECTED', `Socket emission outside the read-only probe allowlist: ${event}`);
  }
}
