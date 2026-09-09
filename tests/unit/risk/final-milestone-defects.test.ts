import { makeOrigin } from './helpers';
import { TEST_INSTANCE_ID, TEST_PARAMETER_HASH, makeLineage } from './helpers';
import { describe, expect, it } from 'vitest';
import {
  REJECTION_PRECEDENCE_V1, riskDecimal, RiskConfigError, RiskEngine, RiskEngineError,
  type InstanceOwnershipRecord, type PairRiskSnapshot, type PortfolioExposureSnapshot, type RiskDecision,
} from '../../../src/risk';
import { exposureHeadroom } from '../../../src/risk/exposure';
import { orderReasonCodes, type RiskRejectionCode } from '../../../src/risk/reason-codes';
import {
  EVALUATION_TIME, makeAccount, makeContext, makeDecision, makeExposure, makePair, makePolicy,
  resealContext, seal,
} from './helpers';

function rejectionCodes(result: RiskDecision): readonly string[] {
  return result.status === 'REJECTED' ? [result.primaryReasonCode, ...result.secondaryReasonCodes] : [];
}

function evaluate(changes: Parameters<typeof makeContext>[0] = {}): RiskDecision {
  return new RiskEngine(makePolicy()).evaluateRisk(resealContext(makeContext(changes)));
}

function openPair(records: readonly InstanceOwnershipRecord[], quantity = '10'): PairRiskSnapshot {
  return seal({
    ...makePair(),
    position: {
      state: 'OPEN' as const, positionId: 'position-1', positionDirection: 'LONG' as const, quantityMagnitude: quantity,
      valuation: {
        valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1' as const, valuationPriceField: 'markPriceUsdt' as const,
        valuationPriceUsdt: '100', valuationPriceSourceId: 'pair-source', valuationPriceSourceTimeMs: EVALUATION_TIME,
        valuationPriceObservedAtMs: EVALUATION_TIME, contractMultiplier: '0.001', conversionMarket: 'USDT_INR',
        conversionRateInrPerUsdt: '80', conversionSourceId: 'conversion-source', unitValuationInrPerQty: '8',
        aggregateCurrentNotionalInr: riskDecimal(quantity).mul(8).toFixed(),
      },
    },
    ownership: {
      status: 'RECONCILED' as const, positionState: 'OPEN' as const, accountId: 'account-1', pair: 'B-BTC_USDT',
      positionId: 'position-1', instanceOwnership: records,
    },
  });
}

function record(currentQuantity: string, currentNotionalInr: string, changes: Partial<InstanceOwnershipRecord> = {}): InstanceOwnershipRecord {
  return {
    strategyInstanceId: TEST_INSTANCE_ID, strategyId: 'EMA_TREND', strategyVersion: '1.0.0', parameterHash: TEST_PARAMETER_HASH,
    currentQuantity, currentNotionalInr, ...changes,
  };
}

function closeResult(pairSnapshot: PairRiskSnapshot, accountStateKnown = true, target: 'FLAT' | 'SHORT' | 'LONG' = 'FLAT'): RiskDecision {
  const strategyDecision = makeDecision(target);
  return new RiskEngine(makePolicy()).evaluateRisk(resealContext({
    ...makeContext(), strategyOrigin: makeOrigin(strategyDecision), candidate: { strategyLineage: makeLineage(), strategyDecision, pair: strategyDecision.pair, instrumentSpecSnapshotId: 'instrument-1' },
    entryStopProposal: null, leverageProposal: null, pairSnapshot,
    accountSnapshot: seal({ ...makeAccount(), accountStateKnown }),
  }));
}

describe('P13-FINAL-001 runtime-immutable rejection taxonomy', () => {
  it.each(['push', 'splice', 'sort', 'index'] as const)('rejects attempted %s mutation', (operation) => {
    const mutable = REJECTION_PRECEDENCE_V1 as RiskRejectionCode[];
    expect(() => {
      if (operation === 'push') mutable.push('DAILY_LOSS_LIMIT');
      else if (operation === 'splice') mutable.splice(0, 1);
      else if (operation === 'sort') mutable.sort();
      else mutable[0] = 'DAILY_LOSS_LIMIT';
    }).toThrow(TypeError);
    expect(REJECTION_PRECEDENCE_V1).toHaveLength(39);
  });

  it('preserves an existing engine hard rejection after attempted mutation', () => {
    const engine = new RiskEngine(makePolicy());
    const context = makeContext();
    if (context.accountSnapshot === null) throw new Error('fixture');
    const failing = resealContext({ ...context, accountSnapshot: {
      ...context.accountSnapshot,
      dailyPnl: { ...context.accountSnapshot.dailyPnl, realizedTradingPnlInr: '-40000', netDailyPnlInr: '-40000' },
    } });
    const before = engine.evaluateRisk(failing);
    expect(() => (REJECTION_PRECEDENCE_V1 as RiskRejectionCode[]).splice(REJECTION_PRECEDENCE_V1.indexOf('DAILY_LOSS_LIMIT'), 1)).toThrow(TypeError);
    const after = engine.evaluateRisk(failing);
    expect(after).toEqual(before);
    expect(rejectionCodes(after)).toContain('DAILY_LOSS_LIMIT');
  });

  it('keeps simultaneous reasons canonical and byte deterministic', () => {
    const exposure = seal({ ...makeExposure(), globalOpenNotionalInr: '800000', perPairOpenNotionalInr: { 'B-BTC_USDT': '400000' } });
    const context = resealContext(makeContext({ exposureSnapshot: exposure }));
    const engine = new RiskEngine(makePolicy());
    const first = engine.evaluateRisk(context);
    const second = engine.evaluateRisk(context);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(rejectionCodes(first)).toEqual(REJECTION_PRECEDENCE_V1.filter((code) => rejectionCodes(first).includes(code)));
  });

  it('never silently drops an unknown reason', () => {
    expect(() => orderReasonCodes(['NOT_A_FROZEN_REASON' as RiskRejectionCode])).toThrowError(RiskConfigError);
  });

  it('freezes both exported taxonomy groups', async () => {
    const taxonomy = await import('../../../src/risk/reason-codes');
    expect(Object.isFrozen(taxonomy.GROUP_A_REASON_CODES)).toBe(true);
    expect(Object.isFrozen(taxonomy.GROUP_B_REASON_CODES)).toBe(true);
    expect(() => (taxonomy.GROUP_A_REASON_CODES as unknown as string[]).push('OTHER')).toThrow(TypeError);
    expect(() => (taxonomy.GROUP_B_REASON_CODES as unknown as string[]).splice(0, 1)).toThrow(TypeError);
  });
});

describe('P13-FINAL-002 account integrity across actions', () => {
  it('rejects OPEN with unknown account state', () => {
    expect(rejectionCodes(evaluate({ accountSnapshot: seal({ ...makeAccount(), accountStateKnown: false }) }))).toContain('ACCOUNT_STATE_UNAVAILABLE');
  });

  it('rejects CLOSE with unknown account state', () => {
    expect(rejectionCodes(closeResult(openPair([record('10', '80')]), false))).toContain('ACCOUNT_STATE_UNAVAILABLE');
  });

  it('accepts CLOSE with known account state', () => {
    expect(closeResult(openPair([record('10', '80')])).status).toBe('ACCEPTED');
  });

  it('rejects REVERSAL_DEFERRED with both action and unknown-account reasons', () => {
    const codes = rejectionCodes(closeResult(openPair([record('10', '80')]), false, 'SHORT'));
    expect(codes).toEqual(expect.arrayContaining(['ACCOUNT_STATE_UNAVAILABLE', 'REVERSAL_REQUIRES_SEQUENTIAL_EVALUATION']));
  });

  it('keeps NO_CHANGE terminal without requiring account integrity', () => {
    const result = closeResult(openPair([record('10', '80')]), false, 'LONG');
    expect(rejectionCodes(result)).toEqual(['NO_CHANGE_TARGET_ALREADY_HELD']);
  });
});

describe('P13-FINAL-003 unique instance ownership', () => {
  it.each([
    [record('3', '24'), record('7', '56')],
    [record('7', '56'), record('3', '24')],
    [record('3', '24'), record('7', '56', { strategyVersion: '2.0.0' })],
    [record('3', '24'), record('7', '56', { parameterHash: 'b'.repeat(64) })],
  ])('rejects duplicate strategyInstanceId allocations', (...records) => {
    const result = closeResult(openPair(records));
    expect(result.status).toBe('REJECTED');
    expect(rejectionCodes(result)).toContain('POSITION_OWNERSHIP_UNRECONCILED');
  });

  it('accepts a unique two-instance allocation and closes only the proven share', () => {
    const result = closeResult(openPair([record('3', '24'), record('7', '56', { strategyInstanceId: 'instance-2' })]));
    expect(result.status === 'ACCEPTED' && result.action === 'CLOSE' && result.approved.approvedQuantity).toBe('3');
  });

  it('cannot turn duplicate ownership into a partial CLOSE', () => {
    const result = closeResult(openPair([record('3', '24'), record('7', '56')]));
    expect(result.status).toBe('REJECTED');
    if (result.status === 'REJECTED') expect(result.approved).toBeNull();
  });

  it('keeps duplicate rejection semantics invariant under record permutation', () => {
    const first = closeResult(openPair([record('3', '24'), record('7', '56')]));
    const second = closeResult(openPair([record('7', '56'), record('3', '24')]));
    expect(second.status).toBe('REJECTED');
    expect(rejectionCodes(second)).toEqual(rejectionCodes(first));
    if (first.status === 'REJECTED' && second.status === 'REJECTED') {
      expect(first.approved).toBeNull();
      expect(second.approved).toBeNull();
    }
  });
});

describe('P13-FINAL-004 nonnegative gross exposure', () => {
  function changedExposure(change: (base: Extract<PortfolioExposureSnapshot['pending'], { status: 'KNOWN' }>, exposure: PortfolioExposureSnapshot) => PortfolioExposureSnapshot): PortfolioExposureSnapshot {
    const exposure = makeExposure();
    if (exposure.pending.status !== 'KNOWN') throw new Error('fixture');
    return seal(change(exposure.pending, exposure));
  }

  it.each([
    changedExposure((pending, exposure) => ({ ...exposure, pending: { ...pending, globalPendingNotionalInr: '-1' } })),
    changedExposure((pending, exposure) => ({ ...exposure, pending: { ...pending, pairPendingNotionalInr: { 'B-BTC_USDT': '-1' } } })),
    changedExposure((pending, exposure) => ({ ...exposure, pending: { ...pending, strategyPendingNotionalInr: { 'EMA_TREND': '-1' } } })),
    changedExposure((pending, exposure) => ({ ...exposure, globalOpenNotionalInr: '-1', pending })),
  ])('rejects negative gross exposure evidence', (exposureSnapshot) => {
    expect(rejectionCodes(evaluate({ exposureSnapshot }))).toContain('EXPOSURE_STATE_UNAVAILABLE');
    expect(exposureHeadroom(exposureSnapshot, makeContext().candidate, makePolicy())).toBeNull();
  });

  it('preserves KNOWN zero and positive exposure behavior', () => {
    expect(evaluate({ exposureSnapshot: makeExposure() }).status).toBe('ACCEPTED');
    const positive = seal({ ...makeExposure(), globalOpenNotionalInr: '1' });
    expect(exposureHeadroom(positive, makeContext().candidate, makePolicy())?.globalInr).toBe('799999');
  });

  it('collects independent hard-cap failures alongside invalid evidence', () => {
    const invalid = seal({ ...makeExposure(), globalOpenNotionalInr: '-1', perPairOpenNotionalInr: { 'B-BTC_USDT': '400000' } });
    const codes = rejectionCodes(evaluate({ exposureSnapshot: invalid }));
    expect(codes).toEqual(expect.arrayContaining(['EXPOSURE_STATE_UNAVAILABLE', 'PAIR_EXPOSURE_LIMIT']));
  });

  it('never lets negative pending values increase headroom', () => {
    const invalid = changedExposure((pending, exposure) => ({ ...exposure, globalOpenNotionalInr: '800000', pending: { ...pending, globalPendingNotionalInr: '-100000' } }));
    expect(evaluate({ exposureSnapshot: invalid }).status).toBe('REJECTED');
    expect(exposureHeadroom(invalid, makeContext().candidate, makePolicy())).toBeNull();
  });

  it('retains independently provable limits when pending exposure is UNKNOWN', () => {
    const unknown = seal({
      ...makeExposure(), globalOpenNotionalInr: '800000', perPairOpenNotionalInr: { 'B-BTC_USDT': '400000' },
      perStrategyOpenNotionalInr: { 'EMA_TREND': '300000' }, concurrentOpenPositions: 10, pending: { status: 'UNKNOWN' as const },
    });
    expect(rejectionCodes(evaluate({ exposureSnapshot: unknown }))).toEqual(expect.arrayContaining([
      'PENDING_EXPOSURE_UNKNOWN', 'GLOBAL_EXPOSURE_LIMIT', 'PAIR_EXPOSURE_LIMIT',
      'STRATEGY_EXPOSURE_LIMIT', 'MAX_CONCURRENT_POSITIONS',
    ]));
  });
});

describe('P13-FINAL-005 conservative sizing precision', () => {
  function expectNumericContext(changes: Parameters<typeof makeContext>[0]): void {
    const result = evaluate(changes);
    expect(result.status).toBe('REJECTED');
    expect(rejectionCodes(result)).toContain('VALUATION_NUMERIC_CONTEXT_EXCEEDED');
  }

  it('rejects the hidden multiplier remainder reproduction', () => {
    expectNumericContext({ pairSnapshot: seal({ ...makePair(), contractMultiplier: `0.001${'0'.repeat(127)}1` }) });
  });

  it('rejects an extreme-precision stop distance', () => {
    const context = makeContext();
    if (context.entryStopProposal === null) throw new Error('fixture');
    expectNumericContext({ entryStopProposal: seal({ ...context.entryStopProposal, stopPriceUsdt: `90.${'1'.repeat(129)}` }) });
  });

  it('rejects an extreme-precision conversion rate', () => {
    const context = makeContext();
    if (context.settlementRateSnapshot === null) throw new Error('fixture');
    expectNumericContext({ settlementRateSnapshot: seal({ ...context.settlementRateSnapshot, rateInrPerUsdt: `80.${'1'.repeat(129)}` }) });
  });

  it('rejects a combined product exceeding the safe context', () => {
    const context = makeContext();
    if (context.settlementRateSnapshot === null) throw new Error('fixture');
    const multiplier = `0.${'1'.repeat(70)}`;
    const rate = `80.${'1'.repeat(70)}`;
    expectNumericContext({ pairSnapshot: seal({ ...makePair(), contractMultiplier: multiplier }), settlementRateSnapshot: seal({ ...context.settlementRateSnapshot, rateInrPerUsdt: rate }) });
  });

  it('accepts the exact normal risk-budget boundary', () => {
    const result = evaluate();
    expect(result.status === 'ACCEPTED' && result.action === 'OPEN' && result.approved.estimatedStopLossRiskInr).toBe('1000');
  });

  it('accepts one representable quantity unit below the boundary', () => {
    const result = evaluate({ pairSnapshot: seal({ ...makePair(), maxQuantity: '1249' }) });
    expect(result.status === 'ACCEPTED' && result.action === 'OPEN' && result.approved.estimatedStopLossRiskInr).toBe('999.2');
  });

  it('handles huge supported Decimal values deterministically', () => {
    const huge = '100000000000000000000000000000';
    const account = seal({ ...makeAccount(), currentEquityInr: huge, peakEquityInr: huge });
    const first = evaluate({ accountSnapshot: account });
    const second = evaluate({ accountSnapshot: account });
    expect(second).toEqual(first);
    expect(first.status).toBe('ACCEPTED');
  });

  it('leaves normal sizing unchanged', () => {
    const result = new RiskEngine(makePolicy()).evaluatePositionSizing(makeContext()).decision;
    expect(result.outcome).toBe('SIZED');
    expect(result.sizing?.finalQuantity).toBe('1250');
  });
});

describe('P13-FINAL-006 independent price validation and audit', () => {
  function invalidPriceContext(extra: Parameters<typeof makeContext>[0] = {}) {
    const context = makeContext(extra);
    if (context.entryStopProposal === null) throw new Error('fixture');
    return { ...context, entryStopProposal: seal({ ...context.entryStopProposal, entryPriceUsdt: '0' }) };
  }

  it('reports an invalid entry price alone at step 9', () => {
    const result = evaluate(invalidPriceContext());
    expect(rejectionCodes(result)).toContain('INVALID_ENTRY_PRICE');
    expect(result.auditTrail[8]).toMatchObject({ outcome: 'FAIL', reasonCodes: expect.arrayContaining(['INVALID_ENTRY_PRICE']) });
  });

  it('reports unknown pending exposure alone', () => {
    const exposure = seal({ ...makeExposure(), pending: { status: 'UNKNOWN' as const } });
    expect(rejectionCodes(evaluate({ exposureSnapshot: exposure }))).toContain('PENDING_EXPOSURE_UNKNOWN');
  });

  it('retains invalid price with unknown pending exposure', () => {
    const exposure = seal({ ...makeExposure(), pending: { status: 'UNKNOWN' as const } });
    const result = evaluate(invalidPriceContext({ exposureSnapshot: exposure }));
    expect(rejectionCodes(result)).toEqual(expect.arrayContaining(['INVALID_ENTRY_PRICE', 'PENDING_EXPOSURE_UNKNOWN']));
    expect(result.auditTrail[8]?.outcome).toBe('FAIL');
    expect(result.auditTrail[10]).toMatchObject({ outcome: 'SKIPPED', reasonCodes: [] });
  });

  it('retains invalid price with unavailable account state', () => {
    const result = evaluate(invalidPriceContext({ accountSnapshot: null }));
    expect(rejectionCodes(result)).toEqual(expect.arrayContaining(['INVALID_ENTRY_PRICE', 'ACCOUNT_STATE_UNAVAILABLE']));
  });

  it('orders multiple independent failures canonically', () => {
    const exposure = seal({ ...makeExposure(), pending: { status: 'UNKNOWN' as const } });
    const result = evaluate(invalidPriceContext({ accountSnapshot: null, exposureSnapshot: exposure }));
    expect(rejectionCodes(result)).toEqual(REJECTION_PRECEDENCE_V1.filter((code) => rejectionCodes(result).includes(code)));
  });

  it('does not run dependent sizing arithmetic with an invalid price', () => {
    const result = evaluate(invalidPriceContext({ pairSnapshot: seal({ ...makePair(), contractMultiplier: `0.001${'0'.repeat(127)}1` }) }));
    expect(rejectionCodes(result)).toContain('INVALID_ENTRY_PRICE');
    expect(result.auditTrail[10]?.outcome).toBe('SKIPPED');
  });
});

describe('P13-FINAL-007 public sizing lineage verification', () => {
  it('allows a genuine StrategyDecision identity', () => {
    expect(new RiskEngine(makePolicy()).evaluatePositionSizing(makeContext()).decision.outcome).toBe('SIZED');
  });

  it('rejects an altered valid-looking decisionId before sizing', () => {
    const context = makeContext();
    const tampered = { ...context.candidate.strategyDecision, decisionId: 'b'.repeat(64) };
    const decision = new RiskEngine(makePolicy()).evaluatePositionSizing({ ...context, candidate: { ...context.candidate, strategyDecision: tampered } }).decision;
    expect(decision.outcome).toBe('NOT_SIZED');
    expect(decision.sizingReasonCodes).toContain('DECISION_IDENTITY_MISMATCH');
  });

  it('throws for malformed decision identity before canonical identity exists', () => {
    const context = makeContext();
    const malformed = { ...context.candidate.strategyDecision, decisionId: 'bad' };
    expect(() => new RiskEngine(makePolicy()).evaluatePositionSizing({ ...context, candidate: { ...context.candidate, strategyDecision: malformed } })).toThrowError(RiskEngineError);
  });

  it('rejects changed target exposure without a recomputed decisionId', () => {
    const context = makeContext();
    const tampered = { ...context.candidate.strategyDecision, targetExposure: 'SHORT' as const };
    const decision = new RiskEngine(makePolicy()).evaluatePositionSizing({ ...context, candidate: { ...context.candidate, strategyDecision: tampered } }).decision;
    expect(decision.outcome).toBe('NOT_SIZED');
    expect(decision.sizingReasonCodes).toContain('DECISION_IDENTITY_MISMATCH');
  });

  it('makes evaluateRisk and evaluatePositionSizing agree on invalid lineage', () => {
    const context = makeContext();
    const tampered = { ...context.candidate.strategyDecision, decisionId: 'b'.repeat(64) };
    const candidate = { ...context.candidate, strategyDecision: tampered };
    const engine = new RiskEngine(makePolicy());
    expect(engine.evaluatePositionSizing({ ...context, candidate }).decision.sizingReasonCodes).toContain('DECISION_IDENTITY_MISMATCH');
    expect(rejectionCodes(engine.evaluateRisk({ ...context, candidate }))).toContain('DECISION_IDENTITY_MISMATCH');
  });

  it('rejects proposal lineage mismatch before public sizing', () => {
    const context = makeContext();
    if (context.entryStopProposal === null) throw new Error('fixture');
    const decision = new RiskEngine(makePolicy()).evaluatePositionSizing({
      ...context, entryStopProposal: seal({ ...context.entryStopProposal, sourceStrategyDecisionId: 'b'.repeat(64) }),
    }).decision;
    expect(decision.outcome).toBe('NOT_SIZED');
    expect(decision.sizingReasonCodes).toContain('DECISION_IDENTITY_MISMATCH');
  });

  it.each(['source', 'content', 'time'] as const)('rejects invalid %s provenance before public sizing', (kind) => {
    const context = makeContext();
    if (context.accountSnapshot === null) throw new Error('fixture');
    const provenance = kind === 'source'
      ? { ...context.accountSnapshot.provenance, sourceId: 'wrong-source' }
      : kind === 'content'
        ? { ...context.accountSnapshot.provenance, contentSha256: 'b'.repeat(64) }
        : { ...context.accountSnapshot.provenance, observedAtMs: EVALUATION_TIME + 1 };
    const decision = new RiskEngine(makePolicy()).evaluatePositionSizing({
      ...context, accountSnapshot: { ...context.accountSnapshot, provenance },
    }).decision;
    expect(decision.outcome).toBe('NOT_SIZED');
  });
});
