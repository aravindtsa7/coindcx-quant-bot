import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as liveBarrel from '../../src/execution/live';
import { currentAccountContinuityCapability, requireCurrentReconciliation } from '../../src/execution/live/reconciliation/barrier';
import { buildImportGraph, computeReachable } from './support/import-graph';

// Phase 18B Stage 1B2, Wave 2A: the Phase17 CANCEL transitions were extracted
// into three transaction-scoped primitives. They are UNSAFE low-level
// persistence steps, not authority:
//
//   - defined and exported ONLY by src/execution/live/repository.ts, never on
//     the LiveExecutionRepository port and never from any barrel;
//   - imported by NO src/ module in Wave 2A; [Wave 2B1] exactly ONE reviewed
//     importer was then added: the Stage 1B2 Prisma adapter
//     (practical-mutation/repository.ts), for claim and arm only, never
//     completion, and it fences the arm with the exact account (never null);
//   - their bodies run no fence, open no transaction, and accept no authority
//     object, certificate, enablement, tier selector, gateway, or network client;
//   - the PUBLIC strict Tier-A methods still open the transaction and run
//     assertReconciliationFence(... 'HEALTHY') FIRST, then call exactly one primitive;
//   - no practical module reaches live/repository.ts, no integration module was
//     added as its importer, and it reaches no gateway, transport, or signer;
//   - the strict Phase 18 continuity barrier is unchanged.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const REPOSITORY = 'src/execution/live/repository.ts';
const MUTATION_ADAPTER = 'src/execution/live/practical-mutation/repository.ts';
const PRIMITIVES = [
  'claimCancelWithinCallerFencedTransaction',
  'armCancelWireWithinCallerFencedTransaction',
  'completeCancelAttemptWithinCallerFencedTransaction',
] as const;

const { graph, files } = buildImportGraph(SRC_ROOT, REPO_ROOT);

function sourceOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8').replace(/\r\n/g, '\n');
}

function codeOf(file: string): string {
  return sourceOf(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** The full text of one exported primitive: from `export async function NAME(` to its closing `\n}`. */
function primitiveSource(name: string): { readonly signature: string; readonly body: string } {
  const code = codeOf(REPOSITORY);
  const start = code.indexOf(`export async function ${name}(`);
  expect(start, name).toBeGreaterThan(0);
  const end = code.indexOf('\n}\n', start);
  const whole = code.slice(start, end + 2);
  const bodyStart = whole.indexOf('> {\n');
  return { signature: whole.slice(0, bodyStart), body: whole.slice(bodyStart) };
}

/** The text of one public class method, up to the next class member. */
function methodSource(name: string): string {
  const code = codeOf(REPOSITORY);
  const start = code.indexOf(`  public async ${name}(`);
  expect(start, name).toBeGreaterThan(0);
  const next = code.indexOf('\n  public async ', start + 1);
  return code.slice(start, next === -1 ? undefined : next);
}

describe('the primitives are defined once, by the Phase17 Prisma adapter module only', () => {
  it.each(PRIMITIVES)('%s is a named export of live/repository.ts taking an exact Prisma.TransactionClient first', (name) => {
    const { signature } = primitiveSource(name);
    expect(signature).toMatch(new RegExp(`^export async function ${name}\\(\\n  tx: Prisma\\.TransactionClient,`));
    for (const file of files.filter((candidate) => candidate !== REPOSITORY)) {
      expect(codeOf(file).includes(`function ${name}`), `${file} defines ${name}`).toBe(false);
    }
  });

  it('accept no authority, certificate, enablement, tier selector, gateway, or network client', () => {
    for (const name of PRIMITIVES) {
      // The one permitted client type is the caller's exact transaction; nothing else may be passed in.
      const { signature } = primitiveSource(name);
      expect(signature.match(/Prisma\.TransactionClient/g), name).toHaveLength(1);
      expect(signature.replace('Prisma.TransactionClient', ''), name)
        .not.toMatch(/authoriz|Authoriz|certificate|Certificate|enablement|Enablement|tier|Tier|strict|Strict|practical|Practical|gateway|Gateway|client|Client|fetch|http|unknown/);
    }
    expect(primitiveSource('claimCancelWithinCallerFencedTransaction').signature).toContain('trustedAccountId: string,');
    expect(primitiveSource('armCancelWireWithinCallerFencedTransaction').signature).toContain('fencedAccountId: string | null,');
    expect(primitiveSource('completeCancelAttemptWithinCallerFencedTransaction').signature).toContain('fencedAccountId: string | null,');
  });

  it('run no fence, open no transaction, mint or read no authority, and perform no network, signing, or environment access', () => {
    for (const name of PRIMITIVES) {
      const { body } = primitiveSource(name);
      for (const forbidden of [
        'assertReconciliationFence', '$transaction', 'LiveReconciliationAuthorization', 'authorizeCurrentHealthy', 'requireCurrentReconciliation',
        'reconciliationAuthorization', 'process.env', 'fetch(', 'axios', 'X-AUTH', 'Signer', 'Gateway', 'cancelOrder', 'placeOrder',
      ]) {
        expect(body.includes(forbidden), `${name} names ${forbidden}`).toBe(false);
      }
    }
  });
});

describe('the primitives are NOT a public authority surface', () => {
  it('[Wave 2B1] exactly ONE other src/ module names them: the reviewed Stage 1B2 adapter, for claim and arm only, never completion', () => {
    const naming = files.filter((file) => file !== REPOSITORY && PRIMITIVES.some((name) => codeOf(file).includes(name)));
    expect(naming).toEqual([MUTATION_ADAPTER]);
    const adapter = codeOf(MUTATION_ADAPTER);
    expect(adapter.includes('completeCancelAttemptWithinCallerFencedTransaction'), 'only the unwired adapter composes completion').toBe(true);
    // One import (claim, arm, and [Wave 2B2b] the two named no-wire releases; never completion), one call each.
    expect(adapter).toContain([
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
    expect(adapter.match(/claimCancelWithinCallerFencedTransaction\(/g)).toHaveLength(1);
    expect(adapter.match(/armCancelWireWithinCallerFencedTransaction\(/g)).toHaveLength(1);
    // The claim is fenced with the exact trusted practical account.
    expect(adapter).toContain('claim = await claimCancelWithinCallerFencedTransaction(tx, intentId, accountId);');
    // The Tier-B arm's 4th argument is the exact account id, NEVER null.
    expect(adapter).toContain('armCancelWireWithinCallerFencedTransaction(tx, handle.intentId, handle.orderRevisionAfterClaim, requireExactAccountId(lease.accountId, handle.accountId));');
    expect(adapter).not.toMatch(/armCancelWireWithinCallerFencedTransaction\([^)]*\bnull\b/);
    expect(adapter).toContain('function requireExactAccountId(value: string, expected: string): string {');
  });

  it('no barrel exports them, statically or at runtime, and the LiveExecutionRepository port does not declare them', () => {
    for (const name of PRIMITIVES) {
      expect(name in liveBarrel, name).toBe(false);
      for (const barrel of files.filter((file) => file.endsWith('/index.ts'))) {
        expect(codeOf(barrel).includes(name), `${barrel} exports ${name}`).toBe(false);
      }
    }
    const repository = codeOf(REPOSITORY);
    const port = repository.slice(repository.indexOf('export interface LiveExecutionRepository {'), repository.indexOf('\n}\n', repository.indexOf('export interface LiveExecutionRepository {')));
    for (const name of PRIMITIVES) expect(port.includes(name), name).toBe(false);
  });

  it('each primitive is called exactly once in src/: by its own strict public wrapper', () => {
    const code = codeOf(REPOSITORY);
    for (const name of PRIMITIVES) {
      expect(code.match(new RegExp(`\\b${name}\\(tx,`, 'g')) ?? [], name).toHaveLength(1);
    }
  });
});

// [P18B Stage 1B2 Wave 2B2a] The ONLY statements permitted between the strict fence and the primitive: the
// reviewed bound-claim interlock (the primitive's own locks, the verified read, then the non-locking guard).
// It adds no authority, takes no practical lock, and forwards nothing new to the primitive.
const ARM_OR_COMPLETE_INTERLOCK = [
  'await tx.$executeRaw`SELECT intent_id FROM live_order WHERE intent_id = ${intentId} FOR UPDATE`;',
  'await tx.$executeRaw`SELECT intent_id FROM live_execution_intent WHERE intent_id = ${intentId} FOR UPDATE`;',
  'const verified = await readVerifiedOrder(tx as unknown as IntentReadClient, intentId);',
  'if (verified !== null && (fence === null || verified.order.accountId === fence.accountId)) {',
  'await assertCancelWriteNotLeaseBound(tx as unknown as ReconciliationFenceClient, verified.order);',
  '}',
].join('\n');
const CLAIM_INTERLOCK = [
  'await tx.$executeRaw`SELECT intent_id FROM live_order WHERE intent_id = ${intentId} FOR UPDATE`;',
  'const verified = await readVerifiedOrder(tx as unknown as IntentReadClient, intentId);',
  "if (verified !== null && verified.order.accountId === trustedAccountId && verified.order.cancelState === 'NONE') {",
  'await assertCancelWriteNotLeaseBound(tx as unknown as ReconciliationFenceClient, verified.order);',
  '}',
].join('\n');
const normalizeLines = (text: string): string => text.split('\n').map((line) => line.trim()).filter(Boolean).join('\n');

describe('the PUBLIC strict Tier-A wrappers still fence FIRST', () => {
  it.each([
    ['claimCancel', 'claimCancelWithinCallerFencedTransaction', "await assertReconciliationFence(tx as unknown as ReconciliationFenceClient, reconciliationAuthorization, trustedAccountId, 'HEALTHY');", CLAIM_INTERLOCK],
    ['armCancelWire', 'armCancelWireWithinCallerFencedTransaction', "const fence = await assertReconciliationFence(tx as unknown as ReconciliationFenceClient, reconciliationAuthorization, null, 'HEALTHY');", ARM_OR_COMPLETE_INTERLOCK],
    ['completeCancelAttempt', 'completeCancelAttemptWithinCallerFencedTransaction', "const fence = await assertReconciliationFence(tx as unknown as ReconciliationFenceClient, reconciliationAuthorization, null, 'HEALTHY');", ARM_OR_COMPLETE_INTERLOCK],
  ])('%s: $transaction -> strict HEALTHY fence -> [2B2a interlock] -> %s, and nothing else', (method, primitive, fence, interlock) => {
    const source = methodSource(method);
    const transaction = source.indexOf('return this.#prisma.$transaction(async (tx) => {');
    const fenceAt = source.indexOf(fence);
    const call = source.indexOf(`return ${primitive}(tx,`);
    expect(transaction).toBeGreaterThan(0);
    expect(fenceAt).toBeGreaterThan(transaction);
    expect(call).toBeGreaterThan(fenceAt);
    // Between the fence and the primitive there is EXACTLY the reviewed Wave 2B2a interlock, and after it nothing but the close.
    expect(normalizeLines(source.slice(fenceAt + fence.length, call))).toBe(interlock);
    expect(source.slice(source.indexOf(';', call) + 1).trim()).toBe('});\n  }'.trim());
    // The wrapper still takes the strict authorization parameter and never a practical one.
    expect(source).toContain('reconciliationAuthorization?: unknown');
    expect(source).not.toMatch(/practical|Practical|certificate|enablement/);
  });

  it('the fence itself is unchanged in kind: every Phase17 mutation claim/repair still names HEALTHY or RUNNING authority', () => {
    const repository = sourceOf(REPOSITORY);
    expect(repository).toContain('async function assertReconciliationFence');
    expect(repository).toContain("reconciliationAuthorization, null, 'HEALTHY'");
    expect(repository).toContain("reconciliationAuthorization, trustedAccountId, 'HEALTHY'");
    expect(repository).toContain("reconciliationAuthorization, next.accountId, 'RUNNING'");
  });
});

describe('reachability: no practical module, no new integration importer, no network reach', () => {
  it('live/repository.ts keeps exactly its pre-Wave-2A src importers (no integration or practical module added)', () => {
    const importers = files.filter((file) => (graph.get(file) ?? []).includes(REPOSITORY)).sort();
    expect(importers).toEqual([
      'src/execution/live/index.ts',
      'src/execution/live/position-ownership.ts',
      'src/execution/live/reconciliation/ports.ts',
      'src/execution/live/reconciliation/position-attribution.ts',
      'src/execution/live/reconciliation/repository.ts',
      'src/execution/live/reconciliation/service.ts',
      'src/execution/live/service.ts',
      // The single approved Phase17 production root (pre-existing; it imports the public repository class only).
      'src/integration/coindcx/live/production-runtime.ts',
      'src/integration/coindcx/live/practical-account-coordinator.ts',
    ].concat(
      // [Wave 2B1] The reviewed Stage 1B2 adapter (the two claim/arm primitives only; it is itself wired into nothing).
      MUTATION_ADAPTER,
    ).sort());
    expect(codeOf('src/integration/coindcx/live/production-runtime.ts')).toContain("import { PrismaLiveExecutionRepository, type LiveExecutionRepository } from '../../../execution/live/repository';");
  });

  it('no practical module (Stage 1A, persistence, recovery, shadow) reaches live/repository.ts', () => {
    for (const root of ['src/execution/live/practical/', 'src/execution/live/practical-persistence/', 'src/execution/live/practical-recovery/', 'src/execution/live/practical-shadow/']) {
      const reaching = files.filter((file) => file.startsWith(root) && (file === REPOSITORY || computeReachable(graph, file).has(REPOSITORY)));
      expect(reaching, root).toEqual([]);
    }
  });

  it('live/repository.ts reaches no integration module, gateway, transport, or signer', () => {
    const reach = [...computeReachable(graph, REPOSITORY)];
    expect(reach.filter((node) => node.startsWith('src/integration/'))).toEqual([]);
    expect(reach.filter((node) => /gateway|transport|signer/.test(node))).toEqual([]);
  });
});

describe('the strict Phase 18 barrier is unchanged', () => {
  it('continuity is still REST_CURRENT_STATE_OBSERVED and the barrier still takes exactly its four real arguments', () => {
    expect(currentAccountContinuityCapability()).toBe('REST_CURRENT_STATE_OBSERVED');
    expect(requireCurrentReconciliation).toHaveLength(4);
    expect(codeOf('src/execution/live/reconciliation/barrier.ts')).toContain("reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN'");
  });
});
