import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

/**
 * [P14-J] True transitive local TypeScript import graph — parser + graph
 * algorithms. Uses the TypeScript compiler API already present as a project
 * devDependency (no new package added). Operates purely on source text via
 * `ts.createSourceFile`, never a full `ts.Program`/type-checker, so it stays
 * fast and dependency-free of build output.
 *
 * All node identifiers are POSIX-style paths relative to the repository
 * root (e.g. `src/execution/persistence/paper-account-kernel.ts`) so output
 * is OS-independent and deterministic regardless of platform path
 * separators or drive letters.
 */

export type ImportGraph = ReadonlyMap<string, readonly string[]>;

const SOURCE_EXTENSIONS = ['.ts', '.tsx'] as const;
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', 'coverage', '.git', 'generated']);

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

/** Recursively lists every `.ts`/`.tsx` (non-declaration) file under `dir`, sorted for determinism. Never descends into excluded directories. */
export function listSourceFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      results.push(...listSourceFiles(join(dir, entry.name)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) results.push(join(dir, entry.name));
  }
  return results.sort();
}

/**
 * Extracts every LOCAL (relative-specifier) module reference from one
 * file's source text: `import ... from './x'`, `export ... from './x'`,
 * `export * from './x'`, statically-resolvable `import('./x')`, and
 * `require('./x')`. Type-only local imports (`import type {...} from './x'`)
 * are included deliberately — a type-only edge is still an architecture
 * edge per the frozen P14-J boundary (§7/§9). Bare package specifiers
 * (no leading `.`) are not local edges and are filtered by the caller via
 * `resolveLocalSpecifier` returning `null` for them.
 */
export type ModuleLoadKind = 'dynamic-import' | 'require' | 'aliased-require' | 'module-require' | 'create-require' | 'indirect-loader';

export interface UnresolvedDynamicModuleLoad {
  readonly file: string;
  readonly kind: ModuleLoadKind;
  readonly line: number;
  readonly expression: string;
}

export interface ModuleReferenceAnalysis {
  readonly specifiers: readonly string[];
  readonly unresolvedDynamicLoads: readonly Omit<UnresolvedDynamicModuleLoad, 'file'>[];
}

function literalModuleSpecifier(node: ts.Expression | undefined): string | null {
  if (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return null;
}

/**
 * AST-based module-load analysis. In addition to normal imports/re-exports it
 * follows statically resolvable aliases of CommonJS `require`, `module.require`,
 * and loaders produced by `createRequire`. A computed loader target is evidence
 * of an unresolved architecture edge, not an edge that may be silently ignored.
 */
export function analyzeModuleReferences(sourceText: string, fileName: string): ModuleReferenceAnalysis {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  const unresolvedDynamicLoads: Omit<UnresolvedDynamicModuleLoad, 'file'>[] = [];
  const requireAliases = new Set(['require']);
  const createRequireNames = new Set<string>();
  const moduleNamespaceNames = new Set<string>();
  const moduleAliases = new Set(['module']);

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue;
    const moduleName = literalModuleSpecifier(statement.moduleSpecifier);
    if (moduleName !== 'node:module' && moduleName !== 'module') continue;
    const bindings = statement.importClause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) moduleNamespaceNames.add(bindings.name.text);
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === 'createRequire') createRequireNames.add(element.name.text);
      }
    }
  }

  const declarations: Array<{ readonly name: string; readonly initializer: ts.Expression }> = [];
  const destructuredModuleRequireAliases: string[] = [];
  const assignments: Array<{ readonly name: string; readonly initializer: ts.Expression }> = [];
  const collectAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (ts.isIdentifier(node.name)) declarations.push({ name: node.name.text, initializer: node.initializer });
      else if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(node.initializer) && moduleAliases.has(node.initializer.text)) {
        for (const element of node.name.elements) {
          if ((element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile)) === 'require' && ts.isIdentifier(element.name)) {
            destructuredModuleRequireAliases.push(element.name.text);
          }
        }
      }
    } else if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)
    ) {
      assignments.push({ name: node.left.text, initializer: node.right });
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(sourceFile);

  for (const alias of destructuredModuleRequireAliases) requireAliases.add(alias);

  const isModuleRequire = (expression: ts.Expression): boolean => {
    if (ts.isPropertyAccessExpression(expression)) {
      return ts.isIdentifier(expression.expression) && moduleAliases.has(expression.expression.text) && expression.name.text === 'require';
    }
    return ts.isElementAccessExpression(expression)
      && ts.isIdentifier(expression.expression)
      && moduleAliases.has(expression.expression.text)
      && literalModuleSpecifier(expression.argumentExpression) === 'require';
  };
  const isCreateRequireCall = (expression: ts.Expression): boolean =>
    ts.isCallExpression(expression)
    && (
      (ts.isIdentifier(expression.expression) && createRequireNames.has(expression.expression.text))
      || (ts.isPropertyAccessExpression(expression.expression)
        && ts.isIdentifier(expression.expression.expression)
        && moduleNamespaceNames.has(expression.expression.expression.text)
        && expression.expression.name.text === 'createRequire')
    );

  let changed = true;
  while (changed) {
    changed = false;
    for (const { name, initializer } of [...declarations, ...assignments]) {
      if (requireAliases.has(name)) continue;
      if (ts.isIdentifier(initializer) && moduleAliases.has(initializer.text)) {
        moduleAliases.add(name);
        changed = true;
        continue;
      }
      if (
        (ts.isIdentifier(initializer) && requireAliases.has(initializer.text))
        || isModuleRequire(initializer)
        || isCreateRequireCall(initializer)
        || (ts.isCallExpression(initializer)
          && ts.isPropertyAccessExpression(initializer.expression)
          && initializer.expression.name.text === 'bind'
          && (ts.isIdentifier(initializer.expression.expression)
            ? requireAliases.has(initializer.expression.expression.text)
            : isModuleRequire(initializer.expression.expression)))
      ) {
        requireAliases.add(name);
        changed = true;
      }
    }
  }

  const recordCall = (node: ts.CallExpression, kind: ModuleLoadKind): void => {
    const firstArg = node.arguments[0];
    const specifier = literalModuleSpecifier(firstArg);
    if (specifier !== null) {
      specifiers.push(specifier);
      return;
    }
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    unresolvedDynamicLoads.push({
      kind,
      line: line + 1,
      expression: node.getText(sourceFile),
    });
  };
  const recordUnresolvedNode = (node: ts.Node, kind: ModuleLoadKind): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    unresolvedDynamicLoads.push({ kind, line: line + 1, expression: node.getText(sourceFile) });
  };

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      const specifier = literalModuleSpecifier(moduleSpecifier);
      if (specifier !== null) specifiers.push(specifier);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isDynamicImport) recordCall(node, 'dynamic-import');
      else if (ts.isIdentifier(node.expression) && requireAliases.has(node.expression.text)) {
        recordCall(node, node.expression.text === 'require' ? 'require' : 'aliased-require');
      } else if (isModuleRequire(node.expression)) recordCall(node, 'module-require');
      else if (ts.isCallExpression(node.expression) && isCreateRequireCall(node.expression)) recordCall(node, 'create-require');
      else if (
        (ts.isIdentifier(node.expression) && (node.expression.text === 'eval' || node.expression.text === 'Function'))
        || (ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression)
          && node.expression.expression.text === 'process'
          && node.expression.name.text === 'getBuiltinModule')
      ) recordUnresolvedNode(node, 'indirect-loader');
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      recordUnresolvedNode(node, 'indirect-loader');
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { specifiers, unresolvedDynamicLoads };
}

export function extractImportSpecifiers(sourceText: string, fileName: string): string[] {
  return [...analyzeModuleReferences(sourceText, fileName).specifiers];
}

/**
 * Resolves a relative specifier from `fromFile` to an absolute file path
 * actually present in `existingFiles`, trying (in order) the exact path,
 * `.ts`, `.tsx`, `/index.ts`, `/index.tsx`. Returns `null` for a bare
 * (non-relative) specifier or one that resolves to nothing in the set —
 * the caller treats `null` as "not a local edge" (external package) rather
 * than an error, except the real-repo test additionally asserts zero
 * unresolved relative specifiers (§8/§31 — every relative import in this
 * repo must resolve to a real file; a silent miss would hide a violation).
 */
export function resolveLocalSpecifier(fromFile: string, specifier: string, existingFiles: ReadonlySet<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
  for (const candidate of candidates) {
    if (existingFiles.has(candidate)) return candidate;
  }
  return null;
}

export interface BuildImportGraphResult {
  /** Repo-root-relative POSIX paths, sorted. */
  readonly files: readonly string[];
  /** Adjacency map keyed by repo-root-relative POSIX path; each edge list is sorted and de-duplicated. */
  readonly graph: ImportGraph;
  /** Every relative import specifier this build could not resolve to a file in `files` — should always be empty for a real project tree (§8/§31). */
  readonly unresolved: readonly { readonly file: string; readonly specifier: string }[];
  /** Computed/otherwise non-literal module loads. Protected production code must reject these unless explicitly reviewed. */
  readonly unresolvedDynamicLoads: readonly UnresolvedDynamicModuleLoad[];
}

/**
 * Builds the full local import graph for every `.ts`/`.tsx` file under
 * `absoluteRootDir`. Deterministic: file discovery and every edge list are
 * sorted; no reliance on filesystem enumeration order (§8).
 */
export function buildImportGraph(absoluteRootDir: string, repoRoot: string): BuildImportGraphResult {
  const absoluteFiles = listSourceFiles(absoluteRootDir);
  const absoluteFileSet = new Set(absoluteFiles);
  const toRepoRelative = (absPath: string): string => toPosix(relative(repoRoot, absPath));

  const graph = new Map<string, string[]>();
  const unresolved: { readonly file: string; readonly specifier: string }[] = [];
  const unresolvedDynamicLoads: UnresolvedDynamicModuleLoad[] = [];

  for (const absoluteFile of absoluteFiles) {
    const sourceText = readFileSync(absoluteFile, 'utf8');
    const analysis = analyzeModuleReferences(sourceText, absoluteFile);
    const specifiers = analysis.specifiers;
    unresolvedDynamicLoads.push(...analysis.unresolvedDynamicLoads.map((load) => ({
      file: toRepoRelative(absoluteFile),
      ...load,
    })));
    const edges = new Set<string>();
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue; // external package — not a local architecture edge
      const resolved = resolveLocalSpecifier(absoluteFile, specifier, absoluteFileSet);
      if (resolved === null) {
        unresolved.push({ file: toRepoRelative(absoluteFile), specifier });
        continue;
      }
      edges.add(toRepoRelative(resolved));
    }
    graph.set(toRepoRelative(absoluteFile), [...edges].sort());
  }

  return {
    files: absoluteFiles.map(toRepoRelative).sort(),
    graph,
    unresolved: unresolved.slice().sort((a, b) => (a.file === b.file ? (a.specifier < b.specifier ? -1 : 1) : a.file < b.file ? -1 : 1)),
    unresolvedDynamicLoads: unresolvedDynamicLoads.slice().sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1),
  };
}

/**
 * Full transitive reachable set from `root` (root itself excluded unless a
 * cycle routes back to it). Cycle-safe by construction (visited-set-gated
 * iterative DFS, never recursion-per-edge) — never infinite-loops on an
 * import cycle (§30). Deterministic given a deterministic `graph` (edge
 * lists pre-sorted by `buildImportGraph`).
 */
export function computeReachable(graph: ImportGraph, root: string): ReadonlySet<string> {
  const visited = new Set<string>();
  const stack: string[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as string;
    if (visited.has(node)) continue;
    visited.add(node);
    const neighbors = graph.get(node) ?? [];
    for (let i = neighbors.length - 1; i >= 0; i -= 1) stack.push(neighbors[i] as string);
  }
  visited.delete(root);
  return visited;
}

/**
 * Deterministic shortest violation path from `root` to the first node
 * (in sorted-BFS-expansion order) satisfying `isTarget`, or `null` if none
 * is reachable. BFS with a `parent` map — cycle-safe (a node is enqueued at
 * most once) and produces the same path every run for the same graph
 * (§8/§28).
 */
export function findPath(graph: ImportGraph, root: string, isTarget: (node: string) => boolean): readonly string[] | null {
  const parent = new Map<string, string | null>();
  parent.set(root, null);
  const queue: string[] = [root];
  let head = 0;
  while (head < queue.length) {
    const node = queue[head] as string;
    head += 1;
    if (node !== root && isTarget(node)) {
      const path: string[] = [];
      let cursor: string | null = node;
      while (cursor !== null) {
        path.unshift(cursor);
        cursor = parent.get(cursor) ?? null;
      }
      return path;
    }
    const neighbors = graph.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (!parent.has(neighbor)) {
        parent.set(neighbor, node);
        queue.push(neighbor);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public-export-surface closure (§18/§19/§52 capability export safety)
// ---------------------------------------------------------------------------

function declaredExportName(statement: ts.Statement): string | null {
  if (!ts.canHaveModifiers(statement)) return null;
  const isExported = (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  if (!isExported) return null;
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return statement.name?.text ?? null;
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) return statement.name.text;
  return null;
}

/**
 * The full set of names publicly reachable by importing `entryAbsFile` —
 * i.e. every name a normal external caller could obtain from this module,
 * following `export { X } from './y'` and `export * from './y'` chains
 * recursively (§18/§19). A name that is merely declared with `const`/etc but
 * never exported from ITS OWN defining file can never appear here by
 * construction, regardless of any barrel — this function proves exactly
 * that "structurally unreachable" property for such names, and separately
 * confirms an exported-but-non-barrel name (e.g. `SESSION_PROOF`) is not
 * re-exported by any of the given entry points. Cycle-safe (`seen` guard);
 * never a full type-checker resolution, only the same lightweight AST parse
 * used throughout this module.
 */
export function collectPublicExportNames(
  entryAbsFile: string,
  readFile: (absFile: string) => string,
  resolveSpecifier: (fromAbsFile: string, specifier: string) => string | null,
  seen: Set<string> = new Set(),
): ReadonlySet<string> {
  if (seen.has(entryAbsFile)) return new Set();
  seen.add(entryAbsFile);
  const names = new Set<string>();
  const sourceFile = ts.createSourceFile(entryAbsFile, readFile(entryAbsFile), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text);
        continue;
      }
      // `export * from './y'` (or `export * as ns from './y'`) — recurse into the target's own public surface.
      const moduleSpecifier = statement.moduleSpecifier;
      if (moduleSpecifier !== undefined && ts.isStringLiteral(moduleSpecifier)) {
        const targetFile = resolveSpecifier(entryAbsFile, moduleSpecifier.text);
        if (targetFile !== null) {
          for (const name of collectPublicExportNames(targetFile, readFile, resolveSpecifier, seen)) names.add(name);
        }
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const isExported = (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!isExported) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
      continue;
    }
    const name = declaredExportName(statement);
    if (name !== null) names.add(name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Live-mutating-order-symbol scan (§12/§13/§33 — evidence-based sink detection)
// ---------------------------------------------------------------------------

/** Deliberately conservative/over-inclusive: matches a mutating verb immediately followed by "order", case-insensitive, on ANY function/method/arrow-const declaration (exported or not) — never a bare filename guess. `listInrFuturesOrders` (a read/list method) does not match: it has no mutating-verb prefix. */
const MUTATING_ORDER_NAME_PATTERN = /^(create|place|submit|cancel|modify|amend|delete|new)[a-z]*order/i;

export interface MutatingSymbolHit {
  readonly file: string;
  readonly name: string;
}

/** Scans every given file for a declared function/method/arrow-function whose name matches `MUTATING_ORDER_NAME_PATTERN` — the evidence-based candidate set for "live order-mutating sink" (§12/§33), never a filename regex. */
export function findMutatingOrderSymbols(absoluteFiles: readonly string[], readFile: (absFile: string) => string): readonly MutatingSymbolHit[] {
  const hits: MutatingSymbolHit[] = [];
  for (const file of absoluteFiles) {
    const sourceFile = ts.createSourceFile(file, readFile(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      let name: string | undefined;
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) && node.name !== undefined && ts.isIdentifier(node.name)) {
        name = node.name.text;
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        name = node.name.text;
      }
      if (name !== undefined && MUTATING_ORDER_NAME_PATTERN.test(name)) hits.push({ file, name });
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return hits.sort((a, b) => (a.file === b.file ? (a.name < b.name ? -1 : 1) : a.file < b.file ? -1 : 1));
}
