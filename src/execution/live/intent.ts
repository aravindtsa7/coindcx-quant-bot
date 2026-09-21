/**
 * The immutable `LiveExecutionIntent` (P17-I05).
 *
 * Every live order mutation in Phase17 originates from one of these. The class
 * holds its validated content in an ECMAScript-private field, so a caller-shaped
 * object literal with identical-looking properties is not an intent and
 * `LiveExecutionIntent.read()` returns `null` for it. The instance and its
 * content are frozen: an authority bound to `intentId` can never be re-pointed
 * at mutated economics, because the economics cannot be mutated and the id is
 * recomputable from them.
 */
import {
  canonicalPositiveLiveDecimal,
  liveDecimal,
} from './decimal';
import { LiveExecutionError } from './errors';
import { computeLiveExecutionIntentId, deriveLiveClientOrderId } from './identity';
import {
  assertOrderWithinInstrumentConstraints,
  quantizeOrderEconomics,
  resolveWireOrderType,
  type AuthoritativeInstrumentConstraints,
} from './instrument-constraints';
import { validateLiveExecutionPolicySnapshot, type LiveExecutionPolicySnapshot } from './execution-policy';
import type {
  LiveExecutionAction,
  LiveExecutionIntentContent,
  LiveExecutionLineage,
  LiveOrderSide,
  LiveOrderType,
  LiveTimeInForce,
} from './types';

export interface LiveExecutionIntentRecord {
  readonly intentId: string;
  readonly clientOrderId: string;
  readonly content: LiveExecutionIntentContent;
  readonly lineage: LiveExecutionLineage;
  /** The exact `order_type` lexeme the adapter will put on the wire. */
  readonly wireOrderType: string;
  /** True when instrument quantization reduced the requested quantity/price. */
  readonly quantityAdjusted: boolean;
  readonly priceAdjusted: boolean;
}

const INTENT_ISSUER = Symbol('P17 live execution intent issuer');

export class LiveExecutionIntent {
  readonly #record: LiveExecutionIntentRecord;

  public constructor(issuer: symbol, record: LiveExecutionIntentRecord) {
    if (issuer !== INTENT_ISSUER) {
      throw new LiveExecutionError('LIVE_INTENT_INVALID', 'Only the genuine Phase17 intent composition may construct a live execution intent');
    }
    this.#record = Object.freeze({
      ...record,
      content: Object.freeze({ ...record.content }),
      lineage: Object.freeze({ ...record.lineage }),
    });
    Object.freeze(this);
  }

  public static read(value: unknown): LiveExecutionIntentRecord | null {
    return value !== null && typeof value === 'object' && #record in value ? value.#record : null;
  }

  public get intentId(): string { return this.#record.intentId; }
  public get clientOrderId(): string { return this.#record.clientOrderId; }
}
Object.freeze(LiveExecutionIntent.prototype);
Object.freeze(LiveExecutionIntent);

/**
 * The non-economic execution shape a caller may choose. Every economically
 * meaningful value (quantity, leverage, risk lineage) is deliberately absent:
 * those are supplied only by genuine authoritative risk output inside
 * `authority.ts` (P17-I02).
 */
export interface LiveExecutionShapeRequest {
  readonly orderType: LiveOrderType;
  readonly timeInForce: LiveTimeInForce;
  /** Required for LIMIT; must be absent for MARKET. */
  readonly limitPrice: string | null;
}

/** Authoritative economics, always derived from a genuine accepted risk decision. */
export interface AuthoritativeIntentEconomics {
  readonly accountId: string;
  readonly pair: string;
  readonly side: LiveOrderSide;
  readonly action: LiveExecutionAction;
  readonly quantity: string;
  readonly leverage: string | null;
  readonly riskDecisionId: string;
  readonly admissionId: string | null;
  readonly strategyInstanceId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly authorizedNotionalInr: string;
  readonly settlementRateInrPerQuote: string | null;
  readonly positionInstanceId: string | null;
  readonly positionRevision: number | null;
  readonly reduceOnlyQuantity: string | null;
}

export interface CreateLiveExecutionIntentInput {
  readonly policy: LiveExecutionPolicySnapshot;
  readonly constraints: AuthoritativeInstrumentConstraints;
  readonly economics: AuthoritativeIntentEconomics;
  readonly shape: LiveExecutionShapeRequest;
  readonly lineage: LiveExecutionLineage;
}

/**
 * The single trusted intent composition. Validates the policy snapshot's own
 * hash, refuses execution semantics the policy or the verified CoinDCX contract
 * cannot guarantee, quantizes against authoritative instrument metadata, proves
 * every instrument bound, and only then derives the deterministic identity pair.
 *
 * Deliberately NOT exported from the Phase17 barrel: production callers reach
 * it through an authority mint, never directly.
 */
export function createLiveExecutionIntent(input: CreateLiveExecutionIntentInput): LiveExecutionIntent {
  const policy = validateLiveExecutionPolicySnapshot(input.policy);
  const { constraints, economics, shape } = input;

  if (constraints.pair !== economics.pair) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', 'Instrument constraints are for a different pair than the intent', {
      details: { pair: economics.pair },
    });
  }
  if (economics.action === 'OPEN' && economics.admissionId === null) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', 'An OPEN live intent requires a genuine admission id');
  }
  if (economics.action === 'CLOSE' && economics.admissionId !== null) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', 'A CLOSE live intent is never capacity-tracked and must not bind an admission id');
  }
  if (shape.orderType === 'MARKET') {
    if (shape.timeInForce !== 'UNSPECIFIED') {
      throw new LiveExecutionError('LIVE_UNSUPPORTED_EXECUTION_SEMANTICS', 'CoinDCX futures forbids time_in_force on MARKET orders', {
        details: { orderType: shape.orderType, timeInForce: shape.timeInForce },
      });
    }
    throw new LiveExecutionError('LIVE_UNSUPPORTED_EXECUTION_SEMANTICS', 'MARKET live execution is unsupported until an authoritative conservative fill-price bound exists');
  }
  if (economics.action === 'OPEN' && (economics.settlementRateInrPerQuote === null
      || economics.positionInstanceId !== null || economics.positionRevision !== null || economics.reduceOnlyQuantity !== null)) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', 'OPEN intent is missing its INR valuation envelope or carries CLOSE ownership fields');
  }
  if (economics.action === 'CLOSE' && (economics.positionInstanceId === null
      || economics.positionRevision === null || economics.reduceOnlyQuantity === null)) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', 'CLOSE intent requires exact durable position ownership and revision');
  }

  if (!policy.content.allowedOrderTypes.includes(shape.orderType)) {
    throw new LiveExecutionError('LIVE_UNSUPPORTED_EXECUTION_SEMANTICS', 'Order type is not permitted by the bound live execution policy', {
      details: { orderType: shape.orderType },
    });
  }
  if (!policy.content.allowedTimeInForce.includes(shape.timeInForce)) {
    throw new LiveExecutionError('LIVE_UNSUPPORTED_EXECUTION_SEMANTICS', 'Time-in-force is not permitted by the bound live execution policy', {
      details: { timeInForce: shape.timeInForce },
    });
  }
  // P17-I12: a post-only request is a REJECTION when the venue contract cannot
  // guarantee it. It is never silently downgraded to a taker order.
  if (shape.timeInForce === 'POST_ONLY') {
    throw new LiveExecutionError('LIVE_UNSUPPORTED_EXECUTION_SEMANTICS', 'Post-only was requested but is not a guaranteed CoinDCX futures semantic', {
      details: { timeInForce: shape.timeInForce },
    });
  }

  const wireOrderType = resolveWireOrderType(constraints, shape.orderType);
  const quantized = quantizeOrderEconomics({
    constraints,
    side: economics.side,
    orderType: shape.orderType,
    quantity: economics.quantity,
    price: shape.limitPrice,
  });
  assertOrderWithinInstrumentConstraints({
    constraints,
    action: economics.action,
    orderType: shape.orderType,
    economics: quantized,
  });

  if (quantized.notional !== null && economics.action === 'OPEN') {
    const conversion = liveDecimal(canonicalPositiveLiveDecimal(economics.settlementRateInrPerQuote, 'settlementRateInrPerQuote'));
    const notionalInr = liveDecimal(quantized.notional).times(conversion);
    const policyCap = liveDecimal(policy.content.maxOrderNotionalInr);
    const riskCap = liveDecimal(canonicalPositiveLiveDecimal(economics.authorizedNotionalInr, 'authorizedNotionalInr'));
    if (notionalInr.greaterThan(policyCap) || notionalInr.greaterThan(riskCap)) {
      throw new LiveExecutionError('LIVE_INSTRUMENT_CONSTRAINT', 'Order notional exceeds the policy ceiling', {
        details: { pair: economics.pair },
      });
    }
  }

  const content: LiveExecutionIntentContent = {
    accountId: economics.accountId,
    pair: economics.pair,
    side: economics.side,
    action: economics.action,
    quantity: canonicalPositiveLiveDecimal(quantized.quantity, 'quantity'),
    orderType: shape.orderType,
    price: quantized.price === null ? null : canonicalPositiveLiveDecimal(quantized.price, 'price'),
    timeInForce: shape.timeInForce,
    leverage: economics.leverage === null ? null : canonicalPositiveLiveDecimal(economics.leverage, 'leverage'),
    riskDecisionId: economics.riskDecisionId,
    admissionId: economics.admissionId,
    strategyInstanceId: economics.strategyInstanceId,
    strategyId: economics.strategyId,
    strategyVersion: economics.strategyVersion,
    parameterHash: economics.parameterHash,
    liveExecutionPolicyId: policy.liveExecutionPolicyId,
    instrumentSpecSnapshotId: constraints.instrumentSpecSnapshotId,
    authorizedNotionalInr: canonicalPositiveLiveDecimal(economics.authorizedNotionalInr, 'authorizedNotionalInr'),
    settlementRateInrPerQuote: economics.settlementRateInrPerQuote === null ? null : canonicalPositiveLiveDecimal(economics.settlementRateInrPerQuote, 'settlementRateInrPerQuote'),
    positionInstanceId: economics.positionInstanceId,
    positionRevision: economics.positionRevision,
    reduceOnlyQuantity: economics.reduceOnlyQuantity === null ? null : canonicalPositiveLiveDecimal(economics.reduceOnlyQuantity, 'reduceOnlyQuantity'),
  };

  return new LiveExecutionIntent(INTENT_ISSUER, {
    intentId: computeLiveExecutionIntentId(content),
    clientOrderId: deriveLiveClientOrderId(content),
    content,
    lineage: input.lineage,
    wireOrderType,
    quantityAdjusted: quantized.quantityAdjusted,
    priceAdjusted: quantized.priceAdjusted,
  });
}

/**
 * Re-derives identity from an intent's own content and proves it still matches.
 * Called at every consumption boundary so a tampered or hand-built record can
 * never be dispatched under an identity it does not actually hash to.
 */
export function assertLiveExecutionIntentIdentity(record: LiveExecutionIntentRecord): void {
  const expectedIntentId = computeLiveExecutionIntentId(record.content);
  const expectedClientOrderId = deriveLiveClientOrderId(record.content);
  if (record.intentId !== expectedIntentId || record.clientOrderId !== expectedClientOrderId) {
    throw new LiveExecutionError('LIVE_INTENT_CONFLICT', 'Live execution intent identity does not match its own economic content', {
      details: { intentId: record.intentId },
    });
  }
}
