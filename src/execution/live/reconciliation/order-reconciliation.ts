/**
 * Order reconciliation, ambiguous-create resolution, cancellation recovery and
 * orphan detection (§6, §7, §8, §9).
 *
 * Pure: no I/O, no clock, no persistence. It consumes already-validated venue
 * evidence plus verified durable order state and returns findings and PROPOSED
 * durable effects. Nothing here writes; `../reconciliation/service.ts` applies
 * the proposals through the Phase17 repository so every Phase17 durable-
 * integrity invariant (sealed intent digest, immutable order mirrors,
 * revision-guarded commit, append-only observation dedup) still holds.
 *
 * THE MATCHING RULE THAT MATTERS MOST (§6):
 *
 * The deterministic client order id is now sent on every create as CoinDCX's
 * `client_order_id`, which CoinDCX support has confirmed is supported,
 * limited to 36 characters, and idempotent (a second create with the same id
 * fails). The List Orders read returns that field. So an ambiguous create has
 * exactly ONE automatic resolution path: a COMPLETE provider read containing
 * EXACTLY ONE venue order whose `client_order_id` is byte-identical to the
 * local id, whose observable economics agree, and which no other local order
 * claims (`resolveAmbiguousCreateByClientOrderId`). That establishes ORDER
 * identity only; it never establishes account continuity.
 *
 * Every other case keeps the pre-existing fail-closed rule: with no
 * `client_order_id` match (for example an order created before the id was
 * sent, whose venue record carries `null`), resolution by economics alone is
 * refused outright by the time-in-force identity gate
 * (`ambiguousCreateIdentityUnobservableReason`), exactly as before. Zero
 * matches, two matches, a match another local order claims, an economically
 * conflicting match, or an incomplete provider read all leave the order
 * reconciliation-required. There is no "closest match", no normalization of
 * ids, no scoring, and no probability anywhere in this file.
 */
import { sha256CanonicalJson } from '../../../risk';
import { canonicalLiveDecimalString, liveDecimal } from '../decimal';
import type { LiveOrderObservation, LiveOrderObservationKind, LiveOrderStateName } from '../types';
import { buildFinding } from './findings';
import type { LiveDurableOrderView } from './ports';
import type {
  LiveReconciliationFinding,
  LiveVenueEvidenceSet,
  LiveVenueOrderEvidence,
} from './types';

/**
 * Durable Phase17 states whose order is still live at the venue as far as local
 * truth knows, and therefore must be accounted for in venue evidence.
 */
const LOCALLY_ACTIVE_STATES: readonly string[] = Object.freeze([
  'DISPATCH_RESERVED',
  'ACKNOWLEDGED',
  'PARTIALLY_FILLED',
  'CANCEL_REQUESTED',
]);

/** Durable states Phase17 considers settled with no further venue expectation. */
const LOCALLY_TERMINAL_STATES: readonly string[] = Object.freeze([
  'FILLED',
  'CANCELLED',
  'REJECTED',
]);

/** Venue statuses that mean the order still rests on the book. */
const VENUE_OPEN_STATUSES: readonly string[] = Object.freeze([
  'open',
  'initial',
  'partially_filled',
]);

/**
 * The Phase18-owned resolution relation (§6, §7).
 *
 * Phase17's `LIVE_ORDER_TRANSITIONS` is frozen and stays frozen — Phase18 does
 * not widen it. This is a SEPARATE, explicitly reconciliation-scoped relation
 * naming the only durable advances an authoritative venue proof may produce.
 * Every entry requires a complete, causally-ordered, conservation-checked
 * observation; none of them is reachable from local inference.
 */
export const LIVE_RECONCILIATION_TRANSITIONS: Readonly<Record<string, readonly LiveOrderStateName[]>> = Object.freeze({
  // An ambiguous create resolved by a unique venue proof adopts whatever the
  // venue actually says — including REJECTED, which is a real outcome.
  SUBMISSION_AMBIGUOUS: Object.freeze<LiveOrderStateName[]>([
    'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED',
  ]),
  // A create claim that crashed before its response is resolved the same way.
  DISPATCH_RESERVED: Object.freeze<LiveOrderStateName[]>([
    'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED',
  ]),
  ACKNOWLEDGED: Object.freeze<LiveOrderStateName[]>(['PARTIALLY_FILLED', 'FILLED', 'CANCELLED']),
  PARTIALLY_FILLED: Object.freeze<LiveOrderStateName[]>(['PARTIALLY_FILLED', 'FILLED', 'CANCELLED']),
  // Deliberately NOT widened to `ACKNOWLEDGED`: the frozen Phase17
  // `LIVE_ORDER_TRANSITIONS['CANCEL_REQUESTED']` (`state-machine.ts`) has no
  // path back to `ACKNOWLEDGED` either, and every effect this table's targets
  // eventually reach `applyLiveOrderObservation`/`applyObservationAtomically`,
  // which enforces THAT frozen table, not this one. "Venue proves the order
  // still rests unaffected" is therefore resolved as a claim-only effect
  // (`CLEAR_CANCEL_CLAIM`, §F18-14) that never asks the observation pipeline
  // to move `order.state` at all — see `reconcileIdentifiedOrder` below.
  CANCEL_REQUESTED: Object.freeze<LiveOrderStateName[]>(['PARTIALLY_FILLED', 'FILLED', 'CANCELLED']),
  // Terminal locally and terminal here. A contradiction is a CONFLICT finding,
  // never a durable rewrite of settled economic history.
  FILLED: Object.freeze<LiveOrderStateName[]>([]),
  CANCELLED: Object.freeze<LiveOrderStateName[]>([]),
  REJECTED: Object.freeze<LiveOrderStateName[]>([]),
  RECONCILIATION_REQUIRED: Object.freeze<LiveOrderStateName[]>([]),
  CREATED: Object.freeze<LiveOrderStateName[]>([]),
});

/** Maps a validated venue status to the Phase17 observation kind it proves. */
function observationKindForStatus(status: string, filledIsFull: boolean, filledIsPositive: boolean): LiveOrderObservationKind | null {
  switch (status) {
    case 'initial':
    case 'open':
      return 'ACKNOWLEDGED';
    case 'partially_filled':
      return filledIsFull ? 'FILL' : 'PARTIAL_FILL';
    case 'filled':
      return 'FILL';
    case 'cancelled':
    case 'partially_cancelled':
      return 'CANCELLED';
    case 'rejected':
      return filledIsPositive ? null : 'REJECTED';
    default:
      // `untriggered` and any future lexeme fail closed: Phase17 never modelled
      // conditional orders and Phase18 will not invent their semantics.
      return null;
  }
}

/** The durable state a venue observation would advance an order to. */
function projectedStateFor(kind: LiveOrderObservationKind, filledIsFull: boolean, filledIsPositive: boolean): LiveOrderStateName {
  switch (kind) {
    case 'ACKNOWLEDGED': return filledIsFull ? 'FILLED' : filledIsPositive ? 'PARTIALLY_FILLED' : 'ACKNOWLEDGED';
    case 'PARTIAL_FILL': return filledIsFull ? 'FILLED' : 'PARTIALLY_FILLED';
    case 'FILL': return 'FILLED';
    case 'CANCELLED': return filledIsFull ? 'FILLED' : 'CANCELLED';
    case 'REJECTED': return 'REJECTED';
    default: return 'RECONCILIATION_REQUIRED';
  }
}

/**
 * Converts authoritative venue evidence into a Phase17 observation for one
 * durable order. Returns `null` when the venue status has no Phase17 meaning,
 * which is a fail-closed condition rather than a default.
 */
export function observationFromEvidence(
  order: LiveDurableOrderView,
  evidence: LiveVenueOrderEvidence,
): LiveOrderObservation | null {
  const ordered = liveDecimal(canonicalLiveDecimalString(evidence.orderedQuantity, 'orderedQuantity'));
  const filled = liveDecimal(canonicalLiveDecimalString(evidence.filledQuantity, 'filledQuantity'));
  const kind = observationKindForStatus(evidence.venueStatus, filled.equals(ordered), filled.greaterThan(0));
  if (kind === null) return null;
  return Object.freeze({
    kind,
    clientOrderId: order.clientOrderId,
    // Only ever the VENUE's own value, and only when it is byte-identical to
    // the local id. A venue `null` (e.g. an order created before the id was
    // sent) stays null; it is never filled in with the local id.
    exchangeClientOrderId: evidence.clientOrderId !== null && evidence.clientOrderId === order.clientOrderId
      ? evidence.clientOrderId
      : null,
    exchangeOrderId: evidence.exchangeOrderId,
    pair: evidence.pair,
    side: evidence.side,
    cumulativeFilledQuantity: filled.toFixed(),
    orderedQuantity: ordered.toFixed(),
    averageFillPrice: filled.isZero() ? null : canonicalLiveDecimalString(evidence.averageFillPrice, 'averageFillPrice'),
    exchangeStatus: evidence.venueStatus,
    providerEventTimeMs: evidence.providerEventTimeMs,
  });
}

/** Exact decimal equality. Textually different but numerically equal values match. */
function exactlyEqual(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return liveDecimal(canonicalLiveDecimalString(left, 'value')).equals(liveDecimal(canonicalLiveDecimalString(right, 'value')));
}

/**
 * Does this venue order match every immutable economic binding of this local
 * intent that the CoinDCX futures contract actually establishes?
 *
 * Bound here: pair, side, ordered quantity, wire order type, limit price, and
 * leverage when the provider supplies it.
 *
 * NOT bound, and honestly so: **time in force**. The verified current futures
 * List Orders contract returns no time-in-force field (see
 * `wire-schemas.ts`), so Phase18 cannot bind it without inventing provider
 * evidence. Its absence only ever makes matching WIDER — more candidates, and
 * therefore more ambiguity and more refusals — never narrower, so the omission
 * cannot cause a wrong order to be adopted.
 */
export function matchesImmutableEconomics(order: LiveDurableOrderView, candidate: LiveVenueOrderEvidence): boolean {
  if (candidate.pair !== order.pair) return false;
  if (candidate.side !== order.side) return false;
  if (candidate.wireOrderType !== order.wireOrderType) return false;
  if (!exactlyEqual(candidate.orderedQuantity, order.orderedQuantity)) return false;
  // A LIMIT order must match its exact limit price. A local MARKET order
  // (price null) must not be matched to a venue order that carries one.
  if (!exactlyEqual(candidate.price, order.price)) return false;
  // Leverage binds only when BOTH sides state it. A provider that omits the
  // field has not contradicted the local value, and a local CLOSE binds none.
  if (order.leverage !== null && candidate.leverage !== null && !exactlyEqual(candidate.leverage, order.leverage)) {
    return false;
  }
  return true;
}

/**
 * [Wave B2 / F18-21, corrected Wave B3 / F18-21] Classifies whether automatic
 * ambiguous-create identity establishment is possible for this order's
 * time-in-force, against the verified CoinDCX evidence contract.
 *
 * `LiveVenueOrderEvidence` has no time-in-force field AT ALL: no authoritative
 * time-in-force field is documented in the verified CoinDCX futures List
 * Orders response contract available to this project. That is a statement
 * about the verified contract this project has evidence for, not a provable
 * claim about the provider's full, possibly-undocumented behavior under every
 * circumstance — this project has no way to prove a universal negative, and
 * does not need to: it treats TIF as unproven, which is sufficient to refuse
 * to trust it (§14: absence is never proof).
 *
 * [Wave B3 correction] Wave B2 exempted `UNSPECIFIED`/`GOOD_TILL_CANCEL` on
 * the theory that CoinDCX's documentation states GTC is the applied default
 * when `time_in_force` is omitted on the wire, so the two would be
 * indistinguishable AT THE VENUE. Independent review rejected that reasoning:
 * this project holds no AUTHORITATIVE, verified proof of that default
 * behavior strong enough to found a durable identity-binding decision on, and
 * "the documentation says so" is not the same evidentiary bar this repository
 * applies everywhere else (§14: absence is never proof; provider contracts are
 * trusted only to the extent independently verified). The correct rule is
 * unconditional: this evidence contract does not document a provable
 * time-in-force field for ANY local value, so time-in-force cannot license an
 * automatic identity claim for ANY local value, including `UNSPECIFIED` and
 * `GOOD_TILL_CANCEL`. There is no per-order distinction left to make — every
 * order's TIF is equally unproven against the verified contract — but the
 * function keeps taking `order` so a future,
 * genuinely authoritative provider mechanism (§F18-24) could reintroduce a
 * real distinction here without changing this function's shape or any call
 * site's contract.
 */
export function ambiguousCreateIdentityUnobservableReason(order: LiveDurableOrderView): string | null {
  void order;
  return 'TIME_IN_FORCE_UNOBSERVABLE';
}

/**
 * [Wave B / F18-08] Stricter than `matchesImmutableEconomics`. Used ONLY when
 * ESTABLISHING identity for an ambiguous create, never for checking an order
 * already bound to a proven `exchangeOrderId`.
 *
 * `matchesImmutableEconomics` treats an omitted venue leverage as "not
 * contradicted" — correct once identity is already proven by an exchange order
 * id, because absence cannot overturn a fact already established another way.
 * But identity ITSELF is what an ambiguous-create resolution is trying to
 * prove, and for that, absence must never substitute for a proof: a local
 * order with a known leverage cannot be said to EXACTLY match a venue
 * candidate that simply did not report leverage at all.
 *
 * [Wave B3 / F18-21] Deliberately does NOT also check time-in-force
 * observability: that check is unconditional (see
 * `ambiguousCreateIdentityUnobservableReason`) and lives ONE LEVEL UP, as its
 * own explicit, order-scoped gate in `resolveAmbiguousCreate`, checked before
 * this function is ever reached. Folding it in here too would make it
 * impossible to keep testing — and therefore keep CORRECT — the
 * candidate-selection logic below independently of the TIF gate, for the day
 * a genuinely authoritative TIF proof might exist. This function's only job
 * is: given that identity establishment is otherwise permitted, is this
 * candidate an exact economic match?
 */
export function matchesProvenEconomicsForAmbiguousCreate(order: LiveDurableOrderView, candidate: LiveVenueOrderEvidence): boolean {
  if (!matchesImmutableEconomics(order, candidate)) return false;
  // `matchesImmutableEconomics` only refuses a STATED contradiction; here a
  // local leverage with no venue-reported counterpart is refused too.
  if (order.leverage !== null && candidate.leverage === null) return false;
  return true;
}

/**
 * Was this venue order plausibly created by this local submission attempt?
 *
 * The local window is LOCAL time; `providerCreatedAtMs` is VENUE time. Those
 * are different clocks and this repository has no proof of their offset, so
 * this check is used ONLY as an additional necessary condition on an already
 * economically-unique candidate. It is never used to choose between two
 * economic matches — under clock skew that would be exactly the probabilistic
 * tie-break §6 forbids.
 */
export function withinSubmissionWindow(
  order: LiveDurableOrderView,
  candidate: LiveVenueOrderEvidence,
  toleranceMs: number,
): boolean {
  const lower = order.createdAtMs - toleranceMs;
  const upper = order.updatedAtMs + toleranceMs;
  return candidate.providerCreatedAtMs >= lower && candidate.providerCreatedAtMs <= upper;
}

/** One proposed durable effect of reconciling a single order. */
export type LiveOrderReconciliationEffect =
  /** Nothing to do: durable state and venue evidence already agree. */
  | { readonly kind: 'NONE' }
  /**
   * Fold this authoritative observation through Phase17's atomic observation
   * path. Idempotent by `UNIQUE(intent_id, observation_sha256)`.
   *
   * `clearsCancelClaim` is set only when this advance resolves an order whose
   * `cancelState` was `CANCEL_RESERVED`/`CANCEL_AMBIGUOUS` (§F18-14): the plain
   * observation path never touches `cancelState`, so without this the account
   * would stay durably blocked forever even after the order's economics were
   * correctly resolved. When set, the service applies the observation through
   * `commitReconciledState` instead, atomically resetting the cancel claim.
   */
  | { readonly kind: 'APPLY_OBSERVATION'; readonly intentId: string; readonly observation: LiveOrderObservation; readonly clearsCancelClaim?: boolean }
  /**
   * Resolve an ambiguous/unresolved create to a uniquely proven venue order,
   * then fold its observation. Only ever produced by `resolveAmbiguousCreate`.
   */
  | { readonly kind: 'RESOLVE_AMBIGUOUS_CREATE'; readonly intentId: string; readonly observation: LiveOrderObservation; readonly targetState: LiveOrderStateName }
  /**
   * [P18 Wave A2 / F18-14] Resolves an ambiguous or crash-recovered cancel
   * claim (`CANCEL_RESERVED`/`CANCEL_AMBIGUOUS`) whose authoritative venue
   * evidence proves the order still rests EXACTLY as before — no fill
   * progress, no cancellation. `order.state` is deliberately left untouched:
   * the frozen Phase17 `LIVE_ORDER_TRANSITIONS['CANCEL_REQUESTED']` has no
   * path back to `ACKNOWLEDGED`, and this effect never asks the observation
   * pipeline to attempt one. Only `cancelState` moves, to `NONE`, so the
   * account is not durably blocked forever by a claim evidence has already
   * conclusively resolved. Never a resend.
   */
  | { readonly kind: 'CLEAR_CANCEL_CLAIM'; readonly intentId: string };

export interface LiveOrderReconciliationOutcome {
  readonly findings: readonly LiveReconciliationFinding[];
  readonly effects: readonly LiveOrderReconciliationEffect[];
  /** Venue order ids this local order provably owns; used for orphan detection. */
  readonly claimedExchangeOrderIds: readonly string[];
}

function outcome(
  findings: readonly LiveReconciliationFinding[],
  effects: readonly LiveOrderReconciliationEffect[] = [],
  claimed: readonly string[] = [],
): LiveOrderReconciliationOutcome {
  return Object.freeze({
    findings: Object.freeze([...findings]),
    effects: Object.freeze([...effects]),
    claimedExchangeOrderIds: Object.freeze([...claimed]),
  });
}

/**
 * Deterministic proof identity of an ambiguous-create resolution, so the same
 * evidence always resolves to the same venue order and an audit can replay it.
 */
export function ambiguousCreateProofSha256(order: LiveDurableOrderView, candidate: LiveVenueOrderEvidence): string {
  return sha256CanonicalJson({
    schema: 'P18_AMBIGUOUS_CREATE_PROOF_V1',
    intentId: order.intentId,
    exchangeOrderId: candidate.exchangeOrderId,
    pair: order.pair,
    side: order.side,
    wireOrderType: order.wireOrderType,
    orderedQuantity: canonicalLiveDecimalString(order.orderedQuantity, 'orderedQuantity'),
    price: order.price === null ? null : canonicalLiveDecimalString(order.price, 'price'),
    leverage: order.leverage === null ? null : canonicalLiveDecimalString(order.leverage, 'leverage'),
  });
}

/**
 * The result of matching one local client order id against venue evidence.
 *
 * `UNIQUE_MATCH` carries `establishes: 'ORDER_IDENTITY_ONLY'` as a literal: an
 * exact `client_order_id` match names which venue order a local intent
 * created, and nothing more. It is not account continuity, not a current
 * reconciliation, and not evidence about any other order.
 */
export type LiveClientOrderIdMatch =
  | { readonly kind: 'NO_MATCH' }
  | { readonly kind: 'UNIQUE_MATCH'; readonly candidate: LiveVenueOrderEvidence; readonly establishes: 'ORDER_IDENTITY_ONLY' }
  /** More than one distinct venue order carries the id: an invariant violation, never a choice. */
  | { readonly kind: 'MULTIPLE_MATCHES'; readonly exchangeOrderIds: readonly string[] };

const NO_CLIENT_ORDER_ID_MATCH: LiveClientOrderIdMatch = Object.freeze({ kind: 'NO_MATCH' as const });

/**
 * Exact `client_order_id` matching. Strict string equality only: no trim, no
 * case folding, no prefix match, so two ids that differ in any byte are never
 * merged. A venue `null` never matches anything, and neither does an empty
 * local id. Records sharing one exchange order id count as one venue order
 * (the evidence set is already deduplicated by id upstream).
 */
export function matchVenueOrdersByClientOrderId(
  localClientOrderId: string,
  orders: readonly LiveVenueOrderEvidence[],
): LiveClientOrderIdMatch {
  if (typeof localClientOrderId !== 'string' || localClientOrderId.length === 0) return NO_CLIENT_ORDER_ID_MATCH;
  const byExchangeOrderId = new Map<string, LiveVenueOrderEvidence>();
  for (const candidate of orders) {
    if (candidate.clientOrderId === null || candidate.clientOrderId !== localClientOrderId) continue;
    if (!byExchangeOrderId.has(candidate.exchangeOrderId)) byExchangeOrderId.set(candidate.exchangeOrderId, candidate);
  }
  if (byExchangeOrderId.size === 0) return NO_CLIENT_ORDER_ID_MATCH;
  if (byExchangeOrderId.size > 1) {
    return Object.freeze({ kind: 'MULTIPLE_MATCHES' as const, exchangeOrderIds: Object.freeze([...byExchangeOrderId.keys()].sort()) });
  }
  const [candidate] = [...byExchangeOrderId.values()];
  return Object.freeze({ kind: 'UNIQUE_MATCH' as const, candidate: candidate!, establishes: 'ORDER_IDENTITY_ONLY' as const });
}

/** Deterministic proof identity of a resolution established by exact `client_order_id`. */
export function clientOrderIdResolutionProofSha256(order: LiveDurableOrderView, candidate: LiveVenueOrderEvidence): string {
  return sha256CanonicalJson({
    schema: 'P18_AMBIGUOUS_CREATE_CLIENT_ORDER_ID_PROOF_V1',
    intentId: order.intentId,
    clientOrderId: order.clientOrderId,
    exchangeOrderId: candidate.exchangeOrderId,
    pair: order.pair,
    side: order.side,
    wireOrderType: order.wireOrderType,
    orderedQuantity: canonicalLiveDecimalString(order.orderedQuantity, 'orderedQuantity'),
    price: order.price === null ? null : canonicalLiveDecimalString(order.price, 'price'),
  });
}

/**
 * Resolves an ambiguous create whose exact `client_order_id` matched exactly
 * one venue order (see `matchVenueOrdersByClientOrderId`).
 *
 * WHY THIS MAY PASS THE TIME-IN-FORCE GATE WHEN ECONOMIC MATCHING MAY NOT: the
 * TIF gate exists because economic matching cannot prove WHICH venue order a
 * local submission created, and TIF is one of the bindings it cannot observe.
 * An exact match on the provider-confirmed idempotent `client_order_id` proves
 * that directly: the only way a venue order carries this 128-bit
 * content-derived id is that this system's own create request, carrying this
 * intent's exact TIF, created it. The economics below are then a consistency
 * check against a stated contradiction, not the basis of identity.
 *
 * Still refused (never adopted):
 *   - an incomplete provider read: uniqueness of the match cannot be proven;
 *   - a venue order another local order already owns;
 *   - a venue order whose stated economics contradict the local intent;
 *   - a venue order created outside the persisted submission window;
 *   - a venue status Phase17 never modelled, or a non-permitted state move.
 */
export function resolveAmbiguousCreateByClientOrderId(
  input: AmbiguousCreateResolutionInput,
  candidate: LiveVenueOrderEvidence,
): LiveOrderReconciliationOutcome {
  const { order, evidence } = input;
  const subject = { pair: order.pair, intentId: order.intentId, exchangeOrderId: candidate.exchangeOrderId };

  if (!evidence.ordersProvenance.complete) {
    return outcome([buildFinding({
      category: 'AMBIGUOUS',
      code: 'RECON_AMBIGUOUS_CREATE_UNRESOLVED',
      subject,
      evidence: {
        reason: 'A venue order carries this exact client order id, but the provider order read could not prove it inspected everything, so the match cannot be proven unique',
        incompleteReason: evidence.ordersProvenance.incompleteReason,
        pagesRead: evidence.ordersProvenance.pagesRead,
      },
    })], [], [candidate.exchangeOrderId]);
  }

  if (input.alreadyClaimed.has(candidate.exchangeOrderId)) {
    return outcome([buildFinding({
      category: 'MANUAL_REVIEW_REQUIRED',
      code: 'RECON_AMBIGUOUS_CREATE_CLIENT_ORDER_ID_CONFLICT',
      subject,
      evidence: { reason: 'The venue order carrying this client order id is already bound to another local order' },
    })]);
  }

  if (!matchesImmutableEconomics(order, candidate)) {
    return outcome([buildFinding({
      category: 'MANUAL_REVIEW_REQUIRED',
      code: 'RECON_AMBIGUOUS_CREATE_CLIENT_ORDER_ID_CONFLICT',
      subject,
      evidence: {
        reason: 'The venue order carrying this exact client order id states economics that contradict the local intent',
        localPair: order.pair,
        venuePair: candidate.pair,
        localSide: order.side,
        venueSide: candidate.side,
        localOrderedQuantity: order.orderedQuantity,
        venueOrderedQuantity: candidate.orderedQuantity,
        localPrice: order.price,
        venuePrice: candidate.price,
        localWireOrderType: order.wireOrderType,
        venueWireOrderType: candidate.wireOrderType,
      },
    })], [], [candidate.exchangeOrderId]);
  }

  if (!withinSubmissionWindow(order, candidate, input.submissionWindowToleranceMs)) {
    return outcome([buildFinding({
      category: 'AMBIGUOUS',
      code: 'RECON_AMBIGUOUS_CREATE_UNRESOLVED',
      subject,
      evidence: {
        reason: 'The venue order carrying this client order id was created outside this intent\'s persisted submission window',
        providerCreatedAtMs: candidate.providerCreatedAtMs,
        localWindowStartMs: order.createdAtMs,
        localWindowEndMs: order.updatedAtMs,
      },
    })], [], [candidate.exchangeOrderId]);
  }

  const observation = observationFromEvidence(order, candidate);
  if (observation === null) {
    return outcome([buildFinding({
      category: 'AMBIGUOUS',
      code: 'RECON_AMBIGUOUS_CREATE_UNRESOLVED',
      subject,
      evidence: { reason: 'The venue order carrying this client order id reports a status Phase17 never modelled', venueStatus: candidate.venueStatus },
    })], [], [candidate.exchangeOrderId]);
  }

  const ordered = liveDecimal(observation.orderedQuantity);
  const filled = liveDecimal(observation.cumulativeFilledQuantity);
  const targetState = projectedStateFor(observation.kind, filled.equals(ordered), filled.greaterThan(0));
  const permitted = LIVE_RECONCILIATION_TRANSITIONS[order.state] ?? [];
  if (!permitted.includes(targetState)) {
    return outcome([buildFinding({
      category: 'MANUAL_REVIEW_REQUIRED',
      code: 'RECON_ORDER_STATE_CONFLICT',
      subject,
      evidence: { localState: order.state, provenVenueState: targetState },
    })], [], [candidate.exchangeOrderId]);
  }

  return outcome(
    [buildFinding({
      category: 'LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE',
      code: 'RECON_AMBIGUOUS_CREATE_RESOLVED_BY_CLIENT_ORDER_ID',
      subject,
      evidence: {
        proofSha256: clientOrderIdResolutionProofSha256(order, candidate),
        identityBasis: 'EXACT_CLIENT_ORDER_ID',
        establishes: 'ORDER_IDENTITY_ONLY',
        resolvedState: targetState,
        venueStatus: candidate.venueStatus,
        cumulativeFilledQuantity: observation.cumulativeFilledQuantity,
      },
    })],
    [{ kind: 'RESOLVE_AMBIGUOUS_CREATE', intentId: order.intentId, observation, targetState }],
    [candidate.exchangeOrderId],
  );
}

export interface AmbiguousCreateResolutionInput {
  readonly order: LiveDurableOrderView;
  readonly evidence: LiveVenueEvidenceSet;
  /** Venue orders already provably owned by another local order. */
  readonly alreadyClaimed: ReadonlySet<string>;
  /**
   * Venue orders that more than one local ambiguous order matches
   * economically. Such a candidate can never be adopted by any of them.
   */
  readonly contestedCandidates: ReadonlySet<string>;
  readonly submissionWindowToleranceMs: number;
}

/**
 * Resolves one `SUBMISSION_AMBIGUOUS` (or crash-interrupted
 * `DISPATCH_RESERVED`) order against authoritative evidence (§6).
 *
 * The PUBLIC entry point, in two strictly ordered steps:
 *
 * 1. Exact `client_order_id` matching (`matchVenueOrdersByClientOrderId`).
 *    Two or more venue orders carrying the id block for manual review; exactly
 *    one is handed to `resolveAmbiguousCreateByClientOrderId`, the only path
 *    that can adopt a venue order. A `null` venue id never matches.
 *
 * 2. With NO client-order-id match, the [Wave B3 / F18-21] identity-
 *    observability gate runs exactly as before, unconditionally (see
 *    `ambiguousCreateIdentityUnobservableReason` — it always returns a reason,
 *    for every order, regardless of candidates or evidence completeness).
 *    This is reported with its own explicit code rather than falling through
 *    to "zero candidates", which would misleadingly suggest more reads might
 *    help — TIF unobservability is a permanent limitation of economic
 *    matching against this provider's evidence contract.
 *
 * Everything below the gate is UNREACHABLE in production (the gate always
 * fires once step 1 found no match), and is delegated to
 * `resolveAmbiguousCreateAgainstObservableCandidates`, kept as its own tested,
 * exported function rather than deleted: the candidate-selection logic it
 * contains remains correct and ready for the day a genuinely authoritative
 * provider TIF proof exists (§F18-24) and the gate above can be narrowed.
 * Until then, this function's real, load-bearing behavior IS the gate.
 */
export function resolveAmbiguousCreate(input: AmbiguousCreateResolutionInput): LiveOrderReconciliationOutcome {
  const { order } = input;
  const subject = { pair: order.pair, intentId: order.intentId };

  // The provider-confirmed `client_order_id` path comes first, because an
  // exact match is the one thing that CAN establish identity. Anything other
  // than exactly one match falls through (NO_MATCH) or blocks (MULTIPLE).
  const byClientOrderId = matchVenueOrdersByClientOrderId(order.clientOrderId, input.evidence.orders);
  if (byClientOrderId.kind === 'MULTIPLE_MATCHES') {
    return outcome([buildFinding({
      category: 'MANUAL_REVIEW_REQUIRED',
      code: 'RECON_CLIENT_ORDER_ID_DUPLICATE_AT_VENUE',
      subject,
      evidence: {
        reason: 'More than one venue order carries this exact client order id; the provider idempotency invariant is violated and no choice between them is permitted',
        candidateExchangeOrderIds: byClientOrderId.exchangeOrderIds,
      },
    })], [], byClientOrderId.exchangeOrderIds);
  }
  if (byClientOrderId.kind === 'UNIQUE_MATCH') {
    return resolveAmbiguousCreateByClientOrderId(input, byClientOrderId.candidate);
  }

  // NO_MATCH: exactly the pre-existing fail-closed behavior. Economics alone
  // can never establish identity while time-in-force is unobservable.
  const unobservableReason = ambiguousCreateIdentityUnobservableReason(order);
  if (unobservableReason !== null) {
    return outcome([buildFinding({
      category: 'MANUAL_REVIEW_REQUIRED',
      code: 'RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE',
      subject,
      evidence: {
        reason: 'A candidate may match every economic field this evidence contract can observe, but exact venue identity cannot be established because a required identity-bearing local field (time-in-force) is not provable by the CoinDCX evidence contract for any candidate; automatic resolution is unsafe regardless of candidate count or evidence completeness',
        unobservableField: unobservableReason,
        localTimeInForce: order.timeInForce,
      },
    })]);
  }

  return resolveAmbiguousCreateAgainstObservableCandidates(input);
}

/**
 * [Wave B3 / F18-21] The candidate-selection logic `resolveAmbiguousCreate`
 * delegates to ONLY after its identity-observability gate has passed —
 * currently never, in production, since that gate is unconditional. Exported
 * and independently tested so this logic stays correct without being
 * exercised through a gate that will always short-circuit it first. Every
 * branch below is otherwise identical to the pre-Wave-B3 behavior: exactly
 * one proven candidate resolves; every other branch is reconciliation-
 * required, and absence from an INCOMPLETE provider read is never treated as
 * proof that the create never landed.
 */
export function resolveAmbiguousCreateAgainstObservableCandidates(input: AmbiguousCreateResolutionInput): LiveOrderReconciliationOutcome {
  const { order, evidence } = input;
  const subject = { pair: order.pair, intentId: order.intentId };

  // [Wave B / F18-08] Identity is being ESTABLISHED here, not merely checked
  // against an already-proven one, so a local immutable field the venue did
  // not report can never stand in for a proof of equality.
  const candidates = evidence.orders.filter((candidate) => matchesProvenEconomicsForAmbiguousCreate(order, candidate));

  if (candidates.length > 1) {
    return outcome([buildFinding({
      category: 'MANUAL_REVIEW_REQUIRED',
      code: 'RECON_AMBIGUOUS_CREATE_MULTIPLE_CANDIDATES',
      subject,
      evidence: {
        candidateCount: candidates.length,
        candidateExchangeOrderIds: candidates.map((candidate) => candidate.exchangeOrderId).sort(),
        reason: 'More than one venue order matches this intent exactly; no tie-break rule is permitted',
      },
    })]);
  }

  if (candidates.length === 0) {
    // Absence is only meaningful in a COMPLETE read, and even then only for an
    // order the venue would still be listing. The observation status set the
    // adapter requests covers terminal statuses too, so a complete read that
    // omits the order is genuine evidence it was never accepted.
    if (!evidence.ordersProvenance.complete) {
      return outcome([buildFinding({
        category: 'AMBIGUOUS',
        code: 'RECON_AMBIGUOUS_CREATE_UNRESOLVED',
        subject,
        evidence: {
          reason: 'No candidate found, and the provider order read could not prove it inspected everything',
          incompleteReason: evidence.ordersProvenance.incompleteReason,
          pagesRead: evidence.ordersProvenance.pagesRead,
        },
      })]);
    }
    return outcome([buildFinding({
      category: 'MANUAL_REVIEW_REQUIRED',
      code: 'RECON_AMBIGUOUS_CREATE_PROVEN_ABSENT',
      subject,
      evidence: {
        reason: 'A complete venue read contains no order matching this intent; the submission is provably absent but resolving it durably is an operator decision',
        pagesRead: evidence.ordersProvenance.pagesRead,
      },
    })]);
  }

  // [Wave B / F18-03] Exactly one candidate is not sufficient to resolve
  // unless the read that produced it can prove it inspected every order. An
  // incomplete read (a later page failed, the pagination guard was hit, a
  // page came back malformed) may be hiding a SECOND matching order that
  // would have made this ambiguous — adopting the one visible candidate
  // anyway would be exactly the guess §6 forbids, merely delayed until the
  // unread page happens not to exist. This must block regardless of whether
  // the account will separately be blocked by the account-level
  // `RECON_EVIDENCE_INCOMPLETE` finding: incomplete evidence must never
  // durably mutate economic lineage, even inside an otherwise-blocked run.
  if (!evidence.ordersProvenance.complete) {
    return outcome([buildFinding({
      category: 'AMBIGUOUS',
      code: 'RECON_AMBIGUOUS_CREATE_UNRESOLVED',
      subject: { ...subject, exchangeOrderId: candidates[0]!.exchangeOrderId },
      evidence: {
        reason: 'A candidate was found but the provider order read could not prove it inspected everything; a second matching order may exist on an unread page',
        incompleteReason: evidence.ordersProvenance.incompleteReason,
        pagesRead: evidence.ordersProvenance.pagesRead,
      },
    })]);
  }

  const candidate = candidates[0]!;

  if (input.contestedCandidates.has(candidate.exchangeOrderId) || input.alreadyClaimed.has(candidate.exchangeOrderId)) {
    return outcome([buildFinding({
      category: 'MANUAL_REVIEW_REQUIRED',
      code: 'RECON_AMBIGUOUS_CREATE_MULTIPLE_CANDIDATES',
      subject: { ...subject, exchangeOrderId: candidate.exchangeOrderId },
      evidence: {
        reason: 'Another local order also proves a claim to this venue order; adopting it for either would be a guess',
      },
    })]);
  }

  if (!withinSubmissionWindow(order, candidate, input.submissionWindowToleranceMs)) {
    return outcome([buildFinding({
      category: 'AMBIGUOUS',
      code: 'RECON_AMBIGUOUS_CREATE_UNRESOLVED',
      subject: { ...subject, exchangeOrderId: candidate.exchangeOrderId },
      evidence: {
        reason: 'The only economic candidate was created outside this intent\'s persisted submission window',
        providerCreatedAtMs: candidate.providerCreatedAtMs,
        localWindowStartMs: order.createdAtMs,
        localWindowEndMs: order.updatedAtMs,
      },
    })]);
  }

  const observation = observationFromEvidence(order, candidate);
  if (observation === null) {
    return outcome([buildFinding({
      category: 'AMBIGUOUS',
      code: 'RECON_AMBIGUOUS_CREATE_UNRESOLVED',
      subject: { ...subject, exchangeOrderId: candidate.exchangeOrderId },
      evidence: {
        reason: 'The matching venue order carries a status Phase17 never modelled',
        venueStatus: candidate.venueStatus,
      },
    })]);
  }

  const ordered = liveDecimal(observation.orderedQuantity);
  const filled = liveDecimal(observation.cumulativeFilledQuantity);
  const targetState = projectedStateFor(observation.kind, filled.equals(ordered), filled.greaterThan(0));
  const permitted = LIVE_RECONCILIATION_TRANSITIONS[order.state] ?? [];
  if (!permitted.includes(targetState)) {
    return outcome([buildFinding({
      category: 'MANUAL_REVIEW_REQUIRED',
      code: 'RECON_ORDER_STATE_CONFLICT',
      subject: { ...subject, exchangeOrderId: candidate.exchangeOrderId },
      evidence: { localState: order.state, provenVenueState: targetState },
    })]);
  }

  return outcome(
    [buildFinding({
      category: 'LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE',
      code: 'RECON_AMBIGUOUS_CREATE_RESOLVED',
      subject: { ...subject, exchangeOrderId: candidate.exchangeOrderId },
      evidence: {
        proofSha256: ambiguousCreateProofSha256(order, candidate),
        resolvedState: targetState,
        venueStatus: candidate.venueStatus,
        cumulativeFilledQuantity: observation.cumulativeFilledQuantity,
      },
    })],
    [{ kind: 'RESOLVE_AMBIGUOUS_CREATE', intentId: order.intentId, observation, targetState }],
    [candidate.exchangeOrderId],
  );
}

/**
 * Reconciles one durable order that already holds an authoritative exchange
 * order id (§7, §8).
 *
 * This covers ordinary lifecycle drift, ambiguous cancellation recovery, late
 * fills discovered after restart, and terminal contradictions — all from the
 * same comparison, because in every case the question is identical: does the
 * venue's view of THIS exact order id agree with durable truth?
 */
export function reconcileIdentifiedOrder(
  order: LiveDurableOrderView,
  evidence: LiveVenueEvidenceSet,
): LiveOrderReconciliationOutcome {
  const exchangeOrderId = order.exchangeOrderId;
  if (exchangeOrderId === null) return outcome([]);
  const subject = { pair: order.pair, intentId: order.intentId, exchangeOrderId };

  const matches = evidence.orders.filter((candidate) => candidate.exchangeOrderId === exchangeOrderId);

  if (matches.length === 0) {
    if (!evidence.ordersProvenance.complete) {
      // §14: an incomplete history is NEVER proof that an order never existed.
      return outcome([buildFinding({
        category: 'AMBIGUOUS',
        code: 'RECON_ORDER_ABSENCE_UNPROVEN',
        subject,
        evidence: {
          reason: 'This order is absent from a provider read that could not prove completeness',
          incompleteReason: evidence.ordersProvenance.incompleteReason,
          localState: order.state,
        },
      })], [], [exchangeOrderId]);
    }
    if (LOCALLY_TERMINAL_STATES.includes(order.state)) {
      // Settled locally and gone from the venue's current window. Consistent.
      return outcome([buildFinding({
        category: 'VERIFIED_MATCH',
        code: 'RECON_ORDER_VERIFIED_MATCH',
        subject,
        evidence: { localState: order.state, reason: 'Terminal locally and absent from the venue view' },
      })], [], [exchangeOrderId]);
    }
    return outcome([buildFinding({
      category: 'CONFLICT',
      code: 'RECON_ORDER_ABSENT_FROM_VENUE',
      subject,
      evidence: {
        reason: 'A locally active order is absent from a complete venue read',
        localState: order.state,
        cumulativeFilledQuantity: order.cumulativeFilledQuantity,
      },
    })], [], [exchangeOrderId]);
  }

  const venue = matches[0]!;

  // A venue order already bound by exchange id must not report a DIFFERENT
  // client order id. `null` is not a contradiction (an order created before
  // the id was sent carries none); any other non-identical value is.
  if (venue.clientOrderId !== null && venue.clientOrderId !== order.clientOrderId) {
    return outcome([buildFinding({
      category: 'MANUAL_REVIEW_REQUIRED',
      code: 'RECON_ORDER_CLIENT_ORDER_ID_CONFLICT',
      subject,
      evidence: { reason: 'The venue order bound to this intent by exchange order id reports a different client order id' },
    })], [], [exchangeOrderId]);
  }

  // Economics must agree before any state claim is even considered.
  if (!matchesImmutableEconomics(order, venue)) {
    return outcome([buildFinding({
      category: 'CONFLICT',
      code: 'RECON_ORDER_ECONOMICS_CONFLICT',
      subject,
      evidence: {
        reason: 'The venue order bound to this intent reports different immutable economics',
        localPair: order.pair,
        venuePair: venue.pair,
        localSide: order.side,
        venueSide: venue.side,
        localOrderedQuantity: order.orderedQuantity,
        venueOrderedQuantity: venue.orderedQuantity,
        localPrice: order.price,
        venuePrice: venue.price,
        localWireOrderType: order.wireOrderType,
        venueWireOrderType: venue.wireOrderType,
      },
    })], [], [exchangeOrderId]);
  }

  const observation = observationFromEvidence(order, venue);
  if (observation === null) {
    return outcome([buildFinding({
      category: 'MANUAL_REVIEW_REQUIRED',
      code: 'RECON_ORDER_STATE_CONFLICT',
      subject,
      evidence: { reason: 'The venue reports a status Phase17 never modelled', venueStatus: venue.venueStatus },
    })], [], [exchangeOrderId]);
  }

  const localFilled = liveDecimal(canonicalLiveDecimalString(order.cumulativeFilledQuantity, 'cumulativeFilledQuantity'));
  const venueFilled = liveDecimal(observation.cumulativeFilledQuantity);
  const ordered = liveDecimal(observation.orderedQuantity);

  // A venue that reports LESS cumulative fill than durable truth is either
  // stale delivery or a genuine regression. Either way Phase18 never decreases
  // a durable fill; it records the contradiction.
  if (venueFilled.lessThan(localFilled)) {
    return outcome([buildFinding({
      category: 'CONFLICT',
      code: 'RECON_ORDER_FILL_REGRESSION',
      subject,
      evidence: {
        reason: 'Venue cumulative fill is below durable cumulative fill',
        localCumulativeFilledQuantity: localFilled.toFixed(),
        venueCumulativeFilledQuantity: venueFilled.toFixed(),
      },
    })], [], [exchangeOrderId]);
  }

  const targetState = projectedStateFor(observation.kind, venueFilled.equals(ordered), venueFilled.greaterThan(0));
  const sameState = targetState === order.state;
  const sameFill = venueFilled.equals(localFilled);
  const sameAverage = exactlyEqual(observation.averageFillPrice, order.averageFillPrice);

  if (sameState && sameFill && sameAverage) {
    return outcome([buildFinding({
      category: 'VERIFIED_MATCH',
      code: 'RECON_ORDER_VERIFIED_MATCH',
      subject,
      evidence: { state: order.state, cumulativeFilledQuantity: localFilled.toFixed(), venueStatus: venue.venueStatus },
    })], [], [exchangeOrderId]);
  }

  // [P18 Wave A2 / F18-14] A `CANCEL_REQUESTED` order whose venue evidence
  // proves it still rests UNAFFECTED (no fill progress, not cancelled) is
  // recognized here regardless of the CURRENT `cancelState` — which may
  // already be `NONE` if an earlier step this same run (`planClaimRecovery`)
  // already reclaimed an unarmed claim, or may still be
  // `CANCEL_RESERVED`/`CANCEL_AMBIGUOUS` if the claim survived. Either way
  // `order.state` is deliberately left untouched: the frozen Phase17
  // transition table has no path from `CANCEL_REQUESTED` back to
  // `ACKNOWLEDGED`, so this never asks the observation pipeline to move it.
  // This must be checked before the generic `permitted` gate below, which
  // would otherwise refuse an already-reclaimed order as a conflict —
  // exactly the "recovery re-blocks itself" bug this exists to close.
  if (order.state === 'CANCEL_REQUESTED' && targetState === 'ACKNOWLEDGED' && sameFill) {
    const claimNeedsClearing = order.cancelState === 'CANCEL_RESERVED' || order.cancelState === 'CANCEL_AMBIGUOUS';
    // [Wave B2 / F18-20] Clearing a cancel claim IS an economic-lineage effect
    // (it durably changes `cancelState`, unblocking future mutation for this
    // order) and must not be produced from a read that could not prove it
    // inspected everything — exactly the same rule as the fill-advance branch
    // below, checked here because this branch's effect is otherwise reached
    // before that one.
    if (claimNeedsClearing && !evidence.ordersProvenance.complete) {
      return outcome([buildFinding({
        category: 'AMBIGUOUS',
        code: 'RECON_ORDER_ADVANCE_WITHHELD_INCOMPLETE_EVIDENCE',
        subject,
        evidence: {
          reason: 'Venue evidence appears to resolve an outstanding cancel claim, but the provider order read could not prove it inspected everything; withholding the claim-clearing effect',
          incompleteReason: evidence.ordersProvenance.incompleteReason,
          cancelState: order.cancelState,
        },
      })], [], [exchangeOrderId]);
    }
    return outcome([buildFinding({
      category: claimNeedsClearing ? 'SAFE_AUTHORITATIVE_ADVANCE' : 'VERIFIED_MATCH',
      code: claimNeedsClearing ? 'RECON_CANCEL_RESOLVED_FROM_VENUE' : 'RECON_ORDER_VERIFIED_MATCH',
      subject,
      evidence: {
        reason: 'Authoritative venue evidence proves this order still rests unaffected despite a cancel request; any outstanding cancel claim is resolved with zero resend',
        venueStatus: venue.venueStatus,
        cancelState: order.cancelState,
      },
    })], claimNeedsClearing ? [{ kind: 'CLEAR_CANCEL_CLAIM', intentId: order.intentId }] : [], [exchangeOrderId]);
  }

  if (LOCALLY_TERMINAL_STATES.includes(order.state) || order.state === 'RECONCILIATION_REQUIRED') {
    // Late authoritative evidence contradicting a settled order is real, but
    // repairing it automatically would rewrite committed economic history.
    return outcome([buildFinding({
      category: 'CONFLICT',
      code: 'RECON_ORDER_STATE_CONFLICT',
      subject,
      evidence: {
        reason: 'Authoritative venue evidence contradicts a terminal durable order',
        localState: order.state,
        provenVenueState: targetState,
        localCumulativeFilledQuantity: localFilled.toFixed(),
        venueCumulativeFilledQuantity: venueFilled.toFixed(),
      },
    })], [], [exchangeOrderId]);
  }

  const permitted = LIVE_RECONCILIATION_TRANSITIONS[order.state] ?? [];
  if (!permitted.includes(targetState)) {
    return outcome([buildFinding({
      category: 'CONFLICT',
      code: 'RECON_ORDER_STATE_CONFLICT',
      subject,
      evidence: { localState: order.state, provenVenueState: targetState },
    })], [], [exchangeOrderId]);
  }

  // [Wave B2 / F18-20 — THE confirmed exploit] A strictly forward advance is
  // exactly the kind of durable economic effect (cumulative fill, state,
  // event persistence) that incomplete evidence must never produce, even
  // though the record backing THIS advance was itself found. The read's
  // completeness is evaluated once for the whole evidence set, not per
  // record, and Wave B2 treats "some page failed" as disqualifying the ENTIRE
  // read from authorizing any economic effect this run — the found record may
  // be perfectly accurate, but the account cannot prove no other divergence
  // exists elsewhere in the same incomplete read, so the conservative rule
  // withholds uniformly rather than trusting some records and not others.
  if (!evidence.ordersProvenance.complete) {
    return outcome([buildFinding({
      category: 'AMBIGUOUS',
      code: 'RECON_ORDER_ADVANCE_WITHHELD_INCOMPLETE_EVIDENCE',
      subject,
      evidence: {
        reason: 'Venue evidence proves a forward advance for this known order, but the provider order read could not prove it inspected everything; withholding the economic effect until completeness is proven',
        fromState: order.state,
        provenToState: targetState,
        fromCumulativeFilledQuantity: localFilled.toFixed(),
        provenCumulativeFilledQuantity: venueFilled.toFixed(),
        incompleteReason: evidence.ordersProvenance.incompleteReason,
      },
    })], [], [exchangeOrderId]);
  }

  // A strictly forward advance proven by the venue. Note this is also exactly
  // how an ambiguous CANCELLATION resolves (§7): the venue's own view of the
  // order id decides CANCELLED / FILLED / still-open, and no cancel is ever
  // resent merely because the process restarted.
  const wasCancelAmbiguous = order.cancelState === 'CANCEL_AMBIGUOUS' || order.cancelState === 'CANCEL_RESERVED';
  return outcome(
    [buildFinding({
      category: 'SAFE_AUTHORITATIVE_ADVANCE',
      code: wasCancelAmbiguous ? 'RECON_CANCEL_RESOLVED_FROM_VENUE' : 'RECON_ORDER_ADVANCED_FROM_VENUE',
      subject,
      evidence: {
        fromState: order.state,
        toState: targetState,
        fromCumulativeFilledQuantity: localFilled.toFixed(),
        toCumulativeFilledQuantity: venueFilled.toFixed(),
        venueStatus: venue.venueStatus,
        cancelState: order.cancelState,
      },
    })],
    [{ kind: 'APPLY_OBSERVATION', intentId: order.intentId, observation, clearsCancelClaim: wasCancelAmbiguous }],
    [exchangeOrderId],
  );
}

/**
 * Orphan detection (§9).
 *
 * An orphan is an ACTIVE venue order for the managed account that no durable
 * local order provably owns. It is classified explicitly and never attached to
 * the nearest local intent — "nearest" is not a relation this file computes.
 */
export function detectOrphanVenueOrders(
  evidence: LiveVenueEvidenceSet,
  claimedExchangeOrderIds: ReadonlySet<string>,
): { readonly findings: readonly LiveReconciliationFinding[]; readonly orphans: readonly LiveVenueOrderEvidence[] } {
  const orphans = evidence.orders.filter(
    (order) => VENUE_OPEN_STATUSES.includes(order.venueStatus) && !claimedExchangeOrderIds.has(order.exchangeOrderId),
  );
  const findings = orphans.map((order) => buildFinding({
    category: 'ORPHAN',
    code: 'RECON_ORPHAN_VENUE_ORDER',
    subject: { pair: order.pair, exchangeOrderId: order.exchangeOrderId },
    evidence: {
      reason: 'An active venue order for this account has no proven local lineage',
      venueStatus: order.venueStatus,
      side: order.side,
      orderedQuantity: canonicalLiveDecimalString(order.orderedQuantity, 'orderedQuantity'),
      filledQuantity: canonicalLiveDecimalString(order.filledQuantity, 'filledQuantity'),
    },
  }));
  return Object.freeze({ findings: Object.freeze(findings), orphans: Object.freeze([...orphans]) });
}

/** Local states from which Phase18 attempts an ambiguous-create resolution. */
export function requiresAmbiguousCreateResolution(order: LiveDurableOrderView): boolean {
  return (order.state === 'SUBMISSION_AMBIGUOUS' || order.state === 'DISPATCH_RESERVED')
    && order.exchangeOrderId === null;
}

/**
 * [P18 Wave A2 / F18-14] One proposed local-only crash-claim reclaim. Pure:
 * the service applies it through `commitReconciledState`, under the CURRENT
 * generation's genuine RUNNING authority, never a caller-supplied one.
 */
export type LiveClaimRecoveryEffect =
  | { readonly kind: 'RECLAIM_DISPATCH'; readonly intentId: string }
  | { readonly kind: 'RECLAIM_CANCEL'; readonly intentId: string };

export interface LiveClaimRecoveryPlan {
  readonly findings: readonly LiveReconciliationFinding[];
  readonly effects: readonly LiveClaimRecoveryEffect[];
}

/**
 * Classifies every durable order this run inherited for a LOCAL-ONLY,
 * never-armed mutation claim (§F18-14 Case A / Case C).
 *
 * This step is deliberately EVIDENCE-INDEPENDENT and runs before any venue
 * read: a `dispatchWireArmed`/`cancelWireArmed` flag of `false` is, on its
 * own, conclusive proof that no wire request was ever sent, so waiting for or
 * depending on venue evidence to reach the same conclusion would only make a
 * safely-recoverable account wait on a read it does not need.
 *
 * An ARMED claim is deliberately left untouched here: it is resolved either
 * by `resolveAmbiguousCreate` (dispatch) or `reconcileIdentifiedOrder`
 * (cancel) against authoritative venue evidence later in the same run, or —
 * if evidence cannot resolve it — stays a durable blocking fact. Nothing here
 * ever infers "wire never sent" from a restart, a timeout, or process
 * liveness; only the durable flag this process itself committed decides it.
 */
export function planClaimRecovery(orders: readonly LiveDurableOrderView[]): LiveClaimRecoveryPlan {
  const findings: LiveReconciliationFinding[] = [];
  const effects: LiveClaimRecoveryEffect[] = [];
  for (const order of orders) {
    if (order.state === 'DISPATCH_RESERVED' && order.exchangeOrderId === null && !order.dispatchWireArmed) {
      effects.push({ kind: 'RECLAIM_DISPATCH', intentId: order.intentId });
      findings.push(buildFinding({
        category: 'LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE',
        code: 'RECON_DISPATCH_RESERVATION_RECLAIMED',
        subject: { pair: order.pair, intentId: order.intentId },
        evidence: {
          reason: 'A local dispatch reservation survived a restart with no durable proof its wire request was ever armed; reclaimed to CREATED with zero exchange mutation',
        },
      }));
    }
    if (order.cancelState === 'CANCEL_RESERVED' && !order.cancelWireArmed) {
      effects.push({ kind: 'RECLAIM_CANCEL', intentId: order.intentId });
      findings.push(buildFinding({
        category: 'LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE',
        code: 'RECON_CANCEL_RESERVATION_RECLAIMED',
        subject: { pair: order.pair, intentId: order.intentId, exchangeOrderId: order.exchangeOrderId },
        evidence: {
          reason: 'A local cancel reservation survived a restart with no durable proof its wire request was ever armed; reclaimed with zero exchange mutation',
        },
      }));
    }
  }
  return Object.freeze({ findings: Object.freeze(findings), effects: Object.freeze(effects) });
}

export function isLocallyActive(order: LiveDurableOrderView): boolean {
  return LOCALLY_ACTIVE_STATES.includes(order.state);
}

export { VENUE_OPEN_STATUSES, LOCALLY_ACTIVE_STATES, LOCALLY_TERMINAL_STATES };
