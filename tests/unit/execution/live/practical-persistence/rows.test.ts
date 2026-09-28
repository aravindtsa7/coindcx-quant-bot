import { describe, expect, it } from 'vitest';
import { classifyPracticalInvalidation } from '../../../../../src/execution/live/practical/invalidation';
import { PRACTICAL_INVALIDATION_REASONS } from '../../../../../src/execution/live/practical/types';
import { PracticalPersistenceError, type PracticalAccountLoad } from '../../../../../src/execution/live/practical-persistence/ports';
import {
  assemblePracticalAccount,
  isPracticalCertificateBoundToLease,
  isPracticalLeaseBoundToFence,
  parsePracticalCertificateRow,
  parsePracticalFenceRow,
  parsePracticalLeaseRow,
  parsePracticalReviewEpisodeRow,
  parsePracticalStateRow,
  practicalStartupStateFromLoad,
  singleRowOrNull,
  toPracticalAccountLoad,
  toPracticalRecordLoad,
  type PracticalAccountRawRows,
} from '../../../../../src/execution/live/practical-persistence/rows';

// Pure row mapping: no database. Rows are shaped exactly as the repository's
// raw `SELECT ... AS camelCase` reads return them (BIGINT as bigint).

const ACCOUNT = 'account-live-1';
const CERT = 'c'.repeat(64);
const MALFORMED = /PRACTICAL_PERSISTENCE_MALFORMED/;

const stateRow = (overrides: Record<string, unknown> = {}) => ({
  accountId: ACCOUNT, state: 'QUARANTINED', revision: 0n,
  currentRecoveryEpisodeId: 'episode-1', currentReviewEpisodeId: null, currentCertificateId: null, ...overrides,
});
const fenceRow = (overrides: Record<string, unknown> = {}) => ({
  accountId: ACCOUNT, runtimeEpoch: 'epoch-a', reconciliationGeneration: 1, revision: 2n,
  mode: 'IDLE', runId: null, leaseId: null, certificateId: null, leaseAction: null, ...overrides,
});
const certificateRow = (overrides: Record<string, unknown> = {}) => ({
  certificateId: CERT, accountId: ACCOUNT, providerAccountFingerprint: 'f'.repeat(64), runtimeEpoch: 'epoch-a',
  reconciliationGeneration: 1, streamIncarnation: 1, evidenceDigest: 'e'.repeat(64), issuedAtMs: 1_000n, expiresAtMs: 121_000n,
  status: 'ISSUED', terminalAtMs: null, terminalReason: null, ...overrides,
});
const recoveryRow = (overrides: Record<string, unknown> = {}) => ({
  episodeId: 'episode-1', accountId: ACCOUNT, startedAtMs: 1n, endedAtMs: null, startCause: 'RUNTIME_STARTUP', status: 'OPEN',
  runtimeEpoch: 'epoch-a', reconciliationGeneration: 0, certifiedCertificateId: null, reviewEpisodeId: null, openedByResolutionId: null, ...overrides,
});
const reviewRow = (overrides: Record<string, unknown> = {}) => ({
  reviewEpisodeId: 'review-1', accountId: ACCOUNT, kind: 'INVALIDATION', enteredAtMs: 5n, reason: 'ORPHAN_ORDER', malformedProblem: null, runtimeEpoch: 'epoch-a',
  status: 'OPEN', resolvedAtMs: null, resolutionId: null, ...overrides,
});
/** The certificate behind a held lease: CONSUMED by the one-shot that created the lease. */
const consumedCertificateRow = (overrides: Record<string, unknown> = {}) => certificateRow({ status: 'CONSUMED', terminalAtMs: 15n, ...overrides });
const leaseRow = (overrides: Record<string, unknown> = {}) => ({
  leaseId: 'lease-1', accountId: ACCOUNT, certificateId: CERT, action: 'CANCEL', intentId: null, clientOrderId: null, cancelGeneration: null,
  runtimeEpoch: 'epoch-a', reconciliationGeneration: 1, createdAtMs: 10n, armedAtMs: null, completedAtMs: null,
  status: 'LEASED', outcome: null, ...overrides,
});
const quarantinedRows = (overrides: Partial<PracticalAccountRawRows> = {}): PracticalAccountRawRows => ({
  latch: null, latchEpisode: null, state: stateRow(), fence: fenceRow(), recoveryEpisode: recoveryRow(), reviewEpisode: null, certificate: null, lease: null, leasedCertificate: null, ...overrides,
});

describe('the absence boundary: only a successful zero-row read is absent', () => {
  it('singleRowOrNull: [] -> null; [row] -> row; anything else -> MALFORMED', () => {
    expect(singleRowOrNull([], 'STATE_ROW_INVALID')).toBeNull();
    const row = stateRow();
    expect(singleRowOrNull([row], 'STATE_ROW_INVALID')).toBe(row);
    expect(() => singleRowOrNull([row, row], 'STATE_ROW_INVALID')).toThrow(/more than one row/);
    for (const notRows of [undefined, null, 'rows', {}, 0]) expect(() => singleRowOrNull(notRows, 'STATE_ROW_INVALID')).toThrow(MALFORMED);
  });

  it('both rows exactly null -> NOT_FOUND; one null -> MALFORMED (PARTIAL); undefined -> MALFORMED, never NOT_FOUND', () => {
    expect(toPracticalAccountLoad(ACCOUNT, quarantinedRows({ state: null, fence: null, recoveryEpisode: null }))).toEqual({ kind: 'NOT_FOUND' });
    expect(toPracticalAccountLoad(ACCOUNT, quarantinedRows({ fence: null }))).toEqual({ kind: 'MALFORMED', problem: 'PARTIAL_ACCOUNT_ROWS', reviewEpisodeId: null });
    expect(toPracticalAccountLoad(ACCOUNT, quarantinedRows({ state: null, recoveryEpisode: null }))).toEqual({ kind: 'MALFORMED', problem: 'PARTIAL_ACCOUNT_ROWS', reviewEpisodeId: null });
    expect(toPracticalAccountLoad(ACCOUNT, quarantinedRows({ state: undefined, fence: undefined, recoveryEpisode: null })).kind).toBe('MALFORMED');
    expect(toPracticalAccountLoad(ACCOUNT, quarantinedRows({ state: undefined, fence: null, recoveryEpisode: null })).kind).toBe('MALFORMED');
  });

  it('a non-MALFORMED error (e.g. a database failure) is rethrown, never turned into NOT_FOUND or MALFORMED', () => {
    const exploding = { ...quarantinedRows(), get state(): unknown { throw new Error('database read exploded'); } };
    expect(() => toPracticalAccountLoad(ACCOUNT, exploding)).toThrow('database read exploded');
    expect(() => toPracticalRecordLoad(certificateRow(), () => { throw new TypeError('driver failure'); })).toThrow('driver failure');
  });

  it('single records: null -> NOT_FOUND, a malformed row -> MALFORMED', () => {
    expect(toPracticalRecordLoad(null, parsePracticalCertificateRow)).toEqual({ kind: 'NOT_FOUND' });
    expect(toPracticalRecordLoad(undefined, parsePracticalCertificateRow)).toEqual({ kind: 'MALFORMED', problem: 'CERTIFICATE_ROW_INVALID' });
    expect(toPracticalRecordLoad(certificateRow({ status: 'BROKEN' }), parsePracticalCertificateRow)).toEqual({ kind: 'MALFORMED', problem: 'CERTIFICATE_ROW_INVALID' });
    expect(toPracticalRecordLoad(certificateRow(), parsePracticalCertificateRow).kind).toBe('FOUND');
  });

  it('the startup state: NOT_FOUND -> QUARANTINED; MALFORMED -> MANUAL_REVIEW_REQUIRED; FOUND keeps review sticky', () => {
    expect(practicalStartupStateFromLoad({ kind: 'NOT_FOUND' })).toBe('QUARANTINED');
    for (const problem of ['STATE_ROW_INVALID', 'FENCE_ROW_INVALID', 'PARTIAL_ACCOUNT_ROWS', 'ROWS_INCONSISTENT'] as const) {
      expect(practicalStartupStateFromLoad({ kind: 'MALFORMED', problem, reviewEpisodeId: null })).toBe('MANUAL_REVIEW_REQUIRED');
      expect(practicalStartupStateFromLoad({ kind: 'MALFORMED', problem, reviewEpisodeId: 'review-latched' })).toBe('MANUAL_REVIEW_REQUIRED');
    }
    const found = toPracticalAccountLoad(ACCOUNT, quarantinedRows());
    expect(practicalStartupStateFromLoad(found)).toBe('QUARANTINED');
    const review = toPracticalAccountLoad(ACCOUNT, quarantinedRows({
      state: stateRow({ state: 'MANUAL_REVIEW_REQUIRED', currentRecoveryEpisodeId: null, currentReviewEpisodeId: 'review-1' }),
      recoveryEpisode: null,
      reviewEpisode: reviewRow(),
    }));
    expect(review.kind).toBe('FOUND');
    expect(practicalStartupStateFromLoad(review)).toBe('MANUAL_REVIEW_REQUIRED');
    // An unknown load kind is treated as malformed, never as absent.
    expect(practicalStartupStateFromLoad({ kind: 'SOMETHING_ELSE' } as unknown as PracticalAccountLoad)).toBe('MANUAL_REVIEW_REQUIRED');
  });
});

describe('state row', () => {
  it('parses a valid row', () => {
    expect(parsePracticalStateRow(stateRow())).toEqual({
      accountId: ACCOUNT, state: 'QUARANTINED', revision: 0, currentRecoveryEpisodeId: 'episode-1', currentReviewEpisodeId: null, currentCertificateId: null,
    });
  });

  it.each([
    ['unknown state', { state: 'STRICT_HEALTHY' }],
    ['lowercase state', { state: 'quarantined' }],
    ['padded account', { accountId: ` ${ACCOUNT}` }],
    ['negative revision', { revision: -1n }],
    ['unsafe revision', { revision: BigInt(Number.MAX_SAFE_INTEGER) + 1n }],
    ['fractional revision', { revision: 1.5 }],
    ['string revision', { revision: '0' }],
    ['recovery pointer missing while QUARANTINED', { currentRecoveryEpisodeId: null }],
    ['review pointer while QUARANTINED', { currentReviewEpisodeId: 'review-1' }],
    ['certificate pointer while QUARANTINED', { currentCertificateId: CERT }],
    ['CERTIFIED_IDLE without certificate', { state: 'CERTIFIED_IDLE', currentRecoveryEpisodeId: null }],
    ['uppercase certificate pointer', { state: 'CERTIFIED_IDLE', currentRecoveryEpisodeId: null, currentCertificateId: 'C'.repeat(64) }],
  ])('%s is MALFORMED', (_label, overrides) => {
    expect(() => parsePracticalStateRow(stateRow(overrides))).toThrow(MALFORMED);
  });

  it('a missing column, null, undefined, or an array is MALFORMED', () => {
    const { revision: _revision, ...missing } = stateRow();
    for (const value of [missing, null, undefined, [stateRow()]]) expect(() => parsePracticalStateRow(value)).toThrow(MALFORMED);
  });
});

describe('fence row (validated by the Stage 1A fence validator)', () => {
  it('parses each mode exactly', () => {
    expect(parsePracticalFenceRow(fenceRow()).mode).toEqual({ kind: 'IDLE' });
    expect(parsePracticalFenceRow(fenceRow({ mode: 'CERTIFYING', runId: 'run-1' })).mode).toEqual({ kind: 'CERTIFYING', runId: 'run-1' });
    expect(parsePracticalFenceRow(fenceRow({ mode: 'MUTATION_LEASED', leaseId: 'lease-1', certificateId: CERT, leaseAction: 'CANCEL' })).mode)
      .toEqual({ kind: 'MUTATION_LEASED', leaseId: 'lease-1', certificateId: CERT, action: 'CANCEL' });
    expect(Object.isFrozen(parsePracticalFenceRow(fenceRow()))).toBe(true);
  });

  it.each([
    ['unknown mode', { mode: 'BROKEN' }],
    ['empty mode (non-strict SQL enum)', { mode: '' }],
    ['IDLE with a stray run id', { runId: 'run-1' }],
    ['IDLE with stray lease data', { leaseId: 'lease-1' }],
    ['CERTIFYING without run id', { mode: 'CERTIFYING' }],
    ['CERTIFYING with padded run id', { mode: 'CERTIFYING', runId: ' run-1' }],
    ['CERTIFYING with lease data', { mode: 'CERTIFYING', runId: 'run-1', leaseAction: 'CANCEL' }],
    ['LEASED without certificate', { mode: 'MUTATION_LEASED', leaseId: 'lease-1', leaseAction: 'CANCEL' }],
    ['LEASED with unknown action', { mode: 'MUTATION_LEASED', leaseId: 'lease-1', certificateId: CERT, leaseAction: 'MODIFY' }],
    ['LEASED with a run id', { mode: 'MUTATION_LEASED', runId: 'run-1', leaseId: 'lease-1', certificateId: CERT, leaseAction: 'CANCEL' }],
    ['negative generation', { reconciliationGeneration: -1 }],
    ['unsafe revision', { revision: BigInt(Number.MAX_SAFE_INTEGER) + 1n }],
    ['padded epoch', { runtimeEpoch: 'epoch-a ' }],
  ])('%s is MALFORMED (never IDLE, never absent)', (_label, overrides) => {
    expect(() => parsePracticalFenceRow(fenceRow(overrides))).toThrow(MALFORMED);
  });

  it('MAX_SAFE_INTEGER itself is a valid stored revision (the Stage 1A increment guard handles it)', () => {
    expect(parsePracticalFenceRow(fenceRow({ revision: BigInt(Number.MAX_SAFE_INTEGER) })).revision).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('certificate, lease, and episode rows', () => {
  it('a valid certificate row parses; every coupling violation is MALFORMED', () => {
    expect(parsePracticalCertificateRow(certificateRow())).toMatchObject({ status: 'ISSUED', issuedAtMs: 1_000, expiresAtMs: 121_000 });
    for (const overrides of [
      { status: 'RESURRECTED' }, { status: '' }, { evidenceDigest: 'E'.repeat(64) }, { providerAccountFingerprint: 'raw-coindcx-id' },
      { expiresAtMs: 1_000n }, { terminalAtMs: 5n }, { status: 'REVOKED', terminalAtMs: 5n }, { status: 'CONSUMED', terminalAtMs: 5n, terminalReason: 'WS_DISCONNECTED' },
      { status: 'EXPIRED', terminalAtMs: 5n, terminalReason: 'WS_DISCONNECTED' }, { status: 'REVOKED', terminalAtMs: 5n, terminalReason: 'NOT_A_REASON' },
      { reconciliationGeneration: 0 }, { streamIncarnation: 0 },
    ]) {
      expect(() => parsePracticalCertificateRow(certificateRow(overrides)), JSON.stringify(overrides, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).toThrow(MALFORMED);
    }
  });

  it('an UNBOUND (Stage 1B1) lease row can never be armed or carry a partial order binding', () => {
    expect(parsePracticalLeaseRow(leaseRow())).toMatchObject({ status: 'LEASED', outcome: null, orderBinding: null, armedAtMs: null });
    expect(() => parsePracticalLeaseRow(leaseRow({ armedAtMs: 11n }))).toThrow(/can never be armed/);
    expect(() => parsePracticalLeaseRow(leaseRow({ intentId: 'intent-1' }))).toThrow(MALFORMED);
    expect(() => parsePracticalLeaseRow(leaseRow({ status: 'COMPLETED' }))).toThrow(MALFORMED);
    expect(() => parsePracticalLeaseRow(leaseRow({ outcome: 'SUCCESS', status: 'COMPLETED', completedAtMs: 12n }))).toThrow(MALFORMED);
  });

  it('a review episode row with an unknown reason or inconsistent resolution is MALFORMED', () => {
    expect(parsePracticalReviewEpisodeRow(reviewRow())).toMatchObject({ status: 'OPEN' });
    expect(() => parsePracticalReviewEpisodeRow(reviewRow({ reason: 'NOT_A_REASON' }))).toThrow(MALFORMED);
    expect(() => parsePracticalReviewEpisodeRow(reviewRow({ status: 'RESOLVED' }))).toThrow(MALFORMED);
    expect(() => parsePracticalReviewEpisodeRow(reviewRow({ resolutionId: 'r' }))).toThrow(MALFORMED);
  });
});

describe('account assembly cross-validates every row', () => {
  const certified = (overrides: Partial<PracticalAccountRawRows> = {}): PracticalAccountRawRows => ({
    latch: null,
    latchEpisode: null,
    state: stateRow({ state: 'CERTIFIED_IDLE', currentRecoveryEpisodeId: null, currentCertificateId: CERT }),
    fence: fenceRow(),
    recoveryEpisode: null,
    reviewEpisode: null,
    certificate: certificateRow(),
    lease: null,
    leasedCertificate: null,
    ...overrides,
  });

  it('a consistent CERTIFIED_IDLE account assembles', () => {
    expect(assemblePracticalAccount(certified())).toMatchObject({ state: 'CERTIFIED_IDLE', currentCertificate: { certificateId: CERT } });
  });

  it.each([
    ['certificate for another account', { certificate: certificateRow({ accountId: 'account-live-2' }) }],
    ['certificate on another epoch', { certificate: certificateRow({ runtimeEpoch: 'epoch-b' }) }],
    ['certificate on another generation', { certificate: certificateRow({ reconciliationGeneration: 2 }) }],
    ['current certificate already CONSUMED', { certificate: certificateRow({ status: 'CONSUMED', terminalAtMs: 5n }) }],
    ['pointer without a row', { certificate: null }],
    ['fence for another account', { fence: fenceRow({ accountId: 'account-live-2' }) }],
    ['CERTIFIED_IDLE with a leased fence', { fence: fenceRow({ mode: 'MUTATION_LEASED', leaseId: 'l', certificateId: CERT, leaseAction: 'CANCEL' }) }],
    ['a row with no pointer', { reviewEpisode: reviewRow() }],
  ])('%s -> MALFORMED ROWS_INCONSISTENT', (_label, overrides) => {
    expect(toPracticalAccountLoad(ACCOUNT, certified(overrides))).toEqual({ kind: 'MALFORMED', problem: 'ROWS_INCONSISTENT', reviewEpisodeId: null });
  });

  it('state/fence coupling: CERTIFYING needs a CERTIFYING fence; MUTATING needs a leased fence', () => {
    expect(toPracticalAccountLoad(ACCOUNT, quarantinedRows({ state: stateRow({ state: 'CERTIFYING' }) }))).toEqual({ kind: 'MALFORMED', problem: 'ROWS_INCONSISTENT', reviewEpisodeId: null });
    expect(toPracticalAccountLoad(ACCOUNT, quarantinedRows({ state: stateRow({ state: 'MUTATING', currentRecoveryEpisodeId: null }), recoveryEpisode: null })))
      .toEqual({ kind: 'MALFORMED', problem: 'ROWS_INCONSISTENT', reviewEpisodeId: null });
    // QUARANTINED and MANUAL_REVIEW_REQUIRED may hold a leased fence (invalidated mid-mutation), with its exact lease.
    expect(toPracticalAccountLoad(ACCOUNT, quarantinedRows({
      fence: fenceRow({ mode: 'MUTATION_LEASED', leaseId: 'l', certificateId: CERT, leaseAction: 'CANCEL' }), lease: leaseRow({ leaseId: 'l' }), leasedCertificate: consumedCertificateRow(),
    })).kind).toBe('FOUND');
  });

  it('a current episode that is closed, or belongs to another account, is inconsistent', () => {
    expect(toPracticalAccountLoad(ACCOUNT, quarantinedRows({ recoveryEpisode: recoveryRow({ status: 'CERTIFIED', endedAtMs: 9n, certifiedCertificateId: CERT }) })))
      .toEqual({ kind: 'MALFORMED', problem: 'ROWS_INCONSISTENT', reviewEpisodeId: null });
    expect(toPracticalAccountLoad(ACCOUNT, quarantinedRows({ recoveryEpisode: recoveryRow({ accountId: 'account-live-2' }) })))
      .toEqual({ kind: 'MALFORMED', problem: 'ROWS_INCONSISTENT', reviewEpisodeId: null });
  });

  it('a MALFORMED_STATE review episode can never be the state row\'s current invalidation episode', () => {
    expect(toPracticalAccountLoad(ACCOUNT, quarantinedRows({
      state: stateRow({ state: 'MANUAL_REVIEW_REQUIRED', currentRecoveryEpisodeId: null, currentReviewEpisodeId: 'review-1' }),
      recoveryEpisode: null,
      reviewEpisode: reviewRow({ kind: 'MALFORMED_STATE', reason: 'DURABLE_STATE_MALFORMED', malformedProblem: 'FENCE_ROW_INVALID' }),
    }))).toEqual({ kind: 'MALFORMED', problem: 'ROWS_INCONSISTENT', reviewEpisodeId: null });
  });

  it('MALFORMED errors are typed and carry only a safe problem code', () => {
    try {
      assemblePracticalAccount(quarantinedRows({ state: stateRow({ state: 'BROKEN' }) }));
      throw new Error('expected MALFORMED');
    } catch (error) {
      expect(error).toBeInstanceOf(PracticalPersistenceError);
      expect((error as PracticalPersistenceError).details).toEqual({ problem: 'STATE_ROW_INVALID', field: 'state' });
    }
  });
});

describe('a MUTATION_LEASED fence is bound to its exact durable LEASED lease (P18B-1B1-02)', () => {
  const LEASED_FENCE = { mode: 'MUTATION_LEASED', leaseId: 'lease-1', certificateId: CERT, leaseAction: 'CANCEL' };
  const mutating = (overrides: Partial<PracticalAccountRawRows> = {}): PracticalAccountRawRows => quarantinedRows({
    state: stateRow({ state: 'MUTATING', currentRecoveryEpisodeId: null }), recoveryEpisode: null, fence: fenceRow(LEASED_FENCE), lease: leaseRow(), leasedCertificate: consumedCertificateRow(), ...overrides,
  });
  const inconsistent = { kind: 'MALFORMED', problem: 'ROWS_INCONSISTENT', reviewEpisodeId: null };

  it('a matching LEASED lease -> FOUND, and the snapshot carries it as currentLease', () => {
    const load = toPracticalAccountLoad(ACCOUNT, mutating());
    expect(load).toMatchObject({ kind: 'FOUND', account: { state: 'MUTATING', currentLease: { leaseId: 'lease-1', status: 'LEASED', action: 'CANCEL' } } });
  });

  it.each([
    ['QUARANTINED', {}],
    ['MANUAL_REVIEW_REQUIRED', { currentRecoveryEpisodeId: null, currentReviewEpisodeId: 'review-1' }],
  ] as const)('%s with a still-leased fence (invalidated mid-mutation) is valid ONLY with the exact matching LEASED lease', (state, pointers) => {
    const rows = (lease: unknown, leasedCertificate: unknown = consumedCertificateRow()) => quarantinedRows({
      state: stateRow({ state, ...pointers }),
      recoveryEpisode: state === 'QUARANTINED' ? recoveryRow() : null,
      reviewEpisode: state === 'MANUAL_REVIEW_REQUIRED' ? reviewRow() : null,
      fence: fenceRow(LEASED_FENCE),
      lease,
      leasedCertificate,
    });
    expect(toPracticalAccountLoad(ACCOUNT, rows(leaseRow())).kind).toBe('FOUND');
    expect(toPracticalAccountLoad(ACCOUNT, rows(null))).toEqual(inconsistent);
    expect(toPracticalAccountLoad(ACCOUNT, rows(leaseRow({ runtimeEpoch: 'epoch-b' })))).toEqual(inconsistent);
    expect(toPracticalAccountLoad(ACCOUNT, rows(leaseRow({ status: 'COMPLETED', completedAtMs: 20n, outcome: 'ACCEPTED' })))).toEqual(inconsistent);
  });

  it.each([
    ['missing lease row', null],
    ['lease id differs (only by case)', leaseRow({ leaseId: 'LEASE-1' })],
    ['lease for another certificate', leaseRow({ certificateId: 'd'.repeat(64) })],
    ['lease for another account', leaseRow({ accountId: 'account-live-2' })],
    ['lease action differs', leaseRow({ action: 'OPEN' })],
    ['lease runtime epoch differs', leaseRow({ runtimeEpoch: 'epoch-b' })],
    ['lease runtime epoch differs only by case', leaseRow({ runtimeEpoch: 'EPOCH-A' })],
    ['lease generation differs', leaseRow({ reconciliationGeneration: 9 })],
    ['lease COMPLETED under a leased fence', leaseRow({ status: 'COMPLETED', completedAtMs: 20n, outcome: 'ACCEPTED' })],
  ])('%s -> MALFORMED ROWS_INCONSISTENT (never repaired, never released)', (_label, lease) => {
    expect(toPracticalAccountLoad(ACCOUNT, mutating({ lease }))).toEqual(inconsistent);
  });

  it('a malformed lease row behind the fence -> MALFORMED LEASE_ROW_INVALID', () => {
    expect(toPracticalAccountLoad(ACCOUNT, mutating({ lease: leaseRow({ armedAtMs: 5n }) }))).toEqual({ kind: 'MALFORMED', problem: 'LEASE_ROW_INVALID', reviewEpisodeId: null });
  });

  it('a lease row read for a fence that is not leased is inconsistent', () => {
    expect(toPracticalAccountLoad(ACCOUNT, quarantinedRows({ lease: leaseRow() }))).toEqual(inconsistent);
  });

  it('isPracticalLeaseBoundToFence requires every binding field and LEASED', () => {
    const fence = parsePracticalFenceRow(fenceRow(LEASED_FENCE));
    expect(isPracticalLeaseBoundToFence(parsePracticalLeaseRow(leaseRow()), fence)).toBe(true);
    for (const overrides of [
      { leaseId: 'lease-2' }, { certificateId: 'd'.repeat(64) }, { accountId: 'account-live-2' }, { action: 'CLOSE' },
      { runtimeEpoch: 'epoch-b' }, { reconciliationGeneration: 2 }, { status: 'COMPLETED', completedAtMs: 20n, outcome: 'REJECTED' },
    ]) {
      expect(isPracticalLeaseBoundToFence(parsePracticalLeaseRow(leaseRow(overrides)), fence), JSON.stringify(overrides, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).toBe(false);
    }
    expect(isPracticalLeaseBoundToFence(parsePracticalLeaseRow(leaseRow()), parsePracticalFenceRow(fenceRow()))).toBe(false);
  });
});

describe('the held lease rests on its exact CONSUMED certificate: fence -> lease -> certificate (P18B-1B1-05)', () => {
  const LEASED_FENCE = { mode: 'MUTATION_LEASED', leaseId: 'lease-1', certificateId: CERT, leaseAction: 'CANCEL' };
  const inconsistent = { kind: 'MALFORMED', problem: 'ROWS_INCONSISTENT', reviewEpisodeId: null };
  const STATES = [
    ['MUTATING', { currentRecoveryEpisodeId: null }],
    ['QUARANTINED', {}],
    ['MANUAL_REVIEW_REQUIRED', { currentRecoveryEpisodeId: null, currentReviewEpisodeId: 'review-1' }],
  ] as const;
  const leasedRows = (state: (typeof STATES)[number][0], pointers: Record<string, unknown>, leasedCertificate: unknown): PracticalAccountRawRows => quarantinedRows({
    state: stateRow({ state, ...pointers }),
    recoveryEpisode: state === 'QUARANTINED' ? recoveryRow() : null,
    reviewEpisode: state === 'MANUAL_REVIEW_REQUIRED' ? reviewRow() : null,
    fence: fenceRow(LEASED_FENCE),
    lease: leaseRow(),
    leasedCertificate,
  });

  it.each(STATES)('%s: the exact CONSUMED certificate -> FOUND, carried as leasedCertificate (never as currentCertificate)', (state, pointers) => {
    const load = toPracticalAccountLoad(ACCOUNT, leasedRows(state, pointers, consumedCertificateRow()));
    expect(load).toMatchObject({ kind: 'FOUND', account: { state, currentCertificate: null, leasedCertificate: { certificateId: CERT, status: 'CONSUMED' } } });
  });

  const BROKEN: readonly (readonly [string, unknown, unknown])[] = [
    ['missing leased certificate', null, inconsistent],
    ['malformed leased certificate', consumedCertificateRow({ providerAccountFingerprint: 'not-a-digest' }), { kind: 'MALFORMED', problem: 'CERTIFICATE_ROW_INVALID', reviewEpisodeId: null }],
    ['certificate id mismatch', consumedCertificateRow({ certificateId: 'd'.repeat(64) }), inconsistent],
    ['certificate account mismatch', consumedCertificateRow({ accountId: 'account-live-2' }), inconsistent],
    ['certificate runtime epoch mismatch', consumedCertificateRow({ runtimeEpoch: 'epoch-b' }), inconsistent],
    ['certificate runtime epoch differs only by case', consumedCertificateRow({ runtimeEpoch: 'EPOCH-A' }), inconsistent],
    ['certificate generation mismatch', consumedCertificateRow({ reconciliationGeneration: 2 }), inconsistent],
    ['certificate still ISSUED', certificateRow(), inconsistent],
    ['certificate REVOKED', certificateRow({ status: 'REVOKED', terminalAtMs: 15n, terminalReason: 'WS_DISCONNECTED' }), inconsistent],
    ['certificate EXPIRED', certificateRow({ status: 'EXPIRED', terminalAtMs: 15n, terminalReason: 'CERTIFICATE_EXPIRED' }), inconsistent],
  ];

  for (const [state, pointers] of STATES) {
    it.each(BROKEN)(`${state}: %s -> MALFORMED (an invalidation never makes a broken chain valid)`, (_label, leasedCertificate, expected) => {
      expect(toPracticalAccountLoad(ACCOUNT, leasedRows(state, pointers, leasedCertificate))).toEqual(expected);
    });
  }

  it('a leased certificate read for a fence that is not leased is inconsistent', () => {
    expect(toPracticalAccountLoad(ACCOUNT, quarantinedRows({ leasedCertificate: consumedCertificateRow() }))).toEqual(inconsistent);
  });

  it('isPracticalCertificateBoundToLease requires every binding field and CONSUMED', () => {
    const lease = parsePracticalLeaseRow(leaseRow());
    expect(isPracticalCertificateBoundToLease(parsePracticalCertificateRow(consumedCertificateRow()), lease)).toBe(true);
    for (const row of [
      consumedCertificateRow({ certificateId: 'd'.repeat(64) }), consumedCertificateRow({ accountId: 'account-live-2' }),
      consumedCertificateRow({ runtimeEpoch: 'epoch-b' }), consumedCertificateRow({ reconciliationGeneration: 2 }),
      certificateRow(), certificateRow({ status: 'REVOKED', terminalAtMs: 15n, terminalReason: 'WS_DISCONNECTED' }),
      certificateRow({ status: 'EXPIRED', terminalAtMs: 15n, terminalReason: 'CERTIFICATE_EXPIRED' }),
    ]) {
      expect(isPracticalCertificateBoundToLease(parsePracticalCertificateRow(row), lease)).toBe(false);
    }
  });
});

describe('an INVALIDATION review episode must carry a MANUAL_REVIEW-severity reason', () => {
  it.each(PRACTICAL_INVALIDATION_REASONS.map((reason) => [reason, classifyPracticalInvalidation(reason)] as const))(
    '%s (%s)',
    (reason, severity) => {
      if (severity === 'MANUAL_REVIEW') {
        expect(parsePracticalReviewEpisodeRow(reviewRow({ reason }))).toMatchObject({ kind: 'INVALIDATION', reason });
      } else {
        expect(() => parsePracticalReviewEpisodeRow(reviewRow({ reason }))).toThrow(MALFORMED);
      }
    },
  );

  it('a MANUAL_REVIEW_REQUIRED account whose current episode has a QUARANTINE-severity reason is MALFORMED', () => {
    expect(toPracticalAccountLoad(ACCOUNT, quarantinedRows({
      state: stateRow({ state: 'MANUAL_REVIEW_REQUIRED', currentRecoveryEpisodeId: null, currentReviewEpisodeId: 'review-1' }),
      recoveryEpisode: null,
      reviewEpisode: reviewRow({ reason: 'WS_DISCONNECTED' }),
    }))).toEqual({ kind: 'MALFORMED', problem: 'REVIEW_EPISODE_ROW_INVALID', reviewEpisodeId: null });
  });
});

describe('the malformed-state latch (P18B-1B1-01)', () => {
  const latchRow = (overrides: Record<string, unknown> = {}) => ({ accountId: ACCOUNT, currentReviewEpisodeId: 'latched-1', revision: 0n, ...overrides });
  const latchEpisode = (overrides: Record<string, unknown> = {}) => reviewRow({
    reviewEpisodeId: 'latched-1', kind: 'MALFORMED_STATE', reason: 'DURABLE_STATE_MALFORMED', malformedProblem: 'FENCE_ROW_INVALID', ...overrides,
  });
  const brokenFence = fenceRow({ mode: 'CERTIFYING', runId: ' padded' });

  it('an active latch makes the load MALFORMED with the durable CURRENT reviewEpisodeId (rows still malformed)', () => {
    const load = toPracticalAccountLoad(ACCOUNT, quarantinedRows({ fence: brokenFence, latch: latchRow(), latchEpisode: latchEpisode() }));
    expect(load).toEqual({ kind: 'MALFORMED', problem: 'FENCE_ROW_INVALID', reviewEpisodeId: 'latched-1' });
    expect(practicalStartupStateFromLoad(load)).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('an active latch keeps the account MALFORMED even after the rows become valid, until resolution', () => {
    expect(toPracticalAccountLoad(ACCOUNT, quarantinedRows({ latch: latchRow(), latchEpisode: latchEpisode() })))
      .toEqual({ kind: 'MALFORMED', problem: 'LATCHED_PENDING_REVIEW', reviewEpisodeId: 'latched-1' });
  });

  it('an inactive (resolved) latch does not block a valid account, and is not a trusted absence without rows', () => {
    expect(toPracticalAccountLoad(ACCOUNT, quarantinedRows({ latch: latchRow({ currentReviewEpisodeId: null }) })).kind).toBe('FOUND');
    expect(toPracticalAccountLoad(ACCOUNT, quarantinedRows({ latch: latchRow({ currentReviewEpisodeId: null }), state: null, fence: null, recoveryEpisode: null })))
      .toEqual({ kind: 'MALFORMED', problem: 'PARTIAL_ACCOUNT_ROWS', reviewEpisodeId: null });
  });

  it.each([
    ['latch for another account', latchRow({ accountId: 'account-live-2' }), latchEpisode()],
    ['latch pointing at nothing', latchRow(), null],
    ['latch pointing at an invalidation episode', latchRow(), latchEpisode({ kind: 'INVALIDATION', reason: 'ORPHAN_ORDER', malformedProblem: null })],
    ['latch pointing at a resolved episode', latchRow(), latchEpisode({ status: 'RESOLVED', resolvedAtMs: 9n, resolutionId: 'r' })],
    ['latch pointing at another account\'s episode', latchRow(), latchEpisode({ accountId: 'account-live-2' })],
    ['latch with a padded episode id', latchRow({ currentReviewEpisodeId: ' latched-1' }), latchEpisode()],
    ['latch with an unsafe revision', latchRow({ revision: BigInt(Number.MAX_SAFE_INTEGER) + 1n }), latchEpisode()],
    ['episode row read for an inactive latch', latchRow({ currentReviewEpisodeId: null }), latchEpisode()],
  ])('%s -> MALFORMED (never "not latched", never absent)', (_label, latch, episode) => {
    const load = toPracticalAccountLoad(ACCOUNT, quarantinedRows({ latch, latchEpisode: episode }));
    expect(load.kind).toBe('MALFORMED');
    expect(practicalStartupStateFromLoad(load)).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('a malformed-state episode must carry exactly DURABLE_STATE_MALFORMED and a known safe problem code', () => {
    expect(parsePracticalReviewEpisodeRow(latchEpisode())).toMatchObject({ kind: 'MALFORMED_STATE', reason: 'DURABLE_STATE_MALFORMED', malformedProblem: 'FENCE_ROW_INVALID' });
    for (const overrides of [
      { reason: 'ORPHAN_ORDER' }, { malformedProblem: null }, { malformedProblem: 'raw row: {"mode":"x"}' }, { kind: 'SOMETHING' },
    ]) {
      expect(() => parsePracticalReviewEpisodeRow(latchEpisode(overrides)), JSON.stringify(overrides)).toThrow(MALFORMED);
    }
    expect(() => parsePracticalReviewEpisodeRow(reviewRow({ malformedProblem: 'FENCE_ROW_INVALID' }))).toThrow(MALFORMED);
    expect(() => parsePracticalReviewEpisodeRow(reviewRow({ reason: 'DURABLE_STATE_MALFORMED' }))).toThrow(MALFORMED);
  });
});

describe('[Stage 1B2] the lease row is closed-world: exactly UNBOUND (Stage 1B1) or ORDER-BOUND (Stage 1B2)', () => {
  const BINDING = { intentId: 'intent-1', clientOrderId: 'P17-client-order-1', cancelGeneration: 1 };
  const boundLeaseRow = (overrides: Record<string, unknown> = {}) => leaseRow({ ...BINDING, ...overrides });
  const show = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? `${String(v)}n` : v));

  it('an unarmed LEASED order-bound lease parses with its binding as frozen data', () => {
    const lease = parsePracticalLeaseRow(boundLeaseRow());
    expect(lease).toMatchObject({ status: 'LEASED', action: 'CANCEL', armedAtMs: null, outcome: null, orderBinding: BINDING });
    expect(Object.isFrozen(lease)).toBe(true);
    expect(Object.isFrozen(lease.orderBinding)).toBe(true);
  });

  it('an ARMED order-bound lease parses with its arm time (LEASED or COMPLETED)', () => {
    expect(parsePracticalLeaseRow(boundLeaseRow({ armedAtMs: 10n }))).toMatchObject({ armedAtMs: 10, status: 'LEASED' });
    expect(parsePracticalLeaseRow(boundLeaseRow({ armedAtMs: 11n, status: 'COMPLETED', completedAtMs: 11n, outcome: 'AMBIGUOUS' })))
      .toMatchObject({ armedAtMs: 11, completedAtMs: 11, outcome: 'AMBIGUOUS' });
  });

  it('a partial order binding is MALFORMED (never completed, never dropped)', () => {
    for (const overrides of [
      { intentId: null }, { clientOrderId: null }, { cancelGeneration: null },
      { intentId: null, clientOrderId: null }, { intentId: null, cancelGeneration: null }, { clientOrderId: null, cancelGeneration: null },
    ]) {
      expect(() => parsePracticalLeaseRow(boundLeaseRow(overrides)), show(overrides)).toThrow(MALFORMED);
    }
    expect(() => parsePracticalLeaseRow(leaseRow({ clientOrderId: 'P17-client-order-1' }))).toThrow(MALFORMED);
    expect(() => parsePracticalLeaseRow(leaseRow({ cancelGeneration: 1 }))).toThrow(MALFORMED);
  });

  it('only a CANCEL lease can be order-bound: OPEN and CLOSE are MALFORMED', () => {
    for (const action of ['OPEN', 'CLOSE']) {
      expect(() => parsePracticalLeaseRow(boundLeaseRow({ action })), action).toThrow(/Only a CANCEL lease can be order-bound/);
      // The same actions stay parseable on an UNBOUND Stage 1B1 row (unchanged compatibility; the Stage 1A policy refuses them upstream).
      expect(parsePracticalLeaseRow(leaseRow({ action }))).toMatchObject({ action, orderBinding: null });
    }
  });

  it('an unbound lease can never be armed; a bound one is never armed before it was created, nor completed before it was armed', () => {
    expect(() => parsePracticalLeaseRow(leaseRow({ armedAtMs: 11n }))).toThrow(/unbound \(Stage 1B1\) lease can never be armed/);
    expect(() => parsePracticalLeaseRow(boundLeaseRow({ armedAtMs: 9n }))).toThrow(/armed before it was created/);
    expect(() => parsePracticalLeaseRow(boundLeaseRow({ armedAtMs: 12n, status: 'COMPLETED', completedAtMs: 11n, outcome: 'AMBIGUOUS' })))
      .toThrow(/cannot complete before it was armed, or created if never armed/);
  });

  it('[Wave 1.6] an order-bound completion never predates the arm, or the creation when never armed', () => {
    const COMPLETION_TIME = /cannot complete before it was armed, or created if never armed/;
    // 1. unarmed, completed one millisecond before creation: refused.
    expect(() => parsePracticalLeaseRow(boundLeaseRow({ createdAtMs: 100n, status: 'COMPLETED', completedAtMs: 99n, outcome: 'PRE_DISPATCH_FAILURE' })))
      .toThrow(COMPLETION_TIME);
    // 2. unarmed, completed at the creation instant: accepted.
    expect(parsePracticalLeaseRow(boundLeaseRow({ createdAtMs: 100n, status: 'COMPLETED', completedAtMs: 100n, outcome: 'PRE_DISPATCH_FAILURE' })))
      .toMatchObject({ createdAtMs: 100, armedAtMs: null, completedAtMs: 100, outcome: 'PRE_DISPATCH_FAILURE' });
    // 3. armed, completed one millisecond before the arm (though after creation): refused.
    expect(() => parsePracticalLeaseRow(boundLeaseRow({ createdAtMs: 100n, armedAtMs: 110n, status: 'COMPLETED', completedAtMs: 109n, outcome: 'AMBIGUOUS' })))
      .toThrow(COMPLETION_TIME);
    // 4. armed, completed at the arm instant: accepted.
    expect(parsePracticalLeaseRow(boundLeaseRow({ createdAtMs: 100n, armedAtMs: 110n, status: 'COMPLETED', completedAtMs: 110n, outcome: 'AMBIGUOUS' })))
      .toMatchObject({ createdAtMs: 100, armedAtMs: 110, completedAtMs: 110 });
    // Legacy UNBOUND timing semantics are unchanged in this wave: an unbound completion is not time-coupled.
    expect(parsePracticalLeaseRow(leaseRow({ createdAtMs: 100n, status: 'COMPLETED', completedAtMs: 99n, outcome: 'PRE_DISPATCH_FAILURE' })))
      .toMatchObject({ orderBinding: null, completedAtMs: 99 });
  });

  it('a completed UNARMED order-bound lease records ONLY PRE_DISPATCH_FAILURE (nothing can have reached the wire)', () => {
    const completed = (outcome: string) => boundLeaseRow({ status: 'COMPLETED', completedAtMs: 12n, outcome });
    expect(parsePracticalLeaseRow(completed('PRE_DISPATCH_FAILURE'))).toMatchObject({ outcome: 'PRE_DISPATCH_FAILURE', armedAtMs: null });
    for (const outcome of ['ACCEPTED', 'REJECTED', 'AMBIGUOUS', 'DUPLICATE_CLIENT_ORDER_ID']) {
      expect(() => parsePracticalLeaseRow(completed(outcome)), outcome).toThrow(/impossible for its arm state/);
    }
  });

  it('a completed ARMED order-bound lease records ACCEPTED, REJECTED, AMBIGUOUS, or PRE_DISPATCH_FAILURE; never DUPLICATE_CLIENT_ORDER_ID', () => {
    const completed = (outcome: string) => boundLeaseRow({ armedAtMs: 11n, status: 'COMPLETED', completedAtMs: 12n, outcome });
    for (const outcome of ['ACCEPTED', 'REJECTED', 'AMBIGUOUS', 'PRE_DISPATCH_FAILURE']) {
      expect(parsePracticalLeaseRow(completed(outcome))).toMatchObject({ outcome });
    }
    expect(() => parsePracticalLeaseRow(completed('DUPLICATE_CLIENT_ORDER_ID'))).toThrow(/impossible for its arm state/);
    expect(() => parsePracticalLeaseRow(completed('SUCCESS'))).toThrow(MALFORMED);
  });

  it('legacy UNBOUND leases keep their Stage 1B1 semantics: any known outcome, never armed', () => {
    for (const outcome of ['ACCEPTED', 'REJECTED', 'AMBIGUOUS', 'DUPLICATE_CLIENT_ORDER_ID', 'PRE_DISPATCH_FAILURE']) {
      expect(parsePracticalLeaseRow(leaseRow({ status: 'COMPLETED', completedAtMs: 12n, outcome }))).toMatchObject({ outcome, orderBinding: null, armedAtMs: null });
    }
  });

  it('binding identifiers must be exact, non-empty, and fit their 64-character columns; the cancel generation a positive safe integer', () => {
    for (const overrides of [
      { intentId: '' }, { intentId: ' intent-1' }, { intentId: 'intent-1 ' }, { intentId: 'i'.repeat(65) }, { intentId: 7 },
      { clientOrderId: '' }, { clientOrderId: 'P17-client-order-1\t' }, { clientOrderId: 'c'.repeat(65) }, { clientOrderId: {} },
      { cancelGeneration: 0 }, { cancelGeneration: -1 }, { cancelGeneration: 1.5 }, { cancelGeneration: '1' },
      { cancelGeneration: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
      { armedAtMs: -1n }, { armedAtMs: 'soon' },
    ]) {
      expect(() => parsePracticalLeaseRow(boundLeaseRow(overrides)), show(overrides)).toThrow(MALFORMED);
    }
    expect(parsePracticalLeaseRow(boundLeaseRow({ intentId: 'i'.repeat(64), clientOrderId: 'c'.repeat(64) }))).toMatchObject({
      orderBinding: { intentId: 'i'.repeat(64), clientOrderId: 'c'.repeat(64), cancelGeneration: 1 },
    });
  });

  it('a row missing any Stage 1B2 column is MALFORMED (never defaulted to unbound)', () => {
    for (const column of ['intentId', 'clientOrderId', 'cancelGeneration', 'armedAtMs']) {
      const row: Record<string, unknown> = leaseRow();
      delete row[column];
      expect(() => parsePracticalLeaseRow(row), column).toThrow(MALFORMED);
    }
  });

  it('account assembly carries an order-bound lease under its leased fence, and a malformed bound lease fails the whole load closed', () => {
    const LEASED_FENCE = { mode: 'MUTATION_LEASED', leaseId: 'lease-1', certificateId: CERT, leaseAction: 'CANCEL' };
    const mutating = (lease: unknown) => quarantinedRows({
      state: stateRow({ state: 'MUTATING', currentRecoveryEpisodeId: null }), recoveryEpisode: null, fence: fenceRow(LEASED_FENCE),
      lease, leasedCertificate: consumedCertificateRow(),
    });
    expect(toPracticalAccountLoad(ACCOUNT, mutating(boundLeaseRow({ armedAtMs: 12n })))).toMatchObject({
      kind: 'FOUND', account: { state: 'MUTATING', currentLease: { leaseId: 'lease-1', armedAtMs: 12, orderBinding: BINDING } },
    });
    const load = toPracticalAccountLoad(ACCOUNT, mutating(boundLeaseRow({ cancelGeneration: null })));
    expect(load).toEqual({ kind: 'MALFORMED', problem: 'LEASE_ROW_INVALID', reviewEpisodeId: null });
    expect(practicalStartupStateFromLoad(load)).toBe('MANUAL_REVIEW_REQUIRED');
    // The fence -> lease check is unchanged by the order binding: a COMPLETED bound lease under a leased fence is inconsistent.
    expect(toPracticalAccountLoad(ACCOUNT, mutating(boundLeaseRow({ armedAtMs: 11n, status: 'COMPLETED', completedAtMs: 12n, outcome: 'AMBIGUOUS' }))))
      .toEqual({ kind: 'MALFORMED', problem: 'ROWS_INCONSISTENT', reviewEpisodeId: null });
  });
});
