import { describe, it, expect } from 'vitest';
import http from 'http';
import { startServer } from '../../src/app/bootstrap/server';
import { shutdownManager } from '../../src/app/lifecycle/shutdown';

describe('Server Startup Error Rejection', () => {
  it('deterministically rejects when target port is already occupied (EADDRINUSE)', async () => {
    // 1. Occupy an ephemeral local test port dynamically
    const occupyingServer = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('occupied');
    });

    await new Promise<void>((resolve) => {
      occupyingServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = occupyingServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to acquire address from test server');
    }

    const occupiedPort = address.port;

    let thrownError: unknown = null;

    try {
      // 2. Attempt to start the server on the exact same occupied port
      await startServer({
        port: occupiedPort,
        host: '127.0.0.1',
        env: {
          PORT: String(occupiedPort),
          DATABASE_URL: 'mysql://u:p@localhost:3306/db',
          LOG_LEVEL: 'fatal',
        },
      });
    } catch (err) {
      thrownError = err;
    } finally {
      // 4. Clean up and release the occupying port
      await new Promise<void>((resolve) => {
        occupyingServer.close(() => resolve());
      });
      shutdownManager.resetState();
    }

    // 3. Prove startup rejected with EADDRINUSE
    expect(thrownError).toBeDefined();
    expect((thrownError as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
  });
});
