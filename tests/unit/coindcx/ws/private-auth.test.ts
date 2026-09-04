import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HmacSha256Signer } from '../../../../src/integration/coindcx/signer';
import {
  CANONICAL_AUTH_BODY,
  CoinDcxPrivateAccountStream,
  PRIVATE_CHANNEL_NAME,
} from '../../../../src/integration/coindcx/websocket/private-stream';
import { CoinDcxPublicFuturesStream } from '../../../../src/integration/coindcx/websocket/public-stream';
import { createTestStreamContext } from './test-helpers';

describe('CoinDCX WebSocket — Private Auth Signer & Join', () => {
  const TEST_KEY = 'test-api-key-12345';
  const TEST_SECRET = 'test-secret-abcdef';

  it('46. signs exact canonical channel body: {"channel":"coindcx"}', () => {
    expect(PRIVATE_CHANNEL_NAME).toBe('coindcx');
    expect(CANONICAL_AUTH_BODY).toBe('{"channel":"coindcx"}');
  });

  it('47. exact expected HMAC-SHA256 signature and whitespace sensitivity', () => {
    const signer = new HmacSha256Signer(TEST_SECRET);
    const expectedSig = crypto
      .createHmac('sha256', TEST_SECRET)
      .update('{"channel":"coindcx"}', 'utf8')
      .digest('hex');

    const signature = signer.sign(CANONICAL_AUTH_BODY);
    expect(signature).toBe(expectedSig);

    // Whitespace changes signature (exact-wire invariant)
    const spacedBody = '{"channel": "coindcx"}';
    const spacedSig = signer.sign(spacedBody);
    expect(spacedSig).not.toBe(signature);
  });

  it('48. private connect emits exactly one auth join request with required payload structure', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: TEST_KEY,
      apiSecret: TEST_SECRET,
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start();
    const socket = ctx.socketFactory.latestSocket!;

    const joins = socket.emitted.filter((e) => e.event === 'join');
    expect(joins).toHaveLength(1);

    const joinPayload = joins[0]!.args[0] as Record<string, unknown>;
    expect(joinPayload['channelName']).toBe('coindcx');
    expect(joinPayload['apiKey']).toBe(TEST_KEY);
    expect(typeof joinPayload['authSignature']).toBe('string');
    expect((joinPayload['authSignature'] as string)).toHaveLength(64); // 64 hex characters

    // State must be AUTH_JOIN_SENT, NOT AUTHENTICATED
    expect(stream.state).toBe('AUTH_JOIN_SENT');
    expect(stream.getHealthSnapshot().authJoinSent).toBe(true);

    stream.stop();
  });

  it('49. API key is never exposed in health snapshots', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: TEST_KEY,
      apiSecret: TEST_SECRET,
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start();
    const healthJson = JSON.stringify(stream.getHealthSnapshot());

    expect(healthJson.includes(TEST_KEY)).toBe(false);
    expect(healthJson.includes('apiKey')).toBe(false);

    stream.stop();
  });

  it('50. signature is never exposed in health snapshots or metrics', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: TEST_KEY,
      apiSecret: TEST_SECRET,
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start();
    const healthJson = JSON.stringify(stream.getHealthSnapshot());
    const metricsJson = JSON.stringify(stream.getMetrics());

    expect(healthJson.includes('authSignature')).toBe(false);
    expect(healthJson.includes('signature')).toBe(false);
    expect(metricsJson.includes('authSignature')).toBe(false);

    stream.stop();
  });

  it('51. secret is never exposed anywhere on instance or health', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: TEST_KEY,
      apiSecret: TEST_SECRET,
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start();
    const stringifiedStream = JSON.stringify(stream);
    const healthJson = JSON.stringify(stream.getHealthSnapshot());

    expect(stringifiedStream.includes(TEST_SECRET)).toBe(false);
    expect(healthJson.includes(TEST_SECRET)).toBe(false);

    stream.stop();
  });

  it('52. reconnect cleanly re-signs and emits a fresh join request', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: TEST_KEY,
      apiSecret: TEST_SECRET,
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start();
    const s1 = ctx.socketFactory.latestSocket!;
    expect(s1.emitted.filter((e) => e.event === 'join')).toHaveLength(1);

    // Disconnect and reconnect
    s1.trigger('disconnect', 'transport close');
    ctx.scheduler.runAllTimers();
    expect(stream.generationId).toBe(2);

    const s2 = ctx.socketFactory.latestSocket!;
    expect(s2).not.toBe(s1);
    const s2Joins = s2.emitted.filter((e) => e.event === 'join');
    expect(s2Joins).toHaveLength(1);
    expect((s2Joins[0]!.args[0] as Record<string, unknown>)['channelName']).toBe('coindcx');

    stream.stop();
  });

  it('53. no timestamp, nonce, or undocumented parameters added to join payload', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: TEST_KEY,
      apiSecret: TEST_SECRET,
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start();
    const socket = ctx.socketFactory.latestSocket!;
    const joinPayload = socket.emitted.find((e) => e.event === 'join')!.args[0] as Record<string, unknown>;

    const keys = Object.keys(joinPayload).sort();
    expect(keys).toEqual(['apiKey', 'authSignature', 'channelName'].sort());
    expect(joinPayload['timestamp']).toBeUndefined();
    expect(joinPayload['nonce']).toBeUndefined();

    stream.stop();
  });

  it('54. no authenticated socket is started by the public-only flow', async () => {
    const ctx = createTestStreamContext();
    const pubStream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await pubStream.start([]);
    const socket = ctx.socketFactory.latestSocket!;

    // Public socket must NOT emit any auth join
    const joins = socket.emitted.filter((e) => e.event === 'join');
    for (const j of joins) {
      const payload = j.args[0] as Record<string, unknown>;
      expect(payload['channelName']).not.toBe('coindcx');
      expect(payload['apiKey']).toBeUndefined();
      expect(payload['authSignature']).toBeUndefined();
    }

    pubStream.stop();
  });
});
