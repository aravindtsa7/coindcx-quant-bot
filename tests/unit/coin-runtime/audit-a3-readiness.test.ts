import { describe, expect, it, vi } from 'vitest';
import {
  CoinDataReadinessProof, CoinProfile, CoinRegistry, CoinRuntimeBootstrapService,
  createSubscriptionIntent, createSubscriptionIntents, DiscoveredCoinRuntime,
} from '../../../src/coin-runtime';
import { CoinLifecycleError } from '../../../src/core/errors/app-error';
import { Decimal } from '../../../src/core/decimal/decimal';
import { CoinDcxClient } from '../../../src/integration/coindcx/client';
import { InrFuturesInstrument } from '../../../src/integration/coindcx/models';
import { CoinDcxTransport } from '../../../src/integration/coindcx/transport';
import { deferred, instrument, profile, wire } from '../coindcx/audit-a2-helpers';

const reader = { getInrFuturesInstrument: async (pair: string) => instrument(pair.split('-')[1]!.split('_')[0]!) };

async function setup(profiles: readonly CoinProfile[] = [profile(), profile('ETH')]) {
  const registry = new CoinRegistry();
  const service = new CoinRuntimeBootstrapService({ findActiveInrPerpetualByUnderlying: async name => instrument(name) }, registry);
  const result = await service.bootstrap(profiles);
  expect(result.failures).toHaveLength(0);
  for (const coin of profiles) registry.transitionLifecycle(coin.underlying, 'DATA_LOADING');
  return { registry, service };
}

describe('Audit A3 mandatory Phase 3 DATA_READY evidence', () => {
  it('generic transition and missing proof both fail closed', async () => {
    const { registry } = await setup();
    expect(() => registry.transitionLifecycle('BTC', 'DATA_READY')).toThrow(CoinLifecycleError);
    expect(() => registry.promoteDataReady('BTC', undefined as unknown as CoinDataReadinessProof)).toThrow(CoinLifecycleError);
    expect(registry.getByUnderlying('BTC').lifecycle).toBe('DATA_LOADING');
  });

  it('completes a real Phase 2 instrument read, then publishes current metadata and an auditable owned intent', async () => {
    const { registry } = await setup();
    const transport = new CoinDcxTransport();
    const read = vi.spyOn(transport, 'executeRead').mockResolvedValue({ status: 200, headers: {}, durationMs: 0,
      data: { instrument: wire('BTC', { price_increment: '0.1' }) } });
    const proof = await registry.prepareDataReadiness('BTC', new CoinDcxClient({ transport }));
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ queryParams: expect.objectContaining({ pair: 'B-BTC_USDT' }) }));
    expect(registry.getByUnderlying('BTC').lifecycle).toBe('DATA_LOADING');
    expect(proof).toMatchObject({ scope: 'PHASE3_METADATA_AND_DATA_INTENT', underlying: 'BTC', pair: 'B-BTC_USDT',
      completedSteps: ['INSTRUMENT_METADATA', 'ONE_MINUTE_DATA_INTENT'],
      subscriptionIntent: { underlying: 'BTC', pair: 'B-BTC_USDT', requiresOneMinuteCandles: true } });
    const runtime = registry.promoteDataReady('BTC', proof) as DiscoveredCoinRuntime;
    expect(runtime.lifecycle).toBe('DATA_READY');
    expect(runtime.instrument.priceIncrement.toString()).toBe('0.1');
    expect(runtime.dataReadiness).toEqual({ lifecycleRevision: proof.lifecycleRevision + 1, evidence: proof });
    expect(createSubscriptionIntent(runtime)).toEqual(proof.subscriptionIntent);
    expect(registry.getByPair(proof.pair)).toEqual(runtime);
    expect(Object.isFrozen(runtime.dataReadiness)).toBe(true);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.completedSteps)).toBe(true);
    expect(Object.isFrozen(proof.subscriptionIntent)).toBe(true);
  });

  it.each(['partial', 'structural copy'] as const)('rejects %s evidence even with current revision fields', async shape => {
    const { registry } = await setup();
    const proof = await registry.prepareDataReadiness('BTC', reader);
    const forged = { ...proof, ...(shape === 'partial' ? { completedSteps: ['INSTRUMENT_METADATA'] } : {}) };
    expect(() => registry.promoteDataReady('BTC', forged as CoinDataReadinessProof)).toThrow(CoinLifecycleError);
    expect(registry.getByUnderlying('BTC').lifecycle).toBe('DATA_LOADING');
  });

  it.each([
    ['inactive instrument', { status: 'inactive' }],
    ['non-perpetual instrument', { kind: 'dated' }],
    ['incomplete metadata', { minNotional: undefined }],
    ['invalid contract unit', { unitContractValue: new Decimal(0) }],
    ['wrong margin', { marginCurrency: 'USDT' }],
    ['wrong quote identity', { quoteCurrency: 'BTC' }],
  ] as const)('failed mandatory metadata step: %s', async (_name, overrides) => {
    const { registry } = await setup();
    await expect(registry.prepareDataReadiness('BTC', {
      getInrFuturesInstrument: async () => ({ ...instrument(), ...overrides }) as InrFuturesInstrument,
    })).rejects.toMatchObject({ code: 'COIN_LIFECYCLE_ERROR', details: { reason: 'INITIALIZATION_FAILED' } });
    expect(registry.getByUnderlying('BTC').lifecycle).toBe('DATA_LOADING');
    expect(registry.getByPair('B-BTC_USDT').dataReadiness).toBeUndefined();
  });

  it('metadata completion alone cannot compensate for a disabled mandatory data intent', async () => {
    const { registry } = await setup([{ ...profile(), dataEnabled: false, researchEnabled: false }]);
    await expect(registry.prepareDataReadiness('BTC', reader)).rejects.toThrow(CoinLifecycleError);
    expect(registry.getByUnderlying('BTC').lifecycle).toBe('DATA_LOADING');
  });

  it('a failed newer initialization invalidates an earlier unconsumed proof', async () => {
    const { registry } = await setup();
    const old = await registry.prepareDataReadiness('BTC', reader);
    await expect(registry.prepareDataReadiness('BTC', { getInrFuturesInstrument: async () => { throw new Error('read failed'); } }))
      .rejects.toMatchObject({ details: { reason: 'INITIALIZATION_FAILED' } });
    expect(() => registry.promoteDataReady('BTC', old)).toThrow(CoinLifecycleError);
    expect(registry.getByUnderlying('BTC').lifecycle).toBe('DATA_LOADING');
    const current = await registry.prepareDataReadiness('BTC', reader);
    expect(registry.promoteDataReady('BTC', current).lifecycle).toBe('DATA_READY');
  });

  it('proof for BTC cannot promote ETH; ETH can independently earn readiness', async () => {
    const { registry } = await setup();
    const btc = await registry.prepareDataReadiness('BTC', reader);
    expect(() => registry.promoteDataReady('ETH', btc)).toThrow(CoinLifecycleError);
    expect(registry.getByUnderlying('ETH').lifecycle).toBe('DATA_LOADING');
    const eth = await registry.prepareDataReadiness('ETH', reader);
    expect(registry.promoteDataReady('ETH', eth).lifecycle).toBe('DATA_READY');
    expect(registry.promoteDataReady('BTC', btc).lifecycle).toBe('DATA_READY');
  });

  it('mismatched read response cannot issue a proof for the requested pair', async () => {
    const { registry } = await setup();
    await expect(registry.prepareDataReadiness('BTC', { getInrFuturesInstrument: async () => instrument('ETH') }))
      .rejects.toThrow(CoinLifecycleError);
    expect(registry.getByPair('B-BTC_USDT').instrument.underlying).toBe('BTC');
    expect(registry.getByPair('B-BTC_USDT').dataReadiness).toBeUndefined();
  });

  it.each(['success', 'failure'] as const)('disable revokes pending readiness before late %s', async outcome => {
    const { registry } = await setup();
    const gate = deferred<InrFuturesInstrument>();
    const pending = registry.prepareDataReadiness('BTC', { getInrFuturesInstrument: () => gate.promise }).catch(error => error as Error);
    registry.transitionLifecycle('BTC', 'DISABLED');
    if (outcome === 'success') gate.resolve(instrument()); else gate.reject(new Error('late read failure'));
    expect(await pending).toMatchObject({ code: 'COIN_LIFECYCLE_ERROR', details: { reason: 'SUPERSEDED' } });
    expect(registry.getByUnderlying('BTC').lifecycle).toBe('DISABLED');
    expect(registry.getByPair('B-BTC_USDT').dataReadiness).toBeUndefined();
    expect(createSubscriptionIntent(registry.getByUnderlying('BTC'))).toBeNull();
    expect(createSubscriptionIntents(registry.list()).map(intent => intent.underlying)).toEqual(['ETH']);
  });

  it('reactivation requires fresh ownership and cannot reuse an old lifecycle proof', async () => {
    const { registry, service } = await setup();
    const old = await registry.prepareDataReadiness('BTC', reader);
    registry.transitionLifecycle('BTC', 'DISABLED');
    await service.reactivate(profile());
    expect(registry.getByUnderlying('BTC').lifecycle).toBe('DISCOVERED');
    registry.transitionLifecycle('BTC', 'DATA_LOADING');
    expect(() => registry.promoteDataReady('BTC', old)).toThrow(CoinLifecycleError);
    const current = await registry.prepareDataReadiness('BTC', reader);
    expect(current.lifecycleRevision).toBeGreaterThan(old.lifecycleRevision);
    expect(registry.promoteDataReady('BTC', current).lifecycle).toBe('DATA_READY');
  });

  it.each(['resolve', 'reject'] as const)('A pending, B ready, disable, A %s: latest lifecycle wins', async outcome => {
    const { registry } = await setup();
    const gate = deferred<InrFuturesInstrument>();
    const a = registry.prepareDataReadiness('BTC', { getInrFuturesInstrument: () => gate.promise }).catch(error => error as Error);
    const b = await registry.prepareDataReadiness('BTC', reader);
    registry.promoteDataReady('BTC', b);
    registry.transitionLifecycle('BTC', 'DISABLED');
    const before = registry.getByUnderlying('BTC');
    if (outcome === 'resolve') gate.resolve(instrument()); else gate.reject(new Error('stale failure'));
    expect(await a).toMatchObject({ details: { reason: 'SUPERSEDED' } });
    expect(() => registry.promoteDataReady('BTC', b)).toThrow(CoinLifecycleError);
    expect(registry.getByUnderlying('BTC')).toEqual(before);
  });

  it('two completed attempts for one lifecycle can only consume the newest proof', async () => {
    const { registry } = await setup();
    const a = await registry.prepareDataReadiness('BTC', reader);
    const b = await registry.prepareDataReadiness('BTC', reader);
    expect(a.lifecycleRevision).toBe(b.lifecycleRevision);
    expect(b.operationRevision).toBeGreaterThan(a.operationRevision);
    expect(() => registry.promoteDataReady('BTC', a)).toThrow(CoinLifecycleError);
    expect(registry.promoteDataReady('BTC', b).lifecycle).toBe('DATA_READY');
  });

  it('concurrent coins retain independent readiness ownership', async () => {
    const { registry } = await setup();
    const gate = deferred<InrFuturesInstrument>();
    const btc = registry.prepareDataReadiness('BTC', { getInrFuturesInstrument: () => gate.promise });
    const eth = await registry.prepareDataReadiness('ETH', reader);
    registry.promoteDataReady('ETH', eth);
    gate.resolve(instrument());
    registry.promoteDataReady('BTC', await btc);
    expect(registry.list().map(runtime => runtime.lifecycle)).toEqual(['DATA_READY', 'DATA_READY']);
  });

  it('repeated current completion is idempotent and does not republish registry changes', async () => {
    const { registry } = await setup();
    const proof = await registry.prepareDataReadiness('BTC', reader);
    const listener = vi.fn(); registry.subscribeChanges(listener);
    const first = registry.promoteDataReady('BTC', proof);
    expect(registry.promoteDataReady('BTC', proof)).toEqual(first);
    expect(listener).toHaveBeenCalledTimes(1);
    // Neither published evidence nor a generic transition can bypass the gate on reload.
    registry.transitionLifecycle('BTC', 'DATA_LOADING');
    expect(() => registry.promoteDataReady('BTC', proof)).toThrow(CoinLifecycleError);
    expect(() => registry.transitionLifecycle('BTC', 'DATA_READY')).toThrow(CoinLifecycleError);
    expect(registry.getByPair('B-BTC_USDT').dataReadiness).toBeUndefined();
  });

  it('synchronous disable from a readiness subscriber cannot be overwritten by promotion', async () => {
    const { registry } = await setup();
    const proof = await registry.prepareDataReadiness('BTC', reader);
    registry.subscribeChanges(() => {
      if (registry.getByUnderlying('BTC').lifecycle === 'DATA_READY') registry.transitionLifecycle('BTC', 'DISABLED');
    });
    expect(registry.promoteDataReady('BTC', proof).lifecycle).toBe('DISABLED');
    expect(() => registry.promoteDataReady('BTC', proof)).toThrow(CoinLifecycleError);
    expect(createSubscriptionIntent(registry.getByUnderlying('BTC'))).toBeNull();
  });

  it('restart bootstraps DISCOVERED and requires newly earned proof even when numeric revisions match', async () => {
    const original = await setup();
    const old = await original.registry.prepareDataReadiness('BTC', reader);
    original.registry.promoteDataReady('BTC', old);
    const registry = new CoinRegistry();
    const service = new CoinRuntimeBootstrapService({ findActiveInrPerpetualByUnderlying: async name => instrument(name) }, registry);
    await service.bootstrap([profile(), profile('ETH')]);
    expect(registry.getByUnderlying('BTC').lifecycle).toBe('DISCOVERED');
    expect(registry.getByPair('B-BTC_USDT').dataReadiness).toBeUndefined();
    registry.transitionLifecycle('BTC', 'DATA_LOADING');
    const current = await registry.prepareDataReadiness('BTC', reader);
    expect(current.lifecycleRevision).toBe(old.lifecycleRevision);
    expect(current.operationRevision).toBe(old.operationRevision);
    expect(() => registry.promoteDataReady('BTC', old)).toThrow(CoinLifecycleError);
    expect(registry.promoteDataReady('BTC', current).lifecycle).toBe('DATA_READY');
  });

  it('clear and rebuild cannot install pending evidence from the former runtime', async () => {
    const { registry, service } = await setup();
    const gate = deferred<InrFuturesInstrument>();
    const pending = registry.prepareDataReadiness('BTC', { getInrFuturesInstrument: () => gate.promise }).catch(error => error as Error);
    registry.clear();
    await service.bootstrap([profile()]);
    registry.transitionLifecycle('BTC', 'DATA_LOADING');
    gate.resolve(instrument());
    expect(await pending).toMatchObject({ details: { reason: 'SUPERSEDED' } });
    expect(registry.getByUnderlying('BTC').lifecycle).toBe('DATA_LOADING');
  });

  it('registration and replacement cannot inject a ready snapshot with genuine old evidence', async () => {
    const { registry } = await setup();
    const proof = await registry.prepareDataReadiness('BTC', reader);
    const ready = registry.promoteDataReady('BTC', proof) as DiscoveredCoinRuntime;
    expect(() => registry.replaceOrRegisterDiscovered(ready)).toThrow(CoinLifecycleError);
    const restarted = new CoinRegistry();
    expect(() => restarted.register(ready)).toThrow(CoinLifecycleError);
    expect(() => restarted.replaceOrRegisterDiscovered(ready)).toThrow(CoinLifecycleError);
    expect(restarted.size).toBe(0);
  });

  it.each([[true, 'EXIT_ONLY'], [null, 'RESTRICTION_UNKNOWN']] as const)(
    'data initialization preserves exit restriction %s without granting entry authority', async (exitOnly, eligibility) => {
      const { registry } = await setup();
      const proof = await registry.prepareDataReadiness('BTC', { getInrFuturesInstrument: async () => ({ ...instrument(), exitOnly }) });
      const ready = registry.promoteDataReady('BTC', proof);
      expect(ready.lifecycle).toBe('DATA_READY');
      expect(ready.entryEligibility).toBe(eligibility);
      expect(ready.instrument?.exitOnly).toBe(exitOnly);
    },
  );
});
