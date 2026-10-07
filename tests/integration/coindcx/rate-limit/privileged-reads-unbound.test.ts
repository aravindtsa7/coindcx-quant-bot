import https from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireProductionInstrumentBinding } from '../../../../src/integration/coindcx/instrument-authority';
import { CoinDcxPaperEvidence, createProductionPaperEvidenceProvider } from '../../../../src/integration/coindcx/paper-evidence';
import { productionReadBudget } from '../../../../src/integration/coindcx/rate-limit/runtime/read-budget';
import { createOwnedCoinDcxReadTransport } from '../../../../src/integration/coindcx/transport';

// M2 W3: with NO production read budget bound in this process, every owned/privileged read refuses before any HTTP.
// `https.request` is replaced by a function that fails the test if it is ever called (no network is possible).
// This file never binds a budget (the binding is set-once per process; Vitest isolates test files).
let httpsCalls = 0;
afterEach(() => { vi.restoreAllMocks(); });
function forbidNetwork(): void {
  httpsCalls = 0;
  vi.spyOn(https, 'request').mockImplementation((() => { httpsCalls += 1; throw new Error('network must not be reached'); }) as never);
}
const refusal = { statusCode: 503, details: { readBudget: 'REFUSED', reason: 'PRODUCTION_READ_BUDGET_UNBOUND' } };
const INSTRUMENTS = [{ pair: 'B-BTC_USDT', underlying: 'BTC', quoteCurrency: 'USDT', instrumentSpecSnapshotId: 'btc-spec-v1' }];

describe('M2 W3 unbound production read budget: explicit refusal, zero HTTP requests', () => {
  it('the production read budget starts unbound', () => { expect(productionReadBudget()).toBeNull(); });

  it('privileged instrument acquisition refuses (signature unchanged: pair only)', async () => {
    forbidNetwork();
    expect(acquireProductionInstrumentBinding.length).toBe(1);
    await expect(acquireProductionInstrumentBinding('B-BTC_USDT')).rejects.toMatchObject(refusal);
    expect(httpsCalls).toBe(0);
  });

  it('the production paper-evidence privileged GET refuses', async () => {
    forbidNetwork();
    const provider = createProductionPaperEvidenceProvider({ instruments: INSTRUMENTS });
    await expect(provider.readConversion()).rejects.toMatchObject(refusal);
    await expect(provider.readOrderbookBootstrap('B-BTC_USDT')).rejects.toMatchObject(refusal);
    expect(httpsCalls).toBe(0);
  });

  it("an owned read transport and a public provider's default transports refuse", async () => {
    forbidNetwork();
    await expect(createOwnedCoinDcxReadTransport({}).executeRead({ endpoint: 'ACTIVE_INSTRUMENTS' })).rejects.toMatchObject(refusal);
    await expect(new CoinDcxPaperEvidence({ instruments: INSTRUMENTS }).readMarkBootstrap()).rejects.toMatchObject(refusal);
    expect(httpsCalls).toBe(0);
  });
});
