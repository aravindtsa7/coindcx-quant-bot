export type BacktestErrorCode =
  | 'INVALID_BACKTEST_CONFIG'
  | 'DATASET_IDENTITY_MISMATCH'
  | 'DATASET_RANGE_INVALID'
  | 'DATASET_ORDER_VIOLATION'
  | 'DATASET_GAP'
  | 'TIMEFRAME_CONFIGURATION_INVALID'
  | 'INDICATOR_FAILURE'
  | 'COST_MODEL_INVALID'
  | 'FUNDING_SCHEDULE_INVALID'
  | 'ORDER_INVALID'
  | 'ORDER_STATE_INVALID'
  | 'POST_ONLY_WOULD_TAKE'
  | 'POSITION_CONFLICT'
  | 'INSTRUMENT_CONSTRAINT_VIOLATION'
  | 'BACKTEST_OVERFLOW'
  | 'BACKTEST_NUMERIC_FAILURE'
  | 'BACKTEST_RUN_FAILED';

export class BacktestError extends Error {
  public readonly code: BacktestErrorCode;
  public readonly context: Readonly<Record<string, unknown>>;

  public constructor(
    code: BacktestErrorCode,
    message: string,
    options?: { readonly cause?: unknown; readonly context?: Readonly<Record<string, unknown>> },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BacktestError';
    this.code = code;
    this.context = Object.freeze({ ...(options?.context ?? {}) });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function asBacktestError(error: unknown, fallbackMessage: string): BacktestError {
  return error instanceof BacktestError
    ? error
    : new BacktestError('BACKTEST_RUN_FAILED', fallbackMessage, { cause: error });
}
