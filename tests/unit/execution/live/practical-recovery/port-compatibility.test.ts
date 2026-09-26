import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../../../src/core/time/clock';
import type { PrismaPracticalSafetyRepository } from '../../../../../src/execution/live/practical-persistence/repository';
import { observeOrderRead, observePositionRead } from '../../../../../src/execution/live/practical-recovery/observation';
import { bindPracticalPrivateStream, practicalPrivateStreamReadiness } from '../../../../../src/execution/live/practical-recovery/private-events';
import { PracticalRecoveryService } from '../../../../../src/execution/live/practical-recovery/service';
import type {
  PracticalPrivateStreamSource,
  PracticalReconciliationStateReader,
  PracticalRecoveryPersistence,
  PracticalRecoveryScheduler,
  PracticalRevocationPort,
  PracticalVenueReadPort,
} from '../../../../../src/execution/live/practical-recovery/ports';
import type { PrismaLiveReconciliationRepository } from '../../../../../src/execution/live/reconciliation/repository';
import { CoinDcxReconciliationEvidenceAdapter } from '../../../../../src/integration/coindcx/live/reconciliation-evidence-adapter';
import { CoinDcxPrivateAccountStream } from '../../../../../src/integration/coindcx/websocket/private-stream';
import type { StreamScheduler } from '../../../../../src/integration/coindcx/websocket/public-stream';
import { createTestStreamContext } from '../../../coindcx/ws/test-helpers';
import { FINGERPRINT, FakeReconciliation, FakeScheduler, FakeVenue, MemoryPracticalPersistence, T0, enablementFor } from './support';

// Checkpoint B adds NO new infrastructure: the existing read-only CoinDCX
// evidence adapter, the existing private account stream, the Phase 18
// repository, the Stage 1B1 repository, and the existing stream scheduler all
// satisfy the recovery ports AS THEY ARE (compile-time assignments below; a
// port drift is a typecheck failure). Nothing is wired: this is a test.

function assignable<T>(_value: T): void {
  // compile-time only
}

describe('existing infrastructure satisfies the Checkpoint B ports unchanged', () => {
  it('type-level: stream, venue adapter, Phase 18 reader, Stage 1B1 repository, scheduler', () => {
    assignable<PracticalPrivateStreamSource>(null as unknown as CoinDcxPrivateAccountStream);
    assignable<PracticalVenueReadPort>(null as unknown as CoinDcxReconciliationEvidenceAdapter);
    assignable<PracticalReconciliationStateReader>(null as unknown as PrismaLiveReconciliationRepository);
    assignable<PracticalRecoveryPersistence>(null as unknown as PrismaPracticalSafetyRepository);
    assignable<PracticalRevocationPort>(null as unknown as PrismaPracticalSafetyRepository);
    assignable<PracticalRecoveryScheduler>(null as unknown as StreamScheduler);
    expect(true).toBe(true);
  });

  it('the CoinDCX evidence adapter reads ACCOUNT-WIDE: an empty pair list never narrows the order read', async () => {
    const orderRequests: Record<string, unknown>[] = [];
    let positionRequests = 0;
    const client = {
      listInrFuturesOrders: async (request: Record<string, unknown>) => {
        orderRequests.push(request);
        return [];
      },
      listInrFuturesPositions: async () => {
        positionRequests += 1;
        return [];
      },
    };
    const adapter = new CoinDcxReconciliationEvidenceAdapter({ client: client as never, credentialAccountId: 'account-1', clock: new FakeClock(1_000) });
    const orders = await adapter.readOrders({ accountId: 'account-1', pairs: [], timeoutMs: 10 });
    const positions = await adapter.readPositions({ accountId: 'account-1', timeoutMs: 10 });
    // Both sides, every documented status, no pair filter.
    expect(orderRequests.map((request) => request['side']).sort()).toEqual(['buy', 'sell']);
    for (const request of orderRequests) {
      expect(request).not.toHaveProperty('pair');
      expect(String(request['status'])).toContain('open');
      expect(String(request['status'])).toContain('filled');
    }
    expect(positionRequests).toBe(1);
    // And its complete provenance is exactly what the recovery core accepts as a complete read.
    expect(observeOrderRead(orders)).toMatchObject({ failure: null, complete: true, pagesRead: 2 });
    expect(observePositionRead(positions)).toMatchObject({ failure: null, complete: true, pagesRead: 1 });
  });
});

describe('P18B-B-04: the PRODUCTION CoinDCX private stream is UNPROVEN (its actual current readiness behavior)', () => {
  // A real CoinDcxPrivateAccountStream over the existing fake socket (no network, dummy credentials).
  function realStream() {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({ apiKey: 'dummy-key', apiSecret: 'dummy-secret', socketFactory: ctx.socketFactory, clock: ctx.clock, scheduler: ctx.scheduler });
    return { ctx, stream };
  }

  it('after connect + join the real adapter reaches AUTH_JOIN_SENT and reports NO provider confirmation: UNPROVEN, cannot bind', async () => {
    const { ctx, stream } = realStream();
    await stream.start();
    const health = stream.getHealthSnapshot();
    expect(health).toMatchObject({ state: 'AUTH_JOIN_SENT', connected: true, authJoinSent: true, reconciliationRequired: false });
    expect(health).not.toHaveProperty('subscriptionConfirmation');
    expect(ctx.socketFactory.latestSocket!.emitted.filter((entry) => entry.event === 'join')).toHaveLength(1);
    expect(practicalPrivateStreamReadiness(health)).toEqual({ kind: 'UNPROVEN', reason: 'NO_PROVIDER_CONFIRMATION' });
    expect(bindPracticalPrivateStream(health)).toEqual({ kind: 'NOT_READY', readiness: 'UNPROVEN', reason: 'NO_PROVIDER_CONFIRMATION' });
    stream.stop();
  });

  it('nothing the provider sends turns it PROVEN_READY: the adapter has no acknowledgement listener, and private data events are not readiness', async () => {
    const { ctx, stream } = realStream();
    await stream.start();
    const socket = ctx.socketFactory.latestSocket!;
    // The adapter subscribes to exactly these socket events; none is a join/subscription acknowledgement.
    expect([...socket.listeners.keys()].sort()).toEqual(['balance-update', 'connect', 'connect_error', 'df-order-update', 'df-position-update', 'disconnect', 'error']);
    for (const event of ['joined', 'join-success', 'subscribed', 'ack']) socket.trigger(event, { channelName: 'coindcx' });
    socket.trigger('df-order-update', [{ id: 'ord-1', pair: 'B-BTC_USDT', side: 'buy', status: 'open', order_type: 'limit_order', price: '50000', total_quantity: '0.1', created_at: T0, updated_at: T0, margin_currency_short_name: 'INR' }]);
    expect(practicalPrivateStreamReadiness(stream.getHealthSnapshot())).toEqual({ kind: 'UNPROVEN', reason: 'NO_PROVIDER_CONFIRMATION' });
    stream.stop();
  });

  it('after a reconnect the real adapter is RECONCILIATION_REQUIRED (new incarnation, never ready)', async () => {
    const { ctx, stream } = realStream();
    await stream.start();
    ctx.socketFactory.latestSocket!.trigger('disconnect', 'transport close');
    ctx.scheduler.runAllTimers();
    expect(stream.generationId).toBe(2);
    expect(practicalPrivateStreamReadiness(stream.getHealthSnapshot())).toEqual({ kind: 'RECONCILIATION_REQUIRED' });
    stream.stop();
    expect(practicalPrivateStreamReadiness(stream.getHealthSnapshot()).kind).not.toBe('PROVEN_READY');
  });

  it('so the recovery engine over the REAL stream cannot arm and cannot certify (production certification unavailable, fail closed)', async () => {
    const { stream } = realStream();
    await stream.start();
    const clock = new FakeClock(T0);
    const venue = new FakeVenue(clock);
    const persistence = new MemoryPracticalPersistence('account-live-1');
    const reconciliation = new FakeReconciliation('account-live-1');
    const service = new PracticalRecoveryService({
      accountId: 'account-live-1', runtimeEpoch: 'runtime-epoch-a', expectedProviderAccountFingerprint: FINGERPRINT, enablement: enablementFor('account-live-1'),
      persistence, venue, reconciliation, privateStream: stream, clock, scheduler: new FakeScheduler(clock),
    });
    await service.recoverAtStartup();
    expect(await service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'STREAM_NO_PROVIDER_CONFIRMATION' });
    reconciliation.completeHealthyRun('runtime-epoch-a');
    expect(await service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'NO_ACTIVE_WATCH' });
    expect(venue.calls).toEqual([]);
    expect(persistence.certificate).toBeNull();
    stream.stop();
  });
});
