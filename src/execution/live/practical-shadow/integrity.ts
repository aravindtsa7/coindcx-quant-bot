/**
 * Phase 18B Checkpoint C: durable-record INTEGRITY for shadow evaluations.
 *
 * One evaluation's durable record (its result row and its paper-decision
 * rows) must tell exactly ONE story: the one its safe evidence tells, for
 * exactly the campaign and evaluation it claims to describe. This module is
 * the single place that checks it, used BEFORE durable completion by the
 * store (a disagreement rolls the whole completion back) and again by
 * offline replay (which never accepts foreign evidence into an analysis):
 *
 *   - the evidence JSON parses against the CLOSED V1 schema (unknown fields
 *     and out-of-domain codes are refused) and the digest of the REBUILT
 *     record equals the stored digest;
 *   - the evidence names EXACTLY the claimed evaluation (id, campaign, and
 *     the runtime epoch it was claimed under), the campaign's account and
 *     provider fingerprint, and the campaign's evidence schema (a
 *     self-consistent record from another account or campaign is refused);
 *   - the evidence's certification window and timing values EXACTLY equal
 *     the campaign's digest-validated configuration (no weakened pass count,
 *     spacing, span, candidate, or hard ceiling; no "at least as safe");
 *   - every top-level result field equals what the evidence and the
 *     campaign's digest-validated configuration recompute;
 *   - the paper decisions are EXACTLY the recomputed ones (one per configured
 *     action/stage, same deterministic id, same fields): none missing, none
 *     extra, none duplicated, none altered.
 *
 * Classification is recomputed only AFTER every binding holds. The only
 * evidence form ever persisted is the canonical JSON of the rebuilt record.
 *
 * Pure (no I/O). Grants no authority.
 */
import { classifyPracticalShadowEvaluation, type PracticalShadowClassification } from './classification';
import { parsePracticalShadowConfigSnapshot, type PracticalShadowConfig } from './config';
import { parsePracticalShadowEvidence, practicalShadowEvidenceDigest, type PracticalShadowEvidence } from './evidence';
import type {
  PracticalShadowCampaignRecord,
  PracticalShadowEvaluationRecord,
  PracticalShadowEvaluationResult,
  PracticalShadowPaperDecisionRecord,
} from './ports';
import { PracticalShadowError, type PracticalPaperIntent } from './types';

/** The campaign fields a record is bound to. */
export type PracticalShadowCampaignView = Pick<PracticalShadowCampaignRecord, 'campaignId' | 'accountId' | 'providerAccountFingerprint' | 'evidenceSchemaVersion'>;

/** The claimed (locked) evaluation a record must describe. */
export type PracticalShadowClaimedEvaluationView = Pick<PracticalShadowEvaluationRecord, 'evaluationId' | 'campaignId' | 'runtimeEpoch'>;

/** The configured protocol the evidence must have been collected under. */
export type PracticalShadowProtocolView = Pick<PracticalShadowConfig, 'window' | 'timing'>;

const WINDOW_FIELDS = ['minimumPasses', 'minimumPassSpacingMs', 'minimumCertificationSpanMs'] as const;
const TIMING_FIELDS = ['readCandidateMs', 'passCandidateMs', 'interReadGapCandidateMs', 'hardReadTimeoutMs', 'hardPassDurationMs'] as const;

function tampered(message: string): never {
  throw new PracticalShadowError('SHADOW_EVIDENCE_TAMPERED', message);
}

/**
 * The durable record the runner writes for one collected evaluation: the
 * result row and one paper decision per configured intent. The store and
 * replay recompute exactly this and compare.
 */
export function buildPracticalShadowCompletion(
  collected: PracticalShadowEvidence,
  intents: readonly PracticalPaperIntent[],
): { readonly classification: PracticalShadowClassification; readonly result: PracticalShadowEvaluationResult; readonly paperDecisions: readonly PracticalShadowPaperDecisionRecord[] } {
  // Only the CLOSED-schema, rebuilt record is classified, digested, and persisted.
  const evidence = parsePracticalShadowEvidence(collected);
  const classification = classifyPracticalShadowEvaluation(evidence, intents);
  const result: PracticalShadowEvaluationResult = Object.freeze({
    startedAtMs: evidence.startedAtMs,
    endedAtMs: evidence.endedAtMs,
    reconciliationGeneration: evidence.reconciliation[0]?.currentGeneration ?? null,
    streamIncarnation: evidence.readiness.atStart.incarnation,
    streamReadiness: evidence.readiness.atStart.readiness,
    restStability: classification.rest.result,
    restFailure: classification.rest.failure,
    authorityEligible: classification.authority.authorityEligible,
    primaryBlocker: classification.authority.primaryBlocker,
    blockers: classification.authority.blockers,
    evidenceSchemaVersion: evidence.schemaVersion,
    evidenceDigest: practicalShadowEvidenceDigest(evidence),
    evidenceJson: JSON.stringify(evidence),
  });
  const paperDecisions = classification.paperDecisions.map((decision) => Object.freeze({
    paperDecisionId: decision.paperDecisionId,
    evaluationId: evidence.evaluationId,
    campaignId: evidence.campaignId,
    requestedAction: decision.requestedAction,
    rolloutStage: decision.rolloutStage,
    restStability: decision.restStability,
    streamReadiness: decision.streamReadiness,
    authorityPrerequisitesMet: decision.authorityPrerequisitesMet,
    outcome: decision.outcome,
    blockers: decision.blockers,
    policyVersion: decision.policyVersion,
    createdAtMs: decision.createdAtMs,
  }));
  return Object.freeze({ classification, result, paperDecisions: Object.freeze(paperDecisions) });
}

/**
 * Parses stored evidence strictly and binds it to EXACTLY this campaign and
 * evaluation. Throws SHADOW_EVIDENCE_INSUFFICIENT (unparsable/missing data)
 * or SHADOW_EVIDENCE_TAMPERED (digest or identity disagreement).
 */
export function verifyPracticalShadowEvidenceBinding(input: {
  readonly campaign: PracticalShadowCampaignView;
  readonly evaluation: PracticalShadowClaimedEvaluationView;
  readonly protocol: PracticalShadowProtocolView;
  readonly evidenceJson: string;
  readonly evidenceDigest: string;
  readonly evidenceSchemaVersion: string;
}): PracticalShadowEvidence {
  let raw: unknown;
  try {
    raw = JSON.parse(input.evidenceJson);
  } catch {
    throw new PracticalShadowError('SHADOW_EVIDENCE_INSUFFICIENT', `Evaluation ${input.evaluation.evaluationId} evidence is not JSON`);
  }
  const evidence = parsePracticalShadowEvidence(raw);
  if (practicalShadowEvidenceDigest(evidence) !== input.evidenceDigest) tampered(`Evaluation ${input.evaluation.evaluationId} evidence does not match its stored digest`);
  const identity: readonly [string, unknown, unknown][] = [
    ['evaluationId', evidence.evaluationId, input.evaluation.evaluationId],
    ['campaignId', evidence.campaignId, input.campaign.campaignId],
    ['evaluation.campaignId', input.evaluation.campaignId, input.campaign.campaignId],
    ['runtimeEpoch', evidence.runtimeEpoch, input.evaluation.runtimeEpoch],
    ['accountId', evidence.accountId, input.campaign.accountId],
    ['expectedProviderAccountFingerprint', evidence.expectedProviderAccountFingerprint, input.campaign.providerAccountFingerprint],
    ['schemaVersion', evidence.schemaVersion, input.campaign.evidenceSchemaVersion],
    ['evidenceSchemaVersion', input.evidenceSchemaVersion, input.campaign.evidenceSchemaVersion],
  ];
  const wrong = identity.filter(([, actual, expected]) => actual !== expected).map(([field]) => field);
  if (wrong.length > 0) tampered(`Evaluation ${input.evaluation.evaluationId} evidence is not bound to this campaign/evaluation (${wrong.join(', ')})`);
  // Exactly ONE configured protocol per campaign: no weakened (or strengthened) window or timing value.
  const protocol = [
    ...WINDOW_FIELDS.filter((field) => evidence.window[field] !== input.protocol.window[field]).map((field) => `window.${field}`),
    ...TIMING_FIELDS.filter((field) => evidence.timing[field] !== input.protocol.timing[field]).map((field) => `timing.${field}`),
  ];
  if (protocol.length > 0) tampered(`Evaluation ${input.evaluation.evaluationId} evidence was not collected under the campaign's configured protocol (${protocol.join(', ')})`);
  return evidence;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/** Top-level result fields that disagree with the recomputed record (in a stable order). */
export function practicalShadowResultMismatches(expected: PracticalShadowEvaluationResult, stored: PracticalShadowEvaluationResult): readonly string[] {
  const mismatches: string[] = [];
  for (const field of ['restStability', 'restFailure', 'authorityEligible', 'primaryBlocker'] as const) if (expected[field] !== stored[field]) mismatches.push(field);
  if (!sameList(expected.blockers, stored.blockers)) mismatches.push('blockers');
  for (const field of ['streamReadiness', 'startedAtMs', 'endedAtMs', 'reconciliationGeneration', 'streamIncarnation', 'evidenceSchemaVersion', 'evidenceDigest'] as const) {
    if (expected[field] !== stored[field]) mismatches.push(field);
  }
  return Object.freeze(mismatches);
}

const PAPER_FIELDS = [
  'evaluationId', 'campaignId', 'requestedAction', 'rolloutStage', 'restStability', 'streamReadiness', 'authorityPrerequisitesMet', 'outcome', 'policyVersion', 'createdAtMs',
] as const;

/** Paper decisions that are missing, extra, duplicated, or altered relative to the recomputed ones. */
export function practicalShadowPaperDecisionMismatches(
  expected: readonly PracticalShadowPaperDecisionRecord[],
  stored: readonly PracticalShadowPaperDecisionRecord[],
): readonly string[] {
  const mismatches: string[] = [];
  const ids = new Set<string>();
  const intents = new Set<string>();
  for (const decision of stored) {
    const intent = `${decision.requestedAction}@${decision.rolloutStage}`;
    if (ids.has(decision.paperDecisionId) || intents.has(intent)) mismatches.push(`paperDecision:${intent}:duplicate`);
    ids.add(decision.paperDecisionId);
    intents.add(intent);
  }
  for (const decision of expected) {
    const label = `paperDecision:${decision.requestedAction}@${decision.rolloutStage}`;
    const match = stored.find((entry) => entry.paperDecisionId === decision.paperDecisionId);
    if (match === undefined) {
      mismatches.push(`${label}:missing`);
      continue;
    }
    const altered: string[] = PAPER_FIELDS.filter((field) => match[field] !== decision[field]);
    if (!sameList(match.blockers, decision.blockers)) altered.push('blockers');
    for (const field of altered) mismatches.push(`${label}:${field}`);
  }
  const expectedIds = new Set(expected.map((decision) => decision.paperDecisionId));
  for (const decision of stored) {
    if (!expectedIds.has(decision.paperDecisionId)) mismatches.push(`paperDecision:${decision.requestedAction}@${decision.rolloutStage}:unexpected`);
  }
  return Object.freeze(mismatches);
}

/**
 * The store's gate BEFORE durable completion: the campaign's configuration
 * must match its bound digest, the evidence must be bound to exactly this
 * campaign/evaluation, and the result and paper decisions must be exactly
 * the recomputed ones. Any disagreement throws SHADOW_EVIDENCE_TAMPERED (the
 * caller's transaction then rolls back: nothing is recorded).
 */
export function verifyPracticalShadowCompletion(input: {
  readonly campaign: PracticalShadowCampaignRecord;
  /** The LOCKED claimed evaluation row. */
  readonly evaluation: PracticalShadowClaimedEvaluationView;
  readonly result: PracticalShadowEvaluationResult;
  readonly paperDecisions: readonly PracticalShadowPaperDecisionRecord[];
}): { readonly result: PracticalShadowEvaluationResult; readonly paperDecisions: readonly PracticalShadowPaperDecisionRecord[] } {
  const config = parsePracticalShadowConfigSnapshot(input.campaign.configJson, input.campaign.configDigest);
  if (config.evidenceSchemaVersion !== input.campaign.evidenceSchemaVersion) tampered('The campaign configuration names another evidence schema than its binding');
  const evidence = verifyPracticalShadowEvidenceBinding({
    campaign: input.campaign,
    evaluation: input.evaluation,
    protocol: config,
    evidenceJson: input.result.evidenceJson,
    evidenceDigest: input.result.evidenceDigest,
    evidenceSchemaVersion: input.result.evidenceSchemaVersion,
  });
  const expected = buildPracticalShadowCompletion(evidence, config.paperIntents);
  const mismatches = [
    ...practicalShadowResultMismatches(expected.result, input.result),
    ...practicalShadowPaperDecisionMismatches(expected.paperDecisions, input.paperDecisions),
  ];
  if (mismatches.length > 0) tampered(`Evaluation ${input.evaluation.evaluationId} record disagrees with its evidence (${mismatches.join(', ')})`);
  // What is persisted: the recomputed record, whose evidence JSON is the canonical rebuilt record (never the caller's raw string).
  return Object.freeze({ result: expected.result, paperDecisions: expected.paperDecisions });
}
