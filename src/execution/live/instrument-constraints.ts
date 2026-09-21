/**
 * Authoritative instrument constraint enforcement and explicit quantization
 * (P17-I11).
 *
 * This module is an execution-owned PORT: it takes only exact Decimal strings
 * and plain metadata, never a CoinDCX client, transport, or model type. The
 * production adapter that fills it from the already-trusted CoinDCX instrument
 * authority lives in `composer.ts`, which is the single file allowed to reach
 * the integration boundary.
 *
 * Quantization rules (deterministic, explicit, never silent):
 *   - quantity ALWAYS floors to `quantityIncrement`. Flooring can only reduce
 *     exposure, so no quantization step can ever increase risk.
 *   - a LIMIT price quantizes AWAY from aggression: a BUY floors to
 *     `priceIncrement`, a SELL ceils. Both directions make the order strictly
 *     less likely to cross, never more.
 */
import {
  canonicalPositiveLiveDecimal,
  floorToIncrement,
  ceilToIncrement,
  isAlignedToIncrement,
  liveDecimal,
  type LiveCalc,
} from './decimal';
import { LiveExecutionError } from './errors';
import type { LiveOrderSide, LiveOrderType } from './types';

/**
 * Exactly the authoritative CoinDCX instrument facts Phase17 needs to prove an
 * order is dispatchable. Every value is an exact fixed-point Decimal string as
 * acquired from the trusted instrument authority — never a JS number.
 */
export interface AuthoritativeInstrumentConstraints {
  readonly pair: string;
  readonly instrumentSpecSnapshotId: string;
  readonly quoteCurrency: string;
  readonly settlementCurrency: string;
  readonly priceIncrement: string;
  readonly quantityIncrement: string;
  readonly minQuantity: string;
  readonly maxQuantity: string;
  readonly minPrice: string;
  readonly maxPrice: string;
  readonly minNotional: string;
  readonly maxNotional: string | null;
  readonly maxMarketOrderQuantity: string | null;
  readonly contractMultiplier: string;
  /**
   * The instrument's own declared order-type lexemes (CoinDCX
   * `instrument.order_types`). Phase17 never invents an `order_type` wire
   * value; it selects one of these, so an undocumented enum is impossible.
   */
  readonly supportedOrderTypes: readonly string[];
  /** The instrument's own declared time-in-force lexemes, if any. */
  readonly supportedTimeInForce: readonly string[];
  /** CoinDCX `exit_only`: when true the instrument refuses new OPEN exposure. */
  readonly exitOnly: boolean;
}

export interface QuantizedOrderEconomics {
  readonly quantity: string;
  readonly price: string | null;
  /** `quantity * price * contractMultiplier`, or `null` for a MARKET order with no reference price. */
  readonly notional: string | null;
  /** True when quantization changed the requested value. Always a reduction in aggression. */
  readonly quantityAdjusted: boolean;
  readonly priceAdjusted: boolean;
}

function constraintFailure(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new LiveExecutionError('LIVE_INSTRUMENT_CONSTRAINT', message, details === undefined ? undefined : { details });
}

/**
 * Quantizes a requested quantity/price pair to the instrument's increments.
 * Purely arithmetic — enforcement of the resulting values happens in
 * `assertOrderWithinInstrumentConstraints`.
 */
export function quantizeOrderEconomics(input: {
  readonly constraints: AuthoritativeInstrumentConstraints;
  readonly side: LiveOrderSide;
  readonly orderType: LiveOrderType;
  readonly quantity: string;
  readonly price: string | null;
}): QuantizedOrderEconomics {
  const { constraints, side, orderType } = input;
  const quantityIncrement = liveDecimal(canonicalPositiveLiveDecimal(constraints.quantityIncrement, 'quantityIncrement'));
  const priceIncrement = liveDecimal(canonicalPositiveLiveDecimal(constraints.priceIncrement, 'priceIncrement'));
  const requestedQuantity = liveDecimal(canonicalPositiveLiveDecimal(input.quantity, 'quantity'));

  const quantizedQuantity = floorToIncrement(requestedQuantity, quantityIncrement);
  if (quantizedQuantity.lessThanOrEqualTo(0)) {
    constraintFailure('Quantity floors to zero at the instrument quantity increment', { pair: constraints.pair });
  }

  let quantizedPrice: LiveCalc | null = null;
  let priceAdjusted = false;
  if (orderType === 'LIMIT') {
    if (input.price === null) constraintFailure('A LIMIT order requires a price', { pair: constraints.pair });
    const requestedPrice = liveDecimal(canonicalPositiveLiveDecimal(input.price, 'price'));
    quantizedPrice = side === 'BUY'
      ? floorToIncrement(requestedPrice, priceIncrement)
      : ceilToIncrement(requestedPrice, priceIncrement);
    priceAdjusted = !quantizedPrice.equals(requestedPrice);
    if (quantizedPrice.lessThanOrEqualTo(0)) {
      constraintFailure('Price quantizes to zero at the instrument price increment', { pair: constraints.pair });
    }
  } else if (input.price !== null) {
    constraintFailure('A MARKET order must not carry a price', { pair: constraints.pair });
  }

  const contractMultiplier = liveDecimal(canonicalPositiveLiveDecimal(constraints.contractMultiplier, 'contractMultiplier'));
  const notional = quantizedPrice === null ? null : quantizedQuantity.times(quantizedPrice).times(contractMultiplier);

  return Object.freeze({
    quantity: quantizedQuantity.toFixed(),
    price: quantizedPrice === null ? null : quantizedPrice.toFixed(),
    notional: notional === null ? null : notional.toFixed(),
    quantityAdjusted: !quantizedQuantity.equals(requestedQuantity),
    priceAdjusted,
  });
}

/**
 * Proves an already-quantized order satisfies every authoritative instrument
 * bound. Any violation fails closed — nothing is silently resized here.
 */
export function assertOrderWithinInstrumentConstraints(input: {
  readonly constraints: AuthoritativeInstrumentConstraints;
  readonly action: 'OPEN' | 'CLOSE';
  readonly orderType: LiveOrderType;
  readonly economics: QuantizedOrderEconomics;
}): void {
  const { constraints, economics, orderType } = input;

  if (input.action === 'OPEN' && constraints.exitOnly) {
    constraintFailure('Instrument is exit-only; new OPEN exposure is refused', { pair: constraints.pair });
  }

  const quantity = liveDecimal(economics.quantity);
  const quantityIncrement = liveDecimal(constraints.quantityIncrement);
  if (!isAlignedToIncrement(quantity, quantityIncrement)) {
    constraintFailure('Quantity is not aligned to the instrument quantity increment', { pair: constraints.pair });
  }
  if (quantity.lessThan(liveDecimal(constraints.minQuantity))) {
    constraintFailure('Quantity is below the instrument minimum', { pair: constraints.pair });
  }
  if (quantity.greaterThan(liveDecimal(constraints.maxQuantity))) {
    constraintFailure('Quantity exceeds the instrument maximum', { pair: constraints.pair });
  }
  if (orderType === 'MARKET' && constraints.maxMarketOrderQuantity !== null
    && quantity.greaterThan(liveDecimal(constraints.maxMarketOrderQuantity))) {
    constraintFailure('Quantity exceeds the instrument market-order maximum', { pair: constraints.pair });
  }

  if (economics.price !== null) {
    const price = liveDecimal(economics.price);
    if (!isAlignedToIncrement(price, liveDecimal(constraints.priceIncrement))) {
      constraintFailure('Price is not aligned to the instrument price increment', { pair: constraints.pair });
    }
    if (price.lessThan(liveDecimal(constraints.minPrice))) {
      constraintFailure('Price is below the instrument minimum', { pair: constraints.pair });
    }
    if (price.greaterThan(liveDecimal(constraints.maxPrice))) {
      constraintFailure('Price exceeds the instrument maximum', { pair: constraints.pair });
    }
  }

  if (economics.notional !== null) {
    const notional = liveDecimal(economics.notional);
    if (notional.lessThan(liveDecimal(constraints.minNotional))) {
      constraintFailure('Notional is below the instrument minimum', { pair: constraints.pair });
    }
    if (constraints.maxNotional !== null && notional.greaterThan(liveDecimal(constraints.maxNotional))) {
      constraintFailure('Notional exceeds the instrument maximum', { pair: constraints.pair });
    }
  }
}

/**
 * Resolves the exact `order_type` lexeme to send on the wire from the
 * instrument's own declared list. Phase17 never invents an enum value: if the
 * instrument does not declare a member matching the requested economic shape,
 * the order is refused as unsupported rather than guessed (§10).
 */
export function resolveWireOrderType(constraints: AuthoritativeInstrumentConstraints, orderType: LiveOrderType): string {
  const wanted = orderType === 'MARKET' ? 'market' : 'limit';
  const candidates = constraints.supportedOrderTypes.filter((declared) => {
    const normalized = declared.trim().toLowerCase();
    // Exclude conditional variants (stop_/take_profit_) — Phase17 dispatches
    // only plain market/limit economics.
    if (normalized.startsWith('stop') || normalized.startsWith('take_profit')) return false;
    return normalized === wanted || normalized === `${wanted}_order`;
  });
  const resolved = candidates[0];
  if (resolved === undefined) {
    throw new LiveExecutionError(
      'LIVE_UNSUPPORTED_EXECUTION_SEMANTICS',
      `Instrument does not declare a plain ${orderType} order type`,
      { details: { pair: constraints.pair, orderType } },
    );
  }
  return resolved;
}
