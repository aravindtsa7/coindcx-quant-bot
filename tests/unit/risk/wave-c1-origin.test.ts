import { describe, expect, it } from 'vitest';
import { adaptCanonicalCandle1m } from '../../../src/indicators';
import { createCanonicalCandle1m } from '../../../src/market-data/models';
import { BaseStrategyKernel, StrategyDecisionOrigin, StrategyRegistry, StrategyReadonlyMap, PHASE10_STRATEGY_DEFINITIONS,
  createStrategyIndicatorBindings, computeStrategyInstanceId, computeStrategyParameterHash,
  type StrategyDecision, type StrategyKernel } from '../../../src/strategies';
import { RiskEngine, createStrategyRiskHandoff, recomputeStrategyDecisionId, evidenceContentSha256,
  type RiskEvaluationContext } from '../../../src/risk';
import { makeContext, makePolicy, resealContext } from './helpers';

const BASE = 1_704_067_200_000;
type Mutable<T> = T extends StrategyDecisionOrigin ? T : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
function copy<T>(value: T): Mutable<T> {
  if (value instanceof StrategyDecisionOrigin) return value as Mutable<T>;
  if (Array.isArray(value)) return value.map(copy) as Mutable<T>;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copy(entry)])) as Mutable<T>;
  return value as Mutable<T>;
}

function genuine(pair = 'B-BTC_USDT', slowPeriod = 2, strategyId = 'EMA_TREND', bootstrapStart = BASE) {
  const registry = new StrategyRegistry();
  PHASE10_STRATEGY_DEFINITIONS.forEach((definition) => registry.register(definition));
  const input = { pair, strategyId, strategyVersion: '1.0.0',
    parameters: strategyId === 'EMA_TREND'
      ? { timeframeMinutes: 1, fastPeriod: 1, slowPeriod, priceSource: 'CLOSE' }
      : { timeframeMinutes: 1, period: 1, longThreshold: '70', shortThreshold: '30', priceSource: 'CLOSE' },
    indicatorBootstrapIdentity: [{ timeframeMinutes: 1, bootstrapStartOpenTimeMs: bootstrapStart }] };
  const kernel = registry.create(input);
  const bindings = createStrategyIndicatorBindings(kernel);
  let decision: StrategyDecision | undefined;
  for (const [index, close] of ['100', '110', '120'].entries()) {
    const candle = createCanonicalCandle1m({ pair, openTimeMs: bootstrapStart + index * 60_000, open: '100', high: '120', low: '90',
      close, volume: '1', quoteVolume: null, source: 'REST_HISTORICAL', finalizedAtMs: bootstrapStart + (index + 1) * 60_000,
      providerEventTimeMs: null, generationId: null });
    const trigger = { pair, timeframeMinutes: 1, openTimeMs: candle.openTimeMs, closeTimeExclusiveMs: candle.closeTimeExclusiveMs,
      open: '100', high: '120', low: '90', close, volume: '1', quoteVolume: null };
    decision = kernel.evaluate({ pair, evaluationTimeMs: trigger.closeTimeExclusiveMs, triggerClosedCandle: trigger,
      latestClosedCandleByTimeframe: new StrategyReadonlyMap([[1, trigger]]), candlesClosedAtThisTimestamp: [trigger],
      latestIndicatorPointByAlias: new StrategyReadonlyMap(bindings.map((binding) => [binding.alias, binding.kernel.update(adaptCanonicalCandle1m(candle))])) });
  }
  if (decision === undefined) throw new Error('Missing decision');
  expect(decision).toMatchObject({ status: 'READY', targetExposure: 'LONG' });
  const handoff = createStrategyRiskHandoff(kernel, decision, 'instrument-1');
  if (handoff === null) throw new Error('Missing handoff');
  return { input, kernel, decision, handoff };
}

function context(source: ReturnType<typeof genuine>): RiskEvaluationContext {
  const value = copy(makeContext());
  value.candidate = copy(source.handoff.candidate); value.strategyOrigin = source.handoff.strategyOrigin;
  value.evaluationTimeMs = source.decision.evaluationTimeMs;
  for (const key of ['entryStopProposal', 'pairSnapshot', 'accountSnapshot', 'exposureSnapshot', 'leverageTierSnapshot', 'settlementRateSnapshot'] as const) {
    value[key]!.provenance.sourceTimeMs = value.evaluationTimeMs; value[key]!.provenance.observedAtMs = value.evaluationTimeMs;
  }
  return refresh(value);
}

// Refresh ALL public lineage and snapshot hashes, including dependent proposal references.
function refresh(value: Mutable<RiskEvaluationContext>): RiskEvaluationContext {
  const d = value.candidate.strategyDecision;
  d.parameterHash = computeStrategyParameterHash(value.candidate.strategyLineage.normalizedParameters);
  d.strategyInstanceId = computeStrategyInstanceId({ ...d, indicatorBootstrapIdentity: value.candidate.strategyLineage.indicatorBootstrapIdentity });
  d.decisionId = recomputeStrategyDecisionId(d);
  value.candidate.pair = d.pair; value.pairSnapshot.pair = d.pair;
  if (value.pairSnapshot.ownership.status === 'RECONCILED') value.pairSnapshot.ownership.pair = d.pair;
  value.leverageTierSnapshot!.pair = d.pair; value.entryStopProposal!.pair = d.pair;
  value.entryStopProposal!.sourceStrategyDecisionId = d.decisionId; value.leverageProposal!.sourceStrategyDecisionId = d.decisionId;
  const sealed = resealContext(value);
  for (const key of ['entryStopProposal', 'pairSnapshot', 'accountSnapshot', 'exposureSnapshot', 'leverageTierSnapshot', 'settlementRateSnapshot'] as const) {
    expect(sealed[key]!.provenance.contentSha256).toBe(evidenceContentSha256(sealed[key]!));
  }
  return sealed;
}
function engine(pair = 'B-BTC_USDT') { return new RiskEngine(makePolicy({ pairConfig: { ...makePolicy().pairConfig, pair } })); }
function rejected(value: RiskEvaluationContext) {
  const evaluator = engine(value.candidate.pair); const result = evaluator.evaluateRisk(value);
  expect(result).toMatchObject({ status: 'REJECTED', primaryReasonCode: 'DECISION_IDENTITY_MISMATCH' });
  expect(evaluator.evaluateRisk(value)).toEqual(result);
  expect(evaluator.evaluatePositionSizing(value).decision).toMatchObject({ outcome: 'NOT_SIZED', sizing: null });
  return result;
}

describe('Wave C1 residual authoritative origin', () => {
  it.each(['B-BTC_USDT', 'B-ETH_USDT'])('accepts the genuine registry-created %s instance', (pair) => {
    const source = genuine(pair);
    expect(engine(pair).evaluateRisk(context(source))).toMatchObject({ status: 'ACCEPTED', action: 'OPEN', pair });
  });

  it.each([['B-BTC_USDT', 'B-ETH_USDT'], ['B-ETH_USDT', 'B-BTC_USDT']])('rejects coordinated %s to %s forgery with every public hash refreshed', (from, to) => {
    const source = genuine(from); const validTarget = genuine(to); const value = copy(context(source));
    value.candidate.strategyDecision.pair = to;
    const forged = refresh(value); const result = rejected(forged);
    // The forged semantic IDs even equal the independently emitted target IDs: only origin distinguishes them.
    expect(forged.candidate.strategyDecision).toEqual(validTarget.decision);
    expect(() => createStrategyRiskHandoff(validTarget.kernel, forged.candidate.strategyDecision, 'instrument-1'))
      .toThrowError(expect.objectContaining({ code: 'RISK_SOURCE_INVALID' }));
    expect(() => createStrategyRiskHandoff(source.kernel, forged.candidate.strategyDecision, 'instrument-1'))
      .toThrowError(expect.objectContaining({ code: 'RISK_SOURCE_INVALID' }));
    expect(engine(to).evaluateRisk(context(validTarget)).status).toBe('ACCEPTED');
    if (from === 'B-BTC_USDT') console.log('C-F01 origin evidence', JSON.stringify({ originalInstance: source.decision.strategyInstanceId,
      originalDecision: source.decision.decisionId, forgedInstance: forged.candidate.strategyDecision.strategyInstanceId,
      forgedDecision: forged.candidate.strategyDecision.decisionId, genuineEthInstance: validTarget.decision.strategyInstanceId,
      genuineEthDecision: validTarget.decision.decisionId, allPublicHashesRefreshed: true, result }));
  });

  it.each(['strategy', 'parameters', 'bootstrap'] as const)('rejects coordinated valid %s switch to another genuine instance', (field) => {
    const source = genuine();
    const target = genuine('B-BTC_USDT', field === 'parameters' ? 3 : 2, field === 'strategy' ? 'RSI_MOMENTUM' : 'EMA_TREND', field === 'bootstrap' ? BASE - 60_000 : BASE);
    const value = copy(context(source));
    value.candidate.strategyLineage = copy(target.handoff.candidate.strategyLineage);
    // Stronger than a relabel: reproduce the target's entire public decision, preserving only the original origin proof.
    value.candidate.strategyDecision = copy(target.decision);
    const forged = refresh(value);
    expect(forged.candidate.strategyDecision.parameterHash).toBe(target.kernel.parameterHash);
    expect(forged.candidate.strategyDecision.strategyInstanceId).toBe(target.kernel.strategyInstanceId);
    rejected(forged);
    expect(() => createStrategyRiskHandoff(target.kernel, forged.candidate.strategyDecision, 'instrument-1'))
      .toThrowError(expect.objectContaining({ code: 'RISK_SOURCE_INVALID' }));
  });

  it('supports two distinct legitimate instances of one strategy/pair in either evaluation order', () => {
    const first = genuine(); const second = genuine('B-BTC_USDT', 3); const evaluator = engine();
    expect(first.decision.strategyInstanceId).not.toBe(second.decision.strategyInstanceId);
    const a = evaluator.evaluateRisk(context(first)); const b = evaluator.evaluateRisk(context(second));
    expect(a.status).toBe('ACCEPTED'); expect(b.status).toBe('ACCEPTED');
    expect(a.riskDecisionId).not.toBe(b.riskDecisionId);
    expect(evaluator.evaluateRisk(context(second))).toEqual(b); expect(evaluator.evaluateRisk(context(first))).toEqual(a);
  });

  it('isolates original config, decision, lineage and exposed authority records from mutation', () => {
    const source = genuine(); const value = context(source); const evaluator = engine(); const baseline = evaluator.evaluateRisk(value);
    source.input.pair = 'B-ETH_USDT'; source.input.parameters.slowPeriod = 99;
    source.input.indicatorBootstrapIdentity[0]!.bootstrapStartOpenTimeMs = 0;
    expect(() => { copy(source.decision).pair = 'B-ETH_USDT'; }).not.toThrow();
    expect(Reflect.set(source.decision, 'pair', 'B-ETH_USDT')).toBe(false);
    const record = StrategyDecisionOrigin.read(source.handoff.strategyOrigin)!;
    expect(Reflect.set(record.instance, 'pair', 'B-ETH_USDT')).toBe(false);
    expect(Reflect.set(record.instance.normalizedParameters, 'slowPeriod', 99)).toBe(false);
    expect(Reflect.set(record.instance.indicatorBootstrapIdentity[0]!, 'bootstrapStartOpenTimeMs', 0)).toBe(false);
    expect(Reflect.set(source.handoff.candidate.strategyLineage, 'normalizedParameters', {})).toBe(false);
    expect(evaluator.evaluateRisk(value)).toEqual(baseline);
  });

  it.each(['null', 'plain-record', 'prototype-clone', 'serialized', 'proxy'] as const)('rejects counterfeit origin capability: %s', (kind) => {
    const source = genuine(); const value = context(source); const proof = source.handoff.strategyOrigin;
    const fake = kind === 'null' ? null : kind === 'plain-record' ? copy(StrategyDecisionOrigin.read(proof)) :
      kind === 'prototype-clone' ? Object.create(StrategyDecisionOrigin.prototype) : kind === 'proxy' ? new Proxy(proof, {}) : JSON.parse(JSON.stringify(proof));
    expect(StrategyDecisionOrigin.read(fake)).toBeNull(); rejected({ ...value, strategyOrigin: fake as StrategyDecisionOrigin });
  });

  it('cannot issue origin from a copied decision, wrong kernel, structural kernel, or caller-created issuer token', () => {
    const source = genuine(); const other = genuine();
    expect(BaseStrategyKernel.issueDecisionOrigin(source.kernel, copy(source.decision))).toBeNull();
    expect(BaseStrategyKernel.issueDecisionOrigin(other.kernel, source.decision)).toBeNull();
    expect(BaseStrategyKernel.issueDecisionOrigin({ ...source.kernel } as StrategyKernel, source.decision)).toBeNull();
    expect(() => new StrategyDecisionOrigin(Symbol('Phase10 kernel decision origin'), StrategyDecisionOrigin.read(source.handoff.strategyOrigin)!))
      .toThrowError(expect.objectContaining({ code: 'STRATEGY_INPUT_INVALID' }));
  });

  it('recreates equivalent authority by deterministic kernel replay without capability data in semantic identity', () => {
    const continuous = genuine(); const restarted = genuine();
    expect(continuous.handoff.strategyOrigin).not.toBe(restarted.handoff.strategyOrigin);
    expect(JSON.stringify(continuous.handoff.strategyOrigin)).toBe('{}');
    expect(continuous.decision).toEqual(restarted.decision);
    expect(engine().evaluateRisk(context(continuous))).toEqual(engine().evaluateRisk(context(restarted)));
    expect(createStrategyRiskHandoff(continuous.kernel, continuous.decision, 'instrument-1')!.candidate).toEqual(continuous.handoff.candidate);
  });
});
