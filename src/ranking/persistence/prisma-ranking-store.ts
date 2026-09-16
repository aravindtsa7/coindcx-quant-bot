import { Prisma, PrismaClient } from '@prisma/client';
import type { RankingEvidenceStore, RankingResultRow, RankingRunRow, StoredRankingRunSummary } from './ranking-repository';

/**
 * MySQL-backed `RankingEvidenceStore`.
 *
 * The Prisma client is always injected - this module never constructs or
 * imports the process-wide singleton, so importing Phase15 never opens a
 * database connection.
 *
 * `insertRun` writes the run and its result rows inside one interactive
 * transaction, so a crash can never leave a `ranking_run` header without its
 * evidence rows. Every decimal crosses the boundary as a canonical fixed-point
 * string wrapped in `Prisma.Decimal`; no JS float is ever persisted.
 */
export class PrismaRankingEvidenceStore implements RankingEvidenceStore {
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
  }
}
