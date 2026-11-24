import { describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { HistoricalStrategySession, PracticalBacktestRunner, VirtualFillBook, parseBacktestConfig, virtualContract,
  type VirtualContract } from '../../../src/integration/coindcx/live/practical-backtest-runner';
import type { RestCandleRecord } from '../../../src/market-data/rest-candle-reader';
import type { StrategyDecision } from '../../../src/strategies';
import { parseBacktestArguments } from '../../../scripts/run-backtest';

const start = Date.parse('2026-01-01T00:00:00Z'), interval = 15 * 60000, pair = 'B-ETH_USDT';
function decision(side: 'LONG' | 'SHORT'): StrategyDecision { return { decisionId: 'virtual-decision', decisionSequence: 1, strategyInstanceId: 'virtual-instance',
  strategyId: 'EMA_TREND', strategyVersion: '1.0.0', parameterHash: 'hash', pair, evaluationTimeMs: start, triggerTimeframeMinutes: 15, status: 'READY', targetExposure: side, reasonCodes: ['TEST_VIRTUAL'] }; }
function candle(open: number, high: number, low: number, close: number, index = 1, volume = 10): RestCandleRecord {
  return { pair, openTimeMs: start + index * interval, open: new Decimal(open), high: new Decimal(high), low: new Decimal(low), close: new Decimal(close), volume: new Decimal(volume), quoteVolume: null };
}
const contract: VirtualContract = { quantityIncrement: '.01', minQuantity: '.01', minNotionalInr: '100', contractMultiplier: '1' };
function book(side: 'LONG' | 'SHORT', extra: Record<string, unknown> = {}, entryMs = start + 60000, spec = contract) {
  const config = parseBacktestConfig({ coin: 'ETH', capitalInr: 5000, maxOrderNotionalInr: 1000, takerFeeBps: 0, slippageBps: 0, spreadBps: 0, stopSlippageBps: 0, ...extra });
  const model = new VirtualFillBook(config, 100, undefined, spec);
  expect(model.entry(decision(side), new Decimal(100), entryMs)).toBe(true); return model;
}

describe('Isolated perpetual futures accounting', () => {
  it.each(['LONG', 'SHORT'] as const)('liquidates %s at 20x BEFORE hard SL / TP and uses the exact modeled liquidation price', side => {
    const b = book(side, { leverage: 20, stopLossMode: 'PERCENT', stopLossValue: 1, takeProfitMode: 'PERCENT', takeProfitValue: 1, stopSlippageBps: 100 });
    const p = b.state.position!, used = Number(p.marginUsedInr);
    const result = b.protection(candle(100, 110, 90, 100), start + 2 * interval)!;
    expect(result.exitReason).toBe('LIQUIDATION'); expect(result.exitPrice).toBe(side === 'LONG' ? 95.5 : 104.5);
    expect(result.liquidationPrice).toBe(result.exitPrice); expect(result.leverage).toBe(20); expect(used).toBe(50);
    expect(result.grossPnlInr).toBeCloseTo(-45, 9); expect(result.grossPnlInr).toBeGreaterThanOrEqual(-used);
    expect(result.feeInr).toBeCloseTo(result.exitPrice * result.quantity * 100 * .01, 9);
    expect(result.netPnlInr).toBeCloseTo(result.grossPnlInr - result.feeInr, 9);
    expect(result.marginRoiPct).toBeCloseTo(result.netPnlInr / used * 100, 8);
  });
  it('caps liquidation price loss at initial margin even under an extreme adverse price, with fees accounted separately', () => {
    const b = book('LONG', { leverage: 20 }), used = Number(b.state.position!.marginUsedInr);
    const result = b.exit(new Decimal(1), start + interval, 'LIQUIDATION')!;
    expect(result.grossPnlInr).toBe(-used); expect(result.netPnlInr).toBeCloseTo(-used - result.feeInr, 9);
    expect(Number(b.state.cashInr)).toBeCloseTo(5000 + result.netPnlInr, 8);
  });
  it('uses an already tightened trail when both hard and trailing stops trigger, while liquidation keeps priority', () => {
    const b = book('LONG', { leverage: 5, stopLossMode: 'PERCENT', stopLossValue: 1, trailingStopPct: 1 });
    b.protection(candle(100, 105, 100, 104), start + interval);
    expect(b.state.position!.trailingStopPrice).toBe('103.95');
    const stopped = b.protection(candle(104, 104, 98, 100), start + 2 * interval)!;
    expect(stopped.exitReason).toBe('TRAILING_STOP'); expect(stopped.exitPrice).toBe(103.95);
  });
  it.each(['LONG', 'SHORT'] as const)('tightens an activated %s trail from closed extremes without loosening and uses stop slippage', side => {
    const b = book(side, { trailingStopPct: 1, trailingActivationPct: 2, stopSlippageBps: 10 });
    expect(b.state.position!.trailingStopPrice).toBeNull();
    expect(b.protection(side === 'LONG' ? candle(101, 105, 100, 104) : candle(99, 100, 95, 96), start + interval)).toBeNull();
    expect(Number(b.state.position!.trailingStopPrice)).toBe(side === 'LONG' ? 103.95 : 95.95);
    const armed = b.state.position!.trailingStopPrice;
    b.protection(side === 'LONG' ? candle(104.3, 104.6, 104.1, 104.2) : candle(95.8, 95.9, 95.5, 95.7), start + 2 * interval);
    expect(b.state.position!.trailingStopPrice).toBe(armed);
    const result = b.protection(side === 'LONG' ? candle(104, 104.1, 103, 103.5) : candle(95.9, 97, 95.8, 96.5), start + 3 * interval)!;
    expect(result.exitReason).toBe('TRAILING_STOP');
    expect(result.exitPrice).toBeCloseTo(Number(armed) * (side === 'LONG' ? .999 : 1.001), 8);
    expect(result.events.some(e => e.type === 'TRAILING_STOP_UPDATED')).toBe(true);
  });
  it.each([['LONG', 1, -1], ['SHORT', 1, 1], ['LONG', -1, 1], ['SHORT', -1, -1]] as const)('settles %s at rate %s with cashflow sign %s on 08:00, 16:00 and 00:00 UTC', (side, rate, direction) => {
    const b = book(side, { fundingRateBpsPer8h: rate });
    for (const hours of [8, 16, 24]) expect(b.settleFunding(new Decimal(110), start + hours * 3600000).toNumber()).toBeCloseTo(direction * .11, 10);
    expect(b.settleFunding(new Decimal(110), start + 24 * 3600000).toNumber()).toBe(0);
    const result = b.exit(new Decimal(110), start + 25 * 3600000, 'END_OF_DATA')!;
    expect(result.fundingInr).toBeCloseTo(direction * .33, 10);
    expect(result.events.filter(e => e.type === 'FUNDING_SETTLEMENT').map(e => new Date(e.timestampMs).getUTCHours())).toEqual([8, 16, 0]);
    expect(result.netPnlInr).toBeCloseTo(result.grossPnlInr - result.feeInr + result.fundingInr, 9);
    expect(Number(b.state.cashInr)).toBeCloseTo(5000 + result.netPnlInr, 8);
  });
  it('does not charge boundary entries or excluded funding, and persists idempotent settlement through a book restart', () => {
    const b = book('LONG', { fundingMode: 'MODELED_FIXED_BPS' }, start);
    expect(b.settleFunding(new Decimal(100), start).toNumber()).toBe(0);
    b.settleFunding(new Decimal(100), start + 8 * 3600000);
    const restored = new VirtualFillBook(b.config, 100, JSON.parse(JSON.stringify(b.state)), contract);
    expect(restored.settleFunding(new Decimal(100), start + 8 * 3600000).toNumber()).toBe(0);
    expect(restored.state).toEqual(b.state);
    const excluded = book('SHORT', { fundingMode: 'EXCLUDED', fundingRateBpsPer8h: 10 });
    expect(excluded.settleFunding(new Decimal(100), start + 8 * 3600000).toNumber()).toBe(0);
    expect(excluded.state.position!.events.some(e => e.type === 'FUNDING_SETTLEMENT')).toBe(false);
  });
  it('rounds contracts DOWN, applies the contract multiplier and skips entries below minimum notional', () => {
    const config = parseBacktestConfig({ coin: 'ETH', maxOrderNotionalInr: 1550, leverage: 5, slippageBps: 0, spreadBps: 0, takerFeeBps: 0 });
    const spec = { ...contract, contractMultiplier: '2' }, b = new VirtualFillBook(config, 100, undefined, spec);
    expect(b.entry(decision('LONG'), new Decimal(100), start)).toBe(true);
    expect(b.state.position!.quantity).toBe('0.07'); expect(b.state.position!.marginUsedInr).toBe('280');
    const skipped = new VirtualFillBook(config, 100, undefined, { ...spec, minNotionalInr: '1500' });
    expect(skipped.entry(decision('LONG'), new Decimal(100), start)).toBe(false);
    expect(skipped.state.diagnostics.skippedMinNotionalCount).toBe(1); expect(skipped.state.cashInr).toBe('5000');
    const tooSmall = new VirtualFillBook(config, 100, undefined, { ...spec, quantityIncrement: '1', minQuantity: '1' });
    expect(tooSmall.entry(decision('LONG'), new Decimal(100), start)).toBe(false);
  });
  it('refuses an approved quantity whose initial margin plus entry fees exceeds available equity', () => {
    const config = parseBacktestConfig({ coin: 'ETH', leverage: 20, capitalInr: 10, maxOrderNotionalInr: 1000 });
    const b = new VirtualFillBook(config, 100, undefined, contract);
    expect(b.entry(decision('LONG'), new Decimal(100), start, '.1')).toBe(false);
    expect(b.state.diagnostics.skippedInsufficientMarginCount).toBe(1); expect(b.state.position).toBeNull();
  });
  it('validates futures settings and parses the real CLI flags including rate-driven modeled funding', () => {
    expect(parseBacktestConfig({ coin: 'ETH' })).toMatchObject({ leverage: 3, marginMode: 'ISOLATED', maintenanceMarginRateBps: 50, trailingStopPct: 0, fundingMode: 'EXCLUDED', fundingRateBpsPer8h: 1 });
    const c = parseBacktestArguments(['--coin', 'ETH', '--strategy', 'supertrend', '--days', '7', '--leverage', '5', '--trailing-stop-pct', '1.5', '--funding-rate-bps-per-8h', '1', '--atr-period', '10', '--multiplier', '3']);
    expect(c).toMatchObject({ leverage: 5, trailingStopPct: 1.5, fundingMode: 'MODELED_FIXED_BPS', fundingRateBpsPer8h: 1, parameters: { atrPeriod: 10, multiplier: '3' } });
    for (const extra of [{ leverage: 21 }, { leverage: 0 }, { leverage: 2.1 }, { marginMode: 'CROSS' }, { trailingStopPct: 100 }, { leverage: 20, maintenanceMarginRateBps: 500 }]) expect(() => parseBacktestConfig({ coin: 'ETH', ...extra })).toThrow();
  });
});

describe('Reusable closed-candle futures kernels', () => {
  const rows = Array.from({ length: 160 }, (_, i) => { const price = 100 + Math.sin(i / 9) * 3 + (i % 19 === 0 ? -10 : i % 19 === 9 ? 10 : 0); return candle(price, price + .1, price - .1, price, i, 1 + i % 5); });
  it.each(['supertrend', 'vwap-mean-reversion'] as const)('replays deterministic %s decisions, reaches LONG / SHORT / warmup, and never consumes future prices', strategy => {
    const run = (data: readonly RestCandleRecord[]) => { const session = new HistoricalStrategySession(pair, strategy, 15, start); return data.map(c => session.update(c).decision); };
    const a = run(rows); expect(run(rows)).toEqual(a);
    expect(a.some(d => d?.status === 'WARMING')).toBe(true);
    expect(a.some(d => d?.targetExposure === 'LONG')).toBe(true); expect(a.some(d => d?.targetExposure === 'SHORT')).toBe(true);
    if (strategy === 'vwap-mean-reversion') expect(a.some(d => d?.targetExposure === 'FLAT')).toBe(true);
    const changed = rows.map((c, i) => i < 80 ? c : candle(200, 201, 199, 200, i));
    expect(run(changed).slice(0, 80)).toEqual(a.slice(0, 80));
  });
  it('uses volume-weighted HLC3 and population variance, and stays flat with no volume', () => {
    const session = new HistoricalStrategySession(pair, 'vwap-mean-reversion', 15, start, { vwapPeriod: 3, bandStdDev: '1' });
    const values = [100, 102, 110].map((p, i) => session.update(candle(p, p, p, p, i, i === 2 ? 8 : 1))).at(-1)!;
    const v = values.indicators['vwap'] as { value: string; stdDev: string };
    expect(Number(v.value)).toBeCloseTo(108.2, 10); expect(Number(v.stdDev)).toBeCloseTo(Math.sqrt(13.16), 10);
    const zero = new HistoricalStrategySession(pair, 'vwap-mean-reversion', 15, start, { vwapPeriod: 3 });
    expect(rows.slice(0, 3).map(c => zero.update({ ...c, volume: new Decimal(0) }).decision).at(-1)!.targetExposure).toBe('FLAT');
  });
  it('reconciles enriched report funding and rejects missing provider contract metadata', async () => {
    const metadata = { pair, kind: 'perpetual', quoteCurrency: 'USDT', marginCurrency: 'INR' as const, quantityIncrement: new Decimal('.001'),
      minQuantity: new Decimal('.001'), minTradeSize: new Decimal('.001'), minNotional: new Decimal(1), unitContractValue: new Decimal(1) };
    const getCandles = vi.fn(async () => rows), getInrFuturesInstrument = vi.fn(async () => metadata);
    const config = { coin: 'ETH', strategy: 'supertrend', bars: rows.length, endTimeMs: start + rows.length * interval, inrPerUsdt: 100, fundingRateBpsPer8h: 1 };
    const r = await new PracticalBacktestRunner({ client: { getCandles, getInrFuturesInstrument }, nowMs: () => config.endTimeMs }).run(config);
    expect(r.liveLocked).toBe(true); expect(r.fundingLabel).toBe('Modeled @ 1 bps/8h'); expect(r.summary.totalTrades).toBeGreaterThan(0);
    expect(r.totalFundingInr).toBeCloseTo(r.trades.reduce((n, t) => n + t.fundingInr, 0), 8);
    expect(r.summary.netPnlInr).toBeCloseTo(r.summary.grossPnlInr - r.summary.totalFeesInr + r.summary.totalFundingInr, 7);
    expect(r.summary.netPnlInr).toBeCloseTo(r.trades.reduce((n, t) => n + t.netPnlInr, 0), 7);
    expect(r.equityCurve.at(-1)!.equityInr).toBeCloseTo(5000 + r.summary.netPnlInr, 7);
    expect(getInrFuturesInstrument).toHaveBeenCalledOnce(); expect(virtualContract(metadata, 100).minNotionalInr).toBe('100');
    await expect(new PracticalBacktestRunner({ client: { getCandles }, nowMs: () => config.endTimeMs }).run(config)).rejects.toThrow('INSTRUMENT_METADATA_REQUIRED');
  });
  it('resolves liquidation before a same-candle strategy reversal and publishes the liquidation KPI', async () => {
    const data = Array.from({ length: 40 }, (_, i) => i < 10 ? candle(100 + i, 100.1 + i, 99.9 + i, 100 + i, i) : candle(90, 91, i === 10 ? 80 : 89, 90, i));
    const client = { getCandles: async () => data, getInrFuturesInstrument: async () => ({ pair, kind: 'perpetual', quoteCurrency: 'USDT', marginCurrency: 'INR' as const,
      quantityIncrement: new Decimal('.001'), minQuantity: new Decimal('.001'), minTradeSize: new Decimal('.001'), minNotional: new Decimal(1), unitContractValue: new Decimal(1) }) };
    const r = await new PracticalBacktestRunner({ client, nowMs: () => start + 40 * interval }).run({ coin: 'ETH', bars: 40, endTimeMs: start + 40 * interval,
      strategy: 'ema-trend', parameters: { fastPeriod: 2, slowPeriod: 3 }, leverage: 20, inrPerUsdt: 100, stopLossMode: 'PERCENT', stopLossValue: 1 });
    expect(r.trades[0]!.exitReason).toBe('LIQUIDATION'); expect(r.summary.liquidationCount).toBeGreaterThan(0);
  });
});
