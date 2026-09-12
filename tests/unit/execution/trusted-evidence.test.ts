import { describe, expect, it } from 'vitest';
import * as executionBarrel from '../../../src/execution';
import * as persistenceBarrel from '../../../src/execution/persistence';
import {
  issueTrustedPaperExecutionEvidence,
  readTrustedPaperExecutionEvidence,
  type TrustedPaperConversionEvidence,
  type TrustedPaperOrderbookDepth,
} from '../../../src/execution/trusted-evidence';
import { FakeClock } from '../../../src/integration/coindcx/clock';
import { getTrustedPaperExecutionEvidence } from '../../../src/integration/coindcx/execution-evidence-adapter';
import { CoinDcxPaperEvidence, type PaperEvidenceInstrument } from '../../../src/integration/coindcx/paper-evidence';
import { FakeCoinDcxSocketFactory } from '../../../src/integration/coindcx/websocket/socket-adapter';
import type { PaperExecutionQuoteSnapshot } from '../../../src/execution/evidence';

const NOW = 1_700_000_000_000;
const PAIR = 'B-BTC_USDT';
const INSTRUMENTS: readonly PaperEvidenceInstrument[] = Object.freeze([
  Object.freeze({ pair: PAIR, underlying: 'BTC', quoteCurrency: 'USDT', instrumentSpecSnapshotId: 'btc-spec-v1' }),
]);

function mutableInputs() {
  const quote = {
    pair: PAIR, instrumentSpecSnapshotId: 'btc-spec-v1', bid: '100', ask: '101', availableExecutableQuantity: null,
    providerEventId: 'event-1', providerEventTimeMs: NOW, firstObservedAtMs: NOW, sourceSessionId: 'session-1', generationId: 1,
    healthState: 'HEALTHY' as const, contentSha256: 'content-1', evidencePolicyVersion: 'P14_B_EVIDENCE_POLICY_V1',
  } satisfies PaperExecutionQuoteSnapshot;
  const orderbookDepth = {
    pair: PAIR, bestBid: '100', bestBidQuantity: '2', bestAsk: '101', bestAskQuantity: '3',
    providerEventTimeMs: NOW, observedAtMs: NOW, sourceSessionId: 'session-1', generationId: 1, contentSha256: 'content-1',
  } satisfies TrustedPaperOrderbookDepth;
  const conversion = {
    conversionPriceInrPerUsdt: '83', providerEventTimeMs: 1, observedAtMs: NOW,
    sourceId: 'COINDCX_USDTINR_CONVERSION_REST_V1', contentSha256: 'conversion-1',
  } satisfies TrustedPaperConversionEvidence;
  return { quote, orderbookDepth, conversion };
}

describe('P14-E trusted execution evidence runtime boundary', () => {
  it('rejects plain structural objects and foreign symbols at runtime', () => {
    expect(readTrustedPaperExecutionEvidence({ __trustedPaperExecutionEvidence: true })).toBeNull();
    expect(readTrustedPaperExecutionEvidence({ brand: Symbol('trusted') })).toBeNull();
  });

  it('copies and freezes all economic evidence so later caller mutation cannot change execution inputs', () => {
    const source = mutableInputs();
    const capability = issueTrustedPaperExecutionEvidence({ ...source, conversionLocalPollFreshnessMs: 60_000 });
    source.quote.ask = '999999';
    source.orderbookDepth.bestAskQuantity = '0.000000000000000001';
    source.conversion.conversionPriceInrPerUsdt = '999';
    const stored = readTrustedPaperExecutionEvidence(capability);
    expect(stored?.quote.ask).toBe('101');
    expect(stored?.orderbookDepth.bestAskQuantity).toBe('3');
    expect(stored?.conversion.conversionPriceInrPerUsdt).toBe('83');
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored?.quote)).toBe(true);
    expect(Object.isFrozen(stored?.orderbookDepth)).toBe(true);
    expect(Object.isFrozen(stored?.conversion)).toBe(true);
  });

  it('does not expose its minting seam from normal execution or persistence barrels', () => {
    expect((executionBarrel as Record<string, unknown>)['issueTrustedPaperExecutionEvidence']).toBeUndefined();
    expect((persistenceBarrel as Record<string, unknown>)['issueTrustedPaperExecutionEvidence']).toBeUndefined();
  });

  it('accepts a genuine current-generation P14-B observation set through the CoinDCX adapter, preserving local conversion freshness', () => {
    const clock = new FakeClock(NOW);
    const socketFactory = new FakeCoinDcxSocketFactory();
    const provider = new CoinDcxPaperEvidence({
      instruments: INSTRUMENTS, clock, socketFactory,
      policy: { orderbookFreshnessMs: 100, markFreshnessMs: 100, conversionLocalPollFreshnessMs: 321, allowedProviderFutureSkewMs: 10 },
    });
    const generation = provider.startOrderbookWebSocket();
    expect(provider.ingestOrderbookWebSocket({
      data: JSON.stringify({ type: 'depth-snapshot', pr: 'futures', s: 'BTCUSDT', ts: String(NOW), vs: '1', bids: [['100', '2']], asks: [['101', '3']] }),
    }, generation)).toMatchObject({ accepted: true });
    // Deliberately ancient provider timestamp: P14-B freshness is local poll age.
    expect(provider.ingestConversionRest([{
      symbol: 'USDTINR', margin_currency_short_name: 'INR', target_currency_short_name: 'USDT', conversion_price: '83', last_updated_at: '1',
    }])).toMatchObject({ accepted: true });

    const result = getTrustedPaperExecutionEvidence(provider, PAIR);
    expect(result.state).toBe('AVAILABLE');
    if (result.state !== 'AVAILABLE') return;
    const stored = readTrustedPaperExecutionEvidence(result.evidence);
    expect(stored?.conversion.providerEventTimeMs).toBe(1);
    expect(stored?.conversion.observedAtMs).toBe(NOW);
    expect(stored?.conversionLocalPollFreshnessMs).toBe(321);
  });

  it('cannot mint through the production adapter from a caller-shaped provider', () => {
    const fake = {
      getLatestExecutionQuote: () => ({ state: 'AVAILABLE' }),
      getLatestOrderbookEvidence: () => ({ state: 'AVAILABLE' }),
      getLatestConversion: () => ({ state: 'AVAILABLE' }),
    } as unknown as CoinDcxPaperEvidence;
    expect(getTrustedPaperExecutionEvidence(fake, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'UNTRUSTED_EVIDENCE_PROVIDER' });
  });
});
