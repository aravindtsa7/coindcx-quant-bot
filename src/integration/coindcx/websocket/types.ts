import { Decimal } from '../../../core/decimal/decimal';

export type SocketEventListener = (...args: unknown[]) => void;

/**
 * Narrow boundary interface wrapping socket.io-client.
 */
export interface CoinDcxSocket {
  connect(): void;
  disconnect(): void;
  on(event: string, listener: SocketEventListener): void;
  off(event: string, listener: SocketEventListener): void;
  emit(event: string, ...args: unknown[]): void;
  readonly connected: boolean;
}

export interface CoinDcxSocketOptions {
  transports?: string[];
  reconnection?: boolean;
  autoConnect?: boolean;
  timeout?: number;
  [key: string]: unknown;
}

export interface CoinDcxSocketFactory {
  createSocket(endpoint: string, options?: CoinDcxSocketOptions): CoinDcxSocket;
}

export type CoinDcxStreamSource = 'COINDCX';

export type CoinDcxStreamType = 'PUBLIC_FUTURES' | 'PRIVATE_ACCOUNT';

export type CoinDcxStreamEventType =
  | 'PUBLIC_CANDLE_UPDATE'
  | 'PUBLIC_TRADE'
  | 'PRIVATE_POSITION_UPDATE_NOTIFICATION'
  | 'PRIVATE_ORDER_UPDATE_NOTIFICATION'
  | 'PRIVATE_BALANCE_CHANGE_NOTIFICATION'
  | 'PUBLIC_STREAM_CONNECTED'
  | 'PUBLIC_STREAM_DISCONNECTED'
  | 'PUBLIC_STREAM_RECOVERY_REQUIRED'
  | 'PRIVATE_STREAM_CONNECTED'
  | 'PRIVATE_STREAM_DISCONNECTED'
  | 'PRIVATE_RECONCILIATION_REQUIRED';

/**
 * Generic internal stream event envelope.
 * Sequence numbers are local and monotonically increment within each generation.
 */
export interface CoinDcxStreamEnvelope<T> {
  readonly source: 'COINDCX';
  readonly stream: CoinDcxStreamType;
  readonly generationId: number;
  readonly sequence: number;
  readonly receivedAtMs: number;
  readonly eventType: CoinDcxStreamEventType;
  readonly providerTimestampMs: number | null;
  readonly pair: string | null;
  readonly payload: T;
}

export interface PublicCandleUpdatePayload {
  readonly pair: string;
  readonly duration: '1m';
  readonly open: Decimal;
  readonly high: Decimal;
  readonly low: Decimal;
  readonly close: Decimal;
  readonly volume: Decimal;
  readonly quoteVolume: Decimal | null;
  readonly openTimeMs: number;
  readonly closeTimeMs: number;
  readonly providerEventTimeMs: number;
  readonly isClosed: false; // Invariant 18: Phase 4 never marks candle closed
  readonly rawChannel: string;
}

export interface PublicTradePayload {
  readonly pair: string;
  readonly price: Decimal;
  readonly quantity: Decimal;
  readonly isMaker: boolean;
  readonly tradeTimeMs: number;
  readonly product: string;
}

export interface PrivatePositionRecord {
  readonly id: string;
  readonly pair: string;
  readonly activePosition: Decimal;
  readonly avgPrice: Decimal;
  readonly liquidationPrice: Decimal;
  readonly lockedMargin: Decimal;
  readonly leverage: number;
  readonly markPrice: Decimal | null;
  readonly maintenanceMargin: Decimal | null;
  readonly updatedAtMs: number;
  readonly marginType: string;
  readonly marginCurrency: 'INR';
  readonly settlementCurrencyAvgPrice: Decimal | null;
}

export interface PrivatePositionNotificationPayload {
  readonly positions: readonly PrivatePositionRecord[];
  readonly droppedNonInrCount: number;
}

export interface PrivateOrderRecord {
  readonly id: string;
  readonly pair: string;
  readonly side: 'buy' | 'sell';
  readonly status: string;
  readonly orderType: string;
  readonly leverage: number;
  readonly price: Decimal;
  readonly avgPrice: Decimal;
  readonly totalQuantity: Decimal;
  readonly remainingQuantity: Decimal;
  readonly cancelledQuantity: Decimal;
  readonly feeAmount: Decimal;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly marginCurrency: 'INR';
}

export interface PrivateOrderNotificationPayload {
  readonly orders: readonly PrivateOrderRecord[];
  readonly droppedNonInrCount: number;
}

export interface PrivateBalanceRecord {
  readonly id: string;
  readonly balance: Decimal;
  readonly lockedBalance: Decimal;
  readonly currencyShortName: string;
}

export interface PrivateBalanceNotificationPayload {
  readonly balances: readonly PrivateBalanceRecord[];
}

export interface StreamLifecyclePayload {
  readonly reason?: string;
  readonly generationId: number;
  readonly reconnectAttempt?: number;
}

export interface PublicRecoveryRequiredPayload {
  readonly previousGeneration: number;
  readonly newGeneration: number;
  readonly disconnectReceivedAtMs: number;
  readonly reconnectedAtMs: number;
  readonly lastValidProviderTimestampByPair: Readonly<Record<string, number>>;
}

export interface PrivateReconciliationRequiredPayload {
  readonly previousGeneration: number;
  readonly newGeneration: number;
  readonly disconnectReceivedAtMs: number;
  readonly reconnectedAtMs: number;
}

export type PublicStreamState =
  | 'STOPPED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'SUBSCRIBING'
  | 'STREAMING'
  | 'DEGRADED'
  | 'RECONNECT_WAIT'
  | 'RECOVERY_REQUIRED';

export type PrivateStreamState =
  | 'STOPPED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'AUTH_JOIN_SENT'
  | 'RECONNECT_WAIT'
  | 'RECONCILIATION_REQUIRED'
  | 'DEGRADED';

export interface PublicStreamHealthSnapshot {
  readonly state: PublicStreamState;
  readonly generationId: number;
  readonly reconnectAttempt: number;
  readonly connected: boolean;
  readonly intendedSubscriptionCount: number;
  readonly activeSubscriptionCount: number;
  readonly lastValidEventReceivedAtMs: number | null;
  readonly invalidEventCount: number;
  readonly staleGenerationDropCount: number;
  readonly unexpectedChannelEventCount: number;
  readonly reconnectCount: number;
  readonly recoveryRequired: boolean;
}

export interface PrivateStreamHealthSnapshot {
  readonly state: PrivateStreamState;
  readonly generationId: number;
  readonly reconnectAttempt: number;
  readonly connected: boolean;
  readonly authJoinSent: boolean;
  readonly lastEventReceivedAtMs: number | null;
  readonly invalidEventCount: number;
  readonly staleGenerationDropCount: number;
  readonly reconnectCount: number;
  readonly reconciliationRequired: boolean;
}

export type StreamEventListener<T = unknown> = (envelope: CoinDcxStreamEnvelope<T>) => void;

export type DisconnectReasonCategory =
  | 'SERVER_DISCONNECT'
  | 'CLIENT_DISCONNECT'
  | 'PING_TIMEOUT'
  | 'TRANSPORT_CLOSE'
  | 'TRANSPORT_ERROR'
  | 'UNKNOWN_DISCONNECT_REASON';

export function categorizeDisconnectReason(rawReason: unknown): DisconnectReasonCategory {
  if (typeof rawReason !== 'string') {
    return 'UNKNOWN_DISCONNECT_REASON';
  }
  switch (rawReason) {
    case 'io server disconnect':
      return 'SERVER_DISCONNECT';
    case 'io client disconnect':
      return 'CLIENT_DISCONNECT';
    case 'ping timeout':
      return 'PING_TIMEOUT';
    case 'transport close':
      return 'TRANSPORT_CLOSE';
    case 'transport error':
      return 'TRANSPORT_ERROR';
    default:
      return 'UNKNOWN_DISCONNECT_REASON';
  }
}
