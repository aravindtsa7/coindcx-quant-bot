import https from 'node:https';
import { isLosslessNumber, LosslessNumber, parse as parseLosslessJson } from 'lossless-json';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { createHash } from 'node:crypto';

import {
  CoinDcxProviderError,
  CoinDcxResponseValidationError,
  CoinDcxTimeoutError,
  ValidationError,
} from '../../core/errors/app-error';




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

const WireNumericSchema = z.union([z.string(), z.number(), z.custom<LosslessNumber>(isLosslessNumber)]);
const InstrumentWireSchema = z
  .object({
    pair: z.string().regex(/^B-[A-Z0-9]+_[A-Z0-9]+$/),
    status: z.string(),
    kind: z.string(),
    settlement: z.string().optional().nullable(),
    settle_currency_short_name: z.string(),
    quote_currency_short_name: z.string(),
    position_currency_short_name: z.string(),
    underlying_currency_short_name: z.string(),
    margin_currency_short_name: z.string(),
    max_leverage_long: WireNumericSchema.optional().nullable(),
    max_leverage_short: WireNumericSchema.optional().nullable(),
    unit_contract_value: WireNumericSchema,
    price_increment: WireNumericSchema,
    quantity_increment: WireNumericSchema,
    min_trade_size: WireNumericSchema,
    min_price: WireNumericSchema,
    max_price: WireNumericSchema,
    min_quantity: WireNumericSchema,
    max_quantity: WireNumericSchema,
    min_notional: WireNumericSchema,
    max_notional: WireNumericSchema.optional().nullable(),
    max_market_order_quantity: WireNumericSchema.optional().nullable(),
    maker_fee: WireNumericSchema,
    taker_fee: WireNumericSchema,
    safety_percentage: WireNumericSchema.optional().nullable(),
    funding_frequency: z.union([z.number(), z.custom<LosslessNumber>(isLosslessNumber)]).optional().nullable(),
    expiry_time: z.union([z.number(), z.custom<LosslessNumber>(isLosslessNumber)]).optional().nullable(),
    exit_only: z.boolean().optional().nullable(),
    time_in_force_options: z.array(z.string()).optional().default([]),
    order_types: z.array(z.string()).optional().default([]),
    dynamic_position_leverage_details: z.record(z.unknown()).optional().nullable(),
    dynamic_safety_margin_details: z.record(z.unknown()).optional().nullable(),
  })
  .passthrough();
type InstrumentWire = z.infer<typeof InstrumentWireSchema>;

const InstrumentDetailsResponseSchema = z.object({
  instrument: InstrumentWireSchema,
});

// Canonical JSON for private, already-normalized plain-data preimages. Kept
// byte-compatible with the repository identity policy; no exported hasher dispatch.
function privateCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(privateCanonicalJson).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + privateCanonicalJson(record[key])).join(',') + '}';
  }
  throw new Error('Invalid private canonical identity preimage');
}
function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256').update(privateCanonicalJson(value), 'utf8').digest('hex');
}

// Canonical authority pipeline is deliberately lexical. Public schemas,
// normalizers, mappers, Decimal configuration and hashers cannot replace it.
const AuthorityDecimal = Decimal.clone({ precision: 128, rounding: Decimal.ROUND_HALF_UP });
function canonicalNumeric(value: unknown, field: string): Decimal {
  const raw = isLosslessNumber(value) ? value.value : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  try {
    if (raw.trim() === '') throw new Error('missing numeric value');
    const decimal = new AuthorityDecimal(raw.trim());
    if (!decimal.isFinite()) throw new Error('non-finite numeric value');
    return decimal;
  } catch { throw new CoinDcxResponseValidationError('Invalid acquired instrument numeric field: ' + field); }
}
function canonicalInstrumentMetadata(wire: InstrumentWire) {
  if (wire.margin_currency_short_name.toUpperCase() !== 'INR') throw new CoinDcxResponseValidationError("Instrument margin currency must be 'INR'");
  // Validate all numeric fields consumed by the established normalizer, even
  // those outside the static economics identity (fees/tiers remain separate).
  for (const field of ['unit_contract_value', 'price_increment', 'quantity_increment', 'min_trade_size', 'min_price', 'max_price', 'min_quantity', 'max_quantity', 'min_notional', 'maker_fee', 'taker_fee']) canonicalNumeric(wire[field], field);
  for (const field of ['max_notional', 'max_market_order_quantity', 'safety_percentage', 'max_leverage_long', 'max_leverage_short']) if (wire[field] != null) canonicalNumeric(wire[field], field);
  for (const field of ['funding_frequency', 'expiry_time']) {
    if (wire[field] != null) {
      const n = canonicalNumeric(wire[field], field);
      if (!n.isInteger() || !n.abs().lessThanOrEqualTo(Number.MAX_SAFE_INTEGER)) throw new CoinDcxResponseValidationError('Invalid instrument integer: ' + field);
    }
  }
  for (const details of [wire.dynamic_position_leverage_details, wire.dynamic_safety_margin_details]) {
    for (const [key, value] of Object.entries(details ?? {})) if (value != null) { canonicalNumeric(key, 'tier key'); canonicalNumeric(value, 'tier value'); }
  }
  return Object.freeze({
    pair: wire.pair, kind: wire.kind, underlying: wire.underlying_currency_short_name.toUpperCase(),
    quoteCurrency: wire.quote_currency_short_name, settleCurrency: wire.settle_currency_short_name,
    positionCurrency: wire.position_currency_short_name, marginCurrency: 'INR' as const, settlement: wire.settlement ?? null,
    unitContractValue: canonicalNumeric(wire.unit_contract_value, 'unit_contract_value'),
    priceIncrement: canonicalNumeric(wire.price_increment, 'price_increment'), quantityIncrement: canonicalNumeric(wire.quantity_increment, 'quantity_increment'),
    minTradeSize: canonicalNumeric(wire.min_trade_size, 'min_trade_size'), minPrice: canonicalNumeric(wire.min_price, 'min_price'),
    maxPrice: canonicalNumeric(wire.max_price, 'max_price'), minQuantity: canonicalNumeric(wire.min_quantity, 'min_quantity'),
    maxQuantity: canonicalNumeric(wire.max_quantity, 'max_quantity'), minNotional: canonicalNumeric(wire.min_notional, 'min_notional'),
    maxMarketOrderQuantity: wire.max_market_order_quantity == null ? null : canonicalNumeric(wire.max_market_order_quantity, 'max_market_order_quantity'),
  });
}

const INSTRUMENT_BINDING_ISSUER = Symbol('CoinDCX production instrument binding issuer');

/* -------------------------------------------------------------------------
 * [F14-03] PRIVILEGED PRODUCTION INSTRUMENT ACQUISITION.
 *
 * Production trust includes the integrity of the acquisition implementation,
 * not merely the identity of the issuer. These bindings are deliberately
 * module-private and the production mint closes over them directly. In
 * particular, this path never constructs an exported CoinDcxTransport and
 * never dispatches through CoinDcxTransport.prototype.executeRead or through
 * the public injectable instrument reader.
 *
 * Tests intercept Node's HTTPS primitive below this repository boundary. Node
 * builtin/package replacement and arbitrary process compromise remain outside
 * the repository-level mutable-prototype threat model.
 * ---------------------------------------------------------------------- */

/** Kept byte-identical to transport.ts's private INSTRUMENT endpoint definition. */
const PRODUCTION_INSTRUMENT_BASE_URL = 'https://api.coindcx.com';
const PRODUCTION_INSTRUMENT_PATH = '/exchange/v1/derivatives/futures/data/instrument';
const PRODUCTION_INSTRUMENT_REQUEST_TIMEOUT_MS = 10_000;
const PRODUCTION_INSTRUMENT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function canonicalProductionPair(pair: string): string {
  if (typeof pair !== 'string' || !/^B-[A-Z0-9]+_[A-Z0-9]+$/.test(pair.trim())) {
    throw new ValidationError('Pair must use canonical uppercase B-<BASE>_<QUOTE> format');
  }
  return pair.trim();
}

/**
 * The sole privileged acquisition primitive. It accepts only the requested
 * pair, fixes the real public endpoint/base URL internally, performs a fresh
 * native HTTPS GET, then applies the same schema and normalization pipeline as
 * the reusable public reader. It has no runtime export or injectable callback.
 */
async function privilegedAcquireProductionInstrument(pair: string): Promise<InstrumentWire> {
  const requestedPair = canonicalProductionPair(pair);
  const url = new URL(PRODUCTION_INSTRUMENT_PATH, PRODUCTION_INSTRUMENT_BASE_URL);
  url.searchParams.set('pair', requestedPair);
  url.searchParams.set('margin_currency_short_name', 'INR');

  const data = await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let receivedBytes = 0;
    const chunks: Buffer[] = [];
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      action();
    };
    const request = https.request(url, { method: 'GET', headers: { Accept: 'application/json' } }, response => {
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        receivedBytes += chunk.length;
        if (receivedBytes > PRODUCTION_INSTRUMENT_MAX_RESPONSE_BYTES) {
          settle(() => reject(new CoinDcxProviderError(
            `CoinDCX response exceeded maximum size limit of ${PRODUCTION_INSTRUMENT_MAX_RESPONSE_BYTES} bytes`,
            502,
            { path: PRODUCTION_INSTRUMENT_PATH, receivedBytes, maxBytes: PRODUCTION_INSTRUMENT_MAX_RESPONSE_BYTES },
          )));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', (error: Error) => settle(() => reject(error)));
      response.on('end', () => settle(() => {
        const status = response.statusCode ?? 500;
        if (status < 200 || status >= 300) {
          reject(new CoinDcxProviderError(
            `CoinDCX production instrument acquisition failed with status ${status}`,
            status,
            { path: PRODUCTION_INSTRUMENT_PATH },
          ));
          return;
        }
        const rawBody = Buffer.concat(chunks).toString('utf8');
        if (rawBody.trim().length === 0) {
          resolve(null);
          return;
        }
        try {
          resolve(parseLosslessJson(rawBody));
        } catch {
          reject(new CoinDcxResponseValidationError(
            'CoinDCX response validation failed: invalid JSON received',
            { path: PRODUCTION_INSTRUMENT_PATH, statusCode: status },
          ));
        }
      }));
    });
    const deadline = setTimeout(() => settle(() => {
      reject(new CoinDcxTimeoutError(
        `CoinDCX request timed out after ${PRODUCTION_INSTRUMENT_REQUEST_TIMEOUT_MS}ms`,
        { path: PRODUCTION_INSTRUMENT_PATH, method: 'GET', timeoutMs: PRODUCTION_INSTRUMENT_REQUEST_TIMEOUT_MS },
      ));
      request.destroy();
    }), PRODUCTION_INSTRUMENT_REQUEST_TIMEOUT_MS);
    request.on('error', (error: Error) => settle(() => reject(error)));
    request.end();
  });

  const parsed = InstrumentDetailsResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new CoinDcxResponseValidationError(
      `Failed to parse instrument specifications for ${pair}: ${parsed.error.message}`,
      { issues: parsed.error.issues, pair: requestedPair },
    );
  }
  if (parsed.data.instrument.pair !== requestedPair) {
    throw new CoinDcxResponseValidationError(
      'Instrument response pair does not match requested pair',
      { pair: requestedPair },
    );
  }
  return parsed.data.instrument;
}

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
function issueBinding(requestedPair: string, instrument: InstrumentWire): TrustedProductionInstrumentBinding {
  if (instrument.pair !== requestedPair) {
    throw new CoinDcxResponseValidationError('Acquired instrument pair does not match requested pair', { pair: requestedPair });
  }
  if (instrument.kind.toLowerCase() !== 'perpetual') {
    throw new CoinDcxResponseValidationError(`Acquired instrument '${requestedPair}' is not a perpetual Futures product`, { pair: requestedPair });
  }

  const metadata = canonicalInstrumentMetadata(instrument);
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
 * pair. It invokes the module-private native CoinDCX acquisition primitive;
 * no client, transport, reader, callback, metadata, brand, token, or factory
 * flag is injectable. A fresh network read is performed on every call (there
 * is no existing instrument TTL/cache to reinterpret in this wave).
 */
export async function acquireProductionInstrumentBinding(pair: string): Promise<TrustedProductionInstrumentBinding> {
  const instrument = await privilegedAcquireProductionInstrument(pair);
  return issueBinding(pair, instrument);
}

// Pin CommonJS authority entry points to lexical implementations. This also
// prevents pre-import replacement through an already-loaded repo namespace.
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  if (Object.getOwnPropertyDescriptor(module.exports, 'TrustedProductionInstrumentBinding')?.configurable !== false) Object.defineProperty(module.exports, 'TrustedProductionInstrumentBinding', { get: () => TrustedProductionInstrumentBinding, configurable: false });
  if (Object.getOwnPropertyDescriptor(module.exports, 'acquireProductionInstrumentBinding')?.configurable !== false) Object.defineProperty(module.exports, 'acquireProductionInstrumentBinding', { get: () => acquireProductionInstrumentBinding, configurable: false });
  Object.freeze(module.exports);
}
