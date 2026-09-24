import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { LiveExecutionError } from '../../../../../src/execution/live/errors';
import {
  CLAIM_GENERATION_MAX_ATTEMPTS,
  PrismaLiveReconciliationRepository,
  isRetryableTransactionConflict,
} from '../../../../../src/execution/live/reconciliation/repository';
import { LiveReconciliationService, resolveOrphanCleanupPolicy } from '../../../../../src/execution/live/reconciliation';
import { newLiveRuntimeIdentity } from '../../../../../src/execution/live/reconciliation/barrier';
import { InMemoryLiveExecutionRepository } from '../helpers';
import { ACCOUNT, FakeEvidenceProvider, FakeOrphanCancellation, FixedClock, evidenceSet, venueOrder } from './helpers';

// [Wave C3.1 / F18-44] `claimGeneration` retries its WHOLE transaction, and
// only on Prisma's `P2034` (the deadlock-victim / write-conflict error MySQL
// surfaces as), at most CLAIM_GENERATION_MAX_ATTEMPTS times in total. These
// tests drive the real repository against a scripted Prisma client, so every
// branch is deterministic and no database or sleep is involved. The real-MySQL
// deadlock itself is reproduced in the Phase18 DB suite ([C3.1-1], [C3-11c]).

function prismaError(code: string, message = `simulated ${code}`): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });
}

const deadlock = () => prismaError('P2034', 'Transaction failed due to a write conflict or a deadlock. Please retry your transaction');

interface StateRowFixture {
  readonly accountId: string;
  readonly status: string;
  readonly currentGeneration: number;
  readonly currentRunId: string | null;
  readonly currentRuntimeEpoch: string | null;
  readonly healthyGeneration: number | null;
  readonly lastEvaluatedAtMs: bigint | null;
  readonly blockingFindingCount: number;
  readonly revision: number;
}

function stateRow(overrides: Partial<StateRowFixture> = {}): StateRowFixture {
  return {
    accountId: ACCOUNT, status: 'RECONCILIATION_REQUIRED', currentGeneration: 0, currentRunId: null,
    currentRuntimeEpoch: null, healthyGeneration: null, lastEvaluatedAtMs: null, blockingFindingCount: 0, revision: 0,
    ...overrides,
  };
}

/**
 * A Prisma client whose every `$transaction` call opens a NEW scripted
 * transaction object. `attempts[i]` decides what attempt i does: which state
 * row it reads, and whether its run INSERT fails (as MySQL's deadlock victim
 * does) or succeeds.
 */
function scriptedClient(attempts: readonly { readonly state: StateRowFixture; readonly insert: 'ok' | Error }[], transactionError?: () => Error) {
  const record = {
    transactions: [] as object[],
    stateReads: 0,
    runInserts: [] as { runId: string; generation: number }[],
    loadStateCalls: 0,
  };
  const client = {
    liveReconciliationState: {
      upsert: async () => ({}),
      findUnique: async () => { record.loadStateCalls += 1; return stateRow({ status: 'RUNNING', currentGeneration: 7, currentRunId: 'winner', currentRuntimeEpoch: 'e', revision: 3 }); },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      if (transactionError !== undefined) throw transactionError();
      const index = record.transactions.length;
      const script = attempts[index];
      if (script === undefined) throw new Error(`unscripted transaction attempt ${index + 1}`);
      const tx = {
        $executeRaw: async () => 1,
        liveReconciliationState: {
          findUnique: async () => { record.stateReads += 1; return script.state; },
          update: async ({ data }: { data: { currentGeneration: number; currentRunId: string; currentRuntimeEpoch: string } }) => stateRow({
            status: 'RUNNING', currentGeneration: data.currentGeneration, currentRunId: data.currentRunId,
            currentRuntimeEpoch: data.currentRuntimeEpoch, revision: script.state.revision + 1,
          }),
        },
        liveReconciliationRun: {
          updateMany: async () => ({ count: 0 }),
          create: async ({ data }: { data: { runId: string; generation: number } }) => {
            record.runInserts.push({ runId: data.runId, generation: data.generation });
            if (script.insert !== 'ok') throw script.insert;
            return data;
          },
        },
      };
      record.transactions.push(tx);
      return callback(tx);
    },
  };
  return { repository: new PrismaLiveReconciliationRepository(client as unknown as PrismaClient), record };
}

describe('[F18-44] only a Prisma P2034 transaction conflict is retryable', () => {
  it('classifies P2034 as retryable', () => {
    expect(isRetryableTransactionConflict(deadlock())).toBe(true);
  });

  it.each([
    ['P2002 unique violation (another worker won the generation)', prismaError('P2002')],
    ['P2028 transaction API error', prismaError('P2028')],
    ['P1001 database unreachable', prismaError('P1001')],
    ['P2025 record not found', prismaError('P2025')],
    ['a LiveExecutionError stale generation', new LiveExecutionError('LIVE_RECONCILIATION_STALE_GENERATION', 'stale')],
    ['a plain Error that merely mentions a deadlock', new Error('Transaction failed due to a write conflict or a deadlock')],
    ['a look-alike object carrying code P2034', { code: 'P2034', message: 'deadlock' }],
    ['null', null],
  ])('does not retry %s', (_label, error) => {
    expect(isRetryableTransactionConflict(error)).toBe(false);
  });

  it('allows the first attempt plus at most two retries', () => {
    expect(CLAIM_GENERATION_MAX_ATTEMPTS).toBe(3);
  });
});

describe('[F18-44] claimGeneration retries the whole transaction in a fresh transaction', () => {
  it('a deadlock victim retries once and claims from state re-read in the NEW transaction', async () => {
    // Attempt 1 reads generation 0 and loses the deadlock. Before attempt 2,
    // another writer has advanced the account to generation 4: the retry must
    // claim 5, proving nothing from the rolled-back attempt is reused.
    const { repository, record } = scriptedClient([
      { state: stateRow({ currentGeneration: 0, revision: 0 }), insert: deadlock() },
      { state: stateRow({ currentGeneration: 4, revision: 9 }), insert: 'ok' },
    ]);
    const outcome = await repository.claimGeneration(ACCOUNT, newLiveRuntimeIdentity(), 1_000);

    expect(outcome.kind).toBe('CLAIMED');
    if (outcome.kind !== 'CLAIMED') return;
    expect(outcome.lease.generation).toBe(5);
    expect(record.transactions).toHaveLength(2);
    expect(record.transactions[0]).not.toBe(record.transactions[1]);
    expect(record.stateReads).toBe(2);
    expect(record.runInserts.map((insert) => insert.generation)).toEqual([1, 5]);
    expect(record.runInserts[0]!.runId).not.toBe(record.runInserts[1]!.runId);
    expect(outcome.lease.runId).toBe(record.runInserts[1]!.runId);
  });

  it('fails closed after exhausting the budget, keeping the final Prisma error as the cause', async () => {
    const errors = [deadlock(), deadlock(), deadlock()];
    const { repository, record } = scriptedClient(errors.map((error) => ({ state: stateRow(), insert: error })));
    const failure = await repository.claimGeneration(ACCOUNT, newLiveRuntimeIdentity(), 1_000).then(
      () => { throw new Error('expected the claim to fail'); },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(LiveExecutionError);
    expect((failure as LiveExecutionError).code).toBe('LIVE_PERSISTENCE_FAULT');
    expect((failure as LiveExecutionError).details).toMatchObject({ accountId: ACCOUNT, attempts: 3, prismaCode: 'P2034' });
    expect((failure as Error).cause).toBe(errors[2]);
    expect(record.transactions).toHaveLength(CLAIM_GENERATION_MAX_ATTEMPTS);
    expect(record.loadStateCalls).toBe(0);
  });

  it.each([
    ['a stale-generation domain error', () => new LiveExecutionError('LIVE_RECONCILIATION_STALE_GENERATION', 'stale')],
    ['an unknown error', () => new Error('boom')],
    ['a Prisma connection error', () => prismaError('P1001')],
    ['a Prisma transaction API error', () => prismaError('P2028')],
  ])('never retries %s: one attempt, the same error propagates', async (_label, makeError) => {
    const thrown: Error[] = [];
    const { repository } = scriptedClient([], () => { const error = makeError(); thrown.push(error); return error; });
    const failure = await repository.claimGeneration(ACCOUNT, newLiveRuntimeIdentity(), 1_000).then(
      () => { throw new Error('expected the claim to fail'); },
      (error: unknown) => error,
    );
    expect(thrown).toHaveLength(1);
    expect(failure).toBe(thrown[0]);
  });

  it('a non-retryable error inside the transaction body is not retried either', async () => {
    const { repository, record } = scriptedClient([
      { state: stateRow(), insert: new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'not a conflict') },
    ]);
    await expect(repository.claimGeneration(ACCOUNT, newLiveRuntimeIdentity(), 1_000)).rejects.toThrow(/not a conflict/);
    expect(record.transactions).toHaveLength(1);
  });

  it('a lost generation race (P2002) still reports LOST after one attempt and is never retried into a win', async () => {
    const { repository, record } = scriptedClient([{ state: stateRow(), insert: prismaError('P2002') }]);
    const outcome = await repository.claimGeneration(ACCOUNT, newLiveRuntimeIdentity(), 1_000);
    expect(outcome.kind).toBe('LOST');
    expect(record.transactions).toHaveLength(1);
    expect(record.loadStateCalls).toBe(1);
  });

  it('a P2002 on the retry attempt is still LOST, not a second retry', async () => {
    const { repository, record } = scriptedClient([
      { state: stateRow(), insert: deadlock() },
      { state: stateRow(), insert: prismaError('P2002') },
    ]);
    expect((await repository.claimGeneration(ACCOUNT, newLiveRuntimeIdentity(), 1_000)).kind).toBe('LOST');
    expect(record.transactions).toHaveLength(2);
  });

  it('refuses a forged runtime identity before any transaction, exactly as before', async () => {
    const { repository, record } = scriptedClient([]);
    await expect(repository.claimGeneration(ACCOUNT, { epoch: 'forged' }, 1_000)).rejects.toThrow(/LIVE_RECONCILIATION_REQUIRED/);
    expect(record.transactions).toHaveLength(0);
  });
});

describe('[F18-44] an exhausted claim happens before any evidence read or wire action', () => {
  it('reconcileAccount fails closed with zero evidence reads and zero orphan cancels', async () => {
    const { repository } = scriptedClient([0, 1, 2].map(() => ({ state: stateRow(), insert: deadlock() })));
    const provider = new FakeEvidenceProvider(evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'stranger-1' })] }));
    const port = new FakeOrphanCancellation({ kind: 'CANCELLED' });
    const policy = resolveOrphanCleanupPolicy({ LIVE_ORPHAN_CANCELLATION_ENABLED: 'true', LIVE_ORPHAN_CANCELLATION_ACCOUNT_ALLOWLIST: ACCOUNT });
    if (policy.status !== 'ENABLED') throw new Error('expected enabled policy');
    const service = new LiveReconciliationService({
      repository, executionRepository: new InMemoryLiveExecutionRepository(), evidenceProvider: provider,
      runtimeIdentity: newLiveRuntimeIdentity(), credentialAccountId: ACCOUNT, clock: new FixedClock(),
      orphanPolicy: policy.policy, orphanCancellation: port,
    });

    await expect(service.reconcileAccount(ACCOUNT)).rejects.toThrow(/LIVE_PERSISTENCE_FAULT/);
    expect(provider.calls).toBe(0);
    expect(port.attempts).toEqual([]);
  });
});
