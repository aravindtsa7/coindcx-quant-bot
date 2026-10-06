import { describe, expect, it } from 'vitest';
import { parseHttpDate, parseRetryAfter, serverWaitBound, validateRateLimiterConfig } from '../../../../src/integration/coindcx/rate-limit';
import { fixtureConfig } from './harness';

const policy = fixtureConfig().retryAfter;
const RECEIPT = Date.parse('Tue, 06 Oct 2026 00:00:00 GMT');
const at = (iso: string): number => Date.parse(iso);

describe('M2 W1 HTTP-date parsing (RFC 9110 §5.6.7: all three forms)', () => {
  it.each([
    ['Tue, 06 Oct 2026 00:10:00 GMT', 'IMF', '2026-10-06T00:10:00.000Z'],
    ['Tuesday, 06-Oct-26 00:10:00 GMT', 'RFC850', '2026-10-06T00:10:00.000Z'],
    ['Tue Oct  6 00:10:00 2026', 'ASCTIME', '2026-10-06T00:10:00.000Z'],
    ['Tue Oct 06 00:10:00 2026', 'ASCTIME', '2026-10-06T00:10:00.000Z'],
    ['Thursday, 06-Oct-77 00:00:00 GMT', 'RFC850', '1977-10-06T00:00:00.000Z'],
    ['Tue, 06 Oct 2026 23:59:60 GMT', 'IMF', '2026-10-07T00:00:00.000Z'],
  ])('%s -> %s %s', (value, form, iso) => {
    expect(parseHttpDate(value, 2026)).toEqual({ kind: 'DATE', form, wallMs: at(iso) });
  });

  it.each([
    ['Mon, 06 Oct 2026 00:10:00 GMT', 'WEEKDAY_MISMATCH'], ['Tue, 31 Feb 2026 00:10:00 GMT', 'CALENDAR'], ['Tue, 06 Oct 2026 24:00:00 GMT', 'FIELD_RANGE'],
    ['tue, 06 oct 2026 00:10:00 gmt', 'SYNTAX'], ['Tue, 06 Oct 2026 00:10:00 UTC', 'SYNTAX'], ['', 'SYNTAX'],
  ])('%s is invalid (%s)', (value, reason) => {
    expect(parseHttpDate(value, 2026)).toEqual({ kind: 'INVALID', reason });
  });

  it('an RFC 850 two-digit year is never guessed without a reference', () => {
    expect(parseHttpDate('Tuesday, 06-Oct-26 00:10:00 GMT', null)).toEqual({ kind: 'TWO_DIGIT_YEAR_UNRESOLVED' });
  });

  it('delay-seconds, overflow, absent and malformed values', () => {
    expect(parseRetryAfter('600', null)).toEqual({ kind: 'SECONDS', waitMs: 600_000 });
    expect(parseRetryAfter(' 0600 ', null)).toEqual({ kind: 'SECONDS', waitMs: 600_000 });
    expect(parseRetryAfter('99999999999999999999', null)).toEqual({ kind: 'OVERFLOW' });
    expect(parseRetryAfter(undefined, null)).toEqual({ kind: 'ABSENT' });
    for (const v of ['-1', '1.5', 'soon']) expect(parseRetryAfter(v, null).kind).toBe('INVALID');
  });
});

describe('M2 W1 server wait bound', () => {
  const ctx = (retryAfter: string | undefined, extra: Partial<Parameters<typeof serverWaitBound>[0]> = {}) => ({ retryAfter, serverDate: undefined, receiptWallMs: RECEIPT, localClockTrusted: true, ...extra });

  it.each(['Tue, 06 Oct 2026 00:10:00 GMT', 'Tuesday, 06-Oct-26 00:10:00 GMT', 'Tue Oct  6 00:10:00 2026'])('%s: 600 s + 2 s uncertainty, by trusted clock or by Date header; fail closed with neither', (value) => {
    const form = value.includes('-Oct-') ? 'RFC850' : value.includes(',') ? 'IMF' : 'ASCTIME';
    expect(serverWaitBound(ctx(value), policy)).toEqual({ kind: 'RELATIVE', waitMs: 602_000, form });
    expect(serverWaitBound(ctx(value, { localClockTrusted: false, receiptWallMs: RECEIPT + 540_000, serverDate: 'Tue, 06 Oct 2026 00:00:00 GMT' }), policy)).toEqual({ kind: 'RELATIVE', waitMs: 602_000, form });
    expect(serverWaitBound(ctx(value, { localClockTrusted: false }), policy)).toEqual({ kind: 'UNBOUNDED', alert: 'DATE_CONVERSION_UNCERTAIN' });
  });

  it('takes the larger candidate when both the Date header and a trusted clock exist; past dates wait only the uncertainty', () => {
    expect(serverWaitBound(ctx('Tue, 06 Oct 2026 00:10:00 GMT', { serverDate: 'Mon, 05 Oct 2026 23:58:00 GMT' }), policy)).toEqual({ kind: 'RELATIVE', waitMs: 722_000, form: 'IMF' });
    expect(serverWaitBound(ctx('Mon, 05 Oct 2026 23:00:00 GMT'), policy)).toEqual({ kind: 'RELATIVE', waitMs: 2000, form: 'IMF' });
  });

  it('only an absent header uses the default; unparseable and overflowing values are unbounded', () => {
    expect(serverWaitBound(ctx(undefined), policy)).toEqual({ kind: 'DEFAULT', waitMs: 60_000 });
    expect(serverWaitBound(ctx('Mon, 06 Oct 2026 00:10:00 GMT'), policy)).toEqual({ kind: 'UNBOUNDED', alert: 'RETRY_AFTER_PRESENT_BUT_UNPARSEABLE' });
    expect(serverWaitBound(ctx('99999999999999999999'), policy)).toEqual({ kind: 'UNBOUNDED', alert: 'RETRY_AFTER_OVERFLOW' });
  });
});

describe('M2 W1 configuration is explicit and validated', () => {
  const valid = (): Record<string, unknown> => JSON.parse(JSON.stringify(fixtureConfig()));
  it('accepts the fixture and freezes it', () => {
    const r = validateRateLimiterConfig(valid());
    expect(r.kind).toBe('VALID');
    if (r.kind === 'VALID') expect(Object.isFrozen(r.config) && Object.isFrozen(r.config.retryAfter)).toBe(true);
  });
  it.each<[string, (c: Record<string, unknown>) => void, string]>([
    ['a missing value (no defaults)', (c) => { delete c.grantTtlMs; }, 'CONFIG_SHAPE'],
    ['an extra key', (c) => { c.extra = 1; }, 'CONFIG_SHAPE'],
    ['infeasible class minimums', (c) => { (c.classShares as Record<string, { minPerWindow: number }>).P0!.minPerWindow = 201; }, 'CLASS_SHARE_P0'],
    ['minimums above the fairness window cap', (c) => { for (const k of ['P0', 'P1', 'P2', 'P3']) (c.classShares as Record<string, { minPerWindow: number }>)[k]!.minPerWindow = 60; }, 'CLASS_MINIMUMS_INFEASIBLE'],
    ['a P0 reservation that leaves no slot', (c) => { c.p0ReservedSlots = c.concurrency; }, 'CONCURRENCY'],
    ['a fairness window that is not configured', (c) => { c.fairnessWindowMs = 5000; }, 'FAIRNESS_WINDOW_NOT_CONFIGURED'],
    ['a non-integer', (c) => { c.concurrency = 1.5; }, 'CONCURRENCY'],
    ['a missing retry-after value', (c) => { delete (c.retryAfter as Record<string, unknown>).noHeaderDefaultMs; }, 'RETRY_AFTER_SHAPE'],
  ])('rejects %s', (_label, mutate, reason) => {
    const c = valid(); mutate(c);
    expect(validateRateLimiterConfig(c)).toEqual({ kind: 'INVALID', reason });
  });
  it('rejects accessors and proxies', () => {
    const c = valid();
    expect(validateRateLimiterConfig(new Proxy(c, {}))).toEqual({ kind: 'INVALID', reason: 'CONFIG_SHAPE' });
    Object.defineProperty(c, 'concurrency', { get: () => 8, enumerable: true });
    expect(validateRateLimiterConfig(c)).toEqual({ kind: 'INVALID', reason: 'CONFIG_SHAPE' });
  });
});
