import http from 'node:http';
import https from 'node:https';
import { parse as parseLosslessJson } from 'lossless-json';
import {
  CoinDcxAuthError,
  CoinDcxProviderError,
  CoinDcxRateLimitError,
  CoinDcxResponseValidationError,
  CoinDcxTimeoutError,
} from '../../core/errors/app-error';
import { createChildLogger } from '../../monitoring/logger';
import { RequestSigner } from './signer';

const logger = createChildLogger('coindcx:transport');

export const DEFAULT_BASE_URL = 'https://api.coindcx.com';
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Fixed semantic read-only endpoint IDs for Phase 2.
 * Higher-level callers select strictly from this closed union.
 */
export type CoinDcxReadEndpoint =
  | 'ACTIVE_INSTRUMENTS'
  | 'INSTRUMENT'
  | 'USER_INFO'
  | 'FUTURES_WALLETS'
  | 'FUTURES_POSITIONS'
  | 'FUTURES_ORDERS'
  | 'POSITION_TRANSACTIONS'
  | 'FUTURES_TRADES'
  | 'WALLET_TRANSACTIONS';

interface ReadEndpointDef {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly auth: boolean;
}

/**
 * Private immutable endpoint map keyed by semantic endpoint IDs.
 * Strictly frozen and NOT exported.
 */
const READ_ENDPOINT_DEFINITIONS: Readonly<Record<CoinDcxReadEndpoint, Readonly<ReadEndpointDef>>> =
  Object.freeze({
    ACTIVE_INSTRUMENTS: Object.freeze({
      method: 'GET',
      path: '/exchange/v1/derivatives/futures/data/active_instruments',
      auth: false,
    }),
    INSTRUMENT: Object.freeze({
      method: 'GET',
      path: '/exchange/v1/derivatives/futures/data/instrument',
      auth: false,
    }),
    USER_INFO: Object.freeze({
      method: 'POST',
      path: '/exchange/v1/users/info',
      auth: true,
    }),
    FUTURES_WALLETS: Object.freeze({
      method: 'GET',
      path: '/exchange/v1/derivatives/futures/wallets',
      auth: true,
    }),
    FUTURES_POSITIONS: Object.freeze({
      method: 'POST',
      path: '/exchange/v1/derivatives/futures/positions',
      auth: true,
    }),
    FUTURES_ORDERS: Object.freeze({
      method: 'POST',
      path: '/exchange/v1/derivatives/futures/orders',
      auth: true,
    }),
    POSITION_TRANSACTIONS: Object.freeze({
      method: 'POST',
      path: '/exchange/v1/derivatives/futures/positions/transactions',
      auth: true,
    }),
    FUTURES_TRADES: Object.freeze({
      method: 'POST',
      path: '/exchange/v1/derivatives/futures/trades',
      auth: true,
    }),
    WALLET_TRANSACTIONS: Object.freeze({
      method: 'GET',
      path: '/exchange/v1/derivatives/futures/wallets/transactions',
      auth: true,
    }),
  });

export interface TransportOptions {
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly signer?: RequestSigner | undefined;
  readonly apiKey?: string | undefined;
}

export interface ExecuteReadOptions {
  readonly endpoint: CoinDcxReadEndpoint;
  readonly queryParams?: Record<string, string | number | boolean | readonly string[]> | undefined;
  readonly body?: string | undefined;
}

export interface HttpResponse<T = unknown> {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly data: T;
  readonly durationMs: number;
}

/**
 * Production read-only CoinDCX HTTP transport.
 *
 * GUARANTEES:
 * 1. Read-Only Boundary: Only fixed Phase 2 read endpoint IDs are reachable.
 *    No public method accepts arbitrary URL paths.
 * 2. Native socket dispatch supports GET with signed body payload.
 * 3. Exact wire payload bytes HMAC-SHA256 signature verification.
 * 4. Lossless JSON parsing preserving numeric precision.
 * 5. Secret redaction and typed error mapping.
 */
export class CoinDcxTransport {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #signer: RequestSigner | undefined;
  readonly #apiKey: string | undefined;

  constructor(options: TransportOptions = {}) {
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#signer = options.signer;
    this.#apiKey = options.apiKey;
  }

  /**
   * Executes a read-only request exclusively using a verified Phase 2 endpoint ID.
   * Arbitrary URL paths are structurally unrepresentable in this API.
   */
  public async executeRead<T = unknown>(options: ExecuteReadOptions): Promise<HttpResponse<T>> {
    const def = READ_ENDPOINT_DEFINITIONS[options.endpoint];
    if (!def) {
      throw new CoinDcxProviderError(
        `Unknown or unsupported read endpoint: ${String(options.endpoint)}`,
        500,
        { endpoint: String(options.endpoint) }
      );
    }

    return this.#executeWireRequest<T>(
      def.method,
      def.path,
      def.auth,
      options.queryParams,
      options.body
    );
  }

  /**
   * ECMAScript-private wire dispatcher.
   * Physically unreachable outside this class instance.
   */
  async #executeWireRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    requiresAuth: boolean,
    queryParams?: Record<string, string | number | boolean | readonly string[]> | undefined,
    body?: string | undefined
  ): Promise<HttpResponse<T>> {
    const startTime = Date.now();
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    let serializedPayload = body;

    if (requiresAuth) {
      if (!this.#apiKey) {
        throw new CoinDcxAuthError(
          'Authentication required: API key is missing',
          401,
          { path }
        );
      }
      if (!this.#signer) {
        throw new CoinDcxAuthError(
          'Authentication required: API secret / request signer is missing',
          401,
          { path }
        );
      }

      if (serializedPayload === undefined) {
        serializedPayload = '{}';
      }

      const signature = this.#signer.sign(serializedPayload);
      headers['X-AUTH-APIKEY'] = this.#apiKey;
      headers['X-AUTH-SIGNATURE'] = signature;
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(serializedPayload, 'utf8'));
    } else if (serializedPayload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(serializedPayload, 'utf8'));
    }

    const fullUrl = new URL(path, this.#baseUrl);
    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            fullUrl.searchParams.append(key, String(item));
          }
        } else {
          fullUrl.searchParams.append(key, String(value));
        }
      }
    }

    const isHttps = fullUrl.protocol === 'https:';
    const requestModule = isHttps ? https : http;

    return new Promise<HttpResponse<T>>((resolve, reject) => {
      let reqTimeout: NodeJS.Timeout | null = null;

      const req = requestModule.request(
        fullUrl,
        {
          method,
          headers,
        },
        (res) => {
          if (reqTimeout) {
            clearTimeout(reqTimeout);
            reqTimeout = null;
          }

          const statusCode = res.statusCode ?? 500;
          const chunks: Buffer[] = [];
          let receivedBytes = 0;

          res.on('data', (chunk: Buffer) => {
            receivedBytes += chunk.length;
            if (receivedBytes > this.#maxResponseBytes) {
              res.destroy();
              reject(
                new CoinDcxProviderError(
                  `CoinDCX response exceeded maximum size limit of ${this.#maxResponseBytes} bytes`,
                  502,
                  { path, receivedBytes, maxBytes: this.#maxResponseBytes }
                )
              );
              return;
            }
            chunks.push(chunk);
          });

          res.on('end', () => {
            const durationMs = Date.now() - startTime;
            const buffer = Buffer.concat(chunks);
            const rawBody = buffer.toString('utf8');

            let parsedData: unknown = null;
            if (rawBody.trim().length > 0) {
              try {
                parsedData = parseLosslessJson(rawBody);
              } catch {
                logger.warn({ path, statusCode }, 'Failed to parse JSON response from CoinDCX');
                reject(
                  new CoinDcxResponseValidationError(
                    'CoinDCX response validation failed: invalid JSON received',
                    { path, statusCode }
                  )
                );
                return;
              }
            }

            if (statusCode === 401 || statusCode === 403) {
              reject(
                new CoinDcxAuthError('CoinDCX authentication request failed', statusCode, {
                  path,
                  statusCode,
                })
              );
              return;
            }

            if (statusCode === 429) {
              const retryAfterHeader = res.headers['retry-after'];
              let retryAfterMs = 60_000;
              if (retryAfterHeader) {
                const parsed = Number(retryAfterHeader);
                if (Number.isFinite(parsed) && parsed > 0) {
                  retryAfterMs = parsed * 1000;
                }
              }
              reject(
                new CoinDcxRateLimitError(
                  'CoinDCX rate limit exceeded',
                  retryAfterMs,
                  { path, statusCode, retryAfterMs }
                )
              );
              return;
            }

            if (statusCode >= 500) {
              reject(
                new CoinDcxProviderError('CoinDCX provider request failed', statusCode, {
                  path,
                  statusCode,
                })
              );
              return;
            }

            if (statusCode >= 400) {
              reject(
                new CoinDcxProviderError('CoinDCX client request error', statusCode, {
                  path,
                  statusCode,
                })
              );
              return;
            }

            resolve({
              status: statusCode,
              headers: res.headers,
              data: parsedData as T,
              durationMs,
            });
          });

          res.on('error', (err) => {
            if (reqTimeout) {
              clearTimeout(reqTimeout);
              reqTimeout = null;
            }
            reject(
              new CoinDcxProviderError(`Socket error while receiving response: ${err.message}`, 502, {
                path,
              })
            );
          });
        }
      );

      reqTimeout = setTimeout(() => {
        req.destroy();
        reject(
          new CoinDcxTimeoutError(
            `CoinDCX request timed out after ${this.#timeoutMs}ms`,
            { path, method, timeoutMs: this.#timeoutMs }
          )
        );
      }, this.#timeoutMs);

      req.on('error', (err) => {
        if (reqTimeout) {
          clearTimeout(reqTimeout);
          reqTimeout = null;
        }
        reject(
          new CoinDcxProviderError(`Network transport error connecting to CoinDCX: ${err.message}`, 502, {
            path,
          })
        );
      });

      if (serializedPayload !== undefined) {
        req.write(serializedPayload, 'utf8');
      }

      req.end();
    });
  }
}
