import { describe, expect, it } from 'vitest';
import {
  PRACTICAL_PASS_READ_PLAN,
  assemblePracticalPass,
  evaluatePracticalCertificationEvidence,
  observeIdentityRead,
  observeOrderRead,
  observePositionRead,
  practicalBracketDisagreement,
  practicalEvidenceDigest,
  practicalProvenanceFailure,
  type PracticalObservationPass,
  type PracticalReadObservation,
} from '../../../../../src/execution/live/practical-recovery/observation';
import { FINGERPRINT, OTHER_FINGERPRINT, order, position } from './support';

const ORDERS = (overrides: Record<string, unknown> = {}) => ({
  source: 'COINDCX_FUTURES_ORDERS', localReadStartedAtMs: 10, localReadEndedAtMs: 20, complete: true, pagesRead: 2, incompleteReason: null, ...overrides,
});
const POSITIONS = (overrides: Record<string, unknown> = {}) => ({ ...ORDERS(overrides), source: 'COINDCX_FUTURES_POSITIONS', ...overrides });

describe('pagination completeness: a partial page set is never usable', () => {
  it('a complete read with at least one page and no incomplete reason is usable', () => {
    expect(practicalProvenanceFailure(ORDERS(), 'COINDCX_FUTURES_ORDERS')).toBeNull();
  });

  it.each([
    ['complete: false', { complete: false, incompleteReason: 'ORDER_PAGINATION_LIMIT_BUY' }, 'PAGINATION_INCOMPLETE'],
    ['zero pages read', { pagesRead: 0 }, 'PAGINATION_INCOMPLETE'],
    ['complete but with an incomplete reason', { incompleteReason: 'ORDER_READ_FAILED_SELL_PAGE_3' }, 'PAGINATION_INCOMPLETE'],
    ['the wrong source', { source: 'COINDCX_FUTURES_POSITIONS' }, 'MALFORMED_RESPONSE'],
    ['a non-boolean completeness', { complete: 'yes' }, 'MALFORMED_RESPONSE'],
    ['a negative page count', { pagesRead: -1 }, 'MALFORMED_RESPONSE'],
    ['an unsafe time', { localReadEndedAtMs: 1.5 }, 'MALFORMED_RESPONSE'],
    ['a read that ended before it started', { localReadStartedAtMs: 30, localReadEndedAtMs: 20 }, 'CLOCK_ANOMALY'],
  ])('%s -> %s', (_label, overrides, failure) => {
    expect(practicalProvenanceFailure(ORDERS(overrides), 'COINDCX_FUTURES_ORDERS')).toBe(failure);
  });

  it('a missing provenance is malformed', () => {
    expect(practicalProvenanceFailure(undefined, 'COINDCX_FUTURES_ORDERS')).toBe('MALFORMED_RESPONSE');
  });
});

describe('reads', () => {
  it('orders and positions: the digest is the exact record set, order-insensitive, identical duplicates tolerated', () => {
    const a = observeOrderRead({ orders: [order('o-1'), order('o-2')], provenance: ORDERS() });
    const b = observeOrderRead({ orders: [order('o-2'), order('o-1'), order('o-1')], provenance: ORDERS() });
    expect(a).toMatchObject({ failure: null, complete: true, pagesRead: 2 });
    expect(a.contentDigest).toBe(b.contentDigest);
    expect(observeOrderRead({ orders: [order('o-1', { remainingQuantity: '0.5' }), order('o-2')], provenance: ORDERS() }).contentDigest).not.toBe(a.contentDigest);
    expect(observePositionRead({ positions: [position('p-1')], provenance: POSITIONS() })).toMatchObject({ failure: null, complete: true });
  });

  it('an incomplete read never yields comparison material', () => {
    expect(observeOrderRead({ orders: [order('o-1')], provenance: ORDERS({ complete: false, incompleteReason: 'X' }) }))
      .toEqual({ failure: 'PAGINATION_INCOMPLETE', pagesRead: 2, complete: false, contentDigest: null });
  });

  it.each([
    ['no result', null],
    ['records that are not a list', { orders: 'o-1', provenance: ORDERS() }],
    ['a record without an exact id', { orders: [order(' o-1')], provenance: ORDERS() }],
    ['conflicting duplicates', { orders: [order('o-1'), order('o-1', { filledQuantity: '1' })], provenance: ORDERS() }],
    ['an unrepresentable number', { orders: [order('o-1', { providerEventTimeMs: 1.5 })], provenance: ORDERS() }],
  ])('malformed order read: %s', (_label, value) => {
    expect(observeOrderRead(value).failure).toBe('MALFORMED_RESPONSE');
  });

  it('identity: only the configured account is usable; a different one is a MISMATCH', () => {
    expect(observeIdentityRead({ kind: 'OBSERVED', fingerprint: FINGERPRINT }, FINGERPRINT)).toMatchObject({ failure: null, contentDigest: FINGERPRINT });
    expect(observeIdentityRead({ kind: 'OBSERVED', fingerprint: OTHER_FINGERPRINT }, FINGERPRINT).failure).toBe('ACCOUNT_FINGERPRINT_MISMATCH');
    expect(observeIdentityRead({ kind: 'UNAVAILABLE', reason: 'ACCOUNT_IDENTITY_READ_FAILED' }, FINGERPRINT).failure).toBe('PROVIDER_UNAVAILABLE');
    expect(observeIdentityRead({ kind: 'UNAVAILABLE', reason: 'ACCOUNT_IDENTITY_MISSING' }, FINGERPRINT).failure).toBe('ACCOUNT_IDENTITY_UNAVAILABLE');
    expect(observeIdentityRead({ kind: 'OBSERVED', fingerprint: 'NOT-HEX' }, FINGERPRINT).failure).toBe('ACCOUNT_IDENTITY_UNAVAILABLE');
    expect(observeIdentityRead({ kind: 'SOMETHING' }, FINGERPRINT).failure).toBe('MALFORMED_RESPONSE');
  });
});

type Slot = PracticalReadObservation['slot'];

const KIND: Readonly<Record<Slot, PracticalReadObservation['kind']>> = {
  IDENTITY_OPEN: 'IDENTITY', O1: 'ORDERS', P1: 'POSITIONS', O2: 'ORDERS', P2: 'POSITIONS', O3: 'ORDERS', IDENTITY_CLOSE: 'IDENTITY',
};
const SLOTS: readonly Slot[] = ['IDENTITY_OPEN', 'O1', 'P1', 'O2', 'P2', 'O3', 'IDENTITY_CLOSE'];
const O_P_SLOTS = ['O1', 'P1', 'O2', 'P2', 'O3'] as const;

function read(slot: Slot, startedAtMs: number, endedAtMs: number, contentDigest: string, overrides: Partial<PracticalReadObservation> = {}): PracticalReadObservation {
  const kind = KIND[slot];
  return { slot, kind, startedAtMs, endedAtMs, latencyMs: endedAtMs - startedAtMs, failure: null, pagesRead: kind === 'IDENTITY' ? null : 1, complete: true, contentDigest, ...overrides };
}

/** One bracketed pass: seven 100 ms reads, 50 ms apart. `digests` overrides any slot's content; `failures` fails a slot. */
function passReads(
  startedAtMs: number,
  options: { readonly state?: string; readonly digests?: Partial<Record<Slot, string>>; readonly failures?: Partial<Record<Slot, PracticalReadObservation['failure']>> } = {},
): PracticalReadObservation[] {
  const state = options.state ?? 'a';
  const base: Record<Slot, string> = {
    IDENTITY_OPEN: FINGERPRINT, O1: `orders-${state}`, P1: 'positions', O2: `orders-${state}`, P2: 'positions', O3: `orders-${state}`, IDENTITY_CLOSE: FINGERPRINT,
  };
  return SLOTS.map((slot, position) => {
    const failure = options.failures?.[slot] ?? null;
    const at = startedAtMs + position * 150;
    return read(slot, at, at + 100, options.digests?.[slot] ?? base[slot], failure === null ? {} : { failure, complete: false, contentDigest: null });
  });
}

function pass(index: number, startedAtMs: number, state = 'a'): PracticalObservationPass {
  return assemblePracticalPass(index, passReads(startedAtMs, { state }));
}

const BINDINGS = { accountId: 'account-1', providerAccountFingerprint: FINGERPRINT, runtimeEpoch: 'epoch', reconciliationGeneration: 4, streamIncarnation: 2, runId: 'run-1' };
const CEILINGS = { minimumPasses: 3, minimumCertificationSpanMs: 30_000, minimumPassSpacingMs: 10_000 };

describe('one pass is the bracketed sequence identity, O1 P1 O2 P2 O3, identity', () => {
  it('the read plan is exactly that sequence', () => {
    expect(PRACTICAL_PASS_READ_PLAN.map((step) => `${step.slot}:${step.kind}`)).toEqual([
      'IDENTITY_OPEN:IDENTITY', 'O1:ORDERS', 'P1:POSITIONS', 'O2:ORDERS', 'P2:POSITIONS', 'O3:ORDERS', 'IDENTITY_CLOSE:IDENTITY',
    ]);
  });

  it('IDENTICAL BRACKETED READS PASS: complete, with a stable state digest and measured skew and gaps', () => {
    const usable = pass(1, 0);
    expect(usable).toMatchObject({ complete: true, failure: null, bracketDisagreement: null, durationMs: 1_000, observationSkewMs: 900, maxInterReadGapMs: 50 });
    expect(usable.reads.map((entry) => entry.slot)).toEqual(SLOTS);
    expect(usable.stateDigest).toMatch(/^[0-9a-f]{64}$/);
    // The state digest is the agreed account state only: the same at a different time, different for a different state.
    expect(pass(2, 99_000).stateDigest).toBe(usable.stateDigest);
    expect(pass(1, 0, 'b').stateDigest).not.toBe(usable.stateDigest);
  });

  it.each([
    ['O1 != O2', { O1: 'orders-x' }, 'ORDERS_O1_O2'],
    ['O2 != O3', { O3: 'orders-x' }, 'ORDERS_O2_O3'],
    ['P1 != P2', { P2: 'positions-x' }, 'POSITIONS_P1_P2'],
  ] as const)('%s fails the pass (BRACKET_DISAGREEMENT %s); no state digest', (_label, digests, disagreement) => {
    const failed = assemblePracticalPass(1, passReads(0, { digests }));
    expect(failed).toMatchObject({ complete: false, failure: 'BRACKET_DISAGREEMENT', bracketDisagreement: disagreement, stateDigest: null });
  });

  it('a TRANSIENT change that is restored inside the bracket is detected whenever a bracket read observes it', () => {
    // The orders changed and changed back: only O2 saw it.
    expect(assemblePracticalPass(1, passReads(0, { digests: { O2: 'orders-transient' } }))).toMatchObject({ failure: 'BRACKET_DISAGREEMENT', bracketDisagreement: 'ORDERS_O1_O2' });
    // The positions changed and changed back: only P1 saw it.
    expect(assemblePracticalPass(1, passReads(0, { digests: { P1: 'positions-transient' } }))).toMatchObject({ failure: 'BRACKET_DISAGREEMENT', bracketDisagreement: 'POSITIONS_P1_P2' });
    // Only the last order read saw it.
    expect(assemblePracticalPass(1, passReads(0, { digests: { O3: 'orders-transient' } }))).toMatchObject({ failure: 'BRACKET_DISAGREEMENT', bracketDisagreement: 'ORDERS_O2_O3' });
    // Decidable as soon as the partner read exists (the engine stops there).
    const early = passReads(0, { digests: { O2: 'orders-transient' } }).slice(0, 4);
    expect(practicalBracketDisagreement(early)).toBe('ORDERS_O1_O2');
    expect(practicalBracketDisagreement(passReads(0).slice(0, 4))).toBeNull();
  });

  it.each(O_P_SLOTS)('PARTIAL PAGINATION in %s fails the pass, whether or not later reads happened', (slot) => {
    const reads = passReads(0, { failures: { [slot]: 'PAGINATION_INCOMPLETE' } });
    expect(assemblePracticalPass(1, reads)).toMatchObject({ complete: false, failure: 'PAGINATION_INCOMPLETE', stateDigest: null });
    const truncated = reads.slice(0, SLOTS.indexOf(slot) + 1);
    expect(assemblePracticalPass(1, truncated)).toMatchObject({ complete: false, failure: 'PAGINATION_INCOMPLETE', stateDigest: null });
  });

  it('the account identity is bound to the pass: both identity reads must be the configured account', () => {
    expect(assemblePracticalPass(1, passReads(0, { failures: { IDENTITY_CLOSE: 'ACCOUNT_FINGERPRINT_MISMATCH' } })).failure).toBe('ACCOUNT_FINGERPRINT_MISMATCH');
    expect(assemblePracticalPass(1, passReads(0, { failures: { IDENTITY_OPEN: 'ACCOUNT_IDENTITY_UNAVAILABLE' } })).failure).toBe('ACCOUNT_IDENTITY_UNAVAILABLE');
    expect(assemblePracticalPass(1, passReads(0, { digests: { IDENTITY_CLOSE: OTHER_FINGERPRINT } })).failure).toBe('ACCOUNT_FINGERPRINT_MISMATCH');
  });

  it('missing or reordered reads are malformed; overlapping reads are a clock anomaly', () => {
    expect(assemblePracticalPass(1, passReads(0).slice(0, 6)).failure).toBe('MALFORMED_RESPONSE');
    const reordered = passReads(0);
    [reordered[1], reordered[2]] = [{ ...reordered[2]!, startedAtMs: 150, endedAtMs: 250 }, { ...reordered[1]!, startedAtMs: 300, endedAtMs: 400 }];
    expect(assemblePracticalPass(1, reordered).failure).toBe('MALFORMED_RESPONSE');
    const overlapping = passReads(0);
    overlapping[3] = { ...overlapping[3]!, startedAtMs: overlapping[2]!.endedAtMs - 1 };
    expect(assemblePracticalPass(1, overlapping).failure).toBe('CLOCK_ANOMALY');
  });
});

describe('certification evidence: every rule, or nothing', () => {
  const passes = [pass(1, 0), pass(2, 15_000), pass(3, 30_000)];

  it('3 usable, agreeing passes, spacing >= 10 s, span >= 30 s -> ACCEPTED with a bound summary', () => {
    const evaluation = evaluatePracticalCertificationEvidence(BINDINGS, passes, CEILINGS);
    expect(evaluation).toMatchObject({ kind: 'ACCEPTED', summary: { passCount: 3, certificationSpanMs: 31_000, minimumObservedPassSpacingMs: 14_000 } });
  });

  it('disagreement ACROSS passes is rejected at that pass', () => {
    expect(evaluatePracticalCertificationEvidence(BINDINGS, [pass(1, 0), pass(2, 15_000, 'b'), pass(3, 30_000)], CEILINGS))
      .toEqual({ kind: 'REJECTED', failure: 'OBSERVATION_DISAGREEMENT', passIndex: 2 });
    expect(evaluatePracticalCertificationEvidence(BINDINGS, [pass(1, 0), pass(2, 15_000), pass(3, 30_000, 'b')], CEILINGS))
      .toMatchObject({ failure: 'OBSERVATION_DISAGREEMENT', passIndex: 3 });
  });

  it('a pass with a bracket disagreement or a failed read is rejected with its failure', () => {
    const bracketed = assemblePracticalPass(2, passReads(15_000, { digests: { P1: 'positions-x' } }));
    expect(evaluatePracticalCertificationEvidence(BINDINGS, [passes[0]!, bracketed, passes[2]!], CEILINGS)).toEqual({ kind: 'REJECTED', failure: 'BRACKET_DISAGREEMENT', passIndex: 2 });
    const timedOut = assemblePracticalPass(2, [read('IDENTITY_OPEN', 15_000, 35_000, FINGERPRINT, { failure: 'READ_HARD_TIMEOUT', complete: false, contentDigest: null })]);
    expect(evaluatePracticalCertificationEvidence(BINDINGS, [passes[0]!, timedOut, passes[2]!], CEILINGS)).toEqual({ kind: 'REJECTED', failure: 'READ_HARD_TIMEOUT', passIndex: 2 });
  });

  it('too few passes, too little spacing, too short a span, or out-of-order passes are rejected', () => {
    expect(evaluatePracticalCertificationEvidence(BINDINGS, passes.slice(0, 2), CEILINGS)).toMatchObject({ failure: 'TOO_FEW_PASSES' });
    expect(evaluatePracticalCertificationEvidence(BINDINGS, [pass(1, 0), pass(2, 10_500), pass(3, 30_000)], CEILINGS)).toMatchObject({ failure: 'TIMING_WINDOW_UNMET' });
    expect(evaluatePracticalCertificationEvidence(BINDINGS, [pass(1, 0), pass(2, 11_000), pass(3, 22_000)], CEILINGS)).toMatchObject({ failure: 'TIMING_WINDOW_UNMET' });
    expect(evaluatePracticalCertificationEvidence(BINDINGS, [pass(1, 0), pass(2, 500), pass(3, 30_000)], CEILINGS)).toMatchObject({ failure: 'CLOCK_ANOMALY' });
  });

  it('spacing alone is not enough: a span below a (tightened) span ceiling is rejected', () => {
    expect(evaluatePracticalCertificationEvidence(BINDINGS, passes, { ...CEILINGS, minimumCertificationSpanMs: 40_000 })).toEqual({ kind: 'REJECTED', failure: 'TIMING_WINDOW_UNMET', passIndex: null });
    expect(evaluatePracticalCertificationEvidence(BINDINGS, passes, { ...CEILINGS, minimumPassSpacingMs: 15_000 })).toEqual({ kind: 'REJECTED', failure: 'TIMING_WINDOW_UNMET', passIndex: null });
  });

  it('the evidence digest is deterministic and binds every binding and every pass', () => {
    const digest = practicalEvidenceDigest(BINDINGS, passes);
    expect(practicalEvidenceDigest({ ...BINDINGS }, [pass(1, 0), pass(2, 15_000), pass(3, 30_000)])).toBe(digest);
    for (const changed of [
      practicalEvidenceDigest({ ...BINDINGS, reconciliationGeneration: 5 }, passes),
      practicalEvidenceDigest({ ...BINDINGS, streamIncarnation: 3 }, passes),
      practicalEvidenceDigest({ ...BINDINGS, runtimeEpoch: 'epoch-2' }, passes),
      practicalEvidenceDigest({ ...BINDINGS, runId: 'run-2' }, passes),
      practicalEvidenceDigest({ ...BINDINGS, providerAccountFingerprint: OTHER_FINGERPRINT }, passes),
      practicalEvidenceDigest(BINDINGS, [pass(1, 0), pass(2, 15_001), pass(3, 30_000)]),
      practicalEvidenceDigest(BINDINGS, [pass(1, 0), pass(2, 15_000), pass(3, 30_000, 'b')]),
    ]) {
      expect(changed).not.toBe(digest);
    }
  });

  /** Pass 2 with one read replaced (same pass state digest), so only that read's material differs. */
  const withRead = (slot: Slot, change: Partial<PracticalReadObservation>): PracticalObservationPass[] => [
    passes[0]!,
    { ...passes[1]!, reads: passes[1]!.reads.map((entry) => (entry.slot === slot ? { ...entry, ...change } : entry)) },
    passes[2]!,
  ];

  it.each(O_P_SLOTS)('the evidence digest includes read %s and its timing metadata', (slot) => {
    const digest = practicalEvidenceDigest(BINDINGS, passes);
    const original = passes[1]!.reads.find((entry) => entry.slot === slot)!;
    for (const change of [
      { startedAtMs: original.startedAtMs + 1 },
      { endedAtMs: original.endedAtMs + 1 },
      { latencyMs: original.latencyMs + 1 },
      { pagesRead: 7 },
    ]) {
      expect(practicalEvidenceDigest(BINDINGS, withRead(slot, change)), `${slot} ${JSON.stringify(change)}`).not.toBe(digest);
    }
  });

  it.each(O_P_SLOTS)('changing the read digest of %s changes the evidence digest', (slot) => {
    const digest = practicalEvidenceDigest(BINDINGS, passes);
    expect(practicalEvidenceDigest(BINDINGS, withRead(slot, { contentDigest: 'another-record-set' }))).not.toBe(digest);
  });

  it('the identity reads are bound too', () => {
    const digest = practicalEvidenceDigest(BINDINGS, passes);
    expect(practicalEvidenceDigest(BINDINGS, withRead('IDENTITY_OPEN', { startedAtMs: 15_001 }))).not.toBe(digest);
    expect(practicalEvidenceDigest(BINDINGS, withRead('IDENTITY_CLOSE', { contentDigest: OTHER_FINGERPRINT }))).not.toBe(digest);
  });
});
