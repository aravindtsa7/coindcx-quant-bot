import { describe, expect, it } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { WorkingCandleManager } from '../../../src/market-data/working-candle';
import { createTestWorkingSnapshot } from './test-helpers';

describe('Phase 5 — Working Candle Semantics & Deterministic Tie-Breaking', () => {
  const PAIR = 'B-BTC_USDT';
  const MINUTE_0 = 1700000040000;

  it('1. first WS snapshot remains forming', () => {
    const manager = new WorkingCandleManager();
    expect(manager.getCurrent(PAIR)).toBeUndefined();
    expect(manager.getCurrentOpenTimeMs(PAIR)).toBeNull();

    const snapshot = createTestWorkingSnapshot({
      pair: PAIR,
      openTimeMs: MINUTE_0,
      closeTimeMs: MINUTE_0 + 59999,
    });

    const result = manager.update(snapshot);
    expect(result.applied).toBe(true);
    expect(result.reason).toBe('ACCEPTED');

    const current = manager.getCurrent(PAIR);
    expect(current).toBeDefined();
    expect(current?.openTimeMs).toBe(MINUTE_0);
    expect(manager.getCurrentOpenTimeMs(PAIR)).toBe(MINUTE_0);
  });

  it('2. same-minute newer snapshot replaces working snapshot', () => {
    const manager = new WorkingCandleManager();
    const initial = createTestWorkingSnapshot({
      pair: PAIR,
      openTimeMs: MINUTE_0,
      providerEventTimeMs: MINUTE_0 + 10000,
      sequence: 1,
      receivedAtMs: MINUTE_0 + 10100,
      close: new Decimal('50000.0'),
      volume: new Decimal('1.0'),
    });
    manager.update(initial);

    // Newer snapshot with higher providerEventTimeMs
    const newer = createTestWorkingSnapshot({
      pair: PAIR,
      openTimeMs: MINUTE_0,
      providerEventTimeMs: MINUTE_0 + 20000,
      sequence: 2,
      receivedAtMs: MINUTE_0 + 20100,
      close: new Decimal('50100.0'),
      volume: new Decimal('2.5'),
    });

    const result = manager.update(newer);
    expect(result.applied).toBe(true);
    expect(result.reason).toBe('ACCEPTED');
    expect(manager.getCurrent(PAIR)?.close.toString()).toBe('50100');
    expect(manager.getCurrent(PAIR)?.volume.toString()).toBe('2.5');

    // Newer snapshot with equal providerEventTimeMs but higher sequence tie-breaker
    const tieBreakSequence = createTestWorkingSnapshot({
      pair: PAIR,
      openTimeMs: MINUTE_0,
      providerEventTimeMs: MINUTE_0 + 20000,
      sequence: 3,
      receivedAtMs: MINUTE_0 + 20200,
      close: new Decimal('50150.0'),
      volume: new Decimal('3.0'),
    });
    const tieResult = manager.update(tieBreakSequence);
    expect(tieResult.applied).toBe(true);
    expect(tieResult.reason).toBe('ACCEPTED');
    expect(manager.getCurrent(PAIR)?.close.toString()).toBe('50150');

    // Newer snapshot with equal providerEventTimeMs and equal sequence, but higher receivedAtMs
    const tieBreakReceivedAt = createTestWorkingSnapshot({
      pair: PAIR,
      openTimeMs: MINUTE_0,
      providerEventTimeMs: MINUTE_0 + 20000,
      sequence: 3,
      receivedAtMs: MINUTE_0 + 20500,
      close: new Decimal('50200.0'),
      volume: new Decimal('3.5'),
    });
    const tieRecResult = manager.update(tieBreakReceivedAt);
    expect(tieRecResult.applied).toBe(true);
    expect(tieRecResult.reason).toBe('ACCEPTED');
    expect(manager.getCurrent(PAIR)?.close.toString()).toBe('50200');
  });

  it('3. same-minute volume is NOT summed', () => {
    const manager = new WorkingCandleManager();
    const update1 = createTestWorkingSnapshot({
      pair: PAIR,
      openTimeMs: MINUTE_0,
      providerEventTimeMs: MINUTE_0 + 10000,
      volume: new Decimal('10.0'),
      quoteVolume: new Decimal('500000.0'),
    });
    manager.update(update1);
    expect(manager.getCurrent(PAIR)?.volume.toString()).toBe('10');

    // Update 2 arrives with cumulative snapshot volume 15.0 (NOT an incremental trade of 15.0)
    const update2 = createTestWorkingSnapshot({
      pair: PAIR,
      openTimeMs: MINUTE_0,
      providerEventTimeMs: MINUTE_0 + 20000,
      volume: new Decimal('15.0'),
      quoteVolume: new Decimal('750000.0'),
    });
    manager.update(update2);

    // Volume must be strictly replaced by 15.0, NEVER summed to 25.0
    expect(manager.getCurrent(PAIR)?.volume.toString()).toBe('15');
    expect(manager.getCurrent(PAIR)?.quoteVolume?.toString()).toBe('750000');
    expect(manager.getCurrent(PAIR)?.volume.equals(new Decimal('25.0'))).toBe(false);
  });

  it('4. identical duplicate is idempotent', () => {
    const manager = new WorkingCandleManager();
    const snapshot = createTestWorkingSnapshot({
      pair: PAIR,
      openTimeMs: MINUTE_0,
      providerEventTimeMs: MINUTE_0 + 10000,
      sequence: 1,
      receivedAtMs: MINUTE_0 + 10100,
      open: new Decimal('50000.0'),
      high: new Decimal('50100.0'),
      low: new Decimal('49900.0'),
      close: new Decimal('50050.0'),
      volume: new Decimal('10.5'),
    });

    const first = manager.update(snapshot);
    expect(first.applied).toBe(true);
    expect(first.reason).toBe('ACCEPTED');

    // Re-send exactly identical snapshot
    const second = manager.update(snapshot);
    expect(second.applied).toBe(true);
    expect(second.reason).toBe('IDEMPOTENT_DUPLICATE');

    // Snapshot remains unchanged
    expect(manager.getCurrent(PAIR)?.close.toString()).toBe('50050');
    expect(manager.getCurrent(PAIR)?.providerEventTimeMs).toBe(MINUTE_0 + 10000);
  });

  it('5. older same-minute provider update cannot overwrite newer', () => {
    const manager = new WorkingCandleManager();
    const newer = createTestWorkingSnapshot({
      pair: PAIR,
      openTimeMs: MINUTE_0,
      providerEventTimeMs: MINUTE_0 + 30000,
      sequence: 5,
      receivedAtMs: MINUTE_0 + 30100,
      close: new Decimal('50300.0'),
    });
    manager.update(newer);

    // Older payload arriving late (lower providerEventTimeMs)
    const older = createTestWorkingSnapshot({
      pair: PAIR,
      openTimeMs: MINUTE_0,
      providerEventTimeMs: MINUTE_0 + 10000,
      sequence: 2,
      receivedAtMs: MINUTE_0 + 40000, // Arrived later locally, but providerEventTimeMs is older
      close: new Decimal('50100.0'),
    });

    const result = manager.update(older);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('SUPERSEDED');
    expect(manager.getCurrent(PAIR)?.close.toString()).toBe('50300');
  });

  it('36. Decimal exactness', () => {
    const manager = new WorkingCandleManager();
    // High-precision financial decimal that would lose precision with standard JS 64-bit IEEE-754 floats
    const preciseOpen = new Decimal('50000.123456789012345678');
    const preciseHigh = new Decimal('50100.987654321098765432');
    const preciseLow = new Decimal('49900.000000000000000001');
    const preciseClose = new Decimal('50050.555555555555555555');
    const preciseVol = new Decimal('0.000000000000000123');

    const snapshot = createTestWorkingSnapshot({
      pair: PAIR,
      openTimeMs: MINUTE_0,
      open: preciseOpen,
      high: preciseHigh,
      low: preciseLow,
      close: preciseClose,
      volume: preciseVol,
    });

    manager.update(snapshot);
    const snap = manager.getCurrent(PAIR)!;
    expect(snap.open.toString()).toBe('50000.123456789012345678');
    expect(snap.high.toString()).toBe('50100.987654321098765432');
    expect(snap.low.toString()).toBe('49900.000000000000000001');
    expect(snap.close.toString()).toBe('50050.555555555555555555');
    expect(snap.volume.toString()).toBe('0.000000000000000123');
  });
});
