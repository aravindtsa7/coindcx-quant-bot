import { IndicatorCalcDecimal, type IndicatorCalc } from '../decimal/indicator-calc-decimal';

export class EmaAccumulator {
  #count = 0;
  #seedSum = new IndicatorCalcDecimal(0);
  #current: IndicatorCalc | null = null;
  readonly #alpha: IndicatorCalc;
  readonly #oneMinusAlpha: IndicatorCalc;
  public constructor(public readonly period: number) {
    this.#alpha = new IndicatorCalcDecimal(2).div(new IndicatorCalcDecimal(period + 1));
    this.#oneMinusAlpha = new IndicatorCalcDecimal(1).minus(this.#alpha);
  }
  public update(value: IndicatorCalc): IndicatorCalc | null {
    if (this.#current === null) {
      this.#count += 1;
      this.#seedSum = this.#seedSum.plus(value);
      if (this.#count < this.period) return null;
      this.#current = this.#seedSum.div(new IndicatorCalcDecimal(this.period));
      return this.#current;
    }
    this.#current = this.#alpha.times(value).plus(this.#oneMinusAlpha.times(this.#current));
    return this.#current;
  }
  public get current(): IndicatorCalc | null { return this.#current; }
}
