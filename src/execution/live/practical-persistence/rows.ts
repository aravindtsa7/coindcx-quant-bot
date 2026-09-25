/**
 * Phase 18B Stage 1B1: strict parsing of durable practical rows (pure,
 * Prisma-free).
 *
 * Every durable row is validated field by field, and then the account's rows
 * are validated for mutual consistency, BEFORE anything uses them. Nothing is
 * repaired, defaulted, or normalized. The fence is validated by the Stage 1A
 * validator itself (`readPracticalAccountFence`).
 *
 * THE ABSENCE BOUNDARY. The only input that means "no row" is exactly `null`,
 * produced by `singleRowOrNull` from a query that succeeded and returned
 * ZERO rows. `undefined`, a non-object, a missing field, or any failed check
 * is MALFORMED, never absent. Nothing in this module catches an error and
 * returns null.
 */
import { readPracticalAccountFence, type PracticalAccountFence } from '../practical/fence';
import { classifyPracticalInvalidation } from '../practical/invalidation';
import { practicalAccountStateOnStartup } from '../practical/state-machine';
import {
  PRACTICAL_DIGEST_PATTERN,
  PRACTICAL_MUTATION_OUTCOMES,
  PracticalLiveSafetyError,
  isExactId,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  isPracticalAccountStateName,
  isPracticalInvalidationReason,
  isPracticalMutationAction,
  type PracticalAccountStateName,
  type PracticalInvalidationReason,
  type PracticalMutationOutcome,
  type PracticalQuarantineCause,
} from '../practical/types';
import {
  PRACTICAL_DURABLE_STATE_MALFORMED,
  PracticalPersistenceError,
  type PracticalAccountLoad,
  type PracticalAccountSnapshot,
  type PracticalDurableCertificateRecord,
  type PracticalMalformedProblem,
  type PracticalMutationLeaseRecord,
  type PracticalRecordLoad,
  type PracticalRecoveryEpisodeRecord,
  type PracticalReviewEpisodeRecord,
} from './ports';
import type { PracticalCertificateStatus } from '../practical/certificate';

/** Every safe MALFORMED problem code (the only content a malformed-state episode may record). */
export const PRACTICAL_MALFORMED_PROBLEMS: readonly PracticalMalformedProblem[] = Object.freeze([
  'STATE_ROW_INVALID',
  'FENCE_ROW_INVALID',
  'CERTIFICATE_ROW_INVALID',
  'LEASE_ROW_INVALID',
  'RECOVERY_EPISODE_ROW_INVALID',
  'REVIEW_EPISODE_ROW_INVALID',
  'LATCH_ROW_INVALID',
  'PARTIAL_ACCOUNT_ROWS',
  'DUPLICATE_ROWS',
  'ROWS_INCONSISTENT',
  'LATCHED_PENDING_REVIEW',
] as const);

/** States during which a recovery episode is open. */
export const PRACTICAL_RECOVERING_STATES: ReadonlySet<PracticalAccountStateName> = new Set(['QUARANTINED', 'CERTIFYING', 'PROVIDER_UNAVAILABLE']);

const CERTIFICATE_STATUSES: readonly PracticalCertificateStatus[] = ['ISSUED', 'CONSUMED', 'EXPIRED', 'REVOKED'];
const NON_REASON_QUARANTINE_CAUSES: readonly string[] = ['RUNTIME_STARTUP', 'MUTATION_OUTCOME_RECORDED', 'OPERATOR_RESOLVED'];

export function malformed(problem: PracticalMalformedProblem, message: string, field?: string): never {
  throw new PracticalPersistenceError('PRACTICAL_PERSISTENCE_MALFORMED', message, field === undefined ? { problem } : { problem, field });
}

/**
 * The ONLY conversion from a query result to "absent": a successful query that
 * returned zero rows. More than one row (impossible under the primary keys)
 * is MALFORMED; a non-array is MALFORMED.
 */
export function singleRowOrNull(rows: unknown, problem: PracticalMalformedProblem): unknown {
  if (!Array.isArray(rows)) malformed(problem, 'A durable read did not return a row list');
  if (rows.length === 0) return null;
  if (rows.length > 1) malformed('DUPLICATE_ROWS', 'A durable read returned more than one row for a unique key');
  return rows[0] as unknown;
}

function asRecord(value: unknown, problem: PracticalMalformedProblem): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) malformed(problem, 'A durable row is not a record');
  return value as Readonly<Record<string, unknown>>;
}

function field(row: Readonly<Record<string, unknown>>, name: string, problem: PracticalMalformedProblem): unknown {
  if (!Object.prototype.hasOwnProperty.call(row, name)) malformed(problem, 'A durable row is missing a column', name);
  return row[name];
}

function exactId(row: Readonly<Record<string, unknown>>, name: string, problem: PracticalMalformedProblem): string {
  const value = field(row, name, problem);
  if (!isExactId(value)) malformed(problem, 'A durable identifier is not a non-empty exact string', name);
  return value;
}

function nullableExactId(row: Readonly<Record<string, unknown>>, name: string, problem: PracticalMalformedProblem): string | null {
  const value = field(row, name, problem);
  if (value === null) return null;
  if (!isExactId(value)) malformed(problem, 'A durable identifier is not a non-empty exact string', name);
  return value;
}

function digest(row: Readonly<Record<string, unknown>>, name: string, problem: PracticalMalformedProblem): string {
  const value = field(row, name, problem);
  if (typeof value !== 'string' || !PRACTICAL_DIGEST_PATTERN.test(value)) malformed(problem, 'A durable digest is not lowercase 64-hex', name);
  return value;
}

function nullableDigest(row: Readonly<Record<string, unknown>>, name: string, problem: PracticalMalformedProblem): string | null {
  if (field(row, name, problem) === null) return null;
  return digest(row, name, problem);
}

/** A BIGINT or INT column as a non-negative SAFE integer. Anything else, including beyond MAX_SAFE_INTEGER, is MALFORMED. */
function safeInteger(row: Readonly<Record<string, unknown>>, name: string, problem: PracticalMalformedProblem): number {
  const value = field(row, name, problem);
  let asNumber: number;
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) malformed(problem, 'A durable integer is outside the safe range', name);
    asNumber = Number(value);
  } else {
    asNumber = value as number;
  }
  if (!isNonNegativeSafeInteger(asNumber)) malformed(problem, 'A durable integer is not a non-negative safe integer', name);
  return asNumber;
}

function nullableSafeInteger(row: Readonly<Record<string, unknown>>, name: string, problem: PracticalMalformedProblem): number | null {
  if (field(row, name, problem) === null) return null;
  return safeInteger(row, name, problem);
}

function positiveInteger(row: Readonly<Record<string, unknown>>, name: string, problem: PracticalMalformedProblem): number {
  const value = safeInteger(row, name, problem);
  if (!isPositiveSafeInteger(value)) malformed(problem, 'A durable integer must be positive', name);
  return value;
}

function oneOf<T extends string>(row: Readonly<Record<string, unknown>>, name: string, allowed: readonly T[], problem: PracticalMalformedProblem): T {
  const value = field(row, name, problem);
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) malformed(problem, 'A durable enumerated value is unknown', name);
  return value as T;
}

function nullableReason(row: Readonly<Record<string, unknown>>, name: string, problem: PracticalMalformedProblem): PracticalInvalidationReason | null {
  const value = field(row, name, problem);
  if (value === null) return null;
  if (!isPracticalInvalidationReason(value)) malformed(problem, 'A durable reason is not a known invalidation reason', name);
  return value;
}

function requireCoupled(condition: boolean, problem: PracticalMalformedProblem, message: string): void {
  if (!condition) malformed(problem, message);
}

// ---------------------------------------------------------------------------
// Row parsers
// ---------------------------------------------------------------------------

export interface ParsedPracticalStateRow {
  readonly accountId: string;
  readonly state: PracticalAccountStateName;
  readonly revision: number;
  readonly currentRecoveryEpisodeId: string | null;
  readonly currentReviewEpisodeId: string | null;
  readonly currentCertificateId: string | null;
}

export function parsePracticalStateRow(value: unknown): ParsedPracticalStateRow {
  const problem = 'STATE_ROW_INVALID';
  const row = asRecord(value, problem);
  const accountId = exactId(row, 'accountId', problem);
  const state = field(row, 'state', problem);
  if (!isPracticalAccountStateName(state)) malformed(problem, 'Unknown durable practical account state', 'state');
  const parsed = Object.freeze({
    accountId,
    state,
    revision: safeInteger(row, 'revision', problem),
    currentRecoveryEpisodeId: nullableExactId(row, 'currentRecoveryEpisodeId', problem),
    currentReviewEpisodeId: nullableExactId(row, 'currentReviewEpisodeId', problem),
    currentCertificateId: nullableDigest(row, 'currentCertificateId', problem),
  });
  requireCoupled(PRACTICAL_RECOVERING_STATES.has(state) === (parsed.currentRecoveryEpisodeId !== null), problem, 'Recovery episode pointer does not match the state');
  requireCoupled((state === 'MANUAL_REVIEW_REQUIRED') === (parsed.currentReviewEpisodeId !== null), problem, 'Review episode pointer does not match the state');
  requireCoupled((state === 'CERTIFIED_IDLE') === (parsed.currentCertificateId !== null), problem, 'Certificate pointer does not match the state');
  return parsed;
}

/**
 * Builds the Stage 1A fence value from the flat row EXACTLY (a column that
 * does not belong to the mode must be NULL; it is never silently dropped),
 * then validates it with the Stage 1A validator.
 */
export function parsePracticalFenceRow(value: unknown): PracticalAccountFence {
  const problem = 'FENCE_ROW_INVALID';
  const row = asRecord(value, problem);
  const mode = field(row, 'mode', problem);
  const runId = field(row, 'runId', problem);
  const leaseId = field(row, 'leaseId', problem);
  const certificateId = field(row, 'certificateId', problem);
  const leaseAction = field(row, 'leaseAction', problem);
  let fenceMode: Readonly<Record<string, unknown>>;
  if (mode === 'IDLE') {
    requireCoupled(runId === null && leaseId === null && certificateId === null && leaseAction === null, problem, 'IDLE fence carries mode data');
    fenceMode = { kind: 'IDLE' };
  } else if (mode === 'CERTIFYING') {
    requireCoupled(leaseId === null && certificateId === null && leaseAction === null, problem, 'CERTIFYING fence carries lease data');
    fenceMode = { kind: 'CERTIFYING', runId };
  } else if (mode === 'MUTATION_LEASED') {
    requireCoupled(runId === null, problem, 'MUTATION_LEASED fence carries a run id');
    if (typeof certificateId !== 'string' || !PRACTICAL_DIGEST_PATTERN.test(certificateId)) malformed(problem, 'Leased certificate id is not a digest', 'certificateId');
    fenceMode = { kind: 'MUTATION_LEASED', leaseId, certificateId, action: leaseAction };
  } else {
    malformed(problem, 'Unknown durable fence mode', 'mode');
  }
  const candidate = {
    accountId: field(row, 'accountId', problem),
    runtimeEpoch: field(row, 'runtimeEpoch', problem),
    reconciliationGeneration: safeInteger(row, 'reconciliationGeneration', problem),
    revision: safeInteger(row, 'revision', problem),
    mode: fenceMode,
  };
  try {
    return readPracticalAccountFence(candidate);
  } catch (error) {
    // Only the Stage 1A fence refusal becomes MALFORMED; nothing becomes absent.
    if (error instanceof PracticalLiveSafetyError && error.code === 'PRACTICAL_FENCE_INVALID') {
      malformed(problem, 'The durable fence failed the Stage 1A validator');
    }
    throw error;
  }
}

export function parsePracticalCertificateRow(value: unknown): PracticalDurableCertificateRecord {
  const problem = 'CERTIFICATE_ROW_INVALID';
  const row = asRecord(value, problem);
  const record = Object.freeze({
    certificateId: digest(row, 'certificateId', problem),
    accountId: exactId(row, 'accountId', problem),
    providerAccountFingerprint: digest(row, 'providerAccountFingerprint', problem),
    runtimeEpoch: exactId(row, 'runtimeEpoch', problem),
    reconciliationGeneration: positiveInteger(row, 'reconciliationGeneration', problem),
    streamIncarnation: positiveInteger(row, 'streamIncarnation', problem),
    evidenceDigest: digest(row, 'evidenceDigest', problem),
    issuedAtMs: safeInteger(row, 'issuedAtMs', problem),
    expiresAtMs: safeInteger(row, 'expiresAtMs', problem),
    status: oneOf(row, 'status', CERTIFICATE_STATUSES, problem),
    terminalAtMs: nullableSafeInteger(row, 'terminalAtMs', problem),
    terminalReason: nullableReason(row, 'terminalReason', problem),
  });
  requireCoupled(record.expiresAtMs > record.issuedAtMs, problem, 'Certificate expiry is not after issuance');
  requireCoupled((record.status === 'ISSUED') === (record.terminalAtMs === null), problem, 'Certificate terminal time does not match its status');
  requireCoupled((record.status === 'EXPIRED' || record.status === 'REVOKED') === (record.terminalReason !== null), problem, 'Certificate terminal reason does not match its status');
  requireCoupled(record.status !== 'EXPIRED' || record.terminalReason === 'CERTIFICATE_EXPIRED', problem, 'An EXPIRED certificate must carry CERTIFICATE_EXPIRED');
  return record;
}

export function parsePracticalLeaseRow(value: unknown): PracticalMutationLeaseRecord {
  const problem = 'LEASE_ROW_INVALID';
  const row = asRecord(value, problem);
  const action = field(row, 'action', problem);
  if (!isPracticalMutationAction(action)) malformed(problem, 'Unknown durable lease action', 'action');
  const outcome = field(row, 'outcome', problem);
  if (outcome !== null && !(PRACTICAL_MUTATION_OUTCOMES as readonly unknown[]).includes(outcome)) malformed(problem, 'Unknown durable lease outcome', 'outcome');
  requireCoupled(field(row, 'armedAtMs', problem) === null, problem, 'A Stage 1B1 lease can never be armed');
  requireCoupled(field(row, 'intentId', problem) === null && field(row, 'clientOrderId', problem) === null, problem, 'A Stage 1B1 lease carries no intent or client order id');
  const record = Object.freeze({
    leaseId: exactId(row, 'leaseId', problem),
    accountId: exactId(row, 'accountId', problem),
    certificateId: digest(row, 'certificateId', problem),
    action,
    runtimeEpoch: exactId(row, 'runtimeEpoch', problem),
    reconciliationGeneration: positiveInteger(row, 'reconciliationGeneration', problem),
    createdAtMs: safeInteger(row, 'createdAtMs', problem),
    status: oneOf(row, 'status', ['LEASED', 'COMPLETED'] as const, problem),
    completedAtMs: nullableSafeInteger(row, 'completedAtMs', problem),
    outcome: outcome as PracticalMutationOutcome | null,
  });
  requireCoupled((record.status === 'LEASED') === (record.completedAtMs === null && record.outcome === null), problem, 'Lease completion fields do not match its status');
  requireCoupled(record.status === 'LEASED' || (record.completedAtMs !== null && record.outcome !== null), problem, 'A completed lease must record time and outcome');
  return record;
}

export function parsePracticalRecoveryEpisodeRow(value: unknown): PracticalRecoveryEpisodeRecord {
  const problem = 'RECOVERY_EPISODE_ROW_INVALID';
  const row = asRecord(value, problem);
  const startCause = field(row, 'startCause', problem);
  if (!(isPracticalInvalidationReason(startCause) || (typeof startCause === 'string' && NON_REASON_QUARANTINE_CAUSES.includes(startCause)))) {
    malformed(problem, 'Unknown recovery episode start cause', 'startCause');
  }
  const record = Object.freeze({
    episodeId: exactId(row, 'episodeId', problem),
    accountId: exactId(row, 'accountId', problem),
    startedAtMs: safeInteger(row, 'startedAtMs', problem),
    endedAtMs: nullableSafeInteger(row, 'endedAtMs', problem),
    startCause: startCause as PracticalQuarantineCause,
    status: oneOf(row, 'status', ['OPEN', 'CERTIFIED', 'ESCALATED_TO_MANUAL_REVIEW'] as const, problem),
    runtimeEpoch: exactId(row, 'runtimeEpoch', problem),
    reconciliationGeneration: nullableSafeInteger(row, 'reconciliationGeneration', problem),
    certifiedCertificateId: nullableDigest(row, 'certifiedCertificateId', problem),
    reviewEpisodeId: nullableExactId(row, 'reviewEpisodeId', problem),
    openedByResolutionId: nullableExactId(row, 'openedByResolutionId', problem),
  });
  requireCoupled((record.status === 'OPEN') === (record.endedAtMs === null), problem, 'Recovery episode end does not match its status');
  requireCoupled((record.status === 'CERTIFIED') === (record.certifiedCertificateId !== null), problem, 'Recovery episode certificate does not match its status');
  requireCoupled((record.status === 'ESCALATED_TO_MANUAL_REVIEW') === (record.reviewEpisodeId !== null), problem, 'Recovery episode escalation does not match its status');
  return record;
}

export function parsePracticalReviewEpisodeRow(value: unknown): PracticalReviewEpisodeRecord {
  const problem = 'REVIEW_EPISODE_ROW_INVALID';
  const row = asRecord(value, problem);
  const kind = oneOf(row, 'kind', ['INVALIDATION', 'MALFORMED_STATE'] as const, problem);
  const reason = field(row, 'reason', problem);
  const malformedProblem = field(row, 'malformedProblem', problem);
  if (kind === 'INVALIDATION') {
    if (!isPracticalInvalidationReason(reason)) malformed(problem, 'Unknown review episode reason', 'reason');
    // Only a MANUAL_REVIEW-severity invalidation ever enters review; a QUARANTINE-severity reason here was never written by Stage 1B1.
    requireCoupled(classifyPracticalInvalidation(reason) === 'MANUAL_REVIEW', problem, 'An invalidation review episode must carry a MANUAL_REVIEW-severity reason');
    requireCoupled(malformedProblem === null, problem, 'An invalidation review episode carries a malformed-state problem');
  } else {
    requireCoupled(reason === PRACTICAL_DURABLE_STATE_MALFORMED, problem, 'A malformed-state review episode must carry DURABLE_STATE_MALFORMED');
    if (typeof malformedProblem !== 'string' || !(PRACTICAL_MALFORMED_PROBLEMS as readonly string[]).includes(malformedProblem)) {
      malformed(problem, 'A malformed-state review episode must carry a known safe problem code', 'malformedProblem');
    }
  }
  const record = Object.freeze({
    reviewEpisodeId: exactId(row, 'reviewEpisodeId', problem),
    accountId: exactId(row, 'accountId', problem),
    kind,
    enteredAtMs: safeInteger(row, 'enteredAtMs', problem),
    reason: reason as PracticalReviewEpisodeRecord['reason'],
    malformedProblem: malformedProblem as PracticalMalformedProblem | null,
    runtimeEpoch: exactId(row, 'runtimeEpoch', problem),
    status: oneOf(row, 'status', ['OPEN', 'RESOLVED'] as const, problem),
    resolvedAtMs: nullableSafeInteger(row, 'resolvedAtMs', problem),
    resolutionId: nullableExactId(row, 'resolutionId', problem),
  });
  requireCoupled((record.status === 'OPEN') === (record.resolvedAtMs === null && record.resolutionId === null), problem, 'Review episode resolution does not match its status');
  requireCoupled(record.status === 'OPEN' || (record.resolvedAtMs !== null && record.resolutionId !== null), problem, 'A resolved review episode must record time and resolution');
  return record;
}

// ---------------------------------------------------------------------------
// Account assembly
// ---------------------------------------------------------------------------

/** Raw rows for one account. `null` = the read succeeded with zero rows; anything else is parsed strictly. */
export interface PracticalAccountRawRows {
  /** The malformed-state latch row, and the review episode it points at. */
  readonly latch: unknown;
  readonly latchEpisode: unknown;
  readonly state: unknown;
  readonly fence: unknown;
  readonly recoveryEpisode: unknown;
  readonly reviewEpisode: unknown;
  readonly certificate: unknown;
  /** The lease named by a MUTATION_LEASED fence (read by the fence's lease id); `null` otherwise. */
  readonly lease: unknown;
  /** The certificate named by a MUTATION_LEASED fence (read by the fence's certificate id); `null` otherwise. Never `certificate`. */
  readonly leasedCertificate: unknown;
}

/**
 * The COMPLETE lease-to-certificate binding: the certificate behind a lease
 * exactly agrees with it on certificate id, account, runtime epoch, and
 * reconciliation generation, and was durably CONSUMED (the one-shot that
 * created the lease). Exact string equality. Used by account assembly and,
 * independently, by `releaseLease` and the post-consume self-check.
 */
export function isPracticalCertificateBoundToLease(certificate: PracticalDurableCertificateRecord, lease: PracticalMutationLeaseRecord): boolean {
  return certificate.certificateId === lease.certificateId
    && certificate.accountId === lease.accountId
    && certificate.runtimeEpoch === lease.runtimeEpoch
    && certificate.reconciliationGeneration === lease.reconciliationGeneration
    && certificate.status === 'CONSUMED';
}

/**
 * The COMPLETE fence-to-lease binding: a MUTATION_LEASED fence and a LEASED
 * lease that exactly agree on lease id, certificate, account, action, runtime
 * epoch, and reconciliation generation. Exact string equality (never the
 * database's case-insensitive collation). Used by account assembly and,
 * independently, by `releaseLease` before it completes a lease.
 */
export function isPracticalLeaseBoundToFence(lease: PracticalMutationLeaseRecord, fence: PracticalAccountFence): boolean {
  return fence.mode.kind === 'MUTATION_LEASED'
    && lease.leaseId === fence.mode.leaseId
    && lease.certificateId === fence.mode.certificateId
    && lease.accountId === fence.accountId
    && lease.action === fence.mode.action
    && lease.runtimeEpoch === fence.runtimeEpoch
    && lease.reconciliationGeneration === fence.reconciliationGeneration
    && lease.status === 'LEASED';
}

export interface ParsedPracticalLatchRow {
  readonly accountId: string;
  readonly currentReviewEpisodeId: string | null;
  readonly revision: number;
}

export function parsePracticalLatchRow(value: unknown): ParsedPracticalLatchRow {
  const problem = 'LATCH_ROW_INVALID';
  const row = asRecord(value, problem);
  return Object.freeze({
    accountId: exactId(row, 'accountId', problem),
    currentReviewEpisodeId: nullableExactId(row, 'currentReviewEpisodeId', problem),
    revision: safeInteger(row, 'revision', problem),
  });
}

export interface PracticalLatchState {
  /** The parsed latch row, or null when the account has never been latched. */
  readonly latch: ParsedPracticalLatchRow | null;
  /** The CURRENT unresolved malformed-state episode, or null when not latched. */
  readonly reviewEpisodeId: string | null;
}

/**
 * Evaluates the malformed-state latch on its own (independently of the
 * possibly malformed account rows). An active latch must point at an OPEN
 * MALFORMED_STATE episode of the same account; anything else is MALFORMED
 * (LATCH_ROW_INVALID) and is never read as "not latched".
 */
export function evaluatePracticalLatch(accountId: string, latchRow: unknown, latchEpisodeRow: unknown): PracticalLatchState {
  const problem = 'LATCH_ROW_INVALID';
  if (latchRow === null) {
    requireCoupled(latchEpisodeRow === null, problem, 'A latch episode was read without a latch');
    return Object.freeze({ latch: null, reviewEpisodeId: null });
  }
  const latch = parsePracticalLatchRow(latchRow);
  requireCoupled(latch.accountId === accountId, problem, 'The latch belongs to a different account');
  if (latch.currentReviewEpisodeId === null) {
    requireCoupled(latchEpisodeRow === null, problem, 'A latch episode was read for an inactive latch');
    return Object.freeze({ latch, reviewEpisodeId: null });
  }
  requireCoupled(latchEpisodeRow !== null, problem, 'The latch names a review episode that does not exist');
  const episode = parsePracticalReviewEpisodeRow(latchEpisodeRow);
  requireCoupled(
    episode.reviewEpisodeId === latch.currentReviewEpisodeId && episode.accountId === accountId && episode.kind === 'MALFORMED_STATE' && episode.status === 'OPEN',
    problem,
    'The latch does not point at an OPEN malformed-state episode of this account',
  );
  return Object.freeze({ latch, reviewEpisodeId: episode.reviewEpisodeId });
}

/**
 * Parses and cross-validates one account's rows. Throws MALFORMED (never
 * returns null) on any problem; returns null ONLY when both the state row and
 * the fence row are exactly `null`. The latch is evaluated separately.
 */
export function assemblePracticalAccount(rows: PracticalAccountRawRows): PracticalAccountSnapshot | null {
  if (rows.state === null && rows.fence === null) return null;
  if (rows.state === null || rows.fence === null) malformed('PARTIAL_ACCOUNT_ROWS', 'The account has a state row without a fence row, or the reverse');
  const state = parsePracticalStateRow(rows.state);
  const fence = parsePracticalFenceRow(rows.fence);
  const inconsistent = (message: string): never => malformed('ROWS_INCONSISTENT', message);
  if (fence.accountId !== state.accountId) inconsistent('Fence and state rows belong to different accounts');

  const recoveryEpisode = pointed(rows.recoveryEpisode, state.currentRecoveryEpisodeId, parsePracticalRecoveryEpisodeRow);
  if (recoveryEpisode !== null && (recoveryEpisode.accountId !== state.accountId || recoveryEpisode.status !== 'OPEN' || recoveryEpisode.episodeId !== state.currentRecoveryEpisodeId)) {
    inconsistent('The current recovery episode is not an OPEN episode of this account');
  }
  const reviewEpisode = pointed(rows.reviewEpisode, state.currentReviewEpisodeId, parsePracticalReviewEpisodeRow);
  if (reviewEpisode !== null && (
    reviewEpisode.accountId !== state.accountId
    || reviewEpisode.status !== 'OPEN'
    || reviewEpisode.kind !== 'INVALIDATION'
    || reviewEpisode.reviewEpisodeId !== state.currentReviewEpisodeId
  )) {
    inconsistent('The current review episode is not an OPEN invalidation episode of this account');
  }
  const certificate = pointed(rows.certificate, state.currentCertificateId, parsePracticalCertificateRow);
  if (certificate !== null && (
    certificate.certificateId !== state.currentCertificateId
    || certificate.accountId !== state.accountId
    || certificate.status !== 'ISSUED'
    || certificate.runtimeEpoch !== fence.runtimeEpoch
    || certificate.reconciliationGeneration !== fence.reconciliationGeneration
  )) {
    inconsistent('The current certificate is not an ISSUED certificate bound to this account fence');
  }
  // A leased fence (whatever the state) must name its exact durable LEASED lease; missing,
  // completed, cross-account, wrong-action, wrong-epoch, or wrong-generation is MALFORMED.
  const lease = pointed(rows.lease, fence.mode.kind === 'MUTATION_LEASED' ? fence.mode.leaseId : null, parsePracticalLeaseRow);
  if (lease !== null && !isPracticalLeaseBoundToFence(lease, fence)) {
    inconsistent('The leased fence does not name a LEASED lease bound to it on every field');
  }
  // ...and that lease must rest on its exact CONSUMED certificate: missing, malformed, cross-account,
  // wrong-epoch, wrong-generation, ISSUED, REVOKED, or EXPIRED is MALFORMED (in every state).
  const leasedCertificate = pointed(rows.leasedCertificate, fence.mode.kind === 'MUTATION_LEASED' ? fence.mode.certificateId : null, parsePracticalCertificateRow);
  if (leasedCertificate !== null && (lease === null || !isPracticalCertificateBoundToLease(leasedCertificate, lease))) {
    inconsistent('The leased certificate is not the CONSUMED certificate bound to the lease on every field');
  }

  // State / fence coupling (QUARANTINED and MANUAL_REVIEW_REQUIRED may coexist with any fence mode).
  const requiredMode: Partial<Record<PracticalAccountStateName, PracticalAccountFence['mode']['kind']>> = {
    CERTIFYING: 'CERTIFYING',
    PROVIDER_UNAVAILABLE: 'IDLE',
    CERTIFIED_IDLE: 'IDLE',
    MUTATING: 'MUTATION_LEASED',
  };
  const mode = requiredMode[state.state];
  if (mode !== undefined && fence.mode.kind !== mode) inconsistent('The fence mode is impossible for the account state');

  return Object.freeze({
    accountId: state.accountId,
    state: state.state,
    stateRevision: state.revision,
    fence,
    currentRecoveryEpisode: recoveryEpisode,
    currentReviewEpisode: reviewEpisode,
    currentCertificate: certificate,
    currentLease: lease,
    leasedCertificate,
  });
}

function pointed<T>(row: unknown, pointer: string | null, parse: (value: unknown) => T): T | null {
  if (pointer === null) {
    if (row !== null) malformed('ROWS_INCONSISTENT', 'A row was read for a pointer that is not set');
    return null;
  }
  if (row === null) malformed('ROWS_INCONSISTENT', 'A current pointer names a row that does not exist');
  return parse(row);
}

/**
 * The MALFORMED problem carried by a persistence MALFORMED error. Any other
 * error, including a database failure, is rethrown unchanged: it is never
 * converted into a result.
 */
function malformedProblemOrRethrow(error: unknown): PracticalMalformedProblem {
  if (error instanceof PracticalPersistenceError && error.code === 'PRACTICAL_PERSISTENCE_MALFORMED' && error.details !== undefined) {
    const problem = error.details['problem'];
    if (typeof problem === 'string') return problem as PracticalMalformedProblem;
  }
  throw error;
}

function malformedLoad(problem: PracticalMalformedProblem, reviewEpisodeId: string | null): PracticalAccountLoad {
  return Object.freeze({ kind: 'MALFORMED' as const, problem, reviewEpisodeId });
}

/**
 * Converts the account's rows into the explicit three-way load result. Only a
 * MALFORMED persistence error becomes `MALFORMED`; every other error
 * (including database failures) propagates unchanged.
 *
 *   - NOT_FOUND only when the state, fence, AND latch reads all returned zero
 *     rows (any latch row proves a prior practical state existed);
 *   - an ACTIVE latch always yields MALFORMED with its current
 *     reviewEpisodeId, even when the rows have since become valid
 *     (LATCHED_PENDING_REVIEW): only the episode-bound resolution clears it;
 *   - FOUND only for valid rows with no active latch.
 */
export function toPracticalAccountLoad(accountId: string, rows: PracticalAccountRawRows): PracticalAccountLoad {
  let latch: PracticalLatchState;
  try {
    latch = evaluatePracticalLatch(accountId, rows.latch, rows.latchEpisode);
  } catch (error) {
    return malformedLoad(malformedProblemOrRethrow(error), null);
  }
  let account: PracticalAccountSnapshot | null;
  try {
    account = assemblePracticalAccount(rows);
  } catch (error) {
    return malformedLoad(malformedProblemOrRethrow(error), latch.reviewEpisodeId);
  }
  if (account === null) {
    return latch.latch === null ? Object.freeze({ kind: 'NOT_FOUND' as const }) : malformedLoad('PARTIAL_ACCOUNT_ROWS', latch.reviewEpisodeId);
  }
  if (account.accountId !== accountId) return malformedLoad('ROWS_INCONSISTENT', latch.reviewEpisodeId);
  if (latch.reviewEpisodeId !== null) return malformedLoad('LATCHED_PENDING_REVIEW', latch.reviewEpisodeId);
  return Object.freeze({ kind: 'FOUND' as const, account });
}

/** Same three-way result for a single record. */
export function toPracticalRecordLoad<T>(row: unknown, parse: (value: unknown) => T): PracticalRecordLoad<T> {
  if (row === null) return Object.freeze({ kind: 'NOT_FOUND' as const });
  try {
    return Object.freeze({ kind: 'FOUND' as const, record: parse(row) });
  } catch (error) {
    return Object.freeze({ kind: 'MALFORMED' as const, problem: malformedProblemOrRethrow(error) });
  }
}


/** A value that is never a practical state name: what a MALFORMED durable state is presented to Stage 1A as. */
const MALFORMED_DURABLE_STATE: unique symbol = Symbol('P18B malformed durable practical state');

/**
 * The Stage 1A startup state for a durable load, with the trusted-absence
 * rule made explicit:
 *   NOT_FOUND -> practicalAccountStateOnStartup(null)   = QUARANTINED
 *   FOUND     -> practicalAccountStateOnStartup(state)   (MANUAL_REVIEW sticky)
 *   MALFORMED -> practicalAccountStateOnStartup(<not a state>) = MANUAL_REVIEW_REQUIRED,
 *                latched or not (the latch makes that review durable and resolvable)
 */
export function practicalStartupStateFromLoad(load: PracticalAccountLoad): PracticalAccountStateName {
  switch (load.kind) {
    case 'NOT_FOUND':
      return practicalAccountStateOnStartup(null);
    case 'FOUND':
      return practicalAccountStateOnStartup(load.account.state);
    default:
      return practicalAccountStateOnStartup(MALFORMED_DURABLE_STATE);
  }
}
