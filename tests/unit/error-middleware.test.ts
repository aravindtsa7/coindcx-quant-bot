import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { errorHandler } from '../../src/api/middleware/error-handler';
import {
  ValidationError,
  NotFoundError,
  DatabaseError,
  ConfigError,
} from '../../src/core/errors/app-error';

function createTestApp() {
  const app = express();
  app.use(express.json());

  app.get('/test/validation-error', () => {
    throw new ValidationError('Invalid order parameter', {
      field: 'price',
      validRange: [1, 100000],
    });
  });

  app.get('/test/sensitive-details-error', () => {
    throw new ValidationError('Validation failed with credentials', {
      fieldName: 'price',
      safeDetail: 'must be alphanumeric',
      apiKey: 'ROOT_API_KEY_LEAK_67890',
      credentials: {
        apiSecret: 'MUST_NOT_LEAK_SECRET_12345',
      },
      headers: {
        authorization: 'Bearer RAW_BEARER_TOKEN_99999',
      },
    });
  });

  app.get('/test/not-found-error', () => {
    throw new NotFoundError('Resource not found');
  });

  app.get('/test/database-error', () => {
    throw new DatabaseError('Failed to query system state');
  });

  app.get('/test/config-error', () => {
    throw new ConfigError('Invalid configuration detected');
  });

  app.get('/test/unhandled-error', () => {
    throw new Error('Unexpected crash simulation');
  });

  app.get('/test/unhandled-string-error', (_req: Request, _res: Response, next: NextFunction) => {
    next('Non-error string thrown');
  });

  app.get('/test/unhandled-object-error', (_req: Request, _res: Response, next: NextFunction) => {
    next({ customFault: true, secretInternalKey: 'LEAK_ME' });
  });

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    errorHandler(err, req, res, next);
  });

  return app;
}

describe('Centralized Error Middleware & Secret Redaction', () => {
  const originalEnv = process.env['NODE_ENV'];
  let app: express.Express;

  beforeEach(() => {
    app = createTestApp();
  });

  afterEach(() => {
    process.env['NODE_ENV'] = originalEnv;
  });

  it('maps ValidationError to status 400 with useful safe details preserved', async () => {
    const res = await request(app).get('/test/validation-error');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toBe('Invalid order parameter');
    expect(res.body.details).toEqual({
      field: 'price',
      validRange: [1, 100000],
    });
  });

  it('redacts nested secrets in AppError.details in DEVELOPMENT mode', async () => {
    process.env['NODE_ENV'] = 'development';

    const res = await request(app).get('/test/sensitive-details-error');
    expect(res.status).toBe(400);

    const jsonString = JSON.stringify(res.body);
    expect(jsonString).not.toContain('MUST_NOT_LEAK_SECRET_12345');
    expect(jsonString).not.toContain('RAW_BEARER_TOKEN_99999');
    expect(jsonString).not.toContain('ROOT_API_KEY_LEAK_67890');

    expect(res.body.details.apiKey).toBe('[REDACTED]');
    expect(res.body.details.credentials.apiSecret).toBe('[REDACTED]');
    expect(res.body.details.headers.authorization).toBe('[REDACTED]');
    expect(res.body.details.safeDetail).toBe('must be alphanumeric');
    expect(res.body.details.fieldName).toBe('price');
  });

  it('redacts nested secrets and hides stack in PRODUCTION mode', async () => {
    process.env['NODE_ENV'] = 'production';

    const res = await request(app).get('/test/sensitive-details-error');
    expect(res.status).toBe(400);

    const jsonString = JSON.stringify(res.body);
    expect(jsonString).not.toContain('MUST_NOT_LEAK_SECRET_12345');
    expect(jsonString).not.toContain('RAW_BEARER_TOKEN_99999');
    expect(jsonString).not.toContain('ROOT_API_KEY_LEAK_67890');

    expect(res.body.details.apiKey).toBe('[REDACTED]');
    expect(res.body.details.credentials.apiSecret).toBe('[REDACTED]');
    expect(res.body.details.headers.authorization).toBe('[REDACTED]');
    expect(res.body.details.safeDetail).toBe('must be alphanumeric');
    expect(res.body.details.fieldName).toBe('price');
    // Production must NEVER include stack traces
    expect(res.body.stack).toBeUndefined();
  });

  it('hides internal error messages and stack traces in PRODUCTION mode for unhandled errors', async () => {
    process.env['NODE_ENV'] = 'production';

    const res = await request(app).get('/test/unhandled-error');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.message).toBe('An unexpected internal error occurred');
    expect(res.body.stack).toBeUndefined();
  });

  it('includes stack trace in DEVELOPMENT mode for debugging', async () => {
    process.env['NODE_ENV'] = 'development';

    const res = await request(app).get('/test/unhandled-error');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.message).toBe('Unexpected crash simulation');
    expect(res.body.stack).toBeDefined();
    expect(typeof res.body.stack).toBe('string');
  });

  it('safely normalizes unknown thrown string types without crashing', async () => {
    process.env['NODE_ENV'] = 'development';

    const res = await request(app).get('/test/unhandled-string-error');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.message).toBe('Non-error string thrown');
  });

  it('safely normalizes unknown thrown object types without reflecting unsafe properties', async () => {
    process.env['NODE_ENV'] = 'production';

    const res = await request(app).get('/test/unhandled-object-error');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.message).toBe('An unexpected internal error occurred');
    expect(res.body.secretInternalKey).toBeUndefined();
  });

  it('maps NotFoundError to status 404', async () => {
    const res = await request(app).get('/test/not-found-error');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND_ERROR');
    expect(res.body.message).toBe('Resource not found');
  });

  it('maps DatabaseError to status 500', async () => {
    const res = await request(app).get('/test/database-error');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('DATABASE_ERROR');
    expect(res.body.message).toBe('Failed to query system state');
  });

  it('maps ConfigError to status 500', async () => {
    const res = await request(app).get('/test/config-error');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('CONFIG_ERROR');
  });
});
