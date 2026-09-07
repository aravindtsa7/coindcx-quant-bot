export type MatrixErrorCode =
  | 'INVALID_PARAMETER_SPACE'
  | 'DUPLICATE_PARAMETER_CANDIDATE'
  | 'DATASET_PAIR_MISMATCH'
  | 'DATASET_COVERAGE_GAP'
  | 'DATASET_IDENTITY_MISMATCH'
  | 'TIMEFRAME_ALIGNMENT_FAILURE'
  | 'STRATEGY_REGISTRY_LOOKUP_FAILED'
  | 'STRATEGY_PARAM_VALIDATION_FAILED'
  | 'CELL_EXECUTION_FAILED'
  | 'RUN_ID_MISMATCH'
  | 'MATRIX_PLAN_INTEGRITY_MISMATCH'
  | 'CONCURRENCY_INTEGRITY_VIOLATION'
  | 'CACHE_INTEGRITY_FAILURE'
  | 'MATRIX_SOURCE_STATE_UNAVAILABLE'
  | 'MATRIX_SOURCE_DIRTY'
  | 'MATRIX_SOURCE_COMMIT_MISMATCH'
  | 'MATRIX_UNSUPPORTED_INDICATOR_BOOTSTRAP_POLICY'
  | 'RESOURCE_IDENTITY_MISMATCH'
  | 'INVALID_BACKTEST_CONFIG'
  | 'FUNDING_SCHEDULE_INVALID';

function safeDetails(details: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> | undefined {
  if (details === undefined) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) output[key] = value;
  }
  return Object.freeze(output);
}

export class StrategyCoinMatrixError extends Error {
  public readonly code: MatrixErrorCode;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: MatrixErrorCode,
    message: string,
    options?: { readonly cause?: unknown; readonly details?: Readonly<Record<string, unknown>> },
  ) {
    super(`[${code}] ${message}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StrategyCoinMatrixError';
    this.code = code;
    const details = safeDetails(options?.details);
    if (details !== undefined) this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
