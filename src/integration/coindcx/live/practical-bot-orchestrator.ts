import { setTimeout as delay } from 'node:timers/promises';
import { CoinRegistry, CoinRuntimeBootstrapService, mapInstrumentToMetadata, type CoinProfile, type InstrumentMetadata } from '../../../coin-runtime';
import { Decimal } from '../../../core/decimal/decimal';
import { AppError } from '../../../core/errors/app-error';
import { providerAccountFingerprint } from '../../../execution/live/reconciliation/account-identity';
import type { LiveVenueOrderEvidence, LiveVenuePositionEvidence } from '../../../execution/live/reconciliation/types';
import type { RestCandleRecord } from '../../../market-data/rest-candle-reader';
import { evidenceContentSha256, sha256CanonicalJson, type RiskDecision, type RiskEvaluationContext, type SettlementConversionSnapshot, type EvidenceProvenance } from '../../../risk';
import type { StrategyDecision } from '../../../strategies';
import type { CoinDcxClient } from '../client';
import { SystemClock, type Clock } from '../clock';
import { CoinDcxPrivateAccountStream } from '../websocket/private-stream';
import { ProductionCoinDcxSocketFactory } from '../websocket/socket-adapter';
import { CoinDcxReconciliationEvidenceAdapter } from './reconciliation-evidence-adapter';
import { botInstrumentSnapshotId, evaluateBotRisk, PracticalBotStrategySession,
  type PracticalBotObservedPosition, type PracticalBotRiskState, type PracticalBotStrategy } from './practical-bot-evaluation';

export interface PracticalBotExecutionRequest {
  readonly decision: RiskDecision;
  readonly context: RiskEvaluationContext;
  readonly maxInr: string;
  readonly accountFingerprint: string;
  readonly isCurrent: () => boolean;
}
export interface PracticalBotExecutionResult {
  readonly status: 'SUBMITTED' | 'REFUSED' | 'AMBIGUOUS';
  readonly ordersSubmitted: 0 | 1;
  readonly reasonCode: string;
}
export interface PracticalBotExecutionPort { execute(request: PracticalBotExecutionRequest): Promise<PracticalBotExecutionResult> }

export interface PracticalBotPairSummary {
  readonly pair: string;
  /** Observed venue minimum converted with this evaluation's settlement snapshot. */
  readonly minNotionalInr?: string | null;
  readonly signal: 'LONG' | 'SHORT' | 'FLAT' | 'WARMING' | 'UNAVAILABLE';
  readonly strategyDecision: StrategyDecision | null;
  readonly indicators: Readonly<Record<string, unknown>>;
  readonly riskDecision: RiskDecision | null;
  readonly riskReasonCodes: readonly string[];
  readonly riskEvidence: {
    readonly scope: 'VENUE' | 'OPERATOR_SHADOW';
    readonly equityInr: string | null;
    readonly availableMarginInr: string | null;
    readonly pendingReservationCount: number | null;
    readonly accountSnapshotAvailable: boolean;
    readonly exposureSnapshotAvailable: boolean;
    readonly pendingState: 'KNOWN' | 'UNKNOWN' | 'UNAVAILABLE';
    readonly ownershipStatus: 'RECONCILED' | 'UNRECONCILED';
    readonly tierSemanticsStatus: 'VERIFIED' | 'SEMANTICS_UNVERIFIED' | 'UNAVAILABLE';
    readonly entryStopProposal: RiskEvaluationContext['entryStopProposal'];
    readonly settlementRateSnapshot: RiskEvaluationContext['settlementRateSnapshot'];
  } | null;
  readonly sizing: { readonly targetQuantity: string; readonly targetNotionalInr: string; readonly finalLeverage: string | null } | null;
  readonly observedLeverageTiers: readonly { readonly leverage: string; readonly maxPositionSizeUsdt: string }[];
  readonly execution: { readonly status: 'READ_ONLY' | 'BLOCKED' | 'DUPLICATE' | 'SUBMITTED' | 'REFUSED' | 'AMBIGUOUS'; readonly reasonCode: string };
}

export type PracticalBotMode = 'DRY_RUN' | 'SHADOW' | 'TINY_LIVE';

export interface PracticalBotCandleQuery {
  readonly pair: string;
  /** Unix milliseconds, translated to provider seconds by the existing reader. */
  readonly from: number;
  readonly to: number;
  readonly resolution: '1';
}

export interface PracticalBotReadClient extends CoinDcxClient {
  getCandles(query: PracticalBotCandleQuery): Promise<readonly RestCandleRecord[]>;
}

export interface PracticalBotOptions {
  /** Application configuration is loaded by the CLI, outside the generic integration layer. */
  readonly profiles: readonly CoinProfile[];
  readonly mode?: PracticalBotMode;
  readonly confirmLive?: boolean;
  readonly coins?: readonly string[];
  readonly cycles?: number;
  readonly intervalMs?: number;
  readonly maxInr?: string;
  readonly equityInr?: string;
  readonly apiKey?: string | undefined;
  readonly apiSecret?: string | undefined;
  readonly signal?: AbortSignal;
  /** Shared request/evidence/market clock. The CLI may inject a verified server-adjusted clock. */
  readonly clock?: Clock;
  readonly strategy?: PracticalBotStrategy;
  /** CLI-owned, M2-budgeted public conversion read. */
  readonly readSettlementConversion?: () => Promise<SettlementConversionSnapshot>;
  readonly readRiskState?: (request: { readonly pair: string; readonly instrumentSpecSnapshotId: string;
    readonly strategyDecision: StrategyDecision; readonly evaluationTimeMs: number; readonly accountFingerprint: string | null;
    readonly instrument: InstrumentMetadata; readonly instrumentObservedAtMs: number;
    readonly positions: readonly PracticalBotObservedPosition[] | null; readonly settlementRateSnapshot: SettlementConversionSnapshot | null }) => Promise<PracticalBotRiskState>;
  /** Composition seam for an existing, budget-configured read client. */
  readonly client: PracticalBotReadClient;
  /** The CLI owns the concrete gateway import; production importer sets remain pinned. */
  readonly createLiveExecutor?: () => PracticalBotExecutionPort;
}

interface ObservationPass {
  readonly ordersSha256: string;
  readonly positionsSha256: string;
  readonly orderCount: number;
  readonly positionCount: number;
  readonly complete: boolean;
  readonly observedAtMs?: number;
  /** End-to-end two-endpoint read duration, including managed budget waits. */
  readonly readLatencyMs?: number;
}

export interface PracticalBotWalletObservation {
  readonly status: 'SKIPPED' | 'OBSERVED' | 'UNAVAILABLE';
  readonly snapshot: {
    readonly marginCurrency: 'INR'; readonly lockedInitialMarginInr: string;
    readonly crossOrderMarginInr: string | null; readonly crossUserMarginInr: string | null;
    readonly provenance: EvidenceProvenance;
  } | null;
  readonly accountRiskSnapshotAvailable: false;
  readonly reasonCode: string;
}

async function observeTwoPasses(adapter: CoinDcxReconciliationEvidenceAdapter, accountId: string, pairs: readonly string[], nowMs: () => number, signal?: AbortSignal) {
  const passes: ObservationPass[] = [];
  let observedOrders: readonly LiveVenueOrderEvidence[] = [], observedPositions: readonly LiveVenuePositionEvidence[] = [];
  let positions: readonly PracticalBotObservedPosition[] | null = null;
  for (let pass = 0; pass < 2 && !signal?.aborted; pass += 1) {
    const started = nowMs();
    const orders = await adapter.readOrders({ accountId, pairs, timeoutMs: 10_000 });
    if (signal?.aborted) break;
    const result = await adapter.readPositions({ accountId, timeoutMs: 10_000 });
    positions = result.positions;
    observedOrders = orders.orders.slice(0, 500); observedPositions = result.positions.slice(0, 500);
    passes.push({ ordersSha256: sha256CanonicalJson([...orders.orders].sort((a, b) => a.exchangeOrderId.localeCompare(b.exchangeOrderId))),
      positionsSha256: sha256CanonicalJson([...result.positions].sort((a, b) => a.venuePositionId.localeCompare(b.venuePositionId))),
      orderCount: orders.orders.length, positionCount: result.positions.length, complete: orders.provenance.complete && result.provenance.complete,
      observedAtMs: nowMs(), readLatencyMs: Math.max(0, nowMs() - started) });
  }
  const [first, second] = passes;
  const converged = first?.complete === true && second?.complete === true && first.ordersSha256 === second.ordersSha256 && first.positionsSha256 === second.positionsSha256;
  return { passes, positions, converged, records: { orders: observedOrders, positions: observedPositions,
    truncated: observedOrders.length !== passes.at(-1)?.orderCount || observedPositions.length !== passes.at(-1)?.positionCount } };
}

export interface PracticalBotAccountObservation {
  readonly status: 'SKIPPED_DRY_RUN' | 'SKIPPED_NO_CREDENTIALS' | 'UNRESOLVED' | 'OBSERVED_CONVERGENCE';
  readonly fingerprint: string | null;
  readonly streamState: string;
  readonly streamConnected: boolean;
  readonly passes: readonly ObservationPass[];
  readonly error: string | null;
  /** Two equal REST snapshots confer no execution or continuity authority. */
  readonly provesAccountContinuity: false;
  /** Bounded last-pass observations only. No ownership or execution authority. Older archives may omit them. */
  readonly records?: { readonly orders: readonly LiveVenueOrderEvidence[]; readonly positions: readonly LiveVenuePositionEvidence[]; readonly truncated: boolean };
}

export interface PracticalBotMarketCheck {
  readonly underlying: string;
  readonly pair: string;
  readonly latestClose: string | null;
  readonly candleCount: number;
  readonly maxLeverage: string;
  readonly status: 'OBSERVED' | 'NO_CANDLES' | 'UNAVAILABLE';
  readonly error: string | null;
}

export interface PracticalBotRunReport {
  readonly mode: PracticalBotMode;
  readonly status: 'COMPLETED' | 'DEGRADED' | 'STOPPED';
  readonly requestedCoins: readonly string[];
  readonly requestedCycles: number;
  readonly intervalMs: number;
  readonly maxInr: string;
  readonly equityInr: string | null;
  readonly strategy: PracticalBotStrategy;
  readonly gatewayConstructed: boolean;
  readonly ordersSubmitted: number;
  readonly discovery: {
    readonly instruments: readonly { readonly underlying: string; readonly pair: string }[];
    readonly failures: readonly { readonly underlying: string; readonly category: string }[];
  };
  readonly account: PracticalBotAccountObservation;
  readonly cycles: readonly {
    readonly cycle: number;
    readonly from: number;
    readonly to: number;
    readonly wallet: PracticalBotWalletObservation;
    readonly settlementReadError: string | null;
    readonly markets: readonly PracticalBotMarketCheck[];
    readonly pairSummaries: readonly PracticalBotPairSummary[];
  }[];
}

function readFailure(error: unknown, fallback: string): string {
  if (error instanceof Error && ['SHADOW_CAPITAL_INVALID', 'SHADOW_CAPITAL_WRITE_FAILED', 'SHADOW_EQUITY_BASELINE_MISMATCH',
    'SHADOW_RESERVATION_IDENTITY_MISMATCH', 'SHADOW_CAPITAL_NOT_LIVE_AUTHORITY', 'INVALID_LEVERAGE_TIERS'].includes(error.message)) return error.message;
  // Only fixed local refusal reasons may cross the reporting boundary.
  const reason = (error as { details?: { reason?: unknown } } | null)?.details?.reason;
  if (reason === 'READ_BUDGET_MISSING' || reason === 'PRODUCTION_READ_BUDGET_UNBOUND') return reason;
  // HTTP 422 alone cannot distinguish an expired key from a bad timestamp or payload.
  // Keep the endpoint and status, never guess a cause or reflect a provider body/message.
  if (error instanceof AppError && Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) {
    const path = error.details?.['path'];
    const endpoint = path === '/exchange/v1/users/info' ? 'USER_INFO'
      : path === '/exchange/v1/derivatives/futures/orders' ? 'FUTURES_ORDERS'
      : path === '/exchange/v1/derivatives/futures/positions' ? 'FUTURES_POSITIONS' : null;
    if (endpoint) return `${endpoint}_HTTP_${error.statusCode}`;
  }
  return fallback;
}

export class PracticalBotOrchestrator {
  readonly #options: PracticalBotOptions;
  readonly #mode: PracticalBotMode;
  readonly #coins: readonly string[];
  readonly #cycles: number;
  readonly #intervalMs: number;
  readonly #maxInr: string;
  readonly #clock: Clock;
  readonly #strategy: PracticalBotStrategy;

  public constructor(options: PracticalBotOptions) {
    this.#mode = options.mode ?? 'SHADOW';
    if (!['DRY_RUN', 'SHADOW', 'TINY_LIVE'].includes(this.#mode)) throw new Error('INVALID_BOT_MODE');
    if (this.#mode === 'TINY_LIVE' && options.confirmLive !== true) {
      throw new Error('TINY_LIVE_REQUIRES_EXPLICIT_CONFIRM_FLAG');
    }
    this.#cycles = options.cycles ?? 1;
    this.#intervalMs = options.intervalMs ?? 5000;
    if (!Number.isSafeInteger(this.#cycles) || this.#cycles < 1) throw new Error('INVALID_CYCLES');
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 0 || this.#intervalMs > 2_147_483_647) {
      throw new Error('INVALID_INTERVAL_MS');
    }
    const maxInr = options.maxInr ?? '500';
    if (!/^\d+(?:\.\d+)?$/.test(maxInr) || !new Decimal(maxInr).isPositive()) throw new Error('INVALID_MAX_INR');
    this.#maxInr = new Decimal(maxInr).toFixed();
    if (options.equityInr !== undefined && (!/^\d+(?:\.\d+)?$/.test(options.equityInr)
      || !new Decimal(options.equityInr).isFinite() || !new Decimal(options.equityInr).gt(0))) throw new Error('INVALID_EQUITY_INR');
    this.#coins = [...new Set((options.coins ?? options.profiles.map(profile => profile.underlying)).map(coin => coin.trim().toUpperCase()))];
    if (this.#coins.length === 0 || this.#coins.some(coin => !/^[A-Z0-9]+$/.test(coin))) throw new Error('INVALID_COINS');
    this.#options = options;
    this.#clock = options.clock ?? new SystemClock();
    this.#strategy = options.strategy ?? 'ema-trend';
    if (this.#strategy !== 'ema-trend' && this.#strategy !== 'rsi-momentum') throw new Error('INVALID_STRATEGY');
  }

  public async run(): Promise<PracticalBotRunReport> {
    const options = this.#options;
    const hasCredentials = Boolean(options.apiKey?.trim() && options.apiSecret?.trim());
    if (this.#mode === 'TINY_LIVE' && !hasCredentials) throw new Error('TINY_LIVE_REQUIRES_CREDENTIALS');
    if (this.#mode === 'TINY_LIVE' && !options.createLiveExecutor) throw new Error('TINY_LIVE_REQUIRES_GATEWAY_FACTORY');
    const selected = new Set(this.#coins);
    const allProfiles = options.profiles;
    if (this.#coins.some(coin => !allProfiles.some(profile => profile.underlying === coin))) {
      throw new Error('REQUESTED_COIN_PROFILE_NOT_FOUND');
    }
    const client = options.client;
    const operatorShadow = this.#mode !== 'TINY_LIVE' && options.equityInr !== undefined && options.readRiskState !== undefined;
    const registry = new CoinRegistry();
    const discoveryErrors = new Map<string, string>();
    const instrumentObservations = new Map<string, { instrument: InstrumentMetadata; observedAtMs: number }>();
    const bootstrap = new CoinRuntimeBootstrapService({
      findActiveInrPerpetualByUnderlying: async underlying => {
        if (options.signal?.aborted) throw new Error('STOPPED');
        try {
          const found = await client.findActiveInrPerpetualByUnderlying(underlying);
          if (found) instrumentObservations.set(found.pair, { instrument: mapInstrumentToMetadata(found, underlying), observedAtMs: this.#clock.nowMs() });
          return found;
        }
        catch (error) { discoveryErrors.set(underlying, readFailure(error, 'DISCOVERY_FAILED')); throw error; }
      },
    }, registry);
    const discovery = await bootstrap.bootstrap(allProfiles.filter(profile => selected.has(profile.underlying)));
    const active = registry.list().filter(runtime => runtime.instrument?.status.toLowerCase() === 'active');
    const sessions = new Map(active.map(runtime => [runtime.instrument!.pair, new PracticalBotStrategySession(this.#strategy)]));
    const dispatched = new Set<string>();
    let observedPositions: readonly PracticalBotObservedPosition[] | null = null;
    let observedAtMs = 0;
    let executionPort: PracticalBotExecutionPort | undefined;
    let executionHalted = false;
    let ordersSubmitted = 0;
    const cycles: PracticalBotRunReport['cycles'][number][] = [];
    let gatewayConstructed = false;
    let account: PracticalBotAccountObservation = {
      status: this.#mode === 'DRY_RUN' ? 'SKIPPED_DRY_RUN' : hasCredentials ? 'UNRESOLVED' : 'SKIPPED_NO_CREDENTIALS',
      fingerprint: null, streamState: 'STOPPED', streamConnected: false, passes: [], error: null,
      provesAccountContinuity: false,
    };
    let stream: CoinDcxPrivateAccountStream | undefined;
    let observationAdapter: CoinDcxReconciliationEvidenceAdapter | undefined;
    let streamRevision = 0;
    let observedStreamRevision = 0;
    let unsubscribe: (() => void) | undefined;
    const stopStream = () => { stream?.stop(); };
    options.signal?.addEventListener('abort', stopStream, { once: true });
    try {
      if (!options.signal?.aborted && this.#mode !== 'DRY_RUN' && hasCredentials) {
        try {
          const userInfo = await client.getUserInfoSafe();
          const fingerprint = providerAccountFingerprint(userInfo.coindcxId);
          account = { ...account, fingerprint };
          if (!options.signal?.aborted) {
            stream = new CoinDcxPrivateAccountStream({
              apiKey: options.apiKey!, apiSecret: options.apiSecret!, socketFactory: new ProductionCoinDcxSocketFactory(),
              clock: this.#clock,
            });
            unsubscribe = stream.subscribe(() => { streamRevision += 1; });
            try { await stream.start(); }
            catch { account = { ...account, error: 'PRIVATE_STREAM_START_FAILED' }; }
            account = { ...account, streamState: stream.state, streamConnected: stream.connected };
            // This adapter only needs the client methods in the read port. No mutation client is supplied.
            observationAdapter = new CoinDcxReconciliationEvidenceAdapter({
              client, credentialAccountId: fingerprint, clock: this.#clock,
            });
            const revision = streamRevision;
            const observation = await observeTwoPasses(observationAdapter, fingerprint, active.map(runtime => runtime.instrument!.pair), () => this.#clock.nowMs(), options.signal);
            const converged = observation.converged && streamRevision === revision;
            account = { ...account, passes: observation.passes, records: observation.records, status: converged ? 'OBSERVED_CONVERGENCE' : 'UNRESOLVED' };
            if (converged) { observedPositions = observation.positions; observedAtMs = this.#clock.nowMs(); observedStreamRevision = streamRevision; }
          }
        } catch (error) { account = { ...account, status: 'UNRESOLVED', error: readFailure(error, 'ACCOUNT_OBSERVATION_FAILED') }; }
      }
      if (!options.signal?.aborted && this.#mode === 'TINY_LIVE' && options.confirmLive === true
        && account.status === 'OBSERVED_CONVERGENCE' && account.error === null) {
        executionPort = options.createLiveExecutor!();
        gatewayConstructed = true;
      }
      for (let cycle = 1; cycle <= this.#cycles && !options.signal?.aborted; cycle += 1) {
        if (cycle > 1 && observationAdapter && account.fingerprint) {
          const fingerprint = account.fingerprint;
          observedPositions = null;
          account = { ...account, status: 'UNRESOLVED' };
          const revision = streamRevision;
          const observation = await observeTwoPasses(observationAdapter, fingerprint, active.map(runtime => runtime.instrument!.pair), () => this.#clock.nowMs(), options.signal);
          const converged = observation.converged && revision === streamRevision;
          account = { ...account, passes: observation.passes, records: observation.records, status: converged ? 'OBSERVED_CONVERGENCE' : 'UNRESOLVED' };
          if (converged) { observedPositions = observation.positions; observedAtMs = this.#clock.nowMs(); observedStreamRevision = streamRevision; }
        }
        let wallet: PracticalBotWalletObservation = { status: 'SKIPPED', snapshot: null, accountRiskSnapshotAvailable: false,
          reasonCode: 'PRIVATE_ACCOUNT_NOT_OBSERVED' };
        if (this.#mode !== 'DRY_RUN' && account.fingerprint && !options.signal?.aborted) {
          try {
            const value = await client.getInrFuturesWallet();
            if (value.currency !== 'INR' || !value.lockedInitialMargin.isFinite() || value.lockedInitialMargin.lt(0)) throw new Error('INVALID_WALLET');
            const snapshot = { marginCurrency: 'INR' as const, lockedInitialMarginInr: value.lockedInitialMargin.toFixed(),
              crossOrderMarginInr: value.crossOrderMargin?.toFixed() ?? null, crossUserMarginInr: value.crossUserMargin?.toFixed() ?? null,
              provenance: { sourceId: 'BOT_INR_WALLET_OBSERVATION_V1', sourceTimeMs: null, observedAtMs: this.#clock.nowMs(), contentSha256: '' } };
            wallet = { status: 'OBSERVED', snapshot: { ...snapshot, provenance: { ...snapshot.provenance, contentSha256: evidenceContentSha256(snapshot) } },
              accountRiskSnapshotAvailable: false, reasonCode: 'ACCOUNT_EQUITY_AND_HISTORY_NOT_EXPOSED' };
          } catch { wallet = { status: 'UNAVAILABLE', snapshot: null, accountRiskSnapshotAvailable: false, reasonCode: 'INR_WALLET_READ_FAILED' }; }
        }
        let settlementRateSnapshot: SettlementConversionSnapshot | null = null;
        let settlementReadError: string | null = options.readSettlementConversion ? null : 'SETTLEMENT_READER_NOT_CONFIGURED';
        if (!operatorShadow && options.readSettlementConversion && !options.signal?.aborted) {
          try { settlementRateSnapshot = await options.readSettlementConversion(); }
          catch { settlementReadError = 'SETTLEMENT_CONVERSION_READ_FAILED'; }
        }
        const currentMinute = Math.floor(this.#clock.nowMs() / 60_000) * 60_000;
        const from = currentMinute - 60 * 60_000;
        const to = currentMinute - 1;
        const markets: PracticalBotMarketCheck[] = [];
        const pairSummaries: PracticalBotPairSummary[] = [];
        for (const runtime of active) {
          if (options.signal?.aborted) break;
          let observation = instrumentObservations.get(runtime.instrument!.pair)!;
          let instrument = observation.instrument;
          const base = { underlying: runtime.profile.underlying, pair: instrument.pair,
            maxLeverage: instrument.dynamicPositionLeverageTiers[0]?.leverage.toFixed() ?? '1' };
          try {
            // A delayed limiter or a long run must refetch metadata, never relabel an old fetch as fresh.
            if (!operatorShadow && this.#clock.nowMs() - observation.observedAtMs > 45_000) {
              const refreshed = mapInstrumentToMetadata(await client.getInrFuturesInstrument(instrument.pair), runtime.profile.underlying);
              if (refreshed.pair !== instrument.pair) throw new Error('INSTRUMENT_SPEC_MISMATCH');
              observation = { instrument: refreshed, observedAtMs: this.#clock.nowMs() };
              instrumentObservations.set(instrument.pair, observation);
              instrument = refreshed;
            }
            const candles = await client.getCandles({ pair: instrument.pair, from, to, resolution: '1' });
            const candleObservedAtMs = this.#clock.nowMs();
            let pairSettlement = settlementRateSnapshot;
            if (operatorShadow) {
              // Acquire real provider metadata/conversion for this pair after any candle admission wait.
              const refreshed = mapInstrumentToMetadata(await client.getInrFuturesInstrument(instrument.pair), runtime.profile.underlying);
              if (refreshed.pair !== instrument.pair) throw new Error('INSTRUMENT_SPEC_MISMATCH');
              observation = { instrument: refreshed, observedAtMs: this.#clock.nowMs() };
              instrumentObservations.set(instrument.pair, observation);
              instrument = refreshed;
              if (options.readSettlementConversion) {
                try { pairSettlement = await options.readSettlementConversion(); }
                catch { pairSettlement = null; settlementReadError = 'SETTLEMENT_CONVERSION_READ_FAILED'; }
              }
            }
            const latest = [...candles].sort((a, b) => a.openTimeMs - b.openTimeMs).at(-1);
            markets.push({ ...base, maxLeverage: instrument.dynamicPositionLeverageTiers[0]?.leverage.toFixed() ?? '1',
              latestClose: latest?.close.toFixed() ?? null, candleCount: candles.length,
              status: latest ? 'OBSERVED' : 'NO_CANDLES', error: null });
            const evaluated = sessions.get(instrument.pair)!.evaluate(instrument.pair, candles, this.#clock.nowMs());
            let now = this.#clock.nowMs();
            const riskFingerprint = account.fingerprint ?? (operatorShadow ? sha256CanonicalJson({ scope: 'OPERATOR_SHADOW_OFFLINE_V1' }) : null);
            const positionsForRisk = streamRevision === observedStreamRevision && !stream?.isReconciliationRequired ? observedPositions : null;
            const riskState = evaluated.decision?.status === 'READY' ? await options.readRiskState?.({
              pair: instrument.pair, instrumentSpecSnapshotId: botInstrumentSnapshotId(instrument), strategyDecision: evaluated.decision,
              evaluationTimeMs: now, accountFingerprint: riskFingerprint, instrument, instrumentObservedAtMs: observation.observedAtMs,
              positions: positionsForRisk, settlementRateSnapshot: pairSettlement,
            }) : undefined;
            if (this.#mode === 'TINY_LIVE' && riskState?.scope === 'OPERATOR_SHADOW') throw new Error('SHADOW_CAPITAL_NOT_LIVE_AUTHORITY');
            // Projection acquisition may await I/O. Evaluate at completion, without restamping its evidence.
            now = this.#clock.nowMs();
            const state: PracticalBotRiskState = { accountSnapshot: null, exposureSnapshot: null, settlementRateSnapshot: pairSettlement, ...riskState };
            const risk = evaluated.decision && evaluated.kernel ? evaluateBotRisk({ kernel: evaluated.kernel, decision: evaluated.decision,
              instrument, instrumentObservedAtMs: observation.observedAtMs, positionObservedAtMs: observedAtMs, evaluationTimeMs: now, maxInr: this.#maxInr,
              ...(latest === undefined ? {} : { latestClosedCandle: latest }), candleObservedAtMs: operatorShadow ? now : candleObservedAtMs,
              accountFingerprint: riskFingerprint, positions: positionsForRisk, state }) : null;
            let execution: PracticalBotPairSummary['execution'] = this.#mode === 'TINY_LIVE'
              ? { status: 'BLOCKED', reasonCode: 'RISK_OR_ACCOUNT_NOT_AUTHORIZED' } : { status: 'READ_ONLY', reasonCode: this.#mode };
            const isCurrent = () => !options.signal?.aborted && !executionHalted && account.status === 'OBSERVED_CONVERGENCE'
              && account.error === null && this.#clock.nowMs() - observedAtMs <= 10_000 && streamRevision === observedStreamRevision && !stream?.isReconciliationRequired;
            if (this.#mode === 'TINY_LIVE' && risk?.decision?.status === 'ACCEPTED' && risk.context && executionPort && account.fingerprint && isCurrent()) {
              if (dispatched.has(risk.decision.sourceStrategyDecisionId)) execution = { status: 'DUPLICATE', reasonCode: 'DECISION_ALREADY_DISPATCHED' };
              else if (new Decimal(risk.decision.approved.approvedNotionalInr).gt(this.#maxInr)) execution = { status: 'BLOCKED', reasonCode: 'MAX_INR_EXCEEDED' };
              else {
                dispatched.add(risk.decision.sourceStrategyDecisionId); // Reserve before awaiting; never retry an ambiguous invocation.
                let result: PracticalBotExecutionResult;
                try { result = await executionPort.execute({ decision: risk.decision, context: risk.context, maxInr: this.#maxInr,
                  accountFingerprint: account.fingerprint, isCurrent }); }
                catch { result = { status: 'AMBIGUOUS', ordersSubmitted: 1, reasonCode: 'EXECUTION_OUTCOME_UNESTABLISHED' }; }
                ordersSubmitted += result.ordersSubmitted;
                execution = { status: result.status, reasonCode: result.reasonCode };
                // Every attempted mutation invalidates the observations used by this run. No second dispatch without fresh reconciliation.
                executionHalted = true;
              }
            }
            pairSummaries.push({ pair: instrument.pair,
              minNotionalInr: pairSettlement ? instrument.minNotional.times(pairSettlement.rateInrPerUsdt).toFixed() : null,
              signal: evaluated.decision?.status === 'WARMING' ? 'WARMING'
              : evaluated.decision?.targetExposure ?? 'UNAVAILABLE', strategyDecision: evaluated.decision, indicators: evaluated.indicators,
              riskDecision: risk?.decision ?? null, riskReasonCodes: risk?.reasonCodes ?? ['NO_CLOSED_CANDLES'],
              sizing: risk?.decision?.status === 'ACCEPTED' ? { targetQuantity: risk.decision.approved.approvedQuantity,
                targetNotionalInr: risk.decision.approved.approvedNotionalInr,
                finalLeverage: risk.decision.action === 'OPEN' ? risk.decision.approved.approvedLeverage : null } : null,
              riskEvidence: risk?.context ? { scope: state.scope ?? 'VENUE', equityInr: risk.context.accountSnapshot?.currentEquityInr ?? null,
                availableMarginInr: risk.context.accountSnapshot?.availableMarginInr ?? null,
                pendingReservationCount: risk.context.exposureSnapshot?.pending.status === 'KNOWN' ? risk.context.exposureSnapshot.pending.pendingReservationCount : null,
                accountSnapshotAvailable: risk.context.accountSnapshot !== null,
                exposureSnapshotAvailable: risk.context.exposureSnapshot !== null, pendingState: risk.context.exposureSnapshot?.pending.status ?? 'UNAVAILABLE',
                ownershipStatus: risk.context.pairSnapshot.ownership.status, tierSemanticsStatus: risk.context.leverageTierSnapshot?.semanticsStatus ?? 'UNAVAILABLE',
                entryStopProposal: risk.context.entryStopProposal, settlementRateSnapshot: risk.context.settlementRateSnapshot } : null,
              observedLeverageTiers: instrument.dynamicPositionLeverageTiers.map(tier => ({ leverage: tier.leverage.toFixed(), maxPositionSizeUsdt: tier.maxPositionSizeUsdt.toFixed() })), execution });
          } catch (error) {
            if (!markets.some(market => market.pair === instrument.pair)) markets.push({ ...base, latestClose: null, candleCount: 0, status: 'UNAVAILABLE', error: readFailure(error, 'MARKET_DATA_READ_FAILED') });
            pairSummaries.push({ pair: instrument.pair, signal: 'UNAVAILABLE', strategyDecision: null, indicators: {}, riskDecision: null,
              riskReasonCodes: [readFailure(error, 'PAIR_EVALUATION_FAILED')], riskEvidence: null, sizing: null, observedLeverageTiers: [],
              execution: { status: 'BLOCKED', reasonCode: readFailure(error, 'PAIR_EVALUATION_FAILED') } });
          }
        }
        cycles.push({ cycle, from, to, wallet, settlementReadError, markets, pairSummaries });
        if (cycle < this.#cycles && !options.signal?.aborted) {
          try { await delay(this.#intervalMs, undefined, { signal: options.signal }); }
          catch (error) { if (!options.signal?.aborted) throw error; }
        }
      }
      if (stream) account = { ...account, streamState: stream.state, streamConnected: stream.connected };
    } finally {
      unsubscribe?.();
      stream?.stop();
      options.signal?.removeEventListener('abort', stopStream);
    }
    const degraded = discovery.failures.length > 0 || active.length === 0 || account.status === 'UNRESOLVED' || account.error !== null
      || cycles.some(cycle => cycle.markets.some(market => market.status !== 'OBSERVED') || cycle.pairSummaries.some(pair => pair.signal === 'UNAVAILABLE' || pair.execution.status === 'AMBIGUOUS'));
    return {
      mode: this.#mode, status: options.signal?.aborted ? 'STOPPED' : degraded ? 'DEGRADED' : 'COMPLETED',
      requestedCoins: this.#coins, requestedCycles: this.#cycles, intervalMs: this.#intervalMs, maxInr: this.#maxInr, equityInr: options.equityInr ?? null,
      strategy: this.#strategy, gatewayConstructed, ordersSubmitted,
      discovery: {
        instruments: active.map(runtime => ({ underlying: runtime.profile.underlying, pair: runtime.instrument!.pair })),
        failures: discovery.failures.map(failure => ({ underlying: failure.underlying, category: discoveryErrors.get(failure.underlying) ?? failure.category })),
      },
      account, cycles,
    };
  }
}
