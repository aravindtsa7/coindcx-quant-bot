import {
  issueTrustedPaperExecutionEvidence,
  type TrustedPaperExecutionEvidence,
} from '../../execution/trusted-evidence';
import { CoinDcxPaperEvidence, readProductionAcquiredPaperExecutionEvidence } from './paper-evidence';

export type TrustedExecutionEvidenceReadResult =
  | Readonly<{ state: 'AVAILABLE'; evidence: TrustedPaperExecutionEvidence }>
  | Readonly<{ state: 'UNAVAILABLE'; reason: string }>;

/**
 * Narrow P14-B -> P14-E adapter. All provider reads happen before execution;
 * the economic transaction receives only an immutable runtime capability.
 *
 * [F14-02] Provenance, not shape, is the trust boundary. Previously this
 * function proved only that "an adapter wrapped a provider object": a caller
 * could publicly construct a `CoinDcxPaperEvidence` over a fake socket
 * factory, push fabricated `depth-snapshot`/conversion payloads through the
 * public `ingest*` methods, and receive an AVAILABLE, production-usable
 * trusted bundle. It now delegates the read to
 * `readProductionAcquiredPaperExecutionEvidence`, which releases data only
 * when the provider is a genuine, non-subclassed instance registered by the
 * real constructor AND every constituent datum was acquired through the
 * approved CoinDCX acquisition path (module-private capability in
 * `./acquisition-capability`). A manual/test/caller-fed provider yields
 * `EVIDENCE_NOT_PRODUCTION_ACQUIRED` and no branded bundle is ever minted.
 *
 * Every pre-existing P14-B gate is preserved unchanged and still evaluated
 * FIRST (current-generation WS-actionable orderbook, orderbook/conversion
 * staleness, clock-fault rejection, REST never blessing a generation) — this
 * adds a requirement, it never relaxes one.
 */
export function getTrustedPaperExecutionEvidence(
  provider: CoinDcxPaperEvidence,
  pair: string,
): TrustedExecutionEvidenceReadResult {
  const read = readProductionAcquiredPaperExecutionEvidence(provider, pair);
  if (read.state !== 'AVAILABLE') return Object.freeze({ state: 'UNAVAILABLE', reason: read.reason });

  const { quote, depth, conversion, conversionLocalPollFreshnessMs, orderbookGenerationId } = read.snapshot;
  if (
    depth.sourceClassification !== 'WEBSOCKET_ACTIONABLE'
    || depth.pair !== pair
    || depth.generationId !== orderbookGenerationId
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
        conversion,
        conversionLocalPollFreshnessMs,
      }),
    });
  } catch {
    return Object.freeze({ state: 'UNAVAILABLE', reason: 'EVIDENCE_BUNDLE_VALIDATION_FAILED' });
  }
}
