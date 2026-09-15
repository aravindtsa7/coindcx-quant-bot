/**
 * [F14-01] The durable risk-state rules, in one place.
 *
 * `docs/RISK_LEVERAGE_ENGINE.md` §12.5 assigns `consecutiveLossCount` and
 * `cooldownActiveUntilMs` to the `AccountRiskStateProvider` adapter: "Phase 13
 * only compares the supplied values against configured thresholds; it never
 * recomputes them from raw trades itself". §12.4 says the same of
 * `peakEquityInr` — "a running high-water mark maintained by the adapter since
 * account risk tracking inception; it never auto-resets".
 *
 * Phase14's durable paper account IS that adapter, and it was never
 * maintaining any of the three. Astra reproduced the consequence: three
 * realized losing CLOSE lifecycles against a configured limit of 3 left
 * `consecutiveLossCount = 0` and `cooldownActiveUntilMs = NULL`, and a fourth
 * OPEN filled; separately, equity rose above the starting capital while the
 * stored peak stayed at its inception value, so the drawdown gate measured
 * decline from the wrong high-water mark.
 *
 * This module implements the frozen rules verbatim and nothing else. It
 * invents no formula, no threshold and no timing source: every value it
 * returns is a pure function of facts P14-E has already computed durably.
 */
import { paperDecimal, type PaperCalc } from '../decimal';

/**
 * The two frozen `RiskModeConfig` knobs, carried into the persistence layer as
 * a plain value. `src/risk/policy.ts` validates them as all-or-nothing
 * ("consecutiveLossLimit and cooldownMs must be configured together"), so both
 * are null or both are set.
 */
export interface PaperLossStatePolicy {
  readonly consecutiveLossLimit: number | null;
  readonly cooldownMs: number | null;
}

/** The durable loss-streak state, exactly as `PaperAccount` stores it. */
export interface PaperLossState {
  readonly consecutiveLossCount: number;
  readonly cooldownActiveUntilMs: number | null;
}

export interface NextLossStateInputs {
  readonly current: PaperLossState;
  /**
   * §12.5 "a closed trade's realized PnL". The canonical value is the exact
   * gross realized trading PnL P14-E already computed for THIS close and
   * booked to `paper_fill.realizedPnlInr`, the `REALIZED_PNL` ledger entry and
   * `paper_position_ownership_history.realizedPnlInr` — never recomputed here
   * and never re-derived through a slightly different formula.
   *
   * Fees stay out of it on purpose: §12.1 keeps `realizedTradingPnlInr` and
   * `feesInr` as separate daily-PnL components, and `accounting.ts` documents
   * the account's `R` column as "cumulative booked gross realized trading
   * PnL". Funding is excluded in Phase14 and contributes nothing.
   */
  readonly realizedPnlInr: PaperCalc;
  /** §12.5 "thatTradeCloseTimeMs" — the closing trade's own provider event time. */
  readonly closeTimeMs: number;
  readonly policy: PaperLossStatePolicy;
}

/**
 * §12.5, verbatim:
 *
 *  - LOSS (realized PnL `< 0`): increments `consecutiveLossCount` by 1.
 *  - PROFIT or BREAKEVEN (realized PnL `≥ 0`): **resets** the count to 0 —
 *    breakeven clears the streak, it does not leave it untouched.
 *  - COOLDOWN START: the exact closing trade that causes the count to FIRST
 *    reach `consecutiveLossLimit` sets
 *    `cooldownActiveUntilMs = thatTradeCloseTimeMs + cooldownMs`.
 *
 * "First reach" is taken literally: a later loss while already at or above the
 * limit does not re-arm or extend the cooldown, so a duplicate or repeated
 * close can never silently push the boundary outward.
 *
 * A reset deliberately leaves `cooldownActiveUntilMs` as it stands. §12.5
 * specifies a reset of the count only, and the §12.5 gate requires BOTH
 * `consecutiveLossCount >= limit` AND `evaluationTimeMs < cooldownActiveUntilMs`
 * — so a count of 0 cannot block regardless, and not rewriting the timestamp
 * keeps the durable value exactly derivable from close history.
 */
export function nextLossState(inputs: NextLossStateInputs): PaperLossState {
  const { current, realizedPnlInr, closeTimeMs, policy } = inputs;

  if (!realizedPnlInr.isNegative()) {
    return Object.freeze({ consecutiveLossCount: 0, cooldownActiveUntilMs: current.cooldownActiveUntilMs });
  }

  const consecutiveLossCount = current.consecutiveLossCount + 1;
  const limit = policy.consecutiveLossLimit;
  const firstReach = limit !== null && current.consecutiveLossCount < limit && consecutiveLossCount >= limit;
  if (!firstReach || policy.cooldownMs === null) {
    return Object.freeze({ consecutiveLossCount, cooldownActiveUntilMs: current.cooldownActiveUntilMs });
  }
  return Object.freeze({ consecutiveLossCount, cooldownActiveUntilMs: closeTimeMs + policy.cooldownMs });
}

/**
 * §12.4's running high-water mark. Exact Decimal comparison, and the invariant
 * that matters: the returned value is never below `currentPeakInr`. There is
 * no path in this module that lowers a peak.
 */
export function nextPeakEquityInr(currentPeakInr: PaperCalc, observedEquityInr: PaperCalc): PaperCalc {
  return observedEquityInr.greaterThan(currentPeakInr) ? observedEquityInr : currentPeakInr;
}

/** True iff the observation strictly advances the high-water mark, i.e. a durable write is warranted. */
export function advancesPeak(currentPeakInr: PaperCalc, observedEquityInr: PaperCalc): boolean {
  return observedEquityInr.greaterThan(currentPeakInr);
}

/**
 * [F14-01 §22] The deterministic replay reconciliation uses to check stored
 * loss state against durable close history.
 *
 * Fed every closed lifecycle in ascending close order, it returns exactly what
 * `nextLossState` would have produced across them. Because the rules are pure
 * and the inputs are immutable durable facts, the result is reproducible on
 * every run — no detection timestamp, no ambient state.
 */
export function replayLossState(
  closes: readonly { readonly realizedPnlInr: string; readonly closeTimeMs: number }[],
  policy: PaperLossStatePolicy,
): PaperLossState {
  let state: PaperLossState = Object.freeze({ consecutiveLossCount: 0, cooldownActiveUntilMs: null });
  for (const close of closes) {
    state = nextLossState({ current: state, realizedPnlInr: paperDecimal(close.realizedPnlInr), closeTimeMs: close.closeTimeMs, policy });
  }
  return state;
}
