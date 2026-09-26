import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { URL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeClock } from '../../../src/core/time/clock';
import { PracticalRecoveryCertificate } from '../../../src/execution/live/practical/certificate';
import { PrismaPracticalSafetyRepository } from '../../../src/execution/live/practical-persistence/repository';
import type { PracticalRecoveryPersistence } from '../../../src/execution/live/practical-recovery/ports';
import { PracticalRecoveryService, type PracticalCertificationOutcome } from '../../../src/execution/live/practical-recovery/service';
import { PracticalRecoveryTelemetryBuffer } from '../../../src/execution/live/practical-recovery/telemetry';
import {
  EPOCH,
  EPOCH_B,
  FINGERPRINT,
  FakePrivateStream,
  FakeReconciliation,
  FakeScheduler,
  FakeVenue,
  T0,
  enablementFor,
  order,
  position,
} from '../../unit/execution/live/practical-recovery/support';

// [P18B-CHECKPOINT-B-DB] Real MySQL proof of the read-only recovery core over
// the reviewed Stage 1B1 repository, with two INDEPENDENT connections.
//
// NOTHING HERE TOUCHES COINDCX. The venue is a read-only fake (it has no
// create/cancel/close method at all), the private stream is a fake health +
// subscription source, and time is a fake clock. No lease is ever taken.
// The fake stream is a DETERMINISTIC TEST STREAM that can explicitly report
// PROVEN_READY (a provider subscription confirmation), which the real CoinDCX
// adapter cannot: with the real adapter, certification is unavailable.
//
// ACCEPTANCE: by default this suite soft-skips when no local MySQL is
// reachable. `npm run test:integration:live-practical-recovery` sets
// REQUIRE_LIVE_PRACTICAL_RECOVERY_DB_INTEGRATION=1, under which `beforeAll`
// throws instead, so a false green is impossible.

const REPO_ROOT = path.resolve(__dirname, '../../..');
const STRICT = process.env['REQUIRE_LIVE_PRACTICAL_RECOVERY_DB_INTEGRATION'] === '1';
const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = `p18b_recovery_test_${randomBytes(6).toString('hex')}`;

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
    if (STRICT) throw new Error('[P18B-RECOVERY-DB] REQUIRE_LIVE_PRACTICAL_RECOVERY_DB_INTEGRATION=1 but no DATABASE_URL is configured.');
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
    if (STRICT) throw new Error(`[P18B-RECOVERY-DB] strict mode could not provision a disposable MySQL shadow database: ${(error as Error).message}`);
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
  if (STRICT) throw new Error('[P18B-RECOVERY-DB] strict mode reached a test body with no database connection.');
  console.warn('P18B recovery DB suite skipped: no reachable disposable MySQL. Set REQUIRE_LIVE_PRACTICAL_RECOVERY_DB_INTEGRATION=1 to make this hard.');
  return true;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let accountCounter = 0;
function freshAccount(): string {
  accountCounter += 1;
  return `p18b-rec-${accountCounter}-${randomBytes(4).toString('hex')}`;
}

/** The venue, stream, Phase 18 state, and clock of one account's world (shared by every "process" that looks at it). */
interface World {
  readonly accountId: string;
  readonly clock: FakeClock;
  readonly venue: FakeVenue;
  readonly stream: FakePrivateStream;
  readonly reconciliation: FakeReconciliation;
}

function world(): World {
  const accountId = freshAccount();
  const clock = new FakeClock(T0);
  return { accountId, clock, venue: new FakeVenue(clock), stream: new FakePrivateStream(), reconciliation: new FakeReconciliation(accountId) };
}

interface Process {
  readonly service: PracticalRecoveryService;
  readonly scheduler: FakeScheduler;
  readonly telemetry: PracticalRecoveryTelemetryBuffer;
}

/** One runtime "process": its own epoch, scheduler, connection, and service over the SAME durable account. */
function processFor(
  w: World,
  options: { readonly epoch?: string; readonly connection?: PrismaClient; readonly persistence?: PracticalRecoveryPersistence; readonly stream?: FakePrivateStream } = {},
): Process {
  const epoch = options.epoch ?? EPOCH;
  const scheduler = new FakeScheduler(w.clock);
  const telemetry = new PracticalRecoveryTelemetryBuffer();
  let runs = 0;
  const service = new PracticalRecoveryService({
    accountId: w.accountId,
    runtimeEpoch: epoch,
    expectedProviderAccountFingerprint: FINGERPRINT,
    enablement: enablementFor(w.accountId),
    persistence: options.persistence ?? new PrismaPracticalSafetyRepository(options.connection ?? connectionA),
    venue: w.venue,
    reconciliation: w.reconciliation,
    privateStream: options.stream ?? w.stream,
    clock: w.clock,
    scheduler,
    telemetry,
    newRunId: () => `run-${epoch}-${randomBytes(3).toString('hex')}-${++runs}`,
  });
  return { service, scheduler, telemetry };
}

async function ready(w: World, p: Process, epoch = EPOCH): Promise<number> {
  await p.service.recoverAtStartup();
  expect(await p.service.startWatch()).toMatchObject({ kind: 'WATCHING' });
  return w.reconciliation.completeHealthyRun(epoch);
}

async function durable(accountId: string) {
  return {
    state: await connectionA.livePracticalAccountState.findUnique({ where: { accountId } }),
    fence: await connectionA.livePracticalAccountFence.findUnique({ where: { accountId } }),
    certificates: await connectionA.livePracticalCertificate.findMany({ where: { accountId }, orderBy: { issuedAtMs: 'asc' } }),
    leases: await connectionA.livePracticalMutationLease.count({ where: { accountId } }),
  };
}

function certified(outcome: PracticalCertificationOutcome): Extract<PracticalCertificationOutcome, { kind: 'CERTIFIED' }> {
  if (outcome.kind !== 'CERTIFIED') throw new Error(`expected CERTIFIED, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
  return outcome;
}

/** Waits (real time, bounded) until a condition holds: real-DB round trips take more than one tick. */
async function until(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** The real repository with some operations replaced (delegation, so the adapter's private state stays intact). */
function withOverrides(repository: PrismaPracticalSafetyRepository, overrides: Partial<PracticalRecoveryPersistence>): PracticalRecoveryPersistence {
  const base: PracticalRecoveryPersistence = {
    loadAccount: (accountId) => repository.loadAccount(accountId),
    escalateMalformedAccount: (input) => repository.escalateMalformedAccount(input),
    initializeAccount: (input) => repository.initializeAccount(input),
    adoptForNewRuntime: (input) => repository.adoptForNewRuntime(input),
    startCertification: (input) => repository.startCertification(input),
    finishCertification: (input) => repository.finishCertification(input),
    failCertification: (input) => repository.failCertification(input),
    recordProviderRecovered: (input) => repository.recordProviderRecovered(input),
    invalidate: (input) => repository.invalidate(input),
    expireCertificate: (input) => repository.expireCertificate(input),
  };
  return { ...base, ...overrides };
}

/** A persistence whose finishCertification waits for a gate (a process frozen just before persisting). */
function gatedFinish(repository: PrismaPracticalSafetyRepository): { persistence: PracticalRecoveryPersistence; reached: Promise<void>; open: () => void } {
  let open!: () => void;
  let reach!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  const persistence: PracticalRecoveryPersistence = withOverrides(repository, {
    finishCertification: async (input: Parameters<PracticalRecoveryPersistence['finishCertification']>[0]) => {
      reach();
      await gate;
      return repository.finishCertification(input);
    },
  });
  return { persistence, reached, open };
}

/** A client whose `model.operation` always fails (deterministic mid-transaction fault). */
function faultyClient(model: 'livePracticalAccountFence' | 'livePracticalCertificate', operation: 'create' | 'updateMany'): PrismaClient {
  return connectionA.$extends({
    query: { [model]: { [operation]: () => { throw new Error(`injected fault: ${model}.${operation}`); } } },
  } as never) as unknown as PrismaClient;
}

// ---------------------------------------------------------------------------
// The certification path over the real repository
// ---------------------------------------------------------------------------

describe('P18B-CKPT-B-DB certification over the real Stage 1B1 repository', () => {
  it('QUARANTINED -> CERTIFYING -> CERTIFIED_IDLE: one durable ISSUED certificate, bound and practical-only; no lease', async () => {
    if (skip()) return;
    const w = world();
    const p = processFor(w);
    const generation = await ready(w, p);
    const outcome = certified(await p.service.certifyAccount());
    const rows = await durable(w.accountId);
    expect(rows.state).toMatchObject({ state: 'CERTIFIED_IDLE', currentCertificateId: outcome.certificate.certificateId });
    expect(rows.fence).toMatchObject({ mode: 'IDLE', reconciliationGeneration: generation, runtimeEpoch: EPOCH });
    expect(rows.certificates).toHaveLength(1);
    expect(rows.certificates[0]).toMatchObject({
      status: 'ISSUED', evidenceDigest: outcome.summary.evidenceDigest, reconciliationGeneration: generation, streamIncarnation: 1, providerAccountFingerprint: FINGERPRINT,
    });
    expect(Number(rows.certificates[0]!.expiresAtMs - rows.certificates[0]!.issuedAtMs)).toBeLessThanOrEqual(120_000);
    expect(rows.leases).toBe(0);
    const episode = await connectionA.livePracticalRecoveryEpisode.findFirstOrThrow({ where: { accountId: w.accountId, status: 'CERTIFIED' } });
    expect(episode.certifiedCertificateId).toBe(outcome.certificate.certificateId);
    expect(PracticalRecoveryCertificate.read(outcome.certificate)).toMatchObject({ basis: 'PRACTICAL_RECOVERY', provesAccountContinuity: false });
  });

  it('CONCURRENT certification attempts on two connections: exactly one certificate; the loser changes nothing', async () => {
    if (skip()) return;
    const w = world();
    const a = processFor(w, { connection: connectionA });
    const b = processFor(w, { connection: connectionB });
    await a.service.recoverAtStartup();
    await a.service.startWatch();
    await b.service.startWatch();
    w.reconciliation.completeHealthyRun();
    const results = await Promise.all([a.service.certifyAccount(), b.service.certifyAccount()]);
    expect(results.map((result) => result.kind).sort()).toEqual(['CERTIFIED', 'LOST_RACE']);
    const rows = await durable(w.accountId);
    expect(rows.certificates).toHaveLength(1);
    expect(rows.state?.state).toBe('CERTIFIED_IDLE');
  });

  it('INVALIDATION RACING FINAL ISSUANCE (invalidation commits first): no certificate is ever persisted', async () => {
    if (skip()) return;
    const w = world();
    const repository = new PrismaPracticalSafetyRepository(connectionA);
    const gated = gatedFinish(repository);
    const p = processFor(w, { persistence: gated.persistence });
    await ready(w, p);
    const pending = p.service.certifyAccount();
    await gated.reached;
    w.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    await p.service.settled();
    expect((await durable(w.accountId)).state?.state).toBe('QUARANTINED');
    gated.open();
    expect(await pending).toMatchObject({ kind: 'SUPERSEDED', reason: 'PRIVATE_STATE_EVENT' });
    const rows = await durable(w.accountId);
    expect(rows.certificates).toHaveLength(0);
    expect(rows).toMatchObject({ state: { state: 'QUARANTINED' }, fence: { mode: 'IDLE' }, leases: 0 });
  });

  it('INVALIDATION RACING FINAL ISSUANCE (issuance commits first): the tripwire durably revokes the certificate', async () => {
    if (skip()) return;
    const w = world();
    const repository = new PrismaPracticalSafetyRepository(connectionA);
    const racing: PracticalRecoveryPersistence = withOverrides(repository, {
      finishCertification: async (input: Parameters<PracticalRecoveryPersistence['finishCertification']>[0]) => {
        const account = await repository.finishCertification(input);
        w.stream.emit('PRIVATE_POSITION_UPDATE_NOTIFICATION');
        return account;
      },
    });
    const p = processFor(w, { persistence: racing });
    await ready(w, p);
    expect(await p.service.certifyAccount()).toMatchObject({ kind: 'SUPERSEDED', reason: 'PRIVATE_STATE_EVENT' });
    const rows = await durable(w.accountId);
    expect(rows.certificates).toHaveLength(1);
    expect(rows.certificates[0]).toMatchObject({ status: 'REVOKED', terminalReason: 'PRIVATE_STATE_EVENT' });
    expect(rows.state?.state).toBe('QUARANTINED');
  });

  it('ROLLBACK ON ISSUANCE FAILURE: a fault after the certificate insert leaves no certificate and a released fence', async () => {
    if (skip()) return;
    const w = world();
    const repository = new PrismaPracticalSafetyRepository(connectionA);
    const faulty = new PrismaPracticalSafetyRepository(faultyClient('livePracticalAccountFence', 'updateMany'));
    const persistence: PracticalRecoveryPersistence = withOverrides(repository, {
      finishCertification: (input: Parameters<PracticalRecoveryPersistence['finishCertification']>[0]) => faulty.finishCertification(input),
    });
    const p = processFor(w, { persistence });
    const generation = await ready(w, p);
    expect(await p.service.certifyAccount()).toMatchObject({ kind: 'FAILED', failure: 'PERSISTENCE_REFUSED', released: true });
    const rows = await durable(w.accountId);
    expect(rows.certificates).toHaveLength(0);
    expect(rows).toMatchObject({ state: { state: 'QUARANTINED' }, fence: { mode: 'IDLE', reconciliationGeneration: generation } });
  });
});

// ---------------------------------------------------------------------------
// Provider failures and the stream
// ---------------------------------------------------------------------------

describe('P18B-CKPT-B-DB provider read failure sequences and the stream', () => {
  it('unavailable -> probe still failing (no change) -> probe OK on a new generation -> certified', async () => {
    if (skip()) return;
    const w = world();
    const p = processFor(w);
    await ready(w, p);
    w.venue.behavior = (kind, index) => (kind === 'ORDERS' && index === 1 ? { kind: 'THROW' } : undefined);
    expect(await p.service.certifyAccount()).toMatchObject({ kind: 'FAILED', failure: 'PROVIDER_UNAVAILABLE' });
    expect((await durable(w.accountId)).state?.state).toBe('PROVIDER_UNAVAILABLE');
    w.reconciliation.completeHealthyRun();
    w.venue.behavior = (kind) => (kind === 'IDENTITY' ? { kind: 'HANG' } : undefined);
    expect(await p.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'PROVIDER_STILL_UNAVAILABLE' });
    expect((await durable(w.accountId)).state?.state).toBe('PROVIDER_UNAVAILABLE');
    w.venue.behavior = () => undefined;
    certified(await p.service.certifyAccount());
  });

  it('a hard timeout, then incomplete pagination, then a bracket disagreement: each fails durably with its own reason and issues nothing', async () => {
    if (skip()) return;
    const w = world();
    const p = processFor(w);
    await ready(w, p);
    w.venue.behavior = (kind, index) => (kind === 'POSITIONS' && index === 0 ? { kind: 'HANG' } : undefined);
    expect(await p.service.certifyAccount()).toMatchObject({ kind: 'FAILED', failure: 'READ_HARD_TIMEOUT' });

    w.reconciliation.completeHealthyRun();
    w.venue.behavior = (kind, index) => (kind === 'ORDERS' && index === 1
      ? { kind: 'VALUE', value: { orders: [], provenance: { source: 'COINDCX_FUTURES_ORDERS', localReadStartedAtMs: 1, localReadEndedAtMs: 2, complete: false, pagesRead: 3, incompleteReason: 'ORDER_READ_FAILED_SELL_PAGE_3' } } }
      : undefined);
    expect(await p.service.certifyAccount()).toMatchObject({ kind: 'FAILED', failure: 'PAGINATION_INCOMPLETE' });
    expect((await durable(w.accountId)).state?.state).toBe('QUARANTINED');

    w.reconciliation.completeHealthyRun();
    w.venue.behavior = () => undefined;
    // Order reads so far: run 1 (O1, index 0), run 2 (O1, index 1). Run 3 reads O1 at index 2 and O2 at index 3: a fill between them.
    w.venue.onCall = (kind, index) => { if (kind === 'ORDERS' && index === 3) w.venue.orders = [order('ord-1', { filledQuantity: '0.5', remainingQuantity: '0.5' })]; };
    expect(await p.service.certifyAccount()).toMatchObject({ kind: 'FAILED', failure: 'BRACKET_DISAGREEMENT' });
    const rows = await durable(w.accountId);
    expect(rows.certificates).toHaveLength(0);
    expect(rows.state?.state).toBe('QUARANTINED');
  });

  it('a stream incarnation change during certification: SUPERSEDED, durably QUARANTINED, nothing issued', async () => {
    if (skip()) return;
    const w = world();
    const p = processFor(w);
    await ready(w, p);
    w.venue.onCall = (kind, index) => { if (kind === 'IDENTITY' && index === 1) w.stream.reconnect(); };
    expect(await p.service.certifyAccount()).toMatchObject({ kind: 'SUPERSEDED', reason: 'WS_DISCONNECTED' });
    const rows = await durable(w.accountId);
    expect(rows.certificates).toHaveLength(0);
    expect(rows).toMatchObject({ state: { state: 'QUARANTINED' }, fence: { mode: 'IDLE' } });
  });

  it('a private event while CERTIFIED_IDLE durably revokes the certificate (WS can only revoke)', async () => {
    if (skip()) return;
    const w = world();
    const p = processFor(w);
    await ready(w, p);
    const outcome = certified(await p.service.certifyAccount());
    w.clock.advance(5_000);
    w.stream.emit('PRIVATE_BALANCE_CHANGE_NOTIFICATION');
    await p.service.settled();
    const rows = await durable(w.accountId);
    expect(rows.certificates[0]).toMatchObject({ certificateId: outcome.certificate.certificateId, status: 'REVOKED', terminalReason: 'PRIVATE_STATE_EVENT' });
    expect(rows.state?.state).toBe('QUARANTINED');
    expect(p.telemetry.events).toContainEqual(expect.objectContaining({ type: 'P18B_TRIPWIRE', certificateAgeMs: 5_000 }));
  });
});

// ---------------------------------------------------------------------------
// P18B-B-01 / B-02 / B-03 over the real repository
// ---------------------------------------------------------------------------

describe('P18B-B-01 the bracketed O-P-O-P-O pass over the real repository', () => {
  const other = [order('ord-1'), order('ord-9')];
  const otherPositions = [position('pos-1', { signedQuantity: '2' })];

  it.each([
    ['O1 != O2', (w: World) => { w.venue.onCall = (kind, index) => { if (kind === 'ORDERS' && index === 1) w.venue.orders = other; }; }],
    ['O2 != O3', (w: World) => { w.venue.onCall = (kind, index) => { if (kind === 'ORDERS' && index === 2) w.venue.orders = other; }; }],
    ['P1 != P2', (w: World) => { w.venue.onCall = (kind, index) => { if (kind === 'POSITIONS' && index === 1) w.venue.positions = otherPositions; }; }],
    ['a transient order change restored inside the bracket (only O2 saw it)', (w: World) => {
      const original = w.venue.orders;
      w.venue.onCall = (kind, index) => {
        if (kind === 'ORDERS' && index === 1) w.venue.orders = other;
        if (kind === 'ORDERS' && index === 2) w.venue.orders = original;
      };
    }],
  ])('%s: FAILED BRACKET_DISAGREEMENT, durably QUARANTINED on a released fence, no certificate', async (_label, arrange) => {
    if (skip()) return;
    const w = world();
    const p = processFor(w);
    const generation = await ready(w, p);
    arrange(w);
    expect(await p.service.certifyAccount()).toMatchObject({ kind: 'FAILED', failure: 'BRACKET_DISAGREEMENT', released: true });
    const rows = await durable(w.accountId);
    expect(rows.certificates).toHaveLength(0);
    expect(rows).toMatchObject({ state: { state: 'QUARANTINED' }, fence: { mode: 'IDLE', reconciliationGeneration: generation }, leases: 0 });
  });

  it.each([
    ['O1', 'ORDERS', 3],
    ['P1', 'POSITIONS', 2],
    ['O2', 'ORDERS', 4],
    ['P2', 'POSITIONS', 3],
    ['O3', 'ORDERS', 5],
  ] as const)('partial pagination in %s of pass 2 fails the certification; no certificate', async (_slot, kind, index) => {
    if (skip()) return;
    const w = world();
    const p = processFor(w);
    await ready(w, p);
    const incomplete = kind === 'ORDERS'
      ? { orders: [order('ord-1')], provenance: { source: 'COINDCX_FUTURES_ORDERS', localReadStartedAtMs: 1, localReadEndedAtMs: 2, complete: false, pagesRead: 100, incompleteReason: 'ORDER_PAGINATION_LIMIT_BUY' } }
      : { positions: [position('pos-1')], provenance: { source: 'COINDCX_FUTURES_POSITIONS', localReadStartedAtMs: 1, localReadEndedAtMs: 2, complete: false, pagesRead: 1, incompleteReason: 'POSITION_PAGE_LIMIT' } };
    w.venue.behavior = (readKind, readIndex) => (readKind === kind && readIndex === index ? { kind: 'VALUE', value: incomplete } : undefined);
    expect(await p.service.certifyAccount()).toMatchObject({ kind: 'FAILED', failure: 'PAGINATION_INCOMPLETE', released: true });
    const rows = await durable(w.accountId);
    expect(rows.certificates).toHaveLength(0);
    expect(rows.state?.state).toBe('QUARANTINED');
  });

  it('a change between passes (every bracket agrees) is caught ACROSS passes: OBSERVATION_DISAGREEMENT', async () => {
    if (skip()) return;
    const w = world();
    const p = processFor(w);
    await ready(w, p);
    w.venue.onCall = (kind, index) => { if (kind === 'ORDERS' && index === 3) w.venue.orders = other; };
    expect(await p.service.certifyAccount()).toMatchObject({ kind: 'FAILED', failure: 'OBSERVATION_DISAGREEMENT' });
    expect((await durable(w.accountId)).certificates).toHaveLength(0);
  });
});

describe('P18B-B-02 stream readiness over the real repository', () => {
  it('RECONCILIATION_REQUIRED during certification aborts it: SUPERSEDED, durably QUARANTINED, nothing issued', async () => {
    if (skip()) return;
    const w = world();
    const p = processFor(w);
    await ready(w, p);
    w.venue.onCall = (kind, index) => {
      if (kind === 'POSITIONS' && index === 3) w.stream.health = { ...w.stream.health, state: 'RECONCILIATION_REQUIRED', reconciliationRequired: true };
    };
    expect(await p.service.certifyAccount()).toMatchObject({ kind: 'SUPERSEDED', reason: 'WS_RECONNECTED' });
    const rows = await durable(w.accountId);
    expect(rows.certificates).toHaveLength(0);
    expect(rows).toMatchObject({ state: { state: 'QUARANTINED' }, fence: { mode: 'IDLE' } });
  });

  it('an issued certificate is durably revoked when the stream later enters RECONCILIATION_REQUIRED', async () => {
    if (skip()) return;
    const w = world();
    const p = processFor(w);
    await ready(w, p);
    const outcome = certified(await p.service.certifyAccount());
    w.stream.health = { ...w.stream.health, state: 'RECONCILIATION_REQUIRED', reconciliationRequired: true };
    expect(await p.service.monitorAuthority()).toEqual({ kind: 'NO_OUTSTANDING_CERTIFICATE', tripped: true });
    const rows = await durable(w.accountId);
    expect(rows.certificates[0]).toMatchObject({ certificateId: outcome.certificate.certificateId, status: 'REVOKED', terminalReason: 'WS_RECONNECTED' });
    expect(rows.state?.state).toBe('QUARANTINED');
  });

  it('a RECONCILIATION_REQUIRED stream cannot arm: certification is refused and nothing durable changes', async () => {
    if (skip()) return;
    const w = world();
    const p = processFor(w);
    await p.service.recoverAtStartup();
    const before = await durable(w.accountId);
    w.stream.health = { ...w.stream.health, state: 'RECONCILIATION_REQUIRED', reconciliationRequired: true };
    expect(await p.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'STREAM_RECONCILIATION_REQUIRED' });
    w.reconciliation.completeHealthyRun();
    expect(await p.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'NO_ACTIVE_WATCH' });
    const after = await durable(w.accountId);
    expect(after.state?.revision).toBe(before.state?.revision);
    expect(after.fence?.revision).toBe(before.fence?.revision);
    expect(w.venue.calls).toEqual([]);
  });
});

describe('P18B-B-04 positive readiness over the real repository', () => {
  it('an UNPROVEN stream (AUTH_JOIN_SENT, no provider confirmation: the real adapter shape) never certifies; nothing durable changes', async () => {
    if (skip()) return;
    const w = world();
    w.stream.unprove();
    const p = processFor(w);
    await p.service.recoverAtStartup();
    const before = await durable(w.accountId);
    for (let round = 0; round < 5; round += 1) {
      w.clock.advance(60 * 60_000);
      w.reconciliation.completeHealthyRun();
      expect(await p.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'STREAM_NO_PROVIDER_CONFIRMATION' });
      expect(await p.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'NO_ACTIVE_WATCH' });
    }
    const after = await durable(w.accountId);
    expect(after.certificates).toHaveLength(0);
    expect(after.state?.revision).toBe(before.state?.revision);
    expect(after.fence?.revision).toBe(before.fence?.revision);
    expect(w.venue.calls).toEqual([]);
  });

  it('readiness lost during O-P-O-P-O aborts the certification: SUPERSEDED, durably QUARANTINED, nothing issued', async () => {
    if (skip()) return;
    const w = world();
    const p = processFor(w);
    await ready(w, p);
    w.venue.onCall = (kind, index) => { if (kind === 'ORDERS' && index === 4) w.stream.unprove(); };
    expect(await p.service.certifyAccount()).toMatchObject({ kind: 'SUPERSEDED', reason: 'WS_JOIN_FAILED' });
    const rows = await durable(w.accountId);
    expect(rows.certificates).toHaveLength(0);
    expect(rows).toMatchObject({ state: { state: 'QUARANTINED' }, fence: { mode: 'IDLE' } });
  });

  it('readiness lost after issuance durably revokes the certificate', async () => {
    if (skip()) return;
    const w = world();
    const p = processFor(w);
    await ready(w, p);
    const outcome = certified(await p.service.certifyAccount());
    w.stream.unprove();
    expect(await p.service.monitorAuthority()).toEqual({ kind: 'NO_OUTSTANDING_CERTIFICATE', tripped: true });
    const rows = await durable(w.accountId);
    expect(rows.certificates[0]).toMatchObject({ certificateId: outcome.certificate.certificateId, status: 'REVOKED', terminalReason: 'WS_JOIN_FAILED' });
    expect(rows.state?.state).toBe('QUARANTINED');
  });
});

describe('P18B-B-03 calibration candidates vs hard ceilings over the real repository', () => {
  it('slow reads (over the candidate, under the hard timeout) certify; reads that add up past the hard pass ceiling fail closed', async () => {
    if (skip()) return;
    const slow = world();
    const p = processFor(slow);
    await ready(slow, p);
    slow.venue.latencyMs = 5_000;
    certified(await p.service.certifyAccount());
    expect(p.telemetry.events.filter((event) => event.type === 'P18B_READ' && event.readCandidateExceeded && !event.hardTimeout)).toHaveLength(21);

    const slower = world();
    const q = processFor(slower);
    await ready(slower, q);
    slower.venue.latencyMs = 10_000;
    expect(await q.service.certifyAccount()).toMatchObject({ kind: 'FAILED', failure: 'PASS_HARD_CEILING_EXCEEDED', released: true });
    expect((await durable(slower.accountId)).certificates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// P18B-B-05 / B-06 over the real repository
// ---------------------------------------------------------------------------

/** The real repository whose invalidate fails while `failing.on` (a durable revocation that cannot be written). */
function failableInvalidate(repository: PrismaPracticalSafetyRepository): { persistence: PracticalRecoveryPersistence; failing: { on: boolean }; attempts: () => number } {
  const failing = { on: false };
  let attempts = 0;
  const persistence = withOverrides(repository, {
    invalidate: async (input: Parameters<PracticalRecoveryPersistence['invalidate']>[0]) => {
      if (failing.on) {
        attempts += 1;
        throw new Error('injected fault: durable revocation unavailable');
      }
      return repository.invalidate(input);
    },
  });
  return { persistence, failing, attempts: () => attempts };
}

describe('P18B-B-05 post-persistence and monitor revalidation over the real repository', () => {
  it('Phase 18 generation G -> G+1 during finishCertification: never CERTIFIED; the committed G certificate is durably revoked', async () => {
    if (skip()) return;
    const w = world();
    const repository = new PrismaPracticalSafetyRepository(connectionA);
    const racing = withOverrides(repository, {
      finishCertification: async (input: Parameters<PracticalRecoveryPersistence['finishCertification']>[0]) => {
        const account = await repository.finishCertification(input);
        w.reconciliation.completeHealthyRun();
        return account;
      },
    });
    const p = processFor(w, { persistence: racing });
    const generation = await ready(w, p);
    expect(await p.service.certifyAccount()).toMatchObject({ kind: 'SUPERSEDED', reason: 'GENERATION_CHANGED' });
    const rows = await durable(w.accountId);
    expect(rows.certificates).toHaveLength(1);
    expect(rows.certificates[0]).toMatchObject({ reconciliationGeneration: generation, status: 'REVOKED', terminalReason: 'GENERATION_CHANGED' });
    expect(rows).toMatchObject({ state: { state: 'QUARANTINED' }, leases: 0 });
  });

  it('a private state event while monitorAuthority awaits the Phase 18 read: never STILL_VALID; durably revoked', async () => {
    if (skip()) return;
    const w = world();
    const p = processFor(w);
    await ready(w, p);
    const outcome = certified(await p.service.certifyAccount());
    expect(await p.service.monitorAuthority()).toEqual({ kind: 'CERTIFICATE_STILL_VALID' });
    w.reconciliation.onLoad = () => { w.reconciliation.onLoad = () => undefined; w.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION'); };
    expect(await p.service.monitorAuthority()).toEqual({ kind: 'CERTIFICATE_REVOKED', reason: 'PRIVATE_STATE_EVENT' });
    const rows = await durable(w.accountId);
    expect(rows.certificates[0]).toMatchObject({ certificateId: outcome.certificate.certificateId, status: 'REVOKED', terminalReason: 'PRIVATE_STATE_EVENT' });
    expect(rows.state?.state).toBe('QUARANTINED');
  });
});

describe('P18B-B-06 sticky trip and fail-closed stop over the real repository', () => {
  it('failed tripwire revocation -> sticky, unusable, no re-arm, never STILL_VALID -> restored -> explicit reset revokes -> only then a NEW watch, fresh generation, full certification', async () => {
    if (skip()) return;
    const w = world();
    const failable = failableInvalidate(new PrismaPracticalSafetyRepository(connectionA));
    const p = processFor(w, { persistence: failable.persistence });
    await ready(w, p);
    const old = certified(await p.service.certifyAccount());
    failable.failing.on = true;
    w.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    await p.service.settled();
    expect(failable.attempts()).toBe(3);
    // The DB write failed: the durable certificate physically remains ISSUED ...
    expect((await durable(w.accountId)).certificates[0]).toMatchObject({ certificateId: old.certificate.certificateId, status: 'ISSUED' });
    // ... but it is unusable: no re-arm, never STILL_VALID, no certification.
    expect(PracticalRecoveryCertificate.status(old.certificate)).toBe('REVOKED');
    expect(await p.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'WATCH_TRIPPED_RESET_REQUIRED' });
    expect(await p.service.monitorAuthority()).toEqual({ kind: 'REVOCATION_UNCONFIRMED', reason: 'PRIVATE_STATE_EVENT' });
    expect(await p.service.monitorAuthority()).toEqual({ kind: 'REVOCATION_UNCONFIRMED', reason: 'PRIVATE_STATE_EVENT' });
    expect(await p.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'DURABLE_SAFETY_UNCONFIRMED' });
    expect(await p.service.resetAfterRevocation()).toEqual({ kind: 'KEPT', problem: 'CERTIFICATE_OUTSTANDING' });

    failable.failing.on = false;
    expect(await p.service.resetAfterRevocation()).toEqual({ kind: 'RESET' });
    let rows = await durable(w.accountId);
    expect(rows.certificates[0]).toMatchObject({ certificateId: old.certificate.certificateId, status: 'REVOKED', terminalReason: 'PRIVATE_STATE_EVENT' });
    expect(rows.state?.state).toBe('QUARANTINED');

    expect(await p.service.startWatch()).toMatchObject({ kind: 'WATCHING' });
    expect(await p.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'RECONCILIATION_GENERATION_NOT_AFTER_WATCH' });
    w.reconciliation.completeHealthyRun();
    const fresh = certified(await p.service.certifyAccount());
    expect(fresh.certificate.certificateId).not.toBe(old.certificate.certificateId);
    rows = await durable(w.accountId);
    expect(rows.certificates.map((row) => row.status).sort()).toEqual(['ISSUED', 'REVOKED']);
    expect(rows.certificates.find((row) => row.certificateId === old.certificate.certificateId)?.status).toBe('REVOKED');
  });

  it('stopWatch with an outstanding certificate: refused while the revocation cannot be written, then revokes FIRST and stops', async () => {
    if (skip()) return;
    const w = world();
    const failable = failableInvalidate(new PrismaPracticalSafetyRepository(connectionA));
    const p = processFor(w, { persistence: failable.persistence });
    await ready(w, p);
    certified(await p.service.certifyAccount());
    failable.failing.on = true;
    expect(await p.service.stopWatch()).toEqual({ kind: 'REFUSED_AUTHORITY_OUTSTANDING', problem: 'REVOCATION_UNCONFIRMED' });
    expect(w.stream.listenerCount).toBe(1);
    expect(await p.service.monitorAuthority()).toMatchObject({ kind: 'REVOCATION_UNCONFIRMED' });
    failable.failing.on = false;
    expect(await p.service.stopWatch()).toEqual({ kind: 'STOPPED', revokedCertificate: true });
    expect(w.stream.listenerCount).toBe(0);
    const rows = await durable(w.accountId);
    expect(rows.certificates[0]).toMatchObject({ status: 'REVOKED', terminalReason: 'STREAM_INCARNATION_CHANGED' });
    expect(rows.state?.state).toBe('QUARANTINED');
  });

  it('a normal stop with no authority outstanding changes nothing durable', async () => {
    if (skip()) return;
    const w = world();
    const p = processFor(w);
    await ready(w, p);
    const before = await durable(w.accountId);
    expect(await p.service.stopWatch()).toEqual({ kind: 'STOPPED', revokedCertificate: false });
    const after = await durable(w.accountId);
    expect(after.state?.revision).toBe(before.state?.revision);
    expect(after.certificates).toHaveLength(0);
  });

  it('a restart (new runtime epoch) after a failed revocation adopts fail-closed: the old ISSUED certificate is revoked', async () => {
    if (skip()) return;
    const w = world();
    const failable = failableInvalidate(new PrismaPracticalSafetyRepository(connectionA));
    const p = processFor(w, { persistence: failable.persistence });
    await ready(w, p);
    const old = certified(await p.service.certifyAccount());
    failable.failing.on = true;
    w.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    await p.service.settled();
    expect((await durable(w.accountId)).certificates[0]?.status).toBe('ISSUED');
    const restarted = processFor(w, { epoch: EPOCH_B, connection: connectionB });
    expect(await restarted.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'ADOPTED', account: { state: 'QUARANTINED' } });
    expect((await durable(w.accountId)).certificates[0]).toMatchObject({ certificateId: old.certificate.certificateId, status: 'REVOKED', terminalReason: 'RUNTIME_EPOCH_CHANGED' });
  });
});

// ---------------------------------------------------------------------------
// P18B-B-07 / B-08 over the real repository
// ---------------------------------------------------------------------------

/** The real repository whose loadAccount can be made to return an ambiguous result or throw. */
function ambiguousLoads(repository: PrismaPracticalSafetyRepository): { persistence: PracticalRecoveryPersistence; mode: { value: 'REAL' | 'MALFORMED' | 'NOT_FOUND' | 'THROW' } } {
  const mode: { value: 'REAL' | 'MALFORMED' | 'NOT_FOUND' | 'THROW' } = { value: 'REAL' };
  const persistence = withOverrides(repository, {
    loadAccount: async (accountId: string) => {
      if (mode.value === 'MALFORMED') return { kind: 'MALFORMED' as const, problem: 'FENCE_ROW_INVALID' as const, reviewEpisodeId: null };
      if (mode.value === 'NOT_FOUND') return { kind: 'NOT_FOUND' as const };
      if (mode.value === 'THROW') throw new Error('injected fault: durable state unreadable');
      return repository.loadAccount(accountId);
    },
  } as Partial<PracticalRecoveryPersistence>);
  return { persistence, mode };
}

describe('P18B-B-07 ambiguous durable reads over the real repository', () => {
  it.each([
    ['MALFORMED', 'DURABLE_STATE_MALFORMED'],
    ['NOT_FOUND', 'DURABLE_STATE_NOT_FOUND'],
  ] as const)('issued certificate + %s read: stopWatch REFUSED, watch still observing, monitor fails closed; restored -> reset revokes durably', async (mode, problem) => {
    if (skip()) return;
    const w = world();
    const ambiguous = ambiguousLoads(new PrismaPracticalSafetyRepository(connectionA));
    const p = processFor(w, { persistence: ambiguous.persistence });
    await ready(w, p);
    const issued = certified(await p.service.certifyAccount());
    ambiguous.mode.value = mode;
    expect(await p.service.stopWatch()).toEqual({ kind: 'REFUSED_AUTHORITY_OUTSTANDING', problem });
    expect(w.stream.listenerCount).toBe(1);
    expect(await p.service.monitorAuthority()).toEqual({ kind: 'REVOCATION_UNCONFIRMED', reason: 'EVIDENCE_STALE' });
    expect(PracticalRecoveryCertificate.status(issued.certificate)).toBe('REVOKED');
    expect((await durable(w.accountId)).certificates[0]?.status).toBe('ISSUED');
    expect(await p.service.resetAfterRevocation()).toMatchObject({ kind: 'KEPT' });
    ambiguous.mode.value = 'REAL';
    expect(await p.service.resetAfterRevocation()).toEqual({ kind: 'RESET' });
    const rows = await durable(w.accountId);
    expect(rows.certificates[0]).toMatchObject({ certificateId: issued.certificate.certificateId, status: 'REVOKED', terminalReason: 'EVIDENCE_STALE' });
    expect(rows.state?.state).toBe('QUARANTINED');
  });
});

describe('P18B-B-08 startup never preserves authority over the real repository', () => {
  it('SAME runtime epoch + unexpired certificate: a restarted service durably revokes it before READY; a full new certification is then required', async () => {
    if (skip()) return;
    const w = world();
    const a = processFor(w);
    await ready(w, a);
    const issued = certified(await a.service.certifyAccount());
    const b = processFor(w, { connection: connectionB, stream: new FakePrivateStream() });
    expect(await b.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'REVOKED_CERTIFICATE', account: { state: 'QUARANTINED', currentCertificate: null } });
    const rows = await durable(w.accountId);
    expect(rows.certificates[0]).toMatchObject({ certificateId: issued.certificate.certificateId, status: 'REVOKED', terminalReason: 'EVIDENCE_STALE' });
    expect(rows).toMatchObject({ state: { state: 'QUARANTINED' }, fence: { runtimeEpoch: EPOCH, mode: 'IDLE' } });
    expect(await b.service.startWatch()).toMatchObject({ kind: 'WATCHING' });
    expect(await b.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'RECONCILIATION_GENERATION_NOT_AFTER_WATCH' });
    w.reconciliation.completeHealthyRun();
    expect(certified(await b.service.certifyAccount()).certificate.certificateId).not.toBe(issued.certificate.certificateId);
  });

  it('a startup revocation that cannot be written, or unreadable state: NOT READY; blocked until durable safety is proven', async () => {
    if (skip()) return;
    const w = world();
    const a = processFor(w);
    await ready(w, a);
    certified(await a.service.certifyAccount());
    const failable = failableInvalidate(new PrismaPracticalSafetyRepository(connectionB));
    const b = processFor(w, { persistence: failable.persistence });
    failable.failing.on = true;
    expect(await b.service.recoverAtStartup()).toEqual({ kind: 'BLOCKED_DURABLE_SAFETY_UNCONFIRMED', problem: 'REVOCATION_UNCONFIRMED' });
    expect((await durable(w.accountId)).certificates[0]?.status).toBe('ISSUED');
    expect(await b.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'DURABLE_SAFETY_UNCONFIRMED' });
    failable.failing.on = false;
    expect(await b.service.resetAfterRevocation()).toEqual({ kind: 'RESET' });
    expect((await durable(w.accountId)).certificates[0]?.status).toBe('REVOKED');

    const unreadable = ambiguousLoads(new PrismaPracticalSafetyRepository(connectionA));
    unreadable.mode.value = 'THROW';
    const c = processFor(world(), { persistence: unreadable.persistence });
    expect(await c.service.recoverAtStartup()).toEqual({ kind: 'BLOCKED_DURABLE_SAFETY_UNCONFIRMED', problem: 'PERSISTENCE_UNREADABLE' });
  });
});

// ---------------------------------------------------------------------------
// P18B-B-09 .. B-12 over the real repository
// ---------------------------------------------------------------------------

describe('P18B-B-09 / B-10 the durable fence of an in-flight certification over the real repository', () => {
  it('while a gated run owns CERTIFYING: stopWatch is REFUSED; a same-epoch restart is BLOCKED (not READY); a new epoch adopts; the stale run can never finish', async () => {
    if (skip()) return;
    const w = world();
    const gated = gatedFinish(new PrismaPracticalSafetyRepository(connectionA));
    const a = processFor(w, { persistence: gated.persistence });
    await ready(w, a);
    const pending = a.service.certifyAccount();
    await gated.reached;
    expect((await durable(w.accountId))).toMatchObject({ state: { state: 'CERTIFYING' }, fence: { mode: 'CERTIFYING' }, certificates: [] });
    expect(await a.service.stopWatch()).toEqual({ kind: 'REFUSED_AUTHORITY_OUTSTANDING', problem: 'CERTIFICATION_IN_PROGRESS' });
    expect(w.stream.listenerCount).toBe(1);

    const sameEpoch = processFor(w, { connection: connectionB, stream: new FakePrivateStream() });
    expect(await sameEpoch.service.recoverAtStartup()).toEqual({ kind: 'BLOCKED_DURABLE_SAFETY_UNCONFIRMED', problem: 'CERTIFICATION_IN_PROGRESS' });
    expect((await durable(w.accountId))).toMatchObject({ state: { state: 'CERTIFYING' }, fence: { mode: 'CERTIFYING', runtimeEpoch: EPOCH } });

    const newEpoch = processFor(w, { epoch: EPOCH_B, connection: connectionB, stream: new FakePrivateStream() });
    expect(await newEpoch.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'ADOPTED', account: { state: 'QUARANTINED' } });
    gated.open();
    expect(await pending).toMatchObject({ kind: 'FAILED', failure: 'PERSISTENCE_REFUSED' });
    const rows = await durable(w.accountId);
    expect(rows.certificates).toHaveLength(0);
    expect(rows).toMatchObject({ state: { state: 'QUARANTINED' }, fence: { mode: 'IDLE', runtimeEpoch: EPOCH_B } });
  });

  it('a gated run that completes: the stop that was refused mid-run now revokes first and stops', async () => {
    if (skip()) return;
    const w = world();
    const gated = gatedFinish(new PrismaPracticalSafetyRepository(connectionA));
    const a = processFor(w, { persistence: gated.persistence });
    await ready(w, a);
    const pending = a.service.certifyAccount();
    await gated.reached;
    expect(await a.service.stopWatch()).toEqual({ kind: 'REFUSED_AUTHORITY_OUTSTANDING', problem: 'CERTIFICATION_IN_PROGRESS' });
    gated.open();
    certified((await pending) as PracticalCertificationOutcome);
    expect(await a.service.stopWatch()).toEqual({ kind: 'STOPPED', revokedCertificate: true });
    expect((await durable(w.accountId)).certificates[0]?.status).toBe('REVOKED');
  });
});

describe('P18B-B-11 the final pre-issuance stream guard over the real repository', () => {
  it('a private event during the final pre-issuance generation await: finishCertification is never called; no certificate row', async () => {
    if (skip()) return;
    const w = world();
    const repository = new PrismaPracticalSafetyRepository(connectionA);
    let finishCalls = 0;
    const counting = withOverrides(repository, {
      finishCertification: (input: Parameters<PracticalRecoveryPersistence['finishCertification']>[0]) => {
        finishCalls += 1;
        return repository.finishCertification(input);
      },
    });
    const p = processFor(w, { persistence: counting });
    await ready(w, p);
    let readsAfterLastPass = 0;
    w.reconciliation.onLoad = () => {
      if (w.venue.calls.length !== 21) return;
      readsAfterLastPass += 1;
      if (readsAfterLastPass === 2) w.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    };
    expect(await p.service.certifyAccount()).toMatchObject({ kind: 'SUPERSEDED', reason: 'PRIVATE_STATE_EVENT' });
    expect(finishCalls).toBe(0);
    const rows = await durable(w.accountId);
    expect(rows.certificates).toHaveLength(0);
    expect(rows).toMatchObject({ state: { state: 'QUARANTINED' }, fence: { mode: 'IDLE' } });
  });
});

describe('P18B-B-12 the account-bound Phase 18 baseline over the real repository', () => {
  it('a baseline row of another account never establishes a watch; the correct baseline requires a fresh generation', async () => {
    if (skip()) return;
    const w = world();
    const p = processFor(w);
    await p.service.recoverAtStartup();
    for (let run = 0; run < 10; run += 1) w.reconciliation.completeHealthyRun();
    w.reconciliation.transform = (state) => ({ ...state, accountId: `${w.accountId}-other`, currentGeneration: 0, healthyGeneration: 0 });
    expect(await p.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'RECONCILIATION_ACCOUNT_MISMATCH' });
    w.reconciliation.transform = (state) => state;
    expect(await p.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'NO_ACTIVE_WATCH' });
    expect(await p.service.startWatch()).toMatchObject({ kind: 'WATCHING', reconciliationGenerationAtArm: 10 });
    expect(await p.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'RECONCILIATION_GENERATION_NOT_AFTER_WATCH' });
    expect((await durable(w.accountId)).certificates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Crash / restart: restart never trusts an in-memory certification
// ---------------------------------------------------------------------------

describe('P18B-CKPT-B-DB crash and restart', () => {
  it('CRASH BEFORE THE FIRST OBSERVATION: restart adopts CERTIFYING -> QUARANTINED; the dead run can never finish', async () => {
    if (skip()) return;
    const w = world();
    const a = processFor(w);
    await ready(w, a);
    a.scheduler.hold();
    w.venue.behavior = (kind, index) => (kind === 'IDENTITY' && index === 0 ? { kind: 'HANG' } : undefined);
    const dead = a.service.certifyAccount();
    await until(() => w.venue.calls.length === 1, 'the first identity read to start (and hang)');
    expect((await durable(w.accountId)).state?.state).toBe('CERTIFYING');

    const b = processFor(w, { epoch: EPOCH_B, connection: connectionB });
    expect(await b.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'ADOPTED', account: { state: 'QUARANTINED', fence: { runtimeEpoch: EPOCH_B, mode: { kind: 'IDLE' } } } });
    w.venue.behavior = () => undefined;
    expect(await b.service.startWatch()).toMatchObject({ kind: 'WATCHING' });
    w.reconciliation.completeHealthyRun(EPOCH_B);
    const fresh = certified(await b.service.certifyAccount());

    a.scheduler.release();
    expect(await dead).toMatchObject({ kind: 'FAILED', released: false });
    const rows = await durable(w.accountId);
    expect(rows.certificates).toHaveLength(1);
    expect(rows.certificates[0]).toMatchObject({ certificateId: fresh.certificate.certificateId, status: 'ISSUED', runtimeEpoch: EPOCH_B });
  });

  it('CRASH BETWEEN PASSES: restart from CERTIFYING resets to QUARANTINED/IDLE and the dead run issues nothing', async () => {
    if (skip()) return;
    const w = world();
    const a = processFor(w);
    await ready(w, a);
    w.venue.onCall = (kind, index) => { if (kind === 'POSITIONS' && index === 0) a.scheduler.hold(); };
    const dead = a.service.certifyAccount();
    await until(() => w.venue.calls.length === 7, 'pass 1 to finish its seven bracketed reads');
    // Pass 1's post-pass Phase 18 check runs, then the pause before pass 2 is held: the "process" is frozen between passes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(w.venue.calls.map((call) => call.kind)).toEqual(['IDENTITY', 'ORDERS', 'POSITIONS', 'ORDERS', 'POSITIONS', 'ORDERS', 'IDENTITY']);
    expect((await durable(w.accountId)).state?.state).toBe('CERTIFYING');
    const b = processFor(w, { epoch: EPOCH_B });
    expect(await b.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'ADOPTED', account: { state: 'QUARANTINED' } });
    w.venue.onCall = () => undefined;
    a.scheduler.release();
    expect(await dead).toMatchObject({ kind: 'FAILED', released: false });
    const rows = await durable(w.accountId);
    expect(rows.certificates).toHaveLength(0);
    expect(rows).toMatchObject({ state: { state: 'QUARANTINED' }, fence: { mode: 'IDLE', runtimeEpoch: EPOCH_B } });
  });

  it('CRASH AFTER FINAL EVIDENCE, BEFORE CERTIFICATE PERSISTENCE: the stale persist is refused after the restart', async () => {
    if (skip()) return;
    const w = world();
    const gated = gatedFinish(new PrismaPracticalSafetyRepository(connectionA));
    const a = processFor(w, { persistence: gated.persistence });
    await ready(w, a);
    const dead = a.service.certifyAccount();
    await gated.reached;
    const b = processFor(w, { epoch: EPOCH_B, connection: connectionB });
    expect(await b.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'ADOPTED' });
    gated.open();
    expect(await dead).toMatchObject({ kind: 'FAILED', failure: 'PERSISTENCE_REFUSED', released: false });
    const rows = await durable(w.accountId);
    expect(rows.certificates).toHaveLength(0);
    expect(rows).toMatchObject({ state: { state: 'QUARANTINED' }, fence: { mode: 'IDLE', runtimeEpoch: EPOCH_B } });
  });

  it('CRASH DURING CERTIFICATE PERSISTENCE: rolled back, the process dies before releasing, restart finds no certificate', async () => {
    if (skip()) return;
    const w = world();
    const repository = new PrismaPracticalSafetyRepository(connectionA);
    const faulty = new PrismaPracticalSafetyRepository(faultyClient('livePracticalAccountFence', 'updateMany'));
    // The dying process can neither persist (rollback) nor release its fence.
    const dying: PracticalRecoveryPersistence = withOverrides(repository, {
      finishCertification: (input: Parameters<PracticalRecoveryPersistence['finishCertification']>[0]) => faulty.finishCertification(input),
      failCertification: () => Promise.reject(new Error('process died')),
    });
    const a = processFor(w, { persistence: dying });
    await ready(w, a);
    expect(await a.service.certifyAccount()).toMatchObject({ kind: 'FAILED', released: false });
    expect((await durable(w.accountId))).toMatchObject({ state: { state: 'CERTIFYING' }, fence: { mode: 'CERTIFYING' }, certificates: [] });
    const b = processFor(w, { epoch: EPOCH_B });
    expect(await b.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'ADOPTED', account: { state: 'QUARANTINED', fence: { mode: { kind: 'IDLE' } } } });
    expect((await durable(w.accountId)).certificates).toHaveLength(0);
  });

  it('RESTART WITH AN ISSUED BUT EXPIRED CERTIFICATE: a new runtime revokes it; the same runtime expires it', async () => {
    if (skip()) return;
    const w = world();
    const a = processFor(w);
    await ready(w, a);
    const issued = certified(await a.service.certifyAccount());
    w.clock.advance(200_000);
    const sameEpoch = processFor(w);
    expect(await sameEpoch.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'EXPIRED_CERTIFICATE', account: { state: 'QUARANTINED' } });
    expect((await durable(w.accountId)).certificates[0]).toMatchObject({ certificateId: issued.certificate.certificateId, status: 'EXPIRED', terminalReason: 'CERTIFICATE_EXPIRED' });

    const w2 = world();
    const c = processFor(w2);
    await ready(w2, c);
    certified(await c.service.certifyAccount());
    // A hard crash: no graceful stop runs; the next runtime epoch's adoption is the fail-closed path.
    w2.clock.advance(200_000);
    const restarted = processFor(w2, { epoch: EPOCH_B });
    expect(await restarted.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'ADOPTED', account: { state: 'QUARANTINED' } });
    expect((await durable(w2.accountId)).certificates[0]).toMatchObject({ status: 'REVOKED', terminalReason: 'RUNTIME_EPOCH_CHANGED' });
  });

  it('RESTART AFTER THE WS INCARNATION CHANGED: the old certificate is revoked; the reconnected stream cannot certify; only a READY stream can', async () => {
    if (skip()) return;
    const w = world();
    // Process A had its own stream instance and then crashed (no graceful stop): nothing it owned observes anything any more.
    const a = processFor(w, { stream: new FakePrivateStream() });
    await ready(w, a);
    const old = certified(await a.service.certifyAccount());
    w.stream.reconnect();
    const b = processFor(w, { epoch: EPOCH_B });
    expect(await b.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'ADOPTED' });
    expect((await durable(w.accountId)).certificates[0]).toMatchObject({ certificateId: old.certificate.certificateId, status: 'REVOKED', terminalReason: 'RUNTIME_EPOCH_CHANGED' });
    // The reconnected stream (incarnation 2) is RECONCILIATION_REQUIRED: no watch, no certification, no durable change.
    expect(await b.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'STREAM_RECONCILIATION_REQUIRED' });
    w.reconciliation.completeHealthyRun(EPOCH_B);
    expect(await b.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'NO_ACTIVE_WATCH' });
    expect(await durable(w.accountId)).toMatchObject({ state: { state: 'QUARANTINED' }, fence: { mode: 'IDLE' }, certificates: [{ status: 'REVOKED' }] });
    // A process with a FRESH (deterministic test) stream instance, clean first connection AND a provider confirmation (PROVEN_READY), can arm and certify from scratch.
    const c = processFor(w, { epoch: EPOCH_B, stream: new FakePrivateStream(), connection: connectionB });
    expect(await c.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'UNCHANGED' });
    expect(await c.service.startWatch()).toMatchObject({ kind: 'WATCHING', watch: { binding: { incarnation: 1, state: 'AUTH_JOIN_SENT' } } });
    w.reconciliation.completeHealthyRun(EPOCH_B);
    const fresh = certified(await c.service.certifyAccount());
    expect(PracticalRecoveryCertificate.read(fresh.certificate)).toMatchObject({ streamIncarnation: 1, runtimeEpoch: EPOCH_B });
    expect((await durable(w.accountId)).leases).toBe(0);
  });
});
