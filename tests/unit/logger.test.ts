import { describe, it, expect } from 'vitest';
import { Writable } from 'stream';
import {
  redactSensitiveData,
  createChildLogger,
  createRootLogger,
  SENSITIVE_KEYS,
  isSensitiveKey,
} from '../../src/monitoring/logger';

describe('Logger Secret Redaction & Sanitization', () => {
  it('correctly identifies sensitive key variants', () => {
    expect(isSensitiveKey('apiKey')).toBe(true);
    expect(isSensitiveKey('api_key')).toBe(true);
    expect(isSensitiveKey('API_KEY')).toBe(true);
    expect(isSensitiveKey('apiSecret')).toBe(true);
    expect(isSensitiveKey('api_secret')).toBe(true);
    expect(isSensitiveKey('secret')).toBe(true);
    expect(isSensitiveKey('authorization')).toBe(true);
    expect(isSensitiveKey('Authorization')).toBe(true);
    expect(isSensitiveKey('signature')).toBe(true);
    expect(isSensitiveKey('password')).toBe(true);
    expect(isSensitiveKey('token')).toBe(true);
    expect(isSensitiveKey('normalField')).toBe(false);
    expect(isSensitiveKey('timestamp')).toBe(false);
  });

  it('redacts all sensitive keys at the root level of an object', () => {
    const sensitivePayload = {
      apiKey: 'raw-api-key-12345',
      api_key: 'raw_api_key_67890',
      secret: 'super-secret-passphrase',
      apiSecret: 'my-api-secret',
      api_secret: 'another-secret',
      authorization: 'Bearer jwt.secret.token',
      signature: 'hmac-sha256-signature',
      password: 'db_password_cleartext',
      token: 'session-token-xyz',
      COINDCX_API_KEY: 'dcx_key',
      COINDCX_API_SECRET: 'dcx_secret',
      DATABASE_URL: 'mysql://admin:pass@host/db',
      normalField: 'public-data',
    };

    const redacted = redactSensitiveData(sensitivePayload);

    for (const key of SENSITIVE_KEYS) {
      if (key in sensitivePayload) {
        expect(redacted[key as keyof typeof sensitivePayload]).toBe('[REDACTED]');
      }
    }

    expect(redacted.normalField).toBe('public-data');
  });

  it('recursively redacts secrets at arbitrary nesting depths and array nesting', () => {
    const sample1 = { apiKey: 'SECRET_LITERAL_1' };
    const sample2 = { credentials: { apiSecret: 'SECRET_LITERAL_2' } };
    const sample3 = { request: { headers: { authorization: 'Bearer SECRET_LITERAL_3' } } };
    const sample4 = { a: { b: { c: { d: { api_key: 'SECRET_LITERAL_4' } } } } };
    const sample5 = { items: [{ nested: { token: 'SECRET_LITERAL_5' } }] };

    const red1 = redactSensitiveData(sample1);
    const red2 = redactSensitiveData(sample2);
    const red3 = redactSensitiveData(sample3);
    const red4 = redactSensitiveData(sample4);
    const red5 = redactSensitiveData(sample5);

    expect(red1.apiKey).toBe('[REDACTED]');
    expect(red2.credentials.apiSecret).toBe('[REDACTED]');
    expect(red3.request.headers.authorization).toBe('[REDACTED]');
    expect(red4.a.b.c.d.api_key).toBe('[REDACTED]');
    expect(red5.items[0]?.nested.token).toBe('[REDACTED]');

    // Verify raw input objects were NOT mutated
    expect(sample1.apiKey).toBe('SECRET_LITERAL_1');
    expect(sample2.credentials.apiSecret).toBe('SECRET_LITERAL_2');
    expect(sample4.a.b.c.d.api_key).toBe('SECRET_LITERAL_4');
    expect(sample5.items[0]?.nested.token).toBe('SECRET_LITERAL_5');
  });

  it('proves emitted log output completely excludes the secret literal across all required shapes', async () => {
    let capturedLogs = '';
    const memoryStream = new Writable({
      write(chunk, _encoding, callback) {
        capturedLogs += chunk.toString();
        callback();
      },
    });

    const testLogger = createRootLogger({
      destination: memoryStream,
      level: 'info',
    });

    const secretValue = 'FORBIDDEN_SECRET_EXPOSURE_12345';

    // 1. Root apiKey
    testLogger.info({ apiKey: secretValue }, 'Log test 1');
    // 2. Nested credentials.apiSecret
    testLogger.info({ credentials: { apiSecret: secretValue } }, 'Log test 2');
    // 3. request.headers.authorization
    testLogger.info({ request: { headers: { authorization: `Bearer ${secretValue}` } } }, 'Log test 3');
    // 4. Arbitrary depth a.b.c.d.api_key
    testLogger.info({ a: { b: { c: { d: { api_key: secretValue } } } } }, 'Log test 4');
    // 5. Array items[0].nested.token
    testLogger.info({ items: [{ nested: { token: secretValue } }] }, 'Log test 5');

    // Assert that the raw secret literal NEVER appears in the output log stream
    expect(capturedLogs).not.toContain(secretValue);
    // Assert redaction occurred
    expect(capturedLogs).toContain('[REDACTED]');
  });

  describe('Issue 1 — Error Object Secret Leakage Prevention', () => {
    it('prevents raw Error.message and raw Error.stack secret canary leakage in actual Pino output', () => {
      let capturedLogs = '';
      const memoryStream = new Writable({
        write(chunk, _enc, cb) {
          capturedLogs += chunk.toString();
          cb();
        },
      });

      const testLogger = createRootLogger({
        destination: memoryStream,
        level: 'info',
      });

      const canarySecret = 'CANARY_ERROR_MESSAGE_SECRET';
      const arbitraryErr = new Error(canarySecret);

      // Log the arbitrary Error directly
      testLogger.error(arbitraryErr);

      // Emitted output must NOT contain canary secret in either message or stack
      expect(capturedLogs).not.toContain(canarySecret);
      // Safe error type/name is preserved
      expect(capturedLogs).toContain('"name":"Error"');
      // Generic safe message is emitted instead of raw message
      expect(capturedLogs).toContain('"message":"[UNHANDLED_ERROR]"');
    });

    it('prevents canary leakage when Error is nested inside an object', () => {
      let capturedLogs = '';
      const memoryStream = new Writable({
        write(chunk, _enc, cb) {
          capturedLogs += chunk.toString();
          cb();
        },
      });

      const testLogger = createRootLogger({
        destination: memoryStream,
        level: 'info',
      });

      const nestedCanary = 'NESTED_ERROR_CANARY_SECRET_XYZ';
      testLogger.error({
        nested: {
          error: new Error(nestedCanary),
        },
      });

      expect(capturedLogs).not.toContain(nestedCanary);
      expect(capturedLogs).toContain('"name":"Error"');
      expect(capturedLogs).toContain('"message":"[UNHANDLED_ERROR]"');
    });

    it('prevents canary leakage when Error is contained inside an array', () => {
      let capturedLogs = '';
      const memoryStream = new Writable({
        write(chunk, _enc, cb) {
          capturedLogs += chunk.toString();
          cb();
        },
      });

      const testLogger = createRootLogger({
        destination: memoryStream,
        level: 'info',
      });

      const arrayCanary = 'ARRAY_ERROR_CANARY_SECRET_ABC';
      testLogger.error({
        items: [new Error(arrayCanary)],
      });

      expect(capturedLogs).not.toContain(arrayCanary);
      expect(capturedLogs).toContain('"name":"Error"');
      expect(capturedLogs).toContain('"message":"[UNHANDLED_ERROR]"');
    });

    it('prevents canary leakage through child loggers', () => {
      let capturedLogs = '';
      const memoryStream = new Writable({
        write(chunk, _enc, cb) {
          capturedLogs += chunk.toString();
          cb();
        },
      });

      const root = createRootLogger({ destination: memoryStream, level: 'info' });
      const child = root.child({ module: 'test-child' });

      const childCanary = 'CHILD_LOGGER_ERROR_CANARY_999';
      child.error(new Error(childCanary));

      expect(capturedLogs).not.toContain(childCanary);
      expect(capturedLogs).toContain('"name":"Error"');
      expect(capturedLogs).toContain('"message":"[UNHANDLED_ERROR]"');
    });
  });

  describe('Issue 2 — Accurate Cycle Detection Without False Circular Positives', () => {
    it('Scenario A: preserves shared non-circular references and redacts secrets in every occurrence', () => {
      const shared = {
        safe: 'value',
        nested: {
          token: 'SHARED_SECRET_TOKEN',
        },
      };

      const result = redactSensitiveData({
        a: shared,
        b: shared,
      });

      // Both a and b remain normal object structures
      expect(result.a).toBeDefined();
      expect(result.b).toBeDefined();
      expect(typeof result.a).toBe('object');
      expect(typeof result.b).toBe('object');

      // Neither a nor b is marked [CIRCULAR]
      expect(result.a).not.toBe('[CIRCULAR]');
      expect(result.b).not.toBe('[CIRCULAR]');

      // Shared secrets remain redacted in every occurrence
      expect(result.a.safe).toBe('value');
      expect(result.b.safe).toBe('value');
      expect(result.a.nested.token).toBe('[REDACTED]');
      expect(result.b.nested.token).toBe('[REDACTED]');
    });

    it('Scenario B: correctly detects and marks true direct circular cycles', () => {
      const directCycle: Record<string, unknown> = {
        label: 'direct-root',
        apiKey: 'SECRET_DIRECT',
      };
      directCycle['self'] = directCycle;

      const result = redactSensitiveData(directCycle);

      expect(result.label).toBe('direct-root');
      expect(result.apiKey).toBe('[REDACTED]');
      expect(result['self']).toBe('[CIRCULAR]');
    });

    it('Scenario C: correctly detects and marks indirect circular cycles', () => {
      const nodeA: Record<string, unknown> = { name: 'A' };
      const nodeB: Record<string, unknown> = { name: 'B', nodeA };
      nodeA['nodeB'] = nodeB;

      const result = redactSensitiveData(nodeA);

      expect(result.name).toBe('A');
      const bRef = result['nodeB'] as Record<string, unknown>;
      expect(bRef.name).toBe('B');
      expect(bRef['nodeA']).toBe('[CIRCULAR]');
    });

    it('Scenario D: handles arrays containing repeated references without false circular flags', () => {
      const sharedItem = {
        id: 42,
        secret: 'REPEAT_SECRET',
      };

      const result = redactSensitiveData([sharedItem, sharedItem]);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      expect(result[0]).not.toBe('[CIRCULAR]');
      expect(result[1]).not.toBe('[CIRCULAR]');
      expect(result[0]?.id).toBe(42);
      expect(result[1]?.id).toBe(42);
      expect(result[0]?.secret).toBe('[REDACTED]');
      expect(result[1]?.secret).toBe('[REDACTED]');
    });
  });

  it('instantiates child loggers with sanitized context bindings', () => {
    let captured = '';
    const stream = new Writable({
      write(chunk, _enc, cb) {
        captured += chunk.toString();
        cb();
      },
    });

    const root = createRootLogger({ destination: stream, level: 'info' });
    const child = root.child({
      module: 'test-module',
      apiSecret: 'SECRET_IN_CHILD_BINDING',
    });

    child.info({ normal: 'hello' }, 'Child logger test');

    expect(captured).not.toContain('SECRET_IN_CHILD_BINDING');
    expect(captured).toContain('[REDACTED]');
    expect(captured).toContain('test-module');

    // Also test createChildLogger helper function
    const standaloneChild = createChildLogger('standalone-module', { apiKey: 'SECRET_STANDALONE' });
    expect(standaloneChild).toBeDefined();
  });
});
