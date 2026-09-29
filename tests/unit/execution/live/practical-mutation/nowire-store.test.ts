import { Prisma, type PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// [P18B Stage 1B2 Wave 2B2b] The STORE's own no-wire decisions, isolated: the Stage 1B1 caller-owned scope
// and the two Wave 2B2a no-wire primitives are recording doubles. This proves pre-DB refusals, the closed
// report, statement order (NO live_reconciliation_state), the release variant derived ONLY from the coupled
// durable pair, split / refusal classification, idempotent retry, the retry policy, and the ticket / handle
// lifecycles. The real scope and primitives run against real MySQL in the no-wire integration suite.
vi.mock('../../../../../src/execution/live/practical-persistence/repository', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../../src/execution/live/practical-persistence/repository')>();
  return { ...original, withLockedPracticalAccountWithinCallerTransaction: vi.fn() };
});
vi.mock('../../../../../src/execution/live/repository', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../../src/execution/live/repository')>();
  return {
    ...original,
    releaseUnarmedCancelClaimWithinCallerFencedTransaction: vi.fn(),
    releaseArmedUndispatchedCancelClaimWithinCallerFencedTransaction: vi.fn(),
  };
});

import * as practicalRepository from '../../../../../src/execution/live/practical-persistence/repository';
import * as liveRepository from '../../../../../src/execution/live/repository';
import { PracticalMutationError } from '../../../../../src/execution/live/practical-mutation/ports';
import { PrismaPracticalCancelMutationStore } from '../../../../../src/execution/live/practical-mutation/repository';
import {
  PracticalAcquiredCancel,
  PracticalArmedCancel,
  beginPracticalAcquiredCancelAbandon,
  issuePracticalAcquiredCancel,
  issuePracticalArmedCancel,
  markPracticalAcquiredCancelArmOutcomeUnknown,
  reservePracticalAcquiredCancel,
  spendPracticalAcquiredCancel,
  type PracticalAcquiredCancelRecord,
  type PracticalArmedCancelRecord,
} from '../../../../../src/execution/live/practical-mutation/ticket';
import type { LiveOrderStateRecord } from '../../../../../src/execution/live/types';

const ACCOUNT = 'acct-w2b2b-unit';
const INTENT = 'a'.repeat(64);
const CLIENT_ORDER_ID = `p17-${'b'.repeat(32)}`;
const CERTIFICATE_ID = 'c'.repeat(64);
const LEASE_ID = 'lease-w2b2b';
const EPOCH = 'epoch-w2b2b';
const GENERATION = 3;
const CREATED = 1_060_000;
const ARMED_AT = 1_061_000;
const NOW = 1_070_000;

interface OrderRow {
  intentId: string; accountId: string; clientOrderId: string; pair: string; state: string; cancelState: string; cancelGeneration: number;
  cancelWireArmed: boolean; exchangeOrderId: string | null; cancelExchangeOrderId: string | null; cancelFaultCode: string | null; revision: number;
}
const CLAIMED: OrderRow = {
  intentId: INTENT, accountId: ACCOUNT, clientOrderId: CLIENT_ORDER_ID, pair: 'B-BTC_USDT', state: 'CANCEL_REQUESTED', cancelState: 'CANCEL_RESERVED',
  cancelGeneration: 1, cancelWireArmed: false, exchangeOrderId: 'venue-1', cancelExchangeOrderId: 'venue-1', cancelFaultCode: null, revision: 3,
};
const ARMED: OrderRow = { ...CLAIMED, cancelWireArmed: true, revision: 4 };

function stateRecord(row: OrderRow): LiveOrderStateRecord {
  return {
    intentId: row.intentId, clientOrderId: row.clientOrderId, accountId: row.accountId, pair: row.pair, state: row.state as LiveOrderStateRecord['state'],
    exchangeOrderId: row.exchangeOrderId, orderedQuantity: '0.5', cumulativeFilledQuantity: '0', remainingQuantity: '0.5', averageFillPrice: null,
    lastExchangeStatus: null, lastProviderEventTimeMs: null, faultCode: null, cancelState: row.cancelState as LiveOrderStateRecord['cancelState'],
    cancelGeneration: row.cancelGeneration, cancelExchangeOrderId: row.cancelExchangeOrderId, cancelFaultCode: row.cancelFaultCode,
    dispatchWireArmed: false, cancelWireArmed: row.cancelWireArmed, revision: row.revision,
  };
}

function releasedOf(row: OrderRow): OrderRow {
  return { ...row, cancelState: 'NONE', cancelWireArmed: false, cancelFaultCode: null, revision: row.revision + 1 };
}

const CERTIFICATE = {
  certificateId: CERTIFICATE_ID, accountId: ACCOUNT, providerAccountFingerprint: 'f'.repeat(64), runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION,
  streamIncarnation: 1, evidenceDigest: 'e'.repeat(64), issuedAtMs: 1_000_000, expiresAtMs: 1_120_000, status: 'CONSUMED' as const, terminalAtMs: CREATED, terminalReason: null,
};

function lease(armedAtMs: number | null, overrides: Record<string, unknown> = {}) {
  return {
    leaseId: LEASE_ID, accountId: ACCOUNT, certificateId: CERTIFICATE_ID, action: 'CANCEL' as const, runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION,
    createdAtMs: CREATED, orderBinding: { intentId: INTENT, clientOrderId: CLIENT_ORDER_ID, cancelGeneration: 1 }, armedAtMs,
    status: 'LEASED' as const, completedAtMs: null, outcome: null, ...overrides,
  };
}

/** The retry inspection's result: the COMPLETED PRE_DISPATCH_FAILURE lease the fence no longer names, and its certificate. */
function completedLease(armedAtMs: number | null, overrides: Record<string, unknown> = {}, certificate: Record<string, unknown> = {}) {
  return {
    lease: lease(armedAtMs, { status: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE', completedAtMs: NOW, ...overrides }),
    certificate: { ...CERTIFICATE, ...certificate },
  };
}

function acquiredRecord(): PracticalAcquiredCancelRecord {
  return {
    accountId: ACCOUNT, leaseId: LEASE_ID, action: 'CANCEL', runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION, leaseCreatedAtMs: CREATED,
    intentId: INTENT, clientOrderId: CLIENT_ORDER_ID, cancelGeneration: 1, pair: 'B-BTC_USDT', exchangeOrderId: 'venue-1', orderRevisionAfterClaim: 3,
    certificate: {
      certificateId: CERTIFICATE_ID, accountId: ACCOUNT, providerAccountFingerprint: 'f'.repeat(64), runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION,
      streamIncarnation: 1, evidenceDigest: 'e'.repeat(64), issuedAtMs: 1_000_000, expiresAtMs: 1_120_000, status: 'CONSUMED', consumedAtMs: CREATED,
      terminalReason: null, basis: 'PRACTICAL_RECOVERY', provesAccountContinuity: false,
    },
    acquiredAtMs: CREATED,
  };
}

function armedRecord(): PracticalArmedCancelRecord {
  return {
    accountId: ACCOUNT, leaseId: LEASE_ID, certificateId: CERTIFICATE_ID, intentId: INTENT, clientOrderId: CLIENT_ORDER_ID, cancelGeneration: 1,
    exchangeOrderId: 'venue-1', pair: 'B-BTC_USDT', orderRevisionAfterArm: 4, runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION,
    certificateStreamIncarnation: 1, certificateExpiresAtMs: 1_120_000, armedAtMs: ARMED_AT, action: 'CANCEL', basis: 'PRACTICAL_RECOVERY', provesAccountContinuity: false,
  };
}

// ----- the recording world -----------------------------------------------------

interface World {
  log: string[];
  transactions: number;
  failBeforeWork: unknown[];
  failAtCommit: unknown;
  orderReads: (OrderRow | null)[];
  fence: { kind: string; leaseId: string | null };
}
let world: World;

const tx = {
  $queryRaw: async (query: Prisma.Sql) => {
    if (query.sql.includes('FROM live_order')) {
      world.log.push('LOCK live_order');
      const row = world.orderReads.length > 1 ? world.orderReads.shift()! : world.orderReads[0]!;
      return row === null ? [] : [{ ...row }];
    }
    throw new Error(`unexpected query: ${query.sql}`);
  },
  $executeRaw: async (query: Prisma.Sql) => {
    if (query.sql.includes('FROM live_execution_intent')) {
      world.log.push('LOCK live_execution_intent');
      return 1;
    }
    throw new Error(`unexpected statement: ${query.sql}`);
  },
};

function rootClient(): PrismaClient {
  const target = {
    $transaction: async (work: (client: unknown) => Promise<unknown>) => {
      world.transactions += 1;
      if (world.failBeforeWork.length > 0) throw world.failBeforeWork.shift();
      const value = await work(tx);
      if (world.failAtCommit !== null) throw world.failAtCommit;
      return value;
    },
  };
  return new Proxy(target, {
    get: (object, property) => {
      if (property === '$transaction') return object.$transaction;
      throw new Error(`the root client was used outside $transaction: ${String(property)}`);
    },
  }) as unknown as PrismaClient;
}

const scope = {
  get account() { return { fence: { mode: world.fence } }; },
  requireLeasedOrderBoundCancelLease: vi.fn(),
  completeOrderBoundCancelLeaseNoWire: vi.fn(),
  readOrderBoundCancelLease: vi.fn(),
};
const hook = vi.mocked(practicalRepository.withLockedPracticalAccountWithinCallerTransaction);
const releaseUnarmed = vi.mocked(liveRepository.releaseUnarmedCancelClaimWithinCallerFencedTransaction);
const releaseArmed = vi.mocked(liveRepository.releaseArmedUndispatchedCancelClaimWithinCallerFencedTransaction);
const enterManualReview = vi.spyOn(practicalRepository.PrismaPracticalSafetyRepository.prototype, 'enterManualReview');

let durableLease = lease(null);

beforeEach(() => {
  world = { log: [], transactions: 0, failBeforeWork: [], failAtCommit: null, orderReads: [{ ...CLAIMED }], fence: { kind: 'MUTATION_LEASED', leaseId: LEASE_ID } };
  durableLease = lease(null);
  for (const fn of [hook, releaseUnarmed, releaseArmed, scope.requireLeasedOrderBoundCancelLease, scope.completeOrderBoundCancelLeaseNoWire, scope.readOrderBoundCancelLease, enterManualReview]) {
    (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  hook.mockImplementation(async (_repository, transaction, accountId, work) => {
    expect(transaction).toBe(tx);
    world.log.push(`SCOPE open ${accountId}`);
    return work(scope as never);
  });
  scope.requireLeasedOrderBoundCancelLease.mockImplementation(async () => {
    world.log.push('SCOPE requireLeased');
    return { lease: durableLease, certificate: CERTIFICATE };
  });
  scope.completeOrderBoundCancelLeaseNoWire.mockImplementation(async (nowMs: number) => {
    world.log.push('SCOPE completeNoWire');
    return {
      lease: { ...durableLease, status: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE', completedAtMs: Math.max(nowMs, durableLease.armedAtMs ?? CREATED) },
      certificate: CERTIFICATE,
      account: { state: 'QUARANTINED', fence: { mode: { kind: 'IDLE' } } },
    };
  });
  const release = (name: string) => async (_tx: unknown, _intentId: string, _generation: number, _accountId: string) => {
    world.log.push(`PHASE17 ${name}`);
    const before = world.orderReads[0]!;
    const released = releasedOf(before);
    world.orderReads = [released];
    return stateRecord(released);
  };
  releaseUnarmed.mockImplementation(release('releaseUnarmed'));
  releaseArmed.mockImplementation(release('releaseArmedUndispatched'));
  enterManualReview.mockImplementation(async () => {
    world.log.push('MANUAL_REVIEW POST_MUTATION_MISMATCH');
    return { kind: 'ENTERED', reviewEpisodeId: 'review-1', account: {} } as never;
  });
});

function store(): PrismaPracticalCancelMutationStore {
  return new PrismaPracticalCancelMutationStore(rootClient());
}

const report = (reason = 'FINAL_STREAM_GUARD_FAILED') => ({ kind: 'NOT_DISPATCHED', reason });
const completeInput = (armed: unknown, overrides: Record<string, unknown> = {}) => ({ armed, report: report(), trustedNowMs: NOW, ...overrides }) as never;
const abandonInput = (acquired: unknown, overrides: Record<string, unknown> = {}) => ({ acquired, trustedNowMs: NOW, ...overrides });
const knownError = (code: string) => new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, { code, clientVersion: 'test' });
const NOWIRE_TAIL = ['LOCK live_order', 'LOCK live_execution_intent'];

function armedTicketWithDurableArm() {
  world.orderReads = [{ ...ARMED }];
  durableLease = lease(ARMED_AT);
  return issuePracticalArmedCancel(armedRecord());
}

// ---------------------------------------------------------------------------

describe('refusals BEFORE any durable access (zero transactions)', () => {
  it.each<[string, () => unknown]>([
    ['a non-record input', () => 'input'],
    ['an extra key', () => completeInput(issuePracticalArmedCancel(armedRecord()), { outcome: 'ACCEPTED' })],
    ['a structural ticket', () => completeInput({ ...issuePracticalArmedCancel(armedRecord()) })],
    ['a ticket record', () => completeInput(armedRecord())],
    ['a REJECTED report', () => completeInput(issuePracticalArmedCancel(armedRecord()), { report: { kind: 'REJECTED', reason: 'FINAL_STREAM_GUARD_FAILED' } })],
    ['an ACCEPTED report', () => completeInput(issuePracticalArmedCancel(armedRecord()), { report: { kind: 'ACCEPTED', reason: 'FINAL_STREAM_GUARD_FAILED' } })],
    ['a DISPATCHED_UNRESOLVED report', () => completeInput(issuePracticalArmedCancel(armedRecord()), { report: { kind: 'DISPATCHED_UNRESOLVED', reason: 'FINAL_STREAM_GUARD_FAILED' } })],
    ['a report with an observation', () => completeInput(issuePracticalArmedCancel(armedRecord()), { report: { ...report(), observation: {} } })],
    ['a report with a reasonCode', () => completeInput(issuePracticalArmedCancel(armedRecord()), { report: { ...report(), reasonCode: 'HTTP_400' } })],
    ['a report with a statusCode', () => completeInput(issuePracticalArmedCancel(armedRecord()), { report: { ...report(), statusCode: 400 } })],
    ['an unknown reason', () => completeInput(issuePracticalArmedCancel(armedRecord()), { report: report('PROVIDER_REJECTED') })],
    ['a non-record report', () => completeInput(issuePracticalArmedCancel(armedRecord()), { report: 'NOT_DISPATCHED' })],
    ['a negative time', () => completeInput(issuePracticalArmedCancel(armedRecord()), { trustedNowMs: -1 })],
  ])('completeUndispatchedCancel refuses %s', async (_name, input) => {
    await expect(store().completeUndispatchedCancel(input() as never)).rejects.toBeInstanceOf(PracticalMutationError);
    expect(world.transactions).toBe(0);
  });

  it('a refused ticket stays ARMED; a SPENT or COMPLETING ticket is refused', async () => {
    const ticket = armedTicketWithDurableArm();
    await expect(store().completeUndispatchedCancel(completeInput(ticket, { report: report('NOPE') }))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_INVALID_INPUT' });
    expect(PracticalArmedCancel.status(ticket)).toBe('ARMED');
    expect((await store().completeUndispatchedCancel(completeInput(ticket))).kind).toBe('COMPLETED');
    expect(PracticalArmedCancel.status(ticket)).toBe('SPENT');
    const transactions = world.transactions;
    await expect(store().completeUndispatchedCancel(completeInput(ticket))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    expect(world.transactions).toBe(transactions);
  });

  it.each<[string, () => unknown]>([
    ['a structural handle', () => ({ ...issuePracticalAcquiredCancel(acquiredRecord()) })],
    ['a handle record', () => acquiredRecord()],
    ['an IN_USE handle', () => { const handle = issuePracticalAcquiredCancel(acquiredRecord()); reservePracticalAcquiredCancel(handle); return handle; }],
    ['a SPENT handle', () => { const handle = issuePracticalAcquiredCancel(acquiredRecord()); reservePracticalAcquiredCancel(handle); spendPracticalAcquiredCancel(handle); return handle; }],
    ['an ABANDONING handle', () => { const handle = issuePracticalAcquiredCancel(acquiredRecord()); beginPracticalAcquiredCancelAbandon(handle); return handle; }],
  ])('abandonAcquiredCancel refuses %s', async (_name, value) => {
    await expect(store().abandonAcquiredCancel(abandonInput(value()))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    expect(world.transactions).toBe(0);
  });

  it('abandonAcquiredCancel refuses an extra key (no outcome, ticket, or arm-state input) with zero transactions', async () => {
    for (const extra of [{ outcome: 'PRE_DISPATCH_FAILURE' }, { armed: true }, { expectedWireArmed: false }]) {
      await expect(store().abandonAcquiredCancel(abandonInput(issuePracticalAcquiredCancel(acquiredRecord()), extra))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_INVALID_INPUT' });
    }
    expect(world.transactions).toBe(0);
  });
});

describe('the release variant is DERIVED from the locked coupled durable pair; no reconciliation lock', () => {
  it('ARMED ticket + armed pair: practical scope -> live_order -> intent -> armed-undispatched release (exact account) -> lease; ticket SPENT', async () => {
    const ticket = armedTicketWithDurableArm();
    const result = await store().completeUndispatchedCancel(completeInput(ticket));
    expect(result).toEqual({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE', leaseId: LEASE_ID, intentId: INTENT, cancelGeneration: 1 });
    expect(world.log).toEqual([`SCOPE open ${ACCOUNT}`, 'SCOPE requireLeased', ...NOWIRE_TAIL, 'PHASE17 releaseArmedUndispatched', 'SCOPE completeNoWire', ...NOWIRE_TAIL]);
    expect(world.log.some((entry) => entry.includes('reconciliation'))).toBe(false);
    expect(releaseArmed).toHaveBeenCalledWith(tx, INTENT, 1, ACCOUNT);
    expect(releaseUnarmed).not.toHaveBeenCalled();
    expect(scope.requireLeasedOrderBoundCancelLease.mock.calls[0]![0]).toEqual({
      leaseId: LEASE_ID, certificateId: CERTIFICATE_ID, runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION,
      binding: { intentId: INTENT, clientOrderId: CLIENT_ORDER_ID, cancelGeneration: 1 },
    });
    expect(scope.completeOrderBoundCancelLeaseNoWire).toHaveBeenCalledWith(NOW);
    expect(PracticalArmedCancel.status(ticket)).toBe('SPENT');
  });

  it('AVAILABLE handle + unarmed pair: unarmed release; handle SPENT', async () => {
    const handle = issuePracticalAcquiredCancel(acquiredRecord());
    expect((await store().abandonAcquiredCancel(abandonInput(handle))).kind).toBe('COMPLETED');
    expect(world.log).toEqual([`SCOPE open ${ACCOUNT}`, 'SCOPE requireLeased', ...NOWIRE_TAIL, 'PHASE17 releaseUnarmed', 'SCOPE completeNoWire', ...NOWIRE_TAIL]);
    expect(releaseUnarmed).toHaveBeenCalledWith(tx, INTENT, 1, ACCOUNT);
    expect(releaseArmed).not.toHaveBeenCalled();
    expect(PracticalAcquiredCancel.status(handle)).toBe('SPENT');
  });

  it.each([
    ['unarmed', null, CLAIMED, 'releaseUnarmed'],
    ['armed', ARMED_AT, ARMED, 'releaseArmedUndispatched'],
  ] as const)('ARM_OUTCOME_UNKNOWN handle + %s pair: the matching release, chosen only from the durable pair', async (_label, armedAtMs, row, primitive) => {
    const handle = issuePracticalAcquiredCancel(acquiredRecord());
    reservePracticalAcquiredCancel(handle);
    markPracticalAcquiredCancelArmOutcomeUnknown(handle);
    durableLease = lease(armedAtMs);
    world.orderReads = [{ ...row }];
    expect((await store().abandonAcquiredCancel(abandonInput(handle))).kind).toBe('COMPLETED');
    expect(world.log).toContain(`PHASE17 ${primitive}`);
    expect(releaseUnarmed.mock.calls.length + releaseArmed.mock.calls.length).toBe(1);
    expect(PracticalAcquiredCancel.status(handle)).toBe('SPENT');
  });
});

describe('split pairs roll back, enter manual review, and restore the ticket / handle; no release runs', () => {
  it.each<[string, () => unknown, () => void, (value: unknown) => string | null]>([
    ['ARMED ticket, durable pair unarmed (a committed arm is not durable)', () => issuePracticalArmedCancel(armedRecord()), () => { durableLease = lease(null); world.orderReads = [{ ...CLAIMED }]; }, (value) => PracticalArmedCancel.status(value)],
    ['ARMED ticket, lease armed / Phase 17 unarmed', () => issuePracticalArmedCancel(armedRecord()), () => { durableLease = lease(ARMED_AT); world.orderReads = [{ ...CLAIMED }]; }, (value) => PracticalArmedCancel.status(value)],
    ['ARMED ticket, Phase 17 claim already NONE', () => issuePracticalArmedCancel(armedRecord()), () => { durableLease = lease(ARMED_AT); world.orderReads = [releasedOf(ARMED)]; }, (value) => PracticalArmedCancel.status(value)],
    ['ARMED ticket, Phase 17 at another generation', () => issuePracticalArmedCancel(armedRecord()), () => { durableLease = lease(ARMED_AT); world.orderReads = [{ ...ARMED, cancelGeneration: 2 }]; }, (value) => PracticalArmedCancel.status(value)],
    ['AVAILABLE handle, durable pair armed', () => issuePracticalAcquiredCancel(acquiredRecord()), () => { durableLease = lease(ARMED_AT); world.orderReads = [{ ...ARMED }]; }, (value) => PracticalAcquiredCancel.status(value)],
    ['AVAILABLE handle, lease unarmed / Phase 17 armed', () => issuePracticalAcquiredCancel(acquiredRecord()), () => { durableLease = lease(null); world.orderReads = [{ ...ARMED }]; }, (value) => PracticalAcquiredCancel.status(value)],
  ])('%s', async (_name, value, setup, status) => {
    setup();
    const subject = value();
    const before = status(subject);
    const call = PracticalArmedCancel.read(subject) !== null
      ? store().completeUndispatchedCancel(completeInput(subject))
      : store().abandonAcquiredCancel(abandonInput(subject));
    await expect(call).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_SPLIT_STATE' });
    expect(releaseArmed).not.toHaveBeenCalled();
    expect(releaseUnarmed).not.toHaveBeenCalled();
    expect(scope.completeOrderBoundCancelLeaseNoWire).not.toHaveBeenCalled();
    expect(enterManualReview).toHaveBeenCalledWith({ accountId: ACCOUNT, reason: 'POST_MUTATION_MISMATCH', nowMs: NOW });
    expect(world.log.at(-1)).toBe('MANUAL_REVIEW POST_MUTATION_MISMATCH');
    expect(status(subject)).toBe(before);
  });
});

describe('exact refusals roll back with zero change and restore the ticket / handle', () => {
  it.each<[string, () => void]>([
    ['a different durable arm instant', () => { durableLease = lease(ARMED_AT + 1); }],
    ['a different certificate stream incarnation', () => { scope.requireLeasedOrderBoundCancelLease.mockResolvedValueOnce({ lease: durableLease, certificate: { ...CERTIFICATE, streamIncarnation: 2 } }); }],
    ['a case-variant Phase 17 client order id', () => { world.orderReads = [{ ...ARMED, clientOrderId: CLIENT_ORDER_ID.toUpperCase() }]; }],
    ['a case-variant Phase 17 account', () => { world.orderReads = [{ ...ARMED, accountId: ACCOUNT.toUpperCase() }]; }],
    ['another exchange order id', () => { world.orderReads = [{ ...ARMED, cancelExchangeOrderId: 'venue-2' }]; }],
    ['no Phase 17 order', () => { world.orderReads = [null]; }],
  ])('ARMED ticket: %s -> COMPLETION_REFUSED; ticket ARMED again', async (_name, setup) => {
    const ticket = armedTicketWithDurableArm();
    setup();
    await expect(store().completeUndispatchedCancel(completeInput(ticket))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMPLETION_REFUSED' });
    expect(releaseArmed).not.toHaveBeenCalled();
    expect(enterManualReview).not.toHaveBeenCalled();
    expect(PracticalArmedCancel.status(ticket)).toBe('ARMED');
  });

  it('abandon: a different certificate snapshot or lease creation instant -> COMPLETION_REFUSED; handle AVAILABLE again', async () => {
    const handle = issuePracticalAcquiredCancel(acquiredRecord());
    scope.requireLeasedOrderBoundCancelLease.mockResolvedValueOnce({ lease: durableLease, certificate: { ...CERTIFICATE, evidenceDigest: 'd'.repeat(64) } });
    await expect(store().abandonAcquiredCancel(abandonInput(handle))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMPLETION_REFUSED' });
    expect(PracticalAcquiredCancel.status(handle)).toBe('AVAILABLE');
    durableLease = lease(null, { createdAtMs: CREATED + 1 });
    await expect(store().abandonAcquiredCancel(abandonInput(handle))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMPLETION_REFUSED' });
    expect(PracticalAcquiredCancel.status(handle)).toBe('AVAILABLE');
    expect(releaseUnarmed).not.toHaveBeenCalled();
  });

  it('a scope refusal or a Phase 17 release conflict rolls back and restores; the same ticket then completes', async () => {
    const ticket = armedTicketWithDurableArm();
    scope.requireLeasedOrderBoundCancelLease.mockRejectedValueOnce(Object.assign(new Error('[PRACTICAL_PERSISTENCE_CONFLICT] tampered'), { code: 'PRACTICAL_PERSISTENCE_CONFLICT' }));
    await expect(store().completeUndispatchedCancel(completeInput(ticket))).rejects.toThrow(/tampered/);
    expect(PracticalArmedCancel.status(ticket)).toBe('ARMED');
    releaseArmed.mockRejectedValueOnce(new PracticalMutationError('PRACTICAL_MUTATION_FAULT', 'moved'));
    await expect(store().completeUndispatchedCancel(completeInput(ticket))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_FAULT' });
    expect(scope.completeOrderBoundCancelLeaseNoWire).not.toHaveBeenCalled();
    expect(PracticalArmedCancel.status(ticket)).toBe('ARMED');
    world.orderReads = [{ ...ARMED }];
    expect((await store().completeUndispatchedCancel(completeInput(ticket))).kind).toBe('COMPLETED');
  });
});

describe('retry policy, unknown commits, and idempotent retries', () => {
  it('deadlocks retry the WHOLE transaction (ticket held COMPLETING); exhaustion is a FAULT and the ticket is ARMED again', async () => {
    const ticket = armedTicketWithDurableArm();
    world.failBeforeWork = [knownError('P2034'), knownError('P2034'), knownError('P2034')];
    await expect(store().completeUndispatchedCancel(completeInput(ticket))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_FAULT' });
    expect(world.transactions).toBe(3);
    expect(PracticalArmedCancel.status(ticket)).toBe('ARMED');
    world.failBeforeWork = [knownError('P2034')];
    expect((await store().completeUndispatchedCancel(completeInput(ticket))).kind).toBe('COMPLETED');
    expect(world.transactions).toBe(5);
  });

  it('non-retryable database errors (1205 timeout, P1017) are a FAULT without retry', async () => {
    const ticket = armedTicketWithDurableArm();
    world.failBeforeWork = [knownError('P1017')];
    await expect(store().completeUndispatchedCancel(completeInput(ticket))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_FAULT' });
    expect(world.transactions).toBe(1);
    expect(PracticalArmedCancel.status(ticket)).toBe('ARMED');
  });

  it('an UNKNOWN completion commit -> COMMIT_UNKNOWN; only the IDENTICAL reason may retry, and an already-durable completion is ALREADY_COMPLETED', async () => {
    const ticket = armedTicketWithDurableArm();
    world.failAtCommit = knownError('P1017');
    await expect(store().completeUndispatchedCancel(completeInput(ticket))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    expect(PracticalArmedCancel.status(ticket)).toBe('COMMIT_UNKNOWN');
    world.failAtCommit = null;
    // A different reason is refused before any durable access.
    const transactions = world.transactions;
    await expect(store().completeUndispatchedCancel(completeInput(ticket, { report: report('ABORTED_BEFORE_DISPATCH') }))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    expect(world.transactions).toBe(transactions);
    // The durable completion DID commit: the fence no longer holds the lease.
    world.fence = { kind: 'IDLE', leaseId: null };
    scope.readOrderBoundCancelLease.mockResolvedValueOnce(completedLease(ARMED_AT, { outcome: 'PRE_DISPATCH_FAILURE' }));
    world.orderReads = [releasedOf(ARMED)];
    expect((await store().completeUndispatchedCancel(completeInput(ticket))).kind).toBe('ALREADY_COMPLETED');
    expect(releaseArmed).toHaveBeenCalledTimes(1);
    expect(PracticalArmedCancel.status(ticket)).toBe('SPENT');
  });

  it('an unknown commit whose transaction did NOT commit: the identical retry completes normally', async () => {
    const ticket = armedTicketWithDurableArm();
    world.failAtCommit = knownError('P1017');
    await expect(store().completeUndispatchedCancel(completeInput(ticket))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    world.failAtCommit = null;
    world.orderReads = [{ ...ARMED }];
    expect((await store().completeUndispatchedCancel(completeInput(ticket))).kind).toBe('COMPLETED');
    expect(PracticalArmedCancel.status(ticket)).toBe('SPENT');
  });

  it('a FRESH ticket whose lease another operation already completed is ALREADY_COMPLETED (an error), never a success', async () => {
    const ticket = armedTicketWithDurableArm();
    world.fence = { kind: 'IDLE', leaseId: null };
    scope.readOrderBoundCancelLease.mockResolvedValueOnce(completedLease(ARMED_AT, { outcome: 'PRE_DISPATCH_FAILURE' }));
    world.orderReads = [releasedOf(ARMED)];
    await expect(store().completeUndispatchedCancel(completeInput(ticket))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_ALREADY_COMPLETED' });
    expect(PracticalArmedCancel.status(ticket)).toBe('ARMED');
  });

  it('a completed lease with a DIFFERENT outcome, or a completed lease whose claim was not released (split), is refused', async () => {
    const ticket = armedTicketWithDurableArm();
    world.fence = { kind: 'IDLE', leaseId: null };
    scope.readOrderBoundCancelLease.mockResolvedValueOnce(completedLease(ARMED_AT, { outcome: 'AMBIGUOUS' }));
    await expect(store().completeUndispatchedCancel(completeInput(ticket))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_ALREADY_COMPLETED' });
    scope.readOrderBoundCancelLease.mockResolvedValueOnce(completedLease(ARMED_AT, { outcome: 'PRE_DISPATCH_FAILURE' }));
    world.orderReads = [{ ...ARMED }];
    await expect(store().completeUndispatchedCancel(completeInput(ticket))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_SPLIT_STATE' });
    expect(enterManualReview).toHaveBeenCalledTimes(1);
    expect(PracticalArmedCancel.status(ticket)).toBe('ARMED');
  });

  it('abandon: unknown commit -> ABANDON_OUTCOME_UNKNOWN; the retry keeps the ORIGINAL origin (AVAILABLE never permits an armed pair)', async () => {
    const handle = issuePracticalAcquiredCancel(acquiredRecord());
    world.failAtCommit = knownError('P1017');
    await expect(store().abandonAcquiredCancel(abandonInput(handle))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    expect(PracticalAcquiredCancel.status(handle)).toBe('ABANDON_OUTCOME_UNKNOWN');
    world.failAtCommit = null;
    durableLease = lease(ARMED_AT);
    world.orderReads = [{ ...ARMED }];
    await expect(store().abandonAcquiredCancel(abandonInput(handle))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_SPLIT_STATE' });
    expect(PracticalAcquiredCancel.status(handle)).toBe('ABANDON_OUTCOME_UNKNOWN');
    world.fence = { kind: 'IDLE', leaseId: null };
    scope.readOrderBoundCancelLease.mockResolvedValueOnce(completedLease(null, { outcome: 'PRE_DISPATCH_FAILURE' }));
    world.orderReads = [releasedOf(CLAIMED)];
    expect((await store().abandonAcquiredCancel(abandonInput(handle))).kind).toBe('ALREADY_COMPLETED');
    expect(PracticalAcquiredCancel.status(handle)).toBe('SPENT');
  });
});

describe('the idempotent retry re-proves the exact identity and arm origin before ALREADY_COMPLETED', () => {
  /** A genuine COMMIT_UNKNOWN ticket whose completion is (as far as the retry can tell) durable. */
  async function commitUnknownTicket() {
    const ticket = armedTicketWithDurableArm();
    world.failAtCommit = knownError('P1017');
    await expect(store().completeUndispatchedCancel(completeInput(ticket))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    expect(PracticalArmedCancel.status(ticket)).toBe('COMMIT_UNKNOWN');
    world.failAtCommit = null;
    world.fence = { kind: 'IDLE', leaseId: null };
    world.orderReads = [releasedOf(ARMED)];
    releaseArmed.mockClear();
    scope.completeOrderBoundCancelLeaseNoWire.mockClear();
    return ticket;
  }

  /** A genuine ABANDON_OUTCOME_UNKNOWN handle of the given origin. */
  async function abandonUnknownHandle(origin: 'AVAILABLE' | 'ARM_OUTCOME_UNKNOWN') {
    const handle = issuePracticalAcquiredCancel(acquiredRecord());
    if (origin === 'ARM_OUTCOME_UNKNOWN') {
      reservePracticalAcquiredCancel(handle);
      markPracticalAcquiredCancelArmOutcomeUnknown(handle);
    }
    world.failAtCommit = knownError('P1017');
    await expect(store().abandonAcquiredCancel(abandonInput(handle))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    expect(PracticalAcquiredCancel.status(handle)).toBe('ABANDON_OUTCOME_UNKNOWN');
    world.failAtCommit = null;
    world.fence = { kind: 'IDLE', leaseId: null };
    world.orderReads = [releasedOf(CLAIMED)];
    releaseUnarmed.mockClear();
    scope.completeOrderBoundCancelLeaseNoWire.mockClear();
    return handle;
  }

  function expectNoWriteAttempted(): void {
    expect(releaseArmed).not.toHaveBeenCalled();
    expect(releaseUnarmed).not.toHaveBeenCalled();
    expect(scope.completeOrderBoundCancelLeaseNoWire).not.toHaveBeenCalled();
    expect(enterManualReview).not.toHaveBeenCalled();
  }

  it.each<[string, () => void]>([
    ['a case-variant Phase 17 pair', () => { world.orderReads = [{ ...releasedOf(ARMED), pair: 'b-btc_usdt' }]; }],
    ['another Phase 17 pair', () => { world.orderReads = [{ ...releasedOf(ARMED), pair: 'B-ETH_USDT' }]; }],
    ['a case-variant exchange order id', () => { world.orderReads = [{ ...releasedOf(ARMED), exchangeOrderId: 'VENUE-1' }]; }],
    ['another exchange order id', () => { world.orderReads = [{ ...releasedOf(ARMED), exchangeOrderId: 'venue-2' }]; }],
    ['a case-variant cancel exchange order id at the released generation', () => { world.orderReads = [{ ...releasedOf(ARMED), cancelExchangeOrderId: 'VENUE-1' }]; }],
    ['a cancel fault at the released generation', () => { world.orderReads = [{ ...releasedOf(ARMED), cancelFaultCode: 'CANCEL_AMBIGUOUS' }]; }],
    ['a case-variant Phase 17 client order id', () => { world.orderReads = [{ ...releasedOf(ARMED), clientOrderId: CLIENT_ORDER_ID.toUpperCase() }]; }],
    ['a different certificate stream incarnation', () => { scope.readOrderBoundCancelLease.mockResolvedValueOnce(completedLease(ARMED_AT, {}, { streamIncarnation: 2 })); }],
    ['a completed lease with a different arm instant', () => { scope.readOrderBoundCancelLease.mockResolvedValueOnce(completedLease(ARMED_AT + 1)); }],
    ['a completed lease that was never armed', () => { scope.readOrderBoundCancelLease.mockResolvedValueOnce(completedLease(null)); }],
  ])('COMMIT_UNKNOWN ticket retry: %s -> COMPLETION_REFUSED, never ALREADY_COMPLETED; the ticket stays COMMIT_UNKNOWN', async (_name, tamper) => {
    const ticket = await commitUnknownTicket();
    scope.readOrderBoundCancelLease.mockResolvedValue(completedLease(ARMED_AT)); // the untampered default; a tamper queues a one-shot override
    tamper();
    await expect(store().completeUndispatchedCancel(completeInput(ticket))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMPLETION_REFUSED' });
    expectNoWriteAttempted();
    expect(PracticalArmedCancel.status(ticket)).toBe('COMMIT_UNKNOWN');
  });

  it('COMMIT_UNKNOWN ticket retry: an OLDER Phase 17 generation is a split (manual review), never ALREADY_COMPLETED', async () => {
    const ticket = await commitUnknownTicket();
    scope.readOrderBoundCancelLease.mockResolvedValueOnce(completedLease(ARMED_AT));
    world.orderReads = [{ ...releasedOf(ARMED), cancelGeneration: 0 }];
    await expect(store().completeUndispatchedCancel(completeInput(ticket))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_SPLIT_STATE' });
    expect(releaseArmed).not.toHaveBeenCalled();
    expect(PracticalArmedCancel.status(ticket)).toBe('COMMIT_UNKNOWN');
  });

  it('COMMIT_UNKNOWN ticket retry: a LATER cancel generation (its own claim, reserved and armed) is still ALREADY_COMPLETED', async () => {
    const ticket = await commitUnknownTicket();
    scope.readOrderBoundCancelLease.mockResolvedValueOnce(completedLease(ARMED_AT));
    world.orderReads = [{ ...ARMED, cancelGeneration: 2, cancelExchangeOrderId: 'venue-1', cancelFaultCode: null }];
    expect((await store().completeUndispatchedCancel(completeInput(ticket))).kind).toBe('ALREADY_COMPLETED');
    expectNoWriteAttempted();
    expect(PracticalArmedCancel.status(ticket)).toBe('SPENT');
  });

  it.each<[string, () => void]>([
    ['a completed lease that is ARMED (tampered armedAtMs)', () => { scope.readOrderBoundCancelLease.mockResolvedValueOnce(completedLease(ARMED_AT)); }],
    ['a completed lease with another creation instant', () => { scope.readOrderBoundCancelLease.mockResolvedValueOnce(completedLease(null, { createdAtMs: CREATED + 1 })); }],
    ['a different certificate snapshot', () => { scope.readOrderBoundCancelLease.mockResolvedValueOnce(completedLease(null, {}, { evidenceDigest: 'd'.repeat(64) })); }],
    ['a case-variant Phase 17 pair', () => { scope.readOrderBoundCancelLease.mockResolvedValueOnce(completedLease(null)); world.orderReads = [{ ...releasedOf(CLAIMED), pair: 'B-BTC_usdt' }]; }],
    ['a case-variant exchange order id', () => { scope.readOrderBoundCancelLease.mockResolvedValueOnce(completedLease(null)); world.orderReads = [{ ...releasedOf(CLAIMED), exchangeOrderId: 'Venue-1' }]; }],
  ])('AVAILABLE-origin ABANDON_OUTCOME_UNKNOWN retry: %s -> COMPLETION_REFUSED; the handle stays ABANDON_OUTCOME_UNKNOWN', async (_name, tamper) => {
    const handle = await abandonUnknownHandle('AVAILABLE');
    tamper();
    await expect(store().abandonAcquiredCancel(abandonInput(handle))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMPLETION_REFUSED' });
    expectNoWriteAttempted();
    expect(PracticalAcquiredCancel.status(handle)).toBe('ABANDON_OUTCOME_UNKNOWN');
  });

  it.each([['unarmed', null], ['armed', ARMED_AT]] as const)('ARM_OUTCOME_UNKNOWN-origin retry: a completed %s lease is ALREADY_COMPLETED (either coupled pair)', async (_label, armedAtMs) => {
    const handle = await abandonUnknownHandle('ARM_OUTCOME_UNKNOWN');
    scope.readOrderBoundCancelLease.mockResolvedValueOnce(completedLease(armedAtMs));
    expect((await store().abandonAcquiredCancel(abandonInput(handle))).kind).toBe('ALREADY_COMPLETED');
    expectNoWriteAttempted();
    expect(PracticalAcquiredCancel.status(handle)).toBe('SPENT');
  });
});
