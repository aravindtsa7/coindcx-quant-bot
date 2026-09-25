/**
 * Phase 18B Stage 1B1: pure planning of one durable account change
 * (Prisma-free).
 *
 * The repository computes the next Stage 1A state and fence with the Stage 1A
 * pure functions, then asks this planner what that change implies for the
 * durable bookkeeping. The planner decides; the repository only executes the
 * plan, in one transaction. The rules:
 *
 *   CERTIFICATE. Leaving CERTIFIED_IDLE always terminates the current
 *     certificate: CONSUMED only into MUTATING (the lease), EXPIRED only for
 *     CERTIFICATE_EXPIRED, otherwise REVOKED with the invalidation reason.
 *     Entering CERTIFIED_IDLE requires the newly persisted certificate.
 *   MANUAL REVIEW. Entering MANUAL_REVIEW_REQUIRED creates a NEW review
 *     episode with a fresh id. Staying in review PRESERVES the current,
 *     unresolved episode (never a second one, never a reused resolved one).
 *     Leaving review requires the genuine resolution and resolves exactly the
 *     current episode.
 *   RECOVERY. An episode is open exactly while the account is QUARANTINED,
 *     CERTIFYING, or PROVIDER_UNAVAILABLE. Entering that set opens a new
 *     episode; leaving it closes the current one as CERTIFIED (with the
 *     certificate) or ESCALATED_TO_MANUAL_REVIEW (with the review episode).
 */
import type { PracticalAccountFence } from '../practical/fence';
import { classifyPracticalInvalidation } from '../practical/invalidation';
import {
  isPracticalInvalidationReason,
  type PracticalAccountStateName,
  type PracticalInvalidationReason,
  type PracticalQuarantineCause,
} from '../practical/types';
import { PracticalPersistenceError, type PracticalAccountSnapshot } from './ports';
import { PRACTICAL_RECOVERING_STATES } from './rows';

export interface PracticalResolutionAudit {
  readonly resolutionId: string;
  /** Caller-asserted audit label from the Stage 1A resolution; NOT an authenticated identity. */
  readonly assertedBy: string;
  readonly note: string;
}

/** Generates a new durable id of the named kind (the repository validates it before any write). */
export type PracticalIdGenerator = (kind: 'reviewEpisodeId' | 'recoveryEpisodeId') => string;

export interface PracticalAccountChangeRequest {
  readonly nextState: PracticalAccountStateName;
  /** The next fence, or null to leave the fence row untouched. */
  readonly nextFence: PracticalAccountFence | null;
  /** Recorded on a recovery episode this change opens. */
  readonly openCause: PracticalQuarantineCause;
  /**
   * The invalidation reason behind the change: it revokes a current
   * certificate, and it is the review reason when entering review.
   */
  readonly reason: PracticalInvalidationReason | null;
  /** How the current certificate leaves CERTIFIED_IDLE; defaults to REVOKED. */
  readonly certificateTermination?: 'CONSUMED' | 'EXPIRED' | 'REVOKED';
  /** The certificate being persisted by this change (entering CERTIFIED_IDLE). */
  readonly newCertificateId?: string | null;
  /** The genuine resolution being applied (leaving MANUAL_REVIEW_REQUIRED). */
  readonly resolution?: PracticalResolutionAudit | null;
}

export interface PracticalAccountChangePlan {
  readonly nextState: PracticalAccountStateName;
  readonly nextFence: PracticalAccountFence | null;
  readonly terminateCertificate:
    | null
    | { readonly certificateId: string; readonly status: 'CONSUMED' | 'EXPIRED' | 'REVOKED'; readonly reason: PracticalInvalidationReason | null };
  readonly enterReviewEpisode: null | { readonly reviewEpisodeId: string; readonly reason: PracticalInvalidationReason };
  readonly resolveReviewEpisode: null | { readonly reviewEpisodeId: string; readonly resolution: PracticalResolutionAudit };
  readonly closeRecoveryEpisode:
    | null
    | {
        readonly episodeId: string;
        readonly status: 'CERTIFIED' | 'ESCALATED_TO_MANUAL_REVIEW';
        readonly certifiedCertificateId: string | null;
        readonly reviewEpisodeId: string | null;
      };
  readonly openRecoveryEpisode:
    | null
    | {
        readonly episodeId: string;
        readonly cause: PracticalQuarantineCause;
        readonly reconciliationGeneration: number;
        readonly openedByResolutionId: string | null;
      };
  readonly nextPointers: {
    readonly currentRecoveryEpisodeId: string | null;
    readonly currentReviewEpisodeId: string | null;
    readonly currentCertificateId: string | null;
  };
}

function refuse(message: string): never {
  throw new PracticalPersistenceError('PRACTICAL_PERSISTENCE_INVALID_INPUT', message);
}

function planCertificate(current: PracticalAccountSnapshot, request: PracticalAccountChangeRequest): {
  readonly terminate: PracticalAccountChangePlan['terminateCertificate'];
  readonly pointer: string | null;
} {
  const leaving = current.state === 'CERTIFIED_IDLE' && request.nextState !== 'CERTIFIED_IDLE';
  const entering = current.state !== 'CERTIFIED_IDLE' && request.nextState === 'CERTIFIED_IDLE';
  if (current.state === 'CERTIFIED_IDLE' && request.nextState === 'CERTIFIED_IDLE') refuse('CERTIFIED_IDLE cannot be re-entered in place');
  if (entering) {
    if (typeof request.newCertificateId !== 'string') refuse('Entering CERTIFIED_IDLE requires the newly persisted certificate');
    return { terminate: null, pointer: request.newCertificateId };
  }
  if (request.newCertificateId !== undefined && request.newCertificateId !== null) refuse('A new certificate may only accompany entry into CERTIFIED_IDLE');
  if (!leaving) {
    if (request.certificateTermination !== undefined) refuse('No current certificate to terminate');
    return { terminate: null, pointer: null };
  }
  const certificateId = current.currentCertificate?.certificateId;
  if (certificateId === undefined) refuse('CERTIFIED_IDLE without a current certificate');
  const status = request.certificateTermination ?? 'REVOKED';
  if ((status === 'CONSUMED') !== (request.nextState === 'MUTATING')) refuse('A certificate is CONSUMED exactly when the account enters MUTATING');
  if (status === 'CONSUMED') return { terminate: { certificateId, status, reason: null }, pointer: null };
  if (status === 'EXPIRED' && request.reason !== 'CERTIFICATE_EXPIRED') refuse('An EXPIRED certificate requires CERTIFICATE_EXPIRED');
  if (!isPracticalInvalidationReason(request.reason)) refuse('Revoking the current certificate requires a typed invalidation reason');
  return { terminate: { certificateId, status, reason: request.reason }, pointer: null };
}

function planReview(current: PracticalAccountSnapshot, request: PracticalAccountChangeRequest, newId: PracticalIdGenerator): {
  readonly enter: PracticalAccountChangePlan['enterReviewEpisode'];
  readonly resolve: PracticalAccountChangePlan['resolveReviewEpisode'];
  readonly pointer: string | null;
} {
  const wasInReview = current.state === 'MANUAL_REVIEW_REQUIRED';
  const willBeInReview = request.nextState === 'MANUAL_REVIEW_REQUIRED';
  if (wasInReview && willBeInReview) {
    if (request.resolution) refuse('A resolution must leave review');
    // Deliberate idempotence: the unresolved CURRENT episode is preserved.
    return { enter: null, resolve: null, pointer: current.currentReviewEpisode!.reviewEpisodeId };
  }
  if (!wasInReview && willBeInReview) {
    if (!isPracticalInvalidationReason(request.reason)) refuse('Entering manual review requires a typed reason');
    if (classifyPracticalInvalidation(request.reason) !== 'MANUAL_REVIEW') refuse('Entering manual review requires a MANUAL_REVIEW-severity reason');
    if (request.resolution) refuse('A resolution cannot enter review');
    const reviewEpisodeId = newId('reviewEpisodeId');
    return { enter: { reviewEpisodeId, reason: request.reason }, resolve: null, pointer: reviewEpisodeId };
  }
  if (wasInReview && !willBeInReview) {
    if (!request.resolution) refuse('Leaving manual review requires the genuine resolution');
    return { enter: null, resolve: { reviewEpisodeId: current.currentReviewEpisode!.reviewEpisodeId, resolution: request.resolution }, pointer: null };
  }
  if (request.resolution) refuse('A resolution applies only to an account in review');
  return { enter: null, resolve: null, pointer: null };
}

/**
 * Plans the durable consequences of moving `current` to `request.nextState`.
 * Pure: the only non-determinism is `newId`, supplied by the caller (which
 * validates every generated id before any durable write).
 */
export function planPracticalAccountChange(
  current: PracticalAccountSnapshot,
  request: PracticalAccountChangeRequest,
  newId: PracticalIdGenerator,
): PracticalAccountChangePlan {
  const certificate = planCertificate(current, request);
  const review = planReview(current, request, newId);

  const wasRecovering = PRACTICAL_RECOVERING_STATES.has(current.state);
  const willRecover = PRACTICAL_RECOVERING_STATES.has(request.nextState);
  let closeRecoveryEpisode: PracticalAccountChangePlan['closeRecoveryEpisode'] = null;
  let openRecoveryEpisode: PracticalAccountChangePlan['openRecoveryEpisode'] = null;
  let recoveryPointer: string | null = null;
  if (wasRecovering && willRecover) {
    recoveryPointer = current.currentRecoveryEpisode!.episodeId;
  } else if (wasRecovering && !willRecover) {
    const episodeId = current.currentRecoveryEpisode!.episodeId;
    if (request.nextState === 'CERTIFIED_IDLE') {
      closeRecoveryEpisode = { episodeId, status: 'CERTIFIED', certifiedCertificateId: certificate.pointer, reviewEpisodeId: null };
    } else if (request.nextState === 'MANUAL_REVIEW_REQUIRED') {
      closeRecoveryEpisode = { episodeId, status: 'ESCALATED_TO_MANUAL_REVIEW', certifiedCertificateId: null, reviewEpisodeId: review.pointer };
    } else {
      refuse('A recovery episode can only end CERTIFIED or ESCALATED_TO_MANUAL_REVIEW');
    }
  } else if (!wasRecovering && willRecover) {
    const episodeId = newId('recoveryEpisodeId');
    openRecoveryEpisode = {
      episodeId,
      cause: request.openCause,
      reconciliationGeneration: (request.nextFence ?? current.fence).reconciliationGeneration,
      openedByResolutionId: review.resolve?.resolution.resolutionId ?? null,
    };
    recoveryPointer = episodeId;
  }

  return Object.freeze({
    nextState: request.nextState,
    nextFence: request.nextFence,
    terminateCertificate: certificate.terminate,
    enterReviewEpisode: review.enter,
    resolveReviewEpisode: review.resolve,
    closeRecoveryEpisode,
    openRecoveryEpisode,
    nextPointers: Object.freeze({
      currentRecoveryEpisodeId: recoveryPointer,
      currentReviewEpisodeId: review.pointer,
      currentCertificateId: certificate.pointer,
    }),
  });
}
