import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeModuleReferences, buildImportGraph } from './support/import-graph';

// M4 private-stream observation adapter (unwired review candidate): it reaches the existing private stream only
// through an injected port and one type-only import of the websocket layer's own types, constructs no socket,
// signer, credential, client or runtime, mints no acknowledgement or readiness, and is imported by nothing in src.
const REPO_ROOT = path.resolve(__dirname, '../..');
const ADAPTER = 'src/integration/coindcx/live/sync-stream-adapter.ts';
const { graph, files } = buildImportGraph(path.join(REPO_ROOT, 'src'), REPO_ROOT);
const raw = readFileSync(path.join(REPO_ROOT, ADAPTER), 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('M4 private-stream observation adapter boundary', () => {
  it('imports exactly the websocket port types, type-only, and no execution or candidate module', () => {
    const analysis = analyzeModuleReferences(raw, ADAPTER);
    expect([...analysis.specifiers]).toEqual(['../websocket/types']);
    expect(analysis.unresolvedDynamicLoads).toEqual([]);
    expect(raw.split(/\r?\n/).filter((line) => /^import /.test(line))).toEqual([
      "import type { PrivateStreamHealthSnapshot, StreamEventListener } from '../websocket/types';",
    ]);
    expect(graph.get(ADAPTER)?.some((edge) => edge.startsWith('src/execution/')) ?? false).toBe(false);
  });

  it('is imported and named by nothing in src (no production or campaign composition)', () => {
    expect([...graph].filter(([, edges]) => edges.includes(ADAPTER)).map(([file]) => file)).toEqual([]);
    for (const file of files.filter((candidate) => candidate !== ADAPTER)) {
      expect(readFileSync(path.join(REPO_ROOT, file), 'utf8').includes('sync-stream-adapter'), file).toBe(false);
    }
  });

  it('constructs no socket, stream, signer, client or runtime, and reads no time source, environment or credentials of its own', () => {
    for (const pattern of [/new CoinDcxPrivateAccountStream|createOwnedCoinDcxPrivateStream|SocketFactory|createSocket|socket\.io|\bio\(/,
      /Signer|createHmac|sign\(/, /new CoinDcx\w+|executeRead|\.request\(|node:http|node:https|fetch\(/, /\.start\(|\.stop\(/,
      /Date\.now|new Date\(|performance\.|process\./, /apiKey|apiSecret|\.env\b/,
      /setTimeout|setInterval|setImmediate|Math\.random|require\s*\(|\bimport\s*\(/]) {
      expect(code, String(pattern)).not.toMatch(pattern);
    }
  });

  it('never reads payload content, never mints an acknowledgement or readiness, and grants nothing', () => {
    expect(code).not.toMatch(/\.payload\b|\['payload'\]|providerTimestampMs|\.pair\b|\['pair'\]/);
    expect(code).not.toMatch(/PROVIDER_CONFIRMED|subscriptionConfirmation|PROVEN_READY|ACCOUNT_CONTINUITY_PROVEN|authorityEligible|Certificate|Authorization|GRANTS/);
    expect(code.match(/joinAcknowledgement: [A-Z_]+\b/g)).toEqual(['joinAcknowledgement: UNKNOWN_ACKNOWLEDGEMENT']);
  });
});
