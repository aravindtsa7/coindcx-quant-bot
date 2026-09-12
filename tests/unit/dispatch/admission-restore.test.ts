import { describe, expect, it } from 'vitest';
import { RiskAdmissionCoordinator } from '../../../src/dispatch/admission';
import type { AdmissionRecord } from '../../../src/dispatch';
import { buildContext, evaluateDecision, makeKernel, policyFor, PAIR } from './helpers';

const ACCOUNT = 'account-restore-1';
const T0 = 1_200_000;

function baseRecord(overrides: Partial<AdmissionRecord> = {}): AdmissionRecord {
  return Object.freeze({
    admissionId: 'a'.repeat(64), generation: 1, accountId: ACCOUNT, riskDecisionId: 'r'.repeat(64),
    sourceStrategyDecisionId: 'decision-1', strategyInstanceId: 'instance-1', strategyId: 'EMA_TREND', strategyVersion: '1.0.0',
    parameterHash: 'p'.repeat(64), pair: PAIR, decisionSequence: 1, direction: 'LONG', approvedNotionalInr: '10000',
    approvedMarginInr: '2000', status: 'ADMITTED',
    ...overrides,
  });
}

describe('P14-D RiskAdmissionCoordinator.restore — validation (V2 §18/§20, pure in-memory, no DB)', () => {
  it('restores a valid ADMITTED record and its sequence watermark without error', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    await expect(coordinator.restore(ACCOUNT, [baseRecord()], [{ strategyInstanceId: 'instance-1', latestDecisionSequence: 1 }])).resolves.toBeUndefined();
  });

  it('rejects restoring into an account that already has in-memory admission state', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const outcome = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) });
    expect(outcome.status).toBe('ADMITTED');
    await expect(coordinator.restore(ACCOUNT, [], [])).rejects.toThrow(/already has in-memory admission state/);
  });

  it('rejects a record whose accountId does not match the account being restored', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    await expect(coordinator.restore(ACCOUNT, [baseRecord({ accountId: 'someone-else' })], [])).rejects.toThrow(/does not match/);
  });

  it('rejects a non-ADMITTED record — restore only ever re-seeds currently-pending capacity', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    await expect(coordinator.restore(ACCOUNT, [baseRecord({ status: 'RELEASED' })], [])).rejects.toThrow(/only currently-pending capacity/);
  });

  it('rejects duplicate sourceStrategyDecisionId within one restore batch', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const first = baseRecord({ admissionId: 'a'.repeat(64) });
    const second = baseRecord({ admissionId: 'b'.repeat(64) });
    await expect(coordinator.restore(ACCOUNT, [first, second], [])).rejects.toThrow(/duplicate sourceStrategyDecisionId/);
  });

  it('rejects a malformed (negative) sequence watermark', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    await expect(coordinator.restore(ACCOUNT, [], [{ strategyInstanceId: 'instance-1', latestDecisionSequence: -1 }])).rejects.toThrow(/malformed sequence watermark/);
  });

  it('rejects a duplicate watermark for the same strategyInstanceId in one batch', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const watermarks = [{ strategyInstanceId: 'instance-1', latestDecisionSequence: 1 }, { strategyInstanceId: 'instance-1', latestDecisionSequence: 2 }];
    await expect(coordinator.restore(ACCOUNT, [], watermarks)).rejects.toThrow(/duplicate watermark/);
  });

  it('is all-or-nothing: a validation failure partway through leaves no partial state committed', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const valid = baseRecord({ admissionId: 'a'.repeat(64), sourceStrategyDecisionId: 'decision-1' });
    const invalid = baseRecord({ admissionId: 'b'.repeat(64), sourceStrategyDecisionId: 'decision-2', accountId: 'wrong-account' });
    await expect(coordinator.restore(ACCOUNT, [valid, invalid], [])).rejects.toThrow();
    // A second, fully-valid restore attempt for the same account must still succeed —
    // proving nothing was partially committed by the failed attempt above.
    await expect(coordinator.restore(ACCOUNT, [valid], [])).resolves.toBeUndefined();
  });

  it('a restored watermark correctly rejects a genuine decision whose sequence it already exceeds', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0); // a fresh kernel's first decision always carries decisionSequence === 1
    expect(decision.decisionSequence).toBe(1);
    await coordinator.restore(ACCOUNT, [], [{ strategyInstanceId: kernel.strategyInstanceId, latestDecisionSequence: 5 }]);
    const outcome = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) });
    expect(outcome.status).toBe('STALE_DECISION_SEQUENCE');
    if (outcome.status !== 'STALE_DECISION_SEQUENCE') return;
    expect(outcome.latestAdmittedSequence).toBe(5);
  });
});
