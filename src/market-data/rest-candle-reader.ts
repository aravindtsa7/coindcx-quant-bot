import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { z } from 'zod';
import { Decimal } from '../core/decimal/decimal';
import { Clock, SystemClock } from '../integration/coindcx/clock';
import { parseFinancialDecimal } from '../integration/coindcx/websocket/schemas';
import { CanonicalRecoveryError } from './errors';

export const DEFAULT_PUBLIC_MARKET_DATA_URL = 'https://public.coindcx.com';
export const DEFAULT_REST_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB

export interface RestCandleRecord {
  readonly pair: string;
  readonly openTimeMs: number;
  readonly open: Decimal;
  readonly high: Decimal;
  readonly low: Decimal;
  readonly close: Decimal;
  readonly volume: Decimal;
  readonly quoteVolume: Decimal | null;
}

export interface FetchCandlesQuery {
  readonly pair: string;
  readonly fromMs: number;
  readonly toMs: number;
}

export interface FuturesCandleRestReaderConfig {
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly clock?: Clock | undefined;
  readonly httpTransport?: ((url: string, timeoutMs: number) => Promise<string>) | undefined;
}

const RawRestCandleItemSchema = z.object({
  open: z.union([z.string(), z.number()]),
  high: z.union([z.string(), z.number()]),
  low: z.union([z.string(), z.number()]),
  close: z.union([z.string(), z.number()]),
  volume: z.union([z.string(), z.number()]),
  time: z.number(),
});

const RawRestCandlesResponseSchema = z.object({
  s: z.string(),
  data: z.array(RawRestCandleItemSchema),
});

/**
 * Fixed, read-only CoinDCX Futures candlestick REST reader.
 * Invariants:
 * - Query format: GET /market_data/candlesticks?pair=<pair>&from=<sec>&to=<sec>&resolution=1&pcode=f
 * - Strictly read-only; no mutations.
 * - Sorts records ascending by openTimeMs.
 * - Deduplicates identical records; rejects conflicting duplicates for the same minute.
 * - Enforces structural OHLC validation and exact UTC minute alignment.
 * - Filters strictly to the requested [fromMs, toMs] range.
 * - Rejects forming/current minute candles (only closed truth is accepted).
 * - Provider errors are sanitized and never reflected unsafely.
 */
export class CoinDcxFuturesCandleRestReader {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #clock: Clock;
  readonly #httpTransport: (url: string, timeoutMs: number) => Promise<string>;

  constructor(config: FuturesCandleRestReaderConfig = {}) {
    this.#baseUrl = (config.baseUrl ?? DEFAULT_PUBLIC_MARKET_DATA_URL).replace(/\/+$/, '');
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_REST_TIMEOUT_MS;
    this.#clock = config.clock ?? new SystemClock();
    this.#httpTransport = config.httpTransport ?? defaultHttpTransport;
  }

  public async fetchClosedCandles(query: FetchCandlesQuery): Promise<readonly RestCandleRecord[]> {
    const { pair, fromMs, toMs } = query;

    if (!pair || pair.trim() === '') {
      throw new CanonicalRecoveryError('Pair is required for REST candle recovery');
    }

    if (!Number.isInteger(fromMs) || !Number.isInteger(toMs) || fromMs > toMs) {
      throw new CanonicalRecoveryError(`Invalid time range: fromMs=${fromMs}, toMs=${toMs}`);
    }

    const fromSec = Math.floor(fromMs / 1000);
    const toSec = Math.floor(toMs / 1000);

    const endpointUrl = `${this.#baseUrl}/market_data/candlesticks?pair=${encodeURIComponent(
      pair
    )}&from=${fromSec}&to=${toSec}&resolution=1&pcode=f`;

    let rawBody: string;
    try {
      rawBody = await this.#httpTransport(endpointUrl, this.#timeoutMs);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'HTTP request failed';
      throw new CanonicalRecoveryError(`Futures candlestick recovery request failed: ${msg}`);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      throw new CanonicalRecoveryError('Failed to parse REST candlestick JSON response');
    }

    const parseResult = RawRestCandlesResponseSchema.safeParse(parsedJson);
    if (!parseResult.success) {
      throw new CanonicalRecoveryError('Invalid REST candlestick response schema');
    }

    const { s, data } = parseResult.data;
    if (s.toLowerCase() !== 'ok') {
      throw new CanonicalRecoveryError(`REST candlestick response status not ok: '${s}'`);
    }

    const nowMs = this.#clock.nowMs();
    const currentMinuteStartMs = Math.floor(nowMs / 60_000) * 60_000;

    const dedupeMap = new Map<number, RestCandleRecord>();

    for (const item of data) {
      // Normalize timestamp to ms
      const timeMs = item.time < 100_000_000_000 ? Math.floor(item.time * 1000) : Math.floor(item.time);

      if (timeMs % 60_000 !== 0) {
        throw new CanonicalRecoveryError(`REST candle time must align to exact UTC minute: ${timeMs}`);
      }

      // Rejects forming/current minute candles
      if (timeMs >= currentMinuteStartMs) {
        continue;
      }

      // Exact requested-range filtering
      if (timeMs < fromMs || timeMs > toMs) {
        continue;
      }

      const open = parseFinancialDecimal(item.open, 'open');
      const high = parseFinancialDecimal(item.high, 'high');
      const low = parseFinancialDecimal(item.low, 'low');
      const close = parseFinancialDecimal(item.close, 'close');
      const volume = parseFinancialDecimal(item.volume, 'volume');

      // Price and volume non-negativity
      if (open.isNegative() || high.isNegative() || low.isNegative() || close.isNegative() || volume.isNegative()) {
        throw new CanonicalRecoveryError(`Negative price or volume encountered at time ${timeMs}`);
      }

      // Structural OHLC consistency
      if (
        high.lessThan(low) ||
        high.lessThan(open) ||
        high.lessThan(close) ||
        low.greaterThan(open) ||
        low.greaterThan(close)
      ) {
        throw new CanonicalRecoveryError(`Structural OHLC violation at time ${timeMs}`);
      }

      const record: RestCandleRecord = {
        pair,
        openTimeMs: timeMs,
        open,
        high,
        low,
        close,
        volume,
        quoteVolume: null, // Public REST candlesticks endpoint does not provide quote_volume
      };

      const existing = dedupeMap.get(timeMs);
      if (existing) {
        // Deduplication: check if identical
        const isIdentical =
          existing.open.equals(record.open) &&
          existing.high.equals(record.high) &&
          existing.low.equals(record.low) &&
          existing.close.equals(record.close) &&
          existing.volume.equals(record.volume);

        if (!isIdentical) {
          throw new CanonicalRecoveryError(
            `REST response contains conflicting duplicate records for minute ${timeMs}`
          );
        }
        // Identical duplicate: no-op
      } else {
        dedupeMap.set(timeMs, record);
      }
    }

    // Sort ascending by openTimeMs
    const sorted = Array.from(dedupeMap.values()).sort((a, b) => a.openTimeMs - b.openTimeMs);
    return Object.freeze(sorted);
  }
}

async function defaultHttpTransport(urlString: string, timeoutMs: number): Promise<string> {
  const parsedUrl = new URL(urlString);
  const isHttps = parsedUrl.protocol === 'https:';
  const transportModule = isHttps ? https : http;

  return new Promise<string>((resolve, reject) => {
    const req = transportModule.request(
      parsedUrl,
      {
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'CoinDCX-Quant-Bot/0.1.0',
        },
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        let responseData = '';
        let totalBytes = 0;

        res.setEncoding('utf8');

        res.on('data', (chunk: string) => {
          totalBytes += Buffer.byteLength(chunk, 'utf8');
          if (totalBytes > DEFAULT_MAX_RESPONSE_BYTES) {
            req.destroy();
            reject(new Error(`Response exceeded maximum size of ${DEFAULT_MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          responseData += chunk;
        });

        res.on('end', () => {
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`HTTP status ${statusCode}`));
            return;
          }
          resolve(responseData);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}
