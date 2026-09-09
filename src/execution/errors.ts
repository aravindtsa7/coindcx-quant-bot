export type PaperEngineFailureCode =
  | 'PAPER_SOURCE_INVALID'
  | 'PAPER_CONFIG_INVALID'
  | 'PAPER_NUMERIC_FAILURE'
  | 'PAPER_OVERFLOW'
  | 'PAPER_AUTHORITY_INVALID'
  | 'PAPER_QUANTITY_MISALIGNED';

export class PaperEngineError extends Error {
  public readonly code: PaperEngineFailureCode;
  public constructor(code: PaperEngineFailureCode, message: string, options?: { readonly cause?: unknown }) {
    super(`[${code}] ${message}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PaperEngineError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PaperConfigError extends PaperEngineError {
  public constructor(code: Exclude<PaperEngineFailureCode, 'PAPER_SOURCE_INVALID'>, message: string) {
    super(code, message);
    this.name = 'PaperConfigError';
  }
}

export function paperSourceInvalid(message: string, cause?: unknown): never {
  throw new PaperEngineError('PAPER_SOURCE_INVALID', message, cause === undefined ? undefined : { cause });
}
