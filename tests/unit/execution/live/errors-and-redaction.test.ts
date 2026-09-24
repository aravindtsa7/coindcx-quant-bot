import { describe, expect, it } from 'vitest';
import {
  assertCredentialFree,
  LiveExecutionError,
  LIVE_AMBIGUOUS_CODES,
  type LiveExecutionFailureCode,
} from '../../../../src/execution/live/errors';
import { redactSensitiveData } from '../../../../src/monitoring/logger';

const SECRET = 'super-secret-coindcx-api-secret-value-1234567890';

describe('P17 fault taxonomy', () => {
  it('prefixes the code into the message so a log line names the exact refusal', () => {
    const error = new LiveExecutionError('LIVE_ORDER_REJECTED', 'venue refused');
    expect(error.message).toBe('[LIVE_ORDER_REJECTED] venue refused');
    expect(error.name).toBe('LiveExecutionError');
    expect(error.code).toBe('LIVE_ORDER_REJECTED');
  });

  it('survives instanceof across the prototype chain', () => {
    const error = new LiveExecutionError('LIVE_INTENT_INVALID', 'bad');
    expect(error).toBeInstanceOf(LiveExecutionError);
    expect(error).toBeInstanceOf(Error);
  });

  it('marks exactly the unestablished-outcome codes as ambiguous', () => {
    // [P18] The orphan-cancel code joins the two Phase17 codes because it means
    // the same thing: a mutation reached the wire and its outcome could not be
    // established, so the venue may hold state this process cannot account for.
    expect(LIVE_AMBIGUOUS_CODES).toEqual([
      'LIVE_SUBMISSION_AMBIGUOUS',
      'LIVE_CANCEL_AMBIGUOUS',
      'LIVE_ORPHAN_CANCEL_AMBIGUOUS',
    ]);
    expect(new LiveExecutionError('LIVE_SUBMISSION_AMBIGUOUS', 'x').isAmbiguous).toBe(true);
    expect(new LiveExecutionError('LIVE_CANCEL_AMBIGUOUS', 'x').isAmbiguous).toBe(true);
    expect(new LiveExecutionError('LIVE_ORPHAN_CANCEL_AMBIGUOUS', 'x').isAmbiguous).toBe(true);
    expect(new LiveExecutionError('LIVE_ORDER_REJECTED', 'x').isAmbiguous).toBe(false);
    // A reconciliation refusal is NOT ambiguity: it means this process declines
    // to act, not that the venue may hold an unaccounted mutation.
    expect(new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'x').isAmbiguous).toBe(false);
    expect(new LiveExecutionError('LIVE_RECONCILIATION_STALE_GENERATION', 'x').isAmbiguous).toBe(false);
  });

  it('freezes its details and serializes them for structured logging', () => {
    const error = new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'conflict', { details: { intentId: 'abc', from: 'FILLED' } });
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(error.toJSON()).toEqual({
      code: 'LIVE_ORDER_STATE_CONFLICT',
      message: '[LIVE_ORDER_STATE_CONFLICT] conflict',
      details: { intentId: 'abc', from: 'FILLED' },
    });
  });

  it('carries the underlying cause without widening it into the message', () => {
    const cause = new Error('socket hang up');
    const error = new LiveExecutionError('LIVE_PROVIDER_ERROR', 'transport', { cause });
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain('socket hang up');
  });

  it('declares the full Phase17 code set used by the implementation', () => {
    const codes: readonly LiveExecutionFailureCode[] = [
      'LIVE_EXECUTION_DISABLED',
      'LIVE_AUTHORITY_INVALID',
      'LIVE_POSITION_NOT_AVAILABLE',
      'LIVE_INTENT_INVALID',
      'LIVE_INTENT_CONFLICT',
      'LIVE_DISPATCH_ALREADY_CLAIMED',
      'LIVE_ORDER_REJECTED',
      'LIVE_ORDER_RESPONSE_INVALID',
      'LIVE_ORDER_IDENTITY_MISMATCH',
      'LIVE_ORDER_STATE_CONFLICT',
      'LIVE_FILL_INVALID',
      'LIVE_SUBMISSION_AMBIGUOUS',
      'LIVE_CANCEL_AMBIGUOUS',
      'LIVE_INSTRUMENT_CONSTRAINT',
      'LIVE_UNSUPPORTED_EXECUTION_SEMANTICS',
      'LIVE_PROVIDER_ERROR',
      'LIVE_NUMERIC_FAILURE',
      'LIVE_OVERFLOW',
      'LIVE_PERSISTENCE_FAULT',
      'LIVE_DURABLE_INTEGRITY_VIOLATION',
    ];
    for (const code of codes) {
      expect(new LiveExecutionError(code, 'x').code).toBe(code);
    }
  });
});

describe('P17-I15 credential material can never enter a live execution error', () => {
  it('refuses details carrying a credential-bearing key', () => {
    for (const key of ['apiKey', 'api_key', 'apiSecret', 'secret', 'signature', 'authorization', 'token', 'password']) {
      expect(() => new LiveExecutionError('LIVE_PROVIDER_ERROR', 'x', { details: { [key]: 'value' } }))
        .toThrow(/credential-bearing key/);
    }
  });

  it('refuses a credential-bearing key nested inside details', () => {
    expect(() => new LiveExecutionError('LIVE_PROVIDER_ERROR', 'x', { details: { request: { headers: { signature: 'abc' } } } }))
      .toThrow(/credential-bearing key/);
  });

  it('permits long opaque identity values, which are public derived data', () => {
    for (const intentId of ['a'.repeat(64), 'i'.repeat(64), `p17-${'b'.repeat(32)}`]) {
      const error = new LiveExecutionError('LIVE_INTENT_CONFLICT', 'x', { details: { intentId } });
      expect(error.details?.['intentId']).toBe(intentId);
    }
  });

  it('passes surviving details through the shared logger redactor', () => {
    const error = new LiveExecutionError('LIVE_PROVIDER_ERROR', 'x', { details: { reason: 'HTTP_429', pair: 'B-BTC_USDT' } });
    expect(error.details).toEqual({ reason: 'HTTP_429', pair: 'B-BTC_USDT' });
    expect(JSON.stringify(error.toJSON())).not.toContain(SECRET);
  });

  it('assertCredentialFree accepts ordinary execution details', () => {
    expect(() => assertCredentialFree({ intentId: 'b'.repeat(64), pair: 'B-BTC_USDT', reason: 'HTTP_429', revision: 4 })).not.toThrow();
    expect(() => assertCredentialFree(undefined)).not.toThrow();
  });

  it('the shared logger redactor still masks live-execution-shaped payloads', () => {
    const redacted = redactSensitiveData({
      intentId: 'c'.repeat(64),
      apiKey: 'visible-key',
      nested: { apiSecret: SECRET, signature: 'd'.repeat(64) },
    }) as Record<string, unknown>;
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('visible-key');
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain('c'.repeat(64));
  });
});
