import type { Decimal } from '../../core/decimal/decimal';
import { CoinDcxResponseValidationError } from '../../core/errors/app-error';
import { sha256CanonicalJson } from '../../backtest/canonical-json';
import { mapInstrumentToMetadata } from '../../coin-runtime/instrument-mapper';
import { readInrFuturesInstrument } from './instrument-reader';
import { CoinDcxTransport } from './transport';

export const COINDCX_INR_FUTURES_INSTRUMENT_SOURCE_ID = 'COINDCX_INR_FUTURES_INSTRUMENT_REST_V1' as const;
export const PRODUCTION_INSTRUMENT_SPEC_IDENTITY_POLICY_ID = 'P14_PRODUCTION_INSTRUMENT_SPEC_IDENTITY_V1' as const;

export interface TrustedProductionInstrumentBindingRecord {
  readonly sourceId: typeof COINDCX_INR_FUTURES_INSTRUMENT_SOURCE_ID;
  readonly instrumentSpecIdentityPolicyId: typeof PRODUCTION_INSTRUMENT_SPEC_IDENTITY_POLICY_ID;
  readonly instrumentSpecSnapshotId: string;
  readonly pair: string;
  readonly contractMultiplier: string;
  readonly priceIncrement: string;
  readonly quantityIncrement: string;
  readonly underlying: string;
  readonly quoteCurrency: string;
  readonly marginCurrency: 'INR';
}

const INSTRUMENT_BINDING_ISSUER = Symbol('CoinDCX production instrument binding issuer');

/** Opaque provenance capability. Shape, prototype, subclassing, or a caller-created Symbol cannot issue one. */
export class TrustedProductionInstrumentBinding {
  readonly #record: TrustedProductionInstrumentBindingRecord;

  public constructor(issuer: symbol, record: TrustedProductionInstrumentBindingRecord) {
    if (issuer !== INSTRUMENT_BINDING_ISSUER) throw new Error('Only approved CoinDCX production acquisition may issue an instrument binding');
    this.#record = Object.freeze({ ...record });
    Object.freeze(this);
  }

  public static read(value: unknown): TrustedProductionInstrumentBindingRecord | null {
    return value !== null && typeof value === 'object' && #record in value ? value.#record : null;
  }
}
Object.freeze(TrustedProductionInstrumentBinding.prototype);
Object.freeze(TrustedProductionInstrumentBinding);

function exactDecimal(value: Decimal): string {
  return value.toFixed();
}

function positiveExactDecimal(value: Decimal, field: string): string {
  if (!value.isFinite() || value.isNaN() || !value.greaterThan(0)) {
    throw new CoinDcxResponseValidationError(`Acquired instrument ${field} must be a strictly positive finite Decimal`);
  }
  return exactDecimal(value);
}

function requiredSourceString(value: string, field: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new CoinDcxResponseValidationError(`Acquired instrument ${field} must be a non-empty exact string`);
  }
  return value;
}

/**
 * The identity binds static product/currency identity, lifecycle economics,
 * and the static order constraints consumed by risk/execution. Mutable market
 * state (status/exit-only), fees, leverage tiers, and funding are intentionally
 * outside this namespace and remain governed by their existing policies.
 */
function issueBinding(requestedPair: string, instrument: Awaited<ReturnType<typeof readInrFuturesInstrument>>): TrustedProductionInstrumentBinding {
  if (instrument.pair !== requestedPair) {
    throw new CoinDcxResponseValidationError('Acquired instrument pair does not match requested pair', { pair: requestedPair });
  }
  if (instrument.kind.toLowerCase() !== 'perpetual') {
    throw new CoinDcxResponseValidationError(`Acquired instrument '${requestedPair}' is not a perpetual Futures product`, { pair: requestedPair });
  }

  const metadata = mapInstrumentToMetadata(instrument, instrument.underlyingCurrency);
  const contractMultiplier = positiveExactDecimal(metadata.unitContractValue, 'contractMultiplier');
  const priceIncrement = positiveExactDecimal(metadata.priceIncrement, 'priceIncrement');
  const quantityIncrement = positiveExactDecimal(metadata.quantityIncrement, 'quantityIncrement');
  const underlying = requiredSourceString(metadata.underlying, 'underlying').toUpperCase();
  const quoteCurrency = requiredSourceString(metadata.quoteCurrency, 'quoteCurrency').toUpperCase();
  const settleCurrency = requiredSourceString(metadata.settleCurrency, 'settleCurrency').toUpperCase();
  const positionCurrency = requiredSourceString(metadata.positionCurrency, 'positionCurrency').toUpperCase();
  const productKind = requiredSourceString(metadata.kind, 'kind').toLowerCase();
  const settlement = metadata.settlement === null ? null : requiredSourceString(metadata.settlement, 'settlement');

  const identityPreimage = Object.freeze({
    identityPolicyId: PRODUCTION_INSTRUMENT_SPEC_IDENTITY_POLICY_ID,
    sourceId: COINDCX_INR_FUTURES_INSTRUMENT_SOURCE_ID,
    pair: metadata.pair,
    productKind,
    settlement,
    underlying,
    quoteCurrency,
    marginCurrency: metadata.marginCurrency,
    settleCurrency,
    positionCurrency,
    contractMultiplier,
    priceIncrement,
    quantityIncrement,
    minTradeSize: exactDecimal(metadata.minTradeSize),
    minPrice: exactDecimal(metadata.minPrice),
    maxPrice: exactDecimal(metadata.maxPrice),
    minQuantity: exactDecimal(metadata.minQuantity),
    maxQuantity: exactDecimal(metadata.maxQuantity),
    minNotional: exactDecimal(metadata.minNotional),
    maxMarketOrderQuantity: metadata.maxMarketOrderQuantity === null ? null : exactDecimal(metadata.maxMarketOrderQuantity),
  });

  return new TrustedProductionInstrumentBinding(INSTRUMENT_BINDING_ISSUER, {
    sourceId: COINDCX_INR_FUTURES_INSTRUMENT_SOURCE_ID,
    instrumentSpecIdentityPolicyId: PRODUCTION_INSTRUMENT_SPEC_IDENTITY_POLICY_ID,
    instrumentSpecSnapshotId: sha256CanonicalJson(identityPreimage),
    pair: metadata.pair,
    contractMultiplier,
    priceIncrement,
    quantityIncrement,
    underlying,
    quoteCurrency,
    marginCurrency: metadata.marginCurrency,
  });
}

/**
 * The sole production mint. Its only caller-controlled value is the canonical
 * pair. It constructs the approved default CoinDCX transport internally; no
 * client, transport, callback, metadata, brand, or factory flag is injectable.
 * The underlying reader performs a fresh network read on every call (there is
 * no existing instrument TTL/cache to reinterpret in this wave).
 */
export async function acquireProductionInstrumentBinding(pair: string): Promise<TrustedProductionInstrumentBinding> {
  const instrument = await readInrFuturesInstrument(new CoinDcxTransport(), pair);
  return issueBinding(pair, instrument);
}
