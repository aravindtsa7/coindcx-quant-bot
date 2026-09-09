import { makeOrigin } from './helpers';
import { TEST_INSTANCE_ID, TEST_PARAMETER_HASH, makeLineage } from './helpers';
import { describe, expect, it } from 'vitest';
import { RiskEngine, type PairRiskSnapshot, type RiskDecisionAction } from '../../../src/risk';
import { EVALUATION_TIME, makeContext, makeDecision, makePair, makePolicy, resealContext, seal } from './helpers';

function openPair(reconciled: boolean): PairRiskSnapshot {
  const valuation = {
    valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1' as const, valuationPriceField: 'markPriceUsdt' as const,
    valuationPriceUsdt: '100', valuationPriceSourceId: 'pair-source', valuationPriceSourceTimeMs: EVALUATION_TIME,
    valuationPriceObservedAtMs: EVALUATION_TIME, contractMultiplier: '0.001', conversionMarket: 'USDT_INR',
    conversionRateInrPerUsdt: '80', conversionSourceId: 'conversion-source', unitValuationInrPerQty: '8', aggregateCurrentNotionalInr: '80',
  };
  return seal({
    ...makePair(), position: { state: 'OPEN' as const, positionId: 'position-1', positionDirection: 'LONG' as const, quantityMagnitude: '10', valuation },
    ownership: reconciled
      ? { status: 'RECONCILED' as const, positionState: 'OPEN' as const, accountId: 'account-1', pair: 'B-BTC_USDT', positionId: 'position-1',
          instanceOwnership: [{ strategyInstanceId: TEST_INSTANCE_ID, strategyId: 'EMA_TREND', strategyVersion: '1.0.0', parameterHash: TEST_PARAMETER_HASH, currentQuantity: '10', currentNotionalInr: '80' }] }
      : { status: 'UNRECONCILED' as const },
  });
}

function decision(action: 'SHORT' | 'LONG') {
  const strategyDecision = makeDecision(action);
  return new RiskEngine(makePolicy()).evaluateRisk(resealContext({
    ...makeContext(), strategyOrigin: makeOrigin(strategyDecision), candidate: { strategyLineage: makeLineage(), strategyDecision, pair: strategyDecision.pair, instrumentSpecSnapshotId: 'instrument-1' },
    entryStopProposal: null, leverageProposal: null, pairSnapshot: openPair(true),
  }));
}

function step(result: ReturnType<typeof decision>, number: number) {
  const found = result.auditTrail.find((entry) => entry.step === number);
  if (found === undefined) throw new Error(`missing audit step ${number}`);
  return found;
}

describe('P13-IMPL-R02 audit applicability', () => {
  it('executes reversal ownership and reports an unreconciled failure at step 10', () => {
    const strategyDecision = makeDecision('SHORT');
    const result = new RiskEngine(makePolicy()).evaluateRisk(resealContext({
      ...makeContext(), strategyOrigin: makeOrigin(strategyDecision), candidate: { strategyLineage: makeLineage(), strategyDecision, pair: strategyDecision.pair, instrumentSpecSnapshotId: 'instrument-1' },
      entryStopProposal: null, leverageProposal: null, pairSnapshot: openPair(false),
    }));
    expect(step(result, 10)).toMatchObject({ outcome: 'FAIL', reasonCodes: ['POSITION_OWNERSHIP_UNRECONCILED'] });
  });

  it('records reversal ownership as a passed executed step when ownership is valid', () => {
    expect(step(decision('SHORT'), 10)).toEqual({ step: 10, name: 'PENDING_OWNERSHIP_STATE', outcome: 'PASS', reasonCodes: [] });
  });

  it('marks a genuinely non-applicable sizing step skipped without reasons', () => {
    expect(step(decision('SHORT'), 11)).toEqual({ step: 11, name: 'SIZING_TIER_MARGIN', outcome: 'SKIPPED', reasonCodes: [] });
  });

  it('keeps NO_CHANGE terminal and skips its inapplicable downstream steps', () => {
    const result = decision('LONG');
    expect(result.status === 'REJECTED' && result.action).toBe<RiskDecisionAction>('NO_CHANGE');
    expect(step(result, 8)).toMatchObject({ outcome: 'FAIL', reasonCodes: ['NO_CHANGE_TARGET_ALREADY_HELD'] });
    for (const number of [9, 10, 11, 12]) expect(step(result, number)).toMatchObject({ outcome: 'SKIPPED', reasonCodes: [] });
  });

  it('never emits reason codes on a skipped audit step', () => {
    for (const result of [decision('SHORT'), decision('LONG')]) {
      for (const entry of result.auditTrail) if (entry.outcome === 'SKIPPED') expect(entry.reasonCodes).toEqual([]);
    }
  });
});
