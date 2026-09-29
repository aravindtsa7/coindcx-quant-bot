import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PrismaLiveExecutionRepository } from '../../../../src/execution/live/repository';
import { newLiveRuntimeIdentity, readLiveRuntimeEpoch } from '../../../../src/execution/live/reconciliation/barrier';
import { LiveReconciliationAuthorization, PrismaLiveReconciliationRepository } from '../../../../src/execution/live/reconciliation/repository';

// [P18B Stage 1B2 Wave 2A] The PUBLIC strict Tier-A cancel methods still run
// the HEALTHY reconciliation fence FIRST, inside their own transaction, and
// refuse before touching any live_order / live_execution_intent row. No
// database: a recording transaction double shows exactly which statements ran,
// in which order. (The recording double does NOT carry the explicit
// LIVE_EXECUTION_TEST_TRANSACTION bypass marker, so the production fence runs.)

const ACCOUNT = 'account-w2a-unit';
const INTENT = 'i'.repeat(64);

interface Recording {
  readonly prisma: PrismaClient;
  readonly calls: string[];
}

/** A transaction double that records every statement; `fenceRow` is what the fence's locking read returns. */
function recordingPrisma(fenceRow: Record<string, unknown> | null): Recording {
  const calls: string[] = [];
  const sql = (strings: TemplateStringsArray): string => strings.join('?').replace(/\s+/g, ' ').trim();
  const delegate = (table: string) => new Proxy({}, {
    get: (_target, operation) => async () => {
      calls.push(`${table}.${String(operation)}`);
      return null;
    },
  });
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      calls.push(`$queryRaw ${sql(strings)}`);
      return fenceRow === null ? [] : [fenceRow];
    },
    $executeRaw: async (strings: TemplateStringsArray) => {
      calls.push(`$executeRaw ${sql(strings)}`);
      return 1;
    },
    liveOrder: delegate('liveOrder'),
    liveExecutionIntent: delegate('liveExecutionIntent'),
  };
  const prisma = { $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx) } as unknown as PrismaClient;
  return { prisma, calls };
}

/** A GENUINE repository-issued HEALTHY authorization (minted through the real issuer over a stub read). */
async function genuineAuthorization(): Promise<{ readonly authorization: unknown; readonly row: Record<string, unknown> }> {
  const identity = newLiveRuntimeIdentity();
  const row = {
    accountId: ACCOUNT, status: 'HEALTHY', currentGeneration: 1, currentRunId: 'run-w2a', currentRuntimeEpoch: readLiveRuntimeEpoch(identity),
    healthyGeneration: 1, lastEvaluatedAtMs: null, blockingFindingCount: 0, revision: 1,
  };
  const client = { liveReconciliationState: { findUnique: async () => row } } as unknown as PrismaClient;
  const outcome = await new PrismaLiveReconciliationRepository(client).authorizeCurrentHealthy(ACCOUNT, identity);
  if (outcome.authorization === null) throw new Error('fixture: no genuine authorization');
  return { authorization: outcome.authorization, row };
}

type CancelCall = (repository: PrismaLiveExecutionRepository, authorization: unknown) => Promise<unknown>;
const PUBLIC_CANCEL_METHODS: readonly (readonly [string, CancelCall])[] = [
  ['claimCancel', (repository, authorization) => repository.claimCancel(INTENT, ACCOUNT, authorization)],
  ['armCancelWire', (repository, authorization) => repository.armCancelWire(INTENT, 3, authorization)],
  ['completeCancelAttempt', (repository, authorization) => repository.completeCancelAttempt(INTENT, 1, 'ACKNOWLEDGED', null, authorization)],
];

describe('the public strict cancel methods refuse BEFORE any statement without genuine authority', () => {
  it.each(PUBLIC_CANCEL_METHODS)('%s: a missing or structural authorization runs zero statements', async (_name, call) => {
    const { authorization } = await genuineAuthorization();
    for (const refused of [undefined, null, { ...LiveReconciliationAuthorization.read(authorization) }, Object.create(LiveReconciliationAuthorization.prototype)]) {
      const { prisma, calls } = recordingPrisma(null);
      await expect(call(new PrismaLiveExecutionRepository(prisma), refused)).rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED' });
      expect(calls).toEqual([]);
    }
  });

  it.each(PUBLIC_CANCEL_METHODS)('%s: a genuine but superseded authorization runs ONLY the fence read, never a live_order lock', async (_name, call) => {
    const { authorization, row } = await genuineAuthorization();
    for (const superseded of [{ ...row, currentGeneration: 2 }, { ...row, status: 'RUNNING' }, { ...row, revision: 2 }, { ...row, blockingFindingCount: 1 }]) {
      const { prisma, calls } = recordingPrisma(superseded);
      await expect(call(new PrismaLiveExecutionRepository(prisma), authorization)).rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_STALE_GENERATION' });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/^\$queryRaw SELECT .* FROM live_reconciliation_state WHERE account_id = \? FOR UPDATE$/);
    }
  });
});

describe('with genuine current authority the fence still runs FIRST, then the extracted primitive', () => {
  it.each(PUBLIC_CANCEL_METHODS)('%s: fence locking read -> [2B2a interlock: same locks, verified read] -> the primitive (same order)', async (name, call) => {
    const { authorization, row } = await genuineAuthorization();
    const { prisma, calls } = recordingPrisma(row);
    // The recording double has no durable order, so the interlock's verified read finds none (no guard read), and
    // the primitive stops at its own verified read; the ORDER is what is proven.
    await expect(call(new PrismaLiveExecutionRepository(prisma), authorization)).rejects.toMatchObject({
      code: name === 'claimCancel' ? 'LIVE_INTENT_INVALID' : 'LIVE_PERSISTENCE_FAULT',
    });
    expect(calls[0]).toMatch(/^\$queryRaw SELECT .* FROM live_reconciliation_state WHERE account_id = \? FOR UPDATE$/);
    const lockOrder = '$executeRaw SELECT intent_id FROM live_order WHERE intent_id = ? FOR UPDATE';
    const lockIntent = '$executeRaw SELECT intent_id FROM live_execution_intent WHERE intent_id = ? FOR UPDATE';
    if (name === 'claimCancel') {
      // Interlock: live_order lock + verified read; then the claim (unchanged): live_order lock + verified read.
      expect(calls.slice(1)).toEqual([lockOrder, 'liveOrder.findUnique', lockOrder, 'liveOrder.findUnique']);
    } else {
      // Interlock: live_order, live_execution_intent, verified read; then the primitive (unchanged): the same order.
      expect(calls.slice(1)).toEqual([lockOrder, lockIntent, 'liveOrder.findUnique', lockOrder, lockIntent, 'liveOrder.findUnique']);
    }
    // No practical lock and no practical read happened without a durable order.
    expect(calls.some((statement) => statement.includes('live_practical'))).toBe(false);
  });
});
