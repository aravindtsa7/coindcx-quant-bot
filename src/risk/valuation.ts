import { canonicalRiskDecimal, checkedProduct, riskDecimal, ValuationNumericContextError } from './decimal';
import type { RiskRejectionCode } from './reason-codes';
import type { PairRiskSnapshot, RiskPolicy, SettlementConversionSnapshot } from './types';

export interface ValuationCheck {
  readonly unitValuationInrPerQty: string | null;
  readonly aggregateCurrentNotionalInr: string | null;
  readonly reasons: readonly RiskRejectionCode[];
}

export function verifyCurrentValuation(pair: PairRiskSnapshot, settlement: SettlementConversionSnapshot | null, policy: RiskPolicy, evaluationTimeMs: number): ValuationCheck {
  if (pair.position.state === 'FLAT') return { unitValuationInrPerQty: '0', aggregateCurrentNotionalInr: '0', reasons: [] };
  if (pair.position.valuation === null) return { unitValuationInrPerQty: null, aggregateCurrentNotionalInr: null, reasons: ['POSITION_OWNERSHIP_UNRECONCILED'] };
  const valuation = pair.position.valuation;
  const reasons: RiskRejectionCode[] = [];
  if (valuation.valuationMethodVersion !== policy.valuationPolicy.valuationMethodVersion || valuation.valuationPriceField !== policy.valuationPolicy.valuationPriceField) reasons.push('VALUATION_METHOD_MISMATCH');
  if (riskDecimal(valuation.valuationPriceUsdt).lte(0)) reasons.push('PAIR_STATE_UNAVAILABLE');
  if (!riskDecimal(valuation.contractMultiplier).eq(pair.contractMultiplier)) reasons.push('PAIR_STATE_UNAVAILABLE');
  if (settlement === null || settlement.sourceCurrency !== 'USDT' || settlement.targetCurrency !== 'INR' || settlement.marginCurrency !== 'INR' || riskDecimal(settlement.rateInrPerUsdt).lte(0)) {
    reasons.push('SETTLEMENT_RATE_UNAVAILABLE');
  } else if (!riskDecimal(valuation.conversionRateInrPerUsdt).eq(settlement.rateInrPerUsdt) || valuation.conversionMarket !== settlement.conversionMarketId) {
    reasons.push('SETTLEMENT_RATE_UNAVAILABLE');
  }
  if (valuation.valuationPriceSourceId !== policy.sourceAuthorityPolicy.pairRiskSourceId || valuation.conversionSourceId !== policy.sourceAuthorityPolicy.conversionSourceId) reasons.push('SOURCE_ID_MISMATCH');
  const causal = (valuation.valuationPriceSourceTimeMs === null || valuation.valuationPriceSourceTimeMs <= valuation.valuationPriceObservedAtMs) && valuation.valuationPriceObservedAtMs <= evaluationTimeMs;
  if (!causal) reasons.push('EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION');
  else if (evaluationTimeMs - valuation.valuationPriceObservedAtMs > policy.freshnessPolicy.maxPairSnapshotAgeMs) reasons.push('PAIR_STATE_UNAVAILABLE');
  if (reasons.includes('VALUATION_METHOD_MISMATCH') || reasons.includes('PAIR_STATE_UNAVAILABLE') || reasons.includes('SETTLEMENT_RATE_UNAVAILABLE')) {
    return { unitValuationInrPerQty: null, aggregateCurrentNotionalInr: null, reasons };
  }
  try {
    const unit = checkedProduct(riskDecimal(valuation.valuationPriceUsdt), riskDecimal(pair.contractMultiplier), riskDecimal(valuation.conversionRateInrPerUsdt))
      .toDecimalPlaces(policy.valuationPolicy.valuationUnitScale);
    const aggregate = checkedProduct(riskDecimal(pair.position.quantityMagnitude), unit);
    const unitCanonical = canonicalRiskDecimal(unit);
    const aggregateCanonical = canonicalRiskDecimal(aggregate);
    if (unitCanonical !== valuation.unitValuationInrPerQty || aggregateCanonical !== valuation.aggregateCurrentNotionalInr) reasons.push('POSITION_OWNERSHIP_UNRECONCILED');
    return { unitValuationInrPerQty: unitCanonical, aggregateCurrentNotionalInr: aggregateCanonical, reasons };
  } catch (error) {
    if (error instanceof ValuationNumericContextError) return { unitValuationInrPerQty: null, aggregateCurrentNotionalInr: null, reasons: [...reasons, 'VALUATION_NUMERIC_CONTEXT_EXCEEDED'] };
    throw error;
  }
}
