import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as liveBarrel from '../../src/execution/live';
import * as practicalBarrel from '../../src/execution/live/practical';
import { PRACTICAL_CLASSIFIED_PRE_WRITE_CLAIM_FAILURE_CODES } from '../../src/execution/live/practical-mutation/preflight';
import { practicalPrivateStreamReadiness } from '../../src/execution/live/practical-recovery/private-events';
import { currentAccountContinuityCapability, requireCurrentReconciliation } from '../../src/execution/live/reconciliation/barrier';
import { buildImportGraph, computeReachable, extractImportSpecifiers } from './support/import-graph';

// Phase 18B Stage 1B2, Wave 2B1: the order-bound practical CANCEL mutation store.
//
//   - ports.ts, ticket.ts, preflight.ts are Prisma-free and network-free; repository.ts is the ONLY
//     Stage 1B2 Prisma adapter; there is no barrel.
//   - It is the ONLY src/ importer (besides live/repository.ts itself) of the Wave 2A claim/arm
//     primitives, never of completion, and it fences the Tier-B arm with the EXACT account (never null).
//   - It names no strict authority (no LiveReconciliationAuthorization, no strict barrier, no strict
//     fence) and never claims continuity.
//   - Nothing imports it (not wired); it reaches no gateway, integration, transport, signer, runtime,
//     private stream, or recovery engine.
//   - The caller-owned Stage 1B1 hook uses ONLY the supplied transaction client.
//   - The classified Phase 17 pre-write claim failures are EXACTLY three, pinned against the committed
//     claim source to occur before its only UPDATE.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const MUTATION_ROOT = 'src/execution/live/practical-mutation/';
const ADAPTER = `${MUTATION_ROOT}repository.ts`;
const PURE_FILES = [`${MUTATION_ROOT}ports.ts`, `${MUTATION_ROOT}preflight.ts`, `${MUTATION_ROOT}ticket.ts`];
const LIVE_REPOSITORY = 'src/execution/live/repository.ts';
const PRACTICAL_REPOSITORY = 'src/execution/live/practical-persistence/repository.ts';
const PRACTICAL_PORT = 'src/execution/live/practical-persistence/ports.ts';

const { graph, files } = buildImportGraph(SRC_ROOT, REPO_ROOT);
const mutationFiles = files.filter((file) => file.startsWith(MUTATION_ROOT)).sort();

function sourceOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8').replace(/\r\n/g, '\n');
}

function codeOf(file: string): string {
  return sourceOf(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function reachOf(file: string): readonly string[] {
  return [file, ...computeReachable(graph, file)];
}

function externalImports(file: string): string[] {
  return extractImportSpecifiers(sourceOf(file), file).filter((specifier) => !specifier.startsWith('.'));
}

/** The source of one module-level exported function, from its signature to its closing `\n}\n`. */
function functionSource(file: string, signature: string): string {
  const code = codeOf(file);
  const start = code.indexOf(signature);
  expect(start, signature).toBeGreaterThan(0);
  return code.slice(start, code.indexOf('\n}\n', start) + 2);
}

describe('[1][2][3] layout, the Prisma boundary, and no barrel', () => {
  it('the tree is exactly ports, preflight, ticket, and ONE Prisma adapter; there is no index.ts', () => {
    const onDisk = readdirSync(path.join(REPO_ROOT, MUTATION_ROOT)).sort();
    expect(onDisk).toEqual(['ports.ts', 'preflight.ts', 'repository.ts', 'ticket.ts']);
    expect(mutationFiles).toEqual(onDisk.map((name) => `${MUTATION_ROOT}${name}`));
  });

  it('ports, preflight, and ticket are Prisma-free and network-free, even transitively', () => {
    for (const file of PURE_FILES) {
      for (const node of reachOf(file)) {
        expect(externalImports(node), `${file} reaches ${node}`).not.toContain('@prisma/client');
      }
      const code = codeOf(file);
      expect(code, file).not.toMatch(/Prisma|\$queryRaw|\$executeRaw|\$transaction/);
      for (const forbidden of ['fetch(', 'axios', 'socket.io', 'WebSocket', 'process.env', 'Date.now', 'new Date(', 'X-AUTH', 'HmacSha256Signer']) {
        expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
    }
  });

  it('ONLY the adapter imports Prisma (and only @prisma/client as an external module)', () => {
    expect(mutationFiles.filter((file) => externalImports(file).includes('@prisma/client'))).toEqual([ADAPTER]);
    expect(externalImports(ADAPTER)).toEqual(['@prisma/client']);
    for (const file of PURE_FILES) expect(externalImports(file), file).toEqual([]);
  });

  it('no barrel exports any Stage 1B2 value, statically or at runtime', () => {
    for (const name of ['PrismaPracticalCancelMutationStore', 'PracticalAcquiredCancel', 'PracticalArmedCancel', 'issuePracticalAcquiredCancel', 'issuePracticalArmedCancel',
      'withLockedPracticalAccountWithinCallerTransaction', 'classifyPracticalReconciliationMismatch', 'isClassifiedPreWriteClaimFailure']) {
      expect(name in liveBarrel, name).toBe(false);
      expect(name in practicalBarrel, name).toBe(false);
    }
    for (const barrel of files.filter((file) => file.endsWith('/index.ts'))) {
      expect(codeOf(barrel).includes('practical-mutation'), barrel).toBe(false);
      expect(codeOf(barrel).includes('withLockedPracticalAccountWithinCallerTransaction'), barrel).toBe(false);
    }
  });
});

describe('[4][5][6][7] the Phase 17 primitives: claim + arm only, strict wrappers untouched, exact-account arm', () => {
  it('only the adapter (besides live/repository.ts) names the claim and arm primitives; nothing names completion outside live/repository.ts', () => {
    const naming = (name: string) => files.filter((file) => file !== LIVE_REPOSITORY && codeOf(file).includes(name));
    expect(naming('claimCancelWithinCallerFencedTransaction')).toEqual([ADAPTER]);
    expect(naming('armCancelWireWithinCallerFencedTransaction')).toEqual([ADAPTER]);
    expect(naming('completeCancelAttemptWithinCallerFencedTransaction')).toEqual([ADAPTER]);
  });

  it('the adapter imports exactly the claim/arm primitives, [Wave 2B2b] the two named no-wire releases, and the claim outcome type from live/repository.ts', () => {
    expect(sourceOf(ADAPTER)).toContain([
      'import {',
      '  armCancelWireWithinCallerFencedTransaction,',
      '  claimCancelWithinCallerFencedTransaction,',
      '  consumeCancelDispatchWithinCallerFencedTransaction,',
      '  reproveCancelOrderWithinCallerFencedTransaction,',
      '  completeCancelAttemptWithinCallerFencedTransaction,',
      '  releaseArmedUndispatchedCancelClaimWithinCallerFencedTransaction,',
      '  releaseUnarmedCancelClaimWithinCallerFencedTransaction,',
      '  type ClaimCancelOutcome,',
      "} from '../repository';",
    ].join('\n'));
    const specifiers = extractImportSpecifiers(sourceOf(ADAPTER), ADAPTER);
    expect(specifiers.filter((specifier) => specifier === '../repository')).toHaveLength(1);
    const adapter = codeOf(ADAPTER);
    for (const name of ['PrismaLiveExecutionRepository', 'claimCancel(', 'armCancelWire(', '.completeCancelAttempt(']) {
      expect(adapter.includes(name), name).toBe(false);
    }
  });

  it('the Tier-B arm is fenced with the exact account id: typed string, runtime-asserted, never null', () => {
    const adapter = codeOf(ADAPTER);
    const calls = [...adapter.matchAll(/armCancelWireWithinCallerFencedTransaction\(([^;]*)\);/g)].map((match) => match[1]);
    expect(calls).toEqual(['tx, handle.intentId, handle.orderRevisionAfterClaim, requireExactAccountId(lease.accountId, handle.accountId)']);
    const helper = functionSource(ADAPTER, 'function requireExactAccountId(value: string, expected: string): string {');
    expect(helper).toContain('if (!isExactId(value) || value !== expected) {');
    expect(helper).toContain('return value;');
    expect(helper).not.toMatch(/\bnull\b/);
  });

  it('the public strict Tier-A cancel wrappers still open their own transaction and fence FIRST (unchanged)', () => {
    const repository = codeOf(LIVE_REPOSITORY);
    for (const [method, fence] of [
      ['claimCancel', "await assertReconciliationFence(tx as unknown as ReconciliationFenceClient, reconciliationAuthorization, trustedAccountId, 'HEALTHY');"],
      ['armCancelWire', "const fence = await assertReconciliationFence(tx as unknown as ReconciliationFenceClient, reconciliationAuthorization, null, 'HEALTHY');"],
    ] as const) {
      const start = repository.indexOf(`  public async ${method}(`);
      const body = repository.slice(start, repository.indexOf('\n  public async ', start + 1));
      expect(body.indexOf('return this.#prisma.$transaction(async (tx) => {')).toBeGreaterThan(0);
      expect(body.indexOf(fence)).toBeGreaterThan(body.indexOf('return this.#prisma.$transaction(async (tx) => {'));
    }
  });
});

describe('[8][15][16] no strict authority, no continuity claim, no compensation revoke; the strict barrier is unchanged', () => {
  it('names no strict authorization, strict barrier, strict fence, continuity capability, or authority issuer', () => {
    for (const file of mutationFiles) {
      const code = codeOf(file);
      for (const forbidden of [
        'LiveReconciliationAuthorization', 'requireCurrentReconciliation', 'authorizeCurrentHealthy', 'assertReconciliationFence',
        'currentAccountContinuityCapability', 'ACCOUNT_CONTINUITY_PROVEN', 'LiveAccountContinuityCapability', 'accountContinuityProven',
        'issuePracticalLiveSafetyEnablement', 'issuePracticalRecoveryCertificate', 'mintPracticalManualReviewResolution', 'newLiveRuntimeIdentity',
        'evaluateReconciliationBarrier', 'claimGeneration',
      ]) {
        expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
      expect(code, file).not.toMatch(/provesAccountContinuity:\s*true|provesAccountContinuity\s*=\s*true/);
    }
    // The ONLY barrier symbol used is the runtime-identity reader.
    expect(sourceOf(ADAPTER)).toContain("import { readLiveRuntimeEpoch } from '../reconciliation/barrier';");
    expect(codeOf(ADAPTER).match(/from '\.\.\/reconciliation\//g)).toHaveLength(1);
  });

  it('no tier / mode / action / client-order-id input and no OPEN or CLOSE literal', () => {
    for (const file of mutationFiles) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/'OPEN'|'CLOSE'|"OPEN"|"CLOSE"|'STRICT'|tierSelector|selectGate|gateMode/);
    }
    const ports = codeOf(`${MUTATION_ROOT}ports.ts`);
    expect(ports).toContain("'accountId', 'expected', 'certificate', 'enablement', 'runtimeIdentity', 'intentId', 'trustedNowMs',");
    expect(ports).toContain("Object.freeze(['acquired', 'enablement', 'runtimeIdentity', 'trustedNowMs'] as const)");
  });

  it('never revokes, expires, invalidates, or releases through the Stage 1B1 public port (no compensation after a failure)', () => {
    for (const file of mutationFiles) {
      const code = codeOf(file);
      for (const forbidden of ['revokeCertificate(', 'expireCertificate(', '.invalidate(', 'releaseLease(', 'consumeCertificateAndLease(', 'resolveManualReview(']) {
        expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
    }
    // The Stage 1B1 public calls, each only AFTER a proven rollback: the existing malformed-state escalation and
    // [Wave 2B2b] the split-pair manual review (never a repair, never a release).
    expect(codeOf(ADAPTER).match(/this\.#practical\.(\w+)\(/g)).toEqual(['this.#practical.enterManualReview(', 'this.#practical.escalateMalformedAccount(']);
    const adapterCode = codeOf(ADAPTER);
    const afterRollback = adapterCode.slice(adapterCode.indexOf('async #afterNoWireRollback('), adapterCode.indexOf('async #enterMismatchReview('));
    expect(afterRollback.length).toBeGreaterThan(0);
    expect(afterRollback).toContain("if ((readPracticalMutationError(error) !== null) && (readPracticalMutationError(error))!.code === 'PRACTICAL_MUTATION_SPLIT_STATE') {");
    expect(afterRollback).toContain('await this.#enterMismatchReview(accountId, nowMs);');
    expect(afterRollback).toContain('throw error;');
    // [Wave 2B2c] The ONE manual-review entry is shared by the split pair and the recovery anomaly; always POST_MUTATION_MISMATCH.
    expect(codeOf(ADAPTER).match(/enterManualReview\(/g)).toHaveLength(1);
    expect(functionSource(ADAPTER, 'async #enterMismatchReview(')).toContain("return this.#practical.enterManualReview({ accountId, reason: 'POST_MUTATION_MISMATCH', nowMs });");
    // The split pair, the 2B2c anomaly, and [Wave 2B2d] the previous-runtime refusal after its rollback.
    expect(codeOf(ADAPTER).match(/this\.#enterMismatchReview\(/g)).toHaveLength(3);
    const afterRecoveryStart = adapterCode.indexOf('async #afterRecoveryRollback(');
    const afterRecovery = adapterCode.slice(afterRecoveryStart, adapterCode.indexOf('async #latchIfMalformed(', afterRecoveryStart));
    expect(afterRecovery.length).toBeGreaterThan(0);
    expect(afterRecovery).toContain('if (contradiction || isEscalatingLeaseRecoveryRefusal(error)) {\n      await this.#enterMismatchReview(accountId, nowMs);');
    expect(afterRecovery).toContain('return this.#latchIfMalformed(error, accountId, epoch, nowMs);');
    // [review fix] TYPED classification only: the durable contradiction is an `instanceof`, never the conflict code or a message.
    expect(afterRecovery).toContain("const contradiction = (readPracticalPersistenceError(error)?.kind === 'PracticalDurableContradictionError');");
    expect(afterRecovery).toContain("if (contradiction) leaseRecoveryRefused('LEASE_CERTIFICATE_MISMATCH', accountId, error);");
    expect(afterRecovery).not.toMatch(/PRACTICAL_PERSISTENCE_CONFLICT|\.message\b|\.code\b/);
    const escalate = functionSource(ADAPTER, 'async #escalateAnomaly(');
    expect(escalate).toContain('const entry = await this.#enterMismatchReview(accountId, nowMs);');
    expect(escalate).toContain('return this.#latchIfMalformed(error, accountId, epoch, nowMs).then(');
  });

  it('the strict Phase 18 barrier still refuses with ACCOUNT_CONTINUITY_NOT_PROVEN and takes exactly its four real arguments', () => {
    expect(currentAccountContinuityCapability()).toBe('REST_CURRENT_STATE_OBSERVED');
    expect(requireCurrentReconciliation).toHaveLength(4);
    expect(codeOf('src/execution/live/reconciliation/barrier.ts')).toContain("reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN'");
  });
});

describe('[9][10][17] not wired; no network, gateway, runtime, private-stream, or recovery-engine reach', () => {
  it('practical-mutation has exactly the three unwired orchestration importers outside its own tree', () => {
    const importers = files.filter((file) => !file.startsWith(MUTATION_ROOT) && (graph.get(file) ?? []).some((dependency) => dependency.startsWith(MUTATION_ROOT)));
    expect(importers.sort()).toEqual([
      'src/execution/live/practical-cancel-transport-evidence.ts',
      'src/execution/live/practical-cancel/gateway-boundary.ts',
      'src/execution/live/practical-cancel/ports.ts',
      'src/execution/live/practical-cancel/service.ts',
      'src/integration/coindcx/live/practical-account-coordinator.ts',
    ]);
  });

  it('reaches no integration module, gateway, transport, signer, service, composer, runtime, dispatch, or private stream', () => {
    for (const file of mutationFiles) {
      const reach = reachOf(file);
      expect(reach.filter((node) => node.startsWith('src/integration/')), file).toEqual([]);
      expect(reach.filter((node) => node.startsWith('src/dispatch/') || node.startsWith('src/coin-runtime/')), file).toEqual([]);
      expect(reach.filter((node) => /gateway|transport|signer|composer|runtime\.ts$|private-stream|websocket/.test(node)), file).toEqual([]);
      expect(reach.filter((node) => node.startsWith('src/execution/live/practical-recovery/') || node.startsWith('src/execution/live/practical-shadow/')), file).toEqual([]);
      for (const forbidden of ['src/execution/live/service.ts', 'src/execution/live/authority.ts', 'src/execution/live/gate.ts']) {
        expect(reach.includes(forbidden), `${file} reaches ${forbidden}`).toBe(false);
      }
    }
    // The adapter's DIRECT dependencies, exactly. Its static reach into the Phase 18 reconciliation modules exists
    // ONLY through the two pre-existing, reviewed modules it needs: live/repository.ts (the Wave 2A primitives) and
    // reconciliation/barrier.ts (readLiveRuntimeEpoch). It imports no reconciliation repository or service itself.
    expect([...(graph.get(ADAPTER) ?? [])].sort()).toEqual([
      'src/execution/live/identity.ts',
      'src/execution/live/errors.ts',
      `${MUTATION_ROOT}ports.ts`,
      `${MUTATION_ROOT}preflight.ts`,
      `${MUTATION_ROOT}ticket.ts`,
      PRACTICAL_PORT,
      PRACTICAL_REPOSITORY,
      'src/execution/live/practical/certificate.ts',
      'src/execution/live/practical/fence.ts',
      'src/execution/live/practical/policy.ts',
      'src/execution/live/practical/types.ts',
      'src/execution/live/reconciliation/barrier.ts',
      LIVE_REPOSITORY,
    ].sort());
    const inherited = new Set([LIVE_REPOSITORY, 'src/execution/live/reconciliation/barrier.ts']);
    for (const dependency of graph.get(ADAPTER) ?? []) {
      if (inherited.has(dependency)) continue;
      const reach = [dependency, ...computeReachable(graph, dependency)];
      // (The Stage 1A certificate's pre-existing reach into the pure reconciliation/account-identity.ts is unaffected.)
      for (const authority of ['barrier.ts', 'repository.ts', 'service.ts', 'ports.ts', 'gateway-orphan-cancellation.ts']) {
        expect(reach.includes(`src/execution/live/reconciliation/${authority}`), `${dependency} reaches reconciliation/${authority}`).toBe(false);
      }
      expect(reach.includes(LIVE_REPOSITORY), dependency).toBe(false);
    }
    for (const file of PURE_FILES) {
      for (const forbidden of [LIVE_REPOSITORY, PRACTICAL_REPOSITORY, 'src/execution/live/reconciliation/barrier.ts', 'src/execution/live/reconciliation/repository.ts']) {
        expect(reachOf(file).includes(forbidden), `${file} reaches ${forbidden}`).toBe(false);
      }
    }
  });

  it('the real CoinDCX private stream stays UNPROVEN: a join with no provider confirmation is not readiness, and this tree names no confirmation', () => {
    const joinSent = { state: 'AUTH_JOIN_SENT', generationId: 1, connected: true, authJoinSent: true, invalidEventCount: 0, reconciliationRequired: false };
    expect(practicalPrivateStreamReadiness(joinSent)).toEqual({ kind: 'UNPROVEN', reason: 'NO_PROVIDER_CONFIRMATION' });
    for (const file of mutationFiles) {
      expect(codeOf(file).includes('subscriptionConfirmation'), file).toBe(false);
      expect(codeOf(file).includes('PROVEN_READY'), file).toBe(false);
    }
  });

  it('entry/result have exactly the unwired boundary caller; genuine no-wire retains ZERO production callers', () => {
    const ticketFile = `${MUTATION_ROOT}ticket.ts`;
    const walkTests = (directory: string): string[] => readdirSync(path.join(REPO_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
      const file = `${directory}/${entry.name}`;
      return entry.isDirectory() ? walkTests(file) : file.endsWith('.ts') ? [file] : [];
    });
    const testFiles = [...walkTests('tests/unit'), ...walkTests('tests/integration')];
    for (const name of ['enterPracticalCancelGateway', 'issuePracticalCancelOutcome', 'issuePracticalCancelTransportNoWire']) {
      expect(files.filter((file) => file !== ticketFile && codeOf(file).includes(name))).toEqual(['src/execution/live/practical-cancel/gateway-boundary.ts']);
      expect(testFiles.filter((file) => sourceOf(file).includes(name)).sort()).toEqual([
        'tests/integration/execution/live-practical-cancel-dispatch.integration.test.ts',
        'tests/unit/coindcx/practical-account-coordinator-trusted-bindings.test.ts',
        'tests/unit/execution/live/practical-mutation/dispatch.test.ts',
      ]);
    }
  });

  it('permission/attempt issuers and lifecycle changes belong only to the unwired adapter', () => {
    for (const name of ['issuePracticalCancelDispatchPermit', 'issuePracticalCancelDispatchAttempt', 'reservePracticalCancelPermitCreation',
      'restorePracticalCancelPermitCreation', 'markPracticalCancelPermitCreationUnknown', 'issuePracticalCancelCreationCleanup', 'transitionPracticalCancelDispatchOwner']) {
      expect(files.filter((file) => file !== `${MUTATION_ROOT}ticket.ts` && codeOf(file).includes(name))).toEqual([ADAPTER]);
    }
    for (const name of ['consumeCancelDispatchWithinCallerFencedTransaction', 'reproveCancelOrderWithinCallerFencedTransaction']) {
      expect(files.filter((file) => file !== LIVE_REPOSITORY && codeOf(file).includes(name))).toEqual([ADAPTER]);
      for (const barrel of files.filter((file) => file.endsWith('/index.ts'))) expect(codeOf(barrel)).not.toContain(name);
    }
    expect(codeOf(ADAPTER)).toContain('issuePracticalArmedCancel(armedRecord, context.handle)');
    expect(codeOf(ADAPTER)).toContain('arm.orderRevisionAfterArm > 2_147_483_645');
    expect(codeOf(LIVE_REPOSITORY)).toContain('expectedRevision > 2_147_483_645');
  });
});

describe('[11] the caller-owned Stage 1B1 hook uses ONLY the supplied transaction client', () => {
  const repository = codeOf(PRACTICAL_REPOSITORY);
  const scopeStart = repository.indexOf('  static {\n    openLockedAccountScope = ');
  const scopeEnd = repository.indexOf('  // ----- internals', scopeStart) === -1
    ? repository.indexOf('  async #invalidateLocked(', scopeStart)
    : repository.indexOf('  // ----- internals', scopeStart);
  const scopeSource = repository.slice(scopeStart, scopeEnd);
  const hookTail = repository.slice(repository.indexOf('export type PracticalPreConsumptionInvalidationReason'), repository.indexOf('const createOwnedPracticalSafetyRepositoryDescriptors'));

  it('the static block, #openScope, and the module hook open no transaction and touch no root client', () => {
    expect(scopeStart).toBeGreaterThan(0);
    expect(scopeSource).toContain('async #openScope(tx: Tx, accountId: string): Promise<LockedAccountScopeHandle> {');
    for (const source of [scopeSource, hookTail]) {
      for (const forbidden of ['this.#prisma.', 'repository.#prisma.', '#transaction(', '$transaction', 'new PrismaClient', 'PrismaClient']) {
        expect(source.includes(forbidden), forbidden).toBe(false);
      }
    }
    // Every raw statement in the scope section and the hook helpers goes through the supplied `tx`.
    for (const source of [scopeSource, hookTail]) {
      for (const match of source.matchAll(/(\w+)\.\$(queryRaw|executeRaw)|(\w+)\.livePractical\w+\./g)) {
        expect(match[1] ?? match[3], match[0]).toBe('tx');
      }
    }
    // The root client is used in exactly two places in the Stage 1B1 adapter: its assignment and #transaction.
    expect(repository.match(/this\.#prisma\b/g)).toHaveLength(2);
    expect(repository).toContain('this.#prisma = prisma;');
    expect(repository).toContain('return await this.#prisma.$transaction(work, { timeout: TRANSACTION_TIMEOUT_MS });');
    // The private-brand check only TESTS for the field; it never reads the client.
    expect(scopeSource).toContain('isGenuinePracticalRepository = (value) => typeof value === \'object\' && value !== null && #prisma in value;');
  });

  it('the scope reuses the Stage 1B1 lock path and plan executor (no duplicated parsing or writes)', () => {
    expect(scopeSource).toContain('const current = await lockAccount(tx, accountId);');
    expect(scopeSource).toContain('await this.#prepareConsumption(tx, current, { expected, presented, leaseId, action: \'CANCEL\', nowMs });');
    expect(scopeSource).toContain('await this.#consumePrepared(tx, current, prepared, orderBinding);');
    expect(scopeSource).toContain('await this.#invalidateLocked(tx, current, reason, prepared.nowMs);');
    expect(scopeSource).toContain('const after = await lockAccount(tx, accountId);');
    // The only direct write the scope adds is the arm CAS.
    expect(scopeSource.match(/tx\.livePractical\w+\.(create|update|updateMany|upsert|delete|deleteMany)\(/g)).toEqual(['tx.livePracticalMutationLease.updateMany(']);
  });

  it('the hook is named in src/ ONLY by the adapter, and is not on the Stage 1B1 port', () => {
    const naming = files.filter((file) => file !== PRACTICAL_REPOSITORY && codeOf(file).includes('withLockedPracticalAccountWithinCallerTransaction'));
    expect(naming).toEqual([ADAPTER]);
    expect(codeOf(PRACTICAL_PORT).includes('withLockedPracticalAccountWithinCallerTransaction')).toBe(false);
    expect(codeOf(PRACTICAL_PORT).includes('PracticalLockedAccountScope')).toBe(false);
    const hook = functionSource(PRACTICAL_REPOSITORY, 'export async function withLockedPracticalAccountWithinCallerTransaction<T>(');
    expect(hook).toContain('tx: Prisma.TransactionClient,');
    expect(hook).toContain('if (!isGenuinePracticalRepository(repository)) invalidInput(');
    expect(hook).toContain('handle.close();');
    expect(hook.indexOf('handle.close();')).toBeGreaterThan(hook.indexOf('} finally {'));
    for (const forbidden of ['enablement', 'Enablement', 'runtimeIdentity', 'Authorization', 'authorization', 'gateway', 'Gateway']) {
      expect(hook.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('the adapter builds its ONE Stage 1B1 repository from its own root client and only ever runs the scope inside its own transactions', () => {
    const adapter = codeOf(ADAPTER);
    expect(adapter.match(/new PrismaPracticalSafetyRepository\(/g)).toHaveLength(1);
    expect(adapter).toContain('this.#practical = new PrismaPracticalSafetyRepository(this.#prisma, newId);');
    expect(adapter.match(/this\.#prisma\.\$transaction\(/g)).toHaveLength(1);
    // Acquire, arm, [Wave 2B2b] the one shared no-wire body, [Wave 2B2c] the read-only resolution, and [Wave 2B2d] the
    // previous-runtime recovery.
    expect(adapter.match(/withLockedPracticalAccountWithinCallerTransaction\(this\.#practical, tx, /g)).toHaveLength(7);
    // Exactly these operation bodies run inside #transaction: acquire, arm, the no-wire body (completion + abandon),
    // [Wave 2B2c] the resolution, and [Wave 2B2d] the recovery.
    expect(adapter.match(/this\.#transaction\(\(tx\) => this\.#(acquireWithin|armWithin|noWireWithin)\(tx, context\)\)/g)).toHaveLength(5);
    expect(adapter.match(/this\.#transaction\(\(tx\) => this\.#resolveWithin\(tx, record\)\)/g)).toHaveLength(1);
    expect(adapter.match(/this\.#transaction\(\(tx\) => this\.#recoverWithin\(tx, accountId, epoch, nowMs\)\)/g)).toHaveLength(1);
    expect(adapter.match(/this\.#transaction\(/g)).toHaveLength(10);
  });
});

describe('[12][13][14] the classified Phase 17 pre-write claim failures', () => {
  it('the classified set is EXACTLY the three pre-UPDATE refusal codes; integrity and persistence faults are NOT classified', () => {
    expect([...PRACTICAL_CLASSIFIED_PRE_WRITE_CLAIM_FAILURE_CODES]).toEqual(['LIVE_INTENT_INVALID', 'LIVE_AUTHORITY_INVALID', 'LIVE_ORDER_IDENTITY_MISMATCH']);
    expect(PRACTICAL_CLASSIFIED_PRE_WRITE_CLAIM_FAILURE_CODES).not.toContain('LIVE_DURABLE_INTEGRITY_VIOLATION');
    expect(PRACTICAL_CLASSIFIED_PRE_WRITE_CLAIM_FAILURE_CODES).not.toContain('LIVE_PERSISTENCE_FAULT');
    const preflight = codeOf(`${MUTATION_ROOT}preflight.ts`);
    expect(preflight.includes("'LIVE_DURABLE_INTEGRITY_VIOLATION'")).toBe(false);
    expect(preflight.includes("'LIVE_PERSISTENCE_FAULT'")).toBe(false);
  });

  it('SOURCE-ORDER PIN: in the committed claim primitive the three classified throws occur only BEFORE its one and only UPDATE', () => {
    const claim = functionSource(LIVE_REPOSITORY, 'export async function claimCancelWithinCallerFencedTransaction(');
    const update = claim.indexOf('const updated = await tx.liveOrder.update({ where: { intentId }, data: {');
    expect(update).toBeGreaterThan(0);
    // The ONLY write, and the ONLY raw statement is the leading lock.
    expect(claim.match(/tx\.liveOrder\.\w+\(/g)).toEqual(['tx.liveOrder.update(']);
    expect(claim.match(/\$executeRaw|\$queryRaw/g)).toEqual(['$executeRaw']);
    expect(claim).toContain('await tx.$executeRaw`SELECT intent_id FROM live_order WHERE intent_id = ${intentId} FOR UPDATE`;');
    for (const code of PRACTICAL_CLASSIFIED_PRE_WRITE_CLAIM_FAILURE_CODES) {
      const sites = [...claim.matchAll(new RegExp(`throw new LiveExecutionError\\('${code}'`, 'g'))].map((match) => match.index!);
      expect(sites, code).toHaveLength(1);
      expect(sites[0], code).toBeLessThan(update);
    }
    // The only pre-UPDATE source of a durable integrity violation is the single verified read.
    expect(claim.match(/readVerifiedOrder\(/g)).toHaveLength(1);
    expect(claim.indexOf('readVerifiedOrder(')).toBeLessThan(update);
    expect(claim.indexOf("return { kind: 'NOT_CANCELLABLE' as const")).toBeLessThan(update);
    expect(claim.indexOf("return { kind: 'ALREADY_CLAIMED' as const")).toBeLessThan(update);
    // After the UPDATE: exactly these statements (the known post-write throw sites of the NON-classified faults).
    const afterUpdate = claim.slice(claim.indexOf('} });', update) + '} });'.length).trim();
    expect(afterUpdate).toBe([
      'const claimedOrder = toStateRecord(updated as unknown as LiveOrderRow);',
      '  assertOrderProjectionMatchesIntent(claimedOrder, verified.verifiedIntent);',
      "  return { kind: 'CLAIMED' as const, order: claimedOrder, generation };",
      '}',
    ].join('\n'));
  });

  it('the adapter has ONE try/catch around a Phase 17 call: exactly the claim, classifier first, then the no-write proof, then the invalidation', () => {
    const adapter = codeOf(ADAPTER);
    // Exactly nine: #transaction's attempt, acquire's / arm's / [2B2b] undispatched completion's / abandon's /
    // [2B2c] resolution's outcome handling, the claim, the malformed escalation, and [2B2c] the anomaly escalation
    // (which never throws). No try surrounds a no-wire release primitive.
    // [Wave 2B2d] + the recovery's outcome handling: ten.
    expect(adapter.match(/\btry \{/g)).toHaveLength(14);
    expect(adapter).not.toMatch(/try \{\s+(const \w+ = )?await release(Unarmed|ArmedUndispatched)CancelClaimWithinCallerFencedTransaction/);
    // The ONLY try around a Phase 17 primitive is the claim (the arm is never caught: any failure rolls back).
    expect(adapter).not.toMatch(/try \{\s+(const \w+ = )?await armCancelWireWithinCallerFencedTransaction/);
    const claimTry = adapter.indexOf('try {\n        claim = await claimCancelWithinCallerFencedTransaction(tx, intentId, accountId);\n      } catch (error) {');
    expect(claimTry).toBeGreaterThan(0);
    const catchBody = adapter.slice(claimTry, adapter.indexOf('\n      }\n', adapter.indexOf('} catch (error) {', claimTry)));
    const order = [
      'if (!isClassifiedPreWriteClaimFailure(error)) throw error;',
      'await requirePhase17Untouched(tx, intentId, before, error);',
      "return invalidated('PREFLIGHT_MISMATCH', 'PHASE17_CLAIM_REFUSED', readLiveExecutionError(error)!.code as PracticalClassifiedPreWriteClaimFailureCode);",
    ].map((statement) => catchBody.indexOf(statement));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // NOT_CANCELLABLE / ALREADY_CLAIMED also require the no-write proof before invalidating.
    expect(adapter).toContain("if (claim.kind !== 'CLAIMED') {\n        await requirePhase17Untouched(tx, intentId, before, null);");
    // The no-write proof compares every claim column exactly.
    const proof = functionSource(ADAPTER, 'async function requirePhase17Untouched(');
    for (const column of ['revision', 'state', 'cancelState', 'cancelGeneration', 'cancelWireArmed', 'cancelExchangeOrderId', 'cancelFaultCode']) {
      expect(proof, column).toContain(`after.${column} === before.${column}`);
    }
    expect(proof).toContain('if (original !== null) throw original;');
  });

  it('the deterministic reconciliation mapping lives only in preflight.ts, in order R0 -> A -> B -> C, and D is decided before the reconciliation read', () => {
    const preflight = functionSource(`${MUTATION_ROOT}preflight.ts`, 'export function classifyPracticalReconciliationMismatch(');
    const returns = [...preflight.matchAll(/return '(\w+)';/g)].map((match) => match[1]);
    expect(returns).toEqual(['PREFLIGHT_MISMATCH', 'RUNTIME_EPOCH_CHANGED', 'GENERATION_CHANGED', 'PREFLIGHT_MISMATCH']);
    const adapter = codeOf(ADAPTER);
    expect(adapter.match(/classifyPracticalReconciliationMismatch\(/g)).toHaveLength(3);
    expect(adapter.includes("'RUNTIME_EPOCH_CHANGED'"), 'the adapter never maps a reconciliation reason inline').toBe(false);
    expect(adapter.includes("'GENERATION_CHANGED'")).toBe(false);
    expect(adapter.indexOf("return invalidated('CONFIG_CHANGED', 'EFFECTIVE_LIFETIME_EXCEEDED', null);"))
      .toBeLessThan(adapter.indexOf('const reconciliation = await lockReconciliationState(tx, accountId);'));
  });

  it('retry scope matches Stage 1B1 exactly: P2034, or P2010 carrying MySQL 1213; nothing else', () => {
    const retry = functionSource(ADAPTER, 'function isRetryableDeadlock(error: unknown): boolean {');
    expect(retry).toContain("if (error.code === 'P2034') return true;");
    expect(retry).toContain("if (error.code !== 'P2010') return false;");
    expect(retry).toContain("(meta as Record<string, unknown>)['code'] === MYSQL_DEADLOCK");
    expect(codeOf(ADAPTER)).toContain("const MYSQL_DEADLOCK = '1213';");
    expect(codeOf(ADAPTER)).toContain('export const PRACTICAL_MUTATION_TRANSACTION_MAX_ATTEMPTS = 3;');
    expect(codeOf(ADAPTER).includes('1205')).toBe(false);
  });
});

describe('the acquired / armed values are minted ONLY by the adapter, ONLY after COMMIT', () => {
  it('the ticket issuing and lifecycle functions have exactly one production importer: the adapter; [Wave 2B2b] there is no take at all', () => {
    for (const name of [
      'issuePracticalAcquiredCancel', 'issuePracticalArmedCancel', 'reservePracticalAcquiredCancel', 'releasePracticalAcquiredCancel', 'spendPracticalAcquiredCancel',
      'markPracticalAcquiredCancelArmOutcomeUnknown', 'beginPracticalAcquiredCancelAbandon', 'finishPracticalAcquiredCancelAbandon', 'restorePracticalAcquiredCancelAbandon',
      'markPracticalAcquiredCancelAbandonOutcomeUnknown', 'beginPracticalArmedCancelNoWireCompletion', 'finishPracticalArmedCancelNoWireCompletion',
      'restorePracticalArmedCancel', 'markPracticalArmedCancelCommitUnknown',
      // [Wave 2B2c] the unknown-acquire receipt
      'issuePracticalUnknownAcquire', 'beginPracticalUnknownAcquireResolution', 'finishPracticalUnknownAcquireResolution',
      'restorePracticalUnknownAcquire', 'refusePracticalUnknownAcquire',
    ]) {
      expect(files.filter((file) => file !== `${MUTATION_ROOT}ticket.ts` && codeOf(file).includes(name)), name).toEqual([ADAPTER]);
    }
    // No take / dispatch surface exists anywhere: an ARMED ticket is, by construction, never dispatched.
    const ticket = codeOf(`${MUTATION_ROOT}ticket.ts`);
    expect(ticket).not.toMatch(/export function take|static take\(|isTaken|#taken/);
    expect(ticket).not.toMatch(/'DISPATCHED'|'PERMITTED'|'PERMIT_PENDING'/);
    expect(files.filter((file) => /takePracticalArmedCancel/.test(codeOf(file)))).toEqual([]);
    expect(ticket).not.toMatch(/export const TICKET_ISSUER|export \{ TICKET_ISSUER/);
  });

  it('minting and spending happen after the awaited #transaction, never inside a transaction callback', () => {
    const adapter = codeOf(ADAPTER);
    const acquire = adapter.slice(adapter.indexOf('public async acquireCancelLease('), adapter.indexOf('async #acquireWithin('));
    expect(acquire.indexOf('issuePracticalAcquiredCancel(')).toBeGreaterThan(acquire.indexOf('outcome = await this.#transaction('));
    const arm = adapter.slice(adapter.indexOf('public async armCancelLease('), adapter.indexOf('async #armWithin('));
    const transaction = arm.indexOf('armedRecord = await this.#transaction(');
    expect(arm.indexOf('reservePracticalAcquiredCancel(acquired);')).toBeLessThan(transaction);
    expect(arm.lastIndexOf('spendPracticalAcquiredCancel(acquired);')).toBeGreaterThan(transaction);
    expect(arm.lastIndexOf('issuePracticalArmedCancel(')).toBeGreaterThan(arm.lastIndexOf('spendPracticalAcquiredCancel(acquired);'));
    const noWireBody = adapter.slice(adapter.indexOf('async #noWireWithin('), adapter.indexOf('async #afterNoWireRollback('));
    for (const body of [
      adapter.slice(adapter.indexOf('async #acquireWithin('), adapter.indexOf('public async armCancelLease(')),
      adapter.slice(adapter.indexOf('async #armWithin('), adapter.indexOf('public async completeUndispatchedCancel(')),
      noWireBody,
    ]) {
      for (const forbidden of ['issuePracticalAcquiredCancel(', 'issuePracticalArmedCancel(', 'spendPracticalAcquiredCancel(', 'reservePracticalAcquiredCancel(', 'releasePracticalAcquiredCancel(']) {
        expect(body.includes(forbidden), forbidden).toBe(false);
      }
      expect(body).not.toMatch(/Practical(Acquired|Armed)Cancel(Abandon|NoWireCompletion|CommitUnknown|ArmOutcomeUnknown|AbandonOutcomeUnknown)\(/);
    }
    // [Wave 2B2b] The ticket / handle transitions of the no-wire operations run OUTSIDE the transaction body.
    for (const [method, begin, finish] of [
      ['completeUndispatchedCancel', 'beginPracticalArmedCancelNoWireCompletion(armed, reason);', 'finishPracticalArmedCancelNoWireCompletion(armed);'],
      ['abandonAcquiredCancel', 'beginPracticalAcquiredCancelAbandon(acquired);', 'finishPracticalAcquiredCancelAbandon(acquired);'],
    ] as const) {
      const body = adapter.slice(adapter.indexOf(`public async ${method}(`));
      const transaction = body.indexOf('outcome = await this.#transaction((tx) => this.#noWireWithin(tx, context));');
      expect(body.indexOf(begin), method).toBeGreaterThan(0);
      expect(body.indexOf(begin), method).toBeLessThan(transaction);
      expect(body.indexOf(finish), method).toBeGreaterThan(transaction);
    }
  });
});

describe('[Wave 2B2c] unknown-acquire resolution: read-only, exact, single-use, no closure result, non-leaking delivery', () => {
  const adapter = codeOf(ADAPTER);
  const between = (from: string, to: string): string => {
    const start = adapter.indexOf(from);
    expect(start, from).toBeGreaterThan(0);
    const end = adapter.indexOf(to, start);
    expect(end, to).toBeGreaterThan(start);
    return adapter.slice(start, end);
  };
  const resolve = between('public async resolveUnknownAcquire(', 'async #resolveWithin(');
  const resolveWithin = between('async #resolveWithin(', 'async #escalateAnomaly(');

  it('the resolution transaction is read-only: no write, no Phase 17 write primitive, no reconciliation lock, no enablement', () => {
    expect(resolveWithin).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw/);
    expect(resolveWithin).not.toMatch(/claimCancelWithinCallerFencedTransaction|armCancelWireWithinCallerFencedTransaction|release(Unarmed|ArmedUndispatched)CancelClaimWithinCallerFencedTransaction/);
    expect(resolveWithin).not.toMatch(/completeOrderBoundCancelLeaseNoWire|armOrderBoundCancelLease|consumeIntoOrderBoundCancelLease|invalidateBeforeConsumption|prepareCancelConsumption/);
    expect(resolveWithin).not.toMatch(/live_reconciliation_state|lockReconciliationState|classifyPracticalReconciliationMismatch|requireCancelEnablement|enterManualReview|escalateMalformedAccount/);
    // Exactly the inspection and the Phase 17 lock, in that order (practical rows before live_order -> intent).
    expect(resolveWithin.match(/scope\.\w+\(/g)).toEqual(['scope.inspectAttemptedOrderBoundCancelLease(']);
    expect(resolveWithin.match(/lockPhase17Order\(/g)).toHaveLength(1);
    expect(resolveWithin.indexOf('scope.inspectAttemptedOrderBoundCancelLease(')).toBeLessThan(resolveWithin.indexOf('lockPhase17Order('));
    expect(resolve).not.toMatch(/requireCancelEnablement|enablement/);
  });

  it('RESTORED is reachable only after EVERY exact check; there is no already-closed result anywhere', () => {
    const restored = resolveWithin.indexOf("return Object.freeze({ kind: 'RESTORED' as const });");
    expect(restored).toBeGreaterThan(0);
    expect(resolveWithin.match(/kind: 'RESTORED'/g)).toHaveLength(1);
    for (const check of [
      "if (lease.leaseId !== attempted) recoveryAnomaly('LEASE_IDENTITY', attempted);",
      "if (lease.status !== 'LEASED' || lease.completedAtMs !== null || lease.outcome !== null) recoveryAnomaly('LEASE_NOT_LEASED', attempted);",
      "if (lease.armedAtMs !== null) recoveryAnomaly('LEASE_ARMED', attempted);",
      "if (!sameAttemptedLease(lease, record)) recoveryAnomaly('LEASE_IDENTITY', attempted);",
      "if (!RESTORABLE_ACCOUNT_STATES.includes(scope.account.state) || !fenceNamesAttempt(fence, record)) recoveryAnomaly('FENCE_MISMATCH', attempted);",
      '|| !sameCertificateSnapshot(certificate, record.certificate)',
      "if (order === null) recoveryAnomaly('PHASE17_MISSING', attempted);",
      '|| order.pair !== record.pair',
      '|| order.exchangeOrderId !== record.exchangeOrderId',
      '|| order.cancelExchangeOrderId !== record.exchangeOrderId',
      "if (order.cancelGeneration !== record.cancelGeneration || order.cancelState !== 'CANCEL_RESERVED' || order.cancelWireArmed) {",
    ]) {
      const at = resolveWithin.indexOf(check);
      expect(at, check).toBeGreaterThan(0);
      expect(at, check).toBeLessThan(restored);
    }
    for (const file of files.filter((candidate) => candidate.startsWith('src/'))) {
      expect(codeOf(file), file).not.toMatch(/ALREADY_CLOSED/);
    }
    expect(codeOf(`${MUTATION_ROOT}ports.ts`)).toContain("| { readonly kind: 'RESTORED'; readonly acquired: PracticalAcquiredCancel }");
    expect(codeOf(`${MUTATION_ROOT}ports.ts`)).toContain("| { readonly kind: 'NOT_COMMITTED'; readonly certificateStatus: PracticalUnknownAcquireCertificateStatus };");
  });

  it('the handle is minted only after COMMIT, from the INTENDED record unchanged, after the receipt is spent', () => {
    expect(adapter.match(/issuePracticalAcquiredCancel\(/g)).toHaveLength(2);
    const transaction = resolve.indexOf('outcome = await this.#transaction((tx) => this.#resolveWithin(tx, record));');
    const spend = resolve.indexOf('finishPracticalUnknownAcquireResolution(unknown);');
    const mint = resolve.indexOf('issuePracticalAcquiredCancel(record)');
    expect(transaction).toBeGreaterThan(0);
    expect(spend).toBeGreaterThan(transaction);
    expect(mint).toBeGreaterThan(spend);
    expect(resolveWithin).not.toMatch(/issuePracticalAcquiredCancel|Practical\w*UnknownAcquire\w*\(/);
    // The receipt is minted only in acquire's unknown-commit branch, only for a completed ACQUIRED outcome.
    const acquire = between('public async acquireCancelLease(', 'async #acquireWithin(');
    expect(adapter.match(/issuePracticalUnknownAcquire\(/g)).toHaveLength(1);
    expect(acquire).toContain("if (completed !== undefined && completed.kind === 'ACQUIRED') issuePracticalUnknownAcquire(completed.record, unknownCommit);");
    expect(acquire.indexOf('issuePracticalUnknownAcquire(')).toBeGreaterThan(acquire.indexOf('if (error instanceof TransactionOutcomeUnknown) {'));
    expect(acquire.indexOf('throw unknownCommit;')).toBeGreaterThan(acquire.indexOf('issuePracticalUnknownAcquire('));
  });

  it('a proven anomaly makes the receipt permanently mint-disabled BEFORE the refusal; only inconclusive failures return it to PENDING', () => {
    // restore: the epoch refusal, the unknown read-only COMMIT, and a database FAULT.
    expect(resolve.match(/restorePracticalUnknownAcquire\(unknown\);/g)).toHaveLength(3);
    // refuse: the epoch refusal of an escalating receipt, the retried escalation, and a proven anomaly.
    // refuse: + [Wave 2B2d] RUNTIME_SUPERSEDED (REFUSED with no escalation).
    expect(resolve.match(/refusePracticalUnknownAcquire\(unknown, /g)).toHaveLength(4);
    expect(resolve.match(/throw recoveryRefused\(/g)).toHaveLength(3);
    const superseded = resolve.indexOf('if (isRuntimeSuperseded(error)) {');
    expect(superseded).toBeGreaterThan(resolve.indexOf('if (isInconclusiveResolution(error)) {'));
    expect(resolve.indexOf("refusePracticalUnknownAcquire(unknown, 'RESOLVING', true);", superseded)).toBeGreaterThan(superseded);
    expect(resolve.indexOf("throw recoveryRefused('RUNTIME_SUPERSEDED', record, NOT_ESCALATED, error);", superseded))
      .toBeGreaterThan(resolve.indexOf("refusePracticalUnknownAcquire(unknown, 'RESOLVING', true);", superseded));
    // ...and it is decided BEFORE the anomaly escalation (no spurious manual review).
    expect(superseded).toBeLessThan(resolve.indexOf('const escalation = await this.#escalateAnomaly(record.accountId, epoch, nowMs);\n      refusePracticalUnknownAcquire(unknown, \'RESOLVING\''));
    // The superseded check comes AFTER the strict account read (parser-first) and BEFORE the inspection.
    expect(resolveWithin.indexOf('if (scope.account.fence.runtimeEpoch !== record.runtimeEpoch) runtimeSuperseded(attempted);')).toBeGreaterThan(0);
    expect(resolveWithin.indexOf('if (scope.account.fence.runtimeEpoch !== record.runtimeEpoch) runtimeSuperseded(attempted);'))
      .toBeLessThan(resolveWithin.indexOf('scope.inspectAttemptedOrderBoundCancelLease('));
    for (const sequence of [
      "refusePracticalUnknownAcquire(unknown, 'ESCALATING', escalation.confirmed);\n      throw recoveryRefused('ANOMALY_PREVIOUSLY_PROVEN'",
      "refusePracticalUnknownAcquire(unknown, 'RESOLVING', escalation.confirmed);\n      throw recoveryRefused(refusalReasonOf(error)",
    ]) {
      expect(resolve, sequence).toContain(sequence);
    }
    expect(functionSource(ADAPTER, 'function isInconclusiveResolution(')).toContain("return (readPracticalMutationError(error) !== null) && (readPracticalMutationError(error))!.code === 'PRACTICAL_MUTATION_FAULT';");
    const ticket = codeOf(`${MUTATION_ROOT}ticket.ts`);
    expect(ticket).toContain("RESOLVING: Object.freeze<PracticalUnknownAcquireStatus[]>(['SPENT', 'PENDING', 'REFUSED', 'ANOMALY_UNESCALATED']),");
    expect(ticket).toContain("ANOMALY_UNESCALATED: Object.freeze<PracticalUnknownAcquireStatus[]>(['ESCALATING']),");
    expect(ticket).toContain("ESCALATING: Object.freeze<PracticalUnknownAcquireStatus[]>(['REFUSED', 'ANOMALY_UNESCALATED']),");
    expect(ticket).toContain('SPENT: Object.freeze<PracticalUnknownAcquireStatus[]>([]),');
    expect(ticket).toContain('REFUSED: Object.freeze<PracticalUnknownAcquireStatus[]>([]),');
    expect(ticket).toContain("if (receipt.#anomalyProven && (to === 'SPENT' || to === 'PENDING' || to === 'RESOLVING')) {");
  });

  it('D1: the receipt travels OFF the error: never a property, never in details; only ticket.ts holds the WeakMap', () => {
    const ports = codeOf(`${MUTATION_ROOT}ports.ts`);
    const classStart = ports.indexOf('export class PracticalAcquireCommitUnknownError');
    const errorClass = ports.slice(classStart, ports.indexOf('\n}\n', classStart));
    expect(errorClass).toContain("super('PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN', 'The acquisition COMMIT could not be confirmed; nothing was minted', { accountId }, cause);");
    expect(errorClass).not.toMatch(/receipt|Receipt|public readonly/);
    expect(errorClass.match(/this\.\w+ = /g)).toEqual(['this.name = ']);
    const ticket = codeOf(`${MUTATION_ROOT}ticket.ts`);
    expect(ticket).toContain('const UNKNOWN_ACQUIRE_RECEIPTS = new WeakMap<object, PracticalUnknownAcquire>();');
    expect(ticket).not.toMatch(/export const UNKNOWN_ACQUIRE_RECEIPTS|export \{ UNKNOWN_ACQUIRE_RECEIPTS/);
    expect(files.filter((file) => codeOf(file).includes('UNKNOWN_ACQUIRE_RECEIPTS'))).toEqual([`${MUTATION_ROOT}ticket.ts`]);
    expect(files.filter((file) => file !== `${MUTATION_ROOT}ticket.ts` && codeOf(file).includes('readPracticalUnknownAcquireReceipt'))).toEqual(['src/execution/live/practical-cancel/service.ts']);
    // The receipt exposes only a static status: no instance getter, no static read of its record.
    const receiptClass = ticket.slice(ticket.indexOf('export class PracticalUnknownAcquire {'), ticket.indexOf('Object.freeze(PracticalUnknownAcquire.prototype);'));
    expect(receiptClass).not.toMatch(/\bget \w+\(|public static read\(|toJSON|inspect/);
  });
});

describe('[Wave 2B2d] previous-runtime UNARMED leased-fence recovery: genuine epoch, exact order of checks, one commit, no authority', () => {
  const adapter = codeOf(ADAPTER);
  const between = (from: string, to: string): string => {
    const start = adapter.indexOf(from);
    expect(start, from).toBeGreaterThan(0);
    const end = adapter.indexOf(to, start);
    expect(end, to).toBeGreaterThan(start);
    return adapter.slice(start, end);
  };
  const recover = between('public async recoverPreviousRuntimeCancelLease(', 'async #recoverWithin(');
  const recoverWithin = between('async #recoverWithin(', 'async #afterRecoveryRollback(');

  it('the adopting epoch comes ONLY from a genuine runtime identity; the input is closed-world and carries no epoch', () => {
    expect(codeOf(`${MUTATION_ROOT}ports.ts`)).toContain("export const PRACTICAL_PREVIOUS_RUNTIME_RECOVERY_INPUT_KEYS = Object.freeze(['accountId', 'runtimeIdentity', 'trustedNowMs'] as const);");
    expect(recover).toContain('const raw = requireClosedWorld(input, PRACTICAL_PREVIOUS_RUNTIME_RECOVERY_INPUT_KEYS);');
    expect(recover).toContain("const epoch = requireRuntimeEpoch(raw['runtimeIdentity']);");
    expect(functionSource(ADAPTER, 'function requireRuntimeEpoch(')).toContain('const epoch = readLiveRuntimeEpoch(value);');
    expect(recover.indexOf("const epoch = requireRuntimeEpoch(raw['runtimeIdentity']);")).toBeLessThan(recover.indexOf('outcome = await this.#transaction('));
    expect(recover).not.toMatch(/enablement|Enablement/);
  });

  it('in order: previous epoch -> bound -> exact lease/certificate -> exact-case Phase 17 -> claim -> coupled UNARMED pair -> release -> complete + adopt -> re-proof', () => {
    const order = [
      "if (fence.mode.kind !== 'MUTATION_LEASED') {",
      "if (fence.runtimeEpoch === epoch) leaseRecoveryRefused('CURRENT_RUNTIME_LEASE', accountId);",
      "leaseRecoveryRefused('UNBOUND_LEASE', accountId);",
      'const { lease } = await scope.requireLeasedOrderBoundCancelLease({',
      'const order = await lockPhase17Order(tx, binding.intentId);',
      "if (order === null) leaseRecoveryRefused('PHASE17_MISSING', accountId);",
      '|| order.clientOrderId !== binding.clientOrderId',
      "leaseRecoveryRefused('PHASE17_IDENTITY', accountId);",
      "if (order.cancelGeneration !== binding.cancelGeneration || order.cancelState !== 'CANCEL_RESERVED') leaseRecoveryRefused('PHASE17_CLAIM', accountId);",
      "if (leaseArmed !== order.cancelWireArmed) leaseRecoveryRefused('SPLIT_PAIR', accountId);",
      "if (leaseArmed) leaseRecoveryRefused('ARMED_ORPHAN_REQUIRES_EVIDENCE', accountId);",
      'const released = await releaseUnarmedCancelClaimWithinCallerFencedTransaction(',
      'const completed = await scope.completeOrderBoundCancelLeaseNoWireAndAdopt(nowMs, epoch);',
      'const after = await lockPhase17Order(tx, binding.intentId);',
      "kind: 'RECOVERED' as const",
    ].map((statement) => {
      const at = recoverWithin.indexOf(statement);
      expect(at, statement).toBeGreaterThan(0);
      return at;
    });
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Only these two scope calls; no reconciliation, arm, claim, or armed release; only PRE_DISPATCH_FAILURE.
    expect(recoverWithin.match(/scope\.\w+\(/g)).toEqual(['scope.requireLeasedOrderBoundCancelLease(', 'scope.completeOrderBoundCancelLeaseNoWireAndAdopt(']);
    expect(recoverWithin).not.toMatch(/'AMBIGUOUS'|'REJECTED'|'ACCEPTED'|lockReconciliationState|live_reconciliation_state|releaseArmedUndispatched/);
    expect(recoverWithin.match(/kind: 'RECOVERED'/g)).toHaveLength(1);
  });

  it('RECOVERED is only returned by the committed transaction; an unknown COMMIT is rethrown; NO_LEASED_FENCE claims no closure', () => {
    expect(recover).toContain("if (error instanceof TransactionOutcomeUnknown) {\n        throw new PracticalMutationError('PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN'");
    expect(recover).toContain('return this.#afterRecoveryRollback(error, accountId, epoch, nowMs);');
    expect(recover.lastIndexOf('return outcome;')).toBeGreaterThan(recover.indexOf('outcome = await this.#transaction('));
    expect(recoverWithin).toContain("return Object.freeze({ kind: 'NO_LEASED_FENCE' as const, fenceHeldByThisRuntime: fence.runtimeEpoch === epoch });");
    expect(codeOf(`${MUTATION_ROOT}ports.ts`)).not.toMatch(/ALREADY_RECOVERED|ALREADY_CLOSED/);
  });

  it('the escalating set is exactly the well-formed contradictions; CURRENT_RUNTIME_LEASE and UNBOUND_LEASE never write', () => {
    const ports = codeOf(`${MUTATION_ROOT}ports.ts`);
    expect(ports).toContain("'ARMED_ORPHAN_REQUIRES_EVIDENCE', 'SPLIT_PAIR', 'LEASE_CERTIFICATE_MISMATCH', 'PHASE17_MISSING', 'PHASE17_IDENTITY', 'PHASE17_CLAIM',\n] as const);");
    const escalating = ports.slice(ports.indexOf('PRACTICAL_PREVIOUS_RUNTIME_ESCALATING_REASONS'), ports.indexOf('export type PracticalPreviousRuntimeRecovery ='));
    expect(escalating).not.toMatch(/CURRENT_RUNTIME_LEASE|UNBOUND_LEASE/);
  });
});
