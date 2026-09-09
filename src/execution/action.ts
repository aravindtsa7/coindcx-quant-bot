import type { RiskDecisionAction } from '../risk';

/** V1 executable actions — the only two a paper `ExecutionIntent` may ever represent. */
export type PaperExecutionAction = 'OPEN' | 'CLOSE';

/** V1 explicitly unsupported: never produces an intent, order, or fill. */
export type UnsupportedStrategyRiskAction = 'NO_CHANGE' | 'REVERSAL_DEFERRED';

export interface NoExecutionOutcome {
  readonly outcome: 'NO_EXECUTION';
  readonly reason: UnsupportedStrategyRiskAction;
}

function isPaperExecutionAction(action: RiskDecisionAction): action is PaperExecutionAction {
  return action === 'OPEN' || action === 'CLOSE';
}

/**
 * Pure mapping from Phase13's `RiskDecisionAction` to what Phase14 may execute.
 * `NO_CHANGE` never creates an order (nothing changed). `REVERSAL_DEFERRED`
 * never synthesizes an instant close+reopen — Invariant 27 requires two
 * independently-evaluated sequential decisions; V1 takes no execution action
 * on it at all. No partial fill, scale-in, partial close, leverage mutation,
 * or automatic reversal is representable by this mapping's output.
 */
export function resolveExecutionAction(action: RiskDecisionAction): PaperExecutionAction | NoExecutionOutcome {
  if (isPaperExecutionAction(action)) return action;
  return { outcome: 'NO_EXECUTION', reason: action };
}
