/**
 * Deterministic Phase17 identity (P17-I05 / P17-I06).
 *
 * Uses the repository's existing canonical hashing convention
 * (`sha256CanonicalJson`, re-exported by `src/risk`) so a Phase17 identity is
 * byte-compatible with how every other phase hashes. No timestamp, random
 * UUID, insertion order, process state, or database auto-increment participates
 * in either identity below.
 */
import { sha256CanonicalJson } from '../../risk';
import { canonicalLiveDecimalString } from './decimal';
import { LiveExecutionError } from './errors';
import type { LiveExecutionIntentContent } from './types';

export const LIVE_EXECUTION_INTENT_IDENTITY_POLICY_ID = 'P17_LIVE_EXECUTION_INTENT_IDENTITY_V1' as const;
export const LIVE_CLIENT_ORDER_ID_POLICY_ID = 'P17_LIVE_CLIENT_ORDER_ID_V1' as const;

/**
 * Documented client-order-id adapter policy (P17-I06).
 *
 * CoinDCX's published futures order contract does not establish a
 * `client_order_id` at all. This is therefore a LOCAL deterministic key only;
 * it is never sent or treated as exchange-confirmed. Its stable format remains
 * part of the local identity policy.
 *
 *   `p17-` + first 32 lowercase hex characters of a dedicated SHA-256 domain
 *
 * Total length 36; alphabet `[a-z0-9-]`. The digest is taken over a hash domain
 * distinct from the intent identity's, so a client order id can never be
 * mistaken for, or reversed into, an intent id.
 */
export const LIVE_CLIENT_ORDER_ID_PREFIX = 'p17-' as const;
export const LIVE_CLIENT_ORDER_ID_DIGEST_CHARS = 32 as const;
export const LIVE_CLIENT_ORDER_ID_LENGTH = LIVE_CLIENT_ORDER_ID_PREFIX.length + LIVE_CLIENT_ORDER_ID_DIGEST_CHARS;
export const LIVE_CLIENT_ORDER_ID_PATTERN = /^p17-[0-9a-f]{32}$/;

function assertExactId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', `${label} must be a non-empty exact string`);
  }
}

function assertNullableExactId(value: unknown, label: string): asserts value is string | null {
  if (value === null) return;
  assertExactId(value, label);
}

/**
 * Canonical identity preimage. Every outcome-relevant field of the intent is
 * bound; audit-only lineage (`researchApprovalOriginId`, `strategyOriginId`) is
 * deliberately excluded, exactly as Phase14 excludes it, so a genuine reissue
 * of the same approval never forks an existing economic identity.
 */
export function liveExecutionIntentIdentityPreimage(content: LiveExecutionIntentContent): Readonly<Record<string, unknown>> {
  assertExactId(content.accountId, 'accountId');
  assertExactId(content.pair, 'pair');
  assertExactId(content.riskDecisionId, 'riskDecisionId');
  assertExactId(content.strategyInstanceId, 'strategyInstanceId');
  assertExactId(content.strategyId, 'strategyId');
  assertExactId(content.strategyVersion, 'strategyVersion');
  assertExactId(content.parameterHash, 'parameterHash');
  assertExactId(content.liveExecutionPolicyId, 'liveExecutionPolicyId');
  assertExactId(content.instrumentSpecSnapshotId, 'instrumentSpecSnapshotId');
  assertExactId(content.authorizedNotionalInr, 'authorizedNotionalInr');
  assertNullableExactId(content.admissionId, 'admissionId');
  assertNullableExactId(content.positionInstanceId, 'positionInstanceId');
  if (content.positionRevision !== null && (!Number.isSafeInteger(content.positionRevision) || content.positionRevision < 0)) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', 'positionRevision must be a non-negative safe integer');
  }

  if (content.side !== 'BUY' && content.side !== 'SELL') {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', 'side must be BUY or SELL');
  }
  if (content.action !== 'OPEN' && content.action !== 'CLOSE') {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', 'action must be OPEN or CLOSE');
  }
  if (content.orderType !== 'MARKET' && content.orderType !== 'LIMIT') {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', 'orderType must be MARKET or LIMIT');
  }
  if (content.timeInForce !== 'UNSPECIFIED'
      && content.timeInForce !== 'GOOD_TILL_CANCEL'
      && content.timeInForce !== 'FILL_OR_KILL'
      && content.timeInForce !== 'IMMEDIATE_OR_CANCEL'
      && content.timeInForce !== 'POST_ONLY') {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', 'timeInForce must be a known Phase17 value');
  }

  return Object.freeze({
    identityPolicyId: LIVE_EXECUTION_INTENT_IDENTITY_POLICY_ID,
    accountId: content.accountId,
    pair: content.pair,
    side: content.side,
    action: content.action,
    quantity: canonicalLiveDecimalString(content.quantity, 'quantity'),
    orderType: content.orderType,
    price: content.price === null ? null : canonicalLiveDecimalString(content.price, 'price'),
    timeInForce: content.timeInForce,
    leverage: content.leverage === null ? null : canonicalLiveDecimalString(content.leverage, 'leverage'),
    riskDecisionId: content.riskDecisionId,
    admissionId: content.admissionId,
    strategyInstanceId: content.strategyInstanceId,
    strategyId: content.strategyId,
    strategyVersion: content.strategyVersion,
    parameterHash: content.parameterHash,
    liveExecutionPolicyId: content.liveExecutionPolicyId,
    instrumentSpecSnapshotId: content.instrumentSpecSnapshotId,
    authorizedNotionalInr: canonicalLiveDecimalString(content.authorizedNotionalInr, 'authorizedNotionalInr'),
    settlementRateInrPerQuote: content.settlementRateInrPerQuote === null ? null : canonicalLiveDecimalString(content.settlementRateInrPerQuote, 'settlementRateInrPerQuote'),
    positionInstanceId: content.positionInstanceId,
    positionRevision: content.positionRevision,
    reduceOnlyQuantity: content.reduceOnlyQuantity === null ? null : canonicalLiveDecimalString(content.reduceOnlyQuantity, 'reduceOnlyQuantity'),
  });
}

/** Deterministic live execution intent identity. Pure function of economic content. */
export function computeLiveExecutionIntentId(content: LiveExecutionIntentContent): string {
  return sha256CanonicalJson(liveExecutionIntentIdentityPreimage(content));
}

/**
 * Deterministic client order identity for the exact same economic content.
 *
 * Hashed in its own domain (`LIVE_CLIENT_ORDER_ID_POLICY_ID`) over the same
 * canonical preimage, then truncated per the documented adapter policy above.
 * Logically identical intents always resolve to the same value; economically
 * different intents differ in the preimage and therefore (bar a 128-bit digest
 * collision) in the id. The durable `UNIQUE(client_order_id)` constraint plus
 * `LIVE_INTENT_CONFLICT` make even a collision fail closed rather than reuse an
 * existing exchange order.
 */
export function deriveLiveClientOrderId(content: LiveExecutionIntentContent): string {
  const digest = sha256CanonicalJson({
    identityPolicyId: LIVE_CLIENT_ORDER_ID_POLICY_ID,
    intent: liveExecutionIntentIdentityPreimage(content),
  });
  const clientOrderId = `${LIVE_CLIENT_ORDER_ID_PREFIX}${digest.slice(0, LIVE_CLIENT_ORDER_ID_DIGEST_CHARS)}`;
  if (!LIVE_CLIENT_ORDER_ID_PATTERN.test(clientOrderId)) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', 'Derived client order id violated the frozen Phase17 format');
  }
  return clientOrderId;
}

/** Validates an externally-supplied (e.g. exchange-echoed) client order id against the frozen format. */
export function isLiveClientOrderId(value: unknown): value is string {
  return typeof value === 'string' && LIVE_CLIENT_ORDER_ID_PATTERN.test(value);
}
