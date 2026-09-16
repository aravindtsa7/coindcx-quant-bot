/**
 * Phase 15 — Strategy Ranking public surface.
 *
 * Deliberately narrow. The pure scoring core (`core.ts`, `normalize.ts`,
 * `score.ts`, `tie-break.ts`, `identity.ts`) and the Phase12 evidence adapter
 * (`evidence.ts`) are NOT re-exported: the only public way to obtain an
 * authoritative Phase15 result is `rankStrategyCandidates`, which requires a
 * genuine Phase12 `ResearchValidationPlanResult`. A caller therefore cannot
 * reach the scorer with a fabricated metric DTO through this barrel. Those
 * modules remain importable by their concrete paths for lower-level tests,
 * matching the repository's existing internal-module convention.
 *
 * Nothing exported here can place an order, mutate Phase14 account state,
 * change Phase13 risk admission, or promote a coin runtime lifecycle.
 */

export { RankingError, type RankingErrorCode } from './errors';

export {
  P15_ECONOMIC_LIMITATION, P15_RANKING_POLICY_ID, P15_RANKING_V1, P15_COMPONENT_IDS, P15_TIE_BREAK_ORDER,
  rankingComponentPolicy,
} from './policy';

export { rankStrategyCandidates, type RankStrategyCandidatesParams, type StrategyRankingCandidateSubject } from './engine';

export {
  RANKING_SCHEMA_VERSION,
  type AuthoritativeStrategyRankingResult,
  type InsufficientEvidenceStrategyRankingResult,
  type NotEligibleStrategyRankingResult,
  type RankedStrategyRankingResult,
  type RankingComponentDirection,
  type RankingComponentId,
  type RankingComponentPolicy,
  type RankingComponentScore,
  type RankingComponentSource,
  type RankingDecimalPolicy,
  type RankingEconomicLimitation,
  type RankingEconomicStatus,
  type RankingFundingCapability,
  type RankingFundingCapabilityReason,
  type RankingMaxLifecycle,
  type RankingMetricUnavailableReason,
  type RankingNormalizationAlgorithm,
  type RankingNormalizationPolicy,
  type RankingPaperEconomicStatus,
  type RankingPnlLabel,
  type RankingPolicy,
  type RankingReasonCode,
  type RankingResultStatus,
  type RankingTieBreakLevel,
  type StrategyRankingResult,
  type StrategyRankingRun,
  type StrategyRankingRunSet,
} from './types';

export {
  PAPER_OBSERVATION_NOT_OBSERVED, attachPaperObservations, buildPaperObservationView,
  type BuildPaperObservationInput, type FundingExcludedObservationalValue, type PaperMechanicalHealth,
  type PaperObservationLineage, type PaperObservationStatus, type PaperObservationView,
  type PaperObservedView, type PaperReconciliationStatus, type PaperUnobservedView,
  type RankingRunObservationView,
} from './paper-observation';

export {
  StrategyRankingRepository, toRankingResultRow, toRankingRunRow,
  type PersistRankingRunOutcome, type PersistRankingRunResult, type RankingEvidenceStore,
  type RankingResultRow, type RankingRunRow, type StoredRankingRunSummary,
} from './persistence/ranking-repository';
export { PrismaRankingEvidenceStore } from './persistence/prisma-ranking-store';
