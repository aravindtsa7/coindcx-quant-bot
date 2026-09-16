import { canonicalJson } from '../../backtest/canonical-json';
import { RankingError } from '../errors';
import { computeRankingResultSha256, computeRankingRunSha256, type UnhashedRankingResult } from '../identity';
import { P15_RANKING_POLICY_ID } from '../policy';
import {
  RANKING_SCHEMA_VERSION,
  type AuthoritativeStrategyRankingResult,
  type StrategyRankingRun,
  type StrategyRankingRunSet,
} from '../types';

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
 *  - persistence authority is bound to genuine engine-minted runs via an
 *    injected `RankingRunAuthority` verifier backed by isolated WeakSet state;
 *    structural caller-created runs produce zero DB writes; this module never
 *    imports the ranking engine or the authority-channel factory itself, so it
 *    cannot mint authority, only ask a supplied verifier to check it;
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

/**
 * The verifier half of a Phase15 ranking-authority channel (see
 * `../authority.ts`). This file deliberately declares this shape locally
 * rather than importing it, so `ranking-repository.ts` has zero static
 * dependency on `authority.ts` or `engine.ts` and stays a narrow leaf: it can
 * check authority without ever being able to mint it.
 */
export interface RankingRunAuthority {
  isAuthoritativeRankingRun(run: unknown): boolean;
  isAuthoritativeRankingRunSet(runSet: unknown): boolean;
}

export class RankingEvidenceUniqueViolationError extends Error {
  public constructor(message = 'Unique constraint violation on ranking evidence insert') {
    super(message);
    this.name = 'RankingEvidenceUniqueViolationError';
  }
}

export function isRankingEvidenceUniqueViolation(error: unknown): error is RankingEvidenceUniqueViolationError {
  return error instanceof RankingEvidenceUniqueViolationError
    || (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'RankingEvidenceUniqueViolationError');
}

export function assertAuthoritativePersistenceIntegrity(run: StrategyRankingRun, authority: RankingRunAuthority): void {
  // 1. Engine authority check - must be genuine Phase15 rankStrategyCandidates output
  if (!authority.isAuthoritativeRankingRun(run)) {
    throw new RankingError('RANKING_EVIDENCE_NOT_AUTHORITATIVE', 'Refusing to persist ranking run without genuine Phase15 engine authority');
  }

  // 2. Policy & schema check
  if (run.rankingPolicyId !== P15_RANKING_POLICY_ID || run.rankingPolicyVersion !== 'P15_RANKING_V1' || run.schemaVersion !== RANKING_SCHEMA_VERSION) {
    throw new RankingError('RANKING_POLICY_INVALID', 'Ranking run policy or schema identity mismatch');
  }

  // 3. Economic firewall on RUN
  if (run.promotionEligible !== false || run.economicStatus !== 'FUNDING_EXCLUDED' || run.maxLifecycle !== 'PAPER') {
    throw new RankingError('RANKING_ECONOMIC_LIMIT_VIOLATION', 'Refusing to persist a ranking run that weakens the frozen economic limitation');
  }

  // 4. Candidate count and ranked count consistency
  if (run.candidateCount !== run.results.length) {
    throw new RankingError('RANKING_EVIDENCE_CORRUPTED', `Run candidateCount (${run.candidateCount}) does not match results array length (${run.results.length})`);
  }
  const expectedRankedCount = run.results.filter((entry) => entry.status === 'RANKED').length;
  if (run.rankedCount !== expectedRankedCount) {
    throw new RankingError('RANKING_EVIDENCE_CORRUPTED', `Run rankedCount (${run.rankedCount}) does not match actual ranked count (${expectedRankedCount})`);
  }

  // 5. Recompute run hash
  const { rankingRunSha256, ...unhashedRun } = run;
  const recomputedRunSha256 = computeRankingRunSha256(unhashedRun);
  if (recomputedRunSha256 !== rankingRunSha256) {
    throw new RankingError('RANKING_EVIDENCE_CORRUPTED', 'Recomputed rankingRunSha256 disagrees with declared run hash', {
      details: { declared: rankingRunSha256, computed: recomputedRunSha256 },
    });
  }

  // 6. Verify each result
  for (const result of run.results) {
    // Economic firewall on RESULT
    if (result.promotionEligible !== false || result.economicStatus !== 'FUNDING_EXCLUDED' || result.maxLifecycle !== 'PAPER') {
      throw new RankingError('RANKING_ECONOMIC_LIMIT_VIOLATION', 'Refusing to persist a ranking result row that weakens the frozen economic limitation');
    }

    // Association to run
    if (
      result.rankingRunId !== run.rankingRunId
      || result.pair !== run.pair
      || result.validationPlanId !== run.validationPlanId
      || result.rankingPolicyId !== run.rankingPolicyId
      || result.rankingPolicyVersion !== run.rankingPolicyVersion
      || result.schemaVersion !== run.schemaVersion
    ) {
      throw new RankingError('RANKING_EVIDENCE_CORRUPTED', 'Ranking result row identity does not match parent run identity');
    }

    // Recompute result hash
    const { rankingResultSha256, ...unhashedResult } = result;
    const recomputedResultSha256 = computeRankingResultSha256(unhashedResult as UnhashedRankingResult);
    if (recomputedResultSha256 !== rankingResultSha256) {
      throw new RankingError('RANKING_EVIDENCE_CORRUPTED', 'Recomputed rankingResultSha256 disagrees with declared result hash', {
        details: { declared: rankingResultSha256, computed: recomputedResultSha256 },
      });
    }
  }
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
  readonly #authority: RankingRunAuthority;

  /**
   * `authority` must be the verifier bound to the ranking engine's own
   * channel (see `src/ranking/index.ts`'s `createStrategyRankingRepository`,
   * the only production wiring point). A caller-authored object satisfying
   * this structural shape is a caller-authored authority, not the engine's -
   * this constructor cannot and does not distinguish the two, exactly like
   * any other injected dependency. See `src/ranking/authority.ts` for why the
   * engine's own channel cannot be forged or reacquired by a third party.
   */
  public constructor(store: RankingEvidenceStore, authority: RankingRunAuthority) {
    this.#store = store;
    this.#authority = authority;
  }

  /**
   * Persists one completed pair-local run.
   *
   * Idempotent: an existing row with the same `rankingRunId` AND the same
   * `rankingRunSha256` returns `ALREADY_IDENTICAL` and writes nothing. An
   * existing row with a different content hash throws rather than overwriting.
   * Concurrent duplicate writes resolve safely to `ALREADY_IDENTICAL` without
   * exposing raw Prisma unique constraint errors.
   */
  public async persistRun(run: StrategyRankingRun): Promise<PersistRankingRunResult> {
    assertAuthoritativePersistenceIntegrity(run, this.#authority);

    const existing = await this.#store.findRun(run.rankingRunId);
    if (existing !== null) {
      if (existing.rankingRunSha256 !== run.rankingRunSha256) {
        throw new RankingError('RANKING_EVIDENCE_CONFLICT', 'Stored ranking run content disagrees with the recomputed run under the same rankingRunId', {
          details: { rankingRunId: run.rankingRunId, stored: existing.rankingRunSha256, computed: run.rankingRunSha256 },
        });
      }
      return { rankingRunId: run.rankingRunId, outcome: 'ALREADY_IDENTICAL' };
    }

    try {
      await this.#store.insertRun(toRankingRunRow(run), run.results.map(toRankingResultRow));
      return { rankingRunId: run.rankingRunId, outcome: 'INSERTED' };
    } catch (error) {
      if (isRankingEvidenceUniqueViolation(error)) {
        const postCollision = await this.#store.findRun(run.rankingRunId);
        if (postCollision !== null) {
          if (postCollision.rankingRunSha256 !== run.rankingRunSha256) {
            throw new RankingError('RANKING_EVIDENCE_CONFLICT', 'Stored ranking run content disagrees with the recomputed run under the same rankingRunId', {
              details: { rankingRunId: run.rankingRunId, stored: postCollision.rankingRunSha256, computed: run.rankingRunSha256 },
            });
          }
          return { rankingRunId: run.rankingRunId, outcome: 'ALREADY_IDENTICAL' };
        }
      }
      throw error;
    }
  }

  /** Persists every pair-local run of a set, in the set's deterministic pair order. */
  public async persistRunSet(runSet: StrategyRankingRunSet): Promise<readonly PersistRankingRunResult[]> {
    if (!this.#authority.isAuthoritativeRankingRunSet(runSet)) {
      throw new RankingError('RANKING_EVIDENCE_NOT_AUTHORITATIVE', 'Refusing to persist ranking run set without genuine Phase15 engine authority');
    }
    const outcomes: PersistRankingRunResult[] = [];
    for (const run of runSet.runs) {
      outcomes.push(await this.persistRun(run));
    }
    return Object.freeze(outcomes);
  }
}

// Pin CommonJS authority entry points to lexical implementations. This also
// prevents pre-import replacement through an already-loaded repo namespace.
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  if (Object.getOwnPropertyDescriptor(module.exports, 'StrategyRankingRepository')?.configurable !== false) {
    Object.defineProperty(module.exports, 'StrategyRankingRepository', { get: () => StrategyRankingRepository, configurable: false });
  }
  if (Object.getOwnPropertyDescriptor(module.exports, 'assertAuthoritativePersistenceIntegrity')?.configurable !== false) {
    Object.defineProperty(module.exports, 'assertAuthoritativePersistenceIntegrity', { get: () => assertAuthoritativePersistenceIntegrity, configurable: false });
  }
  if (Object.getOwnPropertyDescriptor(module.exports, 'RankingEvidenceUniqueViolationError')?.configurable !== false) {
    Object.defineProperty(module.exports, 'RankingEvidenceUniqueViolationError', { get: () => RankingEvidenceUniqueViolationError, configurable: false });
  }
  if (Object.getOwnPropertyDescriptor(module.exports, 'isRankingEvidenceUniqueViolation')?.configurable !== false) {
    Object.defineProperty(module.exports, 'isRankingEvidenceUniqueViolation', { get: () => isRankingEvidenceUniqueViolation, configurable: false });
  }
  if (Object.getOwnPropertyDescriptor(module.exports, 'toRankingRunRow')?.configurable !== false) {
    Object.defineProperty(module.exports, 'toRankingRunRow', { get: () => toRankingRunRow, configurable: false });
  }
  Object.freeze(module.exports);
}
