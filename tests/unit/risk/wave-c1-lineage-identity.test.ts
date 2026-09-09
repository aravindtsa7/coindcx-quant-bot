import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adaptCanonicalCandle1m } from '../../../src/indicators';
import { createCanonicalCandle1m } from '../../../src/market-data/models';
import { createStrategyIndicatorBindings, emaTrendV1Definition, multiTimeframeTrendV1Definition, StrategyReadonlyMap,
  BaseStrategyKernel, StrategyDecisionOrigin, type StrategyDecision, type StrategyTargetExposure } from '../../../src/strategies';
import { IndicatorDecimal } from '../../../src/indicators';
import { computeStrategyInstanceId, computeStrategyParameterHash } from '../../../src/strategies/core/identity';
import { RiskEngine, createStrategyRiskCandidate, type RiskDecision, type RiskDecisionAction, type RiskEvaluationContext,
  type StrategyRiskLineage } from '../../../src/risk';
import { makeContext, makePolicy, resealContext } from './helpers';

const BASE = 1_704_067_200_000;
type Mutable<T> = T extends StrategyDecisionOrigin ? T : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
function copy<T>(value: T): Mutable<T> {
  if (value instanceof StrategyDecisionOrigin) return value as Mutable<T>;
  if (Array.isArray(value)) return value.map(copy) as Mutable<T>;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copy(entry)])) as Mutable<T>;
  return value as Mutable<T>;
}

// Independent SHA implementation over the frozen public Phase 10 decision fields.
function decisionId(decision: StrategyDecision): string {
  const fields = { strategyInstanceId: decision.strategyInstanceId, decisionSequence: decision.decisionSequence,
    evaluationTimeMs: decision.evaluationTimeMs, triggerTimeframeMinutes: decision.triggerTimeframeMinutes,
    status: decision.status, targetExposure: decision.targetExposure, reasonCodes: decision.reasonCodes };
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(fields)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)))).digest('hex');
}

function genuine(pair = 'B-BTC_USDT', target: StrategyTargetExposure = 'LONG') {
  const kernel = emaTrendV1Definition.createKernel({ pair,
    parameters: { timeframeMinutes: 1, fastPeriod: 1, slowPeriod: 2, priceSource: 'CLOSE' },
    indicatorBootstrapIdentity: [{ timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE }] });
  const bindings = createStrategyIndicatorBindings(kernel);
  let decision: StrategyDecision | undefined;
  for (const [index, close] of ['100', target === 'LONG' ? '110' : target === 'SHORT' ? '90' : '100'].entries()) {
    const candle = createCanonicalCandle1m({ pair, openTimeMs: BASE + index * 60_000, open: '100', high: '110', low: '90',
      close, volume: '1', quoteVolume: null, source: 'REST_HISTORICAL', finalizedAtMs: BASE + (index + 1) * 60_000,
      providerEventTimeMs: null, generationId: null });
    const trigger = { pair, timeframeMinutes: 1, openTimeMs: candle.openTimeMs, closeTimeExclusiveMs: candle.closeTimeExclusiveMs,
      open: candle.open.value, high: candle.high.value, low: candle.low.value, close: candle.close.value, volume: '1', quoteVolume: null };
    const points = bindings.map((binding) => [binding.alias, binding.kernel.update(adaptCanonicalCandle1m(candle))] as const);
    decision = kernel.evaluate({ pair, evaluationTimeMs: trigger.closeTimeExclusiveMs, triggerClosedCandle: trigger,
      latestClosedCandleByTimeframe: new StrategyReadonlyMap([[1, trigger]]), candlesClosedAtThisTimestamp: [trigger],
      latestIndicatorPointByAlias: new StrategyReadonlyMap(points) });
  }
  if (decision === undefined) throw new Error('Genuine decision missing');
  expect(decision).toMatchObject({ status: 'READY', targetExposure: target });
  expect(decision.decisionId).toBe(decisionId(decision));
  const lineage: StrategyRiskLineage = { normalizedParameters: kernel.normalizedParameters, indicatorBootstrapIdentity: kernel.indicatorBootstrapIdentity };
  return { decision, lineage, kernel };
}

function context(action: RiskDecisionAction = 'OPEN', pair = 'B-BTC_USDT'): RiskEvaluationContext {
  const { decision, lineage, kernel } = genuine(pair, action === 'CLOSE' ? 'FLAT' : action === 'REVERSAL_DEFERRED' ? 'SHORT' : 'LONG');
  const candidate = createStrategyRiskCandidate(decision, 'instrument-1', lineage);
  if (candidate === null) throw new Error('Genuine READY candidate missing');
  const value = copy(makeContext());
  value.strategyOrigin = BaseStrategyKernel.issueDecisionOrigin(kernel, decision);
  value.candidate = copy(candidate); value.evaluationTimeMs = decision.evaluationTimeMs;
  value.pairSnapshot.pair = pair;
  if (value.pairSnapshot.ownership.status !== 'RECONCILED') throw new Error('Fixture ownership');
  value.pairSnapshot.ownership.pair = pair;
  value.leverageTierSnapshot!.pair = pair;
  value.entryStopProposal!.pair = pair;
  value.entryStopProposal!.sourceStrategyDecisionId = decision.decisionId;
  value.leverageProposal!.sourceStrategyDecisionId = decision.decisionId;
  for (const key of ['entryStopProposal', 'pairSnapshot', 'accountSnapshot', 'exposureSnapshot', 'leverageTierSnapshot', 'settlementRateSnapshot'] as const) {
    value[key]!.provenance.sourceTimeMs = decision.evaluationTimeMs;
    value[key]!.provenance.observedAtMs = decision.evaluationTimeMs;
  }
  if (action !== 'OPEN') {
    value.entryStopProposal = null; value.leverageProposal = null;
    value.pairSnapshot.position = { state: 'OPEN', positionId: 'p', positionDirection: 'LONG', quantityMagnitude: '10', valuation: {
      valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1', valuationPriceField: 'markPriceUsdt', valuationPriceUsdt: '100',
      valuationPriceSourceId: 'pair-source', valuationPriceSourceTimeMs: decision.evaluationTimeMs, valuationPriceObservedAtMs: decision.evaluationTimeMs,
      contractMultiplier: '0.001', conversionMarket: 'USDT_INR', conversionRateInrPerUsdt: '80', conversionSourceId: 'conversion-source',
      unitValuationInrPerQty: '8', aggregateCurrentNotionalInr: '80' } };
    value.pairSnapshot.ownership = { status: 'RECONCILED', positionState: 'OPEN', accountId: 'account-1', pair, positionId: 'p',
      instanceOwnership: [{ strategyInstanceId: decision.strategyInstanceId, strategyId: decision.strategyId, strategyVersion: decision.strategyVersion,
        parameterHash: decision.parameterHash, currentQuantity: '10', currentNotionalInr: '80' }] };
  }
  return resealContext(value);
}

function engine(pair = 'B-BTC_USDT') { return new RiskEngine(makePolicy({ pairConfig: { ...makePolicy().pairConfig, pair } })); }
function reasons(decision: RiskDecision) { return decision.status === 'REJECTED' ? [decision.primaryReasonCode, ...decision.secondaryReasonCodes] : decision.reasonCodes; }
function rehash(value: Mutable<RiskEvaluationContext>) {
  const decision = value.candidate.strategyDecision;
  decision.decisionId = decisionId(decision);
  if (value.entryStopProposal !== null) value.entryStopProposal.sourceStrategyDecisionId = decision.decisionId;
  if (value.leverageProposal !== null) value.leverageProposal.sourceStrategyDecisionId = decision.decisionId;
  return resealContext(value);
}
function reverseKeys(value: unknown): unknown {
  if (value instanceof StrategyDecisionOrigin) return value;
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseKeys(entry)]));
  return value;
}

describe('Wave C1 authoritative Phase 10 construction binding', () => {
  it.each(['B-BTC_USDT', 'B-ETH_USDT'])('preserves genuine %s identity and sizing', (pair) => {
    const value = context('OPEN', pair);
    const result = engine(pair).evaluateRisk(value);
    expect(result).toMatchObject({ status: 'ACCEPTED', action: 'OPEN', pair,
      approved: { approvedQuantity: '1250', approvedLeverage: '5', approvedNotionalInr: '10000', estimatedInitialMarginInr: '2000' } });
    expect(value.candidate.strategyDecision.strategyInstanceId).toBe(computeStrategyInstanceId({ ...value.candidate.strategyDecision,
      indicatorBootstrapIdentity: value.candidate.strategyLineage.indicatorBootstrapIdentity }));
    if (pair === 'B-BTC_USDT') {
      expect(value.candidate.strategyDecision.decisionId).toBe('513da50ea39bba65882538325433c10998bf371bfef83de14b67e352cf761833');
      expect(value.candidate.strategyDecision.strategyInstanceId).toBe('347e66d901ba0b758efc9bcd49b7ee4dbb737cf04ca732a19d6846a8b37c6e65');
    }
  });

  it.each(['parameterHash', 'strategyId', 'strategyVersion', 'pair', 'strategyInstanceId', 'decisionId', 'triggerTimeframeMinutes'] as const)(
    'rejects independently mutated %s, including a recomputed decision hash', (field) => {
    const value = copy(context()); const d = value.candidate.strategyDecision;
    switch (field) {
      case 'parameterHash': d.parameterHash = 'b'.repeat(64); break;
      case 'strategyId': d.strategyId = 'RSI_MOMENTUM'; break;
      case 'strategyVersion': d.strategyVersion = '999.0.0'; break;
      case 'pair': d.pair = 'B-ETH_USDT'; break;
      case 'strategyInstanceId': d.strategyInstanceId = 'b'.repeat(64); break;
      case 'decisionId': d.decisionId = 'b'.repeat(64); break;
      case 'triggerTimeframeMinutes': d.triggerTimeframeMinutes = 5; break;
    }
    const changed = field === 'decisionId' ? value : rehash(value);
    const instance = engine(); const first = instance.evaluateRisk(changed);
    expect(first).toMatchObject({ status: 'REJECTED', primaryReasonCode: 'DECISION_IDENTITY_MISMATCH' });
    expect(instance.evaluateRisk(changed)).toEqual(first);
    expect(instance.evaluatePositionSizing(changed).decision).toMatchObject({ outcome: 'NOT_SIZED', sizing: null });
  });

  it('rejects full ETH relabeling of a genuine BTC instance with a valid decision hash', () => {
    const value = copy(context()); value.candidate.strategyDecision.pair = 'B-ETH_USDT'; value.candidate.pair = 'B-ETH_USDT';
    value.pairSnapshot.pair = 'B-ETH_USDT'; value.leverageTierSnapshot!.pair = 'B-ETH_USDT'; value.entryStopProposal!.pair = 'B-ETH_USDT';
    if (value.pairSnapshot.ownership.status === 'RECONCILED') value.pairSnapshot.ownership.pair = 'B-ETH_USDT';
    expect(engine('B-ETH_USDT').evaluateRisk(rehash(value))).toMatchObject({ status: 'REJECTED', primaryReasonCode: 'DECISION_IDENTITY_MISMATCH' });
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])('rejects malformed trigger %s at source validation', (trigger) => {
    const value = copy(context()); value.candidate.strategyDecision.triggerTimeframeMinutes = trigger;
    expect(() => engine().evaluateRisk(value)).toThrowError(expect.objectContaining({ code: 'RISK_SOURCE_INVALID' }));
    expect(() => engine().evaluatePositionSizing(value)).toThrowError(expect.objectContaining({ code: 'RISK_SOURCE_INVALID' }));
  });
  it('rejects the original absurd safe-integer trigger with a valid hash', () => {
    const value = copy(context()); value.candidate.strategyDecision.triggerTimeframeMinutes = Number.MAX_SAFE_INTEGER;
    expect(engine().evaluateRisk(rehash(value))).toMatchObject({ status: 'REJECTED', primaryReasonCode: 'DECISION_IDENTITY_MISMATCH' });
  });
  it.each(['parameters', 'bootstrap-start', 'bootstrap-timeframe', 'duplicate-bootstrap', 'missing-bootstrap'] as const)(
    'rejects altered construction evidence: %s', (field) => {
    const value = copy(context()); const lineage = value.candidate.strategyLineage;
    if (field === 'parameters') lineage.normalizedParameters.slowPeriod = 3;
    if (field === 'bootstrap-start') lineage.indicatorBootstrapIdentity[0]!.bootstrapStartOpenTimeMs += 60_000;
    if (field === 'bootstrap-timeframe') lineage.indicatorBootstrapIdentity[0]!.timeframeMinutes = 5;
    if (field === 'duplicate-bootstrap') lineage.indicatorBootstrapIdentity.push({ ...lineage.indicatorBootstrapIdentity[0]! });
    if (field === 'missing-bootstrap') lineage.indicatorBootstrapIdentity = [];
    expect(engine().evaluateRisk(rehash(value))).toMatchObject({ status: 'REJECTED', primaryReasonCode: 'DECISION_IDENTITY_MISMATCH' });
  });
  it('fails closed when lineage is absent', () => {
    const value = context(); const { strategyLineage: _lineage, ...candidate } = value.candidate;
    expect(() => engine().evaluateRisk({ ...value, candidate } as RiskEvaluationContext)).toThrowError(expect.objectContaining({ code: 'RISK_SOURCE_INVALID' }));
  });
  it.each([NaN, Infinity, undefined, () => 1])('rejects non-canonical construction input %s with the risk source taxonomy', (invalid) => {
    const value = copy(context()); value.candidate.strategyLineage.normalizedParameters.slowPeriod = invalid;
    expect(() => engine().evaluateRisk(value)).toThrowError(expect.objectContaining({ code: 'RISK_SOURCE_INVALID' }));
  });
  it.each(['CLOSE', 'NO_CHANGE', 'REVERSAL_DEFERRED'] as const)('also verifies complete lineage for %s', (action) => {
    const value = copy(context(action)); value.candidate.strategyLineage.indicatorBootstrapIdentity[0]!.bootstrapStartOpenTimeMs += 60_000;
    expect(engine().evaluateRisk(rehash(value))).toMatchObject({ status: 'REJECTED', primaryReasonCode: 'DECISION_IDENTITY_MISMATCH' });
    expect(engine().evaluatePositionSizing(rehash(value)).decision.sizingReasonCodes).toContain('DECISION_IDENTITY_MISMATCH');
  });
  it('derives the MTF trigger from its construction and normalizes bootstrap ordering', () => {
    const kernel = multiTimeframeTrendV1Definition.createKernel({ pair: 'B-BTC_USDT',
      parameters: { timeframes: [5, 1], fastPeriod: 1, slowPeriod: 2, priceSource: 'CLOSE' },
      indicatorBootstrapIdentity: [{ timeframeMinutes: 5, bootstrapStartOpenTimeMs: BASE }, { timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE }] });
    const time = BASE + 600_000;
    const candles = [1, 5].map((timeframeMinutes) => ({ pair: kernel.pair, timeframeMinutes, openTimeMs: time - timeframeMinutes * 60_000,
      closeTimeExclusiveMs: time, open: '100', high: '110', low: '90', close: '110', volume: '1', quoteVolume: null }));
    const decision = kernel.evaluate({ pair: kernel.pair, evaluationTimeMs: time, triggerClosedCandle: candles[0]!,
      latestClosedCandleByTimeframe: new StrategyReadonlyMap(candles.map((candle) => [candle.timeframeMinutes, candle])), candlesClosedAtThisTimestamp: candles,
      latestIndicatorPointByAlias: new StrategyReadonlyMap(kernel.indicatorRequirements.map((requirement) => [requirement.alias,
        { pair: kernel.pair, timeframeMinutes: requirement.timeframeMinutes, openTimeMs: time - requirement.timeframeMinutes * 60_000,
          closeTimeExclusiveMs: time, value: new IndicatorDecimal(requirement.alias.includes('fast') ? '110' : '100') }])) });
    const value = copy(context()); value.candidate.strategyDecision = copy(decision); value.evaluationTimeMs = time;
    value.strategyOrigin = BaseStrategyKernel.issueDecisionOrigin(kernel, decision);
    for (const key of ['entryStopProposal', 'pairSnapshot', 'accountSnapshot', 'exposureSnapshot', 'leverageTierSnapshot', 'settlementRateSnapshot'] as const) {
      value[key]!.provenance.sourceTimeMs = time; value[key]!.provenance.observedAtMs = time;
    }
    value.candidate.strategyLineage = copy({ normalizedParameters: kernel.normalizedParameters, indicatorBootstrapIdentity: kernel.indicatorBootstrapIdentity });
    const first = engine().evaluateRisk(rehash(value)); expect(first.status).toBe('ACCEPTED');
    value.candidate.strategyLineage.indicatorBootstrapIdentity.reverse();
    expect(engine().evaluateRisk(rehash(value))).toEqual(first);
    value.candidate.strategyDecision.triggerTimeframeMinutes = 5;
    expect(engine().evaluateRisk(rehash(value))).toMatchObject({ status: 'REJECTED', primaryReasonCode: 'DECISION_IDENTITY_MISMATCH' });
  });
});

describe('Wave C1 event-time causality in both public engine entry points', () => {
  it.each([-1, 0, 1])('compares decisionTime - riskTime = %s without a wall clock', (delta) => {
    const value = copy(context()); value.evaluationTimeMs -= delta;
    for (const key of ['entryStopProposal', 'pairSnapshot', 'accountSnapshot', 'exposureSnapshot', 'leverageTierSnapshot', 'settlementRateSnapshot'] as const) {
      value[key]!.provenance.sourceTimeMs = value.evaluationTimeMs; value[key]!.provenance.observedAtMs = value.evaluationTimeMs;
    }
    const normalized = resealContext(value); const instance = engine(); const result = instance.evaluateRisk(normalized);
    if (delta <= 0) expect(result.status).toBe('ACCEPTED');
    else {
      expect(result).toMatchObject({ status: 'REJECTED', primaryReasonCode: 'EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION' });
      expect(instance.evaluatePositionSizing(normalized).decision).toMatchObject({ outcome: 'NOT_SIZED', sizing: null });
    }
  });
  it.each(['OPEN', 'CLOSE', 'NO_CHANGE', 'REVERSAL_DEFERRED'] as const)('rejects a genuine future %s decision, also on ETH', (action) => {
    const value = copy(context(action, 'B-ETH_USDT')); value.evaluationTimeMs -= 1;
    // Keep every non-strategy timestamp causal, isolating the decision timestamp.
    for (const key of ['entryStopProposal', 'pairSnapshot', 'accountSnapshot', 'exposureSnapshot', 'leverageTierSnapshot', 'settlementRateSnapshot'] as const) {
      if (value[key] !== null) { value[key].provenance.observedAtMs -= 1; value[key].provenance.sourceTimeMs = value.evaluationTimeMs; }
    }
    if (value.pairSnapshot.position.state === 'OPEN' && value.pairSnapshot.position.valuation !== null) {
      value.pairSnapshot.position.valuation.valuationPriceSourceTimeMs = value.evaluationTimeMs;
      value.pairSnapshot.position.valuation.valuationPriceObservedAtMs = value.evaluationTimeMs;
    }
    const normalized = resealContext(value); const instance = engine('B-ETH_USDT');
    expect(instance.evaluateRisk(normalized)).toMatchObject({ status: 'REJECTED', primaryReasonCode: 'EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION' });
    expect(instance.evaluatePositionSizing(normalized).decision.sizingReasonCodes).toContain('EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION');
  });
  it('keeps duplicate and older-after-newer evaluation stateless and deterministic', () => {
    const value = context(); const instance = engine(); const first = instance.evaluateRisk(value);
    const later = copy(value); later.evaluationTimeMs += 1;
    instance.evaluateRisk(later);
    expect(instance.evaluateRisk(value)).toEqual(first);
    expect(new RiskEngine(copy(instance.policy)).evaluateRisk(copy(value))).toEqual(first);
  });
});

const SNAPSHOTS = ['pairSnapshot', 'accountSnapshot', 'exposureSnapshot', 'leverageTierSnapshot', 'settlementRateSnapshot'] as const;
describe('Wave C1 final RiskDecision identity', () => {
  for (const action of ['OPEN', 'CLOSE', 'NO_CHANGE', 'REVERSAL_DEFERRED'] as const) {
    it.each(SNAPSHOTS)(`${action}: separates changed validation semantics for %s`, (key) => {
      const value = context(action); const instance = engine(); const valid = instance.evaluateRisk(value);
      const bad = copy(value); bad[key]!.provenance.contentSha256 = 'b'.repeat(64);
      const rejected = instance.evaluateRisk(bad);
      expect(rejected).toMatchObject({ status: 'REJECTED', primaryReasonCode: 'DECISION_IDENTITY_MISMATCH' });
      expect(rejected.inputContentHashes).toEqual(valid.inputContentHashes);
      expect(reasons(rejected)).not.toEqual(reasons(valid));
      expect(rejected.riskDecisionId).not.toBe(valid.riskDecisionId);
      expect(instance.evaluateRisk(reverseKeys(bad) as RiskEvaluationContext)).toEqual(rejected);
      expect(instance.evaluateRisk(copy(value))).toEqual(valid);
    });
  }
  it('identifies equivalent hash-invalid CLOSE semantics identically across snapshot classes', () => {
    const value = context('CLOSE'); const valid = engine().evaluateRisk(value);
    const invalidIds = SNAPSHOTS.map((key) => { const bad = copy(value); bad[key]!.provenance.contentSha256 = 'b'.repeat(64); return engine().evaluateRisk(bad).riskDecisionId; });
    expect(new Set(invalidIds).size).toBe(1);
    expect(invalidIds[0]).not.toBe(valid.riskDecisionId);
    console.log('C1 CLOSE identity evidence', JSON.stringify({ valid: valid.riskDecisionId, ...Object.fromEntries(SNAPSHOTS.map((key, index) => [key, invalidIds[index]])) }));
  });
  it('binds both changed primary reason and changed canonical secondary reason set', () => {
    const value = copy(context('CLOSE')); value.accountSnapshot!.provenance.sourceId = 'wrong-source';
    const source = resealContext(value); const first = engine().evaluateRisk(source);
    expect(first).toMatchObject({ primaryReasonCode: 'SOURCE_ID_MISMATCH' });
    const bad = copy(source); bad.accountSnapshot!.provenance.contentSha256 = 'b'.repeat(64);
    const second = engine().evaluateRisk(bad);
    expect(second).toMatchObject({ primaryReasonCode: 'DECISION_IDENTITY_MISMATCH', secondaryReasonCodes: ['SOURCE_ID_MISMATCH'] });
    expect(second.inputContentHashes).toEqual(first.inputContentHashes);
    expect(second.riskDecisionId).not.toBe(first.riskDecisionId);
    const unavailable = copy(context('CLOSE')); unavailable.accountSnapshot!.accountStateKnown = false;
    const sealed = resealContext(unavailable); const third = engine().evaluateRisk(sealed);
    const hashBad = copy(sealed); hashBad.accountSnapshot!.provenance.contentSha256 = 'b'.repeat(64);
    const fourth = engine().evaluateRisk(hashBad);
    expect(fourth).toMatchObject({ primaryReasonCode: 'DECISION_IDENTITY_MISMATCH', secondaryReasonCodes: ['ACCOUNT_STATE_UNAVAILABLE'] });
    expect(fourth.riskDecisionId).not.toBe(third.riskDecisionId);
    expect(fourth.riskDecisionId).not.toBe(second.riskDecisionId);
  });
});

describe('Wave C1 bounded immutability and numeric regressions', () => {
  it('copies the original decision and nested construction inputs before later mutation', () => {
    const value = context(); const decision = copy(value.candidate.strategyDecision); const lineage = copy(value.candidate.strategyLineage);
    const candidate = createStrategyRiskCandidate(decision, 'instrument-1', lineage)!;
    decision.parameterHash = 'b'.repeat(64); decision.reasonCodes.push('MUTATED'); lineage.normalizedParameters.slowPeriod = 999;
    lineage.indicatorBootstrapIdentity[0]!.bootstrapStartOpenTimeMs += 60_000;
    expect(engine().evaluateRisk({ ...value, candidate })).toEqual(engine().evaluateRisk(value));
    expect(Object.isFrozen(candidate.strategyLineage.normalizedParameters)).toBe(true);
    expect(Object.isFrozen(candidate.strategyLineage.indicatorBootstrapIdentity[0])).toBe(true);
  });
  it('rejects a caller-reconstructed parameter/instance binding despite refreshed public IDs', () => {
    const value = copy(context()); value.candidate.strategyLineage.normalizedParameters.slowPeriod = 3;
    const decision = value.candidate.strategyDecision; decision.parameterHash = computeStrategyParameterHash(value.candidate.strategyLineage.normalizedParameters);
    decision.strategyInstanceId = computeStrategyInstanceId({ ...decision, indicatorBootstrapIdentity: value.candidate.strategyLineage.indicatorBootstrapIdentity });
    const changed = engine().evaluateRisk(rehash(value)); expect(changed).toMatchObject({ status: 'REJECTED', primaryReasonCode: 'DECISION_IDENTITY_MISMATCH' });
    expect(changed.riskDecisionId).not.toBe(engine().evaluateRisk(context()).riskDecisionId);
  });
  it.each(['1.599999999999999999', '1.6', '1.600000000000000001'])('preserves the exact margin boundary at %s', (margin) => {
    const value = copy(context()); value.pairSnapshot.minNotional = '0.1'; value.accountSnapshot!.availableMarginInr = margin;
    const result = engine().evaluateRisk(resealContext(value));
    if (margin === '1.599999999999999999') expect(result).toMatchObject({ status: 'REJECTED', primaryReasonCode: 'INSUFFICIENT_MARGIN' });
    else expect(result).toMatchObject({ status: 'ACCEPTED', approved: { approvedQuantity: '1', estimatedInitialMarginInr: '1.6' } });
  });
  it.each(['NaN', 'Infinity', '-Infinity'])('rejects non-finite account input %s', (amount) => {
    const value = copy(context()); value.accountSnapshot!.availableMarginInr = amount;
    expect(() => engine().evaluateRisk(value)).toThrowError(expect.objectContaining({ code: 'RISK_SOURCE_INVALID' }));
  });
  it('reconstructs identical accepted/rejected decisions across host timezones', () => {
    const original = process.env.TZ;
    try {
      const value = context('CLOSE'); const bad = copy(value); bad.pairSnapshot.provenance.contentSha256 = 'b'.repeat(64);
      process.env.TZ = 'UTC'; const utc = [engine().evaluateRisk(value), engine().evaluateRisk(bad)];
      process.env.TZ = 'America/Los_Angeles';
      expect([engine().evaluateRisk(copy(value)), engine().evaluateRisk(copy(bad))]).toEqual(utc);
    } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
  });
});
