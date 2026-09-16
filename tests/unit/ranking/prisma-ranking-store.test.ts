import { describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { composeRankingRunSet } from '../../../src/ranking/core';
import { PrismaRankingEvidenceStore } from '../../../src/ranking/persistence/prisma-ranking-store';
import { toRankingResultRow, toRankingRunRow } from '../../../src/ranking/persistence/ranking-repository';
import { buildEvidence, runForPair } from './helpers';

// P15 §11 — the MySQL store adapter. Mocked client rather than a live database,
// matching the repository's existing Prisma-testing convention; the field
// names and types themselves are checked at compile time against the generated
// Prisma input types.

interface Recorded {
  readonly table: 'rankingRun' | 'rankingResult';
  readonly data: unknown;
}

function stubClient(existing: { readonly rankingRunId: string; readonly rankingRunSha256: string } | null) {
  const recorded: Recorded[] = [];
  let transactions = 0;
  const tx = {
    rankingRun: { create: (args: { data: unknown }) => { recorded.push({ table: 'rankingRun', data: args.data }); return Promise.resolve(undefined); } },
    rankingResult: { createMany: (args: { data: unknown }) => { recorded.push({ table: 'rankingResult', data: args.data }); return Promise.resolve(undefined); } },
  };
  const client = {
    rankingRun: {
      findUnique: () => Promise.resolve(existing),
      create: tx.rankingRun.create,
    },
    rankingResult: { createMany: tx.rankingResult.createMany },
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => { transactions += 1; return fn(tx); },
  };
  return { client: client as unknown as PrismaClient, recorded, transactionCount: () => transactions };
}

const RUN = runForPair(composeRankingRunSet([
  buildEvidence({ pair: 'BTC-INR', strategyId: 'EMA_TREND', metrics: { SHARPE: '3', MAX_DRAWDOWN: '5' } }),
  buildEvidence({ pair: 'BTC-INR', strategyId: 'GAPPY', metrics: { PARAMETER_ROBUSTNESS: null } }),
], []), 'BTC-INR');

describe('PrismaRankingEvidenceStore', () => {
  it('reports an absent run as null and an existing run by its content hash', async () => {
    expect(await new PrismaRankingEvidenceStore(stubClient(null).client).findRun('x')).toBeNull();
    const existing = { rankingRunId: RUN.rankingRunId, rankingRunSha256: RUN.rankingRunSha256 };
    expect(await new PrismaRankingEvidenceStore(stubClient(existing).client).findRun(RUN.rankingRunId)).toEqual(existing);
  });

  it('writes the run header and its result rows inside a single transaction', async () => {
    const stub = stubClient(null);
    await new PrismaRankingEvidenceStore(stub.client).insertRun(toRankingRunRow(RUN), RUN.results.map(toRankingResultRow));
    expect(stub.transactionCount()).toBe(1);
    expect(stub.recorded.map((entry) => entry.table)).toEqual(['rankingRun', 'rankingResult']);
  });

  it('wraps a ranked composite score in Prisma.Decimal and leaves an unrankable row null', async () => {
    const stub = stubClient(null);
    await new PrismaRankingEvidenceStore(stub.client).insertRun(toRankingRunRow(RUN), RUN.results.map(toRankingResultRow));
    const rows = stub.recorded.find((entry) => entry.table === 'rankingResult')?.data as readonly { status: string; compositeScore: unknown }[];
    const ranked = rows.find((row) => row.status === 'RANKED');
    const gap = rows.find((row) => row.status === 'INSUFFICIENT_RANKING_EVIDENCE');
    expect(ranked?.compositeScore).toBeInstanceOf(Prisma.Decimal);
    expect(String(ranked?.compositeScore)).toBe('1');
    expect(gap?.compositeScore).toBeNull();
  });

  it('skips the result write entirely when a run has no rows', async () => {
    const stub = stubClient(null);
    await new PrismaRankingEvidenceStore(stub.client).insertRun(toRankingRunRow(RUN), []);
    expect(stub.recorded.map((entry) => entry.table)).toEqual(['rankingRun']);
  });
});
