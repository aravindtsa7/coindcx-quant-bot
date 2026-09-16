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
 *
 * REPOSITORY CONSTRUCTION SECURITY (Finding 1, final closure)
 * -------------------------------------------------------------------------
 * The MySQL-backed `RankingEvidenceStore` implementation (`PrismaEvidenceStore`
 * below) is declared and used ENTIRELY inside this file. It is not declared in
 * any separately importable module, so there is no deep-import path anywhere
 * in this repository that can obtain a real, DB-writing store implementation
 * and pair it with a caller-supplied authority object. The only exported
 * function that can ever produce a Prisma-backed, DB-writing
 * `StrategyRankingRepository` is `createStrategyRankingRepository` below, and
 * it takes ONLY a `PrismaClient` - the authority half is always the ranking
 * engine's own real, statically-imported `isAuthoritativeRankingRun` /
 * `isAuthoritativeRankingRunSet`, never a parameter a caller can substitute.
 *
 * `StrategyRankingRepository` itself (from `./persistence/ranking-repository`)
 * remains constructible with an arbitrary store and an arbitrary authority via
 * a direct deep import - that is intentional and harmless (it is how tests
 * exercise the authority/hash/policy checks against an in-memory double), and
 * it is the caller's OWN store, never this file's private, real one. See the
 * review notes for the residual, JS-module-system-inherent limitation this
 * does NOT and cannot close: an attacker who separately obtains a real
 * `PrismaClient` (already possible today, unrelated to Phase15, via the app's
 * own `src/persistence/prisma.ts`) can always write their OWN raw Prisma
 * queries against the `ranking_run`/`ranking_result` tables, exactly as they
 * could against any other table in this application. What this file removes
 * is the pre-built, one-call CONVENIENCE for doing so through Phase15's own
 * code - there is no longer an exported function anywhere in this codebase
 * that combines a real store with a substitutable authority.
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { isAuthoritativeRankingRun, isAuthoritativeRankingRunSet } from './engine';
import {
  RankingEvidenceUniqueViolationError,
  StrategyRankingRepository,
  type RankingEvidenceStore,
  type RankingResultRow,
  type RankingRunRow,
  type StoredRankingRunSummary,
} from './persistence/ranking-repository';

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
  StrategyRankingRepository,
  type PersistRankingRunOutcome, type PersistRankingRunResult, type StoredRankingRunSummary,
} from './persistence/ranking-repository';

/**
 * MySQL-backed `RankingEvidenceStore`. Deliberately declared HERE, in the
 * barrel, rather than in its own separately importable module: this is the
 * only way to guarantee no deep import anywhere can obtain a real,
 * DB-writing store implementation on its own. This class is never exported.
 *
 * The Prisma client is always injected - this file never constructs or
 * imports the process-wide singleton (`src/persistence/prisma.ts`) itself, so
 * importing Phase15 never opens a database connection on its own.
 *
 * `insertRun` writes the run and its result rows inside one interactive
 * transaction, so a crash can never leave a `ranking_run` header without its
 * evidence rows. Every decimal crosses the boundary as a canonical
 * fixed-point string wrapped in `Prisma.Decimal`; no JS float is persisted.
 */
class PrismaEvidenceStore implements RankingEvidenceStore {
  readonly #prisma: PrismaClient;

  public constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  public async findRun(rankingRunId: string): Promise<StoredRankingRunSummary | null> {
    const row = await this.#prisma.rankingRun.findUnique({
      where: { rankingRunId },
      select: { rankingRunId: true, rankingRunSha256: true },
    });
    return row === null ? null : { rankingRunId: row.rankingRunId, rankingRunSha256: row.rankingRunSha256 };
  }

  public async insertRun(run: RankingRunRow, results: readonly RankingResultRow[]): Promise<void> {
    try {
      await this.#prisma.$transaction(async (tx) => {
        await tx.rankingRun.create({ data: { ...run } });
        if (results.length === 0) return;
        await tx.rankingResult.createMany({
          data: results.map((result) => ({
            ...result,
            compositeScore: result.compositeScore === null ? null : new Prisma.Decimal(result.compositeScore),
          })),
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new RankingEvidenceUniqueViolationError(error.message);
      }
      throw error;
    }
  }
}

/**
 * The ONE sanctioned, production entry point for a Prisma-backed
 * `StrategyRankingRepository`. Takes ONLY a `PrismaClient`: the authority
 * verifier is always the ranking engine's own real `isAuthoritativeRankingRun`
 * / `isAuthoritativeRankingRunSet` (imported statically above), and the store
 * implementation is the private `PrismaEvidenceStore` declared above, never
 * exported on its own. There is no parameter, anywhere, through which a
 * caller can substitute either half and still reach the real database.
 */
export function createStrategyRankingRepository(prisma: PrismaClient): StrategyRankingRepository {
  return new StrategyRankingRepository(
    new PrismaEvidenceStore(prisma),
    { isAuthoritativeRankingRun, isAuthoritativeRankingRunSet },
  );
}

// Pin CommonJS entry point to the lexical implementation. This also prevents
// pre-import replacement through an already-loaded repo namespace.
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  if (Object.getOwnPropertyDescriptor(module.exports, 'createStrategyRankingRepository')?.configurable !== false) {
    Object.defineProperty(module.exports, 'createStrategyRankingRepository', { get: () => createStrategyRankingRepository, configurable: false });
  }
}
