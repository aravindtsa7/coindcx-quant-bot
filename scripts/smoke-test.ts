/**
 * Self-contained health endpoint smoke test.
 * Starts an HTTP instance on a free port, sends GET /health, verifies payload, and shuts down cleanly.
 */
import http from 'http';
import { createApp } from '../src/api/app';

async function runSmokeTest(): Promise<void> {
  const app = createApp();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to obtain server address');
  }

  const port = address.port;
  console.log(`[SMOKE-TEST] Server listening on http://127.0.0.1:${port}`);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const status = response.status;
    const body = (await response.json()) as { status: string; service: string };

    console.log(`[SMOKE-TEST] Response HTTP ${status}:`, JSON.stringify(body));

    if (status !== 200) {
      throw new Error(`Expected HTTP 200, got ${status}`);
    }

    if (body.status !== 'ok' || body.service !== 'coindcx-quant-bot') {
      throw new Error(`Unexpected payload: ${JSON.stringify(body)}`);
    }

    console.log('[SMOKE-TEST] PASSED: Health endpoint returned valid structured response.');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    console.log('[SMOKE-TEST] Server closed cleanly.');
  }
}

runSmokeTest().catch((err) => {
  console.error('[SMOKE-TEST] FAILED:', err);
  process.exit(1);
});

