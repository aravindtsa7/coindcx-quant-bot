/**
 * Durable Phase18 reconciliation persistence (§4, §16, §23).
 *
 * Every guarantee below is enforced by MySQL, not by an in-memory lock:
 *
 * | Mechanism                        | Enforcement                                   |
 * | :------------------------------- | :-------------------------------------------- |
 * | One owner per generation         | `UNIQUE(account_id, generation)` on the run    |
 * | No stale commit                  | every write re-reads the state row `FOR UPDATE` and compares the lease generation before mutating |
 * | No duplicate fault               | `UNIQUE(account_id, finding_sha256)` upserts   |
 * | One orphan cancel attempt        | `PRIMARY KEY(account_id, exchange_order_id)` plus a `NONE -> CANCEL_CLAIMED` conditional update |
 * | No ownership double-creation     | `PRIMARY KEY(account_id, pair, owner_strategy_instance_id)` |
 * | No revision churn on a rerun     | an unchanged proof digest short-circuits the write entirely |
 *
 * THE FENCING RULE, stated once and applied everywhere: a durable change is
 * permitted only while `live_reconciliation_state.current_generation` still
 * equals the lease's generation AND `current_runtime_epoch` still equals the
 * lease's epoch. Both are re-read under `FOR UPDATE` inside the same
 * transaction as the write. A worker whose generation has been superseded
 * therefore cannot commit anything, on any path, however long it was asleep.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { canonicalLiveDecimalString, canonicalNonNegativeLiveDecimal, liveDecimal } from '../decimal';
import { LiveExecutionError } from '../errors';
import type { LivePositionOwnershipRecord } from '../repository';
import { evaluateReconciliationBarrier, initialReconciliationState, readLiveRuntimeEpoch } from './barrier';
import { findingSha256, isFindingBlocking } from './findings';
import { readOrphanAmbiguityResolutionRequest, type OrphanAmbiguityResolutionRequest } from './orphan-resolution';
import { LiveReconciliationCompletionProof } from './service';
import { createChildLogger } from '../../../monitoring/logger';

const logger = createChildLogger('execution:live:reconciliation:repository');
import type {
  LiveOrphanCancelClaimOutcome,
  LiveOrphanCancelResolutionRecord,
  LiveOrphanVenueOrderRecord,
  LivePositionOwnershipShareInput,
  LivePositionOwnershipShareRecord,
  LiveReconciliationClaimOutcome,
  LiveReconciliationFindingRecord,
  LiveReconciliationLease,
  LiveReconciliationRepository,
  LiveReconciliationStateRecord,
} from './ports';
import type {
  LiveOrphanCancelResolutionOutcomeName,
  LiveOrphanCancelStateName,
  LiveReconciliationFinding,
  LiveReconciliationFindingCategoryName,
  LiveReconciliationStatusName,
  LiveVenueOrderEvidence,
} from './types';

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

function isUniqueConstraintViolation(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002';
}

/**
 * [Wave C3.1 / F18-44] Attempts one generation claim may make: the first plus
 * at most two retries. Small on purpose: a deadlock victim's retry normally
 * just waits for the winner to commit, so one retry is usually enough, and a
 * conflict that survives three fresh attempts is persistent contention that
 * must surface rather than be absorbed.
 */
export const CLAIM_GENERATION_MAX_ATTEMPTS = 3;

/**
 * [Wave C3.1 / F18-44] The only error a claim is retried on: Prisma's stable
 * `P2034` ("Transaction failed due to a write conflict or a deadlock"), which
 * is what MySQL's deadlock victim surfaces as (verified against real MySQL).
 * Everything else, including `P2002` (another worker won this generation,
 * handled as LOST), every `LiveExecutionError`, and every other Prisma or
 * unknown error, is never retried.
 */
export function isRetryableTransactionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

/**
 * [Wave C3.1 / F18-44] Runs `transaction` (which must open a FRESH
 * interactive transaction on every call) until it succeeds, throws a
 * non-retryable error, or exhausts the attempt budget. There is no sleep: the
 * losing transaction has already been rolled back, and its retry simply waits
 * on the winner's locks. On exhaustion it fails closed with
 * `LIVE_PERSISTENCE_FAULT`, keeping the final Prisma error as its cause.
 */
async function withTransactionConflictRetry<T>(accountId: string, transaction: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await transaction();
    } catch (error) {
      if (!isRetryableTransactionConflict(error)) throw error;
      if (attempt >= CLAIM_GENERATION_MAX_ATTEMPTS) {
        throw new LiveExecutionError(
          'LIVE_PERSISTENCE_FAULT',
          'The reconciliation generation claim kept failing on a database transaction conflict; the account stays blocked',
          { details: { accountId, attempts: attempt, prismaCode: 'P2034' }, cause: error },
        );
      }
      logger.warn({ accountId, attempt, maxAttempts: CLAIM_GENERATION_MAX_ATTEMPTS }, 'Reconciliation generation claim hit a database transaction conflict; retrying in a fresh transaction');
    }
  }
}

interface StateRow {
  readonly accountId: string;
  readonly status: string;
  readonly currentGeneration: number;
  readonly currentRunId: string | null;
  readonly currentRuntimeEpoch: string | null;
  readonly healthyGeneration: number | null;
  readonly lastEvaluatedAtMs: unknown;
  readonly blockingFindingCount: number;
  readonly revision: number;
}

export interface LiveReconciliationAuthorizationRecord {
  readonly accountId: string;
  readonly runId: string;
  readonly generation: number;
  readonly runtimeEpoch: string;
  readonly stateRevision: number;
  readonly mode: 'HEALTHY' | 'RUNNING';
}

const RECONCILIATION_AUTHORIZATION_ISSUER = Object.freeze({ purpose: 'live-reconciliation-authorization' });

/**
 * Opaque, unforgeable proof naming one exact durable reconciliation owner.
 * Possessing it is not sufficient: every economic transaction re-locks and
 * revalidates the named state row before it writes.
 */
export class LiveReconciliationAuthorization {
  readonly #record: LiveReconciliationAuthorizationRecord;

  public constructor(issuer: unknown, record: LiveReconciliationAuthorizationRecord) {
    if (issuer !== RECONCILIATION_AUTHORIZATION_ISSUER) {
      throw new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'Reconciliation authorization is repository-issued only');
    }
    this.#record = Object.freeze({ ...record });
    Object.freeze(this);
  }

  public static read(value: unknown): LiveReconciliationAuthorizationRecord | null {
    if (!(value instanceof LiveReconciliationAuthorization)) return null;
    try {
      return value.#record;
    } catch {
      return null;
    }
  }
}

function issueAuthorization(row: StateRow, mode: 'HEALTHY' | 'RUNNING'): LiveReconciliationAuthorization {
  if (row.currentRunId === null || row.currentRuntimeEpoch === null) {
    throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Reconciliation state lacks its durable owner identity');
  }
  return new LiveReconciliationAuthorization(RECONCILIATION_AUTHORIZATION_ISSUER, {
    accountId: row.accountId,
    runId: row.currentRunId,
    generation: row.currentGeneration,
    runtimeEpoch: row.currentRuntimeEpoch,
    stateRevision: row.revision,
    mode,
  });
}

function toStateRecord(row: StateRow): LiveReconciliationStateRecord {
  return Object.freeze({
    accountId: row.accountId,
    status: row.status as LiveReconciliationStatusName,
    currentGeneration: row.currentGeneration,
    currentRunId: row.currentRunId,
    currentRuntimeEpoch: row.currentRuntimeEpoch,
    healthyGeneration: row.healthyGeneration,
    lastEvaluatedAtMs: bigIntToNumber(row.lastEvaluatedAtMs),
    blockingFindingCount: row.blockingFindingCount,
    revision: row.revision,
  });
}

interface OrphanRow {
  readonly accountId: string;
  readonly exchangeOrderId: string;
  readonly pair: string;
  readonly side: string;
  readonly venueStatus: string;
  readonly orderedQuantity: unknown;
  readonly filledQuantity: unknown;
  readonly price: unknown;
  readonly firstSeenGeneration: number;
  readonly lastSeenGeneration: number;
  readonly cancelState: string;
  readonly cancelGeneration: number;
  readonly cancelFaultCode: string | null;
  readonly cancelWireArmed: boolean;
  readonly revision: number;
}

/**
 * [F18-18] The orphan-cancel equivalent of `assertWireArmedConsistency` in
 * `../repository.ts`: `cancelWireArmed` may be `true` ONLY while
 * `cancelState === 'CANCEL_CLAIMED'`. Every legitimate write path here
 * (`claimOrphanCancellation`, `armOrphanCancelWire`,
 * `reclaimUnarmedOrphanCancelClaim`, `completeOrphanCancellation`) keeps this
 * invariant, so a row that violates it is corruption or tampering and fails
 * closed rather than being silently ignored or coerced.
 */
function assertOrphanWireArmedConsistency(record: LiveOrphanVenueOrderRecord): void {
  if (record.cancelWireArmed && record.cancelState !== 'CANCEL_CLAIMED') {
    throw new LiveExecutionError('LIVE_DURABLE_INTEGRITY_VIOLATION', 'Durable orphan venue order is wire-armed for cancel outside an active CANCEL_CLAIMED claim', {
      details: { accountId: record.accountId, exchangeOrderId: record.exchangeOrderId, cancelState: record.cancelState },
    });
  }
}

interface ResolutionRow {
  readonly resolutionId: string;
  readonly accountId: string;
  readonly exchangeOrderId: string;
  readonly resolvedOrphanRevision: number;
  readonly resolvedCancelGeneration: number;
  readonly outcome: string;
  readonly resolvedBy: string;
  readonly note: string | null;
  readonly resolvedAtMs: bigint;
}

function toResolutionRecord(row: ResolutionRow): LiveOrphanCancelResolutionRecord {
  const resolvedAtMs = bigIntToNumber(row.resolvedAtMs);
  if (resolvedAtMs === null) {
    throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Durable orphan resolution timestamp was unreadable');
  }
  return Object.freeze({
    resolutionId: row.resolutionId,
    accountId: row.accountId,
    exchangeOrderId: row.exchangeOrderId,
    resolvedOrphanRevision: row.resolvedOrphanRevision,
    resolvedCancelGeneration: row.resolvedCancelGeneration,
    outcome: row.outcome as LiveOrphanCancelResolutionOutcomeName,
    resolvedBy: row.resolvedBy,
    note: row.note,
    resolvedAtMs,
  });
}

function toOrphanRecord(row: OrphanRow): LiveOrphanVenueOrderRecord {
  const record = Object.freeze({
    accountId: row.accountId,
    exchangeOrderId: row.exchangeOrderId,
    pair: row.pair,
    side: row.side as 'BUY' | 'SELL',
    venueStatus: row.venueStatus,
    orderedQuantity: decimalString(row.orderedQuantity),
    filledQuantity: decimalString(row.filledQuantity),
    price: optionalDecimalString(row.price),
    firstSeenGeneration: row.firstSeenGeneration,
    lastSeenGeneration: row.lastSeenGeneration,
    cancelState: row.cancelState as LiveOrphanCancelStateName,
    cancelGeneration: row.cancelGeneration,
    cancelFaultCode: row.cancelFaultCode,
    cancelWireArmed: row.cancelWireArmed === true,
    revision: row.revision,
  });
  assertOrphanWireArmedConsistency(record);
  return record;
}

interface ShareRow {
  readonly accountId: string;
  readonly pair: string;
  readonly ownerStrategyInstanceId: string;
  readonly side: string;
  readonly quantity: unknown;
  readonly ownerStrategyId: string;
  readonly ownerStrategyVersion: string;
  readonly ownerParameterHash: string;
  readonly venuePositionId: string | null;
  readonly lineageSha256: string;
  readonly lineageJson: string;
  readonly establishedGeneration: number;
  readonly lastProvenGeneration: number;
  readonly materialized: boolean;
  readonly revision: number;
}

function toShareRecord(row: ShareRow): LivePositionOwnershipShareRecord {
  let lineageIntentIds: readonly string[] = Object.freeze([]);
  try {
    const parsed: unknown = JSON.parse(row.lineageJson);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) {
      lineageIntentIds = Object.freeze([...parsed as string[]]);
    } else {
      throw new Error('lineage is not a string array');
    }
  } catch (cause) {
    throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Durable ownership lineage could not be read back as an intent id list', {
      details: { accountId: row.accountId, pair: row.pair },
      cause,
    });
  }
  return Object.freeze({
    accountId: row.accountId,
    pair: row.pair,
    ownerStrategyInstanceId: row.ownerStrategyInstanceId,
    side: row.side as 'LONG' | 'SHORT',
    quantity: decimalString(row.quantity),
    ownerStrategyId: row.ownerStrategyId,
    ownerStrategyVersion: row.ownerStrategyVersion,
    ownerParameterHash: row.ownerParameterHash,
    venuePositionId: row.venuePositionId,
    lineageSha256: row.lineageSha256,
    lineageIntentIds,
    establishedGeneration: row.establishedGeneration,
    lastProvenGeneration: row.lastProvenGeneration,
    materialized: row.materialized,
    revision: row.revision,
  });
}

/** The exact fencing check every durable Phase18 write performs. */
function assertLeaseStillOwns(row: StateRow | null, lease: LiveReconciliationLease): void {
  if (row === null) {
    throw new LiveExecutionError('LIVE_RECONCILIATION_STALE_GENERATION', 'The reconciliation state row vanished while this lease was held', {
      details: { accountId: lease.accountId, generation: lease.generation },
    });
  }
  if (row.status !== 'RUNNING' || row.currentRunId !== lease.runId
      || row.currentGeneration !== lease.generation || row.currentRuntimeEpoch !== lease.runtimeEpoch) {
    throw new LiveExecutionError('LIVE_RECONCILIATION_STALE_GENERATION', 'A newer reconciliation generation has taken ownership of this account', {
      details: {
        accountId: lease.accountId,
        leaseGeneration: lease.generation,
        currentGeneration: row.currentGeneration,
      },
    });
  }
}

function assertRunningAuthorization(row: StateRow, lease: LiveReconciliationLease, authorization: unknown): void {
  const authority = LiveReconciliationAuthorization.read(authorization);
  if (authority === null || authority.mode !== 'RUNNING'
      || authority.accountId !== lease.accountId || authority.runId !== lease.runId
      || authority.generation !== lease.generation || authority.runtimeEpoch !== lease.runtimeEpoch
      || authority.stateRevision !== row.revision) {
    throw new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'A genuine current reconciliation-owner authorization is required');
  }
}

export class PrismaLiveReconciliationRepository implements LiveReconciliationRepository {
  readonly #prisma: PrismaClient;

  public constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  /** An absent account reads as RECONCILIATION_REQUIRED — fail closed, never open. */
  public async loadState(accountId: string): Promise<LiveReconciliationStateRecord> {
    const row = await this.#prisma.liveReconciliationState.findUnique({ where: { accountId } });
    return row === null ? initialReconciliationState(accountId) : toStateRecord(row as unknown as StateRow);
  }

  public async authorizeCurrentHealthy(accountId: string, runtimeIdentity: unknown): Promise<{
    readonly state: LiveReconciliationStateRecord;
    readonly authorization: LiveReconciliationAuthorization | null;
  }> {
    const runtimeEpoch = readLiveRuntimeEpoch(runtimeIdentity);
    const row = await this.#prisma.liveReconciliationState.findUnique({ where: { accountId } });
    const state = row === null ? initialReconciliationState(accountId) : toStateRecord(row as unknown as StateRow);
    if (runtimeEpoch === null || row === null || evaluateReconciliationBarrier(state, runtimeEpoch).kind !== 'PERMITTED') {
      return Object.freeze({ state, authorization: null });
    }
    return Object.freeze({ state, authorization: issueAuthorization(row as unknown as StateRow, 'HEALTHY') });
  }

  /**
   * Claims the next generation.
   *
   * The state row is created on demand, then locked; the new generation is
   * `current_generation + 1` and the run insert carries
   * `UNIQUE(account_id, generation)`. Two racing workers that read the same
   * current generation therefore both attempt the same next one, and exactly
   * one insert survives — the database picks the winner.
   *
   * Claiming also marks the account RUNNING, which the barrier treats as
   * blocked. That is deliberate: while a repair is in flight, no mutation may
   * proceed, and if this process dies now the account STAYS blocked.
   */
  public async claimGeneration(accountId: string, runtimeIdentity: unknown, nowMs: number): Promise<LiveReconciliationClaimOutcome> {
    const runtimeEpoch = readLiveRuntimeEpoch(runtimeIdentity);
    if (runtimeEpoch === null) {
      throw new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'A genuine runtime identity is required to claim reconciliation');
    }
    try {
      await this.#prisma.liveReconciliationState.upsert({
        where: { accountId },
        create: { accountId },
        update: {},
      });
    } catch (error) {
      // Lost the create race with another worker; the row now exists either way.
      if (!isUniqueConstraintViolation(error)) throw error;
    }

    try {
      // [Wave C3.1 / F18-44] Two DIFFERENT accounts' first claims can deadlock
      // under REPEATABLE READ: each `updateMany` below finds no RUNNING row and
      // takes a next-key lock on the end of
      // `live_reconciliation_run_account_generation_unique`, then each run
      // INSERT waits on the other's lock. The whole transaction, and only it,
      // is retried: every attempt re-locks and re-reads the state row, and
      // recomputes the generation and run id, so nothing from a rolled-back
      // attempt is reused. No wire authority exists yet at this point.
      return await withTransactionConflictRetry(accountId, () => this.#prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT account_id FROM live_reconciliation_state WHERE account_id = ${accountId} FOR UPDATE`;
        const current = await tx.liveReconciliationState.findUnique({ where: { accountId } });
        if (current === null) {
          throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Reconciliation state vanished during generation claim', { details: { accountId } });
        }

        // [F18-14] Deliberately NO outstanding-mutation-claim check here.
        //
        // The original Wave A design refused to supersede a generation while
        // ANY `DISPATCH_RESERVED` / `CANCEL_RESERVED` / orphan `CANCEL_CLAIMED`
        // claim existed, on the theory that reconciliation should never step on
        // a live mutation in flight. In practice that made a crash between
        // "local reservation taken" and "reconciliation completes" permanent:
        // nothing but a completed reconciliation can ever clear such a claim,
        // and nothing but a NEW generation can run reconciliation — so a dead
        // worker's leftover claim permanently bricked the account.
        //
        // Superseding is safe WITHOUT that check because generation takeover is
        // already the sole safety mechanism everywhere else in this file: the
        // account's fenced write path (`assertLeaseStillOwns` /
        // `assertReconciliationFence` in `../repository.ts`) refuses every
        // durable mutation whose authorization names a generation that is no
        // longer current, and the durable pre-wire "arm" checkpoint
        // (`armDispatchWire` / `armCancelWire` / `armOrphanCancelWire`) is the
        // LAST such fenced write before any HTTP call — so a worker whose
        // generation is superseded before it arms sends zero wire requests
        // (Case A), and one superseded after it arms has already left durable
        // proof of that fact for the new generation to treat as unresolved
        // rather than infer as safe (Case B). The new generation itself then
        // classifies every outstanding claim it inherits (see
        // `planClaimRecovery` in `./order-reconciliation.ts` and the orphan
        // recovery step in `./service.ts`): unarmed claims are reclaimed with
        // zero exchange mutation, and armed ones are left durably blocking
        // (never resent) until authoritative venue evidence — or a human —
        // resolves them. No process liveness, heartbeat, or timeout is
        // consulted anywhere in that decision.
        const generation = current.currentGeneration + 1;
        const runId = randomUUID();

        // Any run still marked RUNNING from an earlier generation is fenced out
        // explicitly rather than left indefinitely pending. This is what turns
        // "a process crashed mid-reconciliation" into a recoverable state
        // instead of a stuck one.
        await tx.liveReconciliationRun.updateMany({
          where: { accountId, status: 'RUNNING' },
          data: { status: 'ABANDONED', completedAt: new Date(nowMs) },
        });

        await tx.liveReconciliationRun.create({ data: {
          runId,
          accountId,
          generation,
          status: 'RUNNING',
          runtimeEpoch,
          snapshotStartedAtMs: BigInt(nowMs),
        } });

        const owned = await tx.liveReconciliationState.update({ where: { accountId }, data: {
          status: 'RUNNING',
          currentGeneration: generation,
          currentRunId: runId,
          currentRuntimeEpoch: runtimeEpoch,
          // The previous healthy verdict is explicitly withdrawn the instant a
          // new generation is claimed, so a crash mid-run can never leave a
          // stale HEALTHY readable by the barrier.
          healthyGeneration: null,
          revision: { increment: 1 },
        } });

        return Object.freeze({
          kind: 'CLAIMED' as const,
          lease: Object.freeze({ accountId, runId, generation, runtimeEpoch, startedAtMs: nowMs }),
          authorization: issueAuthorization(owned as unknown as StateRow, 'RUNNING'),
        });
      }));
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      // Another worker committed this exact generation first.
      const state = await this.loadState(accountId);
      return Object.freeze({ kind: 'LOST' as const, state });
    }
  }

  public async recordSnapshot(lease: LiveReconciliationLease, snapshotSha256: string, endedAtMs: number, completeness: {
    readonly validated: boolean;
    readonly ordersComplete: boolean;
    readonly positionsComplete: boolean;
  }): Promise<void> {
    await this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT account_id FROM live_reconciliation_state WHERE account_id = ${lease.accountId} FOR UPDATE`;
      const state = await tx.liveReconciliationState.findUnique({ where: { accountId: lease.accountId } });
      assertLeaseStillOwns(state as unknown as StateRow | null, lease);
      await tx.liveReconciliationRun.update({ where: { runId: lease.runId }, data: {
        snapshotSha256,
        snapshotEndedAtMs: BigInt(endedAtMs),
        snapshotValidated: completeness.validated,
        ordersComplete: completeness.ordersComplete,
        positionsComplete: completeness.positionsComplete,
      } });
    });
  }

  /**
   * Upserts findings by content identity (§16).
   *
   * A finding already recorded for this account has its `last_seen_generation`
   * advanced; a new one is inserted. Neither path ever produces a second row
   * for the same immutable fact, which is what makes a rerun against unchanged
   * evidence produce no new fault.
   */
  public async persistFindings(
    lease: LiveReconciliationLease,
    findings: readonly LiveReconciliationFinding[],
    nowMs: number,
  ): Promise<readonly LiveReconciliationFindingRecord[]> {
    return this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT account_id FROM live_reconciliation_state WHERE account_id = ${lease.accountId} FOR UPDATE`;
      const state = await tx.liveReconciliationState.findUnique({ where: { accountId: lease.accountId } });
      assertLeaseStillOwns(state as unknown as StateRow | null, lease);

      const records: LiveReconciliationFindingRecord[] = [];
      for (const finding of findings) {
        const digest = findingSha256(lease.accountId, finding);
        const blocking = isFindingBlocking(finding);
        const row = await tx.liveReconciliationFinding.upsert({
          where: { accountId_findingSha256: { accountId: lease.accountId, findingSha256: digest } },
          create: {
            accountId: lease.accountId,
            findingSha256: digest,
            category: finding.category as LiveReconciliationFindingCategoryName,
            code: finding.code,
            blocking,
            pair: finding.subject.pair,
            intentId: finding.subject.intentId,
            exchangeOrderId: finding.subject.exchangeOrderId,
            venuePositionId: finding.subject.venuePositionId,
            strategyInstanceId: finding.subject.strategyInstanceId,
            evidenceJson: JSON.stringify(finding.evidence),
            firstSeenRunId: lease.runId,
            firstSeenGeneration: lease.generation,
            lastSeenGeneration: lease.generation,
            firstSeenAtMs: BigInt(nowMs),
            lastSeenAtMs: BigInt(nowMs),
          },
          // Only the generation window moves. The immutable content of a
          // finding is never rewritten — a different content is a different
          // digest and therefore a different row.
          update: { lastSeenGeneration: lease.generation, lastSeenAtMs: BigInt(nowMs) },
        });
        records.push(Object.freeze({
          findingId: row.findingId,
          accountId: row.accountId,
          findingSha256: row.findingSha256,
          category: row.category as LiveReconciliationFindingCategoryName,
          code: row.code,
          blocking: row.blocking,
          pair: row.pair,
          intentId: row.intentId,
          exchangeOrderId: row.exchangeOrderId,
          venuePositionId: row.venuePositionId,
          strategyInstanceId: row.strategyInstanceId,
          firstSeenGeneration: row.firstSeenGeneration,
          lastSeenGeneration: row.lastSeenGeneration,
        }));
      }
      return Object.freeze(records);
    });
  }

  /**
   * Publishes the run's verdict.
   *
   * This is the ONLY write in the entire phase that can unblock an account, and
   * it is fenced like everything else: a stale generation throws rather than
   * overwriting the newer owner's result.
   */
  public async completeRun(
    lease: LiveReconciliationLease,
    completionProof: unknown,
    nowMs: number,
  ): Promise<LiveReconciliationStateRecord> {
    return this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT account_id FROM live_reconciliation_state WHERE account_id = ${lease.accountId} FOR UPDATE`;
      const state = await tx.liveReconciliationState.findUnique({ where: { accountId: lease.accountId } });
      assertLeaseStillOwns(state as unknown as StateRow | null, lease);

      const proof = LiveReconciliationCompletionProof.read(completionProof);
      if (proof === null || proof.accountId !== lease.accountId || proof.runId !== lease.runId
          || proof.generation !== lease.generation) {
        throw new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'A genuine completion proof for this run is required');
      }
      const run = await tx.liveReconciliationRun.findUnique({ where: { runId: lease.runId } });
      if (run === null || run.status !== 'RUNNING' || run.snapshotSha256 === null
          || run.snapshotEndedAtMs === null || run.snapshotSha256 !== proof.snapshotSha256) {
        throw new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'Current run has no matching durable authoritative snapshot');
      }
      const durableFindings = await tx.liveReconciliationFinding.findMany({
        where: { accountId: lease.accountId, lastSeenGeneration: lease.generation, resolvedAtMs: null },
        select: { findingSha256: true, blocking: true, category: true },
      });
      const durableDigests = durableFindings.map((finding) => finding.findingSha256).sort();
      if (durableDigests.length !== proof.findingSha256s.length
          || durableDigests.some((digest, index) => digest !== proof.findingSha256s[index])) {
        throw new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'Durable findings do not match the evaluated completion proof');
      }
      const [ambiguousOrders, ambiguousOrphans] = await Promise.all([
        tx.liveOrder.count({ where: {
          accountId: lease.accountId,
          OR: [
            { state: { in: ['DISPATCH_RESERVED', 'SUBMISSION_AMBIGUOUS'] } },
            { cancelState: { in: ['CANCEL_RESERVED', 'CANCEL_AMBIGUOUS'] } },
          ],
        } }),
        tx.liveOrphanVenueOrder.count({ where: {
          accountId: lease.accountId,
          cancelState: { in: ['CANCEL_CLAIMED', 'CANCEL_AMBIGUOUS'] },
        } }),
      ]);
      const blockingFindingCount = durableFindings.filter((finding) => finding.blocking).length;
      const manualReview = durableFindings.some((finding) => finding.category === 'MANUAL_REVIEW_REQUIRED' || finding.category === 'AMBIGUOUS')
        || ambiguousOrders + ambiguousOrphans > 0;
      const snapshotComplete = run.snapshotValidated && run.ordersComplete && run.positionsComplete;
      const status = manualReview ? 'MANUAL_REVIEW_REQUIRED' as const
        : blockingFindingCount > 0 || !snapshotComplete ? 'UNHEALTHY' as const
          : 'HEALTHY' as const;

      const runStatus = status === 'HEALTHY' ? 'COMPLETED_HEALTHY'
        : status === 'MANUAL_REVIEW_REQUIRED' ? 'COMPLETED_MANUAL_REVIEW' : 'COMPLETED_UNHEALTHY';

      const updatedRuns = await tx.liveReconciliationRun.updateMany({
        where: { runId: lease.runId, accountId: lease.accountId, generation: lease.generation, status: 'RUNNING' },
        data: {
          status: runStatus,
          evaluatedAtMs: BigInt(nowMs),
          findingCount: durableFindings.length,
          blockingFindingCount,
          completedAt: new Date(nowMs),
        },
      });
      if (updatedRuns.count !== 1) {
        throw new LiveExecutionError('LIVE_RECONCILIATION_STALE_GENERATION', 'This reconciliation run is no longer the RUNNING owner of its generation', {
          details: { accountId: lease.accountId, generation: lease.generation },
        });
      }

      const committed = await tx.liveReconciliationState.update({ where: { accountId: lease.accountId }, data: {
        status,
        // Only a HEALTHY completion stamps a healthy generation. Every other
        // outcome leaves it null, so the barrier cannot read a pass out of it.
        healthyGeneration: status === 'HEALTHY' ? lease.generation : null,
        blockingFindingCount,
        lastEvaluatedAtMs: BigInt(nowMs),
        revision: { increment: 1 },
      } });
      return toStateRecord(committed as unknown as StateRow);
    });
  }

  /** Records an orphan observation. Never adopts it into a local intent. */
  public async recordOrphanOrder(
    lease: LiveReconciliationLease,
    order: LiveVenueOrderEvidence,
    nowMs: number,
  ): Promise<LiveOrphanVenueOrderRecord> {
    return this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT account_id FROM live_reconciliation_state WHERE account_id = ${lease.accountId} FOR UPDATE`;
      const state = await tx.liveReconciliationState.findUnique({ where: { accountId: lease.accountId } });
      assertLeaseStillOwns(state as unknown as StateRow | null, lease);

      const orderedQuantity = canonicalNonNegativeLiveDecimal(order.orderedQuantity, 'orderedQuantity');
      const filledQuantity = canonicalNonNegativeLiveDecimal(order.filledQuantity, 'filledQuantity');
      const price = order.price === null ? null : canonicalLiveDecimalString(order.price, 'price');

      const row = await tx.liveOrphanVenueOrder.upsert({
        where: { accountId_exchangeOrderId: { accountId: lease.accountId, exchangeOrderId: order.exchangeOrderId } },
        create: {
          accountId: lease.accountId,
          exchangeOrderId: order.exchangeOrderId,
          pair: order.pair,
          side: order.side,
          venueStatus: order.venueStatus,
          orderedQuantity,
          filledQuantity,
          price,
          firstSeenGeneration: lease.generation,
          lastSeenGeneration: lease.generation,
          providerEventTimeMs: BigInt(order.providerEventTimeMs),
        },
        // Cancellation claim columns are deliberately absent from the update:
        // re-observing an orphan must never reset or re-arm a claim that
        // already exists (§9.8, §16 "no repeated orphan cancel").
        update: {
          venueStatus: order.venueStatus,
          filledQuantity,
          lastSeenGeneration: lease.generation,
          providerEventTimeMs: BigInt(order.providerEventTimeMs),
        },
      });
      void nowMs;
      return toOrphanRecord(row as unknown as OrphanRow);
    });
  }

  /**
   * Claims the single permitted cancellation for one orphan, BEFORE the wire
   * call (§9.7).
   *
   * `NONE -> CANCEL_CLAIMED` is conditional on the current state and revision,
   * so exactly one worker can ever reach the gateway for a given venue order.
   * An ambiguous prior attempt is explicitly NOT reclaimable: that is the
   * durable expression of "never resent after a restart".
   */
  public async claimOrphanCancellation(
    lease: LiveReconciliationLease,
    authorization: unknown,
    exchangeOrderId: string,
    nowMs: number,
  ): Promise<LiveOrphanCancelClaimOutcome> {
    return this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT account_id FROM live_reconciliation_state WHERE account_id = ${lease.accountId} FOR UPDATE`;
      const state = await tx.liveReconciliationState.findUnique({ where: { accountId: lease.accountId } });
      assertLeaseStillOwns(state as unknown as StateRow | null, lease);
      assertRunningAuthorization(state as unknown as StateRow, lease, authorization);

      await tx.$executeRaw`SELECT exchange_order_id FROM live_orphan_venue_order WHERE account_id = ${lease.accountId} AND exchange_order_id = ${exchangeOrderId} FOR UPDATE`;
      const current = await tx.liveOrphanVenueOrder.findUnique({
        where: { accountId_exchangeOrderId: { accountId: lease.accountId, exchangeOrderId } },
      });
      if (current === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Cannot claim a cancellation for an orphan that was never durably recorded', {
          details: { accountId: lease.accountId, exchangeOrderId },
        });
      }
      const record = toOrphanRecord(current as unknown as OrphanRow);
      if (record.cancelState !== 'NONE') {
        return Object.freeze({
          kind: 'NOT_CLAIMABLE' as const,
          record,
          reason: record.cancelState === 'CANCEL_AMBIGUOUS'
            ? 'A previous cancellation outcome is unestablished and is never resent'
            : `A cancellation claim already exists in state ${record.cancelState}`,
        });
      }

      const generation = record.cancelGeneration + 1;
      const updated = await tx.liveOrphanVenueOrder.updateMany({
        where: {
          accountId: lease.accountId,
          exchangeOrderId,
          cancelState: 'NONE',
          cancelGeneration: record.cancelGeneration,
          revision: record.revision,
        },
        data: {
          cancelState: 'CANCEL_CLAIMED',
          cancelGeneration: generation,
          cancelFaultCode: null,
          cancelClaimedAt: new Date(nowMs),
          cancelWireArmed: false,
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        // Another worker claimed it between the read and the write.
        const latest = await tx.liveOrphanVenueOrder.findUnique({
          where: { accountId_exchangeOrderId: { accountId: lease.accountId, exchangeOrderId } },
        });
        return Object.freeze({
          kind: 'NOT_CLAIMABLE' as const,
          record: toOrphanRecord(latest as unknown as OrphanRow),
          reason: 'A concurrent worker claimed this orphan cancellation first',
        });
      }
      const claimed = await tx.liveOrphanVenueOrder.findUnique({
        where: { accountId_exchangeOrderId: { accountId: lease.accountId, exchangeOrderId } },
      });
      return Object.freeze({ kind: 'CLAIMED' as const, record: toOrphanRecord(claimed as unknown as OrphanRow) });
    });
  }

  /** [P18 Wave A2 / F18-14] Durable pre-wire checkpoint for the orphan-cancel mutation. */
  public async armOrphanCancelWire(
    lease: LiveReconciliationLease,
    authorization: unknown,
    exchangeOrderId: string,
    generation: number,
  ): Promise<LiveOrphanVenueOrderRecord> {
    return this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT account_id FROM live_reconciliation_state WHERE account_id = ${lease.accountId} FOR UPDATE`;
      const state = await tx.liveReconciliationState.findUnique({ where: { accountId: lease.accountId } });
      assertLeaseStillOwns(state as unknown as StateRow | null, lease);
      assertRunningAuthorization(state as unknown as StateRow, lease, authorization);

      await tx.$executeRaw`SELECT exchange_order_id FROM live_orphan_venue_order WHERE account_id = ${lease.accountId} AND exchange_order_id = ${exchangeOrderId} FOR UPDATE`;
      const current = await tx.liveOrphanVenueOrder.findUnique({
        where: { accountId_exchangeOrderId: { accountId: lease.accountId, exchangeOrderId } },
      });
      if (current === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Cannot arm a cancellation for an orphan that was never durably recorded', {
          details: { accountId: lease.accountId, exchangeOrderId },
        });
      }
      const record = toOrphanRecord(current as unknown as OrphanRow);
      if (record.cancelState !== 'CANCEL_CLAIMED' || record.cancelGeneration !== generation || record.cancelWireArmed) {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Cannot arm an orphan cancel wire attempt outside an unarmed claim at the expected generation', {
          details: { accountId: lease.accountId, exchangeOrderId, generation },
        });
      }
      const updated = await tx.liveOrphanVenueOrder.updateMany({
        where: { accountId: lease.accountId, exchangeOrderId, cancelState: 'CANCEL_CLAIMED', cancelGeneration: generation, cancelWireArmed: false, revision: record.revision },
        data: { cancelWireArmed: true, revision: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Concurrent modification: orphan cancel wire arm claim moved before it could commit', {
          details: { accountId: lease.accountId, exchangeOrderId, generation },
        });
      }
      const armed = await tx.liveOrphanVenueOrder.findUnique({
        where: { accountId_exchangeOrderId: { accountId: lease.accountId, exchangeOrderId } },
      });
      return toOrphanRecord(armed as unknown as OrphanRow);
    });
  }

  /**
   * [P18 Wave A2 / F18-14] Crash recovery for an unarmed CLAIMED orphan
   * cancellation: local proof (the absence of the wire-arm flag) is sufficient
   * on its own, so this needs no venue evidence and sends zero wire requests.
   */
  public async reclaimUnarmedOrphanCancelClaim(
    lease: LiveReconciliationLease,
    authorization: unknown,
    exchangeOrderId: string,
    generation: number,
  ): Promise<LiveOrphanVenueOrderRecord> {
    return this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT account_id FROM live_reconciliation_state WHERE account_id = ${lease.accountId} FOR UPDATE`;
      const state = await tx.liveReconciliationState.findUnique({ where: { accountId: lease.accountId } });
      assertLeaseStillOwns(state as unknown as StateRow | null, lease);
      assertRunningAuthorization(state as unknown as StateRow, lease, authorization);

      await tx.$executeRaw`SELECT exchange_order_id FROM live_orphan_venue_order WHERE account_id = ${lease.accountId} AND exchange_order_id = ${exchangeOrderId} FOR UPDATE`;
      const current = await tx.liveOrphanVenueOrder.findUnique({
        where: { accountId_exchangeOrderId: { accountId: lease.accountId, exchangeOrderId } },
      });
      if (current === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Cannot reclaim a cancellation claim for an orphan that was never durably recorded', {
          details: { accountId: lease.accountId, exchangeOrderId },
        });
      }
      const record = toOrphanRecord(current as unknown as OrphanRow);
      if (record.cancelState !== 'CANCEL_CLAIMED' || record.cancelGeneration !== generation || record.cancelWireArmed) {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Cannot reclaim an orphan cancellation claim that may have reached the wire', {
          details: { accountId: lease.accountId, exchangeOrderId, generation },
        });
      }
      const updated = await tx.liveOrphanVenueOrder.updateMany({
        where: { accountId: lease.accountId, exchangeOrderId, cancelState: 'CANCEL_CLAIMED', cancelGeneration: generation, cancelWireArmed: false, revision: record.revision },
        data: { cancelState: 'NONE', cancelWireArmed: false, revision: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Concurrent modification: orphan cancellation claim moved before it could be reclaimed', {
          details: { accountId: lease.accountId, exchangeOrderId, generation },
        });
      }
      const reclaimed = await tx.liveOrphanVenueOrder.findUnique({
        where: { accountId_exchangeOrderId: { accountId: lease.accountId, exchangeOrderId } },
      });
      return toOrphanRecord(reclaimed as unknown as OrphanRow);
    });
  }

  public async completeOrphanCancellation(
    lease: LiveReconciliationLease,
    authorization: unknown,
    exchangeOrderId: string,
    generation: number,
    outcome: 'CANCEL_ACKNOWLEDGED' | 'CANCEL_AMBIGUOUS' | 'CANCEL_REJECTED',
    faultCode: string | null,
  ): Promise<LiveOrphanVenueOrderRecord> {
    return this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT account_id FROM live_reconciliation_state WHERE account_id = ${lease.accountId} FOR UPDATE`;
      const state = await tx.liveReconciliationState.findUnique({ where: { accountId: lease.accountId } });
      assertLeaseStillOwns(state as unknown as StateRow | null, lease);
      assertRunningAuthorization(state as unknown as StateRow, lease, authorization);

      const updated = await tx.liveOrphanVenueOrder.updateMany({
        where: {
          accountId: lease.accountId,
          exchangeOrderId,
          cancelGeneration: generation,
          cancelState: 'CANCEL_CLAIMED',
        },
        // [F18-18] This transition always leaves CANCEL_CLAIMED (the WHERE
        // clause above requires it), so any wire-arm proof is no longer
        // meaningful and must not survive as a contradictory `true` against
        // a non-claimed cancel state.
        data: { cancelState: outcome, cancelFaultCode: faultCode, cancelWireArmed: false, revision: { increment: 1 } },
      });
      const row = await tx.liveOrphanVenueOrder.findUnique({
        where: { accountId_exchangeOrderId: { accountId: lease.accountId, exchangeOrderId } },
      });
      if (row === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Orphan record vanished while completing its cancellation', {
          details: { accountId: lease.accountId, exchangeOrderId },
        });
      }
      const record = toOrphanRecord(row as unknown as OrphanRow);
      if (updated.count !== 1 && !(record.cancelGeneration === generation && record.cancelState === outcome)) {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Orphan cancellation claim ownership changed before completion', {
          details: { accountId: lease.accountId, exchangeOrderId, generation },
        });
      }
      return record;
    });
  }

  public async loadOrphanOrders(accountId: string): Promise<readonly LiveOrphanVenueOrderRecord[]> {
    const rows = await this.#prisma.liveOrphanVenueOrder.findMany({
      where: { accountId },
      orderBy: { exchangeOrderId: 'asc' },
    });
    return Object.freeze(rows.map((row) => toOrphanRecord(row as unknown as OrphanRow)));
  }

  /**
   * [P18 Wave C1 / F18-06] Durably resolves one `CANCEL_AMBIGUOUS` orphan
   * cancellation.
   *
   * Deliberately independent of `LiveReconciliationLease` / reconciliation
   * generation fencing: this is a SEPARATE recovery authority from machine
   * reconciliation (§9/§11 of the F18-06 brief) and may commit whether or
   * not reconciliation can currently even run. Its own fencing is simpler and
   * stronger for what it protects: the row is locked (`FOR UPDATE`), then
   * re-checked for account/orphan identity (implicit — both come from
   * `request` itself, never a separate argument, so there is no code path
   * through which a request minted for one orphan could touch another),
   * revision, and current cancel state, all inside the transaction that also
   * writes the append-only audit row. A stale revision, a non-ambiguous
   * state, or a duplicate resolution for the same (account, order, cancel
   * generation) all fail closed with zero mutation.
   */
  public async resolveOrphanCancelAmbiguity(
    request: OrphanAmbiguityResolutionRequest,
    nowMs: number,
  ): Promise<{ readonly resolution: LiveOrphanCancelResolutionRecord; readonly orphan: LiveOrphanVenueOrderRecord }> {
    const requested = readOrphanAmbiguityResolutionRequest(request);
    if (requested === null) {
      throw new LiveExecutionError('LIVE_ORPHAN_RESOLUTION_INVALID', 'A genuine orphan ambiguity resolution request is required');
    }
    return this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT exchange_order_id FROM live_orphan_venue_order WHERE account_id = ${requested.accountId} AND exchange_order_id = ${requested.exchangeOrderId} FOR UPDATE`;
      const current = await tx.liveOrphanVenueOrder.findUnique({
        where: { accountId_exchangeOrderId: { accountId: requested.accountId, exchangeOrderId: requested.exchangeOrderId } },
      });
      if (current === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Cannot resolve ambiguity for an orphan that was never durably recorded', {
          details: { accountId: requested.accountId, exchangeOrderId: requested.exchangeOrderId },
        });
      }
      const orphan = toOrphanRecord(current as unknown as OrphanRow);
      if (orphan.revision !== requested.expectedRevision) {
        throw new LiveExecutionError('LIVE_ORPHAN_RESOLUTION_STALE_REVISION', 'The durable orphan record has moved since this resolution request was minted', {
          details: {
            accountId: requested.accountId,
            exchangeOrderId: requested.exchangeOrderId,
            expectedRevision: requested.expectedRevision,
            currentRevision: orphan.revision,
          },
        });
      }
      if (orphan.cancelState !== 'CANCEL_AMBIGUOUS') {
        throw new LiveExecutionError('LIVE_ORPHAN_RESOLUTION_NOT_AMBIGUOUS', 'Only a durably CANCEL_AMBIGUOUS orphan cancellation may be resolved', {
          details: { accountId: requested.accountId, exchangeOrderId: requested.exchangeOrderId, cancelState: orphan.cancelState },
        });
      }

      const resolutionId = randomUUID();
      let resolutionRow: ResolutionRow;
      try {
        resolutionRow = await tx.liveOrphanCancelResolution.create({
          data: {
            resolutionId,
            accountId: requested.accountId,
            exchangeOrderId: requested.exchangeOrderId,
            resolvedOrphanRevision: orphan.revision,
            resolvedCancelGeneration: orphan.cancelGeneration,
            outcome: requested.outcome,
            resolvedBy: requested.resolvedBy,
            note: requested.note,
            resolvedAtMs: BigInt(nowMs),
          },
        }) as unknown as ResolutionRow;
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          throw new LiveExecutionError('LIVE_ORPHAN_RESOLUTION_ALREADY_RESOLVED', 'This exact ambiguous cancellation attempt already has a durable resolution', {
            details: { accountId: requested.accountId, exchangeOrderId: requested.exchangeOrderId, cancelGeneration: orphan.cancelGeneration },
          });
        }
        throw error;
      }

      const updated = await tx.liveOrphanVenueOrder.updateMany({
        where: {
          accountId: requested.accountId,
          exchangeOrderId: requested.exchangeOrderId,
          revision: requested.expectedRevision,
          cancelState: 'CANCEL_AMBIGUOUS',
        },
        data: { cancelState: 'CANCEL_AMBIGUOUS_RESOLVED', revision: { increment: 1 } },
      });
      if (updated.count !== 1) {
        // A concurrent writer moved the row between the lock read above and
        // this write. Under FOR UPDATE this should be unreachable, but the
        // conditional WHERE is kept as the same defense-in-depth every other
        // durable Phase18 write in this file already applies.
        throw new LiveExecutionError('LIVE_ORPHAN_RESOLUTION_STALE_REVISION', 'Concurrent modification: the orphan record moved before this resolution could commit', {
          details: { accountId: requested.accountId, exchangeOrderId: requested.exchangeOrderId },
        });
      }
      const finalOrphan = await tx.liveOrphanVenueOrder.findUnique({
        where: { accountId_exchangeOrderId: { accountId: requested.accountId, exchangeOrderId: requested.exchangeOrderId } },
      });
      return Object.freeze({
        resolution: toResolutionRecord(resolutionRow),
        orphan: toOrphanRecord(finalOrphan as unknown as OrphanRow),
      });
    });
  }

  public async loadOrphanCancelResolutions(accountId: string, exchangeOrderId: string): Promise<readonly LiveOrphanCancelResolutionRecord[]> {
    const rows = await this.#prisma.liveOrphanCancelResolution.findMany({
      where: { accountId, exchangeOrderId },
      orderBy: { resolvedAtMs: 'asc' },
    });
    return Object.freeze(rows.map((row) => toResolutionRecord(row as unknown as ResolutionRow)));
  }

  /**
   * Replaces the proven ownership shares for one pair as one atomic set, and
   * materializes the Phase17 single-owner `live_position` record only where
   * exactly one owner provably holds the entire aggregate.
   *
   * Idempotence (§16): a share whose lineage digest, quantity and side are
   * unchanged is left completely untouched — no update, no revision bump — so
   * rerunning reconciliation against unchanged truth produces no churn.
   */
  public async applyPositionOwnership(
    lease: LiveReconciliationLease,
    authorization: unknown,
    input: {
      readonly pair: string;
      readonly shares: readonly LivePositionOwnershipShareInput[];
      readonly instrumentSpecSnapshotId: string | null;
      readonly materializeSingleOwner: boolean;
      readonly nowMs: number;
    },
  ): Promise<readonly LivePositionOwnershipShareRecord[]> {
    return this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT account_id FROM live_reconciliation_state WHERE account_id = ${lease.accountId} FOR UPDATE`;
      const state = await tx.liveReconciliationState.findUnique({ where: { accountId: lease.accountId } });
      assertLeaseStillOwns(state as unknown as StateRow | null, lease);
      assertRunningAuthorization(state as unknown as StateRow, lease, authorization);

      const keep = new Set(input.shares.map((share) => share.ownerStrategyInstanceId));
      const existing = await tx.livePositionOwnershipShare.findMany({
        where: { accountId: lease.accountId, pair: input.pair },
      });
      for (const row of existing) {
        if (!keep.has(row.ownerStrategyInstanceId)) {
          await tx.livePositionOwnershipShare.delete({
            where: {
              accountId_pair_ownerStrategyInstanceId: {
                accountId: lease.accountId, pair: input.pair, ownerStrategyInstanceId: row.ownerStrategyInstanceId,
              },
            },
          });
        }
      }

      const records: LivePositionOwnershipShareRecord[] = [];
      for (const share of input.shares) {
        const quantity = canonicalLiveDecimalString(share.quantity, 'quantity');
        const previous = existing.find((row) => row.ownerStrategyInstanceId === share.ownerStrategyInstanceId);
        const unchanged = previous !== undefined
          && previous.lineageSha256 === share.lineageSha256
          && previous.side === share.side
          && previous.materialized === input.materializeSingleOwner
          && liveDecimal(decimalString(previous.quantity)).equals(liveDecimal(quantity));
        if (unchanged) {
          // Only the generation window moves, and it is not part of any proof,
          // so it does not bump `revision`.
          const refreshed = await tx.livePositionOwnershipShare.update({
            where: {
              accountId_pair_ownerStrategyInstanceId: {
                accountId: lease.accountId, pair: input.pair, ownerStrategyInstanceId: share.ownerStrategyInstanceId,
              },
            },
            data: { lastProvenGeneration: lease.generation },
          });
          records.push(toShareRecord(refreshed as unknown as ShareRow));
          continue;
        }

        const row = await tx.livePositionOwnershipShare.upsert({
          where: {
            accountId_pair_ownerStrategyInstanceId: {
              accountId: lease.accountId, pair: input.pair, ownerStrategyInstanceId: share.ownerStrategyInstanceId,
            },
          },
          create: {
            accountId: lease.accountId,
            pair: input.pair,
            ownerStrategyInstanceId: share.ownerStrategyInstanceId,
            side: share.side,
            quantity,
            ownerStrategyId: share.ownerStrategyId,
            ownerStrategyVersion: share.ownerStrategyVersion,
            ownerParameterHash: share.ownerParameterHash,
            venuePositionId: share.venuePositionId,
            lineageSha256: share.lineageSha256,
            lineageJson: JSON.stringify([...share.lineageIntentIds].sort()),
            establishedGeneration: lease.generation,
            lastProvenGeneration: lease.generation,
            materialized: input.materializeSingleOwner,
          },
          update: {
            side: share.side,
            quantity,
            ownerStrategyId: share.ownerStrategyId,
            ownerStrategyVersion: share.ownerStrategyVersion,
            ownerParameterHash: share.ownerParameterHash,
            venuePositionId: share.venuePositionId,
            lineageSha256: share.lineageSha256,
            lineageJson: JSON.stringify([...share.lineageIntentIds].sort()),
            lastProvenGeneration: lease.generation,
            materialized: input.materializeSingleOwner,
            revision: { increment: 1 },
          },
        });
        records.push(toShareRecord(row as unknown as ShareRow));
      }

      if (input.materializeSingleOwner && input.shares.length === 1) {
        const share = input.shares[0]!;
        const quantity = canonicalLiveDecimalString(share.quantity, 'quantity');
        const current = await tx.livePosition.findUnique({
          where: { accountId_pair: { accountId: lease.accountId, pair: input.pair } },
        });
        const identical = current !== null
          && current.side === share.side
          && current.ownerStrategyInstanceId === share.ownerStrategyInstanceId
          && current.ownerStrategyId === share.ownerStrategyId
          && current.ownerStrategyVersion === share.ownerStrategyVersion
          && current.ownerParameterHash === share.ownerParameterHash
          && current.instrumentSpecSnapshotId === share.instrumentSpecSnapshotId
          && liveDecimal(decimalString(current.quantity)).equals(liveDecimal(quantity));
        if (!identical) {
          // `position_instance_id` is derived from the proof, so re-proving the
          // same ownership yields the same identity and a replay cannot fork it.
          await tx.livePosition.upsert({
            where: { accountId_pair: { accountId: lease.accountId, pair: input.pair } },
            create: {
              accountId: lease.accountId,
              pair: input.pair,
              positionInstanceId: share.lineageSha256,
              revision: 0,
              side: share.side,
              quantity,
              instrumentSpecSnapshotId: share.instrumentSpecSnapshotId,
              ownerStrategyInstanceId: share.ownerStrategyInstanceId,
              ownerStrategyId: share.ownerStrategyId,
              ownerStrategyVersion: share.ownerStrategyVersion,
              ownerParameterHash: share.ownerParameterHash,
            },
            update: {
              positionInstanceId: share.lineageSha256,
              side: share.side,
              quantity,
              instrumentSpecSnapshotId: share.instrumentSpecSnapshotId,
              ownerStrategyInstanceId: share.ownerStrategyInstanceId,
              ownerStrategyId: share.ownerStrategyId,
              ownerStrategyVersion: share.ownerStrategyVersion,
              ownerParameterHash: share.ownerParameterHash,
              revision: { increment: 1 },
            },
          });
        }
      }
      return Object.freeze(records);
    });
  }

  public async clearPositionOwnership(lease: LiveReconciliationLease, authorization: unknown, pair: string): Promise<void> {
    await this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT account_id FROM live_reconciliation_state WHERE account_id = ${lease.accountId} FOR UPDATE`;
      const state = await tx.liveReconciliationState.findUnique({ where: { accountId: lease.accountId } });
      assertLeaseStillOwns(state as unknown as StateRow | null, lease);
      assertRunningAuthorization(state as unknown as StateRow, lease, authorization);
      await tx.livePositionOwnershipShare.deleteMany({ where: { accountId: lease.accountId, pair } });
      await tx.livePosition.deleteMany({ where: { accountId: lease.accountId, pair } });
    });
  }

  public async loadOwnershipShares(accountId: string, pair: string): Promise<readonly LivePositionOwnershipShareRecord[]> {
    const rows = await this.#prisma.livePositionOwnershipShare.findMany({
      where: { accountId, pair },
      orderBy: { ownerStrategyInstanceId: 'asc' },
    });
    return Object.freeze(rows.map((row) => toShareRecord(row as unknown as ShareRow)));
  }

  public async loadLivePosition(accountId: string, pair: string): Promise<LivePositionOwnershipRecord | null> {
    const row = await this.#prisma.livePosition.findUnique({ where: { accountId_pair: { accountId, pair } } });
    if (row === null) return null;
    return Object.freeze({
      accountId: row.accountId,
      pair: row.pair,
      positionInstanceId: row.positionInstanceId,
      positionRevision: row.revision,
      side: row.side as 'LONG' | 'SHORT',
      ownedQuantity: decimalString(row.quantity),
      instrumentSpecSnapshotId: row.instrumentSpecSnapshotId,
      ownerStrategyInstanceId: row.ownerStrategyInstanceId,
      ownerStrategyId: row.ownerStrategyId,
      ownerStrategyVersion: row.ownerStrategyVersion,
      ownerParameterHash: row.ownerParameterHash,
    });
  }

  public async countCurrentBlockingFindings(accountId: string, generation: number): Promise<number> {
    return this.#prisma.liveReconciliationFinding.count({
      where: { accountId, lastSeenGeneration: generation, blocking: true, resolvedAtMs: null },
    });
  }
}

Object.freeze(LiveReconciliationAuthorization.prototype);
Object.freeze(LiveReconciliationAuthorization);

// Protect the private-field authorization reader and concrete persistence
// implementation from CommonJS export replacement. Durable row validation is
// still mandatory even for a genuine object.
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const [name, value] of Object.entries({
    LiveReconciliationAuthorization,
    PrismaLiveReconciliationRepository,
  })) {
    if (Object.getOwnPropertyDescriptor(module.exports, name)?.configurable !== false) {
      Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
    }
  }
  Object.freeze(module.exports);
}
