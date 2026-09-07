import { describe, expect, it } from 'vitest';
import { planResearchValidationWithGitSourceVerifier, deriveWalkForwardFolds } from '../../../../src/research/research-validation/planner';
import { BASE, ControlledGitVerifier, registry, resources } from '../strategy-coin-matrix/helpers';
import type { MatrixPairExecutionResources } from '../../../../src/research/strategy-coin-matrix';
import { validationInput } from './helpers';

describe('Phase 12 deterministic planning', () => {
  const covered = (pair: string): MatrixPairExecutionResources => { const resource = resources(pair); return { ...resource, datasetManifest: { ...resource.datasetManifest, fromInclusiveMs: BASE - 86_400_000, toExclusiveMs: BASE + 6 * 86_400_000 } }; };
  it('normalizes bindings, derives pair universe, subjects, folds and immutable identity', async () => {
    const eth = covered('ETH-INR'); const btc = covered('BTC-INR'); const input = validationInput([eth, btc]); const definitions = registry();
    const finalized = await planResearchValidationWithGitSourceVerifier(input, { registry: definitions, pairResources: [eth, btc] }, new ControlledGitVerifier());
    expect(finalized.plan.pairUniverse).toEqual(['BTC-INR', 'ETH-INR']);
    expect(finalized.folds).toHaveLength(1); expect(finalized.unusedTailMs).toBe(0); expect(finalized.subjects).toHaveLength(2);
    expect(finalized.subjects.map((item) => item.validationSubjectId)).toEqual([...finalized.subjects.map((item) => item.validationSubjectId)].sort());
    expect(Object.isFrozen(finalized.plan.pairBindings[0]?.datasetBinding)).toBe(true);
    const id = finalized.validationPlanId; (input.pairBindings as unknown as object[]).reverse(); expect(finalized.validationPlanId).toBe(id);
  });

  it('binds every execution identity and rejects invalid structural policies', async () => {
    const resource = covered('BTC-INR'); const definitions = registry(); const base = validationInput([resource]);
    const first = await planResearchValidationWithGitSourceVerifier(base, { registry: definitions, pairResources: [resource] }, new ControlledGitVerifier());
    const changedBase = validationInput([resource]); const changed = { ...changedBase, pairBindings: [{ ...changedBase.pairBindings[0]!, fixedResearchQuantity: '0.02' }] };
    const second = await planResearchValidationWithGitSourceVerifier(changed, { registry: definitions, pairResources: [resource] }, new ControlledGitVerifier());
    expect(second.validationPlanId).not.toBe(first.validationPlanId);
    await expect(planResearchValidationWithGitSourceVerifier({ ...base, walkForward: { ...base.walkForward, stepDays: 2 } }, { registry: definitions, pairResources: [resource] }, new ControlledGitVerifier())).rejects.toMatchObject({ code: 'VALIDATION_PLAN_INVALID' });
    await expect(planResearchValidationWithGitSourceVerifier({ ...base, thresholds: { ...base.thresholds, requireCostStressSurvival: true } }, { registry: definitions, pairResources: [resource] }, new ControlledGitVerifier())).rejects.toMatchObject({ code: 'VALIDATION_PLAN_INVALID' });
  });

  it('derives only complete folds and exact unused tail', () => {
    const inputBase = validationInput([]); const input = { ...inputBase, holdout: { ...inputBase.holdout, holdoutStartMs: BASE + 3 * 86_400_000 + 43_200_000 } };
    expect(() => deriveWalkForwardFolds(input)).toThrow();
    const alignedBase = validationInput([]); const aligned = { ...alignedBase, holdout: { ...alignedBase.holdout, holdoutStartMs: BASE + 5 * 86_400_000, holdoutEndExclusiveMs: BASE + 6 * 86_400_000 }, validationWindow: { ...alignedBase.validationWindow, endExclusiveMs: BASE + 6 * 86_400_000 } };
    const result = deriveWalkForwardFolds(aligned); expect(result.folds).toHaveLength(3); expect(result.unusedTailMs).toBe(0);
  });
});
