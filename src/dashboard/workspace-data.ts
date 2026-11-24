import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Decimal } from '../core/decimal/decimal';
import type { RestCandleRecord } from '../market-data/rest-candle-reader';
import { sha256CanonicalJson } from '../risk/canonical';
import { storedCandleSchema, type StoredCandle } from './workspace-store';

export const storeCandle = (c: RestCandleRecord): StoredCandle => ({ timeMs: c.openTimeMs, open: c.open.toFixed(), high: c.high.toFixed(), low: c.low.toFixed(), close: c.close.toFixed(), volume: c.volume.toFixed() });
export const restoreCandle = (pair: string, c: StoredCandle): RestCandleRecord => ({ pair, openTimeMs: c.timeMs,
  open: new Decimal(c.open), high: new Decimal(c.high), low: new Decimal(c.low), close: new Decimal(c.close), volume: new Decimal(c.volume), quoteVolume: null });
export function inspectCandleQuality(candles: readonly StoredCandle[], fromMs: number, toMs: number, resolution: string) {
  const step = Number(resolution) * 60_000, expectedBars = Math.floor((toMs - fromMs) / step);
  const times = new Set<number>(), gaps: { fromMs: number; toExclusiveMs: number; missingBars: number }[] = [];
  let duplicateCount = 0, invalidCount = 0;
  for (const candle of candles) {
    const p = [candle.open, candle.high, candle.low, candle.close].map(v => new Decimal(v));
    if (candle.timeMs % step || candle.timeMs < fromMs || candle.timeMs >= toMs || p.some(v => !v.isFinite() || !v.gt(0))
      || p[1]!.lt(Decimal.max(...p)) || p[2]!.gt(Decimal.min(...p)) || new Decimal(candle.volume).lt(0)) invalidCount++;
    if (times.has(candle.timeMs)) duplicateCount++; times.add(candle.timeMs);
  }
  let gapStart: number | null = null;
  for (let time = fromMs; time < toMs; time += step) {
    if (!times.has(time)) gapStart ??= time;
    else if (gapStart !== null) { gaps.push({ fromMs: gapStart, toExclusiveMs: time, missingBars: (time - gapStart) / step }); gapStart = null; }
  }
  if (gapStart !== null) gaps.push({ fromMs: gapStart, toExclusiveMs: toMs, missingBars: (toMs - gapStart) / step });
  const missingBars = gaps.reduce((n, g) => n + g.missingBars, 0);
  return { expectedBars, receivedBars: candles.length, missingBars, missingMinutes: resolution === '1' ? missingBars : null,
    minuteCoverage: resolution === '1' ? 'OBSERVED_MINUTE_BARS' : 'NOT_OBSERVABLE_AT_THIS_RESOLUTION', gaps, duplicateCount, invalidCount,
    complete: missingBars === 0 && invalidCount === 0 && duplicateCount === 0, fabricatedCandles: 0 as const };
}
const datasetSchema = z.object({ id: z.string().regex(/^ds-[a-f0-9]{24}$/), pair: z.string().regex(/^B-[A-Z0-9]+_USDT$/),
  resolution: z.enum(['1', '3', '5', '15', '30', '45', '60', '120', '240']), fromMs: z.number().int().safe(), toMs: z.number().int().safe(),
  source: z.literal('COINDCX_CLOSED_CANDLES'), candles: z.array(storedCandleSchema).max(1000) }).strict();
export class WorkspaceDatasetStore {
  public constructor(readonly root: string) {}
  public async save(input: Omit<z.infer<typeof datasetSchema>, 'id' | 'source'>) {
    const content = { ...input, source: 'COINDCX_CLOSED_CANDLES' as const }, id = `ds-${sha256CanonicalJson(content).slice(0, 24)}`;
    const dataset = datasetSchema.parse({ ...content, id });
    const dir = path.join(this.root, 'datasets'); await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`), temp = `${file}.${process.pid}.${process.hrtime.bigint()}.tmp`;
    try { await fs.writeFile(temp, JSON.stringify(dataset, null, 2), { flag: 'wx' }); await fs.rename(temp, file); }
    finally { await fs.unlink(temp).catch(() => undefined); }
    return { ...dataset, quality: inspectCandleQuality(dataset.candles, dataset.fromMs, dataset.toMs, dataset.resolution) };
  }
  public async read(id: string) {
    if (!/^ds-[a-f0-9]{24}$/.test(id)) throw new Error('DATASET_NOT_FOUND');
    const file = path.join(this.root, 'datasets', `${id}.json`), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('DATASET_INVALID');
    const dataset = datasetSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
    const { id: storedId, ...content } = dataset;
    if (storedId !== id || `ds-${sha256CanonicalJson(content).slice(0, 24)}` !== id) throw new Error('DATASET_INVALID');
    return { ...dataset, quality: inspectCandleQuality(dataset.candles, dataset.fromMs, dataset.toMs, dataset.resolution) };
  }
}
