import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
}
function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  function visit(child: ts.Node): void { result.push(child); child.forEachChild(visit); }
  visit(node);
  return result;
}

describe('Phase14 combined authority and durable mutation architecture', () => {
  it('every private provider method dispatches through private state, never public instance methods', () => {
    const file = source('src/integration/coindcx/paper-evidence.ts');
    const privateMethods = descendants(file).filter(ts.isMethodDeclaration).filter(method => ts.isPrivateIdentifier(method.name));
    expect(privateMethods.length).toBeGreaterThan(10);
    const publicReads = privateMethods.flatMap(method => descendants(method).filter(ts.isPropertyAccessExpression)
      .filter(access => access.expression.kind === ts.SyntaxKind.ThisKeyword && !ts.isPrivateIdentifier(access.name)));
    expect(publicReads.map(access => access.getText(file))).toEqual([]);
    const guards = descendants(file).filter(ts.isFunctionDeclaration)
      .filter(fn => fn.name?.text.startsWith('readProductionAcquiredPaper'));
    expect(guards).toHaveLength(2);
    for (const guard of guards) {
      expect(descendants(guard).filter(ts.isPropertyAccessExpression).filter(access => access.expression.getText(file) === 'provider')).toEqual([]);
      expect(guard.getText(file)).toContain('PRIVATE_READERS.get(provider)');
    }
  });

  it('instrument success path cannot invoke any repository import to transform trusted input', () => {
    const file = source('src/integration/coindcx/instrument-authority.ts');
    const imported = new Set<string>();
    for (const declaration of file.statements.filter(ts.isImportDeclaration)) {
      if (!ts.isStringLiteral(declaration.moduleSpecifier) || !declaration.moduleSpecifier.text.startsWith('.')) continue;
      const clause = declaration.importClause;
      if (clause === undefined || clause.isTypeOnly) continue;
      if (clause.name !== undefined) imported.add(clause.name.text);
      if (clause.namedBindings !== undefined) {
        if (ts.isNamespaceImport(clause.namedBindings)) imported.add(clause.namedBindings.name.text);
        else for (const binding of clause.namedBindings.elements) if (!binding.isTypeOnly) imported.add(binding.name.text);
      }
    }
    const violations: string[] = [];
    function visit(node: ts.Node): void {
      // Error construction can only reject acquisition, never bless data.
      if (ts.isThrowStatement(node) || ts.isImportDeclaration(node) || ts.isTypeNode(node)) return;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'reject') return;
      if (ts.isIdentifier(node) && imported.has(node.text)) violations.push(node.getText(file));
      node.forEachChild(visit);
    }
    visit(file);
    expect(violations).toEqual([]);
  });

  it('authority module namespaces are immutable in fresh CommonJS processes, before and after consumer import', () => {
    const output = execFileSync(process.execPath, ['--require', 'tsx/cjs', '-e', String.raw`
      const assert = require('node:assert/strict');
      const providers = require('./src/integration/coindcx/paper-evidence.ts');
      const instrument = require('./src/integration/coindcx/instrument-authority.ts');
      const provider = providers.createProductionPaperEvidenceProvider({ instruments: [{ pair: 'B-BTC_USDT', underlying: 'BTC', quoteCurrency: 'USDT', instrumentSpecSnapshotId: 'fixture' }] });
      const descriptors = Object.getOwnPropertyDescriptors(providers.CoinDcxPaperEvidence.prototype);
      for (const stage of ['pre-consumer-import', 'post-consumer-import']) {
        if (stage === 'post-consumer-import') require('./src/integration/coindcx/execution-evidence-adapter.ts');
        for (const target of [providers.CoinDcxPaperEvidence.prototype, provider]) {
          for (const [name, descriptor] of Object.entries(descriptors)) {
            if (name === 'constructor') continue;
            if (typeof descriptor.value !== 'function' && !descriptor.get) continue;
            Object.defineProperty(target, name, { value: () => ({ state: 'AVAILABLE', snapshot: {} }), configurable: true });
          }
          assert.equal(providers.readProductionAcquiredPaperExecutionEvidence(provider, 'B-BTC_USDT').state, 'UNAVAILABLE');
          assert.equal(providers.readProductionAcquiredPaperValuationEvidence(provider, ['B-BTC_USDT']).state, 'UNAVAILABLE');
        }
        for (const namespace of [providers, instrument]) {
          assert(Object.isFrozen(namespace));
          for (const key of Object.keys(namespace)) {
            const original = namespace[key];
            assert.equal(Reflect.set(namespace, key, () => 'FORGED'), false);
            assert.equal(namespace[key], original);
          }
        }
      }
      const adapter = require('./src/integration/coindcx/execution-evidence-adapter.ts');
      const issuer = require('./src/execution/trusted-evidence.ts');
      assert(Object.isFrozen(adapter)); assert(Object.isFrozen(issuer));
      console.log('IMMUTABLE_AUTHORITY_EXPORTS');
    `], { cwd: root, encoding: 'utf8' });
    expect(output.trim()).toBe('IMMUTABLE_AUTHORITY_EXPORTS');
  });

  it('release requires a revision and every production cleanup carries its admission revision', () => {
    for (const filename of ['paper-account-session.ts', 'admission-bridge.ts']) {
      const file = source(`src/execution/persistence/${filename}`);
      const release = descendants(file).filter(ts.isMethodDeclaration).find(method => method.name.getText(file) === 'releaseAndPersist');
      expect(release).toBeDefined();
      const revision = release!.parameters.find(parameter => parameter.name.getText(file) === 'expectedRevision');
      expect(revision?.type?.getText(file)).toBe('bigint');
      expect(revision?.questionToken).toBeUndefined();
      expect(revision?.initializer).toBeUndefined();
    }
    const file = source('src/integration/coindcx/paper-production-runtime.ts');
    const calls = descendants(file).filter(ts.isCallExpression).filter(call => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'releaseAndPersist');
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.arguments[2]?.getText(file)).toBe('admitted.accountRevision');
    const bridge = source('src/execution/persistence/admission-bridge.ts');
    const method = descendants(bridge).filter(ts.isMethodDeclaration).find(node => node.name.getText(bridge) === 'releaseAndPersist')!;
    const text = method.getText(bridge);
    expect(text.indexOf('account.revision !== expectedRevision')).toBeGreaterThan(0);
    expect(text.indexOf('account.revision !== expectedRevision')).toBeLessThan(text.indexOf('coordinator.release('));
  });

  it('economic replay comparator uses only durable account revision, with no timestamp fallback', () => {
    const file = source('src/execution/persistence/paper-account-reconciler.ts');
    const replay = descendants(file).filter(ts.isMethodDeclaration).find(method => method.name.getText(file) === '#reconcileDurableRiskState')!;
    const sorts = descendants(replay).filter(ts.isCallExpression).filter(call => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'sort' && call.arguments.length > 0);
    expect(sorts).toHaveLength(1);
    const fields = descendants(sorts[0]!.arguments[0]!).filter(ts.isPropertyAccessExpression).map(access => access.name.text);
    expect(fields).toEqual(['accountMutationRevision', 'accountMutationRevision']);
    expect(replay.getText(file)).toContain('LEGACY_UNVERIFIABLE_ACCOUNT_MUTATION_ORDER');
    const engine = source('src/execution/persistence/execution-engine.ts');
    const mutations = descendants(engine).filter(ts.isPropertyAssignment).filter(property => property.name.getText(engine) === 'accountMutationRevision');
    expect(mutations).toHaveLength(2);
    for (const mutation of mutations) expect(mutation.initializer.getText(engine)).toBe('account.revision + 1n');
  });
});
