import { parse as parseLosslessJson } from 'lossless-json';
import { describe, expect, it } from 'vitest';
import {
  CandidateTracker,
  SecretRegistry,
  TimestampTracker,
  analyzeUserInfo,
  classifyTimestamp,
  enumerateKeyPaths,
  sanitizeHeaders,
  sha256Hex,
} from '../../../../scripts/provider-probe/sanitize';

const API_KEY = 'fake-api-key-0123456789abcdef';

describe('[probe sanitize] headers', () => {
  const headers = {
    'Set-Cookie': ['session=abcdef123456; HttpOnly'],
    cookie: 'a=b',
    authorization: 'Bearer secret-token-value',
    'x-auth-apikey': API_KEY,
    'x-auth-signature': 'deadbeefdeadbeef',
    date: 'Wed, 23 Sep 2026 10:00:00 GMT',
    'content-type': 'application/json',
    etag: 'W/"abc"',
    'x-request-id': 'req-9f8e7d6c5b4a',
    'x-sequence': '1024',
    'x-echo-debug': API_KEY,
    'strict-transport-security': 'max-age=31536000',
    'some-other-header': 'opaque-value-123',
  };
  const sanitized = sanitizeHeaders(headers);
  const byName = new Map(sanitized.map((header) => [header.name, header]));

  it('always suppresses cookies and authentication headers, with no value or shape', () => {
    for (const name of ['set-cookie', 'cookie', 'authorization', 'x-auth-apikey', 'x-auth-signature']) {
      const header = byName.get(name)!;
      expect(header.treatment).toBe('SUPPRESSED');
      expect(header.value).toBeUndefined();
      expect(header.shape).toBeUndefined();
    }
    const serialized = JSON.stringify(sanitized);
    for (const secret of [API_KEY, 'abcdef123456', 'secret-token-value', 'deadbeefdeadbeef']) expect(serialized).not.toContain(secret);
  });

  it('records values only for clearly non-secret headers', () => {
    expect(byName.get('date')).toMatchObject({ treatment: 'VALUE_RECORDED', value: 'Wed, 23 Sep 2026 10:00:00 GMT', candidate: true });
    // An ETag can be a digest of the response body (for /users/info, of PII), so only its shape is kept.
    expect(byName.get('etag')).toMatchObject({ treatment: 'SHAPE_ONLY', candidate: true });
    expect(byName.get('etag')?.value).toBeUndefined();
    expect(byName.get('content-type')).toMatchObject({ treatment: 'VALUE_RECORDED' });
  });

  it('inspects candidate and x-* headers by shape only (length, charset, digest), never by value', () => {
    expect(byName.get('x-request-id')).toMatchObject({ treatment: 'SHAPE_ONLY', candidate: true });
    expect(byName.get('x-sequence')).toMatchObject({ treatment: 'SHAPE_ONLY', shape: { length: 4, charset: 'DIGITS' } });
    expect(byName.get('x-echo-debug')?.value).toBeUndefined();
    expect(byName.get('some-other-header')).toEqual({ name: 'some-other-header', treatment: 'NAME_ONLY', candidate: false });
  });
});

describe('[probe sanitize] /users/info', () => {
  const userInfo = [{
    coindcx_id: 'cdx-user-7f3a9c21', first_name: 'Janet', last_name: 'Doemann',
    email: 'janet.doemann@example.com', mobile_number: '+919876543210', kyc_status: 'verified',
  }];

  it('reports field names, cardinality, and a SHA-256 of coindcx_id; never a PII value', () => {
    const registry = new SecretRegistry();
    const observation = analyzeUserInfo(userInfo, registry);
    expect(observation).toEqual({
      shape: 'ARRAY', arrayLength: 1, cardinalityExpected: true, coindcxIdPresent: true,
      coindcxIdSha256: sha256Hex('cdx-user-7f3a9c21'),
      fieldNames: ['coindcx_id', 'email', 'first_name', 'kyc_status', 'last_name', 'mobile_number'],
    });
    const serialized = JSON.stringify(observation);
    for (const value of ['cdx-user-7f3a9c21', 'Janet', 'Doemann', 'janet.doemann@example.com', '+919876543210']) {
      expect(serialized).not.toContain(value);
    }
    // Identifying values within the scan bounds are registered for the final sweep (defense in depth).
    expect(registry.findIn('x cdx-user-7f3a9c21 janet.doemann@example.com +919876543210 Doemann')).toHaveLength(4);
  });

  it('flags unexpected cardinality', () => {
    const registry = new SecretRegistry();
    expect(analyzeUserInfo([{ coindcx_id: 'aaaaaaa1' }, { coindcx_id: 'bbbbbbb2' }], registry).cardinalityExpected).toBe(false);
    expect(analyzeUserInfo([], registry).coindcxIdPresent).toBe(false);
    expect(analyzeUserInfo({ coindcx_id: 'cccccc33' }, registry)).toMatchObject({ shape: 'OBJECT', cardinalityExpected: true });
  });
});

describe('[probe sanitize] recursive candidate-field scanner', () => {
  it('finds candidate names at any depth and summarizes without raw values', () => {
    const tracker = new CandidateTracker();
    tracker.observe('rest:X', { data: [{ id: 'o1', sequence: 41, nested: { update_id: 'u-aaa' } }] });
    tracker.observe('rest:X', { data: [{ id: 'o1', sequence: 42, nested: { update_id: 'u-bbb' } }] });
    tracker.observe('ws:e', { SessionId: 'sess-xyz', payload: { 'last-event-id': 7, price: 1 } });
    const summary = tracker.summarize();
    const byPath = new Map(summary.map((entry) => [`${entry.scope} ${entry.path}`, entry]));
    expect(byPath.get('rest:X $.data[].sequence')).toMatchObject({ occurrences: 2, distinctValues: 2, numericNonDecreasing: true, numericDigitCounts: [2], note: 'NAME_MATCH_ONLY_SEMANTICS_UNVERIFIED' });
    expect(byPath.get('rest:X $.data[].nested.update_id')).toMatchObject({ occurrences: 2, numericNonDecreasing: null });
    expect(byPath.has('ws:e $.SessionId')).toBe(true);
    expect(byPath.has('ws:e $.payload.last-event-id')).toBe(true);
    expect(byPath.has('rest:X $.data[].id')).toBe(false);
    expect(JSON.stringify(summary)).not.toMatch(/u-aaa|u-bbb|sess-xyz/);
  });

  it('handles lossless numbers exactly and detects a decrease', () => {
    const tracker = new CandidateTracker();
    tracker.observe('s', parseLosslessJson('{"version": 90071992547409930}'));
    tracker.observe('s', parseLosslessJson('{"version": 90071992547409929}'));
    expect(tracker.summarize()[0]).toMatchObject({ numericNonDecreasing: false, numericDigitCounts: [17] });
  });

  it('enumerates key paths with types, arrays as []', () => {
    expect(enumerateKeyPaths([{ a: 1, b: { c: 'x' } }, { a: null }])).toEqual([
      { path: '$', types: ['array'] },
      { path: '$[]', types: ['object'] },
      { path: '$[].a', types: ['null', 'number'] },
      { path: '$[].b', types: ['object'] },
      { path: '$[].b.c', types: ['string'] },
    ]);
  });
});

describe('[probe sanitize] timestamps', () => {
  it.each([
    ['1700000000', 'SECONDS'], ['1700000000.123', 'SECONDS_FRACTIONAL'], ['1700000000123', 'MILLISECONDS'],
    ['1700000000123456', 'MICROSECONDS'], ['1700000000123456789', 'NANOSECONDS'],
    ['2026-09-23T10:00:00.000Z', 'ISO_8601_STRING'], ['abc', 'UNCLASSIFIED'], ['12345', 'UNCLASSIFIED'],
  ])('%s -> %s', (value, unit) => {
    expect(classifyTimestamp(value)).toBe(unit);
  });

  it('tracks units per timestamp-named field, never values', () => {
    const tracker = new TimestampTracker();
    tracker.observe('rest:O', [{ created_at: 1700000000123, updated_at: '1700000000', timestamp: 1700000000123456, price: 1700000000 }]);
    const summary = tracker.summarize();
    expect(summary.map((entry) => [entry.path, entry.units])).toEqual([
      ['$[].created_at', { MILLISECONDS: 1 }],
      ['$[].updated_at', { SECONDS: 1 }],
      ['$[].timestamp', { MICROSECONDS: 1 }],
    ]);
    expect(JSON.stringify(summary)).not.toContain('1700000000');
  });
});

describe('[probe sanitize] secret registry', () => {
  it('finds and redacts explicit secrets by label', () => {
    const registry = new SecretRegistry();
    registry.addSecret('api-key', API_KEY);
    expect(registry.findIn(`header ${API_KEY}`)).toEqual(['api-key']);
    expect(registry.redact(`k=${API_KEY}`)).toBe('k=<redacted:api-key>');
  });

  it('force-registers explicit credentials and signatures of ANY length (no length heuristic)', () => {
    const registry = new SecretRegistry();
    registry.addSecret('api-key', 'k');
    registry.addSecret('api-secret', 's');
    registry.addSecret('signature', 'ab');
    registry.addSecret('empty', '');
    expect(registry.size).toBe(3);
    expect(registry.findIn('the key k')).toEqual(['api-key']);
    expect(registry.findIn('x s y')).toEqual(['api-secret']);
    expect(registry.findIn('--ab--')).toEqual(['signature']);
    // Redaction removes them without the marker reintroducing one ("k" occurs in "<redacted:api-key>").
    const redacted = registry.redact('key=k secret=s sig=ab');
    for (const secret of ['k', 's', 'ab']) expect(redacted).not.toContain(secret);
    expect(registry.findIn(redacted)).toEqual([]);
  });

  it('redaction can never leave a registered value behind, even with pathological one-character secrets', () => {
    const registry = new SecretRegistry();
    for (const [index, secret] of ['<', 'r', 'e', 'd', '#', '*', '~'].entries()) registry.addSecret(`secret-${index}`, secret);
    for (const text of ['<redacted>', 'reader ###', 'plain text with d and e', '']) {
      expect(registry.findIn(registry.redact(text))).toEqual([]);
    }
  });

  it('keeps the false-positive length floor for PROVIDER-DERIVED values only', () => {
    const registry = new SecretRegistry();
    registry.addProviderValue('short', '1234');
    registry.addProviderValue('short-numeric-id', '12345678');
    registry.addProviderValue('word', 'verified-looking');
    expect(registry.findIn('content-length 1234 digest 0a12345678ff')).toEqual([]);
    expect(registry.findIn('x verified-looking y')).toEqual(['word']);
    // A provider value never relabels an explicit secret.
    registry.addSecret('api-key', API_KEY);
    registry.addProviderValue('value-of:echo', API_KEY);
    expect(registry.findIn(API_KEY)).toEqual(['api-key']);
  });
});
