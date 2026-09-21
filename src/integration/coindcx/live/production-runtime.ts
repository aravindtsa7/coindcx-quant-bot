/**
 * [P17] The single production LIVE execution root (P17-I17/I18).
 *
 * THIS IS THE ONLY MODULE IN THE REPOSITORY THAT IMPORTS THE MUTABLE COINDCX
 * ORDER ADAPTER, and the only one that can mint a live execution authority and
 * dispatch it. The Phase17 architecture test proves both statements over the
 * true transitive import graph.
 *
 * It lives under `src/integration/coindcx/` rather than `src/execution/`
 * because Phase14 froze a structural rule — enforced by the repository's own
 * `no-restricted-imports` lint boundary — that no `src/execution/**` file may
 * name the CoinDCX integration surface. Phase17 keeps that rule intact and
 * strengthens it: `src/execution/live/**` reaches NO integration module at
 * all, not even a type-only one. Execution owns the port
 * (`CoinDcxFuturesOrderGateway`); this file owns the adapter and the wiring,
 * exactly as `paper-production-runtime.ts` does for Phase14 paper.
 *
 * Fail-closed construction: the runtime cannot be built unless configuration
 * explicitly enables live mutation. Until then no gateway, no transport, no
 * signer, and no credential object is ever constructed.
 */
import type { PrismaClient } from '@prisma/client';
import type { RiskAdmissionCoordinator } from '../../../dispatch/admission';
import {
  mintLiveCloseExecutionAuthority,
  mintLiveOpenExecutionAuthority,
  type MintedLiveExecutionAuthority,
} from '../../../execution/live/authority';
import { LiveExecutionError } from '../../../execution/live/errors';
import {
  buildLiveExecutionPolicySnapshot,
  defaultLiveExecutionPolicyContent,
  type LiveExecutionPolicyContent,
  type LiveExecutionPolicySnapshot,
} from '../../../execution/live/execution-policy';
import {
  resolveLiveExecutionGate,
  type LiveExecutionConfigInput,
  type LiveExecutionEnablement,
} from '../../../execution/live/gate';
import type { CoinDcxFuturesOrderGateway } from '../../../execution/live/gateway';
import type { AuthoritativeInstrumentConstraints } from '../../../execution/live/instrument-constraints';
import type { LiveExecutionShapeRequest } from '../../../execution/live/intent';
import { requireAuthoritativeLivePosition } from '../../../execution/live/position-ownership';
import { PrismaLiveExecutionRepository, type LiveExecutionRepository } from '../../../execution/live/repository';
import { LiveExecutionService, type LiveCancelOutcome } from '../../../execution/live/service';
import type { LiveDispatchOutcome } from '../../../execution/live/types';
import type { ResearchValidationPlanResult } from '../../../research/research-validation';
import type { RiskEvaluationContext, RiskPolicy } from '../../../risk';
import type { StrategyDecision, StrategyKernel } from '../../../strategies';
import { acquireProductionInstrumentBinding, TrustedProductionInstrumentBinding } from '../instrument-authority';
import type { InrFuturesInstrument } from '../models';
import { CoinDcxLiveFuturesOrderGateway } from './order-gateway';

export interface ComposeLiveExecutionRuntimeInput {
  readonly config: LiveExecutionConfigInput;
  readonly prisma: PrismaClient;
  /** The one real, account-owned coordinator supplied by the owning runtime. */
  readonly coordinator: RiskAdmissionCoordinator;
  /** Optional policy override. Defaults to the conservative Phase17 policy. */
  readonly policyContent?: LiveExecutionPolicyContent | undefined;
  /** Staging/test base URL override. Production leaves it unset. */
  readonly baseUrl?: string | undefined;
  /** Injected gateway, used by tests. Production leaves it unset and gets the real adapter. */
  readonly gateway?: CoinDcxFuturesOrderGateway | undefined;
}

export interface LiveOpenExecutionRequest {
  readonly accountId: string;
  readonly kernel: StrategyKernel;
  readonly decision: StrategyDecision;
  readonly instrumentSpecSnapshotId: string;
  readonly planResult: ResearchValidationPlanResult;
  readonly riskPolicy: RiskPolicy;
  readonly evidence: Omit<RiskEvaluationContext, 'strategyOrigin' | 'candidate'>;
  readonly constraints: AuthoritativeInstrumentConstraints;
  readonly shape: LiveExecutionShapeRequest;
}

export interface LiveCloseExecutionRequest {
  readonly accountId: string;
  readonly kernel: StrategyKernel;
  readonly decision: StrategyDecision;
  readonly instrumentSpecSnapshotId: string;
  readonly riskPolicy: RiskPolicy;
  readonly evidence: Omit<RiskEvaluationContext, 'strategyOrigin' | 'candidate'>;
  readonly constraints: AuthoritativeInstrumentConstraints;
  readonly shape: LiveExecutionShapeRequest;
}

/** Returned when genuine upstream authority was refused. No exchange call happened. */
export interface LiveExecutionNotAuthorized {
  readonly status: 'NOT_AUTHORIZED';
}

export interface LiveExecutionDispatched {
  readonly status: 'DISPATCHED';
  readonly outcome: LiveDispatchOutcome;
  readonly intentId: string;
}

export type LiveExecutionResult = LiveExecutionNotAuthorized | LiveExecutionDispatched;

export class LiveExecutionRuntime {
  readonly #service: LiveExecutionService;
  readonly #repository: LiveExecutionRepository;
  readonly #enablement: LiveExecutionEnablement;
  readonly #policy: LiveExecutionPolicySnapshot;
  readonly #coordinator: RiskAdmissionCoordinator;

  public constructor(input: {
    readonly service: LiveExecutionService;
    readonly repository: LiveExecutionRepository;
    readonly enablement: LiveExecutionEnablement;
    readonly policy: LiveExecutionPolicySnapshot;
    readonly coordinator: RiskAdmissionCoordinator;
  }) {
    this.#service = input.service;
    this.#repository = input.repository;
    this.#enablement = input.enablement;
    this.#policy = input.policy;
    this.#coordinator = input.coordinator;
  }

  public get policy(): LiveExecutionPolicySnapshot { return this.#policy; }
  public get repository(): LiveExecutionRepository { return this.#repository; }

  /** Mints genuine OPEN authority and dispatches it, or reports that authority was refused. */
  public async openLive(request: LiveOpenExecutionRequest): Promise<LiveExecutionResult> {
    const minted = await mintLiveOpenExecutionAuthority({
      enablement: this.#enablement,
      coordinator: this.#coordinator,
      accountId: request.accountId,
      kernel: request.kernel,
      decision: request.decision,
      instrumentSpecSnapshotId: request.instrumentSpecSnapshotId,
      planResult: request.planResult,
      riskPolicy: request.riskPolicy,
      evidence: request.evidence,
      livePolicy: this.#policy,
      constraints: request.constraints,
      shape: request.shape,
    });
    return this.#dispatchMinted(minted);
  }

  /** Mints genuine CLOSE authority and dispatches it. Quantity always comes from the held position. */
  public async closeLive(request: LiveCloseExecutionRequest): Promise<LiveExecutionResult> {
    const position = await requireAuthoritativeLivePosition(this.#repository, request.accountId, request.kernel.pair);
    const minted = await mintLiveCloseExecutionAuthority({
      enablement: this.#enablement,
      coordinator: this.#coordinator,
      accountId: request.accountId,
      kernel: request.kernel,
      decision: request.decision,
      instrumentSpecSnapshotId: request.instrumentSpecSnapshotId,
      riskPolicy: request.riskPolicy,
      evidence: request.evidence,
      position,
      livePolicy: this.#policy,
      constraints: request.constraints,
      shape: request.shape,
    });
    return this.#dispatchMinted(minted);
  }

  /** Cancels a durable order owned by the configured credential/account boundary. */
  public async cancelLive(intentId: string): Promise<LiveCancelOutcome> {
    return this.#service.cancelDurable(intentId, this.#enablement.credentialAccountId);
  }

  /** Folds authoritative venue order state into durable state. Read-only at the venue. */
  public async syncLive(intentId: string): Promise<ReturnType<LiveExecutionService['syncOrderState']>> {
    return this.#service.syncOrderState(intentId);
  }

  async #dispatchMinted(minted: MintedLiveExecutionAuthority | null): Promise<LiveExecutionResult> {
    if (minted === null) return Object.freeze({ status: 'NOT_AUTHORIZED' as const });
    const outcome = await this.#service.dispatch(minted.authority, minted.intent);
    return Object.freeze({ status: 'DISPATCHED' as const, outcome, intentId: minted.intent.intentId });
  }
}

/**
 * Builds the live execution runtime, or refuses.
 *
 * There is no "disabled but constructed" runtime.
 */
export function composeLiveExecutionRuntime(input: ComposeLiveExecutionRuntimeInput): LiveExecutionRuntime {
  const resolution = resolveLiveExecutionGate(input.config);
  if (resolution.status === 'DISABLED') {
    throw new LiveExecutionError('LIVE_EXECUTION_DISABLED', 'Refusing to compose a live execution runtime while live mutation is disabled', {
      details: { reason: resolution.reason },
    });
  }
  const { enablement } = resolution;

  const policy = buildLiveExecutionPolicySnapshot(
    input.policyContent ?? defaultLiveExecutionPolicyContent(enablement.maxOrderNotionalInr),
  );

  const gateway = input.gateway ?? createProductionOrderGateway(input.config, input.baseUrl);
  const repository = new PrismaLiveExecutionRepository(input.prisma);

  return new LiveExecutionRuntime({
    service: new LiveExecutionService({ gateway, repository, policy }),
    repository,
    enablement,
    policy,
    coordinator: input.coordinator,
  });
}

function createProductionOrderGateway(config: LiveExecutionConfigInput, baseUrl: string | undefined): CoinDcxFuturesOrderGateway {
  const apiKey = config.COINDCX_API_KEY;
  const apiSecret = config.COINDCX_API_SECRET;
  if (typeof apiKey !== 'string' || typeof apiSecret !== 'string') {
    // Unreachable through the gate, which already proved both are present.
    throw new LiveExecutionError('LIVE_EXECUTION_DISABLED', 'Live execution credentials are unavailable');
  }
  return new CoinDcxLiveFuturesOrderGateway({ apiKey, apiSecret, baseUrl });
}

function exactDecimal(value: { toFixed(): string } | null): string | null {
  return value === null ? null : value.toFixed();
}

/**
 * Adapts already-acquired authoritative CoinDCX instrument facts into the
 * execution-owned constraint port. The trusted binding supplies the
 * content-addressed `instrumentSpecSnapshotId` and the increments Phase14
 * already treats as authoritative; the instrument record supplies the bounds
 * and the venue's own declared order-type lexemes, so Phase17 never invents an
 * exchange enum value.
 */
export function toAuthoritativeInstrumentConstraints(
  binding: TrustedProductionInstrumentBinding,
  instrument: InrFuturesInstrument,
): AuthoritativeInstrumentConstraints {
  const bindingRecord = TrustedProductionInstrumentBinding.read(binding);
  if (bindingRecord === null) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', 'Instrument constraints require a genuine trusted production instrument binding');
  }
  if (bindingRecord.pair !== instrument.pair) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', 'Instrument binding and instrument record describe different pairs', {
      details: { pair: bindingRecord.pair },
    });
  }
  return Object.freeze({
    pair: bindingRecord.pair,
    instrumentSpecSnapshotId: bindingRecord.instrumentSpecSnapshotId,
    quoteCurrency: bindingRecord.quoteCurrency,
    settlementCurrency: instrument.settleCurrency,
    priceIncrement: bindingRecord.priceIncrement,
    quantityIncrement: bindingRecord.quantityIncrement,
    contractMultiplier: bindingRecord.contractMultiplier,
    minQuantity: instrument.minQuantity.toFixed(),
    maxQuantity: instrument.maxQuantity.toFixed(),
    minPrice: instrument.minPrice.toFixed(),
    maxPrice: instrument.maxPrice.toFixed(),
    minNotional: instrument.minNotional.toFixed(),
    maxNotional: exactDecimal(instrument.maxNotional),
    maxMarketOrderQuantity: exactDecimal(instrument.maxMarketOrderQuantity),
    supportedOrderTypes: Object.freeze([...instrument.supportedOrderTypes]),
    supportedTimeInForce: Object.freeze([...instrument.timeInForceOptions]),
    exitOnly: instrument.exitOnly === true,
  });
}

/**
 * Acquires the authoritative instrument binding for `pair` through the existing
 * Phase14 production instrument authority: a read-only public-endpoint fetch
 * that never touches an order endpoint.
 */
export async function acquireLiveInstrumentBinding(pair: string): Promise<TrustedProductionInstrumentBinding> {
  return acquireProductionInstrumentBinding(pair);
}
