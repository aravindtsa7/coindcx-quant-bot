import type { InstrumentMetadata } from '../coin-runtime/types';
import { BacktestDecimal, toBacktestCalcDecimal, type BacktestCalc } from './decimal';
import { sha256CanonicalJson } from './canonical-json';
import { BacktestError, type BacktestErrorCode } from './errors';
import { deepFreeze } from './immutable';
import type { BacktestInstrumentSpec, BacktestOrderIntent, BacktestOrderSide, BacktestPositionSide } from './types';

export function computeBacktestInstrumentSpecSnapshotId(
  spec: Omit<BacktestInstrumentSpec, 'instrumentSpecSnapshotId'>,
): string {
  return sha256CanonicalJson({
    pair: spec.pair,
    priceIncrement: spec.priceIncrement.value,
    quantityIncrement: spec.quantityIncrement.value,
    minQuantity: spec.minQuantity.value,
    minTradeSize: spec.minTradeSize.value,
    minNotional: spec.minNotional.value,
    contractMultiplier: spec.contractMultiplier.value,
  });
}

export function createBacktestInstrumentSpec(metadata: InstrumentMetadata): BacktestInstrumentSpec {
  const identity = {
    pair: metadata.pair,
    priceIncrement: metadata.priceIncrement.toFixed(),
    quantityIncrement: metadata.quantityIncrement.toFixed(),
    minQuantity: metadata.minQuantity.toFixed(),
    minTradeSize: metadata.minTradeSize.toFixed(),
    minNotional: metadata.minNotional.toFixed(),
    contractMultiplier: metadata.unitContractValue.toFixed(),
  };
  const snapshot = {
    pair: identity.pair,
    priceIncrement: new BacktestDecimal(identity.priceIncrement),
    quantityIncrement: new BacktestDecimal(identity.quantityIncrement),
    minQuantity: new BacktestDecimal(identity.minQuantity),
    minTradeSize: new BacktestDecimal(identity.minTradeSize),
    minNotional: new BacktestDecimal(identity.minNotional),
    contractMultiplier: new BacktestDecimal(identity.contractMultiplier),
  };
  return deepFreeze({ ...snapshot, instrumentSpecSnapshotId: computeBacktestInstrumentSpecSnapshotId(snapshot) });
}

export interface ValidatedOrderValues {
  readonly pair: string;
  readonly type: 'MARKET' | 'POST_ONLY_LIMIT' | 'STOP_MARKET';
  readonly side: BacktestOrderSide;
  readonly quantity: BacktestDecimal;
  readonly limitPrice: BacktestDecimal | null;
  readonly stopPrice: BacktestDecimal | null;
  readonly reduceOnly: boolean;
  readonly ocoGroupId: string | null;
}

function aligned(value: BacktestCalc, increment: BacktestDecimal): boolean {
  return value.modulo(toBacktestCalcDecimal(increment)).isZero();
}

function reject(code: BacktestErrorCode, message: string): never { throw new BacktestError(code, message); }

export function validateOrderIntent(
  intent: BacktestOrderIntent,
  spec: BacktestInstrumentSpec,
  position: { readonly side: BacktestPositionSide; readonly quantity: BacktestDecimal | BacktestCalc },
): ValidatedOrderValues {
  if (intent.pair !== spec.pair) reject('INSTRUMENT_CONSTRAINT_VIOLATION', 'Order pair does not match instrument');
  if (!['MARKET', 'POST_ONLY_LIMIT', 'STOP_MARKET'].includes(intent.type) || !['BUY', 'SELL'].includes(intent.side)) {
    reject('ORDER_INVALID', 'Unsupported order type or side');
  }
  const quantity = new BacktestDecimal(intent.quantity);
  const quantityCalc = toBacktestCalcDecimal(quantity);
  if (quantityCalc.lessThanOrEqualTo(0) || !aligned(quantityCalc, spec.quantityIncrement) ||
      quantityCalc.lessThan(toBacktestCalcDecimal(spec.minQuantity)) ||
      quantityCalc.lessThan(toBacktestCalcDecimal(spec.minTradeSize))) {
    reject('INSTRUMENT_CONSTRAINT_VIOLATION', 'Order quantity violates discovered instrument constraints');
  }
  const limitPrice = intent.limitPrice === undefined ? null : new BacktestDecimal(intent.limitPrice);
  const stopPrice = intent.stopPrice === undefined ? null : new BacktestDecimal(intent.stopPrice);
  if ((intent.type === 'POST_ONLY_LIMIT') !== (limitPrice !== null) || (intent.type === 'STOP_MARKET') !== (stopPrice !== null) ||
      (intent.type === 'MARKET' && (limitPrice !== null || stopPrice !== null))) {
    reject('ORDER_INVALID', 'Order price fields do not match order type');
  }
  for (const price of [limitPrice, stopPrice]) {
    if (price !== null) {
      const priceCalc = toBacktestCalcDecimal(price);
      if (priceCalc.lessThanOrEqualTo(0) || !aligned(priceCalc, spec.priceIncrement)) {
        reject('INSTRUMENT_CONSTRAINT_VIOLATION', 'Order price violates discovered tick size');
      }
    }
  }
  if (intent.type === 'POST_ONLY_LIMIT' && limitPrice !== null) {
    const conservativeNotional = quantityCalc.times(toBacktestCalcDecimal(limitPrice)).times(toBacktestCalcDecimal(spec.contractMultiplier));
    if (conservativeNotional.lessThan(toBacktestCalcDecimal(spec.minNotional))) {
      reject('INSTRUMENT_CONSTRAINT_VIOLATION', 'Post-only order is below minimum notional at its limit price');
    }
  }
  const reduceOnly = intent.reduceOnly ?? false;
  if (typeof reduceOnly !== 'boolean') reject('ORDER_INVALID', 'reduceOnly must be boolean');
  if (reduceOnly) {
    const increases = (position.side === 'LONG' && intent.side === 'BUY') || (position.side === 'SHORT' && intent.side === 'SELL');
    if (position.side === 'FLAT' || increases || quantityCalc.greaterThan(toBacktestCalcDecimal(position.quantity))) {
      reject('ORDER_INVALID', 'Reduce-only order cannot increase, reverse, or exceed the current position');
    }
  }
  const ocoGroupId = intent.ocoGroupId ?? null;
  if (ocoGroupId !== null && (!/^[A-Za-z0-9_.:@/-]{1,256}$/.test(ocoGroupId) || !reduceOnly)) {
    reject('ORDER_INVALID', 'OCO group IDs are restricted to reduce-only orders');
  }
  return deepFreeze({ pair: intent.pair, type: intent.type, side: intent.side, quantity, limitPrice, stopPrice, reduceOnly, ocoGroupId });
}

export function validateFillNotional(quantity: BacktestCalc, price: BacktestCalc, spec: BacktestInstrumentSpec): void {
  const notional = quantity.abs().times(price).times(toBacktestCalcDecimal(spec.contractMultiplier));
  if (notional.lessThan(toBacktestCalcDecimal(spec.minNotional))) {
    throw new BacktestError('INSTRUMENT_CONSTRAINT_VIOLATION', 'Executed notional is below the discovered minimum');
  }
}
