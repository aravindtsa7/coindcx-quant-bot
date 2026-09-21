/**
 * Immutable, content-addressed Phase17 live execution policy.
 *
 * Same frozen discipline as Phase14's `src/execution/policy.ts`: an intent
 * binds `liveExecutionPolicyId`, never "current config". Changing configuration
 * after an intent exists produces a different id for *new* intents only and can
 * never reinterpret an already-minted one.
 *
 * The policy records which supported execution semantics the application is
 * willing to use. Exchange capability is fixed in the adapter: policy can
 * restrict it, but cannot enable CoinDCX post-only, which is documented as
 * unsupported.
 */
import { sha256CanonicalJson } from '../../risk';
import { canonicalNonNegativeLiveDecimal } from './decimal';
import { LiveExecutionError } from './errors';
import type { LiveOrderType, LiveTimeInForce } from './types';

export const LIVE_EXECUTION_POLICY_VERSION = 'P17_LIVE_EXECUTION_POLICY_V1' as const;

export interface LiveExecutionPolicyContent {
  readonly policyVersion: typeof LIVE_EXECUTION_POLICY_VERSION;
  /** Economic order shapes this policy permits to be dispatched. */
  readonly allowedOrderTypes: readonly LiveOrderType[];
  /** Time-in-force semantics this policy permits an intent to request. */
  readonly allowedTimeInForce: readonly LiveTimeInForce[];
  /**
   * Whether the adapter may claim post-only. Verified-false for CoinDCX in
   * Phase17. A `true` value here does not create the capability; the adapter
   * independently refuses to send an unverified post-only field.
   */
  readonly postOnlySupported: boolean;
  /** Hard ceiling on a single order's notional, in INR. Exact Decimal string. */
  readonly maxOrderNotionalInr: string;
  /**
   * Age after which a still-reserved create is durably classified ambiguous.
   * This timeout never proves non-dispatch, releases a claim, or permits resend.
   */
  readonly dispatchClaimTimeoutMs: number;
  /** Wire timeout applied to every order mutation. Exceeding it is AMBIGUOUS, never failure. */
  readonly requestTimeoutMs: number;
  /** Frozen semantics tag, bumped whenever interpretation of any field changes. */
  readonly executionSemanticsVersion: string;
}

export interface LiveExecutionPolicySnapshot {
  readonly liveExecutionPolicyId: string;
  readonly content: LiveExecutionPolicyContent;
}

const ORDER_TYPES: readonly LiveOrderType[] = Object.freeze(['MARKET', 'LIMIT']);
const TIME_IN_FORCE: readonly LiveTimeInForce[] = Object.freeze([
  'UNSPECIFIED',
  'GOOD_TILL_CANCEL',
  'FILL_OR_KILL',
  'IMMEDIATE_OR_CANCEL',
  'POST_ONLY',
]);

function policyInvalid(message: string): never {
  throw new LiveExecutionError('LIVE_INTENT_INVALID', message);
}

function assertBoundedInteger(value: unknown, label: string, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    policyInvalid(`${label} must be an integer between ${min} and ${max}`);
  }
}

/** Deduplicates, validates membership, and sorts so equivalent sets hash identically. */
function normalizeSet<T extends string>(values: readonly T[], allowed: readonly T[], label: string): readonly T[] {
  if (!Array.isArray(values) || values.length === 0) policyInvalid(`${label} must be a non-empty array`);
  const unique = [...new Set(values)];
  for (const value of unique) {
    if (!allowed.includes(value)) policyInvalid(`${label} contains unsupported value`);
  }
  return Object.freeze([...unique].sort());
}

export function normalizeLiveExecutionPolicyContent(content: LiveExecutionPolicyContent): LiveExecutionPolicyContent {
  if (content.policyVersion !== LIVE_EXECUTION_POLICY_VERSION) {
    policyInvalid('policyVersion must be the frozen Phase17 live execution policy version');
  }
  if (typeof content.executionSemanticsVersion !== 'string' || content.executionSemanticsVersion.trim() !== content.executionSemanticsVersion || content.executionSemanticsVersion.length === 0) {
    policyInvalid('executionSemanticsVersion must be a non-empty exact string');
  }
  if (content.postOnlySupported !== false) {
    policyInvalid('CoinDCX futures post-only is a fixed unsupported exchange capability');
  }

  const allowedOrderTypes = normalizeSet(content.allowedOrderTypes, ORDER_TYPES, 'allowedOrderTypes');
  const allowedTimeInForce = normalizeSet(content.allowedTimeInForce, TIME_IN_FORCE, 'allowedTimeInForce');

  // A policy may not permit POST_ONLY while declaring it unsupported: that
  // combination is exactly the silent taker-degradation P17-I12 forbids.
  if (allowedTimeInForce.includes('POST_ONLY')) {
    policyInvalid('CoinDCX futures post-only cannot be enabled by policy');
  }

  assertBoundedInteger(content.dispatchClaimTimeoutMs, 'dispatchClaimTimeoutMs', 1, 3_600_000);
  assertBoundedInteger(content.requestTimeoutMs, 'requestTimeoutMs', 1, 120_000);
  const maxOrderNotionalInr = canonicalNonNegativeLiveDecimal(content.maxOrderNotionalInr, 'maxOrderNotionalInr');
  if (maxOrderNotionalInr === '0') policyInvalid('maxOrderNotionalInr must be strictly positive');

  return Object.freeze({
    policyVersion: LIVE_EXECUTION_POLICY_VERSION,
    allowedOrderTypes,
    allowedTimeInForce,
    postOnlySupported: content.postOnlySupported,
    maxOrderNotionalInr,
    dispatchClaimTimeoutMs: content.dispatchClaimTimeoutMs,
    requestTimeoutMs: content.requestTimeoutMs,
    executionSemanticsVersion: content.executionSemanticsVersion,
  });
}

/**
 * Purely a function of `content`: no wall clock, random value, PID, or host
 * timezone participates in `liveExecutionPolicyId`.
 */
export function buildLiveExecutionPolicySnapshot(content: LiveExecutionPolicyContent): LiveExecutionPolicySnapshot {
  const normalized = normalizeLiveExecutionPolicyContent(content);
  return Object.freeze({ liveExecutionPolicyId: sha256CanonicalJson(normalized), content: normalized });
}

/** Recomputes the frozen hash at every consumption boundary. */
export function validateLiveExecutionPolicySnapshot(snapshot: LiveExecutionPolicySnapshot): LiveExecutionPolicySnapshot {
  const rebuilt = buildLiveExecutionPolicySnapshot(snapshot.content);
  if (snapshot.liveExecutionPolicyId !== rebuilt.liveExecutionPolicyId) {
    throw new LiveExecutionError('LIVE_INTENT_INVALID', 'LIVE_POLICY_IDENTITY_MISMATCH');
  }
  return rebuilt;
}

/**
 * The conservative default Phase17 ships with: taker-capable order shapes only,
 * no time-in-force claim, post-only explicitly unsupported.
 */
export function defaultLiveExecutionPolicyContent(maxOrderNotionalInr: string): LiveExecutionPolicyContent {
  return Object.freeze({
    policyVersion: LIVE_EXECUTION_POLICY_VERSION,
    allowedOrderTypes: Object.freeze<LiveOrderType[]>(['LIMIT', 'MARKET']),
    allowedTimeInForce: Object.freeze<LiveTimeInForce[]>(['UNSPECIFIED']),
    postOnlySupported: false,
    maxOrderNotionalInr,
    dispatchClaimTimeoutMs: 60_000,
    requestTimeoutMs: 10_000,
    executionSemanticsVersion: 'P17_LIVE_EXECUTION_SEMANTICS_V1',
  });
}
