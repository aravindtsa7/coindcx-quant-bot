/**
 * [F14-01] The frozen §12.4/§12.5 durable risk-state rules, in isolation.
 *
 * These pin the semantics recovered from `docs/RISK_LEVERAGE_ENGINE.md` before
 * any of them reached the database, so a later refactor cannot quietly drift
 * the definition of "a loss", "first reach", or "high-water mark".
 */
import { describe, expect, it } from 'vitest';
import { paperDecimal } from '../../../../src/execution/decimal';
import {
  advancesPeak, nextLossState, nextPeakEquityInr, replayLossState,
  type PaperLossState, type PaperLossStatePolicy,
} from '../../../../src/execution/persistence/durable-risk-state';

/** Astra's exact configuration. */
const POLICY: PaperLossStatePolicy = { consecutiveLossLimit: 3, cooldownMs: 60_000 };
const NONE: PaperLossStatePolicy = { consecutiveLossLimit: null, cooldownMs: null };
const ZERO: PaperLossState = { consecutiveLossCount: 0, cooldownActiveUntilMs: null };
const T0 = 1_700_000_000_000;

function loss(current: PaperLossState, amountInr: string, closeTimeMs: number, policy = POLICY): PaperLossState {
  return nextLossState({ current, realizedPnlInr: paperDecimal(amountInr), closeTimeMs, policy });
}

describe('F14-01 §12.5 consecutive loss and cooldown', () => {
  it('increments the streak on each realized loss and arms cooldown exactly at the configured limit', () => {
    // §33.1/§33.2/§33.3 — and Astra's exact three realized losses.
    const first = loss(ZERO, '-1100', T0);
    expect(first).toEqual({ consecutiveLossCount: 1, cooldownActiveUntilMs: null });

    const second = loss(first, '-1087.68', T0 + 1_000);
    expect(second).toEqual({ consecutiveLossCount: 2, cooldownActiveUntilMs: null });

    const third = loss(second, '-1075.36', T0 + 2_000);
    expect(third).toEqual({ consecutiveLossCount: 3, cooldownActiveUntilMs: T0 + 2_000 + 60_000 });
  });

  it('a profit resets the streak to zero', () => {
    const streak = loss(loss(ZERO, '-10', T0), '-10', T0 + 1);
    expect(streak.consecutiveLossCount).toBe(2);
    expect(loss(streak, '0.00000000000000001', T0 + 2).consecutiveLossCount).toBe(0);
  });

  it('breakeven clears the streak rather than leaving it untouched', () => {
    // §12.5 is explicit: realized PnL >= 0 resets; breakeven is not a loss and
    // does not preserve the streak either.
    const streak = loss(loss(ZERO, '-10', T0), '-10', T0 + 1);
    expect(loss(streak, '0', T0 + 2).consecutiveLossCount).toBe(0);
  });

  it('arms the cooldown only on FIRST reach — a further loss never re-arms or extends it', () => {
    const armed = loss(loss(loss(ZERO, '-1', T0), '-1', T0 + 1), '-1', T0 + 2);
    expect(armed.cooldownActiveUntilMs).toBe(T0 + 2 + 60_000);

    const fourth = loss(armed, '-1', T0 + 30_000);
    expect(fourth.consecutiveLossCount).toBe(4);
    expect(fourth.cooldownActiveUntilMs, 'the boundary must not move outward').toBe(T0 + 2 + 60_000);
  });

  it('tracks the streak but arms no cooldown when no limit is configured', () => {
    const streak = loss(loss(loss(ZERO, '-1', T0), '-1', T0 + 1), '-1', T0 + 2, NONE);
    expect(streak).toEqual({ consecutiveLossCount: 3, cooldownActiveUntilMs: null });
  });

  it('a reset leaves an existing cooldown timestamp untouched, and the §12.5 gate needs both', () => {
    const armed = loss(loss(loss(ZERO, '-1', T0), '-1', T0 + 1), '-1', T0 + 2);
    const afterProfit = loss(armed, '500', T0 + 3);
    // §12.5 specifies a reset of the COUNT. The gate requires count >= limit
    // AND now < cooldownUntil, so a zeroed count cannot block regardless, and
    // leaving the timestamp keeps the durable value exactly replayable.
    expect(afterProfit.consecutiveLossCount).toBe(0);
    expect(afterProfit.cooldownActiveUntilMs).toBe(T0 + 2 + 60_000);
  });

  it('replays an entire close history deterministically', () => {
    const closes = [
      { realizedPnlInr: '-1100', closeTimeMs: T0 },
      { realizedPnlInr: '-1087.68', closeTimeMs: T0 + 1_000 },
      { realizedPnlInr: '-1075.36', closeTimeMs: T0 + 2_000 },
    ];
    expect(replayLossState(closes, POLICY)).toEqual({ consecutiveLossCount: 3, cooldownActiveUntilMs: T0 + 62_000 });
    // Same inputs, same answer, every time — no ambient state, no clock.
    expect(replayLossState(closes, POLICY)).toEqual(replayLossState(closes, POLICY));
    expect(replayLossState([...closes, { realizedPnlInr: '5', closeTimeMs: T0 + 3_000 }], POLICY))
      .toEqual({ consecutiveLossCount: 0, cooldownActiveUntilMs: T0 + 62_000 });
  });

  it('uses exact Decimal sign, never a float epsilon', () => {
    const tiny = '-0.000000000000000001';
    expect(loss(ZERO, tiny, T0).consecutiveLossCount).toBe(1);
    expect(loss(ZERO, '0.000000000000000001', T0).consecutiveLossCount).toBe(0);
  });
});

describe('F14-01 §12.4 peak equity high-water mark', () => {
  it('advances only on a strictly higher observation', () => {
    expect(advancesPeak(paperDecimal('100000'), paperDecimal('100990'))).toBe(true);
    expect(advancesPeak(paperDecimal('100000'), paperDecimal('100000'))).toBe(false);
    expect(advancesPeak(paperDecimal('100000'), paperDecimal('99999.999999999999999999'))).toBe(false);
  });

  it('never lowers the mark, for any observation', () => {
    const peak = paperDecimal('100990');
    for (const observed of ['90000', '0', '-5000', '100989.999999999999999999']) {
      expect(nextPeakEquityInr(peak, paperDecimal(observed)).toFixed()).toBe('100990');
    }
  });

  it('carries Astra-reported observations to the exact high-water mark', () => {
    // Realized post-close cash, then a higher MTM equity.
    const afterClose = nextPeakEquityInr(paperDecimal('100000'), paperDecimal('100879.10'));
    expect(afterClose.toFixed()).toBe('100879.1');
    const afterMtm = nextPeakEquityInr(afterClose, paperDecimal('100990'));
    expect(afterMtm.toFixed()).toBe('100990');
    // A later decline leaves the mark exactly where it was.
    expect(nextPeakEquityInr(afterMtm, paperDecimal('90000')).toFixed()).toBe('100990');
  });
});
