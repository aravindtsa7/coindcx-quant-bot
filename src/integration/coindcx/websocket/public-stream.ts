import pino from 'pino';
import { MarketDataSubscriptionIntent } from '../../../coin-runtime/types';
import { Clock, SystemClock } from '../clock';
import { logger as rootLogger } from '../../../monitoring/logger';
import { BackoffPolicyConfig, calculateBackoffWithJitter, DEFAULT_BACKOFF_CONFIG } from './backoff';
import { buildFuturesCandleChannel } from './channel-builder';
import { validateAndNormalizeCandleEvent } from './schemas';
import {
  COINDCX_DEFAULT_SOCKET_ENDPOINT,
  ProductionCoinDcxSocketFactory,
} from './socket-adapter';
import {
  categorizeDisconnectReason,
  CoinDcxSocket,
  CoinDcxSocketFactory,
  CoinDcxStreamEnvelope,
  PublicCandleUpdatePayload,
  PublicRecoveryRequiredPayload,
  PublicStreamHealthSnapshot,
  PublicStreamState,
  SocketEventListener,
  StreamEventListener,
} from './types';

export interface StreamScheduler {
  setTimeout(callback: () => void, delayMs: number): number | NodeJS.Timeout;
  clearTimeout(timerId: number | NodeJS.Timeout): void;
  setInterval(callback: () => void, intervalMs: number): number | NodeJS.Timeout;
  clearInterval(timerId: number | NodeJS.Timeout): void;
}

export const SystemStreamScheduler: StreamScheduler = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (id) => clearInterval(id),
};

export interface PublicStreamConfig {
  endpoint?: string;
  socketFactory?: CoinDcxSocketFactory;
  clock?: Clock;
  scheduler?: StreamScheduler;
  rng?: () => number;
  connectTimeoutMs?: number;
  pingIntervalMs?: number;
  backoffConfig?: BackoffPolicyConfig;
  degradedErrorThreshold?: number;
  logger?: pino.Logger;
}

interface ReconnectToken {
  readonly generation: number;
  readonly timerId: number | NodeJS.Timeout;
}

/**
 * Shared CoinDCX Public Futures WebSocket Stream Manager.
 *
 * Architecture Invariants:
 * - Shared socket across all configured coin pairs (BTC, ETH, SOL, etc.)
 * - Strict generation isolation (callbacks from older generations are permanently dropped)
 * - Single-flight connection and single-flight reconnect scheduling
 * - Bounded exponential backoff with full jitter
 * - Pure channel subscription derived from Phase 3 MarketDataSubscriptionIntent
 * - Emits PUBLIC_STREAM_RECOVERY_REQUIRED on reconnect after active data feed
 * - Zero mutation methods, zero order execution, zero strategy calls
 */
export class CoinDcxPublicFuturesStream {
  readonly #endpoint: string;
  readonly #socketFactory: CoinDcxSocketFactory;
  readonly #clock: Clock;
  readonly #scheduler: StreamScheduler;
  readonly #rng: () => number;
  readonly #connectTimeoutMs: number;
  readonly #pingIntervalMs: number;
  readonly #backoffConfig: BackoffPolicyConfig;
  readonly #degradedErrorThreshold: number;
  readonly #logger: pino.Logger;

  #generationId = 0;
  #localSequence = 0;
  #state: PublicStreamState = 'STOPPED';
  #isStopped = true;

  #socket: CoinDcxSocket | null = null;
  #activeSocketListeners: Array<[string, SocketEventListener]> | null = null;
  #connectionAttempt: Promise<void> | null = null;
  #reconnectToken: ReconnectToken | null = null;
  #connectTimeoutTimer: number | NodeJS.Timeout | null = null;
  #pingTimer: number | NodeJS.Timeout | null = null;

  #reconnectAttempt = 0;
  #reconnectCount = 0;
  #connectionsTotal = 0;
  #disconnectsTotal = 0;

  // Intended subscriptions (immutable snapshot)
  #intendedChannels = new Map<string, { pair: string; channel: string }>();
  // Active server subscriptions confirmed for current generation
  #activeSubscriptions = new Set<string>();

  // Barriers and timestamps
  #hadValidMarketData = false;
  #lastDisconnectReceivedAtMs = 0;
  #recoveryRequired = false;
  #lastValidProviderTimestampByPair = new Map<string, number>();

  // Metrics
  #lastValidEventReceivedAtMs: number | null = null;
  #invalidEventCount = 0;
  #staleGenerationDropCount = 0;
  #unexpectedChannelEventCount = 0;
  #validEventsTotal = 0;

  // Downstream subscribers
  readonly #subscribers = new Set<StreamEventListener>();

  constructor(config: PublicStreamConfig = {}) {
    this.#endpoint = config.endpoint ?? COINDCX_DEFAULT_SOCKET_ENDPOINT;
    this.#socketFactory = config.socketFactory ?? new ProductionCoinDcxSocketFactory();
    this.#clock = config.clock ?? new SystemClock();
    this.#scheduler = config.scheduler ?? SystemStreamScheduler;
    this.#rng = config.rng ?? Math.random;
    this.#connectTimeoutMs = config.connectTimeoutMs ?? 10000;
    this.#pingIntervalMs = config.pingIntervalMs ?? 25000;
    this.#backoffConfig = config.backoffConfig ?? DEFAULT_BACKOFF_CONFIG;
    this.#degradedErrorThreshold = config.degradedErrorThreshold ?? 10;
    this.#logger = config.logger ?? rootLogger;
  }

  public get generationId(): number {
    return this.#generationId;
  }

  public get state(): PublicStreamState {
    return this.#state;
  }

  public get connected(): boolean {
    return this.#socket !== null && this.#socket.connected;
  }

  public get isRecoveryRequired(): boolean {
    return this.#recoveryRequired;
  }

  public get activeSubscriptions(): readonly string[] {
    return Object.freeze(Array.from(this.#activeSubscriptions));
  }

  /**
   * Subscribes a downstream listener to stream envelopes.
   * Returns an unsubscribe function.
   */
  public subscribe(listener: StreamEventListener): () => void {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  /**
   * Synchronizes subscription intents with the current stream.
   * Joins new channels and leaves removed channels.
   */
  public syncSubscriptions(intents: readonly MarketDataSubscriptionIntent[]): void {
    const newIntended = new Map<string, { pair: string; channel: string }>();

    for (const intent of intents) {
      if (intent.requiresOneMinuteCandles) {
        try {
          const channel = buildFuturesCandleChannel(intent.pair, '1m');
          newIntended.set(channel, { pair: intent.pair, channel });
        } catch {
          // Ignore invalid pairs without crashing stream
        }
      }
    }

    const previousChannels = new Set(this.#intendedChannels.keys());
    this.#intendedChannels = newIntended;

    if (!this.connected || this.#socket === null) {
      return;
    }

    // Leave channels that are no longer intended
    for (const ch of previousChannels) {
      if (!newIntended.has(ch) && this.#activeSubscriptions.has(ch)) {
        this.#socket.emit('leave', { channelName: ch });
        this.#activeSubscriptions.delete(ch);
      }
    }

    // Join newly intended channels
    for (const [ch] of newIntended) {
      if (!this.#activeSubscriptions.has(ch)) {
        this.#socket.emit('join', { channelName: ch });
        this.#activeSubscriptions.add(ch);
      }
    }
  }

  /**
   * Starts the public futures stream.
   * Single-flight: concurrent start calls join the same connection attempt.
   */
  public async start(intents?: readonly MarketDataSubscriptionIntent[]): Promise<void> {
    this.#isStopped = false;
    this.#cleanupReconnectTimer();

    if (intents) {
      this.syncSubscriptions(intents);
    }

    return this.#ensureConnected();
  }

  /**
   * Single-flight connection initiator.
   */
  #ensureConnected(): Promise<void> {
    if (this.#isStopped) {
      return Promise.resolve();
    }

    if (this.#connectionAttempt !== null) {
      return this.#connectionAttempt;
    }

    if (this.connected) {
      return Promise.resolve();
    }

    const attempt = this.#executeConnectGeneration();
    this.#connectionAttempt = attempt;
    attempt
      .finally(() => {
        if (this.#connectionAttempt === attempt) {
          this.#connectionAttempt = null;
        }
      })
      .catch(() => {});

    return attempt;
  }

  /**
   * Increments generation, disposes previous socket, and creates fresh generation socket.
   */
  #executeConnectGeneration(): Promise<void> {
    this.#cleanupReconnectTimer();
    // Increment generation BEFORE creating fresh socket instance (Generation Creation Rule)
    this.#generationId++;
    const currentGeneration = this.#generationId;
    this.#localSequence = 0;

    this.#cleanupOldSocket();
    this.#state = 'CONNECTING';

    return new Promise<void>((resolve, reject) => {
      let resolved = false;

      // Bound connection timeout
      this.#connectTimeoutTimer = this.#scheduler.setTimeout(() => {
        if (currentGeneration !== this.#generationId || this.#isStopped) return;
        this.#cleanupConnectTimeout();

        this.#logger.warn({
          module: 'coindcx:public-stream',
          generationId: currentGeneration,
          category: 'SOCKET_CONNECT_TIMEOUT',
          msg: 'Public socket connection timed out',
        });

        this.#handleConnectionFailure(currentGeneration, new Error('SOCKET_CONNECT_TIMEOUT'));
        if (!resolved) {
          resolved = true;
          this.#connectionAttempt = null;
          reject(new Error('SOCKET_CONNECT_TIMEOUT'));
        }
      }, this.#connectTimeoutMs);

      try {
        const socket = this.#socketFactory.createSocket(this.#endpoint);
        this.#socket = socket;

        // Register generation-pinned listeners with exact references
        const connectListener: SocketEventListener = () => {
          if (currentGeneration !== this.#generationId || this.#isStopped) {
            this.#staleGenerationDropCount++;
            return;
          }

          this.#cleanupConnectTimeout();
          this.#cleanupReconnectTimer();
          this.#connectionsTotal++;
          this.#state = 'CONNECTED';

          // If reconnecting after valid data, mark recovery required barrier
          const isReconnect = this.#reconnectAttempt > 0 || this.#hadValidMarketData;
          if (isReconnect && this.#hadValidMarketData) {
            this.#recoveryRequired = true;
            this.#state = 'RECOVERY_REQUIRED';

            this.#dispatchEnvelope({
              source: 'COINDCX',
              stream: 'PUBLIC_FUTURES',
              generationId: currentGeneration,
              sequence: ++this.#localSequence,
              receivedAtMs: this.#clock.nowMs(),
              eventType: 'PUBLIC_STREAM_RECOVERY_REQUIRED',
              providerTimestampMs: null,
              pair: null,
              payload: Object.freeze<PublicRecoveryRequiredPayload>({
                previousGeneration: currentGeneration - 1,
                newGeneration: currentGeneration,
                disconnectReceivedAtMs: this.#lastDisconnectReceivedAtMs,
                reconnectedAtMs: this.#clock.nowMs(),
                lastValidProviderTimestampByPair: Object.freeze(
                  Object.fromEntries(this.#lastValidProviderTimestampByPair)
                ),
              }),
            });
          }

          this.#dispatchEnvelope({
            source: 'COINDCX',
            stream: 'PUBLIC_FUTURES',
            generationId: currentGeneration,
            sequence: ++this.#localSequence,
            receivedAtMs: this.#clock.nowMs(),
            eventType: 'PUBLIC_STREAM_CONNECTED',
            providerTimestampMs: null,
            pair: null,
            payload: { generationId: currentGeneration },
          });

          // Re-subscribe intended channels
          this.#emitIntendedSubscriptions(socket);

          // Reset reconnect attempt count only after successful baseline established
          this.#reconnectAttempt = 0;

          // Start ping task
          this.#startPingTask(currentGeneration, socket);

          if (!resolved) {
            resolved = true;
            this.#connectionAttempt = null;
            resolve();
          }
        };

        const disconnectListener: SocketEventListener = (rawReason: unknown) => {
          if (currentGeneration !== this.#generationId || this.#isStopped) {
            this.#staleGenerationDropCount++;
            return;
          }

          this.#disconnectsTotal++;
          this.#lastDisconnectReceivedAtMs = this.#clock.nowMs();
          const category = categorizeDisconnectReason(rawReason);

          this.#logger.info({
            module: 'coindcx:public-stream',
            generationId: currentGeneration,
            disconnectReasonCategory: category,
            msg: 'Public socket disconnected',
          });

          this.#dispatchEnvelope({
            source: 'COINDCX',
            stream: 'PUBLIC_FUTURES',
            generationId: currentGeneration,
            sequence: ++this.#localSequence,
            receivedAtMs: this.#lastDisconnectReceivedAtMs,
            eventType: 'PUBLIC_STREAM_DISCONNECTED',
            providerTimestampMs: null,
            pair: null,
            payload: { reason: category, generationId: currentGeneration },
          });

          this.#scheduleReconnect(currentGeneration);
        };

        const connectErrorListener: SocketEventListener = () => {
          if (currentGeneration !== this.#generationId || this.#isStopped) {
            this.#staleGenerationDropCount++;
            return;
          }

          this.#cleanupConnectTimeout();
          this.#handleConnectionFailure(currentGeneration, new Error('SOCKET_CONNECT_FAILED'));

          if (!resolved) {
            resolved = true;
            this.#connectionAttempt = null;
            reject(new Error('SOCKET_CONNECT_FAILED'));
          }
        };

        const errorListener: SocketEventListener = () => {
          if (currentGeneration !== this.#generationId || this.#isStopped) {
            this.#staleGenerationDropCount++;
            return;
          }

          this.#handleConnectionFailure(currentGeneration, new Error('SOCKET_ERROR'));
        };

        const candlestickListener: SocketEventListener = (rawPayload: unknown) => {
          this.#handleCandlestickMessage(currentGeneration, rawPayload);
        };

        socket.on('connect', connectListener);
        socket.on('disconnect', disconnectListener);
        socket.on('connect_error', connectErrorListener);
        socket.on('error', errorListener);
        socket.on('candlestick', candlestickListener);

        this.#activeSocketListeners = [
          ['connect', connectListener],
          ['disconnect', disconnectListener],
          ['connect_error', connectErrorListener],
          ['error', errorListener],
          ['candlestick', candlestickListener],
        ];

        // Initiate connection
        socket.connect();
      } catch (err: unknown) {
        this.#cleanupConnectTimeout();
        this.#handleConnectionFailure(currentGeneration, err);
        if (!resolved) {
          resolved = true;
          this.#connectionAttempt = null;
          reject(new Error('SOCKET_CONNECT_FAILED'));
        }
      }
    });
  }

  #emitIntendedSubscriptions(socket: CoinDcxSocket): void {
    this.#activeSubscriptions.clear();
    this.#state = this.#recoveryRequired ? 'RECOVERY_REQUIRED' : 'SUBSCRIBING';

    for (const [channelName] of this.#intendedChannels) {
      socket.emit('join', { channelName });
      this.#activeSubscriptions.add(channelName);
    }

    if (this.#state === 'SUBSCRIBING') {
      this.#state = 'STREAMING';
    }
  }

  #handleCandlestickMessage(generation: number, raw: unknown): void {
    if (generation !== this.#generationId || this.#isStopped) {
      this.#staleGenerationDropCount++;
      return;
    }

    try {
      let parsed: unknown = raw;
      if (typeof raw === 'string') {
        try {
          parsed = JSON.parse(raw);
        } catch {
          this.#invalidEventCount++;
          return;
        }
      }
      if (parsed && typeof parsed === 'object') {
        const rawObj = parsed as Record<string, unknown>;
        if (typeof rawObj['data'] === 'string') {
          try {
            const inner = JSON.parse(rawObj['data'] as string);
            if (Array.isArray(inner)) {
              parsed = { ...rawObj, data: inner };
            } else if (typeof inner === 'object' && inner !== null) {
              parsed = { ...rawObj, ...inner };
            }
          } catch {
            this.#invalidEventCount++;
            return;
          }
        }
      }

      const envelopeData = parsed as { channel?: string; data?: Array<{ pair?: string }> };
      const rawChannel = typeof envelopeData?.channel === 'string' ? envelopeData.channel : '';

      // Check if channel was intended and subscribed for this generation
      if (!this.#intendedChannels.has(rawChannel)) {
        this.#unexpectedChannelEventCount++;
        return;
      }

      const intendedInfo = this.#intendedChannels.get(rawChannel)!;
      const normalizedCandle = validateAndNormalizeCandleEvent(parsed, intendedInfo.pair);

      // Record valid market data observation
      this.#hadValidMarketData = true;
      this.#validEventsTotal++;
      this.#lastValidEventReceivedAtMs = this.#clock.nowMs();
      this.#lastValidProviderTimestampByPair.set(
        normalizedCandle.pair,
        normalizedCandle.providerEventTimeMs
      );

      if (this.#state !== 'RECOVERY_REQUIRED') {
        this.#state = 'STREAMING';
      }

      this.#dispatchEnvelope<PublicCandleUpdatePayload>({
        source: 'COINDCX',
        stream: 'PUBLIC_FUTURES',
        generationId: generation,
        sequence: ++this.#localSequence,
        receivedAtMs: this.#lastValidEventReceivedAtMs,
        eventType: 'PUBLIC_CANDLE_UPDATE',
        providerTimestampMs: normalizedCandle.providerEventTimeMs,
        pair: normalizedCandle.pair,
        payload: normalizedCandle,
      });
    } catch {
      this.#invalidEventCount++;
      if (this.#invalidEventCount > this.#degradedErrorThreshold && this.#state !== 'RECOVERY_REQUIRED') {
        this.#state = 'DEGRADED';
      }
    }
  }

  #handleConnectionFailure(generation: number, _err: unknown): void {
    if (generation !== this.#generationId || this.#isStopped) {
      this.#staleGenerationDropCount++;
      return;
    }

    this.#scheduleReconnect(generation);
  }

  /**
   * Single-flight reconnect scheduling with generation token, bounded backoff and jitter.
   */
  #scheduleReconnect(generation: number): void {
    if (generation !== this.#generationId || this.#isStopped) {
      return;
    }

    if (this.#reconnectToken !== null) {
      if (this.#reconnectToken.generation === generation) {
        return; // Reconnect timer single-flight for current generation
      }
      this.#cleanupReconnectTimer();
    }

    this.#cleanupOldSocket();
    this.#reconnectAttempt++;
    this.#reconnectCount++;
    this.#state = 'RECONNECT_WAIT';

    const delayMs = calculateBackoffWithJitter(
      this.#reconnectAttempt,
      this.#backoffConfig,
      this.#rng
    );

    const timerGeneration = generation;
    const timerId = this.#scheduler.setTimeout(() => {
      if (this.#reconnectToken?.timerId === timerId) {
        this.#reconnectToken = null;
      }
      if (timerGeneration !== this.#generationId || this.#isStopped) {
        this.#staleGenerationDropCount++;
        return;
      }
      this.#ensureConnected().catch(() => {
        // Connection failure will trigger next backoff attempt
      });
    }, delayMs);

    this.#reconnectToken = { generation: timerGeneration, timerId };
  }

  #startPingTask(generation: number, socket: CoinDcxSocket): void {
    this.#cleanupPing();

    this.#pingTimer = this.#scheduler.setInterval(() => {
      if (generation !== this.#generationId || this.#isStopped) {
        this.#cleanupPing();
        return;
      }

      if (socket.connected) {
        try {
          socket.emit('ping', { data: 'Ping message' });
        } catch {
          // Socket write failure handled by disconnect event
        }
      }
    }, this.#pingIntervalMs);
  }

  #dispatchEnvelope<T>(envelope: CoinDcxStreamEnvelope<T>): void {
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(envelope as unknown as CoinDcxStreamEnvelope<unknown>);
      } catch {
        this.#logger.error({
          module: 'coindcx:public-stream',
          generationId: envelope.generationId,
          category: 'DOWNSTREAM_HANDLER_ERROR',
          eventType: envelope.eventType,
          msg: 'Downstream subscriber threw an error',
        });
      }
    }
  }

  #cleanupConnectTimeout(): void {
    if (this.#connectTimeoutTimer !== null) {
      this.#scheduler.clearTimeout(this.#connectTimeoutTimer);
      this.#connectTimeoutTimer = null;
    }
  }

  #cleanupReconnectTimer(): void {
    if (this.#reconnectToken !== null) {
      this.#scheduler.clearTimeout(this.#reconnectToken.timerId);
      this.#reconnectToken = null;
    }
  }

  #cleanupPing(): void {
    if (this.#pingTimer !== null) {
      this.#scheduler.clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }

  #cleanupOldSocket(): void {
    this.#cleanupConnectTimeout();
    this.#cleanupPing();
    this.#connectionAttempt = null;

    if (this.#socket !== null) {
      const oldSocket = this.#socket;
      this.#socket = null;

      if (this.#activeSocketListeners !== null) {
        for (const [event, listener] of this.#activeSocketListeners) {
          oldSocket.off(event, listener);
        }
        this.#activeSocketListeners = null;
      }

      try {
        oldSocket.disconnect();
      } catch {
        // Ignore error during cleanup
      }
    }
  }

  /**
   * Idempotently stops the public futures stream.
   * Cancels all timers, detaches listeners, closes connection, resets latches.
   */
  public stop(): void {
    this.#isStopped = true;
    this.#generationId++; // Invalidate any running callbacks immediately
    this.#cleanupConnectTimeout();
    this.#cleanupReconnectTimer();
    this.#cleanupPing();
    this.#cleanupOldSocket();
    this.#connectionAttempt = null;
    this.#activeSubscriptions.clear();
    this.#state = 'STOPPED';
  }

  /**
   * Exposes an immutable, non-sensitive health snapshot.
   */
  public getHealthSnapshot(): PublicStreamHealthSnapshot {
    return Object.freeze({
      state: this.#state,
      generationId: this.#generationId,
      reconnectAttempt: this.#reconnectAttempt,
      connected: this.connected,
      intendedSubscriptionCount: this.#intendedChannels.size,
      activeSubscriptionCount: this.#activeSubscriptions.size,
      lastValidEventReceivedAtMs: this.#lastValidEventReceivedAtMs,
      invalidEventCount: this.#invalidEventCount,
      staleGenerationDropCount: this.#staleGenerationDropCount,
      unexpectedChannelEventCount: this.#unexpectedChannelEventCount,
      reconnectCount: this.#reconnectCount,
      recoveryRequired: this.#recoveryRequired,
    });
  }

  public getMetrics(): Readonly<Record<string, number>> {
    return Object.freeze({
      connectionsTotal: this.#connectionsTotal,
      disconnectsTotal: this.#disconnectsTotal,
      reconnectsTotal: this.#reconnectCount,
      validEventsTotal: this.#validEventsTotal,
      invalidEventsTotal: this.#invalidEventCount,
      staleGenerationDropsTotal: this.#staleGenerationDropCount,
      unexpectedChannelEventsTotal: this.#unexpectedChannelEventCount,
    });
  }
}
