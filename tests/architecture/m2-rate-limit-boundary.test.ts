import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeModuleReferences, buildImportGraph } from './support/import-graph';

// M2 W1/W2 rate-limit boundary.
// W1: the scheduler/protocol files are pure: they import only each other, `zod` and `node:util`; read no clock; do no I/O.
// W2: the runtime (coordinator, client, durable store, IPC) imports only the pure W1 module, its own files, `zod`
// and a fixed set of Node built-ins.
// W3/W4: outside the rate-limit directory only the reviewed REST primitives and the budget port adapters import the
// limiter, and only its type-only budget interfaces; nothing outside imports the IPC runtime itself.
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
    expect(runtimeFiles).toEqual(['client.ts', 'config.ts', 'coordinator.ts', 'framing.ts', 'mutation-budget.ts', 'protocol.ts', 'read-budget.ts', 'read-probe.ts', 'state-store.ts'].map((f) => `${RUNTIME}${f}`));
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

  it('W3/W4 wiring: only the REST primitives and the budget port adapters import the limiter, and only its budget interfaces', () => {
    const importers = [...graph].filter(([file, edges]) => !file.startsWith(DIR) && edges.some((edge) => edge.startsWith(DIR)));
    const limiterEdges = Object.fromEntries(importers.map(([file, edges]) => [file, edges.filter((edge) => edge.startsWith(DIR)).sort()]));
    const read = [`${RUNTIME}read-budget.ts`], mutation = [`${RUNTIME}mutation-budget.ts`];
    expect(limiterEdges).toEqual({
      'src/integration/coindcx/client.ts': read, 'src/integration/coindcx/instrument-authority.ts': read,
      'src/integration/coindcx/paper-evidence.ts': read, 'src/integration/coindcx/transport.ts': read,
      // W4: the order-mutation transport (mutation permits for create/cancel, a read permit for order observation) and
      // the integration-layer implementations of the two execution budget ports.
      'src/integration/coindcx/live/mutation-transport.ts': [...mutation, ...read],
      'src/integration/coindcx/live/mutation-budget-ports.ts': mutation,
      // W5: the candle-reader primitive (read permits for every candle request).
      'src/market-data/rest-candle-reader.ts': read,
    });
    // Both budget modules have type-only imports, so no primitive loads the IPC runtime (node:net).
    for (const budgetModule of ['read-budget.ts', 'mutation-budget.ts']) {
      const imports = readFileSync(path.join(REPO_ROOT, `${RUNTIME}${budgetModule}`), 'utf8').split(/\r?\n/).filter((line) => /^import /.test(line));
      expect(imports.every((line) => line.startsWith('import type ')), budgetModule).toBe(true);
    }
    // The limiter imports no execution (or any other non-limiter) module; the port adapters live in the integration layer.
    for (const [file, edges] of graph) if (file.startsWith(DIR)) expect(edges.filter((edge) => !edge.startsWith(DIR))).toEqual([]);
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
