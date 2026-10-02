import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { buildImportGraph, computeReachable } from './support/import-graph';

const root = path.resolve(__dirname, '../..');
const factory = 'src/integration/coindcx/live/practical-credential-sources.ts';
const { graph, files } = buildImportGraph(path.join(root, 'src'), root);
const source = (file: string) => readFileSync(path.join(root, file), 'utf8');
const exactCallers: Readonly<Record<string, readonly string[]>> = {
  createOwnedCoinDcxReadClient: [factory],
  createOwnedCoinDcxReader: [factory],
  createOwnedCoinDcxPrivateStream: [factory],
  createOwnedCoinDcxMutationGateway: [factory],
  createOwnedCoinDcxReadTransport: ['src/integration/coindcx/client.ts'],
  createOwnedCoinDcxSigner: ['src/integration/coindcx/client.ts', 'src/integration/coindcx/live/mutation-transport.ts', 'src/integration/coindcx/websocket/private-stream.ts'],
  createOwnedCoinDcxSocketFactory: ['src/integration/coindcx/websocket/private-stream.ts'],
  createOwnedCoinDcxMutationTransport: ['src/integration/coindcx/live/order-gateway.ts'],
};
describe('unwired credential-origin construction ownership', () => {
  it('has zero production importers/reachers and no barrel exposure', () => {
    expect(files.filter(file => file !== factory && computeReachable(graph, file).has(factory))).toEqual([]);
    expect((graph.get(factory) ?? []).filter(file => file.startsWith('src/execution/'))).toEqual([
      'src/execution/live/gateway.ts', 'src/execution/live/practical-recovery/ports.ts',
    ].sort());
    for (const file of files.filter(file => /(?:index|barrel)\.ts$/.test(file))) expect(source(file)).not.toContain('practical-credential-sources');
  });
  it('pins exact helper callers and named importers without directory exemptions', () => {
    const callers = new Map<string, Set<string>>(), importers = new Map<string, Set<string>>();
    for (const file of files) {
      const tree = ts.createSourceFile(file, source(file), ts.ScriptTarget.ES2022, true);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && Object.hasOwn(exactCallers, node.expression.text)) {
          const name = node.expression.text; if (!callers.has(name)) callers.set(name, new Set()); callers.get(name)!.add(file);
        }
        if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          for (const binding of node.importClause.namedBindings.elements) {
            const name = (binding.propertyName ?? binding.name).text;
            if (Object.hasOwn(exactCallers, name)) { if (!importers.has(name)) importers.set(name, new Set()); importers.get(name)!.add(file); expect(binding.name.text).toBe(name); }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    for (const [name, expected] of Object.entries(exactCallers)) {
      expect([...(callers.get(name) ?? [])].sort(), name).toEqual([...expected].sort());
      expect([...(importers.get(name) ?? [])].sort(), name).toEqual([...expected].sort());
    }
  });
  it('keeps source lookup captures and helper export protection in their defining modules', () => {
    for (const file of ['client.ts', 'transport.ts', 'signer.ts', 'live/reconciliation-evidence-adapter.ts',
      'websocket/private-stream.ts', 'websocket/socket-adapter.ts', 'live/order-gateway.ts', 'live/mutation-transport.ts']) {
      const code = source(`src/integration/coindcx/${file}`);
      expect(code).toContain('Object.getOwnPropertyDescriptors(');
      expect(code).toContain('CREDENTIAL_CONSTRUCTION_EXPORT_INVALID');
      expect(code).toContain('descriptor.set !== undefined');
      expect(code).toContain('writable: false, configurable: false');
      expect(code).not.toMatch(/Object\.freeze\((?:CoinDcxClient|CoinDcxTransport|HmacSha256Signer|CoinDcxPrivateAccountStream|ProductionCoinDcxSocket)\.prototype\)/);
    }
  });
  it('cannot reach operational composition, recovery services, stores or proof/authority issuers directly', () => {
    const direct = graph.get(factory) ?? [];
    expect(direct.some(file => /practical-cancel(?:\/|-transport-evidence)|practical-mutation|practical-recovery\/service|production-runtime|practical-shadow-runtime|persistence/.test(file))).toBe(false);
    const code = source(factory);
    for (const forbidden of ['issuePractical', 'reserveCancelTransport', 'beginCancelTransportPreparation', 'new PracticalRecoveryService',
      'new PracticalCancelService', 'resolveLiveExecutionGate', 'ACCOUNT_CONTINUITY_PROVEN', 'subscriptionConfirmation:', 'process.env', 'dotenv', '.start()']) expect(code).not.toContain(forbidden);
    expect(code.indexOf('const credentials = Object.freeze')).toBeLessThan(code.indexOf('const client = createOwned'));
    expect(code).toContain('original === sources');
    expect(code).toContain("try { scope = shape(expected, SCOPE_KEYS, true); }");
  });
});
