import { describe, expect, it } from 'vitest';
import {
  classifyPracticalCancelBinding,
  currentPracticalCancelBinding,
  parsePracticalCancelBindingRow,
  type LivePracticalCancelBindingView,
} from '../../../../src/execution/live/practical-cancel-binding';

// [P18B Stage 1B2 Wave 2B2a] The Phase17/18 view of an order-bound practical CANCEL lease: exact identity
// re-proof (the schema collation is case-insensitive and pad-space), a closed row shape, and ONE shared
// classification used by both the Phase18 planner and the Phase17 public-write guard.

const EXPECTED = Object.freeze({
  accountId: 'acct-2b2a',
  intentId: `${'0'.repeat(60)}beef`,
  clientOrderId: `p17-${'0'.repeat(28)}beef`,
  cancelGeneration: 3,
});

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    leaseId: '2b1d7a5e-6f0c-4c1a-9d1e-1234567890ab',
    accountId: EXPECTED.accountId,
    intentId: EXPECTED.intentId,
    clientOrderId: EXPECTED.clientOrderId,
    cancelGeneration: EXPECTED.cancelGeneration,
    status: 'LEASED',
    outcome: null,
    armedAtMs: null,
    ...overrides,
  };
}

const INTEGRITY = /LIVE_DURABLE_INTEGRITY_VIOLATION|contradict|exactly|malformed|unexpected|not a|unknown|valid|other than|More than one/;

function expectIntegrity(action: () => unknown): void {
  expect(action).toThrow(expect.objectContaining({ code: 'LIVE_DURABLE_INTEGRITY_VIOLATION' }));
}

describe('parsePracticalCancelBindingRow: exact identity, closed shape', () => {
  it('parses a LEASED unarmed, a LEASED armed (bigint), and COMPLETED rows into frozen exact views', () => {
    const leased = parsePracticalCancelBindingRow(row(), EXPECTED);
    expect(leased).toEqual({ ...row(), cancelGeneration: 3, armedAtMs: null });
    expect(Object.isFrozen(leased)).toBe(true);
    expect(parsePracticalCancelBindingRow(row({ armedAtMs: 1_700_000_001_000n }), EXPECTED).armedAtMs).toBe(1_700_000_001_000);
    expect(parsePracticalCancelBindingRow(row({ status: 'COMPLETED', outcome: 'AMBIGUOUS', armedAtMs: 5n }), EXPECTED)).toMatchObject({ status: 'COMPLETED', outcome: 'AMBIGUOUS', armedAtMs: 5 });
    expect(parsePracticalCancelBindingRow(row({ status: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' }), EXPECTED)).toMatchObject({ outcome: 'PRE_DISPATCH_FAILURE', armedAtMs: null });
    expect(parsePracticalCancelBindingRow(row({ cancelGeneration: 3n }), EXPECTED).cancelGeneration).toBe(3);
  });

  it.each([
    ['account differs only by case', { accountId: EXPECTED.accountId.toUpperCase() }],
    ['account differs only by trailing pad space', { accountId: `${EXPECTED.accountId} ` }],
    ['intent differs only by case', { intentId: EXPECTED.intentId.toUpperCase() }],
    ['intent differs only by trailing pad space', { intentId: `${EXPECTED.intentId} ` }],
    ['client order id differs only by case', { clientOrderId: EXPECTED.clientOrderId.toUpperCase() }],
    ['client order id differs only by trailing pad space', { clientOrderId: `${EXPECTED.clientOrderId} ` }],
    ['a different generation', { cancelGeneration: 2 }],
    ['generation zero', { cancelGeneration: 0 }],
    ['a non-integer generation', { cancelGeneration: 3.5 }],
    ['a string generation', { cancelGeneration: '3' }],
    ['an unknown status', { status: 'RELEASED' }],
    ['a lowercase status', { status: 'leased' }],
    ['DUPLICATE_CLIENT_ORDER_ID (never valid for a bound CANCEL)', { status: 'COMPLETED', outcome: 'DUPLICATE_CLIENT_ORDER_ID', armedAtMs: 1n }],
    ['an unknown outcome', { status: 'COMPLETED', outcome: 'CANCELLED', armedAtMs: 1n }],
    ['LEASED with an outcome', { outcome: 'AMBIGUOUS', armedAtMs: 1n }],
    ['COMPLETED without an outcome', { status: 'COMPLETED' }],
    ['an UNARMED AMBIGUOUS completion', { status: 'COMPLETED', outcome: 'AMBIGUOUS' }],
    ['an UNARMED REJECTED completion', { status: 'COMPLETED', outcome: 'REJECTED' }],
    ['a negative arm time', { armedAtMs: -1n }],
    ['an arm time beyond safe integers', { armedAtMs: BigInt(Number.MAX_SAFE_INTEGER) + 1n }],
    ['a string arm time', { armedAtMs: '5' }],
    ['a lease id with whitespace', { leaseId: 'lease id' }],
    ['an empty lease id', { leaseId: '' }],
    ['an over-long lease id', { leaseId: 'x'.repeat(65) }],
  ])('refuses %s as a durable integrity violation', (_label, overrides) => {
    expectIntegrity(() => parsePracticalCancelBindingRow(row(overrides), EXPECTED));
  });

  it('refuses a row with a missing or an extra column, and a non-record', () => {
    const { outcome: _omitted, ...missing } = row();
    expectIntegrity(() => parsePracticalCancelBindingRow(missing, EXPECTED));
    expectIntegrity(() => parsePracticalCancelBindingRow({ ...row(), certificateId: 'c' }, EXPECTED));
    for (const value of [null, undefined, 'row', 1, [row()]]) expectIntegrity(() => parsePracticalCancelBindingRow(value, EXPECTED));
    expect(() => parsePracticalCancelBindingRow(null, EXPECTED)).toThrow(INTEGRITY);
  });
});

describe('currentPracticalCancelBinding: none or exactly one', () => {
  it('returns null for no row, the parsed view for one, and refuses more than one', () => {
    expect(currentPracticalCancelBinding([], EXPECTED)).toBeNull();
    expect(currentPracticalCancelBinding([row()], EXPECTED)).toMatchObject({ status: 'LEASED' });
    expectIntegrity(() => currentPracticalCancelBinding([row(), row({ leaseId: 'other-lease' })], EXPECTED));
    expectIntegrity(() => currentPracticalCancelBinding('rows' as unknown as unknown[], EXPECTED));
  });
});

describe('classifyPracticalCancelBinding: the single planner/guard table', () => {
  const view = (overrides: Partial<LivePracticalCancelBindingView>): LivePracticalCancelBindingView => ({
    ...(parsePracticalCancelBindingRow(row(), EXPECTED)), ...overrides,
  });

  it('no binding is UNBOUND whatever the claim says', () => {
    for (const state of ['NONE', 'CANCEL_RESERVED', 'CANCEL_AMBIGUOUS', 'CANCEL_ACKNOWLEDGED', 'CANCEL_REJECTED']) {
      expect(classifyPracticalCancelBinding(null, state)).toBe('UNBOUND');
    }
  });

  it('a LEASED binding (unarmed or armed) always protects the claim', () => {
    for (const state of ['NONE', 'CANCEL_RESERVED', 'CANCEL_AMBIGUOUS', 'CANCEL_ACKNOWLEDGED', 'CANCEL_REJECTED']) {
      expect(classifyPracticalCancelBinding(view({ status: 'LEASED' }), state)).toBe('LEASED');
      expect(classifyPracticalCancelBinding(view({ status: 'LEASED', armedAtMs: 9 }), state)).toBe('LEASED');
    }
  });

  it('only COMPLETED PRE_DISPATCH_FAILURE with a NONE claim is HISTORICAL (ordinary Phase18 may proceed)', () => {
    const preDispatch = view({ status: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(classifyPracticalCancelBinding(preDispatch, 'NONE')).toBe('HISTORICAL');
    expect(classifyPracticalCancelBinding({ ...preDispatch, armedAtMs: 9 }, 'NONE')).toBe('HISTORICAL');
    for (const state of ['CANCEL_RESERVED', 'CANCEL_AMBIGUOUS', 'CANCEL_ACKNOWLEDGED', 'CANCEL_REJECTED']) {
      expect(classifyPracticalCancelBinding(preDispatch, state)).toBe('SPLIT');
    }
  });

  it('COMPLETED AMBIGUOUS with CANCEL_AMBIGUOUS is sticky; every other AMBIGUOUS pairing is SPLIT', () => {
    const ambiguous = view({ status: 'COMPLETED', outcome: 'AMBIGUOUS', armedAtMs: 9 });
    expect(classifyPracticalCancelBinding(ambiguous, 'CANCEL_AMBIGUOUS')).toBe('PRACTICAL_AMBIGUITY_UNRESOLVED');
    for (const state of ['NONE', 'CANCEL_RESERVED', 'CANCEL_ACKNOWLEDGED', 'CANCEL_REJECTED']) {
      expect(classifyPracticalCancelBinding(ambiguous, state)).toBe('SPLIT');
    }
  });

  it('only exact armed accepted/acknowledged and rejected/rejected completions are historical', () => {
    for (const outcome of ['ACCEPTED', 'REJECTED'] as const) {
      for (const state of ['NONE', 'CANCEL_RESERVED', 'CANCEL_AMBIGUOUS', 'CANCEL_ACKNOWLEDGED', 'CANCEL_REJECTED']) {
        expect(classifyPracticalCancelBinding(view({ status: 'COMPLETED', outcome, armedAtMs: 9 }), state)).toBe((outcome === 'ACCEPTED' && state === 'CANCEL_ACKNOWLEDGED') || (outcome === 'REJECTED' && state === 'CANCEL_REJECTED') ? 'HISTORICAL' : 'SPLIT');
      }
    }
  });
});
