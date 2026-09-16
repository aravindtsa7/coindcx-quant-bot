/**
 * Phase15 Strategy x Coin ranking contracts.
 *
 * Phase15 is strictly analytical: it reads authoritative Phase12 research
 * evidence and emits read-only ordinal evidence. No value in this file can
 * authorize an order, mutate a Phase14 account, change risk admission, or
 * promote a coin runtime lifecycle.
 */

export const RANKING_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Frozen Phase14 economic limitation, restated as the Phase15 ranking contract
// ---------------------------------------------------------------------------

/**
 * Phase14 proved CoinDCX provider evidence insufficient to reproduce funding
 * economics, so every Phase15 result is funding-excluded by construction.
 *
 * These literals deliberately mirror `src/execution/funding-capability.ts`
 * WITHOUT importing it: the Phase15 architecture gate forbids any
 * `src/ranking/**` -> `src/execution/**` import edge (including a type-only
 * one, which the shared import-graph builder counts as a real edge).
 * `tests/unit/ranking/economic-limit.test.ts` asserts field-by-field equality
 * against the genuine Phase14 disclosure so the two can never drift.
 */
export type RankingEconomicStatus = 'FUNDING_EXCLUDED';
export type RankingMaxLifecycle = 'PAPER';
export type RankingFundingCapability = 'FUNDING_UNSUPPORTED';
export type RankingFundingCapabilityReason = 'COINDCX_PROVIDER_EVIDENCE_INCOMPLETE';
export type RankingPaperEconomicStatus = 'PAPER_NOT_ECONOMICALLY_COMPLETE';
export type RankingPnlLabel = 'FUNDING_EXCLUDED_PNL';

export interface RankingEconomicLimitation {
  readonly economicStatus: RankingEconomicStatus;
  readonly fundingCapability: RankingFundingCapability;
  readonly fundingCapabilityReason: RankingFundingCapabilityReason;
  readonly fundingApplied: false;
  readonly paperEconomicStatus: RankingPaperEconomicStatus;
  readonly pnlLabel: RankingPnlLabel;
  readonly promotionEligible: false;
  readonly maxLifecycle: RankingMaxLifecycle;
}

// ---------------------------------------------------------------------------
// Policy contracts
// ---------------------------------------------------------------------------

export type RankingComponentId =
  | 'SHARPE'
  | 'SORTINO'
  | 'MAX_DRAWDOWN'
  | 'PROFIT_FACTOR'
  | 'EXPECTANCY'
  | 'OOS_CONSISTENCY'
  | 'PARAMETER_ROBUSTNESS';

export type RankingComponentDirection = 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';

/**
 * Where the component's authoritative value is read from inside the genuine
 * Phase12 `StrategyValidationRecord`. Bound into `rankingPolicyId`: changing
 * the source of a component changes the policy identity.
 */
export type RankingComponentSource =
  | { readonly kind: 'AGGREGATE_OOS_METRIC'; readonly metric: string }
  | { readonly kind: 'GATE_OBSERVED_VALUE'; readonly gateId: string; readonly gateName: string }
  | { readonly kind: 'SUBJECT_METRIC'; readonly metric: string };

export interface RankingComponentPolicy {
  readonly componentId: RankingComponentId;
  readonly weight: string;
  readonly direction: RankingComponentDirection;
  /** V1 declares every component required; a missing/invalid value fails closed. */
  readonly required: true;
  readonly source: RankingComponentSource;
}

export type RankingNormalizationAlgorithm = 'P15_CANDIDATE_SET_RELATIVE_DENSE_ORDINAL_V1';

export interface RankingNormalizationPolicy {
  readonly algorithm: RankingNormalizationAlgorithm;
  /** Ordinal normalization is computed over the candidates of exactly one pair. */
  readonly scope: 'PAIR_LOCAL';
  /** Equal canonical metric values collapse to one dense ordinal position and one identical score. */
  readonly tieCollapse: 'DENSE_EQUAL_VALUES_SHARE_POSITION';
  /** Best = 1, worst = 0; a one-distinct-value universe scores 1. */
  readonly bestScore: '1';
  readonly worstScore: '0';
  readonly singleDistinctValueScore: '1';
}

export type RankingTieBreakLevel =
  | 'LOWER_MAX_DRAWDOWN'
  | 'HIGHER_SHARPE'
  | 'HIGHER_SORTINO'
  | 'HIGHER_PROFIT_FACTOR'
  | 'LEXICAL_VALIDATION_SUBJECT_ID';

export interface RankingDecimalPolicy {
  readonly calculationPrecision: 128;
  readonly publishedScale: 18;
  readonly rounding: 'ROUND_HALF_UP';
  readonly floatingPointArithmetic: 'FORBIDDEN';
}

export interface RankingPolicy {
  readonly rankingPolicyVersion: 'P15_RANKING_V1';
  readonly schemaVersion: typeof RANKING_SCHEMA_VERSION;
  readonly components: readonly RankingComponentPolicy[];
  readonly normalization: RankingNormalizationPolicy;
  readonly tieBreakOrder: readonly RankingTieBreakLevel[];
  readonly decimal: RankingDecimalPolicy;
  readonly economicLimitation: RankingEconomicLimitation;
  /** Phase15 never contributes funding-excluded paper economics to the score. */
  readonly paperEconomicContribution: 'NONE';
}

// ---------------------------------------------------------------------------
// Candidate evidence (produced only by the Phase12 authority adapter)
// ---------------------------------------------------------------------------

export type RankingMetricUnavailableReason =
  | 'METRIC_ABSENT'
  | 'METRIC_NOT_VALUE'
  | 'METRIC_NON_CANONICAL'
  | 'GATE_UNAVAILABLE';

export type RankingComponentMetric =
  | { readonly status: 'VALUE'; readonly value: string }
  | { readonly status: 'UNAVAILABLE'; readonly reason: RankingMetricUnavailableReason; readonly detail: string };

export type RankingComponentMetrics = Readonly<Record<RankingComponentId, RankingComponentMetric>>;

/** The canonical Phase15 candidate identity - the existing Coin x Strategy validation subject. */
export interface RankingCandidateIdentity {
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly validationSubjectId: string;
  readonly validationPlanId: string;
  readonly validationSubjectResultSha256: string;
}

/**
 * Authoritative per-candidate ranking evidence.
 *
 * Production code obtains this ONLY from `deriveAuthoritativeRankingEvidence`,
 * which requires a genuine executor-issued `ResearchApprovalOrigin`. Neither
 * this type's producer nor the pure scoring core is re-exported from the
 * Phase15 barrel, so a caller cannot hand a fabricated evidence DTO to the
 * authoritative entry point.
 */
export interface RankingCandidateEvidence {
  readonly identity: RankingCandidateIdentity;
  readonly metrics: RankingComponentMetrics;
}

// ---------------------------------------------------------------------------
// Result contracts
// ---------------------------------------------------------------------------

export type RankingResultStatus = 'RANKED' | 'NOT_ELIGIBLE' | 'INSUFFICIENT_RANKING_EVIDENCE';

export type RankingReasonCode =
  | 'RANKED'
  | 'VALIDATION_SUBJECT_NOT_AUTHORITATIVE'
  | 'REQUIRED_METRIC_UNAVAILABLE'
  | 'FUNDING_EXCLUDED'
  | 'PROMOTION_BLOCKED_FUNDING_EXCLUDED';

export interface RankingComponentScore {
  readonly componentId: RankingComponentId;
  readonly weight: string;
  readonly direction: RankingComponentDirection;
  /** The authoritative Phase12 value, canonically normalized. */
  readonly metricValue: string;
  /** Dense ordinal position within the pair-local candidate set (0 = best). */
  readonly ordinalPosition: number;
  readonly distinctValueCount: number;
  /** Exact ordinal normalization in [0, 1]. */
  readonly componentScore: string;
  /** weight x componentScore, canonical. */
  readonly weightedScore: string;
}

interface RankingResultBase {
  readonly schemaVersion: typeof RANKING_SCHEMA_VERSION;
  readonly rankingPolicyVersion: 'P15_RANKING_V1';
  readonly rankingPolicyId: string;
  readonly rankingRunId: string;
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly validationSubjectId: string;
  readonly validationPlanId: string;
  readonly validationSubjectResultSha256: string;
  readonly economicStatus: RankingEconomicStatus;
  readonly promotionEligible: false;
  readonly maxLifecycle: RankingMaxLifecycle;
  readonly reasonCodes: readonly RankingReasonCode[];
  readonly rankingResultSha256: string;
}

export interface RankedStrategyRankingResult extends RankingResultBase {
  readonly status: 'RANKED';
  readonly componentScores: readonly RankingComponentScore[];
  readonly compositeScore: string;
  readonly rank: number;
  /**
   * The size of the ORDINAL universe this `rank` is drawn from: the number of
   * RANKED candidates in this pair. It deliberately differs from
   * `StrategyRankingRun.candidateCount`, which counts every authoritative
   * candidate evaluated for the pair, including the
   * `INSUFFICIENT_RANKING_EVIDENCE` ones that occupy no ordinal slot.
   */
  readonly candidateCount: number;
  readonly compositeTieGroupSize: number;
  /**
   * The first tie-break level that separated this candidate from its immediate
   * predecessor inside the same composite-score tie group; `null` when this
   * candidate leads its group or its group has exactly one member.
   */
  readonly tieBreakLevelApplied: RankingTieBreakLevel | null;
}

export interface InsufficientEvidenceStrategyRankingResult extends RankingResultBase {
  readonly status: 'INSUFFICIENT_RANKING_EVIDENCE';
  readonly unavailableComponents: readonly {
    readonly componentId: RankingComponentId;
    readonly reason: RankingMetricUnavailableReason;
    readonly detail: string;
  }[];
}

export type AuthoritativeStrategyRankingResult = RankedStrategyRankingResult | InsufficientEvidenceStrategyRankingResult;

/**
 * A caller-declared subject that could not be proven to be a genuine Phase12
 * PASSED subject. Deliberately carries no ranking evidence, is not part of any
 * `rankingRunId`, and does not belong to a pair-local candidate universe.
 */
export interface NotEligibleStrategyRankingResult {
  readonly schemaVersion: typeof RANKING_SCHEMA_VERSION;
  readonly rankingPolicyVersion: 'P15_RANKING_V1';
  readonly rankingPolicyId: string;
  readonly status: 'NOT_ELIGIBLE';
  /** Caller-declared, never authoritative. */
  readonly declaredPair: string;
  readonly declaredStrategyId: string;
  readonly declaredStrategyVersion: string;
  readonly declaredParameterHash: string;
  readonly economicStatus: RankingEconomicStatus;
  readonly promotionEligible: false;
  readonly maxLifecycle: RankingMaxLifecycle;
  readonly reasonCodes: readonly RankingReasonCode[];
}

export type StrategyRankingResult = AuthoritativeStrategyRankingResult | NotEligibleStrategyRankingResult;

/** One pair-local leaderboard. BTC candidates never share a run with ETH candidates. */
export interface StrategyRankingRun {
  readonly schemaVersion: typeof RANKING_SCHEMA_VERSION;
  readonly rankingPolicyVersion: 'P15_RANKING_V1';
  readonly rankingPolicyId: string;
  readonly rankingRunId: string;
  readonly pair: string;
  readonly validationPlanId: string;
  /** Authoritative candidates evaluated in this pair (ranked + insufficient-evidence). */
  readonly candidateCount: number;
  readonly rankedCount: number;
  readonly results: readonly AuthoritativeStrategyRankingResult[];
  readonly economicStatus: RankingEconomicStatus;
  readonly promotionEligible: false;
  readonly maxLifecycle: RankingMaxLifecycle;
  readonly rankingRunSha256: string;
}

export interface StrategyRankingRunSet {
  readonly schemaVersion: typeof RANKING_SCHEMA_VERSION;
  readonly rankingPolicyVersion: 'P15_RANKING_V1';
  readonly rankingPolicyId: string;
  /** Sorted by `pair` ascending. */
  readonly runs: readonly StrategyRankingRun[];
  /** Sorted by declared identity ascending. Never part of any `rankingRunId`. */
  readonly nonAuthoritativeCandidates: readonly NotEligibleStrategyRankingResult[];
  readonly economicStatus: RankingEconomicStatus;
  readonly promotionEligible: false;
  readonly maxLifecycle: RankingMaxLifecycle;
  readonly rankingRunSetSha256: string;
}
