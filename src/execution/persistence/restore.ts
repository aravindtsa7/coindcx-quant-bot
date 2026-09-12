import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../persistence/prisma';
import { RiskAdmissionCoordinator, type AdmissionSequenceWatermark } from '../../dispatch';
// [P14-D BLK-01] Internal, non-barrel import — deliberately not re-exported
// from `src/dispatch/index.ts` (see admission.ts). Only this file needs it,
// to route a FAULTED account's session-open through the authoritative
// replacement path instead of ordinary (reject-on-nonempty) restore.
import { ACCOUNT_FAULT_RECOVERY_CAPABILITY } from '../../dispatch/admission';
import { PaperAccountOwnership } from './account-ownership';
import { admissionRecordFromRow, assertReservationConsistency } from './admission-bridge';
import { PaperPersistenceError } from './errors';

export interface RestoreResult {
  readonly accountId: string;
  readonly restoredReservationCount: number;
  readonly restoredWatermarkCount: number;
  /** True only when this restore recovered a previously-FAULTED account via the authoritative replacement path (V2-D §5), never for an ordinary cold-start restore. */
  readonly recoveredFromFault: boolean;
}

/**
 * Startup restoration (V2 §18/§20/§21): reconstructs C3's durable pending
 * admission state for one account from `paper_reservation` before that
 * account may accept any new `admit()` call. Only `status = 'ADMITTED'` rows
 * feed live capacity (V2 §20 — a released/consumed admission's capacity is
 * never resurrected); the decision-sequence watermark is computed from EVERY
 * historical row for the instance regardless of status, since a prior
 * genuine admission always advanced it, whatever became of it since (a prior
 * rejection never reaches this table at all, so every row here is
 * watermark-eligible by construction). Fence-verified: re-locks the account
 * row before reading, so a stale ownership can never publish a restoration
 * for an account another process has since taken over. Fails closed
 * (`RESTORE_MALFORMED`) on any internally-inconsistent row rather than
 * trusting it — a persisted row's mere existence proves nothing on its own
 * (V2.2 §35).
 */
export async function restoreAccountAdmissionState(
  ownership: PaperAccountOwnership,
  coordinator: RiskAdmissionCoordinator,
  prismaClient: PrismaClient = defaultPrisma,
): Promise<RestoreResult> {
  const held = PaperAccountOwnership.read(ownership);
  if (held === null) throw new PaperPersistenceError('NOT_OWNER', 'Caller-shaped ownership object is not genuine');

  const { admittedRows, allRows } = await prismaClient.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT account_id FROM paper_account WHERE account_id = ${held.accountId} FOR UPDATE`;
    const account = await tx.paperAccount.findUnique({ where: { accountId: held.accountId } });
    if (account === null) throw new PaperPersistenceError('ACCOUNT_NOT_FOUND', `No paper_account row for ${held.accountId}`);
    if (account.ownerFence !== held.fence) {
      throw new PaperPersistenceError('STALE_FENCE', `Held fence ${held.fence} no longer matches current ${account.ownerFence} for ${held.accountId}`);
    }
    const admitted = await tx.paperReservation.findMany({ where: { accountId: held.accountId, status: 'ADMITTED' } });
    const all = await tx.paperReservation.findMany({ where: { accountId: held.accountId }, select: { strategyInstanceId: true, decisionSequence: true } });
    return { admittedRows: admitted, allRows: all };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

  const admittedRecords = admittedRows.map((row) => {
    const record = admissionRecordFromRow(row);
    assertReservationConsistency(record, held.accountId);
    return record;
  });

  const watermarkByInstance = new Map<string, number>();
  for (const row of allRows) {
    const current = watermarkByInstance.get(row.strategyInstanceId) ?? 0;
    if (row.decisionSequence > current) watermarkByInstance.set(row.strategyInstanceId, row.decisionSequence);
  }
  const sequenceWatermarks: readonly AdmissionSequenceWatermark[] = Object.freeze(
    [...watermarkByInstance].map(([strategyInstanceId, latestDecisionSequence]) => Object.freeze({ strategyInstanceId, latestDecisionSequence })),
  );

  // [P14-D BLK-01] A FAULTED account (see PaperAdmissionBridge/PaperAccountSession)
  // can never be brought back by ordinary restore (which requires an empty
  // in-memory projection) — it requires the authoritative replacement path,
  // which discards whatever uncertain state the fault left behind in favor of
  // this freshly re-read, fence-verified durable batch. A non-faulted account
  // takes the exact ordinary-restore path this function has always used, so
  // behavior for every pre-existing caller/test is unchanged.
  const isRecovery = coordinator.isAccountFaulted(held.accountId);
  try {
    if (isRecovery) {
      await coordinator.restoreAuthoritative(ACCOUNT_FAULT_RECOVERY_CAPABILITY, held.accountId, admittedRecords, sequenceWatermarks);
    } else {
      await coordinator.restore(held.accountId, admittedRecords, sequenceWatermarks);
    }
  } catch (cause) {
    throw new PaperPersistenceError('DURABLE_CONFLICT', `C3 restore rejected the durable admission state for ${held.accountId}`, { cause });
  }

  return {
    accountId: held.accountId, restoredReservationCount: admittedRecords.length, restoredWatermarkCount: sequenceWatermarks.length,
    recoveredFromFault: isRecovery,
  };
}
