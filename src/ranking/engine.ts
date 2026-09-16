import type { ResearchValidationPlanResult } from '../research/research-validation/types';
import { composeRankingRunSet, deepFreezeRanking, rankingAscii, rankingEconomicFields } from './core';
import { RankingError } from './errors';
import { deriveAuthoritativeRankingEvidence } from './evidence';
import { P15_RANKING_POLICY_ID } from './policy';
import {
  RANKING_SCHEMA_VERSION,
  type NotEligibleStrategyRankingResult,
  type RankingCandidateEvidence,
  type StrategyRankingRunSet,
} from './types';

/**
 * Phase15 ranking engine - the single authoritative public entry point.
 *
 * Strictly analytical and strictly read-only. It performs no I/O, opens no
 * CoinDCX connection, reruns no Phase12 validation, touches no Phase13 risk
 * policy, reads or writes no Phase14 account state, and has no code path that
 * can transition a coin runtime lifecycle. Its entire output is ordinal
 * evidence whose every row is permanently `promotionEligible: false`,
 * `economicStatus: FUNDING_EXCLUDED`, `maxLifecycle: PAPER`.
 */

export interface StrategyRankingCandidateSubject {
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
}

export interface RankStrategyCandidatesParams {
  /**
   * A genuine `ResearchValidationPlanResult` produced by the Phase12 executor.
   * A structurally identical clone is refused by the Phase12 approval
   * authority, so every candidate derived from a forged object becomes
   * `NOT_ELIGIBLE`.
   */
  readonly planResult: ResearchValidationPlanResult;
  /** The declared candidate universe. Never empty; never containing duplicates. */
  readonly candidates: readonly StrategyRankingCandidateSubject[];
}

function declaredKey(subject: StrategyRankingCandidateSubject): string {
  return JSON.stringify([subject.pair, subject.strategyId, subject.strategyVersion, subject.parameterHash]);
}

function notEligible(subject: StrategyRankingCandidateSubject): NotEligibleStrategyRankingResult {
  return deepFreezeRanking({
    schemaVersion: RANKING_SCHEMA_VERSION,
    rankingPolicyVersion: 'P15_RANKING_V1' as const,
    rankingPolicyId: P15_RANKING_POLICY_ID,
    status: 'NOT_ELIGIBLE' as const,
    declaredPair: subject.pair,
    declaredStrategyId: subject.strategyId,
    declaredStrategyVersion: subject.strategyVersion,
    declaredParameterHash: subject.parameterHash,
    ...rankingEconomicFields(),
    reasonCodes: ['VALIDATION_SUBJECT_NOT_AUTHORITATIVE', 'FUNDING_EXCLUDED', 'PROMOTION_BLOCKED_FUNDING_EXCLUDED'] as const,
  });
}

/**
 * Ranks a declared Coin x Strategy candidate universe against one genuine
 * Phase12 validation plan result.
 *
 * Candidates are ranked WITHIN EACH PAIR: the returned set contains one
 * independent pair-local run per pair, each with its own `rankingRunId`. There
 * is no cross-coin ordinal leaderboard in V1, so no cross-coin capital or
 * regime comparability is assumed.
 *
 * A candidate that cannot be proven to be a genuine Phase12 `PASSED` subject
 * (forged plan result, tampered identity, `FAILED`, or
 * `INSUFFICIENT_EVIDENCE`) becomes a `NOT_ELIGIBLE` row that carries no
 * ranking evidence and is excluded from every `rankingRunId`.
 *
 * @throws RankingError `EMPTY_RANKING_UNIVERSE` when `candidates` is empty -
 *   Phase15 never invents a universe or emits a fake ranking.
 * @throws RankingError `DUPLICATE_RANKING_CANDIDATE` when two candidates share
 *   a declared identity tuple or resolve to the same `validationSubjectId`.
 */
export function rankStrategyCandidates(params: RankStrategyCandidatesParams): StrategyRankingRunSet {
  const { planResult, candidates } = params;
  if (candidates.length === 0) {
    throw new RankingError('EMPTY_RANKING_UNIVERSE', 'Phase15 ranking requires at least one declared candidate');
  }

  const declared = new Set<string>();
  for (const candidate of candidates) {
    const key = declaredKey(candidate);
    if (declared.has(key)) {
      throw new RankingError('DUPLICATE_RANKING_CANDIDATE', `Duplicate declared ranking candidate: ${key}`);
    }
    declared.add(key);
  }

  const authoritative: RankingCandidateEvidence[] = [];
  const nonAuthoritative: NotEligibleStrategyRankingResult[] = [];
  for (const candidate of candidates) {
    const evidence = deriveAuthoritativeRankingEvidence(planResult, candidate);
    if (evidence === null) nonAuthoritative.push(notEligible(candidate));
    else authoritative.push(evidence);
  }

  nonAuthoritative.sort((left, right) => rankingAscii(
    declaredKey({ pair: left.declaredPair, strategyId: left.declaredStrategyId, strategyVersion: left.declaredStrategyVersion, parameterHash: left.declaredParameterHash }),
    declaredKey({ pair: right.declaredPair, strategyId: right.declaredStrategyId, strategyVersion: right.declaredStrategyVersion, parameterHash: right.declaredParameterHash }),
  ));

  return composeRankingRunSet(authoritative, Object.freeze(nonAuthoritative));
}
