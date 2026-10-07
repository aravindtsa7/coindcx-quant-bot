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
 *
 * SHARED REST BUDGET (M2 W4): every request this transport creates is paced, and is created inside a permit's
 * synchronous start, which reports STARTED at that moment. The budget kind comes from the closed endpoint:
 *   CREATE_ORDER / CANCEL_ORDER  the caller's opaque mutation permit, consumed synchronously before signing (no await
 *                  until the request exists). Missing, forged, a read permit, for the other operation, expired, revoked
 *                  or used: PRE_DISPATCH 'BUDGET_REFUSED', before any request.
 *   LIST_ORDERS    a read permit acquired here, as the W3 read primitives do.
 * The practical cancel consumed its permit at the gateway boundary; it arrives with the invocation. A budget can only
 * delay or refuse; it never supplies or alters response data.
 */
import http from 'node:http';
import https from 'node:https';
import { createHmac } from 'node:crypto';
import { installCancelTransportBrand, registerCancelTransportSource, beginCancelTransportPreparation, markCancelTransmissionPossible, issueCancelTransportNoWrite,
  readCancelTransportRequest, takeCancelTransportBudget, type CancelTransportInvocation, type CancelTransportNoWriteEvidence } from '../../../execution/live/practical-cancel-transport-evidence';
import { parse as parseLosslessJson } from 'lossless-json';
import { CoinDcxConfigError } from '../../../core/errors/app-error';
import { boundProductionTransportBudget, type ReadPermit, type TransportReadBudget } from '../rate-limit/runtime/read-budget';
import { consumeMutationPermit, readConsumedMutationPermit, type MutationOperation } from '../rate-limit/runtime/mutation-budget';
import { createChildLogger } from '../../../monitoring/logger';
import type { RequestSigner } from '../signer';
import { HmacSha256Signer, createOwnedCoinDcxSigner } from '../signer';
import {
  COINDCX_LIVE_BASE_URL,
  COINDCX_LIVE_MAX_RESPONSE_BYTES,
  COINDCX_ORDER_MUTATION_ENDPOINTS,
  type CoinDcxOrderMutationEndpoint,
} from './endpoints';

/** The budget kind of each closed endpoint. Never a caller label. */
const ENDPOINT_BUDGET: Readonly<Record<CoinDcxOrderMutationEndpoint, MutationOperation | 'READ'>> = Object.freeze({
  CREATE_ORDER: 'CREATE', CANCEL_ORDER: 'CANCEL', LIST_ORDERS: 'READ',
});
/** A read permit or a consumed mutation permit: the only way this transport creates a request. */
type WirePermit = Pick<ReadPermit, 'start' | 'complete' | 'throttled'>;

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
  /** M2 W4: the read budget for LIST_ORDERS (non-owned transports). Absent: every LIST_ORDERS is refused. */
  readonly readBudget?: TransportReadBudget | undefined;
}

export class CoinDcxOrderMutationTransport {
  readonly #apiKey: string;
  readonly #signer: RequestSigner;
  readonly #baseUrl: string;
  readonly #maxResponseBytes: number;
  readonly #practicalSecret: string;
  readonly #practicalBaseUrl: unknown;
  readonly #readBudget: TransportReadBudget | null;

  static { installCancelTransportBrand(value => typeof value === 'object' && value !== null && #practicalSecret in value); }

  public constructor(options: OrderMutationTransportOptions, owned?: unknown) {
    const apiKey = options.apiKey;
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new CoinDcxConfigError('A CoinDCX API key is required for order mutation');
    }
    const apiSecret = options.apiSecret;
    if (typeof apiSecret !== 'string' || apiSecret.trim() === '') {
      throw new CoinDcxConfigError('A CoinDCX API secret is required for order mutation');
    }
    this.#apiKey = apiKey;
    this.#signer = owned === OWNED_CONSTRUCTION ? createOwnedCoinDcxSigner(apiSecret) : new HmacSha256Signer(apiSecret);
    const baseUrl = options.baseUrl, maxResponseBytes = options.maxResponseBytes, readBudget = options.readBudget;
    this.#baseUrl = baseUrl ?? COINDCX_LIVE_BASE_URL;
    this.#practicalBaseUrl = baseUrl === undefined ? COINDCX_LIVE_BASE_URL : baseUrl;
    this.#maxResponseBytes = maxResponseBytes ?? COINDCX_LIVE_MAX_RESPONSE_BYTES;
    this.#practicalSecret = apiSecret;
    // Owned construction paces LIST_ORDERS through the set-once production read binding (refused while unbound).
    this.#readBudget = owned === OWNED_CONSTRUCTION ? boundProductionTransportBudget('API_AUTH') : (readBudget ?? null);
    registerCancelTransportSource(this);
  }

  /** Defining-module protected entry to private transport; no public execute lookup. */
  public static executePracticalCancel(transport: unknown, invocation: CancelTransportInvocation, timestamp: unknown): Promise<{ readonly wire: OrderMutationWireResult; readonly evidence: CancelTransportNoWriteEvidence | null }> {
    if (typeof transport !== 'object' || transport === null || !(#practicalSecret in transport)) throw new Error('CANCEL_TRANSPORT_SOURCE_REFUSED');
    return transport.#executePracticalCancel(invocation, timestamp);
  }

  async #executePracticalCancel(invocation: CancelTransportInvocation, timestamp: unknown): Promise<{ readonly wire: OrderMutationWireResult; readonly evidence: CancelTransportNoWriteEvidence | null }> {
    const request = readCancelTransportRequest(invocation);
    // Snapshot and validate actual retained inputs before the proof-producing region.
    // typeof and Number.isSafeInteger never coerce or inspect malformed values.
    const id = request.exchangeOrderId, baseUrl = this.#practicalBaseUrl, apiKey = this.#apiKey, secret = this.#practicalSecret;
    const cancelPath = COINDCX_ORDER_MUTATION_ENDPOINTS.CANCEL_ORDER.path;
    if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0
      || typeof baseUrl !== 'string' || typeof apiKey !== 'string' || typeof secret !== 'string'
      || typeof id !== 'string' || typeof cancelPath !== 'string') throw new Error('CANCEL_LOCAL_INPUT_INVALID');
    beginCancelTransportPreparation(invocation, this);
    let payload: string, url: URL, headers: Record<string, string>, consumed: WirePermit;
    try {
      // M2 W4: the CANCEL permit the boundary consumed before entry. Anything else is a local refusal with no-write proof.
      const taken = readConsumedMutationPermit(takeCancelTransportBudget(invocation, this), 'CANCEL');
      if (taken === null) throw new Error('CANCEL_BUDGET_REFUSED');
      consumed = taken;
      // Plain locally built body, private secret and native HMAC: no preparation callbacks.
      payload = JSON.stringify({ timestamp, id });
      url = new URL(cancelPath, baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('INVALID_LOCAL_PROTOCOL');
      headers = { Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload, 'utf8')),
        'X-AUTH-APIKEY': apiKey, 'X-AUTH-SIGNATURE': createHmac('sha256', secret).update(payload, 'utf8').digest('hex') };
    } catch {
      return { wire: { kind: 'PRE_DISPATCH', reasonCode: 'LOCAL_CANCEL_PREPARATION_FAILED' }, evidence: issueCancelTransportNoWrite(invocation, this) };
    }
    // From before factory invocation onward no failure can issue practical proof.
    try {
      const wire = await this.#executePrepared('CANCEL_ORDER', payload, url, headers, request.timeoutMs, consumed, invocation);
      return { wire, evidence: null };
    } catch { return { wire: { kind: 'UNESTABLISHED', reasonCode: 'CANCEL_INVOCATION_UNCERTAIN' }, evidence: null }; }
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
    budgetPermit?: unknown,
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
    // M2 W4: the permit for this request, by the closed endpoint's budget kind (see the header).
    const kind = ENDPOINT_BUDGET[endpoint];
    let permit: WirePermit;
    if (kind === 'READ') {
      if (budgetPermit !== undefined && budgetPermit !== null) return { kind: 'PRE_DISPATCH', reasonCode: 'BUDGET_REFUSED' }; // never pays for a read
      const read = await this.#acquireReadPermit(timeoutMs);
      if (read === null) return { kind: 'PRE_DISPATCH', reasonCode: 'READ_BUDGET_REFUSED' };
      permit = read;
    } else {
      // Synchronous consumption before signing; from here to request creation nothing awaits.
      const consumption = consumeMutationPermit(budgetPermit, kind);
      if (consumption.kind === 'REFUSED') return { kind: 'PRE_DISPATCH', reasonCode: 'BUDGET_REFUSED' };
      permit = consumption.consumed;
    }
    let headers: Record<string, string>;
    try {
      headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload, 'utf8')),
        'X-AUTH-APIKEY': this.#apiKey,
        'X-AUTH-SIGNATURE': this.#signer.sign(payload),
      };
    } catch (error) {
      // An unused read permit is released (known non-use); a consumed mutation permit stays charged.
      if (kind === 'READ') (permit as ReadPermit).release();
      throw error;
    }

    return this.#executePrepared(endpoint, payload, url, headers, timeoutMs, permit);
  }

  /** A fresh read permit for one LIST_ORDERS request, or null (missing, unbound, unavailable or refusing budget). */
  async #acquireReadPermit(timeoutMs: number): Promise<ReadPermit | null> {
    const binding = this.#readBudget;
    if (binding === null) return null;
    try {
      const acquired = await binding.budget.acquire({ scope: binding.scope, lifetimeMs: Math.max(1, timeoutMs) });
      return acquired.kind === 'GRANTED' ? acquired.permit : null;
    } catch { return null; }
  }

  #executePrepared(endpoint: CoinDcxOrderMutationEndpoint, payload: string, url: URL, headers: Record<string, string>, timeoutMs: number, permit: WirePermit, invocation?: CancelTransportInvocation): Promise<OrderMutationWireResult> {
    const definition = COINDCX_ORDER_MUTATION_ENDPOINTS[endpoint];
    const requestModule = url.protocol === 'https:' ? https : http;
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

      if (invocation !== undefined) markCancelTransmissionPossible(invocation, this);
      const started = permit.start(() => requestModule.request(url, { method: definition.method, headers }, (response) => {
        const statusCode = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let received = 0;
        if (statusCode === 429) {
          // Shared throttle observation (raw headers); the outcome classification below is unchanged.
          try {
            const retryAfter = response.headers['retry-after'], serverDate = response.headers.date;
            permit.throttled({ ...(typeof retryAfter === 'string' ? { retryAfter } : {}), ...(typeof serverDate === 'string' ? { serverDate } : {}) });
          } catch { /* budget reporting only: never affects the outcome */ }
        }

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
      }));
      if (started.kind !== 'STARTED') {
        // A read permit's start check voided it (NOT_STARTED reported): no request was created.
        settled = true;
        resolve({ kind: 'PRE_DISPATCH', reasonCode: 'READ_BUDGET_REFUSED' });
        return;
      }
      const request = started.value;
      request.once('close', () => permit.complete()); // positive local completion/teardown evidence

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

Object.defineProperty(CoinDcxOrderMutationTransport, 'executePracticalCancel', { value: CoinDcxOrderMutationTransport.executePracticalCancel, writable: false, configurable: false });
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  const descriptor = Object.getOwnPropertyDescriptor(module.exports, 'CoinDcxOrderMutationTransport');
  if (descriptor?.configurable === false) {
    if (descriptor.get === undefined || descriptor.set !== undefined || module.exports.CoinDcxOrderMutationTransport !== CoinDcxOrderMutationTransport) throw new Error('CANCEL_TRANSPORT_EXPORT_BINDING_INVALID');
  } else Object.defineProperty(module.exports, 'CoinDcxOrderMutationTransport', { get: () => CoinDcxOrderMutationTransport, configurable: false });
}

// Capture in the defining module, before any consumer or option getter can patch prototypes.
const OWNED_DESCRIPTORS = Object.getOwnPropertyDescriptors(CoinDcxOrderMutationTransport.prototype);
for (const descriptor of Object.values(OWNED_DESCRIPTORS)) {
  for (const value of [descriptor.value, descriptor.get, descriptor.set]) if (typeof value === 'function') Object.freeze(value);
}
function protectOwnedInstance<T extends object>(instance: T): T {
  for (const [key, descriptor] of Object.entries(OWNED_DESCRIPTORS)) {
    if (key === 'constructor') continue;
    if (typeof descriptor.value === 'function') Object.defineProperty(instance, key, { value: Object.freeze(descriptor.value.bind(instance)), writable: false, configurable: false });
    else if (descriptor.get !== undefined) Object.defineProperty(instance, key, { get: Object.freeze(descriptor.get.bind(instance)), configurable: false });
  }
  return Object.freeze(instance);
}
const OWNED_CONSTRUCTION = Object.freeze({});
/** Internal owned construction; callers are pinned, never an injectable authority port. */
export function createOwnedCoinDcxMutationTransport(options: Readonly<{ apiKey: string; apiSecret: string; baseUrl: string }>) : CoinDcxOrderMutationTransport { return protectOwnedInstance(new CoinDcxOrderMutationTransport(options, OWNED_CONSTRUCTION)); }
Object.freeze(createOwnedCoinDcxMutationTransport);
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  const descriptor = Object.getOwnPropertyDescriptor(module.exports, 'createOwnedCoinDcxMutationTransport');
  if (descriptor?.configurable === false) {
    if (descriptor.get === undefined || descriptor.set !== undefined || module.exports.createOwnedCoinDcxMutationTransport !== createOwnedCoinDcxMutationTransport) throw new Error('CREDENTIAL_CONSTRUCTION_EXPORT_INVALID');
  } else Object.defineProperty(module.exports, 'createOwnedCoinDcxMutationTransport', { get: () => createOwnedCoinDcxMutationTransport, configurable: false });
}
