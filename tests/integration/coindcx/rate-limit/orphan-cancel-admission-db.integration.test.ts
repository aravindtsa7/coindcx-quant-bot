import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  LiveReconciliationService,
  PrismaLiveReconciliationRepository,
  resolveOrphanCleanupPolicy,
} from '../../../../src/execution/live/reconciliation';
import { newLiveRuntimeIdentity } from '../../../../src/execution/live/reconciliation/barrier';
import { GatewayOrphanCancellation } from '../../../../src/execution/live/reconciliation/gateway-orphan-cancellation';
import type { LiveOrphanCancelBudgetPort } from '../../../../src/execution/live/reconciliation/ports';
import type { LiveVenueEvidenceSet } from '../../../../src/execution/live/reconciliation/types';
import { PrismaLiveExecutionRepository } from '../../../../src/execution/live/repository';
import { createLiveMutationBudgetPort } from '../../../../src/integration/coindcx/live/mutation-budget-ports';
import { CoinDcxLiveFuturesOrderGateway } from '../../../../src/integration/coindcx/live/order-gateway';
import { RateLimitClient } from '../../../../src/integration/coindcx/rate-limit/runtime/client';
import { RateLimitCoordinator } from '../../../../src/integration/coindcx/rate-limit/runtime/coordinator';
import { createCoordinatorMutationBudget } from '../../../../src/integration/coindcx/rate-limit/runtime/mutation-budget';
import { emptyMutationBudgetRecord, grantingMutationBudget } from '../../../helpers/mutation-budget-fixture';
import { DisposableMysqlGuardError, DisposableMysqlLifecycle, generateDisposableDatabaseName } from '../../../helpers/p18b-disposable-mysql';
import { fixtureTransportBudget } from '../../../helpers/read-budget-fixture';
import { EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT, FakeEvidenceProvider, FixedClock, evidenceSet, venueOrder } from '../../../unit/execution/live/reconciliation/helpers';
import { cleanup as cleanupLimiterFixtures, clientConfig, fixture, limiterFixture, sleep, waitFor } from './support';

// M2: DB-backed proof of the Phase 18 orphan-cancellation budget admission over the REAL Prisma reconciliation
// repository (durable claim, row-locked arm, completion) on a disposable MySQL database, with the real orphan adapter,
// order gateway and mutation transport against a loopback venue. Synthetic account, credentials and policy (the genuine
// configuration gate, for a test account only). No provider request, no external network, no production composition.
//
// Placement: with the M2 rate-limit integration suites, which construct the real gateway against a loopback venue
// (pinned by the Phase 17 loopback rule). The Phase 18 rule forbids any real-gateway construction in reconciliation-
// named test files, so this suite is deliberately not one of them.
//
// ACCEPTANCE SEMANTICS (the Stage 1B2 convention): soft-skips without a reachable disposable MySQL; with
// REQUIRE_LIVE_RECONCILIATION_ORPHAN_BUDGET_DB_INTEGRATION=1 `beforeAll` THROWS instead. The database is created and
// dropped only through `DisposableMysqlLifecycle` (loopback mysql: URL, p18b_cancel_store_test_<12 hex> name).
const STRICT = process.env['REQUIRE_LIVE_RECONCILIATION_ORPHAN_BUDGET_DB_INTEGRATION'] === '1';
const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const SHADOW_DB_NAME = generateDisposableDatabaseName();
const TIMEOUT = 60_000;

let lifecycle: DisposableMysqlLifecycle | null = null;
let dbAvailable = false;
let connectionA: PrismaClient;
let connectionB: PrismaClient;

beforeAll(async () => {
  if (!BASE_DATABASE_URL) {
    if (STRICT) throw new Error('[M2-ORPHAN-DB] REQUIRE_LIVE_RECONCILIATION_ORPHAN_BUDGET_DB_INTEGRATION=1 but no DATABASE_URL is configured.');
    return;
  }
  let guarded: DisposableMysqlLifecycle;
  try {
    guarded = new DisposableMysqlLifecycle({ rawBaseUrl: BASE_DATABASE_URL, name: SHADOW_DB_NAME, strict: STRICT });
  } catch (error) {
    const reason = error instanceof DisposableMysqlGuardError ? error.message : (error as Error).name;
    if (STRICT) throw new Error(`[M2-ORPHAN-DB] strict mode refused to provision: ${reason}`);
    console.warn(`M2 orphan budget DB suite skipped: ${reason}`);
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
    for (const client of [connectionA, connectionB]) await client.$queryRawUnsafe('SELECT 1');
    dbAvailable = true;
  } catch (error) {
    dbAvailable = false;
    let cleanupFailure = '';
    try {
      await guarded.cleanup();
    } catch (cleanupError) {
      cleanupFailure = `; cleanup ALSO failed: ${cleanupError instanceof DisposableMysqlGuardError ? cleanupError.message : (cleanupError as Error).name}`;
    }
    if (STRICT) throw new Error(`[M2-ORPHAN-DB] strict mode could not provision a disposable MySQL database: ${(error as Error).name}${cleanupFailure}`);
  }
}, 180_000);

afterAll(async () => {
  dbAvailable = false;
  if (lifecycle !== null) await lifecycle.cleanup();
}, 30_000);

const stops: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); cleanupLimiterFixtures(); });

function skip(): boolean {
  if (dbAvailable) return false;
  if (STRICT) throw new Error('[M2-ORPHAN-DB] strict mode reached a test body with no database connection.');
  console.warn('M2 orphan budget DB suite skipped: no reachable disposable MySQL. Set REQUIRE_LIVE_RECONCILIATION_ORPHAN_BUDGET_DB_INTEGRATION=1 to make this hard.');
  return true;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CANCEL_PATH = '/exchange/v1/derivatives/futures/orders/cancel';
const CANCELLED = { status: 200, body: '{"message":"success","status":200,"code":200}' };
type Answer = { status: number; body: string } | 'DESTROY';
interface Venue { baseUrl: string; hits: string[]; respond: () => Answer | Promise<Answer> }
async function startVenue(): Promise<Venue> {
  const state: Venue = { baseUrl: '', hits: [], respond: () => CANCELLED };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      state.hits.push(req.url ?? '');
      void Promise.resolve(state.respond()).then((answer) => {
        if (answer === 'DESTROY') { req.socket.destroy(); return; }
        res.writeHead(answer.status, { 'content-type': 'application/json' }); res.end(answer.body);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stops.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return state;
}

let sequence = 0;
function freshAccount(): string {
  sequence += 1;
  return `m2-orphan-account-${process.pid.toString(16)}-${sequence.toString(16)}`;
}

/** One visible orphan on a per-test account, re-anchored to the wall clock (as the reconciliation DB suite does). */
function orphanEvidence(accountId: string, exchangeOrderId: string): LiveVenueEvidenceSet {
  const base = evidenceSet({ orders: [venueOrder({ exchangeOrderId })] });
  const readEnd = Date.now();
  const observed = readEnd - 500;
  return Object.freeze({
    ...base,
    accountId,
    orders: Object.freeze(base.orders.map((order) => Object.freeze({ ...order, providerCreatedAtMs: observed - 500, providerEventTimeMs: observed }))),
    positions: Object.freeze(base.positions.map((position) => Object.freeze({ ...position, providerEventTimeMs: observed }))),
    ordersProvenance: Object.freeze({ ...base.ordersProvenance, localReadStartedAtMs: readEnd - 2_000, localReadEndedAtMs: readEnd }),
    positionsProvenance: Object.freeze({ ...base.positionsProvenance, localReadStartedAtMs: readEnd, localReadEndedAtMs: readEnd + 100 }),
    evaluatedAtMs: readEnd + 200,
  });
}

/** The real Prisma repository; the durable arm can be delayed or interleaved, and each step is logged. */
class ObservedPrismaReconciliationRepository extends PrismaLiveReconciliationRepository {
  public readonly log: string[] = [];
  public beforeArm: (() => Promise<void>) | null = null;
  public override async armOrphanCancelWire(...args: Parameters<PrismaLiveReconciliationRepository['armOrphanCancelWire']>) {
    this.log.push('armOrphanCancelWire');
    if (this.beforeArm !== null) await this.beforeArm();
    return super.armOrphanCancelWire(...args);
  }
}

function loggedBudget(inner: LiveOrphanCancelBudgetPort, log: string[]): LiveOrphanCancelBudgetPort {
  return { admit: async (request) => { log.push('admit'); return inner.admit(request); }, release: (permit) => { log.push('release'); inner.release(permit); } };
}

async function harness(client: PrismaClient = connectionA) {
  const accountId = freshAccount();
  const exchangeOrderId = `stranger-${accountId}`;
  const venue = await startVenue();
  const repository = new ObservedPrismaReconciliationRepository(client);
  const gateway = new CoinDcxLiveFuturesOrderGateway({ apiKey: 'synthetic-db-orphan-key', apiSecret: 'synthetic-db-orphan-secret', baseUrl: venue.baseUrl, readBudget: fixtureTransportBudget() });
  const resolution = resolveOrphanCleanupPolicy({ LIVE_ORPHAN_CANCELLATION_ENABLED: 'true', LIVE_ORPHAN_CANCELLATION_ACCOUNT_ALLOWLIST: accountId });
  if (resolution.status !== 'ENABLED') throw new Error('synthetic test policy did not resolve');
  const service = (budget: LiveOrphanCancelBudgetPort | undefined, connection: PrismaClient = client) => new LiveReconciliationService({
    repository: connection === client ? repository : new PrismaLiveReconciliationRepository(connection),
    executionRepository: new PrismaLiveExecutionRepository(connection),
    evidenceProvider: new FakeEvidenceProvider(orphanEvidence(accountId, exchangeOrderId)),
    runtimeIdentity: newLiveRuntimeIdentity(), credentialAccountId: accountId,
    expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT, clock: new FixedClock(),
    orphanPolicy: resolution.policy, orphanCancellation: new GatewayOrphanCancellation(gateway),
    orphanCancellationBudget: budget === undefined ? undefined : loggedBudget(budget, repository.log), requestTimeoutMs: 5000,
  });
  const row = () => connectionB.liveOrphanVenueOrder.findUnique({ where: { accountId_exchangeOrderId: { accountId, exchangeOrderId } } });
  return { accountId, exchangeOrderId, venue, repository, service, row };
}

async function limiter(options: Record<string, unknown> = {}) {
  const f = fixture(limiterFixture(options));
  const started = await RateLimitCoordinator.start(f.coordinator);
  if (started.kind !== 'RUNNING') throw new Error(JSON.stringify(started));
  stops.push(() => started.coordinator.close());
  const connect = async () => { const c = new RateLimitClient(clientConfig(f.pipe)); stops.push(() => c.close()); expect(await c.connect()).toBe(true); return c; };
  return { coordinator: started.coordinator, connect };
}
const coordinatorBudget = (c: RateLimitClient) => createLiveMutationBudgetPort(createCoordinatorMutationBudget(c, { cls: 'P0', deadlineInMs: 5000 }));
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('M2-DB orphan cancellation: authorized path and unchanged outcomes on real MySQL', () => {
  it('admission before the durable arm; exactly one request; STARTED and completion once; durably acknowledged', async () => {
    if (skip()) return;
    const record = emptyMutationBudgetRecord();
    const h = await harness();
    await h.service(createLiveMutationBudgetPort(grantingMutationBudget(record))).reconcileAccount(h.accountId);
    expect(h.repository.log).toEqual(['admit', 'armOrphanCancelWire', 'release']);
    expect(h.venue.hits).toEqual([CANCEL_PATH]);
    expect(await h.row()).toMatchObject({ cancelState: 'CANCEL_ACKNOWLEDGED', cancelGeneration: 1, cancelWireArmed: false });
    await waitFor(() => record.completed === 1, 5000, 'completion at request close');
    expect(record).toMatchObject({ acquired: 1, consumed: 1, started: 1, completed: 1, released: 0, operations: ['CANCEL'] });
  }, TIMEOUT);

  it('a definite provider rejection stays definite; an ambiguous cancel stays ambiguous and is never resent across connections', async () => {
    if (skip()) return;
    const definite = await harness();
    definite.venue.respond = () => ({ status: 400, body: '{"message":"order not cancellable","code":"400"}' });
    await definite.service(createLiveMutationBudgetPort(grantingMutationBudget())).reconcileAccount(definite.accountId);
    expect(definite.venue.hits).toEqual([CANCEL_PATH]);
    expect(await definite.row()).toMatchObject({ cancelState: 'CANCEL_REJECTED', cancelFaultCode: 'HTTP_400' });

    const record = emptyMutationBudgetRecord();
    const port = createLiveMutationBudgetPort(grantingMutationBudget(record));
    const ambiguous = await harness();
    ambiguous.venue.respond = () => 'DESTROY';
    const first = await ambiguous.service(port).reconcileAccount(ambiguous.accountId);
    if (first.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(first.result.findings.some((finding) => finding.code === 'RECON_ORPHAN_CANCEL_AMBIGUOUS')).toBe(true);
    expect(await ambiguous.row()).toMatchObject({ cancelState: 'CANCEL_AMBIGUOUS', cancelFaultCode: 'LIVE_ORPHAN_CANCEL_AMBIGUOUS', cancelGeneration: 1 });
    // A later run on the other connection re-asserts the finding without reaching admission or the wire.
    const later = await ambiguous.service(port, connectionB).reconcileAccount(ambiguous.accountId);
    if (later.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(later.result.findings.some((finding) => finding.code === 'RECON_ORPHAN_CANCEL_AMBIGUOUS')).toBe(true);
    expect(ambiguous.venue.hits).toEqual([CANCEL_PATH]);
    expect(ambiguous.repository.log.filter((entry) => entry === 'admit')).toHaveLength(1);
    expect(await ambiguous.row()).toMatchObject({ cancelState: 'CANCEL_AMBIGUOUS', cancelGeneration: 1 });
    await waitFor(() => record.completed === 1, 5000, 'completion at request close');
    expect(record).toMatchObject({ acquired: 1, consumed: 1, started: 1, completed: 1 });
  }, TIMEOUT);
});

describe('M2-DB orphan cancellation: budget refusal records the current terminal claim/result state with zero transmission', () => {
  it('missing, refusing and unavailable budgets: zero requests; CANCEL_REJECTED/BUDGET_REFUSED; later runs do not re-attempt', async () => {
    if (skip()) return;
    // Never connected (connect() is not called): every acquisition is UNAVAILABLE/NOT_CONNECTED.
    const offline = new RateLimitClient(clientConfig(fixture().pipe)); stops.push(() => offline.close());
    const cases: Array<[string, LiveOrphanCancelBudgetPort | undefined]> = [
      ['missing', undefined],
      ['refusing', { admit: async () => null, release: () => undefined }],
      ['coordinator unavailable', coordinatorBudget(offline)],
    ];
    for (const [label, budget] of cases) {
      const h = await harness();
      await h.service(budget).reconcileAccount(h.accountId);
      expect(h.venue.hits, label).toEqual([]);
      // The current (unchanged) classification: terminal for automatic cleanup. Recorded, not approved for production.
      expect(await h.row(), label).toMatchObject({ cancelState: 'CANCEL_REJECTED', cancelFaultCode: 'BUDGET_REFUSED', cancelGeneration: 1, cancelWireArmed: false });
      await h.service(createLiveMutationBudgetPort(grantingMutationBudget()), connectionB).reconcileAccount(h.accountId);
      expect(h.venue.hits, `${label}: no later re-attempt`).toEqual([]);
      expect(await h.row(), label).toMatchObject({ cancelState: 'CANCEL_REJECTED', cancelFaultCode: 'BUDGET_REFUSED', cancelGeneration: 1 });
    }
  }, TIMEOUT);
});

describe('M2-DB orphan cancellation: invalidation while admission waits; expiry and revocation during the durable arm', () => {
  it('ownership superseded on another connection while admission waits: the durable arm is fenced out, zero requests, the permit is released unused, the unarmed claim is reclaimed by the next run', async () => {
    if (skip()) return;
    const record = emptyMutationBudgetRecord();
    const genuine = createLiveMutationBudgetPort(grantingMutationBudget(record));
    const gate = deferred();
    const h = await harness();
    const waiting: LiveOrphanCancelBudgetPort = { admit: async (request) => { await gate.promise; return genuine.admit(request); }, release: (permit) => genuine.release(permit) };
    const run = h.service(waiting).reconcileAccount(h.accountId);
    await waitFor(() => h.repository.log.includes('admit'), 10_000, 'admission waiting');
    const superseding = await new PrismaLiveReconciliationRepository(connectionB).claimGeneration(h.accountId, newLiveRuntimeIdentity(), Date.now());
    expect(superseding.kind).toBe('CLAIMED');
    gate.resolve();
    await expect(run).rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_STALE_GENERATION' });
    expect(h.repository.log).toEqual(['admit', 'armOrphanCancelWire', 'release']);
    expect(h.venue.hits).toEqual([]);
    expect(record).toMatchObject({ acquired: 1, consumed: 0, started: 0, released: 1 });
    // Durable state is certain (never armed): the claim is kept, not released in-run.
    expect(await h.row()).toMatchObject({ cancelState: 'CANCEL_CLAIMED', cancelWireArmed: false, cancelGeneration: 1 });
    // The next run's existing recovery reclaims it with zero requests; that run then passes every gate and a fresh
    // admission, and reaches the wire once.
    h.repository.log.length = 0;
    await h.service(genuine).reconcileAccount(h.accountId);
    expect(h.venue.hits).toEqual([CANCEL_PATH]);
    expect(await h.row()).toMatchObject({ cancelState: 'CANCEL_ACKNOWLEDGED', cancelGeneration: 2 });
  }, TIMEOUT);

  it('permit expiry during the durable arm: refused before transmission; existing classification; capacity refunded', async () => {
    if (skip()) return;
    const l = await limiter({ grantTtlMs: 150 });
    const c = await l.connect();
    const h = await harness();
    h.repository.beforeArm = () => sleep(400);
    await h.service(coordinatorBudget(c)).reconcileAccount(h.accountId);
    expect(h.repository.log).toEqual(['admit', 'armOrphanCancelWire', 'release']);
    expect(h.venue.hits).toEqual([]);
    expect(await h.row()).toMatchObject({ cancelState: 'CANCEL_REJECTED', cancelFaultCode: 'BUDGET_REFUSED', cancelGeneration: 1 });
    await waitFor(() => l.coordinator.state.charges.length === 0, 5000, 'expired grant refunded (NOT_STARTED)');
  }, TIMEOUT);

  it('revocation during the durable arm (coordinator STOP from an operator client): refused before transmission', async () => {
    if (skip()) return;
    const l = await limiter();
    const c = await l.connect();
    const operator = await l.connect();
    const h = await harness();
    h.repository.beforeArm = async () => {
      expect((await operator.control('STOP')).result).toBe('APPLIED');
      await waitFor(() => c.view.admission === 'STOPPED', 5000, 'revocation reached the worker');
    };
    await h.service(coordinatorBudget(c)).reconcileAccount(h.accountId);
    expect(h.repository.log).toEqual(['admit', 'armOrphanCancelWire', 'release']);
    expect(h.venue.hits).toEqual([]);
    expect(await h.row()).toMatchObject({ cancelState: 'CANCEL_REJECTED', cancelFaultCode: 'BUDGET_REFUSED', cancelGeneration: 1 });
    await waitFor(() => l.coordinator.state.charges.length === 0, 5000, 'revoked grant refunded');
  }, TIMEOUT);
});
