import type { InrFuturesPosition } from '../integration/coindcx/models';
import { canonicalDecimalString, canonicalRiskDecimal, checkedProduct, riskDecimal, ValuationNumericContextError } from './decimal';
import type { RiskRejectionCode } from './reason-codes';
import type { CanonicalPositionValuation, PairPositionState, PairRiskSnapshot, StrategyRiskCandidate } from './types';

export function normalizeCoinDcxPosition(position: InrFuturesPosition, valuation: CanonicalPositionValuation | null): PairPositionState {
  if (position.activePositionQuantity.isZero()) return { state: 'FLAT' };
  return {
    state: 'OPEN', positionId: position.id,
    positionDirection: position.activePositionQuantity.isPositive() ? 'LONG' : 'SHORT',
    quantityMagnitude: canonicalDecimalString(position.activePositionQuantity.abs().toFixed()), valuation,
  };
}

export interface OwnershipCheck {
  readonly reasons: readonly RiskRejectionCode[];
  readonly ownedQuantity: string | null;
  readonly ownedNotionalInr: string | null;
}

export function verifyOwnership(
  pair: PairRiskSnapshot,
  candidate: StrategyRiskCandidate,
  accountId: string | null,
  unitValue: string | null,
  aggregateValue: string | null,
): OwnershipCheck {
  const reasons: RiskRejectionCode[] = [];
  if (pair.ownership.status === 'UNRECONCILED') return { reasons: ['POSITION_OWNERSHIP_UNRECONCILED'], ownedQuantity: null, ownedNotionalInr: null };
  if (pair.ownership.pair !== pair.pair) reasons.push('DECISION_IDENTITY_MISMATCH');
  if (accountId !== null && pair.ownership.accountId !== accountId) reasons.push('ACCOUNT_IDENTITY_MISMATCH');
  if (pair.position.state === 'FLAT') {
    if (pair.ownership.positionState !== 'FLAT') reasons.push('POSITION_OWNERSHIP_UNRECONCILED');
    return { reasons, ownedQuantity: null, ownedNotionalInr: null };
  }
  if (pair.ownership.positionState !== 'OPEN') return { reasons: [...reasons, 'POSITION_OWNERSHIP_UNRECONCILED'], ownedQuantity: null, ownedNotionalInr: null };
  if (pair.ownership.positionId !== pair.position.positionId) reasons.push('POSITION_IDENTITY_MISMATCH');
  const seenInstanceIds = new Set<string>();
  const duplicateInstanceIds = new Set<string>();
  for (const record of pair.ownership.instanceOwnership) {
    if (seenInstanceIds.has(record.strategyInstanceId)) duplicateInstanceIds.add(record.strategyInstanceId);
    else seenInstanceIds.add(record.strategyInstanceId);
  }
  if (duplicateInstanceIds.size > 0) reasons.push('POSITION_OWNERSHIP_UNRECONCILED');
  let quantitySum = riskDecimal('0');
  let notionalSum = riskDecimal('0');
  let ownedQuantity: string | null = null;
  let ownedNotionalInr: string | null = null;
  for (const record of pair.ownership.instanceOwnership) {
    const quantity = riskDecimal(record.currentQuantity);
    if (quantity.lte(0)) reasons.push('POSITION_OWNERSHIP_UNRECONCILED');
    quantitySum = quantitySum.plus(quantity);
    notionalSum = notionalSum.plus(record.currentNotionalInr);
    if (record.strategyInstanceId === candidate.strategyDecision.strategyInstanceId) {
      if (record.strategyId !== candidate.strategyDecision.strategyId || record.strategyVersion !== candidate.strategyDecision.strategyVersion || record.parameterHash !== candidate.strategyDecision.parameterHash) reasons.push('DECISION_IDENTITY_MISMATCH');
      else if (!duplicateInstanceIds.has(record.strategyInstanceId)) {
        ownedQuantity = record.currentQuantity;
        ownedNotionalInr = record.currentNotionalInr;
      }
    }
    if (unitValue !== null && quantity.gt(0)) {
      try {
        if (canonicalRiskDecimal(checkedProduct(quantity, riskDecimal(unitValue))) !== record.currentNotionalInr) reasons.push('POSITION_OWNERSHIP_UNRECONCILED');
      } catch (error) {
        if (error instanceof ValuationNumericContextError) reasons.push('VALUATION_NUMERIC_CONTEXT_EXCEEDED'); else throw error;
      }
    }
  }
  if (!quantitySum.eq(pair.position.quantityMagnitude) || pair.position.valuation === null ||
      (aggregateValue !== null && !notionalSum.eq(aggregateValue))) reasons.push('POSITION_OWNERSHIP_UNRECONCILED');
  return { reasons, ownedQuantity, ownedNotionalInr };
}
