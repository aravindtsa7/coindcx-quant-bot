import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, type BacktestEvent } from '../../../../src/backtest';
import { ValidationEvidenceCollector } from '../../../../src/research/research-validation/evidence-collector';
import { executeResearchValidationWithGitSourceVerifier } from '../../../../src/research/research-validation/executor';
import { planResearchValidationWithGitSourceVerifier } from '../../../../src/research/research-validation/planner';
import type { CanonicalValidationEvidence, FinalizedResearchValidationPlan, ResearchValidationPlanInput } from '../../../../src/research/research-validation/types';
import { BASE, ControlledGitVerifier, registry } from '../strategy-coin-matrix/helpers';
import { fundedResource, fundingEvent, fundingSource, reloadFunding } from '../strategy-coin-matrix/audit-b2-helpers';
import { validationInput } from './helpers';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const IS = BASE + DAY + HOUR;
const OOS = BASE + 2 * DAY + HOUR;
const HOLDOUT = BASE + 3 * DAY + HOUR;
type Resource = ReturnType<typeof fundedResource>;

async function planned(resource: Resource, input: ResearchValidationPlanInput = validationInput([resource])) {
  const dependencies = { registry: registry(), pairResources: [resource] };
  const verifier = new ControlledGitVerifier();
  const finalized = await planResearchValidationWithGitSourceVerifier(input, dependencies, verifier);
  return { finalized, dependencies, verifier };
}

async function execute(fixture: Awaited<ReturnType<typeof planned>>, workerCount = 1) {
  const funding = new Map<string, BacktestEvent[]>();
  const original = ValidationEvidenceCollector.prototype.write;
  // Observe the genuine Phase9 stream at Phase12's existing collector boundary;
  // every event is still forwarded to its production integrity verifier.
  const observer = vi.spyOn(ValidationEvidenceCollector.prototype, 'write').mockImplementation(function (this: ValidationEvidenceCollector, event: BacktestEvent) {
    // An OOS window can later be replayed as rolling IS with the same Phase9 runId.
    if (event.sequence === 1) funding.set(event.runId, []);
    if (event.type === 'FUNDING_APPLIED') funding.set(event.runId, [...funding.get(event.runId) ?? [], event]);
    original.call(this, event);
  });
  try {
    const result = await executeResearchValidationWithGitSourceVerifier(fixture.finalized, fixture.dependencies, { workerCount }, fixture.verifier);
    expect(result.status).toBe('COMPLETED');
    expect(result.abortedSubjects).toEqual([]);
    const subject = result.subjectResults[0];
    expect(subject).toBeDefined();
    expect(subject?.foldResults.every((fold) => fold.evidence !== null && fold.failureCode === undefined)).toBe(true);
    expect(subject?.holdoutEvaluation?.evidence).not.toBeNull();
    expect(fixture.verifier.assertions).toBeGreaterThan(0);
    return { result, subject: subject!, funding };
  } finally { observer.mockRestore(); }
}

function assertFunding(observed: Awaited<ReturnType<typeof execute>>, evidence: CanonicalValidationEvidence | null | undefined, times: readonly number[], pnl: string) {
  expect(evidence).toBeDefined(); expect(evidence).not.toBeNull();
  expect(evidence?.fundingPnl).toBe(pnl);
  expect(evidence?.observedEventLedgerSha256).toBe(evidence?.phase9EventLedgerSha256);
  expect(observed.funding.get(evidence!.runId)?.map((event) => event.eventTimeMs) ?? []).toEqual(times);
  expect(observed.funding.get(evidence!.runId)?.every((event) => event.entityId.startsWith('verified-BTC-INR-funding-v1:')) ?? true).toBe(true);
}

describe('Audit B2 genuine validation funding window integration', () => {
  it('executes the Jan2 IS / Jan3 OOS / Jan4 holdout source, preserves restart identity, and isolates a future rate delta', async () => {
    const resource = fundedResource('BTC-INR', [fundingEvent(IS), fundingEvent(OOS, '0.02'), fundingEvent(HOLDOUT, '0.03')], 4 * 24 * 60);
    const fixture = await planned(resource);
    expect(fixture.finalized.plan.pairBindings[0]?.fundingScheduleBinding).toEqual({
      sourceId: resource.fundingSchedule.sourceId, contentSha256: resource.fundingSchedule.contentSha256, fidelity: 'VERIFIED_SCHEDULE',
    });
    const baseline = await execute(fixture);
    const is = baseline.subject.foldResults.find((fold) => fold.kind === 'IS')?.evidence;
    const oos = baseline.subject.foldResults.find((fold) => fold.kind === 'OOS')?.evidence;
    assertFunding(baseline, is, [IS], '-0.01');
    assertFunding(baseline, oos, [OOS], '-0.02');
    assertFunding(baseline, baseline.subject.holdoutEvaluation?.evidence, [HOLDOUT], '-0.03');

    const finalized = JSON.parse(JSON.stringify(fixture.finalized)) as FinalizedResearchValidationPlan;
    const restored = { ...resource, fundingSchedule: reloadFunding(resource.fundingSchedule) };
    const restarted = await execute({ finalized, dependencies: { registry: registry(), pairResources: [restored] }, verifier: new ControlledGitVerifier() }, 2);
    expect(canonicalJson(restarted.result)).toBe(canonicalJson(baseline.result));
    expect(restarted.funding).toEqual(baseline.funding);
    expect(restored.fundingSchedule).toEqual(resource.fundingSchedule);

    const changedSource = fundingSource(resource.pair, [fundingEvent(IS), fundingEvent(OOS, '0.02'), fundingEvent(HOLDOUT, '0.030000000000000001')]);
    const changedFixture = await planned({ ...resource, fundingSchedule: changedSource });
    expect(changedFixture.finalized.validationPlanId).not.toBe(fixture.finalized.validationPlanId);
    const changed = await execute(changedFixture);
    for (const kind of ['IS', 'OOS'] as const) {
      const a = baseline.subject.foldResults.find((fold) => fold.kind === kind)?.evidence;
      const b = changed.subject.foldResults.find((fold) => fold.kind === kind)?.evidence;
      expect(b?.runId).toBe(a?.runId);
      expect(b?.resultSha256).toBe(a?.resultSha256);
      expect(b?.fundingPnl).toBe(a?.fundingPnl);
      expect(b?.dailyEquities).toEqual(a?.dailyEquities);
      expect(b?.validationEvidenceSha256).not.toBe(a?.validationEvidenceSha256);
    }
    assertFunding(changed, changed.subject.holdoutEvaluation?.evidence, [HOLDOUT], '-0.030000000000000001');
    expect(changed.subject.holdoutEvaluation?.evidence?.resultSha256).not.toBe(baseline.subject.holdoutEvaluation?.evidence?.resultSha256);
    expect(changed.result.validationResultSha256).not.toBe(baseline.result.validationResultSha256);
  }, 90_000);

  it('executes multiple OOS folds and settles each adjacent OOS/holdout boundary only in the preceding window', async () => {
    const boundary = BASE + 3 * DAY;
    const holdoutStart = BASE + 4 * DAY;
    const events = [fundingEvent(IS), fundingEvent(OOS, '0.02'), fundingEvent(boundary, '0.04'), fundingEvent(HOLDOUT, '0.03'), fundingEvent(holdoutStart, '0.05'), fundingEvent(holdoutStart + HOUR, '0.06')];
    const resource = fundedResource('BTC-INR', events, 5 * 24 * 60);
    const input = validationInput([resource]);
    const fixture = await planned(resource, { ...input,
      validationWindow: { startMs: BASE + DAY, endExclusiveMs: BASE + 5 * DAY },
      holdout: { ...input.holdout, holdoutStartMs: holdoutStart, holdoutEndExclusiveMs: BASE + 5 * DAY },
    });
    expect(fixture.finalized.folds).toHaveLength(2);
    const observed = await execute(fixture, 2);
    const oos = observed.subject.foldResults.filter((fold) => fold.kind === 'OOS');
    assertFunding(observed, oos[0]?.evidence, [OOS, boundary], '-0.06');
    assertFunding(observed, oos[1]?.evidence, [HOLDOUT, holdoutStart], '-0.08');
    assertFunding(observed, observed.subject.holdoutEvaluation?.evidence, [holdoutStart + HOUR], '-0.06');
    const adjacent = [...oos.map((fold) => fold.evidence), observed.subject.holdoutEvaluation?.evidence];
    const times = adjacent.flatMap((evidence) => observed.funding.get(evidence!.runId)?.map((event) => event.eventTimeMs) ?? []);
    expect(times.filter((time) => time === boundary)).toHaveLength(1);
    expect(times.filter((time) => time === holdoutStart)).toHaveLength(1);
    // Rolling IS windows intentionally revisit history as independent experiments;
    // their schedules must still follow their own window, never global consumption.
    const is = observed.subject.foldResults.filter((fold) => fold.kind === 'IS');
    assertFunding(observed, is[0]?.evidence, [IS], '-0.01');
    assertFunding(observed, is[1]?.evidence, [OOS, boundary], '-0.06');
  }, 90_000);

  it('rejects malformed or stale authoritative funding beyond the initial IS slice', async () => {
    const valid = fundedResource('BTC-INR', [fundingEvent(IS), fundingEvent(OOS), fundingEvent(HOLDOUT)], 4 * 24 * 60);
    const duplicate = { ...valid, fundingSchedule: fundingSource(valid.pair, [...valid.fundingSchedule.events, fundingEvent(HOLDOUT)]) };
    await expect(planned(duplicate)).rejects.toMatchObject({ code: 'VALIDATION_PLAN_INVALID', cause: { code: 'FUNDING_SCHEDULE_INVALID' } });
    const fixture = await planned(valid);
    const stale = { ...valid, fundingSchedule: fundingSource(valid.pair, [fundingEvent(IS), fundingEvent(OOS), fundingEvent(HOLDOUT, '0.02')]) };
    await expect(executeResearchValidationWithGitSourceVerifier(fixture.finalized, { ...fixture.dependencies, pairResources: [stale] }, {}, new ControlledGitVerifier())).rejects.toThrow();
  });
});
