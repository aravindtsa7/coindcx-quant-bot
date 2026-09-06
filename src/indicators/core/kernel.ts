import { validateCandleForSegment } from '../candle/validator';
import { IndicatorDecimal } from '../decimal/indicator-decimal';
import { IndicatorError, IndicatorNumericFailureError } from '../errors';
import type { IndicatorCalc } from '../decimal/indicator-calc-decimal';
import type { IndicatorCandle, IndicatorCalculationSegmentIdentity, IndicatorKernel, IndicatorPoint } from '../types';

export abstract class BaseIndicatorKernel<T> implements IndicatorKernel<T> {
  #previousOpenTimeMs: number | null = null;
  #terminalError: IndicatorError | null = null;

  protected constructor(public readonly segment: IndicatorCalculationSegmentIdentity) {}

  public get isTerminated(): boolean { return this.#terminalError !== null; }

  public update(candle: IndicatorCandle): IndicatorPoint<T> {
    if (this.#terminalError !== null) throw this.#terminalError;
    try {
      validateCandleForSegment(candle, this.segment, this.#previousOpenTimeMs);
      this.validateIndicatorCandle(candle);
      const value = this.calculate(candle);
      const point = Object.freeze({
        pair: candle.pair,
        timeframeMinutes: candle.timeframeMinutes,
        openTimeMs: candle.openTimeMs,
        closeTimeExclusiveMs: candle.closeTimeExclusiveMs,
        value,
      });
      this.#previousOpenTimeMs = candle.openTimeMs;
      return point;
    } catch (error) {
      this.#terminalError = error instanceof IndicatorError
        ? error
        : new IndicatorNumericFailureError('Indicator calculation failed', { cause: error });
      throw this.#terminalError;
    }
  }

  protected validateIndicatorCandle(_candle: IndicatorCandle): void {}
  protected abstract calculate(candle: IndicatorCandle): T | null;

  protected publish(value: IndicatorCalc): IndicatorDecimal { return IndicatorDecimal.from(value); }
  protected composite<V extends object>(value: V): Readonly<V> { return Object.freeze(value); }
}
