import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { CoinDcxClient } from '../../../src/integration/coindcx/client';
import { createDashboardServer } from '../../../src/dashboard/server';
import { WorkspaceStore } from '../../../src/dashboard/workspace-store';
import { instrument, profile } from './audit-a2-helpers';
import type { HistoricalCandleQuery } from '../../../src/market-data/rest-candle-reader';

const start = Date.parse('2026-01-01T00:00:00Z'), minute = 60_000, now = start + 1350 * minute;
const fixtures: { root: string; stop: () => Promise<void> }[] = [];
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coindcx-foundation-'));
  const getCandles = vi.fn(async (q: HistoricalCandleQuery) => Array.from({ length: Math.floor((q.to - q.from + 1) / minute) }, (_, i) => {
    const price = new Decimal(100).plus(new Decimal(q.from - start + i * minute).div(minute).div(100));
    return { pair: q.pair, openTimeMs: q.from + i * minute, open: price, high: price.plus('.1'), low: price.minus('.1'), close: price, volume: new Decimal(10), quoteVolume: null };
  }));
  const client = Object.assign(new CoinDcxClient(), { getCandles });
  vi.spyOn(client, 'getInrFuturesInstrument').mockResolvedValue(instrument('ETH'));
  const app = await createDashboardServer({ client, profiles: ['BTC', 'ETH', 'SOL'].map(profile), clock: { nowMs: () => now }, reportDirectory: root,
    budgetStats: () => ({}), readSettlementConversion: vi.fn(async () => { throw new Error('UNEXPECTED_PRIVATE_READ'); }) });
  fixtures.push({ ...app, root }); return { ...app, root, getCandles };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await f.stop(); const target = fs.realpathSync(f.root);
    if (path.dirname(target) !== fs.realpathSync(os.tmpdir()) || !path.basename(target).startsWith('coindcx-foundation-')) throw new Error('TEST_CLEANUP_PATH_REFUSED');
    fs.rmSync(target, { recursive: true });
  }
});
describe('Perpetual foundation HTTP and persistence', () => {
  it('runs an actual minute-archive 45m ATR/RR/BE/GST replay and preserves all accounting in JSON evidence', async () => {
    const f = await fixture();
    const body = { coin: 'ETH', timeframe: '45m', strategy: 'supertrend', bars: 30, capitalInr: 5000, maxOrderNotionalInr: 20000, leverage: 5, inrPerUsdt: 100,
      stopLossMode: 'ATR', takeProfitMode: 'RR_MULTIPLE', slAtrMult: 2, tpRrMultiple: 2, breakevenAt1R: true, gstRatePct: 18, cooldownBars: 1 };
    const r = (await request(f.app).post('/api/backtest/run').send(body).expect(200)).body;
    expect(r.config).toMatchObject(body); expect(r.liveLocked).toBe(true); expect(r.protectionMode).toBe('1M');
    expect(r.summary.totalTrades).toBeGreaterThan(0); expect(r.summary.gstInr).toBeGreaterThan(0);
    expect(r.summary.netPnlInr).toBeCloseTo(r.summary.grossPnlInr - r.summary.totalFeesInr + r.summary.totalFundingInr, 7);
    expect(r.summary.gstInr).toBeCloseTo(r.trades.reduce((n: number, t: { gstInr: number }) => n + t.gstInr, 0), 7);
    expect(f.getCandles.mock.calls.every(([q]) => q.resolution === '1')).toBe(true);
    f.getCandles.mockClear(); const replay = (await request(f.app).post('/api/backtest/run').send(body).expect(200)).body;
    expect(replay.runId).toBe(r.runId); expect(f.getCandles).not.toHaveBeenCalled();
    const saved = await request(f.app).get(`/api/reports/export?id=${r.runId}&format=json`).expect(200);
    expect(JSON.parse(saved.text)).toMatchObject({ liveLocked: true, report: { protectionMode: '1M', summary: { gstInr: r.summary.gstInr } } });
  });
  it('defaults new API presets to 18% GST while keeping raw runner compatibility and restartable controls', async () => {
    const f = await fixture();
    const p = (await request(f.app).post('/api/strategies').send({ name: 'ATR foundation', strategy: 'supertrend', timeframe: '45m',
      slMode: 'ATR', slValue: 0, tpMode: 'RR_MULTIPLE', tpValue: 0, sizingMode: 'RISK_PERCENT', breakevenAt1R: true, cooldownBars: 2,
      holdSignalOnZero: true, use4hTrend200: true, costGateMult: 2 }).expect(201)).body;
    expect(p).toMatchObject({ gstRatePct: 18, sizingMode: 'RISK_PERCENT', breakevenAt1R: true, use4hTrend200: true });
    const store = await WorkspaceStore.open(f.root, () => now);
    expect(store.snapshot().savedStrategies[0]).toMatchObject(p); expect((await store.verifyPersistence()).status).toBe('VERIFIED');
    const workspace = (await request(f.app).get('/api/workspace').expect(200)).body; expect(workspace.liveLocked).toBe(true);
    await request(f.app).post('/api/backtest/run').send({ coin: 'ETH', sizingMode: 'RISK_PERCENT', stopLossMode: 'NONE' }).expect(400);
  });
});
