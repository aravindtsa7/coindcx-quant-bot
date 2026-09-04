import dotenv from 'dotenv';
import { loadCoinProfiles } from '../src/app/config/coins';
import { CoinRegistry, CoinRuntimeBootstrapService, createSubscriptionIntents } from '../src/coin-runtime';
import { Clock } from '../src/integration/coindcx/clock';
import { CoinDcxClient } from '../src/integration/coindcx/client';
import { CoinDcxPrivateAccountStream } from '../src/integration/coindcx/websocket/private-stream';
import { CoinDcxPublicFuturesStream, StreamScheduler } from '../src/integration/coindcx/websocket/public-stream';
import {
  CoinDcxSocketFactory,
  CoinDcxStreamEnvelope,
  PublicCandleUpdatePayload,
} from '../src/integration/coindcx/websocket/types';
import { waitForSmokeObservation } from './smoke-observation-helper';

// Load environment variables once at module initialization
dotenv.config();

const SMOKE_WAIT_TIMEOUT_MS = 20_000;
const PRIVATE_SMOKE_WAIT_TIMEOUT_MS = 5_000;

export interface PrivateSmokeOptions {
  apiKey?: string;
  apiSecret?: string;
  socketFactory?: CoinDcxSocketFactory;
  clock?: Clock;
  scheduler?: StreamScheduler;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function runPublicWsSmoke(): Promise<void> {
  console.log('=== COINDCX FUTURES WEBSOCKET LAYER — PUBLIC SMOKE TEST ===\n');

  // Load configured coin profiles
  const profiles = loadCoinProfiles();
  console.log(`[1/5] Loaded ${profiles.length} configured coin profile(s).`);

  // Discover and bootstrap coin runtimes via public API
  const client = new CoinDcxClient({});
  const registry = new CoinRegistry();
  const bootstrapService = new CoinRuntimeBootstrapService(client, registry);

  console.log('[2/5] Bootstrapping coin runtimes via public exchange discovery...');
  const bootstrapResult = await bootstrapService.bootstrap(profiles);
  if (bootstrapResult.failures.length > 0) {
    console.error(`Bootstrap encountered failures: ${JSON.stringify(bootstrapResult.failures)}`);
  }

  // Derive subscription intents
  const intents = createSubscriptionIntents(registry.list());
  console.log(`[3/5] Derived ${intents.length} market data subscription intent(s):`);
  for (const intent of intents) {
    console.log(`      - ${intent.underlying} -> Pair: ${intent.pair} (1m: ${intent.requiresOneMinuteCandles}, Trades: ${intent.requiresTrades})`);
  }

  if (intents.length === 0) {
    console.error('[FATAL] Zero market data subscription intents derived. Cannot proceed.');
    process.exitCode = 1;
    return;
  }

  // Initialize public futures stream
  console.log('\n[4/5] Initializing CoinDcxPublicFuturesStream (one shared public socket)...');
  const stream = new CoinDcxPublicFuturesStream();

  let candleCount = 0;
  const candlesByPair = new Map<string, number>();
  for (const intent of intents) {
    candlesByPair.set(intent.pair, 0);
  }

  let publicConnectedEver = false;
  let activeSubscriptionsAtPeak: readonly string[] = [];

  const unsubscribe = stream.subscribe((envelope: CoinDcxStreamEnvelope<unknown>) => {
    if (envelope.eventType === 'PUBLIC_STREAM_CONNECTED') {
      publicConnectedEver = true;
    } else if (envelope.eventType === 'PUBLIC_CANDLE_UPDATE') {
      candleCount++;
      const payload = envelope.payload as PublicCandleUpdatePayload;
      const current = candlesByPair.get(payload.pair) ?? 0;
      candlesByPair.set(payload.pair, current + 1);

      console.log(
        `      [CANDLE #${candleCount}] [${payload.pair}] O:${payload.open.toString()} H:${payload.high.toString()} L:${payload.low.toString()} C:${payload.close.toString()} V:${payload.volume.toString()} (Gen: ${envelope.generationId})`
      );
    }
  });

  try {
    console.log('      Connecting to CoinDcx WebSocket endpoint (wss://stream.coindcx.com)...');
    await stream.start(intents);
    publicConnectedEver = stream.connected || publicConnectedEver;
    activeSubscriptionsAtPeak = stream.activeSubscriptions;

    console.log(`      Connected! Generation: ${stream.generationId}, State: ${stream.state}`);
    console.log(`      Active Subscriptions: [${stream.activeSubscriptions.join(', ')}]`);

    console.log(`\n[5/5] Listening for real-time market data (bounded ${SMOKE_WAIT_TIMEOUT_MS / 1000}s)...`);

    const observedAllBeforeTimeout = await waitForSmokeObservation({
      timeoutMs: SMOKE_WAIT_TIMEOUT_MS,
      pollIntervalMs: 500,
      isComplete: () => {
        const allReceived = intents.every((intent) => (candlesByPair.get(intent.pair) ?? 0) >= 1);
        return allReceived && candleCount >= intents.length;
      },
    });

    if (observedAllBeforeTimeout) {
      console.log('      Received live candles for all intended pairs before timeout!');
    } else {
      console.warn('      Observation window timed out before all intended pairs received live candles.');
    }
  } finally {
    unsubscribe();

    // Snapshot before stop
    const healthBeforeStop = stream.getHealthSnapshot();
    const metricsBeforeStop = stream.getMetrics();
    const finalGen = healthBeforeStop.generationId;

    // Graceful stop (mandatory in finally)
    console.log('\nStopping WebSocket stream gracefully...');
    stream.stop();
    const cleanupConnected = stream.connected;
    const cleanupState = stream.state;
    console.log(`Stream stopped cleanly. Connected: ${cleanupConnected}, State: ${cleanupState}`);

    // Evaluation of fail-closed criteria
    const allPairsObserved = intents.every((intent) => (candlesByPair.get(intent.pair) ?? 0) >= 1);
    const subscriptionsComplete = activeSubscriptionsAtPeak.length >= intents.length;
    const cleanupSuccess = cleanupState === 'STOPPED' && !cleanupConnected;
    const invalidEventsAcceptable = healthBeforeStop.invalidEventCount === 0;

    const overallPassed =
      publicConnectedEver &&
      allPairsObserved &&
      subscriptionsComplete &&
      cleanupSuccess &&
      invalidEventsAcceptable;

    // Structured Summary (Section 17)
    console.log('\n=== PUBLIC SMOKE TEST STRUCTURED SUMMARY ===');
    console.log(`publicConnectedEver=${publicConnectedEver}`);
    console.log(`generationId=${finalGen}`);
    console.log(`sharedSocketCount=1`);
    console.log(`intendedSubscriptionCount=${intents.length}`);
    console.log(`activeSubscriptionCount=${activeSubscriptionsAtPeak.length}`);
    console.log('\npairEvidence:');
    for (const intent of intents) {
      const count = candlesByPair.get(intent.pair) ?? 0;
      console.log(`  ${intent.underlying} (${intent.pair}) -> observed=${count >= 1}, count=${count}`);
    }
    console.log(`\nvalidEvents=${metricsBeforeStop.validEventsTotal}`);
    console.log(`invalidEvents=${healthBeforeStop.invalidEventCount}`);
    console.log(`staleGenerationDrops=${healthBeforeStop.staleGenerationDropCount}`);
    console.log(`unexpectedEvents=${healthBeforeStop.unexpectedChannelEventCount}`);
    console.log('\ncleanup:');
    console.log(`connected=${cleanupConnected}`);
    console.log(`state=${cleanupState}`);
    console.log('\ncredentialsUsed=false');
    console.log('privateSocketStarted=false');

    if (overallPassed) {
      console.log('\n=== PUBLIC SMOKE TEST COMPLETE: SUCCESS ===');
      process.exitCode = 0;
    } else {
      console.error('\n=== PUBLIC SMOKE TEST FAILED ===');
      if (!publicConnectedEver) {
        console.error('- Failure Reason: Public WebSocket connection was never established.');
      }
      if (!allPairsObserved) {
        const missing = intents.filter((i) => (candlesByPair.get(i.pair) ?? 0) === 0).map((i) => i.pair);
        console.error(`- Failure Reason: Zero candle updates received for intended pair(s): ${missing.join(', ')}`);
      }
      if (!subscriptionsComplete) {
        console.error('- Failure Reason: Active subscription count did not match intended subscriptions.');
      }
      if (!cleanupSuccess) {
        console.error('- Failure Reason: Cleanup failed to achieve STOPPED / connected=false state.');
      }
      if (!invalidEventsAcceptable) {
        console.error(`- Failure Reason: Invalid event count (${healthBeforeStop.invalidEventCount}) exceeded threshold.`);
      }
      process.exitCode = 1;
    }
  }
}

export async function runPrivateWsSmoke(options: PrivateSmokeOptions = {}): Promise<void> {
  const apiKey = (options.apiKey !== undefined ? options.apiKey : process.env.COINDCX_API_KEY)?.trim();
  const apiSecret = (options.apiSecret !== undefined ? options.apiSecret : process.env.COINDCX_API_SECRET)?.trim();
  const credentialsLoaded = Boolean(apiKey && apiSecret);

  if (!credentialsLoaded || !apiKey || !apiSecret) {
    console.error('[FAIL] Required credentials (COINDCX_API_KEY, COINDCX_API_SECRET) unavailable in environment.');
    console.log('\n=== PRIVATE AUTH TRANSPORT SMOKE STRUCTURED SUMMARY ===');
    console.log('mode=PRIVATE_AUTH_TRANSPORT_SMOKE');
    console.log('privateConnectedEver=false');
    console.log('generationId=0');
    console.log('authJoinSent=false');
    console.log('authAckObserved=not_applicable');
    console.log('privateEventsObserved=0');
    console.log('reconciliationRequired=false');
    console.log('connected=false');
    console.log('state=STOPPED');
    console.log('credentialsLoaded=false');
    console.log('credentialsPrinted=false');
    console.log('mutationAttempted=false');
    console.error('\n=== PRIVATE AUTH TRANSPORT SMOKE FAILED ===');
    console.error('- Failure Reason: Required credentials (COINDCX_API_KEY, COINDCX_API_SECRET) unavailable in environment.');
    process.exitCode = 1;
    return;
  }

  console.log('=== COINDCX FUTURES WEBSOCKET LAYER — PRIVATE AUTH SMOKE TEST ===\n');
  console.log('[1/4] Loaded credentials from environment.');
  console.log('[2/4] Initializing CoinDcxPrivateAccountStream (dedicated private socket)...');

  const stream = new CoinDcxPrivateAccountStream({
    apiKey,
    apiSecret,
    ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });

  let privateConnectedEver = false;
  let authJoinSent = false;
  let privateEventsObserved = 0;
  let deterministicErrorObserved = false;
  let deterministicErrorMessage: string | null = null;

  const unsubscribe = stream.subscribe((envelope: CoinDcxStreamEnvelope<unknown>) => {
    if (envelope.eventType === 'PRIVATE_STREAM_CONNECTED') {
      privateConnectedEver = true;
    } else if (envelope.eventType === 'PRIVATE_STREAM_DISCONNECTED') {
      deterministicErrorObserved = true;
      deterministicErrorMessage = 'Private stream disconnected during bounded observation window';
    } else if (
      envelope.eventType === 'PRIVATE_POSITION_UPDATE_NOTIFICATION' ||
      envelope.eventType === 'PRIVATE_ORDER_UPDATE_NOTIFICATION' ||
      envelope.eventType === 'PRIVATE_BALANCE_CHANGE_NOTIFICATION'
    ) {
      privateEventsObserved++;
      console.log(
        `      [PRIVATE EVENT #${privateEventsObserved}] Event notification observed: type=${envelope.eventType} (Gen: ${envelope.generationId})`
      );
    }
  });

  const timeoutMs = options.timeoutMs ?? PRIVATE_SMOKE_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 250;

  let startError: Error | null = null;

  try {
    console.log('      Connecting to private WebSocket endpoint (wss://stream.coindcx.com)...');
    await stream.start();

    privateConnectedEver = stream.connected || privateConnectedEver;
    const initialSnapshot = stream.getHealthSnapshot();
    authJoinSent = initialSnapshot.authJoinSent;

    console.log(`      Connected! Generation: ${stream.generationId}, State: ${stream.state}`);
    console.log(`      Auth join emitted: authJoinSent=${authJoinSent}`);

    console.log(`\n[3/4] Observing transport state for bounded window (${timeoutMs / 1000}s)...`);

    const errorTriggered = await waitForSmokeObservation({
      timeoutMs,
      pollIntervalMs,
      isComplete: () => {
        if (deterministicErrorObserved) {
          return true;
        }
        if (!stream.connected) {
          deterministicErrorObserved = true;
          deterministicErrorMessage = 'Socket connected state lost during observation window';
          return true;
        }
        const snap = stream.getHealthSnapshot();
        if (snap.state === 'DEGRADED' || snap.reconnectCount > 0) {
          deterministicErrorObserved = true;
          deterministicErrorMessage = `Stream state transitioned to ${snap.state} (reconnectCount: ${snap.reconnectCount})`;
          return true;
        }
        return false;
      },
    });

    if (errorTriggered || deterministicErrorObserved) {
      console.warn(`      Transport observation noted issue: ${deterministicErrorMessage ?? 'Transport error observed'}`);
    } else {
      console.log('      Transport state remained healthy throughout bounded observation window.');
    }
  } catch (err: unknown) {
    startError = err instanceof Error ? err : new Error(String(err));
    deterministicErrorObserved = true;
    deterministicErrorMessage = `Connection or auth start failed: ${startError.message}`;
    console.error(`      [FAIL] Failed to establish private WebSocket connection: ${startError.message}`);
  } finally {
    unsubscribe();

    // Snapshot before stop
    const healthBeforeStop = stream.getHealthSnapshot();
    const generationId = healthBeforeStop.generationId;
    const reconciliationRequired = stream.isReconciliationRequired;
    authJoinSent = healthBeforeStop.authJoinSent || authJoinSent;

    // Graceful stop (mandatory in finally)
    console.log('\n[4/4] Stopping private WebSocket stream gracefully...');
    stream.stop();
    const cleanupConnected = stream.connected;
    const cleanupState = stream.state;
    console.log(`Private stream stopped cleanly. Connected: ${cleanupConnected}, State: ${cleanupState}`);

    const cleanupSuccess = cleanupState === 'STOPPED' && !cleanupConnected;
    const joinSuccess = authJoinSent;
    const noDeterministicError = !deterministicErrorObserved && startError === null;
    const generationValid = generationId >= 1;

    const overallPassed =
      privateConnectedEver &&
      generationValid &&
      joinSuccess &&
      noDeterministicError &&
      cleanupSuccess;

    // Structured Summary (Section 7)
    console.log('\n=== PRIVATE AUTH TRANSPORT SMOKE STRUCTURED SUMMARY ===');
    console.log('mode=PRIVATE_AUTH_TRANSPORT_SMOKE');
    console.log(`privateConnectedEver=${privateConnectedEver}`);
    console.log(`generationId=${generationId}`);
    console.log(`authJoinSent=${authJoinSent}`);
    console.log('authAckObserved=not_applicable');
    console.log(`privateEventsObserved=${privateEventsObserved}`);
    console.log(`reconciliationRequired=${reconciliationRequired}`);
    console.log(`connected=${cleanupConnected}`);
    console.log(`state=${cleanupState}`);
    console.log('credentialsLoaded=true');
    console.log('credentialsPrinted=false');
    console.log('mutationAttempted=false');

    if (overallPassed) {
      console.log('\n=== PRIVATE AUTH TRANSPORT SMOKE COMPLETE: SUCCESS ===');
      process.exitCode = 0;
    } else {
      console.error('\n=== PRIVATE AUTH TRANSPORT SMOKE FAILED ===');
      if (!privateConnectedEver) {
        console.error('- Failure Reason: Private WebSocket connection was never established.');
      }
      if (!generationValid) {
        console.error('- Failure Reason: Invalid generation ID established.');
      }
      if (!joinSuccess) {
        console.error('- Failure Reason: Auth join was not emitted successfully.');
      }
      if (!noDeterministicError) {
        console.error(`- Failure Reason: Deterministic error observed: ${deterministicErrorMessage ?? startError?.message}`);
      }
      if (!cleanupSuccess) {
        console.error('- Failure Reason: Cleanup failed to achieve STOPPED / connected=false state.');
      }
      process.exitCode = 1;
    }
  }
}

async function main(): Promise<void> {
  const isAuth = process.argv.includes('--auth');

  if (isAuth) {
    await runPrivateWsSmoke();
  } else {
    await runPublicWsSmoke();
  }
}

export { waitForSmokeObservation, SmokeObservationOptions } from './smoke-observation-helper';

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('\n[FATAL] WebSocket smoke test encountered unhandled exception:', err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
