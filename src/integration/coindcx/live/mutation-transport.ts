/**
 * The single authenticated CoinDCX order-mutation transport (P17-I18).
 *
 * Deliberately separate from `../transport.ts`, which keeps its frozen Phase2
 * read-only guarantee untouched: this class exists only to reach the three
 * order endpoints in `endpoints.ts`, cannot express any other path, and is
 * reachable only through `CoinDcxLiveFuturesOrderGateway`.
 *
 * DISPATCH CLASSIFICATION (P17-I14) is the reason this transport exists at all.
 * Every failure is placed in exactly one of three buckets:
 *
 *   PRE_DISPATCH   the socket never connected, so the request provably never
 *                  reached CoinDCX and the caller may safely re-claim.
 *   UNESTABLISHED  the connection was live when the failure occurred, so the
 *                  mutation may or may not have been processed. The caller must
 *                  fail closed and must never resend.
 *   RESPONSE       CoinDCX answered with a complete body, whatever its status.
 *
 * CREDENTIALS (P17-I15): the API key and secret live only in this object's
 * private fields and in the outbound header map. No returned value, no thrown
 * error, and no log line here carries a key, a secret, a signature, or the
 * signed payload bytes.
 */
import http from 'node:http';
import https from 'node:https';
import { parse as parseLosslessJson } from 'lossless-json';
import { CoinDcxConfigError } from '../../../core/errors/app-error';
import { createChildLogger } from '../../../monitoring/logger';
import type { RequestSigner } from '../signer';
import { HmacSha256Signer } from '../signer';
import {
  COINDCX_LIVE_BASE_URL,
  COINDCX_LIVE_MAX_RESPONSE_BYTES,
  COINDCX_ORDER_MUTATION_ENDPOINTS,
  type CoinDcxOrderMutationEndpoint,
} from './endpoints';

const logger = createChildLogger('coindcx:live-order-transport');

export type OrderMutationWireResult =
  | { readonly kind: 'RESPONSE'; readonly statusCode: number; readonly data: unknown }
  | { readonly kind: 'PRE_DISPATCH'; readonly reasonCode: string }
  | { readonly kind: 'UNESTABLISHED'; readonly reasonCode: string };

export interface OrderMutationTransportOptions {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly baseUrl?: string | undefined;
  readonly maxResponseBytes?: number | undefined;
}

export class CoinDcxOrderMutationTransport {
  readonly #apiKey: string;
  readonly #signer: RequestSigner;
  readonly #baseUrl: string;
  readonly #maxResponseBytes: number;

  public constructor(options: OrderMutationTransportOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
      throw new CoinDcxConfigError('A CoinDCX API key is required for order mutation');
    }
    if (typeof options.apiSecret !== 'string' || options.apiSecret.trim() === '') {
      throw new CoinDcxConfigError('A CoinDCX API secret is required for order mutation');
    }
    this.#apiKey = options.apiKey;
    this.#signer = new HmacSha256Signer(options.apiSecret);
    this.#baseUrl = options.baseUrl ?? COINDCX_LIVE_BASE_URL;
    this.#maxResponseBytes = options.maxResponseBytes ?? COINDCX_LIVE_MAX_RESPONSE_BYTES;
  }

  /**
   * Executes exactly one closed-union order endpoint. `body` is serialized
   * once and the resulting bytes are both signed and written, so the signature
   * always covers precisely what the wire carries.
   */
  public async execute(
    endpoint: CoinDcxOrderMutationEndpoint,
    body: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<OrderMutationWireResult> {
    const definition = COINDCX_ORDER_MUTATION_ENDPOINTS[endpoint];
    if (definition === undefined) {
      return { kind: 'PRE_DISPATCH', reasonCode: 'UNKNOWN_ENDPOINT' };
    }

    let payload: string;
    try {
      payload = JSON.stringify(body);
    } catch {
      return { kind: 'PRE_DISPATCH', reasonCode: 'UNSERIALIZABLE_REQUEST' };
    }

    const url = new URL(definition.path, this.#baseUrl);
    const requestModule = url.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload, 'utf8')),
      'X-AUTH-APIKEY': this.#apiKey,
      'X-AUTH-SIGNATURE': this.#signer.sign(payload),
    };

    return new Promise<OrderMutationWireResult>((resolve) => {
      let settled = false;
      let connected = false;
      let deadline: NodeJS.Timeout | null = null;

      const settle = (result: OrderMutationWireResult): void => {
        if (settled) return;
        settled = true;
        if (deadline !== null) clearTimeout(deadline);
        // A path is safe to log: it is a fixed constant, never credential-bearing.
        if (result.kind !== 'RESPONSE') {
          logger.error({ endpoint, mutating: definition.mutating, outcome: result.kind, reasonCode: result.reasonCode }, 'CoinDCX order mutation did not complete');
        }
        resolve(result);
        request.destroy();
      };

      /** Before the socket connects nothing can have been transmitted. */
      const unresolvedOutcome = (reasonCode: string): OrderMutationWireResult =>
        (connected ? { kind: 'UNESTABLISHED', reasonCode } : { kind: 'PRE_DISPATCH', reasonCode });

      const request = requestModule.request(url, { method: definition.method, headers }, (response) => {
        const statusCode = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let received = 0;

        response.on('data', (chunk: Buffer) => {
          if (settled) return;
          received += chunk.length;
          if (received > this.#maxResponseBytes) {
            response.destroy();
            settle(unresolvedOutcome('RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', () => settle(unresolvedOutcome('RESPONSE_STREAM_ERROR')));
        response.once('aborted', () => settle(unresolvedOutcome('RESPONSE_ABORTED')));
        response.on('end', () => {
          if (settled) return;
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.trim().length === 0) {
            settle({ kind: 'RESPONSE', statusCode, data: null });
            return;
          }
          try {
            settle({ kind: 'RESPONSE', statusCode, data: parseLosslessJson(raw) });
          } catch {
            // A body we cannot parse is not proof of anything either way.
            settle(unresolvedOutcome('UNPARSEABLE_RESPONSE_BODY'));
          }
        });
      });

      request.on('socket', (socket) => {
        if (socket.connecting === false) {
          connected = true;
          return;
        }
        socket.once('connect', () => { connected = true; });
        socket.once('secureConnect', () => { connected = true; });
      });

      // A transport error carries an OS/Node message that never contains
      // credential material, but it is still not propagated: only the fixed
      // reason code below leaves this function.
      request.on('error', () => settle(unresolvedOutcome('TRANSPORT_ERROR')));

      deadline = setTimeout(() => settle(unresolvedOutcome('TIMEOUT')), Math.max(1, timeoutMs));

      request.write(payload, 'utf8');
      request.end();
    });
  }
}
