import { CoinDcxSocketValidationError } from '../../../core/errors/app-error';

const FUTURES_PAIR_REGEX = /^B-[A-Z0-9]+_[A-Z0-9]+$/;
const CANONICAL_INTERVAL = '1m';

/**
 * Pure, deterministic builder for CoinDCX Futures WebSocket candlestick channels.
 *
 * Contract:
 * Follows official CoinDCX documentation example format: `${pair}_${interval}-futures`
 * (e.g. 'B-BTC_USDT_1m-futures').
 *
 * Rejection Rules:
 * - Reject empty or whitespace-only pair.
 * - Reject non-futures / spot pair format (must match /^B-[A-Z0-9]+_[A-Z0-9]+$/).
 * - Reject intervals other than canonical '1m' in Phase 4.
 * - Zero coin-specific hardcoded symbols or conditions.
 */
export function buildFuturesCandleChannel(pair: string, interval: string = CANONICAL_INTERVAL): string {
  if (!pair || typeof pair !== 'string' || pair.trim() === '') {
    throw new CoinDcxSocketValidationError('CoinDCX pair must be a non-empty string');
  }

  const trimmedPair = pair.trim();
  if (!FUTURES_PAIR_REGEX.test(trimmedPair)) {
    throw new CoinDcxSocketValidationError(
      `Invalid CoinDCX Futures pair format: '${pair}'. Must match B-<BASE>_<QUOTE> uppercase (e.g. B-BTC_USDT)`
    );
  }

  if (interval !== CANONICAL_INTERVAL) {
    throw new CoinDcxSocketValidationError(
      `Invalid candle interval: '${interval}'. Phase 4 canonical live stream strictly supports '1m' only`
    );
  }

  return `${trimmedPair}_${interval}-futures`;
}

/**
 * Pure deterministic builder for CoinDCX Futures trade channel (optional extension).
 * Format: `${pair}@trades-futures`
 */
export function buildFuturesTradeChannel(pair: string): string {
  if (!pair || typeof pair !== 'string' || pair.trim() === '') {
    throw new CoinDcxSocketValidationError('CoinDCX pair must be a non-empty string');
  }

  const trimmedPair = pair.trim();
  if (!FUTURES_PAIR_REGEX.test(trimmedPair)) {
    throw new CoinDcxSocketValidationError(
      `Invalid CoinDCX Futures pair format: '${pair}'. Must match B-<BASE>_<QUOTE> uppercase (e.g. B-BTC_USDT)`
    );
  }

  return `${trimmedPair}@trades-futures`;
}

/**
 * Validates whether a channel string matches the expected futures candle channel for a given pair and interval.
 */
export function matchesFuturesCandleChannel(
  channelName: string,
  expectedPair: string,
  interval: string = CANONICAL_INTERVAL
): boolean {
  if (!channelName || !expectedPair) return false;
  const expectedChannel = `${expectedPair}_${interval}-futures`;
  return channelName === expectedChannel;
}
