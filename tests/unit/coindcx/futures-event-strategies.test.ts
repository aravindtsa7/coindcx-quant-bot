import { describe, expect, it } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { FUTURES_STRATEGY_DEFAULTS, FUTURES_STRATEGY_DEFINITIONS, type FuturesStrategyId } from '../../../src/integration/coindcx/live/futures-strategies';
import { HistoricalStrategySession, PracticalBacktestRunner, parseBacktestConfig, strategyParameters } from '../../../src/integration/coindcx/live/practical-backtest-runner';
import { adx, atr, bollingerBands, CausalAverage, type GateCandle, type MacroGatePoint } from '../../../src/integration/coindcx/live/strategy-gates';
import { parseBacktestArguments } from '../../../scripts/run-backtest';
import type { RestCandleRecord } from '../../../src/market-data/rest-candle-reader';

const pair = 'B-ETH_USDT', start = Date.parse('2026-01-01T00:00:00Z'), minute = 60_000;
const ids = Object.keys(FUTURES_STRATEGY_DEFAULTS) as FuturesStrategyId[];
function candle(i: number, open = 100, high = 100.5, low = 99.5, close = 100, volume = 10): GateCandle {
  return { openTimeMs: start + i * 30 * minute, closeTimeMs: start + (i + 1) * 30 * minute, open, high, low, close, volume };
}
function record(c: GateCandle): RestCandleRecord {
  return { pair, openTimeMs: c.openTimeMs, open: new Decimal(c.open), high: new Decimal(c.high), low: new Decimal(c.low),
    close: new Decimal(c.close), volume: new Decimal(c.volume), quoteVolume: null };
}
function scenario(id: FuturesStrategyId, side: 'LONG' | 'SHORT' = 'LONG') {
  const bars = Array.from({ length: 220 }, (_, i) => {
    const c = id === 'bb_squeeze_adx' && i < 180 ? 100 + 3 * Math.sin(i * .7) : 100;
    return candle(i, c, c + .5, c - .5, c);
  });
  const extra = id === 'liquidity_sweep_sfp' ? [[99.5, 100.6, 98.5, 100.2, 100], [99.5, 100.7, 98, 100.3, 100]]
    : id === 'liquidity_sweep_mss' ? [[98.8, 101.2, 98.5, 101, 100], [101, 102.2, 100.8, 102, 100]]
    : id === 'vol_climax_reversal' ? [[99.5, 101, 98.5, 100.8, 100], [100, 101.3, 98.3, 101.1, 100]]
    : [[100, 110.1, 99.9, 110, 100], [110, 120.1, 109.9, 120, 100]];
  for (const [o, h, l, c, v] of extra) bars.push(candle(bars.length, o!, h!, l!, c!, v!));
  bars.push(candle(222)); bars.push(candle(223)); bars.push(candle(224));
  return side === 'LONG' ? bars : bars.map(c => ({ ...c, open: 200 - c.open, high: 200 - c.low, low: 200 - c.high, close: 200 - c.close }));
}
function parameters(id: FuturesStrategyId) {
  return { use4hTrend100: false, use4hTrend200: false, costGateMult: 0,
    ...(id === 'liquidity_sweep_sfp' ? { rsiMaxLong: 100, rsiMinShort: 0 } : {}),
    ...(id === 'bb_squeeze_adx' ? { adxMin: 0, adxRising: false } : {}) };
}
function macro(closeTime: number, side: 'LONG' | 'SHORT' | 'BLOCK'): MacroGatePoint {
  const up = side === 'LONG';
  return { sourceCloseTimeMs: closeTime, close4h: side === 'BLOCK' ? 100 : up ? 120 : 80,
    ema50: up ? 110 : 90, ema100: 100, ema200: 100, long100: up, short100: !up, long200: up, short200: !up };
}
function replay(id: FuturesStrategyId, bars: readonly GateCandle[], overrides: Record<string, unknown> = {},
  points?: (i: number, bar: GateCandle) => MacroGatePoint | null) {
  const session = new HistoricalStrategySession(pair, id, 30, bars[0]!.openTimeMs, { ...parameters(id), ...overrides });
  return bars.map((c, i) => session.update(record(c), { macroTrend: points?.(i, c) ?? null }).decision!);
}

describe('Shared futures transition-event kernels', () => {
  it.each(ids)('%s exposes its exact strategy defaults and a real producing kernel', id => {
    const definition = FUTURES_STRATEGY_DEFINITIONS[id], normalized = definition.normalizeParameters({ timeframeMinutes: 30 });
    expect(Object.fromEntries(Object.entries(normalized).map(([k, v]) => [k, typeof v === 'string' ? Number(v) : v]))).toMatchObject(FUTURES_STRATEGY_DEFAULTS[id]);
    const session = new HistoricalStrategySession(pair, id, 30, start);
    expect(session.kernel.strategyId).toBe(id.toUpperCase());
    expect(() => definition.normalizeParameters({ unexpected: 1 })).toThrow(/Unknown/);
  });
  it.each(ids.flatMap(id => (['LONG', 'SHORT'] as const).map(side => ({ id, side }))))('$id emits $side only on false → true, suppressing the second eligible bar', ({ id, side }) => {
    const bars = scenario(id, side), decisions = replay(id, bars);
    expect(decisions[219]!.targetExposure).not.toBe(side);
    expect(decisions[220]!.targetExposure).toBe(side);
    expect(decisions[221]!.targetExposure).toBe('FLAT');
    expect(decisions[221]!.reasonCodes).toEqual(['NO_TRANSITION']);
    expect(replay(id, bars)).toEqual(decisions);
    expect(replay(id, bars.slice(0, 222))).toEqual(decisions.slice(0, 222));
  });
  it.each(ids)('%s applies G100 BEFORE transition detection, so an unchanged setup fires when the gate opens', id => {
    const bars = scenario(id), decisions = replay(id, bars, { use4hTrend100: true }, (i, c) => macro(c.closeTimeMs, i === 220 ? 'BLOCK' : 'LONG'));
    expect(decisions[220]!.targetExposure).toBe('FLAT');
    expect(decisions[221]!.targetExposure).toBe('LONG');
    expect(replay(id, bars, { use4hTrend100: true }).every(d => d.targetExposure !== 'LONG' && d.targetExposure !== 'SHORT')).toBe(true);
  });
  it.each(ids)('%s applies G200 and fee-derived cost filtering to both directions', id => {
    for (const side of ['LONG', 'SHORT'] as const) {
      const bars = scenario(id, side);
      const blocked = replay(id, bars, { use4hTrend200: true }, (_i, c) => macro(c.closeTimeMs, side === 'LONG' ? 'SHORT' : 'LONG'));
      expect(blocked[220]!.targetExposure).toBe('FLAT');
      const passed = replay(id, bars, { use4hTrend200: true }, (_i, c) => macro(c.closeTimeMs, side));
      expect(passed[220]!.targetExposure).toBe(side);
      expect(replay(id, bars, { costGateMult: 1000, rtCost: 1 })[220]!.targetExposure).toBe('FLAT');
      expect(replay(id, bars, { costGateMult: 1, rtCost: 0 })[220]!.targetExposure).toBe(side);
    }
  });
  it.each(ids)('%s applies the cost gate BEFORE edge detection when volatility becomes eligible', id => {
    const bars = scenario(id);
    if (id === 'liquidity_sweep_mss') bars[221] = candle(221, 100, 104.2, 98.4, 104, 100);
    if (id === 'vol_climax_reversal') bars[221] = candle(221, 100, 101.3, 97, 101.1, 100);
    const ranges = atr(bars), before = ranges[220]! / bars[220]!.close, after = ranges[221]! / bars[221]!.close;
    expect(after).toBeGreaterThan(before);
    const decisions = replay(id, bars, { costGateMult: 1, rtCost: (before + after) / 2 });
    expect(decisions[220]!.targetExposure).toBe('FLAT'); expect(decisions[221]!.targetExposure).toBe('LONG');
  });
  it('rejects future macro evidence and never borrows future strategy bars', () => {
    expect(() => replay('liquidity_sweep_mss', scenario('liquidity_sweep_mss'), { use4hTrend100: true }, (_i, c) => macro(c.closeTimeMs + 240 * minute, 'LONG'))).toThrow(/Macro candle/);
  });
  it('SFP re-arms after a neutral bar and respects the configured pierce/RSI/volume/wick limits', () => {
    const bars = scenario('liquidity_sweep_sfp').slice(0, 223);
    bars.push(candle(223, 99, 100.7, 97.5, 100.4, 100));
    expect(replay('liquidity_sweep_sfp', bars)[223]!.targetExposure).toBe('LONG');
    for (const override of [{ maxPierceAtr: .01 }, { rsiMaxLong: 1 }, { rvolMin: 100 }, { wickRatio: .99 }]) {
      expect(replay('liquidity_sweep_sfp', bars, override)[220]!.targetExposure).toBe('FLAT');
    }
  });
  it('MSS swing reference predates the sweep by an extra bar and enforces previous-high/body checks', () => {
    const bars = scenario('liquidity_sweep_mss');
    bars[219] = candle(219, 100, 100.5, 98, 100, 10);
    bars[220] = candle(220, 99.2, 101.2, 99, 101, 100);
    expect(replay('liquidity_sweep_mss', bars)[220]!.targetExposure).toBe('LONG');
    expect(replay('liquidity_sweep_mss', bars, { bodyRatio: .99 })[220]!.targetExposure).toBe('FLAT');
    bars[220] = candle(220, 99.2, 101.2, 99, 100.4, 100);
    expect(replay('liquidity_sweep_mss', bars)[220]!.targetExposure).toBe('FLAT');
  });
  it('volume climax permits previous-bar volume, but requires extension, absorption, EMA and ADX filters', () => {
    const bars = scenario('vol_climax_reversal');
    bars[220] = candle(220, 100, 100.5, 98.5, 100, 100);
    bars[221] = candle(221, 100, 101.3, 99.8, 101.1, 10);
    expect(replay('vol_climax_reversal', bars)[220]!.targetExposure).toBe('FLAT');
    expect(replay('vol_climax_reversal', bars)[221]!.targetExposure).toBe('LONG');
    expect(replay('vol_climax_reversal', scenario('vol_climax_reversal'), { rvolClimax: 100 })[220]!.targetExposure).toBe('FLAT');
    expect(replay('vol_climax_reversal', scenario('vol_climax_reversal'), { adxMax: 0 })[220]!.targetExposure).toBe('FLAT');
  });
  it('squeeze uses prior bandwidths/50-bar quantile and respects rising-ADX and bullish-body rules', () => {
    const bars = scenario('bb_squeeze_adx'), bands = bollingerBands(bars.map(c => c.close));
    expect(bands.bandwidth[220]!).toBeGreaterThan(bands.bandwidth[219]!);
    expect(replay('bb_squeeze_adx', bars, { squeezeQ: 0 })[220]!.targetExposure).toBe('FLAT');
    const directional = adx(bars).adx;
    expect(replay('bb_squeeze_adx', bars, { adxMin: 0, adxRising: true })[220]!.targetExposure)
      .toBe(directional[220]! > directional[219]! ? 'LONG' : 'FLAT');
    bars[220] = candle(220, 111, 111.5, 109, 110, 100);
    expect(replay('bb_squeeze_adx', bars, { bodyRatio: 0 })[220]!.targetExposure).toBe('FLAT');
  });
});

describe('Research configuration and neutral holding', () => {
  it.each(ids)('%s defaults to holding zero, supports explicit overrides and supplies the same normalized gates/costs', id => {
    const config = parseBacktestConfig({ coin: 'ETH', strategy: id, gstRatePct: 18 });
    expect(config.holdSignalOnZero).toBe(true);
    expect(config).toMatchObject(Object.fromEntries(['use4hTrend100', 'use4hTrend200', 'costGateMult'].map(k => [k, FUTURES_STRATEGY_DEFAULTS[id][k as 'costGateMult']])));
    expect(strategyParameters(config)).toMatchObject({ rtCost: .00198, costGateMult: config.costGateMult });
    expect(parseBacktestConfig({ coin: 'ETH', strategy: id, holdSignalOnZero: false, use4hTrend100: false, use4hTrend200: false, costGateMult: 0 }))
      .toMatchObject({ holdSignalOnZero: false, use4hTrend100: false, use4hTrend200: false, costGateMult: 0 });
    const cli = parseBacktestArguments(['--coin', 'ETH', '--strategy', id]); expect(cli.holdSignalOnZero).toBe(true);
  });
  it('keeps legacy zero-signal behavior and parses all futures strategy CLI parameters', () => {
    expect(parseBacktestConfig({ coin: 'ETH' }).holdSignalOnZero).toBe(false);
    const parsed = parseBacktestArguments(['--strategy', 'bb_squeeze_adx', '--bb-period', '24', '--squeeze-q', '.5', '--no-adx-rising', '--no-use-4h-trend-200', '--cost-gate-mult', '0']);
    expect(parsed).toMatchObject({ parameters: { bbPeriod: 24, squeezeQ: .5, adxRising: false }, use4hTrend200: false, costGateMult: 0, holdSignalOnZero: true });
    expect(parseBacktestArguments(['--strategy', 'liquidity_sweep_mss', '--swing-lookback', '30', '--sweep-window', '4', '--no-hold-signal-on-zero']))
      .toMatchObject({ parameters: { swingLookback: 30, sweepWindow: 4 }, holdSignalOnZero: false });
  });
  it.each(ids)('%s holds its actual open trade on neutral bars rather than exiting the following close', async id => {
    const source = scenario(id), level = source[221]!.close;
    const bars = source.map((c, i) => record(i < 222 ? c : candle(i, level, level + .1, level - .1, level))), client = { getCandles: async () => [], getInrFuturesInstrument: async () => ({
      pair, kind: 'perpetual', quoteCurrency: 'USDT', marginCurrency: 'INR' as const, quantityIncrement: new Decimal('.01'), minQuantity: new Decimal('.01'),
      minTradeSize: new Decimal('.01'), minNotional: new Decimal(1), unitContractValue: new Decimal(1), priceIncrement: new Decimal('.01') }) };
    const runner = new PracticalBacktestRunner({ client, nowMs: () => start + 10 * 86400000 });
    const body = { coin: 'ETH', strategy: id, timeframe: '30m', bars: bars.length, parameters: parameters(id), capitalInr: 5000, maxOrderNotionalInr: 1000,
      inrPerUsdt: 100, use4hTrend100: false, use4hTrend200: false, costGateMult: 0, takerFeeBps: 0, slippageBps: 0, spreadBps: 0 };
    const hold = await runner.runOnCandles(body, bars), exit = await runner.runOnCandles({ ...body, holdSignalOnZero: false }, bars);
    expect(hold.trades).toHaveLength(1); expect(exit.trades).toHaveLength(1);
    expect(hold.trades[0]!.exitReason).toBe('END_OF_DATA'); expect(exit.trades[0]!.exitReason).toBe('SIGNAL_EXIT');
    expect(Date.parse(hold.trades[0]!.exitTimeIso)).toBeGreaterThan(Date.parse(exit.trades[0]!.exitTimeIso));
    expect(hold.liveLocked).toBe(true);
  });
  it('uses SMA seeds and exact EMA/Wilder recurrence, resetting warmup after unavailable data', () => {
    const input = [1, 2, 3, 6, null, 4, 4, 10, 1];
    const e = new CausalAverage(3, .5), r = new CausalAverage(3, 1 / 3);
    expect(input.map(v => e.update(v))).toEqual([null, null, 2, 4, null, null, null, 6, 3.5]);
    const wilder = input.map(v => r.update(v));
    expect(wilder.slice(0, 3)).toEqual([null, null, 2]); expect(wilder[3]).toBeCloseTo(10 / 3, 12);
    expect(wilder.slice(4, 8)).toEqual([null, null, null, 6]); expect(wilder[8]).toBeCloseTo(13 / 3, 12);
    // Anchor the Wilder warmup used by every kernel, including first TR unavailability.
    const values = atr(scenario('vol_climax_reversal'));
    expect(values[13]).toBeNull(); expect(values[14]).toBe(1);
  });
});
