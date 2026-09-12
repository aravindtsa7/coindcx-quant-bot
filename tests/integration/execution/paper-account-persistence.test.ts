import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RiskAdmissionCoordinator } from '../../../src/dispatch/admission';
import type { AdmissionRequest } from '../../../src/dispatch';
import { PaperAccountOwnership } from '../../../src/execution/persistence/account-ownership';
import { PaperAccountRepository } from '../../../src/execution/persistence/account-repository';
// [P14-D MAJ-01 correction] `PaperAdmissionBridge`/`SESSION_PROOF` are internal
// collaborators (not exported from the persistence barrel) — used directly
// here ONLY in the one test that explicitly proves the underlying DB-level
// fencing/locking invariant itself (see that test's own comment). Every
// production-path test below goes through `openPaperAccountSession`, exactly
// as a real caller must.
import { PaperAdmissionBridge, SESSION_PROOF } from '../../../src/execution/persistence/admission-bridge';
import { openPaperAccountSession } from '../../../src/execution/persistence/paper-account-session';
import { restoreAccountAdmissionState } from '../../../src/execution/persistence/restore';
import { buildContext, evaluateDecision, makeKernel, policyFor } from '../../unit/dispatch/helpers';

// P14-D concurrency/locking invariants cannot be proven by mocked Prisma alone
// (§41) — this suite creates and destroys its own throwaway MySQL database on
// the same server named by `DATABASE_URL`, never touching the real configured
// database (which may hold real accumulated dev data — confirmed distinct:
// this suite's tables live under a randomly-suffixed database name created
// and dropped entirely within this file). Mirrors the repository's own
// existing "tolerate a missing local DB" convention
// (`tests/integration/health.test.ts` accepts either 200 or 503 depending on
// local MySQL availability) — every test here is skipped, not failed, if no
// MySQL server is reachable or `mysql`/`npx prisma` are unavailable.

const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = `p14d_test_${randomBytes(6).toString('hex')}`;

function mysqlArgs(extra: readonly string[]): string[] {
  const url = new URL(BASE_DATABASE_URL!);
  const args = ['-h', url.hostname, '-P', url.port || '3306', '-u', decodeURIComponent(url.username)];
  if (url.password) args.push(`-p${decodeURIComponent(url.password)}`);
  return [...args, ...extra];
}

function shadowDatabaseUrl(): string {
  const url = new URL(BASE_DATABASE_URL!);
  url.pathname = `/${SHADOW_DB_NAME}`;
  return url.toString();
}

let dbAvailable = false;
let prisma: PrismaClient;

beforeAll(async () => {
  if (!BASE_DATABASE_URL) { dbAvailable = false; return; }
  try {
    execFileSync('mysql', mysqlArgs(['-e', `CREATE DATABASE \`${SHADOW_DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
    // `npx` resolves to `npx.cmd` on Windows, which `execFileSync` cannot
    // spawn directly (no shell association) — `shell: true` is required
    // there. Every argument here is a fixed literal (never external/user
    // input), so the shell-argument-escaping caveat this option carries does
    // not apply.
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      stdio: 'pipe', timeout: 60_000, shell: true, env: { ...process.env, DATABASE_URL: shadowDatabaseUrl() },
    });
    prisma = new PrismaClient({ datasources: { db: { url: shadowDatabaseUrl() } } });
    await prisma.$queryRawUnsafe('SELECT 1');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
}, 90_000);

afterAll(async () => {
  if (!dbAvailable) return;
  await prisma.$disconnect();
  try {
    execFileSync('mysql', mysqlArgs(['-e', `DROP DATABASE IF EXISTS \`${SHADOW_DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
  } catch { /* best-effort cleanup only */ }
}, 30_000);

function skip(): boolean {
  if (!dbAvailable) {
    console.warn('P14-D live-DB suite skipped: no reachable disposable MySQL environment (see beforeAll).');
  }
  return !dbAvailable;
}

let accountCounter = 0;
function freshAccountId(): string { accountCounter += 1; return `p14d-account-${accountCounter}`; }

async function initAccount(repository: PaperAccountRepository, accountId: string, capital = '100000'): Promise<void> {
  await repository.ensureAccountInitialized(accountId, capital);
}

async function provisionPairSlot(accountId: string, pair: string): Promise<void> {
  await prisma.paperPosition.create({ data: { accountId, pair, status: 'EMPTY' } });
}

async function buildRequest(accountId: string, pair: string, evaluationTimeMs: number): Promise<AdmissionRequest> {
  const kernel = makeKernel(pair);
  const decision = evaluateDecision(kernel, evaluationTimeMs);
  return { accountId, policy: policyFor(pair), context: buildContext(kernel, decision) };
}

describe('P14-D live-DB — account ownership and monotonic fencing', () => {
  it('first owner acquisition succeeds with fence 1', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const accountId = freshAccountId();
    await initAccount(repository, accountId);
    const ownership = await repository.acquireOwnership(accountId);
    expect(PaperAccountOwnership.read(ownership)?.fence).toBe(1n);
  });

  it('a second acquisition increments the fence monotonically', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const accountId = freshAccountId();
    await initAccount(repository, accountId);
    const first = await repository.acquireOwnership(accountId);
    const second = await repository.acquireOwnership(accountId);
    expect(PaperAccountOwnership.read(first)?.fence).toBe(1n);
    expect(PaperAccountOwnership.read(second)?.fence).toBe(2n);
  });

  it('a stale fence cannot load a coherent snapshot after a takeover', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const accountId = freshAccountId();
    await initAccount(repository, accountId);
    const staleOwnership = await repository.acquireOwnership(accountId);
    await repository.acquireOwnership(accountId); // takeover
    await expect(repository.loadCoherentSnapshot(staleOwnership)).rejects.toMatchObject({ code: 'STALE_FENCE' });
  });

  it('release semantics: a released ownership can no longer be used to load a snapshot', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const accountId = freshAccountId();
    await initAccount(repository, accountId);
    const ownership = await repository.acquireOwnership(accountId);
    repository.releaseOwnership(ownership);
    await expect(repository.loadCoherentSnapshot(ownership)).rejects.toMatchObject({ code: 'NOT_OWNER' });
  });

  it('restart does not reset the fence — a fresh repository instance continues from the persisted value', async () => {
    if (skip()) return;
    const accountId = freshAccountId();
    await initAccount(new PaperAccountRepository(prisma), accountId);
    await new PaperAccountRepository(prisma).acquireOwnership(accountId); // fence -> 1
    await new PaperAccountRepository(prisma).acquireOwnership(accountId); // fence -> 2, simulating a new process
    const thirdOwnership = await new PaperAccountRepository(prisma).acquireOwnership(accountId);
    expect(PaperAccountOwnership.read(thirdOwnership)?.fence).toBe(3n);
  });

  it('two accounts have fully isolated fence sequences — acquiring one never affects the other', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const accountA = freshAccountId();
    const accountB = freshAccountId();
    await initAccount(repository, accountA);
    await initAccount(repository, accountB);
    await repository.acquireOwnership(accountA);
    await repository.acquireOwnership(accountA);
    const ownershipB = await repository.acquireOwnership(accountB);
    expect(PaperAccountOwnership.read(ownershipB)?.fence).toBe(1n);
  });

  it('does not serialize unrelated accounts — concurrent acquisitions for A and B both complete promptly', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const accountA = freshAccountId();
    const accountB = freshAccountId();
    await initAccount(repository, accountA);
    await initAccount(repository, accountB);
    const start = Date.now();
    await Promise.all([repository.acquireOwnership(accountA), repository.acquireOwnership(accountB)]);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('rejects acquisition for an account that was never initialized', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    await expect(repository.acquireOwnership('never-initialized-account')).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });
});

describe('P14-D live-DB — coherent account snapshot', () => {
  it('binds account, reservations, and pair slots to one coherent fence/revision', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const accountId = freshAccountId();
    const pair = 'B-BTC_USDT';
    await initAccount(repository, accountId);
    await provisionPairSlot(accountId, pair);
    const ownership = await repository.acquireOwnership(accountId);
    const snapshot = await repository.loadCoherentSnapshot(ownership);
    expect(snapshot.accountId).toBe(accountId);
    expect(snapshot.fence).toBe(1n);
    expect(snapshot.admittedReservations).toEqual([]);
    expect(snapshot.pairSlots).toHaveLength(1);
    expect(snapshot.pairSlots[0]?.status).toBe('EMPTY');
  });

  it('returns a frozen (immutable) snapshot object', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const accountId = freshAccountId();
    await initAccount(repository, accountId);
    const ownership = await repository.acquireOwnership(accountId);
    const snapshot = await repository.loadCoherentSnapshot(ownership);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.pairSlots)).toBe(true);
  });
});

describe('P14-D live-DB — pair slot claim and contention', () => {
  it('a genuine admission claims an EMPTY slot and transitions it to PENDING', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const coordinator = new RiskAdmissionCoordinator();
    const accountId = freshAccountId();
    const pair = 'B-BTC_USDT';
    await initAccount(repository, accountId);
    await provisionPairSlot(accountId, pair);
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const request = await buildRequest(accountId, pair, 1_200_000);
    const result = await session.admitAndPersist(pair, request, coordinator);
    expect(result.outcome).toBe('ADMITTED');
    const slot = await prisma.paperPosition.findUnique({ where: { accountId_pair: { accountId, pair } } });
    expect(slot?.status).toBe('PENDING');
    expect(slot?.admissionId).toBe(result.outcome === 'ADMITTED' ? result.admission.admissionId : null);
  });

  it('fails closed when no pair slot has been pre-provisioned', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const coordinator = new RiskAdmissionCoordinator();
    const accountId = freshAccountId();
    const pair = 'B-BTC_USDT';
    await initAccount(repository, accountId);
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const request = await buildRequest(accountId, pair, 1_200_000);
    await expect(session.admitAndPersist(pair, request, coordinator)).rejects.toMatchObject({ code: 'PAIR_SLOT_UNAVAILABLE' });
  });

  it('a losing pair-slot contender creates no reservation row', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const coordinator = new RiskAdmissionCoordinator();
    const accountId = freshAccountId();
    const pair = 'B-BTC_USDT';
    await initAccount(repository, accountId);
    await provisionPairSlot(accountId, pair);

    // One production session handles both attempts sequentially, exactly as a
    // real long-lived account session would receive two different strategy
    // decisions over time (P14-D MAJ-01 correction: a session is opened once
    // and reused, never re-opened per attempt against a still-live account).
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const winnerRequest = await buildRequest(accountId, pair, 1_200_000);
    const winnerResult = await session.admitAndPersist(pair, winnerRequest, coordinator);
    expect(winnerResult.outcome).toBe('ADMITTED');

    // A genuinely different source decision (different evaluation time -> different decisionSequence/decisionId) contending for the same pair.
    const loserRequest = await buildRequest(accountId, pair, 1_260_000);
    const loserResult = await session.admitAndPersist(pair, loserRequest, coordinator);
    expect(loserResult.outcome).toBe('PAIR_SLOT_UNAVAILABLE');

    const reservationCount = await prisma.paperReservation.count({ where: { accountId } });
    expect(reservationCount).toBe(1);
  });

  it('a self-retry of the exact same source decision against an already-PENDING slot is recognized, not rejected', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const coordinator = new RiskAdmissionCoordinator();
    const accountId = freshAccountId();
    const pair = 'B-BTC_USDT';
    await initAccount(repository, accountId);
    await provisionPairSlot(accountId, pair);

    const kernel = makeKernel(pair);
    const decision = evaluateDecision(kernel, 1_200_000);
    const request: AdmissionRequest = { accountId, policy: policyFor(pair), context: buildContext(kernel, decision) };

    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const first = await session.admitAndPersist(pair, request, coordinator);
    expect(first.outcome).toBe('ADMITTED');

    const second = await session.admitAndPersist(pair, request, coordinator);
    expect(second.outcome).toBe('ADMITTED');
    if (first.outcome === 'ADMITTED' && second.outcome === 'ADMITTED') {
      expect(second.admission.admissionId).toBe(first.admission.admissionId);
    }
    expect(await prisma.paperReservation.count({ where: { accountId } })).toBe(1);
  });
});

describe('P14-D live-DB — durable admission generation semantics', () => {
  it('a fresh generation is persistable after a genuine release', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const coordinator = new RiskAdmissionCoordinator();
    const accountId = freshAccountId();
    const pair = 'B-BTC_USDT';
    await initAccount(repository, accountId);
    await provisionPairSlot(accountId, pair);

    const kernel = makeKernel(pair);
    const decision = evaluateDecision(kernel, 1_200_000);
    const request: AdmissionRequest = { accountId, policy: policyFor(pair), context: buildContext(kernel, decision) };

    // One production session, reused across open -> release -> reopen, exactly
    // as the account's real lifetime would proceed within one running process.
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const first = await session.admitAndPersist(pair, request, coordinator);
    expect(first.outcome).toBe('ADMITTED');
    if (first.outcome !== 'ADMITTED') return;
    expect(first.admission.generation).toBe(1);

    const released = await session.releaseAndPersist(first.admission.admissionId, coordinator);
    expect(released).toBe('RELEASED');

    const second = await session.admitAndPersist(pair, request, coordinator);
    expect(second.outcome).toBe('ADMITTED');
    if (second.outcome !== 'ADMITTED') return;
    expect(second.admission.generation).toBe(2);
    expect(second.admission.admissionId).not.toBe(first.admission.admissionId);

    const rows = await prisma.paperReservation.findMany({ where: { accountId }, orderBy: { generation: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe('RELEASED');
    expect(rows[1]?.status).toBe('ADMITTED');
  });

  it('a source decision with an existing terminal PaperFill blocks any new admission attempt', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const coordinator = new RiskAdmissionCoordinator();
    const accountId = freshAccountId();
    const pair = 'B-BTC_USDT';
    await initAccount(repository, accountId);
    await provisionPairSlot(accountId, pair);

    const kernel = makeKernel(pair);
    const decision = evaluateDecision(kernel, 1_200_000);
    // Seed a terminal fill fact directly (test setup only — P14-D never
    // creates PaperExecutionIntent/PaperOrder/PaperFill rows itself; this
    // satisfies PaperFill's real FK chain purely to prove the V2.3 terminal
    // pre-check reads it correctly).
    await prisma.paperExecutionPolicySnapshot.create({
      data: {
        executionPolicySnapshotId: 'p'.repeat(64), policyVersion: 'P14_EXECUTION_POLICY_V1', fillSelectionPolicy: 'MARKET_EQUIVALENT_ALL_OR_NONE_V1',
        maxEvidenceAgeMs: 5000, requiredHealthState: 'HEALTHY', takerFeeRate: '0.001', slippageBps: '5', spreadSemantics: 'BID_ASK_DIRECT',
        tickRoundingPolicy: 'BUY_CEIL_SELL_FLOOR_V1', quantityPolicy: 'REJECT_NOT_RESIZE_V1', contractMultiplier: '0.001',
        currencyConversionPolicy: 'P14_INR_CONVERSION_V1', accountingPolicy: 'P14_INR_CASH_SETTLED_V1', executionSemanticsVersion: 'P14_EXECUTION_V1',
      },
    });
    await prisma.paperExecutionIntent.create({
      data: {
        executionIntentId: 'i'.repeat(64), action: 'OPEN', accountId, pair, strategyInstanceId: decision.strategyInstanceId,
        strategyId: decision.strategyId, strategyVersion: decision.strategyVersion, parameterHash: decision.parameterHash,
        riskDecisionId: 'r'.repeat(64), evaluationTimeMs: 1_200_000, executionPolicySnapshotId: 'p'.repeat(64),
      },
    });
    await prisma.paperOrder.create({ data: { executionIntentId: 'i'.repeat(64), accountId, action: 'OPEN', state: 'FILLED' } });
    await prisma.paperFill.create({
      data: {
        orderId: 'i'.repeat(64), accountId, sourceStrategyDecisionId: decision.decisionId, sourceExecutionKey: 'y'.repeat(64),
        pair, action: 'OPEN', side: 'BUY', fillPrice: '100', quantity: '1', feeInr: '0.1',
        quoteSnapshotContentSha256: 'z'.repeat(64), eventTimeMs: 1_200_000,
      },
    });

    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const request: AdmissionRequest = { accountId, policy: policyFor(pair), context: buildContext(kernel, decision) };
    const result = await session.admitAndPersist(pair, request, coordinator);
    expect(result.outcome).toBe('SOURCE_DECISION_ALREADY_EXECUTED');
    expect(await prisma.paperReservation.count({ where: { accountId } })).toBe(0);
  });
});

describe('P14-D live-DB — restart / C3 restore', () => {
  it('a durable ADMITTED reservation survives a fresh RiskAdmissionCoordinator and is restored before new admissions', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const firstProcessCoordinator = new RiskAdmissionCoordinator();
    const accountId = freshAccountId();
    const pair = 'B-BTC_USDT';
    await initAccount(repository, accountId);
    await provisionPairSlot(accountId, pair);

    const kernel = makeKernel(pair);
    const decision = evaluateDecision(kernel, 1_200_000);
    const request: AdmissionRequest = { accountId, policy: policyFor(pair), context: buildContext(kernel, decision) };

    const session1 = await openPaperAccountSession({ accountId, coordinator: firstProcessCoordinator, prisma });
    const admitted = await session1.admitAndPersist(pair, request, firstProcessCoordinator);
    expect(admitted.outcome).toBe('ADMITTED');

    // Simulate a full process restart: brand new coordinator, brand new session
    // (§17: openPaperAccountSession completes restore first, then admission succeeds).
    const secondProcessCoordinator = new RiskAdmissionCoordinator();
    const session2 = await openPaperAccountSession({ accountId, coordinator: secondProcessCoordinator, prisma });
    expect(session2.restoreResult.restoredReservationCount).toBe(1);

    // The same genuine decision resubmitted post-restart resolves idempotently via the self-healing reconfirmation path.
    const resubmitted = await session2.admitAndPersist(pair, request, secondProcessCoordinator);
    expect(resubmitted.outcome).toBe('ADMITTED');
    if (admitted.outcome === 'ADMITTED' && resubmitted.outcome === 'ADMITTED') {
      expect(resubmitted.admission.admissionId).toBe(admitted.admission.admissionId);
    }
    expect(await prisma.paperReservation.count({ where: { accountId } })).toBe(1);
  });

  it('duplicate restore invocation for the same fresh coordinator is rejected, not silently double-counted', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const coordinator = new RiskAdmissionCoordinator();
    const accountId = freshAccountId();
    const pair = 'B-BTC_USDT';
    await initAccount(repository, accountId);
    await provisionPairSlot(accountId, pair);
    const request = await buildRequest(accountId, pair, 1_200_000);
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    await session.admitAndPersist(pair, request, coordinator);

    const restoreCoordinator = new RiskAdmissionCoordinator();
    const ownership2 = await repository.acquireOwnership(accountId);
    await restoreAccountAdmissionState(ownership2, restoreCoordinator, prisma);
    await expect(restoreAccountAdmissionState(ownership2, restoreCoordinator, prisma)).rejects.toMatchObject({ code: 'DURABLE_CONFLICT' });
  });

  it('restore is account-isolated — restoring account A never touches account B state', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const coordinator = new RiskAdmissionCoordinator();
    const accountA = freshAccountId();
    const accountB = freshAccountId();
    const pair = 'B-BTC_USDT';
    await initAccount(repository, accountA);
    await initAccount(repository, accountB);
    await provisionPairSlot(accountA, pair);
    await provisionPairSlot(accountB, pair);

    const requestA = await buildRequest(accountA, pair, 1_200_000);
    const sessionA = await openPaperAccountSession({ accountId: accountA, coordinator, prisma });
    await sessionA.admitAndPersist(pair, requestA, coordinator);

    const freshCoordinator = new RiskAdmissionCoordinator();
    const ownershipA2 = await repository.acquireOwnership(accountA);
    const restoreA = await restoreAccountAdmissionState(ownershipA2, freshCoordinator, prisma);
    expect(restoreA.restoredReservationCount).toBe(1);

    const ownershipB = await repository.acquireOwnership(accountB);
    const restoreB = await restoreAccountAdmissionState(ownershipB, freshCoordinator, prisma);
    expect(restoreB.restoredReservationCount).toBe(0);
  });

  it('DB restore failure (stale fence) leaves the account not-ready — no in-memory state is committed', async () => {
    if (skip()) return;
    const repository = new PaperAccountRepository(prisma);
    const coordinator = new RiskAdmissionCoordinator();
    const accountId = freshAccountId();
    await initAccount(repository, accountId);
    const staleOwnership = await repository.acquireOwnership(accountId);
    await repository.acquireOwnership(accountId); // takeover invalidates staleOwnership's fence
    await expect(restoreAccountAdmissionState(staleOwnership, coordinator, prisma)).rejects.toMatchObject({ code: 'STALE_FENCE' });
  });
});

describe('P14-D live-DB — same-account operation serialization', () => {
  it('two concurrent account operations (each its own acquire-then-admit cycle) for the same account/pair resolve with exactly one winner and no lost update', async () => {
    if (skip()) return;
    // This test drives `PaperAdmissionBridge` directly (with the genuine,
    // internal `SESSION_PROOF` token) rather than through one
    // `PaperAccountSession`, because it specifically proves the underlying
    // DB-level fencing/locking invariant that the single-session production
    // model relies on: two independent, concurrently-racing fence owners for
    // the same account can never both durably mutate it. A real production
    // caller never does this (it opens exactly one session per account and
    // reuses it — see every other describe block in this file); this is a
    // deliberate internal-level test of the primitive itself (P14-D MAJ-01
    // correction §16: "keep lower-level bridge tests only if bridge remains
    // internal and they are explicitly testing internals").
    const repository = new PaperAccountRepository(prisma);
    const bridge = new PaperAdmissionBridge(prisma);
    const coordinator = new RiskAdmissionCoordinator();
    const accountId = freshAccountId();
    const pair = 'B-BTC_USDT';
    await initAccount(repository, accountId);
    await provisionPairSlot(accountId, pair);

    const requestA = await buildRequest(accountId, pair, 1_200_000);
    const requestB = await buildRequest(accountId, pair, 1_260_000);

    // Each racer performs its own acquire-then-use cycle, exactly as a real
    // caller would (V2 §16 treats acquire+mutate+release as one atomic
    // "account operation" per caller, never a pre-acquired ownership handed
    // between callers). Two such cycles racing concurrently may legitimately
    // resolve one side via a thrown STALE_FENCE (a later concurrent
    // acquisition superseded it before its own mutation ran) rather than a
    // normal outcome value — both are safe, fail-closed results, so
    // `allSettled` is used rather than assuming every racer resolves.
    const racer = (request: AdmissionRequest) => (async () => {
      const ownership = await repository.acquireOwnership(accountId);
      return bridge.admitAndPersist(SESSION_PROOF, ownership, pair, request, coordinator);
    })();

    const settled = await Promise.allSettled([racer(requestA), racer(requestB)]);
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toMatchObject({ code: 'STALE_FENCE' });
      }
    }
    const admittedCount = settled.filter((s) => s.status === 'fulfilled' && s.value.outcome === 'ADMITTED').length;
    expect(admittedCount).toBeLessThanOrEqual(1);
    const reservationCount = await prisma.paperReservation.count({ where: { accountId } });
    expect(reservationCount).toBe(admittedCount);
  });
});
