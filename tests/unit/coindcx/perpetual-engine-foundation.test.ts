import { afterEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { HistoricalStrategySession, PracticalBacktestRunner, VirtualFillBook, parseBacktestConfig, protectivePrices, fetchHistoricalCandles,
  type VirtualContract } from '../../../src/integration/coindcx/live/practical-backtest-runner';
import { aggregateMinutes } from '../../../src/market-data/historical-minute-archive';
import type { RestCandleRecord } from '../../../src/market-data/rest-candle-reader';
import type { StrategyDecision } from '../../../src/strategies';
import { parseBacktestArguments } from '../../../scripts/run-backtest';

const start = Date.parse('2026-01-01T00:00:00Z'), minute = 60_000, pair = 'B-ETH_USDT';
const contract: VirtualContract = { quantityIncrement: '.01', minQuantity: '.01', minNotionalInr: '100', contractMultiplier: '1', tickSize: '.01' };
const metadata = { pair, kind: 'perpetual', quoteCurrency: 'USDT', marginCurrency: 'INR' as const, quantityIncrement: new Decimal('.01'),
  minQuantity: new Decimal('.01'), minTradeSize: new Decimal('.01'), minNotional: new Decimal(1), unitContractValue: new Decimal(1), priceIncrement: new Decimal('.01') };
function decision(side: 'LONG' | 'SHORT' | 'FLAT', evaluationTimeMs = start): StrategyDecision {
  return { decisionId: `decision-${evaluationTimeMs}`, decisionSequence: 1, strategyInstanceId: 'foundation', strategyId: 'EMA_TREND', strategyVersion: '1', parameterHash: 'hash',
    pair, evaluationTimeMs, triggerTimeframeMinutes: 15, status: 'READY', targetExposure: side, reasonCodes: [] };
}
function candle(i: number, open = 100, high = open + .1, low = open - .1, close = open): RestCandleRecord {
  return { pair, openTimeMs: start + i * minute, open: new Decimal(open), high: new Decimal(high), low: new Decimal(low), close: new Decimal(close), volume: new Decimal(1), quoteVolume: null };
}
const config = (extra: Record<string, unknown> = {}) => parseBacktestConfig({ coin: 'ETH', capitalInr: 10000, maxOrderNotionalInr: 1000, leverage: 5,
  inrPerUsdt: 100, takerFeeBps: 0, slippageBps: 0, spreadBps: 0, stopSlippageBps: 0, ...extra });
function book(extra: Record<string, unknown> = {}, side: 'LONG' | 'SHORT' = 'LONG', signalAtr?: number) {
  const b = new VirtualFillBook(config(extra), 100, undefined, contract);
  expect(b.entry(decision(side), new Decimal(100), start, undefined, undefined, signalAtr)).toBe(true); return b;
}
afterEach(() => vi.restoreAllMocks());

describe('Signal-time ATR, isolated sizing, GST and next-candle stops', () => {
  it('clamps ATR SL to .8%-4%, independently supports ATR TP and derives RR from the clamped original SL', () => {
    const c = config({ stopLossMode: 'ATR', takeProfitMode: 'RR_MULTIPLE' });
    expect(protectivePrices(c, new Decimal(100), new Decimal(1000), 'LONG', .1)).toEqual({ stopPrice: '99.2', takeProfitPrice: '101.6' });
    expect(protectivePrices(c, new Decimal(100), new Decimal(1000), 'LONG', 10)).toEqual({ stopPrice: '96', takeProfitPrice: '108' });
    expect(protectivePrices(config({ stopLossMode: 'ATR', takeProfitMode: 'ATR' }), new Decimal(100), new Decimal(1000), 'SHORT', 10))
      .toEqual({ stopPrice: '104', takeProfitPrice: '70' });
    const b = new VirtualFillBook(c, 100); expect(b.entry(decision('LONG'), new Decimal(100), start)).toBe(false);
    expect(b.state.diagnostics.skippedAtrWarmupCount).toBe(1);
  });
  it.each(['LONG', 'SHORT'] as const)('freezes ATR and tightens the tighter ATR/percentage trail for %s', side => {
    const b = book({ trailingStopPct: 2, trailingAtrMult: 1.5 }, side, 2), long = side === 'LONG';
    expect(b.state.position!.trailingStopPrice).toBe(long ? '98' : '102');
    b.protection(long ? candle(1, 100, 110, 99, 109) : candle(1, 100, 101, 90, 91), start + 2 * minute);
    expect(b.state.position!.trailingStopPrice).toBe(long ? '107.8' : '91.8');
    const snapshot = b.state.position!.trailingStopPrice;
    b.protection(long ? candle(2, 109, 109.5, 108, 109) : candle(2, 91, 91.5, 90.5, 91), start + 3 * minute);
    expect(b.state.position!.trailingStopPrice).toBe(snapshot);
    const t = b.protection(long ? candle(3, 108, 109, 107, 108) : candle(3, 91, 93, 90.5, 92), start + 4 * minute)!;
    expect(t.exitReason).toBe('TRAILING_STOP'); expect(t.exitPrice).toBe(Number(snapshot));
  });
  it.each(['LONG', 'SHORT'] as const)('arms fee/GST-adjusted %s breakeven once and applies it only to the next candle', side => {
    const b = book({ stopLossMode: 'PERCENT', stopLossValue: 1, breakevenAt1R: true, takerFeeBps: 5, gstRatePct: 18 }, side);
    const long = side === 'LONG';
    expect(b.protection(long ? candle(1, 100, 101.2, 99.5, 101) : candle(1, 100, 100.5, 98.8, 99), start + 2 * minute)).toBeNull();
    const stop = Number(b.state.position!.breakevenStopPrice); expect(stop).toBe(long ? 100.12 : 99.88);
    expect(b.state.position!.events.filter(e => e.type === 'BREAKEVEN_ARMED')).toHaveLength(1);
    const restored = new VirtualFillBook(b.config, 100, b.state, contract);
    const t = restored.protection(long ? candle(2, 101, 101, 100.1, 100.5) : candle(2, 99, 99.9, 99, 99.5), start + 3 * minute)!;
    expect(t.exitReason).toBe('BREAKEVEN'); expect(t.netPnlInr).toBeGreaterThanOrEqual(0); expect(t.netPnlInr).toBeLessThan(.2);
    expect(t.events.filter(e => e.type === 'BREAKEVEN_ARMED')).toHaveLength(1);
  });
  it('sizes risk including round-trip GST costs, rounds down lots and reports GST as a subset of fees', () => {
    const b = book({ sizingMode: 'RISK_PERCENT', riskPerTradePct: 2, maxOrderNotionalInr: 20000, stopLossMode: 'PERCENT', stopLossValue: 1, takerFeeBps: 5, gstRatePct: 18 });
    expect(b.state.position!.quantity).toBe('1.78');
    const t = b.protection(candle(1, 100, 100.1, 98.9, 99), start + 2 * minute)!;
    const base = (100 + 99) * t.quantity * 100 * .0005;
    expect(t.gstInr).toBeCloseTo(base * .18, 10); expect(t.feeInr).toBeCloseTo(base * 1.18, 10);
    expect(-t.netPnlInr).toBeLessThanOrEqual(200); expect(t.netPnlInr).toBeCloseTo(t.grossPnlInr - t.feeInr, 8);
    expect(Number(b.state.cashInr)).toBeCloseTo(10000 + t.netPnlInr, 8);
  });
  it('caps risk sizing by available isolated margin without rounding up an unaffordable minimum lot', () => {
    const c = config({ capitalInr: 100, maxOrderNotionalInr: 20000, sizingMode: 'RISK_PERCENT', riskPerTradePct: 100, stopLossMode: 'PERCENT', stopLossValue: 1 });
    const b = new VirtualFillBook(c, 100, undefined, contract); expect(b.entry(decision('LONG'), new Decimal(100), start)).toBe(true);
    expect(Number(b.state.position!.marginUsedInr)).toBeLessThanOrEqual(100);
    const tiny = new VirtualFillBook(config({ sizingMode: 'RISK_PERCENT', riskPerTradePct: .0001, stopLossMode: 'PERCENT', stopLossValue: 1 }), 100, undefined, contract);
    expect(tiny.entry(decision('LONG'), new Decimal(100), start)).toBe(false); expect(tiny.state.diagnostics.skippedMinNotionalCount).toBe(1);
  });
  it('counts double-hit ambiguity even when liquidation overrides both levels', () => {
    const b = book({ leverage: 20, stopLossMode: 'PERCENT', stopLossValue: 1, takeProfitMode: 'PERCENT', takeProfitValue: 1 });
    expect(b.protection(candle(1, 100, 110, 90, 100), start + 2 * minute)!.exitReason).toBe('LIQUIDATION');
    expect(b.state.diagnostics.ambiguousCandleCount).toBe(1);
  });
  it('persists HTF-aligned cooldown after a minute exit and admits only the next eligible bucket', () => {
    const b = book({ cooldownBars: 1 }); b.exit(new Decimal(100), start + 6 * minute, 'SIGNAL_EXIT');
    expect(b.state.nextEntryTimeMs).toBe(start + 30 * minute);
    const restored = new VirtualFillBook(b.config, 100, b.state, contract);
    expect(restored.entry(decision('LONG'), new Decimal(100), start + 15 * minute)).toBe(false);
    expect(restored.entry(decision('LONG'), new Decimal(100), start + 30 * minute)).toBe(true);
  });
});

describe('Minute protection, HTF signals, gates and compatibility', () => {
  it.each(['LONG', 'SHORT'] as const)('settles %s funding at exact 8h UTC minutes inside non-divisible 45m strategy bars', async side => {
    const length = 30 * 45, rows = Array.from({ length }, (_, i) => candle(i));
    const bars = aggregateMinutes(rows, 45, { fromMs: start, toMs: start + length * minute });
    vi.spyOn(HistoricalStrategySession.prototype, 'update').mockImplementation(bar => ({ indicators: {}, decision: decision(side, bar.openTimeMs + 45 * minute) }));
    const runner = new PracticalBacktestRunner({ client: { getCandles: async () => [], getInrFuturesInstrument: async () => metadata }, nowMs: () => start + length * minute });
    const report = await runner.runOnCandles(config({ timeframe: '45m', bars: 30, fundingRateBpsPer8h: 1 }), bars, rows);
    const trade = report.trades[0]!;
    expect(report.trades).toHaveLength(1); expect(trade.fundingInr).toBeCloseTo(side === 'LONG' ? -.2 : .2, 10);
    expect(trade.events.filter(e => e.type === 'FUNDING_SETTLEMENT').map(e => e.timestampMs)).toEqual([start + 8 * 60 * minute, start + 16 * 60 * minute]);
    expect(report.summary.totalFundingInr).toBe(trade.fundingInr);
  });
  it('distinguishes actual 1m TP-before-SL chronology from an ambiguous synthetic 45m candle', async () => {
    const tf = 45, length = 30 * tf, rows = Array.from({ length }, (_, i) => candle(i, 100 + Math.floor(i / tf) * .1));
    const entryIndex = 3 * tf;
    rows[entryIndex] = candle(entryIndex, 100.3, 102, 100.2, 100.3);
    rows[entryIndex + 1] = candle(entryIndex + 1, 100.3, 100.5, 98.8, 100.3);
    const bars = aggregateMinutes(rows, tf, { fromMs: start, toMs: start + length * minute });
    const c = { ...config({ timeframe: '45m', bars: 30, parameters: { fastPeriod: 2, slowPeriod: 3 }, stopLossMode: 'PERCENT', stopLossValue: 1,
      takeProfitMode: 'PERCENT', takeProfitValue: 1 }), endTimeMs: start + length * minute };
    const runner = new PracticalBacktestRunner({ client: { getCandles: async () => [], getInrFuturesInstrument: async () => metadata }, nowMs: () => c.endTimeMs });
    const detailed = await runner.runOnCandles(c, bars, rows), fallback = await runner.runOnCandles(c, bars);
    expect(detailed.protectionMode).toBe('1M'); expect(fallback.protectionMode).toBe('HTF');
    expect(detailed.trades[0]!.entryTimeIso).toBe(new Date(start + entryIndex * minute).toISOString());
    expect(detailed.trades[0]!.exitReason).toBe('TAKE_PROFIT'); expect(detailed.trades[0]!.exitTimeIso).toBe(new Date(start + (entryIndex + 1) * minute).toISOString());
    expect(fallback.trades[0]!.exitReason).toBe('STOP_LOSS'); expect(fallback.summary.ambiguousCandleCount).toBe(1);
    expect(detailed.summary.ambiguousCandleCount).toBe(0); expect(detailed.equityCurve).toHaveLength(length + 1);
    expect(detailed.runId).not.toBe(fallback.runId);
    await expect(runner.runOnCandles(c, bars, rows.filter((_, i) => i !== 100))).rejects.toThrow('INCOMPLETE_CANDLE_HISTORY');
  });
  it.each([true, false])('holds neutral signals and applies exitOnOppositeSignal=%s without adding same-bar entries', async exitOnOppositeSignal => {
    const tf = 15, rows = Array.from({ length: 30 }, (_, i) => ({ ...candle(i * tf), close: new Decimal(100) }));
    let index = 0;
    vi.spyOn(HistoricalStrategySession.prototype, 'update').mockImplementation(bar => ({ indicators: {}, decision: decision(index++ === 0 ? 'LONG' : index <= 3 ? 'FLAT' : 'SHORT', bar.openTimeMs + tf * minute) }));
    const c = config({ bars: 30, holdSignalOnZero: true, exitOnOppositeSignal });
    const runner = new PracticalBacktestRunner({ client: { getCandles: async () => [], getInrFuturesInstrument: async () => metadata }, nowMs: () => start + 30 * tf * minute });
    const result = await runner.runOnCandles(c, rows);
    expect(result.trades[0]!.exitReason).toBe(exitOnOppositeSignal ? 'TARGET_CHANGE' : 'END_OF_DATA');
    expect(result.trades[0]!.exitTimeIso).toBe(new Date(start + (exitOnOppositeSignal ? 4 : 30) * tf * minute).toISOString());
    if (exitOnOppositeSignal) expect(result.trades[1]!.entryTimeIso).toBe(result.trades[0]!.exitTimeIso);
  });
  it('blocks all entries with an enabled impossible CG while preserving the legacy disabled default', async () => {
    const tf = 15, rows = Array.from({ length: 30 }, (_, i) => ({ ...candle(i * tf, 100 + i), close: new Decimal(100 + i) }));
    const runner = new PracticalBacktestRunner({ client: { getCandles: async () => [], getInrFuturesInstrument: async () => metadata }, nowMs: () => start + 30 * tf * minute });
    const result = await runner.runOnCandles(config({ bars: 30, costGateMult: 1000, rtCost: 1 }), rows);
    expect(result.summary.totalTrades).toBe(0); expect(result.liveLocked).toBe(true);
  });
  it('aggregates non-native public intervals from supported 1m requests and parses the full CLI configuration', async () => {
    const rows = Array.from({ length: 90 }, (_, i) => candle(i));
    const getCandles = vi.fn(async () => rows);
    const bars = await fetchHistoricalCandles({ getCandles }, { pair, resolution: '45', bars: 2, endTimeMs: start + 90 * minute });
    expect(bars).toHaveLength(2); expect(getCandles.mock.calls).toHaveLength(1);
    const c = parseBacktestArguments(['--coin', 'ETH', '--timeframe', '45m', '--leverage', '5', '--sl-mode', 'ATR', '--tp-mode', 'RR_MULTIPLE',
      '--sl-atr-mult', '2', '--tp-rr-multiple', '2', '--breakeven-at-1r', '--gst-rate-pct', '18', '--sizing-mode', 'RISK_PERCENT', '--risk-per-trade-pct', '2',
      '--cooldown-bars', '1', '--hold-signal-on-zero', '--no-exit-on-opposite-signal', '--use-4h-trend-200', '--cost-gate-mult', '2']);
    expect(c).toMatchObject({ timeframe: '45m', stopLossMode: 'ATR', takeProfitMode: 'RR_MULTIPLE', breakevenAt1R: true, gstRatePct: 18,
      sizingMode: 'RISK_PERCENT', riskPerTradePct: 2, holdSignalOnZero: true, exitOnOppositeSignal: false, use4hTrend200: true, costGateMult: 2 });
    expect(config()).toMatchObject({ gstRatePct: 0, breakevenAt1R: false, sizingMode: 'FIXED_NOTIONAL', holdSignalOnZero: false, exitOnOppositeSignal: true, cooldownBars: 0 });
    expect(() => config({ sizingMode: 'RISK_PERCENT', stopLossMode: 'NONE' })).toThrow();
  });
});
