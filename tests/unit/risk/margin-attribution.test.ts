import { describe, expect, it } from 'vitest';
import { RiskEngine, type RiskEvaluationContext, type RiskPolicy } from '../../../src/risk';
import { noFeasibleTierReason, type TierFailureCause } from '../../../src/risk/tier-resolution';
import { makeAccount, makeContext, makePair, makePolicy, makeTiers, resealContext, seal } from './helpers';

function sizingCodes(changes: Partial<RiskEvaluationContext> = {}, policy: RiskPolicy = makePolicy()): readonly string[] {
  return new RiskEngine(policy).evaluatePositionSizing(resealContext(makeContext(changes))).decision.sizingReasonCodes;
}

function lowEquityAccount(availableMarginInr: string) {
  return seal({ ...makeAccount(), currentEquityInr: '400', peakEquityInr: '400', availableMarginInr });
}

describe('P13-IMPL-R03 causal margin attribution', () => {
  it('attributes failure to margin when margin is truly binding', () => {
    const pair = seal({ ...makePair(), minQuantity: '10', minTradeSize: '10' });
    expect(sizingCodes({ pairSnapshot: pair, accountSnapshot: seal({ ...makeAccount(), availableMarginInr: '8' }) })).toEqual(['INSUFFICIENT_MARGIN']);
  });

  it('does not blame margin when risk quantity binds below both margin and minimum quantity', () => {
    const pair = seal({ ...makePair(), minQuantity: '10', minTradeSize: '10' });
    expect(sizingCodes({ pairSnapshot: pair, accountSnapshot: lowEquityAccount('13') })).toEqual(['MIN_QUANTITY_NOT_MET']);
  });

  it('attributes a max-notional-bound floor failure to minimum quantity even when margin is also below it', () => {
    const pair = seal({ ...makePair(), minQuantity: '10', minTradeSize: '10' });
    const context = makeContext({ pairSnapshot: pair, accountSnapshot: seal({ ...makeAccount(), availableMarginInr: '13' }),
      override: { overrideId: 'notional-cap', overrideRiskPerTradePercent: null, overrideMaxLeverage: null, overrideMaxNotionalInr: '40' } });
    expect(sizingCodes(context)).toEqual(['MIN_QUANTITY_NOT_MET']);
  });

  it('attributes an instrument-max-quantity-bound floor failure to minimum notional', () => {
    const pair = seal({ ...makePair(), minQuantity: '1', minTradeSize: '1', maxQuantity: '5', minNotional: '1' });
    expect(sizingCodes({ pairSnapshot: pair, accountSnapshot: seal({ ...makeAccount(), availableMarginInr: '13' }) })).toEqual(['MIN_NOTIONAL_NOT_MET']);
  });

  it('treats an exact minimum-ceiling tie involving margin deterministically as margin causal', () => {
    const pair = seal({ ...makePair(), minQuantity: '10', minTradeSize: '10' });
    expect(sizingCodes({ pairSnapshot: pair, accountSnapshot: lowEquityAccount('8') })).toEqual(['INSUFFICIENT_MARGIN']);
  });

  it('returns no-valid-tier for mixed per-tier binding causes', () => {
    const pair = seal({ ...makePair(), minQuantity: '10', minTradeSize: '10' });
    const tiers = seal({ ...makeTiers(), exchangeMaxLeverage: '2', tiers: [
      { tierId: 'margin-bound', lowerNotionalUsdt: '0', upperNotionalUsdt: '0.5', lowerInclusive: true, upperInclusive: false, maxLeverage: '1' },
      { tierId: 'risk-bound', lowerNotionalUsdt: '0.5', upperNotionalUsdt: null, lowerInclusive: true, upperInclusive: false, maxLeverage: '2' },
    ] });
    expect(sizingCodes({ pairSnapshot: pair, accountSnapshot: lowEquityAccount('32'), leverageTierSnapshot: tiers })).toEqual(['NO_VALID_LEVERAGE_TIER']);
  });

  it('attributes a pure minimum-quantity failure without margin causality', () => {
    const pair = seal({ ...makePair(), minQuantity: '10', minTradeSize: '10' });
    expect(sizingCodes({ pairSnapshot: pair, accountSnapshot: lowEquityAccount('1000') })).toEqual(['MIN_QUANTITY_NOT_MET']);
  });

  it('attributes a pure minimum-notional failure without margin causality', () => {
    const pair = seal({ ...makePair(), minQuantity: '1', minTradeSize: '1', minNotional: '1' });
    expect(sizingCodes({ pairSnapshot: pair, accountSnapshot: lowEquityAccount('1000') })).toEqual(['MIN_NOTIONAL_NOT_MET']);
  });

  it('makes mixed-cause attribution independent of iteration order', () => {
    const causes: readonly TierFailureCause[] = ['MARGIN_FLOOR', 'MIN_QUANTITY', 'OTHER'];
    expect(noFeasibleTierReason(causes)).toBe('NO_VALID_LEVERAGE_TIER');
    expect(noFeasibleTierReason([...causes].reverse())).toBe('NO_VALID_LEVERAGE_TIER');
  });
});
