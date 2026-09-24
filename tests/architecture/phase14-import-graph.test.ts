import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildImportGraph, collectPublicExportNames, computeReachable, findMutatingOrderSymbols, findPath,
  listSourceFiles, resolveLocalSpecifier, type ImportGraph,
} from './support/import-graph';

// [P14-J] Static architecture proof: a TRUE TRANSITIVE local TypeScript
// import graph (not a direct-import-only grep/ESLint check) proving the
// Phase14 paper/live dependency-direction boundary. See
// docs/PHASE14_PROOF_MATRIX.md for the human-readable guarantee summary this
// test backs.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const PAPER_PRODUCTION_ROOT = 'src/integration/coindcx/paper-production-runtime.ts';
const PRIVATE_ECONOMIC_SOURCE_FILE = 'src/integration/coindcx/client.ts';
const PRODUCTION_INSTRUMENT_AUTHORITY_FILE = 'src/integration/coindcx/instrument-authority.ts';
const LIVE_MUTATION_TRANSPORT = 'src/integration/coindcx/live/mutation-transport.ts';
const LIVE_MUTATION_GATEWAY = 'src/integration/coindcx/live/order-gateway.ts';
const LIVE_PRODUCTION_ROOT = 'src/integration/coindcx/live/production-runtime.ts';

/**
 * [P14-J-MAJ-01/MAJ-02 correction] There is no allowlist here. The two
 * transitive execution/core -> integration edges a prior review found
 * (`src/market-data/historical/index.ts` -> `src/integration/coindcx/clock.ts`,
 * and `src/risk/ownership.ts` -> `src/integration/coindcx/models.ts`, plus an
 * independently-discovered third path through
 * `src/research/**` -> `src/backtest/engine.ts` -> `src/backtest/instrument.ts`
 * -> `src/coin-runtime/types.ts` -> `src/integration/coindcx/models.ts`) were
 * closed by behavior-neutral layering corrections rather than being
 * allowlisted:
 *
 *  - The clock abstraction (`Clock`/`SystemClock`/`FakeClock`) moved to the
 *    exchange-neutral `src/core/time/clock.ts`; `src/integration/coindcx/clock.ts`
 *    is now a thin `export … from` compatibility re-export that no
 *    core/execution file imports any more.
 *  - The generic Decimal-tier contracts `DynamicLeverageTier` /
 *    `DynamicSafetyMarginTier` moved to the exchange-neutral
 *    `src/core/types/index.ts`; `src/integration/coindcx/models.ts` now
 *    re-exports them from core (for its own `InrFuturesInstrument` and for
 *    existing external importers of `./models`), and
 *    `src/coin-runtime/types.ts` imports them directly from core instead of
 *    from `../integration/coindcx/models`.
 *  - The risk-ownership contract `src/risk/ownership.ts` needed from
 *    `InrFuturesPosition` was extracted as the structural
 *    `RiskPositionExposureInput` interface in `src/risk/types.ts`; CoinDCX's
 *    `InrFuturesPosition` remains naturally structurally assignable to it
 *    (no runtime mapping).
 *
 * The real-repository tests below now assert the boundary directly: STRICT
 * ZERO transitive edges from every execution/dispatch/risk/research/strategies
 * file to any `src/integration/**` file, with no exception mechanism.
 */

function posix(p: string): string {
  return p.split(path.sep).join('/');
}

function findViolations(graph: ImportGraph, roots: readonly string[], isForbidden: (node: string) => boolean): readonly { readonly root: string; readonly path: readonly string[] }[] {
  const violations: { readonly root: string; readonly path: readonly string[] }[] = [];
  for (const root of roots) {
    const violation = findPath(graph, root, isForbidden);
    if (violation !== null) violations.push({ root, path: violation });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// 1. Pure graph algorithm — synthetic in-memory graphs (fast, no filesystem).
//    Proves determinism and cycle-safety independent of the TS parser.
// ---------------------------------------------------------------------------

describe('P14-J graph algorithms — synthetic (§8/§30)', () => {
  it('computeReachable follows indirect edges and terminates on a cycle without hanging', () => {
    const graph: ImportGraph = new Map([
      ['a', ['b']],
      ['b', ['c', 'a']], // cycle back to 'a'
      ['c', []],
    ]);
    const reachable = computeReachable(graph, 'a');
    expect([...reachable].sort()).toEqual(['b', 'c']);
  });

  it('computeReachable and findPath produce the same result on repeated runs (deterministic)', () => {
    const graph: ImportGraph = new Map([
      ['root', ['z', 'a']],
      ['a', ['b']],
      ['b', ['target']],
      ['z', []],
      ['target', []],
    ]);
    const runs = Array.from({ length: 5 }, () => findPath(graph, 'root', (n) => n === 'target'));
    for (const run of runs) expect(run).toEqual(['root', 'a', 'b', 'target']);
    const reachableRuns = Array.from({ length: 5 }, () => [...computeReachable(graph, 'root')].sort());
    for (const run of reachableRuns) expect(run).toEqual(['a', 'b', 'target', 'z']);
  });

  it('findPath returns null when no path exists', () => {
    const graph: ImportGraph = new Map([['a', ['b']], ['b', []], ['c', []]]);
    expect(findPath(graph, 'a', (n) => n === 'c')).toBeNull();
  });

  it('a self-referential/cyclic node terminates and excludes the root from its own reachable set unless a distinct cycle member reaches it', () => {
    const graph: ImportGraph = new Map([['a', ['a', 'b']], ['b', []]]);
    expect([...computeReachable(graph, 'a')].sort()).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------
// 2. Real TS-parser fixture tests — proves the checker is truly transitive,
//    respects the allowed direction, is cycle-safe on real syntax, and
//    resolves the real import forms this repo actually uses.
// ---------------------------------------------------------------------------

describe('P14-J fixture — transitive violation detection (§28)', () => {
  it('detects an indirect execution-a -> shared-b -> integration-c path and reports the full chain', () => {
    const dir = path.join(__dirname, 'fixtures', 'transitive-violation');
    const { graph } = buildImportGraph(dir, REPO_ROOT);
    const root = posix(path.relative(REPO_ROOT, path.join(dir, 'execution-a.ts')));
    const violation = findPath(graph, root, (n) => n.endsWith('/integration-c.ts'));
    expect(violation).not.toBeNull();
    expect(violation?.map((p) => path.basename(p))).toEqual(['execution-a.ts', 'shared-b.ts', 'integration-c.ts']);
  });
});

describe('P14-J fixture — allowed reverse direction (§29)', () => {
  it('integration-root -> execution-core is reachable (the one intentional composition direction)', () => {
    const dir = path.join(__dirname, 'fixtures', 'allowed-direction');
    const { graph } = buildImportGraph(dir, REPO_ROOT);
    const root = posix(path.relative(REPO_ROOT, path.join(dir, 'integration-root.ts')));
    const reachable = computeReachable(graph, root);
    expect([...reachable].some((n) => n.endsWith('/execution-core.ts'))).toBe(true);
  });
});

describe('P14-J fixture — cycle safety (§30)', () => {
  it('an import cycle terminates deterministically without hanging, correctly finding the other cycle member', () => {
    const dir = path.join(__dirname, 'fixtures', 'cycle');
    const { graph } = buildImportGraph(dir, REPO_ROOT);
    const root = posix(path.relative(REPO_ROOT, path.join(dir, 'node-a.ts')));
    const reachable = computeReachable(graph, root);
    // `root` is excluded from its own reachable set by design (computeReachable's documented contract) —
    // the cycle-safety proof is that this terminates at all (no hang) and finds exactly the other member.
    expect([...reachable].map((p) => path.basename(p))).toEqual(['node-b.ts']);
  });
});

describe('P14-J fixture — path resolution forms (§31)', () => {
  it('resolves extensionless imports, /index.ts, re-exports, and type-only local imports', () => {
    const dir = path.join(__dirname, 'fixtures', 'path-resolution');
    const { graph, unresolved } = buildImportGraph(dir, REPO_ROOT);
    expect(unresolved).toEqual([]);
    const root = posix(path.relative(REPO_ROOT, path.join(dir, 'entry.ts')));
    const relativeToFixtureDir = (p: string): string => posix(path.relative(posix(path.relative(REPO_ROOT, dir)), p));
    const edges = (graph.get(root) ?? []).map(relativeToFixtureDir).sort();
    // extensionless-target (direct + type-only import collapse to one edge), folder-target/index.ts (direct), re-export.ts (export *)
    expect(edges).toEqual(['extensionless-target.ts', 'folder-target/index.ts', 're-export.ts'].sort());
    const reachable = [...computeReachable(graph, root)].map(relativeToFixtureDir).sort();
    // re-export.ts itself re-exports folder-target, proving `export * from` is followed as an edge too.
    expect(reachable).toContain('re-export.ts');
    expect(reachable).toContain('folder-target/index.ts');
  });
});

// ---------------------------------------------------------------------------
// 3. Real repository graph — the actual proof.
// ---------------------------------------------------------------------------

describe('P14-J real repository graph (§9/§32)', () => {
  const { graph, files, unresolved } = buildImportGraph(SRC_ROOT, REPO_ROOT);

  it('every local relative import in src/ resolves to a real file', () => {
    expect(unresolved).toEqual([]);
  });

  it('no module under src/execution/** transitively reaches any module under src/integration/** (strict zero, no exceptions)', () => {
    const executionFiles = files.filter((f) => f.startsWith('src/execution/'));
    expect(executionFiles.length).toBeGreaterThan(0); // sanity: the boundary being tested actually has files on both sides
    const violations = findViolations(graph, executionFiles, (n) => n.startsWith('src/integration/'));
    expect(violations, `execution -> integration violation(s):\n${violations.map((v) => v.path.join(' -> ')).join('\n')}`).toEqual([]);
  });

  it('the P14-I composition root is allowed to (and does) transitively reach src/execution/**', () => {
    const reachable = computeReachable(graph, PAPER_PRODUCTION_ROOT);
    expect([...reachable].some((n) => n.startsWith('src/execution/'))).toBe(true);
  });

  it('Wave3-A instrument authority is reachable only in the allowed integration-to-core direction', () => {
    expect(files).toContain(PRODUCTION_INSTRUMENT_AUTHORITY_FILE);
    expect(computeReachable(graph, PAPER_PRODUCTION_ROOT).has(PRODUCTION_INSTRUMENT_AUTHORITY_FILE)).toBe(true);
    const forbiddenRoots = files.filter((f) => ['src/execution/', 'src/dispatch/', 'src/risk/', 'src/research/', 'src/strategies/'].some((prefix) => f.startsWith(prefix)));
    const violations = findViolations(graph, forbiddenRoots, (n) => n === PRODUCTION_INSTRUMENT_AUTHORITY_FILE);
    expect(violations, `forbidden deep import of instrument authority:\n${violations.map((v) => v.path.join(' -> ')).join('\n')}`).toEqual([]);
  });

  it('dispatch/risk/research/strategies core layers reach no integration/** file (strict zero, no exceptions)', () => {
    const coreRoots = ['src/dispatch/', 'src/risk/', 'src/research/', 'src/strategies/'];
    const roots = files.filter((f) => coreRoots.some((prefix) => f.startsWith(prefix)));
    const violations = findViolations(graph, roots, (n) => n.startsWith('src/integration/'));
    expect(violations, `core-layer -> integration violation(s):\n${violations.map((v) => v.path.join(' -> ')).join('\n')}`).toEqual([]);
  });

  it('the reachable integration surface from every execution/dispatch/risk/research/strategies file is the empty set', () => {
    const coreRoots = ['src/execution/', 'src/dispatch/', 'src/risk/', 'src/research/', 'src/strategies/'];
    const roots = files.filter((f) => coreRoots.some((prefix) => f.startsWith(prefix)));
    const reachedIntegrationFiles = new Set<string>();
    for (const root of roots) {
      for (const node of computeReachable(graph, root)) {
        if (node.startsWith('src/integration/')) reachedIntegrationFiles.add(node);
      }
    }
    expect([...reachedIntegrationFiles].sort()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Paper-production-root sink proofs (§13/§14/§15/§33/§34).
// ---------------------------------------------------------------------------

describe('P14-J paper root — live-mutation sink absence (§12/§13/§33)', () => {
  it('zero exported/declared symbols in production src/ (excluding Phase9 backtest simulation) match a live order-mutation naming pattern', () => {
    // `src/backtest/**` is excluded on evidence, not convenience: its
    // `cancelOrder` (and similar) methods are `private`, operate only on the
    // backtest engine's own in-memory simulated order Map, and have zero
    // network/exchange interaction — Phase 9 historical simulation, not a
    // live CoinDCX mutation path. Every OTHER file in `src/` remains scanned.
    const files = listSourceFiles(SRC_ROOT).filter((f) => !posix(path.relative(SRC_ROOT, f)).startsWith('backtest/'));
    const hits = findMutatingOrderSymbols(files, (f) => readFileSync(f, 'utf8'));
    // Evidence, not assumption: `src/integration/coindcx/client.ts` and
    // `src/integration/coindcx/transport.ts` were manually inspected and
    // expose only read (`executeRead`, `listXxx`/`getXxx`) methods.
    //
    // [P17 amendment] Phase17 introduced live execution, so the sink set is no
    // longer empty — it is EXACTLY the approved Phase17 boundary, enumerated
    // below. This is a strengthening, not a relaxation: the very next test
    // proves the Phase14 paper production root reaches none of these files,
    // which is now a real non-reachability proof against a NON-EMPTY sink set
    // rather than a vacuous one. Any new mutating-order symbol appearing
    // anywhere else in `src/` still fails this assertion.
    expect(hits.map((hit) => `${posix(path.relative(REPO_ROOT, hit.file))}#${hit.name}`)).toEqual([
      // The execution-owned PORT: an interface declaration only, with no
      // implementation, no HTTP, and no credentials.
      'src/execution/live/gateway.ts#cancelOrder',
      'src/execution/live/gateway.ts#placeOrder',
      // [P18] Orphan-order cancellation. Both entries are execution-owned and
      // credential-free, exactly like the two above: `ports.ts#cancelVenueOrder`
      // is an interface declaration, and
      // `gateway-orphan-cancellation.ts#cancelVenueOrder` is a thin translation
      // that delegates to the Phase17 gateway PORT. Neither builds an HTTP
      // request, names an endpoint, or holds a credential, so Phase18 adds no
      // second mutation sink — it reuses the approved one.
      'src/execution/live/reconciliation/gateway-orphan-cancellation.ts#cancelVenueOrder',
      'src/execution/live/reconciliation/ports.ts#cancelVenueOrder',
      // The single CoinDCX adapter implementing that port.
      'src/integration/coindcx/live/order-gateway.ts#cancelOrder',
      'src/integration/coindcx/live/order-gateway.ts#placeOrder',
      // The approved production root's private gateway factory.
      'src/integration/coindcx/live/production-runtime.ts#createProductionOrderGateway',
    ]);
  });

  it('the P14-I paper production root cannot reach the explicit live network, gateway, or production-root capabilities', () => {
    const { graph, files } = buildImportGraph(SRC_ROOT, REPO_ROOT);
    expect(files).toContain(PAPER_PRODUCTION_ROOT);
    const reachable = computeReachable(graph, PAPER_PRODUCTION_ROOT);
    expect([LIVE_MUTATION_TRANSPORT, LIVE_MUTATION_GATEWAY, LIVE_PRODUCTION_ROOT]
      .filter((target) => reachable.has(target))).toEqual([]);
  });
});

describe('P14-J paper root — private economic source isolation (§15/§16/§34)', () => {
  it('the P14-I paper production root does not transitively reach src/integration/coindcx/client.ts (the sole file exposing private wallet/position/order/trade read methods)', () => {
    const { graph, files } = buildImportGraph(SRC_ROOT, REPO_ROOT);
    expect(files).toContain(PRIVATE_ECONOMIC_SOURCE_FILE); // sanity: the file this test excludes actually exists
    const reachable = computeReachable(graph, PAPER_PRODUCTION_ROOT);
    expect(reachable.has(PRIVATE_ECONOMIC_SOURCE_FILE)).toBe(false);
  });

  it('src/execution/persistence/** (the P14-E economic transaction core) has no transitive dependency on any CoinDCX networking/private-data module (strict zero, no exceptions)', () => {
    const { graph, files } = buildImportGraph(SRC_ROOT, REPO_ROOT);
    const persistenceFiles = files.filter((f) => f.startsWith('src/execution/persistence/'));
    expect(persistenceFiles.length).toBeGreaterThan(0);
    const violations = findViolations(graph, persistenceFiles, (n) => n.startsWith('src/integration/'));
    expect(violations, `persistence -> integration violation(s):\n${violations.map((v) => v.path.join(' -> ')).join('\n')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Capability/issuer export-safety proof (§18/§19/§52).
// ---------------------------------------------------------------------------

describe('P14-J capability export safety (§18/§19/§52)', () => {
  // Every symbol-gated capability construct found anywhere in src/ (via `grep _ISSUER|_PROOF|_CAPABILITY`),
  // labeled with the file that actually DEFINES it.
  const DEFINING_FILES: Readonly<Record<string, string>> = {
    OPEN_AUTHORITY_ISSUER: 'src/execution/open-authority.ts',
    CLOSE_AUTHORITY_ISSUER: 'src/execution/close-authority.ts',
    OWNERSHIP_ISSUER: 'src/execution/persistence/account-ownership.ts',
    SESSION_ISSUER: 'src/execution/persistence/paper-account-session.ts',
    RUNTIME_ISSUER: 'src/execution/persistence/paper-account-kernel.ts',
    PRODUCTION_ISSUER: 'src/integration/coindcx/paper-production-runtime.ts',
    SESSION_PROOF: 'src/execution/persistence/admission-bridge.ts',
    ACCOUNT_FAULT_RECOVERY_CAPABILITY: 'src/dispatch/admission.ts',
    // [F14-02] The production market-evidence acquisition capability. It is no
    // longer a token at all: it is object identity in the module-private
    // PRODUCTION_PROVIDERS WeakSet inside paper-evidence.ts, written only by
    // that module's own approved production factory. Like
    // INSTRUMENT_BINDING_ISSUER it must be exported from NOWHERE — not from its
    // defining file, and therefore not from any barrel or deep import.
    PRODUCTION_PROVIDERS: 'src/integration/coindcx/paper-evidence.ts',
    PRODUCTION_ACQUISITION_CAPABILITY: 'src/integration/coindcx/paper-evidence.ts',
    INSTRUMENT_BINDING_ISSUER: 'src/integration/coindcx/instrument-authority.ts',
  };

  const PUBLIC_BARRELS = [
    'src/execution/index.ts',
    'src/execution/persistence/index.ts',
    'src/dispatch/index.ts',
    'src/risk/index.ts',
    'src/research/index.ts',
    'src/research/research-validation/index.ts',
    'src/strategies/index.ts',
    'src/integration/coindcx/index.ts',
    'src/coin-runtime/index.ts',
    'src/index.ts',
  ];

  it('every known capability/issuer name is absent from every public barrel\'s full (recursive export *) surface', () => {
    const readFile = (f: string): string => readFileSync(f, 'utf8');
    const allFiles = new Set(listSourceFiles(SRC_ROOT));
    const resolveSpecifier = (fromAbsFile: string, specifier: string): string | null => resolveLocalSpecifier(fromAbsFile, specifier, allFiles);

    for (const barrel of PUBLIC_BARRELS) {
      const absBarrel = path.join(REPO_ROOT, barrel);
      const exported = collectPublicExportNames(absBarrel, readFile, resolveSpecifier);
      for (const capabilityName of Object.keys(DEFINING_FILES)) {
        expect(exported.has(capabilityName), `${barrel} must not publicly export ${capabilityName}`).toBe(false);
      }
    }
  });

  it('each capability name that IS exported from its own defining file is exported ONLY from that concrete module path, never re-exported by name from a barrel', () => {
    // Structural cross-check: for names not exported at all from their
    // defining file (module-private `const`), no barrel could ever leak
    // them (proven above already covers this). For the two names that ARE
    // `export const` at their own definition site, confirm that directly too.
    const readFile = (f: string): string => readFileSync(f, 'utf8');
    for (const [name, definingFile] of Object.entries(DEFINING_FILES)) {
      const absDefiningFile = path.join(REPO_ROOT, definingFile);
      const ownExports = collectPublicExportNames(absDefiningFile, readFile, () => null);
      if (name === 'SESSION_PROOF' || name === 'ACCOUNT_FAULT_RECOVERY_CAPABILITY') {
        expect(ownExports.has(name), `${definingFile} was expected to export ${name} at its own module level`).toBe(true);
      } else {
        expect(ownExports.has(name), `${definingFile} must keep ${name} module-private (not exported even from its own file)`).toBe(false);
      }
    }
  });

  /**
   * [F14-02 §3/§9/§17] No file anywhere in src/ may export a market-evidence
   * acquisition capability value, under any name. This is a structural scan of
   * every export statement in the tree, not an allowlist: if someone
   * reintroduces a token — as a const, a helper that returns it, or a
   * re-export — this fails.
   */
  it('no src module exports any production market-evidence acquisition capability value', () => {
    const offenders: string[] = [];
    const forbiddenNamePattern = /ACQUISITION_CAPABILITY|PRODUCTION_PROVIDERS|GENUINE_PROVIDERS|acquisitionFor/;
    for (const absFile of listSourceFiles(SRC_ROOT)) {
      const relative = path.relative(REPO_ROOT, absFile).split(path.sep).join('/');
      const source = readFileSync(absFile, 'utf8');
      // Strip block and line comments so prose about the capability is allowed.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const line of code.split(/\r?\n/)) {
        if (!line.includes('export')) continue;
        if (forbiddenNamePattern.test(line)) offenders.push(`${relative}: ${line.trim()}`);
      }
    }
    expect(offenders, 'a market acquisition capability value must never be exported from src/').toEqual([]);
  });

  /**
   * [F14-02 §4] The provider constructor must capture each caller-controlled
   * option exactly once. A second read of the same caller property is what
   * Astra's getter TOCTOU exploited, so the shape is asserted structurally.
   */
  it('the P14-B provider constructor never reads a caller option property twice', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'src/integration/coindcx/paper-evidence.ts'), 'utf8');
    const constructorStart = source.indexOf('public constructor(options: CoinDcxPaperEvidenceOptions)');
    expect(constructorStart, 'provider constructor not found').toBeGreaterThan(-1);
    const constructorBody = source.slice(constructorStart, source.indexOf('#acquisition(internal: boolean)', constructorStart));
    // Exactly one read of the caller object, into the single-read capture.
    const optionReads = constructorBody.match(/\boptions\.[A-Za-z]+/g) ?? [];
    expect(optionReads, 'the constructor must touch the caller options object only through captureOptions').toEqual([]);
    expect(constructorBody).toContain('captureOptions(options)');
    // And captureOptions itself reads each property exactly once.
    const captureStart = source.indexOf('function captureOptions(');
    const captureBody = source.slice(captureStart, source.indexOf('\n}', captureStart));
    const capturedReads = (captureBody.match(/options\.([A-Za-z]+)/g) ?? []).map((m) => m.split('.')[1]);
    expect(new Set(capturedReads).size, 'captureOptions must read each caller option exactly once').toBe(capturedReads.length);
  });

  /**
   * [F14-02 §5/§8] The approved production construction path must expose no
   * injectable acquisition dependency.
   */
  it('the production evidence provider factory accepts no injectable acquisition dependency', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'src/integration/coindcx/paper-evidence.ts'), 'utf8');
    const start = source.indexOf('export interface ProductionPaperEvidenceOptions {');
    expect(start, 'ProductionPaperEvidenceOptions not found').toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('}', start));
    for (const seam of ['clock', 'socketFactory', 'orderbookRestTransport', 'markRestTransport', 'conversionTransport', 'transport', 'httpClient', 'reader']) {
      expect(body.includes(seam), `the production factory must not accept an injectable ${seam}`).toBe(false);
    }
  });

  /**
   * [F14-02 §7] No public ingestion entry point may take a capability-shaped
   * argument that could upgrade caller-supplied data.
   */
  it('no public ingest entry point accepts a capability argument', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'src/integration/coindcx/paper-evidence.ts'), 'utf8');
    const publicIngestSignatures = source.match(/public ingest[A-Za-z]+\([^)]*\)/g) ?? [];
    expect(publicIngestSignatures.length).toBeGreaterThan(0);
    for (const signature of publicIngestSignatures) {
      expect(signature.includes('acquisitionCapability'), `${signature} must not accept a capability`).toBe(false);
      expect(signature.includes('capability'), `${signature} must not accept a capability`).toBe(false);
      expect(signature.includes('internal'), `${signature} must not let the caller choose the internal path`).toBe(false);
    }
  });

  /**
   * [F14-02 4A.1 §21] The privileged production acquisition implementation is
   * module-private. The behavioural proof lives in
   * `tests/unit/execution/prototype-trust-bypass.test.ts`, which actually
   * patches the exported prototypes and shows the privileged path never calls
   * them; this is the structural companion that fails fast if the privileged
   * primitives are ever exported or moved back onto an exported prototype.
   */
  it('the privileged production acquisition primitives exist and are exported from nowhere', () => {
    const evidenceFile = 'src/integration/coindcx/paper-evidence.ts';
    const source = readFileSync(path.join(REPO_ROOT, evidenceFile), 'utf8');
    for (const primitive of ['privilegedGetJson', 'PrivilegedProductionSocket']) {
      expect(source.includes(primitive), `${evidenceFile} must define ${primitive}`).toBe(true);
    }
    // Defined, never exported — from this file or any other.
    const readFile = (f: string): string => readFileSync(f, 'utf8');
    const ownExports = collectPublicExportNames(path.join(REPO_ROOT, evidenceFile), readFile, () => null);
    for (const primitive of ['privilegedGetJson', 'PrivilegedProductionSocket']) {
      expect(ownExports.has(primitive), `${primitive} must stay module-private`).toBe(false);
    }
    const offenders: string[] = [];
    for (const absFile of listSourceFiles(SRC_ROOT)) {
      const code = readFileSync(absFile, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const line of code.split(/\r?\n/)) {
        if (!line.includes('export')) continue;
        if (/privilegedGetJson|PrivilegedProductionSocket/.test(line)) {
          offenders.push(`${path.relative(REPO_ROOT, absFile).split(path.sep).join('/')}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, 'the privileged acquisition primitives must never be exported').toEqual([]);
  });

  /**
   * [F14-02 4A.1 §6/§7] The privileged path must select the module-private
   * primitives, and must do so on the production-registry check — not on a
   * caller-influenced value.
   */
  it('the production acquisition path routes through the private primitives, not an exported prototype', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'src/integration/coindcx/paper-evidence.ts'), 'utf8');

    const startSocketIndex = source.indexOf('#startSocket(state: SocketState');
    const startSocket = source.slice(startSocketIndex, source.indexOf('#makeBookEvidence(instrument:', startSocketIndex));
    expect(startSocket).toContain('const privileged = PRODUCTION_PROVIDERS.has(this)');
    expect(startSocket).toContain('new PrivilegedProductionSocket(');
    // The exported factory may still serve the untrusted branch, but the
    // privileged branch must not reach it.
    const privilegedSocketBranch = startSocket.slice(startSocket.indexOf('const socket = privileged'), startSocket.indexOf('state.socket = socket'));
    expect(privilegedSocketBranch.indexOf('new PrivilegedProductionSocket('))
      .toBeLessThan(privilegedSocketBranch.indexOf('this.#socketFactory.createSocket('));

    for (const method of ['readConversion', 'readOrderbookBootstrap']) {
      const start = source.indexOf(`public async ${method}(`);
      expect(start, `${method} not found`).toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf('\n  }', start));
      expect(body, `${method} must gate on the production registry`).toContain('PRODUCTION_PROVIDERS.has(this)');
      expect(body, `${method} must use the privileged GET`).toContain('privilegedGetJson(');
      // The exported-transport branch must be explicitly caller-supplied.
      expect(body, `${method}'s exported-transport branch must stay untrusted`).toMatch(/executeRead[\s\S]*false\)/);
    }
  });

  /**
   * [F14-02 4A.1 §6] The privileged GET reimplements no endpoint semantics: its
   * paths must stay byte-identical to transport.ts's frozen definitions.
   */
  it('privileged production endpoint paths stay in sync with the transport endpoint map', () => {
    const evidence = readFileSync(path.join(REPO_ROOT, 'src/integration/coindcx/paper-evidence.ts'), 'utf8');
    const transport = readFileSync(path.join(REPO_ROOT, 'src/integration/coindcx/transport.ts'), 'utf8');
    for (const literal of ['/market_data/v3/orderbook/{pair}-futures/{depth}', '/api/v1/derivatives/futures/data/conversions']) {
      expect(evidence.includes(literal), `paper-evidence must pin ${literal}`).toBe(true);
      expect(transport.includes(literal), `transport must still define ${literal}`).toBe(true);
    }
  });

  /**
   * [F14-03] Instrument trust must close directly over a module-private native
   * acquisition primitive. Exported transports/readers remain useful to public
   * clients, but neither may sit on the production issuer's privileged path.
   */
  it('production instrument authority uses an unexported primitive with no transport/reader injection', () => {
    const authorityFile = 'src/integration/coindcx/instrument-authority.ts';
    const authorityPath = path.join(REPO_ROOT, authorityFile);
    const source = readFileSync(authorityPath, 'utf8');
    const primitive = 'privilegedAcquireProductionInstrument';

    expect(source).toContain(`async function ${primitive}(pair: string)`);
    expect(source).toContain(`const instrument = await ${primitive}(pair);`);
    expect(source).not.toMatch(/import[^;]+CoinDcxTransport[^;]+from ['"]\.\/transport['"]/s);
    expect(source).not.toMatch(/import[^;]+readInrFuturesInstrument[^;]+from ['"]\.\/instrument-reader['"]/s);
    expect(source).not.toContain('.executeRead(');

    const acquireStart = source.indexOf('export async function acquireProductionInstrumentBinding(');
    expect(acquireStart).toBeGreaterThan(-1);
    const acquireSignature = source.slice(acquireStart, source.indexOf('{', acquireStart));
    expect(acquireSignature).toBe('export async function acquireProductionInstrumentBinding(pair: string): Promise<TrustedProductionInstrumentBinding> ');
    for (const seam of ['transport', 'reader', 'client', 'callback', 'http', 'token', 'issuer']) {
      expect(acquireSignature.toLowerCase()).not.toContain(seam);
    }

    const readFile = (file: string): string => readFileSync(file, 'utf8');
    const ownExports = collectPublicExportNames(authorityPath, readFile, () => null);
    expect(ownExports.has(primitive), `${primitive} must stay private even to deep import`).toBe(false);

    const exportOffenders: string[] = [];
    for (const absFile of listSourceFiles(SRC_ROOT)) {
      const code = readFileSync(absFile, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const line of code.split(/\r?\n/)) {
        if (line.includes('export') && line.includes(primitive)) {
          exportOffenders.push(`${path.relative(REPO_ROOT, absFile).split(path.sep).join('/')}: ${line.trim()}`);
        }
      }
    }
    expect(exportOffenders, 'the privileged instrument primitive must have zero runtime exports').toEqual([]);
  });

  it('normal production barrels do not expose Wave3-A trust minting or binding internals', () => {
    const forbiddenExports = [
      'acquireProductionInstrumentBinding',
      'TrustedProductionInstrumentBinding',
      'INSTRUMENT_BINDING_ISSUER',
      'issueBinding',
      // [F14-02] Market-evidence acquisition internals and fake-provider helpers.
      'PRODUCTION_ACQUISITION_CAPABILITY',
      'PRODUCTION_PROVIDERS',
      'GENUINE_PROVIDERS',
      'acquisitionFor',
      'FakeCoinDcxSocket',
      'FakeCoinDcxSocketFactory',
      // [F14-02 4A.1] The privileged acquisition implementation.
      'privilegedGetJson',
      'PrivilegedProductionSocket',
      // [F14-03] The privileged instrument acquisition implementation.
      'privilegedAcquireProductionInstrument',
    ];
    const readFile = (f: string): string => readFileSync(f, 'utf8');
    const allFiles = new Set(listSourceFiles(SRC_ROOT));
    const resolveSpecifier = (fromAbsFile: string, specifier: string): string | null => resolveLocalSpecifier(fromAbsFile, specifier, allFiles);
    for (const barrel of PUBLIC_BARRELS) {
      const exported = collectPublicExportNames(path.join(REPO_ROOT, barrel), readFile, resolveSpecifier);
      for (const name of forbiddenExports) expect(exported.has(name), `${barrel} must not export ${name}`).toBe(false);
    }
  });
});
