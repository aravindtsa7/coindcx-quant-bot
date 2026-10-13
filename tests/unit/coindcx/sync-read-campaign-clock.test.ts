import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { campaignObservationClock } from '../../../scripts/sync-read-launch/campaign-host';
import { runPreparedCollection, type LaunchProposal } from '../../../scripts/sync-read-launch/proposal';
import { normalizeOrder, normalizePosition } from '../../../src/integration/coindcx/normalizers';
import { FuturesOrderWireSchema, FuturesPositionWireSchema } from '../../../src/integration/coindcx/schemas';
import { providerAccountFingerprint, verifyProviderAccountIdentity } from '../../../src/execution/live/reconciliation/account-identity';
import type { AsyncClock } from '../../../src/execution/live/practical-synchronization/async-orchestrator';
import type { SyncCampaignReadClient, SyncReadCampaignReport } from '../../../src/integration/coindcx/live/sync-read-campaign';

// SYNTHETIC ONLY: normalized committed models and an in-memory read client. No HTTP, credentials or coordinator start.
const ACCOUNT = 'SYNTHETIC-OFFLINE-ACCOUNT', IDENTIFIER = 'SYNTHETIC-OFFLINE-IDENTITY';
afterEach(() => vi.restoreAllMocks());
function order(side: 'buy' | 'sell', index: number, malformed: boolean) {
  return normalizeOrder(FuturesOrderWireSchema.parse({ id: `SYNTHETIC-${side}-${index}`, pair: 'B-BTC_USDT', side,
    status: 'open', order_type: 'limit_order', leverage: '5', price: '64000.5', avg_price: null,
    total_quantity: '0.5', remaining_quantity: '0.5', cancelled_quantity: malformed ? null : '0',
    margin_currency_short_name: 'INR', created_at: 1000, updated_at: 1500, client_order_id: null }));
}
function position(index: number) {
  return normalizePosition(FuturesPositionWireSchema.parse({ id: `SYNTHETIC-position-${index}`, pair: 'B-BTC_USDT',
    active_pos: index % 2 === 0 ? '0.5' : '-0.5', avg_price: '64000.5', locked_margin: '1100', locked_user_margin: '1000',
    locked_order_margin: '100', maintenance_margin: '50', mark_price: '64100', margin_type: 'isolated',
    settlement_currency_avg_price: '89.5', margin_currency_short_name: 'INR', leverage: '5', updated_at: 1600 }));
}
async function pipeline(options: { malformed?: boolean; rawFractionalClock?: boolean; adapterFailure?: boolean; repeatRow?: boolean } = {}) {
  const template = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/launch/m4-collection-input.pending.json'), 'utf8')) as { proposal: LaunchProposal };
  const proposal = structuredClone(template.proposal);
  proposal.configuration.account = { accountId: ACCOUNT, expectedProviderAccountFingerprint: providerAccountFingerprint(IDENTIFIER) };
  proposal.configuration.budget.connectionId = 'SYNTHETIC-OFFLINE-BUDGET';
  proposal.configuration.lineage = { kind: 'UNAVAILABLE', reason: 'SYNTHETIC fixture supplies no ownership lineage' };
  proposal.configuration.reportDestination.path = 'C:\\SYNTHETIC-ONLY\\not-written.json';
  let rawTime = 28457.5301;
  vi.spyOn(performance, 'now').mockImplementation(() => { rawTime += 0.125; return rawTime; });
  const clock: AsyncClock = { now: options.rawFractionalClock ? () => rawTime += 0.125 : campaignObservationClock.now,
    delay(ms, signal) {
      if (ms === proposal.configuration.campaign.evaluationIntervalMs) { rawTime += ms; return Promise.resolve(); }
      return campaignObservationClock.delay(ms, signal);
    } };
  const calls: Array<{ endpoint: string; side?: string; page?: string; size?: string; status?: string }> = [];
  const client: SyncCampaignReadClient = {
    async getUserInfoSafe() { calls.push({ endpoint: 'IDENTITY' }); return { authenticated: true, coindcxId: IDENTIFIER }; },
    async listInrFuturesOrders(request) {
      calls.push({ endpoint: 'ORDERS', ...request });
      const offset = (Number(request.page) - 1) * 25;
      return Array.from({ length: 25 }, (_, index) => order(request.side, options.repeatRow && offset + index === 49 ? 0 : offset + index,
        options.malformed === true && request.side === 'buy' && offset + index === 0));
    },
    async listInrFuturesPositions(request) {
      if (request === undefined) throw new Error('SYNTHETIC explicit pagination required');
      calls.push({ endpoint: 'POSITIONS', ...request });
      if (options.adapterFailure) throw new TypeError('SYNTHETIC adapter rejection');
      return Array.from({ length: request.page === '1' ? 25 : 8 }, (_, index) => position((Number(request.page) - 1) * 25 + index));
    },
  };
  const written: SyncReadCampaignReport[] = [];
  const result = await runPreparedCollection(proposal, { client,
    authenticatedClient: { kind: 'CREDENTIAL_BOUND', accountId: ACCOUNT, budgetConnectionId: 'SYNTHETIC-OFFLINE-BUDGET' },
    identity: { fingerprint: providerAccountFingerprint, verify: verifyProviderAccountIdentity },
    coordinator: { status: () => ({ connected: true, localStop: false, coordinatorStop: 'NONE' }) },
    stream: null, clock, reportSink: { write: async (_destination, report) => { written.push(report); } } });
  // Explicit offline harness may retain separate synthetic reports. Never read the protected account report here.
  const output = process.env['COINDCX_SYNTHETIC_PIPELINE_REPORT'];
  if (output && Object.keys(options).length === 0) fs.writeFileSync(output, JSON.stringify({
    kind: 'SYNTHETIC_PIPELINE_FIXTURE_NOT_ACCOUNT_OBSERVATIONS', fixture: 'orders buy 25+25 / sell 25+25; positions 25+8',
    network: 'DISABLED', credentialsLoaded: false, report: result.report,
  }, null, 2) + '\n', { flag: 'wx' });
  return { ...result, calls, written };
}

describe('campaign observation clock through adapter, async orchestration, engine and report sink; no network', () => {
  it('retains valid bounded synthetic records with the actual host observation clock despite fractional raw ticks', async () => {
    const { report, delivery, calls, written } = await pipeline();
    expect(delivery).toBe('WRITTEN'); expect(written).toEqual([report]);
    expect(report).toMatchObject({ status: 'COMPLETED', stopReason: 'MAX_EVALUATIONS_REACHED',
      observations: { evaluations: 3, cycles: 3, convergedEvaluations: 0, records: { 'ORDERS:UNRESOLVED': 600, 'POSITIONS:UNRESOLVED': 198 } },
      inFlight: { started: 39, settled: 39, unsettled: [] } });
    expect(calls.filter(call => call.endpoint === 'IDENTITY')).toHaveLength(3);
    expect(calls.filter(call => call.endpoint === 'ORDERS')).toHaveLength(24);
    expect(calls.filter(call => call.endpoint === 'POSITIONS')).toHaveLength(12);
    expect(calls.filter(call => call.page).every(call => ['1', '2'].includes(call.page!) && call.size === '25')).toBe(true);
    expect(new Set(calls.filter(call => call.endpoint === 'ORDERS').map(call => call.status)).size).toBe(1);
    expect(report.accountProvenance.identityChecks.every(check => check.outcome === 'VERIFIED')).toBe(true);
    expect(report.reads.every(read => read.report.failure === null && read.report.stops.every(stop => stop.stop === 'SCAN_BOUND'))).toBe(true);
    expect(report.readAssessments).toHaveLength(12);
    expect(report.readAssessments.every(read => read.responseOutcome === 'RESPONSE' && read.adapterFailure === null
      && read.scanValidity === 'ACCEPTED' && read.retainedRecordObservations === (read.component === 'ORDERS' ? 100 : 33)
      && read.retainedRowOccurrences === read.receivedRowOccurrences && read.assessmentReasons.length > 0)).toBe(true);
    expect(report.recordCountSemantics).toBe('PER_SCAN_RECORD_OBSERVATIONS_NOT_UNIQUE_TRADES_FILLS_OR_CURRENT_POSITIONS');
    for (const evaluation of report.evaluations) {
      const cycle = evaluation.result!.cycles[0]!, engine = cycle.engine!;
      expect(cycle.reads.every(read => read.outcome === 'RESPONSE')).toBe(true);
      expect(engine.reasons).not.toContain('READ_FAILED'); expect(engine.reasons).not.toContain('INVALID_INPUT');
      expect(engine.reasons).toEqual(expect.arrayContaining(['SCAN_BOUNDARY_REACHED', 'SHORT_PAGE_TERMINALITY_UNCONFIRMED', 'OWNERSHIP_LINEAGE_UNAVAILABLE']));
      expect(engine.terminations.filter(scan => scan.component === 'ORDERS').every(scan => scan.termination === 'SCAN_BOUNDARY_REACHED')).toBe(true);
      expect(engine.terminations.filter(scan => scan.component === 'POSITIONS').every(scan => scan.termination === 'SHORT_PAGE_TERMINALITY_UNCONFIRMED')).toBe(true);
      expect(engine.records.every(scan => scan.records.every(record => record.key.includes('SYNTHETIC') && record.ownership === 'UNRESOLVED'))).toBe(true);
      expect(evaluation.stream.observation).toBe('UNKNOWN');
      expect(Object.values(engine.assessment.grants).every(grant => grant === false)).toBe(true);
    }
    expect(Object.values(report.grants).every(grant => grant === false)).toBe(true);
    expect(report.historyCompleteness).toBe('UNPROVEN');
  });

  it('keeps malformed quantity records rejected while retaining the other valid bounded records', async () => {
    const { report } = await pipeline({ malformed: true });
    expect(report.observations.records).toEqual({ 'ORDERS:UNRESOLVED': 594, 'POSITIONS:UNRESOLVED': 198 });
    expect(report.gaps.some(gap => gap.gap === 'FIELD_MISSING')).toBe(true);
    expect(report.evaluations.every(evaluation => evaluation.result!.cycles[0]!.engine!.reasons.includes('RECORD_MALFORMED'))).toBe(true);
    expect(report.evaluations.flatMap(evaluation => evaluation.result!.cycles[0]!.engine!.records)
      .flatMap(scan => scan.records).some(record => record.key === 'order:SYNTHETIC-buy-0')).toBe(false);
    expect(report.readAssessments.filter(read => read.component === 'ORDERS').every(read => read.scanValidity === 'MALFORMED_RECORDS'
      && read.responseOutcome === 'RESPONSE' && read.adapterFailure === null && read.retainedRecordObservations === 99)).toBe(true);
  });

  it('does not relax the engine or assessment safe-integer timestamp validation', async () => {
    const { report } = await pipeline({ rawFractionalClock: true });
    expect(report.observations.records).toEqual({});
    expect(report.reads.every(read => read.report.failure === null)).toBe(true);
    expect(report.evaluations.every(evaluation => evaluation.result!.cycles[0]!.engine!.reasons.includes('INVALID_INPUT')
      && evaluation.result!.cycles[0]!.engine!.reasons.includes('READ_FAILED'))).toBe(true);
    expect(report.readAssessments.every(read => read.responseOutcome === 'RESPONSE' && read.adapterFailure === null
      && read.scanValidity === 'REJECTED' && read.retainedRecordObservations === 0)).toBe(true);
  });

  it('keeps a real injected adapter rejection distinct from bounded history', async () => {
    const { report } = await pipeline({ adapterFailure: true });
    expect(report.stopReason).toBe('CONSECUTIVE_FAILED_READ_EVALUATIONS');
    expect(report.reads.filter(read => read.binding.component === 'POSITIONS').every(read => read.report.failure?.errorName === 'TypeError')).toBe(true);
    expect(report.evaluations.every(evaluation => evaluation.result!.cycles[0]!.engine!.reasons.includes('READ_FAILED'))).toBe(true);
    expect(report.readAssessments.filter(read => read.component === 'POSITIONS').every(read => read.adapterFailure?.errorName === 'TypeError'
      && read.scanValidity === 'REJECTED' && read.responsePages === 0)).toBe(true);
  });

  it('retains duplicate occurrence provenance without turning repeated rows into distinct positions or trades', async () => {
    const { report } = await pipeline({ repeatRow: true });
    expect(report.observations.records).toEqual({ 'ORDERS:UNRESOLVED': 588, 'POSITIONS:UNRESOLVED': 198 });
    expect(report.evaluations.every(evaluation => evaluation.result!.cycles[0]!.engine!.reasons.includes('PAGE_SHIFT_OBSERVED'))).toBe(true);
    const repeated = report.evaluations[0]!.result!.cycles[0]!.engine!.records[0]!.records.find(record => record.key === 'order:SYNTHETIC-buy-0')!;
    expect(repeated.occurrences).toHaveLength(2);
    expect(report.readAssessments.filter(read => read.component === 'ORDERS').every(read => read.retainedRecordObservations === 98
      && read.receivedRowOccurrences === 100 && read.retainedRowOccurrences === 100)).toBe(true);
  });
});
