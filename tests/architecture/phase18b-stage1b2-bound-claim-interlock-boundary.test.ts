import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as liveBarrel from '../../src/execution/live';
import * as reconciliationBarrel from '../../src/execution/live/reconciliation';
import { currentAccountContinuityCapability, requireCurrentReconciliation } from '../../src/execution/live/reconciliation/barrier';
import { buildImportGraph, computeReachable } from './support/import-graph';

// Phase 18B Stage 1B2, Wave 2B2a: the Phase17/18 bound-claim interlock.
//
//   - ONE pure module (live/practical-cancel-binding.ts) owns the binding view, its exact-identity parser, and
//     the single classification; it imports no practical module, no Prisma client, and no authority.
//   - Every PUBLIC Phase17/18 write that can move a cancel column runs the guard AFTER its live_order lock and
//     verified read and BEFORE its write; the guard reads the lease WITHOUT any lock (global lock order kept).
//   - A plain observation fold writes no cancel column, so it can never clear a claim.
//   - Phase18 planning consults the binding before RECLAIM_CANCEL / CLEAR_CANCEL_CLAIM / claim-clearing folds.
//   - The two named no-wire release primitives have exactly ONE production importer since Wave 2B2b (the
//     Stage 1B2 adapter, one derived call each); neither is on the port or in any barrel; the adapter still
//     never imports Phase17 completion.
//   - [Wave 2B2b] The listing reads orders, intents, and bindings in ONE explicit REPEATABLE READ transaction.
//   - Only the no-wire completion and in-process abandon exist: no recovery, dispatch, permit, ACCEPTED, or REJECTED.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const REPOSITORY = 'src/execution/live/repository.ts';
const BINDING = 'src/execution/live/practical-cancel-binding.ts';
const ORDER_RECONCILIATION = 'src/execution/live/reconciliation/order-reconciliation.ts';
const MUTATION_ADAPTER = 'src/execution/live/practical-mutation/repository.ts';
const NO_WIRE_PRIMITIVES = [
  'releaseUnarmedCancelClaimWithinCallerFencedTransaction',
  'releaseArmedUndispatchedCancelClaimWithinCallerFencedTransaction',
] as const;
const GUARDED_PUBLIC_WRITES = ['claimCancel', 'armCancelWire', 'completeCancelAttempt', 'commitState', 'commitReconciledState'] as const;

const { graph, files } = buildImportGraph(SRC_ROOT, REPO_ROOT);

function sourceOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8').replace(/\r\n/g, '\n');
}

function codeOf(file: string): string {
  return sourceOf(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function functionSource(file: string, header: string): string {
  const code = codeOf(file);
  const start = code.indexOf(header);
  expect(start, header).toBeGreaterThan(0);
  return code.slice(start, code.indexOf('\n}\n', start) + 2);
}

function methodSource(name: string): string {
  const code = codeOf(REPOSITORY);
  const start = code.indexOf(`  public async ${name}(`);
  expect(start, name).toBeGreaterThan(0);
  const next = code.indexOf('\n  public async ', start + 1);
  const nextPrivate = code.indexOf('\n  #', start + 1);
  const ends = [next, nextPrivate].filter((index) => index > start);
  return code.slice(start, ends.length === 0 ? undefined : Math.min(...ends));
}

describe('the binding module is pure', () => {
  it('imports only the live error type and live types: no practical module, no Prisma, no authority', () => {
    const imports = [...codeOf(BINDING).matchAll(/from '([^']+)'/g)].map((match) => match[1]).sort();
    expect(imports).toEqual(['./errors', './types']);
    const reach = [...computeReachable(graph, BINDING)];
    expect(reach.filter((node) => /practical|reconciliation|repository|integration|gateway/.test(node))).toEqual([]);
    expect(codeOf(BINDING)).not.toMatch(/@prisma|\$queryRaw|\$executeRaw|FOR UPDATE|LiveReconciliationAuthorization|Certificate|Enablement/);
  });

  it('is imported in src ONLY by the Phase17 repository, the Phase18 port, and the Phase18 planner', () => {
    expect(files.filter((file) => (graph.get(file) ?? []).includes(BINDING)).sort()).toEqual([
      REPOSITORY, ORDER_RECONCILIATION, 'src/execution/live/reconciliation/ports.ts',
    ].sort());
  });
});

describe('the transaction-time guard', () => {
  it('reads the practical lease WITHOUT any lock, keyed by the verified current generation', () => {
    const read = functionSource(REPOSITORY, 'async function readCurrentPracticalCancelBinding(');
    expect(read).toContain('if (order.cancelGeneration < 1) return null;');
    expect(read).toContain('FROM live_practical_mutation_lease WHERE intent_id = ${order.intentId} AND cancel_generation = ${order.cancelGeneration}');
    expect(read).not.toMatch(/FOR UPDATE|FOR SHARE|LOCK IN SHARE MODE|NOWAIT|SKIP LOCKED/i);
    expect(read).toContain('return currentPracticalCancelBinding(rows, {');
  });

  it('no statement in live/repository.ts ever LOCKS a practical row (the global lock order is preserved)', () => {
    const code = codeOf(REPOSITORY);
    for (const statement of code.split(/`/)) {
      if (statement.includes('live_practical')) expect(statement).not.toMatch(/FOR UPDATE|FOR SHARE|LOCK IN SHARE MODE/i);
    }
    expect(code).not.toMatch(/livePractical[A-Za-z]+\.(update|updateMany|create|upsert|delete|deleteMany)\(/);
    expect(code).not.toMatch(/(UPDATE|INSERT INTO|DELETE FROM)\s+`?live_practical/i);
  });

  it('refuses LEASED / unresolved practical ambiguity as PRACTICALLY_BOUND, split as an integrity violation, and passes UNBOUND / HISTORICAL', () => {
    const guard = functionSource(REPOSITORY, 'async function assertCancelWriteNotLeaseBound(');
    expect(guard).toContain("if (verdict === 'UNBOUND' || verdict === 'HISTORICAL') return;");
    expect(guard).toContain("if (verdict === 'SPLIT') {");
    expect(guard).toContain("throw new LiveExecutionError('LIVE_DURABLE_INTEGRITY_VIOLATION'");
    expect(guard).toContain("throw new LiveExecutionError('LIVE_CANCEL_CLAIM_PRACTICALLY_BOUND'");
  });

  it.each(GUARDED_PUBLIC_WRITES)('%s runs the guard after its live_order lock and verified read, and before any write', (method) => {
    const source = methodSource(method);
    const lock = source.indexOf('SELECT intent_id FROM live_order WHERE intent_id =');
    const read = source.indexOf('await readVerifiedOrder(', lock);
    const guard = source.indexOf('assertCancelWriteNotLeaseBound(');
    expect(lock, method).toBeGreaterThan(0);
    expect(read, method).toBeGreaterThan(lock);
    expect(guard, method).toBeGreaterThan(read);
    for (const write of ['tx.liveOrder.updateMany(', 'tx.liveOrder.update(', 'tx.liveOrderEvent.create(', 'WithinCallerFencedTransaction(tx,']) {
      const at = source.indexOf(write);
      if (at !== -1) expect(at, `${method}: ${write}`).toBeGreaterThan(guard);
    }
    expect(source.split('assertCancelWriteNotLeaseBound(')).toHaveLength(2);
  });

  it('commitState / commitReconciledState guard exactly when a cancel column would change', () => {
    for (const method of ['commitState', 'commitReconciledState']) {
      expect(methodSource(method)).toContain('if (changesCancelColumns(current, next)) await assertCancelWriteNotLeaseBound(tx as unknown as ReconciliationFenceClient, current);');
    }
    const changes = functionSource(REPOSITORY, 'function changesCancelColumns(');
    for (const column of ['cancelState', 'cancelGeneration', 'cancelWireArmed', 'cancelFaultCode', 'cancelExchangeOrderId']) {
      expect(changes).toContain(`current.${column} !== next.${column}`);
    }
  });

  it('the guard is the ONLY new practical read in the Phase17 write paths (exactly the five public writes call it)', () => {
    const code = codeOf(REPOSITORY);
    expect(code.split('assertCancelWriteNotLeaseBound(')).toHaveLength(GUARDED_PUBLIC_WRITES.length + 2); // five calls + one definition
    expect(code.split('readCurrentPracticalCancelBinding(')).toHaveLength(3); // one definition + one call
  });

  it('a plain observation fold writes no cancel column, so it can never clear a claim', () => {
    const fold = methodSource('applyObservationAtomically');
    const data = fold.slice(fold.indexOf('await tx.liveOrder.update({'));
    for (const column of ['cancelState', 'cancelGeneration', 'cancelWireArmed', 'cancelFaultCode', 'cancelExchangeOrderId']) {
      expect(data).not.toContain(`${column}:`);
    }
  });
});

describe('the advisory order-view binding', () => {
  it('listAccountOrderViews reads bindings by the exact (intent_id, cancel_generation) pairs and fails closed on a non-exact row', () => {
    const read = functionSource(REPOSITORY, 'async function currentPracticalCancelBindings(');
    expect(read).toContain('WHERE (intent_id, cancel_generation) IN (${pairs})');
    expect(read).toContain('orders.filter((order) => order.cancelGeneration >= 1)');
    expect(read).toContain("'A practical cancel binding row does not name a requested intent exactly'");
    expect(read).not.toMatch(/FOR UPDATE|FOR SHARE|LOCK IN SHARE MODE/i);
    // [Wave 2B2b] The binding read goes through the listing's OWN transaction client, never the root client.
    expect(read).toContain('const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT');
    expect(read).not.toContain('#prisma');
    const within = codeOf(REPOSITORY).slice(codeOf(REPOSITORY).indexOf('async #listAccountOrderViewsWithin('));
    expect(within.slice(0, within.indexOf('\n  }\n'))).toContain('practicalCancelBinding: bindings.get(order.intentId) ?? null,');
  });

  it('[Wave 2B2b] one explicit REPEATABLE READ transaction, plain non-locking reads only, both through the same tx (no false split pair)', () => {
    const listing = methodSource('listAccountOrderViews');
    expect(listing).toContain('return this.#prisma.$transaction(');
    expect(listing).toContain('(tx) => this.#listAccountOrderViewsWithin(tx as unknown as ConsistentListingClient, accountId),');
    expect(listing).toContain('{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 },');
    const code = codeOf(REPOSITORY);
    const within = code.slice(code.indexOf('async #listAccountOrderViewsWithin('));
    const body = within.slice(0, within.indexOf('\n  }\n'));
    expect(body).toContain('const rows = await tx.liveOrder.findMany({');
    expect(body).toContain('const bindings = await currentPracticalCancelBindings(tx, verifiedRows.map((entry) => entry.order));');
    expect(body).not.toMatch(/#prisma|FOR UPDATE|FOR SHARE|LOCK IN SHARE MODE|\$executeRaw/i);
    // The binding read is reachable ONLY from the consistent listing (never a separate autocommit statement).
    expect(code.split('currentPracticalCancelBindings(')).toHaveLength(3); // one definition + one call
  });
});

describe('Phase18 planning consults the binding before any claim effect', () => {
  it('planClaimRecovery raises the finding and skips the order BEFORE RECLAIM_DISPATCH / RECLAIM_CANCEL', () => {
    const plan = functionSource(ORDER_RECONCILIATION, 'export function planClaimRecovery(');
    const check = plan.indexOf('const practical = practicalCancelBindingFinding(order);');
    expect(check).toBeGreaterThan(0);
    expect(plan.indexOf("kind: 'RECLAIM_DISPATCH'")).toBeGreaterThan(check);
    expect(plan.indexOf("kind: 'RECLAIM_CANCEL'")).toBeGreaterThan(check);
    expect(plan).toContain('findings.push(practical);\n      continue;');
  });

  it('reconcileIdentifiedOrder returns ZERO effects for a bound order before evaluating any venue evidence', () => {
    const reconcile = functionSource(ORDER_RECONCILIATION, 'export function reconcileIdentifiedOrder(');
    const check = reconcile.indexOf('if (practicalCancelBindingFinding(order) !== null) return outcome([], [], [exchangeOrderId]);');
    expect(check).toBeGreaterThan(0);
    for (const effect of ["kind: 'CLEAR_CANCEL_CLAIM'", "kind: 'APPLY_OBSERVATION'", 'evidence.orders.filter(']) {
      expect(reconcile.indexOf(effect), effect).toBeGreaterThan(check);
    }
  });

  it('resolveAmbiguousCreate is defensive for a bound view', () => {
    expect(functionSource(ORDER_RECONCILIATION, 'export function resolveAmbiguousCreate(')).toContain('if (practicalCancelBindingFinding(order) !== null) return outcome([]);');
  });

  it('no planner path uses time to resolve a practical binding', () => {
    const finding = functionSource(ORDER_RECONCILIATION, 'export function practicalCancelBindingFinding(');
    expect(finding).not.toMatch(/AtMs\s*[<>]|evaluatedAtMs|nowMs|Date\.now|timeout/i);
    expect(finding).toContain("category: 'AMBIGUOUS',\n      code: 'RECON_PRACTICAL_CANCEL_AMBIGUITY_UNRESOLVED'");
    expect(finding).toContain("category: 'MANUAL_REVIEW_REQUIRED',\n    code: 'RECON_PRACTICAL_CANCEL_BINDING_SPLIT'");
  });
});

describe('the two named no-wire release primitives', () => {
  it.each(NO_WIRE_PRIMITIVES)('%s: exported by live/repository.ts only; [Wave 2B2b] exactly ONE src importer (the Stage 1B2 adapter); not on the port or any barrel', (name) => {
    expect(codeOf(REPOSITORY)).toMatch(new RegExp(`export async function ${name}\\(\\n  tx: Prisma\\.TransactionClient,\\n  intentId: string,\\n  generation: number,\\n  fencedAccountId: string,\\n\\): Promise<LiveOrderStateRecord> \\{`));
    expect(files.filter((candidate) => candidate !== REPOSITORY && codeOf(candidate).includes(name))).toEqual([MUTATION_ADAPTER]);
    expect(name in liveBarrel).toBe(false);
    expect(name in reconciliationBarrel).toBe(false);
    const port = codeOf(REPOSITORY).slice(codeOf(REPOSITORY).indexOf('export interface LiveExecutionRepository {'));
    expect(port.slice(0, port.indexOf('\n}\n'))).not.toContain(name);
  });

  it('each delegates with its OWN fixed wire-arm literal: no caller ever passes a wire-arm boolean', () => {
    expect(functionSource(REPOSITORY, 'export async function releaseUnarmedCancelClaimWithinCallerFencedTransaction(')).toContain(
      'return releaseCancelClaimWithoutWire(tx, intentId, generation, fencedAccountId, false);',
    );
    expect(functionSource(REPOSITORY, 'export async function releaseArmedUndispatchedCancelClaimWithinCallerFencedTransaction(')).toContain(
      'return releaseCancelClaimWithoutWire(tx, intentId, generation, fencedAccountId, true);',
    );
    const code = codeOf(REPOSITORY);
    expect(code.split('releaseCancelClaimWithoutWire(')).toHaveLength(4); // one definition + two delegations
    expect(code).not.toMatch(/^export (async )?function releaseCancelClaimWithoutWire/m);
  });

  it('the shared body: no fence, no transaction, exact account, exact generation + arm state, order -> intent locks, claim-only write', () => {
    const body = functionSource(REPOSITORY, 'async function releaseCancelClaimWithoutWire(');
    expect(body).not.toMatch(/assertReconciliationFence|\$transaction|LiveReconciliationAuthorization|live_practical/);
    expect(body.indexOf('SELECT intent_id FROM live_order WHERE intent_id =')).toBeLessThan(body.indexOf('SELECT intent_id FROM live_execution_intent WHERE intent_id ='));
    expect(body).toContain('if (current.accountId !== fencedAccountId) {');
    expect(body).toContain("if (current.cancelState !== 'CANCEL_RESERVED' || current.cancelGeneration !== generation || current.cancelWireArmed !== requiredCancelWireArmed) {");
    expect(body).toContain("data: { cancelState: 'NONE', cancelWireArmed: false, cancelFaultCode: null, revision: { increment: 1 } },");
    expect(body).not.toMatch(/\bstate: '(CANCELLED|ACKNOWLEDGED|REJECTED|FILLED)'/);
    expect(body).not.toMatch(/cancelState: '(CANCEL_REJECTED|CANCEL_ACKNOWLEDGED|CANCEL_AMBIGUOUS)'/);
  });
});

describe('scope: [Wave 2B2b widened] only the no-wire completion and in-process abandon exist; no recovery, dispatch, permit, ACCEPTED, or REJECTED', () => {
  it('the Stage 1B2 adapter never names Phase 17 completion; each no-wire primitive is called exactly ONCE, fenced with the exact lease account', () => {
    const adapter = codeOf(MUTATION_ADAPTER);
    expect(adapter).not.toContain('completeCancelAttemptWithinCallerFencedTransaction');
    expect(adapter).not.toMatch(/completeCancelLease|recoverOrphanedCancelLease|DispatchPermit/);
    // One derived call each, in the shared no-wire body, selected ONLY by the locked coupled durable pair.
    expect(adapter.match(/await releaseArmedUndispatchedCancelClaimWithinCallerFencedTransaction\(/g)).toHaveLength(1);
    expect(adapter.match(/await releaseUnarmedCancelClaimWithinCallerFencedTransaction\(/g)).toHaveLength(1);
    expect(adapter).toContain('const accountForRelease = requireExactAccountId(lease.accountId, ctx.accountId);');
    expect(adapter).toContain([
      'const released = leaseArmed',
      '        ? await releaseArmedUndispatchedCancelClaimWithinCallerFencedTransaction(tx, ctx.intentId, ctx.cancelGeneration, accountForRelease)',
      '        : await releaseUnarmedCancelClaimWithinCallerFencedTransaction(tx, ctx.intentId, ctx.cancelGeneration, accountForRelease);',
    ].join('\n'));
    const noWire = adapter.slice(adapter.indexOf('async #noWireWithin('), adapter.indexOf('async #noWireAlreadyClosed('));
    const derive = noWire.indexOf('const leaseArmed = lease.armedAtMs !== null;');
    expect(derive).toBeGreaterThan(0);
    expect(noWire.indexOf("if (leaseArmed !== before.cancelWireArmed) splitState(")).toBeGreaterThan(derive);
    expect(noWire.indexOf("if (!leaseArmed) splitState('A committed arm is not durable on either side', details);")).toBeGreaterThan(derive);
    expect(noWire.indexOf("} else if (ctx.mode === 'ABANDON_AVAILABLE' && leaseArmed) {")).toBeGreaterThan(derive);
    expect(noWire.indexOf('const released = leaseArmed')).toBeGreaterThan(noWire.indexOf("} else if (ctx.mode === 'ABANDON_AVAILABLE' && leaseArmed) {"));
    // The no-wire body never reads or locks the reconciliation state, and never names enablement or runtime authority.
    expect(noWire).not.toMatch(/live_reconciliation_state|lockReconciliationState|classifyPracticalReconciliationMismatch|requireCancelEnablement|requireRuntimeEpoch|readLiveRuntimeEpoch/);
  });

  it('the idempotent-retry path is read-only and returns ALREADY_COMPLETED only after EVERY exact identity and arm-origin check', () => {
    const adapter = codeOf(MUTATION_ADAPTER);
    const start = adapter.indexOf('async #noWireAlreadyClosed(');
    const closed = adapter.slice(start, adapter.indexOf('async #afterNoWireRollback(', start));
    // No write of its own: no release primitive, no lease completion, no manual review, no raw statement
    // (a split it detects is escalated only by #afterNoWireRollback, after the rollback).
    expect(closed).not.toMatch(/release(Armed|Unarmed)\w*WithinCallerFencedTransaction|completeOrderBoundCancelLeaseNoWire|enterManualReview|\$executeRaw|updateMany/);
    const success = closed.indexOf("return Object.freeze({ kind: 'ALREADY_COMPLETED' as const });");
    expect(success).toBeGreaterThan(0);
    expect(closed.match(/kind: 'ALREADY_COMPLETED'/g)).toHaveLength(1);
    for (const check of [
      'const { lease, certificate } = await scope.readOrderBoundCancelLease(expected);',
      'if (!ctx.certificateMatches(certificate)) completionRefused(',
      'if (ctx.expectedLeaseCreatedAtMs !== null && lease.createdAtMs !== ctx.expectedLeaseCreatedAtMs) completionRefused(',
      '? ctx.expectedArmedAtMs !== null && lease.armedAtMs === ctx.expectedArmedAtMs',
      "? lease.armedAtMs === null",
      'if (!armPermitted) completionRefused(',
      '|| order.intentId !== ctx.intentId',
      '|| order.accountId !== ctx.accountId',
      '|| order.clientOrderId !== ctx.clientOrderId',
      '|| order.pair !== ctx.pair',
      '|| order.exchangeOrderId !== ctx.exchangeOrderId) {',
      'if (order.cancelFaultCode !== null || order.cancelExchangeOrderId !== ctx.exchangeOrderId) {',
      "if (!ctx.retry) alreadyCompleted(",
    ]) {
      const at = closed.indexOf(check);
      expect(at, check).toBeGreaterThan(0);
      expect(at, check).toBeLessThan(success);
    }
  });

  it('no src module introduces a completion-of-dispatch / recovery / permit surface; the adapter writes no dispatched outcome', () => {
    for (const file of files.filter((candidate) => candidate.startsWith('src/'))) {
      expect(codeOf(file), file).not.toMatch(/completeCancelLease|recoverOrphanedCancelLease|PracticalCancelDispatchPermit|PracticalVerifiedCancelResolution/);
    }
    const namesNoWireOperations = files.filter((file) => /completeUndispatchedCancel|abandonAcquiredCancel/.test(codeOf(file))).sort();
    expect(namesNoWireOperations).toEqual(['src/execution/live/practical-mutation/ports.ts', MUTATION_ADAPTER].sort());
    const adapter = codeOf(MUTATION_ADAPTER);
    expect(adapter).not.toMatch(/'AMBIGUOUS'|'REJECTED'|'ACCEPTED'|HTTP_|statusCode|\b429\b/);
  });

  it('live/repository.ts still reaches no practical module, integration module, gateway, transport, or signer', () => {
    const reach = [...computeReachable(graph, REPOSITORY)];
    expect(reach.filter((node) => /^src\/execution\/live\/practical(-[a-z]+)?\//.test(node))).toEqual([]);
    expect(reach.filter((node) => node.startsWith('src/integration/'))).toEqual([]);
    expect(reach.filter((node) => /gateway|transport|signer/.test(node))).toEqual([]);
  });

  it('the strict Tier-A barrier is unchanged: continuity still refused', () => {
    expect(currentAccountContinuityCapability()).toBe('REST_CURRENT_STATE_OBSERVED');
    expect(requireCurrentReconciliation).toHaveLength(4);
    expect(codeOf('src/execution/live/reconciliation/barrier.ts')).toContain("reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN'");
  });
});
