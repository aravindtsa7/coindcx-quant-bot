import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeModuleReferences, buildImportGraph } from './support/import-graph';

// M2 W1: the shared REST limiter scheduler/protocol is pure and unwired. It imports only its own files, `zod` and
// `node:util`; it reads no clock and performs no I/O; no production module imports it (W2-W6 are not authorized).
const REPO_ROOT = path.resolve(__dirname, '../..');
const DIR = 'src/integration/coindcx/rate-limit/';
const { graph, files } = buildImportGraph(path.join(REPO_ROOT, 'src'), REPO_ROOT);
const limiterFiles = files.filter((file) => file.startsWith(DIR));
const code = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('M2 W1 rate-limit boundary', () => {
  it('contains exactly the reviewed W1 files', () => {
    expect(limiterFiles).toEqual([`${DIR}client-protocol.ts`, `${DIR}config.ts`, `${DIR}index.ts`, `${DIR}retry-after.ts`, `${DIR}scheduler.ts`]);
  });

  it('imports only its own files, zod and node:util (no dynamic loads)', () => {
    for (const file of limiterFiles) {
      const analysis = analyzeModuleReferences(readFileSync(path.join(REPO_ROOT, file), 'utf8'), file);
      expect(analysis.unresolvedDynamicLoads).toEqual([]);
      for (const specifier of analysis.specifiers) {
        if (specifier.startsWith('.')) expect(specifier).toMatch(/^\.\/[a-z-]+$/);
        else expect(['zod', 'node:util']).toContain(specifier);
      }
      for (const target of graph.get(file) ?? []) expect(target.startsWith(DIR)).toBe(true);
    }
  });

  it('reads no clock and performs no I/O, timers or randomness', () => {
    const forbidden = [/Date\.now\s*\(/, /new Date\(\s*\)/, /performance\./, /process\./, /setTimeout|setInterval|setImmediate|queueMicrotask/, /Math\.random/, /crypto/, /require\s*\(/, /\bawait\b|\basync\b|Promise/];
    for (const file of limiterFiles) for (const pattern of forbidden) expect(`${file}: ${String(code(file).match(pattern)?.[0] ?? '')}`).toBe(`${file}: `);
  });

  it('is unwired: no module outside the directory imports it', () => {
    const importers = [...graph].filter(([file, edges]) => !file.startsWith(DIR) && edges.some((edge) => edge.startsWith(DIR))).map(([file]) => file);
    expect(importers).toEqual([]);
  });
});
