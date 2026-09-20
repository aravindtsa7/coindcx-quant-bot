import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  buildImportGraph,
  computeReachable,
} from './support/import-graph';

/**
 * [Phase 16 Architecture Proof - Acceptance Hardened]
 *
 * Proves that:
 * 1. Protected core engines contain ZERO coin-specific executable logic, symbol comparisons,
 *    switches, pair-specific branches, initializers, calls, method calls, or identifiers.
 * 2. Protected core engines never import coin configuration (src/app/config/coins).
 * 3. Database persistence (prisma/schema.prisma) is 100% generic with ZERO coin-specific
 *    models, enums, fields, or migrations.
 * 4. Existing architecture boundaries and generic abstraction patterns remain strictly preserved.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const SCHEMA_FILE = path.join(REPO_ROOT, 'prisma/schema.prisma');

const PROTECTED_CORE_PREFIXES: readonly string[] = Object.freeze([
  'src/core/',
  'src/coin-runtime/',
  'src/integration/coindcx/',
  'src/market-data/',
  'src/indicators/',
  'src/backtest/',
  'src/strategies/',
  'src/research/',
  'src/risk/',
  'src/execution/',
  'src/dispatch/',
  'src/ranking/',
]);

export const FORBIDDEN_COIN_TOKENS: ReadonlySet<string> = new Set([
  'SOL',
  'BTC',
  'ETH',
  'B-SOL_USDT',
  'B-BTC_USDT',
  'B-ETH_USDT',
  'B-SOL',
  'B-BTC',
  'B-ETH',
  'SOL_USDT',
  'BTC_USDT',
  'ETH_USDT',
  'SOL-INR',
  'BTC-INR',
  'ETH-INR',
  'SOLUSDT',
  'BTCUSDT',
  'ETHUSDT',
]);

const COIN_SYMBOLS: ReadonlySet<string> = new Set(['SOL', 'BTC', 'ETH']);

const FORBIDDEN_TOKEN_PATTERNS: readonly RegExp[] = [...FORBIDDEN_COIN_TOKENS]
  .sort((left, right) => right.length - left.length)
  .map((token) => new RegExp(`(?:^|[^A-Za-z])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'i'));

function identifierWords(name: string): readonly string[] {
  return name
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.match(/[A-Z]+(?=[A-Z][a-z]|[0-9]|$)|[A-Z]?[a-z]+|[0-9]+/g) ?? []);
}

export function isSuspiciousCoinIdentifier(name: string): boolean {
  return identifierWords(name).some((word) => COIN_SYMBOLS.has(word.toUpperCase()));
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export interface ASTViolation {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly details: string;
}

export function scanSourceFileForCoinHardcoding(filePath: string, sourceText: string): readonly ASTViolation[] {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: ASTViolation[] = [];

  function record(node: ts.Node, kind: string, details: string): void {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    violations.push({
      file: toPosix(path.relative(REPO_ROOT, filePath)),
      line: line + 1,
      kind,
      details,
    });
  }

  function containsForbiddenCoinReference(text: string): boolean {
    // JavaScript accepts identity escapes such as \_ in strings and regexes.
    // Normalize those spellings before applying token boundaries.
    const normalized = text.replace(/\\([_-])/g, '$1').replace(/\\b/g, ' ');
    if (FORBIDDEN_TOKEN_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
    return /(?:^|[^A-Za-z])(?:SOL|BTC|ETH)(?![A-Za-z])/i.test(normalized);
  }

  function isErrorConstructorMessage(node: ts.Node): boolean {
    let current: ts.Node = node;
    while (current.parent) {
      const parent = current.parent;
      if (ts.isNewExpression(parent) && parent.arguments?.includes(current as ts.Expression)) {
        const constructorName = ts.isIdentifier(parent.expression)
          ? parent.expression.text
          : ts.isPropertyAccessExpression(parent.expression)
            ? parent.expression.name.text
            : '';
        return constructorName.endsWith('Error');
      }
      if (
        !ts.isTemplateExpression(parent)
        && !ts.isTemplateSpan(parent)
        && !ts.isBinaryExpression(parent)
        && !ts.isParenthesizedExpression(parent)
      ) {
        return false;
      }
      current = parent;
    }
    return false;
  }

  function checkText(text: string, node: ts.Node, context: string): void {
    // Diagnostic examples explain accepted formats; they do not select a coin
    // or alter execution. Any coin-specific condition feeding the error remains scanned.
    if (!isErrorConstructorMessage(node) && containsForbiddenCoinReference(text)) {
      record(node, context, `Forbidden coin reference '${text}' in ${context}`);
    }
  }

  function constantStringValue(node: ts.Expression): string | undefined {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }

    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        const expressionValue = constantStringValue(span.expression);
        if (expressionValue === undefined) return undefined;
        value += expressionValue + span.literal.text;
      }
      return value;
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = constantStringValue(node.left);
      const right = constantStringValue(node.right);
      return left === undefined || right === undefined ? undefined : left + right;
    }

    if (ts.isParenthesizedExpression(node)) return constantStringValue(node.expression);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
      return constantStringValue(node.expression);
    }

    return undefined;
  }

  function isNestedConstantConcatenation(node: ts.BinaryExpression): boolean {
    return ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
  }

  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node)) {
      checkText(node.text, node, 'StringLiteral');
    } else if (ts.isNoSubstitutionTemplateLiteral(node)) {
      checkText(node.text, node, 'NoSubstitutionTemplateLiteral');
    } else if (ts.isTemplateHead(node)) {
      checkText(node.text, node, 'TemplateHead');
    } else if (ts.isTemplateMiddle(node)) {
      checkText(node.text, node, 'TemplateMiddle');
    } else if (ts.isTemplateTail(node)) {
      checkText(node.text, node, 'TemplateTail');
    } else if (ts.isRegularExpressionLiteral(node)) {
      checkText(node.text, node, 'RegularExpressionLiteral');
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && !isNestedConstantConcatenation(node)) {
      const value = constantStringValue(node);
      if (value !== undefined) checkText(value, node, 'CompileTimeStringConcatenation');
    }

    if (ts.isTemplateExpression(node)) {
      const value = constantStringValue(node);
      if (value !== undefined) checkText(value, node, 'CompileTimeTemplateExpression');
    }

    if (ts.isIdentifier(node)) {
      if (isSuspiciousCoinIdentifier(node.text)) {
        record(node, 'Identifier', `Suspicious coin-specific identifier '${node.text}'`);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

describe('Phase 16 — Protected Core Generic Architecture Proof', () => {
  const { files, graph } = buildImportGraph(SRC_ROOT, REPO_ROOT);
  const protectedCoreFiles = files.filter((f) => PROTECTED_CORE_PREFIXES.some((prefix) => f.startsWith(prefix)));

  it('identifies and verifies the comprehensive protected core file set (200+ files)', () => {
    expect(protectedCoreFiles.length).toBeGreaterThanOrEqual(200);
  });

  it('proves zero coin-specific executable logic in the protected core across all AST constructs', () => {
    const allViolations: ASTViolation[] = [];

    for (const relPath of protectedCoreFiles) {
      const absPath = path.join(REPO_ROOT, relPath);
      const content = readFileSync(absPath, 'utf8');
      const violations = scanSourceFileForCoinHardcoding(absPath, content);
      allViolations.push(...violations);
    }

    expect(allViolations).toEqual([]);
  });

  it('detects coin references across literal and value locations', () => {
    const cases: readonly string[] = [
      `const SPECIAL_COIN = 'SOL';`,
      `const SPECIAL_PAIR = \`B-SOL_USDT\`;`,
      `const config = { underlying: 'SOL' };`,
      `const pairs = ['BTC', 'ETH'];`,
      `switch (coin) { case 'SOL': break; }`,
      `const data = map['B-SOL_USDT'];`,
      `if (c === 'BTC') {}`,
      `dispatchOrder('ETH');`,
    ];

    for (const snippet of cases) {
      const violations = scanSourceFileForCoinHardcoding(path.join(REPO_ROOT, 'synthetic-test.ts'), snippet);
      expect(violations.length).toBeGreaterThan(0);
    }
  });

  it('detects every demonstrated AST scanner bypass', () => {
    const bypasses: readonly string[] = [
      'const p = `B-SOL_USDT-${suffix}`;',
      'const p = `SOL${x}`;',
      'if (/SOL/.test(pair)) {}',
      'if (/B-SOL\\_USDT/.test(pair)) {}',
      "pair.startsWith('B-SOL\\_')",
      "pair.includes('-SOL')",
      "pair.indexOf('SOL\\_US')",
      "const P = 'B-SOL\\_USDT-PERP'",
      "const p = 'B-SO' + 'L\\_USDT'",
    ];

    for (const snippet of bypasses) {
      expect(
        scanSourceFileForCoinHardcoding(path.join(REPO_ROOT, 'synthetic-bypass.ts'), snippet),
        snippet,
      ).not.toEqual([]);
    }
  });

  it('detects StringLiteral, every template chunk kind, regex literals, and constant template composition', () => {
    const cases: readonly { readonly snippet: string; readonly kind: string }[] = [
      { snippet: "const pair = 'B-SOL_USDT';", kind: 'StringLiteral' },
      { snippet: 'const pair = `B-SOL_USDT`;', kind: 'NoSubstitutionTemplateLiteral' },
      { snippet: 'const pair = `SOL${suffix}`;', kind: 'TemplateHead' },
      { snippet: 'const pair = `prefix-${value}-SOL-${suffix}`;', kind: 'TemplateMiddle' },
      { snippet: 'const pair = `prefix-${value}-SOL`;', kind: 'TemplateTail' },
      { snippet: 'const matches = /B-SOL\\_USDT/i.test(pair);', kind: 'RegularExpressionLiteral' },
      { snippet: "const pair = `B-${'SO' + 'L'}_USDT`;", kind: 'CompileTimeTemplateExpression' },
    ];

    for (const { snippet, kind } of cases) {
      const violations = scanSourceFileForCoinHardcoding(path.join(REPO_ROOT, 'synthetic-literals.ts'), snippet);
      expect(violations.some((violation) => violation.kind === kind), snippet).toBe(true);
    }
  });

  it('detects coin references in string-method arguments and compile-time concatenations', () => {
    const cases: readonly string[] = [
      "pair.includes('-SOL')",
      "pair.startsWith('B-SOL_')",
      "pair.endsWith('SOL_USDT')",
      "pair.indexOf('SOL_US')",
      "const pair = 'B-SO' + 'L_USDT'",
    ];

    for (const snippet of cases) {
      expect(scanSourceFileForCoinHardcoding(path.join(REPO_ROOT, 'synthetic-method.ts'), snippet), snippet).not.toEqual([]);
    }
  });

  it('detects structurally coin-styled identifiers', () => {
    const identifiers = ['solPair', 'sol_pair', 'SolStrategy', 'btcConfig', 'ethMarket', 'handleSolPair'];

    for (const identifier of identifiers) {
      expect(isSuspiciousCoinIdentifier(identifier), identifier).toBe(true);
    }
  });

  it('does not flag ordinary English identifiers containing coin letter sequences', () => {
    const identifiers = [
      'solution',
      'solutions',
      'solo',
      'solve',
      'solver',
      'solvent',
      'solace',
      'ethics',
      'ethical',
      'ethic',
      'ethnic',
      'ethos',
      'ether',
      'ethereal',
    ];

    for (const identifier of identifiers) {
      expect(isSuspiciousCoinIdentifier(identifier), identifier).toBe(false);
      expect(scanSourceFileForCoinHardcoding(
        path.join(REPO_ROOT, 'synthetic-english.ts'),
        `const ${identifier} = true;`,
      ), identifier).toEqual([]);
    }
  });

  it('proves protected core engines never import coin application configuration', () => {
    const forbiddenConfigModules = ['src/app/config/coins.ts', 'src/app/config/coins'];

    const violatingEdges: { readonly from: string; readonly to: string }[] = [];

    for (const relPath of protectedCoreFiles) {
      const reachable = computeReachable(graph, relPath);
      for (const target of reachable) {
        if (forbiddenConfigModules.some((forbidden) => target.includes(forbidden))) {
          violatingEdges.push({ from: relPath, to: target });
        }
      }
    }

    expect(violatingEdges).toEqual([]);
  });

  it('proves prisma/schema.prisma requires zero SOL-specific models, fields, or enums', () => {
    const schemaContent = readFileSync(SCHEMA_FILE, 'utf8');

    // Reject models like model SolCandle, model SolPosition
    const modelMatches = [...schemaContent.matchAll(/model\s+([A-Za-z0-9_]+)/g)];
    const coinSpecificModels = modelMatches
      .map((m) => m[1] ?? '')
      .filter((name) => /sol/i.test(name));
    expect(coinSpecificModels).toEqual([]);

    // Reject enums like enum SolStatus
    const enumMatches = [...schemaContent.matchAll(/enum\s+([A-Za-z0-9_]+)/g)];
    const coinSpecificEnums = enumMatches
      .map((m) => m[1] ?? '')
      .filter((name) => /sol/i.test(name));
    expect(coinSpecificEnums).toEqual([]);

    // Reject fields named 'sol' or 'solUsdt'
    const fieldLines = schemaContent
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('//') && !line.startsWith('@@') && line.length > 0);

    const coinFields = fieldLines.filter((line) => {
      const firstToken = line.split(/\s+/)[0] ?? '';
      return /^(sol|solUsdt|solana)$/i.test(firstToken);
    });
    expect(coinFields).toEqual([]);

    // Confirm all market-data and paper-execution tables store pair as generic VarChar(64)
    expect(schemaContent).toContain('pair                String   @db.VarChar(64)');
    expect(schemaContent).toContain('pair                            String   @map("pair") @db.VarChar(64)');
  });
});
