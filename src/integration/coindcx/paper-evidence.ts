import { isLosslessNumber, parse as parseLosslessJson } from 'lossless-json';
import { sha256CanonicalJson } from '../../backtest/canonical-json';
import { InstrumentMetadata } from '../../coin-runtime/types';
import { PaperExecutionQuoteSnapshot } from '../../execution/evidence';
import { PaperMarkSnapshot } from '../../execution/mark';
import { canonicalPaperDecimalString, PaperCalcDecimal } from '../../execution/decimal';
import { Clock, SystemClock } from './clock';
import { CoinDcxTransport } from './transport';
import { COINDCX_DEFAULT_SOCKET_ENDPOINT, ProductionCoinDcxSocketFactory } from './websocket/socket-adapter';
import { CoinDcxSocket, CoinDcxSocketFactory } from './websocket/types';

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
}

interface MarkState {
  readonly snapshot: PaperMarkSnapshot;
}

interface ConversionState {
  readonly evidence: ConversionEvidence;
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
    this.#policy = validPolicy(options.policy ?? DEFAULT_PAPER_EVIDENCE_POLICY);
    this.#clock = options.clock ?? new SystemClock();
    this.#socketFactory = options.socketFactory ?? new ProductionCoinDcxSocketFactory();
    this.#orderbookRestTransport = options.orderbookRestTransport ?? new CoinDcxTransport({ baseUrl: 'https://public.coindcx.com' });
    this.#markRestTransport = options.markRestTransport ?? new CoinDcxTransport({ baseUrl: 'https://public.coindcx.com' });
    this.#conversionTransport = options.conversionTransport ?? new CoinDcxTransport();
    for (const instrument of options.instruments) {
      if (!/^B-[A-Z0-9]+_[A-Z0-9]+$/.test(instrument.pair) || instrument.instrumentSpecSnapshotId.trim() === '') throw new Error('Invalid P14-B evidence instrument');
      const symbol = providerSymbol(instrument);
      if (this.#symbolToInstrument.has(symbol) || this.#pairToInstrument.has(instrument.pair)) throw new Error('Ambiguous P14-B provider symbol or canonical pair mapping');
      this.#symbolToInstrument.set(symbol, freeze({ ...instrument }));
      this.#pairToInstrument.set(instrument.pair, freeze({ ...instrument }));
    }
    if (this.#symbolToInstrument.size === 0) throw new Error('P14-B evidence requires at least one active instrument');
  }

  public get orderbookGenerationId(): number { return this.#orderbookSocket.generationId; }
  public get markGenerationId(): number { return this.#markSocket.generationId; }
  /** Exact frozen P14-B local-observation SLA consumed by the trusted P14-E adapter. */
  public get conversionLocalPollFreshnessMs(): number { return this.#policy.conversionLocalPollFreshnessMs; }
  public get orderbookSourceSessionId(): string { return this.#sessionId(P14_B_ORDERBOOK_SOURCE_ID, this.#orderbookSocket.generationId); }
  public get markSourceSessionId(): string { return this.#sessionId(P14_B_MARK_SOURCE_ID, this.#markSocket.generationId); }

  public startOrderbookWebSocket(): number {
    return this.#startSocket(this.#orderbookSocket, 'depth-snapshot', (generation, raw) => this.ingestOrderbookWebSocket(raw, generation));
  }

  public startMarkWebSocket(): number {
    return this.#startSocket(this.#markSocket, 'currentPrices@futures#update', (generation, raw) => this.ingestMarkWebSocket(raw, generation));
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

  public ingestOrderbookWebSocket(raw: unknown, generationId = this.#orderbookSocket.generationId, expectedPair?: string): EvidenceIngestResult {
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
    return this.#storeBook(evidence, instrument.instrumentSpecSnapshotId);
  }

  /** REST evidence is retained only as non-actionable bootstrap/recovery evidence. */
  public ingestOrderbookRest(pair: string, raw: unknown): EvidenceIngestResult {
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
    this.#books.set(pair, freeze({ evidence, instrumentSpecSnapshotId: instrument.instrumentSpecSnapshotId }));
    return freeze({ accepted: true, idempotent: false });
  }

  public ingestMarkWebSocket(raw: unknown, generationId = this.#markSocket.generationId): EvidenceIngestResult {
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
        this.#marks.set(instrument.pair, freeze({ snapshot }));
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
    this.#conversion = freeze({ evidence: freeze({ conversionPriceInrPerUsdt: rate, providerEventTimeMs: providerTime, observedAtMs: now, sourceId: P14_B_CONVERSION_SOURCE_ID, contentSha256 }) });
    return freeze({ accepted: true, idempotent: existing?.contentSha256 === contentSha256 });
  }

  public getLatestExecutionQuote(pair: string): EvidenceReadResult<PaperExecutionQuoteSnapshot> {
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
    const snapshot = this.#marks.get(pair)?.snapshot;
    if (!snapshot || snapshot.generationId !== this.#markSocket.generationId) return unavailable('NO_CURRENT_GENERATION_WEBSOCKET_MARK');
    const now = this.#clock.nowMs();
    if (!this.#isFresh(snapshot.providerEventTimeMs, snapshot.observedAtMs, now, this.#policy.markFreshnessMs)) return unavailable('MARK_STALE_OR_CLOCK_FAULT');
    return available(snapshot);
  }

  public getLatestConversion(): EvidenceReadResult<ConversionEvidence> {
    const evidence = this.#conversion?.evidence;
    if (!evidence || !this.#isLocallyFresh(evidence.observedAtMs, this.#clock.nowMs(), this.#policy.conversionLocalPollFreshnessMs)) return unavailable('CONVERSION_LOCAL_POLL_STALE_OR_CLOCK_FAULT');
    return available(evidence);
  }

  public async readOrderbookBootstrap(pair: string): Promise<EvidenceIngestResult> {
    const response = await this.#orderbookRestTransport.executeRead<unknown>({ endpoint: 'FUTURES_ORDERBOOK', pathParams: { pair, depth: P14_B_ORDERBOOK_DEPTH } });
    return this.ingestOrderbookRest(pair, response.data);
  }

  public async readMarkBootstrap(): Promise<EvidenceIngestResult> {
    const response = await this.#markRestTransport.executeRead<unknown>({ endpoint: 'FUTURES_CURRENT_PRICES' });
    return this.ingestMarkRest(response.data);
  }

  public async readConversion(): Promise<EvidenceIngestResult> {
    const response = await this.#conversionTransport.executeRead<unknown>({ endpoint: 'FUTURES_CONVERSIONS' });
    return this.ingestConversionRest(response.data);
  }

  #startSocket(state: SocketState, event: string, handle: (generation: number, raw: unknown) => EvidenceIngestResult): number {
    state.generationId++;
    const generation = state.generationId;
    state.socket?.disconnect();
    const socket = this.#socketFactory.createSocket(COINDCX_DEFAULT_SOCKET_ENDPOINT, { transports: ['websocket'], reconnection: false, autoConnect: false });
    state.socket = socket;
    socket.on('connect', () => {
      if (state.socket !== socket || state.generationId !== generation) return;
      if (event === 'depth-snapshot') for (const instrument of this.#symbolToInstrument.values()) socket.emit('join', { channelName: `${instrument.pair}@orderbook@${P14_B_ORDERBOOK_DEPTH}-futures` });
      else socket.emit('join', { channelName: 'currentPrices@futures@rt' });
    });
    socket.on(event, (raw: unknown) => { if (state.socket === socket && state.generationId === generation) handle(generation, raw); });
    socket.connect();
    return generation;
  }

  #makeBookEvidence(instrument: PaperEvidenceInstrument, parsed: NonNullable<ReturnType<typeof orderbookFromPayload>>, observedAtMs: number, sourceClassification: NormalizedOrderbookEvidence['sourceClassification'], generationId: number): NormalizedOrderbookEvidence {
    const contentSha256 = sha256CanonicalJson({ contentPolicyId: 'P14_B_ORDERBOOK_CONTENT_V1', sourceId: P14_B_ORDERBOOK_SOURCE_ID, pair: instrument.pair, providerEventTimeMs: parsed.ts, providerVersion: parsed.vs, bids: parsed.semanticLevels.bids, asks: parsed.semanticLevels.asks });
    return freeze({ pair: instrument.pair, bestBid: parsed.bid[0], bestBidQuantity: parsed.bid[1], bestAsk: parsed.ask[0], bestAskQuantity: parsed.ask[1], providerTs: parsed.ts, providerVersion: parsed.vs, observedAtMs, sourceSessionId: this.#sessionId(P14_B_ORDERBOOK_SOURCE_ID, generationId), generationId, contentSha256, sourceClassification });
  }

  #storeBook(evidence: NormalizedOrderbookEvidence, instrumentSpecSnapshotId: string): EvidenceIngestResult {
    const old = this.#books.get(evidence.pair)?.evidence;
    if (old && old.generationId === evidence.generationId && old.sourceClassification === 'WEBSOCKET_ACTIONABLE') {
      if (evidence.providerVersion < old.providerVersion) return freeze({ accepted: false, reason: 'OUT_OF_ORDER_ORDERBOOK_VERSION' });
      if (evidence.providerVersion === old.providerVersion) {
        if (evidence.contentSha256 === old.contentSha256) return freeze({ accepted: true, idempotent: true });
        this.#books.delete(evidence.pair);
        return freeze({ accepted: false, reason: 'CONFLICTING_ORDERBOOK_VERSION' });
      }
    }
    this.#books.set(evidence.pair, freeze({ evidence, instrumentSpecSnapshotId }));
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
