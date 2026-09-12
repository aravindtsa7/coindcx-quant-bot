import { canonicalPaperDecimalString, paperDecimal } from './decimal';
import type { PaperExecutionQuoteSnapshot } from './evidence';

export interface TrustedPaperOrderbookDepth {
  readonly pair: string;
  readonly bestBid: string;
  readonly bestBidQuantity: string;
  readonly bestAsk: string;
  readonly bestAskQuantity: string;
  readonly providerEventTimeMs: number;
  readonly observedAtMs: number;
  readonly sourceSessionId: string;
  readonly generationId: number;
  readonly contentSha256: string;
}

export interface TrustedPaperConversionEvidence {
  readonly conversionPriceInrPerUsdt: string;
  readonly providerEventTimeMs: number;
  readonly observedAtMs: number;
  readonly sourceId: string;
  readonly contentSha256: string;
}

interface TrustedPaperExecutionEvidenceRecord {
  readonly quote: PaperExecutionQuoteSnapshot;
  readonly orderbookDepth: TrustedPaperOrderbookDepth;
  readonly conversion: TrustedPaperConversionEvidence;
  readonly conversionLocalPollFreshnessMs: number;
}

/**
 * Opaque type carried by the public execution API. Runtime authority comes
 * from the module-private WeakMap below, not from this TypeScript shape.
 */
export interface TrustedPaperExecutionEvidence {
  readonly __trustedPaperExecutionEvidence: never;
}

const registry = new WeakMap<object, TrustedPaperExecutionEvidenceRecord>();

function copyQuote(quote: PaperExecutionQuoteSnapshot): PaperExecutionQuoteSnapshot {
  const bid = positiveDecimal(quote.bid, 'quote.bid');
  const ask = positiveDecimal(quote.ask, 'quote.ask');
  if (!paperDecimal(bid).lessThan(paperDecimal(ask))) throw new Error('quote bid must be below ask');
  if (quote.availableExecutableQuantity !== null) throw new Error('execution quote quantity must remain side-neutral');
  if (quote.healthState !== 'HEALTHY') throw new Error('execution quote must be HEALTHY before issuance');
  return Object.freeze({
    pair: nonEmpty(quote.pair, 'quote.pair'),
    instrumentSpecSnapshotId: nonEmpty(quote.instrumentSpecSnapshotId, 'quote.instrumentSpecSnapshotId'),
    bid,
    ask,
    availableExecutableQuantity: null,
    providerEventId: nonEmpty(quote.providerEventId, 'quote.providerEventId'),
    providerEventTimeMs: safeTimestamp(quote.providerEventTimeMs, 'quote.providerEventTimeMs'),
    firstObservedAtMs: safeTimestamp(quote.firstObservedAtMs, 'quote.firstObservedAtMs'),
    sourceSessionId: nonEmpty(quote.sourceSessionId, 'quote.sourceSessionId'),
    generationId: safeTimestamp(quote.generationId, 'quote.generationId'),
    healthState: 'HEALTHY',
    contentSha256: nonEmpty(quote.contentSha256, 'quote.contentSha256'),
    evidencePolicyVersion: nonEmpty(quote.evidencePolicyVersion, 'quote.evidencePolicyVersion'),
  });
}

function positiveDecimal(value: string, label: string): string {
  const canonical = canonicalPaperDecimalString(value, label);
  if (!paperDecimal(canonical).greaterThan(0)) throw new Error(`${label} must be strictly positive`);
  return canonical;
}

function nonEmpty(value: string, label: string): string {
  if (value.trim() === '') throw new Error(`${label} must be non-empty`);
  return value;
}

function safeTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

/**
 * Internal issuance seam used by the CoinDCX adapter and focused tests. It is
 * deliberately absent from every public barrel. The returned object has no
 * public data surface and cannot be reproduced with a structural object or a
 * copied/foreign Symbol.
 */
export function issueTrustedPaperExecutionEvidence(input: TrustedPaperExecutionEvidenceRecord): TrustedPaperExecutionEvidence {
  const quote = copyQuote(input.quote);
  const orderbookDepth = Object.freeze({
    pair: nonEmpty(input.orderbookDepth.pair, 'orderbookDepth.pair'),
    bestBid: positiveDecimal(input.orderbookDepth.bestBid, 'orderbookDepth.bestBid'),
    bestBidQuantity: positiveDecimal(input.orderbookDepth.bestBidQuantity, 'orderbookDepth.bestBidQuantity'),
    bestAsk: positiveDecimal(input.orderbookDepth.bestAsk, 'orderbookDepth.bestAsk'),
    bestAskQuantity: positiveDecimal(input.orderbookDepth.bestAskQuantity, 'orderbookDepth.bestAskQuantity'),
    providerEventTimeMs: safeTimestamp(input.orderbookDepth.providerEventTimeMs, 'orderbookDepth.providerEventTimeMs'),
    observedAtMs: safeTimestamp(input.orderbookDepth.observedAtMs, 'orderbookDepth.observedAtMs'),
    sourceSessionId: nonEmpty(input.orderbookDepth.sourceSessionId, 'orderbookDepth.sourceSessionId'),
    generationId: safeTimestamp(input.orderbookDepth.generationId, 'orderbookDepth.generationId'),
    contentSha256: nonEmpty(input.orderbookDepth.contentSha256, 'orderbookDepth.contentSha256'),
  });
  const conversion = Object.freeze({
    conversionPriceInrPerUsdt: positiveDecimal(input.conversion.conversionPriceInrPerUsdt, 'conversion.conversionPriceInrPerUsdt'),
    providerEventTimeMs: safeTimestamp(input.conversion.providerEventTimeMs, 'conversion.providerEventTimeMs'),
    observedAtMs: safeTimestamp(input.conversion.observedAtMs, 'conversion.observedAtMs'),
    sourceId: nonEmpty(input.conversion.sourceId, 'conversion.sourceId'),
    contentSha256: nonEmpty(input.conversion.contentSha256, 'conversion.contentSha256'),
  });
  const conversionLocalPollFreshnessMs = safeTimestamp(input.conversionLocalPollFreshnessMs, 'conversionLocalPollFreshnessMs');
  if (conversionLocalPollFreshnessMs === 0) throw new Error('conversionLocalPollFreshnessMs must be strictly positive');

  if (quote.pair !== orderbookDepth.pair) throw new Error('Trusted quote/depth pair mismatch');
  if (quote.bid !== orderbookDepth.bestBid || quote.ask !== orderbookDepth.bestAsk) throw new Error('Trusted quote/depth best-price mismatch');
  if (quote.providerEventTimeMs !== orderbookDepth.providerEventTimeMs || quote.firstObservedAtMs !== orderbookDepth.observedAtMs) {
    throw new Error('Trusted quote/depth observation mismatch');
  }
  if (quote.sourceSessionId !== orderbookDepth.sourceSessionId || quote.generationId !== orderbookDepth.generationId) {
    throw new Error('Trusted quote/depth generation mismatch');
  }
  if (quote.contentSha256 !== orderbookDepth.contentSha256) throw new Error('Trusted quote/depth content mismatch');

  const record = Object.freeze({ quote, orderbookDepth, conversion, conversionLocalPollFreshnessMs });
  const capability = Object.freeze(Object.create(null)) as TrustedPaperExecutionEvidence;
  registry.set(capability as object, record);
  return capability;
}

/** @internal Runtime authenticity check for the execution engine. */
export function readTrustedPaperExecutionEvidence(value: unknown): TrustedPaperExecutionEvidenceRecord | null {
  return typeof value === 'object' && value !== null ? registry.get(value) ?? null : null;
}
