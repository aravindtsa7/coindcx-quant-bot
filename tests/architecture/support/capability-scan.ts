import ts from 'typescript';
import { analyzeModuleReferences } from './import-graph';

const NETWORK_MODULES = new Set([
  'http', 'https', 'node:http', 'node:https', 'net', 'node:net', 'tls', 'node:tls',
  'axios', 'got', 'node-fetch', 'undici', 'socket.io-client', 'ws',
]);
const CRYPTO_MODULES = new Set(['crypto', 'node:crypto']);

export type SourceCapability = 'NETWORK_MODULE' | 'GLOBAL_FETCH' | 'CRYPTO_MODULE';

export interface SourceCapabilityHit {
  readonly file: string;
  readonly capability: SourceCapability;
  readonly detail: string;
}

/**
 * Finds primitive capabilities from syntax, independent of endpoint strings,
 * function names, wrappers, and export names. Import aliases and CommonJS
 * loader aliases are resolved by `analyzeModuleReferences`.
 */
export function scanSourceCapabilities(
  files: readonly string[],
  readFile: (file: string) => string,
): readonly SourceCapabilityHit[] {
  const hits: SourceCapabilityHit[] = [];
  for (const file of files) {
    const source = readFile(file);
    const references = analyzeModuleReferences(source, file);
    for (const specifier of new Set(references.specifiers)) {
      if (NETWORK_MODULES.has(specifier)) hits.push({ file, capability: 'NETWORK_MODULE', detail: specifier });
      if (CRYPTO_MODULES.has(specifier)) hits.push({ file, capability: 'CRYPTO_MODULE', detail: specifier });
    }

    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let usesFetch = false;
    const visit = (node: ts.Node): void => {
      // Treat any value-level `fetch` reference as capability ownership so an
      // alias (`const send = fetch`) cannot escape a call-name check.
      if (ts.isIdentifier(node) && node.text === 'fetch' && !ts.isPropertyAccessExpression(node.parent)) usesFetch = true;
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'fetch') usesFetch = true;
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (usesFetch) hits.push({ file, capability: 'GLOBAL_FETCH', detail: 'fetch' });
  }
  return hits.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.capability !== b.capability) return a.capability < b.capability ? -1 : 1;
    return a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0;
  });
}
