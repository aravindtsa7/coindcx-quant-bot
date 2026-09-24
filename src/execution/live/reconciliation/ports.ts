/**
 * The Phase18 reconciliation PORTS (§20).
 *
 * Reconciliation domain code depends on these interfaces and nothing else. No
 * file under `src/execution/live/reconciliation/**` imports Axios, `node:http`,
 * a signer, a credential, or any CoinDCX module — exactly as Phase17 kept its
 * service behind `CoinDcxFuturesOrderGateway`. The architecture test proves it
 * over the true transitive import graph.
 *
 * Note what is deliberately NOT here: a generic "call the venue" primitive.
 * `LiveVenueEvidenceProvider` can only produce a complete, provenance-carrying
 * evidence set, and `LiveOrphanCancellationPort` can only cancel one exact
 * venue order id. Neither can express any other exchange operation, so
 * reconciliation physically cannot grow a second mutation capability at a call
 * site.
 */
import type { LivePositionOwnershipRecord } from '../repository';
import type {
  LiveEvidenceProvenance,
  LiveOrphanCancelResolutionOutcomeName,
  LiveOrphanCancelStateName,
  LiveReconciliationFinding,
  LiveReconciliationFindingCategoryName,
  LiveReconciliationStatusName,
  LiveVenueOrderEvidence,
  LiveVenuePositionEvidence,
} from './types';
import type { OrphanAmbiguityResolutionRequest } from './orphan-resolution';

/** Result of one authoritative orders read. */
export interface LiveVenueOrderReadResult {
  readonly orders: readonly LiveVenueOrderEvidence[];
  readonly provenance: LiveEvidenceProvenance;
}

/** Result of one authoritative positions read. */
export interface LiveVenuePositionReadResult {
  readonly positions: readonly LiveVenuePositionEvidence[];
  readonly provenance: LiveEvidenceProvenance;
}

/**
 * Authoritative private read evidence (§5, Wave B §F18-04).
 *
 * The implementation is an adapter over the already-production-verified
 * authenticated CoinDCX read path; it validates every provider response at the
 * integration boundary and must set `provenance.complete` only where
 * pagination genuinely reached exhaustion.
 *
 * Orders and positions are DELIBERATELY separate methods rather than one
 * combined read. CoinDCX exposes no atomic multi-endpoint snapshot, so the
 * reconciler (`../reconciliation/service.ts`) calls each of these an EXTRA
 * time, bracketing the other kind of read, and requires both brackets to prove
 * byte-identical before treating the result as a usable snapshot (§F18-04). A
 * single combined read could never support that protocol: it would still be
 * only one instant's worth of evidence dressed up as a pair.
 */
export interface LiveVenueEvidenceProvider {
  /**
   * Reads all currently-relevant futures orders for the account. Must never
   * invent a record, and must report incompleteness rather than truncating
   * silently. Callers may invoke this more than once per reconciliation run
   * (§F18-04); implementations must not cache or assume single-call use.
   */
  readOrders(request: {
    readonly accountId: string;
    /** Pairs the caller has durable state for. An implementation may read wider, never narrower. */
    readonly pairs: readonly string[];
    readonly timeoutMs: number;
  }): Promise<LiveVenueOrderReadResult>;

  /**
   * Reads all currently-relevant futures positions for the account. Same
   * repeat-call and no-truncation contract as `readOrders`.
   */
  readPositions(request: {
    readonly accountId: string;
    readonly timeoutMs: number;
  }): Promise<LiveVenuePositionReadResult>;
}

/**
 * The single orphan-cancellation capability (§9.1, §20).
 *
 * This is intentionally a *capability object*, not a gateway: the only
 * implementation wraps the already-approved Phase17
 * `CoinDcxFuturesOrderGateway`, so an orphan cancel travels the same audited
 * transport, signer, and endpoint map as every other Phase17 mutation. No
 * second raw-network mutation owner is introduced.
 */
export interface LiveOrphanCancellationPort {
  cancelVenueOrder(request: {
    readonly exchangeOrderId: string;
    readonly pair: string;
    readonly timeoutMs: number;
  }): Promise<LiveOrphanCancelResult>;
}

export type LiveOrphanCancelResult =
  | { readonly kind: 'CANCELLED' }
  | { readonly kind: 'REJECTED'; readonly reasonCode: string }
  /** Outcome unestablished. Becomes reconciliation-required and is NEVER resent. */
  | { readonly kind: 'AMBIGUOUS'; readonly reasonCode: string }
  /** Provably nothing left this process. */
  | { readonly kind: 'PRE_DISPATCH_FAILURE'; readonly reasonCode: string };

// ---------------------------------------------------------------------------
// Durable reconciliation state
// ---------------------------------------------------------------------------

/** The durable barrier row for one account, as read by the mutation gate. */
export interface LiveReconciliationStateRecord {
  readonly accountId: string;
  readonly status: LiveReconciliationStatusName;
  readonly currentGeneration: number;
  readonly currentRunId: string | null;
  readonly currentRuntimeEpoch: string | null;
  readonly healthyGeneration: number | null;
  readonly lastEvaluatedAtMs: number | null;
  readonly blockingFindingCount: number;
  readonly revision: number;
}

/** Ownership of one reconciliation generation. Only the holder may commit it. */
export interface LiveReconciliationLease {
  readonly accountId: string;
  readonly runId: string;
  readonly generation: number;
  readonly runtimeEpoch: string;
  readonly startedAtMs: number;
}

export type LiveReconciliationClaimOutcome =
  | { readonly kind: 'CLAIMED'; readonly lease: LiveReconciliationLease; readonly authorization: unknown }
  /** Another worker owns a newer or equal generation; this worker must not reconcile. */
  | { readonly kind: 'LOST'; readonly state: LiveReconciliationStateRecord };

/** One durable finding as stored, including its dedup identity and generation window. */
export interface LiveReconciliationFindingRecord {
  readonly findingId: string;
  readonly accountId: string;
  readonly findingSha256: string;
  readonly category: LiveReconciliationFindingCategoryName;
  readonly code: string;
  readonly blocking: boolean;
  readonly pair: string | null;
  readonly intentId: string | null;
  readonly exchangeOrderId: string | null;
  readonly venuePositionId: string | null;
  readonly strategyInstanceId: string | null;
  readonly firstSeenGeneration: number;
  readonly lastSeenGeneration: number;
}

/** A durable orphan venue order together with its cancellation claim state. */
export interface LiveOrphanVenueOrderRecord {
  readonly accountId: string;
  readonly exchangeOrderId: string;
  readonly pair: string;
  readonly side: 'BUY' | 'SELL';
  readonly venueStatus: string;
  readonly orderedQuantity: string;
  readonly filledQuantity: string;
  readonly price: string | null;
  readonly firstSeenGeneration: number;
  readonly lastSeenGeneration: number;
  readonly cancelState: LiveOrphanCancelStateName;
  readonly cancelGeneration: number;
  readonly cancelFaultCode: string | null;
  /** [P18 Wave A2 / F18-14] See `LiveOrder.dispatchWireArmed`'s doc for the concept. */
  readonly cancelWireArmed: boolean;
  readonly revision: number;
}

/**
 * [P18 Wave C1 / F18-06] One durable, append-only, auditable operator
 * resolution of a `CANCEL_AMBIGUOUS` orphan cancellation. Never updated or
 * deleted — the original ambiguity stays provable forever.
 */
export interface LiveOrphanCancelResolutionRecord {
  readonly resolutionId: string;
  readonly accountId: string;
  readonly exchangeOrderId: string;
  readonly resolvedOrphanRevision: number;
  readonly resolvedCancelGeneration: number;
  readonly outcome: LiveOrphanCancelResolutionOutcomeName;
  readonly resolvedBy: string;
  readonly note: string | null;
  readonly resolvedAtMs: number;
}

export type LiveOrphanCancelClaimOutcome =
  | { readonly kind: 'CLAIMED'; readonly record: LiveOrphanVenueOrderRecord }
  /** A claim already exists — including an ambiguous one, which is never retried. */
  | { readonly kind: 'NOT_CLAIMABLE'; readonly record: LiveOrphanVenueOrderRecord; readonly reason: string };

/** One proven strategy-instance share of an authoritative venue position. */
export interface LivePositionOwnershipShareRecord {
  readonly accountId: string;
  readonly pair: string;
  readonly ownerStrategyInstanceId: string;
  readonly side: 'LONG' | 'SHORT';
  readonly quantity: string;
  readonly ownerStrategyId: string;
  readonly ownerStrategyVersion: string;
  readonly ownerParameterHash: string;
  readonly venuePositionId: string | null;
  readonly lineageSha256: string;
  readonly lineageIntentIds: readonly string[];
  readonly establishedGeneration: number;
  readonly lastProvenGeneration: number;
  readonly materialized: boolean;
  readonly revision: number;
}

/**
 * Durable Phase18 persistence (§4, §16, §23).
 *
 * Every method that changes durable state takes the lease, and every one of
 * them revalidates the account's current generation against it inside the same
 * transaction. A stale worker therefore cannot commit anything, anywhere, on
 * any path — that guarantee lives in the adapter's SQL, not in this interface's
 * documentation.
 */
export interface LiveReconciliationRepository {
  /** Reads the barrier row. An absent account reads as RECONCILIATION_REQUIRED. */
  loadState(accountId: string): Promise<LiveReconciliationStateRecord>;

  /** Mints an opaque HEALTHY authority only from the current durable row. */
  authorizeCurrentHealthy(accountId: string, runtimeIdentity: unknown): Promise<{
    readonly state: LiveReconciliationStateRecord;
    readonly authorization: unknown | null;
  }>;

  /**
   * Durably claims the next generation for this account. Exactly one concurrent
   * caller wins, enforced by `UNIQUE(account_id, generation)`.
   */
  claimGeneration(accountId: string, runtimeIdentity: unknown, nowMs: number): Promise<LiveReconciliationClaimOutcome>;

  /** Records the validated snapshot identity against the owning run. */
  recordSnapshot(lease: LiveReconciliationLease, snapshotSha256: string, endedAtMs: number, completeness: {
    readonly validated: boolean;
    readonly ordersComplete: boolean;
    readonly positionsComplete: boolean;
  }): Promise<void>;

  /**
   * Upserts findings by deterministic content identity. A finding already
   * present for this account has its `last_seen_generation` advanced rather
   * than being inserted twice (§16).
   */
  persistFindings(lease: LiveReconciliationLease, findings: readonly LiveReconciliationFinding[], nowMs: number): Promise<readonly LiveReconciliationFindingRecord[]>;

  /**
   * Completes the run and publishes the resulting account status. Refuses with
   * `LIVE_RECONCILIATION_STALE_GENERATION` if a newer generation took ownership.
   */
  completeRun(lease: LiveReconciliationLease, completionProof: unknown, nowMs: number): Promise<LiveReconciliationStateRecord>;

  /** Records/refreshes an orphan venue order observation. Never adopts it. */
  recordOrphanOrder(lease: LiveReconciliationLease, order: LiveVenueOrderEvidence, nowMs: number): Promise<LiveOrphanVenueOrderRecord>;

  /**
   * Durably claims the right to send exactly one cancel for this orphan, BEFORE
   * the wire call. An already-claimed or ambiguous orphan is never reclaimed.
   */
  claimOrphanCancellation(lease: LiveReconciliationLease, authorization: unknown, exchangeOrderId: string, nowMs: number): Promise<LiveOrphanCancelClaimOutcome>;

  /**
   * [P18 Wave A2 / F18-14] Durably proves an orphan-cancel wire request MAY be
   * about to leave this process. RUNNING-fenced exactly like every other
   * reconciliation write, and must commit BEFORE the gateway is ever called.
   */
  armOrphanCancelWire(lease: LiveReconciliationLease, authorization: unknown, exchangeOrderId: string, generation: number): Promise<LiveOrphanVenueOrderRecord>;

  /**
   * [P18 Wave A2 / F18-14] Crash recovery for a CLAIMED orphan cancellation
   * that was never armed: local proof alone shows the wire request could not
   * possibly have been sent, so this restores `cancelState` to `NONE` with
   * zero exchange mutation. Refuses (as `NOT_CLAIMABLE`) an armed claim — that
   * one's outcome is unestablished and must be resolved through
   * `completeOrphanCancellation(..., 'CANCEL_AMBIGUOUS', ...)` instead.
   */
  reclaimUnarmedOrphanCancelClaim(lease: LiveReconciliationLease, authorization: unknown, exchangeOrderId: string, generation: number): Promise<LiveOrphanVenueOrderRecord>;

  /** Records the outcome of the single claimed cancellation attempt. */
  completeOrphanCancellation(
    lease: LiveReconciliationLease,
    authorization: unknown,
    exchangeOrderId: string,
    generation: number,
    outcome: 'CANCEL_ACKNOWLEDGED' | 'CANCEL_AMBIGUOUS' | 'CANCEL_REJECTED',
    faultCode: string | null,
  ): Promise<LiveOrphanVenueOrderRecord>;

  loadOrphanOrders(accountId: string): Promise<readonly LiveOrphanVenueOrderRecord[]>;

  /**
   * [P18 Wave C1 / F18-06] Durably resolves one `CANCEL_AMBIGUOUS` orphan
   * cancellation via an explicit, audited operator decision. Deliberately
   * takes NO `LiveReconciliationLease`/reconciliation authorization: this is
   * a separate recovery path from machine reconciliation, may run whether or
   * not live-mutation authorization is currently available (§F18-27/F18-28
   * are entirely unaffected), and its own authority — `request` — is bound to
   * one exact orphan and one exact expected revision at mint time (see
   * `orphan-resolution.ts`). Refuses a stale revision, a non-ambiguous
   * current state, or a request that is not a genuine instance. Never
   * infers resolution from venue absence, a restart, or a generation change.
   */
  resolveOrphanCancelAmbiguity(
    request: OrphanAmbiguityResolutionRequest,
    nowMs: number,
  ): Promise<{ readonly resolution: LiveOrphanCancelResolutionRecord; readonly orphan: LiveOrphanVenueOrderRecord }>;

  /** Every durable resolution audit row for one orphan, oldest first. Never mutated, only appended to. */
  loadOrphanCancelResolutions(accountId: string, exchangeOrderId: string): Promise<readonly LiveOrphanCancelResolutionRecord[]>;

  /**
   * Replaces the proven ownership shares for one (account, pair) as one atomic
   * set, and materializes the Phase17 `live_position` record only where exactly
   * one owner provably holds the entire venue aggregate.
   */
  applyPositionOwnership(
    lease: LiveReconciliationLease,
    authorization: unknown,
    input: {
      readonly pair: string;
      readonly shares: readonly LivePositionOwnershipShareInput[];
      readonly instrumentSpecSnapshotId: string | null;
      readonly materializeSingleOwner: boolean;
      readonly nowMs: number;
    },
  ): Promise<readonly LivePositionOwnershipShareRecord[]>;

  /** Removes durable ownership for a pair the venue proves is flat. */
  clearPositionOwnership(lease: LiveReconciliationLease, authorization: unknown, pair: string): Promise<void>;

  loadOwnershipShares(accountId: string, pair: string): Promise<readonly LivePositionOwnershipShareRecord[]>;

  /** Reads the Phase17 durable CLOSE ownership record, unchanged. */
  loadLivePosition(accountId: string, pair: string): Promise<LivePositionOwnershipRecord | null>;

  /** Blocking findings still asserted by the account's current generation. */
  countCurrentBlockingFindings(accountId: string, generation: number): Promise<number>;
}

export interface LivePositionOwnershipShareInput {
  readonly ownerStrategyInstanceId: string;
  readonly side: 'LONG' | 'SHORT';
  readonly quantity: string;
  readonly ownerStrategyId: string;
  readonly ownerStrategyVersion: string;
  readonly ownerParameterHash: string;
  readonly venuePositionId: string | null;
  readonly lineageSha256: string;
  readonly lineageIntentIds: readonly string[];
  readonly instrumentSpecSnapshotId: string;
}

/**
 * Durable Phase17 order facts reconciliation reads (read-only view).
 *
 * Reconciliation never queries `live_order` directly: it goes through this
 * port so the Phase17 repository stays the one place that re-proves the sealed
 * intent digest and the immutable order mirrors on every authoritative read
 * (§8 "do not directly mutate projections around Phase17's verified repository
 * invariants").
 */
export interface LiveDurableOrderView {
  readonly intentId: string;
  readonly clientOrderId: string;
  readonly accountId: string;
  readonly pair: string;
  readonly state: string;
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
  readonly cancelState: string;
  readonly strategyInstanceId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly instrumentSpecSnapshotId: string;
  readonly positionInstanceId: string | null;
  readonly reduceOnlyQuantity: string | null;
  /** Local time the intent was durably recorded — the submission window lower bound. */
  readonly createdAtMs: number;
  /** Local time the projection last changed — the submission window upper bound. */
  readonly updatedAtMs: number;
  /** [P18 Wave A2 / F18-14] See `LiveOrderStateRecord.dispatchWireArmed`. */
  readonly dispatchWireArmed: boolean;
  /** [P18 Wave A2 / F18-14] See `LiveOrderStateRecord.cancelWireArmed`. */
  readonly cancelWireArmed: boolean;
  readonly revision: number;
}

export interface LiveDurableOrderReader {
  /** Every durable order for the account, verified by the Phase17 repository. */
  listAccountOrders(accountId: string): Promise<readonly LiveDurableOrderView[]>;
}
