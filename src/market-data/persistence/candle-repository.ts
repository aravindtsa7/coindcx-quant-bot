import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../persistence/prisma';
import { CanonicalDecimal } from '../canonical-decimal';
import { CanonicalCandleConflictError, CanonicalCandleError } from '../errors';
import { areCanonicalCandlesIdentical, createCanonicalCandle1m } from '../models';
import { CanonicalCandle1m, CanonicalCandleSource } from '../types';

export type InsertCandleOutcome = 'INSERTED' | 'ALREADY_IDENTICAL';

export interface InsertCandleResult {
  readonly outcome: InsertCandleOutcome;
}

export interface Candle1mRepository {
  insertCandle(candle: CanonicalCandle1m): Promise<InsertCandleResult>;
  getLatestCanonicalCandle(pair: string): Promise<CanonicalCandle1m | null>;
  getCandle(pair: string, openTimeMs: number): Promise<CanonicalCandle1m | null>;
}

/**
 * Production MySQL repository enforcing strict insert-only immutability.
 * Invariants:
 * - Insert-only: no normal UPDATE path.
 * - Explicit outcome: INSERTED vs ALREADY_IDENTICAL.
 * - Duplicate unique key:
 *   - If existing row is identical in OHLCV: idempotent success returning ALREADY_IDENTICAL.
 *   - If existing row differs: CanonicalCandleConflictError (fail-closed, never overwrite).
 * - Persist-before-publish safety barrier.
 */
export class PrismaCandle1mRepository implements Candle1mRepository {
  readonly #prisma: PrismaClient;

  constructor(prismaClient: PrismaClient = defaultPrisma) {
    this.#prisma = prismaClient;
  }

  public async insertCandle(candle: CanonicalCandle1m): Promise<InsertCandleResult> {
    const data: Prisma.Candle1mCreateInput = {
      pair: candle.pair,
      openTimeMs: BigInt(candle.openTimeMs),
      closeTimeMs: BigInt(candle.closeTimeExclusiveMs),
      open: new Prisma.Decimal(candle.open.value),
      high: new Prisma.Decimal(candle.high.value),
      low: new Prisma.Decimal(candle.low.value),
      close: new Prisma.Decimal(candle.close.value),
      volume: new Prisma.Decimal(candle.volume.value),
      quoteVolume: candle.quoteVolume !== null ? new Prisma.Decimal(candle.quoteVolume.value) : null,
      source: candle.source,
      providerEventTimeMs: candle.providerEventTimeMs !== null ? BigInt(candle.providerEventTimeMs) : null,
      generationId: candle.generationId,
      finalizedAt: new Date(candle.finalizedAtMs),
    };

    try {
      await this.#prisma.candle1m.create({ data });
      return { outcome: 'INSERTED' };
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Unique constraint violation: check whether existing row is identical or conflicting
        const existing = await this.getCandle(candle.pair, candle.openTimeMs);
        if (existing && areCanonicalCandlesIdentical(existing, candle)) {
          // Idempotent duplicate: safe no-op
          return { outcome: 'ALREADY_IDENTICAL' };
        }

        throw new CanonicalCandleConflictError(
          `Canonical candle conflict for ${candle.pair} at openTime ${candle.openTimeMs}: incoming candle materially differs from persisted canonical truth`
        );
      }

      const msg = err instanceof Error ? err.message : String(err);
      throw new CanonicalCandleError(`Failed to persist canonical candle to database: ${msg}`);
    }
  }

  public async getLatestCanonicalCandle(pair: string): Promise<CanonicalCandle1m | null> {
    const row = await this.#prisma.candle1m.findFirst({
      where: { pair },
      orderBy: { openTimeMs: 'desc' },
    });

    if (!row) return null;
    return this.#mapRowToCanonicalCandle(row);
  }

  public async getCandle(pair: string, openTimeMs: number): Promise<CanonicalCandle1m | null> {
    const row = await this.#prisma.candle1m.findUnique({
      where: {
        pair_openTimeMs: {
          pair,
          openTimeMs: BigInt(openTimeMs),
        },
      },
    });

    if (!row) return null;
    return this.#mapRowToCanonicalCandle(row);
  }

  #mapRowToCanonicalCandle(row: {
    pair: string;
    openTimeMs: bigint;
    closeTimeMs: bigint;
    open: Prisma.Decimal;
    high: Prisma.Decimal;
    low: Prisma.Decimal;
    close: Prisma.Decimal;
    volume: Prisma.Decimal;
    quoteVolume: Prisma.Decimal | null;
    source: string;
    providerEventTimeMs: bigint | null;
    generationId: number | null;
    finalizedAt: Date;
  }): CanonicalCandle1m {
    return createCanonicalCandle1m({
      pair: row.pair,
      openTimeMs: Number(row.openTimeMs),
      open: CanonicalDecimal.from(row.open.toString()),
      high: CanonicalDecimal.from(row.high.toString()),
      low: CanonicalDecimal.from(row.low.toString()),
      close: CanonicalDecimal.from(row.close.toString()),
      volume: CanonicalDecimal.from(row.volume.toString()),
      quoteVolume: row.quoteVolume !== null ? CanonicalDecimal.from(row.quoteVolume.toString()) : null,
      source: row.source as CanonicalCandleSource,
      finalizedAtMs: row.finalizedAt.getTime(),
      providerEventTimeMs: row.providerEventTimeMs !== null ? Number(row.providerEventTimeMs) : null,
      generationId: row.generationId,
    });
  }
}
