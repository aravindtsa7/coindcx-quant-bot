import { sha256CanonicalJson } from '../risk/canonical';

/** Redacts credentials in exported/inspected evidence without reading any environment values. */
export function redactEvidence(value: unknown, secrets: readonly string[] = []): unknown {
  const sensitive = /(?:apikey|secret|password|passwd|token|authorization|databaseurl|credentials?)$/i;
  const known = [...new Set(secrets.filter(s => s.length > 0))].sort((a, b) => b.length - a.length);
  const text = (input: string): string => {
    let output = input;
    for (const secret of known) output = output.split(secret).join('[REDACTED]');
    return output.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, '[REDACTED AUTH]')
      .replace(/\b((?:mysql|postgres(?:ql)?|https?):\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(/\b((?:COINDCX_)?API[_-]?(?:KEY|SECRET)|PASSWORD|ACCESS_TOKEN|DATABASE_URL)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  };
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > 64) return '[DEPTH LIMIT]';
    if (typeof node === 'string') return text(node);
    if (Array.isArray(node)) return node.map(item => walk(item, depth + 1));
    if (node !== null && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, child]) =>
      [key, sensitive.test(key.replace(/[_-]/g, '')) && typeof child !== 'boolean' ? '[REDACTED]' : walk(child, depth + 1)]));
    return node;
  };
  return walk(value, 0);
}
export const evidenceDigest = (value: unknown): string => sha256CanonicalJson(JSON.stringify(value));
