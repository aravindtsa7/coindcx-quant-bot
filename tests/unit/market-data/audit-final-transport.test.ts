import http from 'node:http';
import { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoinDcxFuturesCandleRestReader } from '../../../src/market-data/rest-candle-reader';
import { CanonicalMarketDataEngine } from '../../../src/market-data/canonical-engine';
import { InMemoryCandleRepository } from './test-helpers';
import { P, T, deferred } from './audit-a1-helpers';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const query = { pair: P, fromMs: T, toMs: T };
const body = '{"s":"ok","data":[]}';

describe('A-F17 Phase 5 complete-operation deadline', () => {
  it.each([false, true])('headers/partial body stall settles and destroys resources: partial=%s', async partial => {
    const closed = deferred<void>();
    const baseUrl = await serve((_req, res) => {
      res.once('close', () => closed.resolve());
      res.writeHead(200); res.flushHeaders();
      if (partial) res.write('{"s":"ok",');
    });
    await expect(new CoinDcxFuturesCandleRestReader({ baseUrl, timeoutMs: 100 }).fetchClosedCandles(query)).rejects.toThrow(/timed out/);
    await closed.promise;
  });

  it('partial JSON followed by premature close rejects promptly', async () => {
    const baseUrl = await serve((_req, res) => { res.writeHead(200, { 'Content-Length': '1000' }); res.write('{'); setImmediate(() => res.destroy()); });
    const result = await new CoinDcxFuturesCandleRestReader({ baseUrl, timeoutMs: 1000 }).fetchClosedCandles(query).catch(error => error as Error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/aborted|closed|reset/i);
  });

  it('25ms trickle cannot extend the 100ms absolute deadline', async () => {
    const closed = deferred<void>();
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200); res.flushHeaders();
      const ticker = setInterval(() => res.write(' '), 25);
      const end = setTimeout(() => res.end(body), 1000);
      res.once('close', () => { clearInterval(ticker); clearTimeout(end); closed.resolve(); });
    });
    const start = performance.now();
    await expect(new CoinDcxFuturesCandleRestReader({ baseUrl, timeoutMs: 100 }).fetchClosedCandles(query)).rejects.toThrow(/timed out/);
    expect(performance.now() - start).toBeLessThan(800);
    await closed.promise;
  });

  it('normal response settles once and survives its former deadline', async () => {
    const baseUrl = await serve((_req, res) => res.end(body));
    let settlements = 0;
    const result = await new CoinDcxFuturesCandleRestReader({ baseUrl, timeoutMs: 200 }).fetchClosedCandles(query).then(value => { settlements++; return value; });
    expect(result).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 220));
    expect(settlements).toBe(1);
  });

  it.each([80, 100])('end near/racing 100ms deadline: server delay %i settles exactly once', async delay => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200); res.flushHeaders();
      const timer = setTimeout(() => res.end(body), delay);
      res.once('close', () => clearTimeout(timer));
    });
    let settlements = 0;
    const result = await new CoinDcxFuturesCandleRestReader({ baseUrl, timeoutMs: 100 }).fetchClosedCandles(query).then(
      () => { settlements++; return 'SUCCESS'; }, error => { settlements++; return (error as Error).message; });
    expect(result === 'SUCCESS' || /timed out|deadline/.test(result)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(settlements).toBe(1);
  });

  it('abort racing timeout settles once', async () => {
    const baseUrl = await serve((_req, res) => {
      res.write('{'); const timer = setTimeout(() => res.destroy(), 100);
      res.once('close', () => clearTimeout(timer));
    });
    await expect(new CoinDcxFuturesCandleRestReader({ baseUrl, timeoutMs: 100 }).fetchClosedCandles(query)).rejects.toThrow();
    await new Promise(resolve => setTimeout(resolve, 120));
  });

  it('connection reset before headers rejects', async () => {
    const baseUrl = await serve(req => req.socket.destroy());
    await expect(new CoinDcxFuturesCandleRestReader({ baseUrl, timeoutMs: 100 }).fetchClosedCandles(query)).rejects.toThrow();
  });

  it('canonical recovery receives failure, latches fault and never announces completion', async () => {
    const baseUrl = await serve((_req, res) => { res.write('{'); setImmediate(() => res.destroy()); });
    const engine = new CanonicalMarketDataEngine({ repository: new InMemoryCandleRepository(), restReader: new CoinDcxFuturesCandleRestReader({ baseUrl, timeoutMs: 100 }) });
    const events: string[] = []; engine.subscribe(event => events.push(event.eventType));
    try {
      await engine.initializePair(P);
      await engine.executeRecovery(P, T, T);
      expect(engine.getPairHealth(P)).toMatchObject({ state: 'RECOVERING', truthFault: 'RECOVERY_INCOMPLETE', recoveryRequired: true });
      expect(events).not.toContain('CANONICAL_1M_RECOVERY_COMPLETED');
    } finally { engine.stop(); }
  });

  it('normalization/settlement cannot accept a body delivered after the operation deadline', async () => {
    const reader = new CoinDcxFuturesCandleRestReader({ timeoutMs: 10, httpTransport: async () => {
      const start = performance.now(); while (performance.now() - start < 20) { /* synchronous delivery delay */ }
      return body;
    } });
    await expect(reader.fetchClosedCandles(query)).rejects.toThrow(/deadline/);
  });

  it('deadline is rechecked after synchronous parse/normalization before settlement', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(11);
    try {
      const reader = new CoinDcxFuturesCandleRestReader({ timeoutMs: 10, httpTransport: async () => body });
      await expect(reader.fetchClosedCandles(query)).rejects.toThrow(/deadline/);
    } finally { now.mockRestore(); }
  });
});
