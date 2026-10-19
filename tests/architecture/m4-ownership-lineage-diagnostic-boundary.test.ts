import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeModuleReferences, buildImportGraph } from './support/import-graph';

// M4 offline ownership-lineage diagnostic (restricted D1-D4 candidate): a pure transformer over injected rows. It is
// never a SyncLineage, offers no conversion to one, is composed by nothing (engine, orchestrator, campaign, scripts),
// and reads no database, clock, environment or credential of its own.
const REPO_ROOT = path.resolve(__dirname, '../..');
const MODULE = 'src/execution/live/ownership-lineage-diagnostic.ts';
/** The single reviewed importer (offline export; itself composed by nothing, see its own boundary test). */
const EXPORT = 'src/execution/live/ownership-lineage-export.ts';
const { graph, files } = buildImportGraph(path.join(REPO_ROOT, 'src'), REPO_ROOT);
const raw = readFileSync(path.join(REPO_ROOT, MODULE), 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

function scriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? scriptFiles(full) : /\.(ts|js|mjs|cjs)$/.test(name) ? [full] : [];
  });
}

describe('M4 offline ownership-lineage diagnostic boundary', () => {
  it('imports only pure live helpers and the state type (no repository, persistence or candidate module)', () => {
    const analysis = analyzeModuleReferences(raw, MODULE);
    expect([...analysis.specifiers].sort()).toEqual(['../../risk', './decimal', './identity', './types']);
    expect(analysis.unresolvedDynamicLoads).toEqual([]);
    expect(raw.split(/\r?\n/).filter((line) => /^import /.test(line))).toEqual([
      "import { sha256CanonicalJson } from '../../risk';",
      "import { canonicalPositiveLiveDecimal } from './decimal';",
      "import { LIVE_CLIENT_ORDER_ID_PATTERN, LIVE_CLIENT_ORDER_ID_PREFIX } from './identity';",
      "import type { LiveOrderStateName } from './types';",
    ]);
    // Guards against a vacuous graph check: the module must be a known node of the src import graph.
    expect(files).toContain(MODULE);
    expect(graph.has(MODULE)).toBe(true);
    expect(graph.get(MODULE)?.filter((edge) => /practical-synchronization|practical-observation|reconciliation|integration\//.test(edge)) ?? []).toEqual([]);
  });

  it('is imported only by the one offline export adapter, and named by nothing else in src or scripts', () => {
    expect([...graph].filter(([, edges]) => edges.includes(MODULE)).map(([file]) => file)).toEqual([EXPORT]);
    for (const file of files.filter((candidate) => candidate !== MODULE && candidate !== EXPORT)) {
      const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(/ownership-lineage-diagnostic|buildOfflineLineageDiagnostic|OFFLINE_LINEAGE_DIAGNOSTIC/.test(text), file).toBe(false);
    }
    for (const file of scriptFiles(path.join(REPO_ROOT, 'scripts'))) {
      expect(/ownership-lineage-diagnostic|buildOfflineLineageDiagnostic/.test(readFileSync(file, 'utf8')), file).toBe(false);
    }
  });

  it('never names, builds or converts to a SyncLineage', () => {
    expect(code).not.toMatch(/SyncLineage|ownedOrders|ambiguousCreates|closedIntentTags|ownedPositions|botTagNamespace|kind: 'UNAVAILABLE'/);
    expect(code).not.toMatch(/export (function|const) \w*(To|As|Into)(Sync)?Lineage|toSyncLineage|asLineage/i);
    expect(code.match(/^export function \w+/gm)).toEqual(['export function buildOfflineLineageDiagnostic']);
  });

  it('reads no database, clock, environment, network or credential, and never spreads a supplied row', () => {
    for (const pattern of [/PrismaClient|\$transaction|\$queryRaw|\$executeRaw|prisma\./i, /Date\.now|new Date\(|performance\.|process\./,
      /node:|require\s*\(|\bimport\s*\(|fetch\(|\.request\(/, /apiKey|apiSecret|\.env\b|credential/i, /Math\.random|setTimeout|setInterval/,
      /\.\.\.(row|value|input|rows|statements|finding|order)\b/, /JSON\.parse|evidenceJson|evidence_json|resolvedBy|\bnote\b/]) {
      expect(code, String(pattern)).not.toMatch(pattern);
    }
  });
});
