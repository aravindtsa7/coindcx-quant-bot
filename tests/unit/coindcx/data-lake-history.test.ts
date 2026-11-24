import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Decimal } from '../../../src/core/decimal/decimal';
import { CoinDcxClient } from '../../../src/integration/coindcx/client';
import { readBotSettlementConversion } from '../../../src/integration/coindcx/live/practical-bot-evaluation';
import { PracticalBacktestRunner } from '../../../src/integration/coindcx/live/practical-backtest-runner';
import { HistoricalMinuteArchive, DAY_MS, MINUTE_MS, resolveHistoryWindow } from '../../../src/market-data/historical-minute-archive';
import { CoinDcxFuturesCandleRestReader, type HistoricalCandleQuery } from '../../../src/market-data/rest-candle-reader';
import { disciplinedPermit, type ReadBudgetRequest, type ReadBudgetAcquisition } from '../../../src/integration/coindcx/rate-limit/runtime/read-budget';
import { createDashboardServer } from '../../../src/dashboard/server';
import { WorkspaceStore } from '../../../src/dashboard/workspace-store';
import { trackedCoinProfiles } from '../../../src/dashboard/coin-catalog';
import { evidenceDigest } from '../../../src/dashboard/evidence';
import { parseBacktestArguments } from '../../../scripts/run-backtest';
import { instrument, profile } from './audit-a2-helpers';

const directories: string[] = [], now = Date.parse('2026-11-22T00:00:00Z'), pair = 'B-SOL_USDT';
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) {
    const real = fs.realpathSync(dir);
    if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith('coindcx-history-test-')) throw new Error('TEST_CLEANUP_PATH_REFUSED');
    fs.rmSync(real, { recursive: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coindcx-history-test-')); directories.push(root);
  const missing = new Set<number>();
  const getCandles = vi.fn(async (q: HistoricalCandleQuery) => {
    const step = Number(q.resolution) * MINUTE_MS, result = [];
    for (let time = q.from; time <= q.to; time += step) {
      if (missing.has(time)) continue;
      const price = new Decimal(100).plus(new Decimal((time / MINUTE_MS) % 1000).times('.01'));
      result.push({ pair: q.pair, openTimeMs: time, open: price, close: price, high: price.plus('2'), low: price.minus('2'), volume: new Decimal(10), quoteVolume: null });
    }
    return result.reverse(); // Sorting is the archive's responsibility.
  });
  const archive = new HistoricalMinuteArchive(root, () => now);
  return { root, missing, getCandles, archive, client: { getCandles, getInrFuturesInstrument: async (p: string) => ({ ...instrument(p.slice(2, -5)), minNotional: new Decimal(6) }) } };
}
async function dashboardFixture() {
  const f = fixture(), client = Object.assign(new CoinDcxClient(), f.client);
  const list = vi.spyOn(client, 'listActiveInrFuturesInstruments').mockResolvedValue(['B-XRP_USDT', 'B-BTC_USDT', 'B-ETH_USDT', 'B-SOL_USDT']);
  const metadata = vi.spyOn(client, 'getInrFuturesInstrument').mockImplementation(async p => ({ ...instrument(p.slice(2, -5)),
    dynamicPositionLeverageTiers: [{ leverage: new Decimal(20), maxPositionSizeUsdt: new Decimal(5000) }] }));
  vi.spyOn(client, 'findActiveInrPerpetualByUnderlying').mockImplementation(async c => client.getInrFuturesInstrument(`B-${c}_USDT`));
  const options = { client, profiles: ['BTC', 'ETH', 'SOL'].map(profile), clock: { nowMs: () => now }, reportDirectory: f.root,
    readSettlementConversion: async () => readBotSettlementConversion([{ symbol: 'USDTINR', margin_currency_short_name: 'INR',
      target_currency_short_name: 'USDT', conversion_price: '100', last_updated_at: now - 1000 }], now), budgetStats: () => ({ connected: true }) };
  return { ...f, ...await createDashboardServer(options), options, list, metadata };
}

describe('Historical 1m archive', () => {
  it('acquires a fresh M2 public permit for every paginated HTTP request and stops before the refused page', async () => {
    const f = fixture(); let received = 0;
    const server = http.createServer((req, res) => {
      received++; const url = new URL(req.url!, 'http://127.0.0.1');
      const from = Number(url.searchParams.get('from')) * 1000, to = Number(url.searchParams.get('to')) * 1000;
      const data = [];
      for (let time = from; time <= to; time += MINUTE_MS) data.push({ time, open: '100', high: '101', low: '99', close: '100', volume: '10' });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ s: 'ok', data }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const acquire = vi.fn(async (_request: ReadBudgetRequest): Promise<ReadBudgetAcquisition> => acquire.mock.calls.length > 2 ? { kind: 'REFUSED', reason: 'TEST_READ_LIMIT' }
      : { kind: 'GRANTED', permit: disciplinedPermit({ start: create => ({ kind: 'STARTED', value: create() }), complete() {}, release() {}, throttled() {} }) });
    const reader = new CoinDcxFuturesCandleRestReader({ baseUrl: `http://127.0.0.1:${address.port}`, clock: { nowMs: () => now }, readBudget: { scope: 'PUBLIC', budget: { acquire } } });
    try {
      await expect(f.archive.ensureRange(reader, pair, { fromMs: now - 2500 * MINUTE_MS, toMs: now })).rejects.toThrow('TEST_READ_LIMIT');
      expect(received).toBe(2); expect(acquire).toHaveBeenCalledTimes(3);
      expect(acquire.mock.calls.every(([r]) => r.scope === 'PUBLIC')).toBe(true);
      expect((await f.archive.inventory(pair)).candleCount).toBe(2000);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it('merges multi-day sequential pages, deduplicates, sorts, and measures exact coverage and disk bytes', async () => {
    const f = fixture(), window = { fromMs: now - 3 * DAY_MS, toMs: now };
    const original = f.getCandles.getMockImplementation()!;
    f.getCandles.mockImplementation(async q => { const rows = await original(q); return [...rows, ...rows.slice(0, 1)]; });
    await f.archive.ensureRange(f.client, pair, window);
    expect(f.getCandles).toHaveBeenCalledTimes(5);
    expect(f.getCandles.mock.calls.every(([q]) => q.resolution === '1' && q.to - q.from < 1000 * MINUTE_MS)).toBe(true);
    const inventory = await f.archive.inventory(pair), rows = await f.archive.read(pair);
    expect(inventory).toMatchObject({ candleCount: 4320, coverageDays: 3, gapCount: 0, missingMinutes: 0, syncStatus: 'SYNCED', fabricatedCandles: 0,
      dateRangeUtc: { from: '2026-11-19T00:00:00.000Z', to: '2026-11-22T00:00:00.000Z' } });
    expect(inventory.sizeBytes).toBe(fs.statSync(path.join(f.root, 'datasets', `${pair}-1m.json`)).size);
    expect(inventory.sizeMb).toBe(inventory.sizeBytes / (1024 * 1024));
    expect(rows.every((r, i) => r.openTimeMs === window.fromMs + i * MINUTE_MS)).toBe(true);
    f.getCandles.mockClear(); await f.archive.ensureRange(f.client, pair, window); expect(f.getCandles).not.toHaveBeenCalled();
    expect((await new HistoricalMinuteArchive(f.root, () => now).inventory(pair)).candleCount).toBe(4320);
  });
  it('counts gap intervals separately from missing minutes and re-fetches only missing intervals honestly', async () => {
    const f = fixture(), fromMs = now - DAY_MS, window = { fromMs, toMs: now };
    [10, 11, 100].forEach(i => f.missing.add(fromMs + i * MINUTE_MS));
    await f.archive.ensureRange(f.client, pair, window);
    expect(await f.archive.inventory(pair)).toMatchObject({ gapCount: 2, missingMinutes: 3, candleCount: 1437, syncStatus: 'GAPS' });
    f.getCandles.mockClear(); await f.archive.ensureRange(f.client, pair, window);
    expect(f.getCandles.mock.calls.map(([q]) => [q.from, q.to])).toEqual([[fromMs + 10 * MINUTE_MS, fromMs + 12 * MINUTE_MS - 1], [fromMs + 100 * MINUTE_MS, fromMs + 101 * MINUTE_MS - 1]]);
    expect((await f.archive.inventory(pair)).missingMinutes).toBe(3);
    f.missing.clear(); await f.archive.ensureRange(f.client, pair, window);
    expect(await f.archive.inventory(pair)).toMatchObject({ gapCount: 0, missingMinutes: 0, candleCount: 1440 });
  });
  it('preserves completed pages on a budget refusal and resumes from the missing suffix', async () => {
    const f = fixture(), original = f.getCandles.getMockImplementation()!;
    f.getCandles.mockImplementationOnce(original).mockRejectedValueOnce(new Error('READ_BUDGET_REFUSED'));
    const window = { fromMs: now - 2500 * MINUTE_MS, toMs: now };
    await expect(f.archive.ensureRange(f.client, pair, window)).rejects.toThrow('READ_BUDGET_REFUSED');
    expect((await f.archive.inventory(pair)).candleCount).toBe(1000);
    f.getCandles.mockClear(); await f.archive.ensureRange(f.client, pair, window);
    expect(f.getCandles.mock.calls[0]![0].from).toBe(window.fromMs + 1000 * MINUTE_MS);
    expect((await f.archive.inventory(pair)).candleCount).toBe(2500);
  });
  it('rejects contradictory provider rows, invalid windows, traversal and aborts before reads', async () => {
    const f = fixture(), original = f.getCandles.getMockImplementation()!, window = { fromMs: now - 60 * MINUTE_MS, toMs: now };
    f.getCandles.mockImplementation(async q => { const rows = await original(q); return [...rows, { ...rows[0]!, close: rows[0]!.close.plus('.1') }]; });
    await expect(f.archive.ensureRange(f.client, pair, window)).rejects.toThrow('CONFLICTING_CANDLE');
    expect((await f.archive.inventory(pair)).candleCount).toBe(0);
    expect(() => resolveHistoryWindow({ days: 366 }, now)).toThrow('INVALID_HISTORY_WINDOW');
    expect(() => resolveHistoryWindow({ fromDate: '2026-02-30', toDate: '2026-03-02' }, now)).toThrow('INVALID_HISTORY_WINDOW');
    expect(() => resolveHistoryWindow({ fromDate: '2026-11-21', toDate: '2026-11-20' }, now)).toThrow('INVALID_HISTORY_WINDOW');
    expect(() => resolveHistoryWindow({ toMs: now + MINUTE_MS, days: 1 }, now)).toThrow('FUTURE_HISTORY_REFUSED');
    await expect(f.archive.read('../secret')).rejects.toThrow();
    const controller = new AbortController(); controller.abort(); f.getCandles.mockClear();
    await expect(f.archive.ensureRange(f.client, pair, window, controller.signal)).rejects.toThrow(); expect(f.getCandles).not.toHaveBeenCalled();
  });
  it('serializes overlapping downloads without losing earlier minutes', async () => {
    const f = fixture();
    await Promise.all([f.archive.ensureRange(f.client, pair, { fromMs: now - DAY_MS, toMs: now }),
      f.archive.ensureRange(f.client, pair, { fromMs: now - 2 * DAY_MS, toMs: now - DAY_MS / 2 })]);
    expect((await f.archive.inventory(pair)).candleCount).toBe(2880);
  });
});

describe('Tracked catalog and Data Lake API', () => {
  it('discovers searchable paged metadata, persists XRP and exposes it after restart without profile edits', async () => {
    const f = await dashboardFixture();
    const listed = await request(f.app).get('/api/catalog/coins?q=xrp').expect(200);
    expect(listed.body.coins).toEqual([{ underlying: 'XRP', pair: 'B-XRP_USDT', lotSize: '0.01', tickSize: '0.01', maxLeverage: '20', alreadyTracked: false }]);
    expect(f.list).toHaveBeenCalledOnce(); expect(f.metadata).toHaveBeenCalledOnce();
    await request(f.app).post('/api/catalog/coins').send({ underlying: 'XRP' }).expect(201);
    await request(f.app).post('/api/catalog/coins').send({ pair: 'B-XRP_USDT' }).expect(200);
    const state = await WorkspaceStore.open(f.root, () => now);
    expect(state.trackedCoins()).toEqual(['BTC', 'ETH', 'SOL', 'XRP']);
    expect((await f.engine.dataLake.archive.inventory('B-XRP_USDT')).candleCount).toBe(0);
    expect(trackedCoinProfiles(state, f.options.profiles).find(p => p.underlying === 'XRP')).toMatchObject({ researchEnabled: true, shadowEnabled: true, liveEnabled: false });
    const restarted = await createDashboardServer(f.options);
    const w = await request(restarted.app).get('/api/workspace').expect(200);
    expect(w.body.trackedCoins).toContain('XRP'); expect(w.body.dataLake.summary.coinsTracked).toBe(4); expect(w.body.liveLocked).toBe(true);
    expect((await request(f.app).get('/api/catalog/coins?q=xrp').expect(200)).body.coins[0].alreadyTracked).toBe(true);
    await request(f.app).get('/api/candles?pair=B-XRP_USDT&bars=30').expect(200);
    await request(f.app).post('/api/paper/sessions').send({ coin: 'XRP', inrPerUsdt: 100 }).expect(201);
    await request(f.app).post('/api/settings').send({ defaultCoin: 'XRP' }).expect(200);
    await request(f.app).post('/api/backtest/run').send({ coin: 'XRP', timeframe: '1h', days: 3, inrPerUsdt: 100 }).expect(200);
    await request(f.app).post('/api/matrix/run').send({ coins: ['XRP'], bars: 100, fastPeriods: [5], slowPeriods: [21], inrPerUsdt: 100 }).expect(200);
    await request(f.app).post('/api/validation/run').send({ coins: ['XRP'], bars: 300, fastPeriods: [5], slowPeriods: [21], inrPerUsdt: 100 }).expect(200);
    await request(f.app).post('/api/shadow/run').send({ coins: ['XRP'], mode: 'DRY_RUN' }).expect(200);
    await request(f.app).post('/api/catalog/coins').send({ underlying: 'UNKNOWN' }).expect(400);
    await request(f.app).post('/api/backtest/run').send({ coin: 'UNKNOWN' }).expect(400);
  }, 20000);
  it('migrates old checksummed state only after verifying its original bytes', async () => {
    const f = fixture(), store = await WorkspaceStore.open(f.root, () => now), old = store.snapshot();
    delete old.trackedCoins; delete old.trackedInstruments; delete old.syncJobStatus;
    fs.writeFileSync(path.join(f.root, 'workspace-state.json'), JSON.stringify({ format: 'LOCAL_QUANT_WORKSPACE_V1', state: old, contentSha256: evidenceDigest(old) }));
    const reopened = await WorkspaceStore.open(f.root, () => now);
    expect(reopened.trackedCoins()).toEqual(['BTC', 'ETH', 'SOL']); expect(reopened.snapshot().operations.admissionStopped).toBe(false);
    expect(reopened.syncStatus().status).toBe('IDLE');
    expect((await reopened.verifyPersistence()).status).toBe('VERIFIED');
  });
  it('supports backfill, repair, sync-all and extend-all through the admission/job boundary', async () => {
    const f = await dashboardFixture(), from = now - DAY_MS;
    f.missing.add(from + 40 * MINUTE_MS);
    const initial = await request(f.app).post('/api/data/history').send({ action: 'backfill', coin: 'SOL', days: 1 }).expect(200);
    expect(initial.body.results[0]).toMatchObject({ candleCount: 1439, gapCount: 1, requestedMissingMinutes: 1 });
    f.missing.clear(); f.getCandles.mockClear();
    const repaired = await request(f.app).post('/api/data/history').send({ action: 'repair', coin: 'SOL' }).expect(200);
    expect(repaired.body.results[0].gapCount).toBe(0); expect(f.getCandles).toHaveBeenCalledOnce();
    await request(f.app).post('/api/data/history').send({ action: 'sync', all: true }).expect(200);
    const extended = await request(f.app).post('/api/data/history').send({ action: 'extend', all: true, days: 1 }).expect(200);
    expect(extended.body.inventory.coins.every((c: { coverageDays: number }) => c.coverageDays === 2)).toBe(true);
    await request(f.app).post('/api/data/history').send({ action: 'backfill', coin: 'SOL', days: 366 }).expect(400);
    await request(f.app).post('/api/operations/stop').send({}).expect(200);
    await request(f.app).post('/api/data/history').send({ action: 'sync', all: true }).expect(409);
    expect(f.workspace.snapshot().jobs.every(j => j.status !== 'RUNNING')).toBe(true);
  }, 20000);
});

describe('Cache-backed Days and UTC date backtests', () => {
  it.each(['PERCENT', 'INR'] as const)('runs three days with %s SL/TP, then replays the exact cached date window without HTTP', async mode => {
    const f = fixture(), runner = new PracticalBacktestRunner({ client: f.client, nowMs: () => now, archive: f.archive });
    const config = { coin: 'SOL', timeframe: '15m', inrPerUsdt: 100, stopLossMode: mode, stopLossValue: mode === 'INR' ? 5 : 1,
      takeProfitMode: mode, takeProfitValue: mode === 'INR' ? 10 : 2 };
    const first = await runner.run({ ...config, days: 3 });
    expect(first.candles).toHaveLength(288); expect(first.config).toMatchObject({ fromMs: now - 3 * DAY_MS, toMs: now, days: 3 });
    expect(first.trades.some(t => ['STOP_LOSS', 'TAKE_PROFIT'].includes(t.exitReason))).toBe(true);
    expect(first.summary.netPnlInr).toBeCloseTo(first.summary.grossPnlInr - first.summary.totalFeesInr, 6);
    f.getCandles.mockClear();
    const second = await runner.run({ ...config, fromDate: '2026-11-19', toDate: '2026-11-22' });
    expect(f.getCandles).not.toHaveBeenCalled(); expect(second.candles).toEqual(first.candles); expect(second.trades).toEqual(first.trades);
    expect(second.candles[0]!.timeMs).toBe(now - 3 * DAY_MS); expect(second.candles.at(-1)!.timeMs).toBe(now - 15 * MINUTE_MS);
  });
  it('fetches an internal hole from a spanning cache, rejects unavailable minutes, and aggregates OHLCV exactly', async () => {
    const f = fixture(), fromMs = now - DAY_MS, window = { fromMs, toMs: now }, hole = fromMs + 20 * MINUTE_MS;
    f.missing.add(hole); await f.archive.ensureRange(f.client, pair, window);
    const runner = new PracticalBacktestRunner({ client: f.client, archive: f.archive, nowMs: () => now });
    await expect(runner.run({ coin: 'SOL', days: 1, inrPerUsdt: 100 })).rejects.toThrow('INCOMPLETE_CANDLE_HISTORY');
    f.missing.clear(); f.getCandles.mockClear();
    const r = await runner.run({ coin: 'SOL', days: 1, timeframe: '5m', inrPerUsdt: 100 });
    expect(f.getCandles).toHaveBeenCalledOnce(); expect(f.getCandles.mock.calls[0]![0]).toMatchObject({ from: hole, to: hole + MINUTE_MS - 1 });
    expect(r.candles).toHaveLength(288); expect(r.candles[0]!.volume).toBe(50);
    const raw = (await f.archive.read(pair)).slice(0, 5);
    expect(r.candles[0]).toMatchObject({ open: raw[0]!.open.toNumber(), close: raw.at(-1)!.close.toNumber(),
      high: Decimal.max(...raw.map(c => c.high)).toNumber(), low: Decimal.min(...raw.map(c => c.low)).toNumber() });
  });
  it('supports more than 1000 bars through date windows and parses the CLI range flags', async () => {
    const f = fixture(), runner = new PracticalBacktestRunner({ client: f.client, nowMs: () => now, archive: f.archive });
    const r = await runner.run({ coin: 'SOL', timeframe: '1m', days: 1, inrPerUsdt: 100 });
    expect(r.candles).toHaveLength(1440);
    expect(parseBacktestArguments(['--coin', 'XRP', '--days', '3', '--sl-mode', 'inr', '--sl-value', '5'])).toMatchObject({ coin: 'XRP', days: 3, stopLossMode: 'INR', stopLossValue: 5 });
    expect(parseBacktestArguments(['--from-date', '2026-11-19', '--to-date', '2026-11-22'])).toMatchObject({ fromDate: '2026-11-19', toDate: '2026-11-22' });
    expect(() => resolveHistoryWindow({ days: 3, fromDate: '2026-11-20', toDate: '2026-11-22' }, now)).toThrow('INVALID_HISTORY_WINDOW');
  });
});
