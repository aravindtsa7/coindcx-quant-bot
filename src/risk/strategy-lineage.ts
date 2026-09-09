import { strategySha256CanonicalJson } from '../strategies/core/canonical';
import { StrategyError } from '../strategies/core/errors';
import { computeStrategyInstanceId, computeStrategyParameterHash, normalizeIndicatorBootstrapIdentity } from '../strategies/core/identity';
import { PHASE10_STRATEGY_DEFINITIONS } from '../strategies/implementations';
import { BaseStrategyKernel, StrategyDecisionOrigin } from '../strategies/core/kernel';
import type { StrategyDecision, StrategyKernel } from '../strategies/core/types';
import { riskSourceInvalid } from './errors';
import { riskDeepCopyFreeze } from './immutable';
import type { RiskRejectionCode } from './reason-codes';
import type { PairPositionState, RiskDecisionAction, StrategyRiskCandidate, StrategyRiskLineage } from './types';

const issueOrigin = BaseStrategyKernel.issueDecisionOrigin;

/** Resolve the actual emitted object against its producing kernel, before copying. */
export function createStrategyRiskHandoff(kernel: StrategyKernel, decision: StrategyDecision, instrumentSpecSnapshotId: string): {
  readonly candidate: StrategyRiskCandidate; readonly strategyOrigin: StrategyDecisionOrigin;
} | null {
  const strategyOrigin = issueOrigin(kernel, decision);
  if (strategyOrigin === null) riskSourceInvalid('StrategyDecision was not emitted by the supplied kernel');
  const record = StrategyDecisionOrigin.read(strategyOrigin)!;
  const candidate = createStrategyRiskCandidate(decision, instrumentSpecSnapshotId, {
    normalizedParameters: record.instance.normalizedParameters, indicatorBootstrapIdentity: record.instance.indicatorBootstrapIdentity });
  if (candidate === null) return null;
  return Object.freeze({ candidate, strategyOrigin });
}

export function recomputeStrategyDecisionId(decision: StrategyDecision): string {
  return strategySha256CanonicalJson({
    strategyInstanceId: decision.strategyInstanceId,
    decisionSequence: decision.decisionSequence,
    evaluationTimeMs: decision.evaluationTimeMs,
    triggerTimeframeMinutes: decision.triggerTimeframeMinutes,
    status: decision.status,
    targetExposure: decision.targetExposure,
    reasonCodes: decision.reasonCodes,
  });
}

export function createStrategyRiskCandidate(decision: StrategyDecision, instrumentSpecSnapshotId: string, strategyLineage: StrategyRiskLineage): StrategyRiskCandidate | null {
  if (decision.status === 'WARMING') return null;
  return riskDeepCopyFreeze({ strategyDecision: decision, strategyLineage, pair: decision.pair, instrumentSpecSnapshotId });
}

/** Reuses the frozen Phase 10 identity scheme and production construction rules. */
export function strategyLineageReasons(candidate: StrategyRiskCandidate, origin: StrategyDecisionOrigin | null): readonly RiskRejectionCode[] {
  const decision = candidate.strategyDecision;
  const record = StrategyDecisionOrigin.read(origin);
  if (record === null || strategySha256CanonicalJson(decision) !== strategySha256CanonicalJson(record.decision)) return ['DECISION_IDENTITY_MISMATCH'];
  const expected = record.instance;
  if (decision.pair !== expected.pair || decision.strategyId !== expected.strategyId || decision.strategyVersion !== expected.strategyVersion ||
      decision.parameterHash !== expected.parameterHash || decision.strategyInstanceId !== expected.strategyInstanceId ||
      decision.triggerTimeframeMinutes !== expected.triggerTimeframeMinutes ||
      strategySha256CanonicalJson(candidate.strategyLineage.normalizedParameters) !== strategySha256CanonicalJson(expected.normalizedParameters) ||
      strategySha256CanonicalJson(candidate.strategyLineage.indicatorBootstrapIdentity) !== strategySha256CanonicalJson(expected.indicatorBootstrapIdentity)) return ['DECISION_IDENTITY_MISMATCH'];
  const definition = PHASE10_STRATEGY_DEFINITIONS.find((entry) =>
    entry.strategyId === decision.strategyId && entry.strategyVersion === decision.strategyVersion);
  if (definition === undefined) return ['DECISION_IDENTITY_MISMATCH'];
  try {
    const construction = definition.describeConstruction(candidate.strategyLineage.normalizedParameters);
    const bootstrap = normalizeIndicatorBootstrapIdentity(candidate.strategyLineage.indicatorBootstrapIdentity, construction.indicatorRequirements);
    const parameterHash = computeStrategyParameterHash(construction.normalizedParameters);
    const instanceId = computeStrategyInstanceId({ pair: decision.pair, strategyId: definition.strategyId,
      strategyVersion: definition.strategyVersion, parameterHash, indicatorBootstrapIdentity: bootstrap });
    if (parameterHash !== decision.parameterHash ||
        computeStrategyParameterHash(candidate.strategyLineage.normalizedParameters) !== parameterHash ||
        instanceId !== decision.strategyInstanceId || construction.triggerTimeframeMinutes !== decision.triggerTimeframeMinutes ||
        recomputeStrategyDecisionId(decision) !== decision.decisionId) return ['DECISION_IDENTITY_MISMATCH'];
    return [];
  } catch (error) {
    if (error instanceof StrategyError) return ['DECISION_IDENTITY_MISMATCH'];
    throw error;
  }
}

export function deriveRiskAction(decision: StrategyDecision, position: PairPositionState): RiskDecisionAction {
  const target = decision.targetExposure;
  if (target === null) throw new Error('READY StrategyDecision requires targetExposure');
  if (position.state === 'FLAT') return target === 'FLAT' ? 'NO_CHANGE' : 'OPEN';
  if (target === position.positionDirection) return 'NO_CHANGE';
  if (target === 'FLAT') return 'CLOSE';
  return 'REVERSAL_DEFERRED';
}
