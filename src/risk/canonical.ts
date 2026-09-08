import { sha256CanonicalJson } from '../backtest/canonical-json';
import { riskSourceInvalid } from './errors';
import type { EvidenceProvenance } from './types';

export { sha256CanonicalJson };

export function assertExactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) riskSourceInvalid(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) riskSourceInvalid(`${label} has invalid keys`);
}

export function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) riskSourceInvalid(`${label} must be a non-empty exact string`);
}
export function assertSafeInteger(value: unknown, label: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) riskSourceInvalid(`${label} must be a safe integer >= ${minimum}`);
}

export function evidenceContentSha256(snapshot: { readonly provenance: EvidenceProvenance }): string {
  const { contentSha256: _contentSha256, ...provenance } = snapshot.provenance;
  return sha256CanonicalJson({ ...snapshot, provenance });
}
