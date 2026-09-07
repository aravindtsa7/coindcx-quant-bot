export type ValidationErrorCode =
  | 'VALIDATION_PLAN_INVALID'
  | 'VALIDATION_SOURCE_DIRTY'
  | 'VALIDATION_SOURCE_COMMIT_MISMATCH'
  | 'VALIDATION_SOURCE_UNAVAILABLE'
  | 'RESOURCE_IDENTITY_MISMATCH'
  | 'DATASET_COVERAGE_GAP'
  | 'BACKTEST_EXECUTION_FAILED'
  | 'EVIDENCE_INTEGRITY_FAILURE'
  | 'METRIC_NUMERIC_FAILURE'
  | 'MONTE_CARLO_FAILURE'
  | 'OVERFITTING_POLICY_FAILURE'
  | 'CONCURRENCY_INTEGRITY_VIOLATION';

export class ResearchValidationError extends Error {
  public readonly code: ValidationErrorCode;
  public readonly details?: Readonly<Record<string, string | number | boolean | null>>;
  public constructor(code: ValidationErrorCode, message: string, options?: { readonly cause?: unknown; readonly details?: Readonly<Record<string, string | number | boolean | null>> }) {
    super(`[${code}] ${message}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ResearchValidationError';
    this.code = code;
    if (options?.details !== undefined) this.details = Object.freeze({ ...options.details });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
