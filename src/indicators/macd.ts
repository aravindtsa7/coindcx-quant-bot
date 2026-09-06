import { extractPrice, validatePriceSource } from './candle/price-source';
import { computeBatch } from './core/batch';
import { BaseIndicatorKernel } from './core/kernel';
import { validatePeriod } from './core/parameters';
import { createSegmentIdentity } from './core/segment';
import { InvalidIndicatorParameterError } from './errors';
import { EmaAccumulator } from './primitives/ema';
import type { IndicatorCandle, IndicatorPoint, MacdValue, PriceSource } from './types';

export interface MacdConfig {
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly bootstrapStartOpenTimeMs: number;
  readonly fastPeriod: number;
  readonly slowPeriod: number;
  readonly signalPeriod: number;
  readonly priceSource?: PriceSource;
}

export class MacdKernel extends BaseIndicatorKernel<MacdValue> {
  readonly #source: PriceSource;
  readonly #fast: EmaAccumulator;
  readonly #slow: EmaAccumulator;
  readonly #signal: EmaAccumulator;
  public constructor(config: MacdConfig) {
    const fastPeriod = validatePeriod(config.fastPeriod, 'fastPeriod');
    const slowPeriod = validatePeriod(config.slowPeriod, 'slowPeriod');
    const signalPeriod = validatePeriod(config.signalPeriod, 'signalPeriod');
    if (fastPeriod >= slowPeriod) throw new InvalidIndicatorParameterError('fastPeriod must be less than slowPeriod');
    const source = validatePriceSource(config.priceSource ?? 'CLOSE');
    super(createSegmentIdentity({ ...config, indicatorType: 'MACD', parameters: { fastPeriod, slowPeriod, signalPeriod }, priceSource: source }));
    this.#source = source;
    this.#fast = new EmaAccumulator(fastPeriod);
    this.#slow = new EmaAccumulator(slowPeriod);
    this.#signal = new EmaAccumulator(signalPeriod);
  }
  protected calculate(candle: IndicatorCandle): Readonly<MacdValue> | null {
    const price = extractPrice(candle, this.#source);
    const fast = this.#fast.update(price);
    const slow = this.#slow.update(price);
    if (fast === null || slow === null) return null;
    const rawMacd = fast.minus(slow);
    const rawSignal = this.#signal.update(rawMacd);
    if (rawSignal === null) return this.composite({ macd: this.publish(rawMacd), signal: null, histogram: null });
    return this.composite({ macd: this.publish(rawMacd), signal: this.publish(rawSignal), histogram: this.publish(rawMacd.minus(rawSignal)) });
  }
}
export function computeMacd(candles: readonly IndicatorCandle[], config: MacdConfig): readonly IndicatorPoint<MacdValue>[] {
  return computeBatch(new MacdKernel(config), candles);
}
