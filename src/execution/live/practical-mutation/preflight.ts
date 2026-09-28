/**
 * Phase 18B Stage 1B2 (Wave 2B1): pure preflight classification.
 *
 * Prisma-free, network-free, clock-free. Two decisions live here so they are
 * directly unit-testable and cannot drift inside the adapter:
 *
 *   1. `classifyPracticalReconciliationMismatch`: the ONE deterministic
 *      mapping from a locked `live_reconciliation_state` row to an existing
 *      Stage 1A invalidation reason. This is a durable-state consistency
 *      check for Tier B only. It is NOT account continuity and NOT a Phase 18
 *      authorization: it never calls, mints, or reads the strict barrier.
 *
 *   2. `isClassifiedPreWriteClaimFailure`: the EXACT set of Phase 17 cancel
 *      claim refusals that are known (source-order pinned) to be thrown
 *      BEFORE the claim's only UPDATE, and that may therefore be converted
 *      into a same-transaction PREFLIGHT_MISMATCH invalidation (after a
 *      second, runtime no-write proof). LIVE_DURABLE_INTEGRITY_VIOLATION and
 *      LIVE_PERSISTENCE_FAULT are deliberately NOT in the set: they are
 *      integrity/persistence faults that must roll the whole acquisition back.
 */
import { LiveExecutionError } from '../errors';
import type { PracticalSafetyCeilings } from '../practical/policy';
import { isExactId } from '../practical/types';

// ---------------------------------------------------------------------------
// Reconciliation-state mapping
// ---------------------------------------------------------------------------

export type PracticalReconciliationMismatchReason = 'PREFLIGHT_MISMATCH' | 'RUNTIME_EPOCH_CHANGED' | 'GENERATION_CHANGED';

export interface PracticalReconciliationExpectation {
  readonly accountId: string;
  /** The runtime epoch of THIS process (from its genuine runtime identity). */
  readonly runtimeEpoch: string;
  /** The generation the practical certificate / lease is bound to. */
  readonly reconciliationGeneration: number;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Deterministic, first-match precedence (R0, A, B, C); `null` only when every
 * rule holds exactly:
 *
 *   R0  row missing / not a plain record / accountId not EXACTLY the account  -> PREFLIGHT_MISMATCH
 *   A   currentRuntimeEpoch !== expected runtime epoch (null included)         -> RUNTIME_EPOCH_CHANGED
 *   B   currentGeneration or healthyGeneration not a safe integer,
 *       OR currentGeneration !== healthyGeneration
 *       OR currentGeneration !== expected generation
 *       OR healthyGeneration !== expected generation                          -> GENERATION_CHANGED
 *   C   status !== 'HEALTHY' OR blockingFindingCount !== 0
 *       OR currentRunId not an exact id of at most 64 characters              -> PREFLIGHT_MISMATCH
 *
 * The CONFIG_CHANGED (tightened effective lifetime) decision is made by the
 * caller BEFORE the reconciliation row is read, so it is not a rule here.
 */
export function classifyPracticalReconciliationMismatch(
  row: unknown,
  expected: PracticalReconciliationExpectation,
): PracticalReconciliationMismatchReason | null {
  // R0
  if (!isPlainRecord(row) || typeof row['accountId'] !== 'string' || row['accountId'] !== expected.accountId) return 'PREFLIGHT_MISMATCH';
  // A
  if (row['currentRuntimeEpoch'] !== expected.runtimeEpoch) return 'RUNTIME_EPOCH_CHANGED';
  // B
  const currentGeneration = row['currentGeneration'];
  const healthyGeneration = row['healthyGeneration'];
  if (!isSafeInteger(currentGeneration)
    || !isSafeInteger(healthyGeneration)
    || currentGeneration !== healthyGeneration
    || currentGeneration !== expected.reconciliationGeneration
    || healthyGeneration !== expected.reconciliationGeneration) {
    return 'GENERATION_CHANGED';
  }
  // C
  const currentRunId = row['currentRunId'];
  if (row['status'] !== 'HEALTHY'
    || row['blockingFindingCount'] !== 0
    || !isExactId(currentRunId)
    || currentRunId.length > 64) {
    return 'PREFLIGHT_MISMATCH';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Classified Phase 17 pre-write claim refusals
// ---------------------------------------------------------------------------

/**
 * EXACTLY the Phase 17 claim refusal codes thrown only BEFORE the claim's
 * single UPDATE (pinned against the committed claim source by architecture
 * test). Nothing else is ever converted to an invalidation.
 */
export const PRACTICAL_CLASSIFIED_PRE_WRITE_CLAIM_FAILURE_CODES = Object.freeze([
  'LIVE_INTENT_INVALID',
  'LIVE_AUTHORITY_INVALID',
  'LIVE_ORDER_IDENTITY_MISMATCH',
] as const);
export type PracticalClassifiedPreWriteClaimFailureCode = (typeof PRACTICAL_CLASSIFIED_PRE_WRITE_CLAIM_FAILURE_CODES)[number];

/**
 * True only for a GENUINE `LiveExecutionError` (its exact class prototype and
 * an own `code`) carrying one of the three classified codes. Any Prisma or
 * SQL error, any other code (including LIVE_DURABLE_INTEGRITY_VIOLATION and
 * LIVE_PERSISTENCE_FAULT), a plain Error, or a structural `{ code }` object is
 * false, and so escapes to roll the whole transaction back.
 */
export function isClassifiedPreWriteClaimFailure(error: unknown): error is LiveExecutionError & { readonly code: PracticalClassifiedPreWriteClaimFailureCode } {
  return error instanceof LiveExecutionError
    && Object.getPrototypeOf(error) === LiveExecutionError.prototype
    && Object.prototype.hasOwnProperty.call(error, 'code')
    && (PRACTICAL_CLASSIFIED_PRE_WRITE_CLAIM_FAILURE_CODES as readonly string[]).includes(error.code);
}

// ---------------------------------------------------------------------------
// Effective time bounds (from the genuine enablement's reviewed ceilings)
// ---------------------------------------------------------------------------

/** The quiet dwell before a Tier-B CANCEL: the stricter of the two dwell ceilings. */
export function practicalCancelDwellMs(ceilings: PracticalSafetyCeilings): number {
  return Math.max(ceilings.firstMutationDwellMs, ceilings.postIssuanceDwellMs);
}
