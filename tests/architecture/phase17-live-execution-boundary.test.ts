import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildImportGraph, collectPublicExportNames, computeReachable, findPath,
  listSourceFiles, resolveLocalSpecifier,
} from './support/import-graph';

// [P17-ARCH] Static architecture proof for Phase17 live execution. Reuses the
// P14-J TRUE TRANSITIVE local TypeScript import graph (not a direct-import
// grep, and not a filename convention) to prove the live-mutation boundary:
//
//   Exactly one module in this repository can reach CoinDCX order mutation.
//   Strategies, research, ranking, risk, dispatch, and the whole Phase14 paper
//   execution tree cannot reach it by ANY transitive path, including a
//   type-only import edge.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const TESTS_ROOT = path.join(REPO_ROOT, 'tests');

const { files, graph, unresolved } = buildImportGraph(SRC_ROOT, REPO_ROOT);
const existingFiles = new Set(listSourceFiles(SRC_ROOT));

/** The mutable CoinDCX order transport, and the adapter that owns it. */
const MUTATION_TRANSPORT = 'src/integration/coindcx/live/mutation-transport.ts';
const MUTATION_ADAPTER = 'src/integration/coindcx/live/order-gateway.ts';
const MUTATION_ENDPOINTS = 'src/integration/coindcx/live/endpoints.ts';
/** The single approved production root allowed to reach the adapter. */
const APPROVED_ROOT = 'src/integration/coindcx/live/production-runtime.ts';
const LIVE_EXECUTION_ROOT = 'src/execution/live/';
const LIVE_BARREL = path.join(SRC_ROOT, 'execution/live/index.ts');

const liveExecutionFiles = files.filter((file) => file.startsWith(LIVE_EXECUTION_ROOT));

function reaches(from: string, target: string): readonly string[] | null {
  return findPath(graph, from, (node) => node === target);
}

/** Every file that can reach `target` transitively, `target` included if self-referential. */
function reachersOf(target: string): readonly string[] {
  return files.filter((file) => file !== target && computeReachable(graph, file).has(target));
}

describe('Phase17 import graph is well-formed', () => {
  it('discovers both Phase17 source trees', () => {
    expect(liveExecutionFiles.length).toBeGreaterThanOrEqual(10);
    expect(files).toContain(MUTATION_TRANSPORT);
    expect(files).toContain(MUTATION_ADAPTER);
    expect(files).toContain(APPROVED_ROOT);
    expect(files).toContain('src/execution/live/service.ts');
    expect(files).toContain('src/execution/live/authority.ts');
  });

  it('resolves every relative import in the repository (a silent miss would hide a violation)', () => {
    expect(unresolved).toEqual([]);
  });
});

describe('P17-I17 upstream analytical layers cannot reach order mutation', () => {
  const FORBIDDEN_SOURCES: readonly { readonly prefix: string; readonly why: string }[] = Object.freeze([
    { prefix: 'src/strategies/', why: 'strategy kernels' },
    { prefix: 'src/research/', why: 'Phase12 research validation' },
    { prefix: 'src/ranking/', why: 'Phase15 strategy ranking' },
    { prefix: 'src/risk/', why: 'Phase13 risk engine' },
    { prefix: 'src/dispatch/', why: 'risk admission coordination' },
    { prefix: 'src/backtest/', why: 'backtest engine' },
    { prefix: 'src/indicators/', why: 'indicator computation' },
    { prefix: 'src/market-data/', why: 'market data ingestion' },
  ]);

  it.each(FORBIDDEN_SOURCES.map((entry) => [entry.prefix, entry.why] as const))(
    'no file under %s transitively reaches the mutable order transport (%s)',
    (prefix) => {
      for (const file of files.filter((candidate) => candidate.startsWith(prefix))) {
        for (const target of [MUTATION_TRANSPORT, MUTATION_ADAPTER, MUTATION_ENDPOINTS]) {
          const violation = reaches(file, target);
          expect(violation, `forbidden dependency path: ${(violation ?? []).join(' -> ')}`).toBeNull();
        }
      }
    },
  );

  it('no file under those layers even reaches the Phase17 live execution tree', () => {
    for (const prefix of ['src/strategies/', 'src/research/', 'src/ranking/', 'src/risk/', 'src/dispatch/']) {
      for (const file of files.filter((candidate) => candidate.startsWith(prefix))) {
        const violation = findPath(graph, file, (node) => node.startsWith(LIVE_EXECUTION_ROOT));
        expect(violation, `forbidden dependency path: ${(violation ?? []).join(' -> ')}`).toBeNull();
      }
    }
  });
});

describe('P17-I03 the Phase14 paper tree cannot reach live mutation', () => {
  const paperFiles = files.filter((file) => file.startsWith('src/execution/') && !file.startsWith(LIVE_EXECUTION_ROOT));

  it('discovers the Phase14 paper execution tree', () => {
    expect(paperFiles.length).toBeGreaterThanOrEqual(20);
    expect(paperFiles).toContain('src/execution/open-authority.ts');
    expect(paperFiles).toContain('src/execution/persistence/execution-engine.ts');
  });

  it('no paper execution file reaches the mutable order transport or its adapter', () => {
    for (const file of paperFiles) {
      for (const target of [MUTATION_TRANSPORT, MUTATION_ADAPTER, APPROVED_ROOT]) {
        const violation = reaches(file, target);
        expect(violation, `forbidden dependency path: ${(violation ?? []).join(' -> ')}`).toBeNull();
      }
    }
  });

  it('no paper execution file reaches the Phase17 live execution tree at all', () => {
    for (const file of paperFiles) {
      const violation = findPath(graph, file, (node) => node.startsWith(LIVE_EXECUTION_ROOT));
      expect(violation, `forbidden dependency path: ${(violation ?? []).join(' -> ')}`).toBeNull();
    }
  });

  it('no Phase17 file imports a paper authority mint, so paper authority can never be re-used as live', () => {
    for (const file of liveExecutionFiles) {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${file} references a paper mint`).not.toMatch(/mintPaper(Open|Close)ExecutionAuthority/);
    }
  });
});

describe('P17-I17 the Phase17 execution tree holds no integration dependency at all', () => {
  it('preserves the frozen Phase14 rule: no src/execution file reaches src/integration', () => {
    for (const file of files.filter((candidate) => candidate.startsWith('src/execution/'))) {
      const violation = findPath(graph, file, (node) => node.startsWith('src/integration/'));
      expect(violation, `forbidden dependency path: ${(violation ?? []).join(' -> ')}`).toBeNull();
    }
  });

  it('the Phase17 service depends only on its own ports, never on a concrete gateway', () => {
    const reachable = computeReachable(graph, 'src/execution/live/service.ts');
    for (const forbidden of [MUTATION_ADAPTER, MUTATION_TRANSPORT, APPROVED_ROOT]) {
      expect(reachable.has(forbidden), `service reaches ${forbidden}`).toBe(false);
    }
    expect(reachable.has('src/execution/live/gateway.ts')).toBe(true);
  });

  it('the Phase17 barrel reaches no integration module, so importing it can never pull in mutation', () => {
    const reachable = computeReachable(graph, 'src/execution/live/index.ts');
    for (const node of reachable) {
      expect(node.startsWith('src/integration/'), `barrel reaches ${node}`).toBe(false);
    }
  });
});

describe('P17-I18 exactly one approved root reaches order mutation', () => {
  it('the only module reaching the mutable transport is its own adapter and the approved production root', () => {
    expect([...reachersOf(MUTATION_TRANSPORT)].sort()).toEqual([APPROVED_ROOT, MUTATION_ADAPTER].sort());
  });

  it('the only module reaching the mutable order adapter is the approved production root', () => {
    expect(reachersOf(MUTATION_ADAPTER)).toEqual([APPROVED_ROOT]);
  });

  it('nothing in the repository imports the approved production root, so it is an explicit opt-in entry point', () => {
    expect(reachersOf(APPROVED_ROOT)).toEqual([]);
  });

  it('the approved root is the single place naming both the adapter and the execution service', () => {
    const naming: string[] = [];
    for (const file of files) {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (code.includes('CoinDcxLiveFuturesOrderGateway')) naming.push(file);
    }
    expect(naming.sort()).toEqual([APPROVED_ROOT, MUTATION_ADAPTER].sort());
  });

  it('no additional mutable CoinDCX order sink exists anywhere outside the approved boundary', () => {
    const MUTATION_PATH_FRAGMENTS = ['/orders/create', '/orders/cancel', '/orders/status'];
    const allowed = new Set([MUTATION_ENDPOINTS]);
    for (const file of files) {
      if (allowed.has(file)) continue;
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const fragment of MUTATION_PATH_FRAGMENTS) {
        expect(code.includes(`'${fragment}`) || code.includes(`"${fragment}`), `${file} declares a mutation route`).toBe(false);
        expect(code.includes(`${fragment}'`) || code.includes(`${fragment}"`), `${file} declares a mutation route`).toBe(false);
      }
    }
  });

  it('does not retain the inferred futures single-order status route', () => {
    const endpoints = readFileSync(path.join(REPO_ROOT, MUTATION_ENDPOINTS), 'utf8');
    expect(endpoints).not.toContain('/derivatives/futures/orders/status');
    expect(endpoints).toContain("path: '/exchange/v1/derivatives/futures/orders'");
  });

  it('only the mutation transport constructs an authenticated order request', () => {
    const signers: string[] = [];
    for (const file of files) {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      if (source.includes('X-AUTH-SIGNATURE')) signers.push(file);
    }
    // The pre-existing read-only transport also signs; Phase17 adds exactly
    // one signing site, plus the endpoint map that documents the scheme.
    expect(signers.sort()).toEqual([
      'src/integration/coindcx/live/endpoints.ts',
      'src/integration/coindcx/live/mutation-transport.ts',
      'src/integration/coindcx/transport.ts',
    ]);
  });

  it('keeps the frozen Phase2 read-only transport free of any order-mutation capability', () => {
    const readTransport = readFileSync(path.join(REPO_ROOT, 'src/integration/coindcx/transport.ts'), 'utf8');
    expect(readTransport).not.toContain('orders/create');
    expect(readTransport).not.toContain('orders/cancel');
    expect(readTransport).toContain('CoinDcxReadEndpoint');
    const client = readFileSync(path.join(REPO_ROOT, 'src/integration/coindcx/client.ts'), 'utf8');
    for (const forbidden of ['createOrder', 'placeOrder', 'cancelOrder']) {
      expect(client, `read-only client gained ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the legacy Phase2 boundary scan still sees no mutating route in the integration root directory', () => {
    // The Phase2 test scans only the top level of src/integration/coindcx. This
    // asserts the Phase17 mutation code genuinely lives below that level, so
    // the older guarantee is preserved rather than quietly side-stepped.
    const rootFiles = readdirSync(path.join(SRC_ROOT, 'integration/coindcx')).filter((entry) => entry.endsWith('.ts'));
    for (const entry of rootFiles) {
      const source = readFileSync(path.join(SRC_ROOT, 'integration/coindcx', entry), 'utf8');
      expect(source.includes("'/orders/create'"), `${entry} declares a mutating route`).toBe(false);
      expect(source.includes('orders/cancel'), `${entry} declares a mutating route`).toBe(false);
    }
    expect(rootFiles).not.toContain('production-runtime.ts');
  });
});

describe('P17 §6 the live authority mint is not publicly reachable', () => {
  const publicNames = collectPublicExportNames(
    LIVE_BARREL,
    (absFile) => readFileSync(absFile, 'utf8'),
    (fromAbsFile, specifier) => resolveLocalSpecifier(fromAbsFile, specifier, existingFiles),
  );

  it('exposes the inert read-only surface', () => {
    for (const expected of ['LiveExecutionAuthority', 'LiveExecutionIntent', 'LiveExecutionService', 'resolveLiveExecutionGate']) {
      expect(publicNames.has(expected), `${expected} should be on the Phase17 barrel`).toBe(true);
    }
  });

  it('does NOT expose either authority mint', () => {
    expect(publicNames.has('mintLiveOpenExecutionAuthority')).toBe(false);
    expect(publicNames.has('mintLiveCloseExecutionAuthority')).toBe(false);
  });

  it('does NOT expose the intent constructor composition, so an intent cannot be hand-built from the barrel', () => {
    expect(publicNames.has('createLiveExecutionIntent')).toBe(false);
  });

  it('does NOT expose the production composition or any concrete exchange gateway', () => {
    for (const forbidden of ['composeLiveExecutionRuntime', 'CoinDcxLiveFuturesOrderGateway', 'CoinDcxOrderMutationTransport', 'LiveExecutionRuntime']) {
      expect(publicNames.has(forbidden), `${forbidden} must not be on the Phase17 barrel`).toBe(false);
    }
  });

  it('never exports the issuer symbol that gates the mint', () => {
    const authoritySource = readFileSync(path.join(SRC_ROOT, 'execution/live/authority.ts'), 'utf8');
    expect(authoritySource).toMatch(/const LIVE_AUTHORITY_ISSUER = Symbol\(/);
    expect(authoritySource).not.toMatch(/export const LIVE_AUTHORITY_ISSUER/);
    const intentSource = readFileSync(path.join(SRC_ROOT, 'execution/live/intent.ts'), 'utf8');
    expect(intentSource).not.toMatch(/export const INTENT_ISSUER/);
    const gateSource = readFileSync(path.join(SRC_ROOT, 'execution/live/gate.ts'), 'utf8');
    expect(gateSource).not.toMatch(/export const ENABLEMENT_ISSUER/);
  });
});

describe('P17-I19 tests cannot accidentally reach a real venue', () => {
  function listTestFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { results.push(...listTestFiles(path.join(dir, entry.name))); continue; }
      if (entry.isFile() && entry.name.endsWith('.ts')) results.push(path.join(dir, entry.name));
    }
    return results.sort();
  }

  // This suite itself names every forbidden string as an assertion literal,
  // so it is excluded from its own scan.
  const SELF = 'phase17-live-execution-boundary.test.ts';
  const testFiles = listTestFiles(TESTS_ROOT).filter((file) => path.basename(file) !== SELF);

  it('no test imports the approved production live runtime', () => {
    // Import edges only: a sibling architecture test legitimately NAMES that
    // module path inside an assertion literal, which is not a dependency.
    const IMPORTS_RUNTIME = /(?:from\s*|require\(\s*)['"][^'"]*live\/production-runtime['"]/;
    const IMPORTS_COMPOSER = /import[\s\S]{0,200}?composeLiveExecutionRuntime[\s\S]{0,200}?from/;
    for (const file of testFiles) {
      const source = readFileSync(file, 'utf8');
      expect(IMPORTS_RUNTIME.test(source), `${path.relative(REPO_ROOT, file)} imports the production runtime`).toBe(false);
      expect(IMPORTS_COMPOSER.test(source), `${path.relative(REPO_ROOT, file)} imports the production composer`).toBe(false);
    }
  });

  it('every test that constructs the real order gateway pins it to a loopback base URL', () => {
    for (const file of testFiles) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('new CoinDcxLiveFuturesOrderGateway')) continue;
      expect(source).toMatch(/baseUrl:\s*(venue\.baseUrl|'http:\/\/127\.0\.0\.1)/);
      expect(source).not.toContain('api.coindcx.com');
    }
  });

  it('no Phase17 test names the production CoinDCX host', () => {
    for (const file of testFiles.filter((entry) => entry.includes('live') || entry.includes('phase17'))) {
      expect(readFileSync(file, 'utf8')).not.toContain('api.coindcx.com');
    }
  });

  it('the service and state machine suites use only the fake gateway', () => {
    const serviceSuite = readFileSync(path.join(TESTS_ROOT, 'unit/execution/live/service.test.ts'), 'utf8');
    expect(serviceSuite).toContain('FakeOrderGateway');
    expect(serviceSuite).not.toContain('CoinDcxLiveFuturesOrderGateway');
  });
});

describe('P17-I04 application configuration defaults live execution to disabled', () => {
  it('the env schema declares the live flag and defaults it to the closed value', () => {
    const env = readFileSync(path.join(SRC_ROOT, 'app/config/env.ts'), 'utf8');
    expect(env).toMatch(/LIVE_EXECUTION_ENABLED:\s*z\s*\n?\s*\.string\(\)\s*\.optional\(\)\s*\.default\('false'\)/);
    for (const key of ['LIVE_EXECUTION_ACCOUNT_ALLOWLIST', 'LIVE_EXECUTION_PAIR_ALLOWLIST', 'LIVE_EXECUTION_MAX_ORDER_NOTIONAL_INR', 'COINDCX_LIVE_ACCOUNT_ID']) {
      expect(env).toMatch(new RegExp(`${key}:[\\s\\S]{0,80}\\.default\\(''\\)`));
    }
  });

  it('the gate has exactly one enabling branch, and it requires the literal flag plus production', () => {
    const gate = readFileSync(path.join(SRC_ROOT, 'execution/live/gate.ts'), 'utf8');
    expect(gate).toContain("if (rawFlag !== 'true') return disabled('MALFORMED_ENABLE_FLAG');");
    expect(gate).toContain("if (config.NODE_ENV !== 'production') return disabled('UNSUPPORTED_ENVIRONMENT');");
    // Exactly one place constructs an ENABLED resolution.
    expect(gate.match(/status: 'ENABLED' as const/g)).toHaveLength(1);
  });

  it('the production runtime refuses to compose while the gate is disabled', () => {
    const runtime = readFileSync(path.join(REPO_ROOT, APPROVED_ROOT), 'utf8');
    expect(runtime).toContain("if (resolution.status === 'DISABLED')");
    expect(runtime).toContain('LIVE_EXECUTION_DISABLED');
    // The gateway must be constructed after the gate decision, never before.
    expect(runtime.indexOf('resolveLiveExecutionGate(input.config)')).toBeLessThan(runtime.indexOf('createProductionOrderGateway'));
  });
});

describe('P17 targeted closure documentation truth', () => {
  it('documents that Phase18 must establish live_position before production CLOSE is available', () => {
    const documentation = readFileSync(path.join(REPO_ROOT, 'docs/PHASE17_LIVE_EXECUTION.md'), 'utf8');
    expect(documentation).toContain('does **not** populate it from CoinDCX');
    expect(documentation).toContain('production writer/reconciliation');
    expect(documentation).toContain('LIVE_POSITION_NOT_AVAILABLE');
    expect(documentation).toContain('tests seed `live_position` only');
  });

  it('requires durable position availability before CLOSE authority mint or dispatch', () => {
    const runtime = readFileSync(path.join(REPO_ROOT, APPROVED_ROOT), 'utf8');
    const positionCheck = runtime.indexOf('requireAuthoritativeLivePosition(this.#repository');
    const closeMint = runtime.indexOf('mintLiveCloseExecutionAuthority({');
    const dispatch = runtime.indexOf('return this.#dispatchMinted(minted);', closeMint);
    expect(positionCheck).toBeGreaterThan(0);
    expect(positionCheck).toBeLessThan(closeMint);
    expect(closeMint).toBeLessThan(dispatch);
  });
});
