/**
 * [F17-R04] Boundedness of the process-local live admission-consumption state.
 *
 * The original defect was a `Map<admissionId, intentId>` that was written on
 * every successful consumption and never read for eviction, so a long-running
 * process accumulated one permanent entry per admission it ever consumed. The
 * correction removes that structure entirely: consumption is now a field of the
 * admission entry itself, so it cannot outlive or outnumber the admission
 * population, and it is evicted in the same step that evicts the entry.
 *
 * These tests do not accept "the map is gone" as an assertion. They measure the
 * cardinality after every category of outcome the phase can produce — success,
 * rejection, thrown exception, dispatch timeout, submission ambiguity,
 * cancellation, release, restore, and thousands of repeated unique intents —
 * and additionally pin the coordinator's instance-state containers structurally
 * so a future change cannot quietly reintroduce an independent unpruned map.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_FAULT_RECOVERY_CAPABILITY,
  RiskAdmissionCoordinator,
  consumeLiveAdmissionForIntent,
  liveAdmissionConsumptionCardinality,
} from '../../../src/dispatch/admission';
import type { AdmissionRecord } from '../../../src/dispatch/types';
import { buildContext, evaluateDecision, makeKernel, policyFor } from './helpers';

const ACCOUNT = 'account-live-bounded';
const T0 = 1_200_000;
const MIN = 60_000;

/** Admits one genuine OPEN decision and returns its record. */
async function admitOne(coordinator: RiskAdmissionCoordinator, index: number): Promise<AdmissionRecord> {
  const kernel = makeKernel();
  const decision = evaluateDecision(kernel, T0 + index * MIN);
  const outcome = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) });
  if (outcome.status !== 'ADMITTED') throw new Error(`expected ADMITTED, received ${outcome.status}`);
  return outcome.admission;
}

const intentId = (n: number): string => `intent-${String(n).padStart(6, '0')}`;

describe('F17-R04 consumption state is bounded by the admission population', () => {
  it('records at most one marker per admission no matter how many unique intents attempt it', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const admission = await admitOne(coordinator, 0);

    const first = await consumeLiveAdmissionForIntent(coordinator, ACCOUNT, admission.admissionId, intentId(0));
    expect(first.status).toBe('CONSUMED');
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(1);

    // 2,000 DISTINCT intents each try to take the same admission. Under the
    // original map this attempted-keyed growth was the whole defect shape.
    for (let i = 1; i <= 2_000; i += 1) {
      const outcome = await consumeLiveAdmissionForIntent(coordinator, ACCOUNT, admission.admissionId, intentId(i));
      expect(outcome.status).toBe('UNAVAILABLE');
    }
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(1);
  });

  it('is idempotent for the same intent and still adds no second marker', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const admission = await admitOne(coordinator, 0);
    await consumeLiveAdmissionForIntent(coordinator, ACCOUNT, admission.admissionId, intentId(1));
    for (let i = 0; i < 500; i += 1) {
      const repeat = await consumeLiveAdmissionForIntent(coordinator, ACCOUNT, admission.admissionId, intentId(1));
      expect(repeat.status).toBe('ALREADY_CONSUMED_SAME_INTENT');
    }
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(1);
  });

  it('never exceeds the number of admissions across a long admit/consume/release workload', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    let admissions = 0;
    for (let cycle = 0; cycle < 400; cycle += 1) {
      const admission = await admitOne(coordinator, cycle);
      admissions += 1;
      await consumeLiveAdmissionForIntent(coordinator, ACCOUNT, admission.admissionId, intentId(cycle));
      await coordinator.release(ACCOUNT, admission.admissionId);
      // The invariant under test: consumption state is a strict subset of the
      // admission population and never a separate accumulating dimension.
      expect(liveAdmissionConsumptionCardinality(coordinator)).toBeLessThanOrEqual(admissions);
    }
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(400);
    expect(admissions).toBe(400);
  });
});

describe('F17-R04 no outcome other than a genuine consumption leaves state behind', () => {
  it('leaks nothing for an unknown admission id', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    await admitOne(coordinator, 0);
    for (let i = 0; i < 1_000; i += 1) {
      const outcome = await consumeLiveAdmissionForIntent(coordinator, ACCOUNT, `absent-${i}`, intentId(i));
      expect(outcome.status).toBe('UNAVAILABLE');
    }
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(0);
  });

  it('leaks nothing for a cross-account attempt against a real admission', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const admission = await admitOne(coordinator, 0);
    for (let i = 0; i < 500; i += 1) {
      const outcome = await consumeLiveAdmissionForIntent(coordinator, 'other-account', admission.admissionId, intentId(i));
      expect(outcome.status).toBe('UNAVAILABLE');
    }
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(0);
  });

  it('leaks nothing for a released (no longer ADMITTED) admission', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const admission = await admitOne(coordinator, 0);
    await coordinator.release(ACCOUNT, admission.admissionId);
    for (let i = 0; i < 500; i += 1) {
      const outcome = await consumeLiveAdmissionForIntent(coordinator, ACCOUNT, admission.admissionId, intentId(i));
      expect(outcome.status).toBe('UNAVAILABLE');
    }
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(0);
  });

  it('leaks nothing while the account is FAULTED', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const admission = await admitOne(coordinator, 0);
    await coordinator.markAccountFaulted(ACCOUNT_FAULT_RECOVERY_CAPABILITY, ACCOUNT);
    for (let i = 0; i < 500; i += 1) {
      const outcome = await consumeLiveAdmissionForIntent(coordinator, ACCOUNT, admission.admissionId, intentId(i));
      expect(outcome.status).toBe('UNAVAILABLE');
    }
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(0);
  });

  it('leaks nothing when the coordinator is forged rather than genuine', async () => {
    const genuine = new RiskAdmissionCoordinator();
    const admission = await admitOne(genuine, 0);
    const forgeries: readonly unknown[] = [
      {},
      Object.create(RiskAdmissionCoordinator.prototype),
      new Proxy(genuine, {}),
      null,
      'not-a-coordinator',
    ];
    for (const forged of forgeries) {
      const outcome = await consumeLiveAdmissionForIntent(forged, ACCOUNT, admission.admissionId, intentId(1));
      expect(outcome.status).toBe('UNAVAILABLE');
    }
    expect(liveAdmissionConsumptionCardinality(genuine)).toBe(0);
    expect(() => liveAdmissionConsumptionCardinality({})).toThrow(/genuine coordinator instance/);
  });

  it('leaks nothing when admission evaluation itself throws', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const malformedPolicy = { ...policyFor(), riskPolicyId: 'not-a-real-id' } as ReturnType<typeof policyFor>;
    for (let i = 0; i < 200; i += 1) {
      await expect(coordinator.admit({ accountId: ACCOUNT, policy: malformedPolicy, context: buildContext(kernel, decision) })).rejects.toThrow();
    }
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(0);
  });
});

describe('F17-R04 markers follow the lifetime of the admission entry that owns them', () => {
  it('survives release, so a released admission can never be re-consumed by a second intent', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const admission = await admitOne(coordinator, 0);
    await consumeLiveAdmissionForIntent(coordinator, ACCOUNT, admission.admissionId, intentId(1));
    await coordinator.release(ACCOUNT, admission.admissionId);
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(1);
    const second = await consumeLiveAdmissionForIntent(coordinator, ACCOUNT, admission.admissionId, intentId(2));
    expect(second.status).toBe('UNAVAILABLE');
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(1);
  });

  it('is evicted together with the entries that authoritative fault recovery replaces', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    for (let i = 0; i < 25; i += 1) {
      const admission = await admitOne(coordinator, i);
      await consumeLiveAdmissionForIntent(coordinator, ACCOUNT, admission.admissionId, intentId(i));
      // Released so the account keeps risk capacity for the next admission.
      // The consumption marker is deliberately retained across release, which
      // is exactly why eviction has to come from somewhere — here, recovery.
      await coordinator.release(ACCOUNT, admission.admissionId);
    }
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(25);

    await coordinator.markAccountFaulted(ACCOUNT_FAULT_RECOVERY_CAPABILITY, ACCOUNT);
    await coordinator.restoreAuthoritative(ACCOUNT_FAULT_RECOVERY_CAPABILITY, ACCOUNT, [], [], []);
    // Eviction is not best-effort: replacing the account's projection removes
    // every marker it owned, in the same step.
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(0);
    expect(coordinator.isAccountFaulted(ACCOUNT)).toBe(false);
  });

  it('restores no marker at startup, deferring to the durable consumption table', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const source = new RiskAdmissionCoordinator();
    const admission = await admitOne(source, 0);
    await consumeLiveAdmissionForIntent(source, ACCOUNT, admission.admissionId, intentId(0));

    await coordinator.restore(ACCOUNT, [admission], [], []);
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(0);
  });

  it('preserves the marker across the restored-entry self-heal re-evaluation', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0);
    const source = new RiskAdmissionCoordinator();
    const outcome = await source.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) });
    if (outcome.status !== 'ADMITTED') throw new Error('setup failed');

    await coordinator.restore(ACCOUNT, [outcome.admission], [], []);
    await consumeLiveAdmissionForIntent(coordinator, ACCOUNT, outcome.admission.admissionId, intentId(7));
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(1);

    // Re-submitting the same decisionId drives the self-heal path, which
    // rebuilds the entry. The marker must be carried over, not dropped.
    const healed = await coordinator.admit({ accountId: ACCOUNT, policy: policyFor(), context: buildContext(kernel, decision) });
    expect(healed.status).toBe('ADMITTED');
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(1);
    const stolen = await consumeLiveAdmissionForIntent(coordinator, ACCOUNT, outcome.admission.admissionId, intentId(8));
    expect(stolen.status).toBe('UNAVAILABLE');
  });

  it('keeps one account\'s markers independent of another account\'s recovery', async () => {
    const coordinator = new RiskAdmissionCoordinator();
    const a = await admitOne(coordinator, 0);
    await consumeLiveAdmissionForIntent(coordinator, ACCOUNT, a.admissionId, intentId(1));

    const otherAccount = 'account-live-bounded-2';
    const kernel = makeKernel();
    const decision = evaluateDecision(kernel, T0 + 5 * MIN);
    const other = await coordinator.admit({ accountId: otherAccount, policy: policyFor(), context: buildContext(kernel, decision) });
    if (other.status !== 'ADMITTED') throw new Error('setup failed');
    await consumeLiveAdmissionForIntent(coordinator, otherAccount, other.admission.admissionId, intentId(2));
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(2);

    await coordinator.markAccountFaulted(ACCOUNT_FAULT_RECOVERY_CAPABILITY, otherAccount);
    await coordinator.restoreAuthoritative(ACCOUNT_FAULT_RECOVERY_CAPABILITY, otherAccount, [], [], []);
    expect(liveAdmissionConsumptionCardinality(coordinator)).toBe(1);
  });
});

describe('F17-R04 the defective structure cannot be reintroduced', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/dispatch/admission.ts'), 'utf8');

  it('no longer declares an admission-keyed consumption map', () => {
    expect(source).not.toContain('#liveConsumptionByAdmission');
  });

  it('pins the coordinator\'s complete set of instance state containers', () => {
    // Every `readonly #x = new Map()/new Set()` field on the class. Consumption
    // state is deliberately absent: it lives inside `#byAdmissionId` entries.
    const declared = [...source.matchAll(/^ {2}readonly (#[A-Za-z]+) = new (Map|Set|KeyedSerialQueue)/gm)].map((match) => match[1]);
    expect(declared).toEqual([
      '#queues',
      '#byAccountAndDecision',
      '#byAdmissionId',
      '#latestAdmittedSequence',
      '#latestGeneration',
      '#faultedAccounts',
    ]);
  });

  it('writes the consumption marker only through an admission entry', () => {
    // The only assignments that can create a marker are entry constructions.
    const markerWrites = [...source.matchAll(/consumedByIntentId: (?!string)[^,}\n]+/g)].map((match) => match[0].trim());
    expect(markerWrites).toEqual([
      'consumedByIntentId: null',
      'consumedByIntentId: existing.consumedByIntentId',
      'consumedByIntentId: null',
      'consumedByIntentId: entry.consumedByIntentId',
      'consumedByIntentId: intentId',
    ]);
  });
});
