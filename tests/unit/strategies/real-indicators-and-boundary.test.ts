import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BacktestEngine } from '../../../src/backtest';
import { adaptCanonicalCandle1m } from '../../../src/indicators';
import { adaptHigherTimeframeCandle } from '../../../src/indicators/candle/adapter';
import { createCanonicalCandle1m } from '../../../src/market-data/models';
import { aggregateExactBucket } from '../../../src/market-data/higher-timeframe/aggregate-exact-bucket';
import {
  atrBreakoutV1Definition,
  buildStrategyBacktestParticipantIdentity,
  createStrategyBacktestIndicatorBindings,
  createStrategyIndicatorBindings,
  emaTrendV1Definition,
  InMemoryStrategyDecisionSink,
  InMemoryStrategyDispatchAuditSink,
  multiTimeframeTrendV1Definition,
  rsiMomentumV1Definition,
  StrategyBacktestParticipantAdapter,
  type StrategyDecision,
} from '../../../src/strategies';
import { config as backtestConfig } from '../backtest/helpers';
import { BASE, PAIR, bootstrap, snapshot } from './helpers';

function marketCandle(index: number, close: string) {
  const previous = index === 0 ? close : '100';
  return createCanonicalCandle1m({
    pair: PAIR, openTimeMs: BASE + index * 60_000, open: previous, high: close, low: previous, close, volume: '1', quoteVolume: null,
    source: 'REST_HISTORICAL', finalizedAtMs: BASE + (index + 1) * 60_000, providerEventTimeMs: null, generationId: null,
  });
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

function createAtrReplay(candles: readonly ReturnType<typeof marketCandle>[]) {
  const kernel = atrBreakoutV1Definition.createKernel({
    pair: PAIR,
    parameters: { timeframeMinutes: 1, atrPeriod: 2, breakoutMultiplier: '1' },
    indicatorBootstrapIdentity: bootstrap(1),
  });
  const decisions = new InMemoryStrategyDecisionSink();
  const dispatches = new InMemoryStrategyDispatchAuditSink();
  const adapter = new StrategyBacktestParticipantAdapter({
    kernel,
    fixedResearchQuantity: '1',
    decisionSink: decisions,
    dispatchSink: dispatches,
  });
  const participantIdentity = buildStrategyBacktestParticipantIdentity({
    kernel,
    fixedResearchQuantity: '1',
    gitCommitHash: 'b513552',
  });
  const engine = new BacktestEngine(backtestConfig(candles, adapter, {
    participantIdentity,
    indicatorBindings: createStrategyBacktestIndicatorBindings(kernel),
  }));
  return { engine, decisions };
}

function decisionEvidence(decision: StrategyDecision) {
  return {
    decisionSequence: decision.decisionSequence,
    decisionId: decision.decisionId,
    strategyInstanceId: decision.strategyInstanceId,
    status: decision.status,
    targetExposure: decision.targetExposure,
    reasonCodes: decision.reasonCodes,
    evaluationTimeMs: decision.evaluationTimeMs,
  };
}

function candleEvidence(candle: ReturnType<typeof marketCandle>) {
  return {
    pair: candle.pair,
    openTimeMs: candle.openTimeMs,
    closeTimeExclusiveMs: candle.closeTimeExclusiveMs,
    open: candle.open.value,
    high: candle.high.value,
    low: candle.low.value,
    close: candle.close.value,
    volume: candle.volume.value,
  };
}

describe('real Phase 8 indicator reuse', () => {
  it('evaluates EMA Trend from genuine Phase 8 EmaKernel points', () => {
    const kernel = emaTrendV1Definition.createKernel({ pair: PAIR, parameters: { timeframeMinutes: 1, fastPeriod: 1, slowPeriod: 2, priceSource: 'CLOSE' }, indicatorBootstrapIdentity: bootstrap(1) });
    const bindings = createStrategyIndicatorBindings(kernel);
    const firstPoints = Object.fromEntries(bindings.map((binding) => [binding.alias, binding.kernel.update(adaptCanonicalCandle1m(marketCandle(0, '100')))]));
    expect(kernel.evaluate(snapshot(kernel, BASE + 60_000, {}, { triggerClose: '100', pointOverrides: firstPoints }))).toMatchObject({ status: 'WARMING' });
    const secondPoints = Object.fromEntries(bindings.map((binding) => [binding.alias, binding.kernel.update(adaptCanonicalCandle1m(marketCandle(1, '110')))]));
    expect(kernel.evaluate(snapshot(kernel, BASE + 120_000, {}, { triggerClose: '110', pointOverrides: secondPoints }))).toMatchObject({ targetExposure: 'LONG' });
  });

  it('evaluates ATR Breakout causally from genuine Phase 8 AtrKernel points', () => {
    const kernel = atrBreakoutV1Definition.createKernel({ pair: PAIR, parameters: { timeframeMinutes: 1, atrPeriod: 1, breakoutMultiplier: '2' }, indicatorBootstrapIdentity: bootstrap(1) });
    const binding = createStrategyIndicatorBindings(kernel)[0]!;
    const first = binding.kernel.update(adaptCanonicalCandle1m(marketCandle(0, '100')));
    expect(kernel.evaluate(snapshot(kernel, BASE + 60_000, {}, { triggerClose: '100', pointOverrides: { atr: first } }))).toMatchObject({ reasonCodes: ['ATR_REFERENCE_WARMING'] });
    const second = binding.kernel.update(adaptCanonicalCandle1m(marketCandle(1, '121')));
    expect(kernel.evaluate(snapshot(kernel, BASE + 120_000, {}, { triggerClose: '121', pointOverrides: { atr: second } }))).toMatchObject({ targetExposure: 'LONG', reasonCodes: ['ATR_BREAKOUT_UP'] });
  });

  it('evaluates RSI Momentum from a genuine Phase 8 RsiKernel point', () => {
    const kernel = rsiMomentumV1Definition.createKernel({ pair: PAIR, parameters: { timeframeMinutes: 1, period: 1, longThreshold: '70', shortThreshold: '30', priceSource: 'CLOSE' }, indicatorBootstrapIdentity: bootstrap(1) });
    const binding = createStrategyIndicatorBindings(kernel)[0]!;
    const first = binding.kernel.update(adaptCanonicalCandle1m(marketCandle(0, '100')));
    kernel.evaluate(snapshot(kernel, BASE + 60_000, {}, { triggerClose: '100', pointOverrides: { rsi: first } }));
    const second = binding.kernel.update(adaptCanonicalCandle1m(marketCandle(1, '110')));
    expect(kernel.evaluate(snapshot(kernel, BASE + 120_000, {}, { triggerClose: '110', pointOverrides: { rsi: second } }))).toMatchObject({ targetExposure: 'LONG', reasonCodes: ['RSI_LONG_THRESHOLD'] });
  });

  it('evaluates MTF consensus from genuine independent Phase 8 EMA kernels', () => {
    const kernel = multiTimeframeTrendV1Definition.createKernel({ pair: PAIR, parameters: { timeframes: [2, 1], fastPeriod: 1, slowPeriod: 2, priceSource: 'CLOSE' }, indicatorBootstrapIdentity: bootstrap(1, 2) });
    const bindings = createStrategyIndicatorBindings(kernel);
    const candles = ['100', '110', '120', '130'].map((close, index) => marketCandle(index, close));
    const latest = new Map<string, ReturnType<(typeof bindings)[number]['kernel']['update']>>();
    for (const source of candles.slice(0, 2)) {
      for (const binding of bindings.filter((entry) => entry.requirement.timeframeMinutes === 1)) {
        latest.set(binding.alias, binding.kernel.update(adaptCanonicalCandle1m(source)));
      }
    }
    const first2m = aggregateExactBucket(candles.slice(0, 2), 2);
    for (const binding of bindings.filter((entry) => entry.requirement.timeframeMinutes === 2)) {
      latest.set(binding.alias, binding.kernel.update(adaptHigherTimeframeCandle(first2m)));
    }
    expect(kernel.evaluate(snapshot(kernel, BASE + 120_000, {}, { triggerClose: '110', additionalClosedTimeframes: [2], pointOverrides: Object.fromEntries(latest) }))).toMatchObject({ status: 'WARMING' });
    for (const source of candles.slice(2)) {
      for (const binding of bindings.filter((entry) => entry.requirement.timeframeMinutes === 1)) {
        latest.set(binding.alias, binding.kernel.update(adaptCanonicalCandle1m(source)));
      }
    }
    const second2m = aggregateExactBucket(candles.slice(2), 2);
    for (const binding of bindings.filter((entry) => entry.requirement.timeframeMinutes === 2)) {
      latest.set(binding.alias, binding.kernel.update(adaptHigherTimeframeCandle(second2m)));
    }
    expect(kernel.evaluate(snapshot(kernel, BASE + 240_000, {}, { triggerClose: '130', additionalClosedTimeframes: [2], pointOverrides: Object.fromEntries(latest) }))).toMatchObject({ targetExposure: 'LONG', reasonCodes: ['MTF_ALL_BULLISH'] });
  });
});

describe('pure source boundary and no-lookahead evidence', () => {
  it('keeps core and implementations free of forbidden environment imports and order vocabulary', () => {
    const roots = [join(process.cwd(), 'src', 'strategies', 'core'), join(process.cwd(), 'src', 'strategies', 'implementations')];
    const files = roots.flatMap(sourceFiles);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from\s+['"][^'"]*(?:backtest|exchange|coin-runtime|risk|execution|account)/);
      expect(source, file).not.toMatch(/\b(?:BUY|SELL|MARKET|LIMIT|STOP|openOrders|currentPosition|accountEquity|leverage|margin|quantity)\b/);
    }
  });

  it('keeps stateful ATR decisions through T invariant to complete pre-built poison futures', async () => {
    const commonPrefix = Object.freeze(['100', '100', '100', '100']);
    const cutoffTimeMs = BASE + commonPrefix.length * 60_000;
    const streamA = Object.freeze([...commonPrefix, '500', '900'].map((close, index) => marketCandle(index, close)));
    const streamB = Object.freeze([...commonPrefix, '100', '100'].map((close, index) => marketCandle(index, close)));

    // Both immutable datasets, sources, real ATR kernels, and adapters exist before either replay starts.
    const replayA = createAtrReplay(streamA);
    const replayB = createAtrReplay(streamB);
    expect(Object.isFrozen(streamA)).toBe(true);
    expect(Object.isFrozen(streamB)).toBe(true);
    expect(streamA.slice(0, commonPrefix.length).map(candleEvidence))
      .toEqual(streamB.slice(0, commonPrefix.length).map(candleEvidence));
    expect(streamA.slice(commonPrefix.length).map(candleEvidence))
      .not.toEqual(streamB.slice(commonPrefix.length).map(candleEvidence));

    const resultA = await replayA.engine.run();
    const resultB = await replayB.engine.run();
    expect(resultA).toMatchObject({ terminalStatus: 'COMPLETED', isValid: true });
    expect(resultB).toMatchObject({ terminalStatus: 'COMPLETED', isValid: true });

    const throughT_A = replayA.decisions.decisions.filter((decision) => decision.evaluationTimeMs <= cutoffTimeMs);
    const throughT_B = replayB.decisions.decisions.filter((decision) => decision.evaluationTimeMs <= cutoffTimeMs);
    expect(throughT_A.map(decisionEvidence)).toEqual(throughT_B.map(decisionEvidence));
    expect(throughT_A.map((decision) => decision.status)).toEqual(['WARMING', 'WARMING', 'READY', 'READY']);
    expect(throughT_A.map((decision) => decision.reasonCodes)).toEqual([
      ['ATR_INDICATOR_WARMING'],
      ['ATR_REFERENCE_WARMING'],
      ['ATR_NO_BREAKOUT'],
      ['ATR_NO_BREAKOUT'],
    ]);

    const afterT_A = replayA.decisions.decisions.filter((decision) => decision.evaluationTimeMs > cutoffTimeMs);
    const afterT_B = replayB.decisions.decisions.filter((decision) => decision.evaluationTimeMs > cutoffTimeMs);
    expect(afterT_A.map(decisionEvidence)).not.toEqual(afterT_B.map(decisionEvidence));
    expect(afterT_A.some((decision) => decision.reasonCodes.includes('ATR_BREAKOUT_UP'))).toBe(true);
    expect(afterT_B.every((decision) => decision.reasonCodes.includes('ATR_NO_BREAKOUT'))).toBe(true);
  });
});
