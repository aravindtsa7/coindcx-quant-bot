import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeModuleReferences, buildImportGraph } from './support/import-graph';

// M4 (unwired review candidate): the read-only synchronization engine is driven only by an injected source. It reaches
// only the M3 evaluator and the reconciliation evidence types, and nothing in src reaches it.
const REPO_ROOT = path.resolve(__dirname, '../..');
const MODULE = 'src/execution/live/practical-synchronization/engine.ts';
const { graph, files } = buildImportGraph(path.join(REPO_ROOT, 'src'), REPO_ROOT);
const raw = readFileSync(path.join(REPO_ROOT, MODULE), 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('M4 practical synchronization candidate boundary', () => {
  it('is the only file in its directory; imports only the M3 evaluator and (type-only) the reconciliation evidence types', () => {
    expect(files.filter((file) => file.startsWith('src/execution/live/practical-synchronization/'))).toEqual([MODULE]);
    const analysis = analyzeModuleReferences(raw, MODULE);
    expect([...analysis.specifiers].sort()).toEqual(['../practical-observation/assessment', '../reconciliation/types']);
    expect(analysis.unresolvedDynamicLoads).toEqual([]);
    expect([...(graph.get(MODULE) ?? [])].sort()).toEqual(['src/execution/live/practical-observation/assessment.ts', 'src/execution/live/reconciliation/types.ts']);
    expect(raw).toContain("import type { LiveVenueOrderEvidence, LiveVenuePositionEvidence } from '../reconciliation/types';");
    // The evidence-types module itself imports nothing, so the engine reaches no authority path through it.
    expect(graph.get('src/execution/live/reconciliation/types.ts') ?? []).toEqual([]);
  });

  it('nothing in src imports it or names it, so no production path can reach it', () => {
    for (const [file, edges] of graph) expect(edges, file).not.toContain(MODULE);
    for (const file of files.filter((candidate) => candidate !== MODULE)) {
      expect(readFileSync(path.join(REPO_ROOT, file), 'utf8').includes('practical-synchronization'), file).toBe(false);
    }
  });

  it('performs no I/O, reads no clock or environment, and names no gateway, transport, database or HTTP client', () => {
    for (const pattern of [/Date\.now|new Date\(|performance\./, /process\./, /Math\.random|crypto/, /setTimeout|setInterval|setImmediate/,
      /require\s*\(|\bimport\s*\(/, /\bawait\b|\basync\b|Promise/, /fetch\(|http|Prisma|Gateway|Transport|RateLimit|budget/i]) {
      expect(code, String(pattern)).not.toMatch(pattern);
    }
  });

  it('mints no authority, never renames client_id, and every result carries the constant GRANTS_NOTHING', () => {
    expect(code).not.toMatch(/PROVEN_READY|ACCOUNT_CONTINUITY_PROVEN|authorityEligible\b|'SHADOW'|Certificate|Authorization|Enablement|issuer/);
    expect(code).not.toMatch(/\[['"]client_id['"]\]|\.client_id\b/); // the order evidence's client_order_id is never re-read as client_id
    expect(code).not.toMatch(/grants:\s*\{/);
    expect(code.match(/grants: GRANTS_NOTHING/g)?.length).toBe(2);
  });
});
