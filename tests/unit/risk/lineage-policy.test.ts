import { makeLineage } from './helpers';
import { describe, expect, it } from 'vitest';
import {
  RiskConfigError, RiskEngine, RiskEngineError, canonicalDecimalString,
  createStrategyRiskCandidate, deriveRiskAction, recomputeStrategyDecisionId,
} from '../../../src/risk';
import { makeContext, makeDecision, makePolicy } from './helpers';

describe('Phase 13 strategy lineage and policy authority', () => {
  it('recomputes the genuine Phase 10 decision identity', () => {
    const decision = makeDecision();
    expect(recomputeStrategyDecisionId(decision)).toBe(decision.decisionId);
    expect(decision.triggerTimeframeMinutes).toBe(5);
  });

  it('treats WARMING as a structural no-op', () => {
    expect(createStrategyRiskCandidate(makeDecision(null, 'WARMING'), 'instrument-1', makeLineage())).toBeNull();
  });

  it('rejects a well-formed decision ID mismatch without throwing', () => {
    const context = makeContext();
    const tampered = { ...context.candidate.strategyDecision, decisionId: 'b'.repeat(64) };
    const result = new RiskEngine(makePolicy()).evaluateRisk({ ...context, candidate: { ...context.candidate, strategyDecision: tampered } });
    expect(result.status).toBe('REJECTED');
    if (result.status === 'REJECTED') expect(result.primaryReasonCode).toBe('DECISION_IDENTITY_MISMATCH');
  });

  it('derives every frozen action from target exposure and current position', () => {
    expect(deriveRiskAction(makeDecision('LONG'), { state: 'FLAT' })).toBe('OPEN');
    expect(deriveRiskAction(makeDecision('SHORT'), { state: 'OPEN', positionId: 'p', positionDirection: 'LONG', quantityMagnitude: '1', valuation: null })).toBe('REVERSAL_DEFERRED');
    expect(deriveRiskAction(makeDecision('FLAT'), { state: 'OPEN', positionId: 'p', positionDirection: 'LONG', quantityMagnitude: '1', valuation: null })).toBe('CLOSE');
    expect(deriveRiskAction(makeDecision('LONG'), { state: 'OPEN', positionId: 'p', positionDirection: 'LONG', quantityMagnitude: '1', valuation: null })).toBe('NO_CHANGE');
  });

  it('normalizes equivalent Decimal spellings canonically', () => {
    expect(canonicalDecimalString('002.000')).toBe('2');
    expect(canonicalDecimalString('-0.000')).toBe('0');
  });

  it('makes every policy identity deterministic and freshness-sensitive', () => {
    const first = makePolicy();
    const second = makePolicy();
    expect(second).toEqual(first);
    const changed = makePolicy({ freshnessPolicy: { maxAccountSnapshotAgeMs: 1001, maxPairSnapshotAgeMs: 1000, maxExposureSnapshotAgeMs: 1000, maxLeverageTierSnapshotAgeMs: 1000, maxSettlementRateSnapshotAgeMs: 1000 } });
    expect(changed.freshnessPolicy.riskFreshnessPolicyId).not.toBe(first.freshnessPolicy.riskFreshnessPolicyId);
    expect(changed.riskPolicyId).not.toBe(first.riskPolicyId);
  });

  it('rejects HIGH and CUSTOM configurations that widen hard caps', () => {
    for (const mode of ['HIGH', 'CUSTOM'] as const) {
      const base = makePolicy();
      expect(() => makePolicy({ modeConfig: { ...base.modeConfig, mode, leverageRecommendation: '21' } })).toThrowError(RiskConfigError);
    }
  });

  it('rejects a widening override as a typed construction failure', () => {
    const context = makeContext({ override: { overrideId: 'wide', overrideRiskPerTradePercent: '2', overrideMaxLeverage: null, overrideMaxNotionalInr: null } });
    expect(() => new RiskEngine(makePolicy()).evaluateRisk(context)).toThrowError(RiskConfigError);
  });

  it('throws on malformed Decimal evidence before canonical identity exists', () => {
    const context = makeContext();
    const malformed = { ...context.pairSnapshot, minQuantity: 'abc' };
    expect(() => new RiskEngine(makePolicy()).evaluateRisk({ ...context, pairSnapshot: malformed })).toThrowError(RiskEngineError);
  });
});
