import { IndicatorCalcDecimal, type IndicatorCalc } from '../decimal/indicator-calc-decimal';

export class RollingSum {
  readonly #values: IndicatorCalc[] = [];
  #total = new IndicatorCalcDecimal(0);
  public constructor(public readonly period: number) {}
  public push(value: IndicatorCalc): IndicatorCalc | null {
    this.#values.push(value);
    this.#total = this.#total.plus(value);
    if (this.#values.length > this.period) {
      const expired = this.#values.shift();
      if (expired !== undefined) this.#total = this.#total.minus(expired);
    }
    return this.#values.length === this.period ? this.#total : null;
  }
  public get size(): number { return this.#values.length; }
  public get values(): readonly IndicatorCalc[] { return this.#values; }
  public mean(): IndicatorCalc | null {
    return this.#values.length === this.period ? this.#total.div(new IndicatorCalcDecimal(this.period)) : null;
  }
}

interface ExtremaEntry { readonly index: number; readonly value: IndicatorCalc }
export class RollingExtrema {
  readonly #deque: ExtremaEntry[] = [];
  #head = 0;
  #index = -1;
  public constructor(public readonly period: number, private readonly mode: 'MIN' | 'MAX') {}
  public push(value: IndicatorCalc): IndicatorCalc | null {
    this.#index += 1;
    while (this.#deque.length > this.#head) {
      const tail = this.#deque[this.#deque.length - 1];
      if (!tail) break;
      const shouldRemove = this.mode === 'MAX' ? tail.value.lte(value) : tail.value.gte(value);
      if (!shouldRemove) break;
      this.#deque.pop();
    }
    this.#deque.push({ index: this.#index, value });
    const firstAllowed = this.#index - this.period + 1;
    while ((this.#deque[this.#head]?.index ?? firstAllowed) < firstAllowed) this.#head += 1;
    if (this.#head > 128 && this.#head * 2 > this.#deque.length) {
      this.#deque.splice(0, this.#head);
      this.#head = 0;
    }
    return this.#index + 1 >= this.period ? (this.#deque[this.#head]?.value ?? null) : null;
  }
  public get size(): number { return this.#deque.length - this.#head; }
}

export function populationVariance(values: readonly IndicatorCalc[], mean: IndicatorCalc): IndicatorCalc {
  let squaredDeviationSum = new IndicatorCalcDecimal(0);
  for (const value of values) {
    const difference = value.minus(mean);
    squaredDeviationSum = squaredDeviationSum.plus(difference.times(difference));
  }
  return squaredDeviationSum.div(new IndicatorCalcDecimal(values.length));
}

export function populationStdDev(values: readonly IndicatorCalc[], mean: IndicatorCalc): IndicatorCalc {
  return populationVariance(values, mean).sqrt();
}
