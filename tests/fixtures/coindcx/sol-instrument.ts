/**
 * Captured CoinDCX SOL Instrument Specification Fixture.
 *
 * PROVENANCE:
 * - Source Endpoint: https://api.coindcx.com/exchange/v1/derivatives/futures/data/instrument?pair=B-SOL_USDT&margin_currency_short_name=INR
 * - Capture Timestamp: 2026-09-16T17:24:46Z
 * - Pair: B-SOL_USDT
 * - Underlying: SOL
 * - Product Kind: perpetual
 * - Margin Currency: INR
 * - Settle Currency: USDT
 * - Quote Currency: USDT
 * - Contract Multiplier (unit_contract_value): 1.0
 * - Price Increment (price_increment): 0.01
 * - Quantity Increment (quantity_increment): 0.01
 * - Base Max Leverage: max_leverage_long = 5, max_leverage_short = 5
 * - Dynamic Position Leverage Tiers: 11 verified exchange tiers (2x to 100x brackets based on position size)
 * - Dynamic Safety Margin Tiers: 11 verified brackets (0.5% to 12.5%)
 * - Raw Fixture File: tests/fixtures/coindcx/sol-instrument.json
 * - Raw Fixture Size: 1933 bytes
 * - Raw Fixture SHA-256: 94580b8731fd961adb6686141ac4e2d299d7db16120b57dce321d18984003f7e
 *
 * POLICY NOTE:
 * The bot's `configuredAbsoluteMaxLeverage: 20` defined in `src/app/config/coins.ts`
 * is an application-level risk policy cap. It must NEVER be confused with or
 * described as CoinDCX's exchange maximum leverage, which permits up to 100x for small positions.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURE_PATH = join(__dirname, 'sol-instrument.json');
export const RAW_SOL_FIXTURE_SHA256 = '94580b8731fd961adb6686141ac4e2d299d7db16120b57dce321d18984003f7e';

export interface CapturedSolInstrumentJsonPayload {
  readonly instrument: {
    readonly settle_currency_short_name: string;
    readonly quote_currency_short_name: string;
    readonly position_currency_short_name: string;
    readonly underlying_currency_short_name: string;
    readonly status: string;
    readonly pair: string;
    readonly kind: string;
    readonly settlement: string;
    readonly max_leverage_long: number;
    readonly max_leverage_short: number;
    readonly unit_contract_value: number;
    readonly price_increment: number;
    readonly quantity_increment: number;
    readonly min_trade_size: number;
    readonly min_price: number;
    readonly max_price: number;
    readonly min_quantity: number;
    readonly max_quantity: number;
    readonly min_notional: number;
    readonly maker_fee: number;
    readonly taker_fee: number;
    readonly safety_percentage: number;
    readonly quanto_to_settle_multiplier: number;
    readonly is_inverse: boolean;
    readonly is_quanto: boolean;
    readonly allow_post_only: boolean;
    readonly allow_hidden: boolean;
    readonly max_market_order_quantity: number;
    readonly funding_frequency: number;
    readonly max_notional: number;
    readonly expiry_time: number;
    readonly exit_only: boolean;
    readonly multiplier_up: number;
    readonly multiplier_down: number;
    readonly liquidation_fee: number;
    readonly time_in_force_options: readonly string[];
    readonly order_types: readonly string[];
    readonly dynamic_position_leverage_details: Readonly<Record<string, number>>;
    readonly dynamic_safety_margin_details: Readonly<Record<string, number>>;
    readonly margin_currency_short_name: string;
  };
}

let cachedPayload: CapturedSolInstrumentJsonPayload | null = null;

export function getCapturedSolInstrumentPayload(): CapturedSolInstrumentJsonPayload {
  if (cachedPayload === null) {
    const raw = readFileSync(FIXTURE_PATH, 'utf8');
    cachedPayload = Object.freeze(JSON.parse(raw)) as CapturedSolInstrumentJsonPayload;
  }
  return cachedPayload;
}

export function getRawSolInstrumentBuffer(): Buffer {
  return readFileSync(FIXTURE_PATH);
}

export function getRawSolInstrumentSha256(): string {
  const buf = getRawSolInstrumentBuffer();
  return createHash('sha256').update(buf).digest('hex');
}
