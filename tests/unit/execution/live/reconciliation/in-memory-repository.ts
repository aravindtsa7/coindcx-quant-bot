/**
 * An in-memory `LiveReconciliationRepository` that emulates the exact database
 * constraints the production Prisma adapter relies on:
 *
 *   - UNIQUE(account_id, generation) single-winner generation claim;
 *   - the fencing check every write performs before mutating;
 *   - UNIQUE(account_id, finding_sha256) finding dedup;
 *   - the conditional NONE -> CANCEL_CLAIMED orphan cancellation claim.
 *
 * It exists so service-level behaviour can be asserted without a database. The
 * durable guarantees themselves are proven against REAL MySQL in
 * `tests/integration/execution/live-reconciliation-persistence.integration.test.ts`.
 */
import { LiveExecutionError } from '../../../../../src/execution/live/errors';
import type { LivePositionOwnershipRecord } from '../../../../../src/execution/live/repository';
import { initialReconciliationState } from '../../../../../src/execution/live/reconciliation';
import { readLiveRuntimeEpoch } from '../../../../../src/execution/live/reconciliation/barrier';
import { readOrphanAmbiguityResolutionRequest, type OrphanAmbiguityResolutionRequest } from '../../../../../src/execution/live/reconciliation/orphan-resolution';
import { LiveReconciliationCompletionProof } from '../../../../../src/execution/live/reconciliation/service';
import { findingSha256, isFindingBlocking } from '../../../../../src/execution/live/reconciliation/findings';
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
} from '../../../../../src/execution/live/reconciliation/ports';
import type {
  LiveReconciliationFinding,
  LiveReconciliationStatusName,
  LiveVenueOrderEvidence,
} from '../../../../../src/execution/live/reconciliation/types';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class InMemoryReconciliationRepository implements LiveReconciliationRepository {
  readonly #states = new Map<string, Mutable<LiveReconciliationStateRecord>>();
  readonly #runs = new Map<string, { accountId: string; generation: number; status: string }>();
  readonly #findings = new Map<string, Mutable<LiveReconciliationFindingRecord>>();
  readonly #orphans = new Map<string, Mutable<LiveOrphanVenueOrderRecord>>();
  readonly #orphanResolutions = new Map<string, Mutable<LiveOrphanCancelResolutionRecord>>();
  #resolutionSequence = 0;
  readonly #shares = new Map<string, Mutable<LivePositionOwnershipShareRecord>>();
  readonly #positions = new Map<string, LivePositionOwnershipRecord>();
  readonly #snapshots = new Map<string, { sha: string; complete: boolean }>();
  #runSequence = 0;
  public findingWriteCount = 0;
  public ownershipWriteCount = 0;

  public seedLivePosition(position: LivePositionOwnershipRecord): void {
    this.#positions.set(`${position.accountId}:${position.pair}`, Object.freeze({ ...position }));
  }

  #state(accountId: string): Mutable<LiveReconciliationStateRecord> {
    let state = this.#states.get(accountId);
    if (state === undefined) {
      state = { ...initialReconciliationState(accountId) };
      this.#states.set(accountId, state);
    }
    return state;
  }

  /** The same fencing rule the Prisma adapter applies before every write. */
  #assertOwns(lease: LiveReconciliationLease): Mutable<LiveReconciliationStateRecord> {
    const state = this.#state(lease.accountId);
    if (state.currentGeneration !== lease.generation || state.currentRuntimeEpoch !== lease.runtimeEpoch) {
      throw new LiveExecutionError('LIVE_RECONCILIATION_STALE_GENERATION', 'A newer reconciliation generation has taken ownership of this account', {
        details: { accountId: lease.accountId, leaseGeneration: lease.generation, currentGeneration: state.currentGeneration },
      });
    }
    return state;
  }

  public async loadState(accountId: string): Promise<LiveReconciliationStateRecord> {
    return Object.freeze({ ...this.#state(accountId) });
  }

  public async authorizeCurrentHealthy(accountId: string, runtimeIdentity: unknown): Promise<{
    readonly state: LiveReconciliationStateRecord;
    readonly authorization: unknown | null;
  }> {
    const state = await this.loadState(accountId);
    const epoch = readLiveRuntimeEpoch(runtimeIdentity);
    const permitted = epoch !== null && state.status === 'HEALTHY'
      && state.currentRuntimeEpoch === epoch && state.healthyGeneration === state.currentGeneration
      && state.blockingFindingCount === 0;
    return Object.freeze({ state, authorization: permitted ? Object.freeze({ accountId, generation: state.currentGeneration }) : null });
  }

  public async claimGeneration(accountId: string, runtimeIdentity: unknown, nowMs: number): Promise<LiveReconciliationClaimOutcome> {
    const runtimeEpoch = readLiveRuntimeEpoch(runtimeIdentity) ?? (typeof runtimeIdentity === 'string' ? runtimeIdentity : null);
    if (runtimeEpoch === null) throw new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'Runtime identity required');
    const state = this.#state(accountId);
    const generation = state.currentGeneration + 1;
    const key = `${accountId}:${generation}`;
    // Emulates UNIQUE(account_id, generation): the loser sees the row exists.
    if (this.#runs.has(key)) return Object.freeze({ kind: 'LOST' as const, state: Object.freeze({ ...state }) });
    this.#runSequence += 1;
    const runId = `run-${this.#runSequence}`;
    for (const run of this.#runs.values()) if (run.accountId === accountId && run.status === 'RUNNING') run.status = 'ABANDONED';
    this.#runs.set(key, { accountId, generation, status: 'RUNNING' });
    state.status = 'RUNNING';
    state.currentGeneration = generation;
    state.currentRunId = runId;
    state.currentRuntimeEpoch = runtimeEpoch;
    state.healthyGeneration = null;
    state.revision += 1;
    return Object.freeze({
      kind: 'CLAIMED' as const,
      lease: Object.freeze({ accountId, runId, generation, runtimeEpoch, startedAtMs: nowMs }),
      authorization: Object.freeze({ accountId, generation, runtimeEpoch, mode: 'RUNNING' }),
    });
  }

  public async recordSnapshot(lease: LiveReconciliationLease, snapshotSha256 = 'test-snapshot', _endedAtMs = 0, completeness = {
    validated: true, ordersComplete: true, positionsComplete: true,
  }): Promise<void> {
    this.#assertOwns(lease);
    this.#snapshots.set(lease.runId, { sha: snapshotSha256, complete: completeness.validated && completeness.ordersComplete && completeness.positionsComplete });
  }

  public async persistFindings(
    lease: LiveReconciliationLease,
    findings: readonly LiveReconciliationFinding[],
    nowMs: number,
  ): Promise<readonly LiveReconciliationFindingRecord[]> {
    this.#assertOwns(lease);
    const records: LiveReconciliationFindingRecord[] = [];
    for (const finding of findings) {
      const digest = findingSha256(lease.accountId, finding);
      const key = `${lease.accountId}:${digest}`;
      const existing = this.#findings.get(key);
      if (existing === undefined) {
        this.findingWriteCount += 1;
        const record: Mutable<LiveReconciliationFindingRecord> = {
          findingId: `finding-${this.#findings.size + 1}`,
          accountId: lease.accountId,
          findingSha256: digest,
          category: finding.category,
          code: finding.code,
          blocking: isFindingBlocking(finding),
          pair: finding.subject.pair,
          intentId: finding.subject.intentId,
          exchangeOrderId: finding.subject.exchangeOrderId,
          venuePositionId: finding.subject.venuePositionId,
          strategyInstanceId: finding.subject.strategyInstanceId,
          firstSeenGeneration: lease.generation,
          lastSeenGeneration: lease.generation,
        };
        this.#findings.set(key, record);
        records.push(Object.freeze({ ...record }));
        continue;
      }
      // Dedup: only the generation window moves. No second row is ever created.
      existing.lastSeenGeneration = lease.generation;
      records.push(Object.freeze({ ...existing }));
    }
    void nowMs;
    return Object.freeze(records);
  }

  public async completeRun(
    lease: LiveReconciliationLease,
    completionProofOrStatus: unknown,
    nowMsOrBlockingFindingCount: number,
    legacyNowMs?: number,
  ): Promise<LiveReconciliationStateRecord> {
    const state = this.#assertOwns(lease);
    const run = this.#runs.get(`${lease.accountId}:${lease.generation}`);
    if (run === undefined || run.status !== 'RUNNING') {
      throw new LiveExecutionError('LIVE_RECONCILIATION_STALE_GENERATION', 'This reconciliation run is no longer the RUNNING owner of its generation');
    }
    const proof = LiveReconciliationCompletionProof.read(completionProofOrStatus);
    const blockingFindingCount = proof === null
      ? nowMsOrBlockingFindingCount
      : [...this.#findings.values()].filter((finding) => finding.accountId === lease.accountId
        && finding.lastSeenGeneration === lease.generation && finding.blocking).length;
    const currentFindings = [...this.#findings.values()].filter((finding) => finding.accountId === lease.accountId
      && finding.lastSeenGeneration === lease.generation);
    const manualReview = currentFindings.some((finding) => finding.category === 'AMBIGUOUS'
      || finding.category === 'MANUAL_REVIEW_REQUIRED');
    const status: LiveReconciliationStatusName = proof === null
      ? completionProofOrStatus as LiveReconciliationStatusName
      : manualReview ? 'MANUAL_REVIEW_REQUIRED'
        : blockingFindingCount > 0 || this.#snapshots.get(lease.runId)?.complete !== true ? 'UNHEALTHY' : 'HEALTHY';
    const nowMs = legacyNowMs ?? nowMsOrBlockingFindingCount;
    run.status = status === 'HEALTHY' ? 'COMPLETED_HEALTHY' : 'COMPLETED_OTHER';
    state.status = status;
    state.healthyGeneration = status === 'HEALTHY' ? lease.generation : null;
    state.blockingFindingCount = blockingFindingCount;
    state.lastEvaluatedAtMs = nowMs;
    state.revision += 1;
    return Object.freeze({ ...state });
  }

  public async recordOrphanOrder(
    lease: LiveReconciliationLease,
    order: LiveVenueOrderEvidence,
  ): Promise<LiveOrphanVenueOrderRecord> {
    this.#assertOwns(lease);
    const key = `${lease.accountId}:${order.exchangeOrderId}`;
    const existing = this.#orphans.get(key);
    if (existing !== undefined) {
      // Re-observing NEVER resets a cancellation claim.
      existing.lastSeenGeneration = lease.generation;
      existing.venueStatus = order.venueStatus;
      existing.filledQuantity = order.filledQuantity;
      return Object.freeze({ ...existing });
    }
    const record: Mutable<LiveOrphanVenueOrderRecord> = {
      accountId: lease.accountId,
      exchangeOrderId: order.exchangeOrderId,
      pair: order.pair,
      side: order.side,
      venueStatus: order.venueStatus,
      orderedQuantity: order.orderedQuantity,
      filledQuantity: order.filledQuantity,
      price: order.price,
      firstSeenGeneration: lease.generation,
      lastSeenGeneration: lease.generation,
      cancelState: 'NONE',
      cancelGeneration: 0,
      cancelFaultCode: null,
      cancelWireArmed: false,
      revision: 0,
    };
    this.#orphans.set(key, record);
    return Object.freeze({ ...record });
  }

  public async claimOrphanCancellation(lease: LiveReconciliationLease, _authorization: unknown, exchangeOrderId: string): Promise<LiveOrphanCancelClaimOutcome> {
    this.#assertOwns(lease);
    const record = this.#orphans.get(`${lease.accountId}:${exchangeOrderId}`);
    if (record === undefined) {
      throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Cannot claim a cancellation for an orphan that was never durably recorded');
    }
    if (record.cancelState !== 'NONE') {
      return Object.freeze({
        kind: 'NOT_CLAIMABLE' as const,
        record: Object.freeze({ ...record }),
        reason: record.cancelState === 'CANCEL_AMBIGUOUS'
          ? 'A previous cancellation outcome is unestablished and is never resent'
          : `A cancellation claim already exists in state ${record.cancelState}`,
      });
    }
    record.cancelState = 'CANCEL_CLAIMED';
    record.cancelGeneration += 1;
    record.cancelWireArmed = false;
    record.revision += 1;
    return Object.freeze({ kind: 'CLAIMED' as const, record: Object.freeze({ ...record }) });
  }

  public async armOrphanCancelWire(lease: LiveReconciliationLease, _authorization: unknown, exchangeOrderId: string, generation: number): Promise<LiveOrphanVenueOrderRecord> {
    this.#assertOwns(lease);
    const record = this.#orphans.get(`${lease.accountId}:${exchangeOrderId}`);
    if (record === undefined) throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Orphan record vanished');
    if (record.cancelState !== 'CANCEL_CLAIMED' || record.cancelGeneration !== generation || record.cancelWireArmed) {
      throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Cannot arm an orphan cancel wire attempt outside an unarmed claim at the expected generation');
    }
    record.cancelWireArmed = true;
    record.revision += 1;
    return Object.freeze({ ...record });
  }

  public async reclaimUnarmedOrphanCancelClaim(lease: LiveReconciliationLease, _authorization: unknown, exchangeOrderId: string, generation: number): Promise<LiveOrphanVenueOrderRecord> {
    this.#assertOwns(lease);
    const record = this.#orphans.get(`${lease.accountId}:${exchangeOrderId}`);
    if (record === undefined) throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Orphan record vanished');
    if (record.cancelState !== 'CANCEL_CLAIMED' || record.cancelGeneration !== generation || record.cancelWireArmed) {
      throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Cannot reclaim an orphan cancellation claim that may have reached the wire');
    }
    record.cancelState = 'NONE';
    record.cancelWireArmed = false;
    record.revision += 1;
    return Object.freeze({ ...record });
  }

  public async completeOrphanCancellation(
    lease: LiveReconciliationLease,
    _authorization: unknown,
    exchangeOrderId: string,
    generation: number,
    outcome: 'CANCEL_ACKNOWLEDGED' | 'CANCEL_AMBIGUOUS' | 'CANCEL_REJECTED',
    faultCode: string | null,
  ): Promise<LiveOrphanVenueOrderRecord> {
    this.#assertOwns(lease);
    const record = this.#orphans.get(`${lease.accountId}:${exchangeOrderId}`);
    if (record === undefined) throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Orphan record vanished');
    if (record.cancelGeneration !== generation || record.cancelState !== 'CANCEL_CLAIMED') {
      if (!(record.cancelGeneration === generation && record.cancelState === outcome)) {
        throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Orphan cancellation claim ownership changed before completion');
      }
      return Object.freeze({ ...record });
    }
    record.cancelState = outcome;
    record.cancelFaultCode = faultCode;
    record.revision += 1;
    return Object.freeze({ ...record });
  }

  public async loadOrphanOrders(accountId: string): Promise<readonly LiveOrphanVenueOrderRecord[]> {
    return Object.freeze([...this.#orphans.values()]
      .filter((record) => record.accountId === accountId)
      .sort((left, right) => (left.exchangeOrderId < right.exchangeOrderId ? -1 : 1))
      .map((record) => Object.freeze({ ...record })));
  }

  public async resolveOrphanCancelAmbiguity(
    request: OrphanAmbiguityResolutionRequest,
    nowMs: number,
  ): Promise<{ readonly resolution: LiveOrphanCancelResolutionRecord; readonly orphan: LiveOrphanVenueOrderRecord }> {
    const requested = readOrphanAmbiguityResolutionRequest(request);
    if (requested === null) {
      throw new LiveExecutionError('LIVE_ORPHAN_RESOLUTION_INVALID', 'A genuine orphan ambiguity resolution request is required');
    }
    const record = this.#orphans.get(`${requested.accountId}:${requested.exchangeOrderId}`);
    if (record === undefined) {
      throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Cannot resolve ambiguity for an orphan that was never durably recorded');
    }
    if (record.revision !== requested.expectedRevision) {
      throw new LiveExecutionError('LIVE_ORPHAN_RESOLUTION_STALE_REVISION', 'The durable orphan record has moved since this resolution request was minted', {
        details: { expectedRevision: requested.expectedRevision, currentRevision: record.revision },
      });
    }
    if (record.cancelState !== 'CANCEL_AMBIGUOUS') {
      throw new LiveExecutionError('LIVE_ORPHAN_RESOLUTION_NOT_AMBIGUOUS', 'Only a durably CANCEL_AMBIGUOUS orphan cancellation may be resolved', {
        details: { cancelState: record.cancelState },
      });
    }
    const resolutionKey = `${requested.accountId}:${requested.exchangeOrderId}:${record.cancelGeneration}`;
    if (this.#orphanResolutions.has(resolutionKey)) {
      throw new LiveExecutionError('LIVE_ORPHAN_RESOLUTION_ALREADY_RESOLVED', 'This exact ambiguous cancellation attempt already has a durable resolution', {
        details: { cancelGeneration: record.cancelGeneration },
      });
    }
    this.#resolutionSequence += 1;
    const resolution: Mutable<LiveOrphanCancelResolutionRecord> = {
      resolutionId: `orphan-resolution-${this.#resolutionSequence}`,
      accountId: requested.accountId,
      exchangeOrderId: requested.exchangeOrderId,
      resolvedOrphanRevision: record.revision,
      resolvedCancelGeneration: record.cancelGeneration,
      outcome: requested.outcome,
      resolvedBy: requested.resolvedBy,
      note: requested.note,
      resolvedAtMs: nowMs,
    };
    this.#orphanResolutions.set(resolutionKey, resolution);
    record.cancelState = 'CANCEL_AMBIGUOUS_RESOLVED';
    record.revision += 1;
    return Object.freeze({ resolution: Object.freeze({ ...resolution }), orphan: Object.freeze({ ...record }) });
  }

  public async loadOrphanCancelResolutions(accountId: string, exchangeOrderId: string): Promise<readonly LiveOrphanCancelResolutionRecord[]> {
    return Object.freeze([...this.#orphanResolutions.values()]
      .filter((record) => record.accountId === accountId && record.exchangeOrderId === exchangeOrderId)
      .sort((left, right) => left.resolvedAtMs - right.resolvedAtMs)
      .map((record) => Object.freeze({ ...record })));
  }

  public async applyPositionOwnership(
    lease: LiveReconciliationLease,
    _authorization: unknown,
    input: {
      readonly pair: string;
      readonly shares: readonly LivePositionOwnershipShareInput[];
      readonly instrumentSpecSnapshotId: string | null;
      readonly materializeSingleOwner: boolean;
      readonly nowMs: number;
    },
  ): Promise<readonly LivePositionOwnershipShareRecord[]> {
    this.#assertOwns(lease);
    const keep = new Set(input.shares.map((share) => share.ownerStrategyInstanceId));
    for (const [key, record] of [...this.#shares.entries()]) {
      if (record.accountId === lease.accountId && record.pair === input.pair && !keep.has(record.ownerStrategyInstanceId)) {
        this.#shares.delete(key);
      }
    }
    const records: LivePositionOwnershipShareRecord[] = [];
    for (const share of input.shares) {
      const key = `${lease.accountId}:${input.pair}:${share.ownerStrategyInstanceId}`;
      const existing = this.#shares.get(key);
      const unchanged = existing !== undefined
        && existing.lineageSha256 === share.lineageSha256
        && existing.side === share.side
        && existing.quantity === share.quantity
        && existing.materialized === input.materializeSingleOwner;
      if (unchanged && existing !== undefined) {
        // Only the generation window moves: no revision churn on a rerun.
        existing.lastProvenGeneration = lease.generation;
        records.push(Object.freeze({ ...existing }));
        continue;
      }
      this.ownershipWriteCount += 1;
      const record: Mutable<LivePositionOwnershipShareRecord> = {
        accountId: lease.accountId,
        pair: input.pair,
        ownerStrategyInstanceId: share.ownerStrategyInstanceId,
        side: share.side,
        quantity: share.quantity,
        ownerStrategyId: share.ownerStrategyId,
        ownerStrategyVersion: share.ownerStrategyVersion,
        ownerParameterHash: share.ownerParameterHash,
        venuePositionId: share.venuePositionId,
        lineageSha256: share.lineageSha256,
        lineageIntentIds: Object.freeze([...share.lineageIntentIds].sort()),
        establishedGeneration: existing?.establishedGeneration ?? lease.generation,
        lastProvenGeneration: lease.generation,
        materialized: input.materializeSingleOwner,
        revision: existing === undefined ? 0 : existing.revision + 1,
      };
      this.#shares.set(key, record);
      records.push(Object.freeze({ ...record }));
    }

    if (input.materializeSingleOwner && input.shares.length === 1) {
      const share = input.shares[0]!;
      this.#positions.set(`${lease.accountId}:${input.pair}`, Object.freeze({
        accountId: lease.accountId,
        pair: input.pair,
        positionInstanceId: share.lineageSha256,
        positionRevision: 0,
        side: share.side,
        ownedQuantity: share.quantity,
        instrumentSpecSnapshotId: share.instrumentSpecSnapshotId,
        ownerStrategyInstanceId: share.ownerStrategyInstanceId,
        ownerStrategyId: share.ownerStrategyId,
        ownerStrategyVersion: share.ownerStrategyVersion,
        ownerParameterHash: share.ownerParameterHash,
      }));
    }
    return Object.freeze(records);
  }

  public async clearPositionOwnership(lease: LiveReconciliationLease, _authorization: unknown, pair: string): Promise<void> {
    this.#assertOwns(lease);
    for (const [key, record] of [...this.#shares.entries()]) {
      if (record.accountId === lease.accountId && record.pair === pair) this.#shares.delete(key);
    }
    this.#positions.delete(`${lease.accountId}:${pair}`);
  }

  public async loadOwnershipShares(accountId: string, pair: string): Promise<readonly LivePositionOwnershipShareRecord[]> {
    return Object.freeze([...this.#shares.values()]
      .filter((record) => record.accountId === accountId && record.pair === pair)
      .sort((left, right) => (left.ownerStrategyInstanceId < right.ownerStrategyInstanceId ? -1 : 1))
      .map((record) => Object.freeze({ ...record })));
  }

  public async loadLivePosition(accountId: string, pair: string): Promise<LivePositionOwnershipRecord | null> {
    return this.#positions.get(`${accountId}:${pair}`) ?? null;
  }

  public async countCurrentBlockingFindings(accountId: string, generation: number): Promise<number> {
    return [...this.#findings.values()]
      .filter((record) => record.accountId === accountId && record.lastSeenGeneration === generation && record.blocking)
      .length;
  }

  public get findingCount(): number { return this.#findings.size; }
  public get shareCount(): number { return this.#shares.size; }
}
