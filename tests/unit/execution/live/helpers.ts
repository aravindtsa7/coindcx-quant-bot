import { RiskAdmissionCoordinator } from '../../../../src/dispatch/admission';
import {
  mintLiveOpenExecutionAuthority,
  type MintedLiveExecutionAuthority,
} from '../../../../src/execution/live/authority';
import {
  buildLiveExecutionPolicySnapshot,
  defaultLiveExecutionPolicyContent,
  type LiveExecutionPolicyContent,
  type LiveExecutionPolicySnapshot,
} from '../../../../src/execution/live/execution-policy';
import { resolveLiveExecutionGate, type LiveExecutionConfigInput, type LiveExecutionEnablement } from '../../../../src/execution/live/gate';
import type {
  CoinDcxFuturesOrderGateway,
  LiveCancelOrderRequest,
  LiveCancelOrderResult,
  LiveFetchOrderRequest,
  LiveFetchOrderResult,
  LivePlaceOrderRequest,
  LivePlaceOrderResult,
} from '../../../../src/execution/live/gateway';
import type { AuthoritativeInstrumentConstraints } from '../../../../src/execution/live/instrument-constraints';
import type { LiveExecutionIntentRecord, LiveExecutionShapeRequest } from '../../../../src/execution/live/intent';
import {
  liveExecutionIntentContentSha256,
  observationSha256,
  type ClaimCancelOutcome,
  type ClaimDispatchOutcome,
  type CompleteCancelAttemptOutcome,
  type LiveExecutionRepository,
  type LivePositionOwnershipRecord,
} from '../../../../src/execution/live/repository';
import { applyLiveOrderObservation, initialLiveOrderState } from '../../../../src/execution/live/state-machine';
import type { LiveOrderObservation, LiveOrderStateRecord } from '../../../../src/execution/live/types';
import { LiveExecutionError } from '../../../../src/execution/live/errors';
import { buildContext, evaluateDecision, genuineResearchApproval, makeKernel, policyFor, PAIR } from '../../dispatch/helpers';
import { seal } from '../../risk/helpers';
import type { RiskEvaluationContext } from '../../../../src/risk';

export const LIVE_ACCOUNT = 'account-live-1';
export const OTHER_ACCOUNT = 'account-live-2';
export const T0 = 1_200_000;

/** A configuration record that genuinely enables live mutation. */
export function enabledLiveConfig(overrides: Partial<LiveExecutionConfigInput> = {}): LiveExecutionConfigInput {
  return {
    NODE_ENV: 'production',
    LIVE_EXECUTION_ENABLED: 'true',
    LIVE_EXECUTION_ACCOUNT_ALLOWLIST: `${LIVE_ACCOUNT},${OTHER_ACCOUNT}`,
    LIVE_EXECUTION_PAIR_ALLOWLIST: 'B-BTC_USDT,B-ETH_USDT,B-SOL_USDT',
    LIVE_EXECUTION_MAX_ORDER_NOTIONAL_INR: '10000000',
    COINDCX_API_KEY: 'test-key',
    COINDCX_API_SECRET: 'test-secret',
    COINDCX_LIVE_ACCOUNT_ID: LIVE_ACCOUNT,
    ...overrides,
  };
}

export function genuineEnablement(overrides: Partial<LiveExecutionConfigInput> = {}): LiveExecutionEnablement {
  const resolution = resolveLiveExecutionGate(enabledLiveConfig(overrides));
  if (resolution.status !== 'ENABLED') throw new Error(`fixture expected ENABLED, got ${resolution.reason}`);
  return resolution.enablement;
}

export function livePolicy(overrides: Partial<LiveExecutionPolicyContent> = {}): LiveExecutionPolicySnapshot {
  return buildLiveExecutionPolicySnapshot({ ...defaultLiveExecutionPolicyContent('10000000'), ...overrides });
}

/**
 * Deliberately permissive instrument facts so identity/authority tests are not
 * also constraint tests. The constraint suite builds its own tight fixtures.
 */
export function constraintsFor(pair: string = PAIR, overrides: Partial<AuthoritativeInstrumentConstraints> = {}): AuthoritativeInstrumentConstraints {
  return Object.freeze({
    pair,
    instrumentSpecSnapshotId: 'instrument-1',
    quoteCurrency: 'USDT',
    settlementCurrency: 'INR',
    priceIncrement: '1',
    quantityIncrement: '1',
    minQuantity: '1',
    maxQuantity: '10000',
    minPrice: '1',
    maxPrice: '1000000',
    minNotional: '1',
    maxNotional: '10000',
    maxMarketOrderQuantity: null,
    contractMultiplier: '0.001',
    supportedOrderTypes: Object.freeze(['market_order', 'limit_order', 'stop_limit']),
    supportedTimeInForce: Object.freeze(['good_till_cancel']),
    exitOnly: false,
    ...overrides,
  });
}

export const MARKET_SHAPE: LiveExecutionShapeRequest = Object.freeze({
  orderType: 'MARKET',
  timeInForce: 'UNSPECIFIED',
  limitPrice: null,
});

export function limitShape(limitPrice: string): LiveExecutionShapeRequest {
  return Object.freeze({ orderType: 'LIMIT', timeInForce: 'UNSPECIFIED', limitPrice });
}

function evidenceFrom(context: RiskEvaluationContext): Omit<RiskEvaluationContext, 'strategyOrigin' | 'candidate'> {
  const { strategyOrigin: _strategyOrigin, candidate: _candidate, ...evidence } = context;
  return evidence;
}

function evidenceForAccount(context: RiskEvaluationContext, accountId: string): Omit<RiskEvaluationContext, 'strategyOrigin' | 'candidate'> {
  const base = evidenceFrom(context);
  const ownership = base.pairSnapshot.ownership.status === 'RECONCILED'
    ? { ...base.pairSnapshot.ownership, accountId }
    : base.pairSnapshot.ownership;
  return {
    ...base,
    accountSnapshot: base.accountSnapshot === null ? null : seal({ ...base.accountSnapshot, accountId }),
    exposureSnapshot: base.exposureSnapshot === null ? null : seal({ ...base.exposureSnapshot, accountId }),
    pairSnapshot: seal({ ...base.pairSnapshot, ownership }),
  };
}

export interface MintLiveOverrides {
  readonly accountId?: string;
  readonly pair?: string;
  readonly shape?: LiveExecutionShapeRequest;
  readonly enablement?: LiveExecutionEnablement;
  readonly policy?: LiveExecutionPolicySnapshot;
  readonly constraints?: AuthoritativeInstrumentConstraints;
  readonly evaluationTimeMs?: number;
  readonly coordinator?: RiskAdmissionCoordinator;
}

/**
 * Mints a genuine live OPEN authority through the real Phase12 research
 * approval, Phase10 kernel origin, and Phase13 admission chain. Slow the first
 * time per pair (the research approval is genuinely executed and memoized by
 * the shared dispatch helpers), fast afterwards.
 */
export async function mintGenuineLiveOpen(overrides: MintLiveOverrides = {}): Promise<MintedLiveExecutionAuthority> {
  const pair = overrides.pair ?? PAIR;
  const accountId = overrides.accountId ?? LIVE_ACCOUNT;
  const { result } = await genuineResearchApproval(pair);
  const kernel = makeKernel(pair);
  const decision = evaluateDecision(kernel, overrides.evaluationTimeMs ?? T0);
  const context = buildContext(kernel, decision);
  const minted = await mintLiveOpenExecutionAuthority({
    enablement: overrides.enablement ?? genuineEnablement(),
    coordinator: overrides.coordinator ?? new RiskAdmissionCoordinator(),
    accountId,
    kernel,
    decision,
    instrumentSpecSnapshotId: 'instrument-1',
    planResult: result,
    riskPolicy: policyFor(pair),
    evidence: evidenceForAccount(context, accountId),
    livePolicy: overrides.policy ?? livePolicy(),
    constraints: overrides.constraints ?? constraintsFor(pair),
    shape: overrides.shape ?? limitShape('100'),
  });
  if (minted === null) throw new Error('fixture expected a genuine live authority');
  return minted;
}

// ---------------------------------------------------------------------------
// Fake CoinDCX order gateway — the ONLY gateway any test ever uses.
// It performs no I/O whatsoever, so no test can place a production order.
// ---------------------------------------------------------------------------

export interface GatewayCall {
  readonly operation: 'place' | 'cancel' | 'fetch';
  readonly clientOrderId: string;
}

export class FakeOrderGateway implements CoinDcxFuturesOrderGateway {
  public readonly calls: GatewayCall[] = [];
  public readonly placeRequests: LivePlaceOrderRequest[] = [];
  #placeResults: LivePlaceOrderResult[] = [];
  #cancelResults: LiveCancelOrderResult[] = [];
  #fetchResults: LiveFetchOrderResult[] = [];

  public queuePlace(...results: LivePlaceOrderResult[]): this {
    this.#placeResults.push(...results);
    return this;
  }

  public queueCancel(...results: LiveCancelOrderResult[]): this {
    this.#cancelResults.push(...results);
    return this;
  }

  public queueFetch(...results: LiveFetchOrderResult[]): this {
    this.#fetchResults.push(...results);
    return this;
  }

  public get placeCallCount(): number {
    return this.calls.filter((call) => call.operation === 'place').length;
  }

  public get cancelCallCount(): number {
    return this.calls.filter((call) => call.operation === 'cancel').length;
  }

  public async placeOrder(request: LivePlaceOrderRequest): Promise<LivePlaceOrderResult> {
    this.calls.push({ operation: 'place', clientOrderId: request.clientOrderId });
    this.placeRequests.push(request);
    const next = this.#placeResults.shift();
    if (next === undefined) throw new Error('FakeOrderGateway: no queued placeOrder result');
    return next;
  }

  public async cancelOrder(request: LiveCancelOrderRequest): Promise<LiveCancelOrderResult> {
    this.calls.push({ operation: 'cancel', clientOrderId: request.clientOrderId });
    const next = this.#cancelResults.shift();
    if (next === undefined) throw new Error('FakeOrderGateway: no queued cancelOrder result');
    return next;
  }

  public async fetchOrder(request: LiveFetchOrderRequest): Promise<LiveFetchOrderResult> {
    this.calls.push({ operation: 'fetch', clientOrderId: request.clientOrderId });
    const next = this.#fetchResults.shift();
    if (next === undefined) return { kind: 'NOT_FOUND' };
    return next;
  }
}

export function observationFor(
  intent: LiveExecutionIntentRecord,
  overrides: Partial<LiveOrderObservation> = {},
): LiveOrderObservation {
  return Object.freeze({
    kind: 'ACKNOWLEDGED',
    clientOrderId: intent.clientOrderId,
    exchangeClientOrderId: null,
    exchangeOrderId: 'venue-order-1',
    pair: intent.content.pair,
    side: intent.content.side,
    cumulativeFilledQuantity: '0',
    orderedQuantity: intent.content.quantity,
    averageFillPrice: null,
    exchangeStatus: 'open',
    providerEventTimeMs: 1_700_000_000_000,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// In-memory repository that emulates the exact database constraints the
// production Prisma adapter relies on: primary key, unique client order id,
// conditional single-winner dispatch claim, optimistic revision, and
// append-only observation dedup.
// ---------------------------------------------------------------------------

export class InMemoryLiveExecutionRepository implements LiveExecutionRepository {
  readonly #intents = new Map<string, LiveExecutionIntentRecord>();
  readonly #clientOrderIds = new Map<string, string>();
  readonly #orders = new Map<string, LiveOrderStateRecord>();
  readonly #events = new Set<string>();
  readonly #admissionConsumers = new Map<string, string>();
  readonly #positions = new Map<string, LivePositionOwnershipRecord>();
  public commitCount = 0;

  public seedPositionOwnership(position: LivePositionOwnershipRecord): void {
    this.#positions.set(`${position.accountId}:${position.pair}`, Object.freeze({ ...position }));
  }

  public async ensureIntent(intent: LiveExecutionIntentRecord): Promise<LiveOrderStateRecord> {
    const ownerOfClientOrderId = this.#clientOrderIds.get(intent.clientOrderId);
    if (ownerOfClientOrderId !== undefined && ownerOfClientOrderId !== intent.intentId) {
      throw new LiveExecutionError('LIVE_INTENT_CONFLICT', 'Client order identity is already bound to a different live execution intent', {
        details: { intentId: intent.intentId, clientOrderId: intent.clientOrderId },
      });
    }
    const stored = this.#intents.get(intent.intentId);
    if (stored !== undefined) {
      if (liveExecutionIntentContentSha256(stored) !== liveExecutionIntentContentSha256(intent)) {
        throw new LiveExecutionError('LIVE_INTENT_CONFLICT', 'Stored live execution intent binds different economic content to this identity', {
          details: { intentId: intent.intentId },
        });
      }
      return this.#orders.get(intent.intentId) as LiveOrderStateRecord;
    }
    this.#intents.set(intent.intentId, intent);
    this.#clientOrderIds.set(intent.clientOrderId, intent.intentId);
    const initial = initialLiveOrderState({
      intentId: intent.intentId,
      clientOrderId: intent.clientOrderId,
      accountId: intent.content.accountId,
      pair: intent.content.pair,
      orderedQuantity: intent.content.quantity,
    });
    this.#orders.set(intent.intentId, initial);
    return initial;
  }

  public async claimDispatch(intentId: string, consumeOpenAdmission?: () => Promise<boolean>): Promise<ClaimDispatchOutcome> {
    const current = this.#orders.get(intentId);
    if (current === undefined) {
      throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Live order vanished during dispatch claim', { details: { intentId } });
    }
    if (current.state !== 'CREATED') return { kind: 'ALREADY_CLAIMED', order: current };
    // Emulate the database's conditional UPDATE before any awaited work so
    // concurrent callers cannot both pass the CREATED predicate.
    const claimed = Object.freeze({ ...current, state: 'DISPATCH_RESERVED' as const, revision: current.revision + 1 });
    this.#orders.set(intentId, claimed);
    try {
      const intent = this.#intents.get(intentId);
      if (intent?.content.action === 'OPEN') {
        const admissionId = intent.content.admissionId;
        if (admissionId === null || consumeOpenAdmission === undefined) throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'OPEN dispatch requires admission consumption');
        const existing = this.#admissionConsumers.get(admissionId);
        if (existing !== undefined && existing !== intentId) throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Admission already consumed by another intent');
        if (existing === undefined) this.#admissionConsumers.set(admissionId, intentId);
        if (!await consumeOpenAdmission()) {
          if (existing === undefined) this.#admissionConsumers.delete(admissionId);
          throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Admission unavailable');
        }
      }
    } catch (error) {
      this.#orders.set(intentId, current);
      throw error;
    }
    return { kind: 'CLAIMED', order: claimed };
  }

  public async commitState(next: LiveOrderStateRecord, expectedRevision: number): Promise<LiveOrderStateRecord> {
    const current = this.#orders.get(next.intentId);
    if (current === undefined || current.revision !== expectedRevision) {
      throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Concurrent modification: durable live order revision moved', {
        details: { intentId: next.intentId, expectedRevision },
      });
    }
    this.commitCount += 1;
    this.#orders.set(next.intentId, next);
    return next;
  }

  public async applyObservationAtomically(intentId: string, observation: LiveOrderObservation): Promise<LiveOrderStateRecord> {
    const current = this.#orders.get(intentId);
    const intent = this.#intents.get(intentId);
    if (current === undefined || intent === undefined) throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Live order vanished');
    if (observation.side !== intent.content.side) throw new LiveExecutionError('LIVE_ORDER_IDENTITY_MISMATCH', 'Observation side mismatch');
    const application = applyLiveOrderObservation(current, observation);
    const key = `${intentId}:${observationSha256(observation)}`;
    if (this.#events.has(key)) return current;
    this.#events.add(key);
    if (application.kind === 'APPLIED') this.#orders.set(intentId, application.order);
    return application.order;
  }

  public async claimCancel(intentId: string, trustedAccountId: string): Promise<ClaimCancelOutcome> {
    const current = this.#orders.get(intentId);
    if (current === undefined) throw new LiveExecutionError('LIVE_INTENT_INVALID', 'Live order vanished');
    if (current.accountId !== trustedAccountId) throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Account mismatch');
    if (['CREATED', 'DISPATCH_RESERVED', 'SUBMISSION_AMBIGUOUS', 'FILLED', 'CANCELLED', 'REJECTED', 'RECONCILIATION_REQUIRED'].includes(current.state)) {
      return { kind: 'NOT_CANCELLABLE', order: current, generation: current.cancelGeneration };
    }
    if (current.cancelState !== 'NONE') return { kind: 'ALREADY_CLAIMED', order: current, generation: current.cancelGeneration };
    if (current.exchangeOrderId === null) throw new LiveExecutionError('LIVE_ORDER_IDENTITY_MISMATCH', 'Missing exchange order id');
    const generation = current.cancelGeneration + 1;
    const claimed = Object.freeze({ ...current, state: 'CANCEL_REQUESTED' as const, cancelState: 'CANCEL_RESERVED' as const,
      cancelGeneration: generation, cancelExchangeOrderId: current.exchangeOrderId, cancelFaultCode: null, revision: current.revision + 1 });
    this.#orders.set(intentId, claimed);
    return { kind: 'CLAIMED', order: claimed, generation };
  }

  public async completeCancelAttempt(intentId: string, generation: number, outcome: CompleteCancelAttemptOutcome, faultCode: string | null): Promise<LiveOrderStateRecord> {
    const current = this.#orders.get(intentId);
    if (current === undefined || current.cancelGeneration !== generation) throw new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'Cancel generation mismatch');
    const cancelState = outcome === 'ACKNOWLEDGED' ? 'CANCEL_ACKNOWLEDGED' as const
      : outcome === 'AMBIGUOUS' ? 'CANCEL_AMBIGUOUS' as const : 'CANCEL_REJECTED' as const;
    if (current.cancelState !== 'CANCEL_RESERVED') return current;
    const next = Object.freeze({ ...current, cancelState, cancelFaultCode: faultCode,
      faultCode: outcome === 'AMBIGUOUS' ? 'LIVE_CANCEL_AMBIGUOUS' : current.faultCode, revision: current.revision + 1 });
    this.#orders.set(intentId, next);
    return next;
  }

  public async markExpiredDispatchUnresolved(intentId: string, trustedAccountId: string): Promise<LiveOrderStateRecord> {
    const current = this.#orders.get(intentId);
    if (current === undefined) throw new LiveExecutionError('LIVE_INTENT_INVALID', 'Live order vanished');
    if (current.accountId !== trustedAccountId) throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Account mismatch');
    if (current.state !== 'DISPATCH_RESERVED') return current;
    const ambiguous = Object.freeze({ ...current, state: 'SUBMISSION_AMBIGUOUS' as const,
      faultCode: 'LIVE_SUBMISSION_AMBIGUOUS', revision: current.revision + 1 });
    this.#orders.set(intentId, ambiguous);
    return ambiguous;
  }

  public async load(intentId: string): Promise<LiveOrderStateRecord | null> {
    return this.#orders.get(intentId) ?? null;
  }

  public async loadObservationIdentity(intentId: string) {
    const intent = this.#intents.get(intentId);
    if (intent === undefined) return null;
    return Object.freeze({
      intentId,
      accountId: intent.content.accountId,
      clientOrderId: intent.clientOrderId,
      pair: intent.content.pair,
      side: intent.content.side,
      wireOrderType: intent.wireOrderType,
      quantity: intent.content.quantity,
      price: intent.content.price,
      settlementRateInrPerQuote: intent.content.settlementRateInrPerQuote,
      marginCurrencyShortName: 'INR' as const,
    });
  }

  public async loadPositionOwnership(accountId: string, pair: string): Promise<LivePositionOwnershipRecord | null> {
    return this.#positions.get(`${accountId}:${pair}`) ?? null;
  }

  public get eventCount(): number {
    return this.#events.size;
  }
}
