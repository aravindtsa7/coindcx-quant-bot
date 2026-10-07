import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeModuleReferences, listSourceFiles } from './support/import-graph';

// M2 W3 REST-limiter coverage. Scope: actual provider HTTP request sites in src/ (a call of `<module>.request(` in a
// module that imports node:http/node:https). Local named-pipe IPC (node:net, the limiter runtime) and the local HTTP
// server (createServer) are distinguished and are not request sites. WebSocket transports are not REST and are out
// of scope for this limiter.
//
// Covered in W3: the three read primitives. Pending (explicit, allowlisted): the order-mutation transport (W4) and the
// candle-reader primitive (W5). Final no-bypass completion is NOT claimed until the pending list is empty.
const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const rel = (abs: string): string => path.relative(REPO_ROOT, abs).split(path.sep).join('/');
const code = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const files = listSourceFiles(SRC_ROOT).map(rel).sort();
const importsOf = (file: string): readonly string[] => analyzeModuleReferences(readFileSync(path.join(REPO_ROOT, file), 'utf8'), file).specifiers;
const REQUEST_SITE = /\b[A-Za-z]+\.request\(/g;

const COVERED = ['src/integration/coindcx/instrument-authority.ts', 'src/integration/coindcx/paper-evidence.ts', 'src/integration/coindcx/transport.ts'];
const PENDING: Readonly<Record<string, 'W4' | 'W5'>> = {
  'src/integration/coindcx/live/mutation-transport.ts': 'W4',
  'src/market-data/rest-candle-reader.ts': 'W5',
};
const LOCAL_HTTP_SERVER = ['src/app/bootstrap/server.ts', 'src/app/lifecycle/shutdown.ts'];
const LOCAL_PIPE_IPC = ['src/integration/coindcx/rate-limit/runtime/client.ts', 'src/integration/coindcx/rate-limit/runtime/coordinator.ts'];

const httpImporters = files.filter((file) => importsOf(file).some((s) => ['node:http', 'node:https', 'http', 'https'].includes(s)));
const requestSites = httpImporters.filter((file) => (code(file).match(REQUEST_SITE) ?? []).length > 0);

describe('M2 REST limiter coverage (W3)', () => {
  it('every provider HTTP request site is either covered or explicitly pending', () => {
    expect(requestSites).toEqual([...COVERED, ...Object.keys(PENDING)].sort());
  });

  it('modules importing node:http/https without a request site are only the local HTTP server', () => {
    expect(httpImporters.filter((file) => !requestSites.includes(file))).toEqual(LOCAL_HTTP_SERVER);
  });

  it('local named-pipe IPC is distinguished: only the limiter runtime imports node:net, and it imports no HTTP module', () => {
    const netImporters = files.filter((file) => importsOf(file).some((s) => s === 'node:net' || s === 'net'));
    expect(netImporters).toEqual(LOCAL_PIPE_IPC);
    for (const file of LOCAL_PIPE_IPC) expect(httpImporters).not.toContain(file);
  });

  it.each(COVERED)('%s: every request is created inside a read permit\'s synchronous start, after a permit acquisition', (file) => {
    const text = code(file);
    const sites = text.match(REQUEST_SITE) ?? [];
    const permitted = text.match(/\.start\(\(\) => [A-Za-z]+\.request\(/g) ?? [];
    expect(sites.length).toBeGreaterThan(0);
    expect(permitted.length).toBe(sites.length);
    expect(text).toMatch(/acquirePermit\(|acquireProductionPermit\(/);
    expect(text).toMatch(/permit\.complete\(\)/);
    expect(text).toMatch(/permit\.throttled\(/);
    expect(importsOf(file)).toContain('./rate-limit/runtime/read-budget');
  });

  it('pending primitives are still unpaced and are listed with the wave that will cover them (no final no-bypass claim)', () => {
    for (const [file, wave] of Object.entries(PENDING)) {
      expect((code(file).match(REQUEST_SITE) ?? []).length, `${file} (${wave})`).toBeGreaterThan(0);
      expect(importsOf(file).some((s) => s.includes('read-budget')), `${file} must flip to COVERED when integrated in ${wave}`).toBe(false);
    }
    expect(Object.keys(PENDING).length).toBeGreaterThan(0);
  });
});
