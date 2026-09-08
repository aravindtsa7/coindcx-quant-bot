import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  riskDecimal, RiskEngine, RiskEngineError, normalizeCoinDcxPosition,
  type CanonicalPositionValuation, type PairRiskSnapshot,
} from '../../../src/risk';
import type { InrFuturesPosition } from '../../../src/integration/coindcx';
import { EVALUATION_TIME, makeAccount, makeContext, makeDecision, makePair, makePolicy, makeSettlement, resealContext, seal } from './helpers';

function valuation(changes: Partial<CanonicalPositionValuation> = {}): CanonicalPositionValuation {
  return {
    valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1', valuationPriceField: 'markPriceUsdt',
    valuationPriceUsdt: '100', valuationPriceSourceId: 'pair-source', valuationPriceSourceTimeMs: EVALUATION_TIME,
    valuationPriceObservedAtMs: EVALUATION_TIME, contractMultiplier: '0.001', conversionMarket: 'USDT_INR',
    conversionRateInrPerUsdt: '80', conversionSourceId: 'conversion-source', unitValuationInrPerQty: '8',
    aggregateCurrentNotionalInr: '80', ...changes,
  };
}

function openPair(changes: Partial<PairRiskSnapshot> = {}): PairRiskSnapshot {
  return seal({
    ...makePair(), position: { state: 'OPEN', positionId: 'position-1', positionDirection: 'LONG', quantityMagnitude: '10', valuation: valuation() },
    ownership: { status: 'RECONCILED', positionState: 'OPEN', accountId: 'account-1', pair: 'B-BTC_USDT', positionId: 'position-1',
      instanceOwnership: [{ strategyInstanceId: 'instance-1', strategyId: 'strategy-1', strategyVersion: '1.0.0', parameterHash: 'a'.repeat(64), currentQuantity: '10', currentNotionalInr: '80' }] },
    ...changes,
  });
}

function closeContext(pair = openPair()) {
  const decision = makeDecision('FLAT');
  return resealContext(makeContext({ candidate: { strategyDecision: decision, pair: decision.pair, instrumentSpecSnapshotId: 'instrument-1' }, entryStopProposal: null,
    leverageProposal: null, pairSnapshot: pair, exposureSnapshot: null, leverageTierSnapshot: null }));
}

function rawPosition(quantity: string): InrFuturesPosition {
  return { id: 'position-1', pair: 'B-BTC_USDT', activePositionQuantity: new Decimal(quantity) } as InrFuturesPosition;
}

describe('Phase 13 current valuation and strategy-instance ownership', () => {
  it('normalizes positive CoinDCX quantity to LONG magnitude', () => {
    expect(normalizeCoinDcxPosition(rawPosition('3.5'), null)).toMatchObject({ state: 'OPEN', positionDirection: 'LONG', quantityMagnitude: '3.5' });
  });

  it('normalizes negative CoinDCX quantity to SHORT absolute magnitude', () => {
    expect(normalizeCoinDcxPosition(rawPosition('-3.5'), null)).toMatchObject({ state: 'OPEN', positionDirection: 'SHORT', quantityMagnitude: '3.5' });
  });

  it('normalizes zero to structurally flat without a fabricated position ID', () => {
    expect(normalizeCoinDcxPosition(rawPosition('0'), null)).toEqual({ state: 'FLAT' });
  });

  it('accepts CLOSE for the exact owned instance share', () => {
    const result = new RiskEngine(makePolicy()).evaluateRisk(closeContext());
    expect(result.status).toBe('ACCEPTED');
    if (result.status === 'ACCEPTED' && result.action === 'CLOSE') expect(result.approved).toEqual({ approvedQuantity: '10', approvedNotionalUsdt: '1', approvedNotionalInr: '80' });
  });

  it.each(['0', '-1'])('rejects present %s instance quantity as unreconciled', (currentQuantity) => {
    const pair = openPair({ ownership: { status: 'RECONCILED', positionState: 'OPEN', accountId: 'account-1', pair: 'B-BTC_USDT', positionId: 'position-1',
      instanceOwnership: [{ strategyInstanceId: 'instance-1', strategyId: 'strategy-1', strategyVersion: '1.0.0', parameterHash: 'a'.repeat(64), currentQuantity, currentNotionalInr: '80' }] } });
    const result = new RiskEngine(makePolicy()).evaluateRisk(closeContext(pair));
    expect(result.status).toBe('REJECTED');
    if (result.status === 'REJECTED') expect([result.primaryReasonCode, ...result.secondaryReasonCodes]).toContain('POSITION_OWNERSHIP_UNRECONCILED');
  });

  it('rejects a mixed-sign set before cancellation can reconcile', () => {
    const pair = openPair({ ownership: { status: 'RECONCILED', positionState: 'OPEN', accountId: 'account-1', pair: 'B-BTC_USDT', positionId: 'position-1',
      instanceOwnership: [
        { strategyInstanceId: 'instance-1', strategyId: 'strategy-1', strategyVersion: '1.0.0', parameterHash: 'a'.repeat(64), currentQuantity: '11', currentNotionalInr: '88' },
        { strategyInstanceId: 'instance-2', strategyId: 'strategy-2', strategyVersion: '1.0.0', parameterHash: 'b'.repeat(64), currentQuantity: '-1', currentNotionalInr: '-8' },
      ] } });
    const result = new RiskEngine(makePolicy()).evaluateRisk(closeContext(pair));
    expect(result.status === 'REJECTED' && [result.primaryReasonCode, ...result.secondaryReasonCodes]).toContain('POSITION_OWNERSHIP_UNRECONCILED');
  });

  it('does not authorize a same-strategy sibling instance', () => {
    const pair = openPair({ ownership: { status: 'RECONCILED', positionState: 'OPEN', accountId: 'account-1', pair: 'B-BTC_USDT', positionId: 'position-1',
      instanceOwnership: [{ strategyInstanceId: 'instance-2', strategyId: 'strategy-1', strategyVersion: '1.0.0', parameterHash: 'a'.repeat(64), currentQuantity: '10', currentNotionalInr: '80' }] } });
    const result = new RiskEngine(makePolicy()).evaluateRisk(closeContext(pair));
    expect(result.status === 'REJECTED' && [result.primaryReasonCode, ...result.secondaryReasonCodes]).toContain('POSITION_OWNERSHIP_MISMATCH');
  });

  it.each(['strategyId', 'strategyVersion', 'parameterHash'] as const)('rejects a %s mismatch on the matching instance identity', (field) => {
    const record = { strategyInstanceId: 'instance-1', strategyId: 'strategy-1', strategyVersion: '1.0.0', parameterHash: 'a'.repeat(64), currentQuantity: '10', currentNotionalInr: '80', [field]: 'wrong' };
    const pair = openPair({ ownership: { status: 'RECONCILED', positionState: 'OPEN', accountId: 'account-1', pair: 'B-BTC_USDT', positionId: 'position-1', instanceOwnership: [record] } });
    const result = new RiskEngine(makePolicy()).evaluateRisk(closeContext(pair));
    expect(result.status === 'REJECTED' && result.primaryReasonCode).toBe('DECISION_IDENTITY_MISMATCH');
  });

  it('rejects position ID, aggregate quantity, and aggregate notional mismatches', () => {
    const pair = openPair({ position: { state: 'OPEN', positionId: 'position-2', positionDirection: 'LONG', quantityMagnitude: '11', valuation: valuation({ aggregateCurrentNotionalInr: '88' }) } });
    const result = new RiskEngine(makePolicy()).evaluateRisk(closeContext(pair));
    expect(result.status).toBe('REJECTED');
    if (result.status === 'REJECTED') {
      const codes = [result.primaryReasonCode, ...result.secondaryReasonCodes];
      expect(codes).toContain('POSITION_IDENTITY_MISMATCH');
      expect(codes).toContain('POSITION_OWNERSHIP_UNRECONCILED');
    }
  });

  it('rejects null mark valuation without using historical substitutes', () => {
    const result = new RiskEngine(makePolicy()).evaluateRisk(closeContext(openPair({ position: { state: 'OPEN', positionId: 'position-1', positionDirection: 'LONG', quantityMagnitude: '10', valuation: null } })));
    expect(result.status === 'REJECTED' && [result.primaryReasonCode, ...result.secondaryReasonCodes]).toContain('POSITION_OWNERSHIP_UNRECONCILED');
  });

  it('rejects a caller-fabricated notional under exact recomputation', () => {
    const pair = openPair({ position: { state: 'OPEN', positionId: 'position-1', positionDirection: 'LONG', quantityMagnitude: '10', valuation: valuation({ aggregateCurrentNotionalInr: '81' }) } });
    const result = new RiskEngine(makePolicy()).evaluateRisk(closeContext(pair));
    expect(result.status === 'REJECTED' && [result.primaryReasonCode, ...result.secondaryReasonCodes]).toContain('POSITION_OWNERSHIP_UNRECONCILED');
  });

  it('responds exactly to mark-price and conversion-rate changes', () => {
    const priced = openPair({ position: { state: 'OPEN', positionId: 'position-1', positionDirection: 'LONG', quantityMagnitude: '10', valuation: valuation({ valuationPriceUsdt: '101', unitValuationInrPerQty: '8.08', aggregateCurrentNotionalInr: '80.8' }) },
      ownership: { status: 'RECONCILED', positionState: 'OPEN', accountId: 'account-1', pair: 'B-BTC_USDT', positionId: 'position-1', instanceOwnership: [{ strategyInstanceId: 'instance-1', strategyId: 'strategy-1', strategyVersion: '1.0.0', parameterHash: 'a'.repeat(64), currentQuantity: '10', currentNotionalInr: '80.8' }] } });
    const priceResult = new RiskEngine(makePolicy()).evaluateRisk(closeContext(priced));
    expect(priceResult.status === 'ACCEPTED' && priceResult.action === 'CLOSE' && priceResult.approved.approvedNotionalUsdt).toBe('1.01');

    const converted = openPair({ position: { state: 'OPEN', positionId: 'position-1', positionDirection: 'LONG', quantityMagnitude: '10', valuation: valuation({ conversionRateInrPerUsdt: '81', unitValuationInrPerQty: '8.1', aggregateCurrentNotionalInr: '81' }) },
      ownership: { status: 'RECONCILED', positionState: 'OPEN', accountId: 'account-1', pair: 'B-BTC_USDT', positionId: 'position-1', instanceOwnership: [{ strategyInstanceId: 'instance-1', strategyId: 'strategy-1', strategyVersion: '1.0.0', parameterHash: 'a'.repeat(64), currentQuantity: '10', currentNotionalInr: '81' }] } });
    const settlement = seal({ ...makeSettlement(), rateInrPerUsdt: '81' });
    const conversionResult = new RiskEngine(makePolicy()).evaluateRisk(resealContext({ ...closeContext(converted), pairSnapshot: converted, settlementRateSnapshot: settlement }));
    expect(conversionResult.status === 'ACCEPTED' && conversionResult.action === 'CLOSE' && conversionResult.approved.approvedNotionalInr).toBe('81');
  });

  it('reconciles huge canonical Decimal values exactly inside the context', () => {
    const quantity = '12345678901234567890123456789';
    const price = '98765432109876543210987654321';
    const notional = riskDecimal(quantity).mul(price).toFixed();
    const hugePair = openPair({ contractMultiplier: '1', position: { state: 'OPEN', positionId: 'position-1', positionDirection: 'LONG', quantityMagnitude: quantity,
      valuation: valuation({ valuationPriceUsdt: price, contractMultiplier: '1', conversionRateInrPerUsdt: '1', unitValuationInrPerQty: price, aggregateCurrentNotionalInr: notional }) },
      ownership: { status: 'RECONCILED', positionState: 'OPEN', accountId: 'account-1', pair: 'B-BTC_USDT', positionId: 'position-1', instanceOwnership: [{ strategyInstanceId: 'instance-1', strategyId: 'strategy-1', strategyVersion: '1.0.0', parameterHash: 'a'.repeat(64), currentQuantity: quantity, currentNotionalInr: notional }] } });
    const settlement = seal({ ...makeSettlement(), rateInrPerUsdt: '1' });
    const result = new RiskEngine(makePolicy()).evaluateRisk(resealContext({ ...closeContext(hugePair), pairSnapshot: hugePair, settlementRateSnapshot: settlement }));
    expect(result.status).toBe('ACCEPTED');
    if (result.status === 'ACCEPTED' && result.action === 'CLOSE') expect(result.approved.approvedNotionalInr).toBe(notional);
  });

  it('routes valuation method mismatch to its dedicated Group-B code', () => {
    const bad = valuation({ valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1' });
    (bad as { valuationMethodVersion: string }).valuationMethodVersion = 'OTHER';
    const pair = openPair({ position: { state: 'OPEN', positionId: 'position-1', positionDirection: 'LONG', quantityMagnitude: '10', valuation: bad } });
    const result = new RiskEngine(makePolicy()).evaluateRisk(closeContext(pair));
    expect(result.status === 'REJECTED' && result.primaryReasonCode).toBe('VALUATION_METHOD_MISMATCH');
  });

  it('separates source-ID mismatch from content-hash mismatch', () => {
    const base = makeContext();
    const sourceWrong = seal({ ...base.pairSnapshot, provenance: { ...base.pairSnapshot.provenance, sourceId: 'wrong' } });
    const sourceResult = new RiskEngine(makePolicy()).evaluateRisk({ ...base, pairSnapshot: sourceWrong });
    expect(sourceResult.status === 'REJECTED' && sourceResult.primaryReasonCode).toBe('SOURCE_ID_MISMATCH');
    const hashWrong = { ...base.pairSnapshot, provenance: { ...base.pairSnapshot.provenance, contentSha256: 'b'.repeat(64) } };
    const hashResult = new RiskEngine(makePolicy()).evaluateRisk({ ...base, pairSnapshot: hashWrong });
    expect(hashResult.status === 'REJECTED' && hashResult.primaryReasonCode).toBe('DECISION_IDENTITY_MISMATCH');
  });

  it('throws malformed and non-finite Decimal evidence as RISK_SOURCE_INVALID', () => {
    for (const value of ['abc', 'NaN', 'Infinity']) {
      const context = makeContext();
      expect(() => new RiskEngine(makePolicy()).evaluateRisk({ ...context, pairSnapshot: { ...context.pairSnapshot, minNotional: value } })).toThrowError(RiskEngineError);
    }
  });

  it('returns numeric-context exhaustion as a RejectedRiskDecision', () => {
    const huge = '9'.repeat(70);
    const pair = openPair({ contractMultiplier: huge, position: { state: 'OPEN', positionId: 'position-1', positionDirection: 'LONG', quantityMagnitude: '1',
      valuation: valuation({ valuationPriceUsdt: huge, contractMultiplier: huge, conversionRateInrPerUsdt: '1', unitValuationInrPerQty: '1', aggregateCurrentNotionalInr: '1' }) },
      ownership: { status: 'RECONCILED', positionState: 'OPEN', accountId: 'account-1', pair: 'B-BTC_USDT', positionId: 'position-1', instanceOwnership: [{ strategyInstanceId: 'instance-1', strategyId: 'strategy-1', strategyVersion: '1.0.0', parameterHash: 'a'.repeat(64), currentQuantity: '1', currentNotionalInr: '1' }] } });
    const settlement = seal({ ...makeSettlement(), rateInrPerUsdt: '1' });
    const result = new RiskEngine(makePolicy()).evaluateRisk(resealContext({ ...closeContext(pair), pairSnapshot: pair, settlementRateSnapshot: settlement, accountSnapshot: makeAccount() }));
    expect(result.status).toBe('REJECTED');
    if (result.status === 'REJECTED') expect([result.primaryReasonCode, ...result.secondaryReasonCodes]).toContain('VALUATION_NUMERIC_CONTEXT_EXCEEDED');
  });
});
