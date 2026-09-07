export type StrategyErrorCode =
  | 'INVALID_STRATEGY_PARAMETER'
  | 'STRATEGY_REGISTRY_CONFLICT'
  | 'STRATEGY_NOT_FOUND'
  | 'STRATEGY_PAIR_MISMATCH'
  | 'STRATEGY_TIMEFRAME_MISMATCH'
  | 'STRATEGY_EVALUATION_ORDER_VIOLATION'
  | 'STRATEGY_INPUT_INVALID'
  | 'STRATEGY_INPUT_FUTURE_DATA'
  | 'STRATEGY_NUMERIC_FAILURE'
  | 'STRATEGY_TERMINATED'
  | 'STRATEGY_BACKTEST_ADAPTER_BUSY';

export class StrategyError extends Error {
  public readonly code: StrategyErrorCode;
  public readonly context: Readonly<Record<string, unknown>>;

  public constructor(
    code: StrategyErrorCode,
    message: string,
    options?: { readonly cause?: unknown; readonly context?: Readonly<Record<string, unknown>> },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StrategyError';
    this.code = code;
    this.context = Object.freeze({ ...(options?.context ?? {}) });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function strategyParameterError(message: string, cause?: unknown): StrategyError {
  return new StrategyError('INVALID_STRATEGY_PARAMETER', message, cause === undefined ? undefined : { cause });
}
