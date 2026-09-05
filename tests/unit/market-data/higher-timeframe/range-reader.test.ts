import { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { CanonicalCandleError } from '../../../../src/market-data/errors';
import { PrismaCandle1mRepository } from '../../../../src/market-data/persistence/candle-repository';
import { BASE } from './helpers';

interface Row {
  pair: string; openTimeMs: bigint; closeTimeMs: bigint;
  open: Prisma.Decimal; high: Prisma.Decimal; low: Prisma.Decimal; close: Prisma.Decimal;
  volume: Prisma.Decimal; quoteVolume: Prisma.Decimal | null; source: string;
  providerEventTimeMs: bigint | null; generationId: number | null; finalizedAt: Date;
}
function row(openTimeMs: number, pair = 'PAIR-A', overrides: Partial<Row> = {}): Row {
  return {
    pair, openTimeMs: BigInt(openTimeMs), closeTimeMs: BigInt(openTimeMs + 60_000),
    open: new Prisma.Decimal('10'), high: new Prisma.Decimal('12'), low: new Prisma.Decimal('9'), close: new Prisma.Decimal('11'),
    volume: new Prisma.Decimal('1.25'), quoteVolume: new Prisma.Decimal('2.5'), source: 'WS_FINALIZED',
    providerEventTimeMs: null, generationId: 3, finalizedAt: new Date(openTimeMs + 60_000), ...overrides,
  };
}
function mock(rows: readonly Row[] = [], rejection: Error | null = null): { repo: PrismaCandle1mRepository; calls: unknown[] } {
  const calls: unknown[] = [];
  const client = {
    candle1m: {
      findMany: async (args: unknown): Promise<readonly Row[]> => {
        calls.push(args);
        if (rejection) throw rejection;
        return rows;
      },
    },
  } as unknown as PrismaClient;
  return { repo: new PrismaCandle1mRepository(client), calls };
}

describe('PrismaCandle1mRepository.getRange', () => {
  it('validates pair and exact safe inclusive minute boundaries before querying', async () => {
    const { repo, calls } = mock();
    for (const pair of ['', '   ']) await expect(repo.getRange(pair, BASE, BASE)).rejects.toThrow(CanonicalCandleError);
    for (const [from = Number.NaN, to = Number.NaN] of [[Number.NaN, BASE], [BASE, Number.MAX_SAFE_INTEGER], [BASE + 1, BASE], [BASE, BASE + 1], [BASE + 60_000, BASE]]) {
      await expect(repo.getRange('PAIR-A', from, to)).rejects.toThrow(CanonicalCandleError);
    }
    expect(calls).toEqual([]);
  });

  it('uses the exact pair, inclusive BigInt range, and ascending database order', async () => {
    const { repo, calls } = mock([row(BASE), row(BASE + 60_000)]);
    const result = await repo.getRange('PAIR-A', BASE, BASE + 60_000);
    expect(calls).toEqual([{ where: { pair: 'PAIR-A', openTimeMs: { gte: BigInt(BASE), lte: BigInt(BASE + 60_000) } }, orderBy: { openTimeMs: 'asc' } }]);
    expect(result.map((value) => value.openTimeMs)).toEqual([BASE, BASE + 60_000]);
    expect(result[0]).toMatchObject({ pair: 'PAIR-A', closeTimeExclusiveMs: BASE + 60_000, source: 'WS_FINALIZED', generationId: 3 });
    expect(result[0]?.volume.value).toBe('1.25');
    expect(result[0]?.quoteVolume?.value).toBe('2.5');
  });

  it('returns a valid empty range, rejects duplicate domain keys, and propagates DB and mapper failures', async () => {
    await expect(mock().repo.getRange('PAIR-A', BASE, BASE)).resolves.toEqual([]);
    await expect(mock([row(BASE), row(BASE)]).repo.getRange('PAIR-A', BASE, BASE)).rejects.toThrow('Duplicate canonical range row');
    await expect(mock([], new Error('database unavailable')).repo.getRange('PAIR-A', BASE, BASE)).rejects.toThrow('database unavailable');
    await expect(mock([row(BASE, 'PAIR-A', { source: 'NOT_A_CANONICAL_SOURCE' })]).repo.getRange('PAIR-A', BASE, BASE)).rejects.toThrow();
  });
});
