import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { credentialEnvironment, credentialPayload, credentialStorePath, loadSelectedCredentialSource, parseCredentialSource } from '../../../scripts/sync-read-launch/credential-store';
import { protectIpcKeys } from '../../../scripts/sync-read-launch/operator-local-secrets';
import { operatorEntry } from '../../../scripts/coindcx-sync-read-operator';

vi.mock('../../../scripts/sync-read-launch/operator-local-secrets', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../scripts/sync-read-launch/operator-local-secrets')>();
  return { ...actual, protectIpcKeys: vi.fn(actual.protectIpcKeys) };
});

describe('explicit protected credential source, synthetic values only', () => {
  it('accepts exactly two values and rejects extra settings and malformed payloads without echoing values', () => {
    const plain = credentialPayload('SYNTHETIC-KEY', 'SYNTHETIC-SECRET');
    expect(credentialEnvironment(plain)).toEqual({ COINDCX_CAMPAIGN_API_KEY: 'SYNTHETIC-KEY', COINDCX_CAMPAIGN_API_SECRET: 'SYNTHETIC-SECRET' });
    for (const value of ['{}', 'null', '[]', '{"apiKey":"SYNTHETIC","apiSecret":"SYNTHETIC","other":"forbidden"}', 'invalid']) {
      expect(() => credentialEnvironment(Buffer.from(value))).toThrow('PAYLOAD_INVALID');
    }
    expect(() => credentialPayload('', 'SYNTHETIC')).toThrow('TWO_LITERAL_VALUES_REQUIRED');
    expect(() => credentialPayload('SYNTHETIC\nKEY', 'SYNTHETIC')).toThrow('TWO_LITERAL_VALUES_REQUIRED');
    plain.fill(0);
  });
  it('roundtrips CurrentUser DPAPI and fails on malformed ciphertext', () => {
    const plain = credentialPayload('SYNTHETIC-KEY', 'SYNTHETIC-SECRET');
    try {
      const cipher = protectIpcKeys(plain.toString('base64'));
      expect(Buffer.from(cipher, 'base64').includes(plain)).toBe(false);
      const restored = Buffer.from(protectIpcKeys(cipher, true), 'base64');
      try { expect(credentialEnvironment(restored)).toEqual(credentialEnvironment(plain)); }
      finally { restored.fill(0); }
      expect(() => protectIpcKeys(Buffer.from('SYNTHETIC-NOT-DPAPI').toString('base64'), true)).toThrow('DPAPI_FAILED');
    } finally { plain.fill(0); }
  });
  it('requires an explicit source and never tries another source on custody or decryption failure', async () => {
    for (const value of [undefined, '', 'auto', 'fallback']) expect(() => parseCredentialSource(value)).toThrow('EXPLICIT_CREDENTIAL_SOURCE_REQUIRED');
    expect(parseCredentialSource('authorized-env-file')).toBe('authorized-env-file');
    expect(parseCredentialSource('protected-dpapi')).toBe('protected-dpapi');
    const read = fs.readFileSync.bind(fs), calls: string[] = [];
    const syntheticPlain = credentialPayload('SYNTHETIC-KEY', 'SYNTHETIC-SECRET');
    let bytes = Buffer.alloc(64, 1);
    const validCipher = Buffer.from(protectIpcKeys(syntheticPlain.toString('base64')), 'base64'); syntheticPlain.fill(0);
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
      const name = String(file); calls.push(name);
      if (name.endsWith('runtime-inventory.json')) return JSON.stringify({ powershell: { path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' } });
      if (name === credentialStorePath()) return bytes;
      return read(file, options);
    });
    const stat = vi.spyOn(fs, 'statSync').mockReturnValue({ size: 64 } as fs.Stats);
    const exec = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => { throw new Error('SIMULATED_WRONG_USER_CUSTODY'); });
    try {
      await expect(loadSelectedCredentialSource('protected-dpapi')).rejects.toThrow('CUSTODY_FAILED');
      expect(calls).not.toContain(credentialStorePath());
      exec.mockImplementation((_file, _args, options) => {
        if (options && 'input' in options) throw new Error('SIMULATED_FOREIGN_USER_DPAPI_FAILURE');
        return Buffer.from('');
      });
      vi.mocked(protectIpcKeys).mockImplementationOnce(() => { throw new Error('SIMULATED_FOREIGN_USER_DPAPI_FAILURE'); });
      await expect(loadSelectedCredentialSource('protected-dpapi')).rejects.toThrow('DECRYPTION_FAILED');
      expect(vi.mocked(protectIpcKeys).mock.results.at(-1)?.type).toBe('throw');
      expect(calls.some(file => file.endsWith('.env'))).toBe(false);
      exec.mockReturnValue(Buffer.from('')); bytes = validCipher;
      const decryptCalls = vi.mocked(protectIpcKeys).mock.calls.length;
      await expect(loadSelectedCredentialSource('protected-dpapi', '0'.repeat(64))).rejects.toThrow('DECRYPTION_FAILED');
      expect(vi.mocked(protectIpcKeys).mock.calls).toHaveLength(decryptCalls);
      const loaded = await loadSelectedCredentialSource('protected-dpapi', createHash('sha256').update(validCipher).digest('hex'));
      expect(loaded.environment).toEqual({ COINDCX_CAMPAIGN_API_KEY: 'SYNTHETIC-KEY', COINDCX_CAMPAIGN_API_SECRET: 'SYNTHETIC-SECRET' });
      expect(calls.some(file => file.endsWith('.env'))).toBe(false);
    } finally { exec.mockRestore(); stat.mockRestore(); spy.mockRestore(); }
  });
  it('defers all selected-source loading until input and independent authorization pass', async () => {
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      await expect(operatorEntry(['run-provider', '--ipc-key-file', path.resolve('absent.dpapi')])).rejects.toThrow('EXPLICIT_CREDENTIAL_SOURCE_REQUIRED');
      await expect(operatorEntry(['run-provider', '--ipc-key-file', path.resolve('absent.dpapi'), '--credential-source', 'protected-dpapi', '--input', path.resolve('docs/launch/m4-collection-input.pending.json')])).rejects.toThrow('ABSOLUTE_CAMPAIGN_JSON_INPUT_REQUIRED');
      expect(read.mock.calls.some(([file]) => String(file).endsWith('.env') || String(file).endsWith('.dpapi') || String(file).endsWith('runtime-inventory.json'))).toBe(false);
    } finally { read.mockRestore(); }
  });
  it('public provisioner accepts only concealed console input after custody and uses exclusive ciphertext creation', () => {
    const source = fs.readFileSync(path.resolve('scripts/sync-read-launch/provision-credentials.ps1'), 'utf8');
    expect(source.match(/Read-Host[^\r\n]+-AsSecureString/g)).toHaveLength(2);
    expect(source).toContain('[Console]::IsInputRedirected');
    expect(source).toContain('[IO.FileMode]::CreateNew');
    expect(source).toContain('[Security.Cryptography.DataProtectionScope]::CurrentUser');
    expect(source.indexOf('Assert-DiagnosticCustody $credentialDirectory', source.indexOf('\ntry {'))).toBeLessThan(source.indexOf("Read-Host 'CoinDCX API key"));
    expect(source).not.toMatch(/Set-Acl|SetAccessRule|Get-Content.*\.env|ReadAllText.*\.env|ConvertFrom-SecureString.*-Key/);
  });
});

function wireFixture(action = 'run-provider', throws = false) {
  const attempts: string[] = [], output: string[] = [];
  const https = { request: (url: URL, _options?: { method: string }) => { attempts.push(url.pathname); if (throws) throw new Error('SYNTHETIC_FACTORY_THROW'); return {}; }, get: () => ({}) };
  const http = { request: () => ({}), get: () => ({}) };
  const directory = path.resolve('scripts/sync-read-launch');
  const modules: Record<string, unknown> = { 'node:fs': fs, 'node:path': path, 'node:module': { _resolveFilename: (value: string) => value }, 'node:https': https, 'node:http': http };
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'protected-module-guard.cjs'), 'utf8'), {
    __dirname: directory, require: (name: string) => modules[name], URL,
    process: { argv: ['node', 'SYNTHETIC-entry', action], stdout: { write: (value: string) => output.push(value) } },
  });
  return { attempts, output, https, http, request: (endpoint: string) => https.request(new URL(`https://api.coindcx.com${endpoint}`), { method: 'POST' }) };
}
describe('native request creation ceiling and safe endpoint audit, no sockets', () => {
  const identity = '/exchange/v1/users/info', orders = '/exchange/v1/derivatives/futures/orders', positions = '/exchange/v1/derivatives/futures/positions';
  it('counts exactly 3/24/12 factory attempts and refuses a fortieth before factory creation', () => {
    const wire = wireFixture();
    expect(() => wire.request(orders)).toThrow('FORBIDDEN');
    for (let evaluation = 0; evaluation < 3; evaluation++) {
      wire.request(identity);
      for (let n = 0; n < 8; n++) wire.request(orders);
      for (let n = 0; n < 4; n++) wire.request(positions);
    }
    expect(wire.attempts).toHaveLength(39); expect(wire.output).toHaveLength(39);
    expect(JSON.parse(wire.output.at(-1)!)).toMatchObject({ attempt: 39, counts: { USER_INFO: 3, FUTURES_ORDERS: 24, FUTURES_POSITIONS: 12 } });
    expect(() => wire.request(identity)).toThrow('FORBIDDEN'); expect(wire.attempts).toHaveLength(39);
  });
  it('refuses alternate endpoints, origins, methods and all initialize/prepare HTTP before creation', () => {
    for (const action of ['prepare', 'initialize-campaign']) { const wire = wireFixture(action); expect(() => wire.request(identity)).toThrow('FORBIDDEN'); expect(wire.attempts).toHaveLength(0); }
    const wire = wireFixture();
    for (const url of ['https://example.invalid/exchange/v1/users/info', 'https://api.coindcx.com/exchange/v1/derivatives/futures/trades', 'https://api.coindcx.com/exchange/v1/users/info?extra=1']) {
      expect(() => wire.https.request(new URL(url), { method: 'POST' })).toThrow('FORBIDDEN');
    }
    expect(() => wire.https.request(new URL(`https://api.coindcx.com${identity}`), { method: 'GET' })).toThrow('FORBIDDEN');
    expect(() => wire.http.request()).toThrow('FORBIDDEN'); expect(() => wire.https.get()).toThrow('FORBIDDEN');
    expect(wire.attempts).toHaveLength(0);
  });
  it('counts a throwing native factory once and audits only endpoint/count/time fields', () => {
    const wire = wireFixture('run-provider', true);
    expect(() => wire.request(identity)).toThrow('SYNTHETIC_FACTORY_THROW');
    expect(wire.attempts).toHaveLength(1);
    expect(Object.keys(JSON.parse(wire.output[0]!)).sort()).toEqual(['attempt', 'counts', 'endpoint', 'outcome', 'recordedAt']);
  });
});
