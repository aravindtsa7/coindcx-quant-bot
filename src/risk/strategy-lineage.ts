import { strategySha256CanonicalJson } from '../strategies/core/canonical';
import type { StrategyDecision } from '../strategies/core/types';
import { freezeRiskRuntime } from './immutable';
import type { PairPositionState, RiskDecisionAction, StrategyRiskCandidate } from './types';

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

export function createStrategyRiskCandidate(decision: StrategyDecision, instrumentSpecSnapshotId: string): StrategyRiskCandidate | null {
  if (decision.status === 'WARMING') return null;
  return freezeRiskRuntime({ strategyDecision: { ...decision, reasonCodes: [...decision.reasonCodes] }, pair: decision.pair, instrumentSpecSnapshotId });
}

export function deriveRiskAction(decision: StrategyDecision, position: PairPositionState): RiskDecisionAction {
  const target = decision.targetExposure;
  if (target === null) throw new Error('READY StrategyDecision requires targetExposure');
  if (position.state === 'FLAT') return target === 'FLAT' ? 'NO_CHANGE' : 'OPEN';
  if (target === position.positionDirection) return 'NO_CHANGE';
  if (target === 'FLAT') return 'CLOSE';
  return 'REVERSAL_DEFERRED';
}
