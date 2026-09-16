import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildImportGraph, collectPublicExportNames, computeReachable, findPath,
  listSourceFiles, resolveLocalSpecifier, type ImportGraph,
} from './support/import-graph';

// [P15-ARCH] Static architecture proof for Phase15. Reuses the P14-J TRUE
// TRANSITIVE local TypeScript import graph (not a direct-import grep) to prove
// the Phase15 analytical boundary:
//
//   Phase15 may READ Phase12 research evidence. It may not reach live
//   execution, paper account economics, risk admission, the CoinDCX
//   integration surface, or the coin-runtime lifecycle registry — by ANY
//   transitive path, including a type-only import edge.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const RANKING_ROOT = 'src/ranking/';
const RANKING_BARREL = path.join(SRC_ROOT, 'ranking/index.ts');

const { files, graph, unresolved } = buildImportGraph(SRC_ROOT, REPO_ROOT);
const existingFiles = new Set(listSourceFiles(SRC_ROOT));
const rankingFiles = files.filter((file) => file.startsWith(RANKING_ROOT));

/** Every forbidden destination, as a repo-root-relative POSIX prefix. */
const FORBIDDEN_PREFIXES: readonly { readonly prefix: string; readonly why: string }[] = Object.freeze([
  { prefix: 'src/execution/', why: 'Phase14 paper execution / account economics' },
  { prefix: 'src/integration/', why: 'CoinDCX networking and order-capable client surface' },
  { prefix: 'src/coin-runtime/', why: 'coin runtime lifecycle registry (promotion mutation)' },
  { prefix: 'src/risk/', why: 'Phase13 risk / leverage policy' },
  { prefix: 'src/dispatch/', why: 'risk admission coordination' },
  { prefix: 'src/api/', why: 'HTTP surface' },
  { prefix: 'src/app/', why: 'process bootstrap / lifecycle' },
]);

function reachableFrom(root: string): ReadonlySet<string> {
  return computeReachable(graph, root);
}

function violation(root: string, prefix: string): readonly string[] | null {
  return findPath(graph, root, (node) => node.startsWith(prefix));
}

describe('Phase15 import graph is well-formed', () => {
  it('discovers the Phase15 source tree', () => {
    expect(rankingFiles.length).toBeGreaterThanOrEqual(10);
    expect(rankingFiles).toContain('src/ranking/index.ts');
    expect(rankingFiles).toContain('src/ranking/core.ts');
    expect(rankingFiles).toContain('src/ranking/engine.ts');
  });

  it('resolves every relative import in the repository (a silent miss would hide a violation)', () => {
    expect(unresolved).toEqual([]);
  });
});

describe('Phase15 analytical boundary', () => {
  it.each(FORBIDDEN_PREFIXES.map((entry) => [entry.prefix, entry.why] as const))(
    'no Phase15 file transitively reaches %s (%s)',
    (prefix) => {
      for (const file of rankingFiles) {
        const path0 = violation(file, prefix);
        expect(path0, `forbidden dependency path: ${(path0 ?? []).join(' -> ')}`).toBeNull();
      }
    },
  );

  it('the pure scoring core depends on nothing but decimal/canonical-JSON primitives', () => {
    const core = ['src/ranking/core.ts', 'src/ranking/normalize.ts', 'src/ranking/score.ts', 'src/ranking/tie-break.ts', 'src/ranking/identity.ts', 'src/ranking/numeric.ts', 'src/ranking/policy.ts'];
    for (const file of core) {
      for (const dependency of reachableFrom(file)) {
        if (dependency.startsWith(RANKING_ROOT)) continue;
        expect(dependency, `${file} reaches ${dependency}`).toMatch(/^src\/backtest\/(decimal|errors|canonical-json)\.ts$/);
      }
    }
  });

  it('the scoring core never depends on the Phase12 evidence adapter or the public entry point (layering direction)', () => {
    for (const file of ['src/ranking/core.ts', 'src/ranking/normalize.ts', 'src/ranking/score.ts', 'src/ranking/tie-break.ts', 'src/ranking/identity.ts']) {
      const reachable = reachableFrom(file);
      expect(reachable.has('src/ranking/evidence.ts')).toBe(false);
      expect(reachable.has('src/ranking/engine.ts')).toBe(false);
      expect(reachable.has('src/ranking/index.ts')).toBe(false);
    }
  });

  it('reaches Phase12 research validation only through the existing approval authority', () => {
    const reachable = reachableFrom('src/ranking/evidence.ts');
    expect(reachable.has('src/research/research-validation/approval-authority.ts')).toBe(true);
    // And the executor is reachable only because the approval authority itself
    // depends on the genuine-result registry, never because Phase15 re-runs it.
    expect(graph.get('src/ranking/evidence.ts')).toEqual([
      'src/ranking/errors.ts',
      'src/ranking/numeric.ts',
      'src/ranking/policy.ts',
      'src/ranking/types.ts',
      'src/research/research-validation/approval-authority.ts',
      'src/research/research-validation/types.ts',
    ]);
  });

  it('never re-runs Phase12 validation or Phase11 matrix execution from the ranking entry point', () => {
    const source = rankingFiles.map((file) => readFileSync(path.join(REPO_ROOT, file), 'utf8')).join('\n');
    for (const forbidden of ['executeResearchValidation', 'planResearchValidation', 'executeStrategyCoinMatrix', 'BacktestEngine']) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('never imports the process-wide Prisma singleton itself (the client is always injected)', () => {
    // Phase15's own persistence layer must not reach `src/persistence/prisma.ts`
    // at all, and no Phase15 file may name it directly.
    //
    // A ranking file that imports Phase12 TYPES does inherit a pre-existing
    // Phase12 edge (`research-validation/types` -> `strategy-coin-matrix/types`
    // -> `market-data/historical/index` -> `persistence/prisma`). That edge is
    // Phase12's, not Phase15's; refactoring it is out of Phase15 scope, and it
    // is asserted here so a future change to it is visible rather than silent.
    for (const file of ['src/ranking/persistence/ranking-repository.ts', 'src/ranking/persistence/prisma-ranking-store.ts', 'src/ranking/core.ts', 'src/ranking/normalize.ts', 'src/ranking/score.ts', 'src/ranking/tie-break.ts', 'src/ranking/identity.ts', 'src/ranking/policy.ts', 'src/ranking/numeric.ts']) {
      expect(reachableFrom(file).has('src/persistence/prisma.ts'), `${file} reaches the Prisma singleton`).toBe(false);
    }
    for (const file of rankingFiles) {
      expect(readFileSync(path.join(REPO_ROOT, file), 'utf8')).not.toMatch(/persistence\/prisma['"]/);
    }
    expect(findPath(graph, 'src/ranking/evidence.ts', (node) => node === 'src/persistence/prisma.ts')).toEqual([
      'src/ranking/evidence.ts',
      'src/research/research-validation/types.ts',
      'src/research/strategy-coin-matrix/types.ts',
      'src/market-data/historical/index.ts',
      'src/persistence/prisma.ts',
    ]);
  });
});

describe('Phase15 promotion firewall', () => {
  it('reaches no lifecycle transition function at all', () => {
    const reachable = new Set<string>();
    for (const file of rankingFiles) for (const node of reachableFrom(file)) reachable.add(node);
    expect(reachable.has('src/coin-runtime/registry.ts')).toBe(false);
    expect(reachable.has('src/coin-runtime/lifecycle.ts')).toBe(false);
  });

  it('declares no function whose name would mutate a lifecycle, promotion, or order', () => {
    const pattern = /^(transition|promote|approve|advance|set|mutate|place|create|submit|cancel|modify)[A-Za-z]*(Lifecycle|Promotion|Order|Account|Position|Admission)/;
    for (const file of rankingFiles) {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      for (const match of source.matchAll(/(?:function|const|public|private)\s+([A-Za-z_$][\w$]*)/g)) {
        expect(match[1] ?? '', `${file} declares ${match[1]}`).not.toMatch(pattern);
      }
    }
  });

  it('exposes no promoted lifecycle state as a value anywhere in the Phase15 source', () => {
    for (const file of rankingFiles) {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      // Strip block and line comments: the doc comments legitimately NAME the
      // states Phase15 must never emit. Only executable text is checked.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const forbidden of ['PAPER_APPROVED', 'LIVE_CANDIDATE', 'RESEARCH_APPROVED', "'SHADOW'", '"SHADOW"']) {
        expect(code, `${file} contains ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe('Phase15 public export surface', () => {
  const publicNames = collectPublicExportNames(
    RANKING_BARREL,
    (absFile) => readFileSync(absFile, 'utf8'),
    (fromAbsFile, specifier) => resolveLocalSpecifier(fromAbsFile, specifier, existingFiles),
  );

  it('exposes the authority-bound entry point', () => {
    expect(publicNames.has('rankStrategyCandidates')).toBe(true);
  });

  it('does NOT expose the pure scoring core, so a caller cannot rank fabricated metrics', () => {
    for (const internal of [
      'composeRankingRunSet', 'buildPairRankingRun', 'normalizeComponent', 'buildComponentScore',
      'computeCompositeScore', 'orderRankingCandidates', 'resolveTieBreakLevel',
      'computeRankingRunId', 'computeRankingResultSha256', 'computeRankingRunSha256', 'computeRankingRunSetSha256',
      'deriveAuthoritativeRankingEvidence', 'rankingEconomicFields', 'deepFreezeRanking',
    ]) {
      expect(publicNames.has(internal), `${internal} must not be on the Phase15 barrel`).toBe(false);
    }
  });

  it('does NOT expose a caller-constructible authoritative evidence type producer', () => {
    expect(publicNames.has('RankingCandidateEvidence')).toBe(false);
    expect(publicNames.has('RankingComponentMetric')).toBe(false);
  });

  it('exposes no symbol whose name implies mutation or promotion', () => {
    for (const name of publicNames) {
      expect(name).not.toMatch(/promote|approve|transition|execute|dispatch|place|submit|cancel/i);
    }
  });
});

describe('Phase15 does not alter the Phase14 boundary', () => {
  it('no Phase14 execution file imports Phase15', () => {
    const executionFiles = files.filter((file) => file.startsWith('src/execution/'));
    for (const file of executionFiles) {
      const path0 = findPath(graph as ImportGraph, file, (node) => node.startsWith(RANKING_ROOT));
      expect(path0, `Phase14 -> Phase15 dependency: ${(path0 ?? []).join(' -> ')}`).toBeNull();
    }
  });

  it('no Phase12 research file imports Phase15 (ranking stays downstream)', () => {
    for (const file of files.filter((entry) => entry.startsWith('src/research/'))) {
      expect(findPath(graph, file, (node) => node.startsWith(RANKING_ROOT))).toBeNull();
    }
  });
});
