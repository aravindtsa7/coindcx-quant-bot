import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { LiveMutationBudgetPort } from '../../../../src/execution/live/gateway';
import { LiveReconciliationService, resolveOrphanCleanupPolicy } from '../../../../src/execution/live/reconciliation';
import { newLiveRuntimeIdentity } from '../../../../src/execution/live/reconciliation/barrier';
import { GatewayOrphanCancellation } from '../../../../src/execution/live/reconciliation/gateway-orphan-cancellation';
import { createLiveMutationBudgetPort } from '../../../../src/integration/coindcx/live/mutation-budget-ports';
import { CoinDcxLiveFuturesOrderGateway } from '../../../../src/integration/coindcx/live/order-gateway';
import { engageAdmissionStop } from '../../../../src/integration/coindcx/rate-limit/runtime/admission-stop';
import { RateLimitClient } from '../../../../src/integration/coindcx/rate-limit/runtime/client';
import { RateLimitCoordinator } from '../../../../src/integration/coindcx/rate-limit/runtime/coordinator';
import { createCoordinatorMutationBudget, releaseMutationPermit } from '../../../../src/integration/coindcx/rate-limit/runtime/mutation-budget';
import { createCoordinatorReadBudget } from '../../../../src/integration/coindcx/rate-limit/runtime/read-budget';
import { emptyMutationBudgetRecord, fixtureMutationPermitSync, grantingMutationBudget } from '../../../helpers/mutation-budget-fixture';
import { fixtureTransportBudget, grantingReadBudget } from '../../../helpers/read-budget-fixture';
import { InMemoryLiveExecutionRepository } from '../../../unit/execution/live/helpers';
import {
  ACCOUNT, EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT, FakeEvidenceProvider, FixedClock, RUNTIME_IDENTITY, evidenceSet, venueOrder,
} from '../../../unit/execution/live/reconciliation/helpers';
import { InMemoryReconciliationRepository } from '../../../unit/execution/live/reconciliation/in-memory-repository';
import { cleanup, clientConfig, fixture, limiterFixture, sleep, waitFor, type Fixture } from './support';

// M2 (U-M2-1): Phase 18 orphan-cancellation budget admission. The genuine reconciliation service, orphan adapter, order
// gateway and mutation transport against a loopback venue; an in-memory durable reconciliation repository; a synthetic
// cleanup policy built by the genuine configuration gate for a test account; synthetic credentials. The production policy
// is not enabled and nothing is composed into production. No provider, external network or database.
const stops: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); cleanup(); });
const TIMEOUT = 60_000;
const CANCEL_PATH = '/exchange/v1/derivatives/futures/orders/cancel';
const CANCELLED = { status: 200, body: '{"message":"success","status":200,"code":200}' };

type Answer = { status: number; body: string } | 'DESTROY';
interface Venue { baseUrl: string; hits: string[]; respond: (path: string) => Answer | Promise<Answer> }
async function startVenue(): Promise<Venue> {
  const state: Venue = { baseUrl: '', hits: [], respond: () => ({ status: 500, body: '{"message":"unconfigured"}' }) };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = req.url ?? ''; state.hits.push(path);
      void Promise.resolve(state.respond(path)).then((answer) => {
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

/** Logs the durable orphan-cancel steps and can delay or interleave the arm. */
class ObservedReconciliationRepository extends InMemoryReconciliationRepository {
  public readonly log: string[];
  public beforeArm: (() => Promise<void>) | null = null;
  public constructor(log: string[]) { super(); this.log = log; }
  public override async claimOrphanCancellation(...args: Parameters<InMemoryReconciliationRepository['claimOrphanCancellation']>) {
    const claim = await super.claimOrphanCancellation(...args); this.log.push(`claim:${claim.kind}`); return claim;
  }
  public override async armOrphanCancelWire(...args: Parameters<InMemoryReconciliationRepository['armOrphanCancelWire']>) {
    this.log.push('armOrphanCancelWire'); if (this.beforeArm !== null) await this.beforeArm(); return super.armOrphanCancelWire(...args);
  }
  public override async reclaimUnarmedOrphanCancelClaim(...args: Parameters<InMemoryReconciliationRepository['reclaimUnarmedOrphanCancelClaim']>) {
    this.log.push('reclaimUnarmed'); return super.reclaimUnarmedOrphanCancelClaim(...args);
  }
  public override async completeOrphanCancellation(...args: Parameters<InMemoryReconciliationRepository['completeOrphanCancellation']>) {
    this.log.push(`complete:${args[4]}:${String(args[5])}`); return super.completeOrphanCancellation(...args);
  }
}
function loggedPort(inner: LiveMutationBudgetPort, log: string[]): LiveMutationBudgetPort {
  return { admit: async (request) => { log.push(`admit:${request.gatewayCall}`); return inner.admit(request); }, release: (permit) => { log.push('release'); inner.release(permit); } };
}

async function harness(orphanIds: readonly string[] = ['venue-orphan-1']) {
  const venue = await startVenue();
  const log: string[] = [];
  const reconciliation = new ObservedReconciliationRepository(log);
  const gateway = new CoinDcxLiveFuturesOrderGateway({ apiKey: 'synthetic-orphan-key', apiSecret: 'synthetic-orphan-secret', baseUrl: venue.baseUrl, readBudget: fixtureTransportBudget() });
  const resolution = resolveOrphanCleanupPolicy({ LIVE_ORPHAN_CANCELLATION_ENABLED: 'true', LIVE_ORPHAN_CANCELLATION_ACCOUNT_ALLOWLIST: ACCOUNT });
  if (resolution.status !== 'ENABLED') throw new Error('synthetic test policy did not resolve');
  const evidence = evidenceSet({ orders: orphanIds.map((exchangeOrderId) => venueOrder({ exchangeOrderId })) });
  const service = (budget: LiveMutationBudgetPort | undefined, runtimeIdentity = RUNTIME_IDENTITY) => new LiveReconciliationService({
    repository: reconciliation, executionRepository: new InMemoryLiveExecutionRepository(), evidenceProvider: new FakeEvidenceProvider(evidence),
    runtimeIdentity, credentialAccountId: ACCOUNT, expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT, clock: new FixedClock(),
    orphanPolicy: resolution.policy, orphanCancellation: new GatewayOrphanCancellation(gateway),
    orphanCancellationBudget: budget === undefined ? undefined : loggedPort(budget, log), requestTimeoutMs: 5000,
  });
  const orphan = async (exchangeOrderId = orphanIds[0]) => (await reconciliation.loadOrphanOrders(ACCOUNT)).find((o) => o.exchangeOrderId === exchangeOrderId);
  return { venue, log, reconciliation, service, orphan };
}
async function coordinator(f: Fixture): Promise<RateLimitCoordinator> {
  const started = await RateLimitCoordinator.start(f.coordinator);
  if (started.kind !== 'RUNNING') throw new Error(JSON.stringify(started));
  stops.push(() => started.coordinator.close());
  return started.coordinator;
}
async function client(pipe: string, connect = true): Promise<RateLimitClient> {
  const c = new RateLimitClient(clientConfig(pipe)); stops.push(() => c.close());
  if (connect) expect(await c.connect()).toBe(true);
  return c;
}
const coordinatorPort = (c: RateLimitClient, deadlineInMs = 5000) => createLiveMutationBudgetPort(createCoordinatorMutationBudget(c, { cls: 'P0', deadlineInMs }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const REFUSED_BEFORE_WIRE = ['claim:CLAIMED', 'admit:cancelOrder', 'armOrphanCancelWire', 'release', 'complete:CANCEL_REJECTED:BUDGET_REFUSED'];

describe('M2 orphan cancellation: admission before the durable arm; exactly one request on the authorized path', () => {
  it('synthetic authorized path: claim, admission, durable arm, one request carrying the consumed permit; STARTED and completion once', async () => {
    const record = emptyMutationBudgetRecord();
    const h = await harness();
    h.venue.respond = () => CANCELLED;
    expect((await h.service(createLiveMutationBudgetPort(grantingMutationBudget(record))).reconcileAccount(ACCOUNT)).kind).toBe('COMPLETED');
    expect(h.log).toEqual(['claim:CLAIMED', 'admit:cancelOrder', 'armOrphanCancelWire', 'release', 'complete:CANCEL_ACKNOWLEDGED:null']);
    expect(h.venue.hits).toEqual([CANCEL_PATH]);
    expect(await h.orphan()).toMatchObject({ cancelState: 'CANCEL_ACKNOWLEDGED', cancelWireArmed: true });
    await waitFor(() => record.completed === 1, 5000, 'completion at request close');
    expect(record).toMatchObject({ acquired: 1, consumed: 1, started: 1, completed: 1, released: 0, operations: ['CANCEL'] });
  }, TIMEOUT);

  it('missing or refusing budget: zero requests; the existing PRE_DISPATCH_FAILURE classification follows', async () => {
    const absent = await harness();
    absent.venue.respond = () => CANCELLED;
    await absent.service(undefined).reconcileAccount(ACCOUNT);
    expect(absent.log).toEqual(['claim:CLAIMED', 'armOrphanCancelWire', 'complete:CANCEL_REJECTED:BUDGET_REFUSED']);
    expect(absent.venue.hits).toEqual([]);
    const refusing = await harness();
    refusing.venue.respond = () => CANCELLED;
    await refusing.service({ admit: async () => null, release: () => undefined }).reconcileAccount(ACCOUNT);
    expect(refusing.log).toEqual(['claim:CLAIMED', 'admit:cancelOrder', 'armOrphanCancelWire', 'complete:CANCEL_REJECTED:BUDGET_REFUSED']);
    expect(refusing.venue.hits).toEqual([]);
    const throwing = await harness();
    await throwing.service({ admit: async () => { throw new Error('simulated budget failure'); }, release: () => undefined }).reconcileAccount(ACCOUNT);
    expect(throwing.venue.hits).toEqual([]);
    expect(await throwing.orphan()).toMatchObject({ cancelState: 'CANCEL_REJECTED', cancelFaultCode: 'BUDGET_REFUSED' });
  }, TIMEOUT);

  it('wrong-binding, forged, read and reused permits: zero requests each; only the single genuine first use reaches the wire', async () => {
    const record = emptyMutationBudgetRecord();
    const reused = fixtureMutationPermitSync('CANCEL', record);
    const readGrant = await grantingReadBudget().acquire({ scope: 'API_AUTH', lifetimeMs: 5000 });
    if (readGrant.kind !== 'GRANTED') throw new Error('read fixture refused');
    const cases: Array<[string, object]> = [
      ['CREATE permit', fixtureMutationPermitSync('CREATE', record)],
      ['read permit', readGrant.permit],
      ['forged consume', { consume: () => ({ kind: 'USED' }) }],
      ['forged grant shape', Object.freeze({ kind: 'GRANTED', operation: 'CANCEL' })],
      ['genuine first use', reused],
      ['reused', reused],
    ];
    for (const [label, permit] of cases) {
      const h = await harness([`venue-orphan-${label.replace(/\W+/g, '-')}`]);
      h.venue.respond = () => CANCELLED;
      await h.service({ admit: async () => permit, release: () => undefined }).reconcileAccount(ACCOUNT);
      if (label === 'genuine first use') {
        expect(h.venue.hits, label).toEqual([CANCEL_PATH]);
        expect((await h.orphan())?.cancelState, label).toBe('CANCEL_ACKNOWLEDGED');
        continue;
      }
      expect(h.venue.hits, label).toEqual([]);
      expect(await h.orphan(), label).toMatchObject({ cancelState: 'CANCEL_REJECTED', cancelFaultCode: 'BUDGET_REFUSED' });
    }
    expect(record.consumed).toBe(1);
  }, TIMEOUT);

  it('definite and ambiguous outcomes are unchanged: a definite rejection stays definite; an ambiguous cancel is never resent', async () => {
    const definite = await harness();
    definite.venue.respond = () => ({ status: 400, body: '{"message":"order not cancellable","code":"400"}' });
    await definite.service(createLiveMutationBudgetPort(grantingMutationBudget())).reconcileAccount(ACCOUNT);
    expect(definite.venue.hits).toEqual([CANCEL_PATH]);
    expect(await definite.orphan()).toMatchObject({ cancelState: 'CANCEL_REJECTED', cancelFaultCode: 'HTTP_400' });

    const record = emptyMutationBudgetRecord();
    const ambiguous = await harness();
    ambiguous.venue.respond = () => 'DESTROY';
    const port = createLiveMutationBudgetPort(grantingMutationBudget(record));
    const first = await ambiguous.service(port).reconcileAccount(ACCOUNT);
    expect(ambiguous.venue.hits).toEqual([CANCEL_PATH]);
    expect(await ambiguous.orphan()).toMatchObject({ cancelState: 'CANCEL_AMBIGUOUS', cancelFaultCode: 'LIVE_ORPHAN_CANCEL_AMBIGUOUS' });
    if (first.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(first.result.findings.some((f) => f.code === 'RECON_ORPHAN_CANCEL_AMBIGUOUS')).toBe(true);
    // A later run re-asserts the sticky finding and never reaches admission or the wire again.
    await ambiguous.service(port).reconcileAccount(ACCOUNT);
    expect(ambiguous.venue.hits).toEqual([CANCEL_PATH]);
    expect(ambiguous.log.filter((entry) => entry === 'admit:cancelOrder')).toHaveLength(1);
    await waitFor(() => record.completed === 1, 5000, 'completion at request close');
    expect(record).toMatchObject({ acquired: 1, consumed: 1, started: 1, completed: 1 });
  }, TIMEOUT);
});

describe('M2 orphan cancellation: invalidation while admission waits; expiry and revocation during the durable arm', () => {
  it('ownership superseded while admission waits: the arm is fenced out, zero requests, the permit is released unused and the unarmed claim is kept for the existing recovery', async () => {
    const record = emptyMutationBudgetRecord();
    const genuine = grantingMutationBudget(record);
    const waiting = deferred<void>();
    const h = await harness();
    h.venue.respond = () => CANCELLED;
    const port: LiveMutationBudgetPort = { admit: async (request) => { await waiting.promise; return createLiveMutationBudgetPort(genuine).admit(request); }, release: (permit) => createLiveMutationBudgetPort(genuine).release(permit) };
    const run = h.service(port).reconcileAccount(ACCOUNT);
    await waitFor(() => h.log.includes('admit:cancelOrder'), 5000, 'admission waiting');
    // A newer reconciliation generation takes ownership while admission waits.
    expect((await h.reconciliation.claimGeneration(ACCOUNT, newLiveRuntimeIdentity(), 2_000_000)).kind).toBe('CLAIMED');
    waiting.resolve();
    await expect(run).rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_STALE_GENERATION' });
    expect(h.log).toEqual(['claim:CLAIMED', 'admit:cancelOrder', 'armOrphanCancelWire', 'release']);
    expect(h.venue.hits).toEqual([]);
    expect(record).toMatchObject({ acquired: 1, consumed: 0, started: 0, released: 1 });
    // The durable state is certain (never armed): the claim is not released in-run; the next run's existing recovery
    // reclaims it with zero requests, and only then may that run pass every gate and a fresh admission again.
    expect(await h.orphan()).toMatchObject({ cancelState: 'CANCEL_CLAIMED', cancelWireArmed: false });
    h.log.length = 0;
    await h.service(createLiveMutationBudgetPort(genuine)).reconcileAccount(ACCOUNT);
    expect(h.log).toEqual(['reclaimUnarmed', 'claim:CLAIMED', 'admit:cancelOrder', 'armOrphanCancelWire', 'release', 'complete:CANCEL_ACKNOWLEDGED:null']);
    expect(h.venue.hits).toEqual([CANCEL_PATH]);
  }, TIMEOUT);

  it('permit expiry during the durable arm: refused before transmission, existing classification, capacity refunded', async () => {
    const f = fixture(limiterFixture({ grantTtlMs: 150 }));
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const h = await harness();
    h.venue.respond = () => CANCELLED;
    h.reconciliation.beforeArm = () => sleep(400);
    await h.service(coordinatorPort(c)).reconcileAccount(ACCOUNT);
    expect(h.log).toEqual(REFUSED_BEFORE_WIRE);
    expect(h.venue.hits).toEqual([]);
    expect(await h.orphan()).toMatchObject({ cancelState: 'CANCEL_REJECTED', cancelFaultCode: 'BUDGET_REFUSED', cancelWireArmed: true });
    await waitFor(() => coord.state.charges.length === 0, 5000, 'expired grant refunded (NOT_STARTED)');
  }, TIMEOUT);

  it('revocation during the durable arm (coordinator STOP from another client): refused before transmission', async () => {
    const f = fixture();
    const coord = await coordinator(f);
    const c = await client(f.pipe);
    const operator = await client(f.pipe);
    const h = await harness();
    h.venue.respond = () => CANCELLED;
    h.reconciliation.beforeArm = async () => {
      expect((await operator.control('STOP')).result).toBe('APPLIED');
      await waitFor(() => c.view.admission === 'STOPPED', 5000, 'revocation reached the worker');
    };
    await h.service(coordinatorPort(c)).reconcileAccount(ACCOUNT);
    expect(h.log).toEqual(REFUSED_BEFORE_WIRE);
    expect(h.venue.hits).toEqual([]);
    await waitFor(() => coord.state.charges.length === 0, 5000, 'revoked grant refunded');
  }, TIMEOUT);

  it('STOP while admission waits, STOP before admission, and an unavailable coordinator: zero requests each, never a permit', async () => {
    const f = fixture(limiterFixture({ concurrency: 1 }));
    await coordinator(f);
    const reader = await client(f.pipe);
    const held = await createCoordinatorReadBudget(reader, { cls: 'P1', deadlineInMs: 5000 }).acquire({ scope: 'API_AUTH', lifetimeMs: 10_000 });
    if (held.kind !== 'GRANTED') throw new Error('expected the read slot');
    // (a) The orphan's admission waits behind the held slot; the kill switch latches its client while it waits.
    const c = await client(f.pipe);
    const waitingCase = await harness(['venue-orphan-waiting']);
    waitingCase.venue.respond = () => CANCELLED;
    const run = waitingCase.service(coordinatorPort(c)).reconcileAccount(ACCOUNT);
    await waitFor(() => waitingCase.log.includes('admit:cancelOrder'), 5000, 'admission waiting');
    await sleep(100);
    expect(waitingCase.log).not.toContain('armOrphanCancelWire');
    const engagement = engageAdmissionStop({ localStops: [], limiter: c, ackTimeoutMs: 5000 });
    await run;
    expect(waitingCase.log).toEqual(['claim:CLAIMED', 'admit:cancelOrder', 'armOrphanCancelWire', 'complete:CANCEL_REJECTED:BUDGET_REFUSED']);
    expect(waitingCase.venue.hits).toEqual([]);
    expect((await engagement.report).coordinatorStop).toEqual({ kind: 'DURABLE' });
    held.permit.release();
    // (b) STOP already durable: admission is refused by the coordinator for any client.
    const other = await client(f.pipe);
    const stopped = await harness(['venue-orphan-stopped']);
    stopped.venue.respond = () => CANCELLED;
    await stopped.service(coordinatorPort(other)).reconcileAccount(ACCOUNT);
    expect(stopped.venue.hits).toEqual([]);
    expect(await stopped.orphan()).toMatchObject({ cancelState: 'CANCEL_REJECTED', cancelFaultCode: 'BUDGET_REFUSED' });
    // (c) Coordinator unavailable: the client never connected.
    const offline = await client(f.pipe, false);
    const unavailable = await harness(['venue-orphan-unavailable']);
    unavailable.venue.respond = () => CANCELLED;
    await unavailable.service(coordinatorPort(offline)).reconcileAccount(ACCOUNT);
    expect(unavailable.venue.hits).toEqual([]);
    expect(await unavailable.orphan()).toMatchObject({ cancelState: 'CANCEL_REJECTED', cancelFaultCode: 'BUDGET_REFUSED' });
  }, TIMEOUT);
});

describe('M2 orphan cancellation: shared accounting with reads and other mutations', () => {
  it('one coordinator slot: the orphan cancel waits behind a read, holds the slot while in flight, and a Phase 17 mutation waits behind it', async () => {
    const f = fixture(limiterFixture({ concurrency: 1 }));
    const coord = await coordinator(f);
    const reader = await client(f.pipe);
    const worker = await client(f.pipe);
    const c = await client(f.pipe);
    const read = await createCoordinatorReadBudget(reader, { cls: 'P0', deadlineInMs: 10_000 }).acquire({ scope: 'API_AUTH', lifetimeMs: 10_000 });
    if (read.kind !== 'GRANTED') throw new Error('expected the read slot');
    const h = await harness();
    const hold = deferred<Answer>();
    h.venue.respond = () => hold.promise;
    const run = h.service(coordinatorPort(c, 15_000)).reconcileAccount(ACCOUNT);
    await waitFor(() => h.log.includes('admit:cancelOrder'), 5000, 'orphan admission queued');
    const create = createCoordinatorMutationBudget(worker, { cls: 'P0', deadlineInMs: 15_000 }).acquire({ operation: 'CREATE', lifetimeMs: 5000 });
    let createSettled = false; void create.then(() => { createSettled = true; });
    await sleep(200);
    expect(h.log).not.toContain('armOrphanCancelWire'); // waiting behind the read
    expect(h.venue.hits).toEqual([]);
    read.permit.release();
    await waitFor(() => h.venue.hits.length === 1, 5000, 'orphan cancel created after the read released its slot');
    expect(coord.state.charges.map((charge) => charge.operation)).toEqual(['CANCEL']);
    await sleep(200);
    expect(createSettled).toBe(false); // the in-flight orphan cancel holds the shared slot
    hold.resolve(CANCELLED);
    expect((await run).kind).toBe('COMPLETED');
    expect(await h.orphan()).toMatchObject({ cancelState: 'CANCEL_ACKNOWLEDGED' });
    const granted = await create;
    expect(granted.kind).toBe('GRANTED');
    if (granted.kind === 'GRANTED') releaseMutationPermit(granted.permit);
    expect(h.venue.hits).toEqual([CANCEL_PATH]);
  }, TIMEOUT);
});
