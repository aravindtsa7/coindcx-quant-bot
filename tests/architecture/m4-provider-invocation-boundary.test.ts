import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { buildImportGraph } from './support/import-graph';
const ROOT = path.resolve(__dirname, '../..');
const files = ['campaign-input', 'campaign-entry', 'campaign-read-boundary', 'campaign-secrets'].map(name => `scripts/sync-read-launch/${name}.ts`);
const text = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
describe('provider invocation stays explicit, read-only and outside production startup', () => {
  it('is unreachable from src and has no import-time I/O, timers, credentials or client construction', () => {
    const { graph } = buildImportGraph(path.join(ROOT, 'src'), ROOT);
    for (const [source, edges] of graph) expect(edges.filter(edge => files.includes(edge)), source).toEqual([]);
    for (const file of files) {
      const source = ts.createSourceFile(file, text(file), ts.ScriptTarget.Latest, true), forbidden: string[] = [];
      const visit = (node: ts.Node) => { if (ts.isFunctionLike(node)) return;
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          let expression = node.expression;
          while (ts.isPropertyAccessExpression(expression) || ts.isCallExpression(expression)) expression = expression.expression;
          if (/^(fs|net|http|https|process|setInterval|setTimeout|RateLimit|CoinDcx|startCampaign|initializeCampaign)/.test(expression.getText(source))) forbidden.push(node.getText(source));
        }
        ts.forEachChild(node, visit); };
      visit(source); expect(forbidden, file).toEqual([]);
    }
    expect(text('scripts/coindcx-sync-read-bootstrap.ts')).toContain('if (require.main === module)');
    expect(text('scripts/coindcx-sync-read-launch.ts')).toContain('if (require.main === module)');
  });
  it('loads no dotenv/live aliases and checks provider authorization before environment lookup and host startup', () => {
    const entry = text(files[1]!);
    expect(entry.indexOf('requireRecordedAuthorization(input, authorization')).toBeLessThan(entry.indexOf('loadCampaignSecrets(process.env)'));
    expect(entry.indexOf('loadCampaignSecrets(process.env)')).toBeLessThan(entry.indexOf('startCampaignHost(cfg'));
    for (const file of files) expect(text(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/dotenv|process\.env\.(COINDCX_API|LIVE)|bindProduction|MutationBudget|ExecutionGateway|register\w*Hook|RESET_STOP|recoverUnknown/);
  });
  it('uses only fixed semantic endpoints; budget and transport construction remain in the reviewed host', () => {
    const boundary = text(files[2]!); expect(boundary).toContain("['USER_INFO', 'FUTURES_ORDERS', 'FUTURES_POSITIONS']");
    expect(boundary).not.toMatch(/new CoinDcx|\.request\(|fetch\(|createHmac|\.acquire\(|\.release\(/);
    const host = text('scripts/sync-read-launch/campaign-host.ts'); expect(host).toContain('allowedReadEndpoints: CAMPAIGN_READ_ENDPOINTS');
    expect(host).toContain('campaignReadBoundary(narrowed'); expect(host).toContain('requireRecordedAuthorization(invocation, record');
    expect(host).not.toMatch(/createOrder:|cancelOrder:|cancelAllOrders:|exitPosition:|MutationBudget|bindProduction/);
  });
  it('documents managed traffic and host limitations without creating authority or replacing unknown evidence', () => {
    const host = text('scripts/sync-read-launch/campaign-host.ts');
    for (const claim of ['MANAGED_CAMPAIGN_COORDINATOR_TRAFFIC_ONLY', 'UNKNOWN_NOT_CONTROLLED', 'windowsAclEnforced: false', 'remoteClientsExcluded: false', 'processIdentityProven: false']) expect(host).toContain(claim);
    expect(host).toContain('stream: null'); expect(host).toContain('redactCampaignOutput');
    expect(text(files[0]!)).toContain("valuesStatus: z.literal('PROPOSED_NOT_APPROVED')");
  });
});
