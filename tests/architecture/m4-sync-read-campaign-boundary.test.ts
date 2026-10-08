import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeModuleReferences, buildImportGraph } from './support/import-graph';

const ROOT = path.resolve(__dirname, '../..');
const CAMPAIGN = 'src/integration/coindcx/live/sync-read-campaign.ts';
const PREFLIGHT = 'src/integration/coindcx/live/sync-read-campaign-preflight.ts';
const { graph, files } = buildImportGraph(path.join(ROOT, 'src'), ROOT);
const raw = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');
const code = (file: string): string => raw(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('M4 isolated read-only campaign boundary', () => {
  it('only the isolated runner imports the preflight; nothing imports or names the runner in src', () => {
    expect([...graph].filter(([, edges]) => edges.includes(PREFLIGHT)).map(([file]) => file)).toEqual([CAMPAIGN]);
    expect([...graph].filter(([, edges]) => edges.includes(CAMPAIGN))).toEqual([]);
    for (const file of files.filter(file => ![CAMPAIGN, PREFLIGHT].includes(file))) {
      expect(raw(file), file).not.toContain('sync-read-campaign');
    }
  });

  it('imports only the reviewed candidate dependencies and a type-only read client', () => {
    const campaign = analyzeModuleReferences(raw(CAMPAIGN), CAMPAIGN);
    expect([...campaign.specifiers].sort()).toEqual([
      '../../../execution/live/practical-synchronization/async-orchestrator', '../client', './sync-read-adapter', './sync-read-campaign-preflight',
    ]);
    const preflight = analyzeModuleReferences(raw(PREFLIGHT), PREFLIGHT);
    expect([...preflight.specifiers].sort()).toEqual(['../../../execution/live/practical-synchronization/engine', '../rate-limit/config']);
    expect(campaign.unresolvedDynamicLoads).toEqual([]);
    expect(preflight.unresolvedDynamicLoads).toEqual([]);
    expect(raw(CAMPAIGN)).toContain("import type { CoinDcxClient } from '../client';");
    expect(raw(CAMPAIGN)).toContain("Pick<CoinDcxClient, 'getUserInfoSafe' | 'listInrFuturesOrders' | 'listInrFuturesPositions'>");
  });

  it('has no HTTP, signing, budget acquisition/refund, client construction, operational I/O or real timers', () => {
    for (const file of [CAMPAIGN, PREFLIGHT]) {
      for (const pattern of [/node:|fetch\(|\.request\(|createHmac|Signer|sign\(/,
        /\.acquire\(|\.release\(|\.complete\(|bindProduction|new CoinDcx|new RateLimit/,
        /process\.|Date\.now|new Date\(|performance\.|Math\.random|setTimeout|setInterval|setImmediate/,
        /apiKey|apiSecret|\.env\b|Prisma|readFile|writeFile|require\s*\(|\bimport\s*\(/]) {
        expect(code(file), `${file}: ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('uses exactly the identity, order and position reads, with no mutation, hook or execution capability', () => {
    expect([...new Set(code(CAMPAIGN).match(/client\.\w+\(/g))].sort()).toEqual([
      'client.getUserInfoSafe(', 'client.listInrFuturesOrders(', 'client.listInrFuturesPositions(',
    ]);
    for (const file of [CAMPAIGN, PREFLIGHT]) {
      expect(code(file)).not.toMatch(/createOrder|placeOrder|cancelOrder|cancelAll|exitPosition|register\w*Hook|Mutation|Gateway|Certificate|Authorization|Enablement|authorityEligible/);
      expect(code(file)).not.toMatch(/PROVEN_READY|ACCOUNT_CONTINUITY_PROVEN|reconciliationRequired|reconnectLatched:\s*false|grants:\s*\{/);
      expect(code(file)).toContain('grants: GRANTS_NOTHING');
    }
  });
});
