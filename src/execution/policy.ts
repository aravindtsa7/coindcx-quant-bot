import { paperSourceInvalid } from './errors';
import { sha256CanonicalJson } from '../risk';
import { paperDecimal } from './decimal';
import { canonicalPersistedDecimal, canonicalPositivePersistedDecimal } from './snapshot-decimal';

export const EXECUTION_POLICY_VERSION = 'P14_EXECUTION_POLICY_V1' as const;

export interface MarketEvidenceEligibilityPolicy {
  readonly maxEvidenceAgeMs: number;
  readonly requiredHealthState: 'HEALTHY' | 'DEGRADED_ANALYTICAL_ONLY';
}

/**
 * Immutable, content-addressed execution policy content. An `ExecutionIntent`
 * binds `executionPolicySnapshotId`, never the mutable "current config" — a
 * config change after an intent exists produces a new snapshot id for *new*
 * intents only, and never reinterprets an already-minted intent (V2 §6).
 */
export interface ExecutionPolicySnapshotContent {
  readonly policyVersion: typeof EXECUTION_POLICY_VERSION;
  readonly fillSelectionPolicy: string;
  readonly marketEvidenceEligibilityPolicy: MarketEvidenceEligibilityPolicy;
  readonly takerFeeRate: string;
  readonly slippageBps: string;
  readonly spreadSemantics: string;
  readonly tickRoundingPolicy: string;
  readonly quantityPolicy: string;
  readonly contractMultiplier: string;
  readonly currencyConversionPolicy: string;
  readonly accountingPolicy: string;
  readonly executionSemanticsVersion: string;
}

export interface ExecutionPolicySnapshot {
  readonly executionPolicySnapshotId: string;
  readonly content: ExecutionPolicySnapshotContent;
}

function assertNonEmptyPolicyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) paperSourceInvalid(`${label} must be a non-empty exact string`);
}

export function normalizeExecutionPolicySnapshotContent(content: ExecutionPolicySnapshotContent): ExecutionPolicySnapshotContent {
  if (content.policyVersion !== EXECUTION_POLICY_VERSION) paperSourceInvalid('policyVersion must be the frozen execution policy version');
  assertNonEmptyPolicyString(content.fillSelectionPolicy, 'fillSelectionPolicy');
  assertNonEmptyPolicyString(content.spreadSemantics, 'spreadSemantics');
  assertNonEmptyPolicyString(content.tickRoundingPolicy, 'tickRoundingPolicy');
  assertNonEmptyPolicyString(content.quantityPolicy, 'quantityPolicy');
  assertNonEmptyPolicyString(content.currencyConversionPolicy, 'currencyConversionPolicy');
  assertNonEmptyPolicyString(content.accountingPolicy, 'accountingPolicy');
  assertNonEmptyPolicyString(content.executionSemanticsVersion, 'executionSemanticsVersion');
  const eligibility = content.marketEvidenceEligibilityPolicy;
  if (eligibility === null || typeof eligibility !== 'object') paperSourceInvalid('marketEvidenceEligibilityPolicy must be an object');
  if (!Number.isSafeInteger(eligibility.maxEvidenceAgeMs) || eligibility.maxEvidenceAgeMs < 0 || eligibility.maxEvidenceAgeMs > 2_147_483_647) {
    paperSourceInvalid('marketEvidenceEligibilityPolicy.maxEvidenceAgeMs must be a non-negative 32-bit integer');
  }
  if (eligibility.requiredHealthState !== 'HEALTHY' && eligibility.requiredHealthState !== 'DEGRADED_ANALYTICAL_ONLY') {
    paperSourceInvalid('marketEvidenceEligibilityPolicy.requiredHealthState must be HEALTHY or DEGRADED_ANALYTICAL_ONLY');
  }
  const takerFeeRate = canonicalPersistedDecimal(content.takerFeeRate, 'takerFeeRate');
  const slippageBps = canonicalPersistedDecimal(content.slippageBps, 'slippageBps');
  const contractMultiplier = canonicalPositivePersistedDecimal(content.contractMultiplier, 'contractMultiplier');
  if (takerFeeRate.startsWith('-')) paperSourceInvalid('takerFeeRate must be non-negative; fee rebates are not modeled');
  if (slippageBps.startsWith('-') || paperDecimal(slippageBps).greaterThanOrEqualTo(paperDecimal('10000'))) {
    paperSourceInvalid('slippageBps must be greater than or equal to 0 and less than 10000');
  }
  return Object.freeze({
    policyVersion: EXECUTION_POLICY_VERSION,
    fillSelectionPolicy: content.fillSelectionPolicy,
    marketEvidenceEligibilityPolicy: Object.freeze({ maxEvidenceAgeMs: eligibility.maxEvidenceAgeMs, requiredHealthState: eligibility.requiredHealthState }),
    takerFeeRate,
    slippageBps,
    spreadSemantics: content.spreadSemantics,
    tickRoundingPolicy: content.tickRoundingPolicy,
    quantityPolicy: content.quantityPolicy,
    contractMultiplier,
    currencyConversionPolicy: content.currencyConversionPolicy,
    accountingPolicy: content.accountingPolicy,
    executionSemanticsVersion: content.executionSemanticsVersion,
  });
}

/**
 * Builds the immutable, content-addressed policy snapshot. Purely a function of
 * `content` — no wall clock, random value, PID, or host timezone participates in
 * `executionPolicySnapshotId`. Equivalent decimal representations ("0.001" vs
 * "0.0010") normalize to the same canonical string before hashing, so they
 * always produce the identical id.
 */
export function buildExecutionPolicySnapshot(content: ExecutionPolicySnapshotContent): ExecutionPolicySnapshot {
  const normalized = normalizeExecutionPolicySnapshotContent(content);
  const executionPolicySnapshotId = sha256CanonicalJson(normalized);
  return Object.freeze({ executionPolicySnapshotId, content: normalized });
}

/** Recomputes the frozen canonical hash at every economic consumption boundary. */
export function validateExecutionPolicySnapshot(snapshot: ExecutionPolicySnapshot): ExecutionPolicySnapshot {
  const rebuilt = buildExecutionPolicySnapshot(snapshot.content);
  if (snapshot.executionPolicySnapshotId !== rebuilt.executionPolicySnapshotId) {
    paperSourceInvalid('POLICY_IDENTITY_MISMATCH');
  }
  return rebuilt;
}
