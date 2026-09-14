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
    // expose only read (`executeRead`, `listXxx`/`getXxx`) methods — no
    // create/place/cancel/modify/submit/amend/delete/new *Order* symbol
    // exists anywhere else in this repository today. LIVE_EXECUTION = NOT_IMPLEMENTED.
    expect(hits).toEqual([]);
  });

  it('the P14-I paper production root does not transitively reach any live-mutation sink (the sink set is empty by repository-wide evidence, not a filename guess)', () => {
    const { graph, files } = buildImportGraph(SRC_ROOT, REPO_ROOT);
    const scannedFiles = listSourceFiles(SRC_ROOT).filter((f) => !posix(path.relative(SRC_ROOT, f)).startsWith('backtest/'));
    const sinkHits = findMutatingOrderSymbols(scannedFiles, (f) => readFileSync(f, 'utf8'));
    const sinkFiles = new Set(sinkHits.map((h) => posix(path.relative(REPO_ROOT, h.file))));
    expect(files).toContain(PAPER_PRODUCTION_ROOT);
    const reachable = computeReachable(graph, PAPER_PRODUCTION_ROOT);
    const reached = [...reachable].filter((n) => sinkFiles.has(n));
    expect(reached).toEqual([]);
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
});
