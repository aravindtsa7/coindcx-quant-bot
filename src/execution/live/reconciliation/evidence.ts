/**
 * Evidence validation and snapshot identity (§5, §13, §14, §15).
 *
 * Pure: no I/O, no clock, no persistence. Everything here answers one
 * question — *is this set of provider observations allowed to be treated as
 * authoritative at all?* — before any comparison with durable state happens.
 *
 * THE TOCTOU LIMITATION IS NOT HIDDEN. CoinDCX exposes no atomic
 * multi-endpoint snapshot: the orders read and the positions read happen at
 * two different times, and the venue may move between them. This module makes
 * that explicit in three ways rather than pretending it away:
 *
 *   1. each read keeps its own `LiveEvidenceProvenance` window, so the two are
 *      never described as one instant;
 *   2. `assertCausalOrdering` rejects a provider event time that postdates the
 *      local read window, because an observation that claims to describe a
 *      moment after it was read cannot be part of that read's truth;
 *   3. `evidenceWindowIsSeparable` reports when the two windows overlap
 *      movement that could change the answer — and the reconciler refuses
 *      HEALTHY in exactly that case (`../service.ts`).
 *
 * Absence is never proof. `LiveEvidenceProvenance.complete` is the ONLY thing
 * that licenses the statement "this order does not exist at the venue", and it
 * is set only where pagination genuinely reached exhaustion (and only after at
 * least one real page request succeeded — Wave B2 / F18-22).
 *
 * [Wave B2 / F18-04 correction] `rawOrderSetSha256`/`rawPositionSetSha256`
 * (below) add a SEPARATE, later-stage check: the reconciliation service reads
 * each endpoint twice and requires the two reads to agree before trusting
 * either. That detects venue movement STILL VISIBLE in the second read. It is
 * NOT a snapshot-consistency or ABA-immunity proof — CoinDCX exposes no
 * mechanism that could make it one — and neither this module nor the service
 * describes it as such. See the digest functions' own docs and
 * `docs/PHASE18_RECONCILIATION.md` §6 for exactly what is and is not proven.
 */
import { sha256CanonicalJson } from '../../../risk';
import { canonicalLiveDecimalString, liveDecimal } from '../decimal';
import { LiveExecutionError } from '../errors';
import type {
  LiveEvidenceProvenance,
  LiveVenueEvidenceSet,
  LiveVenueOrderEvidence,
  LiveVenuePositionEvidence,
} from './types';

/** Identity of the Phase18 evidence contract. Changing the shape changes this. */
export const LIVE_EVIDENCE_SNAPSHOT_SCHEMA = 'P18_VENUE_EVIDENCE_V1';

function evidenceInvalid(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new LiveExecutionError('LIVE_RECONCILIATION_EVIDENCE_INVALID', message, { details });
}

/**
 * Exact-decimal conservation for one venue order (§15).
 *
 * The same arithmetic Phase17 froze — `filled = total - remaining - cancelled`
 * over exact Decimals, all operands mandatory and non-negative — re-applied at
 * the reconciliation boundary. A provider row that cannot satisfy it is not a
 * row to be tolerated with a fudge factor; there are no tolerance bands here.
 */
export function assertOrderEvidenceConservation(order: LiveVenueOrderEvidence): void {
  const total = liveDecimal(canonicalLiveDecimalString(order.orderedQuantity, 'orderedQuantity'));
  const filled = liveDecimal(canonicalLiveDecimalString(order.filledQuantity, 'filledQuantity'));
  const remaining = liveDecimal(canonicalLiveDecimalString(order.remainingQuantity, 'remainingQuantity'));
  const cancelled = liveDecimal(canonicalLiveDecimalString(order.cancelledQuantity, 'cancelledQuantity'));

  if (total.lessThanOrEqualTo(0)) {
    evidenceInvalid('Venue order evidence reports a non-positive ordered quantity', { exchangeOrderId: order.exchangeOrderId });
  }
  if (filled.isNegative() || remaining.isNegative() || cancelled.isNegative()) {
    evidenceInvalid('Venue order evidence reports a negative quantity operand', { exchangeOrderId: order.exchangeOrderId });
  }
  if (remaining.plus(cancelled).greaterThan(total)) {
    evidenceInvalid('Venue order evidence violates remaining + cancelled <= total', { exchangeOrderId: order.exchangeOrderId });
  }
  if (!filled.equals(total.minus(remaining).minus(cancelled))) {
    evidenceInvalid('Venue order evidence violates filled = total - remaining - cancelled', { exchangeOrderId: order.exchangeOrderId });
  }
  if (filled.greaterThan(0)) {
    if (order.averageFillPrice === null) {
      evidenceInvalid('Venue order evidence reports a positive fill without a cumulative average price', { exchangeOrderId: order.exchangeOrderId });
    }
    if (!liveDecimal(canonicalLiveDecimalString(order.averageFillPrice, 'averageFillPrice')).greaterThan(0)) {
      evidenceInvalid('Venue order evidence reports a non-positive average price for a positive fill', { exchangeOrderId: order.exchangeOrderId });
    }
  } else if (order.averageFillPrice !== null) {
    evidenceInvalid('Venue order evidence carries an average price while nothing filled', { exchangeOrderId: order.exchangeOrderId });
  }
}

/**
 * Causal ordering (§13).
 *
 * A provider event time strictly after the local read ENDED describes a moment
 * this read cannot have observed. Rather than silently accepting it (and then
 * treating it as fresher than durable truth), it fails closed. A small
 * allowance is NOT granted: clock skew between the venue and this host is real,
 * but tolerating it here would mean inventing a tolerance band the brief
 * forbids, so the reconciler instead treats such evidence as unusable and
 * blocks, which is the conservative direction.
 */
export function assertCausalOrdering(
  providerEventTimeMs: number,
  provenance: LiveEvidenceProvenance,
  subject: Readonly<Record<string, unknown>>,
): void {
  if (!Number.isSafeInteger(providerEventTimeMs) || providerEventTimeMs < 0) {
    evidenceInvalid('Venue evidence carries an unusable provider event time', subject);
  }
  if (providerEventTimeMs > provenance.localReadEndedAtMs) {
    evidenceInvalid('Venue evidence claims a provider event time after the read that produced it', {
      ...subject,
      providerEventTimeMs,
      localReadEndedAtMs: provenance.localReadEndedAtMs,
    });
  }
}

/** A read window must be internally coherent before anything inside it is trusted. */
export function assertProvenanceWellFormed(provenance: LiveEvidenceProvenance): void {
  if (!Number.isSafeInteger(provenance.localReadStartedAtMs) || !Number.isSafeInteger(provenance.localReadEndedAtMs)) {
    evidenceInvalid('Evidence provenance carries an unusable local read window', { source: provenance.source });
  }
  if (provenance.localReadEndedAtMs < provenance.localReadStartedAtMs) {
    evidenceInvalid('Evidence provenance ends before it starts', { source: provenance.source });
  }
  if (provenance.pagesRead < 0 || !Number.isSafeInteger(provenance.pagesRead)) {
    evidenceInvalid('Evidence provenance reports an unusable page count', { source: provenance.source });
  }
  if (provenance.complete && provenance.incompleteReason !== null) {
    evidenceInvalid('Evidence provenance claims completeness while naming an incompleteness reason', { source: provenance.source });
  }
  if (!provenance.complete && provenance.incompleteReason === null) {
    evidenceInvalid('Incomplete evidence provenance must name why completeness could not be proven', { source: provenance.source });
  }
}

/**
 * Duplicate detection (§14).
 *
 * The same venue id appearing twice is only safe when both records are
 * byte-identical after canonicalization. A conflicting duplicate means the
 * provider described one order two different ways inside a single logical
 * read, and no rule in this repository can choose between them.
 */
export function assertNoConflictingDuplicates(orders: readonly LiveVenueOrderEvidence[]): void {
  const seen = new Map<string, string>();
  for (const order of orders) {
    const digest = venueOrderContentSha256(order);
    const previous = seen.get(order.exchangeOrderId);
    if (previous !== undefined && previous !== digest) {
      evidenceInvalid('Venue evidence contains the same exchange order id with conflicting content', {
        exchangeOrderId: order.exchangeOrderId,
      });
    }
    seen.set(order.exchangeOrderId, digest);
  }
}

export function assertNoConflictingPositionDuplicates(positions: readonly LiveVenuePositionEvidence[]): void {
  const seen = new Map<string, string>();
  for (const position of positions) {
    const digest = venuePositionContentSha256(position);
    const previous = seen.get(position.venuePositionId);
    if (previous !== undefined && previous !== digest) {
      evidenceInvalid('Venue evidence contains the same position id with conflicting content', {
        venuePositionId: position.venuePositionId,
      });
    }
    seen.set(position.venuePositionId, digest);
  }
  const byPair = new Map<string, string>();
  for (const position of positions) {
    const existing = byPair.get(position.pair);
    if (existing !== undefined && existing !== position.venuePositionId) {
      // Two distinct venue position identities for one pair cannot be resolved
      // into a single authoritative aggregate without inventing a merge rule.
      evidenceInvalid('Venue evidence reports more than one position identity for a single pair', { pair: position.pair });
    }
    byPair.set(position.pair, position.venuePositionId);
  }
}

/** Canonical content digest of one venue order observation. Decimals canonicalized first. */
export function venueOrderContentSha256(order: LiveVenueOrderEvidence): string {
  return sha256CanonicalJson({
    schema: `${LIVE_EVIDENCE_SNAPSHOT_SCHEMA}_ORDER`,
    exchangeOrderId: order.exchangeOrderId,
    pair: order.pair,
    side: order.side,
    venueStatus: order.venueStatus,
    wireOrderType: order.wireOrderType,
    orderedQuantity: canonicalLiveDecimalString(order.orderedQuantity, 'orderedQuantity'),
    filledQuantity: canonicalLiveDecimalString(order.filledQuantity, 'filledQuantity'),
    remainingQuantity: canonicalLiveDecimalString(order.remainingQuantity, 'remainingQuantity'),
    cancelledQuantity: canonicalLiveDecimalString(order.cancelledQuantity, 'cancelledQuantity'),
    averageFillPrice: order.averageFillPrice === null ? null : canonicalLiveDecimalString(order.averageFillPrice, 'averageFillPrice'),
    price: order.price === null ? null : canonicalLiveDecimalString(order.price, 'price'),
    leverage: order.leverage === null ? null : canonicalLiveDecimalString(order.leverage, 'leverage'),
    providerCreatedAtMs: order.providerCreatedAtMs,
    providerEventTimeMs: order.providerEventTimeMs,
    clientOrderId: order.clientOrderId,
  });
}

export function venuePositionContentSha256(position: LiveVenuePositionEvidence): string {
  return sha256CanonicalJson({
    schema: `${LIVE_EVIDENCE_SNAPSHOT_SCHEMA}_POSITION`,
    venuePositionId: position.venuePositionId,
    pair: position.pair,
    signedQuantity: canonicalLiveDecimalString(position.signedQuantity, 'signedQuantity'),
    averageEntryPrice: position.averageEntryPrice === null ? null : canonicalLiveDecimalString(position.averageEntryPrice, 'averageEntryPrice'),
    leverage: position.leverage === null ? null : canonicalLiveDecimalString(position.leverage, 'leverage'),
    providerEventTimeMs: position.providerEventTimeMs,
  });
}

/**
 * Deterministic identity of a whole evidence set (§16).
 *
 * Order-insensitive: records are sorted by their own content digest, so the
 * same venue truth delivered in a different page order produces the same
 * snapshot id and therefore the same reconciliation outcome. Local read
 * windows are deliberately EXCLUDED — they are operational time, and including
 * them would make an otherwise identical rerun look like new evidence.
 */
export function evidenceSnapshotSha256(evidence: LiveVenueEvidenceSet): string {
  const orderDigests = evidence.orders.map(venueOrderContentSha256).sort();
  const positionDigests = evidence.positions.map(venuePositionContentSha256).sort();
  return sha256CanonicalJson({
    schema: LIVE_EVIDENCE_SNAPSHOT_SCHEMA,
    accountId: evidence.accountId,
    orders: orderDigests,
    positions: positionDigests,
    ordersComplete: evidence.ordersProvenance.complete,
    positionsComplete: evidence.positionsProvenance.complete,
  });
}

/**
 * Whether TWO read windows are separable enough for a HEALTHY verdict.
 *
 * The positions read must not START before the orders read ENDS (or vice
 * versa) while either side carries an observation whose provider time falls
 * inside the other's window — that is precisely the interval in which an order
 * could have filled into a position this run would then double count. When the
 * windows are strictly ordered and no observation straddles them, the pair of
 * reads is a usable conservative cut.
 *
 * [Wave B3 / F18-23 — WHICH windows to pass in, and why it matters] This
 * function itself is unchanged and pure; what changed is what the SERVICE
 * feeds it, and getting that wrong created a confirmed false-blocking bug.
 *
 * The reconciliation service's bracketed stability protocol
 * (`LiveReconciliationService#readStableVenueEvidence`, §F18-04) reads each
 * endpoint TWICE (`ordersA -> positionsA -> ordersB -> positionsB`) and
 * MERGES each kind's two provenance windows into one wide envelope spanning
 * the whole bracket (`[ordersA.start, ordersB.end]` for orders,
 * `[positionsA.start, positionsB.end]` for positions) — that merged envelope
 * is what `evidence.ordersProvenance`/`evidence.positionsProvenance` carry
 * for completeness accounting and persistence. Because the four reads
 * interleave, those two MERGED envelopes overlap by construction under any
 * real network latency: `positionsA` (inside the merged orders envelope's
 * span) necessarily starts before `ordersB` (the merged orders envelope's own
 * end) completes. Passing the merged envelopes to THIS function therefore
 * made `second.localReadStartedAtMs < first.localReadEndedAtMs` true on
 * essentially every real call, reporting non-separable and blocking a
 * perfectly clean, stable account as `RECON_EVIDENCE_CAUSALITY_VIOLATION` —
 * confirmed as a production-blocking regression, not merely a theoretical one.
 *
 * The fix is entirely at the CALL SITE: the service now passes the UNMERGED
 * provenance of the LAST read of each kind (`ordersB.provenance`,
 * `positionsB.provenance`) instead. Those two are genuinely, structurally
 * sequential — `ordersB` is fully awaited before `positionsB` begins, in the
 * same process, on the same clock — so they do not overlap by construction,
 * and this function's ORIGINAL invariant (no observation in the later read
 * postdates the boundary) is exactly what it always was designed to check,
 * now evaluated against reads that can actually satisfy it. The bracket's
 * EARLIER reads (`ordersA`, `positionsA`) already did their job upstream: the
 * stability comparison (`rawOrderSetSha256`/`rawPositionSetSha256`) already
 * proved `ordersA == ordersB` and `positionsA == positionsB` in CONTENT
 * before this function is ever reached, so re-checking timing against the
 * wider bracket here would be redundant even where it wasn't actively wrong.
 *
 * This is not a weakening: a genuinely late-arriving provider event time
 * (one that postdates `ordersB`'s or `positionsB`'s own read window) still
 * fails this check and still blocks. What changed is which two windows are
 * asked the question, not what answer counts as safe. This also does NOT
 * authorize any new cross-clock reasoning — both `ordersB` and `positionsB`
 * timestamps are stamped by the SAME local clock in the SAME process, exactly
 * as the original single-read design assumed; no venue-clock comparison is
 * introduced here.
 */
export function evidenceWindowIsSeparable(evidence: LiveVenueEvidenceSet): boolean {
  const orders = evidence.ordersProvenance;
  const positions = evidence.positionsProvenance;
  const first = orders.localReadEndedAtMs <= positions.localReadStartedAtMs ? orders : positions;
  const second = first === orders ? positions : orders;
  // Overlapping windows are never separable: neither read can be said to
  // describe a state the other already accounted for.
  if (second.localReadStartedAtMs < first.localReadEndedAtMs) return false;
  const boundary = first.localReadEndedAtMs;
  // Any observation in the LATER read whose provider event time falls before
  // the boundary is fine (it predates the cut). One that falls after the
  // boundary means the venue moved between the two reads.
  const laterObservations = second === positions
    ? evidence.positions.map((position) => position.providerEventTimeMs)
    : evidence.orders.map((order) => order.providerEventTimeMs);
  return laterObservations.every((time) => time <= boundary);
}

/**
 * The single gate every evidence set passes before it is compared with
 * anything. Throws `LIVE_RECONCILIATION_EVIDENCE_INVALID` on any structural,
 * conservation, identity, duplicate, or causality failure.
 *
 * Incompleteness is deliberately NOT a throw: an incomplete read is still
 * usable for the things it positively proves (an order it DID return exists),
 * it is only unusable as proof of absence. That distinction is enforced by the
 * reconciler, which consults `provenance.complete` at each absence decision.
 */
export function assertEvidenceSetUsable(evidence: LiveVenueEvidenceSet, expectedAccountId: string): void {
  if (evidence.accountId !== expectedAccountId) {
    evidenceInvalid('Venue evidence was produced for a different account than this reconciliation run', {
      expectedAccountId,
    });
  }
  assertProvenanceWellFormed(evidence.ordersProvenance);
  assertProvenanceWellFormed(evidence.positionsProvenance);
  if (!Number.isSafeInteger(evidence.evaluatedAtMs)) {
    evidenceInvalid('Evidence set carries an unusable evaluation time', { accountId: expectedAccountId });
  }

  assertNoConflictingDuplicates(evidence.orders);
  assertNoConflictingPositionDuplicates(evidence.positions);

  for (const order of evidence.orders) {
    assertOrderEvidenceConservation(order);
    assertCausalOrdering(order.providerEventTimeMs, evidence.ordersProvenance, { exchangeOrderId: order.exchangeOrderId });
    assertCausalOrdering(order.providerCreatedAtMs, evidence.ordersProvenance, { exchangeOrderId: order.exchangeOrderId });
    if (order.providerEventTimeMs < order.providerCreatedAtMs) {
      evidenceInvalid('Venue order evidence was updated before it was created', { exchangeOrderId: order.exchangeOrderId });
    }
  }
  for (const position of evidence.positions) {
    // Throws on malformed decimal syntax; a position that cannot be
    // canonicalized cannot participate in exact ownership arithmetic.
    canonicalLiveDecimalString(position.signedQuantity, 'signedQuantity');
    assertCausalOrdering(position.providerEventTimeMs, evidence.positionsProvenance, { venuePositionId: position.venuePositionId });
  }
}

/**
 * Raw (non-Decimal-canonicalizing) content digest of one venue order, used ONLY
 * for the snapshot-stability comparison (§F18-04), never for the persisted
 * snapshot identity. Deliberately does not parse or validate decimals: the
 * comparison must never throw on a malformed record mid-stability-check —
 * structural validity is `assertEvidenceSetUsable`'s job, run afterwards on
 * whichever read is finally chosen. Two reads of the SAME unchanged provider
 * record are expected to be byte-identical, so plain field equality is exactly
 * as strict as this check needs to be; any accidental formatting difference
 * simply reads as "unstable", which is the conservative direction.
 */
function rawOrderDigestInput(order: LiveVenueOrderEvidence): Readonly<Record<string, unknown>> {
  return {
    schema: `${LIVE_EVIDENCE_SNAPSHOT_SCHEMA}_ORDER_RAW`,
    exchangeOrderId: order.exchangeOrderId,
    pair: order.pair,
    side: order.side,
    venueStatus: order.venueStatus,
    orderedQuantity: order.orderedQuantity,
    filledQuantity: order.filledQuantity,
    remainingQuantity: order.remainingQuantity,
    cancelledQuantity: order.cancelledQuantity,
    averageFillPrice: order.averageFillPrice,
    price: order.price,
    wireOrderType: order.wireOrderType,
    leverage: order.leverage,
    providerCreatedAtMs: order.providerCreatedAtMs,
    providerEventTimeMs: order.providerEventTimeMs,
    clientOrderId: order.clientOrderId,
  };
}

function rawPositionDigestInput(position: LiveVenuePositionEvidence): Readonly<Record<string, unknown>> {
  return {
    schema: `${LIVE_EVIDENCE_SNAPSHOT_SCHEMA}_POSITION_RAW`,
    venuePositionId: position.venuePositionId,
    pair: position.pair,
    signedQuantity: position.signedQuantity,
    averageEntryPrice: position.averageEntryPrice,
    leverage: position.leverage,
    providerEventTimeMs: position.providerEventTimeMs,
  };
}

/**
 * Order-insensitive identity of a whole order READ, for the bracketed
 * repeated-read-AGREEMENT check only (§F18-04). Two reads that returned the
 * exact same set of records — regardless of page/array order — produce the
 * same digest; anything STILL VISIBLE as added, removed, or changed in the
 * second read produces a different one.
 *
 * [Wave B2 / F18-04 correction] Equal digests are NOT proof that nothing
 * happened between the two reads — only that whatever the venue reports NOW
 * (at the second read) matches what it reported THEN (at the first). A
 * record that appeared and fully reverted between the two reads (classic ABA)
 * produces the SAME digest both times and is invisible to this function by
 * construction. See `LiveReconciliationService#readStableVenueEvidence` for
 * the full accounting of what this can and cannot be used to conclude.
 */
export function rawOrderSetSha256(orders: readonly LiveVenueOrderEvidence[]): string {
  return sha256CanonicalJson({
    schema: `${LIVE_EVIDENCE_SNAPSHOT_SCHEMA}_ORDER_SET_RAW`,
    digests: orders.map((order) => sha256CanonicalJson(rawOrderDigestInput(order))).sort(),
  });
}

export function rawPositionSetSha256(positions: readonly LiveVenuePositionEvidence[]): string {
  return sha256CanonicalJson({
    schema: `${LIVE_EVIDENCE_SNAPSHOT_SCHEMA}_POSITION_SET_RAW`,
    digests: positions.map((position) => sha256CanonicalJson(rawPositionDigestInput(position))).sort(),
  });
}

/**
 * [Wave B / F18-04] Deterministic identity for an UNSTABLE snapshot attempt —
 * the best-effort evidence recorded when the bracketed reads never agreed
 * within the retry budget. Built from the same raw (non-Decimal-validating)
 * digests as the stability comparison itself, so it can never throw on a
 * malformed record the run is about to block on anyway.
 */
export function rawEvidenceSnapshotSha256(accountId: string, orders: readonly LiveVenueOrderEvidence[], positions: readonly LiveVenuePositionEvidence[]): string {
  return sha256CanonicalJson({
    schema: `${LIVE_EVIDENCE_SNAPSHOT_SCHEMA}_UNSTABLE_V1`,
    accountId,
    ordersDigest: rawOrderSetSha256(orders),
    positionsDigest: rawPositionSetSha256(positions),
  });
}

/**
 * Merges two provenance windows from the SAME source read twice, bracketing
 * an intermediate read of the other kind (§F18-04). The merged window spans
 * both reads; completeness is the conjunction, because a pair that agreed only
 * on what each partially managed to see proves nothing about the rest.
 */
export function mergeEvidenceProvenance(first: LiveEvidenceProvenance, second: LiveEvidenceProvenance): LiveEvidenceProvenance {
  const complete = first.complete && second.complete;
  return Object.freeze({
    source: first.source,
    localReadStartedAtMs: Math.min(first.localReadStartedAtMs, second.localReadStartedAtMs),
    localReadEndedAtMs: Math.max(first.localReadEndedAtMs, second.localReadEndedAtMs),
    complete,
    pagesRead: first.pagesRead + second.pagesRead,
    incompleteReason: complete ? null : (first.incompleteReason ?? second.incompleteReason ?? 'SNAPSHOT_BRACKET_INCOMPLETE'),
  });
}

/** Deduplicates identical records, having already proven no conflicting duplicate exists. */
export function dedupeOrderEvidence(orders: readonly LiveVenueOrderEvidence[]): readonly LiveVenueOrderEvidence[] {
  const byId = new Map<string, LiveVenueOrderEvidence>();
  for (const order of orders) byId.set(order.exchangeOrderId, order);
  return Object.freeze([...byId.values()]);
}

export function dedupePositionEvidence(positions: readonly LiveVenuePositionEvidence[]): readonly LiveVenuePositionEvidence[] {
  const byId = new Map<string, LiveVenuePositionEvidence>();
  for (const position of positions) byId.set(position.venuePositionId, position);
  return Object.freeze([...byId.values()]);
}
