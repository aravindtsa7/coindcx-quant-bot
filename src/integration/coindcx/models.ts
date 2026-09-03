import { Decimal } from '../../core/decimal/decimal';

/**
 * Normalized domain models for CoinDCX Read-Only Integration Layer.
 *
 * CURRENCY SAFETY INVARIANTS:
 * - All financial values have explicit currency semantics in their property names.
 * - USDT contract prices and margins are strictly suffixed `Usdt`.
 * - INR amounts are strictly suffixed `Inr`.
 * - Conversion ratios are strictly suffixed `InrPerUsdt`.
 * - ALL financial values are represented strictly as Decimal instances.
 */

export interface DynamicLeverageTier {
  readonly leverage: Decimal;
  readonly maxPositionSizeUsdt: Decimal;
}

export interface DynamicSafetyMarginTier {
  readonly positionSizeThresholdUsdt: Decimal;
  readonly maintenanceMarginPercent: Decimal;
}

export interface InrFuturesInstrument {
  readonly pair: string;
  readonly status: string;
  readonly kind: string;
  readonly settlement: string | null;
  readonly settleCurrency: string;
  readonly quoteCurrency: string;
  readonly positionCurrency: string;
  readonly underlyingCurrency: string;
  readonly marginCurrency: 'INR';
  readonly unitContractValue: Decimal;
  readonly priceIncrement: Decimal;
  readonly quantityIncrement: Decimal;
  readonly minTradeSize: Decimal;
  readonly minPrice: Decimal;
  readonly maxPrice: Decimal;
  readonly minQuantity: Decimal;
  readonly maxQuantity: Decimal;
  readonly minNotional: Decimal;
  readonly maxNotional: Decimal | null;
  readonly maxMarketOrderQuantity: Decimal | null;
  readonly makerFeePercent: Decimal;
  readonly takerFeePercent: Decimal;
  readonly safetyPercentage: Decimal | null;
  readonly fundingFrequency: number | null;
  readonly expiryTimeMs: number | null;
  readonly exitOnly: boolean;
  readonly timeInForceOptions: readonly string[];
  readonly supportedOrderTypes: readonly string[];
  readonly dynamicPositionLeverageTiers: readonly DynamicLeverageTier[];
  readonly dynamicSafetyMarginTiers: readonly DynamicSafetyMarginTier[];
  readonly legacyMaxLeverageLongIgnored: Decimal | null;
  readonly legacyMaxLeverageShortIgnored: Decimal | null;
  readonly raw: Record<string, unknown>;
}

export interface InrFuturesWallet {
  readonly id: string | null;
  readonly currency: string;
  readonly lockedInitialMargin: Decimal;
  readonly legacyBalanceIgnored: Decimal | null;
  readonly crossOrderMargin: Decimal | null;
  readonly crossUserMargin: Decimal | null;
}

export interface InrFuturesPosition {
  readonly id: string;
  readonly pair: string;

  readonly activePositionQuantity: Decimal; // Signed: negative for short, positive for long, zero for flat
  readonly inactiveBuyQuantity: Decimal;
  readonly inactiveSellQuantity: Decimal;
  readonly avgPriceUsdt: Decimal;
  readonly liquidationPriceUsdt: Decimal | null;
  readonly lockedMarginUsdt: Decimal;
  readonly lockedUserMarginUsdt: Decimal;
  readonly lockedOrderMarginUsdt: Decimal;
  readonly maintenanceMarginUsdt: Decimal | null;
  readonly markPriceUsdt: Decimal | null;
  readonly takeProfitTriggerPriceUsdt: Decimal | null;
  readonly stopLossTriggerPriceUsdt: Decimal | null;
  readonly leverage: Decimal;
  readonly marginType: 'isolated';
  readonly settlementCurrencyAvgPriceInrPerUsdt: Decimal | null;

  readonly marginCurrency: 'INR';
  readonly updatedAtMs: number;
}

export interface InrFuturesOrder {
  readonly id: string;
  readonly pair: string;
  readonly side: 'buy' | 'sell';
  readonly status: string; // Resilient against exchange status extensions
  readonly orderType: string;
  readonly priceUsdt: Decimal | null;
  readonly stopPriceUsdt: Decimal | null;
  readonly avgPriceUsdt: Decimal | null;
  readonly totalQuantity: Decimal;
  readonly remainingQuantity: Decimal;
  readonly cancelledQuantity: Decimal | null;
  readonly feeAmountUsdt: Decimal | null;
  readonly settlementCurrencyConversionPriceInrPerUsdt: Decimal | null;
  readonly makerFeePercent: Decimal | null;
  readonly takerFeePercent: Decimal | null;
  readonly leverage: Decimal | null;
  readonly stage: string | null;
  readonly positionMarginType: string | null;
  readonly marginCurrency: 'INR';
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface InrFuturesPositionTransaction {
  readonly pair: string | null;
  readonly stage: string;
  readonly pnlAmountInr: Decimal;
  readonly feeAmountInr: Decimal;
  readonly priceInInr: Decimal | null;
  readonly priceInUsdt: Decimal | null;
  readonly settlementAmountInr: Decimal | null; // Non-authoritative (ignored by doc)
  readonly parentType: string | null;
  readonly parentId: string | null;
  readonly positionId: string | null;
  readonly source: string | null;
  readonly marginCurrency: 'INR';
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface InrFuturesTrade {
  readonly pair: string;
  readonly side: string;
  readonly priceUsdt: Decimal;
  readonly quantity: Decimal;
  readonly feeAmountUsdt: Decimal;
  readonly isMaker: boolean | null;
  readonly orderId: string | null;
  readonly settlementCurrencyConversionPriceInrPerUsdt: Decimal | null;
  readonly marginCurrency: 'INR';
  readonly timestampMs: number;
}

export interface FuturesWalletTransaction {
  readonly walletId: string | null;
  readonly transactionType: string;
  readonly amount: Decimal;
  readonly currency: string;
  readonly currencyFullName: string | null;
  readonly reason: string | null;
  readonly createdAtMs: number;
}

export interface AuthVerificationResult {
  readonly authenticated: true;
  readonly coindcxId: string;
}
