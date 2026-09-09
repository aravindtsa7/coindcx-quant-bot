import { canonicalPaperDecimalString } from './decimal';
import { paperSourceInvalid } from './errors';
import { sha256CanonicalJson } from '../risk';

function assertNonEmptyId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) paperSourceInvalid(`${label} must be a non-empty exact string`);
}
function assertSafeTimeMs(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) paperSourceInvalid(`${label} must be a non-negative safe integer`);
}
function assertSafeRevision(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) paperSourceInvalid(`${label} must be a non-negative safe integer`);
}

// ---------------------------------------------------------------------------
// OPEN ExecutionIntent identity (V2.2/V2.3 frozen contract)
// ---------------------------------------------------------------------------

export const OPEN_EXECUTION_INTENT_IDENTITY_POLICY_ID = 'P14_EXECUTION_INTENT_IDENTITY_V2' as const;

export interface OpenExecutionIntentIdentityInput {
  readonly admissionId: string;
  readonly riskDecisionId: string;
  readonly accountId: string;
  readonly pair: string;
  readonly strategyInstanceId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly approvedQuantity: string;
  readonly approvedLeverage: string;
  readonly approvedNotionalInr: string;
  readonly approvedMarginInr: string;
  readonly evaluationTimeMs: number;
  readonly executionPolicySnapshotId: string;
}

/**
 * Deterministic, admission-generation-bound OPEN execution intent identity.
 * `researchApprovalOriginId`/`strategyOriginId` are deliberately excluded
 * (V2.2 §2): they are eligibility/authority proof, not execution economics, so
 * a reissued genuine research approval for the same admission never forks
 * economic identity.
 */
export function computeOpenExecutionIntentId(input: OpenExecutionIntentIdentityInput): string {
  assertNonEmptyId(input.admissionId, 'admissionId');
  assertNonEmptyId(input.riskDecisionId, 'riskDecisionId');
  assertNonEmptyId(input.accountId, 'accountId');
  assertNonEmptyId(input.pair, 'pair');
  assertNonEmptyId(input.strategyInstanceId, 'strategyInstanceId');
  assertNonEmptyId(input.strategyId, 'strategyId');
  assertNonEmptyId(input.strategyVersion, 'strategyVersion');
  assertNonEmptyId(input.parameterHash, 'parameterHash');
  assertNonEmptyId(input.executionPolicySnapshotId, 'executionPolicySnapshotId');
  assertSafeTimeMs(input.evaluationTimeMs, 'evaluationTimeMs');
  return sha256CanonicalJson({
    identityPolicyId: OPEN_EXECUTION_INTENT_IDENTITY_POLICY_ID,
    admissionId: input.admissionId,
    riskDecisionId: input.riskDecisionId,
    accountId: input.accountId,
    pair: input.pair,
    strategyInstanceId: input.strategyInstanceId,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    parameterHash: input.parameterHash,
    action: 'OPEN',
    approvedQuantity: canonicalPaperDecimalString(input.approvedQuantity, 'approvedQuantity'),
    approvedLeverage: canonicalPaperDecimalString(input.approvedLeverage, 'approvedLeverage'),
    approvedNotionalInr: canonicalPaperDecimalString(input.approvedNotionalInr, 'approvedNotionalInr'),
    approvedMarginInr: canonicalPaperDecimalString(input.approvedMarginInr, 'approvedMarginInr'),
    evaluationTimeMs: input.evaluationTimeMs,
    executionPolicySnapshotId: input.executionPolicySnapshotId,
  });
}

// ---------------------------------------------------------------------------
// CLOSE ExecutionIntent identity (V2.2 frozen contract)
// ---------------------------------------------------------------------------

export const CLOSE_EXECUTION_INTENT_IDENTITY_POLICY_ID = 'P14_CLOSE_EXECUTION_INTENT_IDENTITY_V1' as const;

export interface CloseExecutionIntentIdentityInput {
  readonly riskDecisionId: string;
  readonly accountId: string;
  readonly pair: string;
  readonly strategyInstanceId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly positionInstanceId: string;
  readonly positionRevision: number;
  readonly reduceOnlyQuantity: string;
  readonly evaluationTimeMs: number;
  readonly executionPolicySnapshotId: string;
}

/**
 * Deterministic CLOSE execution intent identity. No `researchApprovalOriginId`
 * — CLOSE is research-exempt by frozen rule. A distinct `identityPolicyId` from
 * OPEN's guarantees the two hash domains can never collide regardless of any
 * other field overlap.
 */
export function computeCloseExecutionIntentId(input: CloseExecutionIntentIdentityInput): string {
  assertNonEmptyId(input.riskDecisionId, 'riskDecisionId');
  assertNonEmptyId(input.accountId, 'accountId');
  assertNonEmptyId(input.pair, 'pair');
  assertNonEmptyId(input.strategyInstanceId, 'strategyInstanceId');
  assertNonEmptyId(input.strategyId, 'strategyId');
  assertNonEmptyId(input.strategyVersion, 'strategyVersion');
  assertNonEmptyId(input.parameterHash, 'parameterHash');
  assertNonEmptyId(input.positionInstanceId, 'positionInstanceId');
  assertNonEmptyId(input.executionPolicySnapshotId, 'executionPolicySnapshotId');
  assertSafeRevision(input.positionRevision, 'positionRevision');
  assertSafeTimeMs(input.evaluationTimeMs, 'evaluationTimeMs');
  return sha256CanonicalJson({
    identityPolicyId: CLOSE_EXECUTION_INTENT_IDENTITY_POLICY_ID,
    riskDecisionId: input.riskDecisionId,
    accountId: input.accountId,
    pair: input.pair,
    strategyInstanceId: input.strategyInstanceId,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    parameterHash: input.parameterHash,
    positionInstanceId: input.positionInstanceId,
    positionRevision: input.positionRevision,
    reduceOnlyQuantity: canonicalPaperDecimalString(input.reduceOnlyQuantity, 'reduceOnlyQuantity'),
    evaluationTimeMs: input.evaluationTimeMs,
    executionPolicySnapshotId: input.executionPolicySnapshotId,
    action: 'CLOSE',
  });
}

// ---------------------------------------------------------------------------
// PositionInstance identity (V2 §10 frozen contract)
// ---------------------------------------------------------------------------

export const POSITION_INSTANCE_IDENTITY_POLICY_ID = 'P14_POSITION_INSTANCE_IDENTITY_V1' as const;

export interface PositionInstanceIdentityInput {
  readonly accountId: string;
  readonly strategyInstanceId: string;
  readonly pair: string;
  readonly openingExecutionIntentId: string;
}

/** No wall clock or random input — a fresh OPEN always derives a fresh id via `openingExecutionIntentId`. */
export function computePositionInstanceId(input: PositionInstanceIdentityInput): string {
  assertNonEmptyId(input.accountId, 'accountId');
  assertNonEmptyId(input.strategyInstanceId, 'strategyInstanceId');
  assertNonEmptyId(input.pair, 'pair');
  assertNonEmptyId(input.openingExecutionIntentId, 'openingExecutionIntentId');
  return sha256CanonicalJson({
    identityPolicyId: POSITION_INSTANCE_IDENTITY_POLICY_ID,
    accountId: input.accountId,
    strategyInstanceId: input.strategyInstanceId,
    pair: input.pair,
    openingExecutionIntentId: input.openingExecutionIntentId,
  });
}

// ---------------------------------------------------------------------------
// Terminal source-execution identity (V2.3 frozen contract)
// ---------------------------------------------------------------------------

export const SOURCE_EXECUTION_IDENTITY_POLICY_ID = 'P14_SOURCE_EXECUTION_IDENTITY_V1' as const;

export interface SourceExecutionKeyInput {
  readonly accountId: string;
  readonly sourceStrategyDecisionId: string;
}

/**
 * Generation-independent: one source `StrategyDecision` may produce at most one
 * economically-applied paper fill per account, across every admission
 * generation and process restart. `generation`/`admissionId`/`riskDecisionId`
 * are deliberately absent — this key sits one layer beneath all of them.
 */
export function computeSourceExecutionKey(input: SourceExecutionKeyInput): string {
  assertNonEmptyId(input.accountId, 'accountId');
  assertNonEmptyId(input.sourceStrategyDecisionId, 'sourceStrategyDecisionId');
  return sha256CanonicalJson({
    identityPolicyId: SOURCE_EXECUTION_IDENTITY_POLICY_ID,
    accountId: input.accountId,
    sourceStrategyDecisionId: input.sourceStrategyDecisionId,
  });
}
