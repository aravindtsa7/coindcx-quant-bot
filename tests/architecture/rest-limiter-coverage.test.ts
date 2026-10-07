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
// permits for the practical cancel and Phase 17 create/cancel, a read permit for order observation). Covered in W5:
// the candle-reader request site and its callers (accounted for below).
// Covered after W6: the Phase 18 orphan-cancellation mutation PATH (`GatewayOrphanCancellation`): admission is awaited
// before the durable arm and the opaque CANCEL permit is consumed by the transport (pinned below). The path stays
// disabled/unwired: production composes no orphan budget, so it is refused before any request.
// Pending: nothing. The coverage allowlist is empty. That is coverage only, NOT M2 acceptance: the DB acceptance suites
// are NOT RUN, and production budget binding and the remaining production decisions are open.
const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const rel = (abs: string): string => path.relative(REPO_ROOT, abs).split(path.sep).join('/');
const code = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const files = listSourceFiles(SRC_ROOT).map(rel).sort();
const importsOf = (file: string): readonly string[] => analyzeModuleReferences(readFileSync(path.join(REPO_ROOT, file), 'utf8'), file).specifiers;
const REQUEST_SITE = /\b[A-Za-z]+\.request\(/g;

const MUTATION_TRANSPORT = 'src/integration/coindcx/live/mutation-transport.ts';
const CANDLE_READER = 'src/market-data/rest-candle-reader.ts';
const COVERED = ['src/integration/coindcx/instrument-authority.ts', MUTATION_TRANSPORT, 'src/integration/coindcx/paper-evidence.ts', 'src/integration/coindcx/transport.ts', CANDLE_READER];
const PENDING: Readonly<Record<string, 'W5'>> = {};
/** Mutation paths through a covered request site that are NOT integrated with the budget (refused, not paced). */
const PENDING_MUTATION_PATHS: Readonly<Record<string, 'ORPHAN_CANCEL_UNINTEGRATED'>> = {};
const ORPHAN_ADAPTER = 'src/execution/live/reconciliation/gateway-orphan-cancellation.ts';
const RECONCILIATION_SERVICE = 'src/execution/live/reconciliation/service.ts';
const LOCAL_HTTP_SERVER = ['src/app/bootstrap/server.ts', 'src/app/lifecycle/shutdown.ts'];
const LOCAL_PIPE_IPC = ['src/integration/coindcx/rate-limit/runtime/client.ts', 'src/integration/coindcx/rate-limit/runtime/coordinator.ts'];

const httpImporters = files.filter((file) => importsOf(file).some((s) => ['node:http', 'node:https', 'http', 'https'].includes(s)));
const requestSites = httpImporters.filter((file) => (code(file).match(REQUEST_SITE) ?? []).length > 0);

describe('M2 REST limiter coverage (W3/W4/W5)', () => {
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
    expect(Object.keys(PENDING)).toEqual([]); // W5 covered the last unpaced request site; the orphan PATH stays pending below
  });

  it('W5: the candle reader is covered with every caller accounted for (no unpaced construction or transport seam in src)', () => {
    const text = code(CANDLE_READER);
    // Admission before request preparation; the only request is created inside the permit start.
    const transport = text.slice(text.indexOf('async function defaultHttpTransport('));
    expect(transport.indexOf('await acquireReadPermit(readBudget, timeoutMs)')).toBeGreaterThan(0);
    expect(transport.indexOf('await acquireReadPermit(readBudget, timeoutMs)')).toBeLessThan(transport.indexOf('new URL(urlString)'));
    expect(text).toContain("config.readBudget ?? boundProductionTransportBudget('PUBLIC')"); // no unpaced default
    expect(text.match(/defaultHttpTransport\(/g)).toHaveLength(2); // definition and the single budgeted binding
    // Callers: the only constructions in src are the engine's default reader (budget passed through); nothing in src
    // supplies the unpaced `httpTransport` test seam; the historical backfill has no src construction (injected reader).
    const constructs = files.filter((file) => /new CoinDcxFuturesCandleRestReader\(/.test(code(file)));
    expect(constructs).toEqual(['src/market-data/canonical-engine.ts']);
    expect(code('src/market-data/canonical-engine.ts')).toContain('readBudget: config.readBudget');
    expect(files.filter((file) => file !== CANDLE_READER && /httpTransport\s*:/.test(code(file)))).toEqual([]);
    expect(files.filter((file) => /new HistoricalBackfillService\(|new CanonicalMarketDataEngine\(/.test(code(file)))).toEqual([]);
  });

  it('orphan cancellation is integrated: admission before the durable arm, the permit carried unchanged, consumed by the transport', () => {
    // The adapter passes the service's opaque permit, unchanged, to the gateway's budgetPermit (no other permit source).
    const adapter = code(ORPHAN_ADAPTER);
    expect(adapter).toMatch(/this\.#gateway\.cancelOrder\(/);
    expect(adapter).toContain('budgetPermit: request.budgetPermit ?? null,');
    expect(adapter).not.toMatch(/mutation-budget|read-budget|rate-limit|admit\(/);
    // The service: claim, then budget admission (a cancelOrder permit), then the fresh policy re-check and the durable
    // arm, then the port call carrying the permit; the permit is released in finally (a no-op once consumed).
    const service = code(RECONCILIATION_SERVICE);
    const orphans = service.slice(service.indexOf('async #handleOrphans('), service.indexOf('async #verifyAccountIdentity('));
    const order = ['await this.#repository.claimOrphanCancellation(', 'await this.#admitOrphanCancelBudget()', 'const current = this.#permittedOrphanCleanup(accountId)',
      'await this.#repository.armOrphanCancelWire(', 'await current.port.cancelVenueOrder({', 'budgetPermit,', 'this.#releaseOrphanCancelBudget(budgetPermit)'].map((needle) => orphans.indexOf(needle));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Between the durable arm and the gateway call: no other await (the arm is the last check before the wire).
    expect(orphans.slice(order[3], order[4]).match(/\bawait\b/g)).toHaveLength(1);
    expect(service).toContain("budget.admit(Object.freeze({ gatewayCall: 'cancelOrder' as const, lifetimeMs: this.#requestTimeoutMs }))");
    // The budget port type is declared in reconciliation (structural), so the service does not reach the gateway module.
    expect(importsOf(RECONCILIATION_SERVICE)).not.toContain('../gateway');
    // The transport is the single synchronous consumption point for every Phase 17 / Phase 18 gateway mutation.
    expect(code(MUTATION_TRANSPORT)).toContain('consumeMutationPermit(budgetPermit, kind)');
    // Exactly the integrated paths pass a permit into a gateway mutation; production composes no orphan budget (refused).
    const callers = files.filter((file) => /budgetPermit/.test(code(file)) && /\.(?:placeOrder|cancelOrder)\(/.test(code(file)));
    expect(callers).toEqual([ORPHAN_ADAPTER, 'src/execution/live/service.ts']);
    expect(files.filter((file) => /(?<![#\w])orphanCancellationBudget\s*:/.test(code(file)))).toEqual([]); // no composition passes one
    expect(Object.keys(PENDING_MUTATION_PATHS)).toEqual([]);
  });

  it("coverage allowlist empty (the design's no-bypass coverage exit): every site covered and every mutation path integrated; NOT M2 acceptance", () => {
    expect(requestSites).toEqual([...COVERED].sort());
    expect(Object.keys(PENDING)).toEqual([]);
    expect(Object.keys(PENDING_MUTATION_PATHS)).toEqual([]);
    // This is a static coverage result only. M2 acceptance additionally requires the DB acceptance suites (NOT RUN),
    // production budget binding and the open production decisions; none of that is claimed here.
    // Deferred G-RX acquisition/downloader sources stay outside this implementation.
    expect(files.filter((file) => /historical\/acquisition\.ts$|coindcx-historical-candles/.test(file))).toEqual([]);
  });
});
