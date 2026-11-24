import fs from 'node:fs';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBotReadBudget } from '../../../../scripts/run-coindcx-bot';
import { RateLimitCoordinator } from '../../../../src/integration/coindcx/rate-limit/runtime/coordinator';

afterEach(() => { vi.restoreAllMocks(); });

describe('practical bot CLI limiter lifecycle', () => {
  it('shares a real coordinator across API and public permits, drains them, and removes its directory and pipe', async () => {
    const runtime = await startBotReadBudget();
    expect(runtime.apiReadBudget.scope).toBe('API_AUTH');
    expect(runtime.publicReadBudget.scope).toBe('PUBLIC');
    expect(runtime.apiReadBudget.budget).toBe(runtime.publicReadBudget.budget);
    expect(fs.existsSync(runtime.stateDirectory)).toBe(true);
    try {
      for (const binding of [runtime.apiReadBudget, runtime.publicReadBudget]) {
        const acquired = await binding.budget.acquire({ scope: binding.scope, lifetimeMs: 1000 });
        expect(acquired.kind).toBe('GRANTED');
        if (acquired.kind !== 'GRANTED') throw new Error('PERMIT_EXPECTED');
        const create = vi.fn(() => 'local-read-started');
        expect(acquired.permit.start(create)).toEqual({ kind: 'STARTED', value: 'local-read-started' });
        expect(create).toHaveBeenCalledOnce();
        acquired.permit.complete();
      }
    } finally { await runtime.close(); }
    await runtime.close(); // Shutdown is safe to call more than once.
    expect(fs.existsSync(runtime.stateDirectory)).toBe(false);
    const server = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(runtime.pipePath, resolve); });
    } finally { await new Promise<void>(resolve => { server.close(() => { resolve(); }); }); }
  }, 10_000);

  it('cleans the exclusively created directory when coordinator startup refuses', async () => {
    let stateDirectory: string | undefined;
    vi.spyOn(RateLimitCoordinator, 'start').mockImplementation(async config => {
      stateDirectory = config.stateDirectory;
      expect(fs.existsSync(stateDirectory)).toBe(true);
      return { kind: 'FAIL_CLOSED', reason: 'SYNTHETIC_STARTUP_REFUSAL' };
    });
    await expect(startBotReadBudget()).rejects.toThrow('BOT_LIMITER_START_FAILED');
    expect(stateDirectory).toBeDefined();
    expect(fs.existsSync(stateDirectory!)).toBe(false);
  });
});
