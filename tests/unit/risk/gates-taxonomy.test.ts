import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GROUP_A_REASON_CODES, GROUP_B_REASON_CODES, REJECTION_PRECEDENCE_V1, RiskConfigError, RiskEngine, type RiskEvaluationContext,
} from '../../../src/risk';
import { assertRejectionPrecedenceIntegrity } from '../../../src/risk/reason-codes';
import { EVALUATION_TIME, makeAccount, makeContext, makeExposure, makePolicy, resealContext, seal } from './helpers';

function run(changes: Partial<RiskEvaluationContext> = {}, policy = makePolicy()) {
  return new RiskEngine(policy).evaluateRisk(resealContext(makeContext(changes)));
}
function codes(result: ReturnType<typeof run>): readonly string[] {
  return result.status === 'REJECTED' ? [result.primaryReasonCode, ...result.secondaryReasonCodes] : [];
}

describe('Phase 13 source time, loss/drawdown, taxonomy, and numeric safety', () => {
  it('rejects a future observed timestamp as causality, never staleness', () => {
    const context = makeContext();
    const pair = seal({ ...context.pairSnapshot, provenance: { ...context.pairSnapshot.provenance, sourceTimeMs: EVALUATION_TIME, observedAtMs: EVALUATION_TIME + 1 } });
    const result = run({ pairSnapshot: pair });
    expect(codes(result)).toContain('EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION');
    expect(codes(result)).not.toContain('PAIR_STATE_UNAVAILABLE');
  });

  it('rejects a future source timestamp as causality', () => {
    const context = makeContext();
    const pair = seal({ ...context.pairSnapshot, provenance: { ...context.pairSnapshot.provenance, sourceTimeMs: EVALUATION_TIME + 1, observedAtMs: EVALUATION_TIME } });
    expect(codes(run({ pairSnapshot: pair }))).toContain('EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION');
  });

  it('classifies causally-valid old settlement evidence as stale', () => {
    const context = makeContext();
    if (context.settlementRateSnapshot === null) throw new Error('fixture');
    const old = EVALUATION_TIME - 1001;
    const settlement = seal({ ...context.settlementRateSnapshot, provenance: { ...context.settlementRateSnapshot.provenance, sourceTimeMs: old, observedAtMs: old } });
    const result = run({ settlementRateSnapshot: settlement });
    expect(codes(result)).toContain('SETTLEMENT_RATE_STALE');
    expect(codes(result)).not.toContain('EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION');
  });

  it('accepts exact source/observed/evaluation timestamp equality', () => {
    expect(run().status).toBe('ACCEPTED');
  });

  it.each([
    ['100', '0', '0', '0', '100', false],
    ['0', '0', '0', '0', '0', false],
    ['0', '0', '99', '0', '-99', false],
    ['0', '0', '100', '0', '-100', true],
    ['0', '0', '101', '0', '-101', true],
    ['50', '0', '150', '0', '-100', true],
    ['-100', '100', '0', '0', '0', false],
    ['-50', '-50', '0', '0', '-100', true],
  ] as const)('applies exact daily-loss formula and INR boundary', (trading, funding, fees, adjustments, net, rejected) => {
    const base = makePolicy();
    const policy = makePolicy({ globalConfig: { ...base.globalConfig, globalMaxDailyLossInr: '100' }, modeConfig: { ...base.modeConfig, maxDailyLossInr: '100' } });
    const account = seal({ ...makeAccount(), dailyPnl: { realizedTradingPnlInr: trading, fundingPnlInr: funding, feesInr: fees, otherAccountAdjustmentsInr: adjustments, netDailyPnlInr: net } });
    expect(codes(run({ accountSnapshot: account }, policy)).includes('DAILY_LOSS_LIMIT')).toBe(rejected);
  });

  it('rejects drawdown at the exact configured boundary', () => {
    const account = seal({ ...makeAccount(), currentEquityInr: '60000', peakEquityInr: '100000' });
    expect(codes(run({ accountSnapshot: account }))).toContain('DRAWDOWN_LIMIT');
  });

  it('enforces consecutive-loss cooldown strictly before its end', () => {
    const account = seal({ ...makeAccount(), consecutiveLossCount: 3, cooldownActiveUntilMs: EVALUATION_TIME + 1 });
    expect(codes(run({ accountSnapshot: account }))).toContain('CONSECUTIVE_LOSS_COOLDOWN_ACTIVE');
    const elapsed = seal({ ...account, cooldownActiveUntilMs: EVALUATION_TIME });
    expect(codes(run({ accountSnapshot: elapsed }))).not.toContain('CONSECUTIVE_LOSS_COOLDOWN_ACTIVE');
  });

  it.each([
    ['globalOpenNotionalInr', '800000', 'GLOBAL_EXPOSURE_LIMIT'],
  ] as const)('enforces gross exposure without opposite-direction netting', (field, value, code) => {
    const exposure = seal({ ...makeExposure(), [field]: value });
    expect(codes(run({ exposureSnapshot: exposure }))).toContain(code);
  });

  it('enforces pair, strategy, and concurrent-position limits', () => {
    const exposure = seal({ ...makeExposure(), perPairOpenNotionalInr: { 'B-BTC_USDT': '400000' }, perStrategyOpenNotionalInr: { 'strategy-1': '300000' }, concurrentOpenPositions: 10 });
    const resultCodes = codes(run({ exposureSnapshot: exposure }));
    expect(resultCodes).toContain('PAIR_EXPOSURE_LIMIT');
    expect(resultCodes).toContain('STRATEGY_EXPOSURE_LIMIT');
    expect(resultCodes).toContain('MAX_CONCURRENT_POSITIONS');
  });

  it('has exactly 39 unique evaluation codes in taxonomy and precedence', () => {
    const taxonomy = [...GROUP_A_REASON_CODES, ...GROUP_B_REASON_CODES];
    expect(taxonomy).toHaveLength(39);
    expect(REJECTION_PRECEDENCE_V1).toHaveLength(39);
    expect(new Set(REJECTION_PRECEDENCE_V1).size).toBe(39);
    expect(new Set(REJECTION_PRECEDENCE_V1)).toEqual(new Set(taxonomy));
    expect(() => assertRejectionPrecedenceIntegrity()).not.toThrow();
  });

  it('rejects duplicate and missing precedence entries at construction validation', () => {
    expect(() => assertRejectionPrecedenceIntegrity(REJECTION_PRECEDENCE_V1.slice(1))).toThrowError(RiskConfigError);
    expect(() => assertRejectionPrecedenceIntegrity([...REJECTION_PRECEDENCE_V1, REJECTION_PRECEDENCE_V1[0] as string])).toThrowError(RiskConfigError);
  });

  it('orders simultaneous reasons only by the canonical precedence table', () => {
    const context = makeContext();
    if (context.accountSnapshot === null) throw new Error('fixture');
    const account = { ...context.accountSnapshot, accountId: 'wrong', provenance: { ...context.accountSnapshot.provenance, sourceId: 'wrong-source', contentSha256: 'b'.repeat(64) } };
    const engine = new RiskEngine(makePolicy());
    const first = engine.evaluateRisk({ ...context, accountSnapshot: account });
    const second = engine.evaluateRisk({ ...context, accountSnapshot: { provenance: account.provenance, reconciliationSourceIds: account.reconciliationSourceIds, accountMaxLeverage: account.accountMaxLeverage,
      cooldownActiveUntilMs: account.cooldownActiveUntilMs, consecutiveLossCount: account.consecutiveLossCount, dailyPnl: account.dailyPnl, peakEquityInr: account.peakEquityInr,
      currentEquityInr: account.currentEquityInr, lockedMarginInr: account.lockedMarginInr, availableMarginInr: account.availableMarginInr, accountStateKnown: account.accountStateKnown, accountId: account.accountId } });
    expect(second.status).toBe('REJECTED');
    if (first.status === 'REJECTED' && second.status === 'REJECTED') {
      expect([second.primaryReasonCode, ...second.secondaryReasonCodes]).toEqual([first.primaryReasonCode, ...first.secondaryReasonCodes]);
      expect(first.primaryReasonCode).toBe('DECISION_IDENTITY_MISMATCH');
    }
  });

  it('contains no native floating-point financial conversion path', () => {
    const files = ['decimal.ts', 'valuation.ts', 'tier-resolution.ts', 'position-sizing.ts', 'exposure.ts', 'loss-drawdown.ts'];
    const source = files.map((file) => readFileSync(`src/risk/${file}`, 'utf8')).join('\n');
    expect(source).not.toMatch(/parseFloat|\.toNumber\(|Number\s*\(/);
  });
});
