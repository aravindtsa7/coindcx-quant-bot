import { describe, expect, it } from 'vitest';
import { AtrKernel, EmaKernel } from '../../../src/indicators';
import {
  StrategyError,
  StrategyRegistry,
  assertStrategyIndicatorBindings,
  atrBreakoutV1Definition,
  createStrategyIndicatorBindings,
  emaTrendV1Definition,
  multiTimeframeTrendV1Definition,
  normalizeCanonicalDecimalString,
  rsiMomentumV1Definition,
  type StrategyDefinition,
} from '../../../src/strategies';
import { BASE, PAIR, bootstrap } from './helpers';

const emaParameters = { timeframeMinutes: 5, fastPeriod: 3, slowPeriod: 7, priceSource: 'CLOSE' as const };

describe('Phase 10 registry and canonical identity', () => {
  it('registers all four definitions and resolves only exact versions', () => {
    const registry = new StrategyRegistry();
    for (const definition of [emaTrendV1Definition, atrBreakoutV1Definition, rsiMomentumV1Definition, multiTimeframeTrendV1Definition]) registry.register(definition);
    expect(registry.list()).toEqual([
      { strategyId: 'ATR_BREAKOUT', strategyVersion: '1.0.0' },
      { strategyId: 'EMA_TREND', strategyVersion: '1.0.0' },
      { strategyId: 'MULTI_TIMEFRAME_TREND', strategyVersion: '1.0.0' },
      { strategyId: 'RSI_MOMENTUM', strategyVersion: '1.0.0' },
    ]);
    expect(registry.get('EMA_TREND', '1.0.0')).toBe(emaTrendV1Definition);
    expect(() => registry.get('EMA_TREND', '2.0.0')).toThrowError(expect.objectContaining({ code: 'STRATEGY_NOT_FOUND' }));
    expect(() => registry.register(emaTrendV1Definition)).toThrowError(expect.objectContaining({ code: 'STRATEGY_REGISTRY_CONFLICT' }));
  });

  it('accepts an extra definition without registry core changes', () => {
    const extra: StrategyDefinition = Object.freeze({
      strategyId: 'EXTRA', strategyVersion: '1.0.0',
      normalizeParameters: () => Object.freeze({}),
      describeConstruction: () => Object.freeze({ normalizedParameters: Object.freeze({}), triggerTimeframeMinutes: 1, indicatorRequirements: Object.freeze([]) }),
      createKernel: () => { throw new Error('not used'); },
    });
    const registry = new StrategyRegistry();
    registry.register(extra);
    expect(registry.has('EXTRA', '1.0.0')).toBe(true);
  });

  it.each([
    ['2', '2'], ['2.0', '2'], ['2.00', '2'], ['002.000', '2'], ['00.0500', '0.05'],
    ['-0', '0'], ['-0.000', '0'], ['-01.500', '-1.5'],
  ])('normalizes decimal %s to %s', (raw, expected) => {
    expect(normalizeCanonicalDecimalString(raw)).toBe(expected);
  });

  it.each(['+2', ' 2', '2 ', '2e0', '.5', '2.', '1,000', '1_000', 'NaN', 'Infinity'])('rejects invalid decimal syntax %s', (raw) => {
    expect(() => normalizeCanonicalDecimalString(raw)).toThrowError(expect.objectContaining({ code: 'INVALID_STRATEGY_PARAMETER' }));
  });

  it('gives equivalent decimal formatting the same parameter identity', () => {
    const hashes = ['2', '2.0', '2.00', '002.000'].map((breakoutMultiplier) =>
      atrBreakoutV1Definition.createKernel({ pair: PAIR, parameters: { timeframeMinutes: 5, atrPeriod: 3, breakoutMultiplier }, indicatorBootstrapIdentity: bootstrap(5) }).parameterHash);
    expect(new Set(hashes).size).toBe(1);
    const halfA = atrBreakoutV1Definition.createKernel({ pair: PAIR, parameters: { timeframeMinutes: 5, atrPeriod: 3, breakoutMultiplier: '0.5' }, indicatorBootstrapIdentity: bootstrap(5) });
    const halfB = atrBreakoutV1Definition.createKernel({ pair: PAIR, parameters: { breakoutMultiplier: '00.500', atrPeriod: 3, timeframeMinutes: 5 }, indicatorBootstrapIdentity: bootstrap(5) });
    expect(halfA.parameterHash).toBe(halfB.parameterHash);
    expect(halfA.parameterHash).not.toBe(hashes[0]);
  });

  it('normalizes MTF order but rejects duplicates, unknowns, undefined and bad price sources', () => {
    const a = multiTimeframeTrendV1Definition.createKernel({ pair: PAIR, parameters: { timeframes: [15, 5], fastPeriod: 2, slowPeriod: 4, priceSource: 'CLOSE' }, indicatorBootstrapIdentity: bootstrap(5, 15) });
    const b = multiTimeframeTrendV1Definition.createKernel({ pair: PAIR, parameters: { priceSource: 'CLOSE', slowPeriod: 4, fastPeriod: 2, timeframes: [5, 15] }, indicatorBootstrapIdentity: bootstrap(5, 15) });
    expect(a.normalizedParameters).toEqual(b.normalizedParameters);
    expect(a.parameterHash).toBe(b.parameterHash);
    expect(() => multiTimeframeTrendV1Definition.createKernel({ pair: PAIR, parameters: { timeframes: [5, 15, 5], fastPeriod: 2, slowPeriod: 4, priceSource: 'CLOSE' }, indicatorBootstrapIdentity: bootstrap(5, 15) })).toThrowError(StrategyError);
    expect(() => emaTrendV1Definition.createKernel({ pair: PAIR, parameters: { ...emaParameters, extra: 1 }, indicatorBootstrapIdentity: bootstrap(5) })).toThrowError(StrategyError);
    expect(() => emaTrendV1Definition.createKernel({ pair: PAIR, parameters: { ...emaParameters, fastPeriod: undefined }, indicatorBootstrapIdentity: bootstrap(5) })).toThrowError(StrategyError);
    expect(() => emaTrendV1Definition.createKernel({ pair: PAIR, parameters: { ...emaParameters, priceSource: 'close' }, indicatorBootstrapIdentity: bootstrap(5) })).toThrowError(StrategyError);
  });

  it('defensively copies caller parameter arrays', () => {
    const timeframes = [15, 5];
    const kernel = multiTimeframeTrendV1Definition.createKernel({ pair: PAIR, parameters: { timeframes, fastPeriod: 2, slowPeriod: 4, priceSource: 'CLOSE' }, indicatorBootstrapIdentity: bootstrap(5, 15) });
    timeframes.push(60);
    expect(kernel.normalizedParameters.timeframes).toEqual([5, 15]);
    expect(Object.isFrozen(kernel.normalizedParameters)).toBe(true);
    expect(Object.isFrozen(kernel.normalizedParameters.timeframes)).toBe(true);
  });

  it('binds every bootstrap origin into strategyInstanceId and rejects bad coverage', () => {
    const parameters = { timeframes: [5, 15], fastPeriod: 2, slowPeriod: 4, priceSource: 'CLOSE' };
    const a = multiTimeframeTrendV1Definition.createKernel({ pair: PAIR, parameters, indicatorBootstrapIdentity: bootstrap(5, 15) });
    const b = multiTimeframeTrendV1Definition.createKernel({ pair: PAIR, parameters, indicatorBootstrapIdentity: [{ timeframeMinutes: 15, bootstrapStartOpenTimeMs: BASE }, { timeframeMinutes: 5, bootstrapStartOpenTimeMs: BASE }] });
    const c = multiTimeframeTrendV1Definition.createKernel({ pair: PAIR, parameters, indicatorBootstrapIdentity: [{ timeframeMinutes: 5, bootstrapStartOpenTimeMs: BASE }, { timeframeMinutes: 15, bootstrapStartOpenTimeMs: BASE + 900_000 }] });
    expect(a.strategyInstanceId).toBe(b.strategyInstanceId);
    expect(a.strategyInstanceId).not.toBe(c.strategyInstanceId);
    expect(() => multiTimeframeTrendV1Definition.createKernel({ pair: PAIR, parameters, indicatorBootstrapIdentity: bootstrap(5) })).toThrowError(StrategyError);
    expect(() => multiTimeframeTrendV1Definition.createKernel({ pair: PAIR, parameters, indicatorBootstrapIdentity: bootstrap(5, 15, 60) })).toThrowError(StrategyError);
    expect(() => multiTimeframeTrendV1Definition.createKernel({ pair: PAIR, parameters, indicatorBootstrapIdentity: bootstrap(5, 5, 15) })).toThrowError(StrategyError);
  });

  it('constructs and validates real Phase 8 bindings before use', () => {
    const kernel = emaTrendV1Definition.createKernel({ pair: PAIR, parameters: emaParameters, indicatorBootstrapIdentity: bootstrap(5) });
    const bindings = createStrategyIndicatorBindings(kernel);
    expect(bindings.every((binding) => binding.kernel instanceof EmaKernel)).toBe(true);
    expect(() => assertStrategyIndicatorBindings(kernel, [
      { ...bindings[0]!, kernel: new EmaKernel({ pair: PAIR, timeframeMinutes: 5, bootstrapStartOpenTimeMs: BASE + 300_000, period: 3, priceSource: 'CLOSE' }) },
      bindings[1]!,
    ])).toThrowError(expect.objectContaining({ code: 'STRATEGY_INPUT_INVALID' }));
  });

  it('rejects Phase 8 pair, timeframe, type, parameter and source semantic mismatches', () => {
    const kernel = emaTrendV1Definition.createKernel({ pair: PAIR, parameters: emaParameters, indicatorBootstrapIdentity: bootstrap(5) });
    const valid = createStrategyIndicatorBindings(kernel);
    const replacements = [
      new EmaKernel({ pair: 'OTHER', timeframeMinutes: 5, bootstrapStartOpenTimeMs: BASE, period: 3, priceSource: 'CLOSE' }),
      new EmaKernel({ pair: PAIR, timeframeMinutes: 15, bootstrapStartOpenTimeMs: BASE, period: 3, priceSource: 'CLOSE' }),
      new EmaKernel({ pair: PAIR, timeframeMinutes: 5, bootstrapStartOpenTimeMs: BASE, period: 4, priceSource: 'CLOSE' }),
      new EmaKernel({ pair: PAIR, timeframeMinutes: 5, bootstrapStartOpenTimeMs: BASE, period: 3, priceSource: 'OPEN' }),
      new AtrKernel({ pair: PAIR, timeframeMinutes: 5, bootstrapStartOpenTimeMs: BASE, period: 3 }),
    ];
    for (const replacement of replacements) {
      expect(() => assertStrategyIndicatorBindings(kernel, [{ ...valid[0]!, kernel: replacement }, valid[1]!]))
        .toThrowError(expect.objectContaining({ code: 'STRATEGY_INPUT_INVALID' }));
    }
  });
});
