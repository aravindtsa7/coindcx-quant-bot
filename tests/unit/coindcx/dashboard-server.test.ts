import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { CoinDcxClient } from '../../../src/integration/coindcx/client';
import { Decimal } from '../../../src/core/decimal/decimal';
import type { HistoricalCandleQuery } from '../../../src/market-data/rest-candle-reader';
import { readBotSettlementConversion } from '../../../src/integration/coindcx/live/practical-bot-evaluation';
import { createDashboardServer } from '../../../src/dashboard/server';
import { DashboardReportStore } from '../../../src/dashboard/report-store';
import { deferred, instrument, profile } from './audit-a2-helpers';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('coindcx-dashboard-test-')) throw new Error('TEST_CLEANUP_PATH_REFUSED');
    fs.rmSync(resolved, { recursive: true });
  }
});
async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coindcx-dashboard-test-')); directories.push(directory);
  const now = Math.floor(1_780_000_000_000 / 3_600_000) * 3_600_000;
  const getCandles = vi.fn(async (query: HistoricalCandleQuery) => {
    const step = Number(query.resolution) * 60_000, length = Math.floor((query.to - query.from + 1) / step);
    return Array.from({ length }, (_, i) => { const p = new Decimal(100).plus(new Decimal(i).div(10));
      return { pair: query.pair, openTimeMs: query.from + i * step, open: p, high: p.plus('.01'), low: p.minus('.01'), close: p, volume: new Decimal(10), quoteVolume: null }; });
  });
  const client = Object.assign(new CoinDcxClient(), { getCandles });
  const discovered = (coin: string) => ({ ...instrument(coin), minNotional: new Decimal(6),
    dynamicPositionLeverageTiers: [{ leverage: new Decimal(20), maxPositionSizeUsdt: new Decimal(5000) }] });
  vi.spyOn(client, 'findActiveInrPerpetualByUnderlying').mockImplementation(async coin => discovered(coin));
  vi.spyOn(client, 'getInrFuturesInstrument').mockImplementation(async pair => discovered(pair.slice(2).split('_')[0]!));
  const readSettlementConversion = vi.fn(async () => readBotSettlementConversion([{ symbol: 'USDTINR', margin_currency_short_name: 'INR',
    target_currency_short_name: 'USDT', conversion_price: '102', last_updated_at: now - 1000 }], now));
  const options = { client, profiles: ['BTC', 'ETH', 'SOL'].map(profile), clock: { nowMs: () => now }, reportDirectory: directory,
    readSettlementConversion, budgetStats: () => ({ connected: true, acquisitions: 0 }) };
  return { ...await createDashboardServer(options), options, client, directory, now, getCandles, readSettlementConversion };
}
describe('Connected dashboard API', () => {
  it('downloads a redacted workspace bundle without an ID and exposes safe runtime connection metadata', async () => {
    const f = await fixture(), apiKey = 'test-key-do-not-disclose', apiSecret = 'test-secret-do-not-disclose';
    const d = await createDashboardServer({ ...f.options, apiKey, apiSecret, redactValues: ['mysql://user:pass@local/database'],
      storageStatus: { mysqlConfigured: true, prismaSchemaPresent: true },
      connectionSnapshot: () => ({ lastHttpStatus: 200, observedAtMs: f.now, source: 'FUTURES_CONVERSIONS' }) });
    await d.workspace.mutate(s => { s.auditLog.push({ id: 'a-1', timestampMs: f.now, action: 'TEST', scope: 'workspace-audit',
      details: { apiKey, clientSecret: apiSecret, note: `Credentials ${apiKey} mysql://user:pass@local/database`, accessToken: 'hidden-value' } }); });
    const w = await request(d.app).get('/api/workspace').expect(200);
    expect(w.body.connections).toMatchObject({ rest: { credentialsConfigured: true, fingerprintPrefix: null,
      http: { lastHttpStatus: 200, source: 'FUTURES_CONVERSIONS' } }, stream: { currentState: 'STOPPED', persistent: false, epoch: null },
      storage: { local: { status: 'VERIFIED' }, mysqlConfigured: true, prismaSchemaPresent: true, mysqlConnection: 'NOT_COMPOSED' } });
    const bundle = await request(d.app).get('/api/reports/export?format=json').expect(200);
    expect(bundle.headers['content-type']).toMatch(/application\/json/);
    expect(bundle.headers['content-disposition']).toContain('attachment; filename="workspace-audit.json"');
    expect(bundle.body).toMatchObject({ liveLocked: true, fundingNote: 'Funding excluded', report: { persistence: { status: 'VERIFIED' } } });
    expect(bundle.body.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    for (const secret of [apiKey, apiSecret, 'hidden-value', 'user:pass']) expect(bundle.text).not.toContain(secret);
    expect(bundle.body.report.workspace.auditLog[0].details.clientSecret).toBe('[REDACTED]');
    await request(d.app).get('/api/reports/export?format=csv').expect(400);
  });
  it('verifies saved report digests, exports valid CSV/JSON, and distinguishes tampered, legacy and corrupt evidence', async () => {
    const f = await fixture();
    const bt = await request(f.app).post('/api/backtest/run').send({ coin: 'SOL', bars: 60, inrPerUsdt: 102 }).expect(200);
    const preset = await request(f.app).post('/api/strategies').send({ name: 'Saved EMA', strategy: 'ema-trend' }).expect(201);
    const paper = await request(f.app).post('/api/paper/sessions').send({ coin: 'SOL', name: 'Virtual' }).expect(201);
    const id = bt.body.runId, filename = path.join(f.directory, 'backtest-reports', `${id}.json`);
    const catalog = await request(f.app).get('/api/evidence').expect(200);
    expect(catalog.body.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id, integrity: 'VERIFIED', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ id: preset.body.id, kind: 'STRATEGY', integrity: 'VERIFIED' }),
      expect.objectContaining({ id: paper.body.id, kind: 'PAPER', integrity: 'VERIFIED' }) ]));
    const csv = await request(f.app).get(`/api/reports/export?id=${id}&format=csv`).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toContain(`${id}.csv`);
    const rows = csv.text.split('\r\n');
    expect(rows[0]).toBe('tradeId,side,entryTimeIso,entryPrice,exitTimeIso,exitPrice,quantity,grossPnlInr,feeInr,netPnlInr,exitReason,events,leverage,marginUsedInr,liquidationPrice,fundingInr,marginRoiPct');
    expect(rows).toHaveLength(bt.body.trades.length + 1);
    expect(rows[1]).toContain(bt.body.trades[0].tradeId);
    const json = await request(f.app).get(`/api/evidence/${id}`).expect(200);
    expect(json.body.report.trades).toEqual(bt.body.trades);
    expect((await request(f.app).get(`/api/reports/export?id=${preset.body.id}&format=json`).expect(200)).body.report.name).toBe('Saved EMA');
    await request(f.app).get(`/api/reports/export?id=${paper.body.id}&format=csv`).expect(200);
    fs.unlinkSync(path.join(f.directory, 'backtest-reports', `${id}.integrity.json`));
    expect((await request(f.app).get('/api/evidence')).body.entries.find((e: any) => e.id === id).integrity).toBe('DIGEST_ONLY');
    await new DashboardReportStore(f.directory).saveBacktest(bt.body);
    const changed = { ...bt.body, summary: { ...bt.body.summary, netPnlInr: 999999 } };
    fs.writeFileSync(filename, JSON.stringify(changed));
    expect((await request(f.app).get('/api/evidence')).body.entries.find((e: any) => e.id === id).integrity).toBe('FAILED');
    await request(f.app).get(`/api/reports/export?id=${id}&format=json`).expect(502);
    fs.writeFileSync(filename, '{corrupt');
    expect((await request(f.app).get('/api/evidence')).body.entries.find((e: any) => e.id === id).integrity).toBe('FAILED');
  });
  it('redacts configured secrets in CSV and quotes embedded commas, quotes and formula prefixes', async () => {
    const f = await fixture();
    const bt = await request(f.app).post('/api/backtest/run').send({ coin: 'SOL', bars: 60, inrPerUsdt: 102 }).expect(200);
    const report = bt.body;
    report.trades[0].tradeId = '=csv-secret,"quoted"';
    await new DashboardReportStore(f.directory).saveBacktest(report);
    const d = await createDashboardServer({ ...f.options, apiKey: 'csv-secret' });
    const csv = await request(d.app).get(`/api/reports/export?id=${report.runId}&format=csv`).expect(200);
    expect(csv.text).not.toContain('csv-secret');
    expect(csv.text).toContain('"\'=\u005bREDACTED\u005d,""quoted"""');
    const json = await request(d.app).get(`/api/reports/export?id=${report.runId}&format=json`).expect(200);
    expect(json.body.report.trades[0].tradeId).toBe('=[REDACTED],"quoted"');
    expect(json.headers['content-disposition']).toContain('attachment;');
  });
  it('starts empty, serves the offline shell and always reports live locked', async () => {
    const f = await fixture();
    const status = await request(f.app).get('/api/status').expect(200);
    expect(status.body).toMatchObject({ serverMode: 'SHADOW', latestReport: null, readiness: { liveLocked: true, liveExecutionAvailable: false, shadowReady: true } });
    const page = await request(f.app).get('/').expect(200);
    expect(page.text).toContain('LIVE LOCKED'); expect(page.text).toContain('screen-jumper');
    expect(page.text).toContain('Open screen index'); expect(page.text).toContain('/app.js');
    expect(status.headers['x-powered-by']).toBeUndefined();
  });
  it('serves the modular shell assets locally with correct MIME types and no CDN references', async () => {
    const f = await fixture();
    const page = await request(f.app).get('/').expect('Content-Type', /text\/html/).expect(200);
    const assets = await Promise.all(['/app.js', '/ui-core.js', '/styles.css', '/execution.js', '/system.js'].map(asset => request(f.app).get(asset).expect(200)));
    expect(assets[0]!.headers['content-type']).toMatch(/javascript/);
    expect(assets[1]!.headers['content-type']).toMatch(/javascript/);
    expect(assets[2]!.headers['content-type']).toMatch(/text\/css/);
    expect(assets[3]!.headers['content-type']).toMatch(/javascript/);
    expect(assets[4]!.headers['content-type']).toMatch(/javascript/);
    for (const source of [page.text, ...assets.map(a => a.text)]) {
      expect(source).not.toMatch(/(?:src|href)=["']https?:\/\//i);
      expect(source).not.toMatch(/@import|https:\/\/(?:cdn|fonts\.)/i);
    }
    const workspace = await request(f.app).get('/api/workspace').expect(200);
    expect(workspace.body).toMatchObject({ liveLocked: true, savedStrategies: [], paperSessions: [], datasets: [] });
  });
  it('runs a real orchestrator in DRY_RUN, persists and reloads its M7 report', async () => {
    const f = await fixture();
    const result = await request(f.app).post('/api/shadow/run').send({ coins: ['SOL'], mode: 'DRY_RUN', equityInr: 5000, maxOrderNotionalInr: 700 }).expect(200);
    expect(result.body).toMatchObject({ mode: 'DRY_RUN', gatewayConstructed: false, ordersSubmitted: 0 });
    const summary = result.body.cycles[0].pairSummaries[0];
    expect(summary.pair).toBe('B-SOL_USDT'); expect(summary.riskDecision.auditTrail).toHaveLength(13);
    expect(summary.minNotionalInr).toBe('612');
    expect(fs.existsSync(path.join(f.directory, 'bot-shadow-risk-report.json'))).toBe(true);
    const restarted = await createDashboardServer(f.options);
    const status = await request(restarted.app).get('/api/status').expect(200);
    expect(status.body.latestReport).toEqual(result.body);
    const reports = await request(f.app).get('/api/reports').expect(200);
    expect(reports.body.reports).toHaveLength(2);
    const archive = reports.body.reports.find((r: { runId: string }) => r.runId.startsWith('sh-'));
    const inspected = await request(f.app).get('/api/reports/' + archive.runId).expect(200);
    expect(inspected.body.report).toEqual(result.body);
  });
  it.each([{ mode: 'TINY_LIVE' }, { mode: 'SHADOW', confirmLive: true }, { mode: 'LIVE' }, { coins: ['OTHER'] }, { equityInr: -1 }])('refuses invalid or live shadow requests %j', async body => {
    const f = await fixture(); await request(f.app).post('/api/shadow/run').send(body).expect(400);
    expect(f.getCandles).not.toHaveBeenCalled();
  });
  it('returns computed EMA, RSI and ATR overlays from fetched closed candles', async () => {
    const f = await fixture();
    const r = await request(f.app).get('/api/candles?pair=B-SOL_USDT&resolution=15&bars=60').expect(200);
    expect(r.body.candles).toHaveLength(60); expect(r.body.overlays).toHaveLength(60);
    expect(r.body.overlays[0].emaSlow).toBeNull(); expect(r.body.overlays[30].emaSlow).toBeGreaterThan(0);
    expect(r.body.overlays[30].rsi).toBe(100);
    expect(r.body.overlays[0].atr).toBeNull(); expect(r.body.overlays[30].atr).toBeGreaterThan(0);
    expect(f.getCandles.mock.calls[0]![0].resolution).toBe('15');
    await request(f.app).get('/api/candles?pair=B-SOL_USDT&resolution=2').expect(400);
    await request(f.app).get('/api/candles?pair=https://evil.test&bars=100').expect(400);
  });
  it('discovers real configured profiles and constraints while keeping live eligibility false', async () => {
    const f = await fixture();
    const r = await request(f.app).get('/api/instruments').expect(200);
    expect(r.body.liveLocked).toBe(true); expect(r.body.instruments).toHaveLength(3);
    expect(r.body.instruments[2]).toMatchObject({ underlying: 'SOL', pair: 'B-SOL_USDT', minNotionalInr: '612',
      leverageTiers: [{ leverage: '20', maxPositionSizeUsdt: '5000' }], eligibility: { live: false } });
    f.readSettlementConversion.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_BODY'));
    vi.spyOn(f.client, 'findActiveInrPerpetualByUnderlying').mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_BODY'));
    const partial = await request(f.app).get('/api/instruments').expect(200);
    expect(partial.body.conversionError).toBe('CONVERSION_UNAVAILABLE');
    expect(partial.body.instruments[0]).toMatchObject({ error: 'INSTRUMENT_READ_UNAVAILABLE', pair: null, minNotionalInr: null });
    expect(partial.body.instruments[1].pair).toBe('B-ETH_USDT'); expect(JSON.stringify(partial.body)).not.toContain('PRIVATE_PROVIDER_BODY');
  });
  it('exposes archived shadow campaigns and the engine SAFE policy for each isolated paper account', async () => {
    const f = await fixture();
    await request(f.app).post('/api/shadow/run').send({ coins: ['SOL'], mode: 'DRY_RUN' }).expect(200);
    const created = await request(f.app).post('/api/paper/sessions').send({ coin: 'SOL', name: 'Virtual', capitalInr: 125000, maxOrderNotionalInr: 10000 }).expect(201);
    const w = await request(f.app).get('/api/workspace').expect(200);
    expect(w.body.shadowHistory).toHaveLength(1); expect(w.body.shadowHistory[0].accountStatus).toBe('SKIPPED_DRY_RUN');
    expect(w.body.paperPolicies[0]).toMatchObject({ sessionId: created.body.id, policy: { modeConfig: { mode: 'SAFE', riskPerTradePercent: '0.25', maxConcurrentPositions: 1, maxNotionalPerTradeInr: '10000' } } });
    expect(w.body.liveLocked).toBe(true);
  });
  it('runs and persists a backtest with the complete equity curve and trade ledger', async () => {
    const f = await fixture();
    const r = await request(f.app).post('/api/backtest/run').send({ coin: 'SOL', bars: 60, inrPerUsdt: 102 }).expect(200);
    expect(r.body.mode).toBe('BACKTEST'); expect(r.body.trades.length).toBeGreaterThan(0); expect(r.body.equityCurve).toHaveLength(61);
    expect(r.body.summary.netPnlInr).toBeCloseTo(r.body.summary.grossPnlInr - r.body.summary.totalFeesInr, 7);
    const inspected = await request(f.app).get('/api/reports/' + r.body.runId).expect(200);
    expect(inspected.body).toEqual(r.body);
    const history = await request(f.app).get('/api/reports').expect(200);
    expect(history.body.reports[0].runId).toBe(r.body.runId);
    expect(history.body.reports[0]).toMatchObject({ pair: 'B-SOL_USDT', config: { strategy: 'ema-trend', timeframe: '15m' } });
    await request(f.app).post('/api/backtest/run').send({ coin: 'OTHER' }).expect(400);
    await request(f.app).post('/api/backtest/run').send({ coin: 'SOL', mode: 'TINY_LIVE' }).expect(400);
  });
  it('admits one job at a time and releases the busy lock after a failure', async () => {
    const f = await fixture(), waiting = deferred<never>();
    f.readSettlementConversion.mockImplementationOnce(() => waiting.promise);
    const running = request(f.app).post('/api/backtest/run').send({ coin: 'SOL', bars: 60 }).then(r => r);
    await vi.waitFor(() => expect(f.readSettlementConversion).toHaveBeenCalledOnce());
    await request(f.app).post('/api/shadow/run').send({ mode: 'DRY_RUN' }).expect(409);
    await request(f.app).post('/api/backtest/run').send({ coin: 'SOL' }).expect(409);
    waiting.reject(new Error('PRIVATE_PROVIDER_BODY_MUST_NOT_LEAK'));
    const result = await running; expect(result.status).toBe(502); expect(JSON.stringify(result.body)).not.toContain('PRIVATE_PROVIDER');
    const status = await request(f.app).get('/api/status').expect(200); expect(status.body.busy).toBeNull();
  });
  it('ignores corrupt startup reports, refuses traversal, and blocks cross-origin writes', async () => {
    const f = await fixture();
    fs.writeFileSync(path.join(f.directory, 'bot-shadow-risk-report.json'), '{broken');
    expect(await new DashboardReportStore(f.directory).loadShadow()).toBeNull();
    await request(f.app).get('/api/reports/not-a-valid-id').expect(404);
    await expect(new DashboardReportStore(f.directory).read('../../.env')).rejects.toThrow('INVALID_REPORT_ID');
    await request(f.app).post('/api/shadow/run').set('Origin', 'https://evil.example').send({}).expect(403);
    await request(f.app).get('/api/status').set('Host', 'evil.example').expect(403);
    await request(f.app).post('/api/shadow/run').set('Content-Type', 'application/json').send('{broken').expect(400);
    await request(f.app).get('/api/unknown').expect(404);
  });
  it('refuses new operations during shutdown', async () => {
    const f = await fixture(); f.stop();
    await request(f.app).get('/api/status').expect(503);
  });
});
