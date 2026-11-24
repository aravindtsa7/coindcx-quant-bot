import { describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { CoinDcxFuturesCandleRestReader, type HistoricalCandleQuery, type RestCandleRecord } from '../../../src/market-data/rest-candle-reader';
import { HistoricalStrategySession, VirtualFillBook, parseBacktestConfig, PracticalBacktestRunner, fetchHistoricalCandles } from '../../../src/integration/coindcx/live/practical-backtest-runner';
import { parseBacktestArguments } from '../../../scripts/run-backtest';

const step = 900_000, start = Math.floor(1_780_000_000_000 / step) * step;
const getInrFuturesInstrument = async (pair: string) => ({ pair, kind: 'perpetual', quoteCurrency: 'USDT', marginCurrency: 'INR' as const,
  quantityIncrement: new Decimal('0.000000000000000001'), minQuantity: new Decimal('0.000000000000000001'), minTradeSize: new Decimal('0.000000000000000001'),
  minNotional: new Decimal('.01'), unitContractValue: new Decimal(1) });
function fixture(count = 80, price: (index: number) => number = index => 100 + index * 0.1) {
  const records: RestCandleRecord[] = Array.from({ length: count }, (_, i) => {
    const p = new Decimal(price(i));
    return { pair: 'B-SOL_USDT', openTimeMs: start + i * step, open: p, close: p, high: p.plus('.01'), low: p.minus('.01'), volume: new Decimal(10), quoteVolume: null };
  });
  const getCandles = vi.fn(async (query: HistoricalCandleQuery) => records.filter(c => c.openTimeMs >= query.from && c.openTimeMs <= query.to));
  const config = { coin: 'SOL', timeframe: '15m', bars: count, capitalInr: 5000, maxOrderNotionalInr: 700, inrPerUsdt: 100,
    endTimeMs: start + count * step, takerFeeBps: 5, slippageBps: 2, spreadBps: 0, stopSlippageBps: 0 };
  const runner = new PracticalBacktestRunner({ client: { getCandles, getInrFuturesInstrument }, nowMs: () => config.endTimeMs });
  return { records, getCandles, config, runner };
}
describe('PracticalBacktestRunner', () => {
  it('uses the actual EMA kernel, fills at the next open, and reconciles fees, equity and the ledger', async () => {
    const f = fixture(), r = await f.runner.run(f.config), first = r.trades[0]!;
    expect(first.entryTimeIso).toBe(new Date(start + 21 * step).toISOString());
    expect(first.entryPrice).toBeCloseTo(f.records[21]!.open.times('1.0002').toNumber(), 8);
    expect(first.entryPrice * first.quantity * 100).toBeCloseTo(700, 5);
    expect(first.feeInr).toBeCloseTo((first.entryPrice + first.exitPrice) * first.quantity * 100 * .0005, 7);
    expect(first.exitReason).toBe('END_OF_DATA');
    expect(r.summary.netPnlInr).toBeCloseTo(r.summary.grossPnlInr - r.summary.totalFeesInr, 7);
    expect(r.equityCurve.at(-1)!.equityInr).toBeCloseTo(5000 + r.summary.netPnlInr, 7);
    expect(r.equityCurve).toHaveLength(81); expect(r.candles).toHaveLength(80);
    expect(r.sizingMode).toBe('BOUNDED_RESEARCH'); expect(r.summary.fundingNote).toBe('Funding excluded');
    expect(r.summary.profitFactor).toBeNull(); // Undefined with no losing trades, JSON stays finite.
  });
  it('is deterministic for identical input and records reproducible effective FX and end time', async () => {
    const f = fixture(); const a = await f.runner.run(f.config), b = await f.runner.run(f.config);
    expect(a).toEqual(b); expect(a.runId).toMatch(/^bt-[a-f0-9]{24}$/);
    expect(a.config.inrPerUsdt).toBe(100); expect(a.config.endTimeMs).toBe(f.config.endTimeMs);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
  it.each(['ema-trend', 'rsi-momentum', 'atr-breakout'])('evaluates %s without synthetic signals', async strategy => {
    const f = fixture(80, i => 100 + Math.sin(i / 3) * 3);
    const r = await f.runner.run({ ...f.config, strategy });
    expect(r.summary.totalTrades).toBeGreaterThan(0); expect(r.trades.some(t => t.side === 'LONG')).toBe(true);
    expect(r.trades.some(t => t.side === 'SHORT')).toBe(true);
    for (const trade of r.trades) {
      expect(trade.entryPrice * trade.quantity * 100).toBeLessThanOrEqual(700.000001);
      expect(Date.parse(trade.entryTimeIso)).toBeLessThanOrEqual(Date.parse(trade.exitTimeIso));
    }
  });
  it('does not use future prices in earlier decisions or fills', async () => {
    const a = fixture(), b = fixture(80, i => i < 45 ? 100 + i * .1 : 200 - i);
    const ra = await a.runner.run(a.config), rb = await b.runner.run(b.config);
    expect(ra.equityCurve.slice(0, 46)).toEqual(rb.equityCurve.slice(0, 46));
    expect(ra.trades[0]!.entryTimeIso).toBe(rb.trades[0]!.entryTimeIso);
    expect(ra.trades[0]!.entryPrice).toBe(rb.trades[0]!.entryPrice);
  });
  it('charges selected maker/taker fees on both legs and adverse slippage', async () => {
    const f = fixture();
    const noCosts = await f.runner.run({ ...f.config, slippageBps: 0, takerFeeBps: 0 });
    const taker = await f.runner.run(f.config), maker = await f.runner.run({ ...f.config, fillLiquidity: 'MAKER', makerFeeBps: 2 });
    expect(noCosts.summary.totalFeesInr).toBe(0);
    expect(noCosts.summary.netPnlInr).toBeGreaterThan(taker.summary.netPnlInr);
    expect(maker.summary.totalFeesInr).toBeCloseTo(taker.summary.totalFeesInr * .4, 7);
    expect(maker.summary.netPnlInr).toBeGreaterThan(taker.summary.netPnlInr);
  });
  it('handles a gapped protective stop, counts losses and measures marked drawdown', async () => {
    const f = fixture(80, i => i < 35 ? 100 + i * .1 : 90 + (i - 35) * .01);
    const r = await f.runner.run({ ...f.config, slippageBps: 0, stopLossMode: 'PERCENT', stopLossValue: 1 });
    const stopped = r.trades.find(t => t.exitReason === 'STOP_LOSS')!;
    expect(stopped.exitPrice).toBe(90); expect(stopped.netPnlInr).toBeLessThan(0);
    expect(r.summary.maxDrawdownPct).toBeGreaterThan(0);
    expect(r.summary.profitFactor).toBeTypeOf('number');
    expect(r.summary.netPnlInr).toBeCloseTo(r.trades.reduce((sum, t) => sum + t.netPnlInr, 0), 7);
  });
  it('caps allocation to isolated buying power including entry fees when requested notional is larger', async () => {
    const f = fixture(); const r = await f.runner.run({ ...f.config, capitalInr: 100, maxOrderNotionalInr: 10000 });
    const t = r.trades[0]!;
    expect(t.entryPrice * t.quantity * 100 / 3 + t.entryPrice * t.quantity * 100 * .0005).toBeCloseTo(100, 5);
  });
  it('returns finite zero metrics and an empty ledger when the strategy stays flat', async () => {
    const f = fixture(80, () => 100), r = await f.runner.run(f.config);
    expect(r.trades).toEqual([]); expect(r.summary.totalTrades).toBe(0); expect(r.summary.netPnlInr).toBe(0);
    expect(r.summary.profitFactor).toBeNull(); expect(r.summary.winRatePct).toBe(0); expect(r.summary.maxDrawdownPct).toBe(0);
  });
  it('paginates 1000 bars with the selected resolution', async () => {
    const f = fixture(1000); await f.runner.run(f.config);
    expect(f.getCandles).toHaveBeenCalledTimes(5);
    expect(f.getCandles.mock.calls.every(([q]) => q.resolution === '15' && q.to - q.from < step * 200)).toBe(true);
  });
  it('rejects missing, conflicting, malformed and forming candles', async () => {
    const missing = fixture(); missing.records.splice(40, 1);
    await expect(missing.runner.run(missing.config)).rejects.toThrow('INCOMPLETE_CANDLE_HISTORY');
    const conflict = fixture(); conflict.getCandles.mockImplementation(async () => [...conflict.records, { ...conflict.records[0]!, close: new Decimal('100.005') }]);
    await expect(conflict.runner.run(conflict.config)).rejects.toThrow('CONFLICTING_CANDLE');
    const invalid = fixture(); invalid.records[0] = { ...invalid.records[0]!, high: new Decimal(1) };
    await expect(invalid.runner.run(invalid.config)).rejects.toThrow('INVALID_CANDLE');
    const forming = fixture(); forming.records.push({ ...forming.records.at(-1)!, openTimeMs: forming.config.endTimeMs });
    expect((await forming.runner.run(forming.config)).candles).toHaveLength(80);
  });
  it('validates configuration, requires real conversion or an explicit rate, and honors abort', async () => {
    const f = fixture();
    await expect(f.runner.run({ ...f.config, bars: 1001 })).rejects.toThrow();
    await expect(f.runner.run({ ...f.config, takerFeeBps: -1 })).rejects.toThrow();
    await expect(f.runner.run({ ...f.config, inrPerUsdt: undefined })).rejects.toThrow('INR_CONVERSION_REQUIRED');
    await expect(f.runner.run({ ...f.config, endTimeMs: f.config.endTimeMs + step })).rejects.toThrow('FUTURE_HISTORY_REFUSED');
    const controller = new AbortController(); controller.abort();
    await expect(fetchHistoricalCandles({ getCandles: f.getCandles }, { pair: 'B-SOL_USDT', resolution: '15', bars: 80, endTimeMs: f.config.endTimeMs, signal: controller.signal })).rejects.toThrow();
    expect(f.getCandles).not.toHaveBeenCalled();
  });
  it('captures the current conversion snapshot explicitly when no fixed rate is supplied', async () => {
    const f = fixture(), readInrPerUsdt = vi.fn(async () => 106);
    const r = await new PracticalBacktestRunner({ client: { getCandles: f.getCandles, getInrFuturesInstrument }, nowMs: () => f.config.endTimeMs, readInrPerUsdt })
      .run({ ...f.config, inrPerUsdt: undefined });
    expect(readInrPerUsdt).toHaveBeenCalledOnce(); expect(r.conversion).toEqual({ inrPerUsdt: 106, source: 'CURRENT_PROVIDER_SNAPSHOT' });
  });
  it('parses the documented CLI and refuses invalid/unknown options', () => {
    const config = parseBacktestArguments(['--coin', 'SOL', '--timeframe', '15m', '--strategy', 'ema-trend', '--bars', '300', '--capital-inr', '5000', '--max-inr', '700']);
    expect(config).toMatchObject({ coin: 'SOL', timeframe: '15m', bars: 300, capitalInr: 5000, maxOrderNotionalInr: 700 });
    expect(() => parseBacktestArguments(['--bars', 'oops'])).toThrow();
    expect(() => parseBacktestArguments(['--confirm-live'])).toThrow();
  });
});

describe('Historical candle transport', () => {
  it.each(['1', '5', '15', '60'] as const)('requests resolution %s using the reviewed reader and excludes forming bars', async resolution => {
    const interval = Number(resolution) * 60_000, now = Math.floor(1_780_000_000_000 / interval) * interval;
    const httpTransport = vi.fn(async (_url: string) => JSON.stringify({ s: 'ok', data: [now - interval, now].map(time => ({ time, open: '100', high: '101', low: '99', close: '100.1', volume: '10' })) }));
    const reader = new CoinDcxFuturesCandleRestReader({ clock: { nowMs: () => now }, httpTransport });
    const result = await reader.getCandles({ pair: 'B-SOL_USDT', from: now - interval, to: now + interval, resolution });
    expect(httpTransport.mock.calls[0]?.[0]).toContain(`resolution=${resolution}&pcode=f`);
    expect(result).toHaveLength(1); expect(result[0]!.openTimeMs).toBe(now - interval);
  });
  it('refuses before HTTP when the shared M2 read budget refuses', async () => {
    const acquire = vi.fn(async () => ({ kind: 'REFUSED' as const, reason: 'TEST_BLOCK' }));
    const reader = new CoinDcxFuturesCandleRestReader({ readBudget: { scope: 'PUBLIC', budget: { acquire } } });
    await expect(reader.getCandles({ pair: 'B-SOL_USDT', from: start, to: start + step, resolution: '15' })).rejects.toThrow('TEST_BLOCK');
    expect(acquire).toHaveBeenCalledOnce();
  });
});

describe('Configured SL/TP and execution evidence', () => {
  function book(side: 'LONG' | 'SHORT', config: Record<string, unknown>) {
    const f = fixture(80, i => side === 'LONG' ? 100 + i : 200 - i);
    const session = new HistoricalStrategySession('B-SOL_USDT', 'ema-trend', 15, start);
    const decision = f.records.slice(0, 21).map(c => session.update(c).decision).at(-1)!;
    const model = new VirtualFillBook(parseBacktestConfig({ ...f.config, takerFeeBps: 0, slippageBps: 0, spreadBps: 0, stopSlippageBps: 0, ...config }), 100);
    expect(model.entry(decision!, new Decimal(100), start + 21 * step)).toBe(true);
    const candle = (low: number, high: number, open = 100) => ({ ...f.records[22]!, open: new Decimal(open), close: new Decimal(open), low: new Decimal(low), high: new Decimal(high) });
    return { model, candle };
  }
  it.each(['LONG', 'SHORT'] as const)('triggers percent SL and TP for %s with conservative double-hit priority', side => {
    const sl = book(side, { stopLossMode: 'PERCENT', stopLossValue: 1, takeProfitMode: 'PERCENT', takeProfitValue: 2 });
    const stopped = sl.model.protection(sl.candle(97, 103), start + 23 * step)!;
    expect(stopped.exitReason).toBe('STOP_LOSS'); expect(stopped.exitPrice).toBe(side === 'LONG' ? 99 : 101);
    const tp = book(side, { stopLossMode: 'PERCENT', stopLossValue: 1, takeProfitMode: 'PERCENT', takeProfitValue: 2 });
    const profit = tp.model.protection(tp.candle(side === 'LONG' ? 99.5 : 97, side === 'LONG' ? 103 : 100.5), start + 23 * step)!;
    expect(profit.exitReason).toBe('TAKE_PROFIT'); expect(profit.exitPrice).toBe(side === 'LONG' ? 102 : 98);
    expect(profit.netPnlInr).toBeCloseTo(14, 8);
  });
  it.each(['LONG', 'SHORT'] as const)('converts exact INR thresholds through actual notional for %s', side => {
    const sl = book(side, { stopLossMode: 'INR', stopLossValue: 50, takeProfitMode: 'INR', takeProfitValue: 100 });
    const trade = sl.model.protection(sl.candle(80, 120), start + 23 * step)!;
    expect(trade.exitReason).toBe('STOP_LOSS'); expect(trade.grossPnlInr).toBeCloseTo(-50, 7);
    const tp = book(side, { takeProfitMode: 'INR', takeProfitValue: 100 });
    const profit = tp.model.protection(tp.candle(80, 120), start + 23 * step)!;
    expect(profit.exitReason).toBe('TAKE_PROFIT'); expect(profit.grossPnlInr).toBeCloseTo(100, 7);
  });
  it('defaults protection to NONE and never invents a protective stop', () => {
    const f = book('LONG', {}); expect(f.model.state.position!.stopPrice).toBeNull(); expect(f.model.state.position!.takeProfitPrice).toBeNull();
    expect(f.model.protection(f.candle(80, 120), start + 23 * step)).toBeNull();
  });
  it('applies half spread and distinct stop slippage, and gives no favorable TP gap improvement', () => {
    const f = book('LONG', { stopLossMode: 'PERCENT', stopLossValue: 1, spreadBps: 2, slippageBps: 3, stopSlippageBps: 9 });
    expect(Number(f.model.state.position!.entryPrice)).toBeCloseTo(100.04, 8);
    const trade = f.model.protection(f.candle(89, 91, 90), start + 23 * step)!;
    expect(trade.exitPrice).toBeCloseTo(90 * (1 - .001), 8);
    const target = book('LONG', { takeProfitMode: 'PERCENT', takeProfitValue: 2 });
    expect(target.model.protection(target.candle(104, 106, 105), start + 23 * step)!.exitPrice).toBe(102);
  });
  it('records all four chronological event types with exact decision and armed prices', async () => {
    const f = fixture(), r = await f.runner.run({ ...f.config, stopLossMode: 'PERCENT', stopLossValue: 1, takeProfitMode: 'PERCENT', takeProfitValue: 2 });
    const t = r.trades[0]!; expect(t.events.map(e => e.type)).toEqual(['DECISION_RECORDED', 'ENTRY_FILL', 'SL_TP_ARMED', 'EXIT_FILL']);
    expect(t.events[0]!.timestampMs).toBeLessThanOrEqual(t.events[1]!.timestampMs);
    expect(t.events[2]!.details['stopPrice']).not.toBeNull(); expect(t.events[2]!.details['takeProfitPrice']).not.toBeNull();
    expect(t.exitReason).toBe('TAKE_PROFIT');
  });
  it('rejects zero/negative enabled thresholds and percent distances at or above 100%', () => {
    for (const input of [{ stopLossMode: 'PERCENT', stopLossValue: 0 }, { takeProfitMode: 'INR', takeProfitValue: -1 }, { stopLossMode: 'PERCENT', stopLossValue: 100 }]) {
      expect(() => parseBacktestConfig({ coin: 'SOL', ...input })).toThrow();
    }
    expect(parseBacktestArguments(['--sl-mode', 'percent', '--sl-value', '1', '--tp-mode', 'inr', '--tp-value', '100'])).toMatchObject({ stopLossMode: 'PERCENT', stopLossValue: 1, takeProfitMode: 'INR', takeProfitValue: 100, spreadBps: 1, stopSlippageBps: 5 });
  });
  it('uses only complete higher-timeframe candles for the actual multi-timeframe kernel', async () => {
    const f = fixture(240), r = await f.runner.run({ ...f.config, strategy: 'multi-timeframe-trend', parameters: { fastPeriod: 3, slowPeriod: 5, timeframes: [15, 60] } });
    expect(r.trades.length).toBeGreaterThan(0); expect(Date.parse(r.trades[0]!.entryTimeIso)).toBeGreaterThan(start + 5 * 60 * 60_000);
    expect(r.trades[0]!.events[0]!.details['strategyInstanceId']).toMatch(/^[a-f0-9]{64}$/);
  });
});
