import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { analyzeModuleReferences, buildImportGraph, listSourceFiles, resolveLocalSpecifier } from './support/import-graph';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = 'scripts/m4-lineage-export.ts';
const REPOSITORY = 'src/execution/live/repository.ts';
const EXPORT = 'src/execution/live/ownership-lineage-export.ts';
const ACCEPTANCE = 'scripts/m4-synthetic-acceptance.ts';
const MYSQL = 'scripts/m4-synthetic-mysql.ts';
const raw = readFileSync(path.join(ROOT, SCRIPT), 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const { graph, files } = buildImportGraph(path.join(ROOT, 'scripts'), ROOT);
const existing = new Set([...listSourceFiles(path.join(ROOT, 'src')), ...listSourceFiles(path.join(ROOT, 'scripts'))]);
function scriptImporters(target: string): string[] {
  return files.filter(file => analyzeModuleReferences(readFileSync(path.join(ROOT, file), 'utf8'), file).specifiers
    .some(specifier => resolveLocalSpecifier(path.join(ROOT, file), specifier, existing) === path.join(ROOT, target)));
}

describe('explicit M4 offline diagnostic composition boundary', () => {
  it('pins both known operational schema exclusions without importing test tooling or changing importer allowlists', () => {
    const helper = readFileSync(path.join(ROOT, 'tests/helpers/p18b-disposable-mysql.ts'), 'utf8');
    const known = /Object\.freeze\(\['coindcx_shadow', 'coindcx_quant'\]\)/;
    expect(helper).toMatch(known); expect(code).toMatch(known);
    expect(code).toContain('!KNOWN_PROTECTED_SCHEMA_NAMES.includes(name)');
    expect(code).toContain('identities.every(entry => name !== entry.databaseName.toLowerCase())');
    expect(code).not.toContain('tests/helpers');
  });
  it('pins the operator root plus its explicit synthetic adapter, and only the two synthetic harness importers of the root', () => {
    expect(scriptImporters(REPOSITORY)).toEqual([SCRIPT, MYSQL]);
    expect(scriptImporters(EXPORT)).toEqual([SCRIPT, MYSQL]);
    expect([...graph].filter(([, edges]) => edges.includes(SCRIPT)).map(([file]) => file)).toEqual([ACCEPTANCE, MYSQL]);
    const refs = analyzeModuleReferences(raw, SCRIPT);
    expect(refs.unresolvedDynamicLoads).toEqual([]);
    expect([...refs.specifiers].sort()).toEqual([
      '../src/execution/live/ownership-lineage-export', '../src/execution/live/repository', '@prisma/client',
      'node:child_process', 'node:crypto', 'node:fs/promises', 'node:path', 'zod',
    ].sort());
    expect(raw).toContain("const { PrismaLiveExecutionRepository } = await import('../src/execution/live/repository');");
    expect(code).not.toMatch(/claimDispatch|armDispatch|commitState|applyObservation|mintLive|SyncLineage|authorityEligible/);
  });
  it('keeps synthetic acceptance explicit, import-inert and outside src, with CLI env/HTTP denial only on its child', () => {
    for (const file of [ACCEPTANCE, MYSQL]) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (ts.isIfStatement(statement)) { expect(statement.expression.getText(source)).toBe('require.main === module'); continue; }
        if (ts.isVariableStatement(statement)) expect(statement.getText(source)).not.toMatch(/new Client|process\.|execFileSync\(|readFile\(|mkdir\(/);
        else expect(ts.isImportDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement)
          || ts.isTypeAliasDeclaration(statement)).toBe(true);
      }
      expect(text).not.toMatch(/from ['"][^'"]*integration|dotenv|production-runtime|mintLive|grantLive/);
    }
    for (const file of listSourceFiles(path.join(ROOT, 'src'))) expect(readFileSync(file, 'utf8')).not.toContain('m4-synthetic');
    const adapter = readFileSync(path.join(ROOT, MYSQL), 'utf8');
    expect(adapter).toContain("path.join(root, 'scripts/m4-synthetic-cli-guard.cjs')");
    expect(adapter).toContain("flag: 'wx'");
    expect(adapter).not.toMatch(/DROP DATABASE IF EXISTS|CREATE DATABASE IF NOT EXISTS|CREATE USER IF NOT EXISTS|ALTER USER/);
    expect(adapter).toContain('await requireMarker(); await admin.$executeRawUnsafe(`DROP DATABASE');
    expect(adapter).toContain("attributes[0]!['marker'] === marker");
  });
  it('has only declarations and pure schemas at module scope, with execution behind the main guard', () => {
    const source = ts.createSourceFile(SCRIPT, raw, ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement)) continue;
      if (ts.isIfStatement(statement)) {
        expect(statement.expression.getText(source)).toBe('require.main === module'); continue;
      }
      expect(ts.isVariableStatement(statement)).toBe(true);
      // Only pure schema construction or function values; no factory, filesystem, env, child process or timer call.
      expect(statement.getText(source)).not.toMatch(/new Prisma|process\.|execFileSync\(|readFile\(|lstat\(|realpath\(|setTimeout|setInterval/);
    }
    expect(code).not.toMatch(/dotenv|['"]\.env|DPAPI|fetch\(|node:https?|node:net|persistence\/prisma|integration\/|\$executeRaw/);
    expect(code.match(/process\.env/g)).toHaveLength(4);
    expect(code).toContain("if (process.env['DEBUG'] || process.env['RUST_LOG'] || process.env['PRISMA_LOG_LEVEL']) return undefined;");
    expect(code).toContain('return process.env[variable];');
    expect(code.match(/new PrismaClient\(/g)).toHaveLength(1);
    expect(code.match(/new PrismaLiveExecutionRepository\(/g)).toHaveLength(1);
    expect(code.match(/\$queryRaw`/g)).toHaveLength(2);
    expect(code.match(/exportOfflineLineageDiagnostic\(/g)).toHaveLength(1);
    expect(code).toContain("log: [], errorFormat: 'minimal'");
    expect(code.indexOf('requireNoPrismaEnvDiscovery(await readFile')).toBeLessThan(code.indexOf("await import('@prisma/client')"));
  });
});
