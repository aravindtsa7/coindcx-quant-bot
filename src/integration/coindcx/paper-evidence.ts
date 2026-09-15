import https from 'node:https';
import ioClient from 'socket.io-client';
import { isLosslessNumber, parse as parseLosslessJson } from 'lossless-json';
import { CoinDcxProviderError, CoinDcxResponseValidationError, CoinDcxTimeoutError } from '../../core/errors/app-error';
import { sha256CanonicalJson } from '../../backtest/canonical-json';
import { InstrumentMetadata } from '../../coin-runtime/types';
import { PaperExecutionQuoteSnapshot } from '../../execution/evidence';
import { PaperMarkSnapshot } from '../../execution/mark';
import { canonicalPaperDecimalString, PaperCalcDecimal } from '../../execution/decimal';
import { type PaperEvidenceAcquisition } from './acquisition-capability';
import { Clock, SystemClock } from './clock';
import { CoinDcxTransport } from './transport';
import { COINDCX_DEFAULT_SOCKET_ENDPOINT, ProductionCoinDcxSocketFactory } from './websocket/socket-adapter';
import { EXACT_CANDLE_SOCKET_PARSER } from './websocket/candle-json';
import { CoinDcxSocket, CoinDcxSocketFactory, CoinDcxSocketOptions, SocketEventListener } from './websocket/types';

/** Frozen source and policy identifiers. They intentionally form part of all identities. */
export const P14_B_ORDERBOOK_SOURCE_ID = 'COINDCX_FUTURES_ORDERBOOK_WS_V1' as const;
export const P14_B_MARK_SOURCE_ID = 'COINDCX_FUTURES_MARK_WS_V1' as const;
export const P14_B_CONVERSION_SOURCE_ID = 'COINDCX_USDTINR_CONVERSION_REST_V1' as const;
export const P14_B_EVIDENCE_POLICY_VERSION = 'P14_B_EVIDENCE_POLICY_V1' as const;
export const P14_B_MARK_POLICY_VERSION = 'P14_B_MARK_POLICY_V1' as const;
export const P14_B_ORDERBOOK_DEPTH = 50 as const;

export interface PaperEvidencePolicy {
  readonly orderbookFreshnessMs: number;
  readonly markFreshnessMs: number;
  readonly conversionLocalPollFreshnessMs: number;
  readonly allowedProviderFutureSkewMs: number;
}

/** Deliberate, visible defaults; production composition may supply stricter configured values. */
export const DEFAULT_PAPER_EVIDENCE_POLICY: Readonly<PaperEvidencePolicy> = Object.freeze({
  orderbookFreshnessMs: 5_000,
  markFreshnessMs: 5_000,
  conversionLocalPollFreshnessMs: 60_000,
  allowedProviderFutureSkewMs: 1_000,
});

export interface PaperEvidenceInstrument {
  readonly pair: string;
  readonly underlying: string;
  readonly quoteCurrency: string;
  readonly instrumentSpecSnapshotId: string;
}

export interface NormalizedOrderbookEvidence {
  readonly pair: string;
  readonly bestBid: string;
  readonly bestBidQuantity: string;
  readonly bestAsk: string;
  readonly bestAskQuantity: string;
  readonly providerTs: number;
  readonly providerVersion: number;
  readonly observedAtMs: number;
  readonly sourceSessionId: string;
  readonly generationId: number;
  readonly contentSha256: string;
  readonly sourceClassification: 'WEBSOCKET_ACTIONABLE' | 'REST_BOOTSTRAP_RECOVERY';
}

export interface ConversionEvidence {
  readonly conversionPriceInrPerUsdt: string;
  readonly providerEventTimeMs: number;
  readonly observedAtMs: number;
  readonly sourceId: typeof P14_B_CONVERSION_SOURCE_ID;
  readonly contentSha256: string;
}

export type EvidenceReadResult<T> =
  | Readonly<{ state: 'AVAILABLE'; snapshot: T }>
  | Readonly<{ state: 'UNAVAILABLE'; reason: string }>;

export type EvidenceIngestResult = Readonly<{ accepted: true; idempotent: boolean }> | Readonly<{ accepted: false; reason: string }>;

interface BookState {
  readonly evidence: NormalizedOrderbookEvidence;
  readonly instrumentSpecSnapshotId: string;
  /** [F14-02] How THIS stored datum was obtained — never a caller-assignable field. */
  readonly acquisition: PaperEvidenceAcquisition;
}

interface MarkState {
  readonly snapshot: PaperMarkSnapshot;
  readonly acquisition: PaperEvidenceAcquisition;
}

interface ConversionState {
  readonly evidence: ConversionEvidence;
  readonly acquisition: PaperEvidenceAcquisition;
}

/**
 * [F14-01] The minimum trusted market evidence Phase13 mark-to-market EQUITY
 * valuation needs: a fresh, current-generation, production-acquired mark for
 * every requested pair plus the production-acquired INR conversion (durable
 * `averageEntryPriceInr` is INR while the provider mark is USDT, so the same
 * `× conversionRate` step P14-E applies to `fillPriceUsdt` is required).
 *
 * Deliberately NOT the executable quote/depth bundle: risk equity valuation
 * does not execute anything, so requiring executable liquidity for it would
 * add a gate the frozen contract does not ask for. This reuses the SAME
 * production-acquisition boundary as execution evidence — not a second trust
 * system.
 */
export interface ProductionAcquiredValuationEvidence {
  readonly marksByPair: ReadonlyMap<string, PaperMarkSnapshot>;
  readonly conversion: ConversionEvidence;
  readonly markGenerationId: number;
  readonly conversionLocalPollFreshnessMs: number;
}

/**
 * [F14-02] The exact inputs the trusted P14-E adapter may mint from, released
 * ONLY when every constituent datum carries production acquisition provenance.
 */
export interface ProductionAcquiredExecutionEvidence {
  readonly quote: PaperExecutionQuoteSnapshot;
  readonly depth: NormalizedOrderbookEvidence;
  readonly conversion: ConversionEvidence;
  readonly conversionLocalPollFreshnessMs: number;
  readonly orderbookGenerationId: number;
}

/**
 * [F14-02] Every provider instance produced by the REAL `CoinDcxPaperEvidence`
 * constructor (`new.target` identity — a subclass instance is deliberately
 * excluded, closing the "subclass a public provider and override its readers"
 * bypass). Module-private: unreachable and unwritable from outside this file.
 */
const GENUINE_PROVIDERS = new WeakSet<object>();

/**
 * [F14-02] THE acquisition capability, expressed as object identity rather
 * than as a token.
 *
 * A provider is in this set iff it was built by
 * `createProductionPaperEvidenceProvider` — the single approved production
 * construction path, which accepts NO injectable acquisition dependency and
 * selects the real socket factory, the real REST transports, and the real
 * system clock itself. Membership is the only thing that lets this module's
 * own internal acquisition callbacks label a datum
 * `PRODUCTION_ACQUISITION`.
 *
 * Deliberately NOT a symbol, string, boolean, or option: there is nothing to
 * export, deep-import, name, copy, serialize, or structurally reproduce. A
 * caller cannot add an entry (the set is module-private and never handed out),
 * and cannot make a provider it constructed itself become a member. This is
 * the same construction Wave3-A uses for `INSTRUMENT_BINDING_ISSUER`, and it
 * is what closes Astra's F14-02 deep-import exploit.
 */
const PRODUCTION_PROVIDERS = new WeakSet<object>();

/* -------------------------------------------------------------------------
 * [F14-02 4A.1] PRIVILEGED PRODUCTION ACQUISITION PRIMITIVES.
 *
 * An independent verifier showed that provider identity alone was not enough.
 * The previous production factory reached the network through
 * `CoinDcxTransport.prototype.executeRead` and
 * `ProductionCoinDcxSocketFactory.prototype.createSocket` — both exported,
 * both writable/configurable. Ordinary application code could deep-import those
 * classes, patch the prototypes, then call the production factory and receive
 * fully trusted execution AND valuation evidence with zero genuine CoinDCX
 * acquisition and no capability of any kind.
 *
 * The production trust boundary therefore now includes acquisition
 * IMPLEMENTATION integrity, not just provenance bookkeeping. Everything below
 * is a module-local binding in THIS file: not exported, not on any barrel, not
 * a property of any exported object, and not reachable through a namespace
 * object under CommonJS interop. A caller cannot replace it, before or after
 * importing this module, because there is no name anywhere to assign to. The
 * production factory closes over these directly and never calls back out
 * through an exported class prototype.
 *
 * Remaining boundary, stated precisely rather than overclaimed: these
 * primitives still stand on Node's own `https` and on the `socket.io-client`
 * package. Replacing a Node builtin or a third-party package export is a
 * strictly broader capability that defeats every module in the process
 * equally, and is outside this repository's module convention — it is not a
 * repo-exported production API. That is exactly the layer the tests intercept
 * (§9), which is why the test seam can no longer double as this exploit.
 * ---------------------------------------------------------------------- */

/** Mirrors transport.ts's frozen READ_ENDPOINT_DEFINITIONS; kept in sync by an architecture test. */
const PRODUCTION_PUBLIC_BASE_URL = 'https://public.coindcx.com';
const PRODUCTION_API_BASE_URL = 'https://api.coindcx.com';
const PRODUCTION_ORDERBOOK_PATH = '/market_data/v3/orderbook/{pair}-futures/{depth}';
const PRODUCTION_CONVERSIONS_PATH = '/api/v1/derivatives/futures/data/conversions';
const PRODUCTION_REQUEST_TIMEOUT_MS = 10_000;
const PRODUCTION_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * The privileged read. Every P14-B production endpoint is an unauthenticated
 * public GET, so this preserves the transport's semantics for them exactly —
 * same paths, same timeout, same response-size cap, same lossless numeric
 * parsing, same typed CoinDCX errors — without routing through a replaceable
 * exported method.
 */
async function privilegedGetJson(url: string): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let receivedBytes = 0;
    const chunks: Buffer[] = [];
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      action();
    };
    const request = https.request(url, { method: 'GET', headers: { Accept: 'application/json' } }, (response) => {
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        receivedBytes += chunk.length;
        if (receivedBytes > PRODUCTION_MAX_RESPONSE_BYTES) {
          settle(() => reject(new CoinDcxProviderError(`CoinDCX response exceeded maximum size limit of ${PRODUCTION_MAX_RESPONSE_BYTES} bytes`, 502, { url })));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', (error: Error) => settle(() => reject(error)));
      response.on('end', () => settle(() => {
        const status = response.statusCode ?? 500;
        if (status < 200 || status >= 300) {
          reject(new CoinDcxProviderError(`CoinDCX production acquisition failed with status ${status}`, status, { url }));
          return;
        }
        const rawBody = Buffer.concat(chunks).toString('utf8');
        if (rawBody.trim().length === 0) { resolve(null); return; }
        try {
          resolve(parseLosslessJson(rawBody, undefined, (token: string) => token));
        } catch {
          reject(new CoinDcxResponseValidationError('CoinDCX production acquisition returned unparseable JSON', { url }));
        }
      }));
    });
    const deadline = setTimeout(() => settle(() => {
      reject(new CoinDcxTimeoutError(`CoinDCX request timed out after ${PRODUCTION_REQUEST_TIMEOUT_MS}ms`, { url }));
      request.destroy();
    }), PRODUCTION_REQUEST_TIMEOUT_MS);
    request.on('error', (error: Error) => settle(() => reject(error)));
    request.end();
  });
}

interface RawProductionSocket {
  connect(): void;
  disconnect(): void;
  on(event: string, fn: (...args: unknown[]) => void): void;
  off(event: string, fn: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  connected?: boolean;
}

/**
 * The privileged socket. Byte-for-byte the same socket.io-client configuration
 * `ProductionCoinDcxSocket` uses (websocket transport only, no library
 * reconnection, no autoConnect, exact-numeric parser, forceNew), constructed
 * here so no exported factory prototype sits on the privileged path.
 */
class PrivilegedProductionSocket implements CoinDcxSocket {
  readonly #raw: RawProductionSocket;

  public constructor(endpoint: string, options: CoinDcxSocketOptions) {
    const connect = ioClient as unknown as (url: string, opts: unknown) => RawProductionSocket;
    this.#raw = connect(endpoint, {
      transports: ['websocket'], reconnection: false, autoConnect: false,
      ...options, parser: EXACT_CANDLE_SOCKET_PARSER, forceNew: true,
    });
  }

  public connect(): void { this.#raw.connect(); }
  public disconnect(): void { this.#raw.disconnect(); }
  public on(event: string, listener: SocketEventListener): void { this.#raw.on(event, listener); }
  public off(event: string, listener: SocketEventListener): void { this.#raw.off(event, listener); }
  public emit(event: string, ...args: unknown[]): void { this.#raw.emit(event, ...args); }
  public get connected(): boolean { return Boolean(this.#raw.connected); }
}

interface SocketState {
  generationId: number;
  socket: CoinDcxSocket | null;
}

type JsonRecord = Record<string, unknown>;

function unavailable<T>(reason: string): EvidenceReadResult<T> {
  return Object.freeze({ state: 'UNAVAILABLE' as const, reason });
}

function available<T>(snapshot: T): EvidenceReadResult<T> {
  return Object.freeze({ state: 'AVAILABLE' as const, snapshot });
}

function freeze<T>(value: T): T { return Object.freeze(value); }

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Numeric tokens are retained as text all the way to Decimal validation. */
function decodePayload(raw: unknown): JsonRecord | null {
  try {
    let outer: unknown = typeof raw === 'string'
      ? parseLosslessJson(raw, undefined, (token: string) => token)
      : raw;
    if (!isRecord(outer)) return null;
    if (typeof outer.data === 'string') {
      const inner = parseLosslessJson(outer.data, undefined, (token: string) => token);
      if (!isRecord(inner)) return null;
      outer = { ...outer, ...inner };
    }
    return isRecord(outer) ? outer : null;
  } catch {
    return null;
  }
}

function losslessNumericText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (isLosslessNumber(value)) return value.value;
  return null;
}

function exactTimestamp(value: unknown): number | null {
  const text = losslessNumericText(value);
  if (text === null) return null;
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function exactVersion(value: unknown): number | null { return exactTimestamp(value); }

function decimal(value: unknown): string | null {
  const text = losslessNumericText(value);
  if (text === null) return null;
  try {
    const canonical = canonicalPaperDecimalString(text);
    const parsed = new PaperCalcDecimal(canonical);
    return parsed.isFinite() && !parsed.isNaN() ? canonical : null;
  } catch { return null; }
}

function positiveDecimal(value: unknown): string | null {
  const parsed = decimal(value);
  return parsed !== null && new PaperCalcDecimal(parsed).greaterThan(0) ? parsed : null;
}

function validPolicy(policy: PaperEvidencePolicy): PaperEvidencePolicy {
  for (const value of Object.values(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('P14-B evidence policy values must be non-negative safe integer milliseconds');
  }
  if (policy.orderbookFreshnessMs === 0 || policy.markFreshnessMs === 0 || policy.conversionLocalPollFreshnessMs === 0) {
    throw new Error('P14-B freshness policies must be strictly positive');
  }
  return freeze({ ...policy });
}

function providerSymbol(instrument: Pick<PaperEvidenceInstrument, 'underlying' | 'quoteCurrency'>): string {
  const base = instrument.underlying.trim().toUpperCase();
  const quote = instrument.quoteCurrency.trim().toUpperCase();
  if (!/^[A-Z0-9]+$/.test(base) || !/^[A-Z0-9]+$/.test(quote)) throw new Error('Invalid instrument metadata for provider symbol mapping');
  return `${base}${quote}`;
}

/** Explicit metadata-derived provider mapping; duplicate symbols are a construction-time fail-closed error. */
export function createPaperEvidenceInstruments(instruments: readonly InstrumentMetadata[]): readonly PaperEvidenceInstrument[] {
  return Object.freeze(instruments.map((instrument) => freeze({
    pair: instrument.pair,
    underlying: instrument.underlying,
    quoteCurrency: instrument.quoteCurrency,
    instrumentSpecSnapshotId: sha256CanonicalJson({
      identityPolicyId: 'P14_B_INSTRUMENT_SPEC_SNAPSHOT_V1',
      pair: instrument.pair,
      underlying: instrument.underlying,
      quoteCurrency: instrument.quoteCurrency,
      marginCurrency: instrument.marginCurrency,
      priceIncrement: instrument.priceIncrement.toString(),
      quantityIncrement: instrument.quantityIncrement.toString(),
    }),
  })));
}

function readLevels(raw: unknown): readonly (readonly [string, string])[] | null {
  const levels: Array<readonly [string, string]> = [];
  if (Array.isArray(raw)) {
    for (const level of raw) {
      if (!Array.isArray(level) || level.length < 2) return null;
      const price = positiveDecimal(level[0]);
      const quantity = positiveDecimal(level[1]);
      if (price === null || quantity === null) return null;
      levels.push(freeze([price, quantity]));
    }
  } else if (isRecord(raw)) {
    for (const [priceText, quantityValue] of Object.entries(raw)) {
      const price = positiveDecimal(priceText);
      const quantity = positiveDecimal(quantityValue);
      if (price === null || quantity === null) return null;
      levels.push(freeze([price, quantity]));
    }
  } else return null;
  return levels.length > 0 ? Object.freeze(levels) : null;
}

function orderbookFromPayload(payload: JsonRecord, expectedProviderSymbol: string | undefined): {
  readonly providerSymbol: string; readonly ts: number; readonly vs: number;
  readonly bid: readonly [string, string]; readonly ask: readonly [string, string];
  readonly semanticLevels: Readonly<{ bids: readonly (readonly [string, string])[]; asks: readonly (readonly [string, string])[] }>;
} | null {
  if (payload.pr !== 'futures' || payload.type !== 'depth-snapshot') return null;
  const symbol = typeof payload.s === 'string' && /^[A-Z0-9]+$/.test(payload.s) ? payload.s : null;
  const ts = exactTimestamp(payload.ts);
  const vs = exactVersion(payload.vs);
  const bids = readLevels(payload.bids);
  const asks = readLevels(payload.asks);
  if (symbol === null || ts === null || vs === null || bids === null || asks === null) return null;
  if (expectedProviderSymbol !== undefined && symbol !== expectedProviderSymbol) return null;
  const bestBid = bids.reduce((best, item) => new PaperCalcDecimal(item[0]).greaterThan(best[0]) ? item : best);
  const bestAsk = asks.reduce((best, item) => new PaperCalcDecimal(item[0]).lessThan(best[0]) ? item : best);
  if (new PaperCalcDecimal(bestBid[0]).greaterThanOrEqualTo(bestAsk[0])) return null;
  return freeze({ providerSymbol: symbol, ts, vs, bid: bestBid, ask: bestAsk, semanticLevels: freeze({ bids, asks }) });
}

/**
 * [F14-02] Options for the PUBLIC, deliberately UNTRUSTED provider.
 *
 * Every acquisition seam here is freely injectable — and that is now safe,
 * because a provider built through this constructor is NEVER a member of
 * `PRODUCTION_PROVIDERS`. No option, argument, flag, or capability can make
 * it one, so nothing it ever holds can be minted into production-usable
 * trusted evidence. There is intentionally no `acquisitionCapability` option:
 * the concept has been removed from the public surface, not merely hidden.
 */
export interface CoinDcxPaperEvidenceOptions {
  readonly instruments: readonly PaperEvidenceInstrument[];
  readonly policy?: PaperEvidencePolicy;
  readonly clock?: Clock;
  readonly socketFactory?: CoinDcxSocketFactory;
  readonly orderbookRestTransport?: CoinDcxTransport;
  readonly markRestTransport?: CoinDcxTransport;
  readonly conversionTransport?: CoinDcxTransport;
}

/**
 * [F14-02 §4] Every caller-controlled option, read EXACTLY ONCE at the
 * boundary and materialized into a frozen module-local record.
 *
 * Astra's TOCTOU exploit supplied getters that returned `undefined` on the
 * read that made the trust decision and an attacker-controlled socket factory
 * / REST transport on the later read that actually built the provider. No
 * property of the caller's object is ever read twice now, so no getter, Proxy
 * trap, or accessor can present two different values; `instruments` is
 * copied, so a live array cannot mutate after validation either.
 */
interface CapturedEvidenceOptions {
  readonly instruments: readonly PaperEvidenceInstrument[];
  readonly policy: PaperEvidencePolicy | undefined;
  readonly clock: Clock | undefined;
  readonly socketFactory: CoinDcxSocketFactory | undefined;
  readonly orderbookRestTransport: CoinDcxTransport | undefined;
  readonly markRestTransport: CoinDcxTransport | undefined;
  readonly conversionTransport: CoinDcxTransport | undefined;
}

function captureOptions(options: CoinDcxPaperEvidenceOptions): CapturedEvidenceOptions {
  const instruments = options.instruments;
  if (!Array.isArray(instruments)) throw new Error('P14-B evidence requires an instruments array');
  return freeze({
    instruments: Object.freeze(Array.from(instruments as readonly PaperEvidenceInstrument[], (instrument) => freeze({ ...instrument }))),
    policy: options.policy,
    clock: options.clock,
    socketFactory: options.socketFactory,
    orderbookRestTransport: options.orderbookRestTransport,
    markRestTransport: options.markRestTransport,
    conversionTransport: options.conversionTransport,
  });
}

/**
 * Read-oriented evidence collector. Network collection is independent of later
 * economic code: its only downstream surface is immutable, already-observed data.
 */
export class CoinDcxPaperEvidence {
  readonly #policy: PaperEvidencePolicy;
  readonly #clock: Clock;
  readonly #symbolToInstrument = new Map<string, PaperEvidenceInstrument>();
  readonly #pairToInstrument = new Map<string, PaperEvidenceInstrument>();
  readonly #socketFactory: CoinDcxSocketFactory;
  readonly #orderbookRestTransport: CoinDcxTransport;
  readonly #markRestTransport: CoinDcxTransport;
  readonly #conversionTransport: CoinDcxTransport;
  readonly #orderbookSocket: SocketState = { generationId: 0, socket: null };
  readonly #markSocket: SocketState = { generationId: 0, socket: null };
  readonly #books = new Map<string, BookState>();
  readonly #marks = new Map<string, MarkState>();
  #conversion: ConversionState | null = null;
  public constructor(options: CoinDcxPaperEvidenceOptions) {
    // [F14-02 §4] Single-read capture. Everything below consumes ONLY these
    // captured values; the caller's object is never touched again, so the
    // "undefined during the security decision, fake socket during use" getter
    // TOCTOU has no second read to exploit.
    const captured = captureOptions(options);
    this.#policy = validPolicy(captured.policy ?? DEFAULT_PAPER_EVIDENCE_POLICY);
    this.#clock = captured.clock ?? new SystemClock();
    this.#socketFactory = captured.socketFactory ?? new ProductionCoinDcxSocketFactory();
    this.#orderbookRestTransport = captured.orderbookRestTransport ?? new CoinDcxTransport({ baseUrl: 'https://public.coindcx.com' });
    this.#markRestTransport = captured.markRestTransport ?? new CoinDcxTransport({ baseUrl: 'https://public.coindcx.com' });
    this.#conversionTransport = captured.conversionTransport ?? new CoinDcxTransport();
    for (const instrument of captured.instruments) {
      if (!/^B-[A-Z0-9]+_[A-Z0-9]+$/.test(instrument.pair) || instrument.instrumentSpecSnapshotId.trim() === '') throw new Error('Invalid P14-B evidence instrument');
      const symbol = providerSymbol(instrument);
      if (this.#symbolToInstrument.has(symbol) || this.#pairToInstrument.has(instrument.pair)) throw new Error('Ambiguous P14-B provider symbol or canonical pair mapping');
      this.#symbolToInstrument.set(symbol, instrument);
      this.#pairToInstrument.set(instrument.pair, instrument);
    }
    if (this.#symbolToInstrument.size === 0) throw new Error('P14-B evidence requires at least one active instrument');
    // [F14-02] Only a DIRECT construction of this exact class is registered —
    // `class Evil extends CoinDcxPaperEvidence` runs this constructor too, but
    // its `new.target` differs, so it is never a genuine provider.
    //
    // Note what this constructor deliberately does NOT do: it never adds the
    // instance to `PRODUCTION_PROVIDERS`. Public construction cannot produce a
    // production-trusted provider under ANY option combination.
    if (new.target === CoinDcxPaperEvidence) GENUINE_PROVIDERS.add(this);
  }

  /**
   * [F14-02] The single provenance decision, with exactly two inputs, neither
   * of them caller-controlled:
   *
   *  - `internal` is set only where the PRIVILEGED, module-private acquisition
   *    implementation actually ran — the privileged socket in `#startSocket`
   *    and `privilegedGetJson` in the provider's own `read*` methods. Public
   *    `ingest*` entry points hard-code `false` and take no parameter that
   *    could change it, and the exported-transport/socket-factory branches
   *    pass `false` too, so a patched exported prototype yields caller-supplied
   *    data even on a production-registered provider.
   *  - `PRODUCTION_PROVIDERS.has(this)` is object identity in a module-private
   *    `WeakSet` that only `createProductionPaperEvidenceProvider` writes.
   *
   * There is no third input, and in particular no capability argument: the
   * former `acquisitionCapability` parameter is gone from every signature.
   */
  #acquisition(internal: boolean): PaperEvidenceAcquisition {
    return internal && PRODUCTION_PROVIDERS.has(this) ? 'PRODUCTION_ACQUISITION' : 'CALLER_SUPPLIED';
  }

  public get orderbookGenerationId(): number { return this.#orderbookSocket.generationId; }
  public get markGenerationId(): number { return this.#markSocket.generationId; }
  /** Exact frozen P14-B local-observation SLA consumed by the trusted P14-E adapter. */
  public get conversionLocalPollFreshnessMs(): number { return this.#policy.conversionLocalPollFreshnessMs; }
  public get orderbookSourceSessionId(): string { return this.#sessionId(P14_B_ORDERBOOK_SOURCE_ID, this.#orderbookSocket.generationId); }
  public get markSourceSessionId(): string { return this.#sessionId(P14_B_MARK_SOURCE_ID, this.#markSocket.generationId); }

  public startOrderbookWebSocket(): number {
    // [F14-02] The approved CoinDCX Futures WS acquisition path. It dispatches
    // to the PRIVATE `#ingestOrderbookWebSocket` with `internal = true`: a
    // public `ingest*` call can never reach this branch, and an own-property
    // shadow installed on the instance cannot intercept a `#` method either.
    return this.#startSocket(this.#orderbookSocket, 'depth-snapshot', (generation, raw, privileged) => this.#ingestOrderbookWebSocket(raw, generation, undefined, privileged));
  }

  public startMarkWebSocket(): number {
    return this.#startSocket(this.#markSocket, 'currentPrices@futures#update', (generation, raw, privileged) => this.#ingestMarkWebSocket(raw, generation, privileged));
  }

  /** Explicit reconnect operation; no autonomous hidden source switching occurs. */
  public reconnectOrderbookWebSocket(): number { return this.startOrderbookWebSocket(); }
  public reconnectMarkWebSocket(): number { return this.startMarkWebSocket(); }

  public stop(): void {
    this.#orderbookSocket.socket?.disconnect();
    this.#markSocket.socket?.disconnect();
    this.#orderbookSocket.socket = null;
    this.#markSocket.socket = null;
  }

  /**
   * [F14-02] Remains publicly callable for parsing/validation and for tests —
   * but it now takes NO capability argument and hard-codes `internal = false`,
   * so whatever it accepts is stored as `CALLER_SUPPLIED` unconditionally, on
   * every provider, forever. There is no argument, option, or second call that
   * can upgrade it. Parsing/generation/ordering/freshness semantics are
   * unchanged. The same is true of `ingestOrderbookRest`,
   * `ingestMarkWebSocket`, `ingestMarkRest` and `ingestConversionRest`.
   */
  public ingestOrderbookWebSocket(raw: unknown, generationId = this.#orderbookSocket.generationId, expectedPair?: string): EvidenceIngestResult {
    return this.#ingestOrderbookWebSocket(raw, generationId, expectedPair, false);
  }

  #ingestOrderbookWebSocket(raw: unknown, generationId: number, expectedPair: string | undefined, internal: boolean): EvidenceIngestResult {
    if (generationId !== this.#orderbookSocket.generationId || generationId === 0) return freeze({ accepted: false, reason: 'OLD_GENERATION' });
    const payload = decodePayload(raw);
    if (payload !== null && payload.event !== undefined && payload.event !== 'depth-snapshot') return freeze({ accepted: false, reason: 'INVALID_ORDERBOOK_EVENT_TYPE' });
    if (payload !== null && typeof payload.channel === 'string') {
      const matched = /^B-([A-Z0-9]+)_([A-Z0-9]+)@orderbook@50-futures$/.exec(payload.channel);
      if (matched === null || payload.s !== `${matched[1]}${matched[2]}`) return freeze({ accepted: false, reason: 'SUBSCRIPTION_PAYLOAD_MISMATCH' });
    }
    const expectedSymbol = expectedPair === undefined ? undefined : providerSymbol(this.#pairToInstrument.get(expectedPair) ?? this.#invalidPair(expectedPair));
    const parsed = payload === null ? null : orderbookFromPayload(payload, expectedSymbol);
    if (parsed === null) return freeze({ accepted: false, reason: 'INVALID_ORDERBOOK_PAYLOAD' });
    const instrument = this.#symbolToInstrument.get(parsed.providerSymbol);
    if (instrument === undefined) return freeze({ accepted: false, reason: 'UNKNOWN_PROVIDER_SYMBOL' });
    const now = this.#clock.nowMs();
    if (!this.#validEventTime(parsed.ts, now)) return freeze({ accepted: false, reason: 'INVALID_EVENT_TIME' });
    const evidence = this.#makeBookEvidence(instrument, parsed, now, 'WEBSOCKET_ACTIONABLE', generationId);
    return this.#storeBook(evidence, instrument.instrumentSpecSnapshotId, this.#acquisition(internal));
  }

  /** REST evidence is retained only as non-actionable bootstrap/recovery evidence. */
  public ingestOrderbookRest(pair: string, raw: unknown): EvidenceIngestResult {
    return this.#ingestOrderbookRest(pair, raw, false);
  }

  #ingestOrderbookRest(pair: string, raw: unknown, internal: boolean): EvidenceIngestResult {
    const instrument = this.#pairToInstrument.get(pair);
    if (instrument === undefined) return freeze({ accepted: false, reason: 'UNKNOWN_CANONICAL_PAIR' });
    const payload = decodePayload(raw);
    const parsed = payload === null ? null : orderbookFromPayload(payload, providerSymbol(instrument));
    if (parsed === null) return freeze({ accepted: false, reason: 'INVALID_ORDERBOOK_REST_PAYLOAD' });
    const now = this.#clock.nowMs();
    if (!this.#validEventTime(parsed.ts, now)) return freeze({ accepted: false, reason: 'INVALID_EVENT_TIME' });
    const evidence = this.#makeBookEvidence(instrument, parsed, now, 'REST_BOOTSTRAP_RECOVERY', this.#orderbookSocket.generationId);
    // A REST response cannot overwrite valid WS execution evidence in the same generation.
    const existing = this.#books.get(pair);
    if (existing?.evidence.sourceClassification === 'WEBSOCKET_ACTIONABLE' && existing.evidence.generationId === this.#orderbookSocket.generationId) return freeze({ accepted: true, idempotent: true });
    this.#books.set(pair, freeze({ evidence, instrumentSpecSnapshotId: instrument.instrumentSpecSnapshotId, acquisition: this.#acquisition(internal) }));
    return freeze({ accepted: true, idempotent: false });
  }

  public ingestMarkWebSocket(raw: unknown, generationId = this.#markSocket.generationId): EvidenceIngestResult {
    return this.#ingestMarkWebSocket(raw, generationId, false);
  }

  #ingestMarkWebSocket(raw: unknown, generationId: number, internal: boolean): EvidenceIngestResult {
    if (generationId !== this.#markSocket.generationId || generationId === 0) return freeze({ accepted: false, reason: 'OLD_GENERATION' });
    const payload = decodePayload(raw);
    if (payload === null) return freeze({ accepted: false, reason: 'INVALID_MARK_PAYLOAD' });
    const now = this.#clock.nowMs();
    const topTs = payload.ts === undefined ? null : exactTimestamp(payload.ts);
    const topVs = payload.vs === undefined ? null : exactVersion(payload.vs);
    if ((payload.ts !== undefined && topTs === null) || (payload.vs !== undefined && topVs === null)) return freeze({ accepted: false, reason: 'INVALID_MARK_ENVELOPE' });
    let accepted = false;
    let idempotent = true;
    for (const [symbol, entry] of Object.entries(payload)) {
      const instrument = this.#symbolToInstrument.get(symbol);
      if (instrument === undefined || !isRecord(entry)) continue;
      // Ticker-only entries deliberately do nothing: no timestamp or freshness refresh.
      if (entry.mp === undefined && entry.bmST === undefined) continue;
      const price = positiveDecimal(entry.mp);
      const providerTime = exactTimestamp(entry.bmST);
      if (price === null || providerTime === null || !this.#validEventTime(providerTime, now)) continue;
      const eventId = sha256CanonicalJson({ sourceId: P14_B_MARK_SOURCE_ID, pair: instrument.pair, providerEventTimeMs: providerTime, topLevelTs: topTs, topLevelVs: topVs, generationId });
      const contentSha256 = sha256CanonicalJson({ contentPolicyId: 'P14_B_MARK_CONTENT_V1', sourceId: P14_B_MARK_SOURCE_ID, pair: instrument.pair, markPrice: price, providerEventTimeMs: providerTime, topLevelTs: topTs, topLevelVs: topVs });
      const snapshot = freeze<PaperMarkSnapshot>({ pair: instrument.pair, markPrice: price, sourceId: P14_B_MARK_SOURCE_ID, providerEventId: eventId, providerEventTimeMs: providerTime, observedAtMs: now, freshnessState: 'FRESH', sourceSessionId: this.#sessionId(P14_B_MARK_SOURCE_ID, generationId), generationId, contentSha256, markPolicyVersion: P14_B_MARK_POLICY_VERSION });
      const old = this.#marks.get(instrument.pair)?.snapshot;
      if (old && old.generationId === generationId && old.providerEventTimeMs === providerTime) {
        if (old.contentSha256 !== contentSha256) { this.#marks.delete(instrument.pair); return freeze({ accepted: false, reason: 'CONFLICTING_MARK_EVENT' }); }
      } else if (old && old.generationId === generationId && providerTime < old.providerEventTimeMs) {
        return freeze({ accepted: false, reason: 'OUT_OF_ORDER_MARK_EVENT' });
      } else {
        this.#marks.set(instrument.pair, freeze({ snapshot, acquisition: this.#acquisition(internal) }));
        idempotent = false;
      }
      accepted = true;
    }
    return accepted ? freeze({ accepted: true, idempotent }) : freeze({ accepted: false, reason: 'NO_VALID_MP_BEARING_MARK' });
  }

  public ingestMarkRest(raw: unknown): EvidenceIngestResult {
    // Parse/validate only. REST cannot satisfy the current-generation WS mark gate and is not exposed as a PaperMarkSnapshot.
    const payload = decodePayload(raw);
    if (payload === null) return freeze({ accepted: false, reason: 'INVALID_MARK_REST_PAYLOAD' });
    let valid = false;
    for (const [symbol, entry] of Object.entries(payload)) {
      if (!this.#symbolToInstrument.has(symbol) || !isRecord(entry)) continue;
      if (positiveDecimal(entry.mp) !== null && exactTimestamp(entry.bmST) !== null) valid = true;
    }
    return valid ? freeze({ accepted: true, idempotent: true }) : freeze({ accepted: false, reason: 'NO_VALID_REST_MARK' });
  }

  public ingestConversionRest(raw: unknown): EvidenceIngestResult {
    return this.#ingestConversionRest(raw, false);
  }

  #ingestConversionRest(raw: unknown, internal: boolean): EvidenceIngestResult {
    const body = typeof raw === 'string' ? decodeJson(raw) : raw;
    if (!Array.isArray(body)) return freeze({ accepted: false, reason: 'INVALID_CONVERSION_RESPONSE' });
    const matches = body.filter((entry): entry is JsonRecord => isRecord(entry) && entry.symbol === 'USDTINR' && entry.margin_currency_short_name === 'INR' && entry.target_currency_short_name === 'USDT');
    if (matches.length !== 1) return freeze({ accepted: false, reason: 'CONVERSION_RECORD_NOT_UNIQUE' });
    const match = matches[0]!;
    const rate = positiveDecimal(match.conversion_price);
    const providerTime = exactTimestamp(match.last_updated_at);
    if (rate === null || providerTime === null) return freeze({ accepted: false, reason: 'INVALID_CONVERSION_RECORD' });
    const now = this.#clock.nowMs();
    if (!Number.isSafeInteger(now) || now < 0) return freeze({ accepted: false, reason: 'INVALID_LOCAL_CLOCK' });
    const contentSha256 = sha256CanonicalJson({ contentPolicyId: 'P14_B_CONVERSION_CONTENT_V1', sourceId: P14_B_CONVERSION_SOURCE_ID, conversionPriceInrPerUsdt: rate, providerEventTimeMs: providerTime });
    const existing = this.#conversion?.evidence;
    if (existing && providerTime < existing.providerEventTimeMs) { this.#conversion = null; return freeze({ accepted: false, reason: 'CONVERSION_TIMESTAMP_REGRESSION' }); }
    if (existing && providerTime === existing.providerEventTimeMs && existing.contentSha256 !== contentSha256) { this.#conversion = null; return freeze({ accepted: false, reason: 'CONFLICTING_CONVERSION_EVENT' }); }
    this.#conversion = freeze({
      evidence: freeze({ conversionPriceInrPerUsdt: rate, providerEventTimeMs: providerTime, observedAtMs: now, sourceId: P14_B_CONVERSION_SOURCE_ID, contentSha256 }),
      acquisition: this.#acquisition(internal),
    });
    return freeze({ accepted: true, idempotent: existing?.contentSha256 === contentSha256 });
  }

  public getLatestExecutionQuote(pair: string): EvidenceReadResult<PaperExecutionQuoteSnapshot> {
    return this.#latestExecutionQuote(pair);
  }

  /** [F14-02] Private twin of `getLatestExecutionQuote` — the production reader below calls THIS, so no own-property shadow of the public getter can substitute a quote for it. */
  #latestExecutionQuote(pair: string): EvidenceReadResult<PaperExecutionQuoteSnapshot> {
    const state = this.#books.get(pair);
    if (!state || state.evidence.sourceClassification !== 'WEBSOCKET_ACTIONABLE' || state.evidence.generationId !== this.#orderbookSocket.generationId) return unavailable('NO_CURRENT_GENERATION_WEBSOCKET_ORDERBOOK');
    const now = this.#clock.nowMs();
    if (!this.#isFresh(state.evidence.providerTs, state.evidence.observedAtMs, now, this.#policy.orderbookFreshnessMs)) return unavailable('ORDERBOOK_STALE_OR_CLOCK_FAULT');
    return available(freeze({ pair, instrumentSpecSnapshotId: state.instrumentSpecSnapshotId, bid: state.evidence.bestBid, ask: state.evidence.bestAsk, availableExecutableQuantity: null, providerEventId: sha256CanonicalJson({ sourceId: P14_B_ORDERBOOK_SOURCE_ID, pair, providerEventTimeMs: state.evidence.providerTs, providerVersion: state.evidence.providerVersion, generationId: state.evidence.generationId }), providerEventTimeMs: state.evidence.providerTs, firstObservedAtMs: state.evidence.observedAtMs, sourceSessionId: state.evidence.sourceSessionId, generationId: state.evidence.generationId, healthState: 'HEALTHY' as const, contentSha256: state.evidence.contentSha256, evidencePolicyVersion: P14_B_EVIDENCE_POLICY_VERSION }));
  }

  public getLatestOrderbookEvidence(pair: string): EvidenceReadResult<NormalizedOrderbookEvidence> {
    const state = this.#books.get(pair);
    return state === undefined ? unavailable('NO_ORDERBOOK_EVIDENCE') : available(state.evidence);
  }

  public getLatestMark(pair: string): EvidenceReadResult<PaperMarkSnapshot> {
    return this.#latestMark(pair);
  }

  /** [F14-02] Private twin of `getLatestMark` — see `#latestExecutionQuote`. */
  #latestMark(pair: string): EvidenceReadResult<PaperMarkSnapshot> {
    const snapshot = this.#marks.get(pair)?.snapshot;
    if (!snapshot || snapshot.generationId !== this.#markSocket.generationId) return unavailable('NO_CURRENT_GENERATION_WEBSOCKET_MARK');
    const now = this.#clock.nowMs();
    if (!this.#isFresh(snapshot.providerEventTimeMs, snapshot.observedAtMs, now, this.#policy.markFreshnessMs)) return unavailable('MARK_STALE_OR_CLOCK_FAULT');
    return available(snapshot);
  }

  public getLatestConversion(): EvidenceReadResult<ConversionEvidence> {
    return this.#latestConversion();
  }

  /** [F14-02] Private twin of `getLatestConversion` — see `#latestExecutionQuote`. */
  #latestConversion(): EvidenceReadResult<ConversionEvidence> {
    const evidence = this.#conversion?.evidence;
    if (!evidence || !this.#isLocallyFresh(evidence.observedAtMs, this.#clock.nowMs(), this.#policy.conversionLocalPollFreshnessMs)) return unavailable('CONVERSION_LOCAL_POLL_STALE_OR_CLOCK_FAULT');
    return available(evidence);
  }

  public async readOrderbookBootstrap(pair: string): Promise<EvidenceIngestResult> {
    if (PRODUCTION_PROVIDERS.has(this)) {
      const path = PRODUCTION_ORDERBOOK_PATH.replace('{pair}', encodeURIComponent(pair)).replace('{depth}', String(P14_B_ORDERBOOK_DEPTH));
      return this.#ingestOrderbookRest(pair, await privilegedGetJson(`${PRODUCTION_PUBLIC_BASE_URL}${path}`), true);
    }
    const response = await this.#orderbookRestTransport.executeRead<unknown>({ endpoint: 'FUTURES_ORDERBOOK', pathParams: { pair, depth: P14_B_ORDERBOOK_DEPTH } });
    return this.#ingestOrderbookRest(pair, response.data, false);
  }

  public async readMarkBootstrap(): Promise<EvidenceIngestResult> {
    const response = await this.#markRestTransport.executeRead<unknown>({ endpoint: 'FUTURES_CURRENT_PRICES' });
    return this.ingestMarkRest(response.data);
  }

  /** [F14-02] The approved CoinDCX conversion acquisition path — the only conversion caller that supplies the acquisition capability. */
  public async readConversion(): Promise<EvidenceIngestResult> {
    // [F14-02 4A.1] Privileged providers read through the module-private GET;
    // patching `CoinDcxTransport.prototype.executeRead` cannot reach this path.
    // Every other provider keeps the exported transport AND is marked
    // caller-supplied, so a patched transport is not merely ineffective — its
    // output can never be production provenance in the first place.
    if (PRODUCTION_PROVIDERS.has(this)) {
      return this.#ingestConversionRest(await privilegedGetJson(`${PRODUCTION_API_BASE_URL}${PRODUCTION_CONVERSIONS_PATH}`), true);
    }
    const response = await this.#conversionTransport.executeRead<unknown>({ endpoint: 'FUTURES_CONVERSIONS' });
    return this.#ingestConversionRest(response.data, false);
  }

  /**
   * [F14-02] The ONLY read surface the production trusted-evidence issuer may
   * mint from. Reuses the exact existing P14-B gates (current-generation
   * WS-actionable orderbook, quote/depth agreement, conversion local-poll
   * freshness, clock-fault rejection) and then additionally requires that
   * every constituent datum carry production acquisition provenance. Reading
   * is capability-free on purpose: a caller learns nothing it did not already
   * have, because fabricated data can never be tagged `PRODUCTION_ACQUISITION`
   * in the first place.
   */
  /**
   * [F14-01] Production mark-to-market valuation evidence for `pairs`. Applies
   * every existing frozen P14-B mark gate (current mark-WS generation, mark
   * freshness, clock-regression) and the frozen conversion local-poll gate,
   * and then additionally requires production acquisition provenance on the
   * conversion AND on every requested pair's mark. All-or-nothing: one
   * unvaluable pair makes the whole read unavailable, so a caller can never
   * silently value part of an account. No candle/LTP/entry-price fallback
   * exists anywhere on this path.
   */
  public readProductionAcquiredValuationEvidence(pairs: readonly string[]): EvidenceReadResult<ProductionAcquiredValuationEvidence> {
    const conversionState = this.#conversion;
    const conversionResult = this.#latestConversion();
    if (conversionResult.state !== 'AVAILABLE') return unavailable(conversionResult.reason);
    if (conversionState === null || conversionState.acquisition !== 'PRODUCTION_ACQUISITION') return unavailable('EVIDENCE_NOT_PRODUCTION_ACQUIRED');
    const marksByPair = new Map<string, PaperMarkSnapshot>();
    for (const pair of pairs) {
      const markResult = this.#latestMark(pair);
      if (markResult.state !== 'AVAILABLE') return unavailable(`${markResult.reason}:${pair}`);
      if (this.#marks.get(pair)?.acquisition !== 'PRODUCTION_ACQUISITION') return unavailable(`EVIDENCE_NOT_PRODUCTION_ACQUIRED:${pair}`);
      marksByPair.set(pair, markResult.snapshot);
    }
    return available(freeze({
      marksByPair, conversion: conversionResult.snapshot,
      markGenerationId: this.#markSocket.generationId, conversionLocalPollFreshnessMs: this.#policy.conversionLocalPollFreshnessMs,
    }));
  }

  public readProductionAcquiredExecutionEvidence(pair: string): EvidenceReadResult<ProductionAcquiredExecutionEvidence> {
    const quoteResult = this.#latestExecutionQuote(pair);
    if (quoteResult.state !== 'AVAILABLE') return unavailable(quoteResult.reason);
    const book = this.#books.get(pair);
    const conversionState = this.#conversion;
    const conversionResult = this.#latestConversion();
    if (conversionResult.state !== 'AVAILABLE') return unavailable(conversionResult.reason);
    if (book === undefined || conversionState === null) return unavailable('NO_ORDERBOOK_EVIDENCE');
    if (book.acquisition !== 'PRODUCTION_ACQUISITION' || conversionState.acquisition !== 'PRODUCTION_ACQUISITION') {
      return unavailable('EVIDENCE_NOT_PRODUCTION_ACQUIRED');
    }
    return available(freeze({
      quote: quoteResult.snapshot, depth: book.evidence, conversion: conversionResult.snapshot,
      conversionLocalPollFreshnessMs: this.#policy.conversionLocalPollFreshnessMs, orderbookGenerationId: this.#orderbookSocket.generationId,
    }));
  }

  #startSocket(state: SocketState, event: string, handle: (generation: number, raw: unknown, privileged: boolean) => EvidenceIngestResult): number {
    state.generationId++;
    const generation = state.generationId;
    state.socket?.disconnect();
    // [F14-02 4A.1] A production-registered provider NEVER touches the exported
    // socket factory. It constructs the module-private privileged socket
    // directly, so patching `ProductionCoinDcxSocketFactory.prototype` cannot
    // put fabricated frames on the privileged path. `privileged` records which
    // implementation actually ran and is the only thing that can later mark a
    // datum PRODUCTION_ACQUISITION.
    const privileged = PRODUCTION_PROVIDERS.has(this);
    const socketOptions: CoinDcxSocketOptions = { transports: ['websocket'], reconnection: false, autoConnect: false };
    const socket = privileged
      ? new PrivilegedProductionSocket(COINDCX_DEFAULT_SOCKET_ENDPOINT, socketOptions)
      : this.#socketFactory.createSocket(COINDCX_DEFAULT_SOCKET_ENDPOINT, socketOptions);
    state.socket = socket;
    socket.on('connect', () => {
      if (state.socket !== socket || state.generationId !== generation) return;
      if (event === 'depth-snapshot') for (const instrument of this.#symbolToInstrument.values()) socket.emit('join', { channelName: `${instrument.pair}@orderbook@${P14_B_ORDERBOOK_DEPTH}-futures` });
      else socket.emit('join', { channelName: 'currentPrices@futures@rt' });
    });
    socket.on(event, (raw: unknown) => { if (state.socket === socket && state.generationId === generation) handle(generation, raw, privileged); });
    socket.connect();
    return generation;
  }

  #makeBookEvidence(instrument: PaperEvidenceInstrument, parsed: NonNullable<ReturnType<typeof orderbookFromPayload>>, observedAtMs: number, sourceClassification: NormalizedOrderbookEvidence['sourceClassification'], generationId: number): NormalizedOrderbookEvidence {
    const contentSha256 = sha256CanonicalJson({ contentPolicyId: 'P14_B_ORDERBOOK_CONTENT_V1', sourceId: P14_B_ORDERBOOK_SOURCE_ID, pair: instrument.pair, providerEventTimeMs: parsed.ts, providerVersion: parsed.vs, bids: parsed.semanticLevels.bids, asks: parsed.semanticLevels.asks });
    return freeze({ pair: instrument.pair, bestBid: parsed.bid[0], bestBidQuantity: parsed.bid[1], bestAsk: parsed.ask[0], bestAskQuantity: parsed.ask[1], providerTs: parsed.ts, providerVersion: parsed.vs, observedAtMs, sourceSessionId: this.#sessionId(P14_B_ORDERBOOK_SOURCE_ID, generationId), generationId, contentSha256, sourceClassification });
  }

  #storeBook(evidence: NormalizedOrderbookEvidence, instrumentSpecSnapshotId: string, acquisition: PaperEvidenceAcquisition): EvidenceIngestResult {
    const old = this.#books.get(evidence.pair)?.evidence;
    if (old && old.generationId === evidence.generationId && old.sourceClassification === 'WEBSOCKET_ACTIONABLE') {
      if (evidence.providerVersion < old.providerVersion) return freeze({ accepted: false, reason: 'OUT_OF_ORDER_ORDERBOOK_VERSION' });
      if (evidence.providerVersion === old.providerVersion) {
        if (evidence.contentSha256 === old.contentSha256) return freeze({ accepted: true, idempotent: true });
        this.#books.delete(evidence.pair);
        return freeze({ accepted: false, reason: 'CONFLICTING_ORDERBOOK_VERSION' });
      }
    }
    this.#books.set(evidence.pair, freeze({ evidence, instrumentSpecSnapshotId, acquisition }));
    return freeze({ accepted: true, idempotent: false });
  }

  #validEventTime(providerTimeMs: number, observedAtMs: number): boolean {
    return Number.isSafeInteger(observedAtMs) && observedAtMs >= 0 && providerTimeMs <= observedAtMs + this.#policy.allowedProviderFutureSkewMs;
  }
  #isFresh(providerTimeMs: number, observedAtMs: number, nowMs: number, maxAgeMs: number): boolean {
    if (!Number.isSafeInteger(observedAtMs) || nowMs < observedAtMs) return false;
    if (!this.#validEventTime(providerTimeMs, nowMs)) return false;
    const age = nowMs - providerTimeMs;
    return age >= 0 && age <= maxAgeMs;
  }
  #isLocallyFresh(observedAtMs: number, nowMs: number, maxAgeMs: number): boolean {
    return Number.isSafeInteger(nowMs) && nowMs >= observedAtMs && nowMs - observedAtMs <= maxAgeMs;
  }
  #sessionId(sourceId: string, generationId: number): string { return `${sourceId}:SESSION:${generationId}`; }
  #invalidPair(pair: string): never { throw new Error(`Unknown canonical pair ${pair}`); }
}

function decodeJson(text: string): unknown {
  try { return parseLosslessJson(text, undefined, (token: string) => token); } catch { return null; }
}

/**
 * [F14-02 §5] Options for the approved PRODUCTION acquisition path.
 *
 * Deliberately a different, much smaller type than
 * `CoinDcxPaperEvidenceOptions`: there is no `clock`, no `socketFactory`, no
 * `orderbookRestTransport`, no `markRestTransport` and no `conversionTransport`
 * member, so a production caller has no injectable acquisition dependency to
 * supply — not a socket, transport, HTTP client, callback, reader, provider, or
 * Proxy wrapper. `instruments` and `policy` are the only caller inputs, both
 * already validated by the existing construction-time checks, and neither is an
 * acquisition seam.
 */
export interface ProductionPaperEvidenceOptions {
  readonly instruments: readonly PaperEvidenceInstrument[];
  readonly policy?: PaperEvidencePolicy;
}

/**
 * [F14-02 §5] The SOLE production mint for market-evidence acquisition
 * authority — the P14-B counterpart of Wave3-A's
 * `acquireProductionInstrumentBinding`.
 *
 * It selects the real `ProductionCoinDcxSocketFactory`, the real
 * `CoinDcxTransport`s and the real `SystemClock` itself, then registers the
 * resulting instance in the module-private `PRODUCTION_PROVIDERS` set. Trust
 * therefore originates from THIS construction path, never from "some option
 * happened to be `undefined`" — the inference Astra's getter TOCTOU abused.
 *
 * Zero-network testing of this genuine path does not go through any production
 * API: tests intercept `CoinDcxTransport.prototype.executeRead` and
 * `ProductionCoinDcxSocketFactory.prototype.createSocket` with the test
 * runner's own mocking, exactly as Wave3-A's accepted instrument-authority
 * tests already do. That seam is a property of the test runner, not an export,
 * so it hands normal callers no trust-minting authority.
 *
 * [F14-02 §16] This mints market-evidence acquisition trust ONLY. It cannot
 * produce a `TrustedProductionInstrumentBinding`, and instrument authority
 * cannot produce a production provider; the two capabilities stay disjoint.
 */
export function createProductionPaperEvidenceProvider(options: ProductionPaperEvidenceOptions): CoinDcxPaperEvidence {
  // Single-read capture of the caller's two non-acquisition inputs, then
  // construction from values this function controls. The inner options object
  // is built here, so no getter/Proxy of the caller's can be re-consulted.
  const instruments = Object.freeze(Array.from(options.instruments, (instrument) => freeze({ ...instrument })));
  const policy = options.policy;
  const provider = new CoinDcxPaperEvidence(policy === undefined ? { instruments } : { instruments, policy: freeze({ ...policy }) });
  PRODUCTION_PROVIDERS.add(provider);
  return provider;
}

/**
 * [F14-02] The single provenance-checked entry point the trusted P14-E adapter
 * uses. Three independent, non-caller-controllable proofs must hold:
 *
 *  1. GENUINE PROVIDER IDENTITY — `provider` is an instance of the real class
 *     AND was registered by the real constructor's own `new.target` identity
 *     check: a structural look-alike, an
 *     `Object.create(CoinDcxPaperEvidence.prototype)` forgery, a Proxy, and a
 *     `class X extends CoinDcxPaperEvidence` instance all fail.
 *  2. GENUINE PRODUCTION ACQUISITION PROVENANCE — `provider` is a member of
 *     the module-private `PRODUCTION_PROVIDERS` set, i.e. it was built by
 *     `createProductionPaperEvidenceProvider`, which exposes no injectable
 *     socket factory, REST transport, HTTP client, reader, callback or clock.
 *     [F14-02 §6] `instanceof`/`new.target` alone is explicitly NOT treated as
 *     acquisition provenance; this is the separate, independent proof.
 *  3. PER-DATUM PRODUCTION PROVENANCE — inside the reader, every constituent
 *     datum must itself carry `PRODUCTION_ACQUISITION`, which only this
 *     module's own internal acquisition callbacks assign.
 *
 * The reader is additionally invoked as the PROTOTYPE method, never as
 * `provider.read…`, so an own-property shadow installed on a provider instance
 * cannot substitute its own result.
 */
export function readProductionAcquiredPaperExecutionEvidence(provider: unknown, pair: string): EvidenceReadResult<ProductionAcquiredExecutionEvidence> {
  if (!(provider instanceof CoinDcxPaperEvidence) || !GENUINE_PROVIDERS.has(provider)) return unavailable('UNTRUSTED_EVIDENCE_PROVIDER');
  if (!PRODUCTION_PROVIDERS.has(provider)) return unavailable('PROVIDER_NOT_PRODUCTION_ACQUIRED');
  return CoinDcxPaperEvidence.prototype.readProductionAcquiredExecutionEvidence.call(provider, pair);
}

/**
 * [F14-01] The valuation counterpart of the guard above, with the three
 * identical, non-caller-controllable proofs (genuine registered instance,
 * PROTOTYPE reader, production acquisition provenance on every datum). This is
 * the ONLY route by which Phase13 mark-to-market equity may obtain a mark.
 */
export function readProductionAcquiredPaperValuationEvidence(provider: unknown, pairs: readonly string[]): EvidenceReadResult<ProductionAcquiredValuationEvidence> {
  if (!(provider instanceof CoinDcxPaperEvidence) || !GENUINE_PROVIDERS.has(provider)) return unavailable('UNTRUSTED_EVIDENCE_PROVIDER');
  if (!PRODUCTION_PROVIDERS.has(provider)) return unavailable('PROVIDER_NOT_PRODUCTION_ACQUIRED');
  return CoinDcxPaperEvidence.prototype.readProductionAcquiredValuationEvidence.call(provider, pairs);
}
