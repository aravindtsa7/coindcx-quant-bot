import io from 'socket.io-client';
import {
  CoinDcxSocket,
  CoinDcxSocketFactory,
  CoinDcxSocketOptions,
  SocketEventListener,
} from './types';

export const COINDCX_DEFAULT_SOCKET_ENDPOINT = 'wss://stream.coindcx.com';

interface RawSocketIoClient {
  connect(): void;
  disconnect(): void;
  close(): void;
  on(event: string, fn: (...args: unknown[]) => void): void;
  off(event: string, fn: (...args: unknown[]) => void): void;
  removeListener(event: string, fn: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  connected?: boolean;
}

/**
 * Production adapter wrapping socket.io-client 2.4.0.
 *
 * CRITICAL CONFIGURATION:
 * - transports: ['websocket'] (forces native WebSocket transport)
 * - reconnection: false (disables Socket.IO automatic reconnection; application owns lifecycle)
 * - autoConnect: false (ensures explicit start and generation isolation)
 */
export class ProductionCoinDcxSocket implements CoinDcxSocket {
  private readonly rawSocket: RawSocketIoClient;

  constructor(endpoint: string = COINDCX_DEFAULT_SOCKET_ENDPOINT, options?: CoinDcxSocketOptions) {
    const finalOptions: Record<string, unknown> = {
      transports: ['websocket'],
      reconnection: false,
      autoConnect: false,
      ...options,
    };

    const ioFactory = io as unknown as (url: string, opts: unknown) => RawSocketIoClient;
    this.rawSocket = ioFactory(endpoint, finalOptions);
  }

  public connect(): void {
    this.rawSocket.connect();
  }

  public disconnect(): void {
    this.rawSocket.disconnect();
  }

  public on(event: string, listener: SocketEventListener): void {
    this.rawSocket.on(event, listener);
  }

  public off(event: string, listener: SocketEventListener): void {
    this.rawSocket.off(event, listener);
  }

  public emit(event: string, ...args: unknown[]): void {
    this.rawSocket.emit(event, ...args);
  }

  public get connected(): boolean {
    return Boolean(this.rawSocket.connected);
  }

  /**
   * Internal/testing access to the wrapped socket.io client.
   */
  public getRawSocketForTesting(): RawSocketIoClient {
    return this.rawSocket;
  }
}

export class ProductionCoinDcxSocketFactory implements CoinDcxSocketFactory {
  public createSocket(
    endpoint: string = COINDCX_DEFAULT_SOCKET_ENDPOINT,
    options?: CoinDcxSocketOptions
  ): CoinDcxSocket {
    return new ProductionCoinDcxSocket(endpoint, options);
  }
}

/**
 * In-memory test double implementing CoinDcxSocket for zero-network deterministic testing.
 */
export class FakeCoinDcxSocket implements CoinDcxSocket {
  public connected = false;
  public disconnectCalls = 0;
  public readonly listeners = new Map<string, Set<SocketEventListener>>();
  public readonly emitted: Array<{ event: string; args: unknown[] }> = [];
  public autoConnectSynchronously = true;

  public connect(): void {
    if (this.autoConnectSynchronously) {
      this.connected = true;
      this.trigger('connect');
    }
  }

  public disconnect(): void {
    this.disconnectCalls++;
    if (this.connected) {
      this.connected = false;
      this.trigger('disconnect', 'io client disconnect');
    }
  }

  public on(event: string, listener: SocketEventListener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set<SocketEventListener>();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  public off(event: string, listener: SocketEventListener): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  public emit(event: string, ...args: unknown[]): void {
    this.emitted.push({ event, args });
  }

  public trigger(event: string, ...args: unknown[]): void {
    if (event === 'connect') {
      this.connected = true;
    } else if (event === 'disconnect') {
      this.connected = false;
    }
    const set = this.listeners.get(event);
    if (set) {
      // Clone set to avoid mutations during iteration
      const listeners = Array.from(set);
      for (const listener of listeners) {
        listener(...args);
      }
    }
  }

  public getListenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  public getTotalListenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) {
      total += set.size;
    }
    return total;
  }
}

export class FakeCoinDcxSocketFactory implements CoinDcxSocketFactory {
  public autoConnectSynchronously = true;
  public readonly createdSockets: FakeCoinDcxSocket[] = [];

  public createSocket(): FakeCoinDcxSocket {
    const socket = new FakeCoinDcxSocket();
    socket.autoConnectSynchronously = this.autoConnectSynchronously;
    this.createdSockets.push(socket);
    return socket;
  }

  public get latestSocket(): FakeCoinDcxSocket | undefined {
    return this.createdSockets[this.createdSockets.length - 1];
  }
}
