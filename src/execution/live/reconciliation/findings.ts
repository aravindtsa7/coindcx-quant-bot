/**
 * Deterministic finding identity and construction (§12, §16, §21).
 *
 * A finding's identity is a content hash over its category, code, subject
 * identity and sanitized evidence. That is what makes reconciliation
 * idempotent at the fault level: rerunning against unchanged evidence
 * recomputes the same digest, the `UNIQUE(account_id, finding_sha256)` index
 * turns the second write into an update of `last_seen_generation`, and no
 * duplicate fault row appears.
 *
 * The generation is deliberately NOT part of the digest. If it were, every run
 * would mint new rows for the same unchanged fact, which is precisely the
 * duplicate-fault churn §16 forbids.
 *
 * SECURITY (§21): every finding's evidence passes `assertCredentialFree`
 * before it can be constructed, so a developer who puts a credential-shaped
 * key into reconciliation evidence gets a hard failure rather than a redacted
 * log line — the same rule `LiveExecutionError` applies to its details.
 */
import { sha256CanonicalJson } from '../../../risk';
import { assertCredentialFree } from '../errors';
import { redactSensitiveData } from '../../../monitoring/logger';
import {
  isBlockingCategory,
  type LiveReconciliationFinding,
  type LiveReconciliationFindingCategoryName,
  type LiveReconciliationFindingCode,
  type LiveReconciliationFindingSubject,
} from './types';

export const LIVE_FINDING_IDENTITY_SCHEMA = 'P18_RECONCILIATION_FINDING_V1';

const EMPTY_SUBJECT: LiveReconciliationFindingSubject = Object.freeze({
  pair: null,
  intentId: null,
  exchangeOrderId: null,
  venuePositionId: null,
  strategyInstanceId: null,
});

/**
 * Builds one finding. The evidence object is frozen, credential-checked, and
 * passed through the shared redactor, so what is persisted can never differ
 * from what the logger would have been willing to emit.
 */
export function buildFinding(input: {
  readonly category: LiveReconciliationFindingCategoryName;
  readonly code: LiveReconciliationFindingCode;
  readonly subject?: Partial<LiveReconciliationFindingSubject>;
  readonly evidence?: Readonly<Record<string, unknown>>;
}): LiveReconciliationFinding {
  const evidence = input.evidence ?? {};
  assertCredentialFree(evidence);
  return Object.freeze({
    category: input.category,
    code: input.code,
    subject: Object.freeze({ ...EMPTY_SUBJECT, ...input.subject }),
    evidence: Object.freeze(redactSensitiveData({ ...evidence })),
  });
}

/**
 * Content identity of one finding. Stable across process restarts, insertion
 * order, and reconciliation generations.
 */
export function findingSha256(accountId: string, finding: LiveReconciliationFinding): string {
  return sha256CanonicalJson({
    schema: LIVE_FINDING_IDENTITY_SCHEMA,
    accountId,
    category: finding.category,
    code: finding.code,
    subject: finding.subject,
    evidence: finding.evidence,
  });
}

export function isFindingBlocking(finding: LiveReconciliationFinding): boolean {
  return isBlockingCategory(finding.category);
}

export function countBlocking(findings: readonly LiveReconciliationFinding[]): number {
  return findings.filter(isFindingBlocking).length;
}

/**
 * The account status implied by a set of findings (§12).
 *
 * `MANUAL_REVIEW_REQUIRED` outranks `UNHEALTHY`: both block mutation, but the
 * distinction tells an operator whether rerunning reconciliation could ever
 * clear it. An `AMBIGUOUS` or `MANUAL_REVIEW_REQUIRED` category means no
 * amount of rerunning helps until a human acts.
 */
export function resolveAccountStatus(
  findings: readonly LiveReconciliationFinding[],
): 'HEALTHY' | 'UNHEALTHY' | 'MANUAL_REVIEW_REQUIRED' {
  let unhealthy = false;
  for (const finding of findings) {
    if (finding.category === 'MANUAL_REVIEW_REQUIRED' || finding.category === 'AMBIGUOUS') {
      return 'MANUAL_REVIEW_REQUIRED';
    }
    if (isFindingBlocking(finding)) unhealthy = true;
  }
  return unhealthy ? 'UNHEALTHY' : 'HEALTHY';
}

/**
 * Deterministic ordering for persistence, so two workers evaluating identical
 * evidence write identical rows in identical order and a test can compare runs
 * byte for byte.
 */
export function sortFindings(
  accountId: string,
  findings: readonly LiveReconciliationFinding[],
): readonly LiveReconciliationFinding[] {
  return Object.freeze(
    [...findings].sort((left, right) => {
      const leftKey = findingSha256(accountId, left);
      const rightKey = findingSha256(accountId, right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  );
}
