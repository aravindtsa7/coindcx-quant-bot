import { makeOrigin } from './helpers';
import { TEST_INSTANCE_ID, TEST_PARAMETER_HASH, makeLineage } from './helpers';
import { describe, expect, it } from 'vitest';
import { RiskEngine, type CanonicalPositionValuation, type PairRiskSnapshot } from '../../../src/risk';
import { EVALUATION_TIME, makeContext, makeDecision, makePair, makePolicy, resealContext, seal } from './helpers';

function valuation(aggregateCurrentNotionalInr: string): CanonicalPositionValuation {
  return {
    valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1', valuationPriceField: 'markPriceUsdt', valuationPriceUsdt: '100',
    valuationPriceSourceId: 'pair-source', valuationPriceSourceTimeMs: EVALUATION_TIME, valuationPriceObservedAtMs: EVALUATION_TIME,
    contractMultiplier: '0.001', conversionMarket: 'USDT_INR', conversionRateInrPerUsdt: '80', conversionSourceId: 'conversion-source',
    unitValuationInrPerQty: '8', aggregateCurrentNotionalInr,
  };
}

function openPair(reportedAggregate: string, instanceNotional: string): PairRiskSnapshot {
  return seal({
    ...makePair(),
    position: { state: 'OPEN' as const, positionId: 'position-1', positionDirection: 'LONG' as const, quantityMagnitude: '10', valuation: valuation(reportedAggregate) },
    ownership: { status: 'RECONCILED' as const, positionState: 'OPEN' as const, accountId: 'account-1', pair: 'B-BTC_USDT', positionId: 'position-1',
      instanceOwnership: [{ strategyInstanceId: TEST_INSTANCE_ID, strategyId: 'EMA_TREND', strategyVersion: '1.0.0', parameterHash: TEST_PARAMETER_HASH, currentQuantity: '10', currentNotionalInr: instanceNotional }] },
  });
}

function result(reportedAggregate: string, instanceNotional: string) {
  const strategyDecision = makeDecision('FLAT');
  return new RiskEngine(makePolicy()).evaluateRisk(resealContext({
    ...makeContext(), strategyOrigin: makeOrigin(strategyDecision), candidate: { strategyLineage: makeLineage(), strategyDecision, pair: strategyDecision.pair, instrumentSpecSnapshotId: 'instrument-1' },
    entryStopProposal: null, leverageProposal: null, pairSnapshot: openPair(reportedAggregate, instanceNotional),
    exposureSnapshot: null, leverageTierSnapshot: null,
  }));
}

function codes(value: ReturnType<typeof result>): readonly string[] {
  return value.status === 'REJECTED' ? [value.primaryReasonCode, ...value.secondaryReasonCodes] : [];
}

describe('P13-IMPL-R05 aggregate-notional provenance', () => {
  it('rejects matching fabricated caller aggregate and instance values', () => {
    expect(codes(result('81', '81'))).toContain('POSITION_OWNERSHIP_UNRECONCILED');
  });

  it('rejects a wrong instance sum against a correct caller aggregate', () => {
    expect(codes(result('80', '81'))).toContain('POSITION_OWNERSHIP_UNRECONCILED');
  });

  it('rejects a caller aggregate that differs from canonical recomputation', () => {
    expect(codes(result('81', '80'))).toContain('POSITION_OWNERSHIP_UNRECONCILED');
  });

  it('accepts when the recomputed aggregate and every instance value reconcile', () => {
    const accepted = result('80', '80');
    expect(accepted.status).toBe('ACCEPTED');
    if (accepted.status === 'ACCEPTED') expect(accepted.action).toBe('CLOSE');
  });
});
