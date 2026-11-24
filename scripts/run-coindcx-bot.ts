import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { loadCoinProfiles } from '../src/app/config/coins';
import { CoinDcxClient } from '../src/integration/coindcx/client';
import { CoinDcxTransport } from '../src/integration/coindcx/transport';
import { SystemClock } from '../src/integration/coindcx/clock';
import { PracticalBotOrchestrator, type PracticalBotOptions, type PracticalBotCandleQuery, type PracticalBotExecutionPort } from '../src/integration/coindcx/live/practical-bot-orchestrator';
import { CoinDcxLiveFuturesOrderGateway } from '../src/integration/coindcx/live/order-gateway';
import { CoinDcxFuturesCandleRestReader } from '../src/market-data/rest-candle-reader';
import { RateLimitCoordinator } from '../src/integration/coindcx/rate-limit/runtime/coordinator';
import { RateLimitClient } from '../src/integration/coindcx/rate-limit/runtime/client';
import { validateClientConfig, validateCoordinatorConfig } from '../src/integration/coindcx/rate-limit/runtime/config';
import { createCoordinatorReadBudget, type TransportReadBudget } from '../src/integration/coindcx/rate-limit/runtime/read-budget';
import { initializeDisposableStateDirectory } from '../src/integration/coindcx/rate-limit/runtime/state-store';
import { createCoordinatorMutationBudget } from '../src/integration/coindcx/rate-limit/runtime/mutation-budget';
import { createLiveMutationBudgetPort, type LiveMutationBudgetPortImplementation } from '../src/integration/coindcx/live/mutation-budget-ports';
import { createBotRiskPolicy, readBotSettlementConversion } from '../src/integration/coindcx/live/practical-bot-evaluation';
import { evaluateRisk } from '../src/risk/engine';
import { Decimal } from '../src/core/decimal/decimal';
import { readBotShadowCapital } from './coindcx-bot-shadow-state';
import { createBotShadowRiskState } from '../src/integration/coindcx/live/practical-bot-shadow-risk';

export interface BotReadBudgetRuntime {
  readonly apiReadBudget: TransportReadBudget;
  readonly publicReadBudget: TransportReadBudget;
  readonly stateDirectory: string;
  readonly pipePath: string;
  readStats(): { readonly connected: boolean; readonly outboxSize: number; readonly admission: string; readonly blockedScopes: readonly string[]; readonly unknown: boolean };
  createLiveMutationPort(): LiveMutationBudgetPortImplementation;
  close(): Promise<void>;
}

/** Isolated run limiter. Read clients never acquire mutation permits. */
export async function startBotReadBudget(policy: 'SMOKE' | 'PUBLIC_MARKET_DATA' = 'SMOKE'): Promise<BotReadBudgetRuntime> {
  const localRoot = path.resolve(__dirname, '../.local');
  fs.mkdirSync(localRoot, { recursive: true });
  const runId = randomBytes(16).toString('hex');
  const stateDirectory = path.join(localRoot, `bot-rate-limit-state-${runId}`);
  const pipePath = `\\\\.\\pipe\\coindcx-bot-limiter-${runId}`;
  let ownsDirectory = false;
  let coordinator: RateLimitCoordinator | undefined;
  let limiterClient: RateLimitClient | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      try {
        // ReadPermit.complete queues an acknowledgement asynchronously. Allow it to reach durable state.
        const deadline = performance.now() + 5000;
        while (limiterClient && limiterClient.outboxSize > 0 && limiterClient.session !== null && performance.now() < deadline) {
          await delay(20);
        }
        if (limiterClient && limiterClient.outboxSize > 0) throw new Error('BOT_LIMITER_DRAIN_FAILED');
      } finally {
        limiterClient?.close();
        try { await coordinator?.close(); }
        finally {
          if (ownsDirectory) {
            // Recursive deletion is restricted to the exact directory exclusively created by this invocation.
            const resolved = fs.realpathSync(stateDirectory);
            if (path.dirname(resolved) !== fs.realpathSync(localRoot)
              || path.basename(resolved) !== `bot-rate-limit-state-${runId}` || fs.lstatSync(stateDirectory).isSymbolicLink()) {
              throw new Error('BOT_LIMITER_CLEANUP_PATH_REFUSED');
            }
            fs.rmSync(resolved, { recursive: true, force: true });
          }
        }
      }
    })();
    return closing;
  };
  try {
    // Public candles use a separate coordinator, below CoinDCX's documented general
    // 16/sec and 960/min ceiling (https://docs.coindcx.com/#frequently-asked-questions).
    // All existing bot/account callers retain the original smoke policy.
    const startsPerSecond = policy === 'PUBLIC_MARKET_DATA' ? 8 : 1, startsPerMinute = policy === 'PUBLIC_MARKET_DATA' ? 480 : 20;
    const config = validateCoordinatorConfig({
      // CLI smoke pacing choices, not a claim about the provider's rate limit. A 429 blocks the scope;
      // this isolated run installs no probe responder and never resets that block automatically.
      limiter: {
        windows: [{ windowMs: 1000, maxStarts: startsPerSecond }, { windowMs: 60_000, maxStarts: startsPerMinute }],
        fairnessWindowMs: 60_000,
        classShares: {
          P0: { minPerWindow: 0, maxPerWindow: startsPerMinute }, P1: { minPerWindow: 0, maxPerWindow: startsPerMinute },
          P2: { minPerWindow: 0, maxPerWindow: startsPerMinute }, P3: { minPerWindow: 0, maxPerWindow: startsPerMinute },
        },
        concurrency: 1, p0ReservedSlots: 0, grantTtlMs: 2000, maxRequestDeadlineMs: 65_000,
        overdueGuardMs: 1000, uncertainChargeAlertMs: 60_000,
        retryAfter: { noHeaderDefaultMs: 60_000, providerStatedBlockMs: 60_000, localBackoffBaseMs: 60_000,
          localBackoffMaxMs: 300_000, operationalCapMs: 900_000, clockUncertaintyMs: 2000 },
      },
      stateDirectory, pipePath, maxFrameBytes: 65_536, maxStateBytes: 1_048_576,
      tickMs: 20, handshakeTimeoutMs: 5000, maxSessions: 1, maxRegisteredClients: 1, maxPendingRequestsPerSession: 16,
    });
    const peer = validateClientConfig({ pipePath, maxFrameBytes: 65_536, connectTimeoutMs: 5000, probeScopes: [], maxOutbox: 256 });
    if (config.kind !== 'VALID' || peer.kind !== 'VALID') throw new Error('BOT_LIMITER_CONFIG_INVALID');
    fs.mkdirSync(stateDirectory); // Exclusive claim: never initialize, reuse, or remove an existing run directory.
    ownsDirectory = true;
    initializeDisposableStateDirectory(stateDirectory, pipePath, `i${runId}`, 'DISPOSABLE_TEST_DIRECTORY');
    const started = await RateLimitCoordinator.start(config.config);
    if (started.kind !== 'RUNNING') throw new Error('BOT_LIMITER_START_FAILED');
    coordinator = started.coordinator;
    limiterClient = new RateLimitClient(peer.config);
    if (!await limiterClient.connect()) throw new Error('BOT_LIMITER_CONNECT_FAILED');
    const budget = createCoordinatorReadBudget(limiterClient, { cls: 'P1', deadlineInMs: 65_000 });
    return { apiReadBudget: { budget, scope: 'API_AUTH' }, publicReadBudget: { budget, scope: 'PUBLIC' }, stateDirectory, pipePath, close,
      readStats: () => ({ connected: limiterClient?.session !== null && limiterClient?.session !== undefined, outboxSize: limiterClient?.outboxSize ?? 0,
        admission: limiterClient?.view.admission ?? 'UNKNOWN', blockedScopes: limiterClient?.view.blockedScopes ?? [], unknown: limiterClient?.view.unknown ?? true }),
      createLiveMutationPort: () => createLiveMutationBudgetPort(createCoordinatorMutationBudget(limiterClient!, { cls: 'P1', deadlineInMs: 65_000 })) };
  } catch (error) {
    await close();
    throw error;
  }
}

export function parseBotArguments(args: readonly string[], environment: Readonly<Record<string, string | undefined>> = process.env): Omit<PracticalBotOptions, 'profiles' | 'client'> {
  const { values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
    mode: { type: 'string', default: 'shadow' },
    strategy: { type: 'string', default: 'ema-trend' },
    'confirm-live': { type: 'boolean', default: false },
    coins: { type: 'string', default: 'BTC,ETH,SOL' },
    cycles: { type: 'string', default: '1' },
    'interval-ms': { type: 'string', default: '5000' },
    'max-inr': { type: 'string', default: '500' },
    'equity-inr': { type: 'string' },
  } });
  const modes = { 'dry-run': 'DRY_RUN', shadow: 'SHADOW', 'tiny-live': 'TINY_LIVE' } as const;
  if (!Object.hasOwn(modes, values.mode!)) throw new Error('INVALID_BOT_MODE');
  if (values.mode === 'tiny-live' && !values['confirm-live']) throw new Error('TINY_LIVE_REQUIRES_EXPLICIT_CONFIRM_FLAG');
  if (values.strategy !== 'ema-trend' && values.strategy !== 'rsi-momentum') throw new Error('INVALID_STRATEGY');
  const equity = values['equity-inr'] ?? environment['COINDCX_AUTHORITATIVE_EQUITY_INR'] ?? (values.mode === 'tiny-live' ? undefined : '5000');
  if (equity === undefined) throw new Error('TINY_LIVE_REQUIRES_EXPLICIT_EQUITY_INR');
  if (!/^\d+(?:\.\d+)?$/.test(equity) || !new Decimal(equity).isFinite() || !new Decimal(equity).gt(0)) throw new Error('INVALID_EQUITY_INR');
  const integer = (value: string, code: string): number => {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(code);
    return Number(value);
  };
  return {
    mode: modes[values.mode as keyof typeof modes], strategy: values.strategy, confirmLive: values['confirm-live'],
    coins: values.coins!.split(','), cycles: integer(values.cycles!, 'INVALID_CYCLES'),
    intervalMs: integer(values['interval-ms']!, 'INVALID_INTERVAL_MS'), maxInr: values['max-inr']!, equityInr: new Decimal(equity).toFixed(),
  };
}

async function main(): Promise<void> {
  const options = parseBotArguments(process.argv.slice(2));
  const controller = new AbortController();
  const stop = () => { controller.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let limiter: BotReadBudgetRuntime | undefined;
  try {
    const apiKey = process.env['COINDCX_API_KEY'];
    const apiSecret = process.env['COINDCX_API_SECRET'];
    // Use one epoch-millisecond clock for requests, evidence, stream observation and candles.
    // An HTTP 422 alone is not evidence of skew; do not change timestamp units or guess an offset.
    const clock = new SystemClock();
    limiter = await startBotReadBudget();
    // Candle recovery counts limiter admission against its operation deadline. Allow one full pacing window.
    const reader = new CoinDcxFuturesCandleRestReader({ clock, readBudget: limiter.publicReadBudget, timeoutMs: 65_000 });
    const conversionTransport = new CoinDcxTransport({ readBudget: limiter.apiReadBudget, allowedReadEndpoints: ['FUTURES_CONVERSIONS'] });
    // The existing reader implements the fixed resolution=1 provider contract.
    const client = Object.assign(new CoinDcxClient({ apiKey, apiSecret, clock, readBudget: limiter.apiReadBudget }), {
      getCandles: (query: PracticalBotCandleQuery) => reader.fetchClosedCandles({
        pair: query.pair, fromMs: query.from, toMs: query.to,
      }),
    });
    const orchestrator = new PracticalBotOrchestrator({
      ...options, profiles: loadCoinProfiles(), client, apiKey, apiSecret, clock, signal: controller.signal,
      readSettlementConversion: async () => {
        const response = await conversionTransport.executeRead<unknown>({ endpoint: 'FUTURES_CONVERSIONS' });
        return readBotSettlementConversion(response.data, clock.nowMs());
      },
      ...(options.mode === 'TINY_LIVE' ? {} : { readRiskState: async (request: Parameters<NonNullable<PracticalBotOptions['readRiskState']>>[0]) => {
        if (request.accountFingerprint === null) throw new Error('SHADOW_CAPITAL_INVALID');
        const capital = readBotShadowCapital(path.resolve(__dirname, '../.local'), request.accountFingerprint, options.equityInr!, clock.nowMs());
        return createBotShadowRiskState({ capital, instrument: request.instrument, instrumentObservedAtMs: request.instrumentObservedAtMs,
          evaluationTimeMs: clock.nowMs(), settlement: request.settlementRateSnapshot, positions: request.positions,
          allowOfflineFlat: options.mode === 'DRY_RUN' || !apiKey?.trim() || !apiSecret?.trim() });
      } }),
      createLiveExecutor: (): PracticalBotExecutionPort => {
        if (options.mode !== 'TINY_LIVE' || options.confirmLive !== true) throw new Error('TINY_LIVE_REQUIRES_EXPLICIT_CONFIRM_FLAG');
        if (!apiKey?.trim() || !apiSecret?.trim()) throw new Error('TINY_LIVE_REQUIRES_CREDENTIALS');
        const gateway = new CoinDcxLiveFuturesOrderGateway({ apiKey, apiSecret, clock, readBudget: limiter!.apiReadBudget });
        const mutationBudget = limiter!.createLiveMutationPort();
        return { execute: async request => {
          if (!request.isCurrent()) return { status: 'REFUSED', ordersSubmitted: 0, reasonCode: 'ACCOUNT_OBSERVATION_NOT_CURRENT' };
          const decision = evaluateRisk(createBotRiskPolicy(request.decision.pair, request.maxInr), {
            ...request.context, evaluationTimeMs: clock.nowMs(),
          });
          if (decision.status !== 'ACCEPTED') return { status: 'REFUSED', ordersSubmitted: 0, reasonCode: 'RISK_RECHECK_REJECTED' };
          if (new Decimal(decision.approved.approvedNotionalInr).gt(request.maxInr)) return { status: 'REFUSED', ordersSubmitted: 0, reasonCode: 'MAX_INR_EXCEEDED' };
          if (!(gateway instanceof CoinDcxLiveFuturesOrderGateway) || typeof mutationBudget.admit !== 'function') {
            return { status: 'REFUSED', ordersSubmitted: 0, reasonCode: 'LIVE_EXECUTION_NOT_CONFIGURED' };
          }
          // A pacing permit cannot replace a durable admission, a fenced live intent, or CLOSE/CANCEL ownership.
          // The frozen production service is the dispatch owner. Do not reach around it via raw gateway methods.
          return { status: 'REFUSED', ordersSubmitted: 0, reasonCode: decision.action === 'CLOSE'
            ? 'LIVE_CLOSE_OWNERSHIP_AND_REDUCE_ONLY_AUTHORITY_REQUIRED' : 'LIVE_DURABLE_ADMISSION_REQUIRED' };
        } };
      },
    });
    const report = await orchestrator.run();
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'DEGRADED') process.exitCode = 1;
  } finally {
    try { await limiter?.close(); }
    finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const safeCodes = new Set(['INVALID_BOT_MODE', 'INVALID_STRATEGY', 'INVALID_CYCLES', 'INVALID_INTERVAL_MS', 'INVALID_MAX_INR', 'INVALID_COINS', 'INVALID_EQUITY_INR',
      'TINY_LIVE_REQUIRES_EXPLICIT_EQUITY_INR', 'SHADOW_CAPITAL_INVALID', 'SHADOW_CAPITAL_WRITE_FAILED', 'SHADOW_EQUITY_BASELINE_MISMATCH',
      'REQUESTED_COIN_PROFILE_NOT_FOUND', 'TINY_LIVE_REQUIRES_EXPLICIT_CONFIRM_FLAG', 'TINY_LIVE_REQUIRES_CREDENTIALS',
      'BOT_LIMITER_CONFIG_INVALID', 'BOT_LIMITER_START_FAILED', 'BOT_LIMITER_CONNECT_FAILED', 'BOT_LIMITER_DRAIN_FAILED', 'BOT_LIMITER_CLEANUP_PATH_REFUSED']);
    console.error(JSON.stringify({ error: error instanceof Error && safeCodes.has(error.message) ? error.message : 'BOT_RUN_FAILED' }, null, 2));
    process.exitCode = 1;
  });
}
