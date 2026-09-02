/**
 * Standard typed application error model.
 */
import { redactSensitiveData } from '../../monitoring/logger';

export type AppErrorCode =
  | 'CONFIG_ERROR'
  | 'VALIDATION_ERROR'
  | 'DATABASE_ERROR'
  | 'NOT_FOUND_ERROR'
  | 'INTERNAL_ERROR';

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
