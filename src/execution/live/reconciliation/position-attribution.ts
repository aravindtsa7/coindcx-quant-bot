/**
 * Authoritative live-position establishment and attribution (§10, §11).
 *
 * Pure: no I/O, no clock, no persistence.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE:
 *
 *   An exchange aggregate position alone does NOT prove strategy-instance
 *   ownership.
 *
 * CoinDCX reports one net position per pair. It does not report which strategy
 * opened it, and nothing in the venue contract ever will. So ownership is
 * derived in exactly one direction: from local, Phase17-verified, accepted
 * fill lineage upward to a claimed quantity — and that claim is then required
 * to reconcile EXACTLY to the venue aggregate before any of it is durable.
 *
 * What is deliberately impossible here:
 *   - assigning an aggregate to a strategy because it is the only one asking;
 *   - assigning a residual to the nearest owner;
 *   - closing a gap with a tolerance band;
 *   - inferring a position from an order that never provably filled.
 *
 * When attribution fails, exposure becomes an explicit unattributed/conflicting
 * finding and CLOSE stays fail-closed through Phase17's existing
 * `LIVE_POSITION_NOT_AVAILABLE` refusal, because no `live_position` row is
 * written.
 */
import { sha256CanonicalJson } from '../../../risk';
import { canonicalLiveDecimalString, liveDecimal, type LiveCalc } from '../decimal';
import type { LivePositionOwnershipRecord } from '../repository';
import { buildFinding } from './findings';
import type { LiveDurableOrderView, LivePositionOwnershipShareInput } from './ports';
import type { LiveReconciliationFinding, LiveVenueEvidenceSet, LiveVenuePositionEvidence } from './types';

/**
 * Signed exposure contributed by one durable order's accepted fills.
 *
 * A BUY adds, a SELL subtracts — for OPEN and CLOSE alike, because a CLOSE of a
 * long IS a sell and must reduce the same aggregate it is closing. Using the
 * exchange-side direction rather than the OPEN/CLOSE action is what makes this
 * correct without a special case per action.
 */
export function signedFillContribution(order: LiveDurableOrderView): LiveCalc {
  const filled = liveDecimal(canonicalLiveDecimalString(order.cumulativeFilledQuantity, 'cumulativeFilledQuantity'));
  return order.side === 'BUY' ? filled : filled.negated();
}

/** One strategy instance's provable signed share of a pair's exposure. */
export interface ProvenOwnershipShare {
  readonly ownerStrategyInstanceId: string;
  readonly ownerStrategyId: string;
  readonly ownerStrategyVersion: string;
  readonly ownerParameterHash: string;
  readonly instrumentSpecSnapshotId: string;
  /** Signed: positive LONG, negative SHORT. */
  readonly signedQuantity: string;
  /** Intent ids of every durable order whose fills compose this share. */
  readonly lineageIntentIds: readonly string[];
  readonly lineageSha256: string;
}

/**
 * Deterministic proof identity of one ownership share. Recomputed on every run
 * from the same inputs, so an unchanged proof produces an unchanged digest and
 * therefore no revision churn (§16).
 */
export function ownershipLineageSha256(input: {
  readonly accountId: string;
  readonly pair: string;
  readonly ownerStrategyInstanceId: string;
  readonly signedQuantity: string;
  readonly lineageIntentIds: readonly string[];
}): string {
  return sha256CanonicalJson({
    schema: 'P18_POSITION_OWNERSHIP_LINEAGE_V1',
    accountId: input.accountId,
    pair: input.pair,
    ownerStrategyInstanceId: input.ownerStrategyInstanceId,
    signedQuantity: canonicalLiveDecimalString(input.signedQuantity, 'signedQuantity'),
    lineageIntentIds: [...input.lineageIntentIds].sort(),
  });
}

/**
 * Groups a pair's durable orders into per-strategy-instance signed shares.
 *
 * Returns `null` when the lineage is internally incoherent — for example two
 * orders of the same strategy instance disagreeing on the strategy tuple or the
 * instrument snapshot they were validated against. That is a conflict, not a
 * thing to average out.
 */
export function deriveOwnershipShares(
  accountId: string,
  pair: string,
  orders: readonly LiveDurableOrderView[],
): { readonly shares: readonly ProvenOwnershipShare[] } | { readonly incoherentInstanceId: string; readonly reason: string } {
  const grouped = new Map<string, {
    strategyId: string;
    strategyVersion: string;
    parameterHash: string;
    instrumentSpecSnapshotId: string;
    total: LiveCalc;
    intentIds: string[];
  }>();

  for (const order of orders) {
    const contribution = signedFillContribution(order);
    const existing = grouped.get(order.strategyInstanceId);
    if (existing === undefined) {
      grouped.set(order.strategyInstanceId, {
        strategyId: order.strategyId,
        strategyVersion: order.strategyVersion,
        parameterHash: order.parameterHash,
        instrumentSpecSnapshotId: order.instrumentSpecSnapshotId,
        total: contribution,
        intentIds: [order.intentId],
      });
      continue;
    }
    if (existing.strategyId !== order.strategyId
      || existing.strategyVersion !== order.strategyVersion
      || existing.parameterHash !== order.parameterHash) {
      return { incoherentInstanceId: order.strategyInstanceId, reason: 'Durable orders for one strategy instance disagree on the strategy id/version/parameter tuple' };
    }
    if (existing.instrumentSpecSnapshotId !== order.instrumentSpecSnapshotId) {
      return { incoherentInstanceId: order.strategyInstanceId, reason: 'Durable orders for one strategy instance were validated against different instrument snapshots' };
    }
    existing.total = existing.total.plus(contribution);
    existing.intentIds.push(order.intentId);
  }

  const shares: ProvenOwnershipShare[] = [];
  for (const [ownerStrategyInstanceId, entry] of [...grouped.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    const signedQuantity = entry.total.toFixed();
    shares.push(Object.freeze({
      ownerStrategyInstanceId,
      ownerStrategyId: entry.strategyId,
      ownerStrategyVersion: entry.strategyVersion,
      ownerParameterHash: entry.parameterHash,
      instrumentSpecSnapshotId: entry.instrumentSpecSnapshotId,
      signedQuantity,
      lineageIntentIds: Object.freeze([...entry.intentIds].sort()),
      lineageSha256: ownershipLineageSha256({
        accountId, pair, ownerStrategyInstanceId, signedQuantity, lineageIntentIds: entry.intentIds,
      }),
    }));
  }
  return { shares: Object.freeze(shares) };
}

/** The proposed durable effect of reconciling one pair's position. */
export type LivePositionReconciliationEffect =
  | { readonly kind: 'NONE' }
  /** The venue proves flat and local lineage agrees: remove durable ownership. */
  | { readonly kind: 'CLEAR_OWNERSHIP'; readonly pair: string }
  /**
   * Exactly-proven ownership. `materializeSingleOwner` is true only where ONE
   * instance provably holds the ENTIRE venue aggregate, which is the only shape
   * Phase17's single-owner `live_position` record can honestly represent.
   */
  | {
      readonly kind: 'APPLY_OWNERSHIP';
      readonly pair: string;
      readonly shares: readonly LivePositionOwnershipShareInput[];
      readonly instrumentSpecSnapshotId: string | null;
      readonly materializeSingleOwner: boolean;
    };

export interface LivePositionReconciliationOutcome {
  readonly findings: readonly LiveReconciliationFinding[];
  readonly effects: readonly LivePositionReconciliationEffect[];
}

function positionOutcome(
  findings: readonly LiveReconciliationFinding[],
  effects: readonly LivePositionReconciliationEffect[] = [],
): LivePositionReconciliationOutcome {
  return Object.freeze({ findings: Object.freeze([...findings]), effects: Object.freeze([...effects]) });
}

export interface PositionReconciliationInput {
  readonly accountId: string;
  readonly pair: string;
  /** Every durable order for this account/pair, verified by the Phase17 repository. */
  readonly orders: readonly LiveDurableOrderView[];
  /** The venue aggregate for this pair, or `null` when the venue reports none. */
  readonly venuePosition: LiveVenuePositionEvidence | null;
  /** The existing Phase17 CLOSE ownership record, if any. */
  readonly durablePosition: LivePositionOwnershipRecord | null;
  readonly evidence: LiveVenueEvidenceSet;
  /**
   * Whether any order for this pair is itself unresolved. Ownership derived
   * from lineage that contains an unresolved order is not a proof, because the
   * unresolved order's true fill is by definition unknown.
   */
  readonly hasUnresolvedOrders: boolean;
}

/**
 * Reconciles one pair's position (§10, §11).
 *
 * Every economic mismatch is explicit and durable. Nothing is repaired to make
 * the database equal the exchange.
 */
export function reconcilePosition(input: PositionReconciliationInput): LivePositionReconciliationOutcome {
  const { accountId, pair, venuePosition, durablePosition, evidence } = input;
  const subject = { pair, venuePositionId: venuePosition?.venuePositionId ?? null };

  // A positions read that cannot prove completeness cannot establish an
  // aggregate, and an aggregate is the denominator of every ownership claim.
  if (!evidence.positionsProvenance.complete) {
    return positionOutcome([buildFinding({
      category: 'AMBIGUOUS',
      code: 'RECON_EVIDENCE_INCOMPLETE',
      subject,
      evidence: {
        reason: 'The provider position read could not prove it inspected everything, so no venue aggregate is established',
        incompleteReason: evidence.positionsProvenance.incompleteReason,
      },
    })]);
  }

  const venueSigned = venuePosition === null
    ? liveDecimal('0')
    : liveDecimal(canonicalLiveDecimalString(venuePosition.signedQuantity, 'signedQuantity'));

  const derived = deriveOwnershipShares(accountId, pair, input.orders);
  if ('incoherentInstanceId' in derived) {
    return positionOutcome([buildFinding({
      category: 'CONFLICT',
      code: 'RECON_POSITION_IDENTITY_MISMATCH',
      subject: { ...subject, strategyInstanceId: derived.incoherentInstanceId },
      evidence: { reason: derived.reason },
    })]);
  }

  const nonZeroShares = derived.shares.filter((share) => !liveDecimal(share.signedQuantity).isZero());
  const localSigned = derived.shares.reduce(
    (total, share) => total.plus(liveDecimal(share.signedQuantity)),
    liveDecimal('0'),
  );

  // ---- venue flat -------------------------------------------------------
  if (venueSigned.isZero()) {
    if (localSigned.isZero()) {
      const findings = [buildFinding({
        category: 'VERIFIED_MATCH',
        code: 'RECON_POSITION_VERIFIED_MATCH',
        subject,
        evidence: { reason: 'Durable lineage and the venue both report flat', pair },
      })];
      // A durable position row while both sides are flat is a stale artifact of
      // a CLOSE that completed before the local update. Clearing it is a proven
      // reconstruction, not a repair of conflicting economics.
      return durablePosition === null
        ? positionOutcome(findings)
        : positionOutcome(findings, [{ kind: 'CLEAR_OWNERSHIP', pair }]);
    }
    return positionOutcome([buildFinding({
      category: 'CONFLICT',
      code: 'RECON_POSITION_LOCAL_OPEN_VENUE_FLAT',
      subject,
      evidence: {
        reason: 'Local fill lineage proves exposure the venue does not hold',
        localSignedQuantity: localSigned.toFixed(),
        venueSignedQuantity: '0',
      },
    })]);
  }

  // ---- venue holds exposure ---------------------------------------------
  if (input.hasUnresolvedOrders) {
    return positionOutcome([buildFinding({
      category: 'AMBIGUOUS',
      code: 'RECON_POSITION_UNATTRIBUTED_EXPOSURE',
      subject,
      evidence: {
        reason: 'This pair has an unresolved order, so local fill lineage cannot prove ownership of the venue aggregate',
        venueSignedQuantity: venueSigned.toFixed(),
      },
    })]);
  }

  if (localSigned.isZero()) {
    return positionOutcome([buildFinding({
      category: 'CONFLICT',
      code: 'RECON_POSITION_UNATTRIBUTED_EXPOSURE',
      subject,
      evidence: {
        reason: 'The venue holds exposure that no local fill lineage claims; it is never assigned to a strategy',
        venueSignedQuantity: venueSigned.toFixed(),
      },
    })]);
  }

  if (!localSigned.equals(venueSigned)) {
    const sameDirection = localSigned.isNegative() === venueSigned.isNegative();
    const code = !sameDirection
      ? 'RECON_POSITION_DIRECTION_MISMATCH' as const
      : nonZeroShares.length > 1
        ? 'RECON_POSITION_OWNERSHIP_SUM_MISMATCH' as const
        : 'RECON_POSITION_QUANTITY_MISMATCH' as const;
    return positionOutcome([buildFinding({
      category: 'CONFLICT',
      code,
      subject,
      evidence: {
        reason: 'Proven local ownership does not reconcile exactly to the venue aggregate',
        localSignedQuantity: localSigned.toFixed(),
        venueSignedQuantity: venueSigned.toFixed(),
        shareCount: nonZeroShares.length,
      },
    })]);
  }

  // ---- exact reconciliation ---------------------------------------------
  const side = venueSigned.isNegative() ? 'SHORT' as const : 'LONG' as const;
  // Every share must point the same way as the aggregate. Offsetting shares
  // that happen to net correctly are NOT an attribution: one strategy would be
  // recorded as holding exposure opposite to the position it shares.
  const opposing = nonZeroShares.filter((share) => liveDecimal(share.signedQuantity).isNegative() !== venueSigned.isNegative());
  if (opposing.length > 0) {
    return positionOutcome([buildFinding({
      category: 'CONFLICT',
      code: 'RECON_POSITION_OWNERSHIP_SUM_MISMATCH',
      subject,
      evidence: {
        reason: 'Shares net to the venue aggregate only by offsetting opposite-direction exposure; that is not an attribution',
        opposingInstanceIds: opposing.map((share) => share.ownerStrategyInstanceId).sort(),
        venueSignedQuantity: venueSigned.toFixed(),
      },
    })]);
  }

  const snapshotIds = new Set(nonZeroShares.map((share) => share.instrumentSpecSnapshotId));
  if (snapshotIds.size !== 1) {
    return positionOutcome([buildFinding({
      category: 'CONFLICT',
      code: 'RECON_POSITION_IDENTITY_MISMATCH',
      subject,
      evidence: {
        reason: 'Owners of one venue position were validated against different instrument snapshots',
        instrumentSpecSnapshotIds: [...snapshotIds].sort(),
      },
    })]);
  }
  const instrumentSpecSnapshotId = [...snapshotIds][0]!;

  const shareInputs: readonly LivePositionOwnershipShareInput[] = Object.freeze(nonZeroShares.map((share) => Object.freeze({
    ownerStrategyInstanceId: share.ownerStrategyInstanceId,
    side,
    quantity: liveDecimal(share.signedQuantity).abs().toFixed(),
    ownerStrategyId: share.ownerStrategyId,
    ownerStrategyVersion: share.ownerStrategyVersion,
    ownerParameterHash: share.ownerParameterHash,
    venuePositionId: venuePosition?.venuePositionId ?? null,
    lineageSha256: share.lineageSha256,
    lineageIntentIds: share.lineageIntentIds,
    instrumentSpecSnapshotId: share.instrumentSpecSnapshotId,
  })));

  const singleOwner = nonZeroShares.length === 1;

  // An existing Phase17 ownership record must agree with what lineage proves,
  // or the disagreement is durable rather than overwritten.
  if (durablePosition !== null) {
    const proven = singleOwner ? shareInputs[0]! : null;
    const identityConflict = proven === null
      || durablePosition.side !== side
      || durablePosition.ownerStrategyInstanceId !== proven.ownerStrategyInstanceId
      || durablePosition.ownerStrategyId !== proven.ownerStrategyId
      || durablePosition.ownerStrategyVersion !== proven.ownerStrategyVersion
      || durablePosition.ownerParameterHash !== proven.ownerParameterHash
      || durablePosition.instrumentSpecSnapshotId !== proven.instrumentSpecSnapshotId;
    if (identityConflict) {
      return positionOutcome([buildFinding({
        category: 'CONFLICT',
        code: 'RECON_POSITION_IDENTITY_MISMATCH',
        subject: { ...subject, strategyInstanceId: durablePosition.ownerStrategyInstanceId },
        evidence: {
          reason: 'The durable Phase17 position record contradicts the ownership local lineage proves',
          durableSide: durablePosition.side,
          provenSide: side,
          durableOwnerStrategyInstanceId: durablePosition.ownerStrategyInstanceId,
          provenOwnerCount: nonZeroShares.length,
        },
      })]);
    }
    if (!liveDecimal(canonicalLiveDecimalString(durablePosition.ownedQuantity, 'ownedQuantity')).equals(liveDecimal(proven.quantity))) {
      return positionOutcome([buildFinding({
        category: 'CONFLICT',
        code: 'RECON_POSITION_QUANTITY_MISMATCH',
        subject: { ...subject, strategyInstanceId: durablePosition.ownerStrategyInstanceId },
        evidence: {
          reason: 'The durable Phase17 position quantity contradicts proven lineage',
          durableQuantity: durablePosition.ownedQuantity,
          provenQuantity: proven.quantity,
        },
      })]);
    }
  }

  if (singleOwner) {
    return positionOutcome(
      [buildFinding({
        category: durablePosition === null ? 'LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE' : 'VERIFIED_MATCH',
        code: durablePosition === null ? 'RECON_POSITION_OWNERSHIP_ESTABLISHED' : 'RECON_POSITION_VERIFIED_MATCH',
        subject: { ...subject, strategyInstanceId: shareInputs[0]!.ownerStrategyInstanceId },
        evidence: {
          side,
          quantity: shareInputs[0]!.quantity,
          lineageSha256: shareInputs[0]!.lineageSha256,
          lineageIntentIds: [...shareInputs[0]!.lineageIntentIds],
        },
      })],
      [{ kind: 'APPLY_OWNERSHIP', pair, shares: shareInputs, instrumentSpecSnapshotId, materializeSingleOwner: true }],
    );
  }

  // Several instances provably own exact shares that sum to the aggregate.
  // The exposure is fully attributed — there is no unknown venue exposure — but
  // Phase17's `live_position` is a SINGLE-owner record and cannot represent a
  // shared position without one owner falsely claiming the whole aggregate. So
  // the shares are recorded, `live_position` is deliberately NOT materialized,
  // and CLOSE for this pair stays fail-closed through Phase17's existing
  // `LIVE_POSITION_NOT_AVAILABLE` refusal.
  return positionOutcome(
    [buildFinding({
      category: 'LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE',
      code: 'RECON_POSITION_OWNERSHIP_SHARED',
      subject,
      evidence: {
        reason: 'Several strategy instances hold provable shares summing exactly to the venue aggregate; Phase17 CLOSE ownership stays unavailable for this pair',
        side,
        venueSignedQuantity: venueSigned.toFixed(),
        owners: shareInputs.map((share) => ({ ownerStrategyInstanceId: share.ownerStrategyInstanceId, quantity: share.quantity })),
      },
    })],
    [{ kind: 'APPLY_OWNERSHIP', pair, shares: shareInputs, instrumentSpecSnapshotId, materializeSingleOwner: false }],
  );
}
