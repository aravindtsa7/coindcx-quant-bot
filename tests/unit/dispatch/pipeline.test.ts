import { describe, expect, it } from 'vitest';
import { RiskAdmissionCoordinator } from '../../../src/dispatch/admission';
import { dispatchStrategyDecision, type DispatchRequest } from '../../../src/dispatch/pipeline';
import { issueResearchApprovalOrigin } from '../../../src/research/research-validation';
import { riskDecimal } from '../../../src/risk';
import { emaTrendV1Definition, type StrategyDecision, type StrategyKernel } from '../../../src/strategies';
import { buildContext, evaluateDecision, genuineResearchApproval, makeKernel, PAIR, policyFor } from './helpers';

const ACCOUNT = 'account-1';
const T0 = 1_200_000;

function requestFor(kernel: StrategyKernel, decision: StrategyDecision, researchApproval: DispatchRequest['researchApproval']): DispatchRequest {
  const context = buildContext(kernel, decision);
  return {
    kernel, decision, instrumentSpecSnapshotId: 'instrument-1', researchApproval, accountId: ACCOUNT, policy: policyFor(),
    entryStopProposal: context.entryStopProposal, leverageProposal: context.leverageProposal, override: context.override, evaluationTimeMs: context.evaluationTimeMs,
    accountSnapshot: context.accountSnapshot, pairSnapshot: context.pairSnapshot, exposureSnapshot: context.exposureSnapshot,
    leverageTierSnapshot: context.leverageTierSnapshot, settlementRateSnapshot: context.settlementRateSnapshot,
  };
}

// Wave C3 composition — the one production path (research authority -> authorized
// dispatch -> RiskEngine -> admission) end to end, per docs/RISK_LEVERAGE_ENGINE.md
// and the Wave C3 report's diagram. Section 19 A-F.
describe('C-F06 + C-F07 composition', () => {
  it('A: a research-authorized decision reaches risk acceptance and admission succeeds', async () => {
    const { origin } = await genuineResearchApproval();
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const outcome = await dispatchStrategyDecision(coordinator, requestFor(kernel, decision, origin));
    expect(outcome.stage).toBe('ADMISSION');
    if (outcome.stage !== 'ADMISSION') return;
    expect(outcome.status).toBe('ADMITTED');
  }, 30_000);

  it('B: an unapproved (null research approval) decision is never admitted', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const outcome = await dispatchStrategyDecision(coordinator, requestFor(kernel, decision, null));
    expect(outcome.stage).toBe('RESEARCH_UNAUTHORIZED');
  });

  it('C: a genuine PASSED approval for a different parameterHash never authorizes this kernel\'s dispatch', async () => {
    const { origin } = await genuineResearchApproval();
    const coordinator = new RiskAdmissionCoordinator();
    // A kernel with different parameters than the genuinely-approved subject.
    const mismatchedKernel = emaTrendV1Definition.createKernel({
      pair: PAIR, parameters: { timeframeMinutes: 1, fastPeriod: 2, slowPeriod: 3, priceSource: 'CLOSE' }, indicatorBootstrapIdentity: [{ timeframeMinutes: 1, bootstrapStartOpenTimeMs: 0 }],
    });
    const decision = evaluateDecision(mismatchedKernel, T0);
    const outcome = await dispatchStrategyDecision(coordinator, requestFor(mismatchedKernel, decision, origin));
    expect(outcome.stage).toBe('DISPATCH_UNAUTHORIZED');
  }, 30_000);

  it('D: a stale/duplicate decision under valid research approval never double-allocates', async () => {
    const { origin } = await genuineResearchApproval();
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const request = requestFor(kernel, decision, origin);
    const [first, second] = await Promise.all([dispatchStrategyDecision(coordinator, request), dispatchStrategyDecision(coordinator, request)]);
    expect(first.stage).toBe('ADMISSION'); expect(second.stage).toBe('ADMISSION');
    if (first.stage !== 'ADMISSION' || second.stage !== 'ADMISSION' || first.status !== 'ADMITTED' || second.status !== 'ADMITTED') throw new Error('fixture requires a genuine admission');
    expect(second.admission.admissionId).toBe(first.admission.admissionId);
  }, 30_000);

  it('E: two independently research-approved strategy instances competing for one account preserve combined capacity', async () => {
    const { origin } = await genuineResearchApproval();
    const coordinator = new RiskAdmissionCoordinator();
    const kernelA = makeKernel();
    const kernelB = emaTrendV1Definition.createKernel({ pair: PAIR, parameters: { timeframeMinutes: 1, fastPeriod: 1, slowPeriod: 2, priceSource: 'CLOSE' }, indicatorBootstrapIdentity: [{ timeframeMinutes: 1, bootstrapStartOpenTimeMs: 60_000 }] });
    expect(kernelA.strategyInstanceId).not.toBe(kernelB.strategyInstanceId);
    expect(kernelA.parameterHash).toBe(kernelB.parameterHash); // both genuinely authorized by the same PASSED subject
    const decisionA = evaluateDecision(kernelA, T0);
    const decisionB = evaluateDecision(kernelB, T0);
    const [outcomeA, outcomeB] = await Promise.all([
      dispatchStrategyDecision(coordinator, requestFor(kernelA, decisionA, origin)),
      dispatchStrategyDecision(coordinator, requestFor(kernelB, decisionB, origin)),
    ]);
    for (const outcome of [outcomeA, outcomeB]) expect(outcome.stage).toBe('ADMISSION');
    const admittedNotional = [outcomeA, outcomeB]
      .filter((outcome): outcome is Extract<typeof outcome, { readonly stage: 'ADMISSION'; readonly status: 'ADMITTED' }> => outcome.stage === 'ADMISSION' && outcome.status === 'ADMITTED')
      .reduce((sum, outcome) => sum.plus(outcome.admission.approvedNotionalInr), riskDecimal('0'));
    // Whatever the split, combined admitted notional must respect the account's own
    // configured global cap (the default policy's globalMaxOpenNotionalInr).
    expect(admittedNotional.lte(policyFor().globalConfig.globalMaxOpenNotionalInr)).toBe(true);
  }, 30_000);

  it('F: an origin genuinely issued from one research result does not authorize dispatch against an unrelated subject query (no supersession confusion)', async () => {
    const { result, origin } = await genuineResearchApproval();
    // There is no live "revoke" registry in the current architecture (Phase 13 does
    // not implement a persistent research-authority store) — the only meaningful,
    // currently-supported analog is that an origin's bound identity is fixed at
    // issuance and cannot be reinterpreted against a different subject query.
    const unrelatedSubjectQuery = issueResearchApprovalOrigin(result, { pair: PAIR, strategyId: 'EMA_TREND', strategyVersion: '1.0.0', parameterHash: 'f'.repeat(64) });
    expect(unrelatedSubjectQuery).toBeNull();
    expect(origin).not.toBeNull();
  }, 30_000);
});
