import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanSourceCapabilities } from './support/capability-scan';
import { buildImportGraph, computeReachable, listSourceFiles } from './support/import-graph';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const MUTATION_TRANSPORT = 'src/integration/coindcx/live/mutation-transport.ts';
const MUTATION_GATEWAY = 'src/integration/coindcx/live/order-gateway.ts';
const PRODUCTION_ROOT = 'src/integration/coindcx/live/production-runtime.ts';

const APPROVED_NETWORK_OWNERS = Object.freeze([
  'src/app/bootstrap/server.ts',
  'src/app/lifecycle/shutdown.ts',
  'src/integration/coindcx/instrument-authority.ts',
  'src/integration/coindcx/live/mutation-transport.ts',
  'src/integration/coindcx/paper-evidence.ts',
  'src/integration/coindcx/transport.ts',
  'src/integration/coindcx/websocket/socket-adapter.ts',
  'src/market-data/rest-candle-reader.ts',
]);

const APPROVED_COINDCX_CRYPTO_OWNERS = Object.freeze([
  'src/integration/coindcx/instrument-authority.ts',
  'src/integration/coindcx/paper-evidence.ts',
  'src/integration/coindcx/signer.ts',
]);

function posix(value: string): string { return value.split(path.sep).join('/'); }

function inverseDirectImporters(graph: ReadonlyMap<string, readonly string[]>, target: string): readonly string[] {
  return [...graph.entries()]
    .filter(([, dependencies]) => dependencies.includes(target))
    .map(([file]) => file)
    .sort();
}

describe('F17-14 production capability ownership', () => {
  const result = buildImportGraph(SRC_ROOT, REPO_ROOT);
  const absoluteFiles = listSourceFiles(SRC_ROOT);
  const capabilities = scanSourceCapabilities(absoluteFiles, (file) => readFileSync(file, 'utf8'));

  it('allows exactly the reviewed primitive network owners, including one order-mutation transport', () => {
    const owners = [...new Set(capabilities
      .filter((hit) => hit.capability === 'NETWORK_MODULE' || hit.capability === 'GLOBAL_FETCH')
      .map((hit) => posix(path.relative(REPO_ROOT, hit.file))))].sort();
    expect(owners).toEqual([...APPROVED_NETWORK_OWNERS].sort());
    expect(owners.filter((file) => file.startsWith('src/integration/coindcx/live/'))).toEqual([MUTATION_TRANSPORT]);
  });

  it('allows CoinDCX crypto primitives only in the reviewed hash/signing owners', () => {
    const owners = [...new Set(capabilities
      .filter((hit) => hit.capability === 'CRYPTO_MODULE')
      .map((hit) => posix(path.relative(REPO_ROOT, hit.file)))
      .filter((file) => file.startsWith('src/integration/coindcx/')))];
    expect(owners.sort()).toEqual([...APPROVED_COINDCX_CRYPTO_OWNERS].sort());
  });

  it('pins direct access to the one HMAC signer implementation', () => {
    expect(inverseDirectImporters(result.graph, 'src/integration/coindcx/signer.ts')).toEqual([
      'src/integration/coindcx/client.ts',
      MUTATION_TRANSPORT,
      'src/integration/coindcx/transport.ts',
      'src/integration/coindcx/websocket/private-stream.ts',
    ].sort());
    expect(readFileSync(path.join(SRC_ROOT, 'integration/coindcx/index.ts'), 'utf8')).not.toContain("from './signer'");
    const hmacConstructorOwners = result.files.filter((file) =>
      readFileSync(path.join(REPO_ROOT, file), 'utf8').includes('new HmacSha256Signer('));
    expect(hmacConstructorOwners.sort()).toEqual([
      'src/integration/coindcx/client.ts',
      MUTATION_TRANSPORT,
      'src/integration/coindcx/websocket/private-stream.ts',
    ].sort());
  });

  it('pins every module capable of reaching authenticated order mutation', () => {
    const reachers = result.files.filter((file) => file !== MUTATION_TRANSPORT && computeReachable(result.graph, file).has(MUTATION_TRANSPORT));
    expect(reachers.sort()).toEqual([MUTATION_GATEWAY, PRODUCTION_ROOT].sort());
    expect(inverseDirectImporters(result.graph, MUTATION_TRANSPORT)).toEqual([MUTATION_GATEWAY]);
    expect(inverseDirectImporters(result.graph, MUTATION_GATEWAY)).toEqual([PRODUCTION_ROOT]);
  });

  it('fails closed on unresolved dynamic loading in protected production source', () => {
    expect(result.unresolvedDynamicLoads).toEqual([]);
  });

  it.each([
    'src/strategies/', 'src/research/', 'src/ranking/', 'src/risk/',
    'src/execution/', 'src/coin-runtime/', 'src/app/',
  ])('%s cannot reach the mutation transport, gateway, or production root', (prefix) => {
    for (const file of result.files.filter((candidate) => candidate.startsWith(prefix))) {
      const reachable = computeReachable(result.graph, file);
      expect(
        [MUTATION_TRANSPORT, MUTATION_GATEWAY, PRODUCTION_ROOT].filter((target) => reachable.has(target)),
        `${file} crosses the live mutation boundary`,
      ).toEqual([]);
    }
  });
});

interface ProbeResult {
  readonly violations: readonly string[];
  readonly graph: ReadonlyMap<string, readonly string[]>;
  readonly unresolvedDynamicLoads: readonly { readonly file: string }[];
}

const temporaryRoots: string[] = [];

function writeFixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'phase17-capability-'));
  temporaryRoots.push(root);
  for (const [relativeFile, source] of Object.entries(files)) {
    const absoluteFile = path.join(root, relativeFile);
    mkdirSync(path.dirname(absoluteFile), { recursive: true });
    writeFileSync(absoluteFile, source, 'utf8');
  }
  return root;
}

function probe(additions: Readonly<Record<string, string>>): ProbeResult {
  const baseline: Record<string, string> = {
    'src/integration/coindcx/signer.ts': `import crypto from 'node:crypto'; export const sign = (v: string) => crypto.createHmac('sha256', 'test').update(v).digest('hex');`,
    'src/integration/coindcx/live/mutation-transport.ts': `import https from 'node:https'; import { sign } from '../signer'; export const send = () => [https.request, sign];`,
    'src/integration/coindcx/live/order-gateway.ts': `import { send } from './mutation-transport'; export const gateway = () => send();`,
    'src/integration/coindcx/live/production-runtime.ts': `import { gateway } from './order-gateway'; export const runtime = () => gateway();`,
    ...additions,
  };
  const root = writeFixture(baseline);
  const sourceRoot = path.join(root, 'src');
  const result = buildImportGraph(sourceRoot, root);
  const absoluteFiles = listSourceFiles(sourceRoot);
  const capabilities = scanSourceCapabilities(absoluteFiles, (file) => readFileSync(file, 'utf8'));
  const relative = (file: string): string => posix(path.relative(root, file));
  const allowedNetwork = new Set([MUTATION_TRANSPORT]);
  const allowedCrypto = new Set(['src/integration/coindcx/signer.ts']);
  const allowedReachers = new Set([MUTATION_GATEWAY, PRODUCTION_ROOT]);
  const violations: string[] = [];

  for (const hit of capabilities) {
    const file = relative(hit.file);
    if ((hit.capability === 'NETWORK_MODULE' || hit.capability === 'GLOBAL_FETCH') && !allowedNetwork.has(file)) {
      violations.push(`unauthorized network owner: ${file}`);
    }
    if (hit.capability === 'CRYPTO_MODULE' && file.startsWith('src/integration/coindcx/') && !allowedCrypto.has(file)) {
      violations.push(`unauthorized CoinDCX crypto owner: ${file}`);
    }
  }
  for (const file of result.files) {
    if (file !== MUTATION_TRANSPORT && computeReachable(result.graph, file).has(MUTATION_TRANSPORT) && !allowedReachers.has(file)) {
      violations.push(`unauthorized mutation reacher: ${file}`);
    }
  }
  for (const load of result.unresolvedDynamicLoads) violations.push(`unresolved module load: ${load.file}`);
  return { violations: violations.sort(), graph: result.graph, unresolvedDynamicLoads: result.unresolvedDynamicLoads };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('F17-14 adversarial scanner-bypass probes', () => {
  it('accepts the deliberately approved fixture boundary', () => {
    expect(probe({}).violations).toEqual([]);
  });

  it('detects the reviewer second sink inside the formerly exempt live directory despite renamed method and assembled strings', () => {
    const result = probe({
      'src/integration/coindcx/live/hidden-command.ts': `
        import https from 'node:https'; import crypto from 'node:crypto';
        export function sendAuthenticatedCommand(secret: string) {
          const endpoint = '/orders/' + 'create'; const header = 'X-AUTH-' + 'SIGNATURE';
          return https.request(endpoint, { headers: { [header]: crypto.createHmac('sha256', secret).update('{}').digest('hex') } });
        }`,
      'src/integration/coindcx/live/hidden-index.ts': `export { sendAuthenticatedCommand } from './hidden-command';`,
    });
    expect(result.violations).toContain('unauthorized network owner: src/integration/coindcx/live/hidden-command.ts');
    expect(result.violations).toContain('unauthorized CoinDCX crypto owner: src/integration/coindcx/live/hidden-command.ts');
    expect(computeReachable(result.graph, 'src/integration/coindcx/live/hidden-index.ts').has('src/integration/coindcx/live/hidden-command.ts')).toBe(true);
  });

  it('detects a direct second HTTP sink outside the approved directory', () => {
    expect(probe({ 'src/unrelated/send.ts': `import http from 'node:http'; export const differentName = () => http.request('x');` }).violations)
      .toContain('unauthorized network owner: src/unrelated/send.ts');
  });

  it('detects a wrapper around the generic mutation transport', () => {
    expect(probe({ 'src/integration/coindcx/live/wrapper.ts': `import { send } from './mutation-transport'; export const command = () => send();` }).violations)
      .toContain('unauthorized mutation reacher: src/integration/coindcx/live/wrapper.ts');
  });

  it('follows a barrel re-export to a second sink', () => {
    const result = probe({
      'src/integration/coindcx/live/second.ts': `import https from 'node:https'; export const command = () => https.request('x');`,
      'src/integration/coindcx/live/index.ts': `export * from './second';`,
    });
    expect(result.violations).toContain('unauthorized network owner: src/integration/coindcx/live/second.ts');
    expect(computeReachable(result.graph, 'src/integration/coindcx/live/index.ts').has('src/integration/coindcx/live/second.ts')).toBe(true);
  });

  it('follows a literal dynamic import to the mutation transport', () => {
    expect(probe({ 'src/integration/coindcx/live/dynamic.ts': `export const load = () => import('./mutation-transport');` }).violations)
      .toContain('unauthorized mutation reacher: src/integration/coindcx/live/dynamic.ts');
  });

  it('rejects an unresolved computed dynamic import', () => {
    const result = probe({ 'src/integration/coindcx/live/computed.ts': `export const load = (name: string) => import('./' + name);` });
    expect(result.unresolvedDynamicLoads.map((hit) => hit.file)).toEqual(['src/integration/coindcx/live/computed.ts']);
    expect(result.violations).toContain('unresolved module load: src/integration/coindcx/live/computed.ts');
  });

  it('follows static require to the mutation transport', () => {
    expect(probe({ 'src/integration/coindcx/live/static-require.ts': `const transport = require('./mutation-transport'); export const load = () => transport.send();` }).violations)
      .toContain('unauthorized mutation reacher: src/integration/coindcx/live/static-require.ts');
  });

  it('follows an aliased require to the mutation transport', () => {
    expect(probe({ 'src/integration/coindcx/live/aliased-require.ts': `const loadModule = require; const transport = loadModule('./mutation-transport'); export const load = () => transport.send();` }).violations)
      .toContain('unauthorized mutation reacher: src/integration/coindcx/live/aliased-require.ts');
  });

  it('follows destructured module.require and createRequire loaders', () => {
    const result = probe({
      'src/integration/coindcx/live/module-require.ts': `const { require: load } = module; load('./mutation-transport');`,
      'src/integration/coindcx/live/create-require.ts': `import * as mod from 'node:module'; const load = mod.createRequire(__filename); load('./mutation-transport');`,
    });
    expect(result.violations).toContain('unauthorized mutation reacher: src/integration/coindcx/live/module-require.ts');
    expect(result.violations).toContain('unauthorized mutation reacher: src/integration/coindcx/live/create-require.ts');
  });

  it('rejects eval-style indirect loading instead of claiming a complete graph', () => {
    expect(probe({ 'src/integration/coindcx/live/eval-load.ts': `export const load = (name: string) => eval('require')(name);` }).violations)
      .toContain('unresolved module load: src/integration/coindcx/live/eval-load.ts');
  });

  it('detects an aliased global fetch capability', () => {
    expect(probe({ 'src/integration/coindcx/live/fetch-command.ts': `const send = fetch; export const command = () => send('/' + 'orders/create', { method: 'POST' });` }).violations)
      .toContain('unauthorized network owner: src/integration/coindcx/live/fetch-command.ts');
  });

  it('detects a second signer even without a mutation-looking symbol', () => {
    expect(probe({ 'src/integration/coindcx/live/digest.ts': `import crypto from 'node:crypto'; export const opaque = (s: string) => crypto.createHmac('sha256', s);` }).violations)
      .toContain('unauthorized CoinDCX crypto owner: src/integration/coindcx/live/digest.ts');
  });
});
