import { canonicalJson } from '../../backtest/canonical-json';
import { RankingError } from '../errors';
import type { AuthoritativeStrategyRankingResult, StrategyRankingRun, StrategyRankingRunSet } from '../types';

/**
 * Phase15 ranking persistence.
 *
 * Persistence exists only for deterministic audit and restart reproducibility.
 * It is strictly additive and strictly append-only:
 *
 *  - a completed ranking run is immutable once written (no UPDATE path);
 *  - `rankingRunId` is the primary key, so re-running the same semantic ranking
 *    is IDEMPOTENT (`ALREADY_IDENTICAL`) rather than duplicative;
 *  - a same-id/different-content write is a fail-closed
 *    `RANKING_EVIDENCE_CONFLICT`, never a silent overwrite;
 *  - no Phase12 validation result and no Phase14 paper ledger row is read,
 *    written, or referenced by foreign key; and
 *  - decimals are stored as canonical fixed-point strings handed to the
 *    DECIMAL(36,18) column, never as JS floats.
 *
 * Restart behaviour: nothing needs to be replayed. A ranking run is a pure
 * deterministic function of Phase12 evidence, so recomputing after a restart
 * yields the same `rankingRunId` and the same content hash, and re-persisting
 * is a no-op.
 */

export type PersistRankingRunOutcome = 'INSERTED' | 'ALREADY_IDENTICAL';

export interface PersistRankingRunResult {
  readonly rankingRunId: string;
  readonly outcome: PersistRankingRunOutcome;
}

export interface StoredRankingRunSummary {
  readonly rankingRunId: string;
  readonly rankingRunSha256: string;
}

/** Row shapes handed to the datasource. Decimal values are canonical strings. */
export interface RankingRunRow {
  readonly rankingRunId: string;
  readonly schemaVersion: number;
  readonly rankingPolicyId: string;
  readonly rankingPolicyVersion: string;
  readonly pair: string;
  readonly validationPlanId: string;
  readonly candidateCount: number;
  readonly rankedCount: number;
  readonly economicStatus: string;
  readonly promotionEligible: boolean;
  readonly maxLifecycle: string;
  readonly rankingRunSha256: string;
}

export interface RankingResultRow {
  readonly rankingResultSha256: string;
  readonly rankingRunId: string;
  readonly schemaVersion: number;
  readonly status: string;
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly validationSubjectId: string;
  readonly validationPlanId: string;
  readonly validationSubjectResultSha256: string;
  readonly compositeScore: string | null;
  readonly rank: number | null;
  readonly candidateCount: number | null;
  readonly compositeTieGroupSize: number | null;
  readonly tieBreakLevelApplied: string | null;
  readonly componentScoresJson: string | null;
  readonly reasonCodesJson: string;
  readonly unavailableComponentsJson: string | null;
  readonly economicStatus: string;
  readonly promotionEligible: boolean;
  readonly maxLifecycle: string;
}

/**
 * The narrow datasource port. Deliberately tiny and free of any Prisma type,
 * so the repository's immutability/idempotence logic is testable without a
 * live MySQL instance and cannot reach any other table.
 */
export interface RankingEvidenceStore {
  findRun(rankingRunId: string): Promise<StoredRankingRunSummary | null>;
  insertRun(run: RankingRunRow, results: readonly RankingResultRow[]): Promise<void>;
}

export function toRankingRunRow(run: StrategyRankingRun): RankingRunRow {
  return {
    rankingRunId: run.rankingRunId,
    schemaVersion: run.schemaVersion,
    rankingPolicyId: run.rankingPolicyId,
    rankingPolicyVersion: run.rankingPolicyVersion,
    pair: run.pair,
    validationPlanId: run.validationPlanId,
    candidateCount: run.candidateCount,
    rankedCount: run.rankedCount,
    economicStatus: run.economicStatus,
    promotionEligible: run.promotionEligible,
    maxLifecycle: run.maxLifecycle,
    rankingRunSha256: run.rankingRunSha256,
  };
}

export function toRankingResultRow(result: AuthoritativeStrategyRankingResult): RankingResultRow {
  const ranked = result.status === 'RANKED' ? result : null;
  return {
    rankingResultSha256: result.rankingResultSha256,
    rankingRunId: result.rankingRunId,
    schemaVersion: result.schemaVersion,
    status: result.status,
    pair: result.pair,
    strategyId: result.strategyId,
    strategyVersion: result.strategyVersion,
    parameterHash: result.parameterHash,
    validationSubjectId: result.validationSubjectId,
    validationPlanId: result.validationPlanId,
    validationSubjectResultSha256: result.validationSubjectResultSha256,
    compositeScore: ranked === null ? null : ranked.compositeScore,
    rank: ranked === null ? null : ranked.rank,
    candidateCount: ranked === null ? null : ranked.candidateCount,
    compositeTieGroupSize: ranked === null ? null : ranked.compositeTieGroupSize,
    tieBreakLevelApplied: ranked === null ? null : ranked.tieBreakLevelApplied,
    componentScoresJson: ranked === null ? null : canonicalJson(ranked.componentScores),
    reasonCodesJson: canonicalJson(result.reasonCodes),
    unavailableComponentsJson: result.status === 'INSUFFICIENT_RANKING_EVIDENCE' ? canonicalJson(result.unavailableComponents) : null,
    economicStatus: result.economicStatus,
    promotionEligible: result.promotionEligible,
    maxLifecycle: result.maxLifecycle,
  };
}

/**
 * Append-only repository over a `RankingEvidenceStore`. It exposes no update
 * and no delete: there is intentionally no method by which completed ranking
 * evidence can be rewritten.
 */
export class StrategyRankingRepository {
  readonly #store: RankingEvidenceStore;

  public constructor(store: RankingEvidenceStore) {
    this.#store = store;
  }

  /**
   * Persists one completed pair-local run.
   *
   * Idempotent: an existing row with the same `rankingRunId` AND the same
   * `rankingRunSha256` returns `ALREADY_IDENTICAL` and writes nothing. An
   * existing row with a different content hash throws rather than overwriting.
   */
  public async persistRun(run: StrategyRankingRun): Promise<PersistRankingRunResult> {
    if (run.promotionEligible !== false || run.economicStatus !== 'FUNDING_EXCLUDED' || run.maxLifecycle !== 'PAPER') {
      throw new RankingError('RANKING_ECONOMIC_LIMIT_VIOLATION', 'Refusing to persist a ranking run that weakens the frozen economic limitation');
    }
    const existing = await this.#store.findRun(run.rankingRunId);
    if (existing !== null) {
      if (existing.rankingRunSha256 !== run.rankingRunSha256) {
        throw new RankingError('RANKING_EVIDENCE_CONFLICT', 'Stored ranking run content disagrees with the recomputed run under the same rankingRunId', {
          details: { rankingRunId: run.rankingRunId, stored: existing.rankingRunSha256, computed: run.rankingRunSha256 },
        });
      }
      return { rankingRunId: run.rankingRunId, outcome: 'ALREADY_IDENTICAL' };
    }
    await this.#store.insertRun(toRankingRunRow(run), run.results.map(toRankingResultRow));
    return { rankingRunId: run.rankingRunId, outcome: 'INSERTED' };
  }

  /** Persists every pair-local run of a set, in the set's deterministic pair order. */
  public async persistRunSet(runSet: StrategyRankingRunSet): Promise<readonly PersistRankingRunResult[]> {
    const outcomes: PersistRankingRunResult[] = [];
    for (const run of runSet.runs) {
      outcomes.push(await this.persistRun(run));
    }
    return Object.freeze(outcomes);
  }
}
