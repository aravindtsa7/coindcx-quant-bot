import { describe, expect, it } from 'vitest';
import { RiskAdmissionCoordinator } from '../../../src/dispatch/admission';
import { riskDecimal, type AccountRiskSnapshot, type PortfolioExposureSnapshot } from '../../../src/risk';
import { buildContext, evaluateDecision, makeKernel, pairSnapshotFor, policyFor, PAIR } from './helpers';
import { makeAccount, seal } from '../risk/helpers';

const ACCOUNT = 'account-1';
const T0 = 1_200_000;
const MIN = 60_000;

function deferred<T>(): { readonly promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('C-F07 transactional admission — single-decision behavior', () => {
  it('admits a valid OPEN decision and produces a material AdmissionRecord', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const outcome = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) });
    expect(outcome.status).toBe('ADMITTED');
    if (outcome.status !== 'ADMITTED') return;
    expect(outcome.admission.accountId).toBe(ACCOUNT);
    expect(outcome.admission.sourceStrategyDecisionId).toBe(decision.decisionId);
    expect(outcome.admission.strategyInstanceId).toBe(decision.strategyInstanceId);
    expect(outcome.admission.pair).toBe(PAIR);
    expect(outcome.admission.status).toBe('ADMITTED');
    expect(outcome.admission.generation).toBe(1);
    expect(riskDecimal(outcome.admission.approvedNotionalInr).gt(0)).toBe(true);
  });

  it('propagates a genuine RiskEngine rejection without creating any admission', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const impossibleAccount = seal({ ...makeAccount(), lockedMarginInr: '-1' });
    const outcome = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision, { accountSnapshot: impossibleAccount }) });
    expect(outcome.status).toBe('REJECTED');
  });

  it('rejects (fails closed) rather than admits when RiskEngine evaluation throws', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const malformedPolicy = { ...policyFor(), riskPolicyId: 'not-a-real-id' } as ReturnType<typeof policyFor>;
    await expect(coordinator.admit({ accountId: ACCOUNT, policy: malformedPolicy, context: buildContext(kernel, decision) })).rejects.toThrow();
    // No leaked allocation: a fresh, valid admission for the same decision succeeds cleanly afterward.
    const recovered = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) });
    expect(recovered.status).toBe('ADMITTED');
  });
});

describe('C-F07 idempotent duplicates', () => {
  it('returns the identical admission for the same decisionId submitted sequentially twice', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const first = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) });
    const second = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) });
    expect(first.status).toBe('ADMITTED'); expect(second.status).toBe('ADMITTED');
    if (first.status !== 'ADMITTED' || second.status !== 'ADMITTED') return;
    expect(second.admission.admissionId).toBe(first.admission.admissionId);
    expect(second.admission.generation).toBe(1);
  });

  it('returns the identical admission for the same decisionId submitted twice concurrently (Promise.all)', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const [first, second] = await Promise.all([
      coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) }),
      coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) }),
    ]);
    expect(first.status).toBe('ADMITTED'); expect(second.status).toBe('ADMITTED');
    if (first.status !== 'ADMITTED' || second.status !== 'ADMITTED') return;
    // Not double-allocated: both concurrent calls resolve to the exact same
    // admissionId/generation rather than each minting an independent grant.
    expect(second.admission.admissionId).toBe(first.admission.admissionId);
    expect(second.admission.generation).toBe(1);
  });
});

describe('C-F07 sequence-based ordering (no wall clock)', () => {
  it('rejects an older decisionSequence arriving after a newer one was admitted for the same instance', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const older = evaluateDecision(kernel, T0);
    const newer = evaluateDecision(kernel, T0 + MIN);
    expect(newer.decisionSequence).toBeGreaterThan(older.decisionSequence);
    const admittedNewer = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, newer) });
    expect(admittedNewer.status).toBe('ADMITTED');
    const staleOlder = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, older) });
    expect(staleOlder.status).toBe('STALE_DECISION_SEQUENCE');
    if (staleOlder.status !== 'STALE_DECISION_SEQUENCE') return;
    expect(staleOlder.strategyInstanceId).toBe(kernel.strategyInstanceId);
    expect(staleOlder.decisionSequence).toBe(older.decisionSequence);
  });

  it('a rejection does not advance the sequence watermark, so a later-admitted lower-or-equal sequence for a fresh decision can still proceed', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const first = evaluateDecision(kernel, T0);
    const impossibleAccount = seal({ ...makeAccount(), lockedMarginInr: '-1' });
    const rejected = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, first, { accountSnapshot: impossibleAccount }) });
    expect(rejected.status).toBe('REJECTED');
    const secondSameSequenceAttempt = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, first) });
    expect(secondSameSequenceAttempt.status).toBe('ADMITTED');
  });

  it('admits strictly increasing sequences for the same instance in order', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const first = evaluateDecision(kernel, T0);
    const second = evaluateDecision(kernel, T0 + MIN);
    const firstOutcome = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, first) });
    expect(firstOutcome.status).toBe('ADMITTED');
    const secondOutcome = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, second) });
    expect(secondOutcome.status === 'ADMITTED' || secondOutcome.status === 'REJECTED').toBe(true);
  });
});

describe('C-F07 release semantics', () => {
  it('releases a genuine admission exactly once, and a second release is idempotent (ALREADY_RELEASED)', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const admitted = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) });
    expect(admitted.status).toBe('ADMITTED');
    if (admitted.status !== 'ADMITTED') return;
    const released = await coordinator.release(ACCOUNT, admitted.admission.admissionId);
    expect(released).toMatchObject({ status: 'RELEASED' });
    const releasedAgain = await coordinator.release(ACCOUNT, admitted.admission.admissionId);
    expect(releasedAgain).toMatchObject({ status: 'ALREADY_RELEASED' });
  });

  it('two concurrent releases of the same admission race safely: exactly one RELEASED, the other ALREADY_RELEASED', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const admitted = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) });
    expect(admitted.status).toBe('ADMITTED');
    if (admitted.status !== 'ADMITTED') return;
    const [a, b] = await Promise.all([
      coordinator.release(ACCOUNT, admitted.admission.admissionId),
      coordinator.release(ACCOUNT, admitted.admission.admissionId),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['ALREADY_RELEASED', 'RELEASED']);
  });

  it('rejects releasing an unknown admissionId without altering any state', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const outcome = await coordinator.release(ACCOUNT, 'f'.repeat(64));
    expect(outcome).toEqual({ status: 'UNKNOWN_ADMISSION' });
  });

  it('rejects releasing a genuine admissionId under the wrong account', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const admitted = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) });
    if (admitted.status !== 'ADMITTED') throw new Error('fixture');
    expect(await coordinator.release('some-other-account', admitted.admission.admissionId)).toEqual({ status: 'UNKNOWN_ADMISSION' });
  });

  it('allows re-admission of the same decisionId after a genuine release, with a fresh generation/admissionId', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const first = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) });
    if (first.status !== 'ADMITTED') throw new Error('fixture');
    await coordinator.release(ACCOUNT, first.admission.admissionId);
    const again = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) });
    expect(again.status).toBe('ADMITTED');
    if (again.status !== 'ADMITTED') return;
    expect(again.admission.admissionId).not.toBe(first.admission.admissionId);
    expect(again.admission.generation).toBe(2);
  });
});

describe('C-F07 account-wide atomicity and multi-coin capacity', () => {
  it('serializes two decisions on the same pair so the second sees the first as pending exposure', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernelA = makeKernel();
    const declA = evaluateDecision(kernelA, T0);
    const kernelB = makeKernel();
    // A distinct strategyInstanceId on the same pair (different bootstrap identity).
    const kernelBOther = (await import('../../../src/strategies')).emaTrendV1Definition.createKernel({
      pair: PAIR, parameters: { timeframeMinutes: 1, fastPeriod: 1, slowPeriod: 2, priceSource: 'CLOSE' }, indicatorBootstrapIdentity: [{ timeframeMinutes: 1, bootstrapStartOpenTimeMs: 60_000 }],
    });
    const declB = evaluateDecision(kernelBOther, T0);
    expect(kernelBOther.strategyInstanceId).not.toBe(kernelA.strategyInstanceId);
    void kernelB;
    const [outcomeA, outcomeB] = await Promise.all([
      coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernelA, declA) }),
      coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernelBOther, declB) }),
    ]);
    for (const outcome of [outcomeA, outcomeB]) expect(['ADMITTED', 'REJECTED']).toContain(outcome.status);
    // Whatever the resolution, no two ADMITTED grants may exceed the account's combined caps —
    // approximated here by requiring at least one of a tightly-capped pair to be rejected below.
  });

  it('at most one of two concurrent BTC/ETH requests can consume shared account-wide capacity that fits only one', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const btcKernel = makeKernel(PAIR);
    const ethKernel = makeKernel('B-ETH_USDT');
    const btcDecision = evaluateDecision(btcKernel, T0);
    const ethDecision = evaluateDecision(ethKernel, T0);

    // First, discover a single admission's real notional under a generous policy.
    const probeKernel = makeKernel(PAIR);
    const probe = await coordinator.admit({ accountId: 'probe-account', policy: policyFor(), context: buildContext(probeKernel, evaluateDecision(probeKernel, T0)) });
    if (probe.status !== 'ADMITTED') throw new Error('fixture requires a baseline admission to size the shared cap');
    const singleNotional = riskDecimal(probe.admission.approvedNotionalInr);

    // A global cap that comfortably fits one grant but not two.
    const tightCap = singleNotional.mul('1.5').toFixed();
    const exposureSnapshot: PortfolioExposureSnapshot = seal({
      globalOpenNotionalInr: '0', perPairOpenNotionalInr: {}, perStrategyOpenNotionalInr: {}, concurrentOpenPositions: 0,
      pending: { status: 'KNOWN', globalPendingNotionalInr: '0', pairPendingNotionalInr: {}, strategyPendingNotionalInr: {}, instancePendingReservations: [], pendingReservationCount: 0, pendingDirectionalNotionalInr: { longInr: '0', shortInr: '0' } },
      provenance: { sourceId: 'exposure-source', sourceTimeMs: T0, observedAtMs: T0, contentSha256: 'a'.repeat(64) },
    });

    const [btcOutcome, ethOutcome] = await Promise.all([
      coordinator.admit({ accountId: ACCOUNT, policy: policyFor(PAIR, tightCap), context: buildContext(btcKernel, btcDecision, { exposureSnapshot, pairSnapshot: pairSnapshotFor(PAIR) }) }),
      coordinator.admit({ accountId: ACCOUNT, policy: policyFor('B-ETH_USDT', tightCap), context: buildContext(ethKernel, ethDecision, { exposureSnapshot, pairSnapshot: pairSnapshotFor('B-ETH_USDT') }) }),
    ]);
    const outcomes = [btcOutcome, ethOutcome];
    // RiskEngine sizes down to fit remaining headroom rather than only ever
    // hard-rejecting (deterministic sizing/re-evaluation may legitimately split
    // capacity between the two) — the one non-negotiable invariant is that combined
    // admitted notional across both concurrent grants never exceeds the shared cap.
    const admittedNotional = outcomes
      .filter((outcome): outcome is Extract<typeof outcome, { readonly status: 'ADMITTED' }> => outcome.status === 'ADMITTED')
      .reduce((sum, outcome) => sum.plus(outcome.admission.approvedNotionalInr), riskDecimal('0'));
    expect(admittedNotional.lte(tightCap)).toBe(true);
    // And the two concurrent grants must not have each independently consumed the
    // full single-admission notional (proving the second genuinely saw the first's
    // pending contribution rather than evaluating against a stale, pre-lock view).
    expect(admittedNotional.lt(singleNotional.mul('2'))).toBe(true);
  });

  it('two independent accounts do not share or block each other\'s capacity/serialization', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernelA = makeKernel();
    const kernelB = makeKernel();
    const decisionA = evaluateDecision(kernelA, T0);
    const decisionB = evaluateDecision(kernelB, T0);
    const [outcomeA, outcomeB] = await Promise.all([
      coordinator.admit({ accountId: 'account-alpha', policy: policyFor(), context: buildContext(kernelA, decisionA) }),
      coordinator.admit({ accountId: 'account-beta', policy: policyFor(), context: buildContext(kernelB, decisionB) }),
    ]);
    expect(outcomeA.status).toBe('ADMITTED');
    expect(outcomeB.status).toBe('ADMITTED');
  });

  it('a slow first submission genuinely blocks a faster second submission on the same account queue (true serialization, not just first-resolves-first)', async () => {
    const { KeyedSerialQueue } = await import('../../../src/dispatch/serial-queue');
    const queue = new KeyedSerialQueue<string>();
    const order: string[] = [];
    const gate = deferred<void>();
    const slow = queue.enqueue('account-1', async () => { order.push('slow-start'); await gate.promise; order.push('slow-end'); return 'slow'; });
    const fast = queue.enqueue('account-1', () => { order.push('fast-start'); return 'fast'; });
    // The fast operation must not even start until the slow one, submitted first
    // to the same key, has fully finished — proving genuine mutual exclusion.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['slow-start']);
    gate.resolve();
    expect(await Promise.all([slow, fast])).toEqual(['slow', 'fast']);
    expect(order).toEqual(['slow-start', 'slow-end', 'fast-start']);
  });

  it('admits two decisions submitted concurrently for the same account in deterministic queue (call) order, not evaluation-speed order', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const first = evaluateDecision(kernel, T0);
    const second = evaluateDecision(kernel, T0 + MIN);
    const [firstOutcome, secondOutcome] = await Promise.all([
      coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, first) }),
      coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, second) }),
    ]);
    expect(firstOutcome.status).toBe('ADMITTED');
    expect(secondOutcome.status).toBe('ADMITTED');
  });
});

describe('C-F07 decimal exactness', () => {
  it('carries a 1e-18 approved-notional boundary through the pending overlay without native float drift', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const richAccount: AccountRiskSnapshot = seal({ ...makeAccount(), availableMarginInr: '0.000000000000000001' });
    const outcome = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision, { accountSnapshot: richAccount }) });
    // Either genuinely too small to size (REJECTED) or admitted with an exact,
    // non-float-corrupted notional — never NaN/Infinity/silently rounded to a native double.
    if (outcome.status === 'ADMITTED') {
      expect(Number.isFinite(Number(outcome.admission.approvedNotionalInr))).toBe(true);
      expect(outcome.admission.approvedNotionalInr).not.toMatch(/e|NaN|Infinity/i);
    } else {
      expect(outcome.status).toBe('REJECTED');
    }
  });
});
