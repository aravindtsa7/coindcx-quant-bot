import { describe, expect, it } from 'vitest';
import { initialPracticalFence } from '../../../../../src/execution/live/practical/fence';
import { classifyPracticalInvalidation } from '../../../../../src/execution/live/practical/invalidation';
import { PRACTICAL_INVALIDATION_REASONS, type PracticalAccountStateName } from '../../../../../src/execution/live/practical/types';
import { planPracticalAccountChange, type PracticalAccountChangeRequest } from '../../../../../src/execution/live/practical-persistence/plan';
import type { PracticalAccountSnapshot } from '../../../../../src/execution/live/practical-persistence/ports';

// Pure planning rules. The ids are deterministic so each rule is exact.

const ACCOUNT = 'account-live-1';
const CERT = 'c'.repeat(64);
const FENCE = initialPracticalFence({ accountId: ACCOUNT, runtimeEpoch: 'epoch-a', reconciliationGeneration: 1 });

function ids(): () => string {
  let n = 0;
  return () => `new-id-${++n}`;
}

function snapshot(state: PracticalAccountStateName): PracticalAccountSnapshot {
  const recovering = ['QUARANTINED', 'CERTIFYING', 'PROVIDER_UNAVAILABLE'].includes(state);
  return {
    accountId: ACCOUNT,
    state,
    stateRevision: 3,
    fence: FENCE,
    currentRecoveryEpisode: recovering ? {
      episodeId: 'recovery-current', accountId: ACCOUNT, startedAtMs: 1, endedAtMs: null, startCause: 'RUNTIME_STARTUP', status: 'OPEN',
      runtimeEpoch: 'epoch-a', reconciliationGeneration: 0, certifiedCertificateId: null, reviewEpisodeId: null, openedByResolutionId: null,
    } : null,
    currentReviewEpisode: state === 'MANUAL_REVIEW_REQUIRED' ? {
      reviewEpisodeId: 'review-current', accountId: ACCOUNT, kind: 'INVALIDATION', enteredAtMs: 1, reason: 'ORPHAN_ORDER', malformedProblem: null, runtimeEpoch: 'epoch-a',
      status: 'OPEN', resolvedAtMs: null, resolutionId: null,
    } : null,
    currentCertificate: state === 'CERTIFIED_IDLE' ? {
      certificateId: CERT, accountId: ACCOUNT, providerAccountFingerprint: 'f'.repeat(64), runtimeEpoch: 'epoch-a', reconciliationGeneration: 1,
      streamIncarnation: 1, evidenceDigest: 'e'.repeat(64), issuedAtMs: 1, expiresAtMs: 2, status: 'ISSUED', terminalAtMs: null, terminalReason: null,
    } : null,
    currentLease: null,
    leasedCertificate: null,
  };
}

const request = (nextState: PracticalAccountStateName, extra: Partial<PracticalAccountChangeRequest> = {}): PracticalAccountChangeRequest => ({
  nextState, nextFence: null, openCause: 'RUNTIME_STARTUP', reason: null, ...extra,
});

const RESOLUTION = { resolutionId: 'resolution-1', assertedBy: 'operator-label', note: 'reviewed' };

describe('manual-review episode rules', () => {
  it('entering review creates a NEW episode id and escalates the open recovery episode to it', () => {
    const plan = planPracticalAccountChange(snapshot('QUARANTINED'), request('MANUAL_REVIEW_REQUIRED', { reason: 'ORPHAN_ORDER' }), ids());
    expect(plan.enterReviewEpisode).toEqual({ reviewEpisodeId: 'new-id-1', reason: 'ORPHAN_ORDER' });
    expect(plan.closeRecoveryEpisode).toEqual({ episodeId: 'recovery-current', status: 'ESCALATED_TO_MANUAL_REVIEW', certifiedCertificateId: null, reviewEpisodeId: 'new-id-1' });
    expect(plan.nextPointers).toEqual({ currentRecoveryEpisodeId: null, currentReviewEpisodeId: 'new-id-1', currentCertificateId: null });
  });

  it('staying in review preserves the CURRENT unresolved episode: no new episode is ever created', () => {
    const plan = planPracticalAccountChange(snapshot('MANUAL_REVIEW_REQUIRED'), request('MANUAL_REVIEW_REQUIRED', { reason: 'UNEXPLAINED_POSITION' }), ids());
    expect(plan.enterReviewEpisode).toBeNull();
    expect(plan.nextPointers.currentReviewEpisodeId).toBe('review-current');
  });

  it('leaving review requires the resolution, resolves exactly the current episode, and opens a recovery episode linked to it', () => {
    expect(() => planPracticalAccountChange(snapshot('MANUAL_REVIEW_REQUIRED'), request('QUARANTINED'), ids())).toThrow(/requires the genuine resolution/);
    const plan = planPracticalAccountChange(snapshot('MANUAL_REVIEW_REQUIRED'), request('QUARANTINED', { openCause: 'OPERATOR_RESOLVED', resolution: RESOLUTION }), ids());
    expect(plan.resolveReviewEpisode).toEqual({ reviewEpisodeId: 'review-current', resolution: RESOLUTION });
    expect(plan.openRecoveryEpisode).toEqual({ episodeId: 'new-id-1', cause: 'OPERATOR_RESOLVED', reconciliationGeneration: 1, openedByResolutionId: 'resolution-1' });
    expect(plan.nextPointers).toEqual({ currentRecoveryEpisodeId: 'new-id-1', currentReviewEpisodeId: null, currentCertificateId: null });
  });

  it('a resolution is refused anywhere except on the way out of review', () => {
    for (const [from, to] of [['QUARANTINED', 'QUARANTINED'], ['MANUAL_REVIEW_REQUIRED', 'MANUAL_REVIEW_REQUIRED'], ['QUARANTINED', 'MANUAL_REVIEW_REQUIRED']] as const) {
      expect(() => planPracticalAccountChange(snapshot(from), request(to, { reason: 'ORPHAN_ORDER', resolution: RESOLUTION }), ids())).toThrow(/PRACTICAL_PERSISTENCE_INVALID_INPUT/);
    }
  });

  it('entering review without a typed reason is refused', () => {
    expect(() => planPracticalAccountChange(snapshot('QUARANTINED'), request('MANUAL_REVIEW_REQUIRED'), ids())).toThrow(/requires a typed reason/);
  });

  it('entering review with a QUARANTINE-severity reason is refused: no such episode can ever be written', () => {
    for (const reason of PRACTICAL_INVALIDATION_REASONS.filter((candidate) => classifyPracticalInvalidation(candidate) === 'QUARANTINE')) {
      expect(() => planPracticalAccountChange(snapshot('QUARANTINED'), request('MANUAL_REVIEW_REQUIRED', { reason }), ids()), reason)
        .toThrow(/MANUAL_REVIEW-severity reason/);
    }
  });

  it('every generated id is requested by kind, so the repository can validate each one against its column', () => {
    const requested: string[] = [];
    planPracticalAccountChange(snapshot('MANUAL_REVIEW_REQUIRED'), request('QUARANTINED', { openCause: 'OPERATOR_RESOLVED', resolution: RESOLUTION }), (kind) => {
      requested.push(kind);
      return 'id-1';
    });
    planPracticalAccountChange(snapshot('QUARANTINED'), request('MANUAL_REVIEW_REQUIRED', { reason: 'ORPHAN_ORDER' }), (kind) => {
      requested.push(kind);
      return 'id-2';
    });
    expect(requested).toEqual(['recoveryEpisodeId', 'reviewEpisodeId']);
  });

  it('entering review from MUTATING (invalidated mid-mutation) creates a review episode and opens no recovery episode', () => {
    const plan = planPracticalAccountChange(snapshot('MUTATING'), request('MANUAL_REVIEW_REQUIRED', { reason: 'ACCOUNT_IDENTITY_MISMATCH' }), ids());
    expect(plan.enterReviewEpisode).toEqual({ reviewEpisodeId: 'new-id-1', reason: 'ACCOUNT_IDENTITY_MISMATCH' });
    expect(plan.openRecoveryEpisode).toBeNull();
    expect(plan.closeRecoveryEpisode).toBeNull();
  });
});

describe('certificate rules', () => {
  it('leaving CERTIFIED_IDLE by invalidation REVOKES the current certificate with the reason and opens a recovery episode', () => {
    const plan = planPracticalAccountChange(snapshot('CERTIFIED_IDLE'), request('QUARANTINED', { reason: 'PRIVATE_STATE_EVENT', openCause: 'PRIVATE_STATE_EVENT' }), ids());
    expect(plan.terminateCertificate).toEqual({ certificateId: CERT, status: 'REVOKED', reason: 'PRIVATE_STATE_EVENT' });
    expect(plan.openRecoveryEpisode).toMatchObject({ cause: 'PRIVATE_STATE_EVENT' });
    expect(plan.nextPointers.currentCertificateId).toBeNull();
  });

  it('leaving CERTIFIED_IDLE without a reason is refused (a certificate is never silently dropped)', () => {
    expect(() => planPracticalAccountChange(snapshot('CERTIFIED_IDLE'), request('QUARANTINED'), ids())).toThrow(/typed invalidation reason/);
  });

  it('CONSUMED exactly into MUTATING; EXPIRED only with CERTIFICATE_EXPIRED', () => {
    expect(planPracticalAccountChange(snapshot('CERTIFIED_IDLE'), request('MUTATING', { certificateTermination: 'CONSUMED' }), ids()).terminateCertificate)
      .toEqual({ certificateId: CERT, status: 'CONSUMED', reason: null });
    expect(() => planPracticalAccountChange(snapshot('CERTIFIED_IDLE'), request('MUTATING', { reason: 'WS_DISCONNECTED' }), ids())).toThrow(/CONSUMED exactly/);
    expect(() => planPracticalAccountChange(snapshot('CERTIFIED_IDLE'), request('QUARANTINED', { certificateTermination: 'CONSUMED' }), ids())).toThrow(/CONSUMED exactly/);
    expect(() => planPracticalAccountChange(snapshot('CERTIFIED_IDLE'), request('QUARANTINED', { certificateTermination: 'EXPIRED', reason: 'WS_DISCONNECTED' }), ids()))
      .toThrow(/requires CERTIFICATE_EXPIRED/);
    expect(planPracticalAccountChange(snapshot('CERTIFIED_IDLE'), request('QUARANTINED', { certificateTermination: 'EXPIRED', reason: 'CERTIFICATE_EXPIRED' }), ids()).terminateCertificate)
      .toEqual({ certificateId: CERT, status: 'EXPIRED', reason: 'CERTIFICATE_EXPIRED' });
  });

  it('entering CERTIFIED_IDLE requires the new certificate and closes the recovery episode CERTIFIED with it', () => {
    expect(() => planPracticalAccountChange(snapshot('CERTIFYING'), request('CERTIFIED_IDLE'), ids())).toThrow(/newly persisted certificate/);
    const plan = planPracticalAccountChange(snapshot('CERTIFYING'), request('CERTIFIED_IDLE', { newCertificateId: CERT }), ids());
    expect(plan.closeRecoveryEpisode).toEqual({ episodeId: 'recovery-current', status: 'CERTIFIED', certifiedCertificateId: CERT, reviewEpisodeId: null });
    expect(plan.nextPointers).toEqual({ currentRecoveryEpisodeId: null, currentReviewEpisodeId: null, currentCertificateId: CERT });
  });

  it('a new certificate is refused outside entry into CERTIFIED_IDLE', () => {
    expect(() => planPracticalAccountChange(snapshot('QUARANTINED'), request('CERTIFYING', { newCertificateId: CERT }), ids())).toThrow(/only accompany entry/);
  });
});

describe('recovery episode rules', () => {
  it('moving within {QUARANTINED, CERTIFYING, PROVIDER_UNAVAILABLE} keeps the same open episode', () => {
    for (const [from, to] of [['QUARANTINED', 'CERTIFYING'], ['CERTIFYING', 'PROVIDER_UNAVAILABLE'], ['PROVIDER_UNAVAILABLE', 'QUARANTINED'], ['CERTIFYING', 'QUARANTINED']] as const) {
      const plan = planPracticalAccountChange(snapshot(from), request(to), ids());
      expect(plan.openRecoveryEpisode).toBeNull();
      expect(plan.closeRecoveryEpisode).toBeNull();
      expect(plan.nextPointers.currentRecoveryEpisodeId).toBe('recovery-current');
    }
  });

  it('a recorded mutation outcome (MUTATING -> QUARANTINED) opens a NEW episode with that cause', () => {
    const plan = planPracticalAccountChange(snapshot('MUTATING'), request('QUARANTINED', { openCause: 'MUTATION_OUTCOME_RECORDED' }), ids());
    expect(plan.openRecoveryEpisode).toMatchObject({ episodeId: 'new-id-1', cause: 'MUTATION_OUTCOME_RECORDED', openedByResolutionId: null });
  });

  it('a recovery episode can only end CERTIFIED or ESCALATED', () => {
    expect(() => planPracticalAccountChange(snapshot('QUARANTINED'), request('MUTATING', { certificateTermination: 'CONSUMED' }), ids())).toThrow(/INVALID_INPUT/);
  });
});
