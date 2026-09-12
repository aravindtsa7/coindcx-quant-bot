import { describe, expect, it } from 'vitest';
import {
  computeAvailableMargin, computeCashBalance, computeEquity, computeFeeInr, computeFundingPnlInr,
  computeRealizedPnlInr, computeUnrealizedPnlInr, quantizePaperPosting,
} from '../../../src/execution/accounting';
import { paperDecimal, PaperDecimal } from '../../../src/execution/decimal';
import { PaperEngineError } from '../../../src/execution/errors';

describe('P14-A INR account equations (V2 §12 frozen)', () => {
  it('cashBalance = S + R - F + G', () => {
    const cash = computeCashBalance({
      startingCapitalInr: paperDecimal('100000'), cumulativeRealizedPnlInr: paperDecimal('5000'),
      cumulativeFeesInr: paperDecimal('200'), cumulativeFundingInr: paperDecimal('-50'),
    });
    expect(cash.toFixed()).toBe('104750');
  });

  it('equity = cashBalance + U, never clamped', () => {
    expect(computeEquity(paperDecimal('1000'), paperDecimal('250')).toFixed()).toBe('1250');
    expect(computeEquity(paperDecimal('1000'), paperDecimal('-250')).toFixed()).toBe('750');
  });

  it('negative cashBalance/equity are preserved truthfully, never clamped to zero', () => {
    const cash = computeCashBalance({
      startingCapitalInr: paperDecimal('100'), cumulativeRealizedPnlInr: paperDecimal('-500'),
      cumulativeFeesInr: paperDecimal('10'), cumulativeFundingInr: paperDecimal('0'),
    });
    expect(cash.toFixed()).toBe('-410');
    const equity = computeEquity(cash, paperDecimal('0'));
    expect(equity.toFixed()).toBe('-410');
  });

  it('availableMargin = max(0, min(cashBalance, equity) - L - P)', () => {
    const cashBalance = paperDecimal('1000');
    const equity = computeEquity(cashBalance, paperDecimal('200'));
    const margin = computeAvailableMargin({ cashBalance, equity, lockedMarginInr: paperDecimal('300'), reservedCapacityInr: paperDecimal('100') });
    // min(1000, 1200) - 300 - 100 = 600
    expect(margin.toFixed()).toBe('600');
  });

  it('unrealized profit is not spendable collateral — min(cashBalance, equity) ignores a positive U', () => {
    const cashBalance = paperDecimal('1000');
    const equityWithProfit = computeEquity(cashBalance, paperDecimal('10000'));
    const margin = computeAvailableMargin({ cashBalance, equity: equityWithProfit, lockedMarginInr: paperDecimal('0'), reservedCapacityInr: paperDecimal('0') });
    expect(margin.toFixed()).toBe('1000');
  });

  it('unrealized loss does reduce available margin — min(cashBalance, equity) picks the smaller equity', () => {
    const cashBalance = paperDecimal('1000');
    const equityWithLoss = computeEquity(cashBalance, paperDecimal('-400'));
    const margin = computeAvailableMargin({ cashBalance, equity: equityWithLoss, lockedMarginInr: paperDecimal('0'), reservedCapacityInr: paperDecimal('0') });
    expect(margin.toFixed()).toBe('600');
  });

  it('availableMargin floors at zero rather than going negative', () => {
    const cashBalance = paperDecimal('100');
    const equity = computeEquity(cashBalance, paperDecimal('0'));
    const margin = computeAvailableMargin({ cashBalance, equity, lockedMarginInr: paperDecimal('300'), reservedCapacityInr: paperDecimal('50') });
    expect(margin.toFixed()).toBe('0');
  });
});

describe('P14-A posting formulas — fee/realized/unrealized/funding signs', () => {
  it('fee is notional * feeRate', () => {
    expect(computeFeeInr(paperDecimal('100000'), paperDecimal('0.001')).toFixed()).toBe('100');
  });

  it('realized PnL: LONG gains when exit > entry, SHORT gains when exit < entry', () => {
    const longPnl = computeRealizedPnlInr({ side: 'LONG', entryPriceInr: paperDecimal('100'), exitPriceInr: paperDecimal('110'), closingQuantity: paperDecimal('2'), contractMultiplier: paperDecimal('1') });
    expect(longPnl.toFixed()).toBe('20');
    const shortPnl = computeRealizedPnlInr({ side: 'SHORT', entryPriceInr: paperDecimal('100'), exitPriceInr: paperDecimal('90'), closingQuantity: paperDecimal('2'), contractMultiplier: paperDecimal('1') });
    expect(shortPnl.toFixed()).toBe('20');
  });

  it('unrealized PnL mirrors realized formula against mark price', () => {
    const unrealized = computeUnrealizedPnlInr({ side: 'LONG', entryPriceInr: paperDecimal('100'), markPriceInr: paperDecimal('95'), quantity: paperDecimal('3'), contractMultiplier: paperDecimal('1') });
    expect(unrealized.toFixed()).toBe('-15');
  });

  it('funding: positive rate debits LONG, credits SHORT', () => {
    const longFunding = computeFundingPnlInr({ side: 'LONG', quantity: paperDecimal('10'), referencePriceInr: paperDecimal('100'), contractMultiplier: paperDecimal('1'), fundingRate: paperDecimal('0.01') });
    expect(longFunding.toFixed()).toBe('-10');
    const shortFunding = computeFundingPnlInr({ side: 'SHORT', quantity: paperDecimal('10'), referencePriceInr: paperDecimal('100'), contractMultiplier: paperDecimal('1'), fundingRate: paperDecimal('0.01') });
    expect(shortFunding.toFixed()).toBe('10');
  });

  it('funding: negative rate reverses the sign (LONG receives, SHORT pays)', () => {
    const longFunding = computeFundingPnlInr({ side: 'LONG', quantity: paperDecimal('10'), referencePriceInr: paperDecimal('100'), contractMultiplier: paperDecimal('1'), fundingRate: paperDecimal('-0.01') });
    expect(longFunding.toFixed()).toBe('10');
  });

  it('funding on a FLAT side is always zero', () => {
    const funding = computeFundingPnlInr({ side: 'FLAT', quantity: paperDecimal('10'), referencePriceInr: paperDecimal('100'), contractMultiplier: paperDecimal('1'), fundingRate: paperDecimal('0.01') });
    expect(funding.toFixed()).toBe('0');
  });
});

describe('P14-A Q18 durable-posting quantization boundary', () => {
  it('retains high-precision calculation inputs and rounds once to an exact Q18 posting', () => {
    const pnl = computeRealizedPnlInr({
      side: 'LONG', entryPriceInr: paperDecimal('100.123456789012345678'), exitPriceInr: paperDecimal('110.987654321098765432'),
      closingQuantity: paperDecimal('1.234567890123456789'), contractMultiplier: paperDecimal('0.001'),
    });
    expect(pnl.toFixed()).toBe('0.013412589425072397475723212913335009906');
    expect(quantizePaperPosting(pnl).value).toBe('0.013412589425072397');
  });

  it('accepts the exact Decimal(36,18) positive maximum and rejects the next minimal unit', () => {
    expect(quantizePaperPosting(paperDecimal('999999999999999999.999999999999999999')).value).toBe('999999999999999999.999999999999999999');
    expect(() => quantizePaperPosting(paperDecimal('1000000000000000000'))).toThrow(PaperEngineError);
  });

  it('quantizes at exactly the posting boundary, not mid-calculation', () => {
    const highPrecision = computeRealizedPnlInr({
      side: 'LONG', entryPriceInr: paperDecimal('100.1234567890123456789'), exitPriceInr: paperDecimal('110.9876543210987654321'),
      closingQuantity: paperDecimal('1'), contractMultiplier: paperDecimal('1'),
    });
    const posted = quantizePaperPosting(highPrecision);
    expect(posted).toBeInstanceOf(PaperDecimal);
    expect(posted.value.split('.')[1]?.length ?? 0).toBeLessThanOrEqual(18);
  });

  it('handles a 1e-18 posting exactly', () => {
    const posted = quantizePaperPosting(paperDecimal('0.000000000000000001'));
    expect(posted.value).toBe('0.000000000000000001');
  });

  it('fails closed on a non-finite posting value', () => {
    expect(() => quantizePaperPosting(paperDecimal('1').dividedBy(paperDecimal('0')))).toThrow(PaperEngineError);
  });

  it('fails closed on overflow beyond Decimal(36,18)', () => {
    expect(() => quantizePaperPosting(paperDecimal('9'.repeat(19)))).toThrow(PaperEngineError);
  });
});
