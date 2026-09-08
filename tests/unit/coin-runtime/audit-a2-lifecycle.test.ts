import { describe, expect, it } from 'vitest';
import { CoinRegistry, CoinRuntimeBootstrapService, createSubscriptionIntent, createSubscriptionIntents } from '../../../src/coin-runtime';
import { CoinDcxStreamCoordinator } from '../../../src/integration/coindcx/websocket/coordinator';
import { InrFuturesInstrument } from '../../../src/integration/coindcx/models';
import { instrument, profile, deferred } from '../coindcx/audit-a2-helpers';
import { createTestStreamContext } from '../coindcx/ws/test-helpers';

async function setup() {
  const registry = new CoinRegistry();
  const service = new CoinRuntimeBootstrapService({ findActiveInrPerpetualByUnderlying: async name => instrument(name) }, registry);
  await service.bootstrap([profile(), profile('ETH')]);
  return { registry, service };
}

describe('Audit A2 lifecycle authority and rediscovery ownership', () => {
  it('DISABLED suppresses single/batch intents without mutating the enabled profile, and rediscovery restores them', async () => {
    const { registry, service } = await setup();
    expect(createSubscriptionIntents(registry.list())).toHaveLength(2);
    registry.transitionLifecycle('BTC', 'DISABLED');
    expect(registry.getByUnderlying('BTC').profile.enabled).toBe(true);
    expect(createSubscriptionIntent(registry.getByUnderlying('BTC'))).toBeNull();
    expect(createSubscriptionIntents(registry.list()).map(i => i.underlying)).toEqual(['ETH']);
    registry.transitionLifecycle('BTC', 'DISABLED');
    expect(createSubscriptionIntent(registry.getByUnderlying('BTC'))).toBeNull();
    await service.reactivate(profile());
    expect(createSubscriptionIntent(registry.getByUnderlying('BTC'))?.pair).toBe('B-BTC_USDT');
  });

  it('active registry-bound coordinator leaves disabled BTC, ignores stale intents, and preserves ETH', async () => {
    const { registry, service } = await setup(); const ctx = createTestStreamContext();
    const coordinator = new CoinDcxStreamCoordinator({ publicConfig: { ...ctx, registry } });
    const staleIntents = createSubscriptionIntents(registry.list());
    await coordinator.startPublic(staleIntents);
    registry.transitionLifecycle('BTC', 'DISABLED');
    expect(coordinator.publicStream.activeSubscriptions).toEqual(['B-ETH_USDT_1m-futures']);
    expect(ctx.socketFactory.latestSocket?.emitted).toContainEqual({ event: 'leave', args: [{ channelName: 'B-BTC_USDT_1m-futures' }] });
    coordinator.publicStream.syncSubscriptions(staleIntents);
    expect(coordinator.publicStream.activeSubscriptions).toEqual(['B-ETH_USDT_1m-futures']);
    // Disabled channels are suppressed before payload normalization/publication.
    let published = 0;
    const unsubscribe = coordinator.publicStream.subscribe(event => { if (event.eventType === 'PUBLIC_CANDLE_UPDATE') published++; });
    ctx.socketFactory.latestSocket!.trigger('candlestick', { channel: 'B-BTC_USDT_1m-futures' });
    expect(published).toBe(0);
    expect(coordinator.publicStream.getHealthSnapshot().unexpectedChannelEventCount).toBe(1);
    unsubscribe();
    await service.reactivate(profile());
    expect(coordinator.publicStream.activeSubscriptions).toHaveLength(2);
    coordinator.stopAll();
    registry.transitionLifecycle('BTC', 'DISABLED');
    expect(coordinator.publicStream.activeSubscriptions).toHaveLength(0);
    await coordinator.startPublic(staleIntents);
    expect(coordinator.publicStream.activeSubscriptions).toEqual(['B-ETH_USDT_1m-futures']);
    coordinator.stopAll();
  });

  it('disable during reconnect cannot preserve active channels or regenerate the old BTC intent', async () => {
    const { registry } = await setup(); const ctx = createTestStreamContext();
    const coordinator = new CoinDcxStreamCoordinator({ publicConfig: { ...ctx, registry } });
    await coordinator.startPublic(createSubscriptionIntents(registry.list()));
    ctx.socketFactory.latestSocket!.trigger('disconnect', 'transport close');
    expect(coordinator.publicStream.activeSubscriptions).toHaveLength(0);
    registry.transitionLifecycle('BTC', 'DISABLED');
    ctx.scheduler.runAllTimers();
    expect(coordinator.publicStream.activeSubscriptions).toEqual(['B-ETH_USDT_1m-futures']);
    coordinator.stopAll();
  });

  it.each(['B then disable', 'disable only', 'B only', 'stale failure'] as const)('old reactivation is inert: %s', async scenario => {
    const { registry } = await setup(); const a = deferred<InrFuturesInstrument | null>(); let calls = 0;
    const service = new CoinRuntimeBootstrapService({ findActiveInrPerpetualByUnderlying: () => ++calls === 1 ? a.promise : Promise.resolve(instrument()) }, registry);
    const old = service.reactivate(profile()).catch(error => error as Error);
    if (scenario !== 'disable only') await service.reactivate(profile());
    if (scenario !== 'B only') registry.transitionLifecycle('BTC', 'DISABLED');
    const before = registry.getByUnderlying('BTC');
    if (scenario === 'stale failure') a.reject(new Error('late discovery failure')); else a.resolve(instrument());
    expect(await old).toMatchObject({ code: 'COIN_REGISTRATION_ERROR', details: { reason: 'SUPERSEDED' } });
    expect(registry.getByUnderlying('BTC')).toEqual(before);
    expect(registry.getByUnderlying('ETH').lifecycle).toBe('DISCOVERED');
  });

  it('two coins own independent concurrent reactivations', async () => {
    const { registry } = await setup(); const btc = deferred<InrFuturesInstrument | null>(); const eth = deferred<InrFuturesInstrument | null>();
    const service = new CoinRuntimeBootstrapService({ findActiveInrPerpetualByUnderlying: name => name === 'BTC' ? btc.promise : eth.promise }, registry);
    const a = service.reactivate(profile()); const b = service.reactivate(profile('ETH'));
    eth.resolve(instrument('ETH')); expect((await b).instrument?.pair).toBe('B-ETH_USDT');
    btc.resolve(instrument()); expect((await a).instrument?.pair).toBe('B-BTC_USDT');
  });

  it('pending bootstrap discovery cannot install over a newer disabled registration', async () => {
    const registry = new CoinRegistry(); const gate = deferred<InrFuturesInstrument | null>();
    const oldService = new CoinRuntimeBootstrapService({ findActiveInrPerpetualByUnderlying: () => gate.promise }, registry);
    const pending = oldService.bootstrap([profile()]);
    const current = new CoinRuntimeBootstrapService({ findActiveInrPerpetualByUnderlying: async () => instrument() }, registry);
    await current.bootstrap([{ ...profile(), enabled: false, dataEnabled: false, researchEnabled: false }]);
    gate.resolve(instrument());
    expect((await pending).successful).toHaveLength(0);
    expect(registry.getByUnderlying('BTC').lifecycle).toBe('DISABLED');
    expect(registry.hasPair('B-BTC_USDT')).toBe(false);
  });

  it('registry clear revokes pending rediscovery even when the same coin is registered again', async () => {
    const { registry, service: initial } = await setup(); const gate = deferred<InrFuturesInstrument | null>();
    const service = new CoinRuntimeBootstrapService({ findActiveInrPerpetualByUnderlying: () => gate.promise }, registry);
    const old = service.reactivate(profile()).catch(error => error as Error);
    registry.clear(); await initial.bootstrap([{ ...profile(), enabled: false, dataEnabled: false, researchEnabled: false }]);
    gate.resolve(instrument()); expect(await old).toBeInstanceOf(Error);
    expect(registry.getByUnderlying('BTC').lifecycle).toBe('DISABLED');
  });
});
