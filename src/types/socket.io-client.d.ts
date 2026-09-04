declare module 'socket.io-client' {
  export interface ConnectOptions {
    transports?: string[];
    reconnection?: boolean;
    autoConnect?: boolean;
    timeout?: number;
    [key: string]: unknown;
  }

  export interface Socket {
    connect(): Socket;
    disconnect(): Socket;
    close(): Socket;
    on(event: string, fn: (...args: unknown[]) => void): Socket;
    off(event: string, fn?: (...args: unknown[]) => void): Socket;
    removeListener(event: string, fn?: (...args: unknown[]) => void): Socket;
    emit(event: string, ...args: unknown[]): Socket;
    connected: boolean;
    disconnected: boolean;
  }

  function io(uri?: string, opts?: ConnectOptions): Socket;
  export default io;
}

