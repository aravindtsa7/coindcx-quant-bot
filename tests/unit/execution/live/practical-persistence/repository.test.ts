import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { mintPracticalManualReviewResolution, transitionPracticalAccountState } from '../../../../../src/execution/live/practical/state-machine';
import {
  PRACTICAL_TRANSACTION_MAX_ATTEMPTS,
  PrismaPracticalSafetyRepository,
} from '../../../../../src/execution/live/practical-persistence/repository';

// No database: a minimal fake client proves how the repository maps what the
// driver returns, and above all that a FAILED read never becomes NOT_FOUND.

type QueryRaw = (query: unknown) => Promise<unknown>;

function fakeClient(queryRaw: QueryRaw, onTransaction?: () => void): { client: PrismaClient; transactions: () => number } {
  let transactions = 0;
  const tx = { $queryRaw: queryRaw };
  const client = {
    $transaction: async (work: (transaction: unknown) => Promise<unknown>) => {
      transactions += 1;
      onTransaction?.();
      return work(tx);
    },
  };
  return { client: client as unknown as PrismaClient, transactions: () => transactions };
}

const knownError = (code: string) => new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, { code, clientVersion: 'test' });

describe('NOT_FOUND is only a successful zero-row read', () => {
  it('zero rows for the state and fence -> NOT_FOUND', async () => {
    const { client } = fakeClient(async () => []);
    expect(await new PrismaPracticalSafetyRepository(client).loadAccount('account-live-1')).toEqual({ kind: 'NOT_FOUND' });
  });

  it('a failing query rejects: it is never NOT_FOUND and never MALFORMED', async () => {
    const { client } = fakeClient(async () => { throw new Error('connection reset'); });
    await expect(new PrismaPracticalSafetyRepository(client).loadAccount('account-live-1')).rejects.toThrow('connection reset');
    await expect(new PrismaPracticalSafetyRepository(client).loadCertificate('c'.repeat(64))).rejects.toThrow('connection reset');
    await expect(new PrismaPracticalSafetyRepository(client).loadLease('lease-1')).rejects.toThrow('connection reset');
  });

  it('a driver result that is not a row list, a [undefined] row, or duplicate rows -> MALFORMED, never NOT_FOUND', async () => {
    for (const result of [undefined, null, {}, [undefined], [{}, {}]]) {
      const { client } = fakeClient(async () => result);
      const load = await new PrismaPracticalSafetyRepository(client).loadAccount('account-live-1').catch((error: unknown) => error);
      if (load instanceof Error) {
        expect(load.message, JSON.stringify(result)).toMatch(/PRACTICAL_PERSISTENCE_MALFORMED/);
      } else {
        expect(load, JSON.stringify(result)).toMatchObject({ kind: 'MALFORMED' });
      }
    }
  });

  it('an operation on an absent account is a typed NOT_FOUND error, never an implicit create', async () => {
    const { client } = fakeClient(async () => []);
    await expect(new PrismaPracticalSafetyRepository(client).invalidate({ accountId: 'account-live-1', reason: 'WS_DISCONNECTED', nowMs: 1 }))
      .rejects.toThrow(/PRACTICAL_PERSISTENCE_NOT_FOUND/);
  });
});

describe('input validation happens before any durable access', () => {
  it.each([
    ['padded account id', (repository: PrismaPracticalSafetyRepository) => repository.loadAccount(' account-live-1')],
    ['over-long account id', (repository: PrismaPracticalSafetyRepository) => repository.loadAccount('a'.repeat(129))],
    ['uppercase certificate id', (repository: PrismaPracticalSafetyRepository) => repository.loadCertificate('C'.repeat(64))],
    ['non-digest certificate id', (repository: PrismaPracticalSafetyRepository) => repository.loadCertificate('certificate-1')],
    ['uppercase certificate id to revoke', (repository: PrismaPracticalSafetyRepository) => repository.revokeCertificate({ accountId: 'a', certificateId: 'C'.repeat(64), reason: 'WS_DISCONNECTED', nowMs: 1 })],
    ['uppercase certificate id to expire', (repository: PrismaPracticalSafetyRepository) => repository.expireCertificate({ accountId: 'a', certificateId: 'C'.repeat(64), trustedNowMs: 1 })],
    ['untyped reason', (repository: PrismaPracticalSafetyRepository) => repository.invalidate({ accountId: 'a', reason: 'BECAUSE' as never, nowMs: 1 })],
    ['negative time', (repository: PrismaPracticalSafetyRepository) => repository.invalidate({ accountId: 'a', reason: 'WS_DISCONNECTED', nowMs: -1 })],
    ['quarantine-severity manual review', (repository: PrismaPracticalSafetyRepository) => repository.enterManualReview({ accountId: 'a', reason: 'WS_DISCONNECTED', nowMs: 1 })],
    ['unknown outcome', (repository: PrismaPracticalSafetyRepository) => repository.releaseLease({
      accountId: 'a', expected: { accountId: 'a', runtimeEpoch: 'e', reconciliationGeneration: 1, revision: 1 }, leaseId: 'l', outcome: 'SUCCESS' as never, nowMs: 1,
    })],
    ['expectation for another account', (repository: PrismaPracticalSafetyRepository) => repository.startCertification({
      accountId: 'a', expected: { accountId: 'b', runtimeEpoch: 'e', reconciliationGeneration: 0, revision: 0 }, runId: 'r', nowMs: 1,
    })],
    ['unknown certification failure', (repository: PrismaPracticalSafetyRepository) => repository.failCertification({
      accountId: 'a', expected: { accountId: 'a', runtimeEpoch: 'e', reconciliationGeneration: 0, revision: 0 }, runId: 'r', resultingGeneration: 1, failure: { kind: 'OOPS' } as never, nowMs: 1,
    })],
  ])('%s is refused with zero queries', async (_label, operation) => {
    const { client, transactions } = fakeClient(async () => { throw new Error('must not be reached'); });
    await expect(operation(new PrismaPracticalSafetyRepository(client))).rejects.toThrow(/PRACTICAL_PERSISTENCE_INVALID_INPUT/);
    expect(transactions()).toBe(0);
  });

  it('OPEN / CLOSE and forged certificates are refused before any durable access', async () => {
    const { client, transactions } = fakeClient(async () => []);
    const repository = new PrismaPracticalSafetyRepository(client);
    const expected = { accountId: 'a', runtimeEpoch: 'e', reconciliationGeneration: 1, revision: 2 };
    await expect(repository.consumeCertificateAndLease({ accountId: 'a', expected, certificate: {}, leaseId: 'l', action: 'OPEN', trustedNowMs: 1 }))
      .rejects.toThrow(/PRACTICAL_ACTION_NOT_PERMITTED/);
    await expect(repository.consumeCertificateAndLease({ accountId: 'a', expected, certificate: { certificateId: 'c'.repeat(64) }, leaseId: 'l', action: 'CANCEL', trustedNowMs: 1 }))
      .rejects.toThrow(/genuine Stage 1A practical recovery certificate/);
    await expect(repository.finishCertification({ accountId: 'a', expected, runId: 'r', resultingGeneration: 3, certificate: {}, nowMs: 1 }))
      .rejects.toThrow(/genuine Stage 1A practical recovery certificate/);
    await expect(repository.resolveManualReview({ accountId: 'a', resolution: { accountId: 'a', reviewEpisodeId: 'e' }, nowMs: 1 }))
      .rejects.toThrow(/PRACTICAL_AUTHORITY_INVALID/);
    expect(transactions()).toBe(0);
  });
});

describe('exact identity under the case-insensitive collation', () => {
  const leaseRow = (leaseId: string) => ({
    leaseId, accountId: 'account-live-1', certificateId: 'c'.repeat(64), action: 'CANCEL', intentId: null, clientOrderId: null,
    runtimeEpoch: 'epoch-a', reconciliationGeneration: 1, createdAtMs: 10n, armedAtMs: null, completedAtMs: null, status: 'LEASED', outcome: null,
  });

  it('loadLease returns FOUND only for the exactly spelled key', async () => {
    const { client } = fakeClient(async () => [leaseRow('lease-1')]);
    expect(await new PrismaPracticalSafetyRepository(client).loadLease('lease-1')).toMatchObject({ kind: 'FOUND', record: { leaseId: 'lease-1' } });
  });

  it('a row matched only case-insensitively is refused: never FOUND, never NOT_FOUND', async () => {
    // What MySQL utf8mb4_unicode_ci returns for WHERE lease_id = 'LEASE-1' when only 'lease-1' exists.
    const { client } = fakeClient(async () => [leaseRow('lease-1')]);
    await expect(new PrismaPracticalSafetyRepository(client).loadLease('LEASE-1')).rejects.toThrow(/PRACTICAL_PERSISTENCE_CONFLICT/);
  });
});

describe('transaction retry is narrow', () => {
  it('a deadlock (P2034) is retried in a fresh transaction, then fails closed with FAULT', async () => {
    const { client, transactions } = fakeClient(async () => [], () => { throw knownError('P2034'); });
    await expect(new PrismaPracticalSafetyRepository(client).loadAccount('account-live-1')).rejects.toThrow(/PRACTICAL_PERSISTENCE_FAULT/);
    expect(transactions()).toBe(PRACTICAL_TRANSACTION_MAX_ATTEMPTS);
  });

  it('a raw-query deadlock (P2010 carrying MySQL 1213, as real MySQL reports it) is retried too', async () => {
    const deadlock = new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `1213`.', { code: 'P2010', clientVersion: 'test', meta: { code: '1213', message: 'Deadlock found' } });
    const { client, transactions } = fakeClient(async () => [], () => { throw deadlock; });
    await expect(new PrismaPracticalSafetyRepository(client).loadAccount('account-live-1')).rejects.toThrow(/PRACTICAL_PERSISTENCE_FAULT/);
    expect(transactions()).toBe(PRACTICAL_TRANSACTION_MAX_ATTEMPTS);
  });

  it('any other error is never retried (including a raw-query failure that is not a deadlock)', async () => {
    const otherRawFailure = new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `1146`.', { code: 'P2010', clientVersion: 'test', meta: { code: '1146', message: 'Table does not exist' } });
    for (const error of [knownError('P2002'), new Error('boom'), otherRawFailure]) {
      const { client, transactions } = fakeClient(async () => [], () => { throw error; });
      await expect(new PrismaPracticalSafetyRepository(client).invalidate({ accountId: 'a', reason: 'WS_DISCONNECTED', nowMs: 1 })).rejects.toBe(error);
      expect(transactions()).toBe(1);
    }
  });

  it('resolving a manual review IS retried on a deadlock, and a failed attempt never consumes the one-shot resolution', async () => {
    const { client, transactions } = fakeClient(async () => [], () => { throw knownError('P2034'); });
    const resolution = mintPracticalManualReviewResolution({ accountId: 'a', reviewEpisodeId: 'e', resolutionId: 'r', assertedBy: 'x', note: 'n' });
    await expect(new PrismaPracticalSafetyRepository(client).resolveManualReview({ accountId: 'a', resolution, nowMs: 1 })).rejects.toThrow(/PRACTICAL_PERSISTENCE_FAULT/);
    expect(transactions()).toBe(PRACTICAL_TRANSACTION_MAX_ATTEMPTS);
    // Still unconsumed: the Stage 1A one-shot can still be spent exactly once.
    const next = transitionPracticalAccountState('MANUAL_REVIEW_REQUIRED', { kind: 'OPERATOR_RESOLUTION', accountId: 'a', reviewEpisodeId: 'e', resolution });
    expect(next).toBe('QUARANTINED');
    expect(() => transitionPracticalAccountState('MANUAL_REVIEW_REQUIRED', { kind: 'OPERATOR_RESOLUTION', accountId: 'a', reviewEpisodeId: 'e', resolution })).toThrow(/already used/);
  });
});
