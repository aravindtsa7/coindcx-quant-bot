import { describe, expect, it } from 'vitest';
import {
  ambiguousCreateIdentityUnobservableReason,
  ambiguousCreateProofSha256,
  detectOrphanVenueOrders,
  matchesImmutableEconomics,
  matchesProvenEconomicsForAmbiguousCreate,
  observationFromEvidence,
  reconcileIdentifiedOrder,
  requiresAmbiguousCreateResolution,
  resolveAmbiguousCreate,
  resolveAmbiguousCreateAgainstObservableCandidates,
  withinSubmissionWindow,
} from '../../../../../src/execution/live/reconciliation';
import type { LiveReconciliationFinding } from '../../../../../src/execution/live/reconciliation/types';
import {
  OTHER_PAIR,
  PAIR,
  T_READ_START,
  durableOrder,
  evidenceSet,
  filledVenueOrder,
  provenance,
  venueOrder,
} from './helpers';

const NO_CLAIMS = new Set<string>();
const TOLERANCE = 120_000;

function codes(findings: readonly LiveReconciliationFinding[]): readonly string[] {
  return findings.map((finding) => finding.code);
}

function categories(findings: readonly LiveReconciliationFinding[]): readonly string[] {
  return findings.map((finding) => finding.category);
}

describe('P18 §6 immutable economic matching', () => {
  it('matches a venue order binding every provable immutable field', () => {
    expect(matchesImmutableEconomics(durableOrder(), venueOrder())).toBe(true);
  });

  it.each([
    ['pair', { pair: OTHER_PAIR }],
    ['side', { side: 'SELL' as const }],
    ['ordered quantity', { orderedQuantity: '0.6', remainingQuantity: '0.6' }],
    ['limit price', { price: '64001' }],
    ['wire order type', { wireOrderType: 'market_order' }],
    ['leverage', { leverage: '10' }],
  ])('refuses a candidate differing in %s', (_label, override) => {
    expect(matchesImmutableEconomics(durableOrder(), venueOrder(override))).toBe(false);
  });

  it('matches across numerically equal but textually different decimals', () => {
    expect(matchesImmutableEconomics(
      durableOrder({ orderedQuantity: '0.5', price: '64000.5' }),
      venueOrder({ orderedQuantity: '0.500', remainingQuantity: '0.500', price: '64000.50' }),
    )).toBe(true);
  });

  it('does not bind leverage when the provider omits it, since absence is not contradiction', () => {
    expect(matchesImmutableEconomics(durableOrder({ leverage: '5' }), venueOrder({ leverage: null }))).toBe(true);
  });

  it('never matches a local MARKET order to a venue order carrying a price', () => {
    expect(matchesImmutableEconomics(
      durableOrder({ price: null, wireOrderType: 'market_order' }),
      venueOrder({ price: '64000.5', wireOrderType: 'market_order' }),
    )).toBe(false);
  });

  it('applies the submission window against the persisted local bounds', () => {
    const order = durableOrder({ createdAtMs: 1_000, updatedAtMs: 2_000 });
    expect(withinSubmissionWindow(order, venueOrder({ providerCreatedAtMs: 1_500 }), 0)).toBe(true);
    expect(withinSubmissionWindow(order, venueOrder({ providerCreatedAtMs: 500 }), 0)).toBe(false);
    expect(withinSubmissionWindow(order, venueOrder({ providerCreatedAtMs: 500 }), 600)).toBe(true);
  });
});

describe('P18 §6 ambiguous create resolution [candidate-selection logic, via resolveAmbiguousCreateAgainstObservableCandidates — see Wave B3 §F18-21 note below]', () => {
  // [Wave B3 / F18-21] These tests call `resolveAmbiguousCreateAgainstObservableCandidates`
  // directly, NOT the public `resolveAmbiguousCreate` entry point:
  // `resolveAmbiguousCreate` now unconditionally refuses every order on TIF
  // unobservability before candidates are even considered (see the dedicated
  // F18-21 describe block far below), so calling it here would only ever
  // exercise the gate, not the candidate-selection logic these tests exist to
  // prove. That logic remains correct and load-bearing for the day a
  // genuinely authoritative TIF proof narrows the gate.
  const ambiguous = durableOrder({ state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null });

  it('identifies which orders need resolution', () => {
    expect(requiresAmbiguousCreateResolution(ambiguous)).toBe(true);
    expect(requiresAmbiguousCreateResolution(durableOrder({ state: 'DISPATCH_RESERVED', exchangeOrderId: null }))).toBe(true);
    // Already bound to a venue identity: this is ordinary drift, not ambiguity.
    expect(requiresAmbiguousCreateResolution(durableOrder({ state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: 'venue-1' }))).toBe(false);
    expect(requiresAmbiguousCreateResolution(durableOrder({ state: 'ACKNOWLEDGED' }))).toBe(false);
  });

  it('resolves to a UNIQUE proven candidate and claims its venue identity', () => {
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: ambiguous,
      evidence: evidenceSet({ orders: [venueOrder()] }),
      alreadyClaimed: NO_CLAIMS,
      contestedCandidates: NO_CLAIMS,
      submissionWindowToleranceMs: TOLERANCE,
    });
    expect(codes(result.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_RESOLVED']);
    expect(categories(result.findings)).toEqual(['LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE']);
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({ kind: 'RESOLVE_AMBIGUOUS_CREATE', targetState: 'ACKNOWLEDGED' });
    expect(result.claimedExchangeOrderIds).toEqual(['venue-1']);
  });

  it('carries a deterministic, replayable proof digest', () => {
    const first = ambiguousCreateProofSha256(ambiguous, venueOrder());
    const second = ambiguousCreateProofSha256(ambiguous, venueOrder());
    expect(first).toBe(second);
    expect(first).not.toBe(ambiguousCreateProofSha256(ambiguous, venueOrder({ exchangeOrderId: 'venue-2' })));
  });

  it('adopts the venue fill state when the create actually filled', () => {
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: ambiguous,
      evidence: evidenceSet({ orders: [filledVenueOrder('0.5')] }),
      alreadyClaimed: NO_CLAIMS,
      contestedCandidates: NO_CLAIMS,
      submissionWindowToleranceMs: TOLERANCE,
    });
    expect(result.effects[0]).toMatchObject({ targetState: 'FILLED' });
  });

  it('REFUSES to choose when more than one candidate matches exactly', () => {
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: ambiguous,
      evidence: evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'venue-1' }), venueOrder({ exchangeOrderId: 'venue-2' })] }),
      alreadyClaimed: NO_CLAIMS,
      contestedCandidates: NO_CLAIMS,
      submissionWindowToleranceMs: TOLERANCE,
    });
    expect(codes(result.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_MULTIPLE_CANDIDATES']);
    expect(categories(result.findings)).toEqual(['MANUAL_REVIEW_REQUIRED']);
    expect(result.effects).toEqual([]);
  });

  it('does not pick the "closest" candidate by time when two match economically', () => {
    // One candidate is inside the submission window and one is far outside it.
    // Matching is still refused: time must never be the discriminator.
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: ambiguous,
      evidence: evidenceSet({ orders: [
        venueOrder({ exchangeOrderId: 'venue-1', providerCreatedAtMs: T_READ_START - 10_000 }),
        venueOrder({ exchangeOrderId: 'venue-2', providerCreatedAtMs: 1 }),
      ] }),
      alreadyClaimed: NO_CLAIMS,
      contestedCandidates: NO_CLAIMS,
      submissionWindowToleranceMs: TOLERANCE,
    });
    expect(codes(result.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_MULTIPLE_CANDIDATES']);
    expect(result.effects).toEqual([]);
  });

  it('refuses a candidate another local order already provably owns', () => {
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: ambiguous,
      evidence: evidenceSet({ orders: [venueOrder()] }),
      alreadyClaimed: new Set(['venue-1']),
      contestedCandidates: NO_CLAIMS,
      submissionWindowToleranceMs: TOLERANCE,
    });
    expect(codes(result.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_MULTIPLE_CANDIDATES']);
    expect(result.effects).toEqual([]);
  });

  it('refuses a candidate two unresolved local orders both match', () => {
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: ambiguous,
      evidence: evidenceSet({ orders: [venueOrder()] }),
      alreadyClaimed: NO_CLAIMS,
      contestedCandidates: new Set(['venue-1']),
      submissionWindowToleranceMs: TOLERANCE,
    });
    expect(result.effects).toEqual([]);
  });

  it('never infers a failed submission from absence in an INCOMPLETE read', () => {
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: ambiguous,
      evidence: evidenceSet({
        orders: [],
        ordersProvenance: provenance({ complete: false, incompleteReason: 'ORDER_PAGINATION_LIMIT_BUY' }),
      }),
      alreadyClaimed: NO_CLAIMS,
      contestedCandidates: NO_CLAIMS,
      submissionWindowToleranceMs: TOLERANCE,
    });
    expect(codes(result.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_UNRESOLVED']);
    expect(categories(result.findings)).toEqual(['AMBIGUOUS']);
    expect(result.effects).toEqual([]);
  });

  it('records provable absence from a COMPLETE read as manual review, not as a silent failure', () => {
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: ambiguous,
      evidence: evidenceSet({ orders: [] }),
      alreadyClaimed: NO_CLAIMS,
      contestedCandidates: NO_CLAIMS,
      submissionWindowToleranceMs: TOLERANCE,
    });
    expect(codes(result.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_PROVEN_ABSENT']);
    expect(categories(result.findings)).toEqual(['MANUAL_REVIEW_REQUIRED']);
    // Crucially: it does NOT mark the order failed or release it for retry.
    expect(result.effects).toEqual([]);
  });

  it('refuses a unique candidate created outside the persisted submission window', () => {
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: durableOrder({ state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null, createdAtMs: 5_000_000, updatedAtMs: 5_001_000 }),
      evidence: evidenceSet({ orders: [venueOrder()] }),
      alreadyClaimed: NO_CLAIMS,
      contestedCandidates: NO_CLAIMS,
      submissionWindowToleranceMs: 0,
    });
    expect(codes(result.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_UNRESOLVED']);
    expect(result.effects).toEqual([]);
  });

  it('refuses a candidate carrying a status Phase17 never modelled', () => {
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: ambiguous,
      evidence: evidenceSet({ orders: [venueOrder({ venueStatus: 'untriggered' })] }),
      alreadyClaimed: NO_CLAIMS,
      contestedCandidates: NO_CLAIMS,
      submissionWindowToleranceMs: TOLERANCE,
    });
    expect(codes(result.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_UNRESOLVED']);
    expect(result.effects).toEqual([]);
  });
});

describe('P18 Wave B §F18-03 incomplete pagination must never resolve an ambiguous create [via resolveAmbiguousCreateAgainstObservableCandidates — see Wave B3 §F18-21 note above]', () => {
  const ambiguous = durableOrder({ state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null });

  function resolveWith(overrides: { readonly orders: readonly ReturnType<typeof venueOrder>[]; readonly complete: boolean }) {
    return resolveAmbiguousCreateAgainstObservableCandidates({
      order: ambiguous,
      evidence: evidenceSet({
        orders: overrides.orders,
        ordersProvenance: provenance({ complete: overrides.complete, incompleteReason: overrides.complete ? null : 'ORDER_PAGINATION_LIMIT_BUY' }),
      }),
      alreadyClaimed: NO_CLAIMS,
      contestedCandidates: NO_CLAIMS,
      submissionWindowToleranceMs: TOLERANCE,
    });
  }

  it('complete + exactly one exact candidate MAY resolve', () => {
    const result = resolveWith({ orders: [venueOrder()], complete: true });
    expect(codes(result.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_RESOLVED']);
    expect(result.effects).toHaveLength(1);
  });

  it('complete + zero candidates is a proven-absent manual review, never a resolve', () => {
    const result = resolveWith({ orders: [], complete: true });
    expect(codes(result.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_PROVEN_ABSENT']);
    expect(result.effects).toEqual([]);
  });

  it('complete + two exact candidates is unresolved regardless of completeness', () => {
    const result = resolveWith({
      orders: [venueOrder({ exchangeOrderId: 'venue-1' }), venueOrder({ exchangeOrderId: 'venue-2' })],
      complete: true,
    });
    expect(codes(result.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_MULTIPLE_CANDIDATES']);
    expect(result.effects).toEqual([]);
  });

  it('incomplete + zero candidates never infers a failed submission', () => {
    const result = resolveWith({ orders: [], complete: false });
    expect(codes(result.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_UNRESOLVED']);
    expect(result.effects).toEqual([]);
  });

  it('[F18-03 CORE] incomplete + exactly ONE candidate MUST NOT resolve: an unread page could hide a second match', () => {
    const result = resolveWith({ orders: [venueOrder()], complete: false });
    expect(codes(result.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_UNRESOLVED']);
    expect(categories(result.findings)).toEqual(['AMBIGUOUS']);
    // The decisive assertion: no durable economic adoption of any kind.
    expect(result.effects).toEqual([]);
    expect(result.claimedExchangeOrderIds).toEqual([]);
  });

  it('incomplete + many candidates never resolves (already refused by the >1 rule, reconfirmed under incompleteness)', () => {
    const result = resolveWith({
      orders: [venueOrder({ exchangeOrderId: 'venue-1' }), venueOrder({ exchangeOrderId: 'venue-2' })],
      complete: false,
    });
    expect(codes(result.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_MULTIPLE_CANDIDATES']);
    expect(result.effects).toEqual([]);
  });

  it.each([
    'ORDER_READ_FAILED_BUY_PAGE_2',
    'ORDER_PAGINATION_LIMIT_SELL',
    'ORDER_OUTSIDE_INR_SCOPE',
  ])('blocks resolution regardless of WHY the read is incomplete (%s)', (incompleteReason) => {
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: ambiguous,
      evidence: evidenceSet({
        orders: [venueOrder()],
        ordersProvenance: provenance({ complete: false, incompleteReason }),
      }),
      alreadyClaimed: NO_CLAIMS,
      contestedCandidates: NO_CLAIMS,
      submissionWindowToleranceMs: TOLERANCE,
    });
    expect(result.effects).toEqual([]);
  });
});

describe('P18 Wave B §F18-08 missing venue leverage is not an exact match for ambiguous-create identity [via resolveAmbiguousCreateAgainstObservableCandidates — see Wave B3 §F18-21 note above]', () => {
  const ambiguous = durableOrder({ state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null, leverage: '5' });

  function candidates(result: ReturnType<typeof resolveAmbiguousCreateAgainstObservableCandidates>) {
    return { codes: codes(result.findings), effects: result.effects };
  }

  it('local leverage known, venue leverage known and equal: eligible', () => {
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: ambiguous,
      evidence: evidenceSet({ orders: [venueOrder({ leverage: '5' })] }),
      alreadyClaimed: NO_CLAIMS, contestedCandidates: NO_CLAIMS, submissionWindowToleranceMs: TOLERANCE,
    });
    expect(candidates(result).codes).toEqual(['RECON_AMBIGUOUS_CREATE_RESOLVED']);
    expect(candidates(result).effects).toHaveLength(1);
  });

  it('local leverage known, venue leverage known and different: not eligible', () => {
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: ambiguous,
      evidence: evidenceSet({ orders: [venueOrder({ leverage: '10' })] }),
      alreadyClaimed: NO_CLAIMS, contestedCandidates: NO_CLAIMS, submissionWindowToleranceMs: TOLERANCE,
    });
    // No candidate matches at all, so this reads as proven-absent, never a resolve.
    expect(candidates(result).codes).toEqual(['RECON_AMBIGUOUS_CREATE_PROVEN_ABSENT']);
    expect(candidates(result).effects).toEqual([]);
  });

  it('[F18-08 CORE] local leverage known, venue leverage absent: NOT an exact match, never resolves', () => {
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: ambiguous,
      evidence: evidenceSet({ orders: [venueOrder({ leverage: null })] }),
      alreadyClaimed: NO_CLAIMS, contestedCandidates: NO_CLAIMS, submissionWindowToleranceMs: TOLERANCE,
    });
    // Absence of a venue candidate that would have exactly matched leaves the
    // order proven-absent from a complete read, not resolved to that candidate.
    expect(candidates(result).codes).toEqual(['RECON_AMBIGUOUS_CREATE_PROVEN_ABSENT']);
    expect(candidates(result).effects).toEqual([]);
    expect(result.claimedExchangeOrderIds).toEqual([]);
  });

  it('equivalent Decimal leverage strings resolve exactly (canonical equality, not textual)', () => {
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: durableOrder({ state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null, leverage: '5' }),
      evidence: evidenceSet({ orders: [venueOrder({ leverage: '5.0' })] }),
      alreadyClaimed: NO_CLAIMS, contestedCandidates: NO_CLAIMS, submissionWindowToleranceMs: TOLERANCE,
    });
    expect(candidates(result).codes).toEqual(['RECON_AMBIGUOUS_CREATE_RESOLVED']);
  });

  it('a tiny leverage difference is a mismatch, never rounded away', () => {
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: durableOrder({ state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null, leverage: '5' }),
      evidence: evidenceSet({ orders: [venueOrder({ leverage: '5.001' })] }),
      alreadyClaimed: NO_CLAIMS, contestedCandidates: NO_CLAIMS, submissionWindowToleranceMs: TOLERANCE,
    });
    expect(candidates(result).effects).toEqual([]);
  });

  it('matchesProvenEconomicsForAmbiguousCreate directly refuses missing venue leverage, unlike the lenient conflict-check predicate', () => {
    const order = durableOrder({ leverage: '5' });
    const candidate = venueOrder({ leverage: null });
    expect(matchesImmutableEconomics(order, candidate)).toBe(true);
    expect(matchesProvenEconomicsForAmbiguousCreate(order, candidate)).toBe(false);
  });

  it('local leverage null: not governed by the leverage rule (a local CLOSE binds none)', () => {
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: durableOrder({ state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null, leverage: null }),
      evidence: evidenceSet({ orders: [venueOrder({ leverage: null })] }),
      alreadyClaimed: NO_CLAIMS, contestedCandidates: NO_CLAIMS, submissionWindowToleranceMs: TOLERANCE,
    });
    expect(candidates(result).codes).toEqual(['RECON_AMBIGUOUS_CREATE_RESOLVED']);
  });

  it('one visible candidate but leverage missing must not resolve, even as the ONLY candidate present', () => {
    const result = resolveAmbiguousCreateAgainstObservableCandidates({
      order: ambiguous,
      evidence: evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'only-candidate', leverage: null })] }),
      alreadyClaimed: NO_CLAIMS, contestedCandidates: NO_CLAIMS, submissionWindowToleranceMs: TOLERANCE,
    });
    expect(result.effects).toEqual([]);
    expect(result.claimedExchangeOrderIds).toEqual([]);
  });
});

describe('P18 §8 reconciling an order already bound to a venue identity', () => {
  it('reports a verified match when both sides agree exactly', () => {
    const result = reconcileIdentifiedOrder(
      durableOrder({ state: 'ACKNOWLEDGED', cumulativeFilledQuantity: '0' }),
      evidenceSet({ orders: [venueOrder()] }),
    );
    expect(codes(result.findings)).toEqual(['RECON_ORDER_VERIFIED_MATCH']);
    expect(result.effects).toEqual([]);
  });

  it('advances on a strictly forward fill proven by the venue', () => {
    const result = reconcileIdentifiedOrder(
      durableOrder({ state: 'ACKNOWLEDGED', cumulativeFilledQuantity: '0' }),
      evidenceSet({ orders: [filledVenueOrder('0.2')] }),
    );
    expect(codes(result.findings)).toEqual(['RECON_ORDER_ADVANCED_FROM_VENUE']);
    expect(categories(result.findings)).toEqual(['SAFE_AUTHORITATIVE_ADVANCE']);
    expect(result.effects[0]).toMatchObject({ kind: 'APPLY_OBSERVATION' });
  });

  it('applies a LATE authoritative fill discovered only at reconciliation', () => {
    const result = reconcileIdentifiedOrder(
      durableOrder({ state: 'PARTIALLY_FILLED', cumulativeFilledQuantity: '0.2', averageFillPrice: '64000' }),
      evidenceSet({ orders: [filledVenueOrder('0.5')] }),
    );
    expect(result.effects[0]).toMatchObject({ kind: 'APPLY_OBSERVATION' });
    const effect = result.effects[0]!;
    expect(effect.kind === 'APPLY_OBSERVATION' && effect.observation.cumulativeFilledQuantity).toBe('0.5');
  });

  it('never decreases a durable fill; a venue regression is a CONFLICT', () => {
    const result = reconcileIdentifiedOrder(
      durableOrder({ state: 'PARTIALLY_FILLED', cumulativeFilledQuantity: '0.4', averageFillPrice: '64000' }),
      evidenceSet({ orders: [filledVenueOrder('0.1')] }),
    );
    expect(codes(result.findings)).toEqual(['RECON_ORDER_FILL_REGRESSION']);
    expect(categories(result.findings)).toEqual(['CONFLICT']);
    expect(result.effects).toEqual([]);
  });

  it('records an economics conflict rather than adopting the venue view', () => {
    const result = reconcileIdentifiedOrder(
      durableOrder({ orderedQuantity: '0.5' }),
      evidenceSet({ orders: [venueOrder({ orderedQuantity: '0.9', remainingQuantity: '0.9' })] }),
    );
    expect(codes(result.findings)).toEqual(['RECON_ORDER_ECONOMICS_CONFLICT']);
    expect(result.effects).toEqual([]);
  });

  it('flags a locally active order absent from a COMPLETE venue read', () => {
    const result = reconcileIdentifiedOrder(
      durableOrder({ state: 'ACKNOWLEDGED' }),
      evidenceSet({ orders: [] }),
    );
    expect(codes(result.findings)).toEqual(['RECON_ORDER_ABSENT_FROM_VENUE']);
    expect(categories(result.findings)).toEqual(['CONFLICT']);
  });

  it('does NOT treat absence from an INCOMPLETE read as evidence of anything', () => {
    const result = reconcileIdentifiedOrder(
      durableOrder({ state: 'ACKNOWLEDGED' }),
      evidenceSet({ orders: [], ordersProvenance: provenance({ complete: false, incompleteReason: 'ORDER_READ_FAILED_BUY_PAGE_2' }) }),
    );
    expect(codes(result.findings)).toEqual(['RECON_ORDER_ABSENCE_UNPROVEN']);
    expect(categories(result.findings)).toEqual(['AMBIGUOUS']);
  });

  it('accepts a terminal local order that has aged out of the venue view', () => {
    const result = reconcileIdentifiedOrder(
      durableOrder({ state: 'FILLED', cumulativeFilledQuantity: '0.5', averageFillPrice: '64000' }),
      evidenceSet({ orders: [] }),
    );
    expect(categories(result.findings)).toEqual(['VERIFIED_MATCH']);
  });

  it('never rewrites settled history: a contradicted terminal order is a CONFLICT', () => {
    const result = reconcileIdentifiedOrder(
      durableOrder({ state: 'CANCELLED', cumulativeFilledQuantity: '0' }),
      evidenceSet({ orders: [filledVenueOrder('0.5')] }),
    );
    expect(codes(result.findings)).toEqual(['RECON_ORDER_STATE_CONFLICT']);
    expect(categories(result.findings)).toEqual(['CONFLICT']);
    expect(result.effects).toEqual([]);
  });
});

describe('P18 §7 ambiguous cancellation recovery', () => {
  it('resolves an ambiguous cancel from the venue proving CANCELLED', () => {
    const result = reconcileIdentifiedOrder(
      durableOrder({ state: 'CANCEL_REQUESTED', cancelState: 'CANCEL_AMBIGUOUS' }),
      evidenceSet({ orders: [venueOrder({
        venueStatus: 'cancelled', filledQuantity: '0', remainingQuantity: '0', cancelledQuantity: '0.5',
      })] }),
    );
    expect(codes(result.findings)).toEqual(['RECON_CANCEL_RESOLVED_FROM_VENUE']);
    expect(result.effects[0]).toMatchObject({ kind: 'APPLY_OBSERVATION' });
  });

  it('resolves an ambiguous cancel that actually FILLED, preserving the fills', () => {
    const result = reconcileIdentifiedOrder(
      durableOrder({ state: 'CANCEL_REQUESTED', cancelState: 'CANCEL_AMBIGUOUS' }),
      evidenceSet({ orders: [filledVenueOrder('0.5')] }),
    );
    const effect = result.effects[0]!;
    expect(effect.kind === 'APPLY_OBSERVATION' && effect.observation.cumulativeFilledQuantity).toBe('0.5');
    expect(codes(result.findings)).toEqual(['RECON_CANCEL_RESOLVED_FROM_VENUE']);
  });

  it('resolves a still-open order from venue evidence and proposes NO resend of the cancel', () => {
    const result = reconcileIdentifiedOrder(
      durableOrder({ state: 'CANCEL_REQUESTED', cancelState: 'CANCEL_AMBIGUOUS' }),
      evidenceSet({ orders: [venueOrder({ venueStatus: 'open' })] }),
    );
    // The venue says it still rests exactly as before: authoritative proof the
    // cancel never took effect, resolved the same way any other advance is —
    // never as a resend. [P18 Wave A2 / F18-14] `CANCEL_REQUESTED -> ACKNOWLEDGED`
    // is what lets a crash-recovered `CANCEL_RESERVED` claim (wire never armed,
    // or armed but unaffected) resolve without a human, and the identical
    // comparison applies here.
    for (const effect of result.effects) expect(effect.kind).not.toBe('CANCEL');
    expect(result.effects[0]).toMatchObject({ kind: 'CLEAR_CANCEL_CLAIM' });
    expect(codes(result.findings)).toEqual(['RECON_CANCEL_RESOLVED_FROM_VENUE']);
    expect(categories(result.findings)).toEqual(['SAFE_AUTHORITATIVE_ADVANCE']);
  });

  it('leaves the outcome unresolved when the venue view cannot be established', () => {
    const result = reconcileIdentifiedOrder(
      durableOrder({ state: 'CANCEL_REQUESTED', cancelState: 'CANCEL_AMBIGUOUS' }),
      evidenceSet({ orders: [], ordersProvenance: provenance({ complete: false, incompleteReason: 'X' }) }),
    );
    expect(codes(result.findings)).toEqual(['RECON_ORDER_ABSENCE_UNPROVEN']);
    expect(result.effects).toEqual([]);
  });
});

describe('P18 §9 orphan detection', () => {
  it('classifies an unclaimed active venue order as an orphan', () => {
    const detection = detectOrphanVenueOrders(evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'stranger-1' })] }), NO_CLAIMS);
    expect(codes(detection.findings)).toEqual(['RECON_ORPHAN_VENUE_ORDER']);
    expect(categories(detection.findings)).toEqual(['ORPHAN']);
    expect(detection.orphans).toHaveLength(1);
  });

  it('never treats a claimed venue order as an orphan', () => {
    const detection = detectOrphanVenueOrders(evidenceSet({ orders: [venueOrder()] }), new Set(['venue-1']));
    expect(detection.orphans).toEqual([]);
    expect(detection.findings).toEqual([]);
  });

  it('ignores terminal venue orders, which cannot be adopted or cancelled anyway', () => {
    const detection = detectOrphanVenueOrders(
      evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'old-1', venueStatus: 'filled', filledQuantity: '0.5', remainingQuantity: '0', averageFillPrice: '1' })] }),
      NO_CLAIMS,
    );
    expect(detection.orphans).toEqual([]);
  });

  it('is pair-generic: an orphan on any pair is detected identically', () => {
    const detection = detectOrphanVenueOrders(
      evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'stranger-2', pair: OTHER_PAIR })] }),
      NO_CLAIMS,
    );
    expect(detection.orphans[0]?.pair).toBe(OTHER_PAIR);
    expect(detection.findings[0]?.subject.pair).toBe(OTHER_PAIR);
  });
});

describe('P18 observation translation', () => {
  it('never fabricates a venue client-order-id echo', () => {
    const observation = observationFromEvidence(durableOrder(), venueOrder());
    expect(observation?.exchangeClientOrderId).toBeNull();
    expect(observation?.clientOrderId).toBe(durableOrder().clientOrderId);
  });

  it('refuses a venue status Phase17 never modelled', () => {
    expect(observationFromEvidence(durableOrder(), venueOrder({ venueStatus: 'untriggered' }))).toBeNull();
    expect(observationFromEvidence(durableOrder(), venueOrder({ venueStatus: 'something_new' }))).toBeNull();
  });

  it('carries no average price when nothing filled', () => {
    expect(observationFromEvidence(durableOrder(), venueOrder())?.averageFillPrice).toBeNull();
  });

  it('is pair-generic', () => {
    const observation = observationFromEvidence(
      durableOrder({ pair: OTHER_PAIR }),
      venueOrder({ pair: OTHER_PAIR }),
    );
    expect(observation?.pair).toBe(OTHER_PAIR);
    expect(PAIR).not.toBe(OTHER_PAIR);
  });
});

describe('P18 Wave B2 §F18-20 incomplete evidence never advances a KNOWN venue-bound order', () => {
  const bound = durableOrder({ state: 'ACKNOWLEDGED', exchangeOrderId: 'venue-1', cumulativeFilledQuantity: '0' });

  function evidenceFor(overrides: { readonly complete: boolean; readonly incompleteReason?: string }) {
    return evidenceSet({
      orders: [filledVenueOrder('0.2', { exchangeOrderId: 'venue-1' })],
      ordersProvenance: provenance({ complete: overrides.complete, incompleteReason: overrides.complete ? null : (overrides.incompleteReason ?? 'ORDER_PAGINATION_LIMIT_BUY') }),
    });
  }

  it('[F18-20 CORE] a proven forward advance from a COMPLETE read applies normally (regression baseline)', () => {
    const result = reconcileIdentifiedOrder(bound, evidenceFor({ complete: true }));
    expect(codes(result.findings)).toEqual(['RECON_ORDER_ADVANCED_FROM_VENUE']);
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({ kind: 'APPLY_OBSERVATION' });
  });

  it('[F18-20 CORE] the exact same advance from an INCOMPLETE read is withheld entirely: zero effect', () => {
    const result = reconcileIdentifiedOrder(bound, evidenceFor({ complete: false }));
    expect(codes(result.findings)).toEqual(['RECON_ORDER_ADVANCE_WITHHELD_INCOMPLETE_EVIDENCE']);
    expect(categories(result.findings)).toEqual(['AMBIGUOUS']);
    expect(result.effects).toEqual([]);
    // The order id is still claimed for orphan-detection purposes (it IS
    // accounted for locally), even though its economics were not advanced.
    expect(result.claimedExchangeOrderIds).toEqual(['venue-1']);
  });

  it.each([
    'ORDER_READ_FAILED_BUY_PAGE_2',
    'ORDER_PAGINATION_LIMIT_SELL',
    'ORDER_OUTSIDE_INR_SCOPE',
    'NO_PAGES_READ',
  ])('withholds the advance regardless of WHY the read is incomplete (%s)', (incompleteReason) => {
    const result = reconcileIdentifiedOrder(bound, evidenceFor({ complete: false, incompleteReason }));
    expect(result.effects).toEqual([]);
    expect(codes(result.findings)).toEqual(['RECON_ORDER_ADVANCE_WITHHELD_INCOMPLETE_EVIDENCE']);
  });

  it('withholds a cancel-claim-clearing effect the same way', () => {
    const requested = durableOrder({
      state: 'CANCEL_REQUESTED', exchangeOrderId: 'venue-1', cancelState: 'CANCEL_RESERVED', cumulativeFilledQuantity: '0',
    });
    const stillOpen = evidenceSet({
      orders: [venueOrder({ exchangeOrderId: 'venue-1', venueStatus: 'open' })],
      ordersProvenance: provenance({ complete: false, incompleteReason: 'ORDER_READ_FAILED_SELL_PAGE_1' }),
    });
    const result = reconcileIdentifiedOrder(requested, stillOpen);
    expect(codes(result.findings)).toEqual(['RECON_ORDER_ADVANCE_WITHHELD_INCOMPLETE_EVIDENCE']);
    expect(result.effects).toEqual([]);
  });

  it('applies the cancel-claim-clearing effect once the read is complete (regression baseline)', () => {
    const requested = durableOrder({
      state: 'CANCEL_REQUESTED', exchangeOrderId: 'venue-1', cancelState: 'CANCEL_RESERVED', cumulativeFilledQuantity: '0',
    });
    const stillOpen = evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'venue-1', venueStatus: 'open' })] });
    const result = reconcileIdentifiedOrder(requested, stillOpen);
    expect(codes(result.findings)).toEqual(['RECON_CANCEL_RESOLVED_FROM_VENUE']);
    expect(result.effects).toEqual([{ kind: 'CLEAR_CANCEL_CLAIM', intentId: requested.intentId }]);
  });

  it('a VERIFIED_MATCH (no economic change either way) is unaffected by incompleteness: it never produced an effect', () => {
    const settled = durableOrder({ state: 'ACKNOWLEDGED', exchangeOrderId: 'venue-1', cumulativeFilledQuantity: '0' });
    const identical = evidenceSet({
      orders: [venueOrder({ exchangeOrderId: 'venue-1', venueStatus: 'open' })],
      ordersProvenance: provenance({ complete: false, incompleteReason: 'ORDER_PAGINATION_LIMIT_BUY' }),
    });
    const result = reconcileIdentifiedOrder(settled, identical);
    expect(codes(result.findings)).toEqual(['RECON_ORDER_VERIFIED_MATCH']);
    expect(result.effects).toEqual([]);
  });

  it('an economics-conflict CONFLICT finding (no effect either way) still fires under incomplete evidence', () => {
    const local = durableOrder({ state: 'ACKNOWLEDGED', exchangeOrderId: 'venue-1', orderedQuantity: '0.5' });
    const conflicting = evidenceSet({
      orders: [venueOrder({ exchangeOrderId: 'venue-1', orderedQuantity: '0.9', remainingQuantity: '0.9' })],
      ordersProvenance: provenance({ complete: false, incompleteReason: 'ORDER_PAGINATION_LIMIT_BUY' }),
    });
    const result = reconcileIdentifiedOrder(local, conflicting);
    expect(codes(result.findings)).toEqual(['RECON_ORDER_ECONOMICS_CONFLICT']);
    expect(result.effects).toEqual([]);
  });
});

describe('P18 Wave B3 §F18-21 TIF is unobservable for EVERY local value: automatic identity resolution is unconditionally blocked', () => {
  // [Wave B3 correction] Wave B2 exempted UNSPECIFIED/GOOD_TILL_CANCEL on the
  // theory that CoinDCX's documentation makes them venue-indistinguishable.
  // Independent review rejected that: this project holds no AUTHORITATIVE,
  // independently-verified proof of that default strong enough to found a
  // durable identity binding on. The corrected rule has no exemption at all.
  const REQUIRED_MATRIX = [
    'GOOD_TILL_CANCEL',
    'UNSPECIFIED',
    'IMMEDIATE_OR_CANCEL',
    'FILL_OR_KILL',
    'POST_ONLY',
  ] as const;

  it.each(REQUIRED_MATRIX)('classifies local TIF %s as unobservable, unconditionally', (timeInForce) => {
    expect(ambiguousCreateIdentityUnobservableReason(durableOrder({ timeInForce }))).toBe('TIME_IN_FORCE_UNOBSERVABLE');
  });

  it.each(REQUIRED_MATRIX)(
    '[F18-21 REQUIRED MATRIX] local TIF %s: resolveAmbiguousCreate NEVER automatically binds an exchangeOrderId, even against an otherwise-perfect single candidate',
    (timeInForce) => {
      const order = durableOrder({ state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null, timeInForce });
      const result = resolveAmbiguousCreate({
        order,
        evidence: evidenceSet({ orders: [venueOrder()] }),
        alreadyClaimed: NO_CLAIMS,
        contestedCandidates: NO_CLAIMS,
        submissionWindowToleranceMs: TOLERANCE,
      });
      expect(codes(result.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE']);
      expect(categories(result.findings)).toEqual(['MANUAL_REVIEW_REQUIRED']);
      expect(result.effects).toEqual([]);
      expect(result.claimedExchangeOrderIds).toEqual([]);
    },
  );

  it('the TIF refusal applies even with ZERO or MULTIPLE candidates: it precedes candidate counting entirely', () => {
    const order = durableOrder({ state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null, timeInForce: 'UNSPECIFIED' });
    const zero = resolveAmbiguousCreate({
      order, evidence: evidenceSet({ orders: [] }),
      alreadyClaimed: NO_CLAIMS, contestedCandidates: NO_CLAIMS, submissionWindowToleranceMs: TOLERANCE,
    });
    expect(codes(zero.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE']);
    const many = resolveAmbiguousCreate({
      order,
      evidence: evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'a' }), venueOrder({ exchangeOrderId: 'b' })] }),
      alreadyClaimed: NO_CLAIMS, contestedCandidates: NO_CLAIMS, submissionWindowToleranceMs: TOLERANCE,
    });
    expect(codes(many.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE']);
  });

  it('the refusal applies even with INCOMPLETE evidence: TIF-unobservability precedes the completeness gate too', () => {
    const order = durableOrder({ state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null, timeInForce: 'GOOD_TILL_CANCEL' });
    const result = resolveAmbiguousCreate({
      order,
      evidence: evidenceSet({
        orders: [venueOrder()],
        ordersProvenance: provenance({ complete: false, incompleteReason: 'ORDER_PAGINATION_LIMIT_BUY' }),
      }),
      alreadyClaimed: NO_CLAIMS, contestedCandidates: NO_CLAIMS, submissionWindowToleranceMs: TOLERANCE,
    });
    expect(codes(result.findings)).toEqual(['RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE']);
  });

  it('the finding means "may match observable economics, but exact identity unproven" — never silently absorbed as a plain absence/ambiguity code', () => {
    const order = durableOrder({ state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null, timeInForce: 'FILL_OR_KILL' });
    // A candidate that matches EVERY other observable field exactly.
    const perfectExceptTif = venueOrder({ exchangeOrderId: 'economically-perfect' });
    const result = resolveAmbiguousCreate({
      order,
      evidence: evidenceSet({ orders: [perfectExceptTif] }),
      alreadyClaimed: NO_CLAIMS, contestedCandidates: NO_CLAIMS, submissionWindowToleranceMs: TOLERANCE,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.code).toBe('RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE');
    expect(result.findings[0]?.category).toBe('MANUAL_REVIEW_REQUIRED');
    // No binding, no fill adoption, no ownership derivation, no retry
    // authorization: the effect list is the durable proof of all four.
    expect(result.effects).toEqual([]);
    expect(result.claimedExchangeOrderIds).toEqual([]);
  });

  it('matchesProvenEconomicsForAmbiguousCreate no longer encodes the TIF rule (it lives one level up, unconditionally, in the gate)', () => {
    // [Wave B3] This function now ONLY encodes F18-08 leverage-provability.
    // TIF blocking is the caller's (`resolveAmbiguousCreate`'s) job, checked
    // BEFORE this function is ever reached — see the describe block above.
    const order = durableOrder({ timeInForce: 'FILL_OR_KILL' });
    const candidate = venueOrder();
    expect(matchesImmutableEconomics(order, candidate)).toBe(true);
    expect(matchesProvenEconomicsForAmbiguousCreate(order, candidate)).toBe(true);
  });

  it('does not regress F18-08: missing venue leverage remains refused independent of TIF', () => {
    const order = durableOrder({ timeInForce: 'UNSPECIFIED', leverage: '5' });
    expect(matchesProvenEconomicsForAmbiguousCreate(order, venueOrder({ leverage: null }))).toBe(false);
    expect(matchesProvenEconomicsForAmbiguousCreate(order, venueOrder({ leverage: '5' }))).toBe(true);
    expect(matchesProvenEconomicsForAmbiguousCreate(order, venueOrder({ leverage: '10' }))).toBe(false);
  });
});
