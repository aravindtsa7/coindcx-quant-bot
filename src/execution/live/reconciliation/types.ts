/**
 * Phase18 reconciliation domain vocabulary.
 *
 * Like `../types.ts`, everything here is plain data and confers no capability.
 * Holding a `LiveVenueOrderEvidence` authorizes nothing: it is a *claim about*
 * the exchange, and only the evidence set that a genuine provider adapter
 * produced — carrying its own provenance and completeness proof — is ever
 * treated as authoritative.
 *
 * The central asymmetry this module encodes: absence is not proof. A local
 * order that does not appear in one provider response has NOT been proven not
 * to exist, and no type here can express "provably absent" without an explicit
 * completeness proof accompanying it.
 */

/**
 * Durable startup-barrier status for one account (§3).
 *
 * `RECONCILIATION_REQUIRED` is the state every account is in until a run of
 * THIS runtime proves otherwise. It is also what an absent durable row reads
 * as, so a database that has never seen an account fails closed rather than
 * defaulting open.
 */
export type LiveReconciliationStatusName =
  | 'RECONCILIATION_REQUIRED'
  | 'RUNNING'
  | 'HEALTHY'
  | 'UNHEALTHY'
  | 'MANUAL_REVIEW_REQUIRED';

export type LiveReconciliationRunStatusName =
  | 'RUNNING'
  | 'COMPLETED_HEALTHY'
  | 'COMPLETED_UNHEALTHY'
  | 'COMPLETED_MANUAL_REVIEW'
  | 'ABANDONED';

/**
 * The conservative classification taxonomy (§12).
 *
 * Only `VERIFIED_MATCH`, `SAFE_AUTHORITATIVE_ADVANCE` and
 * `LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE` are compatible with a
 * HEALTHY account. Everything else blocks live mutation, and none of them is
 * ever "repaired" by overwriting conflicting economic history.
 */
export type LiveReconciliationFindingCategoryName =
  /** Durable state and authoritative venue evidence agree exactly. */
  | 'VERIFIED_MATCH'
  /** Venue evidence proves a strictly forward, conservation-respecting advance. */
  | 'SAFE_AUTHORITATIVE_ADVANCE'
  /** Local state is behind but exactly one reconstruction is provable. */
  | 'LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE'
  /** Durable economics and venue economics genuinely disagree. */
  | 'CONFLICT'
  /** Venue holds an order or exposure with no proven local lineage. */
  | 'ORPHAN'
  /** Evidence is insufficient to establish any single result. */
  | 'AMBIGUOUS'
  /** A human must decide; no automatic resolution is safe. */
  | 'MANUAL_REVIEW_REQUIRED';

/** Categories that permit an account to be declared HEALTHY. */
export const NON_BLOCKING_FINDING_CATEGORIES: readonly LiveReconciliationFindingCategoryName[] = Object.freeze([
  'VERIFIED_MATCH',
  'SAFE_AUTHORITATIVE_ADVANCE',
  'LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE',
]);

export function isBlockingCategory(category: LiveReconciliationFindingCategoryName): boolean {
  return !NON_BLOCKING_FINDING_CATEGORIES.includes(category);
}

/** Durable claim state for an orphan-order cancellation attempt. */
export type LiveOrphanCancelStateName =
  | 'NONE'
  | 'CANCEL_CLAIMED'
  | 'CANCEL_ACKNOWLEDGED'
  | 'CANCEL_AMBIGUOUS'
  | 'CANCEL_REJECTED'
  /**
   * [P18 Wave C1 / F18-06] A durable `CANCEL_AMBIGUOUS` an operator has
   * explicitly, auditably resolved. See `LiveOrphanCancelResolutionRecord`
   * for the resolution itself, and `orphan-resolution.ts` for the
   * unforgeable request that may produce this transition. Deliberately
   * distinct from every other state — see the Prisma schema doc comment on
   * the equivalent database enum value for why.
   */
  | 'CANCEL_AMBIGUOUS_RESOLVED';

/**
 * [P18 Wave C1 / F18-06] What an operator resolving a durable
 * `CANCEL_AMBIGUOUS` orphan cancellation is asserting. See the equivalent
 * Prisma schema enum doc comment for the full rationale.
 */
export type LiveOrphanCancelResolutionOutcomeName = 'ACKNOWLEDGED_NO_RETRY' | 'CONFIRMED_CANCELLED';

// ---------------------------------------------------------------------------
// Evidence model (§13)
// ---------------------------------------------------------------------------

/**
 * Provenance of one provider read. Every field is explicit about WHOSE clock
 * it came from, because conflating venue time with local time is exactly how a
 * reconciliation declares a stale observation authoritative.
 */
export interface LiveEvidenceProvenance {
  /** Stable identity of the read that produced this evidence. */
  readonly source: 'COINDCX_FUTURES_ORDERS' | 'COINDCX_FUTURES_POSITIONS';
  /** Local monotonic-ish wall clock when the read STARTED. */
  readonly localReadStartedAtMs: number;
  /** Local wall clock when the read COMPLETED, after the last page. */
  readonly localReadEndedAtMs: number;
  /**
   * Whether the full result set was genuinely inspected (§14). `false` means
   * pagination was truncated or a page failed; absence of a record in an
   * incomplete read proves nothing.
   */
  readonly complete: boolean;
  /** How many provider pages were consumed. Audit only. */
  readonly pagesRead: number;
  /** Populated when completeness could not be established. */
  readonly incompleteReason: string | null;
}

/** One authoritative venue order observation, bound to its provenance. */
export interface LiveVenueOrderEvidence {
  readonly exchangeOrderId: string;
  readonly pair: string;
  readonly side: 'BUY' | 'SELL';
  /** Raw validated venue status lexeme. */
  readonly venueStatus: string;
  /** Exact fixed-point decimals. Never a JS number. */
  readonly orderedQuantity: string;
  readonly filledQuantity: string;
  readonly remainingQuantity: string;
  readonly cancelledQuantity: string;
  readonly averageFillPrice: string | null;
  readonly price: string | null;
  readonly wireOrderType: string;
  readonly leverage: string | null;
  /** Venue-supplied times, clearly labelled as provider clock. */
  readonly providerCreatedAtMs: number;
  readonly providerEventTimeMs: number;
}

/** One authoritative venue position observation. */
export interface LiveVenuePositionEvidence {
  /** Venue position identity when the provider supplies one. */
  readonly venuePositionId: string;
  readonly pair: string;
  /**
   * Signed exact quantity: positive LONG, negative SHORT, zero flat. Kept
   * signed so a direction mismatch is a value comparison, not an enum guess.
   */
  readonly signedQuantity: string;
  readonly averageEntryPrice: string | null;
  readonly leverage: string | null;
  readonly providerEventTimeMs: number;
}

/**
 * The complete evidence set one reconciliation run evaluated.
 *
 * CoinDCX exposes no atomic multi-endpoint snapshot, so this is NOT a
 * consistent cut of venue state — it is two reads at two different times. That
 * limitation is represented explicitly rather than hidden: `ordersProvenance`
 * and `positionsProvenance` keep their own windows, and the reconciler refuses
 * HEALTHY wherever movement between those windows could change the answer.
 */
export interface LiveVenueEvidenceSet {
  readonly accountId: string;
  readonly orders: readonly LiveVenueOrderEvidence[];
  readonly positions: readonly LiveVenuePositionEvidence[];
  readonly ordersProvenance: LiveEvidenceProvenance;
  readonly positionsProvenance: LiveEvidenceProvenance;
  /** Local time the reconciler began evaluating this set. */
  readonly evaluatedAtMs: number;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** The subject a finding is about. Every field is optional identity, never economics. */
export interface LiveReconciliationFindingSubject {
  readonly pair: string | null;
  readonly intentId: string | null;
  readonly exchangeOrderId: string | null;
  readonly venuePositionId: string | null;
  readonly strategyInstanceId: string | null;
}

/**
 * One reconciliation fact, before it is persisted.
 *
 * `evidence` is sanitized structured metadata only (§21): identities, exact
 * decimal strings, state names and counts. No provider payload, no header, no
 * credential-shaped key — `LiveExecutionError`'s credential-free rule is
 * applied to it before it is ever written or logged.
 */
export interface LiveReconciliationFinding {
  readonly category: LiveReconciliationFindingCategoryName;
  /** Stable taxonomy code naming the exact detection point. */
  readonly code: LiveReconciliationFindingCode;
  readonly subject: LiveReconciliationFindingSubject;
  readonly evidence: Readonly<Record<string, unknown>>;
}

/**
 * Every Phase18 detection point, each raised from exactly one place so an
 * operator can name the refusal without reading application state.
 */
export type LiveReconciliationFindingCode =
  // --- evidence integrity (§5, §13, §14) -----------------------------------
  /** A provider order/position read could not prove it inspected everything. */
  | 'RECON_EVIDENCE_INCOMPLETE'
  /** Two venue records share an id but disagree on content. */
  | 'RECON_EVIDENCE_DUPLICATE_CONFLICT'
  /** Provider timestamps violate causal ordering against the read window. */
  | 'RECON_EVIDENCE_CAUSALITY_VIOLATION'
  /** Venue evidence failed conservation arithmetic at the boundary. */
  | 'RECON_EVIDENCE_CONSERVATION_VIOLATION'
  /** Evidence arrived for an account/pair this run did not request. */
  | 'RECON_EVIDENCE_IDENTITY_MISMATCH'
  /**
   * [Wave B / F18-04] Repeated authoritative reads could not prove a stable
   * venue snapshot within the bounded retry budget. CoinDCX exposes no atomic
   * multi-endpoint snapshot, so absence of a contradictory timestamp is never
   * treated as proof nothing moved; only a matching bracketed re-read is.
   */
  | 'RECON_EVIDENCE_SNAPSHOT_UNSTABLE'
  // --- crash-claim recovery (§F18-14, Wave A2) -----------------------------
  /** A local-only dispatch reservation survived a restart unarmed; safely reclaimed to CREATED. */
  | 'RECON_DISPATCH_RESERVATION_RECLAIMED'
  /** A local-only cancel reservation survived a restart unarmed; safely reclaimed to NONE. */
  | 'RECON_CANCEL_RESERVATION_RECLAIMED'
  // --- order reconciliation (§6, §7, §8) -----------------------------------
  | 'RECON_ORDER_VERIFIED_MATCH'
  /** Venue proves a strictly forward fill/terminal advance; applied exactly once. */
  | 'RECON_ORDER_ADVANCED_FROM_VENUE'
  /** A locally active order is absent from a COMPLETE venue read. */
  | 'RECON_ORDER_ABSENT_FROM_VENUE'
  /** A locally active order is absent from an INCOMPLETE read: proves nothing. */
  | 'RECON_ORDER_ABSENCE_UNPROVEN'
  /** Durable economics and venue economics genuinely disagree. */
  | 'RECON_ORDER_ECONOMICS_CONFLICT'
  /** Venue state contradicts a terminal local state. */
  | 'RECON_ORDER_STATE_CONFLICT'
  /** Applying venue evidence would regress cumulative fill. */
  | 'RECON_ORDER_FILL_REGRESSION'
  /**
   * [Wave B2 / F18-20] Venue evidence proved a forward advance (or resolved an
   * outstanding cancel claim) for an order ALREADY bound to a venue id, but the
   * provider order read could not prove it inspected everything this run. The
   * economic effect is withheld entirely — no fill, state, or cancel-claim
   * change is persisted — even though this exact record was found.
   */
  | 'RECON_ORDER_ADVANCE_WITHHELD_INCOMPLETE_EVIDENCE'
  // --- ambiguous create resolution (§6) ------------------------------------
  /** Exactly one venue order matched every immutable economic binding. */
  | 'RECON_AMBIGUOUS_CREATE_RESOLVED'
  /** More than one venue candidate matched; never choose the closest. */
  | 'RECON_AMBIGUOUS_CREATE_MULTIPLE_CANDIDATES'
  /** No candidate, and a complete read proves the create never landed. */
  | 'RECON_AMBIGUOUS_CREATE_PROVEN_ABSENT'
  /** No candidate, but non-existence cannot be proven. */
  | 'RECON_AMBIGUOUS_CREATE_UNRESOLVED'
  /**
   * [Wave B2 / F18-21] A local identity-bearing execution field (e.g.
   * time-in-force) cannot be proven by the CoinDCX evidence contract for ANY
   * candidate, so automatic resolution is refused regardless of candidate
   * count. Structural, not evidentiary: no amount of re-reading changes it.
   */
  | 'RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE'
  // --- cancellation ambiguity (§7) -----------------------------------------
  | 'RECON_CANCEL_RESOLVED_FROM_VENUE'
  | 'RECON_CANCEL_UNRESOLVED'
  // --- orphans (§9) --------------------------------------------------------
  /** An active venue order with no proven local lineage. */
  | 'RECON_ORPHAN_VENUE_ORDER'
  /** Orphan cleanup is configured off, or this account is not allowlisted. */
  | 'RECON_ORPHAN_CLEANUP_DISABLED'
  /** An orphan cancellation attempt has an unestablished outcome. */
  | 'RECON_ORPHAN_CANCEL_AMBIGUOUS'
  /**
   * [P18 Wave C1 / F18-06] An exchange order id previously resolved by an
   * operator (its ambiguous cancellation was durably acknowledged) is active
   * at the venue again. Stronger than a plain `RECON_ORPHAN_VENUE_ORDER`: the
   * prior resolution does not apply to this new observation, automatic
   * cancellation is never retried, and this is always treated as requiring
   * fresh human review.
   */
  | 'RECON_ORPHAN_REAPPEARED_AFTER_RESOLUTION'
  // --- positions (§10, §11) ------------------------------------------------
  | 'RECON_POSITION_VERIFIED_MATCH'
  /** Local lineage proves exactly one owner of the whole venue aggregate. */
  | 'RECON_POSITION_OWNERSHIP_ESTABLISHED'
  /** Proven shares sum exactly to the aggregate but more than one owner holds it. */
  | 'RECON_POSITION_OWNERSHIP_SHARED'
  /** Venue holds exposure that local lineage cannot attribute. */
  | 'RECON_POSITION_UNATTRIBUTED_EXPOSURE'
  /** Proven shares do not sum to the venue aggregate. */
  | 'RECON_POSITION_OWNERSHIP_SUM_MISMATCH'
  /** Durable position quantity disagrees with the venue aggregate. */
  | 'RECON_POSITION_QUANTITY_MISMATCH'
  /** Durable position direction disagrees with the venue aggregate. */
  | 'RECON_POSITION_DIRECTION_MISMATCH'
  /** Durable position identity/ownership tuple disagrees with proven lineage. */
  | 'RECON_POSITION_IDENTITY_MISMATCH'
  /** Local believes a position is open; a complete venue read shows flat. */
  | 'RECON_POSITION_LOCAL_OPEN_VENUE_FLAT';
