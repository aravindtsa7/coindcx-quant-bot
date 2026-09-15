import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../persistence/prisma';
import { sha256CanonicalJson } from '../../risk';
import { quantizePaperPosting } from '../accounting';
import { paperDecimal } from '../decimal';
import { computePositionInstanceId } from '../identity';
import { PAPER_FUNDING_CAPABILITY, type PaperFundingDisclosure } from '../funding-capability';
import { SystemClock, type Clock } from './account-repository';
import { replayLossState, type PaperLossStatePolicy } from './durable-risk-state';
import { PaperPersistenceError } from './errors';
import { executionPolicySnapshotFromRow, instrumentEconomicsSnapshotFromRow } from './immutable-snapshots';

/**
 * [P14-H] Paper durable reconciliation / account health.
 *
 * Read-only fact/projection verification against durable MySQL state for one
 * paper account (V2 §23 reconciliation hierarchy: `PaperFill`/
 * `PaperLedgerEntry` are Tier-1 authoritative facts; `PaperAccount`/
 * `PaperPosition` cumulative fields are Tier-2 rebuildable/cached
 * projections). A detected mismatch is classified and persisted as a
 * `PaperReconciliationFault` row — it is NEVER repaired. This module never
 * writes to `PaperAccount`, `PaperPosition`, `PaperReservation`,
 * `PaperExecutionIntent`, `PaperOrder`, `PaperFill`,
 * `PaperPositionOwnershipHistory`, or `PaperLedgerEntry`; the only table it
 * ever mutates is `PaperReconciliationFault`, and only to append fault
 * evidence, never to alter/delete a prior fault fact.
 *
 * Scope: PAPER-vs-PAPER internal consistency only. This never reconciles
 * against real CoinDCX positions/fills/funding/wallet balance — zero
 * provider/network calls occur here. A `HEALTHY` result means "internally
 * consistent with currently supported paper accounting," never "funding-
 * complete" or "production-promotion-eligible" — P14-F's funding-unsupported
 * disclosure and promotion gate are untouched and unaffected by this module.
 */

// ---------------------------------------------------------------------------
// Fault taxonomy and result shapes
// ---------------------------------------------------------------------------

/** Stable, machine-readable fault categories (§22 — deliberately coarse; the `evidence` payload carries the specific discriminating detail). */
export type PaperReconciliationFaultType =
  | 'ACCOUNT_LEDGER_MISMATCH'
  | 'FUNDING_INVARIANT_VIOLATION'
  | 'POSITION_STATE_MISMATCH'
  | 'RESERVATION_STATE_MISMATCH'
  | 'ORDER_FILL_MISMATCH'
  | 'OWNERSHIP_HISTORY_MISMATCH'
  /** [F14-01] Durable §12.4/§12.5 risk state contradicted by the account's own committed economic history. */
  | 'RISK_STATE_MISMATCH';

export interface PaperAccountReconciliationIssue {
  readonly faultId: string;
  readonly faultType: PaperReconciliationFaultType;
  readonly pair: string | null;
  readonly positionInstanceId: string | null;
  readonly admissionId: string | null;
  readonly message: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export type PaperAccountReconciliationStatus = 'HEALTHY' | 'UNHEALTHY';

export interface PaperAccountReconciliationResult {
  readonly accountId: string;
  readonly status: PaperAccountReconciliationStatus;
  /** The `PaperAccount.ownerFence` observed at read time — never acquired/incremented by this module (§34: durable-snapshot-scoped, not a competing ownership). */
  readonly ownerFence: bigint;
  readonly revision: bigint;
  readonly observedAtMs: number;
  readonly issues: readonly PaperAccountReconciliationIssue[];
  /** Reconciliation health never implies funding/economic completeness (§30). */
  readonly fundingDisclosure: PaperFundingDisclosure;
}

/**
 * [F14-01 §22] Optional inputs for the checks that cannot be derived from
 * durable state alone.
 *
 * `consecutiveLossCount` and the peak lower bound are both fully derivable from
 * committed economic history, so they are always checked. The cooldown BOUNDARY
 * is not: it is a function of the configured `consecutiveLossLimit`/`cooldownMs`,
 * which are policy, not durable account facts. Supply them and the cooldown is
 * checked too; omit them and it is deliberately left unverified rather than
 * guessed.
 */
export interface PaperReconcileOptions {
  readonly lossStatePolicy?: PaperLossStatePolicy;
}

const FAULT_IDENTITY_POLICY_ID = 'P14_H_RECONCILIATION_FAULT_IDENTITY_V1';

/**
 * Deterministic, content-addressed fault identity — reruns against unchanged
 * durable state produce the same id (idempotent `upsert`, §26); a materially
 * different subsequent observation (different evidence) produces a fresh,
 * additional immutable fact rather than overwriting the earlier one (§27/§28).
 * `detectedAtMs`/wall-clock time is deliberately EXCLUDED from this hash — it
 * is stored metadata, never part of the health/identity determination (§21).
 */
function computeReconciliationFaultId(input: {
  readonly accountId: string;
  readonly faultType: PaperReconciliationFaultType;
  readonly pair: string | null;
  readonly positionInstanceId: string | null;
  readonly admissionId: string | null;
  readonly evidence: Readonly<Record<string, unknown>>;
}): string {
  return sha256CanonicalJson({ identityPolicyId: FAULT_IDENTITY_POLICY_ID, ...input });
}

interface Builder {
  readonly accountId: string;
  readonly issues: PaperAccountReconciliationIssue[];
}

function addIssue(
  builder: Builder,
  faultType: PaperReconciliationFaultType,
  subject: { readonly pair?: string | null; readonly positionInstanceId?: string | null; readonly admissionId?: string | null },
  message: string,
  evidence: Readonly<Record<string, unknown>>,
): void {
  const pair = subject.pair ?? null;
  const positionInstanceId = subject.positionInstanceId ?? null;
  const admissionId = subject.admissionId ?? null;
  const faultId = computeReconciliationFaultId({ accountId: builder.accountId, faultType, pair, positionInstanceId, admissionId, evidence });
  builder.issues.push(Object.freeze({ faultId, faultType, pair, positionInstanceId, admissionId, message, evidence: Object.freeze({ ...evidence }) }));
}

/**
 * [P14-H] Reusable, account-scoped PAPER reconciliation/health reader.
 * Constructor-injectable `prisma`/`clock`, mirroring
 * `PaperAccountRepository`/`PaperExecutionEngine`/`PaperAccountKernel`'s own
 * convention. Reusable from a future P14-I composition layer; builds/owns no
 * daemon, scheduler, or continuous loop itself (§57).
 */
export class PaperAccountReconciler {
  readonly #prisma: PrismaClient;
  readonly #clock: Clock;

  public constructor(prismaClient: PrismaClient = defaultPrisma, clock: Clock = new SystemClock()) {
    this.#prisma = prismaClient;
    this.#clock = clock;
  }

  /**
   * Runs one coherent, account-scoped reconciliation pass and returns an
   * immutable result. Persists any detected mismatch as a
   * `PaperReconciliationFault` row (idempotent by content-addressed
   * `faultId`) in the SAME transaction as the read — a healthy account
   * creates no fault row and this call is otherwise side-effect free (§25).
   * Never touches any economic table (§6). Follows the exact frozen P14-D
   * lock ordering (`paper_account` row first, `SELECT ... FOR UPDATE`) so it
   * never inverts against OPEN/CLOSE/admission/restore locking (§5) — but,
   * unlike `acquireOwnership`, never writes `ownerFence`, so a live session
   * elsewhere is never invalidated by running this (§34).
   */
  public async reconcile(accountId: string, options: PaperReconcileOptions = {}): Promise<PaperAccountReconciliationResult> {
    const observedAtMs = this.#clock.nowMs();

    return this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT account_id FROM paper_account WHERE account_id = ${accountId} FOR UPDATE`;
      const account = await tx.paperAccount.findUnique({ where: { accountId } });
      if (account === null) throw new PaperPersistenceError('ACCOUNT_NOT_FOUND', `No paper_account row for ${accountId}`);

      const [positions, reservations, intents, orders, fills, ledgerEntries, history] = await Promise.all([
        tx.paperPosition.findMany({ where: { accountId } }),
        tx.paperReservation.findMany({ where: { accountId } }),
        tx.paperExecutionIntent.findMany({ where: { accountId } }),
        tx.paperOrder.findMany({ where: { accountId } }),
        tx.paperFill.findMany({ where: { accountId } }),
        tx.paperLedgerEntry.findMany({ where: { accountId } }),
        tx.paperPositionOwnershipHistory.findMany({ where: { accountId } }),
      ]);
      // [F14-05] Execution-policy snapshots are a global, content-addressed table
      // (never account-scoped) — fetched only for the specific ids this
      // account's own OPEN intents reference, to recompute leverage/initial-margin
      // facts without any market/network dependency.
      const policySnapshotIds = [...new Set(intents.map((i) => i.executionPolicySnapshotId))];
      const policySnapshots = policySnapshotIds.length === 0 ? [] : await tx.paperExecutionPolicySnapshot.findMany({ where: { executionPolicySnapshotId: { in: policySnapshotIds } } });
      const policySnapshotById = new Map(policySnapshots.map((p) => [p.executionPolicySnapshotId, p]));
      const economicsSnapshotIds = [...new Set(intents.map((i) => i.instrumentEconomicsSnapshotId).filter((id): id is string => id !== null))];
      const economicsSnapshots = economicsSnapshotIds.length === 0 ? [] : await tx.paperInstrumentEconomicsSnapshot.findMany({ where: { instrumentEconomicsSnapshotId: { in: economicsSnapshotIds } } });
      const economicsSnapshotById = new Map(economicsSnapshots.map((p) => [p.instrumentEconomicsSnapshotId, p]));

      const reservationByAdmissionId = new Map(reservations.map((r) => [r.admissionId, r]));
      const intentByAdmissionId = new Map(intents.filter((i) => i.admissionId !== null).map((i) => [i.admissionId as string, i]));
      const orderByIntentId = new Map(orders.map((o) => [o.executionIntentId, o]));
      const fillByOrderId = new Map(fills.map((f) => [f.orderId, f]));
      const positionByPair = new Map(positions.map((p) => [p.pair, p]));
      const intentById = new Map(intents.map((i) => [i.executionIntentId, i]));

      const builder: Builder = { accountId, issues: [] };

      this.#reconcileFunding(builder, account, positions, ledgerEntries);
      this.#reconcileAccountLedger(builder, account, ledgerEntries);
      this.#reconcileEconomicBindings(builder, intents, policySnapshotById, economicsSnapshotById);
      for (const row of history) {
        const opening = intentById.get(row.openingExecutionIntentId);
        const closing = intentById.get(row.closingExecutionIntentId);
        if (opening !== undefined && closing !== undefined && opening.instrumentEconomicsSnapshotId !== closing.instrumentEconomicsSnapshotId) {
          addIssue(builder, 'ORDER_FILL_MISMATCH', { pair: row.pair, positionInstanceId: row.positionInstanceId }, 'CLOSE_INSTRUMENT_ECONOMICS_DIFFERS_FROM_OPEN', {
            openingInstrumentEconomicsSnapshotId: opening.instrumentEconomicsSnapshotId,
            closingInstrumentEconomicsSnapshotId: closing.instrumentEconomicsSnapshotId,
          });
        }
      }
      for (const slot of positions) this.#reconcilePosition(builder, accountId, slot, reservationByAdmissionId, intentByAdmissionId, orderByIntentId, fillByOrderId, policySnapshotById, economicsSnapshotById);
      this.#reconcileOrders(builder, orders, fillByOrderId);
      this.#reconcileTerminalDedup(builder, fills);
      for (const row of history) this.#reconcileHistory(builder, row, fillByOrderId, ledgerEntries, positions);
      this.#reconcileDurableRiskState(builder, account, history, fills, positions, options.lossStatePolicy);
      this.#reconcileReservationsReverse(builder, reservations, positionByPair, intentByAdmissionId, history);
      this.#reconcileCompletedClosesReverse(builder, intents, orderByIntentId, fillByOrderId, history);

      for (const issue of builder.issues) {
        await tx.paperReconciliationFault.upsert({
          where: { faultId: issue.faultId },
          create: {
            faultId: issue.faultId, accountId, faultType: issue.faultType, detectedAtMs: BigInt(observedAtMs),
            evidenceJson: JSON.stringify({ message: issue.message, pair: issue.pair, positionInstanceId: issue.positionInstanceId, admissionId: issue.admissionId, evidence: issue.evidence }),
          },
          update: {},
        });
      }

      return Object.freeze({
        accountId, status: builder.issues.length === 0 ? 'HEALTHY' as const : 'UNHEALTHY' as const,
        ownerFence: account.ownerFence, revision: account.revision, observedAtMs,
        issues: Object.freeze(builder.issues), fundingDisclosure: PAPER_FUNDING_CAPABILITY,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  #reconcileEconomicBindings(
    builder: Builder,
    intents: readonly { readonly executionIntentId: string; readonly action: string; readonly pair: string; readonly admissionId: string | null; readonly positionInstanceId: string | null; readonly executionPolicySnapshotId: string; readonly instrumentEconomicsSnapshotId: string | null }[],
    policies: ReadonlyMap<string, Parameters<typeof executionPolicySnapshotFromRow>[0]>,
    economics: ReadonlyMap<string, Parameters<typeof instrumentEconomicsSnapshotFromRow>[0]>,
  ): void {
    for (const intent of intents) {
      const subject = { pair: intent.pair, admissionId: intent.admissionId, positionInstanceId: intent.positionInstanceId };
      if (intent.instrumentEconomicsSnapshotId === null) {
        addIssue(builder, 'ORDER_FILL_MISMATCH', subject, 'LEGACY_UNVERIFIABLE_INSTRUMENT_ECONOMICS', { executionIntentId: intent.executionIntentId, action: intent.action });
        continue;
      }
      const economicsRow = economics.get(intent.instrumentEconomicsSnapshotId);
      const policyRow = policies.get(intent.executionPolicySnapshotId);
      if (economicsRow === undefined) {
        addIssue(builder, 'ORDER_FILL_MISMATCH', subject, 'INSTRUMENT_ECONOMICS_SNAPSHOT_MISSING', { executionIntentId: intent.executionIntentId, instrumentEconomicsSnapshotId: intent.instrumentEconomicsSnapshotId });
        continue;
      }
      if (policyRow === undefined) {
        addIssue(builder, 'ORDER_FILL_MISMATCH', subject, 'EXECUTION_POLICY_SNAPSHOT_MISSING', { executionIntentId: intent.executionIntentId, executionPolicySnapshotId: intent.executionPolicySnapshotId });
        continue;
      }
      try {
        const economicSnapshot = instrumentEconomicsSnapshotFromRow(economicsRow);
        const policySnapshot = executionPolicySnapshotFromRow(policyRow);
        if (economicSnapshot.pair !== intent.pair) {
          addIssue(builder, 'ORDER_FILL_MISMATCH', subject, 'INSTRUMENT_ECONOMICS_PAIR_MISMATCH', { executionIntentId: intent.executionIntentId, snapshotPair: economicSnapshot.pair });
        }
        if (!paperDecimal(policySnapshot.content.contractMultiplier).equals(paperDecimal(economicSnapshot.contractMultiplier))) {
          addIssue(builder, 'ORDER_FILL_MISMATCH', subject, 'POLICY_MULTIPLIER_INSTRUMENT_ECONOMICS_MISMATCH', { executionIntentId: intent.executionIntentId });
        }
      } catch (error) {
        addIssue(builder, 'ORDER_FILL_MISMATCH', subject, 'CANONICAL_ECONOMIC_SNAPSHOT_VALIDATION_FAILED', {
          executionIntentId: intent.executionIntentId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // §29/§43 — P14-F funding invariant (defense-in-depth alongside the
  // `loadCoherentSnapshot` fail-closed gate; recorded as a durable fault here
  // rather than merely blocking session-open). Never queries/repairs funding.
  // -------------------------------------------------------------------------
  #reconcileFunding(
    builder: Builder,
    account: { readonly cumulativeFundingInr: { readonly isZero: () => boolean; readonly toFixed: () => string } },
    positions: readonly { readonly pair: string; readonly cumulativeFundingInr: { readonly isZero: () => boolean; readonly toFixed: () => string } }[],
    ledgerEntries: readonly { readonly type: string; readonly entryId: string }[],
  ): void {
    if (!account.cumulativeFundingInr.isZero()) {
      addIssue(builder, 'FUNDING_INVARIANT_VIOLATION', {}, 'ACCOUNT_CUMULATIVE_FUNDING_NONZERO', { cumulativeFundingInr: account.cumulativeFundingInr.toFixed() });
    }
    for (const position of positions) {
      if (!position.cumulativeFundingInr.isZero()) {
        addIssue(builder, 'FUNDING_INVARIANT_VIOLATION', { pair: position.pair }, 'POSITION_CUMULATIVE_FUNDING_NONZERO', { pair: position.pair, cumulativeFundingInr: position.cumulativeFundingInr.toFixed() });
      }
    }
    const fundingEntry = ledgerEntries.find((e) => e.type === 'FUNDING');
    if (fundingEntry !== undefined) {
      addIssue(builder, 'FUNDING_INVARIANT_VIOLATION', {}, 'FUNDING_LEDGER_ENTRY_PRESENT', { entryId: fundingEntry.entryId });
    }
  }

  // -------------------------------------------------------------------------
  // §8/§41/§42 — cumulative-projection vs. immutable-ledger-fact reconciliation.
  // Ledger FEE postings are negative (`amountInr: post(feeInr.negated())` in
  // execution-engine.ts); `cumulativeFeesInr` is stored positive, so the
  // expected relationship is `cumulativeFeesInr === -sum(FEE)`.
  // -------------------------------------------------------------------------
  #reconcileAccountLedger(
    builder: Builder,
    account: { readonly cumulativeFeesInr: { readonly toFixed: () => string }; readonly cumulativeRealizedPnlInr: { readonly toFixed: () => string } },
    ledgerEntries: readonly { readonly type: string; readonly amountInr: { readonly toFixed: () => string } }[],
  ): void {
    const feeLedgerSum = ledgerEntries.filter((e) => e.type === 'FEE').reduce((sum, e) => sum.plus(paperDecimal(e.amountInr.toFixed())), paperDecimal('0'));
    const expectedCumulativeFees = feeLedgerSum.negated();
    const actualCumulativeFees = paperDecimal(account.cumulativeFeesInr.toFixed());
    if (!actualCumulativeFees.equals(expectedCumulativeFees)) {
      addIssue(builder, 'ACCOUNT_LEDGER_MISMATCH', {}, 'ACCOUNT_CUMULATIVE_FEES_DOES_NOT_MATCH_LEDGER', {
        field: 'cumulativeFeesInr', actual: actualCumulativeFees.toFixed(), expected: expectedCumulativeFees.toFixed(),
      });
    }

    const pnlLedgerSum = ledgerEntries.filter((e) => e.type === 'REALIZED_PNL').reduce((sum, e) => sum.plus(paperDecimal(e.amountInr.toFixed())), paperDecimal('0'));
    const actualCumulativePnl = paperDecimal(account.cumulativeRealizedPnlInr.toFixed());
    if (!actualCumulativePnl.equals(pnlLedgerSum)) {
      addIssue(builder, 'ACCOUNT_LEDGER_MISMATCH', {}, 'ACCOUNT_CUMULATIVE_REALIZED_PNL_DOES_NOT_MATCH_LEDGER', {
        field: 'cumulativeRealizedPnlInr', actual: actualCumulativePnl.toFixed(), expected: pnlLedgerSum.toFixed(),
      });
    }
  }

  // -------------------------------------------------------------------------
  // §10/§11/§12/§13/§18 — per-slot structural + economic reconciliation,
  // mirroring `paper-account-kernel.ts`'s `rehydratePositions` structural
  // checks exactly, but non-throwing: every mismatch is collected as a fault
  // instead of aborting (P14-G fails a startup; P14-H reports a health fact).
  // -------------------------------------------------------------------------
  #reconcilePosition(
    builder: Builder,
    accountId: string,
    slot: {
      readonly pair: string; readonly status: string; readonly admissionId: string | null; readonly positionInstanceId: string | null;
      readonly side: string | null; readonly quantity: { readonly toFixed: () => string } | null; readonly averageEntryPriceInr: { readonly toFixed: () => string } | null;
      readonly leverage: { readonly toFixed: () => string } | null; readonly initialMarginInr: { readonly toFixed: () => string } | null; readonly openedAtMs: bigint | null;
      readonly cumulativeFeesInr: { readonly toFixed: () => string }; readonly cumulativeRealizedPnlInr: { readonly toFixed: () => string };
      readonly ownerStrategyInstanceId: string | null; readonly ownerStrategyId: string | null; readonly ownerStrategyVersion: string | null; readonly ownerParameterHash: string | null;
    },
    reservationByAdmissionId: ReadonlyMap<string, { readonly accountId: string; readonly pair: string; readonly status: string; readonly direction: string }>,
    intentByAdmissionId: ReadonlyMap<string, {
      readonly executionIntentId: string; readonly action: string; readonly accountId: string; readonly strategyInstanceId: string;
      readonly approvedLeverage: { readonly toFixed: () => string } | null; readonly executionPolicySnapshotId: string; readonly instrumentEconomicsSnapshotId: string | null;
    }>,
    orderByIntentId: ReadonlyMap<string, { readonly executionIntentId: string; readonly state: string }>,
    fillByOrderId: ReadonlyMap<string, { readonly quantity: { readonly toFixed: () => string }; readonly fillPrice: { readonly toFixed: () => string }; readonly feeInr: { readonly toFixed: () => string }; readonly eventTimeMs: bigint }>,
    policySnapshotById: ReadonlyMap<string, { readonly contractMultiplier: { readonly toFixed: () => string } }>,
    economicsSnapshotById: ReadonlyMap<string, { readonly contractMultiplier: { readonly toFixed: () => string } }>,
  ): void {
    const subject = { pair: slot.pair, positionInstanceId: slot.positionInstanceId, admissionId: slot.admissionId };

    if (slot.status === 'EMPTY') {
      if (slot.admissionId !== null || slot.positionInstanceId !== null) {
        addIssue(builder, 'POSITION_STATE_MISMATCH', subject, 'EMPTY_SLOT_RETAINS_CLAIM', { admissionId: slot.admissionId, positionInstanceId: slot.positionInstanceId });
      }
      return;
    }

    if (slot.admissionId === null) {
      addIssue(builder, 'POSITION_STATE_MISMATCH', subject, `${slot.status}_SLOT_MISSING_ADMISSION_ID`, {});
      return;
    }
    const reservation = reservationByAdmissionId.get(slot.admissionId);
    if (reservation === undefined || reservation.accountId !== accountId) {
      addIssue(builder, 'RESERVATION_STATE_MISMATCH', subject, 'NO_MATCHING_DURABLE_RESERVATION', { admissionId: slot.admissionId });
      return;
    }
    if (reservation.pair !== slot.pair) {
      addIssue(builder, 'RESERVATION_STATE_MISMATCH', subject, 'RESERVATION_PAIR_MISMATCH', { admissionId: slot.admissionId, reservationPair: reservation.pair, slotPair: slot.pair });
    }

    if (slot.status === 'PENDING') {
      if (reservation.status !== 'ADMITTED') {
        addIssue(builder, 'RESERVATION_STATE_MISMATCH', subject, 'PENDING_SLOT_RESERVATION_NOT_ADMITTED', { admissionId: slot.admissionId, reservationStatus: reservation.status });
      }
      if (intentByAdmissionId.has(slot.admissionId)) {
        addIssue(builder, 'POSITION_STATE_MISMATCH', subject, 'PENDING_SLOT_HAS_OPENING_EXECUTION_INTENT', { admissionId: slot.admissionId });
      }
      return;
    }

    // OPEN (§12/§13).
    if (reservation.status !== 'CONSUMED') {
      addIssue(builder, 'RESERVATION_STATE_MISMATCH', subject, 'OPEN_SLOT_RESERVATION_NOT_CONSUMED', { admissionId: slot.admissionId, reservationStatus: reservation.status });
    }
    if (
      slot.positionInstanceId === null || slot.side === null || slot.quantity === null || slot.averageEntryPriceInr === null
      || slot.leverage === null || slot.initialMarginInr === null
      || slot.openedAtMs === null || slot.ownerStrategyInstanceId === null || slot.ownerStrategyId === null
      || slot.ownerStrategyVersion === null || slot.ownerParameterHash === null
    ) {
      addIssue(builder, 'POSITION_STATE_MISMATCH', subject, 'OPEN_SLOT_MISSING_REQUIRED_FIELDS', {});
      return;
    }
    const intent = intentByAdmissionId.get(slot.admissionId);
    if (intent === undefined || intent.action !== 'OPEN' || intent.accountId !== accountId) {
      addIssue(builder, 'ORDER_FILL_MISMATCH', subject, 'OPEN_SLOT_NO_MATCHING_OPENING_INTENT', { admissionId: slot.admissionId });
      return;
    }
    if (intent.approvedLeverage === null) {
      addIssue(builder, 'ORDER_FILL_MISMATCH', subject, 'OPEN_SLOT_OPENING_INTENT_MISSING_APPROVED_LEVERAGE', { admissionId: slot.admissionId });
      return;
    }
    const policySnapshot = policySnapshotById.get(intent.executionPolicySnapshotId);
    if (policySnapshot === undefined) {
      addIssue(builder, 'ORDER_FILL_MISMATCH', subject, 'OPEN_SLOT_OPENING_INTENT_MISSING_POLICY_SNAPSHOT', { executionPolicySnapshotId: intent.executionPolicySnapshotId });
      return;
    }
    const economicsSnapshot = intent.instrumentEconomicsSnapshotId === null ? undefined : economicsSnapshotById.get(intent.instrumentEconomicsSnapshotId);
    if (economicsSnapshot === undefined) {
      addIssue(builder, 'ORDER_FILL_MISMATCH', subject, 'OPEN_SLOT_OPENING_INTENT_MISSING_INSTRUMENT_ECONOMICS', { instrumentEconomicsSnapshotId: intent.instrumentEconomicsSnapshotId });
      return;
    }
    const order = orderByIntentId.get(intent.executionIntentId);
    if (order === undefined || order.state !== 'FILLED') {
      addIssue(builder, 'ORDER_FILL_MISMATCH', subject, 'OPEN_SLOT_OPENING_ORDER_NOT_FILLED', { executionIntentId: intent.executionIntentId, orderState: order?.state ?? null });
      return;
    }
    const fill = fillByOrderId.get(order.executionIntentId);
    if (fill === undefined) {
      addIssue(builder, 'ORDER_FILL_MISMATCH', subject, 'OPEN_SLOT_OPENING_ORDER_HAS_NO_FILL', { executionIntentId: intent.executionIntentId });
      return;
    }

    const mismatches: Record<string, unknown>[] = [];
    const expectedPositionInstanceId = computePositionInstanceId({ accountId, strategyInstanceId: intent.strategyInstanceId, pair: slot.pair, openingExecutionIntentId: intent.executionIntentId });
    if (expectedPositionInstanceId !== slot.positionInstanceId) mismatches.push({ field: 'positionInstanceId', actual: slot.positionInstanceId, expected: expectedPositionInstanceId });
    if (slot.side !== reservation.direction) mismatches.push({ field: 'side', actual: slot.side, expected: reservation.direction });
    if (!paperDecimal(slot.quantity.toFixed()).equals(paperDecimal(fill.quantity.toFixed()))) mismatches.push({ field: 'quantity', actual: slot.quantity.toFixed(), expected: fill.quantity.toFixed() });
    if (!paperDecimal(slot.averageEntryPriceInr.toFixed()).equals(paperDecimal(fill.fillPrice.toFixed()))) mismatches.push({ field: 'averageEntryPriceInr', actual: slot.averageEntryPriceInr.toFixed(), expected: fill.fillPrice.toFixed() });
    // [F14-05] Leverage is a direct, unrounded copy of `decision.approved.approvedLeverage`
    // on BOTH the slot and the opening intent (execution-engine.ts never rounds
    // it) — an exact equality check, zero rounding risk. Initial margin is
    // re-derived from the same committed facts and frozen P14-E formula
    // (`notionalInr / leverage`, quantized at the same `quantizePaperPosting`
    // boundary execution-engine itself uses) — no market/live price is used.
    if (!paperDecimal(slot.leverage.toFixed()).equals(paperDecimal(intent.approvedLeverage.toFixed()))) {
      mismatches.push({ field: 'leverage', actual: slot.leverage.toFixed(), expected: intent.approvedLeverage.toFixed() });
    } else {
      const contractMultiplier = paperDecimal(economicsSnapshot.contractMultiplier.toFixed());
      const notionalInr = paperDecimal(fill.fillPrice.toFixed()).times(paperDecimal(fill.quantity.toFixed())).times(contractMultiplier);
      const expectedInitialMarginInr = quantizePaperPosting(notionalInr.dividedBy(paperDecimal(intent.approvedLeverage.toFixed()))).value;
      if (!paperDecimal(slot.initialMarginInr.toFixed()).equals(paperDecimal(expectedInitialMarginInr))) {
        mismatches.push({ field: 'initialMarginInr', actual: slot.initialMarginInr.toFixed(), expected: expectedInitialMarginInr });
      }
    }
    if (!paperDecimal(slot.cumulativeFeesInr.toFixed()).equals(paperDecimal(fill.feeInr.toFixed()))) mismatches.push({ field: 'cumulativeFeesInr', actual: slot.cumulativeFeesInr.toFixed(), expected: fill.feeInr.toFixed() });
    if (!paperDecimal(slot.cumulativeRealizedPnlInr.toFixed()).equals(paperDecimal('0'))) mismatches.push({ field: 'cumulativeRealizedPnlInr', actual: slot.cumulativeRealizedPnlInr.toFixed(), expected: '0' });
    if (slot.openedAtMs !== fill.eventTimeMs) mismatches.push({ field: 'openedAtMs', actual: slot.openedAtMs.toString(), expected: fill.eventTimeMs.toString() });

    if (mismatches.length > 0) {
      addIssue(builder, 'POSITION_STATE_MISMATCH', subject, 'OPEN_SLOT_ECONOMIC_FACT_MISMATCH', { mismatches });
    }
  }

  // -------------------------------------------------------------------------
  // §17/§44 — order/fill state machine: a FILLED order must have a terminal
  // fill. (The reverse — a fill without an order — is already impossible;
  // `PaperFill.orderId` is a `Restrict`-on-delete FK to `PaperOrder`.)
  // -------------------------------------------------------------------------
  #reconcileOrders(
    builder: Builder,
    orders: readonly { readonly executionIntentId: string; readonly state: string }[],
    fillByOrderId: ReadonlyMap<string, unknown>,
  ): void {
    for (const order of orders) {
      if (order.state === 'FILLED' && !fillByOrderId.has(order.executionIntentId)) {
        addIssue(builder, 'ORDER_FILL_MISMATCH', {}, 'FILLED_ORDER_HAS_NO_FILL', { executionIntentId: order.executionIntentId });
      }
    }
  }

  // -------------------------------------------------------------------------
  // §16 — terminal source-execution dedup. `PaperFill`'s own
  // `UNIQUE(accountId, sourceStrategyDecisionId)` is the primary/only
  // enforcement mechanism; this is a defensive detection pass over
  // already-loaded rows, never a second dedup system.
  // -------------------------------------------------------------------------
  #reconcileTerminalDedup(builder: Builder, fills: readonly { readonly orderId: string; readonly sourceStrategyDecisionId: string }[]): void {
    const byDecision = new Map<string, string[]>();
    for (const fill of fills) {
      const existing = byDecision.get(fill.sourceStrategyDecisionId);
      if (existing === undefined) byDecision.set(fill.sourceStrategyDecisionId, [fill.orderId]);
      else existing.push(fill.orderId);
    }
    for (const [sourceStrategyDecisionId, orderIds] of byDecision) {
      if (orderIds.length > 1) {
        addIssue(builder, 'ORDER_FILL_MISMATCH', {}, 'MULTIPLE_TERMINAL_FILLS_FOR_SOURCE_DECISION', { sourceStrategyDecisionId, orderIds });
      }
    }
  }

  // -------------------------------------------------------------------------
  // §14/§15/§46 — completed OPEN→CLOSE lifecycle fact agreement. History is
  // immutable (V2.1 §4) — never reopened/rewritten here, only cross-checked.
  // -------------------------------------------------------------------------
  #reconcileHistory(
    builder: Builder,
    row: {
      readonly positionInstanceId: string; readonly pair: string; readonly openingExecutionIntentId: string; readonly closingExecutionIntentId: string;
      readonly quantity: { readonly toFixed: () => string }; readonly averageEntryPriceInr: { readonly toFixed: () => string }; readonly exitPriceInr: { readonly toFixed: () => string };
      readonly realizedPnlInr: { readonly toFixed: () => string }; readonly totalFeesInr: { readonly toFixed: () => string }; readonly totalFundingInr: { readonly toFixed: () => string };
    },
    fillByOrderId: ReadonlyMap<string, { readonly quantity: { readonly toFixed: () => string }; readonly fillPrice: { readonly toFixed: () => string }; readonly feeInr: { readonly toFixed: () => string }; readonly realizedPnlInr: { readonly toFixed: () => string } | null }>,
    ledgerEntries: readonly { readonly type: string; readonly sourceFillId: string | null; readonly amountInr: { readonly toFixed: () => string } }[],
    positions: readonly { readonly pair: string; readonly status: string; readonly positionInstanceId: string | null }[],
  ): void {
    const subject = { pair: row.pair, positionInstanceId: row.positionInstanceId };
    const openFill = fillByOrderId.get(row.openingExecutionIntentId);
    const closeFill = fillByOrderId.get(row.closingExecutionIntentId);
    if (openFill === undefined || closeFill === undefined) {
      addIssue(builder, 'OWNERSHIP_HISTORY_MISMATCH', subject, 'HISTORY_MISSING_LINKED_FILL', {
        openingExecutionIntentId: row.openingExecutionIntentId, closingExecutionIntentId: row.closingExecutionIntentId,
        openFillFound: openFill !== undefined, closeFillFound: closeFill !== undefined,
      });
    } else {
      const mismatches: Record<string, unknown>[] = [];
      if (!paperDecimal(row.quantity.toFixed()).equals(paperDecimal(openFill.quantity.toFixed()))) mismatches.push({ field: 'quantity', actual: row.quantity.toFixed(), expected: openFill.quantity.toFixed() });
      if (!paperDecimal(row.averageEntryPriceInr.toFixed()).equals(paperDecimal(openFill.fillPrice.toFixed()))) mismatches.push({ field: 'averageEntryPriceInr', actual: row.averageEntryPriceInr.toFixed(), expected: openFill.fillPrice.toFixed() });
      if (!paperDecimal(row.exitPriceInr.toFixed()).equals(paperDecimal(closeFill.fillPrice.toFixed()))) mismatches.push({ field: 'exitPriceInr', actual: row.exitPriceInr.toFixed(), expected: closeFill.fillPrice.toFixed() });
      if (closeFill.realizedPnlInr === null || !paperDecimal(row.realizedPnlInr.toFixed()).equals(paperDecimal(closeFill.realizedPnlInr.toFixed()))) {
        mismatches.push({ field: 'realizedPnlInr', actual: row.realizedPnlInr.toFixed(), expected: closeFill.realizedPnlInr === null ? null : closeFill.realizedPnlInr.toFixed() });
      }
      const expectedTotalFees = paperDecimal(openFill.feeInr.toFixed()).plus(paperDecimal(closeFill.feeInr.toFixed()));
      if (!paperDecimal(row.totalFeesInr.toFixed()).equals(expectedTotalFees)) mismatches.push({ field: 'totalFeesInr', actual: row.totalFeesInr.toFixed(), expected: expectedTotalFees.toFixed() });
      if (!paperDecimal(row.totalFundingInr.toFixed()).equals(paperDecimal('0'))) mismatches.push({ field: 'totalFundingInr', actual: row.totalFundingInr.toFixed(), expected: '0' });

      const feeLedgerSum = ledgerEntries.filter((e) => e.type === 'FEE' && (e.sourceFillId === row.openingExecutionIntentId || e.sourceFillId === row.closingExecutionIntentId))
        .reduce((sum, e) => sum.plus(paperDecimal(e.amountInr.toFixed())), paperDecimal('0'));
      if (!feeLedgerSum.negated().equals(expectedTotalFees)) mismatches.push({ field: 'ledgerFeeSum', actual: feeLedgerSum.toFixed(), expectedNegated: expectedTotalFees.toFixed() });
      const pnlLedgerEntry = ledgerEntries.find((e) => e.type === 'REALIZED_PNL' && e.sourceFillId === row.closingExecutionIntentId);
      if (pnlLedgerEntry === undefined || !paperDecimal(pnlLedgerEntry.amountInr.toFixed()).equals(paperDecimal(row.realizedPnlInr.toFixed()))) {
        mismatches.push({ field: 'ledgerRealizedPnl', actual: pnlLedgerEntry === undefined ? null : pnlLedgerEntry.amountInr.toFixed(), expected: row.realizedPnlInr.toFixed() });
      }

      if (mismatches.length > 0) addIssue(builder, 'OWNERSHIP_HISTORY_MISMATCH', subject, 'HISTORY_ECONOMIC_FACT_MISMATCH', { mismatches });
    }

    const currentSlot = positions.find((p) => p.pair === row.pair);
    if (currentSlot !== undefined && currentSlot.status === 'OPEN' && currentSlot.positionInstanceId === row.positionInstanceId) {
      addIssue(builder, 'OWNERSHIP_HISTORY_MISMATCH', subject, 'SLOT_STILL_OPEN_FOR_COMPLETED_HISTORY', { pair: row.pair, positionInstanceId: row.positionInstanceId });
    }
  }

  // -------------------------------------------------------------------------
  // [F14-05] Reverse reservation -> slot binding. `#reconcilePosition` above
  // only walks FORWARD from each slot to its claimed reservation, so a
  // reservation that durably claims live capacity but has NO slot reflecting
  // it (or a slot reflecting a DIFFERENT admission) is invisible to it — the
  // exact defect an ADMITTED reservation next to an EMPTY, unclaimed slot
  // previously produced a false HEALTHY for. RELEASED-masquerading-as-PENDING
  // is already caught by the forward check (`PENDING_SLOT_RESERVATION_NOT_ADMITTED`)
  // and is not duplicated here.
  // -------------------------------------------------------------------------
  /**
   * [F14-01 §22] Durable §12.4/§12.5 risk state versus the account's own
   * committed economic history.
   *
   * Astra's report included stale risk state reconciling HEALTHY. These checks
   * close that, and are careful to flag ONLY what committed facts mathematically
   * prove — never to fabricate a historical market observation.
   *
   *  - CONSECUTIVE LOSS COUNT is fully derivable: every closed lifecycle carries
   *    its own canonical realized PnL and close time, and §12.5's rules are a
   *    pure fold over them. Replayed exactly, no policy required.
   *  - COOLDOWN is derivable only against the configured limit/duration, which
   *    are policy rather than durable facts — checked when supplied, otherwise
   *    deliberately left unverified.
   *  - PEAK EQUITY is only bounded below. Historical marks are NOT durably
   *    stored, so the true high-water of an account that held open positions is
   *    genuinely unrecoverable after the fact and is NOT reconstructed here.
   *    What IS provable: the peak can never be below the starting capital, and
   *    can never be below the account's cash at any moment it demonstrably held
   *    no open position — because equity equals cash exactly at those moments.
   *    A stored peak below that bound is a contradiction, and only that is
   *    flagged.
   */
  #reconcileDurableRiskState(
    builder: Builder,
    account: { readonly startingCapitalInr: Prisma.Decimal; readonly peakEquityInr: Prisma.Decimal; readonly consecutiveLossCount: number; readonly cooldownActiveUntilMs: bigint | null },
    history: readonly { readonly realizedPnlInr: Prisma.Decimal; readonly closedAtMs: bigint; readonly openedAtMs: bigint; readonly closingExecutionIntentId: string; readonly positionInstanceId: string }[],
    fills: readonly { readonly orderId: string; readonly action: string; readonly realizedPnlInr: Prisma.Decimal | null; readonly feeInr: Prisma.Decimal; readonly eventTimeMs: bigint }[],
    positions: readonly { readonly pair: string; readonly status: string; readonly positionInstanceId: string | null; readonly openedAtMs: bigint | null }[],
    lossStatePolicy: PaperLossStatePolicy | undefined,
  ): void {
    const closes = [...history]
      .sort((left, right) => {
        const byTime = Number(left.closedAtMs - right.closedAtMs);
        return byTime !== 0 ? byTime : left.closingExecutionIntentId.localeCompare(right.closingExecutionIntentId);
      })
      .map((row) => ({ realizedPnlInr: row.realizedPnlInr.toFixed(), closeTimeMs: Number(row.closedAtMs) }));

    // --- §12.5 consecutive loss count (always derivable) --------------------
    const derivedCount = replayLossState(closes, { consecutiveLossLimit: null, cooldownMs: null }).consecutiveLossCount;
    if (derivedCount !== account.consecutiveLossCount) {
      addIssue(builder, 'RISK_STATE_MISMATCH', {}, 'DURABLE_CONSECUTIVE_LOSS_COUNT_MISMATCH', {
        storedConsecutiveLossCount: account.consecutiveLossCount, derivedConsecutiveLossCount: derivedCount, closedLifecycles: closes.length,
      });
    }

    // --- §12.5 cooldown (derivable only against configured policy) ----------
    if (lossStatePolicy !== undefined && lossStatePolicy.consecutiveLossLimit !== null) {
      const derived = replayLossState(closes, lossStatePolicy);
      const stored = account.cooldownActiveUntilMs === null ? null : Number(account.cooldownActiveUntilMs);
      if (derived.cooldownActiveUntilMs !== stored) {
        addIssue(builder, 'RISK_STATE_MISMATCH', {}, 'DURABLE_COOLDOWN_BOUNDARY_MISMATCH', {
          storedCooldownActiveUntilMs: stored, derivedCooldownActiveUntilMs: derived.cooldownActiveUntilMs,
          consecutiveLossLimit: lossStatePolicy.consecutiveLossLimit, cooldownMs: lossStatePolicy.cooldownMs,
        });
      }
    }

    // --- §12.4 peak equity, lower bound only --------------------------------
    // Cash replayed over committed fills, sampled at each moment the account
    // demonstrably held no open position (so equity === cash exactly there).
    // Funding is deliberately excluded from this bound. It is unsupported in
    // Phase14 and is always exactly 0 in valid state; a nonzero value is
    // already owned by FUNDING_INVARIANT_VIOLATION, and folding it in here
    // would report the same corruption twice under a second fault type.
    const startingCapital = paperDecimal(account.startingCapitalInr.toFixed());
    type LifecycleEvent = Readonly<{ at: bigint; action: 'OPEN' | 'CLOSE'; positionInstanceId: string }>;
    const lifecycleEvents: LifecycleEvent[] = history.flatMap((row) => [
      { at: row.openedAtMs, action: 'OPEN' as const, positionInstanceId: row.positionInstanceId },
      { at: row.closedAtMs, action: 'CLOSE' as const, positionInstanceId: row.positionInstanceId },
    ]);
    let lifecycleUnverifiable = false;
    for (const position of positions) {
      if (position.status !== 'OPEN') continue;
      if (position.positionInstanceId === null || position.openedAtMs === null) {
        // Another reconciliation check owns the malformed OPEN projection. For
        // peak proof, fail conservatively: an unplaceable active lifecycle means
        // no post-inception historical flat moment is mathematically provable.
        lifecycleUnverifiable = true;
        continue;
      }
      lifecycleEvents.push({
        at: position.openedAtMs,
        action: 'OPEN',
        positionInstanceId: position.positionInstanceId,
      });
    }

    const eventsByTime = new Map<bigint, LifecycleEvent[]>();
    for (const event of lifecycleEvents) {
      const atTime = eventsByTime.get(event.at);
      if (atTime === undefined) eventsByTime.set(event.at, [event]);
      else atTime.push(event);
    }
    const fillsByTime = new Map<bigint, typeof fills[number][]>();
    for (const fill of fills) {
      const atTime = fillsByTime.get(fill.eventTimeMs);
      if (atTime === undefined) fillsByTime.set(fill.eventTimeMs, [fill]);
      else atTime.push(fill);
    }
    const orderedTimes = [...new Set([...eventsByTime.keys(), ...fillsByTime.keys()])]
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const completedCloseIntentIds = new Set(history.map((row) => row.closingExecutionIntentId));
    const activePositions = new Set<string>();

    let provableMinimum = startingCapital;
    let cash = startingCapital;
    for (const at of orderedTimes) {
      // Same-time events form one durable economic point. OPENs precede CLOSEs
      // within the group, and instance identity makes duplicate terminal facts
      // idempotent: Set.add/delete can never double-change cardinality.
      const events = [...(eventsByTime.get(at) ?? [])].sort((left, right) => {
        if (left.action !== right.action) return left.action === 'OPEN' ? -1 : 1;
        return left.positionInstanceId.localeCompare(right.positionInstanceId);
      });
      for (const event of events) {
        if (event.action === 'OPEN') activePositions.add(event.positionInstanceId);
        else activePositions.delete(event.positionInstanceId);
      }

      const atFills = [...(fillsByTime.get(at) ?? [])].sort((left, right) => left.orderId.localeCompare(right.orderId));
      for (const fill of atFills) {
        cash = cash.plus(fill.realizedPnlInr === null ? '0' : fill.realizedPnlInr.toFixed()).minus(fill.feeInr.toFixed());
      }
      const hasVerifiedClose = atFills.some((fill) => fill.action === 'CLOSE' && completedCloseIntentIds.has(fill.orderId));
      if (!lifecycleUnverifiable && hasVerifiedClose && activePositions.size === 0 && cash.greaterThan(provableMinimum)) {
        provableMinimum = cash;
      }
    }
    // The account's CURRENT state is the same kind of proof when it is flat.
    if (!positions.some((slot) => slot.status === 'OPEN') && cash.greaterThan(provableMinimum)) provableMinimum = cash;

    const storedPeak = paperDecimal(account.peakEquityInr.toFixed());
    if (storedPeak.lessThan(provableMinimum)) {
      addIssue(builder, 'RISK_STATE_MISMATCH', {}, 'PEAK_EQUITY_BELOW_PROVABLE_MINIMUM', {
        storedPeakEquityInr: storedPeak.toFixed(), provableMinimumPeakEquityInr: provableMinimum.toFixed(),
        // Stated explicitly: this is a lower bound from realized, flat-account
        // observations only. An account that held open positions may have had a
        // genuinely higher historical MTM peak that is not durably recoverable,
        // and its absence is NOT treated as a fault.
        derivation: 'REALIZED_FLAT_ACCOUNT_CASH_LOWER_BOUND_V1',
      });
    }
  }

  #reconcileReservationsReverse(
    builder: Builder,
    reservations: readonly { readonly admissionId: string; readonly pair: string; readonly status: string }[],
    positionByPair: ReadonlyMap<string, { readonly status: string; readonly admissionId: string | null; readonly positionInstanceId: string | null }>,
    intentByAdmissionId: ReadonlyMap<string, { readonly executionIntentId: string }>,
    history: readonly { readonly openingExecutionIntentId: string }[],
  ): void {
    for (const reservation of reservations) {
      const subject = { pair: reservation.pair, admissionId: reservation.admissionId };
      if (reservation.status === 'ADMITTED') {
        const slot = positionByPair.get(reservation.pair);
        if (slot === undefined || slot.status !== 'PENDING' || slot.admissionId !== reservation.admissionId) {
          addIssue(builder, 'RESERVATION_STATE_MISMATCH', subject, 'ADMITTED_RESERVATION_NOT_REFLECTED_IN_PENDING_SLOT', {
            slotStatus: slot?.status ?? null, slotAdmissionId: slot?.admissionId ?? null,
          });
        }
        continue;
      }
      if (reservation.status === 'CONSUMED') {
        const slot = positionByPair.get(reservation.pair);
        const isCurrentOpen = slot !== undefined && slot.status === 'OPEN' && slot.admissionId === reservation.admissionId;
        const openingIntent = intentByAdmissionId.get(reservation.admissionId);
        const historicallyClosed = openingIntent !== undefined && history.some((h) => h.openingExecutionIntentId === openingIntent.executionIntentId);
        if (!isCurrentOpen && !historicallyClosed) {
          addIssue(builder, 'RESERVATION_STATE_MISMATCH', subject, 'CONSUMED_RESERVATION_WITHOUT_OPEN_OR_COMPLETED_LIFECYCLE', {
            slotStatus: slot?.status ?? null, slotAdmissionId: slot?.admissionId ?? null,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // [F14-05] Reverse completed-CLOSE -> ownership-history binding.
  // `#reconcileHistory` above only walks FORWARD from each EXISTING history
  // row — a completed CLOSE (a FILLED CLOSE order with a terminal fill) that
  // is missing its required `PaperPositionOwnershipHistory` row entirely
  // would otherwise never be detected.
  // -------------------------------------------------------------------------
  #reconcileCompletedClosesReverse(
    builder: Builder,
    intents: readonly { readonly executionIntentId: string; readonly action: string; readonly pair: string }[],
    orderByIntentId: ReadonlyMap<string, { readonly state: string }>,
    fillByOrderId: ReadonlyMap<string, unknown>,
    history: readonly { readonly closingExecutionIntentId: string }[],
  ): void {
    const historyByClosingIntentId = new Set(history.map((h) => h.closingExecutionIntentId));
    for (const intent of intents) {
      if (intent.action !== 'CLOSE') continue;
      const order = orderByIntentId.get(intent.executionIntentId);
      if (order === undefined || order.state !== 'FILLED') continue; // not a completed close
      if (!fillByOrderId.has(intent.executionIntentId)) continue; // already reported by #reconcileOrders' FILLED_ORDER_HAS_NO_FILL
      if (!historyByClosingIntentId.has(intent.executionIntentId)) {
        addIssue(builder, 'OWNERSHIP_HISTORY_MISMATCH', { pair: intent.pair }, 'COMPLETED_CLOSE_MISSING_OWNERSHIP_HISTORY', { closingExecutionIntentId: intent.executionIntentId });
      }
    }
  }
}
