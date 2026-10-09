import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { buildImportGraph } from './support/import-graph';

const ROOT = path.resolve(__dirname, '../..');
const HOST = 'scripts/sync-read-launch/campaign-host.ts', AUTH = 'scripts/sync-read-launch/campaign-access.ts', CLI = 'scripts/coindcx-sync-read-bootstrap.ts';
const text = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
describe('isolated campaign bootstrap capability and invocation boundary', () => {
  it('is unreachable from all src imports, including production startup', () => {
    const { graph } = buildImportGraph(path.join(ROOT, 'src'), ROOT);
    for (const [file, edges] of graph) expect(edges.filter(edge => [HOST, AUTH, CLI].includes(edge)), file).toEqual([]);
  });
  it('has no bootstrap I/O, timers, network or state initialization on module import', () => {
    for (const file of [HOST, AUTH]) {
      const source = ts.createSourceFile(file, text(file), ts.ScriptTarget.Latest, true);
      const forbidden: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isFunctionLike(node)) return;
        if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && /\b(fs|net|process|execFileSync|setInterval|setTimeout|initializeCampaign|startCampaign|RateLimit|CoinDcx)\b/.test(node.expression.getText(source))) forbidden.push(node.getText(source));
        ts.forEachChild(node, visit);
      };
      visit(source); expect(forbidden, file).toEqual([]);
    }
    expect(text(CLI)).toContain('if (require.main === module) main()');
  });
  it('composes only read budget and narrowed reads, without execution binding, recovery or hooks', () => {
    const host = text(HOST);
    expect(host).not.toMatch(/bindProduction|createOwned|MutationBudget|ExecutionGateway|register\w*Hook|\.resetStop\(|\.control\(['"]RESET_STOP/);
    expect(host).toContain('createCoordinatorReadBudget'); expect(host).toContain("cls: 'P1'");
    expect(host).toContain('getUserInfoSafe:'); expect(host).toContain('listInrFuturesOrders:'); expect(host).toContain('listInrFuturesPositions:');
    expect(host).not.toMatch(/createOrder:|cancelOrder:|cancelAllOrders:|exitPosition:/);
  });
  it('keeps provider credentials out of strict IPC schemas and uses distinct authenticated session capabilities', () => {
    const protocol = text('src/integration/coindcx/rate-limit/runtime/protocol.ts');
    expect(protocol).not.toMatch(/apiKey|apiSecret|providerCredential/);
    expect(protocol).toContain("z.enum(['READ', 'OPERATOR_STOP'])");
    const core = text('src/integration/coindcx/rate-limit/runtime/coordinator.ts');
    expect(core).toContain("message.action !== 'STOP'"); expect(core).toContain("message.operation !== 'READ'"); expect(core).toContain("message.cls !== 'P1'");
    expect(core).toContain('this.#access.verify(session.challenge, message)');
  });
  it('retains UNKNOWN and active capacity; no test initialization substitutes for campaign initialization', () => {
    const host = text(HOST);
    expect(host).not.toContain('initializeDisposableStateDirectory');
    expect(host).toContain('opened.recoveredFrom !== \'BOTH\'');
    expect(host).toContain('capacityRefunded: false'); expect(host).toContain('unknownRecoveryAttempted: false');
    expect(host).toContain("networkAccess: z.enum(['LOOPBACK_ONLY', 'COINDCX_PROVIDER_AUTHORIZATION_REQUIRED'])");
    expect(host).toContain('requireRecordedAuthorization(invocation, record, Date.now())');
    expect(host).toContain('connection.origin !== \'https://api.coindcx.com\'');
    expect(host).toContain('windowsAclEnforced: false'); expect(host).toContain('processIdentityProven: false'); expect(host).toContain('remoteClientsExcluded: false');
  });
});
