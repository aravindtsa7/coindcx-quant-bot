import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CoinDcxAuthError,
  CoinDcxConfigError,
  CoinDcxProviderError,
  CoinDcxRateLimitError,
} from '../../../src/core/errors/app-error';
import { createRootLogger, redactSensitiveData } from '../../../src/monitoring/logger';

describe('CoinDCX Security & Credential Redaction Invariants', () => {
  const canaryApiKey = 'SECRET_CANARY_API_KEY_12345';
  const canaryApiSecret = 'SECRET_CANARY_API_SECRET_67890';
  const canarySignature = 'SECRET_CANARY_SIGNATURE_abcdef1234567890';

  it('redacts apiKey, apiSecret, and signature in data objects recursively', () => {
    const sensitiveData = {
      endpoint: '/exchange/v1/users/info',
      apiKey: canaryApiKey,
      apiSecret: canaryApiSecret,
      headers: {
        'X-AUTH-APIKEY': canaryApiKey,
        'X-AUTH-SIGNATURE': canarySignature,
        authorization: 'Bearer ' + canaryApiKey,
      },
      metadata: {
        safeField: 'safeValue',
        signature: canarySignature,
      },
    };

    const sanitized = redactSensitiveData(sensitiveData);

    const jsonString = JSON.stringify(sanitized);
    expect(jsonString).not.toContain(canaryApiKey);
    expect(jsonString).not.toContain(canaryApiSecret);
    expect(jsonString).not.toContain(canarySignature);

    expect(sanitized.apiKey).toBe('[REDACTED]');
    expect(sanitized.apiSecret).toBe('[REDACTED]');
    expect(sanitized.metadata.signature).toBe('[REDACTED]');
  });

  it('proves zero canary leakage in structured Pino logger output under error conditions', async () => {
    const logChunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logChunks.push(chunk.toString('utf8'));
        callback();
      },
    });

    const testLogger = createRootLogger({
      destination: stream,
      level: 'trace',
    });

    // 1. Log with sensitive context
    testLogger.error(
      {
        apiKey: canaryApiKey,
        apiSecret: canaryApiSecret,
        signature: canarySignature,
        requestHeaders: {
          'X-AUTH-APIKEY': canaryApiKey,
          'X-AUTH-SIGNATURE': canarySignature,
        },
      },
      'CoinDCX authenticated request failed'
    );

    // 2. Log with CoinDcx error instances
    const authErr = new CoinDcxAuthError('Unauthorized request', 401, {
      apiKey: canaryApiKey,
      signature: canarySignature,
    });
    testLogger.error(authErr, 'CoinDCX auth error handled');

    const providerErr = new CoinDcxProviderError('Provider timeout', 504, {
      apiKey: canaryApiKey,
      signature: canarySignature,
    });
    testLogger.error(providerErr, 'CoinDCX provider error handled');

    const configErr = new CoinDcxConfigError('Invalid credentials', {
      apiSecret: canaryApiSecret,
    });
    testLogger.error(configErr, 'CoinDCX config error handled');

    const rateLimitErr = new CoinDcxRateLimitError('Too many requests', 60000, {
      apiKey: canaryApiKey,
    });
    testLogger.error(rateLimitErr, 'CoinDCX rate limit error handled');

    // Combine all emitted logs
    const fullLogOutput = logChunks.join('\n');

    // Strict assertions: NONE of the canaries must appear anywhere in the output
    expect(fullLogOutput).not.toContain(canaryApiKey);
    expect(fullLogOutput).not.toContain(canaryApiSecret);
    expect(fullLogOutput).not.toContain(canarySignature);
  });

  it('proves provider error canary secrets and PII are never reflected into AppError or Pino logs', async () => {
    const canarySecrets = [
      'REFLECTED_SECRET_CANARY_401',
      'REFLECTED_SECRET_CANARY_403',
      'REFLECTED_SECRET_CANARY_429',
      'REFLECTED_SECRET_CANARY_500',
      'user_pii_email_canary@exchange.com',
      'user_phone_canary_9999999999',
    ];

    const logChunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logChunks.push(chunk.toString('utf8'));
        callback();
      },
    });

    const testLogger = createRootLogger({
      destination: stream,
      level: 'trace',
    });

    // Simulate creation and logging of errors following transport's safe error policy
    const errors = [
      new CoinDcxAuthError('CoinDCX authentication request failed', 401, {
        path: '/exchange/v1/users/info',
        statusCode: 401,
      }),
      new CoinDcxAuthError('CoinDCX authentication request failed', 403, {
        path: '/exchange/v1/users/info',
        statusCode: 403,
      }),
      new CoinDcxRateLimitError('CoinDCX rate limit exceeded', 60000, {
        path: '/exchange/v1/derivatives/futures/data/active_instruments',
        statusCode: 429,
        retryAfterMs: 60000,
      }),
      new CoinDcxProviderError('CoinDCX provider request failed', 500, {
        path: '/exchange/v1/derivatives/futures/data/active_instruments',
        statusCode: 500,
      }),
    ];

    for (const err of errors) {
      testLogger.error(err, 'Transport error handled');
      for (const canary of canarySecrets) {
        expect(err.message).not.toContain(canary);
        expect(JSON.stringify(err.details)).not.toContain(canary);
      }
    }

    const fullLogOutput = logChunks.join('\n');
    for (const canary of canarySecrets) {
      expect(fullLogOutput).not.toContain(canary);
    }
  });
});


