import { assertExactKeys, assertSafeInteger, assertString } from './canonical';
import { canonicalDecimalString } from './decimal';
import { riskSourceInvalid } from './errors';
import { riskDeepCopyFreeze } from './immutable';
import type {
  AccountRiskSnapshot, CanonicalPositionValuation, CoinDcxLeverageTierSnapshot, DailyPnlComponents,
  EntryStopProposal, EvidenceProvenance, InstanceOwnershipRecord, InstancePendingReservation,
  LeverageProposal, PairPositionState, PairRiskSnapshot, PendingExposureState, PortfolioExposureSnapshot,
  PositionOwnershipState, RiskEvaluationContext, SettlementConversionSnapshot, StrategyRiskCandidate,
  VerifiedLeverageTier,
} from './types';
import type { StrategyDecision } from '../strategies/core/types';

const SHA = /^[a-f0-9]{64}$/;
function boolean(value: unknown, label: string): boolean { if (typeof value !== 'boolean') riskSourceInvalid(`${label} must be boolean`); return value; }
function nullableString(value: unknown, label: string): string | null { if (value === null) return null; assertString(value, label); return value; }
function nullableTime(value: unknown, label: string): number | null { if (value === null) return null; assertSafeInteger(value, label); return value; }
function decimal(value: unknown, label: string): string { return canonicalDecimalString(value, label); }
function nullableDecimal(value: unknown, label: string): string | null { return value === null ? null : decimal(value, label); }
function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) riskSourceInvalid(`${label} must be an array`);
  return value.map((entry, index) => { assertString(entry, `${label}[${index}]`); return entry; });
}

function provenance(value: unknown, label: string): EvidenceProvenance {
  assertExactKeys(value, ['sourceId', 'sourceTimeMs', 'observedAtMs', 'contentSha256'], label);
  assertString(value.sourceId, `${label}.sourceId`);
  assertSafeInteger(value.observedAtMs, `${label}.observedAtMs`);
  const sourceTimeMs = nullableTime(value.sourceTimeMs, `${label}.sourceTimeMs`);
  if (typeof value.contentSha256 !== 'string' || !SHA.test(value.contentSha256)) riskSourceInvalid(`${label}.contentSha256 must be lowercase SHA-256`);
  return { sourceId: value.sourceId, sourceTimeMs, observedAtMs: value.observedAtMs, contentSha256: value.contentSha256 };
}

function strategyDecision(value: unknown): StrategyDecision {
  const keys = ['decisionId', 'decisionSequence', 'strategyInstanceId', 'strategyId', 'strategyVersion', 'parameterHash', 'pair', 'evaluationTimeMs', 'triggerTimeframeMinutes', 'status', 'targetExposure', 'reasonCodes'];
  assertExactKeys(value, keys, 'StrategyDecision');
  if (typeof value.decisionId !== 'string' || !SHA.test(value.decisionId)) riskSourceInvalid('StrategyDecision.decisionId must be lowercase SHA-256');
  if (typeof value.parameterHash !== 'string' || !SHA.test(value.parameterHash)) riskSourceInvalid('StrategyDecision.parameterHash must be lowercase SHA-256');
  assertSafeInteger(value.decisionSequence, 'StrategyDecision.decisionSequence', 1);
  assertSafeInteger(value.evaluationTimeMs, 'StrategyDecision.evaluationTimeMs');
  assertSafeInteger(value.triggerTimeframeMinutes, 'StrategyDecision.triggerTimeframeMinutes', 1);
  for (const key of ['strategyInstanceId', 'strategyId', 'strategyVersion', 'pair'] as const) assertString(value[key], `StrategyDecision.${key}`);
  if (value.status !== 'WARMING' && value.status !== 'READY') riskSourceInvalid('StrategyDecision.status is invalid');
  if (value.targetExposure !== null && value.targetExposure !== 'LONG' && value.targetExposure !== 'SHORT' && value.targetExposure !== 'FLAT') riskSourceInvalid('StrategyDecision.targetExposure is invalid');
  if ((value.status === 'WARMING') !== (value.targetExposure === null)) riskSourceInvalid('StrategyDecision status and targetExposure are inconsistent');
  return { ...value, reasonCodes: stringArray(value.reasonCodes, 'StrategyDecision.reasonCodes') } as StrategyDecision;
}

function candidate(value: unknown): StrategyRiskCandidate {
  assertExactKeys(value, ['strategyDecision', 'pair', 'instrumentSpecSnapshotId'], 'StrategyRiskCandidate');
  assertString(value.pair, 'StrategyRiskCandidate.pair');
  assertString(value.instrumentSpecSnapshotId, 'StrategyRiskCandidate.instrumentSpecSnapshotId');
  return { strategyDecision: strategyDecision(value.strategyDecision), pair: value.pair, instrumentSpecSnapshotId: value.instrumentSpecSnapshotId };
}

function entryStop(value: unknown): EntryStopProposal {
  assertExactKeys(value, ['proposalId', 'proposalPolicyId', 'sourceStrategyDecisionId', 'pair', 'entryPriceUsdt', 'stopPriceUsdt', 'provenance'], 'EntryStopProposal');
  for (const key of ['proposalId', 'proposalPolicyId', 'sourceStrategyDecisionId', 'pair'] as const) assertString(value[key], `EntryStopProposal.${key}`);
  return { proposalId: value.proposalId as string, proposalPolicyId: value.proposalPolicyId as string, sourceStrategyDecisionId: value.sourceStrategyDecisionId as string, pair: value.pair as string,
    entryPriceUsdt: decimal(value.entryPriceUsdt, 'entryPriceUsdt'), stopPriceUsdt: decimal(value.stopPriceUsdt, 'stopPriceUsdt'), provenance: provenance(value.provenance, 'EntryStopProposal.provenance') };
}

function leverage(value: unknown): LeverageProposal {
  assertExactKeys(value, ['proposalId', 'proposalPolicyId', 'sourceStrategyDecisionId', 'requestedLeverage'], 'LeverageProposal');
  for (const key of ['proposalId', 'proposalPolicyId', 'sourceStrategyDecisionId'] as const) assertString(value[key], `LeverageProposal.${key}`);
  return { proposalId: value.proposalId as string, proposalPolicyId: value.proposalPolicyId as string, sourceStrategyDecisionId: value.sourceStrategyDecisionId as string,
    requestedLeverage: nullableDecimal(value.requestedLeverage, 'requestedLeverage') };
}

function ownershipRecord(value: unknown, index: number): InstanceOwnershipRecord {
  assertExactKeys(value, ['strategyInstanceId', 'strategyId', 'strategyVersion', 'parameterHash', 'currentQuantity', 'currentNotionalInr'], `instanceOwnership[${index}]`);
  for (const key of ['strategyInstanceId', 'strategyId', 'strategyVersion', 'parameterHash'] as const) assertString(value[key], `instanceOwnership[${index}].${key}`);
  return { strategyInstanceId: value.strategyInstanceId as string, strategyId: value.strategyId as string, strategyVersion: value.strategyVersion as string, parameterHash: value.parameterHash as string,
    currentQuantity: decimal(value.currentQuantity, `instanceOwnership[${index}].currentQuantity`), currentNotionalInr: decimal(value.currentNotionalInr, `instanceOwnership[${index}].currentNotionalInr`) };
}

function ownership(value: unknown): PositionOwnershipState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) riskSourceInvalid('ownership must be an object');
  const record = value as Record<string, unknown>;
  if (record.status === 'UNRECONCILED') { assertExactKeys(record, ['status'], 'ownership'); return { status: 'UNRECONCILED' }; }
  if (record.status !== 'RECONCILED') riskSourceInvalid('ownership.status is invalid');
  if (record.positionState === 'FLAT') {
    assertExactKeys(record, ['status', 'positionState', 'accountId', 'pair', 'positionId', 'instanceOwnership'], 'flat ownership');
    assertString(record.accountId, 'ownership.accountId'); assertString(record.pair, 'ownership.pair');
    if (record.positionId !== null || !Array.isArray(record.instanceOwnership) || record.instanceOwnership.length !== 0) riskSourceInvalid('flat ownership must have null positionId and empty instanceOwnership');
    return { status: 'RECONCILED', positionState: 'FLAT', accountId: record.accountId, pair: record.pair, positionId: null, instanceOwnership: [] };
  }
  if (record.positionState !== 'OPEN') riskSourceInvalid('ownership.positionState is invalid');
  assertExactKeys(record, ['status', 'positionState', 'accountId', 'pair', 'positionId', 'instanceOwnership'], 'open ownership');
  assertString(record.accountId, 'ownership.accountId'); assertString(record.pair, 'ownership.pair'); assertString(record.positionId, 'ownership.positionId');
  if (!Array.isArray(record.instanceOwnership)) riskSourceInvalid('ownership.instanceOwnership must be an array');
  return { status: 'RECONCILED', positionState: 'OPEN', accountId: record.accountId, pair: record.pair, positionId: record.positionId,
    instanceOwnership: record.instanceOwnership.map(ownershipRecord) };
}

function valuation(value: unknown): CanonicalPositionValuation {
  const keys = ['valuationMethodVersion', 'valuationPriceField', 'valuationPriceUsdt', 'valuationPriceSourceId', 'valuationPriceSourceTimeMs', 'valuationPriceObservedAtMs', 'contractMultiplier', 'conversionMarket', 'conversionRateInrPerUsdt', 'conversionSourceId', 'unitValuationInrPerQty', 'aggregateCurrentNotionalInr'];
  assertExactKeys(value, keys, 'valuation');
  for (const key of ['valuationMethodVersion', 'valuationPriceField', 'valuationPriceSourceId', 'conversionMarket', 'conversionSourceId'] as const) assertString(value[key], `valuation.${key}`);
  assertSafeInteger(value.valuationPriceObservedAtMs, 'valuation.valuationPriceObservedAtMs');
  return { valuationMethodVersion: value.valuationMethodVersion, valuationPriceField: value.valuationPriceField,
    valuationPriceUsdt: decimal(value.valuationPriceUsdt, 'valuationPriceUsdt'), valuationPriceSourceId: value.valuationPriceSourceId,
    valuationPriceSourceTimeMs: nullableTime(value.valuationPriceSourceTimeMs, 'valuationPriceSourceTimeMs'), valuationPriceObservedAtMs: value.valuationPriceObservedAtMs,
    contractMultiplier: decimal(value.contractMultiplier, 'valuation.contractMultiplier'), conversionMarket: value.conversionMarket,
    conversionRateInrPerUsdt: decimal(value.conversionRateInrPerUsdt, 'valuation.conversionRateInrPerUsdt'), conversionSourceId: value.conversionSourceId,
    unitValuationInrPerQty: decimal(value.unitValuationInrPerQty, 'unitValuationInrPerQty'), aggregateCurrentNotionalInr: decimal(value.aggregateCurrentNotionalInr, 'aggregateCurrentNotionalInr') } as CanonicalPositionValuation;
}

function position(value: unknown): PairPositionState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) riskSourceInvalid('position must be an object');
  const record = value as Record<string, unknown>;
  if (record.state === 'FLAT') { assertExactKeys(record, ['state'], 'flat position'); return { state: 'FLAT' }; }
  if (record.state !== 'OPEN') riskSourceInvalid('position.state is invalid');
  assertExactKeys(record, ['state', 'positionId', 'positionDirection', 'quantityMagnitude', 'valuation'], 'open position');
  assertString(record.positionId, 'position.positionId');
  if (record.positionDirection !== 'LONG' && record.positionDirection !== 'SHORT') riskSourceInvalid('position.positionDirection is invalid');
  return { state: 'OPEN', positionId: record.positionId, positionDirection: record.positionDirection,
    quantityMagnitude: decimal(record.quantityMagnitude, 'position.quantityMagnitude'), valuation: record.valuation === null ? null : valuation(record.valuation) };
}

function pairSnapshot(value: unknown): PairRiskSnapshot {
  const keys = ['pair', 'instrumentSpecSnapshotId', 'status', 'exitOnly', 'priceIncrement', 'quantityIncrement', 'minPrice', 'maxPrice', 'minQuantity', 'maxQuantity', 'minTradeSize', 'minNotional', 'maxNotional', 'contractMultiplier', 'position', 'ownership', 'provenance'];
  assertExactKeys(value, keys, 'PairRiskSnapshot');
  for (const key of ['pair', 'instrumentSpecSnapshotId', 'status'] as const) assertString(value[key], `PairRiskSnapshot.${key}`);
  return { pair: value.pair as string, instrumentSpecSnapshotId: value.instrumentSpecSnapshotId as string, status: value.status as string, exitOnly: boolean(value.exitOnly, 'exitOnly'),
    priceIncrement: decimal(value.priceIncrement, 'priceIncrement'), quantityIncrement: decimal(value.quantityIncrement, 'quantityIncrement'),
    minPrice: decimal(value.minPrice, 'minPrice'), maxPrice: decimal(value.maxPrice, 'maxPrice'), minQuantity: decimal(value.minQuantity, 'minQuantity'),
    maxQuantity: decimal(value.maxQuantity, 'maxQuantity'), minTradeSize: decimal(value.minTradeSize, 'minTradeSize'), minNotional: decimal(value.minNotional, 'minNotional'),
    maxNotional: nullableDecimal(value.maxNotional, 'maxNotional'), contractMultiplier: decimal(value.contractMultiplier, 'contractMultiplier'),
    position: position(value.position), ownership: ownership(value.ownership), provenance: provenance(value.provenance, 'PairRiskSnapshot.provenance') };
}

function dailyPnl(value: unknown): DailyPnlComponents {
  const keys = ['realizedTradingPnlInr', 'fundingPnlInr', 'feesInr', 'otherAccountAdjustmentsInr', 'netDailyPnlInr'];
  assertExactKeys(value, keys, 'dailyPnl');
  return Object.fromEntries(keys.map((key) => [key, decimal(value[key], `dailyPnl.${key}`)])) as unknown as DailyPnlComponents;
}
function accountSnapshot(value: unknown): AccountRiskSnapshot {
  const keys = ['accountId', 'provenance', 'accountStateKnown', 'availableMarginInr', 'lockedMarginInr', 'currentEquityInr', 'peakEquityInr', 'dailyPnl', 'consecutiveLossCount', 'cooldownActiveUntilMs', 'accountMaxLeverage', 'reconciliationSourceIds'];
  assertExactKeys(value, keys, 'AccountRiskSnapshot'); assertString(value.accountId, 'accountId'); assertSafeInteger(value.consecutiveLossCount, 'consecutiveLossCount');
  return { accountId: value.accountId, provenance: provenance(value.provenance, 'AccountRiskSnapshot.provenance'), accountStateKnown: boolean(value.accountStateKnown, 'accountStateKnown'),
    availableMarginInr: decimal(value.availableMarginInr, 'availableMarginInr'), lockedMarginInr: decimal(value.lockedMarginInr, 'lockedMarginInr'), currentEquityInr: decimal(value.currentEquityInr, 'currentEquityInr'),
    peakEquityInr: decimal(value.peakEquityInr, 'peakEquityInr'), dailyPnl: dailyPnl(value.dailyPnl), consecutiveLossCount: value.consecutiveLossCount,
    cooldownActiveUntilMs: nullableTime(value.cooldownActiveUntilMs, 'cooldownActiveUntilMs'), accountMaxLeverage: nullableDecimal(value.accountMaxLeverage, 'accountMaxLeverage'),
    reconciliationSourceIds: stringArray(value.reconciliationSourceIds, 'reconciliationSourceIds') };
}

function decimalRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) riskSourceInvalid(`${label} must be an object`);
  return Object.fromEntries(Object.keys(value).sort().map((key) => { assertString(key, `${label} key`); return [key, decimal((value as Record<string, unknown>)[key], `${label}.${key}`)]; }));
}
function reservation(value: unknown, index: number): InstancePendingReservation {
  assertExactKeys(value, ['strategyInstanceId', 'strategyId', 'strategyVersion', 'parameterHash', 'pendingNotionalInr', 'pendingReservationCount'], `reservation[${index}]`);
  for (const key of ['strategyInstanceId', 'strategyId', 'strategyVersion', 'parameterHash'] as const) assertString(value[key], `reservation[${index}].${key}`);
  assertSafeInteger(value.pendingReservationCount, `reservation[${index}].pendingReservationCount`);
  return { strategyInstanceId: value.strategyInstanceId as string, strategyId: value.strategyId as string, strategyVersion: value.strategyVersion as string, parameterHash: value.parameterHash as string,
    pendingNotionalInr: decimal(value.pendingNotionalInr, `reservation[${index}].pendingNotionalInr`), pendingReservationCount: value.pendingReservationCount };
}
function pending(value: unknown): PendingExposureState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) riskSourceInvalid('pending must be an object');
  const record = value as Record<string, unknown>;
  if (record.status === 'UNKNOWN') { assertExactKeys(record, ['status'], 'pending'); return { status: 'UNKNOWN' }; }
  if (record.status !== 'KNOWN') riskSourceInvalid('pending.status is invalid');
  assertExactKeys(record, ['status', 'globalPendingNotionalInr', 'pairPendingNotionalInr', 'strategyPendingNotionalInr', 'instancePendingReservations', 'pendingReservationCount', 'pendingDirectionalNotionalInr'], 'pending');
  if (!Array.isArray(record.instancePendingReservations)) riskSourceInvalid('instancePendingReservations must be an array');
  assertSafeInteger(record.pendingReservationCount, 'pendingReservationCount');
  assertExactKeys(record.pendingDirectionalNotionalInr, ['longInr', 'shortInr'], 'pendingDirectionalNotionalInr');
  return { status: 'KNOWN', globalPendingNotionalInr: decimal(record.globalPendingNotionalInr, 'globalPendingNotionalInr'), pairPendingNotionalInr: decimalRecord(record.pairPendingNotionalInr, 'pairPendingNotionalInr'),
    strategyPendingNotionalInr: decimalRecord(record.strategyPendingNotionalInr, 'strategyPendingNotionalInr'), instancePendingReservations: record.instancePendingReservations.map(reservation),
    pendingReservationCount: record.pendingReservationCount, pendingDirectionalNotionalInr: { longInr: decimal(record.pendingDirectionalNotionalInr.longInr, 'longInr'), shortInr: decimal(record.pendingDirectionalNotionalInr.shortInr, 'shortInr') } };
}
function exposureSnapshot(value: unknown): PortfolioExposureSnapshot {
  assertExactKeys(value, ['globalOpenNotionalInr', 'perPairOpenNotionalInr', 'perStrategyOpenNotionalInr', 'concurrentOpenPositions', 'pending', 'provenance'], 'PortfolioExposureSnapshot');
  assertSafeInteger(value.concurrentOpenPositions, 'concurrentOpenPositions');
  return { globalOpenNotionalInr: decimal(value.globalOpenNotionalInr, 'globalOpenNotionalInr'), perPairOpenNotionalInr: decimalRecord(value.perPairOpenNotionalInr, 'perPairOpenNotionalInr'),
    perStrategyOpenNotionalInr: decimalRecord(value.perStrategyOpenNotionalInr, 'perStrategyOpenNotionalInr'), concurrentOpenPositions: value.concurrentOpenPositions,
    pending: pending(value.pending), provenance: provenance(value.provenance, 'PortfolioExposureSnapshot.provenance') };
}

function tier(value: unknown, index: number): VerifiedLeverageTier {
  assertExactKeys(value, ['tierId', 'lowerNotionalUsdt', 'upperNotionalUsdt', 'lowerInclusive', 'upperInclusive', 'maxLeverage'], `tier[${index}]`); assertString(value.tierId, `tier[${index}].tierId`);
  return { tierId: value.tierId, lowerNotionalUsdt: decimal(value.lowerNotionalUsdt, `tier[${index}].lowerNotionalUsdt`), upperNotionalUsdt: nullableDecimal(value.upperNotionalUsdt, `tier[${index}].upperNotionalUsdt`),
    lowerInclusive: boolean(value.lowerInclusive, 'lowerInclusive'), upperInclusive: boolean(value.upperInclusive, 'upperInclusive'), maxLeverage: decimal(value.maxLeverage, 'maxLeverage') };
}
function tierSnapshot(value: unknown): CoinDcxLeverageTierSnapshot {
  const keys = ['pair', 'provenance', 'semanticsStatus', 'semanticsVersion', 'exchangeMaxLeverage', 'tiers', 'safetyMarginTiers', 'legacyMaxLeverageLongIgnored', 'legacyMaxLeverageShortIgnored'];
  assertExactKeys(value, keys, 'CoinDcxLeverageTierSnapshot'); assertString(value.pair, 'tierSnapshot.pair');
  if (value.semanticsStatus !== 'VERIFIED' && value.semanticsStatus !== 'SEMANTICS_UNVERIFIED') riskSourceInvalid('semanticsStatus is invalid');
  if (!Array.isArray(value.tiers) || !Array.isArray(value.safetyMarginTiers)) riskSourceInvalid('tier arrays are invalid');
  const safety = value.safetyMarginTiers.map((entry, index) => { assertExactKeys(entry, ['positionSizeThresholdUsdt', 'maintenanceMarginPercent'], `safetyMarginTier[${index}]`); return { positionSizeThresholdUsdt: decimal(entry.positionSizeThresholdUsdt, 'positionSizeThresholdUsdt'), maintenanceMarginPercent: decimal(entry.maintenanceMarginPercent, 'maintenanceMarginPercent') }; });
  return { pair: value.pair, provenance: provenance(value.provenance, 'CoinDcxLeverageTierSnapshot.provenance'), semanticsStatus: value.semanticsStatus,
    semanticsVersion: nullableString(value.semanticsVersion, 'semanticsVersion'), exchangeMaxLeverage: decimal(value.exchangeMaxLeverage, 'exchangeMaxLeverage'), tiers: value.tiers.map(tier), safetyMarginTiers: safety,
    legacyMaxLeverageLongIgnored: nullableDecimal(value.legacyMaxLeverageLongIgnored, 'legacyMaxLeverageLongIgnored'), legacyMaxLeverageShortIgnored: nullableDecimal(value.legacyMaxLeverageShortIgnored, 'legacyMaxLeverageShortIgnored') };
}
function settlementSnapshot(value: unknown): SettlementConversionSnapshot {
  assertExactKeys(value, ['conversionMarketId', 'sourceCurrency', 'targetCurrency', 'marginCurrency', 'rateInrPerUsdt', 'provenance'], 'SettlementConversionSnapshot'); assertString(value.conversionMarketId, 'conversionMarketId');
  if (typeof value.sourceCurrency !== 'string' || typeof value.targetCurrency !== 'string' || typeof value.marginCurrency !== 'string') riskSourceInvalid('Settlement currencies must be strings');
  return { conversionMarketId: value.conversionMarketId, sourceCurrency: value.sourceCurrency, targetCurrency: value.targetCurrency, marginCurrency: value.marginCurrency,
    rateInrPerUsdt: decimal(value.rateInrPerUsdt, 'rateInrPerUsdt'), provenance: provenance(value.provenance, 'SettlementConversionSnapshot.provenance') } as SettlementConversionSnapshot;
}

export function normalizeRiskEvaluationContext(value: RiskEvaluationContext): RiskEvaluationContext {
  assertExactKeys(value, value.expectedRiskPolicyId === undefined
    ? ['candidate', 'entryStopProposal', 'leverageProposal', 'override', 'evaluationTimeMs', 'accountSnapshot', 'pairSnapshot', 'exposureSnapshot', 'leverageTierSnapshot', 'settlementRateSnapshot']
    : ['candidate', 'entryStopProposal', 'leverageProposal', 'override', 'evaluationTimeMs', 'expectedRiskPolicyId', 'accountSnapshot', 'pairSnapshot', 'exposureSnapshot', 'leverageTierSnapshot', 'settlementRateSnapshot'], 'RiskEvaluationContext');
  assertSafeInteger(value.evaluationTimeMs, 'evaluationTimeMs');
  if (value.expectedRiskPolicyId !== undefined && (typeof value.expectedRiskPolicyId !== 'string' || !SHA.test(value.expectedRiskPolicyId))) riskSourceInvalid('expectedRiskPolicyId must be SHA-256');
  const normalized: RiskEvaluationContext = {
    candidate: candidate(value.candidate), entryStopProposal: value.entryStopProposal === null ? null : entryStop(value.entryStopProposal), leverageProposal: value.leverageProposal === null ? null : leverage(value.leverageProposal),
    override: value.override === null ? null : { ...value.override }, evaluationTimeMs: value.evaluationTimeMs,
    ...(value.expectedRiskPolicyId === undefined ? {} : { expectedRiskPolicyId: value.expectedRiskPolicyId }),
    accountSnapshot: value.accountSnapshot === null ? null : accountSnapshot(value.accountSnapshot), pairSnapshot: pairSnapshot(value.pairSnapshot), exposureSnapshot: value.exposureSnapshot === null ? null : exposureSnapshot(value.exposureSnapshot),
    leverageTierSnapshot: value.leverageTierSnapshot === null ? null : tierSnapshot(value.leverageTierSnapshot), settlementRateSnapshot: value.settlementRateSnapshot === null ? null : settlementSnapshot(value.settlementRateSnapshot),
  };
  return riskDeepCopyFreeze(normalized);
}
