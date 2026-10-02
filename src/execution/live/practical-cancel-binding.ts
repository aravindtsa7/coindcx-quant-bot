/**
 * [P18B Stage 1B2 Wave 2B2a] The Phase17/18 view of a Stage 1B2 order-bound
 * practical CANCEL lease, and the one classification both the Phase18 planner
 * (advisory) and the Phase17 public-write guard (authoritative) apply to it.
 *
 * PURE. It imports no practical module, no Prisma client, and no authority:
 * Phase17/18 learn only the durable FACT that a lease names an order's CURRENT
 * cancel generation, never any practical capability. Nothing here grants,
 * reads, or mints authority; it only decides when an ordinary Phase17/18 write
 * to the cancel columns must be refused.
 *
 * Only the lease naming the order's EXACT CURRENT `cancelGeneration` is ever
 * a binding. A lease for an older generation is history and never blocks.
 *
 * The frozen schema compares `intent_id`, `client_order_id`, and `account_id`
 * under a case-insensitive, pad-space collation, so a row returned by SQL
 * equality is only a candidate: every identity is re-proven here with exact
 * JavaScript `===`, and a row that matched only by collation — or any
 * malformed or contradictory row — is a durable integrity violation.
 */
import { LiveExecutionError } from './errors';
import type { LiveCancelAttemptState } from './types';

export type LivePracticalCancelBindingOutcome = 'ACCEPTED' | 'REJECTED' | 'AMBIGUOUS' | 'PRE_DISPATCH_FAILURE';

/** The order's CURRENT-generation practical binding, or null. Closed, frozen, exact. */
export interface LivePracticalCancelBindingView {
  readonly leaseId: string;
  readonly accountId: string;
  readonly intentId: string;
  readonly clientOrderId: string;
  readonly cancelGeneration: number;
  readonly status: 'LEASED' | 'COMPLETED';
  readonly outcome: LivePracticalCancelBindingOutcome | null;
  readonly armedAtMs: number | null;
}

/** The exact identity a binding must re-prove: the verified order's own values. */
export interface LivePracticalCancelBindingExpectation {
  readonly accountId: string;
  readonly intentId: string;
  readonly clientOrderId: string;
  readonly cancelGeneration: number;
}

/**
 * What an ordinary (non-Stage-1B2) Phase17/18 cancel-column write may do.
 *
 *   UNBOUND     no lease names the current generation: ordinary behavior.
 *   HISTORICAL  COMPLETED PRE_DISPATCH_FAILURE/NONE, or the exact armed
 *               ACCEPTED/CANCEL_ACKNOWLEDGED and REJECTED/CANCEL_REJECTED pairs;
 *               the coupled completion already happened; ordinary behavior
 *               (including a new claim at generation + 1).
 *   LEASED      the lease still owns the claim: refuse.
 *   PRACTICAL_AMBIGUITY_UNRESOLVED
 *               COMPLETED AMBIGUOUS with CANCEL_AMBIGUOUS: sticky; only a
 *               future reviewed evidence boundary may resolve it: refuse.
 *   SPLIT       any other COMPLETED combination: integrity violation.
 */
export type LivePracticalCancelBindingVerdict =
  | 'UNBOUND'
  | 'HISTORICAL'
  | 'LEASED'
  | 'PRACTICAL_AMBIGUITY_UNRESOLVED'
  | 'SPLIT';

const OUTCOMES: readonly string[] = Object.freeze(['ACCEPTED', 'REJECTED', 'AMBIGUOUS', 'PRE_DISPATCH_FAILURE']);
const ROW_KEYS: readonly string[] = Object.freeze([
  'accountId', 'armedAtMs', 'cancelGeneration', 'clientOrderId', 'intentId', 'leaseId', 'outcome', 'status',
]);
const LEASE_ID_PATTERN = /^[\x21-\x7E]{1,64}$/;

function integrity(message: string, details: Record<string, unknown>): never {
  throw new LiveExecutionError('LIVE_DURABLE_INTEGRITY_VIOLATION', message, { details });
}

function safeInteger(value: unknown): number | null {
  if (typeof value === 'bigint') {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Strictly parses ONE raw lease row against the verified order's exact
 * identity. Every string must be exactly (`===`) the order's own value.
 */
export function parsePracticalCancelBindingRow(
  row: unknown,
  expected: LivePracticalCancelBindingExpectation,
): LivePracticalCancelBindingView {
  const context = { intentId: expected.intentId, cancelGeneration: expected.cancelGeneration };
  if (typeof row !== 'object' || row === null || Array.isArray(row)) integrity('Practical cancel binding row is not a record', context);
  const record = row as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== ROW_KEYS.join(',')) integrity('Practical cancel binding row has an unexpected shape', context);
  const { leaseId, accountId, intentId, clientOrderId, status, outcome } = record;
  if (typeof leaseId !== 'string' || !LEASE_ID_PATTERN.test(leaseId)) integrity('Practical cancel binding lease id is malformed', context);
  if (accountId !== expected.accountId) integrity('Practical cancel binding account does not exactly equal the order account', context);
  if (intentId !== expected.intentId) integrity('Practical cancel binding intent does not exactly equal the order intent', context);
  if (clientOrderId !== expected.clientOrderId) integrity('Practical cancel binding client order id does not exactly equal the order client order id', context);
  const cancelGeneration = safeInteger(record['cancelGeneration']);
  if (cancelGeneration === null || cancelGeneration < 1 || cancelGeneration !== expected.cancelGeneration) {
    integrity('Practical cancel binding generation does not exactly equal the order current cancel generation', context);
  }
  if (status !== 'LEASED' && status !== 'COMPLETED') integrity('Practical cancel binding status is unknown', context);
  if (outcome !== null && (typeof outcome !== 'string' || !OUTCOMES.includes(outcome))) {
    integrity('Practical cancel binding outcome is not a valid bound CANCEL outcome', context);
  }
  if ((status === 'LEASED') !== (outcome === null)) integrity('Practical cancel binding status and outcome contradict each other', context);
  const rawArmed = record['armedAtMs'];
  const armedAtMs = rawArmed === null ? null : safeInteger(rawArmed);
  if (rawArmed !== null && armedAtMs === null) integrity('Practical cancel binding arm time is malformed', context);
  if (armedAtMs === null && outcome !== null && outcome !== 'PRE_DISPATCH_FAILURE') {
    integrity('An unarmed practical cancel binding records an outcome other than PRE_DISPATCH_FAILURE', context);
  }
  return Object.freeze({
    leaseId: leaseId as string,
    accountId: expected.accountId,
    intentId: expected.intentId,
    clientOrderId: expected.clientOrderId,
    cancelGeneration: cancelGeneration as number,
    status: status as 'LEASED' | 'COMPLETED',
    outcome: outcome as LivePracticalCancelBindingOutcome | null,
    armedAtMs,
  });
}

/**
 * The CURRENT-generation binding from the rows an exact
 * `(intent_id, cancel_generation)` read returned: none, or exactly one.
 */
export function currentPracticalCancelBinding(
  rows: readonly unknown[],
  expected: LivePracticalCancelBindingExpectation,
): LivePracticalCancelBindingView | null {
  if (!Array.isArray(rows)) integrity('Practical cancel binding read did not return rows', { intentId: expected.intentId });
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    integrity('More than one practical lease names this order\'s current cancel generation', {
      intentId: expected.intentId, cancelGeneration: expected.cancelGeneration,
    });
  }
  return parsePracticalCancelBindingRow(rows[0], expected);
}

/** The single classification the planner and the guard both apply. */
export function classifyPracticalCancelBinding(
  binding: LivePracticalCancelBindingView | null,
  cancelState: LiveCancelAttemptState | string,
): LivePracticalCancelBindingVerdict {
  if (binding === null) return 'UNBOUND';
  if (binding.status === 'LEASED') return 'LEASED';
  if (binding.outcome === 'PRE_DISPATCH_FAILURE' && cancelState === 'NONE') return 'HISTORICAL';
  if (binding.armedAtMs !== null && ((binding.outcome === 'ACCEPTED' && cancelState === 'CANCEL_ACKNOWLEDGED')
    || (binding.outcome === 'REJECTED' && cancelState === 'CANCEL_REJECTED'))) return 'HISTORICAL';
  if (binding.outcome === 'AMBIGUOUS' && binding.armedAtMs !== null && cancelState === 'CANCEL_AMBIGUOUS') {
    return 'PRACTICAL_AMBIGUITY_UNRESOLVED';
  }
  return 'SPLIT';
}

// Reviewed defining-owner binding protection.
Object.freeze(classifyPracticalCancelBinding);
Object.freeze(currentPracticalCancelBinding);
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const name of ["classifyPracticalCancelBinding","currentPracticalCancelBinding"]) {
    const value = module.exports[name] as unknown;
    const descriptor = Object.getOwnPropertyDescriptor(module.exports, name);
    if (descriptor?.configurable === false) {
      if (descriptor.set !== undefined || (descriptor.get === undefined && descriptor.writable !== false) || module.exports[name] !== value) throw new Error('OWNED_TRUSTED_EXPORT_INVALID');
    } else Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
  }
}
