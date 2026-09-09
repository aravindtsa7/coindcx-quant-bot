import { sha256CanonicalJson } from '../../backtest/canonical-json';
import type { ResearchValidationPlanResult } from './types';

// [C-F06] Genuine origin, not a self-consistent caller hash. Only a
// `ResearchValidationPlanResult` object that this module itself observed being
// constructed by the real executor (tracked by reference in this WeakSet) can ever
// back an issued `ResearchApprovalOrigin`. A caller-fabricated object with a
// byte-for-byte identical, internally self-consistent PASSED verdict and a
// correctly-recomputed `validationSubjectResultSha256` is *not* sufficient — it is
// simply not present in this WeakSet, so `issueResearchApprovalOrigin` returns null.
const GENUINE_RESULTS = new WeakSet<ResearchValidationPlanResult>();

/** Called only by the research-validation executor at its actual result construction sites. */
export function registerGenuineResearchValidationResult(result: ResearchValidationPlanResult): void {
  GENUINE_RESULTS.add(result);
}

const ORIGIN_ISSUER = Symbol('P12 research approval origin');

export interface ResearchApprovalOriginRecord {
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly validationSubjectId: string;
  readonly validationPlanId: string;
  readonly validationSubjectResultSha256: string;
}

export interface ResearchApprovalSubject {
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
}

/** Runtime ownership capability; never part of canonical semantic identity. */
export class ResearchApprovalOrigin {
  readonly #record: ResearchApprovalOriginRecord;
  public constructor(issuer: symbol, record: ResearchApprovalOriginRecord) {
    if (issuer !== ORIGIN_ISSUER) throw new Error('Only a genuine ResearchValidationPlanResult may issue research approval origin');
    this.#record = Object.freeze({ ...record });
    Object.freeze(this);
  }
  public static read(value: unknown): ResearchApprovalOriginRecord | null {
    return value !== null && typeof value === 'object' && #record in value ? value.#record : null;
  }
}
Object.freeze(ResearchApprovalOrigin.prototype);
Object.freeze(ResearchApprovalOrigin);

/**
 * Issues dispatch-authorizing evidence that `subject` genuinely passed research
 * validation under `planResult`. Returns null (never throws) for every rejection
 * case: `planResult` is not a genuine executor output (forged/rehashed/foreign
 * object), no subject in `planResult.subjectResults` matches the recomputed
 * `validationSubjectId`, or the matching record's verdict is not `PASSED`
 * (`FAILED`, `INSUFFICIENT_EVIDENCE`, or simply absent because the plan aborted it).
 */
export function issueResearchApprovalOrigin(planResult: ResearchValidationPlanResult, subject: ResearchApprovalSubject): ResearchApprovalOrigin | null {
  if (planResult === null || typeof planResult !== 'object' || !GENUINE_RESULTS.has(planResult)) return null;
  const validationSubjectId = sha256CanonicalJson({ pair: subject.pair, strategyId: subject.strategyId, strategyVersion: subject.strategyVersion, parameterHash: subject.parameterHash });
  const record = planResult.subjectResults.find((entry) => entry.validationSubjectId === validationSubjectId);
  if (record === undefined || record.verdict !== 'PASSED') return null;
  return new ResearchApprovalOrigin(ORIGIN_ISSUER, {
    pair: subject.pair, strategyId: subject.strategyId, strategyVersion: subject.strategyVersion, parameterHash: subject.parameterHash,
    validationSubjectId, validationPlanId: planResult.validationPlanId, validationSubjectResultSha256: record.validationSubjectResultSha256,
  });
}
