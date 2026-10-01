import { describe, expect, it } from 'vitest';
import type { LivePracticalCancelBindingView } from '../../../../../src/execution/live/practical-cancel-binding';
import { findingSha256 } from '../../../../../src/execution/live/reconciliation/findings';
import {
  planClaimRecovery,
  practicalCancelBindingFinding,
  reconcileIdentifiedOrder,
  resolveAmbiguousCreate,
} from '../../../../../src/execution/live/reconciliation/order-reconciliation';
import type { LiveDurableOrderView } from '../../../../../src/execution/live/reconciliation/ports';
import { ACCOUNT, durableOrder, evidenceSet, provenance, venueOrder } from './helpers';

// [P18B Stage 1B2 Wave 2B2a] Phase18 planning never reclaims, clears, or folds a cancel claim whose CURRENT
// generation is practically bound (LEASED), practically ambiguous (COMPLETED AMBIGUOUS + CANCEL_AMBIGUOUS), or
// split. A historical PRE_DISPATCH_FAILURE binding whose claim is NONE never blocks. Every blocked case below is
// paired with the UNBOUND control that DOES produce the effect, so the binding is what suppresses it.

const INTENT = `${'0'.repeat(62)}01`;
const CLIENT = `p17-${'0'.repeat(30)}01`;

function binding(overrides: Partial<LivePracticalCancelBindingView> = {}): LivePracticalCancelBindingView {
  return Object.freeze({
    leaseId: 'lease-2b2a', accountId: ACCOUNT, intentId: INTENT, clientOrderId: CLIENT, cancelGeneration: 1,
    status: 'LEASED', outcome: null, armedAtMs: null, ...overrides,
  });
}

const LEASED_UNARMED = binding();
const LEASED_ARMED = binding({ armedAtMs: 1_000 });
const COMPLETED_AMBIGUOUS = binding({ status: 'COMPLETED', outcome: 'AMBIGUOUS', armedAtMs: 1_000 });
const COMPLETED_PRE_DISPATCH = binding({ status: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });

/** A CANCEL_REQUESTED order, as a cancel claim leaves it. */
function cancelRequested(overrides: Partial<LiveDurableOrderView>): LiveDurableOrderView {
  return durableOrder({ state: 'CANCEL_REQUESTED', ...overrides });
}

const OPEN = evidenceSet({ orders: [venueOrder()] });
const CANCELLED = evidenceSet({ orders: [venueOrder({ venueStatus: 'cancelled', remainingQuantity: '0', cancelledQuantity: '0.5' })] });
const FILLED = evidenceSet({ orders: [venueOrder({ venueStatus: 'filled', filledQuantity: '0.5', remainingQuantity: '0', averageFillPrice: '64000' })] });

describe('A. a LEASED current-generation binding: finding once, ZERO effects', () => {
  it('unarmed CANCEL_RESERVED: planClaimRecovery would RECLAIM_CANCEL unbound, but raises the bound finding instead', () => {
    const unbound = cancelRequested({ cancelState: 'CANCEL_RESERVED' });
    expect(planClaimRecovery([unbound]).effects).toEqual([{ kind: 'RECLAIM_CANCEL', intentId: INTENT }]);

    const plan = planClaimRecovery([{ ...unbound, practicalCancelBinding: LEASED_UNARMED }]);
    expect(plan.effects).toEqual([]);
    expect(plan.findings).toHaveLength(1);
    expect(plan.findings[0]).toMatchObject({
      category: 'AMBIGUOUS', code: 'RECON_CANCEL_CLAIM_PRACTICALLY_BOUND',
      subject: { intentId: INTENT, exchangeOrderId: 'venue-1' },
      evidence: { leaseId: 'lease-2b2a', cancelGeneration: 1, leaseStatus: 'LEASED', leaseOutcome: null, leaseArmed: false, cancelState: 'CANCEL_RESERVED' },
    });
  });

  it.each([
    ['still open (unbound: CLEAR_CANCEL_CLAIM)', OPEN, 'CLEAR_CANCEL_CLAIM'],
    ['cancelled (unbound: APPLY_OBSERVATION clearing the claim)', CANCELLED, 'APPLY_OBSERVATION'],
    ['filled (unbound: APPLY_OBSERVATION clearing the claim)', FILLED, 'APPLY_OBSERVATION'],
  ])('armed CANCEL_RESERVED, venue %s: zero effects, zero duplicate findings, exchange id still claimed', (_label, evidence, unboundEffect) => {
    const unbound = cancelRequested({ cancelState: 'CANCEL_RESERVED', cancelWireArmed: true });
    expect(reconcileIdentifiedOrder(unbound, evidence).effects.map((effect) => effect.kind)).toEqual([unboundEffect]);

    const bound = { ...unbound, practicalCancelBinding: LEASED_ARMED };
    const result = reconcileIdentifiedOrder(bound, evidence);
    expect(result.effects).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.claimedExchangeOrderIds).toEqual(['venue-1']);
    expect(planClaimRecovery([bound]).findings.map((finding) => finding.code)).toEqual(['RECON_CANCEL_CLAIM_PRACTICALLY_BOUND']);
    expect(planClaimRecovery([bound]).effects).toEqual([]);
  });
});

describe('Blocker 1. a completed practical AMBIGUOUS cancel stays CANCEL_AMBIGUOUS', () => {
  const unbound = cancelRequested({ cancelState: 'CANCEL_AMBIGUOUS' });
  const sticky = { ...unbound, practicalCancelBinding: COMPLETED_AMBIGUOUS };

  it.each([
    ['an "order still open" observation (unbound: CLEAR_CANCEL_CLAIM)', OPEN, 'CLEAR_CANCEL_CLAIM'],
    ['a cancelled observation (unbound: APPLY_OBSERVATION)', CANCELLED, 'APPLY_OBSERVATION'],
    ['a filled observation (unbound: APPLY_OBSERVATION)', FILLED, 'APPLY_OBSERVATION'],
  ])('%s: ZERO effects', (_label, evidence, unboundEffect) => {
    expect(reconcileIdentifiedOrder(unbound, evidence).effects.map((effect) => effect.kind)).toEqual([unboundEffect]);
    expect(reconcileIdentifiedOrder(sticky, evidence).effects).toEqual([]);
  });

  it('elapsed time is not proof: an evaluation arbitrarily far in the future still produces no effect', () => {
    for (const later of [OPEN, CANCELLED, FILLED].map((evidence) => ({ ...evidence, evaluatedAtMs: evidence.evaluatedAtMs + 365 * 86_400_000 }))) {
      expect(reconcileIdentifiedOrder(sticky, later).effects).toEqual([]);
    }
  });

  it('planClaimRecovery raises exactly one blocking AMBIGUITY_UNRESOLVED finding and no effect', () => {
    const plan = planClaimRecovery([sticky]);
    expect(plan.effects).toEqual([]);
    expect(plan.findings).toHaveLength(1);
    expect(plan.findings[0]).toMatchObject({
      category: 'AMBIGUOUS', code: 'RECON_PRACTICAL_CANCEL_AMBIGUITY_UNRESOLVED',
      evidence: { leaseStatus: 'COMPLETED', leaseOutcome: 'AMBIGUOUS', leaseArmed: true, cancelState: 'CANCEL_AMBIGUOUS' },
    });
  });

  it('the finding is deterministic across runs (same durable digest, no time in its evidence)', () => {
    const first = practicalCancelBindingFinding(sticky)!;
    const second = practicalCancelBindingFinding({ ...sticky, updatedAtMs: sticky.updatedAtMs + 99_999 })!;
    expect(findingSha256(ACCOUNT, first)).toBe(findingSha256(ACCOUNT, second));
  });
});

describe('C. a HISTORICAL PRE_DISPATCH_FAILURE binding with a NONE claim never blocks', () => {
  it('ordinary planning proceeds exactly as unbound (the finding is null, effects identical)', () => {
    const unbound = cancelRequested({ cancelState: 'NONE' });
    const historical = { ...unbound, practicalCancelBinding: COMPLETED_PRE_DISPATCH };
    expect(practicalCancelBindingFinding(historical)).toBeNull();
    for (const evidence of [OPEN, CANCELLED, FILLED]) {
      expect(reconcileIdentifiedOrder(historical, evidence)).toEqual(reconcileIdentifiedOrder(unbound, evidence));
    }
    expect(planClaimRecovery([historical])).toEqual(planClaimRecovery([unbound]));
    expect(reconcileIdentifiedOrder(historical, CANCELLED).effects).toEqual([
      expect.objectContaining({ kind: 'APPLY_OBSERVATION', clearsCancelClaim: false }),
    ]);
  });
});

describe('B / C-prime. split practical bindings: blocking MANUAL_REVIEW finding, ZERO effects', () => {
  it.each([
    ['COMPLETED PRE_DISPATCH_FAILURE while still CANCEL_RESERVED', COMPLETED_PRE_DISPATCH, 'CANCEL_RESERVED'],
    ['COMPLETED AMBIGUOUS while still CANCEL_RESERVED', COMPLETED_AMBIGUOUS, 'CANCEL_RESERVED'],
    ['COMPLETED PRE_DISPATCH_FAILURE while CANCEL_AMBIGUOUS', COMPLETED_PRE_DISPATCH, 'CANCEL_AMBIGUOUS'],
    ['COMPLETED AMBIGUOUS while NONE', COMPLETED_AMBIGUOUS, 'NONE'],
    ['COMPLETED AMBIGUOUS while CANCEL_ACKNOWLEDGED', COMPLETED_AMBIGUOUS, 'CANCEL_ACKNOWLEDGED'],
    ['COMPLETED REJECTED with wrong claim', binding({ status: 'COMPLETED', outcome: 'REJECTED', armedAtMs: 1_000 }), 'CANCEL_ACKNOWLEDGED'],
    ['COMPLETED ACCEPTED with wrong claim', binding({ status: 'COMPLETED', outcome: 'ACCEPTED', armedAtMs: 1_000 }), 'CANCEL_REJECTED'],
  ] as const)('%s', (_label, practical, cancelState) => {
    const order = cancelRequested({ cancelState, practicalCancelBinding: practical });
    const plan = planClaimRecovery([order]);
    expect(plan.effects).toEqual([]);
    expect(plan.findings).toEqual([expect.objectContaining({ category: 'MANUAL_REVIEW_REQUIRED', code: 'RECON_PRACTICAL_CANCEL_BINDING_SPLIT' })]);
    for (const evidence of [OPEN, CANCELLED, FILLED]) expect(reconcileIdentifiedOrder(order, evidence).effects).toEqual([]);
  });
});

describe('D. no binding: ordinary Phase18 behavior is unchanged', () => {
  it('null binding yields no practical finding and the pre-2B2a planner output', () => {
    const order = cancelRequested({ cancelState: 'CANCEL_RESERVED' });
    expect(practicalCancelBindingFinding(order)).toBeNull();
    expect(planClaimRecovery([order]).findings.map((finding) => finding.code)).toEqual(['RECON_CANCEL_RESERVATION_RECLAIMED']);
  });
});

describe('ambiguous-create resolution is defensive for a (never legitimate) bound view', () => {
  it('returns zero effects and zero findings', () => {
    const order = durableOrder({
      state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null, cancelState: 'CANCEL_RESERVED', practicalCancelBinding: LEASED_UNARMED,
    });
    const result = resolveAmbiguousCreate({
      order, evidence: evidenceSet({ orders: [venueOrder({ clientOrderId: CLIENT })], ordersProvenance: provenance() }),
      alreadyClaimed: new Set(), contestedCandidates: new Set(), submissionWindowToleranceMs: 60_000,
    });
    expect(result.effects).toEqual([]);
    expect(result.findings).toEqual([]);
  });
});
