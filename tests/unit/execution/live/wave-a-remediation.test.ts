import { describe, expect, it } from 'vitest';
import { buildLiveExecutionPolicySnapshot, defaultLiveExecutionPolicyContent } from '../../../../src/execution/live/execution-policy';
import { createLiveExecutionIntent, LiveExecutionIntent } from '../../../../src/execution/live/intent';
import type { AuthoritativeInstrumentConstraints } from '../../../../src/execution/live/instrument-constraints';

const constraints: AuthoritativeInstrumentConstraints = Object.freeze({
  pair: 'B-BTC_USDT', instrumentSpecSnapshotId: 'spec-wave-a', quoteCurrency: 'USDT', settlementCurrency: 'USDT',
  priceIncrement: '1', quantityIncrement: '1', minQuantity: '1', maxQuantity: '100', minPrice: '1', maxPrice: '1000000',
  minNotional: '1', maxNotional: null, maxMarketOrderQuantity: null, contractMultiplier: '2',
  supportedOrderTypes: Object.freeze(['limit_order', 'market_order']), supportedTimeInForce: Object.freeze([]), exitOnly: false,
});

function create(overrides: { price?: string; quantity?: string; policyCap?: string; riskCap?: string; orderType?: 'LIMIT' | 'MARKET'; side?: 'BUY' | 'SELL' } = {}) {
  const orderType = overrides.orderType ?? 'LIMIT';
  return createLiveExecutionIntent({
    policy: buildLiveExecutionPolicySnapshot(defaultLiveExecutionPolicyContent(overrides.policyCap ?? '1600')),
    constraints,
    economics: {
      accountId: 'account-live-1', pair: constraints.pair, side: overrides.side ?? 'BUY', action: 'OPEN',
      quantity: overrides.quantity ?? '1', leverage: '2', riskDecisionId: 'risk-wave-a', admissionId: 'admission-wave-a',
      strategyInstanceId: 'instance-wave-a', strategyId: 'EMA_TREND', strategyVersion: '1.0.0', parameterHash: 'a'.repeat(64),
      authorizedNotionalInr: overrides.riskCap ?? '1600', settlementRateInrPerQuote: '80',
      positionInstanceId: null, positionRevision: null, reduceOnlyQuantity: null,
    },
    shape: { orderType, timeInForce: 'UNSPECIFIED', limitPrice: orderType === 'LIMIT' ? (overrides.price ?? '10') : null },
    lineage: { researchApproval: { validationSubjectId: 'subject', validationPlanId: 'plan', validationSubjectResultSha256: 'b'.repeat(64) }, sourceStrategyDecisionId: 'decision-wave-a' },
  });
}

describe('Phase17 Wave A INR notional envelope', () => {
  it('converts quote notional through the authoritative INR rate and accepts exactly at both ceilings', () => {
    const intent = LiveExecutionIntent.read(create());
    expect(intent?.content.price).toBe('10');
    expect(intent?.content.authorizedNotionalInr).toBe('1600');
    expect(intent?.content.settlementRateInrPerQuote).toBe('80');
  });

  it('rejects just over the application ceiling and just over the risk envelope', () => {
    expect(() => create({ policyCap: '1599.999999' })).toThrow(/Order notional exceeds/);
    expect(() => create({ riskCap: '1599.999999' })).toThrow(/Order notional exceeds/);
  });

  it('rejects a caller-manipulated limit price outside the accepted economics', () => {
    expect(() => create({ price: '11' })).toThrow(/Order notional exceeds/);
  });

  it('MARKET cannot bypass even a tiny INR ceiling', () => {
    expect(() => create({ orderType: 'MARKET', policyCap: '0.000001' })).toThrow(/MARKET live execution is unsupported/);
  });

  it('quantity and BUY price quantization can only reduce exposure', () => {
    const intent = LiveExecutionIntent.read(create({ quantity: '1.9', price: '10.9' }));
    expect(intent?.content.quantity).toBe('1');
    expect(intent?.content.price).toBe('10');
    expect(intent?.quantityAdjusted).toBe(true);
    expect(intent?.priceAdjusted).toBe(true);
  });

  it('SELL rounding that would increase authorized exposure is rejected', () => {
    expect(() => create({ side: 'SELL', price: '10.1' })).toThrow(/Order notional exceeds/);
  });
});
