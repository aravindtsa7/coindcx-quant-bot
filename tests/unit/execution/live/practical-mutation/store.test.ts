import { Prisma, type PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Stage 1B1 caller-owned scope and the two Wave 2A primitives are replaced by recording doubles, so
// this suite isolates the STORE's own decisions: pre-DB refusals, statement order, the reconciliation
// mapping, the classified-failure catch, the retry policy, and the acquired-handle lifecycle.
// (The real scope and primitives are exercised against real MySQL in the integration suite.)
vi.mock('../../../../../src/execution/live/practical-persistence/repository', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../../src/execution/live/practical-persistence/repository')>();
  return { ...original, withLockedPracticalAccountWithinCallerTransaction: vi.fn() };
});
vi.mock('../../../../../src/execution/live/repository', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../../src/execution/live/repository')>();
  return { ...original, claimCancelWithinCallerFencedTransaction: vi.fn(), armCancelWireWithinCallerFencedTransaction: vi.fn() };
});

import { LiveExecutionError } from '../../../../../src/execution/live/errors';
import * as practicalRepository from '../../../../../src/execution/live/practical-persistence/repository';
import * as liveRepository from '../../../../../src/execution/live/repository';
import { issuePracticalRecoveryCertificate, revokePracticalRecoveryCertificate, PracticalRecoveryCertificate } from '../../../../../src/execution/live/practical/certificate';
import { issuePracticalLiveSafetyEnablement, type PracticalLiveSafetyEnablement } from '../../../../../src/execution/live/practical/policy';
import { PracticalMutationError } from '../../../../../src/execution/live/practical-mutation/ports';
import { PRACTICAL_MUTATION_TRANSACTION_MAX_ATTEMPTS, PrismaPracticalCancelMutationStore } from '../../../../../src/execution/live/practical-mutation/repository';
import {
  PracticalAcquiredCancel,
  PracticalArmedCancel,
  issuePracticalAcquiredCancel,
  type PracticalAcquiredCancelRecord,
} from '../../../../../src/execution/live/practical-mutation/ticket';
import { providerAccountFingerprint } from '../../../../../src/execution/live/reconciliation/account-identity';
import { newLiveRuntimeIdentity, readLiveRuntimeEpoch } from '../../../../../src/execution/live/reconciliation/barrier';
import type { LiveOrderStateRecord } from '../../../../../src/execution/live/types';

const ACCOUNT = 'acct-w2b1-unit';
const INTENT = 'a'.repeat(64);
const CLIENT_ORDER_ID = `p17-${'b'.repeat(32)}`;
const T0 = 1_000_000;
const NOW = T0 + 60_000;
const IDENTITY = newLiveRuntimeIdentity();
const EPOCH = readLiveRuntimeEpoch(IDENTITY)!;
const GENERATION = 3;

function enablementFor(accountId: string, extra: Record<string, string> = {}): PracticalLiveSafetyEnablement {
  const resolution = issuePracticalLiveSafetyEnablement({ LIVE_PRACTICAL_SAFETY_ENABLED: 'true', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: accountId, ...extra });
  if (resolution.status !== 'ENABLED') throw new Error('fixture enablement');
  return resolution.enablement;
}
const ENABLEMENT = enablementFor(ACCOUNT);

function newCertificate(options: { readonly accountId?: string; readonly runtimeEpoch?: string } = {}): PracticalRecoveryCertificate {
  return issuePracticalRecoveryCertificate({
    enablement: enablementFor(options.accountId ?? ACCOUNT),
    bindings: {
      accountId: options.accountId ?? ACCOUNT, providerAccountFingerprint: providerAccountFingerprint('w2b1-unit-account'),
      runtimeEpoch: options.runtimeEpoch ?? EPOCH, reconciliationGeneration: GENERATION, streamIncarnation: 1,
    },
    evidence: { evidenceDigest: 'e'.repeat(64), passCount: 3, certificationSpanMs: 30_000, minimumObservedPassSpacingMs: 10_000 },
    issuedAtMs: T0,
  });
}

// ---------------------------------------------------------------------------
// The recording world
// ---------------------------------------------------------------------------

interface OrderRow {
  intentId: string; accountId: string; clientOrderId: string; pair: string; state: string; cancelState: string; cancelGeneration: number;
  cancelWireArmed: boolean; exchangeOrderId: string | null; cancelExchangeOrderId: string | null; cancelFaultCode: string | null; revision: number;
}

const OPEN_ORDER: OrderRow = {
  intentId: INTENT, accountId: ACCOUNT, clientOrderId: CLIENT_ORDER_ID, pair: 'B-BTC_USDT', state: 'ACKNOWLEDGED', cancelState: 'NONE', cancelGeneration: 0,
  cancelWireArmed: false, exchangeOrderId: 'venue-1', cancelExchangeOrderId: null, cancelFaultCode: null, revision: 2,
};
const CLAIMED_ORDER: OrderRow = { ...OPEN_ORDER, state: 'CANCEL_REQUESTED', cancelState: 'CANCEL_RESERVED', cancelGeneration: 1, cancelExchangeOrderId: 'venue-1', revision: 3 };
const ARMED_ORDER: OrderRow = { ...CLAIMED_ORDER, cancelWireArmed: true, revision: 4 };
const HEALTHY = {
  accountId: ACCOUNT, status: 'HEALTHY', currentGeneration: GENERATION, currentRunId: 'run-3', currentRuntimeEpoch: EPOCH, healthyGeneration: GENERATION, blockingFindingCount: 0,
};

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
  /** Errors thrown by $transaction INSTEAD of running the work (a failed/rolled-back attempt), consumed in order. */
  failBeforeWork: unknown[];
  /** An error thrown by $transaction AFTER the work resolved (a failed/unconfirmable COMMIT). */
  failAtCommit: unknown;
  reconciliation: Record<string, unknown> | null;
  /** Successive live_order locking reads (the last one repeats). */
  orderReads: (OrderRow | null)[];
  gate: Promise<void> | null;
}

let world: World;
let certificate: PracticalRecoveryCertificate;

function durableOf(value: PracticalRecoveryCertificate, status: 'ISSUED' | 'CONSUMED', terminalAtMs: number | null) {
  const record = PracticalRecoveryCertificate.read(value)!;
  return {
    certificateId: record.certificateId, accountId: record.accountId, providerAccountFingerprint: record.providerAccountFingerprint, runtimeEpoch: record.runtimeEpoch,
    reconciliationGeneration: record.reconciliationGeneration, streamIncarnation: record.streamIncarnation, evidenceDigest: record.evidenceDigest,
    issuedAtMs: record.issuedAtMs, expiresAtMs: record.expiresAtMs, status, terminalAtMs, terminalReason: null,
  };
}

function nextOrderRead(): OrderRow | null {
  return world.orderReads.length > 1 ? world.orderReads.shift()! : world.orderReads[0]!;
}

const tx = {
  $queryRaw: async (query: Prisma.Sql) => {
    if (query.sql.includes('FROM live_reconciliation_state')) {
      world.log.push('LOCK live_reconciliation_state');
      return world.reconciliation === null ? [] : [world.reconciliation];
    }
    if (query.sql.includes('FROM live_order')) {
      world.log.push('LOCK live_order');
      const row = nextOrderRead();
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

/** The ROOT client: only `$transaction` exists. Any other use (a second connection inside a transaction) throws. */
function rootClient(): PrismaClient {
  const target = {
    $transaction: async (work: (client: unknown) => Promise<unknown>) => {
      world.transactions += 1;
      if (world.failBeforeWork.length > 0) throw world.failBeforeWork.shift();
      if (world.gate !== null) await world.gate;
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

// ----- the scope double -----------------------------------------------------

const scope = {
  account: {},
  prepareCancelConsumption: vi.fn(),
  consumeIntoOrderBoundCancelLease: vi.fn(),
  invalidateBeforeConsumption: vi.fn(),
  requireArmableOrderBoundCancelLease: vi.fn(),
  armOrderBoundCancelLease: vi.fn(),
};
const hook = vi.mocked(practicalRepository.withLockedPracticalAccountWithinCallerTransaction);
const claim = vi.mocked(liveRepository.claimCancelWithinCallerFencedTransaction);
const arm = vi.mocked(liveRepository.armCancelWireWithinCallerFencedTransaction);

function leaseOf(binding: { intentId: string; clientOrderId: string; cancelGeneration: number }, armedAtMs: number | null = null) {
  return {
    leaseId: 'lease-w2b1', accountId: ACCOUNT, certificateId: PracticalRecoveryCertificate.read(certificate)!.certificateId, action: 'CANCEL' as const,
    runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION, createdAtMs: NOW, orderBinding: binding, armedAtMs, status: 'LEASED' as const, completedAtMs: null, outcome: null,
  };
}

beforeEach(() => {
  world = { log: [], transactions: 0, failBeforeWork: [], failAtCommit: null, reconciliation: { ...HEALTHY }, orderReads: [{ ...OPEN_ORDER }], gate: null };
  certificate = newCertificate();
  for (const fn of [hook, claim, arm, ...Object.values(scope).filter((value) => typeof value === 'function')]) (fn as ReturnType<typeof vi.fn>).mockReset();
  hook.mockImplementation(async (_repository, transaction, accountId, work) => {
    expect(transaction).toBe(tx);
    world.log.push(`SCOPE open ${accountId}`);
    return work(scope as never);
  });
  scope.prepareCancelConsumption.mockImplementation(async () => {
    world.log.push('SCOPE prepare');
    return { kind: 'READY', preparation: Object.freeze({ certificate: durableOf(certificate, 'ISSUED', null) }) };
  });
  scope.invalidateBeforeConsumption.mockImplementation(async (_preparation, reason) => {
    world.log.push(`SCOPE invalidate ${reason}`);
    return {};
  });
  scope.consumeIntoOrderBoundCancelLease.mockImplementation(async (_preparation, binding) => {
    world.log.push('SCOPE consume');
    return { lease: leaseOf(binding), certificate: durableOf(certificate, 'CONSUMED', NOW), account: { state: 'MUTATING' } };
  });
  claim.mockImplementation(async () => {
    world.log.push('PHASE17 claim');
    world.orderReads = [{ ...CLAIMED_ORDER }];
    return { kind: 'CLAIMED', order: stateRecord(CLAIMED_ORDER), generation: 1 };
  });
  scope.requireArmableOrderBoundCancelLease.mockImplementation(async () => {
    world.log.push('SCOPE requireArmable');
    return { lease: leaseOf({ intentId: INTENT, clientOrderId: CLIENT_ORDER_ID, cancelGeneration: 1 }), certificate: durableOf(certificate, 'CONSUMED', NOW) };
  });
  arm.mockImplementation(async () => {
    world.log.push('PHASE17 arm');
    world.orderReads = [{ ...ARMED_ORDER }];
    return stateRecord(ARMED_ORDER);
  });
  scope.armOrderBoundCancelLease.mockImplementation(async (armedAtMs: number) => {
    world.log.push('SCOPE arm');
    return {
      lease: leaseOf({ intentId: INTENT, clientOrderId: CLIENT_ORDER_ID, cancelGeneration: 1 }, armedAtMs),
      certificate: durableOf(certificate, 'CONSUMED', NOW),
      account: { state: 'MUTATING' },
    };
  });
});

function store(): PrismaPracticalCancelMutationStore {
  return new PrismaPracticalCancelMutationStore(rootClient());
}

function acquireInput(overrides: Record<string, unknown> = {}) {
  return {
    accountId: ACCOUNT, expected: { accountId: ACCOUNT, runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION, revision: 4 },
    certificate, enablement: ENABLEMENT, runtimeIdentity: IDENTITY, intentId: INTENT, trustedNowMs: NOW, ...overrides,
  };
}

const knownError = (code: string, meta?: Record<string, unknown>) => new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, { code, clientVersion: 'test', ...(meta === undefined ? {} : { meta }) });
const ACQUIRE_TAIL = ['LOCK live_reconciliation_state', 'LOCK live_order', 'LOCK live_execution_intent'];

// ---------------------------------------------------------------------------
// ACQUIRE
// ---------------------------------------------------------------------------

describe('acquire: refusals BEFORE any durable access (zero transactions, zero statements)', () => {
  it.each<[string, () => unknown]>([
    ['a non-record input', () => 'input'],
    ['an extra clientOrderId key', () => acquireInput({ clientOrderId: CLIENT_ORDER_ID })],
    ['an extra action key (OPEN/CLOSE impossible)', () => acquireInput({ action: 'OPEN' })],
    ['an extra tier / mode key', () => acquireInput({ tier: 'STRICT' })],
    ['an extra leaseId / generation key', () => acquireInput({ leaseId: 'mine', cancelGeneration: 9 })],
    ['a reconciliation authorization key', () => acquireInput({ reconciliationAuthorization: {} })],
    ['a missing intent id', () => { const { intentId: _omit, ...rest } = acquireInput(); return rest; }],
    ['an uppercase intent id', () => acquireInput({ intentId: 'A'.repeat(64) })],
    ['a short intent id', () => acquireInput({ intentId: 'a'.repeat(63) })],
    ['a padded account id', () => acquireInput({ accountId: ` ${ACCOUNT}` })],
    ['a non-integer time', () => acquireInput({ trustedNowMs: 1.5 })],
    ['a structural enablement', () => acquireInput({ enablement: { accountAllowlist: [ACCOUNT], stage: 'STAGE_5A_CANCEL_ONLY' } })],
    ['an enablement for another account', () => acquireInput({ enablement: enablementFor('acct-other') })],
    ['a case-variant account (not allowlisted exactly)', () => acquireInput({ accountId: ACCOUNT.toUpperCase() })],
    ['a structural runtime identity', () => acquireInput({ runtimeIdentity: { epoch: EPOCH } })],
    ['a certificate clone', () => acquireInput({ certificate: { ...certificate } })],
    ['a certificate record', () => acquireInput({ certificate: PracticalRecoveryCertificate.read(certificate) })],
    ['a certificate from another runtime epoch', () => acquireInput({ certificate: newCertificate({ runtimeEpoch: 'epoch-previous' }) })],
    ['a certificate terminated in memory', () => { revokePracticalRecoveryCertificate(certificate, 'WS_DISCONNECTED', T0 + 1); return acquireInput(); }],
  ])('%s', async (_name, input) => {
    await expect(store().acquireCancelLease(input() as never)).rejects.toBeInstanceOf(PracticalMutationError);
    expect(world.transactions).toBe(0);
    expect(world.log).toEqual([]);
  });
});

describe('acquire: the exact lock / write sequence', () => {
  it('practical scope -> reconciliation -> live_order -> live_execution_intent -> claim (exact account) -> consume -> Phase 17 re-read; handle minted AFTER commit', async () => {
    const result = await store().acquireCancelLease(acquireInput());
    expect(world.log).toEqual([
      `SCOPE open ${ACCOUNT}`, 'SCOPE prepare', ...ACQUIRE_TAIL, 'PHASE17 claim', 'SCOPE consume', 'LOCK live_order', 'LOCK live_execution_intent',
    ]);
    expect(world.transactions).toBe(1);
    expect(claim).toHaveBeenCalledWith(tx, INTENT, ACCOUNT);
    // The binding came ONLY from the verified claimed order.
    expect(scope.consumeIntoOrderBoundCancelLease.mock.calls[0]![1]).toEqual({ intentId: INTENT, clientOrderId: CLIENT_ORDER_ID, cancelGeneration: 1 });
    if (result.kind !== 'ACQUIRED') throw new Error(result.kind);
    const record = PracticalAcquiredCancel.read(result.acquired)!;
    expect(PracticalAcquiredCancel.status(result.acquired)).toBe('AVAILABLE');
    expect(record).toMatchObject({
      accountId: ACCOUNT, leaseId: 'lease-w2b1', action: 'CANCEL', intentId: INTENT, clientOrderId: CLIENT_ORDER_ID, cancelGeneration: 1, pair: 'B-BTC_USDT',
      exchangeOrderId: 'venue-1', orderRevisionAfterClaim: 3, runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION, leaseCreatedAtMs: NOW, acquiredAtMs: NOW,
      certificate: { status: 'CONSUMED', consumedAtMs: NOW, terminalReason: null, basis: 'PRACTICAL_RECOVERY', provesAccountContinuity: false, streamIncarnation: 1 },
    });
  });

  it('D: a tightened effective lifetime that has elapsed invalidates with CONFIG_CHANGED BEFORE the reconciliation read', async () => {
    const tightened = enablementFor(ACCOUNT, { LIVE_PRACTICAL_CERTIFICATE_LIFETIME_MS: '90000' });
    const result = await store().acquireCancelLease(acquireInput({ enablement: tightened, trustedNowMs: T0 + 95_000 }));
    expect(result).toMatchObject({ kind: 'AUTHORITY_INVALIDATED', reason: 'CONFIG_CHANGED', cause: 'EFFECTIVE_LIFETIME_EXCEEDED', phase17Code: null });
    expect(world.log).toEqual([`SCOPE open ${ACCOUNT}`, 'SCOPE prepare', 'SCOPE invalidate CONFIG_CHANGED']);
  });

  it('dwell: max(first, post) not yet elapsed is a zero-change refusal (no reconciliation read, no invalidation)', async () => {
    await expect(store().acquireCancelLease(acquireInput({ trustedNowMs: T0 + 59_999 }))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_DWELL_NOT_ELAPSED' });
    const stricter = enablementFor(ACCOUNT, { LIVE_PRACTICAL_POST_ISSUANCE_DWELL_MS: '90000' });
    await expect(store().acquireCancelLease(acquireInput({ enablement: stricter, trustedNowMs: T0 + 60_000 }))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_DWELL_NOT_ELAPSED' });
    expect(world.log.filter((entry) => !entry.startsWith('SCOPE open') && entry !== 'SCOPE prepare')).toEqual([]);
    expect(scope.invalidateBeforeConsumption).not.toHaveBeenCalled();
  });

  it.each([
    ['R0 missing row', null, 'PREFLIGHT_MISMATCH'],
    ['R0 case-variant account', { ...HEALTHY, accountId: ACCOUNT.toUpperCase() }, 'PREFLIGHT_MISMATCH'],
    ['A other runtime epoch', { ...HEALTHY, currentRuntimeEpoch: 'epoch-previous' }, 'RUNTIME_EPOCH_CHANGED'],
    ['B run in flight', { ...HEALTHY, status: 'RUNNING', currentGeneration: GENERATION + 1 }, 'GENERATION_CHANGED'],
    ['B healthy generation null', { ...HEALTHY, healthyGeneration: null }, 'GENERATION_CHANGED'],
    ['C unhealthy', { ...HEALTHY, status: 'UNHEALTHY' }, 'PREFLIGHT_MISMATCH'],
    ['C blocking finding', { ...HEALTHY, blockingFindingCount: 1 }, 'PREFLIGHT_MISMATCH'],
    ['C null run id', { ...HEALTHY, currentRunId: null }, 'PREFLIGHT_MISMATCH'],
  ] as const)('reconciliation %s -> same-transaction %s invalidation, no Phase 17 lock or claim', async (_name, row, reason) => {
    world.reconciliation = row === null ? null : { ...row };
    const result = await store().acquireCancelLease(acquireInput());
    expect(result).toMatchObject({ kind: 'AUTHORITY_INVALIDATED', reason, cause: 'RECONCILIATION_STATE_MISMATCH' });
    expect(world.log).toEqual([`SCOPE open ${ACCOUNT}`, 'SCOPE prepare', 'LOCK live_reconciliation_state', `SCOPE invalidate ${reason}`]);
    expect(claim).not.toHaveBeenCalled();
  });

  it.each([
    ['no order row', null],
    ['a collation-matched (case variant) intent id', { ...OPEN_ORDER, intentId: INTENT.toUpperCase() }],
    ['another account', { ...OPEN_ORDER, accountId: 'acct-other' }],
    ['a case-variant account', { ...OPEN_ORDER, accountId: ACCOUNT.toUpperCase() }],
    ['a client order id not in the frozen format', { ...OPEN_ORDER, clientOrderId: 'P17-'.concat('B'.repeat(32)) }],
  ] as const)('Phase 17 pre-check: %s -> PREFLIGHT_MISMATCH before any claim', async (_name, row) => {
    world.orderReads = [row === null ? null : { ...row }];
    const result = await store().acquireCancelLease(acquireInput());
    expect(result).toMatchObject({ kind: 'AUTHORITY_INVALIDATED', reason: 'PREFLIGHT_MISMATCH', cause: 'PHASE17_ORDER_MISMATCH' });
    expect(claim).not.toHaveBeenCalled();
    expect(world.log.at(-1)).toBe('SCOPE invalidate PREFLIGHT_MISMATCH');
  });
});

describe('acquire: classified Phase 17 pre-write failures invalidate in the SAME transaction, only after the no-write proof', () => {
  it.each(['LIVE_INTENT_INVALID', 'LIVE_AUTHORITY_INVALID', 'LIVE_ORDER_IDENTITY_MISMATCH'] as const)('%s with the order untouched -> PREFLIGHT_MISMATCH', async (code) => {
    claim.mockImplementation(async () => { world.log.push('PHASE17 claim'); throw new LiveExecutionError(code, 'refused before the update'); });
    const result = await store().acquireCancelLease(acquireInput());
    expect(result).toMatchObject({ kind: 'AUTHORITY_INVALIDATED', reason: 'PREFLIGHT_MISMATCH', cause: 'PHASE17_CLAIM_REFUSED', phase17Code: code });
    expect(world.log).toEqual([`SCOPE open ${ACCOUNT}`, 'SCOPE prepare', ...ACQUIRE_TAIL, 'PHASE17 claim', 'LOCK live_order', 'LOCK live_execution_intent', 'SCOPE invalidate PREFLIGHT_MISMATCH']);
    expect(world.transactions).toBe(1);
  });

  it.each([
    ['revision', { revision: 3 }], ['state', { state: 'CANCEL_REQUESTED' }], ['cancelState', { cancelState: 'CANCEL_RESERVED' }], ['cancelGeneration', { cancelGeneration: 1 }],
    ['cancelWireArmed', { cancelWireArmed: true }], ['cancelExchangeOrderId', { cancelExchangeOrderId: 'venue-1' }], ['cancelFaultCode', { cancelFaultCode: 'X' }],
  ] as const)('a classified failure whose no-write proof FAILS (%s changed) rethrows the ORIGINAL error: no invalidation, full rollback', async (_name, change) => {
    const original = new LiveExecutionError('LIVE_ORDER_IDENTITY_MISMATCH', 'looked pre-write');
    claim.mockImplementation(async () => { world.orderReads = [{ ...OPEN_ORDER, ...change }]; throw original; });
    await expect(store().acquireCancelLease(acquireInput())).rejects.toBe(original);
    expect(scope.invalidateBeforeConsumption).not.toHaveBeenCalled();
    expect(scope.consumeIntoOrderBoundCancelLease).not.toHaveBeenCalled();
  });

  it.each([
    ['LIVE_DURABLE_INTEGRITY_VIOLATION', new LiveExecutionError('LIVE_DURABLE_INTEGRITY_VIOLATION', 'tampered')],
    ['LIVE_PERSISTENCE_FAULT', new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'unreadable')],
    ['LIVE_ORDER_STATE_CONFLICT', new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'moved')],
    ['a plain Error', new Error('boom')],
    ['a structural look-alike', { code: 'LIVE_INTENT_INVALID' }],
  ] as const)('%s is NEVER converted to an invalidation: it propagates and rolls the whole acquisition back', async (_name, error) => {
    claim.mockImplementation(async () => { throw error; });
    await expect(store().acquireCancelLease(acquireInput())).rejects.toBe(error);
    expect(scope.invalidateBeforeConsumption).not.toHaveBeenCalled();
    expect(scope.consumeIntoOrderBoundCancelLease).not.toHaveBeenCalled();
    expect(world.transactions).toBe(1);
  });

  it('a database error from the claim is never classified: FAULT, no invalidation, no retry (non-deadlock)', async () => {
    claim.mockImplementation(async () => { throw knownError('P2002'); });
    await expect(store().acquireCancelLease(acquireInput())).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_FAULT', details: { databaseCode: 'P2002' } });
    expect(scope.invalidateBeforeConsumption).not.toHaveBeenCalled();
    expect(world.transactions).toBe(1);
  });

  it.each(['NOT_CANCELLABLE', 'ALREADY_CLAIMED'] as const)('%s with the order untouched -> same-transaction PREFLIGHT_MISMATCH; with the order changed -> SELF_CHECK_FAILED, nothing committed', async (kind) => {
    claim.mockImplementation(async () => ({ kind, order: stateRecord(OPEN_ORDER), generation: 0 }));
    const result = await store().acquireCancelLease(acquireInput());
    expect(result).toMatchObject({ kind: 'AUTHORITY_INVALIDATED', reason: 'PREFLIGHT_MISMATCH', cause: kind === 'NOT_CANCELLABLE' ? 'PHASE17_NOT_CANCELLABLE' : 'PHASE17_ALREADY_CLAIMED' });
    scope.invalidateBeforeConsumption.mockClear();
    claim.mockImplementation(async () => { world.orderReads = [{ ...OPEN_ORDER, revision: 9 }]; return { kind, order: stateRecord(OPEN_ORDER), generation: 0 }; });
    await expect(store().acquireCancelLease(acquireInput())).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_SELF_CHECK_FAILED' });
    expect(scope.invalidateBeforeConsumption).not.toHaveBeenCalled();
  });

  it('a claim that did not produce EXACTLY the expected CANCEL_RESERVED order fails the self-check before any consumption', async () => {
    for (const bad of [{ revision: 4 }, { cancelGeneration: 2 }, { clientOrderId: `p17-${'c'.repeat(32)}` }, { cancelExchangeOrderId: 'venue-2' }, { exchangeOrderId: null }]) {
      claim.mockImplementation(async () => ({ kind: 'CLAIMED', order: stateRecord({ ...CLAIMED_ORDER, ...bad }), generation: CLAIMED_ORDER.cancelGeneration }));
      await expect(store().acquireCancelLease(acquireInput()), JSON.stringify(bad)).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_SELF_CHECK_FAILED' });
    }
    expect(scope.consumeIntoOrderBoundCancelLease).not.toHaveBeenCalled();
  });
});

describe('acquire: retry policy (Stage 1B1 scope) and no compensation after a database failure', () => {
  it('P2034 is retried as a whole transaction, then FAULT after 3 attempts; nothing is invalidated or revoked', async () => {
    world.failBeforeWork = [knownError('P2034'), knownError('P2034'), knownError('P2034')];
    await expect(store().acquireCancelLease(acquireInput())).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_FAULT', details: { attempts: PRACTICAL_MUTATION_TRANSACTION_MAX_ATTEMPTS } });
    expect(world.transactions).toBe(PRACTICAL_MUTATION_TRANSACTION_MAX_ATTEMPTS);
    expect(scope.invalidateBeforeConsumption).not.toHaveBeenCalled();
  });

  it('a deadlock raised INSIDE the transaction (P2010 carrying 1213) re-runs EVERYTHING, and the retry can succeed', async () => {
    let first = true;
    claim.mockImplementation(async () => {
      world.log.push('PHASE17 claim');
      if (first) { first = false; throw knownError('P2010', { code: '1213', message: 'Deadlock found' }); }
      world.orderReads = [{ ...CLAIMED_ORDER }];
      return { kind: 'CLAIMED', order: stateRecord(CLAIMED_ORDER), generation: 1 };
    });
    const result = await store().acquireCancelLease(acquireInput());
    expect(result.kind).toBe('ACQUIRED');
    expect(world.transactions).toBe(2);
    expect(world.log.filter((entry) => entry === 'SCOPE prepare')).toHaveLength(2);
    expect(scope.invalidateBeforeConsumption).not.toHaveBeenCalled();
  });

  it.each([
    ['MySQL 1205 lock wait timeout', knownError('P2010', { code: '1205' })],
    ['P2028 transaction API error', knownError('P2028')],
    ['P1017 connection closed', knownError('P1017')],
    ['an unknown request error', new Prisma.PrismaClientUnknownRequestError('unknown', { clientVersion: 'test' })],
  ] as const)('%s is NOT retried: FAULT, one attempt, no invalidation', async (_name, error) => {
    world.failBeforeWork = [error];
    await expect(store().acquireCancelLease(acquireInput())).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_FAULT' });
    expect(world.transactions).toBe(1);
    expect(scope.invalidateBeforeConsumption).not.toHaveBeenCalled();
  });

  it('a COMMIT that fails after the work completed is COMMIT_OUTCOME_UNKNOWN: nothing is minted, nothing retried or compensated', async () => {
    world.failAtCommit = knownError('P1017');
    await expect(store().acquireCancelLease(acquireInput())).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    expect(world.transactions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ARM
// ---------------------------------------------------------------------------

function acquiredHandle(overrides: Partial<PracticalAcquiredCancelRecord> = {}) {
  const record = PracticalRecoveryCertificate.read(certificate)!;
  return issuePracticalAcquiredCancel({
    accountId: ACCOUNT, leaseId: 'lease-w2b1', action: 'CANCEL', runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION, leaseCreatedAtMs: NOW,
    intentId: INTENT, clientOrderId: CLIENT_ORDER_ID, cancelGeneration: 1, pair: 'B-BTC_USDT', exchangeOrderId: 'venue-1', orderRevisionAfterClaim: 3,
    certificate: {
      certificateId: record.certificateId, accountId: ACCOUNT, providerAccountFingerprint: record.providerAccountFingerprint, runtimeEpoch: EPOCH,
      reconciliationGeneration: GENERATION, streamIncarnation: 1, evidenceDigest: record.evidenceDigest, issuedAtMs: record.issuedAtMs, expiresAtMs: record.expiresAtMs,
      status: 'CONSUMED', consumedAtMs: NOW, terminalReason: null, basis: 'PRACTICAL_RECOVERY', provesAccountContinuity: false,
    },
    acquiredAtMs: NOW,
    ...overrides,
  });
}

function armInput(acquired: unknown, overrides: Record<string, unknown> = {}) {
  return { acquired, enablement: ENABLEMENT, runtimeIdentity: IDENTITY, trustedNowMs: NOW + 1_000, ...overrides };
}

describe('arm: the exact lock / write sequence, exact-account arm, mint after commit', () => {
  beforeEach(() => { world.orderReads = [{ ...CLAIMED_ORDER }]; });

  it('scope check -> reconciliation -> live_order -> intent -> Phase 17 arm (EXACT account, never null) -> practical arm -> re-read; handle SPENT; ticket minted', async () => {
    const handle = acquiredHandle();
    const result = await store().armCancelLease(armInput(handle));
    expect(world.log).toEqual([
      `SCOPE open ${ACCOUNT}`, 'SCOPE requireArmable', ...ACQUIRE_TAIL, 'PHASE17 arm', 'SCOPE arm', 'LOCK live_order', 'LOCK live_execution_intent',
    ]);
    expect(arm).toHaveBeenCalledTimes(1);
    const [transaction, intentId, expectedRevision, fencedAccountId] = arm.mock.calls[0]!;
    expect(transaction).toBe(tx);
    expect(intentId).toBe(INTENT);
    expect(expectedRevision).toBe(3);
    expect(fencedAccountId).toBe(ACCOUNT);
    expect(fencedAccountId).not.toBeNull();
    expect(typeof fencedAccountId).toBe('string');
    // The full certificate snapshot was handed to the scope for re-proof.
    expect(scope.requireArmableOrderBoundCancelLease.mock.calls[0]![0]).toMatchObject({
      leaseId: 'lease-w2b1', leaseCreatedAtMs: NOW, binding: { intentId: INTENT, clientOrderId: CLIENT_ORDER_ID, cancelGeneration: 1 },
      certificate: { streamIncarnation: 1, consumedAtMs: NOW, issuedAtMs: T0, expiresAtMs: T0 + 120_000 },
    });
    expect(PracticalAcquiredCancel.status(handle)).toBe('SPENT');
    expect(PracticalArmedCancel.read(result.ticket)).toMatchObject({
      accountId: ACCOUNT, leaseId: 'lease-w2b1', intentId: INTENT, clientOrderId: CLIENT_ORDER_ID, cancelGeneration: 1, exchangeOrderId: 'venue-1', pair: 'B-BTC_USDT',
      orderRevisionAfterArm: 4, runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION, certificateStreamIncarnation: 1, certificateExpiresAtMs: T0 + 120_000,
      armedAtMs: NOW + 1_000, action: 'CANCEL', basis: 'PRACTICAL_RECOVERY', provesAccountContinuity: false,
    });
    // A spent handle can never arm again, in this process.
    await expect(store().armCancelLease(armInput(handle))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
  });

  it.each<[string, () => unknown]>([
    ['a structural handle', () => ({ ...acquiredHandle() })],
    ['a handle record', () => PracticalAcquiredCancel.read(acquiredHandle())],
  ])('refuses %s before any durable access', async (_name, value) => {
    await expect(store().armCancelLease(armInput(value()))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    expect(world.transactions).toBe(0);
  });

  it('refuses another runtime identity, a structural enablement, or a not-allowlisted account before any durable access; the handle stays AVAILABLE', async () => {
    const handle = acquiredHandle();
    for (const overrides of [{ runtimeIdentity: newLiveRuntimeIdentity() }, { enablement: {} }, { enablement: enablementFor('acct-other') }, { trustedNowMs: -1 }, { extra: 1 }]) {
      await expect(store().armCancelLease(armInput(handle, overrides)), JSON.stringify(Object.keys(overrides))).rejects.toBeInstanceOf(PracticalMutationError);
    }
    expect(world.transactions).toBe(0);
    expect(PracticalAcquiredCancel.status(handle)).toBe('AVAILABLE');
  });
});

describe('arm: a PROVEN zero-change refusal leaves the acquired handle reusable', () => {
  beforeEach(() => { world.orderReads = [{ ...CLAIMED_ORDER }]; });

  it.each<[string, Record<string, unknown>, () => void]>([
    ['dwell / window: after the durable expiry', { trustedNowMs: T0 + 120_000 }, () => undefined],
    ['dwell / window: before the dwell', { trustedNowMs: T0 + 59_000 }, () => undefined],
    ['reconciliation generation moved', {}, () => { world.reconciliation = { ...HEALTHY, currentGeneration: GENERATION + 1, status: 'RUNNING' }; }],
    ['reconciliation epoch moved', {}, () => { world.reconciliation = { ...HEALTHY, currentRuntimeEpoch: 'epoch-previous' }; }],
    ['stale Phase 17 revision', {}, () => { world.orderReads = [{ ...CLAIMED_ORDER, revision: 5 }]; }],
    ['Phase 17 already armed', {}, () => { world.orderReads = [{ ...CLAIMED_ORDER, cancelWireArmed: true }]; }],
    ['another cancel generation', {}, () => { world.orderReads = [{ ...CLAIMED_ORDER, cancelGeneration: 2 }]; }],
    ['a case-variant client order id', {}, () => { world.orderReads = [{ ...CLAIMED_ORDER, clientOrderId: CLIENT_ORDER_ID.toUpperCase() }]; }],
    ['a case-variant account', {}, () => { world.orderReads = [{ ...CLAIMED_ORDER, accountId: ACCOUNT.toUpperCase() }]; }],
    ['another exchange order id', {}, () => { world.orderReads = [{ ...CLAIMED_ORDER, cancelExchangeOrderId: 'venue-2' }]; }],
  ])('%s -> ARM_REFUSED before the Phase 17 arm; handle AVAILABLE again', async (_name, overrides, setup) => {
    setup();
    const handle = acquiredHandle();
    await expect(store().armCancelLease(armInput(handle, overrides))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_ARM_REFUSED' });
    expect(arm).not.toHaveBeenCalled();
    expect(scope.armOrderBoundCancelLease).not.toHaveBeenCalled();
    expect(PracticalAcquiredCancel.status(handle)).toBe('AVAILABLE');
  });

  it('a scope refusal (e.g. certificate tamper), a Phase 17 arm conflict, or a post-arm self-check failure all roll back and release the handle', async () => {
    const handle = acquiredHandle();
    scope.requireArmableOrderBoundCancelLease.mockRejectedValueOnce(Object.assign(new Error('[PRACTICAL_PERSISTENCE_CONFLICT] tampered'), { code: 'PRACTICAL_PERSISTENCE_CONFLICT' }));
    await expect(store().armCancelLease(armInput(handle))).rejects.toThrow(/tampered/);
    expect(PracticalAcquiredCancel.status(handle)).toBe('AVAILABLE');
    arm.mockRejectedValueOnce(new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'moved'));
    await expect(store().armCancelLease(armInput(handle))).rejects.toMatchObject({ code: 'LIVE_ORDER_STATE_CONFLICT' });
    expect(scope.armOrderBoundCancelLease).not.toHaveBeenCalled();
    expect(PracticalAcquiredCancel.status(handle)).toBe('AVAILABLE');
    arm.mockImplementationOnce(async () => { world.orderReads = [{ ...ARMED_ORDER }]; return stateRecord({ ...ARMED_ORDER, revision: 9 }); });
    await expect(store().armCancelLease(armInput(handle))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_SELF_CHECK_FAILED' });
    expect(PracticalAcquiredCancel.status(handle)).toBe('AVAILABLE');
    // ...and the same handle then arms successfully.
    world.orderReads = [{ ...CLAIMED_ORDER }];
    expect((await store().armCancelLease(armInput(handle))).kind).toBe('ARMED');
    expect(PracticalAcquiredCancel.status(handle)).toBe('SPENT');
  });

  it('deadlocks are retried inside ONE arm call with the handle held IN_USE; exhausted retries release it (nothing committed)', async () => {
    const handle = acquiredHandle();
    world.failBeforeWork = [knownError('P2034'), knownError('P2034'), knownError('P2034')];
    await expect(store().armCancelLease(armInput(handle))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_FAULT' });
    expect(world.transactions).toBe(3);
    expect(PracticalAcquiredCancel.status(handle)).toBe('AVAILABLE');
    world.failBeforeWork = [knownError('P2034')];
    world.orderReads = [{ ...CLAIMED_ORDER }];
    expect((await store().armCancelLease(armInput(handle))).kind).toBe('ARMED');
    expect(PracticalAcquiredCancel.status(handle)).toBe('SPENT');
  });

  it('an UNKNOWN commit outcome conservatively SPENDS the handle and mints NO ticket', async () => {
    const handle = acquiredHandle();
    world.failAtCommit = knownError('P1017');
    await expect(store().armCancelLease(armInput(handle))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    expect(PracticalAcquiredCancel.status(handle)).toBe('SPENT');
    expect(world.transactions).toBe(1);
  });

  it('a concurrent second arm with the SAME in-memory handle is refused while the first is in flight (never a second ticket)', async () => {
    const handle = acquiredHandle();
    let open!: () => void;
    world.gate = new Promise<void>((resolve) => { open = resolve; });
    const first = store().armCancelLease(armInput(handle));
    await expect(store().armCancelLease(armInput(handle))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    expect(PracticalAcquiredCancel.status(handle)).toBe('IN_USE');
    world.gate = null;
    open();
    expect((await first).kind).toBe('ARMED');
    expect(PracticalAcquiredCancel.status(handle)).toBe('SPENT');
    expect(arm).toHaveBeenCalledTimes(1);
  });
});
