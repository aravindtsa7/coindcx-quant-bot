import { EventEmitter } from 'node:events';
import https from 'node:https';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { acquireProductionInstrumentBinding, TrustedProductionInstrumentBinding } from '../../../../src/integration/coindcx/instrument-authority';
import { createProductionPaperEvidenceProvider } from '../../../../src/integration/coindcx/paper-evidence';
import { RateLimitClient } from '../../../../src/integration/coindcx/rate-limit/runtime/client';
import { RateLimitCoordinator } from '../../../../src/integration/coindcx/rate-limit/runtime/coordinator';
import { bindProductionReadBudget, createCoordinatorReadBudget } from '../../../../src/integration/coindcx/rate-limit/runtime/read-budget';
import { wire } from '../../../unit/coindcx/audit-a2-helpers';
import { cleanup, clientConfig, fixture, waitFor } from './support';

// M2 W3: the privileged production reads under a coordinator-backed production read budget (bound once for this
// process). `https.request` is intercepted below the authority boundary (no network). Fixture values only.
let coordinator: RateLimitCoordinator;
let client: RateLimitClient;
beforeAll(async () => {
  const f = fixture();
  const started = await RateLimitCoordinator.start(f.coordinator);
  if (started.kind !== 'RUNNING') throw new Error(JSON.stringify(started));
  coordinator = started.coordinator;
  client = new RateLimitClient(clientConfig(f.pipe));
  if (!(await client.connect())) throw new Error('client did not connect');
  bindProductionReadBudget(createCoordinatorReadBudget(client, { cls: 'P1', deadlineInMs: 500 }));
}, 30_000);
afterAll(async () => { client.close(); await coordinator.close(); cleanup(); });
afterEach(() => { vi.restoreAllMocks(); });

interface Reply { status: number; headers?: Record<string, string>; body: string }
function intercept(reply: (url: URL) => Reply): URL[] {
  const urls: URL[] = [];
  vi.spyOn(https, 'request').mockImplementation(((url: string | URL, _options: unknown, callback: (r: unknown) => void) => {
    const target = new URL(String(url));
    urls.push(target);
    const request = Object.assign(new EventEmitter(), { destroy: () => undefined, write: () => true });
    Object.assign(request, { end: () => setImmediate(() => {
      const r = reply(target);
      const response = Object.assign(new EventEmitter(), { statusCode: r.status, headers: r.headers ?? {}, destroy: () => undefined });
      callback(response);
      response.emit('data', Buffer.from(r.body));
      response.emit('end');
      setImmediate(() => request.emit('close')); // local teardown
    }) });
    return request;
  }) as never);
  return urls;
}

describe('M2 W3 privileged reads under the shared coordinator budget', () => {
  it('privileged instrument acquisition is accounted: STARTED at request creation, completion on teardown', async () => {
    const urls = intercept(() => ({ status: 200, body: JSON.stringify({ instrument: wire('BTC') }) }));
    const binding = await acquireProductionInstrumentBinding('B-BTC_USDT');
    expect(TrustedProductionInstrumentBinding.read(binding)?.pair).toBe('B-BTC_USDT');
    expect(urls.map((u) => u.origin)).toEqual(['https://api.coindcx.com']);
    await waitFor(() => coordinator.state.charges.length === 1 && coordinator.state.charges[0]!.started && !coordinator.state.charges[0]!.slotHeld, 5000, 'accounted');
    expect(coordinator.state.charges[0]!.scope).toBe('API_AUTH');
  }, 30_000);

  it('the production paper-evidence GET uses the PUBLIC scope for the public host and is accounted', async () => {
    const urls = intercept(() => ({ status: 200, body: JSON.stringify({ bids: {}, asks: {} }) }));
    const provider = createProductionPaperEvidenceProvider({ instruments: [{ pair: 'B-BTC_USDT', underlying: 'BTC', quoteCurrency: 'USDT', instrumentSpecSnapshotId: 'btc-spec-v1' }] });
    await provider.readOrderbookBootstrap('B-BTC_USDT').catch(() => undefined); // ingestion outcome is not under test
    expect(urls.map((u) => u.origin)).toEqual(['https://public.coindcx.com']);
    await waitFor(() => coordinator.state.charges.some((c) => c.scope === 'PUBLIC' && c.started && !c.slotHeld), 5000, 'public read accounted');
  }, 30_000);

  it('a privileged 429 keeps its error, blocks the shared budget, and the next privileged read is refused with no HTTP', async () => {
    const urls = intercept(() => ({ status: 429, headers: { 'retry-after': '30' }, body: '{}' }));
    await expect(acquireProductionInstrumentBinding('B-BTC_USDT')).rejects.toMatchObject({ code: 'COINDCX_PROVIDER_ERROR', statusCode: 429 });
    await waitFor(() => coordinator.state.scopes.API_AUTH.kind === 'BLOCKED' && coordinator.state.scopes.PUBLIC.kind === 'BLOCKED', 5000, 'shared block');
    await expect(acquireProductionInstrumentBinding('B-BTC_USDT')).rejects.toMatchObject({ statusCode: 503, details: { readBudget: 'REFUSED' } });
    expect(urls).toHaveLength(1);
    expect(() => bindProductionReadBudget(createCoordinatorReadBudget(client, { cls: 'P1', deadlineInMs: 500 }))).toThrow('PRODUCTION_READ_BUDGET_ALREADY_BOUND');
  }, 30_000);
});
