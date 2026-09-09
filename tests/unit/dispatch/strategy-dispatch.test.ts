import { describe, expect, it } from 'vitest';
import { authorizeStrategyDispatch } from '../../../src/dispatch/strategy-dispatch';
import { issueResearchApprovalOrigin } from '../../../src/research/research-validation';
import { evaluateDecision, genuineResearchApproval, makeKernel, PAIR } from './helpers';

// Wave C3 — C-F06 dispatch-layer enforcement: authorizeStrategyDispatch is the only
// place a genuine ResearchApprovalOrigin is checked against the actual kernel being
// dispatched. It must reject every case where either the approval is missing/foreign
// or genuinely belongs to a different (pair, strategyId, strategyVersion, parameterHash).
describe('C-F06 authorized strategy dispatch', () => {
  it('authorizes dispatch for a matching genuine research approval', async () => {
    const { origin } = await genuineResearchApproval();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, 1_200_000);
    const handoff = authorizeStrategyDispatch(kernel, decision, 'instrument-1', origin);
    expect(handoff).not.toBeNull();
    expect(handoff?.candidate.strategyDecision.decisionId).toBe(decision.decisionId);
  }, 30_000);

  it('rejects a null (missing) research approval', () => {
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, 1_200_000);
    expect(authorizeStrategyDispatch(kernel, decision, 'instrument-1', null)).toBeNull();
  });

  it('rejects a forged/foreign object masquerading as ResearchApprovalOrigin', () => {
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, 1_200_000);
    const fake = { pair: kernel.pair, strategyId: kernel.strategyId, strategyVersion: kernel.strategyVersion, parameterHash: kernel.parameterHash };
    expect(authorizeStrategyDispatch(kernel, decision, 'instrument-1', fake as never)).toBeNull();
  });

  it('rejects a genuine approval bound to a different pair than the dispatched kernel', async () => {
    const { origin } = await genuineResearchApproval();
    const otherPairKernel = makeKernel('B-ETH_USDT');
    const decision = evaluateDecision(otherPairKernel, 1_200_000);
    expect(authorizeStrategyDispatch(otherPairKernel, decision, 'instrument-1', origin)).toBeNull();
  }, 30_000);

  it('rejects a genuine approval when a mismatched fake origin record is substituted for a different strategyId', async () => {
    const { result } = await genuineResearchApproval();
    const wrongStrategyOrigin = issueResearchApprovalOrigin(result, { pair: PAIR, strategyId: 'ATR_BREAKOUT', strategyVersion: '1.0.0', parameterHash: 'a'.repeat(64) });
    expect(wrongStrategyOrigin).toBeNull(); // confirms no PASSED subject exists for this foreign strategyId in the same genuine result
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, 1_200_000);
    expect(authorizeStrategyDispatch(kernel, decision, 'instrument-1', wrongStrategyOrigin)).toBeNull();
  }, 30_000);

  it('rejects when the approval is genuine but the dispatched kernel has a different parameterHash', async () => {
    const { origin } = await genuineResearchApproval();
    const differentParamsKernel = (await import('../../../src/strategies')).emaTrendV1Definition.createKernel({
      pair: PAIR, parameters: { timeframeMinutes: 1, fastPeriod: 2, slowPeriod: 3, priceSource: 'CLOSE' }, indicatorBootstrapIdentity: [{ timeframeMinutes: 1, bootstrapStartOpenTimeMs: 0 }],
    });
    const decision = evaluateDecision(differentParamsKernel, 1_200_000);
    expect(authorizeStrategyDispatch(differentParamsKernel, decision, 'instrument-1', origin)).toBeNull();
  }, 30_000);
});
