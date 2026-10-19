import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeModuleReferences, buildImportGraph } from './support/import-graph';

// M4 offline ownership-lineage export (unwired): it receives its snapshot through an injected structural port, so it
// imports neither the repository nor Prisma, constructs no client, reads no environment or credential, is composed by
// one explicit operator script (no campaign, engine or orchestrator), and persists only the diagnostic.
const REPO_ROOT = path.resolve(__dirname, '../..');
const MODULE = 'src/execution/live/ownership-lineage-export.ts';
const REPOSITORY = 'src/execution/live/repository.ts';
const OPERATOR_SCRIPT = 'scripts/m4-lineage-export.ts';
const { graph, files } = buildImportGraph(path.join(REPO_ROOT, 'src'), REPO_ROOT);
const raw = readFileSync(path.join(REPO_ROOT, MODULE), 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
const repository = readFileSync(path.join(REPO_ROOT, REPOSITORY), 'utf8').replace(/\r\n/g, '\n');

function scriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? scriptFiles(full) : /\.(ts|js|mjs|cjs)$/.test(name) ? [full] : [];
  });
}
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThan(0);
  const rest = source.slice(start);
  return rest.slice(0, rest.indexOf('\n  }\n'));
}

describe('M4 offline ownership-lineage export boundary', () => {
  it('imports only the diagnostic, the canonical hash and node crypto/fs/path; never the repository or Prisma', () => {
    const analysis = analyzeModuleReferences(raw, MODULE);
    expect([...analysis.specifiers].sort()).toEqual(['../../risk', './ownership-lineage-diagnostic', 'node:crypto', 'node:fs/promises', 'node:path']);
    expect(analysis.unresolvedDynamicLoads).toEqual([]);
    expect(files).toContain(MODULE);
    expect(graph.get(MODULE)?.includes(REPOSITORY)).toBe(false);
    expect(code).not.toMatch(/PrismaClient|@prisma|PrismaLiveExecutionRepository|\$transaction|\$queryRaw/);
  });

  it('has no src importers and only the reviewed explicit operator script under scripts', () => {
    expect(graph.has(MODULE)).toBe(true);
    expect([...graph].filter(([, edges]) => edges.includes(MODULE)).map(([file]) => file)).toEqual([]);
    for (const file of files.filter((candidate) => candidate !== MODULE)) {
      expect(/ownership-lineage-export|exportOfflineLineageDiagnostic|LineageSnapshotPort/.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')), file).toBe(false);
    }
    for (const file of scriptFiles(path.join(REPO_ROOT, 'scripts'))) {
      if (path.relative(REPO_ROOT, file).split(path.sep).join('/') === OPERATOR_SCRIPT) continue;
      expect(/ownership-lineage|readLineageDiagnosticSnapshot/.test(readFileSync(file, 'utf8')), file).toBe(false);
    }
    const script = readFileSync(path.join(REPO_ROOT, OPERATOR_SCRIPT), 'utf8');
    expect(analyzeModuleReferences(script, OPERATOR_SCRIPT).specifiers).toContain('../src/execution/live/ownership-lineage-export');
  });

  it('reads no environment, clock, network or credential, writes exclusively, and never builds a SyncLineage', () => {
    for (const pattern of [/process\.|\.env\b|apiKey|apiSecret|credential/i, /Date\.now|new Date\(|performance\.|Math\.random/,
      /fetch\(|node:https?|node:net|\.request\(/, /require\s*\(|\bimport\s*\(/, /SyncLineage|ownedOrders:|botTagNamespace:/,
      /rename\(|rm\(|unlink\(|writeFile\(\s*(?!text)|appendFile|copyFile|recursive: true/]) {
      expect(code, String(pattern)).not.toMatch(pattern);
    }
    expect(code).toContain("await open(file, 'wx', 0o600);");
    expect(code).toContain('await mkdir(directory, { mode: 0o700 });');
  });

  it('adds one repository snapshot read: one REPEATABLE READ interactive transaction, tx-only, plain reads, no writes', () => {
    const outer = methodBody(repository, 'public async readLineageDiagnosticSnapshot(');
    expect(outer).toContain('return this.#prisma.$transaction(');
    expect(outer).toContain('(tx) => this.#readLineageDiagnosticSnapshotWithin(tx as unknown as LineageSnapshotClient, accountId),');
    expect(outer).toContain('{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 },');
    const within = methodBody(repository, 'async #readLineageDiagnosticSnapshotWithin(');
    expect(within).toContain('await this.#listAccountOrderViewsWithin(tx, accountId);');
    expect(within).not.toMatch(/#prisma|\$executeRaw|\$queryRaw|FOR UPDATE|FOR SHARE|LOCK IN SHARE MODE|\.create\(|\.update|\.delete|\.upsert|this\.list|this\.load/);
    for (const read of ['tx.liveReconciliationFinding.findMany(', 'tx.livePracticalCertificate.findMany(', 'tx.livePositionOwnershipShare.count(',
      'tx.liveReconciliationState.findUnique(']) {
      expect(within.split(read)).toHaveLength(2);
    }
    expect(within.match(/where: \{ accountId[,\s}]/g)).toHaveLength(4);
    expect(within.match(/select: \{/g)).toHaveLength(3);
    // Reachable only from its public wrapper.
    expect(repository.split('#readLineageDiagnosticSnapshotWithin(')).toHaveLength(3);
  });
});
