import { z } from 'zod';
import path from 'node:path';
import { HistoricalMinuteArchive, resolveHistoryWindow, aggregateMinutes, missingMinuteRanges } from '../../../market-data/historical-minute-archive';
import { Decimal } from '../../../core/decimal/decimal';
import { toIndicatorCalcDecimal } from '../../../indicators/decimal/indicator-calc-decimal';
import type { RestCandleRecord, HistoricalCandleQuery, HistoricalResolution } from '../../../market-data/rest-candle-reader';
import { sha256CanonicalJson } from '../../../risk/canonical';
import type { IndicatorPoint } from '../../../indicators/types';
import { atrBreakoutV1Definition, emaTrendV1Definition, rsiMomentumV1Definition, multiTimeframeTrendV1Definition, createStrategyIndicatorBindings, StrategyReadonlyMap,
  supertrendV1Definition, vwapMeanReversionV1Definition,
  type StrategyCandleSnapshot, type StrategyDecision, type StrategyKernel, type StrategyIndicatorBinding } from '../../../strategies';
import type { InrFuturesInstrument } from '../models';
import { atr as wilderAtr, costGate, macroTrendGates, type GateCandle } from './strategy-gates';
import { FUTURES_STRATEGY_DEFINITIONS, isFuturesEventStrategy, withFuturesStrategyDefaults, type FuturesResearchContext } from './futures-strategies';
export { withFuturesStrategyDefaults } from './futures-strategies';

export const backtestConfigSchema = z.object({
  coin: z.string().regex(/^[A-Z0-9]{1,24}$/),
  timeframe: z.enum(['1m', '3m', '5m', '15m', '30m', '45m', '1h', '2h', '4h']).default('15m'),
  strategy: z.enum(['ema-trend', 'rsi-momentum', 'atr-breakout', 'multi-timeframe-trend', 'supertrend', 'vwap-mean-reversion', 'liquidity_sweep_sfp', 'liquidity_sweep_mss', 'vol_climax_reversal', 'bb_squeeze_adx']).default('ema-trend'),
  parameters: z.record(z.unknown()).default({}),
  bars: z.number().int().min(30).max(1000).default(300),
  days: z.number().int().min(1).max(365).optional(),
  fromDate: z.string().max(40).optional(),
  toDate: z.string().max(40).optional(),
  fromMs: z.number().int().positive().safe().optional(),
  toMs: z.number().int().positive().safe().optional(),
  capitalInr: z.number().finite().positive().max(1_000_000_000).default(5000),
  maxOrderNotionalInr: z.number().finite().positive().max(1_000_000_000).default(700),
  leverage: z.number().int().min(1).max(20).default(3),
  marginMode: z.literal('ISOLATED').default('ISOLATED'),
  maintenanceMarginRateBps: z.number().finite().min(0).max(1000).default(50),
  liquidationFeeBps: z.number().finite().min(0).max(1000).default(100),
  trailingStopPct: z.number().finite().min(0).lt(100).default(0),
  trailingActivationPct: z.number().finite().min(0).max(1000).default(0),
  slAtrMult: z.number().finite().positive().max(100).default(2),
  slMinPct: z.number().finite().positive().lt(100).default(.8),
  slMaxPct: z.number().finite().positive().lt(100).default(4),
  tpAtrMult: z.number().finite().positive().max(100).default(3),
  tpRrMultiple: z.number().finite().positive().max(100).default(2),
  trailingAtrMult: z.number().finite().min(0).max(100).default(0),
  breakevenAt1R: z.boolean().default(false),
  sizingMode: z.enum(['FIXED_NOTIONAL', 'RISK_PERCENT']).default('FIXED_NOTIONAL'),
  riskPerTradePct: z.number().finite().positive().max(100).default(2),
  gstRatePct: z.number().finite().min(0).max(100).default(0),
  cooldownBars: z.number().int().min(0).max(1000).default(0),
  exitOnOppositeSignal: z.boolean().default(true),
  holdSignalOnZero: z.boolean().default(false),
  use4hTrend200: z.boolean().default(false),
  use4hTrend100: z.boolean().default(false),
  costGateMult: z.number().finite().min(-100).max(1000).default(0),
  rtCost: z.number().finite().min(0).max(1).optional(),
  // Optional here so object-schema API compositions preserve whether the caller supplied a rate.
  fundingMode: z.enum(['EXCLUDED', 'MODELED_FIXED_BPS']).optional(),
  fundingRateBpsPer8h: z.number().finite().min(-100).max(100).optional(),
  makerFeeBps: z.number().finite().min(0).max(100).default(2),
  takerFeeBps: z.number().finite().min(0).max(100).default(5),
  slippageBps: z.number().finite().min(0).max(100).default(2),
  spreadBps: z.number().finite().min(0).max(100).default(1),
  stopSlippageBps: z.number().finite().min(0).max(100).default(5),
  stopLossMode: z.enum(['NONE', 'PERCENT', 'INR', 'ATR']).default('NONE'),
  stopLossValue: z.number().finite().nonnegative().max(1_000_000_000).default(0),
  takeProfitMode: z.enum(['NONE', 'PERCENT', 'INR', 'ATR', 'RR_MULTIPLE']).default('NONE'),
  takeProfitValue: z.number().finite().nonnegative().max(1_000_000_000).default(0),
  fillLiquidity: z.enum(['MAKER', 'TAKER']).default('TAKER'),
  inrPerUsdt: z.number().finite().positive().max(10000).optional(),
  endTimeMs: z.number().int().positive().max(8_640_000_000_000_000).optional(),
}).strict();
export type PracticalBacktestConfig = z.infer<typeof backtestConfigSchema>;
export const futuresConfigSchema = backtestConfigSchema.pick({ leverage: true, marginMode: true, maintenanceMarginRateBps: true, liquidationFeeBps: true,
  trailingStopPct: true, trailingActivationPct: true, fundingMode: true, fundingRateBpsPer8h: true,
  slAtrMult: true, slMinPct: true, slMaxPct: true, tpAtrMult: true, tpRrMultiple: true, trailingAtrMult: true, breakevenAt1R: true,
  sizingMode: true, riskPerTradePct: true, gstRatePct: true, cooldownBars: true, exitOnOppositeSignal: true, holdSignalOnZero: true,
  use4hTrend200: true, use4hTrend100: true, costGateMult: true, rtCost: true });
export function parseBacktestConfig(input: unknown): PracticalBacktestConfig {
  const config = backtestConfigSchema.parse(withFuturesStrategyDefaults(input));
  config.fundingMode ??= config.fundingRateBpsPer8h === undefined ? 'EXCLUDED' : 'MODELED_FIXED_BPS';
  config.fundingRateBpsPer8h ??= 1;
  if (config.maintenanceMarginRateBps >= 10000 / config.leverage) throw new z.ZodError([{ code: 'custom', path: ['maintenanceMarginRateBps'], message: 'Maintenance margin must be below initial margin at the selected leverage.' }]);
  for (const [mode, value, field] of [[config.stopLossMode, config.stopLossValue, 'stopLossValue'], [config.takeProfitMode, config.takeProfitValue, 'takeProfitValue']] as const) {
    if (['PERCENT', 'INR'].includes(mode) && (value <= 0 || (mode === 'PERCENT' && value >= 100))) {
      throw new z.ZodError([{ code: 'custom', path: [field], message: 'Enabled protection requires a positive value; percent must be below 100.' }]);
    }
  }
  if (config.slMinPct > config.slMaxPct || (config.takeProfitMode === 'RR_MULTIPLE' || config.sizingMode === 'RISK_PERCENT') && config.stopLossMode === 'NONE') {
    throw new z.ZodError([{ code: 'custom', path: ['stopLossMode'], message: 'Risk sizing and R:R targets require a stop; ATR minimum must not exceed maximum.' }]);
  }
  return config;
}
export type BacktestInstrumentSource = Pick<InrFuturesInstrument, 'pair' | 'kind' | 'quoteCurrency' | 'marginCurrency' | 'quantityIncrement' | 'minQuantity' | 'minTradeSize' | 'minNotional' | 'unitContractValue'> & Partial<Pick<InrFuturesInstrument, 'priceIncrement'>>;
export interface PracticalHistoricalClient { getCandles(query: HistoricalCandleQuery): Promise<readonly RestCandleRecord[]>;
  getInrFuturesInstrument?(pair: string): Promise<BacktestInstrumentSource> }
export interface VirtualContract { readonly quantityIncrement: string; readonly minQuantity: string; readonly minNotionalInr: string; readonly contractMultiplier: string; readonly tickSize?: string }
export function virtualContract(instrument: BacktestInstrumentSource, rate: number): VirtualContract {
  if ([instrument.quantityIncrement, instrument.unitContractValue, instrument.minNotional, instrument.minQuantity, instrument.minTradeSize].some(v => !v.isFinite() || v.lt(0))
    || instrument.marginCurrency !== 'INR' || instrument.quoteCurrency !== 'USDT' || instrument.kind.toLowerCase() !== 'perpetual'
    || !instrument.quantityIncrement.gt(0) || !instrument.unitContractValue.gt(0) || !instrument.minNotional.gt(0)) throw new Error('INVALID_INSTRUMENT_METADATA');
  return { quantityIncrement: instrument.quantityIncrement.toFixed(), minQuantity: Decimal.max(instrument.minQuantity, instrument.minTradeSize).toFixed(),
    minNotionalInr: instrument.minNotional.times(rate).toFixed(), contractMultiplier: instrument.unitContractValue.toFixed(),
    ...(instrument.priceIncrement?.gt(0) ? { tickSize: instrument.priceIncrement.toFixed() } : {}) };
}
export function roundTripCostFraction(config: PracticalBacktestConfig): number {
  return config.rtCost ?? 2 * (config.fillLiquidity === 'MAKER' ? config.makerFeeBps : config.takerFeeBps) / 10000 * (1 + config.gstRatePct / 100)
    + (config.slippageBps + config.stopSlippageBps + config.spreadBps) / 10000;
}
export function strategyParameters(config: PracticalBacktestConfig): Readonly<Record<string, unknown>> {
  return isFuturesEventStrategy(config.strategy) ? { ...config.parameters, use4hTrend100: config.use4hTrend100,
    use4hTrend200: config.use4hTrend200, costGateMult: config.costGateMult, rtCost: roundTripCostFraction(config) } : config.parameters;
}
export function fundingLabel(config: PracticalBacktestConfig): string {
  const mode = config.fundingMode ?? (config.fundingRateBpsPer8h === undefined ? 'EXCLUDED' : 'MODELED_FIXED_BPS');
  return mode === 'MODELED_FIXED_BPS' ? `Modeled @ ${config.fundingRateBpsPer8h ?? 1} bps/8h` : 'Excluded';
}
export interface ChartCandle { readonly timeMs: number; readonly open: number; readonly high: number; readonly low: number; readonly close: number; readonly volume: number }
export interface PracticalBacktestTrade {
  readonly tradeId: string; readonly side: 'LONG' | 'SHORT'; readonly entryTimeIso: string; readonly entryPrice: number;
  readonly exitTimeIso: string; readonly exitPrice: number; readonly quantity: number; readonly grossPnlInr: number;
  readonly feeInr: number; readonly netPnlInr: number; readonly exitReason: 'SIGNAL_FLAT' | 'SIGNAL_REVERSAL' | 'SIGNAL_EXIT' | 'TARGET_CHANGE' | 'STOP_LOSS' | 'TRAILING_STOP' | 'TAKE_PROFIT' | 'LIQUIDATION' | 'BREAKEVEN' | 'END_OF_DATA';
  readonly gstInr?: number | undefined;
  readonly leverage: number; readonly marginUsedInr: number; readonly liquidationPrice: number | null; readonly fundingInr: number; readonly marginRoiPct: number;
  readonly events: readonly PracticalTradeEvent[];
}
export interface PracticalTradeEvent {
  readonly type: 'DECISION_RECORDED' | 'ENTRY_FILL' | 'SL_TP_ARMED' | 'TRAILING_STOP_UPDATED' | 'BREAKEVEN_ARMED' | 'FUNDING_SETTLEMENT' | 'EXIT_FILL';
  readonly timestampMs: number; readonly details: Readonly<Record<string, string | number | null>>;
}
export interface PracticalBacktestReport {
  readonly runId: string; readonly mode: 'BACKTEST'; readonly pair: string; readonly config: PracticalBacktestConfig;
  readonly completedAtIso: string; readonly sizingMode: 'BOUNDED_RESEARCH'; readonly assumptions: readonly string[];
  readonly conversion: { readonly inrPerUsdt: number; readonly source: 'OPERATOR_FIXED' | 'CURRENT_PROVIDER_SNAPSHOT' };
  readonly instrument: VirtualContract; readonly totalFundingInr: number; readonly fundingLabel: string; readonly liveLocked: true; readonly protectionMode: '1M' | 'HTF';
  readonly diagnostics: { readonly SKIPPED_MIN_NOTIONAL: number; readonly INSUFFICIENT_MARGIN: number };
  readonly summary: { readonly netPnlInr: number; readonly grossPnlInr: number; readonly totalFeesInr: number; readonly winRatePct: number;
    readonly profitFactor: number | null; readonly maxDrawdownPct: number; readonly totalTrades: number; readonly fundingNote: string;
    readonly totalFundingInr: number; readonly liquidationCount: number; readonly skippedMinNotionalCount: number;
    readonly avgMarginRoiPct: number; readonly effectiveLeverage: number; readonly fundingLabel: string;
    readonly gstInr: number; readonly breakevenExitCount: number; readonly ambiguousCandleCount: number; readonly protectionMode: '1M' | 'HTF' };
  readonly equityCurve: readonly { readonly timestampMs: number; readonly equityInr: number; readonly drawdownPct: number }[];
  readonly candles: readonly ChartCandle[]; readonly trades: readonly PracticalBacktestTrade[];
}
export const timeframeResolution = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '45m': '45', '1h': '60', '2h': '120', '4h': '240' } as const;
export type BacktestResolution = typeof timeframeResolution[keyof typeof timeframeResolution];
export const researchPair = (coin: string): string => `B-${coin}_USDT`;
const numeric = (value: Decimal): number => value.toDecimalPlaces(10).toNumber();
const candleIdentity = (c: RestCandleRecord) => [c.pair, c.openTimeMs, c.open.toFixed(), c.high.toFixed(), c.low.toFixed(), c.close.toFixed(), c.volume.toFixed()];

/** Real Phase 10 kernels and indicator bindings, evaluated once per closed bar. */
export class HistoricalStrategySession {
  readonly kernel: StrategyKernel;
  readonly #bindings: readonly StrategyIndicatorBinding[];
  readonly #latest = new Map<number, StrategyCandleSnapshot>();
  readonly #points = new Map<string, IndicatorPoint<unknown>>();
  readonly #buffers = new Map<number, RestCandleRecord[]>();
  public constructor(pair: string, strategy: PracticalBacktestConfig['strategy'], minutes: number, firstOpenMs: number, overrides: Readonly<Record<string, unknown>> = {}) {
    const definition = isFuturesEventStrategy(strategy) ? FUTURES_STRATEGY_DEFINITIONS[strategy] : strategy === 'ema-trend' ? emaTrendV1Definition : strategy === 'rsi-momentum' ? rsiMomentumV1Definition
      : strategy === 'supertrend' ? supertrendV1Definition : strategy === 'vwap-mean-reversion' ? vwapMeanReversionV1Definition
      : strategy === 'multi-timeframe-trend' ? multiTimeframeTrendV1Definition : atrBreakoutV1Definition;
    const parameters = isFuturesEventStrategy(strategy) ? { timeframeMinutes: minutes } : strategy === 'ema-trend' ? { timeframeMinutes: minutes, fastPeriod: 9, slowPeriod: 21, priceSource: 'CLOSE' }
      : strategy === 'supertrend' ? { timeframeMinutes: minutes, atrPeriod: 10, multiplier: '3' }
        : strategy === 'vwap-mean-reversion' ? { timeframeMinutes: minutes, vwapPeriod: 24, bandStdDev: '2' }
      : strategy === 'rsi-momentum' ? { timeframeMinutes: minutes, period: 14, longThreshold: '55', shortThreshold: '45', priceSource: 'CLOSE' }
        : strategy === 'multi-timeframe-trend' ? { timeframes: [minutes, minutes * 4], fastPeriod: 9, slowPeriod: 21, priceSource: 'CLOSE' }
          : { timeframeMinutes: minutes, atrPeriod: 14, breakoutMultiplier: '1.5' };
    const merged = { ...parameters, ...overrides };
    const description = definition.describeConstruction(merged);
    if (description.triggerTimeframeMinutes !== minutes || description.indicatorRequirements.some(r => r.timeframeMinutes % minutes !== 0)) throw new Error('INVALID_STRATEGY_TIMEFRAMES');
    const timeframes = [...new Set(description.indicatorRequirements.map(r => r.timeframeMinutes))];
    this.kernel = definition.createKernel({ pair, parameters: merged, indicatorBootstrapIdentity: timeframes.map(timeframeMinutes => ({ timeframeMinutes,
      bootstrapStartOpenTimeMs: Math.ceil(firstOpenMs / (timeframeMinutes * 60_000)) * timeframeMinutes * 60_000 })) });
    this.#bindings = createStrategyIndicatorBindings(this.kernel);
  }
  public update(record: RestCandleRecord, researchContext?: FuturesResearchContext): { decision: StrategyDecision | null; indicators: Readonly<Record<string, unknown>> } {
    const minutes = this.kernel.triggerTimeframeMinutes, closeTime = record.openTimeMs + minutes * 60_000;
    const closed: StrategyCandleSnapshot[] = [];
    for (const origin of this.kernel.indicatorBootstrapIdentity) {
      const timeframeMinutes = origin.timeframeMinutes, duration = timeframeMinutes * 60_000;
      if (record.openTimeMs < origin.bootstrapStartOpenTimeMs) continue;
      const buffer = this.#buffers.get(timeframeMinutes) ?? []; buffer.push(record); this.#buffers.set(timeframeMinutes, buffer);
      if (closeTime % duration !== 0) continue;
      if (buffer.length !== timeframeMinutes / minutes || buffer[0]!.openTimeMs !== closeTime - duration) throw new Error('CANDLE_GAP');
      const candle: StrategyCandleSnapshot = { pair: record.pair, timeframeMinutes, openTimeMs: buffer[0]!.openTimeMs,
        closeTimeExclusiveMs: closeTime, open: buffer[0]!.open.toFixed(), high: Decimal.max(...buffer.map(c => c.high)).toFixed(),
        low: Decimal.min(...buffer.map(c => c.low)).toFixed(), close: record.close.toFixed(),
        volume: buffer.reduce((sum, c) => sum.plus(c.volume), new Decimal(0)).toFixed(), quoteVolume: null };
      this.#buffers.set(timeframeMinutes, []); this.#latest.set(timeframeMinutes, candle); closed.push(candle);
      const input = { ...candle, open: toIndicatorCalcDecimal(candle.open), high: toIndicatorCalcDecimal(candle.high),
      low: toIndicatorCalcDecimal(candle.low), close: toIndicatorCalcDecimal(candle.close), volume: toIndicatorCalcDecimal(candle.volume),
      quoteVolume: candle.quoteVolume === null ? null : toIndicatorCalcDecimal(candle.quoteVolume) };
      for (const binding of this.#bindings.filter(b => b.requirement.timeframeMinutes === timeframeMinutes)) this.#points.set(binding.alias, binding.kernel.update(input));
    }
    if (!this.kernel.indicatorRequirements.length) {
      const candle: StrategyCandleSnapshot = { pair: record.pair, timeframeMinutes: minutes, openTimeMs: record.openTimeMs,
        closeTimeExclusiveMs: closeTime, open: record.open.toFixed(), high: record.high.toFixed(), low: record.low.toFixed(),
        close: record.close.toFixed(), volume: record.volume.toFixed(), quoteVolume: null };
      this.#latest.set(minutes, candle); closed.push(candle);
    }
    const trigger = this.#latest.get(minutes);
    const decision = this.#points.size !== this.#bindings.length || !trigger ? null : this.kernel.evaluate({ pair: record.pair,
      evaluationTimeMs: closeTime, triggerClosedCandle: trigger, latestClosedCandleByTimeframe: new StrategyReadonlyMap(this.#latest),
      candlesClosedAtThisTimestamp: closed, latestIndicatorPointByAlias: new StrategyReadonlyMap(this.#points), ...(researchContext ? { researchContext } : {}) });
    return { decision, indicators: Object.fromEntries([...this.#points].map(([alias, point]) => [alias, point.value])) };
  }
}

export function toChartCandle(record: RestCandleRecord): ChartCandle {
  return { timeMs: record.openTimeMs, open: record.open.toNumber(), high: record.high.toNumber(), low: record.low.toNumber(), close: record.close.toNumber(), volume: record.volume.toNumber() };
}

/** Validate a closed chronological grid independently of provider-native timeframe support. */
function verifiedCandles(records: readonly RestCandleRecord[], pair: string, step: number, from: number, to: number, allowGaps = false): readonly RestCandleRecord[] {
  const unique = new Map<number, RestCandleRecord>();
  for (const bar of records) {
    if (bar.pair !== pair || !Number.isSafeInteger(bar.openTimeMs) || bar.openTimeMs % step !== 0) throw new Error('INVALID_CANDLE');
    if (bar.openTimeMs < from || bar.openTimeMs + step > to) continue;
    if ([bar.open, bar.high, bar.low, bar.close].some(p => !p.isFinite() || !p.gt(0)) || !bar.volume.isFinite() || bar.volume.lt(0)
      || bar.high.lt(Decimal.max(bar.open, bar.close, bar.low)) || bar.low.gt(Decimal.min(bar.open, bar.close))) throw new Error('INVALID_CANDLE');
    const old = unique.get(bar.openTimeMs);
    if (old && sha256CanonicalJson(candleIdentity(old)) !== sha256CanonicalJson(candleIdentity(bar))) throw new Error('CONFLICTING_CANDLE');
    unique.set(bar.openTimeMs, bar);
  }
  const sorted = [...unique.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
  if (!allowGaps && (sorted.length !== (to - from) / step || sorted.some((bar, i) => bar.openTimeMs !== from + i * step))) throw new Error('INCOMPLETE_CANDLE_HISTORY');
  return sorted;
}
/** Non-native strategy intervals are aggregated from public 1m reads, never sent as unsupported provider resolutions. */
export async function fetchHistoricalCandles(client: PracticalHistoricalClient, input: {
  pair: string; resolution: BacktestResolution; bars: number; endTimeMs: number; signal?: AbortSignal | undefined; allowGaps?: boolean;
}): Promise<readonly RestCandleRecord[]> {
  const step = Number(input.resolution) * 60_000;
  if (!/^B-[A-Z0-9]+_USDT$/.test(input.pair) || !Object.values(timeframeResolution).includes(input.resolution)
    || !Number.isInteger(input.bars) || input.bars < 1 || input.bars > 1000 || !Number.isSafeInteger(input.endTimeMs)) throw new Error('INVALID_CANDLE_QUERY');
  const end = Math.floor(input.endTimeMs / step) * step, start = end - input.bars * step;
  if (start <= 0) throw new Error('INVALID_CANDLE_QUERY');
  const native = ['1', '5', '15', '60'].includes(input.resolution), sourceStep = native ? step : 60_000, source: RestCandleRecord[] = [];
  for (let cursor = start; cursor < end; cursor += (native ? 200 : 1000) * sourceStep) {
    input.signal?.throwIfAborted();
    source.push(...await client.getCandles({ pair: input.pair, from: cursor, to: Math.min(end, cursor + (native ? 200 : 1000) * sourceStep) - 1,
      resolution: native ? input.resolution as HistoricalResolution : '1' }));
  }
  input.signal?.throwIfAborted();
  const verified = verifiedCandles(source, input.pair, sourceStep, start, end, input.allowGaps);
  return native ? verified : aggregateMinutes(verified, Number(input.resolution), { fromMs: start, toMs: end });
}
const gateCandle = (c: RestCandleRecord, minutes: number): GateCandle => ({ openTimeMs: c.openTimeMs, closeTimeMs: c.openTimeMs + minutes * 60_000,
  open: c.open.toNumber(), high: c.high.toNumber(), low: c.low.toNumber(), close: c.close.toNumber(), volume: c.volume.toNumber() });

export interface VirtualPosition {
  side: 'LONG' | 'SHORT'; entryPrice: string; quantity: string; contractMultiplier: string; entryFeeInr: string;
  entryTimeMs: number; stopPrice: string | null; takeProfitPrice: string | null; events: PracticalTradeEvent[];
  leverage: number; marginUsedInr: string; liquidationPrice: string | null; fundingInr: string; lastFundingTimeMs: number;
  peakFavorablePrice: string; trailingStopPrice: string | null;
  entryGstInr: string; originalSlDistance: string | null; signalAtrPrice: string | null;
  breakevenStopPrice: string | null; breakevenArmed: boolean;
}
const positionFields = ['leverage', 'marginUsedInr', 'liquidationPrice', 'fundingInr', 'lastFundingTimeMs', 'peakFavorablePrice', 'trailingStopPrice',
  'entryGstInr', 'originalSlDistance', 'signalAtrPrice', 'breakevenStopPrice', 'breakevenArmed'] as const;
type OptionalFields<T, K extends keyof T> = { [P in K]?: T[P] | undefined };
type CompatiblePosition = Omit<VirtualPosition, typeof positionFields[number]> & OptionalFields<VirtualPosition, typeof positionFields[number]>;
type FuturesTradeField = 'leverage' | 'marginUsedInr' | 'liquidationPrice' | 'fundingInr' | 'marginRoiPct';
type CompatibleTrade = Omit<PracticalBacktestTrade, FuturesTradeField> & OptionalFields<PracticalBacktestTrade, FuturesTradeField>;
export interface VirtualBookInput { cashInr: string; position: CompatiblePosition | null; trades: CompatibleTrade[];
  nextEntryTimeMs?: number | undefined;
  diagnostics?: { skippedMinNotionalCount: number; skippedInsufficientMarginCount: number;
    ambiguousCandleCount?: number | undefined; skippedAtrWarmupCount?: number | undefined; skippedCooldownCount?: number | undefined; skippedRiskBudgetCount?: number | undefined } | undefined }
export interface VirtualBookState { cashInr: string; position: VirtualPosition | null; trades: PracticalBacktestTrade[];
  nextEntryTimeMs: number;
  diagnostics: { skippedMinNotionalCount: number; skippedInsufficientMarginCount: number;
    ambiguousCandleCount: number; skippedAtrWarmupCount: number; skippedCooldownCount: number; skippedRiskBudgetCount: number } }
export function protectivePrices(config: PracticalBacktestConfig, entry: Decimal, notionalInr: Decimal, side: 'LONG' | 'SHORT', signalAtr?: number | null) {
  const stopDistance = config.stopLossMode === 'NONE' ? null : config.stopLossMode === 'ATR'
    ? Decimal.min(Decimal.max(new Decimal(signalAtr ?? 0).times(config.slAtrMult), entry.times(config.slMinPct).div(100)), entry.times(config.slMaxPct).div(100))
    : config.stopLossMode === 'PERCENT' ? entry.times(config.stopLossValue).div(100) : entry.times(config.stopLossValue).div(notionalInr);
  if ((config.stopLossMode === 'ATR' || config.takeProfitMode === 'ATR') && !(signalAtr && Number.isFinite(signalAtr) && signalAtr > 0)) throw new Error('ATR_WARMUP_REQUIRED');
  const targetDistance = config.takeProfitMode === 'NONE' ? null : config.takeProfitMode === 'ATR' ? new Decimal(signalAtr!).times(config.tpAtrMult)
    : config.takeProfitMode === 'RR_MULTIPLE' ? stopDistance!.times(config.tpRrMultiple)
    : config.takeProfitMode === 'PERCENT' ? entry.times(config.takeProfitValue).div(100) : entry.times(config.takeProfitValue).div(notionalInr);
  const price = (distance: Decimal | null, stop: boolean): string | null => {
    if (distance === null) return null;
    const result = entry.plus(distance.times((side === 'LONG') === stop ? -1 : 1));
    if (!result.gt(0)) throw new Error('INVALID_PROTECTIVE_DISTANCE');
    return result.toFixed();
  };
  return { stopPrice: price(stopDistance, true), takeProfitPrice: price(targetDistance, false) };
}
const FUNDING_INTERVAL_MS = 8 * 60 * 60_000;
/** Pure virtual isolated-margin accounting. Production replays and paper inject observed contract constraints. */
export class VirtualFillBook {
  public readonly state: VirtualBookState;
  public readonly config: PracticalBacktestConfig;
  public constructor(config: PracticalBacktestConfig, public inrPerUsdt: number, initial?: VirtualBookInput, readonly contract?: VirtualContract) {
    this.config = parseBacktestConfig(config);
    const old = initial ? structuredClone(initial) : null, p = old?.position;
    // Old persisted positions retain their actual 1x model; do not invent historical liquidation evidence.
    const margin = p ? p.marginUsedInr ?? new Decimal(p.entryPrice).times(p.quantity).times(p.contractMultiplier).times(inrPerUsdt).toFixed() : '0';
    this.state = { cashInr: old?.cashInr ?? String(config.capitalInr), nextEntryTimeMs: old?.nextEntryTimeMs ?? 0,
      position: p ? { ...p, leverage: p.leverage ?? 1, marginUsedInr: margin, liquidationPrice: p.liquidationPrice ?? null,
        fundingInr: p.fundingInr ?? '0', lastFundingTimeMs: p.lastFundingTimeMs ?? Math.floor(p.entryTimeMs / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS,
        peakFavorablePrice: p.peakFavorablePrice ?? p.entryPrice, trailingStopPrice: p.trailingStopPrice ?? null,
        entryGstInr: p.entryGstInr ?? '0', originalSlDistance: p.originalSlDistance ?? (p.stopPrice === null ? null : new Decimal(p.entryPrice).minus(p.stopPrice).abs().toFixed()),
        signalAtrPrice: p.signalAtrPrice ?? null, breakevenStopPrice: p.breakevenStopPrice ?? null, breakevenArmed: p.breakevenArmed ?? false } : null,
      trades: (old?.trades ?? []).map(t => {
        const used = t.marginUsedInr ?? Number(t.events.find(e => e.type === 'ENTRY_FILL')?.details['notionalInr'] ?? 0);
        return { ...t, leverage: t.leverage ?? 1, marginUsedInr: used, liquidationPrice: t.liquidationPrice ?? null,
          fundingInr: t.fundingInr ?? 0, marginRoiPct: t.marginRoiPct ?? (used > 0 ? t.netPnlInr / used * 100 : 0) };
      }), diagnostics: { skippedMinNotionalCount: old?.diagnostics?.skippedMinNotionalCount ?? 0, skippedInsufficientMarginCount: old?.diagnostics?.skippedInsufficientMarginCount ?? 0,
        ambiguousCandleCount: old?.diagnostics?.ambiguousCandleCount ?? 0, skippedAtrWarmupCount: old?.diagnostics?.skippedAtrWarmupCount ?? 0,
        skippedCooldownCount: old?.diagnostics?.skippedCooldownCount ?? 0, skippedRiskBudgetCount: old?.diagnostics?.skippedRiskBudgetCount ?? 0 } };
  }
  public mark(price: Decimal): Decimal {
    const p = this.state.position;
    const unrealized = p ? price.minus(p.entryPrice).times(p.quantity).times(p.contractMultiplier).times(this.inrPerUsdt).times(p.side === 'LONG' ? 1 : -1) : new Decimal(0);
    return new Decimal(this.state.cashInr).plus(p ? Decimal.max(unrealized, new Decimal(p.marginUsedInr).negated()) : 0);
  }
  public entry(decision: StrategyDecision, rawPrice: Decimal, timeMs: number, approvedQuantity?: string, multiplier?: string, signalAtr?: number | null): boolean {
    if (this.state.position || decision.status !== 'READY' || !decision.targetExposure || decision.targetExposure === 'FLAT') return false;
    const side = decision.targetExposure, price = this.fillPrice(rawPrice, side === 'LONG' ? 1 : -1);
    if (timeMs < this.state.nextEntryTimeMs) { this.state.diagnostics.skippedCooldownCount++; return false; }
    if ((this.config.stopLossMode === 'ATR' || this.config.takeProfitMode === 'ATR' || this.config.trailingAtrMult > 0)
      && !(signalAtr && Number.isFinite(signalAtr) && signalAtr > 0)) { this.state.diagnostics.skippedAtrWarmupCount++; return false; }
    const feeRate = this.feeRate(), cash = new Decimal(this.state.cashInr), leverage = this.config.leverage;
    if (!cash.gt(0)) { this.state.diagnostics.skippedInsufficientMarginCount++; return false; }
    const allocation = Decimal.min(this.config.maxOrderNotionalInr, cash.div(new Decimal(1).div(leverage).plus(feeRate)));
    const contractMultiplier = multiplier ?? this.contract?.contractMultiplier ?? '1', unit = price.times(contractMultiplier).times(this.inrPerUsdt);
    let desired = approvedQuantity === undefined ? allocation.div(unit) : new Decimal(approvedQuantity);
    if (this.config.sizingMode === 'RISK_PERCENT') {
      const riskBudget = cash.times(this.config.riskPerTradePct).div(100);
      const model = protectivePrices(this.config, price, allocation, side, signalAtr);
      const distance = price.minus(model.stopPrice!).abs(), stop = new Decimal(model.stopPrice!);
      const adverseStop = this.fillPrice(stop, side === 'LONG' ? -1 : 1, true);
      const perUnitCosts = price.plus(adverseStop).times(feeRate).plus(price.minus(rawPrice).abs()).plus(stop.minus(adverseStop).abs())
        .times(contractMultiplier).times(this.inrPerUsdt);
      const availableRisk = this.config.stopLossMode === 'INR' ? riskBudget.minus(this.config.stopLossValue) : riskBudget;
      const loss = this.config.stopLossMode === 'INR' ? perUnitCosts : distance.times(contractMultiplier).times(this.inrPerUsdt).plus(perUnitCosts);
      if (!availableRisk.gt(0)) { this.state.diagnostics.skippedRiskBudgetCount++; return false; }
      const riskQuantity = loss.gt(0) ? availableRisk.div(loss) : allocation.div(unit);
      desired = Decimal.min(desired, allocation.div(unit), riskQuantity);
    }
    const lot = new Decimal(this.contract?.quantityIncrement ?? '0.000000000000000001');
    const quantity = desired.div(lot).floor().times(lot), notional = quantity.times(unit);
    if (!quantity.gt(0) || quantity.lt(this.contract?.minQuantity ?? 0) || notional.lt(this.contract?.minNotionalInr ?? 0)) {
      this.state.diagnostics.skippedMinNotionalCount++; return false;
    }
    const initialMargin = notional.div(leverage), fee = notional.times(feeRate);
    if (notional.gt(this.config.maxOrderNotionalInr) || initialMargin.plus(fee).gt(cash)) {
      this.state.diagnostics.skippedInsufficientMarginCount++; return false;
    }
    const distance = new Decimal(1).div(leverage).minus(new Decimal(this.config.maintenanceMarginRateBps).div(10000));
    const liquidation = price.times(new Decimal(1).plus(distance.times(side === 'LONG' ? -1 : 1)));
    const protection = protectivePrices(this.config, price, notional, side, signalAtr);
    const originalSlDistance = protection.stopPrice === null ? null : price.minus(protection.stopPrice).abs().toFixed();
    const initialTrails = [this.config.trailingStopPct > 0 ? price.times(this.config.trailingStopPct).div(100) : null,
      this.config.trailingAtrMult > 0 ? new Decimal(signalAtr!).times(this.config.trailingAtrMult) : null].filter((v): v is Decimal => v !== null);
    const trail = initialTrails.length && this.config.trailingActivationPct === 0
      ? price.plus(Decimal.min(...initialTrails).times(side === 'LONG' ? -1 : 1)).toFixed() : null;
    const gst = fee.times(this.config.gstRatePct).div(100 + this.config.gstRatePct);
    const events: PracticalTradeEvent[] = [
      { type: 'DECISION_RECORDED', timestampMs: decision.evaluationTimeMs, details: { decisionId: decision.decisionId, strategyInstanceId: decision.strategyInstanceId, target: side } },
      { type: 'ENTRY_FILL', timestampMs: timeMs, details: { price: numeric(price), quantity: numeric(quantity), feeInr: numeric(fee), gstInr: numeric(gst), notionalInr: numeric(notional), leverage, initialMarginInr: numeric(initialMargin), marginMode: 'ISOLATED', liquidationPrice: numeric(liquidation) } },
      { type: 'SL_TP_ARMED', timestampMs: timeMs, details: { stopLossMode: this.config.stopLossMode, takeProfitMode: this.config.takeProfitMode,
        stopPrice: protection.stopPrice, takeProfitPrice: protection.takeProfitPrice, trailingStopPrice: trail } },
    ];
    this.state.cashInr = cash.minus(fee).toFixed();
    this.state.position = { side, entryPrice: price.toFixed(), quantity: quantity.toFixed(), contractMultiplier, entryFeeInr: fee.toFixed(), entryTimeMs: timeMs,
      ...protection, events, leverage, marginUsedInr: initialMargin.toFixed(), liquidationPrice: liquidation.toFixed(), fundingInr: '0',
      lastFundingTimeMs: Math.floor(timeMs / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS, peakFavorablePrice: price.toFixed(), trailingStopPrice: trail,
      entryGstInr: gst.toFixed(), originalSlDistance, signalAtrPrice: signalAtr == null ? null : String(signalAtr), breakevenStopPrice: null, breakevenArmed: false };
    return true;
  }
  /** Boundary mark is an OHLC proxy, not a reconstructed historical venue mark or observed funding rate. */
  public settleFunding(markPrice: Decimal, timestampMs: number): Decimal {
    const p = this.state.position;
    if (!p || this.config.fundingMode !== 'MODELED_FIXED_BPS' || timestampMs % FUNDING_INTERVAL_MS !== 0) return new Decimal(0);
    let total = new Decimal(0);
    for (let boundary = p.lastFundingTimeMs + FUNDING_INTERVAL_MS; boundary <= timestampMs; boundary += FUNDING_INTERVAL_MS) {
      if (boundary <= p.entryTimeMs) continue;
      const notional = markPrice.times(p.quantity).times(p.contractMultiplier).times(this.inrPerUsdt);
      const cashflow = notional.times(this.config.fundingRateBpsPer8h ?? 1).div(10000).times(p.side === 'LONG' ? -1 : 1);
      p.fundingInr = new Decimal(p.fundingInr).plus(cashflow).toFixed();
      this.state.cashInr = new Decimal(this.state.cashInr).plus(cashflow).toFixed();
      p.lastFundingTimeMs = boundary; total = total.plus(cashflow);
      p.events.push({ type: 'FUNDING_SETTLEMENT', timestampMs: boundary, details: { fundingMode: 'MODELED_FIXED_BPS', rateBpsPer8h: this.config.fundingRateBpsPer8h ?? 1,
        markPriceUsdt: numeric(markPrice), markNotionalInr: numeric(notional), fundingCashflowInr: numeric(cashflow), source: 'FIXED_RATE_OHLC_MARK_PROXY' } });
    }
    return total;
  }
  public exit(rawPrice: Decimal, timeMs: number, reason: PracticalBacktestTrade['exitReason']): PracticalBacktestTrade | null {
    const p = this.state.position; if (!p) return null;
    const liquidated = reason === 'LIQUIDATION';
    const exit = liquidated ? rawPrice : this.fillPrice(rawPrice, p.side === 'LONG' ? -1 : 1, ['STOP_LOSS', 'TRAILING_STOP', 'BREAKEVEN'].includes(reason));
    let gross = exit.minus(p.entryPrice).times(p.quantity).times(p.contractMultiplier).times(this.inrPerUsdt).times(p.side === 'LONG' ? 1 : -1);
    if (liquidated) gross = Decimal.max(gross, new Decimal(p.marginUsedInr).negated());
    const exitFee = exit.times(p.quantity).times(p.contractMultiplier).times(this.inrPerUsdt)
      .times(liquidated ? new Decimal(this.config.liquidationFeeBps).div(10000).times(new Decimal(1).plus(new Decimal(this.config.gstRatePct).div(100))) : this.feeRate());
    const gst = new Decimal(p.entryGstInr).plus(exitFee.times(this.config.gstRatePct).div(100 + this.config.gstRatePct));
    const fees = new Decimal(p.entryFeeInr).plus(exitFee), funding = new Decimal(p.fundingInr), net = gross.minus(fees).plus(funding);
    // Funding has already settled into cash and must not be applied twice on exit.
    this.state.cashInr = new Decimal(this.state.cashInr).plus(gross).minus(exitFee).toFixed();
    const trade: PracticalBacktestTrade = { tradeId: `trade-${String(this.state.trades.length + 1).padStart(4, '0')}`, side: p.side,
      entryTimeIso: new Date(p.entryTimeMs).toISOString(), entryPrice: numeric(new Decimal(p.entryPrice)), exitTimeIso: new Date(timeMs).toISOString(),
      exitPrice: numeric(exit), quantity: numeric(new Decimal(p.quantity)), grossPnlInr: numeric(gross), feeInr: numeric(fees), netPnlInr: numeric(net), exitReason: reason,
      leverage: p.leverage, marginUsedInr: numeric(new Decimal(p.marginUsedInr)), liquidationPrice: p.liquidationPrice === null ? null : numeric(new Decimal(p.liquidationPrice)),
      fundingInr: numeric(funding), marginRoiPct: numeric(net.div(p.marginUsedInr).times(100)), gstInr: numeric(gst),
      events: [...p.events, { type: 'EXIT_FILL', timestampMs: timeMs, details: { price: numeric(exit), feeInr: numeric(exitFee), exitReason: reason,
        liquidationFeeInr: liquidated ? numeric(exitFee) : 0, gstInr: numeric(exitFee.times(this.config.gstRatePct).div(100 + this.config.gstRatePct)),
        fundingInr: numeric(funding), grossPnlInr: numeric(gross), netPnlInr: numeric(net) } }] };
    const step = Number(timeframeResolution[this.config.timeframe]) * 60_000;
    this.state.nextEntryTimeMs = this.config.cooldownBars > 0 ? (Math.floor((timeMs - 1) / step) + 1 + this.config.cooldownBars) * step : timeMs;
    this.state.trades.push(trade); this.state.position = null; return trade;
  }
  public protection(bar: RestCandleRecord, closeTimeMs: number): PracticalBacktestTrade | null {
    const p = this.state.position; if (!p) return null;
    const hit = (level: Decimal, adverse: boolean) => (p.side === 'LONG') === adverse ? bar.low.lte(level) : bar.high.gte(level);
    const hard = p.stopPrice === null ? null : new Decimal(p.stopPrice), trail = p.trailingStopPrice === null ? null : new Decimal(p.trailingStopPrice);
    const be = p.breakevenStopPrice === null ? null : new Decimal(p.breakevenStopPrice);
    const stop = be === null ? hard : hard === null ? be : p.side === 'LONG' ? Decimal.max(hard, be) : Decimal.min(hard, be);
    const target = p.takeProfitPrice === null ? null : new Decimal(p.takeProfitPrice);
    // A tightened trailing stop replaces a looser hard stop. Stops still precede TP on a double hit.
    const trailingActive = trail !== null && (stop === null || (p.side === 'LONG' ? trail.gt(stop) : trail.lt(stop)));
    const activeStop = trailingActive ? trail : stop;
    if (activeStop && target && hit(activeStop, true) && hit(target, false)) this.state.diagnostics.ambiguousCandleCount++;
    if (p.liquidationPrice !== null && hit(new Decimal(p.liquidationPrice), true)) return this.exit(new Decimal(p.liquidationPrice), closeTimeMs, 'LIQUIDATION');
    if (activeStop && hit(activeStop, true)) return this.exit(p.side === 'LONG' ? Decimal.min(bar.open, activeStop) : Decimal.max(bar.open, activeStop), closeTimeMs,
      trailingActive ? 'TRAILING_STOP' : be !== null && activeStop.eq(be) ? 'BREAKEVEN' : 'STOP_LOSS');
    if (target && hit(target, false)) return this.exit(target, closeTimeMs, 'TAKE_PROFIT');
    const peak = p.side === 'LONG' ? Decimal.max(p.peakFavorablePrice, bar.high) : Decimal.min(p.peakFavorablePrice, bar.low);
    p.peakFavorablePrice = peak.toFixed();
    const profitPct = peak.minus(p.entryPrice).div(p.entryPrice).times(p.side === 'LONG' ? 100 : -100);
    if (this.config.breakevenAt1R && !p.breakevenArmed && p.originalSlDistance !== null && new Decimal(p.originalSlDistance).gt(0)
      && peak.minus(p.entryPrice).times(p.side === 'LONG' ? 1 : -1).gte(p.originalSlDistance)) {
      const entry = new Decimal(p.entryPrice), entryRate = new Decimal(p.entryFeeInr).div(entry.times(p.quantity).times(p.contractMultiplier).times(this.inrPerUsdt));
      const sign = p.side === 'LONG' ? 1 : -1;
      let price = entry.times(new Decimal(1).plus(entryRate.times(sign))).div(new Decimal(1).minus(this.feeRate().times(sign)));
      if (this.contract?.tickSize) { const ticks = price.div(this.contract.tickSize); price = (sign === 1 ? ticks.ceil() : ticks.floor()).times(this.contract.tickSize); }
      p.breakevenArmed = true; p.breakevenStopPrice = price.toFixed();
      p.events.push({ type: 'BREAKEVEN_ARMED', timestampMs: closeTimeMs, details: { originalSlDistance: p.originalSlDistance, breakevenStopPrice: price.toFixed(), effectiveFromMs: closeTimeMs } });
    }
    const distances = [this.config.trailingStopPct > 0 ? peak.times(this.config.trailingStopPct).div(100) : null,
      this.config.trailingAtrMult > 0 && p.signalAtrPrice !== null ? new Decimal(p.signalAtrPrice).times(this.config.trailingAtrMult) : null].filter((v): v is Decimal => v !== null);
    if (distances.length && profitPct.gte(this.config.trailingActivationPct)) {
      const candidate = peak.plus(Decimal.min(...distances).times(p.side === 'LONG' ? -1 : 1));
      if (candidate.gt(0) && (trail === null || (p.side === 'LONG' ? candidate.gt(trail) : candidate.lt(trail)))) {
        p.trailingStopPrice = candidate.toFixed();
        p.events.push({ type: 'TRAILING_STOP_UPDATED', timestampMs: closeTimeMs, details: { peakFavorablePrice: peak.toFixed(), trailingStopPrice: candidate.toFixed(), effectiveFromMs: closeTimeMs } });
      }
    }
    return null;
  }
  public fillPrice(price: Decimal, direction: 1 | -1, stop = false): Decimal {
    return price.times(new Decimal(1).plus(new Decimal(stop ? this.config.stopSlippageBps : this.config.slippageBps)
      .plus(new Decimal(this.config.spreadBps).div(2)).div(10000).times(direction)));
  }
  private feeRate(): Decimal { return new Decimal(this.config.fillLiquidity === 'MAKER' ? this.config.makerFeeBps : this.config.takerFeeBps).div(10000).times(new Decimal(1).plus(new Decimal(this.config.gstRatePct).div(100))); }
}

export class PracticalBacktestRunner {
  readonly #instruments = new Map<string, Promise<BacktestInstrumentSource>>();
  public constructor(private readonly options: { client: PracticalHistoricalClient; nowMs?: () => number;
    readInrPerUsdt?: () => Promise<number>; signal?: AbortSignal; archive?: HistoricalMinuteArchive; archiveRoot?: string }) {}
  public async run(input: unknown = {}): Promise<PracticalBacktestReport> {
    const config = parseBacktestConfig(input), now = (this.options.nowMs ?? Date.now)(), endTimeMs = config.endTimeMs ?? now;
    if (endTimeMs > now) throw new Error('FUTURE_HISTORY_REFUSED');
    const interval = Number(timeframeResolution[config.timeframe]) * 60_000, pair = researchPair(config.coin);
    const ranged = config.days !== undefined || config.fromDate !== undefined || config.toDate !== undefined || config.fromMs !== undefined || config.toMs !== undefined;
    const end = Math.floor(endTimeMs / interval) * interval;
    const window = ranged ? resolveHistoryWindow(config, now) : { fromMs: end - config.bars * interval, toMs: end };
    const archive = this.options.archive ?? new HistoricalMinuteArchive(this.options.archiveRoot ?? path.resolve('.local'), this.options.nowMs ?? Date.now);
    const gates = config.use4hTrend100 || config.use4hTrend200;
    const cached = ranged || this.options.archive || this.options.archiveRoot || gates ? await archive.read(pair) : [];
    const cachedWindow = cached.filter(c => c.openTimeMs >= window.fromMs && c.openTimeMs < window.toMs);
    const hasMinutes = cachedWindow.length > 0 && !missingMinuteRanges(cachedWindow, window).length;
    const nonNative = !['1', '5', '15', '60'].includes(timeframeResolution[config.timeframe]);
    const rate = await this.rate(config), contract = await this.contract(pair, rate);
    if (ranged || hasMinutes || nonNative || gates) {
      const source = hasMinutes ? cachedWindow : await archive.ensureRange(this.options.client, pair, window, this.options.signal);
      if (missingMinuteRanges(source, window).length) throw new Error('INCOMPLETE_CANDLE_HISTORY');
      const candles = aggregateMinutes(source, interval / 60_000, window);
      const macro = gates ? await archive.read(pair) : source;
      return this.simulate(ranged ? { ...config, ...window } : config, candles, rate, contract, source, macro);
    }
    const candles = await fetchHistoricalCandles(this.options.client, { pair, resolution: timeframeResolution[config.timeframe],
      bars: config.bars, endTimeMs, signal: this.options.signal });
    return this.simulate(config, candles, rate, contract);
  }
  /** Synthetic HTF inputs retain their legacy fallback. An explicit 1m source must cover the entire replay. */
  public async runOnCandles(input: unknown, records: readonly RestCandleRecord[], minuteRecords?: readonly RestCandleRecord[]): Promise<PracticalBacktestReport> {
    if (!records.length) throw new Error('INCOMPLETE_CANDLE_HISTORY');
    const config = parseBacktestConfig(input), rate = await this.rate(config), step = Number(timeframeResolution[config.timeframe]) * 60_000;
    const end = Math.floor((config.endTimeMs ?? records.at(-1)!.openTimeMs + step) / step) * step;
    if (end > (this.options.nowMs ?? Date.now)()) throw new Error('FUTURE_HISTORY_REFUSED');
    const candles = verifiedCandles(records, researchPair(config.coin), step, end - config.bars * step, end);
    const retained = (config.use4hTrend100 || config.use4hTrend200) && (this.options.archive || this.options.archiveRoot)
      ? await (this.options.archive ?? new HistoricalMinuteArchive(this.options.archiveRoot!, this.options.nowMs ?? Date.now)).read(researchPair(config.coin)) : [];
    return this.simulate(config, candles, rate, await this.contract(researchPair(config.coin), rate), minuteRecords, retained.length ? retained : minuteRecords);
  }

  private async contract(pair: string, rate: number): Promise<VirtualContract> {
    if (!this.options.client.getInrFuturesInstrument) throw new Error('INSTRUMENT_METADATA_REQUIRED');
    let pending = this.#instruments.get(pair);
    if (!pending) { pending = this.options.client.getInrFuturesInstrument(pair); this.#instruments.set(pair, pending); }
    const metadata = await pending;
    if (metadata.pair !== pair) throw new Error('INVALID_INSTRUMENT_METADATA');
    return virtualContract(metadata, rate);
  }
  private async rate(config: PracticalBacktestConfig): Promise<number> {
    const rate = config.inrPerUsdt ?? await this.options.readInrPerUsdt?.();
    if (rate === undefined || !Number.isFinite(rate) || rate <= 0 || rate > 10000) throw new Error('INR_CONVERSION_REQUIRED'); return rate;
  }
  private simulate(config: PracticalBacktestConfig, candles: readonly RestCandleRecord[], rate: number, contract: VirtualContract,
    minuteRecords?: readonly RestCandleRecord[], macroSource = minuteRecords): PracticalBacktestReport {
    const minutes = Number(timeframeResolution[config.timeframe]), step = minutes * 60_000, pair = researchPair(config.coin);
    const session = new HistoricalStrategySession(pair, config.strategy, minutes, candles[0]!.openTimeMs, strategyParameters(config));
    const book = new VirtualFillBook(config, rate, undefined, contract);
    const from = candles[0]!.openTimeMs, to = candles.at(-1)!.openTimeMs + step;
    const subCandles = minuteRecords === undefined ? undefined : verifiedCandles(minuteRecords, pair, 60_000, from, to);
    if (subCandles) {
      const aggregated = aggregateMinutes(subCandles, minutes, { fromMs: from, toMs: to });
      if (aggregated.some((c, i) => JSON.stringify(candleIdentity(c)) !== JSON.stringify(candleIdentity(candles[i]!)))) throw new Error('CONFLICTING_CANDLE');
    }
    const protectionMode = subCandles !== undefined || minutes === 1 ? '1M' as const : 'HTF' as const;
    const bars = candles.map(c => gateCandle(c, minutes)), atr = wilderAtr(bars);
    const macro = config.use4hTrend100 || config.use4hTrend200
      ? macroTrendGates(bars, macroSource ? macroSource.filter(c => c.openTimeMs + 60_000 <= to).map(c => gateCandle(c, 1))
        : 240 % minutes === 0 ? bars : [], macroSource ? 1 : 240 % minutes === 0 ? minutes : 1) : null;
    const roundTripCost = roundTripCostFraction(config);
    let gateRejectedCount = 0, peak = new Decimal(config.capitalInr), maxDrawdown = new Decimal(0);
    let pending: { decision: StrategyDecision; atr: number | null; allowed: boolean } | null = null;
    const equityCurve: { timestampMs: number; equityInr: number; drawdownPct: number }[] = [];
    const mark = (timestampMs: number, price: Decimal): void => {
      const equity = book.mark(price); peak = Decimal.max(peak, equity);
      const dd = peak.minus(equity).div(peak).times(100); maxDrawdown = Decimal.max(maxDrawdown, dd);
      equityCurve.push({ timestampMs, equityInr: numeric(equity), drawdownPct: numeric(dd) });
    };
    mark(from, candles[0]!.open);
    let cursor = 0;
    for (let i = 0; i < candles.length; i++) {
      const strategyBar = candles[i]!, closing = strategyBar.openTimeMs + step;
      const protection = subCandles ? subCandles.slice(cursor, cursor + minutes) : [strategyBar];
      if (subCandles) cursor += minutes;
      for (let j = 0; j < protection.length; j++) {
        this.options.signal?.throwIfAborted(); const bar = protection[j]!, duration = subCandles ? 60_000 : step, close = bar.openTimeMs + duration;
        book.settleFunding(bar.open, bar.openTimeMs);
        if (j === 0 && pending?.allowed && pending.decision.status === 'READY' && pending.decision.targetExposure && pending.decision.targetExposure !== 'FLAT'
          && !book.state.position) book.entry(pending.decision, bar.open, bar.openTimeMs, undefined, undefined, pending.atr);
        // HTF-only fallback uses the already known open as the proxy for an interior funding boundary.
        if (!subCandles) for (let boundary = (Math.floor(bar.openTimeMs / FUNDING_INTERVAL_MS) + 1) * FUNDING_INTERVAL_MS; boundary < close; boundary += FUNDING_INTERVAL_MS) book.settleFunding(bar.open, boundary);
        const protectedExit = book.protection(bar, close);
        if (!protectedExit) book.settleFunding(bar.close, close);
        if (j === protection.length - 1) {
          const decision = session.update(strategyBar, { macroTrend: macro?.[i] ?? null }).decision, target = decision?.targetExposure, point = macro?.[i];
          const allowed = target === 'LONG' || target === 'SHORT' ? isFuturesEventStrategy(config.strategy) || costGate(atr[i]!, bars[i]!.close, config.costGateMult, roundTripCost)
            && (!config.use4hTrend200 || (target === 'LONG' ? point?.long200 : point?.short200) === true)
            && (!config.use4hTrend100 || (target === 'LONG' ? point?.long100 : point?.short100) === true) : false;
          if (decision?.status === 'READY' && target && target !== 'FLAT' && !allowed) gateRejectedCount++;
          pending = decision ? { decision, atr: atr[i] ?? null, allowed } : null;
          const position = book.state.position;
          if (position && decision?.status === 'READY' && target && target !== position.side
            && (target === 'FLAT' ? !config.holdSignalOnZero : config.exitOnOppositeSignal)) {
            book.exit(strategyBar.close, closing, target === 'FLAT' ? 'SIGNAL_EXIT' : 'TARGET_CHANGE');
          }
          if (i === candles.length - 1) book.exit(strategyBar.close, closing, 'END_OF_DATA');
        }
        mark(close, bar.close);
      }
    }
    const trades = book.state.trades;
    const sum = (key: 'grossPnlInr' | 'feeInr' | 'fundingInr' | 'marginUsedInr' | 'marginRoiPct') => trades.reduce((v, t) => v.plus(t[key]), new Decimal(0));
    const winners = trades.filter(t => t.netPnlInr > 0), losers = trades.filter(t => t.netPnlInr < 0);
    const won = winners.reduce((v, t) => v.plus(t.netPnlInr), new Decimal(0)), lost = losers.reduce((v, t) => v.minus(t.netPnlInr), new Decimal(0));
    const effectiveConfig = { ...config, inrPerUsdt: rate, endTimeMs: candles.at(-1)!.openTimeMs + step };
    const totalFundingInr = numeric(sum('fundingInr')), label = fundingLabel(config);
    return { runId: `bt-${sha256CanonicalJson(JSON.stringify({ version: 4, config: effectiveConfig, contract, candles: candles.map(candleIdentity), minutes: subCandles?.map(candleIdentity), macro })).slice(0, 24)}`,
      mode: 'BACKTEST', pair, config: effectiveConfig, completedAtIso: new Date(effectiveConfig.endTimeMs).toISOString(), sizingMode: 'BOUNDED_RESEARCH',
      conversion: { inrPerUsdt: rate, source: config.inrPerUsdt === undefined ? 'CURRENT_PROVIDER_SNAPSHOT' : 'OPERATOR_FIXED' },
      instrument: contract, totalFundingInr, fundingLabel: label, liveLocked: true, protectionMode,
      diagnostics: { SKIPPED_MIN_NOTIONAL: book.state.diagnostics.skippedMinNotionalCount, INSUFFICIENT_MARGIN: book.state.diagnostics.skippedInsufficientMarginCount },
      assumptions: [`Virtual ISOLATED margin at ${config.leverage}x; notional is capped by available margin including entry fees and max order INR. Quantity rounds down to the observed contract lot; provider minimums are enforced.`,
        'Current instrument constraints and fixed INR/USDT conversion are used; historical contract changes and historical FX are not reconstructed. No live M7 admission or trading authority is conferred.',
        'Closed-candle entries fill at the next open; signal exits fill at the completed candle close after protective checks. Reversals enter at the following open. Half-spread and adverse slippage apply per fill.',
        'SL/TP are optional gross trading PnL thresholds, before fees and execution costs; INR distance = threshold / (quantity * contract multiplier * fixed FX).',
        'Conservative exit priority: liquidation, active hard/trailing SL, TP, then strategy exit. A tighter trailing level replaces a looser hard SL. Stop gaps fill at the worse open with stop slippage; TP gaps fill at the target. Intrabar exits are recorded at candle close.',
        `Protection resolution: ${protectionMode}. Macro gates use retained closed 4h history; missing EMA warmup blocks entries. Gate rejections: ${gateRejectedCount}.`,
        'ATR distances are frozen from signal-time Wilder ATR14; SL is clamped and R:R uses the original stop. GST is included in fees and reported separately. Breakeven covers fees/GST before funding and adverse slippage.',
        'Trailing levels tighten using completed candle extremes and apply from the next candle; no intrabar high/low ordering is inferred.',
        `Liquidation uses the configured ${config.maintenanceMarginRateBps} bps maintenance rate and ${config.liquidationFeeBps} bps liquidation fee. Price loss is capped at isolated initial margin; fees and funding remain separate cashflows. This is a conservative model, not a venue liquidation quote.`,
        `${label}. Modeled funding settles at 00:00/08:00/16:00 UTC using boundary OHLC as a mark-price proxy, before signal/end exits. Intrabar protective exits occur before a closing funding boundary; entry exactly at a boundary pays from the next boundary.`,
        'Final exposure closes at end of data. Queue, partial fills and historical funding rates are not reconstructed. LIVE LOCKED.'],
      summary: { netPnlInr: numeric(new Decimal(book.state.cashInr).minus(config.capitalInr)), grossPnlInr: numeric(sum('grossPnlInr')), totalFeesInr: numeric(sum('feeInr')),
        winRatePct: trades.length ? numeric(new Decimal(winners.length).div(trades.length).times(100)) : 0, profitFactor: lost.gt(0) ? numeric(won.div(lost)) : null,
        maxDrawdownPct: numeric(maxDrawdown), totalTrades: trades.length, fundingNote: label === 'Excluded' ? 'Funding excluded' : `Funding ${label.toLowerCase()}`,
        totalFundingInr, fundingLabel: label, liquidationCount: trades.filter(t => t.exitReason === 'LIQUIDATION').length,
        skippedMinNotionalCount: book.state.diagnostics.skippedMinNotionalCount, avgMarginRoiPct: trades.length ? numeric(sum('marginRoiPct').div(trades.length)) : 0,
        gstInr: numeric(trades.reduce((n, t) => n.plus(t.gstInr ?? 0), new Decimal(0))),
        breakevenExitCount: trades.filter(t => t.exitReason === 'BREAKEVEN').length, ambiguousCandleCount: book.state.diagnostics.ambiguousCandleCount, protectionMode,
        effectiveLeverage: trades.length ? numeric(trades.reduce((n, t) => n.plus(new Decimal(t.marginUsedInr).times(t.leverage)), new Decimal(0)).div(sum('marginUsedInr'))) : 0 }, equityCurve, candles: candles.map(toChartCandle), trades };
  }
}
