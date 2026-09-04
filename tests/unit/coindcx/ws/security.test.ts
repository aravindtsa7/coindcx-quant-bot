import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CoinDcxPrivateAccountStream } from '../../../../src/integration/coindcx/websocket/private-stream';
import { CoinDcxPublicFuturesStream } from '../../../../src/integration/coindcx/websocket/public-stream';
import { createRootLogger, redactSensitiveData } from '../../../../src/monitoring/logger';
import { createTestStreamContext } from './test-helpers';

describe('CoinDCX WebSocket — Security & Redaction', () => {
  const CANARY_API_KEY = 'SUPER_SECRET_WS_API_KEY_99999';
  const CANARY_SIGNATURE = 'SUPER_SECRET_WS_SIGNATURE_88888';
  const CANARY_PAYLOAD = 'SUPER_SECRET_PRIVATE_PAYLOAD_77777';
  const CANARY_PROVIDER_ERROR = 'SUPER_SECRET_WS_PROVIDER_ERROR_CANARY';
  const CANARY_DISCONNECT_REASON = 'SUPER_SECRET_WS_DISCONNECT_REASON_CANARY';

  it('70. provider error canary is absent from real captured Pino logger stream', async () => {
    const logChunks: string[] = [];
    const memoryStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logChunks.push(chunk.toString('utf8'));
        callback();
      },
    });
    const testLogger = createRootLogger({ destination: memoryStream, level: 'trace' });

    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
      logger: testLogger,
    });

    await stream.start([]);
    const socket = ctx.socketFactory.latestSocket!;

    // Emit untrusted error with secret canary string
    socket.trigger('error', new Error(CANARY_PROVIDER_ERROR));

    // Verify logs were emitted but contain ZERO canary
    const serialized = logChunks.join('\n');
    expect(serialized).not.toContain(CANARY_PROVIDER_ERROR);
    expect(JSON.stringify(stream.getHealthSnapshot())).not.toContain(CANARY_PROVIDER_ERROR);

    stream.stop();
  });

  it('71. disconnect reason canary is absent from real captured Pino logger stream and mapped to safe category', async () => {
    const logChunks: string[] = [];
    const memoryStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logChunks.push(chunk.toString('utf8'));
        callback();
      },
    });
    const testLogger = createRootLogger({ destination: memoryStream, level: 'trace' });

    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
      logger: testLogger,
    });

    let disconnectedReason: string | undefined;
    stream.subscribe((env) => {
      if (env.eventType === 'PUBLIC_STREAM_DISCONNECTED') {
        disconnectedReason = (env.payload as { reason: string }).reason;
      }
    });

    await stream.start([]);
    const socket = ctx.socketFactory.latestSocket!;

    // Trigger disconnect with canary reason string
    socket.trigger('disconnect', CANARY_DISCONNECT_REASON);

    // Must be mapped to UNKNOWN_DISCONNECT_REASON
    expect(disconnectedReason).toBe('UNKNOWN_DISCONNECT_REASON');

    // Real serialized logs must contain the log entry but ZERO canary
    const serialized = logChunks.join('\n');
    expect(serialized).toContain('Public socket disconnected');
    expect(serialized).toContain('UNKNOWN_DISCONNECT_REASON');
    expect(serialized).not.toContain(CANARY_DISCONNECT_REASON);

    stream.stop();
  });

  it('72. API key canary is redacted and absent from serialized structures', () => {
    const objWithCanary = {
      apiKey: CANARY_API_KEY,
      api_key: CANARY_API_KEY,
      nested: {
        apiKey: CANARY_API_KEY,
      },
    };

    const redacted = redactSensitiveData(objWithCanary);
    const json = JSON.stringify(redacted);

    expect(json.includes(CANARY_API_KEY)).toBe(false);
    expect(redacted.apiKey).toBe('[REDACTED]');
    expect(redacted.api_key).toBe('[REDACTED]');
    expect(redacted.nested.apiKey).toBe('[REDACTED]');
  });

  it('73. signature canary is redacted recursively', () => {
    const objWithSig = {
      authSignature: CANARY_SIGNATURE,
      auth_signature: CANARY_SIGNATURE,
      signature: CANARY_SIGNATURE,
    };

    const redacted = redactSensitiveData(objWithSig);
    const json = JSON.stringify(redacted);

    expect(json.includes(CANARY_SIGNATURE)).toBe(false);
    expect(redacted.authSignature).toBe('[REDACTED]');
    expect(redacted.auth_signature).toBe('[REDACTED]');
    expect(redacted.signature).toBe('[REDACTED]');
  });

  it('74. private credentials and payload canaries are absent from real captured Pino logger stream', async () => {
    const logChunks: string[] = [];
    const memoryStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logChunks.push(chunk.toString('utf8'));
        callback();
      },
    });
    const testLogger = createRootLogger({ destination: memoryStream, level: 'trace' });

    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: 'SUPER_SECRET_WS_API_KEY',
      apiSecret: 'SUPER_SECRET_WS_SIGNATURE',
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
      logger: testLogger,
    });

    await stream.start();
    const socket = ctx.socketFactory.latestSocket!;

    // Trigger position update with canary payload
    socket.trigger('df-position-update', [
      {
        id: 'SUPER_SECRET_PRIVATE_PAYLOAD',
        pair: 'B-BTC_USDT',
        active_pos: '1.0',
        avg_price: '50000',
        leverage: 10,
        updated_at: 1700000050000,
        margin_currency_short_name: 'INR',
      },
    ]);

    // Trigger order update with canary
    socket.trigger('df-order-update', [
      {
        id: 'SUPER_SECRET_PRIVATE_PAYLOAD_ORDER',
        pair: 'B-BTC_USDT',
        side: 'buy',
        status: 'open',
        order_type: 'limit_order',
        total_quantity: '1.0',
        created_at: 1700000050000,
        updated_at: 1700000050000,
        margin_currency_short_name: 'INR',
      },
    ]);

    // Verify logs were genuinely captured (logging was not disabled)
    expect(logChunks.length).toBeGreaterThan(0);
    const serialized = logChunks.join('\n');

    expect(serialized).toContain('Dispatched private authenticated channel join request');
    expect(serialized).toContain('Received private position update notification');
    expect(serialized).toContain('Received private order update notification');

    // Zero canary leakage
    expect(serialized).not.toContain('SUPER_SECRET_WS_API_KEY');
    expect(serialized).not.toContain('SUPER_SECRET_WS_SIGNATURE');
    expect(serialized).not.toContain('SUPER_SECRET_PRIVATE_PAYLOAD');
    expect(serialized).not.toContain('SUPER_SECRET_PRIVATE_PAYLOAD_ORDER');

    // Health snapshot also safe
    const healthSnapshotJson = JSON.stringify(stream.getHealthSnapshot());
    expect(healthSnapshotJson).not.toContain('SUPER_SECRET_PRIVATE_PAYLOAD');

    stream.stop();
  });

  it('75. health snapshots contain zero secret fields', async () => {
    const ctx = createTestStreamContext();
    const privStream = new CoinDcxPrivateAccountStream({
      apiKey: 'my-api-key',
      apiSecret: 'my-api-secret',
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });
    const pubStream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await privStream.start();
    await pubStream.start([]);

    const privHealth = privStream.getHealthSnapshot();
    const pubHealth = pubStream.getHealthSnapshot();

    const privJson = JSON.stringify(privHealth);
    const pubJson = JSON.stringify(pubHealth);

    expect(privJson.includes('apiKey')).toBe(false);
    expect(privJson.includes('apiSecret')).toBe(false);
    expect(privJson.includes('secret')).toBe(false);
    expect(privJson.includes('signature')).toBe(false);

    expect(pubJson.includes('apiKey')).toBe(false);
    expect(pubJson.includes('apiSecret')).toBe(false);

    privStream.stop();
    pubStream.stop();
  });

  it('76. event validation error contains no raw private payload', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: 'key',
      apiSecret: 'secret',
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start();
    const socket = ctx.socketFactory.latestSocket!;

    // Send malformed payload containing canary
    socket.trigger('df-position-update', {
      sensitiveData: CANARY_PAYLOAD,
      notAnArray: true,
    });

    // Health snapshot and stream metrics must not contain canary
    const snapshotJson = JSON.stringify(stream.getHealthSnapshot());
    expect(snapshotJson.includes(CANARY_PAYLOAD)).toBe(false);

    stream.stop();
  });
});
