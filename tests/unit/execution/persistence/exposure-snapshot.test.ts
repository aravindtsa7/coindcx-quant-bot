import { describe, expect, it } from 'vitest';
import { buildBaseExposureSnapshot } from '../../../../src/execution/persistence/account-repository';

describe('P14-D buildBaseExposureSnapshot — durable, non-pending exposure (V2 §11/§17, no network I/O)', () => {
  it('produces zero exposure for no open positions', () => {
    const snapshot = buildBaseExposureSnapshot('acc-1', [], 1_000);
    expect(snapshot.globalOpenNotionalInr).toBe('0');
    expect(snapshot.concurrentOpenPositions).toBe(0);
    expect(snapshot.pending).toEqual({ status: 'UNKNOWN' });
  });

  it('computes notional as quantity * averageEntryPriceInr per position, summed globally/per-pair/per-strategy', () => {
    const snapshot = buildBaseExposureSnapshot('acc-1', [
      { pair: 'B-BTC_USDT', strategyId: 'EMA_TREND', quantity: '2', averageEntryPriceInr: '100' },
      { pair: 'B-ETH_USDT', strategyId: 'EMA_TREND', quantity: '3', averageEntryPriceInr: '50' },
    ], 1_000);
    expect(snapshot.globalOpenNotionalInr).toBe('350');
    expect(snapshot.perPairOpenNotionalInr).toEqual({ 'B-BTC_USDT': '200', 'B-ETH_USDT': '150' });
    expect(snapshot.perStrategyOpenNotionalInr).toEqual({ EMA_TREND: '350' });
    expect(snapshot.concurrentOpenPositions).toBe(2);
  });

  it('aggregates multiple positions on the same pair correctly', () => {
    const snapshot = buildBaseExposureSnapshot('acc-1', [
      { pair: 'B-BTC_USDT', strategyId: 'A', quantity: '1', averageEntryPriceInr: '100' },
      { pair: 'B-BTC_USDT', strategyId: 'B', quantity: '1', averageEntryPriceInr: '200' },
    ], 1_000);
    expect(snapshot.perPairOpenNotionalInr['B-BTC_USDT']).toBe('300');
    expect(snapshot.perStrategyOpenNotionalInr).toEqual({ A: '100', B: '200' });
  });

  it('never fabricates a pending overlay — always UNKNOWN, left to the real C3 overlay mechanism', () => {
    const snapshot = buildBaseExposureSnapshot('acc-1', [{ pair: 'B-BTC_USDT', strategyId: 'A', quantity: '1', averageEntryPriceInr: '1' }], 1_000);
    expect(snapshot.pending).toEqual({ status: 'UNKNOWN' });
  });

  it('binds a deterministic provenance content hash for identical input', () => {
    const positions = [{ pair: 'B-BTC_USDT', strategyId: 'A', quantity: '1', averageEntryPriceInr: '100' }];
    const a = buildBaseExposureSnapshot('acc-1', positions, 1_000);
    const b = buildBaseExposureSnapshot('acc-1', positions, 2_000); // observedAtMs differs, content hash should not
    expect(a.provenance.contentSha256).toBe(b.provenance.contentSha256);
    expect(a.provenance.sourceId).toBe('PAPER_POSITION_PROJECTION_V1');
  });

  it('is frozen/immutable', () => {
    const snapshot = buildBaseExposureSnapshot('acc-1', [], 1_000);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});
