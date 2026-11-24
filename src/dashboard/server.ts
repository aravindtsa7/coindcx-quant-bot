import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { z } from 'zod';
import type { CoinProfile } from '../coin-runtime';
import { Decimal } from '../core/decimal/decimal';
import type { Clock } from '../integration/coindcx/clock';
import { PracticalBotOrchestrator, type PracticalBotOptions, type PracticalBotReadClient } from '../integration/coindcx/live/practical-bot-orchestrator';
import { createBotShadowRiskState } from '../integration/coindcx/live/practical-bot-shadow-risk';
import { backtestConfigSchema, withFuturesStrategyDefaults, fetchHistoricalCandles, HistoricalStrategySession, PracticalBacktestRunner, toChartCandle,
  type PracticalHistoricalClient } from '../integration/coindcx/live/practical-backtest-runner';
import type { SettlementConversionSnapshot } from '../risk';
import { DashboardReportStore } from './report-store';
import { WorkspaceStore, auditWorkspace, alertWorkspace, effectiveWorkspaceSettings } from './workspace-store';
import { redactEvidence } from './evidence';
import { WorkspaceEngine, workspacePaperViews } from './workspace-engine';
import { StrategyError } from '../strategies/core/errors';
import { createBotRiskPolicy } from '../integration/coindcx/live/practical-bot-evaluation';
import { CoinCatalog, catalogMetadata, trackedCoinProfiles } from './coin-catalog';

const amount = z.union([z.number().finite(), z.string().regex(/^\d+(?:\.\d+)?$/)]).transform(Number).pipe(z.number().positive().max(1_000_000_000));
const shadowSchema = z.object({ coins: z.array(backtestConfigSchema.shape.coin).min(1).max(500).optional(),
  strategy: z.enum(['ema-trend', 'rsi-momentum']).default('ema-trend'), equityInr: amount.default(5000),
  maxOrderNotionalInr: amount.default(700), mode: z.enum(['SHADOW', 'DRY_RUN']).default('SHADOW') }).strict();
const candlesSchema = z.object({ pair: z.string().regex(/^B-[A-Z0-9]{1,24}_USDT$/), resolution: z.enum(['1', '3', '5', '15', '30', '45', '60', '120', '240']).default('15'),
  bars: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(30).max(1000)).default('120') }).strict();

export interface DashboardOptions {
  readonly client: PracticalBotReadClient & PracticalHistoricalClient; readonly profiles: readonly CoinProfile[]; readonly clock: Clock;
  readonly reportDirectory: string; readonly publicDirectory?: string; readonly apiKey?: string | undefined; readonly apiSecret?: string | undefined;
  readonly readSettlementConversion: () => Promise<SettlementConversionSnapshot>;
  readonly budgetStats: () => unknown;
  readonly redactValues?: readonly string[];
  readonly storageStatus?: { readonly mysqlConfigured: boolean; readonly prismaSchemaPresent: boolean };
  readonly connectionSnapshot?: () => { readonly lastHttpStatus: number | null; readonly observedAtMs: number | null; readonly source: string };
}

/** Express application has read/research capabilities only. No live executor is composed. */
export async function createDashboardServer(options: DashboardOptions) {
  const app = express(), store = new DashboardReportStore(options.reportDirectory), abort = new AbortController();
  const workspace = await WorkspaceStore.open(options.reportDirectory, () => options.clock.nowMs());
  const engine = new WorkspaceEngine(workspace, options, store, abort.signal);
  const catalog = new CoinCatalog(options.client, workspace, () => options.clock.nowMs());
  let latestReport = await store.loadShadow(), busy: string | null = null, stopping = false;
  let latestBacktest: { runId: string; summary: unknown } | null = null;
  const startedAtIso = new Date(options.clock.nowMs()).toISOString();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
    // Loopback-only launcher plus same-origin writes protects local account reads from cross-site requests.
    const origin = req.get('origin');
    if (origin && origin !== `http://${req.get('host')}`) { res.status(403).json({ error: 'ORIGIN_REFUSED' }); return; }
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(req.get('host') ?? '')) { res.status(403).json({ error: 'HOST_REFUSED' }); return; }
    if (stopping && req.path.startsWith('/api/')) { res.status(503).json({ error: 'SERVER_STOPPING' }); return; }
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));
  const route = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction): void => { void handler(req, res).catch(next); };
  const workRoute = (name: string, handler: (req: Request, res: Response) => Promise<void>) => route(async (req, res) => {
    if (busy) { res.status(409).json({ error: 'RUN_IN_PROGRESS' }); return; }
    busy = name; try { await handler(req, res); } finally { busy = null; }
  });
  app.get('/api/status', (_req, res) => {
    const budget = options.budgetStats();
    const view = budget as { connected?: boolean; unknown?: boolean; admission?: string; blockedScopes?: readonly string[] } | null;
    const readReady = view?.connected === true && view.unknown !== true && view.admission !== 'STOPPED' && !view.blockedScopes?.length;
    res.set('Cache-Control', 'no-store').json({ serverMode: 'SHADOW', startedAtIso, busy, latestReport, latestBacktest,
      readiness: { shadowReady: !stopping && !engine.admissionStopped && busy === null && readReady, liveLocked: true, liveExecutionAvailable: false,
        accountStatus: latestReport?.account.status ?? 'NOT_OBSERVED', convergenceIsHistorical: latestReport !== null,
        credentialsConfigured: Boolean(options.apiKey?.trim() && options.apiSecret?.trim()) },
      paper: { status: workspace.snapshot().paperSessions.some(s => s.status === 'RUNNING') ? 'RUNNING' : 'IDLE',
        positions: workspace.snapshot().paperSessions.filter(s => s.book.position).length, ordersSubmitted: 0,
        note: 'Paper accounts are virtual and isolated. No venue orders are submitted.' }, operations: workspace.snapshot().operations, budget });
  });
  app.post('/api/shadow/run', route(async (req, res) => {
    const config = shadowSchema.parse(req.body);
    const coins = config.coins ?? workspace.trackedCoins(); coins.forEach(coin => workspace.assertTracked(coin));
    const epoch = engine.admission();
    if (busy) { res.status(409).json({ error: 'RUN_IN_PROGRESS' }); return; }
    busy = 'SHADOW';
    try {
      const readRiskState: NonNullable<PracticalBotOptions['readRiskState']> = async request => {
        if (!request.accountFingerprint) throw new Error('SHADOW_CAPITAL_INVALID');
        const equity = new Decimal(config.equityInr).toFixed();
        return createBotShadowRiskState({ capital: { accountFingerprint: request.accountFingerprint, initialEquityInr: equity, equityInr: equity,
          peakEquityInr: equity, lockedMarginInr: '0', createdAtMs: request.evaluationTimeMs,
          dailyPnl: { realizedTradingPnlInr: '0', fundingPnlInr: '0', feesInr: '0', otherAccountAdjustmentsInr: '0', netDailyPnlInr: '0' },
          consecutiveLossCount: 0, cooldownActiveUntilMs: null, reservations: [] },
          instrument: request.instrument, instrumentObservedAtMs: request.instrumentObservedAtMs, evaluationTimeMs: options.clock.nowMs(),
          settlement: request.settlementRateSnapshot, positions: request.positions,
          allowOfflineFlat: config.mode === 'DRY_RUN' || !options.apiKey?.trim() || !options.apiSecret?.trim() });
      };
      const report = await new PracticalBotOrchestrator({ client: options.client, profiles: trackedCoinProfiles(workspace, options.profiles), clock: options.clock,
        coins, strategy: config.strategy, equityInr: String(config.equityInr), maxInr: String(config.maxOrderNotionalInr),
        mode: config.mode, confirmLive: false, cycles: 1, apiKey: options.apiKey, apiSecret: options.apiSecret, signal: abort.signal,
        readSettlementConversion: options.readSettlementConversion, readRiskState }).run();
      engine.assertAdmission(epoch); const runId = await store.saveShadow(report); latestReport = report;
      await workspace.mutate(state => {
        auditWorkspace(state, options.clock.nowMs(), 'SHADOW_COMPLETED', runId, { status: report.status, mode: report.mode, ordersSubmitted: report.ordersSubmitted });
        if (report.account.status === 'UNRESOLVED') alertWorkspace(state, options.clock.nowMs(), 'PRIVATE_ACCOUNT_UNRESOLVED', report.account.error ?? 'Private account observation did not converge.', runId);
      });
      res.json(report);
    } finally { busy = null; }
  }));
  app.get('/api/candles', route(async (req, res) => {
    const config = candlesSchema.parse(req.query);
    workspace.assertTracked(config.pair.slice(2, -5));
    const candles = await fetchHistoricalCandles(options.client, { ...config, endTimeMs: options.clock.nowMs(), signal: abort.signal });
    const ema = new HistoricalStrategySession(config.pair, 'ema-trend', Number(config.resolution), candles[0]!.openTimeMs);
    const rsi = new HistoricalStrategySession(config.pair, 'rsi-momentum', Number(config.resolution), candles[0]!.openTimeMs);
    const atr = new HistoricalStrategySession(config.pair, 'atr-breakout', Number(config.resolution), candles[0]!.openTimeMs);
    const scalar = (value: unknown): number | null => {
      if (value === null || value === undefined) return null;
      const parsed = Number(String(value)); return Number.isFinite(parsed) ? parsed : null;
    };
    const overlays = candles.map(bar => {
      const e = ema.update(bar).indicators, r = rsi.update(bar).indicators, a = atr.update(bar).indicators;
      return { timeMs: bar.openTimeMs, emaFast: scalar(e['ema.fast']), emaSlow: scalar(e['ema.slow']), rsi: scalar(r['rsi']), atr: scalar(a['atr']) };
    });
    res.json({ pair: config.pair, resolution: config.resolution, candles: candles.map(toChartCandle), overlays,
      source: 'CoinDCX closed futures candles', fetchedAtIso: new Date(options.clock.nowMs()).toISOString() });
  }));
  app.post('/api/backtest/run', route(async (req, res) => {
    const config = backtestConfigSchema.extend({ coin: backtestConfigSchema.shape.coin.default('SOL') }).parse(withFuturesStrategyDefaults(req.body));
    workspace.assertTracked(config.coin);
    const epoch = engine.admission();
    if (busy) { res.status(409).json({ error: 'RUN_IN_PROGRESS' }); return; }
    busy = 'BACKTEST';
    try {
      const report = await new PracticalBacktestRunner({ client: { getCandles: query => { engine.assertAdmission(epoch); return options.client.getCandles(query); },
        getInrFuturesInstrument: pair => { engine.assertAdmission(epoch); return options.client.getInrFuturesInstrument(pair); } }, nowMs: () => options.clock.nowMs(), signal: abort.signal, archive: engine.dataLake.archive,
        readInrPerUsdt: async () => Number((await options.readSettlementConversion()).rateInrPerUsdt) }).run(config);
      engine.assertAdmission(epoch); await store.saveBacktest(report); latestBacktest = { runId: report.runId, summary: report.summary };
      await workspace.mutate(state => { auditWorkspace(state, options.clock.nowMs(), 'BACKTEST_COMPLETED', report.runId, { pair: report.pair,
        strategy: report.config.strategy, trades: report.summary.totalTrades, netPnlInr: report.summary.netPnlInr }); });
      res.json(report);
    } finally { busy = null; }
  }));
  app.get('/api/reports', route(async (_req, res) => { res.json({ reports: await store.list() }); }));
  // Keep export before the dynamic report route so "export" is never treated as a report ID.
  app.get('/api/reports/export', route(async (req, res) => {
    const input = z.object({ id: z.string().regex(/^(?:(?:bt|sh)-[a-f0-9]{24}|(?:paper|matrix|validation|strategy)-[a-f0-9]{12}|latest-shadow|workspace-audit)$/).default('workspace-audit'),
      format: z.enum(['csv', 'json']).default('json') }).strict().parse(req.query);
    const result = await engine.export(input.id, input.format);
    res.set({ 'Content-Type': result.contentType, 'Content-Disposition': `attachment; filename="${result.filename}"`, 'Cache-Control': 'no-store' }).send(result.content);
  }));
  app.get('/api/reports/:id', route(async (req, res) => { res.json(redactEvidence(await store.read(String(req.params['id'])),
    [options.apiKey ?? '', options.apiSecret ?? '', ...(options.redactValues ?? [])])); }));
  app.get('/api/evidence', route(async (_req, res) => { res.set('Cache-Control', 'no-store').json(await engine.evidence()); }));
  app.get('/api/evidence/:id', route(async (req, res) => {
    const id = z.string().regex(/^(?:(?:bt|sh)-[a-f0-9]{24}|(?:paper|matrix|validation|strategy)-[a-f0-9]{12}|latest-shadow|workspace-audit)$/).parse(req.params['id']);
    const result = await engine.export(id, 'json'); res.set('Cache-Control', 'no-store').type('json').send(result.content);
  }));
  app.get('/api/workspace', route(async (_req, res) => {
    const state = workspace.snapshot();
    const history = (await store.list()).filter(r => ['SHADOW', 'DRY_RUN'].includes(r.mode) && r.runId !== 'latest-shadow').slice(0, 30);
    const shadowHistory = await Promise.all(history.map(async entry => {
      const archive = await store.read(entry.runId) as { report: typeof latestReport };
      const report = archive.report;
      return { ...entry, accountStatus: report?.account.status, passes: report?.account.passes ?? [],
        pairSummaries: report?.cycles.at(-1)?.pairSummaries ?? [] };
    }));
    const persistence = await workspace.verifyPersistence();
    const privateHttp = /_HTTP_(\d{3})$/.exec(latestReport?.account.error ?? '');
    res.set('Cache-Control', 'no-store').json({ ...state, trackedCoins: workspace.trackedCoins(), dataLake: await engine.dataLake.inventory(), settings: effectiveWorkspaceSettings(state.settings), shadowReport: latestReport, backtestReports: (await store.list()).filter(r => r.mode === 'BACKTEST'),
      connections: { rest: { credentialsConfigured: Boolean(options.apiKey?.trim() && options.apiSecret?.trim()),
        fingerprintPrefix: latestReport?.account.fingerprint ? `${latestReport.account.fingerprint.slice(0, 12)}…` : null,
        http: options.connectionSnapshot?.() ?? { lastHttpStatus: privateHttp ? Number(privateHttp[1]) : null, observedAtMs: null, source: privateHttp ? 'Retained private account error' : 'No HTTP status captured' },
        accountStatus: latestReport?.account.status ?? 'NOT_OBSERVED', error: latestReport?.account.error ?? null },
        stream: { currentState: 'STOPPED', lastObservedState: latestReport?.account.streamState ?? 'NOT_OBSERVED', persistent: false, reconnectPolicy: 'Explicit read-only cycle; no automatic mutation retry', epoch: null },
        storage: { local: persistence, mysqlConfigured: options.storageStatus?.mysqlConfigured ?? false,
          prismaSchemaPresent: options.storageStatus?.prismaSchemaPresent ?? false, mysqlConnection: 'NOT_COMPOSED' } },
      shadowHistory, paperPolicies: state.paperSessions.map(s => ({ sessionId: s.id,
        policy: createBotRiskPolicy(`B-${s.config.coin}_USDT`, String(s.config.maxOrderNotionalInr), 'OPERATOR_SHADOW') })),
      observedAtMs: options.clock.nowMs(),
      ...workspacePaperViews(state), rateBudget: options.budgetStats(), liveLocked: true, mode: 'PAPER', promotion: 'PAPER · no promotion',
      fundingNote: state.paperSessions.some(s => s.config.fundingMode === 'MODELED_FIXED_BPS') ? 'Funding modeled per session; fixed-rate estimates' : 'Funding excluded', busy });
  }));
  app.get('/api/instruments', workRoute('INSTRUMENT_DISCOVERY', async (_req, res) => {
    let conversion: SettlementConversionSnapshot | null = null;
    try { conversion = await options.readSettlementConversion(); } catch { abort.signal.throwIfAborted(); }
    const instruments = [];
    for (const profile of trackedCoinProfiles(workspace, options.profiles)) {
      abort.signal.throwIfAborted();
      let found: Awaited<ReturnType<PracticalBotReadClient['findActiveInrPerpetualByUnderlying']>> = null;
      let error: string | null = null;
      try { found = await options.client.findActiveInrPerpetualByUnderlying(profile.underlying); }
      catch { abort.signal.throwIfAborted(); error = 'INSTRUMENT_READ_UNAVAILABLE'; }
      if (found) await workspace.trackCoin(catalogMetadata(found));
      instruments.push({ underlying: profile.underlying, pair: found?.pair ?? null, status: found?.status ?? 'NOT_DISCOVERED',
        error, observedAtMs: options.clock.nowMs(), minNotionalInr: found && conversion ? found.minNotional.times(conversion.rateInrPerUsdt).toFixed() : null,
        priceIncrement: found?.priceIncrement.toFixed() ?? null, quantityIncrement: found?.quantityIncrement.toFixed() ?? null,
        leverageTiers: found?.dynamicPositionLeverageTiers.map(t => ({ leverage: t.leverage.toFixed(), maxPositionSizeUsdt: t.maxPositionSizeUsdt.toFixed() })) ?? [],
        eligibility: { data: profile.enabled && profile.dataEnabled, research: profile.enabled && profile.researchEnabled,
          paper: profile.enabled && profile.paperEnabled, shadow: profile.enabled && profile.shadowEnabled, live: false } });
    }
    res.json({ instruments, source: 'COINDCX_DISCOVERY', liveLocked: true, conversion, conversionError: conversion ? null : 'CONVERSION_UNAVAILABLE' });
  }));
  app.get('/api/catalog/coins', route(async (req, res) => {
    const query = z.object({ q: z.string().max(100).default(''), offset: z.coerce.number().int().min(0).max(10000).default(0),
      limit: z.coerce.number().int().min(1).max(20).default(6) }).strict().parse(req.query);
    res.set('Cache-Control', 'no-store').json(await catalog.list(query.q, query.offset, query.limit));
  }));
  app.post('/api/catalog/coins', workRoute('ADD_COIN', async (req, res) => {
    const input = z.object({ underlying: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,24}$/).optional(),
      pair: z.string().trim().toUpperCase().regex(/^B-[A-Z0-9]{1,24}_USDT$/).optional() }).strict().refine(v => v.underlying || v.pair).parse(req.body);
    const epoch = engine.admission();
    const metadata = await catalog.resolve(input); engine.assertAdmission(epoch);
    await engine.dataLake.archive.initialize(metadata.pair);
    const result = await workspace.trackCoin(metadata);
    res.status(result.added ? 201 : 200).json({ ...result, inventory: await engine.dataLake.archive.inventory(metadata.pair), liveLocked: true });
  }));
  app.get('/api/data/inventory', route(async (_req, res) => { res.json(await engine.dataLake.inventory()); }));
  app.post('/api/data/history', workRoute('DATA_LAKE', async (req, res) => { res.json(await engine.historicalAction(req.body)); }));
  app.get('/api/strategies', (_req, res) => { res.json({ strategies: workspace.snapshot().savedStrategies }); });
  app.post('/api/strategies', route(async (req, res) => { res.status(201).json(await engine.saveStrategy(req.body)); }));
  app.post('/api/matrix/run', workRoute('MATRIX', async (req, res) => { res.json(await engine.matrix(req.body)); }));
  app.post('/api/validation/run', workRoute('VALIDATION', async (req, res) => { res.json(await engine.validate(req.body)); }));
  app.get('/api/matrix', (_req, res) => { res.json({ runs: workspace.snapshot().researchRuns.filter(r => r.type === 'MATRIX') }); });
  app.get('/api/validation', (_req, res) => { res.json({ runs: workspace.snapshot().researchRuns.filter(r => r.type === 'VALIDATION') }); });
  app.get('/api/rankings', (_req, res) => { res.json({ runs: workspace.snapshot().researchRuns.filter(r => r.type === 'VALIDATION'), promotion: 'PAPER · no promotion' }); });
  app.get('/api/data/sync/status', (_req, res) => { res.set('Cache-Control', 'no-store').json(workspace.syncStatus()); });
  app.post('/api/data/sync/cancel', route(async (req, res) => { res.json(await engine.cancelSync(req.body)); }));
  app.post('/api/data/sync', route(async (req, res) => {
    if (busy) { res.status(409).json({ error: 'RUN_IN_PROGRESS' }); return; }
    busy = 'DATA_SYNC';
    try {
      const job = await engine.startSync(req.body);
      void job.completion.then(() => { busy = null; }, () => { busy = null; });
      res.status(202).json({ jobId: job.jobId, status: job.status });
    } catch (error) { busy = null; throw error; }
  }));
  app.get('/api/data/datasets', (_req, res) => { const state = workspace.snapshot(); res.json({ datasets: state.datasets, jobs: state.jobs.filter(j => j.type === 'DATA_SYNC') }); });
  app.get('/api/data/datasets/:id', route(async (req, res) => { res.json(await engine.datasets.read(String(req.params['id']))); }));
  app.get('/api/paper/sessions', (_req, res) => { res.json({ sessions: workspace.snapshot().paperSessions }); });
  app.post('/api/paper/sessions', route(async (req, res) => { res.status(201).json(await engine.createPaper(req.body)); }));
  app.post('/api/paper/sessions/:id/step', workRoute('PAPER_STEP', async (req, res) => { z.object({}).strict().parse(req.body ?? {}); res.json(await engine.stepPaper(String(req.params['id']))); }));
  app.post('/api/paper/sessions/:id/toggle', route(async (req, res) => { res.json(await engine.togglePaper(String(req.params['id']), req.body)); }));
  app.get('/api/paper/orders', (_req, res) => { res.json({ orders: workspacePaperViews(workspace.snapshot()).paperOrders }); });
  app.get('/api/paper/positions', (_req, res) => { res.json({ positions: workspacePaperViews(workspace.snapshot()).paperPositions }); });
  app.get('/api/paper/fills', (_req, res) => { res.json({ fills: workspace.snapshot().paperSessions.flatMap(s => s.fills.map(f => ({ ...f, sessionId: s.id }))) }); });
  app.post('/api/operations/stop', route(async (req, res) => { res.json(await engine.operations(true, req.body)); }));
  app.post('/api/operations/resume', route(async (req, res) => { res.json(await engine.operations(false, req.body)); }));
  app.get('/api/operations', (_req, res) => { res.json({ operations: workspace.snapshot().operations, busy, budget: options.budgetStats(), liveLocked: true }); });
  app.post('/api/settings', route(async (req, res) => { res.json(await engine.settings(req.body)); }));
  app.get('/api/alerts', (_req, res) => { res.json({ alerts: workspace.snapshot().alerts }); });
  app.post('/api/alerts/:id/ack', route(async (req, res) => { z.object({}).strict().parse(req.body ?? {}); res.json(await engine.acknowledge(String(req.params['id']))); }));
  app.get('/api/audit', (_req, res) => { res.json({ auditLog: workspace.snapshot().auditLog, jobs: workspace.snapshot().jobs }); });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'NOT_FOUND' }); });
  app.use(express.static(options.publicDirectory ?? path.resolve(__dirname, '../../src/dashboard/public')));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof StrategyError && ['INVALID_STRATEGY_PARAMETER', 'STRATEGY_INPUT_INVALID'].includes(error.code)) { res.status(400).json({ error: error.code }); return; }
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'INVALID_REQUEST', fields: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) }); return; }
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || (error instanceof Error && ['INVALID_REPORT_ID', 'REPORT_UNAVAILABLE', 'DATASET_NOT_FOUND', 'ALERT_NOT_FOUND', 'PAPER_SESSION_NOT_FOUND'].includes(error.message))) { res.status(404).json({ error: 'WORKSPACE_RESOURCE_NOT_FOUND' }); return; }
    if (error instanceof SyntaxError || (error as { status?: number } | null)?.status === 413) { res.status(400).json({ error: 'INVALID_JSON_BODY' }); return; }
    const conflict = new Set(['OPERATOR_STOPPED', 'RUN_IN_PROGRESS', 'SYNC_JOB_CHANGED', 'PAPER_SESSION_PAUSED', 'PAPER_STEP_CONFLICT', 'PAPER_BACKFILL_REQUIRED', 'PAPER_CANDLE_REVISION', 'PAPER_HISTORY_LIMIT', 'WORKSPACE_CAPACITY_LIMIT']);
    if (error instanceof Error && conflict.has(error.message)) { res.status(409).json({ error: error.message }); return; }
    const badRequest = new Set(['INVALID_HISTORY_WINDOW', 'INVALID_DATA_LAKE_TARGET', 'COIN_NOT_TRACKED', 'CATALOG_COIN_UNAVAILABLE', 'INVALID_TIMEZONE', 'INVALID_VALIDATION_SPLIT', 'VALIDATION_FOLD_TOO_SMALL', 'MATRIX_CELL_LIMIT', 'INVALID_EXPORT_FORMAT', 'EXPORT_LEDGER_UNAVAILABLE', 'INVALID_PROTECTIVE_DISTANCE', 'INVALID_STRATEGY_TIMEFRAMES']);
    if (error instanceof Error && badRequest.has(error.message)) { res.status(400).json({ error: error.message }); return; }
    const safe = new Set(['INCOMPLETE_CANDLE_HISTORY', 'CONFLICTING_CANDLE', 'INVALID_CANDLE', 'FUTURE_HISTORY_REFUSED', 'INR_CONVERSION_REQUIRED', 'DATASET_INVALID', 'EVIDENCE_INTEGRITY_FAILED']);
    res.status(502).json({ error: error instanceof Error && safe.has(error.message) ? error.message : 'PROVIDER_OR_REPORT_OPERATION_FAILED' });
  });
  return { app, workspace, engine, stop: async () => { stopping = true; abort.abort(); await engine.waitForSync(); } };
}
