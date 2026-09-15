import { Prisma, type PrismaClient } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { RiskAdmissionCoordinator } from '../../../../src/dispatch/admission';
import type { AdmissionRequest } from '../../../../src/dispatch';
import * as persistenceBarrel from '../../../../src/execution/persistence';
import { PaperAccountRepository } from '../../../../src/execution/persistence/account-repository';
import { PaperAdmissionBridge, SESSION_PROOF } from '../../../../src/execution/persistence/admission-bridge';
import { PaperAccountKernel } from '../../../../src/execution/persistence/paper-account-kernel';
import { PaperAccountReconciler } from '../../../../src/execution/persistence/paper-account-reconciler';
import { openPaperAccountSession } from '../../../../src/execution/persistence/paper-account-session';
import { CoinDcxPaperEvidence, type PaperEvidenceInstrument } from '../../../../src/integration/coindcx/paper-evidence';
import { FakeCoinDcxSocketFactory } from '../../../../src/integration/coindcx/websocket/socket-adapter';
import { PaperAccountProductionComposer, type ProductionOpenParams } from '../../../../src/integration/coindcx/paper-production-runtime';
import { buildExecutionPolicySnapshot, EXECUTION_POLICY_VERSION, type ExecutionPolicySnapshot } from '../../../../src/execution';
import { wire as instrumentWire } from '../../coindcx/audit-a2-helpers';
import { buildContext, evaluateDecision, genuineResearchApproval, makeKernel, policyFor, productionRiskRequest } from '../../dispatch/helpers';
import { interceptProductionInstrumentAcquisition } from '../../../helpers/production-instrument-acquisition-harness';

// P14-D-BLK-01/MAJ-01 correction tests (Antigravity targeted-verify findings).
//
// A genuine MySQL "commit acknowledged but client saw an error" is
// impractical to reproduce deterministically (the correction mission
// explicitly does not require it â€” Â§9). What MUST be proven deterministically
// is that our own code treats ANY error occurring after
// `RiskAdmissionCoordinator.admit()`/`.release()` has already mutated
// in-memory state as outcome-ambiguous and fails closed, never as "rollback
// memory and continue". This suite injects a failure at exactly that point
// using a small, fully in-memory fake `PrismaClient` (no real DB needed) â€”
// the real, unmocked `RiskAdmissionCoordinator`/`RiskEngine` still perform the
// actual admission logic; only the DB layer is faked, per the mission's own
// explicit allowance for injected transaction-level failure (Â§8).

interface AccountRow {
  accountId: string; ownerFence: bigint; revision: bigint;
  startingCapitalInr: Prisma.Decimal; cumulativeRealizedPnlInr: Prisma.Decimal; cumulativeFeesInr: Prisma.Decimal;
  cumulativeFundingInr: Prisma.Decimal; peakEquityInr: Prisma.Decimal; consecutiveLossCount: number; cooldownActiveUntilMs: null;
}
interface PositionRow {
  accountId: string; pair: string; status: 'EMPTY' | 'PENDING' | 'OPEN'; admissionId: string | null; positionInstanceId: string | null;
  revision: number; ownerStrategyInstanceId: string | null; ownerStrategyId: string | null; ownerStrategyVersion: string | null; ownerParameterHash: string | null;
  cumulativeFundingInr: Prisma.Decimal;
}
type ReservationRow = Record<string, unknown> & { admissionId: string; accountId: string; status: 'ADMITTED' | 'RELEASED' | 'CONSUMED' };

function createFakePersistence() {
  const accounts = new Map<string, AccountRow>();
  const positions = new Map<string, PositionRow>();
  const reservations = new Map<string, ReservationRow>();
  let injected: { accountId: string; at: 'paperPosition.update' | 'paperReservation.upsert' } | null = null;
  const posKey = (accountId: string, pair: string): string => `${accountId}::${pair}`;

  function buildTx() {
    return {
      $executeRaw: async () => undefined,
      paperAccount: {
        findUnique: async ({ where }: any) => { const row = accounts.get(where.accountId); return row ? { ...row } : null; },
        update: async ({ where, data }: any) => {
          const row = accounts.get(where.accountId);
          if (row === undefined) throw new Error('fake paperAccount.update: no such account');
          const next: AccountRow = { ...row };
          if (data.ownerFence !== undefined) next.ownerFence = data.ownerFence;
          if (data.revision?.increment !== undefined) next.revision = row.revision + BigInt(data.revision.increment);
          accounts.set(where.accountId, next);
          return { ...next };
        },
      },
      paperPosition: {
        findUnique: async ({ where }: any) => {
          const row = positions.get(posKey(where.accountId_pair.accountId, where.accountId_pair.pair));
          return row ? { ...row } : null;
        },
        findMany: async ({ where }: any) => [...positions.values()].filter((p) => p.accountId === where.accountId).map((p) => ({ ...p })),
        update: async ({ where, data }: any) => {
          const { accountId, pair } = where.accountId_pair;
          if (injected !== null && injected.at === 'paperPosition.update' && injected.accountId === accountId) {
            injected = null;
            throw new Error('INJECTED_POST_ADMIT_FAILURE (paperPosition.update)');
          }
          const key = posKey(accountId, pair);
          const row = positions.get(key);
          if (row === undefined) throw new Error('fake paperPosition.update: no such slot');
          positions.set(key, { ...row, ...data, revision: row.revision + (data.revision?.increment ?? 0) });
          return { ...positions.get(key) };
        },
      },
      paperReservation: {
        findUnique: async ({ where }: any) => { const row = reservations.get(where.admissionId); return row ? { ...row } : null; },
        findMany: async ({ where }: any) => {
          let rows = [...reservations.values()].filter((r) => r.accountId === where.accountId);
          if (where.status !== undefined) rows = rows.filter((r) => r.status === where.status);
          return rows.map((r) => ({ ...r }));
        },
        upsert: async ({ where, create }: any) => {
          if (injected !== null && injected.at === 'paperReservation.upsert' && injected.accountId === create.accountId) {
            injected = null;
            throw new Error('INJECTED_POST_ADMIT_FAILURE (paperReservation.upsert)');
          }
          if (!reservations.has(where.admissionId)) reservations.set(where.admissionId, { status: 'ADMITTED', ...create });
          return { ...reservations.get(where.admissionId) };
        },
        update: async ({ where, data }: any) => {
          const row = reservations.get(where.admissionId);
          if (row === undefined) throw new Error('fake paperReservation.update: no such reservation');
          reservations.set(where.admissionId, { ...row, ...data });
          return { ...reservations.get(where.admissionId) };
        },
      },
      paperLedgerEntry: { findFirst: async () => null, findMany: async () => [] },
      paperFill: { findUnique: async () => null, findMany: async () => [] },
      // [F14-07] Only reachable for an account that never has an OPEN
      // position in these fake-persistence tests (PENDING/EMPTY only) â€” these
      // three always report empty since P14-G rehydration and P14-H
      // reconciliation only inspect them for OPEN-slot lineage.
      paperExecutionIntent: { findMany: async () => [], findUnique: async () => null },
      paperOrder: { findMany: async () => [], findUnique: async () => null },
      paperPositionOwnershipHistory: { findMany: async () => [] },
      paperExecutionPolicySnapshot: { findMany: async () => [] },
      paperReconciliationFault: { upsert: async () => undefined },
    };
  }

  const prisma = {
    // [F14-01] P14-I's read-only §52 terminal fast path queries this directly
    // on the client (outside any transaction). This fake account never has a
    // terminal fill, so it always reports none and the normal path runs.
    paperFill: { findUnique: async () => null },
    $transaction: async (fn: any) => {
      const accountsSnapshot = new Map(accounts);
      const positionsSnapshot = new Map(positions);
      const reservationsSnapshot = new Map(reservations);
      try {
        return await fn(buildTx());
      } catch (err) {
        // Simulates real Prisma interactive-transaction rollback: a throw inside
        // the callback must leave durable state exactly as it was beforehand.
        accounts.clear(); for (const [k, v] of accountsSnapshot) accounts.set(k, v);
        positions.clear(); for (const [k, v] of positionsSnapshot) positions.set(k, v);
        reservations.clear(); for (const [k, v] of reservationsSnapshot) reservations.set(k, v);
        throw err;
      }
    },
  } as unknown as PrismaClient;

  return {
    prisma,
    seedAccount(accountId: string): void {
      accounts.set(accountId, {
        accountId, ownerFence: 0n, revision: 0n,
        startingCapitalInr: new Prisma.Decimal('100000'), cumulativeRealizedPnlInr: new Prisma.Decimal('0'),
        cumulativeFeesInr: new Prisma.Decimal('0'), cumulativeFundingInr: new Prisma.Decimal('0'),
        peakEquityInr: new Prisma.Decimal('100000'), consecutiveLossCount: 0, cooldownActiveUntilMs: null,
      });
    },
    seedPairSlot(accountId: string, pair: string): void {
      positions.set(posKey(accountId, pair), {
        accountId, pair, status: 'EMPTY', admissionId: null, positionInstanceId: null, revision: 0,
        ownerStrategyInstanceId: null, ownerStrategyId: null, ownerStrategyVersion: null, ownerParameterHash: null,
        cumulativeFundingInr: new Prisma.Decimal('0'),
      });
    },
    injectFailureOnce(accountId: string, at: 'paperPosition.update' | 'paperReservation.upsert'): void {
      injected = { accountId, at };
    },
    reservationCount(accountId: string): number {
      return [...reservations.values()].filter((r) => r.accountId === accountId).length;
    },
    /** [F14-07] Simulates a genuine recovery-restore failure (e.g. the account row vanishing) â€” never reachable in real operation, only used to prove no READY facade escapes a failed recovery. */
    dropAccount(accountId: string): void {
      accounts.delete(accountId);
    },
  };
}

function buildRequest(accountId: string, pair: string, evaluationTimeMs: number): AdmissionRequest {
  const kernel = makeKernel(pair);
  const decision = evaluateDecision(kernel, evaluationTimeMs);
  return { accountId, policy: policyFor(pair), context: buildContext(kernel, decision) };
}

// ---------------------------------------------------------------------------
// [F14-07] Fixtures reused from the P14-I production-composer suite's own
// pattern (`CoinDcxPaperEvidence`/`FakeCoinDcxSocketFactory` are fully
// in-memory â€” no real network â€” so they are just as usable in this
// fake-Prisma unit suite as they are in the live-DB one).
// ---------------------------------------------------------------------------

const F14_07_EXECUTION_POLICY: ExecutionPolicySnapshot = buildExecutionPolicySnapshot({
  policyVersion: EXECUTION_POLICY_VERSION,
  fillSelectionPolicy: 'MARKET_EQUIVALENT_ALL_OR_NONE_V1',
  marketEvidenceEligibilityPolicy: { maxEvidenceAgeMs: 30_000, requiredHealthState: 'HEALTHY' },
  takerFeeRate: '0.001', slippageBps: '5', spreadSemantics: 'BID_ASK_DIRECT', tickRoundingPolicy: 'BUY_CEIL_SELL_FLOOR_V1',
  quantityPolicy: 'REJECT_NOT_RESIZE_V1', contractMultiplier: '0.001', currencyConversionPolicy: 'P14_INR_CONVERSION_V1',
  accountingPolicy: 'P14_INR_CASH_SETTLED_V1', executionSemanticsVersion: 'P14_EXECUTION_V1',
});
const F14_07_INSTRUMENT_SPEC_SNAPSHOT_ID = 'instrument-1';
const F14_07_WALL_CLOCK = { nowMs: () => Date.now() };

/** A real, in-memory `CoinDcxPaperEvidence` provider â€” deliberately never fed any evidence, so any OPEN that reaches evidence-read fails closed with `EVIDENCE_UNAVAILABLE` rather than proceeding to a fill (this suite's fake Prisma implements no fill-transaction tables at all â€” proving a genuine ADMISSION succeeded is sufficient to prove the facade is usable and produced no duplicate economics). */
function f1407Provider(pair: string): CoinDcxPaperEvidence {
  const instruments: readonly PaperEvidenceInstrument[] = Object.freeze([
    Object.freeze({ pair, underlying: 'BTC', quoteCurrency: 'USDT', instrumentSpecSnapshotId: F14_07_INSTRUMENT_SPEC_SNAPSHOT_ID }),
  ]);
  return new CoinDcxPaperEvidence({
    instruments, clock: F14_07_WALL_CLOCK, socketFactory: new FakeCoinDcxSocketFactory(),
    policy: { orderbookFreshnessMs: 30_000, markFreshnessMs: 30_000, conversionLocalPollFreshnessMs: 60_000, allowedProviderFutureSkewMs: 5_000 },
  });
}

async function f1407OpenParams(accountId: string, pair: string, evaluationTimeMs: number): Promise<ProductionOpenParams> {
  const { result: planResult } = await genuineResearchApproval();
  const kernel = makeKernel(pair);
  const decision = evaluateDecision(kernel, evaluationTimeMs);
  return {
    kernel, decision, planResult, policy: policyFor(pair),
    // [F14-01] account/exposure evidence is no longer caller-supplied at all.
    riskRequest: productionRiskRequest(kernel, decision, accountId),
    executionPolicy: F14_07_EXECUTION_POLICY,
  };
}

beforeAll(() => {
  interceptProductionInstrumentAcquisition(
    instrumentWire('BTC', { unit_contract_value: '0.001', price_increment: '1', quantity_increment: '1' }),
  );
});

describe('F14-07 correction â€” production composer never returns a cached READY facade over a FAULTED session', () => {
  it('a genuine ambiguous OPEN admission failure faults the session; the next composer.start() discards the stale facade, recovers through the kernel, and returns a fresh, usable READY facade with no duplicate economics', async () => {
    const { prisma, seedAccount, seedPairSlot, reservationCount, injectFailureOnce } = createFakePersistence();
    const accountId = 'f1407-account-1';
    const pair = 'B-BTC_USDT';
    seedAccount(accountId);
    seedPairSlot(accountId, pair);

    const coordinator = new RiskAdmissionCoordinator();
    const kernel = new PaperAccountKernel(prisma);
    const composer = new PaperAccountProductionComposer({ prisma, kernel, reconciler: new PaperAccountReconciler(prisma) });
    const provider = f1407Provider(pair);

    const runtime1 = await composer.start({ accountId, coordinator, provider });
    expect(runtime1.state).toBe('READY');
    expect(composer.getState(accountId)).toBe('READY');

    // A genuine ambiguous OPEN admission failure: coordinator.admit() mutates
    // in-memory state, then the durable commit fails â€” the exact P14-D-BLK-01
    // condition, here reached through the full P14-I public OPEN surface.
    injectFailureOnce(accountId, 'paperPosition.update');
    const openParams = await f1407OpenParams(accountId, pair, 1_200_000);
    await expect(runtime1.executeOpen(openParams)).rejects.toMatchObject({ code: 'ADMISSION_OUTCOME_AMBIGUOUS' });
    expect(coordinator.isAccountFaulted(accountId)).toBe(true);
    expect(reservationCount(accountId)).toBe(0); // the injected failure rolled the (simulated) transaction back

    // [F14-07 defect] The kernel's own diagnostic getState() never reflects a
    // post-startup session fault â€” it still reads READY even though the
    // underlying PaperAccountSession is now genuinely FAULTED. A composer
    // that trusted this alone would return the stale cached facade forever.
    expect(kernel.getState(accountId)).toBe('READY');

    const runtime2 = await composer.start({ accountId, coordinator, provider });
    expect(runtime2).not.toBe(runtime1); // never the stale facade â€” a genuinely fresh one, produced only after kernel recovery + fresh P14-H reconciliation
    expect(composer.getState(accountId)).toBe('READY');
    expect(coordinator.isAccountFaulted(accountId)).toBe(false); // the kernel's recovery path cleared it

    // The fresh facade is genuinely usable: a clean retry reaches (and completes) admission.
    const retryParams = await f1407OpenParams(accountId, pair, 1_260_000);
    await expect(runtime2.executeOpen(retryParams)).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' }); // expected â€” this provider was never fed evidence
    expect(reservationCount(accountId)).toBe(1); // exactly one genuine admission â€” no duplicate/phantom economics survived the earlier fault
  }, 30_000); // genuineResearchApproval() performs real (CPU-bound, no network) backtest validation

  it('a recovery restore that itself fails never lets a READY facade escape', async () => {
    const { prisma, seedAccount, seedPairSlot, injectFailureOnce, dropAccount } = createFakePersistence();
    const accountId = 'f1407-account-2';
    const pair = 'B-BTC_USDT';
    seedAccount(accountId);
    seedPairSlot(accountId, pair);

    const coordinator = new RiskAdmissionCoordinator();
    const kernel = new PaperAccountKernel(prisma);
    const composer = new PaperAccountProductionComposer({ prisma, kernel, reconciler: new PaperAccountReconciler(prisma) });
    const provider = f1407Provider(pair);

    await composer.start({ accountId, coordinator, provider });
    injectFailureOnce(accountId, 'paperPosition.update');
    const openParams = await f1407OpenParams(accountId, pair, 1_200_000);
    await expect(composer.start({ accountId, coordinator, provider }).then((r) => r.executeOpen(openParams))).rejects.toMatchObject({ code: 'ADMISSION_OUTCOME_AMBIGUOUS' });
    expect(coordinator.isAccountFaulted(accountId)).toBe(true);

    // The account row itself is now gone â€” the kernel's recovery-path restore must fail.
    dropAccount(accountId);
    await expect(composer.start({ accountId, coordinator, provider })).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    expect(composer.getState(accountId)).toBe('NOT_READY');
  }, 30_000);
});

describe('P14-D-BLK-01 â€” post-admit durable-persistence failure is treated as FAULTED, never a silent rollback-and-continue', () => {
  it('a failure at paperPosition.update after coordinator.admit() succeeded yields ADMISSION_OUTCOME_AMBIGUOUS, faults the session and the account, and leaves no durable row behind', async () => {
    const { prisma, seedAccount, seedPairSlot, reservationCount, injectFailureOnce } = createFakePersistence();
    const accountId = 'blk01-account-1';
    const pair = 'B-BTC_USDT';
    seedAccount(accountId);
    seedPairSlot(accountId, pair);
    const coordinator = new RiskAdmissionCoordinator();
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    expect(session.state).toBe('READY');

    injectFailureOnce(accountId, 'paperPosition.update');
    const request = buildRequest(accountId, pair, 1_200_000);
    await expect(session.admitAndPersist(pair, request, coordinator)).rejects.toMatchObject({ code: 'ADMISSION_OUTCOME_AMBIGUOUS' });

    // Session and account are both FAULTED â€” no successful result escaped.
    expect(session.state).toBe('FAULTED');
    expect(coordinator.isAccountFaulted(accountId)).toBe(true);
    await expect(coordinator.admit(request)).rejects.toThrow(/FAULTED/);

    // The (simulated) DB transaction rolled back â€” no phantom reservation survives.
    expect(reservationCount(accountId)).toBe(0);

    // The same session cannot be used again for anything mutating.
    const retryRequest = buildRequest(accountId, pair, 1_260_000);
    await expect(session.admitAndPersist(pair, retryRequest, coordinator)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_READY' });
    await expect(session.releaseAndPersist('whatever', coordinator, 0n)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_READY' });
  });

  it('a failure at paperReservation.upsert (an earlier post-admit write) triggers the identical fail-closed path', async () => {
    const { prisma, seedAccount, seedPairSlot, reservationCount, injectFailureOnce } = createFakePersistence();
    const accountId = 'blk01-account-2';
    const pair = 'B-BTC_USDT';
    seedAccount(accountId);
    seedPairSlot(accountId, pair);
    const coordinator = new RiskAdmissionCoordinator();
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });

    injectFailureOnce(accountId, 'paperReservation.upsert');
    const request = buildRequest(accountId, pair, 1_200_000);
    await expect(session.admitAndPersist(pair, request, coordinator)).rejects.toMatchObject({ code: 'ADMISSION_OUTCOME_AMBIGUOUS' });
    expect(session.state).toBe('FAULTED');
    expect(coordinator.isAccountFaulted(accountId)).toBe(true);
    expect(reservationCount(accountId)).toBe(0);
  });

  it('authoritative restore (opening a fresh session) repairs runtime state after a fault, and a subsequent legitimate admission then succeeds', async () => {
    const { prisma, seedAccount, seedPairSlot, reservationCount, injectFailureOnce } = createFakePersistence();
    const accountId = 'blk01-account-3';
    const pair = 'B-BTC_USDT';
    seedAccount(accountId);
    seedPairSlot(accountId, pair);
    const coordinator = new RiskAdmissionCoordinator();
    const session1 = await openPaperAccountSession({ accountId, coordinator, prisma });

    injectFailureOnce(accountId, 'paperPosition.update');
    const faultingRequest = buildRequest(accountId, pair, 1_200_000);
    await expect(session1.admitAndPersist(pair, faultingRequest, coordinator)).rejects.toMatchObject({ code: 'ADMISSION_OUTCOME_AMBIGUOUS' });
    expect(coordinator.isAccountFaulted(accountId)).toBe(true);

    // Production recovery lifecycle: simply open a fresh session for the account again.
    const session2 = await openPaperAccountSession({ accountId, coordinator, prisma });
    expect(session2.state).toBe('READY');
    expect(session2.restoreResult.recoveredFromFault).toBe(true);
    expect(coordinator.isAccountFaulted(accountId)).toBe(false);

    const freshRequest = buildRequest(accountId, pair, 1_260_000);
    const result = await session2.admitAndPersist(pair, freshRequest, coordinator);
    expect(result.outcome).toBe('ADMITTED');
    expect(reservationCount(accountId)).toBe(1);
  });

  it('one account faulting never affects an unrelated account â€” both share the same coordinator and DB layer', async () => {
    const { prisma, seedAccount, seedPairSlot, injectFailureOnce } = createFakePersistence();
    const accountA = 'blk01-account-a';
    const accountB = 'blk01-account-b';
    const pair = 'B-BTC_USDT';
    seedAccount(accountA); seedPairSlot(accountA, pair);
    seedAccount(accountB); seedPairSlot(accountB, pair);
    const coordinator = new RiskAdmissionCoordinator();
    const sessionA = await openPaperAccountSession({ accountId: accountA, coordinator, prisma });
    const sessionB = await openPaperAccountSession({ accountId: accountB, coordinator, prisma });

    injectFailureOnce(accountA, 'paperPosition.update');
    await expect(sessionA.admitAndPersist(pair, buildRequest(accountA, pair, 1_200_000), coordinator)).rejects.toMatchObject({ code: 'ADMISSION_OUTCOME_AMBIGUOUS' });
    expect(coordinator.isAccountFaulted(accountA)).toBe(true);
    expect(coordinator.isAccountFaulted(accountB)).toBe(false);

    const resultB = await sessionB.admitAndPersist(pair, buildRequest(accountB, pair, 1_200_000), coordinator);
    expect(resultB.outcome).toBe('ADMITTED');
    expect(sessionB.state).toBe('READY');
  });
});

describe('P14-D-MAJ-01 â€” production durable admission requires a READY PaperAccountSession, never raw ownership alone', () => {
  it('PaperAdmissionBridge and its session-proof token are not exported from the persistence barrel', () => {
    expect((persistenceBarrel as Record<string, unknown>)['PaperAdmissionBridge']).toBeUndefined();
    expect((persistenceBarrel as Record<string, unknown>)['SESSION_PROOF']).toBeUndefined();
  });

  it('ownership acquired directly from the repository â€” without ever restoring â€” cannot drive the bridge without the genuine session proof', async () => {
    const { prisma, seedAccount, seedPairSlot } = createFakePersistence();
    const accountId = 'maj01-account-1';
    const pair = 'B-BTC_USDT';
    seedAccount(accountId);
    seedPairSlot(accountId, pair);
    const coordinator = new RiskAdmissionCoordinator();
    const repository = new PaperAccountRepository(prisma);
    const rawOwnership = await repository.acquireOwnership(accountId); // no restore performed at all
    const bridge = new PaperAdmissionBridge(prisma);
    const request = buildRequest(accountId, pair, 1_200_000);
    await expect(
      bridge.admitAndPersist('forged-proof' as unknown as symbol, rawOwnership, pair, request, coordinator),
    ).rejects.toMatchObject({ code: 'NOT_OWNER' });
  });

  it('the genuine (internal, non-barrel) SESSION_PROOF still lets the bridge admit for a session that has already restored â€” proving the guard is the proof, not obscurity', async () => {
    const { prisma, seedAccount, seedPairSlot, reservationCount } = createFakePersistence();
    const accountId = 'maj01-account-2';
    const pair = 'B-BTC_USDT';
    seedAccount(accountId);
    seedPairSlot(accountId, pair);
    const coordinator = new RiskAdmissionCoordinator();
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    const bridge = new PaperAdmissionBridge(prisma);
    const request = buildRequest(accountId, pair, 1_200_000);
    const result = await bridge.admitAndPersist(SESSION_PROOF, session.ownership, pair, request, coordinator);
    expect(result.outcome).toBe('ADMITTED');
    expect(reservationCount(accountId)).toBe(1);
  });

  it('a caller cannot construct a PaperAccountSession directly with a foreign issuer â€” only openPaperAccountSession can produce a live one', () => {
    const PaperAccountSessionCtor = (persistenceBarrel as unknown as { PaperAccountSession: new (...args: unknown[]) => unknown }).PaperAccountSession;
    expect(() => new PaperAccountSessionCtor(Symbol('forged'), 'acc', {}, {}, {}, {}, {})).toThrow();
  });

  it('a released session rejects further admission/release', async () => {
    const { prisma, seedAccount, seedPairSlot } = createFakePersistence();
    const accountId = 'maj01-account-3';
    const pair = 'B-BTC_USDT';
    seedAccount(accountId);
    seedPairSlot(accountId, pair);
    const coordinator = new RiskAdmissionCoordinator();
    const session = await openPaperAccountSession({ accountId, coordinator, prisma });
    session.release();
    expect(session.state).toBe('RELEASED');
    await expect(session.admitAndPersist(pair, buildRequest(accountId, pair, 1_200_000), coordinator)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_READY' });
    await expect(session.releaseAndPersist('whatever', coordinator, 0n)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_READY' });
  });

  it('a stale session after a fence takeover by a new process/coordinator fails closed on STALE_FENCE without faulting the account or mutating any row', async () => {
    // A takeover is realistically a different process (or a fault-recovery
    // reopen) â€” i.e. a DIFFERENT coordinator instance, not a second live
    // session sharing the same in-process coordinator (which ordinary
    // restore correctly refuses â€” single-owner-per-coordinator semantics,
    // proven by the account-isolation/duplicate-restore tests elsewhere).
    const { prisma, seedAccount, seedPairSlot, reservationCount } = createFakePersistence();
    const accountId = 'maj01-account-4';
    const pair = 'B-BTC_USDT';
    seedAccount(accountId);
    seedPairSlot(accountId, pair);
    const coordinatorA = new RiskAdmissionCoordinator();
    const coordinatorB = new RiskAdmissionCoordinator();
    const sessionA = await openPaperAccountSession({ accountId, coordinator: coordinatorA, prisma }); // fence 1
    await openPaperAccountSession({ accountId, coordinator: coordinatorB, prisma }); // fence 2 â€” takeover by a new process

    await expect(sessionA.admitAndPersist(pair, buildRequest(accountId, pair, 1_200_000), coordinatorA)).rejects.toMatchObject({ code: 'STALE_FENCE' });
    // No coordinator mutation ever occurred (the fence check runs before admit()), so this is a clean failure, not a fault.
    expect(sessionA.state).toBe('READY');
    expect(coordinatorA.isAccountFaulted(accountId)).toBe(false);
    expect(reservationCount(accountId)).toBe(0);
  });
});
