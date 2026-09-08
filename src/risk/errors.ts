export type RiskFailureCode =
  | 'RISK_SOURCE_INVALID'
  | 'RISK_CONFIG_INVALID'
  | 'RISK_OVERRIDE_INVALID'
  | 'UNSUPPORTED_RISK_MODE'
  | 'RISK_POLICY_IDENTITY_MISMATCH';

export class RiskEngineError extends Error {
  public readonly code: RiskFailureCode;
  public constructor(code: RiskFailureCode, message: string, options?: { readonly cause?: unknown }) {
    super(`[${code}] ${message}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RiskEngineError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RiskConfigError extends RiskEngineError {
  public constructor(code: Exclude<RiskFailureCode, 'RISK_SOURCE_INVALID'>, message: string) {
    super(code, message);
    this.name = 'RiskConfigError';
  }
}

export function riskSourceInvalid(message: string, cause?: unknown): never {
  throw new RiskEngineError('RISK_SOURCE_INVALID', message, cause === undefined ? undefined : { cause });
}
