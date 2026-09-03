import { CoinProfile, Timeframe, validateCoinProfiles } from '../../coin-runtime';
import { Decimal } from '../../core/decimal/decimal';

const STANDARD_TIMEFRAMES: readonly Timeframe[] = Object.freeze([
  '1m',
  '2m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
]);

/**
 * Initial static coin configuration for CoinDCX Quant Futures Bot (Phase 3).
 *
 * Invariant Guarantees:
 * - Live trading is strictly disabled across all initial coin profiles (Invariant 20).
 * - 1m timeframe is configured for all data-enabled assets (Invariant 6).
 * - Zero hardcoded exchange pair identifiers (Invariant 4).
 * - Zero API credentials or secrets (Invariant 16).
 */
export const DEFAULT_COIN_PROFILES: readonly CoinProfile[] = Object.freeze([
  Object.freeze({
    underlying: 'BTC',
    enabled: true,
    dataEnabled: true,
    researchEnabled: true,
    paperEnabled: false,
    shadowEnabled: false,
    liveEnabled: false,
    timeframes: STANDARD_TIMEFRAMES,
    strategyAssignments: Object.freeze([]),
    riskProfileId: 'DEFAULT_SAFE',
    defaultLeverage: new Decimal(1),
    configuredAbsoluteMaxLeverage: new Decimal(20),
  }),
  Object.freeze({
    underlying: 'ETH',
    enabled: true,
    dataEnabled: true,
    researchEnabled: true,
    paperEnabled: false,
    shadowEnabled: false,
    liveEnabled: false,
    timeframes: STANDARD_TIMEFRAMES,
    strategyAssignments: Object.freeze([]),
    riskProfileId: 'DEFAULT_SAFE',
    defaultLeverage: new Decimal(1),
    configuredAbsoluteMaxLeverage: new Decimal(20),
  }),
]);


/**
 * Loads and validates coin configuration profiles.
 */
export function loadCoinProfiles(): readonly CoinProfile[] {
  return validateCoinProfiles(DEFAULT_COIN_PROFILES);
}
