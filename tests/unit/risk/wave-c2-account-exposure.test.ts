import { describe, expect, it } from 'vitest';
import { RiskEngine, RiskEngineError, type PortfolioExposureSnapshot, type RiskDecision } from '../../../src/risk';
import { accountStateReasons } from '../../../src/risk/account';
import { exposureStateReasons } from '../../../src/risk/exposure';
import { makeAccount, makeContext, makeExposure, makePolicy, resealContext, seal } from './helpers';

// Wave C2 — C-F03 (impossible finite account state) and C-F04 (contradictory exposure
// aggregate) fail-closed corrections. Does not reopen Wave C1 (C-F01/C-F02/C-F05).

function rejectionCodes(result: RiskDecision): readonly string[] {
  return result.status === 'REJECTED' ? [result.primaryReasonCode, ...result.secondaryReasonCodes] : [];
}

function evaluate(changes: Parameters<typeof makeContext>[0] = {}): RiskDecision {
  return new RiskEngine(makePolicy()).evaluateRisk(resealContext(makeContext(changes)));
}

describe('C-F03 impossible finite account state acceptance', () => {
  it.each([
    ['lockedMarginInr', '-1'],
    ['availableMarginInr', '-1'],
    ['currentEquityInr', '-1'],
  ] as const)('rejects OPEN when %s is negative', (field, value) => {
    const account = seal({ ...makeAccount(), [field]: value });
    const result = evaluate({ accountSnapshot: account });
    expect(result.status).toBe('REJECTED');
    expect(rejectionCodes(result)).toContain('ACCOUNT_STATE_UNAVAILABLE');
  });

  it('rejects a directly-constructed snapshot with negative lockedMarginInr (the original defect) via accountStateReasons', () => {
    const account = seal({ ...makeAccount(), lockedMarginInr: '-1' });
    expect(accountStateReasons(account)).toEqual(['ACCOUNT_STATE_UNAVAILABLE']);
  });

  it('rejects zero equity with a positive locked margin via the existing equity-positivity gate (unrelated to the new negativity checks)', () => {
    const account = seal({ ...makeAccount(), currentEquityInr: '0', lockedMarginInr: '5000' });
    const result = evaluate({ accountSnapshot: account });
    expect(result.status).toBe('REJECTED');
    expect(rejectionCodes(result)).toContain('ACCOUNT_STATE_UNAVAILABLE');
  });

  it('does NOT enforce an available+locked<=equity decomposition that the provider contract never guarantees', () => {
    // availableMarginInr + lockedMarginInr (150000) exceeds currentEquityInr (100000): every
    // individual field is still non-negative, so this must remain accepted — see
    // docs/RISK_LEVERAGE_ENGINE.md §15.1, which never asserts this relationship.
    const account = seal({ ...makeAccount(), availableMarginInr: '100000', lockedMarginInr: '50000', currentEquityInr: '100000', peakEquityInr: '100000' });
    expect(accountStateReasons(account)).toEqual([]);
    expect(evaluate({ accountSnapshot: account }).status).toBe('ACCEPTED');
  });

  it.each([
    ['zero locked margin', { lockedMarginInr: '0' }],
    ['zero available margin', { availableMarginInr: '0' }],
    ['a fully-utilized account (available=0, locked=equity)', { availableMarginInr: '0', lockedMarginInr: '100000', currentEquityInr: '100000', peakEquityInr: '100000' }],
    ['the smallest valid positive Decimal (1e-18)', { availableMarginInr: '0.000000000000000001' }],
    ['a large finite Decimal', { availableMarginInr: '99999999999999999999999999999' }],
  ])('accepts the valid account boundary: %s', (_label, overrides) => {
    const account = seal({ ...makeAccount(), ...overrides });
    expect(accountStateReasons(account)).toEqual([]);
  });

  it.each([
    ['NaN', 'NaN'], ['Infinity', 'Infinity'], ['-Infinity', '-Infinity'], ['empty string', ''], ['malformed', 'not-a-decimal'],
  ])('fails closed at ingestion (RISK_SOURCE_INVALID) rather than accepting a non-finite/malformed %s', (_label, value) => {
    const account = seal({ ...makeAccount(), lockedMarginInr: value });
    expect(() => evaluate({ accountSnapshot: account })).toThrowError(RiskEngineError);
  });

  it('accepts NO_CHANGE without requiring account state (matches the existing action-scoped gate)', () => {
    const account = seal({ ...makeAccount(), lockedMarginInr: '-1', accountStateKnown: false });
    expect(accountStateReasons(account)).toEqual(['ACCOUNT_STATE_UNAVAILABLE']);
  });
});

describe('C-F04 exposure aggregate consistency', () => {
  function exposureWith(changes: Partial<PortfolioExposureSnapshot> = {}, pendingChanges: Partial<Extract<PortfolioExposureSnapshot['pending'], { status: 'KNOWN' }>> = {}): PortfolioExposureSnapshot {
    const base = makeExposure();
    if (base.pending.status !== 'KNOWN') throw new Error('fixture');
    return seal({ ...base, ...changes, pending: { ...base.pending, ...pendingChanges } });
  }

  it('rejects global open exposure below a reported pair component (probe A)', () => {
    const exposure = exposureWith({ globalOpenNotionalInr: '0', perPairOpenNotionalInr: { 'B-ETH_USDT': '800000' } });
    expect(exposureStateReasons(exposure)).toEqual(['EXPOSURE_STATE_UNAVAILABLE']);
    expect(rejectionCodes(evaluate({ exposureSnapshot: exposure }))).toContain('EXPOSURE_STATE_UNAVAILABLE');
  });

  it('rejects global pending exposure below a reported instance reservation (probe B)', () => {
    const exposure = exposureWith({}, { globalPendingNotionalInr: '0', instancePendingReservations: [
      { strategyInstanceId: 'instance-2', strategyId: 'OTHER', strategyVersion: '1.0.0', parameterHash: 'b'.repeat(64), pendingNotionalInr: '800000', pendingReservationCount: 1 },
    ] });
    expect(exposureStateReasons(exposure)).toEqual(['EXPOSURE_STATE_UNAVAILABLE']);
    expect(rejectionCodes(evaluate({ exposureSnapshot: exposure }))).toContain('EXPOSURE_STATE_UNAVAILABLE');
  });

  it('rejects global open exposure narrowly below a pair component (probe C)', () => {
    const exposure = exposureWith({ globalOpenNotionalInr: '100', perPairOpenNotionalInr: { 'B-BTC_USDT': '101' } });
    expect(exposureStateReasons(exposure)).toEqual(['EXPOSURE_STATE_UNAVAILABLE']);
  });

  it('rejects global pending exposure narrowly below a strategy component (probe D)', () => {
    const exposure = exposureWith({}, { globalPendingNotionalInr: '100', strategyPendingNotionalInr: { EMA_TREND: '101' } });
    expect(exposureStateReasons(exposure)).toEqual(['EXPOSURE_STATE_UNAVAILABLE']);
  });

  it('rejects global open exposure below a strategy component', () => {
    const exposure = exposureWith({ globalOpenNotionalInr: '50', perStrategyOpenNotionalInr: { EMA_TREND: '51' } });
    expect(exposureStateReasons(exposure)).toEqual(['EXPOSURE_STATE_UNAVAILABLE']);
  });

  it.each([
    ['parent exactly equal to its largest component (probe E)', { globalOpenNotionalInr: '100', perPairOpenNotionalInr: { 'B-BTC_USDT': '100' } }],
    ['parent greater than every component (probe F)', { globalOpenNotionalInr: '200', perPairOpenNotionalInr: { 'B-BTC_USDT': '100' } }],
    ['multiple pairs and strategies under a valid parent (probe G)', { globalOpenNotionalInr: '300', perPairOpenNotionalInr: { 'B-BTC_USDT': '100', 'B-ETH_USDT': '150' }, perStrategyOpenNotionalInr: { EMA_TREND: '100', OTHER: '50' } }],
  ])('accepts a valid exposure aggregate: %s', (_label, changes) => {
    const exposure = exposureWith(changes);
    expect(exposureStateReasons(exposure)).toEqual([]);
  });

  it('rejects a negative pending component before reaching aggregate consistency (fail closed on malformed evidence)', () => {
    const exposure = exposureWith({}, { pairPendingNotionalInr: { 'B-BTC_USDT': '-1' } });
    expect(exposureStateReasons(exposure)).toEqual(['EXPOSURE_STATE_UNAVAILABLE']);
  });

  it('fails ingestion (RISK_SOURCE_INVALID) rather than accepting a non-finite/malformed component', () => {
    const exposure = exposureWith({ perPairOpenNotionalInr: { 'B-BTC_USDT': 'NaN' } });
    expect(() => evaluate({ exposureSnapshot: exposure })).toThrowError(RiskEngineError);
  });

  it('multi-coin: a contradiction in the ETH component blocks BTC approval within the same account-wide snapshot', () => {
    const exposure = exposureWith({ globalOpenNotionalInr: '10', perPairOpenNotionalInr: { 'B-BTC_USDT': '10', 'B-ETH_USDT': '800000' } });
    const result = evaluate({ exposureSnapshot: exposure });
    expect(result.status).toBe('REJECTED');
    expect(rejectionCodes(result)).toContain('EXPOSURE_STATE_UNAVAILABLE');
  });

  it('multi-coin: valid global coverage of both BTC and ETH components is accepted', () => {
    const exposure = exposureWith({ globalOpenNotionalInr: '300', perPairOpenNotionalInr: { 'B-BTC_USDT': '100', 'B-ETH_USDT': '150' } });
    expect(exposureStateReasons(exposure)).toEqual([]);
  });

  it('never silently normalizes: does not clamp, sum-and-continue, or drop the contradictory component', () => {
    const exposure = exposureWith({ globalOpenNotionalInr: '0', perPairOpenNotionalInr: { 'B-ETH_USDT': '800000' } });
    // A silent max(component) or sum-and-continue repair would either accept this or produce
    // a different rejection code; the only acceptable outcome is the direct contradiction code.
    expect(exposureStateReasons(exposure)).toEqual(['EXPOSURE_STATE_UNAVAILABLE']);
  });
});

describe('RiskDecision identity is preserved through Identity V2 for new semantic rejections', () => {
  it('produces a deterministic identical riskDecisionId for the same semantic account rejection', () => {
    const account = seal({ ...makeAccount(), lockedMarginInr: '-1' });
    const first = evaluate({ accountSnapshot: account });
    const second = evaluate({ accountSnapshot: account });
    expect(first.riskDecisionId).toBe(second.riskDecisionId);
  });

  it('gives a valid account and an impossible account distinct final decision identities', () => {
    const valid = evaluate({ accountSnapshot: makeAccount() });
    const invalid = evaluate({ accountSnapshot: seal({ ...makeAccount(), lockedMarginInr: '-1' }) });
    expect(valid.riskDecisionId).not.toBe(invalid.riskDecisionId);
  });

  it('gives a valid exposure and a contradictory exposure distinct final decision identities', () => {
    const valid = evaluate({ exposureSnapshot: makeExposure() });
    const invalid = evaluate({ exposureSnapshot: seal({ ...makeExposure(), globalOpenNotionalInr: '0', perPairOpenNotionalInr: { 'B-ETH_USDT': '800000' } }) });
    expect(valid.riskDecisionId).not.toBe(invalid.riskDecisionId);
  });
});
