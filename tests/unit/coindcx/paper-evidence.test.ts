import { describe, expect, it } from 'vitest';
import { parse as parseLosslessJson } from 'lossless-json';
import { FakeClock } from '../../../src/integration/coindcx/clock';
import { CoinDcxTransport } from '../../../src/integration/coindcx/transport';
import {
  CoinDcxPaperEvidence,
  P14_B_ORDERBOOK_DEPTH,
  type PaperEvidenceInstrument,
} from '../../../src/integration/coindcx/paper-evidence';
import { FakeCoinDcxSocketFactory } from '../../../src/integration/coindcx/websocket/socket-adapter';

const NOW = 1_700_000_000_000;
const INSTRUMENTS: readonly PaperEvidenceInstrument[] = Object.freeze([
  Object.freeze({ pair: 'B-BTC_USDT', underlying: 'BTC', quoteCurrency: 'USDT', instrumentSpecSnapshotId: 'btc-spec-v1' }),
  Object.freeze({ pair: 'B-ETH_USDT', underlying: 'ETH', quoteCurrency: 'USDT', instrumentSpecSnapshotId: 'eth-spec-v1' }),
]);

function setup(policy = { orderbookFreshnessMs: 100, markFreshnessMs: 100, conversionLocalPollFreshnessMs: 100, allowedProviderFutureSkewMs: 10 }) {
  const clock = new FakeClock(NOW);
  const socketFactory = new FakeCoinDcxSocketFactory();
  const evidence = new CoinDcxPaperEvidence({
    instruments: INSTRUMENTS,
    clock,
    socketFactory,
    policy,
  });
  return { clock, socketFactory, evidence };
}

function losslessJson(text: string): unknown { return parseLosslessJson(text); }

function responseTransport(data: unknown): CoinDcxTransport {
  return {
    executeRead: async () => ({ status: 200, headers: {}, data, durationMs: 0 }),
  } as unknown as CoinDcxTransport;
}

function book(symbol = 'BTCUSDT', version = '1', ts = String(NOW), bids: unknown = [['100.000000000000000001', '2.500000000000000001'], ['99', '1']], asks: unknown = [['101', '3'], ['102', '1']]) {
  return { event: 'depth-snapshot', data: JSON.stringify({ type: 'depth-snapshot', pr: 'futures', s: symbol, ts, vs: version, bids, asks }) };
}

function marks(entries: Record<string, unknown>) {
  return { event: 'currentPrices@futures#update', data: JSON.stringify({ ts: String(NOW), vs: '9', ...entries }) };
}

describe('P14-B CoinDCX orderbook evidence', () => {
  it('uses lossless JSON string payloads, canonical mapping, correct extrema and side-neutral quote quantity', () => {
    const { evidence, socketFactory } = setup();
    evidence.startOrderbookWebSocket();
    expect(socketFactory.latestSocket?.emitted).toContainEqual({ event: 'join', args: [{ channelName: `B-BTC_USDT@orderbook@${P14_B_ORDERBOOK_DEPTH}-futures` }] });
    expect(evidence.ingestOrderbookWebSocket(book())).toEqual({ accepted: true, idempotent: false });
    const internal = evidence.getLatestOrderbookEvidence('B-BTC_USDT');
    expect(internal.state).toBe('AVAILABLE');
    if (internal.state === 'AVAILABLE') {
      expect(internal.snapshot.bestBid).toBe('100.000000000000000001');
      expect(internal.snapshot.bestBidQuantity).toBe('2.500000000000000001');
      expect(internal.snapshot.bestAsk).toBe('101');
      expect(internal.snapshot.bestAskQuantity).toBe('3');
      expect(Object.isFrozen(internal.snapshot)).toBe(true);
    }
    const quote = evidence.getLatestExecutionQuote('B-BTC_USDT');
    expect(quote.state).toBe('AVAILABLE');
    if (quote.state === 'AVAILABLE') expect(quote.snapshot.availableExecutableQuantity).toBeNull();
  });

  it('fails closed for symbols, product, subscription mismatch, empty/zero/crossed books and malformed wrappers', () => {
    const { evidence } = setup();
    evidence.startOrderbookWebSocket();
    expect(evidence.ingestOrderbookWebSocket(book('DOGEUSDT'))).toMatchObject({ accepted: false });
    expect(evidence.ingestOrderbookWebSocket({ data: JSON.stringify({ type: 'depth-snapshot', pr: 'spot', s: 'BTCUSDT', ts: String(NOW), vs: '1', bids: [['1', '1']], asks: [['2', '1']] }) })).toMatchObject({ accepted: false });
    expect(evidence.ingestOrderbookWebSocket(book('ETHUSDT'), undefined, 'B-BTC_USDT')).toMatchObject({ accepted: false });
    expect(evidence.ingestOrderbookWebSocket(book('BTCUSDT', '1', String(NOW), [], [['2', '1']]))).toMatchObject({ accepted: false });
    expect(evidence.ingestOrderbookWebSocket(book('BTCUSDT', '1', String(NOW), [['2', '1']], [['2', '1']]))).toMatchObject({ accepted: false });
    expect(evidence.ingestOrderbookWebSocket({ data: '{bad' })).toMatchObject({ accepted: false });
  });

  it('enforces orderbook version consistency, generation isolation, freshness and REST non-actionability', () => {
    const { evidence, clock } = setup();
    const first = evidence.startOrderbookWebSocket();
    expect(evidence.ingestOrderbookWebSocket(book(), first)).toMatchObject({ accepted: true });
    expect(evidence.ingestOrderbookWebSocket(book(), first)).toEqual({ accepted: true, idempotent: true });
    expect(evidence.ingestOrderbookWebSocket(book('BTCUSDT', '1', String(NOW), [['99', '1']], [['101', '1']]), first)).toMatchObject({ accepted: false });
    expect(evidence.ingestOrderbookRest('B-BTC_USDT', book())).toMatchObject({ accepted: true });
    expect(evidence.getLatestExecutionQuote('B-BTC_USDT').state).toBe('UNAVAILABLE');
    const second = evidence.reconnectOrderbookWebSocket();
    expect(evidence.ingestOrderbookWebSocket(book('BTCUSDT', '2'), first)).toEqual({ accepted: false, reason: 'OLD_GENERATION' });
    expect(evidence.getLatestExecutionQuote('B-BTC_USDT').state).toBe('UNAVAILABLE');
    expect(evidence.ingestOrderbookWebSocket(book('BTCUSDT', '1'), second)).toMatchObject({ accepted: true });
    clock.advance(101);
    expect(evidence.getLatestExecutionQuote('B-BTC_USDT').state).toBe('UNAVAILABLE');
  });

  it('rejects future-skew, lower-version, locked/crossed and zeroed REST evidence without any candle or LTP fallback', () => {
    const { evidence } = setup();
    const generation = evidence.startOrderbookWebSocket();
    expect(evidence.ingestOrderbookWebSocket(book('BTCUSDT', '2'), generation)).toMatchObject({ accepted: true });
    expect(evidence.ingestOrderbookWebSocket(book('BTCUSDT', '1'), generation)).toEqual({ accepted: false, reason: 'OUT_OF_ORDER_ORDERBOOK_VERSION' });
    expect(evidence.ingestOrderbookWebSocket(book('BTCUSDT', '3', String(NOW + 11)), generation)).toEqual({ accepted: false, reason: 'INVALID_EVENT_TIME' });
    expect(evidence.ingestOrderbookRest('B-BTC_USDT', book('BTCUSDT', '3', String(NOW), { '0': '0' }, { '1': '0' }))).toMatchObject({ accepted: false });
    // The only quote entrypoint consumes validated depth evidence; candles/LTP have no input surface here.
    expect(evidence.getLatestExecutionQuote('B-BTC_USDT').state).toBe('AVAILABLE');
  });

  it('fails closed when the read-time local clock regresses below the orderbook observation time', () => {
    const { evidence, clock } = setup({ orderbookFreshnessMs: 1_000, markFreshnessMs: 1_000, conversionLocalPollFreshnessMs: 1_000, allowedProviderFutureSkewMs: 1_000 });
    clock.setTime(NOW + 1_000);
    evidence.startOrderbookWebSocket();
    expect(evidence.ingestOrderbookWebSocket(book('BTCUSDT', '1', String(NOW + 500)))).toMatchObject({ accepted: true });
    clock.setTime(NOW + 800);
    expect(evidence.getLatestExecutionQuote('B-BTC_USDT')).toEqual({ state: 'UNAVAILABLE', reason: 'ORDERBOOK_STALE_OR_CLOCK_FAULT' });
    expect(evidence.getLatestOrderbookEvidence('B-BTC_USDT').state).toBe('AVAILABLE');
  });
});

describe('P14-B CoinDCX mark evidence', () => {
  it('uses only mp and bmST; ticker-only updates do not refresh independent pair mark state', () => {
    const { evidence, clock } = setup();
    evidence.startMarkWebSocket();
    expect(evidence.ingestMarkWebSocket(marks({ BTCUSDT: { mp: '100.000000000000000001', bmST: String(NOW), ls: '90' }, ETHUSDT: { mp: '50', bmST: String(NOW) } }))).toMatchObject({ accepted: true });
    const btc = evidence.getLatestMark('B-BTC_USDT');
    expect(btc.state).toBe('AVAILABLE');
    if (btc.state === 'AVAILABLE') expect(btc.snapshot.markPrice).toBe('100.000000000000000001');
    clock.advance(101);
    expect(evidence.ingestMarkWebSocket(marks({ BTCUSDT: { ls: '200', cmRT: '1', pST: '2' }, ETHUSDT: { mp: '51', bmST: String(NOW + 101) } }))).toMatchObject({ accepted: true });
    expect(evidence.getLatestMark('B-BTC_USDT').state).toBe('UNAVAILABLE');
    expect(evidence.getLatestMark('B-ETH_USDT').state).toBe('AVAILABLE');
  });

  it('requires a fresh current-generation mp bearing update and detects deterministic conflict', () => {
    const { evidence } = setup();
    const one = evidence.startMarkWebSocket();
    expect(evidence.ingestMarkWebSocket(marks({ BTCUSDT: { mp: '100', bmST: String(NOW) } }), one)).toMatchObject({ accepted: true });
    const hash = evidence.getLatestMark('B-BTC_USDT');
    const two = evidence.reconnectMarkWebSocket();
    expect(evidence.ingestMarkWebSocket(marks({ BTCUSDT: { mp: '101', bmST: String(NOW) } }), one)).toEqual({ accepted: false, reason: 'OLD_GENERATION' });
    expect(evidence.getLatestMark('B-BTC_USDT').state).toBe('UNAVAILABLE');
    expect(evidence.ingestMarkWebSocket(marks({ BTCUSDT: { mp: '100', bmST: String(NOW) } }), two)).toMatchObject({ accepted: true });
    const fresh = evidence.getLatestMark('B-BTC_USDT');
    if (hash.state === 'AVAILABLE' && fresh.state === 'AVAILABLE') expect(fresh.snapshot.contentSha256).toBe(hash.snapshot.contentSha256);
    expect(evidence.ingestMarkWebSocket(marks({ BTCUSDT: { mp: '101', bmST: String(NOW) } }), two)).toEqual({ accepted: false, reason: 'CONFLICTING_MARK_EVENT' });
  });

  it('rejects missing/invalid/future mark evidence and cannot turn REST evidence into a mark snapshot', () => {
    const { evidence } = setup();
    evidence.startMarkWebSocket();
    expect(evidence.ingestMarkWebSocket(marks({ BTCUSDT: { mp: '0', bmST: String(NOW) } }))).toMatchObject({ accepted: false });
    expect(evidence.ingestMarkWebSocket(marks({ BTCUSDT: { mp: '100' } }))).toMatchObject({ accepted: false });
    expect(evidence.ingestMarkWebSocket(marks({ BTCUSDT: { mp: '100', bmST: String(NOW + 11) } }))).toMatchObject({ accepted: false });
    expect(evidence.ingestMarkRest(marks({ BTCUSDT: { mp: '100', bmST: String(NOW) } }))).toMatchObject({ accepted: true });
    expect(evidence.getLatestMark('B-BTC_USDT')).toEqual({ state: 'UNAVAILABLE', reason: 'NO_CURRENT_GENERATION_WEBSOCKET_MARK' });
  });

  it('fails closed when the read-time local clock regresses below the mark observation time', () => {
    const { evidence, clock } = setup({ orderbookFreshnessMs: 1_000, markFreshnessMs: 1_000, conversionLocalPollFreshnessMs: 1_000, allowedProviderFutureSkewMs: 1_000 });
    clock.setTime(NOW + 1_000);
    evidence.startMarkWebSocket();
    expect(evidence.ingestMarkWebSocket(marks({ BTCUSDT: { mp: '2489.266122690000000001', bmST: String(NOW + 500) } }))).toMatchObject({ accepted: true });
    clock.setTime(NOW + 800);
    expect(evidence.getLatestMark('B-BTC_USDT')).toEqual({ state: 'UNAVAILABLE', reason: 'MARK_STALE_OR_CLOCK_FAULT' });
  });
});

describe('P14-B CoinDCX conversion evidence', () => {
  it('selects exactly USDTINR INR-to-USDT record, retains precision, and ages by local successful poll not provider timestamp', () => {
    const { evidence, clock } = setup();
    const body = [{ symbol: 'USDTINR', margin_currency_short_name: 'INR', target_currency_short_name: 'USDT', conversion_price: '83.123456789123456789', last_updated_at: '1' }];
    expect(evidence.ingestConversionRest(body)).toEqual({ accepted: true, idempotent: false });
    const result = evidence.getLatestConversion();
    expect(result.state).toBe('AVAILABLE');
    if (result.state === 'AVAILABLE') expect(result.snapshot.conversionPriceInrPerUsdt).toBe('83.123456789123456789');
    clock.advance(101);
    expect(evidence.getLatestConversion().state).toBe('UNAVAILABLE');
    expect(evidence.ingestConversionRest(body)).toEqual({ accepted: true, idempotent: true });
    expect(evidence.getLatestConversion().state).toBe('AVAILABLE');
  });

  it('fails closed for no/duplicate/wrong/invalid or conflicting conversion records', () => {
    const { evidence } = setup();
    const record = { symbol: 'USDTINR', margin_currency_short_name: 'INR', target_currency_short_name: 'USDT', conversion_price: '83', last_updated_at: String(NOW) };
    expect(evidence.ingestConversionRest([])).toMatchObject({ accepted: false });
    expect(evidence.ingestConversionRest([record, record])).toMatchObject({ accepted: false });
    expect(evidence.ingestConversionRest([{ ...record, target_currency_short_name: 'BTC' }])).toMatchObject({ accepted: false });
    expect(evidence.ingestConversionRest([{ ...record, conversion_price: '0' }])).toMatchObject({ accepted: false });
    expect(evidence.ingestConversionRest([record])).toMatchObject({ accepted: true });
    expect(evidence.ingestConversionRest([{ ...record, conversion_price: '84' }])).toEqual({ accepted: false, reason: 'CONFLICTING_CONVERSION_EVENT' });
  });

  it('rejects malformed timestamps and provider timestamp regression without fabricating a replacement rate', () => {
    const { evidence } = setup();
    const record = { symbol: 'USDTINR', margin_currency_short_name: 'INR', target_currency_short_name: 'USDT', conversion_price: '83', last_updated_at: String(NOW) };
    expect(evidence.ingestConversionRest([{ ...record, last_updated_at: 'not-a-time' }])).toMatchObject({ accepted: false });
    expect(evidence.ingestConversionRest([record])).toMatchObject({ accepted: true });
    expect(evidence.ingestConversionRest([{ ...record, last_updated_at: String(NOW - 1) }])).toEqual({ accepted: false, reason: 'CONVERSION_TIMESTAMP_REGRESSION' });
    expect(evidence.getLatestConversion()).toEqual({ state: 'UNAVAILABLE', reason: 'CONVERSION_LOCAL_POLL_STALE_OR_CLOCK_FAULT' });
  });

  it('accepts actual lossless-json REST values end-to-end without making bootstrap evidence actionable', async () => {
    const conversionTransport = responseTransport(losslessJson('[{"symbol":"USDTINR","margin_currency_short_name":"INR","target_currency_short_name":"USDT","conversion_price":83.123456789123456789,"last_updated_at":1700000000000}]'));
    const orderbookTransport = responseTransport(losslessJson('{"type":"depth-snapshot","pr":"futures","s":"BTCUSDT","ts":1700000000000,"vs":9007199254740991,"bids":[[78629.123456789123456789,0.000000000000000001]],"asks":[[78630.123456789123456789,2.000000000000000001]]}'));
    const markTransport = responseTransport(losslessJson('{"ts":1700000000000,"vs":9007199254740991,"BTCUSDT":{"mp":2489.266122690000000001,"bmST":1700000000000}}'));
    const clock = new FakeClock(NOW);
    const evidence = new CoinDcxPaperEvidence({ instruments: INSTRUMENTS, clock, conversionTransport, orderbookRestTransport: orderbookTransport, markRestTransport: markTransport });
    expect(await evidence.readConversion()).toEqual({ accepted: true, idempotent: false });
    expect(evidence.getLatestConversion()).toMatchObject({ state: 'AVAILABLE', snapshot: { conversionPriceInrPerUsdt: '83.123456789123456789', providerEventTimeMs: NOW } });
    expect(await evidence.readOrderbookBootstrap('B-BTC_USDT')).toEqual({ accepted: true, idempotent: false });
    expect(evidence.getLatestOrderbookEvidence('B-BTC_USDT')).toMatchObject({ state: 'AVAILABLE', snapshot: { bestBid: '78629.123456789123456789', bestBidQuantity: '0.000000000000000001', bestAsk: '78630.123456789123456789', bestAskQuantity: '2.000000000000000001', providerVersion: Number.MAX_SAFE_INTEGER, sourceClassification: 'REST_BOOTSTRAP_RECOVERY' } });
    expect(evidence.getLatestExecutionQuote('B-BTC_USDT').state).toBe('UNAVAILABLE');
    expect(await evidence.readMarkBootstrap()).toEqual({ accepted: true, idempotent: true });
    expect(evidence.getLatestMark('B-BTC_USDT').state).toBe('UNAVAILABLE');

    const unsafeVersionEvidence = new CoinDcxPaperEvidence({
      instruments: INSTRUMENTS,
      clock,
      orderbookRestTransport: responseTransport(losslessJson('{"type":"depth-snapshot","pr":"futures","s":"BTCUSDT","ts":1700000000000,"vs":9007199254740992,"bids":[[1,1]],"asks":[[2,1]]}')),
    });
    // Unsafe LosslessNumber versions are rejected; they are never rounded into a colliding Number.
    expect(await unsafeVersionEvidence.readOrderbookBootstrap('B-BTC_USDT')).toMatchObject({ accepted: false });
  });
});
