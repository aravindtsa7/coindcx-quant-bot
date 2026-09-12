import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../persistence/prisma';
import { RiskAdmissionCoordinator } from '../../dispatch/admission';
import { assertQuantityAligned, ceilToTick, floorToTick, paperDecimal, PaperCalcDecimal, PAPER_ONE, type PaperCalc } from '../decimal';
import { computeFeeInr, computeRealizedPnlInr, quantizePaperPosting } from '../accounting';
import { computeOpenExecutionIntentId, computeCloseExecutionIntentId, computePositionInstanceId, computeSourceExecutionKey } from '../identity';
import type { ExecutionPolicySnapshot } from '../policy';
import type { PaperExecutionQuoteSnapshot } from '../evidence';
import {
  readTrustedPaperExecutionEvidence,
  type TrustedPaperConversionEvidence,
  type TrustedPaperExecutionEvidence,
  type TrustedPaperOrderbookDepth,
} from '../trusted-evidence';
import { PaperOpenExecutionAuthority } from '../open-authority';
import { PaperCloseExecutionAuthority } from '../close-authority';
import { sha256CanonicalJson } from '../../risk';
import { PaperAccountOwnership, type PaperAccountOwnershipRecord } from './account-ownership';
import { SESSION_PROOF } from './admission-bridge';
import { PaperPersistenceError } from './errors';

/** Execution stays provider-independent; runtime provenance arrives through the opaque trusted-evidence capability. */
export type PaperExecutionSide = 'BUY' | 'SELL';

function sideForOpenDirection(direction: 'LONG' | 'SHORT'): PaperExecutionSide {
  return direction === 'LONG' ? 'BUY' : 'SELL';
}
function sideForClosingPosition(positionSide: 'LONG' | 'SHORT'): PaperExecutionSide {
  return positionSide === 'LONG' ? 'SELL' : 'BUY';
}

function rawReferencePrice(side: PaperExecutionSide, quote: PaperExecutionQuoteSnapshot): PaperCalc {
  return paperDecimal(side === 'BUY' ? quote.ask : quote.bid);
}
function availableExecutableQuantity(side: PaperExecutionSide, depth: TrustedPaperOrderbookDepth): PaperCalc {
  return paperDecimal(side === 'BUY' ? depth.bestAskQuantity : depth.bestBidQuantity);
}

/**
 * V2 §7 frozen fill model: slippage is applied once, adversely, directly to the
 * actionable bid/ask (spreadSemantics=`BID_ASK_DIRECT` — the real spread is
 * already captured by using the real best bid/ask, never a synthetic
 * half-spread model). Tick rounding is applied LAST, in the SAME adverse
 * direction as slippage (BUY ceils, SELL floors — `tickRoundingPolicy=
 * BUY_CEIL_SELL_FLOOR_V1`) so both distortions are consistently unfavorable to
 * the trader, never offsetting. Mirrors the exact `rawReference * (1 ± rate)`
 * shape already established by `src/backtest/engine.ts`'s market-order fill
 * model (reused arithmetic pattern, not re-derived).
 */
function computeExecutionPrice(side: PaperExecutionSide, raw: PaperCalc, slippageBps: string, tick: PaperCalc): PaperCalc {
  const slippageRate = paperDecimal(slippageBps).dividedBy(new PaperCalcDecimal(10000));
  const slipped = side === 'BUY' ? raw.times(PAPER_ONE.plus(slippageRate)) : raw.times(PAPER_ONE.minus(slippageRate));
  return side === 'BUY' ? ceilToTick(slipped, tick) : floorToTick(slipped, tick);
}

function assertEvidenceCausality(quote: PaperExecutionQuoteSnapshot, depth: TrustedPaperOrderbookDepth, pair: string): string | null {
  if (quote.pair !== pair || depth.pair !== pair) return 'EVIDENCE_PAIR_MISMATCH';
  if (quote.contentSha256 !== depth.contentSha256) return 'EVIDENCE_CAUSALITY_MISMATCH';
  if (quote.bid !== depth.bestBid || quote.ask !== depth.bestAsk) return 'EVIDENCE_PRICE_BINDING_MISMATCH';
  if (quote.providerEventTimeMs !== depth.providerEventTimeMs || quote.firstObservedAtMs !== depth.observedAtMs) return 'EVIDENCE_OBSERVATION_BINDING_MISMATCH';
  if (quote.sourceSessionId !== depth.sourceSessionId || quote.generationId !== depth.generationId) return 'EVIDENCE_GENERATION_BINDING_MISMATCH';
  return null;
}

/**
 * Second, network-free freshness check at the deterministic use boundary (V2
 * §35) — P14-B's own gate already required `HEALTHY`/current-generation/fresh
 * evidence to produce this snapshot at all, but time may pass before this
 * exact moment, so it is re-verified here against the bound execution
 * policy's `maxEvidenceAgeMs`, without ever calling back into any provider.
 * Execution always requires the strict `HEALTHY` health state regardless of
 * the configured policy value — `DEGRADED_ANALYTICAL_ONLY` (the only other
 * value `MarketEvidenceEligibilityPolicy.requiredHealthState` can hold) is
 * self-documenting that degraded evidence may back analysis only, never a
 * real economic execution.
 */
function evidenceStaleAtUse(quote: PaperExecutionQuoteSnapshot, policy: ExecutionPolicySnapshot, nowMs: number): string | null {
  if (quote.healthState !== 'HEALTHY') return 'EVIDENCE_HEALTH_STATE_INSUFFICIENT';
  if (!Number.isSafeInteger(nowMs) || nowMs < quote.firstObservedAtMs) return 'EVIDENCE_CLOCK_FAULT';
  const age = nowMs - quote.providerEventTimeMs;
  if (age < 0 || age > policy.content.marketEvidenceEligibilityPolicy.maxEvidenceAgeMs) return 'EVIDENCE_STALE_AT_USE';
  return null;
}

function conversionStaleAtUse(conversion: TrustedPaperConversionEvidence, localFreshnessMs: number, nowMs: number): string | null {
  if (!Number.isSafeInteger(nowMs) || nowMs < conversion.observedAtMs) return 'CONVERSION_CLOCK_FAULT';
  if (nowMs - conversion.observedAtMs > localFreshnessMs) return 'CONVERSION_STALE_AT_USE';
  return null;
}

function toPrismaDecimal(value: string): Prisma.Decimal { return new Prisma.Decimal(value); }
function post(value: PaperCalc): Prisma.Decimal { return toPrismaDecimal(quantizePaperPosting(value).value); }

/** [P14-E] Deterministic, content-addressed ledger-entry identity — a P14-E-owned identity (never added to the frozen `src/execution/identity.ts` P14-A module). Collapses exactly onto the DB's own `UNIQUE(type, sourceFillId)` dedup key, so a retry can never conflict with genuinely different content under the same id. */
function computeLedgerEntryId(type: 'FEE' | 'REALIZED_PNL', sourceFillId: string): string {
  return sha256CanonicalJson({ identityPolicyId: 'P14_E_LEDGER_ENTRY_IDENTITY_V1', type, sourceFillId });
}

function assertSessionProof(proof: unknown): void {
  if (proof !== SESSION_PROOF) throw new PaperPersistenceError('NOT_OWNER', 'PaperExecutionEngine may only be driven by a READY PaperAccountSession (post-restore)');
}

function readGenuineOwnership(ownership: PaperAccountOwnership): PaperAccountOwnershipRecord {
  const held = PaperAccountOwnership.read(ownership);
  if (held === null) throw new PaperPersistenceError('NOT_OWNER', 'Caller-shaped ownership object is not genuine');
  return held;
}

interface ExpectedTerminalFill {
  readonly accountId: string;
  readonly sourceStrategyDecisionId: string;
  readonly sourceExecutionKey: string;
  readonly orderId: string;
  readonly pair: string;
  readonly action: 'OPEN' | 'CLOSE';
  readonly quantity: string;
  readonly side?: PaperExecutionSide;
}

interface TerminalFillRow {
  readonly accountId: string;
  readonly sourceStrategyDecisionId: string;
  readonly sourceExecutionKey: string;
  readonly orderId: string;
  readonly pair: string;
  readonly action: string;
  readonly quantity: Prisma.Decimal;
  readonly side: string;
}

function terminalFillMatches(fill: TerminalFillRow, expected: ExpectedTerminalFill): boolean {
  return fill.accountId === expected.accountId
    && fill.sourceStrategyDecisionId === expected.sourceStrategyDecisionId
    && fill.sourceExecutionKey === expected.sourceExecutionKey
    && fill.pair === expected.pair
    && fill.action === expected.action
    && paperDecimal(fill.quantity.toFixed()).equals(paperDecimal(expected.quantity))
    && (expected.side === undefined || fill.side === expected.side);
}

function assertMatchingTerminalFill(fill: TerminalFillRow, expected: ExpectedTerminalFill): void {
  if (!terminalFillMatches(fill, expected)) {
    throw new PaperPersistenceError(
      'DURABLE_CONFLICT',
      `Terminal fill for (${expected.accountId}, ${expected.sourceStrategyDecisionId}) conflicts with the requested execution identity`,
    );
  }
}

class SourceDecisionAlreadyExecutedSentinel extends Error {
  public constructor(public readonly uniqueFailure: unknown) {
    super('P14-E terminal source-decision uniqueness requires transaction rollback');
    this.name = 'SourceDecisionAlreadyExecutedSentinel';
  }
}

function isP2002(value: unknown): boolean {
  return value instanceof Prisma.PrismaClientKnownRequestError && value.code === 'P2002';
}

/** @internal Exact Decimal admission-cap check, kept public only for focused correction proofs. */
export function executionApprovedRiskIssue(
  actualNotionalInr: PaperCalc,
  actualInitialMarginInr: PaperCalc,
  approvedNotionalInr: string,
  approvedMarginInr: string,
): 'EXECUTION_EXCEEDS_APPROVED_NOTIONAL' | 'EXECUTION_EXCEEDS_APPROVED_MARGIN' | null {
  if (actualNotionalInr.greaterThan(paperDecimal(approvedNotionalInr))) return 'EXECUTION_EXCEEDS_APPROVED_NOTIONAL';
  if (actualInitialMarginInr.greaterThan(paperDecimal(approvedMarginInr))) return 'EXECUTION_EXCEEDS_APPROVED_MARGIN';
  return null;
}

// ---------------------------------------------------------------------------
// OPEN
// ---------------------------------------------------------------------------

export interface PaperOpenExecutionInputs {
  readonly evidence: TrustedPaperExecutionEvidence;
  readonly priceIncrement: string;
  readonly quantityIncrement: string;
  readonly executionPolicy: ExecutionPolicySnapshot;
  /** Caller-supplied "now" for the network-free freshness re-check (V2 §35) — never `Date.now()` internally. */
  readonly nowMs: number;
}

export type PaperOpenExecutionResult =
  | {
      readonly outcome: 'FILLED';
      readonly executionIntentId: string;
      readonly positionInstanceId: string;
      readonly side: PaperExecutionSide;
      readonly fillPriceInr: string;
      readonly quantity: string;
      readonly feeInr: string;
      readonly notionalInr: string;
    }
  | { readonly outcome: 'SOURCE_DECISION_ALREADY_EXECUTED' }
  | { readonly outcome: 'RESERVATION_NOT_READY'; readonly reason: string }
  | { readonly outcome: 'EVIDENCE_INVALID'; readonly reason: string }
  | { readonly outcome: 'APPROVED_RISK_EXCEEDED'; readonly reason: 'EXECUTION_EXCEEDS_APPROVED_NOTIONAL' | 'EXECUTION_EXCEEDS_APPROVED_MARGIN' }
  | { readonly outcome: 'INSUFFICIENT_LIQUIDITY' };

// ---------------------------------------------------------------------------
// CLOSE
// ---------------------------------------------------------------------------

export interface PaperCloseExecutionInputs {
  readonly evidence: TrustedPaperExecutionEvidence;
  readonly priceIncrement: string;
  readonly executionPolicy: ExecutionPolicySnapshot;
  readonly nowMs: number;
}

export type PaperCloseExecutionResult =
  | {
      readonly outcome: 'CLOSED';
      readonly executionIntentId: string;
      readonly positionInstanceId: string;
      readonly side: PaperExecutionSide;
      readonly fillPriceInr: string;
      readonly quantity: string;
      readonly feeInr: string;
      readonly realizedPnlInr: string;
    }
  | { readonly outcome: 'SOURCE_DECISION_ALREADY_EXECUTED' }
  | { readonly outcome: 'POSITION_NOT_READY'; readonly reason: string }
  | { readonly outcome: 'EVIDENCE_INVALID'; readonly reason: string }
  | { readonly outcome: 'INSUFFICIENT_LIQUIDITY' };

/**
 * [P14-E] Integrated PAPER OPEN/CLOSE economic execution — the only production
 * path that may create `PaperExecutionIntent`/`PaperOrder`/`PaperFill`/
 * `PaperLedgerEntry` rows or mutate `PaperPosition`/`PaperAccount` economics.
 * Reuses P14-A's frozen authority/identity/accounting/decimal contracts and
 * P14-D's frozen fencing/lock-order/fail-closed conventions exactly — no
 * economic formula, identity, or lifecycle transition here is independently
 * invented beyond what those already-frozen modules and the P14-C schema's own
 * comments establish (see the accompanying implementation report for the
 * specific evidence trail behind each choice).
 *
 * Gated by the same internal, non-barrel `SESSION_PROOF` token as
 * `PaperAdmissionBridge` (P14-D MAJ-01 correction) — only a READY
 * `PaperAccountSession` may drive this engine; raw ownership alone cannot.
 */
export class PaperExecutionEngine {
  readonly #prisma: PrismaClient;

  public constructor(prismaClient: PrismaClient = defaultPrisma) {
    this.#prisma = prismaClient;
  }

  /**
   * [P14-E BLK-01-equivalent] `coordinator.release()` (reused verbatim from
   * P14-D — no coordinator fork/modification) runs inside this transaction to
   * remove the consumed admission's pending-exposure entry BEFORE the
   * remaining durable writes/commit. Any failure after that point is
   * OUTCOME-AMBIGUOUS for the identical reason P14-D's `PaperAdmissionBridge`
   * already established: this function cannot tell whether the surrounding
   * transaction committed. It rethrows `ADMISSION_OUTCOME_AMBIGUOUS`, and
   * `PaperAccountSession` (unchanged fault-handling) takes it from there.
   */
  public async executeOpen(
    sessionProof: symbol,
    ownership: PaperAccountOwnership,
    authority: PaperOpenExecutionAuthority,
    inputs: PaperOpenExecutionInputs,
    coordinator: RiskAdmissionCoordinator,
  ): Promise<PaperOpenExecutionResult> {
    assertSessionProof(sessionProof);
    const held = readGenuineOwnership(ownership);
    const record = PaperOpenExecutionAuthority.read(authority);
    if (record === null) throw new PaperPersistenceError('NOT_OWNER', 'Caller-shaped OPEN execution authority object is not genuine');
    if (record.accountId !== held.accountId) throw new PaperPersistenceError('NOT_OWNER', 'OPEN authority accountId does not match the held ownership accountId');

    const { admission, decision } = record;
    const pair = admission.pair;

    const evidence = readTrustedPaperExecutionEvidence(inputs.evidence);
    if (evidence === null) return { outcome: 'EVIDENCE_INVALID', reason: 'UNTRUSTED_EXECUTION_EVIDENCE' };
    const { quote, orderbookDepth, conversion, conversionLocalPollFreshnessMs } = evidence;
    const causalityIssue = assertEvidenceCausality(quote, orderbookDepth, pair);
    const staleIssue = evidenceStaleAtUse(quote, inputs.executionPolicy, inputs.nowMs);
    const conversionStaleIssue = conversionStaleAtUse(conversion, conversionLocalPollFreshnessMs, inputs.nowMs);

    const side = sideForOpenDirection(admission.direction);
    const approvedQuantity = paperDecimal(decision.approved.approvedQuantity);
    assertQuantityAligned(approvedQuantity, paperDecimal(inputs.quantityIncrement));

    const executionIntentId = computeOpenExecutionIntentId({
      admissionId: admission.admissionId, riskDecisionId: admission.riskDecisionId, accountId: held.accountId, pair,
      strategyInstanceId: admission.strategyInstanceId, strategyId: admission.strategyId, strategyVersion: admission.strategyVersion,
      parameterHash: admission.parameterHash, approvedQuantity: decision.approved.approvedQuantity, approvedLeverage: decision.approved.approvedLeverage,
      approvedNotionalInr: admission.approvedNotionalInr, approvedMarginInr: admission.approvedMarginInr,
      evaluationTimeMs: decision.evaluationTimeMs, executionPolicySnapshotId: inputs.executionPolicy.executionPolicySnapshotId,
    });
    const sourceExecutionKey = computeSourceExecutionKey({ accountId: held.accountId, sourceStrategyDecisionId: decision.sourceStrategyDecisionId });
    const positionInstanceId = computePositionInstanceId({
      accountId: held.accountId, strategyInstanceId: admission.strategyInstanceId, pair, openingExecutionIntentId: executionIntentId,
    });
    const expectedTerminalFill: ExpectedTerminalFill = {
      accountId: held.accountId,
      sourceStrategyDecisionId: decision.sourceStrategyDecisionId,
      sourceExecutionKey,
      orderId: executionIntentId,
      pair,
      action: 'OPEN',
      quantity: decision.approved.approvedQuantity,
      side,
    };

    let coordinatorMutated = false;
    try {
      return await this.#prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT account_id FROM paper_account WHERE account_id = ${held.accountId} FOR UPDATE`;
        const account = await tx.paperAccount.findUnique({ where: { accountId: held.accountId } });
        if (account === null) throw new PaperPersistenceError('ACCOUNT_NOT_FOUND', `No paper_account row for ${held.accountId}`);
        if (account.ownerFence !== held.fence) throw new PaperPersistenceError('STALE_FENCE', `Held fence ${held.fence} no longer matches current ${account.ownerFence}`);

        const terminalFill = await tx.paperFill.findUnique({ where: { accountId_sourceStrategyDecisionId: { accountId: held.accountId, sourceStrategyDecisionId: decision.sourceStrategyDecisionId } } });
        if (terminalFill !== null) {
          assertMatchingTerminalFill(terminalFill, expectedTerminalFill);
          return { outcome: 'SOURCE_DECISION_ALREADY_EXECUTED' as const };
        }
        if (causalityIssue !== null) return { outcome: 'EVIDENCE_INVALID' as const, reason: causalityIssue };
        if (staleIssue !== null) return { outcome: 'EVIDENCE_INVALID' as const, reason: staleIssue };
        if (conversionStaleIssue !== null) return { outcome: 'EVIDENCE_INVALID' as const, reason: conversionStaleIssue };
        const available = availableExecutableQuantity(side, orderbookDepth);
        if (available.lessThan(approvedQuantity)) return { outcome: 'INSUFFICIENT_LIQUIDITY' as const };
        const rawPrice = rawReferencePrice(side, quote);
        const fillPriceUsdt = computeExecutionPrice(side, rawPrice, inputs.executionPolicy.content.slippageBps, paperDecimal(inputs.priceIncrement));
        const contractMultiplier = paperDecimal(inputs.executionPolicy.content.contractMultiplier);
        const notionalUsdt = fillPriceUsdt.times(approvedQuantity).times(contractMultiplier);
        const conversionRate = paperDecimal(conversion.conversionPriceInrPerUsdt);
        const notionalInr = notionalUsdt.times(conversionRate);
        const fillPriceInr = fillPriceUsdt.times(conversionRate);
        const feeInr = computeFeeInr(notionalInr, paperDecimal(inputs.executionPolicy.content.takerFeeRate));
        const initialMarginInr = notionalInr.dividedBy(paperDecimal(decision.approved.approvedLeverage));
        const approvedRiskIssue = executionApprovedRiskIssue(
          notionalInr, initialMarginInr, admission.approvedNotionalInr, admission.approvedMarginInr,
        );
        if (approvedRiskIssue !== null) return { outcome: 'APPROVED_RISK_EXCEEDED' as const, reason: approvedRiskIssue };

        await tx.$executeRaw`SELECT account_id FROM paper_position WHERE account_id = ${held.accountId} AND pair = ${pair} FOR UPDATE`;
        const slot = await tx.paperPosition.findUnique({ where: { accountId_pair: { accountId: held.accountId, pair } } });
        if (slot === null || slot.status !== 'PENDING' || slot.admissionId !== admission.admissionId) {
          return { outcome: 'RESERVATION_NOT_READY' as const, reason: 'PAIR_SLOT_NOT_PENDING_FOR_THIS_ADMISSION' };
        }

        const reservation = await tx.paperReservation.findUnique({ where: { admissionId: admission.admissionId } });
        if (reservation === null || reservation.accountId !== held.accountId || reservation.status !== 'ADMITTED') {
          return { outcome: 'RESERVATION_NOT_READY' as const, reason: 'RESERVATION_NOT_ADMITTED' };
        }

        await tx.paperExecutionPolicySnapshot.upsert({
          where: { executionPolicySnapshotId: inputs.executionPolicy.executionPolicySnapshotId },
          create: {
            executionPolicySnapshotId: inputs.executionPolicy.executionPolicySnapshotId, policyVersion: inputs.executionPolicy.content.policyVersion,
            fillSelectionPolicy: inputs.executionPolicy.content.fillSelectionPolicy, maxEvidenceAgeMs: inputs.executionPolicy.content.marketEvidenceEligibilityPolicy.maxEvidenceAgeMs,
            requiredHealthState: inputs.executionPolicy.content.marketEvidenceEligibilityPolicy.requiredHealthState, takerFeeRate: toPrismaDecimal(inputs.executionPolicy.content.takerFeeRate),
            slippageBps: toPrismaDecimal(inputs.executionPolicy.content.slippageBps), spreadSemantics: inputs.executionPolicy.content.spreadSemantics,
            tickRoundingPolicy: inputs.executionPolicy.content.tickRoundingPolicy, quantityPolicy: inputs.executionPolicy.content.quantityPolicy,
            contractMultiplier: toPrismaDecimal(inputs.executionPolicy.content.contractMultiplier), currencyConversionPolicy: inputs.executionPolicy.content.currencyConversionPolicy,
            accountingPolicy: inputs.executionPolicy.content.accountingPolicy, executionSemanticsVersion: inputs.executionPolicy.content.executionSemanticsVersion,
          },
          update: {},
        });

        await tx.paperExecutionIntent.create({
          data: {
            executionIntentId, action: 'OPEN', accountId: held.accountId, pair, strategyInstanceId: admission.strategyInstanceId,
            strategyId: admission.strategyId, strategyVersion: admission.strategyVersion, parameterHash: admission.parameterHash,
            riskDecisionId: admission.riskDecisionId, evaluationTimeMs: decision.evaluationTimeMs, executionPolicySnapshotId: inputs.executionPolicy.executionPolicySnapshotId,
            admissionId: admission.admissionId, approvedQuantity: toPrismaDecimal(decision.approved.approvedQuantity), approvedLeverage: toPrismaDecimal(decision.approved.approvedLeverage),
            approvedNotionalInr: toPrismaDecimal(admission.approvedNotionalInr), approvedMarginInr: toPrismaDecimal(admission.approvedMarginInr),
            validationSubjectId: record.researchApproval.validationSubjectId, validationPlanId: record.researchApproval.validationPlanId,
            validationSubjectResultSha256: record.researchApproval.validationSubjectResultSha256,
          },
        });
        await tx.paperOrder.create({ data: { executionIntentId, accountId: held.accountId, action: 'OPEN', state: 'FILLED' } });

        try {
          await tx.paperFill.create({
            data: {
              orderId: executionIntentId, accountId: held.accountId, sourceStrategyDecisionId: decision.sourceStrategyDecisionId, sourceExecutionKey,
              pair, action: 'OPEN', side, fillPrice: post(fillPriceInr), quantity: toPrismaDecimal(decision.approved.approvedQuantity), feeInr: post(feeInr),
              quoteSnapshotContentSha256: quote.contentSha256, eventTimeMs: quote.providerEventTimeMs,
            },
          });
        } catch (fillError) {
          // V2.3 §6 terminal dedup — the DB's UNIQUE(accountId, sourceStrategyDecisionId)
          // is the authoritative race arbiter (§13), not our earlier precheck read.
          // Re-read to classify per §39 rather than trust the error shape alone.
          if (isP2002(fillError)) throw new SourceDecisionAlreadyExecutedSentinel(fillError);
          throw fillError;
        }

        const released = await coordinator.release(held.accountId, admission.admissionId);
        if (released.status === 'RELEASED') coordinatorMutated = true;
        else if (released.status === 'UNKNOWN_ADMISSION') throw new PaperPersistenceError('DURABLE_CONFLICT', `Durable reservation ${admission.admissionId} exists but C3 has no matching in-memory admission — restore may be required`);
        // ALREADY_RELEASED here would itself be a genuine inconsistency (the reservation row was just verified ADMITTED above) — fail closed.
        else throw new PaperPersistenceError('DURABLE_CONFLICT', `In-memory admission ${admission.admissionId} was already released/consumed while its durable reservation was still ADMITTED`);

        await tx.paperLedgerEntry.create({
          data: {
            entryId: computeLedgerEntryId('FEE', executionIntentId), type: 'FEE', accountId: held.accountId, positionInstanceId, pair,
            strategyInstanceId: admission.strategyInstanceId, strategyId: admission.strategyId, strategyVersion: admission.strategyVersion, parameterHash: admission.parameterHash,
            amountInr: post(feeInr.negated()), sourceFillId: executionIntentId,
            conversionSnapshotContentSha256: conversion.contentSha256, conversionRateInrPerUsdt: toPrismaDecimal(conversion.conversionPriceInrPerUsdt), eventTimeMs: quote.providerEventTimeMs,
          },
        });

        await tx.paperPosition.update({
          where: { accountId_pair: { accountId: held.accountId, pair } },
          data: {
            status: 'OPEN', positionInstanceId, side: admission.direction, quantity: toPrismaDecimal(decision.approved.approvedQuantity),
            averageEntryPriceInr: post(fillPriceInr), leverage: toPrismaDecimal(decision.approved.approvedLeverage), initialMarginInr: post(initialMarginInr),
            cumulativeRealizedPnlInr: new Prisma.Decimal(0), cumulativeFeesInr: post(feeInr), cumulativeFundingInr: new Prisma.Decimal(0),
            openedAtMs: BigInt(quote.providerEventTimeMs), revision: { increment: 1 },
          },
        });

        await tx.paperReservation.update({ where: { admissionId: admission.admissionId }, data: { status: 'CONSUMED' } });

        await tx.paperAccount.update({
          where: { accountId: held.accountId },
          data: { cumulativeFeesInr: { increment: post(feeInr) }, revision: { increment: 1n } },
        });

        return {
          outcome: 'FILLED' as const, executionIntentId, positionInstanceId, side,
          fillPriceInr: quantizePaperPosting(fillPriceInr).value, quantity: decision.approved.approvedQuantity,
          feeInr: quantizePaperPosting(feeInr).value, notionalInr: quantizePaperPosting(notionalInr).value,
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (cause) {
      if (cause instanceof SourceDecisionAlreadyExecutedSentinel) {
        const existing = await this.#prisma.paperFill.findUnique({
          where: { accountId_sourceStrategyDecisionId: { accountId: held.accountId, sourceStrategyDecisionId: decision.sourceStrategyDecisionId } },
        });
        if (existing === null) throw cause.uniqueFailure;
        assertMatchingTerminalFill(existing, expectedTerminalFill);
        return { outcome: 'SOURCE_DECISION_ALREADY_EXECUTED' };
      }
      if (coordinatorMutated) {
        throw new PaperPersistenceError(
          'ADMISSION_OUTCOME_AMBIGUOUS',
          `Durable OPEN fill commit is unconfirmed for account ${held.accountId} admission ${admission.admissionId} after in-memory release was already granted — the account must be treated as FAULTED until an authoritative restore resolves it`,
          { cause: cause instanceof Error ? cause : undefined },
        );
      }
      throw cause;
    }
  }

  /**
   * CLOSE has no reservation/coordinator interaction at all (V2.2 §41) — every
   * write here is a plain DB mutation inside one transaction with no preceding
   * in-memory mutation, so a failure anywhere is an ordinary rollback, never an
   * outcome-ambiguous fault. `PaperAccountSession.executeClose` does not apply
   * the fault-on-ambiguous wrapper for exactly this reason.
   */
  public async executeClose(
    sessionProof: symbol,
    ownership: PaperAccountOwnership,
    authority: PaperCloseExecutionAuthority,
    inputs: PaperCloseExecutionInputs,
  ): Promise<PaperCloseExecutionResult> {
    assertSessionProof(sessionProof);
    const held = readGenuineOwnership(ownership);
    const record = PaperCloseExecutionAuthority.read(authority);
    if (record === null) throw new PaperPersistenceError('NOT_OWNER', 'Caller-shaped CLOSE execution authority object is not genuine');
    if (record.accountId !== held.accountId) throw new PaperPersistenceError('NOT_OWNER', 'CLOSE authority accountId does not match the held ownership accountId');

    const { decision, position } = record;
    const pair = decision.pair;

    const evidence = readTrustedPaperExecutionEvidence(inputs.evidence);
    if (evidence === null) return { outcome: 'EVIDENCE_INVALID', reason: 'UNTRUSTED_EXECUTION_EVIDENCE' };
    const { quote, orderbookDepth, conversion, conversionLocalPollFreshnessMs } = evidence;
    const causalityIssue = assertEvidenceCausality(quote, orderbookDepth, pair);
    const staleIssue = evidenceStaleAtUse(quote, inputs.executionPolicy, inputs.nowMs);
    const conversionStaleIssue = conversionStaleAtUse(conversion, conversionLocalPollFreshnessMs, inputs.nowMs);

    // V1 frozen: full close only — `reduceOnlyQuantity` is always the position's
    // full owned quantity by construction (`close-authority.ts`), never a
    // caller-chosen partial amount. No scale-out/partial-close path exists here.
    const closeQuantity = paperDecimal(record.reduceOnlyQuantity);
    const closeQuantityMatches = closeQuantity.equals(paperDecimal(position.ownedQuantity));

    const executionIntentId = computeCloseExecutionIntentId({
      riskDecisionId: decision.riskDecisionId, accountId: held.accountId, pair, strategyInstanceId: decision.strategyInstanceId,
      strategyId: decision.strategyId, strategyVersion: decision.strategyVersion, parameterHash: decision.parameterHash,
      positionInstanceId: position.positionInstanceId, positionRevision: position.positionRevision, reduceOnlyQuantity: record.reduceOnlyQuantity,
      evaluationTimeMs: decision.evaluationTimeMs, executionPolicySnapshotId: inputs.executionPolicy.executionPolicySnapshotId,
    });
    const sourceExecutionKey = computeSourceExecutionKey({ accountId: held.accountId, sourceStrategyDecisionId: decision.sourceStrategyDecisionId });
    const expectedTerminalFill: ExpectedTerminalFill = {
      accountId: held.accountId,
      sourceStrategyDecisionId: decision.sourceStrategyDecisionId,
      sourceExecutionKey,
      orderId: executionIntentId,
      pair,
      action: 'CLOSE',
      quantity: record.reduceOnlyQuantity,
    };

    // The order/price side is resolved against the durable slot's ACTUAL side
    // inside the transaction below, never trusted from the authority binding
    // alone (the authority is minted before the account-row lock is taken).

    try {
      return await this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT account_id FROM paper_account WHERE account_id = ${held.accountId} FOR UPDATE`;
      const account = await tx.paperAccount.findUnique({ where: { accountId: held.accountId } });
      if (account === null) throw new PaperPersistenceError('ACCOUNT_NOT_FOUND', `No paper_account row for ${held.accountId}`);
      if (account.ownerFence !== held.fence) throw new PaperPersistenceError('STALE_FENCE', `Held fence ${held.fence} no longer matches current ${account.ownerFence}`);

      const terminalFill = await tx.paperFill.findUnique({ where: { accountId_sourceStrategyDecisionId: { accountId: held.accountId, sourceStrategyDecisionId: decision.sourceStrategyDecisionId } } });
      if (terminalFill !== null) {
        assertMatchingTerminalFill(terminalFill, expectedTerminalFill);
        return { outcome: 'SOURCE_DECISION_ALREADY_EXECUTED' as const };
      }
      if (causalityIssue !== null) return { outcome: 'EVIDENCE_INVALID' as const, reason: causalityIssue };
      if (staleIssue !== null) return { outcome: 'EVIDENCE_INVALID' as const, reason: staleIssue };
      if (conversionStaleIssue !== null) return { outcome: 'EVIDENCE_INVALID' as const, reason: conversionStaleIssue };
      if (!closeQuantityMatches) return { outcome: 'POSITION_NOT_READY' as const, reason: 'PARTIAL_CLOSE_NOT_SUPPORTED_IN_V1' };

      await tx.$executeRaw`SELECT account_id FROM paper_position WHERE account_id = ${held.accountId} AND pair = ${pair} FOR UPDATE`;
      const slot = await tx.paperPosition.findUnique({ where: { accountId_pair: { accountId: held.accountId, pair } } });
      if (
        slot === null || slot.status !== 'OPEN' || slot.positionInstanceId !== position.positionInstanceId || slot.revision !== position.positionRevision
        || slot.ownerStrategyInstanceId !== position.ownerStrategyInstanceId || slot.ownerStrategyId !== position.ownerStrategyId
        || slot.ownerStrategyVersion !== position.ownerStrategyVersion || slot.ownerParameterHash !== position.ownerParameterHash
        || slot.side === null || slot.quantity === null || slot.averageEntryPriceInr === null
      ) {
        return { outcome: 'POSITION_NOT_READY' as const, reason: 'PAIR_SLOT_STATE_OR_REVISION_MISMATCH' };
      }

      const actualSide = sideForClosingPosition(slot.side);
      const actualAvailable = availableExecutableQuantity(actualSide, orderbookDepth);
      if (actualAvailable.lessThan(closeQuantity)) return { outcome: 'INSUFFICIENT_LIQUIDITY' as const };

      const rawPrice = rawReferencePrice(actualSide, quote);
      const fillPriceUsdt = computeExecutionPrice(actualSide, rawPrice, inputs.executionPolicy.content.slippageBps, paperDecimal(inputs.priceIncrement));
      const contractMultiplier = paperDecimal(inputs.executionPolicy.content.contractMultiplier);
      const conversionRate = paperDecimal(conversion.conversionPriceInrPerUsdt);
      const notionalUsdt = fillPriceUsdt.times(closeQuantity).times(contractMultiplier);
      const notionalInr = notionalUsdt.times(conversionRate);
      const fillPriceInr = fillPriceUsdt.times(conversionRate);
      const feeInr = computeFeeInr(notionalInr, paperDecimal(inputs.executionPolicy.content.takerFeeRate));
      const entryPriceInr = paperDecimal(slot.averageEntryPriceInr.toFixed());
      const realizedPnlInr = computeRealizedPnlInr({ side: slot.side, entryPriceInr, exitPriceInr: fillPriceInr, closingQuantity: closeQuantity, contractMultiplier });

      await tx.paperExecutionPolicySnapshot.upsert({
        where: { executionPolicySnapshotId: inputs.executionPolicy.executionPolicySnapshotId },
        create: {
          executionPolicySnapshotId: inputs.executionPolicy.executionPolicySnapshotId, policyVersion: inputs.executionPolicy.content.policyVersion,
          fillSelectionPolicy: inputs.executionPolicy.content.fillSelectionPolicy, maxEvidenceAgeMs: inputs.executionPolicy.content.marketEvidenceEligibilityPolicy.maxEvidenceAgeMs,
          requiredHealthState: inputs.executionPolicy.content.marketEvidenceEligibilityPolicy.requiredHealthState, takerFeeRate: toPrismaDecimal(inputs.executionPolicy.content.takerFeeRate),
          slippageBps: toPrismaDecimal(inputs.executionPolicy.content.slippageBps), spreadSemantics: inputs.executionPolicy.content.spreadSemantics,
          tickRoundingPolicy: inputs.executionPolicy.content.tickRoundingPolicy, quantityPolicy: inputs.executionPolicy.content.quantityPolicy,
          contractMultiplier: toPrismaDecimal(inputs.executionPolicy.content.contractMultiplier), currencyConversionPolicy: inputs.executionPolicy.content.currencyConversionPolicy,
          accountingPolicy: inputs.executionPolicy.content.accountingPolicy, executionSemanticsVersion: inputs.executionPolicy.content.executionSemanticsVersion,
        },
        update: {},
      });

      await tx.paperExecutionIntent.create({
        data: {
          executionIntentId, action: 'CLOSE', accountId: held.accountId, pair, strategyInstanceId: decision.strategyInstanceId,
          strategyId: decision.strategyId, strategyVersion: decision.strategyVersion, parameterHash: decision.parameterHash,
          riskDecisionId: decision.riskDecisionId, evaluationTimeMs: decision.evaluationTimeMs, executionPolicySnapshotId: inputs.executionPolicy.executionPolicySnapshotId,
          positionInstanceId: position.positionInstanceId, positionRevision: position.positionRevision, reduceOnlyQuantity: toPrismaDecimal(record.reduceOnlyQuantity),
        },
      });
      await tx.paperOrder.create({ data: { executionIntentId, accountId: held.accountId, action: 'CLOSE', state: 'FILLED' } });

      try {
        await tx.paperFill.create({
          data: {
            orderId: executionIntentId, accountId: held.accountId, sourceStrategyDecisionId: decision.sourceStrategyDecisionId, sourceExecutionKey,
            pair, action: 'CLOSE', side: actualSide, fillPrice: post(fillPriceInr), quantity: toPrismaDecimal(record.reduceOnlyQuantity), feeInr: post(feeInr),
            realizedPnlInr: post(realizedPnlInr), quoteSnapshotContentSha256: quote.contentSha256, eventTimeMs: quote.providerEventTimeMs,
          },
        });
      } catch (fillError) {
        if (isP2002(fillError)) throw new SourceDecisionAlreadyExecutedSentinel(fillError);
        throw fillError;
      }

      await tx.paperLedgerEntry.create({
        data: {
          entryId: computeLedgerEntryId('FEE', executionIntentId), type: 'FEE', accountId: held.accountId, positionInstanceId: position.positionInstanceId, pair,
          strategyInstanceId: decision.strategyInstanceId, strategyId: decision.strategyId, strategyVersion: decision.strategyVersion, parameterHash: decision.parameterHash,
          amountInr: post(feeInr.negated()), sourceFillId: executionIntentId,
          conversionSnapshotContentSha256: conversion.contentSha256, conversionRateInrPerUsdt: toPrismaDecimal(conversion.conversionPriceInrPerUsdt), eventTimeMs: quote.providerEventTimeMs,
        },
      });
      await tx.paperLedgerEntry.create({
        data: {
          entryId: computeLedgerEntryId('REALIZED_PNL', executionIntentId), type: 'REALIZED_PNL', accountId: held.accountId, positionInstanceId: position.positionInstanceId, pair,
          strategyInstanceId: decision.strategyInstanceId, strategyId: decision.strategyId, strategyVersion: decision.strategyVersion, parameterHash: decision.parameterHash,
          amountInr: post(realizedPnlInr), sourceFillId: executionIntentId,
          conversionSnapshotContentSha256: conversion.contentSha256, conversionRateInrPerUsdt: toPrismaDecimal(conversion.conversionPriceInrPerUsdt), eventTimeMs: quote.providerEventTimeMs,
        },
      });

      // `PaperPosition` never stores its own `openingExecutionIntentId` directly
      // (it's baked one-way into `positionInstanceId`'s hash) — but the OPEN
      // transition never clears `admissionId` from the slot while OPEN, and
      // `PaperExecutionIntent.admissionId` is UNIQUE (V2 §11: one reservation
      // backs at most one intent), so it is recoverable exactly, not fabricated.
      if (slot.admissionId === null) throw new PaperPersistenceError('DURABLE_CONFLICT', `OPEN pair slot for (${held.accountId}, ${pair}) is missing its opening admissionId`);
      const openingIntent = await tx.paperExecutionIntent.findUnique({ where: { admissionId: slot.admissionId } });
      if (openingIntent === null) throw new PaperPersistenceError('DURABLE_CONFLICT', `No OPEN execution intent found for admission ${slot.admissionId} backing position ${position.positionInstanceId}`);

      const totalFeesInr = post(paperDecimal(slot.cumulativeFeesInr.toFixed()).plus(feeInr));
      await tx.paperPositionOwnershipHistory.create({
        data: {
          positionInstanceId: position.positionInstanceId, accountId: held.accountId, pair, strategyInstanceId: decision.strategyInstanceId,
          strategyId: decision.strategyId, strategyVersion: decision.strategyVersion, parameterHash: decision.parameterHash, side: slot.side,
          openingExecutionIntentId: openingIntent.executionIntentId,
          closingExecutionIntentId: executionIntentId, quantity: slot.quantity, averageEntryPriceInr: slot.averageEntryPriceInr, exitPriceInr: post(fillPriceInr),
          realizedPnlInr: post(realizedPnlInr), totalFeesInr, totalFundingInr: slot.cumulativeFundingInr, openedAtMs: slot.openedAtMs ?? BigInt(quote.providerEventTimeMs),
          closedAtMs: BigInt(quote.providerEventTimeMs),
        },
      });

      await tx.paperPosition.update({
        where: { accountId_pair: { accountId: held.accountId, pair } },
        data: {
          status: 'EMPTY', admissionId: null, positionInstanceId: null, ownerStrategyInstanceId: null, ownerStrategyId: null, ownerStrategyVersion: null, ownerParameterHash: null,
          side: null, quantity: null, averageEntryPriceInr: null, leverage: null, initialMarginInr: null,
          cumulativeRealizedPnlInr: new Prisma.Decimal(0), cumulativeFeesInr: new Prisma.Decimal(0), cumulativeFundingInr: new Prisma.Decimal(0), openedAtMs: null,
          revision: { increment: 1 },
        },
      });

      await tx.paperAccount.update({
        where: { accountId: held.accountId },
        data: { cumulativeRealizedPnlInr: { increment: post(realizedPnlInr) }, cumulativeFeesInr: { increment: post(feeInr) }, revision: { increment: 1n } },
      });

      return {
        outcome: 'CLOSED' as const, executionIntentId, positionInstanceId: position.positionInstanceId, side: actualSide,
        fillPriceInr: quantizePaperPosting(fillPriceInr).value, quantity: record.reduceOnlyQuantity,
        feeInr: quantizePaperPosting(feeInr).value, realizedPnlInr: quantizePaperPosting(realizedPnlInr).value,
      };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (cause) {
      if (cause instanceof SourceDecisionAlreadyExecutedSentinel) {
        const existing = await this.#prisma.paperFill.findUnique({
          where: { accountId_sourceStrategyDecisionId: { accountId: held.accountId, sourceStrategyDecisionId: decision.sourceStrategyDecisionId } },
        });
        if (existing === null) throw cause.uniqueFailure;
        assertMatchingTerminalFill(existing, expectedTerminalFill);
        return { outcome: 'SOURCE_DECISION_ALREADY_EXECUTED' };
      }
      throw cause;
    }
  }
}
