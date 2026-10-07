import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { parse as parseLosslessJson } from 'lossless-json';
import { Decimal } from '../core/decimal/decimal';
import { Clock, SystemClock } from '../core/time/clock';
import { toLosslessDecimal, toSafeIntegerTimestamp } from '../integration/coindcx/normalizers';
import { WireNumericSchema } from '../integration/coindcx/schemas';
import { CanonicalDecimal } from './canonical-decimal';
import { MIN_CANONICAL_OPEN_TIME_MS } from './models';
import { CanonicalRecoveryError } from './errors';
import { boundProductionTransportBudget, readBudgetRefusal, type ReadPermit, type TransportReadBudget } from '../integration/coindcx/rate-limit/runtime/read-budget';

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
  /**
   * M2 W5: the shared REST read budget paying for every request of the default HTTP transport. Absent: the set-once
   * production read binding (scope PUBLIC), which refuses while unbound. There is no unpaced fallback. An injected
   * `httpTransport` replaces the default transport entirely (a test seam; no src caller supplies one).
   */
  readonly readBudget?: TransportReadBudget | undefined;
}

const RawRestCandleItemSchema = z.object({
  open: WireNumericSchema,
  high: WireNumericSchema,
  low: WireNumericSchema,
  close: WireNumericSchema,
  volume: WireNumericSchema,
  quote_volume: WireNumericSchema.nullable().optional(),
  time: WireNumericSchema,
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
    const readBudget = config.readBudget ?? boundProductionTransportBudget('PUBLIC');
    this.#httpTransport = config.httpTransport ?? ((url, timeoutMs) => defaultHttpTransport(url, timeoutMs, readBudget));
  }

  public async fetchClosedCandles(query: FetchCandlesQuery): Promise<readonly RestCandleRecord[]> {
    const started = performance.now();
    const assertDeadline = () => {
      if (performance.now() - started >= this.#timeoutMs) throw new CanonicalRecoveryError('REST candle operation deadline exceeded');
    };
    const { pair, fromMs, toMs } = query;

    if (!pair || pair.trim() === '') {
      throw new CanonicalRecoveryError('Pair is required for REST candle recovery');
    }

    if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs > toMs) {
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
      assertDeadline();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'HTTP request failed';
      throw new CanonicalRecoveryError(`Futures candlestick recovery request failed: ${msg}`);
    }

    let parsedJson: unknown;
    try {
      parsedJson = parseLosslessJson(rawBody);
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
      const timestamp = toSafeIntegerTimestamp(item.time, 'time');
      const timeMs = timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;

      if (!Number.isSafeInteger(timeMs) || timeMs < MIN_CANONICAL_OPEN_TIME_MS || timeMs % 60_000 !== 0) {
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

      const exact = (value: unknown, field: string): Decimal => {
        const decimal = toLosslessDecimal(value, field);
        // Bound the exponent before any fixed-point expansion allocates a large string.
        if (decimal.decimalPlaces() > 18 || decimal.abs().greaterThanOrEqualTo('1000000000000000000')) {
          throw new CanonicalRecoveryError(`REST financial field ${field} exceeds canonical decimal bounds`);
        }
        return CanonicalDecimal.from(decimal).toDecimal();
      };
      const open = exact(item.open, 'open');
      const high = exact(item.high, 'high');
      const low = exact(item.low, 'low');
      const close = exact(item.close, 'close');
      const volume = exact(item.volume, 'volume');
      const quoteVolume = item.quote_volume == null ? null : exact(item.quote_volume, 'quote_volume');

      // Price and volume non-negativity
      if (open.isNegative() || high.isNegative() || low.isNegative() || close.isNegative() || volume.isNegative() || quoteVolume?.isNegative()) {
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
        quoteVolume,
      };

      const existing = dedupeMap.get(timeMs);
      if (existing) {
        // Deduplication: check if identical
        const isIdentical =
          existing.open.equals(record.open) &&
          existing.high.equals(record.high) &&
          existing.low.equals(record.low) &&
          existing.close.equals(record.close) &&
          existing.volume.equals(record.volume) &&
          (existing.quoteVolume === null || record.quoteVolume === null || existing.quoteVolume.equals(record.quoteVolume));

        if (!isIdentical) {
          throw new CanonicalRecoveryError(
            `REST response contains conflicting duplicate records for minute ${timeMs}`
          );
        }
        if (existing.quoteVolume === null && record.quoteVolume !== null) dedupeMap.set(timeMs, record);
        // Identical duplicate: no-op
      } else {
        dedupeMap.set(timeMs, record);
      }
    }

    // Sort ascending by openTimeMs
    const sorted = Array.from(dedupeMap.values()).sort((a, b) => a.openTimeMs - b.openTimeMs);
    // Parsing and normalization are synchronous: check elapsed time before successful settlement.
    assertDeadline();
    return Object.freeze(sorted);
  }
}

/** M2 W5: one fresh read permit per candle request, or a refusal before any HTTP (missing, unavailable, refusing). */
async function acquireReadPermit(budget: TransportReadBudget, lifetimeMs: number): Promise<ReadPermit> {
  let acquired;
  try {
    acquired = await budget.budget.acquire({ scope: budget.scope, lifetimeMs: Math.max(1, lifetimeMs) });
  } catch {
    throw new Error(readBudgetRefusal('READ_BUDGET_ERROR').message);
  }
  if (acquired.kind !== 'GRANTED') throw new Error(readBudgetRefusal(acquired.reason).message);
  return acquired.permit;
}

async function defaultHttpTransport(urlString: string, timeoutMs: number, readBudget: TransportReadBudget): Promise<string> {
  const started = performance.now();
  // M2 W5: admission before request preparation. The wait counts against this request's timeout.
  const permit = await acquireReadPermit(readBudget, timeoutMs);
  let parsedUrl: URL;
  try {
    if (performance.now() - started >= timeoutMs) throw new Error(`Request timed out after ${timeoutMs}ms`);
    parsedUrl = new URL(urlString);
  } catch (error) {
    permit.release(); // preparation failed before any request creation: irrevocable known non-use
    throw error;
  }
  const isHttps = parsedUrl.protocol === 'https:';
  const transportModule = isHttps ? https : http;

  return new Promise<string>((resolveWire, rejectWire) => {
    let settled = false;
    let response: http.IncomingMessage | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const clearDeadline = () => { clearTimeout(deadline); deadline = undefined; };
    const timeoutError = () => new Error(`Request timed out after ${timeoutMs}ms`);
    const reject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      rejectWire(error);
      response?.destroy();
      req.destroy();
    };
    const resolve = (body: string) => {
      if (settled) return;
      if (performance.now() - started >= timeoutMs) { reject(timeoutError()); return; }
      settled = true;
      clearDeadline();
      resolveWire(body);
    };
    // The request is created inside the permit's synchronous start, which reports STARTED at creation (also on throw).
    const creation = permit.start(() => transportModule.request(
      parsedUrl,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'CoinDCX-Quant-Bot/0.1.0',
        },
      },
      (res) => {
        response = res;
        const statusCode = res.statusCode ?? 0;
        if (statusCode === 429) {
          // Shared throttle observation (raw headers); the caller-facing error below is unchanged.
          try {
            const retryAfter = res.headers['retry-after'], serverDate = res.headers.date;
            permit.throttled({ ...(typeof retryAfter === 'string' ? { retryAfter } : {}), ...(typeof serverDate === 'string' ? { serverDate } : {}) });
          } catch { /* budget reporting only */ }
        }
        if (settled) { res.destroy(); return; }
        let responseData = '';
        let totalBytes = 0;

        res.setEncoding('utf8');

        res.on('data', (chunk: string) => {
          if (settled) return;
          totalBytes += Buffer.byteLength(chunk, 'utf8');
          if (totalBytes > DEFAULT_MAX_RESPONSE_BYTES) {
            reject(new Error(`Response exceeded maximum size of ${DEFAULT_MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          responseData += chunk;
        });

        res.on('end', () => {
          if (settled) return;
          if (!res.complete) { reject(new Error('REST response ended before complete body')); return; }
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`HTTP status ${statusCode}`));
            return;
          }
          resolve(responseData);
        });
        res.on('error', reject);
        res.once('aborted', () => reject(new Error('REST response aborted before completion')));
        res.once('close', () => {
          if (!settled) reject(new Error('REST response closed before completion'));
          res.removeAllListeners('data');
          res.removeAllListeners('end');
          res.removeAllListeners('error');
          res.removeAllListeners('aborted');
        });
      }
    ));
    if (creation.kind !== 'STARTED') {
      // The start check voided the permit (NOT_STARTED reported): no request was created.
      settled = true;
      rejectWire(new Error(readBudgetRefusal(`PERMIT_${creation.reason}`).message));
      return;
    }
    const req = creation.value;
    req.once('close', () => permit.complete()); // positive local completion/teardown evidence

    deadline = setTimeout(() => reject(timeoutError()), Math.max(0, timeoutMs - (performance.now() - started)));

    req.on('error', (err) => {
      reject(err);
    });
    req.once('close', () => {
      if (!response && !settled) reject(new Error('REST request closed before response'));
      req.removeAllListeners('error');
    });

    req.end();
  });
}
