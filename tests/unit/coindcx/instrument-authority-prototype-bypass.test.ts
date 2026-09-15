/**
 * [F14-03] Regression for Astra's repository-level mutable-prototype bypass.
 *
 * The pre-fix version of these attacks invoked the patched executeRead once,
 * made zero network calls, and minted a trusted binding for multiplier 777 and
 * increments 9/8. Production authority must now ignore every repository-level
 * transport/reader substitute and acquire through native HTTPS instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoinDcxTransport, ExecuteReadOptions, HttpResponse } from '../../../src/integration/coindcx/transport';
import { interceptProductionInstrumentAcquisition } from '../../helpers/production-instrument-acquisition-harness';
import { wire } from './audit-a2-helpers';

const PAIR = 'B-BTC_USDT';
const GENUINE_WIRE = wire('BTC', {
  unit_contract_value: '0.001',
  price_increment: '0.1',
  quantity_increment: '0.001',
});
const FABRICATED_WIRE = wire('BTC', {
  unit_contract_value: '777',
  price_increment: '9',
  quantity_increment: '8',
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('F14-03 trusted instrument authority prototype bypass', () => {
  it('post-import prototype patch cannot mint fabricated metadata', async () => {
    vi.resetModules();
    const authority = await import('../../../src/integration/coindcx/instrument-authority');
    const transport = await import('../../../src/integration/coindcx/transport');
    const interception = interceptProductionInstrumentAcquisition(GENUINE_WIRE);
    let patchCalls = 0;
    vi.spyOn(transport.CoinDcxTransport.prototype, 'executeRead').mockImplementation(async () => {
      patchCalls += 1;
      return { status: 200, headers: {}, durationMs: 0, data: { instrument: FABRICATED_WIRE } } as never;
    });

    const binding = await authority.acquireProductionInstrumentBinding(PAIR);
    const record = authority.TrustedProductionInstrumentBinding.read(binding);

    expect(patchCalls).toBe(0);
    expect(interception.calls).toBe(1);
    expect(record).toMatchObject({
      contractMultiplier: '0.001', priceIncrement: '0.1', quantityIncrement: '0.001',
    });
  });

  it('pre-import prototype patch cannot capture or replace privileged acquisition', async () => {
    vi.resetModules();
    const transport = await import('../../../src/integration/coindcx/transport');
    let patchCalls = 0;
    vi.spyOn(transport.CoinDcxTransport.prototype, 'executeRead').mockImplementation(async () => {
      patchCalls += 1;
      return { status: 200, headers: {}, durationMs: 0, data: { instrument: FABRICATED_WIRE } } as never;
    });
    const interception = interceptProductionInstrumentAcquisition(GENUINE_WIRE);

    // Load the production authority only after the attacker has patched the
    // exported prototype. Capturing the prototype at import time would fail.
    const authority = await import('../../../src/integration/coindcx/instrument-authority');
    const binding = await authority.acquireProductionInstrumentBinding(PAIR);
    const record = authority.TrustedProductionInstrumentBinding.read(binding);

    expect(patchCalls).toBe(0);
    expect(interception.calls).toBe(1);
    expect(record).toMatchObject({
      contractMultiplier: '0.001', priceIncrement: '0.1', quantityIncrement: '0.001',
    });
  });

  it('subclass, Proxy, structural fake, and public injected readers remain untrusted', async () => {
    vi.resetModules();
    const authority = await import('../../../src/integration/coindcx/instrument-authority');
    const reader = await import('../../../src/integration/coindcx/instrument-reader');
    const transportModule = await import('../../../src/integration/coindcx/transport');
    const interception = interceptProductionInstrumentAcquisition(GENUINE_WIRE, GENUINE_WIRE, GENUINE_WIRE);
    let fakeCalls = 0;
    const fabricatedResponse = async () => {
      fakeCalls += 1;
      return { status: 200, headers: {}, durationMs: 0, data: { instrument: FABRICATED_WIRE } };
    };

    class FakeSubclass extends transportModule.CoinDcxTransport {
      public override async executeRead<T = unknown>(_options: ExecuteReadOptions): Promise<HttpResponse<T>> {
        return await fabricatedResponse() as HttpResponse<T>;
      }
    }
    const subclass = new FakeSubclass();
    const proxy = new Proxy(new transportModule.CoinDcxTransport(), {
      get(target, property, receiver): unknown {
        if (property === 'executeRead') return fabricatedResponse;
        return Reflect.get(target, property, receiver);
      },
    });
    const structuralFake = { executeRead: fabricatedResponse };

    // The public reusable reader remains injectable, but its structural output
    // is not a capability and cannot be read as a trusted production binding.
    for (const candidate of [subclass, proxy, structuralFake]) {
      const publicResult = await reader.readInrFuturesInstrument(
        candidate as CoinDcxTransport,
        PAIR,
      );
      expect(authority.TrustedProductionInstrumentBinding.read(publicResult)).toBeNull();
    }
    expect(fakeCalls).toBe(3);

    // Even an extra runtime argument cannot create a production injection
    // seam: the public function accepts and consumes only the canonical pair.
    const callWithInjection = authority.acquireProductionInstrumentBinding as unknown as (
      pair: string,
      injected: unknown,
    ) => Promise<unknown>;
    for (const candidate of [subclass, proxy, structuralFake]) {
      const binding = await callWithInjection(PAIR, candidate);
      expect(authority.TrustedProductionInstrumentBinding.read(binding)).toMatchObject({ contractMultiplier: '0.001' });
    }
    expect(fakeCalls).toBe(3);
    expect(interception.calls).toBe(3);
  });
});
