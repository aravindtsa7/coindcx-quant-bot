/**
 * [Wave B / F18-04] End-to-end proof of the bracketed snapshot-stability
 * protocol at the `LiveReconciliationService` level.
 *
 * CoinDCX exposes no atomic multi-endpoint snapshot. Wave A2's
 * `evidenceWindowIsSeparable` compared only provider EVENT TIMESTAMPS against
 * the two read windows, which is vacuously satisfied by a brand-new order that
 * appears between the orders read and the positions read and never touches the
 * position aggregate — there is no timestamp to compare against, because the
 * order simply is not present in the (single) orders read at all. This file
 * proves the replacement: every reconciliation run reads orders and positions
 * TWICE each, bracketing the other kind of read, and treats ANY disagreement
 * between the two reads of the same kind as an unusable snapshot — never a
 * silent pass.
 *
 * NOTHING HERE TOUCHES COINDCX (§25): every provider is a fake fixture.
 */
import { describe, expect, it } from 'vitest';
import type { LiveExecutionIntentRecord } from '../../../../../src/execution/live/intent';
import { LiveReconciliationService, requireCurrentReconciliation, resolveOrphanCleanupPolicy } from '../../../../../src/execution/live/reconciliation';
import { InMemoryLiveExecutionRepository } from '../helpers';
import { InMemoryReconciliationRepository } from './in-memory-repository';
import {
  EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
  ACCOUNT,
  AlwaysUnstableEvidenceProvider,
  FakeOrphanCancellation,
  FixedClock,
  LatencyAwareEvidenceProvider,
  PAIR,
  RUNTIME_IDENTITY,
  SequencedEvidenceProvider,
  provenance,
  venueOrder,
  venuePosition,
} from './helpers';

function buildService(input: {
  readonly evidenceProvider: ConstructorParameters<typeof LiveReconciliationService>[0]['evidenceProvider'];
  readonly maxSnapshotAttempts?: number;
  readonly orphanCancellation?: FakeOrphanCancellation;
}) {
  const reconciliation = new InMemoryReconciliationRepository();
  const execution = new InMemoryLiveExecutionRepository();
  const resolution = resolveOrphanCleanupPolicy({
    LIVE_ORPHAN_CANCELLATION_ENABLED: input.orphanCancellation !== undefined ? 'true' : 'false',
    LIVE_ORPHAN_CANCELLATION_ACCOUNT_ALLOWLIST: ACCOUNT,
  });
  const service = new LiveReconciliationService({
    repository: reconciliation,
    executionRepository: execution,
    evidenceProvider: input.evidenceProvider,
    runtimeIdentity: RUNTIME_IDENTITY,
    credentialAccountId: ACCOUNT, expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
    clock: new FixedClock(),
    maxSnapshotAttempts: input.maxSnapshotAttempts,
    ...(resolution.status === 'ENABLED' && input.orphanCancellation !== undefined
      ? { orphanPolicy: resolution.policy, orphanCancellation: input.orphanCancellation }
      : {}),
  });
  return { service, reconciliation, execution };
}

const ORDERS_PROVENANCE = provenance({ source: 'COINDCX_FUTURES_ORDERS' });
const POSITIONS_PROVENANCE = provenance({ source: 'COINDCX_FUTURES_POSITIONS', localReadStartedAtMs: 1_000_500, localReadEndedAtMs: 1_000_900 });

describe('P18 Wave B3 §F18-23 real network latency must never produce a false RECON_EVIDENCE_CAUSALITY_VIOLATION', () => {
  // Confirmed exploit: the four bracketed reads (`ordersA -> positionsA ->
  // ordersB -> positionsB`) interleave, so the MERGED whole-bracket
  // provenance windows (`evidence.ordersProvenance`/`evidence.positionsProvenance`)
  // overlap by construction under ANY real latency between calls —
  // `evidenceWindowIsSeparable` fed those merged windows reported a clean,
  // stable, fully-flat account as non-separable on essentially every real
  // call. `FixedClock`'s default (frozen, never advancing) masked this in
  // every prior test, since every read stamped the identical instant.
  it('a clean, stable, fully-flat account is not falsely blocked despite 40ms of latency on every one of the four provider calls', async () => {
    const clock = new FixedClock(1_000_000);
    const provider = new LatencyAwareEvidenceProvider({
      clock, latencyMs: 40, orders: [], positions: [],
    });
    const reconciliation = new InMemoryReconciliationRepository();
    const execution = new InMemoryLiveExecutionRepository();
    const service = new LiveReconciliationService({
      repository: reconciliation,
      executionRepository: execution,
      evidenceProvider: provider,
      runtimeIdentity: RUNTIME_IDENTITY,
      credentialAccountId: ACCOUNT, expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
      clock: new FixedClock(),
    });

    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');

    expect(outcome.result.findings.map((finding) => finding.code)).not.toContain('RECON_EVIDENCE_CAUSALITY_VIOLATION');
    expect(outcome.result.status).toBe('HEALTHY');
    // Exactly one bracket: stable on the first attempt (fixed content), 4 real
    // reads, confirming the latency was genuinely applied on every one of them.
    expect(provider.orderCalls).toBe(2);
    expect(provider.positionCalls).toBe(2);
    expect(clock.nowMs()).toBe(1_000_000 + 40 * 4);
  });

  it('a genuinely late-arriving position observation (postdating the orders boundary) still fails closed, even under the corrected check', async () => {
    const clock = new FixedClock(2_000_000);
    // With latencyMs=40 starting at 2_000_000: ordersA [2000000,2000040],
    // positionsA [2000040,2000080], ordersB [2000080,2000120], positionsB
    // [2000120,2000160]. `finalOrdersProvenance` (ordersB) ends at 2000120 —
    // a position observation timed AFTER that boundary genuinely means the
    // venue moved between the final orders read and the final positions
    // read, which the corrected check must still refuse.
    const latePosition = venuePosition({ signedQuantity: '0.5', providerEventTimeMs: 2_000_121 });
    const provider = new LatencyAwareEvidenceProvider({
      clock, latencyMs: 40, orders: [], positions: [latePosition],
    });
    const service = new LiveReconciliationService({
      repository: new InMemoryReconciliationRepository(),
      executionRepository: new InMemoryLiveExecutionRepository(),
      evidenceProvider: provider,
      runtimeIdentity: RUNTIME_IDENTITY,
      credentialAccountId: ACCOUNT, expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
      clock: new FixedClock(),
    });

    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');

    expect(outcome.result.findings.map((finding) => finding.code)).toContain('RECON_EVIDENCE_CAUSALITY_VIOLATION');
    expect(outcome.result.status).not.toBe('HEALTHY');
  });

  it('a position observation exactly AT the boundary (not after it) remains separable — the check is not off-by-one', async () => {
    const clock = new FixedClock(3_000_000);
    // ordersB ends at 3_000_120 (same arithmetic as above). A position
    // observation timed EXACTLY at that boundary predates or coincides with
    // it and must be accepted (`<=`, not `<`).
    const onBoundary = venuePosition({ signedQuantity: '0.5', providerEventTimeMs: 3_000_120 });
    const provider = new LatencyAwareEvidenceProvider({
      clock, latencyMs: 40, orders: [], positions: [onBoundary],
    });
    const service = new LiveReconciliationService({
      repository: new InMemoryReconciliationRepository(),
      executionRepository: new InMemoryLiveExecutionRepository(),
      evidenceProvider: provider,
      runtimeIdentity: RUNTIME_IDENTITY,
      credentialAccountId: ACCOUNT, expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
      clock: new FixedClock(),
    });

    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome.result.findings.map((finding) => finding.code)).not.toContain('RECON_EVIDENCE_CAUSALITY_VIOLATION');
  });

  it('scales to larger realistic latency (250ms) without false-blocking', async () => {
    const clock = new FixedClock(4_000_000);
    const provider = new LatencyAwareEvidenceProvider({
      clock, latencyMs: 250, orders: [], positions: [],
    });
    const service = new LiveReconciliationService({
      repository: new InMemoryReconciliationRepository(),
      executionRepository: new InMemoryLiveExecutionRepository(),
      evidenceProvider: provider,
      runtimeIdentity: RUNTIME_IDENTITY,
      credentialAccountId: ACCOUNT, expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
      clock: new FixedClock(),
    });

    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome.result.status).toBe('HEALTHY');
    expect(outcome.result.findings.map((finding) => finding.code)).not.toContain('RECON_EVIDENCE_CAUSALITY_VIOLATION');
  });
});

describe('P18 Wave B §F18-04 sustained instability blocks the account and applies zero economic effects', () => {
  it('a perpetually-mutating order set never reaches HEALTHY, exhausts exactly the configured budget, and records only the instability finding', async () => {
    const port = new FakeOrphanCancellation({ kind: 'CANCELLED' });
    const provider = new AlwaysUnstableEvidenceProvider({
      orders: [], ordersProvenance: ORDERS_PROVENANCE,
      positions: [], positionsProvenance: POSITIONS_PROVENANCE,
      unstableOrders: true,
    });
    const { service, reconciliation } = buildService({ evidenceProvider: provider, maxSnapshotAttempts: 2, orphanCancellation: port });

    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');

    expect(outcome.result.status).not.toBe('HEALTHY');
    expect(outcome.result.status).toBe('MANUAL_REVIEW_REQUIRED');
    expect(outcome.result.findings.map((finding) => finding.code)).toEqual(['RECON_EVIDENCE_SNAPSHOT_UNSTABLE']);

    // Exactly the bounded budget: 2 attempts * 2 order reads (A and B) per
    // attempt. Never unbounded, never silently fewer.
    expect(provider.orderCalls).toBe(4);
    expect(provider.positionCalls).toBe(4);

    // Zero provisional economic effects of ANY kind (§5): no orphan even
    // recorded, let alone claimed or cancelled.
    expect(await reconciliation.loadOrphanOrders(ACCOUNT)).toEqual([]);
    expect(port.attempts).toEqual([]);

    const state = await reconciliation.loadState(ACCOUNT);
    expect(state.status).not.toBe('HEALTHY');
  });

  it('a perpetually-mutating position quantity is equally caught, even when the order set never moves', async () => {
    const provider = new AlwaysUnstableEvidenceProvider({
      orders: [], ordersProvenance: ORDERS_PROVENANCE,
      positions: [venuePosition({ signedQuantity: '0.5' })], positionsProvenance: POSITIONS_PROVENANCE,
      unstablePositions: true,
    });
    const { service } = buildService({ evidenceProvider: provider, maxSnapshotAttempts: 2 });

    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');

    expect(outcome.result.status).not.toBe('HEALTHY');
    expect(outcome.result.findings.map((finding) => finding.code)).toEqual(['RECON_EVIDENCE_SNAPSHOT_UNSTABLE']);
  });

  it('exhaustion is never mistaken for proof that nothing moved: the same unstable provider blocks on every independent run', async () => {
    const provider = new AlwaysUnstableEvidenceProvider({
      orders: [], ordersProvenance: ORDERS_PROVENANCE,
      positions: [], positionsProvenance: POSITIONS_PROVENANCE,
      unstableOrders: true,
    });
    const { service } = buildService({ evidenceProvider: provider, maxSnapshotAttempts: 1 });

    for (let run = 0; run < 3; run += 1) {
      const outcome = await service.reconcileAccount(ACCOUNT);
      expect(outcome.kind === 'COMPLETED' && outcome.result.status).not.toBe('HEALTHY');
    }
  });
});

describe('P18 Wave B §F18-04 a transient blip that self-heals within the retry budget recovers safely', () => {
  it('the SECOND bracket stabilizing lets reconciliation proceed with the now-accurate evidence', async () => {
    const newOrder = venueOrder({ exchangeOrderId: 'appeared-mid-run', venueStatus: 'open' });
    const provider = new SequencedEvidenceProvider({
      // Attempt 1: A sees nothing, B sees the new order -> unstable.
      // Attempt 2: A and B both see the (now genuinely present) order -> stable.
      orders: [[], [newOrder], [newOrder], [newOrder]],
      ordersProvenance: [ORDERS_PROVENANCE],
      positions: [[]],
      positionsProvenance: [POSITIONS_PROVENANCE],
    });
    const { service, reconciliation } = buildService({ evidenceProvider: provider, maxSnapshotAttempts: 3 });

    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');

    // Recovered within budget: exactly 2 attempts (4 order reads), not all 3.
    expect(provider.orderCalls).toBe(4);
    expect(outcome.result.findings.map((finding) => finding.code)).not.toContain('RECON_EVIDENCE_SNAPSHOT_UNSTABLE');

    // Reconciliation genuinely proceeded on the stabilized evidence: the new
    // order is unclaimed by any local order, so it is detected as an orphan —
    // proof this is the ordinary post-stability path, not a stale/incomplete one.
    const orphans = await reconciliation.loadOrphanOrders(ACCOUNT);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.exchangeOrderId).toBe('appeared-mid-run');
    expect(orphans[0]?.pair).toBe(PAIR);
  });
});

describe('P18 Wave B §F18-04 stability is content-based, never sensitive to read/page ordering', () => {
  it('the same records returned in a different array order across the bracket are treated as stable', async () => {
    const one = venueOrder({ exchangeOrderId: 'a' });
    const two = venueOrder({ exchangeOrderId: 'b' });
    const provider = new SequencedEvidenceProvider({
      orders: [[one, two], [two, one]],
      ordersProvenance: [ORDERS_PROVENANCE],
      positions: [[]],
      positionsProvenance: [POSITIONS_PROVENANCE],
    });
    const { service } = buildService({ evidenceProvider: provider, maxSnapshotAttempts: 3 });

    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');

    // Stabilized on the FIRST attempt: exactly 2 order reads (A and B), not more.
    expect(provider.orderCalls).toBe(2);
    expect(outcome.result.findings.map((finding) => finding.code)).not.toContain('RECON_EVIDENCE_SNAPSHOT_UNSTABLE');
  });
});

describe('P18 Wave B2 §F18-04 ABA: what the bracketed check genuinely cannot see, and why that stays safe', () => {
  it('[ABA order] a transient order that fully reverts within the bracket is undetectable — and produces zero wrong effect, only a missed one', async () => {
    // The order appears and disappears entirely BETWEEN ordersA and ordersB;
    // neither read ever captures it. ordersA == ordersB == [] is genuinely,
    // correctly equal by content — this is NOT a bug in the comparison, it is
    // the documented structural limit of polling a venue with no continuity
    // mechanism (§F18-04 correction).
    const provider = new SequencedEvidenceProvider({
      orders: [[], []],
      ordersProvenance: [provenance({ source: 'COINDCX_FUTURES_ORDERS' })],
      positions: [[]],
      positionsProvenance: [provenance({ source: 'COINDCX_FUTURES_POSITIONS', localReadStartedAtMs: 2_000, localReadEndedAtMs: 2_100 })],
    });
    const { service, reconciliation } = buildService({ evidenceProvider: provider, maxSnapshotAttempts: 3 });

    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');

    // Stabilizes immediately (both reads genuinely agree) and, because
    // nothing in the FINAL evidence contradicts a flat account, reaches
    // HEALTHY. The transient order is not merely missed from a finding — it
    // never enters the evidence set at all, so there is nothing for any
    // economic-effect code path to act on, correctly or incorrectly.
    expect(outcome.result.status).toBe('HEALTHY');
    expect(provider.orderCalls).toBe(2);
    expect(await reconciliation.loadOrphanOrders(ACCOUNT)).toEqual([]);
  });

  it('[ABA position] a transient position that fully reverts within the bracket is equally undetectable, and materializes no ownership', async () => {
    const provider = new SequencedEvidenceProvider({
      orders: [[]],
      ordersProvenance: [provenance({ source: 'COINDCX_FUTURES_ORDERS' })],
      // The position opens and closes entirely between positionsA and
      // positionsB; both reads see flat. Genuinely, correctly equal content.
      positions: [[], []],
      positionsProvenance: [provenance({ source: 'COINDCX_FUTURES_POSITIONS', localReadStartedAtMs: 2_000, localReadEndedAtMs: 2_100 })],
    });
    const { service, reconciliation } = buildService({ evidenceProvider: provider, maxSnapshotAttempts: 3 });

    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');

    expect(outcome.result.status).toBe('HEALTHY');
    expect(provider.positionCalls).toBe(2);
    // No ownership share was fabricated for exposure this run never observed.
    expect(await reconciliation.loadOwnershipShares(ACCOUNT, PAIR)).toEqual([]);
  });

  it('[cross-endpoint asymmetry] a new order/fill landing strictly between ordersB and positionsB is caught by the POSITION bracket, never silently treated as one atomic snapshot', async () => {
    // orders stabilizes immediately on an untouched resting order (ordersA ==
    // ordersB): if the protocol used ONLY the orders bracket, this would look
    // "safe" after one attempt. But an untracked fill lands after ordersB was
    // already captured and before positionsB is captured, moving the venue
    // position — positionsA != positionsB catches exactly what an
    // orders-only check would miss.
    const resting = venueOrder({ exchangeOrderId: 'resting-1', venueStatus: 'open' });
    const provider = new SequencedEvidenceProvider({
      orders: [[resting], [resting]],
      ordersProvenance: [provenance({ source: 'COINDCX_FUTURES_ORDERS' })],
      positions: [[], [venuePosition({ signedQuantity: '0.3' })]],
      positionsProvenance: [provenance({ source: 'COINDCX_FUTURES_POSITIONS', localReadStartedAtMs: 2_000, localReadEndedAtMs: 2_100 })],
    });
    // Exactly one attempt: proves the FIRST bracket alone already refuses to
    // treat `ordersA == ordersB` as sufficient on its own — the account must
    // not be declared HEALTHY (or anything else) from an asymmetric pair.
    const { service } = buildService({ evidenceProvider: provider, maxSnapshotAttempts: 1 });

    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');

    expect(outcome.result.status).not.toBe('HEALTHY');
    expect(outcome.result.findings.map((finding) => finding.code)).toEqual(['RECON_EVIDENCE_SNAPSHOT_UNSTABLE']);
  });

  it('repeated equal reads remain insufficient for a conclusion requiring full historical continuity: HEALTHY never claims more than current-state reconciliation', async () => {
    // A clean, fully-stable, fully-reconciled account reaches HEALTHY. This
    // test exists to anchor the documentation claim: HEALTHY here means "the
    // twice-confirmed current venue state reconciles exactly against durable
    // local records", not "no venue activity has ever gone unobserved". The
    // two ABA tests above are the actual proof of that distinction; this test
    // just confirms the ordinary stable path still reaches HEALTHY at all.
    const provider = new SequencedEvidenceProvider({
      orders: [[]],
      ordersProvenance: [ORDERS_PROVENANCE],
      positions: [[]],
      positionsProvenance: [POSITIONS_PROVENANCE],
    });
    const { service } = buildService({ evidenceProvider: provider });
    const outcome = await service.reconcileAccount(ACCOUNT);
    expect(outcome.kind === 'COMPLETED' && outcome.result.status).toBe('HEALTHY');
  });
});

describe('P18 Wave B §F18-04 maxSnapshotAttempts is validated, not caller-trusted', () => {
  function serviceWith(maxSnapshotAttempts: number) {
    const provider = new AlwaysUnstableEvidenceProvider({
      orders: [], ordersProvenance: ORDERS_PROVENANCE, positions: [], positionsProvenance: POSITIONS_PROVENANCE,
    });
    return () => new LiveReconciliationService({
      repository: new InMemoryReconciliationRepository(),
      executionRepository: new InMemoryLiveExecutionRepository(),
      evidenceProvider: provider,
      runtimeIdentity: RUNTIME_IDENTITY,
      credentialAccountId: ACCOUNT, expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
      clock: new FixedClock(),
      maxSnapshotAttempts,
    });
  }

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, 11, 1_000_000])(
    'refuses an unsafe or out-of-range value at construction time (%s)',
    (value) => {
      expect(serviceWith(value)).toThrow(/LIVE_RECONCILIATION_EVIDENCE_INVALID/);
    },
  );

  it('accepts the implementation-owned ceiling and every safe value below it', () => {
    expect(serviceWith(10)).not.toThrow();
    expect(serviceWith(1)).not.toThrow();
  });
});

describe('P18 Wave B3 §F18-04 CURRENT-STATE reconciliation (Option B): history-sensitive durable state remains blocked, a clean account may still reach HEALTHY', () => {
  // [Wave B3 / F18-04 closure] A fully-reverted ABA event is structurally
  // undetectable by ANY repeated-REST-read protocol (§6.2 in the docs), and
  // that limitation is accepted, not "solved". The closure question is
  // narrower: CAN a fully-reverted ABA event make HEALTHY unsafe for the
  // operations HEALTHY unlocks (OPEN, CLOSE, cancel, dispatch/cancel arm)?
  //
  // Answer, derived from the actual economic-effect code paths (not asserted):
  // every durable state whose TRUE current progression is genuinely uncertain
  // — SUBMISSION_AMBIGUOUS, an armed-but-unresolved DISPATCH_RESERVED/
  // CANCEL_RESERVED claim, an orphan CANCEL_AMBIGUOUS, a position ownership
  // conflict, an economics conflict — ALREADY, independently, produces its
  // own blocking finding through the ordinary per-order/per-position
  // reconciliation pass (`reconcileIdentifiedOrder`, `resolveAmbiguousCreate`,
  // `reconcilePosition`, the orphan-claim recovery path). There is no
  // SEPARATE gate to add: the existing finding-based architecture already IS
  // the history-sensitive predicate, because it is derived from durable facts
  // (order state, cancel state, wire-armed flags, orphan cancel state) rather
  // than a manually-maintained flag. An account with NONE of that state has
  // nothing for an unobserved-and-reverted transient to have corrupted: no
  // order lineage depends on it, no ownership claim depends on it, and no
  // outstanding local reservation could have silently become a wire
  // request. For such an account, current-state-only reconciliation (orders
  // + positions, twice-confirmed) is sufficient, and the proof is exactly
  // that there is nothing left un-checked.
  //
  // These two tests hold the FINAL REST-visible state IDENTICAL — both
  // present the exact same clean, empty, twice-confirmed endpoint pattern —
  // and vary ONLY the local durable state, to isolate that this is what
  // actually decides HEALTHY, not anything the REST protocol could detect.

  function intentRecord(): LiveExecutionIntentRecord {
    return {
      intentId: 'i'.repeat(64),
      clientOrderId: `p17-${'a'.repeat(32)}`,
      wireOrderType: 'limit_order',
      quantityAdjusted: false,
      priceAdjusted: false,
      content: {
        accountId: ACCOUNT,
        pair: PAIR,
        side: 'BUY',
        action: 'OPEN',
        quantity: '0.5',
        orderType: 'LIMIT',
        price: '64000.5',
        timeInForce: 'UNSPECIFIED',
        leverage: '5',
        riskDecisionId: 'risk-1',
        admissionId: 'admission-1',
        strategyInstanceId: 'instance-1',
        strategyId: 'EMA_TREND',
        strategyVersion: '1.0.0',
        parameterHash: 'p'.repeat(64),
        liveExecutionPolicyId: 'policy-1',
        instrumentSpecSnapshotId: 'spec-1',
        authorizedNotionalInr: '2560020',
        settlementRateInrPerQuote: '80',
        positionInstanceId: null,
        positionRevision: null,
        reduceOnlyQuantity: null,
      },
      lineage: {
        researchApproval: {
          validationSubjectId: 'subject-1',
          validationPlanId: 'plan-1',
          validationSubjectResultSha256: 'r'.repeat(64),
        },
        sourceStrategyDecisionId: 'decision-1',
      },
    };
  }

  /** The exact same ABA-visible endpoint pattern both tests below share. */
  function abaCleanEndpointProvider(): SequencedEvidenceProvider {
    return new SequencedEvidenceProvider({
      // A: nothing. [unobservable transient venue activity occurs and fully
      // reverts]. B: nothing. Genuinely, correctly equal — this IS the ABA
      // blind spot (§6.2), not a detection of it.
      orders: [[], []],
      ordersProvenance: [ORDERS_PROVENANCE],
      positions: [[], []],
      positionsProvenance: [POSITIONS_PROVENANCE],
    });
  }

  it('[ABA clean-account] zero history-sensitive local state: current-state-only reconciliation reaches HEALTHY', async () => {
    const provider = abaCleanEndpointProvider();
    const { service } = buildService({ evidenceProvider: provider, maxSnapshotAttempts: 3 });

    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');

    // The protocol did NOT detect the transient — it cannot. It correctly
    // reports stable (both reads agree) and, because nothing locally durable
    // depends on unproven history, HEALTHY is safe to grant.
    expect(outcome.result.status).toBe('HEALTHY');
  });

  it('[ABA history-sensitive account] an unresolved local ambiguous create blocks HEALTHY even though the final REST-visible state is IDENTICAL to the clean case', async () => {
    const provider = abaCleanEndpointProvider();
    const reconciliation = new InMemoryReconciliationRepository();
    const execution = new InMemoryLiveExecutionRepository();

    // History-sensitive durable state: a create whose true venue outcome is
    // genuinely unknown. Reached through the SAME public repository API
    // Phase17 itself uses (ensureIntent -> claimDispatch -> expire), not by
    // hand-constructing a row — this is a real, reachable durable state.
    const intent = intentRecord();
    await execution.ensureIntent(intent);
    const claim = await execution.claimDispatch(intent.intentId, async () => true);
    if (claim.kind !== 'CLAIMED') throw new Error('expected claim');
    await execution.markExpiredDispatchUnresolved(intent.intentId, ACCOUNT);

    const service = new LiveReconciliationService({
      repository: reconciliation,
      executionRepository: execution,
      evidenceProvider: provider,
      runtimeIdentity: RUNTIME_IDENTITY,
      credentialAccountId: ACCOUNT, expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
      clock: new FixedClock(),
      maxSnapshotAttempts: 3,
    });

    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');

    // Identical endpoint pattern to the clean-account test above; the ONLY
    // difference is local durable state, and that alone is what correctly
    // forbids HEALTHY here.
    expect(outcome.result.status).not.toBe('HEALTHY');
    const order = await execution.load(intent.intentId);
    expect(order?.state).toBe('SUBMISSION_AMBIGUOUS');
    expect(order?.exchangeOrderId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// [Wave B4 / F18-27] The exact confirmed race, end to end: a brand-new active
// venue order appearing strictly after the final ORDERS read this run ever
// takes is structurally invisible to that run — no additional read, however
// placed, closes the window (adding an `ordersC` merely moves the race to
// after `ordersC`). These tests prove the two halves of the required
// behaviour together: (1) reconciliation itself is unaffected by this
// unobservable event and legitimately reports its usual, honest status; (2)
// the SEPARATE `requireCurrentReconciliation` barrier still refuses to
// authorize a mutation from that result, regardless, because REST-only
// evidence can never rule this race out — proving the refusal in
// `evidence-and-barrier.test.ts` (there constructed from a fake repository)
// also holds for a GENUINE, fully-executed reconciliation run.
// ---------------------------------------------------------------------------

describe('P18 Wave B4 §F18-27 a venue order appearing after the final REST read is invisible to reconciliation, and the barrier refuses regardless', () => {
  it('a clean run reaches HEALTHY exactly as it would with no race at all, and the barrier still refuses authorization', async () => {
    // Deliberately IDENTICAL fixture to `abaCleanEndpointProvider` above: an
    // order appearing strictly after `ordersB` leaves NO trace in the
    // evidence this run reads, by construction — there is nothing to
    // construct differently between "clean" and "raced". That is precisely
    // the F18-27 finding, not an oversight in this test.
    const provider = new SequencedEvidenceProvider({
      orders: [[], []],
      ordersProvenance: [ORDERS_PROVENANCE],
      positions: [[], []],
      positionsProvenance: [POSITIONS_PROVENANCE],
    });
    const { service, reconciliation } = buildService({ evidenceProvider: provider, maxSnapshotAttempts: 3 });

    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome.result.status).toBe('HEALTHY');

    // The account-level verdict is honestly HEALTHY (Level 2: REST-observed,
    // no known problem) — reconciliation is not being asked to lie. What
    // must NOT happen is that verdict, by itself, unlocking a live mutation.
    await expect(requireCurrentReconciliation(reconciliation, ACCOUNT, RUNTIME_IDENTITY, 'CREATE'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
  });

  it('the SAME race, only detected by luck one generation later, becomes an ordinary orphan finding — proving the gap is real and only ever closes retroactively, never for the run that missed it', async () => {
    // Generation 1: the order has already appeared on the venue, but this
    // run's bracketed reads simply never observe it (fixed fake evidence: the
    // run cannot "get luckier" than what it was given, exactly like
    // production cannot either). It reconciles HEALTHY, honestly, on
    // evidence that happens to be stale in a way nothing in this run could
    // detect.
    const reconciliation = new InMemoryReconciliationRepository();
    const execution = new InMemoryLiveExecutionRepository();
    const cleanProvider = new SequencedEvidenceProvider({
      orders: [[], []], ordersProvenance: [ORDERS_PROVENANCE], positions: [[], []], positionsProvenance: [POSITIONS_PROVENANCE],
    });
    const first = new LiveReconciliationService({
      repository: reconciliation, executionRepository: execution, evidenceProvider: cleanProvider,
      runtimeIdentity: RUNTIME_IDENTITY, credentialAccountId: ACCOUNT, expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT, clock: new FixedClock(), maxSnapshotAttempts: 3,
    });
    const firstOutcome = await first.reconcileAccount(ACCOUNT);
    if (firstOutcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(firstOutcome.result.status).toBe('HEALTHY');

    // Generation 2: a later reconciliation run's reads finally happen to
    // land after the order exists. It has no local lineage for it (nothing
    // in this test ever dispatched it), so it is correctly detected as an
    // ORPHAN and blocks the account — this is the existing orphan-detection
    // mechanism catching what F18-27 says no read protocol can catch
    // in the moment. It does NOT retroactively make generation 1's HEALTHY
    // verdict, or anything authorized under it, safe.
    const raced = venueOrder({ exchangeOrderId: `late-${ACCOUNT}`, venueStatus: 'open' });
    const laterProvider = new SequencedEvidenceProvider({
      orders: [[raced], [raced]], ordersProvenance: [ORDERS_PROVENANCE], positions: [[], []], positionsProvenance: [POSITIONS_PROVENANCE],
    });
    const second = new LiveReconciliationService({
      repository: reconciliation, executionRepository: execution, evidenceProvider: laterProvider,
      runtimeIdentity: RUNTIME_IDENTITY, credentialAccountId: ACCOUNT, expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT, clock: new FixedClock(), maxSnapshotAttempts: 3,
    });
    const secondOutcome = await second.reconcileAccount(ACCOUNT);
    if (secondOutcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(secondOutcome.result.status).not.toBe('HEALTHY');
    expect(secondOutcome.result.findings.some((finding) => finding.code === 'RECON_ORPHAN_VENUE_ORDER')).toBe(true);
  });
});
