/**
 * The Phase17 live execution service: the one controlled root through which an
 * already-authorized execution request becomes a CoinDCX order mutation
 * (P17-I17).
 *
 * It depends on the `CoinDcxFuturesOrderGateway` PORT and the
 * `LiveExecutionRepository` PORT only. It imports nothing from
 * `src/integration/**`, holds no credentials, and builds no HTTP request, so
 * the only way it can reach an exchange is through the single adapter the
 * composer injects.
 *
 * Ordering is fixed and never varies:
 *   authority -> intent identity -> durable intent -> durable dispatch claim
 *   -> wire mutation -> validated observation -> durable state.
 *
 * The durable claim is taken BEFORE the wire call, so a crash between claim and
 * response can never present as "never dispatched" on restart.
 */
import { createChildLogger } from '../../monitoring/logger';
import { readLiveAuthorityForIntent } from './authority';
import { consumeLiveAdmissionForIntent } from '../../dispatch/admission';
import { LiveExecutionError } from './errors';
import type { LiveExecutionPolicySnapshot } from './execution-policy';
import type { CoinDcxFuturesOrderGateway } from './gateway';
import { assertLiveExecutionIntentIdentity, LiveExecutionIntent, type LiveExecutionIntentRecord } from './intent';
import type { LiveExecutionRepository } from './repository';
import {
  isLiveTerminalState,
  markRejected,
  markSubmissionAmbiguous,
  releaseDispatchClaim,
} from './state-machine';
import type { LiveDispatchOutcome, LiveOrderObservation, LiveOrderStateRecord } from './types';

const logger = createChildLogger('execution:live');

export type LiveCancelOutcomeKind =
  | 'CANCELLED'
  | 'CANCEL_REQUESTED'
  | 'FILLED_BEFORE_CANCEL'
  | 'NOT_CANCELLABLE'
  | 'AMBIGUOUS';

export interface LiveCancelOutcome {
  readonly kind: LiveCancelOutcomeKind;
  readonly order: LiveOrderStateRecord;
  readonly faultCode: string | null;
}

export interface LiveExecutionServiceDependencies {
  readonly gateway: CoinDcxFuturesOrderGateway;
  readonly repository: LiveExecutionRepository;
  readonly policy: LiveExecutionPolicySnapshot;
}

export class LiveExecutionService {
  readonly #gateway: CoinDcxFuturesOrderGateway;
  readonly #repository: LiveExecutionRepository;
  readonly #policy: LiveExecutionPolicySnapshot;

  public constructor(dependencies: LiveExecutionServiceDependencies) {
    this.#gateway = dependencies.gateway;
    this.#repository = dependencies.repository;
    this.#policy = dependencies.policy;
  }

  /**
   * Dispatches one authorized intent, exactly once, ever.
   *
   * Replaying the same genuine intent never creates a second exchange order:
   * the durable claim resolves the second attempt to `ALREADY_DISPATCHED`
   * without touching the gateway. An intent whose prior attempt is ambiguous
   * fails closed and is never resent (P17-I07/I14/I20).
   */
  public async dispatch(authority: unknown, intent: unknown): Promise<LiveDispatchOutcome> {
    const intentRecord = this.#requireIntent(intent);
    const authorityRecord = readLiveAuthorityForIntent(authority, intent);
    assertLiveExecutionIntentIdentity(intentRecord);

    const persisted = await this.#repository.ensureIntent(intentRecord);

    if (persisted.state === 'SUBMISSION_AMBIGUOUS') {
      // P17-I07/I20: this process cannot prove whether the earlier mutation
      // reached CoinDCX. Resending is exactly the duplicate-order risk the
      // phase forbids; resolution is deferred to Phase18 reconciliation.
      throw new LiveExecutionError('LIVE_SUBMISSION_AMBIGUOUS', 'A prior dispatch of this intent has an unresolved outcome and must not be resent', {
        details: { intentId: persisted.intentId, state: persisted.state },
      });
    }
    if (persisted.state !== 'CREATED') {
      return Object.freeze({ kind: 'ALREADY_DISPATCHED' as const, order: persisted, faultCode: persisted.faultCode });
    }

    const claim = await this.#repository.claimDispatch(intentRecord.intentId, authorityRecord.admission === null ? undefined : async () => {
      const consumed = await consumeLiveAdmissionForIntent(
        authorityRecord.coordinator, authorityRecord.accountId, authorityRecord.admission!.admissionId, intentRecord.intentId,
      );
      return consumed.status === 'CONSUMED' || consumed.status === 'ALREADY_CONSUMED_SAME_INTENT';
    });
    if (claim.kind === 'ALREADY_CLAIMED') {
      logger.warn({ intentId: intentRecord.intentId, state: claim.order.state }, 'Live dispatch already claimed by another worker; no exchange mutation performed');
      return Object.freeze({ kind: 'ALREADY_DISPATCHED' as const, order: claim.order, faultCode: claim.order.faultCode });
    }

    const reserved = claim.order;
    const result = await this.#gateway.placeOrder({
      clientOrderId: intentRecord.clientOrderId,
      pair: intentRecord.content.pair,
      side: intentRecord.content.side,
      wireOrderType: intentRecord.wireOrderType,
      quantity: intentRecord.content.quantity,
      price: intentRecord.content.price,
      leverage: intentRecord.content.leverage,
      settlementRateInrPerQuote: intentRecord.content.settlementRateInrPerQuote,
      timeInForce: intentRecord.content.timeInForce,
      timeoutMs: this.#policy.content.requestTimeoutMs,
    });

    switch (result.kind) {
      case 'ACCEPTED': {
        const order = await this.#ingest(reserved, result.observation);
        return Object.freeze({ kind: 'SUBMITTED' as const, order, faultCode: null });
      }
      case 'REJECTED': {
        const order = result.observation === null
          ? await this.#commitRejection(reserved, result.reasonCode)
          : await this.#ingest(reserved, result.observation);
        logger.warn({ intentId: reserved.intentId, reasonCode: result.reasonCode }, 'CoinDCX rejected the live order');
        return Object.freeze({ kind: 'REJECTED' as const, order, faultCode: result.reasonCode });
      }
      case 'PRE_DISPATCH_FAILURE': {
        // Provably nothing left this process, so the claim is safe to release
        // and the intent may be attempted again later.
        const released = releaseDispatchClaim(reserved, result.reasonCode);
        const order = await this.#repository.commitState(released, reserved.revision);
        throw new LiveExecutionError('LIVE_PROVIDER_ERROR', 'Live order was refused before dispatch; nothing reached CoinDCX', {
          details: { intentId: order.intentId, reasonCode: result.reasonCode },
        });
      }
      case 'AMBIGUOUS':
      default: {
        const ambiguous = markSubmissionAmbiguous(reserved, 'LIVE_SUBMISSION_AMBIGUOUS');
        const order = await this.#repository.commitState(ambiguous, reserved.revision);
        logger.error({ intentId: order.intentId, reasonCode: result.reasonCode }, 'Live order submission outcome is unknown; failing closed for Phase18 reconciliation');
        return Object.freeze({ kind: 'AMBIGUOUS' as const, order, faultCode: 'LIVE_SUBMISSION_AMBIGUOUS' });
      }
    }
  }

  /**
   * Cancels an order by its exact authoritative identity (P17-I13).
   *
   * A cancel acknowledgement is never treated as proof that nothing filled: the
   * authoritative post-cancel state comes from a validated order observation,
   * and when none can be obtained the order stays CANCEL_REQUESTED with a
   * durable ambiguity fault rather than a fabricated CANCELLED.
   */
  public async cancel(authority: unknown, intent: unknown): Promise<LiveCancelOutcome> {
    const intentRecord = this.#requireIntent(intent);
    const authorityRecord = readLiveAuthorityForIntent(authority, intent);
    return this.cancelDurable(intentRecord.intentId, authorityRecord.accountId);
  }

  /**
   * Cancels from durable order ownership plus the trusted configured account
   * boundary. No admission or process-local authority object is required.
   */
  public async cancelDurable(intentId: string, trustedAccountId: string): Promise<LiveCancelOutcome> {
    const cutoff = new Date(Date.now() - this.#policy.content.dispatchClaimTimeoutMs);
    const current = await this.#repository.markExpiredDispatchUnresolved(intentId, trustedAccountId, cutoff);
    if (current.state === 'SUBMISSION_AMBIGUOUS') {
      throw new LiveExecutionError('LIVE_CANCEL_AMBIGUOUS', 'Cannot cancel an order whose submission outcome is unresolved', {
        details: { intentId: current.intentId },
      });
    }
    if (isLiveTerminalState(current.state) || current.state === 'CREATED' || current.state === 'DISPATCH_RESERVED') {
      return Object.freeze({ kind: 'NOT_CANCELLABLE' as const, order: current, faultCode: current.faultCode });
    }
    const claim = await this.#repository.claimCancel(intentId, trustedAccountId);
    if (claim.kind === 'NOT_CANCELLABLE') {
      return Object.freeze({ kind: 'NOT_CANCELLABLE' as const, order: claim.order, faultCode: claim.order.faultCode });
    }
    if (claim.kind === 'ALREADY_CLAIMED') {
      if (claim.order.cancelState === 'CANCEL_AMBIGUOUS') {
        return Object.freeze({ kind: 'AMBIGUOUS' as const, order: claim.order, faultCode: claim.order.cancelFaultCode });
      }
      if (claim.order.cancelState === 'CANCEL_REJECTED') {
        return Object.freeze({ kind: 'NOT_CANCELLABLE' as const, order: claim.order, faultCode: claim.order.cancelFaultCode });
      }
      return Object.freeze({ kind: 'CANCEL_REQUESTED' as const, order: claim.order, faultCode: claim.order.cancelFaultCode });
    }

    const requested = claim.order;
    const exchangeOrderId = requested.exchangeOrderId;
    if (exchangeOrderId === null) throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Cancellation claim lost its exchange order identity', { details: { intentId } });

    const result = await this.#gateway.cancelOrder({
      clientOrderId: requested.clientOrderId,
      exchangeOrderId,
      pair: requested.pair,
      timeoutMs: this.#policy.content.requestTimeoutMs,
    });

    if (result.kind === 'AMBIGUOUS') {
      const order = await this.#repository.completeCancelAttempt(intentId, claim.generation, 'AMBIGUOUS', 'LIVE_CANCEL_AMBIGUOUS');
      return Object.freeze({ kind: 'AMBIGUOUS' as const, order, faultCode: 'LIVE_CANCEL_AMBIGUOUS' });
    }
    if (result.kind === 'PRE_DISPATCH_FAILURE' || result.kind === 'REJECTED') {
      const order = await this.#repository.completeCancelAttempt(intentId, claim.generation, 'REJECTED', result.reasonCode);
      return Object.freeze({ kind: 'NOT_CANCELLABLE' as const, order, faultCode: result.reasonCode });
    }

    const observation = result.observation ?? await this.#fetchAuthoritativeObservation(requested, exchangeOrderId);
    if (observation === null) {
      const order = await this.#repository.completeCancelAttempt(intentId, claim.generation, 'AMBIGUOUS', 'LIVE_CANCEL_AMBIGUOUS');
      return Object.freeze({ kind: 'AMBIGUOUS' as const, order, faultCode: 'LIVE_CANCEL_AMBIGUOUS' });
    }

    const acknowledged = await this.#repository.completeCancelAttempt(intentId, claim.generation, 'ACKNOWLEDGED', null);
    const order = await this.#ingest(acknowledged, observation);
    if (order.state === 'FILLED') {
      return Object.freeze({ kind: 'FILLED_BEFORE_CANCEL' as const, order, faultCode: null });
    }
    if (order.state === 'CANCELLED') {
      return Object.freeze({ kind: 'CANCELLED' as const, order, faultCode: null });
    }
    return Object.freeze({ kind: 'CANCEL_REQUESTED' as const, order, faultCode: order.faultCode });
  }

  /**
   * Applies an externally-obtained, already-validated observation (for example
   * from `syncOrderState`). Idempotent: a replayed event and a late event both
   * resolve without regressing durable state.
   */
  public async applyObservation(intentId: string, observation: LiveOrderObservation): Promise<LiveOrderStateRecord> {
    const current = await this.#repository.load(intentId);
    if (current === null) {
      throw new LiveExecutionError('LIVE_INTENT_INVALID', 'No durable live order exists for this intent', { details: { intentId } });
    }
    return this.#ingest(current, observation);
  }

  /**
   * Reads authoritative order state from CoinDCX and folds it into durable
   * state. This is the only read the Phase17 lifecycle needs: it is what turns
   * an acknowledgement into an eventual fill/cancel outcome without inventing
   * one locally.
   */
  public async syncOrderState(intentId: string): Promise<LiveOrderStateRecord> {
    const current = await this.#repository.load(intentId);
    if (current === null) {
      throw new LiveExecutionError('LIVE_INTENT_INVALID', 'No durable live order exists for this intent', { details: { intentId } });
    }
    if (current.state === 'SUBMISSION_AMBIGUOUS') {
      // Reading an ambiguous submission back is reconciliation, which Phase17
      // deliberately does not perform (P17-I20).
      throw new LiveExecutionError('LIVE_SUBMISSION_AMBIGUOUS', 'Resolving an ambiguous submission is deferred to Phase18 reconciliation', {
        details: { intentId },
      });
    }
    if (current.state === 'CREATED' || current.state === 'DISPATCH_RESERVED') {
      // Nothing has been acknowledged yet, so there is no venue-side order
      // this process is entitled to fold in. Asking would invite an
      // observation that does not belong to any dispatched order.
      return current;
    }
    const observation = await this.#fetchAuthoritativeObservation(current, current.exchangeOrderId);
    return observation === null ? current : this.#ingest(current, observation);
  }

  async #fetchAuthoritativeObservation(order: LiveOrderStateRecord, exchangeOrderId: string | null): Promise<LiveOrderObservation | null> {
    if (exchangeOrderId === null) return null;
    const identity = await this.#repository.loadObservationIdentity(order.intentId);
    if (identity === null) {
      throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Live order exists without immutable observation identity', {
        details: { intentId: order.intentId },
      });
    }
    const result = await this.#gateway.fetchOrder({
      clientOrderId: order.clientOrderId,
      exchangeOrderId,
      pair: order.pair,
      side: identity.side,
      wireOrderType: identity.wireOrderType,
      quantity: identity.quantity,
      price: identity.price,
      settlementRateInrPerQuote: identity.settlementRateInrPerQuote,
      marginCurrencyShortName: identity.marginCurrencyShortName,
      timeoutMs: this.#policy.content.requestTimeoutMs,
    });
    return result.kind === 'FOUND' ? result.observation : null;
  }

  /** Records the observation for audit/dedup, then folds it into durable state. */
  async #ingest(current: LiveOrderStateRecord, observation: LiveOrderObservation): Promise<LiveOrderStateRecord> {
    // Pure validation is deliberately first. A hostile observation must not
    // reach even the append-only event log before its identity and financial
    // conservation have been proven against durable local truth.
    return this.#repository.applyObservationAtomically(current.intentId, observation);
  }

  async #commitRejection(reserved: LiveOrderStateRecord, reasonCode: string): Promise<LiveOrderStateRecord> {
    return this.#repository.commitState(markRejected(reserved, reasonCode), reserved.revision);
  }

  #requireIntent(intent: unknown): LiveExecutionIntentRecord {
    const record = LiveExecutionIntent.read(intent);
    if (record === null) {
      throw new LiveExecutionError('LIVE_INTENT_INVALID', 'Live mutation requires a genuine immutable live execution intent');
    }
    return record;
  }
}
