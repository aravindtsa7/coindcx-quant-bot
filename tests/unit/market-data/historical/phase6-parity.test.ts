import { describe, expect, it } from 'vitest';
import { aggregateExactBucket } from '../../../../src/market-data/higher-timeframe/aggregate-exact-bucket';
import {
  BASE_START_MS,
  DEFAULT_TEST_PAIR,
  makeCanonicalRange,
} from './test-helpers';

describe('Phase 7 — Phase 6 Parity Evidence', () => {
  it('derives 2m, 5m, 15m, 60m higher timeframe candles from Phase 7 historical canonical 1m truth using aggregateExactBucket', () => {
    // Generate 60 canonical 1m candles representing Phase 7 historical truth (source: 'REST_HISTORICAL')
    const historicalConstituents = makeCanonicalRange(60, BASE_START_MS, DEFAULT_TEST_PAIR, {
      source: 'REST_HISTORICAL',
      open: '100.00',
      high: '110.00',
      low: '95.00',
      close: '105.00',
      volume: '1.00',
      quoteVolume: '100.00',
    });

    // 1. Derive 2m candle
    const candle2m = aggregateExactBucket(historicalConstituents.slice(0, 2), 2);
    expect(candle2m.pair).toBe(DEFAULT_TEST_PAIR);
    expect(candle2m.timeframeMinutes).toBe(2);
    expect(candle2m.openTimeMs).toBe(BASE_START_MS);
    expect(candle2m.closeTimeExclusiveMs).toBe(BASE_START_MS + 2 * 60_000);
    expect(candle2m.open.value).toBe('100.00');
    expect(candle2m.high.value).toBe('110.00');
    expect(candle2m.low.value).toBe('95.00');
    expect(candle2m.close.value).toBe('105.00');
    expect(candle2m.volume.value).toBe('2');
    expect(candle2m.quoteVolume?.value).toBe('200');

    // 2. Derive 5m candle
    const candle5m = aggregateExactBucket(historicalConstituents.slice(0, 5), 5);
    expect(candle5m.pair).toBe(DEFAULT_TEST_PAIR);
    expect(candle5m.timeframeMinutes).toBe(5);
    expect(candle5m.openTimeMs).toBe(BASE_START_MS);
    expect(candle5m.closeTimeExclusiveMs).toBe(BASE_START_MS + 5 * 60_000);
    expect(candle5m.volume.value).toBe('5');
    expect(candle5m.quoteVolume?.value).toBe('500');

    // 3. Derive 15m candle
    const candle15m = aggregateExactBucket(historicalConstituents.slice(0, 15), 15);
    expect(candle15m.pair).toBe(DEFAULT_TEST_PAIR);
    expect(candle15m.timeframeMinutes).toBe(15);
    expect(candle15m.openTimeMs).toBe(BASE_START_MS);
    expect(candle15m.closeTimeExclusiveMs).toBe(BASE_START_MS + 15 * 60_000);
    expect(candle15m.volume.value).toBe('15');
    expect(candle15m.quoteVolume?.value).toBe('1500');

    // 4. Derive 60m candle
    const candle60m = aggregateExactBucket(historicalConstituents.slice(0, 60), 60);
    expect(candle60m.pair).toBe(DEFAULT_TEST_PAIR);
    expect(candle60m.timeframeMinutes).toBe(60);
    expect(candle60m.openTimeMs).toBe(BASE_START_MS);
    expect(candle60m.closeTimeExclusiveMs).toBe(BASE_START_MS + 60 * 60_000);
    expect(candle60m.volume.value).toBe('60');
    expect(candle60m.quoteVolume?.value).toBe('6000');
  });

  it('proves constituent source/provenance (WS_FINALIZED vs REST_RECOVERY vs REST_HISTORICAL) does not alter derived market truth', () => {
    // 5 minutes of constituents with WS_FINALIZED
    const wsConstituents = makeCanonicalRange(5, BASE_START_MS, DEFAULT_TEST_PAIR, {
      source: 'WS_FINALIZED',
      open: '100.00',
      high: '110.00',
      low: '95.00',
      close: '105.00',
      volume: '2.00',
      quoteVolume: '200.00',
    });

    // Same 5 minutes of constituents with REST_RECOVERY
    const recConstituents = makeCanonicalRange(5, BASE_START_MS, DEFAULT_TEST_PAIR, {
      source: 'REST_RECOVERY',
      open: '100.00',
      high: '110.00',
      low: '95.00',
      close: '105.00',
      volume: '2.00',
      quoteVolume: '200.00',
    });

    // Same 5 minutes of constituents with REST_HISTORICAL
    const histConstituents = makeCanonicalRange(5, BASE_START_MS, DEFAULT_TEST_PAIR, {
      source: 'REST_HISTORICAL',
      open: '100.00',
      high: '110.00',
      low: '95.00',
      close: '105.00',
      volume: '2.00',
      quoteVolume: '200.00',
    });

    const derivedWs = aggregateExactBucket(wsConstituents, 5);
    const derivedRec = aggregateExactBucket(recConstituents, 5);
    const derivedHist = aggregateExactBucket(histConstituents, 5);

    expect(derivedWs.open.value).toBe(derivedRec.open.value);
    expect(derivedWs.high.value).toBe(derivedRec.high.value);
    expect(derivedWs.low.value).toBe(derivedRec.low.value);
    expect(derivedWs.close.value).toBe(derivedRec.close.value);
    expect(derivedWs.volume.value).toBe(derivedRec.volume.value);
    expect(derivedWs.quoteVolume?.value).toBe(derivedRec.quoteVolume?.value);

    expect(derivedHist.open.value).toBe(derivedWs.open.value);
    expect(derivedHist.high.value).toBe(derivedWs.high.value);
    expect(derivedHist.low.value).toBe(derivedWs.low.value);
    expect(derivedHist.close.value).toBe(derivedWs.close.value);
    expect(derivedHist.volume.value).toBe(derivedWs.volume.value);
    expect(derivedHist.quoteVolume?.value).toBe(derivedWs.quoteVolume?.value);
  });

  it('verifies 2m, 5m, 15m, 60m mathematical aggregation correctness with WS_FINALIZED constituents', () => {
    const wsConstituents = makeCanonicalRange(60, BASE_START_MS, DEFAULT_TEST_PAIR, {
      source: 'WS_FINALIZED',
      open: '100.00',
      high: '110.00',
      low: '95.00',
      close: '105.00',
      volume: '1.00',
      quoteVolume: '100.00',
    });

    const candle2m = aggregateExactBucket(wsConstituents.slice(0, 2), 2);
    expect(candle2m.pair).toBe(DEFAULT_TEST_PAIR);
    expect(candle2m.timeframeMinutes).toBe(2);
    expect(candle2m.openTimeMs).toBe(BASE_START_MS);
    expect(candle2m.closeTimeExclusiveMs).toBe(BASE_START_MS + 2 * 60_000);
    expect(candle2m.open.value).toBe('100.00');
    expect(candle2m.high.value).toBe('110.00');
    expect(candle2m.low.value).toBe('95.00');
    expect(candle2m.close.value).toBe('105.00');
    expect(candle2m.volume.value).toBe('2');
    expect(candle2m.quoteVolume?.value).toBe('200');

    const candle5m = aggregateExactBucket(wsConstituents.slice(0, 5), 5);
    expect(candle5m.pair).toBe(DEFAULT_TEST_PAIR);
    expect(candle5m.timeframeMinutes).toBe(5);
    expect(candle5m.openTimeMs).toBe(BASE_START_MS);
    expect(candle5m.closeTimeExclusiveMs).toBe(BASE_START_MS + 5 * 60_000);
    expect(candle5m.volume.value).toBe('5');
    expect(candle5m.quoteVolume?.value).toBe('500');

    const candle15m = aggregateExactBucket(wsConstituents.slice(0, 15), 15);
    expect(candle15m.pair).toBe(DEFAULT_TEST_PAIR);
    expect(candle15m.timeframeMinutes).toBe(15);
    expect(candle15m.openTimeMs).toBe(BASE_START_MS);
    expect(candle15m.closeTimeExclusiveMs).toBe(BASE_START_MS + 15 * 60_000);
    expect(candle15m.volume.value).toBe('15');
    expect(candle15m.quoteVolume?.value).toBe('1500');

    const candle60m = aggregateExactBucket(wsConstituents.slice(0, 60), 60);
    expect(candle60m.pair).toBe(DEFAULT_TEST_PAIR);
    expect(candle60m.timeframeMinutes).toBe(60);
    expect(candle60m.openTimeMs).toBe(BASE_START_MS);
    expect(candle60m.closeTimeExclusiveMs).toBe(BASE_START_MS + 60 * 60_000);
    expect(candle60m.volume.value).toBe('60');
    expect(candle60m.quoteVolume?.value).toBe('6000');
  });
});
