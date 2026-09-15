import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async () => (await import('../../helpers/fake-socket-io')).socketIoClientMock());
import * as executionBarrel from '../../../src/execution';
import * as persistenceBarrel from '../../../src/execution/persistence';
import {
  issueTrustedPaperExecutionEvidence,
  readTrustedPaperExecutionEvidence,
  type TrustedPaperConversionEvidence,
  type TrustedPaperOrderbookDepth,
} from '../../../src/execution/trusted-evidence';
import { getTrustedPaperExecutionEvidence } from '../../../src/integration/coindcx/execution-evidence-adapter';
import {
  CoinDcxPaperEvidence, createProductionPaperEvidenceProvider, readProductionAcquiredPaperValuationEvidence,
  type PaperEvidenceInstrument,
} from '../../../src/integration/coindcx/paper-evidence';
import { CoinDcxTransport } from '../../../src/integration/coindcx/transport';
import { FakeCoinDcxSocketFactory } from '../../../src/integration/coindcx/websocket/socket-adapter';
import type { PaperExecutionQuoteSnapshot } from '../../../src/execution/evidence';
import {
  acquireConversionOverRest, acquireMarkOverWebSocket, acquireOrderbookOverWebSocket,
  createInterceptedProductionProvider, interceptProductionAcquisition,
  type ProductionAcquisitionInterception,
} from '../../helpers/production-acquisition-harness';

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

/**
 * [F14-02 §12] The production path selects the real `SystemClock`, so
 * deterministic time is controlled the same way the acquisition seams are: by
 * intercepting the real primitive from the test runner, never by injecting one
 * through a production API (there is no longer a `clock` option on the
 * production factory).
 */
let currentNow = NOW;
function setNow(ms: number): void { currentNow = ms; }

let interception: ProductionAcquisitionInterception;

beforeEach(() => {
  currentNow = NOW;
  vi.spyOn(Date, 'now').mockImplementation(() => currentNow);
  interception = interceptProductionAcquisition();
});
afterEach(() => vi.restoreAllMocks());

/** [F14-02] A provider built by the ONE approved production path. */
function productionAcquiredProvider(): CoinDcxPaperEvidence {
  return createInterceptedProductionProvider(INSTRUMENTS, EVIDENCE_POLICY);
}

/** [F14-02] The exact same class, built through the PUBLIC constructor — the shape any caller can build. */
function callerFedProvider(): CoinDcxPaperEvidence {
  return new CoinDcxPaperEvidence({
    instruments: INSTRUMENTS, socketFactory: new FakeCoinDcxSocketFactory(), policy: EVIDENCE_POLICY,
  });
}

/** Acquisition through the provider's OWN internal CoinDCX path (real WS callback + real REST read). */
async function feedApproved(provider: CoinDcxPaperEvidence): Promise<void> {
  acquireOrderbookOverWebSocket(provider, interception, BOOK_FRAME);
  await acquireConversionOverRest(provider, interception, CONVERSION_BODY);
}

/** Byte-identical payloads, fed through the public ingestion surface — Astra's reproducer. */
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

  // [F14-02 §18.12] The genuine approved production acquisition path still works.
  it('accepts a genuine current-generation P14-B observation set through the CoinDCX adapter, preserving local conversion freshness', async () => {
    const provider = productionAcquiredProvider();
    await feedApproved(provider);

    // Proof the data really travelled the production primitives, not an injected seam.
    expect(interception.restCalls).toEqual(['FUTURES_CONVERSIONS']);
    expect(interception.sockets).toHaveLength(1);

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
// [F14-02] Production acquisition provenance — Astra's two exploit families and
// every bypass route §18 enumerates.
// ---------------------------------------------------------------------------

describe('F14-02 trusted evidence requires approved CoinDCX acquisition provenance', () => {
  /**
   * [F14-02 §18.1/§18.2] Astra ATTACK A, verbatim: options whose getters return
   * `undefined` on the read that makes the security decision and an
   * attacker-controlled dependency on the read that actually builds the
   * provider.
   */
  function toctouOptions(evil: Readonly<Record<string, unknown>>): { options: Record<string, unknown>; reads: Map<string, number> } {
    const reads = new Map<string, number>();
    const options: Record<string, unknown> = { instruments: INSTRUMENTS, policy: EVIDENCE_POLICY };
    for (const [key, value] of Object.entries(evil)) {
      Object.defineProperty(options, key, {
        get(): unknown {
          const seen = (reads.get(key) ?? 0) + 1;
          reads.set(key, seen);
          return seen === 1 ? undefined : value;
        },
        enumerable: true, configurable: true,
      });
    }
    return { options, reads };
  }

  it('§18.1 a getter that hides a fake socket factory from the trust decision is never consulted twice and cannot mint execution evidence', () => {
    const socketFactory = new FakeCoinDcxSocketFactory();
    const { options, reads } = toctouOptions({ socketFactory });
    const provider = new CoinDcxPaperEvidence(options as never);

    // [§4] The property was read EXACTLY ONCE, so the getter's second,
    // attacker-controlled value never reached the provider at all.
    expect(reads.get('socketFactory')).toBe(1);
    provider.startOrderbookWebSocket();
    expect(socketFactory.createdSockets).toHaveLength(0);
    expect(interception.sockets).toHaveLength(1);

    // [§5] Even feeding the frame through the provider's OWN internal
    // `#startSocket` handler — the laundering route Astra used — mints nothing,
    // because trust no longer follows from "the options looked default".
    interception.latestSocket().trigger('depth-snapshot', BOOK_FRAME);
    expect(provider.ingestConversionRest(CONVERSION_BODY)).toMatchObject({ accepted: true });
    expect(provider.getLatestExecutionQuote(PAIR).state).toBe('AVAILABLE');
    expect(getTrustedPaperExecutionEvidence(provider, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'PROVIDER_NOT_PRODUCTION_ACQUIRED' });
  });

  it('§18.2/§18.10 a getter that hides a fake REST transport from the trust decision is never consulted twice and cannot mint execution evidence', async () => {
    let evilTransportCalls = 0;
    const conversionTransport = {
      executeRead: async () => { evilTransportCalls += 1; return { status: 200, headers: {}, durationMs: 0, data: CONVERSION_BODY }; },
    } as unknown as CoinDcxTransport;
    const { options, reads } = toctouOptions({ conversionTransport });
    const provider = new CoinDcxPaperEvidence(options as never);

    expect(reads.get('conversionTransport')).toBe(1);
    acquireOrderbookOverWebSocket(provider, interception, BOOK_FRAME);
    // The provider's OWN approved REST read method. It goes to the real
    // transport; the attacker's transport was never installed.
    await acquireConversionOverRest(provider, interception, CONVERSION_BODY);
    expect(evilTransportCalls).toBe(0);

    expect(provider.getLatestConversion().state).toBe('AVAILABLE');
    expect(provider.getLatestExecutionQuote(PAIR).state).toBe('AVAILABLE');
    expect(getTrustedPaperExecutionEvidence(provider, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'PROVIDER_NOT_PRODUCTION_ACQUIRED' });
  });

  it('§18.4 the same getter attack cannot mint trusted mark-to-market valuation evidence either', async () => {
    const socketFactory = new FakeCoinDcxSocketFactory();
    let evilClockReads = 0;
    const clock = { nowMs: (): number => { evilClockReads += 1; return NOW; } };
    const { options, reads } = toctouOptions({ socketFactory, clock });
    const provider = new CoinDcxPaperEvidence(options as never);

    expect(reads.get('socketFactory')).toBe(1);
    expect(reads.get('clock')).toBe(1);

    // Astra's fabricated 999999 mark, delivered through the provider's own
    // internal mark-WS callback.
    const fabricated = { data: JSON.stringify({ ts: String(NOW), vs: '1', BTCUSDT: { mp: '999999', bmST: String(NOW) } }) };
    acquireMarkOverWebSocket(provider, interception, fabricated);
    await acquireConversionOverRest(provider, interception, CONVERSION_BODY);

    // The attacker clock was never installed, so the P14-B freshness/skew gates
    // still run against the real system clock.
    expect(evilClockReads).toBe(0);
    // The fabricated mark is visible to ordinary reads…
    const ordinaryRead = provider.getLatestMark(PAIR);
    expect(ordinaryRead.state).toBe('AVAILABLE');
    if (ordinaryRead.state === 'AVAILABLE') expect(ordinaryRead.snapshot.markPrice).toBe('999999');
    // …and can never reach equity valuation.
    expect(readProductionAcquiredPaperValuationEvidence(provider, [PAIR]))
      .toEqual({ state: 'UNAVAILABLE', reason: 'PROVIDER_NOT_PRODUCTION_ACQUIRED' });
  });

  it('§18.3 no constructor option combination whatsoever makes a publicly constructed provider production-trusted', async () => {
    // The exact combination that used to be blessed: every acquisition seam
    // left `undefined` so the old "everything looks default" inference fired.
    const defaults = new CoinDcxPaperEvidence({ instruments: INSTRUMENTS, policy: EVIDENCE_POLICY });
    acquireOrderbookOverWebSocket(defaults, interception, BOOK_FRAME);
    await acquireConversionOverRest(defaults, interception, CONVERSION_BODY);
    expect(defaults.getLatestExecutionQuote(PAIR).state).toBe('AVAILABLE');
    expect(getTrustedPaperExecutionEvidence(defaults, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'PROVIDER_NOT_PRODUCTION_ACQUIRED' });
  });

  it('§18.5 the acquisition capability is not exported, deep-importable, or reconstructible', async () => {
    const capabilityModule = await import('../../../src/integration/coindcx/acquisition-capability') as Record<string, unknown>;
    expect(capabilityModule['PRODUCTION_ACQUISITION_CAPABILITY']).toBeUndefined();
    expect(Object.keys(capabilityModule).filter((key) => /CAPABILITY|ACQUISITION/i.test(key))).toEqual([]);

    const evidenceModule = await import('../../../src/integration/coindcx/paper-evidence') as Record<string, unknown>;
    expect(evidenceModule['PRODUCTION_ACQUISITION_CAPABILITY']).toBeUndefined();
    expect(evidenceModule['PRODUCTION_PROVIDERS']).toBeUndefined();
    expect(evidenceModule['GENUINE_PROVIDERS']).toBeUndefined();
    expect(evidenceModule['acquisitionFor']).toBeUndefined();
    // Nothing exported anywhere returns a value that could be handed back in.
    expect(Object.keys(evidenceModule).filter((key) => /CAPABILITY/i.test(key))).toEqual([]);
  });

  it('§18.6 a manually ingested orderbook cannot be upgraded to production trust on a genuine production provider', async () => {
    const provider = productionAcquiredProvider();
    // Conversion acquired legitimately; the book fed by hand.
    await acquireConversionOverRest(provider, interception, CONVERSION_BODY);
    const generation = provider.startOrderbookWebSocket();
    expect(provider.ingestOrderbookWebSocket(BOOK_FRAME, generation)).toMatchObject({ accepted: true });
    expect(provider.getLatestExecutionQuote(PAIR).state).toBe('AVAILABLE');
    expect(getTrustedPaperExecutionEvidence(provider, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'EVIDENCE_NOT_PRODUCTION_ACQUIRED' });
  });

  it('§18.7 a manually ingested mark cannot be upgraded to production trust on a genuine production provider', async () => {
    const provider = productionAcquiredProvider();
    await acquireConversionOverRest(provider, interception, CONVERSION_BODY);
    const generation = provider.startMarkWebSocket();
    expect(provider.ingestMarkWebSocket(MARK_FRAME, generation)).toMatchObject({ accepted: true });
    expect(provider.getLatestMark(PAIR).state).toBe('AVAILABLE');
    expect(readProductionAcquiredPaperValuationEvidence(provider, [PAIR]))
      .toEqual({ state: 'UNAVAILABLE', reason: `EVIDENCE_NOT_PRODUCTION_ACQUIRED:${PAIR}` });
  });

  it('§18.8 a manually ingested conversion cannot be upgraded to production trust on a genuine production provider', () => {
    const provider = productionAcquiredProvider();
    acquireOrderbookOverWebSocket(provider, interception, BOOK_FRAME);
    expect(provider.ingestConversionRest(CONVERSION_BODY)).toMatchObject({ accepted: true });
    expect(provider.getLatestConversion().state).toBe('AVAILABLE');
    expect(getTrustedPaperExecutionEvidence(provider, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'EVIDENCE_NOT_PRODUCTION_ACQUIRED' });
  });

  it('§18.9 an explicitly injected socket factory is untrusted even through the provider\'s own internal socket callback', () => {
    const socketFactory = new FakeCoinDcxSocketFactory();
    const provider = new CoinDcxPaperEvidence({ instruments: INSTRUMENTS, socketFactory, policy: EVIDENCE_POLICY });
    provider.startOrderbookWebSocket();
    socketFactory.latestSocket?.trigger('depth-snapshot', BOOK_FRAME);
    provider.ingestConversionRest(CONVERSION_BODY);
    expect(provider.getLatestExecutionQuote(PAIR).state).toBe('AVAILABLE');
    expect(getTrustedPaperExecutionEvidence(provider, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'PROVIDER_NOT_PRODUCTION_ACQUIRED' });
  });

  it('§18.11 a Proxy over a genuine production provider, a subclass, and a structural look-alike are all rejected', async () => {
    const genuine = productionAcquiredProvider();
    await feedApproved(genuine);
    expect(getTrustedPaperExecutionEvidence(genuine, PAIR).state).toBe('AVAILABLE');

    // A Proxy forwards `instanceof`, but is a distinct object identity.
    const proxied = new Proxy(genuine, {}) as CoinDcxPaperEvidence;
    expect(proxied instanceof CoinDcxPaperEvidence).toBe(true);
    expect(getTrustedPaperExecutionEvidence(proxied, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'UNTRUSTED_EVIDENCE_PROVIDER' });

    class ForgedProvider extends CoinDcxPaperEvidence {
      public override readProductionAcquiredExecutionEvidence(): never {
        throw new Error('a subclass override must never be reached by the production adapter');
      }
    }
    const forged = new ForgedProvider({ instruments: INSTRUMENTS, socketFactory: new FakeCoinDcxSocketFactory(), policy: EVIDENCE_POLICY });
    expect(getTrustedPaperExecutionEvidence(forged, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'UNTRUSTED_EVIDENCE_PROVIDER' });

    const real = genuine.readProductionAcquiredExecutionEvidence(PAIR);
    const structural = {
      orderbookGenerationId: 1,
      readProductionAcquiredExecutionEvidence: () => real,
      conversionLocalPollFreshnessMs: 321,
    } as unknown as CoinDcxPaperEvidence;
    expect(getTrustedPaperExecutionEvidence(structural, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'UNTRUSTED_EVIDENCE_PROVIDER' });
    expect(getTrustedPaperExecutionEvidence(Object.create(CoinDcxPaperEvidence.prototype) as CoinDcxPaperEvidence, PAIR))
      .toEqual({ state: 'UNAVAILABLE', reason: 'UNTRUSTED_EVIDENCE_PROVIDER' });
  });

  it('Astra reproducer: a publicly-constructed provider fed fabricated orderbook/conversion payloads mints NO production-usable trusted evidence', () => {
    const provider = callerFedProvider();
    feedManually(provider);

    // Every pre-existing P14-B gate still passes on this data.
    expect(provider.getLatestExecutionQuote(PAIR).state).toBe('AVAILABLE');
    expect(provider.getLatestConversion().state).toBe('AVAILABLE');

    expect(getTrustedPaperExecutionEvidence(provider, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'PROVIDER_NOT_PRODUCTION_ACQUIRED' });
  });

  it('an own-property shadow installed on a genuine provider cannot substitute its reader or any getter it uses', async () => {
    const provider = productionAcquiredProvider();
    await feedApproved(provider);
    const shadow = { value: () => { throw new Error('an instance shadow must never be reached by the production adapter'); }, configurable: true };
    Object.defineProperty(provider, 'readProductionAcquiredExecutionEvidence', shadow);
    Object.defineProperty(provider, 'getLatestExecutionQuote', shadow);
    Object.defineProperty(provider, 'getLatestConversion', shadow);
    Object.defineProperty(provider, 'getLatestOrderbookEvidence', shadow);
    Object.defineProperty(provider, 'ingestOrderbookWebSocket', shadow);
    Object.defineProperty(provider, 'ingestConversionRest', shadow);
    expect(getTrustedPaperExecutionEvidence(provider, PAIR).state).toBe('AVAILABLE');
  });

  it('a caller-supplied conversion alone poisons an otherwise production-acquired bundle (every constituent datum must be approved)', () => {
    const provider = productionAcquiredProvider();
    acquireOrderbookOverWebSocket(provider, interception, BOOK_FRAME);
    expect(provider.ingestConversionRest(CONVERSION_BODY)).toMatchObject({ accepted: true });
    expect(getTrustedPaperExecutionEvidence(provider, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'EVIDENCE_NOT_PRODUCTION_ACQUIRED' });
  });

  // [F14-02 §18.16 / §13] Every frozen P14-B rule still fires, ahead of provenance.
  it('every pre-existing P14-B staleness/generation gate still fires ahead of the provenance gate', async () => {
    const wrongGeneration = productionAcquiredProvider();
    const generation = wrongGeneration.startOrderbookWebSocket();
    expect(wrongGeneration.ingestOrderbookWebSocket(BOOK_FRAME, generation + 1)).toMatchObject({ accepted: false, reason: 'OLD_GENERATION' });
    expect(getTrustedPaperExecutionEvidence(wrongGeneration, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'NO_CURRENT_GENERATION_WEBSOCKET_ORDERBOOK' });

    const stale = productionAcquiredProvider();
    await feedApproved(stale);
    expect(getTrustedPaperExecutionEvidence(stale, PAIR).state).toBe('AVAILABLE');
    setNow(NOW + EVIDENCE_POLICY.orderbookFreshnessMs + 1);
    expect(getTrustedPaperExecutionEvidence(stale, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'ORDERBOOK_STALE_OR_CLOCK_FAULT' });

    // Clock regression is still a fault, not a fresh read.
    setNow(NOW - 1);
    expect(getTrustedPaperExecutionEvidence(stale, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'ORDERBOOK_STALE_OR_CLOCK_FAULT' });
  });

  it('REST bootstrap evidence still cannot make a generation actionable, on a production provider or any other', async () => {
    const provider = productionAcquiredProvider();
    provider.startOrderbookWebSocket();
    interception.setRestResponse('FUTURES_ORDERBOOK', {
      type: 'depth-snapshot', pr: 'futures', s: 'BTCUSDT', ts: String(NOW), vs: '1', bids: [['100', '2']], asks: [['101', '3']],
    });
    // The genuine REST bootstrap acquisition path, not a manual ingest.
    expect(await provider.readOrderbookBootstrap(PAIR)).toMatchObject({ accepted: true });
    await acquireConversionOverRest(provider, interception, CONVERSION_BODY);
    expect(getTrustedPaperExecutionEvidence(provider, PAIR)).toEqual({ state: 'UNAVAILABLE', reason: 'NO_CURRENT_GENERATION_WEBSOCKET_ORDERBOOK' });
  });

  it('the public CoinDCX barrel exposes neither an acquisition capability nor the fake socket helpers', async () => {
    const barrel = await import('../../../src/integration/coindcx') as Record<string, unknown>;
    expect(barrel['PRODUCTION_ACQUISITION_CAPABILITY']).toBeUndefined();
    expect(barrel['FakeCoinDcxSocket']).toBeUndefined();
    expect(barrel['FakeCoinDcxSocketFactory']).toBeUndefined();
    expect(barrel['ProductionCoinDcxSocketFactory']).toBeDefined();
    expect(barrel['CoinDcxPaperEvidence']).toBeDefined();
    // The approved production mint IS reachable — it grants no injection point.
    expect(barrel['createProductionPaperEvidenceProvider']).toBeDefined();
  });

  it('§16 market acquisition authority and Wave3-A instrument authority stay disjoint', async () => {
    const provider = createProductionPaperEvidenceProvider({ instruments: INSTRUMENTS, policy: EVIDENCE_POLICY });
    const { TrustedProductionInstrumentBinding } = await import('../../../src/integration/coindcx/instrument-authority');
    // A production evidence provider cannot pose as, or produce, an instrument binding.
    expect(TrustedProductionInstrumentBinding.read(provider)).toBeNull();
    expect((provider as unknown as Record<string, unknown>)['acquireProductionInstrumentBinding']).toBeUndefined();
  });
});

describe('F14-01 production-acquired mark-to-market valuation evidence', () => {
  it('returns fresh production-acquired marks for every requested OPEN pair plus the production conversion', async () => {
    const provider = productionAcquiredProvider();
    await feedApproved(provider);
    const generation = acquireMarkOverWebSocket(provider, interception, MARK_FRAME);

    const result = readProductionAcquiredPaperValuationEvidence(provider, [PAIR, PAIR_B]);
    expect(result.state).toBe('AVAILABLE');
    if (result.state !== 'AVAILABLE') return;
    expect([...result.snapshot.marksByPair.keys()]).toEqual([PAIR, PAIR_B]);
    expect(result.snapshot.marksByPair.get(PAIR)?.markPrice).toBe('100');
    expect(result.snapshot.marksByPair.get(PAIR_B)?.markPrice).toBe('50');
    expect(result.snapshot.conversion.conversionPriceInrPerUsdt).toBe('83');
    expect(result.snapshot.markGenerationId).toBe(generation);
  });

  it('fails the whole account valuation when any requested OPEN pair lacks a current-generation fresh mark', async () => {
    const provider = productionAcquiredProvider();
    await feedApproved(provider);
    const btcOnly = { data: JSON.stringify({ ts: String(NOW), vs: '1', BTCUSDT: { mp: '100', bmST: String(NOW) } }) };
    acquireMarkOverWebSocket(provider, interception, btcOnly);

    expect(readProductionAcquiredPaperValuationEvidence(provider, [PAIR, PAIR_B]))
      .toEqual({ state: 'UNAVAILABLE', reason: `NO_CURRENT_GENERATION_WEBSOCKET_MARK:${PAIR_B}` });
  });

  it('rejects a caller-fed mark even when conversion and every ordinary freshness/generation check pass', async () => {
    const provider = productionAcquiredProvider();
    await feedApproved(provider);
    const generation = provider.startMarkWebSocket();
    expect(provider.ingestMarkWebSocket(MARK_FRAME, generation)).toMatchObject({ accepted: true });
    expect(provider.getLatestMark(PAIR).state).toBe('AVAILABLE');

    expect(readProductionAcquiredPaperValuationEvidence(provider, [PAIR]))
      .toEqual({ state: 'UNAVAILABLE', reason: `EVIDENCE_NOT_PRODUCTION_ACQUIRED:${PAIR}` });
  });

  it('rejects a caller-fed conversion even when every requested mark is production-acquired and fresh', () => {
    const provider = productionAcquiredProvider();
    expect(provider.ingestConversionRest(CONVERSION_BODY)).toMatchObject({ accepted: true });
    acquireMarkOverWebSocket(provider, interception, MARK_FRAME);

    expect(readProductionAcquiredPaperValuationEvidence(provider, [PAIR, PAIR_B]))
      .toEqual({ state: 'UNAVAILABLE', reason: 'EVIDENCE_NOT_PRODUCTION_ACQUIRED' });
  });

  it('rejects stale marks and stale conversion evidence through their existing frozen freshness gates', async () => {
    const provider = productionAcquiredProvider();
    await acquireConversionOverRest(provider, interception, CONVERSION_BODY);
    acquireMarkOverWebSocket(provider, interception, MARK_FRAME);

    setNow(NOW + EVIDENCE_POLICY.markFreshnessMs + 1);
    expect(readProductionAcquiredPaperValuationEvidence(provider, [PAIR]))
      .toEqual({ state: 'UNAVAILABLE', reason: `MARK_STALE_OR_CLOCK_FAULT:${PAIR}` });

    // Refresh marks at the new time, then advance beyond only the longer
    // conversion local-poll window: conversion must independently fail.
    const refreshedMark = { data: JSON.stringify({ ts: String(currentNow), vs: '2', BTCUSDT: { mp: '101', bmST: String(currentNow) } }) };
    acquireMarkOverWebSocket(provider, interception, refreshedMark);
    setNow(NOW + EVIDENCE_POLICY.conversionLocalPollFreshnessMs + 1);
    expect(readProductionAcquiredPaperValuationEvidence(provider, [PAIR]))
      .toEqual({ state: 'UNAVAILABLE', reason: 'CONVERSION_LOCAL_POLL_STALE_OR_CLOCK_FAULT' });
  });
});
