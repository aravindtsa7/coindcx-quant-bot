import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { URL } from 'node:url';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issuePracticalRecoveryCertificate, PracticalRecoveryCertificate } from '../../../src/execution/live/practical/certificate';
import { classifyPracticalInvalidation } from '../../../src/execution/live/practical/invalidation';
import { issuePracticalLiveSafetyEnablement } from '../../../src/execution/live/practical/policy';
import { PRACTICAL_INVALIDATION_REASONS } from '../../../src/execution/live/practical/types';
import { mintPracticalManualReviewResolution, transitionPracticalAccountState } from '../../../src/execution/live/practical/state-machine';
import type { PracticalAccountSnapshot } from '../../../src/execution/live/practical-persistence/ports';
import { PrismaPracticalSafetyRepository } from '../../../src/execution/live/practical-persistence/repository';
import { practicalStartupStateFromLoad } from '../../../src/execution/live/practical-persistence/rows';
import { providerAccountFingerprint } from '../../../src/execution/live/reconciliation/account-identity';

// [P18B-1B1-DB] Real MySQL proof of the Phase 18B Stage 1B1 durable
// invariants, over two INDEPENDENT connections (not two Promises sharing one
// client, and not a mocked client): fence compare-and-set, the durable
// one-shot certificate, the single mutation lease, all-or-nothing rollback,
// manual-review episode binding, and fail-closed reads of malformed rows.
//
// NOTHING HERE TOUCHES COINDCX. There is no gateway, no transport, no signer,
// and no network call. A "lease" here is durable bookkeeping only.
//
// ACCEPTANCE SEMANTICS (the Phase 17/18 convention): by default this suite
// soft-skips when no local MySQL is reachable. For real acceptance set
// REQUIRE_LIVE_PRACTICAL_DB_INTEGRATION=1 (or run
// `npm run test:integration:live-practical`), under which `beforeAll` THROWS
// rather than skipping, so a false green is impossible.

const REPO_ROOT = path.resolve(__dirname, '../../..');
const STRICT = process.env['REQUIRE_LIVE_PRACTICAL_DB_INTEGRATION'] === '1';
const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = `p18b_practical_test_${randomBytes(6).toString('hex')}`;

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
let connectionA: PrismaClient;
let connectionB: PrismaClient;

beforeAll(async () => {
  if (!BASE_DATABASE_URL) {
    if (STRICT) throw new Error('[P18B-DB-INTEGRATION] REQUIRE_LIVE_PRACTICAL_DB_INTEGRATION=1 but no DATABASE_URL is configured.');
    return;
  }
  try {
    execFileSync('mysql', mysqlArgs(['-e', `CREATE DATABASE \`${SHADOW_DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: REPO_ROOT, stdio: 'pipe', timeout: 120_000, shell: true, env: { ...process.env, DATABASE_URL: shadowDatabaseUrl() },
    });
    connectionA = new PrismaClient({ datasources: { db: { url: shadowDatabaseUrl() } } });
    connectionB = new PrismaClient({ datasources: { db: { url: shadowDatabaseUrl() } } });
    await connectionA.$queryRawUnsafe('SELECT 1');
    await connectionB.$queryRawUnsafe('SELECT 1');
    dbAvailable = true;
  } catch (error) {
    dbAvailable = false;
    if (STRICT) throw new Error(`[P18B-DB-INTEGRATION] strict mode could not provision a disposable MySQL shadow database: ${(error as Error).message}`);
  }
}, 180_000);

afterAll(async () => {
  if (!dbAvailable) return;
  await connectionA.$disconnect();
  await connectionB.$disconnect();
  try {
    execFileSync('mysql', mysqlArgs(['-e', `DROP DATABASE IF EXISTS \`${SHADOW_DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
  } catch { /* best-effort cleanup only */ }
}, 30_000);

function skip(): boolean {
  if (dbAvailable) return false;
  if (STRICT) throw new Error('[P18B-DB-INTEGRATION] strict mode reached a test body with no database connection.');
  console.warn('P18B practical persistence DB suite skipped: no reachable disposable MySQL. Set REQUIRE_LIVE_PRACTICAL_DB_INTEGRATION=1 to make this hard.');
  return true;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EPOCH = 'runtime-epoch-a';
const EPOCH_B = 'runtime-epoch-b';
const T0 = 1_000_000;
const LIFETIME = 120_000;
const FINGERPRINT = providerAccountFingerprint('fake-coindcx-trading-account-p18b');

let accountCounter = 0;
function freshAccount(): string {
  accountCounter += 1;
  return `p18b-acct-${accountCounter}-${randomBytes(4).toString('hex')}`;
}

/** Lease ids are a global primary key: scope every fixture lease id to its account. */
function lid(accountId: string, name: string): string { return `${accountId}-${name}`; }

function repoA(): PrismaPracticalSafetyRepository { return new PrismaPracticalSafetyRepository(connectionA); }
function repoB(): PrismaPracticalSafetyRepository { return new PrismaPracticalSafetyRepository(connectionB); }

function issueCertificate(accountId: string, options: {
  readonly runtimeEpoch?: string;
  readonly generation?: number;
  readonly evidence?: string;
  readonly issuedAtMs?: number;
} = {}): PracticalRecoveryCertificate {
  const resolution = issuePracticalLiveSafetyEnablement({ LIVE_PRACTICAL_SAFETY_ENABLED: 'true', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: accountId });
  if (resolution.status !== 'ENABLED') throw new Error('fixture enablement');
  return issuePracticalRecoveryCertificate({
    enablement: resolution.enablement,
    bindings: {
      accountId,
      providerAccountFingerprint: FINGERPRINT,
      runtimeEpoch: options.runtimeEpoch ?? EPOCH,
      reconciliationGeneration: options.generation ?? 1,
      streamIncarnation: 1,
    },
    evidence: { evidenceDigest: options.evidence ?? 'e'.repeat(64), passCount: 3, certificationSpanMs: 30_000, minimumObservedPassSpacingMs: 10_000 },
    issuedAtMs: options.issuedAtMs ?? T0,
  });
}

function expectationOf(account: PracticalAccountSnapshot) {
  return {
    accountId: account.accountId,
    runtimeEpoch: account.fence.runtimeEpoch,
    reconciliationGeneration: account.fence.reconciliationGeneration,
    revision: account.fence.revision,
  };
}

async function initialized(accountId: string, repository = repoA()): Promise<PracticalAccountSnapshot> {
  const result = await repository.initializeAccount({ accountId, runtimeEpoch: EPOCH, reconciliationGeneration: 0, nowMs: T0 - 50_000 });
  return result.account;
}

/** QUARANTINED -> CERTIFYING -> CERTIFIED_IDLE with a durable ISSUED certificate at generation 1. */
async function certified(accountId: string, repository = repoA()): Promise<{ account: PracticalAccountSnapshot; certificate: PracticalRecoveryCertificate }> {
  const start = await initialized(accountId, repository);
  const certifying = await repository.startCertification({ accountId, expected: expectationOf(start), runId: 'run-1', nowMs: T0 - 40_000 });
  const certificate = issueCertificate(accountId);
  const account = await repository.finishCertification({
    accountId, expected: expectationOf(certifying), runId: 'run-1', resultingGeneration: 1, certificate, nowMs: T0,
  });
  return { account, certificate };
}

async function leased(accountId: string): Promise<{ account: PracticalAccountSnapshot; certificate: PracticalRecoveryCertificate }> {
  const { account, certificate } = await certified(accountId);
  const acquisition = await repoA().consumeCertificateAndLease({
    accountId, expected: expectationOf(account), certificate, leaseId: lid(accountId, 'lease-1'), action: 'CANCEL', trustedNowMs: T0 + 1_000,
  });
  if (acquisition.kind !== 'LEASED') throw new Error('fixture lease');
  return { account: acquisition.account, certificate };
}

async function rawFence(accountId: string) {
  return connectionA.livePracticalAccountFence.findUniqueOrThrow({ where: { accountId } });
}

async function rawState(accountId: string) {
  return connectionA.livePracticalAccountState.findUniqueOrThrow({ where: { accountId } });
}

function settledSummary(results: readonly PromiseSettledResult<unknown>[]): { fulfilled: number; rejected: unknown[] } {
  return {
    fulfilled: results.filter((result) => result.status === 'fulfilled').length,
    rejected: results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason),
  };
}

/** A client whose `model.operation` always fails, for deterministic mid-transaction fault injection. */
function faultyClient(model: 'livePracticalMutationLease' | 'livePracticalAccountFence' | 'livePracticalCertificate' | 'livePracticalMalformedLatch', operation: 'create' | 'updateMany'): PrismaClient {
  return connectionA.$extends({
    query: {
      [model]: {
        [operation]: () => { throw new Error(`injected fault: ${model}.${operation}`); },
      },
    },
  } as never) as unknown as PrismaClient;
}

// ---------------------------------------------------------------------------
// Lifecycle and the trusted-absence rule
// ---------------------------------------------------------------------------

describe('P18B-1B1-DB lifecycle and trusted absence', () => {
  it('an account with no rows is NOT_FOUND, and only NOT_FOUND starts QUARANTINED', async () => {
    if (skip()) return;
    const load = await repoA().loadAccount(freshAccount());
    expect(load).toEqual({ kind: 'NOT_FOUND' });
    expect(practicalStartupStateFromLoad(load)).toBe('QUARANTINED');
    expect(await repoA().loadCertificate('f'.repeat(64))).toEqual({ kind: 'NOT_FOUND' });
    expect(await repoA().loadLease('no-such-lease')).toEqual({ kind: 'NOT_FOUND' });
  });

  it('a read FAILURE is an error, never NOT_FOUND', async () => {
    if (skip()) return;
    const broken = new URL(shadowDatabaseUrl());
    broken.pathname = `/${SHADOW_DB_NAME}_does_not_exist`;
    const unreachable = new PrismaClient({ datasources: { db: { url: broken.toString() } } });
    try {
      await expect(new PrismaPracticalSafetyRepository(unreachable).loadAccount(freshAccount())).rejects.toThrow();
    } finally {
      await unreachable.$disconnect();
    }
  });

  it('initialize creates QUARANTINED + IDLE fence + an OPEN recovery episode, and is idempotent', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const first = await repoA().initializeAccount({ accountId, runtimeEpoch: EPOCH, reconciliationGeneration: 0, nowMs: T0 });
    expect(first.kind).toBe('CREATED');
    expect(first.account).toMatchObject({ state: 'QUARANTINED', stateRevision: 0, fence: { revision: 0, mode: { kind: 'IDLE' }, runtimeEpoch: EPOCH } });
    expect(first.account.currentRecoveryEpisode).toMatchObject({ status: 'OPEN', startCause: 'RUNTIME_STARTUP' });
    const second = await repoB().initializeAccount({ accountId, runtimeEpoch: EPOCH_B, reconciliationGeneration: 9, nowMs: T0 + 1 });
    expect(second.kind).toBe('EXISTING');
    expect(second.account).toEqual(first.account);
  });

  it('two workers initializing the same account concurrently create exactly one set of rows', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const results = await Promise.all([
      repoA().initializeAccount({ accountId, runtimeEpoch: EPOCH, reconciliationGeneration: 0, nowMs: T0 }),
      repoB().initializeAccount({ accountId, runtimeEpoch: EPOCH, reconciliationGeneration: 0, nowMs: T0 }),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['CREATED', 'EXISTING']);
    expect(await connectionA.livePracticalAccountState.count({ where: { accountId } })).toBe(1);
    expect(await connectionA.livePracticalRecoveryEpisode.count({ where: { accountId } })).toBe(1);
  });

  it('certify -> consume -> release runs end to end with every durable record consistent', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    expect(account).toMatchObject({ state: 'CERTIFIED_IDLE', fence: { mode: { kind: 'IDLE' }, reconciliationGeneration: 1, revision: 2 } });
    expect(account.currentCertificate).toMatchObject({ certificateId: certificate.certificateId, status: 'ISSUED', providerAccountFingerprint: FINGERPRINT });
    const certifiedEpisode = await connectionA.livePracticalRecoveryEpisode.findFirstOrThrow({ where: { accountId, status: 'CERTIFIED' } });
    expect(certifiedEpisode.certifiedCertificateId).toBe(certificate.certificateId);

    const acquisition = await repoA().consumeCertificateAndLease({
      accountId, expected: expectationOf(account), certificate, leaseId: lid(accountId, 'lease-e2e'), action: 'CANCEL', trustedNowMs: T0 + 1_000,
    });
    if (acquisition.kind !== 'LEASED') throw new Error('expected LEASED');
    expect(acquisition.certificate.status).toBe('CONSUMED');
    expect(acquisition.lease).toMatchObject({ leaseId: lid(accountId, 'lease-e2e'), status: 'LEASED', action: 'CANCEL', outcome: null, reconciliationGeneration: 1 });
    expect(acquisition.account).toMatchObject({ state: 'MUTATING', fence: { revision: 3, mode: { kind: 'MUTATION_LEASED', leaseId: lid(accountId, 'lease-e2e'), certificateId: certificate.certificateId } } });
    const leaseRow = await connectionA.livePracticalMutationLease.findUniqueOrThrow({ where: { leaseId: lid(accountId, 'lease-e2e') } });
    expect(leaseRow.armedAtMs).toBeNull();
    expect(leaseRow.intentId).toBeNull();

    const released = await repoA().releaseLease({ accountId, expected: expectationOf(acquisition.account), leaseId: lid(accountId, 'lease-e2e'), outcome: 'REJECTED', nowMs: T0 + 2_000 });
    expect(released).toMatchObject({ state: 'QUARANTINED', fence: { revision: 4, mode: { kind: 'IDLE' } } });
    expect(released.currentRecoveryEpisode).toMatchObject({ status: 'OPEN', startCause: 'MUTATION_OUTCOME_RECORDED' });
    expect(await repoA().loadLease(lid(accountId, 'lease-e2e'))).toMatchObject({ kind: 'FOUND', record: { status: 'COMPLETED', outcome: 'REJECTED' } });
    // No outcome restores the consumed certificate.
    expect(await repoA().loadCertificate(certificate.certificateId)).toMatchObject({ kind: 'FOUND', record: { status: 'CONSUMED' } });
  });

  it('OPEN and CLOSE are refused at the primitive (Stage 5a is cancel-only)', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    for (const action of ['OPEN', 'CLOSE'] as const) {
      await expect(repoA().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate, leaseId: `l-${action}`, action, trustedNowMs: T0 + 1 }))
        .rejects.toThrow(/PRACTICAL_ACTION_NOT_PERMITTED/);
    }
    expect((await rawFence(accountId)).mode).toBe('IDLE');
  });
});

// ---------------------------------------------------------------------------
// §6 Concurrency (two independent connections)
// ---------------------------------------------------------------------------

describe('P18B-1B1-DB §6 concurrency', () => {
  it('[1] two workers start certification from the same view: exactly one wins', async () => {
    if (skip()) return;
    for (let round = 0; round < 5; round += 1) {
      const accountId = freshAccount();
      const start = await initialized(accountId);
      const summary = settledSummary(await Promise.allSettled([
        repoA().startCertification({ accountId, expected: expectationOf(start), runId: 'run-a', nowMs: T0 }),
        repoB().startCertification({ accountId, expected: expectationOf(start), runId: 'run-b', nowMs: T0 }),
      ]));
      expect(summary.fulfilled).toBe(1);
      expect(String(summary.rejected[0])).toMatch(/PRACTICAL_FENCE_BINDING_MISMATCH|stale compare-and-set/);
      const fence = await rawFence(accountId);
      expect(fence.mode).toBe('CERTIFYING');
      expect(fence.revision).toBe(1n);
      expect(['run-a', 'run-b']).toContain(fence.runId);
    }
  });

  it('[2] certification and a mutation lease never overlap', async () => {
    if (skip()) return;
    // (a) From CERTIFIED_IDLE, racing a new certification against a lease: only the lease is possible.
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const summary = settledSummary(await Promise.allSettled([
      repoA().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate, leaseId: lid(accountId, 'lease-x'), action: 'CANCEL', trustedNowMs: T0 + 1 }),
      repoB().startCertification({ accountId, expected: expectationOf(account), runId: 'run-x', nowMs: T0 + 1 }),
    ]));
    expect(summary.fulfilled).toBe(1);
    expect((await rawFence(accountId)).mode).toBe('MUTATION_LEASED');
    // While leased, certification is refused.
    const leasedLoad = await repoA().loadAccount(accountId);
    if (leasedLoad.kind !== 'FOUND') throw new Error('expected FOUND');
    await expect(repoB().startCertification({ accountId, expected: expectationOf(leasedLoad.account), runId: 'run-y', nowMs: T0 + 2 })).rejects.toThrow();

    // (b) From QUARANTINED with a revoked certificate: only certification is possible, and while
    // CERTIFYING no lease can be taken.
    const other = freshAccount();
    const second = await certified(other);
    const invalidated = await repoA().invalidate({ accountId: other, reason: 'WS_DISCONNECTED', nowMs: T0 + 1 });
    const race = settledSummary(await Promise.allSettled([
      repoA().startCertification({ accountId: other, expected: expectationOf(invalidated.account), runId: 'run-z', nowMs: T0 + 2 }),
      repoB().consumeCertificateAndLease({ accountId: other, expected: expectationOf(invalidated.account), certificate: second.certificate, leaseId: lid(other, 'lease-z'), action: 'CANCEL', trustedNowMs: T0 + 2 }),
    ]));
    expect(race.fulfilled).toBe(1);
    expect((await rawFence(other)).mode).toBe('CERTIFYING');
    expect(await connectionA.livePracticalMutationLease.count({ where: { accountId: other } })).toBe(0);
  });

  it('[3] two workers consume the SAME certificate object: exactly one lease wins, the other finds it CONSUMED', async () => {
    if (skip()) return;
    for (let round = 0; round < 5; round += 1) {
      const accountId = freshAccount();
      const { account, certificate } = await certified(accountId);
      const results = await Promise.allSettled([
        repoA().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate, leaseId: lid(accountId, 'lease-a'), action: 'CANCEL', trustedNowMs: T0 + 1 }),
        repoB().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate, leaseId: lid(accountId, 'lease-b'), action: 'CANCEL', trustedNowMs: T0 + 1 }),
      ]);
      const summary = settledSummary(results);
      expect(summary.fulfilled).toBe(1);
      expect(String(summary.rejected[0])).toMatch(/PRACTICAL_PERSISTENCE_CERTIFICATE_UNUSABLE.*no longer ISSUED/);
      expect(await connectionA.livePracticalMutationLease.count({ where: { accountId } })).toBe(1);
      expect((await connectionA.livePracticalCertificate.findUniqueOrThrow({ where: { certificateId: certificate.certificateId } })).status).toBe('CONSUMED');
    }
  });

  it('[4] the same certificate as two SEPARATE in-memory objects: still exactly one durable lease (the Stage 1A invariant)', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const twin = issueCertificate(accountId); // identical inputs -> identical certificateId, independent in-memory state
    expect(twin).not.toBe(certificate);
    expect(twin.certificateId).toBe(certificate.certificateId);
    const summary = settledSummary(await Promise.allSettled([
      repoA().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate, leaseId: lid(accountId, 'lease-1'), action: 'CANCEL', trustedNowMs: T0 + 1 }),
      repoB().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate: twin, leaseId: lid(accountId, 'lease-2'), action: 'CANCEL', trustedNowMs: T0 + 1 }),
    ]));
    expect(summary.fulfilled).toBe(1);
    expect(await connectionA.livePracticalMutationLease.count({ where: { certificateId: certificate.certificateId } })).toBe(1);
    // In memory both objects still say ISSUED: only the durable row decided.
    expect(PracticalRecoveryCertificate.status(certificate)).toBe('ISSUED');
    expect(PracticalRecoveryCertificate.status(twin)).toBe('ISSUED');
    // Sequential replay of either object is refused too.
    const load = await repoA().loadAccount(accountId);
    if (load.kind !== 'FOUND') throw new Error('expected FOUND');
    await expect(repoA().consumeCertificateAndLease({ accountId, expected: expectationOf(load.account), certificate: twin, leaseId: lid(accountId, 'lease-3'), action: 'CANCEL', trustedNowMs: T0 + 2 }))
      .rejects.toThrow(/no longer ISSUED/);
  });

  it('[5] two DIFFERENT certificates racing for one account fence: at most one lease', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    // A second ISSUED certificate for the same account and bindings, injected directly (not current).
    const rogue = issueCertificate(accountId, { evidence: 'a'.repeat(64) });
    const rogueRecord = PracticalRecoveryCertificate.read(rogue)!;
    await connectionA.livePracticalCertificate.create({ data: {
      certificateId: rogueRecord.certificateId, accountId, providerAccountFingerprint: FINGERPRINT, runtimeEpoch: EPOCH,
      reconciliationGeneration: 1, streamIncarnation: 1, evidenceDigest: rogueRecord.evidenceDigest,
      issuedAtMs: BigInt(rogueRecord.issuedAtMs), expiresAtMs: BigInt(rogueRecord.expiresAtMs), status: 'ISSUED',
    } });
    const summary = settledSummary(await Promise.allSettled([
      repoA().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate, leaseId: lid(accountId, 'lease-1'), action: 'CANCEL', trustedNowMs: T0 + 1 }),
      repoB().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate: rogue, leaseId: lid(accountId, 'lease-2'), action: 'CANCEL', trustedNowMs: T0 + 1 }),
    ]));
    expect(summary.fulfilled).toBeLessThanOrEqual(1);
    expect(await connectionA.livePracticalMutationLease.count({ where: { accountId } })).toBe(1);
    expect((await rawFence(accountId)).certificateId).toBe(certificate.certificateId);
    expect((await connectionA.livePracticalCertificate.findUniqueOrThrow({ where: { certificateId: rogueRecord.certificateId } })).status).toBe('ISSUED');
  });

  it('[6] a stale revision loses with zero durable change', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const before = await rawFence(accountId);
    await expect(repoA().consumeCertificateAndLease({
      accountId, expected: { ...expectationOf(account), revision: account.fence.revision - 1 }, certificate, leaseId: lid(accountId, 'lease-1'), action: 'CANCEL', trustedNowMs: T0 + 1,
    })).rejects.toThrow(/stale compare-and-set/);
    expect(await rawFence(accountId)).toEqual(before);
    expect((await connectionA.livePracticalCertificate.findUniqueOrThrow({ where: { certificateId: certificate.certificateId } })).status).toBe('ISSUED');
  });

  it('[7] a stale runtime epoch loses (and adoption revokes the old epoch\'s certificate)', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const adopted = await repoB().adoptForNewRuntime({ accountId, previousRuntimeEpoch: EPOCH, expectedFenceRevision: account.fence.revision, newRuntimeEpoch: EPOCH_B, nowMs: T0 + 1 });
    expect(adopted).toMatchObject({ state: 'QUARANTINED', fence: { runtimeEpoch: EPOCH_B } });
    expect(await repoA().loadCertificate(certificate.certificateId)).toMatchObject({ record: { status: 'REVOKED', terminalReason: 'RUNTIME_EPOCH_CHANGED' } });
    // The old runtime's view is stale on the epoch.
    await expect(repoA().startCertification({ accountId, expected: { ...expectationOf(adopted), runtimeEpoch: EPOCH }, runId: 'run-old', nowMs: T0 + 2 }))
      .rejects.toThrow(/runtime epoch/);
    await expect(repoA().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate, leaseId: lid(accountId, 'lease-old'), action: 'CANCEL', trustedNowMs: T0 + 2 }))
      .rejects.toThrow(/no longer ISSUED/);
  });

  it('[8] a stale generation loses', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    await expect(repoA().consumeCertificateAndLease({
      accountId, expected: { ...expectationOf(account), reconciliationGeneration: 0 }, certificate, leaseId: lid(accountId, 'lease-1'), action: 'CANCEL', trustedNowMs: T0 + 1,
    })).rejects.toThrow(/reconciliation generation/);
    const start = await initialized(freshAccount());
    const certifying = await repoA().startCertification({ accountId: start.accountId, expected: expectationOf(start), runId: 'run-1', nowMs: T0 });
    // Finishing on the same generation (no new reconciliation run) is refused, leaving CERTIFYING.
    await expect(repoA().finishCertification({
      accountId: start.accountId, expected: expectationOf(certifying), runId: 'run-1', resultingGeneration: 0, certificate: issueCertificate(start.accountId, { generation: 1 }), nowMs: T0,
    })).rejects.toThrow(/strictly after/);
    expect((await rawFence(start.accountId)).mode).toBe('CERTIFYING');
  });

  it('[9] a MAX_SAFE_INTEGER fence revision cannot increment; beyond it the row is MALFORMED', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    await connectionA.$executeRaw`UPDATE live_practical_account_fence SET revision = ${BigInt(Number.MAX_SAFE_INTEGER)} WHERE account_id = ${accountId}`;
    const load = await repoA().loadAccount(accountId);
    if (load.kind !== 'FOUND') throw new Error('expected FOUND');
    await expect(repoA().startCertification({ accountId, expected: expectationOf(load.account), runId: 'run-1', nowMs: T0 }))
      .rejects.toThrow(/revision is exhausted/);
    expect((await rawFence(accountId)).revision).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    await connectionA.$executeRaw`UPDATE live_practical_account_fence SET revision = ${BigInt(Number.MAX_SAFE_INTEGER) + 1n} WHERE account_id = ${accountId}`;
    expect(await repoA().loadAccount(accountId)).toEqual({ kind: 'MALFORMED', problem: 'FENCE_ROW_INVALID', reviewEpisodeId: null });
  });

  it('[10] a fault after certificate consumption but before lease insertion rolls EVERYTHING back', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const faulty = new PrismaPracticalSafetyRepository(faultyClient('livePracticalMutationLease', 'create'));
    await expect(faulty.consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate, leaseId: lid(accountId, 'lease-1'), action: 'CANCEL', trustedNowMs: T0 + 1 }))
      .rejects.toThrow(/injected fault: livePracticalMutationLease\.create/);
    expect((await connectionA.livePracticalCertificate.findUniqueOrThrow({ where: { certificateId: certificate.certificateId } })).status).toBe('ISSUED');
    expect((await rawFence(accountId))).toMatchObject({ mode: 'IDLE', revision: BigInt(account.fence.revision) });
    expect(await connectionA.livePracticalMutationLease.count({ where: { accountId } })).toBe(0);
    expect((await rawState(accountId)).state).toBe('CERTIFIED_IDLE');
    // And the untouched certificate still works exactly once afterwards.
    const acquisition = await repoA().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate, leaseId: lid(accountId, 'lease-1'), action: 'CANCEL', trustedNowMs: T0 + 2 });
    expect(acquisition.kind).toBe('LEASED');
  });

  it('[11] a fault after the certificate insert during certification leaves no certificate and the fence CERTIFYING', async () => {
    if (skip()) return;
    for (const [model, operation] of [['livePracticalAccountFence', 'updateMany'], ['livePracticalCertificate', 'create']] as const) {
      const accountId = freshAccount();
      const start = await initialized(accountId);
      const certifying = await repoA().startCertification({ accountId, expected: expectationOf(start), runId: 'run-1', nowMs: T0 - 1 });
      const certificate = issueCertificate(accountId);
      const faulty = new PrismaPracticalSafetyRepository(faultyClient(model, operation));
      await expect(faulty.finishCertification({ accountId, expected: expectationOf(certifying), runId: 'run-1', resultingGeneration: 1, certificate, nowMs: T0 }))
        .rejects.toThrow(/injected fault/);
      expect(await connectionA.livePracticalCertificate.count({ where: { accountId } })).toBe(0);
      expect(await rawFence(accountId)).toMatchObject({ mode: 'CERTIFYING', runId: 'run-1', revision: 1n });
      expect((await rawState(accountId)).state).toBe('CERTIFYING');
      expect(await connectionA.livePracticalRecoveryEpisode.count({ where: { accountId, status: 'OPEN' } })).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Certificate terminal-state CAS
// ---------------------------------------------------------------------------

describe('P18B-1B1-DB durable certificate terminal CAS', () => {
  it('revoke: ISSUED -> REVOKED once; the same revocation is idempotent; any other is refused; never resurrected', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { certificate } = await certified(accountId);
    const revoked = await repoA().revokeCertificate({ accountId, certificateId: certificate.certificateId, reason: 'PRIVATE_STATE_EVENT', nowMs: T0 + 1 });
    expect(revoked).toMatchObject({ kind: 'TERMINATED', certificate: { status: 'REVOKED', terminalReason: 'PRIVATE_STATE_EVENT' }, account: { state: 'QUARANTINED' } });
    expect(await repoB().revokeCertificate({ accountId, certificateId: certificate.certificateId, reason: 'PRIVATE_STATE_EVENT', nowMs: T0 + 2 }))
      .toMatchObject({ kind: 'ALREADY_TERMINAL' });
    await expect(repoB().revokeCertificate({ accountId, certificateId: certificate.certificateId, reason: 'WS_DISCONNECTED', nowMs: T0 + 2 }))
      .rejects.toThrow(/already terminal/);
    await expect(repoA().expireCertificate({ accountId, certificateId: certificate.certificateId, trustedNowMs: T0 + LIFETIME }))
      .rejects.toThrow(/Only an ISSUED certificate can expire/);
    expect(await repoA().loadCertificate(certificate.certificateId)).toMatchObject({ record: { status: 'REVOKED' } });
  });

  it('two workers revoking and consuming concurrently: exactly one terminal transition wins', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const summary = settledSummary(await Promise.allSettled([
      repoA().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate, leaseId: lid(accountId, 'lease-1'), action: 'CANCEL', trustedNowMs: T0 + 1 }),
      repoB().revokeCertificate({ accountId, certificateId: certificate.certificateId, reason: 'WS_RECONNECTED', nowMs: T0 + 1 }),
    ]));
    expect(summary.fulfilled).toBe(1);
    const row = await connectionA.livePracticalCertificate.findUniqueOrThrow({ where: { certificateId: certificate.certificateId } });
    expect(['CONSUMED', 'REVOKED']).toContain(row.status);
    expect(await connectionA.livePracticalMutationLease.count({ where: { accountId } })).toBe(row.status === 'CONSUMED' ? 1 : 0);
  });

  it('expire: refused before the absolute expiry; ISSUED -> EXPIRED at it; idempotent after', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { certificate } = await certified(accountId);
    await expect(repoA().expireCertificate({ accountId, certificateId: certificate.certificateId, trustedNowMs: T0 + LIFETIME - 1 }))
      .rejects.toThrow(/has not reached its absolute expiry/);
    const expired = await repoA().expireCertificate({ accountId, certificateId: certificate.certificateId, trustedNowMs: T0 + LIFETIME });
    expect(expired).toMatchObject({ kind: 'TERMINATED', certificate: { status: 'EXPIRED', terminalReason: 'CERTIFICATE_EXPIRED' }, account: { state: 'QUARANTINED' } });
    expect(await repoB().expireCertificate({ accountId, certificateId: certificate.certificateId, trustedNowMs: T0 + LIFETIME + 5 })).toMatchObject({ kind: 'ALREADY_TERMINAL' });
  });

  it('consuming at or after expiry durably EXPIRES the certificate; before issuance durably REVOKES it (CLOCK_ANOMALY); no lease either way', async () => {
    if (skip()) return;
    for (const [nowMs, status, reason] of [[T0 + LIFETIME, 'EXPIRED', 'CERTIFICATE_EXPIRED'], [T0 - 1, 'REVOKED', 'CLOCK_ANOMALY']] as const) {
      const accountId = freshAccount();
      const { account, certificate } = await certified(accountId);
      const result = await repoA().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate, leaseId: lid(accountId, 'lease-1'), action: 'CANCEL', trustedNowMs: nowMs });
      expect(result).toMatchObject({ kind: 'CERTIFICATE_TERMINATED', certificate: { status, terminalReason: reason }, account: { state: 'QUARANTINED' } });
      expect(await connectionA.livePracticalMutationLease.count({ where: { accountId } })).toBe(0);
      // A later, valid-looking time cannot bring it back.
      const load = await repoA().loadAccount(accountId);
      if (load.kind !== 'FOUND') throw new Error('expected FOUND');
      await expect(repoA().consumeCertificateAndLease({ accountId, expected: expectationOf(load.account), certificate, leaseId: lid(accountId, 'lease-2'), action: 'CANCEL', trustedNowMs: T0 + 5 }))
        .rejects.toThrow(/no longer ISSUED/);
    }
  });

  it('the database itself allows at most one lease per certificate, and never an armed lease', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { certificate } = await leased(accountId);
    await expect(connectionA.livePracticalMutationLease.create({ data: {
      leaseId: lid(accountId, 'lease-dup'), accountId, certificateId: certificate.certificateId, action: 'CANCEL', runtimeEpoch: EPOCH,
      reconciliationGeneration: 1, createdAtMs: BigInt(T0), status: 'LEASED',
    } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET armed_at_ms = ${BigInt(T0)} WHERE account_id = ${accountId}`)
      .rejects.toThrow(/live_practical_mutation_lease_not_armed_chk/);
  });

  it('a genuine certificate for another account, a structural look-alike, or a clone is refused', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const other = freshAccount();
    const foreign = await certified(other);
    await expect(repoA().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate: foreign.certificate, leaseId: lid(accountId, 'lease-f'), action: 'CANCEL', trustedNowMs: T0 + 1 }))
      .rejects.toThrow(/different account/);
    for (const forged of [{ ...PracticalRecoveryCertificate.read(certificate) }, { ...certificate }, Object.create(PracticalRecoveryCertificate.prototype)]) {
      await expect(repoA().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate: forged, leaseId: lid(accountId, 'lease-s'), action: 'CANCEL', trustedNowMs: T0 + 1 }))
        .rejects.toThrow(/genuine Stage 1A practical recovery certificate/);
    }
    expect(await connectionA.livePracticalMutationLease.count({ where: { accountId } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Manual-review episode binding
// ---------------------------------------------------------------------------

function resolutionFor(accountId: string, reviewEpisodeId: string, resolutionId = `resolution-${randomBytes(3).toString('hex')}`) {
  return mintPracticalManualReviewResolution({ accountId, reviewEpisodeId, resolutionId, assertedBy: 'operator-label', note: 'reviewed' });
}

describe('P18B-1B1-DB manual-review episodes', () => {
  it('entry creates a NEW episode; repeat entry preserves the unresolved current one without writing', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    const entered = await repoA().enterManualReview({ accountId, reason: 'ORPHAN_ORDER', nowMs: T0 });
    expect(entered.kind).toBe('ENTERED');
    expect(entered.account.state).toBe('MANUAL_REVIEW_REQUIRED');
    const escalated = await connectionA.livePracticalRecoveryEpisode.findFirstOrThrow({ where: { accountId, status: 'ESCALATED_TO_MANUAL_REVIEW' } });
    expect(escalated.reviewEpisodeId).toBe(entered.reviewEpisodeId);
    const again = await repoB().enterManualReview({ accountId, reason: 'UNEXPLAINED_POSITION', nowMs: T0 + 1 });
    expect(again).toMatchObject({ kind: 'PRESERVED', reviewEpisodeId: entered.reviewEpisodeId });
    expect(again.account.stateRevision).toBe(entered.account.stateRevision);
    expect(await connectionA.livePracticalReviewEpisode.count({ where: { accountId } })).toBe(1);
    await expect(repoA().enterManualReview({ accountId, reason: 'WS_DISCONNECTED', nowMs: T0 })).rejects.toThrow(/severity is MANUAL_REVIEW/);
  });

  it('a resolution clears exactly the CURRENT episode; an unused resolution from old episode A can never clear later episode B', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    const episodeA = (await repoA().enterManualReview({ accountId, reason: 'ORPHAN_ORDER', nowMs: T0 })).reviewEpisodeId;
    const usedForA = resolutionFor(accountId, episodeA, 'resolution-a-1');
    const leftoverForA = resolutionFor(accountId, episodeA, 'resolution-a-2');

    const resolved = await repoA().resolveManualReview({ accountId, resolution: usedForA, nowMs: T0 + 1 });
    expect(resolved.state).toBe('QUARANTINED');
    expect(resolved.currentRecoveryEpisode).toMatchObject({ startCause: 'OPERATOR_RESOLVED', openedByResolutionId: 'resolution-a-1' });
    expect(await connectionA.livePracticalReviewEpisode.findUniqueOrThrow({ where: { reviewEpisodeId: episodeA } }))
      .toMatchObject({ status: 'RESOLVED', resolutionId: 'resolution-a-1', resolutionAssertedBy: 'operator-label' });

    const episodeB = (await repoA().enterManualReview({ accountId, reason: 'ACCOUNT_IDENTITY_MISMATCH', nowMs: T0 + 2 })).reviewEpisodeId;
    expect(episodeB).not.toBe(episodeA);
    await expect(repoB().resolveManualReview({ accountId, resolution: leftoverForA, nowMs: T0 + 3 })).rejects.toThrow(/different manual-review episode/);
    await expect(repoB().resolveManualReview({ accountId, resolution: resolutionFor('another-account', episodeB), nowMs: T0 + 3 })).rejects.toThrow(/different account/);
    await expect(repoB().resolveManualReview({ accountId, resolution: { accountId, reviewEpisodeId: episodeB }, nowMs: T0 + 3 })).rejects.toThrow(/genuine resolution/);
    // Durable one-shot: a NEW object reusing an already-used resolution id is refused by the database.
    await expect(repoB().resolveManualReview({ accountId, resolution: resolutionFor(accountId, episodeB, 'resolution-a-1'), nowMs: T0 + 3 }))
      .rejects.toThrow(/already resolved a review episode/);
    let load = await repoA().loadAccount(accountId);
    expect(load).toMatchObject({ kind: 'FOUND', account: { state: 'MANUAL_REVIEW_REQUIRED', currentReviewEpisode: { reviewEpisodeId: episodeB, status: 'OPEN' } } });

    const forB = resolutionFor(accountId, episodeB);
    expect((await repoB().resolveManualReview({ accountId, resolution: forB, nowMs: T0 + 4 })).state).toBe('QUARANTINED');
    // In-memory one-shot: replay refused; and outside review, refused.
    await expect(repoA().resolveManualReview({ accountId, resolution: forB, nowMs: T0 + 5 })).rejects.toThrow(/not in manual review/);
    load = await repoA().loadAccount(accountId);
    expect(load).toMatchObject({ kind: 'FOUND', account: { state: 'QUARANTINED' } });
  });

  it('two workers resolving the same episode with different genuine resolutions: exactly one wins', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    const episode = (await repoA().enterManualReview({ accountId, reason: 'ORPHAN_ORDER', nowMs: T0 })).reviewEpisodeId;
    const summary = settledSummary(await Promise.allSettled([
      repoA().resolveManualReview({ accountId, resolution: resolutionFor(accountId, episode), nowMs: T0 + 1 }),
      repoB().resolveManualReview({ accountId, resolution: resolutionFor(accountId, episode), nowMs: T0 + 1 }),
    ]));
    expect(summary.fulfilled).toBe(1);
    expect(await connectionA.livePracticalRecoveryEpisode.count({ where: { accountId, startCause: 'OPERATOR_RESOLVED' } })).toBe(1);
  });

  it('an invalidation while MUTATING moves the state to MANUAL_REVIEW_REQUIRED immediately; the lease stays held; nothing downgrades it', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account } = await leased(accountId);
    const invalidated = await repoB().invalidate({ accountId, reason: 'ACCOUNT_IDENTITY_MISMATCH', nowMs: T0 + 2 });
    expect(invalidated.account).toMatchObject({ state: 'MANUAL_REVIEW_REQUIRED', fence: { mode: { kind: 'MUTATION_LEASED' } } });
    expect(invalidated.reviewEpisodeId).not.toBeNull();
    // A new runtime cannot adopt a leased fence (wire-arm resolution belongs to Stage 1B2).
    await expect(repoA().adoptForNewRuntime({ accountId, previousRuntimeEpoch: EPOCH, expectedFenceRevision: account.fence.revision, newRuntimeEpoch: EPOCH_B, nowMs: T0 + 3 }))
      .rejects.toThrow(/PRACTICAL_FENCE_CONFLICT/);
    const released = await repoA().releaseLease({ accountId, expected: expectationOf(account), leaseId: lid(accountId, 'lease-1'), outcome: 'ACCEPTED', nowMs: T0 + 4 });
    expect(released).toMatchObject({ state: 'MANUAL_REVIEW_REQUIRED', fence: { mode: { kind: 'IDLE' } } });
    expect(practicalStartupStateFromLoad(await repoA().loadAccount(accountId))).toBe('MANUAL_REVIEW_REQUIRED');
    const adopted = await repoA().adoptForNewRuntime({ accountId, previousRuntimeEpoch: EPOCH, expectedFenceRevision: released.fence.revision, newRuntimeEpoch: EPOCH_B, nowMs: T0 + 5 });
    expect(adopted).toMatchObject({ state: 'MANUAL_REVIEW_REQUIRED', currentReviewEpisode: { reviewEpisodeId: invalidated.reviewEpisodeId } });
  });

  it('a QUARANTINE-severity invalidation while MUTATING quarantines immediately; the later outcome keeps it quarantined', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account } = await leased(accountId);
    expect((await repoB().invalidate({ accountId, reason: 'WS_DISCONNECTED', nowMs: T0 + 2 })).account.state).toBe('QUARANTINED');
    const released = await repoA().releaseLease({ accountId, expected: expectationOf(account), leaseId: lid(accountId, 'lease-1'), outcome: 'ACCEPTED', nowMs: T0 + 3 });
    expect(released.state).toBe('QUARANTINED');
  });
});

// ---------------------------------------------------------------------------
// §7 Malformed durable data: fail closed, never NOT_FOUND, never repaired
// ---------------------------------------------------------------------------

async function withConstraintDropped(table: string, constraint: string, work: () => Promise<void>, checkSql: string): Promise<void> {
  await connectionA.$executeRawUnsafe(`ALTER TABLE \`${table}\` DROP CHECK \`${constraint}\``);
  try {
    await work();
  } finally {
    await connectionA.$executeRawUnsafe(`ALTER TABLE \`${table}\` ADD CONSTRAINT \`${constraint}\` CHECK (${checkSql})`);
  }
}

const INVALIDATION_REASON_CHK = 'live_practical_review_episode_invalidation_reason_chk';
const INVALIDATION_REASON_CHECK_SQL = `\`kind\` <> 'INVALIDATION' OR \`reason\` IN (${PRACTICAL_INVALIDATION_REASONS
  .filter((reason) => classifyPracticalInvalidation(reason) === 'MANUAL_REVIEW').map((reason) => `'${reason}'`).join(', ')})`;

describe('P18B-1B1-DB §7 malformed durable data', () => {
  it('the database refuses the malformed shapes it can express', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    await expect(connectionA.$executeRaw`UPDATE live_practical_account_fence SET mode = 'CERTIFYING' WHERE account_id = ${accountId}`).rejects.toThrow(/live_practical_account_fence_mode_chk/);
    await expect(connectionA.$executeRaw`UPDATE live_practical_account_fence SET mode = 'BROKEN' WHERE account_id = ${accountId}`).rejects.toThrow();
    await expect(connectionA.$executeRaw`UPDATE live_practical_account_fence SET reconciliation_generation = -1 WHERE account_id = ${accountId}`).rejects.toThrow(/generation_chk/);
    await expect(connectionA.$executeRaw`UPDATE live_practical_account_state SET state = 'CERTIFIED_IDLE' WHERE account_id = ${accountId}`).rejects.toThrow(/_chk/);
  });

  it('a malformed fence (padded run id, or a mode/data mismatch past a dropped CHECK) is MALFORMED and every operation refuses', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const start = await initialized(accountId);
    const certifying = await repoA().startCertification({ accountId, expected: expectationOf(start), runId: 'run-1', nowMs: T0 });
    await connectionA.$executeRaw`UPDATE live_practical_account_fence SET run_id = ' run-1' WHERE account_id = ${accountId}`;
    const load = await repoA().loadAccount(accountId);
    expect(load).toEqual({ kind: 'MALFORMED', problem: 'FENCE_ROW_INVALID', reviewEpisodeId: null });
    expect(practicalStartupStateFromLoad(load)).toBe('MANUAL_REVIEW_REQUIRED');
    await expect(repoA().failCertification({ accountId, expected: expectationOf(certifying), runId: 'run-1', resultingGeneration: 1, failure: { kind: 'PROVIDER_UNAVAILABLE' }, nowMs: T0 + 1 }))
      .rejects.toThrow(/PRACTICAL_PERSISTENCE_MALFORMED/);
    await expect(repoA().invalidate({ accountId, reason: 'WS_DISCONNECTED', nowMs: T0 + 1 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_MALFORMED/);
    await expect(repoA().enterManualReview({ accountId, reason: 'ORPHAN_ORDER', nowMs: T0 + 1 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_MALFORMED/);
    // No automatic repair.
    expect((await rawFence(accountId)).runId).toBe(' run-1');

    const other = freshAccount();
    await initialized(other);
    const shape = "(`mode` = 'IDLE' AND `run_id` IS NULL AND `lease_id` IS NULL AND `certificate_id` IS NULL AND `lease_action` IS NULL) OR (`mode` = 'CERTIFYING' AND `run_id` IS NOT NULL AND `lease_id` IS NULL AND `certificate_id` IS NULL AND `lease_action` IS NULL) OR (`mode` = 'MUTATION_LEASED' AND `run_id` IS NULL AND `lease_id` IS NOT NULL AND `certificate_id` IS NOT NULL AND `lease_action` IS NOT NULL)";
    await withConstraintDropped('live_practical_account_fence', 'live_practical_account_fence_mode_chk', async () => {
      await connectionA.$executeRaw`UPDATE live_practical_account_fence SET mode = 'CERTIFYING' WHERE account_id = ${other}`;
      expect(await repoA().loadAccount(other)).toEqual({ kind: 'MALFORMED', problem: 'FENCE_ROW_INVALID', reviewEpisodeId: null });
      await connectionA.$executeRaw`UPDATE live_practical_account_fence SET mode = 'IDLE', run_id = 'stray' WHERE account_id = ${other}`;
      expect(await repoA().loadAccount(other)).toEqual({ kind: 'MALFORMED', problem: 'FENCE_ROW_INVALID', reviewEpisodeId: null });
      // An UNKNOWN mode value (only storable with strict mode off AND the CHECK gone).
      await connectionA.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET SESSION sql_mode = ''");
        await tx.$executeRaw`UPDATE live_practical_account_fence SET mode = 'BROKEN', run_id = NULL WHERE account_id = ${other}`;
        await tx.$executeRawUnsafe('SET SESSION sql_mode = @@GLOBAL.sql_mode');
      });
      const unknown = await repoA().loadAccount(other);
      expect(unknown).toEqual({ kind: 'MALFORMED', problem: 'FENCE_ROW_INVALID', reviewEpisodeId: null });
      expect(practicalStartupStateFromLoad(unknown)).toBe('MANUAL_REVIEW_REQUIRED');
      await connectionA.$executeRaw`UPDATE live_practical_account_fence SET mode = 'IDLE', run_id = NULL WHERE account_id = ${other}`;
    }, shape);
  });

  it('a state row without its fence row is MALFORMED (PARTIAL), never NOT_FOUND', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    await connectionA.$executeRaw`DELETE FROM live_practical_account_fence WHERE account_id = ${accountId}`;
    const load = await repoA().loadAccount(accountId);
    expect(load).toEqual({ kind: 'MALFORMED', problem: 'PARTIAL_ACCOUNT_ROWS', reviewEpisodeId: null });
    expect(practicalStartupStateFromLoad(load)).toBe('MANUAL_REVIEW_REQUIRED');
    // Re-initializing is NOT a repair path: it refuses.
    await expect(repoA().initializeAccount({ accountId, runtimeEpoch: EPOCH, reconciliationGeneration: 0, nowMs: T0 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_MALFORMED/);
  });

  it('a malformed certificate (bad digest, unknown status past a dropped CHECK) fails closed', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    await connectionA.$executeRaw`UPDATE live_practical_certificate SET evidence_digest = ${'E'.repeat(64)} WHERE certificate_id = ${certificate.certificateId}`;
    expect(await repoA().loadAccount(accountId)).toEqual({ kind: 'MALFORMED', problem: 'CERTIFICATE_ROW_INVALID', reviewEpisodeId: null });
    expect(await repoA().loadCertificate(certificate.certificateId)).toEqual({ kind: 'MALFORMED', problem: 'CERTIFICATE_ROW_INVALID' });
    await expect(repoA().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate, leaseId: lid(accountId, 'lease-1'), action: 'CANCEL', trustedNowMs: T0 + 1 }))
      .rejects.toThrow(/PRACTICAL_PERSISTENCE_MALFORMED/);
    expect(await connectionA.livePracticalMutationLease.count({ where: { accountId } })).toBe(0);

    const other = freshAccount();
    const second = await certified(other);
    await withConstraintDropped('live_practical_certificate', 'live_practical_certificate_terminal_at_chk', async () => {
      await connectionA.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET SESSION sql_mode = ''");
        await tx.$executeRaw`UPDATE live_practical_certificate SET status = 'RESURRECTED' WHERE certificate_id = ${second.certificate.certificateId}`;
        await tx.$executeRawUnsafe('SET SESSION sql_mode = @@GLOBAL.sql_mode');
      });
      expect(await repoA().loadCertificate(second.certificate.certificateId)).toEqual({ kind: 'MALFORMED', problem: 'CERTIFICATE_ROW_INVALID' });
      expect(await repoA().loadAccount(other)).toEqual({ kind: 'MALFORMED', problem: 'CERTIFICATE_ROW_INVALID', reviewEpisodeId: null });
      await connectionA.$executeRaw`UPDATE live_practical_certificate SET status = 'ISSUED' WHERE certificate_id = ${second.certificate.certificateId}`;
    }, "(`status` = 'ISSUED') = (`terminal_at_ms` IS NULL)");
  });

  it('a current certificate bound to the wrong account, epoch, or generation fails closed', async () => {
    if (skip()) return;
    for (const column of ['runtime_epoch', 'reconciliation_generation', 'account_id'] as const) {
      const accountId = freshAccount();
      const { account, certificate } = await certified(accountId);
      if (column === 'runtime_epoch') {
        await connectionA.$executeRaw`UPDATE live_practical_certificate SET runtime_epoch = 'other-epoch' WHERE certificate_id = ${certificate.certificateId}`;
      } else if (column === 'reconciliation_generation') {
        await connectionA.$executeRaw`UPDATE live_practical_certificate SET reconciliation_generation = 7 WHERE certificate_id = ${certificate.certificateId}`;
      } else {
        const foreign = freshAccount();
        await initialized(foreign);
        await connectionA.$executeRaw`UPDATE live_practical_certificate SET account_id = ${foreign} WHERE certificate_id = ${certificate.certificateId}`;
      }
      expect(await repoA().loadAccount(accountId), column).toEqual({ kind: 'MALFORMED', problem: 'ROWS_INCONSISTENT', reviewEpisodeId: null });
      await expect(repoA().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate, leaseId: lid(accountId, 'lease-1'), action: 'CANCEL', trustedNowMs: T0 + 1 }))
        .rejects.toThrow(/PRACTICAL_PERSISTENCE_MALFORMED/);
      expect(await connectionA.livePracticalMutationLease.count({ where: { certificateId: certificate.certificateId } })).toBe(0);
    }
  });

  it('a malformed CURRENT manual-review episode yields the MANUAL_REVIEW_REQUIRED path and cannot be resolved', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    const episode = (await repoA().enterManualReview({ accountId, reason: 'ORPHAN_ORDER', nowMs: T0 })).reviewEpisodeId;
    // The database itself refuses an unknown invalidation reason...
    await expect(connectionA.$executeRaw`UPDATE live_practical_review_episode SET reason = 'NOT_A_REASON' WHERE review_episode_id = ${episode}`)
      .rejects.toThrow(new RegExp(INVALIDATION_REASON_CHK));
    // ...so inject it past the dropped CHECK: the repository still fails closed.
    await withConstraintDropped('live_practical_review_episode', INVALIDATION_REASON_CHK, async () => {
      await connectionA.$executeRaw`UPDATE live_practical_review_episode SET reason = 'NOT_A_REASON' WHERE review_episode_id = ${episode}`;
      try {
        const load = await repoA().loadAccount(accountId);
        expect(load).toEqual({ kind: 'MALFORMED', problem: 'REVIEW_EPISODE_ROW_INVALID', reviewEpisodeId: null });
        expect(practicalStartupStateFromLoad(load)).toBe('MANUAL_REVIEW_REQUIRED');
        await expect(repoA().resolveManualReview({ accountId, resolution: resolutionFor(accountId, episode), nowMs: T0 + 1 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_MALFORMED/);
      } finally {
        // Restored before the CHECK is re-added, even if an assertion failed.
        await connectionA.$executeRaw`UPDATE live_practical_review_episode SET reason = 'ORPHAN_ORDER' WHERE review_episode_id = ${episode}`;
      }
    }, INVALIDATION_REASON_CHECK_SQL);
    // A current episode that is already RESOLVED is inconsistent too.
    await connectionA.$executeRaw`UPDATE live_practical_review_episode SET status = 'RESOLVED', resolved_at_ms = 1, resolution_id = 'r', resolution_asserted_by = 'a', resolution_note = 'n' WHERE review_episode_id = ${episode}`;
    expect(await repoA().loadAccount(accountId)).toEqual({ kind: 'MALFORMED', problem: 'ROWS_INCONSISTENT', reviewEpisodeId: null });
  });
});

// ---------------------------------------------------------------------------
// P18B-1B1-01: the malformed-state manual-review latch
// ---------------------------------------------------------------------------

/** Makes an initialized (QUARANTINED) account's fence malformed in a way the CHECKs allow. */
async function corruptFence(accountId: string): Promise<void> {
  await connectionA.$executeRaw`UPDATE live_practical_account_fence SET mode = 'CERTIFYING', run_id = ' padded-run' WHERE account_id = ${accountId}`;
}

async function repairFence(accountId: string): Promise<void> {
  await connectionA.$executeRaw`UPDATE live_practical_account_fence SET mode = 'IDLE', run_id = NULL WHERE account_id = ${accountId}`;
}

async function malformedEpisodes(accountId: string) {
  return connectionA.livePracticalReviewEpisode.findMany({ where: { accountId, kind: 'MALFORMED_STATE' }, orderBy: { enteredAtMs: 'asc' } });
}

/** A client whose `livePracticalReviewEpisode.updateMany` fails ONCE with a MySQL-deadlock-shaped P2034, then works. */
function transientlyDeadlockingClient(): PrismaClient {
  let thrown = false;
  return connectionA.$extends({
    query: {
      livePracticalReviewEpisode: {
        async updateMany({ args, query }: { args: unknown; query: (args: unknown) => Promise<unknown> }) {
          if (!thrown) {
            thrown = true;
            throw new Prisma.PrismaClientKnownRequestError('simulated deadlock', { code: 'P2034', clientVersion: 'test' });
          }
          return query(args);
        },
      },
    },
  } as never) as unknown as PrismaClient;
}

describe('P18B-1B1-01 malformed durable state is latched into a durable manual-review episode', () => {
  it('[1][2] detection creates exactly ONE current reviewEpisodeId; repeated detection preserves it; the malformed row is untouched', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    await corruptFence(accountId);
    expect(await repoA().loadAccount(accountId)).toEqual({ kind: 'MALFORMED', problem: 'FENCE_ROW_INVALID', reviewEpisodeId: null });

    const first = await repoA().escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH_B, nowMs: T0 });
    if (first.kind !== 'LATCHED') throw new Error('expected LATCHED');
    expect(first.problem).toBe('FENCE_ROW_INVALID');
    const load = await repoB().loadAccount(accountId);
    expect(load).toEqual({ kind: 'MALFORMED', problem: 'FENCE_ROW_INVALID', reviewEpisodeId: first.reviewEpisodeId });
    expect(practicalStartupStateFromLoad(load)).toBe('MANUAL_REVIEW_REQUIRED');

    const episodes = await malformedEpisodes(accountId);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      reviewEpisodeId: first.reviewEpisodeId, reason: 'DURABLE_STATE_MALFORMED', malformedProblem: 'FENCE_ROW_INVALID', status: 'OPEN', runtimeEpoch: EPOCH_B,
    });
    const latchBefore = await connectionA.livePracticalMalformedLatch.findUniqueOrThrow({ where: { accountId } });

    for (const repository of [repoA(), repoB(), repoA()]) {
      expect(await repository.escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH, nowMs: T0 + 1 }))
        .toEqual({ kind: 'PRESERVED', reviewEpisodeId: first.reviewEpisodeId });
    }
    expect(await malformedEpisodes(accountId)).toHaveLength(1);
    expect(await connectionA.livePracticalMalformedLatch.findUniqueOrThrow({ where: { accountId } })).toEqual(latchBefore);
    // No repair: the malformed values are exactly as found; the state row never changed.
    expect(await rawFence(accountId)).toMatchObject({ mode: 'CERTIFYING', runId: ' padded-run', revision: 0n });
    expect(await rawState(accountId)).toMatchObject({ state: 'QUARANTINED', revision: 0n });
  });

  it('escalation refuses a trusted absence and a valid account (nothing is invented, nothing latched without cause)', async () => {
    if (skip()) return;
    await expect(repoA().escalateMalformedAccount({ accountId: freshAccount(), detectingRuntimeEpoch: EPOCH, nowMs: T0 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_NOT_FOUND/);
    const accountId = freshAccount();
    await initialized(accountId);
    await expect(repoA().escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH, nowMs: T0 })).rejects.toThrow(/nothing malformed to escalate/);
    expect(await connectionA.livePracticalMalformedLatch.count({ where: { accountId } })).toBe(0);
  });

  it('[3] certification is refused while the latch exists, even after the rows are corrected', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const start = await initialized(accountId);
    await corruptFence(accountId);
    const { reviewEpisodeId } = await repoA().escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH, nowMs: T0 });
    await repairFence(accountId);
    expect(await repoA().loadAccount(accountId)).toEqual({ kind: 'MALFORMED', problem: 'LATCHED_PENDING_REVIEW', reviewEpisodeId });
    await expect(repoA().startCertification({ accountId, expected: expectationOf(start), runId: 'run-1', nowMs: T0 + 1 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_LATCHED/);
    // Nothing else moves the account either (only the exact resolution does).
    await expect(repoA().invalidate({ accountId, reason: 'WS_DISCONNECTED', nowMs: T0 + 1 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_LATCHED/);
    await expect(repoA().enterManualReview({ accountId, reason: 'ORPHAN_ORDER', nowMs: T0 + 1 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_LATCHED/);
    await expect(repoA().initializeAccount({ accountId, runtimeEpoch: EPOCH, reconciliationGeneration: 0, nowMs: T0 + 1 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_LATCHED/);
    await expect(repoA().adoptForNewRuntime({ accountId, previousRuntimeEpoch: EPOCH, expectedFenceRevision: 0, newRuntimeEpoch: EPOCH_B, nowMs: T0 + 1 }))
      .rejects.toThrow(/PRACTICAL_PERSISTENCE_LATCHED/);
    expect(await rawFence(accountId)).toMatchObject({ mode: 'IDLE', revision: 0n });
  });

  it('[4] certificate leasing is refused while the latch exists, even after the rows are corrected', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    await connectionA.$executeRaw`UPDATE live_practical_certificate SET evidence_digest = ${'E'.repeat(64)} WHERE certificate_id = ${certificate.certificateId}`;
    const escalation = await repoA().escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH, nowMs: T0 + 1 });
    expect(escalation).toMatchObject({ kind: 'LATCHED', problem: 'CERTIFICATE_ROW_INVALID' });
    await connectionA.$executeRaw`UPDATE live_practical_certificate SET evidence_digest = ${'e'.repeat(64)} WHERE certificate_id = ${certificate.certificateId}`;
    await expect(repoA().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate, leaseId: lid(accountId, 'lease-1'), action: 'CANCEL', trustedNowMs: T0 + 2 }))
      .rejects.toThrow(/PRACTICAL_PERSISTENCE_LATCHED/);
    expect(await connectionA.livePracticalMutationLease.count({ where: { accountId } })).toBe(0);
    expect((await connectionA.livePracticalCertificate.findUniqueOrThrow({ where: { certificateId: certificate.certificateId } })).status).toBe('ISSUED');
    // Clearing the latch requires a non-authority baseline: a CERTIFIED_IDLE account is refused.
    await expect(repoA().resolveManualReview({ accountId, resolution: resolutionFor(accountId, escalation.reviewEpisodeId), nowMs: T0 + 3 }))
      .rejects.toThrow(/non-authority baseline/);
  });

  it('[5][6][7][9] only a resolution for this account AND the exact CURRENT episode clears it; old episode A can never clear later episode B', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    await corruptFence(accountId);
    const episodeA = (await repoA().escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH, nowMs: T0 })).reviewEpisodeId;
    const forA = resolutionFor(accountId, episodeA);
    const leftoverForA = resolutionFor(accountId, episodeA);

    // Rows still malformed: refused, and the resolution is NOT consumed (it works once the rows are corrected).
    await expect(repoA().resolveManualReview({ accountId, resolution: forA, nowMs: T0 + 1 })).rejects.toThrow(/still malformed or absent/);
    await repairFence(accountId);
    await expect(repoA().resolveManualReview({ accountId, resolution: resolutionFor(accountId, 'some-other-episode'), nowMs: T0 + 1 })).rejects.toThrow(/different manual-review episode/);
    await expect(repoA().resolveManualReview({ accountId, resolution: resolutionFor('another-account', episodeA), nowMs: T0 + 1 })).rejects.toThrow(/different account/);
    await expect(repoA().resolveManualReview({ accountId, resolution: { accountId, reviewEpisodeId: episodeA }, nowMs: T0 + 1 })).rejects.toThrow(/genuine resolution/);

    const resolved = await repoB().resolveManualReview({ accountId, resolution: forA, nowMs: T0 + 2 });
    expect(resolved).toMatchObject({ state: 'QUARANTINED', fence: { mode: { kind: 'IDLE' } } });
    expect(await repoA().loadAccount(accountId)).toMatchObject({ kind: 'FOUND', account: { state: 'QUARANTINED' } });
    expect(await connectionA.livePracticalReviewEpisode.findUniqueOrThrow({ where: { reviewEpisodeId: episodeA } })).toMatchObject({ status: 'RESOLVED' });
    expect((await connectionA.livePracticalMalformedLatch.findUniqueOrThrow({ where: { accountId } })).currentReviewEpisodeId).toBeNull();
    // The resolution is spent (in memory AND durably).
    await expect(repoA().resolveManualReview({ accountId, resolution: forA, nowMs: T0 + 3 })).rejects.toThrow(/not in manual review/);

    // [9] A later malformed detection gets a NEW episode; an unused resolution for old episode A cannot clear it.
    await corruptFence(accountId);
    const episodeB = (await repoA().escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH, nowMs: T0 + 4 })).reviewEpisodeId;
    expect(episodeB).not.toBe(episodeA);
    await repairFence(accountId);
    await expect(repoA().resolveManualReview({ accountId, resolution: leftoverForA, nowMs: T0 + 5 })).rejects.toThrow(/different manual-review episode/);
    expect(await repoA().loadAccount(accountId)).toEqual({ kind: 'MALFORMED', problem: 'LATCHED_PENDING_REVIEW', reviewEpisodeId: episodeB });
    expect((await malformedEpisodes(accountId)).map((episode) => [episode.reviewEpisodeId, episode.status])).toEqual([[episodeA, 'RESOLVED'], [episodeB, 'OPEN']]);
  });

  it('[8] concurrent malformed-state escalators converge on exactly one current unresolved episode', async () => {
    if (skip()) return;
    for (let round = 0; round < 5; round += 1) {
      const accountId = freshAccount();
      await initialized(accountId);
      await corruptFence(accountId);
      const results = await Promise.all([
        repoA().escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH, nowMs: T0 }),
        repoB().escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH_B, nowMs: T0 }),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual(['LATCHED', 'PRESERVED']);
      expect(results[0].reviewEpisodeId).toBe(results[1].reviewEpisodeId);
      const episodes = await malformedEpisodes(accountId);
      expect(episodes).toHaveLength(1);
      expect((await connectionA.livePracticalMalformedLatch.findUniqueOrThrow({ where: { accountId } })).currentReviewEpisodeId).toBe(episodes[0]!.reviewEpisodeId);
    }
  });

  it('[10] a database read failure is an error: never NOT_FOUND, and it never clears the latch', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    await corruptFence(accountId);
    const { reviewEpisodeId } = await repoA().escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH, nowMs: T0 });
    const broken = new URL(shadowDatabaseUrl());
    broken.pathname = `/${SHADOW_DB_NAME}_does_not_exist`;
    const unreachable = new PrismaClient({ datasources: { db: { url: broken.toString() } } });
    try {
      const failing = new PrismaPracticalSafetyRepository(unreachable);
      await expect(failing.loadAccount(accountId)).rejects.toThrow();
      await expect(failing.escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH, nowMs: T0 + 1 })).rejects.toThrow();
      await expect(failing.resolveManualReview({ accountId, resolution: resolutionFor(accountId, reviewEpisodeId), nowMs: T0 + 1 })).rejects.toThrow();
    } finally {
      await unreachable.$disconnect();
    }
    expect(await repoA().loadAccount(accountId)).toEqual({ kind: 'MALFORMED', problem: 'FENCE_ROW_INVALID', reviewEpisodeId });
  });

  it('[11] a fault during escalation leaves no half-created episode and no latch change', async () => {
    if (skip()) return;
    // First escalation (latch row insert) fails after the episode insert.
    const accountId = freshAccount();
    await initialized(accountId);
    await corruptFence(accountId);
    await expect(new PrismaPracticalSafetyRepository(faultyClient('livePracticalMalformedLatch', 'create')).escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH, nowMs: T0 }))
      .rejects.toThrow(/injected fault/);
    expect(await malformedEpisodes(accountId)).toHaveLength(0);
    expect(await connectionA.livePracticalMalformedLatch.count({ where: { accountId } })).toBe(0);
    expect(await repoA().loadAccount(accountId)).toEqual({ kind: 'MALFORMED', problem: 'FENCE_ROW_INVALID', reviewEpisodeId: null });

    // Re-latching an existing, resolved latch row (update path) fails after the episode insert.
    const episodeA = (await repoA().escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH, nowMs: T0 + 1 })).reviewEpisodeId;
    await repairFence(accountId);
    await repoA().resolveManualReview({ accountId, resolution: resolutionFor(accountId, episodeA), nowMs: T0 + 2 });
    await corruptFence(accountId);
    const latchBefore = await connectionA.livePracticalMalformedLatch.findUniqueOrThrow({ where: { accountId } });
    await expect(new PrismaPracticalSafetyRepository(faultyClient('livePracticalMalformedLatch', 'updateMany')).escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH, nowMs: T0 + 3 }))
      .rejects.toThrow(/injected fault/);
    expect(await malformedEpisodes(accountId)).toHaveLength(1);
    expect(await connectionA.livePracticalMalformedLatch.findUniqueOrThrow({ where: { accountId } })).toEqual(latchBefore);
  });

  it('[12] malformed fence, malformed certificate, and cross-table inconsistency all take the same latch path, with no value repaired', async () => {
    if (skip()) return;
    const cases: readonly { name: string; corrupt: (accountId: string, certificateId: string) => Promise<void>; problem: string; check: (accountId: string, certificateId: string) => Promise<void> }[] = [
      {
        name: 'fence',
        corrupt: async (accountId) => { await connectionA.$executeRaw`UPDATE live_practical_account_fence SET runtime_epoch = ' epoch-a' WHERE account_id = ${accountId}`; },
        problem: 'FENCE_ROW_INVALID',
        check: async (accountId) => { expect((await rawFence(accountId)).runtimeEpoch).toBe(' epoch-a'); },
      },
      {
        name: 'certificate',
        corrupt: async (_accountId, certificateId) => { await connectionA.$executeRaw`UPDATE live_practical_certificate SET provider_account_fingerprint = 'not-a-digest' WHERE certificate_id = ${certificateId}`; },
        problem: 'CERTIFICATE_ROW_INVALID',
        check: async (_accountId, certificateId) => {
          expect((await connectionA.livePracticalCertificate.findUniqueOrThrow({ where: { certificateId } })).providerAccountFingerprint).toBe('not-a-digest');
        },
      },
      {
        name: 'cross-table',
        corrupt: async (_accountId, certificateId) => { await connectionA.$executeRaw`UPDATE live_practical_certificate SET reconciliation_generation = 9 WHERE certificate_id = ${certificateId}`; },
        problem: 'ROWS_INCONSISTENT',
        check: async (_accountId, certificateId) => {
          expect((await connectionA.livePracticalCertificate.findUniqueOrThrow({ where: { certificateId } })).reconciliationGeneration).toBe(9);
        },
      },
    ];
    for (const testCase of cases) {
      const accountId = freshAccount();
      const { certificate } = await certified(accountId);
      await testCase.corrupt(accountId, certificate.certificateId);
      const escalation = await repoA().escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH, nowMs: T0 + 1 });
      expect(escalation, testCase.name).toMatchObject({ kind: 'LATCHED', problem: testCase.problem });
      const load = await repoA().loadAccount(accountId);
      expect(load, testCase.name).toEqual({ kind: 'MALFORMED', problem: testCase.problem, reviewEpisodeId: escalation.reviewEpisodeId });
      expect(practicalStartupStateFromLoad(load)).toBe('MANUAL_REVIEW_REQUIRED');
      await testCase.check(accountId, certificate.certificateId);
      expect((await rawState(accountId)).state, testCase.name).toBe('CERTIFIED_IDLE');
      expect((await connectionA.livePracticalCertificate.findUniqueOrThrow({ where: { certificateId: certificate.certificateId } })).status).toBe('ISSUED');
    }
  });
});

describe('P18B-1B1-01 resolution liveness: a rolled-back attempt never burns the one-shot resolution', () => {
  it('a transient deadlock during the durable writes is retried; the resolution is consumed exactly once (latch path)', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    await corruptFence(accountId);
    const { reviewEpisodeId } = await repoA().escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH, nowMs: T0 });
    await repairFence(accountId);
    const resolution = resolutionFor(accountId, reviewEpisodeId);
    const resolved = await new PrismaPracticalSafetyRepository(transientlyDeadlockingClient()).resolveManualReview({ accountId, resolution, nowMs: T0 + 1 });
    expect(resolved.state).toBe('QUARANTINED');
    expect(await connectionA.livePracticalReviewEpisode.count({ where: { accountId, status: 'RESOLVED' } })).toBe(1);
    expect(() => transitionPracticalAccountState('MANUAL_REVIEW_REQUIRED', { kind: 'OPERATOR_RESOLUTION', accountId, reviewEpisodeId, resolution })).toThrow(/already used/);
  });

  it('a transient deadlock is retried on the invalidation-episode path too', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    const { reviewEpisodeId } = await repoA().enterManualReview({ accountId, reason: 'ORPHAN_ORDER', nowMs: T0 });
    const resolved = await new PrismaPracticalSafetyRepository(transientlyDeadlockingClient()).resolveManualReview({ accountId, resolution: resolutionFor(accountId, reviewEpisodeId), nowMs: T0 + 1 });
    expect(resolved.state).toBe('QUARANTINED');
    expect(await connectionA.livePracticalRecoveryEpisode.count({ where: { accountId, startCause: 'OPERATOR_RESOLVED' } })).toBe(1);
  });

  it('a non-retryable fault after the episode write rolls everything back, and the SAME resolution then succeeds exactly once', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    await corruptFence(accountId);
    const { reviewEpisodeId } = await repoA().escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH, nowMs: T0 });
    await repairFence(accountId);
    const resolution = resolutionFor(accountId, reviewEpisodeId);
    await expect(new PrismaPracticalSafetyRepository(faultyClient('livePracticalMalformedLatch', 'updateMany')).resolveManualReview({ accountId, resolution, nowMs: T0 + 1 }))
      .rejects.toThrow(/injected fault/);
    expect(await connectionA.livePracticalReviewEpisode.findUniqueOrThrow({ where: { reviewEpisodeId } })).toMatchObject({ status: 'OPEN', resolutionId: null });
    expect(await repoA().loadAccount(accountId)).toMatchObject({ kind: 'MALFORMED', reviewEpisodeId });
    expect((await repoB().resolveManualReview({ accountId, resolution, nowMs: T0 + 2 })).state).toBe('QUARANTINED');
    await expect(repoB().resolveManualReview({ accountId, resolution, nowMs: T0 + 3 })).rejects.toThrow(/not in manual review/);
  });

  it('a resolution already consumed in memory is refused at the final step, and nothing is committed', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    const { reviewEpisodeId } = await repoA().enterManualReview({ accountId, reason: 'ORPHAN_ORDER', nowMs: T0 });
    const resolution = resolutionFor(accountId, reviewEpisodeId);
    transitionPracticalAccountState('MANUAL_REVIEW_REQUIRED', { kind: 'OPERATOR_RESOLUTION', accountId, reviewEpisodeId, resolution });
    await expect(repoA().resolveManualReview({ accountId, resolution, nowMs: T0 + 1 })).rejects.toThrow(/already used/);
    expect(await repoA().loadAccount(accountId)).toMatchObject({ kind: 'FOUND', account: { state: 'MANUAL_REVIEW_REQUIRED', currentReviewEpisode: { reviewEpisodeId, status: 'OPEN' } } });
  });
});

// ---------------------------------------------------------------------------
// P18B-1B1-02: a MUTATION_LEASED fence is bound to its exact durable lease
// ---------------------------------------------------------------------------

const FENCE_LEASE_FK = 'live_practical_account_fence_lease_fkey';

/**
 * Test-only injection of a state the six-column fence->lease FK forbids: one
 * pinned connection with FOREIGN_KEY_CHECKS off, restored before it returns.
 */
async function withoutForeignKeyChecks(work: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  await connectionA.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
    try {
      await work(tx);
    } finally {
      await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
    }
  });
}

/** Every durable practical row of an account, plus one lease by id (a cross-account lease is no longer the account's). */
async function durableRows(accountId: string, leaseId?: string) {
  const where = { accountId };
  return {
    state: await connectionA.livePracticalAccountState.findUnique({ where }),
    fence: await connectionA.livePracticalAccountFence.findUnique({ where }),
    latch: await connectionA.livePracticalMalformedLatch.findUnique({ where }),
    certificates: await connectionA.livePracticalCertificate.findMany({ where, orderBy: { certificateId: 'asc' } }),
    leases: await connectionA.livePracticalMutationLease.findMany({ where, orderBy: { leaseId: 'asc' } }),
    lease: leaseId === undefined ? null : await connectionA.livePracticalMutationLease.findUnique({ where: { leaseId } }),
    recoveryEpisodes: await connectionA.livePracticalRecoveryEpisode.findMany({ where, orderBy: { episodeId: 'asc' } }),
    reviewEpisodes: await connectionA.livePracticalReviewEpisode.findMany({ where, orderBy: { reviewEpisodeId: 'asc' } }),
  };
}

const ROWS_INCONSISTENT = { kind: 'MALFORMED', problem: 'ROWS_INCONSISTENT', reviewEpisodeId: null };

describe('P18B-1B1-02 a MUTATION_LEASED fence is bound to its exact durable LEASED lease', () => {
  it('[1] a leased account with its matching lease is FOUND and carries that lease', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await leased(accountId);
    expect(account.currentLease).toMatchObject({
      leaseId: lid(accountId, 'lease-1'), certificateId: certificate.certificateId, accountId, action: 'CANCEL', runtimeEpoch: EPOCH, reconciliationGeneration: 1, status: 'LEASED',
    });
    expect(await repoB().loadAccount(accountId)).toMatchObject({ kind: 'FOUND', account: { state: 'MUTATING', currentLease: { leaseId: lid(accountId, 'lease-1') } } });
  });

  it('the database itself refuses a fence or lease change that breaks the binding (six-column composite FK)', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const other = freshAccount();
    await leased(accountId);
    await initialized(other);
    const leaseId = lid(accountId, 'lease-1');
    const fk = new RegExp(FENCE_LEASE_FK);
    await expect(connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET action = 'OPEN' WHERE lease_id = ${leaseId}`).rejects.toThrow(fk);
    await expect(connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET runtime_epoch = 'runtime-epoch-z' WHERE lease_id = ${leaseId}`).rejects.toThrow(fk);
    await expect(connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET reconciliation_generation = 9 WHERE lease_id = ${leaseId}`).rejects.toThrow(fk);
    await expect(connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET account_id = ${other} WHERE lease_id = ${leaseId}`).rejects.toThrow(fk);
    await expect(connectionA.$executeRaw`DELETE FROM live_practical_mutation_lease WHERE lease_id = ${leaseId}`).rejects.toThrow(fk);
    await expect(connectionA.$executeRaw`UPDATE live_practical_account_fence SET lease_action = 'CLOSE' WHERE account_id = ${accountId}`).rejects.toThrow(fk);
    await expect(connectionA.$executeRaw`UPDATE live_practical_account_fence SET runtime_epoch = 'runtime-epoch-z' WHERE account_id = ${accountId}`).rejects.toThrow(fk);
    await expect(connectionA.$executeRaw`UPDATE live_practical_account_fence SET reconciliation_generation = 9 WHERE account_id = ${accountId}`).rejects.toThrow(fk);
    // What the FK cannot express: exact case under the case-insensitive collation (the child side
    // may differ only by case), and the lease's status. The repository refuses both.
    expect(await connectionA.$executeRaw`UPDATE live_practical_account_fence SET runtime_epoch = UPPER(runtime_epoch) WHERE account_id = ${accountId}`).toBe(1);
    expect(await repoA().loadAccount(accountId)).toEqual(ROWS_INCONSISTENT);
    expect(await connectionA.$executeRaw`UPDATE live_practical_account_fence SET runtime_epoch = ${EPOCH} WHERE account_id = ${accountId}`).toBe(1);
    expect((await repoA().loadAccount(accountId)).kind).toBe('FOUND');
    expect(await connectionA.$executeRaw`UPDATE live_practical_mutation_lease SET status = 'COMPLETED', completed_at_ms = 5, outcome = 'ACCEPTED' WHERE lease_id = ${leaseId}`).toBe(1);
    expect(await repoA().loadAccount(accountId)).toEqual(ROWS_INCONSISTENT);
  });

  const mismatches: readonly { readonly name: string; readonly inject: (tx: Prisma.TransactionClient, leaseId: string, other: string) => Promise<unknown> }[] = [
    { name: '[2] missing lease', inject: (tx, leaseId) => tx.$executeRaw`DELETE FROM live_practical_mutation_lease WHERE lease_id = ${leaseId}` },
    { name: '[3] lease action differs', inject: (tx, leaseId) => tx.$executeRaw`UPDATE live_practical_mutation_lease SET action = 'OPEN' WHERE lease_id = ${leaseId}` },
    { name: '[4] lease runtime epoch differs', inject: (tx, leaseId) => tx.$executeRaw`UPDATE live_practical_mutation_lease SET runtime_epoch = 'runtime-epoch-z' WHERE lease_id = ${leaseId}` },
    { name: '[4] lease runtime epoch differs only by case', inject: (tx, leaseId) => tx.$executeRaw`UPDATE live_practical_mutation_lease SET runtime_epoch = UPPER(runtime_epoch) WHERE lease_id = ${leaseId}` },
    { name: '[5] lease generation differs', inject: (tx, leaseId) => tx.$executeRaw`UPDATE live_practical_mutation_lease SET reconciliation_generation = 9 WHERE lease_id = ${leaseId}` },
    { name: '[6] lease belongs to another account', inject: (tx, leaseId, other) => tx.$executeRaw`UPDATE live_practical_mutation_lease SET account_id = ${other} WHERE lease_id = ${leaseId}` },
    {
      name: '[7] lease COMPLETED while the fence stays MUTATION_LEASED',
      inject: (tx, leaseId) => tx.$executeRaw`UPDATE live_practical_mutation_lease SET status = 'COMPLETED', completed_at_ms = 5, outcome = 'ACCEPTED' WHERE lease_id = ${leaseId}`,
    },
  ];

  it.each(mismatches.map((mismatch) => [mismatch.name, mismatch] as const))('%s -> MALFORMED; [8] releaseLease refuses it with ZERO durable change', async (_name, mismatch) => {
    if (skip()) return;
    const accountId = freshAccount();
    const other = freshAccount();
    const { account } = await leased(accountId);
    await initialized(other);
    const leaseId = lid(accountId, 'lease-1');
    await withoutForeignKeyChecks(async (tx) => { expect(await mismatch.inject(tx, leaseId, other)).toBe(1); });

    const load = await repoB().loadAccount(accountId);
    expect(load).toEqual(ROWS_INCONSISTENT);
    expect(practicalStartupStateFromLoad(load)).toBe('MANUAL_REVIEW_REQUIRED');
    const before = await durableRows(accountId, leaseId);
    for (const outcome of ['ACCEPTED', 'REJECTED', 'AMBIGUOUS'] as const) {
      await expect(repoA().releaseLease({ accountId, expected: expectationOf(account), leaseId, outcome, nowMs: T0 + 5 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_MALFORMED/);
    }
    // Nothing else can move it either.
    await expect(repoA().invalidate({ accountId, reason: 'WS_DISCONNECTED', nowMs: T0 + 6 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_MALFORMED/);
    expect(await durableRows(accountId, leaseId)).toEqual(before);
    expect(before.fence).toMatchObject({ mode: 'MUTATION_LEASED', leaseId });
  });

  it('[9] a malformed leased state goes through the malformed-state latch, which repairs neither fence nor lease', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account } = await leased(accountId);
    const leaseId = lid(accountId, 'lease-1');
    await withoutForeignKeyChecks(async (tx) => { await tx.$executeRaw`UPDATE live_practical_mutation_lease SET action = 'OPEN' WHERE lease_id = ${leaseId}`; });
    const before = await durableRows(accountId, leaseId);

    const escalation = await repoA().escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH_B, nowMs: T0 + 5 });
    if (escalation.kind !== 'LATCHED') throw new Error('expected LATCHED');
    expect(escalation.problem).toBe('ROWS_INCONSISTENT');
    expect(await repoB().escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH_B, nowMs: T0 + 6 })).toEqual({ kind: 'PRESERVED', reviewEpisodeId: escalation.reviewEpisodeId });
    expect(await repoA().loadAccount(accountId)).toEqual({ kind: 'MALFORMED', problem: 'ROWS_INCONSISTENT', reviewEpisodeId: escalation.reviewEpisodeId });
    await expect(repoA().releaseLease({ accountId, expected: expectationOf(account), leaseId, outcome: 'ACCEPTED', nowMs: T0 + 7 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_LATCHED/);

    const after = await durableRows(accountId, leaseId);
    // Only the episode and the latch were written; the state, fence, certificate, and lease are exactly as found.
    expect({ ...after, latch: null, reviewEpisodes: [] }).toEqual({ ...before, latch: null, reviewEpisodes: [] });
    expect(after.lease).toMatchObject({ action: 'OPEN', status: 'LEASED' });
    expect(after.fence).toMatchObject({ mode: 'MUTATION_LEASED', leaseAction: 'CANCEL' });
    // The latch cannot be resolved while the binding is still broken.
    await expect(repoA().resolveManualReview({ accountId, resolution: resolutionFor(accountId, escalation.reviewEpisodeId), nowMs: T0 + 8 }))
      .rejects.toThrow(/still malformed or absent/);
  });

  it.each([
    ['QUARANTINED', 'WS_DISCONNECTED'],
    ['MANUAL_REVIEW_REQUIRED', 'ACCOUNT_IDENTITY_MISMATCH'],
  ] as const)('[10] invalidated mid-mutation to %s: the still-leased fence is VALID only while its exact LEASED lease matches', async (state, reason) => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account } = await leased(accountId);
    const leaseId = lid(accountId, 'lease-1');
    const invalidated = await repoB().invalidate({ accountId, reason, nowMs: T0 + 2 });
    expect(invalidated.account).toMatchObject({ state, fence: { mode: { kind: 'MUTATION_LEASED', leaseId } }, currentLease: { leaseId, status: 'LEASED' } });
    expect(await repoA().loadAccount(accountId)).toMatchObject({ kind: 'FOUND', account: { state, currentLease: { leaseId } } });

    // Break exactly one binding (the generation), past the FK: the SAME account is now MALFORMED.
    await withoutForeignKeyChecks(async (tx) => { await tx.$executeRaw`UPDATE live_practical_mutation_lease SET reconciliation_generation = 2 WHERE lease_id = ${leaseId}`; });
    expect(await repoA().loadAccount(accountId)).toEqual(ROWS_INCONSISTENT);
    const before = await durableRows(accountId, leaseId);
    await expect(repoA().releaseLease({ accountId, expected: expectationOf(account), leaseId, outcome: 'ACCEPTED', nowMs: T0 + 3 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_MALFORMED/);
    expect(await durableRows(accountId, leaseId)).toEqual(before);

    // Restored exactly, it is valid again and releases normally (state unchanged by the outcome).
    await withoutForeignKeyChecks(async (tx) => { await tx.$executeRaw`UPDATE live_practical_mutation_lease SET reconciliation_generation = 1 WHERE lease_id = ${leaseId}`; });
    const released = await repoA().releaseLease({ accountId, expected: expectationOf(account), leaseId, outcome: 'ACCEPTED', nowMs: T0 + 4 });
    expect(released).toMatchObject({ state, fence: { mode: { kind: 'IDLE' } }, currentLease: null });
    expect(await repoA().loadLease(leaseId)).toMatchObject({ kind: 'FOUND', record: { status: 'COMPLETED', outcome: 'ACCEPTED' } });
  });
});

// ---------------------------------------------------------------------------
// P18B-1B1-05: the held lease rests on its exact CONSUMED certificate
// ---------------------------------------------------------------------------

const LEASE_CERTIFICATE_FK = 'live_practical_mutation_lease_certificate_fkey';

/** `durableRows` plus the leased certificate by id (a cross-account certificate is no longer the account's). */
async function chainRows(accountId: string, leaseId: string, certificateId: string) {
  return {
    ...(await durableRows(accountId, leaseId)),
    leasedCertificate: await connectionA.livePracticalCertificate.findUnique({ where: { certificateId } }),
  };
}

/** A client whose ISSUED -> CONSUMED update silently does nothing yet reports one row: a simulated consumption regression. */
function nonConsumingClient(): PrismaClient {
  return connectionA.$extends({
    query: {
      livePracticalCertificate: {
        async updateMany({ args, query }: { args: { data?: { status?: unknown } }; query: (args: unknown) => Promise<unknown> }) {
          if (args.data?.status === 'CONSUMED') return { count: 1 };
          return query(args);
        },
      },
    },
  } as never) as unknown as PrismaClient;
}

describe('P18B-1B1-05 fence -> exact LEASED lease -> exact CONSUMED certificate', () => {
  it('[1][14] a normal leased account is FOUND with its exact CONSUMED certificate, and the consume re-read returns exactly that chain', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const acquisition = await repoA().consumeCertificateAndLease({
      accountId, expected: expectationOf(account), certificate, leaseId: lid(accountId, 'lease-1'), action: 'CANCEL', trustedNowMs: T0 + 1_000,
    });
    if (acquisition.kind !== 'LEASED') throw new Error('expected LEASED');
    expect(acquisition.account.leasedCertificate).toMatchObject({
      certificateId: certificate.certificateId, accountId, runtimeEpoch: EPOCH, reconciliationGeneration: 1, status: 'CONSUMED',
    });
    expect(acquisition.account.currentCertificate).toBeNull();
    expect(acquisition.certificate).toEqual(acquisition.account.leasedCertificate);
    expect(acquisition.lease).toEqual(acquisition.account.currentLease);
    expect(await repoB().loadAccount(accountId)).toEqual({ kind: 'FOUND', account: acquisition.account });
  });

  it('[14] a consumption regression (certificate left ISSUED) is caught by the post-consume re-read and rolls EVERYTHING back', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await certified(accountId);
    const leaseId = lid(accountId, 'lease-1');
    const before = await durableRows(accountId, leaseId);
    await expect(new PrismaPracticalSafetyRepository(nonConsumingClient()).consumeCertificateAndLease({
      accountId, expected: expectationOf(account), certificate, leaseId, action: 'CANCEL', trustedNowMs: T0 + 1_000,
    })).rejects.toThrow(/PRACTICAL_PERSISTENCE_(MALFORMED|CONFLICT)/);
    expect(await durableRows(accountId, leaseId)).toEqual(before);
    expect(before).toMatchObject({ lease: null, fence: { mode: 'IDLE' }, state: { state: 'CERTIFIED_IDLE' } });
    // The real consumption still works afterwards (nothing was burned).
    expect(await repoA().consumeCertificateAndLease({ accountId, expected: expectationOf(account), certificate, leaseId, action: 'CANCEL', trustedNowMs: T0 + 1_000 }))
      .toMatchObject({ kind: 'LEASED', certificate: { status: 'CONSUMED' } });
  });

  it('[13] the database itself refuses a certificate change that breaks the lease binding (four-column composite FK)', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const other = freshAccount();
    const { certificate } = await leased(accountId);
    await initialized(other);
    const id = certificate.certificateId;
    const fk = new RegExp(LEASE_CERTIFICATE_FK);
    await expect(connectionA.$executeRaw`UPDATE live_practical_certificate SET account_id = ${other} WHERE certificate_id = ${id}`).rejects.toThrow(fk);
    await expect(connectionA.$executeRaw`UPDATE live_practical_certificate SET runtime_epoch = 'runtime-epoch-z' WHERE certificate_id = ${id}`).rejects.toThrow(fk);
    await expect(connectionA.$executeRaw`UPDATE live_practical_certificate SET reconciliation_generation = 9 WHERE certificate_id = ${id}`).rejects.toThrow(fk);
    await expect(connectionA.$executeRaw`DELETE FROM live_practical_certificate WHERE certificate_id = ${id}`).rejects.toThrow(/foreign key constraint fails/);
    // What the FK cannot express: the CONSUMED status. The repository refuses it.
    expect(await connectionA.$executeRaw`UPDATE live_practical_certificate SET status = 'ISSUED', terminal_at_ms = NULL WHERE certificate_id = ${id}`).toBe(1);
    expect(await repoA().loadAccount(accountId)).toEqual(ROWS_INCONSISTENT);
  });

  const corruptions: readonly { readonly name: string; readonly inject: (tx: Prisma.TransactionClient, certificateId: string, other: string) => Promise<unknown> }[] = [
    { name: '[2] missing leased certificate', inject: (tx, id) => tx.$executeRaw`DELETE FROM live_practical_certificate WHERE certificate_id = ${id}` },
    { name: '[3] certificate account differs', inject: (tx, id, other) => tx.$executeRaw`UPDATE live_practical_certificate SET account_id = ${other} WHERE certificate_id = ${id}` },
    { name: '[4] certificate runtime epoch differs', inject: (tx, id) => tx.$executeRaw`UPDATE live_practical_certificate SET runtime_epoch = 'runtime-epoch-z' WHERE certificate_id = ${id}` },
    { name: '[4] certificate runtime epoch differs only by case', inject: (tx, id) => tx.$executeRaw`UPDATE live_practical_certificate SET runtime_epoch = UPPER(runtime_epoch) WHERE certificate_id = ${id}` },
    { name: '[5] certificate generation differs', inject: (tx, id) => tx.$executeRaw`UPDATE live_practical_certificate SET reconciliation_generation = 9 WHERE certificate_id = ${id}` },
    { name: '[6] certificate ISSUED again', inject: (tx, id) => tx.$executeRaw`UPDATE live_practical_certificate SET status = 'ISSUED', terminal_at_ms = NULL WHERE certificate_id = ${id}` },
    { name: '[7] certificate REVOKED', inject: (tx, id) => tx.$executeRaw`UPDATE live_practical_certificate SET status = 'REVOKED', terminal_reason = 'WS_DISCONNECTED' WHERE certificate_id = ${id}` },
    { name: '[8] certificate EXPIRED', inject: (tx, id) => tx.$executeRaw`UPDATE live_practical_certificate SET status = 'EXPIRED', terminal_reason = 'CERTIFICATE_EXPIRED' WHERE certificate_id = ${id}` },
  ];

  it.each(corruptions.map((corruption) => [corruption.name, corruption] as const))('%s -> MALFORMED; [9] releaseLease refuses it with ZERO durable change', async (_name, corruption) => {
    if (skip()) return;
    const accountId = freshAccount();
    const other = freshAccount();
    const { account, certificate } = await leased(accountId);
    await initialized(other);
    const leaseId = lid(accountId, 'lease-1');
    await withoutForeignKeyChecks(async (tx) => { expect(await corruption.inject(tx, certificate.certificateId, other)).toBe(1); });

    const load = await repoB().loadAccount(accountId);
    expect(load).toEqual(ROWS_INCONSISTENT);
    expect(practicalStartupStateFromLoad(load)).toBe('MANUAL_REVIEW_REQUIRED');
    const before = await chainRows(accountId, leaseId, certificate.certificateId);
    for (const outcome of ['ACCEPTED', 'REJECTED', 'AMBIGUOUS'] as const) {
      await expect(repoA().releaseLease({ accountId, expected: expectationOf(account), leaseId, outcome, nowMs: T0 + 5 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_MALFORMED/);
    }
    expect(await chainRows(accountId, leaseId, certificate.certificateId)).toEqual(before);
    expect(before).toMatchObject({ fence: { mode: 'MUTATION_LEASED', leaseId }, lease: { status: 'LEASED' } });
  });

  it.each([
    ['[10] QUARANTINED', 'WS_DISCONNECTED'],
    ['[11] MANUAL_REVIEW_REQUIRED', 'ACCOUNT_IDENTITY_MISMATCH'],
  ] as const)('%s with a still-leased fence still requires the exact CONSUMED certificate', async (_label, reason) => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await leased(accountId);
    const leaseId = lid(accountId, 'lease-1');
    const id = certificate.certificateId;
    const invalidated = await repoB().invalidate({ accountId, reason, nowMs: T0 + 2 });
    const state = invalidated.account.state;
    expect(invalidated.account).toMatchObject({ fence: { mode: { kind: 'MUTATION_LEASED' } }, leasedCertificate: { certificateId: id, status: 'CONSUMED' } });

    await connectionA.$executeRaw`UPDATE live_practical_certificate SET status = 'ISSUED', terminal_at_ms = NULL WHERE certificate_id = ${id}`;
    expect(await repoA().loadAccount(accountId)).toEqual(ROWS_INCONSISTENT);
    const before = await chainRows(accountId, leaseId, id);
    await expect(repoA().releaseLease({ accountId, expected: expectationOf(account), leaseId, outcome: 'ACCEPTED', nowMs: T0 + 3 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_MALFORMED/);
    expect(await chainRows(accountId, leaseId, id)).toEqual(before);

    // Restored exactly, the chain is valid again and the lease releases normally.
    await connectionA.$executeRaw`UPDATE live_practical_certificate SET status = 'CONSUMED', terminal_at_ms = ${T0 + 1_000} WHERE certificate_id = ${id}`;
    expect(await repoA().loadAccount(accountId)).toMatchObject({ kind: 'FOUND', account: { state, leasedCertificate: { status: 'CONSUMED' } } });
    const released = await repoA().releaseLease({ accountId, expected: expectationOf(account), leaseId, outcome: 'ACCEPTED', nowMs: T0 + 4 });
    expect(released).toMatchObject({ state, fence: { mode: { kind: 'IDLE' } }, currentLease: null, leasedCertificate: null });
  });

  it('[12] a malformed lease -> certificate chain goes through the malformed-state latch, which repairs neither certificate, lease, nor fence', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await leased(accountId);
    const leaseId = lid(accountId, 'lease-1');
    const id = certificate.certificateId;
    await withoutForeignKeyChecks(async (tx) => { await tx.$executeRaw`UPDATE live_practical_certificate SET runtime_epoch = 'runtime-epoch-z' WHERE certificate_id = ${id}`; });
    const before = await chainRows(accountId, leaseId, id);

    const escalation = await repoA().escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH_B, nowMs: T0 + 5 });
    if (escalation.kind !== 'LATCHED') throw new Error('expected LATCHED');
    expect(escalation.problem).toBe('ROWS_INCONSISTENT');
    expect(await repoB().escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH_B, nowMs: T0 + 6 })).toEqual({ kind: 'PRESERVED', reviewEpisodeId: escalation.reviewEpisodeId });
    await expect(repoA().releaseLease({ accountId, expected: expectationOf(account), leaseId, outcome: 'ACCEPTED', nowMs: T0 + 7 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_LATCHED/);
    await expect(repoA().resolveManualReview({ accountId, resolution: resolutionFor(accountId, escalation.reviewEpisodeId), nowMs: T0 + 8 }))
      .rejects.toThrow(/still malformed or absent/);

    const after = await chainRows(accountId, leaseId, id);
    // Only the episode and the latch were written: certificate, lease, fence, and state are exactly as found.
    expect({ ...after, latch: null, reviewEpisodes: [] }).toEqual({ ...before, latch: null, reviewEpisodes: [] });
    expect(after.leasedCertificate).toMatchObject({ runtimeEpoch: 'runtime-epoch-z', status: 'CONSUMED' });
  });
});

// ---------------------------------------------------------------------------
// P18B-1B1-03: generated durable ids are validated before any write
// ---------------------------------------------------------------------------

describe('P18B-1B1-03 a faulty id generator can never poison durable state', () => {
  const BAD_IDS: readonly (readonly [string, string])[] = [
    ['empty', ''],
    ['whitespace-padded', ' padded-id '],
    ['over-length (65)', 'x'.repeat(65)],
  ];
  const faultyIds = (id: string) => new PrismaPracticalSafetyRepository(connectionA, () => id);

  it.each(BAD_IDS)('%s generated id: initialize (recovery episode id) writes nothing', async (_label, id) => {
    if (skip()) return;
    const accountId = freshAccount();
    await expect(faultyIds(id).initializeAccount({ accountId, runtimeEpoch: EPOCH, reconciliationGeneration: 0, nowMs: T0 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_FAULT/);
    expect(await durableRows(accountId)).toEqual({ state: null, fence: null, latch: null, certificates: [], leases: [], lease: null, recoveryEpisodes: [], reviewEpisodes: [] });
    expect(await repoA().loadAccount(accountId)).toEqual({ kind: 'NOT_FOUND' });
  });

  it.each(BAD_IDS)('%s generated id: entering manual review (review episode id) writes nothing', async (_label, id) => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    const before = await durableRows(accountId);
    await expect(faultyIds(id).enterManualReview({ accountId, reason: 'ORPHAN_ORDER', nowMs: T0 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_FAULT/);
    expect(await durableRows(accountId)).toEqual(before);
  });

  it.each(BAD_IDS)('%s generated id: malformed-state escalation (malformed review episode id) writes nothing', async (_label, id) => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    await corruptFence(accountId);
    const before = await durableRows(accountId);
    await expect(faultyIds(id).escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH, nowMs: T0 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_FAULT/);
    expect(await durableRows(accountId)).toEqual(before);
    expect(await repoA().loadAccount(accountId)).toEqual({ kind: 'MALFORMED', problem: 'FENCE_ROW_INVALID', reviewEpisodeId: null });
  });

  it.each(BAD_IDS)('%s generated id: resolving review (new recovery episode id) writes nothing and never burns the resolution', async (_label, id) => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    const { reviewEpisodeId } = await repoA().enterManualReview({ accountId, reason: 'ORPHAN_ORDER', nowMs: T0 });
    const resolution = resolutionFor(accountId, reviewEpisodeId);
    const before = await durableRows(accountId);
    await expect(faultyIds(id).resolveManualReview({ accountId, resolution, nowMs: T0 + 1 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_FAULT/);
    expect(await durableRows(accountId)).toEqual(before);
    expect(await repoA().resolveManualReview({ accountId, resolution, nowMs: T0 + 2 })).toMatchObject({ state: 'QUARANTINED' });
  });

  it('a valid UUID generator keeps working, and the escalated latch re-reads as exactly that episode', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    await corruptFence(accountId);
    const fixed = '6f1c2b1e-3a55-4d0e-9d7a-0b8f5f7f2c11';
    const escalation = await new PrismaPracticalSafetyRepository(connectionA, () => fixed).escalateMalformedAccount({ accountId, detectingRuntimeEpoch: EPOCH, nowMs: T0 });
    expect(escalation).toEqual({ kind: 'LATCHED', reviewEpisodeId: fixed, problem: 'FENCE_ROW_INVALID' });
    expect(await connectionA.livePracticalMalformedLatch.findUniqueOrThrow({ where: { accountId } })).toMatchObject({ currentReviewEpisodeId: fixed });
  });
});

// ---------------------------------------------------------------------------
// Hardening: exact identity under the case-insensitive collation, and review-reason severity
// ---------------------------------------------------------------------------

describe('P18B-1B1 hardening: exact identity under utf8mb4_unicode_ci', () => {
  it('a differently cased certificate, lease, or account key is never returned as an exact identity match', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    const { account, certificate } = await leased(accountId);
    const leaseId = lid(accountId, 'lease-1');
    // MySQL itself matches these keys case-insensitively:
    expect(await connectionA.livePracticalMutationLease.count({ where: { leaseId: leaseId.toUpperCase() } })).toBe(1);

    await expect(repoA().loadCertificate(certificate.certificateId.toUpperCase())).rejects.toThrow(/PRACTICAL_PERSISTENCE_INVALID_INPUT/);
    expect(await repoA().loadCertificate(certificate.certificateId)).toMatchObject({ kind: 'FOUND' });
    await expect(repoA().loadLease(leaseId.toUpperCase())).rejects.toThrow(/PRACTICAL_PERSISTENCE_CONFLICT/);
    expect(await repoA().loadLease(leaseId)).toMatchObject({ kind: 'FOUND', record: { leaseId } });
    await expect(repoA().releaseLease({ accountId, expected: expectationOf(account), leaseId: leaseId.toUpperCase(), outcome: 'ACCEPTED', nowMs: T0 + 2 }))
      .rejects.toThrow(/PRACTICAL_FENCE/);
    expect((await repoA().loadAccount(accountId)).kind).toBe('FOUND');

    // A case-variant ACCOUNT key reads as MALFORMED (never FOUND) and can never latch the real account.
    const upper = accountId.toUpperCase();
    expect(await repoA().loadAccount(upper)).toEqual(ROWS_INCONSISTENT);
    const before = await durableRows(accountId, leaseId);
    await expect(repoA().escalateMalformedAccount({ accountId: upper, detectingRuntimeEpoch: EPOCH, nowMs: T0 + 3 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_CONFLICT/);
    await expect(repoA().invalidate({ accountId: upper, reason: 'WS_DISCONNECTED', nowMs: T0 + 3 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_MALFORMED/);
    expect(await durableRows(accountId, leaseId)).toEqual(before);
    expect(await repoA().loadAccount(accountId)).toMatchObject({ kind: 'FOUND', account: { state: 'MUTATING' } });
  });
});

describe('P18B-1B1 hardening: an INVALIDATION review episode must carry a MANUAL_REVIEW-severity reason', () => {
  it('the database refuses a QUARANTINE-severity reason; past a dropped CHECK the account is MALFORMED and cannot be resolved', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await initialized(accountId);
    const { reviewEpisodeId } = await repoA().enterManualReview({ accountId, reason: 'ORPHAN_ORDER', nowMs: T0 });
    await expect(connectionA.$executeRaw`UPDATE live_practical_review_episode SET reason = 'WS_DISCONNECTED' WHERE review_episode_id = ${reviewEpisodeId}`)
      .rejects.toThrow(new RegExp(INVALIDATION_REASON_CHK));
    await withConstraintDropped('live_practical_review_episode', INVALIDATION_REASON_CHK, async () => {
      await connectionA.$executeRaw`UPDATE live_practical_review_episode SET reason = 'WS_DISCONNECTED' WHERE review_episode_id = ${reviewEpisodeId}`;
      try {
        const load = await repoA().loadAccount(accountId);
        expect(load).toEqual({ kind: 'MALFORMED', problem: 'REVIEW_EPISODE_ROW_INVALID', reviewEpisodeId: null });
        expect(practicalStartupStateFromLoad(load)).toBe('MANUAL_REVIEW_REQUIRED');
        await expect(repoA().resolveManualReview({ accountId, resolution: resolutionFor(accountId, reviewEpisodeId), nowMs: T0 + 1 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_MALFORMED/);
      } finally {
        // Restored before the CHECK is re-added, even if an assertion failed.
        await connectionA.$executeRaw`UPDATE live_practical_review_episode SET reason = 'ORPHAN_ORDER' WHERE review_episode_id = ${reviewEpisodeId}`;
      }
    }, INVALIDATION_REASON_CHECK_SQL);
    expect((await repoA().loadAccount(accountId)).kind).toBe('FOUND');
  });

  it('a QUARANTINE-severity invalidation never creates a review episode (it quarantines)', async () => {
    if (skip()) return;
    const accountId = freshAccount();
    await certified(accountId);
    const result = await repoA().invalidate({ accountId, reason: 'CLOCK_ANOMALY', nowMs: T0 + 1 });
    expect(result).toMatchObject({ account: { state: 'QUARANTINED' }, reviewEpisodeId: null });
    expect(await connectionA.livePracticalReviewEpisode.count({ where: { accountId } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Migration parity for the new objects
// ---------------------------------------------------------------------------

describe('P18B-1B1-DB migration parity', () => {
  it('the migrated database and the Prisma datamodel agree on every live_practical_* object', () => {
    if (skip()) return;
    const diff = spawnSync(process.execPath, [
      path.join(REPO_ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'diff', '--script',
      '--from-url', shadowDatabaseUrl(),
      '--to-schema-datamodel', path.join(REPO_ROOT, 'prisma/schema.prisma'),
    ], { encoding: 'utf8', cwd: REPO_ROOT, env: process.env });
    expect(diff.status).toBe(0);
    expect(diff.stdout.split('\n').filter((line) => /live_practical/.test(line))).toEqual([]);
  }, 60_000);

  it('every Stage 1B1 CHECK constraint is present in the migrated database', async () => {
    if (skip()) return;
    const rows = await connectionA.$queryRaw<{ name: string }[]>`SELECT CONSTRAINT_NAME AS name FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ${SHADOW_DB_NAME} AND CONSTRAINT_NAME LIKE 'live\\_practical\\_%'`;
    expect(rows.length).toBe(28);
    expect(rows.map((row) => row.name)).toContain('live_practical_mutation_lease_not_armed_chk');
    expect(rows.map((row) => row.name)).toContain(INVALIDATION_REASON_CHK);
  });
});
