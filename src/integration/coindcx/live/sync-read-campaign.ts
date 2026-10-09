/**
 * M4 (unwired review candidate): a bounded, read-only synchronization collection campaign runner
 * (docs/M4_READ_ONLY_CAMPAIGN_PLAN.md). It composes the existing CoinDCX read adapter and the asynchronous
 * orchestration through explicit dependencies. It constructs no client, transport, budget or stream, reads no
 * configuration, environment or credentials, binds nothing in production, and is composed nowhere.
 *
 * Capabilities. The injected client is narrowed to three reads: the existing identity read (`getUserInfoSafe`) and
 * the two supported account reads (`listInrFuturesOrders`, `listInrFuturesPositions`). The runner holds no execution
 * service, mutation gateway, order submission, cancellation or cancellation-hook capability.
 *
 * Order of work (every evaluation):
 *   1. the preflight (once) must allow collection;
 *   2. the shared budget coordinator must be connected and not stopped;
 *   3. the expected provider account fingerprint is verified through the existing identity read, reduced and
 *      compared by the injected existing functions and compared exactly again here; no account read starts first;
 *   4. one orchestration run (cycles of two REST passes between stream observations) over the adapter.
 *
 * Stops. No further read is launched after cancellation, a budget refusal, a provider throttle, an identity mismatch
 * or unverified identity, a failed coverage case, the configured consecutive-failure limit, the evaluation limit or the
 * campaign duration. A read already in flight cannot be aborted (the read primitives accept no signal): its result is
 * abandoned, its budget charge is held by the shared budget until it completes, and it is reported as uncertain.
 *
 * Provenance. The adapter's echoed binding is local correlation only. Account provenance is separate: the credential
 * binding declared in the configuration, checked by the identity read at evaluation start (provider trading account at
 * read time; no continuity, exclusive use or per-response account identity).
 *
 * Stream. Without an injected private-stream source every stream observation is unavailable, which revokes every
 * cycle. That gap stays UNKNOWN; a quiet stream is never synthesized.
 *
 * Classes. PASS (observed, expected behaviour held), FAIL (observed, expected behaviour did not hold), NOT_OBSERVED
 * (did not occur) and UNKNOWN (not decidable by passive reads) are counted separately and never folded together.
 * Every report grants nothing; D4c and AS1 stay pending.
 */
import type { CoinDcxClient } from '../client';
import {
  runAsyncSynchronizationCandidate,
  type AsyncClock,
  type AsyncCycleRecord,
  type AsyncReadBinding,
  type AsyncSynchronizationResult,
  type AsyncSynchronizationSource,
} from '../../../execution/live/practical-synchronization/async-orchestrator';
import { createCoinDcxSyncReadAdapter, type SyncReadAdapterReport, type SyncReadRequest } from './sync-read-adapter';
import {
  GRANTS_NOTHING,
  preflightSyncReadCampaign,
  SYNC_CAMPAIGN_DECISIONS,
  SYNC_CAMPAIGN_FINGERPRINT_PATTERN,
  type SyncCampaignScopeLabel,
  type SyncReadCampaignPlan,
  type SyncReadCampaignPreflight,
  type SyncReadCampaignRuntimeStatus,
} from './sync-read-campaign-preflight';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** The only client capabilities the campaign may use. */
export type SyncCampaignReadClient = Pick<CoinDcxClient, 'getUserInfoSafe' | 'listInrFuturesOrders' | 'listInrFuturesPositions'>;

export type SyncCampaignIdentityRead = Readonly<{ kind: 'OBSERVED'; fingerprint: string }> | Readonly<{ kind: 'UNAVAILABLE'; reason: string }>;
/**
 * The existing identity reduction and comparison, injected (the reconciliation account-identity module's
 * `providerAccountFingerprint` and `verifyProviderAccountIdentity`); the runner does not reimplement them.
 */
export interface SyncCampaignIdentityFunctions {
  fingerprint(providerAccountIdentifier: string): string;
  verify(expectedFingerprint: string, read: SyncCampaignIdentityRead): Readonly<{ kind: string; reason?: string }>;
}

export type SyncCampaignCoordinatorStatus = Readonly<{ connected: boolean; localStop: boolean; coordinatorStop: string }>;
export type SyncCampaignReportDestination = Readonly<{ kind: 'LOCAL_FILE'; path: string }>;

export interface SyncReadCampaignDependencies {
  readonly config: unknown;
  /** An already-constructed authenticated read client paced by the shared read budget. Never constructed here. */
  readonly client: SyncCampaignReadClient;
  readonly authenticatedClient: SyncReadCampaignRuntimeStatus['authenticatedClient'];
  readonly identity: SyncCampaignIdentityFunctions;
  /** The shared budget coordinator connection's status (for example a connected limiter client's session and stop status). */
  readonly coordinator: Readonly<{ status(): SyncCampaignCoordinatorStatus }> | null;
  /** A private-stream observation source, or null (every stream observation is then unavailable and UNKNOWN). */
  readonly stream: Pick<AsyncSynchronizationSource, 'observeStream' | 'subscribeEvents'> | null;
  readonly clock: AsyncClock;
  readonly reportSink: Readonly<{ write(destination: SyncCampaignReportDestination, report: SyncReadCampaignReport): Promise<void> }> | null;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type SyncCampaignStopReason =
  | 'PREFLIGHT_BLOCKED' | 'DURATION_REACHED' | 'NEXT_EVALUATION_OUTSIDE_DURATION' | 'MAX_EVALUATIONS_REACHED' | 'CANCELLED' | 'BUDGET_UNAVAILABLE' | 'PROVIDER_THROTTLE_OBSERVED'
  | 'ACCOUNT_IDENTITY_MISMATCH' | 'ACCOUNT_IDENTITY_UNVERIFIED' | 'CONSECUTIVE_FAILED_READ_EVALUATIONS' | 'CASE_FAILED';
export type SyncCampaignCaseClass = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_OBSERVED';
export type SyncCampaignCase = Readonly<{ id: string; class: SyncCampaignCaseClass; basis: string }>;
export type SyncCampaignIdentityCheck = Readonly<{
  evaluation: number;
  outcome: 'VERIFIED' | 'MISMATCH' | 'UNVERIFIED';
  reason: string | null;
  /** Only for a mismatch: enough for an operator to tell bindings apart. The raw identifier is never kept. */
  observedFingerprintPrefix: string | null;
}>;
export type SyncCampaignAdapterRead = Readonly<{ evaluation: number; binding: AsyncReadBinding; report: SyncReadAdapterReport }>;
export type SyncCampaignEvaluation = Readonly<{
  index: number;
  startedAtMs: number;
  endedAtMs: number;
  identity: SyncCampaignIdentityCheck;
  /** Null when the evaluation stopped before the orchestration ran (no account read was launched). */
  result: AsyncSynchronizationResult | null;
  stream: Readonly<{ source: 'INJECTED' | 'NOT_CONFIGURED'; observation: 'AS_OBSERVED' | 'UNKNOWN'; quietStreamSynthesized: false }>;
}>;

export type SyncReadCampaignReport = Readonly<{
  kind: 'SYNC_READ_CAMPAIGN_REPORT';
  status: 'PREFLIGHT_BLOCKED' | 'COMPLETED' | 'STOPPED';
  stopReason: SyncCampaignStopReason;
  scopeLabel: SyncCampaignScopeLabel;
  fullAccountSynchronization: 'NOT_CLAIMED';
  preflight: SyncReadCampaignPreflight;
  decisions: typeof SYNC_CAMPAIGN_DECISIONS;
  accountProvenance: Readonly<{
    credentialBinding: string | null;
    identityChecks: readonly SyncCampaignIdentityCheck[];
    scope: 'PROVIDER_TRADING_ACCOUNT_AT_READ_TIME';
    readResponsesCarryAccountIdentity: false;
    provesAccountContinuity: false;
    provesExclusiveUse: false;
  }>;
  correlation: Readonly<{ kind: 'ADAPTER_LOCAL_ECHO'; providerReturnedIdentity: 'NONE'; isProviderProof: false }>;
  evaluations: readonly SyncCampaignEvaluation[];
  reads: readonly SyncCampaignAdapterRead[];
  /** Adapter results that arrived after their evaluation ended: abandoned, never attributed as observations. */
  lateReads: readonly SyncCampaignAdapterRead[];
  observations: Readonly<{ evaluations: number; convergedEvaluations: number; cycles: number; records: Readonly<Record<string, number>> }>;
  gaps: readonly Readonly<{ evaluation: number | null; gap: string; detail: string }>[];
  revocations: readonly Readonly<{ evaluation: number; cycle: number; reasons: readonly string[] }>[];
  scanBounds: readonly Readonly<{ evaluation: number; cycle: number; pass: 0 | 1; component: string; segment: string; stop: string; pages: number }>[];
  inFlight: Readonly<{
    started: number;
    settled: number;
    unsettled: readonly Readonly<{ read: string; startedAtMs: number }>[];
    abortable: 'NO_READ_PRIMITIVE_ACCEPTS_A_SIGNAL';
    outcome: 'UNKNOWN_UNTIL_COMPLETION';
    budget: 'HELD_BY_THE_SHARED_BUDGET_UNTIL_COMPLETION_NEVER_RELEASED_HERE';
    refusedAfterStop: number;
  }>;
  coverage: readonly SyncCampaignCase[];
  counts: Readonly<Record<SyncCampaignCaseClass, number>>;
  historyCompleteness: 'UNPROVEN';
  grants: typeof GRANTS_NOTHING;
}>;

export type SyncReadCampaignOutcome = Readonly<{ report: SyncReadCampaignReport; delivery: 'WRITTEN' | 'FAILED' | 'NOT_ATTEMPTED' }>;

// ---------------------------------------------------------------------------
// Read gate: the narrowed client, with stop, refusal and in-flight accounting
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Raised locally (no request) for any read after the campaign stopped launching reads. */
export class SyncReadCampaignStoppedError extends Error {
  public constructor() { super('Synchronization read campaign stopped: no further read is launched'); this.name = 'SyncReadCampaignStoppedError'; }
}

type ReadName = 'IDENTITY' | 'ORDERS' | 'POSITIONS';

class ReadGate {
  public stop: SyncCampaignStopReason | null = null;
  /** Reads started when the gate closed; every later read is refused before it starts. */
  public startedAtClose: number | null = null;
  public started = 0;
  public settled = 0;
  public refusedAfterStop = 0;
  public budgetRefusals = 0;
  public throttles = 0;
  public readonly unsettled = new Set<Readonly<{ read: ReadName; startedAtMs: number }>>();
  public constructor(private readonly clock: AsyncClock, private readonly authorize: () => SyncCampaignStopReason | null,
    private readonly onClose: () => void) {}

  public close(reason: SyncCampaignStopReason): void {
    if (this.stop === null) { this.stop = reason; this.startedAtClose = this.started; this.onClose(); }
  }
  /** Reads started after the gate closed (must stay zero), or null while it is open. */
  public get startedAfterClose(): number | null { return this.startedAtClose === null ? null : this.started - this.startedAtClose; }

  public async read<T>(read: ReadName, invoke: () => Promise<T>): Promise<T> {
    const refusal = this.authorize();
    if (refusal !== null) this.close(refusal);
    if (this.stop !== null) { this.refusedAfterStop += 1; throw new SyncReadCampaignStoppedError(); }
    const entry = Object.freeze({ read, startedAtMs: this.clock.now() });
    this.started += 1;
    this.unsettled.add(entry);
    try {
      return await invoke();
    } catch (error) {
      // A budget refusal or a provider throttle stops every further read.
      const details = isRecord(error) ? error['details'] : undefined;
      if (isRecord(details) && details['readBudget'] === 'REFUSED') { this.budgetRefusals += 1; this.close('BUDGET_UNAVAILABLE'); }
      else if (isRecord(error) && error['code'] === 'COINDCX_RATE_LIMIT') { this.throttles += 1; this.close('PROVIDER_THROTTLE_OBSERVED'); }
      throw error;
    } finally {
      this.unsettled.delete(entry);
      this.settled += 1;
    }
  }
}

type Settled<T> = Readonly<{ kind: 'OK'; value: T }> | Readonly<{ kind: 'TIMEOUT' | 'CANCELLED' | 'REJECTED' }>;
/** Awaits `work` until it settles, `ms` elapses on the injected clock, or `signal` aborts. */
async function within<T>(work: () => Promise<T>, ms: number, clock: AsyncClock, signal: AbortSignal): Promise<Settled<T>> {
  if (signal.aborted) return { kind: 'CANCELLED' };
  const timer = new AbortController();
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<Settled<T>>((resolve) => { onAbort = () => resolve({ kind: 'CANCELLED' }); signal.addEventListener('abort', onAbort, { once: true }); });
  try {
    return await Promise.race<Settled<T>>([
      work().then((value): Settled<T> => ({ kind: 'OK', value }), (): Settled<T> => ({ kind: 'REJECTED' })),
      clock.delay(ms, timer.signal).then((): Settled<T> => ({ kind: 'TIMEOUT' }), () => new Promise<never>(() => undefined)),
      aborted,
    ]);
  } finally {
    timer.abort();
    signal.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// Coverage classification
// ---------------------------------------------------------------------------

/** Cases passive reads cannot decide (docs/M4_READ_ONLY_CAMPAIGN_PLAN.md). Always UNKNOWN. */
const UNDECIDABLE: readonly Readonly<{ id: string; basis: string }>[] = Object.freeze([
  { id: 'EXCLUSIVE_ACCOUNT_USE', basis: 'C1: no origin field; passive reads cannot exclude other activity' },
  { id: 'STREAM_JOIN_AND_DELIVERY_COMPLETENESS', basis: 'D2: a quiet stream proves nothing' },
  { id: 'ATOMIC_CONSISTENCY_BETWEEN_READS', basis: 'B12: no sequence or gap detection' },
  { id: 'COMPLETE_HISTORY_AND_TERMINAL_PAGE_CONTRACT', basis: 'B8, B9: terminations are observed, the contract is not confirmed' },
  { id: 'STABLE_FILL_IDENTITY_AND_FILL_ACCOUNTING', basis: 'B3, B13: stable fill semantics unresolved' },
  { id: 'TAG_CONTRACT_AND_ECHO', basis: 'C2, C3' },
  { id: 'VENUE_GENERATED_EVENT_REPRESENTATION', basis: 'C5a-C5d' },
  { id: 'TRANSACTIONS_COMPONENT', basis: 'CLIENT_ADAPTER_UNSUPPORTED; not evidence about the provider' },
]);

/** What the classification reads: the collected evaluations and reads, and the read gate's stop facts. */
export interface SyncCampaignCollected {
  readonly evaluations: readonly SyncCampaignEvaluation[];
  readonly reads: readonly SyncCampaignAdapterRead[];
  readonly gate: Readonly<{ stop: SyncCampaignStopReason | null; startedAfterClose: number | null; budgetRefusals: number; throttles: number }>;
  readonly streamInjected: boolean;
}

function cycleOf(collected: SyncCampaignCollected, evaluation: number, cycle: number): AsyncCycleRecord | null {
  return collected.evaluations[evaluation]?.result?.cycles.find((entry) => entry.cycle === cycle) ?? null;
}

/** Observed if `observed` is non-empty; FAIL if any observed instance breaks `held`. */
function judge<T>(id: string, observed: readonly T[], held: (instance: T) => boolean, basis: string): SyncCampaignCase {
  if (observed.length === 0) return Object.freeze({ id, class: 'NOT_OBSERVED' as const, basis });
  return Object.freeze({ id, class: observed.every(held) ? 'PASS' as const : 'FAIL' as const, basis });
}

/** Classifies every coverage case as PASS, FAIL, NOT_OBSERVED or UNKNOWN. Pure. */
export function classifySyncReadCampaign(collected: SyncCampaignCollected): SyncCampaignCase[] {
  const { reads, evaluations, gate } = collected;
  const notConverged = (read: SyncCampaignAdapterRead): boolean => cycleOf(collected, read.evaluation, read.binding.cycle)?.status !== 'OBSERVED_CONVERGENCE';
  const segmentsOf = (read: SyncCampaignAdapterRead): string[] => [...new Set(read.report.pages.map((page) => page.segment))];
  const cycles = evaluations.flatMap((evaluation) => (evaluation.result?.cycles ?? []).map((cycle) => ({ evaluation: evaluation.index, cycle })));
  const converged = evaluations.filter((evaluation) => evaluation.result?.status === 'OBSERVED_CONVERGENCE');
  const cases: SyncCampaignCase[] = [
    judge('OBSERVED_CONVERGENCE', converged, (evaluation) => evaluation.result!.historyCompleteness.status === 'UNPROVEN'
      && reads.filter((read) => read.evaluation === evaluation.index && read.binding.cycle === evaluation.result!.cycles.at(-1)!.cycle)
        .every((read) => read.report.failure === null && read.report.gaps.length === 0 && read.report.support === 'SUPPORTED' && read.report.stops.every((stop) => stop.stop === 'EMPTY_PAGE')),
    collected.streamInjected ? 'two agreeing passes; history stays unproven' : 'cannot occur: private-stream observation not configured'),
    judge('EMPTY_PAGE_TERMINATION', reads.flatMap((read) => read.report.stops.filter((stop) => stop.stop === 'EMPTY_PAGE').map((stop) => read.report.pages.filter((page) => page.segment === stop.segment))
      .filter((pages) => pages.length > 1)), (pages) => pages.at(-1)!.records === 0, 'a multi-page segment ended at an empty page, never at a short one'),
    judge('SCAN_BOUND_TRUNCATION', reads.filter((read) => read.report.stops.some((stop) => stop.stop === 'SCAN_BOUND')), notConverged, 'the bound stops the scan and the cycle does not converge'),
    judge('RECORDS_AFTER_SHORT_PAGE', reads.filter((read) => segmentsOf(read).some((segment) => {
      const pages = read.report.pages.filter((page) => page.segment === segment);
      return pages.some((page, index) => page.records > 0 && page.records < page.requestedSize && pages.slice(index + 1).some((later) => later.records > 0));
    })), notConverged, 'records after a short page are kept and the cycle does not converge'),
    judge('PRIVATE_EVENT_REVOCATION', cycles.filter(({ cycle }) => cycle.localObservedEventCount > 0), ({ cycle }) => cycle.status === 'REVOKED', 'an event during a cycle revokes it'),
    judge('READ_FAILURE_EXPLICIT', reads.filter((read) => read.report.support === 'SUPPORTED' && read.report.failure !== null), notConverged, 'a failed read is explicit and the cycle does not converge'),
    judge('MISSING_FIELD_GAP', reads.filter((read) => read.report.gaps.length > 0), notConverged, 'a missing field is an explicit gap and the cycle does not converge'),
    judge('UNRESOLVED_OWNERSHIP', cycles.filter(({ cycle }) => (cycle.engine?.records ?? []).some((entry) => entry.records.some((record) => record.ownership === 'UNRESOLVED'))),
      ({ cycle }) => cycle.status !== 'OBSERVED_CONVERGENCE', 'unresolved ownership keeps the cycle unresolved'),
    judge('BUDGET_REFUSAL_OR_THROTTLE', gate.budgetRefusals + gate.throttles > 0 || gate.stop === 'BUDGET_UNAVAILABLE' ? [gate.startedAfterClose] : [],
      (after) => after === 0, 'no read is launched after a refusal, a throttle or an unavailable coordinator'),
    judge('ACCOUNT_IDENTITY_MISMATCH', evaluations.filter((evaluation) => evaluation.identity.outcome === 'MISMATCH'),
      (evaluation) => evaluation.result === null && gate.startedAfterClose === 0, 'zero account reads after a mismatch'),
    judge('CANCELLATION', gate.stop === 'CANCELLED' ? [gate.startedAfterClose] : [], (after) => after === 0, 'no read is launched after cancellation'),
    judge('AUTHORITY_GRANTS_ALL_FALSE', [GRANTS_NOTHING, ...evaluations.flatMap((evaluation) => (evaluation.result === null ? [] : [evaluation.result.grants]))],
      (grants) => grants === GRANTS_NOTHING && Object.values(grants).every((value) => value === false), 'every grant is a literal false'),
  ];
  for (const entry of UNDECIDABLE) cases.push(Object.freeze({ id: entry.id, class: 'UNKNOWN' as const, basis: entry.basis }));
  if (!collected.streamInjected || evaluations.some(evaluation => evaluation.stream.observation === 'UNKNOWN')) {
    cases.push(Object.freeze({ id: 'PRIVATE_STREAM_OBSERVATION', class: 'UNKNOWN' as const,
      basis: collected.streamInjected ? 'observation unavailable; never synthesized as quiet' : 'not configured; never synthesized as quiet' }));
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Runs the bounded read-only collection. Never throws for a provider or budget failure; every outcome grants nothing. */
export async function runSyncReadCampaign(deps: SyncReadCampaignDependencies): Promise<SyncReadCampaignOutcome> {
  const { clock, identity, stream, reportSink } = deps;
  const signal = deps.signal ?? new AbortController().signal;
  const coordinatorStatus = (): SyncCampaignCoordinatorStatus | null => {
    try { return deps.coordinator === null ? null : deps.coordinator.status(); } catch { return null; }
  };
  const preflight = preflightSyncReadCampaign(deps.config, { authenticatedClient: deps.authenticatedClient,
    coordinator: coordinatorStatus(), stream: stream === null ? 'NOT_CONFIGURED' : 'INJECTED', reportSink: reportSink !== null });
  const campaignControl = new AbortController();
  const campaignSignal = campaignControl.signal;
  const durationTimer = new AbortController();
  let deadline: number | null = null;
  const authorize = (): SyncCampaignStopReason | null => {
    if (signal.aborted) return 'CANCELLED';
    if (deadline !== null && clock.now() >= deadline) return 'DURATION_REACHED';
    const status = coordinatorStatus();
    return status === null || status.connected !== true || status.localStop !== false || status.coordinatorStop !== 'NONE' ? 'BUDGET_UNAVAILABLE' : null;
  };
  const gate = new ReadGate(clock, authorize, () => campaignControl.abort());
  const evaluations: SyncCampaignEvaluation[] = [];
  const reads: SyncCampaignAdapterRead[] = [];
  const lateReads: SyncCampaignAdapterRead[] = [];
  const onAbort = (): void => { gate.close('CANCELLED'); };
  signal.addEventListener('abort', onAbort, { once: true });

  const finish = async (stopReason: SyncCampaignStopReason, plan: SyncReadCampaignPlan | null): Promise<SyncReadCampaignOutcome> => {
    signal.removeEventListener('abort', onAbort);
    durationTimer.abort();
    gate.close(stopReason);
    const report = buildReport({ preflight, stopReason, plan, evaluations, reads, lateReads, gate, streamInjected: stream !== null });
    if (plan === null || reportSink === null) return Object.freeze({ report, delivery: 'NOT_ATTEMPTED' as const });
    try { await reportSink.write(plan.reportDestination, report); return Object.freeze({ report, delivery: 'WRITTEN' as const }); } catch { return Object.freeze({ report, delivery: 'FAILED' as const }); }
  };

  const plan = preflight.plan;
  if (!preflight.startable || plan === null) return finish('PREFLIGHT_BLOCKED', null);
  if (signal.aborted) { onAbort(); return finish('CANCELLED', plan); }

  // The narrowed client: identity plus the two supported account reads, all through the gate.
  const client = deps.client;
  const narrowed = Object.freeze({
    listInrFuturesOrders: (request: Parameters<SyncCampaignReadClient['listInrFuturesOrders']>[0]) => gate.read('ORDERS', () => client.listInrFuturesOrders(request)),
    listInrFuturesPositions: (request: Parameters<SyncCampaignReadClient['listInrFuturesPositions']>[0]) => gate.read('POSITIONS', () => client.listInrFuturesPositions(request)),
  });
  const adapter = createCoinDcxSyncReadAdapter({
    client: narrowed, accountProvenance: { kind: 'CREDENTIAL_BOUND', accountId: deps.authenticatedClient!.accountId }, orderStatuses: plan.orderStatuses, clock,
  });
  if (adapter === null) return finish('PREFLIGHT_BLOCKED', null);

  const startedAtMs = clock.now();
  deadline = startedAtMs + plan.campaign.durationMs;
  // Stop even during identity, stream observation or a held page; active requests keep their existing budget charge.
  void clock.delay(plan.campaign.durationMs, durationTimer.signal).then(() => gate.close('DURATION_REACHED'), () => undefined);
  let consecutiveFailedReads = 0;
  for (let index = 0; ; index += 1) {
    if (gate.stop !== null) return finish(gate.stop, plan);
    if (index >= plan.campaign.maxEvaluations) return finish('MAX_EVALUATIONS_REACHED', plan);
    if (clock.now() - startedAtMs >= plan.campaign.durationMs) return finish('DURATION_REACHED', plan);
    const refusal = authorize();
    if (refusal !== null) { gate.close(refusal); return finish(refusal, plan); }

    const evaluationStartedAtMs = clock.now();
    const identityCheck = await checkIdentity(index, plan, gate, client, identity, clock, campaignSignal);
    const streamView = Object.freeze({ source: stream === null ? 'NOT_CONFIGURED' as const : 'INJECTED' as const, observation: stream === null ? 'UNKNOWN' as const : 'AS_OBSERVED' as const, quietStreamSynthesized: false as const });
    if (identityCheck.outcome !== 'VERIFIED') {
      evaluations.push(Object.freeze({ index, startedAtMs: evaluationStartedAtMs, endedAtMs: clock.now(), identity: identityCheck, result: null, stream: streamView }));
      if (gate.stop !== null) return finish(gate.stop, plan);
      if (identityCheck.outcome === 'MISMATCH') { gate.close('ACCOUNT_IDENTITY_MISMATCH'); return finish('ACCOUNT_IDENTITY_MISMATCH', plan); }
      gate.close('ACCOUNT_IDENTITY_UNVERIFIED');
      return finish('ACCOUNT_IDENTITY_UNVERIFIED', plan);
    }

    let open = true;
    const source: AsyncSynchronizationSource = {
      scan: async (request) => {
        const scanControl = new AbortController();
        const scanTimer = new AbortController();
        const abortScan = (): void => scanControl.abort();
        request.signal.addEventListener('abort', abortScan, { once: true });
        if (request.signal.aborted) abortScan();
        // The orchestration owns the timeout verdict; this signal additionally prevents another page after expiry.
        void clock.delay(plan.orchestration.readTimeoutMs, scanTimer.signal).then(abortScan, () => undefined);
        try {
          const response = await adapter.scan({ ...request, signal: scanControl.signal } as unknown as SyncReadRequest);
          const report = isRecord(response) ? response['adapter'] as SyncReadAdapterReport | undefined : undefined;
          if (report !== undefined) (open && !scanControl.signal.aborted ? reads : lateReads).push(Object.freeze({ evaluation: index, binding: request.binding, report }));
          return response;
        } finally {
          scanTimer.abort();
          request.signal.removeEventListener('abort', abortScan);
        }
      },
      observeStream: async (request) => {
        const observation = stream === null ? null : await stream.observeStream(request);
        if (observation === null || observation === undefined) throw new Error('PRIVATE_STREAM_OBSERVATION_UNAVAILABLE');
        return observation;
      },
      subscribeEvents: stream === null ? () => () => undefined : (listener) => stream.subscribeEvents(listener),
    };
    const result = await runAsyncSynchronizationCandidate({ config: plan.synchronization, limits: plan.orchestration, source, clock, signal: campaignSignal });
    open = false;
    const streamUnavailable = stream === null || result.cycles.some(cycle => cycle.orchestrationReasons.includes('STREAM_OBSERVATION_UNAVAILABLE'));
    evaluations.push(Object.freeze({ index, startedAtMs: evaluationStartedAtMs, endedAtMs: clock.now(), identity: identityCheck, result,
      stream: streamUnavailable ? Object.freeze({ ...streamView, observation: 'UNKNOWN' as const }) : streamView }));

    if (gate.stop !== null) return finish(gate.stop, plan);
    if (result.status === 'CANCELLED' || signal.aborted) return finish('CANCELLED', plan);
    const failedRead = reads.some((read) => read.evaluation === index && read.report.support === 'SUPPORTED' && read.report.failure !== null)
      || result.cycles.some((cycle) => cycle.reads.some((read) => read.outcome !== 'RESPONSE'));
    consecutiveFailedReads = failedRead ? consecutiveFailedReads + 1 : 0;
    const partial = classifySyncReadCampaign({ evaluations, reads, gate, streamInjected: stream !== null });
    if (partial.some((entry) => entry.class === 'FAIL')) return finish('CASE_FAILED', plan);
    if (consecutiveFailedReads >= plan.campaign.maxConsecutiveFailedReadEvaluations) return finish('CONSECUTIVE_FAILED_READ_EVALUATIONS', plan);

    const more = index + 1 < plan.campaign.maxEvaluations && clock.now() + plan.campaign.evaluationIntervalMs - startedAtMs < plan.campaign.durationMs;
    if (!more) return finish(index + 1 >= plan.campaign.maxEvaluations ? 'MAX_EVALUATIONS_REACHED' : 'NEXT_EVALUATION_OUTSIDE_DURATION', plan);
    try { await clock.delay(plan.campaign.evaluationIntervalMs, campaignSignal); } catch {
      return finish(gate.stop ?? 'CANCELLED', plan);
    }
  }
}

/** The identity read, reduced to a fingerprint at once, verified by the injected function and compared exactly here. */
async function checkIdentity(evaluation: number, plan: SyncReadCampaignPlan, gate: ReadGate, client: SyncCampaignReadClient,
  identity: SyncCampaignIdentityFunctions, clock: AsyncClock, signal: AbortSignal): Promise<SyncCampaignIdentityCheck> {
  const expected = plan.account.expectedProviderAccountFingerprint;
  const settled = await within(() => gate.read('IDENTITY', async () => (await client.getUserInfoSafe()).coindcxId), plan.identityReadTimeoutMs, clock, signal);
  let read: SyncCampaignIdentityRead;
  if (settled.kind === 'OK') {
    let fingerprint: string | null = null;
    try { fingerprint = typeof settled.value === 'string' && settled.value.length > 0 ? identity.fingerprint(settled.value) : null; } catch { fingerprint = null; }
    read = fingerprint === null ? { kind: 'UNAVAILABLE', reason: 'ACCOUNT_IDENTITY_MISSING' } : { kind: 'OBSERVED', fingerprint };
  } else {
    read = { kind: 'UNAVAILABLE', reason: settled.kind === 'TIMEOUT' ? 'ACCOUNT_IDENTITY_READ_TIMEOUT' : settled.kind === 'CANCELLED' ? 'ACCOUNT_IDENTITY_READ_CANCELLED' : 'ACCOUNT_IDENTITY_READ_FAILED' };
  }
  let verdict: Readonly<{ kind: string; reason?: string }>;
  try { verdict = identity.verify(expected, read); } catch { verdict = { kind: 'ACCOUNT_IDENTITY_UNVERIFIED', reason: 'IDENTITY_VERIFICATION_FAILED' }; }
  const observed = read.kind === 'OBSERVED' && SYNC_CAMPAIGN_FINGERPRINT_PATTERN.test(read.fingerprint) ? read.fingerprint : null;
  if (observed !== null && observed === expected && verdict.kind === 'ACCOUNT_IDENTITY_VERIFIED') {
    return Object.freeze({ evaluation, outcome: 'VERIFIED' as const, reason: null, observedFingerprintPrefix: null });
  }
  if (observed !== null && observed !== expected) {
    return Object.freeze({ evaluation, outcome: 'MISMATCH' as const, reason: 'ACCOUNT_IDENTITY_MISMATCH', observedFingerprintPrefix: observed.slice(0, 12) });
  }
  const reason = read.kind === 'UNAVAILABLE' ? read.reason : (verdict.reason ?? 'IDENTITY_VERIFICATION_INCONSISTENT');
  return Object.freeze({ evaluation, outcome: 'UNVERIFIED' as const, reason, observedFingerprintPrefix: null });
}

function buildReport(input: Readonly<{
  preflight: SyncReadCampaignPreflight; stopReason: SyncCampaignStopReason; plan: SyncReadCampaignPlan | null; evaluations: readonly SyncCampaignEvaluation[];
  reads: readonly SyncCampaignAdapterRead[]; lateReads: readonly SyncCampaignAdapterRead[]; gate: ReadGate; streamInjected: boolean;
}>): SyncReadCampaignReport {
  const { preflight, stopReason, plan, evaluations, reads, gate } = input;
  const coverage = preflight.startable
    ? classifySyncReadCampaign({ evaluations, reads, gate, streamInjected: input.streamInjected })
    : UNDECIDABLE.map((entry) => Object.freeze({ id: entry.id, class: 'UNKNOWN' as const, basis: entry.basis }));
  const counts = { PASS: 0, FAIL: 0, UNKNOWN: 0, NOT_OBSERVED: 0 };
  for (const entry of coverage) counts[entry.class] += 1;
  const records: Record<string, number> = {};
  const cycles = evaluations.flatMap((evaluation) => (evaluation.result?.cycles ?? []).map((cycle) => ({ evaluation: evaluation.index, cycle })));
  for (const { cycle } of cycles) {
    for (const entry of cycle.engine?.records ?? []) for (const record of entry.records) records[`${entry.component}:${record.ownership}`] = (records[`${entry.component}:${record.ownership}`] ?? 0) + 1;
  }
  const gaps: Array<Readonly<{ evaluation: number | null; gap: string; detail: string }>> = [];
  if (preflight.limitations.some(entry => entry.code === 'OWNERSHIP_LINEAGE_UNAVAILABLE')) gaps.push(Object.freeze({ evaluation: null, gap: 'OWNERSHIP_LINEAGE_UNAVAILABLE', detail: 'NO_DURABLE_OWNERSHIP_ASSERTIONS_SUPPLIED' }));
  for (const entry of preflight.unsupportedRequiredComponents) gaps.push(Object.freeze({ evaluation: null, gap: 'CLIENT_ADAPTER_UNSUPPORTED_COMPONENT', detail: entry.component }));
  for (const evaluation of evaluations) if (evaluation.stream.observation === 'UNKNOWN') gaps.push(Object.freeze({ evaluation: evaluation.index, gap: 'PRIVATE_STREAM_OBSERVATION_UNKNOWN',
    detail: evaluation.stream.source === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'UNAVAILABLE' }));
  for (const read of reads) for (const gap of read.report.gaps) gaps.push(Object.freeze({ evaluation: read.evaluation, gap: 'FIELD_MISSING', detail: `${read.binding.component}:${gap.key}:${gap.field}` }));
  return Object.freeze({
    kind: 'SYNC_READ_CAMPAIGN_REPORT' as const,
    status: stopReason === 'PREFLIGHT_BLOCKED' ? 'PREFLIGHT_BLOCKED' as const
      : ['DURATION_REACHED', 'NEXT_EVALUATION_OUTSIDE_DURATION', 'MAX_EVALUATIONS_REACHED'].includes(stopReason) ? 'COMPLETED' as const : 'STOPPED' as const,
    stopReason,
    scopeLabel: preflight.scopeLabel,
    fullAccountSynchronization: 'NOT_CLAIMED' as const,
    preflight,
    decisions: SYNC_CAMPAIGN_DECISIONS,
    accountProvenance: Object.freeze({
      credentialBinding: plan?.account.accountId ?? null,
      identityChecks: Object.freeze(evaluations.map((evaluation) => evaluation.identity)),
      scope: 'PROVIDER_TRADING_ACCOUNT_AT_READ_TIME' as const,
      readResponsesCarryAccountIdentity: false as const, provesAccountContinuity: false as const, provesExclusiveUse: false as const,
    }),
    correlation: Object.freeze({ kind: 'ADAPTER_LOCAL_ECHO' as const, providerReturnedIdentity: 'NONE' as const, isProviderProof: false as const }),
    evaluations: Object.freeze([...evaluations]),
    reads: Object.freeze([...reads]),
    lateReads: Object.freeze([...input.lateReads]),
    observations: Object.freeze({
      evaluations: evaluations.length,
      convergedEvaluations: evaluations.filter((evaluation) => evaluation.result?.status === 'OBSERVED_CONVERGENCE').length,
      cycles: cycles.length,
      records: Object.freeze(records),
    }),
    gaps: Object.freeze(gaps),
    revocations: Object.freeze(cycles.filter(({ cycle }) => cycle.status === 'REVOKED').map(({ evaluation, cycle }) => Object.freeze({ evaluation, cycle: cycle.cycle, reasons: cycle.reasons }))),
    scanBounds: Object.freeze(reads.flatMap((read) => read.report.stops.map((stop) => Object.freeze({
      evaluation: read.evaluation, cycle: read.binding.cycle, pass: read.binding.pass, component: read.binding.component, segment: stop.segment, stop: stop.stop,
      pages: read.report.pages.filter((page) => page.segment === stop.segment).length,
    })))),
    inFlight: Object.freeze({
      started: gate.started, settled: gate.settled, unsettled: Object.freeze([...gate.unsettled]),
      abortable: 'NO_READ_PRIMITIVE_ACCEPTS_A_SIGNAL' as const, outcome: 'UNKNOWN_UNTIL_COMPLETION' as const,
      budget: 'HELD_BY_THE_SHARED_BUDGET_UNTIL_COMPLETION_NEVER_RELEASED_HERE' as const, refusedAfterStop: gate.refusedAfterStop,
    }),
    coverage: Object.freeze(coverage),
    counts: Object.freeze(counts),
    historyCompleteness: 'UNPROVEN' as const,
    grants: GRANTS_NOTHING,
  });
}
