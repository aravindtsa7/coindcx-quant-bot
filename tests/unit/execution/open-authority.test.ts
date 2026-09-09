import { describe, expect, it } from 'vitest';
import { RiskAdmissionCoordinator } from '../../../src/dispatch/admission';
import { mintPaperOpenExecutionAuthority, PaperOpenExecutionAuthority, type PaperOpenRiskEvidence } from '../../../src/execution/open-authority';
import { PaperEngineError } from '../../../src/execution/errors';
import { buildContext, evaluateDecision, genuineResearchApproval, makeKernel, policyFor } from '../dispatch/helpers';
import { makeAccount, seal } from '../risk/helpers';
import type { RiskEvaluationContext } from '../../../src/risk';

const ACCOUNT = 'account-open-authority';
const T0 = 1_200_000;

function evidenceFrom(context: RiskEvaluationContext): PaperOpenRiskEvidence {
  const { strategyOrigin: _strategyOrigin, candidate: _candidate, ...evidence } = context;
  return evidence;
}

describe('P14-A PaperOpenExecutionAuthority — genuine trusted composition', () => {
  it('mints a genuine authority when research approval + kernel origin + admission all succeed', async () => {
    const { result } = await genuineResearchApproval();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const context = buildContext(kernel, decision);
    const authority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId: ACCOUNT, kernel, decision, instrumentSpecSnapshotId: 'instrument-1',
      planResult: result, policy: policyFor(), evidence: evidenceFrom(context),
    });
    expect(authority).not.toBeNull();
    const record = PaperOpenExecutionAuthority.read(authority);
    expect(record).not.toBeNull();
    expect(record?.accountId).toBe(ACCOUNT);
    expect(record?.decision.action).toBe('OPEN');
    expect(record?.admission.status).toBe('ADMITTED');
    expect(record?.admission.sourceStrategyDecisionId).toBe(decision.decisionId);
    expect(record?.researchApproval.pair).toBe(kernel.pair);
    expect(record?.researchApproval.strategyId).toBe(kernel.strategyId);
    expect(record?.strategyOrigin.decision.decisionId).toBe(decision.decisionId);
  }, 30_000);

  it('returns null (never throws) when no genuine research approval exists for the subject', async () => {
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const context = buildContext(kernel, decision);
    const notGenuine = { validationPlanId: 'fake-plan', subjectResults: [] } as never;
    const authority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId: ACCOUNT, kernel, decision, instrumentSpecSnapshotId: 'instrument-1',
      planResult: notGenuine, policy: policyFor(), evidence: evidenceFrom(context),
    });
    expect(authority).toBeNull();
  });

  it('returns null when the genuine approval is bound to a different pair than the dispatched kernel', async () => {
    const { result } = await genuineResearchApproval();
    const otherKernel = makeKernel('B-ETH_USDT');
    const decision = evaluateDecision(otherKernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const context = buildContext(otherKernel, decision);
    const authority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId: ACCOUNT, kernel: otherKernel, decision, instrumentSpecSnapshotId: 'instrument-1',
      planResult: result, policy: policyFor(), evidence: evidenceFrom(context),
    });
    expect(authority).toBeNull();
  }, 30_000);

  it('returns null when the coordinator genuinely rejects admission (RiskEngine rejection propagates, no authority minted)', async () => {
    const { result } = await genuineResearchApproval();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const impossibleAccount = seal({ ...makeAccount(), lockedMarginInr: '-1' });
    const context = buildContext(kernel, decision, { accountSnapshot: impossibleAccount });
    const authority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId: ACCOUNT, kernel, decision, instrumentSpecSnapshotId: 'instrument-1',
      planResult: result, policy: policyFor(), evidence: evidenceFrom(context),
    });
    expect(authority).toBeNull();
  }, 30_000);
});

describe('P14-A PaperOpenExecutionAuthority — forgery resistance', () => {
  it('rejects direct construction with a foreign issuer symbol (forged capability)', () => {
    const forged = () => new PaperOpenExecutionAuthority(Symbol('forged'), {
      accountId: 'x', admission: {} as never, decision: {} as never, researchApproval: {} as never, strategyOrigin: {} as never,
    });
    expect(forged).toThrow(PaperEngineError);
  });

  it('.read() rejects a caller-shaped object with byte-identical-looking fields', async () => {
    const { result } = await genuineResearchApproval();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const context = buildContext(kernel, decision);
    const authority = await mintPaperOpenExecutionAuthority({
      coordinator, accountId: ACCOUNT, kernel, decision, instrumentSpecSnapshotId: 'instrument-1',
      planResult: result, policy: policyFor(), evidence: evidenceFrom(context),
    });
    const genuine = PaperOpenExecutionAuthority.read(authority);
    expect(genuine).not.toBeNull();
    expect(PaperOpenExecutionAuthority.read({ ...genuine })).toBeNull();
  }, 30_000);

  it('a raw AdmissionOutcome — even a genuine ADMITTED one — is never itself OPEN authority', async () => {
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const outcome = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) });
    expect(outcome.status).toBe('ADMITTED');
    expect(PaperOpenExecutionAuthority.read(outcome)).toBeNull();
  });

  it('a raw AcceptedOpenRiskDecision is never itself OPEN authority', async () => {
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const outcome = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) });
    if (outcome.status !== 'ADMITTED') throw new Error('fixture');
    expect(PaperOpenExecutionAuthority.read(outcome.decision)).toBeNull();
  });

  it('a raw AdmissionRecord is never itself OPEN authority', async () => {
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const coordinator = new RiskAdmissionCoordinator();
    const outcome = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) });
    if (outcome.status !== 'ADMITTED') throw new Error('fixture');
    expect(PaperOpenExecutionAuthority.read(outcome.admission)).toBeNull();
  });
});
