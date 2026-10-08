import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeModuleReferences, buildImportGraph } from './support/import-graph';

// M3 (design for review): the practical observation evaluator is pure, self-contained and unwired. It cannot reach,
// mint or be reached by any authority, certificate, budget, gate, stream or production composition.
const REPO_ROOT = path.resolve(__dirname, '../..');
const MODULE = 'src/execution/live/practical-observation/assessment.ts';
const { graph, files } = buildImportGraph(path.join(REPO_ROOT, 'src'), REPO_ROOT);
const raw = readFileSync(path.join(REPO_ROOT, MODULE), 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('M3 practical observation evaluator boundary', () => {
  it('is the only file in its directory and imports nothing (no dynamic loads)', () => {
    expect(files.filter((file) => file.startsWith('src/execution/live/practical-observation/'))).toEqual([MODULE]);
    const analysis = analyzeModuleReferences(raw, MODULE);
    expect(analysis.specifiers).toEqual([]);
    expect(analysis.unresolvedDynamicLoads).toEqual([]);
    expect(graph.get(MODULE) ?? []).toEqual([]);
  });

  it('only the unwired M4 synchronization candidate imports it, and only its unwired orchestration imports that, so no production path can reach it', () => {
    const M4_ENGINE = 'src/execution/live/practical-synchronization/engine.ts';
    const M4_ORCHESTRATOR = 'src/execution/live/practical-synchronization/async-orchestrator.ts';
    const importers = [...graph].filter(([, edges]) => edges.includes(MODULE)).map(([file]) => file);
    expect(importers).toEqual([M4_ENGINE]);
    expect([...graph].filter(([, edges]) => edges.includes(M4_ENGINE)).map(([file]) => file)).toEqual([M4_ORCHESTRATOR]);
    for (const [file, edges] of graph) expect(edges, file).not.toContain(M4_ORCHESTRATOR);
    for (const file of files.filter((candidate) => candidate !== MODULE && candidate !== M4_ENGINE)) {
      expect(readFileSync(path.join(REPO_ROOT, file), 'utf8').includes('practical-observation'), file).toBe(false);
    }
  });

  it('reads no clock, configuration, environment or randomness and performs no I/O', () => {
    for (const pattern of [/Date\.now|new Date\(|performance\./, /process\./, /Math\.random|crypto/, /setTimeout|setInterval|setImmediate/, /require\s*\(|\bimport\s*\(/, /\bawait\b|\basync\b|Promise/]) {
      expect(code, String(pattern)).not.toMatch(pattern);
    }
  });

  it('mints no existing authority, readiness, continuity or strategy status, and every grant is a literal false', () => {
    expect(code).not.toMatch(/PROVEN_READY|ACCOUNT_CONTINUITY_PROVEN|authorityEligible\b|'SHADOW'|Certificate|Authorization|Enablement|issuer|consumeMutationPermit|bindProduction/);
    const grants = code.slice(code.indexOf('export const GRANTS_NOTHING'), code.indexOf('} as const);', code.indexOf('export const GRANTS_NOTHING')));
    const values = grants.match(/:\s*(\w+),/g) ?? [];
    expect(values.length).toBe(7);
    expect(values.every((value) => /:\s*false,/.test(value))).toBe(true);
    // Every result object carries the constant, never a computed grant.
    expect(code.match(/grants: GRANTS_NOTHING/g)?.length).toBeGreaterThanOrEqual(5);
    expect(code).not.toMatch(/grants:\s*\{/);
  });
});
