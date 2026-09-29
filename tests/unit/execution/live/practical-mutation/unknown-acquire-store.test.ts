import { Prisma, type PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// [P18B Stage 1B2 Wave 2B2c] The STORE's own unknown-acquire resolution decisions, isolated: the Stage 1B1
// caller-owned scope is a recording double. This proves the pre-DB refusals, the statement order (practical
// inspection -> live_order -> intent; NO live_reconciliation_state), RESTORED only for an exactly restorable
// lease (the INTENDED handle, unchanged), NOT_COMMITTED only for a provable absence, every anomaly reason (no
// handle, receipt permanently mint-disabled, escalation), the escalation-only retry, and the inconclusive paths.
// The real scope runs against real MySQL in the unknown-acquire integration suite.
vi.mock('../../../../../src/execution/live/practical-persistence/repository', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../../src/execution/live/practical-persistence/repository')>();
  return { ...original, withLockedPracticalAccountWithinCallerTransaction: vi.fn() };
});

import * as practicalRepository from '../../../../../src/execution/live/practical-persistence/repository';
import { PracticalPersistenceError } from '../../../../../src/execution/live/practical-persistence/ports';
import { PracticalAcquireCommitUnknownError, PracticalMutationError } from '../../../../../src/execution/live/practical-mutation/ports';
import { PrismaPracticalCancelMutationStore } from '../../../../../src/execution/live/practical-mutation/repository';
import {
  PracticalAcquiredCancel,
  PracticalUnknownAcquire,
  issuePracticalUnknownAcquire,
  type PracticalAcquiredCancelRecord,
} from '../../../../../src/execution/live/practical-mutation/ticket';
import { newLiveRuntimeIdentity, readLiveRuntimeEpoch } from '../../../../../src/execution/live/reconciliation/barrier';

const IDENTITY = newLiveRuntimeIdentity();
const EPOCH = readLiveRuntimeEpoch(IDENTITY)!;
const ACCOUNT = 'acct-w2b2c-unit';
const INTENT = 'a'.repeat(64);
const CLIENT_ORDER_ID = `p17-${'b'.repeat(32)}`;
const CERTIFICATE_ID = 'c'.repeat(64);
const LEASE_ID = '6f1c1d62-2b2c-4d0e-9a51-attempted00';
const GENERATION = 3;
const CREATED = 1_060_000;
const NOW = 1_070_000;

function intendedRecord(): PracticalAcquiredCancelRecord {
  return {
    accountId: ACCOUNT, leaseId: LEASE_ID, action: 'CANCEL', runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION, leaseCreatedAtMs: CREATED,
    intentId: INTENT, clientOrderId: CLIENT_ORDER_ID, cancelGeneration: 2, pair: 'B-BTC_USDT', exchangeOrderId: 'venue-1', orderRevisionAfterClaim: 5,
    certificate: {
      certificateId: CERTIFICATE_ID, accountId: ACCOUNT, providerAccountFingerprint: 'f'.repeat(64), runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION,
      streamIncarnation: 1, evidenceDigest: 'e'.repeat(64), issuedAtMs: 1_000_000, expiresAtMs: 1_120_000, status: 'CONSUMED', consumedAtMs: CREATED,
      terminalReason: null, basis: 'PRACTICAL_RECOVERY', provesAccountContinuity: false,
    },
    acquiredAtMs: CREATED,
  };
}

const CERTIFICATE = {
  certificateId: CERTIFICATE_ID, accountId: ACCOUNT, providerAccountFingerprint: 'f'.repeat(64), runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION,
  streamIncarnation: 1, evidenceDigest: 'e'.repeat(64), issuedAtMs: 1_000_000, expiresAtMs: 1_120_000, status: 'CONSUMED', terminalAtMs: CREATED, terminalReason: null,
};

const LEASE = {
  leaseId: LEASE_ID, accountId: ACCOUNT, certificateId: CERTIFICATE_ID, action: 'CANCEL', runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION,
  createdAtMs: CREATED, orderBinding: { intentId: INTENT, clientOrderId: CLIENT_ORDER_ID, cancelGeneration: 2 }, armedAtMs: null,
  status: 'LEASED', completedAtMs: null, outcome: null,
};

const LEASED_FENCE = {
  accountId: ACCOUNT, runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION, revision: 7,
  mode: { kind: 'MUTATION_LEASED', leaseId: LEASE_ID, certificateId: CERTIFICATE_ID, action: 'CANCEL' },
};
const IDLE_FENCE = { accountId: ACCOUNT, runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION, revision: 7, mode: { kind: 'IDLE' } };

const CLAIMED_ORDER = {
  intentId: INTENT, accountId: ACCOUNT, clientOrderId: CLIENT_ORDER_ID, pair: 'B-BTC_USDT', state: 'CANCEL_REQUESTED', cancelState: 'CANCEL_RESERVED',
  cancelGeneration: 2, cancelWireArmed: false, exchangeOrderId: 'venue-1', cancelExchangeOrderId: 'venue-1', cancelFaultCode: null, revision: 5,
};

// ----- the recording world -----------------------------------------------------

interface World {
  log: string[];
  transactions: number;
  failBeforeWork: unknown[];
  failAtCommit: unknown;
  account: { state: string; fence: unknown };
  inspection: { certificate: unknown; certificateLeaseIds: readonly string[]; lease: unknown };
  order: Record<string, unknown> | null;
  hookError: unknown;
  gate: Promise<void> | null;
}
let world: World;

const tx = {
  $queryRaw: async (query: Prisma.Sql) => {
    if (query.sql.includes('FROM live_order')) {
      world.log.push('LOCK live_order');
      return world.order === null ? [] : [{ ...world.order }];
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
  get account() { return world.account; },
  inspectAttemptedOrderBoundCancelLease: vi.fn(),
};
const hook = vi.mocked(practicalRepository.withLockedPracticalAccountWithinCallerTransaction);
const enterManualReview = vi.spyOn(practicalRepository.PrismaPracticalSafetyRepository.prototype, 'enterManualReview');
const escalateMalformed = vi.spyOn(practicalRepository.PrismaPracticalSafetyRepository.prototype, 'escalateMalformedAccount');

beforeEach(() => {
  world = {
    log: [], transactions: 0, failBeforeWork: [], failAtCommit: null,
    account: { state: 'MUTATING', fence: LEASED_FENCE },
    inspection: { certificate: CERTIFICATE, certificateLeaseIds: [LEASE_ID], lease: LEASE },
    order: { ...CLAIMED_ORDER }, hookError: null, gate: null,
  };
  for (const fn of [hook, scope.inspectAttemptedOrderBoundCancelLease, enterManualReview, escalateMalformed]) (fn as ReturnType<typeof vi.fn>).mockReset();
  hook.mockImplementation(async (_repository, transaction, accountId, work) => {
    expect(transaction).toBe(tx);
    world.log.push(`SCOPE open ${accountId}`);
    if (world.gate !== null) await world.gate;
    if (world.hookError !== null) throw world.hookError;
    return work(scope as never);
  });
  scope.inspectAttemptedOrderBoundCancelLease.mockImplementation(async (expected: unknown) => {
    world.log.push('SCOPE inspect');
    expect(expected).toEqual({ leaseId: LEASE_ID, certificateId: CERTIFICATE_ID });
    return world.inspection;
  });
  enterManualReview.mockImplementation(async () => {
    world.log.push('MANUAL_REVIEW POST_MUTATION_MISMATCH');
    return { kind: 'ENTERED', reviewEpisodeId: 'review-1', account: {} } as never;
  });
  escalateMalformed.mockImplementation(async () => {
    world.log.push('MALFORMED_LATCH');
    return { kind: 'LATCHED', reviewEpisodeId: 'review-latch-1' } as never;
  });
});

function store(): PrismaPracticalCancelMutationStore {
  return new PrismaPracticalCancelMutationStore(rootClient());
}

function receipt() {
  const error = new PracticalAcquireCommitUnknownError(ACCOUNT, new Error('lost'));
  return issuePracticalUnknownAcquire(intendedRecord(), error);
}

const input = (unknown: unknown, overrides: Record<string, unknown> = {}) => ({ unknown, runtimeIdentity: IDENTITY, trustedNowMs: NOW, ...overrides }) as never;
const knownError = (code: string) => new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, { code, clientVersion: 'test' });
const RESTORE_LOG = [`SCOPE open ${ACCOUNT}`, 'SCOPE inspect', 'LOCK live_order', 'LOCK live_execution_intent'];

async function refusal(unknown: unknown): Promise<PracticalMutationError> {
  const error = await store().resolveUnknownAcquire(input(unknown)).then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(PracticalMutationError);
  return error as PracticalMutationError;
}

// ---------------------------------------------------------------------------

describe('refusals BEFORE any durable access (zero transactions)', () => {
  it.each<[string, () => unknown]>([
    ['a non-record input', () => 'input'],
    ['an extra key', () => ({ unknown: receipt(), runtimeIdentity: IDENTITY, trustedNowMs: NOW, enablement: {} })],
    ['a missing key', () => ({ unknown: receipt(), trustedNowMs: NOW })],
    ['a structural receipt', () => input({ ...receipt() })],
    ['an acquired handle instead of a receipt', () => input(Object.create(PracticalAcquiredCancel.prototype))],
    ['a forged runtime identity', () => input(receipt(), { runtimeIdentity: { epoch: EPOCH } })],
    ['a negative time', () => input(receipt(), { trustedNowMs: -1 })],
  ])('refuses %s', async (_name, value) => {
    await expect(store().resolveUnknownAcquire(value() as never)).rejects.toBeInstanceOf(PracticalMutationError);
    expect(world.transactions).toBe(0);
    expect(hook).not.toHaveBeenCalled();
  });

  it('a receipt of another runtime epoch is refused and stays PENDING (nothing proven)', async () => {
    const unknown = receipt();
    await expect(store().resolveUnknownAcquire(input(unknown, { runtimeIdentity: newLiveRuntimeIdentity() }))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    expect(PracticalUnknownAcquire.status(unknown)).toBe('PENDING');
    expect(world.transactions).toBe(0);
  });

  it('a second concurrent resolution of the same receipt is refused synchronously; SPENT is refused afterwards', async () => {
    const unknown = receipt();
    let open!: () => void;
    world.gate = new Promise<void>((resolve) => { open = resolve; });
    const first = store().resolveUnknownAcquire(input(unknown));
    await expect(store().resolveUnknownAcquire(input(unknown))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    expect(world.transactions).toBe(1);
    open();
    expect((await first).kind).toBe('RESTORED');
    await expect(store().resolveUnknownAcquire(input(unknown))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    expect(world.transactions).toBe(1);
  });
});

describe('RESTORED: only an exactly restorable lease; the INTENDED handle, unchanged; read-only; no reconciliation read', () => {
  it('practical inspection -> live_order -> intent; the handle is genuine, AVAILABLE, and equals the intended record', async () => {
    const unknown = receipt();
    const result = await store().resolveUnknownAcquire(input(unknown));
    expect(result.kind).toBe('RESTORED');
    if (result.kind !== 'RESTORED') throw new Error('unreachable');
    expect(PracticalAcquiredCancel.read(result.acquired)).toEqual(intendedRecord());
    expect(PracticalAcquiredCancel.status(result.acquired)).toBe('AVAILABLE');
    expect(PracticalUnknownAcquire.status(unknown)).toBe('SPENT');
    expect(world.log).toEqual(RESTORE_LOG);
    expect(world.log.some((entry) => /reconciliation/i.test(entry))).toBe(false);
    expect(enterManualReview).not.toHaveBeenCalled();
  });

  it.each(['QUARANTINED', 'MANUAL_REVIEW_REQUIRED'])('an account invalidated to %s after the commit still restores (arm refuses it later; abandon works)', async (state) => {
    world.account = { state, fence: LEASED_FENCE };
    expect((await store().resolveUnknownAcquire(input(receipt()))).kind).toBe('RESTORED');
  });

  it('D3: order revision drift is permitted; the restored handle keeps the ORIGINAL revision', async () => {
    world.order = { ...CLAIMED_ORDER, revision: 9 };
    const result = await store().resolveUnknownAcquire(input(receipt()));
    if (result.kind !== 'RESTORED') throw new Error('expected RESTORED');
    expect(PracticalAcquiredCancel.read(result.acquired)!.orderRevisionAfterClaim).toBe(5);
  });
});

describe('NOT_COMMITTED: only a provable absence; nothing but the certificate status is reported; no Phase 17 read', () => {
  it.each([
    ['ISSUED', { status: 'ISSUED', terminalAtMs: null }, [], 'ISSUED'],
    ['EXPIRED', { status: 'EXPIRED', terminalAtMs: CREATED + 1, terminalReason: 'CERTIFICATE_EXPIRED' }, [], 'EXPIRED'],
    ['REVOKED', { status: 'REVOKED', terminalAtMs: CREATED + 1, terminalReason: 'WS_DISCONNECTED' }, [], 'REVOKED'],
    ['CONSUMED by ANOTHER lease (a different acquisition won)', { status: 'CONSUMED' }, ['lease-of-another-acquisition'], 'CONSUMED_BY_ANOTHER_LEASE'],
  ] as const)('%s', async (_name, certificate, leaseIds, expected) => {
    world.account = { state: 'CERTIFIED_IDLE', fence: IDLE_FENCE };
    world.inspection = { certificate: { ...CERTIFICATE, ...certificate }, certificateLeaseIds: leaseIds, lease: null };
    const unknown = receipt();
    expect(await store().resolveUnknownAcquire(input(unknown))).toEqual({ kind: 'NOT_COMMITTED', certificateStatus: expected });
    expect(PracticalUnknownAcquire.status(unknown)).toBe('SPENT');
    expect(world.log).toEqual([`SCOPE open ${ACCOUNT}`, 'SCOPE inspect']);
    expect(enterManualReview).not.toHaveBeenCalled();
  });
});

describe('ANOMALIES: RECOVERY_REFUSED, no handle, no closure asserted, receipt permanently REFUSED, manual review', () => {
  const absent = (patch: Partial<World['inspection']>, fence: unknown = IDLE_FENCE) => () => {
    world.account = { state: 'QUARANTINED', fence };
    world.inspection = { certificate: CERTIFICATE, certificateLeaseIds: [], lease: null, ...patch };
  };
  it.each<[string, string, () => void]>([
    ['LEASE_NOT_LEASED', 'a COMPLETED lease (a consistent-looking closure: fence IDLE)', () => {
      world.account = { state: 'QUARANTINED', fence: IDLE_FENCE };
      world.inspection = { ...world.inspection, lease: { ...LEASE, status: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE', completedAtMs: CREATED + 1 } };
    }],
    ['LEASE_NOT_LEASED', 'a COMPLETED lease with any other outcome', () => { world.inspection = { ...world.inspection, lease: { ...LEASE, status: 'COMPLETED', outcome: 'AMBIGUOUS', completedAtMs: CREATED + 1 } }; }],
    ['LEASE_ARMED', 'an armed lease (no handle could have armed it)', () => { world.inspection = { ...world.inspection, lease: { ...LEASE, armedAtMs: CREATED + 1 } }; }],
    ['LEASE_IDENTITY', 'a case-variant lease id', () => { world.inspection = { ...world.inspection, lease: { ...LEASE, leaseId: LEASE_ID.toUpperCase() } }; }],
    ['LEASE_IDENTITY', 'another creation instant', () => { world.inspection = { ...world.inspection, lease: { ...LEASE, createdAtMs: CREATED + 1 } }; }],
    ['LEASE_IDENTITY', 'a case-variant binding client order id', () => { world.inspection = { ...world.inspection, lease: { ...LEASE, orderBinding: { ...LEASE.orderBinding, clientOrderId: CLIENT_ORDER_ID.toUpperCase() } } }; }],
    ['FENCE_MISMATCH', 'a LEASED lease the fence does not name', () => { world.account = { state: 'QUARANTINED', fence: IDLE_FENCE }; }],
    ['FENCE_MISMATCH', 'an account state that cannot hold the lease', () => { world.account = { state: 'CERTIFIED_IDLE', fence: LEASED_FENCE }; }],
    ['CERTIFICATE_MISMATCH', 'another evidence digest', () => { world.inspection = { ...world.inspection, certificate: { ...CERTIFICATE, evidenceDigest: 'd'.repeat(64) } }; }],
    ['CERTIFICATE_MISMATCH', 'another consumption instant', () => { world.inspection = { ...world.inspection, certificate: { ...CERTIFICATE, terminalAtMs: CREATED + 1 } }; }],
    ['CERTIFICATE_MISMATCH', 'the lease not being the one lease of its certificate', () => { world.inspection = { ...world.inspection, certificateLeaseIds: [] }; }],
    ['PHASE17_MISSING', 'no Phase 17 order', () => { world.order = null; }],
    ['PHASE17_IDENTITY', 'a case-variant pair', () => { world.order = { ...CLAIMED_ORDER, pair: 'b-btc_usdt' }; }],
    ['PHASE17_IDENTITY', 'a case-variant exchange order id', () => { world.order = { ...CLAIMED_ORDER, exchangeOrderId: 'VENUE-1' }; }],
    ['PHASE17_IDENTITY', 'a case-variant cancel exchange order id', () => { world.order = { ...CLAIMED_ORDER, cancelExchangeOrderId: 'Venue-1' }; }],
    ['PHASE17_IDENTITY', 'a cancel fault code', () => { world.order = { ...CLAIMED_ORDER, cancelFaultCode: 'CANCEL_AMBIGUOUS' }; }],
    ['PHASE17_IDENTITY', 'a case-variant client order id', () => { world.order = { ...CLAIMED_ORDER, clientOrderId: CLIENT_ORDER_ID.toUpperCase() }; }],
    ['PHASE17_CLAIM', 'a LATER Phase 17 generation', () => { world.order = { ...CLAIMED_ORDER, cancelGeneration: 3 }; }],
    ['PHASE17_CLAIM', 'an OLDER Phase 17 generation', () => { world.order = { ...CLAIMED_ORDER, cancelGeneration: 1 }; }],
    ['PHASE17_CLAIM', 'a released (NONE) Phase 17 claim', () => { world.order = { ...CLAIMED_ORDER, cancelState: 'NONE' }; }],
    ['PHASE17_CLAIM', 'an armed Phase 17 claim', () => { world.order = { ...CLAIMED_ORDER, cancelWireArmed: true }; }],
    ['ABSENT_BUT_REFERENCED', 'no lease row although the fence names it', absent({}, LEASED_FENCE)],
    ['ABSENT_BUT_REFERENCED', 'no lease row although it rests on the certificate', absent({ certificateLeaseIds: [LEASE_ID] })],
    ['ABSENT_BUT_REFERENCED', 'a CONSUMED certificate with no lease (a deleted lease)', absent({ certificateLeaseIds: [] })],
    ['CERTIFICATE_MISMATCH', 'no lease and no certificate row', absent({ certificate: null })],
    ['CERTIFICATE_MISMATCH', 'no lease and another certificate identity', absent({ certificate: { ...CERTIFICATE, status: 'ISSUED', streamIncarnation: 2 } })],
    ['CERTIFICATE_MISMATCH', 'an ISSUED certificate with a lease resting on it', absent({ certificate: { ...CERTIFICATE, status: 'ISSUED' }, certificateLeaseIds: ['lease-x'] })],
  ])('%s: %s', async (reason, _name, setup) => {
    setup();
    const unknown = receipt();
    const error = await refusal(unknown);
    expect(error.code).toBe('PRACTICAL_MUTATION_RECOVERY_REFUSED');
    expect(error.details).toEqual({ accountId: ACCOUNT, leaseId: LEASE_ID, reason, escalated: true, reviewEpisodeId: 'review-1' });
    expect(PracticalUnknownAcquire.status(unknown)).toBe('REFUSED');
    expect(enterManualReview).toHaveBeenCalledTimes(1);
    expect(enterManualReview).toHaveBeenCalledWith({ accountId: ACCOUNT, reason: 'POST_MUTATION_MISMATCH', nowMs: NOW });
    // Mint-disabled forever: even with the rows "repaired" to be exactly restorable, it is refused before any durable access.
    world.account = { state: 'MUTATING', fence: LEASED_FENCE };
    world.inspection = { certificate: CERTIFICATE, certificateLeaseIds: [LEASE_ID], lease: LEASE };
    world.order = { ...CLAIMED_ORDER };
    const transactions = world.transactions;
    await expect(store().resolveUnknownAcquire(input(unknown))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    expect(world.transactions).toBe(transactions);
  });

  it('an account the strict parser rejects (MALFORMED at the account read) is an anomaly: the malformed latch is the escalation', async () => {
    world.hookError = new PracticalPersistenceError('PRACTICAL_PERSISTENCE_MALFORMED', 'fence names a COMPLETED lease', { accountId: ACCOUNT, problem: 'ROWS_INCONSISTENT' });
    enterManualReview.mockRejectedValueOnce(new PracticalPersistenceError('PRACTICAL_PERSISTENCE_MALFORMED', 'still malformed', { accountId: ACCOUNT, problem: 'ROWS_INCONSISTENT' }));
    const unknown = receipt();
    const error = await refusal(unknown);
    expect(error.details).toMatchObject({ reason: 'ACCOUNT_UNREADABLE', escalated: true, reviewEpisodeId: 'review-latch-1' });
    expect(escalateMalformed).toHaveBeenCalledWith({ accountId: ACCOUNT, detectingRuntimeEpoch: EPOCH, nowMs: NOW });
    expect(PracticalUnknownAcquire.status(unknown)).toBe('REFUSED');
    expect(scope.inspectAttemptedOrderBoundCancelLease).not.toHaveBeenCalled();
  });

  it('an ALREADY latched account is an anomaly whose escalation is already durable', async () => {
    world.hookError = new PracticalPersistenceError('PRACTICAL_PERSISTENCE_LATCHED', 'latched', { accountId: ACCOUNT, reviewEpisodeId: 'review-old' });
    enterManualReview.mockRejectedValueOnce(new PracticalPersistenceError('PRACTICAL_PERSISTENCE_LATCHED', 'latched', { accountId: ACCOUNT, reviewEpisodeId: 'review-old' }));
    const unknown = receipt();
    expect((await refusal(unknown)).details).toMatchObject({ reason: 'ACCOUNT_UNREADABLE', escalated: true, reviewEpisodeId: 'review-old' });
    expect(PracticalUnknownAcquire.status(unknown)).toBe('REFUSED');
    expect(escalateMalformed).not.toHaveBeenCalled();
  });

  it('a malformed ROW met by the inspection (after a valid account read) is an anomaly escalated by manual review', async () => {
    scope.inspectAttemptedOrderBoundCancelLease.mockRejectedValueOnce(new PracticalPersistenceError('PRACTICAL_PERSISTENCE_MALFORMED', 'bad lease row', { problem: 'ROWS_INCONSISTENT' }));
    const unknown = receipt();
    expect((await refusal(unknown)).details).toMatchObject({ reason: 'ACCOUNT_UNREADABLE', escalated: true, reviewEpisodeId: 'review-1' });
    expect(PracticalUnknownAcquire.status(unknown)).toBe('REFUSED');
  });
});

describe('an escalation that cannot be confirmed: ANOMALY_UNESCALATED retries ONLY the escalation and can never mint', () => {
  it('the receipt is mint-disabled at once; a retry reads nothing, runs no transaction, and only escalates', async () => {
    world.inspection = { ...world.inspection, lease: { ...LEASE, armedAtMs: CREATED + 1 } };
    enterManualReview.mockRejectedValueOnce(new PracticalMutationError('PRACTICAL_MUTATION_FAULT', 'review write failed'));
    const unknown = receipt();
    expect((await refusal(unknown)).details).toMatchObject({ reason: 'LEASE_ARMED', escalated: false, reviewEpisodeId: null });
    expect(PracticalUnknownAcquire.status(unknown)).toBe('ANOMALY_UNESCALATED');
    // Rows "repaired" to be exactly restorable: irrelevant, nothing is read.
    world.inspection = { certificate: CERTIFICATE, certificateLeaseIds: [LEASE_ID], lease: LEASE };
    const transactions = world.transactions;
    enterManualReview.mockRejectedValueOnce(new Error('still failing'));
    expect((await refusal(unknown)).details).toMatchObject({ reason: 'ANOMALY_PREVIOUSLY_PROVEN', escalated: false });
    expect(PracticalUnknownAcquire.status(unknown)).toBe('ANOMALY_UNESCALATED');
    const retried = await refusal(unknown);
    expect(retried.details).toMatchObject({ reason: 'ANOMALY_PREVIOUSLY_PROVEN', escalated: true, reviewEpisodeId: 'review-1' });
    expect(PracticalUnknownAcquire.status(unknown)).toBe('REFUSED');
    expect(world.transactions).toBe(transactions);
    expect(scope.inspectAttemptedOrderBoundCancelLease).toHaveBeenCalledTimes(1);
    await expect(store().resolveUnknownAcquire(input(unknown))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
  });
});

describe('INCONCLUSIVE failures leave the receipt PENDING (nothing proven), and the same receipt then resolves', () => {
  it.each<[string, () => void, string]>([
    ['a non-retryable database error (e.g. a lock-wait timeout)', () => { world.failBeforeWork = [knownError('P1017')]; }, 'PRACTICAL_MUTATION_FAULT'],
    ['exhausted deadlock retries', () => { world.failBeforeWork = [knownError('P2034'), knownError('P2034'), knownError('P2034')]; }, 'PRACTICAL_MUTATION_FAULT'],
    ['D4: the read-only COMMIT is unknown', () => { world.failAtCommit = knownError('P1017'); }, 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN'],
  ])('%s', async (_name, setup, code) => {
    setup();
    const unknown = receipt();
    await expect(store().resolveUnknownAcquire(input(unknown))).rejects.toMatchObject({ code });
    expect(PracticalUnknownAcquire.status(unknown)).toBe('PENDING');
    expect(enterManualReview).not.toHaveBeenCalled();
    world.failBeforeWork = [];
    world.failAtCommit = null;
    expect((await store().resolveUnknownAcquire(input(unknown))).kind).toBe('RESTORED');
    expect(PracticalUnknownAcquire.status(unknown)).toBe('SPENT');
  });

  it('one deadlock is retried inside ONE call', async () => {
    world.failBeforeWork = [knownError('P2034')];
    expect((await store().resolveUnknownAcquire(input(receipt()))).kind).toBe('RESTORED');
    expect(world.transactions).toBe(2);
  });
});
