import pino from 'pino';
import { Clock, SystemClock } from '../clock';
import { HmacSha256Signer, RequestSigner } from '../signer';
import { CoinDcxConfigError } from '../../../core/errors/app-error';
import { logger as rootLogger } from '../../../monitoring/logger';
import { BackoffPolicyConfig, calculateBackoffWithJitter, DEFAULT_BACKOFF_CONFIG } from './backoff';
import { StreamScheduler, SystemStreamScheduler } from './public-stream';
import {
  validateAndFilterOrderNotification,
  validateAndFilterPositionNotification,
  validateBalanceNotification,
} from './schemas';
import {
  COINDCX_DEFAULT_SOCKET_ENDPOINT,
  ProductionCoinDcxSocketFactory,
} from './socket-adapter';
import {
  categorizeDisconnectReason,
  CoinDcxSocket,
  CoinDcxSocketFactory,
  CoinDcxStreamEnvelope,
  PrivateBalanceNotificationPayload,
  PrivateOrderNotificationPayload,
  PrivatePositionNotificationPayload,
  PrivateReconciliationRequiredPayload,
  PrivateStreamHealthSnapshot,
  PrivateStreamState,
  SocketEventListener,
  StreamEventListener,
} from './types';

export const PRIVATE_CHANNEL_NAME = 'coindcx';
export const CANONICAL_AUTH_BODY = JSON.stringify({ channel: PRIVATE_CHANNEL_NAME });

export interface PrivateStreamConfig {
  apiKey?: string;
  apiSecret?: string;
  endpoint?: string;
  socketFactory?: CoinDcxSocketFactory;
  clock?: Clock;
  scheduler?: StreamScheduler;
  rng?: () => number;
  connectTimeoutMs?: number;
  pingIntervalMs?: number;
  backoffConfig?: BackoffPolicyConfig;
  degradedErrorThreshold?: number;
  signer?: RequestSigner;
  logger?: pino.Logger;
}

interface ReconnectToken {
  readonly generation: number;
  readonly timerId: number | NodeJS.Timeout;
}

/**
 * Isolated CoinDCX Private Account WebSocket Stream Manager.
 *
 * Architecture Invariants:
 * - Dedicated private socket completely isolated from public streams
 * - Generation isolation: stale callbacks from earlier generations are dropped
 * - Signs canonical exact JSON body {"channel":"coindcx"} using HMAC-SHA256
 * - Joins private channel 'coindcx' on connect
 * - Enters AUTH_JOIN_SENT state (never falsely claims AUTHENTICATED)
 * - Private events are change notifications and reconciliation barriers, NOT authoritative truth
 * - Emits PRIVATE_RECONCILIATION_REQUIRED on reconnect
 * - Zero logging of API keys, secrets, signatures, or private record payloads
 */
export class CoinDcxPrivateAccountStream {
  readonly #apiKey: string;
  readonly #signer: RequestSigner;
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
  #state: PrivateStreamState = 'STOPPED';
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

  // Barriers and states
  #hadConnected = false;
  #authJoinSent = false;
  #reconciliationRequired = false;
  #lastDisconnectReceivedAtMs = 0;

  // Metrics
  #lastEventReceivedAtMs: number | null = null;
  #invalidEventCount = 0;
  #staleGenerationDropCount = 0;
  #validNotificationsTotal = 0;

  // Downstream subscribers
  readonly #subscribers = new Set<StreamEventListener>();

  constructor(config: PrivateStreamConfig) {
    if (!config.apiKey || config.apiKey.trim() === '') {
      throw new CoinDcxConfigError('COINDCX_API_KEY is required for private stream initialization');
    }
    this.#apiKey = config.apiKey.trim();

    if (config.signer) {
      this.#signer = config.signer;
    } else {
      if (!config.apiSecret || config.apiSecret.trim() === '') {
        throw new CoinDcxConfigError('COINDCX_API_SECRET is required for private stream request signing');
      }
      this.#signer = new HmacSha256Signer(config.apiSecret.trim());
    }

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

  public get state(): PrivateStreamState {
    return this.#state;
  }

  public get connected(): boolean {
    return this.#socket !== null && this.#socket.connected;
  }

  public get isReconciliationRequired(): boolean {
    return this.#reconciliationRequired;
  }

  public subscribe(listener: StreamEventListener): () => void {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  public async start(): Promise<void> {
    this.#isStopped = false;
    this.#cleanupReconnectTimer();
    return this.#ensureConnected();
  }

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

  #executeConnectGeneration(): Promise<void> {
    this.#cleanupReconnectTimer();
    this.#generationId++;
    const currentGeneration = this.#generationId;
    this.#localSequence = 0;

    this.#cleanupOldSocket();
    this.#state = 'CONNECTING';
    this.#authJoinSent = false;

    return new Promise<void>((resolve, reject) => {
      let resolved = false;

      this.#connectTimeoutTimer = this.#scheduler.setTimeout(() => {
        if (currentGeneration !== this.#generationId || this.#isStopped) return;
        this.#cleanupConnectTimeout();

        this.#logger.warn({
          module: 'coindcx:private-stream',
          generationId: currentGeneration,
          category: 'SOCKET_CONNECT_TIMEOUT',
          msg: 'Private socket connection timed out',
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

        const connectListener: SocketEventListener = () => {
          if (currentGeneration !== this.#generationId || this.#isStopped) {
            this.#staleGenerationDropCount++;
            return;
          }

          this.#cleanupConnectTimeout();
          this.#cleanupReconnectTimer();
          this.#connectionsTotal++;
          this.#state = 'CONNECTED';

          // If reconnecting, private event continuity is broken: trigger reconciliation barrier
          const isReconnect = this.#reconnectAttempt > 0 || this.#hadConnected;
          if (isReconnect) {
            this.#reconciliationRequired = true;
            this.#state = 'RECONCILIATION_REQUIRED';

            this.#dispatchEnvelope({
              source: 'COINDCX',
              stream: 'PRIVATE_ACCOUNT',
              generationId: currentGeneration,
              sequence: ++this.#localSequence,
              receivedAtMs: this.#clock.nowMs(),
              eventType: 'PRIVATE_RECONCILIATION_REQUIRED',
              providerTimestampMs: null,
              pair: null,
              payload: Object.freeze<PrivateReconciliationRequiredPayload>({
                previousGeneration: currentGeneration - 1,
                newGeneration: currentGeneration,
                disconnectReceivedAtMs: this.#lastDisconnectReceivedAtMs,
                reconnectedAtMs: this.#clock.nowMs(),
              }),
            });
          }

          this.#hadConnected = true;

          this.#dispatchEnvelope({
            source: 'COINDCX',
            stream: 'PRIVATE_ACCOUNT',
            generationId: currentGeneration,
            sequence: ++this.#localSequence,
            receivedAtMs: this.#clock.nowMs(),
            eventType: 'PRIVATE_STREAM_CONNECTED',
            providerTimestampMs: null,
            pair: null,
            payload: { generationId: currentGeneration },
          });

          // Send authenticated private channel join
          this.#sendAuthJoin(socket);

          // Reset reconnect attempts
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
            module: 'coindcx:private-stream',
            generationId: currentGeneration,
            disconnectReasonCategory: category,
            msg: 'Private socket disconnected',
          });

          this.#dispatchEnvelope({
            source: 'COINDCX',
            stream: 'PRIVATE_ACCOUNT',
            generationId: currentGeneration,
            sequence: ++this.#localSequence,
            receivedAtMs: this.#lastDisconnectReceivedAtMs,
            eventType: 'PRIVATE_STREAM_DISCONNECTED',
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

        // Private notification event listeners
        const positionListener: SocketEventListener = (rawPayload: unknown) => {
          this.#handlePositionUpdate(currentGeneration, rawPayload);
        };

        const orderListener: SocketEventListener = (rawPayload: unknown) => {
          this.#handleOrderUpdate(currentGeneration, rawPayload);
        };

        const balanceListener: SocketEventListener = (rawPayload: unknown) => {
          this.#handleBalanceUpdate(currentGeneration, rawPayload);
        };

        socket.on('connect', connectListener);
        socket.on('disconnect', disconnectListener);
        socket.on('connect_error', connectErrorListener);
        socket.on('error', errorListener);
        socket.on('df-position-update', positionListener);
        socket.on('df-order-update', orderListener);
        socket.on('balance-update', balanceListener);

        this.#activeSocketListeners = [
          ['connect', connectListener],
          ['disconnect', disconnectListener],
          ['connect_error', connectErrorListener],
          ['error', errorListener],
          ['df-position-update', positionListener],
          ['df-order-update', orderListener],
          ['balance-update', balanceListener],
        ];

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

  /**
   * Generates HMAC-SHA256 signature and emits join request.
   * Invariant: Never logs credentials or signature.
   */
  #sendAuthJoin(socket: CoinDcxSocket): void {
    const authSignature = this.#signer.sign(CANONICAL_AUTH_BODY);

    socket.emit('join', {
      channelName: PRIVATE_CHANNEL_NAME,
      authSignature,
      apiKey: this.#apiKey,
    });

    this.#authJoinSent = true;
    if (this.#state !== 'RECONCILIATION_REQUIRED') {
      this.#state = 'AUTH_JOIN_SENT';
    }

    this.#logger.info({
      module: 'coindcx:private-stream',
      generationId: this.#generationId,
      channel: PRIVATE_CHANNEL_NAME,
      msg: 'Dispatched private authenticated channel join request',
    });
  }

  #handlePositionUpdate(generation: number, raw: unknown): void {
    if (generation !== this.#generationId || this.#isStopped) {
      this.#staleGenerationDropCount++;
      return;
    }

    try {
      const payload = validateAndFilterPositionNotification(raw);
      this.#validNotificationsTotal++;
      this.#lastEventReceivedAtMs = this.#clock.nowMs();

      // Invariant: Do not log private record details
      this.#logger.debug({
        module: 'coindcx:private-stream',
        generationId: generation,
        eventType: 'df-position-update',
        inrPositionCount: payload.positions.length,
        droppedNonInrCount: payload.droppedNonInrCount,
        msg: 'Received private position update notification',
      });

      this.#dispatchEnvelope<PrivatePositionNotificationPayload>({
        source: 'COINDCX',
        stream: 'PRIVATE_ACCOUNT',
        generationId: generation,
        sequence: ++this.#localSequence,
        receivedAtMs: this.#lastEventReceivedAtMs,
        eventType: 'PRIVATE_POSITION_UPDATE_NOTIFICATION',
        providerTimestampMs: payload.positions[0]?.updatedAtMs ?? null,
        pair: payload.positions[0]?.pair ?? null,
        payload,
      });
    } catch {
      this.#invalidEventCount++;
      if (this.#invalidEventCount > this.#degradedErrorThreshold && this.#state !== 'RECONCILIATION_REQUIRED') {
        this.#state = 'DEGRADED';
      }
    }
  }

  #handleOrderUpdate(generation: number, raw: unknown): void {
    if (generation !== this.#generationId || this.#isStopped) {
      this.#staleGenerationDropCount++;
      return;
    }

    try {
      const payload = validateAndFilterOrderNotification(raw);
      this.#validNotificationsTotal++;
      this.#lastEventReceivedAtMs = this.#clock.nowMs();

      this.#logger.debug({
        module: 'coindcx:private-stream',
        generationId: generation,
        eventType: 'df-order-update',
        inrOrderCount: payload.orders.length,
        droppedNonInrCount: payload.droppedNonInrCount,
        msg: 'Received private order update notification',
      });

      this.#dispatchEnvelope<PrivateOrderNotificationPayload>({
        source: 'COINDCX',
        stream: 'PRIVATE_ACCOUNT',
        generationId: generation,
        sequence: ++this.#localSequence,
        receivedAtMs: this.#lastEventReceivedAtMs,
        eventType: 'PRIVATE_ORDER_UPDATE_NOTIFICATION',
        providerTimestampMs: payload.orders[0]?.updatedAtMs ?? null,
        pair: payload.orders[0]?.pair ?? null,
        payload,
      });
    } catch {
      this.#invalidEventCount++;
      if (this.#invalidEventCount > this.#degradedErrorThreshold && this.#state !== 'RECONCILIATION_REQUIRED') {
        this.#state = 'DEGRADED';
      }
    }
  }

  #handleBalanceUpdate(generation: number, raw: unknown): void {
    if (generation !== this.#generationId || this.#isStopped) {
      this.#staleGenerationDropCount++;
      return;
    }

    try {
      const payload = validateBalanceNotification(raw);
      this.#validNotificationsTotal++;
      this.#lastEventReceivedAtMs = this.#clock.nowMs();

      this.#logger.debug({
        module: 'coindcx:private-stream',
        generationId: generation,
        eventType: 'balance-update',
        balanceCount: payload.balances.length,
        msg: 'Received private balance change notification',
      });

      this.#dispatchEnvelope<PrivateBalanceNotificationPayload>({
        source: 'COINDCX',
        stream: 'PRIVATE_ACCOUNT',
        generationId: generation,
        sequence: ++this.#localSequence,
        receivedAtMs: this.#lastEventReceivedAtMs,
        eventType: 'PRIVATE_BALANCE_CHANGE_NOTIFICATION',
        providerTimestampMs: null,
        pair: null,
        payload,
      });
    } catch {
      this.#invalidEventCount++;
      if (this.#invalidEventCount > this.#degradedErrorThreshold && this.#state !== 'RECONCILIATION_REQUIRED') {
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

  #scheduleReconnect(generation: number): void {
    if (generation !== this.#generationId || this.#isStopped) {
      return;
    }

    if (this.#reconnectToken !== null) {
      if (this.#reconnectToken.generation === generation) {
        return;
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
      this.#ensureConnected().catch(() => {});
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
          module: 'coindcx:private-stream',
          generationId: envelope.generationId,
          category: 'DOWNSTREAM_HANDLER_ERROR',
          eventType: envelope.eventType,
          msg: 'Downstream private subscriber threw an error',
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

  public stop(): void {
    this.#isStopped = true;
    this.#generationId++;
    this.#cleanupConnectTimeout();
    this.#cleanupReconnectTimer();
    this.#cleanupPing();
    this.#cleanupOldSocket();
    this.#connectionAttempt = null;
    this.#authJoinSent = false;
    this.#state = 'STOPPED';
  }

  public getHealthSnapshot(): PrivateStreamHealthSnapshot {
    return Object.freeze({
      state: this.#state,
      generationId: this.#generationId,
      reconnectAttempt: this.#reconnectAttempt,
      connected: this.connected,
      authJoinSent: this.#authJoinSent,
      lastEventReceivedAtMs: this.#lastEventReceivedAtMs,
      invalidEventCount: this.#invalidEventCount,
      staleGenerationDropCount: this.#staleGenerationDropCount,
      reconnectCount: this.#reconnectCount,
      reconciliationRequired: this.#reconciliationRequired,
    });
  }

  public getMetrics(): Readonly<Record<string, number>> {
    return Object.freeze({
      connectionsTotal: this.#connectionsTotal,
      disconnectsTotal: this.#disconnectsTotal,
      reconnectsTotal: this.#reconnectCount,
      validNotificationsTotal: this.#validNotificationsTotal,
      invalidNotificationsTotal: this.#invalidEventCount,
      staleGenerationDropsTotal: this.#staleGenerationDropCount,
      reconciliationRequiredTotal: this.#reconciliationRequired ? 1 : 0,
    });
  }
}
