import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeModuleReferences, listSourceFiles } from './support/import-graph';

// M2 REST-limiter coverage. Scope: actual provider HTTP request sites in src/ (a call of `<module>.request(` in a
// module that imports node:http/node:https). Local named-pipe IPC (node:net, the limiter runtime) and the local HTTP
// server (createServer) are distinguished and are not request sites. WebSocket transports are not REST and are out
// of scope for this limiter.
//
// Covered in W3: the three read primitives. Covered in W4: the order-mutation transport's request site (mutation
// permits for the practical cancel and Phase 17 create/cancel, a read permit for order observation).
// Pending (explicit, allowlisted):
//   - the candle-reader primitive (W5), an unpaced request site;
//   - the Phase 18 orphan-cancellation mutation PATH (`GatewayOrphanCancellation`): not integrated with the budget. It
//     carries no permit, so the transport refuses it before any request; it is disabled/unwired, not paced.
// Complete mutation-path coverage and final no-bypass completion are NOT claimed until both pending lists are empty.
const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const rel = (abs: string): string => path.relative(REPO_ROOT, abs).split(path.sep).join('/');
const code = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const files = listSourceFiles(SRC_ROOT).map(rel).sort();
const importsOf = (file: string): readonly string[] => analyzeModuleReferences(readFileSync(path.join(REPO_ROOT, file), 'utf8'), file).specifiers;
const REQUEST_SITE = /\b[A-Za-z]+\.request\(/g;

const MUTATION_TRANSPORT = 'src/integration/coindcx/live/mutation-transport.ts';
const COVERED = ['src/integration/coindcx/instrument-authority.ts', MUTATION_TRANSPORT, 'src/integration/coindcx/paper-evidence.ts', 'src/integration/coindcx/transport.ts'];
const PENDING: Readonly<Record<string, 'W5'>> = {
  'src/market-data/rest-candle-reader.ts': 'W5',
};
/** Mutation paths through a covered request site that are NOT integrated with the budget (refused, not paced). */
const PENDING_MUTATION_PATHS: Readonly<Record<string, 'ORPHAN_CANCEL_UNINTEGRATED'>> = {
  'src/execution/live/reconciliation/gateway-orphan-cancellation.ts': 'ORPHAN_CANCEL_UNINTEGRATED',
};
const LOCAL_HTTP_SERVER = ['src/app/bootstrap/server.ts', 'src/app/lifecycle/shutdown.ts'];
const LOCAL_PIPE_IPC = ['src/integration/coindcx/rate-limit/runtime/client.ts', 'src/integration/coindcx/rate-limit/runtime/coordinator.ts'];

const httpImporters = files.filter((file) => importsOf(file).some((s) => ['node:http', 'node:https', 'http', 'https'].includes(s)));
const requestSites = httpImporters.filter((file) => (code(file).match(REQUEST_SITE) ?? []).length > 0);

describe('M2 REST limiter coverage (W3/W4)', () => {
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

  it.each(COVERED)('%s: every request is created inside a permit\'s synchronous start, after a permit acquisition or consumption', (file) => {
    const text = code(file);
    const sites = text.match(REQUEST_SITE) ?? [];
    const permitted = text.match(/\.start\(\(\) => [A-Za-z]+\.request\(/g) ?? [];
    expect(sites.length).toBeGreaterThan(0);
    expect(permitted.length).toBe(sites.length);
    expect(text).toMatch(/acquirePermit\(|acquireProductionPermit\(|acquireReadPermit\(/);
    expect(text).toMatch(/permit\.complete\(\)/);
    expect(text).toMatch(/permit\.throttled\(/);
    expect(importsOf(file).some((s) => /(^|\/)rate-limit\/runtime\/read-budget$/.test(s))).toBe(true);
  });

  it('W4: the mutation transport consumes a mutation permit for every mutating endpoint, synchronously before signing', () => {
    const text = code(MUTATION_TRANSPORT);
    expect(importsOf(MUTATION_TRANSPORT)).toContain('../rate-limit/runtime/mutation-budget');
    // The budget kind comes from the closed endpoint union, never from a caller label.
    expect(text).toContain("CREATE_ORDER: 'CREATE', CANCEL_ORDER: 'CANCEL', LIST_ORDERS: 'READ'");
    const execute = text.slice(text.indexOf('public async execute('), text.indexOf('async #acquireReadPermit('));
    const consume = execute.indexOf('consumeMutationPermit(budgetPermit, kind)');
    expect(consume).toBeGreaterThan(0);
    expect(consume).toBeLessThan(execute.indexOf('this.#signer.sign(payload)'));
    // From consumption to the request: no await (only the read branch awaits, before it).
    expect(execute.slice(consume, execute.indexOf('return this.#executePrepared('))).not.toMatch(/\bawait\b/);
    expect(execute.lastIndexOf('await this.#acquireReadPermit(', consume)).toBeGreaterThan(0);
    // The practical cancel's permit was consumed at the boundary; the transport accepts only a genuine consumed CANCEL permit.
    expect(text).toContain("readConsumedMutationPermit(takeCancelTransportBudget(invocation, this), 'CANCEL')");
  });

  it('pending primitives are still unpaced and are listed with the wave that will cover them (no final no-bypass claim)', () => {
    for (const [file, wave] of Object.entries(PENDING)) {
      expect((code(file).match(REQUEST_SITE) ?? []).length, `${file} (${wave})`).toBeGreaterThan(0);
      expect(importsOf(file).some((s) => s.includes('read-budget') || s.includes('mutation-budget')), `${file} must flip to COVERED when integrated in ${wave}`).toBe(false);
    }
    expect(Object.keys(PENDING)).toEqual(['src/market-data/rest-candle-reader.ts']);
  });

  it('pending mutation path: orphan cancellation calls the gateway without a budget permit and has no admission (refused, not covered)', () => {
    expect(Object.keys(PENDING_MUTATION_PATHS)).toEqual(['src/execution/live/reconciliation/gateway-orphan-cancellation.ts']);
    for (const file of Object.keys(PENDING_MUTATION_PATHS)) {
      const text = code(file);
      expect(text).toMatch(/this\.#gateway\.cancelOrder\(/);
      expect(text, `${file} must move out of PENDING_MUTATION_PATHS when its admission is integrated`).not.toMatch(/budgetPermit|admit\(|budget/i);
    }
    // The only callers of the gateway mutation methods with a permit are the two integrated paths.
    const callers = files.filter((file) => /budgetPermit/.test(code(file)) && /\.(?:placeOrder|cancelOrder)\(/.test(code(file)));
    expect(callers).toEqual(['src/execution/live/service.ts']);
  });
});
