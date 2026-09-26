/**
 * Phase 18B Checkpoint C: pure, deterministic classification of one shadow
 * evaluation from its SAFE evidence record alone (so replay recomputes it
 * exactly).
 *
 * The three concepts stay separate:
 *   - `classifyRestStability`: A. REST_STABILITY_CANDIDATE, from the REST
 *     reads only, with the EXACT Checkpoint B bracket semantics (identity,
 *     O1 P1 O2 P2 O3, identity; completeness; O1 == O2 == O3; P1 == P2;
 *     identical pass digests; pass count, spacing, span) plus the hard pass
 *     ceiling. PASS is calibration evidence, never authority;
 *   - `evaluateAuthorityEligibility`: B. AUTHORITY_ELIGIBILITY, whether EVERY
 *     real authority prerequisite WOULD hold. The recorded stream readiness
 *     is used EXACTLY as observed: UNPROVEN is never upgraded, so on the real
 *     CoinDCX stream the result is always false with the primary blocker
 *     PRIVATE_STREAM_READINESS_UNPROVEN;
 *   - `decidePaperSafety`: C. PAPER_DECISION, a hypothetical outcome per
 *     paper intent (WOULD_BLOCK or WOULD_REACH_AUTHORITY_GATE). It never
 *     calls the real authority gate, never consumes a certificate, and never
 *     takes a lease; "reaching the gate" is itself only a hypothesis.
 *
 * This module is the only place these branded values are constructed.
 */
import { sha256CanonicalJson } from '../../../risk';
import { VERIFIED_REDUCE_ONLY_CAPABILITY, practicalActionPermission } from '../practical/policy';
import {
  assemblePracticalPass,
  evaluatePracticalCertificationEvidence,
  type PracticalObservationPass,
  type PracticalReadObservation,
} from '../practical-recovery/observation';
import type { PracticalShadowEvidence } from './evidence';
import {
  PRACTICAL_AUTHORITY_BLOCKERS,
  PRACTICAL_PAPER_POLICY_VERSION,
  PracticalShadowError,
  type PracticalAuthorityBlocker,
  type PracticalAuthorityEligibility,
  type PracticalPaperAction,
  type PracticalPaperBlocker,
  type PracticalPaperIntent,
  type PracticalPaperPolicyBlocker,
  type PracticalPaperRolloutStage,
  type PracticalPaperSafetyDecision,
  type PracticalRestStabilityCandidate,
} from './types';

// ---------------------------------------------------------------------------
// Passes from stored reads
// ---------------------------------------------------------------------------

/** Re-assembles the Checkpoint B passes from the stored reads (grouped by pass index, in order). */
export function practicalShadowPasses(evidence: PracticalShadowEvidence): readonly PracticalObservationPass[] {
  const byPass = new Map<number, PracticalReadObservation[]>();
  for (const entry of evidence.reads) {
    const reads = byPass.get(entry.passIndex) ?? [];
    reads.push(Object.freeze({
      slot: entry.slot,
      kind: entry.kind,
      startedAtMs: entry.startedAtMs,
      endedAtMs: entry.endedAtMs,
      latencyMs: entry.latencyMs,
      failure: entry.failure,
      pagesRead: entry.pagesRead,
      complete: entry.complete,
      contentDigest: entry.contentDigest,
    }));
    byPass.set(entry.passIndex, reads);
  }
  return [...byPass.keys()].sort((a, b) => a - b).map((index) => assemblePracticalPass(index, byPass.get(index)!));
}

// ---------------------------------------------------------------------------
// A. REST stability candidate
// ---------------------------------------------------------------------------

function restCandidate(result: 'PASS' | 'FAIL', failure: string | null): PracticalRestStabilityCandidate {
  return Object.freeze({ concept: 'REST_STABILITY_CANDIDATE' as const, result, failure, grantsAuthority: false as const }) as unknown as PracticalRestStabilityCandidate;
}

/** Calibration-only REST stability, from the REST reads alone. */
export function classifyRestStability(evidence: PracticalShadowEvidence): PracticalRestStabilityCandidate {
  if (evidence.clockAnomaly) return restCandidate('FAIL', 'CLOCK_ANOMALY');
  const passes = practicalShadowPasses(evidence);
  const firstReconciliation = evidence.reconciliation[0];
  const evaluation = evaluatePracticalCertificationEvidence(
    {
      accountId: evidence.accountId,
      providerAccountFingerprint: evidence.expectedProviderAccountFingerprint,
      runtimeEpoch: evidence.runtimeEpoch,
      reconciliationGeneration: firstReconciliation?.currentGeneration ?? -1,
      streamIncarnation: evidence.readiness.atStart.incarnation ?? -1,
      runId: evidence.evaluationId,
    },
    passes,
    evidence.window,
  );
  if (evaluation.kind === 'REJECTED') return restCandidate('FAIL', evaluation.failure);
  if (passes.some((pass) => pass.durationMs > evidence.timing.hardPassDurationMs)) return restCandidate('FAIL', 'PASS_HARD_CEILING_EXCEEDED');
  return restCandidate('PASS', null);
}

// ---------------------------------------------------------------------------
// B. Authority eligibility (hypothetical)
// ---------------------------------------------------------------------------

const READINESS_BLOCKER = Object.freeze({
  UNPROVEN: 'PRIVATE_STREAM_READINESS_UNPROVEN',
  RECONCILIATION_REQUIRED: 'PRIVATE_STREAM_RECONCILIATION_REQUIRED',
  DISCONNECTED: 'PRIVATE_STREAM_DISCONNECTED',
} as const);

function streamBlockers(evidence: PracticalShadowEvidence, add: (blocker: PracticalAuthorityBlocker) => void): void {
  const samples = [evidence.readiness.atStart, ...evidence.readiness.samples, evidence.readiness.atEnd];
  for (const sample of samples) {
    if (sample.readiness !== 'PROVEN_READY') add(READINESS_BLOCKER[sample.readiness]);
  }
  const startIncarnation = evidence.readiness.atStart.incarnation;
  if (samples.some((sample) => sample.incarnation !== startIncarnation)) add('PRIVATE_STREAM_INCARNATION_CHANGED');
  if (evidence.readiness.atStart.readiness === 'PROVEN_READY'
    && (samples.some((sample) => sample.readiness !== 'PROVEN_READY') || evidence.streamHealthTrip !== null)) {
    add('PRIVATE_STREAM_READINESS_LOST');
  }
  if (evidence.events.total > 0) add('PRIVATE_STREAM_EVENT_DURING_WINDOW');
}

function reconciliationBlockers(evidence: PracticalShadowEvidence, add: (blocker: PracticalAuthorityBlocker) => void): number | null {
  const samples = evidence.reconciliation;
  const start = samples[0];
  if (start === undefined || samples.some((sample) => !sample.available || sample.currentGeneration === null)) {
    add('PHASE18_STATE_UNAVAILABLE');
    return null;
  }
  const generation = start.currentGeneration!;
  if (samples.some((sample) => sample.status !== 'HEALTHY' || sample.healthyGeneration !== sample.currentGeneration)) add('PHASE18_NOT_HEALTHY');
  if (samples.some((sample) => !sample.runtimeEpochMatches)) add('PHASE18_OTHER_RUNTIME');
  if (samples.some((sample) => sample.currentGeneration !== generation)) add('PHASE18_GENERATION_CHANGED');
  // Mirrors "claimed after the watch armed": the generation must have advanced after this stream incarnation was first observed.
  if (evidence.generationBaseline === null || generation <= evidence.generationBaseline) add('PHASE18_GENERATION_NOT_AFTER_STREAM_OBSERVATION');
  return generation;
}

function accountBlockers(evidence: PracticalShadowEvidence, generation: number | null, add: (blocker: PracticalAuthorityBlocker) => void): void {
  const account = evidence.practicalAccount;
  if (!account.readable) {
    add('PRACTICAL_ACCOUNT_UNREADABLE');
    return;
  }
  const startable = (account.state === 'QUARANTINED' || account.state === 'PROVIDER_UNAVAILABLE') && account.fenceMode === 'IDLE'
    && account.hasCurrentCertificate === false && account.hasLease === false;
  if (!startable) add('PRACTICAL_ACCOUNT_NOT_QUARANTINED_IDLE');
  if (account.fenceRuntimeEpochMatches !== true) add('PRACTICAL_FENCE_OTHER_RUNTIME');
  if (generation === null || account.fenceGeneration === null || generation <= account.fenceGeneration) add('PHASE18_GENERATION_NOT_NEWER_THAN_FENCE');
}

function eligibility(blockers: readonly PracticalAuthorityBlocker[]): PracticalAuthorityEligibility {
  const ordered = PRACTICAL_AUTHORITY_BLOCKERS.filter((blocker) => blockers.includes(blocker));
  return Object.freeze({
    concept: 'AUTHORITY_ELIGIBILITY' as const,
    authorityEligible: ordered.length === 0,
    blockers: Object.freeze([...ordered]),
    primaryBlocker: ordered[0] ?? null,
    grantsAuthority: false as const,
  }) as unknown as PracticalAuthorityEligibility;
}

/** Hypothetical: would EVERY authority prerequisite hold? Never authority. */
export function evaluateAuthorityEligibility(evidence: PracticalShadowEvidence, rest: PracticalRestStabilityCandidate): PracticalAuthorityEligibility {
  const blockers = new Set<PracticalAuthorityBlocker>();
  const add = (blocker: PracticalAuthorityBlocker): void => {
    blockers.add(blocker);
  };
  streamBlockers(evidence, add);
  if (rest.result !== 'PASS') add('REST_STABILITY_NOT_PASSED');
  const generation = reconciliationBlockers(evidence, add);
  accountBlockers(evidence, generation, add);
  if (evidence.tierB.status !== 'ELIGIBLE' || !evidence.tierB.accountAllowlisted) add('TIER_B_NOT_ENABLED_FOR_ACCOUNT');
  return eligibility([...blockers]);
}

// ---------------------------------------------------------------------------
// C. Paper safety decisions (hypothetical)
// ---------------------------------------------------------------------------

export function practicalPaperIntent(requestedAction: PracticalPaperAction, rolloutStage: PracticalPaperRolloutStage): PracticalPaperIntent {
  if (requestedAction !== 'CANCEL' && requestedAction !== 'OPEN' && requestedAction !== 'CLOSE') {
    throw new PracticalShadowError('SHADOW_CONFIG_INVALID', 'Unknown paper action');
  }
  if (rolloutStage !== 'STAGE_5A_CANCEL_ONLY' && rolloutStage !== 'STAGE_5B_OPEN_CLOSE_FUTURE') {
    throw new PracticalShadowError('SHADOW_CONFIG_INVALID', 'Unknown paper rollout stage');
  }
  return Object.freeze({ requestedAction, rolloutStage }) as unknown as PracticalPaperIntent;
}

/**
 * The (hypothetical) policy blockers of a paper intent. Stage 5a uses the
 * Stage 1A action permission (CANCEL only). Stage 5b is FUTURE: never
 * enabled here; OPEN also needs a future ResumeApproval, and CLOSE needs a
 * provider-confirmed, controlled-tested venue-enforced reduce-only
 * capability (Stage 1A: VERIFIED_REDUCE_ONLY_CAPABILITY is false).
 */
export function paperPolicyBlockers(intent: PracticalPaperIntent): readonly PracticalPaperPolicyBlocker[] {
  const blockers: PracticalPaperPolicyBlocker[] = [];
  if (intent.rolloutStage === 'STAGE_5A_CANCEL_ONLY') {
    const permission = practicalActionPermission('STAGE_5A_CANCEL_ONLY', intent.requestedAction);
    if (!permission.permitted) {
      if (permission.reason === 'OPEN_DISABLED_UNTIL_STAGE_5B' || permission.reason === 'CLOSE_REQUIRES_VERIFIED_REDUCE_ONLY') blockers.push(permission.reason);
      else throw new PracticalShadowError('SHADOW_CONFIG_INVALID', `Unexpected Stage 5a refusal ${permission.reason}`);
    }
  } else {
    blockers.push('STAGE_5B_NOT_ENABLED');
    if (intent.requestedAction === 'OPEN') blockers.push('OPEN_REQUIRES_RESUME_APPROVAL');
    if (intent.requestedAction === 'CLOSE') {
      blockers.push('CLOSE_REQUIRES_VERIFIED_REDUCE_ONLY');
      if (!VERIFIED_REDUCE_ONLY_CAPABILITY) blockers.push('CLOSE_REDUCE_ONLY_NOT_PROVIDER_CONFIRMED');
    }
  }
  return Object.freeze(blockers);
}

/** Deterministic id: one decision per (evaluation, action, stage), so replay reproduces it exactly. */
export function practicalPaperDecisionId(evaluationId: string, intent: PracticalPaperIntent): string {
  const digest = sha256CanonicalJson({ schema: 'P18B_PAPER_DECISION_ID_V1', evaluationId, action: intent.requestedAction, stage: intent.rolloutStage });
  return `pd-${digest.slice(0, 48)}`;
}

/** A hypothetical paper safety decision. It executes nothing and reaches no real gate. */
export function decidePaperSafety(
  evidence: PracticalShadowEvidence,
  rest: PracticalRestStabilityCandidate,
  authority: PracticalAuthorityEligibility,
  intent: PracticalPaperIntent,
): PracticalPaperSafetyDecision {
  const blockers: PracticalPaperBlocker[] = [...paperPolicyBlockers(intent), ...authority.blockers];
  return Object.freeze({
    concept: 'PAPER_DECISION' as const,
    paperDecisionId: practicalPaperDecisionId(evidence.evaluationId, intent),
    evaluationId: evidence.evaluationId,
    requestedAction: intent.requestedAction,
    rolloutStage: intent.rolloutStage,
    restStability: rest.result,
    streamReadiness: evidence.readiness.atStart.readiness,
    authorityPrerequisitesMet: authority.authorityEligible,
    outcome: blockers.length === 0 ? 'WOULD_REACH_AUTHORITY_GATE' as const : 'WOULD_BLOCK' as const,
    blockers: Object.freeze(blockers),
    policyVersion: PRACTICAL_PAPER_POLICY_VERSION,
    createdAtMs: evidence.endedAtMs,
    grantsAuthority: false as const,
  }) as unknown as PracticalPaperSafetyDecision;
}

/** The full classification of one evaluation. */
export interface PracticalShadowClassification {
  readonly rest: PracticalRestStabilityCandidate;
  readonly authority: PracticalAuthorityEligibility;
  readonly paperDecisions: readonly PracticalPaperSafetyDecision[];
}

export function classifyPracticalShadowEvaluation(evidence: PracticalShadowEvidence, intents: readonly PracticalPaperIntent[]): PracticalShadowClassification {
  const rest = classifyRestStability(evidence);
  const authority = evaluateAuthorityEligibility(evidence, rest);
  return Object.freeze({
    rest,
    authority,
    paperDecisions: Object.freeze(intents.map((intent) => decidePaperSafety(evidence, rest, authority, intent))),
  });
}
