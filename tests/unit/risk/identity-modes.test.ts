import { describe, expect, it } from 'vitest';
import {
  RiskEngine, computePositionSizingPolicyId, createRiskPolicy, type RiskMode, type RiskPolicyDraft,
} from '../../../src/risk';
import { EVALUATION_TIME, makeContext, makePolicy, resealContext, seal } from './helpers';

describe('Phase 13 authority modes and canonical identity sensitivity', () => {
  it.each(['SAFE', 'NORMAL', 'HIGH', 'CUSTOM'] as const)('supports %s without bypassing parent caps', (mode: RiskMode) => {
    const base = makePolicy();
    const policy = makePolicy({ modeConfig: { ...base.modeConfig, mode } });
    expect(policy.modeConfig.mode).toBe(mode);
    expect(new RiskEngine(policy).evaluateRisk(makeContext()).status).toBe('ACCEPTED');
  });

  it('applies a tighten-only risk override', () => {
    const context = makeContext({ override: { overrideId: 'tight', overrideRiskPerTradePercent: '0.5', overrideMaxLeverage: '3', overrideMaxNotionalInr: '50000' } });
    const result = new RiskEngine(makePolicy()).evaluateRisk(context);
    expect(result.status).toBe('ACCEPTED');
    if (result.status === 'ACCEPTED' && result.action === 'OPEN') {
      expect(result.approved.approvedQuantity).toBe('625');
      expect(result.approved.approvedLeverage).toBe('3');
    }
  });

  it('does not use leverage to reduce underlying stop-loss risk', () => {
    const base = makeContext();
    const high = new RiskEngine(makePolicy()).evaluatePositionSizing(base).decision.sizing;
    const low = new RiskEngine(makePolicy()).evaluatePositionSizing({ ...base, leverageProposal: { ...base.leverageProposal!, requestedLeverage: '2' } }).decision.sizing;
    expect(low?.finalQuantity).toBe(high?.finalQuantity);
    expect(low?.estimatedStopLossRiskInr).toBe(high?.estimatedStopLossRiskInr);
    expect(low?.estimatedInitialMarginInr).not.toBe(high?.estimatedInitialMarginInr);
  });

  it('changes global, pair, and mode IDs only from their canonical fields', () => {
    const base = makePolicy();
    const global = makePolicy({ globalConfig: { ...base.globalConfig, globalMaxLeverage: '21' } });
    const pair = makePolicy({ pairConfig: { ...base.pairConfig, pairMaxExposureInr: '499999' } });
    const mode = makePolicy({ modeConfig: { ...base.modeConfig, riskPerTradePercent: '0.9' } });
    expect(global.globalConfig.globalRiskConfigId).not.toBe(base.globalConfig.globalRiskConfigId);
    expect(pair.pairConfig.pairRiskConfigId).not.toBe(base.pairConfig.pairRiskConfigId);
    expect(mode.modeConfig.riskModeConfigId).not.toBe(base.modeConfig.riskModeConfigId);
    expect(new Set([global.riskPolicyId, pair.riskPolicyId, mode.riskPolicyId]).size).toBe(3);
  });

  it('changes source-authority and valuation IDs with their owning fields', () => {
    const base = makePolicy();
    const source = makePolicy({ sourceAuthorityPolicy: { ...base.sourceAuthorityPolicy, pairRiskSourceId: 'pair-source-v2' } });
    const valuation = makePolicy({ valuationPolicy: { ...base.valuationPolicy, valuationUnitScale: 9 } });
    expect(source.sourceAuthorityPolicy.riskSourceAuthorityPolicyId).not.toBe(base.sourceAuthorityPolicy.riskSourceAuthorityPolicyId);
    expect(valuation.valuationPolicy.riskValuationPolicyId).not.toBe(base.valuationPolicy.riskValuationPolicyId);
    expect(source.riskPolicyId).not.toBe(base.riskPolicyId);
    expect(valuation.riskPolicyId).not.toBe(base.riskPolicyId);
  });

  it('keeps the frozen position-sizing policy identity stable', () => {
    const policy = makePolicy();
    expect(computePositionSizingPolicyId()).toBe(policy.positionSizingPolicyId);
    expect(computePositionSizingPolicyId()).toMatch(/^[a-f0-9]{64}$/);
    expect(() => new RiskEngine({ ...policy, positionSizingPolicyId: 'a'.repeat(64) })).toThrow();
  });

  it('changes PositionSizingDecision and RiskDecision IDs when sizing input changes', () => {
    const engine = new RiskEngine(makePolicy());
    const first = makeContext();
    const second = resealContext({ ...first, entryStopProposal: seal({ ...first.entryStopProposal!, stopPriceUsdt: '80' }) });
    expect(engine.evaluatePositionSizing(second).decision.positionSizingDecisionId).not.toBe(engine.evaluatePositionSizing(first).decision.positionSizingDecisionId);
    expect(engine.evaluateRisk(second).riskDecisionId).not.toBe(engine.evaluateRisk(first).riskDecisionId);
  });

  it('changes riskDecisionId when a bound evidence timestamp changes', () => {
    const context = makeContext();
    if (context.accountSnapshot === null) throw new Error('fixture');
    const observedAtMs = EVALUATION_TIME - 1;
    const account = seal({ ...context.accountSnapshot, provenance: { ...context.accountSnapshot.provenance, sourceTimeMs: observedAtMs, observedAtMs } });
    const engine = new RiskEngine(makePolicy());
    expect(engine.evaluateRisk({ ...context, accountSnapshot: account }).riskDecisionId).not.toBe(engine.evaluateRisk(context).riskDecisionId);
  });

  it('normalizes equivalent Decimal config spellings to identical IDs', () => {
    const base = makePolicy();
    const equivalent = makePolicy({ modeConfig: { ...base.modeConfig, riskPerTradePercent: '01.000' } });
    expect(equivalent.modeConfig.riskModeConfigId).toBe(base.modeConfig.riskModeConfigId);
    expect(equivalent.riskPolicyId).toBe(base.riskPolicyId);
  });

  it('rejects unknown canonical policy metadata', () => {
    const base = makePolicy();
    const draft = {
      globalConfig: { globalMaxLeverage: '20', globalMaxOpenNotionalInr: '1000000', globalMaxConcurrentPositions: 20, globalMaxDailyLossInr: '50000', globalDailyLossLimitPercent: null, globalMaxDrawdownPercent: '50', metadata: true },
      pairConfig: { pair: base.pairConfig.pair, pairMaxLeverage: '20', pairMaxExposureInr: '500000', pairMaxConcurrentPositions: 10 },
      modeConfig: { mode: 'NORMAL', riskPerTradePercent: '1', maxNotionalPerTradeInr: '100000', leverageRecommendation: '5', maxConcurrentExposureInr: '800000', maxCoinExposureInr: '400000', maxStrategyExposureInr: '300000', maxConcurrentPositions: 10, maxDailyLossInr: '40000', dailyLossLimitPercent: null, maxDrawdownPercent: '40', consecutiveLossLimit: 3, cooldownMs: 60000 },
      sourceAuthorityPolicy: { accountRiskSourceId: 'account-source', pairRiskSourceId: 'pair-source', exposureSourceId: 'exposure-source', leverageTierSourceId: 'tier-source', conversionSourceId: 'conversion-source' },
      freshnessPolicy: { maxAccountSnapshotAgeMs: 1000, maxPairSnapshotAgeMs: 1000, maxExposureSnapshotAgeMs: 1000, maxLeverageTierSnapshotAgeMs: 1000, maxSettlementRateSnapshotAgeMs: 1000 },
      valuationPolicy: { valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1', valuationPriceField: 'markPriceUsdt', valuationUnitScale: 8, valuationUnitRounding: 'ROUND_HALF_UP' },
    };
    expect(() => createRiskPolicy(draft as unknown as RiskPolicyDraft)).toThrow();
  });
});
