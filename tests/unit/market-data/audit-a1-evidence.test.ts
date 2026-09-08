import { afterEach, describe, expect, it } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { isPhase5Eligible } from '../../../src/market-data/higher-timeframe';
import { createCanonicalCandle1m } from '../../../src/market-data/models';
import { RestCandleRecord } from '../../../src/market-data/rest-candle-reader';
import { P, T, M, setup, update, payload, final, record, deferred, flushQueues } from './audit-a1-helpers';

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });
function context(now?: number) { const c = setup(now); stops.push(() => c.engine.stop()); return c; }

describe('Audit A1 temporal evidence, freshness and provenance', () => {
  it('A13: a future bucket with old Ets never finalizes a forming candle', async () => {
    const c = context(T + 1000); await c.engine.handleStreamEnvelope(update(T));
    await c.engine.handleStreamEnvelope(update(T + M, 1, { providerEventTimeMs: T + 1000 }));
    c.clock.advance(1000); c.scheduler.advanceTime(1000); await flushQueues();
    expect(c.repository.insertCalls).toHaveLength(0);
    expect(c.engine.getPairHealth(P)?.truthFault).toBe('TIME_INVALID');
  });

  it.each([59_999, 60_000])('successor provider offset %i is validated against its exact opening', async offset => {
    const c = context(T + M + 1000); await c.engine.handleStreamEnvelope(update(T));
    await c.engine.handleStreamEnvelope(update(T + M, 1, { providerEventTimeMs: T + offset }));
    c.scheduler.advanceTime(1000); await flushQueues();
    expect(c.repository.insertCalls).toHaveLength(offset === 60_000 ? 1 : 0);
    for (const row of c.repository.insertCalls) expect(row.finalizedAtMs).toBeGreaterThanOrEqual(row.closeTimeExclusiveMs);
  });

  it('event at the minute edge without a successor bucket is not closure evidence', async () => {
    const c = context(T + M); await c.engine.handleStreamEnvelope(update(T, 1, { providerEventTimeMs: T + 59_999 }));
    await c.engine.handleStreamEnvelope(update(T, 1, { providerEventTimeMs: T + M }));
    c.scheduler.advanceTime(5000); await flushQueues(); expect(c.repository.insertCalls).toHaveLength(0);
  });

  it('clock moving backward cannot persist finalizedAt before the close boundary', async () => {
    const c = context(T + M); await c.engine.handleStreamEnvelope(update(T));
    await c.engine.handleStreamEnvelope(update(T + M, 1, { providerEventTimeMs: T + M }));
    c.clock.setTime(T + 59_999); c.scheduler.advanceTime(1000); await flushQueues();
    expect(c.repository.insertCalls).toHaveLength(0);
    c.clock.setTime(T + M + 1000); c.scheduler.advanceTime(1000); await flushQueues();
    expect(c.repository.insertCalls).toHaveLength(1);
  });

  it('malformed duration or close boundary cannot become canonical evidence', async () => {
    for (const closeTimeMs of [T + M, T + 59_998, T + 120_000]) {
      const c = context(T + M); await c.engine.handleStreamEnvelope(update(T, 1, { closeTimeMs }));
      expect(c.engine.getPairHealth(P)?.truthFault).toBe('TIME_INVALID');
    }
    expect(() => createCanonicalCandle1m({ ...final(T), finalizedAtMs: T + 59_999 })).toThrow();
  });

  it('startup and no-evidence timeout remain ineligible', async () => {
    const c = context(T); await c.engine.initializePair(P);
    expect(c.engine.getPairHealth(P)?.state).toBe('STALE');
    expect(c.scheduler.activeTimerCount).toBe(1);
    c.clock.advance(120_000); c.scheduler.advanceTime(120_000);
    expect(isPhase5Eligible(c.engine.getPairHealth(P))).toBe(false);
  });

  it('A12: newly received ancient evidence does not restore health; fresh reconciled source does', async () => {
    const c = context(T + 1000); await c.engine.handleStreamEnvelope(update(T));
    c.clock.setTime(T + 10 * M + 1000); c.scheduler.advanceTime(10 * M);
    await c.engine.handleStreamEnvelope(update(T, 1, { providerEventTimeMs: T + 2000, close: new Decimal('101') }, 2));
    expect(c.engine.getPairHealth(P)?.state).toBe('STALE');
    expect(c.engine.getPairHealth(P)?.lastValidProviderEventTimeMs).toBe(T + 1000);
    c.rest.recordsToReturn = Array.from({ length: 10 }, (_, i) => record(T + i * M));
    await c.engine.handleStreamEnvelope(update(T + 10 * M));
    expect(isPhase5Eligible(c.engine.getPairHealth(P))).toBe(true);
  });

  it('future source cannot establish startup eligibility; fresh source can', async () => {
    const c = context(T + 1000); await c.engine.handleStreamEnvelope(update(T, 1, { providerEventTimeMs: T + 20_000 }));
    expect(isPhase5Eligible(c.engine.getPairHealth(P))).toBe(false);
    await c.engine.handleStreamEnvelope(update(T)); expect(isPhase5Eligible(c.engine.getPairHealth(P))).toBe(true);
  });

  it('staleness expires by source age even if a packet was received more recently', async () => {
    const c = context(T + 100_000); await c.engine.handleStreamEnvelope(update(T, 1, { providerEventTimeMs: T }));
    expect(isPhase5Eligible(c.engine.getPairHealth(P))).toBe(true);
    c.clock.advance(20_000); c.scheduler.advanceTime(20_000);
    expect(isPhase5Eligible(c.engine.getPairHealth(P))).toBe(false);
  });

  it.each([false, true])('REST final supersedes earlier forming WS; known WS quote=%s', async known => {
    const c = context(T + M + 1000); await c.repository.insertCandle(final(T));
    await c.engine.handleStreamEnvelope(update(T, 1, { quoteVolume: known ? new Decimal('1000') : null }));
    expect(c.engine.getPairHealth(P)?.truthFault).toBe('NONE');
    expect((await c.repository.getCandle(P, T))?.quoteVolume).toBeNull();
  });

  it('A17: buffered forming snapshot is discarded after authoritative REST recovery', async () => {
    const c = context(T + 2 * M); await c.engine.initializePair(P); const gate = deferred<RestCandleRecord[]>();
    c.rest.fetchClosedCandles = () => gate.promise;
    const recovery = c.engine.executeRecovery(P, T, T);
    await c.engine.handleStreamEnvelope(update(T, 1, { volume: new Decimal('1'), close: new Decimal('99') }));
    gate.resolve([record(T)]); await recovery;
    expect(c.engine.getPairHealth(P)?.truthFault).toBe('NONE');
    expect((await c.repository.getCandle(P, T))?.volume.value).toBe('10');
  });

  it('two authoritative known final values that disagree still fault', async () => {
    const c = context(T + 2 * M); await c.repository.insertCandle(final(T, { quoteVolume: '1000' }));
    await c.engine.initializePair(P); c.rest.recordsToReturn = [{ ...record(T), quoteVolume: new Decimal('1001') }];
    await c.engine.executeRecovery(P, T, T);
    expect(c.engine.getPairHealth(P)?.truthFault).toBe('CANONICAL_CONFLICT');
    expect((await c.repository.getCandle(P, T))?.quoteVolume?.value).toBe('1000');
  });

  it('duplicate identical REST finals are idempotent and unknown quote is compatible', async () => {
    const c = context(T + 2 * M); await c.repository.insertCandle(final(T, { quoteVolume: '1000' }));
    await c.engine.initializePair(P); c.rest.recordsToReturn = [record(T)];
    await c.engine.executeRecovery(P, T, T); await c.engine.executeRecovery(P, T, T);
    expect(c.engine.getPairHealth(P)?.truthFault).toBe('NONE'); expect(c.repository.insertCalls).toHaveLength(1);
  });

  it.each([false, true])('A14: reversed equal-time conflict gives the same fault without any close; buffered=%s', async buffered => {
    const outcomes: unknown[] = [];
    for (const values of [['100', '110'], ['110', '100']]) {
      const c = context(T + M + 1000); const sm = await c.engine.initializePair(P);
      if (buffered) sm.enterRecovery();
      for (const [i, close] of values.entries()) await c.engine.handleStreamEnvelope(update(T, 1, { providerEventTimeMs: T + 30_000, close: new Decimal(close) }, i + 1));
      await c.engine.handleStreamEnvelope(update(T + M)); c.scheduler.advanceTime(1000); await flushQueues();
      outcomes.push({ fault: c.engine.getPairHealth(P)?.truthFault, count: c.repository.insertCalls.length });
    }
    expect(outcomes).toEqual([{ fault: 'CANONICAL_CONFLICT', count: 0 }, { fault: 'CANONICAL_CONFLICT', count: 0 }]);
  });

  it('identical equal-time snapshots deduplicate despite different arrival metadata', async () => {
    const c = context(T + M + 1000); await c.engine.handleStreamEnvelope(update(T));
    await c.engine.handleStreamEnvelope(update(T, 1, {}, 99));
    expect(c.engine.getPairHealth(P)?.truthFault).toBe('NONE');
    expect(c.engine.getPairHealth(P)?.duplicateCount).toBe(1);
    await c.engine.handleStreamEnvelope(update(T + M)); c.scheduler.advanceTime(1000); await flushQueues();
    expect(c.repository.insertCalls).toHaveLength(1); expect(c.repository.insertCalls[0]?.volume.value).toBe(payload(T).volume.toFixed());
  });
});
