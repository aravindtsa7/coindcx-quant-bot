import type { ResearchValidationPlanInput } from '../../../../src/research/research-validation/types';
import type { MatrixPairExecutionResources } from '../../../../src/research/strategy-coin-matrix';
import { BASE, matrixInput } from '../strategy-coin-matrix/helpers';

export function validationInput(resources: readonly MatrixPairExecutionResources[]): ResearchValidationPlanInput {
  const matrix = matrixInput(resources, false);
  return {
    planName: 'phase-12-test', validationPolicyVersion: 'P12_VALIDATION_POLICY_V1', pairBindings: matrix.pairs, strategies: matrix.strategies,
    validationWindow: { startMs: BASE + 86_400_000, endExclusiveMs: BASE + 4 * 86_400_000 }, walkForward: { policyId: 'P12_WALK_FORWARD_V1', trainDays: 1, testDays: 1, stepDays: 1, embargoDays: 0 },
    holdout: { holdoutStartMs: BASE + 3 * 86_400_000, holdoutEndExclusiveMs: BASE + 4 * 86_400_000, exposureDeclaration: 'UNSEEN_BY_OPERATOR' },
    metricPolicy: { policyId: 'P12_METRIC_POLICY_V1', annualRiskFreeRate: '0', annualSortinoTargetRate: '0', annualizationFactor: 365, minDailyObservations: 2, minClosedTrades: 1, sharpeDegradationDenominatorFloor: '0.1' },
    thresholds: { minOosClosedTrades: 0, minDailyObservations: 1, minOosSharpe: '-100', minOosSortino: '-100', maxOosDrawdownPercent: '100', minNetDailyProfitFactor: '0', minNetDailyExpectancy: '-1000', minOosFoldPassRatio: '0', maxIsToOosSharpeDegradation: '100', requireCostStressSurvival: false, maxMonteCarloAdverseDrawdownPercent: '100', minDeflatedSharpeZ: '-100', requireHoldoutPositiveReturn: false, minHoldoutSharpe: '-100', requireFreshHoldout: false },
    costStress: { policyId: 'P12_COST_STRESS_V1', scenarios: [] }, monteCarlo: { policyId: 'P12_MONTE_CARLO_PERMUTATION_V1', simulationCount: 10, adversePercentile: 95, seedDerivationPolicy: 'HMAC_SHA256_V1' },
    overfitting: { policyId: 'P12_DEFLATED_SHARPE_Z_V1', metric: 'DEFLATED_SHARPE_Z' }, backtestBaseConfig: matrix.backtestConfig,
  };
}
