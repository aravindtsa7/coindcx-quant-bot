/**
 * Phase 18B Checkpoint C: deterministic OFFLINE replay of stored shadow
 * metadata. No network, no credentials, no provider call, no mutation API:
 * input is a consistent store snapshot, output is data.
 *
 * Before ANY stored value is used, the campaign's configuration snapshot is
 * read through the one strict parser: its canonical digest must equal the
 * campaign's bound configDigest (SHADOW_EVIDENCE_TAMPERED otherwise), and its
 * config schema, evidence schema, analysis, paper-policy, and review-criteria
 * versions must be supported; the PERSISTED analysis version must equal the
 * analysis version replaying it (no silent reinterpretation).
 *
 * For every COMPLETED evaluation up to the snapshot cutoff it:
 *   1. parses the stored evidence strictly (missing data is an explicit
 *      SHADOW_EVIDENCE_INSUFFICIENT failure; nothing is invented), checks its
 *      digest, and requires it to name EXACTLY this campaign's account,
 *      provider fingerprint, campaign, evaluation, and evidence schema
 *      (`./integrity.ts`; otherwise SHADOW_EVIDENCE_TAMPERED -- foreign
 *      evidence never enters this campaign's analysis);
 *   2. recomputes the result and every paper decision and reports each
 *      disagreement (missing, extra, duplicated, altered) as a mismatch;
 *   3. recomputes the calibration summary from the recomputed values.
 * The same dataset and analysis version always give the same result.
 */
import { analysePracticalShadowCampaign, type PracticalShadowCalibrationReport } from './analysis';
import { parsePracticalShadowConfigSnapshot } from './config';
import {
  buildPracticalShadowCompletion,
  practicalShadowPaperDecisionMismatches,
  practicalShadowResultMismatches,
  verifyPracticalShadowEvidenceBinding,
} from './integrity';
import type { PracticalShadowCampaignSnapshot } from './ports';
import {
  PRACTICAL_PAPER_SUPPORTED_POLICY_VERSIONS,
  PRACTICAL_SHADOW_ANALYSIS_VERSION,
  PRACTICAL_SHADOW_SUPPORTED_ANALYSIS_VERSIONS,
  PRACTICAL_SHADOW_SUPPORTED_EVIDENCE_SCHEMA_VERSIONS,
  PracticalShadowError,
} from './types';

export interface PracticalShadowReplayMismatch {
  readonly evaluationId: string;
  readonly field: string;
}

export interface PracticalShadowReplayResult {
  readonly analysisVersion: string;
  readonly campaignId: string;
  /** The persisted software provenance of the campaign (the clean commit it was bound to). */
  readonly provenance: PracticalShadowCalibrationReport['provenance'];
  readonly cutoffSequence: number;
  readonly evaluationsReplayed: number;
  readonly paperDecisionsReplayed: number;
  readonly mismatches: readonly PracticalShadowReplayMismatch[];
  readonly consistent: boolean;
  readonly report: PracticalShadowCalibrationReport;
  readonly grantsAuthority: false;
}

function unsupported(what: string, value: unknown): never {
  throw new PracticalShadowError('SHADOW_UNSUPPORTED_VERSION', `Unsupported ${what} ${JSON.stringify(value)}; it is refused, never reinterpreted`);
}

/** Replays a consistent snapshot. Throws on an unsupported version or insufficient/tampered evidence. */
export function replayPracticalShadowSnapshot(
  snapshot: PracticalShadowCampaignSnapshot,
  options: { readonly analysisVersion?: string } = {},
): PracticalShadowReplayResult {
  const analysisVersion = options.analysisVersion ?? PRACTICAL_SHADOW_ANALYSIS_VERSION;
  if (!PRACTICAL_SHADOW_SUPPORTED_ANALYSIS_VERSIONS.includes(analysisVersion)) unsupported('analysis version', analysisVersion);
  const campaign = snapshot.campaign;
  if (!PRACTICAL_SHADOW_SUPPORTED_EVIDENCE_SCHEMA_VERSIONS.includes(campaign.evidenceSchemaVersion)) unsupported('evidence schema version', campaign.evidenceSchemaVersion);
  // The ONE strict reader: digest-bound to the campaign binding before any value is used.
  const config = parsePracticalShadowConfigSnapshot(campaign.configJson, campaign.configDigest);
  if (config.analysisVersion !== analysisVersion) unsupported('persisted analysis version (replayed by another analysis version)', config.analysisVersion);
  if (config.evidenceSchemaVersion !== campaign.evidenceSchemaVersion) {
    throw new PracticalShadowError('SHADOW_EVIDENCE_TAMPERED', 'The campaign configuration names another evidence schema than its binding');
  }
  for (const decision of snapshot.paperDecisions) {
    if (!PRACTICAL_PAPER_SUPPORTED_POLICY_VERSIONS.includes(decision.policyVersion)) unsupported('paper policy version', decision.policyVersion);
  }

  const mismatches: PracticalShadowReplayMismatch[] = [];
  const mismatch = (evaluationId: string, field: string): void => {
    mismatches.push(Object.freeze({ evaluationId, field }));
  };
  const completed = [];
  let paperDecisionsReplayed = 0;
  const evaluations = [...snapshot.evaluations].sort((a, b) => a.sequence - b.sequence);
  for (const row of evaluations) {
    if (row.status !== 'COMPLETED') continue;
    const stored = row.result;
    if (stored === null) throw new PracticalShadowError('SHADOW_EVIDENCE_INSUFFICIENT', `Completed evaluation ${row.evaluationId} has no stored result`);
    if (!PRACTICAL_SHADOW_SUPPORTED_EVIDENCE_SCHEMA_VERSIONS.includes(stored.evidenceSchemaVersion)) unsupported('evidence schema version', stored.evidenceSchemaVersion);
    const evidence = verifyPracticalShadowEvidenceBinding({
      campaign,
      // Bound to the stored claimed row (id, campaign, runtime epoch) and to the digest-validated configured protocol.
      evaluation: row,
      protocol: config,
      evidenceJson: stored.evidenceJson,
      evidenceDigest: stored.evidenceDigest,
      evidenceSchemaVersion: stored.evidenceSchemaVersion,
    });
    if (row.campaignId !== campaign.campaignId) {
      throw new PracticalShadowError('SHADOW_EVIDENCE_TAMPERED', `Evaluation ${row.evaluationId} belongs to another campaign`);
    }
    const expected = buildPracticalShadowCompletion(evidence, config.paperIntents);
    const classification = expected.classification;
    for (const field of practicalShadowResultMismatches(expected.result, stored)) mismatch(row.evaluationId, field);
    const storedDecisions = snapshot.paperDecisions.filter((decision) => decision.evaluationId === row.evaluationId);
    paperDecisionsReplayed += expected.paperDecisions.length;
    for (const field of practicalShadowPaperDecisionMismatches(expected.paperDecisions, storedDecisions)) mismatch(row.evaluationId, field);

    completed.push(Object.freeze({
      sequence: row.sequence,
      evidence,
      restStability: classification.rest.result,
      restFailure: classification.rest.failure,
      authorityEligible: classification.authority.authorityEligible,
      blockers: classification.authority.blockers,
      primaryBlocker: classification.authority.primaryBlocker,
    }));
  }

  // A paper decision must belong to a completed evaluation of this snapshot.
  const completedIds = new Set(evaluations.filter((row) => row.status === 'COMPLETED').map((row) => row.evaluationId));
  for (const decision of snapshot.paperDecisions) {
    if (!completedIds.has(decision.evaluationId) || decision.campaignId !== campaign.campaignId) mismatch(decision.evaluationId, `paperDecision:${decision.paperDecisionId}:orphan`);
  }

  const report = analysePracticalShadowCampaign({
    campaign: {
      campaignId: campaign.campaignId,
      status: campaign.status,
      startedAtMs: campaign.startedAtMs,
      sourceProvenance: campaign.sourceProvenance,
      softwareVersion: campaign.softwareVersion,
      cadenceMs: config.cadenceMs,
      calibrationReview: config.calibrationReview,
    },
    completed,
    abortedEvaluations: evaluations.filter((row) => row.status === 'ABORTED').length,
    inProgressEvaluations: evaluations.filter((row) => row.status === 'CLAIMED').length,
    cutoffSequence: snapshot.cutoffSequence,
  });
  return Object.freeze({
    analysisVersion,
    campaignId: campaign.campaignId,
    provenance: report.provenance,
    cutoffSequence: snapshot.cutoffSequence,
    evaluationsReplayed: completed.length,
    paperDecisionsReplayed,
    mismatches: Object.freeze(mismatches),
    consistent: mismatches.length === 0,
    report,
    grantsAuthority: false as const,
  });
}
