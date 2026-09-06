export type IndicatorErrorCode =
  | 'INVALID_INDICATOR_PARAMETER'
  | 'INVALID_CANDLE_INPUT'
  | 'PAIR_MISMATCH'
  | 'TIMEFRAME_MISMATCH'
  | 'CANDLE_ORDER_VIOLATION'
  | 'CANDLE_GAP'
  | 'INDICATOR_OVERFLOW'
  | 'INDICATOR_NUMERIC_FAILURE';

export class IndicatorError extends Error {
  public constructor(
    public readonly code: IndicatorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidIndicatorParameterError extends IndicatorError {
  public constructor(message: string) { super('INVALID_INDICATOR_PARAMETER', message); }
}
export class InvalidCandleInputError extends IndicatorError {
  public constructor(message: string, options?: ErrorOptions) { super('INVALID_CANDLE_INPUT', message, options); }
}
export class PairMismatchError extends IndicatorError {
  public constructor(message: string) { super('PAIR_MISMATCH', message); }
}
export class TimeframeMismatchError extends IndicatorError {
  public constructor(message: string) { super('TIMEFRAME_MISMATCH', message); }
}
export class CandleOrderViolationError extends IndicatorError {
  public constructor(message: string) { super('CANDLE_ORDER_VIOLATION', message); }
}
export class CandleGapError extends IndicatorError {
  public constructor(message: string) { super('CANDLE_GAP', message); }
}
export class IndicatorOverflowError extends IndicatorError {
  public constructor(message: string) { super('INDICATOR_OVERFLOW', message); }
}
export class IndicatorNumericFailureError extends IndicatorError {
  public constructor(message: string, options?: ErrorOptions) { super('INDICATOR_NUMERIC_FAILURE', message, options); }
}
