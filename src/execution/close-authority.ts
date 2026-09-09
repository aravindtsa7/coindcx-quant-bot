import { RiskAdmissionCoordinator } from '../dispatch/admission';
import { createStrategyRiskHandoff, type AcceptedCloseRiskDecision, type RiskEvaluationContext, type RiskPolicy } from '../risk';
import { StrategyDecisionOrigin, type StrategyDecision, type StrategyDecisionOriginRecord, type StrategyKernel } from '../strategies';
import { PaperEngineError } from './errors';

const CLOSE_AUTHORITY_ISSUER = Symbol('P14 paper CLOSE execution authority');

/**
 * The durable position identity/ownership evidence a CLOSE authority binds to.
 * In P14-A this is caller-supplied (no persistence exists yet); later slices
 * (P14-D/E) source it from the durable `paper_position` slot under the
 * account-owner lock and re-verify it again at fill time (V2.2/V2.3).
 */
export interface PaperClosePositionBinding {
  readonly positionInstanceId: string;
  readonly positionRevision: number;
  readonly ownerStrategyInstanceId: string;
  readonly ownerStrategyId: string;
  readonly ownerStrategyVersion: string;
  readonly ownerParameterHash: string;
  readonly ownedQuantity: string;
}

export interface PaperCloseExecutionAuthorityRecord {
  readonly accountId: string;
  readonly decision: AcceptedCloseRiskDecision;
  readonly strategyOrigin: StrategyDecisionOriginRecord;
  readonly position: PaperClosePositionBinding;
  readonly reduceOnlyQuantity: string;
}

/**
 * Runtime capability, never part of canonical semantic identity — same
 * non-forgeable private-field + symbol-gated-issuer pattern as
 * `PaperOpenExecutionAuthority`. Structurally can never represent OPEN (its
 * `decision` field type is `AcceptedCloseRiskDecision` only) or a reversal (no
 * upstream contract ever supplies a target quantity for one).
 */
export class PaperCloseExecutionAuthority {
  readonly #record: PaperCloseExecutionAuthorityRecord;
  public constructor(issuer: symbol, record: PaperCloseExecutionAuthorityRecord) {
    if (issuer !== CLOSE_AUTHORITY_ISSUER) throw new PaperEngineError('PAPER_AUTHORITY_INVALID', 'Only the genuine mint composition may issue CLOSE execution authority');
    this.#record = Object.freeze({ ...record });
    Object.freeze(this);
  }
  public static read(value: unknown): PaperCloseExecutionAuthorityRecord | null {
    return value !== null && typeof value === 'object' && #record in value ? value.#record : null;
  }
}
Object.freeze(PaperCloseExecutionAuthority.prototype);
Object.freeze(PaperCloseExecutionAuthority);

/** NOT part of the public `src/execution` barrel — see `mintPaperCloseExecutionAuthority`. */
export type PaperCloseRiskEvidence = Omit<RiskEvaluationContext, 'strategyOrigin' | 'candidate'>;

/** NOT part of the public `src/execution` barrel — see `mintPaperCloseExecutionAuthority`. */
export interface MintPaperCloseExecutionAuthorityInput {
  readonly coordinator: RiskAdmissionCoordinator;
  readonly accountId: string;
  readonly kernel: StrategyKernel;
  readonly decision: StrategyDecision;
  readonly instrumentSpecSnapshotId: string;
  readonly policy: RiskPolicy;
  readonly evidence: PaperCloseRiskEvidence;
  readonly position: PaperClosePositionBinding;
}

/**
 * CLOSE is research-exempt for de-risking (frozen rule) — `createStrategyRiskHandoff`
 * is called directly, with no research-approval gate, but every other genuine
 * verification OPEN gets still applies: kernel-issued origin, `RiskEngine`
 * acceptance via the real coordinator, and (uniquely to CLOSE) reconciled
 * ownership of the exact position being closed, keyed by the full
 * `strategyInstanceId + strategyId + strategyVersion + parameterHash` tuple —
 * never by instance id alone (Invariant 27). `reduceOnlyQuantity` is always
 * derived from the position's own owned quantity, never a caller-supplied
 * target — there is no path to authorize an increased quantity, an OPEN, or a
 * reversal through this function.
 *
 * NOT public execution API — deliberately absent from the `src/execution`
 * barrel (`index.ts`). Production invocation is reserved for the single,
 * future Phase14-owned runtime composition (P14-D/I), which alone supplies
 * the one real, account-owned coordinator and coherent evidence (including
 * the durable position binding) acquired under the account-owner transaction
 * boundary (V2 §16) — this module does not implement that ownership/locking
 * itself. Arbitrary downstream code must not import this function and treat
 * it as a public actionability API.
 */
export async function mintPaperCloseExecutionAuthority(input: MintPaperCloseExecutionAuthorityInput): Promise<PaperCloseExecutionAuthority | null> {
  const authorized = createStrategyRiskHandoff(input.kernel, input.decision, input.instrumentSpecSnapshotId);
  if (authorized === null) return null;

  const { position } = input;
  if (
    position.ownerStrategyInstanceId !== input.decision.strategyInstanceId ||
    position.ownerStrategyId !== input.decision.strategyId ||
    position.ownerStrategyVersion !== input.decision.strategyVersion ||
    position.ownerParameterHash !== input.decision.parameterHash
  ) {
    return null;
  }

  const context: RiskEvaluationContext = { ...input.evidence, strategyOrigin: authorized.strategyOrigin, candidate: authorized.candidate };
  const outcome = await input.coordinator.admit({ accountId: input.accountId, policy: input.policy, context });
  if (outcome.status !== 'ACCEPTED_NO_CAPACITY_OWNERSHIP') return null;

  const strategyOriginRecord = StrategyDecisionOrigin.read(authorized.strategyOrigin);
  if (strategyOriginRecord === null) {
    throw new PaperEngineError('PAPER_AUTHORITY_INVALID', 'Unreachable: a just-issued genuine origin failed to read back its own record');
  }

  return new PaperCloseExecutionAuthority(CLOSE_AUTHORITY_ISSUER, {
    accountId: input.accountId,
    decision: outcome.decision,
    strategyOrigin: strategyOriginRecord,
    position,
    reduceOnlyQuantity: position.ownedQuantity,
  });
}
