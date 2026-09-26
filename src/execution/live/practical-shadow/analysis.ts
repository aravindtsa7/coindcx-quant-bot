/**
 * Phase 18B Checkpoint C: deterministic calibration analysis over stored,
 * SAFE shadow evidence (pure; no network, no credentials, no provider call).
 *
 * Every figure is an integer (milliseconds, counts, permille), percentiles
 * use the nearest-rank method, and the input order is normalized, so the same
 * dataset and analysis version always give the same report.
 *
 * NO AUTOMATIC THRESHOLD TUNING. The report may contain
 * CALIBRATION_RECOMMENDATION entries (measured percentiles next to the
 * current candidate). They are data for a HUMAN review in a later reviewed
 * checkpoint: nothing here writes, returns, or applies a threshold, and no
 * recommendation is a provider guarantee or a safe threshold.
 * `eligibleForHumanCalibrationReview` only says the PROVISIONAL_HUMAN_REVIEW_CRITERIA
 * (duration/sample/coverage) are met AND the campaign names a trusted clean
 * source commit; the criteria are not authority requirements, CoinDCX
 * guarantees, or calibrated safety thresholds, and meeting them grants no
 * authority.
 */
import type { PracticalShadowCalibrationReviewRules } from './config';
import { isTrustedPracticalShadowProvenance } from './provenance';
import { practicalShadowPasses } from './classification';
import type { PracticalShadowEvidence } from './evidence';
import { PRACTICAL_SHADOW_ANALYSIS_VERSION } from './types';

export interface PracticalShadowDistribution {
  readonly count: number;
  readonly min: number | null;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

export interface PracticalShadowRate {
  readonly count: number;
  readonly total: number;
  /** floor(count * 1000 / total); null when total is 0. */
  readonly permille: number | null;
}

/** One completed evaluation as analysed: its evidence and its STORED classification. */
export interface PracticalShadowAnalysedEvaluation {
  readonly sequence: number;
  readonly evidence: PracticalShadowEvidence;
  readonly restStability: 'PASS' | 'FAIL';
  readonly restFailure: string | null;
  readonly authorityEligible: boolean;
  readonly blockers: readonly string[];
  readonly primaryBlocker: string | null;
}

export interface PracticalShadowAnalysisInput {
  readonly campaign: {
    readonly campaignId: string;
    readonly status: string;
    readonly startedAtMs: number;
    /** The persisted software provenance (binding). */
    readonly sourceProvenance: string;
    readonly softwareVersion: string;
    readonly cadenceMs: number;
    readonly calibrationReview: PracticalShadowCalibrationReviewRules;
  };
  readonly completed: readonly PracticalShadowAnalysedEvaluation[];
  readonly abortedEvaluations: number;
  readonly inProgressEvaluations: number;
  /** The snapshot cutoff: evaluations with a sequence above this were not visible to this report. */
  readonly cutoffSequence: number;
}

export interface PracticalShadowCalibrationRecommendation {
  readonly status: 'CALIBRATION_RECOMMENDATION';
  readonly parameter: 'READ_DURATION' | 'PASS_WINDOW' | 'INTER_READ_GAP';
  readonly currentCandidateMs: number;
  readonly measured: PracticalShadowDistribution;
  readonly providerGuarantee: false;
  readonly appliesAutomatically: false;
  readonly requiresHumanReview: true;
}

/** Minimum samples before a recommendation candidate is reported at all. */
export const PRACTICAL_SHADOW_RECOMMENDATION_MIN_SAMPLES = 30;

function distribution(values: readonly number[]): PracticalShadowDistribution {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (quantilePermille: number): number | null => {
    if (sorted.length === 0) return null;
    const index = Math.ceil((quantilePermille * sorted.length) / 1_000) - 1;
    return sorted[Math.min(sorted.length - 1, Math.max(0, index))]!;
  };
  return Object.freeze({
    count: sorted.length,
    min: sorted[0] ?? null,
    p50: rank(500),
    p90: rank(900),
    p95: rank(950),
    p99: rank(990),
    max: sorted.at(-1) ?? null,
  });
}

function rate(count: number, total: number): PracticalShadowRate {
  return Object.freeze({ count, total, permille: total === 0 ? null : Math.floor((count * 1_000) / total) });
}

function increment(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

function sortedCounts(counts: Record<string, number>): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(Object.keys(counts).sort().map((key) => [key, counts[key]!])));
}

export function analysePracticalShadowCampaign(input: PracticalShadowAnalysisInput) {
  const evaluations = [...input.completed].sort((a, b) => a.sequence - b.sequence);
  const latencies: number[] = [];
  const latencyByKind: Record<string, number[]> = { IDENTITY: [], ORDERS: [], POSITIONS: [] };
  const pageCounts: number[] = [];
  const readFailures: Record<string, number> = {};
  let readCount = 0;
  let readCandidateExceeded = 0;
  const passDurations: number[] = [];
  const passSkews: number[] = [];
  const interReadGaps: number[] = [];
  const passPageCounts: number[] = [];
  const passSpacings: number[] = [];
  const windowSpans: number[] = [];
  const bracketDisagreements: Record<string, number> = {};
  let passCount = 0;
  let completePasses = 0;
  let passCandidateExceeded = 0;
  let interReadGapCandidateExceeded = 0;
  let passHardCeilingExceeded = 0;
  const readinessAtStart: Record<string, number> = {};
  const readinessSamples: Record<string, number> = {};
  const eventsByReason: Record<string, number> = {};
  let incarnationChanges = 0;
  let restPass = 0;
  const restFailures: Record<string, number> = {};
  let disagreementEvaluations = 0;
  let eligible = 0;
  const blockerCounts: Record<string, number> = {};
  const primaryBlockerCounts: Record<string, number> = {};

  for (const evaluation of evaluations) {
    const { evidence } = evaluation;
    for (const read of evidence.reads) {
      readCount += 1;
      latencies.push(read.latencyMs);
      latencyByKind[read.kind]?.push(read.latencyMs);
      if (read.kind !== 'IDENTITY' && read.pagesRead !== null) pageCounts.push(read.pagesRead);
      if (read.failure !== null) increment(readFailures, read.failure);
      if (read.latencyMs > evidence.timing.readCandidateMs) readCandidateExceeded += 1;
    }
    const passes = practicalShadowPasses(evidence);
    for (const [position, pass] of passes.entries()) {
      passCount += 1;
      if (pass.complete) completePasses += 1;
      passDurations.push(pass.durationMs);
      passSkews.push(pass.observationSkewMs);
      interReadGaps.push(pass.maxInterReadGapMs);
      passPageCounts.push(pass.reads.reduce((sum, read) => sum + (read.pagesRead ?? 0), 0));
      if (pass.bracketDisagreement !== null) increment(bracketDisagreements, pass.bracketDisagreement);
      if (pass.durationMs > evidence.timing.passCandidateMs) passCandidateExceeded += 1;
      if (pass.maxInterReadGapMs > evidence.timing.interReadGapCandidateMs) interReadGapCandidateExceeded += 1;
      if (pass.durationMs > evidence.timing.hardPassDurationMs) passHardCeilingExceeded += 1;
      if (position > 0) passSpacings.push(pass.startedAtMs - passes[position - 1]!.endedAtMs);
    }
    if (passes.length > 0) windowSpans.push(passes.at(-1)!.endedAtMs - passes[0]!.startedAtMs);
    increment(readinessAtStart, evidence.readiness.atStart.readiness);
    for (const sample of [evidence.readiness.atStart, ...evidence.readiness.samples, evidence.readiness.atEnd]) increment(readinessSamples, sample.readiness);
    if ([...evidence.readiness.samples, evidence.readiness.atEnd].some((sample) => sample.incarnation !== evidence.readiness.atStart.incarnation)) incarnationChanges += 1;
    for (const [reason, count] of Object.entries(evidence.events.byReason)) increment(eventsByReason, reason, count);
    if (evaluation.restStability === 'PASS') restPass += 1;
    else increment(restFailures, evaluation.restFailure ?? 'UNKNOWN');
    if (evaluation.restFailure === 'BRACKET_DISAGREEMENT' || evaluation.restFailure === 'OBSERVATION_DISAGREEMENT') disagreementEvaluations += 1;
    if (evaluation.authorityEligible) eligible += 1;
    for (const blocker of evaluation.blockers) increment(blockerCounts, blocker);
    if (evaluation.primaryBlocker !== null) increment(primaryBlockerCounts, evaluation.primaryBlocker);
  }

  const total = evaluations.length;
  const last = evaluations.at(-1);
  const durationObservedMs = last === undefined ? 0 : Math.max(0, last.evidence.endedAtMs - input.campaign.startedAtMs);
  let maxGapBetweenEvaluationsMs = 0;
  for (let position = 1; position < evaluations.length; position += 1) {
    maxGapBetweenEvaluationsMs = Math.max(maxGapBetweenEvaluationsMs, evaluations[position]!.evidence.startedAtMs - evaluations[position - 1]!.evidence.endedAtMs);
  }
  const coveragePermille = durationObservedMs === 0 ? 0 : Math.min(1_000, Math.floor((total * input.campaign.cadenceMs * 1_000) / durationObservedMs));
  const rules = input.campaign.calibrationReview;
  const trustedSourceProvenance = isTrustedPracticalShadowProvenance(input.campaign.sourceProvenance, input.campaign.softwareVersion);
  // A dataset without a trusted CLEAN source commit is never review-eligible, whatever its duration or size.
  const eligibleForHumanCalibrationReview = trustedSourceProvenance
    && durationObservedMs >= rules.minimumDurationMs
    && total >= rules.minimumCompletedEvaluations
    && coveragePermille >= rules.minimumCoveragePermille;

  const candidate = evaluations[0]?.evidence.timing;
  const recommendation = (parameter: PracticalShadowCalibrationRecommendation['parameter'], currentCandidateMs: number, values: readonly number[]): PracticalShadowCalibrationRecommendation => Object.freeze({
    status: 'CALIBRATION_RECOMMENDATION' as const,
    parameter,
    currentCandidateMs,
    measured: distribution(values),
    providerGuarantee: false as const,
    appliesAutomatically: false as const,
    requiresHumanReview: true as const,
  });
  const recommendations = candidate === undefined || latencies.length < PRACTICAL_SHADOW_RECOMMENDATION_MIN_SAMPLES
    ? []
    : [
      recommendation('READ_DURATION', candidate.readCandidateMs, latencies),
      recommendation('PASS_WINDOW', candidate.passCandidateMs, passDurations),
      recommendation('INTER_READ_GAP', candidate.interReadGapCandidateMs, interReadGaps),
    ];

  return Object.freeze({
    analysisVersion: PRACTICAL_SHADOW_ANALYSIS_VERSION,
    campaignId: input.campaign.campaignId,
    campaignStatus: input.campaign.status,
    cutoffSequence: input.cutoffSequence,
    grantsAuthority: false as const,
    provenance: Object.freeze({
      sourceProvenance: input.campaign.sourceProvenance,
      softwareVersion: input.campaign.softwareVersion,
      trustedCleanCommit: trustedSourceProvenance,
    }),
    notice: 'Shadow evidence and paper decisions are NOT authority. Recommendations are CALIBRATION_RECOMMENDATION data for human review only; nothing is applied automatically.',
    evaluations: Object.freeze({ completed: total, aborted: input.abortedEvaluations, inProgress: input.inProgressEvaluations }),
    coverage: Object.freeze({
      durationObservedMs,
      sampleCount: total,
      coveragePermille,
      maxGapBetweenEvaluationsMs,
      rules,
      criteriaNotice: 'PROVISIONAL_HUMAN_REVIEW_CRITERIA: not authority requirements, not CoinDCX guarantees, not calibrated safety thresholds.',
      eligibleForHumanCalibrationReview,
    }),
    reads: Object.freeze({
      latencyMs: distribution(latencies),
      latencyMsByKind: Object.freeze({
        IDENTITY: distribution(latencyByKind['IDENTITY']!),
        ORDERS: distribution(latencyByKind['ORDERS']!),
        POSITIONS: distribution(latencyByKind['POSITIONS']!),
      }),
      pageCount: distribution(pageCounts),
      failures: sortedCounts(readFailures),
      readCandidateExceeded: rate(readCandidateExceeded, readCount),
      hardTimeout: rate(readFailures['READ_HARD_TIMEOUT'] ?? 0, readCount),
      providerUnavailable: rate(readFailures['PROVIDER_UNAVAILABLE'] ?? 0, readCount),
      incompletePagination: rate(readFailures['PAGINATION_INCOMPLETE'] ?? 0, readCount),
    }),
    passes: Object.freeze({
      durationMs: distribution(passDurations),
      skewMs: distribution(passSkews),
      maxInterReadGapMs: distribution(interReadGaps),
      pageCount: distribution(passPageCounts),
      interPassSpacingMs: distribution(passSpacings),
      windowSpanMs: distribution(windowSpans),
      bracketPass: rate(completePasses, passCount),
      bracketDisagreements: sortedCounts(bracketDisagreements),
      passCandidateExceeded: rate(passCandidateExceeded, passCount),
      interReadGapCandidateExceeded: rate(interReadGapCandidateExceeded, passCount),
      hardCeilingExceeded: rate(passHardCeilingExceeded, passCount),
    }),
    stream: Object.freeze({
      readinessAtStart: sortedCounts(readinessAtStart),
      readinessSamples: sortedCounts(readinessSamples),
      eventsByReason: sortedCounts(eventsByReason),
      disconnects: (eventsByReason['WS_DISCONNECTED'] ?? 0) + (eventsByReason['WS_PING_TIMEOUT'] ?? 0),
      reconciliationRequired: eventsByReason['WS_RECONNECTED'] ?? 0,
      stateChangeEvents: eventsByReason['PRIVATE_STATE_EVENT'] ?? 0,
      evaluationsWithIncarnationChange: incarnationChanges,
    }),
    evidence: Object.freeze({
      restStabilityPass: rate(restPass, total),
      restFailures: sortedCounts(restFailures),
      disagreement: rate(disagreementEvaluations, total),
    }),
    authority: Object.freeze({
      authorityEligible: rate(eligible, total),
      blockers: sortedCounts(blockerCounts),
      primaryBlockers: sortedCounts(primaryBlockerCounts),
    }),
    recommendations: Object.freeze(recommendations),
  });
}

export type PracticalShadowCalibrationReport = ReturnType<typeof analysePracticalShadowCampaign>;
