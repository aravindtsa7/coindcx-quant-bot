import { describe, expect, it } from 'vitest';
import { RiskEngine, type RiskEvaluationContext } from '../../../src/risk';
import { EVALUATION_TIME, makeAccount, makeContext, makeDecision, makeExposure, makePair, makePolicy, makeTiers, resealContext, seal } from './helpers';

function evaluate(changes: Partial<RiskEvaluationContext> = {}) {
  const context = resealContext(makeContext(changes));
  return new RiskEngine(makePolicy()).evaluateRisk(context);
}

function rejectionCodes(result: ReturnType<typeof evaluate>): readonly string[] {
  return result.status === 'REJECTED' ? [result.primaryReasonCode, ...result.secondaryReasonCodes] : [];
}

describe('Phase 13 deterministic sizing, tiers, exposure, and decision union', () => {
  it('accepts OPEN and projects all seven sizing values without recalculation', () => {
    const engine = new RiskEngine(makePolicy());
    const context = makeContext();
    const sizing = engine.evaluatePositionSizing(context).decision;
    const result = engine.evaluateRisk(context);
    expect(result.status).toBe('ACCEPTED');
    if (result.status === 'ACCEPTED' && result.action === 'OPEN' && sizing.sizing !== null) {
      expect(result.sourcePositionSizingDecisionId).toBe(sizing.positionSizingDecisionId);
      expect(result.approved).toEqual({
        approvedQuantity: sizing.sizing.finalQuantity, approvedLeverage: sizing.sizing.finalLeverage,
        approvedNotionalUsdt: sizing.sizing.finalNotionalUsdt, approvedNotionalInr: sizing.sizing.finalNotionalInr,
        estimatedInitialMarginUsdt: sizing.sizing.estimatedInitialMarginUsdt, estimatedInitialMarginInr: sizing.sizing.estimatedInitialMarginInr,
        estimatedStopLossRiskInr: sizing.sizing.estimatedStopLossRiskInr,
      });
      expect(result.approved).not.toHaveProperty('riskBudgetInr');
      expect(result.approved).not.toHaveProperty('riskCappedQuantity');
    }
  });

  it('is deterministic and never exceeds the economic risk budget', () => {
    const engine = new RiskEngine(makePolicy());
    const context = makeContext();
    expect(engine.evaluateRisk(context)).toEqual(engine.evaluateRisk(context));
    const sizing = engine.evaluatePositionSizing(context).decision.sizing;
    expect(sizing).not.toBeNull();
    if (sizing !== null) expect(BigInt(sizing.estimatedStopLossRiskInr)).toBeLessThanOrEqual(BigInt(sizing.riskBudgetInr));
  });

  it('rounds quantity down to the exchange increment', () => {
    const context = makeContext();
    const pair = seal({ ...context.pairSnapshot, quantityIncrement: '3' });
    const sizing = new RiskEngine(makePolicy()).evaluatePositionSizing(resealContext({ ...context, pairSnapshot: pair })).decision.sizing;
    expect(sizing?.finalQuantity).toBe('1248');
  });

  it('enforces maximum quantity', () => {
    const context = makeContext();
    const result = evaluate({ pairSnapshot: seal({ ...context.pairSnapshot, maxQuantity: '100' }) });
    expect(result.status === 'ACCEPTED' && result.action === 'OPEN' && result.approved.approvedQuantity).toBe('100');
  });

  it('does not bump upward to satisfy minimum quantity', () => {
    const context = makeContext();
    const result = evaluate({ pairSnapshot: seal({ ...context.pairSnapshot, minQuantity: '2000' }) });
    expect(rejectionCodes(result)).toContain('MIN_QUANTITY_NOT_MET');
  });

  it('does not bump upward to satisfy minimum notional', () => {
    const context = makeContext();
    const result = evaluate({ pairSnapshot: seal({ ...context.pairSnapshot, minNotional: '1000' }) });
    expect(rejectionCodes(result)).toContain('MIN_NOTIONAL_NOT_MET');
  });

  it('rejects insufficient margin', () => {
    const result = evaluate({ accountSnapshot: seal({ ...makeAccount(), availableMarginInr: '1' }) });
    expect(rejectionCodes(result)).toContain('INSUFFICIENT_MARGIN');
  });

  it.each([
    [{ status: 'INACTIVE' }, 'inactive'],
    [{ exitOnly: true }, 'exitOnly'],
  ] as const)('rejects %s instruments for new exposure', (change, _label) => {
    const context = makeContext();
    const result = evaluate({ pairSnapshot: seal({ ...context.pairSnapshot, ...change }) });
    expect(rejectionCodes(result)).toContain('INSTRUMENT_NOT_TRADEABLE_FOR_NEW_EXPOSURE');
  });

  it.each([
    [{ minPrice: '101' }, 'INVALID_ENTRY_PRICE'],
    [{ maxPrice: '99' }, 'INVALID_ENTRY_PRICE'],
    [{ priceIncrement: '3' }, 'INVALID_ENTRY_PRICE'],
  ] as const)('enforces price bounds and tick alignment', (change, code) => {
    const context = makeContext();
    expect(rejectionCodes(evaluate({ pairSnapshot: seal({ ...context.pairSnapshot, ...change }) }))).toContain(code);
  });

  it('fails closed when tier semantics are unverified', () => {
    const result = evaluate({ leverageTierSnapshot: seal({ ...makeTiers(), semanticsStatus: 'SEMANTICS_UNVERIFIED' as const, semanticsVersion: null }) });
    expect(rejectionCodes(result)).toContain('LEVERAGE_TIER_SEMANTICS_UNVERIFIED');
  });

  it('rejects overlapping or gapped tier intervals', () => {
    const tiers = seal({ ...makeTiers(), tiers: [
      { tierId: 'a', lowerNotionalUsdt: '0', upperNotionalUsdt: '100', lowerInclusive: true, upperInclusive: false, maxLeverage: '10' },
      { tierId: 'b', lowerNotionalUsdt: '101', upperNotionalUsdt: null, lowerInclusive: true, upperInclusive: false, maxLeverage: '5' },
    ] });
    expect(rejectionCodes(evaluate({ leverageTierSnapshot: tiers }))).toContain('LEVERAGE_TIERS_UNAVAILABLE');
  });

  it('enumerates all tiers and selects the greatest feasible quantity', () => {
    const tiers = seal({ ...makeTiers(), exchangeMaxLeverage: '10', tiers: [
      { tierId: 'low', lowerNotionalUsdt: '0', upperNotionalUsdt: '100', lowerInclusive: true, upperInclusive: false, maxLeverage: '10' },
      { tierId: 'high', lowerNotionalUsdt: '100', upperNotionalUsdt: null, lowerInclusive: true, upperInclusive: false, maxLeverage: '5' },
    ] });
    const result = evaluate({ leverageTierSnapshot: tiers });
    expect(result.status === 'ACCEPTED' && result.action === 'OPEN' && result.approved.approvedQuantity).toBe('1250');
  });

  it('respects an exclusive upper tier boundary exactly', () => {
    const context = makeContext();
    const tiers = seal({ ...makeTiers(), tiers: [
      { tierId: 'low', lowerNotionalUsdt: '0', upperNotionalUsdt: '100', lowerInclusive: true, upperInclusive: false, maxLeverage: '10' },
      { tierId: 'high', lowerNotionalUsdt: '100', upperNotionalUsdt: '100', lowerInclusive: true, upperInclusive: true, maxLeverage: '5' },
    ] });
    const result = evaluate({ ...context, leverageTierSnapshot: tiers });
    expect(rejectionCodes(result)).toContain('LEVERAGE_TIERS_UNAVAILABLE');
  });

  it('applies instrument max notional and resolved per-trade notional caps', () => {
    const context = makeContext();
    const result = evaluate({ pairSnapshot: seal({ ...context.pairSnapshot, maxNotional: '50' }) });
    expect(result.status === 'ACCEPTED' && result.action === 'OPEN' && result.approved.approvedNotionalUsdt).toBe('50');
  });

  it('distinguishes KNOWN zero pending exposure from UNKNOWN', () => {
    expect(evaluate().status).toBe('ACCEPTED');
    const exposure = seal({ ...makeExposure(), pending: { status: 'UNKNOWN' as const } });
    expect(rejectionCodes(evaluate({ exposureSnapshot: exposure }))).toContain('PENDING_EXPOSURE_UNKNOWN');
  });

  it('isolates pending reservations by full instance identity', () => {
    const exposure = makeExposure();
    if (exposure.pending.status !== 'KNOWN') throw new Error('fixture');
    const pending = { ...exposure.pending, instancePendingReservations: [{ strategyInstanceId: 'instance-2', strategyId: 'strategy-1', strategyVersion: '1.0.0', parameterHash: 'a'.repeat(64), pendingNotionalInr: '10', pendingReservationCount: 1 }] };
    expect(evaluate({ exposureSnapshot: seal({ ...exposure, pending }) }).status).toBe('ACCEPTED');
  });

  it('rejects a corrupt reservation identity for the requesting instance', () => {
    const exposure = makeExposure();
    if (exposure.pending.status !== 'KNOWN') throw new Error('fixture');
    const pending = { ...exposure.pending, instancePendingReservations: [{ strategyInstanceId: 'instance-1', strategyId: 'wrong', strategyVersion: '1.0.0', parameterHash: 'a'.repeat(64), pendingNotionalInr: '10', pendingReservationCount: 1 }] };
    expect(rejectionCodes(evaluate({ exposureSnapshot: seal({ ...exposure, pending }) }))).toContain('DECISION_IDENTITY_MISMATCH');
  });

  it('returns NO_CHANGE only as a rejected non-actionable union variant', () => {
    const decision = makeDecision('FLAT');
    const result = evaluate({ candidate: { strategyDecision: decision, pair: decision.pair, instrumentSpecSnapshotId: 'instrument-1' }, entryStopProposal: null, leverageProposal: null });
    expect(result).toMatchObject({ status: 'REJECTED', action: 'NO_CHANGE', approved: null, primaryReasonCode: 'NO_CHANGE_TARGET_ALREADY_HELD' });
  });

  it('returns REVERSAL_DEFERRED only as a rejected non-executable variant', () => {
    const decision = makeDecision('SHORT');
    const pair = { ...makePair(), position: { state: 'OPEN' as const, positionId: 'p', positionDirection: 'LONG' as const, quantityMagnitude: '1', valuation: null }, ownership: { status: 'UNRECONCILED' as const } };
    const result = evaluate({ candidate: { strategyDecision: decision, pair: decision.pair, instrumentSpecSnapshotId: 'instrument-1' }, pairSnapshot: seal(pair), entryStopProposal: null, leverageProposal: null });
    expect(result.status).toBe('REJECTED');
    if (result.status === 'REJECTED') { expect(result.action).toBe('REVERSAL_DEFERRED'); expect(result.approved).toBeNull(); expect(rejectionCodes(result)).toContain('REVERSAL_REQUIRES_SEQUENTIAL_EVALUATION'); }
  });

  it('deep-freezes decisions and snapshots against caller mutation', () => {
    const context = makeContext();
    const sourcePolicy = makePolicy();
    const mutablePolicy = { ...sourcePolicy, globalConfig: { ...sourcePolicy.globalConfig } };
    const engine = new RiskEngine(mutablePolicy);
    const result = engine.evaluateRisk(context);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.auditTrail)).toBe(true);
    expect(Object.isFrozen(result.capsApplied)).toBe(true);
    expect(Object.isFrozen(engine.policy.globalConfig)).toBe(true);
    const id = result.riskDecisionId;
    (context.accountSnapshot as { currentEquityInr: string }).currentEquityInr = '1';
    (mutablePolicy.globalConfig as { globalMaxLeverage: string }).globalMaxLeverage = '999';
    expect(result.riskDecisionId).toBe(id);
    expect(engine.policy.globalConfig.globalMaxLeverage).toBe(sourcePolicy.globalConfig.globalMaxLeverage);
  });

  it('binds evaluation time without reading the wall clock', () => {
    const first = evaluate();
    const context = makeContext({ evaluationTimeMs: EVALUATION_TIME + 1 });
    const second = new RiskEngine(makePolicy({ freshnessPolicy: { maxAccountSnapshotAgeMs: 1001, maxPairSnapshotAgeMs: 1001, maxExposureSnapshotAgeMs: 1001, maxLeverageTierSnapshotAgeMs: 1001, maxSettlementRateSnapshotAgeMs: 1001 } })).evaluateRisk(context);
    expect(second.riskDecisionId).not.toBe(first.riskDecisionId);
  });
});
