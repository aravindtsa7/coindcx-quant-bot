import { describe, expect, it } from 'vitest';
import * as executionBarrel from '../../../src/execution';
import * as persistenceBarrel from '../../../src/execution/persistence';
import {
  issueTrustedPaperExecutionEvidence,
  readTrustedPaperExecutionEvidence,
  type TrustedPaperConversionEvidence,
  type TrustedPaperOrderbookDepth,
} from '../../../src/execution/trusted-evidence';
import { PRODUCTION_ACQUISITION_CAPABILITY } from '../../../src/integration/coindcx/acquisition-capability';
import { FakeClock } from '../../../src/integration/coindcx/clock';
import { getTrustedPaperExecutionEvidence } from '../../../src/integration/coindcx/execution-evidence-adapter';
import {
  CoinDcxPaperEvidence, readProductionAcquiredPaperValuationEvidence,
  type PaperEvidenceInstrument,
} from '../../../src/integration/coindcx/paper-evidence';
import { FakeCoinDcxSocketFactory } from '../../../src/integration/coindcx/websocket/socket-adapter';
import type { PaperExecutionQuoteSnapshot } from '../../../src/execution/evidence';

const NOW = 1_700_000_000_000;
const PAIR = 'B-BTC_USDT';
const PAIR_B = 'B-ETH_USDT';
const INSTRUMENTS: readonly PaperEvidenceInstrument[] = Object.freeze([
  Object.freeze({ pair: PAIR, underlying: 'BTC', quoteCurrency: 'USDT', instrumentSpecSnapshotId: 'btc-spec-v1' }),
  Object.freeze({ pair: PAIR_B, underlying: 'ETH', quoteCurrency: 'USDT', instrumentSpecSnapshotId: 'eth-spec-v1' }),
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

const EVIDENCE_POLICY = { orderbookFreshnessMs: 100, markFreshnessMs: 100, conversionLocalPollFreshnessMs: 321, allowedProviderFutureSkewMs: 10 } as const;
const BOOK_FRAME = {
  data: JSON.stringify({ type: 'depth-snapshot', pr: 'futures', s: 'BTCUSDT', ts: String(NOW), vs: '1', bids: [['100', '2']], asks: [['101', '3']] }),
};
// Deliberately ancient provider timestamp: P14-B conversion freshness is local poll age.
const CONVERSION_BODY = [{ symbol: 'USDTINR', margin_currency_short_name: 'INR', target_currency_short_name: 'USDT', conversion_price: '83', last_updated_at: '1' }];
const MARK_FRAME = {
  data: JSON.stringify({
    ts: String(NOW), vs: '1',
    BTCUSDT: { mp: '100', bmST: String(NOW) },
    ETHUSDT: { mp: '50', bmST: String(NOW) },
  }),
};

/** [F14-02] A provider whose injected test seams are re-blessed as approved acquisition by the module-private capability. */
function productionAcquiredProvider(): CoinDcxPaperEvidence {
  return new CoinDcxPaperEvidence({
    instruments: INSTRUMENTS, clock: new FakeClock(NOW), socketFactory: new FakeCoinDcxSocketFactory(),
    policy: EVIDENCE_POLICY, acquisitionCapability: PRODUCTION_ACQUISITION_CAPABILITY,
  });
}

/** [F14-02] The exact same provider WITHOUT the capability â€” the shape any public/manual caller can build. */
function callerFedProvider(): CoinDcxPaperEvidence {
  return new CoinDcxPaperEvidence({
    instruments: INSTRUMENTS, clock: new FakeClock(NOW), socketFactory: new FakeCoinDcxSocketFactory(), policy: EVIDENCE_POLICY,
  });
}

function feedApproved(provider: CoinDcxPaperEvidence): void {
  const generation = provider.startOrderbookWebSocket();
  expect(provider.ingestOrderbookWebSocket(BOOK_FRAME, generation, undefined, PRODUCTION_ACQUISITION_CAPABILITY)).toMatchObject({ accepted: true });
  expect(provider.ingestConversionRest(CONVERSION_BODY, PRODUCTION_ACQUISITION_CAPABILITY)).toMatchObject({ accepted: true });
}

/** Byte-identical payloads, fed through the public ingestion surface with no capability â€” Astra's reproducer. */
function feedManually(provider: CoinDcxPaperEvidence): void {
  const generation = provider.startOrderbookWebSocket();
  expect(provider.ingestOrderbookWebSocket(BOOK_FRAME, generation)).toMatchObject({ accepted: true });
  expect(provider.ingestConversionRest(CONVERSION_BODY)).toMatchObject({ accepted: true });
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
    // [F14-02] The approved acquisition path, reached through the internal
    // non-barrel capability so no real network is required (Â§20).
    const provider = productionAcquiredProvider();
    feedApproved(provider);

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

// ---------------------------------------------------------------------------
// [F14-02] Production acquisition provenance â€” Astra's fabrication reproducer
// and every bypass route Â§12 enumerates.
// ---------------------------------------------------------------------------

describe('F14-02 trusted evidence requires approved CoinDCX acquisition provenance', () => {
  it('Astra reproducer: a publicly-constructed provider fed fabricated orderbook/conversion payloads mints NO production-usable trusted evidence', () => {
    const provider = callerFedProvider();
    feedManually(provider);

    // Every pre-existing P14-B gate still passes on this data â€” the provider
    // genuinely holds a current-generation, WS-actionable, fresh quote and a
    // locally-fresh conversion. Before F14-02 that was sufficient to mint.
    expect(provider.getLatestExecutionQuote(PAIR).state).toBe('AVAILABLE');
    expect(provider.getLatestConversion().state).toBe('AVAILABLE');

    expect(getTrustedPaperExecutionEvidence(provider, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'EVIDENCE_NOT_PRODUCTION_ACQUIRED' });
  });

  it('a fake socket factory does not launder fabricated frames into production provenance, even through the provider\'s own internal socket callback', () => {
    const socketFactory = new FakeCoinDcxSocketFactory();
    const provider = new CoinDcxPaperEvidence({ instruments: INSTRUMENTS, clock: new FakeClock(NOW), socketFactory, policy: EVIDENCE_POLICY });
    provider.startOrderbookWebSocket();
    // Delivered by the fake socket itself â€” i.e. through the provider's own
    // internal `#startSocket` handler, which DOES supply the capability.
    socketFactory.latestSocket?.trigger('depth-snapshot', BOOK_FRAME);
    expect(provider.ingestConversionRest(CONVERSION_BODY, PRODUCTION_ACQUISITION_CAPABILITY)).toMatchObject({ accepted: true });

    expect(provider.getLatestExecutionQuote(PAIR).state).toBe('AVAILABLE'); // the frame WAS ingested
    expect(getTrustedPaperExecutionEvidence(provider, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'EVIDENCE_NOT_PRODUCTION_ACQUIRED' });
  });

  it('a subclass of the real provider is never a genuine production provider', () => {
    class ForgedProvider extends CoinDcxPaperEvidence {
      public override readProductionAcquiredExecutionEvidence(): never {
        throw new Error('a subclass override must never be reached by the production adapter');
      }
    }
    const forged = new ForgedProvider({
      instruments: INSTRUMENTS, clock: new FakeClock(NOW), socketFactory: new FakeCoinDcxSocketFactory(),
      policy: EVIDENCE_POLICY, acquisitionCapability: PRODUCTION_ACQUISITION_CAPABILITY,
    });
    feedApproved(forged);
    expect(getTrustedPaperExecutionEvidence(forged, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'UNTRUSTED_EVIDENCE_PROVIDER' });
  });

  it('an own-property shadow installed on a genuine provider cannot substitute its reader or any getter it uses', () => {
    const provider = productionAcquiredProvider();
    feedApproved(provider);
    const shadow = { value: () => { throw new Error('an instance shadow must never be reached by the production adapter'); }, configurable: true };
    Object.defineProperty(provider, 'readProductionAcquiredExecutionEvidence', shadow);
    Object.defineProperty(provider, 'getLatestExecutionQuote', shadow);
    Object.defineProperty(provider, 'getLatestConversion', shadow);
    Object.defineProperty(provider, 'getLatestOrderbookEvidence', shadow);
    // The PROTOTYPE reader ran, and it reads through private twins/fields that
    // no own property can shadow.
    expect(getTrustedPaperExecutionEvidence(provider, PAIR).state).toBe('AVAILABLE');
  });

  it('a structural look-alike carrying the exact production shape is rejected', () => {
    const genuine = productionAcquiredProvider();
    feedApproved(genuine);
    const real = genuine.readProductionAcquiredExecutionEvidence(PAIR);
    expect(real.state).toBe('AVAILABLE');
    const structural = {
      orderbookGenerationId: 1,
      readProductionAcquiredExecutionEvidence: () => real,
      conversionLocalPollFreshnessMs: 321,
    } as unknown as CoinDcxPaperEvidence;
    expect(getTrustedPaperExecutionEvidence(structural, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'UNTRUSTED_EVIDENCE_PROVIDER' });
    expect(Object.create(Object.getPrototypeOf(genuine) as object)).toBeDefined();
    expect(getTrustedPaperExecutionEvidence(Object.create(CoinDcxPaperEvidence.prototype) as CoinDcxPaperEvidence, PAIR))
      .toEqual({ state: 'UNAVAILABLE', reason: 'UNTRUSTED_EVIDENCE_PROVIDER' });
  });

  it('a caller-supplied conversion alone poisons an otherwise production-acquired bundle (every constituent datum must be approved)', () => {
    const provider = productionAcquiredProvider();
    const generation = provider.startOrderbookWebSocket();
    expect(provider.ingestOrderbookWebSocket(BOOK_FRAME, generation, undefined, PRODUCTION_ACQUISITION_CAPABILITY)).toMatchObject({ accepted: true });
    expect(provider.ingestConversionRest(CONVERSION_BODY)).toMatchObject({ accepted: true }); // no capability
    expect(getTrustedPaperExecutionEvidence(provider, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'EVIDENCE_NOT_PRODUCTION_ACQUIRED' });
  });

  it('a string brand / isProduction-style flag never substitutes for the capability', () => {
    const provider = new CoinDcxPaperEvidence({
      instruments: INSTRUMENTS, clock: new FakeClock(NOW), socketFactory: new FakeCoinDcxSocketFactory(), policy: EVIDENCE_POLICY,
      acquisitionCapability: 'P14-B production acquisition capability (internal, non-barrel)',
    });
    const generation = provider.startOrderbookWebSocket();
    provider.ingestOrderbookWebSocket(BOOK_FRAME, generation, undefined, { isProduction: true });
    provider.ingestConversionRest(CONVERSION_BODY, Symbol('P14-B production acquisition capability (internal, non-barrel)'));
    expect(getTrustedPaperExecutionEvidence(provider, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'EVIDENCE_NOT_PRODUCTION_ACQUIRED' });
  });

  it('every pre-existing P14-B staleness/generation gate still fires ahead of the provenance gate', () => {
    // Wrong generation: the frame is rejected outright, so nothing is stored.
    const wrongGeneration = productionAcquiredProvider();
    const generation = wrongGeneration.startOrderbookWebSocket();
    expect(wrongGeneration.ingestOrderbookWebSocket(BOOK_FRAME, generation + 1, undefined, PRODUCTION_ACQUISITION_CAPABILITY)).toMatchObject({ accepted: false, reason: 'OLD_GENERATION' });
    expect(getTrustedPaperExecutionEvidence(wrongGeneration, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'NO_CURRENT_GENERATION_WEBSOCKET_ORDERBOOK' });

    // Stale orderbook: production-acquired, but beyond the freshness policy.
    const clock = new FakeClock(NOW);
    const stale = new CoinDcxPaperEvidence({
      instruments: INSTRUMENTS, clock, socketFactory: new FakeCoinDcxSocketFactory(), policy: EVIDENCE_POLICY,
      acquisitionCapability: PRODUCTION_ACQUISITION_CAPABILITY,
    });
    feedApproved(stale);
    expect(getTrustedPaperExecutionEvidence(stale, PAIR).state).toBe('AVAILABLE');
    clock.setTime(NOW + EVIDENCE_POLICY.orderbookFreshnessMs + 1);
    expect(getTrustedPaperExecutionEvidence(stale, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'ORDERBOOK_STALE_OR_CLOCK_FAULT' });

    // Clock regression is still a fault, not a fresh read.
    clock.setTime(NOW - 1);
    expect(getTrustedPaperExecutionEvidence(stale, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'ORDERBOOK_STALE_OR_CLOCK_FAULT' });
  });

  it('REST bootstrap evidence still cannot make a generation actionable, capability or not', () => {
    const provider = productionAcquiredProvider();
    provider.startOrderbookWebSocket();
    expect(provider.ingestOrderbookRest(PAIR, {
      type: 'depth-snapshot', pr: 'futures', s: 'BTCUSDT', ts: String(NOW), vs: '1', bids: [['100', '2']], asks: [['101', '3']],
    }, PRODUCTION_ACQUISITION_CAPABILITY)).toMatchObject({ accepted: true });
    expect(provider.ingestConversionRest(CONVERSION_BODY, PRODUCTION_ACQUISITION_CAPABILITY)).toMatchObject({ accepted: true });
    expect(getTrustedPaperExecutionEvidence(provider, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'NO_CURRENT_GENERATION_WEBSOCKET_ORDERBOOK' });
  });

  it('the public CoinDCX barrel exposes neither the acquisition capability nor the fake socket helpers', async () => {
    const barrel = await import('../../../src/integration/coindcx') as Record<string, unknown>;
    expect(barrel['PRODUCTION_ACQUISITION_CAPABILITY']).toBeUndefined();
    expect(barrel['FakeCoinDcxSocket']).toBeUndefined();
    expect(barrel['FakeCoinDcxSocketFactory']).toBeUndefined();
    // The genuine production acquisition surface is of course still exported.
    expect(barrel['ProductionCoinDcxSocketFactory']).toBeDefined();
    expect(barrel['CoinDcxPaperEvidence']).toBeDefined();
  });
});

describe('F14-01 production-acquired mark-to-market valuation evidence', () => {
  it('returns fresh production-acquired marks for every requested OPEN pair plus the production conversion', () => {
    const provider = productionAcquiredProvider();
    feedApproved(provider);
    const generation = provider.startMarkWebSocket();
    expect(provider.ingestMarkWebSocket(MARK_FRAME, generation, PRODUCTION_ACQUISITION_CAPABILITY))
      .toMatchObject({ accepted: true });

    const result = readProductionAcquiredPaperValuationEvidence(provider, [PAIR, PAIR_B]);
    expect(result.state).toBe('AVAILABLE');
    if (result.state !== 'AVAILABLE') return;
    expect([...result.snapshot.marksByPair.keys()]).toEqual([PAIR, PAIR_B]);
    expect(result.snapshot.marksByPair.get(PAIR)?.markPrice).toBe('100');
    expect(result.snapshot.marksByPair.get(PAIR_B)?.markPrice).toBe('50');
    expect(result.snapshot.conversion.conversionPriceInrPerUsdt).toBe('83');
    expect(result.snapshot.markGenerationId).toBe(generation);
  });

  it('fails the whole account valuation when any requested OPEN pair lacks a current-generation fresh mark', () => {
    const provider = productionAcquiredProvider();
    feedApproved(provider);
    const generation = provider.startMarkWebSocket();
    const btcOnly = {
      data: JSON.stringify({ ts: String(NOW), vs: '1', BTCUSDT: { mp: '100', bmST: String(NOW) } }),
    };
    expect(provider.ingestMarkWebSocket(btcOnly, generation, PRODUCTION_ACQUISITION_CAPABILITY))
      .toMatchObject({ accepted: true });

    expect(readProductionAcquiredPaperValuationEvidence(provider, [PAIR, PAIR_B]))
      .toEqual({ state: 'UNAVAILABLE', reason: `NO_CURRENT_GENERATION_WEBSOCKET_MARK:${PAIR_B}` });
  });

  it('rejects a caller-fed mark even when conversion and every ordinary freshness/generation check pass', () => {
    const provider = productionAcquiredProvider();
    feedApproved(provider);
    const generation = provider.startMarkWebSocket();
    // No capability: byte-valid and fresh, but explicitly CALLER_SUPPLIED.
    expect(provider.ingestMarkWebSocket(MARK_FRAME, generation)).toMatchObject({ accepted: true });
    expect(provider.getLatestMark(PAIR).state).toBe('AVAILABLE');

    expect(readProductionAcquiredPaperValuationEvidence(provider, [PAIR]))
      .toEqual({ state: 'UNAVAILABLE', reason: `EVIDENCE_NOT_PRODUCTION_ACQUIRED:${PAIR}` });
  });

  it('rejects a caller-fed conversion even when every requested mark is production-acquired and fresh', () => {
    const provider = productionAcquiredProvider();
    expect(provider.ingestConversionRest(CONVERSION_BODY)).toMatchObject({ accepted: true });
    const generation = provider.startMarkWebSocket();
    expect(provider.ingestMarkWebSocket(MARK_FRAME, generation, PRODUCTION_ACQUISITION_CAPABILITY))
      .toMatchObject({ accepted: true });

    expect(readProductionAcquiredPaperValuationEvidence(provider, [PAIR, PAIR_B]))
      .toEqual({ state: 'UNAVAILABLE', reason: 'EVIDENCE_NOT_PRODUCTION_ACQUIRED' });
  });

  it('rejects stale marks and stale conversion evidence through their existing frozen freshness gates', () => {
    const clock = new FakeClock(NOW);
    const provider = new CoinDcxPaperEvidence({
      instruments: INSTRUMENTS, clock, socketFactory: new FakeCoinDcxSocketFactory(),
      policy: EVIDENCE_POLICY, acquisitionCapability: PRODUCTION_ACQUISITION_CAPABILITY,
    });
    expect(provider.ingestConversionRest(CONVERSION_BODY, PRODUCTION_ACQUISITION_CAPABILITY)).toMatchObject({ accepted: true });
    const generation = provider.startMarkWebSocket();
    expect(provider.ingestMarkWebSocket(MARK_FRAME, generation, PRODUCTION_ACQUISITION_CAPABILITY)).toMatchObject({ accepted: true });

    clock.setTime(NOW + EVIDENCE_POLICY.markFreshnessMs + 1);
    expect(readProductionAcquiredPaperValuationEvidence(provider, [PAIR]))
      .toEqual({ state: 'UNAVAILABLE', reason: `MARK_STALE_OR_CLOCK_FAULT:${PAIR}` });

    // Refresh marks at the new time, then advance beyond only the longer
    // conversion local-poll window: conversion must independently fail.
    const refreshedGeneration = provider.startMarkWebSocket();
    const refreshedMark = {
      data: JSON.stringify({ ts: String(clock.nowMs()), vs: '2', BTCUSDT: { mp: '101', bmST: String(clock.nowMs()) } }),
    };
    expect(provider.ingestMarkWebSocket(refreshedMark, refreshedGeneration, PRODUCTION_ACQUISITION_CAPABILITY))
      .toMatchObject({ accepted: true });
    clock.setTime(NOW + EVIDENCE_POLICY.conversionLocalPollFreshnessMs + 1);
    expect(readProductionAcquiredPaperValuationEvidence(provider, [PAIR]))
      .toEqual({ state: 'UNAVAILABLE', reason: 'CONVERSION_LOCAL_POLL_STALE_OR_CLOCK_FAULT' });
  });
});
