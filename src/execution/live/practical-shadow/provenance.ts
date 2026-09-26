/**
 * Phase 18B Checkpoint C: shadow campaign SOFTWARE PROVENANCE.
 *
 * A calibration dataset must name exactly the software that produced it. A
 * campaign is bound to the source commit it runs from, and it may be started
 * or resumed ONLY from a CLEAN source tree at an exact commit:
 *
 *   CLEAN tree at a 40-hex commit -> the commit is the campaign's software version
 *   uncommitted/untracked changes -> SHADOW_SOURCE_DIRTY, no campaign is created
 *   commit or cleanliness unknown -> SHADOW_SOURCE_PROVENANCE_UNAVAILABLE (fail closed)
 *
 * There is NO dirty/development mode: two different uncommitted trees can
 * never produce datasets that claim the same software version. Nothing about
 * the tree's contents (no diff, no file list, no source) is persisted; only
 * the clean commit is.
 *
 * Pure: the caller supplies the raw probe (the CLI script runs
 * `git rev-parse --verify HEAD` and `git status --porcelain`; tests inject a
 * deterministic probe). Grants no authority.
 */
import { PracticalShadowError } from './types';

/** The only accepted provenance kind (persisted as `source_provenance`). */
export const PRACTICAL_SHADOW_SOURCE_PROVENANCE_KIND = 'GIT_CLEAN_COMMIT';
export type PracticalShadowSourceProvenanceKind = typeof PRACTICAL_SHADOW_SOURCE_PROVENANCE_KIND;

export const PRACTICAL_SHADOW_SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** Raw probe output; `null` means the probe itself failed (no git, not a repository, ...). */
export interface PracticalShadowSourceProbe {
  /** `git rev-parse --verify HEAD` output. */
  readonly head: string | null;
  /** `git status --porcelain` output (untracked files included, ignored files excluded). */
  readonly status: string | null;
}

export type PracticalShadowSourceProvenance =
  | { readonly state: 'CLEAN'; readonly kind: PracticalShadowSourceProvenanceKind; readonly commit: string }
  /** Only the NUMBER of changed entries is kept, for the operator message; never their names or contents. */
  | { readonly state: 'DIRTY'; readonly changedEntries: number }
  | { readonly state: 'UNAVAILABLE' };

/** Classifies a raw probe. Anything short of an exact commit AND an empty status is not CLEAN. */
export function resolvePracticalShadowSourceProvenance(probe: PracticalShadowSourceProbe | null | undefined): PracticalShadowSourceProvenance {
  const head = typeof probe?.head === 'string' ? probe.head.trim() : null;
  const status = typeof probe?.status === 'string' ? probe.status : null;
  if (head === null || !PRACTICAL_SHADOW_SOURCE_COMMIT_PATTERN.test(head) || status === null) return Object.freeze({ state: 'UNAVAILABLE' as const });
  const changedEntries = status.split('\n').filter((line) => line.trim() !== '').length;
  if (changedEntries > 0) return Object.freeze({ state: 'DIRTY' as const, changedEntries });
  return Object.freeze({ state: 'CLEAN' as const, kind: PRACTICAL_SHADOW_SOURCE_PROVENANCE_KIND, commit: head });
}

/** The refusal code for a provenance that is not CLEAN; null when CLEAN. */
export function practicalShadowSourceRefusal(provenance: PracticalShadowSourceProvenance): 'SHADOW_SOURCE_DIRTY' | 'SHADOW_SOURCE_PROVENANCE_UNAVAILABLE' | null {
  if (provenance.state === 'CLEAN' && provenance.kind === PRACTICAL_SHADOW_SOURCE_PROVENANCE_KIND && PRACTICAL_SHADOW_SOURCE_COMMIT_PATTERN.test(provenance.commit)) return null;
  return provenance.state === 'DIRTY' ? 'SHADOW_SOURCE_DIRTY' : 'SHADOW_SOURCE_PROVENANCE_UNAVAILABLE';
}

/** True only for a persisted binding that names a trusted clean commit. */
export function isTrustedPracticalShadowProvenance(sourceProvenance: string, softwareVersion: string): boolean {
  return sourceProvenance === PRACTICAL_SHADOW_SOURCE_PROVENANCE_KIND && PRACTICAL_SHADOW_SOURCE_COMMIT_PATTERN.test(softwareVersion);
}

/** Throws unless the binding names a trusted clean commit (store-level defence in depth; MySQL also CHECKs it). */
export function requireTrustedPracticalShadowProvenance(sourceProvenance: string, softwareVersion: string): void {
  if (!isTrustedPracticalShadowProvenance(sourceProvenance, softwareVersion)) {
    throw new PracticalShadowError('SHADOW_SOURCE_PROVENANCE_UNAVAILABLE', 'A campaign binding must name an exact CLEAN source commit');
  }
}
