/**
 * Standard typed application error model.
 */
import { redactSensitiveData } from '../../monitoring/logger';

export type AppErrorCode =
  | 'CONFIG_ERROR'
  | 'VALIDATION_ERROR'
  | 'DATABASE_ERROR'
  | 'NOT_FOUND_ERROR'
  | 'INTERNAL_ERROR'
  | 'COINDCX_CONFIG_ERROR'
  | 'COINDCX_AUTH_ERROR'
  | 'COINDCX_TIMEOUT'
  | 'COINDCX_RATE_LIMIT'
  | 'COINDCX_PROVIDER_ERROR'
  | 'COINDCX_RESPONSE_VALIDATION_ERROR'
  | 'COIN_CONFIG_ERROR'
  | 'COIN_DISCOVERY_ERROR'
  | 'COIN_REGISTRATION_ERROR'
  | 'COIN_LIFECYCLE_ERROR'
  | 'COINDCX_SOCKET_ERROR'
  | 'COINDCX_SOCKET_VALIDATION_ERROR';


export interface AppErrorPayload {
  code: AppErrorCode;
  message: string;
  statusCode: number;
  details?: Record<string, unknown> | undefined;
  stack?: string | undefined;
}

export class AppError extends Error {
  public readonly code: AppErrorCode;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown> | undefined;
  public readonly isOperational: boolean;

  constructor(
    code: AppErrorCode,
    message: string,
    statusCode = 500,
    details?: Record<string, unknown> | undefined,
    isOperational = true
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = isOperational;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  public toJSON(includeStack = false): AppErrorPayload {
    return {
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      ...(this.details && { details: redactSensitiveData(this.details) }),
      ...(includeStack && this.stack && { stack: this.stack }),
    };
  }
}

export class ConfigError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFIG_ERROR', message, 500, details, false);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, 400, details, true);
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('DATABASE_ERROR', message, 500, details, true);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('NOT_FOUND_ERROR', message, 404, details, true);
  }
}

export class InternalError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INTERNAL_ERROR', message, 500, details, false);
  }
}

export class CoinDcxConfigError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('COINDCX_CONFIG_ERROR', message, 500, details, true);
  }
}

export class CoinDcxAuthError extends AppError {
  constructor(message: string, statusCode = 401, details?: Record<string, unknown>) {
    super('COINDCX_AUTH_ERROR', message, statusCode, details, true);
  }
}

export class CoinDcxTimeoutError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('COINDCX_TIMEOUT', message, 504, details, true);
  }
}

export class CoinDcxRateLimitError extends AppError {
  public readonly retryAfterMs?: number | undefined;

  constructor(message: string, retryAfterMs?: number, details?: Record<string, unknown>) {
    const errorDetails = retryAfterMs !== undefined ? { ...details, retryAfterMs } : details;
    super('COINDCX_RATE_LIMIT', message, 429, errorDetails, true);
    this.retryAfterMs = retryAfterMs;
  }
}

export class CoinDcxProviderError extends AppError {
  constructor(message: string, statusCode = 502, details?: Record<string, unknown>) {
    super('COINDCX_PROVIDER_ERROR', message, statusCode, details, true);
  }
}

export class CoinDcxResponseValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('COINDCX_RESPONSE_VALIDATION_ERROR', message, 502, details, true);
  }
}

export class CoinConfigError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('COIN_CONFIG_ERROR', message, 400, details, true);
  }
}

export class CoinDiscoveryError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('COIN_DISCOVERY_ERROR', message, 502, details, true);
  }
}

export class CoinRegistrationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('COIN_REGISTRATION_ERROR', message, 409, details, true);
  }
}

export class CoinLifecycleError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('COIN_LIFECYCLE_ERROR', message, 400, details, true);
  }
}

export class CoinDcxSocketError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('COINDCX_SOCKET_ERROR', message, 502, details, true);
  }
}

export class CoinDcxSocketValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('COINDCX_SOCKET_VALIDATION_ERROR', message, 502, details, true);
  }
}
