import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeModuleReferences, buildImportGraph } from './support/import-graph';

// M2 W1/W2 rate-limit boundary.
// W1: the scheduler/protocol files are pure: they import only each other, `zod` and `node:util`; read no clock; do no I/O.
// W2: the runtime (coordinator, client, durable store, IPC) imports only the pure W1 module, its own files, `zod`
// and a fixed set of Node built-ins. Nothing outside the rate-limit directory imports either (unwired: no provider
// request or mutation path uses the limiter; W3-W6 are not authorized).
const REPO_ROOT = path.resolve(__dirname, '../..');
const DIR = 'src/integration/coindcx/rate-limit/';
const RUNTIME = `${DIR}runtime/`;
const { graph, files } = buildImportGraph(path.join(REPO_ROOT, 'src'), REPO_ROOT);
const pureFiles = files.filter((file) => file.startsWith(DIR) && !file.startsWith(RUNTIME));
const runtimeFiles = files.filter((file) => file.startsWith(RUNTIME));
const code = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const specifiers = (file: string) => analyzeModuleReferences(readFileSync(path.join(REPO_ROOT, file), 'utf8'), file);

describe('M2 W1 rate-limit boundary (pure scheduler/protocol)', () => {
  it('contains exactly the reviewed W1 files', () => {
    expect(pureFiles).toEqual([`${DIR}client-protocol.ts`, `${DIR}config.ts`, `${DIR}index.ts`, `${DIR}retry-after.ts`, `${DIR}scheduler.ts`]);
  });

  it('imports only its own files, zod and node:util (no dynamic loads)', () => {
    for (const file of pureFiles) {
      const analysis = specifiers(file);
      expect(analysis.unresolvedDynamicLoads).toEqual([]);
      for (const specifier of analysis.specifiers) {
        if (specifier.startsWith('.')) expect(specifier).toMatch(/^\.\/[a-z-]+$/);
        else expect(['zod', 'node:util']).toContain(specifier);
      }
      for (const target of graph.get(file) ?? []) expect(pureFiles).toContain(target);
    }
  });

  it('reads no clock and performs no I/O, timers or randomness', () => {
    const forbidden = [/Date\.now\s*\(/, /new Date\(\s*\)/, /performance\./, /process\./, /setTimeout|setInterval|setImmediate|queueMicrotask/, /Math\.random/, /crypto/, /require\s*\(/, /\bawait\b|\basync\b|Promise/];
    for (const file of pureFiles) for (const pattern of forbidden) expect(`${file}: ${String(code(file).match(pattern)?.[0] ?? '')}`).toBe(`${file}: `);
  });

  it('the pure entry point does not re-export the W2 runtime', () => {
    expect(code(`${DIR}index.ts`)).not.toMatch(/runtime/);
  });
});

describe('M2 W2 rate-limit runtime boundary', () => {
  it('contains exactly the reviewed W2 files', () => {
    expect(runtimeFiles).toEqual(['client.ts', 'config.ts', 'coordinator.ts', 'framing.ts', 'protocol.ts', 'read-budget.ts', 'read-probe.ts', 'state-store.ts'].map((f) => `${RUNTIME}${f}`));
  });

  it('imports only the pure W1 module, its own files, zod and a fixed set of Node built-ins', () => {
    const allowedExternal = ['zod', 'node:crypto', 'node:fs', 'node:net', 'node:path', 'node:perf_hooks', 'node:util'];
    for (const file of runtimeFiles) {
      const analysis = specifiers(file);
      expect(analysis.unresolvedDynamicLoads).toEqual([]);
      for (const specifier of analysis.specifiers) {
        if (specifier.startsWith('.')) expect(specifier).toMatch(/^(\.\/[a-z-]+|\.\.\/(index|config))$/);
        else expect(allowedExternal).toContain(specifier);
      }
      for (const target of graph.get(file) ?? []) expect(target.startsWith(DIR)).toBe(true);
    }
  });

  it('network use is local named-pipe IPC only; crypto is hashing and random identifiers only', () => {
    for (const file of runtimeFiles) expect(code(file)).not.toMatch(/node:(http|https|tls|dgram|dns|child_process|worker_threads)|createHmac|createSign|apiSecret|apiKey/);
    expect(code(`${RUNTIME}coordinator.ts`).match(/\.listen\([^,)]*/g)).toEqual(['.listen(config.pipePath']);
    expect(code(`${RUNTIME}client.ts`).match(/net\.connect\([^)]*\)/g)).toEqual(['net.connect(this.#config.pipePath)']);
    expect(code(`${RUNTIME}config.ts`)).toContain(String.raw`const PIPE = /^\\\\\.\\pipe\\`);
  });

  it('W3 wiring: only the three read primitives and the read client import the limiter, and only the read-budget interface', () => {
    const importers = [...graph].filter(([file, edges]) => !file.startsWith(DIR) && edges.some((edge) => edge.startsWith(DIR)));
    expect(importers.map(([file]) => file).sort()).toEqual([
      'src/integration/coindcx/client.ts', 'src/integration/coindcx/instrument-authority.ts', 'src/integration/coindcx/paper-evidence.ts', 'src/integration/coindcx/transport.ts',
    ]);
    for (const [, edges] of importers) expect(edges.filter((edge) => edge.startsWith(DIR))).toEqual([`${RUNTIME}read-budget.ts`]);
    // The read-budget module has type-only imports, so no read primitive loads the IPC runtime (node:net).
    const imports = readFileSync(path.join(REPO_ROOT, `${RUNTIME}read-budget.ts`), 'utf8').split(/\r?\n/).filter((line) => /^import /.test(line));
    expect(imports.every((line) => line.startsWith('import type '))).toBe(true);
    // Nothing imports the coordinator, the IPC client, the store or the probe responder outside the runtime.
    for (const [file, edges] of graph) if (!file.startsWith(RUNTIME)) for (const target of ['coordinator', 'client', 'state-store', 'read-probe', 'framing']) expect(edges).not.toContain(`${RUNTIME}${target}.ts`);
  });

  it('never passes the optional trusted-clock or elapsed-time inputs, and offers no reset from UNKNOWN', () => {
    const coordinator = code(`${RUNTIME}coordinator.ts`);
    expect(coordinator).toMatch(/localClockTrusted: false/);
    expect(coordinator).not.toMatch(/localClockTrusted: true|SAME_BOOT_ELAPSED|TERMINATION_EVIDENCE|HOOK_REGISTERED/);
    expect(coordinator).toMatch(/restoreLimiterState\([^)]*, null\)/);
  });
});
