import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPreparedCollection, type LaunchProposal } from '../../../scripts/sync-read-launch/proposal';
import { localReportSink } from '../../../scripts/sync-read-launch/report-sink';
import { redactCampaignOutput } from '../../../scripts/sync-read-launch/campaign-secrets';
import { normalizeOrder, normalizePosition } from '../../../src/integration/coindcx/normalizers';
import { FuturesOrderWireSchema, FuturesPositionWireSchema } from '../../../src/integration/coindcx/schemas';
import { providerAccountFingerprint, verifyProviderAccountIdentity } from '../../../src/execution/live/reconciliation/account-identity';
import type { AsyncClock } from '../../../src/execution/live/practical-synchronization/async-orchestrator';
import type { SyncRecordView } from '../../../src/execution/live/practical-synchronization/engine';
import type { SyncCampaignReadClient, SyncReadCampaignReport } from '../../../src/integration/coindcx/live/sync-read-campaign';

// SYNTHETIC/SANITIZED SHAPE REPLAY, NOT ACCOUNT OBSERVATIONS OR RECONSTRUCTED PROVIDER PAYLOADS.
// No protected files are read. Counts and the reviewed GTC transition select fresh invented models.
// Real record fields available only inside fingerprints are NOT decoded into replay inputs.
const ACCOUNT = 'SYNTHETIC-ATTEMPT-3-REPLAY-ACCOUNT';
const IDENTITY = 'SYNTHETIC-ATTEMPT-3-REPLAY-IDENTITY';
const SECRET_CANARY = 'SYNTHETIC-SECRET-ECHO-CANARY';
const PERSONAL_CANARY = 'SYNTHETIC-PERSONAL-IDENTITY-CANARY';
const directories: string[] = [];
const denied = () => { throw new Error('SYNTHETIC_REPLAY_NETWORK_FORBIDDEN'); };
beforeEach(() => {
  vi.spyOn(http, 'request').mockImplementation(denied);
  vi.spyOn(https, 'request').mockImplementation(denied);
  vi.spyOn(globalThis, 'fetch').mockImplementation(denied);
});
afterEach(() => {
  expect(http.request).not.toHaveBeenCalled(); expect(https.request).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

type Variant = 'baseline' | 'identical-duplicate' | 'within-pass-conflict' | 'between-pass-difference';
function syntheticOrder(side: 'buy' | 'sell', index: number, evaluation: number) {
  // One replacement between evaluations gives 101 IDs across 600 observations; never a trade count.
  const id = side === 'buy' && index === 0 && evaluation > 0 ? 50 : index;
  return normalizeOrder(FuturesOrderWireSchema.parse({ id: `SYNTHETIC-REPLAY-${side}-${id}`, pair: 'B-SYNTH_USDT', side,
    status: 'open', order_type: 'limit_order', leverage: '5', price: '100', avg_price: null,
    total_quantity: '0.5', remaining_quantity: '0.5', cancelled_quantity: '0', margin_currency_short_name: 'INR',
    created_at: 1000, updated_at: 1500, client_order_id: index === 1 ? SECRET_CANARY : null }));
}
function syntheticPosition(index: number, evaluation: number, quantityOverride?: string) {
  const quantity = index === 0 ? '-2910' : index === 1 ? (evaluation === 0 ? '-447.2' : '-557.6') : index === 2 ? '11166' : '0';
  return normalizePosition(FuturesPositionWireSchema.parse({ id: `SYNTHETIC-REPLAY-position-${index}`,
    pair: index === 1 ? 'B-GTC_USDT' : `B-SYNTH${index}_USDT`, active_pos: quantityOverride ?? quantity,
    avg_price: '1', locked_margin: '1', locked_user_margin: '1', locked_order_margin: '0', maintenance_margin: '0',
    mark_price: '1', margin_type: 'isolated', settlement_currency_avg_price: '80', margin_currency_short_name: 'INR',
    leverage: '3', updated_at: evaluation === 0 ? 1600 : 1700 }));
}

async function replay(variant: Variant = 'baseline') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'SYNTHETIC-attempt-3-replay-')); directories.push(directory);
  const template = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/launch/m4-collection-input.pending.json'), 'utf8')) as { proposal: LaunchProposal };
  const proposal = structuredClone(template.proposal);
  proposal.configuration.account = { accountId: ACCOUNT, expectedProviderAccountFingerprint: providerAccountFingerprint(IDENTITY) };
  proposal.configuration.budget.connectionId = 'SYNTHETIC-REPLAY-BUDGET';
  proposal.configuration.lineage = { kind: 'UNAVAILABLE', reason: 'SYNTHETIC unavailable lineage; not an empty owned inventory' };
  proposal.configuration.reportDestination.path = path.join(directory, 'SYNTHETIC-campaign-report.json');
  let time = 10_000, evaluation = -1, positionCalls = 0;
  const clock: AsyncClock = {
    now: () => ++time,
    delay(ms, signal) {
      if (ms === proposal.configuration.campaign.evaluationIntervalMs) { time += ms; return Promise.resolve(); }
      return new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new Error('SYNTHETIC_TIMER_ABORTED'));
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
    },
  };
  const calls: Array<{ endpoint: string; evaluation: number; side?: string; page?: string; size?: string }> = [];
  const client: SyncCampaignReadClient = {
    async getUserInfoSafe() {
      evaluation++; positionCalls = 0; calls.push({ endpoint: 'IDENTITY', evaluation });
      return { authenticated: true, coindcxId: IDENTITY, name: PERSONAL_CANARY, email: PERSONAL_CANARY };
    },
    async listInrFuturesOrders(request) {
      calls.push({ endpoint: 'ORDERS', evaluation, ...request });
      const offset = (Number(request.page) - 1) * 25;
      return Array.from({ length: 25 }, (_, i) => syntheticOrder(request.side,
        variant === 'identical-duplicate' && request.side === 'buy' && offset + i === 24 ? 0 : offset + i, evaluation));
    },
    async listInrFuturesPositions(request) {
      if (!request) throw new Error('SYNTHETIC_EXPLICIT_PAGINATION_REQUIRED');
      calls.push({ endpoint: 'POSITIONS', evaluation, ...request });
      const pass = Math.floor(positionCalls++ / 2), offset = (Number(request.page) - 1) * 25;
      return Array.from({ length: request.page === '1' ? 25 : 9 }, (_, i) => {
        const index = offset + i;
        if (variant === 'within-pass-conflict' && index === 24) return syntheticPosition(1, evaluation, '-999');
        return syntheticPosition(index, evaluation, variant === 'between-pass-difference' && pass === 1 && index === 1 ? '-999' : undefined);
      });
    },
  };
  let delivered: SyncReadCampaignReport | undefined;
  const outcome = await runPreparedCollection(proposal, { client,
    authenticatedClient: { kind: 'CREDENTIAL_BOUND', accountId: ACCOUNT, budgetConnectionId: 'SYNTHETIC-REPLAY-BUDGET' },
    identity: { fingerprint: providerAccountFingerprint, verify: verifyProviderAccountIdentity },
    coordinator: { status: () => ({ connected: true, localStop: false, coordinatorStop: 'NONE' }) }, stream: null, clock,
    reportSink: { async write(destination, report) {
      delivered = redactCampaignOutput(report, [SECRET_CANARY]);
      await localReportSink.write(destination, delivered);
    } },
  });
  const serialized = fs.readFileSync(proposal.configuration.reportDestination.path, 'utf8');
  const saved = JSON.parse(serialized) as SyncReadCampaignReport;
  // Explicit synthetic-only export for before/after legacy compatibility verification; never reads protected evidence.
  const evidenceDirectory = process.env['COINDCX_SYNTHETIC_REPLAY_DIRECTORY'];
  if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, `${variant}.json`), serialized, { flag: 'wx' });
  expect(outcome.delivery).toBe('WRITTEN'); expect(saved).toEqual(delivered);
  expect(saved).toEqual(redactCampaignOutput(outcome.report, [SECRET_CANARY]));
  expect(serialized).not.toContain(SECRET_CANARY); expect(serialized).not.toContain(PERSONAL_CANARY);
  expect(serialized).not.toContain(IDENTITY); expect(serialized).toContain('[REDACTED]');
  expect(saved).toMatchObject({ status: 'COMPLETED', stopReason: 'MAX_EVALUATIONS_REACHED', historyCompleteness: 'UNPROVEN',
    observations: { evaluations: 3, cycles: 3, convergedEvaluations: 0 }, inFlight: { started: 39, settled: 39, unsettled: [] } });
  expect(saved.readAssessments).toHaveLength(12);
  expect(saved.readAssessments.every(r => r.scanValidity === 'ACCEPTED' && r.adapterFailure === null && r.responseOutcome === 'RESPONSE')).toBe(true);
  expect(saved.readAssessments.every(r => r.termination === (r.component === 'ORDERS'
    ? 'SCAN_BOUNDARY_REACHED' : 'SHORT_PAGE_TERMINALITY_UNCONFIRMED'))).toBe(true);
  expect(saved.reads.every(r => r.report.stops.every(s => s.stop === 'SCAN_BOUND'))).toBe(true);
  expect(saved.accountProvenance.identityChecks.map(c => c.outcome)).toEqual(['VERIFIED', 'VERIFIED', 'VERIFIED']);
  expect(calls.filter(c => c.endpoint === 'IDENTITY')).toHaveLength(3);
  expect(calls.filter(c => c.endpoint === 'ORDERS')).toHaveLength(24);
  expect(calls.filter(c => c.endpoint === 'POSITIONS')).toHaveLength(12);
  for (let e = 0; e < 3; e++) expect(calls.filter(c => c.evaluation === e)[0]!.endpoint).toBe('IDENTITY');
  expect(calls.filter(c => c.page).every(c => ['1', '2'].includes(c.page!) && c.size === '25')).toBe(true);
  expect(saved.reads.every(r => r.report.pages.every(p => Number.isSafeInteger(p.startedAtMs) && Number.isSafeInteger(p.endedAtMs)))).toBe(true);
  for (const e of saved.evaluations) {
    expect(Number.isSafeInteger(e.startedAtMs) && Number.isSafeInteger(e.endedAtMs)).toBe(true);
    expect(e.result!.status).toBe('REVOKED_CYCLE_LIMIT_REACHED'); expect(e.stream.observation).toBe('UNKNOWN');
    const cycle = e.result!.cycles[0]!;
    expect(cycle.reasons).toEqual(expect.arrayContaining(['OWNERSHIP_LINEAGE_UNAVAILABLE', 'OWNERSHIP_UNRESOLVED',
      'STREAM_OBSERVATION_UNAVAILABLE', 'EPOCH_UNKNOWN', 'PAGINATION_TRUNCATED', 'PAGINATION_UNKNOWN',
      'SCAN_BOUNDARY_REACHED', 'SHORT_PAGE_TERMINALITY_UNCONFIRMED']));
    expect(cycle.reasons).not.toContain('INVALID_INPUT'); expect(cycle.reasons).not.toContain('READ_FAILED');
    expect(cycle.engine!.records.every(s => s.records.every(r => r.ownership === 'UNRESOLVED' && r.key.includes('SYNTHETIC-REPLAY')))).toBe(true);
    expect(cycle.engine!.assessment.kind).toBe('NOT_CONVERGED');
    expect(cycle.engine!.assessment.stream!.epoch).toBeNull();
    expect(cycle.engine!.assessment.stream!.quietStreamProvesNoActivity).toBe(false);
    expect(Object.values(cycle.engine!.assessment.grants).every(g => g === false)).toBe(true);
  }
  expect(Object.values(saved.grants).every(g => g === false)).toBe(true);
  // The real sink must keep its no-overwrite behavior even in this disposable synthetic directory.
  await expect(localReportSink.write(proposal.configuration.reportDestination, saved)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(fs.readFileSync(proposal.configuration.reportDestination.path, 'utf8')).toBe(serialized);
  return saved;
}
function records(report: SyncReadCampaignReport, evaluation: number, pass: number, component: string): readonly SyncRecordView[] {
  return report.evaluations[evaluation]!.result!.cycles[0]!.engine!.records.find(s => s.pass === pass && s.component === component)!.records;
}
const gtc = (report: SyncReadCampaignReport, evaluation: number, pass: number) => records(report, evaluation, pass, 'POSITIONS').find(r => r.key === 'position:SYNTHETIC-REPLAY-position-1')!;

describe('SYNTHETIC attempt-3 shape replay through adapter, orchestration, engine, redactor and actual JSON file sink', () => {
  it('persists bounded 25+25 orders per side / 25+9 positions and cross-evaluation changes, without convergence', async () => {
    const saved = await replay();
    expect(saved.observations.records).toEqual({ 'ORDERS:UNRESOLVED': 600, 'POSITIONS:UNRESOLVED': 204 });
    const allOrders: SyncRecordView[] = [], allPositions: SyncRecordView[] = [];
    for (let e = 0; e < 3; e++) {
      for (const component of ['ORDERS', 'POSITIONS']) {
        expect(records(saved, e, 0, component)).toEqual(records(saved, e, 1, component));
        for (const pass of [0, 1]) {
          const rows = records(saved, e, pass, component);
          expect(rows).toHaveLength(component === 'ORDERS' ? 100 : 34);
          expect(rows.every(r => r.occurrences.length === 1)).toBe(true);
          expect(rows.every(r => r.observationVariants?.length === 1)).toBe(true);
          for (const row of rows) {
            const variant = row.observationVariants![0]!;
            expect(variant.fingerprint).toBe(row.fingerprint); expect(variant.occurrences).toEqual(row.occurrences);
            expect(variant.normalized).toMatchObject({ format: 'M4_NORMALIZED_OBSERVATION_V1', component,
              provenance: { source: 'ENGINE_NORMALIZED_INPUT', providerSemantics: 'UNCONFIRMED', rawProviderPayload: 'NOT_RETAINED', rawNumericLexemes: 'NOT_RETAINED' } });
            expect(`${component}|${Object.entries(variant.normalized.fields).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('|')}`).toBe(row.fingerprint);
            expect(variant.normalized.fields.providerEventTimeMs).toBe(component === 'ORDERS' ? 1500 : e === 0 ? 1600 : 1700);
            if (variant.normalized.component === 'ORDERS') {
              expect(variant.normalized.fields).toMatchObject({ pair: 'B-SYNTH_USDT', orderedQuantity: '0.5', filledQuantity: '0', remainingQuantity: '0.5', cancelledQuantity: '0', price: '100' });
            }
          }
          (component === 'ORDERS' ? allOrders : allPositions).push(...rows);
        }
      }
      expect(gtc(saved, e, 0).fingerprint).toContain(`signedQuantity="${e === 0 ? '-447.2' : '-557.6'}"`);
      const gtcObservation = gtc(saved, e, 0).observationVariants![0]!.normalized;
      expect(gtcObservation.component).toBe('POSITIONS');
      if (gtcObservation.component === 'POSITIONS') expect(gtcObservation.fields).toMatchObject({ pair: 'B-GTC_USDT', signedQuantity: e === 0 ? '-447.2' : '-557.6' });
      expect(saved.evaluations[e]!.result!.cycles[0]!.reasons).not.toContain('RECORDS_DISAGREE');
    }
    expect(new Set(allOrders.map(r => r.key)).size).toBe(101);
    expect(new Set(allPositions.map(r => r.key)).size).toBe(34);
    // Own synthetic input expectations only: never decode private source fingerprints into models.
    const nonzero = allPositions.filter(r => !r.fingerprint.includes('signedQuantity="0"|'));
    expect(nonzero).toHaveLength(18); expect(new Set(nonzero.map(r => r.key)).size).toBe(3);
    expect(gtc(saved, 0, 0).fingerprint).not.toBe(gtc(saved, 1, 0).fingerprint);
    for (const read of saved.reads) {
      expect(read.report.pages.map(p => p.records)).toEqual(read.binding.component === 'ORDERS' ? [25, 25, 25, 25] : [25, 9]);
      expect(read.report.fieldProvenance.every(p => p.providerSemantics === 'NOT_CONFIRMED')).toBe(true);
      if (read.binding.component === 'ORDERS') expect(read.report.fieldProvenance.find(p => p.providerField === 'client_id'))
        .toMatchObject({ basis: 'NOT_EXPOSED_BY_COMMITTED_READ_PATH' });
      expect(read.report.correlation.kind).toBe('ADAPTER_LOCAL_ECHO');
    }
    expect(saved.recordCountSemantics).toBe('PER_SCAN_RECORD_OBSERVATIONS_NOT_UNIQUE_TRADES_FILLS_OR_CURRENT_POSITIONS');
  });

  it('retains repeated same-page occurrences separately from distinct IDs after readback', async () => {
    const saved = await replay('identical-duplicate');
    expect(saved.observations.records['ORDERS:UNRESOLVED']).toBe(594);
    for (const r of saved.readAssessments.filter(r => r.component === 'ORDERS')) {
      expect(r).toMatchObject({ retainedRecordObservations: 99, retainedRowOccurrences: 100, receivedRowOccurrences: 100 });
    }
    const repeated = records(saved, 0, 0, 'ORDERS').find(r => r.key === 'order:SYNTHETIC-REPLAY-buy-0')!;
    expect(repeated.occurrences).toEqual([{ segment: 'side=buy', page: 0, position: 0 }, { segment: 'side=buy', page: 0, position: 24 }]);
    expect(repeated.anomalies).toEqual(['IDENTICAL_DUPLICATE_DEDUPED']);
    expect(repeated.observationVariants).toHaveLength(1);
    expect(repeated.observationVariants![0]!.occurrences).toEqual(repeated.occurrences);
  });

  it('preserves a deliberate within-pass conflicting duplicate and both locations without last-write-wins', async () => {
    const saved = await replay('within-pass-conflict');
    for (const e of saved.evaluations) {
      const engine = e.result!.cycles[0]!.engine!;
      expect(engine.reasons).toContain('CONFLICTING_DUPLICATE');
      expect(engine.scanFindings.filter(f => f.finding === 'CONFLICTING_DUPLICATE')).toEqual(expect.arrayContaining([
        expect.objectContaining({ pass: 0, component: 'POSITIONS', blocking: true, key: 'position:SYNTHETIC-REPLAY-position-1',
          occurrences: [{ page: 0, position: 1 }, { page: 0, position: 24 }] }),
      ]));
    }
    expect(gtc(saved, 0, 0).occurrences).toHaveLength(2);
    expect(gtc(saved, 0, 0).fingerprint).toContain('signedQuantity="-447.2"');
    expect(gtc(saved, 0, 0).fingerprint).not.toContain('-999');
    expect(saved.readAssessments.filter(r => r.component === 'POSITIONS').every(r => r.retainedRecordObservations === 33 && r.retainedRowOccurrences === 34)).toBe(true);
    // The legacy comparison keeps the first fingerprint; additive evidence keeps both variants and their locations.
    expect(gtc(saved, 0, 0).observationVariants).toHaveLength(2);
    expect(gtc(saved, 0, 0).observationVariants!.map(v => ({ fields: v.normalized.fields, occurrences: v.occurrences }))).toEqual([
      { fields: expect.objectContaining({ signedQuantity: '-447.2' }), occurrences: [{ page: 0, position: 1 }] },
      { fields: expect.objectContaining({ signedQuantity: '-999' }), occurrences: [{ page: 0, position: 24 }] },
    ]);
  });

  it('keeps a separate between-pass content difference visible as RECORDS_DISAGREE despite other blockers', async () => {
    const saved = await replay('between-pass-difference');
    for (let e = 0; e < 3; e++) {
      expect(gtc(saved, e, 0).fingerprint).not.toBe(gtc(saved, e, 1).fingerprint);
      expect(gtc(saved, e, 1).fingerprint).toContain('signedQuantity="-999"');
      expect(gtc(saved, e, 0).observationVariants![0]!.normalized.fields).not.toEqual(gtc(saved, e, 1).observationVariants![0]!.normalized.fields);
      expect(saved.evaluations[e]!.result!.cycles[0]!.reasons).toContain('RECORDS_DISAGREE');
    }
  });
});
