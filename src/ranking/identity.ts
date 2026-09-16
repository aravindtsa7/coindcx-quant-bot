import { sha256CanonicalJson } from '../backtest/canonical-json';
import { P15_COMPONENT_IDS, P15_RANKING_POLICY_ID } from './policy';
import {
  RANKING_SCHEMA_VERSION,
  type AuthoritativeStrategyRankingResult,
  type RankingCandidateEvidence,
  type RankingComponentMetric,
  type StrategyRankingRun,
  type StrategyRankingRunSet,
} from './types';

/**
 * Phase15 run identity.
 *
 * `rankingPolicyId` (in `policy.ts`) binds the policy version, metric set,
 * weights, directions, normalization algorithm, tie-break policy and economic
 * limitation semantics.
 *
 * `rankingRunId` additionally binds:
 *
 *  - the exact pair (a run is pair-local, so a BTC run identity can never
 *    contain an ETH candidate);
 *  - the authoritative Phase12 `validationPlanId`. Phase12 defines
 *    `validationPlanId = sha256CanonicalJson(plan)` and the plan carries
 *    `sourceIdentity.gitCommitHash`, so the verified-clean source Git identity
 *    is cryptographically bound transitively - Phase15 does not mint a second,
 *    weaker Git identity of its own;
 *  - the exact candidate universe: every authoritative candidate evaluated for
 *    this pair, with its Phase12 subject identity, its Phase12
 *    `validationSubjectResultSha256`, its rankability, and the canonical value
 *    (or the unavailability reason) of every policy component.
 *
 * Binding the component values directly - not only the Phase12 result hash -
 * is what makes a 1e-18 outcome-affecting metric difference produce a
 * different `rankingRunId`.
 *
 * The universe is sorted by `validationSubjectId`, so worker count, DB
 * insertion order and caller array order cannot reach the identity. No wall
 * clock, host, PID or paper observation participates.
 */

function canonicalMetric(metric: RankingComponentMetric): Readonly<Record<string, string>> {
  return metric.status === 'VALUE'
    ? { status: 'VALUE', value: metric.value }
    : { status: 'UNAVAILABLE', reason: metric.reason, detail: metric.detail };
}

export interface RankingUniverseEntry {
  readonly evidence: RankingCandidateEvidence;
  readonly rankable: boolean;
}

function canonicalUniverse(entries: readonly RankingUniverseEntry[]): readonly unknown[] {
  return [...entries]
    .sort((left, right) => {
      const a = left.evidence.identity.validationSubjectId;
      const b = right.evidence.identity.validationSubjectId;
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .map((entry) => {
      const { identity, metrics } = entry.evidence;
      const componentMetrics: Record<string, unknown> = {};
      // Frozen policy order, never object key-iteration order.
      for (const componentId of P15_COMPONENT_IDS) {
        const metric = metrics[componentId];
        componentMetrics[componentId] = metric === undefined
          ? { status: 'UNAVAILABLE', reason: 'METRIC_ABSENT', detail: componentId }
          : canonicalMetric(metric);
      }
      return {
        validationSubjectId: identity.validationSubjectId,
        strategyId: identity.strategyId,
        strategyVersion: identity.strategyVersion,
        parameterHash: identity.parameterHash,
        validationSubjectResultSha256: identity.validationSubjectResultSha256,
        eligibility: entry.rankable ? 'RANKABLE' : 'INSUFFICIENT_RANKING_EVIDENCE',
        componentMetrics,
      };
    });
}

export interface RankingRunIdentityInput {
  readonly pair: string;
  readonly validationPlanId: string;
  readonly universe: readonly RankingUniverseEntry[];
}

export function computeRankingRunId(input: RankingRunIdentityInput): string {
  return sha256CanonicalJson({
    schemaVersion: RANKING_SCHEMA_VERSION,
    rankingPolicyId: P15_RANKING_POLICY_ID,
    rankingPolicyVersion: 'P15_RANKING_V1',
    pair: input.pair,
    validationPlanId: input.validationPlanId,
    candidateUniverse: canonicalUniverse(input.universe),
  });
}

/** Distributes `Omit` across a discriminated union so the discriminant survives. */
type WithoutKey<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type UnhashedRankingResult = WithoutKey<AuthoritativeStrategyRankingResult, 'rankingResultSha256'>;

/** Content identity of one ranking result row, computed over every field except the hash itself. */
export function computeRankingResultSha256(result: UnhashedRankingResult): string {
  return sha256CanonicalJson(result);
}

/** Content identity of a completed pair-local run, computed over every field except the hash itself. */
export function computeRankingRunSha256(run: Omit<StrategyRankingRun, 'rankingRunSha256'>): string {
  return sha256CanonicalJson(run);
}

/** Content identity of the full multi-pair run set, computed over every field except the hash itself. */
export function computeRankingRunSetSha256(runSet: Omit<StrategyRankingRunSet, 'rankingRunSetSha256'>): string {
  return sha256CanonicalJson(runSet);
}
