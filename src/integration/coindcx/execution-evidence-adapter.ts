import {
  issueTrustedPaperExecutionEvidence,
  type TrustedPaperExecutionEvidence,
} from '../../execution/trusted-evidence';
import { CoinDcxPaperEvidence } from './paper-evidence';

export type TrustedExecutionEvidenceReadResult =
  | Readonly<{ state: 'AVAILABLE'; evidence: TrustedPaperExecutionEvidence }>
  | Readonly<{ state: 'UNAVAILABLE'; reason: string }>;

/**
 * Narrow P14-B -> P14-E adapter. All provider reads happen before execution;
 * the economic transaction receives only an immutable runtime capability.
 */
export function getTrustedPaperExecutionEvidence(
  provider: CoinDcxPaperEvidence,
  pair: string,
): TrustedExecutionEvidenceReadResult {
  if (!(provider instanceof CoinDcxPaperEvidence)) {
    return Object.freeze({ state: 'UNAVAILABLE', reason: 'UNTRUSTED_EVIDENCE_PROVIDER' });
  }
  const quoteResult = provider.getLatestExecutionQuote(pair);
  if (quoteResult.state !== 'AVAILABLE') return Object.freeze({ state: 'UNAVAILABLE', reason: quoteResult.reason });
  const depthResult = provider.getLatestOrderbookEvidence(pair);
  if (depthResult.state !== 'AVAILABLE') return Object.freeze({ state: 'UNAVAILABLE', reason: depthResult.reason });
  const conversionResult = provider.getLatestConversion();
  if (conversionResult.state !== 'AVAILABLE') return Object.freeze({ state: 'UNAVAILABLE', reason: conversionResult.reason });

  const quote = quoteResult.snapshot;
  const depth = depthResult.snapshot;
  if (
    depth.sourceClassification !== 'WEBSOCKET_ACTIONABLE'
    || depth.pair !== pair
    || depth.generationId !== provider.orderbookGenerationId
    || quote.pair !== depth.pair
    || quote.bid !== depth.bestBid
    || quote.ask !== depth.bestAsk
    || quote.providerEventTimeMs !== depth.providerTs
    || quote.firstObservedAtMs !== depth.observedAtMs
    || quote.sourceSessionId !== depth.sourceSessionId
    || quote.generationId !== depth.generationId
    || quote.contentSha256 !== depth.contentSha256
  ) {
    return Object.freeze({ state: 'UNAVAILABLE', reason: 'QUOTE_DEPTH_BINDING_INVALID' });
  }

  try {
    return Object.freeze({
      state: 'AVAILABLE',
      evidence: issueTrustedPaperExecutionEvidence({
        quote,
        orderbookDepth: {
          pair: depth.pair,
          bestBid: depth.bestBid,
          bestBidQuantity: depth.bestBidQuantity,
          bestAsk: depth.bestAsk,
          bestAskQuantity: depth.bestAskQuantity,
          providerEventTimeMs: depth.providerTs,
          observedAtMs: depth.observedAtMs,
          sourceSessionId: depth.sourceSessionId,
          generationId: depth.generationId,
          contentSha256: depth.contentSha256,
        },
        conversion: conversionResult.snapshot,
        conversionLocalPollFreshnessMs: provider.conversionLocalPollFreshnessMs,
      }),
    });
  } catch {
    return Object.freeze({ state: 'UNAVAILABLE', reason: 'EVIDENCE_BUNDLE_VALIDATION_FAILED' });
  }
}
