import { Server } from 'http';
import { disconnectPrisma } from '../../persistence/prisma';
import { createChildLogger } from '../../monitoring/logger';

const log = createChildLogger('lifecycle:shutdown');

export interface ShutdownOptions {
  timeoutMs?: number;
}

export type ShutdownHook = () => Promise<void> | void;

export class GracefulShutdownManager {
  private isShuttingDown = false;
  private signalHandlersRegistered = false;
  private readonly hooks: ShutdownHook[] = [];
  private server: Server | null = null;
  private readonly timeoutMs: number;

  constructor(options: ShutdownOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  public setServer(server: Server): void {
    this.server = server;
  }

  public addHook(hook: ShutdownHook): void {
    this.hooks.push(hook);
  }

  public registerSignalHandlers(): void {
    if (this.signalHandlersRegistered) {
      return;
    }
    this.signalHandlersRegistered = true;

    const handleSignal = (signal: string) => {
      log.info({ signal }, `Received OS shutdown signal: ${signal}`);
      this.shutdown(signal).catch((err) => {
        log.error({ err: err instanceof Error ? err.message : err }, 'Error during shutdown');
        process.exit(1);
      });
    };

    process.once('SIGINT', () => handleSignal('SIGINT'));
    process.once('SIGTERM', () => handleSignal('SIGTERM'));
  }

  public async shutdown(reason = 'manual'): Promise<void> {
    if (this.isShuttingDown) {
      log.warn('Shutdown is already in progress, ignoring subsequent request');
      return;
    }

    this.isShuttingDown = true;
    log.info({ reason }, 'Commencing graceful system shutdown');

    const forceTimer = setTimeout(() => {
      log.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, this.timeoutMs);

    forceTimer.unref();

    // 1. Stop accepting new HTTP requests
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close((err) => {
          if (err) {
            log.error({ err: err.message }, 'Error while closing HTTP server');
          } else {
            log.info('HTTP server closed successfully');
          }
          resolve();
        });
      });
    }

    // 2. Execute custom shutdown hooks
    for (const hook of this.hooks) {
      try {
        await hook();
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : err }, 'Error executing shutdown hook');
      }
    }

    // 3. Disconnect database
    try {
      await disconnectPrisma();
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, 'Error disconnecting database');
    }

    clearTimeout(forceTimer);
    log.info('Graceful shutdown completed successfully');
  }

  /**
   * Reset internal shutdown state (used in testing).
   */
  public resetState(): void {
    this.isShuttingDown = false;
    this.server = null;
    this.hooks.length = 0;
  }
}

export const shutdownManager = new GracefulShutdownManager();
