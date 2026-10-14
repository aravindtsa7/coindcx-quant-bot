import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateCollectedCycle, type SynchronizationConfig, type SyncCycleResult, type SyncRecordView } from '../../../../../src/execution/live/practical-synchronization/engine';
import { writeNewJson } from '../../../../../scripts/sync-read-launch/report-sink';
import { redactCampaignOutput } from '../../../../../scripts/sync-read-launch/campaign-secrets';
import { createCoinDcxSyncReadAdapter } from '../../../../../src/integration/coindcx/live/sync-read-adapter';

// SYNTHETIC ONLY: injected evidence; no actual report, credential, provider client, network or runtime startup.
const SECRET = 'SYNTHETIC-REDACTION-CANARY', PRIVATE = 'SYNTHETIC-UNKNOWN-PRIVATE-FIELD';
const directories: string[] = [];
afterEach(() => { for (const d of directories.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const order = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ exchangeOrderId: 'SYNTHETIC-order', pair: 'B-SYNTH_USDT', side: 'BUY', venueStatus: 'open',
  orderedQuantity: '01.2300', filledQuantity: '0', remainingQuantity: '1.23', cancelledQuantity: '0', averageFillPrice: null,
  price: '002.500', wireOrderType: 'limit_order', leverage: '3', providerCreatedAtMs: 1000, providerEventTimeMs: 1100, clientOrderId: SECRET, ...extra });
const position = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ venuePositionId: 'SYNTHETIC-position', pair: 'B-SYNTH_USDT', signedQuantity: '-01.2300',
  averageEntryPrice: null, leverage: null, providerEventTimeMs: 1200, ...extra });
const transaction = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ category: 'FILL', fillId: null, parentExchangeOrderId: null, stage: null,
  amount: '01.2300', currency: null, providerEventTimeMs: null, ...extra });
const config: SynchronizationConfig = {
  mode: 'CUMULATIVE_STATE', scope: { accountId: 'SYNTHETIC-account', components: ['ORDERS', 'POSITIONS', 'TRANSACTIONS'], requiredAccounting: [], history: { kind: 'AVAILABLE_HISTORY' } },
  scanLimits: { ORDERS: { pageSize: 2, maxPages: 2 }, POSITIONS: { pageSize: 2, maxPages: 2 }, TRANSACTIONS: { pageSize: 2, maxPages: 2 } },
  thresholds: { maxEvidenceAgeMs: 10_000, maxTotalReadDurationMs: 10_000 }, maxCycles: 1,
  lineage: { kind: 'UNAVAILABLE', reason: 'SYNTHETIC no ownership evidence' },
  contracts: { tagContract: { confirmed: false }, venueGeneratedOrderTypes: null, venueGeneratedWalletStages: null, terminalShortPage: {} },
};
const stream = { connected: false, epoch: null, epochAtWindowStart: null, disconnectObservedSinceWindowStart: false, reconnectLatched: false,
  joinAcknowledgement: { kind: 'UNKNOWN' as const }, events: [], bufferedUnprocessedEvents: 0 };
function evaluate(pages: unknown[][][] = [[[order()], []], [[position()], []], [[transaction()], []]], startedAtMs = 2000): SyncCycleResult {
  const scans = pages.map(p => ({ kind: 'SCANNED', accountScope: { kind: 'CONFIRMED', accountId: 'SYNTHETIC-account' }, startedAtMs, endedAtMs: 2100, pages: p }));
  return evaluateCollectedCycle(config, 0, { start: stream, evaluation: stream, evaluatedAtMs: 2200, scans: [scans, scans] });
}
function readback<T>(value: T): T {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'SYNTHETIC-structured-evidence-')); directories.push(d);
  const file = path.join(d, 'synthetic.json'), redacted = redactCampaignOutput(value, [SECRET]);
  writeNewJson(file, redacted);
  const bytes = fs.readFileSync(file, 'utf8');
  expect(bytes).not.toContain(SECRET); expect(bytes).not.toContain(PRIVATE);
  expect(() => writeNewJson(file, redacted)).toThrow(); expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  const saved = JSON.parse(bytes) as T; expect(saved).toEqual(redacted); return saved;
}
const record = (cycle: SyncCycleResult, component: string): SyncRecordView => cycle.records.find(g => g.pass === 0 && g.component === component)!.records[0]!;

describe('M4 additive normalized observations: presence, allowlist, variants and legacy compatibility', () => {
  it('retains typed canonical values, explicit nulls and transaction fill-id absence without retaining arbitrary fields or numeric lexemes', () => {
    const cycle = readback(evaluate([[[order({ email: PRIVATE, raw: { secret: PRIVATE }, client_id: PRIVATE })], []], [[position()], []], [[transaction()], []]]));
    const observed = record(cycle, 'ORDERS').observationVariants![0]!.normalized;
    expect(observed.component).toBe('ORDERS');
    if (observed.component !== 'ORDERS') throw Error('SYNTHETIC expected ORDERS');
    expect(observed.fields).toEqual({ exchangeOrderId: 'SYNTHETIC-order', pair: 'B-SYNTH_USDT', side: 'BUY', venueStatus: 'open',
      orderedQuantity: '1.23', filledQuantity: '0', remainingQuantity: '1.23', cancelledQuantity: '0', averageFillPrice: null,
      price: '2.5', wireOrderType: 'limit_order', leverage: '3', providerCreatedAtMs: 1000, providerEventTimeMs: 1100, client_order_id: '[REDACTED]' });
    expect(observed.fieldPresence).toMatchObject({ averageFillPrice: 'NULL', price: 'PRESENT', client_order_id: 'PRESENT' });
    expect(observed.inputTimestamps.providerCreatedAtMs).toEqual({ presence: 'PRESENT', value: 1000 });
    expect(observed.fields).not.toHaveProperty('client_id'); expect(observed.fields).not.toHaveProperty('raw');
    expect(JSON.stringify(cycle)).not.toContain('01.2300'); expect(JSON.stringify(cycle)).not.toContain('002.500');
    const p = record(cycle, 'POSITIONS').observationVariants![0]!.normalized;
    expect(p.fields).toMatchObject({ signedQuantity: '-1.23', averageEntryPrice: null, leverage: null });
    expect(p.fieldPresence).toMatchObject({ averageEntryPrice: 'NULL', leverage: 'NULL' });
    const t = record(cycle, 'TRANSACTIONS');
    expect(t.identity).toBe('CONTENT_ONLY');
    expect(t.observationVariants![0]!.normalized.fields).toMatchObject({ fill_id_field: null, fill_id_value: null, amount: '1.23', providerEventTimeMs: null });
    expect(t.observationVariants![0]!.normalized.fieldPresence).toMatchObject({ fill_id_field: 'NULL', fill_id_value: 'NULL' });
    expect(t.observationVariants![0]!.normalized.inputTimestamps.providerEventTimeMs).toEqual({ presence: 'NULL' });
    expect(Object.values(cycle.assessment.grants).every(v => v === false)).toBe(true);
  });

  it('keeps identical and conflicting variants with every same-page/across-page location, without changing the first fingerprint', () => {
    const a = order(), b = order({ price: '3.5' });
    const cycle = readback(evaluate([[[a, a], [b, a]], [[position()], []], [[transaction()], []]]));
    const r = record(cycle, 'ORDERS');
    expect(r.occurrences).toHaveLength(4); expect(r.observationVariants).toHaveLength(2);
    expect(r.observationVariants![0]!.fingerprint).toBe(r.fingerprint);
    expect(r.observationVariants![0]!.occurrences).toEqual([{ page: 0, position: 0 }, { page: 0, position: 1 }, { page: 1, position: 1 }]);
    expect(r.observationVariants![1]!.occurrences).toEqual([{ page: 1, position: 0 }]);
    expect(r.observationVariants![1]!.normalized.fields).toMatchObject({ price: '3.5' });
    expect(cycle.reasons).toEqual(expect.arrayContaining(['CONFLICTING_DUPLICATE', 'PAGE_SHIFT_OBSERVED', 'OWNERSHIP_UNRESOLVED']));
    expect(r.ownership).toBe('UNRESOLVED');
  });

  it('distinguishes missing/null/invalid timestamp inputs even when legacy fingerprints agree, without inventing timestamps', () => {
    const missing = order(); delete missing['providerEventTimeMs'];
    const nil = order({ providerEventTimeMs: null }), invalid = order({ providerEventTimeMs: PRIVATE }), fractional = order({ providerEventTimeMs: 1100.5 });
    const undefinedTime = order({ providerEventTimeMs: undefined });
    for (const [input, presence] of [[missing, 'MISSING'], [nil, 'NULL'], [invalid, 'INVALID'], [fractional, 'INVALID'], [undefinedTime, 'INVALID']] as const) {
      const cycle = readback(evaluate([[[input], []], [[position()], []], [[transaction()], []]]));
      const observation = record(cycle, 'ORDERS').observationVariants![0]!.normalized;
      expect(observation.fields).toMatchObject({ providerCreatedAtMs: null, providerEventTimeMs: null });
      expect(observation.fieldPresence.providerEventTimeMs).toBe(presence);
      expect(observation.inputTimestamps).toEqual({ providerEventTimeMs: { presence }, providerCreatedAtMs: { presence: 'PRESENT', value: 1000 } });
      expect(cycle.assessment.reasons).toContain('RECORD_TIMESTAMPS_MISSING');
    }
    const cycle = readback(evaluate([[[missing, nil]], [[position()], []], [[transaction()], []]]));
    const variants = record(cycle, 'ORDERS').observationVariants!;
    expect(variants).toHaveLength(2); expect(variants[0]!.fingerprint).toBe(variants[1]!.fingerprint);
    expect(variants.map(v => v.normalized.fieldPresence.providerEventTimeMs)).toEqual(['MISSING', 'NULL']);
  });

  it('does not accept malformed records, fractional local clocks or over-limit page counts', () => {
    const bad = order(); delete bad['cancelledQuantity'];
    const malformed = readback(evaluate([[[bad, order()], []], [[position()], []], [[transaction()], []]]));
    expect(malformed.reasons).toContain('RECORD_MALFORMED');
    expect(malformed.records.find(g => g.component === 'ORDERS')!.records).toHaveLength(1);
    expect(record(malformed, 'ORDERS').observationVariants).toHaveLength(1);
    const fractional = readback(evaluate(undefined, 2000.5));
    expect(fractional.reasons).toContain('READ_FAILED'); expect(fractional.records).toHaveLength(0);
    const overLimit = readback(evaluate([[[order()], [], []], [[position()], []], [[transaction()], []]]));
    expect(overLimit.reasons).toContain('SCAN_LIMIT_VIOLATED');
    expect(overLimit.records.filter(g => g.component === 'ORDERS')).toHaveLength(0);
    const irregular = readback(evaluate([[[order(), order({ exchangeOrderId: 'SYNTHETIC-two' }), order({ exchangeOrderId: 'SYNTHETIC-three' })]], [[position()], []], [[transaction()], []]]));
    expect(irregular.reasons).toContain('IRREGULAR_PAGE'); expect(irregular.assessment.kind).toBe('NOT_CONVERGED');
    const irregularRows = irregular.records.find(g => g.pass === 0 && g.component === 'ORDERS')!.records;
    expect(irregularRows).toHaveLength(3);
    expect(irregularRows.reduce((n, r) => n + r.observationVariants!.length, 0)).toBe(3);
  });

  it('preserves unsupported transaction reads as explicit unsupported failures, with no substituted records or fill IDs', async () => {
    const adapter = createCoinDcxSyncReadAdapter({ client: {
      listInrFuturesOrders: async () => { throw Error('SYNTHETIC unexpected read'); }, listInrFuturesPositions: async () => { throw Error('SYNTHETIC unexpected read'); },
    }, accountProvenance: { kind: 'UNKNOWN' }, orderStatuses: ['open'], clock: { now: () => 2000 } })!;
    const response = readback(await adapter.scan({ binding: { accountId: 'SYNTHETIC-account', scopeId: 'SYNTHETIC-scope', cycle: 0, pass: 0, component: 'TRANSACTIONS', epoch: null, requestId: 'SYNTHETIC-request' },
      limits: { pageSize: 2, maxPages: 2 }, history: { kind: 'AVAILABLE_HISTORY' }, signal: new AbortController().signal }));
    expect(response).toMatchObject({ scan: { kind: 'FAILED' }, adapter: { support: 'UNSUPPORTED', unsupportedReason: 'CLIENT_ADAPTER_UNSUPPORTED',
      unsupportedScope: { transactionRecordObservation: 'NOT_IMPLEMENTED_BY_THIS_ADAPTER' } } });
    expect(response).not.toHaveProperty('observationVariants');
  });

  it('keeps old record views without the additive field valid and retains a supplied fake fill identity only when present', () => {
    const legacy: SyncRecordView = { key: 'order:SYNTHETIC-legacy', identity: 'EXCHANGE_ORDER_ID', fingerprint: 'SYNTHETIC-existing-comparison',
      ownership: 'UNRESOLVED', reason: 'OWNERSHIP_LINEAGE_UNAVAILABLE', occurrences: [{ page: 0, position: 0 }], anomalies: [] };
    expect(readback(legacy)).toEqual(legacy); expect(readback(legacy)).not.toHaveProperty('observationVariants');
    const cycle = readback(evaluate([[[order()], []], [[position()], []], [[transaction({ fillId: { field: 'id', value: 'SYNTHETIC-fill-id' } })], []]]));
    const r = record(cycle, 'TRANSACTIONS');
    expect(r.key).toBe('txn:fill:id:SYNTHETIC-fill-id'); expect(r.identity).toBe('PROVIDER_FILL_ID');
    expect(r.observationVariants![0]!.normalized.fields).toMatchObject({ fill_id_field: 'id', fill_id_value: 'SYNTHETIC-fill-id' });
    expect(r.observationVariants![0]!.normalized.fieldPresence).toMatchObject({ fill_id_field: 'PRESENT', fill_id_value: 'PRESENT' });
  });
});
