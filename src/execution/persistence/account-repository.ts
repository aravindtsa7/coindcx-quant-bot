import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../persistence/prisma';
import { canonicalDecimalString, riskDecimal, sha256CanonicalJson, type EvidenceProvenance, type PortfolioExposureSnapshot } from '../../risk';
import { issueAccountOwnership, PaperAccountOwnership, type PaperAccountOwnershipRecord } from './account-ownership';
import { PaperPersistenceError } from './errors';

/** Injectable for deterministic testing — never `Date.now()` directly. */
export interface Clock {
  nowMs(): number;
}
export class SystemClock implements Clock {
  public nowMs(): number { return Date.now(); }
}

export interface PaperPairSlotSnapshot {
  readonly pair: string;
  readonly status: 'EMPTY' | 'PENDING' | 'OPEN';
  readonly admissionId: string | null;
  readonly positionInstanceId: string | null;
  readonly revision: number;
  readonly ownerStrategyInstanceId: string | null;
  readonly ownerStrategyId: string | null;
  readonly ownerStrategyVersion: string | null;
  readonly ownerParameterHash: string | null;
}

/**
 * One coherent, mutually-consistent read of durable account state (V2 §9/§17)
 * — every field is bound to the same `fence`/`revision` obtained under a
 * single `SELECT ... FOR UPDATE`-guarded transaction (V2 §16), never a
 * composite of separate unlocked queries. Frozen/immutable once returned.
 * `admittedReservations` deliberately excludes RELEASED/CONSUMED rows — those
 * no longer hold live pending capacity (V2 §15's double-count-prevention
 * rule: only currently-ADMITTED rows contribute to pending exposure).
 */
export interface PaperAccountSnapshot {
  readonly accountId: string;
  readonly fence: bigint;
  readonly revision: bigint;
  readonly startingCapitalInr: string;
  readonly cumulativeRealizedPnlInr: string;
  readonly cumulativeFeesInr: string;
  readonly cumulativeFundingInr: string;
  readonly peakEquityInr: string;
  readonly consecutiveLossCount: number;
  readonly cooldownActiveUntilMs: number | null;
  readonly admittedReservations: readonly {
    readonly admissionId: string;
    readonly riskDecisionId: string;
    readonly sourceStrategyDecisionId: string;
    readonly strategyInstanceId: string;
    readonly strategyId: string;
    readonly strategyVersion: string;
    readonly parameterHash: string;
    readonly pair: string;
    readonly decisionSequence: number;
    readonly direction: 'LONG' | 'SHORT';
    readonly approvedNotionalInr: string;
    readonly approvedMarginInr: string;
    readonly generation: number;
  }[];
  readonly pairSlots: readonly PaperPairSlotSnapshot[];
  readonly observedAtMs: number;
}

function decimalToString(value: Prisma.Decimal): string {
  return value.toFixed();
}

function provenance(sourceId: string, observedAtMs: number, content: unknown): EvidenceProvenance {
  return { sourceId, sourceTimeMs: null, observedAtMs, contentSha256: sha256CanonicalJson(content) };
}

/**
 * Builds the BASE (non-pending) `PortfolioExposureSnapshot` from durable
 * `OPEN` pair-slot rows only — no live market evidence, no network I/O (V2
 * §11). Notional is the entry-time-fixed `quantity * averageEntryPriceInr`,
 * never a live mark-based figure (none is available inside an account
 * transaction). C3's own `#overlayPending` (`src/dispatch/admission.ts`)
 * folds currently-ADMITTED reservations on top of this at evaluation time —
 * this function deliberately never computes `pending` itself.
 */
export function buildBaseExposureSnapshot(
  accountId: string,
  openPositions: readonly { readonly pair: string; readonly strategyId: string; readonly quantity: string; readonly averageEntryPriceInr: string }[],
  observedAtMs: number,
): PortfolioExposureSnapshot {
  let global = riskDecimal('0');
  const perPair = new Map<string, ReturnType<typeof riskDecimal>>();
  const perStrategy = new Map<string, ReturnType<typeof riskDecimal>>();
  for (const position of openPositions) {
    const notional = riskDecimal(position.quantity).mul(position.averageEntryPriceInr);
    global = global.plus(notional);
    perPair.set(position.pair, (perPair.get(position.pair) ?? riskDecimal('0')).plus(notional));
    perStrategy.set(position.strategyId, (perStrategy.get(position.strategyId) ?? riskDecimal('0')).plus(notional));
  }
  const canonical = (value: ReturnType<typeof riskDecimal>): string => canonicalDecimalString(value.toFixed());
  const content = {
    accountId,
    globalOpenNotionalInr: canonical(global),
    perPairOpenNotionalInr: Object.fromEntries([...perPair].map(([k, v]) => [k, canonical(v)])),
    perStrategyOpenNotionalInr: Object.fromEntries([...perStrategy].map(([k, v]) => [k, canonical(v)])),
    concurrentOpenPositions: openPositions.length,
  };
  return Object.freeze({
    ...content,
    pending: { status: 'UNKNOWN' as const },
    provenance: provenance('PAPER_POSITION_PROJECTION_V1', observedAtMs, content),
  });
}

/**
 * Account ownership, fencing, and coherent-snapshot repository (V2 §16/§17/§18).
 *
 * Fencing model: `PaperAccount` (P14-C, frozen, unchanged) carries only
 * `ownerFence`/`revision` — no persisted owner identity, no lease-expiry
 * column. This is a deliberate, evidence-grounded reading of the frozen
 * schema, not an invented shortcut: acquisition is therefore unconditional at
 * the DB layer (it always succeeds and always returns a strictly fresh,
 * monotonically higher fence) — safety comes entirely from every subsequent
 * ownership-sensitive write re-verifying its held fence against the row's
 * current value under `SELECT ... FOR UPDATE`, in the same transaction as the
 * write (the classic fencing-token pattern). *Liveness* (deciding whether a
 * previous owner's process is actually gone) is explicitly out of scope here
 * and left to the caller/process-supervision layer — P14-D does not invent a
 * distributed coordination system. No time-based lease/renewal is
 * implemented because none exists in the frozen P14-C schema.
 */
export class PaperAccountRepository {
  readonly #prisma: PrismaClient;
  readonly #clock: Clock;
  readonly #released = new WeakSet<PaperAccountOwnership>();

  public constructor(prismaClient: PrismaClient = defaultPrisma, clock: Clock = new SystemClock()) {
    this.#prisma = prismaClient;
    this.#clock = clock;
  }

  /** Idempotent — never overwrites an already-initialized account's economic state. */
  public async ensureAccountInitialized(accountId: string, startingCapitalInr: string): Promise<void> {
    if (accountId.trim() === '') throw new PaperPersistenceError('ACCOUNT_NOT_FOUND', 'accountId must be non-empty');
    await this.#prisma.paperAccount.upsert({
      where: { accountId },
      create: {
        accountId,
        startingCapitalInr: new Prisma.Decimal(startingCapitalInr),
        peakEquityInr: new Prisma.Decimal(startingCapitalInr),
      },
      update: {},
    });
  }

  /**
   * Unconditionally acquires a fresh, monotonically-higher fence for
   * `accountId`. Locks the canonical account row for the duration of this one
   * transaction (V2 §16 steps 2-3), increments `ownerFence`/`revision`
   * atomically, and returns an immutable capability — never exposes the raw
   * `ownerFence` mutation to callers.
   */
  public async acquireOwnership(accountId: string): Promise<PaperAccountOwnership> {
    return this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT account_id FROM paper_account WHERE account_id = ${accountId} FOR UPDATE`;
      const account = await tx.paperAccount.findUnique({ where: { accountId } });
      if (account === null) {
        throw new PaperPersistenceError('ACCOUNT_NOT_FOUND', `No paper_account row for ${accountId} — call ensureAccountInitialized first`);
      }
      const nextFence = account.ownerFence + 1n;
      await tx.paperAccount.update({ where: { accountId }, data: { ownerFence: nextFence, revision: { increment: 1n } } });
      return issueAccountOwnership({ accountId, fence: nextFence });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  /**
   * Explicit, in-process invalidation of a held capability (V2 §16 step 11 —
   * "only then allow next account operation"). No DB write occurs: there is
   * no persisted owner identity to clear, and the next `acquireOwnership`
   * call is unconditional regardless. This exists so a caller cannot
   * accidentally keep mutating with a capability it has already declared
   * done with.
   */
  public releaseOwnership(ownership: PaperAccountOwnership): void {
    const record = PaperAccountOwnership.read(ownership);
    if (record === null) throw new PaperPersistenceError('NOT_OWNER', 'Caller-shaped ownership object is not genuine');
    this.#released.add(ownership);
  }

  /**
   * Throws (fail-closed) unless `ownership` is genuine and not released.
   * Returns the validated `{accountId, fence}` record. Exported for reuse by
   * sibling P14-D repositories (reservation/pair-slot mutation) so every
   * ownership-sensitive write starts from the same genuineness check — the
   * actual current-fence-in-DB comparison still happens separately, inside
   * each write's own `SELECT ... FOR UPDATE` transaction, never trusted from
   * this in-memory check alone.
   */
  public assertFence(ownership: PaperAccountOwnership): PaperAccountOwnershipRecord {
    const record = PaperAccountOwnership.read(ownership);
    if (record === null) throw new PaperPersistenceError('NOT_OWNER', 'Caller-shaped ownership object is not genuine');
    if (this.#released.has(ownership)) throw new PaperPersistenceError('NOT_OWNER', 'Ownership has already been released');
    return record;
  }

  /**
   * One coherent, fence-verified read (V2 §9/§10/§17): re-locks the account
   * row, rejects a stale fence, and reads reservations/pair-slots inside the
   * same transaction — never a composite of separate unlocked queries. No
   * network I/O occurs (V2 §11).
   */
  public async loadCoherentSnapshot(ownership: PaperAccountOwnership): Promise<PaperAccountSnapshot> {
    const record = this.assertFence(ownership);
    const observedAtMs = this.#clock.nowMs();
    return this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT account_id FROM paper_account WHERE account_id = ${record.accountId} FOR UPDATE`;
      const account = await tx.paperAccount.findUnique({ where: { accountId: record.accountId } });
      if (account === null) throw new PaperPersistenceError('ACCOUNT_NOT_FOUND', `No paper_account row for ${record.accountId}`);
      if (account.ownerFence !== record.fence) {
        throw new PaperPersistenceError('STALE_FENCE', `Held fence ${record.fence} no longer matches current ${account.ownerFence} for ${record.accountId}`);
      }
      const reservations = await tx.paperReservation.findMany({ where: { accountId: record.accountId, status: 'ADMITTED' } });
      const pairSlots = await tx.paperPosition.findMany({ where: { accountId: record.accountId } });
      const snapshot: PaperAccountSnapshot = Object.freeze({
        accountId: record.accountId,
        fence: account.ownerFence,
        revision: account.revision,
        startingCapitalInr: decimalToString(account.startingCapitalInr),
        cumulativeRealizedPnlInr: decimalToString(account.cumulativeRealizedPnlInr),
        cumulativeFeesInr: decimalToString(account.cumulativeFeesInr),
        cumulativeFundingInr: decimalToString(account.cumulativeFundingInr),
        peakEquityInr: decimalToString(account.peakEquityInr),
        consecutiveLossCount: account.consecutiveLossCount,
        cooldownActiveUntilMs: account.cooldownActiveUntilMs === null ? null : Number(account.cooldownActiveUntilMs),
        admittedReservations: Object.freeze(reservations.map((r) => Object.freeze({
          admissionId: r.admissionId, riskDecisionId: r.riskDecisionId, sourceStrategyDecisionId: r.sourceStrategyDecisionId,
          strategyInstanceId: r.strategyInstanceId, strategyId: r.strategyId, strategyVersion: r.strategyVersion, parameterHash: r.parameterHash,
          pair: r.pair, decisionSequence: r.decisionSequence, direction: r.direction, approvedNotionalInr: decimalToString(r.approvedNotionalInr),
          approvedMarginInr: decimalToString(r.approvedMarginInr), generation: r.generation,
        }))),
        pairSlots: Object.freeze(pairSlots.map((p) => Object.freeze({
          pair: p.pair, status: p.status, admissionId: p.admissionId, positionInstanceId: p.positionInstanceId, revision: p.revision,
          ownerStrategyInstanceId: p.ownerStrategyInstanceId, ownerStrategyId: p.ownerStrategyId, ownerStrategyVersion: p.ownerStrategyVersion,
          ownerParameterHash: p.ownerParameterHash,
        }))),
        observedAtMs,
      });
      return snapshot;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
