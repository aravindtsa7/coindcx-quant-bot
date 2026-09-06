import { IndicatorCalcDecimal, type IndicatorCalc } from '../decimal/indicator-calc-decimal';

export class RmaAccumulator {
  #count = 0;
  #seedSum = new IndicatorCalcDecimal(0);
  #current: IndicatorCalc | null = null;
  readonly #periodDecimal: IndicatorCalc;
  readonly #periodMinusOne: IndicatorCalc;
  public constructor(public readonly period: number) {
    this.#periodDecimal = new IndicatorCalcDecimal(period);
    this.#periodMinusOne = new IndicatorCalcDecimal(period - 1);
  }
  public update(value: IndicatorCalc): IndicatorCalc | null {
    if (this.#current === null) {
      this.#count += 1;
      this.#seedSum = this.#seedSum.plus(value);
      if (this.#count < this.period) return null;
      this.#current = this.#seedSum.div(this.#periodDecimal);
      return this.#current;
    }
    this.#current = this.#current.times(this.#periodMinusOne).plus(value).div(this.#periodDecimal);
    return this.#current;
  }
  public get current(): IndicatorCalc | null { return this.#current; }
}
