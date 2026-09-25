/**
 * Phase 18B per-account fence (Stage 1A, pure domain only).
 *
 * One fence per account serializes practical certification and Tier-B
 * mutation: certification cannot begin while a mutation lease is held, a
 * lease cannot begin while certification runs, and there is at most one
 * lease. Every operation is a pure compare-and-set: it takes the current
 * fence record plus the caller's EXPECTED bindings (account, runtime epoch,
 * reconciliation generation, revision) and returns the next frozen record
 * with `revision + 1`, or throws. Nothing here locks, persists, or reads a
 * clock.
 *
 * Shaped so Stage 1B can persist it verbatim: read the row `FOR UPDATE`, apply
 * one of these functions to it, and write the result conditioned on the old
 * revision. A stale reader then fails on the revision, a process from a dead
 * runtime fails on the epoch, and a superseded generation fails on the
 * generation.
 *
 * The fence is not authority: holding MUTATION_LEASED does not authorize a
 * mutation (that also requires the consumed certificate named in the lease,
 * the action permission, and every Phase 17 check).
 *
 * FAIL CLOSED ON MALFORMED RECORDS. Every operation first validates the whole
 * fence record at runtime: exact own keys, exact identifiers, safe
 * non-negative integers, and a mode that is EXACTLY one of IDLE,
 * CERTIFYING(runId), or MUTATION_LEASED(leaseId, certificateId, action) with
 * its fields. A corrupt, unknown, or future mode is refused with
 * PRACTICAL_FENCE_INVALID. It is never treated as IDLE and never normalized.
 * Each operation then states the one mode it accepts, and anything else is a
 * refusal. A revision that cannot advance to a safe integer is also refused.
 */
import {
  PracticalLiveSafetyError,
  isExactId,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  isPracticalMutationAction,
  type PracticalMutationAction,
} from './types';

export type PracticalFenceMode =
  | { readonly kind: 'IDLE' }
  | { readonly kind: 'CERTIFYING'; readonly runId: string }
  | {
      readonly kind: 'MUTATION_LEASED';
      readonly leaseId: string;
      readonly certificateId: string;
      readonly action: PracticalMutationAction;
    };

export interface PracticalAccountFence {
  readonly accountId: string;
  readonly runtimeEpoch: string;
  readonly reconciliationGeneration: number;
  /** Compare-and-set token. Every successful operation increments it by exactly 1. */
  readonly revision: number;
  readonly mode: PracticalFenceMode;
}

/** What the caller believes the fence currently is. Every field must match exactly. */
export interface PracticalFenceExpectation {
  readonly accountId: string;
  readonly runtimeEpoch: string;
  readonly reconciliationGeneration: number;
  readonly revision: number;
}

const IDLE: PracticalFenceMode = Object.freeze({ kind: 'IDLE' as const });

function bindingMismatch(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new PracticalLiveSafetyError('PRACTICAL_FENCE_BINDING_MISMATCH', message, details);
}

function conflict(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new PracticalLiveSafetyError('PRACTICAL_FENCE_CONFLICT', message, details);
}

function invalidFence(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new PracticalLiveSafetyError('PRACTICAL_FENCE_INVALID', message, details);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** True when `value`'s own enumerable keys are exactly `keys` (no missing, no extra). */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function validateCertifyingMode(mode: Record<string, unknown>): void {
  if (!hasExactKeys(mode, ['kind', 'runId'])) invalidFence('CERTIFYING fence mode must carry exactly a runId');
  if (!isExactId(mode.runId)) invalidFence('CERTIFYING runId must be a non-empty exact string', { field: 'runId' });
}

function validateLeasedMode(mode: Record<string, unknown>): void {
  if (!hasExactKeys(mode, ['kind', 'leaseId', 'certificateId', 'action'])) {
    invalidFence('MUTATION_LEASED fence mode must carry exactly leaseId, certificateId, and action');
  }
  if (!isExactId(mode.leaseId)) invalidFence('MUTATION_LEASED leaseId must be a non-empty exact string', { field: 'leaseId' });
  if (!isExactId(mode.certificateId)) invalidFence('MUTATION_LEASED certificateId must be a non-empty exact string', { field: 'certificateId' });
  if (!isPracticalMutationAction(mode.action)) invalidFence('MUTATION_LEASED action must be a known mutation action', { field: 'action' });
}

/** Validates a mode exactly. Unknown kinds, missing or extra fields, and malformed values all fail closed. */
function validateMode(mode: unknown): void {
  if (!isPlainRecord(mode)) invalidFence('Fence mode must be a plain record');
  switch (mode.kind) {
    case 'IDLE':
      if (!hasExactKeys(mode, ['kind'])) invalidFence('IDLE fence mode has unexpected fields');
      return;
    case 'CERTIFYING':
      validateCertifyingMode(mode);
      return;
    case 'MUTATION_LEASED':
      validateLeasedMode(mode);
      return;
    default:
      // The raw kind is not echoed: a corrupt durable value is not trusted even as a log string.
      invalidFence('Unknown fence mode', { field: 'mode.kind' });
  }
}

/**
 * Validates a fence record before ANY operation. Never repairs or normalizes:
 * a malformed durable record is refused so that Stage 1B surfaces it instead
 * of acting on a guess.
 */
function validateFence(fence: unknown): PracticalAccountFence {
  if (!isPlainRecord(fence)) invalidFence('Fence must be a plain record');
  if (!hasExactKeys(fence, ['accountId', 'runtimeEpoch', 'reconciliationGeneration', 'revision', 'mode'])) {
    invalidFence('Fence record has missing or unexpected fields');
  }
  if (!isExactId(fence.accountId)) invalidFence('Fence accountId must be a non-empty exact string', { field: 'accountId' });
  if (!isExactId(fence.runtimeEpoch)) invalidFence('Fence runtimeEpoch must be a non-empty exact string', { field: 'runtimeEpoch' });
  if (!isNonNegativeSafeInteger(fence.reconciliationGeneration)) {
    invalidFence('Fence reconciliationGeneration must be a non-negative safe integer', { field: 'reconciliationGeneration' });
  }
  if (!isNonNegativeSafeInteger(fence.revision)) invalidFence('Fence revision must be a non-negative safe integer', { field: 'revision' });
  validateMode(fence.mode);
  return fence as unknown as PracticalAccountFence;
}

/**
 * [Stage 1B1] The same strict validator, exposed read-only so the durable
 * persistence adapter validates every stored fence row with the Stage 1A
 * rules before use. It never repairs or normalizes: a malformed value throws
 * PRACTICAL_FENCE_INVALID. It returns a frozen copy, so later changes to the
 * caller's object cannot affect it. It grants nothing and changes no state.
 */
export function readPracticalAccountFence(value: unknown): PracticalAccountFence {
  const fence = validateFence(value);
  const mode = fence.mode.kind === 'IDLE'
    ? IDLE
    : Object.freeze({ ...fence.mode });
  return Object.freeze({
    accountId: fence.accountId,
    runtimeEpoch: fence.runtimeEpoch,
    reconciliationGeneration: fence.reconciliationGeneration,
    revision: fence.revision,
    mode,
  });
}

/** revision + 1, refused rather than ever producing an unsafe integer. */
function nextRevision(fence: PracticalAccountFence): number {
  if (fence.revision >= Number.MAX_SAFE_INTEGER) invalidFence('Fence revision is exhausted and cannot advance safely', { field: 'revision' });
  return fence.revision + 1;
}

function next(fence: PracticalAccountFence, mode: PracticalFenceMode, reconciliationGeneration = fence.reconciliationGeneration): PracticalAccountFence {
  return Object.freeze({
    accountId: fence.accountId,
    runtimeEpoch: fence.runtimeEpoch,
    reconciliationGeneration,
    revision: nextRevision(fence),
    mode,
  });
}

/**
 * Validates the fence, then rejects any mismatch between it and the caller's
 * expectation. Epoch first, then generation, then revision.
 */
function assertExpected(fence: PracticalAccountFence, expected: PracticalFenceExpectation): void {
  validateFence(fence);
  if (fence.accountId !== expected.accountId) bindingMismatch('Fence belongs to a different account', { field: 'accountId' });
  if (fence.runtimeEpoch !== expected.runtimeEpoch) bindingMismatch('Fence belongs to a different runtime epoch', { field: 'runtimeEpoch' });
  if (fence.reconciliationGeneration !== expected.reconciliationGeneration) {
    bindingMismatch('Fence is bound to a different reconciliation generation', {
      field: 'reconciliationGeneration',
      fenceGeneration: fence.reconciliationGeneration,
      expectedGeneration: expected.reconciliationGeneration,
    });
  }
  if (fence.revision !== expected.revision) {
    bindingMismatch('Fence revision changed (stale compare-and-set)', { field: 'revision', fenceRevision: fence.revision, expectedRevision: expected.revision });
  }
}

/** The fence a new runtime creates for an account with no durable fence: IDLE, revision 0. */
export function initialPracticalFence(input: { readonly accountId: string; readonly runtimeEpoch: string; readonly reconciliationGeneration: number }): PracticalAccountFence {
  if (!isExactId(input.accountId) || !isExactId(input.runtimeEpoch) || !isNonNegativeSafeInteger(input.reconciliationGeneration)) {
    throw new PracticalLiveSafetyError('PRACTICAL_FENCE_BINDING_MISMATCH', 'Fence bindings must be exact identifiers and a non-negative generation');
  }
  return Object.freeze({ accountId: input.accountId, runtimeEpoch: input.runtimeEpoch, reconciliationGeneration: input.reconciliationGeneration, revision: 0, mode: IDLE });
}

/** IDLE -> CERTIFYING. Only an IDLE fence is accepted; every other mode is refused. */
export function beginPracticalCertification(fence: PracticalAccountFence, expected: PracticalFenceExpectation, runId: string): PracticalAccountFence {
  assertExpected(fence, expected);
  if (!isExactId(runId)) bindingMismatch('runId must be a non-empty exact string', { field: 'runId' });
  if (fence.mode.kind !== 'IDLE') {
    conflict(fence.mode.kind === 'MUTATION_LEASED'
      ? 'Certification cannot begin while a mutation lease is held'
      : 'Certification requires an IDLE fence (another certification holds it)', { mode: fence.mode.kind });
  }
  return next(fence, Object.freeze({ kind: 'CERTIFYING' as const, runId }));
}

/**
 * CERTIFYING(runId) -> IDLE, adopting the generation the certification ended
 * on, which must be STRICTLY greater than the fence's starting generation.
 * Every Phase 18 reconciliation run claims `current_generation + 1` before it
 * reads anything (`claimGeneration` in `../reconciliation/repository.ts`,
 * called first by `reconcileAccount`). A certification that finishes on the
 * same or an older generation therefore ran no genuine reconciliation of its
 * own and is refused. Used for both success and failure; success is recorded
 * separately by certificate issuance.
 */
export function finishPracticalCertification(
  fence: PracticalAccountFence,
  expected: PracticalFenceExpectation,
  runId: string,
  resultingGeneration: number,
): PracticalAccountFence {
  assertExpected(fence, expected);
  if (fence.mode.kind !== 'CERTIFYING') conflict('No certification holds the fence', { mode: fence.mode.kind });
  if (fence.mode.runId !== runId) bindingMismatch('Certification run does not own the fence', { field: 'runId' });
  if (!isPositiveSafeInteger(resultingGeneration) || resultingGeneration <= fence.reconciliationGeneration) {
    bindingMismatch('The resulting generation must be a safe integer strictly after the fence generation', {
      field: 'reconciliationGeneration',
      fenceGeneration: fence.reconciliationGeneration,
    });
  }
  return next(fence, IDLE, resultingGeneration);
}

/**
 * IDLE -> MUTATION_LEASED. Only an IDLE fence is accepted, so there is exactly
 * one lease and none while certifying. The generation in `expected` must be
 * the certificate's generation, so a newer generation fails here.
 */
export function beginPracticalMutationLease(
  fence: PracticalAccountFence,
  expected: PracticalFenceExpectation,
  lease: { readonly leaseId: string; readonly certificateId: string; readonly action: PracticalMutationAction },
): PracticalAccountFence {
  assertExpected(fence, expected);
  if (!isExactId(lease.leaseId) || !isExactId(lease.certificateId)) bindingMismatch('Lease and certificate ids must be exact identifiers', { field: 'lease' });
  if (!isPracticalMutationAction(lease.action)) bindingMismatch('Unknown mutation action', { field: 'action' });
  if (fence.mode.kind !== 'IDLE') {
    conflict(fence.mode.kind === 'MUTATION_LEASED'
      ? 'A mutation lease is already held; only one is allowed'
      : 'A mutation lease requires an IDLE fence (certification holds it)', { mode: fence.mode.kind });
  }
  return next(fence, Object.freeze({
    kind: 'MUTATION_LEASED' as const,
    leaseId: lease.leaseId,
    certificateId: lease.certificateId,
    action: lease.action,
  }));
}

/** MUTATION_LEASED(leaseId) -> IDLE, once the mutation's outcome is durably recorded. */
export function releasePracticalMutationLease(fence: PracticalAccountFence, expected: PracticalFenceExpectation, leaseId: string): PracticalAccountFence {
  assertExpected(fence, expected);
  if (fence.mode.kind !== 'MUTATION_LEASED') conflict('No mutation lease is held', { mode: fence.mode.kind });
  if (fence.mode.leaseId !== leaseId) bindingMismatch('The lease id does not own the fence', { field: 'leaseId' });
  return next(fence, IDLE);
}

/**
 * Adopts a fence left by a previous runtime epoch. IDLE and an abandoned
 * CERTIFYING are safely reset to IDLE under the new epoch (a dead run's
 * certification can never complete). A MUTATION_LEASED fence is REFUSED here:
 * whether its mutation reached the wire must be decided from durable Phase 17
 * arm state first (Stage 1B), never by this pure step. A malformed or unknown
 * mode is refused by validation and is never reset to IDLE.
 */
export function adoptPracticalFenceForNewRuntime(
  fence: PracticalAccountFence,
  expected: { readonly accountId: string; readonly previousRuntimeEpoch: string; readonly revision: number },
  newRuntimeEpoch: string,
): PracticalAccountFence {
  validateFence(fence);
  if (fence.accountId !== expected.accountId) bindingMismatch('Fence belongs to a different account', { field: 'accountId' });
  if (fence.runtimeEpoch !== expected.previousRuntimeEpoch) bindingMismatch('Fence is not from the expected previous runtime epoch', { field: 'runtimeEpoch' });
  if (fence.revision !== expected.revision) bindingMismatch('Fence revision changed (stale compare-and-set)', { field: 'revision' });
  if (!isExactId(newRuntimeEpoch) || newRuntimeEpoch === fence.runtimeEpoch) bindingMismatch('The new runtime epoch must be a different exact identifier', { field: 'runtimeEpoch' });
  if (fence.mode.kind !== 'IDLE' && fence.mode.kind !== 'CERTIFYING') {
    conflict('A lease left by a previous runtime needs its wire-arm state resolved before adoption', { mode: fence.mode.kind });
  }
  return Object.freeze({
    accountId: fence.accountId,
    runtimeEpoch: newRuntimeEpoch,
    reconciliationGeneration: fence.reconciliationGeneration,
    revision: nextRevision(fence),
    mode: IDLE,
  });
}
