/**
 * READ-ONLY CoinDCX provider probe: REST reads.
 *
 * The only way to issue a request is `ProbeReadClient.read(endpoint)`, which
 * resolves the endpoint from the frozen allowlist, passes the exact method
 * and URL through `assertReadOnlyProbeRequest`, and only then calls the
 * executor. Request bodies are fixed templates built here, never supplied by
 * a caller. In production the executor is the Phase 2 read-only
 * `CoinDcxTransport`, whose own endpoint map is closed and contains no
 * mutation route.
 */
import { CoinDcxTransport } from '../../src/integration/coindcx/transport';
import { HmacSha256Signer, type RequestSigner } from '../../src/integration/coindcx/signer';
import {
  PROBE_API_ORIGIN,
  ProbeSafetyError,
  READ_ONLY_PROVIDER_PROBE_ALLOWLIST,
  assertReadOnlyProbeRequest,
  isAllowlistedEndpoint,
  type ProbeReadEndpoint,
} from './allowlist';
import type { SecretRegistry } from './sanitize';

export interface ProbeHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | number | undefined>>;
  readonly data: unknown;
}

export interface ProbeReadExecutor {
  executeRead(request: { readonly endpoint: ProbeReadEndpoint; readonly body: string }): Promise<ProbeHttpResponse>;
}

/** Fixed request bodies, mirroring the Phase 2 client and the Phase 18 evidence adapter. */
const ORDER_OBSERVATION_STATUSES = 'open,filled,partially_filled,partially_cancelled,cancelled,rejected,untriggered';

export type ProbeOrderSide = 'buy' | 'sell';

function requestBody(endpoint: ProbeReadEndpoint, timestamp: number, side: ProbeOrderSide | undefined): string {
  switch (endpoint) {
    case 'USER_INFO':
    case 'FUTURES_WALLETS':
      return JSON.stringify({ timestamp });
    case 'FUTURES_POSITIONS':
      return JSON.stringify({ timestamp, page: '1', size: '10', margin_currency_short_name: ['INR'] });
    case 'FUTURES_ORDERS':
      if (side !== 'buy' && side !== 'sell') throw new ProbeSafetyError('PROBE_ROUTE_NOT_ALLOWLISTED', 'FUTURES_ORDERS requires side buy or sell');
      return JSON.stringify({
        timestamp, status: ORDER_OBSERVATION_STATUSES, side, page: '1', size: '10', margin_currency_short_name: ['INR'],
      });
  }
}

export class ProbeReadClient {
  readonly #executor: ProbeReadExecutor;
  readonly #now: () => number;

  public constructor(executor: ProbeReadExecutor, now: () => number = Date.now) {
    this.#executor = executor;
    this.#now = now;
  }

  public async read(endpoint: ProbeReadEndpoint, side?: ProbeOrderSide): Promise<ProbeHttpResponse> {
    if (!isAllowlistedEndpoint(endpoint)) {
      throw new ProbeSafetyError('PROBE_ROUTE_NOT_ALLOWLISTED', `Unknown probe endpoint refused before network I/O: ${String(endpoint)}`);
    }
    const route = READ_ONLY_PROVIDER_PROBE_ALLOWLIST[endpoint];
    assertReadOnlyProbeRequest(route.method, `${PROBE_API_ORIGIN}${route.path}`);
    return this.#executor.executeRead({ endpoint, body: requestBody(endpoint, this.#now(), side) });
  }
}

/** Delegates to the real signer and force-registers every signature it produces (any length) for redaction and the final sweep. */
export class RecordingSigner implements RequestSigner {
  readonly #inner: RequestSigner;
  readonly #registry: SecretRegistry;

  public constructor(inner: RequestSigner, registry: SecretRegistry) {
    this.#inner = inner;
    this.#registry = registry;
  }

  public sign(payload: string): string {
    const signature = this.#inner.sign(payload);
    this.#registry.addSecret('signature', signature);
    return signature;
  }
}

/** Production executor: the Phase 2 closed read-only transport. */
export function createPhase2ReadExecutor(apiKey: string, apiSecret: string, registry: SecretRegistry): ProbeReadExecutor {
  const transport = new CoinDcxTransport({
    baseUrl: PROBE_API_ORIGIN,
    apiKey,
    signer: new RecordingSigner(new HmacSha256Signer(apiSecret), registry),
  });
  return {
    async executeRead({ endpoint, body }) {
      const response = await transport.executeRead<unknown>({ endpoint, body });
      return { status: response.status, headers: response.headers as ProbeHttpResponse['headers'], data: response.data };
    },
  };
}
