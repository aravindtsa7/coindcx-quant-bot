import https from 'node:https';
import { parse as parseLosslessJson } from 'lossless-json';
import type { Decimal } from '../../core/decimal/decimal';
import {
  CoinDcxProviderError,
  CoinDcxResponseValidationError,
  CoinDcxTimeoutError,
  ValidationError,
} from '../../core/errors/app-error';
import { sha256CanonicalJson } from '../../backtest/canonical-json';
import { mapInstrumentToMetadata } from '../../coin-runtime/instrument-mapper';
import type { InrFuturesInstrument } from './models';
import { normalizeInstrument } from './normalizers';
import { InstrumentDetailsResponseSchema } from './schemas';

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
async function privilegedAcquireProductionInstrument(pair: string): Promise<InrFuturesInstrument> {
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
  return normalizeInstrument(parsed.data.instrument);
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
function issueBinding(requestedPair: string, instrument: InrFuturesInstrument): TrustedProductionInstrumentBinding {
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
 * pair. It invokes the module-private native CoinDCX acquisition primitive;
 * no client, transport, reader, callback, metadata, brand, token, or factory
 * flag is injectable. A fresh network read is performed on every call (there
 * is no existing instrument TTL/cache to reinterpret in this wave).
 */
export async function acquireProductionInstrumentBinding(pair: string): Promise<TrustedProductionInstrumentBinding> {
  const instrument = await privilegedAcquireProductionInstrument(pair);
  return issueBinding(pair, instrument);
}
