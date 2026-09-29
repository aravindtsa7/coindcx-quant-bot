import { describe, expect, it } from 'vitest';
import { PracticalRecoveryCertificate } from '../../../../../src/execution/live/practical/certificate';
import { PracticalLiveSafetyEnablement } from '../../../../../src/execution/live/practical/policy';
import { LiveReconciliationAuthorization } from '../../../../../src/execution/live/reconciliation/repository';
import * as ticketModule from '../../../../../src/execution/live/practical-mutation/ticket';
import {
  PracticalAcquiredCancel,
  PracticalArmedCancel,
  beginPracticalAcquiredCancelAbandon,
  beginPracticalArmedCancelNoWireCompletion,
  finishPracticalAcquiredCancelAbandon,
  finishPracticalArmedCancelNoWireCompletion,
  issuePracticalAcquiredCancel,
  issuePracticalArmedCancel,
  markPracticalAcquiredCancelAbandonOutcomeUnknown,
  markPracticalAcquiredCancelArmOutcomeUnknown,
  markPracticalArmedCancelCommitUnknown,
  releasePracticalAcquiredCancel,
  reservePracticalAcquiredCancel,
  restorePracticalAcquiredCancelAbandon,
  restorePracticalArmedCancel,
  spendPracticalAcquiredCancel,
  type PracticalAcquiredCancelRecord,
  type PracticalArmedCancelRecord,
} from '../../../../../src/execution/live/practical-mutation/ticket';

// [P18B Stage 1B2 Wave 2B1] The acquired handle and the armed ticket are non-forgeable, validated on
// issue, carry no continuity claim, are not strict authority, and have the reviewed lifecycle.

const DIGEST = (c: string) => c.repeat(64);

function acquiredRecord(overrides: Partial<PracticalAcquiredCancelRecord> = {}): PracticalAcquiredCancelRecord {
  return {
    accountId: 'acct-w2b1', leaseId: 'lease-w2b1', action: 'CANCEL', runtimeEpoch: 'epoch-now', reconciliationGeneration: 3, leaseCreatedAtMs: 1_060_000,
    intentId: DIGEST('a'), clientOrderId: `p17-${'b'.repeat(32)}`, cancelGeneration: 1, pair: 'B-BTC_USDT', exchangeOrderId: 'venue-1', orderRevisionAfterClaim: 3,
    certificate: {
      certificateId: DIGEST('c'), accountId: 'acct-w2b1', providerAccountFingerprint: DIGEST('f'), runtimeEpoch: 'epoch-now', reconciliationGeneration: 3,
      streamIncarnation: 1, evidenceDigest: DIGEST('e'), issuedAtMs: 1_000_000, expiresAtMs: 1_120_000, status: 'CONSUMED', consumedAtMs: 1_060_000,
      terminalReason: null, basis: 'PRACTICAL_RECOVERY', provesAccountContinuity: false,
    },
    acquiredAtMs: 1_060_000,
    ...overrides,
  };
}

function armedRecord(overrides: Partial<PracticalArmedCancelRecord> = {}): PracticalArmedCancelRecord {
  return {
    accountId: 'acct-w2b1', leaseId: 'lease-w2b1', certificateId: DIGEST('c'), intentId: DIGEST('a'), clientOrderId: `p17-${'b'.repeat(32)}`, cancelGeneration: 1,
    exchangeOrderId: 'venue-1', pair: 'B-BTC_USDT', orderRevisionAfterArm: 4, runtimeEpoch: 'epoch-now', reconciliationGeneration: 3,
    certificateStreamIncarnation: 1, certificateExpiresAtMs: 1_120_000, armedAtMs: 1_061_000, action: 'CANCEL', basis: 'PRACTICAL_RECOVERY', provesAccountContinuity: false,
    ...overrides,
  };
}

describe('non-forgeable', () => {
  it('a genuine handle / ticket reads back its frozen record; clones, spreads, JSON, and prototype-only objects read null', () => {
    const handle = issuePracticalAcquiredCancel(acquiredRecord());
    const ticket = issuePracticalArmedCancel(armedRecord());
    expect(PracticalAcquiredCancel.read(handle)).toEqual(acquiredRecord());
    expect(PracticalArmedCancel.read(ticket)).toEqual(armedRecord());
    expect(Object.isFrozen(PracticalAcquiredCancel.read(handle))).toBe(true);
    expect(Object.isFrozen(PracticalAcquiredCancel.read(handle)!.certificate)).toBe(true);
    for (const forged of [{ ...handle }, JSON.parse(JSON.stringify(handle)), Object.create(PracticalAcquiredCancel.prototype), acquiredRecord(), structuredClone(acquiredRecord()), null, 'handle']) {
      expect(PracticalAcquiredCancel.read(forged)).toBeNull();
      expect(PracticalAcquiredCancel.status(forged)).toBeNull();
    }
    for (const forged of [{ ...ticket }, JSON.parse(JSON.stringify(ticket)), Object.create(PracticalArmedCancel.prototype), armedRecord(), null]) {
      expect(PracticalArmedCancel.read(forged)).toBeNull();
    }
    // A handle is not a ticket, and neither is the other's record.
    expect(PracticalArmedCancel.read(handle)).toBeNull();
    expect(PracticalAcquiredCancel.read(ticket)).toBeNull();
  });

  it('the constructors refuse anything but the module-private issuer; class and prototype are frozen', () => {
    expect(() => new PracticalAcquiredCancel({ purpose: 'p18b-stage1b2-practical-cancel-ticket' }, acquiredRecord())).toThrow(/PRACTICAL_MUTATION_AUTHORITY_INVALID/);
    expect(() => new PracticalArmedCancel(undefined, armedRecord())).toThrow(/PRACTICAL_MUTATION_AUTHORITY_INVALID/);
    expect(Object.isFrozen(PracticalAcquiredCancel)).toBe(true);
    expect(Object.isFrozen(PracticalAcquiredCancel.prototype)).toBe(true);
    expect(Object.isFrozen(PracticalArmedCancel)).toBe(true);
    expect(Object.isFrozen(PracticalArmedCancel.prototype)).toBe(true);
    expect(Object.isFrozen(issuePracticalArmedCancel(armedRecord()))).toBe(true);
    // The lifecycle transitions refuse a caller without the issuer.
    expect(() => PracticalAcquiredCancel.transition({}, issuePracticalAcquiredCancel(acquiredRecord()), 'AVAILABLE', 'SPENT')).toThrow(/internal/);
    expect(() => PracticalArmedCancel.transition({}, issuePracticalArmedCancel(armedRecord()), 'ARMED', 'SPENT', null)).toThrow(/internal/);
    expect(() => PracticalAcquiredCancel.beginAbandon({}, issuePracticalAcquiredCancel(acquiredRecord()))).toThrow(/internal/);
  });

  it('neither is, reads as, or converts to strict authority, a certificate, or an enablement; neither claims continuity', () => {
    const handle = issuePracticalAcquiredCancel(acquiredRecord());
    const ticket = issuePracticalArmedCancel(armedRecord());
    for (const value of [handle, ticket]) {
      expect(LiveReconciliationAuthorization.read(value)).toBeNull();
      expect(PracticalRecoveryCertificate.read(value)).toBeNull();
      expect(PracticalLiveSafetyEnablement.read(value)).toBeNull();
      expect((value as { provesAccountContinuity: unknown }).provesAccountContinuity).toBe(false);
      expect(JSON.stringify(value)).toBe('{}');
    }
    expect(PracticalArmedCancel.read(ticket)).toMatchObject({ basis: 'PRACTICAL_RECOVERY', provesAccountContinuity: false, action: 'CANCEL' });
    expect(Object.keys(PracticalArmedCancel.read(ticket)!)).not.toContain('accountContinuityProven');
  });
});

describe('validated on issue: every field and every coupling', () => {
  it.each([
    ['action OPEN', { action: 'OPEN' }],
    ['uppercase intent id', { intentId: DIGEST('A') }],
    ['caller-style client order id', { clientOrderId: 'my-own-id' }],
    ['zero cancel generation', { cancelGeneration: 0 }],
    ['padded lease id', { leaseId: ' lease' }],
    ['over-long exchange order id', { exchangeOrderId: 'x'.repeat(65) }],
    ['lease created at another instant', { leaseCreatedAtMs: 1_060_001 }],
    ['acquired at another instant', { acquiredAtMs: 1_059_999 }],
    ['other account', { accountId: 'acct-other' }],
    ['other epoch', { runtimeEpoch: 'epoch-other' }],
    ['other generation', { reconciliationGeneration: 4 }],
  ] as const)('refuses an acquired handle with %s', (_name, change) => {
    expect(() => issuePracticalAcquiredCancel(acquiredRecord(change as Partial<PracticalAcquiredCancelRecord>))).toThrow(/PRACTICAL_MUTATION_AUTHORITY_INVALID/);
  });

  it.each([
    ['status ISSUED', { status: 'ISSUED' }],
    ['a terminal reason', { terminalReason: 'PREFLIGHT_MISMATCH' }],
    ['basis STRICT', { basis: 'STRICT' }],
    ['provesAccountContinuity true', { provesAccountContinuity: true }],
    ['uppercase fingerprint', { providerAccountFingerprint: DIGEST('F') }],
    ['expiry not after issuance', { expiresAtMs: 1_000_000 }],
    ['zero stream incarnation', { streamIncarnation: 0 }],
  ] as const)('refuses a certificate snapshot with %s', (_name, change) => {
    const record = acquiredRecord();
    expect(() => issuePracticalAcquiredCancel({ ...record, certificate: { ...record.certificate, ...change } as never })).toThrow(/PRACTICAL_MUTATION_AUTHORITY_INVALID/);
  });

  it.each([
    ['provesAccountContinuity true', { provesAccountContinuity: true }],
    ['action CLOSE', { action: 'CLOSE' }],
    ['non-digest certificate id', { certificateId: 'cert' }],
    ['zero revision', { orderRevisionAfterArm: 0 }],
  ] as const)('refuses an armed ticket with %s', (_name, change) => {
    expect(() => issuePracticalArmedCancel(armedRecord(change as never))).toThrow(/PRACTICAL_MUTATION_AUTHORITY_INVALID/);
  });
});

describe('the acquired-handle lifecycle and the one-shot armed ticket', () => {
  it('AVAILABLE -> IN_USE -> AVAILABLE (proven rollback) -> IN_USE -> SPENT; nothing leaves SPENT', () => {
    const handle = issuePracticalAcquiredCancel(acquiredRecord());
    expect(PracticalAcquiredCancel.status(handle)).toBe('AVAILABLE');
    expect(reservePracticalAcquiredCancel(handle)).toEqual(acquiredRecord());
    expect(PracticalAcquiredCancel.status(handle)).toBe('IN_USE');
    // A second concurrent reservation in this process is refused while in use.
    expect(() => reservePracticalAcquiredCancel(handle)).toThrow(/IN_USE/);
    releasePracticalAcquiredCancel(handle);
    expect(PracticalAcquiredCancel.status(handle)).toBe('AVAILABLE');
    reservePracticalAcquiredCancel(handle);
    spendPracticalAcquiredCancel(handle);
    expect(PracticalAcquiredCancel.status(handle)).toBe('SPENT');
    expect(() => reservePracticalAcquiredCancel(handle)).toThrow(/SPENT/);
    expect(() => releasePracticalAcquiredCancel(handle)).toThrow(/SPENT/);
    expect(() => spendPracticalAcquiredCancel(handle)).toThrow(/SPENT/);
    // The record stays readable (audit), but the handle can never be reserved again.
    expect(PracticalAcquiredCancel.read(handle)).toEqual(acquiredRecord());
  });

  it('release and spend require IN_USE; forged handles are refused by every transition', () => {
    const handle = issuePracticalAcquiredCancel(acquiredRecord());
    expect(() => releasePracticalAcquiredCancel(handle)).toThrow(/AVAILABLE, not IN_USE/);
    expect(() => spendPracticalAcquiredCancel(handle)).toThrow(/AVAILABLE, not IN_USE/);
    for (const forged of [{ ...handle }, acquiredRecord(), null]) {
      expect(() => reservePracticalAcquiredCancel(forged)).toThrow(/genuine/);
    }
  });

});

describe('[Wave 2B2b] no take, no dispatch state', () => {
  it('the ticket module exports no take* function and the armed ticket has no take / isTaken / dispatch surface', () => {
    expect(Object.keys(ticketModule).filter((name) => /^take/i.test(name))).toEqual([]);
    expect('take' in PracticalArmedCancel).toBe(false);
    expect('isTaken' in PracticalArmedCancel).toBe(false);
    const ticket = issuePracticalArmedCancel(armedRecord());
    expect(PracticalArmedCancel.status(ticket)).toBe('ARMED');
    // No path leads from ARMED to any dispatch-like state: the only transition targets are the no-wire ones.
    for (const target of ['DISPATCHED', 'PERMITTED', 'TAKEN']) {
      expect(() => PracticalArmedCancel.transition({}, ticket, 'ARMED', target as never, null)).toThrow(/internal/);
    }
  });
});

describe('[Wave 2B2b] the armed-ticket no-wire lifecycle', () => {
  it('ARMED -> COMPLETING_NO_WIRE -> ARMED (proven rollback) -> COMPLETING_NO_WIRE -> SPENT; nothing leaves SPENT', () => {
    const ticket = issuePracticalArmedCancel(armedRecord());
    expect(beginPracticalArmedCancelNoWireCompletion(ticket, 'FINAL_STREAM_GUARD_FAILED')).toEqual({ record: armedRecord(), from: 'ARMED' });
    expect(PracticalArmedCancel.status(ticket)).toBe('COMPLETING_NO_WIRE');
    // A second concurrent completion in this process is refused while completing.
    expect(() => beginPracticalArmedCancelNoWireCompletion(ticket, 'FINAL_STREAM_GUARD_FAILED')).toThrow(/COMPLETING_NO_WIRE cannot be completed/);
    restorePracticalArmedCancel(ticket, 'ARMED', 'FINAL_STREAM_GUARD_FAILED');
    expect(PracticalArmedCancel.status(ticket)).toBe('ARMED');
    beginPracticalArmedCancelNoWireCompletion(ticket, 'ABORTED_BEFORE_DISPATCH');
    finishPracticalArmedCancelNoWireCompletion(ticket);
    expect(PracticalArmedCancel.status(ticket)).toBe('SPENT');
    expect(() => beginPracticalArmedCancelNoWireCompletion(ticket, 'ABORTED_BEFORE_DISPATCH')).toThrow(/SPENT cannot be completed/);
    expect(PracticalArmedCancel.read(ticket)).toEqual(armedRecord());
  });

  it('COMMIT_UNKNOWN accepts ONLY the identical reason, and can be restored to COMMIT_UNKNOWN after a proven rollback', () => {
    const ticket = issuePracticalArmedCancel(armedRecord());
    beginPracticalArmedCancelNoWireCompletion(ticket, 'DISPATCH_WINDOW_CLOSED');
    markPracticalArmedCancelCommitUnknown(ticket, 'DISPATCH_WINDOW_CLOSED');
    expect(PracticalArmedCancel.status(ticket)).toBe('COMMIT_UNKNOWN');
    expect(() => beginPracticalArmedCancelNoWireCompletion(ticket, 'FINAL_STREAM_GUARD_FAILED')).toThrow(/identical/);
    expect(PracticalArmedCancel.status(ticket)).toBe('COMMIT_UNKNOWN');
    expect(beginPracticalArmedCancelNoWireCompletion(ticket, 'DISPATCH_WINDOW_CLOSED').from).toBe('COMMIT_UNKNOWN');
    restorePracticalArmedCancel(ticket, 'COMMIT_UNKNOWN', 'DISPATCH_WINDOW_CLOSED');
    expect(PracticalArmedCancel.status(ticket)).toBe('COMMIT_UNKNOWN');
    expect(() => beginPracticalArmedCancelNoWireCompletion(ticket, 'ABORTED_BEFORE_DISPATCH')).toThrow(/identical/);
    beginPracticalArmedCancelNoWireCompletion(ticket, 'DISPATCH_WINDOW_CLOSED');
    finishPracticalArmedCancelNoWireCompletion(ticket);
    expect(PracticalArmedCancel.status(ticket)).toBe('SPENT');
  });

  it('forged tickets are refused by every transition, and no transition runs outside COMPLETING_NO_WIRE', () => {
    const ticket = issuePracticalArmedCancel(armedRecord());
    for (const forged of [{ ...ticket }, JSON.parse(JSON.stringify(ticket)), armedRecord(), null]) {
      expect(() => beginPracticalArmedCancelNoWireCompletion(forged, 'FINAL_STREAM_GUARD_FAILED')).toThrow(/genuine/);
      expect(PracticalArmedCancel.status(forged)).toBeNull();
    }
    expect(() => finishPracticalArmedCancelNoWireCompletion(ticket)).toThrow(/ARMED, not COMPLETING_NO_WIRE/);
    expect(() => markPracticalArmedCancelCommitUnknown(ticket, 'FINAL_STREAM_GUARD_FAILED')).toThrow(/ARMED, not COMPLETING_NO_WIRE/);
    expect(() => restorePracticalArmedCancel(ticket, 'SPENT' as never, 'FINAL_STREAM_GUARD_FAILED')).toThrow(/started from/);
  });
});

describe('[Wave 2B2b] the acquired-handle unknown-arm and abandon lifecycle', () => {
  it('an unknown arm commit leaves ARM_OUTCOME_UNKNOWN: it cannot be reserved (so no ticket can follow), only abandoned', () => {
    const handle = issuePracticalAcquiredCancel(acquiredRecord());
    reservePracticalAcquiredCancel(handle);
    markPracticalAcquiredCancelArmOutcomeUnknown(handle);
    expect(PracticalAcquiredCancel.status(handle)).toBe('ARM_OUTCOME_UNKNOWN');
    expect(() => reservePracticalAcquiredCancel(handle)).toThrow(/ARM_OUTCOME_UNKNOWN, not AVAILABLE/);
    expect(() => spendPracticalAcquiredCancel(handle)).toThrow(/ARM_OUTCOME_UNKNOWN/);
    expect(beginPracticalAcquiredCancelAbandon(handle)).toEqual({ record: acquiredRecord(), from: 'ARM_OUTCOME_UNKNOWN', origin: 'ARM_OUTCOME_UNKNOWN' });
    expect(PracticalAcquiredCancel.status(handle)).toBe('ABANDONING');
    finishPracticalAcquiredCancelAbandon(handle);
    expect(PracticalAcquiredCancel.status(handle)).toBe('SPENT');
  });

  it('abandon: AVAILABLE -> ABANDONING -> AVAILABLE (proven rollback) -> ABANDONING -> ABANDON_OUTCOME_UNKNOWN -> retry keeps the ORIGINAL origin', () => {
    const handle = issuePracticalAcquiredCancel(acquiredRecord());
    const first = beginPracticalAcquiredCancelAbandon(handle);
    expect(first).toMatchObject({ from: 'AVAILABLE', origin: 'AVAILABLE' });
    expect(() => beginPracticalAcquiredCancelAbandon(handle)).toThrow(/ABANDONING cannot be abandoned/);
    expect(() => reservePracticalAcquiredCancel(handle)).toThrow(/ABANDONING/);
    restorePracticalAcquiredCancelAbandon(handle, 'AVAILABLE');
    expect(PracticalAcquiredCancel.status(handle)).toBe('AVAILABLE');
    beginPracticalAcquiredCancelAbandon(handle);
    markPracticalAcquiredCancelAbandonOutcomeUnknown(handle);
    expect(PracticalAcquiredCancel.status(handle)).toBe('ABANDON_OUTCOME_UNKNOWN');
    expect(() => reservePracticalAcquiredCancel(handle)).toThrow(/ABANDON_OUTCOME_UNKNOWN/);
    const retry = beginPracticalAcquiredCancelAbandon(handle);
    expect(retry).toMatchObject({ from: 'ABANDON_OUTCOME_UNKNOWN', origin: 'AVAILABLE' });
    restorePracticalAcquiredCancelAbandon(handle, 'ABANDON_OUTCOME_UNKNOWN');
    expect(PracticalAcquiredCancel.status(handle)).toBe('ABANDON_OUTCOME_UNKNOWN');
    beginPracticalAcquiredCancelAbandon(handle);
    finishPracticalAcquiredCancelAbandon(handle);
    expect(PracticalAcquiredCancel.status(handle)).toBe('SPENT');
    expect(() => beginPracticalAcquiredCancelAbandon(handle)).toThrow(/SPENT cannot be abandoned/);
  });

  it('IN_USE and SPENT handles cannot be abandoned; forged handles are refused; restore only to an abandonable origin', () => {
    const handle = issuePracticalAcquiredCancel(acquiredRecord());
    reservePracticalAcquiredCancel(handle);
    expect(() => beginPracticalAcquiredCancelAbandon(handle)).toThrow(/IN_USE cannot be abandoned/);
    spendPracticalAcquiredCancel(handle);
    expect(() => beginPracticalAcquiredCancelAbandon(handle)).toThrow(/SPENT cannot be abandoned/);
    for (const forged of [{ ...handle }, acquiredRecord(), null]) expect(() => beginPracticalAcquiredCancelAbandon(forged)).toThrow(/genuine/);
    const other = issuePracticalAcquiredCancel(acquiredRecord());
    beginPracticalAcquiredCancelAbandon(other);
    expect(() => restorePracticalAcquiredCancelAbandon(other, 'IN_USE')).toThrow(/started from/);
  });
});
