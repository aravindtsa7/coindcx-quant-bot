import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DisposableMysqlGuardError, DisposableMysqlLifecycle, generateDisposableDatabaseName } from '../../helpers/p18b-disposable-mysql';
import type { LiveExecutionIntentRecord } from '../../../src/execution/live/intent';
import { PrismaLiveExecutionRepository, claimCancelWithinCallerFencedTransaction } from '../../../src/execution/live/repository';
import { issuePracticalRecoveryCertificate, type PracticalRecoveryCertificate } from '../../../src/execution/live/practical/certificate';
import { issuePracticalLiveSafetyEnablement, type PracticalLiveSafetyEnablement } from '../../../src/execution/live/practical/policy';
import type { PracticalAccountSnapshot } from '../../../src/execution/live/practical-persistence/ports';
import { PrismaPracticalSafetyRepository } from '../../../src/execution/live/practical-persistence/repository';
import { PrismaPracticalCancelMutationStore } from '../../../src/execution/live/practical-mutation/repository';
import { PracticalAcquiredCancel, PracticalArmedCancel, issuePracticalAcquiredCancel } from '../../../src/execution/live/practical-mutation/ticket';
import { providerAccountFingerprint } from '../../../src/execution/live/reconciliation/account-identity';
import { newLiveRuntimeIdentity, readLiveRuntimeEpoch, requireCurrentReconciliation } from '../../../src/execution/live/reconciliation/barrier';
import { PrismaLiveReconciliationRepository } from '../../../src/execution/live/reconciliation/repository';

// [P18B-1B2-W2B1-DB] Real MySQL proof of the Stage 1B2 order-bound practical CANCEL store:
//
//   ACQUIRE: practical certificate consumption + ONE order-bound CANCEL lease + MUTATING/MUTATION_LEASED +
//            the Phase 17 cancel claim commit together, or not at all; conflicts fail closed in the SAME
//            transaction (PREFLIGHT_MISMATCH / reconciliation reasons) with no lease and no Phase 17 write;
//            integrity/persistence faults and database failures roll back with NO compensation.
//   ARM:     the practical lease AND the Phase 17 claim are armed together, or neither; the full CONSUMED
//            certificate snapshot is re-proven against the acquired handle; any drift refuses with zero writes.
//   LEGACY:  Stage 1B1 UNBOUND consume/release is unchanged; releaseLease refuses order-bound leases;
//            revoke/expire refuse the CONSUMED certificate; invalidate/manual review keep the fence leased.
//
// Over two INDEPENDENT connections, plus a single-connection client proving the store never needs a
// second connection inside its transaction. Failures are injected by TEST-ONLY client extensions (no
// production failpoint, no trigger). FOREIGN_KEY_CHECKS=0 is used only inside disposable tamper
// fixtures, on one transaction's own connection, and restored before it ends.
//
// NOTHING HERE TOUCHES COINDCX: no gateway, transport, signer, or network.
//
// ACCEPTANCE SEMANTICS: soft-skips without a reachable local MySQL; with
// REQUIRE_LIVE_PRACTICAL_CANCEL_STORE_DB_INTEGRATION=1 `beforeAll` THROWS instead. It always uses its own
// disposable database, dropped afterwards — also after a partial provisioning failure. It refuses, before any
// mysql/prisma command, a DATABASE_URL that is not mysql: on localhost / 127.0.0.1 / ::1 / [::1].

const STRICT = process.env['REQUIRE_LIVE_PRACTICAL_CANCEL_STORE_DB_INTEGRATION'] === '1';
const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = generateDisposableDatabaseName();

// [W2B1.1] Every CREATE/DROP, and every client URL, goes through this lifecycle. Constructing it validates the
// base URL (mysql: on a loopback host ONLY) and the generated name BEFORE any mysql/prisma command or client.
let lifecycle: DisposableMysqlLifecycle | null = null;
let dbAvailable = false;
let connectionA: PrismaClient;
let connectionB: PrismaClient;
let singleConnection: PrismaClient;

beforeAll(async () => {
  if (!BASE_DATABASE_URL) {
    if (STRICT) throw new Error('[P18B-W2B1-DB] REQUIRE_LIVE_PRACTICAL_CANCEL_STORE_DB_INTEGRATION=1 but no DATABASE_URL is configured.');
    return;
  }
  let guarded: DisposableMysqlLifecycle;
  try {
    guarded = new DisposableMysqlLifecycle({ rawBaseUrl: BASE_DATABASE_URL, name: SHADOW_DB_NAME, strict: STRICT });
  } catch (error) {
    // The guard's message is credential-free by construction; anything else is reported by class name only.
    const reason = error instanceof DisposableMysqlGuardError ? error.message : (error as Error).name;
    if (STRICT) throw new Error(`[P18B-W2B1-DB] strict mode refused to provision: ${reason}`);
    console.warn(`P18B Wave 2B1 practical cancel store DB suite skipped: ${reason}`);
    return;
  }
  lifecycle = guarded;
  try {
    guarded.createDatabase();
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      stdio: 'pipe', timeout: 120_000, shell: true, env: { ...process.env, DATABASE_URL: guarded.databaseUrl() },
    });
    connectionA = guarded.track(new PrismaClient({ datasources: { db: { url: guarded.databaseUrl() } } }));
    connectionB = guarded.track(new PrismaClient({ datasources: { db: { url: guarded.databaseUrl() } } }));
    singleConnection = guarded.track(new PrismaClient({ datasources: { db: { url: guarded.databaseUrl({ connection_limit: '1', pool_timeout: '5' }) } } }));
    for (const client of [connectionA, connectionB, singleConnection]) await client.$queryRawUnsafe('SELECT 1');
    dbAvailable = true;
  } catch (error) {
    dbAvailable = false;
    // Partial provisioning (CREATE succeeded, a later step failed) is cleaned up HERE, not left for afterAll.
    let cleanupFailure = '';
    try {
      await guarded.cleanup();
    } catch (cleanupError) {
      cleanupFailure = `; cleanup ALSO failed: ${cleanupError instanceof DisposableMysqlGuardError ? cleanupError.message : (cleanupError as Error).name}`;
    }
    if (STRICT) throw new Error(`[P18B-W2B1-DB] strict mode could not provision a disposable MySQL database: ${(error as Error).name}${cleanupFailure}`);
  }
}, 180_000);

afterAll(async () => {
  dbAvailable = false;
  // Idempotent: a no-op after a successful beforeAll-path cleanup; retries a DROP that failed there. Strict
  // mode surfaces a cleanup failure as a hard afterAll failure.
  if (lifecycle !== null) await lifecycle.cleanup();
}, 30_000);

function skip(): boolean {
  if (dbAvailable) return false;
  if (STRICT) throw new Error('[P18B-W2B1-DB] strict mode reached a test body with no database connection.');
  console.warn('P18B Wave 2B1 practical cancel store DB suite skipped: no reachable disposable MySQL. Set REQUIRE_LIVE_PRACTICAL_CANCEL_STORE_DB_INTEGRATION=1 to make this hard.');
  return true;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IDENTITY = newLiveRuntimeIdentity();
const EPOCH = readLiveRuntimeEpoch(IDENTITY)!;
const GENERATION = 1;
const T0 = 1_700_000_000_000;
const NOW = T0 + 60_000;
const ARM_AT = NOW + 1_000;
const FINGERPRINT = providerAccountFingerprint('w2b1-fake-coindcx-account');

let sequence = 0;
function freshAccount(): string {
  sequence += 1;
  return `w2b1-acct-${sequence}-${randomBytes(4).toString('hex')}`;
}

function enablementFor(accountId: string, extra: Record<string, string> = {}): PracticalLiveSafetyEnablement {
  const resolution = issuePracticalLiveSafetyEnablement({ LIVE_PRACTICAL_SAFETY_ENABLED: 'true', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: accountId, ...extra });
  if (resolution.status !== 'ENABLED') throw new Error('fixture enablement');
  return resolution.enablement;
}

function issueCertificate(accountId: string, evidence = 'e'.repeat(64)): PracticalRecoveryCertificate {
  return issuePracticalRecoveryCertificate({
    enablement: enablementFor(accountId),
    bindings: { accountId, providerAccountFingerprint: FINGERPRINT, runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION, streamIncarnation: 1 },
    evidence: { evidenceDigest: evidence, passCount: 3, certificationSpanMs: 30_000, minimumObservedPassSpacingMs: 10_000 },
    issuedAtMs: T0,
  });
}

function practical(client: PrismaClient = connectionA): PrismaPracticalSafetyRepository {
  return new PrismaPracticalSafetyRepository(client);
}

function expectationOf(account: PracticalAccountSnapshot) {
  return { accountId: account.accountId, runtimeEpoch: account.fence.runtimeEpoch, reconciliationGeneration: account.fence.reconciliationGeneration, revision: account.fence.revision };
}

/** QUARANTINED -> CERTIFYING -> CERTIFIED_IDLE with a durable ISSUED certificate at GENERATION, plus a HEALTHY reconciliation row. */
async function certified(accountId: string): Promise<{ account: PracticalAccountSnapshot; certificate: PracticalRecoveryCertificate }> {
  const start = (await practical().initializeAccount({ accountId, runtimeEpoch: EPOCH, reconciliationGeneration: 0, nowMs: T0 - 50_000 })).account;
  const certifying = await practical().startCertification({ accountId, expected: expectationOf(start), runId: 'run-w2b1', nowMs: T0 - 40_000 });
  const certificate = issueCertificate(accountId);
  const account = await practical().finishCertification({ accountId, expected: expectationOf(certifying), runId: 'run-w2b1', resultingGeneration: GENERATION, certificate, nowMs: T0 });
  await healthy(accountId);
  return { account, certificate };
}

async function healthy(accountId: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const state = {
    status: 'HEALTHY' as const, currentGeneration: GENERATION, currentRunId: 'recon-run-w2b1', currentRuntimeEpoch: EPOCH,
    healthyGeneration: GENERATION, blockingFindingCount: 0, revision: 1, ...overrides,
  };
  await connectionA.liveReconciliationState.upsert({ where: { accountId }, create: { accountId, ...state }, update: state } as never);
}

function intentRecord(accountId: string): LiveExecutionIntentRecord {
  sequence += 1;
  const tag = `${randomBytes(4).toString('hex')}${sequence.toString(16).padStart(4, '0')}`;
  return {
    intentId: `${'0'.repeat(52)}${tag}`,
    clientOrderId: `p17-${'0'.repeat(20)}${tag}`,
    wireOrderType: 'limit_order', quantityAdjusted: false, priceAdjusted: false,
    content: {
      accountId, pair: 'B-BTC_USDT', side: 'BUY', action: 'OPEN', quantity: '0.5', orderType: 'LIMIT', price: '64000.5', timeInForce: 'UNSPECIFIED', leverage: '5',
      riskDecisionId: 'risk-w2b1', admissionId: `admission-w2b1-${tag}`, strategyInstanceId: 'instance-w2b1', strategyId: 'EMA_TREND', strategyVersion: '1.0.0',
      parameterHash: 'p'.repeat(64), liveExecutionPolicyId: 'policy-w2b1', instrumentSpecSnapshotId: 'spec-w2b1', authorizedNotionalInr: '2560020',
      settlementRateInrPerQuote: '80', positionInstanceId: null, positionRevision: null, reduceOnlyQuantity: null,
    },
    lineage: {
      researchApproval: { validationSubjectId: 'subject-w2b1', validationPlanId: 'plan-w2b1', validationSubjectResultSha256: 'r'.repeat(64) },
      sourceStrategyDecisionId: 'decision-w2b1',
    },
  };
}

/** A sealed Phase 17 intent (production ensureIntent), then its MUTABLE projection set to an acknowledged venue order. */
async function seedOrder(accountId: string, projection: { readonly state?: 'ACKNOWLEDGED' | 'CREATED' | 'FILLED'; readonly exchangeOrderId?: string | null } = {}): Promise<LiveExecutionIntentRecord> {
  const record = intentRecord(accountId);
  await new PrismaLiveExecutionRepository(connectionA).ensureIntent(record);
  const state = projection.state ?? 'ACKNOWLEDGED';
  if (state !== 'CREATED') {
    await connectionA.liveOrder.update({ where: { intentId: record.intentId }, data: {
      state, exchangeOrderId: projection.exchangeOrderId === undefined ? `venue-${randomBytes(4).toString('hex')}` : projection.exchangeOrderId, revision: 2,
    } });
  }
  return record;
}

function store(client: PrismaClient = connectionA): PrismaPracticalCancelMutationStore {
  return new PrismaPracticalCancelMutationStore(client);
}

function acquireInput(accountId: string, account: PracticalAccountSnapshot, certificate: unknown, intentId: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId, expected: expectationOf(account), certificate, enablement: enablementFor(accountId), runtimeIdentity: IDENTITY, intentId, trustedNowMs: NOW, ...overrides,
  };
}

function armInput(accountId: string, acquired: unknown, overrides: Record<string, unknown> = {}) {
  return { acquired, enablement: enablementFor(accountId), runtimeIdentity: IDENTITY, trustedNowMs: ARM_AT, ...overrides };
}

async function orderRow(intentId: string) {
  return connectionA.liveOrder.findUniqueOrThrow({ where: { intentId } });
}

async function orderClaimColumns(intentId: string) {
  const row = await orderRow(intentId);
  return {
    state: row.state, cancelState: row.cancelState, cancelGeneration: row.cancelGeneration, cancelWireArmed: row.cancelWireArmed,
    cancelExchangeOrderId: row.cancelExchangeOrderId, cancelFaultCode: row.cancelFaultCode, revision: row.revision,
  };
}

async function practicalRows(accountId: string) {
  const [state, fence, leases, certificates, latch] = await Promise.all([
    connectionA.livePracticalAccountState.findUnique({ where: { accountId } }),
    connectionA.livePracticalAccountFence.findUnique({ where: { accountId } }),
    connectionA.livePracticalMutationLease.findMany({ where: { accountId }, orderBy: { leaseId: 'asc' } }),
    connectionA.livePracticalCertificate.findMany({ where: { accountId }, orderBy: { certificateId: 'asc' } }),
    connectionA.livePracticalMalformedLatch.findUnique({ where: { accountId } }),
  ]);
  return { state, fence, leases, certificates, latch };
}

/** A fully acquired account: certified, HEALTHY, one acknowledged order, one committed acquisition. */
async function acquired(): Promise<{ accountId: string; order: LiveExecutionIntentRecord; handle: PracticalAcquiredCancel; certificate: PracticalRecoveryCertificate }> {
  const accountId = freshAccount();
  const { account, certificate } = await certified(accountId);
  const order = await seedOrder(accountId);
  const result = await store().acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId));
  if (result.kind !== 'ACQUIRED') throw new Error(`fixture acquisition: ${result.kind}`);
  return { accountId, order, handle: result.acquired, certificate };
}

class InjectedFault extends Error {}

/** A client whose `model.operation` runs, then throws: a failure AFTER that write, before commit. */
function failAfter(model: string, operation: string): PrismaClient {
  return connectionA.$extends({
    query: { [model]: { async [operation]({ args, query }: { args: unknown; query: (a: unknown) => Promise<unknown> }) { await query(args); throw new InjectedFault(`after ${model}.${operation}`); } } },
  } as never) as unknown as PrismaClient;
}

/** A client whose `model.operation` throws `error` (optionally only the first `times` calls) before running. */
function failWith(model: string, operation: string, error: () => unknown, times = Number.POSITIVE_INFINITY): PrismaClient {
  let calls = 0;
  return connectionA.$extends({
    query: { [model]: { async [operation]({ args, query }: { args: unknown; query: (a: unknown) => Promise<unknown> }) { calls += 1; if (calls <= times) throw error(); return query(args); } } },
  } as never) as unknown as PrismaClient;
}

/** A client whose $transaction COMMITS for real, then reports a lost connection: an UNKNOWN commit outcome. */
function commitLostClient(): PrismaClient {
  return new Proxy(connectionA, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return async (work: unknown, options: unknown) => {
          await (target.$transaction as (w: unknown, o: unknown) => Promise<unknown>)(work, options);
          throw new Prisma.PrismaClientKnownRequestError('connection lost after COMMIT', { code: 'P1017', clientVersion: 'test' });
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

const deadlock = () => new Prisma.PrismaClientKnownRequestError('simulated deadlock', { code: 'P2034', clientVersion: 'test' });

/** Disposable tamper fixture: runs `statements` on ONE connection with foreign-key checks off, restored in finally. */
async function tamperWithoutForeignKeys(statements: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<void> {
  await connectionA.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
    try {
      await statements(tx);
    } finally {
      await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
    }
  });
}

async function expectNoArmWrites(accountId: string, intentId: string, revision: number): Promise<void> {
  const rows = await practicalRows(accountId);
  expect(rows.leases).toHaveLength(1);
  expect(rows.leases[0]!.armedAtMs).toBeNull();
  const order = await orderRow(intentId);
  expect({ cancelWireArmed: order.cancelWireArmed, revision: order.revision }).toEqual({ cancelWireArmed: false, revision });
}

// ---------------------------------------------------------------------------
// ACQUIRE
// ---------------------------------------------------------------------------

describe('P18B-W2B1-DB acquire: one atomic decision', () => {
  it('commits certificate CONSUMED + ONE order-bound CANCEL lease + MUTATING + MUTATION_LEASED + the Phase 17 claim; the handle equals the durable rows', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const order = await seedOrder(accountId);
    const before = await orderRow(order.intentId);
    const result = await store().acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId));
    if (result.kind !== 'ACQUIRED') throw new Error(result.kind);
    const handle = PracticalAcquiredCancel.read(result.acquired)!;
    const rows = await practicalRows(accountId);
    expect(rows.state).toMatchObject({ state: 'MUTATING' });
    expect(rows.fence).toMatchObject({ mode: 'MUTATION_LEASED', leaseId: handle.leaseId, certificateId: handle.certificate.certificateId, leaseAction: 'CANCEL' });
    expect(rows.leases).toHaveLength(1);
    expect(rows.leases[0]).toMatchObject({
      leaseId: handle.leaseId, action: 'CANCEL', intentId: order.intentId, clientOrderId: order.clientOrderId, cancelGeneration: 1,
      runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION, createdAtMs: BigInt(NOW), armedAtMs: null, status: 'LEASED',
    });
    expect(rows.certificates).toHaveLength(1);
    expect(rows.certificates[0]).toMatchObject({ status: 'CONSUMED', terminalAtMs: BigInt(NOW), terminalReason: null, streamIncarnation: 1 });
    expect(await orderRow(order.intentId)).toMatchObject({
      state: 'CANCEL_REQUESTED', cancelState: 'CANCEL_RESERVED', cancelGeneration: 1, cancelWireArmed: false, cancelExchangeOrderId: before.exchangeOrderId, revision: before.revision + 1,
    });
    expect(handle).toMatchObject({
      accountId, intentId: order.intentId, clientOrderId: order.clientOrderId, cancelGeneration: 1, exchangeOrderId: before.exchangeOrderId, pair: 'B-BTC_USDT',
      orderRevisionAfterClaim: before.revision + 1, leaseCreatedAtMs: NOW, acquiredAtMs: NOW,
      certificate: { status: 'CONSUMED', consumedAtMs: NOW, providerAccountFingerprint: FINGERPRINT, streamIncarnation: 1, basis: 'PRACTICAL_RECOVERY', provesAccountContinuity: false },
    });
    expect(PracticalAcquiredCancel.status(result.acquired)).toBe('AVAILABLE');
  });

  it('two independent connections racing the SAME certificate: exactly one lease, one claim, one consumption', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const twin = issueCertificate(accountId); // a second genuine in-memory object with the SAME certificate id
    const order = await seedOrder(accountId);
    const before = await orderRow(order.intentId);
    const results = await Promise.allSettled([
      store(connectionA).acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId)),
      store(connectionB).acquireCancelLease(acquireInput(accountId, account, twin, order.intentId)),
    ]);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<PrismaPracticalCancelMutationStore['acquireCancelLease']>>> => result.status === 'fulfilled');
    expect(fulfilled.map((result) => result.value.kind)).toEqual(['ACQUIRED']);
    const rows = await practicalRows(accountId);
    expect(rows.leases).toHaveLength(1);
    expect(rows.certificates.map((row) => row.status)).toEqual(['CONSUMED']);
    expect(await orderRow(order.intentId)).toMatchObject({ cancelGeneration: 1, revision: before.revision + 1 });
  }, 60_000);

  it('the certificate is consumed at most once: a second acquisition, or a Stage 1B1 consume, is refused with zero change', async () => {
    if (skip()) return;
    const { accountId, order, certificate } = await acquired();
    const snapshot = await practicalRows(accountId);
    const second = await seedOrder(accountId);
    const account = (await practical().loadAccount(accountId));
    if (account.kind !== 'FOUND') throw new Error(account.kind);
    await expect(store().acquireCancelLease(acquireInput(accountId, account.account, certificate, second.intentId))).rejects.toThrow(/PRACTICAL_PERSISTENCE_(CONFLICT|CERTIFICATE_UNUSABLE)|PRACTICAL_FENCE/);
    await expect(practical().consumeCertificateAndLease({ accountId, expected: expectationOf(account.account), certificate, leaseId: `${accountId}-x`, action: 'CANCEL', trustedNowMs: NOW }))
      .rejects.toThrow();
    expect(await practicalRows(accountId)).toEqual(snapshot);
    expect((await orderRow(second.intentId)).cancelState).toBe('NONE');
    expect((await orderRow(order.intentId)).cancelGeneration).toBe(1);
  });

  it('the database allows ONE lease per certificate and ONE lease per (intent, cancel generation)', async () => {
    if (skip()) return;
    const { accountId, order } = await acquired();
    const lease = (await practicalRows(accountId)).leases[0]!;
    await expect(connectionA.$executeRaw`INSERT INTO live_practical_mutation_lease (lease_id, account_id, certificate_id, action, runtime_epoch, reconciliation_generation, created_at_ms, status)
      VALUES (${`${accountId}-dup`}, ${accountId}, ${lease.certificateId}, 'CANCEL', ${EPOCH}, ${GENERATION}, ${NOW}, 'LEASED')`).rejects.toThrow(/Duplicate|1062|P2002|P2010/);
    // A second CONSUMED certificate of the same account, then a lease bound to the SAME intent + cancel generation.
    const other = 'd'.repeat(64);
    await connectionA.$executeRaw`INSERT INTO live_practical_certificate (certificate_id, account_id, provider_account_fingerprint, runtime_epoch, reconciliation_generation,
      stream_incarnation, evidence_digest, issued_at_ms, expires_at_ms, status, terminal_at_ms) VALUES (${other}, ${accountId}, ${FINGERPRINT}, ${EPOCH}, ${GENERATION}, 1,
      ${'e'.repeat(64)}, ${T0}, ${T0 + 120_000}, 'CONSUMED', ${NOW})`;
    await expect(connectionA.$executeRaw`INSERT INTO live_practical_mutation_lease (lease_id, account_id, certificate_id, action, intent_id, client_order_id, cancel_generation,
      runtime_epoch, reconciliation_generation, created_at_ms, status) VALUES (${`${accountId}-dup2`}, ${accountId}, ${other}, 'CANCEL', ${order.intentId}, ${order.clientOrderId}, 1,
      ${EPOCH}, ${GENERATION}, ${NOW}, 'LEASED')`).rejects.toThrow(/Duplicate|1062|P2002|P2010/);
    // OPEN / CLOSE can never be order-bound (CHECK).
    await expect(connectionA.$executeRaw`INSERT INTO live_practical_mutation_lease (lease_id, account_id, certificate_id, action, intent_id, client_order_id, cancel_generation,
      runtime_epoch, reconciliation_generation, created_at_ms, status) VALUES (${`${accountId}-open`}, ${accountId}, ${other}, 'OPEN', ${order.intentId}, ${order.clientOrderId}, 2,
      ${EPOCH}, ${GENERATION}, ${NOW}, 'LEASED')`).rejects.toThrow(/bound_action_chk|3819|check constraint/i);
  });

  it.each([
    ['after the Phase 17 claim UPDATE', 'liveOrder', 'update'],
    ['after the order-bound lease INSERT', 'livePracticalMutationLease', 'create'],
    ['at the final stage (after the fence UPDATE, before the re-reads and COMMIT)', 'livePracticalAccountFence', 'updateMany'],
  ] as const)('a failure %s rolls EVERYTHING back (practical and Phase 17), with no compensation', async (_name, model, operation) => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const order = await seedOrder(accountId);
    const beforeOrder = await orderClaimColumns(order.intentId);
    const beforeRows = await practicalRows(accountId);
    await expect(store(failAfter(model, operation)).acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId))).rejects.toBeInstanceOf(InjectedFault);
    expect(await orderClaimColumns(order.intentId)).toEqual(beforeOrder);
    expect(await practicalRows(accountId)).toEqual(beforeRows);
    // Still usable: the certificate stayed ISSUED and a clean retry acquires.
    expect((await store().acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId))).kind).toBe('ACQUIRED');
  });

  it('a stale practical fence expectation is refused BEFORE any Phase 17 claim (zero change)', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const order = await seedOrder(accountId);
    const beforeOrder = await orderClaimColumns(order.intentId);
    const beforeRows = await practicalRows(accountId);
    await expect(store().acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId, { expected: { ...expectationOf(account), revision: account.fence.revision - 1 } })))
      .rejects.toThrow(/PRACTICAL_FENCE_BINDING_MISMATCH/);
    expect(await orderClaimColumns(order.intentId)).toEqual(beforeOrder);
    expect(await practicalRows(accountId)).toEqual(beforeRows);
  });

  it('outside the durable validity window: EXPIRED at/after expiry, REVOKED(CLOCK_ANOMALY) before issuance; Phase 17 untouched', async () => {
    if (skip()) return;
    for (const [nowMs, status, reason] of [[T0 + 120_000, 'EXPIRED', 'CERTIFICATE_EXPIRED'], [T0 - 1, 'REVOKED', 'CLOCK_ANOMALY']] as const) {
      const accountId = freshAccount();
      const { account, certificate } = await certified(accountId);
      const order = await seedOrder(accountId);
      const beforeOrder = await orderClaimColumns(order.intentId);
      const result = await store().acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId, { trustedNowMs: nowMs }));
      expect(result).toMatchObject({ kind: 'CERTIFICATE_TERMINATED', status });
      expect((await practicalRows(accountId)).certificates[0]).toMatchObject({ status, terminalReason: reason });
      expect(await orderClaimColumns(order.intentId)).toEqual(beforeOrder);
    }
  });

  it('forged or non-durable certificates are refused with zero change', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const order = await seedOrder(accountId);
    const beforeRows = await practicalRows(accountId);
    await expect(store().acquireCancelLease(acquireInput(accountId, account, { ...certificate }, order.intentId))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    // Genuine, but never persisted (different evidence -> different id): not the durable current certificate.
    await expect(store().acquireCancelLease(acquireInput(accountId, account, issueCertificate(accountId, 'd'.repeat(64)), order.intentId))).rejects.toThrow(/PRACTICAL_PERSISTENCE_CERTIFICATE_UNUSABLE/);
    expect(await practicalRows(accountId)).toEqual(beforeRows);
    expect((await orderRow(order.intentId)).cancelState).toBe('NONE');
  });

  it('an exact-case account mismatch never acts on the exactly spelled account (no latch, no claim)', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account } = await certified(accountId);
    const order = await seedOrder(accountId);
    const variant = accountId.toUpperCase();
    const beforeRows = await practicalRows(accountId);
    const variantCertificate = issuePracticalRecoveryCertificate({
      enablement: enablementFor(variant),
      bindings: { accountId: variant, providerAccountFingerprint: FINGERPRINT, runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION, streamIncarnation: 1 },
      evidence: { evidenceDigest: 'e'.repeat(64), passCount: 3, certificationSpanMs: 30_000, minimumObservedPassSpacingMs: 10_000 },
      issuedAtMs: T0,
    });
    await expect(store().acquireCancelLease({ ...acquireInput(variant, account, variantCertificate, order.intentId), expected: { ...expectationOf(account), accountId: variant } }))
      .rejects.toThrow(/PRACTICAL_PERSISTENCE_MALFORMED/);
    expect(await practicalRows(accountId)).toEqual(beforeRows);
    expect((await orderRow(order.intentId)).cancelState).toBe('NONE');
  });

  it.each([
    ['another runtime epoch', { currentRuntimeEpoch: 'epoch-of-a-previous-process' }, 'RUNTIME_EPOCH_CHANGED'],
    ['a reconciliation run in flight (generation bumped)', { status: 'RUNNING', currentGeneration: GENERATION + 1 }, 'GENERATION_CHANGED'],
    ['a newer healthy generation', { currentGeneration: GENERATION + 1, healthyGeneration: GENERATION + 1 }, 'GENERATION_CHANGED'],
    ['UNHEALTHY', { status: 'UNHEALTHY' }, 'PREFLIGHT_MISMATCH'],
    ['a blocking finding', { blockingFindingCount: 1 }, 'PREFLIGHT_MISMATCH'],
    ['a null run id', { currentRunId: null }, 'PREFLIGHT_MISMATCH'],
  ] as const)('reconciliation state with %s: same-transaction %s, certificate REVOKED, no lease, no Phase 17 write', async (_name, change, reason) => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    await healthy(accountId, change);
    const order = await seedOrder(accountId);
    const beforeOrder = await orderClaimColumns(order.intentId);
    const result = await store().acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId));
    expect(result).toMatchObject({ kind: 'AUTHORITY_INVALIDATED', reason, cause: 'RECONCILIATION_STATE_MISMATCH' });
    const rows = await practicalRows(accountId);
    expect(rows.state).toMatchObject({ state: 'QUARANTINED' });
    expect(rows.fence).toMatchObject({ mode: 'IDLE', revision: BigInt(account.fence.revision) });
    expect(rows.leases).toEqual([]);
    expect(rows.certificates[0]).toMatchObject({ status: 'REVOKED', terminalReason: reason });
    expect(await orderClaimColumns(order.intentId)).toEqual(beforeOrder);
  });

  it('a missing reconciliation row is PREFLIGHT_MISMATCH', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    await connectionA.liveReconciliationState.delete({ where: { accountId } });
    const order = await seedOrder(accountId);
    expect(await store().acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId))).toMatchObject({ reason: 'PREFLIGHT_MISMATCH', cause: 'RECONCILIATION_STATE_MISMATCH' });
  });

  it('OPEN / CLOSE and a caller client order id are impossible: extra input keys are refused before any durable access', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const order = await seedOrder(accountId);
    const beforeRows = await practicalRows(accountId);
    for (const extra of [{ action: 'OPEN' }, { action: 'CLOSE' }, { clientOrderId: order.clientOrderId }, { cancelGeneration: 1 }, { leaseId: 'mine' }, { tier: 'PRACTICAL' }]) {
      await expect(store().acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId, extra) as never), JSON.stringify(extra)).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_INVALID_INPUT' });
    }
    expect(await practicalRows(accountId)).toEqual(beforeRows);
  });
});

describe('P18B-W2B1-DB acquire: Phase 17 claim conflicts fail closed in the SAME transaction; faults roll back with NO compensation', () => {
  async function invalidatedWithoutPhase17Write(prepare: (accountId: string) => Promise<LiveExecutionIntentRecord | string>, cause: string, phase17Code: string | null = null) {
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const order = await prepare(accountId);
    const intentId = typeof order === 'string' ? order : order.intentId;
    const beforeOrder = typeof order === 'string' ? null : await orderClaimColumns(intentId);
    const result = await store().acquireCancelLease(acquireInput(accountId, account, certificate, intentId));
    expect(result).toMatchObject({ kind: 'AUTHORITY_INVALIDATED', reason: 'PREFLIGHT_MISMATCH', cause, phase17Code });
    const rows = await practicalRows(accountId);
    expect(rows.state).toMatchObject({ state: 'QUARANTINED' });
    expect(rows.fence).toMatchObject({ mode: 'IDLE' });
    expect(rows.leases).toEqual([]);
    expect(rows.certificates[0]).toMatchObject({ status: 'REVOKED', terminalReason: 'PREFLIGHT_MISMATCH' });
    if (beforeOrder !== null) expect(await orderClaimColumns(intentId)).toEqual(beforeOrder);
  }

  it('ALREADY_CLAIMED -> PREFLIGHT_MISMATCH, no lease, no Phase 17 write', async () => {
    if (skip()) return;
    await invalidatedWithoutPhase17Write(async (accountId) => {
      const order = await seedOrder(accountId);
      await connectionA.$transaction((tx) => claimCancelWithinCallerFencedTransaction(tx, order.intentId, accountId));
      return order;
    }, 'PHASE17_ALREADY_CLAIMED');
  });

  it.each(['CREATED', 'FILLED'] as const)('NOT_CANCELLABLE (%s) -> PREFLIGHT_MISMATCH, no lease, no Phase 17 write', async (state) => {
    if (skip()) return;
    await invalidatedWithoutPhase17Write((accountId) => seedOrder(accountId, { state }), 'PHASE17_NOT_CANCELLABLE');
  });

  it('a missing exchange order id (classified LIVE_ORDER_IDENTITY_MISMATCH, pre-UPDATE) -> same-transaction PREFLIGHT_MISMATCH', async () => {
    if (skip()) return;
    await invalidatedWithoutPhase17Write((accountId) => seedOrder(accountId, { exchangeOrderId: null }), 'PHASE17_CLAIM_REFUSED', 'LIVE_ORDER_IDENTITY_MISMATCH');
  });

  it('a missing Phase 17 intent -> same-transaction PREFLIGHT_MISMATCH (the exact pre-check, before any claim)', async () => {
    if (skip()) return;
    await invalidatedWithoutPhase17Write(async () => `${'0'.repeat(56)}${randomBytes(4).toString('hex')}`, 'PHASE17_ORDER_MISMATCH');
  });

  it('an order owned by ANOTHER account -> same-transaction PREFLIGHT_MISMATCH (the exact pre-check; the claim\'s LIVE_AUTHORITY_INVALID is not reached)', async () => {
    if (skip()) return;
    await invalidatedWithoutPhase17Write(() => seedOrder(freshAccount()), 'PHASE17_ORDER_MISMATCH');
  });

  it('LIVE_DURABLE_INTEGRITY_VIOLATION (tampered sealed intent) is NOT converted: FULL rollback, certificate still ISSUED, no lease', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const order = await seedOrder(accountId);
    await connectionA.$executeRaw`UPDATE live_execution_intent SET strategy_id = 'TAMPERED' WHERE intent_id = ${order.intentId}`;
    const beforeOrder = await orderClaimColumns(order.intentId);
    const beforeRows = await practicalRows(accountId);
    await expect(store().acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId))).rejects.toMatchObject({ code: 'LIVE_DURABLE_INTEGRITY_VIOLATION' });
    expect(await practicalRows(accountId)).toEqual(beforeRows);
    expect(beforeRows.certificates[0]).toMatchObject({ status: 'ISSUED' });
    expect(await orderClaimColumns(order.intentId)).toEqual(beforeOrder);
  });

  it('LIVE_PERSISTENCE_FAULT (an unreadable durable timestamp) is NOT converted: FULL rollback, certificate still ISSUED, no lease', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const order = await seedOrder(accountId);
    await connectionA.$executeRaw`UPDATE live_order SET last_provider_event_time_ms = 9007199254740993 WHERE intent_id = ${order.intentId}`;
    const beforeRows = await practicalRows(accountId);
    await expect(store().acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId))).rejects.toMatchObject({ code: 'LIVE_PERSISTENCE_FAULT' });
    expect(await practicalRows(accountId)).toEqual(beforeRows);
    expect((await orderRow(order.intentId)).cancelState).toBe('NONE');
  });

  it('a MALFORMED practical row is latched (existing escalation, after rollback) with NO Phase 17 write; a retry is refused LATCHED', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const order = await seedOrder(accountId);
    const beforeOrder = await orderClaimColumns(order.intentId);
    await connectionA.$executeRaw`UPDATE live_practical_account_fence SET mode = 'CERTIFYING', run_id = ' padded-run' WHERE account_id = ${accountId}`;
    const result = await store().acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId));
    expect(result).toMatchObject({ kind: 'MALFORMED_LATCHED' });
    expect((await practicalRows(accountId)).latch).not.toBeNull();
    await expect(store().acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId))).rejects.toThrow(/PRACTICAL_PERSISTENCE_LATCHED/);
    expect(await orderClaimColumns(order.intentId)).toEqual(beforeOrder);
  });

  it('a deadlock is retried as a WHOLE transaction (nothing reused) and never revokes; exhausted retries change nothing', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const order = await seedOrder(accountId);
    const beforeOrder = await orderClaimColumns(order.intentId);
    const beforeRows = await practicalRows(accountId);
    // Always deadlocking AFTER the claim wrote: 3 attempts, FAULT, and NOTHING committed or compensated.
    await expect(store(failWith('livePracticalMutationLease', 'create', deadlock)).acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId)))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_FAULT', details: { attempts: 3 } });
    expect(await practicalRows(accountId)).toEqual(beforeRows);
    expect(await orderClaimColumns(order.intentId)).toEqual(beforeOrder);
    // Deadlocking once: the retry re-claims from scratch (ONE generation, ONE revision step).
    const result = await store(failWith('livePracticalMutationLease', 'create', deadlock, 1)).acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId));
    expect(result.kind).toBe('ACQUIRED');
    expect(await orderRow(order.intentId)).toMatchObject({ cancelGeneration: 1, revision: beforeOrder.revision + 1 });
    expect((await practicalRows(accountId)).leases).toHaveLength(1);
  }, 60_000);

  it('a non-retryable database error is FAULT after ONE attempt: nothing committed, nothing revoked', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const order = await seedOrder(accountId);
    const beforeRows = await practicalRows(accountId);
    for (const error of [() => new Prisma.PrismaClientKnownRequestError('closed', { code: 'P1017', clientVersion: 'test' }),
      () => new Prisma.PrismaClientKnownRequestError('lock wait', { code: 'P2010', clientVersion: 'test', meta: { code: '1205' } })]) {
      await expect(store(failWith('livePracticalAccountState', 'updateMany', error)).acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId)))
        .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_FAULT' });
    }
    expect(await practicalRows(accountId)).toEqual(beforeRows);
    expect((await orderRow(order.intentId)).cancelState).toBe('NONE');
  });

  it('a REAL mid-transaction database failure after the claim (duplicate lease id) rolls everything back', async () => {
    if (skip()) return;
    const holder = await acquired();
    const existingLeaseId = (await practicalRows(holder.accountId)).leases[0]!.leaseId;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const order = await seedOrder(accountId);
    const beforeOrder = await orderClaimColumns(order.intentId);
    await expect(new PrismaPracticalCancelMutationStore(connectionA, () => existingLeaseId).acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId)))
      .rejects.toThrow(/PRACTICAL_PERSISTENCE_CONFLICT/);
    expect(await orderClaimColumns(order.intentId)).toEqual(beforeOrder);
    expect((await practicalRows(accountId)).certificates[0]).toMatchObject({ status: 'ISSUED' });
  });

  it('the store never needs a second connection inside its transaction (single-connection client: acquire and arm succeed)', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const order = await seedOrder(accountId);
    const result = await store(singleConnection).acquireCancelLease(acquireInput(accountId, account, certificate, order.intentId));
    if (result.kind !== 'ACQUIRED') throw new Error(result.kind);
    expect((await store(singleConnection).armCancelLease(armInput(accountId, result.acquired))).kind).toBe('ARMED');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// ARM
// ---------------------------------------------------------------------------

describe('P18B-W2B1-DB arm: both durable sides, or neither', () => {
  it('arms the practical lease AND the Phase 17 claim in one commit; the handle is SPENT; the ticket equals the durable rows', async () => {
    if (skip()) return;
    const { accountId, order, handle } = await acquired();
    const record = PracticalAcquiredCancel.read(handle)!;
    const beforeRows = await practicalRows(accountId);
    const result = await store().armCancelLease(armInput(accountId, handle));
    const rows = await practicalRows(accountId);
    expect(rows.leases[0]).toMatchObject({ armedAtMs: BigInt(ARM_AT), status: 'LEASED', intentId: order.intentId, cancelGeneration: 1 });
    expect(rows.fence).toEqual(beforeRows.fence);
    expect(rows.state).toEqual(beforeRows.state);
    expect(rows.certificates).toEqual(beforeRows.certificates);
    expect(await orderRow(order.intentId)).toMatchObject({ cancelState: 'CANCEL_RESERVED', cancelWireArmed: true, revision: record.orderRevisionAfterClaim + 1 });
    expect(PracticalAcquiredCancel.status(handle)).toBe('SPENT');
    expect(PracticalArmedCancel.read(result.ticket)).toMatchObject({
      accountId, leaseId: record.leaseId, certificateId: record.certificate.certificateId, intentId: order.intentId, clientOrderId: order.clientOrderId, cancelGeneration: 1,
      exchangeOrderId: record.exchangeOrderId, pair: 'B-BTC_USDT', orderRevisionAfterArm: record.orderRevisionAfterClaim + 1, runtimeEpoch: EPOCH, reconciliationGeneration: GENERATION,
      certificateStreamIncarnation: 1, certificateExpiresAtMs: T0 + 120_000, armedAtMs: ARM_AT, action: 'CANCEL', basis: 'PRACTICAL_RECOVERY', provesAccountContinuity: false,
    });
    // The ticket is not strict authority: the public Tier-A arm refuses it.
    await expect(new PrismaLiveExecutionRepository(connectionA).armCancelWire(order.intentId, record.orderRevisionAfterClaim + 1, result.ticket)).rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED' });
    // The strict Phase 18 barrier still refuses.
    await expect(requireCurrentReconciliation(new PrismaLiveReconciliationRepository(connectionA), accountId, IDENTITY, 'CANCEL'))
      .rejects.toMatchObject({ details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
  });

  it.each([
    ['after the Phase 17 arm UPDATE, before the practical arm', 'liveOrder', 'updateMany'],
    ['after the practical arm CAS, before the re-reads and COMMIT', 'livePracticalMutationLease', 'updateMany'],
  ] as const)('a failure %s rolls BOTH sides back; the handle stays reusable and then arms', async (_name, model, operation) => {
    if (skip()) return;
    const { accountId, order, handle } = await acquired();
    const revision = PracticalAcquiredCancel.read(handle)!.orderRevisionAfterClaim;
    await expect(store(failAfter(model, operation)).armCancelLease(armInput(accountId, handle))).rejects.toBeInstanceOf(InjectedFault);
    await expectNoArmWrites(accountId, order.intentId, revision);
    expect(PracticalAcquiredCancel.status(handle)).toBe('AVAILABLE');
    expect((await store().armCancelLease(armInput(accountId, handle))).kind).toBe('ARMED');
  });

  it('a practical invalidation (stale state) or a stale Phase 17 revision refuses with zero arm writes', async () => {
    if (skip()) return;
    const first = await acquired();
    await practical().invalidate({ accountId: first.accountId, reason: 'WS_DISCONNECTED', nowMs: NOW + 500 });
    await expect(store().armCancelLease(armInput(first.accountId, first.handle))).rejects.toThrow(/PRACTICAL_PERSISTENCE_CONFLICT.*not MUTATING/);
    await expectNoArmWrites(first.accountId, first.order.intentId, PracticalAcquiredCancel.read(first.handle)!.orderRevisionAfterClaim);
    const second = await acquired();
    const revision = PracticalAcquiredCancel.read(second.handle)!.orderRevisionAfterClaim;
    await connectionA.liveOrder.update({ where: { intentId: second.order.intentId }, data: { revision: revision + 1 } });
    await expect(store().armCancelLease(armInput(second.accountId, second.handle))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_ARM_REFUSED' });
    await expectNoArmWrites(second.accountId, second.order.intentId, revision + 1);
    expect(PracticalAcquiredCancel.status(second.handle)).toBe('AVAILABLE');
  });

  it('another runtime identity, or a moved reconciliation generation / epoch, refuses with zero arm writes', async () => {
    if (skip()) return;
    const { accountId, order, handle } = await acquired();
    const revision = PracticalAcquiredCancel.read(handle)!.orderRevisionAfterClaim;
    await expect(store().armCancelLease(armInput(accountId, handle, { runtimeIdentity: newLiveRuntimeIdentity() }))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
    for (const change of [{ status: 'RUNNING', currentGeneration: GENERATION + 1 }, { currentRuntimeEpoch: 'epoch-previous' }, { blockingFindingCount: 2 }]) {
      await healthy(accountId, change);
      await expect(store().armCancelLease(armInput(accountId, handle)), JSON.stringify(change)).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_ARM_REFUSED' });
    }
    await expectNoArmWrites(accountId, order.intentId, revision);
    await healthy(accountId);
    expect((await store().armCancelLease(armInput(accountId, handle))).kind).toBe('ARMED');
  });

  it('a zero-change refusal (outside the certificate window) leaves the handle reusable; inside the window it then arms', async () => {
    if (skip()) return;
    const { accountId, order, handle } = await acquired();
    const revision = PracticalAcquiredCancel.read(handle)!.orderRevisionAfterClaim;
    await expect(store().armCancelLease(armInput(accountId, handle, { trustedNowMs: T0 + 120_000 }))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_ARM_REFUSED' });
    await expect(store().armCancelLease(armInput(accountId, handle, { enablement: enablementFor(accountId, { LIVE_PRACTICAL_CERTIFICATE_LIFETIME_MS: '61000' }) })))
      .rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_ARM_REFUSED' });
    await expectNoArmWrites(accountId, order.intentId, revision);
    expect(PracticalAcquiredCancel.status(handle)).toBe('AVAILABLE');
    expect((await store().armCancelLease(armInput(accountId, handle))).kind).toBe('ARMED');
  });

  it('racing arms of ONE lease on two connections (two genuine handles): exactly one commit, one ticket', async () => {
    if (skip()) return;
    const { accountId, order, handle } = await acquired();
    const twin = issuePracticalAcquiredCancel(PracticalAcquiredCancel.read(handle)!);
    const revision = PracticalAcquiredCancel.read(handle)!.orderRevisionAfterClaim;
    const results = await Promise.allSettled([
      store(connectionA).armCancelLease(armInput(accountId, handle)),
      store(connectionB).armCancelLease(armInput(accountId, twin)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await orderRow(order.intentId))).toMatchObject({ cancelWireArmed: true, revision: revision + 1 });
    expect((await practicalRows(accountId)).leases[0]!.armedAtMs).toBe(BigInt(ARM_AT));
    const statuses = [PracticalAcquiredCancel.status(handle), PracticalAcquiredCancel.status(twin)].sort();
    expect(statuses).toEqual(['AVAILABLE', 'SPENT']);
  }, 60_000);

  it('an UNKNOWN commit outcome (COMMIT happened, acknowledgement lost) spends the handle and mints NO ticket', async () => {
    if (skip()) return;
    const { accountId, order, handle } = await acquired();
    await expect(store(commitLostClient()).armCancelLease(armInput(accountId, handle))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN' });
    expect(PracticalAcquiredCancel.status(handle)).toBe('SPENT');
    // Durable truth (here: committed) is left for the later recovery path; the spent handle can never arm again.
    expect((await orderRow(order.intentId)).cancelWireArmed).toBe(true);
    await expect(store().armCancelLease(armInput(accountId, handle))).rejects.toMatchObject({ code: 'PRACTICAL_MUTATION_AUTHORITY_INVALID' });
  });
});

describe('P18B-W2B1-DB arm: binding and CONSUMED-certificate tamper refuses with ZERO arm writes', () => {
  const SNAPSHOT_DRIFT = /PRACTICAL_PERSISTENCE_CONFLICT\] The durable CONSUMED certificate does not exactly equal the acquired snapshot/;
  const LEASE_DRIFT = /PRACTICAL_PERSISTENCE_CONFLICT\] The durable lease is not exactly this unarmed, order-bound CANCEL lease/;
  // A row the strict parser or the account chain rejects is MALFORMED: latched by the existing escalation, never armed.
  const LATCHED = /PRACTICAL_PERSISTENCE_LATCHED\] The account was latched in malformed-state manual review; nothing was armed/;
  const RECONCILIATION_R0 = /PRACTICAL_MUTATION_ARM_REFUSED\] The reconciliation state no longer matches the lease/;

  async function tampered(tamper: (context: { accountId: string; intentId: string; certificateId: string }) => Promise<void>, refusal: RegExp): Promise<void> {
    const { accountId, order, handle } = await acquired();
    const record = PracticalAcquiredCancel.read(handle)!;
    await tamper({ accountId, intentId: order.intentId, certificateId: record.certificate.certificateId });
    await expect(store().armCancelLease(armInput(accountId, handle))).rejects.toThrow(refusal);
    await expectNoArmWrites(accountId, order.intentId, record.orderRevisionAfterClaim);
  }

  it.each([
    ['streamIncarnation', SNAPSHOT_DRIFT, (c: { certificateId: string }) => connectionA.$executeRaw`UPDATE live_practical_certificate SET stream_incarnation = 2 WHERE certificate_id = ${c.certificateId}`],
    ['providerAccountFingerprint', SNAPSHOT_DRIFT, (c: { certificateId: string }) => connectionA.$executeRaw`UPDATE live_practical_certificate SET provider_account_fingerprint = ${'a'.repeat(64)} WHERE certificate_id = ${c.certificateId}`],
    ['evidenceDigest', SNAPSHOT_DRIFT, (c: { certificateId: string }) => connectionA.$executeRaw`UPDATE live_practical_certificate SET evidence_digest = ${'b'.repeat(64)} WHERE certificate_id = ${c.certificateId}`],
    ['issuedAtMs', SNAPSHOT_DRIFT, (c: { certificateId: string }) => connectionA.$executeRaw`UPDATE live_practical_certificate SET issued_at_ms = issued_at_ms - 1 WHERE certificate_id = ${c.certificateId}`],
    ['expiresAtMs', SNAPSHOT_DRIFT, (c: { certificateId: string }) => connectionA.$executeRaw`UPDATE live_practical_certificate SET expires_at_ms = expires_at_ms + 1 WHERE certificate_id = ${c.certificateId}`],
    ['status (REVOKED)', LATCHED, (c: { certificateId: string }) => connectionA.$executeRaw`UPDATE live_practical_certificate SET status = 'REVOKED', terminal_reason = 'PREFLIGHT_MISMATCH' WHERE certificate_id = ${c.certificateId}`],
    ['terminalAtMs', SNAPSHOT_DRIFT, (c: { certificateId: string }) => connectionA.$executeRaw`UPDATE live_practical_certificate SET terminal_at_ms = terminal_at_ms + 1 WHERE certificate_id = ${c.certificateId}`],
    ['case-only fingerprint', LATCHED, (c: { certificateId: string }) => connectionA.$executeRaw`UPDATE live_practical_certificate SET provider_account_fingerprint = UPPER(provider_account_fingerprint) WHERE certificate_id = ${c.certificateId}`],
  ] as const)('certificate %s changed', async (_name, refusal, tamper) => {
    if (skip()) return;
    await tampered(async (context) => { await tamper(context); }, refusal);
  });

  it.each([
    ['case-only certificate runtime epoch', LATCHED, "UPDATE live_practical_certificate SET runtime_epoch = UPPER(runtime_epoch) WHERE certificate_id = ?", 'certificateId'],
    ['case-only certificate account id', LATCHED, "UPDATE live_practical_certificate SET account_id = UPPER(account_id) WHERE certificate_id = ?", 'certificateId'],
    ['case-only lease client order id', LEASE_DRIFT, "UPDATE live_practical_mutation_lease SET client_order_id = UPPER(client_order_id) WHERE intent_id = ?", 'intentId'],
    ['case-only lease intent id', LEASE_DRIFT, "UPDATE live_practical_mutation_lease SET intent_id = UPPER(intent_id) WHERE intent_id = ?", 'intentId'],
    ['lease cancel generation', LEASE_DRIFT, "UPDATE live_practical_mutation_lease SET cancel_generation = 2 WHERE intent_id = ?", 'intentId'],
    ['lease client order id (another value)', LEASE_DRIFT, "UPDATE live_practical_mutation_lease SET client_order_id = CONCAT('p17-', REPEAT('9', 32)) WHERE intent_id = ?", 'intentId'],
  ] as const)('%s (a collation-tolerated or foreign-key-bypassing tamper, disposable fixture)', async (_name, refusal, sql, key) => {
    if (skip()) return;
    await tampered(async (context) => {
      await tamperWithoutForeignKeys((tx) => tx.$executeRawUnsafe(sql, context[key]));
    }, refusal);
  });

  it('a case-only reconciliation account key (collation match) is R0: refused with zero arm writes', async () => {
    if (skip()) return;
    await tampered(async ({ accountId }) => {
      await connectionA.$executeRaw`UPDATE live_reconciliation_state SET account_id = UPPER(account_id) WHERE account_id = ${accountId}`;
    }, RECONCILIATION_R0);
  });
});

// ---------------------------------------------------------------------------
// LEGACY Stage 1B1 behavior around an ORDER-BOUND lease
// ---------------------------------------------------------------------------

describe('P18B-W2B1-DB legacy Stage 1B1 behavior', () => {
  it('UNBOUND consume -> release is unchanged (no binding written, lease COMPLETED, fence IDLE)', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const consumed = await practical().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate, leaseId: `${accountId}-unbound`, action: 'CANCEL', trustedNowMs: NOW });
    if (consumed.kind !== 'LEASED') throw new Error(consumed.kind);
    expect(consumed.lease).toMatchObject({ orderBinding: null, armedAtMs: null });
    const released = await practical().releaseLease({ accountId, expected: expectationOf(consumed.account), leaseId: `${accountId}-unbound`, outcome: 'PRE_DISPATCH_FAILURE', nowMs: NOW + 10 });
    expect(released).toMatchObject({ state: 'QUARANTINED', fence: { mode: { kind: 'IDLE' } } });
    const lease = (await practicalRows(accountId)).leases[0]!;
    expect(lease).toMatchObject({ status: 'COMPLETED', intentId: null, clientOrderId: null, cancelGeneration: null, armedAtMs: null, outcome: 'PRE_DISPATCH_FAILURE' });
  });

  it('releaseLease refuses an ORDER-BOUND lease, unarmed or armed, for every outcome, with zero change', async () => {
    if (skip()) return;
    const unarmed = await acquired();
    const armed = await acquired();
    await store().armCancelLease(armInput(armed.accountId, armed.handle));
    for (const target of [unarmed, armed]) {
      const snapshot = await practicalRows(target.accountId);
      const orderBefore = await orderClaimColumns(target.order.intentId);
      const load = await practical().loadAccount(target.accountId);
      if (load.kind !== 'FOUND') throw new Error(load.kind);
      for (const outcome of ['ACCEPTED', 'REJECTED', 'AMBIGUOUS', 'DUPLICATE_CLIENT_ORDER_ID', 'PRE_DISPATCH_FAILURE'] as const) {
        await expect(practical().releaseLease({ accountId: target.accountId, expected: expectationOf(load.account), leaseId: snapshot.leases[0]!.leaseId, outcome, nowMs: ARM_AT + 10 }), outcome)
          .rejects.toThrow(/order-bound \(Stage 1B2\) lease is completed only by the Stage 1B2 completion path/);
      }
      expect(await practicalRows(target.accountId)).toEqual(snapshot);
      expect(await orderClaimColumns(target.order.intentId)).toEqual(orderBefore);
    }
  });

  it('revokeCertificate and expireCertificate refuse the CONSUMED bound certificate (never resurrected or re-revoked)', async () => {
    if (skip()) return;
    const { accountId, handle } = await acquired();
    const certificateId = PracticalAcquiredCancel.read(handle)!.certificate.certificateId;
    const snapshot = await practicalRows(accountId);
    await expect(practical().revokeCertificate({ accountId, certificateId, reason: 'PREFLIGHT_MISMATCH', nowMs: NOW + 5 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_CERTIFICATE_UNUSABLE/);
    await expect(practical().expireCertificate({ accountId, certificateId, trustedNowMs: T0 + 200_000 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_CERTIFICATE_UNUSABLE/);
    expect(await practicalRows(accountId)).toEqual(snapshot);
  });

  it('invalidate / enterManualReview move the safety state while the MUTATION_LEASED fence and the bound lease stay held; the arm is then refused', async () => {
    if (skip()) return;
    for (const [operation, expectedState] of [['invalidate', 'QUARANTINED'], ['enterManualReview', 'MANUAL_REVIEW_REQUIRED']] as const) {
      const { accountId, order, handle } = await acquired();
      const before = await practicalRows(accountId);
      const orderBefore = await orderClaimColumns(order.intentId);
      if (operation === 'invalidate') await practical().invalidate({ accountId, reason: 'WS_DISCONNECTED', nowMs: NOW + 5 });
      else await practical().enterManualReview({ accountId, reason: 'ORPHAN_ORDER', nowMs: NOW + 5 });
      const after = await practicalRows(accountId);
      expect(after.state).toMatchObject({ state: expectedState });
      expect(after.fence).toEqual(before.fence);
      expect(after.leases).toEqual(before.leases);
      expect(after.certificates).toEqual(before.certificates);
      expect(await orderClaimColumns(order.intentId)).toEqual(orderBefore);
      await expect(store().armCancelLease(armInput(accountId, handle))).rejects.toThrow(/not MUTATING/);
    }
  });

  it('adoptForNewRuntime and startCertification are blocked by the leased fence', async () => {
    if (skip()) return;
    const { accountId } = await acquired();
    const load = await practical().loadAccount(accountId);
    if (load.kind !== 'FOUND') throw new Error(load.kind);
    await expect(practical().adoptForNewRuntime({ accountId, previousRuntimeEpoch: EPOCH, expectedFenceRevision: load.account.fence.revision, newRuntimeEpoch: 'epoch-next', nowMs: NOW + 5 }))
      .rejects.toThrow(/PRACTICAL_FENCE_CONFLICT/);
    const quarantined = await practical().invalidate({ accountId, reason: 'WS_DISCONNECTED', nowMs: NOW + 6 });
    await expect(practical().startCertification({ accountId, expected: expectationOf(quarantined.account), runId: 'run-again', nowMs: NOW + 7 }))
      .rejects.toThrow(/PRACTICAL_FENCE_CONFLICT/);
  });

  it('the public strict Tier-A claim still refuses without genuine strict authority (Tier A untouched)', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await certified(accountId);
    const order = await seedOrder(accountId);
    await expect(new PrismaLiveExecutionRepository(connectionA).claimCancel(order.intentId, accountId)).rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED' });
    expect((await orderRow(order.intentId)).cancelState).toBe('NONE');
  });
});
