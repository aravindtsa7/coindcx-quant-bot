import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../core/errors/app-error';
import { createChildLogger, redactSensitiveData } from '../../monitoring/logger';

const log = createChildLogger('api:error-handler');

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const isProduction = process.env['NODE_ENV'] === 'production';

  if (err instanceof AppError) {
    const sanitizedDetails = err.details ? redactSensitiveData(err.details) : undefined;

    log.error(
      {
        name: err.name,
        code: err.code,
        statusCode: err.statusCode,
        message: err.message,
        ...(sanitizedDetails && { details: sanitizedDetails }),
      },
      'Operational application error handled'
    );

    res.status(err.statusCode).json({
      status: 'error',
      code: err.code,
      message: err.message,
      ...(sanitizedDetails && { details: sanitizedDetails }),
      ...(!isProduction && err.stack && { stack: err.stack }),
    });
    return;
  }

  // Safely normalize unknown thrown errors without exposing raw message or stack in logs
  const isErrorInstance = err instanceof Error;
  const errorName = isErrorInstance ? err.name : 'UnknownError';
  const errorCode =
    isErrorInstance && 'code' in err && typeof (err as { code: unknown }).code === 'string'
      ? (err as { code: string }).code
      : undefined;
  const rawMessage = isErrorInstance
    ? err.message
    : typeof err === 'string'
      ? err
      : 'Unknown non-error object thrown';
  const stack = isErrorInstance ? err.stack : undefined;

  // Never log raw message or stack of arbitrary unknown errors
  log.error(
    {
      error: {
        name: errorName,
        ...(errorCode && { code: errorCode }),
        message: '[UNHANDLED_ERROR]',
      },
    },
    'Unhandled internal server error'
  );

  res.status(500).json({
    status: 'error',
    code: 'INTERNAL_ERROR',
    message: isProduction ? 'An unexpected internal error occurred' : rawMessage,
    ...(!isProduction && stack && { stack }),
  });
}
