import { beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, sha256CanonicalJson } from '../../../../src/backtest';
import { executeResearchValidationWithGitSourceVerifier } from '../../../../src/research/research-validation/executor';
import { planResearchValidationWithGitSourceVerifier } from '../../../../src/research/research-validation/planner';
import type { FinalizedResearchValidationPlan, ResearchValidationPlanInput } from '../../../../src/research/research-validation/types';
import { fundedResource } from '../strategy-coin-matrix/audit-b2-helpers';
import { ControlledGitVerifier, registry } from '../strategy-coin-matrix/helpers';
import { validationInput } from './helpers';

const flags = ['requireFreshHoldout', 'requireHoldoutPositiveReturn', 'requireCostStressSurvival'] as const;
const malformed = [null, undefined, 'true', 'false', 0, 1, '', [], {}, [true]];
const resource = fundedResource('BTC-INR', [], 4 * 24 * 60);
const dependencies = { registry: registry(), pairResources: [resource] };
const input = validationInput([resource]);
let baseline: FinalizedResearchValidationPlan;
beforeAll(async () => { baseline = await planResearchValidationWithGitSourceVerifier(input, dependencies, new ControlledGitVerifier()); });

function rehash(mutate: (plan: ResearchValidationPlanInput) => void): FinalizedResearchValidationPlan {
  const copy = JSON.parse(JSON.stringify(baseline)) as FinalizedResearchValidationPlan;
  mutate(copy.plan);
  return { ...copy, validationPlanId: sha256CanonicalJson(copy.plan) };
}
async function rejectLoaded(finalized: FinalizedResearchValidationPlan) {
  expect(sha256CanonicalJson(finalized.plan)).toBe(finalized.validationPlanId);
  const verifier = new ControlledGitVerifier();
  await expect(executeResearchValidationWithGitSourceVerifier(finalized, dependencies, {}, verifier)).rejects.toMatchObject({ code: 'VALIDATION_PLAN_INVALID' });
  expect(verifier.assertions).toBe(0);
}

describe('Audit B3 strict policy and serialized plan semantics', () => {
  it.each(flags.flatMap((flag) => malformed.map((value) => ({ flag, value }))))('rejects $flag = $value in planning and a matching-hash loaded plan', async ({ flag, value }) => {
    const mutate = (plan: ResearchValidationPlanInput) => {
      const thresholds = plan.thresholds as unknown as Record<string, unknown>;
      if (value === undefined) delete thresholds[flag]; else thresholds[flag] = value;
    };
    const invalidInput = JSON.parse(JSON.stringify(input)) as ResearchValidationPlanInput;
    mutate(invalidInput);
    await expect(planResearchValidationWithGitSourceVerifier(invalidInput, dependencies, new ControlledGitVerifier())).rejects.toMatchObject({ code: 'VALIDATION_PLAN_INVALID' });
    await rejectLoaded(rehash(mutate));
  });

  it.each(flags.flatMap((flag) => [false, true].map((value) => ({ flag, value }))))('accepts explicit $flag = $value and binds the valid policy', async ({ flag, value }) => {
    const validInput = { ...input, thresholds: { ...input.thresholds, [flag]: value }, costStress: { ...input.costStress, scenarios: [{ scenarioId: 'MODERATE_STRESS', costModel: input.backtestBaseConfig.costModel }] } };
    const finalized = await planResearchValidationWithGitSourceVerifier(validInput, dependencies, new ControlledGitVerifier());
    expect(finalized.plan.thresholds[flag]).toBe(value);
    const restored = JSON.parse(JSON.stringify(finalized)) as FinalizedResearchValidationPlan;
    const normalized = await planResearchValidationWithGitSourceVerifier(restored.plan, dependencies, new ControlledGitVerifier());
    expect(canonicalJson(normalized)).toBe(canonicalJson(finalized));
    expect(normalized.validationPlanId).toBe(sha256CanonicalJson(normalized.plan));
  });

  it.each([
    ['validationPolicyVersion', 'UNSUPPORTED_POLICY'], ['maxOosDrawdownPercent', 'Infinity'], ['maxOosDrawdownPercent', '-Infinity'],
    ['maxOosDrawdownPercent', 'NaN'], ['maxOosDrawdownPercent', '1e999999'], ['maxOosDrawdownPercent', ''],
    ['maxOosDrawdownPercent', '-0.1'], ['minOosFoldPassRatio', '1.000000000000000001'],
  ])('rejects rehashed %s = %s', async (field, value) => {
    await rejectLoaded(rehash((plan) => {
      if (field === 'validationPolicyVersion') (plan as unknown as Record<string, unknown>)[field!] = value;
      else (plan.thresholds as unknown as Record<string, unknown>)[field!] = value;
    }));
  });

  it('rechecks planner policy combinations, required fields, and authoritative fold structure', async () => {
    await rejectLoaded(rehash((plan) => { (plan.thresholds as unknown as Record<string, unknown>).requireCostStressSurvival = true; }));
    await rejectLoaded(rehash((plan) => { delete (plan as unknown as Record<string, unknown>).metricPolicy; }));
    await rejectLoaded(rehash((plan) => { (plan.walkForward as unknown as Record<string, unknown>).stepDays = 2; }));
    const changed = rehash(() => undefined);
    await rejectLoaded({ ...changed, folds: [] });
  });

  it('enables freshness explicitly and disables it only with explicit false in genuine execution', async () => {
    for (const requireFreshHoldout of [false, true]) {
      const validInput = { ...input, holdout: { ...input.holdout, exposureDeclaration: 'PREVIOUSLY_OBSERVED' as const }, thresholds: { ...input.thresholds, requireFreshHoldout } };
      const finalized = await planResearchValidationWithGitSourceVerifier(validInput, dependencies, new ControlledGitVerifier());
      const loaded = JSON.parse(JSON.stringify(finalized)) as FinalizedResearchValidationPlan;
      const result = await executeResearchValidationWithGitSourceVerifier(loaded, dependencies, {}, new ControlledGitVerifier());
      expect(result.status).toBe('COMPLETED');
      expect(result.subjectResults[0]?.holdoutEvaluation?.freshnessGate.status).toBe(requireFreshHoldout ? 'UNAVAILABLE' : 'DISABLED');
      if (requireFreshHoldout) expect(result.passedSubjects).toBe(0);
    }
    const changed = await planResearchValidationWithGitSourceVerifier({ ...input, thresholds: { ...input.thresholds, requireFreshHoldout: true } }, dependencies, new ControlledGitVerifier());
    expect(changed.validationPlanId).not.toBe(baseline.validationPlanId);
  }, 60_000);
});
