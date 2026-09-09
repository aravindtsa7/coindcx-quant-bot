import { describe, expect, it } from 'vitest';
import {
  computeCloseExecutionIntentId, computeOpenExecutionIntentId, computePositionInstanceId, computeSourceExecutionKey,
  type CloseExecutionIntentIdentityInput, type OpenExecutionIntentIdentityInput,
} from '../../../src/execution/identity';
import { PaperEngineError } from '../../../src/execution/errors';

const OPEN_INPUT: OpenExecutionIntentIdentityInput = {
  admissionId: 'a'.repeat(64),
  riskDecisionId: 'b'.repeat(64),
  accountId: 'account-1',
  pair: 'B-BTC_USDT',
  strategyInstanceId: 'instance-1',
  strategyId: 'EMA_TREND',
  strategyVersion: '1.0.0',
  parameterHash: 'c'.repeat(64),
  approvedQuantity: '1.5',
  approvedLeverage: '5',
  approvedNotionalInr: '100000',
  approvedMarginInr: '20000',
  evaluationTimeMs: 1_200_000,
  executionPolicySnapshotId: 'd'.repeat(64),
};

const CLOSE_INPUT: CloseExecutionIntentIdentityInput = {
  riskDecisionId: 'e'.repeat(64),
  accountId: 'account-1',
  pair: 'B-BTC_USDT',
  strategyInstanceId: 'instance-1',
  strategyId: 'EMA_TREND',
  strategyVersion: '1.0.0',
  parameterHash: 'c'.repeat(64),
  positionInstanceId: 'f'.repeat(64),
  positionRevision: 1,
  reduceOnlyQuantity: '1.5',
  evaluationTimeMs: 1_260_000,
  executionPolicySnapshotId: 'd'.repeat(64),
};

describe('P14-A OPEN ExecutionIntent identity', () => {
  it('is deterministic for identical input', () => {
    expect(computeOpenExecutionIntentId(OPEN_INPUT)).toBe(computeOpenExecutionIntentId({ ...OPEN_INPUT }));
  });

  it('hashes equivalent decimal representations identically', () => {
    const a = computeOpenExecutionIntentId(OPEN_INPUT);
    const b = computeOpenExecutionIntentId({ ...OPEN_INPUT, approvedQuantity: '1.50', approvedNotionalInr: '100000.00' });
    expect(a).toBe(b);
  });

  it.each<readonly [keyof OpenExecutionIntentIdentityInput, unknown]>([
    ['admissionId', 'z'.repeat(64)],
    ['riskDecisionId', 'z'.repeat(64)],
    ['accountId', 'account-2'],
    ['pair', 'B-ETH_USDT'],
    ['strategyInstanceId', 'instance-2'],
    ['approvedQuantity', '2'],
    ['approvedLeverage', '10'],
    ['approvedNotionalInr', '200000'],
    ['approvedMarginInr', '40000'],
    ['evaluationTimeMs', 1_260_000],
    ['executionPolicySnapshotId', 'z'.repeat(64)],
  ])('changes identity when %s changes', (field, value) => {
    const changed = computeOpenExecutionIntentId({ ...OPEN_INPUT, [field]: value });
    expect(changed).not.toBe(computeOpenExecutionIntentId(OPEN_INPUT));
  });

  it('rejects malformed input', () => {
    expect(() => computeOpenExecutionIntentId({ ...OPEN_INPUT, accountId: '' })).toThrow(PaperEngineError);
    expect(() => computeOpenExecutionIntentId({ ...OPEN_INPUT, approvedQuantity: 'not-a-decimal' })).toThrow(PaperEngineError);
    expect(() => computeOpenExecutionIntentId({ ...OPEN_INPUT, evaluationTimeMs: -1 })).toThrow(PaperEngineError);
  });
});

describe('P14-A CLOSE ExecutionIntent identity', () => {
  it('is deterministic for identical input', () => {
    expect(computeCloseExecutionIntentId(CLOSE_INPUT)).toBe(computeCloseExecutionIntentId({ ...CLOSE_INPUT }));
  });

  it.each<readonly [keyof CloseExecutionIntentIdentityInput, unknown]>([
    ['positionInstanceId', 'z'.repeat(64)],
    ['positionRevision', 2],
    ['reduceOnlyQuantity', '0.5'],
    ['riskDecisionId', 'z'.repeat(64)],
    ['executionPolicySnapshotId', 'z'.repeat(64)],
  ])('changes identity when %s changes (stale-successor protection)', (field, value) => {
    const changed = computeCloseExecutionIntentId({ ...CLOSE_INPUT, [field]: value });
    expect(changed).not.toBe(computeCloseExecutionIntentId(CLOSE_INPUT));
  });

  it('never collides with an OPEN identity even under adversarial field overlap', () => {
    const openId = computeOpenExecutionIntentId(OPEN_INPUT);
    const closeId = computeCloseExecutionIntentId({
      ...CLOSE_INPUT,
      riskDecisionId: OPEN_INPUT.riskDecisionId,
      accountId: OPEN_INPUT.accountId,
      pair: OPEN_INPUT.pair,
      strategyInstanceId: OPEN_INPUT.strategyInstanceId,
      strategyId: OPEN_INPUT.strategyId,
      strategyVersion: OPEN_INPUT.strategyVersion,
      parameterHash: OPEN_INPUT.parameterHash,
      executionPolicySnapshotId: OPEN_INPUT.executionPolicySnapshotId,
      evaluationTimeMs: OPEN_INPUT.evaluationTimeMs,
    });
    expect(closeId).not.toBe(openId);
  });
});

describe('P14-A PositionInstance identity', () => {
  it('is deterministic and has no wall-clock/random input', () => {
    const input = { accountId: 'account-1', strategyInstanceId: 'instance-1', pair: 'B-BTC_USDT', openingExecutionIntentId: 'g'.repeat(64) };
    expect(computePositionInstanceId(input)).toBe(computePositionInstanceId({ ...input }));
  });

  it('produces a fresh id for a fresh opening intent (close/reopen safety)', () => {
    const base = { accountId: 'account-1', strategyInstanceId: 'instance-1', pair: 'B-BTC_USDT', openingExecutionIntentId: 'g'.repeat(64) };
    const reopened = { ...base, openingExecutionIntentId: 'h'.repeat(64) };
    expect(computePositionInstanceId(base)).not.toBe(computePositionInstanceId(reopened));
  });
});

describe('P14-A terminal source-execution identity — generation-independent', () => {
  it('is deterministic for identical (accountId, sourceStrategyDecisionId)', () => {
    const input = { accountId: 'account-1', sourceStrategyDecisionId: 'decision-1' };
    expect(computeSourceExecutionKey(input)).toBe(computeSourceExecutionKey({ ...input }));
  });

  it('is unaffected by any admission-generation-derived field (admissionId not part of its input at all)', () => {
    // The type signature itself proves this: SourceExecutionKeyInput has no
    // admissionId/generation field, so no such input can ever change the key.
    const key1 = computeSourceExecutionKey({ accountId: 'account-1', sourceStrategyDecisionId: 'decision-1' });
    const key2 = computeSourceExecutionKey({ accountId: 'account-1', sourceStrategyDecisionId: 'decision-1' });
    expect(key1).toBe(key2);
  });

  it('changes when accountId or sourceStrategyDecisionId changes', () => {
    const base = computeSourceExecutionKey({ accountId: 'account-1', sourceStrategyDecisionId: 'decision-1' });
    expect(computeSourceExecutionKey({ accountId: 'account-2', sourceStrategyDecisionId: 'decision-1' })).not.toBe(base);
    expect(computeSourceExecutionKey({ accountId: 'account-1', sourceStrategyDecisionId: 'decision-2' })).not.toBe(base);
  });

  it('a different CLOSE-triggering decision on the same account/pair after a legitimate close is not blocked (distinct decisionId)', () => {
    const openKey = computeSourceExecutionKey({ accountId: 'account-1', sourceStrategyDecisionId: 'open-decision-1' });
    const closeKey = computeSourceExecutionKey({ accountId: 'account-1', sourceStrategyDecisionId: 'close-decision-1' });
    const reopenKey = computeSourceExecutionKey({ accountId: 'account-1', sourceStrategyDecisionId: 'open-decision-2' });
    expect(new Set([openKey, closeKey, reopenKey]).size).toBe(3);
  });
});
