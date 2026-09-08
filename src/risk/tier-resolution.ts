import {
  assertRiskDecimalContext, canonicalRiskDecimal, checkedProduct, floorToIncrement, floorRatioToIncrement, riskDecimal,
  ValuationNumericContextError, type RiskCalc,
} from './decimal';
import { exposureHeadroom, exposureStateReasons } from './exposure';
import type { RiskRejectionCode } from './reason-codes';
import type { CapValue, PositionSizingRequest, PositionSizingValues, RiskCapsApplied, RiskPolicy, VerifiedLeverageTier } from './types';

const resolved = (value: string): CapValue => ({ status: 'RESOLVED', value });
const notApplicable = (): CapValue => ({ status: 'NOT_APPLICABLE', value: null });
const unresolved = (): CapValue => ({ status: 'UNRESOLVED', value: null });

export interface TierSizingResult {
  readonly sizing: PositionSizingValues | null;
  readonly reasons: readonly RiskRejectionCode[];
  readonly capsApplied: RiskCapsApplied;
}

export type TierFailureCause = 'MARGIN_FLOOR' | 'MIN_QUANTITY' | 'MIN_NOTIONAL' | 'OTHER';

export function noFeasibleTierReason(failures: readonly TierFailureCause[]): RiskRejectionCode {
  if (failures.length > 0 && failures.every((failure) => failure === 'MARGIN_FLOOR')) return 'INSUFFICIENT_MARGIN';
  if (failures.length > 0 && failures.every((failure) => failure === 'MIN_QUANTITY')) return 'MIN_QUANTITY_NOT_MET';
  if (failures.length > 0 && failures.every((failure) => failure === 'MIN_NOTIONAL')) return 'MIN_NOTIONAL_NOT_MET';
  return 'NO_VALID_LEVERAGE_TIER';
}

function minimum(values: readonly RiskCalc[]): RiskCalc {
  const first = values[0];
  if (first === undefined) throw new Error('minimum requires values');
  return values.slice(1).reduce((current, value) => current.lt(value) ? current : value, first);
}
function aligned(value: RiskCalc, increment: RiskCalc): boolean { return value.mod(increment).isZero(); }

export function riskCapsForRequest(request: PositionSizingRequest, policy: RiskPolicy): RiskCapsApplied {
  const riskPercent = request.override?.overrideRiskPerTradePercent ?? policy.modeConfig.riskPerTradePercent;
  const maxNotional = request.override?.overrideMaxNotionalInr ?? policy.modeConfig.maxNotionalPerTradeInr;
  return {
    riskPerTradePercentApplied: resolved(riskPercent), maxNotionalPerTradeInrApplied: resolved(maxNotional),
    requestedLeverage: request.leverageProposal?.requestedLeverage === null || request.leverageProposal === null ? notApplicable() : resolved(request.leverageProposal.requestedLeverage),
    modeRecommendedLeverage: resolved(policy.modeConfig.leverageRecommendation),
    exchangeMaxLeverage: request.leverageTierSnapshot === null ? unresolved() : resolved(request.leverageTierSnapshot.exchangeMaxLeverage),
    tierMaxLeverage: unresolved(), accountMaxLeverage: request.accountSnapshot?.accountMaxLeverage === null || request.accountSnapshot === null ? notApplicable() : resolved(request.accountSnapshot.accountMaxLeverage),
    pairMaxLeverage: resolved(policy.pairConfig.pairMaxLeverage), globalMaxLeverage: resolved(policy.globalConfig.globalMaxLeverage), finalLeverage: unresolved(),
  };
}

const PRICE_REASON_CODES: ReadonlySet<RiskRejectionCode> = new Set([
  'INVALID_ENTRY_PRICE', 'INVALID_STOP_PRICE', 'INVALID_STOP_DISTANCE',
]);

export function isInstrumentPriceReason(code: RiskRejectionCode): boolean { return PRICE_REASON_CODES.has(code); }

export function instrumentPriceReasons(request: PositionSizingRequest): readonly RiskRejectionCode[] {
  if (request.action !== 'OPEN') return [];
  const proposal = request.entryStopProposal;
  if (proposal === null) return ['INVALID_ENTRY_PRICE'];
  const pair = request.pairSnapshot;
  const entry = riskDecimal(proposal.entryPriceUsdt);
  const stop = riskDecimal(proposal.stopPriceUsdt);
  const priceIncrement = riskDecimal(pair.priceIncrement);
  const reasons: RiskRejectionCode[] = [];
  const incrementValid = priceIncrement.gt(0);
  // Comparisons are exact and independent of supported arithmetic precision.
  if (entry.lte(0) || entry.lt(pair.minPrice) || entry.gt(pair.maxPrice)) reasons.push('INVALID_ENTRY_PRICE');
  if (stop.lte(0) || stop.lt(pair.minPrice) || stop.gt(pair.maxPrice)) reasons.push('INVALID_STOP_PRICE');
  const side = request.candidate.strategyDecision.targetExposure;
  if ((side === 'LONG' && stop.gte(entry)) || (side === 'SHORT' && stop.lte(entry)) || entry.eq(stop)) reasons.push('INVALID_STOP_DISTANCE');
  try {
    assertRiskDecimalContext(entry, stop, priceIncrement);
    if (incrementValid && !aligned(entry, priceIncrement)) reasons.push('INVALID_ENTRY_PRICE');
    if (incrementValid && !aligned(stop, priceIncrement)) reasons.push('INVALID_STOP_PRICE');
  } catch (error) {
    if (error instanceof ValuationNumericContextError) reasons.push('VALUATION_NUMERIC_CONTEXT_EXCEEDED'); else throw error;
  }
  return reasons;
}

export function validateTierIntervals(tiers: readonly VerifiedLeverageTier[]): boolean {
  if (tiers.length === 0) return false;
  for (let index = 0; index < tiers.length; index += 1) {
    const tier = tiers[index];
    if (tier === undefined || riskDecimal(tier.lowerNotionalUsdt).lt(0) || riskDecimal(tier.maxLeverage).lte(0)) return false;
    if (tier.upperNotionalUsdt === null) { if (index !== tiers.length - 1) return false; }
    else if (riskDecimal(tier.lowerNotionalUsdt).gte(tier.upperNotionalUsdt)) return false;
    if (index > 0) {
      const prior = tiers[index - 1];
      if (prior === undefined || prior.upperNotionalUsdt === null || !riskDecimal(prior.upperNotionalUsdt).eq(tier.lowerNotionalUsdt) || prior.upperInclusive === tier.lowerInclusive) return false;
    } else if (!riskDecimal(tier.lowerNotionalUsdt).eq(0) || !tier.lowerInclusive) return false;
  }
  return true;
}

function inTier(notional: RiskCalc, tier: VerifiedLeverageTier): boolean {
  const lower = riskDecimal(tier.lowerNotionalUsdt);
  if (tier.lowerInclusive ? notional.lt(lower) : notional.lte(lower)) return false;
  if (tier.upperNotionalUsdt === null) return true;
  const upper = riskDecimal(tier.upperNotionalUsdt);
  return tier.upperInclusive ? notional.lte(upper) : notional.lt(upper);
}

function resolveTierSizingUnchecked(request: PositionSizingRequest, policy: RiskPolicy): TierSizingResult {
  const caps = riskCapsForRequest(request, policy);
  const reasons: RiskRejectionCode[] = [];
  if (request.action !== 'OPEN') return { sizing: null, reasons, capsApplied: caps };
  const account = request.accountSnapshot;
  const proposal = request.entryStopProposal;
  const conversion = request.settlementRateSnapshot;
  const tierSnapshot = request.leverageTierSnapshot;
  const exposure = request.exposureSnapshot;
  const pair = request.pairSnapshot;
  const riskPercent = riskDecimal(request.override?.overrideRiskPerTradePercent ?? policy.modeConfig.riskPerTradePercent);
  reasons.push(...instrumentPriceReasons(request));
  if (account === null || !account.accountStateKnown) reasons.push('ACCOUNT_STATE_UNAVAILABLE');
  else if (riskPercent.lte(0) || riskDecimal(account.currentEquityInr).lte(0)) reasons.push('RISK_BUDGET_NON_POSITIVE');
  if (conversion === null || conversion.sourceCurrency !== 'USDT' || conversion.targetCurrency !== 'INR' || conversion.marginCurrency !== 'INR' || riskDecimal(conversion.rateInrPerUsdt).lte(0)) reasons.push('SETTLEMENT_RATE_UNAVAILABLE');
  if (tierSnapshot === null) reasons.push('LEVERAGE_TIERS_UNAVAILABLE');
  else {
    const exchangeMax = riskDecimal(tierSnapshot.exchangeMaxLeverage);
    if (!validateTierIntervals(tierSnapshot.tiers) || tierSnapshot.pair !== request.candidate.pair || exchangeMax.lte(0) || tierSnapshot.tiers.some((tier) => riskDecimal(tier.maxLeverage).gt(exchangeMax))) reasons.push('LEVERAGE_TIERS_UNAVAILABLE');
    if (tierSnapshot.semanticsStatus !== 'VERIFIED' || tierSnapshot.semanticsVersion === null) reasons.push('LEVERAGE_TIER_SEMANTICS_UNVERIFIED');
  }
  if (exposure === null) reasons.push('EXPOSURE_STATE_UNAVAILABLE');
  else {
    reasons.push(...exposureStateReasons(exposure));
    if (exposure.pending.status === 'UNKNOWN') reasons.push('PENDING_EXPOSURE_UNKNOWN');
  }
  if (riskDecimal(pair.quantityIncrement).lte(0) || riskDecimal(pair.priceIncrement).lte(0) || riskDecimal(pair.contractMultiplier).lte(0) ||
      riskDecimal(pair.maxQuantity).lt(pair.minQuantity) || riskDecimal(pair.minQuantity).lt(0)) reasons.push('PAIR_STATE_UNAVAILABLE');
  if (reasons.length > 0 || account === null || proposal === null || conversion === null || tierSnapshot === null || exposure === null || exposure.pending.status === 'UNKNOWN') return { sizing: null, reasons, capsApplied: caps };
  const entry = riskDecimal(proposal.entryPriceUsdt);
  const stop = riskDecimal(proposal.stopPriceUsdt);
  const quantityIncrement = riskDecimal(pair.quantityIncrement);
  const stopDistance = entry.minus(stop).abs();
  const rate = riskDecimal(conversion.rateInrPerUsdt);
  const multiplier = riskDecimal(pair.contractMultiplier);
  const unitNotionalUsdt = checkedProduct(entry, multiplier);
  const riskBudget = checkedProduct(riskDecimal(account.currentEquityInr), riskPercent).div(100);
  const perUnitLossInr = checkedProduct(stopDistance, multiplier, rate);
  if (perUnitLossInr.lte(0) || riskBudget.lte(0)) return { sizing: null, reasons: ['RISK_BUDGET_NON_POSITIVE'], capsApplied: caps };
  const riskCapped = floorRatioToIncrement(riskBudget, perUnitLossInr, quantityIncrement);
  const qtyFromUsdt = (cap: RiskCalc): RiskCalc => floorRatioToIncrement(cap, unitNotionalUsdt, quantityIncrement);
  const qtyFromInr = (cap: RiskCalc): RiskCalc => floorRatioToIncrement(cap, checkedProduct(rate, unitNotionalUsdt), quantityIncrement);
  const headroom = exposureHeadroom(exposure, request.candidate, policy);
  if (headroom === null) return { sizing: null, reasons: ['PENDING_EXPOSURE_UNKNOWN'], capsApplied: caps };
  const maxNotionalInr = riskDecimal(request.override?.overrideMaxNotionalInr ?? policy.modeConfig.maxNotionalPerTradeInr);
  const nonNegative = (value: string): RiskCalc => { const parsed = riskDecimal(value); return parsed.isNegative() ? riskDecimal('0') : parsed; };
  const commonCeilings: { readonly kind: string; readonly quantity: RiskCalc }[] = [
    { kind: 'RISK', quantity: riskCapped },
    { kind: 'MAX_QUANTITY', quantity: riskDecimal(pair.maxQuantity) },
    { kind: 'MAX_NOTIONAL_PER_TRADE', quantity: qtyFromInr(maxNotionalInr) },
    { kind: 'GLOBAL_EXPOSURE', quantity: qtyFromInr(nonNegative(headroom.globalInr)) },
    { kind: 'PAIR_EXPOSURE', quantity: qtyFromInr(nonNegative(headroom.pairInr)) },
    { kind: 'STRATEGY_EXPOSURE', quantity: qtyFromInr(nonNegative(headroom.strategyInr)) },
  ];
  if (pair.maxNotional !== null) commonCeilings.push({ kind: 'PAIR_MAX_NOTIONAL', quantity: qtyFromUsdt(riskDecimal(pair.maxNotional)) });
  const feasible: { quantity: RiskCalc; leverage: RiskCalc; tierLeverage: string }[] = [];
  const failures: TierFailureCause[] = [];
  const minQuantity = riskDecimal(pair.minQuantity); const minTradeSize = riskDecimal(pair.minTradeSize);
  const minimumQuantity = minQuantity.gt(minTradeSize) ? minQuantity : minTradeSize;
  for (const tier of tierSnapshot.tiers) {
    const leverageValues = [riskDecimal(tier.maxLeverage), riskDecimal(policy.modeConfig.leverageRecommendation), riskDecimal(policy.pairConfig.pairMaxLeverage), riskDecimal(policy.globalConfig.globalMaxLeverage)];
    if (request.leverageProposal?.requestedLeverage !== null && request.leverageProposal !== null) leverageValues.push(riskDecimal(request.leverageProposal.requestedLeverage));
    if (request.override?.overrideMaxLeverage !== null && request.override !== null) leverageValues.push(riskDecimal(request.override.overrideMaxLeverage));
    if (account.accountMaxLeverage !== null) leverageValues.push(riskDecimal(account.accountMaxLeverage));
    const finalLeverage = minimum(leverageValues);
    const marginQty = qtyFromInr(checkedProduct(riskDecimal(account.availableMarginInr), finalLeverage));
    const ceilings = [...commonCeilings, { kind: 'MARGIN', quantity: marginQty }];
    if (tier.upperNotionalUsdt !== null) {
      let upper = qtyFromUsdt(riskDecimal(tier.upperNotionalUsdt));
      if (!tier.upperInclusive && checkedProduct(upper, unitNotionalUsdt).eq(tier.upperNotionalUsdt)) { const lowered = upper.minus(quantityIncrement); upper = lowered.isNegative() ? riskDecimal('0') : lowered; }
      ceilings.push({ kind: 'TIER_UPPER', quantity: upper });
    }
    const minimumCeiling = minimum(ceilings.map((ceiling) => ceiling.quantity));
    const quantity = floorToIncrement(minimumCeiling, quantityIncrement);
    const notionalUsdt = checkedProduct(quantity, unitNotionalUsdt);
    const notionalInr = checkedProduct(notionalUsdt, rate);
    const quantityFloorFailed = quantity.lt(minimumQuantity);
    const notionalFloorFailed = notionalUsdt.lt(pair.minNotional);
    if (quantityFloorFailed || notionalFloorFailed) {
      const marginIsBinding = ceilings.some((ceiling) => ceiling.kind === 'MARGIN' && ceiling.quantity.eq(minimumCeiling));
      failures.push(marginIsBinding ? 'MARGIN_FLOOR' : quantityFloorFailed ? 'MIN_QUANTITY' : 'MIN_NOTIONAL');
      continue;
    }
    if (!inTier(notionalUsdt, tier) || quantity.gt(riskCapped) || quantity.gt(pair.maxQuantity) ||
        (pair.maxNotional !== null && notionalUsdt.gt(pair.maxNotional)) || notionalInr.gt(maxNotionalInr) || notionalInr.gt(headroom.globalInr) || notionalInr.gt(headroom.pairInr) || notionalInr.gt(headroom.strategyInr) ||
        notionalInr.gt(checkedProduct(riskDecimal(account.availableMarginInr), finalLeverage))) { failures.push('OTHER'); continue; }
    feasible.push({ quantity, leverage: finalLeverage, tierLeverage: tier.maxLeverage });
  }
  if (feasible.length === 0) {
    reasons.push(noFeasibleTierReason(failures));
    return { sizing: null, reasons, capsApplied: caps };
  }
  feasible.sort((left, right) => right.quantity.cmp(left.quantity) || right.leverage.cmp(left.leverage));
  const selected = feasible[0];
  if (selected === undefined) throw new Error('Feasible sizing set unexpectedly empty');
  const notionalUsdt = checkedProduct(selected.quantity, unitNotionalUsdt);
  const notionalInr = checkedProduct(notionalUsdt, rate);
  const initialMarginUsdt = notionalUsdt.divUp(selected.leverage);
  const initialMarginInr = notionalInr.divUp(selected.leverage);
  const stopRisk = checkedProduct(selected.quantity, perUnitLossInr);
  if (stopRisk.gt(riskBudget)) return { sizing: null, reasons: ['VALUATION_NUMERIC_CONTEXT_EXCEEDED'], capsApplied: caps };
  return {
    sizing: {
      riskBudgetInr: canonicalRiskDecimal(riskBudget), riskCappedQuantity: canonicalRiskDecimal(riskCapped), finalQuantity: canonicalRiskDecimal(selected.quantity), finalLeverage: canonicalRiskDecimal(selected.leverage),
      finalNotionalUsdt: canonicalRiskDecimal(notionalUsdt), finalNotionalInr: canonicalRiskDecimal(notionalInr), estimatedInitialMarginUsdt: canonicalRiskDecimal(initialMarginUsdt),
      estimatedInitialMarginInr: canonicalRiskDecimal(initialMarginInr), estimatedStopLossRiskInr: canonicalRiskDecimal(stopRisk),
    }, reasons, capsApplied: { ...caps, tierMaxLeverage: resolved(selected.tierLeverage), finalLeverage: resolved(canonicalRiskDecimal(selected.leverage)) },
  };
}

export function resolveTierSizing(request: PositionSizingRequest, policy: RiskPolicy): TierSizingResult {
  try {
    return resolveTierSizingUnchecked(request, policy);
  } catch (error) {
    if (error instanceof ValuationNumericContextError) {
      return { sizing: null, reasons: ['VALUATION_NUMERIC_CONTEXT_EXCEEDED'], capsApplied: riskCapsForRequest(request, policy) };
    }
    throw error;
  }
}
