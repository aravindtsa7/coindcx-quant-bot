/**
 * Phase 18B Checkpoint C: shadow calibration + paper safety simulation types.
 *
 * NOTHING HERE IS AUTHORITY. Three concepts are kept deliberately apart, each
 * a distinct BRANDED type that no other type (and no plain object literal)
 * can be assigned to or from:
 *
 *   A. REST_STABILITY_CANDIDATE (`PracticalRestStabilityCandidate`): whether
 *      the read-only bracketed REST evidence of one evaluation was internally
 *      stable enough to be useful for CALIBRATION. It says nothing about the
 *      private stream, Phase 18, or the durable fence, and is never authority.
 *   B. AUTHORITY_ELIGIBILITY (`PracticalAuthorityEligibility`): whether EVERY
 *      real authority prerequisite WOULD hold. Hypothetical: it is computed,
 *      recorded, and analysed, but it is not an enablement, a certificate, or
 *      a lease, and it never causes one. On the real CoinDCX private stream it
 *      is always false (readiness is UNPROVEN).
 *   C. PAPER_DECISION (`PracticalPaperSafetyDecision`): a hypothetical safety
 *      decision for a paper intent, recorded for analysis only. It executes
 *      nothing and cannot become a certificate, lease, dispatch claim, or
 *      gateway call.
 *
 * Each carries `grantsAuthority: false` at runtime, and none is structurally
 * compatible with `PracticalRecoveryCertificate` (a class with private state)
 * or the Tier-B enablement (architecture tests pin both).
 */
import type { PracticalPrivateStreamReadiness } from '../practical-recovery/private-events';

// ---------------------------------------------------------------------------
// Versions (persisted; an unsupported version is refused, never reinterpreted)
// ---------------------------------------------------------------------------

export const PRACTICAL_SHADOW_EVIDENCE_SCHEMA_VERSION = 'P18B_SHADOW_EVIDENCE_V1';
export const PRACTICAL_SHADOW_ANALYSIS_VERSION = 'P18B_SHADOW_ANALYSIS_V1';
export const PRACTICAL_PAPER_POLICY_VERSION = 'P18B_PAPER_SAFETY_POLICY_V1';
export const PRACTICAL_SHADOW_CONFIG_SCHEMA_VERSION = 'P18B_SHADOW_CONFIG_V1';

export const PRACTICAL_SHADOW_SUPPORTED_EVIDENCE_SCHEMA_VERSIONS: readonly string[] = Object.freeze([PRACTICAL_SHADOW_EVIDENCE_SCHEMA_VERSION]);
export const PRACTICAL_SHADOW_SUPPORTED_ANALYSIS_VERSIONS: readonly string[] = Object.freeze([PRACTICAL_SHADOW_ANALYSIS_VERSION]);
export const PRACTICAL_PAPER_SUPPORTED_POLICY_VERSIONS: readonly string[] = Object.freeze([PRACTICAL_PAPER_POLICY_VERSION]);
export const PRACTICAL_SHADOW_SUPPORTED_CONFIG_SCHEMA_VERSIONS: readonly string[] = Object.freeze([PRACTICAL_SHADOW_CONFIG_SCHEMA_VERSION]);

export type PracticalShadowErrorCode =
  | 'SHADOW_CONFIG_INVALID'
  | 'SHADOW_UNSUPPORTED_VERSION'
  | 'SHADOW_EVIDENCE_INSUFFICIENT'
  | 'SHADOW_EVIDENCE_TAMPERED'
  | 'SHADOW_STORE_CONFLICT'
  | 'SHADOW_STORE_MALFORMED'
  | 'SHADOW_STORE_FAULT'
  /** The source tree has uncommitted or untracked changes: no campaign is started or resumed. */
  | 'SHADOW_SOURCE_DIRTY'
  /** The exact source commit / cleanliness could not be established: fail closed. */
  | 'SHADOW_SOURCE_PROVENANCE_UNAVAILABLE';

export class PracticalShadowError extends Error {
  public constructor(public readonly code: PracticalShadowErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'PracticalShadowError';
  }
}

/**
 * The abort reason recorded on an evaluation left CLAIMED when an operator
 * explicitly aborts its campaign (`PracticalShadowStore.abortCampaign`).
 */
export const PRACTICAL_SHADOW_OPERATOR_ABORT_REASON = 'OPERATOR_CAMPAIGN_ABORT';

/** An operator abort reason is a short upper-case CODE (never free text: nothing sensitive is persisted). */
export const PRACTICAL_SHADOW_OPERATOR_REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;

// ---------------------------------------------------------------------------
// Stream readiness (recorded exactly; never counterfactually upgraded)
// ---------------------------------------------------------------------------

export type PracticalShadowStreamReadiness = PracticalPrivateStreamReadiness['kind'];
export const PRACTICAL_SHADOW_STREAM_READINESS: readonly PracticalShadowStreamReadiness[] = Object.freeze([
  'PROVEN_READY',
  'UNPROVEN',
  'RECONCILIATION_REQUIRED',
  'DISCONNECTED',
]);

// ---------------------------------------------------------------------------
// A. REST stability candidate
// ---------------------------------------------------------------------------

declare const REST_STABILITY_CANDIDATE_BRAND: unique symbol;

/** Calibration-only: the REST bracket evidence was internally stable. NOT authority. */
export interface PracticalRestStabilityCandidate {
  readonly [REST_STABILITY_CANDIDATE_BRAND]: 'REST_STABILITY_CANDIDATE';
  readonly concept: 'REST_STABILITY_CANDIDATE';
  readonly result: 'PASS' | 'FAIL';
  /** The first violated rule when FAIL (a Checkpoint B certification failure code), null when PASS. */
  readonly failure: string | null;
  readonly grantsAuthority: false;
}

// ---------------------------------------------------------------------------
// B. Authority eligibility (hypothetical)
// ---------------------------------------------------------------------------

/**
 * Why authority WOULD NOT be available. Ordered: the first blocker in this
 * list that applies is the primary blocker.
 */
export const PRACTICAL_AUTHORITY_BLOCKERS = Object.freeze([
  'PRIVATE_STREAM_READINESS_UNPROVEN',
  'PRIVATE_STREAM_RECONCILIATION_REQUIRED',
  'PRIVATE_STREAM_DISCONNECTED',
  'PRIVATE_STREAM_INCARNATION_CHANGED',
  'PRIVATE_STREAM_READINESS_LOST',
  'PRIVATE_STREAM_EVENT_DURING_WINDOW',
  'REST_STABILITY_NOT_PASSED',
  'PHASE18_STATE_UNAVAILABLE',
  'PHASE18_NOT_HEALTHY',
  'PHASE18_OTHER_RUNTIME',
  'PHASE18_GENERATION_CHANGED',
  'PHASE18_GENERATION_NOT_AFTER_STREAM_OBSERVATION',
  'PRACTICAL_ACCOUNT_UNREADABLE',
  'PRACTICAL_ACCOUNT_NOT_QUARANTINED_IDLE',
  'PRACTICAL_FENCE_OTHER_RUNTIME',
  'PHASE18_GENERATION_NOT_NEWER_THAN_FENCE',
  'TIER_B_NOT_ENABLED_FOR_ACCOUNT',
] as const);
export type PracticalAuthorityBlocker = (typeof PRACTICAL_AUTHORITY_BLOCKERS)[number];

export function isPracticalAuthorityBlocker(value: unknown): value is PracticalAuthorityBlocker {
  return typeof value === 'string' && (PRACTICAL_AUTHORITY_BLOCKERS as readonly string[]).includes(value);
}

declare const AUTHORITY_ELIGIBILITY_BRAND: unique symbol;

/** Hypothetical: whether EVERY authority prerequisite would hold. NOT authority; never causes any. */
export interface PracticalAuthorityEligibility {
  readonly [AUTHORITY_ELIGIBILITY_BRAND]: 'AUTHORITY_ELIGIBILITY';
  readonly concept: 'AUTHORITY_ELIGIBILITY';
  readonly authorityEligible: boolean;
  /** Every blocker that applies, in canonical order. Empty exactly when `authorityEligible`. */
  readonly blockers: readonly PracticalAuthorityBlocker[];
  readonly primaryBlocker: PracticalAuthorityBlocker | null;
  readonly grantsAuthority: false;
}

// ---------------------------------------------------------------------------
// C. Paper safety decision (hypothetical)
// ---------------------------------------------------------------------------

/** A paper intent's action. Deliberately NOT `PracticalMutationAction`: a paper action is never a mutation intent. */
export type PracticalPaperAction = 'CANCEL' | 'OPEN' | 'CLOSE';
export const PRACTICAL_PAPER_ACTIONS: readonly PracticalPaperAction[] = Object.freeze(['CANCEL', 'OPEN', 'CLOSE']);

/** The rollout stage under (hypothetical) evaluation. Stage 5b is FUTURE and not enabled anywhere. */
export type PracticalPaperRolloutStage = 'STAGE_5A_CANCEL_ONLY' | 'STAGE_5B_OPEN_CLOSE_FUTURE';
export const PRACTICAL_PAPER_ROLLOUT_STAGES: readonly PracticalPaperRolloutStage[] = Object.freeze(['STAGE_5A_CANCEL_ONLY', 'STAGE_5B_OPEN_CLOSE_FUTURE']);

export type PracticalPaperOutcome = 'WOULD_BLOCK' | 'WOULD_REACH_AUTHORITY_GATE';

/** Policy blockers of a paper intent (in addition to every authority blocker). */
export type PracticalPaperPolicyBlocker =
  | 'OPEN_DISABLED_UNTIL_STAGE_5B'
  | 'CLOSE_REQUIRES_VERIFIED_REDUCE_ONLY'
  | 'STAGE_5B_NOT_ENABLED'
  | 'OPEN_REQUIRES_RESUME_APPROVAL'
  | 'CLOSE_REDUCE_ONLY_NOT_PROVIDER_CONFIRMED';

export type PracticalPaperBlocker = PracticalPaperPolicyBlocker | PracticalAuthorityBlocker;

declare const PAPER_INTENT_BRAND: unique symbol;

/** A hypothetical paper intent. Executes nothing; not a live execution intent. */
export interface PracticalPaperIntent {
  readonly [PAPER_INTENT_BRAND]: 'PAPER_INTENT';
  readonly requestedAction: PracticalPaperAction;
  readonly rolloutStage: PracticalPaperRolloutStage;
}

declare const PAPER_DECISION_BRAND: unique symbol;

/** Hypothetical paper safety decision. NOT authority; cannot become a certificate, lease, claim, or gateway call. */
export interface PracticalPaperSafetyDecision {
  readonly [PAPER_DECISION_BRAND]: 'PAPER_DECISION';
  readonly concept: 'PAPER_DECISION';
  readonly paperDecisionId: string;
  readonly evaluationId: string;
  readonly requestedAction: PracticalPaperAction;
  readonly rolloutStage: PracticalPaperRolloutStage;
  readonly restStability: 'PASS' | 'FAIL';
  readonly streamReadiness: PracticalShadowStreamReadiness;
  readonly authorityPrerequisitesMet: boolean;
  readonly outcome: PracticalPaperOutcome;
  readonly blockers: readonly PracticalPaperBlocker[];
  readonly policyVersion: string;
  readonly createdAtMs: number;
  readonly grantsAuthority: false;
}
