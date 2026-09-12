import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../persistence/prisma';
import { RiskAdmissionCoordinator, type AdmissionRecord, type AdmissionRequest } from '../../dispatch';
import { PaperAccountOwnership } from './account-ownership';
import { PaperPersistenceError } from './errors';

/**
 * [P14-D MAJ-01] Internal-only proof that a call to `admitAndPersist`/
 * `releaseAndPersist` originates from a `PaperAccountSession` that has
 * already completed restore and is READY (see `paper-account-session.ts`).
 * Deliberately NOT exported from `src/execution/persistence/index.ts` — a
 * caller holding only a raw `PaperAccountOwnership` (e.g. straight from
 * `PaperAccountRepository.acquireOwnership`) cannot produce this token and
 * therefore cannot drive durable admission/release without having gone
 * through session restore first. `PaperAdmissionBridge` itself may remain
 * importable by its concrete module path for internal/lower-level tests —
 * the proof requirement is the actual bypass guard, not the barrel omission.
 */
export const SESSION_PROOF = Symbol('P14-D session-ready proof — only a READY PaperAccountSession may drive PaperAdmissionBridge');

function assertSessionProof(proof: unknown): void {
  if (proof !== SESSION_PROOF) {
    throw new PaperPersistenceError('NOT_OWNER', 'PaperAdmissionBridge may only be driven by a READY PaperAccountSession (post-restore)');
  }
}

export type AdmitAndPersistResult =
  | { readonly outcome: 'ADMITTED'; readonly admission: AdmissionRecord }
  | { readonly outcome: 'SOURCE_DECISION_ALREADY_EXECUTED' }
  | { readonly outcome: 'PAIR_SLOT_UNAVAILABLE' }
  | { readonly outcome: 'RISK_REJECTED' }
  | { readonly outcome: 'NOT_CAPACITY_TRACKED' }
  | { readonly outcome: 'STALE_DECISION_SEQUENCE' };

function toDecimal(value: string): Prisma.Decimal { return new Prisma.Decimal(value); }
function decimalToString(value: Prisma.Decimal): string { return value.toFixed(); }

function admissionRecordFromRow(row: {
  readonly admissionId: string; readonly accountId: string; readonly riskDecisionId: string; readonly sourceStrategyDecisionId: string;
  readonly strategyInstanceId: string; readonly strategyId: string; readonly strategyVersion: string; readonly parameterHash: string;
  readonly pair: string; readonly decisionSequence: number; readonly direction: 'LONG' | 'SHORT';
  readonly approvedNotionalInr: Prisma.Decimal; readonly approvedMarginInr: Prisma.Decimal; readonly generation: number;
  readonly status: 'ADMITTED' | 'RELEASED' | 'CONSUMED';
}): AdmissionRecord {
  return Object.freeze({
    admissionId: row.admissionId, generation: row.generation, accountId: row.accountId, riskDecisionId: row.riskDecisionId,
    sourceStrategyDecisionId: row.sourceStrategyDecisionId, strategyInstanceId: row.strategyInstanceId, strategyId: row.strategyId,
    strategyVersion: row.strategyVersion, parameterHash: row.parameterHash, pair: row.pair, decisionSequence: row.decisionSequence,
    direction: row.direction, approvedNotionalInr: decimalToString(row.approvedNotionalInr), approvedMarginInr: decimalToString(row.approvedMarginInr),
    status: row.status === 'CONSUMED' ? 'RELEASED' : row.status, // AdmissionRecord.status is only 'ADMITTED' | 'RELEASED' (Phase13 contract) — CONSUMED is a P14-only extension; a consumed reservation no longer holds live capacity, so it is reported as released for that purpose.
  });
}

/** Fails closed on any internal inconsistency — a persisted row is never blindly trusted (V2.2 §35). */
function assertReservationConsistency(record: AdmissionRecord, expectedAccountId: string): void {
  if (record.accountId !== expectedAccountId) throw new PaperPersistenceError('DURABLE_CONFLICT', 'Reservation accountId does not match the owning account');
  if (record.admissionId.length === 0 || record.riskDecisionId.length === 0 || record.sourceStrategyDecisionId.length === 0) {
    throw new PaperPersistenceError('RESTORE_MALFORMED', 'Reservation row is missing required identity fields');
  }
  if (!Number.isSafeInteger(record.generation) || record.generation < 1) throw new PaperPersistenceError('RESTORE_MALFORMED', 'Reservation generation must be a positive safe integer');
  if (!Number.isSafeInteger(record.decisionSequence) || record.decisionSequence < 0) throw new PaperPersistenceError('RESTORE_MALFORMED', 'Reservation decisionSequence must be a non-negative safe integer');
}

/**
 * Bridges genuine C3 risk admission to durable P14-C persistence (V2.2 §1/§2,
 * V2.3 §3-§6). The only production path that may create an OPEN
 * `paper_reservation` row. `request` must already carry the caller's fully
 * assembled, genuine `AdmissionRequest` (research approval + kernel origin
 * already verified upstream, per P14-A's `mintPaperOpenExecutionAuthority`
 * composition, or an equivalent genuine composition the caller owns) — this
 * bridge does not itself construct research/strategy evidence; it persists
 * whatever the real, injected `RiskAdmissionCoordinator` genuinely decides.
 * There is no path here that accepts a caller-supplied `AdmissionOutcome` or
 * fabricated `AdmissionRecord` as trusted input.
 */
export class PaperAdmissionBridge {
  readonly #prisma: PrismaClient;

  public constructor(prismaClient: PrismaClient = defaultPrisma) {
    this.#prisma = prismaClient;
  }

  /**
   * Implements the frozen V2.2 corrected OPEN admission sequence up to (and
   * not beyond) a durable reservation: account-fence verification, pair-slot
   * lock, the V2.3 terminal-fill pre-check, the V2.2 pair-slot
   * EMPTY/self-retry gate — all BEFORE `coordinator.admit()` is ever called —
   * then, only on a genuine `ADMITTED` outcome, persists the reservation and
   * transitions the pair slot to `PENDING` in the same transaction. A losing
   * pair-slot contender never calls `coordinator.admit()` and never creates a
   * `paper_reservation` row (V2.2 §1) — no fabricated audit fact is written
   * here either; that belongs to observability/logging, not this schema.
   *
   * Does NOT create `PaperExecutionIntent`/`PaperOrder`/`PaperFill` — P14-D
   * ends at this durable reservation boundary (P14-E owns everything past it).
   *
   * [P14-D BLK-01] `coordinator.admit()` runs inside this same transaction,
   * BEFORE the reservation/pair-slot DB writes and BEFORE commit — so it is
   * possible for it to mutate the coordinator's in-memory state and then have
   * a later step in this same call fail (a DB write, or the transaction's own
   * commit acknowledgement). Any such failure is OUTCOME-AMBIGUOUS: this
   * function cannot tell whether the surrounding transaction actually
   * committed or rolled back. It therefore never attempts to guess or to
   * blindly roll back the coordinator's memory — it rethrows
   * `ADMISSION_OUTCOME_AMBIGUOUS`, and the caller (`PaperAccountSession`) is
   * responsible for treating the account as FAULTED until an authoritative
   * durable restore resolves it.
   */
  public async admitAndPersist(
    sessionProof: symbol,
    ownership: PaperAccountOwnership,
    pair: string,
    request: AdmissionRequest,
    coordinator: RiskAdmissionCoordinator,
  ): Promise<AdmitAndPersistResult> {
    assertSessionProof(sessionProof);
    const held = PaperAccountOwnership.read(ownership);
    if (held === null) throw new PaperPersistenceError('NOT_OWNER', 'Caller-shaped ownership object is not genuine');
    if (held.accountId !== request.accountId) throw new PaperPersistenceError('NOT_OWNER', 'Ownership accountId does not match the admission request accountId');
    const sourceStrategyDecisionId = request.context.candidate.strategyDecision.decisionId;
    if (request.context.candidate.pair !== pair) throw new PaperPersistenceError('DURABLE_CONFLICT', 'pair argument does not match the candidate pair bound into the request');

    let coordinatorMutated = false;
    try {
      return await this.#prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT account_id FROM paper_account WHERE account_id = ${held.accountId} FOR UPDATE`;
        const account = await tx.paperAccount.findUnique({ where: { accountId: held.accountId } });
        if (account === null) throw new PaperPersistenceError('ACCOUNT_NOT_FOUND', `No paper_account row for ${held.accountId}`);
        if (account.ownerFence !== held.fence) throw new PaperPersistenceError('STALE_FENCE', `Held fence ${held.fence} no longer matches current ${account.ownerFence}`);

        await tx.$executeRaw`SELECT account_id FROM paper_position WHERE account_id = ${held.accountId} AND pair = ${pair} FOR UPDATE`;
        const slot = await tx.paperPosition.findUnique({ where: { accountId_pair: { accountId: held.accountId, pair } } });
        if (slot === null) {
          throw new PaperPersistenceError('PAIR_SLOT_UNAVAILABLE', `No pre-provisioned paper_position slot for (${held.accountId}, ${pair}) — pair onboarding must provision it first`);
        }

        // V2.3 terminal check — before fabricating anything, before calling admit().
        const terminalFill = await tx.paperFill.findUnique({ where: { accountId_sourceStrategyDecisionId: { accountId: held.accountId, sourceStrategyDecisionId } } });
        if (terminalFill !== null) return { outcome: 'SOURCE_DECISION_ALREADY_EXECUTED' as const };

        // V2.2 §4 self-retry exception: the slot may be non-EMPTY only if it is
        // already claimed by this exact source decision (a retry of the same
        // in-flight/completed attempt), never a genuinely different contender.
        if (slot.status !== 'EMPTY') {
          const claimant = slot.admissionId === null ? null : await tx.paperReservation.findUnique({ where: { admissionId: slot.admissionId } });
          if (claimant === null || claimant.sourceStrategyDecisionId !== sourceStrategyDecisionId) {
            return { outcome: 'PAIR_SLOT_UNAVAILABLE' as const };
          }
        }

        const outcome = await coordinator.admit(request);
        if (outcome.status === 'ADMITTED') coordinatorMutated = true;
        if (outcome.status === 'REJECTED') return { outcome: 'RISK_REJECTED' as const };
        if (outcome.status === 'STALE_DECISION_SEQUENCE') return { outcome: 'STALE_DECISION_SEQUENCE' as const };
        if (outcome.status === 'ACCEPTED_NO_CAPACITY_OWNERSHIP') return { outcome: 'NOT_CAPACITY_TRACKED' as const };
        // outcome.status === 'ADMITTED' from here — coordinatorMutated is now true;
        // any throw below this point is outcome-ambiguous, never a clean rejection.
        assertReservationConsistency(outcome.admission, held.accountId);
        const admission = outcome.admission;

        await tx.paperReservation.upsert({
          where: { admissionId: admission.admissionId },
          create: {
            admissionId: admission.admissionId, accountId: admission.accountId, riskDecisionId: admission.riskDecisionId,
            sourceStrategyDecisionId: admission.sourceStrategyDecisionId, strategyInstanceId: admission.strategyInstanceId,
            strategyId: admission.strategyId, strategyVersion: admission.strategyVersion, parameterHash: admission.parameterHash,
            pair: admission.pair, decisionSequence: admission.decisionSequence, direction: admission.direction,
            approvedNotionalInr: toDecimal(admission.approvedNotionalInr), approvedMarginInr: toDecimal(admission.approvedMarginInr),
            generation: admission.generation, status: 'ADMITTED',
          },
          update: {}, // Idempotent: an existing row for this exact admissionId is byte-identical by construction (admissionId is a content hash) — never mutated here.
        });

        await tx.paperPosition.update({
          where: { accountId_pair: { accountId: held.accountId, pair } },
          data: {
            status: 'PENDING', admissionId: admission.admissionId, ownerStrategyInstanceId: admission.strategyInstanceId,
            ownerStrategyId: admission.strategyId, ownerStrategyVersion: admission.strategyVersion, ownerParameterHash: admission.parameterHash,
            revision: { increment: 1 },
          },
        });

        return { outcome: 'ADMITTED' as const, admission };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (cause) {
      if (coordinatorMutated) {
        throw new PaperPersistenceError(
          'ADMISSION_OUTCOME_AMBIGUOUS',
          `Durable admission commit is unconfirmed for account ${held.accountId} after in-memory admission was already granted — the account must be treated as FAULTED until an authoritative restore resolves it`,
          { cause: cause instanceof Error ? cause : undefined },
        );
      }
      throw cause;
    }
  }

  /**
   * Mirrors `RiskAdmissionCoordinator.release`: marks the durable reservation
   * `RELEASED` and, only if the pair slot is still `PENDING` for that exact
   * `admissionId` (never a slot a later admission has already moved past),
   * resets it to `EMPTY` — atomically, fence-protected.
   *
   * [P14-D BLK-01] Same outcome-ambiguity handling as `admitAndPersist`:
   * `coordinator.release()` runs inside this transaction before the durable
   * writes/commit, so a failure after it returns `RELEASED` is rethrown as
   * `ADMISSION_OUTCOME_AMBIGUOUS` rather than assumed rolled back.
   */
  public async releaseAndPersist(
    sessionProof: symbol, ownership: PaperAccountOwnership, admissionId: string, coordinator: RiskAdmissionCoordinator,
  ): Promise<'RELEASED' | 'ALREADY_RELEASED' | 'UNKNOWN_ADMISSION'> {
    assertSessionProof(sessionProof);
    const held = PaperAccountOwnership.read(ownership);
    if (held === null) throw new PaperPersistenceError('NOT_OWNER', 'Caller-shaped ownership object is not genuine');

    let coordinatorMutated = false;
    try {
      return await this.#prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT account_id FROM paper_account WHERE account_id = ${held.accountId} FOR UPDATE`;
        const account = await tx.paperAccount.findUnique({ where: { accountId: held.accountId } });
        if (account === null) throw new PaperPersistenceError('ACCOUNT_NOT_FOUND', `No paper_account row for ${held.accountId}`);
        if (account.ownerFence !== held.fence) throw new PaperPersistenceError('STALE_FENCE', `Held fence ${held.fence} no longer matches current ${account.ownerFence}`);

        const reservation = await tx.paperReservation.findUnique({ where: { admissionId } });
        if (reservation === null || reservation.accountId !== held.accountId) return 'UNKNOWN_ADMISSION' as const;
        if (reservation.status === 'RELEASED') return 'ALREADY_RELEASED' as const;
        if (reservation.status === 'CONSUMED') {
          throw new PaperPersistenceError('DURABLE_CONFLICT', `Cannot release a CONSUMED reservation (${admissionId})`);
        }

        const released = await coordinator.release(held.accountId, admissionId);
        if (released.status === 'UNKNOWN_ADMISSION') {
          throw new PaperPersistenceError('DURABLE_CONFLICT', `Durable reservation ${admissionId} exists but C3 has no matching in-memory admission — restore may be required`);
        }
        if (released.status === 'RELEASED') coordinatorMutated = true;
        // From here on, any throw is outcome-ambiguous whenever coordinatorMutated is true.

        await tx.paperReservation.update({ where: { admissionId }, data: { status: 'RELEASED' } });
        await tx.$executeRaw`SELECT account_id FROM paper_position WHERE account_id = ${held.accountId} AND pair = ${reservation.pair} FOR UPDATE`;
        const slot = await tx.paperPosition.findUnique({ where: { accountId_pair: { accountId: held.accountId, pair: reservation.pair } } });
        if (slot !== null && slot.status === 'PENDING' && slot.admissionId === admissionId) {
          await tx.paperPosition.update({
            where: { accountId_pair: { accountId: held.accountId, pair: reservation.pair } },
            data: { status: 'EMPTY', admissionId: null, ownerStrategyInstanceId: null, ownerStrategyId: null, ownerStrategyVersion: null, ownerParameterHash: null, revision: { increment: 1 } },
          });
        }
        return 'RELEASED' as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (cause) {
      if (coordinatorMutated) {
        throw new PaperPersistenceError(
          'ADMISSION_OUTCOME_AMBIGUOUS',
          `Durable release commit is unconfirmed for account ${held.accountId} admission ${admissionId} after in-memory release was already granted — the account must be treated as FAULTED until an authoritative restore resolves it`,
          { cause: cause instanceof Error ? cause : undefined },
        );
      }
      throw cause;
    }
  }
}

export { admissionRecordFromRow, assertReservationConsistency };
