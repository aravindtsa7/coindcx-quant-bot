import { describe, expect, it } from 'vitest';
import { buildExecutionPolicySnapshot, validateExecutionPolicySnapshot, EXECUTION_POLICY_VERSION, type ExecutionPolicySnapshotContent } from '../../../src/execution/policy';
import { PaperEngineError } from '../../../src/execution/errors';

function baseContent(overrides: Partial<ExecutionPolicySnapshotContent> = {}): ExecutionPolicySnapshotContent {
  return {
    policyVersion: EXECUTION_POLICY_VERSION,
    fillSelectionPolicy: 'MARKET_EQUIVALENT_ALL_OR_NONE_V1',
    marketEvidenceEligibilityPolicy: { maxEvidenceAgeMs: 2000, requiredHealthState: 'HEALTHY' },
    takerFeeRate: '0.001',
    slippageBps: '5',
    spreadSemantics: 'BID_ASK_DIRECT',
    tickRoundingPolicy: 'BUY_CEIL_SELL_FLOOR_V1',
    quantityPolicy: 'REJECT_NOT_RESIZE_V1',
    contractMultiplier: '0.001',
    currencyConversionPolicy: 'P14_INR_CONVERSION_V1',
    accountingPolicy: 'P14_INR_CASH_SETTLED_V1',
    executionSemanticsVersion: 'P14_EXECUTION_V1',
    ...overrides,
  };
}

describe('P14-A ExecutionPolicySnapshot identity', () => {
  it('is deterministic for identical content', () => {
    const a = buildExecutionPolicySnapshot(baseContent());
    const b = buildExecutionPolicySnapshot(baseContent());
    expect(a.executionPolicySnapshotId).toBe(b.executionPolicySnapshotId);
  });

  it('hashes equivalent decimal representations identically', () => {
    const a = buildExecutionPolicySnapshot(baseContent({ takerFeeRate: '0.001', slippageBps: '5' }));
    const b = buildExecutionPolicySnapshot(baseContent({ takerFeeRate: '0.0010', slippageBps: '5.0' }));
    expect(a.executionPolicySnapshotId).toBe(b.executionPolicySnapshotId);
  });

  it('changes identity when a material field changes', () => {
    const a = buildExecutionPolicySnapshot(baseContent());
    const b = buildExecutionPolicySnapshot(baseContent({ takerFeeRate: '0.002' }));
    expect(a.executionPolicySnapshotId).not.toBe(b.executionPolicySnapshotId);
  });

  it('changes identity when maxEvidenceAgeMs changes', () => {
    const a = buildExecutionPolicySnapshot(baseContent());
    const b = buildExecutionPolicySnapshot(baseContent({ marketEvidenceEligibilityPolicy: { maxEvidenceAgeMs: 5000, requiredHealthState: 'HEALTHY' } }));
    expect(a.executionPolicySnapshotId).not.toBe(b.executionPolicySnapshotId);
  });

  it('rejects a malformed content object', () => {
    expect(() => buildExecutionPolicySnapshot(baseContent({ fillSelectionPolicy: '' }))).toThrow(PaperEngineError);
    expect(() => buildExecutionPolicySnapshot(baseContent({ takerFeeRate: 'not-a-decimal' }))).toThrow(PaperEngineError);
    expect(() => buildExecutionPolicySnapshot(baseContent({ marketEvidenceEligibilityPolicy: { maxEvidenceAgeMs: -1, requiredHealthState: 'HEALTHY' } }))).toThrow(PaperEngineError);
  });

  it('recomputes and accepts the canonical ID/content pair', () => {
    const snapshot = buildExecutionPolicySnapshot(baseContent());
    expect(validateExecutionPolicySnapshot(snapshot)).toEqual(snapshot);
  });

  it('rejects an ID(A) + content(B) spoof', () => {
    const a = buildExecutionPolicySnapshot(baseContent());
    const b = buildExecutionPolicySnapshot(baseContent({ takerFeeRate: '0.002' }));
    expect(() => validateExecutionPolicySnapshot({ executionPolicySnapshotId: a.executionPolicySnapshotId, content: b.content }))
      .toThrow(/POLICY_IDENTITY_MISMATCH/);
  });

  it.each([
    ['negative fee', { takerFeeRate: '-0.001' }],
    ['negative slippage', { slippageBps: '-0.001' }],
    ['10000 bps slippage', { slippageBps: '10000' }],
    ['over-10000 bps slippage', { slippageBps: '10000.0001' }],
    ['zero multiplier', { contractMultiplier: '0' }],
    ['negative multiplier', { contractMultiplier: '-0.001' }],
    ['excess scale fee', { takerFeeRate: '0.0000000000000000001' }],
    ['overflow multiplier', { contractMultiplier: '1000000000000000000' }],
  ] satisfies readonly [string, Partial<ExecutionPolicySnapshotContent>][])('rejects %s before use', (_label, overrides) => {
    expect(() => buildExecutionPolicySnapshot(baseContent(overrides))).toThrow(PaperEngineError);
  });

  it('allows exact zero fee and zero slippage', () => {
    const snapshot = buildExecutionPolicySnapshot(baseContent({ takerFeeRate: '0', slippageBps: '0' }));
    expect(snapshot.content.takerFeeRate).toBe('0');
    expect(snapshot.content.slippageBps).toBe('0');
  });

  it('rejects maxEvidenceAgeMs outside the persisted 32-bit integer domain', () => {
    expect(() => buildExecutionPolicySnapshot(baseContent({
      marketEvidenceEligibilityPolicy: { maxEvidenceAgeMs: 2_147_483_648, requiredHealthState: 'HEALTHY' },
    }))).toThrow(PaperEngineError);
  });
});
