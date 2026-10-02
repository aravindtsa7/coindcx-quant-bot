import io from 'socket.io-client';
import { EXACT_CANDLE_SOCKET_PARSER } from './candle-json';
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
      parser: EXACT_CANDLE_SOCKET_PARSER,
      forceNew: true, // Never reuse a manager created with a different decoding contract.
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

const OWNED_SOCKET_DESCRIPTORS = Object.getOwnPropertyDescriptors(ProductionCoinDcxSocket.prototype);
for (const descriptor of Object.values(OWNED_SOCKET_DESCRIPTORS)) for (const value of [descriptor.value, descriptor.get]) if (typeof value === 'function') Object.freeze(value);
function ownedSocket(endpoint: string, options?: CoinDcxSocketOptions): CoinDcxSocket {
  const socket = new ProductionCoinDcxSocket(endpoint, options);
  for (const [key, descriptor] of Object.entries(OWNED_SOCKET_DESCRIPTORS)) {
    if (key === 'constructor') continue;
    if (typeof descriptor.value === 'function') Object.defineProperty(socket, key, { value: Object.freeze(descriptor.value.bind(socket)), writable: false, configurable: false });
    else if (descriptor.get !== undefined) Object.defineProperty(socket, key, { get: Object.freeze(descriptor.get.bind(socket)), configurable: false });
  }
  return Object.freeze(socket);
}
/** No socket is created until the existing stream explicitly starts. */
export function createOwnedCoinDcxSocketFactory(): CoinDcxSocketFactory {
  const factory = new ProductionCoinDcxSocketFactory();
  Object.defineProperty(factory, 'createSocket', { value: Object.freeze(ownedSocket), writable: false, configurable: false });
  return Object.freeze(factory);
}
Object.freeze(createOwnedCoinDcxSocketFactory);
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  const descriptor = Object.getOwnPropertyDescriptor(module.exports, 'createOwnedCoinDcxSocketFactory');
  if (descriptor?.configurable === false) {
    if (descriptor.get === undefined || descriptor.set !== undefined || module.exports.createOwnedCoinDcxSocketFactory !== createOwnedCoinDcxSocketFactory) throw new Error('CREDENTIAL_CONSTRUCTION_EXPORT_INVALID');
  } else Object.defineProperty(module.exports, 'createOwnedCoinDcxSocketFactory', { get: () => createOwnedCoinDcxSocketFactory, configurable: false });
}
