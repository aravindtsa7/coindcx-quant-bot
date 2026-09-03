import http from 'node:http';
import { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoinDcxClient } from '../../../src/integration/coindcx/client';
import { CoinDcxTransport } from '../../../src/integration/coindcx/transport';

describe('CoinDCX Read-Only Boundary & Non-Mutation Proof', () => {
  let server: http.Server;
  let serverUrl: string;
  let serverReceivedPaths: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      serverReceivedPaths.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        serverUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  const PROHIBITED_MUTATING_METHOD_NAMES = [
    'createOrder',
    'cancelOrder',
    'cancelAllOrders',
    'cancelAll',
    'editOrder',
    'updateLeverage',
    'changeMarginType',
    'addMargin',
    'removeMargin',
    'exitPosition',
    'quickExit',
    'createTpSl',
    'modifyTpSl',
    'transferWallet',
    'walletTransfer',
    'placeOrder',
  ];

  const PROHIBITED_MUTATING_ENDPOINT_SNIPPETS = [
    '/orders/create',
    '/orders/cancel',
    '/orders/cancel_all',
    '/orders/cancel_multiple',
    '/orders/edit',
    '/positions/update_leverage',
    '/positions/add_margin',
    '/positions/remove_margin',
    '/positions/exit',
    '/positions/create_tpsl',
    '/wallets/transfer',
    '/positions/change_margin_type',
  ];

  it('proves no mutable endpoint collections are exported from transport or index', async () => {
    const transportModule = await import('../../../src/integration/coindcx/transport');
    const indexModule = await import('../../../src/integration/coindcx/index');

    expect((transportModule as Record<string, unknown>)['READ_ONLY_ENDPOINT_ALLOWLIST']).toBeUndefined();
    expect((transportModule as Record<string, unknown>)['READ_ENDPOINT_DEFINITIONS']).toBeUndefined();
    expect((indexModule as Record<string, unknown>)['READ_ONLY_ENDPOINT_ALLOWLIST']).toBeUndefined();
    expect((indexModule as Record<string, unknown>)['READ_ENDPOINT_DEFINITIONS']).toBeUndefined();
  });

  it('proves generic arbitrary path is NOT publicly callable and /orders/create cannot reach fake server', async () => {
    const transport = new CoinDcxTransport({ baseUrl: serverUrl });
    serverReceivedPaths = [];

    // Attempting to invoke an arbitrary or mutating route
    const arbitraryCaller = transport as unknown as {
      executeRead: (opts: unknown) => Promise<unknown>;
      request?: unknown;
    };

    expect(arbitraryCaller.request).toBeUndefined();

    await expect(
      arbitraryCaller.executeRead({
        endpoint: 'POST /exchange/v1/derivatives/futures/orders/create',
      })
    ).rejects.toThrow();

    await expect(
      arbitraryCaller.executeRead({
        endpoint: '/orders/create',
      })
    ).rejects.toThrow();

    // Verify zero requests reached the server
    expect(serverReceivedPaths).toHaveLength(0);
  });

  it('proves no mutating methods exist on CoinDcxClient prototype', () => {
    const prototypeProps = Object.getOwnPropertyNames(CoinDcxClient.prototype);

    for (const prohibited of PROHIBITED_MUTATING_METHOD_NAMES) {
      expect(
        prototypeProps,
        `Prohibited mutation method '${prohibited}' must not exist on CoinDcxClient`
      ).not.toContain(prohibited);
    }
  });

  it('proves all public methods on CoinDcxClient are read operations (list/get/find)', () => {
    const prototypeProps = Object.getOwnPropertyNames(CoinDcxClient.prototype).filter(
      (prop) =>
        prop !== 'constructor' &&
        typeof (CoinDcxClient.prototype as unknown as Record<string, unknown>)[prop] === 'function'
    );

    const allowedPrefixes = ['list', 'get', 'find'];

    for (const methodName of prototypeProps) {
      const startsWithAllowed = allowedPrefixes.some((prefix) => methodName.startsWith(prefix));
      expect(
        startsWithAllowed,
        `Method '${methodName}' violates read-only naming convention`
      ).toBe(true);
    }
  });

  it('proves source code in src/integration/coindcx contains zero active mutating API routes', () => {
    const dirPath = path.resolve(__dirname, '../../../src/integration/coindcx');
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const content = fs.readFileSync(path.join(dirPath, file), 'utf8');

      for (const snippet of PROHIBITED_MUTATING_ENDPOINT_SNIPPETS) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!.trim();
          if (line.startsWith('//') || line.startsWith('*')) {
            continue;
          }
          expect(
            line.includes(`"${snippet}"`) || line.includes(`'${snippet}'`),
            `File ${file}:${i + 1} contains active mutating route string ${snippet}`
          ).toBe(false);
        }
      }
    }
  });
});
