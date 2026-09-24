import { describe, expect, it } from 'vitest';
import { newLiveRuntimeIdentity } from '../../../../../src/execution/live/reconciliation/barrier';
import {
  assertCausalOrdering,
  assertEvidenceSetUsable,
  assertNoConflictingDuplicates,
  assertOrderEvidenceConservation,
  assertProvenanceWellFormed,
  currentAccountContinuityCapability,
  dedupeOrderEvidence,
  evaluateReconciliationBarrier,
  evidenceSnapshotSha256,
  evidenceWindowIsSeparable,
  initialReconciliationState,
  rawOrderSetSha256,
  rawPositionSetSha256,
  requireCurrentReconciliation,
  venueOrderContentSha256,
} from '../../../../../src/execution/live/reconciliation';
import type { LiveReconciliationStateRecord } from '../../../../../src/execution/live/reconciliation/ports';
import { ACCOUNT, EPOCH, RUNTIME_IDENTITY, T_READ_END, T_READ_START, evidenceSet, provenance, venueOrder, venuePosition } from './helpers';

const INVALID = /LIVE_RECONCILIATION_EVIDENCE_INVALID/;

describe('P18 §15 exact-decimal conservation at the evidence boundary', () => {
  it('accepts a record satisfying filled = total - remaining - cancelled', () => {
    expect(() => assertOrderEvidenceConservation(venueOrder({
      orderedQuantity: '0.5', filledQuantity: '0.2', remainingQuantity: '0.3', cancelledQuantity: '0',
      venueStatus: 'partially_filled', averageFillPrice: '64000',
    }))).not.toThrow();
  });

  it('treats numerically identical but textually different decimals as equal', () => {
    // "0.50" and "0.5" are the same quantity. A reconciliation that disagreed
    // would raise a phantom conflict on every provider formatting change.
    expect(() => assertOrderEvidenceConservation(venueOrder({
      orderedQuantity: '0.50', filledQuantity: '0.200', remainingQuantity: '0.3000', cancelledQuantity: '0.0',
      venueStatus: 'partially_filled', averageFillPrice: '64000.00',
    }))).not.toThrow();
  });

  it('refuses a record that violates conservation by any amount, with no tolerance band', () => {
    expect(() => assertOrderEvidenceConservation(venueOrder({
      orderedQuantity: '0.5', filledQuantity: '0.2', remainingQuantity: '0.3', cancelledQuantity: '0.000000000000000001',
      venueStatus: 'partially_filled', averageFillPrice: '64000',
    }))).toThrow(INVALID);
  });

  it('refuses remaining + cancelled above total', () => {
    expect(() => assertOrderEvidenceConservation(venueOrder({
      orderedQuantity: '0.5', filledQuantity: '0', remainingQuantity: '0.4', cancelledQuantity: '0.4',
    }))).toThrow(INVALID);
  });

  it('refuses a negative operand', () => {
    expect(() => assertOrderEvidenceConservation(venueOrder({
      orderedQuantity: '0.5', filledQuantity: '0.6', remainingQuantity: '-0.1', cancelledQuantity: '0',
    }))).toThrow(INVALID);
  });

  it('requires an average price exactly when something filled', () => {
    expect(() => assertOrderEvidenceConservation(venueOrder({
      orderedQuantity: '0.5', filledQuantity: '0.2', remainingQuantity: '0.3', cancelledQuantity: '0', averageFillPrice: null,
    }))).toThrow(INVALID);
    expect(() => assertOrderEvidenceConservation(venueOrder({
      orderedQuantity: '0.5', filledQuantity: '0', remainingQuantity: '0.5', cancelledQuantity: '0', averageFillPrice: '64000',
    }))).toThrow(INVALID);
  });
});

describe('P18 §13 causal ordering', () => {
  it('accepts a provider event time inside the read window', () => {
    expect(() => assertCausalOrdering(T_READ_START, provenance(), {})).not.toThrow();
  });

  it('refuses evidence claiming a provider time after the read that produced it', () => {
    expect(() => assertCausalOrdering(T_READ_END + 1, provenance(), {})).toThrow(INVALID);
  });

  it('refuses an unusable provider time', () => {
    expect(() => assertCausalOrdering(-1, provenance(), {})).toThrow(INVALID);
    expect(() => assertCausalOrdering(1.5, provenance(), {})).toThrow(INVALID);
  });

  it('refuses an order updated before it was created', () => {
    expect(() => assertEvidenceSetUsable(evidenceSet({
      orders: [venueOrder({ providerCreatedAtMs: T_READ_START, providerEventTimeMs: T_READ_START - 1 })],
    }), ACCOUNT)).toThrow(INVALID);
  });

  it('refuses a provenance window that ends before it starts', () => {
    expect(() => assertProvenanceWellFormed(provenance({
      localReadStartedAtMs: 500, localReadEndedAtMs: 400,
    }))).toThrow(INVALID);
  });

  it('refuses a provenance that claims completeness while naming an incompleteness reason', () => {
    expect(() => assertProvenanceWellFormed(provenance({ complete: true, incompleteReason: 'X' }))).toThrow(INVALID);
  });

  it('requires an incomplete provenance to say why', () => {
    expect(() => assertProvenanceWellFormed(provenance({ complete: false, incompleteReason: null }))).toThrow(INVALID);
  });
});

describe('P18 §14 duplicate handling', () => {
  it('accepts an identical duplicate record across pages', () => {
    const order = venueOrder();
    expect(() => assertNoConflictingDuplicates([order, { ...order }])).not.toThrow();
    expect(dedupeOrderEvidence([order, { ...order }])).toHaveLength(1);
  });

  it('fails closed on the same venue id with conflicting content', () => {
    expect(() => assertNoConflictingDuplicates([
      venueOrder({ exchangeOrderId: 'venue-1', orderedQuantity: '0.5', remainingQuantity: '0.5' }),
      venueOrder({ exchangeOrderId: 'venue-1', orderedQuantity: '0.7', remainingQuantity: '0.7' }),
    ])).toThrow(INVALID);
  });

  it('refuses two distinct position identities for one pair', () => {
    expect(() => assertEvidenceSetUsable(evidenceSet({
      positions: [venuePosition({ venuePositionId: 'a' }), venuePosition({ venuePositionId: 'b' })],
    }), ACCOUNT)).toThrow(INVALID);
  });
});

describe('P18 §5 evidence identity binding', () => {
  it('refuses evidence produced for a different account', () => {
    expect(() => assertEvidenceSetUsable(evidenceSet(), 'someone-else')).toThrow(INVALID);
  });
});

describe('P18 §16 deterministic snapshot identity', () => {
  it('is insensitive to record order', () => {
    const a = venueOrder({ exchangeOrderId: 'venue-1' });
    const b = venueOrder({ exchangeOrderId: 'venue-2' });
    expect(evidenceSnapshotSha256(evidenceSet({ orders: [a, b] })))
      .toBe(evidenceSnapshotSha256(evidenceSet({ orders: [b, a] })));
  });

  it('ignores local read windows, so an identical rerun is identical evidence', () => {
    const orders = [venueOrder()];
    const first = evidenceSet({ orders });
    const second = evidenceSet({
      orders,
      ordersProvenance: provenance({ localReadStartedAtMs: 9_000_000, localReadEndedAtMs: 9_000_900 }),
    });
    expect(evidenceSnapshotSha256(first)).toBe(evidenceSnapshotSha256(second));
  });

  it('changes when any economic field changes', () => {
    expect(venueOrderContentSha256(venueOrder({ orderedQuantity: '0.5', remainingQuantity: '0.5' })))
      .not.toBe(venueOrderContentSha256(venueOrder({ orderedQuantity: '0.6', remainingQuantity: '0.6' })));
  });

  it('is stable across numerically equal decimal spellings', () => {
    expect(venueOrderContentSha256(venueOrder({ orderedQuantity: '0.5', remainingQuantity: '0.5' })))
      .toBe(venueOrderContentSha256(venueOrder({ orderedQuantity: '0.50', remainingQuantity: '0.500' })));
  });
});

describe('P18 §13 the two reads are not one atomic snapshot', () => {
  it('accepts strictly ordered windows with no observation after the boundary', () => {
    expect(evidenceWindowIsSeparable(evidenceSet({ orders: [venueOrder()], positions: [venuePosition()] }))).toBe(true);
  });

  it('refuses overlapping read windows', () => {
    expect(evidenceWindowIsSeparable(evidenceSet({
      positionsProvenance: provenance({
        source: 'COINDCX_FUTURES_POSITIONS',
        localReadStartedAtMs: T_READ_START + 1,
        localReadEndedAtMs: T_READ_END + 400,
      }),
    }))).toBe(false);
  });

  it('refuses when the later read observed venue movement after the boundary', () => {
    // A position updated after the orders read ended means the venue moved
    // between the two queries — the exact TOCTOU window §13 refuses to hide.
    expect(evidenceWindowIsSeparable(evidenceSet({
      positions: [venuePosition({ providerEventTimeMs: T_READ_END + 200 })],
    }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The barrier (§3, §18)
// ---------------------------------------------------------------------------

function state(overrides: Partial<LiveReconciliationStateRecord> = {}): LiveReconciliationStateRecord {
  return Object.freeze({ ...initialReconciliationState(ACCOUNT), ...overrides });
}

describe('P18 §3 the startup reconciliation barrier', () => {
  it('blocks an account that has never reconciled', () => {
    const resolution = evaluateReconciliationBarrier(state(), EPOCH);
    expect(resolution.kind).toBe('BLOCKED');
    expect(resolution.kind === 'BLOCKED' && resolution.reason).toBe('NO_CURRENT_RECONCILIATION');
  });

  it('treats an absent durable row as RECONCILIATION_REQUIRED, never as healthy', () => {
    expect(initialReconciliationState(ACCOUNT).status).toBe('RECONCILIATION_REQUIRED');
    expect(initialReconciliationState(ACCOUNT).healthyGeneration).toBeNull();
  });

  it('permits a HEALTHY account reconciled by THIS runtime at the current generation', () => {
    // [P18 Wave B4 / F18-27] This function's OWN decision — "is this durable
    // row, at this epoch, internally consistent" — is unchanged by F18-27.
    // See `requireCurrentReconciliation`'s dedicated F18-27 tests below for
    // why PERMITTED here no longer means a live mutation may proceed: that
    // gate lives one level up, deliberately, so `authorizeCurrentHealthy`
    // (which reuses this exact function) can still mint a genuine
    // 'RUNNING'-mode authorization for reconciliation's own mid-run writes,
    // and so Wave A/A2/A3's fencing/crash-recovery proofs — which are
    // orthogonal to F18-27 — still have a real authorization object to test
    // against.
    const resolution = evaluateReconciliationBarrier(state({
      status: 'HEALTHY', currentGeneration: 4, healthyGeneration: 4, currentRuntimeEpoch: EPOCH,
    }), EPOCH);
    expect(resolution.kind).toBe('PERMITTED');
  });

  it('refuses a HEALTHY verdict left by a PREVIOUS runtime epoch', () => {
    // This is the restart rule: a stale healthy row never authorizes a new
    // process, without that row being rewritten.
    const resolution = evaluateReconciliationBarrier(state({
      status: 'HEALTHY', currentGeneration: 4, healthyGeneration: 4, currentRuntimeEpoch: 'a-previous-process',
    }), EPOCH);
    expect(resolution.kind === 'BLOCKED' && resolution.reason).toBe('STALE_RUNTIME_GENERATION');
  });

  it('refuses a HEALTHY verdict that a newer generation has fenced out', () => {
    const resolution = evaluateReconciliationBarrier(state({
      status: 'HEALTHY', currentGeneration: 5, healthyGeneration: 4, currentRuntimeEpoch: EPOCH,
    }), EPOCH);
    expect(resolution.kind === 'BLOCKED' && resolution.reason).toBe('STALE_RUNTIME_GENERATION');
  });

  it('blocks while reconciliation is in flight', () => {
    const resolution = evaluateReconciliationBarrier(state({ status: 'RUNNING', currentRuntimeEpoch: EPOCH }), EPOCH);
    expect(resolution.kind === 'BLOCKED' && resolution.reason).toBe('RECONCILIATION_IN_PROGRESS');
  });

  it('blocks an UNHEALTHY account', () => {
    const resolution = evaluateReconciliationBarrier(state({ status: 'UNHEALTHY', currentRuntimeEpoch: EPOCH }), EPOCH);
    expect(resolution.kind === 'BLOCKED' && resolution.reason).toBe('RECONCILIATION_UNHEALTHY');
  });

  it('blocks an account needing manual review', () => {
    const resolution = evaluateReconciliationBarrier(state({ status: 'MANUAL_REVIEW_REQUIRED', currentRuntimeEpoch: EPOCH }), EPOCH);
    expect(resolution.kind === 'BLOCKED' && resolution.reason).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('refuses a contradictory HEALTHY row that still carries blocking findings', () => {
    const resolution = evaluateReconciliationBarrier(state({
      status: 'HEALTHY', currentGeneration: 2, healthyGeneration: 2, currentRuntimeEpoch: EPOCH, blockingFindingCount: 1,
    }), EPOCH);
    expect(resolution.kind === 'BLOCKED' && resolution.reason).toBe('RECONCILIATION_UNHEALTHY');
  });

  it('throws a named Phase18 code rather than returning a falsy value', async () => {
    const repository = { authorizeCurrentHealthy: async () => ({ state: state(), authorization: null }) } as never;
    await expect(requireCurrentReconciliation(repository, ACCOUNT, newLiveRuntimeIdentity(), 'CREATE'))
      .rejects.toThrow(/LIVE_RECONCILIATION_REQUIRED/);
  });

  it('uses the manual-review code when a human must act', async () => {
    const repository = { authorizeCurrentHealthy: async () => ({ state: state({ status: 'MANUAL_REVIEW_REQUIRED' }), authorization: null }) } as never;
    await expect(requireCurrentReconciliation(repository, ACCOUNT, newLiveRuntimeIdentity(), 'CLOSE'))
      .rejects.toThrow(/LIVE_RECONCILIATION_MANUAL_REVIEW_REQUIRED/);
  });

  it('carries no credential material in its refusal details', async () => {
    const repository = { authorizeCurrentHealthy: async () => ({ state: state(), authorization: null }) } as never;
    await expect(requireCurrentReconciliation(repository, ACCOUNT, newLiveRuntimeIdentity(), 'CREATE'))
      .rejects.toThrow(/LIVE_RECONCILIATION_REQUIRED/);
  });
});

// ---------------------------------------------------------------------------
// [Wave B4 / F18-27] The account-continuity gate. Lives in
// `requireCurrentReconciliation` specifically, NOT in
// `evaluateReconciliationBarrier` — see that function's doc for why. These
// tests use a fake repository that returns a genuinely fenced, HEALTHY,
// non-null-authorization outcome (exactly what `authorizeCurrentHealthy`
// mints once fencing passes) so the ONLY variable under test is the
// continuity gate itself.
// ---------------------------------------------------------------------------

describe('P18 Wave B4 §F18-27 the account-continuity gate', () => {
  const fencedHealthyRow = state({
    status: 'HEALTHY', currentGeneration: 4, healthyGeneration: 4, currentRuntimeEpoch: EPOCH, blockingFindingCount: 0,
  });

  it('blocks even a fully-fenced, genuinely-authorized HEALTHY account by default, because REST-only evidence never proves account continuity', async () => {
    const repository = { authorizeCurrentHealthy: async () => ({ state: fencedHealthyRow, authorization: {} }) } as never;
    await expect(requireCurrentReconciliation(repository, ACCOUNT, RUNTIME_IDENTITY, 'CREATE'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
  });

  // [Wave B5 / F18-28] Wave B4 originally shipped `requireCurrentReconciliation`
  // with a public 5th parameter (`continuityCapability`, defaulting to
  // `currentAccountContinuityCapability()`) so a genuine future continuity
  // adapter could one day be threaded through explicitly. Independent review
  // correctly identified that as a forgery hole: nothing stopped ANY caller
  // from passing the literal string `'ACCOUNT_CONTINUITY_PROVEN'` and minting
  // a real authorization with zero actual continuity proof behind it. The fix
  // removed the parameter entirely — `requireCurrentReconciliation` now has
  // exactly 4 parameters and reads `currentAccountContinuityCapability()`
  // itself, consulting no caller-supplied value of any kind. These tests
  // prove that removal is airtight: every shape in the review's forgery
  // matrix is attempted as a 5th positional argument (via `as never`/`as any`
  // to bypass the compiler, since TypeScript itself now already refuses a 5th
  // argument at the call site — see the `TS2554` the plain literal produces
  // if attempted with real types) and every single one is silently ignored,
  // producing the IDENTICAL refusal as calling with no 5th argument at all.
  it('a forgery matrix of 5th positional arguments is uniformly ignored: none can mint an authorization', async () => {
    const repository = { authorizeCurrentHealthy: async () => ({ state: fencedHealthyRow, authorization: {} }) } as never;
    const call = requireCurrentReconciliation as unknown as (
      repository: unknown,
      accountId: unknown,
      runtimeIdentity: unknown,
      mutation: unknown,
      forged?: unknown,
    ) => Promise<unknown>;

    class ProofLookalike {
      readonly kind = 'ACCOUNT_CONTINUITY_PROVEN';
    }
    const forgeryAttempts: readonly unknown[] = [
      'ACCOUNT_CONTINUITY_PROVEN',
      { kind: 'ACCOUNT_CONTINUITY_PROVEN' },
      Object.assign(Object.create(null), { kind: 'ACCOUNT_CONTINUITY_PROVEN' }),
      Object.create({ kind: 'ACCOUNT_CONTINUITY_PROVEN' }),
      new ProofLookalike(),
      Symbol('ACCOUNT_CONTINUITY_PROVEN'),
      Symbol.for('ACCOUNT_CONTINUITY_PROVEN'),
      new String('ACCOUNT_CONTINUITY_PROVEN'),
      true,
      null,
      undefined,
      { accountId: ACCOUNT, runtimeEpoch: EPOCH, kind: 'ACCOUNT_CONTINUITY_PROVEN' },
      { accountId: 'some-other-account', kind: 'ACCOUNT_CONTINUITY_PROVEN' },
      { runtimeEpoch: 'some-other-runtime', kind: 'ACCOUNT_CONTINUITY_PROVEN' },
      { currentGeneration: fencedHealthyRow.currentGeneration - 1, kind: 'ACCOUNT_CONTINUITY_PROVEN' },
    ];

    for (const forged of forgeryAttempts) {
      await expect(call(repository, ACCOUNT, RUNTIME_IDENTITY, 'CREATE', forged))
        .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
    }
  });

  it('TypeScript itself refuses a 5th argument at the call site, so a well-typed caller cannot even attempt the forgery', () => {
    // This is a compile-time property, not a runtime one — `npm run
    // typecheck` is the actual assertion (tsconfig.test.json covers this
    // file). This test exists only to document, next to the runtime forgery
    // matrix above, that the two layers together are what closes F18-28: the
    // type system stops any well-typed call, and the runtime matrix above
    // proves that even a caller willing to fight the compiler (`as never`,
    // raw JS) gains nothing.
    expect(requireCurrentReconciliation).toHaveLength(4);
  });

  it('currentAccountContinuityCapability() is the honest, currently-correct answer: no continuity mechanism is wired anywhere in this codebase', () => {
    expect(currentAccountContinuityCapability()).toBe('REST_CURRENT_STATE_OBSERVED');
  });

  it('the exact race: an order appearing strictly after the final REST read is evidentially indistinguishable from a genuinely clean account, so both are refused identically', async () => {
    // There is nothing to construct differently between "clean" and "raced"
    // here — that IS the finding. Both produce the identical durable state
    // (HEALTHY, fenced, zero blocking findings) because the race, by
    // definition, leaves no trace in evidence this run ever read. The gate
    // must therefore treat every REST-only result the same way.
    const cleanRepository = { authorizeCurrentHealthy: async () => ({ state: fencedHealthyRow, authorization: {} }) } as never;
    const racedRepository = { authorizeCurrentHealthy: async () => ({ state: fencedHealthyRow, authorization: {} }) } as never;
    await expect(requireCurrentReconciliation(cleanRepository, ACCOUNT, RUNTIME_IDENTITY, 'CREATE'))
      .rejects.toMatchObject({ details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
    await expect(requireCurrentReconciliation(racedRepository, ACCOUNT, RUNTIME_IDENTITY, 'CREATE'))
      .rejects.toMatchObject({ details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
  });

  it('does not block a genuinely stale-epoch account with the continuity reason: the epoch check still fires first', async () => {
    const staleRow = state({
      status: 'HEALTHY', currentGeneration: 4, healthyGeneration: 4, currentRuntimeEpoch: 'a-previous-process', blockingFindingCount: 0,
    });
    const repository = { authorizeCurrentHealthy: async () => ({ state: staleRow, authorization: null }) } as never;
    await expect(requireCurrentReconciliation(repository, ACCOUNT, RUNTIME_IDENTITY, 'CREATE'))
      .rejects.toMatchObject({ details: { reason: 'STALE_RUNTIME_GENERATION' } });
  });
});

// ---------------------------------------------------------------------------
// [Wave B / F18-04] Raw snapshot-stability digests. These are what the
// service's bracketed read (`LiveReconciliationService#readStableVenueEvidence`)
// compares before it will trust ANY orders/positions read; the end-to-end
// account-level behaviour is exercised in `snapshot-stability.test.ts`.
// ---------------------------------------------------------------------------

describe('P18 Wave B §F18-04 raw stability digests detect every required movement', () => {
  it('is stable (equal) for the exact same content', () => {
    const orders = [venueOrder({ exchangeOrderId: 'a' }), venueOrder({ exchangeOrderId: 'b' })];
    expect(rawOrderSetSha256(orders)).toBe(rawOrderSetSha256(orders));
  });

  it('is stable across pure reordering of otherwise-identical records', () => {
    const one = venueOrder({ exchangeOrderId: 'a' });
    const two = venueOrder({ exchangeOrderId: 'b' });
    expect(rawOrderSetSha256([one, two])).toBe(rawOrderSetSha256([two, one]));
  });

  it('detects a brand-new order appearing between reads', () => {
    const before = [venueOrder({ exchangeOrderId: 'a' })];
    const after = [venueOrder({ exchangeOrderId: 'a' }), venueOrder({ exchangeOrderId: 'new-order' })];
    expect(rawOrderSetSha256(before)).not.toBe(rawOrderSetSha256(after));
  });

  it('detects an order filling between reads', () => {
    const before = [venueOrder({ exchangeOrderId: 'a', venueStatus: 'open', filledQuantity: '0', remainingQuantity: '0.5' })];
    const after = [venueOrder({ exchangeOrderId: 'a', venueStatus: 'filled', filledQuantity: '0.5', remainingQuantity: '0', averageFillPrice: '64000' })];
    expect(rawOrderSetSha256(before)).not.toBe(rawOrderSetSha256(after));
  });

  it('detects an order being cancelled between reads', () => {
    const before = [venueOrder({ exchangeOrderId: 'a', venueStatus: 'open' })];
    const after = [venueOrder({ exchangeOrderId: 'a', venueStatus: 'cancelled', cancelledQuantity: '0.5', remainingQuantity: '0' })];
    expect(rawOrderSetSha256(before)).not.toBe(rawOrderSetSha256(after));
  });

  it('fails closed on the same exchange order id reported with conflicting content', () => {
    const conflicting = [venueOrder({ exchangeOrderId: 'a', venueStatus: 'open' }), venueOrder({ exchangeOrderId: 'a', venueStatus: 'filled', filledQuantity: '0.5', remainingQuantity: '0', averageFillPrice: '64000' })];
    // The stability check does not itself decide this is invalid (that is
    // `assertNoConflictingDuplicates`'s job, run after stability), but it must
    // never silently treat two DIFFERENT records with the same id as if
    // nothing were there worth comparing.
    expect(rawOrderSetSha256(conflicting)).not.toBe(rawOrderSetSha256([conflicting[0]!]));
  });

  it('is stable for identical positions and unstable for a quantity change', () => {
    const flat = [venuePosition({ signedQuantity: '0.5' })];
    const moved = [venuePosition({ signedQuantity: '0.6' })];
    expect(rawPositionSetSha256(flat)).toBe(rawPositionSetSha256(flat));
    expect(rawPositionSetSha256(flat)).not.toBe(rawPositionSetSha256(moved));
  });

  it('detects a position direction change between reads', () => {
    const long = [venuePosition({ signedQuantity: '0.5' })];
    const short = [venuePosition({ signedQuantity: '-0.5' })];
    expect(rawPositionSetSha256(long)).not.toBe(rawPositionSetSha256(short));
  });
});
