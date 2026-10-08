import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeModuleReferences, buildImportGraph } from './support/import-graph';

// M4 read adapter (unwired review candidate): it reaches the committed, M2-budgeted read client only through two
// type-only imports, creates no request site, signing, budget acquisition or client, substitutes no endpoint, and is
// imported by nothing in src.
const REPO_ROOT = path.resolve(__dirname, '../..');
const ADAPTER = 'src/integration/coindcx/live/sync-read-adapter.ts';
const { graph, files } = buildImportGraph(path.join(REPO_ROOT, 'src'), REPO_ROOT);
const raw = readFileSync(path.join(REPO_ROOT, ADAPTER), 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('M4 read adapter boundary', () => {
  it('imports exactly the read client and its models, both type-only', () => {
    const analysis = analyzeModuleReferences(raw, ADAPTER);
    expect([...analysis.specifiers].sort()).toEqual(['../client', '../models']);
    expect(analysis.unresolvedDynamicLoads).toEqual([]);
    const imports = raw.split(/\r?\n/).filter((line) => /^import /.test(line));
    expect(imports).toEqual([
      "import type { CoinDcxClient } from '../client';",
      "import type { InrFuturesOrder, InrFuturesPosition } from '../models';",
    ]);
  });

  it('is imported by nothing in src and named by nothing else in src (unwired; no production composition)', () => {
    for (const [file, edges] of graph) expect(edges, file).not.toContain(ADAPTER);
    for (const file of files.filter((candidate) => candidate !== ADAPTER)) {
      expect(readFileSync(path.join(REPO_ROOT, file), 'utf8').includes('sync-read-adapter'), file).toBe(false);
    }
  });

  it('creates no request site, signer, transport, client or budget call, and reads no clock, environment or credentials', () => {
    for (const pattern of [/\.request\(|node:http|node:https|fetch\(/, /Signer|createHmac|sign\(/, /new CoinDcxClient|new CoinDcxTransport|executeRead/,
      /acquire|bindProduction|releaseReadPermit|\.release\(|readBudget|ReadPermit/, /Date\.now|new Date\(|performance\.|process\./, /apiKey|apiSecret|\.env\b/,
      /setTimeout|setInterval|setImmediate|Math\.random|require\s*\(|\bimport\s*\(/]) {
      expect(code, String(pattern)).not.toMatch(pattern);
    }
  });

  it('uses only the committed order and position read methods (no endpoint substituted for another component)', () => {
    expect([...new Set(code.match(/client\??\.list\w+/g)?.map((name) => name.replace('?', '')))].sort()).toEqual(['client.listInrFuturesOrders', 'client.listInrFuturesPositions']);
    expect(code).not.toMatch(/listInrFuturesPositionTransactions|listInrFuturesTrades|listFuturesWalletTransactions|getUserInfo/);
  });

  it('never reads client_id as a property, mints no authority, and imports no execution or candidate module', () => {
    expect(code).not.toMatch(/\[['"]client_id['"]\]|\.client_id\b/);
    expect(code).not.toMatch(/PROVEN_READY|ACCOUNT_CONTINUITY_PROVEN|authorityEligible|Certificate|Authorization|Enablement|GRANTS/);
    expect(graph.get(ADAPTER)?.some((edge) => edge.startsWith('src/execution/')) ?? false).toBe(false);
  });
});
