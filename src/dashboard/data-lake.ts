import { z } from 'zod';
import { DAY_MS, MINUTE_MS, HISTORY_CHUNK_BARS, HistoricalMinuteArchive, missingMinuteRanges, resolveHistoryWindow,
  type HistoryWindow, type HistoryChunkObserver, type MinuteHistoryClient } from '../market-data/historical-minute-archive';
import { WorkspaceStore, alertWorkspace, auditWorkspace } from './workspace-store';

export const dataLakeActionSchema = z.object({ action: z.enum(['sync', 'backfill', 'repair', 'extend']).default('sync'),
  coin: z.string().regex(/^[A-Z0-9]{1,24}$/).optional(), all: z.boolean().default(false), days: z.number().int().min(1).max(365).optional(),
  fromDate: z.string().max(40).optional(), toDate: z.string().max(40).optional(), fromMs: z.number().int().positive().safe().optional(),
  toMs: z.number().int().positive().safe().optional() }).strict();
export interface DataLakePlan { config: z.infer<typeof dataLakeActionSchema>; totalChunks: number;
  targets: { coin: string; pair: string; windows: HistoryWindow[] }[] }

export class DataLake {
  readonly archive: HistoricalMinuteArchive;
  constructor(readonly store: WorkspaceStore, readonly client: MinuteHistoryClient, readonly nowMs: () => number, readonly signal: AbortSignal) {
    this.archive = new HistoricalMinuteArchive(store.root, nowMs);
  }
  public async inventory() {
    const metadata = this.store.snapshot().trackedInstruments ?? [];
    const coins = [];
    for (const coin of this.store.trackedCoins()) coins.push({ underlying: coin, lotSize: null, tickSize: null, maxLeverage: null,
      ...metadata.find(m => m.underlying === coin), ...await this.archive.inventory(`B-${coin}_USDT`) });
    const globalSyncStatus = coins.every(c => c.syncStatus === 'SYNCED') ? 'SYNCED' : coins.some(c => c.syncStatus === 'GAPS') ? 'GAPS' : coins.every(c => c.syncStatus === 'EMPTY') ? 'EMPTY' : 'SYNC_REQUIRED';
    const sizeBytes = coins.reduce((n, c) => n + c.sizeBytes, 0);
    return { coins, summary: { coinsTracked: coins.length, totalCandles: coins.reduce((n, c) => n + c.candleCount, 0), sizeBytes,
      sizeMb: sizeBytes / (1024 * 1024), globalSyncStatus }, observedAtMs: this.nowMs(), source: '.local/datasets/<PAIR>-1m.json', liveLocked: true };
  }
  public validate(input: unknown) {
    const config = dataLakeActionSchema.parse(input);
    if (config.all === Boolean(config.coin)) throw new Error('INVALID_DATA_LAKE_TARGET');
    const coins = config.all ? this.store.trackedCoins() : [config.coin!];
    for (const coin of coins) this.store.assertTracked(coin);
    const custom = config.fromDate !== undefined || config.toDate !== undefined || config.fromMs !== undefined || config.toMs !== undefined;
    if (custom) resolveHistoryWindow(config, this.nowMs());
    return { config, coins, custom };
  }
  public async prepare(input: unknown): Promise<DataLakePlan> {
    const { config, coins, custom } = this.validate(input), targets = [];
    let totalChunks = 0;
    for (const coin of coins) {
      const pair = `B-${coin}_USDT`, inventory = await this.archive.inventory(pair), now = Math.floor(this.nowMs() / MINUTE_MS) * MINUTE_MS;
      const windows = config.action === 'repair' ? inventory.gaps : custom ? [resolveHistoryWindow(config, this.nowMs())]
        : config.action === 'extend' && inventory.fromMs !== null ? [{ fromMs: inventory.fromMs - (config.days ?? 30) * DAY_MS, toMs: inventory.fromMs }]
          : config.action === 'sync' && inventory.toMs !== null ? [{ fromMs: Math.max(inventory.toMs - MINUTE_MS, now - 365 * DAY_MS), toMs: now }]
            : [resolveHistoryWindow({ days: config.days ?? (config.action === 'sync' ? 1 : 30) }, this.nowMs())];
      const existing = await this.archive.read(pair);
      for (const window of windows) {
        resolveHistoryWindow(window, this.nowMs());
        totalChunks += missingMinuteRanges(existing, window).reduce((n, r) => n + Math.ceil((r.toMs - r.fromMs) / (HISTORY_CHUNK_BARS * MINUTE_MS)), 0);
      }
      targets.push({ coin, pair, windows });
    }
    return { config, targets, totalChunks };
  }
  public async run(input: unknown, assertAdmission: () => void) { return this.execute(await this.prepare(input), assertAdmission); }
  public async execute(plan: DataLakePlan, assertAdmission: () => void, onChunk?: HistoryChunkObserver) {
    const { config } = plan, results = [];
    for (const { coin, pair, windows } of plan.targets) {
      assertAdmission();
      let missingMinutes = 0;
      for (const window of windows) {
        assertAdmission();
        const candles = await this.archive.ensureRange({ getCandles: query => { assertAdmission(); return this.client.getCandles(query); } }, pair, window, this.signal, false, onChunk);
        missingMinutes += missingMinuteRanges(candles, window).reduce((n, r) => n + (r.toMs - r.fromMs) / MINUTE_MS, 0);
      }
      assertAdmission();
      const result = { ...await this.archive.inventory(pair), underlying: coin, action: config.action, requestedWindows: windows, requestedMissingMinutes: missingMinutes };
      await this.store.mutate(state => {
        auditWorkspace(state, this.nowMs(), `DATA_LAKE_${config.action.toUpperCase()}`, pair, { candleCount: result.candleCount, gapCount: result.gapCount, requestedMissingMinutes: missingMinutes });
        if (missingMinutes) alertWorkspace(state, this.nowMs(), 'DATA_GAPS', `${missingMinutes} requested minutes remain missing. No synthetic candles were created.`, pair);
      });
      results.push(result);
    }
    return { results, inventory: await this.inventory(), fabricatedCandles: 0, liveLocked: true };
  }
}
