import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildImportGraph, computeReachable } from './support/import-graph';

// Provider-confirmed account identity (users/info coindcx_id) and
// client_order_id idempotency are ORDER/ACCOUNT identity facts. This file
// proves structurally that neither can reach continuity-authority
// construction, that no new mutation owner or authority path exists, and that
// the Phase18 continuity decision point is unchanged.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

const ACCOUNT_IDENTITY = 'src/execution/live/reconciliation/account-identity.ts';
const ORDER_RECONCILIATION = 'src/execution/live/reconciliation/order-reconciliation.ts';
const BARRIER = 'src/execution/live/reconciliation/barrier.ts';
const RECONCILIATION_REPOSITORY = 'src/execution/live/reconciliation/repository.ts';
const RECONCILIATION_SERVICE = 'src/execution/live/reconciliation/service.ts';
const MUTATION_TRANSPORT = 'src/integration/coindcx/live/mutation-transport.ts';
const MUTATION_GATEWAY = 'src/integration/coindcx/live/order-gateway.ts';
const PRODUCTION_ROOT = 'src/integration/coindcx/live/production-runtime.ts';
const EVIDENCE_ADAPTER = 'src/integration/coindcx/live/reconciliation-evidence-adapter.ts';

function sourceOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8').replace(/\r\n/g, '\n');
}

/** Source with block and line comments removed, so prose cannot satisfy or trip an assertion. */
function codeOf(file: string): string {
  return sourceOf(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('provider identity cannot reach continuity-authority construction', () => {
  const { graph, files } = buildImportGraph(SRC_ROOT, REPO_ROOT);

  it('the account-identity module reaches no barrier, authorization repository, service, integration, or mutation module', () => {
    const reachable = computeReachable(graph, ACCOUNT_IDENTITY);
    for (const forbidden of [BARRIER, RECONCILIATION_REPOSITORY, RECONCILIATION_SERVICE, MUTATION_TRANSPORT, MUTATION_GATEWAY, PRODUCTION_ROOT, 'src/execution/live/authority.ts']) {
      expect(reachable.has(forbidden), `${ACCOUNT_IDENTITY} reaches ${forbidden}`).toBe(false);
    }
    expect([...reachable].filter((file) => file.startsWith('src/integration/'))).toEqual([]);
  });

  it('neither the identity guard nor client_order_id matching names any continuity or authority construct', () => {
    for (const file of [ACCOUNT_IDENTITY, ORDER_RECONCILIATION]) {
      const code = codeOf(file);
      for (const forbidden of ['ACCOUNT_CONTINUITY_PROVEN', 'currentAccountContinuityCapability', 'LiveAccountContinuityCapability',
        'LiveReconciliationAuthorization', 'authorizeCurrentHealthy', 'requireCurrentReconciliation', 'mintLive']) {
        expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
    }
  });

  it("the literal 'ACCOUNT_CONTINUITY_PROVEN' exists in executable source only inside the barrier", () => {
    const owners = files.filter((file) => file.startsWith('src/') && codeOf(file).includes("'ACCOUNT_CONTINUITY_PROVEN'"));
    expect(owners).toEqual([BARRIER]);
  });

  it('the one continuity decision point is unchanged: no parameter, literal REST-only answer', () => {
    const barrier = codeOf(BARRIER);
    const start = barrier.indexOf('export function currentAccountContinuityCapability(');
    const body = barrier.slice(start, barrier.indexOf('}', start) + 1);
    expect(body.replace(/\s+/g, ' ')).toBe("export function currentAccountContinuityCapability(): LiveAccountContinuityCapability { return 'REST_CURRENT_STATE_OBSERVED'; }");
  });
});

describe('the identity guard runs first and cannot be skipped', () => {
  const service = codeOf(RECONCILIATION_SERVICE);
  const reconcile = service.slice(service.indexOf('public async reconcileAccount('));

  it('verifies identity immediately after the generation claim, before any durable read, recovery, or evidence read', () => {
    const claim = reconcile.indexOf('this.#repository.claimGeneration(');
    const verify = reconcile.indexOf('await this.#verifyAccountIdentity(accountId)');
    const blocked = reconcile.indexOf('return this.#completeWithFindings(lease, [identityFinding], identitySnapshotSha256);');
    const firstDurableRead = reconcile.indexOf('listAccountOrderViews(accountId)');
    const recovery = reconcile.indexOf('planClaimRecovery(');
    const evidenceRead = reconcile.indexOf('this.#readStableVenueEvidence(');
    expect([claim, verify, blocked, firstDurableRead, recovery, evidenceRead].every((index) => index >= 0)).toBe(true);
    expect(claim).toBeLessThan(verify);
    expect(verify).toBeLessThan(blocked);
    expect(blocked).toBeLessThan(firstDurableRead);
    expect(firstDurableRead).toBeLessThan(recovery);
    expect(recovery).toBeLessThan(evidenceRead);
  });

  it('the expectation is required at construction and sourced only from the configuration gate', () => {
    expect(service).toContain('this.#expectedProviderAccountFingerprint = requireExpectedProviderAccountFingerprint(dependencies.expectedProviderAccountFingerprint);');
    const runtime = codeOf(PRODUCTION_ROOT);
    expect(runtime.match(/expectedProviderAccountFingerprint:/g)).toHaveLength(1);
    expect(runtime).toContain('expectedProviderAccountFingerprint: enablement.expectedProviderAccountFingerprint,');
  });
});

describe('no new mutation owner and no new authority path', () => {
  const { graph, files } = buildImportGraph(SRC_ROOT, REPO_ROOT);

  it('the mutation transport is still reachable only through the one gateway and the one production root', () => {
    const reachers = files.filter((file) => file !== MUTATION_TRANSPORT && computeReachable(graph, file).has(MUTATION_TRANSPORT));
    expect(reachers.sort()).toEqual([MUTATION_GATEWAY, PRODUCTION_ROOT].sort());
    expect(computeReachable(graph, EVIDENCE_ADAPTER).has(MUTATION_TRANSPORT)).toBe(false);
  });

  it('dependency inversion holds: no execution module reaches any integration module', () => {
    for (const file of files.filter((candidate) => candidate.startsWith('src/execution/'))) {
      expect([...computeReachable(graph, file)].filter((node) => node.startsWith('src/integration/')), file).toEqual([]);
    }
  });

  it('normal mutations still pass the unchanged barrier before any authority mint', () => {
    const runtime = codeOf(PRODUCTION_ROOT);
    for (const method of ['openLive', 'closeLive', 'cancelLive']) {
      const body = runtime.slice(runtime.indexOf(`public async ${method}(`));
      expect(body.indexOf('await this.#requireReconciled(')).toBeGreaterThan(-1);
      expect(body.indexOf('await this.#requireReconciled(')).toBeLessThan(Math.max(body.indexOf('mintLive'), body.indexOf('cancelDurable')));
    }
  });
});

describe('the duplicate client_order_id outcome is not guessed', () => {
  it('pins the unconfirmed provider signal to null and classifies on exact status and code only, never the message', () => {
    const gateway = codeOf(MUTATION_GATEWAY);
    expect(gateway).toContain('export const COINDCX_DUPLICATE_CLIENT_ORDER_ID_SIGNAL: CoinDcxDuplicateClientOrderIdSignal | null = null;');
    const start = gateway.indexOf('export function classifyCreateFailure(');
    const classifier = gateway.slice(start, gateway.indexOf('\n}\n', start) + 2);
    expect(classifier).toContain('signal.providerCode');
    expect(classifier).not.toMatch(/\.message|message\b|includes\(|RegExp|\.test\(/);
  });

  it('[PROVIDER-IDEMP-01] the create-failure path has no terminal REJECTED branch and no status-range rule', () => {
    const gateway = codeOf(MUTATION_GATEWAY);
    const start = gateway.indexOf('export function classifyCreateHttpFailure(');
    const classifier = gateway.slice(start, gateway.indexOf('\n}\n', start) + 2);
    expect(classifier).not.toContain("'REJECTED'");
    expect(classifier).not.toMatch(/statusCode\s*[<>]/);
    const mutationFailure = gateway.slice(gateway.indexOf('#classifyMutationFailure(wire: '), gateway.indexOf('#translate(order: '));
    expect(mutationFailure).not.toContain("'REJECTED'");
    expect(mutationFailure).toContain('return classifyCreateHttpFailure(wire.statusCode, wire.data);');
    // Only the create path uses it; the cancel path is separate and unchanged.
    expect(gateway.match(/this\.#classifyMutationFailure\(/g)).toHaveLength(1);
    const place = gateway.slice(gateway.indexOf('public async placeOrder('), gateway.indexOf('public async cancelOrder('));
    expect(place).toContain('this.#classifyMutationFailure(wire)');
  });

  it('the raw coindcx_id is reduced to a fingerprint at the adapter and never logged', () => {
    const adapter = codeOf(EVIDENCE_ADAPTER);
    const method = adapter.slice(adapter.indexOf('public async readAccountIdentity('), adapter.indexOf('async #readOrders('));
    for (const logCall of method.match(/logger\.\w+\([^;]*;/g) ?? []) {
      expect(logCall).not.toMatch(/providerAccountIdentifier|coindcxId/);
    }
    expect(method.match(/providerAccountIdentifier/g)?.length).toBeGreaterThan(0);
    expect(method).toContain('fingerprint: providerAccountFingerprint(providerAccountIdentifier)');
  });
});
