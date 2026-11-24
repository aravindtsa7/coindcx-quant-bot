import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { z } from 'zod';
import { mapInstrumentToMetadata } from '../coin-runtime';
import { backtestConfigSchema, futuresConfigSchema, withFuturesStrategyDefaults, strategyParameters, fundingLabel, parseBacktestConfig, fetchHistoricalCandles, HistoricalStrategySession, PracticalBacktestRunner, researchPair, timeframeResolution,
  type PracticalBacktestConfig, type PracticalBacktestReport } from '../integration/coindcx/live/practical-backtest-runner';
import { WorkspaceStore, auditWorkspace, alertWorkspace, workspaceId, workspaceSettingsSchema, effectiveWorkspaceSettings, type PaperSession, type WorkspaceState } from './workspace-store';
import { evidenceDigest, redactEvidence } from './evidence';
import { WorkspaceDatasetStore, storeCandle } from './workspace-data';
import { stepPaperSession } from './paper-engine';
import type { DashboardOptions } from './server';
import { DashboardReportStore } from './report-store';
import { DataLake } from './data-lake';
import { aggregateMinutes, MINUTE_MS } from '../market-data/historical-minute-archive';

const coins = z.array(backtestConfigSchema.shape.coin).min(1).max(500).default(['SOL']);
const researchSchema = backtestConfigSchema.omit({ coin: true }).extend({ coins,
  fastPeriods: z.array(z.number().int().min(1).max(200)).min(1).max(8).default([5, 9]),
  slowPeriods: z.array(z.number().int().min(2).max(200)).min(1).max(8).default([21, 30]),
}).strict();
const validationSchema = researchSchema.extend({ bars: z.number().int().min(150).max(1000).default(600),
  trainPercent: z.number().int().min(30).max(70).default(60), oosPercent: z.number().int().min(15).max(40).default(20),
  costStressMultiplier: z.number().finite().min(1).max(5).default(2) }).strict();
const presetSchema = z.object({ name: z.string().trim().min(1).max(100), strategy: backtestConfigSchema.shape.strategy,
  ...futuresConfigSchema.shape, gstRatePct: backtestConfigSchema.shape.gstRatePct.default(18), maxOrderNotionalInr: backtestConfigSchema.shape.maxOrderNotionalInr,
  timeframe: backtestConfigSchema.shape.timeframe, parameters: z.record(z.unknown()).default({}),
  slMode: backtestConfigSchema.shape.stopLossMode, slValue: backtestConfigSchema.shape.stopLossValue,
  tpMode: backtestConfigSchema.shape.takeProfitMode, tpValue: backtestConfigSchema.shape.takeProfitValue }).strict();
const settingsSchema = workspaceSettingsSchema.extend({ timezone: z.string().min(1).max(100) }).partial().strict();
const syncSchema = backtestConfigSchema.extend({ coin: backtestConfigSchema.shape.coin.default('SOL') })
  .pick({ coin: true, timeframe: true, bars: true, endTimeMs: true }).strict();
type SnapshotSyncConfig = z.infer<typeof syncSchema>;
export interface MatrixCell { coin: string; parameters: Record<string, unknown>; status: 'COMPLETED' | 'INVALID'; reason: string | null;
  runId: string | null; summary: PracticalBacktestReport['summary'] | null; rank: number | null }
const rankScore = (s: PracticalBacktestReport['summary']): number => s.profitFactor ?? (s.netPnlInr > 0 && s.totalTrades > 0 ? Number.MAX_SAFE_INTEGER : -1);

export class WorkspaceEngine {
  readonly datasets: WorkspaceDatasetStore;
  readonly dataLake: DataLake;
  #stopped: boolean;
  #epoch = 0;
  #syncActive = false;
  #syncCancelled = false;
  #syncTask: Promise<void> = Promise.resolve();
  constructor(readonly store: WorkspaceStore, readonly options: DashboardOptions, readonly reports: DashboardReportStore, readonly signal: AbortSignal) {
    this.datasets = new WorkspaceDatasetStore(store.root); this.#stopped = store.snapshot().operations.admissionStopped;
    this.dataLake = new DataLake(store, options.client, () => options.clock.nowMs(), signal);
  }
  public get admissionStopped(): boolean { return this.#stopped; }
  public admission(): number { if (this.#stopped) throw new Error('OPERATOR_STOPPED'); return this.#epoch; }
  public assertAdmission(epoch: number): void { this.signal.throwIfAborted(); if (this.#stopped || epoch !== this.#epoch) throw new Error('OPERATOR_STOPPED'); }
  public async operations(stop: boolean, input: unknown) {
    const { reason } = z.object({ reason: z.string().trim().max(500).default('Operator request') }).strict().parse(input ?? {});
    if (stop) { this.#stopped = true; this.#epoch++; }
    const epoch = this.#epoch;
    const result = await this.store.mutate(state => {
      state.operations = { admissionStopped: stop, generation: state.operations.generation + 1, reason, updatedAtMs: this.options.clock.nowMs() };
      let cancelled = 0;
      if (stop) for (const session of state.paperSessions) for (const order of session.orders.filter(o => o.status === 'Working' && o.action === 'OPEN')) {
        order.status = 'Cancelled'; order.reason = 'OPERATOR_STOPPED'; order.updatedAtMs = this.options.clock.nowMs(); cancelled++;
      }
      auditWorkspace(state, this.options.clock.nowMs(), stop ? 'ADMISSION_STOPPED' : 'ADMISSION_RESUMED', 'WORKSPACE', { reason, cancelled });
      return state.operations;
    });
    if (!stop && epoch === this.#epoch) this.#stopped = false; return result;
  }
  public async saveStrategy(input: unknown) {
    const preset = presetSchema.parse(withFuturesStrategyDefaults(input));
    const config = parseBacktestConfig({ coin: this.store.snapshot().settings.defaultCoin, strategy: preset.strategy, timeframe: preset.timeframe,
      parameters: preset.parameters, ...futuresConfigSchema.strip().parse(preset), maxOrderNotionalInr: preset.maxOrderNotionalInr,
      stopLossMode: preset.slMode, stopLossValue: preset.slValue, takeProfitMode: preset.tpMode, takeProfitValue: preset.tpValue });
    const parameters = this.validateStrategy(config);
    return this.store.mutate(state => {
      const existing = state.savedStrategies.find(p => p.name.toLowerCase() === preset.name.toLowerCase());
      const saved = { ...preset, ...futuresConfigSchema.strip().parse(config), parameters: { ...parameters }, id: existing?.id ?? workspaceId(state, 'strategy'), updatedAtMs: this.options.clock.nowMs() };
      if (existing) state.savedStrategies[state.savedStrategies.indexOf(existing)] = saved; else state.savedStrategies.push(saved);
      auditWorkspace(state, saved.updatedAtMs, 'STRATEGY_SAVED', saved.id, { name: saved.name, strategy: saved.strategy }); return saved;
    });
  }
  public async settings(input: unknown) {
    const update = settingsSchema.parse(input);
    if (update.defaultCoin) this.store.assertTracked(update.defaultCoin);
    if (update.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: update.timezone }); } catch { throw new Error('INVALID_TIMEZONE'); } }
    return this.store.mutate(state => { state.settings = workspaceSettingsSchema.parse({ ...effectiveWorkspaceSettings(state.settings), ...update });
      auditWorkspace(state, this.options.clock.nowMs(), 'SETTINGS_UPDATED', 'WORKSPACE'); return state.settings; });
  }
  public async acknowledge(id: string) {
    return this.store.mutate(state => {
      const alert = state.alerts.find(a => a.id === id); if (!alert) throw new Error('ALERT_NOT_FOUND');
      alert.acknowledgedAtMs ??= this.options.clock.nowMs(); auditWorkspace(state, this.options.clock.nowMs(), 'ALERT_ACKNOWLEDGED', id); return alert;
    });
  }
  public async sync(input: unknown) {
    const config = syncSchema.parse(input), epoch = this.admission();
    this.store.assertTracked(config.coin);
    return this.job('DATA_SYNC', async () => {
      config.endTimeMs ??= this.options.clock.nowMs();
      const window = this.snapshotSyncWindow(config);
      await this.dataLake.archive.ensureRange({ getCandles: query => { this.assertAdmission(epoch); return this.options.client.getCandles(query); } }, researchPair(config.coin), window, this.signal);
      this.assertAdmission(epoch); return this.saveSyncedDataset(config);
    });
  }
  private snapshotSyncWindow(config: SnapshotSyncConfig) {
    const interval = Number(timeframeResolution[config.timeframe]) * MINUTE_MS, endTimeMs = config.endTimeMs ?? this.options.clock.nowMs();
    if (endTimeMs > this.options.clock.nowMs()) throw new Error('FUTURE_HISTORY_REFUSED');
    const toMs = Math.floor(endTimeMs / interval) * interval;
    return { fromMs: toMs - config.bars * interval, toMs };
  }
  private async saveSyncedDataset(config: SnapshotSyncConfig) {
    const resolution = timeframeResolution[config.timeframe], { fromMs, toMs } = this.snapshotSyncWindow(config), pair = researchPair(config.coin);
    const raw = (await this.dataLake.archive.read(pair)).filter(c => c.openTimeMs >= fromMs && c.openTimeMs < toMs);
    // Retain honest gaps; only complete minute groups produce higher-timeframe bars.
    const minutes = Number(resolution), byTime = new Map(raw.map(c => [c.openTimeMs, c]));
    const candles = minutes === 1 ? raw : Array.from({ length: config.bars }, (_, i) => {
      const window = { fromMs: fromMs + i * minutes * MINUTE_MS, toMs: fromMs + (i + 1) * minutes * MINUTE_MS };
      const group = Array.from({ length: minutes }, (_, j) => byTime.get(window.fromMs + j * MINUTE_MS)).filter(c => c !== undefined);
      return group.length === minutes ? aggregateMinutes(group, minutes, window)[0]! : null;
    }).filter(c => c !== null);
    const dataset = await this.datasets.save({ pair: researchPair(config.coin), resolution, fromMs, toMs, candles: candles.map(storeCandle) });
    await this.store.mutate(state => {
      const metadata = { id: dataset.id, pair: dataset.pair, resolution, bars: candles.length, fromMs, toMs, complete: dataset.quality.complete,
        missingBars: dataset.quality.missingBars, updatedAtMs: this.options.clock.nowMs() };
      const index = state.datasets.findIndex(d => d.id === dataset.id); if (index >= 0) state.datasets[index] = metadata; else state.datasets.push(metadata);
      if (!dataset.quality.complete) alertWorkspace(state, this.options.clock.nowMs(), 'DATA_GAPS', `${dataset.quality.missingBars} expected bars are missing. No gap candles were fabricated.`, dataset.id);
      auditWorkspace(state, this.options.clock.nowMs(), 'DATA_SYNC_COMPLETED', dataset.id, { missingBars: dataset.quality.missingBars, bars: candles.length });
    });
    return dataset;
  }
  /** Persist admission before returning; provider work runs independently of the HTTP response. */
  public async startSync(input: unknown) {
    if (this.#syncActive) throw new Error('RUN_IN_PROGRESS');
    const epoch = this.admission();
    const historical = typeof input === 'object' && input !== null && ['action', 'all', 'days', 'fromDate', 'toDate', 'fromMs', 'toMs'].some(k => k in input);
    const snapshot = historical ? null : syncSchema.parse(input);
    // Freeze a blank end time so a long download cannot move its snapshot window.
    if (snapshot) snapshot.endTimeMs ??= this.options.clock.nowMs();
    const request = snapshot ? { action: 'backfill', coin: snapshot.coin, ...this.snapshotSyncWindow(snapshot) } : input;
    const { config } = this.dataLake.validate(request);
    const operation = snapshot ? 'SYNC' as const : config.all && config.action === 'sync' ? 'SYNC_ALL' as const
      : config.action === 'extend' ? 'EXTEND_ALL' as const : config.action === 'repair' ? 'REPAIR' as const : config.action === 'backfill' ? 'BACKFILL' as const : 'SYNC' as const;
    this.#syncActive = true; this.#syncCancelled = false;
    let jobId: string;
    try {
      jobId = await this.store.mutate(state => {
        const id = workspaceId(state, 'job');
        state.syncJobStatus = { jobId: id, status: 'RUNNING', coin: config.coin ?? null, pair: config.coin ? researchPair(config.coin) : null,
          operation, completedChunks: 0, totalChunks: 0, percentComplete: 0, candlesFetched: 0, etaSeconds: null, message: 'Preparing missing candle chunks…', error: null };
        state.jobs.push({ id, type: 'DATA_SYNC', status: 'RUNNING', createdAtMs: this.options.clock.nowMs(), completedAtMs: null, error: null });
        state.jobs = state.jobs.slice(-500); auditWorkspace(state, this.options.clock.nowMs(), 'DATA_SYNC_STARTED', id, { operation }); return id;
      });
    } catch (error) { this.#syncActive = false; throw error; }
    const check = () => { if (this.#syncCancelled) throw new Error('SYNC_CANCELLED'); this.assertAdmission(epoch); };
    const finish = async (status: 'COMPLETED' | 'CANCELLED' | 'FAILED', message: string, error: string | null = null) => {
      await this.store.mutate(state => {
        const current = state.syncJobStatus!;
        if (status === 'COMPLETED' && this.#syncCancelled) { status = 'CANCELLED'; message = 'Sync cancelled. All downloaded chunks are saved.'; }
        state.syncJobStatus = { ...current, status, message, error, etaSeconds: 0, percentComplete: status === 'COMPLETED' ? 100 : current.percentComplete };
        const job = state.jobs.find(j => j.id === jobId)!; job.status = status; job.error = error; job.completedAtMs = this.options.clock.nowMs();
        auditWorkspace(state, this.options.clock.nowMs(), `DATA_SYNC_${status}`, jobId, { completedChunks: current.completedChunks, candlesFetched: current.candlesFetched });
        if (status === 'FAILED') alertWorkspace(state, this.options.clock.nowMs(), 'JOB_FAILED', message, jobId);
      });
    };
    this.#syncTask = (async () => {
      await yieldImmediate();
      try {
        check(); const plan = await this.dataLake.prepare(config); check();
        await this.store.mutate(state => { state.syncJobStatus!.totalChunks = plan.totalChunks; state.syncJobStatus!.message = 'Downloading missing closed candles…'; });
        const started = performance.now();
        const result = await this.dataLake.execute(plan, check, async chunk => {
          await this.store.mutate(state => {
            const job = state.syncJobStatus!, completed = job.completedChunks + 1;
            job.coin = chunk.pair.slice(2, -5); job.pair = chunk.pair; job.completedChunks = completed;
            job.candlesFetched += chunk.candlesFetched;
            // Reserve 100% for the persisted terminal state and snapshot finalization.
            job.percentComplete = Math.min(99, Math.floor(completed / Math.max(1, job.totalChunks) * 100));
            job.etaSeconds = Math.ceil((performance.now() - started) / 1000 / completed * Math.max(0, job.totalChunks - completed));
            job.message = this.#syncCancelled ? 'Cancelling after saving this chunk…' : `Downloading ${chunk.pair} · Chunk ${completed} / ${job.totalChunks} (${job.percentComplete}%) · ${job.candlesFetched.toLocaleString('en-US')} candles`;
          });
        });
        check(); if (snapshot) await this.saveSyncedDataset(snapshot); check();
        const missing = result.results.reduce((n, r) => n + r.requestedMissingMinutes, 0);
        await finish('COMPLETED', missing ? `Sync completed. ${missing} requested minutes remain unavailable; no candles were fabricated.` : 'Sync completed. All downloaded chunks are saved.');
      } catch (error) {
        if (this.#syncCancelled || this.signal.aborted || error instanceof Error && error.message === 'OPERATOR_STOPPED') {
          await finish('CANCELLED', 'Sync cancelled. All downloaded chunks are saved.');
        } else {
          const safe = new Set(['INVALID_CANDLE', 'CONFLICTING_CANDLE', 'INVALID_HISTORY_WINDOW', 'FUTURE_HISTORY_REFUSED', 'DATASET_INVALID', 'WORKSPACE_CAPACITY_LIMIT']);
          const code = error instanceof Error && safe.has(error.message) ? error.message : 'DATA_SYNC_FAILED';
          await finish('FAILED', 'Sync failed. Downloaded chunks are retained; retry to fetch missing minutes.', code);
        }
      }
    })().finally(() => { this.#syncActive = false; });
    return { jobId, status: 'RUNNING' as const, completion: this.#syncTask };
  }
  public async cancelSync(input: unknown) {
    const { jobId } = z.object({ jobId: z.string().max(100).optional() }).strict().parse(input ?? {}), current = this.store.syncStatus();
    if (jobId && current.jobId !== jobId) throw new Error('SYNC_JOB_CHANGED');
    if (current.status !== 'RUNNING') return current;
    this.#syncCancelled = true;
    await this.store.mutate(state => { if (state.syncJobStatus?.status === 'RUNNING') {
      state.syncJobStatus.message = 'Cancelling after the current chunk is saved…'; state.syncJobStatus.etaSeconds = null;
    } });
    return this.store.syncStatus();
  }
  public waitForSync(): Promise<void> { return this.#syncTask; }
  public async matrix(input: unknown) {
    const request = researchSchema.parse(withFuturesStrategyDefaults(input)), epoch = this.admission();
    request.coins.forEach(coin => this.store.assertTracked(coin));
    return this.job('MATRIX', async () => {
      const configs = this.candidates(request), endTimeMs = request.endTimeMs ?? this.options.clock.nowMs(), runner = this.runner();
      const fx = request.inrPerUsdt ?? Number((await this.options.readSettlementConversion()).rateInrPerUsdt);
      const cells: MatrixCell[] = [];
      for (const coin of [...new Set(request.coins)]) {
        const candles = await fetchHistoricalCandles(this.options.client, { pair: researchPair(coin), resolution: timeframeResolution[request.timeframe], bars: request.bars, endTimeMs, signal: this.signal });
        for (const candidate of configs) {
          await yieldImmediate(); this.assertAdmission(epoch);
          const config = parseBacktestConfig({ ...candidate, coin, inrPerUsdt: fx, endTimeMs });
          try { this.validateStrategy(config); } catch { cells.push({ coin, parameters: config.parameters, status: 'INVALID', reason: 'INVALID_STRATEGY_PARAMETERS', runId: null, summary: null, rank: null }); continue; }
          const report = await runner.runOnCandles(config, candles); this.assertAdmission(epoch); await this.reports.saveBacktest(report);
          cells.push({ coin, parameters: config.parameters, status: 'COMPLETED', reason: null, runId: report.runId, summary: report.summary, rank: null });
        }
      }
      const ranked = cells.filter(c => c.summary).sort((a, b) => rankScore(b.summary!) - rankScore(a.summary!) || b.summary!.netPnlInr - a.summary!.netPnlInr || String(a.runId).localeCompare(String(b.runId)));
      ranked.forEach((cell, index) => { cell.rank = index + 1; });
      return this.researchResult('MATRIX', epoch, { cells, ranked, ranking: 'PROFIT_FACTOR_THEN_NET_PNL', fixedInrPerUsdt: fx, endTimeMs,
        fundingLabel: fundingLabel(parseBacktestConfig({ coin: request.coins[0], ...futuresConfigSchema.strip().parse(request) })) });
    });
  }
  public async validate(input: unknown) {
    const request = validationSchema.parse(withFuturesStrategyDefaults(input)), epoch = this.admission();
    request.coins.forEach(coin => this.store.assertTracked(coin));
    if (request.trainPercent + request.oosPercent > 85) throw new Error('INVALID_VALIDATION_SPLIT');
    return this.job('VALIDATION', async () => {
      const { trainPercent, oosPercent, costStressMultiplier, ...base } = request;
      const configs = this.candidates(base), endTimeMs = request.endTimeMs ?? this.options.clock.nowMs(), runner = this.runner();
      const fx = request.inrPerUsdt ?? Number((await this.options.readSettlementConversion()).rateInrPerUsdt);
      const byPair: { pair: string; selectedOnTrain: number | null; candidates: { parameters: Record<string, unknown>; folds: { name: string; fromMs: number; toMs: number; bars: number; runId: string; summary: PracticalBacktestReport['summary'] }[]; costStress: PracticalBacktestReport['summary']; rank: number }[] }[] = [];
      for (const coin of [...new Set(request.coins)]) {
        const candles = await fetchHistoricalCandles(this.options.client, { pair: researchPair(coin), resolution: timeframeResolution[request.timeframe], bars: request.bars, endTimeMs, signal: this.signal });
        const trainEnd = Math.floor(candles.length * trainPercent / 100), oosEnd = trainEnd + Math.floor(candles.length * oosPercent / 100);
        const slices = [candles.slice(0, trainEnd), candles.slice(trainEnd, oosEnd), candles.slice(oosEnd)];
        if (slices.some(s => s.length < 30)) throw new Error('VALIDATION_FOLD_TOO_SMALL');
        const candidates: (typeof byPair)[number]['candidates'] = [];
        for (const candidate of configs) {
          this.assertAdmission(epoch);
          const config = parseBacktestConfig({ ...candidate, coin, inrPerUsdt: fx }); this.validateStrategy(config);
          const folds: (typeof candidates)[number]['folds'] = [];
          for (const [index, slice] of slices.entries()) {
            await yieldImmediate(); this.assertAdmission(epoch);
            const end = slice.at(-1)!.openTimeMs + Number(timeframeResolution[config.timeframe]) * 60_000;
            const report = await runner.runOnCandles({ ...config, bars: slice.length, endTimeMs: end }, slice); await this.reports.saveBacktest(report);
            folds.push({ name: ['TRAIN', 'OOS', 'HOLDOUT'][index]!, fromMs: slice[0]!.openTimeMs, toMs: end, bars: slice.length, runId: report.runId, summary: report.summary });
          }
          const oos = slices[1]!, stressConfig = { ...config, bars: oos.length, endTimeMs: folds[1]!.toMs,
            makerFeeBps: config.makerFeeBps * costStressMultiplier, takerFeeBps: config.takerFeeBps * costStressMultiplier,
            slippageBps: config.slippageBps * costStressMultiplier, spreadBps: config.spreadBps * costStressMultiplier, stopSlippageBps: config.stopSlippageBps * costStressMultiplier };
          const stress = await runner.runOnCandles(stressConfig, oos); await this.reports.saveBacktest(stress);
          candidates.push({ parameters: config.parameters, folds, costStress: stress.summary, rank: 0 });
        }
        const trainWinner = [...candidates].sort((a, b) => b.folds[0]!.summary.netPnlInr - a.folds[0]!.summary.netPnlInr)[0];
        candidates.sort((a, b) => rankScore(b.folds[1]!.summary) - rankScore(a.folds[1]!.summary) || b.folds[1]!.summary.netPnlInr - a.folds[1]!.summary.netPnlInr);
        candidates.forEach((c, i) => { c.rank = i + 1; });
        byPair.push({ pair: researchPair(coin), selectedOnTrain: trainWinner?.rank ?? null, candidates });
      }
      return this.researchResult('VALIDATION', epoch, { byPair, fixedInrPerUsdt: fx, selection: 'TRAIN_NET_PNL_ONLY', ranking: 'OOS_PROFIT_FACTOR_THEN_NET_PNL',
        fundingLabel: fundingLabel(parseBacktestConfig({ coin: request.coins[0], ...futuresConfigSchema.strip().parse(request) })),
        costStressMultiplier, foldPolicy: 'Chronological non-overlapping TRAIN/OOS/HOLDOUT; each fold starts flat and warms its own indicators. Holdout is excluded from selection and ranking.' });
    });
  }
  public async createPaper(input: unknown) {
    const epoch = this.admission();
    const { name, ...body } = backtestConfigSchema.extend({ name: z.string().trim().min(1).max(100).default('Virtual INR account'),
      coin: backtestConfigSchema.shape.coin.default('SOL'), capitalInr: z.number().finite().positive().max(1_000_000_000).default(125000),
      maxOrderNotionalInr: z.number().finite().positive().max(1_000_000_000).default(10000),
      stopLossMode: backtestConfigSchema.shape.stopLossMode.default('PERCENT'), stopLossValue: z.number().finite().nonnegative().default(1) }).strict().parse(withFuturesStrategyDefaults(input));
    const config = parseBacktestConfig(body); this.store.assertTracked(config.coin); this.validateStrategy(config);
    return this.store.mutate(state => {
      this.assertAdmission(epoch); const now = this.options.clock.nowMs();
      const session: PaperSession = { id: workspaceId(state, 'paper'), name, status: 'RUNNING', mode: 'PAPER', createdAtMs: now, updatedAtMs: now, config,
        book: { cashInr: String(config.capitalInr), position: null, trades: [] }, candles: [], lastProcessedOpenMs: null, orders: [], fills: [], lastRisk: null,
        lastMarkPriceUsdt: null, lastFxInrPerUsdt: null, equityInr: String(config.capitalInr), peakEquityInr: String(config.capitalInr), unrealizedPnlInr: '0',
        consecutiveLossCount: 0, fundingNote: fundingLabel(config) === 'Excluded' ? 'Funding excluded' : fundingLabel(config), promotion: 'PAPER · no promotion' };
      state.paperSessions.push(session); auditWorkspace(state, now, 'PAPER_SESSION_CREATED', session.id, { capitalInr: config.capitalInr }); return session;
    });
  }
  public async togglePaper(id: string, input: unknown) {
    const { running } = z.object({ running: z.boolean().optional() }).strict().parse(input ?? {});
    return this.store.mutate(state => {
      const session = state.paperSessions.find(s => s.id === id); if (!session) throw new Error('PAPER_SESSION_NOT_FOUND');
      const next = running ?? session.status !== 'RUNNING'; if (next) this.admission();
      session.status = next ? 'RUNNING' : 'PAUSED'; session.updatedAtMs = this.options.clock.nowMs();
      if (!next) for (const order of session.orders.filter(o => o.status === 'Working')) { order.status = 'Cancelled'; order.reason = 'SESSION_PAUSED'; order.updatedAtMs = session.updatedAtMs; }
      auditWorkspace(state, session.updatedAtMs, next ? 'PAPER_SESSION_RESUMED' : 'PAPER_SESSION_PAUSED', id); return session;
    });
  }
  public async stepPaper(id: string) {
    const stepEpoch = this.#epoch;
    const snapshot = this.store.snapshot().paperSessions.find(s => s.id === id); if (!snapshot) throw new Error('PAPER_SESSION_NOT_FOUND');
    if (snapshot.status !== 'RUNNING') throw new Error('PAPER_SESSION_PAUSED');
    const pair = researchPair(snapshot.config.coin), resolution = timeframeResolution[snapshot.config.timeframe], interval = Number(resolution) * 60_000;
    const endTimeMs = Math.floor(this.options.clock.nowMs() / interval) * interval;
    if (snapshot.lastProcessedOpenMs !== null && snapshot.lastProcessedOpenMs + interval === endTimeMs) return snapshot;
    const bars = snapshot.lastProcessedOpenMs === null ? snapshot.config.bars : (endTimeMs - snapshot.lastProcessedOpenMs) / interval - 1;
    if (bars < 1 || bars > 1000) throw new Error('PAPER_BACKFILL_REQUIRED');
    const incoming = await fetchHistoricalCandles(this.options.client, { pair, resolution, bars, endTimeMs, signal: this.signal });
    const raw = await this.options.client.getInrFuturesInstrument(pair), instrumentObservedAtMs = this.options.clock.nowMs();
    const settlement = await this.options.readSettlementConversion();
    const instrument = mapInstrumentToMetadata(raw, snapshot.config.coin); this.signal.throwIfAborted();
    const macroSource = snapshot.config.use4hTrend100 || snapshot.config.use4hTrend200 ? await this.dataLake.archive.read(pair) : [];
    return this.store.mutate(state => {
      const session = state.paperSessions.find(s => s.id === id); if (!session) throw new Error('PAPER_SESSION_NOT_FOUND');
      if (session.lastProcessedOpenMs !== snapshot.lastProcessedOpenMs) throw new Error('PAPER_STEP_CONFLICT');
      return stepPaperSession(state, session, incoming, instrument, settlement, this.options.clock.nowMs(), !this.#stopped && stepEpoch === this.#epoch, instrumentObservedAtMs, macroSource);
    });
  }
  public async export(id: string, format: string) {
    if (!['csv', 'json'].includes(format)) throw new Error('INVALID_EXPORT_FORMAT');
    const state = this.store.snapshot();
    const session = state.paperSessions.find(s => s.id === id), research = state.researchRuns.find(r => r.id === id), strategy = state.savedStrategies.find(s => s.id === id);
    const report: unknown = id === 'workspace-audit' ? { workspace: state, reports: await this.reports.inventory(), persistence: await this.store.verifyPersistence() }
      : session ?? research ?? strategy ?? await this.reports.read(id);
    if (/^(?:bt|sh)-/.test(id) || id === 'latest-shadow') { if ((await this.reports.inspect(id)).integrity === 'FAILED') throw new Error('EVIDENCE_INTEGRITY_FAILED'); }
    const secrets = [this.options.apiKey ?? '', this.options.apiSecret ?? '', ...(this.options.redactValues ?? [])];
    const redacted = redactEvidence(report, secrets);
    const funding = redacted as { summary?: { fundingNote?: string }; fundingNote?: string };
    if (format === 'json') return { filename: `${id}.json`, contentType: 'application/json', content: JSON.stringify({ mode: 'RESEARCH_OR_PAPER', liveLocked: true,
      promotion: 'PAPER · no promotion', fundingNote: funding.summary?.fundingNote ?? funding.fundingNote ?? (state.paperSessions.some(s => s.config.fundingMode === 'MODELED_FIXED_BPS') ? 'Funding modeled per session; fixed-rate estimates' : 'Funding excluded'), report: redacted, contentSha256: evidenceDigest(redacted),
      integrityNote: 'Digest covers the redacted report value. Local integrity is not a signature or execution authority.',
      audit: redactEvidence(id === 'workspace-audit' ? state.auditLog : state.auditLog.filter(a => a.scope === id), secrets) }, null, 2) };
    const ledger = (redacted as { book?: { trades?: unknown }; trades?: unknown }).book?.trades ?? (redacted as PracticalBacktestReport).trades;
    if (!Array.isArray(ledger)) throw new Error('EXPORT_LEDGER_UNAVAILABLE');
    const keys = ['tradeId', 'side', 'entryTimeIso', 'entryPrice', 'exitTimeIso', 'exitPrice', 'quantity', 'grossPnlInr', 'feeInr', 'netPnlInr', 'exitReason', 'events',
      'leverage', 'marginUsedInr', 'liquidationPrice', 'fundingInr', 'marginRoiPct'] as const;
    const cell = (value: unknown): string => { let text = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
      if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replace(/"/g, '""')}"`; };
    return { filename: `${id}.csv`, contentType: 'text/csv; charset=utf-8', content: [keys.join(','), ...ledger.map(t => keys.map(k => cell(t[k])).join(','))].join('\r\n') };
  }
  public async evidence() {
    const state = this.store.snapshot(), persistence = await this.store.verifyPersistence();
    const integrity = persistence.status === 'FAILED' ? 'FAILED' : persistence.contentSha256 === evidenceDigest(state) ? 'VERIFIED' : 'DIGEST_ONLY';
    const entries = [...await this.reports.inventory(), ...state.savedStrategies.map(s => ({ id: s.id, kind: 'STRATEGY', title: s.name,
      timestamp: new Date(s.updatedAtMs).toISOString(), source: '.local/workspace-state.json#savedStrategies', sha256: evidenceDigest(s), integrity })),
      ...state.paperSessions.map(s => ({ id: s.id, kind: 'PAPER', title: s.name, timestamp: new Date(s.updatedAtMs).toISOString(),
        source: '.local/workspace-state.json#paperSessions', sha256: evidenceDigest(s), integrity }))];
    return { entries: redactEvidence(entries, [this.options.apiKey ?? '', this.options.apiSecret ?? '', ...(this.options.redactValues ?? [])]),
      persistence, authorityChanges: 0, authorityScope: 'THIS_DASHBOARD · NO_LIVE_AUTHORITY',
      limitations: ['Local SHA-256 checks detect content changes; they are not external signatures.', 'DIGEST_ONLY archives have no retained baseline seal.', 'Workspace components are covered by the verified workspace envelope.'] };
  }
  public async historicalAction(input: unknown) {
    const epoch = this.admission();
    return this.job('DATA_LAKE', () => this.dataLake.run(input, () => this.assertAdmission(epoch)));
  }
  private runner() { return new PracticalBacktestRunner({ client: this.options.client, nowMs: () => this.options.clock.nowMs(), signal: this.signal, archive: this.dataLake.archive }); }
  private validateStrategy(config: PracticalBacktestConfig): Readonly<Record<string, unknown>> { return new HistoricalStrategySession(researchPair(config.coin), config.strategy,
    Number(timeframeResolution[config.timeframe]), Math.floor(this.options.clock.nowMs() / 3_600_000) * 3_600_000, strategyParameters(config)).kernel.normalizedParameters; }
  private candidates(request: z.infer<typeof researchSchema>): Omit<PracticalBacktestConfig, 'coin'>[] {
    const { coins: selected, fastPeriods, slowPeriods, ...base } = request;
    const grid = ['ema-trend', 'multi-timeframe-trend'].includes(base.strategy) ? [...new Set(fastPeriods)].flatMap(fastPeriod => [...new Set(slowPeriods)].map(slowPeriod => ({ fastPeriod, slowPeriod }))) : [{}];
    if (grid.length * selected.length > 64) throw new Error('MATRIX_CELL_LIMIT');
    return grid.map(parameters => ({ ...base, parameters: { ...base.parameters, ...parameters } }));
  }
  private async researchResult<T extends Record<string, unknown>>(type: 'MATRIX' | 'VALIDATION', epoch: number, result: T) {
    return this.store.mutate(state => {
      this.assertAdmission(epoch); const id = workspaceId(state, type === 'MATRIX' ? 'matrix' : 'validation');
      const complete = { ...result, id, mode: 'PAPER', promotion: 'PAPER · no promotion', fundingNote: result['fundingLabel'] === 'Excluded' || !result['fundingLabel'] ? 'Funding excluded' : `Funding ${String(result['fundingLabel']).toLowerCase()}` };
      state.researchRuns.push({ id, type, createdAtMs: this.options.clock.nowMs(), result: complete }); state.researchRuns = state.researchRuns.slice(-100);
      auditWorkspace(state, this.options.clock.nowMs(), `${type}_COMPLETED`, id); return complete;
    });
  }
  private async job<T>(type: string, work: () => Promise<T>): Promise<T> {
    const id = await this.store.mutate(state => { const id = workspaceId(state, 'job'); state.jobs.push({ id, type, status: 'RUNNING', createdAtMs: this.options.clock.nowMs(), completedAtMs: null, error: null }); state.jobs = state.jobs.slice(-500); return id; });
    try {
      const result = await work(); await this.store.mutate(state => { const job = state.jobs.find(j => j.id === id)!; job.status = 'COMPLETED'; job.completedAtMs = this.options.clock.nowMs(); }); return result;
    } catch (error) {
      await this.store.mutate(state => { const job = state.jobs.find(j => j.id === id)!; job.status = 'FAILED'; job.completedAtMs = this.options.clock.nowMs();
        const safeCodes = new Set(['OPERATOR_STOPPED', 'INCOMPLETE_CANDLE_HISTORY', 'CONFLICTING_CANDLE', 'INVALID_CANDLE', 'FUTURE_HISTORY_REFUSED',
          'INR_CONVERSION_REQUIRED', 'INVALID_VALIDATION_SPLIT', 'VALIDATION_FOLD_TOO_SMALL', 'MATRIX_CELL_LIMIT', 'INVALID_PROTECTIVE_DISTANCE', 'INVALID_STRATEGY_TIMEFRAMES']);
        job.error = error instanceof Error && safeCodes.has(error.message) ? error.message : 'WORKSPACE_JOB_FAILED'; alertWorkspace(state, this.options.clock.nowMs(), 'JOB_FAILED', job.error, id); auditWorkspace(state, this.options.clock.nowMs(), 'JOB_FAILED', id, { type, error: job.error }); }); throw error;
    }
  }
}

export function workspacePaperViews(state: WorkspaceState) {
  return { paperOrders: state.paperSessions.flatMap(s => s.orders.map(order => ({ ...order, sessionId: s.id, mode: 'PAPER' }))),
    paperPositions: state.paperSessions.flatMap(s => s.book.position ? [{ ...s.book.position, sessionId: s.id, pair: researchPair(s.config.coin),
      unrealizedPnlInr: s.unrealizedPnlInr, markPriceUsdt: s.lastMarkPriceUsdt, inrPerUsdt: s.lastFxInrPerUsdt, mode: 'PAPER' }] : []) };
}
