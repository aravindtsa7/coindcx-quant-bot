import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROBE_API_ORIGIN,
  READ_ONLY_PROVIDER_PROBE_ALLOWLIST,
  assertReadOnlyProbeRequest,
  assertReadOnlySocketEmit,
} from '../../../../scripts/provider-probe/allowlist';
import { ProbeReadClient, type ProbeReadExecutor } from '../../../../scripts/provider-probe/rest-probe';
import { PROBE_JOIN_SIGNED_BODY } from '../../../../scripts/provider-probe/ws-probe';
import { CANONICAL_AUTH_BODY } from '../../../../src/integration/coindcx/websocket/private-stream';

// No test here touches the network: every executor is an in-memory fake.

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function recordingExecutor(): ProbeReadExecutor & { calls: { endpoint: string; body: string }[] } {
  const calls: { endpoint: string; body: string }[] = [];
  return {
    calls,
    async executeRead(request) {
      calls.push({ endpoint: request.endpoint, body: request.body });
      return { status: 200, headers: {}, data: [] };
    },
  };
}

const MUTATION_ROUTES: readonly (readonly [string, string])[] = [
  ['POST', '/exchange/v1/derivatives/futures/orders/create'],
  ['POST', '/exchange/v1/derivatives/futures/orders/cancel'],
  ['POST', '/exchange/v1/derivatives/futures/orders/cancel_all'],
  ['POST', '/exchange/v1/derivatives/futures/orders/edit'],
  ['POST', '/exchange/v1/derivatives/futures/positions/exit'],
  ['POST', '/exchange/v1/derivatives/futures/positions/close'],
  ['POST', '/exchange/v1/derivatives/futures/positions/cancel_all_open_orders'],
  ['POST', '/exchange/v1/derivatives/futures/positions/create_tpsl'],
  ['POST', '/exchange/v1/derivatives/futures/positions/add_margin'],
  ['POST', '/exchange/v1/derivatives/futures/positions/remove_margin'],
  ['POST', '/exchange/v1/derivatives/futures/positions/update_leverage'],
  ['POST', '/exchange/v1/derivatives/futures/wallets/transfer'],
  ['POST', '/exchange/v1/orders/create'],
  ['POST', '/exchange/v1/orders/cancel'],
  ['POST', '/exchange/v1/orders/cancel_all'],
  ['POST', '/exchange/v1/orders/edit'],
  ['POST', '/exchange/v1/funding/withdraw'],
  ['POST', '/exchange/v1/wallets/transfer'],
  ['POST', '/exchange/v1/deposit/create'],
];

describe('[probe allowlist] mutation routes are rejected before any network I/O', () => {
  it.each(MUTATION_ROUTES)('%s %s is rejected', (method, route) => {
    expect(() => assertReadOnlyProbeRequest(method, `${PROBE_API_ORIGIN}${route}`)).toThrow(/PROBE_MUTATION_ROUTE_REJECTED/);
  });

  it('rejects any HFT host', () => {
    expect(() => assertReadOnlyProbeRequest('POST', 'https://hft-api.coindcx.com/exchange/v1/users/info')).toThrow(/PROBE_(MUTATION_ROUTE_REJECTED|ROUTE_NOT_ALLOWLISTED)/);
  });

  it('a mutation endpoint name cannot be smuggled through the client: the executor is never called', async () => {
    const executor = recordingExecutor();
    const client = new ProbeReadClient(executor);
    for (const name of ['CREATE_ORDER', 'CANCEL_ORDER', 'EXIT_POSITION', 'TRANSFER', '__proto__', 'constructor', 'toString']) {
      await expect(client.read(name as never)).rejects.toThrow(/PROBE_ROUTE_NOT_ALLOWLISTED/);
    }
    expect(executor.calls).toEqual([]);
  });
});

describe('[probe allowlist] unknown or tampered routes are rejected', () => {
  it.each([
    ['GET', `${PROBE_API_ORIGIN}/exchange/v1/users/balances`],
    ['POST', `${PROBE_API_ORIGIN}/exchange/v1/derivatives/futures/trades`],
    ['POST', `${PROBE_API_ORIGIN}/exchange/v1/users/info/`],
    ['GET', `${PROBE_API_ORIGIN}/exchange/v1/users/info`],
    ['POST', `${PROBE_API_ORIGIN}/exchange/v1/users/info?x=1`],
    ['POST', `${PROBE_API_ORIGIN}/exchange/v1/users/info#frag`],
    ['POST', 'http://api.coindcx.com/exchange/v1/users/info'],
    ['POST', 'https://api.coindcx.com.evil.test/exchange/v1/users/info'],
    ['POST', 'https://user:pass@api.coindcx.com/exchange/v1/users/info'],
    ['POST', 'not a url'],
  ])('%s %s is rejected', (method, url) => {
    expect(() => assertReadOnlyProbeRequest(method, url)).toThrow(/PROBE_/);
  });
});

describe('[probe allowlist] only the allowlisted reads pass', () => {
  it('allows exactly four read routes', () => {
    expect(Object.keys(READ_ONLY_PROVIDER_PROBE_ALLOWLIST).sort()).toEqual(['FUTURES_ORDERS', 'FUTURES_POSITIONS', 'FUTURES_WALLETS', 'USER_INFO']);
    for (const [endpoint, route] of Object.entries(READ_ONLY_PROVIDER_PROBE_ALLOWLIST)) {
      expect(assertReadOnlyProbeRequest(route.method, `${PROBE_API_ORIGIN}${route.path}`)).toBe(endpoint);
    }
  });

  it('every allowlisted route is byte-identical to a route in the Phase 2 read-only transport map', () => {
    const phase2 = readFileSync(path.join(REPO_ROOT, 'src/integration/coindcx/transport.ts'), 'utf8');
    for (const route of Object.values(READ_ONLY_PROVIDER_PROBE_ALLOWLIST)) {
      expect(phase2).toMatch(new RegExp(`method: '${route.method}',\\s*path: '${route.path.replace(/\//g, '\\/')}',\\s*auth: true`));
    }
  });

  it('cannot be extended at runtime', () => {
    expect(Object.isFrozen(READ_ONLY_PROVIDER_PROBE_ALLOWLIST)).toBe(true);
    expect(() => { (READ_ONLY_PROVIDER_PROBE_ALLOWLIST as Record<string, unknown>)['CREATE_ORDER'] = { method: 'POST', path: '/x' }; }).toThrow();
    expect(() => { (READ_ONLY_PROVIDER_PROBE_ALLOWLIST.USER_INFO as { path: string }).path = '/exchange/v1/derivatives/futures/orders/create'; }).toThrow();
  });

  it('builds fixed request bodies only; FUTURES_ORDERS requires a side', async () => {
    const executor = recordingExecutor();
    const client = new ProbeReadClient(executor, () => 1_700_000_000_000);
    await client.read('USER_INFO');
    await client.read('FUTURES_ORDERS', 'buy');
    await expect(client.read('FUTURES_ORDERS')).rejects.toThrow(/requires side/);
    expect(executor.calls.map((call) => JSON.parse(call.body) as unknown)).toEqual([
      { timestamp: 1_700_000_000_000 },
      { timestamp: 1_700_000_000_000, status: 'open,filled,partially_filled,partially_cancelled,cancelled,rejected,untriggered', side: 'buy', page: '1', size: '10', margin_currency_short_name: ['INR'] },
    ]);
  });
});

describe('[probe allowlist] the private socket may only emit the coindcx join', () => {
  it('signs exactly the production private-stream join body', () => {
    expect(PROBE_JOIN_SIGNED_BODY).toBe(CANONICAL_AUTH_BODY);
    expect(PROBE_JOIN_SIGNED_BODY).toBe('{"channel":"coindcx"}');
  });

  it('accepts the documented join', () => {
    expect(() => assertReadOnlySocketEmit('join', { channelName: 'coindcx', authSignature: 's', apiKey: 'k' })).not.toThrow();
  });

  it.each([
    ['leave', { channelName: 'coindcx' }],
    ['create-order', { pair: 'B-BTC_USDT' }],
    ['join', { channelName: 'B-BTC_USDT@trades', authSignature: 's', apiKey: 'k' }],
    ['join', { channelName: 'coindcx', authSignature: 's', apiKey: 'k', extra: 1 }],
    ['join', null],
    ['ping', { data: 'Ping message' }],
  ])('rejects %s', (event, payload) => {
    expect(() => assertReadOnlySocketEmit(event, payload)).toThrow(/PROBE_SOCKET_OPERATION_REJECTED/);
  });
});
