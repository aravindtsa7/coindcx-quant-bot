import { CoinDcxClient } from '../src/integration/coindcx/client';
import { SystemClock } from '../src/integration/coindcx/clock';
import { CoinDcxTransport } from '../src/integration/coindcx/transport';
import { readBotSettlementConversion } from '../src/integration/coindcx/live/practical-bot-evaluation';
import { CoinDcxFuturesCandleRestReader, type HistoricalCandleQuery } from '../src/market-data/rest-candle-reader';
import { startBotReadBudget } from './run-coindcx-bot';
import { observeReadBudget } from './practical-read-telemetry';

/** Account reads retain smoke pacing; public candles have a dedicated coordinator and permit budget. */
export async function startPracticalReadRuntime() {
  const limiter = await startBotReadBudget();
  let publicLimiter: Awaited<ReturnType<typeof startBotReadBudget>> | undefined;
  const close = async () => {
    const results = await Promise.allSettled([limiter.close(), publicLimiter?.close()]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  };
  try {
    publicLimiter = await startBotReadBudget('PUBLIC_MARKET_DATA');
    const clock = new SystemClock();
    const publicBudget = publicLimiter.publicReadBudget.budget;
    const telemetry = observeReadBudget({ acquire: request => (request.scope === 'PUBLIC' ? publicBudget : limiter.apiReadBudget.budget).acquire(request) }, () => clock.nowMs()), budget = telemetry.budget;
    const apiReadBudget = { budget, scope: 'API_AUTH' as const }, publicReadBudget = { budget, scope: 'PUBLIC' as const };
    const apiKey = process.env['COINDCX_API_KEY'], apiSecret = process.env['COINDCX_API_SECRET'];
    const reader = new CoinDcxFuturesCandleRestReader({ clock, readBudget: publicReadBudget, timeoutMs: 65_000 });
    const client = Object.assign(new CoinDcxClient({ clock, apiKey, apiSecret, readBudget: apiReadBudget, timeoutMs: 65_000 }), {
      getCandles: (query: HistoricalCandleQuery) => reader.getCandles(query),
    });
    const conversion = new CoinDcxTransport({ readBudget: apiReadBudget, allowedReadEndpoints: ['FUTURES_CONVERSIONS'], timeoutMs: 65_000 });
    let http: { lastHttpStatus: number | null; observedAtMs: number | null; source: string } = { lastHttpStatus: null, observedAtMs: null, source: 'FUTURES_CONVERSIONS · no response recorded' };
    return { client, clock, apiKey, apiSecret, close,
      stats: () => {
        const account = limiter.readStats(), market = publicLimiter!.readStats();
        return { ...telemetry.stats(), ...account, connected: account.connected && market.connected, unknown: account.unknown || market.unknown,
          admission: account.admission === 'STOPPED' || market.admission === 'STOPPED' ? 'STOPPED' : account.admission,
          blockedScopes: [...account.blockedScopes.filter(s => s === 'API_AUTH'), ...market.blockedScopes.filter(s => s === 'PUBLIC')], outboxSize: account.outboxSize + market.outboxSize,
          pacing: { startsPerSecond: 1, startsPerMinute: 20, concurrency: 2, publicMarketData: { startsPerSecond: 8, startsPerMinute: 480, concurrency: 1 } },
          note: 'Separate account/public local pacing policies; external shared-IP consumers are unknown.' };
      },
      connectionSnapshot: () => ({ ...http }),
      readSettlementConversion: async () => {
        try { const response = await conversion.executeRead<unknown>({ endpoint: 'FUTURES_CONVERSIONS' });
          http = { lastHttpStatus: response.status, observedAtMs: clock.nowMs(), source: 'FUTURES_CONVERSIONS' };
          return readBotSettlementConversion(response.data, clock.nowMs());
        } catch (error) { const code = (error as { statusCode?: unknown } | null)?.statusCode;
          http = { lastHttpStatus: typeof code === 'number' && code >= 100 && code <= 599 ? code : null, observedAtMs: clock.nowMs(), source: 'FUTURES_CONVERSIONS' }; throw error; }
      },
    };
  } catch (error) { await close(); throw error; }
}
