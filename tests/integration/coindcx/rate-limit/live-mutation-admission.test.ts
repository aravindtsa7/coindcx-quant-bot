import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { LiveMutationBudgetPort } from '../../../../src/execution/live/gateway';
import { LiveExecutionIntent, type LiveExecutionIntentRecord } from '../../../../src/execution/live/intent';
import { GatewayOrphanCancellation } from '../../../../src/execution/live/reconciliation/gateway-orphan-cancellation';
import { LiveExecutionService } from '../../../../src/execution/live/service';
import type { LiveOrderStateRecord } from '../../../../src/execution/live/types';
import { createLiveMutationBudgetPort } from '../../../../src/integration/coindcx/live/mutation-budget-ports';
import { CoinDcxLiveFuturesOrderGateway } from '../../../../src/integration/coindcx/live/order-gateway';
import { RateLimitClient } from '../../../../src/integration/coindcx/rate-limit/runtime/client';
import { RateLimitCoordinator } from '../../../../src/integration/coindcx/rate-limit/runtime/coordinator';
import { createCoordinatorMutationBudget, type MutationBudget } from '../../../../src/integration/coindcx/rate-limit/runtime/mutation-budget';
import { emptyMutationBudgetRecord, fixtureMutationPermitSync, grantingMutationBudget } from '../../../helpers/mutation-budget-fixture';
import { fixtureTransportBudget } from '../../../helpers/read-budget-fixture';
import { InMemoryLiveExecutionRepository, livePolicy, mintGenuineLiveOpen } from '../../../unit/execution/live/helpers';
import { cleanup, clientConfig, fixture, limiterFixture, sleep, waitFor } from './support';

// M2 W4 (U-M2-1): Phase 17 create/cancel admission. The genuine order gateway and mutation transport against a loopback
// venue; an in-memory durable repository; synthetic accounts and credentials. No provider, external network or database.
const stops: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); cleanup(); });
const TIMEOUT = 60_000;

interface Venue { baseUrl: string; hits: string[]; respond: (path: string, body: string) => { status: number; body: string } | 'DESTROY' }
async function startVenue(): Promise<Venue> {
  const state: Venue = { baseUrl: '', hits: [], respond: () => ({ status: 500, body: '{"message":"unconfigured"}' }) };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    req.on('end', () => {
      const path = req.url ?? ''; state.hits.push(path);
      const answer = state.respond(path, body);
      if (answer === 'DESTROY') { req.socket.destroy(); return; }
      res.writeHead(answer.status, { 'content-type': 'application/json' }); res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stops.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return state;
}
function ack(record: LiveExecutionIntentRecord): string {
  const c = record.content;
  return JSON.stringify([{ id: 'venue-order-w4', pair: c.pair, side: c.side === 'BUY' ? 'buy' : 'sell', status: 'initial', order_type: record.wireOrderType,
    price: c.price, avg_price: '0', total_quantity: c.quantity, remaining_quantity: c.quantity, cancelled_quantity: '0', leverage: c.leverage,
    margin_currency_short_name: 'INR', settlement_currency_conversion_price: c.settlementRateInrPerQuote, client_order_id: record.clientOrderId,
    created_at: 1_700_000_000_000, updated_at: 1_700_000_000_500 }]);
}
/** Logs the durable arms and can delay them, to observe ordering and waits while armed. */
class ObservedRepository extends InMemoryLiveExecutionRepository {
  public readonly log: string[];
  public armDelayMs = 0;
  public constructor(log: string[]) { super(); this.log = log; }
  public override async armDispatchWire(intentId: string, expectedRevision: number): Promise<LiveOrderStateRecord> {
    this.log.push('armDispatchWire'); if (this.armDelayMs > 0) await sleep(this.armDelayMs); return super.armDispatchWire(intentId, expectedRevision);
  }
  public override async armCancelWire(intentId: string, expectedRevision: number): Promise<LiveOrderStateRecord> {
    this.log.push('armCancelWire'); return super.armCancelWire(intentId, expectedRevision);
  }
}
function loggedPort(inner: LiveMutationBudgetPort, log: string[]): LiveMutationBudgetPort {
  return { admit: async (request) => { log.push(`admit:${request.gatewayCall}`); return inner.admit(request); }, release: (permit) => { log.push('release'); inner.release(permit); } };
}
async function harness(budget: LiveMutationBudgetPort | undefined) {
  const minted = await mintGenuineLiveOpen();
  const record = LiveExecutionIntent.read(minted.intent)!;
  const venue = await startVenue();
  const log: string[] = [];
  const repository = new ObservedRepository(log);
  const gateway = new CoinDcxLiveFuturesOrderGateway({ apiKey: 'synthetic-w4-key', apiSecret: 'synthetic-w4-secret', baseUrl: venue.baseUrl, readBudget: fixtureTransportBudget() });
  const service = (port: LiveMutationBudgetPort | undefined) => new LiveExecutionService({ gateway, repository, policy: livePolicy(), budget: port === undefined ? undefined : loggedPort(port, log) });
  return { minted, record, venue, log, repository, gateway, service: service(budget), withBudget: service };
}

describe('M2 W4 Phase 17 create admission', () => {
  it('admission is awaited before the durable arm; the transport consumes the permit; exactly one request; STARTED and completion once', async () => {
    const budgetRecord = emptyMutationBudgetRecord();
    const h = await harness(createLiveMutationBudgetPort(grantingMutationBudget(budgetRecord)));
    h.venue.respond = () => ({ status: 200, body: ack(h.record) });
    const outcome = await h.service.dispatch(h.minted.authority, h.minted.intent);
    expect(outcome.kind).toBe('SUBMITTED'); // a definite response stays definite
    expect(h.log).toEqual(['admit:placeOrder', 'armDispatchWire', 'release']);
    expect(h.venue.hits).toHaveLength(1);
    await waitFor(() => budgetRecord.completed === 1, 5000, 'completion after teardown');
    expect(budgetRecord).toMatchObject({ acquired: 1, consumed: 1, started: 1, completed: 1, released: 0, operations: ['CREATE'] });
  }, TIMEOUT);

  it('a refused or absent budget: no permit, the transport refuses before any request, the existing claim release follows; a later attempt passes every gate again', async () => {
    const refusing: LiveMutationBudgetPort = { admit: async () => null, release: () => undefined };
    const h = await harness(refusing);
    h.venue.respond = () => ({ status: 200, body: ack(h.record) });
    await expect(h.service.dispatch(h.minted.authority, h.minted.intent)).rejects.toMatchObject({ code: 'LIVE_PROVIDER_ERROR', details: { reasonCode: 'BUDGET_REFUSED' } });
    expect((await h.repository.load(h.record.intentId))?.state).toBe('CREATED');
    await expect(h.withBudget(undefined).dispatch(h.minted.authority, h.minted.intent)).rejects.toMatchObject({ details: { reasonCode: 'BUDGET_REFUSED' } });
    expect(h.venue.hits).toHaveLength(0);
    // No automatic retry: only an explicit later dispatch, through every gate and a fresh admission, reaches the wire once.
    const budgetRecord = emptyMutationBudgetRecord();
    expect((await h.withBudget(createLiveMutationBudgetPort(grantingMutationBudget(budgetRecord))).dispatch(h.minted.authority, h.minted.intent)).kind).toBe('SUBMITTED');
    expect(h.venue.hits).toHaveLength(1);
    expect(budgetRecord.acquired).toBe(1);
    expect(h.log.filter((entry) => entry === 'armDispatchWire')).toHaveLength(3);
  }, TIMEOUT);

  it('wrong-operation, forged, read and reused permits are refused before any request; an unconsumed permit is released', async () => {
    const budgetRecord = emptyMutationBudgetRecord();
    const used = fixtureMutationPermitSync('CREATE', budgetRecord);
    for (const permit of [fixtureMutationPermitSync('CANCEL', budgetRecord), { consume: () => ({ kind: 'USED' }) }, Object.freeze({ kind: 'GRANTED' }), used, used]) {
      const h = await harness({ admit: async () => permit, release: (p) => { if (p === permit) budgetRecord.released += 1; } });
      h.venue.respond = () => ({ status: 200, body: ack(h.record) });
      if (permit === used && budgetRecord.consumed === 0) {
        // First use of `used`: genuine and correct, so it is consumed and the request is sent once.
        expect((await h.service.dispatch(h.minted.authority, h.minted.intent)).kind).toBe('SUBMITTED');
        expect(h.venue.hits).toHaveLength(1);
        continue;
      }
      await expect(h.service.dispatch(h.minted.authority, h.minted.intent)).rejects.toMatchObject({ details: { reasonCode: 'BUDGET_REFUSED' } });
      expect(h.venue.hits).toHaveLength(0);
    }
    expect(budgetRecord.consumed).toBe(1); // only the single genuine first use; reuse is refused
  }, TIMEOUT);

  it('an uncertain outcome remains ambiguous and is never resent', async () => {
    const budgetRecord = emptyMutationBudgetRecord();
    const h = await harness(createLiveMutationBudgetPort(grantingMutationBudget(budgetRecord)));
    h.venue.respond = () => 'DESTROY';
    expect((await h.service.dispatch(h.minted.authority, h.minted.intent)).kind).toBe('AMBIGUOUS');
    await expect(h.service.dispatch(h.minted.authority, h.minted.intent)).rejects.toMatchObject({ code: 'LIVE_SUBMISSION_AMBIGUOUS' });
    expect(h.venue.hits).toHaveLength(1);
    expect(budgetRecord.acquired).toBe(1); // the refused replay never reached admission
  }, TIMEOUT);

  it('permit expiry while the durable arm is awaited: PRE_DISPATCH, existing release, zero requests, capacity refunded', async () => {
    const f = fixture(limiterFixture({ grantTtlMs: 150 }));
    const started = await RateLimitCoordinator.start(f.coordinator);
    if (started.kind !== 'RUNNING') throw new Error(JSON.stringify(started));
    stops.push(() => started.coordinator.close());
    const c = new RateLimitClient(clientConfig(f.pipe)); stops.push(() => c.close());
    expect(await c.connect()).toBe(true);
    const budget: MutationBudget = createCoordinatorMutationBudget(c, { cls: 'P0', deadlineInMs: 5000 });
    const h = await harness(createLiveMutationBudgetPort(budget));
    h.venue.respond = () => ({ status: 200, body: ack(h.record) });
    h.repository.armDelayMs = 400;
    await expect(h.service.dispatch(h.minted.authority, h.minted.intent)).rejects.toMatchObject({ code: 'LIVE_PROVIDER_ERROR', details: { reasonCode: 'BUDGET_REFUSED' } });
    expect((await h.repository.load(h.record.intentId))?.state).toBe('CREATED');
    expect(h.venue.hits).toHaveLength(0);
    await waitFor(() => started.coordinator.state.charges.length === 0, 5000, 'expired grant refunded (NOT_STARTED)');
  }, TIMEOUT);
});

describe('M2 W4 Phase 17 cancel admission and orphan cleanup', () => {
  async function acknowledged() {
    const h = await harness(createLiveMutationBudgetPort(grantingMutationBudget()));
    h.venue.respond = () => ({ status: 200, body: ack(h.record) });
    expect((await h.service.dispatch(h.minted.authority, h.minted.intent)).kind).toBe('SUBMITTED');
    h.venue.hits.length = 0; h.log.length = 0;
    return h;
  }

  it('cancel admission precedes the durable arm; a definite provider rejection stays definite', async () => {
    const h = await acknowledged();
    h.venue.respond = () => ({ status: 400, body: '{"message":"order not cancellable","code":"400"}' });
    const outcome = await h.service.cancel(h.minted.authority, h.minted.intent);
    expect(outcome.kind).toBe('NOT_CANCELLABLE');
    expect(outcome.faultCode).toBe('HTTP_400');
    expect(h.log).toEqual(['admit:cancelOrder', 'armCancelWire', 'release']);
    expect(h.venue.hits).toEqual(['/exchange/v1/derivatives/futures/orders/cancel']);
  }, TIMEOUT);

  it('a refused cancel admission reaches no wire and takes the existing non-transmission completion', async () => {
    const h = await acknowledged();
    const outcome = await h.withBudget({ admit: async () => null, release: () => undefined }).cancel(h.minted.authority, h.minted.intent);
    expect(outcome).toMatchObject({ kind: 'NOT_CANCELLABLE', faultCode: 'BUDGET_REFUSED' });
    expect(h.venue.hits).toHaveLength(0);
  }, TIMEOUT);

  it('Phase 18 orphan cleanup carries no permit and is refused before any request (not yet integrated)', async () => {
    const h = await acknowledged();
    const orphan = new GatewayOrphanCancellation(h.gateway);
    expect(await orphan.cancelVenueOrder({ exchangeOrderId: 'venue-orphan', pair: h.record.content.pair, timeoutMs: 1000 })).toEqual({ kind: 'PRE_DISPATCH_FAILURE', reasonCode: 'BUDGET_REFUSED' });
    expect(h.venue.hits).toHaveLength(0);
  }, TIMEOUT);
});
