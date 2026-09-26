/**
 * Phase 18B Checkpoint C: the durable shadow calibration store port.
 *
 * It persists ONLY observational data (`live_practical_shadow_*`): campaigns,
 * evaluation windows, and hypothetical paper decisions. It has no operation
 * that reads or writes Stage 1B1 practical authority rows, no certificate,
 * lease, dispatch, or gateway operation, and nothing it stores is authority.
 *
 * Every write is a compare-and-set under a row lock in ONE transaction
 * (the Stage 1B1 pattern):
 *   - one ACTIVE campaign per account (the account row's pointer);
 *   - a campaign is owned by one worker at a time; resuming it with the SAME
 *     binding (account, fingerprint, CLEAN source commit, configuration
 *     digest, evidence schema version) takes ownership and ABORTS every
 *     evaluation the previous worker left CLAIMED (a crash never becomes a
 *     completed observation);
 *   - an evaluation is completed at most once, only by its claiming worker
 *     while it still owns the campaign (a stale worker loses);
 *   - a normal stop requires the owning worker (hence the same binding); an
 *     operator whose binding drifted uses the separate, explicit
 *     `abortCampaign` (exact account + campaign id, ACTIVE only), which never
 *     resumes, collects, or resurrects anything.
 */
import type { PracticalShadowSourceProvenanceKind } from './provenance';
import type {
  PracticalPaperAction,
  PracticalPaperOutcome,
  PracticalPaperRolloutStage,
  PracticalShadowStreamReadiness,
} from './types';

export type PracticalShadowCampaignStatus = 'ACTIVE' | 'COMPLETED' | 'ABORTED';
export type PracticalShadowEvaluationStatus = 'CLAIMED' | 'COMPLETED' | 'ABORTED';

/** What binds a campaign: a resume must present exactly this. */
export interface PracticalShadowCampaignBinding {
  readonly accountId: string;
  readonly providerAccountFingerprint: string;
  /** The exact CLEAN source commit (lowercase 40-hex). */
  readonly softwareVersion: string;
  readonly sourceProvenance: PracticalShadowSourceProvenanceKind;
  readonly configDigest: string;
  readonly evidenceSchemaVersion: string;
}

export interface PracticalShadowCampaignRecord extends PracticalShadowCampaignBinding {
  readonly campaignId: string;
  readonly configJson: string;
  readonly status: PracticalShadowCampaignStatus;
  readonly workerId: string;
  readonly nextSequence: number;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly endReason: string | null;
  readonly revision: number;
}

export interface PracticalShadowEvaluationRecord {
  readonly evaluationId: string;
  readonly campaignId: string;
  readonly sequence: number;
  readonly workerId: string;
  readonly runtimeEpoch: string;
  readonly status: PracticalShadowEvaluationStatus;
  readonly claimedAtMs: number;
  readonly finishedAtMs: number | null;
  readonly abortReason: string | null;
  readonly result: PracticalShadowEvaluationResult | null;
}

/** The stored classification + safe evidence of a COMPLETED evaluation. */
export interface PracticalShadowEvaluationResult {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly reconciliationGeneration: number | null;
  readonly streamIncarnation: number | null;
  readonly streamReadiness: PracticalShadowStreamReadiness;
  readonly restStability: 'PASS' | 'FAIL';
  readonly restFailure: string | null;
  readonly authorityEligible: boolean;
  readonly primaryBlocker: string | null;
  readonly blockers: readonly string[];
  readonly evidenceSchemaVersion: string;
  readonly evidenceDigest: string;
  readonly evidenceJson: string;
}

export interface PracticalShadowPaperDecisionRecord {
  readonly paperDecisionId: string;
  readonly evaluationId: string;
  readonly campaignId: string;
  readonly requestedAction: PracticalPaperAction;
  readonly rolloutStage: PracticalPaperRolloutStage;
  readonly restStability: 'PASS' | 'FAIL';
  readonly streamReadiness: PracticalShadowStreamReadiness;
  readonly authorityPrerequisitesMet: boolean;
  readonly outcome: PracticalPaperOutcome;
  readonly blockers: readonly string[];
  readonly policyVersion: string;
  readonly createdAtMs: number;
}

export type PracticalShadowStartResult =
  | { readonly kind: 'STARTED'; readonly campaign: PracticalShadowCampaignRecord }
  | { readonly kind: 'ACTIVE_CAMPAIGN_EXISTS'; readonly campaign: PracticalShadowCampaignRecord };

export type PracticalShadowResumeResult =
  | { readonly kind: 'RESUMED'; readonly campaign: PracticalShadowCampaignRecord; readonly abortedEvaluations: number }
  | { readonly kind: 'NO_ACTIVE_CAMPAIGN' }
  /** The active campaign's binding differs: it is never silently resumed. */
  | { readonly kind: 'BINDING_MISMATCH'; readonly campaign: PracticalShadowCampaignRecord; readonly mismatches: readonly string[] };

export type PracticalShadowClaimResult =
  | { readonly kind: 'CLAIMED'; readonly evaluation: PracticalShadowEvaluationRecord }
  /** Another worker owns the campaign now, or it is no longer ACTIVE: this worker changed nothing. */
  | { readonly kind: 'STALE_WORKER' | 'CAMPAIGN_NOT_ACTIVE' };

export type PracticalShadowCompleteResult =
  | { readonly kind: 'COMPLETED'; readonly evaluation: PracticalShadowEvaluationRecord }
  | { readonly kind: 'REFUSED'; readonly reason: 'STALE_WORKER' | 'NOT_CLAIMED' | 'CAMPAIGN_NOT_ACTIVE' | 'DUPLICATE_PAPER_DECISION' };

export type PracticalShadowAbortCampaignResult =
  | { readonly kind: 'ABORTED'; readonly campaign: PracticalShadowCampaignRecord; readonly abortedEvaluations: number }
  /** Already COMPLETED or ABORTED: nothing was written (idempotent; never resurrected or changed). */
  | { readonly kind: 'ALREADY_TERMINAL'; readonly campaign: PracticalShadowCampaignRecord }
  /** No such campaign, or it belongs to another account: nothing was written. */
  | { readonly kind: 'REFUSED'; readonly reason: 'UNKNOWN_CAMPAIGN' | 'ACCOUNT_MISMATCH' };

/** A consistent snapshot for reports and replay: one read transaction, an explicit sequence cutoff. */
export interface PracticalShadowCampaignSnapshot {
  readonly campaign: PracticalShadowCampaignRecord;
  readonly evaluations: readonly PracticalShadowEvaluationRecord[];
  readonly paperDecisions: readonly PracticalShadowPaperDecisionRecord[];
  /** Every evaluation with sequence <= cutoffSequence (and only those) is in this snapshot. */
  readonly cutoffSequence: number;
}

export interface PracticalShadowStore {
  startCampaign(input: {
    readonly campaignId: string;
    readonly binding: PracticalShadowCampaignBinding;
    readonly configJson: string;
    readonly workerId: string;
    readonly nowMs: number;
  }): Promise<PracticalShadowStartResult>;

  resumeCampaign(input: { readonly binding: PracticalShadowCampaignBinding; readonly workerId: string; readonly nowMs: number }): Promise<PracticalShadowResumeResult>;

  stopCampaign(input: {
    readonly campaignId: string;
    readonly workerId: string;
    readonly status: 'COMPLETED' | 'ABORTED';
    readonly reason: string;
    readonly nowMs: number;
  }): Promise<{ readonly kind: 'STOPPED'; readonly campaign: PracticalShadowCampaignRecord } | { readonly kind: 'STALE_WORKER' | 'CAMPAIGN_NOT_ACTIVE' }>;

  /**
   * EXPLICIT operator abort, by exact account AND campaign id, of an ACTIVE
   * campaign regardless of its binding or owning worker. In ONE transaction
   * under row locks: ACTIVE -> ABORTED (compare-and-set), every CLAIMED
   * evaluation of it -> ABORTED (`OPERATOR_CAMPAIGN_ABORT`), and the account's
   * active pointer cleared. It never resumes, collects, classifies, or
   * creates paper decisions, and never touches Stage 1B1 state.
   */
  abortCampaign(input: { readonly accountId: string; readonly campaignId: string; readonly reason: string; readonly nowMs: number }): Promise<PracticalShadowAbortCampaignResult>;

  claimEvaluation(input: {
    readonly campaignId: string;
    readonly workerId: string;
    readonly evaluationId: string;
    readonly runtimeEpoch: string;
    readonly nowMs: number;
  }): Promise<PracticalShadowClaimResult>;

  completeEvaluation(input: {
    readonly evaluationId: string;
    readonly workerId: string;
    readonly result: PracticalShadowEvaluationResult;
    readonly paperDecisions: readonly PracticalShadowPaperDecisionRecord[];
    readonly nowMs: number;
  }): Promise<PracticalShadowCompleteResult>;

  abortEvaluation(input: { readonly evaluationId: string; readonly workerId: string; readonly reason: string; readonly nowMs: number }): Promise<{ readonly kind: 'ABORTED' | 'REFUSED' }>;

  loadActiveCampaign(accountId: string): Promise<PracticalShadowCampaignRecord | null>;
  loadCampaign(campaignId: string): Promise<PracticalShadowCampaignRecord | null>;
  snapshotCampaign(campaignId: string): Promise<PracticalShadowCampaignSnapshot | null>;
}
