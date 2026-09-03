import { Decimal } from '../core/decimal/decimal';
import { CoinDiscoveryError } from '../core/errors/app-error';
import { InrFuturesInstrument } from '../integration/coindcx/models';
import {
  CoinEntryEligibility,
  CoinProfile,
  InstrumentMetadata,
} from './types';

function isPositiveFinite(d: Decimal | null | undefined): boolean {
  return d instanceof Decimal && d.isFinite() && !d.isNaN() && d.greaterThan(0);
}

function isNonNegativeFinite(d: Decimal | null | undefined): boolean {
  return d instanceof Decimal && d.isFinite() && !d.isNaN() && d.greaterThanOrEqualTo(0);
}

/**
 * Maps a Phase 2 normalized InrFuturesInstrument to a runtime InstrumentMetadata snapshot.
 *
 * Invariant Guarantees:
 * - Legacy static ignored leverage fields are discarded and never become runtime limits.
 * - Dynamic leverage tiers and safety margin brackets are preserved exactly.
 * - Margin currency is strictly verified as 'INR'.
 */
export function mapInstrumentToMetadata(
  instrument: InrFuturesInstrument,
  expectedUnderlying: string
): InstrumentMetadata {
  if (instrument.underlyingCurrency.toUpperCase() !== expectedUnderlying.toUpperCase()) {
    throw new CoinDiscoveryError(
      `Discovered instrument underlying '${instrument.underlyingCurrency}' does not match expected '${expectedUnderlying}'`,
      {
        pair: instrument.pair,
        receivedUnderlying: instrument.underlyingCurrency,
        expectedUnderlying,
      }
    );
  }

  if (instrument.marginCurrency !== 'INR') {
    throw new CoinDiscoveryError(
      `Instrument '${instrument.pair}' has unsupported margin currency '${instrument.marginCurrency}', expected 'INR'`,
      { pair: instrument.pair, marginCurrency: instrument.marginCurrency }
    );
  }

  return Object.freeze({
    pair: instrument.pair,
    underlying: instrument.underlyingCurrency.toUpperCase(),
    status: instrument.status,
    kind: instrument.kind,
    settlement: instrument.settlement,
    settleCurrency: instrument.settleCurrency,
    quoteCurrency: instrument.quoteCurrency,
    positionCurrency: instrument.positionCurrency,
    marginCurrency: 'INR',
    unitContractValue: instrument.unitContractValue,
    priceIncrement: instrument.priceIncrement,
    quantityIncrement: instrument.quantityIncrement,
    minTradeSize: instrument.minTradeSize,
    minPrice: instrument.minPrice,
    maxPrice: instrument.maxPrice,
    minQuantity: instrument.minQuantity,
    maxQuantity: instrument.maxQuantity,
    minNotional: instrument.minNotional,
    legacyMaxNotionalIgnored: instrument.maxNotional,
    maxMarketOrderQuantity: instrument.maxMarketOrderQuantity,
    makerFeePercent: instrument.makerFeePercent,
    takerFeePercent: instrument.takerFeePercent,
    safetyPercentage: instrument.safetyPercentage,
    fundingFrequency: instrument.fundingFrequency,
    expiryTimeMs: instrument.expiryTimeMs,
    exitOnly: instrument.exitOnly,
    timeInForceOptions: Object.freeze([...instrument.timeInForceOptions]),
    supportedOrderTypes: Object.freeze([...instrument.supportedOrderTypes]),
    dynamicPositionLeverageTiers: Object.freeze(
      instrument.dynamicPositionLeverageTiers.map((t) =>
        Object.freeze({ leverage: t.leverage, maxPositionSizeUsdt: t.maxPositionSizeUsdt })
      )
    ),
    dynamicSafetyMarginTiers: Object.freeze(
      instrument.dynamicSafetyMarginTiers.map((t) =>
        Object.freeze({
          positionSizeThresholdUsdt: t.positionSizeThresholdUsdt,
          maintenanceMarginPercent: t.maintenanceMarginPercent,
        })
      )
    ),
  });
}

/**
 * Determines static entry eligibility for a coin based on its profile and discovered instrument.
 * Fails closed on all safety-critical static constraints from the normalized Phase 2 instrument.
 */
export function determineEntryEligibility(
  profile: CoinProfile,
  instrument: InstrumentMetadata | null
): CoinEntryEligibility {
  if (!profile.enabled) {
    return 'CONFIG_DISABLED';
  }

  if (instrument === null) {
    return 'UNDISCOVERED';
  }

  if (instrument.status.toLowerCase() !== 'active') {
    return 'INSTRUMENT_INACTIVE';
  }

  if (instrument.exitOnly) {
    return 'EXIT_ONLY';
  }

  if (instrument.marginCurrency !== 'INR') {
    return 'INVALID_INSTRUMENT_METADATA';
  }

  // 1. Tick size & lot size precision increments
  if (!isPositiveFinite(instrument.priceIncrement) || !isPositiveFinite(instrument.quantityIncrement)) {
    return 'INVALID_INSTRUMENT_METADATA';
  }

  // 2. Minimum trade size
  if (!isPositiveFinite(instrument.minTradeSize)) {
    return 'INVALID_INSTRUMENT_METADATA';
  }

  // 3. Price bounds
  if (
    !isPositiveFinite(instrument.minPrice) ||
    !isPositiveFinite(instrument.maxPrice) ||
    instrument.maxPrice.lessThan(instrument.minPrice)
  ) {
    return 'INVALID_INSTRUMENT_METADATA';
  }

  // 4. Quantity bounds
  if (
    !isPositiveFinite(instrument.minQuantity) ||
    !isPositiveFinite(instrument.maxQuantity) ||
    instrument.maxQuantity.lessThan(instrument.minQuantity)
  ) {
    return 'INVALID_INSTRUMENT_METADATA';
  }

  // 5. Notional bounds (minNotional must be positive finite; provider-ignored max_notional has zero eligibility influence)
  if (!isPositiveFinite(instrument.minNotional)) {
    return 'INVALID_INSTRUMENT_METADATA';
  }

  // 6. Market order max quantity

  if (instrument.maxMarketOrderQuantity !== null) {
    if (!isPositiveFinite(instrument.maxMarketOrderQuantity)) {
      return 'INVALID_INSTRUMENT_METADATA';
    }
  }

  // 7. Fee percentages
  if (!isNonNegativeFinite(instrument.makerFeePercent) || !isNonNegativeFinite(instrument.takerFeePercent)) {
    return 'INVALID_INSTRUMENT_METADATA';
  }

  // 8. Dynamic leverage tiers validation
  for (const tier of instrument.dynamicPositionLeverageTiers) {
    if (!isPositiveFinite(tier.leverage) || !isPositiveFinite(tier.maxPositionSizeUsdt)) {
      return 'INVALID_INSTRUMENT_METADATA';
    }
  }

  // 9. Dynamic safety margin tiers validation
  for (const tier of instrument.dynamicSafetyMarginTiers) {
    if (
      !isPositiveFinite(tier.positionSizeThresholdUsdt) ||
      !isPositiveFinite(tier.maintenanceMarginPercent)
    ) {
      return 'INVALID_INSTRUMENT_METADATA';
    }
  }

  return 'ELIGIBLE';
}
