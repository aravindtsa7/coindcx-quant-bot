import { describe, expect, it } from 'vitest';
import { EnvSchema, loadConfig } from '../../../../src/app/config/env';
import {
  LiveExecutionEnablement,
  requireLiveExecutionEnabled,
  resolveLiveExecutionGate,
  type LiveExecutionConfigInput,
} from '../../../../src/execution/live/gate';
import { LiveExecutionError } from '../../../../src/execution/live/errors';
import {
  buildLiveExecutionPolicySnapshot,
  defaultLiveExecutionPolicyContent,
  normalizeLiveExecutionPolicyContent,
  validateLiveExecutionPolicySnapshot,
  LIVE_EXECUTION_POLICY_VERSION,
  type LiveExecutionPolicyContent,
} from '../../../../src/execution/live/execution-policy';
import { enabledLiveConfig } from './helpers';

describe('P17-I04 live execution is disabled by default', () => {
  it('an entirely empty configuration is DISABLED, not enabled', () => {
    const resolution = resolveLiveExecutionGate({});
    expect(resolution.status).toBe('DISABLED');
    if (resolution.status === 'DISABLED') expect(resolution.reason).toBe('NOT_EXPLICITLY_ENABLED');
  });

  it('the shipped application schema defaults the live flag to the closed value', () => {
    const parsed = EnvSchema.parse({ DATABASE_URL: 'mysql://user:pass@localhost:3306/db' });
    expect(parsed.LIVE_EXECUTION_ENABLED).toBe('false');
    expect(parsed.LIVE_EXECUTION_ACCOUNT_ALLOWLIST).toBe('');
    expect(parsed.LIVE_EXECUTION_PAIR_ALLOWLIST).toBe('');
    expect(parsed.LIVE_EXECUTION_MAX_ORDER_NOTIONAL_INR).toBe('');
    expect(parsed.COINDCX_LIVE_ACCOUNT_ID).toBe('');
    expect(resolveLiveExecutionGate(parsed).status).toBe('DISABLED');
  });

  it('a default-loaded application configuration never enables live mutation', () => {
    const config = loadConfig({ DATABASE_URL: 'mysql://user:pass@localhost:3306/db' });
    expect(resolveLiveExecutionGate(config).status).toBe('DISABLED');
  });

  const nearMisses: ReadonlyArray<readonly [string, string]> = [
    ['TRUE', 'MALFORMED_ENABLE_FLAG'],
    ['True', 'MALFORMED_ENABLE_FLAG'],
    ['1', 'MALFORMED_ENABLE_FLAG'],
    ['yes', 'MALFORMED_ENABLE_FLAG'],
    ['on', 'MALFORMED_ENABLE_FLAG'],
    [' true', 'MALFORMED_ENABLE_FLAG'],
    ['true ', 'MALFORMED_ENABLE_FLAG'],
    ['', 'NOT_EXPLICITLY_ENABLED'],
    ['false', 'NOT_EXPLICITLY_ENABLED'],
  ];

  it.each(nearMisses)('the flag value %j never silently enables live mutation', (flag, reason) => {
    const resolution = resolveLiveExecutionGate(enabledLiveConfig({ LIVE_EXECUTION_ENABLED: flag }));
    expect(resolution.status).toBe('DISABLED');
    if (resolution.status === 'DISABLED') expect(resolution.reason).toBe(reason);
  });

  const malformed: ReadonlyArray<readonly [string, Partial<LiveExecutionConfigInput>, string]> = [
    ['an unknown environment', { NODE_ENV: 'staging' }, 'UNSUPPORTED_ENVIRONMENT'],
    ['a development environment', { NODE_ENV: 'development' }, 'UNSUPPORTED_ENVIRONMENT'],
    ['a test environment', { NODE_ENV: 'test' }, 'UNSUPPORTED_ENVIRONMENT'],
    ['an absent environment', { NODE_ENV: undefined }, 'UNSUPPORTED_ENVIRONMENT'],
    ['a missing api key', { COINDCX_API_KEY: '' }, 'MISSING_CREDENTIALS'],
    ['a whitespace api key', { COINDCX_API_KEY: '   ' }, 'MISSING_CREDENTIALS'],
    ['a missing api secret', { COINDCX_API_SECRET: undefined }, 'MISSING_CREDENTIALS'],
    ['a missing credential account identity', { COINDCX_LIVE_ACCOUNT_ID: '' }, 'MISSING_CREDENTIAL_ACCOUNT_ID'],
    ['a missing provider account binding', { COINDCX_EXPECTED_ACCOUNT_FINGERPRINT: undefined }, 'MISSING_ACCOUNT_IDENTITY_BINDING'],
    ['an empty provider account binding', { COINDCX_EXPECTED_ACCOUNT_FINGERPRINT: '' }, 'MISSING_ACCOUNT_IDENTITY_BINDING'],
    ['a raw (unhashed) provider account binding', { COINDCX_EXPECTED_ACCOUNT_FINGERPRINT: 'fake-coindcx-trading-account-1' }, 'MALFORMED_ACCOUNT_IDENTITY_BINDING'],
    ['an uppercase provider account binding', { COINDCX_EXPECTED_ACCOUNT_FINGERPRINT: 'A'.repeat(64) }, 'MALFORMED_ACCOUNT_IDENTITY_BINDING'],
    ['a padded provider account binding', { COINDCX_EXPECTED_ACCOUNT_FINGERPRINT: ` ${'a'.repeat(64)}` }, 'MALFORMED_ACCOUNT_IDENTITY_BINDING'],
    ['a truncated provider account binding', { COINDCX_EXPECTED_ACCOUNT_FINGERPRINT: 'a'.repeat(63) }, 'MALFORMED_ACCOUNT_IDENTITY_BINDING'],
    ['an empty account allowlist', { LIVE_EXECUTION_ACCOUNT_ALLOWLIST: '' }, 'EMPTY_ACCOUNT_ALLOWLIST'],
    ['a comma-only account allowlist', { LIVE_EXECUTION_ACCOUNT_ALLOWLIST: ' , , ' }, 'EMPTY_ACCOUNT_ALLOWLIST'],
    ['an empty pair allowlist', { LIVE_EXECUTION_PAIR_ALLOWLIST: '' }, 'EMPTY_PAIR_ALLOWLIST'],
    ['a missing notional ceiling', { LIVE_EXECUTION_MAX_ORDER_NOTIONAL_INR: '' }, 'MALFORMED_NOTIONAL_CEILING'],
    ['a zero notional ceiling', { LIVE_EXECUTION_MAX_ORDER_NOTIONAL_INR: '0' }, 'MALFORMED_NOTIONAL_CEILING'],
    ['a negative notional ceiling', { LIVE_EXECUTION_MAX_ORDER_NOTIONAL_INR: '-5' }, 'MALFORMED_NOTIONAL_CEILING'],
    ['a non-numeric notional ceiling', { LIVE_EXECUTION_MAX_ORDER_NOTIONAL_INR: 'lots' }, 'MALFORMED_NOTIONAL_CEILING'],
    ['an exponent notional ceiling', { LIVE_EXECUTION_MAX_ORDER_NOTIONAL_INR: '1e6' }, 'MALFORMED_NOTIONAL_CEILING'],
  ];

  it.each(malformed)('%s fails closed', (_label, overrides, reason) => {
    const resolution = resolveLiveExecutionGate(enabledLiveConfig(overrides));
    expect(resolution.status).toBe('DISABLED');
    if (resolution.status === 'DISABLED') expect(resolution.reason).toBe(reason);
  });

  it('enables only when every condition is explicitly satisfied', () => {
    const resolution = resolveLiveExecutionGate(enabledLiveConfig());
    expect(resolution.status).toBe('ENABLED');
  });

  it('requireLiveExecutionEnabled throws the named code and never leaks the credential values', () => {
    try {
      requireLiveExecutionEnabled({ ...enabledLiveConfig(), LIVE_EXECUTION_ENABLED: 'false' });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(LiveExecutionError);
      const failure = error as LiveExecutionError;
      expect(failure.code).toBe('LIVE_EXECUTION_DISABLED');
      expect(JSON.stringify(failure.toJSON())).not.toContain('test-secret');
      expect(JSON.stringify(failure.toJSON())).not.toContain('test-key');
    }
  });
});

describe('P17 enablement is non-forgeable and allowlist-bound', () => {
  it('a plain object literal is not an enablement', () => {
    expect(LiveExecutionEnablement.read({
      accountAllowlist: ['account-live-1'],
      pairAllowlist: ['B-BTC_USDT'],
      maxOrderNotionalInr: '1',
      credentialAccountId: 'account-live-1',
      environment: 'production',
    })).toBeNull();
  });

  it('a spread of a genuine enablement record is not an enablement', () => {
    const resolution = resolveLiveExecutionGate(enabledLiveConfig());
    if (resolution.status !== 'ENABLED') throw new Error('fixture');
    const record = LiveExecutionEnablement.read(resolution.enablement);
    expect(record).not.toBeNull();
    expect(LiveExecutionEnablement.read({ ...record })).toBeNull();
  });

  it('direct construction with a foreign issuer symbol is refused', () => {
    expect(() => new LiveExecutionEnablement(Symbol('forged'), {
      accountAllowlist: [],
      pairAllowlist: [],
      maxOrderNotionalInr: '1',
      credentialAccountId: 'account-live-1',
      expectedProviderAccountFingerprint: 'a'.repeat(64),
      environment: 'production',
    })).toThrow(LiveExecutionError);
  });

  it('answers allowlist membership exactly, and is frozen', () => {
    const resolution = resolveLiveExecutionGate(enabledLiveConfig());
    if (resolution.status !== 'ENABLED') throw new Error('fixture');
    expect(resolution.enablement.permitsAccount('account-live-1')).toBe(true);
    expect(resolution.enablement.permitsAccount('account-live-9')).toBe(false);
    expect(resolution.enablement.permitsPair('B-BTC_USDT')).toBe(true);
    expect(resolution.enablement.permitsPair('B-DOGE_USDT')).toBe(false);
    expect(Object.isFrozen(resolution.enablement)).toBe(true);
  });
});

describe('P17 live execution policy is content-addressed', () => {
  const content = (): LiveExecutionPolicyContent => defaultLiveExecutionPolicyContent('1000000');

  it('hashes purely from content, with no clock or random input', () => {
    const first = buildLiveExecutionPolicySnapshot(content());
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(buildLiveExecutionPolicySnapshot(content()).liveExecutionPolicyId).toBe(first.liveExecutionPolicyId);
    }
  });

  it('treats an equivalent decimal ceiling as the same policy', () => {
    const a = buildLiveExecutionPolicySnapshot(defaultLiveExecutionPolicyContent('1000000'));
    const b = buildLiveExecutionPolicySnapshot(defaultLiveExecutionPolicyContent('1000000.000'));
    expect(a.liveExecutionPolicyId).toBe(b.liveExecutionPolicyId);
  });

  it('treats an ordering difference in the allowed sets as the same policy', () => {
    const a = buildLiveExecutionPolicySnapshot({ ...content(), allowedOrderTypes: ['LIMIT', 'MARKET'] });
    const b = buildLiveExecutionPolicySnapshot({ ...content(), allowedOrderTypes: ['MARKET', 'LIMIT'] });
    expect(a.liveExecutionPolicyId).toBe(b.liveExecutionPolicyId);
  });

  it('changes identity when any semantic field changes', () => {
    const base = buildLiveExecutionPolicySnapshot(content()).liveExecutionPolicyId;
    expect(buildLiveExecutionPolicySnapshot({ ...content(), maxOrderNotionalInr: '2000000' }).liveExecutionPolicyId).not.toBe(base);
    expect(buildLiveExecutionPolicySnapshot({ ...content(), allowedOrderTypes: ['MARKET'] }).liveExecutionPolicyId).not.toBe(base);
    expect(buildLiveExecutionPolicySnapshot({ ...content(), requestTimeoutMs: 9_000 }).liveExecutionPolicyId).not.toBe(base);
  });

  it('detects a tampered snapshot at the consumption boundary', () => {
    const snapshot = buildLiveExecutionPolicySnapshot(content());
    const tampered = { ...snapshot, content: { ...snapshot.content, maxOrderNotionalInr: '99999999' } };
    expect(() => validateLiveExecutionPolicySnapshot(tampered)).toThrow(/LIVE_POLICY_IDENTITY_MISMATCH/);
  });

  it('ships post-only unsupported and time-in-force unclaimed by default (P17-I12)', () => {
    const defaults = defaultLiveExecutionPolicyContent('1000000');
    expect(defaults.postOnlySupported).toBe(false);
    expect(defaults.allowedTimeInForce).toEqual(['UNSPECIFIED']);
    expect(defaults.policyVersion).toBe(LIVE_EXECUTION_POLICY_VERSION);
  });

  it('refuses a policy that permits POST_ONLY while declaring it unsupported', () => {
    expect(() => normalizeLiveExecutionPolicyContent({
      ...content(),
      allowedTimeInForce: ['UNSPECIFIED', 'POST_ONLY'],
      postOnlySupported: false,
    })).toThrow(/LIVE_INTENT_INVALID/);
  });

  it('refuses a policy override that claims CoinDCX supports post-only', () => {
    expect(() => normalizeLiveExecutionPolicyContent({
      ...content(),
      allowedTimeInForce: ['UNSPECIFIED'],
      postOnlySupported: true,
    })).toThrow(/fixed unsupported exchange capability/);
  });

  it('refuses malformed policy content', () => {
    expect(() => normalizeLiveExecutionPolicyContent({ ...content(), policyVersion: 'OTHER' as never })).toThrow(LiveExecutionError);
    expect(() => normalizeLiveExecutionPolicyContent({ ...content(), allowedOrderTypes: [] })).toThrow(LiveExecutionError);
    expect(() => normalizeLiveExecutionPolicyContent({ ...content(), allowedOrderTypes: ['STOP' as never] })).toThrow(LiveExecutionError);
    expect(() => normalizeLiveExecutionPolicyContent({ ...content(), requestTimeoutMs: 0 })).toThrow(LiveExecutionError);
    expect(() => normalizeLiveExecutionPolicyContent({ ...content(), requestTimeoutMs: 999_999 })).toThrow(LiveExecutionError);
    expect(() => normalizeLiveExecutionPolicyContent({ ...content(), maxOrderNotionalInr: '0' })).toThrow(LiveExecutionError);
  });
});
