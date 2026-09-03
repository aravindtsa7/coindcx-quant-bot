import { Decimal } from '../core/decimal/decimal';
import { DynamicLeverageTier, DynamicSafetyMarginTier } from '../integration/coindcx/models';

/**
 * Supported timeframe granularities for candle aggregation in the bot.
 * '1m' is the foundational source of truth (Invariant 6).
 */
export type Timeframe =
  | '1m'
  | '2m'
  | '3m'
  | '4m'
  | '5m'
  | '10m'
  | '15m'
  | '30m'
  | '1h';

export const VALID_TIMEFRAMES: readonly Timeframe[] = Object.freeze([
  '1m',
  '2m',
  '3m',
  '4m',
  '5m',
  '10m',
  '15m',
  '30m',
  '1h',
]);

/**
 * Sequential Coin Onboarding Lifecycle states according to docs/COIN_ONBOARDING.md.
 * These are instrument qualification/promotion states, decoupled from order or socket health.
 */
export type CoinLifecycleState =
  | 'DISCOVERED'
  | 'DATA_LOADING'
  | 'DATA_READY'
  | 'BACKTESTING'
  | 'RESEARCH_APPROVED'
  | 'PAPER'
  | 'PAPER_APPROVED'
  | 'SHADOW'
  | 'LIVE_CANDIDATE'
  | 'LIVE'
  | 'DISABLED';

export const ALL_LIFECYCLE_STATES: readonly CoinLifecycleState[] = Object.freeze([
  'DISCOVERED',
  'DATA_LOADING',
  'DATA_READY',
  'BACKTESTING',
  'RESEARCH_APPROVED',
  'PAPER',
  'PAPER_APPROVED',
  'SHADOW',
  'LIVE_CANDIDATE',
  'LIVE',
  'DISABLED',
]);

/**
 * Static/config/provider instrument entry eligibility status.
 * Decoupled from dynamic account balance, daily loss, or strategy signals.
 */
export type CoinEntryEligibility =
  | 'ELIGIBLE'
  | 'DISABLED'
  | 'INSTRUMENT_INACTIVE'
  | 'EXIT_ONLY'
  | 'INVALID_INSTRUMENT_METADATA'
  | 'CONFIG_DISABLED'
  | 'UNDISCOVERED';

/**
 * Strategy assignment metadata for a coin profile.
 * Pure metadata container; contains zero strategy execution logic.
 */
export interface StrategyAssignment {
  readonly strategyId: string;
  readonly enabled: boolean;
  readonly parameterProfileId: string | null;
}

/**
 * Configuration-facing Coin Profile defining operational boundaries per asset.
 */
export interface CoinProfile {
  readonly underlying: string; // Canonical uppercase symbol (e.g. 'BTC', 'ETH')
  readonly enabled: boolean;
  readonly dataEnabled: boolean;
  readonly researchEnabled: boolean;
  readonly paperEnabled: boolean;
  readonly shadowEnabled: boolean;
  readonly liveEnabled: boolean;
  readonly timeframes: readonly Timeframe[];
  readonly strategyAssignments: readonly StrategyAssignment[];
  readonly riskProfileId: string;
  readonly defaultLeverage: Decimal | null;
  readonly configuredAbsoluteMaxLeverage: Decimal | null;
}

/**
 * Normalized runtime instrument metadata mapped from Phase 2 CoinDCX discovery.
 * Retains exact exchange constraints, tick sizes, fee tiers, and dynamic leverage tiers.
 * Never fabricated or filled with synthetic zero placeholders.
 */
export interface InstrumentMetadata {
  readonly pair: string;
  readonly underlying: string;
  readonly status: string;
  readonly kind: string;
  readonly settlement: string | null;
  readonly settleCurrency: string;
  readonly quoteCurrency: string;
  readonly positionCurrency: string;
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
  readonly legacyMaxNotionalIgnored: Decimal | null;
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
}

/**
 * Runtime representation for a configured coin that is disabled and has NEVER been discovered.
 * Strictly guarantees instrument === null (zero fabricated exchange truth).
 */
export interface UndiscoveredDisabledCoinRuntime {
  readonly status: 'UNDISCOVERED_DISABLED';
  readonly profile: CoinProfile;
  readonly instrument: null;
  readonly lifecycle: 'DISABLED';
  readonly entryEligibility: 'CONFIG_DISABLED';
}

/**
 * Runtime representation for an onboarded coin that has undergone real CoinDCX discovery.
 * Holds verified InstrumentMetadata. If later suspended, lifecycle may be 'DISABLED'
 * while preserving its verified historical instrument metadata and 'DISCOVERED' discovery status.
 */
export interface DiscoveredCoinRuntime {
  readonly status: 'DISCOVERED';
  readonly profile: CoinProfile;
  readonly instrument: InstrumentMetadata;
  readonly lifecycle: CoinLifecycleState;
  readonly entryEligibility: CoinEntryEligibility;
}

/**
 * Discriminated union explicitly distinguishing undiscovered disabled truth from discovered truth.
 */
export type CoinRuntime = DiscoveredCoinRuntime | UndiscoveredDisabledCoinRuntime;

/**
 * Subscription intent expressing market data needs to downstream streaming market data manager.
 * Realized only when a real discovered pair exists and market data is enabled.
 */
export interface MarketDataSubscriptionIntent {
  readonly underlying: string;
  readonly pair: string;
  readonly requiresOneMinuteCandles: boolean;
  readonly requiresTrades: boolean;
}

export type CoinBootstrapFailureCategory =
  | 'CONFIG_ERROR'
  | 'DISCOVERY_FAILED'
  | 'MAPPING_FAILED'
  | 'REGISTRATION_FAILED'
  | 'ELIGIBILITY_FAILED';

export interface CoinBootstrapFailure {
  readonly underlying: string;
  readonly category: CoinBootstrapFailureCategory;
  readonly message: string;
}

export interface CoinBootstrapResult {
  readonly successful: readonly CoinRuntime[];
  readonly failures: readonly CoinBootstrapFailure[];
}
