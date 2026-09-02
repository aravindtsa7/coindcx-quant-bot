import http, { Server } from 'http';
import { createApp } from '../../api/app';
import { loadConfig } from '../config/env';
import { shutdownManager } from '../lifecycle/shutdown';
import { createChildLogger } from '../../monitoring/logger';

const log = createChildLogger('bootstrap:server');

export interface ServerOptions {
  port?: number;
  host?: string;
  env?: Record<string, unknown>;
}

/**
 * Starts the application HTTP server with deterministic listen error handling.
 * If binding fails (e.g. EADDRINUSE), the returned promise is rejected cleanly.
 */
export async function startServer(options: ServerOptions = {}): Promise<Server> {
  // 1. Validate environment configuration
  const config = loadConfig(options.env ?? process.env);
  const targetPort = options.port ?? config.PORT;

  log.info(
    {
      nodeEnv: config.NODE_ENV,
      port: targetPort,
      logLevel: config.LOG_LEVEL,
      databaseUrlConfigured: Boolean(config.DATABASE_URL),
    },
    'Starting CoinDCX Quant Futures Bot'
  );

  // 2. Initialize API & explicit HTTP server
  const app = createApp();
  const server = http.createServer(app);

  // 3. Start HTTP server with deterministic error rejection
  return new Promise<Server>((resolve, reject) => {
    let listening = false;

    const onError = (err: Error) => {
      if (!listening) {
        server.removeListener('error', onError);
        server.removeListener('listening', onListening);
        log.error({ err: err.message, port: targetPort }, 'Failed to bind HTTP server to port');
        reject(err);
      }
    };

    const onListening = () => {
      listening = true;
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
      log.info(`HTTP service listening on port ${targetPort} [env: ${config.NODE_ENV}]`);
      shutdownManager.setServer(server);
      shutdownManager.registerSignalHandlers();
      resolve(server);
    };

    server.once('error', onError);
    server.once('listening', onListening);

    if (options.host) {
      server.listen(targetPort, options.host);
    } else {
      server.listen(targetPort);
    }
  });
}
