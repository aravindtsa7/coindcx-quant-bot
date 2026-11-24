import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Decimal } from '../core/decimal/decimal';
import type { HistoricalCandleQuery, RestCandleRecord } from './rest-candle-reader';

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;
export const MAX_HISTORY_DAYS = 365;
// Bound each public candle request to at most 1,000 closed bars.
export const HISTORY_CHUNK_BARS = 1000;
export type HistoryChunkObserver = (chunk: { pair: string; candlesFetched: number }) => Promise<void>;
const pairSchema = z.string().regex(/^B-[A-Z0-9]{1,24}_USDT$/);
const value = z.string().regex(/^\d+(?:\.\d+)?$/).max(100);
const candleSchema = z.object({ openTimeMs: z.number().int().nonnegative().safe(), open: value, high: value, low: value, close: value, volume: value }).strict();
const archiveSchema = z.object({ version: z.literal(1), pair: pairSchema, resolution: z.literal('1'),
  source: z.literal('COINDCX_CLOSED_CANDLES'), candles: z.array(candleSchema).max(3_000_000) }).strict();
type DiskCandle = z.infer<typeof candleSchema>;
export interface MinuteHistoryClient { getCandles(query: HistoricalCandleQuery): Promise<readonly RestCandleRecord[]> }
export interface HistoryWindow { fromMs: number; toMs: number }
export interface HistoryWindowInput { days?: number | undefined; fromDate?: string | undefined; toDate?: string | undefined;
  fromMs?: number | undefined; toMs?: number | undefined; endTimeMs?: number | undefined }

/** All ranges are UTC, half-open [fromMs, toMs). Date-only To Date is midnight, exclusive. */
export function resolveHistoryWindow(input: HistoryWindowInput, nowMs: number, defaultDays = 7): HistoryWindow {
  const parseDate = (date: string): number => {
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(date)) throw new Error('INVALID_HISTORY_WINDOW');
    const ms = Date.parse(date);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date.slice(0, 10) && date.length === 10) throw new Error('INVALID_HISTORY_WINDOW');
    return ms;
  };
  if (input.days !== undefined && (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_HISTORY_DAYS)) throw new Error('INVALID_HISTORY_WINDOW');
  if (input.fromMs !== undefined && input.fromDate !== undefined || input.toMs !== undefined && input.toDate !== undefined
    || input.endTimeMs !== undefined && (input.toMs !== undefined || input.toDate !== undefined)) throw new Error('INVALID_HISTORY_WINDOW');
  const toMs = input.toMs ?? (input.toDate === undefined ? input.endTimeMs ?? Math.floor(nowMs / MINUTE_MS) * MINUTE_MS : parseDate(input.toDate));
  const fromMs = input.fromMs ?? (input.fromDate === undefined ? toMs - (input.days ?? defaultDays) * DAY_MS : parseDate(input.fromDate));
  if (![fromMs, toMs].every(n => Number.isSafeInteger(n) && n > 0 && n % MINUTE_MS === 0)
    || fromMs >= toMs || toMs - fromMs > MAX_HISTORY_DAYS * DAY_MS
    || input.days !== undefined && toMs - fromMs !== input.days * DAY_MS) throw new Error('INVALID_HISTORY_WINDOW');
  if (toMs > Math.floor(nowMs / MINUTE_MS) * MINUTE_MS) throw new Error('FUTURE_HISTORY_REFUSED');
  return { fromMs, toMs };
}

const diskCandle = (c: RestCandleRecord): DiskCandle => ({ openTimeMs: c.openTimeMs, open: c.open.toFixed(), high: c.high.toFixed(),
  low: c.low.toFixed(), close: c.close.toFixed(), volume: c.volume.toFixed() });
const restore = (pair: string, c: DiskCandle): RestCandleRecord => ({ pair, ...c, open: new Decimal(c.open), high: new Decimal(c.high),
  low: new Decimal(c.low), close: new Decimal(c.close), volume: new Decimal(c.volume), quoteVolume: null });
function validate(c: RestCandleRecord, pair: string): void {
  if (c.pair !== pair || !Number.isSafeInteger(c.openTimeMs) || c.openTimeMs <= 0 || c.openTimeMs % MINUTE_MS
    || [c.open, c.high, c.low, c.close].some(p => !p.isFinite() || !p.gt(0)) || !c.volume.isFinite() || c.volume.lt(0)
    || c.high.lt(Decimal.max(c.open, c.close, c.low)) || c.low.gt(Decimal.min(c.open, c.close))) throw new Error('INVALID_CANDLE');
}
export function missingMinuteRanges(candles: readonly RestCandleRecord[], window: HistoryWindow): HistoryWindow[] {
  const ranges: HistoryWindow[] = [];
  let cursor = window.fromMs;
  for (const c of candles) {
    if (c.openTimeMs < cursor || c.openTimeMs >= window.toMs) continue;
    if (c.openTimeMs > cursor) ranges.push({ fromMs: cursor, toMs: c.openTimeMs });
    cursor = c.openTimeMs + MINUTE_MS;
  }
  if (cursor < window.toMs) ranges.push({ fromMs: cursor, toMs: window.toMs });
  return ranges;
}

/** Atomic per-pair archives. Only the injected read client performs HTTP; its M2 budget pays for every page. */
export class HistoricalMinuteArchive {
  #tails = new Map<string, Promise<unknown>>();
  constructor(readonly root: string, readonly nowMs: () => number = Date.now) {}
  private file(pair: string): string { return path.join(this.root, 'datasets', `${pairSchema.parse(pair)}-1m.json`); }
  public async read(pair: string): Promise<readonly RestCandleRecord[]> {
    const file = this.file(pair);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024 * 1024) throw new Error('DATASET_INVALID');
      const data = archiveSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
      if (data.pair !== pair) throw new Error('DATASET_INVALID');
      const candles = data.candles.map(c => restore(pair, c));
      for (const [i, c] of candles.entries()) {
        validate(c, pair);
        if (i > 0 && candles[i - 1]!.openTimeMs >= c.openTimeMs || c.openTimeMs + MINUTE_MS > this.nowMs()) throw new Error('DATASET_INVALID');
      }
      return candles;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  public async inventory(pair: string) {
    const candles = await this.read(pair), first = candles[0]?.openTimeMs ?? null, last = candles.at(-1)?.openTimeMs ?? null;
    const gaps = first === null || last === null ? [] : missingMinuteRanges(candles, { fromMs: first, toMs: last + MINUTE_MS });
    const sizeBytes = await fs.stat(this.file(pair)).then(s => s.size, e => { if (e.code === 'ENOENT') return 0; throw e; });
    const syncStatus = !candles.length ? 'EMPTY' : gaps.length ? 'GAPS' : last! + MINUTE_MS < Math.floor(this.nowMs() / MINUTE_MS) * MINUTE_MS ? 'STALE' : 'SYNCED';
    return { pair, candleCount: candles.length, coverageDays: first === null ? 0 : (last! + MINUTE_MS - first) / DAY_MS,
      fromMs: first, toMs: last === null ? null : last + MINUTE_MS,
      dateRangeUtc: first === null ? null : { from: new Date(first).toISOString(), to: new Date(last! + MINUTE_MS).toISOString() },
      gapCount: gaps.length, missingMinutes: gaps.reduce((n, r) => n + (r.toMs - r.fromMs) / MINUTE_MS, 0), gaps,
      sizeBytes, sizeMb: sizeBytes / (1024 * 1024), syncStatus, fabricatedCandles: 0 };
  }
  /** Missing-only reads include internal gaps. Force is reserved for explicit provider re-reads. Partial progress survives a refusal. */
  public ensureRange(client: MinuteHistoryClient, pair: string, window: HistoryWindow, signal?: AbortSignal, force = false, onChunk?: HistoryChunkObserver): Promise<readonly RestCandleRecord[]> {
    pairSchema.parse(pair); resolveHistoryWindow(window, this.nowMs());
    const operation = (this.#tails.get(pair) ?? Promise.resolve()).then(async () => {
      signal?.throwIfAborted();
      const existing = await this.read(pair), records = new Map(existing.map(c => [c.openTimeMs, c]));
      const ranges = force ? [window] : missingMinuteRanges(existing, window);
      let pages = 0;
      for (const range of ranges) for (let cursor = range.fromMs; cursor < range.toMs; cursor += HISTORY_CHUNK_BARS * MINUTE_MS) {
        signal?.throwIfAborted();
        if (++pages > MAX_HISTORY_DAYS * 1440) throw new Error('HISTORY_PAGE_LIMIT');
        const end = Math.min(range.toMs, cursor + HISTORY_CHUNK_BARS * MINUTE_MS);
        const page = await client.getCandles({ pair, resolution: '1', from: cursor, to: end - 1 });
        const seen = new Map<number, string>(), accepted = new Map<number, RestCandleRecord>();
        for (const c of page) {
          validate(c, pair);
          if (c.openTimeMs < cursor || c.openTimeMs >= end) continue;
          const encoded = JSON.stringify(diskCandle(c)), prior = seen.get(c.openTimeMs);
          if (prior !== undefined && prior !== encoded) throw new Error('CONFLICTING_CANDLE');
          seen.set(c.openTimeMs, encoded);
          const old = records.get(c.openTimeMs);
          if (old && JSON.stringify(diskCandle(old)) !== encoded && !force) throw new Error('CONFLICTING_CANDLE');
          if (!old || JSON.stringify(diskCandle(old)) !== encoded) accepted.set(c.openTimeMs, c);
        }
        // A contradictory or malformed page must not contaminate the previously verified archive.
        for (const [time, c] of accepted) records.set(time, c);
        // Checkpoint BEFORE publishing progress or observing cancellation of the next chunk.
        // An interruption never discards previously validated pages.
        if (accepted.size) await this.write(pair, [...records.values()].sort((a, b) => a.openTimeMs - b.openTimeMs));
        await onChunk?.({ pair, candlesFetched: accepted.size });
      }
      signal?.throwIfAborted();
      return [...records.values()].filter(c => c.openTimeMs >= window.fromMs && c.openTimeMs < window.toMs).sort((a, b) => a.openTimeMs - b.openTimeMs);
    });
    this.#tails.set(pair, operation.catch(() => undefined));
    return operation;
  }
  public async initialize(pair: string): Promise<void> {
    // ensureRange() owns writes; empty inventory is a valid file, created once without overwriting any archive.
    const file = this.file(pair); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 1, pair, resolution: '1', source: 'COINDCX_CLOSED_CANDLES', candles: [] }), { flag: 'wx' })
      .catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
  }
  private async write(pair: string, candles: readonly RestCandleRecord[]): Promise<void> {
    const file = this.file(pair), temp = `${file}.${process.pid}.${process.hrtime.bigint()}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (candles.length > 3_000_000) throw new Error('WORKSPACE_CAPACITY_LIMIT');
    try {
      const handle = await fs.open(temp, 'wx');
      try { await handle.writeFile(JSON.stringify({ version: 1, pair, resolution: '1', source: 'COINDCX_CLOSED_CANDLES', candles: candles.map(diskCandle) })); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, file);
    } finally { await fs.unlink(temp).catch(() => undefined); }
  }
}

/** Only complete UTC-aligned groups become higher-timeframe bars; missing minutes are never synthesized. */
export function aggregateMinutes(records: readonly RestCandleRecord[], minutes: number, window: HistoryWindow): readonly RestCandleRecord[] {
  const step = minutes * MINUTE_MS, start = Math.ceil(window.fromMs / step) * step, end = Math.floor(window.toMs / step) * step;
  const byTime = new Map(records.map(c => [c.openTimeMs, c])), result: RestCandleRecord[] = [];
  for (let cursor = start; cursor < end; cursor += step) {
    const group: RestCandleRecord[] = [];
    for (let time = cursor; time < cursor + step; time += MINUTE_MS) {
      const c = byTime.get(time); if (!c) throw new Error('INCOMPLETE_CANDLE_HISTORY'); group.push(c);
    }
    const first = group[0]!, last = group.at(-1)!;
    result.push({ ...first, high: Decimal.max(...group.map(c => c.high)), low: Decimal.min(...group.map(c => c.low)), close: last.close,
      volume: group.reduce((n, c) => n.plus(c.volume), new Decimal(0)), quoteVolume: null });
  }
  if (!result.length) throw new Error('INCOMPLETE_CANDLE_HISTORY');
  return result;
}
