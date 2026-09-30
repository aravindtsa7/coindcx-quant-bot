import { Prisma, type PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// [P18B Stage 1B2 Wave 2B2d] The STORE's previous-runtime recovery decisions, isolated: the Stage 1B1 caller-owned
// scope and the Wave 2B2a no-wire release primitives are recording doubles. This proves the pre-DB refusals (the
// adopting epoch comes only from a genuine runtime identity), every eligibility branch, the statement order
// (practical -> live_order -> intent; NO live_reconciliation_state; ONLY the UNARMED release), which refusals write
// nothing and which enter manual review through the shared call site, the malformed latch, and the unknown-commit /
// deadlock policy. The real scope and primitives run against real MySQL in the previous-runtime integration suite.
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
import { PracticalDurableContradictionError, PracticalPersistenceError } from '../../../../../src/execution/live/practical-persistence/ports';
import { PracticalLiveSafetyError } from '../../../../../src/execution/live/practical/types';
import { PracticalMutationError } from '../../../../../src/execution/live/practical-mutation/ports';
import { PrismaPracticalCancelMutationStore } from '../../../../../src/execution/live/practical-mutation/repository';
import { newLiveRuntimeIdentity, readLiveRuntimeEpoch } from '../../../../../src/execution/live/reconciliation/barrier';
import type { LiveOrderStateRecord } from '../../../../../src/execution/live/types';

const IDENTITY = newLiveRuntimeIdentity();
const EPOCH = readLiveRuntimeEpoch(IDENTITY)!;
const PREVIOUS_EPOCH = 'epoch-of-a-previous-runtime';
const ACCOUNT = 'acct-w2b2d-unit';
const INTENT = 'a'.repeat(64);
const CLIENT_ORDER_ID = `p17-${'b'.repeat(32)}`;
const CERTIFICATE_ID = 'c'.repeat(64);
const LEASE_ID = 'lease-of-a-previous-runtime';
const GENERATION = 3;
const NOW = 1_070_000;

interface OrderRow {
  intentId: string; accountId: string; clientOrderId: string; pair: string; state: string; cancelState: string; cancelGeneration: number;
  cancelWireArmed: boolean; exchangeOrderId: string | null; cancelExchangeOrderId: string | null; cancelFaultCode: string | null; revision: number;
}
const CLAIMED: OrderRow = {
  intentId: INTENT, accountId: ACCOUNT, clientOrderId: CLIENT_ORDER_ID, pair: 'B-BTC_USDT', state: 'CANCEL_REQUESTED', cancelState: 'CANCEL_RESERVED',
  cancelGeneration: 2, cancelWireArmed: false, exchangeOrderId: 'venue-1', cancelExchangeOrderId: 'venue-1', cancelFaultCode: null, revision: 5,
};

const BINDING = { intentId: INTENT, clientOrderId: CLIENT_ORDER_ID, cancelGeneration: 2 };
const LEASE = {
  leaseId: LEASE_ID, accountId: ACCOUNT, certificateId: CERTIFICATE_ID, action: 'CANCEL', runtimeEpoch: PREVIOUS_EPOCH, reconciliationGeneration: GENERATION,
  createdAtMs: 1_060_000, orderBinding: BINDING, armedAtMs: null as number | null, status: 'LEASED', completedAtMs: null, outcome: null,
};
function leasedFence(epoch: string) {
  return { accountId: ACCOUNT, runtimeEpoch: epoch, reconciliationGeneration: GENERATION, revision: 7, mode: { kind: 'MUTATION_LEASED', leaseId: LEASE_ID, certificateId: CERTIFICATE_ID, action: 'CANCEL' } };
}

function stateRecord(row: OrderRow): LiveOrderStateRecord {
  return {
    intentId: row.intentId, clientOrderId: row.clientOrderId, accountId: row.accountId, pair: row.pair, state: row.state as LiveOrderStateRecord['state'],
    exchangeOrderId: row.exchangeOrderId, orderedQuantity: '0.5', cumulativeFilledQuantity: '0', remainingQuantity: '0.5', averageFillPrice: null,
    lastExchangeStatus: null, lastProviderEventTimeMs: null, faultCode: null, cancelState: row.cancelState as LiveOrderStateRecord['cancelState'],
    cancelGeneration: row.cancelGeneration, cancelExchangeOrderId: row.cancelExchangeOrderId, cancelFaultCode: row.cancelFaultCode,
    dispatchWireArmed: false, cancelWireArmed: row.cancelWireArmed, revision: row.revision,
  };
}

interface World {
  log: string[];
  transactions: number;
  failBeforeWork: unknown[];
  failAtCommit: unknown;
  account: { state: string; fence: unknown; currentLease: unknown };
  lease: typeof LEASE;
  orderReads: (OrderRow | null)[];
  hookError: unknown;
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
  get account() { return world.account; },
  requireLeasedOrderBoundCancelLease: vi.fn(),
  completeOrderBoundCancelLeaseNoWireAndAdopt: vi.fn(),
};
const hook = vi.mocked(practicalRepository.withLockedPracticalAccountWithinCallerTransaction);
const releaseUnarmed = vi.mocked(liveRepository.releaseUnarmedCancelClaimWithinCallerFencedTransaction);
const releaseArmed = vi.mocked(liveRepository.releaseArmedUndispatchedCancelClaimWithinCallerFencedTransaction);
const enterManualReview = vi.spyOn(practicalRepository.PrismaPracticalSafetyRepository.prototype, 'enterManualReview');
const escalateMalformed = vi.spyOn(practicalRepository.PrismaPracticalSafetyRepository.prototype, 'escalateMalformedAccount');

beforeEach(() => {
  world = {
    log: [], transactions: 0, failBeforeWork: [], failAtCommit: null,
    account: { state: 'MUTATING', fence: leasedFence(PREVIOUS_EPOCH), currentLease: LEASE },
    lease: { ...LEASE }, orderReads: [{ ...CLAIMED }], hookError: null,
  };
  for (const fn of [hook, releaseUnarmed, releaseArmed, scope.requireLeasedOrderBoundCancelLease, scope.completeOrderBoundCancelLeaseNoWireAndAdopt, enterManualReview, escalateMalformed]) {
    (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  hook.mockImplementation(async (_repository, transaction, accountId, work) => {
    expect(transaction).toBe(tx);
    world.log.push(`SCOPE open ${accountId}`);
    if (world.hookError !== null) throw world.hookError;
    return work(scope as never);
  });
  scope.requireLeasedOrderBoundCancelLease.mockImplementation(async (expected: unknown) => {
    world.log.push('SCOPE requireLeased');
    expect(expected).toEqual({ leaseId: LEASE_ID, certificateId: CERTIFICATE_ID, runtimeEpoch: PREVIOUS_EPOCH, reconciliationGeneration: GENERATION, binding: BINDING });
    return { lease: world.lease, certificate: { certificateId: CERTIFICATE_ID, status: 'CONSUMED' } };
  });
  scope.completeOrderBoundCancelLeaseNoWireAndAdopt.mockImplementation(async (nowMs: number, epoch: string) => {
    world.log.push(`SCOPE completeAndAdopt ${epoch === EPOCH ? 'THIS_EPOCH' : epoch}`);
    expect(nowMs).toBe(NOW);
    return {
      lease: { ...world.lease, status: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE', completedAtMs: NOW },
      certificate: { certificateId: CERTIFICATE_ID, status: 'CONSUMED' },
      account: { state: 'QUARANTINED', fence: { mode: { kind: 'IDLE' }, runtimeEpoch: epoch } },
    };
  });
  releaseUnarmed.mockImplementation(async () => {
    world.log.push('PHASE17 releaseUnarmed');
    const released = { ...world.orderReads[0]!, cancelState: 'NONE', cancelWireArmed: false, cancelFaultCode: null, revision: world.orderReads[0]!.revision + 1 };
    world.orderReads = [released];
    return stateRecord(released);
  });
  enterManualReview.mockImplementation(async () => {
    world.log.push('MANUAL_REVIEW POST_MUTATION_MISMATCH');
    return { kind: 'ENTERED', reviewEpisodeId: 'review-1', account: {} } as never;
  });
  escalateMalformed.mockImplementation(async () => ({ kind: 'LATCHED', reviewEpisodeId: 'review-latch-1' }) as never);
});

function store(): PrismaPracticalCancelMutationStore {
  return new PrismaPracticalCancelMutationStore(rootClient());
}

const input = (overrides: Record<string, unknown> = {}) => ({ accountId: ACCOUNT, runtimeIdentity: IDENTITY, trustedNowMs: NOW, ...overrides }) as never;
const knownError = (code: string) => new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, { code, clientVersion: 'test' });
const RECOVERED_LOG = [
  `SCOPE open ${ACCOUNT}`, 'SCOPE requireLeased', 'LOCK live_order', 'LOCK live_execution_intent',
  'PHASE17 releaseUnarmed', 'SCOPE completeAndAdopt THIS_EPOCH', 'LOCK live_order', 'LOCK live_execution_intent',
];

async function refusedWith(reason: string): Promise<void> {
  await expect(store().recoverPreviousRuntimeCancelLease(input())).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_RECOVERY_REFUSED', details: { accountId: ACCOUNT, reason } });
}

function expectNothingReleased(): void {
  expect(releaseUnarmed).not.toHaveBeenCalled();
  expect(releaseArmed).not.toHaveBeenCalled();
  expect(scope.completeOrderBoundCancelLeaseNoWireAndAdopt).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------

describe('refusals BEFORE any durable access: the adopting epoch comes only from a GENUINE runtime identity', () => {
  it.each<[string, () => unknown]>([
    ['a non-record input', () => 'input'],
    ['an extra key (an epoch cannot be supplied)', () => ({ accountId: ACCOUNT, runtimeIdentity: IDENTITY, trustedNowMs: NOW, runtimeEpoch: EPOCH })],
    ['a missing key', () => ({ accountId: ACCOUNT, trustedNowMs: NOW })],
    ['the epoch STRING as the identity', () => input({ runtimeIdentity: EPOCH })],
    ['a structural identity look-alike', () => input({ runtimeIdentity: { epoch: EPOCH } })],
    ['a spread clone of the genuine identity', () => input({ runtimeIdentity: { ...IDENTITY } })],
    ['an object with the identity prototype only', () => input({ runtimeIdentity: Object.create(Object.getPrototypeOf(IDENTITY)) })],
    ['a JSON round-trip of the identity', () => input({ runtimeIdentity: JSON.parse(JSON.stringify(IDENTITY)) })],
    ['an invalid account id', () => input({ accountId: '' })],
    ['a negative time', () => input({ trustedNowMs: -1 })],
  ])('refuses %s', async (_name, value) => {
    await expect(store().recoverPreviousRuntimeCancelLease(value() as never)).rejects.toBeInstanceOf(PracticalMutationError);
    expect(world.transactions).toBe(0);
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('RECOVERED: a previous-epoch, order-bound, coupled UNARMED pair, closed and adopted in ONE transaction', () => {
  it('practical -> live_order -> intent -> UNARMED release (exact account) -> completion + adoption by THIS epoch -> both sides re-proven', async () => {
    expect(await store().recoverPreviousRuntimeCancelLease(input())).toEqual({
      kind: 'RECOVERED', outcome: 'PRE_DISPATCH_FAILURE', leaseId: LEASE_ID, intentId: INTENT, cancelGeneration: 2,
    });
    expect(world.log).toEqual(RECOVERED_LOG);
    expect(world.log.some((entry) => /reconciliation/i.test(entry))).toBe(false);
    expect(releaseUnarmed).toHaveBeenCalledWith(tx, INTENT, 2, ACCOUNT);
    expect(releaseArmed).not.toHaveBeenCalled();
    expect(enterManualReview).not.toHaveBeenCalled();
    expect(world.transactions).toBe(1);
  });

  it.each(['QUARANTINED', 'MANUAL_REVIEW_REQUIRED'])('an account left %s by the previous runtime is recovered too', async (state) => {
    world.account = { ...world.account, state };
    expect((await store().recoverPreviousRuntimeCancelLease(input())).kind).toBe('RECOVERED');
  });

  it('a post-write self-check failure rolls back (SELF_CHECK_FAILED), is NOT escalated, and reports nothing recovered', async () => {
    scope.completeOrderBoundCancelLeaseNoWireAndAdopt.mockResolvedValueOnce({
      lease: { ...LEASE, status: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' }, certificate: { status: 'CONSUMED' },
      account: { state: 'QUARANTINED', fence: { mode: { kind: 'IDLE' }, runtimeEpoch: PREVIOUS_EPOCH } },
    });
    await expect(store().recoverPreviousRuntimeCancelLease(input())).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_SELF_CHECK_FAILED' });
    expect(enterManualReview).not.toHaveBeenCalled();
  });
});

describe('NO_LEASED_FENCE: a fact about the current state, never a closure claim; nothing else is read', () => {
  it.each([
    ['IDLE at a previous epoch', PREVIOUS_EPOCH, false],
    ['IDLE at THIS epoch (e.g. the retry after an unknown commit)', EPOCH, true],
  ] as const)('%s', async (_name, epoch, held) => {
    world.account = { state: 'QUARANTINED', fence: { accountId: ACCOUNT, runtimeEpoch: epoch, reconciliationGeneration: GENERATION, revision: 9, mode: { kind: 'IDLE' } }, currentLease: null };
    expect(await store().recoverPreviousRuntimeCancelLease(input())).toEqual({ kind: 'NO_LEASED_FENCE', fenceHeldByThisRuntime: held });
    expect(world.log).toEqual([`SCOPE open ${ACCOUNT}`]);
    expectNothingReleased();
  });
});

describe('refused with NO write and NO review', () => {
  it('CURRENT_RUNTIME_LEASE: the fence belongs to THIS runtime', async () => {
    world.account = { ...world.account, fence: leasedFence(EPOCH) };
    await refusedWith('CURRENT_RUNTIME_LEASE');
    expect(scope.requireLeasedOrderBoundCancelLease).not.toHaveBeenCalled();
    expectNothingReleased();
    expect(enterManualReview).not.toHaveBeenCalled();
  });

  it('UNBOUND_LEASE: a Stage 1B1 lease with no Phase 17 claim', async () => {
    world.account = { ...world.account, currentLease: { ...LEASE, orderBinding: null } };
    await refusedWith('UNBOUND_LEASE');
    expectNothingReleased();
    expect(enterManualReview).not.toHaveBeenCalled();
  });
});

describe('refused, rolled back, then manual review through the ONE shared call site (never released)', () => {
  it.each<[string, string, () => void]>([
    ['ARMED_ORPHAN_REQUIRES_EVIDENCE', 'a coupled ARMED pair (a wire attempt may have been made)', () => { world.lease = { ...LEASE, armedAtMs: 1_061_000 }; world.orderReads = [{ ...CLAIMED, cancelWireArmed: true }]; }],
    ['SPLIT_PAIR', 'lease armed, Phase 17 unarmed', () => { world.lease = { ...LEASE, armedAtMs: 1_061_000 }; }],
    ['SPLIT_PAIR', 'lease unarmed, Phase 17 armed', () => { world.orderReads = [{ ...CLAIMED, cancelWireArmed: true }]; }],
    ['PHASE17_MISSING', 'no Phase 17 order', () => { world.orderReads = [null]; }],
    ['PHASE17_IDENTITY', 'a case-variant Phase 17 client order id', () => { world.orderReads = [{ ...CLAIMED, clientOrderId: CLIENT_ORDER_ID.toUpperCase() }]; }],
    ['PHASE17_IDENTITY', 'a case-variant Phase 17 account', () => { world.orderReads = [{ ...CLAIMED, accountId: ACCOUNT.toUpperCase() }]; }],
    ['PHASE17_IDENTITY', 'no exchange order id', () => { world.orderReads = [{ ...CLAIMED, exchangeOrderId: null }]; }],
    ['PHASE17_IDENTITY', 'a case-variant cancel exchange order id', () => { world.orderReads = [{ ...CLAIMED, cancelExchangeOrderId: 'VENUE-1' }]; }],
    ['PHASE17_IDENTITY', 'a cancel fault code', () => { world.orderReads = [{ ...CLAIMED, cancelFaultCode: 'CANCEL_AMBIGUOUS' }]; }],
    ['PHASE17_CLAIM', 'another Phase 17 generation', () => { world.orderReads = [{ ...CLAIMED, cancelGeneration: 3 }]; }],
    ['PHASE17_CLAIM', 'a released (NONE) claim', () => { world.orderReads = [{ ...CLAIMED, cancelState: 'NONE' }]; }],
    ['LEASE_CERTIFICATE_MISMATCH', 'a PROVEN lease / certificate contradiction (the TYPED persistence error)', () => {
      scope.requireLeasedOrderBoundCancelLease.mockRejectedValueOnce(new PracticalDurableContradictionError('CERTIFICATE_NOT_BOUND_TO_LEASE', 'The lease does not rest on its exact CONSUMED certificate'));
    }],
    ['LEASE_CERTIFICATE_MISMATCH', 'a certificate that does not rest under exactly this one lease (TYPED)', () => {
      scope.requireLeasedOrderBoundCancelLease.mockRejectedValueOnce(new PracticalDurableContradictionError('CERTIFICATE_LEASE_NOT_UNIQUE', 'The certificate does not rest under exactly one lease'));
    }],
  ])('%s: %s', async (reason, _name, setup) => {
    setup();
    await refusedWith(reason);
    expectNothingReleased();
    expect(enterManualReview).toHaveBeenCalledTimes(1);
    expect(enterManualReview).toHaveBeenCalledWith({ accountId: ACCOUNT, reason: 'POST_MUTATION_MISMATCH', nowMs: NOW });
    expect(world.log.at(-1)).toBe('MANUAL_REVIEW POST_MUTATION_MISMATCH');
  });

  it('the LEASE_CERTIFICATE_MISMATCH refusal carries the typed contradiction as its cause', async () => {
    const typed = new PracticalDurableContradictionError('CERTIFICATE_NOT_BOUND_TO_LEASE', 'The lease does not rest on its exact CONSUMED certificate');
    scope.requireLeasedOrderBoundCancelLease.mockRejectedValueOnce(typed);
    const error = await store().recoverPreviousRuntimeCancelLease(input()).then(() => null, (thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'PRACTICAL_MUTATION_RECOVERY_REFUSED', details: { reason: 'LEASE_CERTIFICATE_MISMATCH' } });
    expect((error as Error).cause).toBe(typed);
    expect(typed).toMatchObject({ code: 'PRACTICAL_PERSISTENCE_CONFLICT', contradiction: 'CERTIFICATE_NOT_BOUND_TO_LEASE', details: { contradiction: 'CERTIFICATE_NOT_BOUND_TO_LEASE' } });
  });

  it('a malformed account (parser-first) is latched by the existing escalation, not reviewed and not released', async () => {
    world.hookError = new PracticalPersistenceError('PRACTICAL_PERSISTENCE_MALFORMED', 'fence names a COMPLETED lease', { accountId: ACCOUNT, problem: 'ROWS_INCONSISTENT' });
    expect(await store().recoverPreviousRuntimeCancelLease(input())).toEqual({ kind: 'MALFORMED_LATCHED', reviewEpisodeId: 'review-latch-1' });
    expect(escalateMalformed).toHaveBeenCalledWith({ accountId: ACCOUNT, detectingRuntimeEpoch: EPOCH, nowMs: NOW });
    expect(enterManualReview).not.toHaveBeenCalled();
    expectNothingReleased();
  });
});

describe('unknown commits and the retry policy', () => {
  it('an unknown COMMIT is COMMIT_OUTCOME_UNKNOWN (no RECOVERED); the retry RE-READS: NO_LEASED_FENCE held by this runtime, no closure claim', async () => {
    world.failAtCommit = knownError('P1017');
    await expect(store().recoverPreviousRuntimeCancelLease(input())).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    expect(enterManualReview).not.toHaveBeenCalled();
    world.failAtCommit = null;
    world.account = { state: 'QUARANTINED', fence: { accountId: ACCOUNT, runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION, revision: 9, mode: { kind: 'IDLE' } }, currentLease: null };
    expect(await store().recoverPreviousRuntimeCancelLease(input())).toEqual({ kind: 'NO_LEASED_FENCE', fenceHeldByThisRuntime: true });
  });

  it('one deadlock is retried inside ONE call; exhausted retries are a FAULT, never escalated', async () => {
    world.failBeforeWork = [knownError('P2034')];
    expect((await store().recoverPreviousRuntimeCancelLease(input())).kind).toBe('RECOVERED');
    expect(world.transactions).toBe(2);
    world.orderReads = [{ ...CLAIMED }];
    world.failBeforeWork = [knownError('P2034'), knownError('P2034'), knownError('P2034')];
    await expect(store().recoverPreviousRuntimeCancelLease(input())).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_FAULT' });
    expect(enterManualReview).not.toHaveBeenCalled();
  });
});

describe('[review fix] a NON-contradiction conflict is rethrown UNCHANGED: fail-closed, no review, never LEASE_CERTIFICATE_MISMATCH', () => {
  it.each<[string, () => Error, 'requireLeased' | 'completeAndAdopt']>([
    ['a plain scope lifecycle CONFLICT (e.g. a second check in one scope)', () => new PracticalPersistenceError('PRACTICAL_PERSISTENCE_CONFLICT', 'A scope checks at most one no-wire completion, and never after another check'), 'requireLeased'],
    ['a plain operational CONFLICT (two locked reads of one row disagree)', () => new PracticalPersistenceError('PRACTICAL_PERSISTENCE_CONFLICT', 'The two locked reads of the leased certificate disagree'), 'requireLeased'],
    ['a terminal compare-and-set CONFLICT (the lease changed concurrently)', () => new PracticalPersistenceError('PRACTICAL_PERSISTENCE_CONFLICT', 'The order-bound lease was completed or changed concurrently'), 'completeAndAdopt'],
    ['a terminal self-check re-read CONFLICT', () => new PracticalPersistenceError('PRACTICAL_PERSISTENCE_CONFLICT', 'The previous-runtime recovery did not re-read as one PRE_DISPATCH_FAILURE completion'), 'completeAndAdopt'],
    ['a fence revision-exhaustion error from the Stage 1A adoption', () => new PracticalLiveSafetyError('PRACTICAL_FENCE_INVALID', 'Fence revision is exhausted and cannot advance safely', { field: 'revision' }), 'completeAndAdopt'],
  ])('%s', async (_name, make, where) => {
    const original = make();
    if (where === 'requireLeased') scope.requireLeasedOrderBoundCancelLease.mockRejectedValueOnce(original);
    else scope.completeOrderBoundCancelLeaseNoWireAndAdopt.mockRejectedValueOnce(original);
    const error = await store().recoverPreviousRuntimeCancelLease(input()).then(() => null, (thrown: unknown) => thrown);
    expect(error).toBe(original);
    expect(error).not.toBeInstanceOf(PracticalDurableContradictionError);
    expect(enterManualReview).not.toHaveBeenCalled();
    expect(escalateMalformed).not.toHaveBeenCalled();
    if (where === 'requireLeased') expectNothingReleased();
  });
});
