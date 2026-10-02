import pino from 'pino';
import { types } from 'node:util';
import { readAppErrorSafetyRecord } from '../core/errors/app-error';

/** Detached data only: never invoke application accessors or Proxy traps. */
export function snapshotSafetyData<T>(input: T, activePath = new Set<object>()): T {
  if (input === null || input === undefined || typeof input !== 'object') {
    return (typeof input === 'function' || typeof input === 'symbol' ? '[UNSAFE_VALUE]' : input) as T;
  }
  if (types.isProxy(input)) return '[UNSAFE_VALUE]' as T;
  if (types.isNativeError(input)) return '[UNHANDLED_ERROR]' as T;
  if (activePath.has(input)) return '[CIRCULAR]' as T;
  activePath.add(input);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const result: Record<string, unknown> | unknown[] = Array.isArray(input) ? [] : {};
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable) continue;
      const value = isSensitiveKey(key) ? '[REDACTED]' : !Object.hasOwn(descriptor, 'value')
        ? '[UNSAFE_VALUE]' : snapshotSafetyData(descriptor.value, activePath);
      Object.defineProperty(result, key, { value, enumerable: true, configurable: false, writable: false });
    }
    return Object.freeze(result) as T;
  } finally { activePath.delete(input); }
}

/** Protected safety serialization; the public legacy redactor remains unchanged. */
export function redactSafetyData<T>(input: T, activePath = new Set<object>()): T {
  if (input === null || input === undefined || typeof input !== 'object') return snapshotSafetyData(input);
  if (types.isProxy(input)) return '[UNSAFE_VALUE]' as T;
  if (activePath.has(input)) return '[CIRCULAR]' as T;
  if (types.isNativeError(input)) {
    // Resolve at call time, including during either circular import order.
    const reader = readAppErrorSafetyRecord;
    const record = typeof reader === 'function' ? reader(input) : null;
    if (record !== null) return snapshotSafetyData(record) as T;
    const code = Object.getOwnPropertyDescriptor(input, 'code');
    const safeCode = code && Object.hasOwn(code, 'value') && typeof code.value === 'string'
      && ['EADDRINUSE', 'ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EACCES'].includes(code.value)
      ? code.value as string : undefined;
    return Object.freeze({ name: 'Error', message: '[UNHANDLED_ERROR]', ...(safeCode === undefined ? {} : { code: safeCode }) }) as T;
  }
  activePath.add(input);
  try {
    const result: Record<string, unknown> | unknown[] = Array.isArray(input) ? [] : {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
      if (!descriptor.enumerable) continue;
      Object.defineProperty(result, key, { enumerable: true, configurable: false, writable: false,
        value: isSensitiveKey(key) ? '[REDACTED]' : !Object.hasOwn(descriptor, 'value') ? '[UNSAFE_VALUE]'
          : redactSafetyData(descriptor.value, activePath) });
    }
    return Object.freeze(result) as T;
  } finally { activePath.delete(input); }
}

export const SENSITIVE_KEYS = [
  'apiKey',
  'api_key',
  'apiSecret',
  'api_secret',
  'secret',
  'authorization',
  'signature',
  'authSignature',
  'auth_signature',
  'password',
  'token',
  'COINDCX_API_KEY',
  'COINDCX_API_SECRET',
  'DATABASE_URL',
] as const;

const SENSITIVE_KEY_SET = new Set([
  'apikey',
  'api_key',
  'apisecret',
  'api_secret',
  'secret',
  'authorization',
  'signature',
  'authsignature',
  'auth_signature',
  'password',
  'token',
  'coindcx_api_key',
  'coindcx_api_secret',
  'database_url',
  'cookie',
  'jwt',
  'passphrase',
  'privatekey',
  'private_key',
  'x-auth-apikey',
  'x-auth-signature',
  'xauthapikey',
  'xauthsignature',
]);

/**
 * Checks whether a given key name represents sensitive information.
 * Uses exact case-insensitive matches as well as normalized punctuation checks.
 */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEY_SET.has(lower)) {
    return true;
  }
  const normalized = lower.replace(/[-_]/g, '');
  return (
    normalized === 'apikey' ||
    normalized === 'apisecret' ||
    normalized === 'authorization' ||
    normalized === 'signature' ||
    normalized === 'password' ||
    normalized === 'token' ||
    normalized === 'secret' ||
    normalized === 'privatekey' ||
    normalized === 'xauthapikey' ||
    normalized === 'xauthsignature' ||
    normalized.includes('apikey') ||
    normalized.includes('apisecret') ||
    normalized.includes('signature')
  );
}

/**
 * Determines whether an Error instance is a typed operational AppError
 * from the application's controlled error model.
 */
export function isAppError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof (err as Record<string, unknown>)['code'] === 'string' &&
    'isOperational' in err
  );
}

/**
 * Serializes Error instances safely:
 * - Controlled AppError instances expose their explicit application code, status,
 *   safe message, and sanitized details.
 * - Arbitrary / unknown Error objects are strictly sanitized: raw message and
 *   raw stack traces are NEVER serialized, preventing canary or secret leakage.
 */
function serializeSafeError(err: Error, activePath: Set<object>): Record<string, unknown> {
  if (isAppError(err)) {
    const appErr = err as unknown as {
      name: string;
      code: string;
      statusCode?: number;
      isOperational?: boolean;
      message: string;
      details?: Record<string, unknown>;
    };

    const out: Record<string, unknown> = {
      name: appErr.name,
      code: appErr.code,
      message: appErr.message,
    };

    if (appErr.statusCode !== undefined) {
      out['statusCode'] = appErr.statusCode;
    }
    if (appErr.isOperational !== undefined) {
      out['isOperational'] = appErr.isOperational;
    }
    if (appErr.details !== undefined) {
      out['details'] = redactSensitiveData(appErr.details, activePath);
    }
    return out;
  }

  // Arbitrary / unknown Error: mask raw message and omit raw stack
  const safeName = err.name || 'Error';
  const out: Record<string, unknown> = {
    name: safeName,
    message: '[UNHANDLED_ERROR]',
  };

  // Preserve standard safe error codes if present (e.g. EADDRINUSE, ENOENT)
  if ('code' in err && typeof (err as { code: unknown }).code === 'string') {
    out['code'] = (err as { code: string }).code;
  }

  // Sanitize any custom metadata properties attached to the Error
  for (const [key, val] of Object.entries(err)) {
    if (isSensitiveKey(key)) {
      out[key] = '[REDACTED]';
    } else if (key !== 'message' && key !== 'stack' && key !== 'name' && key !== 'code') {
      out[key] = redactSensitiveData(val, activePath);
    }
  }

  return out;
}

/**
 * Deep recursive redaction utility to sanitize arbitrary data structures before
 * passing to loggers, serializers, or HTTP responses.
 *
 * Guarantees:
 * - Recursively processes objects and arrays to arbitrary nesting depth.
 * - Handles primitives, null, and undefined without modification.
 * - Enforces safe Error serialization without raw message or stack leakage.
 * - Tracks the active recursion ancestor path (Set) to accurately catch true cycles
 *   without falsely marking repeated/shared object references as circular.
 * - Does not mutate input objects.
 */
export function redactSensitiveData<T>(input: T, activePath = new Set<object>()): T {
  if (input === null || input === undefined) {
    return input;
  }

  if (typeof input !== 'object') {
    return input;
  }

  // Detect true active recursion cycles along the current branch
  if (activePath.has(input as object)) {
    return '[CIRCULAR]' as unknown as T;
  }

  activePath.add(input as object);

  try {
    // Handle Arrays recursively
    if (Array.isArray(input)) {
      return input.map((item) => redactSensitiveData(item, activePath)) as unknown as T;
    }

    // Handle Error instances deterministically
    if (input instanceof Error) {
      return serializeSafeError(input, activePath) as unknown as T;
    }

    // Handle standard objects / records
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        result[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        result[key] = redactSensitiveData(value, activePath);
      } else {
        result[key] = value;
      }
    }

    return result as T;
  } finally {
    activePath.delete(input as object);
  }
}

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
  destination?: pino.DestinationStream;
}

/**
 * Wraps a Pino logger instance to ensure all child logger creation automatically
 * sanitizes child bindings to arbitrary depth.
 */
function wrapLoggerWithRedaction(pinoInstance: pino.Logger): pino.Logger {
  const originalChild = pinoInstance.child.bind(pinoInstance);
  pinoInstance.child = (function (
    bindings: pino.Bindings,
    options?: pino.ChildLoggerOptions
  ): pino.Logger {
    const sanitizedBindings = redactSensitiveData(bindings) as pino.Bindings;
    const childInstance = originalChild(sanitizedBindings, options);
    return wrapLoggerWithRedaction(childInstance);
  } as unknown as typeof pinoInstance.child);
  return pinoInstance;
}

export function createRootLogger(options: LoggerOptions = {}): pino.Logger {
  const level = options.level || process.env['LOG_LEVEL'] || 'info';
  const isDev = (process.env['NODE_ENV'] || 'development') === 'development';

  const pinoConfig: pino.LoggerOptions = {
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      service: 'coindcx-quant-bot',
    },
    // Hook raw logging calls to sanitize input arguments (including Errors) before Pino processes them
    hooks: {
      logMethod(inputArgs: unknown[], method: (...args: unknown[]) => void) {
        const sanitizedArgs = inputArgs.map((arg) => redactSensitiveData(arg));
        return method.apply(this, sanitizedArgs as [unknown, ...unknown[]]);
      },
    },
    // Intercept and sanitize all log metadata at the formatter layer
    formatters: {
      log(object: Record<string, unknown>) {
        return redactSensitiveData(object);
      },
      bindings(bindings: pino.Bindings) {
        return redactSensitiveData(bindings);
      },
    },
  };

  if (!options.destination && (options.pretty || (isDev && !process.env['VITEST']))) {
    pinoConfig.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    };
  }

  const baseLogger = options.destination ? pino(pinoConfig, options.destination) : pino(pinoConfig);
  return wrapLoggerWithRedaction(baseLogger);
}

export const logger = createRootLogger();

export function createChildLogger(
  moduleName: string,
  extraContext: Record<string, unknown> = {}
): pino.Logger {
  return logger.child({
    module: moduleName,
    ...extraContext,
  });
}

Object.freeze(snapshotSafetyData);
Object.freeze(redactSafetyData);
// Reviewed defining-owner binding protection.
Object.freeze(isSensitiveKey);
Object.freeze(redactSensitiveData);
Object.freeze(isAppError);
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const name of ["isSensitiveKey","redactSensitiveData","isAppError","snapshotSafetyData","redactSafetyData"]) {
    const value = module.exports[name] as unknown;
    const descriptor = Object.getOwnPropertyDescriptor(module.exports, name);
    if (descriptor?.configurable === false) {
      if (descriptor.set !== undefined || (descriptor.get === undefined && descriptor.writable !== false) || module.exports[name] !== value) throw new Error('OWNED_TRUSTED_EXPORT_INVALID');
    } else Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
  }
}
