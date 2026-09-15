import { describe, expect, it } from 'vitest';
import {
  buildInstrumentEconomicsSnapshot, validateInstrumentEconomicsSnapshot,
  INSTRUMENT_ECONOMICS_IDENTITY_POLICY_ID, type InstrumentEconomicsSnapshotContent,
} from '../../../src/execution/instrument-economics';

function content(overrides: Partial<InstrumentEconomicsSnapshotContent> = {}) {
  return {
    identityPolicyId: INSTRUMENT_ECONOMICS_IDENTITY_POLICY_ID,
    sourceId: 'COINDCX_INR_FUTURES_INSTRUMENT_REST_V1',
    instrumentSpecIdentityPolicyId: 'P14_PRODUCTION_INSTRUMENT_SPEC_IDENTITY_V1',
    instrumentSpecSnapshotId: 'a'.repeat(64), pair: 'B-BTC_USDT',
    contractMultiplier: '0.001', priceIncrement: '0.5', quantityIncrement: '1',
    ...overrides,
  };
}

describe('F14-03 durable instrument economics identity', () => {
  it('uses the exact frozen preimage and is deterministic across equivalent decimals', () => {
    const a = buildInstrumentEconomicsSnapshot(content());
    const b = buildInstrumentEconomicsSnapshot(content({ contractMultiplier: '0.0010', priceIncrement: '00.500' }));
    expect(a).toEqual(b);
    expect(validateInstrumentEconomicsSnapshot(a)).toEqual(a);
  });

  it.each(['sourceId', 'instrumentSpecIdentityPolicyId', 'instrumentSpecSnapshotId', 'pair', 'contractMultiplier', 'priceIncrement', 'quantityIncrement'] as const)(
    'changes identity when %s changes',
    (field) => {
      const changed = field === 'contractMultiplier' ? '0.002' : field === 'priceIncrement' ? '1' : field === 'quantityIncrement' ? '2' : `${content()[field]}-changed`;
      expect(buildInstrumentEconomicsSnapshot(content({ [field]: changed })).instrumentEconomicsSnapshotId)
        .not.toBe(buildInstrumentEconomicsSnapshot(content()).instrumentEconomicsSnapshotId);
    },
  );

  it('rejects an ID/content spoof', () => {
    const a = buildInstrumentEconomicsSnapshot(content());
    const b = buildInstrumentEconomicsSnapshot(content({ contractMultiplier: '1' }));
    expect(() => validateInstrumentEconomicsSnapshot({ ...b, instrumentEconomicsSnapshotId: a.instrumentEconomicsSnapshotId }))
      .toThrow(/INSTRUMENT_ECONOMICS_IDENTITY_MISMATCH/);
  });

  it.each([
    ['contractMultiplier', '0'], ['contractMultiplier', '-1'],
    ['priceIncrement', '0'], ['priceIncrement', '-1'],
    ['quantityIncrement', '0'], ['quantityIncrement', '-1'],
    ['contractMultiplier', '0.0000000000000000001'], ['priceIncrement', '1000000000000000000'],
  ] as const)('rejects invalid/non-persistable %s=%s without rounding', (field, value) => {
    expect(() => buildInstrumentEconomicsSnapshot(content({ [field]: value }))).toThrow();
  });
});
