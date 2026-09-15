import { Prisma } from '@prisma/client';
import { paperDecimal } from '../decimal';
import { validateInstrumentEconomicsSnapshot, type InstrumentEconomicsSnapshot } from '../instrument-economics';
import { validateExecutionPolicySnapshot, type ExecutionPolicySnapshot } from '../policy';
import { PaperPersistenceError } from './errors';

type Tx = Prisma.TransactionClient;

export function executionPolicySnapshotFromRow(row: {
  readonly executionPolicySnapshotId: string; readonly policyVersion: string; readonly fillSelectionPolicy: string;
  readonly maxEvidenceAgeMs: number; readonly requiredHealthState: string; readonly takerFeeRate: Prisma.Decimal;
  readonly slippageBps: Prisma.Decimal; readonly spreadSemantics: string; readonly tickRoundingPolicy: string;
  readonly quantityPolicy: string; readonly contractMultiplier: Prisma.Decimal; readonly currencyConversionPolicy: string;
  readonly accountingPolicy: string; readonly executionSemanticsVersion: string;
}): ExecutionPolicySnapshot {
  return validateExecutionPolicySnapshot({
    executionPolicySnapshotId: row.executionPolicySnapshotId,
    content: {
      policyVersion: row.policyVersion as ExecutionPolicySnapshot['content']['policyVersion'],
      fillSelectionPolicy: row.fillSelectionPolicy,
      marketEvidenceEligibilityPolicy: {
        maxEvidenceAgeMs: row.maxEvidenceAgeMs,
        requiredHealthState: row.requiredHealthState as ExecutionPolicySnapshot['content']['marketEvidenceEligibilityPolicy']['requiredHealthState'],
      },
      takerFeeRate: row.takerFeeRate.toFixed(), slippageBps: row.slippageBps.toFixed(), spreadSemantics: row.spreadSemantics,
      tickRoundingPolicy: row.tickRoundingPolicy, quantityPolicy: row.quantityPolicy, contractMultiplier: row.contractMultiplier.toFixed(),
      currencyConversionPolicy: row.currencyConversionPolicy, accountingPolicy: row.accountingPolicy,
      executionSemanticsVersion: row.executionSemanticsVersion,
    },
  });
}

export function instrumentEconomicsSnapshotFromRow(row: {
  readonly instrumentEconomicsSnapshotId: string; readonly identityPolicyId: string; readonly sourceId: string;
  readonly instrumentSpecIdentityPolicyId: string; readonly instrumentSpecSnapshotId: string; readonly pair: string;
  readonly contractMultiplier: Prisma.Decimal; readonly priceIncrement: Prisma.Decimal; readonly quantityIncrement: Prisma.Decimal;
}): InstrumentEconomicsSnapshot {
  return validateInstrumentEconomicsSnapshot({
    instrumentEconomicsSnapshotId: row.instrumentEconomicsSnapshotId,
    identityPolicyId: row.identityPolicyId as InstrumentEconomicsSnapshot['identityPolicyId'],
    sourceId: row.sourceId,
    instrumentSpecIdentityPolicyId: row.instrumentSpecIdentityPolicyId,
    instrumentSpecSnapshotId: row.instrumentSpecSnapshotId,
    pair: row.pair,
    contractMultiplier: row.contractMultiplier.toFixed(),
    priceIncrement: row.priceIncrement.toFixed(),
    quantityIncrement: row.quantityIncrement.toFixed(),
  });
}

function decimalEquals(actual: Prisma.Decimal, expected: string): boolean {
  return paperDecimal(actual.toFixed()).equals(paperDecimal(expected));
}

export function policySnapshotRowMatches(
  row: Awaited<ReturnType<Tx['paperExecutionPolicySnapshot']['findUniqueOrThrow']>>,
  snapshot: ExecutionPolicySnapshot,
): boolean {
  const c = snapshot.content;
  return row.executionPolicySnapshotId === snapshot.executionPolicySnapshotId
    && row.policyVersion === c.policyVersion
    && row.fillSelectionPolicy === c.fillSelectionPolicy
    && row.maxEvidenceAgeMs === c.marketEvidenceEligibilityPolicy.maxEvidenceAgeMs
    && row.requiredHealthState === c.marketEvidenceEligibilityPolicy.requiredHealthState
    && decimalEquals(row.takerFeeRate, c.takerFeeRate)
    && decimalEquals(row.slippageBps, c.slippageBps)
    && row.spreadSemantics === c.spreadSemantics
    && row.tickRoundingPolicy === c.tickRoundingPolicy
    && row.quantityPolicy === c.quantityPolicy
    && decimalEquals(row.contractMultiplier, c.contractMultiplier)
    && row.currencyConversionPolicy === c.currencyConversionPolicy
    && row.accountingPolicy === c.accountingPolicy
    && row.executionSemanticsVersion === c.executionSemanticsVersion;
}

export async function persistImmutableExecutionPolicySnapshot(
  tx: Tx,
  supplied: ExecutionPolicySnapshot,
): Promise<ExecutionPolicySnapshot> {
  const snapshot = validateExecutionPolicySnapshot(supplied);
  const c = snapshot.content;
  await tx.paperExecutionPolicySnapshot.createMany({
    data: [{
      executionPolicySnapshotId: snapshot.executionPolicySnapshotId,
      policyVersion: c.policyVersion,
      fillSelectionPolicy: c.fillSelectionPolicy,
      maxEvidenceAgeMs: c.marketEvidenceEligibilityPolicy.maxEvidenceAgeMs,
      requiredHealthState: c.marketEvidenceEligibilityPolicy.requiredHealthState,
      takerFeeRate: new Prisma.Decimal(c.takerFeeRate),
      slippageBps: new Prisma.Decimal(c.slippageBps),
      spreadSemantics: c.spreadSemantics,
      tickRoundingPolicy: c.tickRoundingPolicy,
      quantityPolicy: c.quantityPolicy,
      contractMultiplier: new Prisma.Decimal(c.contractMultiplier),
      currencyConversionPolicy: c.currencyConversionPolicy,
      accountingPolicy: c.accountingPolicy,
      executionSemanticsVersion: c.executionSemanticsVersion,
    }],
    skipDuplicates: true,
  });
  const row = await tx.paperExecutionPolicySnapshot.findUnique({ where: { executionPolicySnapshotId: snapshot.executionPolicySnapshotId } });
  if (row === null || !policySnapshotRowMatches(row, snapshot)) {
    throw new PaperPersistenceError('POLICY_SNAPSHOT_CONTENT_MISMATCH', `Immutable execution policy ${snapshot.executionPolicySnapshotId} conflicts with canonical supplied content`);
  }
  return snapshot;
}

export function instrumentEconomicsRowMatches(
  row: Awaited<ReturnType<Tx['paperInstrumentEconomicsSnapshot']['findUniqueOrThrow']>>,
  snapshot: InstrumentEconomicsSnapshot,
): boolean {
  return row.instrumentEconomicsSnapshotId === snapshot.instrumentEconomicsSnapshotId
    && row.identityPolicyId === snapshot.identityPolicyId
    && row.sourceId === snapshot.sourceId
    && row.instrumentSpecIdentityPolicyId === snapshot.instrumentSpecIdentityPolicyId
    && row.instrumentSpecSnapshotId === snapshot.instrumentSpecSnapshotId
    && row.pair === snapshot.pair
    && decimalEquals(row.contractMultiplier, snapshot.contractMultiplier)
    && decimalEquals(row.priceIncrement, snapshot.priceIncrement)
    && decimalEquals(row.quantityIncrement, snapshot.quantityIncrement);
}

export async function persistImmutableInstrumentEconomicsSnapshot(
  tx: Tx,
  supplied: InstrumentEconomicsSnapshot,
): Promise<InstrumentEconomicsSnapshot> {
  const snapshot = validateInstrumentEconomicsSnapshot(supplied);
  await tx.paperInstrumentEconomicsSnapshot.createMany({
    data: [{
      instrumentEconomicsSnapshotId: snapshot.instrumentEconomicsSnapshotId,
      identityPolicyId: snapshot.identityPolicyId,
      sourceId: snapshot.sourceId,
      instrumentSpecIdentityPolicyId: snapshot.instrumentSpecIdentityPolicyId,
      instrumentSpecSnapshotId: snapshot.instrumentSpecSnapshotId,
      pair: snapshot.pair,
      contractMultiplier: new Prisma.Decimal(snapshot.contractMultiplier),
      priceIncrement: new Prisma.Decimal(snapshot.priceIncrement),
      quantityIncrement: new Prisma.Decimal(snapshot.quantityIncrement),
    }],
    skipDuplicates: true,
  });
  const row = await tx.paperInstrumentEconomicsSnapshot.findUnique({ where: { instrumentEconomicsSnapshotId: snapshot.instrumentEconomicsSnapshotId } });
  if (row === null || !instrumentEconomicsRowMatches(row, snapshot)) {
    throw new PaperPersistenceError('INSTRUMENT_ECONOMICS_SNAPSHOT_CONTENT_MISMATCH', `Immutable instrument economics ${snapshot.instrumentEconomicsSnapshotId} conflicts with canonical supplied content`);
  }
  return snapshot;
}
