import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CoinDcxTransport } from '../../../src/integration/coindcx/transport';
import { deferred } from './audit-a2-helpers';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function serverFor(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('Audit A2 full transport deadline', () => {
  it.each([false, true])('headers then stall (partial body=%s) times out and closes the socket', async partial => {
    const closed = deferred<void>();
    const baseUrl = await serverFor((_req, res) => {
      res.on('close', () => closed.resolve());
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders();
      if (partial) res.write('{"value":');
    });
    const transport = new CoinDcxTransport({ baseUrl, timeoutMs: 100 });
    await expect(transport.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' })).rejects.toMatchObject({ code: 'COINDCX_TIMEOUT' });
    await closed.promise;
  });

  it('normal completion before deadline survives its former timeout boundary', async () => {
    const baseUrl = await serverFor((_req, res) => res.end('{"ok":true}'));
    const transport = new CoinDcxTransport({ baseUrl, timeoutMs: 100 });
    let settlements = 0;
    expect((await transport.executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' }).then(value => { settlements++; return value; })).data).toEqual({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(settlements).toBe(1);
  });

  it('premature body close rejects instead of hanging', async () => {
    const baseUrl = await serverFor((_req, res) => { res.writeHead(200); res.write('{'); setImmediate(() => res.destroy()); });
    await expect(new CoinDcxTransport({ baseUrl, timeoutMs: 500 }).executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' })).rejects.toMatchObject({ code: 'COINDCX_PROVIDER_ERROR' });
  });

  it('body completion racing the deadline settles exactly once', async () => {
    const baseUrl = await serverFor((_req, res) => {
      res.writeHead(200); res.flushHeaders();
      const timer = setTimeout(() => res.end('{}'), 100);
      res.once('close', () => clearTimeout(timer));
    });
    let settlements = 0;
    const result = await new CoinDcxTransport({ baseUrl, timeoutMs: 100 }).executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' }).then(
      () => { settlements++; return 'SUCCESS'; }, error => { settlements++; return (error as { code: string }).code; });
    expect(['SUCCESS', 'COINDCX_TIMEOUT']).toContain(result);
    await new Promise(resolve => setTimeout(resolve, 120)); expect(settlements).toBe(1);
  });

  it('size-limit abort settles and cleans up the body socket', async () => {
    const closed = deferred<void>();
    const baseUrl = await serverFor((_req, res) => { res.once('close', () => closed.resolve()); res.write('123456789'); });
    await expect(new CoinDcxTransport({ baseUrl, timeoutMs: 500, maxResponseBytes: 4 }).executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' })).rejects.toMatchObject({ code: 'COINDCX_PROVIDER_ERROR' });
    await closed.promise;
  });
});
