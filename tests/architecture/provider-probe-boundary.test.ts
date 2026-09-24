import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildImportGraph, computeReachable, extractImportSpecifiers } from './support/import-graph';

// The read-only CoinDCX provider probe lives OUTSIDE src/ (scripts/provider-probe)
// so it adds no production network owner, signer importer, or signing site to
// the pinned production capability surface. This file proves it cannot reach
// any mutation authority, Phase 17 live execution, or the Phase 18 continuity
// gate, even transitively through the src/ modules it does import.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const PROBE_DIR = 'scripts/provider-probe';
const PROBE_FILES = [
  ...readdirSync(path.join(REPO_ROOT, PROBE_DIR)).filter((file) => file.endsWith('.ts')).map((file) => `${PROBE_DIR}/${file}`),
  'scripts/coindcx-readonly-provider-probe.ts',
].sort();

const FORBIDDEN_TARGETS = [
  'src/integration/coindcx/live/mutation-transport.ts',
  'src/integration/coindcx/live/order-gateway.ts',
  'src/integration/coindcx/live/production-runtime.ts',
  'src/integration/coindcx/live/endpoints.ts',
  'src/execution/live/service.ts',
  'src/execution/live/reconciliation/barrier.ts',
  'src/execution/live/reconciliation/service.ts',
];

function codeOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(path.join(REPO_ROOT, fromFile)), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return path.relative(REPO_ROOT, candidate).split(path.sep).join('/');
  }
  throw new Error(`unresolved local import ${specifier} from ${fromFile}`);
}

describe('read-only provider probe isolation', () => {
  const { graph } = buildImportGraph(SRC_ROOT, REPO_ROOT);
  const srcImports = new Set<string>();
  const externalImports = new Set<string>();
  const otherLocalImports: string[] = [];
  for (const file of PROBE_FILES) {
    for (const specifier of extractImportSpecifiers(readFileSync(path.join(REPO_ROOT, file), 'utf8'), file)) {
      const resolved = resolveLocal(file, specifier);
      if (resolved === null) externalImports.add(specifier);
      else if (resolved.startsWith('src/')) srcImports.add(resolved);
      else if (!resolved.startsWith(`${PROBE_DIR}/`)) otherLocalImports.push(`${file} -> ${resolved}`);
    }
  }

  it('imports nothing local outside the probe directory and src/', () => {
    expect(otherLocalImports).toEqual([]);
  });

  it('discovers the probe files', () => {
    expect(PROBE_FILES).toEqual([
      'scripts/coindcx-readonly-provider-probe.ts',
      `${PROBE_DIR}/allowlist.ts`, `${PROBE_DIR}/report.ts`, `${PROBE_DIR}/rest-probe.ts`,
      `${PROBE_DIR}/run.ts`, `${PROBE_DIR}/sanitize.ts`, `${PROBE_DIR}/ws-probe.ts`,
    ].sort());
  });

  it('imports only the reviewed read-side production modules', () => {
    expect([...srcImports].sort()).toEqual([
      'src/integration/coindcx/signer.ts',
      'src/integration/coindcx/transport.ts',
    ]);
    expect([...externalImports].sort()).toEqual(['dotenv/config', 'lossless-json', 'node:child_process', 'node:crypto', 'node:fs', 'node:path', 'node:perf_hooks', 'socket.io-client']);
  });

  it('has no dependency path to any mutation authority, Phase 17 live execution, or the continuity gate', () => {
    for (const imported of srcImports) {
      const reachable = new Set([imported, ...computeReachable(graph, imported)]);
      expect(FORBIDDEN_TARGETS.filter((target) => reachable.has(target)), `${imported} reaches a forbidden module`).toEqual([]);
      expect([...reachable].filter((node) => node.startsWith('src/execution/')), `${imported} reaches execution`).toEqual([]);
    }
  });

  it('names no mutation operation, live-execution entry point, or continuity capability', () => {
    for (const file of PROBE_FILES) {
      const code = codeOf(file);
      for (const forbidden of [
        'openLive', 'cancelLive', 'closeLive', 'cancelOrder', 'createOrder', 'placeOrder', 'orders/create', 'orders/cancel',
        'mintLive', 'LiveExecutionService', 'requireCurrentReconciliation', 'currentAccountContinuityCapability',
        'CoinDcxOrderMutationTransport', 'hft-api', 'hft_api',
      ]) {
        expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
    }
  });

  describe('emits on the socket only through the guarded private-channel join', () => {
    const wsFile = `${PROBE_DIR}/ws-probe.ts`;
    const wsCode = codeOf(wsFile);
    const interfaceBody = (name: string): string => {
      const match = new RegExp(`interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(wsCode);
      if (match === null) throw new Error(`interface ${name} not found`);
      return match[1]!;
    };

    it('the production-facing socket type has no generic emit, only the semantic join', () => {
      const surface = interfaceBody('ProbeSocket');
      expect(surface).not.toMatch(/\bemit\b/);
      expect(surface).toMatch(/joinPrivateAccountChannel\(apiKey: string, signer: RequestSigner\): void;/);
      // The factory hands out that safe type, never the raw socket type.
      expect(wsCode).toMatch(/export type ProbeSocketFactory = \(origin: typeof PROBE_SOCKET_ORIGIN\) => ProbeSocket;/);
    });

    it('the raw socket.io type and object stay module-private', () => {
      expect(wsCode).toMatch(/^interface RawIoSocket \{/m);
      expect(wsCode).not.toMatch(/export\s+(?:interface|type|class|const|let|function)\s+\w*Raw/);
      expect(wsCode).not.toMatch(/export\s*\{/);
      for (const file of PROBE_FILES.filter((entry) => entry !== wsFile)) expect(codeOf(file), file).not.toMatch(/RawIoSocket|ProbeRawSocket/);
    });

    it('has exactly one application-level raw emit in the probe, inside joinPrivateAccountChannel, dominated by the guard', () => {
      const emitSites = PROBE_FILES.flatMap((file) => (codeOf(file).match(/\.emit\(/g) ?? []).map(() => file));
      expect(emitSites).toEqual([wsFile]);
      // The only `emit` tokens: the raw type's declaration and that one call.
      expect(wsCode.match(/\bemit\b/g)).toHaveLength(2);
      expect(wsCode).toMatch(/emit\(event: string, \.\.\.args: unknown\[\]\): void;/);
      const join = /joinPrivateAccountChannel: \(apiKey, signer\) => \{([\s\S]*?)\n {4}\},/.exec(wsCode);
      expect(join).not.toBeNull();
      expect(join![1]!.trim().split('\n').map((line) => line.trim())).toEqual([
        'const payload = { channelName: PROBE_PRIVATE_CHANNEL, authSignature: signer.sign(PROBE_JOIN_SIGNED_BODY), apiKey };',
        'assertReadOnlySocketEmit(PROBE_SOCKET_JOIN_EVENT, payload);',
        'raw.emit(PROBE_SOCKET_JOIN_EVENT, payload);',
      ]);
    });

    it('the origin and connection options are fixed', () => {
      expect(wsCode).toMatch(/ioFactory\(PROBE_SOCKET_ORIGIN, \{ transports: \['websocket'\], reconnection: false, autoConnect: false, forceNew: true \}\)/);
      expect(wsCode.match(/ioFactory\(/g)).toHaveLength(1);
    });
  });

  it('can name ACCOUNT_CONTINUITY_PROVEN only inside the disclaimer that denies it', () => {
    for (const file of PROBE_FILES) {
      const code = codeOf(file).replace("'THIS PROBE DOES NOT SET ACCOUNT_CONTINUITY_PROVEN.'", '');
      expect(code.includes('ACCOUNT_CONTINUITY_PROVEN'), file).toBe(false);
    }
  });
});
