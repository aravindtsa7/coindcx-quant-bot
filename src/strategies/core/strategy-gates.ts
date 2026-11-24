/** Pure, closed-candle research helpers. No transport, execution authority or mutable global state. */
export type IndicatorValue = number | null;
export interface GateCandle {
  readonly openTimeMs: number; readonly closeTimeMs: number;
  readonly open: number; readonly high: number; readonly low: number; readonly close: number; readonly volume: number;
}
const MINUTE = 60_000, FOUR_HOURS = 240 * MINUTE, DAY = 24 * 60 * MINUTE;
const valid = (v: IndicatorValue | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
function period(n: number): void { if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new Error('INVALID_INDICATOR_PERIOD'); }
function ordered(candles: readonly GateCandle[]): void {
  for (const [i, c] of candles.entries()) if (!Number.isSafeInteger(c.openTimeMs) || !Number.isSafeInteger(c.closeTimeMs)
    || c.closeTimeMs <= c.openTimeMs || (i > 0 && candles[i - 1]!.closeTimeMs > c.openTimeMs)
    || ![c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) || c.volume < 0
    || c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close) || c.low > c.high) throw new Error('INVALID_GATE_CANDLES');
}
export function sma(values: readonly IndicatorValue[], n: number): IndicatorValue[] {
  period(n); let sum = 0, missing = 0;
  return values.map((v, i) => {
    if (valid(v)) sum += v; else missing++;
    if (i >= n) { const old = values[i - n]; if (valid(old)) sum -= old; else missing--; }
    return i + 1 >= n && missing === 0 ? sum / n : null;
  });
}
/** Streaming equivalent of the batch SMA-seeded EMA/RMA; state belongs to one replay. */
export class CausalAverage {
  #sum = 0; #count = 0; #previous: IndicatorValue = null;
  public constructor(readonly n: number, readonly alpha: number) {
    period(n); if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) throw new Error('INVALID_AVERAGE_ALPHA');
  }
  public update(value: IndicatorValue): IndicatorValue {
    if (!valid(value)) { this.#sum = 0; this.#count = 0; this.#previous = null; return null; }
    if (this.#previous === null) { this.#sum += value; this.#count++; if (this.#count < this.n) return null; this.#previous = this.#sum / this.n; }
    else this.#previous += this.alpha * (value - this.#previous);
    return this.#previous;
  }
}
function seeded(values: readonly IndicatorValue[], n: number, alpha: number): IndicatorValue[] {
  const average = new CausalAverage(n, alpha);
  return values.map(v => average.update(v));
}
export const ema = (values: readonly IndicatorValue[], n: number): IndicatorValue[] => seeded(values, n, 2 / (n + 1));
export const rma = (values: readonly IndicatorValue[], n: number): IndicatorValue[] => seeded(values, n, 1 / n);
export function trueRange(candles: readonly GateCandle[]): IndicatorValue[] {
  return candles.map((c, i) => i === 0 ? null : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1]!.close), Math.abs(c.low - candles[i - 1]!.close)));
}
export const atr = (candles: readonly GateCandle[], n = 14): IndicatorValue[] => rma(trueRange(candles), n);
export function rsi(values: readonly IndicatorValue[], n = 14): IndicatorValue[] {
  const changes = values.map((v, i) => i > 0 && valid(v) && valid(values[i - 1]) ? v - values[i - 1]! : null);
  const gains = rma(changes.map(v => v === null ? null : Math.max(0, v)), n);
  const losses = rma(changes.map(v => v === null ? null : Math.max(0, -v)), n);
  return gains.map((g, i) => g === null || losses[i] === null ? null : losses[i] === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / losses[i]!));
}
export function adx(candles: readonly GateCandle[], n = 14): { plusDi: IndicatorValue[]; minusDi: IndicatorValue[]; adx: IndicatorValue[] } {
  const range = atr(candles, n);
  const movement = (positive: boolean) => rma(candles.map((c, i) => {
    if (i === 0) return null;
    const up = c.high - candles[i - 1]!.high, down = candles[i - 1]!.low - c.low;
    return positive ? (up > down && up > 0 ? up : 0) : (down > up && down > 0 ? down : 0);
  }), n).map((v, i) => v === null || range[i] === null ? null : range[i] === 0 ? 0 : 100 * v / range[i]!);
  const plusDi = movement(true), minusDi = movement(false);
  const dx = plusDi.map((p, i) => p === null || minusDi[i] === null ? null : p + minusDi[i]! === 0 ? 0 : 100 * Math.abs(p - minusDi[i]!) / (p + minusDi[i]!));
  return { plusDi, minusDi, adx: rma(dx, n) };
}
export function bollingerBands(values: readonly IndicatorValue[], n = 20, deviation = 2) {
  period(n); if (!Number.isFinite(deviation) || deviation <= 0) throw new Error('INVALID_BAND_DEVIATION');
  const middle = sma(values, n), upper: IndicatorValue[] = [], lower: IndicatorValue[] = [], bandwidth: IndicatorValue[] = [];
  // Welford removal/addition avoids subtracting nearly equal price-squared sums.
  let mean = 0, m2 = 0, count = 0;
  values.forEach((v, i) => {
    if (i >= n && valid(values[i - n])) {
      const old = values[i - n]!;
      if (count === 1) { mean = 0; m2 = 0; count = 0; }
      else { const next = (mean * count - old) / (count - 1); m2 -= (old - mean) * (old - next); mean = next; count--; }
    }
    if (valid(v)) { count++; const delta = v - mean; mean += delta / count; m2 += delta * (v - mean); }
    const mid = middle[i], sd = mid === null || count !== n ? null : Math.sqrt(Math.max(0, m2 / n));
    upper.push(sd === null ? null : mid! + deviation * sd); lower.push(sd === null ? null : mid! - deviation * sd);
    bandwidth.push(sd === null || mid === 0 ? null : 2 * deviation * sd / mid!);
  });
  return { middle, upper, lower, bandwidth };
}
/** Linear-interpolated population quantile over available past/current values; callers shift explicitly for prior-bar setups. */
export function bandwidthPercentile(values: readonly IndicatorValue[], n = 50, quantile = .6, minPeriods = n): IndicatorValue[] {
  period(n); if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1 || minPeriods < 1 || minPeriods > n) throw new Error('INVALID_PERCENTILE');
  return values.map((_v, i) => {
    const window = values.slice(Math.max(0, i + 1 - n), i + 1).filter(valid).sort((a, b) => a - b);
    if (window.length < minPeriods) return null;
    const rank = (window.length - 1) * quantile, lo = Math.floor(rank), hi = Math.ceil(rank);
    return window[lo]! + (window[hi]! - window[lo]!) * (rank - lo);
  });
}
export function donchian(candles: readonly GateCandle[], n = 20): { upper: IndicatorValue[]; lower: IndicatorValue[] } {
  period(n); const highs: number[] = [], lows: number[] = [], upper: IndicatorValue[] = [], lower: IndicatorValue[] = []; let h = 0, l = 0;
  candles.forEach((c, i) => {
    while (h < highs.length && highs[h]! < i - n) h++;
    while (l < lows.length && lows[l]! < i - n) l++;
    upper.push(i < n ? null : candles[highs[h]!]!.high); lower.push(i < n ? null : candles[lows[l]!]!.low);
    while (highs.length > h && candles[highs.at(-1)!]!.high <= c.high) highs.pop();
    while (lows.length > l && candles[lows.at(-1)!]!.low >= c.low) lows.pop();
    highs.push(i); lows.push(i);
  });
  return { upper, lower };
}
export function rvol(candles: readonly GateCandle[], n = 20): IndicatorValue[] {
  return sma(candles.map(c => c.volume), n).map((v, i) => v === null || v <= 0 ? null : candles[i]!.volume / v);
}
export function candleBodyRatio(c: GateCandle, eps = 1e-12): number {
  if (!Number.isFinite(eps) || eps <= 0) throw new Error('INVALID_BODY_EPSILON');
  return Math.abs(c.close - c.open) / Math.max(c.high - c.low, eps);
}
export function utcDayVwap(candles: readonly GateCandle[]): IndicatorValue[] {
  ordered(candles); let day = -1, pv = 0, volume = 0;
  return candles.map(c => {
    const current = Math.floor(c.openTimeMs / DAY); if (current !== day) { day = current; pv = 0; volume = 0; }
    pv += (c.high + c.low + c.close) / 3 * c.volume; volume += c.volume;
    return volume > 0 ? pv / volume : null;
  });
}
/** Actual elapsed-time 24h window; incomplete initial/gapped windows remain unavailable by default. */
export function rolling24hVwap(candles: readonly GateCandle[], requireFullWindow = true): IndicatorValue[] {
  ordered(candles); let first = 0, pv = 0, volume = 0, covered = 0;
  return candles.map((c, i) => {
    pv += (c.high + c.low + c.close) / 3 * c.volume; volume += c.volume; covered += c.closeTimeMs - c.openTimeMs;
    const from = c.closeTimeMs - DAY;
    while (first <= i && candles[first]!.openTimeMs < from) {
      const old = candles[first++]!; pv -= (old.high + old.low + old.close) / 3 * old.volume; volume -= old.volume; covered -= old.closeTimeMs - old.openTimeMs;
    }
    return volume > 0 && (!requireFullWindow || covered === DAY) ? pv / volume : null;
  });
}
/** Source bars must tile UTC 4h buckets; use genuine 1m source for a 45m strategy. Partial buckets are dropped. */
export function aggregateClosed4h(source: readonly GateCandle[], sourceTimeframeMinutes = 1): GateCandle[] {
  ordered(source); period(sourceTimeframeMinutes);
  if (240 % sourceTimeframeMinutes) throw new Error('NON_DIVISIBLE_MACRO_SOURCE');
  const duration = sourceTimeframeMinutes * MINUTE, result: GateCandle[] = []; let group: GateCandle[] = [];
  for (const c of source) {
    if (c.closeTimeMs - c.openTimeMs !== duration || c.openTimeMs % duration) throw new Error('INVALID_GATE_CANDLES');
    if (!group.length || Math.floor(group[0]!.openTimeMs / FOUR_HOURS) !== Math.floor(c.openTimeMs / FOUR_HOURS)) group = [];
    group.push(c);
    if (group.length === FOUR_HOURS / duration && group[0]!.openTimeMs % FOUR_HOURS === 0 && c.closeTimeMs % FOUR_HOURS === 0
      && group.every((v, i) => v.openTimeMs === group[0]!.openTimeMs + i * duration)) {
      result.push({ openTimeMs: group[0]!.openTimeMs, closeTimeMs: c.closeTimeMs, open: group[0]!.open,
        high: Math.max(...group.map(v => v.high)), low: Math.min(...group.map(v => v.low)), close: c.close, volume: group.reduce((n, v) => n + v.volume, 0) });
      group = [];
    }
  }
  return result;
}
export interface MacroGatePoint {
  readonly sourceCloseTimeMs: number | null; readonly close4h: IndicatorValue;
  readonly ema50: IndicatorValue; readonly ema100: IndicatorValue; readonly ema200: IndicatorValue;
  readonly long200: boolean; readonly short200: boolean; readonly long100: boolean; readonly short100: boolean;
}
export function macroTrendGates(strategy: readonly GateCandle[], source: readonly GateCandle[], sourceTimeframeMinutes = 1): MacroGatePoint[] {
  ordered(strategy); const bars = aggregateClosed4h(source, sourceTimeframeMinutes), closes = bars.map(c => c.close);
  const e50 = ema(closes, 50), e100 = ema(closes, 100), e200 = ema(closes, 200); let cursor = -1;
  return strategy.map(c => {
    while (cursor + 1 < bars.length && bars[cursor + 1]!.closeTimeMs <= c.closeTimeMs) cursor++;
    const close = bars[cursor]?.close ?? null, fast = e50[cursor] ?? null, mid = e100[cursor] ?? null, slow = e200[cursor] ?? null;
    return { sourceCloseTimeMs: bars[cursor]?.closeTimeMs ?? null, close4h: close, ema50: fast, ema100: mid, ema200: slow,
      long200: close !== null && slow !== null && fast !== null && close > slow && fast > slow,
      short200: close !== null && slow !== null && fast !== null && close < slow && fast < slow,
      long100: close !== null && mid !== null && close > mid, short100: close !== null && mid !== null && close < mid };
  });
}
export function costGate(atrValue: IndicatorValue, close: number, multiplier: number, rtCost: number): boolean {
  if (![multiplier, rtCost].every(Number.isFinite) || rtCost < 0) throw new Error('INVALID_COST_GATE');
  return multiplier <= 0 || valid(atrValue) && close > 0 && Number.isFinite(close) && atrValue / close >= multiplier * rtCost;
}
