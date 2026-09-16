import { RankingError } from './errors';
import {
  computeRankingResultSha256, computeRankingRunId, computeRankingRunSetSha256, computeRankingRunSha256,
  type RankingUniverseEntry, type UnhashedRankingResult,
} from './identity';
import { buildComponentScore, normalizeComponent, type ComponentValueInput, type NormalizedComponentValue } from './normalize';
import { rankCalc, rankCompareDecimals } from './numeric';
import { P15_COMPONENT_IDS, P15_ECONOMIC_LIMITATION, P15_RANKING_POLICY_ID } from './policy';
import { computeCompositeScore } from './score';
import { orderRankingCandidates, resolveTieBreakLevel, type RankingOrderingCandidate } from './tie-break';
import {
  RANKING_SCHEMA_VERSION,
  type AuthoritativeStrategyRankingResult,
  type InsufficientEvidenceStrategyRankingResult,
  type NotEligibleStrategyRankingResult,
  type RankedStrategyRankingResult,
  type RankingCandidateEvidence,
  type RankingComponentId,
  type RankingComponentScore,
  type StrategyRankingRun,
  type StrategyRankingRunSet,
} from './types';

/**
 * The pure Phase15 ranking core: normalization -> composite scoring ->
 * tie-breaking -> identity -> immutable result assembly.
 *
 * This module is deliberately free of every authority concern. It takes
 * already-authorized `RankingCandidateEvidence` and produces immutable ordinal
 * evidence. It is NOT part of the Phase15 public barrel, so a caller cannot
 * reach it with fabricated metrics through the package's public surface; the
 * only production producer of `RankingCandidateEvidence` is the Phase12-bound
 * adapter in `evidence.ts`. Lower-level tests import it by concrete module
 * path, matching the repository's existing internal-module convention.
 *
 * It contains no clock read, no I/O, no randomness, no concurrency, and no
 * dependency on Phase13 risk, Phase14 execution, or the CoinDCX integration
 * surface.
 */

export function deepFreezeRanking<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreezeRanking(entry, seen);
  return Object.freeze(value);
}

/**
 * The single promotion firewall every Phase15 result passes through. There is
 * no branch anywhere in Phase15 that can emit `PAPER_APPROVED`, `SHADOW`,
 * `LIVE_CANDIDATE` or `LIVE`, and none that can emit
 * `promotionEligible: true`.
 */
export function rankingEconomicFields(): {
  readonly economicStatus: 'FUNDING_EXCLUDED';
  readonly promotionEligible: false;
  readonly maxLifecycle: 'PAPER';
} {
  if (
    P15_ECONOMIC_LIMITATION.economicStatus !== 'FUNDING_EXCLUDED'
    || P15_ECONOMIC_LIMITATION.promotionEligible !== false
    || P15_ECONOMIC_LIMITATION.maxLifecycle !== 'PAPER'
    || P15_ECONOMIC_LIMITATION.fundingApplied !== false
  ) {
    throw new RankingError('RANKING_ECONOMIC_LIMIT_VIOLATION', 'Phase15 economic limitation was weakened');
  }
  return {
    economicStatus: P15_ECONOMIC_LIMITATION.economicStatus,
    promotionEligible: P15_ECONOMIC_LIMITATION.promotionEligible,
    maxLifecycle: P15_ECONOMIC_LIMITATION.maxLifecycle,
  };
}

export function rankingAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface RankableCandidate {
  readonly evidence: RankingCandidateEvidence;
  readonly metricValues: Readonly<Record<RankingComponentId, string>>;
}

interface PairPartition {
  readonly rankable: readonly RankableCandidate[];
  readonly insufficient: readonly RankingCandidateEvidence[];
  readonly universe: readonly RankingUniverseEntry[];
}

/**
 * Fail-closed metric validity. A component that is absent, `UNDEFINED`,
 * `INSUFFICIENT_DATA`, non-canonical or identity-invalid is never coerced to
 * zero and never silently re-weighted: the candidate leaves the ranked
 * universe entirely and is reported as `INSUFFICIENT_RANKING_EVIDENCE`.
 */
function partitionPair(evidences: readonly RankingCandidateEvidence[]): PairPartition {
  const rankable: RankableCandidate[] = [];
  const insufficient: RankingCandidateEvidence[] = [];
  const universe: RankingUniverseEntry[] = [];
  for (const evidence of evidences) {
    const values: Partial<Record<RankingComponentId, string>> = {};
    let complete = true;
    for (const componentId of P15_COMPONENT_IDS) {
      const metric = evidence.metrics[componentId];
      if (metric === undefined || metric.status !== 'VALUE') {
        complete = false;
        continue;
      }
      values[componentId] = metric.value;
    }
    universe.push({ evidence, rankable: complete });
    if (complete) rankable.push({ evidence, metricValues: values as Readonly<Record<RankingComponentId, string>> });
    else insufficient.push(evidence);
  }
  return { rankable, insufficient, universe };
}

function unavailableComponents(evidence: RankingCandidateEvidence): InsufficientEvidenceStrategyRankingResult['unavailableComponents'] {
  const rows: {
    readonly componentId: RankingComponentId;
    readonly reason: 'METRIC_ABSENT' | 'METRIC_NOT_VALUE' | 'METRIC_NON_CANONICAL' | 'GATE_UNAVAILABLE';
    readonly detail: string;
  }[] = [];
  for (const componentId of P15_COMPONENT_IDS) {
    const metric = evidence.metrics[componentId];
    if (metric === undefined) {
      rows.push({ componentId, reason: 'METRIC_ABSENT', detail: componentId });
      continue;
    }
    if (metric.status !== 'VALUE') rows.push({ componentId, reason: metric.reason, detail: metric.detail });
  }
  return rows;
}

function identityFields(evidence: RankingCandidateEvidence, rankingRunId: string) {
  const { identity } = evidence;
  return {
    schemaVersion: RANKING_SCHEMA_VERSION,
    rankingPolicyVersion: 'P15_RANKING_V1' as const,
    rankingPolicyId: P15_RANKING_POLICY_ID,
    rankingRunId,
    pair: identity.pair,
    strategyId: identity.strategyId,
    strategyVersion: identity.strategyVersion,
    parameterHash: identity.parameterHash,
    validationSubjectId: identity.validationSubjectId,
    validationPlanId: identity.validationPlanId,
    validationSubjectResultSha256: identity.validationSubjectResultSha256,
    ...rankingEconomicFields(),
  };
}

function sealResult(unhashed: UnhashedRankingResult): AuthoritativeStrategyRankingResult {
  const rankingResultSha256 = computeRankingResultSha256(unhashed);
  return deepFreezeRanking({ ...unhashed, rankingResultSha256 } as AuthoritativeStrategyRankingResult);
}

/** Builds one pair-local leaderboard. BTC evidence never enters an ETH run. */
export function buildPairRankingRun(
  pair: string,
  validationPlanId: string,
  evidences: readonly RankingCandidateEvidence[],
): StrategyRankingRun {
  const { rankable, insufficient, universe } = partitionPair(evidences);
  const rankingRunId = computeRankingRunId({ pair, validationPlanId, universe });

  // ---- Ordinal normalization, pair-local, over the rankable set only -------
  const normalized = new Map<RankingComponentId, ReadonlyMap<string, NormalizedComponentValue>>();
  for (const componentId of P15_COMPONENT_IDS) {
    if (rankable.length === 0) break;
    const inputs: ComponentValueInput[] = rankable.map((candidate) => ({
      validationSubjectId: candidate.evidence.identity.validationSubjectId,
      value: candidate.metricValues[componentId],
    }));
    normalized.set(componentId, normalizeComponent(componentId, inputs));
  }

  // ---- Composite scoring ---------------------------------------------------
  const scored = new Map<string, { readonly componentScores: readonly RankingComponentScore[]; readonly compositeScore: string }>();
  const evidenceBySubjectId = new Map<string, RankingCandidateEvidence>();
  const ordering: RankingOrderingCandidate[] = [];
  for (const candidate of rankable) {
    const subjectId = candidate.evidence.identity.validationSubjectId;
    evidenceBySubjectId.set(subjectId, candidate.evidence);
    const componentScores: RankingComponentScore[] = [];
    for (const componentId of P15_COMPONENT_IDS) {
      const value = normalized.get(componentId)?.get(subjectId);
      if (value === undefined) {
        throw new RankingError('RANKING_NUMERIC_FAILURE', `Normalization is missing component ${componentId} for ${subjectId}`);
      }
      componentScores.push(buildComponentScore(componentId, candidate.metricValues[componentId], value));
    }
    const compositeScore = computeCompositeScore(componentScores);
    scored.set(subjectId, { componentScores: Object.freeze(componentScores), compositeScore });
    ordering.push({ validationSubjectId: subjectId, compositeScore, metricValues: candidate.metricValues });
  }

  // ---- Deterministic total ordering + tie attribution ----------------------
  const ordered = orderRankingCandidates(ordering);
  const tieGroupSize = new Map<string, number>();
  const groupLead = new Map<string, boolean>();
  let groupStart = 0;
  for (let index = 0; index <= ordered.length; index += 1) {
    const current = ordered[index];
    const first = ordered[groupStart];
    if (
      current !== undefined && first !== undefined
      && rankCompareDecimals(rankCalc(first.compositeScore), rankCalc(current.compositeScore)) === 0
    ) continue;
    for (let member = groupStart; member < index; member += 1) {
      const entry = ordered[member];
      if (entry === undefined) continue;
      tieGroupSize.set(entry.validationSubjectId, index - groupStart);
      groupLead.set(entry.validationSubjectId, member === groupStart);
    }
    groupStart = index;
  }

  const rankedResults: RankedStrategyRankingResult[] = ordered.map((candidate, index) => {
    const subjectId = candidate.validationSubjectId;
    const evidence = evidenceBySubjectId.get(subjectId);
    const computed = scored.get(subjectId);
    if (evidence === undefined || computed === undefined) {
      throw new RankingError('RANKING_NUMERIC_FAILURE', `Ranking lost candidate ${subjectId}`);
    }
    const previous = index === 0 ? undefined : ordered[index - 1];
    const isLead = groupLead.get(subjectId) === true;
    const tieBreakLevelApplied = isLead || previous === undefined ? null : resolveTieBreakLevel(previous, candidate);
    return sealResult({
      ...identityFields(evidence, rankingRunId),
      status: 'RANKED' as const,
      reasonCodes: ['RANKED', 'FUNDING_EXCLUDED', 'PROMOTION_BLOCKED_FUNDING_EXCLUDED'] as const,
      componentScores: computed.componentScores,
      compositeScore: computed.compositeScore,
      rank: index + 1,
      candidateCount: ordered.length,
      compositeTieGroupSize: tieGroupSize.get(subjectId) ?? 1,
      tieBreakLevelApplied,
    }) as RankedStrategyRankingResult;
  });

  const insufficientResults: InsufficientEvidenceStrategyRankingResult[] = [...insufficient]
    .sort((left, right) => rankingAscii(left.identity.validationSubjectId, right.identity.validationSubjectId))
    .map((evidence) => sealResult({
      ...identityFields(evidence, rankingRunId),
      status: 'INSUFFICIENT_RANKING_EVIDENCE' as const,
      reasonCodes: ['REQUIRED_METRIC_UNAVAILABLE', 'FUNDING_EXCLUDED', 'PROMOTION_BLOCKED_FUNDING_EXCLUDED'] as const,
      unavailableComponents: unavailableComponents(evidence),
    }) as InsufficientEvidenceStrategyRankingResult);

  const unhashedRun = {
    schemaVersion: RANKING_SCHEMA_VERSION,
    rankingPolicyVersion: 'P15_RANKING_V1' as const,
    rankingPolicyId: P15_RANKING_POLICY_ID,
    rankingRunId,
    pair,
    validationPlanId,
    candidateCount: evidences.length,
    rankedCount: rankedResults.length,
    results: [...rankedResults, ...insufficientResults] as readonly AuthoritativeStrategyRankingResult[],
    ...rankingEconomicFields(),
  };
  return deepFreezeRanking({ ...unhashedRun, rankingRunSha256: computeRankingRunSha256(unhashedRun) });
}

/**
 * Groups authorized evidence into pair-local runs and seals the run set.
 *
 * Grouping uses a `Map` keyed by the authoritative pair, and the emitted run
 * order is the sorted pair order - never insertion order.
 */
export function composeRankingRunSet(
  evidences: readonly RankingCandidateEvidence[],
  nonAuthoritativeCandidates: readonly NotEligibleStrategyRankingResult[],
): StrategyRankingRunSet {
  const byPair = new Map<string, RankingCandidateEvidence[]>();
  const seen = new Set<string>();
  for (const evidence of evidences) {
    const subjectId = evidence.identity.validationSubjectId;
    if (seen.has(subjectId)) {
      throw new RankingError('DUPLICATE_RANKING_CANDIDATE', `Duplicate authoritative ranking candidate: ${subjectId}`);
    }
    seen.add(subjectId);
    const bucket = byPair.get(evidence.identity.pair);
    if (bucket === undefined) byPair.set(evidence.identity.pair, [evidence]);
    else bucket.push(evidence);
  }

  const runs = [...byPair.keys()].sort(rankingAscii).map((pair) => {
    const bucket = byPair.get(pair) ?? [];
    const first = bucket[0];
    if (first === undefined) {
      throw new RankingError('RANKING_NUMERIC_FAILURE', `Pair ${pair} has no authoritative candidate`);
    }
    const planIds = new Set(bucket.map((entry) => entry.identity.validationPlanId));
    if (planIds.size !== 1) {
      throw new RankingError('RANKING_EVIDENCE_CONFLICT', `Pair ${pair} mixes candidates from different validation plans`);
    }
    return buildPairRankingRun(pair, first.identity.validationPlanId, bucket);
  });

  const unhashedSet = {
    schemaVersion: RANKING_SCHEMA_VERSION,
    rankingPolicyVersion: 'P15_RANKING_V1' as const,
    rankingPolicyId: P15_RANKING_POLICY_ID,
    runs: runs as readonly StrategyRankingRun[],
    nonAuthoritativeCandidates,
    ...rankingEconomicFields(),
  };
  return deepFreezeRanking({ ...unhashedSet, rankingRunSetSha256: computeRankingRunSetSha256(unhashedSet) });
}
