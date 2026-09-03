import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CoinDcxConfigError } from '../../../src/core/errors/app-error';
import { HmacSha256Signer } from '../../../src/integration/coindcx/signer';

describe('CoinDCX Request Signer', () => {
  it('computes known HMAC-SHA256 test vector accurately', () => {
    const secret = 'test-secret-key-vector-12345';
    const payload = '{"timestamp":1700000000000,"page":"1","size":"10"}';

    // Direct reference calculation
    const expected = crypto
      .createHmac('sha256', secret)
      .update(payload, 'utf8')
      .digest('hex');

    const signer = new HmacSha256Signer(secret);
    const signature = signer.sign(payload);

    expect(signature).toBe(expected);
    expect(signature).toHaveLength(64);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('proves exact payload invariant: signing is byte-sensitive', () => {
    const secret = 'secret-abc';
    const signer = new HmacSha256Signer(secret);

    const payloadA = '{"timestamp":1000,"a":1}';
    const payloadB = '{"a":1,"timestamp":1000}';
    const payloadC = '{"timestamp": 1000, "a": 1}'; // with spaces

    const sigA = signer.sign(payloadA);
    const sigB = signer.sign(payloadB);
    const sigC = signer.sign(payloadC);

    // Any byte-level reordering or whitespace alteration MUST yield different signatures
    expect(sigA).not.toBe(sigB);
    expect(sigA).not.toBe(sigC);
    expect(sigB).not.toBe(sigC);

    // Identical byte string must yield identical signature
    expect(signer.sign(payloadA)).toBe(sigA);
  });

  it('throws CoinDcxConfigError if secret is missing or empty', () => {
    expect(() => new HmacSha256Signer('')).toThrow(CoinDcxConfigError);
    expect(() => new HmacSha256Signer('   ')).toThrow(CoinDcxConfigError);
  });
});

describe('CoinDCX Clock Abstraction', () => {
  it('SystemClock returns a valid recent timestamp', async () => {
    const { SystemClock } = await import('../../../src/integration/coindcx/clock');
    const clock = new SystemClock();
    const now = clock.nowMs();
    expect(now).toBeGreaterThan(1700000000000);
    expect(Number.isInteger(now)).toBe(true);
  });

  it('FakeClock supports deterministic control, setting time, and advancing time', async () => {
    const { FakeClock } = await import('../../../src/integration/coindcx/clock');
    const clock = new FakeClock(1000);
    expect(clock.nowMs()).toBe(1000);

    clock.advance(500);
    expect(clock.nowMs()).toBe(1500);

    clock.setTime(9999);
    expect(clock.nowMs()).toBe(9999);
  });
});

