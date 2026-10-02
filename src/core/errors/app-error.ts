/**
 * Standard typed application error model.
 */
import { types } from 'node:util';
import { redactSafetyData, redactSensitiveData } from '../../monitoring/logger';

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
  | 'COINDCX_SOCKET_VALIDATION_ERROR'
  | 'CANONICAL_CANDLE_ERROR'
  | 'CANONICAL_CANDLE_CONFLICT'
  | 'CANONICAL_RECOVERY_ERROR'
  | 'CANONICAL_VALIDATION_ERROR';


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
    const kind = appErrorKinds.get(new.target);
    if (kind !== undefined && typeof code === 'string' && appErrorCodes[kind]!.includes(code)
      && typeof message === 'string' && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
      && typeof isOperational === 'boolean') {
      appErrorRecords.set(this, Object.freeze({ kind, code, message, statusCode, isOperational,
        details: captureAppErrorData(details) as Readonly<Record<string, unknown>> | undefined }));
    }

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

export class CanonicalCandleError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CANONICAL_CANDLE_ERROR', message, 500, details, true);
  }
}

export class CanonicalCandleConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CANONICAL_CANDLE_CONFLICT', message, 409, details, true);
  }
}

export class CanonicalRecoveryError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CANONICAL_RECOVERY_ERROR', message, 502, details, true);
  }
}

export class CanonicalValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CANONICAL_VALIDATION_ERROR', message, 400, details, true);
  }
}

interface AppErrorSafetyRecord {
  readonly kind: string; readonly code: AppErrorCode; readonly message: string;
  readonly statusCode: number; readonly isOperational: boolean; readonly details: Readonly<Record<string, unknown>> | undefined;
}
const appErrorRecords = new WeakMap<object, AppErrorSafetyRecord>();
const appErrorKinds = new Map<object, string>([[AppError, 'AppError'], [ValidationError, 'ValidationError'], [CoinDcxConfigError, 'CoinDcxConfigError'], [CoinDcxAuthError, 'CoinDcxAuthError'], [CoinDcxTimeoutError, 'CoinDcxTimeoutError'], [CoinDcxRateLimitError, 'CoinDcxRateLimitError'], [CoinDcxProviderError, 'CoinDcxProviderError'], [CoinDcxResponseValidationError, 'CoinDcxResponseValidationError'], [CoinDcxSocketError, 'CoinDcxSocketError'], [CoinDcxSocketValidationError, 'CoinDcxSocketValidationError']]);
const appErrorCodes: Readonly<Record<string, readonly string[]>> = {"AppError":["CONFIG_ERROR","VALIDATION_ERROR","DATABASE_ERROR","NOT_FOUND_ERROR","INTERNAL_ERROR","COINDCX_CONFIG_ERROR","COINDCX_AUTH_ERROR","COINDCX_TIMEOUT","COINDCX_RATE_LIMIT","COINDCX_PROVIDER_ERROR","COINDCX_RESPONSE_VALIDATION_ERROR","COIN_CONFIG_ERROR","COIN_DISCOVERY_ERROR","COIN_REGISTRATION_ERROR","COIN_LIFECYCLE_ERROR","COINDCX_SOCKET_ERROR","COINDCX_SOCKET_VALIDATION_ERROR","CANONICAL_CANDLE_ERROR","CANONICAL_CANDLE_CONFLICT","CANONICAL_RECOVERY_ERROR","CANONICAL_VALIDATION_ERROR"],"ValidationError":["VALIDATION_ERROR"],"CoinDcxConfigError":["COINDCX_CONFIG_ERROR"],"CoinDcxAuthError":["COINDCX_AUTH_ERROR"],"CoinDcxTimeoutError":["COINDCX_TIMEOUT"],"CoinDcxRateLimitError":["COINDCX_RATE_LIMIT"],"CoinDcxProviderError":["COINDCX_PROVIDER_ERROR"],"CoinDcxResponseValidationError":["COINDCX_RESPONSE_VALIDATION_ERROR"],"CoinDcxSocketError":["COINDCX_SOCKET_ERROR"],"CoinDcxSocketValidationError":["COINDCX_SOCKET_VALIDATION_ERROR"]};
const appErrorMessages: Readonly<Record<string, readonly string[]>> = {"AppError":[],"ValidationError":["underlyingCurrency must be a non-empty string"],"CoinDcxConfigError":["COINDCX_API_KEY is required for private stream initialization","COINDCX_API_SECRET is required for private stream request signing","A CoinDCX API key is required for order mutation","A CoinDCX API secret is required for order mutation","API secret must be a non-empty string for request signing"],"CoinDcxAuthError":["Authentication required: API key is missing","Authentication required: API secret / request signer is missing","CoinDCX authentication request failed"],"CoinDcxTimeoutError":[],"CoinDcxRateLimitError":["CoinDCX rate limit exceeded"],"CoinDcxProviderError":["INR Futures wallet not found on CoinDCX account. Verify INR margin mode is enabled.","Path parameters are not permitted for this read endpoint","Invalid Futures orderbook path parameters","CoinDCX provider request failed","CoinDCX client request error","CoinDCX response was aborted","CoinDCX response closed before completion","CoinDCX request closed before response"],"CoinDcxResponseValidationError":["Failed to parse user info response","User info returned more than one account record","Empty user info received","Failed to parse futures wallets response","Failed to parse futures wallet transactions response","Failed to parse futures positions response","Position response identity is outside requested scope","Failed to parse futures orders response","Failed to parse futures position transactions response","Failed to parse futures trades response","Trade response identity is outside requested scope","Missing required field 'active_pos'","Missing required field 'avg_price'","Missing required field 'locked_margin'","Missing required field 'locked_user_margin'","Missing required field 'locked_order_margin'","Missing required field 'leverage'","Missing required field 'maintenance_margin'","Missing required field 'mark_price'","Missing required field 'settlement_currency_avg_price'","CoinDCX production acquisition returned unparseable JSON","CoinDCX response validation failed: invalid JSON received"],"CoinDcxSocketError":["SOCKET_CONNECT_CANCELLED","SOCKET_CONNECT_TIMEOUT","SOCKET_CONNECT_FAILED"],"CoinDcxSocketValidationError":["Malformed JSON candlestick payload","Malformed candlestick envelope from provider","Candle prices must be non-negative","Candle volumes must be non-negative","Malformed df-position-update payload","Malformed df-order-update payload","Malformed balance-update payload","CoinDCX pair must be a non-empty string","Invalid CoinDCX Futures canonical pair for orderbook channel","P14-B supports only CoinDCX Futures orderbook depth 50"]};
function captureAppErrorData(value: unknown, active = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? '[UNSAFE_VALUE]' : value;
  if (types.isProxy(value)) return '[UNSAFE_VALUE]';
  if (types.isNativeError(value)) return '[UNHANDLED_ERROR]';
  if (active.has(value)) return '[CIRCULAR]';
  active.add(value);
  try {
    const out: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue;
      Object.defineProperty(out, key, { enumerable: true, writable: false, configurable: false,
        value: Object.hasOwn(descriptor, 'value') ? captureAppErrorData(descriptor.value, active) : '[UNSAFE_VALUE]' });
    }
    return Object.freeze(out);
  } finally { active.delete(value); }
}
/** Native records only; foreign subclasses, runtime codes and structural markers do not qualify. */
export function readAppErrorSafetyRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || types.isProxy(value)) return null;
  const record = appErrorRecords.get(value);
  if (record === undefined) return null;
  const message = appErrorMessages[record.kind]!.includes(record.message) ? record.message : '[UNHANDLED_ERROR]';
  return Object.freeze({ name: record.kind, code: record.code, message, statusCode: record.statusCode,
    isOperational: record.isOperational, ...(record.details === undefined ? {} : { details: redactSafetyData(record.details) }) });
}
Object.freeze(readAppErrorSafetyRecord);

// Reviewed defining-owner binding protection.
Object.freeze(AppError.prototype);
Object.freeze(AppError);
Object.freeze(CoinDcxConfigError.prototype);
Object.freeze(CoinDcxConfigError);
Object.freeze(CoinDcxAuthError.prototype);
Object.freeze(CoinDcxAuthError);
Object.freeze(CoinDcxTimeoutError.prototype);
Object.freeze(CoinDcxTimeoutError);
Object.freeze(CoinDcxRateLimitError.prototype);
Object.freeze(CoinDcxRateLimitError);
Object.freeze(CoinDcxProviderError.prototype);
Object.freeze(CoinDcxProviderError);
Object.freeze(CoinDcxResponseValidationError.prototype);
Object.freeze(CoinDcxResponseValidationError);
Object.freeze(CoinDcxSocketError.prototype);
Object.freeze(CoinDcxSocketError);
Object.freeze(CoinDcxSocketValidationError.prototype);
Object.freeze(CoinDcxSocketValidationError);
Object.freeze(ValidationError.prototype);
Object.freeze(ValidationError);
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const name of ["AppError","CoinDcxConfigError","CoinDcxAuthError","CoinDcxTimeoutError","CoinDcxRateLimitError","CoinDcxProviderError","CoinDcxResponseValidationError","CoinDcxSocketError","CoinDcxSocketValidationError","ValidationError","readAppErrorSafetyRecord"]) {
    const value = module.exports[name] as unknown;
    const descriptor = Object.getOwnPropertyDescriptor(module.exports, name);
    if (descriptor?.configurable === false) {
      if (descriptor.set !== undefined || (descriptor.get === undefined && descriptor.writable !== false) || module.exports[name] !== value) throw new Error('OWNED_TRUSTED_EXPORT_INVALID');
    } else Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
  }
}
