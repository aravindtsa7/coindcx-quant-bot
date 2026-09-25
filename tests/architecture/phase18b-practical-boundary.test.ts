import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as practical from '../../src/execution/live/practical';
import { currentAccountContinuityCapability, requireCurrentReconciliation } from '../../src/execution/live/reconciliation/barrier';
import { buildImportGraph, computeReachable, extractImportSpecifiers } from './support/import-graph';

// Phase 18B Stage 1A: the practical tree is pure domain. It cannot reach the
// Phase 18 strict continuity barrier, cannot construct or name the strict
// continuity capability, cannot reach Prisma, the network, signing, or any
// CoinDCX module, reads no environment, and is wired into nothing but the
// Stage 1B1 durable persistence adapter (itself wired into nothing), so no
// caller can select a strict/practical gate.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const PRACTICAL_ROOT = 'src/execution/live/practical/';
const BARRIER = 'src/execution/live/reconciliation/barrier.ts';

const { graph, files } = buildImportGraph(SRC_ROOT, REPO_ROOT);
const practicalFiles = files.filter((file) => file.startsWith(PRACTICAL_ROOT)).sort();

function sourceOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

function codeOf(file: string): string {
  return sourceOf(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function reachOf(file: string): readonly string[] {
  return [file, ...computeReachable(graph, file)];
}

describe('Stage 1A practical tree', () => {
  it('discovers exactly the Stage 1A pure-domain modules', () => {
    const onDisk = readdirSync(path.join(REPO_ROOT, PRACTICAL_ROOT)).filter((name) => name.endsWith('.ts')).sort();
    expect(onDisk).toEqual(['certificate.ts', 'fence.ts', 'index.ts', 'invalidation.ts', 'policy.ts', 'state-machine.ts', 'types.ts']);
    expect(practicalFiles).toEqual(onDisk.map((name) => `${PRACTICAL_ROOT}${name}`));
  });
});

describe('no practical module can reach the strict continuity barrier or construct its capability', () => {
  it('no practical module imports, even transitively, the Phase 18 barrier', () => {
    for (const file of practicalFiles) expect(reachOf(file).includes(BARRIER), `${file} reaches the barrier`).toBe(false);
  });

  it('no practical module names a strict continuity symbol or the continuity literal', () => {
    for (const file of practicalFiles) {
      const code = codeOf(file);
      for (const forbidden of [
        'requireCurrentReconciliation', 'currentAccountContinuityCapability', 'LiveAccountContinuityCapability',
        'ACCOUNT_CONTINUITY_PROVEN', 'authorizeCurrentHealthy', 'LiveReconciliationAuthorization', 'evaluateReconciliationBarrier',
      ]) {
        expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
    }
  });

  it('no practical export value is, or produces, the continuity literal', () => {
    for (const [name, value] of Object.entries(practical)) {
      expect(JSON.stringify(typeof value === 'function' ? name : value) ?? '', name).not.toContain('ACCOUNT_CONTINUITY_PROVEN');
    }
    expect(practical.PRACTICAL_AUTHORIZATION_BASIS).toBe('PRACTICAL_RECOVERY');
  });

  it('the strict barrier imports no practical module (reach) and keeps its semantics', () => {
    expect(reachOf(BARRIER).filter((file) => file.startsWith(PRACTICAL_ROOT))).toEqual([]);
    // Semantic pins (the full refusal matrix lives in evidence-and-barrier.test.ts).
    expect(currentAccountContinuityCapability()).toBe('REST_CURRENT_STATE_OBSERVED');
    expect(requireCurrentReconciliation).toHaveLength(4);
  });
});

describe('no practical module reaches persistence, the network, signing, or CoinDCX', () => {
  it('reaches no integration module, mutation owner, signer, production root, or Prisma-backed repository', () => {
    for (const file of practicalFiles) {
      const reach = reachOf(file);
      expect(reach.filter((node) => node.startsWith('src/integration/')), file).toEqual([]);
      expect(reach.filter((node) => node.startsWith('src/persistence/')), file).toEqual([]);
      for (const forbidden of [
        'src/execution/live/repository.ts',
        'src/execution/live/reconciliation/repository.ts',
        'src/execution/live/reconciliation/service.ts',
        'src/execution/live/service.ts',
        'src/execution/live/gateway.ts',
        'src/execution/live/authority.ts',
      ]) {
        expect(reach.includes(forbidden), `${file} reaches ${forbidden}`).toBe(false);
      }
    }
  });

  it('the only external packages in the whole practical reach are logging, decimals, and hashing', () => {
    const external = new Set<string>();
    for (const file of practicalFiles) {
      for (const node of reachOf(file)) {
        for (const specifier of extractImportSpecifiers(sourceOf(node), node)) if (!specifier.startsWith('.')) external.add(specifier);
      }
    }
    expect([...external].sort()).toEqual(['decimal.js', 'node:crypto', 'pino']);
  });

  it('practical code reads no environment, clock, or network primitive and names no endpoint or signing header', () => {
    for (const file of practicalFiles) {
      const code = codeOf(file);
      for (const forbidden of ['process.env', 'Date.now', 'new Date(', 'performance.now', 'fetch(', 'Prisma', '@prisma', 'HmacSha256Signer', 'X-AUTH', '/exchange/v1', 'socket.io', 'axios']) {
        expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
    }
  });
});

describe('no caller-selectable gate and no premature wiring', () => {
  it('outside the practical tree, ONLY the Stage 1B1 persistence adapter imports it (no runtime, gateway, or barrier wiring)', () => {
    // [Stage 1B1] The exact importer set. Widening it (e.g. a runtime or a
    // gateway) must be an explicit, reviewed edit of this list.
    const importers = files.filter((file) => !file.startsWith(PRACTICAL_ROOT) && (graph.get(file) ?? []).some((dependency) => dependency.startsWith(PRACTICAL_ROOT)));
    expect(importers.sort()).toEqual([
      'src/execution/live/practical-persistence/plan.ts',
      'src/execution/live/practical-persistence/ports.ts',
      'src/execution/live/practical-persistence/repository.ts',
      'src/execution/live/practical-persistence/rows.ts',
    ]);
  });

  it('the barrel exposes exactly the reviewed Stage 1A surface: no gate, selector, or issuance', () => {
    expect(Object.keys(practical).sort()).toEqual([
      'PRACTICAL_ACCOUNT_STATES',
      'PRACTICAL_ALLOWED_TRANSITIONS',
      'PRACTICAL_AUTHORIZATION_BASIS',
      'PRACTICAL_INVALIDATION_REASONS',
      'PRACTICAL_INVALIDATION_SEVERITY',
      'PRACTICAL_MUTATION_ACTIONS',
      'PRACTICAL_MUTATION_OUTCOMES',
      'PRACTICAL_ROLLOUT_STAGES',
      'PRACTICAL_SAFETY_CEILINGS',
      'PRACTICAL_TIMING_CANDIDATES',
      'PracticalLiveSafetyEnablement',
      'PracticalLiveSafetyError',
      'PracticalRecoveryCertificate',
      'VERIFIED_REDUCE_ONLY_CAPABILITY',
      'adoptPracticalFenceForNewRuntime',
      'beginPracticalCertification',
      'beginPracticalMutationLease',
      'classifyPracticalInvalidation',
      'consumePracticalRecoveryCertificate',
      'evaluatePracticalLiveSafetyConfig',
      'finishPracticalCertification',
      'initialPracticalFence',
      'isAtLeastAsStrictAsCeilings',
      'isPracticalAccountStateName',
      'isPracticalInvalidationReason',
      'isPracticalMutationAction',
      'isPracticalRolloutStage',
      'practicalAccountStateOnStartup',
      'practicalActionPermission',
      'practicalStateAfterTransitionFailure',
      'practicalStateForSeverity',
      'readPracticalAccountFence',
      'releasePracticalMutationLease',
      'requirePracticalLiveSafetyEnablement',
      'revokePracticalRecoveryCertificate',
      'strictestPracticalSeverity',
      'transitionPracticalAccountState',
      'verifyPracticalRecoveryCertificate',
    ]);
  });

  it('no practical module accepts a strict/practical tier selector anywhere', () => {
    for (const file of practicalFiles) {
      expect(codeOf(file), file).not.toMatch(/'STRICT'|"STRICT"|STRICT_HEALTHY|selectGate|gateMode|tierSelector/);
    }
  });

});

// Every value that grants practical authority is minted at exactly one
// internal boundary. Each boundary's PRODUCTION importer set is pinned here,
// exactly. In Stage 1A every set is empty. A later stage adds its trusted
// caller (composition root, recovery service, operator-resolution adapter)
// by editing this table, which makes the widening an explicit, reviewed diff.
const AUTHORITY_ISSUERS: readonly { readonly symbol: string; readonly definedIn: string; readonly allowedProductionImporters: readonly string[] }[] = [
  { symbol: 'issuePracticalLiveSafetyEnablement', definedIn: `${PRACTICAL_ROOT}policy.ts`, allowedProductionImporters: [] },
  { symbol: 'mintPracticalManualReviewResolution', definedIn: `${PRACTICAL_ROOT}state-machine.ts`, allowedProductionImporters: [] },
  { symbol: 'issuePracticalRecoveryCertificate', definedIn: `${PRACTICAL_ROOT}certificate.ts`, allowedProductionImporters: [] },
];

describe('authority issuance boundaries are internal and pinned (P18B-1A-01, P18B-1A-02)', () => {
  it.each(AUTHORITY_ISSUERS)('$symbol: production src references it from exactly the allowed set (Stage 1A: none)', ({ symbol, definedIn, allowedProductionImporters }) => {
    expect(codeOf(definedIn)).toMatch(new RegExp(`export function ${symbol}\\(`));
    const referencing = files.filter((file) => file !== definedIn && codeOf(file).includes(symbol)).sort();
    expect(referencing).toEqual([...allowedProductionImporters].sort());
  });

  it.each(AUTHORITY_ISSUERS)('$symbol is not reachable through the practical barrel', ({ symbol }) => {
    expect(symbol in practical).toBe(false);
    expect(codeOf(`${PRACTICAL_ROOT}index.ts`)).not.toContain(symbol);
  });

  it('no src file can reach an issuer indirectly (no `export *`, namespace, dynamic, or require import of the practical tree)', () => {
    for (const file of files) {
      const code = codeOf(file);
      if (file.startsWith(PRACTICAL_ROOT)) {
        expect(code, file).not.toMatch(/export\s*\*|import\s*\*\s*as|\bimport\s*\(|\brequire\s*\(/);
      } else {
        expect(code, file).not.toMatch(/['"`][^'"`]*live\/practical(\/[\w-]+)?['"`]/);
      }
    }
  });

  it('the manual-review resolution class is exported from the barrel as a TYPE only (no constructor value)', () => {
    expect('PracticalManualReviewResolution' in practical).toBe(false);
    expect(codeOf(`${PRACTICAL_ROOT}index.ts`)).toMatch(/type PracticalManualReviewResolution,/);
  });

  it('no barrel export accepts configuration and returns an enablement (config parsing is data only)', () => {
    const evaluation = practical.evaluatePracticalLiveSafetyConfig({ LIVE_PRACTICAL_SAFETY_ENABLED: 'true', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: 'account-live-1' });
    expect(evaluation.status).toBe('ELIGIBLE');
    expect(practical.PracticalLiveSafetyEnablement.read(evaluation)).toBeNull();
    expect(Object.values(evaluation).some((value) => value instanceof practical.PracticalLiveSafetyEnablement)).toBe(false);
  });
});

describe('Stage-1B invariants are recorded next to the code they constrain', () => {
  it('certificate.ts records the durable UNIQUE certificate / atomic ISSUED -> CONSUMED invariant and forbids a global registry', () => {
    const source = sourceOf(`${PRACTICAL_ROOT}certificate.ts`);
    expect(source).toContain('STAGE-1B INVARIANT');
    expect(source).toMatch(/UNIQUE durable certificateId/);
    expect(source).toMatch(/ISSUED -> CONSUMED atomically/);
    expect(source).toMatch(/NOT be solved with a process-global in-memory registry/);
  });

  it('P18B-1A-09: no practical source tells callers to hard-code QUARANTINED after a failure; the fail-closed contract is recorded', () => {
    for (const file of practicalFiles) {
      expect(sourceOf(file), file).not.toMatch(/treat\s+(?:\*\s+)?the\s+(?:\*\s+)?account\s+(?:\*\s+)?as\s+(?:\*\s+)?QUARANTINED/);
    }
    const source = sourceOf(`${PRACTICAL_ROOT}state-machine.ts`);
    expect(source).toContain('STAGE 1B INTEGRATION CONTRACT');
    expect(source).toMatch(/practicalStateAfterTransitionFailure\(current\)/);
    expect(source).toMatch(/MUST NOT write QUARANTINED directly/);
    expect(source).toMatch(/malformed or unknown, Stage 1B\s+\*\s+creates \(or retains\) a MANUAL_REVIEW_REQUIRED episode/);
  });

  it('state-machine.ts records that Stage 1B loads the CURRENT durable reviewEpisodeId under the same trusted boundary', () => {
    const source = sourceOf(`${PRACTICAL_ROOT}state-machine.ts`);
    expect(source).toMatch(/load the CURRENT durable reviewEpisodeId/);
    expect(source).toMatch(/same trusted persistence boundary/);
  });
});

describe('certificate shape', () => {

  it('the one-shot, non-renewable, practical-only certificate shape is pinned in source', () => {
    const certificate = codeOf(`${PRACTICAL_ROOT}certificate.ts`);
    expect(certificate).toContain('provesAccountContinuity: false as const');
    // The TypeScript keyword `extends` is not a renewal; anything else named extend* is.
    expect(certificate).not.toMatch(/\b(renew\w*|refresh\w*|reissue\w*|prolong\w*|extend(?!s\b)\w*)/i);
  });
});
