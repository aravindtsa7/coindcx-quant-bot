/**
 * Durable Phase17 execution state (§8).
 *
 * The port below is what the service depends on. The Prisma implementation is
 * the production adapter; its idempotence guarantees come from database
 * constraints and conditional updates, never from in-memory locks:
 *
 *   - `ensureIntent` inserts the immutable intent and its CREATED order under
 *     `PRIMARY KEY(intent_id)` + `UNIQUE(client_order_id)`. A duplicate insert
 *     collides in the database; identical content resolves idempotently, and
 *     different content is `LIVE_INTENT_CONFLICT`.
 *   - `claimDispatch` is a single conditional `UPDATE ... WHERE state='CREATED'`.
 *     Exactly one concurrent worker can observe `count === 1`; every other
 *     worker deterministically resolves to ALREADY_CLAIMED and must not mutate
 *     the exchange (P17-I07).
 *   - `commitState` is a conditional update on the exact expected `revision`,
 *     so a state computed from a stale read can never overwrite a newer one.
 *   - observation validation, dedup insertion, and projection update share one
 *     row-locking transaction, so no event can outrun its financial effect.
 */
import type { PrismaClient } from '@prisma/client';
import { sha256CanonicalJson } from '../../risk';
import { canonicalLiveDecimalString, liveDecimal } from './decimal';
import { LiveExecutionError } from './errors';
import type { LiveExecutionIntentRecord } from './intent';
import { LiveReconciliationAuthorization, type LiveReconciliationAuthorizationRecord } from './reconciliation/repository';
import { applyLiveOrderObservation, initialLiveOrderState } from './state-machine';
import type { LiveCancelAttemptState, LiveOrderObservation, LiveOrderStateName, LiveOrderStateRecord } from './types';

export type ClaimDispatchOutcome =
  | { readonly kind: 'CLAIMED'; readonly order: LiveOrderStateRecord }
  | { readonly kind: 'ALREADY_CLAIMED'; readonly order: LiveOrderStateRecord };

export type ClaimCancelOutcome =
  | { readonly kind: 'CLAIMED'; readonly order: LiveOrderStateRecord; readonly generation: number }
  | { readonly kind: 'ALREADY_CLAIMED'; readonly order: LiveOrderStateRecord; readonly generation: number }
  | { readonly kind: 'NOT_CANCELLABLE'; readonly order: LiveOrderStateRecord; readonly generation: number };

export type CompleteCancelAttemptOutcome = 'ACKNOWLEDGED' | 'AMBIGUOUS' | 'REJECTED';

export interface LivePositionOwnershipRecord {
  readonly accountId: string;
  readonly pair: string;
  readonly positionInstanceId: string;
  readonly positionRevision: number;
  readonly side: 'LONG' | 'SHORT';
  readonly ownedQuantity: string;
  readonly instrumentSpecSnapshotId: string;
  readonly ownerStrategyInstanceId: string;
  readonly ownerStrategyId: string;
  readonly ownerStrategyVersion: string;
  readonly ownerParameterHash: string;
}

export interface LiveOrderObservationIdentity {
  readonly intentId: string;
  readonly accountId: string;
  readonly clientOrderId: string;
  readonly pair: string;
  readonly side: 'BUY' | 'SELL';
  readonly wireOrderType: string;
  readonly quantity: string;
  readonly price: string | null;
  readonly settlementRateInrPerQuote: string | null;
  readonly marginCurrencyShortName: 'INR';
}

export interface LiveExecutionRepository {
  /**
   * Durably records the immutable intent and its CREATED order, or returns the
   * already-recorded one. Fails closed with `LIVE_INTENT_CONFLICT` when a
   * stored row binds the same identity to different economic content.
   */
  ensureIntent(intent: LiveExecutionIntentRecord): Promise<LiveOrderStateRecord>;
  /** Atomic, database-enforced single dispatch claim. */
  claimDispatch(intentId: string, reconciliationAuthorization?: unknown, consumeOpenAdmission?: () => Promise<boolean>): Promise<ClaimDispatchOutcome>;
  /** Optimistic-concurrency state commit. */
  commitState(next: LiveOrderStateRecord, expectedRevision: number, reconciliationAuthorization?: unknown): Promise<LiveOrderStateRecord>;
  /** Validates, deduplicates, records, and projects one observation in one transaction. */
  applyObservationAtomically(intentId: string, observation: LiveOrderObservation, reconciliationAuthorization?: unknown): Promise<LiveOrderStateRecord>;
  /** Database-enforced exclusive cancellation mutation claim. */
  claimCancel(intentId: string, trustedAccountId: string, reconciliationAuthorization?: unknown): Promise<ClaimCancelOutcome>;
  completeCancelAttempt(intentId: string, generation: number, outcome: CompleteCancelAttemptOutcome, faultCode: string | null, reconciliationAuthorization?: unknown): Promise<LiveOrderStateRecord>;
  /**
   * [P18 Wave A2 / F18-14] Durably proves a create-order wire request MAY be
   * about to leave this process. HEALTHY-fenced exactly like `commitState`,
   * and must commit BEFORE the gateway is ever called. Refuses (fenced out)
   * if this account's reconciliation generation was superseded since the
   * dispatch reservation was taken, so a stale worker can never arm — and
   * therefore never send — a wire request (Case A of F18-14).
   */
  armDispatchWire(intentId: string, expectedRevision: number, reconciliationAuthorization?: unknown): Promise<LiveOrderStateRecord>;
  /** [P18 Wave A2 / F18-14] The cancel-mutation equivalent of `armDispatchWire`. */
  armCancelWire(intentId: string, expectedRevision: number, reconciliationAuthorization?: unknown): Promise<LiveOrderStateRecord>;
  /** A timed-out create claim becomes explicitly ambiguous; timeout never releases or resends it. */
  markExpiredDispatchUnresolved(intentId: string, trustedAccountId: string, cutoff: Date, reconciliationAuthorization?: unknown): Promise<LiveOrderStateRecord>;
  load(intentId: string): Promise<LiveOrderStateRecord | null>;
  /** Immutable economics used to validate every provider observation. */
  loadObservationIdentity(intentId: string): Promise<LiveOrderObservationIdentity | null>;
  /** Authoritative durable ownership used to compose CLOSE; never caller DTO data. */
  loadPositionOwnership(accountId: string, pair: string): Promise<LivePositionOwnershipRecord | null>;
  /**
   * [Phase18] Commits a state Phase18 reconciliation computed from
   * authoritative venue evidence, optionally recording the observation that
   * proved it in the SAME transaction.
   *
   * This exists so reconciliation never writes `live_order` itself: it gets the
   * identical verify-before-write discipline as every Phase17 path — sealed
   * intent digest, immutable mirror re-proof, revision-guarded conditional
   * update — plus the append-only event dedup. It is the only way an
   * ambiguous create or a crash-interrupted dispatch claim can be resolved.
   */
  commitReconciledState(
    next: LiveOrderStateRecord,
    expectedRevision: number,
    observation: LiveOrderObservation | null,
    reconciliationAuthorization?: unknown,
  ): Promise<LiveOrderStateRecord>;
  /**
   * [Phase18] Every durable order for one account, each verified exactly as
   * `load` verifies a single one, joined with the immutable intent economics
   * reconciliation must compare against.
   */
  listAccountOrderViews(accountId: string): Promise<readonly LiveDurableOrderRow[]>;
}

/**
 * [Phase18] A verified durable order joined with its verified immutable intent.
 *
 * Both halves come from the same digest-checked read, so reconciliation can
 * never compare a projection against a different snapshot of the intent that
 * authorizes it.
 */
export interface LiveDurableOrderRow {
  readonly intentId: string;
  readonly clientOrderId: string;
  readonly accountId: string;
  readonly pair: string;
  readonly state: LiveOrderStateName;
  readonly exchangeOrderId: string | null;
  readonly side: 'BUY' | 'SELL';
  readonly action: 'OPEN' | 'CLOSE';
  readonly wireOrderType: string;
  readonly orderedQuantity: string;
  readonly cumulativeFilledQuantity: string;
  readonly averageFillPrice: string | null;
  readonly price: string | null;
  readonly leverage: string | null;
  readonly timeInForce: string;
  readonly cancelState: LiveCancelAttemptState;
  readonly strategyInstanceId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly instrumentSpecSnapshotId: string;
  readonly positionInstanceId: string | null;
  readonly reduceOnlyQuantity: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly revision: number;
  /** [P18 Wave A2 / F18-14] See `LiveOrderStateRecord.dispatchWireArmed`. */
  readonly dispatchWireArmed: boolean;
  /** [P18 Wave A2 / F18-14] See `LiveOrderStateRecord.cancelWireArmed`. */
  readonly cancelWireArmed: boolean;
}

/** Stable dedup identity of one exchange observation (P17 §9 repeated event). */
export function observationSha256(observation: LiveOrderObservation): string {
  return sha256CanonicalJson({
    kind: observation.kind,
    clientOrderId: observation.clientOrderId,
    exchangeClientOrderId: observation.exchangeClientOrderId,
    exchangeOrderId: observation.exchangeOrderId,
    pair: observation.pair,
    side: observation.side,
    cumulativeFilledQuantity: observation.cumulativeFilledQuantity,
    orderedQuantity: observation.orderedQuantity,
    averageFillPrice: observation.averageFillPrice,
    exchangeStatus: observation.exchangeStatus,
    providerEventTimeMs: observation.providerEventTimeMs,
  });
}

/** Canonical immutable semantic digest; mutable venue/projection state is excluded. */
export function liveExecutionIntentContentSha256(intent: LiveExecutionIntentRecord): string {
  const content = intent.content;
  return sha256CanonicalJson({
    schema: 'P17_LIVE_INTENT_STORED_V1',
    intentId: intent.intentId,
    clientOrderId: intent.clientOrderId,
    wireOrderType: intent.wireOrderType,
    content: {
      ...content,
      quantity: canonicalLiveDecimalString(content.quantity, 'quantity'),
      price: content.price === null ? null : canonicalLiveDecimalString(content.price, 'price'),
      leverage: content.leverage === null ? null : canonicalLiveDecimalString(content.leverage, 'leverage'),
      authorizedNotionalInr: canonicalLiveDecimalString(content.authorizedNotionalInr, 'authorizedNotionalInr'),
      settlementRateInrPerQuote: content.settlementRateInrPerQuote === null
        ? null : canonicalLiveDecimalString(content.settlementRateInrPerQuote, 'settlementRateInrPerQuote'),
      reduceOnlyQuantity: content.reduceOnlyQuantity === null
        ? null : canonicalLiveDecimalString(content.reduceOnlyQuantity, 'reduceOnlyQuantity'),
    },
    lineage: intent.lineage,
  });
}

interface DecimalLike { toFixed(): string }

function decimalString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && typeof (value as DecimalLike).toFixed === 'function') {
    return (value as DecimalLike).toFixed();
  }
  throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Durable decimal column was not readable as an exact string');
}

function optionalDecimalString(value: unknown): string | null {
  return value === null || value === undefined ? null : decimalString(value);
}

function bigIntToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const asNumber = Number(value as bigint);
  if (!Number.isSafeInteger(asNumber)) {
    throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Durable timestamp exceeded safe integer range');
  }
  return asNumber;
}

interface LiveOrderRow {
  readonly intentId: string;
  readonly clientOrderId: string;
  readonly accountId: string;
  readonly pair: string;
  readonly state: string;
  readonly exchangeOrderId: string | null;
  readonly orderedQuantity: unknown;
  readonly cumulativeFilledQuantity: unknown;
  readonly remainingQuantity: unknown;
  readonly averageFillPrice: unknown;
  readonly lastExchangeStatus: string | null;
  readonly lastProviderEventTimeMs: unknown;
  readonly faultCode: string | null;
  readonly cancelState: string;
  readonly cancelGeneration: number;
  readonly cancelExchangeOrderId: string | null;
  readonly cancelFaultCode: string | null;
  readonly dispatchWireArmed: boolean;
  readonly cancelWireArmed: boolean;
  readonly revision: number;
}

/**
 * [F18-18] The valid-state matrix for the two wire-arm flags this file owns.
 *
 * `dispatchWireArmed` may be `true` ONLY while `state === 'DISPATCH_RESERVED'`;
 * `cancelWireArmed` may be `true` ONLY while `cancelState === 'CANCEL_RESERVED'`.
 * Every legitimate write path in this file clears the corresponding flag the
 * instant its owning state is left — `applyLiveOrderObservation`,
 * `markSubmissionAmbiguous`, `markRejected`, `releaseDispatchClaim`,
 * `reclaimDispatchAfterCrash`/`reclaimCancelAfterCrash`, `completeCancelAttempt`,
 * and `markExpiredDispatchUnresolved` — so a row that violates this matrix
 * cannot be produced by any code path here. Reading one back is therefore
 * corruption or tampering, exactly like a sealed-digest mismatch, and it
 * fails closed rather than being silently ignored or coerced.
 */
function assertWireArmedConsistency(order: LiveOrderStateRecord): void {
  if (order.dispatchWireArmed && order.state !== 'DISPATCH_RESERVED') {
    throw new LiveExecutionError('LIVE_DURABLE_INTEGRITY_VIOLATION', 'Durable live order is wire-armed for dispatch outside an active DISPATCH_RESERVED claim', {
      details: { intentId: order.intentId, state: order.state },
    });
  }
  if (order.cancelWireArmed && order.cancelState !== 'CANCEL_RESERVED') {
    throw new LiveExecutionError('LIVE_DURABLE_INTEGRITY_VIOLATION', 'Durable live order is wire-armed for cancel outside an active CANCEL_RESERVED claim', {
      details: { intentId: order.intentId, cancelState: order.cancelState },
    });
  }
}

function toStateRecord(row: LiveOrderRow): LiveOrderStateRecord {
  const record = Object.freeze({
    intentId: row.intentId,
    clientOrderId: row.clientOrderId,
    accountId: row.accountId,
    pair: row.pair,
    state: row.state as LiveOrderStateName,
    exchangeOrderId: row.exchangeOrderId,
    orderedQuantity: decimalString(row.orderedQuantity),
    cumulativeFilledQuantity: decimalString(row.cumulativeFilledQuantity),
    remainingQuantity: decimalString(row.remainingQuantity),
    averageFillPrice: optionalDecimalString(row.averageFillPrice),
    lastExchangeStatus: row.lastExchangeStatus,
    lastProviderEventTimeMs: bigIntToNumber(row.lastProviderEventTimeMs),
    faultCode: row.faultCode,
    cancelState: row.cancelState as LiveCancelAttemptState,
    cancelGeneration: row.cancelGeneration,
    cancelExchangeOrderId: row.cancelExchangeOrderId,
    cancelFaultCode: row.cancelFaultCode,
    dispatchWireArmed: row.dispatchWireArmed === true,
    cancelWireArmed: row.cancelWireArmed === true,
    revision: row.revision,
  });
  assertWireArmedConsistency(record);
  return record;
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002';
}

/**
 * [F17-R03] THE database trust boundary.
 *
 * Everything below this comment exists so that exactly one rule holds, with no
 * exception anywhere in this file: a durable row may not influence any
 * authority decision, any wire mutation, or any returned authoritative state
 * until its content has been proven to be the content Phase17 sealed.
 *
 * Two proofs are applied, in this order:
 *
 *   1. `verifyStoredIntentIntegrity` reconstructs the canonical intent from the
 *      immutable `live_execution_intent` columns, recomputes
 *      `liveExecutionIntentContentSha256`, and requires it to equal the stored
 *      `content_sha256`. A single altered economic column — quantity, price,
 *      side, account, leverage, notional ceiling, position lineage, risk
 *      lineage — changes the digest and fails closed.
 *
 *   2. `assertOrderProjectionMatchesIntent` re-derives the four `live_order`
 *      columns that are pure immutable mirrors of the verified intent and
 *      requires exact agreement. The mutable projection columns (state, fills,
 *      revision, cancel bookkeeping) are legitimately variable and carry no
 *      digest; they are instead guarded by the frozen state machine, the
 *      revision-guarded commit, and the row locks. The mirrors are what an
 *      attacker would otherwise edit to redirect ownership or inflate the
 *      accepted fill envelope, so they are the ones that are re-proven.
 *
 * Not digest-verifiable, and deliberately not pretended to be:
 *   - `live_position` carries no sealed digest because Phase17 does not write
 *     it. It is never trusted on its own: `claimDispatch`'s CLOSE branch only
 *     ever compares it, under `FOR UPDATE`, against an already-verified intent,
 *     so a tampered position row can cause a refusal but can never widen what a
 *     CLOSE is allowed to do.
 *   - `live_order_event` rows are append-only audit and dedup keys. No field of
 *     an event row is ever read back as truth; only the existence of a digest
 *     is, and inventing one can only suppress a duplicate, never fabricate a
 *     fill.
 *   - A writer with full SQL access can of course rewrite content AND its
 *     digest together. That is unforgeable only for paths holding an
 *     independently-minted intent to compare against (`ensureIntent`, and
 *     therefore every dispatch). For pure recovery paths the digest is the
 *     available proof, and it is enforced.
 */
function reconstructStoredIntent(storedRow: unknown): LiveExecutionIntentRecord {
  const stored = storedRow as Record<string, unknown>;
  const approvalPresent = stored['validationSubjectId'] !== null
    || stored['validationPlanId'] !== null
    || stored['validationSubjectResultSha256'] !== null;
  return {
    intentId: String(stored['intentId']),
    clientOrderId: String(stored['clientOrderId']),
    wireOrderType: String(stored['wireOrderType']),
    quantityAdjusted: false,
    priceAdjusted: false,
    content: {
      accountId: String(stored['accountId']),
      pair: String(stored['pair']),
      side: stored['side'] as LiveExecutionIntentRecord['content']['side'],
      action: stored['action'] as LiveExecutionIntentRecord['content']['action'],
      quantity: decimalString(stored['quantity']),
      orderType: stored['orderType'] as LiveExecutionIntentRecord['content']['orderType'],
      price: optionalDecimalString(stored['price']),
      timeInForce: stored['timeInForce'] as LiveExecutionIntentRecord['content']['timeInForce'],
      leverage: optionalDecimalString(stored['leverage']),
      riskDecisionId: String(stored['riskDecisionId']),
      admissionId: stored['admissionId'] === null ? null : String(stored['admissionId']),
      strategyInstanceId: String(stored['strategyInstanceId']),
      strategyId: String(stored['strategyId']),
      strategyVersion: String(stored['strategyVersion']),
      parameterHash: String(stored['parameterHash']),
      liveExecutionPolicyId: String(stored['liveExecutionPolicyId']),
      instrumentSpecSnapshotId: String(stored['instrumentSpecSnapshotId']),
      authorizedNotionalInr: decimalString(stored['authorizedNotionalInr']),
      settlementRateInrPerQuote: optionalDecimalString(stored['settlementRateInrPerQuote']),
      positionInstanceId: stored['positionInstanceId'] === null ? null : String(stored['positionInstanceId']),
      positionRevision: stored['positionRevision'] === null ? null : Number(stored['positionRevision']),
      reduceOnlyQuantity: optionalDecimalString(stored['reduceOnlyQuantity']),
    },
    lineage: {
      sourceStrategyDecisionId: String(stored['sourceStrategyDecisionId']),
      researchApproval: approvalPresent ? {
        validationSubjectId: String(stored['validationSubjectId']),
        validationPlanId: String(stored['validationPlanId']),
        validationSubjectResultSha256: String(stored['validationSubjectResultSha256']),
      } : null,
    },
  };
}

/** A durable intent row that has proven it still holds the content Phase17 sealed. */
export interface VerifiedStoredIntent {
  readonly intent: LiveExecutionIntentRecord;
  readonly digest: string;
}

/**
 * The ONLY way this file is allowed to obtain an intent from the database.
 * Every authoritative read, replay, recovery and restart path goes through it;
 * a malformed row (unreadable decimal, absent column) fails here too, because a
 * row that cannot even be canonicalized is equally untrustworthy.
 */
export function verifyStoredIntentIntegrity(storedRow: unknown): VerifiedStoredIntent {
  const stored = storedRow as Record<string, unknown>;
  const intentId = typeof stored['intentId'] === 'string' ? stored['intentId'] : '<unreadable>';
  let digest: string;
  try {
    digest = liveExecutionIntentContentSha256(reconstructStoredIntent(storedRow));
  } catch (cause) {
    throw new LiveExecutionError('LIVE_DURABLE_INTEGRITY_VIOLATION', 'Durable live execution intent could not be canonicalized for integrity verification', {
      details: { intentId },
      cause,
    });
  }
  if (stored['contentSha256'] !== digest) {
    throw new LiveExecutionError('LIVE_DURABLE_INTEGRITY_VIOLATION', 'Durable live execution intent contradicts its own sealed content digest', {
      details: { intentId },
    });
  }
  return Object.freeze({ intent: reconstructStoredIntent(storedRow), digest });
}

/**
 * The `live_order` columns below are written once from the intent and never
 * updated, so any divergence is corruption or tampering — never a legitimate
 * lifecycle change. `orderedQuantity` in particular bounds every fill the state
 * machine will accept, and `accountId` is what `claimCancel` and
 * `markExpiredDispatchUnresolved` compare the trusted credential owner against.
 */
function assertOrderProjectionMatchesIntent(order: LiveOrderStateRecord, verified: VerifiedStoredIntent): void {
  const { content } = verified.intent;
  const mismatch = order.intentId !== verified.intent.intentId
    || order.clientOrderId !== verified.intent.clientOrderId
    || order.accountId !== content.accountId
    || order.pair !== content.pair
    || canonicalLiveDecimalString(order.orderedQuantity, 'orderedQuantity') !== canonicalLiveDecimalString(content.quantity, 'quantity');
  if (mismatch) {
    throw new LiveExecutionError('LIVE_DURABLE_INTEGRITY_VIOLATION', 'Durable live order projection contradicts its verified immutable intent', {
      details: { intentId: order.intentId },
    });
  }
}

/** Minimal structural view of the Prisma delegates a verified read needs; satisfied by both the client and an interactive transaction client. */
interface IntentReadClient {
  readonly liveOrder: { findUnique(args: { where: { intentId: string }; include: { intent: true } }): Promise<unknown> };
  readonly liveExecutionIntent: { findUnique(args: { where: { intentId: string } }): Promise<unknown> };
}

interface ReconciliationFenceClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/**
 * [F18-15] Tags a deliberate Phase17 unit-test transaction double so it may
 * skip the reconciliation fence — for tests that exist purely to exercise
 * intent-integrity verification and never touch reconciliation at all.
 *
 * This is an EXPLICIT opt-in a real Prisma client or interactive transaction
 * can never carry, unlike the structural "does this object happen to expose a
 * `liveReconciliationState` delegate" check this replaces. That structural
 * check silently fail-opened the fence whenever a Prisma client's generated
 * delegate was absent or stale — a partially-deployed migration, a stale
 * generated client, or any other accidental mismatch would have silently
 * disabled Phase18 fencing in production instead of blocking live mutation.
 * A production transaction never carries this symbol, so its absence is what
 * makes the fence fail closed by default; only a fixture that explicitly sets
 * `tx[LIVE_EXECUTION_TEST_TRANSACTION] = true` may bypass it.
 */
export const LIVE_EXECUTION_TEST_TRANSACTION: unique symbol = Symbol('live-execution-test-transaction');

interface MaybeTestTransaction {
  readonly [LIVE_EXECUTION_TEST_TRANSACTION]?: true;
}

/** Locks and validates the exact generation authority inside an economic write. */
async function assertReconciliationFence(
  tx: ReconciliationFenceClient,
  authorization: unknown,
  accountId: string | null,
  requiredMode?: 'HEALTHY' | 'RUNNING',
): Promise<LiveReconciliationAuthorizationRecord | null> {
  // [F18-15] The ONLY bypass, and it requires an explicit, deliberate marker —
  // never inferred from what the transaction object happens to be missing.
  if ((tx as MaybeTestTransaction)[LIVE_EXECUTION_TEST_TRANSACTION] === true) return null;
  const authority = LiveReconciliationAuthorization.read(authorization);
  if (authority === null || (requiredMode !== undefined && authority.mode !== requiredMode)
      || (accountId !== null && authority.accountId !== accountId)) {
    throw new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'A genuine current reconciliation authorization is required');
  }
  // Use the locking read itself as the value read. A separate ordinary SELECT
  // here would establish a REPEATABLE READ snapshot before a later live_order
  // lock wait and could observe a pre-wait projection; the single locking read
  // preserves both the account serialization order and Phase17's fresh-read
  // integrity guarantees.
  const rows = await tx.$queryRaw<Array<{
    accountId: string;
    status: string;
    currentGeneration: number;
    currentRunId: string | null;
    currentRuntimeEpoch: string | null;
    healthyGeneration: number | null;
    blockingFindingCount: number;
    revision: number;
  }>>`SELECT account_id AS accountId, status, current_generation AS currentGeneration,
      current_run_id AS currentRunId, current_runtime_epoch AS currentRuntimeEpoch,
      healthy_generation AS healthyGeneration, blocking_finding_count AS blockingFindingCount,
      revision
    FROM live_reconciliation_state WHERE account_id = ${authority.accountId} FOR UPDATE`;
  const state = rows[0] ?? null;
  const healthy = authority.mode === 'HEALTHY'
    && state?.status === 'HEALTHY'
    && state.healthyGeneration === authority.generation
    && state.blockingFindingCount === 0;
  const running = authority.mode === 'RUNNING' && state?.status === 'RUNNING';
  if (state === null || state.currentRunId !== authority.runId
      || state.currentGeneration !== authority.generation
      || state.currentRuntimeEpoch !== authority.runtimeEpoch
      || state.revision !== authority.stateRevision
      || (!healthy && !running)) {
    throw new LiveExecutionError('LIVE_RECONCILIATION_STALE_GENERATION', 'Reconciliation authorization no longer owns the current durable generation', {
      details: { accountId: authority.accountId, generation: authority.generation },
    });
  }
  return authority;
}

/** A verified order projection together with the verified intent that authorizes it. */
export interface VerifiedLiveOrder {
  readonly order: LiveOrderStateRecord;
  readonly verifiedIntent: VerifiedStoredIntent;
}

/**
 * One verified read used by every path that returns or acts on authoritative
 * durable order state. The intent is fetched with the order in the same query,
 * so the pair can never be verified against a different snapshot than the one
 * the caller acts on.
 */
async function readVerifiedOrder(client: IntentReadClient, intentId: string): Promise<VerifiedLiveOrder | null> {
  const row = await client.liveOrder.findUnique({ where: { intentId }, include: { intent: true } }) as (LiveOrderRow & { intent?: unknown }) | null;
  if (row === null) return null;
  const intentRow = row.intent ?? await client.liveExecutionIntent.findUnique({ where: { intentId } });
  if (intentRow === null || intentRow === undefined) {
    throw new LiveExecutionError('LIVE_DURABLE_INTEGRITY_VIOLATION', 'Durable live order exists without the immutable intent that authorizes it', {
      details: { intentId },
    });
  }
  const verifiedIntent = verifyStoredIntentIntegrity(intentRow);
  const order = toStateRecord(row);
  assertOrderProjectionMatchesIntent(order, verifiedIntent);
  return Object.freeze({ order, verifiedIntent });
}

/**
 * Production Prisma-backed repository.
 *
 * Holds no authority and performs no policy decision: it persists exactly the
 * state the caller computed through the frozen state machine, and refuses
 * anything the database's own constraints reject.
 */
export class PrismaLiveExecutionRepository implements LiveExecutionRepository {
  readonly #prisma: PrismaClient;

  public constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  public async ensureIntent(intent: LiveExecutionIntentRecord): Promise<LiveOrderStateRecord> {
    const existing = await this.#prisma.liveExecutionIntent.findUnique({ where: { intentId: intent.intentId } });
    if (existing !== null) {
      this.#assertStoredIntentMatches(existing, intent);
      const order = await this.load(intent.intentId);
      if (order === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Durable intent exists without its order projection', {
          details: { intentId: intent.intentId },
        });
      }
      return order;
    }

    const initial = initialLiveOrderState({
      intentId: intent.intentId,
      clientOrderId: intent.clientOrderId,
      accountId: intent.content.accountId,
      pair: intent.content.pair,
      orderedQuantity: intent.content.quantity,
    });

    try {
      await this.#prisma.$transaction([
        this.#prisma.liveExecutionIntent.create({ data: this.#intentCreateData(intent) }),
        this.#prisma.liveOrder.create({
          data: {
            intentId: initial.intentId,
            clientOrderId: initial.clientOrderId,
            accountId: initial.accountId,
            pair: initial.pair,
            state: initial.state,
            exchangeOrderId: null,
            orderedQuantity: initial.orderedQuantity,
            cumulativeFilledQuantity: initial.cumulativeFilledQuantity,
            remainingQuantity: initial.remainingQuantity,
            averageFillPrice: null,
            lastExchangeStatus: null,
            lastProviderEventTimeMs: null,
            faultCode: null,
            cancelState: initial.cancelState,
            cancelGeneration: initial.cancelGeneration,
            cancelExchangeOrderId: initial.cancelExchangeOrderId,
            cancelFaultCode: initial.cancelFaultCode,
            revision: initial.revision,
          },
        }),
      ]);
      return initial;
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      // Lost an insert race, or a different intent already owns this client
      // order id. Re-read and let the content comparison decide which.
      const stored = await this.#prisma.liveExecutionIntent.findUnique({ where: { intentId: intent.intentId } });
      if (stored === null) {
        throw new LiveExecutionError('LIVE_INTENT_CONFLICT', 'Client order identity is already bound to a different live execution intent', {
          details: { intentId: intent.intentId, clientOrderId: intent.clientOrderId },
        });
      }
      this.#assertStoredIntentMatches(stored, intent);
      const order = await this.load(intent.intentId);
      if (order === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Durable intent exists without its order projection', {
          details: { intentId: intent.intentId },
        });
      }
      return order;
    }
  }

  public async claimDispatch(intentId: string, reconciliationAuthorization?: unknown, consumeOpenAdmission?: () => Promise<boolean>): Promise<ClaimDispatchOutcome> {
    // Backward-compatible argument shape for pure Phase17 test doubles only.
    if (typeof reconciliationAuthorization === 'function' && consumeOpenAdmission === undefined) {
      consumeOpenAdmission = reconciliationAuthorization as () => Promise<boolean>;
      reconciliationAuthorization = undefined;
    }
    let claimed: { readonly count: number };
    try {
      claimed = await this.#prisma.$transaction(async (tx) => {
      const fence = await assertReconciliationFence(tx as unknown as ReconciliationFenceClient, reconciliationAuthorization, null, 'HEALTHY');
      // Lock before reading either half of the sealed identity. Verification
      // and CREATED -> DISPATCH_RESERVED therefore share one transaction.
      await tx.$executeRaw`SELECT intent_id FROM live_order WHERE intent_id = ${intentId} FOR UPDATE`;
      await tx.$executeRaw`SELECT intent_id FROM live_execution_intent WHERE intent_id = ${intentId} FOR UPDATE`;
      const projection = await readVerifiedOrder(tx as unknown as IntentReadClient, intentId);
      if (projection === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Live order vanished during dispatch claim', { details: { intentId } });
      }
      const { order: current, verifiedIntent } = projection;
      if (fence !== null && current.accountId !== fence.accountId) {
        throw new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'Reconciliation authorization belongs to a different account');
      }
      if (current.state !== 'CREATED') return { count: 0 };
      const intent = verifiedIntent.intent.content;

      if (intent.action === 'OPEN') {
        if (intent.admissionId === null || consumeOpenAdmission === undefined) {
          throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'OPEN dispatch requires authenticated admission consumption');
        }
        const existing = await tx.liveAdmissionConsumption.findUnique({ where: { admissionId: intent.admissionId } });
        if (existing !== null && (existing.intentId !== intentId
            || existing.accountId !== intent.accountId
            || existing.pair !== intent.pair
            || existing.riskDecisionId !== intent.riskDecisionId)) {
          throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Admission capacity is already consumed by a different economic intent');
        }
        if (existing === null) {
          await tx.liveAdmissionConsumption.create({ data: {
            admissionId: intent.admissionId, intentId, accountId: intent.accountId, pair: intent.pair, riskDecisionId: intent.riskDecisionId,
          } });
        }
        // Allocation and current validity are separate proofs. Revalidate the
        // genuine admission on every new mutation attempt, even for the same
        // intent with an existing durable consumption row.
        if (!await consumeOpenAdmission()) {
          throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Admission is released, revoked, stale, or already consumed');
        }
      } else {
        if (intent.positionInstanceId === null || intent.positionRevision === null || intent.reduceOnlyQuantity === null) {
          throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'CLOSE intent lacks durable position lineage');
        }
        await tx.$executeRaw`SELECT account_id FROM live_position WHERE account_id = ${intent.accountId} AND pair = ${intent.pair} FOR UPDATE`;
        const position = await tx.livePosition.findUnique({ where: { accountId_pair: { accountId: intent.accountId, pair: intent.pair } } });
        const reducingSide = position?.side === 'LONG' ? 'SELL' : 'BUY';
        // Every comparison below is against the digest-verified intent, so an
        // undigested `live_position` row can only ever cause a refusal.
        if (position === null || position.positionInstanceId !== intent.positionInstanceId
            || position.revision !== intent.positionRevision || position.instrumentSpecSnapshotId !== intent.instrumentSpecSnapshotId
            || position.ownerStrategyInstanceId !== intent.strategyInstanceId || position.ownerStrategyId !== intent.strategyId
            || position.ownerStrategyVersion !== intent.strategyVersion || position.ownerParameterHash !== intent.parameterHash
            || reducingSide !== intent.side
            || canonicalLiveDecimalString(intent.reduceOnlyQuantity, 'reduceOnlyQuantity') !== canonicalLiveDecimalString(intent.quantity, 'quantity')
            || liveDecimal(intent.quantity).greaterThan(liveDecimal(decimalString(position.quantity)))) {
          throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'CLOSE position ownership is stale or the order is not strictly exposure-reducing');
        }
      }

      return tx.liveOrder.updateMany({
        where: {
          intentId,
          state: 'CREATED',
          revision: current.revision,
          clientOrderId: current.clientOrderId,
          accountId: current.accountId,
          pair: current.pair,
          orderedQuantity: canonicalLiveDecimalString(current.orderedQuantity, 'orderedQuantity'),
        },
        data: { state: 'DISPATCH_RESERVED', dispatchWireArmed: false, revision: { increment: 1 } },
      });
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      // [F17-R03] The lost-race resolution path is authoritative too: it decides
      // whether a dispatch is safely idempotent, so it re-verifies rather than
      // trusting the same columns a second time.
      const [intentRow, consumption, order] = await Promise.all([
        this.#prisma.liveExecutionIntent.findUnique({ where: { intentId } }),
        this.#prisma.liveAdmissionConsumption.findUnique({ where: { intentId } }),
        this.load(intentId),
      ]);
      const intent = intentRow === null ? null : verifyStoredIntentIntegrity(intentRow).intent.content;
      if (intent !== null && intent.admissionId !== null && order !== null
          && consumption?.intentId === intentId
          && consumption.admissionId === intent.admissionId
          && consumption.accountId === intent.accountId
          && consumption.pair === intent.pair
          && consumption.riskDecisionId === intent.riskDecisionId) {
        return { kind: 'ALREADY_CLAIMED', order };
      }
      throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Admission capacity is already consumed by a different economic intent');
    }
    const order = await this.load(intentId);
    if (order === null) {
      throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Live order vanished during dispatch claim', { details: { intentId } });
    }
    return claimed.count === 1 ? { kind: 'CLAIMED', order } : { kind: 'ALREADY_CLAIMED', order };
  }

  /**
   * [P18 Wave A2 / F18-14] The durable pre-wire checkpoint (§5, §11). Locks and
   * re-verifies the sealed intent and immutable mirrors exactly like every
   * other HEALTHY-fenced write, then conditionally flips `dispatchWireArmed`
   * from false to true on the exact expected revision. Refuses (fenced out) if
   * the account's reconciliation generation was superseded since the caller's
   * `HEALTHY` authorization was minted — so a stale worker's arm attempt fails
   * BEFORE it can ever reach the gateway, and it sends zero wire requests.
   */
  public async armDispatchWire(intentId: string, expectedRevision: number, reconciliationAuthorization?: unknown): Promise<LiveOrderStateRecord> {
    return this.#prisma.$transaction(async (tx) => {
      const fence = await assertReconciliationFence(tx as unknown as ReconciliationFenceClient, reconciliationAuthorization, null, 'HEALTHY');
      await tx.$executeRaw`SELECT intent_id FROM live_order WHERE intent_id = ${intentId} FOR UPDATE`;
      await tx.$executeRaw`SELECT intent_id FROM live_execution_intent WHERE intent_id = ${intentId} FOR UPDATE`;
      const verified = await readVerifiedOrder(tx as unknown as IntentReadClient, intentId);
      if (verified === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Live order vanished while arming the dispatch wire attempt', { details: { intentId } });
      }
      const current = verified.order;
      if (fence !== null && current.accountId !== fence.accountId) {
        throw new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'Reconciliation authorization belongs to a different account');
      }
      if (current.state !== 'DISPATCH_RESERVED' || current.dispatchWireArmed || current.revision !== expectedRevision) {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Cannot arm a create-order wire attempt outside an unarmed DISPATCH_RESERVED claim at the expected revision', {
          details: { intentId, expectedRevision },
        });
      }
      const updated = await tx.liveOrder.updateMany({
        where: {
          intentId, state: 'DISPATCH_RESERVED', dispatchWireArmed: false, revision: expectedRevision,
          clientOrderId: current.clientOrderId, accountId: current.accountId, pair: current.pair,
          orderedQuantity: canonicalLiveDecimalString(current.orderedQuantity, 'orderedQuantity'),
        },
        data: { dispatchWireArmed: true, revision: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Concurrent modification: dispatch wire arm claim moved before it could commit', {
          details: { intentId, expectedRevision },
        });
      }
      const committed = await readVerifiedOrder(tx as unknown as IntentReadClient, intentId);
      if (committed === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Live order vanished after arming the dispatch wire attempt', { details: { intentId } });
      }
      return committed.order;
    });
  }

  /** [P18 Wave A2 / F18-14] The cancel-mutation equivalent of `armDispatchWire`. */
  public async armCancelWire(intentId: string, expectedRevision: number, reconciliationAuthorization?: unknown): Promise<LiveOrderStateRecord> {
    return this.#prisma.$transaction(async (tx) => {
      const fence = await assertReconciliationFence(tx as unknown as ReconciliationFenceClient, reconciliationAuthorization, null, 'HEALTHY');
      await tx.$executeRaw`SELECT intent_id FROM live_order WHERE intent_id = ${intentId} FOR UPDATE`;
      await tx.$executeRaw`SELECT intent_id FROM live_execution_intent WHERE intent_id = ${intentId} FOR UPDATE`;
      const verified = await readVerifiedOrder(tx as unknown as IntentReadClient, intentId);
      if (verified === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Live order vanished while arming the cancel wire attempt', { details: { intentId } });
      }
      const current = verified.order;
      if (fence !== null && current.accountId !== fence.accountId) {
        throw new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'Reconciliation authorization belongs to a different account');
      }
      if (current.cancelState !== 'CANCEL_RESERVED' || current.cancelWireArmed || current.revision !== expectedRevision) {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Cannot arm a cancel wire attempt outside an unarmed CANCEL_RESERVED claim at the expected revision', {
          details: { intentId, expectedRevision },
        });
      }
      const updated = await tx.liveOrder.updateMany({
        where: {
          intentId, cancelState: 'CANCEL_RESERVED', cancelWireArmed: false, revision: expectedRevision,
          clientOrderId: current.clientOrderId, accountId: current.accountId, pair: current.pair,
          orderedQuantity: canonicalLiveDecimalString(current.orderedQuantity, 'orderedQuantity'),
        },
        data: { cancelWireArmed: true, revision: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Concurrent modification: cancel wire arm claim moved before it could commit', {
          details: { intentId, expectedRevision },
        });
      }
      const committed = await readVerifiedOrder(tx as unknown as IntentReadClient, intentId);
      if (committed === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Live order vanished after arming the cancel wire attempt', { details: { intentId } });
      }
      return committed.order;
    });
  }

  /**
   * Locks and re-verifies both the sealed intent and every immutable order
   * mirror immediately before the conditional state write. The predicate also
   * pins the verified state, revision, identity, and canonical quantity.
   */
  public async commitState(next: LiveOrderStateRecord, expectedRevision: number, reconciliationAuthorization?: unknown): Promise<LiveOrderStateRecord> {
    return this.#prisma.$transaction(async (tx) => {
      await assertReconciliationFence(tx as unknown as ReconciliationFenceClient, reconciliationAuthorization, next.accountId, 'HEALTHY');
      await tx.$executeRaw`SELECT intent_id FROM live_order WHERE intent_id = ${next.intentId} FOR UPDATE`;
      await tx.$executeRaw`SELECT intent_id FROM live_execution_intent WHERE intent_id = ${next.intentId} FOR UPDATE`;
      const verified = await readVerifiedOrder(tx as unknown as IntentReadClient, next.intentId);
      if (verified === null) {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Concurrent modification: durable live order vanished', {
          details: { intentId: next.intentId, expectedRevision },
        });
      }
      const current = verified.order;
      assertOrderProjectionMatchesIntent(next, verified.verifiedIntent);
      if (current.revision !== expectedRevision) {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Concurrent modification: durable live order revision moved', {
          details: { intentId: next.intentId, expectedRevision },
        });
      }
      const updated = await tx.liveOrder.updateMany({
        where: {
          intentId: current.intentId,
          state: current.state,
          revision: expectedRevision,
          clientOrderId: current.clientOrderId,
          accountId: current.accountId,
          pair: current.pair,
          orderedQuantity: canonicalLiveDecimalString(current.orderedQuantity, 'orderedQuantity'),
        },
        data: {
          state: next.state,
          exchangeOrderId: next.exchangeOrderId,
          cumulativeFilledQuantity: next.cumulativeFilledQuantity,
          remainingQuantity: next.remainingQuantity,
          averageFillPrice: next.averageFillPrice,
          lastExchangeStatus: next.lastExchangeStatus,
          lastProviderEventTimeMs: next.lastProviderEventTimeMs === null ? null : BigInt(next.lastProviderEventTimeMs),
          faultCode: next.faultCode,
          cancelState: next.cancelState,
          cancelGeneration: next.cancelGeneration,
          cancelExchangeOrderId: next.cancelExchangeOrderId,
          cancelFaultCode: next.cancelFaultCode,
          dispatchWireArmed: next.dispatchWireArmed,
          cancelWireArmed: next.cancelWireArmed,
          revision: next.revision,
        },
      });
      if (updated.count !== 1) {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Concurrent modification: durable live order identity or revision moved', {
          details: { intentId: next.intentId, expectedRevision },
        });
      }
      const committed = await readVerifiedOrder(tx as unknown as IntentReadClient, next.intentId);
      if (committed === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Live order vanished after state commit', { details: { intentId: next.intentId } });
      }
      return committed.order;
    });
  }

  public async applyObservationAtomically(intentId: string, observation: LiveOrderObservation, reconciliationAuthorization?: unknown): Promise<LiveOrderStateRecord> {
    return this.#prisma.$transaction(async (tx) => {
      const fence = await assertReconciliationFence(tx as unknown as ReconciliationFenceClient, reconciliationAuthorization, null);
      await tx.$executeRaw`SELECT intent_id FROM live_order WHERE intent_id = ${intentId} FOR UPDATE`;
      // [F17-R03] Folding a provider observation writes money-bearing state, so
      // the local truth it is validated against must itself be proven first.
      const verified = await readVerifiedOrder(tx as unknown as IntentReadClient, intentId);
      if (verified === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Live order or immutable identity vanished during observation application', {
          details: { intentId },
        });
      }
      const { order: current, verifiedIntent } = verified;
      if (fence !== null && current.accountId !== fence.accountId) {
        throw new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'Reconciliation authorization belongs to a different account');
      }
      if (observation.side !== verifiedIntent.intent.content.side) {
        throw new LiveExecutionError('LIVE_ORDER_IDENTITY_MISMATCH', 'Observation side does not belong to this live order', {
          details: { intentId },
        });
      }

      // Complete hostile-data validation and next-state calculation happen
      // before an event row can be inserted.
      const application = applyLiveOrderObservation(current, observation);
      const digest = observationSha256(observation);
      const existing = await tx.liveOrderEvent.findUnique({
        where: { intentId_observationSha256: { intentId, observationSha256: digest } },
      });
      if (existing !== null) return current;

      await tx.liveOrderEvent.create({ data: {
        intentId,
        observationSha256: digest,
        kind: observation.kind,
        exchangeOrderId: observation.exchangeOrderId,
        exchangeStatus: observation.exchangeStatus,
        cumulativeFilledQuantity: observation.cumulativeFilledQuantity,
        averageFillPrice: observation.averageFillPrice,
        providerEventTimeMs: BigInt(observation.providerEventTimeMs),
      } });

      if (application.kind !== 'APPLIED') return current;
      const next = application.order;
      await tx.liveOrder.update({
        where: { intentId },
        data: {
          state: next.state,
          exchangeOrderId: next.exchangeOrderId,
          cumulativeFilledQuantity: next.cumulativeFilledQuantity,
          remainingQuantity: next.remainingQuantity,
          averageFillPrice: next.averageFillPrice,
          lastExchangeStatus: next.lastExchangeStatus,
          lastProviderEventTimeMs: next.lastProviderEventTimeMs === null ? null : BigInt(next.lastProviderEventTimeMs),
          faultCode: next.faultCode,
          // [F18-18] `applyLiveOrderObservation` already resets this to false
          // whenever the fold leaves DISPATCH_RESERVED (always, here); persist
          // it so the column agrees with what `toStateRecord`'s integrity
          // check requires on every subsequent read.
          dispatchWireArmed: next.dispatchWireArmed,
          revision: next.revision,
        },
      });
      return next;
    });
  }

  public async claimCancel(intentId: string, trustedAccountId: string, reconciliationAuthorization?: unknown): Promise<ClaimCancelOutcome> {
    return this.#prisma.$transaction(async (tx) => {
      await assertReconciliationFence(tx as unknown as ReconciliationFenceClient, reconciliationAuthorization, trustedAccountId, 'HEALTHY');
      await tx.$executeRaw`SELECT intent_id FROM live_order WHERE intent_id = ${intentId} FOR UPDATE`;
      // [F17-R03] A cancellation claim is a wire mutation authorization whose
      // only ownership proof is `accountId`, an immutable mirror column — so it
      // is verified against the sealed intent before it is compared.
      const verified = await readVerifiedOrder(tx as unknown as IntentReadClient, intentId);
      if (verified === null) {
        throw new LiveExecutionError('LIVE_INTENT_INVALID', 'Cannot cancel an intent that was never durably recorded', { details: { intentId } });
      }
      const current = verified.order;
      if (current.accountId !== trustedAccountId) {
        throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Configured credential account does not own this durable live order', {
          details: { intentId, accountId: current.accountId },
        });
      }
      if (['CREATED', 'DISPATCH_RESERVED', 'SUBMISSION_AMBIGUOUS', 'FILLED', 'CANCELLED', 'REJECTED', 'RECONCILIATION_REQUIRED'].includes(current.state)) {
        return { kind: 'NOT_CANCELLABLE' as const, order: current, generation: current.cancelGeneration };
      }
      if (current.exchangeOrderId === null) {
        throw new LiveExecutionError('LIVE_ORDER_IDENTITY_MISMATCH', 'Cannot cancel without an authoritative exchange order id', { details: { intentId } });
      }
      if (current.cancelState !== 'NONE') {
        return { kind: 'ALREADY_CLAIMED' as const, order: current, generation: current.cancelGeneration };
      }
      const generation = current.cancelGeneration + 1;
      const updated = await tx.liveOrder.update({ where: { intentId }, data: {
        state: 'CANCEL_REQUESTED',
        cancelState: 'CANCEL_RESERVED',
        cancelGeneration: generation,
        cancelExchangeOrderId: current.exchangeOrderId,
        cancelFaultCode: null,
        cancelClaimedAt: new Date(),
        cancelWireArmed: false,
        revision: { increment: 1 },
      } });
      const claimedOrder = toStateRecord(updated as unknown as LiveOrderRow);
      assertOrderProjectionMatchesIntent(claimedOrder, verified.verifiedIntent);
      return { kind: 'CLAIMED' as const, order: claimedOrder, generation };
    });
  }

  public async completeCancelAttempt(
    intentId: string,
    generation: number,
    outcome: CompleteCancelAttemptOutcome,
    faultCode: string | null,
    reconciliationAuthorization?: unknown,
  ): Promise<LiveOrderStateRecord> {
    return this.#prisma.$transaction(async (tx) => {
      const fence = await assertReconciliationFence(tx as unknown as ReconciliationFenceClient, reconciliationAuthorization, null, 'HEALTHY');
      await tx.$executeRaw`SELECT intent_id FROM live_order WHERE intent_id = ${intentId} FOR UPDATE`;
      await tx.$executeRaw`SELECT intent_id FROM live_execution_intent WHERE intent_id = ${intentId} FOR UPDATE`;
      const verified = await readVerifiedOrder(tx as unknown as IntentReadClient, intentId);
      if (verified === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Live order vanished while completing cancellation', { details: { intentId } });
      }
      const current = verified.order;
      if (fence !== null && current.accountId !== fence.accountId) throw new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'Reconciliation authorization belongs to a different account');
      const cancelState = outcome === 'ACKNOWLEDGED' ? 'CANCEL_ACKNOWLEDGED'
        : outcome === 'AMBIGUOUS' ? 'CANCEL_AMBIGUOUS' : 'CANCEL_REJECTED';
      if (current.cancelGeneration === generation && current.cancelState === cancelState) return current;
      if (current.cancelGeneration !== generation || current.cancelState !== 'CANCEL_RESERVED') {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Cancellation claim ownership changed before completion', { details: { intentId, generation } });
      }
      const updated = await tx.liveOrder.updateMany({
        where: {
          intentId,
          state: current.state,
          revision: current.revision,
          clientOrderId: current.clientOrderId,
          accountId: current.accountId,
          pair: current.pair,
          orderedQuantity: canonicalLiveDecimalString(current.orderedQuantity, 'orderedQuantity'),
          cancelGeneration: generation,
          cancelState: 'CANCEL_RESERVED',
        },
        data: {
          cancelState,
          cancelFaultCode: faultCode,
          ...(outcome === 'AMBIGUOUS' ? { faultCode: 'LIVE_CANCEL_AMBIGUOUS' } : {}),
          // [F18-18] This transition always leaves CANCEL_RESERVED (the
          // precondition above requires it), so any wire-arm proof is no
          // longer meaningful and must not survive as a contradictory `true`
          // against a non-reserved cancel state.
          cancelWireArmed: false,
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Cancellation claim ownership changed before completion', { details: { intentId, generation } });
      }
      const committed = await readVerifiedOrder(tx as unknown as IntentReadClient, intentId);
      if (committed === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Live order vanished after completing cancellation', { details: { intentId } });
      }
      return committed.order;
    });
  }

  public async markExpiredDispatchUnresolved(intentId: string, trustedAccountId: string, cutoff: Date, reconciliationAuthorization?: unknown): Promise<LiveOrderStateRecord> {
    return this.#prisma.$transaction(async (tx) => {
      await assertReconciliationFence(tx as unknown as ReconciliationFenceClient, reconciliationAuthorization, trustedAccountId, 'HEALTHY');
      await tx.$executeRaw`SELECT intent_id FROM live_order WHERE intent_id = ${intentId} FOR UPDATE`;
      // [F17-R03] Restart recovery is an authoritative durable read: it decides
      // whether an order becomes permanently unresolvable, so it is verified on
      // exactly the same terms as the forward paths.
      const verified = await readVerifiedOrder(tx as unknown as IntentReadClient, intentId);
      if (verified === null) throw new LiveExecutionError('LIVE_INTENT_INVALID', 'No durable live order exists for this intent', { details: { intentId } });
      // Read a second time for `updatedAt` ALONE — local operational time,
      // which is mutable by design and therefore carries no digest and is not
      // part of `LiveOrderStateRecord`. Every value that decides anything below
      // comes from `verified.order`, never from this row.
      const row = await tx.liveOrder.findUnique({ where: { intentId } });
      if (row === null) throw new LiveExecutionError('LIVE_INTENT_INVALID', 'No durable live order exists for this intent', { details: { intentId } });
      if (verified.order.accountId !== trustedAccountId) {
        throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Configured credential account does not own this durable live order', { details: { intentId } });
      }
      if (verified.order.state !== 'DISPATCH_RESERVED' || row.updatedAt > cutoff) return verified.order;
      const updated = await tx.liveOrder.update({ where: { intentId }, data: {
        // [F18-18] Leaving DISPATCH_RESERVED for good, exactly like
        // `markSubmissionAmbiguous`: whether this claim was armed or not, the
        // flag is no longer meaningful once the order stops being reserved,
        // and it must not persist as a contradictory `true`.
        state: 'SUBMISSION_AMBIGUOUS', faultCode: 'LIVE_SUBMISSION_AMBIGUOUS', dispatchWireArmed: false, revision: { increment: 1 },
      } });
      const unresolved = toStateRecord(updated as unknown as LiveOrderRow);
      assertOrderProjectionMatchesIntent(unresolved, verified.verifiedIntent);
      return unresolved;
    });
  }

  /**
   * [F17-R03] Integrity-verified. Every caller of `load` — dispatch replay,
   * cancellation, sync, restart recovery, and the post-write reads in this
   * file — therefore receives state that has been proven against the sealed
   * intent digest, never a raw projection row.
   */
  public async load(intentId: string): Promise<LiveOrderStateRecord | null> {
    const verified = await readVerifiedOrder(this.#prisma as unknown as IntentReadClient, intentId);
    return verified === null ? null : verified.order;
  }

  /**
   * [F17-R03] The observation identity is what every provider response is
   * validated against, so it is rebuilt from the verified canonical intent
   * rather than read field-by-field off an unverified row. A tampered quantity
   * or price can no longer widen what a hostile venue response is allowed to
   * claim.
   */
  public async loadObservationIdentity(intentId: string): Promise<LiveOrderObservationIdentity | null> {
    const row = await this.#prisma.liveExecutionIntent.findUnique({ where: { intentId } });
    if (row === null) return null;
    const { intent } = verifyStoredIntentIntegrity(row);
    return Object.freeze({
      intentId: intent.intentId,
      accountId: intent.content.accountId,
      clientOrderId: intent.clientOrderId,
      pair: intent.content.pair,
      side: intent.content.side,
      wireOrderType: intent.wireOrderType,
      quantity: intent.content.quantity,
      price: intent.content.price,
      settlementRateInrPerQuote: intent.content.settlementRateInrPerQuote,
      marginCurrencyShortName: 'INR' as const,
    });
  }

  /**
   * [F17-R03] `live_position` carries no sealed digest because Phase17 never
   * writes it. It is therefore never authoritative on its own: the value
   * returned here is only ever re-compared, under `FOR UPDATE`, against a
   * digest-verified intent inside `claimDispatch`. See the trust-boundary
   * comment above.
   */
  public async loadPositionOwnership(accountId: string, pair: string): Promise<LivePositionOwnershipRecord | null> {
    const row = await this.#prisma.livePosition.findUnique({ where: { accountId_pair: { accountId, pair } } });
    if (row === null) return null;
    return Object.freeze({
      accountId: row.accountId, pair: row.pair, positionInstanceId: row.positionInstanceId, positionRevision: row.revision,
      // `decimalString`, not a bare `.toFixed()`: an unreadable durable decimal
      // must surface as a Phase17 fault, never as a raw TypeError.
      side: row.side, ownedQuantity: decimalString(row.quantity), instrumentSpecSnapshotId: row.instrumentSpecSnapshotId,
      ownerStrategyInstanceId: row.ownerStrategyInstanceId, ownerStrategyId: row.ownerStrategyId,
      ownerStrategyVersion: row.ownerStrategyVersion, ownerParameterHash: row.ownerParameterHash,
    });
  }

  /**
   * [Phase18 §8] Commits a reconciliation-computed state.
   *
   * Deliberately built from `commitState`'s exact discipline rather than a
   * looser path: lock both halves, re-verify the sealed intent digest,
   * re-prove the immutable order mirrors against it, then conditionally update
   * on the expected revision AND every immutable identity column. The optional
   * observation is inserted into the append-only log inside the SAME
   * transaction, so an event can never outrun the financial effect it proves,
   * and `UNIQUE(intent_id, observation_sha256)` makes a replayed reconciliation
   * a no-op instead of a second fill.
   */
  public async commitReconciledState(
    next: LiveOrderStateRecord,
    expectedRevision: number,
    observation: LiveOrderObservation | null,
    reconciliationAuthorization?: unknown,
  ): Promise<LiveOrderStateRecord> {
    return this.#prisma.$transaction(async (tx) => {
      await assertReconciliationFence(tx as unknown as ReconciliationFenceClient, reconciliationAuthorization, next.accountId, 'RUNNING');
      await tx.$executeRaw`SELECT intent_id FROM live_order WHERE intent_id = ${next.intentId} FOR UPDATE`;
      await tx.$executeRaw`SELECT intent_id FROM live_execution_intent WHERE intent_id = ${next.intentId} FOR UPDATE`;
      const verified = await readVerifiedOrder(tx as unknown as IntentReadClient, next.intentId);
      if (verified === null) {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Concurrent modification: durable live order vanished', {
          details: { intentId: next.intentId, expectedRevision },
        });
      }
      const current = verified.order;
      assertOrderProjectionMatchesIntent(next, verified.verifiedIntent);
      if (current.revision !== expectedRevision) {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Concurrent modification: durable live order revision moved', {
          details: { intentId: next.intentId, expectedRevision },
        });
      }
      if (observation !== null) {
        if (observation.side !== verified.verifiedIntent.intent.content.side) {
          throw new LiveExecutionError('LIVE_ORDER_IDENTITY_MISMATCH', 'Reconciliation observation side does not belong to this live order', {
            details: { intentId: next.intentId },
          });
        }
        const digest = observationSha256(observation);
        const existing = await tx.liveOrderEvent.findUnique({
          where: { intentId_observationSha256: { intentId: next.intentId, observationSha256: digest } },
        });
        // An already-recorded observation means this exact reconciliation
        // effect was applied before. Return current state untouched: no
        // duplicate event, no second projection write, no revision churn.
        if (existing !== null) return current;
        await tx.liveOrderEvent.create({ data: {
          intentId: next.intentId,
          observationSha256: digest,
          kind: observation.kind,
          exchangeOrderId: observation.exchangeOrderId,
          exchangeStatus: observation.exchangeStatus,
          cumulativeFilledQuantity: observation.cumulativeFilledQuantity,
          averageFillPrice: observation.averageFillPrice,
          providerEventTimeMs: BigInt(observation.providerEventTimeMs),
        } });
      }
      const updated = await tx.liveOrder.updateMany({
        where: {
          intentId: current.intentId,
          state: current.state,
          revision: expectedRevision,
          clientOrderId: current.clientOrderId,
          accountId: current.accountId,
          pair: current.pair,
          orderedQuantity: canonicalLiveDecimalString(current.orderedQuantity, 'orderedQuantity'),
        },
        data: {
          state: next.state,
          exchangeOrderId: next.exchangeOrderId,
          cumulativeFilledQuantity: next.cumulativeFilledQuantity,
          remainingQuantity: next.remainingQuantity,
          averageFillPrice: next.averageFillPrice,
          lastExchangeStatus: next.lastExchangeStatus,
          lastProviderEventTimeMs: next.lastProviderEventTimeMs === null ? null : BigInt(next.lastProviderEventTimeMs),
          faultCode: next.faultCode,
          cancelState: next.cancelState,
          cancelGeneration: next.cancelGeneration,
          cancelExchangeOrderId: next.cancelExchangeOrderId,
          cancelFaultCode: next.cancelFaultCode,
          dispatchWireArmed: next.dispatchWireArmed,
          cancelWireArmed: next.cancelWireArmed,
          revision: next.revision,
        },
      });
      if (updated.count !== 1) {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Concurrent modification: durable live order identity or revision moved', {
          details: { intentId: next.intentId, expectedRevision },
        });
      }
      const committed = await readVerifiedOrder(tx as unknown as IntentReadClient, next.intentId);
      if (committed === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Live order vanished after reconciliation commit', { details: { intentId: next.intentId } });
      }
      return committed.order;
    });
  }

  /**
   * [Phase18 §8] Every durable order for one account, each proven against its
   * own sealed intent digest before it is returned. Reconciliation therefore
   * never sees a raw projection row, exactly like every Phase17 path.
   */
  public async listAccountOrderViews(accountId: string): Promise<readonly LiveDurableOrderRow[]> {
    const rows = await this.#prisma.liveOrder.findMany({
      where: { accountId },
      include: { intent: true },
      orderBy: { intentId: 'asc' },
    }) as readonly (LiveOrderRow & { intent: unknown; createdAt: Date; updatedAt: Date })[];

    const views: LiveDurableOrderRow[] = [];
    for (const row of rows) {
      if (row.intent === null || row.intent === undefined) {
        throw new LiveExecutionError('LIVE_DURABLE_INTEGRITY_VIOLATION', 'Durable live order exists without the immutable intent that authorizes it', {
          details: { intentId: row.intentId },
        });
      }
      const verifiedIntent = verifyStoredIntentIntegrity(row.intent);
      const order = toStateRecord(row);
      assertOrderProjectionMatchesIntent(order, verifiedIntent);
      const { content } = verifiedIntent.intent;
      views.push(Object.freeze({
        intentId: order.intentId,
        clientOrderId: order.clientOrderId,
        accountId: order.accountId,
        pair: order.pair,
        state: order.state,
        exchangeOrderId: order.exchangeOrderId,
        side: content.side,
        action: content.action,
        wireOrderType: verifiedIntent.intent.wireOrderType,
        orderedQuantity: order.orderedQuantity,
        cumulativeFilledQuantity: order.cumulativeFilledQuantity,
        averageFillPrice: order.averageFillPrice,
        price: content.price,
        leverage: content.leverage,
        timeInForce: content.timeInForce,
        cancelState: order.cancelState,
        strategyInstanceId: content.strategyInstanceId,
        strategyId: content.strategyId,
        strategyVersion: content.strategyVersion,
        parameterHash: content.parameterHash,
        instrumentSpecSnapshotId: content.instrumentSpecSnapshotId,
        positionInstanceId: content.positionInstanceId,
        reduceOnlyQuantity: content.reduceOnlyQuantity,
        createdAtMs: row.createdAt.getTime(),
        updatedAtMs: row.updatedAt.getTime(),
        dispatchWireArmed: order.dispatchWireArmed,
        cancelWireArmed: order.cancelWireArmed,
        revision: order.revision,
      }));
    }
    return Object.freeze(views);
  }

  #intentCreateData(intent: LiveExecutionIntentRecord) {
    const { content, lineage } = intent;
    return {
      intentId: intent.intentId,
      clientOrderId: intent.clientOrderId,
      contentSha256: liveExecutionIntentContentSha256(intent),
      accountId: content.accountId,
      pair: content.pair,
      side: content.side,
      action: content.action,
      quantity: content.quantity,
      orderType: content.orderType,
      price: content.price,
      timeInForce: content.timeInForce,
      leverage: content.leverage,
      riskDecisionId: content.riskDecisionId,
      admissionId: content.admissionId,
      strategyInstanceId: content.strategyInstanceId,
      strategyId: content.strategyId,
      strategyVersion: content.strategyVersion,
      parameterHash: content.parameterHash,
      liveExecutionPolicyId: content.liveExecutionPolicyId,
      instrumentSpecSnapshotId: content.instrumentSpecSnapshotId,
      authorizedNotionalInr: content.authorizedNotionalInr,
      settlementRateInrPerQuote: content.settlementRateInrPerQuote,
      positionInstanceId: content.positionInstanceId,
      positionRevision: content.positionRevision,
      reduceOnlyQuantity: content.reduceOnlyQuantity,
      wireOrderType: intent.wireOrderType,
      sourceStrategyDecisionId: lineage.sourceStrategyDecisionId,
      validationSubjectId: lineage.researchApproval?.validationSubjectId ?? null,
      validationPlanId: lineage.researchApproval?.validationPlanId ?? null,
      validationSubjectResultSha256: lineage.researchApproval?.validationSubjectResultSha256 ?? null,
    };
  }

  /**
   * A stored intent is immutable. If the same identity is presented with
   * different economics, that is a hash collision or a tampered replay — never
   * an update — and it fails closed before anything can be dispatched.
   */
  #assertStoredIntentMatches(storedRow: unknown, intent: LiveExecutionIntentRecord): void {
    // [F17-R03] Two distinct failures, deliberately not conflated:
    //   - the stored row disagreeing with its own digest is corruption or
    //     tampering (`LIVE_DURABLE_INTEGRITY_VIOLATION`, raised inside);
    //   - a self-consistent stored row disagreeing with a freshly minted intent
    //     is an identity collision or an economics change (`LIVE_INTENT_CONFLICT`).
    // This path is also the only one that can detect a writer who rewrote
    // content AND digest together, because it alone holds an independently
    // minted intent to compare against.
    const { digest } = verifyStoredIntentIntegrity(storedRow);
    if (digest !== liveExecutionIntentContentSha256(intent)) {
      throw new LiveExecutionError('LIVE_INTENT_CONFLICT', 'Stored live execution intent binds different economic content to this identity', {
        details: { intentId: intent.intentId },
      });
    }
  }
}
