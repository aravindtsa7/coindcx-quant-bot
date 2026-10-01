import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { PrismaPracticalCancelMutationStore } from '../../../../../src/execution/live/practical-mutation/repository';
import { issuePracticalArmedCancel, PracticalArmedCancel, PracticalCancelDispatchOwner,
reservePracticalCancelPermitCreation, restorePracticalCancelPermitCreation,
issuePracticalCancelDispatchPermit, issuePracticalCancelDispatchAttempt, transitionPracticalCancelDispatchOwner,
markPracticalCancelPermitCreationUnknown, issuePracticalCancelCreationCleanup,
enterPracticalCancelGateway, issuePracticalCancelOutcome, issuePracticalCancelTransportNoWire,
PRACTICAL_CANCEL_DISPATCH_TRANSITIONS, type PracticalAcquiredCancelRecord, type PracticalArmedCancelRecord } from '../../../../../src/execution/live/practical-mutation/ticket';
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

function permission() {
  const ticket = issuePracticalArmedCancel(armedRecord(), acquiredRecord());
  reservePracticalCancelPermitCreation(ticket);
  return { ticket, permission: issuePracticalCancelDispatchPermit(ticket) };
}
function attempt() {
  const seed = permission();
  transitionPracticalCancelDispatchOwner(seed.permission, 'READY', 'CONSUMING');
  return { ...seed, attempt: issuePracticalCancelDispatchAttempt(seed.permission) };
}

describe('closed dispatch ownership lifecycle (synthetic fixtures only)', () => {
  it('requires original immutable provenance, transfers once and preserves its frozen snapshot', () => {
    expect(() => reservePracticalCancelPermitCreation(issuePracticalArmedCancel(armedRecord()))).toThrow(/provenance/);
    const original = acquiredRecord();
    const ticket = issuePracticalArmedCancel(armedRecord(), original);
    expect(PracticalArmedCancel.provenance(ticket)?.certificate.evidenceDigest).toBe(original.certificate.evidenceDigest);
    reservePracticalCancelPermitCreation(ticket);
    const value = issuePracticalCancelDispatchPermit(ticket);
    expect(PracticalArmedCancel.status(ticket)).toBe('TRANSFERRED');
    expect(() => reservePracticalCancelPermitCreation(ticket)).toThrow();
    expect(() => restorePracticalCancelPermitCreation(ticket)).toThrow();
    const record = PracticalCancelDispatchOwner.read(value)!;
    expect(record.original).toEqual(original);
    expect(Object.isFrozen(record.original.certificate)).toBe(true);
    expect(Object.isFrozen(value)).toBe(true);
    expect(JSON.stringify(value)).toBe('{}');
  });

  it('reserves synchronously, restores only the legal rollback edge and refuses reentrancy', () => {
    const seed = permission();
    transitionPracticalCancelDispatchOwner(seed.permission, 'READY', 'CONSUMING');
    expect(() => transitionPracticalCancelDispatchOwner(seed.permission, 'READY', 'CONSUMING')).toThrow();
    transitionPracticalCancelDispatchOwner(seed.permission, 'CONSUMING', 'READY');
    transitionPracticalCancelDispatchOwner(seed.permission, 'READY', 'CONSUMING');
    transitionPracticalCancelDispatchOwner(seed.permission, 'CONSUMING', 'REFUSED');
    expect(() => transitionPracticalCancelDispatchOwner(seed.permission, 'REFUSED', 'READY')).toThrow();
    expect(() => issuePracticalCancelDispatchAttempt(seed.permission)).toThrow();
    expect(PRACTICAL_CANCEL_DISPATCH_TRANSITIONS.REFUSED).toEqual([]);
  });

  it('unknown consumption cannot dispatch or return to READY', () => {
    const seed = permission();
    transitionPracticalCancelDispatchOwner(seed.permission, 'READY', 'CONSUMING');
    transitionPracticalCancelDispatchOwner(seed.permission, 'CONSUMING', 'CONSUMPTION_UNKNOWN');
    expect(() => transitionPracticalCancelDispatchOwner(seed.permission, 'CONSUMPTION_UNKNOWN', 'READY')).toThrow();
    expect(() => issuePracticalCancelDispatchAttempt(seed.permission)).toThrow();
    expect(() => enterPracticalCancelGateway(seed.permission)).toThrow();
  });

  it('clones, prototypes, JSON, accessors and structural records have no ownership', () => {
    const seed = attempt();
    const fakes = [{}, { ...seed.attempt }, JSON.parse(JSON.stringify(seed.attempt)), Object.create(PracticalCancelDispatchOwner.prototype), { role: 'ATTEMPT', status: 'UNENTERED' }, Object.defineProperty({}, 'role', { get() { throw new Error('TEST_ACCESSOR'); } })];
    for (const fake of fakes) {
      expect(PracticalCancelDispatchOwner.read(fake)).toBeNull();
      expect(() => enterPracticalCancelGateway(fake)).toThrow();
      expect(() => issuePracticalCancelOutcome(fake, { kind: 'CANCEL_ACCEPTED' })).toThrow();
    }
    expect(() => new PracticalCancelDispatchOwner({}, PracticalCancelDispatchOwner.read(seed.attempt)!, 'UNENTERED')).toThrow();
  });

  it('entry is one-shot and transfers result ownership exactly once', () => {
    const seed = attempt();
    const request = enterPracticalCancelGateway(seed.attempt);
    expect(request).toEqual(armedRecord());
    expect(() => enterPracticalCancelGateway(seed.attempt)).toThrow();
    const receipt = issuePracticalCancelOutcome(seed.attempt, { kind: 'CANCEL_ACCEPTED' });
    expect(PracticalCancelDispatchOwner.status(seed.attempt)).toBe('RESULT_RECORDED');
    expect(PracticalCancelDispatchOwner.read(receipt)?.result).toEqual({ kind: 'CANCEL_ACCEPTED', reason: null });
    expect(() => issuePracticalCancelOutcome(seed.attempt, { kind: 'REJECTED' })).toThrow();
    expect(() => enterPracticalCancelGateway(receipt)).toThrow();
    expect(() => transitionPracticalCancelDispatchOwner(receipt, 'READY', 'CONSUMING')).toThrow(/different ownership role/);
  });

  it.each([
    undefined, null, new Error('synthetic raw error'), { kind: 'PRE_DISPATCH_FAILURE' },
    { kind: 'PRE_DISPATCH_FAILURE', noWire: {} }, { kind: 'CANCEL_ACCEPTED', observation: {} },
    { kind: 'REJECTED', reason: 'RAW_PROVIDER_MESSAGE' }, { kind: 'AMBIGUOUS', credentials: 'SYNTHETIC_UNTRUSTED' },
    Object.create({ kind: 'CANCEL_ACCEPTED' }),
    Object.defineProperty({}, 'kind', { enumerable: true, get() { throw new Error('TEST_ACCESSOR'); } }),
  ])('unexpected post-entry result becomes fixed possible-wire ambiguity', (reported) => {
    const seed = attempt();
    enterPracticalCancelGateway(seed.attempt);
    const receipt = issuePracticalCancelOutcome(seed.attempt, reported);
    expect(PracticalCancelDispatchOwner.read(receipt)?.result).toEqual({ kind: 'AMBIGUOUS', reason: 'UNEXPECTED_RESULT' });
    expect(JSON.stringify(PracticalCancelDispatchOwner.read(receipt)?.result)).not.toMatch(/RAW_PROVIDER|synthetic raw|SYNTHETIC_UNTRUSTED/);
  });

  it('a genuine no-wire result is attempt-bound; a wrong-attempt token gives ambiguity', () => {
    const first = attempt(), second = attempt();
    enterPracticalCancelGateway(first.attempt);
    enterPracticalCancelGateway(second.attempt);
    const proof = issuePracticalCancelTransportNoWire(first.attempt);
    const wrong = issuePracticalCancelOutcome(second.attempt, { kind: 'PRE_DISPATCH_FAILURE', noWire: proof });
    expect(PracticalCancelDispatchOwner.read(wrong)?.result?.kind).toBe('AMBIGUOUS');
    const right = issuePracticalCancelOutcome(first.attempt, { kind: 'PRE_DISPATCH_FAILURE', noWire: proof });
    expect(PracticalCancelDispatchOwner.read(right)?.result).toEqual({ kind: 'PRE_DISPATCH_FAILURE', reason: 'LOCAL_REQUEST_REFUSED' });
    expect(() => issuePracticalCancelTransportNoWire(first.attempt)).toThrow();
  });

  it('cleanup unknown state allows only identical reason and never consumption', () => {
    const seed = permission();
    transitionPracticalCancelDispatchOwner(seed.permission, 'READY', 'CLEANING', 'ABORTED_BEFORE_DISPATCH');
    transitionPracticalCancelDispatchOwner(seed.permission, 'CLEANING', 'CLEANUP_UNKNOWN');
    expect(() => transitionPracticalCancelDispatchOwner(seed.permission, 'CLEANUP_UNKNOWN', 'CONSUMING')).toThrow();
    expect(() => transitionPracticalCancelDispatchOwner(seed.permission, 'CLEANUP_UNKNOWN', 'CLEANING', 'FINAL_STREAM_GUARD_FAILED')).toThrow();
    transitionPracticalCancelDispatchOwner(seed.permission, 'CLEANUP_UNKNOWN', 'CLEANING', 'ABORTED_BEFORE_DISPATCH');
    transitionPracticalCancelDispatchOwner(seed.permission, 'CLEANING', 'SPENT');
  });

  it.each(['READY', 'CREATION_UNKNOWN', 'UNENTERED', 'CONSUMPTION_UNKNOWN'] as const)('%s cleanup retains its original revision bounds through repeated unknown retries', (origin) => {
    let owner;
    if (origin === 'CREATION_UNKNOWN') {
      const ticket = issuePracticalArmedCancel(armedRecord(), acquiredRecord());
      reservePracticalCancelPermitCreation(ticket);
      markPracticalCancelPermitCreationUnknown(ticket);
      owner = issuePracticalCancelCreationCleanup(ticket);
    } else if (origin === 'UNENTERED') owner = attempt().attempt;
    else {
      owner = permission().permission;
      if (origin === 'CONSUMPTION_UNKNOWN') {
        transitionPracticalCancelDispatchOwner(owner, 'READY', 'CONSUMING');
        transitionPracticalCancelDispatchOwner(owner, 'CONSUMING', 'CONSUMPTION_UNKNOWN');
      }
    }
    const from = PracticalCancelDispatchOwner.status(owner)!;
    const expected = origin === 'UNENTERED' ? [5] : origin === 'CONSUMPTION_UNKNOWN' ? [4, 5] : [4];
    expect(PracticalCancelDispatchOwner.cleanupRevisions(owner)).toBeNull();
    transitionPracticalCancelDispatchOwner(owner, from, 'CLEANING', 'ABORTED_BEFORE_DISPATCH');
    for (let retry = 0; retry < 3; retry += 1) {
      expect(PracticalCancelDispatchOwner.cleanupRevisions(owner)).toEqual(expected);
      expect(Object.isFrozen(PracticalCancelDispatchOwner.cleanupRevisions(owner))).toBe(true);
      transitionPracticalCancelDispatchOwner(owner, 'CLEANING', 'CLEANUP_UNKNOWN');
      expect(() => transitionPracticalCancelDispatchOwner(owner, 'CLEANUP_UNKNOWN', 'CLEANING', 'FINAL_STREAM_GUARD_FAILED')).toThrow();
      transitionPracticalCancelDispatchOwner(owner, 'CLEANUP_UNKNOWN', 'CLEANING', 'ABORTED_BEFORE_DISPATCH');
      expect(() => transitionPracticalCancelDispatchOwner(owner, 'CLEANING', origin === 'UNENTERED' ? 'UNENTERED' : 'READY')).toThrow(/origin/);
    }
    transitionPracticalCancelDispatchOwner(owner, 'CLEANING', 'CLEANUP_UNKNOWN');
    expect(PracticalCancelDispatchOwner.cleanupRevisions(owner)).toEqual(expected);
    expect(() => enterPracticalCancelGateway(owner)).toThrow();
  });

  it('proven cleanup rollback restores only its reserved origin and clears its reason', () => {
    const owner = permission().permission;
    transitionPracticalCancelDispatchOwner(owner, 'READY', 'CLEANING', 'ABORTED_BEFORE_DISPATCH');
    expect(() => transitionPracticalCancelDispatchOwner(owner, 'CLEANING', 'CONSUMPTION_UNKNOWN')).toThrow(/origin/);
    transitionPracticalCancelDispatchOwner(owner, 'CLEANING', 'READY');
    expect(PracticalCancelDispatchOwner.cleanupRevisions(owner)).toBeNull();
    transitionPracticalCancelDispatchOwner(owner, 'READY', 'CLEANING', 'FINAL_STREAM_GUARD_FAILED');
    expect(PracticalCancelDispatchOwner.cleanupRevisions(owner)).toEqual([4]);
  });

  it.each(['createCancelDispatchPermission', 'consumeCancelDispatchPermission', 'completeUnenteredCancelDispatch', 'completeCancelLease'] as const)('%s rejects forged/hostile inputs before database access', async (method) => {
    let accessed = false;
    const client = { $transaction: () => { accessed = true; throw new Error('TEST_DATABASE_ACCESSED'); } } as unknown as PrismaClient;
    const store = new PrismaPracticalCancelMutationStore(client);
    const fakes = [{}, Object.create({ armed: {} }), Object.defineProperty({}, 'armed', { enumerable: true, get() { throw new Error('TEST_HOSTILE_ACCESSOR'); } }),
      { armed: {}, permission: {}, owner: {}, outcome: {}, enablement: {}, runtimeIdentity: {}, trustedNowMs: 1 }];
    for (const input of fakes) await expect(store[method](input as never)).rejects.toThrow();
    expect(accessed).toBe(false);
  });
});
