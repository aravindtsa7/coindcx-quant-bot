import { describe, expect, it } from 'vitest';
import {
  buildOfflineLineageDiagnostic,
  type LineageDiagnosticFindingCode,
  type LineageDiagnosticFindingRow,
  type LineageDiagnosticOrderRow,
  type OfflineLineageDiagnostic,
  type OfflineLineageDiagnosticInput,
  type OfflineLineageDiagnosticResult,
} from '../../../../src/execution/live/ownership-lineage-diagnostic';
import { isValidSynchronizationConfig, type SynchronizationConfig } from '../../../../src/execution/live/practical-synchronization/engine';
import type { LiveReconciliationFindingCode } from '../../../../src/execution/live/reconciliation/types';
import type { LiveDurableOrderRow } from '../../../../src/execution/live/repository';
import type { LiveOrderStateName } from '../../../../src/execution/live/types';

// Compile-time only. The repository's verified listing row satisfies the local order-row shape, and the local code
// list equals the persisted finding taxonomy. Type compatibility says nothing about the integrity of any database.
const REPOSITORY_ROW_FITS = (row: LiveDurableOrderRow): LineageDiagnosticOrderRow => row;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const TAXONOMY_PINNED: Same<LineageDiagnosticFindingCode, LiveReconciliationFindingCode> = true;
void REPOSITORY_ROW_FITS;
void TAXONOMY_PINNED;

// SYNTHETIC rows and statements only: test inputs, never account evidence, ownership evidence or provider settings.
const ACCOUNT = 'synthetic-account';
const FP = 'f0'.repeat(32);
const OTHER_FP = '0f'.repeat(32);
const CANARY = 'SYNTHETIC_CANARY_7Q';
const intent = (n: number): string => n.toString(16).padStart(64, '0');
const tag = (n: number): string => `p17-${n.toString(16).padStart(32, '0')}`;

function order(n: number, state: LiveOrderStateName, exchangeOrderId: string | null, overrides: Partial<LineageDiagnosticOrderRow> = {}): LineageDiagnosticOrderRow {
  return { intentId: intent(n), clientOrderId: tag(n), accountId: ACCOUNT, pair: 'B-BTC_USDT', state, exchangeOrderId,
    dispatchWireArmed: false, side: 'BUY', wireOrderType: 'limit_order', orderedQuantity: '0.50', price: '64000.5', leverage: '5', ...overrides };
}
function finding(code: string, intentId: string | null, exchangeOrderId: string | null): LineageDiagnosticFindingRow {
  return { accountId: ACCOUNT, intentId, exchangeOrderId, code };
}
function input(rows: Partial<OfflineLineageDiagnosticInput['rows']> = {}, statements: Partial<OfflineLineageDiagnosticInput['statements']> = {}): OfflineLineageDiagnosticInput {
  return {
    accountId: ACCOUNT,
    rows: { orders: [], findings: [], certificates: [], reconciliationState: { accountId: ACCOUNT, currentGeneration: 4, healthyGeneration: 3 }, ownershipShareCount: 0, ...rows },
    statements: { expectedProviderAccountFingerprint: FP, campaignExpectedProviderAccountFingerprint: FP, campaignAccountId: ACCOUNT,
      sourceCommit: 'c0'.repeat(20), migrationIdentity: { directories: ['20260920000000_phase17_live_execution'], lockSha256: 'ab'.repeat(32) },
      sourceCoverage: 'NOT_ATTESTED', ...statements },
  };
}
function ok(result: OfflineLineageDiagnosticResult): OfflineLineageDiagnostic {
  if (result.kind !== 'OFFLINE_LINEAGE_DIAGNOSTIC') throw new Error(`refused: ${result.reason}`);
  return result;
}
const refusal = (result: OfflineLineageDiagnosticResult): string => (result.kind === 'OFFLINE_LINEAGE_DIAGNOSTIC_REFUSED' ? result.reason : 'NOT_REFUSED');
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
function objects(value: unknown, out: object[] = []): object[] {
  if (typeof value === 'object' && value !== null) { out.push(value); Object.values(value).forEach((child) => objects(child, out)); }
  return out;
}
/** A row whose every field returns the given value on the first read and the canary on any later read. */
function readOnce<T extends object>(row: T): T {
  const reads = new Map<string, number>();
  return new Proxy(row, { get(target, key) {
    if (typeof key !== 'string') return Reflect.get(target, key);
    reads.set(key, (reads.get(key) ?? 0) + 1);
    return reads.get(key) === 1 ? Reflect.get(target, key) : CANARY;
  } });
}
const POLICY_EMPTY = {
  ownedOrderLineage: { status: 'EMPTY_BY_POLICY', decision: 'D4' },
  closedIntentTagLineage: { status: 'EMPTY_BY_POLICY', decision: 'D2' },
  ownedPositionLineage: { status: 'EMPTY_BY_POLICY', decision: 'D3' },
};

describe('offline ownership-lineage diagnostic: classification table (plan §3, D1-D4)', () => {
  it('classifies each durable row kind exactly and keeps every row with a reason', () => {
    const result = ok(buildOfflineLineageDiagnostic(input({
      orders: [
        order(1, 'ACKNOWLEDGED', 'ex-1'),
        order(2, 'FILLED', 'ex-2'),
        order(3, 'SUBMISSION_AMBIGUOUS', null),
        order(4, 'DISPATCH_RESERVED', null, { dispatchWireArmed: true, price: null, leverage: null }),
        order(5, 'CREATED', null),
        order(6, 'DISPATCH_RESERVED', null),
        order(7, 'REJECTED', null),
      ],
      findings: [finding('RECON_AMBIGUOUS_CREATE_RESOLVED_BY_CLIENT_ORDER_ID', intent(2), 'ex-2')],
      ownershipShareCount: 3,
    })));
    expect(result.diagnostics.excluded).toEqual([
      { intentId: intent(1), reasons: ['OWNED_ORDERS_DISABLED'], findingCodes: [], exchangeIdCorrelatedFindingCodes: [] },
      { intentId: intent(2), reasons: ['OWNED_ORDERS_DISABLED', 'RECONCILIATION_RESOLVED'], findingCodes: ['RECON_AMBIGUOUS_CREATE_RESOLVED_BY_CLIENT_ORDER_ID'],
        exchangeIdCorrelatedFindingCodes: [] },
    ]);
    expect(result.ambiguousCreateCandidates).toEqual({
      status: 'ENTRIES_FOUND', scope: 'SUPPLIED_SNAPSHOT_ONLY', accountWideAbsence: 'NOT_ESTABLISHED', evidenceUse: 'DIAGNOSTIC_ONLY',
      entries: [
        { intentId: intent(3), accountId: ACCOUNT, tag: tag(3), pair: 'B-BTC_USDT', side: 'BUY', orderedQuantity: '0.5', price: '64000.5', wireOrderType: 'limit_order', leverage: '5', findingCodes: [] },
        { intentId: intent(4), accountId: ACCOUNT, tag: tag(4), pair: 'B-BTC_USDT', side: 'BUY', orderedQuantity: '0.5', price: null, wireOrderType: 'limit_order', leverage: null, findingCodes: [] },
      ],
    });
    expect(result.diagnostics.omitted).toEqual([
      { intentId: intent(5), reason: 'CLAIM_RELEASED_UNSENT', findingCodes: [] },
      { intentId: intent(6), reason: 'RESERVATION_UNARMED', findingCodes: [] },
      { intentId: intent(7), reason: 'VENUE_REFUSED_WITHOUT_SNAPSHOT', findingCodes: [] },
    ]);
    expect(result.diagnostics.conflicts).toEqual([]);
    expect(result.diagnostics.ownershipShareCount).toBe(3);
    expect(result.policyEmpty).toEqual(POLICY_EMPTY);
    expect(result.correlationTagNamespace).toBe('p17-');
  });

  it('reports every other state without an exchange id as a conflict, never a candidate or an omission', () => {
    const states: LiveOrderStateName[] = ['ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'CANCELLED', 'RECONCILIATION_REQUIRED'];
    const result = ok(buildOfflineLineageDiagnostic(input({ orders: states.map((state, index) => order(index + 1, state, null)) })));
    expect(result.diagnostics.conflicts).toEqual(states.map((_, index) => ({ reason: 'UNEXPECTED_STATE_WITHOUT_EXCHANGE_ID', intentIds: [intent(index + 1)], findingCodes: [] })));
    expect(result.ambiguousCreateCandidates.entries).toEqual([]);
    expect(result.diagnostics.omitted).toEqual([]);
  });

  it('keeps all three policy-empty outputs fixed whatever the rows suggest', () => {
    const variants: OfflineLineageDiagnosticInput[] = [
      input(),
      input({ orders: [order(1, 'FILLED', 'ex-1'), order(2, 'CANCELLED', 'ex-2'), order(3, 'RECONCILIATION_REQUIRED', 'ex-3')], ownershipShareCount: 9 }),
      input({ orders: [order(1, 'ACKNOWLEDGED', 'ex-1')], findings: [finding('RECON_ORDER_VERIFIED_MATCH', intent(1), 'ex-1')],
        certificates: [{ accountId: ACCOUNT, providerAccountFingerprint: FP }] }, { sourceCoverage: 'ATTESTED' }),
      input({ orders: [order(1, 'FILLED', 'ex-1')], findings: [finding('RECON_AMBIGUOUS_CREATE_RESOLVED', intent(1), 'ex-1')] }),
    ];
    for (const variant of variants) {
      const result = ok(buildOfflineLineageDiagnostic(variant));
      expect(result.policyEmpty).toEqual(POLICY_EMPTY);
      for (const entry of objects(result)) {
        for (const key of ['ownedOrders', 'closedIntentTags', 'ownedPositions', 'ambiguousCreates', 'botTagNamespace']) expect(Object.keys(entry)).not.toContain(key);
      }
      expect(result).toMatchObject({ engineInput: 'NOT_PERMITTED', ownershipProof: 'NONE', use: 'OFFLINE_DIAGNOSTIC_ONLY' });
    }
  });
});

describe('offline ownership-lineage diagnostic: associations and conflicts', () => {
  it('keeps duplicate exchange ids, orphan findings and conflicting links as explicit conflicts', () => {
    const result = ok(buildOfflineLineageDiagnostic(input({
      orders: [order(1, 'ACKNOWLEDGED', 'ex-dup'), order(2, 'FILLED', 'ex-dup'), order(3, 'CANCELLED', 'ex-3'), order(4, 'ACKNOWLEDGED', 'ex-4')],
      findings: [
        finding('RECON_ORDER_STATE_CONFLICT', intent(9), 'ex-9'),
        finding('RECON_ORDER_STATE_CONFLICT', intent(3), 'ex-4'),
        finding('RECON_ORDER_STATE_CONFLICT', intent(4), 'ex-other'),
      ],
    })));
    expect(result.diagnostics.conflicts).toEqual([
      { reason: 'DUPLICATE_EXCHANGE_ORDER_ID', intentIds: [intent(1), intent(2)], findingCodes: [] },
      { reason: 'FINDING_EXCHANGE_ID_DIFFERS_FROM_ORDER', intentIds: [intent(4)], findingCodes: ['RECON_ORDER_STATE_CONFLICT'] },
      { reason: 'FINDING_EXCHANGE_ID_HELD_BY_OTHER_INTENT', intentIds: [intent(3), intent(4)], findingCodes: ['RECON_ORDER_STATE_CONFLICT'] },
      { reason: 'FINDING_INTENT_NOT_IN_SNAPSHOT', intentIds: [intent(9)], findingCodes: ['RECON_ORDER_STATE_CONFLICT'] },
    ]);
    expect(result.diagnostics.excluded.map((entry) => [entry.intentId, entry.findingCodes])).toEqual([
      [intent(1), []], [intent(2), []], [intent(3), ['RECON_ORDER_STATE_CONFLICT']], [intent(4), ['RECON_ORDER_STATE_CONFLICT']]]);
  });

  it('reports exchange-id-only findings as correlation and counts unlinked ones by code without ids', () => {
    const result = ok(buildOfflineLineageDiagnostic(input({
      orders: [order(1, 'ACKNOWLEDGED', 'ex-1'), order(2, 'SUBMISSION_AMBIGUOUS', null)],
      findings: [
        finding('RECON_ORPHAN_VENUE_ORDER', null, 'ex-1'),
        finding('RECON_ORPHAN_VENUE_ORDER', null, 'ex-unknown-a'),
        finding('RECON_ORPHAN_VENUE_ORDER', null, 'ex-unknown-b'),
        finding('RECON_AMBIGUOUS_CREATE_MULTIPLE_CANDIDATES', intent(2), 'ex-candidate'),
      ],
    })));
    expect(result.diagnostics.excluded).toEqual([{ intentId: intent(1), reasons: ['OWNED_ORDERS_DISABLED'], findingCodes: [],
      exchangeIdCorrelatedFindingCodes: ['RECON_ORPHAN_VENUE_ORDER'] }]);
    expect(result.diagnostics.unlinkedFindingCodes).toEqual([{ code: 'RECON_ORPHAN_VENUE_ORDER', count: 2 }]);
    expect(result.ambiguousCreateCandidates.entries.map((entry) => [entry.intentId, entry.findingCodes])).toEqual([[intent(2), ['RECON_AMBIGUOUS_CREATE_MULTIPLE_CANDIDATES']]]);
    expect(result.diagnostics.conflicts).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/ex-(1|unknown|candidate)/);
  });

  it('never classifies an order as reconciliation-resolved from exchange-id correlation alone', () => {
    const result = ok(buildOfflineLineageDiagnostic(input({
      orders: [order(1, 'FILLED', 'ex-1')],
      findings: [finding('RECON_AMBIGUOUS_CREATE_RESOLVED', null, 'ex-1')],
    })));
    expect(result.diagnostics.excluded).toEqual([{ intentId: intent(1), reasons: ['OWNED_ORDERS_DISABLED'], findingCodes: [],
      exchangeIdCorrelatedFindingCodes: ['RECON_AMBIGUOUS_CREATE_RESOLVED'] }]);
  });

  it('never turns a resolution finding on a null-id order into a candidate (D1)', () => {
    const result = ok(buildOfflineLineageDiagnostic(input({
      orders: [order(1, 'SUBMISSION_AMBIGUOUS', null), order(2, 'DISPATCH_RESERVED', null, { dispatchWireArmed: true })],
      findings: [finding('RECON_AMBIGUOUS_CREATE_RESOLVED', intent(1), 'ex-1'), finding('RECON_AMBIGUOUS_CREATE_RESOLVED_BY_CLIENT_ORDER_ID', intent(2), null)],
    })));
    expect(result.ambiguousCreateCandidates).toMatchObject({ status: 'NONE_FOUND_IN_SNAPSHOT', entries: [] });
    expect(result.diagnostics.conflicts).toEqual([
      { reason: 'RESOLUTION_FINDING_WITHOUT_EXCHANGE_ID', intentIds: [intent(1)], findingCodes: ['RECON_AMBIGUOUS_CREATE_RESOLVED'] },
      { reason: 'RESOLUTION_FINDING_WITHOUT_EXCHANGE_ID', intentIds: [intent(2)], findingCodes: ['RECON_AMBIGUOUS_CREATE_RESOLVED_BY_CLIENT_ORDER_ID'] },
    ]);
  });

  it('infers nothing from a missing finding: an id-bearing order without findings is excluded, never owned', () => {
    const result = ok(buildOfflineLineageDiagnostic(input({ orders: [order(1, 'FILLED', 'ex-1')] })));
    expect(result.diagnostics.excluded).toEqual([{ intentId: intent(1), reasons: ['OWNED_ORDERS_DISABLED'], findingCodes: [], exchangeIdCorrelatedFindingCodes: [] }]);
    expect(JSON.stringify(result)).not.toMatch(/OWNED"|BOT_CREATE_RESPONSE|CREATE_RESPONSE_BY_ELIMINATION/);
  });
});

describe('offline ownership-lineage diagnostic: integrity refusals (no partial success)', () => {
  const cases: [string, OfflineLineageDiagnosticInput | unknown, string][] = [
    ['duplicate intent id', input({ orders: [order(1, 'FILLED', 'ex-1'), order(1, 'CANCELLED', 'ex-2', { clientOrderId: tag(2) })] }), 'DUPLICATE_INTENT_ID'],
    ['duplicate client order id', input({ orders: [order(1, 'FILLED', 'ex-1'), order(2, 'FILLED', 'ex-2', { clientOrderId: tag(1) })] }), 'DUPLICATE_CLIENT_ORDER_ID'],
    ['wire arm outside a reservation', input({ orders: [order(1, 'SUBMISSION_AMBIGUOUS', null, { dispatchWireArmed: true })] }), 'WIRE_ARM_STATE_CONTRADICTION'],
    ['unknown state', input({ orders: [order(1, 'OPEN' as LiveOrderStateName, null)] }), 'ORDER_ROW_INVALID'],
    ['tag outside the Phase 17 client order id format', input({ orders: [order(1, 'SUBMISSION_AMBIGUOUS', null, { clientOrderId: 'bot-0001' })] }), 'ORDER_ROW_INVALID'],
    ['non-decimal quantity', input({ orders: [order(1, 'SUBMISSION_AMBIGUOUS', null, { orderedQuantity: '1e3' })] }), 'ORDER_ROW_INVALID'],
    ['non-positive quantity', input({ orders: [order(1, 'SUBMISSION_AMBIGUOUS', null, { orderedQuantity: '0' })] }), 'ORDER_ROW_INVALID'],
    ['non-positive price', input({ orders: [order(1, 'SUBMISSION_AMBIGUOUS', null, { price: '-1' })] }), 'ORDER_ROW_INVALID'],
    ['empty exchange id', input({ orders: [order(1, 'FILLED', '')] }), 'ORDER_ROW_INVALID'],
    ['order of another account', input({ orders: [order(1, 'FILLED', 'ex-1', { accountId: 'other-account' })] }), 'ROW_ACCOUNT_SCOPE_VIOLATION'],
    ['finding of another account', input({ findings: [{ ...finding('RECON_ORDER_VERIFIED_MATCH', intent(1), null), accountId: 'other-account' }] }), 'ROW_ACCOUNT_SCOPE_VIOLATION'],
    ['certificate of another account', input({ certificates: [{ accountId: 'other-account', providerAccountFingerprint: FP }] }), 'ROW_ACCOUNT_SCOPE_VIOLATION'],
    ['state of another account', input({ reconciliationState: { accountId: 'other-account', currentGeneration: 1, healthyGeneration: null } }), 'ROW_ACCOUNT_SCOPE_VIOLATION'],
    ['negative generation', input({ reconciliationState: { accountId: ACCOUNT, currentGeneration: -1, healthyGeneration: null } }), 'INPUT_INVALID'],
    ['finding naming nothing', input({ findings: [finding('RECON_ORDER_VERIFIED_MATCH', null, null)] }), 'FINDING_ROW_INVALID'],
    ['finding with a free-text code', input({ findings: [finding('recon x', intent(1), null)] }), 'FINDING_ROW_INVALID'],
    ['malformed certificate', input({ certificates: [{ accountId: ACCOUNT, providerAccountFingerprint: 'F0'.repeat(32) }] }), 'CERTIFICATE_ROW_INVALID'],
    ['certificates not a list', input({ certificates: {} as never }), 'INPUT_INVALID'],
    ['unknown coverage statement', input({}, { sourceCoverage: 'PROVEN' as never }), 'INPUT_INVALID'],
    ['missing statements', { accountId: ACCOUNT, rows: input().rows }, 'INPUT_INVALID'],
    ['invalid share count', input({ ownershipShareCount: -1 }), 'INPUT_INVALID'],
    ['throwing getter', { ...input(), rows: Object.defineProperty({ ...input().rows }, 'orders', { get() { throw new Error(CANARY); } }) }, 'INPUT_INVALID'],
  ];
  it.each(cases)('refuses on %s with a fixed reason and nothing else', (_name, value, reason) => {
    const result = buildOfflineLineageDiagnostic(value as OfflineLineageDiagnosticInput);
    expect(result).toEqual({ kind: 'OFFLINE_LINEAGE_DIAGNOSTIC_REFUSED', reason });
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe('offline ownership-lineage diagnostic: account and fingerprint bindings', () => {
  it('refuses disagreeing statements, a mismatching or conflicting certificate and a mismatched account label', () => {
    expect(refusal(buildOfflineLineageDiagnostic(input({}, { campaignExpectedProviderAccountFingerprint: OTHER_FP })))).toBe('FINGERPRINT_STATEMENTS_DISAGREE');
    // Same 12-character prefix, different full value: the full fingerprint is compared before any prefix is emitted.
    const samePrefix = `${FP.slice(0, 12)}${'1'.repeat(52)}`;
    expect(refusal(buildOfflineLineageDiagnostic(input({}, { campaignExpectedProviderAccountFingerprint: samePrefix })))).toBe('FINGERPRINT_STATEMENTS_DISAGREE');
    expect(refusal(buildOfflineLineageDiagnostic(input({ certificates: [{ accountId: ACCOUNT, providerAccountFingerprint: samePrefix }] })))).toBe('CERTIFICATE_FINGERPRINT_MISMATCH');
    expect(refusal(buildOfflineLineageDiagnostic(input({ certificates: [
      { accountId: ACCOUNT, providerAccountFingerprint: FP }, { accountId: ACCOUNT, providerAccountFingerprint: OTHER_FP }] })))).toBe('CERTIFICATE_FINGERPRINT_MISMATCH');
    expect(refusal(buildOfflineLineageDiagnostic(input({}, { campaignAccountId: 'other-account' })))).toBe('ACCOUNT_LABEL_STATEMENT_MISMATCH');
  });

  it('labels agreement of two statements as binding nothing, and absent certificates as statement-only', () => {
    const absent = ok(buildOfflineLineageDiagnostic(input()));
    expect(absent.provenance.checkedOnSuppliedRows.certificateBinding).toBe('NO_CERTIFICATE_ROWS_STATEMENT_ONLY');
    expect(absent.provenance.callerStatements.fingerprintStatements).toBe('STATEMENTS_AGREE_BINDS_NOTHING');
    const present = ok(buildOfflineLineageDiagnostic(input({ certificates: [{ accountId: ACCOUNT, providerAccountFingerprint: FP }] })));
    expect(present.provenance.checkedOnSuppliedRows.certificateBinding).toBe('SUPPLIED_CERTIFICATE_ROWS_MATCH_STATEMENT');
    expect(present.provenance.callerStatements.expectedFingerprintPrefix).toBe(FP.slice(0, 12));
    expect(present.provenance.notEstablished).toEqual(expect.arrayContaining(['SOURCE_COVERAGE', 'ORDER_TIME_ACCOUNT_IDENTITY', 'CREATE_RESPONSE_PROVENANCE']));
    expect(JSON.stringify(present)).not.toContain(FP);
  });
});

describe('offline ownership-lineage diagnostic: provenance and snapshot-only absence', () => {
  it('reports absence for the supplied snapshot only, even with an attested coverage statement', () => {
    const result = ok(buildOfflineLineageDiagnostic(input({ reconciliationState: null }, { sourceCoverage: 'ATTESTED' })));
    expect(result.ambiguousCreateCandidates).toEqual({ status: 'NONE_FOUND_IN_SNAPSHOT', scope: 'SUPPLIED_SNAPSHOT_ONLY',
      accountWideAbsence: 'NOT_ESTABLISHED', evidenceUse: 'DIAGNOSTIC_ONLY', entries: [] });
    expect(result.provenance.callerStatements.sourceCoverage).toBe('ATTESTED_BY_OPERATOR_UNVERIFIED');
    expect(result.provenance.checkedOnSuppliedRows.reconciliationGenerations).toBe('NO_STATE_ROW_SUPPLIED');
    expect(result.provenance.notEstablished).toEqual(['TRANSACTION_CONSISTENCY', 'SNAPSHOT_ISOLATION_AND_TIME', 'INTENT_CONTENT_HASH_INTEGRITY',
      'DATABASE_IDENTITY', 'DATABASE_APPLIED_MIGRATIONS', 'SOURCE_COVERAGE', 'ORDER_TIME_ACCOUNT_IDENTITY', 'CREATE_RESPONSE_PROVENANCE', 'ACCOUNT_WIDE_ABSENCE']);
  });

  it('keeps supplied commit and migration identity as caller statements, separate from checks on supplied rows', () => {
    const result = ok(buildOfflineLineageDiagnostic(input({ orders: [order(1, 'FILLED', 'ex-1')], findings: [finding('RECON_ORDER_VERIFIED_MATCH', intent(1), 'ex-1')] })));
    expect(result.provenance.callerStatements).toMatchObject({ sourceCommit: 'c0'.repeat(20),
      migrationIdentity: { directories: ['20260920000000_phase17_live_execution'], lockSha256: 'ab'.repeat(32) } });
    expect(result.provenance.checkedOnSuppliedRows).toMatchObject({ rowCounts: { orders: 1, findings: 1, certificates: 0, ownershipShares: 0 },
      reconciliationGenerations: { current: 4, healthy: 3 }, accountLabel: 'SUPPLIED_ROWS_MATCH_CAMPAIGN_STATEMENT' });
    expect(Object.keys(result.provenance.checkedOnSuppliedRows)).not.toContain('sourceCommit');
  });
});

describe('offline ownership-lineage diagnostic: privacy, immutability and determinism', () => {
  it('copies only allowlisted fields: extra row fields never reach the result', () => {
    const extra = { strategyId: CANARY, evidenceJson: CANARY, note: CANARY, apiSecret: CANARY, cumulativeFilledQuantity: CANARY, averageFillPrice: CANARY };
    const result = ok(buildOfflineLineageDiagnostic(input({
      orders: [{ ...order(1, 'SUBMISSION_AMBIGUOUS', null), ...extra } as LineageDiagnosticOrderRow, { ...order(2, 'FILLED', 'ex-2'), ...extra } as LineageDiagnosticOrderRow],
      findings: [{ ...finding('RECON_ORDER_VERIFIED_MATCH', intent(2), 'ex-2'), ...extra } as LineageDiagnosticFindingRow],
      certificates: [{ accountId: ACCOUNT, providerAccountFingerprint: FP, ...extra } as never],
    })));
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(JSON.stringify(result)).not.toContain('ex-2');
  });

  it('reports a well-formed code outside the taxonomy as UNRECOGNIZED_FINDING_CODE, never echoing it', () => {
    const result = ok(buildOfflineLineageDiagnostic(input({
      orders: [order(1, 'FILLED', 'ex-1'), order(2, 'SUBMISSION_AMBIGUOUS', null)],
      findings: [finding(CANARY, intent(1), 'ex-1'), finding(CANARY, null, 'ex-1'), finding(CANARY, intent(2), null), finding(CANARY, null, 'ex-9'), finding(CANARY, intent(7), null)],
    })));
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(result.diagnostics.excluded[0]).toMatchObject({ findingCodes: ['UNRECOGNIZED_FINDING_CODE'], exchangeIdCorrelatedFindingCodes: ['UNRECOGNIZED_FINDING_CODE'] });
    expect(result.ambiguousCreateCandidates.entries[0]?.findingCodes).toEqual(['UNRECOGNIZED_FINDING_CODE']);
    expect(result.diagnostics.unlinkedFindingCodes).toEqual([{ code: 'UNRECOGNIZED_FINDING_CODE', count: 1 }]);
    expect(result.diagnostics.conflicts).toEqual([{ reason: 'FINDING_INTENT_NOT_IN_SNAPSHOT', intentIds: [intent(7)], findingCodes: ['UNRECOGNIZED_FINDING_CODE'] }]);
  });

  it('reads each supplied field once, so a value cannot change between validation and use', () => {
    const result = ok(buildOfflineLineageDiagnostic(readOnce({
      ...input({
        orders: [readOnce(order(1, 'SUBMISSION_AMBIGUOUS', null))],
        findings: [readOnce(finding('RECON_AMBIGUOUS_CREATE_UNRESOLVED', intent(1), null))],
        certificates: [readOnce({ accountId: ACCOUNT, providerAccountFingerprint: FP })],
      }),
    })));
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(result.ambiguousCreateCandidates.entries.map((entry) => [entry.tag, entry.findingCodes])).toEqual([[tag(1), ['RECON_AMBIGUOUS_CREATE_UNRESOLVED']]]);
  });

  it('never echoes a rejected value in a refusal', () => {
    for (const value of [
      input({ orders: [order(1, 'FILLED', `ex ${CANARY}`)] }),
      input({ findings: [finding(`RECON_${CANARY.toLowerCase()}`, intent(1), null)] }),
      input({ orders: [order(1, 'FILLED', 'ex-1', { accountId: CANARY })] }),
      input({ orders: [order(1, 'FILLED', 'ex-1', { clientOrderId: CANARY })] }),
      input({}, { sourceCommit: CANARY }),
      input({ orders: [order(1, 'SUBMISSION_AMBIGUOUS', null, { orderedQuantity: CANARY })] }),
    ]) {
      const result = buildOfflineLineageDiagnostic(value);
      expect(result.kind).toBe('OFFLINE_LINEAGE_DIAGNOSTIC_REFUSED');
      expect(JSON.stringify(result).toLowerCase()).not.toContain(CANARY.toLowerCase());
    }
  });

  it('does not mutate frozen inputs, returns a deeply frozen result and is independent of row order', () => {
    const rows = {
      orders: [order(3, 'SUBMISSION_AMBIGUOUS', null), order(1, 'FILLED', 'ex-1'), order(2, 'CREATED', null), order(4, 'ACKNOWLEDGED', 'ex-1')],
      findings: [finding('RECON_ORPHAN_VENUE_ORDER', null, 'ex-z'), finding('RECON_EVIDENCE_INCOMPLETE', null, 'ex-y'),
        finding('RECON_ORDER_STATE_CONFLICT', intent(8), null), finding('RECON_ORPHAN_VENUE_ORDER', null, 'ex-1')],
    };
    const frozen = deepFreeze(input(rows));
    const before = JSON.stringify(frozen);
    const first = ok(buildOfflineLineageDiagnostic(frozen));
    expect(JSON.stringify(frozen)).toBe(before);
    expect(objects(first).every((entry) => Object.isFrozen(entry))).toBe(true);
    const reversed = ok(buildOfflineLineageDiagnostic(input({ orders: [...rows.orders].reverse(), findings: [...rows.findings].reverse() })));
    expect(reversed).toEqual(first);
    expect(reversed.recordSha256).toBe(first.recordSha256);
    expect(first.recordSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.diagnostics.unlinkedFindingCodes).toEqual([{ code: 'RECON_EVIDENCE_INCOMPLETE', count: 1 }, { code: 'RECON_ORPHAN_VENUE_ORDER', count: 1 }]);
    const changed = ok(buildOfflineLineageDiagnostic(input({ ...rows, ownershipShareCount: 1 })));
    expect(changed.recordSha256).not.toBe(first.recordSha256);
  });
});

describe('offline ownership-lineage diagnostic: separation from SyncLineage', () => {
  const config = (lineage: unknown): unknown => ({
    mode: 'FULL_EVIDENCE',
    scope: { accountId: ACCOUNT, components: ['ORDERS'], requiredAccounting: [], history: { kind: 'AVAILABLE_HISTORY' } },
    scanLimits: { ORDERS: { pageSize: 2, maxPages: 3 } },
    thresholds: { maxEvidenceAgeMs: 5_000, maxTotalReadDurationMs: 2_000 },
    maxCycles: 1,
    lineage,
    contracts: { tagContract: { confirmed: false }, venueGeneratedOrderTypes: null, venueGeneratedWalletStages: null, terminalShortPage: {} },
  } satisfies Record<keyof SynchronizationConfig, unknown>);

  it('is rejected by the engine as a lineage input, whole or in any part, while UNAVAILABLE stays valid', () => {
    expect(isValidSynchronizationConfig(config({ kind: 'UNAVAILABLE', reason: 'SYNTHETIC_NOT_SUPPLIED' }))).toBe(true);
    const diagnostic = ok(buildOfflineLineageDiagnostic(input({ orders: [order(1, 'SUBMISSION_AMBIGUOUS', null), order(2, 'FILLED', 'ex-2')] })));
    const refused = buildOfflineLineageDiagnostic(input({ ownershipShareCount: -1 }));
    for (const candidate of [...objects(diagnostic), refused]) expect(isValidSynchronizationConfig(config(candidate))).toBe(false);
  });
});
