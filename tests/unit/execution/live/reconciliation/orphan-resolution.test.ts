import { describe, expect, it } from 'vitest';
import {
  mintOrphanAmbiguityResolutionRequest,
  OrphanAmbiguityResolutionRequest,
  readOrphanAmbiguityResolutionRequest,
} from '../../../../../src/execution/live/reconciliation/orphan-resolution';
import { ACCOUNT } from './helpers';

const EXCHANGE_ORDER_ID = 'stranger-1';

function validInput(overrides: Partial<Parameters<typeof mintOrphanAmbiguityResolutionRequest>[0]> = {}) {
  return {
    accountId: ACCOUNT,
    exchangeOrderId: EXCHANGE_ORDER_ID,
    expectedRevision: 3,
    outcome: 'ACKNOWLEDGED_NO_RETRY' as const,
    resolvedBy: 'ops:jane',
    ...overrides,
  };
}

describe('P18 Wave C1 §F18-06 mintOrphanAmbiguityResolutionRequest: shape and bounds validation', () => {
  it('mints a genuine request from valid input, readable only via readOrphanAmbiguityResolutionRequest', () => {
    const request = mintOrphanAmbiguityResolutionRequest(validInput());
    expect(request).toBeInstanceOf(OrphanAmbiguityResolutionRequest);
    const record = readOrphanAmbiguityResolutionRequest(request);
    expect(record).toEqual({
      accountId: ACCOUNT,
      exchangeOrderId: EXCHANGE_ORDER_ID,
      expectedRevision: 3,
      outcome: 'ACKNOWLEDGED_NO_RETRY',
      resolvedBy: 'ops:jane',
      note: null,
    });
  });

  it('accepts CONFIRMED_CANCELLED with an optional bounded note', () => {
    const request = mintOrphanAmbiguityResolutionRequest(validInput({ outcome: 'CONFIRMED_CANCELLED', note: 'Verified cancelled via CoinDCX support ticket #4821' }));
    expect(readOrphanAmbiguityResolutionRequest(request)?.note).toBe('Verified cancelled via CoinDCX support ticket #4821');
  });

  it.each(['', 'PENDING', 'CONFIRMED', 'CANCELLED', 'confirmed_cancelled'])('refuses an unrecognized outcome %s', (outcome) => {
    expect(() => mintOrphanAmbiguityResolutionRequest(validInput({ outcome: outcome as never })))
      .toThrow(/LIVE_ORPHAN_RESOLUTION_INVALID/);
  });

  it('refuses an empty accountId', () => {
    expect(() => mintOrphanAmbiguityResolutionRequest(validInput({ accountId: '' })))
      .toThrow(/LIVE_ORPHAN_RESOLUTION_INVALID/);
  });

  it('refuses an empty exchangeOrderId', () => {
    expect(() => mintOrphanAmbiguityResolutionRequest(validInput({ exchangeOrderId: '' })))
      .toThrow(/LIVE_ORPHAN_RESOLUTION_INVALID/);
  });

  it.each([-1, 1.5, Infinity, -Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('refuses a non-safe-non-negative-integer expectedRevision %s', (revision) => {
    expect(() => mintOrphanAmbiguityResolutionRequest(validInput({ expectedRevision: revision })))
      .toThrow(/LIVE_ORPHAN_RESOLUTION_INVALID/);
  });

  it('accepts expectedRevision = 0 (a never-yet-mutated orphan row)', () => {
    expect(() => mintOrphanAmbiguityResolutionRequest(validInput({ expectedRevision: 0 }))).not.toThrow();
  });

  it('refuses an empty resolvedBy', () => {
    expect(() => mintOrphanAmbiguityResolutionRequest(validInput({ resolvedBy: '' })))
      .toThrow(/LIVE_ORPHAN_RESOLUTION_INVALID/);
  });

  it('refuses a resolvedBy longer than the bounded limit', () => {
    expect(() => mintOrphanAmbiguityResolutionRequest(validInput({ resolvedBy: 'x'.repeat(129) })))
      .toThrow(/LIVE_ORPHAN_RESOLUTION_INVALID/);
  });

  it('accepts a resolvedBy exactly at the bounded limit', () => {
    expect(() => mintOrphanAmbiguityResolutionRequest(validInput({ resolvedBy: 'x'.repeat(128) }))).not.toThrow();
  });

  it('refuses a note longer than the bounded limit', () => {
    expect(() => mintOrphanAmbiguityResolutionRequest(validInput({ note: 'x'.repeat(513) })))
      .toThrow(/LIVE_ORPHAN_RESOLUTION_INVALID/);
  });

  it('accepts a note exactly at the bounded limit', () => {
    expect(() => mintOrphanAmbiguityResolutionRequest(validInput({ note: 'x'.repeat(512) }))).not.toThrow();
  });

  it('never treats the note as credential-shaped and never throws for ordinary operator prose', () => {
    expect(() => mintOrphanAmbiguityResolutionRequest(validInput({
      note: 'Confirmed with CoinDCX support that order #stranger-1 was already cancelled before our request arrived.',
    }))).not.toThrow();
  });
});

describe('P18 Wave C1 §F18-06 forgery resistance: readOrphanAmbiguityResolutionRequest refuses anything not genuinely minted', () => {
  const genuineRecord = {
    accountId: ACCOUNT,
    exchangeOrderId: EXCHANGE_ORDER_ID,
    expectedRevision: 3,
    outcome: 'ACKNOWLEDGED_NO_RETRY' as const,
    resolvedBy: 'ops:jane',
    note: null,
  };

  it('refuses a plain object shaped exactly like a genuine request', () => {
    expect(readOrphanAmbiguityResolutionRequest({ ...genuineRecord })).toBeNull();
  });

  it('refuses Object.create(OrphanAmbiguityResolutionRequest.prototype) with no real private field', () => {
    const fake = Object.create(OrphanAmbiguityResolutionRequest.prototype);
    expect(readOrphanAmbiguityResolutionRequest(fake)).toBeNull();
  });

  it('refuses a structurally similar but distinct class instance', () => {
    class Lookalike {
      public accountId = ACCOUNT;
      public exchangeOrderId = EXCHANGE_ORDER_ID;
    }
    expect(readOrphanAmbiguityResolutionRequest(new Lookalike())).toBeNull();
  });

  it('refuses null, undefined, a boxed string, and a bare string', () => {
    expect(readOrphanAmbiguityResolutionRequest(null)).toBeNull();
    expect(readOrphanAmbiguityResolutionRequest(undefined)).toBeNull();
    expect(readOrphanAmbiguityResolutionRequest(new String('genuine'))).toBeNull();
    expect(readOrphanAmbiguityResolutionRequest('genuine')).toBeNull();
  });

  it('refuses direct construction with any issuer other than the module-private one', () => {
    expect(() => new (OrphanAmbiguityResolutionRequest as unknown as new (issuer: unknown, record: unknown) => unknown)(
      { purpose: 'a forged issuer' }, genuineRecord,
    )).toThrow(/LIVE_ORPHAN_RESOLUTION_INVALID/);
    expect(() => new (OrphanAmbiguityResolutionRequest as unknown as new (issuer: unknown, record: unknown) => unknown)(
      null, genuineRecord,
    )).toThrow(/LIVE_ORPHAN_RESOLUTION_INVALID/);
  });

  it('a genuinely minted request round-trips through the reader exactly', () => {
    const request = mintOrphanAmbiguityResolutionRequest({
      accountId: genuineRecord.accountId,
      exchangeOrderId: genuineRecord.exchangeOrderId,
      expectedRevision: genuineRecord.expectedRevision,
      outcome: genuineRecord.outcome,
      resolvedBy: genuineRecord.resolvedBy,
    });
    expect(readOrphanAmbiguityResolutionRequest(request)).toEqual(genuineRecord);
  });
});
