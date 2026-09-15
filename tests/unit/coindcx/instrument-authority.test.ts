import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256CanonicalJson } from '../../../src/backtest/canonical-json';
import { mapInstrumentToMetadata } from '../../../src/coin-runtime/instrument-mapper';
import * as coindcxPublic from '../../../src/integration/coindcx';
import {
  acquireProductionInstrumentBinding,
  COINDCX_INR_FUTURES_INSTRUMENT_SOURCE_ID,
  PRODUCTION_INSTRUMENT_SPEC_IDENTITY_POLICY_ID,
  TrustedProductionInstrumentBinding,
  type TrustedProductionInstrumentBindingRecord,
} from '../../../src/integration/coindcx/instrument-authority';
import { CoinDcxTransport } from '../../../src/integration/coindcx/transport';
import { instrument, wire } from './audit-a2-helpers';

const PAIR = 'B-BTC_USDT';

function mockInstrumentReads(...responses: readonly Record<string, unknown>[]): void {
  let index = 0;
  vi.spyOn(CoinDcxTransport.prototype, 'executeRead').mockImplementation(async options => {
    expect(options).toMatchObject({
      endpoint: 'INSTRUMENT',
      queryParams: { pair: PAIR, margin_currency_short_name: 'INR' },
    });
    const response = responses[index] ?? responses.at(-1);
    index += 1;
    return { status: 200, headers: {}, durationMs: 0, data: { instrument: response } };
  });
}

function read(binding: TrustedProductionInstrumentBinding): TrustedProductionInstrumentBindingRecord {
  const record = TrustedProductionInstrumentBinding.read(binding);
  if (record === null) throw new Error('Expected genuine trusted instrument binding');
  return record;
}

afterEach(() => vi.restoreAllMocks());

describe('Wave3-A production instrument acquisition authority', () => {
  it('issues an immutable trusted binding only after the approved CoinDCX read/schema/normalization path', async () => {
    mockInstrumentReads(wire('BTC', {
      unit_contract_value: '0.001', price_increment: '0.10', quantity_increment: '0.001',
    }));

    const binding = await acquireProductionInstrumentBinding(PAIR);
    const record = read(binding);
    expect(record).toEqual({
      sourceId: COINDCX_INR_FUTURES_INSTRUMENT_SOURCE_ID,
      instrumentSpecIdentityPolicyId: PRODUCTION_INSTRUMENT_SPEC_IDENTITY_POLICY_ID,
      instrumentSpecSnapshotId: expect.stringMatching(/^[0-9a-f]{64}$/),
      pair: PAIR,
      contractMultiplier: '0.001',
      priceIncrement: '0.1',
      quantityIncrement: '0.001',
      underlying: 'BTC',
      quoteCurrency: 'USDT',
      marginCurrency: 'INR',
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
  });

  it('does not trust structural InstrumentMetadata or a manually hashed look-alike', () => {
    const metadata = mapInstrumentToMetadata(instrument(), 'BTC');
    expect(TrustedProductionInstrumentBinding.read(metadata)).toBeNull();
    expect(TrustedProductionInstrumentBinding.read({
      sourceId: COINDCX_INR_FUTURES_INSTRUMENT_SOURCE_ID,
      instrumentSpecIdentityPolicyId: PRODUCTION_INSTRUMENT_SPEC_IDENTITY_POLICY_ID,
      instrumentSpecSnapshotId: sha256CanonicalJson({
        pair: metadata.pair,
        contractMultiplier: metadata.unitContractValue.toFixed(),
        priceIncrement: metadata.priceIncrement.toFixed(),
        quantityIncrement: metadata.quantityIncrement.toFixed(),
      }),
      pair: metadata.pair,
      contractMultiplier: metadata.unitContractValue.toFixed(),
      priceIncrement: metadata.priceIncrement.toFixed(),
      quantityIncrement: metadata.quantityIncrement.toFixed(),
      underlying: metadata.underlying,
      quoteCurrency: metadata.quoteCurrency,
      marginCurrency: metadata.marginCurrency,
    })).toBeNull();
  });

  it('rejects fake symbols, string brands, prototype forgeries, and subclasses', () => {
    const fakeRecord = {
      sourceId: COINDCX_INR_FUTURES_INSTRUMENT_SOURCE_ID,
      instrumentSpecIdentityPolicyId: PRODUCTION_INSTRUMENT_SPEC_IDENTITY_POLICY_ID,
      instrumentSpecSnapshotId: 'a'.repeat(64), pair: PAIR, contractMultiplier: '0.001',
      priceIncrement: '0.1', quantityIncrement: '0.001', underlying: 'BTC', quoteCurrency: 'USDT', marginCurrency: 'INR' as const,
    };
    expect(() => new TrustedProductionInstrumentBinding(Symbol('fake'), fakeRecord)).toThrow();
    expect(TrustedProductionInstrumentBinding.read({ ...fakeRecord, trusted: true, brand: 'PRODUCTION', issuer: Symbol('fake') })).toBeNull();
    expect(TrustedProductionInstrumentBinding.read(Object.create(TrustedProductionInstrumentBinding.prototype))).toBeNull();
    class ForgedBinding extends TrustedProductionInstrumentBinding {
      public constructor() { super(Symbol('subclass-fake'), fakeRecord); }
    }
    expect(() => new ForgedBinding()).toThrow();
  });

  it('prevents consumer mutation from changing trusted multiplier or increments', async () => {
    mockInstrumentReads(wire('BTC', {
      unit_contract_value: '0.001', price_increment: '0.1', quantity_increment: '0.001',
    }));
    const record = read(await acquireProductionInstrumentBinding(PAIR));
    expect(Reflect.set(record, 'contractMultiplier', '1')).toBe(false);
    expect(Reflect.set(record, 'priceIncrement', '9')).toBe(false);
    expect(Reflect.set(record, 'quantityIncrement', '9')).toBe(false);
    expect(record).toMatchObject({ contractMultiplier: '0.001', priceIncrement: '0.1', quantityIncrement: '0.001' });
  });

  it('fails closed when the acquired response pair differs from the requested canonical pair', async () => {
    mockInstrumentReads(wire('ETH'));
    await expect(acquireProductionInstrumentBinding(PAIR)).rejects.toMatchObject({ code: 'COINDCX_RESPONSE_VALIDATION_ERROR' });
  });

  it.each([
    ['unit_contract_value', 'contractMultiplier'],
    ['price_increment', 'priceIncrement'],
    ['quantity_increment', 'quantityIncrement'],
  ] as const)('rejects zero and negative %s at the authority boundary', async (wireField, label) => {
    for (const invalid of ['0', '-0.001']) {
      vi.restoreAllMocks();
      mockInstrumentReads(wire('BTC', { [wireField]: invalid }));
      await expect(acquireProductionInstrumentBinding(PAIR)).rejects.toThrow(`${label} must be a strictly positive finite Decimal`);
    }
  });

  it('rejects non-INR margin and non-perpetual product responses', async () => {
    mockInstrumentReads(wire('BTC', { margin_currency_short_name: 'USDT' }));
    await expect(acquireProductionInstrumentBinding(PAIR)).rejects.toMatchObject({ code: 'COINDCX_RESPONSE_VALIDATION_ERROR' });
    vi.restoreAllMocks();
    mockInstrumentReads(wire('BTC', { kind: 'spot' }));
    await expect(acquireProductionInstrumentBinding(PAIR)).rejects.toThrow('is not a perpetual Futures product');
  });

  it('preserves exact fractional Decimal source values without native-number conversion', async () => {
    mockInstrumentReads(wire('BTC', {
      unit_contract_value: '0.000000000000000001', price_increment: '0.000000000000000003', quantity_increment: '0.000000000000000007',
    }));
    expect(read(await acquireProductionInstrumentBinding(PAIR))).toMatchObject({
      contractMultiplier: '0.000000000000000001',
      priceIncrement: '0.000000000000000003',
      quantityIncrement: '0.000000000000000007',
    });
  });

  it('is deterministic for identical source facts', async () => {
    mockInstrumentReads(wire('BTC'), wire('BTC'));
    const first = read(await acquireProductionInstrumentBinding(PAIR)).instrumentSpecSnapshotId;
    const second = read(await acquireProductionInstrumentBinding(PAIR)).instrumentSpecSnapshotId;
    expect(second).toBe(first);
  });

  it.each(['unit_contract_value', 'price_increment', 'quantity_increment'] as const)(
    'changes identity when %s changes', async field => {
      mockInstrumentReads(wire('BTC'), wire('BTC', { [field]: '0.123456789' }));
      const first = read(await acquireProductionInstrumentBinding(PAIR)).instrumentSpecSnapshotId;
      const second = read(await acquireProductionInstrumentBinding(PAIR)).instrumentSpecSnapshotId;
      expect(second).not.toBe(first);
    },
  );

  it('does not expose acquisition, issuer, registry, or trust-reader symbols through the production barrel', () => {
    const publicSurface = coindcxPublic as Record<string, unknown>;
    for (const name of [
      'acquireProductionInstrumentBinding', 'INSTRUMENT_BINDING_ISSUER',
      'TrustedProductionInstrumentBinding', 'issueBinding',
    ]) expect(publicSurface[name]).toBeUndefined();
  });
});
