import { describe, expect, it } from 'vitest';
import {
  StrategyError,
  atrBreakoutV1Definition,
  emaTrendV1Definition,
  multiTimeframeTrendV1Definition,
  rsiMomentumV1Definition,
} from '../../../src/strategies';
import { BASE, PAIR, bootstrap, indicatorPoint, snapshot } from './helpers';

function emaKernel() {
  return emaTrendV1Definition.createKernel({ pair: PAIR, parameters: { timeframeMinutes: 1, fastPeriod: 2, slowPeriod: 3, priceSource: 'CLOSE' }, indicatorBootstrapIdentity: bootstrap(1) });
}

function atrKernel(multiplier = '2') {
  return atrBreakoutV1Definition.createKernel({ pair: PAIR, parameters: { timeframeMinutes: 1, atrPeriod: 2, breakoutMultiplier: multiplier }, indicatorBootstrapIdentity: bootstrap(1) });
}

function rsiKernel() {
  return rsiMomentumV1Definition.createKernel({ pair: PAIR, parameters: { timeframeMinutes: 1, period: 2, longThreshold: '70', shortThreshold: '30', priceSource: 'CLOSE' }, indicatorBootstrapIdentity: bootstrap(1) });
}

function mtfKernel() {
  return multiTimeframeTrendV1Definition.createKernel({ pair: PAIR, parameters: { timeframes: [5, 15], fastPeriod: 2, slowPeriod: 3, priceSource: 'CLOSE' }, indicatorBootstrapIdentity: bootstrap(5, 15) });
}

describe('common strategy lifecycle and validation', () => {
  it('rejects missing required aliases for every strategy definition', () => {
    const cases = [emaKernel(), atrKernel(), rsiKernel(), mtfKernel()];
    const times = [BASE + 60_000, BASE + 60_000, BASE + 60_000, BASE + 600_000];
    cases.forEach((kernel, index) => {
      const alias = kernel.indicatorRequirements[0]?.alias;
      if (alias === undefined) throw new Error('fixture requires an indicator');
      expect(() => kernel.evaluate(snapshot(kernel, times[index]!, {}, { omitAliases: [alias] })))
        .toThrowError(expect.objectContaining({ code: 'STRATEGY_INPUT_INVALID' }));
      expect(kernel.isTerminated).toBe(true);
    });
  });

  it('rejects a missing required alias instead of warming and terminates', () => {
    const kernel = emaKernel();
    expect(() => kernel.evaluate(snapshot(kernel, BASE + 60_000, { 'ema.fast': null, 'ema.slow': null }, { omitAliases: ['ema.slow'] })))
      .toThrowError(expect.objectContaining({ code: 'STRATEGY_INPUT_INVALID' }));
    expect(kernel.isTerminated).toBe(true);
    expect(() => kernel.evaluate(snapshot(kernel, BASE + 120_000, { 'ema.fast': '2', 'ema.slow': '1' })))
      .toThrowError(expect.objectContaining({ code: 'STRATEGY_TERMINATED' }));
  });

  it('uses specific pair and timeframe mismatch errors', () => {
    const pairKernel = emaKernel();
    expect(() => pairKernel.evaluate(snapshot(pairKernel, BASE + 60_000, { 'ema.fast': '2', 'ema.slow': '1' }, {
      pointOverrides: { 'ema.fast': indicatorPoint(1, BASE + 60_000, '2', 'OTHER') },
    }))).toThrowError(expect.objectContaining({ code: 'STRATEGY_PAIR_MISMATCH' }));
    const timeframeKernel = emaKernel();
    expect(() => timeframeKernel.evaluate(snapshot(timeframeKernel, BASE + 60_000, { 'ema.fast': '2', 'ema.slow': '1' }, {
      pointOverrides: { 'ema.fast': indicatorPoint(5, BASE + 60_000, '2') },
    }))).toThrowError(expect.objectContaining({ code: 'STRATEGY_TIMEFRAME_MISMATCH' }));
  });

  it('distinguishes initial warmup from impossible null regression', () => {
    const kernel = emaKernel();
    const warming = kernel.evaluate(snapshot(kernel, BASE + 60_000, { 'ema.fast': null, 'ema.slow': null }));
    expect(warming).toMatchObject({ decisionSequence: 1, status: 'WARMING', targetExposure: null, reasonCodes: ['EMA_WARMING'] });
    expect(kernel.evaluate(snapshot(kernel, BASE + 120_000, { 'ema.fast': '2', 'ema.slow': '1' }))).toMatchObject({ decisionSequence: 2, status: 'READY' });
    expect(() => kernel.evaluate(snapshot(kernel, BASE + 180_000, { 'ema.fast': null, 'ema.slow': '1' })))
      .toThrowError(expect.objectContaining({ code: 'STRATEGY_INPUT_INVALID' }));
    expect(kernel.isTerminated).toBe(true);
  });

  it('fails on duplicate/backward evaluations, future points, and stale trigger points', () => {
    const duplicate = emaKernel();
    duplicate.evaluate(snapshot(duplicate, BASE + 60_000, { 'ema.fast': '2', 'ema.slow': '1' }));
    expect(() => duplicate.evaluate(snapshot(duplicate, BASE + 60_000, { 'ema.fast': '2', 'ema.slow': '1' })))
      .toThrowError(expect.objectContaining({ code: 'STRATEGY_EVALUATION_ORDER_VIOLATION' }));

    const future = emaKernel();
    expect(() => future.evaluate(snapshot(future, BASE + 60_000, { 'ema.fast': '2', 'ema.slow': '1' }, {
      pointOverrides: { 'ema.fast': indicatorPoint(1, BASE + 120_000, '2') },
    }))).toThrowError(expect.objectContaining({ code: 'STRATEGY_INPUT_FUTURE_DATA' }));

    const stale = emaKernel();
    expect(() => stale.evaluate(snapshot(stale, BASE + 120_000, { 'ema.fast': '2', 'ema.slow': '1' }, {
      pointOverrides: { 'ema.fast': indicatorPoint(1, BASE + 60_000, '2') },
    }))).toThrowError(expect.objectContaining({ code: 'STRATEGY_INPUT_INVALID' }));

    const backward = emaKernel();
    backward.evaluate(snapshot(backward, BASE + 120_000, { 'ema.fast': '2', 'ema.slow': '1' }));
    expect(() => backward.evaluate(snapshot(backward, BASE + 60_000, { 'ema.fast': '2', 'ema.slow': '1' })))
      .toThrowError(expect.objectContaining({ code: 'STRATEGY_EVALUATION_ORDER_VIOLATION' }));
  });

  it('rejects malformed indicator timestamps before strategy logic', () => {
    const kernel = emaKernel();
    const malformed = { ...indicatorPoint(1, BASE + 60_000, '2'), openTimeMs: BASE + 60_000 };
    expect(() => kernel.evaluate(snapshot(kernel, BASE + 60_000, { 'ema.fast': '2', 'ema.slow': '1' }, {
      pointOverrides: { 'ema.fast': malformed },
    }))).toThrowError(expect.objectContaining({ code: 'STRATEGY_INPUT_INVALID' }));
  });

  it('constructs immutable deterministic decisions and replay IDs', () => {
    const left = emaKernel();
    const right = emaKernel();
    const leftDecisions = [
      left.evaluate(snapshot(left, BASE + 60_000, { 'ema.fast': null, 'ema.slow': null })),
      left.evaluate(snapshot(left, BASE + 120_000, { 'ema.fast': '2', 'ema.slow': '1' })),
    ];
    const rightDecisions = [
      right.evaluate(snapshot(right, BASE + 60_000, { 'ema.fast': null, 'ema.slow': null })),
      right.evaluate(snapshot(right, BASE + 120_000, { 'ema.fast': '2', 'ema.slow': '1' })),
    ];
    expect(leftDecisions).toEqual(rightDecisions);
    expect(Object.isFrozen(leftDecisions[0])).toBe(true);
    expect(Object.isFrozen(leftDecisions[0]!.reasonCodes)).toBe(true);
  });
});

describe('EMA Trend V1 exact relation semantics', () => {
  it.each([
    ['2', '1', 'LONG', 'EMA_FAST_ABOVE_SLOW'],
    ['1', '2', 'SHORT', 'EMA_FAST_BELOW_SLOW'],
    ['2.000', '2', 'FLAT', 'EMA_FAST_EQUALS_SLOW'],
  ] as const)('maps fast=%s slow=%s to %s', (fast, slow, target, reason) => {
    const kernel = emaKernel();
    expect(kernel.evaluate(snapshot(kernel, BASE + 60_000, { 'ema.fast': fast, 'ema.slow': slow })))
      .toMatchObject({ status: 'READY', targetExposure: target, reasonCodes: [reason] });
  });

  it('is relation-based, not crossover-only', () => {
    const kernel = emaKernel();
    expect(kernel.evaluate(snapshot(kernel, BASE + 60_000, { 'ema.fast': '2', 'ema.slow': '1' })).targetExposure).toBe('LONG');
    expect(kernel.evaluate(snapshot(kernel, BASE + 120_000, { 'ema.fast': '3', 'ema.slow': '2' })).targetExposure).toBe('LONG');
  });
});

describe('ATR Breakout V1 causal reference semantics', () => {
  it('warms on null and then on the first ready reference', () => {
    const kernel = atrKernel();
    expect(kernel.evaluate(snapshot(kernel, BASE + 60_000, { atr: null }, { triggerClose: '100' }))).toMatchObject({ status: 'WARMING', reasonCodes: ['ATR_INDICATOR_WARMING'] });
    expect(kernel.evaluate(snapshot(kernel, BASE + 120_000, { atr: '10' }, { triggerClose: '100' }))).toMatchObject({ decisionSequence: 2, status: 'WARMING', reasonCodes: ['ATR_REFERENCE_WARMING'] });
  });

  it.each([
    ['121', 'LONG', 'ATR_BREAKOUT_UP'],
    ['79', 'SHORT', 'ATR_BREAKOUT_DOWN'],
    ['120', 'FLAT', 'ATR_NO_BREAKOUT'],
    ['80', 'FLAT', 'ATR_NO_BREAKOUT'],
    ['100', 'FLAT', 'ATR_NO_BREAKOUT'],
  ] as const)('uses strict prior close plus prior ATR envelope for close %s', (close, target, reason) => {
    const kernel = atrKernel('2');
    kernel.evaluate(snapshot(kernel, BASE + 60_000, { atr: '10' }, { triggerClose: '100' }));
    const decision = kernel.evaluate(snapshot(kernel, BASE + 120_000, { atr: '1000' }, { triggerClose: close }));
    expect(decision).toMatchObject({ status: 'READY', targetExposure: target, reasonCodes: [reason] });
  });

  it('does not mutate the causal reference on failed evaluation', () => {
    const kernel = atrKernel();
    kernel.evaluate(snapshot(kernel, BASE + 60_000, { atr: '10' }, { triggerClose: '100' }));
    expect(() => kernel.evaluate(snapshot(kernel, BASE + 120_000, { atr: '10' }, { omitAliases: ['atr'], triggerClose: '200' }))).toThrowError(StrategyError);
    expect(kernel.isTerminated).toBe(true);
  });
});

describe('RSI Momentum V1 exact thresholds', () => {
  it.each([
    ['70', 'LONG', 'RSI_LONG_THRESHOLD'],
    ['90', 'LONG', 'RSI_LONG_THRESHOLD'],
    ['30', 'SHORT', 'RSI_SHORT_THRESHOLD'],
    ['10', 'SHORT', 'RSI_SHORT_THRESHOLD'],
    ['50', 'FLAT', 'RSI_NEUTRAL'],
  ] as const)('maps RSI %s exactly', (value, target, reason) => {
    const kernel = rsiKernel();
    expect(kernel.evaluate(snapshot(kernel, BASE + 60_000, { rsi: value }))).toMatchObject({ targetExposure: target, reasonCodes: [reason] });
  });

  it('warms on initial null and rejects inverted thresholds', () => {
    const kernel = rsiKernel();
    expect(kernel.evaluate(snapshot(kernel, BASE + 60_000, { rsi: null }))).toMatchObject({ status: 'WARMING', targetExposure: null, reasonCodes: ['RSI_WARMING'] });
    expect(() => rsiMomentumV1Definition.createKernel({ pair: PAIR, parameters: { timeframeMinutes: 1, period: 2, longThreshold: '30', shortThreshold: '70', priceSource: 'CLOSE' }, indicatorBootstrapIdentity: bootstrap(1) }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_STRATEGY_PARAMETER' }));
  });
});

describe('Multi-Timeframe Trend V1 closed-truth semantics', () => {
  const bullish = { 'tf.5.ema.fast': '2', 'tf.5.ema.slow': '1', 'tf.15.ema.fast': '4', 'tf.15.ema.slow': '3' };
  it.each([
    [bullish, 'LONG', 'MTF_ALL_BULLISH'],
    [{ 'tf.5.ema.fast': '1', 'tf.5.ema.slow': '2', 'tf.15.ema.fast': '3', 'tf.15.ema.slow': '4' }, 'SHORT', 'MTF_ALL_BEARISH'],
    [{ 'tf.5.ema.fast': '2', 'tf.5.ema.slow': '1', 'tf.15.ema.fast': '3', 'tf.15.ema.slow': '4' }, 'FLAT', 'MTF_MIXED'],
    [{ 'tf.5.ema.fast': '2', 'tf.5.ema.slow': '2', 'tf.15.ema.fast': '4', 'tf.15.ema.slow': '3' }, 'FLAT', 'MTF_MIXED'],
  ] as const)('applies unanimous consensus', (values, target, reason) => {
    const kernel = mtfKernel();
    expect(kernel.evaluate(snapshot(kernel, BASE + 600_000, values))).toMatchObject({ targetExposure: target, reasonCodes: [reason] });
  });

  it('warms if any structurally valid indicator is initially null', () => {
    const kernel = mtfKernel();
    expect(kernel.evaluate(snapshot(kernel, BASE + 600_000, { ...bullish, 'tf.15.ema.slow': null }))).toMatchObject({ status: 'WARMING', targetExposure: null });
  });

  it('requires fresh same-T HTF points when that HTF closes', () => {
    const stale = mtfKernel();
    expect(() => stale.evaluate(snapshot(stale, BASE + 900_000, bullish, {
      additionalClosedTimeframes: [15],
      pointOverrides: { 'tf.15.ema.fast': indicatorPoint(15, BASE, '4') },
    }))).toThrowError(expect.objectContaining({ code: 'STRATEGY_INPUT_INVALID' }));
    const fresh = mtfKernel();
    expect(fresh.evaluate(snapshot(fresh, BASE + 900_000, bullish, { additionalClosedTimeframes: [15] })).targetExposure).toBe('LONG');
  });

  it('rejects future/forming MTF indicator truth', () => {
    const kernel = mtfKernel();
    expect(() => kernel.evaluate(snapshot(kernel, BASE + 600_000, bullish, {
      pointOverrides: { 'tf.15.ema.fast': indicatorPoint(15, BASE + 900_000, '4') },
    }))).toThrowError(expect.objectContaining({ code: 'STRATEGY_INPUT_FUTURE_DATA' }));
  });

  it('accepts the latest prior HTF point when the HTF did not close', () => {
    const kernel = mtfKernel();
    expect(kernel.evaluate(snapshot(kernel, BASE + 600_000, bullish)).targetExposure).toBe('LONG');
  });
});
