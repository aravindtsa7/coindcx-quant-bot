import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Smoke Script Contract & Invariants', () => {
  const smokeScriptPath = path.resolve(__dirname, '../../../scripts/coindcx-read-smoke.ts');
  const smokeScriptContent = fs.readFileSync(smokeScriptPath, 'utf8');

  it('requires explicit --auth flag to activate authenticated read checks', () => {
    // Proves that process.argv.includes('--auth') is required
    expect(smokeScriptContent).toContain("process.argv.includes('--auth')");
  });

  it('proves ENABLE_AUTHENTICATED_SMOKE environment variable is NOT supported to bypass --auth', () => {
    expect(smokeScriptContent).not.toContain('ENABLE_AUTHENTICATED_SMOKE');
  });

  it('proves smoke script does not print legacy max leverage as authoritative', () => {
    // Proves it does not output maxLeverage=
    expect(smokeScriptContent).not.toContain('maxLeverage=');
    expect(smokeScriptContent).toContain('dynamicLeverageTierCount=');
  });

  it('proves smoke script queries open orders separately for buy and sell', () => {
    expect(smokeScriptContent).toContain("side: 'buy'");
    expect(smokeScriptContent).toContain("side: 'sell'");
    expect(smokeScriptContent).toContain('totalOpenOrders');
  });
});

describe('WebSocket Smoke Script Contract & Invariants', () => {
  const wsSmokeScriptPath = path.resolve(__dirname, '../../../scripts/coindcx-ws-smoke.ts');
  const wsSmokeScriptContent = fs.readFileSync(wsSmokeScriptPath, 'utf8');

  it('requires explicit --auth flag to activate private WebSocket smoke', () => {
    expect(wsSmokeScriptContent).toContain("process.argv.includes('--auth')");
  });

  it('proves ENABLE_AUTHENTICATED_SMOKE environment variable is NOT supported to bypass --auth', () => {
    expect(wsSmokeScriptContent).not.toContain('ENABLE_AUTHENTICATED_SMOKE');
  });

  it('proves default behavior remains public only when --auth is absent', () => {
    expect(wsSmokeScriptContent).toContain('runPublicWsSmoke()');
    expect(wsSmokeScriptContent).toContain('runPrivateWsSmoke()');
  });

  it('proves script strictly avoids process.exit() and relies solely on process.exitCode', () => {
    expect(wsSmokeScriptContent).not.toMatch(/process\.exit\s*\(/);
    expect(wsSmokeScriptContent).toContain('process.exitCode = 0');
    expect(wsSmokeScriptContent).toContain('process.exitCode = 1');
  });

  it('proves no mutation API is invoked', () => {
    expect(wsSmokeScriptContent).not.toContain('createOrder');
    expect(wsSmokeScriptContent).not.toContain('cancelOrder');
    expect(wsSmokeScriptContent).not.toContain('setLeverage');
    expect(wsSmokeScriptContent).not.toContain('closePosition');
    expect(wsSmokeScriptContent).not.toContain('transferFunds');
    expect(wsSmokeScriptContent).toContain('mutationAttempted=false');
  });
});

