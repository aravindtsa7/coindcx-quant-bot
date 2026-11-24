import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sha256CanonicalJson } from '../risk/canonical';
import { backtestConfigSchema, futuresConfigSchema } from '../integration/coindcx/live/practical-backtest-runner';

const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/).max(100);
const time = z.number().int().nonnegative().safe();
const scalar = z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]);
export const workspaceSettingsSchema = z.object({ language: z.enum(['en', 'hi', 'ta']), timezone: z.string().max(100), defaultCoin: z.string().regex(/^[A-Z0-9]{1,24}$/),
  defaultEquityInr: z.number().finite().positive().max(1_000_000_000).optional(), defaultMaxOrderNotionalInr: z.number().finite().positive().max(1_000_000_000).optional(),
  defaultSlPct: z.number().finite().min(0).lt(100).optional(), defaultTpPct: z.number().finite().min(0).lt(100).optional(),
  notifications: z.object({ researchCompletion: z.boolean(), routineStatus: z.boolean() }).strict().optional() }).strict();
// Optional fields deliberately have no schema defaults: old envelope checksums must remain verifiable.
export const effectiveWorkspaceSettings = (settings: z.infer<typeof workspaceSettingsSchema>) => ({
  defaultEquityInr: 5000, defaultMaxOrderNotionalInr: 700, defaultSlPct: 1, defaultTpPct: 2,
  notifications: { researchCompletion: true, routineStatus: true }, ...settings });
export const storedCandleSchema = z.object({ timeMs: time, open: decimal, high: decimal, low: decimal, close: decimal, volume: decimal }).strict();
export type StoredCandle = z.infer<typeof storedCandleSchema>;
const event = z.object({ type: z.enum(['DECISION_RECORDED', 'ENTRY_FILL', 'SL_TP_ARMED', 'TRAILING_STOP_UPDATED', 'BREAKEVEN_ARMED', 'FUNDING_SETTLEMENT', 'EXIT_FILL']), timestampMs: time,
  details: z.record(z.union([z.string(), z.number().finite(), z.null()])) }).strict();
const trade = z.object({ tradeId: z.string(), side: z.enum(['LONG', 'SHORT']), entryTimeIso: z.string(), entryPrice: z.number().positive(),
  exitTimeIso: z.string(), exitPrice: z.number().positive(), quantity: z.number().positive(), grossPnlInr: z.number().finite(),
  feeInr: z.number().nonnegative(), gstInr: z.number().finite().nonnegative().optional(), netPnlInr: z.number().finite(), exitReason: z.enum(['SIGNAL_FLAT', 'SIGNAL_REVERSAL', 'SIGNAL_EXIT', 'TARGET_CHANGE', 'STOP_LOSS', 'TRAILING_STOP', 'TAKE_PROFIT', 'LIQUIDATION', 'BREAKEVEN', 'END_OF_DATA']),
  leverage: z.number().int().min(1).max(20).optional(), marginUsedInr: z.number().finite().nonnegative().optional(), liquidationPrice: z.number().finite().positive().nullable().optional(),
  fundingInr: z.number().finite().optional(), marginRoiPct: z.number().finite().optional(), events: z.array(event) }).strict();
const position = z.object({ side: z.enum(['LONG', 'SHORT']), entryPrice: decimal, quantity: decimal, contractMultiplier: decimal, entryFeeInr: decimal,
  entryTimeMs: time, stopPrice: decimal.nullable(), takeProfitPrice: decimal.nullable(), events: z.array(event),
  leverage: z.number().int().min(1).max(20).optional(), marginUsedInr: decimal.optional(), liquidationPrice: decimal.nullable().optional(),
  fundingInr: decimal.optional(), lastFundingTimeMs: time.optional(), peakFavorablePrice: decimal.optional(), trailingStopPrice: decimal.nullable().optional(), entryGstInr: decimal.optional(), originalSlDistance: decimal.nullable().optional(),
  signalAtrPrice: decimal.nullable().optional(), breakevenStopPrice: decimal.nullable().optional(), breakevenArmed: z.boolean().optional() }).strict();
export const paperOrderSchema = z.object({ id: z.string(), status: z.enum(['Working', 'Filled', 'Cancelled']), action: z.enum(['OPEN', 'CLOSE']),
  side: z.enum(['LONG', 'SHORT']), createdAtMs: time, updatedAtMs: time, decisionId: z.string(), quantity: decimal, riskDecisionId: z.string(),
  reason: z.string().nullable() }).strict();
export type PaperOrder = z.infer<typeof paperOrderSchema>;
const fill = z.object({ id: z.string(), orderId: z.string(), kind: z.enum(['ENTRY', 'EXIT']), side: z.enum(['LONG', 'SHORT']), timestampMs: time,
  price: z.number().positive(), quantity: z.number().positive(), feeInr: z.number().nonnegative(), grossPnlInr: z.number().finite(), reason: z.string() }).strict();
export const paperSessionSchema = z.object({ id: z.string(), name: z.string().min(1).max(100), status: z.enum(['RUNNING', 'PAUSED']), mode: z.literal('PAPER'),
  createdAtMs: time, updatedAtMs: time, config: backtestConfigSchema, book: z.object({ cashInr: decimal, nextEntryTimeMs: time.optional(), position: position.nullable(), trades: z.array(trade).max(5000),
    diagnostics: z.object({ skippedMinNotionalCount: z.number().int().nonnegative(), skippedInsufficientMarginCount: z.number().int().nonnegative(),
      ambiguousCandleCount: z.number().int().nonnegative().optional(), skippedAtrWarmupCount: z.number().int().nonnegative().optional(),
      skippedCooldownCount: z.number().int().nonnegative().optional(), skippedRiskBudgetCount: z.number().int().nonnegative().optional() }).strict().optional() }).strict(),
  candles: z.array(storedCandleSchema).max(5000), lastProcessedOpenMs: time.nullable(), orders: z.array(paperOrderSchema).max(10000), fills: z.array(fill).max(10000),
  lastRisk: z.unknown().nullable(), lastMarkPriceUsdt: decimal.nullable(), lastFxInrPerUsdt: z.number().positive().nullable(),
  equityInr: decimal, unrealizedPnlInr: decimal, peakEquityInr: decimal, consecutiveLossCount: z.number().int().nonnegative(),
  fundingNote: z.string().max(200), promotion: z.literal('PAPER · no promotion') }).strict();
export type PaperSession = z.infer<typeof paperSessionSchema>;
export const savedStrategySchema = z.object({ id: z.string(), name: z.string().min(1).max(100), strategy: backtestConfigSchema.shape.strategy,
  ...futuresConfigSchema.shape, maxOrderNotionalInr: backtestConfigSchema.shape.maxOrderNotionalInr,
  timeframe: backtestConfigSchema.shape.timeframe, parameters: z.record(z.unknown()), slMode: backtestConfigSchema.shape.stopLossMode,
  slValue: z.number().finite().nonnegative(), tpMode: backtestConfigSchema.shape.takeProfitMode, tpValue: z.number().finite().nonnegative(), updatedAtMs: time }).strict();
export const trackedInstrumentSchema = z.object({ underlying: z.string().regex(/^[A-Z0-9]{1,24}$/), pair: z.string().regex(/^B-[A-Z0-9]{1,24}_USDT$/),
  lotSize: decimal, tickSize: decimal, maxLeverage: decimal.nullable() }).strict();
export const syncJobStatusSchema = z.object({ jobId: z.string().nullable(), status: z.enum(['IDLE', 'RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED']),
  coin: z.string().nullable(), pair: z.string().nullable(), operation: z.enum(['SYNC', 'BACKFILL', 'REPAIR', 'SYNC_ALL', 'EXTEND_ALL']),
  completedChunks: z.number().int().nonnegative(), totalChunks: z.number().int().nonnegative(), percentComplete: z.number().min(0).max(100),
  candlesFetched: z.number().int().nonnegative(), etaSeconds: z.number().int().nonnegative().nullable(), message: z.string().max(500), error: z.string().nullable() }).strict();
export type SyncJobStatus = z.infer<typeof syncJobStatusSchema>;
export const idleSyncJobStatus = (): SyncJobStatus => ({ jobId: null, status: 'IDLE', coin: null, pair: null, operation: 'SYNC',
  completedChunks: 0, totalChunks: 0, percentComplete: 0, candlesFetched: 0, etaSeconds: null, message: 'No historical sync job started.', error: null });
export const workspaceStateSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), sequence: z.number().int().nonnegative(),
  syncJobStatus: syncJobStatusSchema.optional(),
  trackedCoins: z.array(z.string().regex(/^[A-Z0-9]{1,24}$/)).min(1).max(500).optional(),
  trackedInstruments: z.array(trackedInstrumentSchema).max(500).optional(),
  savedStrategies: z.array(savedStrategySchema).max(100), paperSessions: z.array(paperSessionSchema).max(20),
  operations: z.object({ admissionStopped: z.boolean(), generation: z.number().int().nonnegative(), reason: z.string().max(500), updatedAtMs: time }).strict(),
  settings: workspaceSettingsSchema,
  alerts: z.array(z.object({ id: z.string(), severity: z.enum(['INFO', 'WARNING', 'CRITICAL']), code: z.string(), message: z.string().max(500),
    createdAtMs: time, acknowledgedAtMs: time.nullable(), scope: z.string() }).strict()).max(1000),
  auditLog: z.array(z.object({ id: z.string(), timestampMs: time, action: z.string(), scope: z.string(), details: z.record(scalar) }).strict()).max(5000),
  datasets: z.array(z.object({ id: z.string(), pair: z.string(), resolution: z.string(), bars: z.number().int(), fromMs: time, toMs: time,
    complete: z.boolean(), missingBars: z.number().int(), updatedAtMs: time }).strict()).max(500),
  researchRuns: z.array(z.object({ id: z.string(), type: z.enum(['MATRIX', 'VALIDATION']), createdAtMs: time, result: z.unknown() }).strict()).max(100),
  jobs: z.array(z.object({ id: z.string(), type: z.string(), status: z.enum(['RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED']), createdAtMs: time,
    completedAtMs: time.nullable(), error: z.string().nullable() }).strict()).max(500),
}).strict();
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;
const checksum = (state: WorkspaceState): string => sha256CanonicalJson(JSON.stringify(state));
const envelope = z.object({ format: z.literal('LOCAL_QUANT_WORKSPACE_V1'), contentSha256: z.string().regex(/^[a-f0-9]{64}$/), state: workspaceStateSchema }).strict();
export function workspaceId(state: WorkspaceState, prefix: string): string { return `${prefix}-${(++state.sequence).toString(16).padStart(12, '0')}`; }
export function auditWorkspace(state: WorkspaceState, timestampMs: number, action: string, scope: string, details: Record<string, string | number | boolean | null> = {}): void {
  state.auditLog.push({ id: workspaceId(state, 'audit'), timestampMs, action, scope, details }); state.auditLog = state.auditLog.slice(-5000);
}
export function alertWorkspace(state: WorkspaceState, now: number, code: string, message: string, scope: string, severity: 'INFO' | 'WARNING' | 'CRITICAL' = 'WARNING'): void {
  if (state.alerts.some(a => a.code === code && a.scope === scope && a.acknowledgedAtMs === null)) return;
  state.alerts.push({ id: workspaceId(state, 'alert'), severity, code, message, scope, createdAtMs: now, acknowledgedAtMs: null }); state.alerts = state.alerts.slice(-1000);
}

/** Serialized, checksum-verified local state. No credentials, execution authority or venue balances are stored. */
export class WorkspaceStore {
  #state: WorkspaceState;
  #tail: Promise<unknown> = Promise.resolve();
  private constructor(readonly root: string, readonly nowMs: () => number, initial: WorkspaceState) { this.#state = initial; }
  public static async open(root: string, nowMs: () => number = Date.now): Promise<WorkspaceStore> {
    const now = nowMs();
    const initial = workspaceStateSchema.parse({ version: 1, revision: 0, sequence: 0, syncJobStatus: idleSyncJobStatus(), trackedCoins: ['BTC', 'ETH', 'SOL'], trackedInstruments: [], savedStrategies: [], paperSessions: [], datasets: [], researchRuns: [], jobs: [], alerts: [], auditLog: [],
      operations: { admissionStopped: false, generation: 0, reason: '', updatedAtMs: now }, settings: { language: 'en', timezone: 'Asia/Kolkata', defaultCoin: 'SOL' } });
    const store = new WorkspaceStore(path.resolve(root), nowMs, initial); await fs.mkdir(store.root, { recursive: true });
    try { store.#state = await store.#read('workspace-state.json'); }
    catch (error) {
      let recoveryRequired = (error as NodeJS.ErrnoException).code !== 'ENOENT';
      try { store.#state = await store.#read('workspace-state.json.bak'); recoveryRequired = true; }
      catch (backupError) { if ((backupError as NodeJS.ErrnoException).code !== 'ENOENT') recoveryRequired = true; }
      if (recoveryRequired) {
        // Preserve corrupt evidence under a unique name, without reading arbitrary paths or deleting it.
        await fs.rename(path.join(store.root, 'workspace-state.json'), path.join(store.root, `workspace-state.corrupt-${now}-${process.hrtime.bigint()}.json`))
          .catch((renameError: NodeJS.ErrnoException) => { if (renameError.code !== 'ENOENT') throw renameError; });
        store.#state.operations = { admissionStopped: true, generation: store.#state.operations.generation + 1, reason: 'WORKSPACE_RECOVERED_REVIEW_REQUIRED', updatedAtMs: now };
        for (const session of store.#state.paperSessions) { session.status = 'PAUSED'; for (const order of session.orders.filter(o => o.status === 'Working')) { order.status = 'Cancelled'; order.reason = 'CORRUPTION_RECOVERY'; } }
        alertWorkspace(store.#state, now, 'WORKSPACE_RECOVERED', 'State corruption detected. Valid backup or empty state recovered; admissions stopped. Review before resuming.', 'WORKSPACE', 'CRITICAL');
      }
      await store.#write('workspace-state.json', store.#state);
    }
    // Verify legacy checksums first, then migrate optional fields through the normal atomic writer.
    if (!store.#state.trackedCoins) await store.mutate(state => { state.trackedCoins = ['BTC', 'ETH', 'SOL']; state.trackedInstruments = []; });
    if (!store.#state.syncJobStatus) await store.mutate(state => { state.syncJobStatus = idleSyncJobStatus(); });
    if (store.#state.syncJobStatus?.status === 'RUNNING') await store.mutate(state => {
      state.syncJobStatus = { ...state.syncJobStatus!, status: 'FAILED', error: 'PROCESS_RESTARTED', etaSeconds: 0,
        message: 'Sync interrupted by process restart. Saved chunks are retained; start again to fetch missing minutes.' };
    });
    // A process restart cannot complete previously running work. Preserve its failed status honestly.
    if (store.#state.jobs.some(j => j.status === 'RUNNING')) await store.mutate(state => { for (const job of state.jobs.filter(j => j.status === 'RUNNING')) {
      job.status = 'FAILED'; job.error = 'PROCESS_RESTARTED'; job.completedAtMs = now;
      alertWorkspace(state, now, 'PROCESS_RESTARTED', 'The process restarted before this job completed. Review and rerun if needed.', job.id);
      auditWorkspace(state, now, 'JOB_INTERRUPTED', job.id);
    } });
    return store;
  }
  public snapshot(): WorkspaceState { return structuredClone(this.#state); }
  public syncStatus(): SyncJobStatus { return structuredClone(this.#state.syncJobStatus ?? idleSyncJobStatus()); }
  public trackedCoins(): string[] { return [...(this.#state.trackedCoins ?? ['BTC', 'ETH', 'SOL'])]; }
  public assertTracked(coin: string): void { if (!this.trackedCoins().includes(coin)) throw new Error('COIN_NOT_TRACKED'); }
  public async trackCoin(instrument: z.infer<typeof trackedInstrumentSchema>) {
    const metadata = trackedInstrumentSchema.parse(instrument);
    return this.mutate(state => {
      state.trackedCoins ??= ['BTC', 'ETH', 'SOL']; state.trackedInstruments ??= [];
      const added = !state.trackedCoins.includes(metadata.underlying);
      if (added) state.trackedCoins.push(metadata.underlying);
      state.trackedInstruments = [...state.trackedInstruments.filter(i => i.underlying !== metadata.underlying), metadata];
      auditWorkspace(state, this.nowMs(), added ? 'COIN_TRACKED' : 'COIN_METADATA_REFRESHED', metadata.pair);
      return { ...metadata, added, trackedCoins: state.trackedCoins };
    });
  }
  public verifyPersistence(): Promise<{ status: 'VERIFIED' | 'FAILED'; contentSha256: string | null; source: string }> {
    const verification = this.#tail.then(async () => {
      try {
        const persisted = await this.#read('workspace-state.json'), digest = checksum(persisted);
        return { status: digest === checksum(this.#state) ? 'VERIFIED' as const : 'FAILED' as const, contentSha256: digest, source: '.local/workspace-state.json' };
      } catch { return { status: 'FAILED' as const, contentSha256: null, source: '.local/workspace-state.json' }; }
    });
    this.#tail = verification.catch(() => undefined); return verification;
  }
  public mutate<T>(change: (draft: WorkspaceState) => T): Promise<T> {
    const operation = this.#tail.then(async () => {
      const draft = this.snapshot(), result = change(draft); draft.revision++;
      const valid = workspaceStateSchema.parse(draft);
      await this.#write('workspace-state.json.bak', this.#state);
      await this.#write('workspace-state.json', valid); this.#state = valid;
      return structuredClone(result);
    });
    this.#tail = operation.catch(() => undefined); return operation;
  }
  async #read(name: string): Promise<WorkspaceState> {
    const file = path.join(this.root, name), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('WORKSPACE_INVALID');
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { state: WorkspaceState };
    const parsed = envelope.parse(raw);
    // V1 digests cover the original JSON field order. Verify before schema parsing can reorder keys.
    if (checksum(raw.state) !== parsed.contentSha256) throw new Error('WORKSPACE_CHECKSUM_INVALID'); return parsed.state;
  }
  async #write(name: string, state: WorkspaceState): Promise<void> {
    const file = path.join(this.root, name), temp = `${file}.${process.pid}.${process.hrtime.bigint()}.tmp`;
    const content = JSON.stringify({ format: 'LOCAL_QUANT_WORKSPACE_V1', state, contentSha256: checksum(state) }, null, 2);
    if (Buffer.byteLength(content, 'utf8') > 32 * 1024 * 1024) throw new Error('WORKSPACE_CAPACITY_LIMIT');
    try {
      const handle = await fs.open(temp, 'wx');
      try { await handle.writeFile(content); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, file);
    } finally { await fs.unlink(temp).catch(() => undefined); }
  }
}
