import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveExecutionAuthority } from '../../../../src/execution/live/authority';
import { PracticalRecoveryCertificate } from '../../../../src/execution/live/practical/certificate';
import type { PrivateStreamObservation } from '../../../../src/execution/live/practical-observation/assessment';
import type { AsyncClock } from '../../../../src/execution/live/practical-synchronization/async-orchestrator';
import { GRANTS_NOTHING } from '../../../../src/execution/live/practical-synchronization/engine';
import { providerAccountFingerprint, verifyProviderAccountIdentity } from '../../../../src/execution/live/reconciliation/account-identity';
import { currentAccountContinuityCapability } from '../../../../src/execution/live/reconciliation/barrier';
import { CoinDcxClient } from '../../../../src/integration/coindcx/client';
import {
  classifySyncReadCampaign,
  runSyncReadCampaign,
  type SyncCampaignReadClient,
  type SyncCampaignIdentityFunctions,
  type SyncReadCampaignReport,
} from '../../../../src/integration/coindcx/live/sync-read-campaign';
import { RateLimitClient } from '../../../../src/integration/coindcx/rate-limit/runtime/client';
import { RateLimitCoordinator } from '../../../../src/integration/coindcx/rate-limit/runtime/coordinator';
import { createCoordinatorReadBudget, type TransportReadBudget } from '../../../../src/integration/coindcx/rate-limit/runtime/read-budget';
import { fixtureTransportBudget } from '../../../helpers/read-budget-fixture';
import { cleanup, clientConfig, fixture, limiterFixture, sleep, waitFor } from './support';

// M4 read-only campaign runner (unwired review candidate): preflight -> identity read -> adapter -> M2-budgeted
// CoinDcxClient -> transport -> loopback venue -> orchestration -> report. Synthetic identity, credentials and payloads;
// loopback only; test-only budget bindings in this process. No provider, external network or database.
const stops: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); cleanup(); });
const ACCOUNT = 'synthetic-account';
const IDENTIFIER = 'synthetic-coindcx-id-0001';
const EXPECTED = providerAccountFingerprint(IDENTIFIER);
const STATUSES = ['open', 'filled', 'partially_filled', 'partially_cancelled', 'cancelled', 'rejected', 'untriggered'];
const USERS_PATH = '/exchange/v1/users/info';
const ORDERS_PATH = '/exchange/v1/derivatives/futures/orders';
const POSITIONS_PATH = '/exchange/v1/derivatives/futures/positions';
const INTERVAL = 10_000;
const DESTINATION = { kind: 'LOCAL_FILE' as const, path: 'C:\\synthetic\\campaign-report.json' };
const TIMEOUT = 60_000;

function orderWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'ex-1', pair: 'B-BTC_USDT', side: 'buy', status: 'open', order_type: 'limit_order', leverage: '5', price: '64000.5', avg_price: null,
    total_quantity: '0.5', remaining_quantity: '0.5', cancelled_quantity: '0', margin_currency_short_name: 'INR', created_at: 1_000, updated_at: 1_500,
    client_order_id: 'bot-0001', ...overrides };
}
function positionWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'pos-1', pair: 'B-BTC_USDT', active_pos: '0.5', avg_price: '64000.5', locked_margin: '1100.0', locked_user_margin: '1000.0', locked_order_margin: '100.0',
    maintenance_margin: '50.0', mark_price: '64100.0', margin_type: 'isolated', settlement_currency_avg_price: '89.5', margin_currency_short_name: 'INR',
    leverage: '5', updated_at: 1_600, ...overrides };
}

type Answer = { status: number; body: unknown; headers?: Record<string, string> } | Promise<{ status: number; body: unknown; headers?: Record<string, string> }>;
interface Venue { url: string; hits: Array<{ path: string; body: Record<string, unknown> }>; respond: (path: string, body: Record<string, unknown>) => Answer }
/** Identity: the synthetic identifier. Orders: buy page 1 has ex-1, every other page is empty. Positions: page 1 has pos-1. */
function defaultAnswer(path: string, body: Record<string, unknown>): Answer {
  if (path === USERS_PATH) return { status: 200, body: { coindcx_id: IDENTIFIER } };
  if (path === ORDERS_PATH) return { status: 200, body: body['side'] === 'buy' && body['page'] === '1' ? [orderWire()] : [] };
  if (path === POSITIONS_PATH) return { status: 200, body: body['page'] === '1' ? [positionWire()] : [] };
  return { status: 404, body: { message: 'unexpected path' } };
}
async function startVenue(): Promise<Venue> {
  const state: Venue = { url: '', hits: [], respond: defaultAnswer };
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]!;
      const body = raw.length > 0 ? JSON.parse(raw) as Record<string, unknown> : {};
      state.hits.push({ path, body });
      void Promise.resolve(state.respond(path, body)).then((answer) => {
        res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers ?? {}) }); res.end(JSON.stringify(answer.body));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stops.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return state;
}

/** Manual time; the campaign interval advances automatically so multi-evaluation runs need no stepping. */
class ManualClock implements AsyncClock {
  public nowMs = 10_000;
  readonly #waiters: Array<{ due: number; resolve: () => void }> = [];
  public now(): number { return this.nowMs; }
  public delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('aborted')); return; }
      if (ms === INTERVAL) { this.nowMs += ms; queueMicrotask(resolve); return; }
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error('aborted'));
      };
      const waiter = { due: this.nowMs + ms, resolve: () => { signal.removeEventListener('abort', onAbort); resolve(); } };
      this.#waiters.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  public advance(ms: number): void {
    this.nowMs += ms;
    for (const waiter of this.#waiters.filter((entry) => entry.due <= this.nowMs)) { this.#waiters.splice(this.#waiters.indexOf(waiter), 1); waiter.resolve(); }
  }
}

/** A test-only injected stream source (the runner never synthesizes one). */
function streamSource() {
  const listeners = new Set<(event: unknown) => void>();
  const observation = (): PrivateStreamObservation => ({ connected: true, epoch: 7, epochAtWindowStart: 7, disconnectObservedSinceWindowStart: false, reconnectLatched: false,
    joinAcknowledgement: { kind: 'UNKNOWN' }, events: [], bufferedUnprocessedEvents: 0 });
  return {
    emit: (event: unknown) => { for (const listener of listeners) listener(event); },
    source: { observeStream: async () => observation(), subscribeEvents: (listener: (event: unknown) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
  };
}

function campaignFixture() {
  return {
    account: { accountId: ACCOUNT, expectedProviderAccountFingerprint: EXPECTED },
    scope: { mode: 'FULL_EVIDENCE', components: ['ORDERS', 'POSITIONS'], requiredAccounting: [], history: { kind: 'AVAILABLE_HISTORY' }, orderStatuses: STATUSES },
    accountScope: { assumption: 'UNKNOWN', attestation: 'NONE' },
    decisions: { d4c: 'PENDING', as1: 'PENDING' },
    budget: { connectionId: 'synthetic-budget', kind: 'SHARED_COORDINATOR_READ_BUDGET', scope: 'API_AUTH', priorityClass: 'P1', admissionDeadlineMs: 500, transportRequestTimeoutMs: 10_000,
      limiter: limiterFixture(), campaignShare: { maxStartsPerFairnessWindow: 40 } },
    scanLimits: { ORDERS: { pageSize: 2, maxPages: 3 }, POSITIONS: { pageSize: 2, maxPages: 3 }, TRANSACTIONS: { pageSize: 2, maxPages: 3 } },
    timeouts: { identityReadTimeoutMs: 1_000, readTimeoutMs: 1_000, streamTimeoutMs: 1_000 },
    maxCycles: 1,
    thresholds: { maxEvidenceAgeMs: 30_000, maxTotalReadDurationMs: 20_000 },
    campaign: { durationMs: 600_000, evaluationIntervalMs: INTERVAL, maxEvaluations: 1, maxConsecutiveFailedReadEvaluations: 2 },
    lineage: { ownedOrders: [{ exchangeOrderId: 'ex-1', intentId: 'intent-1' }], ambiguousCreates: [], closedIntentTags: [], ownedPositions: ['pos-1'], botTagNamespace: 'bot-' },
    contracts: 'ALL_UNCONFIRMED',
    reportDestination: DESTINATION,
  };
}

function campaignConfig(mutate: (c: ReturnType<typeof campaignFixture>) => void = () => undefined) {
  const c = campaignFixture();
  mutate(c);
  return c;
}

type CoordinatorStatus = { connected: boolean; localStop: boolean; coordinatorStop: string };
const CONNECTED: CoordinatorStatus = { connected: true, localStop: false, coordinatorStop: 'NONE' };

async function harness(options: { readBudget?: TransportReadBudget | null; stream?: boolean; coordinator?: { status(): CoordinatorStatus } | null;
  provenance?: { kind: 'CREDENTIAL_BOUND'; accountId: string; budgetConnectionId: string } | null; sinkFails?: boolean;
  streamObservation?: () => Promise<unknown> } = {}) {
  const venue = await startVenue();
  const clock = new ManualClock();
  const readBudget = options.readBudget === undefined ? fixtureTransportBudget() : options.readBudget;
  const client = new CoinDcxClient({ apiKey: 'synthetic-campaign-key', apiSecret: 'synthetic-campaign-secret', baseUrl: venue.url, ...(readBudget === null ? {} : { readBudget }) });
  const stream = streamSource();
  const sink = { writes: [] as Array<{ destination: unknown; report: SyncReadCampaignReport }>, write: async (destination: unknown, report: SyncReadCampaignReport) => {
    if (options.sinkFails) throw new Error('synthetic report sink failure');
    sink.writes.push({ destination, report });
  } };
  const run = (config: unknown = campaignConfig(), signal?: AbortSignal, readClient: SyncCampaignReadClient = client,
    identity: SyncCampaignIdentityFunctions = { fingerprint: providerAccountFingerprint, verify: verifyProviderAccountIdentity }) => runSyncReadCampaign({
    config, client: readClient, identity, coordinator: options.coordinator === undefined ? { status: () => CONNECTED } : options.coordinator,
    authenticatedClient: options.provenance === undefined ? { kind: 'CREDENTIAL_BOUND', accountId: ACCOUNT, budgetConnectionId: 'synthetic-budget' } : options.provenance,
    stream: options.stream === false ? null : { ...stream.source, observeStream: options.streamObservation ?? stream.source.observeStream },
    clock, reportSink: sink, ...(signal === undefined ? {} : { signal }),
  });
  return { venue, clock, client, stream, sink, run };
}
const caseOf = (report: SyncReadCampaignReport, id: string) => report.coverage.find((entry) => entry.id === id)!;
const pathsOf = (venue: Venue): string[] => venue.hits.map((hit) => hit.path);
const accountHits = (venue: Venue): number => venue.hits.filter((hit) => hit.path !== USERS_PATH).length;

describe('M4 read-only campaign: end to end over the identity read, the budgeted read client and a loopback venue', () => {
  it('verifies the account identity first, then collects; orders/positions-only is labelled exactly; the report is delivered', async () => {
    const h = await harness();
    const outcome = await h.run();
    const report = outcome.report;
    expect(report).toMatchObject({ kind: 'SYNC_READ_CAMPAIGN_REPORT', status: 'COMPLETED', stopReason: 'MAX_EVALUATIONS_REACHED',
      scopeLabel: 'ORDERS_AND_POSITIONS_ONLY_NOT_FULL_ACCOUNT_SYNCHRONIZATION', fullAccountSynchronization: 'NOT_CLAIMED', historyCompleteness: 'UNPROVEN',
      decisions: { D4c: 'PENDING_NOT_DECIDED_BY_COLLECTION', AS1: 'PENDING_NOT_DECIDED_BY_COLLECTION' } });
    expect(pathsOf(h.venue)[0]).toBe(USERS_PATH);
    expect(pathsOf(h.venue).filter((path) => path === USERS_PATH)).toHaveLength(1);
    expect(report.evaluations[0]!.identity).toEqual({ evaluation: 0, outcome: 'VERIFIED', reason: null, observedFingerprintPrefix: null });
    expect(report.evaluations[0]!.result?.status).toBe('OBSERVED_CONVERGENCE');
    expect(report.accountProvenance).toMatchObject({ credentialBinding: ACCOUNT, scope: 'PROVIDER_TRADING_ACCOUNT_AT_READ_TIME',
      readResponsesCarryAccountIdentity: false, provesAccountContinuity: false, provesExclusiveUse: false });
    expect(report.correlation).toEqual({ kind: 'ADAPTER_LOCAL_ECHO', providerReturnedIdentity: 'NONE', isProviderProof: false });
    expect(report.reads.every((read) => read.report.accountProvenance.status === 'BOUND' && read.report.correlation.kind === 'ADAPTER_LOCAL_ECHO')).toBe(true);
    expect(report.observations).toEqual({ evaluations: 1, convergedEvaluations: 1, cycles: 1, records: { 'ORDERS:OWNED': 2, 'POSITIONS:OWNED': 2 } });
    expect(report.inFlight).toMatchObject({ started: 1 + 2 * (3 + 2), settled: 1 + 2 * (3 + 2), unsettled: [], refusedAfterStop: 0 });
    expect(caseOf(report, 'OBSERVED_CONVERGENCE').class).toBe('PASS');
    expect(caseOf(report, 'EMPTY_PAGE_TERMINATION').class).toBe('PASS');
    expect(outcome.delivery).toBe('WRITTEN');
    expect(h.sink.writes).toEqual([{ destination: DESTINATION, report }]);
    expect(JSON.stringify(report)).not.toContain(IDENTIFIER); // the raw provider identifier is never kept
    expect(report.grants).toBe(GRANTS_NOTHING);
  }, TIMEOUT);

  it('PASS, FAIL, UNKNOWN and NOT_OBSERVED are counted separately and never folded together', async () => {
    const h = await harness();
    const report = (await h.run()).report;
    const byClass = (cls: string) => report.coverage.filter((entry) => entry.class === cls).map((entry) => entry.id);
    expect(byClass('PASS')).toEqual(['OBSERVED_CONVERGENCE', 'EMPTY_PAGE_TERMINATION', 'AUTHORITY_GRANTS_ALL_FALSE']);
    expect(byClass('FAIL')).toEqual([]);
    expect(byClass('NOT_OBSERVED')).toEqual(['SCAN_BOUND_TRUNCATION', 'RECORDS_AFTER_SHORT_PAGE', 'PRIVATE_EVENT_REVOCATION', 'READ_FAILURE_EXPLICIT', 'MISSING_FIELD_GAP',
      'UNRESOLVED_OWNERSHIP', 'BUDGET_REFUSAL_OR_THROTTLE', 'ACCOUNT_IDENTITY_MISMATCH', 'CANCELLATION']);
    expect(byClass('UNKNOWN')).toEqual(['EXCLUSIVE_ACCOUNT_USE', 'STREAM_JOIN_AND_DELIVERY_COMPLETENESS', 'ATOMIC_CONSISTENCY_BETWEEN_READS',
      'COMPLETE_HISTORY_AND_TERMINAL_PAGE_CONTRACT', 'STABLE_FILL_IDENTITY_AND_FILL_ACCOUNTING', 'TAG_CONTRACT_AND_ECHO', 'VENUE_GENERATED_EVENT_REPRESENTATION', 'TRANSACTIONS_COMPONENT']);
    expect(report.counts).toEqual({ PASS: 3, FAIL: 0, UNKNOWN: 8, NOT_OBSERVED: 9 });

    // FAIL: an observed case whose expected behaviour did not hold (synthetic inconsistent collections).
    const truncated = { ...report.reads[0]!, report: { ...report.reads[0]!.report, stops: [{ segment: 'side=buy', stop: 'SCAN_BOUND' as const }] } };
    const failed = classifySyncReadCampaign({ evaluations: report.evaluations, reads: [truncated], gate: { stop: null, startedAfterClose: null, budgetRefusals: 0, throttles: 0 }, streamInjected: true });
    expect(failed.filter((entry) => entry.class === 'FAIL').map((entry) => entry.id)).toEqual(['OBSERVED_CONVERGENCE', 'SCAN_BOUND_TRUNCATION']);
    const leaked = classifySyncReadCampaign({ evaluations: [], reads: [], gate: { stop: 'CANCELLED', startedAfterClose: 1, budgetRefusals: 0, throttles: 0 }, streamInjected: true });
    expect(leaked.find((entry) => entry.id === 'CANCELLATION')?.class).toBe('FAIL');
    const noStream = classifySyncReadCampaign({ evaluations: [], reads: [], gate: { stop: null, startedAfterClose: null, budgetRefusals: 0, throttles: 0 }, streamInjected: false });
    expect(noStream.find((entry) => entry.id === 'PRIVATE_STREAM_OBSERVATION')).toEqual({ id: 'PRIVATE_STREAM_OBSERVATION', class: 'UNKNOWN', basis: 'not configured; never synthesized as quiet' });
    expect(noStream.find((entry) => entry.id === 'OBSERVED_CONVERGENCE')).toMatchObject({ class: 'NOT_OBSERVED', basis: 'cannot occur: private-stream observation not configured' });
  }, TIMEOUT);
});

describe('M4 read-only campaign: account identity', () => {
  it('an identity mismatch stops before any account read: zero account scans', async () => {
    const h = await harness();
    h.venue.respond = (path, body) => (path === USERS_PATH ? { status: 200, body: { coindcx_id: 'another-synthetic-id' } } : defaultAnswer(path, body));
    const report = (await h.run(campaignConfig((c) => { c.campaign.maxEvaluations = 3; }))).report;
    expect(report).toMatchObject({ status: 'STOPPED', stopReason: 'ACCOUNT_IDENTITY_MISMATCH' });
    expect(pathsOf(h.venue)).toEqual([USERS_PATH]);
    expect(report.evaluations).toHaveLength(1);
    expect(report.evaluations[0]).toMatchObject({ result: null, identity: { outcome: 'MISMATCH', observedFingerprintPrefix: providerAccountFingerprint('another-synthetic-id').slice(0, 12) } });
    expect(report.reads).toEqual([]);
    expect(caseOf(report, 'ACCOUNT_IDENTITY_MISMATCH').class).toBe('PASS');
    expect(JSON.stringify(report)).not.toContain('another-synthetic-id');
  }, TIMEOUT);

  it('a verifier that would accept anything cannot pass a mismatch: the fingerprints are also compared exactly', async () => {
    const h = await harness();
    h.venue.respond = (path, body) => (path === USERS_PATH ? { status: 200, body: { coindcx_id: 'another-synthetic-id' } } : defaultAnswer(path, body));
    const lenient = { fingerprint: providerAccountFingerprint, verify: () => ({ kind: 'ACCOUNT_IDENTITY_VERIFIED' }) };
    const report = (await h.run(campaignConfig(), undefined, h.client, lenient)).report;
    expect(report.stopReason).toBe('ACCOUNT_IDENTITY_MISMATCH');
    expect(accountHits(h.venue)).toBe(0);
  }, TIMEOUT);

  it('an unavailable or malformed identity is UNVERIFIED and stops before any account read', async () => {
    for (const answer of [{ status: 200, body: [] }, { status: 200, body: { coindcx_id: '' } }, { status: 200, body: [{ coindcx_id: 'a' }, { coindcx_id: 'b' }] }]) {
      const h = await harness();
      h.venue.respond = (path, body) => (path === USERS_PATH ? answer : defaultAnswer(path, body));
      const report = (await h.run()).report;
      expect(report.stopReason, JSON.stringify(answer)).toBe('ACCOUNT_IDENTITY_UNVERIFIED');
      expect(report.evaluations[0]!.identity.outcome).toBe('UNVERIFIED');
      expect(accountHits(h.venue)).toBe(0);
    }
  }, TIMEOUT);
});

describe('M4 read-only campaign: configuration, budget and coordinator', () => {
  it('unknown or mismatched authenticated-client provenance blocks before identity or account HTTP', async () => {
    for (const provenance of [null, { kind: 'CREDENTIAL_BOUND' as const, accountId: 'other-account', budgetConnectionId: 'synthetic-budget' },
      { kind: 'CREDENTIAL_BOUND' as const, accountId: ACCOUNT, budgetConnectionId: 'other-budget' }]) {
      const h = await harness({ provenance });
      expect((await h.run()).report.status).toBe('PREFLIGHT_BLOCKED');
      expect(h.venue.hits).toEqual([]);
    }
  }, TIMEOUT);

  it('a report sink failure is explicit and cannot turn completed observations into acceptance', async () => {
    const h = await harness({ sinkFails: true });
    const outcome = await h.run();
    expect(outcome.delivery).toBe('FAILED');
    expect(outcome.report.status).toBe('COMPLETED');
    expect(outcome.report.grants).toBe(GRANTS_NOTHING);
    expect(outcome.report.preflight.limitations.length).toBeGreaterThan(0);
  }, TIMEOUT);
  it('missing configuration is a preflight block: zero HTTP and no report delivery', async () => {
    const h = await harness();
    for (const config of [null, {}, campaignConfig((c) => { Reflect.deleteProperty(c.budget, 'campaignShare'); }), campaignConfig((c) => { c.decisions.as1 = 'APPROVED'; })]) {
      const outcome = await h.run(config);
      expect(outcome.report).toMatchObject({ status: 'PREFLIGHT_BLOCKED', stopReason: 'PREFLIGHT_BLOCKED', evaluations: [] });
      expect(outcome.report.preflight.blockers.length).toBeGreaterThan(0);
      expect(outcome.report.counts).toEqual({ PASS: 0, FAIL: 0, UNKNOWN: 8, NOT_OBSERVED: 0 });
      expect(outcome.delivery).toBe('NOT_ATTEMPTED');
      expect(outcome.report.grants).toBe(GRANTS_NOTHING);
    }
    expect(h.venue.hits).toEqual([]);
    expect(h.sink.writes).toEqual([]);
  }, TIMEOUT);

  it('no coordinator, or a disconnected or stopped one, blocks before any HTTP', async () => {
    for (const coordinator of [null, { status: () => ({ ...CONNECTED, connected: false }) }, { status: () => ({ ...CONNECTED, localStop: true }) }, { status: (): CoordinatorStatus => { throw new Error('probe'); } }]) {
      const h = await harness({ coordinator });
      expect((await h.run()).report.stopReason).toBe('PREFLIGHT_BLOCKED');
      expect(h.venue.hits).toEqual([]);
    }
  }, TIMEOUT);

  it('a missing or unavailable read budget refuses the identity read before any HTTP and stops the campaign', async () => {
    const missing = await harness({ readBudget: null });
    const report = (await missing.run(campaignConfig((c) => { c.campaign.maxEvaluations = 3; }))).report;
    expect(report).toMatchObject({ status: 'STOPPED', stopReason: 'BUDGET_UNAVAILABLE' });
    expect(caseOf(report, 'BUDGET_REFUSAL_OR_THROTTLE').class).toBe('PASS');
    expect(missing.venue.hits).toEqual([]);
    const offline = new RateLimitClient(clientConfig(fixture().pipe)); stops.push(() => offline.close());
    const unavailable = await harness({ readBudget: { budget: createCoordinatorReadBudget(offline, { cls: 'P1', deadlineInMs: 500 }), scope: 'API_AUTH' } });
    expect((await unavailable.run()).report.stopReason).toBe('BUDGET_UNAVAILABLE');
    expect(unavailable.venue.hits).toEqual([]);
  }, TIMEOUT);

  it('a coordinator that becomes unavailable between evaluations stops further evaluations', async () => {
    let now = () => 0;
    const h = await harness({ coordinator: { status: () => (now() < 20_000 ? CONNECTED : { ...CONNECTED, coordinatorStop: 'DURABLE' }) } });
    now = () => h.clock.now();
    const report = (await h.run(campaignConfig((c) => { c.campaign.maxEvaluations = 3; }))).report;
    expect(report).toMatchObject({ status: 'STOPPED', stopReason: 'BUDGET_UNAVAILABLE' });
    expect(report.evaluations).toHaveLength(1);
    expect(pathsOf(h.venue).filter((path) => path === USERS_PATH)).toHaveLength(1);
  }, TIMEOUT);
});

describe('M4 read-only campaign: scope and stream gaps', () => {
  it('an injected source with a missing or rejected observation reports UNKNOWN and revokes, never quiet', async () => {
    for (const streamObservation of [async () => null, async () => { throw new Error('synthetic unavailable stream'); }]) {
      const h = await harness({ streamObservation });
      const report = (await h.run()).report;
      expect(report.evaluations[0]!.stream.observation).toBe('UNKNOWN');
      expect(report.evaluations[0]!.result?.status).toBe('REVOKED_CYCLE_LIMIT_REACHED');
      expect(report.gaps).toContainEqual({ evaluation: 0, gap: 'PRIVATE_STREAM_OBSERVATION_UNKNOWN', detail: 'UNAVAILABLE' });
      expect(caseOf(report, 'PRIVATE_STREAM_OBSERVATION').class).toBe('UNKNOWN');
    }
  }, TIMEOUT);
  it('a required unsupported component stays in scope and visible; it is never requested or substituted, and prevents convergence', async () => {
    const h = await harness();
    const report = (await h.run(campaignConfig((c) => { c.scope.components = ['ORDERS', 'POSITIONS', 'TRANSACTIONS']; c.campaign.maxEvaluations = 2; }))).report;
    expect(report.scopeLabel).toBe('DECLARED_SCOPE_INCLUDES_CLIENT_ADAPTER_UNSUPPORTED_COMPONENT');
    expect(report.preflight.unsupportedRequiredComponents).toEqual([{ component: 'TRANSACTIONS', support: 'CLIENT_ADAPTER_UNSUPPORTED' }]);
    expect(report.preflight.limitations).toContainEqual({ code: 'REQUIRED_COMPONENT_CLIENT_ADAPTER_UNSUPPORTED', effect: 'PREVENTS_CONVERGENCE', detail: 'TRANSACTIONS' });
    expect(report.stopReason).toBe('MAX_EVALUATIONS_REACHED'); // an unsupported component is not counted as a failed read
    expect(report.evaluations.map((evaluation) => evaluation.result?.status)).toEqual(['UNRESOLVED', 'UNRESOLVED']);
    expect(report.reads.filter((read) => read.binding.component === 'TRANSACTIONS').every((read) => read.report.unsupportedReason === 'CLIENT_ADAPTER_UNSUPPORTED')).toBe(true);
    expect(report.gaps).toContainEqual({ evaluation: null, gap: 'CLIENT_ADAPTER_UNSUPPORTED_COMPONENT', detail: 'TRANSACTIONS' });
    expect(new Set(pathsOf(h.venue))).toEqual(new Set([USERS_PATH, ORDERS_PATH, POSITIONS_PATH]));
    expect(caseOf(report, 'TRANSACTIONS_COMPONENT').class).toBe('UNKNOWN');
    expect(caseOf(report, 'OBSERVED_CONVERGENCE').class).toBe('NOT_OBSERVED');
  }, TIMEOUT);

  it('without a stream source every cycle revokes; the gap stays UNKNOWN and no quiet stream is synthesized', async () => {
    const h = await harness({ stream: false });
    const report = (await h.run(campaignConfig((c) => { c.maxCycles = 2; }))).report;
    expect(report.preflight.limitations).toContainEqual({ code: 'PRIVATE_STREAM_OBSERVATION_NOT_CONFIGURED_EVERY_CYCLE_REVOKES', effect: 'PREVENTS_CONVERGENCE' });
    expect(report.evaluations[0]!.result?.status).toBe('REVOKED_CYCLE_LIMIT_REACHED');
    expect(report.evaluations[0]!.stream).toEqual({ source: 'NOT_CONFIGURED', observation: 'UNKNOWN', quietStreamSynthesized: false });
    expect(report.revocations.map((entry) => entry.cycle)).toEqual([0, 1]);
    expect(report.revocations.every((entry) => entry.reasons.includes('STREAM_OBSERVATION_UNAVAILABLE'))).toBe(true);
    expect(report.gaps).toContainEqual({ evaluation: 0, gap: 'PRIVATE_STREAM_OBSERVATION_UNKNOWN', detail: 'NOT_CONFIGURED' });
    expect(report.observations.records['ORDERS:OWNED']).toBeGreaterThan(0); // REST observations are still collected and kept
    expect(caseOf(report, 'PRIVATE_STREAM_OBSERVATION').class).toBe('UNKNOWN');
    expect(caseOf(report, 'OBSERVED_CONVERGENCE').class).toBe('NOT_OBSERVED');
  }, TIMEOUT);

  it('a private event during a cycle revokes it; a fresh cycle may then converge', async () => {
    const h = await harness();
    let emitted = false;
    h.venue.respond = (path, body) => {
      if (path === ORDERS_PATH && !emitted) { emitted = true; h.stream.emit({ observedAtMs: h.clock.now() }); }
      return defaultAnswer(path, body);
    };
    const report = (await h.run(campaignConfig((c) => { c.maxCycles = 2; }))).report;
    expect(report.revocations).toEqual([{ evaluation: 0, cycle: 0, reasons: ['EVENT_OBSERVED_DURING_CYCLE', 'READ_CANCELLED'] }]);
    expect(report.evaluations[0]!.result?.status).toBe('OBSERVED_CONVERGENCE');
    expect(caseOf(report, 'PRIVATE_EVENT_REVOCATION').class).toBe('PASS');
  }, TIMEOUT);
});

describe('M4 read-only campaign: bounds, payload cases and stop conditions', () => {
  it('scans are bounded: full pages stop at the bound, are reported in the scan bounds, and do not converge', async () => {
    const h = await harness();
    let counter = 0;
    h.venue.respond = (path, body) => (path === ORDERS_PATH && body['side'] === 'buy'
      ? { status: 200, body: [orderWire({ id: `ex-f${counter += 1}` }), orderWire({ id: `ex-f${counter += 1}` })] } : defaultAnswer(path, body));
    const report = (await h.run()).report;
    expect(report.scanBounds.filter((entry) => entry.segment === 'side=buy')).toEqual([
      { evaluation: 0, cycle: 0, pass: 0, component: 'ORDERS', segment: 'side=buy', stop: 'SCAN_BOUND', pages: 3 },
      { evaluation: 0, cycle: 0, pass: 1, component: 'ORDERS', segment: 'side=buy', stop: 'SCAN_BOUND', pages: 3 },
    ]);
    expect(h.venue.hits.filter((hit) => hit.path === ORDERS_PATH && hit.body['side'] === 'buy')).toHaveLength(6);
    expect(caseOf(report, 'SCAN_BOUND_TRUNCATION').class).toBe('PASS');
    expect(report.evaluations[0]!.result?.status).toBe('UNRESOLVED');
  }, TIMEOUT);

  it('records after a short page, a missing field and unresolved ownership are observed as PASS cases (kept unresolved)', async () => {
    const h = await harness();
    h.venue.respond = (path, body) => {
      if (path === ORDERS_PATH && body['side'] === 'buy') {
        return { status: 200, body: body['page'] === '1' ? [orderWire({ cancelled_quantity: undefined })] : body['page'] === '2' ? [orderWire({ id: 'ex-2', client_order_id: 'bot-0002' })] : [] };
      }
      return defaultAnswer(path, body);
    };
    const report = (await h.run()).report;
    expect(caseOf(report, 'RECORDS_AFTER_SHORT_PAGE').class).toBe('PASS');
    expect(caseOf(report, 'MISSING_FIELD_GAP').class).toBe('PASS');
    expect(caseOf(report, 'UNRESOLVED_OWNERSHIP').class).toBe('PASS');
    expect(report.gaps).toContainEqual({ evaluation: 0, gap: 'FIELD_MISSING', detail: 'ORDERS:order:ex-1:cancelled_quantity' });
    expect(report.counts.FAIL).toBe(0);
  }, TIMEOUT);

  it('the campaign duration and the evaluation limit stop the schedule', async () => {
    const h = await harness();
    const byDuration = (await h.run(campaignConfig((c) => { c.campaign.durationMs = 15_000; c.campaign.maxEvaluations = 5; }))).report;
    expect(byDuration).toMatchObject({ status: 'COMPLETED', stopReason: 'NEXT_EVALUATION_OUTSIDE_DURATION' });
    expect(byDuration.evaluations).toHaveLength(2);
    const byCount = (await h.run(campaignConfig((c) => { c.campaign.maxEvaluations = 3; }))).report;
    expect(byCount).toMatchObject({ status: 'COMPLETED', stopReason: 'MAX_EVALUATIONS_REACHED' });
    expect(byCount.evaluations.map((evaluation) => evaluation.identity.outcome)).toEqual(['VERIFIED', 'VERIFIED', 'VERIFIED']); // identity before every evaluation
    expect(byCount.evaluations[1]!.startedAtMs - byCount.evaluations[0]!.startedAtMs).toBe(INTERVAL);
  }, TIMEOUT);

  it('consecutive failed-read evaluations stop the campaign (configured stop condition)', async () => {
    const h = await harness();
    h.venue.respond = (path, body) => (path === POSITIONS_PATH ? { status: 200, body: { not: 'an array' } } : defaultAnswer(path, body));
    const report = (await h.run(campaignConfig((c) => { c.campaign.maxEvaluations = 5; c.campaign.maxConsecutiveFailedReadEvaluations = 2; }))).report;
    expect(report).toMatchObject({ status: 'STOPPED', stopReason: 'CONSECUTIVE_FAILED_READ_EVALUATIONS' });
    expect(report.evaluations).toHaveLength(2);
    expect(caseOf(report, 'READ_FAILURE_EXPLICIT').class).toBe('PASS');
  }, TIMEOUT);
});

describe('M4 read-only campaign: cancellation, late responses and 429 through the shared coordinator', () => {
  it('cancellation stops launching reads; the in-flight read stays uncertain and its late result is abandoned', async () => {
    const f = fixture(limiterFixture());
    const started = await RateLimitCoordinator.start(f.coordinator);
    if (started.kind !== 'RUNNING') throw new Error(JSON.stringify(started));
    stops.push(() => started.coordinator.close());
    const limiterClient = new RateLimitClient(clientConfig(f.pipe)); stops.push(() => limiterClient.close());
    expect(await limiterClient.connect()).toBe(true);
    const h = await harness({ readBudget: { budget: createCoordinatorReadBudget(limiterClient, { cls: 'P1', deadlineInMs: 500 }), scope: 'API_AUTH' },
      coordinator: { status: () => ({ connected: limiterClient.session !== null, localStop: limiterClient.stopStatus.localLatch, coordinatorStop: limiterClient.stopStatus.coordinator }) } });
    const controller = new AbortController();
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    h.venue.respond = (path, body) => (path === ORDERS_PATH && body['side'] === 'buy' && body['page'] === '1' ? held.then(() => ({ status: 200, body: [orderWire()] })) : defaultAnswer(path, body));
    let primitiveCalls = 0;
    const counted: SyncCampaignReadClient = {
      getUserInfoSafe: () => { primitiveCalls += 1; return h.client.getUserInfoSafe(); },
      listInrFuturesOrders: request => { primitiveCalls += 1; return h.client.listInrFuturesOrders(request); },
      listInrFuturesPositions: request => { primitiveCalls += 1; return h.client.listInrFuturesPositions(request); },
    };
    const pending = h.run(campaignConfig((c) => { c.campaign.maxEvaluations = 3; }), controller.signal, counted);
    await waitFor(() => h.venue.hits.some((hit) => hit.path === ORDERS_PATH), 5_000, 'orders page in flight');
    controller.abort();
    const report = (await pending).report;
    expect(report).toMatchObject({ status: 'STOPPED', stopReason: 'CANCELLED' });
    expect(report.inFlight.unsettled.map((entry) => entry.read)).toContain('ORDERS');
    expect(report.inFlight).toMatchObject({ abortable: 'NO_READ_PRIMITIVE_ACCEPTS_A_SIGNAL', outcome: 'UNKNOWN_UNTIL_COMPLETION', budget: 'HELD_BY_THE_SHARED_BUDGET_UNTIL_COMPLETION_NEVER_RELEASED_HERE' });
    expect(caseOf(report, 'CANCELLATION').class).toBe('PASS');
    expect(started.coordinator.state.charges.some(charge => charge.slotHeld)).toBe(true);
    const callsAtStop = primitiveCalls;
    expect(callsAtStop).toBe(report.inFlight.started);
    const frozenReport = JSON.stringify(report);
    release();
    await waitFor(() => !started.coordinator.state.charges.some(charge => charge.slotHeld), 5_000, 'slot settled only after active request completes');
    expect(started.coordinator.state.charges.length).toBeGreaterThan(0); // rate-window starts remain charged; no refund
    await sleep(50);
    expect(primitiveCalls).toBe(callsAtStop); // zero new client calls, pages or evaluations
    // An already-invoked primitive awaiting its budget can reach the server after stop; it cannot be aborted here.
    expect(h.venue.hits.length).toBeLessThanOrEqual(callsAtStop);
    expect(JSON.stringify(report)).toBe(frozenReport); // a delivered report cannot acquire late observations
    const before = await harness();
    const aborted = new AbortController(); aborted.abort();
    expect((await before.run(campaignConfig(), aborted.signal)).report.stopReason).toBe('CANCELLED');
    expect(before.venue.hits).toEqual([]);
  }, TIMEOUT);

  it('duration expiry stops a held identity read and a held page, without starting another scan or recording a late result', async () => {
    for (const target of [USERS_PATH, ORDERS_PATH]) {
      const h = await harness();
      let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
      h.venue.respond = (path, body) => path === target ? held.then(() => defaultAnswer(path, body)) : defaultAnswer(path, body);
      const pending = h.run(campaignConfig(c => { c.campaign.durationMs = 500; c.campaign.maxEvaluations = 3; }));
      await waitFor(() => h.venue.hits.some(hit => hit.path === target), 5_000, 'held read started');
      h.clock.advance(500);
      const report = (await pending).report;
      expect(report).toMatchObject({ status: 'COMPLETED', stopReason: 'DURATION_REACHED' });
      expect(report.inFlight.unsettled.length).toBeGreaterThan(0);
      if (target === USERS_PATH) expect(accountHits(h.venue)).toBe(0);
      const hits = h.venue.hits.length;
      const snapshot = JSON.stringify(report);
      release(); await sleep(50);
      expect(h.venue.hits).toHaveLength(hits);
      expect(JSON.stringify(report)).toBe(snapshot);
      expect(report.reads.every(read => !read.report.pages.some(page => page.endedAtMs >= 10_500))).toBe(true);
    }
  }, TIMEOUT);

  it('a timed-out identity stays unverified after its late response, and no account scan starts', async () => {
    const h = await harness();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    h.venue.respond = (path, body) => path === USERS_PATH ? held.then(() => defaultAnswer(path, body)) : defaultAnswer(path, body);
    const pending = h.run();
    await waitFor(() => h.venue.hits.length === 1, 5_000, 'held identity read');
    h.clock.advance(1_000);
    const report = (await pending).report;
    expect(report.stopReason).toBe('ACCOUNT_IDENTITY_UNVERIFIED');
    expect(report.evaluations[0]!.identity.reason).toBe('ACCOUNT_IDENTITY_READ_TIMEOUT');
    release(); await sleep(50);
    expect(accountHits(h.venue)).toBe(0);
    expect(report.evaluations[0]!.identity.outcome).toBe('UNVERIFIED');
  }, TIMEOUT);

  it('coordinator loss during an evaluation refuses the next page and stops new scans', async () => {
    let connected = true;
    const h = await harness({ coordinator: { status: () => ({ ...CONNECTED, connected }) } });
    h.venue.respond = (path, body) => {
      if (path === ORDERS_PATH) connected = false;
      return defaultAnswer(path, body);
    };
    const report = (await h.run()).report;
    expect(report.stopReason).toBe('BUDGET_UNAVAILABLE');
    expect(h.venue.hits.filter(hit => hit.path === ORDERS_PATH)).toHaveLength(1);
    expect(h.venue.hits.every(hit => hit.body['page'] === undefined || hit.body['page'] === '1')).toBe(true);
  }, TIMEOUT);

  it('a late page result from a timed-out read is abandoned and kept apart from the observations', async () => {
    const h = await harness();
    let ordersCalls = 0; let usersCalls = 0; let ordersSettled = 0;
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    let releaseIdentity!: () => void; const identityHeld = new Promise<void>((resolve) => { releaseIdentity = resolve; });
    h.venue.respond = (path, body) => {
      if (path === USERS_PATH && (usersCalls += 1) === 2) return identityHeld.then(() => ({ status: 200, body: { coindcx_id: IDENTIFIER } }));
      if (path === ORDERS_PATH && body['side'] === 'buy' && body['page'] === '1' && (ordersCalls += 1) === 1) return held.then(() => ({ status: 200, body: [orderWire()] }));
      return defaultAnswer(path, body);
    };
    const counting: SyncCampaignReadClient = {
      getUserInfoSafe: () => h.client.getUserInfoSafe(),
      listInrFuturesOrders: async (request) => { try { return await h.client.listInrFuturesOrders(request); } finally { ordersSettled += 1; } },
      listInrFuturesPositions: (request) => h.client.listInrFuturesPositions(request),
    };
    const pending = h.run(campaignConfig((c) => { c.campaign.maxEvaluations = 2; }), undefined, counting);
    await waitFor(() => ordersCalls === 1, 5_000, 'first orders page in flight');
    h.clock.advance(1_000); // the orchestration's read timeout for that scan
    await waitFor(() => usersCalls === 2, 5_000, 'evaluation 1 identity read in flight');
    const settled = ordersSettled;
    release();
    await waitFor(() => ordersSettled > settled, 5_000, 'late page settled');
    releaseIdentity();
    const report = (await pending).report;
    expect(report.evaluations[0]!.result?.cycles[0]!.orchestrationReasons).toContain('READ_TIMEOUT');
    const lateOrders = report.lateReads.filter(read => read.evaluation === 0 && read.binding.pass === 0 && read.binding.component === 'ORDERS');
    expect(lateOrders).toHaveLength(1);
    expect(lateOrders[0]).toMatchObject({ evaluation: 0, binding: { cycle: 0, pass: 0, component: 'ORDERS' } });
    expect(lateOrders[0]!.report.stops).toEqual([{ segment: 'side=buy', stop: 'CANCELLED' }]);
    expect(lateOrders[0]!.report.pages).toEqual([]); // the late page was abandoned, not recorded
    expect(report.reads.some((read) => read.evaluation === 0 && read.binding.pass === 0 && read.binding.component === 'ORDERS')).toBe(false);
  }, TIMEOUT);

  it('a 429 reaches the shared coordinator and stops the campaign: no request storm', async () => {
    const f = fixture(limiterFixture({ retryAfter: { noHeaderDefaultMs: 60_000, providerStatedBlockMs: 60_000, localBackoffBaseMs: 60_000, localBackoffMaxMs: 60_000, operationalCapMs: 600_000, clockUncertaintyMs: 100 } }));
    const started = await RateLimitCoordinator.start(f.coordinator);
    if (started.kind !== 'RUNNING') throw new Error(JSON.stringify(started));
    stops.push(() => started.coordinator.close());
    const limiterClient = new RateLimitClient(clientConfig(f.pipe)); stops.push(() => limiterClient.close());
    expect(await limiterClient.connect()).toBe(true);
    const status = () => ({ connected: limiterClient.session !== null, localStop: limiterClient.stopStatus.localLatch, coordinatorStop: limiterClient.stopStatus.coordinator });
    const h = await harness({ readBudget: { budget: createCoordinatorReadBudget(limiterClient, { cls: 'P1', deadlineInMs: 500 }), scope: 'API_AUTH' }, coordinator: { status } });
    h.venue.respond = (path, body) => (path === ORDERS_PATH ? { status: 429, body: { message: 'too many requests' }, headers: { 'retry-after': '60' } } : defaultAnswer(path, body));
    const report = (await h.run(campaignConfig((c) => { c.scope.components = ['ORDERS']; c.campaign.maxEvaluations = 3; }))).report;
    expect(report).toMatchObject({ status: 'STOPPED', stopReason: 'PROVIDER_THROTTLE_OBSERVED' });
    await waitFor(() => started.coordinator.state.scopes.API_AUTH.kind !== 'CLEAR', 5_000, 'throttle recorded');
    expect(h.venue.hits.filter((hit) => hit.path === ORDERS_PATH)).toHaveLength(1);
    expect(report.evaluations[0]!.result?.status).toBe('CANCELLED'); // the read gate stopped the active orchestration
    expect(caseOf(report, 'BUDGET_REFUSAL_OR_THROTTLE').class).toBe('PASS');
  }, TIMEOUT);
});

describe('M4 read-only campaign: capabilities and grants', () => {
  it('uses only the identity read and the two supported account reads; no mutation, cancellation or hook capability is touched', async () => {
    const h = await harness();
    const accessed = new Set<string>();
    const forbidden = { createOrder: vi.fn(), cancelOrder: vi.fn(), cancelAllOrders: vi.fn(), exitPosition: vi.fn(), registerCancellationHook: vi.fn(),
      listInrFuturesTrades: vi.fn(), listInrFuturesPositionTransactions: vi.fn(), listFuturesWalletTransactions: vi.fn() };
    const wide = { getUserInfoSafe: () => h.client.getUserInfoSafe(), listInrFuturesOrders: (r: never) => h.client.listInrFuturesOrders(r),
      listInrFuturesPositions: (r: never) => h.client.listInrFuturesPositions(r), ...forbidden };
    const proxy = new Proxy(wide, { get(target, property) { accessed.add(String(property)); return (target as Record<string | symbol, unknown>)[property]; } });
    const report = (await h.run(campaignConfig((c) => { c.scope.components = ['ORDERS', 'POSITIONS', 'TRANSACTIONS']; }), undefined, proxy as unknown as SyncCampaignReadClient)).report;
    expect(report.evaluations[0]!.result).not.toBeNull();
    expect([...accessed].sort()).toEqual(['getUserInfoSafe', 'listInrFuturesOrders', 'listInrFuturesPositions']);
    for (const spy of Object.values(forbidden)) expect(spy).not.toHaveBeenCalled();
  }, TIMEOUT);

  it('no outcome grants authority', async () => {
    const h = await harness();
    const reports = [(await h.run()).report, (await h.run({})).report, (await h.run(campaignConfig((c) => { c.scope.components = ['TRANSACTIONS']; }))).report];
    for (const report of reports) {
      expect(report.grants).toBe(GRANTS_NOTHING);
      expect(report.preflight.grants).toBe(GRANTS_NOTHING);
      expect(Object.values(report.grants).every((value) => value === false)).toBe(true);
      for (const candidate of [report, report.preflight, ...report.evaluations, ...report.evaluations.map((evaluation) => evaluation.result)]) {
        expect(LiveExecutionAuthority.read(candidate)).toBeNull();
        expect(PracticalRecoveryCertificate.read(candidate)).toBeNull();
      }
      for (const evaluation of report.evaluations) expect(evaluation.result?.grants).toBe(GRANTS_NOTHING);
    }
    expect(currentAccountContinuityCapability()).toBe('REST_CURRENT_STATE_OBSERVED');
  }, TIMEOUT);
});
