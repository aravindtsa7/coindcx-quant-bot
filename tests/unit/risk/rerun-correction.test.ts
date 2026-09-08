import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import * as api from '../../../src/risk';
import * as numeric from '../../../src/risk/decimal';
import { orderReasonCodes } from '../../../src/risk/reason-codes';
import type { DailyPnlComponents, InstancePendingReservation, RiskEvaluationContext, RiskDecision, RiskDecisionAction } from '../../../src/risk';
import { EVALUATION_TIME, makeContext, makeDecision, makePolicy, resealContext } from './helpers';

const engine = () => new api.RiskEngine(makePolicy());
const reasons = (result: RiskDecision): readonly string[] => result.status === 'REJECTED' ? [result.primaryReasonCode, ...result.secondaryReasonCodes] : [];
const evaluate = (context: RiskEvaluationContext) => engine().evaluateRisk(resealContext(context));
const huge = '1' + '0'.repeat(140);

function pnlContext(residual: string, reported = residual): RiskEvaluationContext {
  const context = makeContext();
  if (context.accountSnapshot === null) throw new Error('fixture');
  return { ...context, accountSnapshot: { ...context.accountSnapshot, dailyPnl: {
    realizedTradingPnlInr: huge, feesInr: huge, fundingPnlInr: residual,
    otherAccountAdjustmentsInr: '0', netDailyPnlInr: reported,
  } } };
}

function reservationContext(): RiskEvaluationContext {
  const context = makeContext();
  const decision = context.candidate.strategyDecision;
  if (context.exposureSnapshot === null || context.exposureSnapshot.pending.status !== 'KNOWN') throw new Error('fixture');
  const reservation: InstancePendingReservation = {
    strategyInstanceId: decision.strategyInstanceId, strategyId: decision.strategyId,
    strategyVersion: decision.strategyVersion, parameterHash: decision.parameterHash,
    pendingNotionalInr: '8', pendingReservationCount: 1,
  };
  return { ...context, exposureSnapshot: { ...context.exposureSnapshot, pending: {
    ...context.exposureSnapshot.pending, globalPendingNotionalInr: '8', pairPendingNotionalInr: { [decision.pair]: '8' },
    strategyPendingNotionalInr: { [decision.strategyId]: '8' }, pendingReservationCount: 1,
    pendingDirectionalNotionalInr: { longInr: '8', shortInr: '0' }, instancePendingReservations: [reservation],
  } } };
}

function actionContext(action: RiskDecisionAction): RiskEvaluationContext {
  if (action === 'OPEN') return makeContext();
  const context = makeContext();
  const decision = makeDecision(action === 'CLOSE' ? 'FLAT' : action === 'REVERSAL_DEFERRED' ? 'SHORT' : 'LONG');
  return { ...context, candidate: { ...context.candidate, strategyDecision: decision }, entryStopProposal: null, leverageProposal: null,
    pairSnapshot: { ...context.pairSnapshot,
      position: { state: 'OPEN', positionId: 'p', positionDirection: 'LONG', quantityMagnitude: '10', valuation: {
        valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1', valuationPriceField: 'markPriceUsdt', valuationPriceUsdt: '100',
        valuationPriceSourceId: 'pair-source', valuationPriceSourceTimeMs: EVALUATION_TIME, valuationPriceObservedAtMs: EVALUATION_TIME,
        contractMultiplier: '0.001', conversionMarket: 'USDT_INR', conversionRateInrPerUsdt: '80', conversionSourceId: 'conversion-source',
        unitValuationInrPerQty: '8', aggregateCurrentNotionalInr: '80',
      } },
      ownership: { status: 'RECONCILED', positionState: 'OPEN', accountId: 'account-1', pair: decision.pair, positionId: 'p',
        instanceOwnership: [{ strategyInstanceId: decision.strategyInstanceId, strategyId: decision.strategyId,
          strategyVersion: decision.strategyVersion, parameterHash: decision.parameterHash, currentQuantity: '10', currentNotionalInr: '80' }] },
    } };
}

describe('P13-RERUN-001 private numeric context', () => {
  it('exports no raw Decimal constructor from either boundary', () => {
    for (const boundary of [api, numeric]) {
      expect(boundary).not.toHaveProperty('RiskCalcDecimal');
      for (const value of Object.values(boundary)) {
        if (typeof value === 'function') for (const name of ['set', 'config', 'clone', 'precision']) expect(value).not.toHaveProperty(name);
      }
    }
  });
  it.each(['set', 'config', 'clone', 'precision'])('cannot install a %s configuration alias on returned values or their constructor', (name) => {
    const value = api.riskDecimal('1');
    expect(() => Object.defineProperty(value, name, { value: 3 })).toThrow(TypeError);
    expect(() => Object.defineProperty(value.constructor, name, { value: 3 })).toThrow(TypeError);
    expect(() => Object.defineProperty(Object.getPrototypeOf(value), name, { value: 3 })).toThrow(TypeError);
  });
  it('preserves existing/future engines and byte-equivalent decisions after external Decimal mutation', () => {
    const instance = engine(); const context = resealContext(pnlContext('-39999'));
    const before = instance.evaluateRisk(context);
    const saved = { precision: Decimal.precision, rounding: Decimal.rounding };
    try {
      Decimal.set({ precision: 3, rounding: Decimal.ROUND_DOWN });
      for (const after of [instance.evaluateRisk(context), engine().evaluateRisk(context)]) {
        expect(after.status).toBe('ACCEPTED');
        expect(after.riskDecisionId).toBe(before.riskDecisionId);
        expect(JSON.stringify(after)).toBe(JSON.stringify(before));
      }
    } finally { Decimal.set(saved); }
  });
  it('keeps 128 significant digits in division without exposing internal storage', () => {
    const third = api.riskDecimal('1').div('3');
    expect(third.toFixed()).toBe('0.' + '3'.repeat(128));
    expect(Object.keys(third)).toEqual([]);
    expect(Object.isFrozen(third)).toBe(true);
  });
});

describe('P13-RERUN-002 exact cancellation and related numeric limits', () => {
  it('rejects the exact Astra reported-zero reproduction at the hard boundary', () => {
    expect(reasons(evaluate(pnlContext('-40000', '0')))).toEqual(['ACCOUNT_STATE_UNAVAILABLE', 'DAILY_LOSS_LIMIT']);
  });
  it.each(['-39999', '-40000', '-40001', huge, '-' + huge])('computes cancellation residual %s exactly', (residual) => {
    const result = evaluate(pnlContext(residual));
    expect(reasons(result)).not.toContain('ACCOUNT_STATE_UNAVAILABLE');
    expect(result.status).toBe(api.riskDecimal(residual).lte('-40000') ? 'REJECTED' : 'ACCEPTED');
    if (result.status === 'REJECTED') expect(reasons(result)).toContain('DAILY_LOSS_LIMIT');
  });
  it.each([
    [huge, '-' + huge, '-40000'], [huge, '-40000', '-' + huge],
    ['-' + huge, huge, '-40000'], ['-' + huge, '-40000', huge],
    ['-40000', huge, '-' + huge], ['-40000', '-' + huge, huge],
  ])('keeps exact accumulation independent of operand order %j', (a, b, c) => {
    expect(api.riskDecimal(a).plus(b).plus(c).toFixed()).toBe('-40000');
  });
  it('keeps all component insertion orders byte-equivalent', () => {
    const context = pnlContext('-40000');
    if (context.accountSnapshot === null) throw new Error('fixture');
    const expected = evaluate(context);
    const entries = Object.entries(context.accountSnapshot.dailyPnl);
    const reversed = Object.fromEntries(entries.reverse()) as unknown as DailyPnlComponents;
    expect(evaluate({ ...context, accountSnapshot: { ...context.accountSnapshot, dailyPnl: reversed } })).toEqual(expected);
  });
  it('reconciles mixed funding, fees and adjustment signs exactly', () => {
    const context = pnlContext('0');
    if (context.accountSnapshot === null) throw new Error('fixture');
    const dailyPnl = { realizedTradingPnlInr: '200', feesInr: '300', fundingPnlInr: '400', otherAccountAdjustmentsInr: '-40300', netDailyPnlInr: '-40000' };
    expect(reasons(evaluate({ ...context, accountSnapshot: { ...context.accountSnapshot, dailyPnl } }))).toEqual(['DAILY_LOSS_LIMIT']);
  });
  it('fails closed when a percentage-gate cross product exceeds supported context', () => {
    const policy = makePolicy();
    const instance = new api.RiskEngine(makePolicy({ modeConfig: { ...policy.modeConfig, dailyLossLimitPercent: '0.' + '1'.repeat(129) } }));
    const result = instance.evaluateRisk(resealContext(pnlContext('-1')));
    expect(reasons(result)).toContain('VALUATION_NUMERIC_CONTEXT_EXCEEDED');
  });
  it('does not lose a tiny positive exposure allocation at an exact cap', () => {
    const context = makeContext();
    if (context.exposureSnapshot === null || context.exposureSnapshot.pending.status !== 'KNOWN') throw new Error('fixture');
    const tiny = '0.' + '0'.repeat(140) + '1';
    expect(api.riskDecimal('800000').minus(tiny).minus('800000').toFixed()).toBe('-' + tiny);
    expect(reasons(evaluate({ ...context, exposureSnapshot: { ...context.exposureSnapshot, globalOpenNotionalInr: '800000',
      pending: { ...context.exposureSnapshot.pending, globalPendingNotionalInr: tiny } } }))).toContain('GLOBAL_EXPOSURE_LIMIT');
  });
  it('floors a near-integer rational quotient without rounding across a quantity tick', () => {
    const tiny = '0.' + '0'.repeat(140) + '1';
    const below = api.riskDecimal('1').minus(tiny);
    expect(numeric.floorRatioToIncrement(below, api.riskDecimal('1'), api.riskDecimal('1')).toFixed()).toBe('0');
  });
  it('compares a near-boundary drawdown by exact cross products, not rounded ratios', () => {
    const context = makeContext();
    if (context.accountSnapshot === null) throw new Error('fixture');
    const result = evaluate({ ...context, accountSnapshot: { ...context.accountSnapshot, currentEquityInr: '60000' } });
    expect(reasons(result)).toContain('DRAWDOWN_LIMIT');
  });
  it('never drops a small ownership allocation when summing huge allocations', () => {
    const context = actionContext('CLOSE'); const pair = context.pairSnapshot;
    if (pair.position.state !== 'OPEN' || pair.position.valuation === null || pair.ownership.status !== 'RECONCILED' || pair.ownership.positionState !== 'OPEN') throw new Error('fixture');
    const original = pair.ownership.instanceOwnership[0]; if (original === undefined) throw new Error('fixture');
    const aggregate = api.riskDecimal(huge).mul('8').toFixed();
    const result = evaluate({ ...context, pairSnapshot: { ...pair,
      position: { ...pair.position, quantityMagnitude: huge, valuation: { ...pair.position.valuation, aggregateCurrentNotionalInr: aggregate } },
      ownership: { ...pair.ownership, instanceOwnership: [
        { ...original, currentQuantity: huge, currentNotionalInr: aggregate },
        { ...original, strategyInstanceId: 'instance-2', currentQuantity: '1', currentNotionalInr: '8' },
      ] },
    } });
    expect(reasons(result)).toContain('POSITION_OWNERSHIP_UNRECONCILED');
  });
  it('fails closed on unsupported CLOSE quote-notional precision despite rounded INR valuation fitting', () => {
    const context = actionContext('CLOSE'); const pair = context.pairSnapshot;
    if (pair.position.state !== 'OPEN' || pair.position.valuation === null || pair.ownership.status !== 'RECONCILED' || pair.ownership.positionState !== 'OPEN') throw new Error('fixture');
    const original = pair.ownership.instanceOwnership[0]; if (original === undefined) throw new Error('fixture');
    const quantity = '123456789012345678901234567890'; const price = '100.' + '1'.repeat(100);
    const unit = numeric.checkedProduct(api.riskDecimal(price), api.riskDecimal('0.001'), api.riskDecimal('80')).toDecimalPlaces(8).toFixed();
    const aggregate = numeric.checkedProduct(api.riskDecimal(quantity), api.riskDecimal(unit)).toFixed();
    const result = evaluate({ ...context, pairSnapshot: { ...pair,
      position: { ...pair.position, quantityMagnitude: quantity, valuation: { ...pair.position.valuation,
        valuationPriceUsdt: price, unitValuationInrPerQty: unit, aggregateCurrentNotionalInr: aggregate } },
      ownership: { ...pair.ownership, instanceOwnership: [{ ...original, currentQuantity: quantity, currentNotionalInr: aggregate }] },
    } });
    expect(reasons(result)).toContain('VALUATION_NUMERIC_CONTEXT_EXCEEDED');
  });
  it('rounds recurring initial margin conservatively without changing the calculation context', () => {
    const third = api.riskDecimal('1').divUp('3');
    expect(third.toFixed()).toBe('0.' + '3'.repeat(127) + '4');
    expect(api.riskDecimal('1').div('3').toFixed()).toBe('0.' + '3'.repeat(128));
  });
});

describe('P13-RERUN-003 reservation lineage before public sizing', () => {
  it('sizes a correct full reservation tuple', () => {
    expect(engine().evaluatePositionSizing(resealContext(reservationContext())).decision.outcome).toBe('SIZED');
  });
  it.each(['strategyId', 'strategyVersion', 'parameterHash'] as const)('rejects %s disagreement in both boundaries', (field) => {
    const context = reservationContext();
    const changed = { ...context, candidate: { ...context.candidate, strategyDecision: { ...context.candidate.strategyDecision,
      [field]: field === 'parameterHash' ? 'b'.repeat(64) : 'different',
    } } };
    const instance = engine(); const normalized = resealContext(changed);
    expect(reasons(instance.evaluateRisk(normalized))).toContain('DECISION_IDENTITY_MISMATCH');
    const sized = instance.evaluatePositionSizing(normalized).decision;
    expect(sized.outcome).toBe('NOT_SIZED');
    expect(sized.sizingReasonCodes).toContain('DECISION_IDENTITY_MISMATCH');
    expect(sized.auditTrail.find((step) => step.step === 10)).toMatchObject({ outcome: 'FAIL', reasonCodes: ['DECISION_IDENTITY_MISMATCH'] });
  });
  it.each([false, true])('isolates unrelated instances and is reservation-order independent (reverse=%s)', (reverse) => {
    const context = reservationContext();
    if (context.exposureSnapshot === null || context.exposureSnapshot.pending.status !== 'KNOWN') throw new Error('fixture');
    const original = context.exposureSnapshot.pending.instancePendingReservations[0];
    if (original === undefined) throw new Error('fixture');
    const records = [original, { ...original, strategyInstanceId: 'instance-2', parameterHash: 'b'.repeat(64) }];
    if (reverse) records.reverse();
    const normalized = resealContext({ ...context, exposureSnapshot: { ...context.exposureSnapshot, pending: {
      ...context.exposureSnapshot.pending, instancePendingReservations: records,
    } } });
    expect(engine().evaluatePositionSizing(normalized).decision.outcome).toBe('SIZED');
    expect(engine().evaluateRisk(normalized).status).toBe('ACCEPTED');
  });
  it.each([false, true])('fails closed on duplicate reservation instances (reverse=%s)', (reverse) => {
    const context = reservationContext();
    if (context.exposureSnapshot === null || context.exposureSnapshot.pending.status !== 'KNOWN') throw new Error('fixture');
    const original = context.exposureSnapshot.pending.instancePendingReservations[0];
    if (original === undefined) throw new Error('fixture');
    const records = [original, { ...original, pendingNotionalInr: '9' }];
    if (reverse) records.reverse();
    const normalized = resealContext({ ...context, exposureSnapshot: { ...context.exposureSnapshot, pending: {
      ...context.exposureSnapshot.pending, instancePendingReservations: records,
    } } });
    expect(engine().evaluatePositionSizing(normalized).decision.sizingReasonCodes).toContain('EXPOSURE_STATE_UNAVAILABLE');
    expect(reasons(engine().evaluateRisk(normalized))).toContain('EXPOSURE_STATE_UNAVAILABLE');
  });
});

describe('P13-RERUN-004 independent price and numeric-context validation', () => {
  it.each(['zero', 'numeric', 'combined', 'pending', 'account'] as const)('retains independent reasons and truthful audit for %s', (mode) => {
    const context = makeContext();
    if (context.entryStopProposal === null || context.exposureSnapshot === null || context.accountSnapshot === null) throw new Error('fixture');
    const result = evaluate({ ...context, entryStopProposal: { ...context.entryStopProposal,
      entryPriceUsdt: mode === 'numeric' ? '100' : '0',
      stopPriceUsdt: mode === 'numeric' || mode === 'combined' ? '90.' + '1'.repeat(129) : '90',
    }, exposureSnapshot: mode === 'pending' ? { ...context.exposureSnapshot, pending: { status: 'UNKNOWN' } } : context.exposureSnapshot,
    accountSnapshot: mode === 'account' ? { ...context.accountSnapshot, accountStateKnown: false } : context.accountSnapshot });
    const codes = reasons(result);
    expect(codes).toEqual(orderReasonCodes(codes as api.RiskRejectionCode[]));
    if (mode !== 'numeric') {
      expect(codes).toContain('INVALID_ENTRY_PRICE');
      expect(result.auditTrail.find((step) => step.step === 9)).toMatchObject({ outcome: 'FAIL' });
    }
    if (mode === 'numeric' || mode === 'combined') {
      expect(codes).toContain('VALUATION_NUMERIC_CONTEXT_EXCEEDED');
      expect(result.auditTrail.find((step) => step.step === 11)).toMatchObject({ outcome: 'FAIL' });
    }
    if (mode === 'pending') expect(codes).toContain('PENDING_EXPOSURE_UNKNOWN');
    if (mode === 'account') expect(codes).toContain('ACCOUNT_STATE_UNAVAILABLE');
    for (const step of result.auditTrail) if (step.outcome === 'SKIPPED') expect(step.reasonCodes).toEqual([]);
  });
  it.each(['abc', 'NaN'])('retains malformed ingestion failure for %s rather than treating it as zero', (price) => {
    const context = makeContext();
    if (context.entryStopProposal === null) throw new Error('fixture');
    const proposal = { ...context.entryStopProposal, entryPriceUsdt: price };
    expect(() => evaluate({ ...context, entryStopProposal: proposal })).toThrow(/RISK_SOURCE_INVALID/);
  });
});

describe('P13-RERUN-005 public sizing audit step ownership', () => {
  it.each(['OPEN', 'CLOSE', 'REVERSAL_DEFERRED', 'NO_CHANGE'] as const)('records valid %s applicability', (action) => {
    const decision = engine().evaluatePositionSizing(resealContext(actionContext(action))).decision;
    expect(decision.outcome).toBe(action === 'OPEN' ? 'SIZED' : 'NOT_APPLICABLE');
    expect(decision.auditTrail.find((step) => step.step === 3)).toMatchObject({ outcome: 'PASS' });
    expect(decision.auditTrail.find((step) => step.step === 11)).toMatchObject({ outcome: action === 'OPEN' ? 'PASS' : 'SKIPPED', reasonCodes: [] });
    for (const step of decision.auditTrail) if (step.outcome === 'SKIPPED') expect(step.reasonCodes).toEqual([]);
  });
  it.each(['OPEN', 'CLOSE', 'REVERSAL_DEFERRED', 'NO_CHANGE'] as const)('records invalid %s lineage at step 3, never on skipped sizing', (action) => {
    const context = actionContext(action);
    const decision = engine().evaluatePositionSizing(resealContext({ ...context, candidate: { ...context.candidate,
      strategyDecision: { ...context.candidate.strategyDecision, decisionId: 'b'.repeat(64) },
    } })).decision;
    expect(decision.outcome).toBe(action === 'OPEN' ? 'NOT_SIZED' : 'NOT_APPLICABLE');
    expect(decision.auditTrail.find((step) => step.step === 3)).toMatchObject({ outcome: 'FAIL', reasonCodes: ['DECISION_IDENTITY_MISMATCH'] });
    expect(decision.auditTrail.find((step) => step.step === 11)).toMatchObject({ outcome: 'SKIPPED', reasonCodes: [] });
    for (const step of decision.auditTrail) if (step.outcome === 'SKIPPED') expect(step.reasonCodes).toEqual([]);
  });
});
