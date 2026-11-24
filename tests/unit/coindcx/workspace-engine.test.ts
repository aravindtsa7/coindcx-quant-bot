import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { CoinDcxClient } from '../../../src/integration/coindcx/client';
import { Decimal } from '../../../src/core/decimal/decimal';
import type { HistoricalCandleQuery } from '../../../src/market-data/rest-candle-reader';
import { readBotSettlementConversion } from '../../../src/integration/coindcx/live/practical-bot-evaluation';
import { createDashboardServer } from '../../../src/dashboard/server';
import { evidenceDigest } from '../../../src/dashboard/evidence';
import { WorkspaceStore, workspaceId } from '../../../src/dashboard/workspace-store';
import { deferred, instrument, profile } from './audit-a2-helpers';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('coindcx-workspace-test-')) throw new Error('TEST_CLEANUP_PATH_REFUSED');
    fs.rmSync(resolved, { recursive: true });
  }
});
const start = Math.floor(1_780_000_000_000 / 3_600_000) * 3_600_000;
async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coindcx-workspace-test-')); directories.push(directory);
  const clock = { value: start + 600 * 60_000, nowMs() { return this.value; } };
  let missing: number | null = null;
  let price = (i: number) => new Decimal(100).plus(new Decimal(i).times('.05'));
  const getCandles = vi.fn(async (query: HistoricalCandleQuery) => {
    const interval = Number(query.resolution) * 60_000;
    const bars = Array.from({ length: Math.floor((query.to - query.from + 1) / interval) }, (_, i) => {
      const time = query.from + i * interval, p = price((time - start) / 60_000);
      return { pair: query.pair, openTimeMs: time, open: p, close: p, high: p.plus('.01'), low: p.minus('.01'), volume: new Decimal(10), quoteVolume: null };
    }); return bars.filter(b => b.openTimeMs !== missing);
  });
  const client = Object.assign(new CoinDcxClient(), { getCandles });
  vi.spyOn(client, 'getInrFuturesInstrument').mockImplementation(async pair => ({ ...instrument(pair.slice(2).split('_')[0]!), minNotional: new Decimal(6),
    unitContractValue: new Decimal(1), quantityIncrement: new Decimal('.0001'), minQuantity: new Decimal('.0001'), minTradeSize: new Decimal('.0001'), priceIncrement: new Decimal('.0001'),
    dynamicPositionLeverageTiers: [{ leverage: new Decimal(20), maxPositionSizeUsdt: new Decimal(5000) }] }));
  const readSettlementConversion = vi.fn(async () => readBotSettlementConversion([{ symbol: 'USDTINR', margin_currency_short_name: 'INR',
    target_currency_short_name: 'USDT', conversion_price: '100', last_updated_at: clock.value - 1000 }], clock.value));
  const options = { client, clock, reportDirectory: directory, profiles: ['BTC', 'ETH', 'SOL'].map(profile), readSettlementConversion,
    budgetStats: () => ({ connected: true, admission: 'OPEN', unknown: false, blockedScopes: [] }) };
  const dashboard = await createDashboardServer(options);
  return { ...dashboard, options, directory, clock, client, getCandles, readSettlementConversion,
    setMissing: (time: number) => { missing = time; }, setPrice: (value: typeof price) => { price = value; } };
}
const paperConfig = { coin: 'SOL', strategy: 'ema-trend', timeframe: '1m', bars: 60, capitalInr: 125000, maxOrderNotionalInr: 700,
  slippageBps: 0, spreadBps: 0, stopSlippageBps: 0, stopLossMode: 'PERCENT', stopLossValue: 1, takeProfitMode: 'PERCENT', takeProfitValue: 2 };

describe('Workspace persistence, settings and audit', () => {
  it('opens legacy settings without changing their checksum and persists the new preferences', async () => {
    const f = await fixture(), file = path.join(f.directory, 'workspace-state.json');
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    old.state = Object.fromEntries(Object.entries(old.state).reverse()); // V1 files may retain a different key order.
    old.contentSha256 = evidenceDigest(old.state);
    const original = JSON.stringify(old); fs.writeFileSync(file, original);
    expect(JSON.parse(original).state.settings).toEqual({ language: 'en', timezone: 'Asia/Kolkata', defaultCoin: 'SOL' });
    const legacy = await WorkspaceStore.open(f.directory, () => f.clock.value);
    expect(legacy.snapshot().alerts).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect((await legacy.verifyPersistence()).status).toBe('VERIFIED');
    const preferences = { language: 'ta', timezone: 'UTC', defaultCoin: 'ETH', defaultEquityInr: 125000,
      defaultMaxOrderNotionalInr: 900, defaultSlPct: 1.5, defaultTpPct: 3, notifications: { researchCompletion: false, routineStatus: true } };
    await request(f.app).post('/api/settings').send(preferences).expect(200);
    const reopened = await WorkspaceStore.open(f.directory, () => f.clock.value);
    expect(reopened.snapshot().settings).toEqual(preferences);
    expect(reopened.snapshot().operations.admissionStopped).toBe(false);
    await request(f.app).post('/api/settings').send({ defaultSlPct: 100 }).expect(400);
    await request(f.app).post('/api/settings').send({ defaultMaxOrderNotionalInr: 0 }).expect(400);
    await request(f.app).post('/api/settings').send({ confirmLive: true }).expect(400);
  });
  it('serializes concurrent writes, returns isolated snapshots and persists through restart', async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 10 }, () => f.workspace.mutate(state => { workspaceId(state, 'test'); })));
    const snapshot = f.workspace.snapshot(); expect(snapshot.revision).toBe(10); expect(snapshot.sequence).toBe(10);
    snapshot.settings.language = 'hi'; expect(f.workspace.snapshot().settings.language).toBe('en');
    await f.engine.settings({ language: 'hi', defaultCoin: 'ETH', timezone: 'Asia/Kolkata' });
    const restart = await WorkspaceStore.open(f.directory, () => f.clock.value);
    expect(restart.snapshot().settings).toMatchObject({ language: 'hi', defaultCoin: 'ETH' });
    expect(restart.snapshot().auditLog.at(-1)!.action).toBe('SETTINGS_UPDATED');
    await expect(f.engine.settings({ timezone: 'Invalid/Place' })).rejects.toThrow('INVALID_TIMEZONE');
  });
  it('recovers a checksum-verified backup after corruption and stops admissions with preserved evidence', async () => {
    const f = await fixture(); await f.engine.settings({ language: 'hi' }); await f.engine.settings({ defaultCoin: 'BTC' });
    fs.writeFileSync(path.join(f.directory, 'workspace-state.json'), '{corrupt');
    const recovered = await WorkspaceStore.open(f.directory, () => f.clock.value);
    expect(recovered.snapshot().settings.language).toBe('hi'); expect(recovered.snapshot().operations.admissionStopped).toBe(true);
    expect(recovered.snapshot().alerts[0]!.code).toBe('WORKSPACE_RECOVERED');
    expect(fs.readdirSync(f.directory).some(file => file.startsWith('workspace-state.corrupt-'))).toBe(true);
    const restarted = await createDashboardServer(f.options); expect(restarted.engine.admissionStopped).toBe(true);
  });
  it('detects valid-JSON tampering and recovers empty stopped state without a backup', async () => {
    const f = await fixture();
    const file = path.join(f.directory, 'workspace-state.json'), envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    envelope.state.settings.defaultCoin = 'ETH'; fs.writeFileSync(file, JSON.stringify(envelope));
    const recovered = await WorkspaceStore.open(f.directory, () => f.clock.value);
    expect(recovered.snapshot().operations.admissionStopped).toBe(true); expect(recovered.snapshot().alerts[0]!.severity).toBe('CRITICAL');
  });
  it('recovers a missing primary from backup without silently reopening admissions', async () => {
    const f = await fixture(); await f.engine.settings({ language: 'hi' }); await f.engine.settings({ defaultCoin: 'ETH' });
    fs.renameSync(path.join(f.directory, 'workspace-state.json'), path.join(f.directory, 'displaced-primary.json'));
    const recovered = await WorkspaceStore.open(f.directory, () => f.clock.value);
    expect(recovered.snapshot().settings.language).toBe('hi'); expect(recovered.snapshot().operations.admissionStopped).toBe(true);
  });
  it('saves all four named strategy types with SL/TP and rejects invalid parameters', async () => {
    const f = await fixture();
    for (const strategy of ['ema-trend', 'rsi-momentum', 'atr-breakout', 'multi-timeframe-trend']) {
      const r = await request(f.app).post('/api/strategies').send({ name: strategy, strategy, timeframe: '15m', slMode: 'PERCENT', slValue: 1, tpMode: 'INR', tpValue: 100 }).expect(201);
      expect(r.body).toMatchObject({ strategy, slMode: 'PERCENT', slValue: 1, tpMode: 'INR', tpValue: 100 });
    }
    expect(f.workspace.snapshot().savedStrategies).toHaveLength(4);
    await f.engine.saveStrategy({ name: 'ema-trend', strategy: 'ema-trend', parameters: { fastPeriod: 5, slowPeriod: 10 } });
    expect(f.workspace.snapshot().savedStrategies).toHaveLength(4);
    await expect(f.engine.saveStrategy({ name: 'Invalid', strategy: 'ema-trend', parameters: { fastPeriod: 50, slowPeriod: 10 } })).rejects.toThrow();
  });
});

describe('Research matrix, walk-forward evidence and datasets', () => {
  it.each(['supertrend', 'vwap-mean-reversion'])('reuses %s through presets, HTTP backtests, matrix, validation and restartable paper with futures settings', async strategy => {
    const f = await fixture();
    f.setPrice(i => new Decimal(100 + Math.sin(i / 8) * 3 + (i % 25 === 0 ? -7 : i % 25 === 12 ? 7 : 0)));
    const futures = { leverage: 5, marginMode: 'ISOLATED', maintenanceMarginRateBps: 50, trailingStopPct: 1.5, trailingActivationPct: .5, fundingRateBpsPer8h: 1 };
    const preset = await request(f.app).post('/api/strategies').send({ name: `Futures ${strategy}`, strategy, ...futures,
      slMode: 'PERCENT', slValue: 1, tpMode: 'PERCENT', tpValue: 3 }).expect(201);
    expect(preset.body).toMatchObject({ ...futures, fundingMode: 'MODELED_FIXED_BPS' });
    const bt = await request(f.app).post('/api/backtest/run').send({ coin: 'SOL', strategy, timeframe: '1m', bars: 160, inrPerUsdt: 100, ...futures }).expect(200);
    expect(bt.body.config).toMatchObject({ ...futures, fundingMode: 'MODELED_FIXED_BPS' });
    expect(bt.body.summary).toMatchObject({ fundingLabel: 'Modeled @ 1 bps/8h', liquidationCount: expect.any(Number), skippedMinNotionalCount: expect.any(Number) });
    const matrix = await request(f.app).post('/api/matrix/run').send({ coins: ['SOL'], strategy, timeframe: '1m', bars: 160, inrPerUsdt: 100, ...futures }).expect(200);
    expect(matrix.body.cells).toHaveLength(1); expect(matrix.body.cells[0].status).toBe('COMPLETED'); expect(matrix.body.fundingNote).toContain('modeled');
    const validation = await request(f.app).post('/api/validation/run').send({ coins: ['SOL'], strategy, timeframe: '1m', bars: 300, inrPerUsdt: 100, ...futures }).expect(200);
    expect(validation.body.byPair[0].candidates).toHaveLength(1); expect(validation.body.fundingLabel).toBe('Modeled @ 1 bps/8h');
    const paper = await request(f.app).post('/api/paper/sessions').send({ ...paperConfig, strategy, ...futures }).expect(201);
    const stepped = await request(f.app).post(`/api/paper/sessions/${paper.body.id}/step`).send({}).expect(200);
    expect(stepped.body.config).toMatchObject({ ...futures, fundingMode: 'MODELED_FIXED_BPS' });
    const restarted = await WorkspaceStore.open(f.directory, () => f.clock.value);
    expect(restarted.snapshot().paperSessions[0]!.config).toEqual(stepped.body.config);
    expect((await restarted.verifyPersistence()).status).toBe('VERIFIED');
    const exported = await request(f.app).get(`/api/reports/export?id=${bt.body.runId}&format=json`).expect(200);
    expect(exported.body.fundingNote).toContain('modeled'); expect(exported.body.liveLocked).toBe(true);
  }, 20000);
  it('executes the actual parameter grid with one shared data read and deterministic ranked reports', async () => {
    const f = await fixture();
    const input = { coins: ['SOL'], timeframe: '1m', bars: 120, strategy: 'ema-trend', fastPeriods: [3, 5], slowPeriods: [10, 20], inrPerUsdt: 100,
      stopLossMode: 'PERCENT', stopLossValue: 1, takeProfitMode: 'PERCENT', takeProfitValue: 2 };
    const a = await f.engine.matrix(input);
    const ranked = a.ranked as { runId: string; rank: number; summary: { totalTrades: number } }[];
    expect(ranked).toHaveLength(4); expect(ranked.map(c => c.rank)).toEqual([1, 2, 3, 4]); expect(ranked.every(c => c.summary.totalTrades > 0)).toBe(true);
    expect(new Set(ranked.map(c => c.runId)).size).toBe(4); expect(f.getCandles).toHaveBeenCalledOnce();
    const b = await f.engine.matrix(input); expect(b.ranked).toEqual(a.ranked); expect(a.promotion).toBe('PAPER · no promotion');
    expect(f.workspace.snapshot().researchRuns).toHaveLength(2);
  });
  it('reports invalid grid cells and refuses unbounded matrices', async () => {
    const f = await fixture();
    const r = await f.engine.matrix({ coins: ['SOL'], bars: 60, timeframe: '1m', inrPerUsdt: 100, fastPeriods: [3, 20], slowPeriods: [10] });
    expect((r.cells as { status: string }[]).map(c => c.status)).toEqual(['COMPLETED', 'INVALID']);
    await expect(f.engine.matrix({ coins: ['BTC', 'ETH', 'SOL'], fastPeriods: [1, 2, 3, 4, 5, 6, 7, 8], slowPeriods: [10, 11, 12, 13, 14, 15, 16, 17], inrPerUsdt: 100 })).rejects.toThrow('MATRIX_CELL_LIMIT');
    expect(f.workspace.snapshot().jobs.at(-1)!.status).toBe('FAILED');
  });
  it('uses non-overlapping train/OOS/holdout data and records exact cost stress without promotion', async () => {
    const f = await fixture();
    const result = await f.engine.validate({ coins: ['SOL'], strategy: 'ema-trend', timeframe: '1m', bars: 300, inrPerUsdt: 100, fastPeriods: [3, 5], slowPeriods: [10] });
    const pair = result.byPair[0]!;
    expect(pair.candidates).toHaveLength(2); expect(pair.selectedOnTrain).toBeGreaterThan(0); expect(f.getCandles).toHaveBeenCalledTimes(2);
    for (const c of pair.candidates) {
      expect(c.folds.map(f => f.name)).toEqual(['TRAIN', 'OOS', 'HOLDOUT']); expect(c.folds.map(f => f.bars)).toEqual([180, 60, 60]);
      expect(c.folds[0]!.toMs).toBe(c.folds[1]!.fromMs); expect(c.folds[1]!.toMs).toBe(c.folds[2]!.fromMs);
      expect(c.costStress.totalFeesInr).toBeGreaterThan(c.folds[1]!.summary.totalFeesInr);
    }
    expect(result.selection).toBe('TRAIN_NET_PNL_ONLY'); expect(result.fundingNote).toBe('Funding excluded');
  });
  it('does not use holdout changes to select or rank candidates', async () => {
    const f = await fixture(), input = { coins: ['SOL'], timeframe: '1m', bars: 300, inrPerUsdt: 100, fastPeriods: [3, 5], slowPeriods: [10] };
    const a = await f.engine.validate(input);
    f.setPrice(i => i < 540 ? new Decimal(100).plus(new Decimal(i).times('.05')) : new Decimal(200).minus(new Decimal(i - 540).times('.5')));
    const b = await f.engine.validate(input);
    const view = (r: typeof a) => r.byPair.map(p => ({ selected: p.selectedOnTrain,
      ranked: p.candidates.map(c => ({ parameters: c.parameters, rank: c.rank, train: c.folds[0]!.summary, oos: c.folds[1]!.summary })) }));
    expect(view(a)).toEqual(view(b));
  });
  it('stores incomplete minute data with honest gap evidence and verifies cached dataset integrity', async () => {
    const f = await fixture(); f.setMissing(f.clock.value - 30 * 60_000);
    const result = await f.engine.sync({ coin: 'SOL', timeframe: '1m', bars: 60 });
    expect(result.candles).toHaveLength(59); expect(result.quality).toMatchObject({ complete: false, missingBars: 1, missingMinutes: 1, fabricatedCandles: 0 });
    expect((await f.engine.datasets.read(result.id)).quality).toEqual(result.quality);
    const alert = f.workspace.snapshot().alerts.find(a => a.code === 'DATA_GAPS')!;
    await request(f.app).post(`/api/alerts/${alert.id}/ack`).send({}).expect(200);
    expect(f.workspace.snapshot().alerts.find(a => a.id === alert.id)!.acknowledgedAtMs).not.toBeNull();
    await expect(f.engine.datasets.read('../../.env')).rejects.toThrow('DATASET_NOT_FOUND');
    const file = path.join(f.directory, 'datasets', `${result.id}.json`), cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    cached.candles[0].close = '999'; fs.writeFileSync(file, JSON.stringify(cached));
    await expect(f.engine.datasets.read(result.id)).rejects.toThrow('DATASET_INVALID');
  });
  it('never claims minute coverage for coarser fetched candles', async () => {
    const f = await fixture(), dataset = await f.engine.sync({ coin: 'SOL', timeframe: '15m', bars: 60 });
    expect(dataset.quality.missingMinutes).toBeNull(); expect(dataset.quality.minuteCoverage).toBe('NOT_OBSERVABLE_AT_THIS_RESOLUTION');
  });
  it('invalidates in-flight research even when the operator stops and resumes before data returns', async () => {
    const f = await fixture(), wait = deferred<Awaited<ReturnType<typeof f.getCandles>>>(), implementation = f.getCandles.getMockImplementation()!;
    f.getCandles.mockImplementationOnce(() => wait.promise);
    const pending = f.engine.matrix({ coins: ['SOL'], timeframe: '1m', bars: 60, fastPeriods: [3], slowPeriods: [10], inrPerUsdt: 100 });
    const rejected = expect(pending).rejects.toThrow('OPERATOR_STOPPED');
    await vi.waitFor(() => expect(f.getCandles).toHaveBeenCalledOnce());
    await f.engine.operations(true, {}); await f.engine.operations(false, {});
    wait.resolve(await implementation(f.getCandles.mock.calls[0]![0])); await rejected;
    expect(f.workspace.snapshot().researchRuns).toHaveLength(0); expect(f.workspace.snapshot().jobs.at(-1)!.status).toBe('FAILED');
  });
});

describe('Isolated paper stepping, admission stop and exports', () => {
  it('queues a real M7-approved order, fills at the next eligible open, and is idempotent across restart', async () => {
    const f = await fixture(), session = await f.engine.createPaper(paperConfig);
    const bootstrap = await f.engine.stepPaper(session.id);
    expect(bootstrap.fills).toHaveLength(0); expect(bootstrap.orders).toHaveLength(1); expect(bootstrap.orders[0]!.status).toBe('Working');
    expect(bootstrap.lastRisk).toMatchObject({ status: 'ACCEPTED', action: 'OPEN', auditTrail: expect.any(Array) });
    f.clock.value += 60_000;
    const tick = await f.engine.stepPaper(session.id);
    expect(tick.orders[0]!.status).toBe('Filled'); expect(tick.fills).toHaveLength(1); expect(tick.book.position?.side).toBe('LONG');
    expect(Number(tick.book.position!.entryPrice) * Number(tick.book.position!.quantity) * 100).toBeLessThanOrEqual(700);
    expect(tick.lastRisk).toMatchObject({ action: 'NO_CHANGE', primaryReasonCode: 'NO_CHANGE_TARGET_ALREADY_HELD' });
    const calls = f.getCandles.mock.calls.length; expect(await f.engine.stepPaper(session.id)).toEqual(tick); expect(f.getCandles).toHaveBeenCalledTimes(calls);
    const restarted = await createDashboardServer(f.options); expect(await restarted.engine.stepPaper(session.id)).toEqual(tick);
  });
  it('does not backdate a paper entry into a candle that opened before its order existed', async () => {
    const f = await fixture(); f.clock.value += 10_000; const session = await f.engine.createPaper(paperConfig);
    const initial = await f.engine.stepPaper(session.id), created = initial.orders[0]!.createdAtMs;
    f.clock.value += 60_000; const first = await f.engine.stepPaper(session.id); expect(first.fills).toHaveLength(0);
    f.clock.value += 60_000; const second = await f.engine.stepPaper(session.id);
    expect(second.fills).toHaveLength(1); expect(second.fills[0]!.timestampMs).toBeGreaterThanOrEqual(created);
  });
  it('keeps unprotected or below-minimum paper entries refused by M7', async () => {
    const f = await fixture(), noStop = await f.engine.createPaper({ ...paperConfig, stopLossMode: 'NONE', stopLossValue: 0 });
    const result = await f.engine.stepPaper(noStop.id); expect(result.orders).toHaveLength(0); expect(result.lastRisk).toMatchObject({ status: 'REJECTED' });
    const tooSmall = await f.engine.createPaper({ ...paperConfig, maxOrderNotionalInr: 100 });
    const blocked = await f.engine.stepPaper(tooSmall.id); expect(blocked.orders).toHaveLength(0); expect(blocked.lastRisk).toMatchObject({ status: 'REJECTED' });
    expect(f.workspace.snapshot().alerts.some(a => a.code === 'PAPER_M7_REFUSED')).toBe(true);
  });
  it('cancels working entries on STOP, persists the latch and still permits protective reductions', async () => {
    const f = await fixture(), waiting = await f.engine.createPaper(paperConfig); await f.engine.stepPaper(waiting.id);
    await f.engine.operations(true, { reason: 'Operator test' });
    expect(f.workspace.snapshot().paperSessions[0]!.orders[0]!.status).toBe('Cancelled');
    await expect(f.engine.createPaper(paperConfig)).rejects.toThrow('OPERATOR_STOPPED');
    const restarted = await createDashboardServer(f.options); expect(restarted.engine.admissionStopped).toBe(true);
    await f.engine.operations(false, {}); const open = await f.engine.createPaper(paperConfig); await f.engine.stepPaper(open.id);
    f.clock.value += 60_000; const positioned = await f.engine.stepPaper(open.id); expect(positioned.book.position).not.toBeNull();
    await f.engine.operations(true, {}); const boundary = (f.clock.value - start) / 60_000;
    f.setPrice(i => i < boundary ? new Decimal(100).plus(new Decimal(i).times('.05')) : new Decimal(120));
    f.clock.value += 60_000; const stopped = await f.engine.stepPaper(open.id);
    expect(stopped.book.position).toBeNull(); expect(stopped.book.trades[0]!.exitReason).toBe('STOP_LOSS');
    expect(stopped.orders.filter(o => o.status === 'Working' && o.action === 'OPEN')).toHaveLength(0);
  });
  it('honors STOP arriving while a paper step awaits data', async () => {
    const f = await fixture(), session = await f.engine.createPaper(paperConfig), wait = deferred<Awaited<ReturnType<typeof f.getCandles>>>();
    const implementation = f.getCandles.getMockImplementation()!;
    f.getCandles.mockImplementationOnce(() => wait.promise);
    const pending = f.engine.stepPaper(session.id); await vi.waitFor(() => expect(f.getCandles).toHaveBeenCalledOnce());
    await f.engine.operations(true, {});
    wait.resolve(await implementation(f.getCandles.mock.calls[0]![0]));
    const result = await pending; expect(result.orders).toHaveLength(0); expect(result.fills).toHaveLength(0);
  });
  it('pauses and resumes sessions and rejects candle gaps without partial accounting commits', async () => {
    const f = await fixture(), session = await f.engine.createPaper(paperConfig); await f.engine.stepPaper(session.id);
    const paused = await f.engine.togglePaper(session.id, { running: false }); expect(paused.status).toBe('PAUSED');
    await expect(f.engine.stepPaper(session.id)).rejects.toThrow('PAPER_SESSION_PAUSED');
    await f.engine.togglePaper(session.id, { running: true }); f.clock.value += 2 * 60_000; f.setMissing(f.clock.value - 60_000);
    const before = f.workspace.snapshot().paperSessions[0]!;
    await expect(f.engine.stepPaper(session.id)).rejects.toThrow('INCOMPLETE_CANDLE_HISTORY'); expect(f.workspace.snapshot().paperSessions[0]).toEqual(before);
  });
  it('never allows a racing resume acknowledgement to clear a newer stop', async () => {
    const f = await fixture(); await f.engine.operations(true, {});
    const resume = f.engine.operations(false, {}), stop = f.engine.operations(true, { reason: 'Newer stop' });
    await Promise.all([resume, stop]); expect(f.engine.admissionStopped).toBe(true); expect(f.workspace.snapshot().operations.admissionStopped).toBe(true);
  });
  it('wires strategy, paper, settings, data and research HTTP routes without live capabilities', async () => {
    const f = await fixture();
    await request(f.app).post('/api/settings').send({ language: 'hi', defaultCoin: 'SOL', timezone: 'Asia/Kolkata' }).expect(200);
    await request(f.app).post('/api/strategies').send({ name: 'HTTP EMA', strategy: 'ema-trend', parameters: { fastPeriod: 3, slowPeriod: 10 }, slMode: 'INR', slValue: 50, tpMode: 'INR', tpValue: 100 }).expect(201);
    await request(f.app).post('/api/strategies').send({ name: 'Bad', strategy: 'ema-trend', parameters: { fastPeriod: 50, slowPeriod: 3 } }).expect(400);
    const session = await request(f.app).post('/api/paper/sessions').send(paperConfig).expect(201);
    const tick = await request(f.app).post(`/api/paper/sessions/${session.body.id}/step`).send({}).expect(200); expect(tick.body.orders[0].status).toBe('Working');
    await request(f.app).post(`/api/paper/sessions/${session.body.id}/toggle`).send({ running: false }).expect(200);
    await request(f.app).post('/api/paper/sessions').send({ ...paperConfig, confirmLive: true }).expect(400);
    const sync = await request(f.app).post('/api/data/sync').send({ coin: 'SOL', timeframe: '1m', bars: 60 }).expect(202);
    await f.engine.waitForSync();
    expect(f.workspace.syncStatus()).toMatchObject({ jobId: sync.body.jobId, status: 'COMPLETED' });
    await request(f.app).get('/api/data/datasets/' + f.workspace.snapshot().datasets.at(-1)!.id).expect(200);
    await request(f.app).post('/api/matrix/run').send({ coins: ['SOL'], timeframe: '1m', bars: 60, fastPeriods: [3], slowPeriods: [10], inrPerUsdt: 100 }).expect(200);
    await request(f.app).post('/api/validation/run').send({ coins: ['SOL'], timeframe: '1m', bars: 150, fastPeriods: [3], slowPeriods: [10], inrPerUsdt: 100 }).expect(200);
    for (const url of ['/api/strategies', '/api/paper/sessions', '/api/paper/orders', '/api/paper/positions', '/api/paper/fills', '/api/data/datasets', '/api/matrix', '/api/validation', '/api/rankings', '/api/operations', '/api/alerts', '/api/audit']) await request(f.app).get(url).expect(200);
    const state = await request(f.app).get('/api/workspace').expect(200); expect(state.body.settings.language).toBe('hi'); expect(state.body.paperOrders[0].status).toBe('Cancelled');
  });
  it('exposes the full workspace and downloadable CSV/JSON evidence with safe live boundaries', async () => {
    const f = await fixture();
    const result = await request(f.app).post('/api/backtest/run').send({ coin: 'SOL', timeframe: '1m', bars: 60, inrPerUsdt: 100, stopLossMode: 'PERCENT', stopLossValue: 1 }).expect(200);
    const csv = await request(f.app).get(`/api/reports/export?id=${result.body.runId}&format=csv`).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv'); expect(csv.headers['content-disposition']).toContain(result.body.runId);
    expect(csv.text).toContain('tradeId,side,entryTimeIso'); expect(csv.text).toContain('SL_TP_ARMED');
    const json = await request(f.app).get(`/api/reports/export?id=${result.body.runId}&format=json`).expect(200);
    expect(json.body).toMatchObject({ liveLocked: true, fundingNote: 'Funding excluded' });
    const workspace = await request(f.app).get('/api/workspace').expect(200);
    expect(workspace.body).toMatchObject({ liveLocked: true, savedStrategies: [], paperSessions: [], paperOrders: [], paperPositions: [], operations: { admissionStopped: false } });
    await request(f.app).post('/api/operations/stop').send({}).expect(200);
    await request(f.app).post('/api/backtest/run').send({ coin: 'SOL' }).expect(409);
    await request(f.app).post('/api/paper/sessions').send({ ...paperConfig, confirmLive: true }).expect(409);
    await request(f.app).post('/api/operations/resume').send({ confirmLive: true }).expect(400);
    await request(f.app).get('/api/reports/export?id=../../.env&format=json').expect(400);
  });
});
