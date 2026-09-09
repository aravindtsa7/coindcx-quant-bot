import { paperMax, paperMin, PaperCalcDecimal, PaperDecimal, type PaperCalc } from './decimal';
import { PaperEngineError } from './errors';

// ---------------------------------------------------------------------------
// V2 §12 frozen INR cash-settled account equations.
//
//   cashBalance     = S + R - F + G
//   equity          = cashBalance + U
//   lockedMargin    = L
//   reservedCapacity = P
//   availableMargin = max(0, min(cashBalance, equity) - L - P)
//
// Negative true cash/equity are never clamped — insolvency stays visible.
// Only `availableMargin` has the defined `max(0, ...)` floor. Unrealized
// profit never becomes spendable collateral: `min(cashBalance, equity)`
// excludes a positive `U` from the floor entirely, while a negative `U`
// (unrealized loss) still reduces it.
// ---------------------------------------------------------------------------

export interface CashBalanceInputs {
  /** S — immutable starting-capital posting. */
  readonly startingCapitalInr: PaperCalc;
  /** R — cumulative booked gross realized trading PnL. */
  readonly cumulativeRealizedPnlInr: PaperCalc;
  /** F — cumulative positive fee charges. */
  readonly cumulativeFeesInr: PaperCalc;
  /** G — cumulative signed funding PnL. */
  readonly cumulativeFundingInr: PaperCalc;
}

export function computeCashBalance(inputs: CashBalanceInputs): PaperCalc {
  return inputs.startingCapitalInr.plus(inputs.cumulativeRealizedPnlInr).minus(inputs.cumulativeFeesInr).plus(inputs.cumulativeFundingInr);
}

/** `equity = cashBalance + U` — never clamped. */
export function computeEquity(cashBalance: PaperCalc, unrealizedPnlInr: PaperCalc): PaperCalc {
  return cashBalance.plus(unrealizedPnlInr);
}

export interface AvailableMarginInputs {
  readonly cashBalance: PaperCalc;
  readonly equity: PaperCalc;
  /** L — open-position initial margin. */
  readonly lockedMarginInr: PaperCalc;
  /** P — pending margin reservations + reserved opening fee allowances. */
  readonly reservedCapacityInr: PaperCalc;
}

/** `availableMargin = max(0, min(cashBalance, equity) - L - P)`. */
export function computeAvailableMargin(inputs: AvailableMarginInputs): PaperCalc {
  const floor = paperMin(inputs.cashBalance, inputs.equity);
  const afterReservations = floor.minus(inputs.lockedMarginInr).minus(inputs.reservedCapacityInr);
  return paperMax(new PaperCalcDecimal(0), afterReservations);
}

// ---------------------------------------------------------------------------
// Pure posting helpers — Phase9's exact fee/PnL/funding formulas (reused
// arithmetic pattern, not the stateful engine plumbing around it).
// ---------------------------------------------------------------------------

export function computeFeeInr(notionalInr: PaperCalc, feeRate: PaperCalc): PaperCalc {
  return notionalInr.times(feeRate);
}

export interface RealizedPnlInputs {
  readonly side: 'LONG' | 'SHORT';
  readonly entryPriceInr: PaperCalc;
  readonly exitPriceInr: PaperCalc;
  readonly closingQuantity: PaperCalc;
  readonly contractMultiplier: PaperCalc;
}

/** Realized PnL is computed strictly on the closing quantity, mirroring `src/backtest/accounting.ts`. */
export function computeRealizedPnlInr(inputs: RealizedPnlInputs): PaperCalc {
  const delta = inputs.side === 'LONG' ? inputs.exitPriceInr.minus(inputs.entryPriceInr) : inputs.entryPriceInr.minus(inputs.exitPriceInr);
  return delta.times(inputs.closingQuantity).times(inputs.contractMultiplier);
}

export interface UnrealizedPnlInputs {
  readonly side: 'LONG' | 'SHORT';
  readonly entryPriceInr: PaperCalc;
  readonly markPriceInr: PaperCalc;
  readonly quantity: PaperCalc;
  readonly contractMultiplier: PaperCalc;
}

export function computeUnrealizedPnlInr(inputs: UnrealizedPnlInputs): PaperCalc {
  const delta = inputs.side === 'LONG' ? inputs.markPriceInr.minus(inputs.entryPriceInr) : inputs.entryPriceInr.minus(inputs.markPriceInr);
  return delta.times(inputs.quantity).times(inputs.contractMultiplier);
}

export interface FundingPnlInputs {
  readonly side: 'LONG' | 'SHORT' | 'FLAT';
  readonly quantity: PaperCalc;
  readonly referencePriceInr: PaperCalc;
  readonly contractMultiplier: PaperCalc;
  readonly fundingRate: PaperCalc;
}

/**
 * `fundingPnl = -sign(side) * |Q| * referencePrice * multiplier * fundingRate`
 * — positive rate: LONG pays, SHORT receives (mirrors Phase9's exact convention).
 */
export function computeFundingPnlInr(inputs: FundingPnlInputs): PaperCalc {
  const sign = inputs.side === 'LONG' ? new PaperCalcDecimal(1) : inputs.side === 'SHORT' ? new PaperCalcDecimal(-1) : new PaperCalcDecimal(0);
  const fundingNotional = inputs.quantity.abs().times(inputs.referencePriceInr).times(inputs.contractMultiplier);
  return sign.negated().times(fundingNotional).times(inputs.fundingRate);
}

/**
 * The explicit durable-posting boundary: `ROUND_HALF_UP` to `Decimal(36,18)`
 * happens only here, immediately before a value becomes a durable posting.
 * Higher-precision `PaperCalc` intermediates from the functions above must
 * never pass through this except at that exact moment. Overflow/non-finite
 * input fails closed (`PaperEngineError`), never silently truncated.
 */
export function quantizePaperPosting(value: PaperCalc): PaperDecimal {
  if (!value.isFinite() || value.isNaN()) throw new PaperEngineError('PAPER_NUMERIC_FAILURE', 'Posting value must be finite');
  return new PaperDecimal(value);
}
