import { RiskAdmissionCoordinator } from '../dispatch/admission';
import type { AdmissionRecord } from '../dispatch';
import { authorizeStrategyDispatch } from '../dispatch/strategy-dispatch';
import {
  issueResearchApprovalOrigin,
  ResearchApprovalOrigin,
  type ResearchApprovalOriginRecord,
  type ResearchValidationPlanResult,
} from '../research/research-validation';
import type { AcceptedOpenRiskDecision, RiskEvaluationContext, RiskPolicy } from '../risk';
import { StrategyDecisionOrigin, type StrategyDecision, type StrategyDecisionOriginRecord, type StrategyKernel } from '../strategies';
import { PaperEngineError } from './errors';

const OPEN_AUTHORITY_ISSUER = Symbol('P14 paper OPEN execution authority');

/**
 * Everything Phase14's fill engine may ever consume as proof an OPEN economic
 * action is authorized. Every field was produced by a genuine call this module
 * itself made — never a caller-supplied claim.
 */
export interface PaperOpenExecutionAuthorityRecord {
  readonly accountId: string;
  readonly admission: AdmissionRecord;
  readonly decision: AcceptedOpenRiskDecision;
  readonly researchApproval: ResearchApprovalOriginRecord;
  readonly strategyOrigin: StrategyDecisionOriginRecord;
}

/**
 * Runtime capability, never part of canonical semantic identity. The private
 * `#record` field plus the module-private issuer symbol make this
 * non-forgeable: a caller-shaped object with byte-identical-looking fields is
 * not an instance of this class and `.read()` returns `null` for it.
 */
export class PaperOpenExecutionAuthority {
  readonly #record: PaperOpenExecutionAuthorityRecord;
  public constructor(issuer: symbol, record: PaperOpenExecutionAuthorityRecord) {
    if (issuer !== OPEN_AUTHORITY_ISSUER) throw new PaperEngineError('PAPER_AUTHORITY_INVALID', 'Only the genuine mint composition may issue OPEN execution authority');
    this.#record = Object.freeze({ ...record });
    Object.freeze(this);
  }
  public static read(value: unknown): PaperOpenExecutionAuthorityRecord | null {
    return value !== null && typeof value === 'object' && #record in value ? value.#record : null;
  }
}
Object.freeze(PaperOpenExecutionAuthority.prototype);
Object.freeze(PaperOpenExecutionAuthority);

/**
 * Everything the caller supplies for evidence that this module cannot itself
 * derive or verify (account/pair/exposure/leverage-tier/settlement evidence).
 * `strategyOrigin`/`candidate` are deliberately excluded: this module derives
 * them itself from the genuine, verified research-approval + kernel-origin
 * chain, so a caller can never substitute a mismatched pair.
 * NOT part of the public `src/execution` barrel — see `mintPaperOpenExecutionAuthority`.
 */
export type PaperOpenRiskEvidence = Omit<RiskEvaluationContext, 'strategyOrigin' | 'candidate'>;

/** NOT part of the public `src/execution` barrel — see `mintPaperOpenExecutionAuthority`. */
export interface MintPaperOpenExecutionAuthorityInput {
  /** Owned by the caller's runtime composition (later slices) — never a caller-fabricated coordinator standing in for a real one. */
  readonly coordinator: RiskAdmissionCoordinator;
  readonly accountId: string;
  readonly kernel: StrategyKernel;
  readonly decision: StrategyDecision;
  readonly instrumentSpecSnapshotId: string;
  readonly planResult: ResearchValidationPlanResult;
  readonly policy: RiskPolicy;
  readonly evidence: PaperOpenRiskEvidence;
}

/**
 * The single trusted composition (V2.2 §2): genuine Phase12 PASSED research
 * approval + matching genuine `StrategyDecision` origin + `RiskEngine`
 * acceptance + `RiskAdmissionCoordinator` `ADMITTED`, in that order, all inside
 * this one function. Returns `null` (never throws) for every rejection case —
 * missing/mismatched research approval, a kernel origin mismatch, or a
 * non-`ADMITTED` coordinator outcome. There is no other path that constructs a
 * `PaperOpenExecutionAuthority`.
 *
 * NOT public execution API — deliberately absent from the `src/execution`
 * barrel (`index.ts`), the same way `registerGenuineResearchValidationResult`
 * is absent from the research-validation barrel. Genuineness of the returned
 * authority is only as strong as the `coordinator`/`evidence` the caller
 * supplies: an arbitrary caller could construct its own throwaway
 * `RiskAdmissionCoordinator` and fabricated evidence and still receive a
 * structurally "genuine" authority back. Production invocation is therefore
 * reserved for the single, future Phase14-owned runtime composition (P14-D/I),
 * which alone is responsible for supplying the one real, account-owned
 * coordinator and coherent evidence acquired under the account-owner
 * transaction boundary (V2 §16) — this module does not implement that
 * ownership/locking itself. Arbitrary downstream code must not import this
 * function and treat it as a public actionability API.
 */
export async function mintPaperOpenExecutionAuthority(input: MintPaperOpenExecutionAuthorityInput): Promise<PaperOpenExecutionAuthority | null> {
  const researchApproval = issueResearchApprovalOrigin(input.planResult, {
    pair: input.kernel.pair,
    strategyId: input.kernel.strategyId,
    strategyVersion: input.kernel.strategyVersion,
    parameterHash: input.kernel.parameterHash,
  });
  if (researchApproval === null) return null;

  const authorized = authorizeStrategyDispatch(input.kernel, input.decision, input.instrumentSpecSnapshotId, researchApproval);
  if (authorized === null) return null;

  const context: RiskEvaluationContext = { ...input.evidence, strategyOrigin: authorized.strategyOrigin, candidate: authorized.candidate };
  const outcome = await input.coordinator.admit({ accountId: input.accountId, policy: input.policy, context });
  if (outcome.status !== 'ADMITTED') return null;

  const researchApprovalRecord = ResearchApprovalOrigin.read(researchApproval);
  const strategyOriginRecord = StrategyDecisionOrigin.read(authorized.strategyOrigin);
  if (researchApprovalRecord === null || strategyOriginRecord === null) {
    throw new PaperEngineError('PAPER_AUTHORITY_INVALID', 'Unreachable: a just-issued genuine origin failed to read back its own record');
  }

  return new PaperOpenExecutionAuthority(OPEN_AUTHORITY_ISSUER, {
    accountId: input.accountId,
    admission: outcome.admission,
    decision: outcome.decision,
    researchApproval: researchApprovalRecord,
    strategyOrigin: strategyOriginRecord,
  });
}
