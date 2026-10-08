import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeModuleReferences, buildImportGraph } from './support/import-graph';

// M4 (unwired review candidates): the read-only synchronization engine and the asynchronous orchestration over it.
// The engine reaches only the M3 evaluator and the reconciliation evidence types; only the orchestration imports the
// engine; nothing in src imports either candidate entry point.
const REPO_ROOT = path.resolve(__dirname, '../..');
const ENGINE = 'src/execution/live/practical-synchronization/engine.ts';
const ORCHESTRATOR = 'src/execution/live/practical-synchronization/async-orchestrator.ts';
const { graph, files } = buildImportGraph(path.join(REPO_ROOT, 'src'), REPO_ROOT);
const rawOf = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const codeOf = (file: string): string => rawOf(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('M4 practical synchronization candidate boundary', () => {
  it('the directory holds exactly the engine and the orchestration; the engine imports only the M3 evaluator and (type-only) the evidence types', () => {
    expect(files.filter((file) => file.startsWith('src/execution/live/practical-synchronization/'))).toEqual([ORCHESTRATOR, ENGINE]);
    const analysis = analyzeModuleReferences(rawOf(ENGINE), ENGINE);
    expect([...analysis.specifiers].sort()).toEqual(['../practical-observation/assessment', '../reconciliation/types']);
    expect(analysis.unresolvedDynamicLoads).toEqual([]);
    expect([...(graph.get(ENGINE) ?? [])].sort()).toEqual(['src/execution/live/practical-observation/assessment.ts', 'src/execution/live/reconciliation/types.ts']);
    expect(rawOf(ENGINE)).toContain("import type { LiveVenueOrderEvidence, LiveVenuePositionEvidence } from '../reconciliation/types';");
    // The evidence-types module itself imports nothing, so the engine reaches no authority path through it.
    expect(graph.get('src/execution/live/reconciliation/types.ts') ?? []).toEqual([]);
  });

  it('the orchestration imports only the engine', () => {
    const analysis = analyzeModuleReferences(rawOf(ORCHESTRATOR), ORCHESTRATOR);
    expect(analysis.specifiers).toEqual(['./engine']);
    expect(analysis.unresolvedDynamicLoads).toEqual([]);
    expect(graph.get(ORCHESTRATOR) ?? []).toEqual([ENGINE]);
  });

  it('only the orchestration imports the engine; nothing imports the orchestration; nothing else names either', () => {
    expect([...graph].filter(([, edges]) => edges.includes(ENGINE)).map(([file]) => file)).toEqual([ORCHESTRATOR]);
    for (const [file, edges] of graph) expect(edges, file).not.toContain(ORCHESTRATOR);
    for (const file of files.filter((candidate) => candidate !== ENGINE && candidate !== ORCHESTRATOR)) {
      expect(rawOf(file).includes('practical-synchronization'), file).toBe(false);
    }
  });

  it('the engine performs no I/O, reads no clock or environment, and names no gateway, transport, database or HTTP client', () => {
    for (const pattern of [/Date\.now|new Date\(|performance\./, /process\./, /Math\.random|crypto/, /setTimeout|setInterval|setImmediate/,
      /require\s*\(|\bimport\s*\(/, /\bawait\b|\basync\b|Promise/, /fetch\(|http|Prisma|Gateway|Transport|RateLimit|budget/i]) {
      expect(codeOf(ENGINE), String(pattern)).not.toMatch(pattern);
    }
  });

  it('the orchestration uses only its injected clock and source: no real timers, clock, environment, network, database or budget', () => {
    for (const pattern of [/Date\.now|new Date\(|performance\./, /process\./, /Math\.random|crypto/, /setTimeout|setInterval|setImmediate/,
      /require\s*\(|\bimport\s*\(/, /fetch\(|http|Prisma|Gateway|Transport|RateLimit|budget|credential|apiKey|apiSecret/i]) {
      expect(codeOf(ORCHESTRATOR), String(pattern)).not.toMatch(pattern);
    }
  });

  it('mints no authority, never renames client_id, never clears the latch, and every result carries the constant GRANTS_NOTHING', () => {
    for (const file of [ENGINE, ORCHESTRATOR]) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/PROVEN_READY|ACCOUNT_CONTINUITY_PROVEN|authorityEligible\b|'SHADOW'|Certificate|Authorization|Enablement|issuer/);
      expect(code, file).not.toMatch(/\[['"]client_id['"]\]|\.client_id\b/);
      expect(code, file).not.toMatch(/grants:\s*\{/);
      expect(code, file).not.toMatch(/reconciliationRequired/);
      // The latch is never cleared or overridden: the only literal false is the engine's disconnected "unavailable"
      // observation, which always revokes.
      const latchFalse = code.split('\n').filter((line) => /reconnectLatched:\s*false/.test(line));
      expect(latchFalse.every((line) => line.includes('connected: false')), file).toBe(true);
      expect(latchFalse.length, file).toBe(file === ENGINE ? 1 : 0);
    }
    expect(codeOf(ENGINE).match(/grants: GRANTS_NOTHING/g)?.length).toBe(2);
    expect(codeOf(ORCHESTRATOR).match(/grants: GRANTS_NOTHING/g)?.length).toBe(1);
  });
});
