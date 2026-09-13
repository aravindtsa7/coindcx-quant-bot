import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../persistence/prisma';
import { RiskAdmissionCoordinator } from '../../dispatch';
// [P14-G-MAJ-01] Internal, non-barrel import — same convention already used
// by `paper-account-session.ts`/`restore.ts` to reach the one trusted
// account-fault-recovery capability. Not re-exported from `src/dispatch/index.ts`.
import { ACCOUNT_FAULT_RECOVERY_CAPABILITY } from '../../dispatch/admission';
import { computePositionInstanceId } from '../identity';
import { PaperAccountOwnership } from './account-ownership';
import type { Clock } from './account-repository';
import { PaperPersistenceError } from './errors';
import { openPaperAccountSession, PaperAccountSession } from './paper-account-session';
import type { RestoreResult } from './restore';

/**
 * [P14-G] Restart / rehydration / kernel startup sequence.
 *
 * This module is the FIRST multi-step "process boot" orchestration Phase 14
 * has ever had. Every per-account restore primitive it uses is already
 * frozen and unmodified (P14-D/P14-F `openPaperAccountSession` — ownership
 * acquisition, fence validation, coherent snapshot incl. the P14-F funding
 * fail-closed invariants, and C3 admission restore, all in that exact order,
 * see `paper-account-session.ts`). P14-G does not fork, duplicate, or
 * reimplement any part of that sequence — it composes one additional,
 * genuinely new step on top of it (durable position-lineage rehydration +
 * structural validation, §"RESTORING_RUNTIME" below) and wraps the whole
 * thing in an explicit, non-forgeable, account-scoped readiness gate.
 *
 * Frozen invariants this module depends on and must never weaken:
 *  - Durable MySQL state is the sole restart authority — no process-local
 *    cache, no serialized capability, is ever trusted across a restart.
 *  - `openPaperAccountSession` already IS the P14-F fail-closed funding gate
 *    (`PaperAccountRepository.loadCoherentSnapshot`) — a session can never
 *    become READY while any funding fact is non-zero/present.
 *  - Terminal `PaperFill` dedup (`UNIQUE(accountId, sourceStrategyDecisionId)`)
 *    survives restart untouched — this module reads fills, never writes them.
 *  - A reservation/pending-position row is never treated as OPEN/CLOSE
 *    execution authority. Fresh OPEN authority is never minted from durable
 *    rows alone; fresh CLOSE authority is always obtainable through the
 *    existing trusted `mintPaperCloseExecutionAuthority` path, bound to the
 *    exact durable `positionInstanceId`/`revision` this module reports.
 */

/**
 * Startup/readiness state for one account's kernel run. `ACQUIRING_OWNERSHIP`
 * covers the entire frozen `openPaperAccountSession` sequence (ownership
 * acquisition, fence validation, coherent snapshot + funding invariant, and
 * C3 admission restore) as one atomic unit — those steps are not
 * independently observable from outside without forking that frozen,
 * single-transaction-boundary composition, which this module must not do.
 * `RESTORING_RUNTIME` is P14-G's own additional work: durable position
 * lineage rehydration and structural-consistency validation. A `FAULTED`
 * account can only be retried by calling `startPaperAccountRuntime` again for
 * it — there is no separate repair path here (that is P14-H's scope).
 */
export type PaperAccountKernelState = 'COLD' | 'ACQUIRING_OWNERSHIP' | 'RESTORING_RUNTIME' | 'READY' | 'FAULTED';

export interface PaperPositionRehydrationEmpty {
  readonly status: 'EMPTY';
  readonly pair: string;
}

export interface PaperPositionRehydrationPending {
  readonly status: 'PENDING';
  readonly pair: string;
  /** The durable, still-`ADMITTED` reservation already restored into the coordinator by `openPaperAccountSession`. Never execution authority by itself (§20). */
  readonly admissionId: string;
}

export interface PaperPositionRehydrationOpen {
  readonly status: 'OPEN';
  readonly pair: string;
  readonly positionInstanceId: string;
  /** The opening reservation's admissionId — retained on the slot for the entire OPEN lifetime (never cleared until CLOSE). */
  readonly admissionId: string;
  readonly side: 'LONG' | 'SHORT';
  readonly quantity: string;
  readonly averageEntryPriceInr: string;
  readonly leverage: string;
  readonly initialMarginInr: string;
  readonly cumulativeRealizedPnlInr: string;
  readonly cumulativeFeesInr: string;
  /** Always `'0'` under the current P14-F `FUNDING_UNSUPPORTED` mode — never repaired or reinterpreted here. */
  readonly cumulativeFundingInr: string;
  readonly revision: number;
  readonly ownerStrategyInstanceId: string;
  readonly ownerStrategyId: string;
  readonly ownerStrategyVersion: string;
  readonly ownerParameterHash: string;
  readonly openedAtMs: number;
  /** The identified completed opening `PaperExecutionIntent`/`PaperOrder`/`PaperFill` lineage's id — the exact binding a fresh CLOSE authority's identity computation needs. */
  readonly openingExecutionIntentId: string;
}

export type PaperPositionRehydration = PaperPositionRehydrationEmpty | PaperPositionRehydrationPending | PaperPositionRehydrationOpen;

/**
 * [P14-G] Reads and validates every durable pair-slot row for one account
 * (read-only — no mutation, no repair). Reuses the exact fence-verified
 * `SELECT ... FOR UPDATE` + coherent-transaction pattern already established
 * by `PaperAccountRepository.loadCoherentSnapshot`/`restoreAccountAdmissionState`,
 * but is intentionally NOT added to that frozen P14-D file — this lineage
 * validation (§15/§23) is new P14-G-owned logic, not a modification of the
 * frozen coherent-snapshot contract. No network I/O occurs (§49): every check
 * here is either a plain durable read or a pure, deterministic recomputation
 * of the frozen `computePositionInstanceId` identity (§15's "verify enough
 * lineage", never trusting a persisted id blindly, V2.2 §35). Any structural
 * impossibility (§23/§46) fails closed with `RECONCILIATION_REQUIRED` — P14-G
 * never repairs it; that is exclusively P14-H's scope (§24/§56).
 */
async function rehydratePositions(
  prismaClient: PrismaClient,
  ownership: PaperAccountOwnership,
): Promise<readonly PaperPositionRehydration[]> {
  const held = PaperAccountOwnership.read(ownership);
  if (held === null) throw new PaperPersistenceError('NOT_OWNER', 'Caller-shaped ownership object is not genuine');

  return prismaClient.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT account_id FROM paper_account WHERE account_id = ${held.accountId} FOR UPDATE`;
    const account = await tx.paperAccount.findUnique({ where: { accountId: held.accountId } });
    if (account === null) throw new PaperPersistenceError('ACCOUNT_NOT_FOUND', `No paper_account row for ${held.accountId}`);
    if (account.ownerFence !== held.fence) {
      throw new PaperPersistenceError('STALE_FENCE', `Held fence ${held.fence} no longer matches current ${account.ownerFence} for ${held.accountId}`);
    }

    const slots = await tx.paperPosition.findMany({ where: { accountId: held.accountId } });
    const results: PaperPositionRehydration[] = [];

    for (const slot of slots) {
      if (slot.status === 'EMPTY') {
        if (slot.admissionId !== null || slot.positionInstanceId !== null) {
          throw new PaperPersistenceError('RECONCILIATION_REQUIRED', `EMPTY pair slot (${held.accountId}, ${slot.pair}) unexpectedly retains admissionId/positionInstanceId`);
        }
        results.push(Object.freeze({ status: 'EMPTY' as const, pair: slot.pair }));
        continue;
      }

      if (slot.admissionId === null) {
        throw new PaperPersistenceError('RECONCILIATION_REQUIRED', `${slot.status} pair slot (${held.accountId}, ${slot.pair}) is missing its admissionId`);
      }
      const reservation = await tx.paperReservation.findUnique({ where: { admissionId: slot.admissionId } });
      if (reservation === null || reservation.accountId !== held.accountId) {
        throw new PaperPersistenceError('RECONCILIATION_REQUIRED', `${slot.status} pair slot (${held.accountId}, ${slot.pair}) references admission ${slot.admissionId} with no matching durable reservation`);
      }

      if (slot.status === 'PENDING') {
        // §12/§18/§37: pending exposure for this exact admission is already
        // restored into the coordinator by openPaperAccountSession before
        // this function ever runs — this is a read-only consistency check,
        // never a second restore mechanism, and never mints OPEN authority.
        if (reservation.status !== 'ADMITTED') {
          throw new PaperPersistenceError('RECONCILIATION_REQUIRED', `PENDING pair slot (${held.accountId}, ${slot.pair}) claim ${slot.admissionId} is durably ${reservation.status}, not ADMITTED`);
        }
        results.push(Object.freeze({ status: 'PENDING' as const, pair: slot.pair, admissionId: slot.admissionId }));
        continue;
      }

      // OPEN (§13/§14/§15/§41).
      if (
        slot.positionInstanceId === null || slot.side === null || slot.quantity === null || slot.averageEntryPriceInr === null
        || slot.leverage === null || slot.initialMarginInr === null || slot.openedAtMs === null
        || slot.ownerStrategyInstanceId === null || slot.ownerStrategyId === null || slot.ownerStrategyVersion === null || slot.ownerParameterHash === null
      ) {
        throw new PaperPersistenceError('RECONCILIATION_REQUIRED', `OPEN pair slot (${held.accountId}, ${slot.pair}) is missing required mechanical fields`);
      }
      const openingIntent = await tx.paperExecutionIntent.findUnique({ where: { admissionId: slot.admissionId } });
      if (openingIntent === null || openingIntent.action !== 'OPEN' || openingIntent.accountId !== held.accountId) {
        throw new PaperPersistenceError('RECONCILIATION_REQUIRED', `OPEN pair slot (${held.accountId}, ${slot.pair}) has no matching opening PaperExecutionIntent for admission ${slot.admissionId}`);
      }
      const order = await tx.paperOrder.findUnique({ where: { executionIntentId: openingIntent.executionIntentId } });
      if (order === null || order.state !== 'FILLED') {
        throw new PaperPersistenceError('RECONCILIATION_REQUIRED', `OPEN pair slot (${held.accountId}, ${slot.pair}) opening order ${openingIntent.executionIntentId} is not FILLED`);
      }
      const fill = await tx.paperFill.findUnique({ where: { orderId: order.executionIntentId } });
      if (fill === null) {
        throw new PaperPersistenceError('RECONCILIATION_REQUIRED', `OPEN pair slot (${held.accountId}, ${slot.pair}) opening order ${openingIntent.executionIntentId} has no terminal PaperFill`);
      }
      const expectedPositionInstanceId = computePositionInstanceId({
        accountId: held.accountId, strategyInstanceId: openingIntent.strategyInstanceId, pair: slot.pair, openingExecutionIntentId: openingIntent.executionIntentId,
      });
      if (expectedPositionInstanceId !== slot.positionInstanceId) {
        throw new PaperPersistenceError('RECONCILIATION_REQUIRED', `OPEN pair slot (${held.accountId}, ${slot.pair}) positionInstanceId does not match its recomputed opening identity`);
      }

      results.push(Object.freeze({
        status: 'OPEN' as const, pair: slot.pair, positionInstanceId: slot.positionInstanceId, admissionId: slot.admissionId,
        side: slot.side, quantity: slot.quantity.toFixed(), averageEntryPriceInr: slot.averageEntryPriceInr.toFixed(),
        leverage: slot.leverage.toFixed(), initialMarginInr: slot.initialMarginInr.toFixed(),
        cumulativeRealizedPnlInr: slot.cumulativeRealizedPnlInr.toFixed(), cumulativeFeesInr: slot.cumulativeFeesInr.toFixed(),
        cumulativeFundingInr: slot.cumulativeFundingInr.toFixed(), revision: slot.revision,
        ownerStrategyInstanceId: slot.ownerStrategyInstanceId, ownerStrategyId: slot.ownerStrategyId,
        ownerStrategyVersion: slot.ownerStrategyVersion, ownerParameterHash: slot.ownerParameterHash,
        openedAtMs: Number(slot.openedAtMs), openingExecutionIntentId: openingIntent.executionIntentId,
      }));
    }

    return Object.freeze(results);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

const RUNTIME_ISSUER = Symbol('P14-G PaperAccountRuntime issuer — only PaperAccountKernel.startPaperAccountRuntime may construct one');

/**
 * [P14-G] Non-forgeable READY runtime handle for exactly one paper account
 * (§30/§31). Constructor is symbol-gated identically to `PaperAccountSession`
 * /`PaperAccountOwnership` — a caller cannot fabricate `{ state: 'READY',
 * session, positions }` and gain mutation access, because the real mutation
 * surface (`session.admitAndPersist`/`executeOpen`/`executeClose`) is itself
 * already gated by the session's own internal `SESSION_PROOF`/ownership
 * checks; this class merely proves that P14-G's own additional startup work
 * (position rehydration/structural validation) also completed before
 * anything is handed back. Its mere existence, like `PaperAccountSession`'s,
 * is the readiness proof — there is no separate boolean a caller could race
 * past (§30).
 */
export class PaperAccountRuntime {
  public readonly accountId: string;
  public readonly ownerFence: bigint;
  public readonly session: PaperAccountSession;
  public readonly positions: readonly PaperPositionRehydration[];
  public readonly restoreResult: RestoreResult;

  /** @internal — only `PaperAccountKernel.startPaperAccountRuntime` may construct one; throws for any other caller. */
  public constructor(
    issuer: symbol, accountId: string, ownerFence: bigint, session: PaperAccountSession,
    positions: readonly PaperPositionRehydration[], restoreResult: RestoreResult,
  ) {
    if (issuer !== RUNTIME_ISSUER) throw new PaperPersistenceError('NOT_OWNER', 'Only PaperAccountKernel.startPaperAccountRuntime may construct a PaperAccountRuntime');
    this.accountId = accountId;
    this.ownerFence = ownerFence;
    this.session = session;
    this.positions = positions;
    this.restoreResult = restoreResult;
    Object.freeze(this);
  }

  /** Always `'READY'` — an instance cannot exist in any other state (§30). */
  public get state(): 'READY' {
    return 'READY';
  }

  public position(pair: string): PaperPositionRehydration | undefined {
    return this.positions.find((entry) => entry.pair === pair);
  }
}
Object.freeze(PaperAccountRuntime.prototype);
Object.freeze(PaperAccountRuntime);

export interface StartPaperAccountRuntimeParams {
  readonly accountId: string;
  readonly coordinator: RiskAdmissionCoordinator;
  readonly prisma?: PrismaClient;
  readonly clock?: Clock;
}

/**
 * [P14-G] The single production startup orchestrator (§5). One instance
 * represents one running process's kernel: it tracks per-account readiness
 * state (§4, diagnostic-only — never itself a usable mutation surface, §30)
 * and guarantees single-flight startup per account within this process
 * (§32) — concurrent calls for the SAME account join the same in-flight
 * start rather than each independently racing `openPaperAccountSession`;
 * different accounts are never serialized against each other (§8). A fresh
 * `PaperAccountKernel` instance (as a real process restart would have) has
 * no memory of any prior run — every test that simulates a restart must
 * construct one (§62), never reuse a prior instance.
 *
 * No new "already started" rejection is layered on top of the frozen fencing
 * model: once a prior start settles (success or failure), a later call for
 * the same account starts fresh and simply acquires a new, higher fence —
 * exactly as `openPaperAccountSession` already allows on its own. This
 * mirrors the frozen P14-D fencing model rather than inventing a competing
 * "already owned" concept (no persisted owner identity exists to check
 * against, per `PaperAccountRepository`'s own documented design, §7).
 *
 * [P14-G-MAJ-02] A repeated call for an account that is ALREADY READY in this
 * kernel instance is the one exception to "always starts fresh": it returns
 * the SAME cached `PaperAccountRuntime` with no DB interaction at all (no
 * ownership reacquisition, no fence bump, no C3 restore attempt) — idempotent
 * startup, not a second independent start. Only a fully-READY runtime is ever
 * cached; an in-progress or failed start is never cached (that remains the
 * `#inFlight` map's job).
 */
export class PaperAccountKernel {
  readonly #prisma: PrismaClient;
  readonly #states = new Map<string, PaperAccountKernelState>();
  readonly #inFlight = new Map<string, Promise<PaperAccountRuntime>>();
  readonly #readyRuntimes = new Map<string, PaperAccountRuntime>();

  public constructor(prismaClient: PrismaClient = defaultPrisma) {
    this.#prisma = prismaClient;
  }

  /** Diagnostic-only read of one account's current startup state (`'COLD'` if never started in this process). Never a usable mutation surface (§29/§66). */
  public getState(accountId: string): PaperAccountKernelState {
    return this.#states.get(accountId) ?? 'COLD';
  }

  /**
   * Resolves only once the account is fully READY — every step (§5 steps
   * 1-6) has already completed successfully. Rejects (leaving the account
   * `FAULTED`, §59's typed error taxonomy — `PaperPersistenceError`,
   * `RECONCILIATION_REQUIRED`/`FUNDING_INVARIANT_VIOLATION`/`STALE_FENCE`/
   * etc.) if any step fails; no partially-started runtime is ever returned
   * (§29/§30/§48/§66).
   *
   * [P14-G-MAJ-02] If this account is already READY in this kernel instance,
   * returns the existing runtime immediately — no ownership reacquisition, no
   * fence mutation, no coordinator restore. This check (and the `#inFlight`
   * join below it) both happen synchronously before any `await`, so a caller
   * arriving at any point after a start has resolved READY — even in the
   * same microtask turn the resolution happened in — can never fall through
   * into starting a second, independent startup for the same account.
   */
  public startPaperAccountRuntime(params: StartPaperAccountRuntimeParams): Promise<PaperAccountRuntime> {
    const { accountId } = params;

    const cached = this.#readyRuntimes.get(accountId);
    if (cached !== undefined) {
      // The cached runtime's own `PaperAccountSession` may since have been
      // faulted/released by session-level activity this kernel does not
      // itself observe (`PaperAccountSession`'s own admit/execute
      // fault-handling, §21) — handing that back as "the same usable READY
      // runtime" would be wrong. Evict it and fall through to a fresh start
      // rather than silently returning something already known-unusable.
      if (cached.session.state === 'READY') return Promise.resolve(cached);
      this.#readyRuntimes.delete(accountId);
      this.#states.set(accountId, 'FAULTED');
    }

    const existingFlight = this.#inFlight.get(accountId);
    if (existingFlight !== undefined) return existingFlight;

    const promise = this.#start(params);
    this.#inFlight.set(accountId, promise);
    const clearInFlight = (): void => {
      if (this.#inFlight.get(accountId) === promise) this.#inFlight.delete(accountId);
    };
    // Both branches handled here (not left to the caller) so this cleanup
    // chain never itself becomes an unhandled rejection; the `promise`
    // returned to the caller above still carries its own original
    // resolution/rejection independently.
    promise.then(clearInFlight, clearInFlight);
    return promise;
  }

  async #start(params: StartPaperAccountRuntimeParams): Promise<PaperAccountRuntime> {
    const { accountId, coordinator } = params;
    const prismaClient = params.prisma ?? this.#prisma;
    this.#states.set(accountId, 'ACQUIRING_OWNERSHIP');

    let session: PaperAccountSession | undefined;
    try {
      // Frozen P14-D/P14-F sequence, reused verbatim and never forked:
      // ownership acquisition -> fence validation -> coherent snapshot
      // (incl. the P14-F funding fail-closed invariants) -> C3 admission
      // restore (§6/§7/§26/§36).
      session = await openPaperAccountSession({
        accountId, coordinator, prisma: prismaClient, ...(params.clock === undefined ? {} : { clock: params.clock }),
      });

      this.#states.set(accountId, 'RESTORING_RUNTIME');
      const positions = await rehydratePositions(prismaClient, session.ownership);

      const runtime = new PaperAccountRuntime(RUNTIME_ISSUER, accountId, session.snapshot.fence, session, positions, session.restoreResult);
      // [P14-G-MAJ-02] Installed synchronously, in the same tick this
      // function resolves with `runtime` — before `#inFlight`'s cleanup
      // microtask runs, and before control returns to any other caller of
      // `startPaperAccountRuntime` (§20).
      this.#readyRuntimes.set(accountId, runtime);
      this.#states.set(accountId, 'READY');
      return runtime;
    } catch (cause) {
      this.#states.set(accountId, 'FAULTED');
      // [P14-G-MAJ-01] A failure reaching this point with a genuine `session`
      // already obtained means `openPaperAccountSession` already committed a
      // real C3 admission restore into `coordinator`'s in-memory state before
      // this module's OWN post-session rehydration/structural validation
      // failed. Leaving that state merely "restored" (not faulted) would let
      // a same-process retry against the SAME coordinator instance call
      // ordinary `coordinator.restore()` again, which rejects any account
      // that already holds in-memory state with a hard `Error` (surfaced here
      // as `DURABLE_CONFLICT` — see `restore.ts`) — bricking the account for
      // that coordinator. Marking it FAULTED via the same trusted P14-D
      // fault-recovery capability `PaperAccountSession` itself already uses
      // for an ambiguous durable-write outcome routes any retry through
      // `coordinator.restoreAuthoritative(...)` instead, which correctly
      // discards this stale projection in favor of a freshly re-read durable
      // snapshot and clears the fault on success — no manual map surgery, no
      // second recovery mechanism (§3/§5). This performs no durable mutation
      // and never touches any other account's state (`markAccountFaulted`
      // enqueues only on this account's own serialized queue).
      if (session !== undefined) {
        try {
          await coordinator.markAccountFaulted(ACCOUNT_FAULT_RECOVERY_CAPABILITY, accountId);
        } catch { /* best-effort only; never mask the original startup failure */ }
        // A failure after a genuine session was already obtained must not
        // leave a usable half-started session reachable by anything else in
        // this process (§33/§48). This is pure in-process bookkeeping —
        // `release()` writes nothing durable — so it changes nothing about a
        // later clean startup's ability to take over via a fresh, higher
        // fence (§7/§33).
        try { session.release(); } catch { /* best-effort only; never mask the original cause */ }
      }
      // The original, meaningful startup failure (e.g. RECONCILIATION_REQUIRED)
      // is always what the caller sees — marking the coordinator faulted is a
      // safety side effect, never a reason to replace or mask the root cause (§23).
      throw cause;
    }
  }
}
