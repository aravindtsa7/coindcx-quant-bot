import { describe, expect, it } from 'vitest';
import {
  LiveReconciliationService,
  OrphanCleanupPolicy,
  resolveOrphanCleanupPolicy,
} from '../../../../../src/execution/live/reconciliation';
import { mintOrphanAmbiguityResolutionRequest } from '../../../../../src/execution/live/reconciliation/orphan-resolution';
import { newLiveRuntimeIdentity } from '../../../../../src/execution/live/reconciliation/barrier';
import { InMemoryLiveExecutionRepository } from '../helpers';
import { InMemoryReconciliationRepository } from './in-memory-repository';
import {
  ACCOUNT,
  EPOCH,
  FakeEvidenceProvider,
  FakeOrphanCancellation,
  FixedClock,
  PAIR,
  RUNTIME_IDENTITY,
  evidenceSet,
  provenance,
  venueOrder,
  venuePosition,
} from './helpers';

// ---------------------------------------------------------------------------
// §9 the orphan-cleanup gate
// ---------------------------------------------------------------------------

describe('P18 §9 orphan cleanup is disabled by default', () => {
  it('refuses an absent flag', () => {
    const resolution = resolveOrphanCleanupPolicy({});
    expect(resolution.status).toBe('DISABLED');
    expect(resolution.status === 'DISABLED' && resolution.reason).toBe('NOT_EXPLICITLY_ENABLED');
  });

  it.each(['TRUE', '1', 'yes', ' true ', 'True'])('refuses the near-miss flag %s', (flag) => {
    const resolution = resolveOrphanCleanupPolicy({
      LIVE_ORPHAN_CANCELLATION_ENABLED: flag,
      LIVE_ORPHAN_CANCELLATION_ACCOUNT_ALLOWLIST: ACCOUNT,
    });
    expect(resolution.status).toBe('DISABLED');
    expect(resolution.status === 'DISABLED' && resolution.reason).toBe('MALFORMED_ENABLE_FLAG');
  });

  it('refuses an empty account allowlist even when explicitly enabled', () => {
    const resolution = resolveOrphanCleanupPolicy({ LIVE_ORPHAN_CANCELLATION_ENABLED: 'true' });
    expect(resolution.status === 'DISABLED' && resolution.reason).toBe('EMPTY_ACCOUNT_ALLOWLIST');
  });

  it('refuses a malformed per-run ceiling rather than falling back to a default', () => {
    const resolution = resolveOrphanCleanupPolicy({
      LIVE_ORPHAN_CANCELLATION_ENABLED: 'true',
      LIVE_ORPHAN_CANCELLATION_ACCOUNT_ALLOWLIST: ACCOUNT,
      LIVE_ORPHAN_CANCELLATION_MAX_PER_RUN: '0',
    });
    expect(resolution.status).toBe('DISABLED');
  });

  it('enables only with the exact lowercase literal plus an allowlist', () => {
    const resolution = resolveOrphanCleanupPolicy({
      LIVE_ORPHAN_CANCELLATION_ENABLED: 'true',
      LIVE_ORPHAN_CANCELLATION_ACCOUNT_ALLOWLIST: ACCOUNT,
      LIVE_ORPHAN_CANCELLATION_MAX_PER_RUN: '3',
    });
    expect(resolution.status).toBe('ENABLED');
    if (resolution.status !== 'ENABLED') return;
    expect(resolution.policy.permitsAccount(ACCOUNT)).toBe(true);
    expect(resolution.policy.permitsAccount('another-account')).toBe(false);
    expect(resolution.policy.maxCancellationsPerRun).toBe(3);
  });

  it('cannot be forged by a plain object', () => {
    expect(() => new OrphanCleanupPolicy(Symbol('not the issuer'), {
      accountAllowlist: [ACCOUNT], maxCancellationsPerRun: 99,
    })).toThrow(/LIVE_EXECUTION_DISABLED/);
    expect(OrphanCleanupPolicy.read({ accountAllowlist: [ACCOUNT] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

function buildService(options: {
  readonly evidence?: ReturnType<typeof evidenceSet>;
  readonly orphanCancellation?: FakeOrphanCancellation;
  readonly orphanEnabled?: boolean;
  readonly orphanAccount?: string;
} = {}) {
  const reconciliation = new InMemoryReconciliationRepository();
  const execution = new InMemoryLiveExecutionRepository();
  const provider = new FakeEvidenceProvider(options.evidence ?? evidenceSet());
  const resolution = resolveOrphanCleanupPolicy({
    LIVE_ORPHAN_CANCELLATION_ENABLED: options.orphanEnabled === true ? 'true' : 'false',
    LIVE_ORPHAN_CANCELLATION_ACCOUNT_ALLOWLIST: options.orphanAccount ?? ACCOUNT,
  });
  const service = new LiveReconciliationService({
    repository: reconciliation,
    executionRepository: execution,
    evidenceProvider: provider,
    runtimeIdentity: RUNTIME_IDENTITY,
    credentialAccountId: ACCOUNT,
    clock: new FixedClock(),
    ...(resolution.status === 'ENABLED' && options.orphanCancellation !== undefined
      ? { orphanPolicy: resolution.policy, orphanCancellation: options.orphanCancellation }
      : {}),
  });
  return { service, reconciliation, execution, provider };
}

describe('P18 §3 a clean account reconciles to HEALTHY and unblocks the Phase17 path', () => {
  it('starts blocked, then permits after a successful run', async () => {
    const { service, reconciliation } = buildService();
    expect((await reconciliation.loadState(ACCOUNT)).status).toBe('RECONCILIATION_REQUIRED');

    const outcome = await service.reconcileAccount(ACCOUNT);
    expect(outcome.kind).toBe('COMPLETED');
    if (outcome.kind !== 'COMPLETED') return;
    expect(outcome.result.status).toBe('HEALTHY');
    expect(outcome.result.blockingFindingCount).toBe(0);

    const state = await reconciliation.loadState(ACCOUNT);
    expect(state.status).toBe('HEALTHY');
    expect(state.currentRuntimeEpoch).toBe(EPOCH);
    expect(state.healthyGeneration).toBe(state.currentGeneration);
  });

  it('carries a deterministic snapshot identity', async () => {
    const { service } = buildService();
    const first = await service.reconcileAccount(ACCOUNT);
    const second = await service.reconcileAccount(ACCOUNT);
    if (first.kind !== 'COMPLETED' || second.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(first.result.snapshotSha256).toBe(second.result.snapshotSha256);
  });
});

describe('P18 §16 idempotence', () => {
  it('produces no new economic effect, no duplicate finding, and no ownership churn on a rerun', async () => {
    const evidence = evidenceSet({
      orders: [venueOrder({ exchangeOrderId: 'stranger-1' })],
      positions: [venuePosition({ signedQuantity: '0' })],
    });
    const { service, reconciliation } = buildService({ evidence });

    await service.reconcileAccount(ACCOUNT);
    const findingsAfterFirst = reconciliation.findingCount;
    const writesAfterFirst = reconciliation.findingWriteCount;

    await service.reconcileAccount(ACCOUNT);
    await service.reconcileAccount(ACCOUNT);

    // The same immutable facts are re-observed, never re-inserted.
    expect(reconciliation.findingCount).toBe(findingsAfterFirst);
    expect(reconciliation.findingWriteCount).toBe(writesAfterFirst);
  });

  it('keeps the account blocked across identical reruns when the fault persists', async () => {
    const evidence = evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'stranger-1' })] });
    const { service, reconciliation } = buildService({ evidence });
    for (let run = 0; run < 3; run += 1) {
      const outcome = await service.reconcileAccount(ACCOUNT);
      expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
    }
    expect((await reconciliation.loadState(ACCOUNT)).status).not.toBe('HEALTHY');
  });
});

describe('P18 §9 orphan handling', () => {
  const orphanEvidence = evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'stranger-1' })] });

  it('records the orphan and BLOCKS when cleanup is disabled, rather than reporting health', async () => {
    const { service, reconciliation } = buildService({ evidence: orphanEvidence });
    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');

    expect(outcome.result.status).not.toBe('HEALTHY');
    expect(outcome.result.findings.map((finding) => finding.code)).toContain('RECON_ORPHAN_CLEANUP_DISABLED');
    const orphans = await reconciliation.loadOrphanOrders(ACCOUNT);
    expect(orphans).toHaveLength(1);
    // Never silently adopted: no cancellation was even claimed.
    expect(orphans[0]?.cancelState).toBe('NONE');
  });

  it('never cancels for an account outside the orphan allowlist', async () => {
    const port = new FakeOrphanCancellation();
    const { service } = buildService({
      evidence: orphanEvidence, orphanCancellation: port, orphanEnabled: true, orphanAccount: 'a-different-account',
    });
    await service.reconcileAccount(ACCOUNT);
    expect(port.attempts).toEqual([]);
  });

  it('attempts at most ONE wire cancel per orphan, even across repeated runs', async () => {
    const port = new FakeOrphanCancellation({ kind: 'CANCELLED' });
    const { service } = buildService({ evidence: orphanEvidence, orphanCancellation: port, orphanEnabled: true });

    await service.reconcileAccount(ACCOUNT);
    await service.reconcileAccount(ACCOUNT);
    await service.reconcileAccount(ACCOUNT);

    expect(port.attempts).toEqual([{ exchangeOrderId: 'stranger-1', pair: PAIR }]);
  });

  it('NEVER resends an ambiguous orphan cancel, including after a restart', async () => {
    const port = new FakeOrphanCancellation({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const reconciliation = new InMemoryReconciliationRepository();
    const execution = new InMemoryLiveExecutionRepository();
    const provider = new FakeEvidenceProvider(orphanEvidence);
    const resolution = resolveOrphanCleanupPolicy({
      LIVE_ORPHAN_CANCELLATION_ENABLED: 'true',
      LIVE_ORPHAN_CANCELLATION_ACCOUNT_ALLOWLIST: ACCOUNT,
    });
    if (resolution.status !== 'ENABLED') throw new Error('expected enabled policy');

    const first = new LiveReconciliationService({
      repository: reconciliation, executionRepository: execution, evidenceProvider: provider,
      runtimeIdentity: RUNTIME_IDENTITY, credentialAccountId: ACCOUNT,
      clock: new FixedClock(), orphanPolicy: resolution.policy, orphanCancellation: port,
    });
    await first.reconcileAccount(ACCOUNT);
    expect(port.attempts).toHaveLength(1);

    // A NEW process, new epoch, same durable state. The ambiguous claim is
    // durable, so the restart must not re-arm it.
    const second = new LiveReconciliationService({
      repository: reconciliation, executionRepository: execution, evidenceProvider: provider,
      runtimeIdentity: newLiveRuntimeIdentity(), credentialAccountId: ACCOUNT,
      clock: new FixedClock(), orphanPolicy: resolution.policy, orphanCancellation: port,
    });
    const outcome = await second.reconcileAccount(ACCOUNT);

    expect(port.attempts).toHaveLength(1);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome.result.status).toBe('MANUAL_REVIEW_REQUIRED');
    expect(outcome.result.findings.map((finding) => finding.code)).toContain('RECON_ORPHAN_CANCEL_AMBIGUOUS');
  });

  it('an ambiguous orphan cancel makes the account manual-review, not healthy', async () => {
    const port = new FakeOrphanCancellation({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const { service, reconciliation } = buildService({ evidence: orphanEvidence, orphanCancellation: port, orphanEnabled: true });
    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome.result.status).toBe('MANUAL_REVIEW_REQUIRED');
    const orphans = await reconciliation.loadOrphanOrders(ACCOUNT);
    expect(orphans[0]?.cancelState).toBe('CANCEL_AMBIGUOUS');
  });
});

// ---------------------------------------------------------------------------
// [Wave B5 / F18-29] A durably (or freshly) `CANCEL_AMBIGUOUS` orphan must
// report exactly ONE blocking finding — the sticky `RECON_ORPHAN_CANCEL_AMBIGUOUS`
// — never that finding ALONGSIDE the generic `RECON_ORPHAN_VENUE_ORDER` that
// `detectOrphanVenueOrders` would otherwise also raise for the same still-
// visible order. The sticky finding is strictly stronger; the generic one is
// pure duplicate operator noise for the identical underlying fact. This must
// hold on first discovery (same run the ambiguity happens), on every later
// reassertion (F18-25 stickiness across generations), and even once the venue
// stops returning the order at all (F18-25's whole point is that stickiness
// does not depend on continued visibility).
// ---------------------------------------------------------------------------

describe('P18 Wave B5 §F18-29 orphan finding dedup', () => {
  const orphanEvidence = evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'stranger-1' })] });

  it('same-run direct discovery: an orphan cancel that turns ambiguous THIS run reports the sticky finding only, never RECON_ORPHAN_VENUE_ORDER too', async () => {
    const port = new FakeOrphanCancellation({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const { service } = buildService({ evidence: orphanEvidence, orphanCancellation: port, orphanEnabled: true });

    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    const codesForOrphan = outcome.result.findings
      .filter((finding) => finding.subject.exchangeOrderId === 'stranger-1')
      .map((finding) => finding.code);
    expect(codesForOrphan).toEqual(['RECON_ORPHAN_CANCEL_AMBIGUOUS']);
    expect(codesForOrphan).not.toContain('RECON_ORPHAN_VENUE_ORDER');
  });

  it('across generations: a durably ambiguous orphan still visible at the venue keeps reporting exactly one finding, never two', async () => {
    const port = new FakeOrphanCancellation({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const { service } = buildService({ evidence: orphanEvidence, orphanCancellation: port, orphanEnabled: true });

    const first = await service.reconcileAccount(ACCOUNT);
    if (first.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(first.result.findings.filter((f) => f.subject.exchangeOrderId === 'stranger-1').map((f) => f.code))
      .toEqual(['RECON_ORPHAN_CANCEL_AMBIGUOUS']);

    // Generations 2 and 3: the same fake evidence provider keeps returning
    // the same still-open venue order. A live cancel is never resent
    // (§9.8/F18-25), and the dedup must hold on every reassertion too.
    for (let run = 0; run < 2; run += 1) {
      const outcome = await service.reconcileAccount(ACCOUNT);
      if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
      const codesForOrphan = outcome.result.findings
        .filter((finding) => finding.subject.exchangeOrderId === 'stranger-1')
        .map((finding) => finding.code);
      expect(codesForOrphan).toEqual(['RECON_ORPHAN_CANCEL_AMBIGUOUS']);
      expect(outcome.result.status).toBe('MANUAL_REVIEW_REQUIRED');
    }
    expect(port.attempts).toHaveLength(1);
  });

  it('venue visibility disappearing does not break the dedup or weaken the sticky finding', async () => {
    const port = new FakeOrphanCancellation({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const { service, provider } = buildService({ evidence: orphanEvidence, orphanCancellation: port, orphanEnabled: true });

    const first = await service.reconcileAccount(ACCOUNT);
    if (first.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(first.result.findings.map((f) => f.code)).toContain('RECON_ORPHAN_CANCEL_AMBIGUOUS');

    // The venue stops returning the order at all. `detectOrphanVenueOrders`
    // would not raise ANY finding for it now (it is not even in evidence) —
    // so this specifically exercises that the sticky reassertion
    // (`#recoverOrphanCancelClaims`) is what keeps the account blocked, and
    // that it still reports as exactly one finding.
    provider.setEvidence(evidenceSet());
    const second = await service.reconcileAccount(ACCOUNT);
    if (second.kind !== 'COMPLETED') throw new Error('expected completion');
    const codesForOrphan = second.result.findings
      .filter((finding) => finding.subject.exchangeOrderId === 'stranger-1')
      .map((finding) => finding.code);
    expect(codesForOrphan).toEqual(['RECON_ORPHAN_CANCEL_AMBIGUOUS']);
    expect(second.result.status).toBe('MANUAL_REVIEW_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// [Wave C1 / F18-06] Durable orphan cancellation ambiguity resolution: an
// explicit, audited operator decision is the ONLY way a `CANCEL_AMBIGUOUS`
// orphan ever stops blocking. Never inferred from venue absence, a restart,
// or a generation change (those are exactly what F18-25's stickiness already
// refuses to treat as resolution).
// ---------------------------------------------------------------------------

describe('P18 Wave C1 §F18-06 durable orphan ambiguity resolution', () => {
  const orphanEvidence = evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'stranger-1' })] });

  async function driveToAmbiguous() {
    const port = new FakeOrphanCancellation({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const { service, reconciliation, provider } = buildService({ evidence: orphanEvidence, orphanCancellation: port, orphanEnabled: true });
    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED' || outcome.result.status !== 'MANUAL_REVIEW_REQUIRED') {
      throw new Error('expected the account to reach MANUAL_REVIEW_REQUIRED with an ambiguous orphan cancel');
    }
    const [orphan] = await reconciliation.loadOrphanOrders(ACCOUNT);
    if (orphan === undefined || orphan.cancelState !== 'CANCEL_AMBIGUOUS') throw new Error('expected a durably CANCEL_AMBIGUOUS orphan');
    return { service, reconciliation, port, provider, orphan };
  }

  it('a resolved ambiguity stops being reasserted, and the account can reach HEALTHY again once no other fault exists', async () => {
    const { service, reconciliation, port, provider, orphan } = await driveToAmbiguous();

    const request = mintOrphanAmbiguityResolutionRequest({
      accountId: ACCOUNT, exchangeOrderId: orphan.exchangeOrderId, expectedRevision: orphan.revision,
      outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:jane',
    });
    const { resolution, orphan: resolved } = await reconciliation.resolveOrphanCancelAmbiguity(request, 5_000);
    expect(resolved.cancelState).toBe('CANCEL_AMBIGUOUS_RESOLVED');
    expect(resolution.outcome).toBe('ACKNOWLEDGED_NO_RETRY');
    expect(resolution.resolvedBy).toBe('ops:jane');
    // The original ambiguity stays auditable: the resolution names the exact
    // attempt it answers for.
    expect(resolution.resolvedCancelGeneration).toBe(orphan.cancelGeneration);
    expect(resolution.resolvedOrphanRevision).toBe(orphan.revision);

    // Venue no longer returns the order at all — the next generation must
    // NOT reassert the old sticky finding, and with nothing else blocking,
    // the account reaches HEALTHY.
    provider.setEvidence(evidenceSet());
    const outcome2 = await service.reconcileAccount(ACCOUNT);
    if (outcome2.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome2.result.findings.map((f) => f.code)).not.toContain('RECON_ORPHAN_CANCEL_AMBIGUOUS');
    expect(outcome2.result.status).toBe('HEALTHY');
    expect(port.attempts).toHaveLength(1); // never resent
  });

  it('never fabricates a specific venue outcome for ACKNOWLEDGED_NO_RETRY: the durable record states only that retry is refused', async () => {
    const { reconciliation, orphan } = await driveToAmbiguous();
    const request = mintOrphanAmbiguityResolutionRequest({
      accountId: ACCOUNT, exchangeOrderId: orphan.exchangeOrderId, expectedRevision: orphan.revision,
      outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:jane',
    });
    const { resolution } = await reconciliation.resolveOrphanCancelAmbiguity(request, 5_000);
    expect(resolution.outcome).toBe('ACKNOWLEDGED_NO_RETRY');
    expect(resolution.outcome).not.toBe('CONFIRMED_CANCELLED');
  });

  it('reasserts for one orphan but not another: resolution never bleeds across exchange order ids', async () => {
    const port = new FakeOrphanCancellation({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const { service, reconciliation } = buildService({
      evidence: evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'stranger-1' }), venueOrder({ exchangeOrderId: 'stranger-2' })] }),
      orphanCancellation: port,
      orphanEnabled: true,
    });
    await service.reconcileAccount(ACCOUNT);
    const orphans = await reconciliation.loadOrphanOrders(ACCOUNT);
    const strangerOne = orphans.find((o) => o.exchangeOrderId === 'stranger-1');
    const strangerTwo = orphans.find((o) => o.exchangeOrderId === 'stranger-2');
    if (strangerOne === undefined || strangerTwo === undefined) throw new Error('expected both orphans');
    expect(strangerOne.cancelState).toBe('CANCEL_AMBIGUOUS');
    expect(strangerTwo.cancelState).toBe('CANCEL_AMBIGUOUS');

    const request = mintOrphanAmbiguityResolutionRequest({
      accountId: ACCOUNT, exchangeOrderId: 'stranger-1', expectedRevision: strangerOne.revision,
      outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:jane',
    });
    await reconciliation.resolveOrphanCancelAmbiguity(request, 5_000);

    const after = await reconciliation.loadOrphanOrders(ACCOUNT);
    const afterOne = after.find((o) => o.exchangeOrderId === 'stranger-1');
    const afterTwo = after.find((o) => o.exchangeOrderId === 'stranger-2');
    expect(afterOne?.cancelState).toBe('CANCEL_AMBIGUOUS_RESOLVED');
    // stranger-2 is completely untouched.
    expect(afterTwo?.cancelState).toBe('CANCEL_AMBIGUOUS');
    expect(afterTwo?.revision).toBe(strangerTwo.revision);
  });

  it('refuses a stale-revision resolution attempt with zero mutation', async () => {
    const { reconciliation, orphan } = await driveToAmbiguous();
    const staleRequest = mintOrphanAmbiguityResolutionRequest({
      accountId: ACCOUNT, exchangeOrderId: orphan.exchangeOrderId, expectedRevision: orphan.revision - 1,
      outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:jane',
    });
    await expect(reconciliation.resolveOrphanCancelAmbiguity(staleRequest, 5_000)).rejects.toThrow(/LIVE_ORPHAN_RESOLUTION_STALE_REVISION/);
    const [after] = await reconciliation.loadOrphanOrders(ACCOUNT);
    expect(after?.cancelState).toBe('CANCEL_AMBIGUOUS');
    expect(after?.revision).toBe(orphan.revision);
  });

  it('refuses to resolve an orphan that is not currently CANCEL_AMBIGUOUS', async () => {
    const { service, reconciliation } = buildService({ evidence: orphanEvidence, orphanEnabled: false });
    await service.reconcileAccount(ACCOUNT);
    const [orphan] = await reconciliation.loadOrphanOrders(ACCOUNT);
    expect(orphan?.cancelState).toBe('NONE');
    const request = mintOrphanAmbiguityResolutionRequest({
      accountId: ACCOUNT, exchangeOrderId: orphan!.exchangeOrderId, expectedRevision: orphan!.revision,
      outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:jane',
    });
    await expect(reconciliation.resolveOrphanCancelAmbiguity(request, 5_000)).rejects.toThrow(/LIVE_ORPHAN_RESOLUTION_NOT_AMBIGUOUS/);
  });

  it('refuses a second resolution for the exact same already-resolved cancellation attempt', async () => {
    const { reconciliation, orphan } = await driveToAmbiguous();
    const request = mintOrphanAmbiguityResolutionRequest({
      accountId: ACCOUNT, exchangeOrderId: orphan.exchangeOrderId, expectedRevision: orphan.revision,
      outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:jane',
    });
    await reconciliation.resolveOrphanCancelAmbiguity(request, 5_000);
    // A caller retrying with a freshly-minted request against the CURRENT
    // (post-resolution) revision hits the not-ambiguous refusal, because the
    // state itself has already moved off CANCEL_AMBIGUOUS.
    const [after] = await reconciliation.loadOrphanOrders(ACCOUNT);
    const replay = mintOrphanAmbiguityResolutionRequest({
      accountId: ACCOUNT, exchangeOrderId: orphan.exchangeOrderId, expectedRevision: after!.revision,
      outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:jane',
    });
    await expect(reconciliation.resolveOrphanCancelAmbiguity(replay, 6_000)).rejects.toThrow(/LIVE_ORPHAN_RESOLUTION_NOT_AMBIGUOUS/);
  });

  it('does not auto-cancel or auto-claim after resolution: the resolved state is never eligible for a fresh cancellation claim', async () => {
    const { service, reconciliation, port, provider, orphan } = await driveToAmbiguous();
    const request = mintOrphanAmbiguityResolutionRequest({
      accountId: ACCOUNT, exchangeOrderId: orphan.exchangeOrderId, expectedRevision: orphan.revision,
      outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:jane',
    });
    await reconciliation.resolveOrphanCancelAmbiguity(request, 5_000);

    // The SAME order is still visible at the venue (unlike the HEALTHY test
    // above). If resolution were modeled as cancelState = NONE, this would
    // silently re-arm automatic cancellation — exactly the trap §18 warns
    // against.
    provider.setEvidence(orphanEvidence);
    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(port.attempts).toHaveLength(1); // never resent
    const [after] = await reconciliation.loadOrphanOrders(ACCOUNT);
    expect(after?.cancelState).toBe('CANCEL_AMBIGUOUS_RESOLVED'); // never reverted to NONE
  });

  it('[§17] a reappeared, previously-resolved orphan raises the stronger RECON_ORPHAN_REAPPEARED_AFTER_RESOLUTION finding, never the generic one, and blocks', async () => {
    const { service, reconciliation, provider, orphan } = await driveToAmbiguous();
    const request = mintOrphanAmbiguityResolutionRequest({
      accountId: ACCOUNT, exchangeOrderId: orphan.exchangeOrderId, expectedRevision: orphan.revision,
      outcome: 'ACKNOWLEDGED_NO_RETRY', resolvedBy: 'ops:jane',
    });
    await reconciliation.resolveOrphanCancelAmbiguity(request, 5_000);

    // Confirm the resolved account genuinely reaches HEALTHY once the venue
    // stops returning the order, exactly like the primary test above —
    // establishing the baseline this test's reappearance is a DEPARTURE from.
    provider.setEvidence(evidenceSet());
    const healthy = await service.reconcileAccount(ACCOUNT);
    if (healthy.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(healthy.result.status).toBe('HEALTHY');

    // The exact same exchange order id is active at the venue again.
    provider.setEvidence(orphanEvidence);
    const reappeared = await service.reconcileAccount(ACCOUNT);
    if (reappeared.kind !== 'COMPLETED') throw new Error('expected completion');
    const codesForOrphan = reappeared.result.findings
      .filter((f) => f.subject.exchangeOrderId === orphan.exchangeOrderId)
      .map((f) => f.code);
    expect(codesForOrphan).toEqual(['RECON_ORPHAN_REAPPEARED_AFTER_RESOLUTION']);
    expect(reappeared.result.status).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('a brand-new orphan with no prior resolution reappearing is unaffected: ordinary RECON_ORPHAN_VENUE_ORDER handling still applies', async () => {
    // Negative control for the §17 test above: an orphan that was NEVER
    // resolved must never receive the stronger reappearance finding.
    const { service } = buildService({ evidence: orphanEvidence, orphanEnabled: false });
    const first = await service.reconcileAccount(ACCOUNT);
    if (first.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(first.result.findings.map((f) => f.code)).toContain('RECON_ORPHAN_CLEANUP_DISABLED');
    const codesForOrphan = first.result.findings
      .filter((f) => f.subject.exchangeOrderId === 'stranger-1')
      .map((f) => f.code);
    expect(codesForOrphan).not.toContain('RECON_ORPHAN_REAPPEARED_AFTER_RESOLUTION');
  });
});

describe('P18 §13/§14 unusable evidence never yields a healthy account', () => {
  it('blocks when the order read could not prove completeness', async () => {
    const { service } = buildService({
      evidence: evidenceSet({ ordersProvenance: provenance({ complete: false, incompleteReason: 'ORDER_PAGINATION_LIMIT_BUY' }) }),
    });
    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome.result.status).toBe('MANUAL_REVIEW_REQUIRED');
    expect(outcome.result.findings.map((finding) => finding.code)).toContain('RECON_EVIDENCE_INCOMPLETE');
  });

  it('blocks when the two read windows overlap, disclosing the TOCTOU limit', async () => {
    const { service } = buildService({
      evidence: evidenceSet({
        positionsProvenance: provenance({
          source: 'COINDCX_FUTURES_POSITIONS', localReadStartedAtMs: 1_000_100, localReadEndedAtMs: 1_000_900,
        }),
      }),
    });
    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome.result.findings.map((finding) => finding.code)).toContain('RECON_EVIDENCE_CAUSALITY_VIOLATION');
    expect(outcome.result.status).not.toBe('HEALTHY');
  });

  it('blocks on structurally invalid evidence rather than throwing past the barrier', async () => {
    const { service, reconciliation } = buildService({
      evidence: evidenceSet({ orders: [venueOrder({ orderedQuantity: '0.5', remainingQuantity: '0.4', cancelledQuantity: '0.4' })] }),
    });
    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome.result.status).not.toBe('HEALTHY');
    expect((await reconciliation.loadState(ACCOUNT)).status).not.toBe('HEALTHY');
  });
});

describe('P18 §4 generation fencing at the service level', () => {
  it('reports NOT_OWNER and performs no repair when another worker holds the generation', async () => {
    const reconciliation = new InMemoryReconciliationRepository();
    const execution = new InMemoryLiveExecutionRepository();
    const provider = new FakeEvidenceProvider(evidenceSet());
    const make = () => new LiveReconciliationService({
      repository: reconciliation, executionRepository: execution, evidenceProvider: provider,
      runtimeIdentity: newLiveRuntimeIdentity(), credentialAccountId: ACCOUNT, clock: new FixedClock(),
    });

    // Claim generation 1 and leave it RUNNING by not completing it.
    const lost = await reconciliation.claimGeneration(ACCOUNT, 'other-worker', 1);
    expect(lost.kind).toBe('CLAIMED');

    // A second service claims generation 2, fencing the first out.
    const outcome = await make().reconcileAccount(ACCOUNT);
    expect(outcome.kind).toBe('COMPLETED');

    // The stale generation-1 lease can no longer commit anything.
    if (lost.kind !== 'CLAIMED') return;
    await expect(reconciliation.completeRun(lost.lease, 'HEALTHY', 0, 1))
      .rejects.toThrow(/LIVE_RECONCILIATION_STALE_GENERATION/);
  });

  it('withdraws a previous healthy verdict the instant a new generation is claimed', async () => {
    const { service, reconciliation } = buildService();
    await service.reconcileAccount(ACCOUNT);
    expect((await reconciliation.loadState(ACCOUNT)).status).toBe('HEALTHY');

    await reconciliation.claimGeneration(ACCOUNT, EPOCH, 1);
    const state = await reconciliation.loadState(ACCOUNT);
    expect(state.status).toBe('RUNNING');
    expect(state.healthyGeneration).toBeNull();
  });
});
