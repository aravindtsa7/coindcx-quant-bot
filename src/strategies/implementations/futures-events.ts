import { BaseStrategyKernel, type StrategyOutcome } from '../core/kernel';
import { StrategyError, strategyParameterError } from '../core/errors';
import { StrategyCalcDecimal, normalizeCanonicalDecimalString } from '../core/decimal';
import { deepCopyFreeze } from '../core/immutable';
import { strategyPeriod, strategyTimeframe } from '../core/parameters';
import type { StrategyDefinition, StrategyEvaluationSnapshot, StrategyIndicatorBootstrapIdentityEntry } from '../core/types';
import { CausalAverage, bollingerBands, bandwidthPercentile, candleBodyRatio, costGate, donchian, rvol,
  type GateCandle, type IndicatorValue, type MacroGatePoint } from '../core/strategy-gates';

export const FUTURES_STRATEGY_DEFAULTS = deepCopyFreeze({
  liquidity_sweep_sfp: { swingLookback: 20, maxPierceAtr: 1.8, wickRatio: .38, rvolMin: 1.2, rsiPeriod: 14, rsiMaxLong: 60, rsiMinShort: 40,
    use4hTrend100: false, use4hTrend200: false, costGateMult: 0 },
  liquidity_sweep_mss: { swingLookback: 24, sweepWindow: 3, bodyRatio: .48, rvolMin: 1.2,
    use4hTrend100: false, use4hTrend200: false, costGateMult: 0 },
  vol_climax_reversal: { bbPeriod: 20, bbStd: 2, rvolClimax: 2.8, rsiPeriod: 14, rsiLongMax: 38, rsiShortMin: 62, wickRatio: .4, emaFilter: 200, adxMax: 45,
    use4hTrend100: true, use4hTrend200: false, costGateMult: 1.5 },
  bb_squeeze_adx: { bbPeriod: 20, bbStd: 2, squeezeQ: .6, squeezeLookback: 4, adxMin: 20, adxRising: true, volMult: 1.3, bodyRatio: .45, emaFilter: 50,
    use4hTrend100: false, use4hTrend200: true, costGateMult: 2 },
} as const);
export type FuturesStrategyId = keyof typeof FUTURES_STRATEGY_DEFAULTS;
export function isFuturesEventStrategy(id: unknown): id is FuturesStrategyId {
  return typeof id === 'string' && Object.hasOwn(FUTURES_STRATEGY_DEFAULTS, id);
}
/** Apply before object-schema defaults, retaining explicit false/zero overrides. */
export function withFuturesStrategyDefaults(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (!isFuturesEventStrategy(record.strategy)) return input;
  const defaults = FUTURES_STRATEGY_DEFAULTS[record.strategy];
  const parameters = record.parameters && typeof record.parameters === 'object' && !Array.isArray(record.parameters)
    ? record.parameters as Record<string, unknown> : {};
  return { ...record, holdSignalOnZero: record.holdSignalOnZero === undefined ? true : record.holdSignalOnZero,
    ...Object.fromEntries((['use4hTrend100', 'use4hTrend200', 'costGateMult'] as const).map(key => {
      if (record[key] !== undefined) return [key, record[key]];
      const value = parameters[key] === undefined ? defaults[key] : parameters[key];
      return [key, key === 'costGateMult' && typeof value === 'string' ? Number(value) : value];
    })) };
}
type Parameters = Readonly<Record<string, number | boolean | string>> & { readonly timeframeMinutes: number };
export interface FuturesResearchContext { readonly macroTrend?: MacroGatePoint | null }
interface Snapshot extends StrategyEvaluationSnapshot { readonly researchContext?: FuturesResearchContext }
const periods = new Set(['swingLookback', 'sweepWindow', 'rsiPeriod', 'bbPeriod', 'emaFilter', 'squeezeLookback']);
const ratios = new Set(['wickRatio', 'bodyRatio', 'squeezeQ']);
function normalize(id: FuturesStrategyId, raw: unknown): Parameters {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw strategyParameterError('Futures parameters must be a plain object');
  const defaults = { ...FUTURES_STRATEGY_DEFAULTS[id], rtCost: .0018, timeframeMinutes: 15 };
  const values = { ...defaults, ...raw as Record<string, unknown> };
  for (const [key, supplied] of Object.entries(values)) {
    const value = typeof supplied === 'string' && !periods.has(key) && key !== 'timeframeMinutes' ? Number(supplied) : supplied;
    if (!Object.hasOwn(defaults, key)) throw strategyParameterError(`Unknown ${id} parameter: ${key}`);
    if (typeof defaults[key as keyof typeof defaults] === 'boolean') {
      if (typeof value !== 'boolean') throw strategyParameterError(`${key} must be boolean`);
    } else {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw strategyParameterError(`${key} must be finite numeric`);
      if (key === 'timeframeMinutes') strategyTimeframe(value, key);
      else if (periods.has(key)) strategyPeriod(value, key);
      else if (key === 'costGateMult') { if (value < -100 || value > 1000) throw strategyParameterError('Invalid costGateMult'); }
      else if (value < 0 || (ratios.has(key) || key === 'rtCost') && value > 1
        || (key.startsWith('rsi') || key.startsWith('adx')) && value > 100
        || ['bbStd', 'maxPierceAtr'].includes(key) && value === 0) throw strategyParameterError(`Invalid ${key}`);
    }
  }
  // Strategy identity uses integer JSON numbers and canonical fixed-point strings for decimals.
  return deepCopyFreeze(Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
    typeof value === 'boolean' || periods.has(key) || key === 'timeframeMinutes' ? value
      : normalizeCanonicalDecimalString(new StrategyCalcDecimal(value as number | string).toFixed())]))) as Parameters;
}

interface Features { readonly candle: GateCandle; readonly atr: IndicatorValue; readonly rsi: IndicatorValue; readonly adx: IndicatorValue;
  readonly ema: IndicatorValue; readonly upper: IndicatorValue; readonly lower: IndicatorValue; readonly bbw: IndicatorValue; readonly rvol: IndicatorValue }
/** Bounded windows plus the foundation's SMA-seeded recurrence: no quadratic full-history recomputation. */
class FeaturesStream {
  readonly #atr = new CausalAverage(14, 1 / 14);
  readonly #plus = new CausalAverage(14, 1 / 14); readonly #minus = new CausalAverage(14, 1 / 14); readonly #adx = new CausalAverage(14, 1 / 14);
  readonly #gain: CausalAverage; readonly #loss: CausalAverage; readonly #ema: CausalAverage;
  #previous: GateCandle | null = null; readonly #window: GateCandle[] = [];
  public constructor(readonly p: Parameters) {
    const rsiPeriod = Number(p.rsiPeriod ?? 14), emaPeriod = Number(p.emaFilter ?? 1);
    this.#gain = new CausalAverage(rsiPeriod, 1 / rsiPeriod); this.#loss = new CausalAverage(rsiPeriod, 1 / rsiPeriod);
    this.#ema = new CausalAverage(emaPeriod, 2 / (emaPeriod + 1));
  }
  public update(c: GateCandle): Features {
    const prev = this.#previous;
    const atr = this.#atr.update(prev ? Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)) : null);
    const up = prev ? c.high - prev.high : 0, down = prev ? prev.low - c.low : 0;
    const plus = this.#plus.update(prev ? up > down && up > 0 ? up : 0 : null);
    const minus = this.#minus.update(prev ? down > up && down > 0 ? down : 0 : null);
    const sum = plus === null || minus === null ? null : plus + minus;
    const adx = this.#adx.update(atr === null || sum === null ? null : atr === 0 || sum === 0 ? 0 : 100 * Math.abs(plus! - minus!) / sum);
    const gain = this.#gain.update(prev ? Math.max(0, c.close - prev.close) : null);
    const loss = this.#loss.update(prev ? Math.max(0, prev.close - c.close) : null);
    const rsi = gain === null || loss === null ? null : loss === 0 ? gain === 0 ? 50 : 100 : 100 - 100 / (1 + gain / loss);
    const ema = this.#ema.update(c.close), n = Number(this.p.bbPeriod ?? 20);
    this.#window.push(c); if (this.#window.length > Math.max(n, 20)) this.#window.shift();
    const bands = bollingerBands(this.#window.map(v => v.close), n, Number(this.p.bbStd ?? 2));
    const volume = rvol(this.#window, 20).at(-1) ?? null;
    this.#previous = c;
    return { candle: c, atr, rsi, adx, ema, upper: bands.upper.at(-1) ?? null, lower: bands.lower.at(-1) ?? null, bbw: bands.bandwidth.at(-1) ?? null, rvol: volume };
  }
}
const number = (value: IndicatorValue): value is number => value !== null && Number.isFinite(value);
const range = (c: GateCandle) => Math.max(c.high - c.low, 1e-12);
const lowerWick = (c: GateCandle) => (Math.min(c.open, c.close) - c.low) / range(c);
const upperWick = (c: GateCandle) => (c.high - Math.max(c.open, c.close)) / range(c);

export class FuturesEventStrategyKernel extends BaseStrategyKernel {
  readonly #stream: FeaturesStream; readonly #history: GateCandle[] = []; readonly #widths: IndicatorValue[] = [];
  #previous: Features | null = null; #longEligible = false; #shortEligible = false;
  public constructor(readonly id: FuturesStrategyId, readonly p: Parameters, pair: string, bootstrap: readonly StrategyIndicatorBootstrapIdentityEntry[]) {
    super({ pair, strategyId: id.toUpperCase(), strategyVersion: '1.0.0', normalizedParameters: p, triggerTimeframeMinutes: p.timeframeMinutes,
      indicatorBootstrapIdentity: bootstrap, indicatorRequirements: [] });
    this.#stream = new FeaturesStream(p);
  }
  protected evaluateValidated(snapshot: Snapshot): StrategyOutcome {
    const raw = snapshot.triggerClosedCandle;
    const c: GateCandle = { openTimeMs: raw.openTimeMs, closeTimeMs: raw.closeTimeExclusiveMs,
      open: Number(raw.open), high: Number(raw.high), low: Number(raw.low), close: Number(raw.close), volume: Number(raw.volume) };
    if (![c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) || c.low <= 0 || c.volume < 0
      || c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close)) throw strategyParameterError('Invalid futures candle');
    if (this.#previous && this.#previous.candle.closeTimeMs !== c.openTimeMs) throw strategyParameterError('Futures candles must be contiguous');
    const f = this.#stream.update(c), prev = this.#previous, p = this.p;
    let long = false, short = false, ready = false;
    if (this.id === 'liquidity_sweep_sfp' || this.id === 'liquidity_sweep_mss') {
      const n = Number(p.swingLookback), shift = this.id === 'liquidity_sweep_mss' ? 1 : 0;
      const prior = this.#history.slice(0, this.#history.length - shift);
      // Append current only to make the foundation's exclusive-current Donchian window explicit.
      const swings = donchian([...prior, c], n), low = swings.lower.at(-1) ?? null, high = swings.upper.at(-1) ?? null;
      ready = number(low) && number(high) && number(f.rvol) && (this.id === 'liquidity_sweep_mss' || number(f.rsi) && number(f.atr));
      if (ready && low !== null && high !== null && f.rvol! >= Number(p.rvolMin)) {
        if (this.id === 'liquidity_sweep_sfp') {
          long = c.low < low && low - c.low <= Number(p.maxPierceAtr) * f.atr! && c.close > low && lowerWick(c) >= Number(p.wickRatio) && f.rsi! <= Number(p.rsiMaxLong);
          short = c.high > high && c.high - high <= Number(p.maxPierceAtr) * f.atr! && c.close < high && upperWick(c) >= Number(p.wickRatio) && f.rsi! >= Number(p.rsiMinShort);
        } else if (prev) {
          const sweep = [...this.#history, c].slice(-Number(p.sweepWindow));
          long = sweep.length === p.sweepWindow && Math.min(...sweep.map(v => v.low)) < low && c.close > c.open && c.close > low && c.close > prev.candle.high && candleBodyRatio(c) >= Number(p.bodyRatio);
          short = sweep.length === p.sweepWindow && Math.max(...sweep.map(v => v.high)) > high && c.close < c.open && c.close < high && c.close < prev.candle.low && candleBodyRatio(c) >= Number(p.bodyRatio);
        }
      }
    } else if (this.id === 'vol_climax_reversal') {
      ready = [f.upper, f.lower, f.rvol, f.rsi, f.ema, f.adx].every(number);
      const climax = f.rvol !== null && f.rvol >= Number(p.rvolClimax) || prev?.rvol != null && prev.rvol >= Number(p.rvolClimax);
      if (ready && climax && f.adx! <= Number(p.adxMax)) {
        const bullish = c.close > c.open, bearish = c.close < c.open;
        long = (c.low <= f.lower! * 1.002 || prev?.lower != null && prev.candle.low <= prev.lower * 1.002 || f.rsi! <= Number(p.rsiLongMax))
          && (lowerWick(c) >= Number(p.wickRatio) && c.close > f.lower! || bullish && c.close >= c.low + .55 * range(c) || !!prev && lowerWick(prev.candle) >= Number(p.wickRatio) && bullish)
          && c.close > f.ema!;
        short = (c.high >= f.upper! * .998 || prev?.upper != null && prev.candle.high >= prev.upper * .998 || f.rsi! >= Number(p.rsiShortMin))
          && (upperWick(c) >= Number(p.wickRatio) && c.close < f.upper! || bearish && c.close <= c.low + .45 * range(c) || !!prev && upperWick(prev.candle) >= Number(p.wickRatio) && bearish)
          && c.close < f.ema!;
      }
    } else {
      const threshold = bandwidthPercentile(this.#widths, 50, Number(p.squeezeQ)).at(-1) ?? null;
      const recent = this.#widths.slice(-Number(p.squeezeLookback));
      ready = [f.upper, f.lower, f.bbw, f.ema, f.adx, f.rvol, threshold].every(number) && recent.length === p.squeezeLookback && recent.every(number);
      const squeeze = ready && Math.min(...recent as number[]) < threshold! && f.bbw! > prev!.bbw!;
      if (squeeze && f.adx! >= Number(p.adxMin) && (!p.adxRising || prev?.adx != null && f.adx! > prev.adx)
        && f.rvol! >= Number(p.volMult) && candleBodyRatio(c) >= Number(p.bodyRatio)) {
        long = c.close > f.upper! && c.close > f.ema! && c.close > c.open;
        short = c.close < f.lower! && c.close < f.ema! && c.close < c.open;
      }
    }
    const macro = snapshot.researchContext?.macroTrend;
    if (macro?.sourceCloseTimeMs != null && macro.sourceCloseTimeMs > c.closeTimeMs) throw new StrategyError('STRATEGY_INPUT_FUTURE_DATA', 'Macro candle must be closed at strategy evaluation');
    const gate = (side: 'LONG' | 'SHORT'): boolean => {
      if (!costGate(f.atr, c.close, Number(p.costGateMult), Number(p.rtCost))) return false;
      if (!p.use4hTrend100 && !p.use4hTrend200) return true;
      if (macro?.sourceCloseTimeMs == null || !number(macro.close4h)) return false;
      const above = (a: number, b: number) => side === 'LONG' ? a > b : a < b;
      return (!p.use4hTrend100 || number(macro.ema100) && above(macro.close4h, macro.ema100))
        && (!p.use4hTrend200 || number(macro.ema200) && number(macro.ema50) && above(macro.close4h, macro.ema200) && above(macro.ema50, macro.ema200));
    };
    // Eligibility includes gates BEFORE edge detection, independently for each direction.
    long = long && gate('LONG'); short = short && gate('SHORT');
    const longEvent = long && !this.#longEligible, shortEvent = short && !this.#shortEligible;
    const target = longEvent && !shortEvent ? 'LONG' : shortEvent && !longEvent ? 'SHORT' : 'FLAT';
    return { status: ready ? 'READY' : 'WARMING', targetExposure: ready ? target : null,
      reasonCodes: [ready ? target === 'FLAT' ? 'NO_TRANSITION' : `${this.id.toUpperCase()}_${target}_TRANSITION` : 'FUTURES_INDICATORS_WARMING'],
      commit: () => {
        this.#longEligible = long; this.#shortEligible = short; this.#previous = f;
        this.#history.push(c); if (this.#history.length > Math.max(Number(p.swingLookback ?? 1) + 1, Number(p.sweepWindow ?? 1))) this.#history.shift();
        this.#widths.push(f.bbw); if (this.#widths.length > Math.max(50, Number(p.squeezeLookback ?? 1))) this.#widths.shift();
      } };
  }
}
function definition(id: FuturesStrategyId): StrategyDefinition<Parameters> {
  return Object.freeze({ strategyId: id.toUpperCase(), strategyVersion: '1.0.0', normalizeParameters: (raw: unknown) => normalize(id, raw),
    describeConstruction: (raw: unknown) => deepCopyFreeze({ normalizedParameters: normalize(id, raw), triggerTimeframeMinutes: normalize(id, raw).timeframeMinutes, indicatorRequirements: [] }),
    createKernel: (config: { pair: string; parameters: unknown; indicatorBootstrapIdentity: readonly StrategyIndicatorBootstrapIdentityEntry[] }) =>
      new FuturesEventStrategyKernel(id, normalize(id, config.parameters), config.pair, config.indicatorBootstrapIdentity) });
}
export const FUTURES_STRATEGY_DEFINITIONS = Object.freeze(Object.fromEntries((Object.keys(FUTURES_STRATEGY_DEFAULTS) as FuturesStrategyId[]).map(id => [id, definition(id)])) as Record<FuturesStrategyId, StrategyDefinition<Parameters>>);
