import { describe, expect, it } from 'vitest';
import { InMemoryLiveExecutionRepository } from '../helpers';
import {
  LiveRuntimeIdentity,
  newLiveRuntimeIdentity,
  readLiveRuntimeEpoch,
  requireCurrentReconciliation,
} from '../../../../../src/execution/live/reconciliation/barrier';
import {
  LiveReconciliationAuthorization,
} from '../../../../../src/execution/live/reconciliation/repository';
import {
  LiveReconciliationCompletionProof,
  LiveReconciliationService,
} from '../../../../../src/execution/live/reconciliation/service';
import {
  COINDCX_RECONCILIATION_MAX_PAGES,
  COINDCX_RECONCILIATION_MAX_PAGES_CEILING,
  CoinDcxReconciliationEvidenceAdapter,
} from '../../../../../src/integration/coindcx/live/reconciliation-evidence-adapter';
import { InMemoryReconciliationRepository } from './in-memory-repository';
import { ACCOUNT, FakeEvidenceProvider, FixedClock, evidenceSet } from './helpers';

describe('P18 Wave A opaque runtime and reconciliation authority', () => {
  it('rejects constructor misuse, cloning, structural fakes, and prototype-only objects', () => {
    expect(() => new LiveRuntimeIdentity(Symbol('fake'), 'replayed')).toThrow(/runtime identity/i);
    expect(LiveRuntimeIdentity.read({ epoch: 'replayed' })).toBeNull();
    expect(LiveRuntimeIdentity.read(Object.create(LiveRuntimeIdentity.prototype))).toBeNull();

    const identity = newLiveRuntimeIdentity();
    expect(readLiveRuntimeEpoch(identity)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(readLiveRuntimeEpoch({ ...identity })).toBeNull();

    expect(() => new LiveReconciliationAuthorization(Symbol('fake'), {
      accountId: ACCOUNT,
      runId: 'run',
      generation: 1,
      runtimeEpoch: 'epoch',
      stateRevision: 1,
      mode: 'HEALTHY',
    })).toThrow(/repository-issued/i);
    expect(LiveReconciliationAuthorization.read({ accountId: ACCOUNT, generation: 1 })).toBeNull();
    expect(LiveReconciliationAuthorization.read(Object.create(LiveReconciliationAuthorization.prototype))).toBeNull();
    expect(Object.isFrozen(LiveRuntimeIdentity)).toBe(true);
    expect(Object.isFrozen(LiveRuntimeIdentity.prototype)).toBe(true);
    expect(Object.isFrozen(LiveReconciliationAuthorization)).toBe(true);
    expect(Object.isFrozen(LiveReconciliationAuthorization.prototype)).toBe(true);
    expect(Object.isFrozen(LiveReconciliationCompletionProof)).toBe(true);
    expect(Object.isFrozen(LiveReconciliationCompletionProof.prototype)).toBe(true);
  });

  it('does not let a later runtime inherit or replay an earlier runtime HEALTHY result', async () => {
    // [P18 Wave B4 / F18-27] `requireCurrentReconciliation` now ALWAYS blocks
    // with `ACCOUNT_CONTINUITY_NOT_PROVEN`, by design: no evidence provider in
    // this codebase can prove account continuity, so live-mutation
    // authorization is structurally unreachable regardless of epoch fencing
    // (see `evidence-and-barrier.test.ts` for the dedicated F18-27 coverage).
    // What THIS test still proves is that epoch/generation fencing is the
    // active, correct reason in the two genuinely-fenced cases below, and NOT
    // a coincidental side effect of the F18-27 gate: a stale identity is
    // rejected for `STALE_RUNTIME_GENERATION`, one generation earlier than the
    // F18-27 check is even reached, while the CURRENT identity is rejected
    // ONLY for `ACCOUNT_CONTINUITY_NOT_PROVEN` — proving fencing itself
    // would otherwise have let it through.
    const repository = new InMemoryReconciliationRepository();
    const execution = new InMemoryLiveExecutionRepository();
    const provider = new FakeEvidenceProvider(evidenceSet());
    const firstIdentity = newLiveRuntimeIdentity();
    const first = new LiveReconciliationService({
      repository,
      executionRepository: execution,
      evidenceProvider: provider,
      runtimeIdentity: firstIdentity,
      credentialAccountId: ACCOUNT,
      clock: new FixedClock(),
    });
    await first.reconcileAccount(ACCOUNT);
    await expect(requireCurrentReconciliation(repository, ACCOUNT, firstIdentity, 'CREATE'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });

    const secondIdentity = newLiveRuntimeIdentity();
    await expect(requireCurrentReconciliation(repository, ACCOUNT, secondIdentity, 'CREATE'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'STALE_RUNTIME_GENERATION' } });

    const second = new LiveReconciliationService({
      repository,
      executionRepository: execution,
      evidenceProvider: provider,
      runtimeIdentity: secondIdentity,
      credentialAccountId: ACCOUNT,
      clock: new FixedClock(),
    });
    await second.reconcileAccount(ACCOUNT);
    await expect(requireCurrentReconciliation(repository, ACCOUNT, secondIdentity, 'CREATE'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
    await expect(requireCurrentReconciliation(repository, ACCOUNT, firstIdentity, 'CREATE'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'STALE_RUNTIME_GENERATION' } });
  });
});

describe('P18 Wave A credential account binding', () => {
  it('rejects another account before a claim or evidence read', async () => {
    const repository = new InMemoryReconciliationRepository();
    const provider = new FakeEvidenceProvider(evidenceSet());
    const service = new LiveReconciliationService({
      repository,
      executionRepository: new InMemoryLiveExecutionRepository(),
      evidenceProvider: provider,
      runtimeIdentity: newLiveRuntimeIdentity(),
      credentialAccountId: ACCOUNT,
      clock: new FixedClock(),
    });

    await expect(service.reconcileAccount('account-b')).rejects.toThrow(/Credential-bound reconciliation/);
    expect(provider.calls).toBe(0);
    expect((await repository.loadState('account-b')).currentGeneration).toBe(0);
    expect(await repository.loadOrphanOrders('account-b')).toEqual([]);
    expect(await repository.loadOwnershipShares('account-b', 'B-BTC_USDT')).toEqual([]);
  });

  it('the CoinDCX adapter returns only its bound account and refuses relabelling before reads', async () => {
    let orderReads = 0;
    let positionReads = 0;
    const client = {
      listInrFuturesOrders: async () => { orderReads += 1; return []; },
      listInrFuturesPositions: async () => { positionReads += 1; return []; },
    };
    const adapter = new CoinDcxReconciliationEvidenceAdapter({
      client: client as never,
      credentialAccountId: ACCOUNT,
      clock: new FixedClock(),
    });

    await expect(adapter.readAccountEvidence({ accountId: 'account-b', pairs: [], timeoutMs: 10 }))
      .rejects.toThrow(/different account/);
    expect(orderReads).toBe(0);
    expect(positionReads).toBe(0);

    const evidence = await adapter.readAccountEvidence({ accountId: ACCOUNT, pairs: [], timeoutMs: 10 });
    expect(evidence.accountId).toBe(ACCOUNT);
    expect(orderReads).toBe(2);
    expect(positionReads).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// [Wave B2 / F18-22] Adapter `maxPages` construction-time validation.
//
// Confirmed exploit: `maxPages = 0` (or `NaN`, negative, fractional,
// `Infinity`, or an absurd caller-supplied value) made the adapter's page
// loop condition `page <= maxPages` false on its very first check, so the
// loop body never ran. Zero provider requests were made, `pagesRead` stayed
// `0`, and the adapter reported `complete: true` anyway.
// ---------------------------------------------------------------------------

describe('P18 Wave B2 §F18-22 maxPages construction-time validation', () => {
  function fakeClient(counts: { orderCalls: number; positionCalls: number }) {
    return {
      listInrFuturesOrders: async () => { counts.orderCalls += 1; return []; },
      listInrFuturesPositions: async () => { counts.positionCalls += 1; return []; },
    };
  }

  function buildAdapter(maxPages: number | undefined, counts: { orderCalls: number; positionCalls: number }) {
    return new CoinDcxReconciliationEvidenceAdapter({
      client: fakeClient(counts) as never,
      credentialAccountId: ACCOUNT,
      clock: new FixedClock(),
      maxPages,
    });
  }

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, COINDCX_RECONCILIATION_MAX_PAGES_CEILING + 1, Number.MAX_SAFE_INTEGER])(
    'refuses an unsafe or out-of-range value at construction time (%s)',
    (value) => {
      const counts = { orderCalls: 0, positionCalls: 0 };
      expect(() => buildAdapter(value, counts)).toThrow(/LIVE_RECONCILIATION_EVIDENCE_INVALID/);
      // The confirmed exploit's decisive assertion: an invalid config makes
      // zero provider calls, ever.
      expect(counts.orderCalls).toBe(0);
      expect(counts.positionCalls).toBe(0);
    },
  );

  it('accepts 1 (the smallest legal value) and the implementation-owned ceiling', () => {
    const counts = { orderCalls: 0, positionCalls: 0 };
    expect(() => buildAdapter(1, counts)).not.toThrow();
    expect(() => buildAdapter(COINDCX_RECONCILIATION_MAX_PAGES_CEILING, counts)).not.toThrow();
  });

  it('accepts an absent value and falls back to the documented default, which is itself within the ceiling', () => {
    const counts = { orderCalls: 0, positionCalls: 0 };
    expect(() => buildAdapter(undefined, counts)).not.toThrow();
    expect(COINDCX_RECONCILIATION_MAX_PAGES).toBeLessThanOrEqual(COINDCX_RECONCILIATION_MAX_PAGES_CEILING);
    expect(COINDCX_RECONCILIATION_MAX_PAGES).toBeGreaterThanOrEqual(1);
  });

  it('a legally-constructed adapter that actually reads at least one page reports genuine completeness (defense-in-depth regression)', async () => {
    const counts = { orderCalls: 0, positionCalls: 0 };
    const adapter = buildAdapter(5, counts);
    const orders = await adapter.readOrders({ accountId: ACCOUNT, pairs: [], timeoutMs: 10 });
    const positions = await adapter.readPositions({ accountId: ACCOUNT, timeoutMs: 10 });
    expect(orders.provenance.complete).toBe(true);
    expect(orders.provenance.pagesRead).toBeGreaterThan(0);
    expect(positions.provenance.complete).toBe(true);
    expect(positions.provenance.pagesRead).toBeGreaterThan(0);
    expect(counts.orderCalls).toBe(2);
    expect(counts.positionCalls).toBe(1);
  });
});
