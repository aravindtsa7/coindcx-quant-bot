import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { CoinDcxClient } from '../../../src/integration/coindcx/client';
import { createDashboardServer } from '../../../src/dashboard/server';
import { WorkspaceEngine } from '../../../src/dashboard/workspace-engine';
import { WorkspaceStore } from '../../../src/dashboard/workspace-store';
import { FUTURES_STRATEGY_DEFAULTS, type FuturesStrategyId } from '../../../src/integration/coindcx/live/futures-strategies';
import type { HistoricalCandleQuery } from '../../../src/market-data/rest-candle-reader';
import { readBotSettlementConversion } from '../../../src/integration/coindcx/live/practical-bot-evaluation';
import { instrument, profile } from './audit-a2-helpers';

const start = Date.parse('2026-01-01T00:00:00Z'), now = start + 240 * 30 * 60_000;
const fixtures: { root: string; stop: () => Promise<void> }[] = [];
async function fixture(mssSignal = false) {
  const clock = { value: now, nowMs() { return this.value; } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coindcx-futures-kernels-'));
  const getCandles = vi.fn(async (q: HistoricalCandleQuery) => {
    const step = Number(q.resolution) * 60_000;
    return Array.from({ length: Math.floor((q.to - q.from + 1) / step) }, (_, i) => {
      const time = q.from + i * step, value = new Decimal(100);
      const index = (time - start) / (30 * 60_000);
      if (mssSignal && index >= 239) {
        const prices = index === 239 ? [98.8, 101.2, 98.5, 101, 100] : index === 240 ? [101.3, 102.5, 101.2, 102, 100] : [102, 102.2, 101.8, 102, 10];
        return { pair: q.pair, openTimeMs: time, open: new Decimal(prices[0]!), high: new Decimal(prices[1]!), low: new Decimal(prices[2]!), close: new Decimal(prices[3]!), volume: new Decimal(prices[4]!), quoteVolume: null };
      }
      return { pair: q.pair, openTimeMs: time, open: value, high: value.plus('.5'), low: value.minus('.5'), close: value, volume: new Decimal(10), quoteVolume: null };
    });
  });
  const client = Object.assign(new CoinDcxClient(), { getCandles });
  vi.spyOn(client, 'getInrFuturesInstrument').mockResolvedValue({ ...instrument('ETH'), ...(mssSignal ? { minNotional: new Decimal(6) } : {}), dynamicPositionLeverageTiers: [{ leverage: new Decimal(20), maxPositionSizeUsdt: new Decimal(5000) }] });
  const result = await createDashboardServer({ client, profiles: ['BTC', 'ETH', 'SOL'].map(profile), clock, reportDirectory: root,
    budgetStats: () => ({}), readSettlementConversion: vi.fn(async () => readBotSettlementConversion([{ symbol: 'USDTINR', margin_currency_short_name: 'INR', target_currency_short_name: 'USDT', conversion_price: '100', last_updated_at: clock.value - 1000 }], clock.value)) });
  fixtures.push({ ...result, root }); return { ...result, root, clock };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await f.stop(); const target = fs.realpathSync(f.root);
    if (path.dirname(target) !== fs.realpathSync(os.tmpdir()) || !path.basename(target).startsWith('coindcx-futures-kernels-')) throw new Error('TEST_CLEANUP_PATH_REFUSED');
    fs.rmSync(target, { recursive: true });
  }
});
describe('Futures strategies across workspace API contracts', () => {
  it('admits an actual MSS event through M7, fills only at the next open, and holds the neutral event after restart', async () => {
    const f = await fixture(true);
    const session = await f.engine.createPaper({ coin: 'ETH', strategy: 'liquidity_sweep_mss', timeframe: '30m', bars: 150,
      capitalInr: 125000, maxOrderNotionalInr: 700, leverage: 5, stopLossMode: 'PERCENT', stopLossValue: 3, gstRatePct: 18, breakevenAt1R: true });
    const queued = await f.engine.stepPaper(session.id);
    expect(queued.lastRisk, JSON.stringify(queued.lastRisk)).toMatchObject({ status: 'ACCEPTED', action: 'OPEN' });
    expect(queued.orders).toHaveLength(1); expect(queued.orders[0]!.status).toBe('Working'); expect(queued.fills).toHaveLength(0);
    f.clock.value += 30 * 60_000;
    const filled = await f.engine.stepPaper(session.id);
    expect(filled.orders[0]!.status).toBe('Filled'); expect(filled.fills).toHaveLength(1); expect(filled.book.position!.side).toBe('LONG');
    expect(filled.fills[0]!.timestampMs).toBe(now);
    const reopened = await WorkspaceStore.open(f.root, () => f.clock.value);
    expect(reopened.snapshot().paperSessions[0]!.book.position).toEqual(filled.book.position);
    const restarted = new WorkspaceEngine(reopened, f.engine.options, f.engine.reports, f.engine.signal);
    f.clock.value += 30 * 60_000;
    const held = await restarted.stepPaper(session.id);
    expect(held.book.position!.side).toBe('LONG'); expect(held.fills).toHaveLength(1);
    expect(held.orders).toHaveLength(1);
  });

  it.each(Object.keys(FUTURES_STRATEGY_DEFAULTS) as FuturesStrategyId[])('%s saves/reloads a preset and runs backtest, matrix, validation and paper with the same defaults', async strategy => {
    const f = await fixture();
    const preset = (await request(f.app).post('/api/strategies').send({ name: strategy, strategy, timeframe: '30m',
      slMode: 'PERCENT', slValue: 3, tpMode: 'PERCENT', tpValue: 2.5 }).expect(201)).body;
    const expected = { holdSignalOnZero: true, use4hTrend100: FUTURES_STRATEGY_DEFAULTS[strategy].use4hTrend100,
      use4hTrend200: FUTURES_STRATEGY_DEFAULTS[strategy].use4hTrend200, costGateMult: FUTURES_STRATEGY_DEFAULTS[strategy].costGateMult };
    expect(preset).toMatchObject({ ...expected, gstRatePct: 18 });
    const reopened = await WorkspaceStore.open(f.root, () => now);
    expect(reopened.snapshot().savedStrategies[0]).toEqual(preset); expect((await reopened.verifyPersistence()).status).toBe('VERIFIED');
    const common = { strategy, timeframe: '30m', bars: 150, inrPerUsdt: 100, gstRatePct: 18, breakevenAt1R: true,
      stopLossMode: 'PERCENT', stopLossValue: 3, takeProfitMode: 'PERCENT', takeProfitValue: 2.5 };
    const replay = (await request(f.app).post('/api/backtest/run').send({ coin: 'ETH', ...common }).expect(200)).body;
    expect(replay.config).toMatchObject(expected); expect(replay.liveLocked).toBe(true);
    const matrix = (await request(f.app).post('/api/matrix/run').send({ coins: ['ETH'], ...common }).expect(200)).body;
    expect(matrix.cells).toHaveLength(1); expect(matrix.cells[0].status).toBe('COMPLETED');
    const validation = (await request(f.app).post('/api/validation/run').send({ coins: ['ETH'], ...common }).expect(200)).body;
    expect(validation.byPair[0].candidates[0].folds.map((fold: { name: string }) => fold.name)).toEqual(['TRAIN', 'OOS', 'HOLDOUT']);
    const paper = (await request(f.app).post('/api/paper/sessions').send({ name: strategy, coin: 'ETH', ...common }).expect(201)).body;
    expect(paper.config).toMatchObject(expected);
    const step = (await request(f.app).post(`/api/paper/sessions/${paper.id}/step`).send({}).expect(res => { expect(res.status, JSON.stringify(res.body)).toBe(200); })).body;
    expect(step.lastProcessedOpenMs).toBe(now - 30 * 60_000);
    expect((await request(f.app).get('/api/workspace').expect(200)).body.liveLocked).toBe(true);
  });
});
