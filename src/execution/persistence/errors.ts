/**
 * P14-D domain errors — account ownership/fencing, coherent snapshot loading,
 * and durable admission persistence. Deliberately separate from
 * `src/execution/errors.ts` (`PaperEngineError`): that module is P14-A's pure
 * contract layer and is not modified here (regression guard). Mirrors its
 * exact code+message+cause pattern, and `src/market-data/**`'s convention of
 * one domain error class per concern (e.g. `CanonicalCandleError`).
 */
export type PaperPersistenceFailureCode =
  | 'ACCOUNT_NOT_FOUND'
  | 'NOT_OWNER'
  | 'STALE_FENCE'
  | 'ACCOUNT_NOT_READY'
  | 'PAIR_SLOT_UNAVAILABLE'
  | 'DURABLE_CONFLICT'
  | 'RESTORE_REQUIRED'
  | 'RESTORE_MALFORMED'
  | 'DB_FAILURE'
  | 'ADMISSION_OUTCOME_AMBIGUOUS';

export class PaperPersistenceError extends Error {
  public readonly code: PaperPersistenceFailureCode;
  public constructor(code: PaperPersistenceFailureCode, message: string, options?: { readonly cause?: unknown }) {
    super(`[${code}] ${message}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PaperPersistenceError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
