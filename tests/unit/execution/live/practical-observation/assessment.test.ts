import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveExecutionAuthority } from '../../../../../src/execution/live/authority';
import { LiveExecutionEnablement } from '../../../../../src/execution/live/gate';
import { PracticalRecoveryCertificate } from '../../../../../src/execution/live/practical/certificate';
import { PracticalLiveSafetyEnablement } from '../../../../../src/execution/live/practical/policy';
import {
  assessPracticalObservation,
  GRANTS_NOTHING,
  recheckObservationCandidate,
  type ComponentRead,
  type ObservationComponent,
  type ObservationOwnership,
  type PracticalObservationAssessment,
  type PracticalObservationInput,
  type PrivateStreamObservation,
} from '../../../../../src/execution/live/practical-observation/assessment';
import { practicalPrivateStreamReadiness } from '../../../../../src/execution/live/practical-recovery/private-events';
import { currentAccountContinuityCapability } from '../../../../../src/execution/live/reconciliation/barrier';
import { OrphanCleanupPolicy } from '../../../../../src/execution/live/reconciliation/orphan-policy';
import { LiveReconciliationAuthorization } from '../../../../../src/execution/live/reconciliation/repository';
import { LiveReconciliationCompletionProof } from '../../../../../src/execution/live/reconciliation/service';
import { consumeMutationPermit } from '../../../../../src/integration/coindcx/rate-limit/runtime/mutation-budget';

// M3 practical observation evaluator. Synthetic values only: these thresholds are test inputs, not proposed defaults.
const THRESHOLDS = Object.freeze({ maxEvidenceAgeMs: 5_000, maxTotalReadDurationMs: 2_000 });
const ACCOUNT = 'synthetic-account';
const OWNED: ObservationOwnership = { kind: 'OWNED', lineage: 'BOT_CREATE_RESPONSE' };

type Read = Extract<ComponentRead, { kind: 'READ' }>;
function read(component: ObservationComponent, startedAtMs: number, overrides: Partial<Read> = {}): Read {
  return {
    component, kind: 'READ', accountScope: { kind: 'CONFIRMED', accountId: ACCOUNT }, pagination: 'COMPLETE',
    recordTimestamps: 'PRESENT', fillIds: component === 'TRANSACTIONS' ? 'PRESENT' : 'NOT_APPLICABLE',
    startedAtMs, endedAtMs: startedAtMs + 100,
    records: [{ key: `${component}:1`, fingerprint: 'f1', ownership: OWNED }],
    ...overrides,
  };
}
function stream(overrides: Partial<PrivateStreamObservation> = {}): PrivateStreamObservation {
  return {
    connected: true, epoch: 7, epochAtWindowStart: 7, disconnectObservedSinceWindowStart: false, reconnectLatched: false,
    joinAcknowledgement: { kind: 'UNKNOWN' }, events: [], bufferedUnprocessedEvents: 0, ...overrides,
  };
}
/** Two agreeing passes over ORDERS and POSITIONS: pass 1 at 1000-1100/1100-1200, pass 2 at 1300-1400/1400-1500. */
function input(overrides: Partial<PracticalObservationInput> = {}): PracticalObservationInput {
  return {
    mode: 'FULL_EVIDENCE',
    scope: { accountId: ACCOUNT, components: ['ORDERS', 'POSITIONS'], requiredAccounting: [] },
    thresholds: THRESHOLDS,
    passes: [{ reads: [read('ORDERS', 1_000), read('POSITIONS', 1_100)] }, { reads: [read('ORDERS', 1_300), read('POSITIONS', 1_400)] }],
    stream: stream(),
    evaluatedAtMs: 2_000,
    ...overrides,
  };
}
const withPass2 = (reads: ComponentRead[]): PracticalObservationInput => input({ passes: [input().passes[0]!, { reads }] });
const reasonsOf = (value: PracticalObservationInput | Record<string, unknown>): readonly string[] => assessPracticalObservation(value).reasons;

afterEach(() => { vi.restoreAllMocks(); });

describe('M3 observed convergence: what agreement establishes, and what it does not', () => {
  it('two agreeing passes within the declared scope and bounds are OBSERVED_CONVERGENCE, with explicit limits', () => {
    const result = assessPracticalObservation(input());
    expect(result.kind).toBe('OBSERVED_CONVERGENCE');
    expect(result.reasons).toEqual([]);
    expect(result.evidenceGaps).toEqual([]);
    expect(result.semantics).toBe('OBSERVED_CONVERGENCE_IS_NOT_ATOMIC_CONSISTENCY');
    expect(result.window).toEqual({ startedAtMs: 1_000, endedAtMs: 1_500, evaluatedAtMs: 2_000 });
    expect(result.mode).toBe('FULL_EVIDENCE');
    expect(result.scope).toEqual({ accountId: ACCOUNT, components: ['ORDERS', 'POSITIONS'], requiredAccounting: [] });
    // A quiet stream is recorded, never credited; the join stays UNKNOWN without provider evidence, and is recorded,
    // not blocking, for this REST comparison only. Private-stream readiness is not assessed here.
    expect(result.stream).toEqual({ epoch: 7, privateStreamReadiness: 'NOT_ASSESSED', joinAcknowledgement: 'UNKNOWN', joinAcknowledgementBlocksComparison: false,
      eventsInWindow: 0, quietStream: true, quietStreamProvesNoActivity: false });
    expect(result.fillLevelAccounting).toEqual({ completeFillReconstruction: 'UNKNOWN', exactlyOnceExecutionAccounting: 'UNKNOWN', feeAccounting: 'UNKNOWN',
      reasons: ['STABLE_FILL_ID_CONTRACT_UNRESOLVED'] });
    // REST-only assessment never establishes the provider's REST/WebSocket procedure.
    expect(result.providerSynchronization).toEqual({ status: 'NOT_ESTABLISHED', reasons: ['REST_ONLY_ASSESSMENT', 'WEBSOCKET_DERIVED_STATE_NOT_COMPARED', 'JOIN_ACKNOWLEDGEMENT_UNKNOWN'] });
    expect(result.grants).toEqual(GRANTS_NOTHING);
  });

  it('join acknowledgement is positive only with provider evidence for the current epoch; even then the provider procedure is not established', () => {
    const confirmed = assessPracticalObservation(input({ stream: stream({ joinAcknowledgement: { kind: 'PROVIDER_CONFIRMED', epoch: 7 } }) }));
    expect(confirmed.stream?.joinAcknowledgement).toBe('PROVIDER_CONFIRMED_FOR_EPOCH');
    expect(confirmed.providerSynchronization).toEqual({ status: 'NOT_ESTABLISHED', reasons: ['REST_ONLY_ASSESSMENT', 'WEBSOCKET_DERIVED_STATE_NOT_COMPARED'] });
    const otherEpoch = assessPracticalObservation(input({ stream: stream({ joinAcknowledgement: { kind: 'PROVIDER_CONFIRMED', epoch: 6 } }) }));
    expect(otherEpoch.stream?.joinAcknowledgement).toBe('UNKNOWN');
    // A join merely sent, or any other claim, is not an acknowledgement (rejected as input).
    expect(assessPracticalObservation(input({ stream: { ...stream(), joinAcknowledgement: { kind: 'SENT' } } as never })).kind).toBe('INVALID_INPUT');
  });

  it('is pure: identical input gives an identical result, and no clock is read', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock read'); });
    vi.spyOn(performance, 'now').mockImplementation(() => { throw new Error('clock read'); });
    expect(assessPracticalObservation(input())).toEqual(assessPracticalObservation(input()));
  });
});

describe('M3 incomplete evidence stays explicit and is never convergence', () => {
  it.each([
    ['pagination truncated', { pagination: 'TRUNCATED' }, 'PAGINATION_TRUNCATED'],
    ['pagination unknown', { pagination: 'UNKNOWN' }, 'PAGINATION_UNKNOWN'],
    ['record timestamps missing', { recordTimestamps: 'MISSING' }, 'RECORD_TIMESTAMPS_MISSING'],
    ['account scope unknown', { accountScope: { kind: 'UNKNOWN' } }, 'ACCOUNT_SCOPE_UNKNOWN'],
  ] as const)('%s', (_label, overrides, reason) => {
    const result = assessPracticalObservation(withPass2([read('ORDERS', 1_300, overrides as Partial<Read>), read('POSITIONS', 1_400)]));
    expect(result.kind).toBe('NOT_CONVERGED');
    expect(result.reasons).toContain(reason);
    expect(result.evidenceGaps).toEqual([{ pass: 1, component: 'ORDERS', gap: reason, blocking: true }]);
  });

  it('FULL_EVIDENCE mode (unchanged): missing fill identifiers block when transactions are in scope', () => {
    const scope = { accountId: ACCOUNT, components: ['TRANSACTIONS'] as ObservationComponent[], requiredAccounting: [] };
    const passes = [{ reads: [read('TRANSACTIONS', 1_000, { fillIds: 'MISSING' })] }, { reads: [read('TRANSACTIONS', 1_200, { fillIds: 'MISSING' })] }];
    const result = assessPracticalObservation(input({ scope, passes }));
    expect(result.kind).toBe('NOT_CONVERGED');
    expect(result.reasons).toEqual(['FILL_IDS_MISSING']);
    expect(result.evidenceGaps).toEqual([{ pass: 0, component: 'TRANSACTIONS', gap: 'FILL_IDS_MISSING', blocking: true }, { pass: 1, component: 'TRANSACTIONS', gap: 'FILL_IDS_MISSING', blocking: true }]);
    expect(assessPracticalObservation(input({ scope, passes: [{ reads: [read('TRANSACTIONS', 1_000)] }, { reads: [read('TRANSACTIONS', 1_200)] }] })).kind).toBe('OBSERVED_CONVERGENCE');
  });

  it('a failed read, a missing or undeclared component, another account, or the wrong pass count is never convergence', () => {
    expect(reasonsOf(withPass2([{ component: 'ORDERS', kind: 'FAILED' }, read('POSITIONS', 1_400)]))).toContain('READ_FAILED');
    expect(reasonsOf(withPass2([read('ORDERS', 1_300)]))).toContain('SCOPE_COMPONENT_MISSING');
    expect(reasonsOf(withPass2([read('ORDERS', 1_300), read('POSITIONS', 1_400), read('TRANSACTIONS', 1_400)]))).toContain('SCOPE_COMPONENT_UNDECLARED');
    expect(reasonsOf(withPass2([read('ORDERS', 1_300, { accountScope: { kind: 'CONFIRMED', accountId: 'other' } }), read('POSITIONS', 1_400)]))).toContain('ACCOUNT_SCOPE_MISMATCH');
    expect(reasonsOf(input({ passes: [input().passes[0]!] }))).toContain('PASS_COUNT_INVALID');
    expect(reasonsOf(input({ passes: [...input().passes, input().passes[1]!] }))).toContain('PASS_COUNT_INVALID');
  });
});

describe('M3 CUMULATIVE_STATE mode: cumulative comparison is separate from fill-level accounting', () => {
  const txnScope = (requiredAccounting: PracticalObservationInput['scope']['requiredAccounting'] = []) => ({
    accountId: ACCOUNT, components: ['ORDERS', 'TRANSACTIONS'] as ObservationComponent[], requiredAccounting,
  });
  const txnPasses = (overrides: Partial<Read> = { fillIds: 'MISSING' }) => [
    { reads: [read('ORDERS', 1_000), read('TRANSACTIONS', 1_100, overrides)] },
    { reads: [read('ORDERS', 1_300), read('TRANSACTIONS', 1_400, overrides)] },
  ];

  it('missing fill identifiers do not prevent cumulative comparison; they stay explicit, and fill-level accounting stays UNKNOWN', () => {
    const result = assessPracticalObservation(input({ mode: 'CUMULATIVE_STATE', scope: txnScope(), passes: txnPasses() }));
    expect(result.kind).toBe('OBSERVED_CONVERGENCE');
    expect(result.mode).toBe('CUMULATIVE_STATE');
    expect(result.evidenceGaps).toEqual([{ pass: 0, component: 'TRANSACTIONS', gap: 'FILL_IDS_MISSING', blocking: false }, { pass: 1, component: 'TRANSACTIONS', gap: 'FILL_IDS_MISSING', blocking: false }]);
    expect(result.fillLevelAccounting).toEqual({ completeFillReconstruction: 'UNKNOWN', exactlyOnceExecutionAccounting: 'UNKNOWN', feeAccounting: 'UNKNOWN',
      reasons: ['STABLE_FILL_ID_CONTRACT_UNRESOLVED', 'FILL_IDS_MISSING', 'CUMULATIVE_STATE_MODE'] });
    expect(result.grants).toBe(GRANTS_NOTHING);
    // The same evidence in FULL_EVIDENCE mode is still blocked: the existing mode is not weakened.
    expect(reasonsOf(input({ mode: 'FULL_EVIDENCE', scope: txnScope(), passes: txnPasses() }))).toEqual(['FILL_IDS_MISSING']);
  });

  it.each(['COMPLETE_FILL_RECONSTRUCTION', 'EXACTLY_ONCE_EXECUTION_ACCOUNTING', 'FEE_ACCOUNTING'] as const)('a scope that requires %s is blocked in both modes, even with fill identifiers present', (capability) => {
    for (const mode of ['CUMULATIVE_STATE', 'FULL_EVIDENCE'] as const) {
      expect(reasonsOf(input({ mode, scope: txnScope([capability]), passes: txnPasses({ fillIds: 'PRESENT' }) })), mode).toEqual(['ACCOUNTING_UNSUPPORTED_FOR_SCOPE']);
    }
  });

  it('every other blocker is unchanged in CUMULATIVE_STATE mode: ownership, pagination and account scope', () => {
    const cumulative = (pass2: ComponentRead[]) => input({ mode: 'CUMULATIVE_STATE', passes: [input().passes[0]!, { reads: pass2 }] });
    expect(reasonsOf(cumulative([read('ORDERS', 1_300, { pagination: 'UNKNOWN' }), read('POSITIONS', 1_400)]))).toEqual(['PAGINATION_UNKNOWN']);
    expect(reasonsOf(cumulative([read('ORDERS', 1_300, { pagination: 'TRUNCATED' }), read('POSITIONS', 1_400)]))).toEqual(['PAGINATION_TRUNCATED']);
    expect(reasonsOf(cumulative([read('ORDERS', 1_300, { accountScope: { kind: 'UNKNOWN' } }), read('POSITIONS', 1_400)]))).toEqual(['ACCOUNT_SCOPE_UNKNOWN']);
    const tagged = { key: 'ORDERS:1', fingerprint: 'f1', ownership: { kind: 'TAG_CORRELATED_ONLY' } as const };
    expect(reasonsOf(input({ mode: 'CUMULATIVE_STATE', passes: [
      { reads: [read('ORDERS', 1_000, { records: [tagged] }), read('POSITIONS', 1_100)] },
      { reads: [read('ORDERS', 1_300, { records: [tagged] }), read('POSITIONS', 1_400)] },
    ] }))).toEqual(['OWNERSHIP_UNRESOLVED']);
  });

  it('the mode and the accounting scope are explicit inputs: missing or unknown values fail closed', () => {
    const { mode: _mode, ...noMode } = input();
    expect(assessPracticalObservation(noMode).kind).toBe('INVALID_INPUT');
    expect(assessPracticalObservation({ ...input(), mode: 'BEST_EFFORT' }).kind).toBe('INVALID_INPUT');
    expect(assessPracticalObservation({ ...input(), scope: { accountId: ACCOUNT, components: ['ORDERS'] } }).kind).toBe('INVALID_INPUT');
    expect(assessPracticalObservation({ ...input(), scope: { accountId: ACCOUNT, components: ['ORDERS'], requiredAccounting: ['FUNDING'] } }).kind).toBe('INVALID_INPUT');
  });

  it('an UNKNOWN join acknowledgement is recorded, non-blocking for REST comparison only, and never described as readiness or synchronization', () => {
    const result = assessPracticalObservation(input({ mode: 'CUMULATIVE_STATE' }));
    expect(result.kind).toBe('OBSERVED_CONVERGENCE');
    expect(result.stream).toMatchObject({ joinAcknowledgement: 'UNKNOWN', joinAcknowledgementBlocksComparison: false, privateStreamReadiness: 'NOT_ASSESSED' });
    expect(result.providerSynchronization.status).toBe('NOT_ESTABLISHED');
    expect(JSON.stringify(result)).not.toMatch(/READY|SYNCHRONIZED|PROVEN|SATISFIED/);
  });
});

describe('M3 disagreement and timing', () => {
  it('a changed fingerprint, a changed record set or a duplicate key is a disagreement', () => {
    expect(reasonsOf(withPass2([read('ORDERS', 1_300, { records: [{ key: 'ORDERS:1', fingerprint: 'f2', ownership: OWNED }] }), read('POSITIONS', 1_400)]))).toEqual(['RECORDS_DISAGREE']);
    expect(reasonsOf(withPass2([read('ORDERS', 1_300, { records: [] }), read('POSITIONS', 1_400)]))).toEqual(['RECORDS_DISAGREE']);
    const twice = { key: 'ORDERS:1', fingerprint: 'f1', ownership: OWNED };
    expect(reasonsOf(withPass2([read('ORDERS', 1_300, { records: [twice, twice] }), read('POSITIONS', 1_400)]))).toContain('DUPLICATE_RECORD_KEY');
  });

  it('stale evidence, an over-long read span, overlapping passes and evidence after evaluation are never convergence', () => {
    expect(reasonsOf(input({ evaluatedAtMs: 1_000 + THRESHOLDS.maxEvidenceAgeMs + 1 }))).toEqual(['EVIDENCE_STALE']);
    expect(assessPracticalObservation(input({ evaluatedAtMs: 1_000 + THRESHOLDS.maxEvidenceAgeMs })).kind).toBe('OBSERVED_CONVERGENCE');
    expect(reasonsOf(withPass2([read('ORDERS', 2_950), read('POSITIONS', 2_950)]))).toContain('READ_DURATION_EXCEEDED');
    expect(reasonsOf(withPass2([read('ORDERS', 1_150), read('POSITIONS', 1_400)]))).toContain('READ_ORDER_INVALID');
    expect(reasonsOf(input({ evaluatedAtMs: 1_450 }))).toContain('EVIDENCE_AFTER_EVALUATION');
  });
});

describe('M3 private stream: revocation inputs only; silence proves nothing', () => {
  it('an event observed during or after the window revokes; an earlier event does not, but the stream is no longer quiet', () => {
    expect(reasonsOf(input({ stream: stream({ events: [{ observedAtMs: 1_250 }] }) }))).toEqual(['EVENT_DURING_OR_AFTER_WINDOW']);
    expect(reasonsOf(input({ stream: stream({ events: [{ observedAtMs: 1_900 }] }) }))).toEqual(['EVENT_DURING_OR_AFTER_WINDOW']);
    const earlier = assessPracticalObservation(input({ stream: stream({ events: [{ observedAtMs: 900 }] }) }));
    expect(earlier.kind).toBe('OBSERVED_CONVERGENCE');
    expect(earlier.stream).toMatchObject({ quietStream: false, eventsInWindow: 0 });
    expect(reasonsOf(input({ stream: stream({ bufferedUnprocessedEvents: 1 }) }))).toEqual(['BUFFERED_EVENTS_PENDING']);
  });

  it('disconnects, the reconnect latch and epoch changes or unknown epochs revoke', () => {
    expect(reasonsOf(input({ stream: stream({ connected: false }) }))).toEqual(['STREAM_DISCONNECTED']);
    expect(reasonsOf(input({ stream: stream({ disconnectObservedSinceWindowStart: true }) }))).toEqual(['DISCONNECT_DURING_WINDOW']);
    expect(reasonsOf(input({ stream: stream({ reconnectLatched: true }) }))).toEqual(['RECONNECT_LATCHED']);
    expect(reasonsOf(input({ stream: stream({ epoch: 8 }) }))).toEqual(['EPOCH_CHANGED']);
    expect(reasonsOf(input({ stream: stream({ epoch: null }) }))).toEqual(['EPOCH_UNKNOWN']);
    expect(reasonsOf(input({ stream: stream({ epochAtWindowStart: null }) }))).toEqual(['EPOCH_UNKNOWN']);
  });

  it('a quiet stream never upgrades anything: incomplete REST evidence stays NOT_CONVERGED however quiet the stream is', () => {
    const result = assessPracticalObservation(withPass2([read('ORDERS', 1_300, { pagination: 'UNKNOWN' }), read('POSITIONS', 1_400)]));
    expect(result.stream?.quietStream).toBe(true);
    expect(result.kind).toBe('NOT_CONVERGED');
  });
});

describe('M3 ownership: unknown or conflicting ownership is never accepted', () => {
  const both = (first: ObservationOwnership, second: ObservationOwnership = first) => input({
    passes: [
      { reads: [read('ORDERS', 1_000, { records: [{ key: 'ORDERS:1', fingerprint: 'f1', ownership: first }] }), read('POSITIONS', 1_100)] },
      { reads: [read('ORDERS', 1_300, { records: [{ key: 'ORDERS:1', fingerprint: 'f1', ownership: second }] }), read('POSITIONS', 1_400)] },
    ],
  });

  it('a tag-correlated record is UNRESOLVED even when both passes agree exactly', () => {
    expect(reasonsOf(both({ kind: 'TAG_CORRELATED_ONLY' }))).toEqual(['OWNERSHIP_UNRESOLVED']);
  });

  it.each([
    [{ kind: 'UNRESOLVED' }, 'OWNERSHIP_UNRESOLVED'],
    [{ kind: 'FOREIGN_OBSERVED' }, 'FOREIGN_ACTIVITY_OBSERVED'],
    [{ kind: 'VENUE_GENERATED' }, 'VENUE_GENERATED_CHANGE'],
  ] as const)('%o blocks with %s', (ownership, reason) => {
    expect(reasonsOf(both(ownership))).toEqual([reason]);
  });

  it('ownership that differs between passes, including a different lineage, is a conflict', () => {
    expect(reasonsOf(both(OWNED, { kind: 'UNRESOLVED' }))).toEqual(['OWNERSHIP_CONFLICT', 'OWNERSHIP_UNRESOLVED']);
    expect(reasonsOf(both(OWNED, { kind: 'OWNED', lineage: 'RESOLVED_UNDER_CONFIRMED_CONTRACT' }))).toEqual(['OWNERSHIP_CONFLICT']);
  });

  it('an OWNED claim without established lineage, or an unknown class, is invalid input', () => {
    expect(assessPracticalObservation(both({ kind: 'OWNED' } as never)).kind).toBe('INVALID_INPUT');
    expect(assessPracticalObservation(both({ kind: 'OWNED', lineage: 'MATCHING_TAG' } as never)).kind).toBe('INVALID_INPUT');
    expect(assessPracticalObservation(both({ kind: 'OWNED', lineage: 'DURABLE_OWNERSHIP_RECORD' })).kind).toBe('OBSERVED_CONVERGENCE');
    expect(assessPracticalObservation(both({ kind: 'ADOPTED' } as never)).kind).toBe('INVALID_INPUT');
  });
});

describe('M3 thresholds: explicit inputs only, no defaults', () => {
  it.each([
    ['missing', undefined],
    ['zero age', { maxEvidenceAgeMs: 0, maxTotalReadDurationMs: 2_000 }],
    ['negative duration', { maxEvidenceAgeMs: 5_000, maxTotalReadDurationMs: -1 }],
    ['fractional', { maxEvidenceAgeMs: 5_000.5, maxTotalReadDurationMs: 2_000 }],
    ['infinite', { maxEvidenceAgeMs: Number.POSITIVE_INFINITY, maxTotalReadDurationMs: 2_000 }],
    ['string', { maxEvidenceAgeMs: '5000', maxTotalReadDurationMs: 2_000 }],
  ])('%s thresholds are INVALID_INPUT', (_label, thresholds) => {
    const result = assessPracticalObservation({ ...input(), thresholds });
    expect(result).toMatchObject({ kind: 'INVALID_INPUT', reasons: ['INVALID_THRESHOLDS'], grants: GRANTS_NOTHING });
  });

  it('malformed input of any shape fails closed', () => {
    for (const value of [null, undefined, 42, 'x', [], {}, { ...input(), passes: 'x' }, { ...input(), evaluatedAtMs: -1 }, { ...input(), scope: { accountId: '', components: ['ORDERS'] } }]) {
      expect(assessPracticalObservation(value).kind).toBe('INVALID_INPUT');
    }
  });
});

describe('M3 candidate recheck: new observations can only invalidate', () => {
  const current = (overrides: Partial<PrivateStreamObservation> = {}, evaluatedAtMs = 2_500) => ({ thresholds: THRESHOLDS, stream: stream(overrides), evaluatedAtMs });

  it('an unchanged stream within the age bound leaves the candidate unchanged (still granting nothing)', () => {
    expect(recheckObservationCandidate(assessPracticalObservation(input()), current())).toEqual({ kind: 'CANDIDATE_UNCHANGED', grants: GRANTS_NOTHING });
  });

  it.each([
    ['a new observed event', current({ events: [{ observedAtMs: 2_200 }] }), 'EVENT_DURING_OR_AFTER_WINDOW'],
    ['an epoch change (reconnect)', current({ epoch: 8, epochAtWindowStart: 8 }), 'EPOCH_CHANGED'],
    ['a disconnect', current({ connected: false }), 'STREAM_DISCONNECTED'],
    ['a disconnect since the window', current({ disconnectObservedSinceWindowStart: true }), 'DISCONNECT_DURING_WINDOW'],
    ['the reconnect latch', current({ reconnectLatched: true }), 'RECONNECT_LATCHED'],
    ['buffered events', current({ bufferedUnprocessedEvents: 2 }), 'BUFFERED_EVENTS_PENDING'],
    ['stale evidence', current({}, 1_000 + THRESHOLDS.maxEvidenceAgeMs + 1), 'EVIDENCE_STALE'],
    ['a time before the assessment', current({}, 1_999), 'EVIDENCE_AFTER_EVALUATION'],
  ])('%s invalidates', (_label, now, reason) => {
    const recheck = recheckObservationCandidate(assessPracticalObservation(input()), now);
    expect(recheck.kind).toBe('INVALIDATED');
    expect(recheck.kind === 'INVALIDATED' && recheck.reasons).toContain(reason);
    expect(recheck.grants).toEqual(GRANTS_NOTHING);
  });

  it('a non-convergent, invalid or forged assessment is never a candidate; recheck never upgrades', () => {
    const notConverged = assessPracticalObservation(input({ stream: stream({ connected: false }) }));
    expect(recheckObservationCandidate(notConverged, current()).kind).toBe('NOT_A_CANDIDATE');
    expect(recheckObservationCandidate(assessPracticalObservation(null), current()).kind).toBe('NOT_A_CANDIDATE');
    const forged = { ...assessPracticalObservation(input()) }; // a structural copy is not a produced assessment
    expect(recheckObservationCandidate(forged, current()).kind).toBe('NOT_A_CANDIDATE');
    expect(recheckObservationCandidate({ kind: 'OBSERVED_CONVERGENCE' }, current()).kind).toBe('NOT_A_CANDIDATE');
  });
});

describe('M3 no evaluator outcome grants authority', () => {
  const outcomes: Array<[string, unknown]> = [];
  const convergent = assessPracticalObservation(input({ stream: stream({ joinAcknowledgement: { kind: 'PROVIDER_CONFIRMED', epoch: 7 } }) }));
  outcomes.push(['OBSERVED_CONVERGENCE', convergent]);
  outcomes.push(['NOT_CONVERGED', assessPracticalObservation(input({ stream: stream({ connected: false }) }))]);
  outcomes.push(['INVALID_INPUT', assessPracticalObservation(null)]);
  outcomes.push(['CANDIDATE_UNCHANGED', recheckObservationCandidate(convergent, { thresholds: THRESHOLDS, stream: stream(), evaluatedAtMs: 2_500 })]);
  outcomes.push(['INVALIDATED', recheckObservationCandidate(convergent, { thresholds: THRESHOLDS, stream: stream({ connected: false }), evaluatedAtMs: 2_500 })]);

  it.each(outcomes)('%s grants nothing and is accepted by no authority, certificate, policy, permit or readiness reader', (_label, outcome) => {
    expect((outcome as { grants: unknown }).grants).toBe(GRANTS_NOTHING);
    for (const reader of [LiveExecutionAuthority, LiveExecutionEnablement, PracticalRecoveryCertificate, PracticalLiveSafetyEnablement,
      LiveReconciliationAuthorization, LiveReconciliationCompletionProof, OrphanCleanupPolicy]) {
      expect(reader.read(outcome), reader.name).toBeNull();
    }
    expect(practicalPrivateStreamReadiness(outcome).kind).not.toBe('PROVEN_READY');
    expect(consumeMutationPermit(outcome, 'CANCEL').kind).toBe('REFUSED');
    expect(consumeMutationPermit(outcome, 'CREATE').kind).toBe('REFUSED');
    expect(JSON.stringify(outcome)).not.toMatch(/authorityEligible|PROVEN_READY|ACCOUNT_CONTINUITY_PROVEN|SHADOW/);
  });

  it('every grant is a literal false, frozen; results are frozen; strict continuity is unchanged', () => {
    expect(Object.values(GRANTS_NOTHING).every((value) => value === false)).toBe(true);
    expect(Object.keys(GRANTS_NOTHING).sort()).toEqual(['authorityEligibility', 'certificate', 'liveReadiness', 'mutationBudget', 'orderPermission', 'strategyLifecyclePromotion', 'strictContinuity']);
    expect(Object.isFrozen(GRANTS_NOTHING)).toBe(true);
    const result: PracticalObservationAssessment = assessPracticalObservation(input());
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => { (result as { kind: string }).kind = 'X'; }).toThrow(TypeError);
    expect(() => { (GRANTS_NOTHING as { certificate: boolean }).certificate = true; }).toThrow(TypeError);
    expect(currentAccountContinuityCapability()).toBe('REST_CURRENT_STATE_OBSERVED');
  });
});
